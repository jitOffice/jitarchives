/**
 * 统一检索调度服务（全系统统一智能检索 · 第一批）。
 *
 * 职责：把一次检索请求拆成「档案 / 附件 / 正文 / 分类」四类子检索并聚合成统一结构，
 * 四类子检索全部复用现有实现，本层只做范围编排、权限复核与降级标注：
 *  档案组 → ArchivesService.searchArchives（含档号/标题/关键词/分类/状态与动态元数据命中）
 *  附件组 → UnifiedSearchRepository.searchFiles（SQL 层可见性过滤 + ArchiveAccessService 逐档复核）
 *  正文组 → ContentIndexRepository.searchChunks（复用既有 FTS5 索引；无 FTS5 时 LIKE 兜底并如实降级）
 *  分类组 → ArchivesService.listCategories（层级、编码链与按可见性统计的档案数量都是现成的）
 *
 * 安全底线：
 * - 带分类/状态限定时，附件与正文只在「目录检索按可见性过滤后的档案集合」内检索；
 * - 附件组返回前逐条用 ArchiveAccessService 复核（与正文检索「SQL + 服务层」双闸口径一致）；
 * - 本服务全程只读，不写业务数据、不改任何权限结论、不新建搜索库或搜索表。
 */
import { Inject, Injectable } from '@nestjs/common';
import { ArchivesService } from '../archives/archives.service';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { CategoryRepository } from '../archives/archive.repositories';
import {
  ContentIndexRepository,
  ViewerScope,
} from '../archives/content/content-index.repositories';
import { ROLE_ADMIN, Role, UserView } from '../common/roles';
import { DEFAULT_UNIFIED_SCOPES, SEARCH_SCOPES, SearchScope } from '../agent/intent.parser';
import { ContentKeywordSearchService } from './content-keyword-search.service';
import { UnifiedSearchRepository } from './unified-search.repositories';
import {
  UnifiedArchiveHit,
  UnifiedCategoryHit,
  UnifiedContentHit,
  UnifiedGroup,
  UnifiedQuery,
  UnifiedSearchResult,
} from './unified-search.types';

/** 附件/正文检索的档案范围：限定分类或状态时，先取有权限的档案集合再在其内检索（完整分页获取，不限制条数）。 */

@Injectable()
export class UnifiedSearchService {
  constructor(
    @Inject(ArchivesService) private readonly archives: ArchivesService,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(CategoryRepository) private readonly categories: CategoryRepository,
    @Inject(UnifiedSearchRepository) private readonly repo: UnifiedSearchRepository,
    @Inject(ContentIndexRepository) private readonly contentUnits: ContentIndexRepository,
    @Inject(ContentKeywordSearchService) private readonly keywords: ContentKeywordSearchService,
  ) {}

