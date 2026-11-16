/**
 * 知识图谱查询服务（第二阶段：后端 API 的读侧）。
 *
 * 与第一阶段构建服务的分工：GraphBuildService 只写图，本服务只读图并组装对外视图，
 * 二者共用同一套表与同一份 CJK 词法能力，不重复实现检索、不引入新存储。
 *
 * 权限模型（本阶段重点，全部复用既有体系，不另建一套）：
 * 1. 角色入口：控制器 @Perm('archiveView') + SessionGuard（未登录 401，越权角色 403）；
 * 2. 档案级：SQL 层复用 ARCHIVE_VISIBILITY_SQL（public / 本人创建 / 未过期 active 借阅授权），
 *    与目录检索、附件检索、正文检索完全同一份条件；
 * 3. 逐条复核：详情接口再用 ArchiveAccessService.canView/canDownload 复核（双闸，与统一检索一致）；
 * 4. 附件与知识块继承所属档案权限（节点必须带可见 archive_id 才出现）；
 * 5. 关系两端任一不可见 → 整条关系不返回；
 * 6. 概览统计全部按可见范围实时重算；不可见节点直接不存在于计数里，
 *    因此不会通过总数、关联数或搜索命中泄露受限档案的存在；
 * 7. 对「存在但无权」的图谱节点统一按 404 处理（图谱是浏览型入口，
 *    403 会等于告诉调用方「这个编号有档案」，故与无权存在的响应保持一致）。
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { ArchiveRepository, CategoryRepository, CategoryRow } from '../archives/archive.repositories';
import { UnifiedSearchService } from '../search/unified-search.service';
import { UnifiedContentHit, UnifiedQuery, UnifiedSearchResult } from '../search/unified-search.types';
import { UserView } from '../common/roles';
import { ArchivesService, STATUS_LABELS } from '../archives/archives.service';
import { GraphQueryRepository, KgEdgeRecord, KgNodeRecord, KgOverviewRaw } from './graph.query.repositories';
import {
  KgEdgeDetailResponse,
  KgEdgeEvidence,
  KgEvidenceLocator,
  KgGraphEdgeView,
  KgGraphNodeView,
  KgGraphQuery,
  KgGraphResponse,
  KgNodeDetailResponse,
  KgOverviewResponse,
  KgRelationItem,
  KgRelationsResponse,
  KgSearchHit,
  KgSearchResponse,
  KgViewerScope,
} from './graph.query.types';
import { KG_EDGE_BASIS, KG_EDGE_TYPE_LABEL, KgEdgeType, KgNodeType, kgNodeKey } from './graph.types';
import { KG_NODE_LIMIT_MAX } from './graph.query.dto';

/** 展开深度内的邻接上限（单跳）：即使前端请求很大，也限制单次遍历的边数。 */
const TRAVERSAL_ROW_LIMIT = 1200;
/** 详情里「关联档案 / 关联知识块」的展示条数。 */
const DETAIL_RELATION_LIMIT = 30;
/** 附件详情里知识块列表的条数上限（默认只给前 N 块，其余靠画布分页展开）。 */
const DETAIL_CHUNK_LIMIT = 50;
const CHUNK_LIST_EXCERPT_CHARS = 200;
/** 证据里共有词项的展示条数（与第一阶段 maxEvidencePairsPerEdge 同量级）。 */
const EVIDENCE_TERMS = 12;
/** 知识块摘录长度：右栏「正文摘录」用，避免把整段正文搬进图谱接口。 */
const CHUNK_EXCERPT_CHARS = 600;
const SEARCH_EXCERPT_CHARS = 160;

/** 结构展开方向：每个类型的「下层」由真实业务归属决定。 */
const OUTWARD_EDGES: Record<KgNodeType, KgEdgeType[]> = {
  category: ['category_contains_archive'],
  archive: ['archive_contains_file'],
  file: ['file_contains_chunk'],
  chunk: [],
};
/** 内容展开方向：档案级与知识块级关联。 */
const RELATION_EDGES: Record<KgNodeType, KgEdgeType[]> = {
  category: [],
  archive: ['archive_related_to', 'archive_shared_reference'],
  file: [],
  chunk: ['chunk_similar_to'],
};
/** 全景视图的关系集合：结构归属 + 档案级关联（知识块级关联只在展开时出现，避免画布拥挤）。 */
const PANORAMA_EDGES: KgEdgeType[] = ['category_contains_archive', 'archive_related_to', 'archive_shared_reference'];
/** 结构边（第一阶段只为「分类→档案→附件→知识块」建结构关系，分类之间的父子层级来自 archive_categories.parent_id）。 */
const STRUCTURE_EDGES: KgEdgeType[] = ['category_contains_archive', 'archive_contains_file', 'file_contains_chunk'];
/** 内容/确定性边（只在调用方明确要求带出关联时参与展开）。 */
const CONTENT_EDGES: KgEdgeType[] = ['archive_related_to', 'archive_shared_reference', 'chunk_similar_to'];

@Injectable()
export class GraphQueryService {
  constructor(
    @Inject(GraphQueryRepository) private readonly repo: GraphQueryRepository,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(ArchiveRepository) private readonly archives: ArchiveRepository,
    @Inject(CategoryRepository) private readonly categories: CategoryRepository,
    @Inject(UnifiedSearchService) private readonly unifiedSearch: UnifiedSearchService,
    @Inject(ArchivesService) private readonly archiveService: ArchivesService,
  ) {}

  private scope(user: UserView): KgViewerScope {
    return { userId: user.id, admin: user.role === 'admin' };
  }

  // ==================== 概览 ====================

