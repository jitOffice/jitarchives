/**
 * 档案知识图谱 · 第二阶段查询视图类型（对外 DTO）。
 *
 * 边界约定：
 * - 图谱表只提供拓扑（节点 + 关系），展示用的业务事实一律取权威表（档案 / 分类 / 附件 / 正文片段），
 *   因此本文件里的字段都是「白名单投影」，不存在 meta_json / 数据库整行的透传；
 * - 所有集合都是「当前登录用户可见」的子集：无权档案的节点、关系、统计与搜索命中都不会出现在这里；
 * - 关系证据（evidence）按计算依据分形状给出，只包含定位信息与词项，不含正文全文。
 */
import { KgEdgeType, KgNodeType } from './graph.types';

/** 查询视角：全景（分类 + 档案层）/ 分类（指定分类子树）。 */
export type KgGraphView = 'panorama' | 'category';

/** 服务层访问者范围（与正文检索 ViewerScope 同口径：非管理员叠加档案可见性条件）。 */
export interface KgViewerScope {
  userId: number;
  admin: boolean;
}

/** 画布节点：拓扑信息 + 该类型必要的展示字段。 */
export interface KgGraphNodeView {
  /** 节点幂等键（category:1 / archive:12 / file:5 / chunk:<storedName>:3），前端以此为稳定 id。 */
  key: string;
  /** kg_graph_nodes.id（数据库主键，关系定位用）。 */
  id: number;
  type: KgNodeType;
  /** 权威业务行主键（分类 id / 档案 id / 附件 id / 知识块 id）。 */
  refId: number;
  /** 展示名（分类名 / 档案标题 / 附件原名 / 知识块摘录首行）。 */
  label: string;
  /** 所属档案 id（分类节点为 null）。 */
  archiveId: number | null;
  /** 所属附件 id（仅知识块 / 附件节点有值）。 */
  fileId: number | null;
  /** 分类节点的层级（0 起），用于全景视图分层布局。 */
  depth?: number;
  /** 该子树是否还有未加载的下层节点（前端据此显示「可展开」标记）。 */
  expandable: boolean;
  /** 子节点数量（按可见范围实时统计，真实数据）。 */
  childCount: number;
  /** 类型相关的展示字段（受控白名单，非 meta_json 透传）。 */
  facts: Record<string, string | number | null | boolean>;
}

/** 画布关系：端点用节点键表示，附证据摘要。 */
export interface KgGraphEdgeView {
  id: number;
  type: KgEdgeType;
  /** 关系中文说明（与第一阶段 KG_EDGE_TYPE_LABEL 同源）。 */
  label: string;
  from: string;
  to: string;
  fromId: number;
  toId: number;
  weight: number;
  /** 计算依据标识（business_structure / tfidf_cosine / tfidf_cosine_aggregated / metadata_exact_match）。 */
  basis: string;
  /** 关联原因的一句话说明（不含内部实现细节）。 */
  reason: string;
}

/** 图谱查询分页与裁剪信息。 */
export interface KgGraphPage {
  page: number;
  pageSize: number;
  totalNodes: number;
  returnedNodes: number;
  returnedEdges: number;
  /** 是否因为数量上限被裁剪（前端提示「已显示前 N 个」）。 */
  truncated: boolean;
}

export interface KgGraphQuery {
  view: KgGraphView;
  categoryId?: number;
  /** 展开模式：以「type:refId」为中心节点按深度取邻接（与详情接口同一寻址方式）。 */
  center?: { type: KgNodeType; refId: number };
  depth: number;
  types?: KgNodeType[];
  edgeTypes?: KgEdgeType[];
  /** 是否一并返回内容关联 / 确定性关联边（默认全景返回，展开时按需）。 */
  includeRelations: boolean;
  page: number;
  pageSize: number;
}

export interface KgGraphResponse {
  view: KgGraphView;
  mode: 'overview' | 'expand';
  center?: KgGraphNodeView;
  nodes: KgGraphNodeView[];
  edges: KgGraphEdgeView[];
  page: KgGraphPage;
  /** 当前用户可见的节点上限（用于前端提示是否还有未加载内容）。 */
  limits: { maxNodes: number; maxDepth: number };
}

/** 左侧概览：全部按当前用户可见范围实时计算。 */
export interface KgOverviewResponse {
  archives: number;
  categories: number;
  files: number;
  chunks: number;
  relations: number;
  nodesByType: Record<KgNodeType, number>;
  edgesByType: Partial<Record<KgEdgeType, number>>;
  /** 分类概览列表（仅含当前用户可见档案的分类）。 */
  categoryList: KgCategorySummary[];
  /** 图谱尚未构建（库中没有任何图谱节点）时为 true，前端据此给出构建提示。 */
  notBuilt: boolean;
}