  search(query: UnifiedQuery, operator: UserView): UnifiedSearchResult {
    const scopes = this.resolveScopes(query.scopes);
    const keyword = this.clean(query.keyword);
    const title = this.clean(query.title);
    const archiveNo = this.clean(query.archiveNo);
    const extension = this.cleanExtension(query.extension);
    const limit = this.boundedLimit(query.limit);
    const status = query.status === 'draft' || query.status === 'archived' ? query.status : '';
    const categoryId = this.positiveId(query.categoryId);
    const fileName = this.clean(query.attachmentFileName);
    const page = Number.isSafeInteger(query.page) && query.page! > 0 ? query.page! : 1;
    const hasTerm = !!(keyword || title || archiveNo || extension || categoryId || status);

    const empty = <T>(): UnifiedGroup<T> => ({ total: 0, shown: 0, items: [] });
    const result: UnifiedSearchResult = {
      scopes,
      archives: empty<UnifiedArchiveHit>(),
      attachments: empty(),
      contents: empty<UnifiedContentHit>(),
      categories: empty<UnifiedCategoryHit>(),
      degraded: false,
      totalHits: 0,
    };
    if (query.archiveIds && !query.archiveIds.length && scopes.every(s => s === 'attachment' || s === 'content')) return result;
    // 显式附件/分类列表允许空关键词，其余范围保留原有空条件限制；所有查询仍按用户可见性过滤。
    if (!hasTerm && !fileName && query.archiveIds === undefined && !scopes.includes('attachment') && !scopes.includes('category')) return result;

    const viewer = { id: operator.id, role: operator.role as Role };
    // 目录检索只跑一次：档案组取展示切片，附件/正文组取「有权限的档案范围」
    const needScope = scopes.includes('attachment') || scopes.includes('content');
    const narrowScope = !!categoryId || !!status;
    // 修复 100 条限制：完整分页获取符合权限的档案范围，不因超过 100 条而遗漏结果
    const allArchiveIds: number[] = [];
    if (needScope && narrowScope) {
      let page = 1;
      const pageSize = 100; // 每页 100 条，循环获取直到没有更多
      while (true) {
        const archiveView = this.archives.searchArchives(
          {
            q: '',
            title,
            archiveNo,
            categoryId: categoryId ? String(categoryId) : '',
            includeSub: '1',
            status,
            page: String(page),
            pageSize: String(pageSize),
          },
          viewer,
        );
        allArchiveIds.push(...archiveView.items.map((item) => item.id));
        if (archiveView.items.length < pageSize || page * pageSize >= archiveView.total) {
          break;
        }
        page++;
      }
    }
    const archiveView = scopes.includes('archive') ? this.archives.searchArchives(
      {
        q: keyword,
        title,
        archiveNo,
        categoryId: categoryId ? String(categoryId) : '',
        includeSub: '1',
        status,
        page: String(page),
        pageSize: String(limit),
      },
      viewer,
    ) : { items: [], total: 0 };
    const scopeIds = query.archiveIds === undefined ? (narrowScope ? allArchiveIds : undefined)
      : query.archiveIds.filter(id => !narrowScope || allArchiveIds.includes(id));

    if (scopes.includes('archive')) {
      const shown = archiveView.items.slice(0, limit);
      result.archives = {
        total: archiveView.total,
        shown: shown.length,
        items: shown.map<UnifiedArchiveHit>((item) => ({
          id: item.id,
          title: item.title,
          archiveNo: item.archiveNo,
        })),
      };
    }

    // 附件组：跨档案按文件名/格式/所属档案/当前版本检索（无分类/状态限定时由 SQL 可见性过滤即可）
    if (scopes.includes('attachment')) {
      const found = this.repo.searchFiles({
        term: keyword,
        fileName,
        archiveTitle: title,
        archiveNo,
        extension,
        archiveIds: scopeIds,
        fileIds: query.fileIds,
        viewer: { id: operator.id, role: operator.role },
        limit,
        page,
      });
      const allowed = found.items.filter((row) => {
        try {
          return this.access.canView(operator, this.access.loadArchive(row.archiveId));
        } catch {
          // 档案已删除等异常一律不放行：绝不因检索命中而泄露
          return false;
        }
      });
      result.attachments = { total: found.total, shown: allowed.length, items: allowed };
    }

    // 正文组：复用既有 FTS5 索引（受限正文在 SQL 层即被拦截），FTS5 不可用时如实标注降级
    if (scopes.includes('content') && keyword && (!scopeIds || scopeIds.length)) {
      const scope: ViewerScope = { userId: operator.id, admin: operator.role === ROLE_ADMIN };
      // Shared lexical search counts deduplicated, current-version hits before presentation pagination.
      const lexical = this.keywords.search({query:keyword,scope,archiveIds:scopeIds,fileIds:query.fileIds,archiveNo,archiveTitle:title,extension});
      const rows = lexical.items;
      result.retrievalMode=lexical.retrievalMode;
      result.degradedReason=lexical.degradedReason;
      result.degraded = !this.contentUnits.ftsAvailable();
      const matching = rows.filter(row => (!extension || row.extension.toLowerCase() === extension) &&
        this.access.canView(operator, this.access.loadArchive(row.archiveId)));
      const filtered = matching.slice((page - 1) * limit, page * limit);
      result.contents = {
        total: matching.length,
        shown: filtered.length,
        items: filtered.map<UnifiedContentHit>((row) => ({
          archiveId: row.archiveId,
          fileId: row.fileId,
          unitId: row.unitId,
          chunkId: row.chunkId,
          pageNo: row.pageNo,
          posFrom: row.posFrom,
          posTo: row.posTo,
          archiveTitle: row.archiveTitle,
          archiveNo: row.archiveNo,
          fileName: row.fileName,
          extension: row.extension,
          versionNo: row.versionNo,
          locator: row.locator,
          text: row.text,
          score: row.score,
        })),
      };
    }

    // 分类组：复用既有分类视图（名称/编码/层级/按可见性统计的档案数量均为真实数据）
    if (scopes.includes('category')) {
      const subtree = categoryId ? this.subtreeIds(categoryId) : [];
      const term = (keyword || title || archiveNo || '').toLowerCase();
      const matched = this.archives.listCategories(viewer).filter((c) => {
        if (subtree.length && subtree.includes(c.id)) return true;
        if (!term) return !categoryId;
        return (
          c.name.toLowerCase().includes(term) ||
          c.code.toLowerCase().includes(term) ||
          c.pathCode.toLowerCase().includes(term)
        );
      });
      result.categories = {
        total: matched.length,
        shown: Math.min(matched.length, limit),
        items: matched.slice(0, limit).map<UnifiedCategoryHit>((c) => ({
          id: c.id,
          name: c.name,
          code: c.code,
          pathCode: c.pathCode,
          depth: c.depth,
          parentId: c.parentId,
          archiveCount: c.archiveCount,
        })),
      };
    }

    result.totalHits =
      result.archives.total + result.attachments.total + result.contents.total + result.categories.total;
    return result;
  }

  /** 生效范围：缺省四类全开；非法值剔除，顺序固定为档案 → 附件 → 正文 → 分类。 */
  private resolveScopes(raw?: SearchScope[]): SearchScope[] {
    const asked = Array.isArray(raw) && raw.length ? raw : [...DEFAULT_UNIFIED_SCOPES];
    const allowed = new Set<string>(SEARCH_SCOPES);
    const picked = new Set(asked.filter((s): s is SearchScope => allowed.has(s)));
    return SEARCH_SCOPES.filter((s) => picked.has(s));
  }

  /** 分类子树展开：与目录检索的「含子分类」口径一致（同一份分类数据，不重复实现规则）。 */
  private subtreeIds(rootId: number): number[] {
    const rows = this.categories.listAll();
    const childrenOf = new Map<number, number[]>();
    for (const r of rows) {
      if (r.parentId == null) continue;
      const list = childrenOf.get(r.parentId) ?? [];
      list.push(r.id);
      childrenOf.set(r.parentId, list);
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

  private clean(raw?: string): string {
    return String(raw ?? '').trim();
  }

  private positiveId(raw?: number): number | undefined {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }

  private boundedLimit(raw: number): number {
    const n = Math.trunc(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return 8;
    return Math.min(n, 100);
  }

  /** 扩展名归一化：去点、转小写，仅保留字母数字（不信任外部输入）。 */
  private cleanExtension(raw?: string): string {
    const value = this.clean(raw).replace(/^\./, '').toLowerCase();
    return /^[a-z0-9]{1,10}$/.test(value) ? value : '';
  }
}