  overview(user: UserView): KgOverviewResponse {
    const scope = this.scope(user);
    const raw: KgOverviewRaw = this.repo.overview(scope);
    const rows = raw.categoryRows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
    // 子树可见档案数：按 parent_id 链向上累加（分类层级受 MAX_CATEGORY_DEPTH 约束，最坏线性一遍）
    const subtree = new Map<number, number>();
    const accumulate = (id: number, guard = 0): number => {
      if (guard > 10) return 0;
      const cached = subtree.get(id);
      if (cached !== undefined) return cached;
      const self = byId.get(id);
      let sum = self?.visibleArchiveCount ?? 0;
      for (const [childId, parentId] of parentOf) {
        if (parentId === id && childId !== id) sum += accumulate(childId, guard + 1);
      }
      subtree.set(id, sum);
      return sum;
    };
    const depthOf = (id: number): number => {
      let cursor = byId.get(id)?.parentId ?? null;
      let depth = 0;
      const seen = new Set<number>([id]);
      while (cursor != null && !seen.has(cursor) && depth < 10) {
        seen.add(cursor);
        depth += 1;
        cursor = byId.get(cursor)?.parentId ?? null;
      }
      return depth;
    };

    const visibleCategories = rows
      .filter((row) => row.visibleArchiveCount > 0 || (subtree.get(row.id) ?? accumulate(row.id)) > 0)
      .map((row) => ({
        id: row.id,
        key: kgNodeKey.category(row.id),
        name: row.name,
        code: row.code,
        parentId: row.parentId,
        depth: depthOf(row.id),
        archiveCount: row.visibleArchiveCount,
        subtreeArchiveCount: accumulate(row.id),
        attachmentCount: row.attachmentCount,
        chunkCount: row.chunkCount,
      }));

    return {
      archives: raw.archives,
      categories: visibleCategories.length,
      files: raw.files,
      chunks: raw.chunks,
      relations: raw.relations,
      nodesByType: raw.nodesByType,
      edgesByType: raw.edgesByType,
      categoryList: visibleCategories,
      notBuilt: raw.totalNodes === 0,
    };
  }

  // ==================== 图谱（全景 / 分类 / 展开） ====================

  graph(user: UserView, query: KgGraphQuery): KgGraphResponse {
    const scope = this.scope(user);
    if (query.center) {
      return this.expand(scope, query);
    }
    const categoryIds = query.view === 'category' ? this.subtreeIds(query.categoryId) : undefined;
    const types = query.types?.length ? query.types : (['category', 'archive'] as KgNodeType[]);
    const pageSize = Math.min(query.pageSize, KG_NODE_LIMIT_MAX);
    const offset = (query.page - 1) * pageSize;
    const listed = this.repo.listNodes(scope, {
      types,
      categoryIds,
      limit: pageSize,
      offset,
    });
    const nodes = this.toNodeViews(scope, listed.items);
    // 关系只在「本次返回的节点集合」内部取，保证不会出现指向未加载节点的悬空连线
    const edges = this.toEdgeViews(listed.items, this.repo.edgesAmong(scope, listed.items.map((n) => n.id), query.includeRelations ? undefined : PANORAMA_EDGES));
    return {
      view: query.view,
      mode: 'overview',
      nodes,
      edges,
      page: {
        page: query.page,
        pageSize,
        totalNodes: listed.total,
        returnedNodes: nodes.length,
        returnedEdges: edges.length,
        truncated: listed.total > nodes.length,
      },
      limits: { maxNodes: KG_NODE_LIMIT_MAX, maxDepth: 0 },
    };
  }

  /** 按需展开：以中心节点为种子逐层取邻接（每层每类型一次 SQL，深度受 DTO 上限约束）。 */
  private expand(scope: KgViewerScope, query: KgGraphQuery): KgGraphResponse {
    const center = this.repo.findNode(scope, query.center!.type, query.center!.refId);
    if (!center) {
      throw new NotFoundException('图谱节点不存在，或当前账号无权访问其所属档案');
    }
    if (center.nodeType === 'category') {
      return this.expandCategory(scope, center, query);
    }
    const typeFilter = query.types?.length ? new Set<KgNodeType>(query.types) : undefined;
    const nodeById = new Map<number, KgNodeRecord>([[center.id, center]]);
    const edgeById = new Map<number, KgEdgeRecord>();
    let frontier: KgNodeRecord[] = [center];

    for (let hop = 0; hop < query.depth && frontier.length; hop += 1) {
      const byType = new Map<KgNodeType, number[]>();
      for (const node of frontier) {
        const list = byType.get(node.nodeType) ?? [];
        list.push(node.id);
        byType.set(node.nodeType, list);
      }
      const next: KgNodeRecord[] = [];
      for (const [type, seedIds] of byType) {
        const edgeTypes = this.traversalEdges(type, query.includeRelations, query.edgeTypes);
        if (!edgeTypes.length) continue;
        for (const row of this.repo.neighborRows(scope, seedIds, edgeTypes, TRAVERSAL_ROW_LIMIT)) {
          edgeById.set(row.edge.id, row.edge);
          if (nodeById.has(row.neighbor.id)) continue;
          if (typeFilter && !typeFilter.has(row.neighbor.nodeType)) continue;
          nodeById.set(row.neighbor.id, row.neighbor);
          next.push(row.neighbor);
        }
      }
      frontier = next;
      if (nodeById.size >= query.pageSize) break;
    }

    const ordered = [...nodeById.values()].sort(compareNodes);
    const pageSize = Math.min(query.pageSize, KG_NODE_LIMIT_MAX);
    const paged = ordered.slice(0, pageSize);
    const pagedIds = new Set(paged.map((node) => node.id));
    const nodes = this.toNodeViews(scope, paged);
    const edges = this.toEdgeViews(paged, [...edgeById.values()].filter((edge) => pagedIds.has(edge.fromNode) && pagedIds.has(edge.toNode)));
    return {
      view: query.view,
      mode: 'expand',
      center: nodes.find((node) => node.id === center.id) ?? undefined,
      nodes,
      edges,
      page: {
        page: 1,
        pageSize,
        totalNodes: ordered.length,
        returnedNodes: nodes.length,
        returnedEdges: edges.length,
        truncated: ordered.length > nodes.length,
      },
      limits: { maxNodes: KG_NODE_LIMIT_MAX, maxDepth: query.depth },
    };
  }

