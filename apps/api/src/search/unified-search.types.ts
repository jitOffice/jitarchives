/**
 * 全系统统一智能检索 · 领域类型（第一批）。
 *
 * 设计原则：统一检索只做「调度与聚合」，四类检索全部委托给已有能力：
 *  档案   → ArchivesService.searchArchives（含档号/标题/关键词/分类/状态/动态元数据命中）
 *  附件   → UnifiedSearchRepository.searchFiles（跨档案按文件名/格式/所属档案/当前版本检索）
 *  正文   → ContentIndexRepository.searchChunks（复用既有 SQLite FTS5 索引，短词 LIKE 兜底）
 *  分类   → ArchivesService.listCategories（复用既有层级、编码链与按可见性统计的档案数量）
 * 本模块不新建任何搜索库/搜索表，也不重复实现权限逻辑。
 */
import type { SearchScope } from '../agent/intent.parser';

/** 单个分组的查询条件（由调度服务按生效范围下发给对应检索实现）。 */
export interface UnifiedQuery {
  /** Dedicated filename, archive scope and pagination for the read-only Agent dispatcher. */
  attachmentFileName?: string;
  archiveIds?: number[];
  fileIds?: number[];
  page?: number;
  /** 主题关键词：档案组按既有 OR 语义命中目录与动态著录值；附件组命中标题与文件名；正文组命中片段；分类组命中名称/编码链。 */
  keyword?: string;
  /** 仅按档案标题匹配（档案组专用，沿用既有标题检索参数）。 */
  title?: string;
  /** 仅按档号匹配（档案组专用）。 */
  archiveNo?: string;
  /** 分类筛选（调度服务按既有「含子分类」口径展开）。 */
  categoryId?: number;
  /** 档案状态筛选。 */
  status?: 'draft' | 'archived';
  /** 附件格式（扩展名，小写不带点），限定附件组与正文组。 */
  extension?: string;
  /** 生效范围；缺省为四类全开。 */
  scopes?: SearchScope[];
  /** 每组最多返回条数。 */
  limit: number;
}

/** 附件检索行：附件本体 + 所属档案目录字段 + 当前入库版本信息。 */
export interface FileSearchRow {
  fileId: number;
  fileName: string;
  extension: string;
  fileSize: number;
  contentType: string;
  uploadedBy: number;
  uploadedAt: string;
  uploaderName: string;
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  categoryId: number;
  status: 'draft' | 'archived';
  /** 当前最新已入库版本号；null 表示尚无版本记录（即上传原件本身）。 */
  versionNo: number | null;
  versionCount: number;
}

/** 单个分组的结果容器（total 为数据库真实命中数，shown 为本组实际返回数）。 */
export interface UnifiedGroup<T> {
  total: number;
  shown: number;
  items: T[];
}

export interface UnifiedSearchResult {
  /** 本次实际生效的范围（按请求 scopes 与检索条件裁剪后）。 */
  scopes: SearchScope[];
  archives: UnifiedGroup<UnifiedArchiveHit>;
  attachments: UnifiedGroup<FileSearchRow>;
  contents: UnifiedGroup<UnifiedContentHit>;
  categories: UnifiedGroup<UnifiedCategoryHit>;
  /** 正文索引降级说明（FTS5 不可用时如实标注，不伪装 BM25 排序）。 */
  degraded: boolean;
  retrievalMode?: 'fts5' | 'like' | 'mixed';
  degradedReason?: string | null;
  /** 命中总数（各生效分组之和），用于上层判断是否空结果。 */
  totalHits: number;
}

/** 档案组命中：只保留调度层需要的目录级字段，视图组装由调用方完成。 */
export interface UnifiedArchiveHit {
  id: number;
  title: string;
  archiveNo: string;
}

/** 正文组命中：包装既有证据行，附带该片段所属档案是否在允许范围内。 */
export interface UnifiedContentHit {
  unitId?: number;
  chunkId?: number;
  pageNo?: number | null;
  posFrom?: number;
  posTo?: number;
  archiveId: number;
  fileId: number;
  archiveTitle: string;
  archiveNo: string;
  fileName: string;
  extension: string;
  versionNo: number | null;
  locator: string;
  text: string;
  score: number;
}

/** 分类组命中：直接复用既有分类视图字段。 */
export interface UnifiedCategoryHit {
  id: number;
  name: string;
  code: string;
  pathCode: string;
  depth: number;
  parentId: number | null;
  archiveCount: number;
}