export interface KgCategorySummary {
  id: number;
  key: string;
  name: string;
  code: string;
  parentId: number | null;
  depth: number;
  /** 当前用户可见的档案数（不含受限未授权档案，避免存在性泄露）。 */
  archiveCount: number;
  /** 含子分类的可见档案数。 */
  subtreeArchiveCount: number;
  attachmentCount: number;
  chunkCount: number;
}

/** 关系列表（右栏「关联档案 / 关联知识块」与关系线详情共用）。 */
export interface KgRelationsResponse {
  node: KgGraphNodeView;
  total: number;
  page: number;
  pageSize: number;
  items: KgRelationItem[];
}

export interface KgRelationItem {
  edge: KgGraphEdgeView;
  node: KgGraphNodeView;
  /** 关联依据与证据（结构关系只给来源字段，内容关系给相似度与共有词项，确定性关系给等值字段）。 */
  evidence: KgEdgeEvidence;
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
  /** 证据摘录（长度受控，仅用于说明「为什么相似」，不是全文）。 */
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

/** 节点详情（按类型给出不同字段，均带「查看原文」所需的定位信息与真实授权结果）。 */
export type KgNodeDetailResponse =
  | KgCategoryDetail
  | KgArchiveDetailNode
  | KgFileDetailNode
  | KgChunkDetailNode;

interface KgDetailBase {
  node: KgGraphNodeView;
  /** 关联关系条数（可见范围内）。 */
  relationCount: number;
}

export interface KgCategoryDetail extends KgDetailBase {
  type: 'category';
  name: string;
  code: string;
  description: string;
  parentId: number | null;
  parentName: string | null;
  archiveCount: number;
  /** 该分类下当前用户可见的档案（数量受控）。 */
  archives: Array<{ key: string; id: number; title: string; archiveNo: string; status: string; fileCount: number }>;
}

export interface KgArchiveDetailNode extends KgDetailBase {
  type: 'archive';
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
  /** 附件列表（与档案详情同源字段，可查看即可列出）。 */
  files: Array<{ key: string; id: number; name: string; extension: string; fileSize: number; extractStatus: string; chunkCount: number }>;
  /** 关联档案（含关联原因，仅可见者）。 */
  relatedArchives: KgRelationItem[];
  /** 当前用户的真实授权结果（查看原文 / 下载入口据此显示，后端仍会二次校验）。 */
  permissions: { canView: boolean; canDownload: boolean };
}

export interface KgFileDetailNode extends KgDetailBase {
  type: 'file';
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
  /** 正文知识块列表（分页 + 真实定位信息）。 */
  chunks: Array<{ key: string; id: number; chunkNo: number; locator: string; pageNo: number | null; excerpt: string }>;
  permissions: { canView: boolean; canDownload: boolean };
}

export interface KgChunkDetailNode extends KgDetailBase {
  type: 'chunk';
  chunkNo: number;
  locator: string;
  pageNo: number | null;
  posFrom: number | null;
  posTo: number | null;
  /** 正文摘录（受控长度，权限等同档案查看）。 */
  excerpt: string;
  textLength: number;
  file: { key: string; id: number; name: string; extension: string };
  archive: { key: string; id: number; title: string; archiveNo: string; categoryName: string };
  relatedChunks: KgRelationItem[];
  permissions: { canView: boolean; canDownload: boolean };
}

/** 图谱搜索：命中项带节点定位信息，前端点击即可在画布中定位。 */
export interface KgSearchResponse {
  query: string;
  total: number;
  retrievalMode?: 'fts5' | 'like' | 'mixed';
  degraded: boolean;
  degradedReason?: string | null;
  groups: Record<KgNodeType, KgSearchHit[]>;
}

export interface KgSearchHit {
  /** 定位到画布所需的节点键；节点尚未入图时为 null（例如正文已重建但图谱未刷新）。 */
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
  /** 节点是否已在图谱中（false 时前端提示「需重建图谱后才能定位」）。 */
  inGraph: boolean;
}

/** Exact, permission-checked edge lookup; independent of paginated relation lists. */
export interface KgEdgeDetailResponse {
  edge: KgGraphEdgeView;
  from: KgGraphNodeView;
  to: KgGraphNodeView;
  evidence: KgEdgeEvidence;
  supportingNodes: KgGraphNodeView[];
}