  private traversalEdges(type: KgNodeType, includeRelations: boolean, override?: KgEdgeType[]): KgEdgeType[] {
    if (override?.length) return override;
    const base = [...OUTWARD_EDGES[type]];
    if (includeRelations || base.length === 0) base.push(...RELATION_EDGES[type]);
    return [...new Set(base)];
  }

  /**
   * 分类中心节点的展开：按子树分层（深度 1 = 子分类与档案，2 = 再加附件，3 = 再加知识块）。
   * 分类之间没有结构关系，若沿用边遍历，父分类展开会停在原地，因此以 archive_categories 层级为准。
   */
  private expandCategory(scope: KgViewerScope, center: KgNodeRecord, query: KgGraphQuery): KgGraphResponse {
    const pageSize = Math.min(query.pageSize, KG_NODE_LIMIT_MAX);
    const layers: KgNodeType[] = ['category', 'archive'];
    if (query.depth >= 2) layers.push('file');
    if (query.depth >= 3) layers.push('chunk');
    const types = query.types?.length ? layers.filter((type) => query.types!.includes(type)) : layers;
    const listed = this.repo.listNodes(scope, {
      types,
      categoryIds: this.subtreeIds(center.refId),
      limit: pageSize,
      offset: 0,
    });
    const nodes = this.toNodeViews(scope, listed.items);
    const edgeTypes = query.edgeTypes?.length
      ? query.edgeTypes
      : query.includeRelations
        ? [...STRUCTURE_EDGES, ...CONTENT_EDGES]
        : STRUCTURE_EDGES;
    const edges = this.toEdgeViews(listed.items, this.repo.edgesAmong(scope, listed.items.map((node) => node.id), edgeTypes));
    const centerView = nodes.find((node) => node.id === center.id) ?? this.fallbackView(center);
    return {
      view: query.view,
      mode: 'expand',
      center: centerView,
      nodes,
      edges,
      page: {
        page: 1,
        pageSize,
        totalNodes: listed.total,
        returnedNodes: nodes.length,
        returnedEdges: edges.length,
        truncated: listed.total > nodes.length,
      },
      limits: { maxNodes: KG_NODE_LIMIT_MAX, maxDepth: query.depth },
    };
  }

  // ==================== 节点详情 ====================

  detail(user: UserView, nodeType: KgNodeType, refId: number): KgNodeDetailResponse {
    const scope = this.scope(user);
    const node = this.repo.findNode(scope, nodeType, refId);
    if (!node) throw new NotFoundException('图谱节点不存在，或当前账号无权访问其所属档案');
    const view = this.toNodeViews(scope, [node])[0];
    if (!view) throw new NotFoundException('该节点对应的业务数据已变更，请在图谱管理中重新构建');
    const relationCount = this.repo.edgesOfNode(scope, node.id, undefined, DETAIL_RELATION_LIMIT, 0).total;

    if (nodeType === 'category') return this.categoryDetail(user, view, refId, relationCount);
    if (nodeType === 'archive') return this.archiveDetail(user, view, refId, relationCount);
    if (nodeType === 'file') return this.fileDetail(user, view, refId, relationCount);
    return this.chunkDetail(user, view, refId, relationCount);
  }

  /** 分类详情：事实取权威表 archive_categories，档案列表按当前用户可见档案过滤。 */
  private categoryDetail(user: UserView, view: KgGraphNodeView, categoryId: number, relationCount: number): KgNodeDetailResponse {
    const scope = this.scope(user);
    const facts = this.repo.categoryFacts(scope, [categoryId]).get(categoryId);
    if (!facts) throw new NotFoundException('分类不存在，或当前账号无权访问该分类下的档案');
    const parent = facts.parentId == null ? undefined : this.categories.findById(facts.parentId);
    return {
      type: 'category',
      node: view,
      relationCount,
      name: facts.name,
      code: facts.code,
      description: facts.description,
      parentId: facts.parentId,
      parentName: parent?.name ?? null,
      archiveCount: facts.visibleArchiveCount,
      archives: this.visibleArchivesOfCategory(scope, categoryId),
    };
  }

  private visibleArchivesOfCategory(scope: KgViewerScope, categoryId: number): Array<{ key: string; id: number; title: string; archiveNo: string; status: string; fileCount: number }> {
    const rows = this.repo.listNodes(scope, { types: ['archive'], categoryIds: [categoryId], limit: 100, offset: 0 }).items;
    const facts = this.repo.archiveFacts(scope, rows.map((row) => row.refId));
    return rows
      .map((row) => {
        const fact = facts.get(row.refId);
        if (!fact) return undefined;
        return { key: row.bizKey, id: fact.id, title: fact.title, archiveNo: fact.archiveNo, status: fact.status, fileCount: fact.fileCount };
      })
      .filter((item): item is { key: string; id: number; title: string; archiveNo: string; status: string; fileCount: number } => !!item);
  }

