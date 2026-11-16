import type { KgEdgeDetailResponse } from './lib/knowledge-graph/types';
/** 与后端 common/roles.ts 对应的公共类型。 */
export type Role = 'admin' | 'cataloger' | 'reviewer' | 'borrower' | 'guest';
export type UserStatus = 'active' | 'disabled';

export const ROLE_LABELS: Record<Role, string> = {
  admin: '管理员',
  cataloger: '著录员',
  reviewer: '审核员',
  borrower: '借阅者',
  guest: '访客',
};

export const ALL_ROLES: Role[] = ['admin', 'cataloger', 'reviewer', 'borrower', 'guest'];

export interface UserView {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: Role;
  roleLabel: string;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SystemInfo {
  productName: string;
  stage: string;
  version: string;
  techStack: { frontend: string; backend: string; database: string };
  runtime: { node: string; database: string; apiPort: number; startedAt: string };
  currentUser: UserView;
  userOverview?: {
    total: number;
    byRole: Array<{ role: Role; roleLabel: string; count: number }>;
  };
}

// ==================== 档案核心业务（阶段二第二批，与后端 archives.service 视图对应） ====================

export interface CategoryView {
  id: number;
  name: string;
  code: string;
  description: string;
  parentId: number | null;
  parentName: string | null;
  pathCode: string;
  depth: number;
  archiveCount: number;
  createdAt: string;
  updatedAt: string;
}

export type ArchiveStatus = 'draft' | 'archived';

export const ARCHIVE_TYPE_OPTIONS = ['文书档案', '科技档案', '会计档案', '人事档案', '业务档案', '其他'];

export const ARCHIVE_STATUS_LABELS: Record<ArchiveStatus, string> = {
  draft: '草稿（可著录）',
  archived: '已归档（只读）',
};

export interface ArchiveFileView {
  id: number;
  originalName: string;
  extension: string;
  fileSize: number;
  contentType: string;
  uploadedByName: string;
  uploadedAt: string;
  /** 电子文件角色（一体化优化）。 */
  /** 该文件当前最新已入库版本号；无版本时为 null。 */
  /** 是否可进入在线编辑（doc/docx 且非只读角色且档案 draft，服务端判定）。 */
}

export interface ArchiveView {
  id: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  categoryPath: string;
  archiveType: string;
  keywords: string;
  formationDate: string | null;
  responsible: string;
  remarks: string;
  status: ArchiveStatus;
  statusLabel: string;
  accessLevel: 'public' | 'restricted';
  createdByName: string;
  createdByRoleLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArchiveFieldValueView {
  fieldKey: string;
  label: string;
  type: string;
  value: string;
}

/** 当前用户对该档案的附件操作授权（服务端真实判定，预览与下载同源）。 */
export interface ArchivePermissionsView {
  canDownload: boolean;
}

export interface ArchiveDetailView extends ArchiveView {
  files: ArchiveFileView[];
  dynamicFields: ArchiveFieldValueView[];
  permissions: ArchivePermissionsView;
}

export interface ArchiveListView {
  items: ArchiveView[];
  total: number;
  page: number;
  pageSize: number;
}

// ==================== 档案 Agent 助理（第一、二、三阶段，与后端 agent 模块视图对应） ====================

/** Agent 状态：前端据此如实标注模型服务是否已配置，不展示密钥/地址细节。 */
export interface AgentStatusView {
  aiConfigured: boolean;
  model: string | null;
  provider: string | null;
  providerLabel: string | null;
  personalAiConfigured: boolean;
  aiAvailable: boolean;
  archiveSearchReady: boolean;
  /** 附件正文索引是否可用（迁移与表结构就绪）。 */
  contentIndexReady: boolean;
  /** 是否走 SQLite FTS5；false 表示已降级为 LIKE 检索（如实上报，不伪装）。 */
  contentFts: boolean;
  capabilities: {
    conversationSearch: boolean;
    archiveDetailLink: boolean;
    attachmentContentQa: boolean;
    /** 第三阶段：智能借阅申请（需用户确认后提交）。 */
    borrowApply: boolean;
    /** 第三阶段：借阅进度查询（按现有角色权限隔离）。 */
    borrowProgress: boolean;
    /** 第三阶段：智能辅助著录（预览 + 确认后写入）。 */
    catalogAssist: boolean;
    /** 第一批：全系统统一智能检索（跨档案/附件/正文/分类联合查询）。 */
    unifiedSearch: boolean;
    ocr: boolean;
    /** AI 自动审批：永久 false，审批仍由审核员/管理员在现有页面完成。 */
    autoApproval: boolean;
    /** AI 自动归档：永久 false。 */
    autoArchive: boolean;
  };
}

export type AiProviderId = 'deepseek' | 'kimi' | 'qwen';

export interface AiProviderSettingsItem {
  provider: AiProviderId;
  label: string;
  description: string;
  configured: boolean;
  enabled: boolean;
  model: string;
  apiBase: string;
  temperature: number;
  updatedAt: string | null;
}

export interface PersonalAiSettingsView {
  enabled: boolean;
  activeProvider: AiProviderId | null;
  activeProviderLabel: string | null;
  providers: AiProviderSettingsItem[];
}

/** 档案结果卡片：目录级字段 + 服务端判定的可执行动作（详情入口始终指向既有路由）。 */
export interface AgentArchiveCard {
  id: number;
  title: string;
  archiveNo: string;
  categoryName: string;
  categoryPath: string;
  archiveType: string;
  status: string;
  statusLabel: string;
  formationDate: string | null;
  responsible: string;
  keywords: string;
  snippet: string;
  canOpenDetail: boolean;
  detailPath: string;
}

export type AgentReplyKind =
  | 'search'
  | 'archive_info'
  | 'help'
  /** 统一检索（第一批）：跨档案/附件/正文/分类的多业务联合查询 */
  | 'unified_search'
  /** 第一阶段遗留回复：仅可能出现在历史会话里 */
  | 'content_boundary'
  /** 基于真实正文证据的 AI 回答 */
  | 'content_answer'
  /** 模型不可用或引用不可核验时，直接展示检索到的原文片段 */
  | 'content_evidence'
  /** 未检索到可用依据（含附件未入索引、扫描件、无权访问） */
  | 'content_no_evidence'
  /** 第三阶段：需要先确定目标档案（候选清单或请用户补充档号/标题） */
  | 'target_ask'
  /** 第三阶段：借阅申请信息收集中（逐项询问缺少的真实必填字段） */
  | 'borrow_collect'
  /** 第三阶段：借阅申请待确认（展示完整申请内容 + 确认提交/取消申请） */
  | 'borrow_confirm'
  /** 第三阶段：借阅申请被拒绝（无权限/不可借阅/重复申请等真实原因） */
  | 'borrow_denied'
  /** 第三阶段：借阅进度/记录列表 */
  | 'borrow_progress'
  /** 第三阶段：智能辅助著录预览（可编辑，确认后才保存） */
  | 'catalog_preview'
  /** 第三阶段：业务工具执行结果（成功/失败均如实展示） */
  | 'action_result'
  /** 用户主动停止生成：保留本轮提问与停止说明，便于回看历史。 */
  | 'stopped'
  | 'unsupported'
  | 'unparsed'
  | 'error';

/** 借阅申请待确认视图：字段与现有借阅接口的真实入参一致（用途 + 期限）。 */
export interface AgentBorrowDraftView {
  /** 确认/取消只凭该 token，申请内容一律以服务端保存的草稿为准。 */
  token: string;
  status: 'pending' | 'executed' | 'cancelled' | 'failed';
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  purpose: string | null;
  days: number | null;
  applicantName: string;
  applicantRoleLabel: string;
  /** 仍缺少的字段（'purpose' / 'days'），非空时不得提交。 */
  missing: string[];
  createdAt: string;
}

/** 借阅记录视图：与现有借阅接口返回字段一致，状态名沿用现有业务状态集。 */
export interface AgentBorrowRecordView {
  id: number;
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  applicantName: string;
  purpose: string;
  days: number;
  status: string;
  statusLabel: string;
  createdAt: string;
  startAt: string | null;
  dueAt: string | null;
  reviewedAt: string | null;
  reviewerName: string | null;
  reviewNote: string;
  canReturn: boolean;
  canOpenDetail: boolean;
  detailPath: string;
}

/** 著录字段视图：AI 建议值 + 原文依据 + 现有原始值（三者严格区分）。 */
export interface AgentCatalogFieldView {
  key: string;
  label: string;
  type: string;
  /** true = 档案固定著录字段；false = 分类绑定模板的信息项。 */
  fixed: boolean;
  required: boolean;
  /** AI 建议值；未识别时为空串（不编造）。 */
  value: string;
  hasValue: boolean;
  evidenceRef: string | null;
  evidenceText: string;
  locator: string;
  /** 现有档案的真实著录值（新建档时为空串），便于用户对比 AI 建议。 */
  original: string;
}

export interface AgentCatalogDraftView {
  /** null = 没有可执行草稿（无著录权限 / 未提取到任何字段），此时只能查看不能保存。 */
  token: string | null;
  status: 'pending' | 'executed' | 'cancelled' | 'failed' | 'none';
  /** update = 编辑现有草稿档案；create = 新建档案（已归档档案绝不走 update）。 */
  mode: 'create' | 'update';
  archiveId: number | null;
  archiveTitle: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  fields: AgentCatalogFieldView[];
  /** 正文里识别到、但现有系统暂无对应字段的信息（只展示，不写入）。 */
  unmapped: Array<{
    label: string;
    value: string;
    evidenceRef: string | null;
    evidenceText: string;
    locator: string;
  }>;
  missingRequired: string[];
  notes: string[];
  canSave: boolean;
  saveBlockedReason: string | null;
  createdAt: string;
}

/** 业务工具执行结果视图（成功/失败都如实回显，带真实业务编号）。 */
export interface AgentActionResultView {
  tool: string;
  ok: boolean;
  message: string;
  /** 后续环节说明（如「等待审核员在借阅管理中审批」）。 */
  nextStep: string | null;
  borrow?: AgentBorrowRecordView | null;
  archive?: {
    id: number;
    title: string;
    archiveNo: string;
    statusLabel: string;
    detailPath: string;
  } | null;
  /** true = 命中防重复提交（本次未产生新数据）。 */
  replayed?: boolean;
}

/**
 * 答案来源：逐条对应真实检索到的正文片段及其附件、版本与位置，
 * 所有字段均来自后端真实数据，不允许由模型生成或补齐。
 */
export interface AgentSource {
  attachmentId?:number;
  attachmentName?:string;
  fileVersion?:string;
  unitId?:number;
  chunkId?:number;
  versionId?:number|null;
  pageNo?:number|null;
  posFrom?:number;
  posTo?:number;
  /** 答案中引用的编号，如 E1 */
  ref: string;
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  fileId: number;
  fileName: string;
  /** 文档版本号；null 表示尚无入库版本（即上传原件本身） */
  versionNo: number | null;
  /** 来源位置：DOCX 第 N 段 / PDF 第 N 页 第 M 行 / TXT 第 N 行 */
  locator: string;
  /** 实际被检索到的原文摘录 */
  excerpt: string;
  /** 跳转到现有档案详情的入口 */
  detailPath: string;
}

export interface AgentSearchConditions {
  keyword?: string;
  title?: string;
  archiveNo?: string;
  categoryName?: string;
  status?: string;
}

/** 统一检索生效范围（与后端 SEARCH_SCOPES 一致）。 */
export type SearchScope = 'archive' | 'attachment' | 'content' | 'category' | 'borrow' | 'audit' | 'template' | 'stats';

/** 附件检索卡片。 */
export interface AgentAttachmentCard {
  fileId: number;
  fileName: string;
  extension: string;
  fileSize: number;
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  versionNo: number | null;
  versionCount: number;
  uploadedByName: string;
  uploadedAt: string;
  canOpenDetail: boolean;
  detailPath: string;
}

/** 分类检索卡片。 */
export interface AgentCategoryCard {
  id: number;
  name: string;
  code: string;
  pathCode: string;
  depth: number;
  archiveCount: number;
}

export interface AgentUnifiedAuditCard {
  id: number;
  actorName: string | null;
  actorRoleLabel: string;
  actionLabel: string;
  objectTypeLabel: string;
  objectLabel: string | null;
  objectRef: string | null;
  result: 'success' | 'failure';
  resultLabel: string;
  summary: string;
  createdAt: string;
}

export interface AgentUnifiedTemplateCard {
  id: number;
  name: string;
  description: string;
  status: 'active' | 'disabled';
  statusLabel: string;
  fieldCount: number;
  fields: Array<{ fieldKey: string; label: string; type: string; required: boolean; active: boolean }>;
  boundCategories: Array<{ id: number; name: string; code: string }>;
}

export interface AgentUnifiedStatsView {
  rangeLabel: string;
  archiveScopeLabel: string;
  borrowScopeLabel: string;
  note: string;
  metrics: Array<{ key: string; label: string; unit: string; total: number | null; period: number | null; available: boolean; hint: string }>;
  statuses: Array<{ key: string; label: string; count: number }>;
  categories: Array<{ label: string; count: number; ratio: number }>;
  borrow: { available: boolean; reason: string | null; total: number; pending: number; periodTotal: number; scopeLabel: string };
  utilization: { available: boolean; reason: string | null; previewTotal: number; downloadTotal: number };
}

/** 统一检索分组结果（后端返回，仅 kind=unified_search 时出现）。 */
export interface AgentUnifiedGroups {
  scopes: SearchScope[];
  archives: { total: number; shown: number; items: AgentArchiveCard[] };
  attachments: { total: number; shown: number; items: AgentAttachmentCard[] };
  contents: { total: number; shown: number; items: AgentSource[] };
  categories: { total: number; shown: number; items: AgentCategoryCard[] };
  borrowings: { total: number; shown: number; scope: 'mine' | 'review' | null; items: AgentBorrowRecordView[] };
  audits: { total: number; shown: number; items: AgentUnifiedAuditCard[] };
  templates: { total: number; shown: number; items: AgentUnifiedTemplateCard[] };
  statistics: AgentUnifiedStatsView | null;
  restrictedScopes: Array<{ scope: SearchScope; label: string; reason: string }>;
  degraded: boolean;
}

export interface AgentTraceStep {
  id:string;label:string;status:'waiting'|'running'|'completed'|'empty'|'failed'|'skipped';hitCount:number;durationMs:number;note?:string;
}
export interface AgentSourceHit {
  archiveId:number;fileId:number;chunkId:number;unitId:number;versionId?:number|null;versionNo:number|null;
  pageNo?:number|null;posFrom?:number;posTo?:number;locator:string;text:string;
}
export interface AgentGraphCitation extends Partial<KgEdgeDetailResponse> {
  ref: string;
  edgeId: number;
  fromArchiveId: number | null;
  fromTitle: string;
  fromArchiveNo: string;
  toArchiveId: number | null;
  toTitle: string;
  toArchiveNo: string;
  relationLabel: string;
  basisLabel: string;
  factGrade: 'deterministic_clue' | 'similarity_clue';
  explanation: string;
  caveat: string | null;
  supportCount?: number;
}

export interface AgentPayload {
  retrievalPlan?: { originalQuestion: string; taskGoal: string; responseMode: string; contentScope: string; searchSources: string[] };
  plannerCall?: { attempted: boolean; status: 'success' | 'failed' | 'unavailable' | 'fast_path'; provider: string; model: string | null; failure?: string };
  retrievalRounds?: number;
  inventory?: { total: number; statuses: Record<string, number>; categories: Array<{ name: string; count: number }> };
  pagination?: { page: number; pageSize: number; totalPages: number; hasMore: boolean };
  retrievedAttachments?: AgentAttachmentCard[];
  trace?:AgentTraceStep[];
  modelCall?: { provider: string; model: string | null; attempted: boolean; status: 'not_attempted' | 'unavailable' | 'success' | 'failed'; reason: string; evidenceCount: number; modelEvidenceCount: number };
  answerGeneration?: {status:'success'|'failed'|'unavailable';failure?:string;generation:'not_started'|'generated'|'failed';modelResponse:'not_attempted'|'received'|'failed';citations:'not_checked'|'passed'|'failed';calls:number;retries:number;sections:number;evidenceCount:number;processedEvidenceCount?:number;validationIssues?:Array<{rule:string;claimIndex:number;ref?:string;missingNumbers?:string[];sourceSnippet?:string;claimSnippet?:string}>};
  usedContext?: boolean;
  evidenceSelection?: {strategy:'relevant'|'whole_attachment';before:number;after:number;excluded:Array<{chunkId:number;fileId:number;reason:string}>};
  claims?:Array<{text:string;citations:string[];evidenceQuote:string}>;
  metadataSources?:Array<{ref:string;kind:string;label:string;excerpt:string;archiveId?:number;fileId?:number}>;
  kind: AgentReplyKind;
  intent: string;
  conditions: AgentSearchConditions;
  matched: boolean;
  total: number;
  shown: number;
  items: AgentArchiveCard[];
  aiUsed: boolean;
  aiNote: string | null;
  reason: string | null;
  /** 经核验、实际支撑回答的正文来源（与回复中的 [E1] 引用一一对应）。 */
  sources?: AgentSource[];
  /** 检索到但未作为正式引用的参考资料；不得冒充 sources。 */
  retrievedEvidence?: AgentSource[];
  /** 必要、简洁的用户可读限制说明。 */
  limitations?: string[];
  /** 本次回答实际使用的、经服务端重新核验的图谱关系。 */
  graphCitations?: AgentGraphCitation[];
  /** 正文处理状态的说明（哪些附件没能提供正文及真实原因）。只含业务语言，可直接展示。 */
  contentNotes?: string[];
  /** 检索链路的内部诊断（工具名、判定结果、安全校验等）；仅留存，不向用户展示。 */
  diagnostics?: string[];
  /** 绑定范围内档案确实没有附件：正文已给出确定结论，不再补「未检索到正文依据」类提示。 */
  emptyScope?: boolean;
  /** 第三阶段：需用户先选定目标档案时的业务入口类型。 */
  targetAsk?: 'borrow' | 'catalog' | null;
  /** 第三阶段：借阅申请待确认草稿（确认只凭 token，内容由服务端保存）。 */
  borrowDraft?: AgentBorrowDraftView | null;
  /** 第三阶段：借阅进度/记录列表。 */
  borrowRecords?: AgentBorrowRecordView[] | null;
  /** 第三阶段：本次借阅记录的数据范围（mine=本人，review=审核视角，由服务端权限裁决）。 */
  borrowScope?: 'mine' | 'review' | null;
  /** 第三阶段：辅助著录预览草稿。 */
  catalogDraft?: AgentCatalogDraftView | null;
  /** 第三阶段：业务工具执行结果。 */
  action?: AgentActionResultView | null;
  /** 第三阶段：需如实告知但不阻断流程的提示。 */
  notices?: string[];
  /** 全系统统一检索：档案/附件/正文/分类/借阅/审计/模板/统计分组结果。 */
  unified?: AgentUnifiedGroups | null;
  /** 无法直接作答时服务端默认给出的 3 条可点击提示语；正常回答不返回。 */
  suggestions?: string[];
}

/** POST /api/agent/action 的返回：确认/取消后由后端回传新的助手消息。 */
export interface AgentActionResultPayload {
  conversation: AgentConversationView;
  reply: AgentMessageView;
}

export interface AgentMessageView {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  payload: AgentPayload | null;
  createdAt: string;
}

export interface AgentConversationView {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/**
 * 第三阶段：知识图谱页面传给 Agent 的节点 / 关系上下文。
 * 这里的 ID 只作为「当前选中了什么」的上下文提示：后端会按当前用户
 * 重新查询并验证节点（或关系两端）的真实性与访问权限，验证失败直接拒绝，
 * 绝不把客户端传来的 ID 当作已授权范围。
 */
export type AgentGraphContext =
  | { graphNode: { nodeType: 'archive' | 'file' | 'chunk'; refId: number } }
  | { graphEdge: { edgeId: number; fromArchiveId: number; toArchiveId: number } };

export interface AgentAskResult {
  conversation: AgentConversationView;
  userMessage: AgentMessageView;
  reply: AgentMessageView;
  conversationId: number;
  replayed: boolean;
  cancelled?: boolean;
}

/** POST /api/agent/regenerate 的返回：原地替换后的最后一条回复。 */
export interface AgentRegenerateResult {
  conversation: AgentConversationView;
  reply: AgentMessageView;
}

// ==================== 附件正文索引（第二阶段：全文检索与内容问答） ====================

/**
 * 单文件正文提取状态（与后端 FileContentStatus 对应）。
 * 后端只返回状态与真实原因，不返回正文本身；pending 表示尚未入索引。
 */
export type ContentExtractStatus =
  | 'indexed'
  | 'no_text'
  | 'unsupported'
  | 'corrupt'
  | 'encrypted'
  | 'scanned'
  | 'failed'
  | 'pending'
  | 'processing';

export interface FileContentStatus {
  jobStatus?:string;
  embeddingStatus?:string;
  attempts?:number;
  fileId: number;
  fileName: string;
  extension: string;
  versionNo: number | null;
  status: ContentExtractStatus;
  message: string;
  extractor: string;
  charCount: number;
  chunkCount: number;
  truncated: boolean;
  indexedAt: string | null;
}

export interface ArchiveContentStatus {
  archiveId: number;
  /** 本次实际新建/重建的索引单元数 */
  synced: number;
  files: FileContentStatus[];
}

/** 提取状态中文标签（与后端 EMPTY_RESULT_LABEL 口径一致，不得美化）。 */
export const CONTENT_STATUS_LABELS: Record<ContentExtractStatus, string> = {
  indexed: '已入索引',
  no_text: '无文本内容',
  unsupported: '格式不支持',
  corrupt: '文件损坏',
  encrypted: '已加密',
  scanned: '扫描件（未启用 OCR）',
  failed: '提取失败',
  pending: '等待提取',
  processing: '正在提取',
};

// ==================== 在线编辑与文档版本（阶段二第三批） ====================

export type DocumentEditState = 'linked' | 'editing' | 'saved' | 'unsupported';

export interface ArchiveDocumentView {
  id: number;
  archiveId: number;
  docId: string;
  docName: string;
  editState: DocumentEditState;
  canEdit: boolean;
  creatorName: string;
  createdAt: string;
  lastSavedAt: string | null;
  /** 附件正文导入远端文档的时间；null 表示从未导入过，可自动载入。 */
  seededAt: string | null;
  /** 该关联对应的源电子文件（同档案可分别对多个 DOC/DOCX 建立关联）。 */
  sourceFileId: number | null;
  sourceFileName: string | null;
  sourceExtension: string | null;
}

export interface ArchiveFileVersionView {
  id: number;
  versionNo: number;
  sha256: string;
  fileSize: number;
  origin: string;
  originLabel: string;
  createdByName: string;
  createdAt: string;
}

export interface JitWordStatus {
  available: boolean;
  source: string | null;
  apiBase: string;
  editorUrl: string;
  loaderUrl: string;
  /** 文件预览 SDK 地址（纯前端，默认厂商 CDN，可用环境变量切换自托管）。 */
  previewSdkUrl?: string;
  tenantKey: string;
  providerKey: string;
  /** 本次请求解析出的票据来源；不在允许范围内时为 null。 */
  origin: string | null;
  /** 是否支持保存后自动入库（厂商开放导出字节回传后为 true）。 */
  autoExportAvailable?: boolean;
  /** 可进入在线编辑的源附件格式（后端权威口径，缺省兼容为 doc/docx）。 */
  editableExtensions?: string[];
}

// ==================== 元数据模板与借阅（阶段二第四批） ====================

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'select' | 'bool' | 'tags';
export const FIELD_TYPE_OPTIONS: Array<{
  value: FieldType;
  label: string;
  /** 面向普通用户的一句话说明（仅前端展示，不影响后端 type 取值）。 */
  hint: string;
  /** 预览用的示例值（为空表示不显示占位示例）。 */
  example: string;
}> = [
  { value: 'text', label: '单行文字', hint: '一行文字，如题名、文号', example: '2026年度工作总结' },
  { value: 'textarea', label: '多行文字', hint: '较长内容，可以换行', example: '记录该档案的主要内容' },
  { value: 'number', label: '数字', hint: '只填数值，如页数、份数', example: '12' },
  { value: 'date', label: '日期', hint: '按年月日选择', example: '' },
  { value: 'select', label: '下拉单选', hint: '从设定好的选项里选一个', example: '' },
  { value: 'bool', label: '是 / 否', hint: '二选一', example: '' },
  { value: 'tags', label: '多选标签', hint: '从设定好的选项里选多个', example: '' },
];

export interface TemplateFieldView {
  id: number;
  fieldKey: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[];
  validation: Record<string, unknown>;
  sortNo: number;
  active: boolean;
  referenced: boolean;
}

export interface MetadataTemplateView {
  id: number;
  name: string;
  description: string;
  status: 'active' | 'disabled';
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 模板已绑定的分类（与后端 BoundCategoryView 对应，随模板详情内联返回）。 */
export interface BoundCategoryView {
  id: number;
  name: string;
  code: string;
}

export interface MetadataTemplateDetailView extends MetadataTemplateView {
  fields: TemplateFieldView[];
  boundCategories: BoundCategoryView[];
}

export interface CategoryTemplateFields {
  template: MetadataTemplateView | null;
  fields: TemplateFieldView[];
}

export type BorrowStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'expired'
  | 'cancelled';

export interface BorrowRequestView {
  id: number;
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  applicantId: number;
  applicantName: string;
  purpose: string;
  days: number;
  startAt: string | null;
  dueAt: string | null;
  status: BorrowStatus;
  statusLabel: string;
  reviewNote: string;
  reviewerName: string | null;
  reviewedAt: string | null;
  createdAt: string;
  canReturn: boolean;
}

export interface BorrowCatalogItem {
  id: number;
  title: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  archiveType: string;
  accessLevel: 'public' | 'restricted';
}

// ==================== 操作审计（阶段二第五批，与后端 audit 模块视图对应） ====================

/** 审计记录原始字段（追溯用，与后端 audit_logs 一致，不做任何改写）。 */
export interface AuditLogView {
  id: number;
  actorUserId: number | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  result: 'success' | 'failure';
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** 业务化描述片段：时间片段由浏览器按本地时区渲染。 */
export type AuditSummaryPart = { kind: 'text'; text: string } | { kind: 'time'; iso: string };

/** 列表行：原始字段 + 后端生成的中文展示字段。 */
export interface AuditLogItemView extends AuditLogView {
  actionLabel: string;
  objectTypeLabel: string;
  /** 真实业务名称；为 null 表示原对象已不存在（不伪造）。 */
  objectLabel: string | null;
  objectRef: string | null;
  objectResolved: boolean;
  summary: AuditSummaryPart[];
}

export interface AuditPage {
  items: AuditLogItemView[];
  total: number;
  page: number;
  pageSize: number;
}

// ==================== 工作台数据大盘（与后端 dashboard 模块视图对应） ====================

export type DashboardRangeKey = '7d' | '30d' | '90d';

export interface DashboardRangeView {
  key: DashboardRangeKey;
  days: number;
  label: string;
  /** 统计起始自然日（含），YYYY-MM-DD。 */
  fromDay: string;
  /** 统计截止自然日（含），YYYY-MM-DD。 */
  toDay: string;
}

export interface DashboardScopeView {
  role: Role;
  roleLabel: string;
  archiveScope: 'system' | 'visible';
  archiveScopeLabel: string;
  borrowScope: 'all' | 'own' | 'none';
  borrowScopeLabel: string;
  note: string;
}

export interface DashboardMetricView {
  key: 'archives' | 'archived' | 'draft' | 'borrowPending';
  label: string;
  unit: string;
  /** 累计量（借阅指标为当前待审核量）；null 表示当前角色无此口径。 */
  total: number | null;
  totalLabel: string;
  /** 统计范围内的新增量；null 表示当前角色无此口径。 */
  period: number | null;
  periodLabel: string;
  available: boolean;
  hint: string;
}

export interface DashboardTrendPointView {
  day: string;
  count: number;
}

export interface DashboardBreakdownItemView {
  key: string;
  label: string;
  count: number;
  /** 占比（0-1）。 */
  ratio: number;
}

export interface DashboardCategoryItemView {
  id: number | null;
  name: string;
  count: number;
  ratio: number;
}

export interface DashboardTodoView {
  key: string;
  label: string;
  count: number;
  hint: string;
  to: string;
}

export interface DashboardStatsView {
  generatedAt: string;
  range: DashboardRangeView;
  scope: DashboardScopeView;
  metrics: DashboardMetricView[];
  archiveTrend: { points: DashboardTrendPointView[]; periodTotal: number; hint: string };
  categories: { total: number; items: DashboardCategoryItemView[]; truncated: boolean };
  statuses: { total: number; items: DashboardBreakdownItemView[] };
  borrow: {
    available: boolean;
    reason: string;
    scopeLabel: string;
    total: number;
    pending: number;
    periodTotal: number;
    items: DashboardBreakdownItemView[];
    trend: DashboardTrendPointView[];
  };
  utilization: {
    available: boolean;
    reason: string;
    sourceLabel: string;
    totals: { preview: number; download: number; borrow: number };
    series: Array<{ day: string; preview: number; download: number; borrow: number }>;
  };
  todos: DashboardTodoView[];
}
