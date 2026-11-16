/**
 * 知识图谱仓储 · 查询侧（第二阶段）。
 *
 * 与第一阶段写入侧仓储（graph.repositories.ts）严格分工：
 * - 写入侧只负责建图（幂等 upsert / 清理），本文件只负责「带着权限读图」；
 * - 读图分两步：拓扑取自 kg_graph_*（节点与边），展示事实取自权威业务表
 *   （archives / archive_categories / archive_files / archive_content_units / archive_content_chunks），
 *   因此接口返回的永远是当前业务状态，不会把图谱里的历史快照当成事实；
 * - 权限过滤全部下推到 SQL：非管理员一律叠加 ARCHIVE_VISIBILITY_SQL（与目录检索、
 *   附件检索、正文检索同一份条件），无权档案的节点在结果集里就不存在；
 *   关系两端任一不可见时整条关系被排除（edgesAmong 再复核一次端点可见性）；
 * - 批量取事实按类型分组一次查询（IN 列表），邻接遍历按层一次查询，
 *   概览固定 7 条聚合 SQL，不做逐节点 N+1。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { ARCHIVE_VISIBILITY_SQL } from '../archives/archive.repositories';
import { CURRENT_CONTENT_SQL } from '../archives/content/content-index.repositories';
import { KgEdgeType, KgNodeType } from './graph.types';
import { KgViewerScope } from './graph.query.types';

/** 图谱节点原始行（拓扑信息，事实字段由 facts 系列方法补齐）。 */
export interface KgNodeRecord {
  id: number;
  nodeType: KgNodeType;
  bizKey: string;
  refId: number;
  archiveId: number | null;
  fileId: number | null;
  name: string;
}

/** 图谱关系原始行。 */
export interface KgEdgeRecord {
  id: number;
  edgeType: KgEdgeType;
  fromNode: number;
  toNode: number;
  weight: number;
  basis: string;
  evidence: Record<string, unknown>;
}

/** 一条「种子节点 → 邻接节点」的遍历行（同一条边会从两端各出现一次，由服务层按 edge.id 去重）。 */
export interface KgNeighborRow {
  seedNodeId: number;
  neighbor: KgNodeRecord;
  edge: KgEdgeRecord;
}

export interface KgArchiveFacts {
  id: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  archiveType: string;
  status: string;
  accessLevel: string;
  responsible: string;
  formationDate: string | null;
  keywords: string;
  createdAt: string;
  fileCount: number;
  chunkCount: number;
}

export interface KgFileFacts {
  id: number;
  archiveId: number;
  originalName: string;
  extension: string;
  fileSize: number;
  contentType: string;
  uploadedAt: string;
  extractStatus: string;
  extractMessage: string;
  extractor: string;
  charCount: number;
  /** 已入图的知识块数（与画布可展开数量一致）。 */
  chunkCount: number;
  truncated: boolean;
}

export interface KgChunkFacts {
  id: number;
  archiveId: number;
  fileId: number;
  fileName: string;
  chunkNo: number;
  locator: string;
  pageNo: number | null;
  posFrom: number | null;
  posTo: number | null;
  textLength: number;
}

export interface KgCategoryFacts {
  id: number;
  name: string;
  code: string;
  description: string;
  parentId: number | null;
  /** 当前用户可见的直接归属档案数。 */
  visibleArchiveCount: number;
  attachmentCount: number;
  chunkCount: number;
}

/** 概览原始计数（全部为可见范围口径）。 */
export interface KgOverviewRaw {
  archives: number;
  categories: number;
  files: number;
  chunks: number;
  relations: number;
  nodesByType: Record<KgNodeType, number>;
  edgesByType: Partial<Record<KgEdgeType, number>>;
  totalNodes: number;
  categoryRows: KgCategoryFacts[];
}

export interface KgNodeListFilter {
  types: KgNodeType[];
  /** 分类视图：限定这些分类（含其档案子树）；undefined 表示不限。 */
  categoryIds?: number[];
  /** 限定档案范围（分类筛选后的可见档案集合）；undefined 表示不限。 */
  archiveIds?: number[];
  /** 限定附件（附件详情列知识块用）；undefined 表示不限。 */
  fileIds?: number[];
  limit: number;
  offset: number;
}

