/**
 * 档案知识图谱 · 前端类型（与后端 graph.query.types.ts 一一对应）。
 *
 * 约定：
 * - 这里只有「当前登录用户可见」的数据，前端不再做权限判断，也不允许伪造节点；
 * - 展示字段是后端白名单投影的结果，不含数据库整行，也不含内部 meta_json；
 * - 本文件为纯类型模块（无运行时代码），供 API 层、Pinia store、画布组件与自动化测试共用。
 */

export type KgNodeType = 'category' | 'archive' | 'file' | 'chunk';

export type KgEdgeType =
  | 'category_contains_archive'
  | 'archive_contains_file'
  | 'file_contains_chunk'
  | 'chunk_similar_to'
  | 'archive_related_to'
  | 'archive_shared_reference';

export type KgGraphView = 'panorama' | 'category';

export interface KgGraphNodeView {
  key: string;
  id: number;
  type: KgNodeType;
  refId: number;
  label: string;
  archiveId: number | null;
  fileId: number | null;
  depth?: number;
  expandable: boolean;
  childCount: number;
  facts: Record<string, string | number | null | boolean>;
}

export interface KgGraphEdgeView {
  id: number;
  type: KgEdgeType;
  label: string;
  from: string;
  to: string;
  fromId: number;
  toId: number;
  weight: number;
  basis: string;
  reason: string;
}

export interface KgGraphPage {
  page: number;
  pageSize: number;
  totalNodes: number;
  returnedNodes: number;
  returnedEdges: number;
  truncated: boolean;
}

export interface KgGraphResponse {
  view: KgGraphView;
  mode: 'overview' | 'expand';
  center?: KgGraphNodeView;
  nodes: KgGraphNodeView[];
  edges: KgGraphEdgeView[];
  page: KgGraphPage;
  limits: { maxNodes: number; maxDepth: number };
}

export interface KgCategorySummary {
  id: number;
  key: string;
  name: string;
  code: string;
  parentId: number | null;
  depth: number;
  archiveCount: number;
  subtreeArchiveCount: number;
  attachmentCount: number;
  chunkCount: number;
}

export interface KgOverviewResponse {
  archives: number;
  categories: number;
  files: number;
  chunks: number;
  relations: number;
  nodesByType: Record<KgNodeType, number>;
  edgesByType: Partial<Record<KgEdgeType, number>>;
  categoryList: KgCategorySummary[];
  notBuilt: boolean;
}

export type KgEdgeEvidence =
  | { basis: 'business_structure'; origin: string; archiveId?: number | null; fileId?: number | null; chunkId?: number | null; locator?: string; pageNo?: number | null }
  | { basis: 'tfidf_cosine'; method: string; tokenizer: string; similarity: number; sharedTermCount: number; sharedTerms: string[]; from: KgEvidenceLocator; to: KgEvidenceLocator }
  | { basis: 'tfidf_cosine_aggregated'; method: string; formula: string; maxChunkSimilarity: number; supportCount: number; supportingChunks: KgSupportingChunkPair[] }
  | { basis: 'metadata_exact_match'; fieldKey: string; fieldLabel: string; value: string; matchedOn: string; sharedValueCount: number }
  | { basis: 'unknown'; note: string };

export interface KgEvidenceLocator {
  chunkId: number;
  fileId: number;
  archiveId: number;
  chunkNo: number;
  locator: string;
  pageNo: number | null;
  preview: string;
}

export interface KgSupportingChunkPair {
  from?: KgEvidenceLocator;
  to?: KgEvidenceLocator;
  fromChunkId: number;
  toChunkId: number;
  fromFileId: number | null;
  toFileId: number | null;
  similarity: number;
  sharedTerms: string[];
}

export interface KgRelationItem {
  edge: KgGraphEdgeView;
  node: KgGraphNodeView;
  evidence: KgEdgeEvidence;
}

export interface KgRelationsResponse {
  node: KgGraphNodeView;
  total: number;
  page: number;
  pageSize: number;
  items: KgRelationItem[];
}