  private archiveDetail(user: UserView, view: KgGraphNodeView, archiveId: number, relationCount: number): KgNodeDetailResponse {
    const scope = this.scope(user);
    const row = this.archives.findById(archiveId);
    // 「存在但无权」与「不存在」同一响应：图谱不提供受限档案的存在性探针
    if (!row || !this.access.canView(user, row)) {
      throw new NotFoundException('图谱节点不存在，或当前账号无权访问其所属档案');
    }
    const files = this.archives.listFiles(archiveId);
    const facts = this.repo.fileFacts(scope, files.map((file) => file.id));
    const node = this.repo.findNode(scope, 'archive', archiveId)!;
    const related = this.relationItems(scope, node, ['archive_related_to', 'archive_shared_reference'], DETAIL_RELATION_LIMIT);
    return {
      type: 'archive',
      node: { ...view, expandable: files.length > 0, childCount: files.length },
      relationCount,
      title: row.title,
      archiveNo: row.archiveNo,
      categoryId: row.categoryId,
      categoryName: this.categories.findById(row.categoryId)?.name ?? '',
      archiveType: row.archiveType,
      status: row.status,
      statusLabel: STATUS_LABELS[row.status] ?? row.status,
      accessLevel: row.accessLevel,
      responsible: row.responsible,
      formationDate: row.formationDate,
      keywords: row.keywords,
      createdAt: row.createdAt,
      files: files.map((file) => ({
        key: kgNodeKey.file(file.id),
        id: file.id,
        name: file.originalName,
        extension: file.extension,
        fileSize: file.fileSize,
        extractStatus: facts.get(file.id)?.extractStatus ?? 'pending',
        chunkCount: facts.get(file.id)?.chunkCount ?? 0,
      })),
      relatedArchives: related.items,
      permissions: { canView: true, canDownload: this.access.canDownload(user, row) },
    };
  }

  private fileDetail(user: UserView, view: KgGraphNodeView, fileId: number, relationCount: number): KgNodeDetailResponse {
    const scope = this.scope(user);
    const facts = this.repo.fileFacts(scope, [fileId]).get(fileId);
    if (!facts) throw new NotFoundException('附件不存在，或当前账号无权访问其所属档案');
    const archive = this.archives.findById(facts.archiveId);
    if (!archive || !this.access.canView(user, archive)) {
      throw new NotFoundException('附件不存在，或当前账号无权访问其所属档案');
    }
    const listed = this.repo.listNodes(scope, { types: ['chunk'], fileIds: [fileId], limit: DETAIL_CHUNK_LIMIT, offset: 0 });
    const chunkIds = listed.items.map((item) => item.refId);
    // 知识块事实与摘录分两次批量查询，不逐块取，避免 N+1
    const chunkFacts = this.repo.chunkFacts(scope, chunkIds);
    const excerpts = this.repo.chunkTexts(scope, chunkIds, CHUNK_LIST_EXCERPT_CHARS);
    return {
      type: 'file',
      node: view,
      relationCount,
      name: facts.originalName,
      extension: facts.extension,
      fileSize: facts.fileSize,
      contentType: facts.contentType,
      uploadedAt: facts.uploadedAt,
      extractStatus: facts.extractStatus,
      extractMessage: facts.extractMessage,
      extractor: facts.extractor,
      charCount: facts.charCount,
      chunkCount: facts.chunkCount,
      truncated: facts.truncated,
      archive: {
        key: kgNodeKey.archive(archive.id),
        id: archive.id,
        title: archive.title,
        archiveNo: archive.archiveNo,
        categoryName: this.categories.findById(archive.categoryId)?.name ?? '',
      },
      chunks: listed.items.map((item) => {
        const fact = chunkFacts.get(item.refId);
        return {
          key: item.bizKey,
          id: item.refId,
          chunkNo: fact?.chunkNo ?? 0,
          locator: fact?.locator ?? '',
          pageNo: fact?.pageNo ?? null,
          excerpt: oneLine(excerpts.get(item.refId) ?? ''),
        };
      }),
      permissions: { canView: true, canDownload: this.access.canDownload(user, archive) },
    };
  }

  private chunkDetail(user: UserView, view: KgGraphNodeView, chunkId: number, relationCount: number): KgNodeDetailResponse {
    const scope = this.scope(user);
    const chunk = this.repo.chunkText(scope, chunkId);
    if (!chunk) throw new NotFoundException('知识块不存在，或当前账号无权访问其所属档案');
    const archive = this.archives.findById(chunk.archiveId);
    if (!archive || !this.access.canView(user, archive)) {
      throw new NotFoundException('知识块不存在，或当前账号无权访问其所属档案');
    }
    const node = this.repo.findNode(scope, 'chunk', chunkId);
    const related = node ? this.relationItems(scope, node, ['chunk_similar_to'], DETAIL_RELATION_LIMIT) : { items: [], total: 0 };
    const fileFacts = this.repo.fileFacts(scope, [chunk.fileId]).get(chunk.fileId);
    return {
      type: 'chunk',
      node: view,
      relationCount,
      chunkNo: chunk.chunkNo,
      locator: chunk.locator,
      pageNo: chunk.pageNo,
      posFrom: chunk.posFrom,
      posTo: chunk.posTo,
      excerpt: oneLine(chunk.text).slice(0, CHUNK_EXCERPT_CHARS),
      textLength: chunk.textLength,
      file: { key: kgNodeKey.file(chunk.fileId), id: chunk.fileId, name: chunk.fileName, extension: fileFacts?.extension ?? '' },
      archive: {
        key: kgNodeKey.archive(archive.id),
        id: archive.id,
        title: archive.title,
        archiveNo: archive.archiveNo,
        categoryName: this.categories.findById(archive.categoryId)?.name ?? '',
      },
      relatedChunks: related.items,
      permissions: { canView: true, canDownload: this.access.canDownload(user, archive) },
    };
  }

  // ==================== 关系 ====================