export abstract class GraphQueryRepository {
  abstract overview(scope: KgViewerScope): KgOverviewRaw;
  /** 按 (type, refId) 取单个可见节点；不可见或不存在返回 undefined。 */
  abstract findNode(scope: KgViewerScope, nodeType: KgNodeType, refId: number): KgNodeRecord | undefined;
  abstract findNodesByIds(scope: KgViewerScope, nodeIds: number[]): KgNodeRecord[];
  /** 批量按业务主键解析节点（搜索命中定位用）。 */
  abstract findNodesByRefs(scope: KgViewerScope, refs: Array<{ type: KgNodeType; refId: number }>): KgNodeRecord[];
  /** 全景 / 分类视图的节点分页读取（按类型分层稳定排序）。 */
  abstract listNodes(scope: KgViewerScope, filter: KgNodeListFilter): { items: KgNodeRecord[]; total: number };
  /** 指定节点集合内部的全部关系（端点可见性复核后返回）。 */
  abstract edgesAmong(scope: KgViewerScope, nodeIds: number[], edgeTypes?: KgEdgeType[], limit?: number): KgEdgeRecord[];
  /** 一层邻接遍历（含关系与邻接节点），单次 SQL 完成。 */
  abstract neighborRows(scope: KgViewerScope, seedIds: number[], edgeTypes: KgEdgeType[], limit: number): KgNeighborRow[];
  /** 单个节点的关系（关系详情用，支持分页，按权重降序）。 */
  abstract edgesOfNode(
    scope: KgViewerScope,
    nodeId: number,
    edgeTypes: KgEdgeType[] | undefined,
    limit: number,
    offset: number,
  ): { items: KgNeighborRow[]; total: number };
  /** 关系 id 批量读取（含两端可见性复核）。 */
  abstract edgesByIds(scope: KgViewerScope, edgeIds: number[]): KgEdgeRecord[];

  // ---------- 权威业务事实（批量，带权限） ----------
  abstract archiveFacts(scope: KgViewerScope, archiveIds: number[]): Map<number, KgArchiveFacts>;
  abstract fileFacts(scope: KgViewerScope, fileIds: number[]): Map<number, KgFileFacts>;
  abstract chunkFacts(scope: KgViewerScope, chunkIds: number[]): Map<number, KgChunkFacts>;
  abstract categoryFacts(scope: KgViewerScope, categoryIds: number[]): Map<number, KgCategoryFacts>;
  /** 单个知识块正文摘录（长度受控；SQL 内仍带档案可见性条件）。 */
  abstract chunkText(scope: KgViewerScope, chunkId: number): (KgChunkFacts & { text: string }) | undefined;
  /** 知识块正文（批量，附件详情内「正文知识块列表」用）。 */
  abstract chunkTexts(scope: KgViewerScope, chunkIds: number[], maxLength: number): Map<number, string>;
}

/** 节点排序：先分类、再档案、再附件、最后知识块，保证分页与画布布局稳定。 */
const NODE_ORDER = `
  CASE n.node_type WHEN 'category' THEN 0 WHEN 'archive' THEN 1 WHEN 'file' THEN 2 ELSE 3 END,
  n.archive_id, n.file_id, n.id`;

const NODE_COLUMNS = 'n.id, n.node_type, n.biz_key, n.ref_id, n.archive_id, n.file_id, n.name';