export interface KgDetailPermissions {
  canView: boolean;
  canDownload: boolean;
}

export interface KgCategoryDetail {
  type: 'category';
  node: KgGraphNodeView;
  relationCount: number;
  name: string;
  code: string;
  description: string;
  parentId: number | null;
  parentName: string | null;
  archiveCount: number;
  archives: Array<{ key: string; id: number; title: string; archiveNo: string; status: string; fileCount: number }>;
}

export interface KgArchiveDetail {
  type: 'archive';
  node: KgGraphNodeView;
  relationCount: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  archiveType: string;
  status: string;
  statusLabel: string;
  accessLevel: string;
  responsible: string;
  formationDate: string | null;
  keywords: string;
  createdAt: string;
  files: Array<{ key: string; id: number; name: string; extension: string; fileSize: number; extractStatus: string; chunkCount: number }>;
  relatedArchives: KgRelationItem[];
  permissions: KgDetailPermissions;
}

export interface KgFileDetail {
  type: 'file';
  node: KgGraphNodeView;
  relationCount: number;
  name: string;
  extension: string;
  fileSize: number;
  contentType: string;
  uploadedAt: string;
  extractStatus: string;
  extractMessage: string;
  extractor: string;
  charCount: number;
  chunkCount: number;
  truncated: boolean;
  archive: { key: string; id: number; title: string; archiveNo: string; categoryName: string };
  chunks: Array<{ key: string; id: number; chunkNo: number; locator: string; pageNo: number | null; excerpt: string }>;
  permissions: KgDetailPermissions;
}

export interface KgChunkDetail {
  type: 'chunk';
  node: KgGraphNodeView;
  relationCount: number;
  chunkNo: number;
  locator: string;
  pageNo: number | null;
  posFrom: number | null;
  posTo: number | null;
  excerpt: string;
  textLength: number;
  file: { key: string; id: number; name: string; extension: string };
  archive: { key: string; id: number; title: string; archiveNo: string; categoryName: string };
  relatedChunks: KgRelationItem[];
  permissions: KgDetailPermissions;
}

export type KgNodeDetailResponse = KgCategoryDetail | KgArchiveDetail | KgFileDetail | KgChunkDetail;

export interface KgSearchHit {
  key: string | null;
  type: KgNodeType;
  refId: number;
  title: string;
  subtitle: string;
  archiveId: number | null;
  fileId: number | null;
  locator?: string;
  pageNo?: number | null;
  excerpt?: string;
  score?: number;
  inGraph: boolean;
}

export interface KgSearchResponse {
  query: string;
  total: number;
  retrievalMode?: 'fts5' | 'like' | 'mixed';
  degraded: boolean;
  degradedReason?: string | null;
  groups: Record<KgNodeType, KgSearchHit[]>;
}

/** 节点中心寻址（与后端 center=type:refId 同格式）。 */
export interface KgNodeRef {
  type: KgNodeType;
  refId: number;
}

export function kgNodeKeyOf(ref: KgNodeRef): string {
  return `${ref.type}:${ref.refId}`;
}

/**
 * 解析节点键。
 * category / archive / file 的键就是「类型:业务主键」；chunk 的键是「chunk:<物理文件名>:<序号>」，
 * 里面并不含数据库主键，因此只回类型与原始尾串，调用方需要 refId 时必须走节点对象本身。
 */
export function parseKgNodeKey(key: string): { type: KgNodeType; refId: number | null; rawId: string } | undefined {
  const matched = /^(category|archive|file|chunk):(.+)$/u.exec(key);
  if (!matched) return undefined;
  const rawId = matched[2];
  return { type: matched[1] as KgNodeType, refId: /^\d+$/u.test(rawId) ? Number(rawId) : null, rawId };
}

/** Exact, permission-checked edge lookup; independent of paginated relation lists. */
export interface KgEdgeDetailResponse {
  edge: KgGraphEdgeView;
  from: KgGraphNodeView;
  to: KgGraphNodeView;
  evidence: KgEdgeEvidence;
  supportingNodes: KgGraphNodeView[];
}