  edge(user: UserView, edgeId: number, expected?: { fromId: number; toId: number }): KgEdgeDetailResponse {
    const unavailable = () => new NotFoundException('关系不存在、依据已变化或当前无权访问');
    if (!Number.isSafeInteger(edgeId) || edgeId <= 0) throw unavailable();
    const scope = this.scope(user);
    const row = this.repo.edgesByIds(scope, [edgeId])[0];
    if (!row || expected && (row.fromNode !== expected.fromId || row.toNode !== expected.toId)) throw unavailable();
    const nodes = this.repo.findNodesByIds(scope, [row.fromNode, row.toNode]);
    const views = this.toNodeViews(scope, nodes);
    const from = views.find(n => n.id === row.fromNode), to = views.find(n => n.id === row.toNode);
    if (!from || !to) throw unavailable();
    for (const node of [from, to]) {
      if (node.archiveId != null) {
        const archive = this.archives.findById(node.archiveId);
        if (!archive || !this.access.canView(user, archive)) throw unavailable();
      }
    }
    let evidence = buildEvidence(row);
    const chunkIds: number[] = [];
    const locate = (id: number, owner: KgGraphNodeView, fileId?: number | null): KgEvidenceLocator => {
      const chunk = this.repo.chunkText(scope, id);
      if (!chunk || chunk.archiveId !== owner.archiveId || fileId != null && chunk.fileId !== fileId) throw unavailable();
      chunkIds.push(chunk.id);
      return { chunkId: chunk.id, fileId: chunk.fileId, archiveId: chunk.archiveId, chunkNo: chunk.chunkNo,
        locator: chunk.locator, pageNo: chunk.pageNo, preview: chunk.text.slice(0, 300) };
    };
    if (evidence.basis === 'tfidf_cosine') {
      evidence = { ...evidence, from: locate(evidence.from.chunkId, from, evidence.from.fileId),
        to: locate(evidence.to.chunkId, to, evidence.to.fileId) };
    } else if (evidence.basis === 'tfidf_cosine_aggregated') {
      if (!evidence.supportingChunks.length) throw unavailable();
      const supportingChunks = evidence.supportingChunks.slice(0, 4).map(pair => ({ ...pair,
        from: locate(pair.fromChunkId, from, pair.fromFileId), to: locate(pair.toChunkId, to, pair.toFileId) }));
      evidence = { ...evidence, supportingChunks };
    } else if (evidence.basis === 'metadata_exact_match') {
      if (from.type !== 'archive' || to.type !== 'archive') throw unavailable();
      const fieldKey=evidence.fieldKey;
      const a = this.archiveService.getArchiveDetail(from.refId, user).dynamicFields.find(f => f.fieldKey === fieldKey);
      const b = this.archiveService.getArchiveDetail(to.refId, user).dynamicFields.find(f => f.fieldKey === fieldKey);
      const norm = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, '');
      if (!a || !b || !norm(a.value) || norm(a.value) !== norm(b.value) || norm(a.value) !== norm(evidence.value)) throw unavailable();
      evidence = { ...evidence, fieldLabel: a.label, value: a.value, matchedOn: '两端档案的同一著录字段等值', sharedValueCount: 2 };
    } else if (evidence.basis === 'business_structure') {
      const valid = row.edgeType === 'category_contains_archive' ? from.type === 'category' && to.type === 'archive' &&
        this.archives.findById(to.refId)?.categoryId === from.refId :
        row.edgeType === 'archive_contains_file' ? from.type === 'archive' && to.type === 'file' && to.archiveId === from.refId :
        row.edgeType === 'file_contains_chunk' && from.type === 'file' && to.type === 'chunk' && to.fileId === from.refId;
      if (!valid) throw unavailable();
    } else throw unavailable();
    const refs: Array<{type: KgNodeType; refId: number}> = chunkIds.map(refId => ({type:'chunk',refId}));
    for (const id of chunkIds) {
      const chunk = this.repo.chunkFacts(scope, [id]).get(id);
      if (chunk) refs.push({ type: 'file', refId: chunk.fileId });
    }
    const supportingNodes = this.toNodeViews(scope, this.repo.findNodesByRefs(scope, refs)).slice(0, 16);
    const edge = this.toEdgeView({ ...row, evidence: evidence as unknown as Record<string, unknown> },
      nodes.find(n => n.id === row.fromNode)!, nodes.find(n => n.id === row.toNode)!);
    return { edge, from, to, evidence, supportingNodes };
  }

  relations(user: UserView, nodeType: KgNodeType, refId: number, edgeTypes: KgEdgeType[] | undefined, page: number, pageSize: number): KgRelationsResponse {
    const scope = this.scope(user);
    const node = this.repo.findNode(scope, nodeType, refId);
    if (!node) throw new NotFoundException('图谱节点不存在，或当前账号无权访问其所属档案');
    const found = this.repo.edgesOfNode(scope, node.id, edgeTypes, pageSize, (page - 1) * pageSize);
    const items = this.buildRelationItems(scope, node, found.items);
    return {
      node: this.toNodeViews(scope, [node])[0] ?? this.fallbackView(node),
      total: found.total,
      page,
      pageSize,
      items,
    };
  }

  private relationItems(
    scope: KgViewerScope,
    node: KgNodeRecord,
    edgeTypes: KgEdgeType[],
    limit: number,
  ): { items: KgRelationItem[]; total: number } {
    const found = this.repo.edgesOfNode(scope, node.id, edgeTypes, limit, 0);
    return { items: this.buildRelationItems(scope, node, found.items), total: found.total };
  }

  private buildRelationItems(scope: KgViewerScope, seed: KgNodeRecord, rows: Array<{ neighbor: KgNodeRecord; edge: KgEdgeRecord }>): KgRelationItem[] {
    const neighbors = rows.map((row) => row.neighbor);
    const views = new Map(this.toNodeViews(scope, neighbors).map((view) => [view.id, view]));
    const items: KgRelationItem[] = [];
    for (const row of rows) {
      const view = views.get(row.neighbor.id);
      // 邻接节点的业务事实取不到（档案被删 / 权限已回收）时整条关系不返回
      if (!view) continue;
      items.push({ edge: this.toEdgeView(row.edge, seed, row.neighbor), node: view, evidence: buildEvidence(row.edge) });
    }
    return items;
  }

  // ==================== 搜索 ====================

  /**
   * 图谱搜索：完全复用统一检索（档案 / 附件 / 正文 / 分类四组已在 SQL 层叠加可见性条件
   * 并逐条过 ArchiveAccessService），本方法只做「命中 → 图谱节点定位」的映射，不另建检索。
   */
  search(user: UserView, keyword: string, limit: number, page: number): KgSearchResponse {
    const scope = this.scope(user);
    const query: UnifiedQuery = { keyword, scopes: ['archive', 'attachment', 'content', 'category'], page, limit };
    const result: UnifiedSearchResult = this.unifiedSearch.search(query, user);
    const groups: Record<KgNodeType, KgSearchHit[]> = { category: [], archive: [], file: [], chunk: [] };
    const refs: Array<{ type: KgNodeType; refId: number }> = [];
    const push = (hit: Omit<KgSearchHit, 'key' | 'inGraph'>) => {
      groups[hit.type].push({ ...hit, key: null, inGraph: false });
      refs.push({ type: hit.type, refId: hit.refId });
    };
    for (const row of result.categories.items) {
      push({ type: 'category', refId: row.id, title: row.name, subtitle: row.pathCode || row.code, archiveId: null, fileId: null });
    }
    for (const row of result.archives.items) {
      push({ type: 'archive', refId: row.id, title: row.title, subtitle: row.archiveNo, archiveId: row.id, fileId: null });
    }
    for (const row of result.attachments.items) {
      push({
        type: 'file',
        refId: row.fileId,
        title: row.fileName,
        subtitle: `${row.archiveTitle} · ${row.archiveNo}`,
        archiveId: row.archiveId,
        fileId: row.fileId,
      });
    }
    for (const row of result.contents.items as UnifiedContentHit[]) {
      // 旧索引行可能只到段落级（无片段主键）：这类命中无法定位到节点，按不入图处理
      if (row.chunkId == null) continue;
      push({
        type: 'chunk',
        refId: row.chunkId,
        title: row.fileName || row.archiveTitle,
        subtitle: `${row.archiveTitle} · ${row.archiveNo}`,
        archiveId: row.archiveId,
        fileId: row.fileId,
        locator: row.locator,
        pageNo: row.pageNo ?? null,
        excerpt: oneLine(row.text).slice(0, SEARCH_EXCERPT_CHARS),
        score: row.score,
      });
    }
    // 一次批量解析命中对应的图谱节点；正文已重建但图谱未刷新的命中仍保留，标注 inGraph=false
    const keyOf = new Map<string, string>();
    for (const node of this.repo.findNodesByRefs(scope, refs)) keyOf.set(`${node.nodeType}:${node.refId}`, node.bizKey);
    for (const list of Object.values(groups)) {
      for (const hit of list) {
        const key = keyOf.get(`${hit.type}:${hit.refId}`);
        if (!key) continue;
        hit.key = key;
        hit.inGraph = true;
      }
    }
    const total = groups.category.length + groups.archive.length + groups.file.length + groups.chunk.length;
    return {
      query: keyword,
      total,
      retrievalMode: result.retrievalMode,
      degraded: result.degraded,
      degradedReason: result.degradedReason ?? null,
      groups,
    };
  }

  // ==================== 视图组装 ====================

  /** 节点 → 画布视图：批量取权威事实，取不到事实的节点直接剔除（失效节点不外显）。 */
  private toNodeViews(scope: KgViewerScope, nodes: KgNodeRecord[]): KgGraphNodeView[] {
    if (!nodes.length) return [];
    const idsByType = new Map<KgNodeType, number[]>();
    for (const node of nodes) {
      const list = idsByType.get(node.nodeType) ?? [];
      list.push(node.refId);
      idsByType.set(node.nodeType, list);
    }
    const archiveFacts = this.repo.archiveFacts(scope, idsByType.get('archive') ?? []);
    const fileFacts = this.repo.fileFacts(scope, idsByType.get('file') ?? []);
    const chunkFacts = this.repo.chunkFacts(scope, idsByType.get('chunk') ?? []);
    const categoryFacts = this.repo.categoryFacts(scope, idsByType.get('category') ?? []);
    // 附件与知识块还需要「所属档案」的展示字段：按 archive_id 批量取一次，顺带再确认所属档案仍然可见
    const ownerIds = [...new Set(nodes.filter((node) => node.nodeType === 'file' || node.nodeType === 'chunk').map((node) => node.archiveId).filter((id): id is number => id != null))];
    const ownerFacts = this.repo.archiveFacts(scope, ownerIds);
    const categoryDepth = this.categoryDepthMap(idsByType.get('category') ?? []);

    const childCounts = this.childCounts(scope, nodes);
    const out: KgGraphNodeView[] = [];
    for (const node of nodes) {
      const child = childCounts.get(node.id);
      let facts: Record<string, string | number | null | boolean> | undefined;
      // 节点标签以权威表当前值为准（图谱索引里的 name 可能滞后于改名）
      let label = node.name;
      if (node.nodeType === 'category') {
        const fact = categoryFacts.get(node.refId);
        if (!fact) continue;
        label = fact.name;
        facts = { code: fact.code, parentId: fact.parentId, archiveCount: fact.visibleArchiveCount, attachmentCount: fact.attachmentCount, chunkCount: fact.chunkCount };
      } else if (node.nodeType === 'archive') {
        const fact = archiveFacts.get(node.refId);
        if (!fact) continue;
        label = fact.title;
        facts = {
          archiveNo: fact.archiveNo,
          categoryId: fact.categoryId,
          categoryName: fact.categoryName,
          archiveType: fact.archiveType,
          status: fact.status,
          fileCount: fact.fileCount,
          chunkCount: fact.chunkCount,
        };
      } else if (node.nodeType === 'file') {
        const fact = fileFacts.get(node.refId);
        const owner = node.archiveId == null ? undefined : ownerFacts.get(node.archiveId);
        // 附件继承所属档案权限：取不到所属档案的可见事实就整节点不输出（事实与权限双保险）
        if (!fact || !owner) continue;
        label = fact.originalName;
        facts = {
          extension: fact.extension,
          fileSize: fact.fileSize,
          extractStatus: fact.extractStatus,
          chunkCount: fact.chunkCount,
          archiveNo: owner.archiveNo,
          archiveTitle: owner.title,
        };
      } else {
        const fact = chunkFacts.get(node.refId);
        const owner = node.archiveId == null ? undefined : ownerFacts.get(node.archiveId);
        if (!fact || !owner) continue;
        label = node.name || `${fact.fileName} 第${fact.chunkNo}块`;
        facts = { chunkNo: fact.chunkNo, locator: fact.locator, pageNo: fact.pageNo, fileName: fact.fileName, archiveNo: owner.archiveNo };
      }
      out.push({
        key: node.bizKey,
        id: node.id,
        type: node.nodeType,
        refId: node.refId,
        label,
        archiveId: node.archiveId,
        fileId: node.fileId,
        depth: node.nodeType === 'category' ? categoryDepth.get(node.refId) : undefined,
        expandable: (child?.count ?? 0) > 0,
        childCount: child?.count ?? 0,
        facts,
      });
    }
    return out;
  }

  /** 每类节点的下层数量（expandable 标记）：一次按类型分组的邻接查询，不逐节点问。 */
  private childCounts(scope: KgViewerScope, nodes: KgNodeRecord[]): Map<number, { count: number }> {
    const result = new Map<number, { count: number }>();
    const byType = new Map<KgNodeType, number[]>();
    for (const node of nodes) {
      const list = byType.get(node.nodeType) ?? [];
      list.push(node.id);
      byType.set(node.nodeType, list);
    }
    for (const [type, ids] of byType) {
      const edgeTypes = [...OUTWARD_EDGES[type], ...RELATION_EDGES[type]];
      if (!edgeTypes.length) continue;
      const seen = new Map<number, Set<number>>();
      for (const row of this.repo.neighborRows(scope, ids, edgeTypes, TRAVERSAL_ROW_LIMIT)) {
        const set = seen.get(row.seedNodeId) ?? new Set<number>();
        set.add(row.neighbor.id);
        seen.set(row.seedNodeId, set);
      }
      for (const id of ids) result.set(id, { count: seen.get(id)?.size ?? 0 });
    }
    return result;
  }

  private toEdgeViews(nodes: KgNodeRecord[], edges: KgEdgeRecord[]): KgGraphEdgeView[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const out: KgGraphEdgeView[] = [];
    for (const edge of edges) {
      const from = byId.get(edge.fromNode);
      const to = byId.get(edge.toNode);
      // 端点不在本次节点集合里的关系不输出（宁可少连线，不给前端悬空边）
      if (!from || !to) continue;
      out.push(this.toEdgeView(edge, from, to));
    }
    return out;
  }

  private toEdgeView(edge: KgEdgeRecord, seed: KgNodeRecord, other: KgNodeRecord): KgGraphEdgeView {
    const from = seed.id === edge.fromNode ? seed : other;
    const to = seed.id === edge.toNode ? seed : other;
    return {
      id: edge.id,
      type: edge.edgeType,
      label: KG_EDGE_TYPE_LABEL[edge.edgeType] ?? edge.edgeType,
      from: from.bizKey,
      to: to.bizKey,
      fromId: from.id,
      toId: to.id,
      weight: Number(edge.weight.toFixed(4)),
      basis: edge.basis,
      reason: edgeReason(edge),
    };
  }

  private fallbackView(node: KgNodeRecord): KgGraphNodeView {
    return {
      key: node.bizKey,
      id: node.id,
      type: node.nodeType,
      refId: node.refId,
      label: node.name,
      archiveId: node.archiveId,
      fileId: node.fileId,
      expandable: false,
      childCount: 0,
      facts: {},
    };
  }

  /** 分类层级（0 起）：一次性读全量分类后沿 parent_id 上溯，带环与深度保护。 */
  private categoryDepthMap(categoryIds: number[]): Map<number, number> {
    const map = new Map<number, number>();
    if (!categoryIds.length) return map;
    const parentOf = new Map<number, number | null>(this.categories.listAll().map((row: CategoryRow) => [row.id, row.parentId]));
    for (const id of new Set(categoryIds)) {
      let depth = 0;
      let cursor = parentOf.get(id) ?? null;
      const seen = new Set<number>([id]);
      while (cursor != null && !seen.has(cursor) && depth < 10) {
        seen.add(cursor);
        depth += 1;
        cursor = parentOf.get(cursor) ?? null;
      }
      map.set(id, depth);
    }
    return map;
  }

  /** 分类子树（与目录检索「含子分类」同一层级定义，数据源同为 archive_categories）。 */
  private subtreeIds(rootId?: number): number[] {
    const rows: CategoryRow[] = this.categories.listAll();
    if (!rootId) return rows.map((row) => row.id);
    const childrenOf = new Map<number, number[]>();
    for (const row of rows) {
      if (row.parentId == null) continue;
      const list = childrenOf.get(row.parentId) ?? [];
      list.push(row.id);
      childrenOf.set(row.parentId, list);
    }
    const out: number[] = [];
    const queue = [rootId];
    const seen = new Set<number>();
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
    return out;
  }
}