function inClause(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function parseJson(raw: unknown): Record<string, unknown> {
  try {
    return JSON.parse(String(raw ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 邻接节点列（UNION 两侧列名统一为 n_*）。 */
const nodeCols = (alias: string) =>
  `${alias}.id AS n_id, ${alias}.node_type AS n_type, ${alias}.biz_key AS n_key, ${alias}.ref_id AS n_ref, ` +
  `${alias}.archive_id AS n_archive, ${alias}.file_id AS n_file, ${alias}.name AS n_name`;

/** 关系列（统一 edge_id 前缀，避免与节点 id 撞名）。 */
const edgeCols = `
  e.id AS edge_id, e.edge_type AS edge_type, e.from_node AS from_node, e.to_node AS to_node,
  e.weight AS weight, e.basis AS basis, e.evidence_json AS evidence_json`;

@Injectable()
export class SqliteGraphQueryRepository implements GraphQueryRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  // ==================== 可见性谓词 ====================

  /**
   * 节点可见条件（节点别名由调用方给出）：
   * - 分类节点：自身或其子树（最多 5 级，与 ArchivesService.MAX_CATEGORY_DEPTH 一致）内存在「当前用户可见」的档案；
   *   按层级向上展开是为了避免画布断链：父分类自身无直接归档时，子分类可见则父节点也必须可见。
   *   完全没有可见档案的空分类（及其祖先）不会被枚举出来；
   * - 档案 / 附件 / 知识块节点：其 archive_id 指向的档案必须可见（附件与正文继承所属档案权限）。
   * 非管理员把 ARCHIVE_VISIBILITY_SQL 内联到两处 EXISTS，参数顺序即 SQL 文本顺序。
   */
  private nodeVisible(scope: KgViewerScope, alias: string): { sql: string; args: Array<number | string> } {
    const vis = scope.admin ? '1=1' : ARCHIVE_VISIBILITY_SQL;
    const args: Array<number | string> = scope.admin ? [] : [scope.userId, scope.userId, scope.userId, scope.userId];
    // 分类分支：先确认分类行仍在（图谱是可重建索引层，可能滞后于业务删除），
    // 再沿 parent_id 向上最多 4 跳（共 5 级，与 ArchivesService.MAX_CATEGORY_DEPTH 一致）判断子树是否有可见档案
    const categorySql =
      `( ${alias}.node_type = 'category' AND EXISTS (SELECT 1 FROM archive_categories kc WHERE kc.id = ${alias}.ref_id) AND EXISTS (
          SELECT 1 FROM archives a
            JOIN archive_categories d0 ON d0.id = a.category_id
            LEFT JOIN archive_categories d1 ON d1.id = d0.parent_id
            LEFT JOIN archive_categories d2 ON d2.id = d1.parent_id
            LEFT JOIN archive_categories d3 ON d3.id = d2.parent_id
           WHERE (d0.id = ${alias}.ref_id OR d1.id = ${alias}.ref_id OR d2.id = ${alias}.ref_id OR d3.id = ${alias}.ref_id)
             AND ${vis}) )`;
    // 档案 / 附件 / 知识块分支：所属档案必须可见，且权威业务行仍取到（失效节点既不外显也不计数）
    const archiveSql =
      `( ${alias}.node_type <> 'category' AND ${alias}.archive_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM archives a WHERE a.id = ${alias}.archive_id AND ${vis})
        AND ( (${alias}.node_type = 'archive' AND ${alias}.ref_id = ${alias}.archive_id)
           OR ( ${alias}.node_type = 'file' AND EXISTS (SELECT 1 FROM archive_files kf WHERE kf.id = ${alias}.ref_id AND kf.archive_id = ${alias}.archive_id AND kf.id = ${alias}.file_id) )
           OR ( ${alias}.node_type = 'chunk' AND EXISTS (SELECT 1 FROM archive_content_chunks kx
              JOIN archive_content_units ku ON ku.id = kx.unit_id
              JOIN (${CURRENT_CONTENT_SQL}) kc ON kc.file_id = kx.file_id AND kc.stored_name = ku.stored_name AND kc.sha256 = ku.sha256
              WHERE kx.id = ${alias}.ref_id AND kx.archive_id = ${alias}.archive_id AND kx.file_id = ${alias}.file_id) ) ) )`;
    return { sql: `( ${categorySql} OR ${archiveSql} )`, args };
  }

  /** 档案可见条件（档案别名固定为 a）。 */
  private archiveVisible(scope: KgViewerScope): { sql: string; args: Array<number | string> } {
    return scope.admin
      ? { sql: '1=1', args: [] }
      : { sql: ARCHIVE_VISIBILITY_SQL, args: [scope.userId, scope.userId] };
  }

  private count(sql: string, args: Array<number | string>): number {
    return Number((this.db.prepare(sql).get(...args) as unknown as { c: number | bigint }).c);
  }

  // ==================== 概览 ====================

  overview(scope: KgViewerScope): KgOverviewRaw {
    const archiveVis = this.archiveVisible(scope);
    const archives = this.count(`SELECT COUNT(1) AS c FROM archives a WHERE ${archiveVis.sql}`, archiveVis.args);
    const files = this.count(
      `SELECT COUNT(1) AS c FROM archive_files f JOIN archives a ON a.id = f.archive_id WHERE ${archiveVis.sql}`,
      archiveVis.args,
    );

    // 图谱节点计数（口径与画布一致：分类节点要「有可见档案」才计入，避免暴露受限内容规模）
    const nodeVis = this.nodeVisible(scope, 'n');
    const nodesByType: Record<KgNodeType, number> = { category: 0, archive: 0, file: 0, chunk: 0 };
    for (const row of this.db
      .prepare(`SELECT n.node_type AS t, COUNT(1) AS c FROM kg_graph_nodes n WHERE ${nodeVis.sql} GROUP BY n.node_type`)
      .all(...nodeVis.args) as unknown as Array<{ t: string; c: number | bigint }>) {
      if (row.t in nodesByType) nodesByType[row.t as KgNodeType] = Number(row.c);
    }
    const totalNodes = nodesByType.category + nodesByType.archive + nodesByType.file + nodesByType.chunk;

    // 关系计数：两端节点都可见才计入（受限档案相关的关系整体不可见）
    const fromVis = this.nodeVisible(scope, 'f');
    const toVis = this.nodeVisible(scope, 't');
    const edgesByType: Partial<Record<KgEdgeType, number>> = {};
    for (const row of this.db
      .prepare(`
        SELECT e.edge_type AS t, COUNT(1) AS c
          FROM kg_graph_edges e
          JOIN kg_graph_nodes f ON f.id = e.from_node
          JOIN kg_graph_nodes t ON t.id = e.to_node
         WHERE ${fromVis.sql} AND ${toVis.sql}
         GROUP BY e.edge_type`)
      .all(...fromVis.args, ...toVis.args) as unknown as Array<{ t: string; c: number | bigint }>) {
      edgesByType[row.t as KgEdgeType] = Number(row.c);
    }
    const relations = Object.values(edgesByType).reduce((sum, value) => sum + (value ?? 0), 0);

    // 分类聚合：档案数 / 附件数 / 知识块数都按可见档案实时统计
    const categoryRows: KgCategoryFacts[] = [];
    const base = this.db
      .prepare(`
        SELECT c.id, c.name, c.code, c.description, c.parent_id
          FROM archive_categories c ORDER BY c.id`)
      .all() as unknown as Array<Record<string, unknown>>;
    const archiveCountByCategory = this.groupCount(
      `SELECT a.category_id AS k, COUNT(1) AS c FROM archives a WHERE ${archiveVis.sql} GROUP BY a.category_id`,
      archiveVis.args,
    );
    const fileCountByCategory = this.groupCount(
      `SELECT a.category_id AS k, COUNT(1) AS c FROM archive_files f JOIN archives a ON a.id = f.archive_id
        WHERE ${archiveVis.sql} GROUP BY a.category_id`,
      archiveVis.args,
    );
    const chunkCountByCategory = this.groupCount(
      `SELECT a.category_id AS k, COUNT(1) AS c FROM kg_graph_nodes n JOIN archives a ON a.id = n.archive_id
        WHERE n.node_type = 'chunk' AND ${archiveVis.sql} GROUP BY a.category_id`,
      archiveVis.args,
    );
    for (const r of base) {
      const id = Number(r.id);
      categoryRows.push({
        id,
        name: String(r.name ?? ''),
        code: String(r.code ?? ''),
        description: String(r.description ?? ''),
        parentId: r.parent_id == null ? null : Number(r.parent_id),
        visibleArchiveCount: archiveCountByCategory.get(id) ?? 0,
        attachmentCount: fileCountByCategory.get(id) ?? 0,
        chunkCount: chunkCountByCategory.get(id) ?? 0,
      });
    }

    return {
      archives,
      categories: categoryRows.filter((row) => row.visibleArchiveCount > 0).length,
      files,
      chunks: nodesByType.chunk,
      relations,
      nodesByType,
      edgesByType,
      totalNodes,
      categoryRows,
    };
  }

  private groupCount(sql: string, args: Array<number | string>): Map<number, number> {
    const map = new Map<number, number>();
    for (const row of this.db.prepare(sql).all(...args) as unknown as Array<{ k: number | bigint; c: number | bigint }>) {
      map.set(Number(row.k), Number(row.c));
    }
    return map;
  }

  // ==================== 节点读取 ====================

  findNode(scope: KgViewerScope, nodeType: KgNodeType, refId: number): KgNodeRecord | undefined {
    const vis = this.nodeVisible(scope, 'n');
    const row = this.db
      .prepare(`SELECT ${NODE_COLUMNS} FROM kg_graph_nodes n WHERE n.node_type = ? AND n.ref_id = ? AND ${vis.sql}`)
      .get(nodeType, refId, ...vis.args) as unknown as Record<string, unknown> | undefined;
    return row ? toNodeRecord(row) : undefined;
  }

  findNodesByIds(scope: KgViewerScope, nodeIds: number[]): KgNodeRecord[] {
    if (!nodeIds.length) return [];
    const vis = this.nodeVisible(scope, 'n');
    const rows = this.db
      .prepare(`SELECT ${NODE_COLUMNS} FROM kg_graph_nodes n WHERE n.id IN (${inClause(nodeIds.length)}) AND ${vis.sql}`)
      .all(...nodeIds, ...vis.args) as unknown as Array<Record<string, unknown>>;
    return rows.map(toNodeRecord);
  }

  findNodesByRefs(scope: KgViewerScope, refs: Array<{ type: KgNodeType; refId: number }>): KgNodeRecord[] {
    if (!refs.length) return [];
    const vis = this.nodeVisible(scope, 'n');
    const pairs = refs.map(() => '(n.node_type = ? AND n.ref_id = ?)').join(' OR ');
    const args: Array<number | string> = [];
    for (const ref of refs) args.push(ref.type, ref.refId);
    const rows = this.db
      .prepare(`SELECT ${NODE_COLUMNS} FROM kg_graph_nodes n WHERE (${pairs}) AND ${vis.sql}`)
      .all(...args, ...vis.args) as unknown as Array<Record<string, unknown>>;
    return rows.map(toNodeRecord);
  }

  listNodes(scope: KgViewerScope, filter: KgNodeListFilter): { items: KgNodeRecord[]; total: number } {
    if (!filter.types.length) return { items: [], total: 0 };
    const vis = this.nodeVisible(scope, 'n');
    const where: string[] = [vis.sql, `n.node_type IN (${inClause(filter.types.length)})`];
    const args: Array<number | string> = [...vis.args, ...filter.types];
    if (filter.categoryIds) {
      if (!filter.categoryIds.length) return { items: [], total: 0 };
      // 分类视图：分类节点按自身编号限定，档案及其下层按所属档案的分类限定
      const holders = inClause(filter.categoryIds.length);
      where.push(
        `( ( n.node_type = 'category' AND n.ref_id IN (${holders}) ) ` +
          `OR ( n.node_type <> 'category' AND EXISTS (SELECT 1 FROM archives a2 ` +
          `WHERE a2.id = n.archive_id AND a2.category_id IN (${holders})) ) )`,
      );
      args.push(...filter.categoryIds, ...filter.categoryIds);
    }
    if (filter.archiveIds) {
      if (!filter.archiveIds.length) return { items: [], total: 0 };
      where.push(`n.archive_id IN (${inClause(filter.archiveIds.length)})`);
      args.push(...filter.archiveIds);
    }
    if (filter.fileIds) {
      if (!filter.fileIds.length) return { items: [], total: 0 };
      where.push(`n.file_id IN (${inClause(filter.fileIds.length)})`);
      args.push(...filter.fileIds);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = this.count(`SELECT COUNT(1) AS c FROM kg_graph_nodes n ${clause}`, args);
    const rows = this.db
      .prepare(`SELECT ${NODE_COLUMNS} FROM kg_graph_nodes n ${clause} ORDER BY ${NODE_ORDER} LIMIT ? OFFSET ?`)
      .all(...args, filter.limit, filter.offset) as unknown as Array<Record<string, unknown>>;
    return { items: rows.map(toNodeRecord), total };
  }

  edgesAmong(scope: KgViewerScope, nodeIds: number[], edgeTypes?: KgEdgeType[], limit = 2000): KgEdgeRecord[] {
    if (!nodeIds.length) return [];
    const placeholders = inClause(nodeIds.length);
    const where: string[] = [`e.from_node IN (${placeholders})`, `e.to_node IN (${placeholders})`];
    const args: Array<number | string> = [...nodeIds, ...nodeIds];
    if (edgeTypes?.length) {
      where.push(`e.edge_type IN (${inClause(edgeTypes.length)})`);
      args.push(...edgeTypes);
    }
    const rows = this.db
      .prepare(`SELECT ${edgeCols} FROM kg_graph_edges e WHERE ${where.join(' AND ')} ORDER BY e.edge_type, e.weight DESC, e.id LIMIT ?`)
      .all(...args, limit) as unknown as Array<Record<string, unknown>>;
    const edges = rows.map(toEdgeRecord);
    // 端点集合理论上已按可见性筛选，这里再复核一次：调用方传入未校验节点 id 时也绝不返回越权关系
    const endpointIds = [...new Set(edges.flatMap((edge) => [edge.fromNode, edge.toNode]))];
    const visible = new Set(this.findNodesByIds(scope, endpointIds).map((node) => node.id));
    return edges.filter((edge) => visible.has(edge.fromNode) && visible.has(edge.toNode));
  }

  neighborRows(scope: KgViewerScope, seedIds: number[], edgeTypes: KgEdgeType[], limit: number): KgNeighborRow[] {
    if (!seedIds.length || !edgeTypes.length) return [];
    const built = this.unionTraversal(scope, seedIds, edgeTypes, limit, 0);
    const rows = this.db.prepare(built.sql).all(...built.args) as unknown as Array<Record<string, unknown>>;
    return rows.map(toNeighborRow);
  }

  edgesOfNode(
    scope: KgViewerScope,
    nodeId: number,
    edgeTypes: KgEdgeType[] | undefined,
    limit: number,
    offset: number,
  ): { items: KgNeighborRow[]; total: number } {
    const seeds = [nodeId];
    const types = edgeTypes?.length ? edgeTypes : allEdgeTypes();
    // 总数：同一形状的去重计数（一个节点出发的边只会在一个方向上命中，UNION ALL 不会重复统计）
    const countSql = `
      SELECT COUNT(1) AS c FROM (
        SELECT e.id AS eid FROM kg_graph_edges e
          JOIN kg_graph_nodes f ON f.id = e.from_node
          JOIN kg_graph_nodes t ON t.id = e.to_node
         WHERE e.from_node IN (${inClause(seeds.length)}) AND e.edge_type IN (${inClause(types.length)})
           AND ${this.nodeVisible(scope, 't').sql}
        UNION ALL
        SELECT e.id FROM kg_graph_edges e
          JOIN kg_graph_nodes f ON f.id = e.from_node
          JOIN kg_graph_nodes t ON t.id = e.to_node
         WHERE e.to_node IN (${inClause(seeds.length)}) AND e.edge_type IN (${inClause(types.length)})
           AND ${this.nodeVisible(scope, 'f').sql}
      )`;
    const countArgs: Array<number | string> = [
      ...seeds,
      ...types,
      ...this.nodeVisible(scope, 't').args,
      ...seeds,
      ...types,
      ...this.nodeVisible(scope, 'f').args,
    ];
    const total = this.count(countSql, countArgs);
    const built = this.unionTraversal(scope, seeds, types, limit, offset);
    const rows = this.db.prepare(built.sql).all(...built.args) as unknown as Array<Record<string, unknown>>;
    return { items: rows.map(toNeighborRow), total };
  }

  edgesByIds(scope: KgViewerScope, edgeIds: number[]): KgEdgeRecord[] {
    if (!edgeIds.length) return [];
    const rows = this.db
      .prepare(`SELECT ${edgeCols} FROM kg_graph_edges e WHERE e.id IN (${inClause(edgeIds.length)})`)
      .all(...edgeIds) as unknown as Array<Record<string, unknown>>;
    const edges = rows.map(toEdgeRecord);
    const endpointIds = [...new Set(edges.flatMap((edge) => [edge.fromNode, edge.toNode]))];
    const visible = new Set(this.findNodesByIds(scope, endpointIds).map((node) => node.id));
    return edges.filter((edge) => visible.has(edge.fromNode) && visible.has(edge.toNode));
  }

  /**
   * 双向邻接遍历（UNION ALL）：
   * 第一分支取「种子在 from_node」的边（邻接端 = to_node，别名 t），第二分支方向相反；
   * 可见性只作用在「邻接端」节点上（种子由调用方保证可见），因此关系两端都可见才成立。
   */
  private unionTraversal(
    scope: KgViewerScope,
    seedIds: number[],
    edgeTypes: KgEdgeType[],
    limit: number,
    offset: number,
  ): { sql: string; args: Array<number | string> } {
    const seeds = inClause(seedIds.length);
    const types = inClause(edgeTypes.length);
    const visT = this.nodeVisible(scope, 't');
    const visF = this.nodeVisible(scope, 'f');
    const sql = `
      SELECT * FROM (
        SELECT f.id AS seed_node_id, ${nodeCols('t')}, ${edgeCols}
          FROM kg_graph_edges e
          JOIN kg_graph_nodes f ON f.id = e.from_node
          JOIN kg_graph_nodes t ON t.id = e.to_node
         WHERE e.from_node IN (${seeds}) AND e.edge_type IN (${types}) AND ${visT.sql}
        UNION ALL
        SELECT t.id AS seed_node_id, ${nodeCols('f')}, ${edgeCols}
          FROM kg_graph_edges e
          JOIN kg_graph_nodes f ON f.id = e.from_node
          JOIN kg_graph_nodes t ON t.id = e.to_node
         WHERE e.to_node IN (${seeds}) AND e.edge_type IN (${types}) AND ${visF.sql}
      ) ORDER BY weight DESC, edge_id, seed_node_id LIMIT ? OFFSET ?`;
    const args: Array<number | string> = [
      ...seedIds,
      ...edgeTypes,
      ...visT.args,
      ...seedIds,
      ...edgeTypes,
      ...visF.args,
      limit,
      offset,
    ];
    return { sql, args };
  }

  // ==================== 业务事实（批量） ====================

  archiveFacts(scope: KgViewerScope, archiveIds: number[]): Map<number, KgArchiveFacts> {
    const map = new Map<number, KgArchiveFacts>();
    if (!archiveIds.length) return map;
    const vis = this.archiveVisible(scope);
    const rows = this.db
      .prepare(`
        SELECT a.id, a.title, a.archive_no, a.category_id, a.archive_type, a.status, a.access_level,
               a.responsible, a.formation_date, a.keywords, a.created_at,
               c.name AS category_name,
               (SELECT COUNT(1) FROM archive_files f WHERE f.archive_id = a.id) AS file_count,
               (SELECT COUNT(1) FROM kg_graph_nodes n WHERE n.node_type = 'chunk' AND n.archive_id = a.id) AS chunk_count
          FROM archives a LEFT JOIN archive_categories c ON c.id = a.category_id
         WHERE a.id IN (${inClause(archiveIds.length)}) AND ${vis.sql}
         ORDER BY a.id`)
      .all(...archiveIds, ...vis.args) as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      map.set(Number(r.id), {
        id: Number(r.id),
        title: String(r.title ?? ''),
        archiveNo: String(r.archive_no ?? ''),
        categoryId: Number(r.category_id ?? 0),
        categoryName: String(r.category_name ?? ''),
        archiveType: String(r.archive_type ?? ''),
        status: String(r.status ?? ''),
        accessLevel: String(r.access_level ?? 'public'),
        responsible: String(r.responsible ?? ''),
        formationDate: r.formation_date == null ? null : String(r.formation_date),
        keywords: String(r.keywords ?? ''),
        createdAt: String(r.created_at ?? ''),
        fileCount: Number(r.file_count ?? 0),
        chunkCount: Number(r.chunk_count ?? 0),
      });
    }
    return map;
  }

  fileFacts(scope: KgViewerScope, fileIds: number[]): Map<number, KgFileFacts> {
    const map = new Map<number, KgFileFacts>();
    if (!fileIds.length) return map;
    const vis = this.archiveVisible(scope);
    const rows = this.db
      .prepare(`
        SELECT f.id, f.archive_id, f.original_name, f.extension, f.file_size, f.content_type, f.uploaded_at,
               COALESCE(u.status, 'pending') AS extract_status, COALESCE(u.message, '') AS extract_message,
               COALESCE(u.extractor, '') AS extractor, COALESCE(u.char_count, 0) AS char_count,
               COALESCE(u.truncated, 0) AS truncated,
               (SELECT COUNT(1) FROM kg_graph_nodes n WHERE n.node_type = 'chunk' AND n.file_id = f.id) AS chunk_count
          FROM archive_files f
          JOIN archives a ON a.id = f.archive_id
          LEFT JOIN archive_content_units u
            ON u.file_id = f.id AND u.stored_name = f.stored_name AND u.sha256 = f.sha256
         WHERE f.id IN (${inClause(fileIds.length)}) AND ${vis.sql}
         ORDER BY f.id`)
      .all(...fileIds, ...vis.args) as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      map.set(Number(r.id), {
        id: Number(r.id),
        archiveId: Number(r.archive_id),
        originalName: String(r.original_name ?? ''),
        extension: String(r.extension ?? ''),
        fileSize: Number(r.file_size ?? 0),
        contentType: String(r.content_type ?? ''),
        uploadedAt: String(r.uploaded_at ?? ''),
        extractStatus: String(r.extract_status ?? 'pending'),
        extractMessage: String(r.extract_message ?? ''),
        extractor: String(r.extractor ?? ''),
        charCount: Number(r.char_count ?? 0),
        chunkCount: Number(r.chunk_count ?? 0),
        truncated: Number(r.truncated ?? 0) === 1,
      });
    }
    return map;
  }

  chunkFacts(scope: KgViewerScope, chunkIds: number[]): Map<number, KgChunkFacts> {
    const map = new Map<number, KgChunkFacts>();
    for (const r of this.chunkRows(scope, chunkIds, false)) map.set(Number(r.id), toChunkFacts(r));
    return map;
  }

  chunkText(scope: KgViewerScope, chunkId: number): (KgChunkFacts & { text: string }) | undefined {
    const rows = this.chunkRows(scope, [chunkId], true);
    if (!rows.length) return undefined;
    return { ...toChunkFacts(rows[0]), text: String(rows[0].text ?? '') };
  }

  chunkTexts(scope: KgViewerScope, chunkIds: number[], maxLength: number): Map<number, string> {
    const map = new Map<number, string>();
    for (const r of this.chunkRows(scope, chunkIds, true)) {
      map.set(Number(r.id), String(r.text ?? '').slice(0, Math.max(1, maxLength)));
    }
    return map;
  }

  /** 知识块投影：始终带档案可见性条件，正文只在 withText 时取出（长度由调用方截断）。 */
  private chunkRows(scope: KgViewerScope, chunkIds: number[], withText: boolean): Array<Record<string, unknown>> {
    if (!chunkIds.length) return [];
    const vis = this.archiveVisible(scope);
    return this.db
      .prepare(`
        SELECT c.id, c.archive_id, c.file_id, c.chunk_no, c.locator, c.page_no, c.pos_from, c.pos_to,
               LENGTH(c.text) AS text_length, f.original_name AS file_name${withText ? ', c.text AS text' : ''}
          FROM archive_content_chunks c
          JOIN archives a ON a.id = c.archive_id
          JOIN archive_files f ON f.id = c.file_id AND f.archive_id = c.archive_id
          JOIN archive_content_units u ON u.id = c.unit_id
          JOIN (${CURRENT_CONTENT_SQL}) cur ON cur.file_id = f.id AND cur.stored_name = u.stored_name AND cur.sha256 = u.sha256
         WHERE c.id IN (${inClause(chunkIds.length)}) AND ${vis.sql}
         ORDER BY c.id`)
      .all(...chunkIds, ...vis.args) as unknown as Array<Record<string, unknown>>;
  }

  categoryFacts(scope: KgViewerScope, categoryIds: number[]): Map<number, KgCategoryFacts> {
    const map = new Map<number, KgCategoryFacts>();
    if (!categoryIds.length) return map;
    const vis = this.archiveVisible(scope);
    const rows = this.db
      .prepare(`
        SELECT c.id, c.name, c.code, c.description, c.parent_id,
               (SELECT COUNT(1) FROM archives a WHERE a.category_id = c.id AND ${vis.sql}) AS visible_archive_count,
               (SELECT COUNT(1) FROM archive_files f JOIN archives a ON a.id = f.archive_id
                 WHERE a.category_id = c.id AND ${vis.sql}) AS attachment_count,
               (SELECT COUNT(1) FROM kg_graph_nodes n JOIN archives a ON a.id = n.archive_id
                 WHERE n.node_type = 'chunk' AND a.category_id = c.id AND ${vis.sql}) AS chunk_count
          FROM archive_categories c
         WHERE c.id IN (${inClause(categoryIds.length)})
         ORDER BY c.id`)
      // 参数顺序即 SQL 文本顺序：三个 SELECT 子查询的可见性参数先于 WHERE 里的分类编号
      .all(...vis.args, ...vis.args, ...vis.args, ...categoryIds) as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      map.set(Number(r.id), {
        id: Number(r.id),
        name: String(r.name ?? ''),
        code: String(r.code ?? ''),
        description: String(r.description ?? ''),
        parentId: r.parent_id == null ? null : Number(r.parent_id),
        visibleArchiveCount: Number(r.visible_archive_count ?? 0),
        attachmentCount: Number(r.attachment_count ?? 0),
        chunkCount: Number(r.chunk_count ?? 0),
      });
    }
    return map;
  }
}

// ==================== 行映射 ====================

function allEdgeTypes(): KgEdgeType[] {
  return [
    'category_contains_archive',
    'archive_contains_file',
    'file_contains_chunk',
    'chunk_similar_to',
    'archive_related_to',
    'archive_shared_reference',
  ];
}

function toNodeRecord(r: Record<string, unknown>): KgNodeRecord {
  return {
    id: Number(r.id),
    nodeType: String(r.node_type) as KgNodeType,
    bizKey: String(r.biz_key),
    refId: Number(r.ref_id),
    archiveId: r.archive_id == null ? null : Number(r.archive_id),
    fileId: r.file_id == null ? null : Number(r.file_id),
    name: String(r.name ?? ''),
  };
}

function toEdgeRecord(r: Record<string, unknown>): KgEdgeRecord {
  return {
    id: Number(r.edge_id ?? r.id),
    edgeType: String(r.edge_type) as KgEdgeType,
    fromNode: Number(r.from_node),
    toNode: Number(r.to_node),
    weight: Number(r.weight ?? 0),
    basis: String(r.basis ?? ''),
    evidence: parseJson(r.evidence_json),
  };
}

function toNeighborRow(r: Record<string, unknown>): KgNeighborRow {
  return {
    seedNodeId: Number(r.seed_node_id),
    neighbor: {
      id: Number(r.n_id),
      nodeType: String(r.n_type) as KgNodeType,
      bizKey: String(r.n_key),
      refId: Number(r.n_ref),
      archiveId: r.n_archive == null ? null : Number(r.n_archive),
      fileId: r.n_file == null ? null : Number(r.n_file),
      name: String(r.n_name ?? ''),
    },
    edge: toEdgeRecord(r),
  };
}

function toChunkFacts(r: Record<string, unknown>): KgChunkFacts {
  return {
    id: Number(r.id),
    archiveId: Number(r.archive_id),
    fileId: Number(r.file_id),
    fileName: String(r.file_name ?? ''),
    chunkNo: Number(r.chunk_no ?? 0),
    locator: String(r.locator ?? ''),
    pageNo: r.page_no == null ? null : Number(r.page_no),
    posFrom: r.pos_from == null ? null : Number(r.pos_from),
    posTo: r.pos_to == null ? null : Number(r.pos_to),
    textLength: Number(r.text_length ?? 0),
  };
}