// ==================== 证据与文案 ====================

/** 正文压缩成单行：搜索摘录与知识块列表用，避免把换行甩给前端。 */
function oneLine(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 一句话「关联原因」：只讲业务事实与真实依据，不暴露算法内部参数。
 */
function edgeReason(edge: KgEdgeRecord): string {
  const evidence = edge.evidence ?? {};
  switch (edge.edgeType) {
    case 'category_contains_archive':
      return '分类与档案的归属关系来自档案的所属分类字段';
    case 'archive_contains_file':
      return '附件直接挂在该档案下';
    case 'file_contains_chunk':
      return `正文片段来自该附件${evidence.locator ? `（${String(evidence.locator)}）` : ''}`;
    case 'chunk_similar_to': {
      const terms = Array.isArray(evidence.sharedTerms) ? (evidence.sharedTerms as string[]).slice(0, 4).join('、') : '';
      return `正文相似度 ${Number(edge.weight).toFixed(2)}${terms ? `，共有词项：${terms}` : ''}`;
    }
    case 'archive_related_to': {
      const support = Number(evidence.supportCount ?? 0);
      const max = Number(evidence.maxChunkSimilarity ?? 0);
      return `${support} 组正文彼此相似${max ? `，最高相似度 ${max.toFixed(2)}` : ''}`;
    }
    case 'archive_shared_reference':
      return `著录字段「${String(evidence.fieldLabel ?? evidence.fieldKey ?? '')}」取值相同：${String(evidence.value ?? '')}`;
    default:
      return edge.basis;
  }
}

/** 关系证据白名单化：按第一阶段写入的真实形状还原，不整包透传 evidence_json。 */
function buildEvidence(edge: KgEdgeRecord): KgEdgeEvidence {
  const evidence = edge.evidence ?? {};
  if (edge.basis === KG_EDGE_BASIS.STRUCTURE) {
    return {
      basis: 'business_structure',
      origin: String(evidence.origin ?? ''),
      archiveId: numOrNull(evidence.archiveId),
      fileId: numOrNull(evidence.fileId),
      chunkId: numOrNull(evidence.chunkId),
      locator: evidence.locator == null ? undefined : String(evidence.locator),
      pageNo: numOrNull(evidence.pageNo) ?? undefined,
    };
  }
  if (edge.basis === KG_EDGE_BASIS.TFIDF_COSINE) {
    return {
      basis: 'tfidf_cosine',
      method: String(evidence.method ?? 'tfidf_cosine'),
      tokenizer: String(evidence.tokenizer ?? 'cjk-bigram'),
      similarity: Number(evidence.similarity ?? edge.weight),
      sharedTermCount: Number(evidence.sharedTermCount ?? (Array.isArray(evidence.sharedTerms) ? evidence.sharedTerms.length : 0)),
      sharedTerms: strArray(evidence.sharedTerms, EVIDENCE_TERMS),
      from: locator(evidence.from),
      to: locator(evidence.to),
    };
  }
  if (edge.basis === KG_EDGE_BASIS.TFIDF_COSINE_AGGREGATED) {
    const pairs = Array.isArray(evidence.supportingChunks) ? (evidence.supportingChunks as Array<Record<string, unknown>>) : [];
    return {
      basis: 'tfidf_cosine_aggregated',
      method: String(evidence.method ?? 'tfidf_cosine_aggregated'),
      formula: String(evidence.formula ?? ''),
      maxChunkSimilarity: Number(evidence.maxChunkSimilarity ?? 0),
      supportCount: Number(evidence.supportCount ?? pairs.length),
      supportingChunks: pairs.slice(0, 8).map((pair) => ({
        fromChunkId: Number(pair.fromChunkId ?? 0),
        toChunkId: Number(pair.toChunkId ?? 0),
        fromFileId: numOrNull(pair.fromFileId),
        toFileId: numOrNull(pair.toFileId),
        similarity: Number(pair.similarity ?? 0),
        sharedTerms: strArray(pair.sharedTerms, 6),
      })),
    };
  }
  if (edge.basis === KG_EDGE_BASIS.METADATA_EXACT) {
    const shared = Array.isArray(evidence.sharedArchiveIds) ? (evidence.sharedArchiveIds as unknown[]).length : 0;
    return {
      basis: 'metadata_exact_match',
      fieldKey: String(evidence.fieldKey ?? ''),
      fieldLabel: String(evidence.fieldLabel ?? ''),
      value: String(evidence.value ?? ''),
      matchedOn: String(evidence.matchedOn ?? ''),
      sharedValueCount: shared,
    };
  }
  return { basis: 'unknown', note: '该关系的计算依据未被识别，仅返回权重与端点信息' };
}

function locator(raw: unknown): KgEvidenceLocator {
  const item = (raw ?? {}) as Record<string, unknown>;
  return {
    chunkId: Number(item.chunkId ?? 0),
    fileId: Number(item.fileId ?? 0),
    archiveId: Number(item.archiveId ?? 0),
    chunkNo: Number(item.chunkNo ?? 0),
    locator: String(item.locator ?? ''),
    pageNo: numOrNull(item.pageNo) ?? null,
    preview: String(item.preview ?? '').slice(0, 60),
  };
}

function strArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, max).map((item) => String(item));
}

function numOrNull(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function compareNodes(a: KgNodeRecord, b: KgNodeRecord): number {
  const rank = (node: KgNodeRecord) => (node.nodeType === 'category' ? 0 : node.nodeType === 'archive' ? 1 : node.nodeType === 'file' ? 2 : 3);
  return rank(a) - rank(b) || (a.archiveId ?? 0) - (b.archiveId ?? 0) || (a.fileId ?? 0) - (b.fileId ?? 0) || a.id - b.id;
}
