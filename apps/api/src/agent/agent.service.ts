import { KnowledgeSearchService } from '../knowledge/knowledge-search.service';
import { graphCitation, type AgentGraphCitation } from './graph.evidence';
export type { AgentGraphCitation } from './graph.evidence';
import { withExecutionBudget, budgetedModel, executionBudget } from './execution.budget';
import { withAgentCancellation, throwIfAgentCancelled, isAgentCancelled } from './agent.cancellation';
import { generateGroundedAnswer, answerFailureMessage, AnswerGeneration } from './answer.generation';
import {withAgentTrace,understood,recordStep,finishAgentTrace,AgentTraceStep} from './agent.trace';
import { emptyRetrievalPlan, generateRetrievalPlan, RetrievalPlan, RetrievalPlanValidationError } from './retrieval.plan';
import { AgentRetrievalService } from './retrieval.service';
import { isUserReadableNote, noEvidenceAnswer, sanitizeHistoricalContent, userReadableNotes } from './user.message';
/**
 * 档案 Agent 助理服务
 * （第一阶段：对话式查档；第二阶段：附件全文检索与 AI 内容问答；第三阶段：智能档案业务办理）。
 *
 * 职责链路：
 *  目录检索：用户提问 → 模型结构化检索计划（明确实体快速处理）→ 严格校验
 *            → 复用 ArchivesService.searchArchives 真实检索（含分页/可见性过滤）
 *            → 后端权限判定（ArchiveAccessService，不信任模型与前端）→ 结果卡片 + 对话持久化。
 *  内容问答：用户提问 → 定位取证范围（档号/标题/上一轮检索结果）→ 按当前用户权限检索附件正文片段
 *            → 只把命中的相关片段交给模型 → 校验答案引用编号必须真实存在于证据集 → 返回答案与来源。
 *  业务办理（第三阶段）：
 *            借阅申请：定位真实档案（绝不按名称猜 ID）→ 借阅资格检查（复用现有规则）
 *                      → 多轮逐项收集真实必填字段 → 服务端落库待确认草稿 → 用户确认 → 调现有借阅接口；
 *            借阅进度：复用现有借阅记录接口，数据范围由服务端按现有角色权限裁决；
 *            辅助著录：读当前用户有权访问的已索引正文 → 按真实字段清单规则抽取（带原文依据）
 *                      → 预览（区分原始值与 AI 建议值）→ 用户确认 → 调现有创建/编辑接口。
 *
 * 安全底线：
 * - 模型输出只作为「检索条件 / 办理意向」，一律经 sanitizeIntent 校验（长度、取值集合、分类真实存在）；
 * - 绝不采信模型给出的 userId / 角色 / 权限结论，身份一律取服务端已校验会话；
 * - 无权访问的档案不会进入正文检索（复用既有可见性 SQL + 服务层逐档复核），因此不会交给模型也不会出现在答案来源中；
 * - 证据不足时如实回答「未找到依据」，模型给出的引用编号对不上即剔除，绝不伪造来源；
 * - 模型未配置或异常时降级为「直接展示检索到的原文片段」并如实标注，绝不伪造 AI 归纳结论；
 * - 有副作用的操作（借阅申请 / 著录保存）只能由「服务端保存的待确认草稿 + 用户明确确认」触发：
 *   档案 ID、分类 ID、申请人身份均来自草稿行（服务端生成），前端与大模型都无法指定；
 *   草稿内容经条件更新 claim() 抢占后才执行，重复点击不会重复提交；
 * - 审批 / 归档 / 删除等高风险操作一律不代为执行（既有边界保持不变）；
 * - 业务接口失败时如实告知失败，绝不谎报成功。
 */
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentIndexService } from '../archives/content/content-index.service';
import { UserRepository } from '../users/user.repository';
import {
  AgentRepository,
  AgentConversationRow,
  AgentMessageRow,
} from './agent.repositories';
import { AI_MODEL_CLIENT, AiModelClient, AiModelError, ChatMessage } from './ai-model.client';
import { PersonalAiSettingsService } from './ai-settings.service';
import {
  buildConversationTitle,
  extractJsonObject,
  parseDeterministic,
  safeDeterministicLookup,
  sanitizeIntent,
  structureRetrievalIntent,
  CANCEL_TEXT_RE,
  CONFIRM_TEXT_RE,
  extractBorrowDays,
  extractBorrowPurpose,
  normalizeFollowUpQuestion,
  normalizeAgentQuestion,
  isReanswerRequest,
  CategoryHint,
  ParsedIntent,
  SearchScope,
} from './intent.parser';
import { MAX_KEYWORD_LENGTH, MAX_QUESTION_LENGTH } from './intent.parser';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { ArchivesService, ArchiveView } from '../archives/archives.service';
import { CategoryRepository } from '../archives/archive.repositories';
import type { BorrowCatalogItem } from '../archives/archive.repositories';
import {
  FileSearchRow,
  UnifiedSearchResult,
} from '../search/unified-search.types';
import {
  EvidenceRow,
} from '../archives/content/content-index.repositories';
import { BorrowRequestView } from '../borrowing/borrowing.service';
import {
  ROLE_ADMIN,
  UserView,
  roleLabel,
} from '../common/roles';
import { hasPermission } from '../common/permissions';
import { AgentContextService, AgentContextSnapshot, CONTEXT_LIMITS, parseReference } from './agent.context';
import { answerArchives, answerAttachments, answerUnified } from './agent.answer';
import { AgentToolDispatcher } from './tool.dispatcher';
import { AgentToolResult, AgentToolExecution } from './tool.types';
import { SqliteTransaction } from '../db/transaction';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION, AUDIT_OBJECT } from '../audit/audit.types';
import {
  EvidenceItem,
  INSUFFICIENT_ANSWER,
  buildEvidence,
  selectEvidence,
  EvidenceSelection,
  buildSummaryEvidence,
  isComparisonQuestion,
  isSummaryQuestion,
  renderEvidenceFallback,
  EVIDENCE_FALLBACK_ANSWER,
  GroundedClaim,
} from './content.evidence';
import {
  AGENT_PENDING_TOOL,
  AgentPendingActionRepository,
  AgentPendingActionRow,
} from './agent.pending';
import {
  AGENT_TOOL,
  AgentToolService,
  BorrowEligibility,
  describeToolError,
} from './agent.tools';
import { ExtractedValue, ExtractSource, extractCatalogFields } from './catalog.extract';
import { UnifiedBusinessSearchResult } from './unified-business-search.service';
import { GraphQueryService } from '../graph/graph.query.service';

/** 会话列表上限（V1 单用户会话量有限，超出后按最近更新截取）。 */
const CONVERSATION_LIST_LIMIT = 100;
/** 历史消息加载上限：长会话只回传最近若干条，避免无界增长。 */
const MESSAGE_HISTORY_LIMIT = 200;
/** 单次回复展示的档案卡片数量（检索仍按真实分页统计，仅展示前若干条）。 */
const RESULT_CARD_LIMIT = 8;
/** 幂等键长度上限。 */
const MAX_CLIENT_REQUEST_ID_LENGTH = 64;
/** 正文问答：每附件最多保留的来源条数。 */

// ---------- 对外视图 ----------

export interface AgentSearchConditions {
  keyword?: string;
  title?: string;
  archiveNo?: string;
  categoryName?: string;
  status?: string;
}

/** 档案结果卡片：只含目录级字段 + 服务端判定的可执行动作（详情入口始终指向既有路由）。 */
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
  /** 摘要：既有检索可命中的著录信息拼接（不含附件正文）。 */
  snippet: string;
  canOpenDetail: boolean;
  detailPath: string;
}

export type AgentReplyKind =
  | 'search'
  | 'archive_info'
  | 'help'
  /** 统一检索：跨档案/附件/正文/分类的多业务联合查询（按分组展示） */
  | 'unified_search'
  /** 第一阶段遗留的「正文问答未开放」回复；仅可能出现在历史会话消息里，第二阶段不再产生 */
  | 'content_boundary'
  /** 基于真实正文证据的 AI 回答 */
  | 'content_answer'
  /** 模型不可用/引用不可核验时，直接展示检索到的原文片段 */
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

/**
 * 答案来源：逐条对应「真实检索到的正文片段」及其所在附件、版本与位置。
 * 任何一个字段均来自数据库行与磁盘文件，不允许由模型生成或补齐。
 */
export interface AgentSource {
  categoryName?: string;
  archiveStatus?: string;
  hitType?: string;
  searchSource?: string;
  relevance?: { score: number; algorithm: string };
  chunkId?: number;
  versionId?:number|null;
  pageNo?: number | null;
  posFrom?: number;
  posTo?: number;
  attachmentId?: number;
  attachmentName?: string;
  fileVersion?: string;
  score?: number;
  unitId?: number;
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
  /** 跳转到现有档案详情入口 */
  detailPath: string;
}

/** 附件检索卡片：附件本体 + 所属档案定位（详情入口按服务端权限判定）。 */
export interface AgentAttachmentCard {
  fileId: number;
  fileName: string;
  extension: string;
  fileSize: number;
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  /** 当前最新已入库版本号；null 表示尚无版本（即原件本身）。 */
  versionNo: number | null;
  versionCount: number;
  uploadedByName: string;
  uploadedAt: string;
  canOpenDetail: boolean;
  detailPath: string;
}

/** 分类检索卡片：名称/编码/层级/按可见性统计的档案数量均为真实数据。 */
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

/** 统一检索分组结果（只包含本次生效范围对应的分组）。 */
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
  /** 正文检索是否已降级为 LIKE（FTS5 不可用时如实标注，不伪装 BM25 排序）。 */
  degraded: boolean;
}


export interface AgentPayload {
  retrievedAttachments?: AgentAttachmentCard[];
  retrievalPlan?: RetrievalPlan;
  attachmentInventory?: {archives:number;attachments:number;parsed:number;indexed:number;complete:boolean};
  plannerCall?: { attempted: boolean; status: 'success' | 'failed' | 'unavailable' | 'fast_path'; provider: string; model: string | null; failure?: string };
  retrievalRounds?: number;
  inventory?: { total: number; statuses: Record<string, number>; categories: Array<{ name: string; count: number }> };
  pagination?: { page: number; pageSize: number; totalPages: number; hasMore: boolean };
  evidenceCount?: number;
  modelCall?: { provider: string; model: string | null; attempted: boolean; status: 'not_attempted' | 'unavailable' | 'success' | 'failed'; reason: string; evidenceCount: number; modelEvidenceCount: number };
  answerGeneration?: AnswerGeneration;
  evidenceSelection?: EvidenceSelection;
  usedContext?: boolean;
  trace?: AgentTraceStep[];
  claims?: GroundedClaim[];
  metadataSources?: Array<{ref:string;kind:'archive'|'attachment'|'category'|'business';archiveId?:number;fileId?:number;label:string;excerpt:string}>;
  /** Internal persisted state; stripped from API views. IDs never convey permissions. */
  context?: AgentContextSnapshot;
  contextSelection?: { archives: number[]; files: number[]; focus: 'archive' | 'attachment' | null };
  /** Additive diagnostics; legacy card and conversation fields remain unchanged. */
  toolResults?: AgentToolResult[];
  toolExecutionStatus?: AgentToolExecution['status'];
  kind: AgentReplyKind;
  /** 本次实际生效的意图（search / archive_info / …）。 */
  intent: string;
  conditions: AgentSearchConditions;
  matched: boolean;
  total: number;
  shown: number;
  items: AgentArchiveCard[];
  /** 本轮回复是否由大模型完成意图理解。 */
  aiUsed: boolean;
  /** 模型不可用/异常时的诚实标注（不影响基础检索）。 */
  aiNote: string | null;
  /** 无法处理时的原因说明。 */
  reason: string | null;
  /** 经核验、实际支撑回答的正文来源（与回复中的 [E1] 引用一一对应）。 */
  sources?: AgentSource[];
  /** 未作为正式引用的辅助证据，仅供服务端内部核查，不在普通对话中展示。 */
  retrievedEvidence?: AgentSource[];
  /** 覆盖范围与处理边界的内部说明；普通对话不展示检索过程和处理状态。 */
  limitations?: string[];
  /** 本次回答实际使用的、经服务端重新核验的图谱关系；不与正文来源或回答文本混合。 */
  graphCitations?: AgentGraphCitation[];
  /** 附件正文可用性说明，供服务端诊断；不进入普通用户回答界面。 */
  contentNotes?: string[];
  /** 绑定范围内档案确实没有附件：正文已给出确定结论，前端不再补「未检索到正文依据」一类提示。 */
  emptyScope?: boolean;
  /** 检索链路的内部诊断（工具名/判定枚举/安全校验）；只保存不展示。 */
  diagnostics?: string[];
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
  /** 统一检索（第一批）：跨档案/附件/正文/分类的分组结果（仅 kind=unified_search 时出现）。 */
  unified?: AgentUnifiedGroups | null;
  /**
   * 本轮无法直接作答（超出能力边界 / 未理解 / 查无结果 / 需要补充信息）时，
   * 服务端默认给出的 3 条可点击提示语；正常回答不返回，避免干扰。
   */
  suggestions?: string[];
}

/** 借阅申请待确认视图：字段与现有借阅接口的真实入参一致（用途 + 期限）。 */
export interface AgentBorrowDraftView {
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

export interface AgentAskResult {
  conversation: AgentConversationView;
  userMessage: AgentMessageView;
  reply: AgentMessageView;
  /** true 表示命中幂等（同一 clientRequestId 重复提交，返回既有回复，未产生新数据）。 */
  replayed: boolean;
  /** true 表示本轮由用户主动停止；已落库为「提问 + 已停止生成」两条消息。 */
  cancelled?: boolean;
}

// ---------- 固定话术（第一阶段能力边界，均为服务端常量，不经模型生成） ----------

const HELP_ANSWER =
  '想让检索更准确，可以这样问我：\n' +
  '1. 直接给出题名关键词，例如「查找采购验收档案」；\n' +
  '2. 给出完整档号，例如「档号 WS-2026-000007」；\n' +
  '3. 指明档案分类，例如「合同管理类有哪些档案」；\n' +
  '4. 指明状态，例如「已归档的合同档案」；\n' +
  '5. 关键词越具体、修饰词越少，命中越准确。';

const UNSUPPORTED_ANSWER =
  '抱歉，这个问题超出我当前已实现的能力。我可以在权限范围内检索档案、附件正文、分类、借阅记录、操作审计、元数据模板和统计信息，' +
  '也可以回答有正文证据支持的问题；不会代为执行审批、归档、删除等高风险操作。';

const UNPARSED_ANSWER =
  '抱歉，我暂时没能理解这个问题，也不会猜测结果骗你。\n' +
  '你可以让我检索档案、附件、正文、分类、本人借阅记录，或在授权范围内查询审计、元数据模板和统计信息。' +
  '例如「查找采购合同的档案和附件」「查询最近7天的操作审计」「查询最近30天的档案统计」。';

const NO_RESULT_HINT = '可以试试更换关键词、减少修饰词，或改用档号、档案分类再检索一次。';

/**
 * 无法直接作答时的默认提示语：固定为 3 条，全部是当前 Agent 真正能执行的档案域问题。
 * 由服务端生成、不依赖模型，模型不可用时也能稳定给出可点击入口。
 */
const UNABLE_ANSWER_SUGGESTIONS: readonly string[] = [
  '帮我查找采购验收相关的档案',
  '查询我最近的借阅记录',
  '如何更准确地查找档案？',
];

/**
 * 只在「答不了 / 查无结果 / 需要用户补充信息」时给出提示语。
 * 正常检索、业务卡片、正文回答都不附带，避免把引导语变成噪音。
 */
function unableAnswerSuggestions(payload: AgentPayload): string[] {
  const noResult = (payload.kind === 'search' || payload.kind === 'archive_info')
    && !payload.matched && payload.total === 0;
  // 业务办理的候选档案选择（targetAsk 非空）已有卡片按钮，不再叠加通用提示语。
  const needsClarification = payload.kind === 'target_ask' && !payload.targetAsk;
  const cannotAnswer = payload.kind === 'unsupported'
    || payload.kind === 'unparsed'
    || payload.kind === 'content_no_evidence';
  return noResult || needsClarification || cannotAnswer ? [...UNABLE_ANSWER_SUGGESTIONS] : [];
}

/** 现有借阅接口的真实必填字段上限（与 BorrowingService.createRequest 一致）。 */
const MAX_BORROW_PURPOSE_LENGTH = 500;
const MAX_BORROW_DAYS = 90;
/** 借阅申请后续环节说明（与现有借阅业务一致：需人工审核，AI 不审批）。 */
const BORROW_NEXT_STEP = '申请已提交至借阅审核环节，需等待审核员在「借阅管理」中审批（AI 不会代为审批）。';

/** 服务端保存的借阅草稿内容（确认执行时以它为准，不接受模型/前端传回）。 */
interface BorrowDraftPayload {
  archiveId: number;
  archiveTitle: string;
  archiveNo: string;
  purpose: string;
  days: number | null;
  applicantName: string;
  applicantRoleLabel: string;
  createdAt: string;
}

/** 服务端保存的辅助著录草稿内容。 */
interface CatalogDraftPayload {
  mode: 'create' | 'update';
  archiveId: number | null;
  archiveTitle: string;
  archiveNo: string;
  categoryId: number;
  categoryName: string;
  fields: AgentCatalogFieldView[];
  unmapped: AgentCatalogDraftView['unmapped'];
  notes: string[];
  createdAt: string;
}

/** 模型意图抽取的系统提示模板（分类清单由服务端注入，模型不得接触身份与权限信息）。 */
function buildSystemPrompt(categories: CategoryHint[]): string {
  const list = categories.length
    ? categories.map((c) => `${c.name}（编码 ${c.code}）`).join('、')
    : '（当前系统尚未建立任何分类）';
  return (
    '你是档案管理系统里的检索条件解析器。你的唯一任务是把用户的一句中文提问改写成结构化检索条件，' +
    '只输出一个 JSON 对象，不要输出解释、不要输出 Markdown 代码块。\n' +
    `JSON 字段与约束：\n` +
    `- kind: "search" | "archive_info" | "help" | "content_question" | "unified_search" | "unsupported" | "unparsed"\n` +
    `- title: 用户想按档案标题检索时的标题关键词（字符串，不超过 ${MAX_KEYWORD_LENGTH} 字，没有则省略）\n` +
    `- archiveNo: 用户给出的档号（没有则省略）\n` +
    `- keyword: 主题关键词（没有则省略）\n` +
    `- categoryName: 档案分类名，必须严格来自下面这份真实存在的清单：${list}\n` +
    `- status: "draft"（草稿/未归档）或 "archived"（已归档），没有则省略\n` +
    `- scopes: 仅 unified_search 使用，数组，元素只能取 "archive"|"attachment"|"content"|"category"|"borrow"|"audit"|"template"|"stats"，代表用户想检索的业务范围\n` +
    `- extension: 仅 unified_search 使用的附件格式（小写不带点，如 docx/pdf/txt，没有则省略）\n` +
    `- timeRange: 仅 unified_search 使用，可取 "today"|"yesterday"|"7d"|"30d"|"90d"，没有则省略\n` +
    `- attachmentFileName: 明确指定的附件文件名条件，与所属档案标题分开\n` +
    `- attachmentMode: 附件查询方式，列出附件用 "list"，按附件名称筛选用 "file_name"\n` +
    `- archiveTitleCandidates / attachmentNameCandidates / metadataTerms / contentTerms: 分别为档案标题、附件名称、元数据及正文的候选字符串数组，每项不超过100字，最多6项；名称不要求扩展名，模糊名称允许多候选。不得返回档案或附件 ID。\n` +
    `- queryReference: “这些/那些/其中/这份/刚才那些”等连续追问填 "previous_results"\n` +
    `- confidence: 0 到 1 的小数\n` +
    '规则：\n' +
    '1. 询问合同条款、正文内容、付款条件、要求总结或比较等「附件正文问题」时，kind 用 "content_question"；' +
    '若提问里出现了档号或档案标题，一并填进 archiveNo / title，以便系统锁定取证范围；\n' +
    '2. 询问“某档案里面有哪些附件”时，kind 用 "unified_search"，scopes 只填 ["attachment"]，title 填所属档案标题，attachmentMode 填 "list"；\n' +
    '3. 明确按附件名称筛选时，attachmentFileName 填附件名称，attachmentMode 填 "file_name"，scopes 包含 "attachment"；\n' +
    '4. 同时查询档案和附件等多个对象时，kind 用 "unified_search"，scopes 填实际涉及的范围；不得把礼貌语、疑问词当作 keyword；\n' +
    '5. 询问谁修改/创建/删除/操作过档案时，优先使用 "audit" 范围，并识别时间范围；\n' +
    '6. 连续追问“这些/那些/其中/这份”等上一轮结果时，queryReference 填 "previous_results"，不要猜测实体 ID；\n' +
    '7. 询问怎么检索、如何问更准时，kind 用 "help"；要求删除、归档、审批等写操作时用 "unsupported"；\n' +
    '8. 永远不要输出用户身份、角色、权限或任何档案数据，你只负责解析条件。'
  );
}

/** 会话消息持久化辅助：安全解析服务端保存的草稿/结果内容（损坏或未写入时不猜、不执行）。 */
function parseDraftJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

/** 现有档案的真实著录值（区分原始数据与 AI 建议值）。 */
function originalCatalogValue(
  current: ReturnType<AgentToolService['currentCatalog']>,
  field: ExtractedValue,
): string {
  if (!current) return '';
  if (field.fixed) {
    const raw = (current as Record<string, unknown>)[field.key];
    return raw === null || raw === undefined ? '' : String(raw);
  }
  const hit = current.dynamic.find((d) => d.fieldKey === field.key);
  return hit ? hit.value : '';
}

/**
 * 降级诊断标签：只输出白名单内的固定错误码/内置校验消息（HTTP 状态码、代码内写死的英文串），
 * 绝不回显模型原文、厂商错误体或密钥，供日志与 plannerCall.failure 定位降级真因。
 */
function agentFailureLabel(err: unknown): string {
  if (err instanceof RetrievalPlanValidationError) return `plan_validation:${err.message}`;
  if (err instanceof AiModelError) return `model:${err.code}`;
  if (err instanceof HttpException) return `http:${err.getStatus()}`;
  return 'execution_failed';
}

@Injectable()
export class AgentService {
  constructor(
    @Inject(AgentRetrievalService) private readonly retrieval: AgentRetrievalService,
    @Inject(AgentContextService) private readonly context: AgentContextService,
    @Inject(AgentToolDispatcher) private readonly dispatcher: AgentToolDispatcher,
    @Inject(AgentRepository) private readonly repo: AgentRepository,
    @Inject(AI_MODEL_CLIENT) private readonly model: AiModelClient,
    private readonly personalAiSettings: PersonalAiSettingsService,
    @Inject(ArchivesService) private readonly archives: ArchivesService,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(CategoryRepository) private readonly categories: CategoryRepository,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
    @Inject(AuditService) private readonly audit: AuditService,
    // 第三阶段：受控工具（只读与需确认）+ 待确认草稿仓储
    @Inject(AgentToolService) private readonly tools: AgentToolService,
    @Inject(AgentPendingActionRepository) private readonly pendingRepo: AgentPendingActionRepository,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(ContentIndexService) private readonly contentIndex: ContentIndexService,
    @Inject(GraphQueryService) private readonly graph: GraphQueryService,
    @Inject(KnowledgeSearchService) private readonly knowledge: KnowledgeSearchService,
  ) {}

  // ==================== 会话 ====================

  createConversation(operator: UserView): AgentConversationView {
    const row = this.repo.createConversation(operator.id, '新对话');
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.AGENT_CONVERSATION_CREATE,
      AUDIT_OBJECT.AGENT_CONVERSATION,
      row.id,
      {},
    );
    return this.toConversationView(row);
  }

  listConversations(operator: UserView): AgentConversationView[] {
    return this.repo
      .listConversations(operator.id, CONVERSATION_LIST_LIMIT)
      .map((row) => this.toConversationView(row));
  }

  /** 取会话消息：必须同时命中 id 与当前用户，否则视为不存在（不区分他人会话，避免探测）。 */
  getConversation(id: number, operator: UserView): {
    conversation: AgentConversationView;
    messages: AgentMessageView[];
  } {
    const row = this.repo.findConversation(id, operator.id);
    if (!row) throw new NotFoundException('会话不存在或不属于当前用户');
    return {
      conversation: this.toConversationView(row),
      messages: this.repo.listMessages(id, MESSAGE_HISTORY_LIMIT).map((m) => this.toMessageView(m, operator)),
    };
  }

  /**
   * 授权诊断视图：仅返回原始诊断与生成状态，供管理员/审计排查误杀。
   * 普通会话接口不展示这些内容，也不改变数据库中的原始记录。
   */
  diagnostics(id: number, operator: UserView): {
    conversation: AgentConversationView;
    messages: Array<{ id: number; createdAt: string; content: string; diagnostics: string[];
      trace: AgentTraceStep[]; answerGeneration: AnswerGeneration | null }>;
  } {
    const row = this.repo.findConversation(id, operator.id);
    if (!row) throw new NotFoundException('会话不存在或不属于当前用户');
    return {
      conversation: this.toConversationView(row),
      messages: this.repo.listMessages(id, MESSAGE_HISTORY_LIMIT).filter(message => message.role === 'assistant').map(message => {
        let payload: AgentPayload | null = null;
        try { payload = message.payloadJson ? JSON.parse(message.payloadJson) as AgentPayload : null; } catch { payload = null; }
        return { id: message.id, createdAt: message.createdAt, content: message.content,
          diagnostics: payload?.diagnostics ?? [], trace: payload?.trace ?? [],
          answerGeneration: payload?.answerGeneration ?? null };
      }),
    };
  }

  deleteConversation(id: number, operator: UserView): { ok: true } {
    const row = this.repo.findConversation(id, operator.id);
    if (!row) throw new NotFoundException('会话不存在或不属于当前用户');
    const messageCount = this.repo.countMessages(id);
    if (!this.repo.deleteConversation(id, operator.id)) {
      throw new NotFoundException('会话不存在或不属于当前用户');
    }
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.AGENT_CONVERSATION_DELETE,
      AUDIT_OBJECT.AGENT_CONVERSATION,
      id,
      { messageCount },
    );
    return { ok: true as const };
  }

  // ==================== 提问 ====================

  async ask(
    conversationId: number,
    input: { question?: unknown; clientRequestId?: unknown; context?: unknown },
    operator: UserView,
    onTraceUpdate?: (steps: AgentTraceStep[]) => void,
    signal?: AbortSignal,
  ): Promise<AgentAskResult> {
    try {
      return await withAgentCancellation(signal, () =>
        withExecutionBudget(() => withAgentTrace(() => this.askInContext(conversationId, input, operator), onTraceUpdate)));
    } catch (error) {
      if (isAgentCancelled(error)) return this.persistStoppedExchange(conversationId, input, operator);
      throw error;
    }
  }

  /**
   * 重新生成：用同一条用户问题重新执行一次，并原地替换最后一条回复。
   * 不追加新的用户消息，不改动更早的对话；只能针对当前会话的最后一条回复。
   */
  async regenerate(
    conversationId: number,
    messageId: number,
    operator: UserView,
    onTraceUpdate?: (steps: AgentTraceStep[]) => void,
    signal?: AbortSignal,
  ): Promise<{ conversation: AgentConversationView; reply: AgentMessageView }> {
    try {
      return await withAgentCancellation(signal, () => withExecutionBudget(() => withAgentTrace(async () => {
      const conversation = this.repo.findConversation(conversationId, operator.id);
      if (!conversation) throw new NotFoundException('会话不存在或不属于当前用户');
      if (!Number.isSafeInteger(messageId) || messageId <= 0) {
        throw new BadRequestException('消息参数不合法');
      }
      const messages = this.repo.listMessages(conversationId, MESSAGE_HISTORY_LIMIT);
      const target = messages.at(-1);
      const paired = messages.at(-2);
      if (!target || target.id !== messageId || target.role !== 'assistant' || paired?.role !== 'user') {
        throw new BadRequestException('只能重新生成由用户提问产生的最后一条回复');
      }
      let question = paired.content;
      if (isReanswerRequest(normalizeFollowUpQuestion(question))) {
        question = this.findPreviousUserQuestion(conversationId) ?? '';
      }
      if (!question.trim()) throw new BadRequestException('当前会话没有可重新生成的问题');
      if (this.pendingRepo.findLatestPending(operator.id, conversationId)) {
        throw new BadRequestException('当前还有待确认的业务草稿，请先确认或取消后再重新生成');
      }
      const result = await this.askInContext(conversationId, { question }, operator, messageId);
      return { conversation: result.conversation, reply: result.reply };
      }, onTraceUpdate)));
    } catch (error) {
      if (!isAgentCancelled(error)) throw error;
      // 重新生成被停止时保留原回复，不追加或改写任何消息。
      const conversation = this.repo.findConversation(conversationId, operator.id);
      const target = conversation
        ? this.repo.listMessages(conversationId, MESSAGE_HISTORY_LIMIT).find((message) => message.id === messageId)
        : undefined;
      if (!conversation || !target) throw error;
      return { conversation: this.toConversationView(conversation), reply: this.toMessageView(target, operator) };
    }
  }

  private async askInContext(conversationId:number,input:{question?:unknown;clientRequestId?:unknown;context?:unknown},operator:UserView,replacementMessageId?:number):Promise<AgentAskResult> {
    throwIfAgentCancelled();
    const conversation = this.repo.findConversation(conversationId, operator.id);
    if (!conversation) throw new NotFoundException('会话不存在或不属于当前用户');

    const question = String(input.question ?? '').trim();
    if (!question) throw new BadRequestException('请输入想查询的内容');
    if (question.length > MAX_QUESTION_LENGTH) {
      throw new BadRequestException(`提问内容不能超过 ${MAX_QUESTION_LENGTH} 个字符`);
    }
    const normalizedQuestion = normalizeFollowUpQuestion(question);
    const reanswerRequested = isReanswerRequest(normalizedQuestion);
    // 纯粹的“重新回答”从当前会话中恢复上一条有效用户问题；纠正型表达则使用剥离话术后的新问题。
    const previousQuestion = reanswerRequested ? this.findPreviousUserQuestion(conversationId) : null;
    const effectiveQuestion = reanswerRequested ? (previousQuestion ?? '') : (normalizedQuestion || question);
    const clientRequestId = this.normalizeClientRequestId(input.clientRequestId);

    // 幂等：同一 clientRequestId 已生成过回复 → 直接返回既有消息，不重复检索、不重复落库
    if (clientRequestId) {
      const existing = this.repo.findMessageByClientRequest(conversationId, clientRequestId);
      if (existing) {
        const userMessage = this.findPairedUserMessage(conversationId, existing);
        return {
          conversation: this.toConversationView(
            this.repo.findConversation(conversationId, operator.id) ?? conversation,
          ),
          userMessage: this.toMessageView(userMessage, operator),
          reply: this.toMessageView(existing, operator),
          replayed: true,
        };
      }
    }

    recordStep('understand', 'running', 0, 0);
    const categories = this.categoryHints();
    const model = budgetedModel(this.personalAiSettings.clientForUser(operator.id, this.model));

    // 第三阶段：图谱页面「问 AI / 分析关联」传来的节点/关系提示只作上下文入口；
    // 这里立即在后端重新查询并验证真实性与访问权限（不存在/无权一律 404，绝不采信客户端 ID）。
    const graphContext = input.context === undefined || input.context === null || input.context === ''
      ? null : this.resolveGraphContext(input.context, operator);

    // 第三阶段：本会话若存在待确认草稿，先按「确认 / 取消 / 逐项补齐」处理。
    // 纯重答请求不应被误当成草稿补充；纠正后的真实问题仍可正常进入业务流程。
    const draft = this.pendingRepo.findLatestPending(operator.id, conversationId);
    if (draft && !reanswerRequested) {
      const handled = this.tryHandleDraftText(draft, effectiveQuestion, operator, conversationId);
      if (handled) {
        return this.persistExchange(conversationId, conversation, question, handled, operator, clientRequestId, replacementMessageId);
      }
    }

    if (reanswerRequested && !effectiveQuestion) {
      const noHistory = await this.buildReply({ kind: 'unparsed' }, {
        question,
        categories,
        operator,
        aiUsed: false,
        aiNote: null,
        conversationId,
        model,
      });
      noHistory.content = '当前对话还没有可重新回答的问题。请先提出一个档案查询问题。';
      return this.persistExchange(conversationId, conversation, question, noHistory, operator, clientRequestId, replacementMessageId);
    }

    const deterministic = parseDeterministic({ question: effectiveQuestion.replace(/第\s*\d+\s*页|每页\s*\d+\s*条/gu, '').trim(), categories });
    // Only exact, structured identifiers and confirmed write workflows bypass planning.
    const exactNumber = /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){2,}$/u.test(effectiveQuestion);
    // 扩展快速路径：业务意图（borrow_apply/catalog_suggest/borrow_progress）当确定性解析为 strong 时直接处理
    const writeWorkflow = deterministic.strong && ['borrow_apply', 'catalog_suggest', 'borrow_progress'].includes(deterministic.intent.kind);
    const safeLookup = safeDeterministicLookup(effectiveQuestion, deterministic.intent);
    // Only keyword-free inventories are unambiguous enough to bypass AI while available.
    const directIntent = deterministic.strong && !!safeLookup &&
      (!model.available || (safeLookup.kind === 'search' && !safeLookup.keyword && !safeLookup.title && !safeLookup.archiveNo));
    const simpleRead = deterministic.strong && ['unified_search','content_question'].includes(deterministic.intent.kind) &&
      (!model.available || normalizeAgentQuestion(effectiveQuestion).length <= 12) &&
      !isComparisonQuestion(effectiveQuestion) && (!isSummaryQuestion(effectiveQuestion) || !model.available && !!deterministic.intent.title) &&
      !/分析|风险|建议|进度|未完成|属于|其他附件|还有哪些|核对|核实|完整/u.test(effectiveQuestion);
    if (!graphContext && (exactNumber || writeWorkflow || directIntent || simpleRead)) {
      understood();
      const intent = exactNumber ? { kind: 'archive_info' as const, archiveNo: effectiveQuestion } : deterministic.intent;
      const archiveLookup = ['archive_info', 'search', 'unified_search', 'borrow_progress'].includes(intent.kind);
      const contentLookup = intent.kind === 'content_question';
      if (archiveLookup) recordStep('archives', 'running', 0, 0);
      if (contentLookup) recordStep('content', 'running', 0, 0);
      const reply = await this.buildReply(intent, { question: effectiveQuestion, categories, operator,
        aiUsed: false, aiNote: null, conversationId, model });
      if (archiveLookup) recordStep('archives', reply.payload.total > 0 ? 'completed' : 'empty', reply.payload.total ?? 0, 0);
      if (contentLookup) {
        const hits = reply.payload.retrievedAttachments?.length ?? reply.payload.sources?.length ?? 0;
        recordStep('content', hits > 0 ? 'completed' : 'empty', hits, 0);
      }
      return this.persistExchange(conversationId, conversation, question, reply, operator, clientRequestId, replacementMessageId);
    }
    let failure = 'model:unconfigured';
    let planned = false;
    if (model.available) {
      try {
        const loaded = replacementMessageId === undefined
          ? this.context.load(conversationId, operator.id)
          : this.context.loadBefore(conversationId, operator.id, replacementMessageId);
        const context = graphContext ? this.applyGraphContext(loaded, graphContext) : loaded;
        const slots = this.buildContextSlots(context, operator);
        const plan = await generateRetrievalPlan(effectiveQuestion, model, {
          previousQuestion: context.previousQuestion, recentTurns: context.recentTurns, summary: context.summary,
          focus: context.focus, ...slots,
          ...(graphContext ? { graphNote: graphContext.note } : {}),
        }, categories.map(c => c.name), undefined, this.retrieval.plannerTools());
        planned = true;
        // A literal, verified title is an explicit constraint, never a route around AI.
        const namedTitle = deterministic.intent.title;
        if (namedTitle && effectiveQuestion.includes(namedTitle)) {
          const exact = this.archives.searchArchives({title:namedTitle,page:'1',pageSize:'100'},operator).items.filter(a=>a.title===namedTitle);
          if (exact.length) plan.hardConstraints.archiveTitles = [...new Set([...plan.hardConstraints.archiveTitles,namedTitle])];
        }
        understood();
        const reply = await this.answerRetrievalPlan(plan, { question: effectiveQuestion, operator, model, conversationId, context }, false);
        return this.persistExchange(conversationId, conversation, question, reply, operator, clientRequestId, replacementMessageId);
      } catch (err) {
        if (isAgentCancelled(err)) throw err;
        failure = agentFailureLabel(err);
      }
    }
    if (safeLookup && deterministic.strong) {
      const archiveLookup = safeLookup.kind === 'search' || safeLookup.kind === 'archive_info' || deterministic.intent.kind === 'borrow_progress';
      if (archiveLookup) recordStep('archives', 'running', 0, 0);
      const reply = await this.buildReply(safeLookup, {question:effectiveQuestion, categories, operator,
        aiUsed:false, aiNote:'AI 暂时不可用，已按你给出的明确条件直接查询。', conversationId, model});
      if (archiveLookup) recordStep('archives', reply.payload.total > 0 ? 'completed' : 'empty', reply.payload.total ?? 0, 0);
      reply.payload.plannerCall = {attempted:model.available,status:model.available?'failed':'unavailable',provider:model.provider??'unknown',model:model.model,failure};
      return this.persistExchange(conversationId, conversation, question, reply, operator, clientRequestId, replacementMessageId);
    }
    const failureReason = planned ? '这次查询没有执行完成，本次未取得可用结果。' : failure.startsWith('plan_validation:')
      ? 'AI 计划未通过校验，未执行不安全或不完整的查询步骤。'
      : failure === 'model:invalid_json' ? '模型返回格式错误，未获得有效检索计划。'
      : model.available ? '模型服务调用失败，暂时无法完成检索规划。' : '尚未配置可用的 AI 模型服务。';
    const reply: { content: string; payload: AgentPayload } = {
      content: `${failureReason}本次未生成分析结论；可稍后重试，或提供明确档号、名称等查询条件。`,
      payload: { kind: 'target_ask', intent: 'unparsed', conditions: {}, matched: false, total: 0, shown: 0, items: [],
        aiUsed: false, aiNote: failureReason, reason: failureReason,
        plannerCall: { attempted: model.available, status: model.available ? 'failed' : 'unavailable', provider: model.provider ?? 'unknown', model: model.model, failure } },
    };

    return this.persistExchange(conversationId, conversation, question, reply, operator, clientRequestId, replacementMessageId);
  }

  /**
   * 确认 / 取消待执行的业务草稿（卡片按钮入口，不携带用户提问文本）。
   * 只信任 token + 会话归属：档案 ID、分类 ID、申请内容全部来自服务端保存的草稿行。
   */
  act(
    conversationId: number,
    input: { token?: unknown; action?: unknown; values?: unknown },
    operator: UserView,
  ): { conversation: AgentConversationView; reply: AgentMessageView } {
    const conversation = this.repo.findConversation(conversationId, operator.id);
    if (!conversation) throw new NotFoundException('会话不存在或不属于当前用户');
    const token = String(input?.token ?? '').trim();
    if (!token) throw new BadRequestException('缺少待确认标识，请重新发起业务办理');
    const action = String(input?.action ?? '').trim();
    if (action !== 'confirm' && action !== 'cancel') {
      throw new BadRequestException('不支持的操作，仅允许确认提交与取消申请');
    }
    const draft = this.pendingRepo.find(token, operator.id, conversationId);
    if (!draft) throw new NotFoundException('待确认的申请不存在或已失效，请重新发起');

    const reply =
      action === 'cancel'
        ? this.cancelDraft(draft, operator, conversationId)
        : this.executeDraft(draft, operator, conversationId, this.pickEditableValues(input?.values));

    const assistant = this.tx.run(() => {
      const appended = this.repo.appendMessage({
        conversationId,
        role: 'assistant',
        content: reply.content,
        payloadJson: JSON.stringify(reply.payload),
      });
      this.repo.touchConversation(conversationId, operator.id, conversation.title);
      return appended;
    });
    return { conversation: this.toConversationView(conversation), reply: this.toMessageView(assistant, operator) };
  }

  /**
   * 用户主动停止后仍保留本轮记录：提问与「已停止生成」回复同事务落库，
   * 刷新或重新进入会话时可见；同一 clientRequestId 重复提交直接回放，不产生重复消息。
   */
  private persistStoppedExchange(
    conversationId: number,
    input: { question?: unknown; clientRequestId?: unknown },
    operator: UserView,
  ): AgentAskResult {
    const conversation = this.repo.findConversation(conversationId, operator.id);
    if (!conversation) throw new NotFoundException('会话不存在或不属于当前用户');
    const question = String(input.question ?? '').trim();
    const clientRequestId = this.normalizeClientRequestId(input.clientRequestId);
    if (clientRequestId) {
      const existing = this.repo.findMessageByClientRequest(conversationId, clientRequestId);
      if (existing) {
        return {
          conversation: this.toConversationView(
            this.repo.findConversation(conversationId, operator.id) ?? conversation,
          ),
          userMessage: this.toMessageView(this.findPairedUserMessage(conversationId, existing), operator),
          reply: this.toMessageView(existing, operator),
          replayed: true,
          cancelled: true,
        };
      }
    }
    if (!question) throw new BadRequestException('请输入想查询的内容');
    const payload: AgentPayload = {
      kind: 'stopped', intent: 'unparsed', conditions: {}, matched: false, total: 0, shown: 0, items: [],
      aiUsed: false, aiNote: null, reason: null,
    };
    const content = '已停止生成。你可以重新发送问题，或修改后继续提问。';
    const persisted = this.tx.run(() => {
      const userMessage = this.repo.appendMessage({ conversationId, role: 'user', content: question });
      const assistant = this.repo.appendMessage({
        conversationId,
        role: 'assistant',
        content,
        payloadJson: JSON.stringify(payload),
        clientRequestId,
      });
      const title = conversation.title === '新对话' ? buildConversationTitle(question) : conversation.title;
      this.repo.touchConversation(conversationId, operator.id, title);
      return { userMessage, assistant };
    });
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.AGENT_QUERY,
      AUDIT_OBJECT.AGENT_CONVERSATION,
      conversationId,
      { intent: 'unparsed', kind: 'stopped', total: 0, conditions: {}, aiUsed: false,
        aiUnavailable: false, sourceCount: 0, unresolved: false, cancelled: true },
    );
    return {
      conversation: this.toConversationView(
        this.repo.findConversation(conversationId, operator.id) ?? conversation,
      ),
      userMessage: this.toMessageView(persisted.userMessage, operator),
      reply: this.toMessageView(persisted.assistant, operator),
      replayed: false,
      cancelled: true,
    };
  }

  /** 消息落库 + Agent 检索留痕（提问与回复同事务；审计不写完整对话正文）。 */
  private persistExchange(
    conversationId: number,
    conversation: AgentConversationRow,
    question: string,
    reply: { content: string; payload: AgentPayload },
    operator: UserView,
    clientRequestId: string | null,
    replacementMessageId?: number,
  ): AgentAskResult {
    throwIfAgentCancelled();
    if (executionBudget()?.exhausted) reply.content += '\n任务已达到全局执行预算上限，仍有未完成检索或分析；不能视为完整结论。';
    Object.assign(reply.payload, { executionBudget: executionBudget()?.snapshot(), authorizationRole: operator.role });
    reply.payload.trace=finishAgentTrace(reply.payload.toolResults,(reply.payload.sources??[]).length+(reply.payload.metadataSources??[]).length);
    reply = this.revalidateReply(reply, operator);
    const suggestions = unableAnswerSuggestions(reply.payload);
    if (suggestions.length) reply.payload.suggestions = suggestions;
    const generation=reply.payload.answerGeneration;
    console.info(JSON.stringify({event:'agent.turn',intent:reply.payload.retrievalPlan?.responseMode??reply.payload.intent,
      usedContext:reply.payload.usedContext??reply.payload.retrievalPlan?.contentScope==='previous_results',
      archives:reply.payload.total,attachments:reply.payload.retrievedAttachments?.length??new Set(reply.payload.sources?.map(s=>s.fileId)).size,
      contentHits:reply.payload.trace?.find(step=>step.id==='content')?.hitCount??0,
      evidence:reply.payload.evidenceSelection,modelEvidenceCount:generation?.evidenceCount??0,
      processedEvidenceCount:generation?.processedEvidenceCount??0,citationStatus:generation?.citations??'not_checked',
      finalStatus:generation?.status??reply.payload.kind}));
    // 业务写入与「消息落库」同事务；审计为非关键事件在提交后尽力留痕（不含完整对话正文）
    const priorContext = replacementMessageId === undefined
      ? this.context.load(conversationId, operator.id)
      : this.context.loadBefore(conversationId, operator.id, replacementMessageId);
    reply.payload.context = this.context.advance(priorContext, question, reply.payload);
    delete reply.payload.contextSelection;
    const persisted = this.tx.run(() => {
      if (replacementMessageId !== undefined) {
        const assistant = this.repo.updateMessage(
          conversationId,
          replacementMessageId,
          reply.content,
          JSON.stringify(reply.payload),
        );
        if (!assistant) throw new NotFoundException('要重新生成的回复不存在或已被替换');
        this.repo.touchConversation(conversationId, operator.id, conversation.title);
        return {
          userMessage: this.findPairedUserMessage(conversationId, assistant),
          assistant,
        };
      }
      const userMessage = this.repo.appendMessage({
        conversationId,
        role: 'user',
        content: question,
      });
      const assistant = this.repo.appendMessage({
        conversationId,
        role: 'assistant',
        content: reply.content,
        payloadJson: JSON.stringify(reply.payload),
        clientRequestId,
      });
      const title =
        conversation.title === '新对话' ? buildConversationTitle(question) : conversation.title;
      this.repo.touchConversation(conversationId, operator.id, title);
      return { userMessage, assistant };
    });

    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.AGENT_QUERY,
      AUDIT_OBJECT.AGENT_CONVERSATION,
      conversationId,
      {
        intent: reply.payload.intent,
        kind: reply.payload.kind,
        total: reply.payload.total,
        // 只留检索条件摘要，不写入完整提问原文（避免敏感对话进入审计）
        conditions: reply.payload.conditions,
        aiUsed: reply.payload.aiUsed,
        aiUnavailable: !reply.payload.aiUsed && reply.payload.aiNote !== null,
        // 内容问答只记「引用了几条来源」，绝不把正文片段/摘录写进审计 detail
        sourceCount: reply.payload.sources?.length ?? 0,
        unresolved: reply.payload.kind === 'content_no_evidence',
      },
    );

    return {
      conversation: this.toConversationView(
        this.repo.findConversation(conversationId, operator.id) ?? conversation,
      ),
      userMessage: this.toMessageView(persisted.userMessage, operator),
      reply: this.toMessageView(persisted.assistant, operator),
      replayed: false,
    };
  }

  // ==================== 内部实现 ====================

  /**
   * 会话授权槽位表（点8/参考与范围分离）：把上一轮真实档案/附件以稳定序号 1..N + 标题提供给规划器，
   * 模型用 contextRef:{entity,slot} 引用“这份/刚才那份/另外一个”，后端按序号解析为已 canView 复核的真实 ID。
   * 标题只来自当前用户可见的真实详情（getArchiveDetail 内含权限判定）；已删除/无权的一律跳过，绝不臆造。
   */
  private buildContextSlots(context: AgentContextSnapshot, operator: UserView): { archiveSlots?: Array<{ slot: number; title: string }>; attachmentSlots?: Array<{ slot: number; name: string; archiveSlot?: number }> } {
    const archiveIds = context.activeArchives.length ? context.activeArchives : context.archives;
    if (!archiveIds.length && !context.attachments.length) return {};
    const archiveSlots: Array<{ slot: number; title: string }> = [];
    archiveIds.forEach((id, i) => { try { archiveSlots.push({ slot: i + 1, title: this.archives.getArchiveDetail(id, operator).title }); } catch { /* 已删除或无权：不进入槽位表 */ } });
    const detailCache = new Map<number, { title: string; files: Array<{ id: number; name: string }> }>();
    const detail = (archiveId: number): { title: string; files: Array<{ id: number; name: string }> } | undefined => {
      const cached = detailCache.get(archiveId); if (cached) return cached;
      try { const a = this.archives.getArchiveDetail(archiveId, operator); const d = { title: a.title, files: a.files.map(f => ({ id: f.id, name: f.originalName })) }; detailCache.set(archiveId, d); return d; } catch { return undefined; }
    };
    const attachmentSlots: Array<{ slot: number; name: string; archiveSlot?: number }> = [];
    context.attachments.forEach((att, i) => {
      const d = detail(att.archiveId); if (!d) return; const f = d.files.find(x => x.id === att.fileId); if (!f) return;
      const aslot = archiveIds.indexOf(att.archiveId); attachmentSlots.push({ slot: i + 1, name: f?.name ?? `附件#${att.fileId}`, ...(aslot >= 0 ? { archiveSlot: aslot + 1 } : {}) });
    });
    return { ...(archiveSlots.length ? { archiveSlots } : {}), ...(attachmentSlots.length ? { attachmentSlots } : {}) };
  }

  /**
   * 第三阶段：解析并验证图谱页面传来的节点/关系上下文提示。
   * 客户端只允许提供「类型 + ID」这一种线索；真实性与权限一律后端重新查询：
   * - detail/relations 复用第二阶段 GraphQueryService 的三层权限闸门（无权/不存在统一 404，不区分原因避免探测）；
   * - 验证通过的 ID 只进入会话快照槽位，后续检索仍由工具层逐次 canView 复核；
   * - 未知键/半整数 ID/非白名单节点类型一律 400（fail-closed）。
   */
  private resolveGraphContext(raw: unknown, operator: UserView): { archives: number[]; attachments: Array<{ archiveId: number; fileId: number }>; note: string } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('图谱上下文参数不合法');
    const c = raw as Record<string, unknown>;
    if (Object.keys(c).some(k => k !== 'graphNode' && k !== 'graphEdge')) throw new BadRequestException('图谱上下文参数不合法');
    const hasNode = c.graphNode !== undefined && c.graphNode !== null;
    const hasEdge = c.graphEdge !== undefined && c.graphEdge !== null;
    if (hasNode === hasEdge) throw new BadRequestException('图谱上下文需且只需提供节点或关系其中一种');
    if (hasNode) {
      const n = c.graphNode;
      if (!n || typeof n !== 'object' || Array.isArray(n)) throw new BadRequestException('图谱节点上下文不合法');
      const node = n as Record<string, unknown>;
      if (Object.keys(node).some(k => k !== 'nodeType' && k !== 'refId')) throw new BadRequestException('图谱节点上下文不合法');
      const nodeType = node.nodeType;
      if (nodeType !== 'archive' && nodeType !== 'file' && nodeType !== 'chunk') throw new BadRequestException('不支持的图谱节点类型');
      if (!Number.isSafeInteger(node.refId) || (node.refId as number) <= 0) throw new BadRequestException('图谱节点 ID 不合法');
      // 后端重新查询：不存在或无权访问一律 404（借阅归还/过期后立即按最新权限拦截）
      const detail = this.graph.detail(operator, nodeType, node.refId as number);
      if (detail.type === 'archive') {
        if (!detail.permissions.canView) throw new NotFoundException('无权访问该档案');
        return { archives: [detail.node.refId], attachments: [],
          note: `图谱选中节点（后端已复核真实性与权限）：档案《${detail.title}》（档号 ${detail.archiveNo}）` };
      }
      if (detail.type === 'file') {
        return { archives: [detail.archive.id], attachments: [{ archiveId: detail.archive.id, fileId: detail.node.refId }],
          note: `图谱选中节点（后端已复核真实性与权限）：档案《${detail.archive.title}》（档号 ${detail.archive.archiveNo}）的附件《${detail.name}》` };
      }
      if (detail.type !== 'chunk') throw new BadRequestException('不支持的图谱节点类型');
      return { archives: [detail.archive.id], attachments: [{ archiveId: detail.archive.id, fileId: detail.file.id }],
        note: `图谱选中节点（后端已复核真实性与权限）：档案《${detail.archive.title}》（档号 ${detail.archive.archiveNo}）附件《${detail.file.name}》的正文知识块（${detail.locator || `第${detail.chunkNo}块`}）` };
    }
    const e = c.graphEdge;
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new BadRequestException('图谱关系上下文不合法');
    const edge = e as Record<string, unknown>;
    if (Object.keys(edge).some(k => k !== 'edgeId' && k !== 'fromArchiveId' && k !== 'toArchiveId')) throw new BadRequestException('图谱关系上下文不合法');
    for (const key of ['edgeId', 'fromArchiveId', 'toArchiveId']) {
      if (!Number.isSafeInteger(edge[key]) || (edge[key] as number) <= 0) throw new BadRequestException(`图谱关系参数 ${key} 不合法`);
    }
    const edgeId = edge.edgeId as number;
    const fromArchiveId = edge.fromArchiveId as number;
    const toArchiveId = edge.toArchiveId as number;
    // 关系两端都重新验证：起点走 GraphQueryService（无权即 404），命中项必须真实存在这条边且终点为当前用户可见的档案
    const live = this.graph.edge(operator, edgeId);
    const endpoints=[live.from,live.to];
    const source=endpoints.find(n=>n.type==='archive' && n.refId===fromArchiveId);
    const target=endpoints.find(n=>n.type==='archive' && n.refId===toArchiveId);
    const hit=source && target && fromArchiveId!==toArchiveId ? {edge:live.edge,node:target}:undefined;
    const found={node:source!};
    if (!hit) throw new NotFoundException('关联关系不存在，或当前账号无权访问关系两端的档案');
    const tfidf = hit.edge.basis.startsWith('tfidf');
    return {
      archives: [fromArchiveId, toArchiveId],
      attachments: [],
      note: `图谱选中关系（后端已复核）：《${found.node.label}》↔《${hit.node.label}》：${hit.edge.label}，依据 ${hit.edge.basis}${hit.edge.reason ? `（${hit.edge.reason}）` : ''}。${tfidf
        ? '注意：TF-IDF 相似度只说明正文词项相似，不能据此认定项目、合同或其他真实业务关系。'
        : hit.edge.basis === 'metadata_exact_match' ? '著录字段等值命中是确定性线索，但仍需正文证据才能得出业务结论。' : ''}`,
    };
  }

  /** 把已复核的图谱上下文固定为本轮会话作用域（只改内存快照，不代表授权；后续每次工具调用仍重新判权）。 */
  private applyGraphContext(state: AgentContextSnapshot, graph: { archives: number[]; attachments: Array<{ archiveId: number; fileId: number }> }): AgentContextSnapshot {
    const ids = (values: number[]) => [...new Set(values.filter(v => Number.isSafeInteger(v) && v > 0))].slice(0, CONTEXT_LIMITS.entities);
    const pinnedArchives = ids(graph.archives);
    const freshAttachments = graph.attachments.filter(a => !state.attachments.some(existing => existing.fileId === a.fileId)).slice(0, CONTEXT_LIMITS.entities);
    return {
      ...state,
      archives: ids([...pinnedArchives, ...state.archives]),
      attachments: [...freshAttachments, ...state.attachments].slice(0, CONTEXT_LIMITS.entities),
      activeArchives: pinnedArchives,
      activeFiles: ids(graph.attachments.map(a => a.fileId)),
      focus: graph.attachments.length ? 'attachment' : pinnedArchives.length ? 'archive' : state.focus,
    };
  }

  private async answerRetrievalPlan(plan: RetrievalPlan,
    ctx: { question: string; operator: UserView; model: AiModelClient; conversationId: number; context?: AgentContextSnapshot }, fast: boolean,
  ): Promise<{ content: string; payload: AgentPayload }> {
    const base: AgentPayload = { kind: 'search', intent: 'search', conditions: {}, matched: false, total: 0, shown: 0, items: [], aiUsed: !fast, aiNote: null, reason: null,
      retrievalPlan: plan, plannerCall: { attempted: !fast, status: fast ? 'fast_path' : 'success', provider: ctx.model.provider ?? 'unknown', model: ctx.model.model } };
    if (plan.needsClarification || plan.confidence < 0.4) return { content: plan.clarificationQuestion ?? '请补充想查的档案范围、业务内容或时间条件。', payload: { ...base, kind: 'target_ask' } };
    const result = await this.retrieval.retrieve(plan, ctx.operator, ctx.model, ctx.context ?? this.context.load(ctx.conversationId, ctx.operator.id));
    recordStep('evidence', 'running', 0, 0);
    base.toolResults = result.results; base.retrievalRounds = result.rounds;
    Object.assign(base, { coverage: result.coverage, sufficiency: result.sufficiency });
    base.retrievedAttachments = [...new Map(result.results.filter(r => r.status === 'success' && r.toolName === 'attachment.search').flatMap(r => r.data.items as FileSearchRow[]).map(f => [f.fileId, this.toAttachmentCard(f, ctx.operator)])).values()];
    base.toolExecutionStatus = result.results.some(r => r.status !== 'success') ? result.results.some(r => r.status === 'success') ? 'partial' : 'error' : 'success';
    if(base.toolExecutionStatus==='error' && result.results.some(r=>r.status==='error')) return {
      // 原始错误文本（工具名、依赖引用等）归入 diagnostics，正文只告知用户结果状态。
      content:'这次查询没有成功，未能取得可用的结果，请稍后重试或补充档案名称、档号。',
      payload:{...base,kind:'error',aiUsed:false,reason:'检索工具执行失败',contentNotes:userReadableNotes(result.notes),
        diagnostics:[...result.diagnostics, ...result.results.filter(r=>r.error?.message).map(r=>`${r.toolName}：${r.error?.message}`)]}};
    if (plan.responseMode === 'compare' && (result.missingAttachments?.length || result.coverage?.comparisonMissingSide)) {
      // 必须点名是哪一份没取到正文：用户才知道该补传、补问，还是换一份资料。
      const missing = [...new Set([...(result.missingAttachments ?? []),
        ...result.notes.map(note => /附件「([^」]+)」/u.exec(note)?.[1]).filter((name): name is string => !!name)])];
      const named = missing.slice(0, 3).map(name => `《${name}》`).join('、');
      return {content: named
        ? `暂时无法完成比较：没有找到${named}的正文内容，已找到的资料不能替代它。`
        : '暂时无法完成比较：还有一份资料没有取到正文内容，已找到的资料不能替代它。',
        payload:{...base,kind:'content_no_evidence',sources:[],contentNotes:userReadableNotes(result.notes),diagnostics:result.diagnostics,aiUsed:false,reason:'比较对象缺失'}};
    }
    const attachmentResults = result.results.filter(r=>r.toolName==='attachment.search' && r.status==='success' && !r.callId?.startsWith('constraint:'));
    if (!result.evidence.length && attachmentResults.length && !plan.planSteps.some(s=>['relevantText','fullText'].includes(s.expects))) {
      const files = [...new Map(attachmentResults.flatMap(r=>r.data.items as FileSearchRow[]).map(f=>[f.fileId,f])).values()];
      const statuses = [...new Map<number,any>(attachmentResults.flatMap(r=>r.data.indexStatuses??[]).map((f:any)=>[f.fileId,f])).values()];
      const parsed = statuses.filter(f=>['indexed','no_text'].includes(f.status)).length;
      const indexed = statuses.filter(f=>f.status==='indexed' && f.chunkCount>0).length;
      const cards = result.archives.map(a=>this.toCard(a,ctx.operator));
      return {content:(cards.length ? `找到 ${cards.length} 份档案，共 ${files.length} 份附件。` : '附件未找到或当前无权访问。')+'\n'+
        cards.map(c=>`档案《${c.title}》 · ${c.archiveNo} · ${c.statusLabel}\n`+files.filter(f=>f.archiveId===c.id).map(f=>`· ${f.fileName}`).join('\n')).join('\n'),
        payload:{...base,items:cards,total:cards.length,shown:cards.length,matched:files.length>0,aiUsed:false,
          attachmentInventory:{archives:cards.length,attachments:files.length,parsed,indexed,complete:base.toolExecutionStatus==='success'},contentNotes:userReadableNotes(result.notes),diagnostics:result.diagnostics}};
    }
    // A relation explanation can be grounded in graph evidence without pretending it is document text.
    if (!result.evidence.length && this.buildGraphCitations(result.results, ctx.operator).length) {
      return this.answerFromEvidence([], result.notes, { ...ctx, aiNote: null }, base, result.limitations);
    }
    if (result.sufficiency?.verdict === 'insufficient' || result.sufficiency?.verdict === 'clarify') {
      const clarify = result.sufficiency.verdict === 'clarify';
      // 模型判定原文可能带工具名/枚举，仅当它本身是用户可读的业务语言时才引用。
      const note = isUserReadableNote(result.sufficiency.note) ? result.sufficiency.note : '';
      const content = clarify
        ? `需要你补充一点信息：${note || '请说明想查的具体档案、附件或业务对象。'}`
        : `现有资料还不足以回答这个问题。${note}`;
      return {content,
        payload:{...base,kind:clarify?'target_ask':'content_no_evidence',sources:[],contentNotes:userReadableNotes(result.notes),diagnostics:result.diagnostics,aiUsed:false,
          aiNote:'没有找到足够的相关正文，未把这些命中整理成答案。',reason:result.sufficiency.note}};
    }
    if (!result.evidence.length && result.results.some(r => ['borrow.search','borrow.detail','audit.search','template.search','statistics.get','category.list'].includes(r.toolName))) {
      const names: Record<string, SearchScope> = { 'borrow.search':'borrow','borrow.detail':'borrow','audit.search':'audit','template.search':'template','statistics.get':'stats','category.list':'category','archive.search':'archive','archive.detail':'archive','attachment.search':'attachment' };
      const ids: Record<string, string> = { borrow:'borrowings',audit:'audits',template:'templates',stats:'statistics',category:'categories',archive:'archives',attachment:'attachments' };
      const grouped = new Map<string, AgentToolResult>();
      for (const r of result.results) {
        const scope = names[r.toolName]; if (!scope) continue;
        const id = ids[scope]; const prev = grouped.get(id);
        grouped.set(id, prev && prev.status === 'success' && r.status === 'success' && Array.isArray(r.data?.items)
          ? { ...r, callId:id, total:Math.max(r.total,prev.total), data:{...r.data,items:[...(prev.data?.items ?? []),...r.data.items]} }
          : {...r,callId:id});
      }
      return this.handleUnifiedSearch({kind:'unified_search',scopes:[...new Set(result.results.map(r => names[r.toolName]).filter(Boolean))]},
        {...ctx,execution:{results:[...grouped.values()],status:base.toolExecutionStatus ?? 'success'}},base);
    }
    if (result.evidence.length || plan.planSteps.some(s => ['relevantText', 'fullText'].includes(s.expects))) {
      // 若检索阶段已按原文顺序读取整篇（hitType=full_content），必须用 buildSummaryEvidence 保留全部分块，
      // 不能再按关键词相关度截断（否则 content_qa 误标会把整篇总结退化成 0 命中）。
      const orderedRead = result.evidence.some(e => e.hitType === 'full_content');
      const assembled = plan.responseMode === 'summary' || plan.responseMode === 'compare' || orderedRead ? buildSummaryEvidence(result.evidence) : selectEvidence(this.rankEvidence(result.evidence), ctx.question, ctx.model.contextWindowTokens);
      base.evidenceSelection = assembled.selection;
      base.evidenceCount = result.evidence.length;
      if (assembled.items.length) return this.answerFromEvidence(assembled.items, [...result.notes, ...assembled.notes], { ...ctx, aiNote: null }, base, result.limitations);
      recordStep('evidence', 'empty', 0, 0, '没有找到真实正文证据');
      recordStep('answer', 'empty', 0, 0, '没有正文证据，未调用回答模型');
      // 用户只看到「找到哪份档案 + 为什么答不了 + 怎么办」；工具名与覆盖率归入 diagnostics。
      const located = result.archives.slice(0, 3).map((archive) => ({
        title: archive.title, archiveNo: archive.archiveNo,
        fileCount: (() => { try { return this.archives.getArchiveDetail(archive.id, ctx.operator).files.length; } catch { return -1; } })(),
      }));
      const answer = noEvidenceAnswer({ archives: located, notes: result.notes });
      return { content: answer.content, payload: { ...base, kind: 'content_no_evidence', sources: [], contentNotes: answer.notes, diagnostics: result.diagnostics,
        modelCall: { provider: ctx.model.provider ?? 'unknown', model: ctx.model.model, attempted: false, status: 'not_attempted', reason: '未找到真实正文证据', evidenceCount: 0, modelEvidenceCount: 0 } } };
    }
    const page = Math.max(1, Math.min(1000000, Number(ctx.question.match(/第\s*(\d+)\s*页/u)?.[1] ?? 1)));
    const pageSize = Math.max(1, Math.min(100, Number(ctx.question.match(/每页\s*(\d+)\s*条/u)?.[1] ?? 20)));
    const total = result.inventory?.total ?? result.archives.length;
    base.total = total;
    const cards = result.archives.slice((page - 1) * pageSize, page * pageSize).map(a => this.toCard(a, ctx.operator));
    const counts = result.inventory;
    const listing = cards.map(c => `《${c.title}》 · ${c.statusLabel} · ${c.archiveNo}`).join('\n');
    const rawContent = counts ? `当前查询范围共有 ${counts.total} 份可访问档案。草稿 ${counts.statuses.draft} 份，已归档 ${counts.statuses.archived} 份。\n分类：${counts.categories.map(c => `${c.name} ${c.count} 份`).join('；') || '暂无档案'}。\n第 ${page} 页，本页 ${cards.length} 份。\n${listing}` : total ? `找到 ${total} 份相关档案，第 ${page} 页展示 ${cards.length} 份。\n${listing}` : '没有找到满足这些条件的可访问档案。可补充名称、业务内容或时间范围。';
    // P4 全类型 AI 综合作答：凡是真正经过规划器的清单/统计/定位结果（非确定性快速路径），
    // 都基于数据库真实数量与卡片再做一段 AI 叙述化分析；数据库数字始终原样展示（权威来源），
    // 归纳失败则回落纯数据库清单，绝不编造或美化。快速路径（精确档号/无歧义目录清单）保持确定性不调模型。
    let narrated: string | null = null;
    let narrMeta: Pick<AgentPayload, 'claims' | 'metadataSources' | 'answerGeneration' | 'aiUsed' | 'aiNote'> | null = null;
    if (!fast && result.results.some(r => r.status === 'success') && ctx.model.available) {
      const synth = await this.narrateListing(cards, counts, ctx, base);
      if (synth) { narrated = synth.content; narrMeta = synth.meta; }
    }
    if (!fast && !narrated && total > 0) base.aiNote = 'AI 综合分析未完成，以下仅为真实数据库检索结果。';
    if (!narrated) recordStep('answer', 'skipped', 0, 0, '直接返回真实数据库清单，无需生成回答');
    return { content: narrated ? `${narrated}\n\n${rawContent}` : rawContent, payload: { ...base, items: cards, total, shown: cards.length, matched: total > 0, inventory: counts,
      contentNotes: userReadableNotes(result.notes), diagnostics: result.diagnostics,
      ...(narrMeta ?? {}),
      pagination: { page, pageSize, totalPages: Math.ceil(total / pageSize), hasMore: page * pageSize < total },
      sources: result.evidence.length ? buildEvidence(result.evidence).map(e => this.toSource(e)) : [],
    } };
  }

  /**
   * 清单/统计的 AI 叙述化分析：把数据库真实卡片与计数作为“不可执行事实证据”交给模型归纳，
   * 通过引用核验才采用；任何失败一律返回 null 由调用方回落原始清单。数字权威来源始终是数据库。
   */
  private async narrateListing(
    cards: AgentArchiveCard[], counts: { total: number; statuses: Record<string, number>; categories: Array<{ name: string; count: number }> } | undefined,
    ctx: { question: string; operator: UserView; model: AiModelClient }, base: AgentPayload,
  ): Promise<{ content: string; meta: Pick<AgentPayload, 'claims' | 'metadataSources' | 'answerGeneration' | 'aiUsed' | 'aiNote'> } | null> {
    const selected: NonNullable<AgentPayload['metadataSources']> = cards.map((c, i) => ({ ref: `E${i + 1}`, kind: 'archive', archiveId: c.id, label: c.title,
      excerpt: `档案《${c.title}》：档号 ${c.archiveNo}；状态 ${c.statusLabel}${c.categoryName ? `；分类 ${c.categoryName}` : ''}。` }));
    for (const r of base.toolResults ?? []) {
      if (r.status !== 'success' || ['archive.search', 'archive.detail'].includes(r.toolName)) continue;
      const rows = r.data?.items ?? [r.data];
      for (const row of rows) {
        if (!row) continue;
        selected.push({ ref: `E${selected.length + 1}`, kind: r.toolName === 'attachment.search' ? 'attachment' : 'business',
          ...(row.archiveId ? { archiveId: row.archiveId } : {}), ...(row.fileId ? { fileId: row.fileId } : {}),
          label: row.fileName ?? r.toolName, excerpt: JSON.stringify(row) });
      }
    }
    const headline = counts ? `可访问档案总数 ${counts.total}（草稿 ${counts.statuses.draft}、已归档 ${counts.statuses.archived}）`
      : `本轮检索到的相关档案 ${base.total} 份`;
    selected.unshift({ ref: 'E0', kind: 'business', label: '本轮数据库计数', excerpt: headline });
    const evidence: EvidenceItem[] = selected.map(f => ({ ref: f.ref, excerpt: f.excerpt,
      row: { archiveTitle: f.label, archiveNo: '', fileName: '数据库事实', fileId: 0, versionNo: null } as EvidenceRow }));
    recordStep('answer', 'running', 0, 0);
    try {
      const generated = await generateGroundedAnswer(ctx.model, `${ctx.question}\n（请基于下列数据库真实清单与计数，客观归纳这批结果的整体情况；不得编造未出现的数字或事实）`, evidence);
      const verified = generated.verified;
      if (!verified?.valid) { recordStep('answer', 'failed', 0, 0, '清单归纳未完成，已保留数据库原始清单'); return null; }
      recordStep('answer', 'completed', verified.citations.length, 0, '清单叙述归纳和引用核验已完成');
      return { content: `以下分析基于本轮数据库真实检索结果：\n${verified.cleaned}`,
        meta: { aiUsed: true, aiNote: null, claims: verified.claims, answerGeneration: generated.state,
          metadataSources: selected.filter(f => verified.citations.some(item => item.ref === f.ref)) } };
    } catch (error) {
      if (isAgentCancelled(error)) throw error;
      recordStep('answer', 'failed', 0, 0, '清单归纳调用异常，已保留数据库原始清单');
      return null;
    }
  }

  /**
   * 依据意图生成回复（含真实检索）。
   * 返回 content（面向用户的中文）与 payload（结构化结果，前端渲染卡片）。
   */
  private async buildReply(
    intent: ParsedIntent,
    ctx: {
      question: string;
      categories: CategoryHint[];
      operator: UserView;
      aiUsed: boolean;
      aiNote: string | null;
      conversationId: number;
      model: AiModelClient;
    },
  ): Promise<{ content: string; payload: AgentPayload }> {
    const base: AgentPayload = {
      kind: 'search',
      intent: intent.kind,
      conditions: {},
      matched: false,
      total: 0,
      shown: 0,
      items: [],
      aiUsed: ctx.aiUsed,
      aiNote: ctx.aiNote,
      reason: null,
    };

    if (intent.kind === 'help') {
      return { content: HELP_ANSWER, payload: { ...base, kind: 'help', intent: 'help' } };
    }
    if (intent.kind === 'content_question') {
      return this.answerContentQuestion(intent, ctx, base);
    }
    if (intent.kind === 'unified_search') {
      return this.handleUnifiedSearch(intent, ctx, base);
    }
    // 第三阶段：业务办理意图（均需服务端权限与业务规则终局判定）
    if (intent.kind === 'borrow_apply') {
      return this.handleBorrowApply(intent, ctx, base);
    }
    if (intent.kind === 'borrow_progress') {
      return this.handleBorrowProgress(intent, ctx, base);
    }
    if (intent.kind === 'catalog_suggest') {
      return this.handleCatalogSuggest(intent, ctx, base);
    }
    if (intent.kind === 'unsupported') {
      return {
        content: UNSUPPORTED_ANSWER,
        payload: { ...base, kind: 'unsupported', intent: 'unsupported' },
      };
    }
    if (intent.kind === 'unparsed') {
      return {
        content: UNPARSED_ANSWER,
        payload: { ...base, kind: 'unparsed', intent: 'unparsed' },
      };
    }

    // 检索条件（只保留白名单字段，身份固定为当前会话用户）
    const conditions: AgentSearchConditions = {};
    if (intent.archiveNo) conditions.archiveNo = intent.archiveNo;
    if (intent.title) conditions.title = intent.title;
    if (intent.keyword) conditions.keyword = intent.keyword;
    if (intent.categoryName) conditions.categoryName = intent.categoryName;
    if (intent.status) conditions.status = intent.status;

    const execution = await this.dispatcher.dispatch(intent, ctx.operator, ctx.question);
    base.toolResults = execution.results;
    base.toolExecutionStatus = execution.status;
    const searchResult = execution.results.find(r => r.callId === 'archives' || r.callId === 'detail')!;
    if (searchResult.status !== 'success') {
      return { content: `这次没能完成检索：${searchResult.error?.message}`,
        payload: { ...base, kind: 'error', conditions, reason: searchResult.error?.message ?? '档案检索失败' } };
    }
    const page = { items: searchResult.data.items as ArchiveView[], total: searchResult.total };

    const cards = page.items.slice(0, RESULT_CARD_LIMIT).map((item) => this.toCard(item, ctx.operator));
    const conditionDesc = this.describeConditions(conditions);

    if (page.total === 0) {
      const content =
        `没有找到符合条件的档案${conditionDesc ? `（${conditionDesc}）` : ''}。\n${NO_RESULT_HINT}`;
      return {
        content,
        payload: {
          ...base,
          kind: intent.kind === 'archive_info' ? 'archive_info' : 'search',
          conditions,
          matched: false,
          total: 0,
          shown: 0,
          items: [],
        },
      };
    }

    if (intent.kind === 'archive_info') {
      if (page.total > 1) return {
        content: '找到多份名称相同或相近的档案。你要查看其中哪一份？',
        payload: { ...base, kind: 'archive_info', conditions, matched: true, total: page.total, shown: cards.length, items: cards },
      };
      const first = cards[0];
      const detail = execution.results.find(r => r.callId === 'detail' && r.status === 'success')?.data?.items?.[0];
      const content =
        `为你找到《${first.title}》，以下是基础信息：\n` +
        `档号：${first.archiveNo}\n` +
        `分类：${first.categoryPath}\n` +
        `类型：${first.archiveType}\n` +
        `状态：${first.statusLabel}\n` +
        `形成时间：${detail?.formationDate ?? first.formationDate ?? '未著录'}\n` +
        `责任者：${detail?.responsible || first.responsible || '未著录'}\n` +
        (detail ? `附件数量：${detail.files.length} 个\n` : '附件数量查询失败，暂时无法确认。\n') +
        (page.total > 1 ? `另有 ${page.total - 1} 条同名/相近结果，可点击卡片查看。` : '');
      return {
        content,
        payload: {
          ...base,
          reason: execution.results.find(r => r.status !== 'success')?.error?.message ?? null,
          kind: 'archive_info',
          conditions,
          matched: true,
          total: page.total,
          shown: cards.length,
          items: cards,
        },
      };
    }

    const content = answerArchives(page.total, cards);
    const aiUsed = base.aiUsed;
    const aiNote = base.aiNote;
    return {
      content,
      payload: {
        ...base,
        kind: 'search',
        conditions,
        matched: true,
        total: page.total,
        shown: cards.length,
        items: cards,
        aiUsed,
        aiNote,
      },
    };
  }

  // ==================== 统一智能检索（第一批）====================

  /**
   * 统一检索：一次提问跨档案 / 附件 / 正文 / 分类多业务联合查询。
   * 本体只调度，四类检索均复用现有 Service/Repository；权限沿用现有五类角色矩阵与 ArchiveAccessService。
   * 无权限的档案/附件在 SQL 层即被过滤，绝不会因统一检索而泄露。
   */
  private async handleUnifiedSearch(
    intent: ParsedIntent,
    ctx: { question: string; operator: UserView; execution?: AgentToolExecution; model?: AiModelClient },
    base: AgentPayload,
  ): Promise<{ content: string; payload: AgentPayload }> {
    const execution = ctx.execution ?? await this.dispatcher.dispatch(intent, ctx.operator, ctx.question);
    const scopes = intent.scopes ?? ['archive', 'attachment', 'content', 'category', 'borrow', 'audit', 'template'];
    const empty = () => ({ total: 0, shown: 0, items: [] });
    const get = (id: string) => execution.results.find(r => r.callId === id);
    if (scopes.length === 1 && scopes.includes('attachment') && intent.title) {
      const candidates = execution.results.filter(r => (r.callId === 'archives' || r.callId?.startsWith('archives:page:')) && r.status === 'success')
        .flatMap(r => r.data.items as ArchiveView[]).filter(a => a.title === intent.title);
      if (candidates.length > 1) {
        const cards = candidates.slice(0, RESULT_CARD_LIMIT).map(a => this.toCard(a, ctx.operator));
        return { content: '找到多份同名档案。你要查看哪一份档案的附件？', payload: { ...base, kind: 'search',
          total: candidates.length, shown: cards.length, matched: true, items: cards,
          toolResults: execution.results, toolExecutionStatus: execution.status } };
      }
    }
    const group = (id: string) => {
      const r = get(id);
      return r?.status === 'success' ? { ...r.data, total: r.total, shown: r.data.items?.length ?? 0 } : empty();
    };
    const archiveGroup = scopes.includes('archive') ? group('archives') : empty();
    if (get('archives')?.pagination?.pageSize === 100) {
      const page = Number(ctx.question.match(/第\s*(\d+)\s*页/u)?.[1] ?? 1);
      const size = Number(ctx.question.match(/每页\s*(\d+)\s*条/u)?.[1] ?? RESULT_CARD_LIMIT);
      const pages = execution.results.filter(r => r.callId?.startsWith('archives:page:') && r.status === 'success')
        .sort((a, b) => (a.pagination?.page ?? 0) - (b.pagination?.page ?? 0));
      archiveGroup.items = [...archiveGroup.items, ...pages.flatMap(r => r.data.items)].slice((page - 1) * size, page * size);
    }
    const result: UnifiedSearchResult = {
      scopes, archives: archiveGroup, attachments: group('attachments'), contents: group('contents'), categories: group('categories'),
      degraded: !!get('contents')?.data?.degraded, totalHits: 0,
    };
    const business: UnifiedBusinessSearchResult = {
      borrowings: { scope: null, ...group('borrowings') }, audits: group('audits'), templates: group('templates'),
      statistics: get('statistics')?.status === 'success' ? get('statistics')!.data : null,
      restrictedScopes: [], totalHits: 0,
    };
    const ids: Record<string, SearchScope> = { archives: 'archive', attachments: 'attachment', contents: 'content', categories: 'category', borrowings: 'borrow', audits: 'audit', templates: 'template', statistics: 'stats' };
    for (const r of execution.results) {
      if (r.error?.code === '403' && ids[r.callId!] && scopes.includes(ids[r.callId!])) business.restrictedScopes.push({
        scope: ids[r.callId!], label: this.describeScopes([ids[r.callId!]]), reason: r.error.message,
      });
    }
    const unified = this.toUnifiedGroupsView(result, ctx.operator, business);
    const total = unified.archives.total + unified.attachments.total + unified.contents.total + unified.categories.total +
      unified.borrowings.total + unified.audits.total + unified.templates.total + (unified.statistics ? 1 : 0);
    const shown = unified.archives.shown + unified.attachments.shown + unified.contents.shown + unified.categories.shown +
      unified.borrowings.shown + unified.audits.shown + unified.templates.shown + (unified.statistics ? 1 : 0);
    const conditions: AgentSearchConditions = { keyword: intent.keyword, title: intent.title, archiveNo: intent.archiveNo,
      categoryName: intent.categoryName, status: intent.status };
    const failures = execution.results.filter(r => r.status !== 'success');
    const contentNotes: string[] = userReadableNotes(get('contents')?.data?.notes ?? []);
    const content = answerUnified(unified, execution);
    let synthesis = result.contents.items.length && ctx.model?.available
      ? await this.answerFromEvidence(buildEvidence(result.contents.items.filter((row): row is typeof row & EvidenceRow => !!row.chunkId && !!row.unitId)),[],
        {question:ctx.question,operator:ctx.operator,model:ctx.model,aiNote:null},{...base,unified,toolResults:execution.results}) : null;
    if(!synthesis && ctx.model?.available && total)
      synthesis=await this.answerUnifiedMetadata(unified,ctx.question,ctx.operator,ctx.model,{...base,unified,toolResults:execution.results});
    if(synthesis?.payload.kind==='error')return synthesis;
    return { content:synthesis?.content ?? content, payload: { ...base, kind: execution.status === 'error' ? 'error' : 'unified_search', intent: 'unified_search',
      conditions, matched: total > 0, total, shown, unified, contentNotes, toolResults: execution.results, toolExecutionStatus: execution.status,
      ...(synthesis ? {sources:synthesis.payload.sources,metadataSources:synthesis.payload.metadataSources,claims:synthesis.payload.claims,modelCall:synthesis.payload.modelCall,answerGeneration:synthesis.payload.answerGeneration,aiUsed:synthesis.payload.aiUsed,aiNote:synthesis.payload.aiNote} : {}),
      reason: failures.length ? failures.map(r => r.error?.message).join('；') : null } };
  }

  private async answerUnifiedMetadata(unified:AgentUnifiedGroups,question:string,operator:UserView,model:AiModelClient,base:AgentPayload) {
    const evidenceStarted=performance.now();
    const facts:NonNullable<AgentPayload['metadataSources']>=[];
    for(const row of unified.archives.items)facts.push({ref:'',kind:'archive',archiveId:row.id,label:row.title,
      excerpt:`档案名称：${row.title}；档号：${row.archiveNo}；分类：${row.categoryPath}；状态：${row.statusLabel}。`});
    for(const row of unified.attachments.items)facts.push({ref:'',kind:'attachment',archiveId:row.archiveId,fileId:row.fileId,label:row.fileName,
      excerpt:`所属档案：${row.archiveTitle}；档号：${row.archiveNo}；附件名称：${row.fileName}；版本：${row.versionNo===null?'上传原件':`第${row.versionNo}版`}。`});
    for(const row of unified.categories.items)facts.push({ref:'',kind:'category',label:row.name,excerpt:`分类名称：${row.name}；分类编码：${row.code}；可见档案数量：${row.archiveCount}。`});
    for (const [label, group] of [['借阅记录',unified.borrowings],['操作审计',unified.audits],['模板',unified.templates]] as const) {
      for (const row of group.items) facts.push({ref:'',kind:'business',label,excerpt:JSON.stringify(row)});
    }
    if (unified.statistics) facts.push({ref:'',kind:'business',label:'数据库统计',excerpt:JSON.stringify(unified.statistics)});
    const selected=facts.map((fact,i)=>({...fact,ref:`E${i+1}`}));
    recordStep('evidence',selected.length?'completed':'empty',selected.length,performance.now()-evidenceStarted);
    if(!selected.length)return null;
    // These are explicitly metadata facts, never attachment text or fabricated content locators.
    const evidence:EvidenceItem[]=selected.map(fact=>({ref:fact.ref,excerpt:fact.excerpt,row:{archiveTitle:fact.label,fileName:'目录元数据',fileId:fact.fileId??0} as EvidenceRow}));
    const safe=this.revalidateReply({content:'',payload:base},operator);if(safe.payload.kind==='error')return safe;
    try {
      recordStep('answer','running',0,0);
      const generated=await generateGroundedAnswer(model,question,evidence);
      const checked=this.revalidateReply({content:'',payload:base},operator);if(checked.payload.kind==='error')return checked;
      const verified=generated.verified;
      if(!verified?.valid){recordStep('answer','failed',0,0,'目录归纳未能完成，已保留真实检索结果');return {
        content:'本次 AI 归纳未能完成。'+answerFailureMessage[generated.state.failure??'call_failed']+'\n'+answerUnified(unified,{results:[],status:'success'} as unknown as AgentToolExecution),
        payload:{...base,aiUsed:false,aiNote:answerFailureMessage[generated.state.failure??'call_failed'],answerGeneration:generated.state}};}
      recordStep('answer','completed',verified.citations.length,0,'目录归纳和引用核验已完成');
      return {content:`以下归纳基于本轮已展示的目录检索结果：\n${verified.cleaned}`,payload:{...base,aiUsed:true,aiNote:null,claims:verified.claims,answerGeneration:generated.state,
        metadataSources:selected.filter(fact=>verified.citations.some(item=>item.ref===fact.ref))}};
    } catch (error) {
      if (isAgentCancelled(error)) throw error;
      return null;
    }
  }

  /** 将统一检索结果组装为分组视图（档案卡片复用目录检索的权限判定与详情入口）。 */
  private toUnifiedGroupsView(
    result: UnifiedSearchResult,
    operator: UserView,
    business: UnifiedBusinessSearchResult,
  ): AgentUnifiedGroups {
    const archiveItems: AgentArchiveCard[] = [];
    if (result.scopes.includes('archive')) {
      for (const hit of result.archives.items) {
        const detail = this.loadDetailForAgent(hit.id, operator);
        if (detail) archiveItems.push(this.toCard(detail, operator));
      }
    }
    const attachmentItems: AgentAttachmentCard[] = result.attachments.items.map((row) =>
      this.toAttachmentCard(row, operator),
    );
    const contentItems: AgentSource[] = result.contents.items.map((row, i) => ({
      ref: `E${i + 1}`,
      chunkId:row.chunkId,unitId:row.unitId,pageNo:row.pageNo,posFrom:row.posFrom,posTo:row.posTo,
      attachmentId:row.fileId,attachmentName:row.fileName,fileVersion:row.versionNo===null?'上传原件':`第 ${row.versionNo} 版`,
      archiveId: row.archiveId,
      archiveTitle: row.archiveTitle,
      archiveNo: row.archiveNo,
      fileId: row.fileId,
      fileName: row.fileName,
      versionNo: row.versionNo,
      locator: row.locator,
      excerpt: row.text.slice(0, 200),
      detailPath: `/archives/${row.archiveId}`,
    }));
    const categoryItems: AgentCategoryCard[] = result.categories.items.map((c) => ({
      id: c.id,
      name: c.name,
      code: c.code,
      pathCode: c.pathCode,
      depth: c.depth,
      archiveCount: c.archiveCount,
    }));
    return {
      scopes: result.scopes,
      archives: { total: result.archives.total, shown: archiveItems.length, items: archiveItems },
      attachments: { total: result.attachments.total, shown: attachmentItems.length, items: attachmentItems },
      contents: { total: result.contents.total, shown: contentItems.length, items: contentItems },
      categories: { total: result.categories.total, shown: categoryItems.length, items: categoryItems },
      borrowings: {
        total: business.borrowings.total,
        shown: business.borrowings.items.length,
        scope: business.borrowings.scope,
        items: this.toBorrowRecords(business.borrowings.items, operator),
      },
      audits: business.audits,
      templates: business.templates,
      statistics: business.statistics,
      restrictedScopes: business.restrictedScopes,
      degraded: result.degraded,
    };
  }

  /** 附件卡片：canOpenDetail 统一由现有访问控制复核（即使检索已过滤，也不依赖它作为安全控制）。 */
  private toAttachmentCard(row: FileSearchRow, operator: UserView): AgentAttachmentCard {
    return {
      fileId: row.fileId,
      fileName: row.fileName,
      extension: row.extension,
      fileSize: row.fileSize,
      archiveId: row.archiveId,
      archiveTitle: row.archiveTitle,
      archiveNo: row.archiveNo,
      versionNo: row.versionNo,
      versionCount: row.versionCount,
      uploadedByName: row.uploaderName,
      uploadedAt: row.uploadedAt,
      canOpenDetail: this.canOpenDetail(row.archiveId, operator),
      detailPath: `/archives/${row.archiveId}`,
    };
  }

  /** 生效范围描述（中文）。 */
  private describeScopes(scopes: SearchScope[]): string {
    const labels: Record<SearchScope, string> = {
      archive: '档案',
      attachment: '附件',
      content: '正文',
      category: '分类',
      borrow: '借阅记录',
      audit: '操作审计',
      template: '元数据模板',
      stats: '档案统计',
    };
    return scopes.map((s) => labels[s]).join(' / ');
  }

  /** 分组命中计数文案（只统计生效范围）。 */
  private describeUnifiedCounts(unified: AgentUnifiedGroups): string {
    const parts: string[] = [];
    if (unified.scopes.includes('archive')) parts.push(`档案 ${unified.archives.total} 条`);
    if (unified.scopes.includes('attachment')) parts.push(`附件 ${unified.attachments.total} 个`);
    if (unified.scopes.includes('content')) parts.push(`正文片段 ${unified.contents.total} 条`);
    if (unified.scopes.includes('category')) parts.push(`分类 ${unified.categories.total} 个`);
    if (unified.scopes.includes('borrow')) parts.push(`借阅记录 ${unified.borrowings.total} 条`);
    if (unified.scopes.includes('audit')) parts.push(`操作审计 ${unified.audits.total} 条`);
    if (unified.scopes.includes('template')) parts.push(`元数据模板 ${unified.templates.total} 个`);
    if (unified.scopes.includes('stats')) parts.push(unified.statistics ? `统计摘要 ${unified.statistics.rangeLabel}` : '统计摘要不可用');
    return parts.join('，');
  }

  // ==================== 第三阶段：智能借阅办理 / 借阅进度 / 辅助著录 ====================

  /**
   * 定位目标档案：一律通过现有检索接口拿真实 ID（绝不根据档案名称猜测 ID）。
   * 命中唯一 → 直接用它；命中多条 → 返回候选让用户确认；无命中 → 回退本会话上一轮结果。
   * allowBorrowCatalog：借阅场景专用兜底——受限档案不在常规检索可见范围内，
   * 但现有「借阅目录」正是无权查看者发起借阅申请的入口，因此仍按真实接口定位（只给目录级字段）。
   */
  private locateTargetArchive(
    intent: ParsedIntent,
    ctx: { operator: UserView; conversationId: number },
    opts: { allowBorrowCatalog?: boolean } = {},
  ): { archive: ArchiveView | null; candidates: ArchiveView[]; borrowEntry: BorrowCatalogItem | null } {
    const hasClue = !!(intent.archiveNo || intent.title || intent.keyword || intent.categoryId !== undefined);
    if (hasClue) {
      try {
        const items = this.tools.searchArchives(
          {
            keyword: intent.keyword,
            title: intent.title,
            archiveNo: intent.archiveNo,
            categoryId: intent.categoryId,
            status: intent.status,
          },
          ctx.operator,
          RESULT_CARD_LIMIT,
        );
        if (items.length === 1) return { archive: items[0], candidates: items, borrowEntry: null };
        if (items.length > 1) {
          // 只有档号/标题与某一条结果完全一致才算唯一命中，否则坚持让用户确认
          const exact = items.filter(
            (item) =>
              (intent.archiveNo !== undefined && item.archiveNo === intent.archiveNo) ||
              (intent.title !== undefined && item.title === intent.title),
          );
          if (exact.length === 1) return { archive: exact[0], candidates: items, borrowEntry: null };
          return { archive: null, candidates: items, borrowEntry: null };
        }
      } catch (err) {
        if (err instanceof HttpException) {
          console.warn(`[agent] 业务定位检索失败：${err.message}`);
        } else {
          console.error('[agent] 业务定位检索异常', err);
        }
      }
      // 常规检索无结果：借阅意图再查一次现有借阅目录（受限档案的正规发现入口）
      if (opts.allowBorrowCatalog) {
        const entries = this.tools.borrowCatalog(ctx.operator, {
          archiveNo: intent.archiveNo,
          keyword: intent.keyword ?? intent.title,
        });
        if (entries.length === 1) return { archive: null, candidates: [], borrowEntry: entries[0] };
        if (entries.length > 1) {
          const exact = intent.archiveNo
            ? entries.filter((item) => item.archiveNo === intent.archiveNo)
            : entries.filter((item) => intent.title !== undefined && item.title === intent.title);
          if (exact.length === 1) return { archive: null, candidates: [], borrowEntry: exact[0] };
        }
      }
    }
    // 没有档案线索或检索无结果：沿用本会话上一轮结果（支持「借阅这份合同」类指代）
    for (const id of this.scopeFromConversation(ctx.conversationId, 1)) {
      const detail = this.tools.archiveDetail(id, ctx.operator);
      if (detail) return { archive: detail, candidates: [detail], borrowEntry: null };
    }
    return { archive: null, candidates: [], borrowEntry: null };
  }

  /**
   * 功能一：智能借阅办理。
   * 真实检索定位 → 借阅资格检查（复用现有规则）→ 逐项收集真实必填字段 → 服务端落库待确认草稿。
   * 本方法人不提交任何数据：只有用户明确确认（executeDraft）才调现有借阅接口。
   */
  private handleBorrowApply(
    intent: ParsedIntent,
    ctx: { operator: UserView; conversationId: number },
    base: AgentPayload,
  ): { content: string; payload: AgentPayload } {
    const located = this.locateTargetArchive(intent, ctx, { allowBorrowCatalog: true });
    // 目标既可以是常规检索命中的可见档案，也可以是现有借阅目录里的受限档案（ID 均来自真实接口）
    const target = located.archive ?? located.borrowEntry;
    if (!target) {
      const cards = located.candidates
        .slice(0, RESULT_CARD_LIMIT)
        .map((item) => this.toCard(item, ctx.operator));
      const content = cards.length
        ? `找到 ${cards.length} 份与你描述相近的档案，请先确认要借阅哪一份（点卡片上的「申请借阅这一份」，或告诉我更完整的档号）。`
        : '还没法确定你要借阅哪一份档案。请描述档案标题或档号，例如「帮我申请借阅档号 WS-2026-000007」。';
      return {
        content,
        payload: {
          ...base,
          kind: 'target_ask',
          intent: 'borrow_apply',
          targetAsk: 'borrow',
          matched: cards.length > 0,
          total: cards.length,
          shown: cards.length,
          items: cards,
          reason: cards.length ? '存在多个候选档案，需用户选定' : '未能定位目标档案',
        },
      };
    }
    // 资格检查完全复用现有后端规则；无权限时给出真实原因，不给绕过入口
    const card = located.archive ? this.toCard(located.archive, ctx.operator) : null;
    const eligibility = this.tools.borrowEligibility(target.id, ctx.operator);
    if (!eligibility.allowed) {
      const lines = eligibility.reasons.map((r) => `· ${r}`).join('\n');
      const content =
        `这份档案现在不能由我代为发起借阅申请：\n${lines}` +
        (eligibility.pendingRequestId
          ? `\n可以回复「查一下我的借阅进度」查看申请 #${eligibility.pendingRequestId} 的审核状态。`
          : '');
      return {
        content,
        payload: {
          ...base,
          kind: 'borrow_denied',
          intent: 'borrow_apply',
          reason: eligibility.reasons[0] ?? '不满足现有借阅规则',
          notices: eligibility.notices,
          matched: true,
          total: card ? 1 : 0,
          shown: card ? 1 : 0,
          items: card ? [card] : [],
        },
      };
    }

    // 同一会话 + 同一档案：复用已有待确认草稿（不产生第二份草稿，避免重复申请）
    const latest = this.pendingRepo.findLatestPending(ctx.operator.id, ctx.conversationId);
    const sameDraft =
      latest && latest.tool === AGENT_PENDING_TOOL.BORROW_REQUEST
        ? (parseDraftJson<BorrowDraftPayload>(latest.payloadJson)?.archiveId === target.id ? latest : null)
        : null;
    const saved = sameDraft ? parseDraftJson<BorrowDraftPayload>(sameDraft.payloadJson) : null;
    const payload: BorrowDraftPayload = {
      archiveId: target.id,
      archiveTitle: target.title,
      archiveNo: target.archiveNo,
      purpose: String(intent.purpose ?? saved?.purpose ?? '').trim().slice(0, MAX_BORROW_PURPOSE_LENGTH),
      days: intent.days ?? saved?.days ?? null,
      applicantName: ctx.operator.displayName || ctx.operator.username,
      applicantRoleLabel: ctx.operator.roleLabel,
      createdAt: saved?.createdAt ?? new Date().toISOString(),
    };
    let row = sameDraft;
    if (row) {
      this.pendingRepo.updatePayload(row.id, JSON.stringify(payload));
      row = { ...row, payloadJson: JSON.stringify(payload) };
    } else {
      // 会话内其他未确认草稿（目标档案不同）先作废，确保「确认」只指向当前这一份
      if (latest) this.pendingRepo.discard(latest.id);
      row = this.pendingRepo.insert({
        conversationId: ctx.conversationId,
        userId: ctx.operator.id,
        tool: AGENT_PENDING_TOOL.BORROW_REQUEST,
        payload,
      });
    }
    return this.borrowDraftReply(row, located.archive, ctx.operator, eligibility.notices);
  }

  /**
   * 借阅草稿回复：未补齐真实必填字段时逐项询问（不一次展示复杂表单）；
   * 字段齐备时展示完整申请内容，等用户点「确认提交」（本方法不写任何业务数据）。
   */
  private borrowDraftReply(
    row: AgentPendingActionRow,
    archive: ArchiveView | null,
    operator: UserView,
    notices: string[] = [],
    extraHint: string | null = null,
  ): { content: string; payload: AgentPayload } {
    const data = parseDraftJson<BorrowDraftPayload>(row.payloadJson);
    if (!data) {
      return {
        content: '待确认的借阅内容已损坏，请重新发起申请。',
        payload: { kind: 'error', intent: 'borrow_apply', conditions: {}, matched: false, total: 0, shown: 0, items: [], aiUsed: false, aiNote: null, reason: '借阅草稿内容不可解析' },
      };
    }
    const missing: string[] = [];
    if (!data.purpose) missing.push('purpose');
    if (!data.days) missing.push('days');
    const card = archive ? this.toCard(archive, operator) : null;
    const draftView: AgentBorrowDraftView = {
      token: row.token,
      status: 'pending',
      archiveId: data.archiveId,
      archiveTitle: data.archiveTitle,
      archiveNo: data.archiveNo,
      purpose: data.purpose || null,
      days: data.days ?? null,
      applicantName: data.applicantName,
      applicantRoleLabel: data.applicantRoleLabel,
      missing,
      createdAt: data.createdAt,
    };
    const head = `待借阅档案：《${data.archiveTitle}》（档号 ${data.archiveNo}）`;
    const noticeLines = notices.length ? `\n${notices.map((n) => `· ${n}`).join('\n')}` : '';
    const content = missing.length
      ? `${head}。${extraHint ?? ''}\n` +
        (data.purpose
          ? '还差借阅期限：请告知天数（1-90 天，例如「30 天」）。'
          : '请告诉我借阅用途（例如「用于项目审查」）。') +
        noticeLines
      : `${head}\n申请人：${data.applicantName}（${data.applicantRoleLabel}）\n` +
        `借阅用途：${data.purpose}\n借阅期限：${data.days} 天\n` +
        '以下内容与上述完全一致，需你点击下方「确认提交」后才会真正提交申请。' +
        noticeLines;
    return {
      content,
      payload: {
        kind: missing.length ? 'borrow_collect' : 'borrow_confirm',
        intent: 'borrow_apply',
        conditions: {},
        matched: true,
        total: card ? 1 : 0,
        shown: card ? 1 : 0,
        items: card ? [card] : [],
        aiUsed: false,
        aiNote: null,
        reason: missing.length ? `待补齐：${missing.join('、')}` : null,
        borrowDraft: draftView,
        notices,
      },
    };
  }

  /** 功能二：借阅进度/记录查询（数据范围由现有角色权限裁决，不接受任何 userId 入参）。 */
  private async handleBorrowProgress(
    intent: ParsedIntent,
    ctx: { operator: UserView; question?: string },
    base: AgentPayload,
  ): Promise<{ content: string; payload: AgentPayload }> {
    const execution = await this.dispatcher.dispatch(intent, ctx.operator, ctx.question);
    base.toolResults = execution.results;
    base.toolExecutionStatus = execution.status;
    const found = execution.results[0];
    const result = { allowed: found.status === 'success', deniedReason: found.error?.message ?? null,
      scope: found.data?.scope ?? (hasPermission(ctx.operator.role, 'borrowReview') ? intent.dataScope ?? 'mine' : 'mine'), items: found.data?.items ?? [], total: found.total };
    if (!result.allowed) {
      return {
        content: `没能查询借阅记录：${result.deniedReason ?? '当前账号无借阅业务权限'}\n如需查看本人记录，可直接说「查我的借阅记录」。`,
        payload: {
          ...base,
          kind: 'borrow_progress',
          intent: 'borrow_progress',
          reason: result.deniedReason,
          borrowScope: result.scope,
          borrowRecords: [],
        },
      };
    }
    const records = this.toBorrowRecords(result.items, ctx.operator);
    const scopeLine =
      result.scope === 'review' ? '以下是审核视角的借阅申请（仅你有 borrowReview 权限时可见）：' : '以下是你本人的借阅申请：';
    const content = records.length
      ? `${scopeLine}\n共 ${result.total} 条符合条件的记录，展示前 ${records.length} 条：\n` +
        records
          .map(
            (r, i) =>
              `${i + 1}. 《${r.archiveTitle}》（档号 ${r.archiveNo}）· ${r.statusLabel} · 用途「${r.purpose}」` +
              (r.reviewNote ? ` · 审核意见「${r.reviewNote}」` : '') +
              (r.reviewerName ? ` · 审核人 ${r.reviewerName}` : ''),
          )
          .join('\n') +
        '\n时间与详细审核结果见下方卡片，点击可进入对应档案详情。'
      : `${scopeLine}\n没有找到符合条件的借阅记录。可以换个档案名称、去掉状态筛选，或到「我的借阅」页面查看全部记录。`;
    return {
      content,
      payload: {
        ...base,
        kind: 'borrow_progress',
        intent: 'borrow_progress',
        matched: records.length > 0,
        total: result.total,
        shown: records.length,
        borrowScope: result.scope,
        borrowRecords: records,
        reason: records.length ? null : '未查到借阅记录',
      },
    };
  }

  // ==================== 第三阶段（续）：辅助著录 / 确认执行 / 防重复提交 ====================

  /**
   * 功能三：智能辅助档案著录。
   * 只读当前用户有权访问的已索引正文 → 按系统真实字段清单抽取（带原文依据）→ 预览
   * → 用户确认后才调现有创建/编辑接口。
   * 已归档档案不进入 update 路径（现有 updateArchive 自身也会拒绝），改为新建草稿或仅展示建议。
   */
  private handleCatalogSuggest(
    intent: ParsedIntent,
    ctx: { operator: UserView; conversationId: number },
    base: AgentPayload,
  ): { content: string; payload: AgentPayload } {
    const located = this.locateTargetArchive(intent, ctx);
    if (!located.archive) {
      const cards = located.candidates
        .slice(0, RESULT_CARD_LIMIT)
        .map((item) => this.toCard(item, ctx.operator));
      return {
        content: cards.length
          ? `先确认要整理哪一份档案的著录信息（共 ${cards.length} 份相近结果），点击卡片上的「辅助著录这一份」，或补充更完整的档号。`
          : '要先确定具体是哪一份档案，我才能读取它的附件正文并整理著录信息。请告诉我档案标题或档号。',
        payload: {
          ...base,
          kind: 'target_ask',
          intent: 'catalog_suggest',
          targetAsk: 'catalog',
          matched: cards.length > 0,
          total: cards.length,
          shown: cards.length,
          items: cards,
          reason: '需先确定目标档案',
        },
      };
    }
    const archive = located.archive;
    const detail = this.tools.archiveDetail(archive.id, ctx.operator);
    if (!detail) {
      return {
        content:
          `《${archive.title}》是受限档案，你当前没有查看正文的权限，因此我不会去读取它的附件正文，` +
          '也不会根据文件名猜测合同信息。可先发起借阅申请，审核通过后再让我帮你整理。',
        payload: {
          ...base,
          kind: 'content_no_evidence',
          intent: 'catalog_suggest',
          matched: true,
          total: 1,
          shown: 1,
          items: [this.toCard(archive, ctx.operator)],
          contentNotes: ['未获得正文访问权限，未作任何提取。'],
          reason: '无该档案正文访问权限',
        },
      };
    }

    const specs = this.tools.catalogFieldSpecs(detail.categoryId);
    const rows: EvidenceRow[] = this.tools.readContent([detail.id], ctx.operator, 24);
    const sources: ExtractSource[] = rows.map((row, i) => ({
      ref: `E${i + 1}`,
      locator: row.locator,
      text: row.text,
    }));
    const extraction = extractCatalogFields(specs, sources);
    const current = this.tools.currentCatalog(detail.id, ctx.operator);
    const fields: AgentCatalogFieldView[] = extraction.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      fixed: f.fixed,
      required: f.required,
      value: f.value,
      hasValue: f.hasValue,
      evidenceRef: f.evidenceRef,
      evidenceText: f.evidenceText,
      locator: f.locator,
      original: originalCatalogValue(current, f),
    }));
    const unmapped = extraction.unmapped.map((f) => ({
      label: f.label,
      value: f.value,
      evidenceRef: f.evidenceRef,
      evidenceText: f.evidenceText,
      locator: f.locator,
    }));
    const notes = [...extraction.notes];
    const foundCount = fields.filter((f) => f.hasValue).length;
    const card = this.toCard(detail, ctx.operator);

    if (!sources.length || foundCount === 0) {
      if (sources.length && !foundCount) {
        notes.push('已阅段正文里没有可核对的字段值，建议字段全部保持为空（不会编造，也不会按文件名猜测）。');
      }
      return {
        content:
          `没能从《${detail.title}》的现有资料中找到足以支持著录的字段信息。请补充相关资料后再试。`,
        payload: {
          ...base,
          kind: 'content_no_evidence',
          intent: 'catalog_suggest',
          matched: false,
          total: 0,
          shown: 0,
          items: [card],
          sources: rows.map((row, i) => this.evidenceToSource(row, `E${i + 1}`)),
          contentNotes: notes,
          reason: '未提取到带原文依据的字段值',
        },
      };
    }

    const editable = this.tools.canEditArchive(detail.id, ctx.operator);
    const canManage = hasPermission(ctx.operator.role, 'archiveManage');
    const mode: 'create' | 'update' | null = editable.editable ? 'update' : canManage ? 'create' : null;
    const titleValue = fields.find((f) => f.key === 'title')?.value ?? '';

    // 无著录权限（借阅者/访客）：只展示建议，不建可执行草稿，不写任何数据
    if (!mode) {
      notes.push('本次仅展示建议值，未写入任何数据。');
      return {
        content:
          `已从正文里整理出 ${foundCount} 个建议字段（均附原文依据）。` +
          `${editable.reason ?? '当前角色没有档案著录权限'}，因此本次不会写入任何数据，可将下列内容交由著录员录入。`,
        payload: {
          ...base,
          kind: 'catalog_preview',
          intent: 'catalog_suggest',
          matched: true,
          total: foundCount,
          shown: foundCount,
          items: [card],
          sources: rows.map((row, i) => this.evidenceToSource(row, `E${i + 1}`)),
          catalogDraft: {
            token: null,
            status: 'none',
            mode: 'update',
            archiveId: detail.id,
            archiveTitle: detail.title,
            archiveNo: detail.archiveNo,
            categoryId: detail.categoryId,
            categoryName: detail.categoryName,
            fields,
            unmapped,
            missingRequired: [],
            notes,
            canSave: false,
            saveBlockedReason: editable.reason ?? '当前角色无档案著录权限',
            createdAt: new Date().toISOString(),
          },
        },
      };
    }

    if (mode === 'update') {
      notes.push('确认后将编辑该档案的著录信息；字段长度/格式/必填校验与页面录入完全一致。');
    } else {
      notes.push('该档案已归档或你不具备它的编辑权限，因此确认后将新建一份草稿档案，不会覆盖原档案。');
    }

    // 会话内旧的未确认草稿先作废（避免「确认提交」指向哪一份产生歧义）
    const stale = this.pendingRepo.findLatestPending(ctx.operator.id, ctx.conversationId);
    if (stale) {
      this.pendingRepo.discard(stale.id);
      notes.push(
        stale.tool === AGENT_PENDING_TOOL.BORROW_REQUEST
          ? '已作废此前未确认的借阅草稿，避免确认时产生歧义。'
          : '已作废此前未确认的著录草稿。',
      );
    }
    const payloadDraft: CatalogDraftPayload = {
      mode,
      archiveId: mode === 'update' ? detail.id : null,
      archiveTitle: mode === 'update' ? detail.title : titleValue,
      archiveNo: detail.archiveNo,
      categoryId: detail.categoryId,
      categoryName: detail.categoryName,
      fields,
      unmapped,
      notes,
      createdAt: new Date().toISOString(),
    };
    const row = this.pendingRepo.insert({
      conversationId: ctx.conversationId,
      userId: ctx.operator.id,
      tool: AGENT_PENDING_TOOL.ARCHIVE_CATALOG_SAVE,
      payload: payloadDraft,
    });
    const missingRequired = fields
      .filter((f) => (f.key === 'title' || f.required) && !(f.value || f.original))
      .map((f) => f.label);
    return {
      content:
        `已从《${detail.title}》的已索引正文里整理出 ${foundCount} 个建议字段（未识别的保持为空）。` +
        (mode === 'update' ? '以下为待确认的编辑内容：' : '以下为待确认的新建草稿档案内容：') +
        (missingRequired.length ? `\n还需补充：${missingRequired.join('、')}。` : '') +
        '\n你可以先修改字段值，确认保存后才会写入系统。' +
        `${notes.map((n) => `\n· ${n}`).join('')}`,
      payload: {
        ...base,
        kind: 'catalog_preview',
        intent: 'catalog_suggest',
        matched: true,
        total: foundCount,
        shown: foundCount,
        items: [card],
        sources: rows.map((row, i) => this.evidenceToSource(row, `E${i + 1}`)),
        notices: notes,
        catalogDraft: this.toCatalogDraftView(row, 'pending', payloadDraft, missingRequired, true, null),
      },
    };
  }

  /** 来源片段 → 可核验来源卡片（辅助著录不写入模型，但给用户回查原文位）。 */
  private evidenceToSource(row: EvidenceRow, ref: string): AgentSource {
    return {
      ref,
      archiveId: row.archiveId,
      archiveTitle: row.archiveTitle,
      archiveNo: row.archiveNo,
      fileId: row.fileId,
      fileName: row.fileName,
      versionNo: row.versionNo,
      locator: row.locator,
      excerpt: row.text.slice(0, 200),
      detailPath: `/archives/${row.archiveId}`,
    };
  }

  private toCatalogDraftView(
    row: AgentPendingActionRow,
    status: AgentCatalogDraftView['status'],
    data: CatalogDraftPayload,
    missingRequired: string[],
    canSave: boolean,
    blockedReason: string | null,
  ): AgentCatalogDraftView {
    return {
      token: row.token,
      status,
      mode: data.mode,
      archiveId: data.archiveId,
      archiveTitle: data.archiveTitle,
      archiveNo: data.archiveNo,
      categoryId: data.categoryId,
      categoryName: data.categoryName,
      fields: data.fields,
      unmapped: data.unmapped,
      missingRequired,
      notes: data.notes,
      canSave,
      saveBlockedReason: blockedReason,
      createdAt: data.createdAt,
    };
  }

  /**
   * 待确认草稿的文本续答：确认 / 取消 / 逐项补齐。
   * 只在「真的在回应该草稿」时接管对话，否则返回 null 走常规意图解析（不会阻断新话题）。
   */
  private tryHandleDraftText(
    draft: AgentPendingActionRow,
    question: string,
    operator: UserView,
    conversationId: number,
  ): { content: string; payload: AgentPayload } | null {
    if (CONFIRM_TEXT_RE.test(question)) {
      return this.executeDraft(draft, operator, conversationId, null);
    }
    if (CANCEL_TEXT_RE.test(question)) {
      return this.cancelDraft(draft, operator, conversationId);
    }
    if (draft.tool !== AGENT_PENDING_TOOL.BORROW_REQUEST) return null;
    const data = parseDraftJson<BorrowDraftPayload>(draft.payloadJson);
    if (!data) return null;
    let changed = false;
    if (!data.purpose) {
      const hit = extractBorrowPurpose(question);
      // 用户直接以裸文本回答用途（如「项目审查」）时也要能接住；
      // 但明显是在开新话题（查询/借阅/问进度…）时不接管，避免误拿检索词当用途。
      const looksLikeNewTopic =
        /(查找|检索|搜索|借阅|申请|进度|取消|确认|档案|如何|怎么|为什么|哪些|请问|帮我)/.test(question);
      const bareAnswer =
        !hit && !looksLikeNewTopic && question.length >= 2 && question.length <= 40 ? question : null;
      const value = hit ?? bareAnswer;
      if (value) {
        data.purpose = value.trim().slice(0, MAX_BORROW_PURPOSE_LENGTH);
        changed = true;
      }
    }
    if (!data.days) {
      const hit = extractBorrowDays(question);
      if (hit) {
        data.days = hit;
        changed = true;
      }
    }
    if (!changed) return null;
    this.pendingRepo.updatePayload(draft.id, JSON.stringify(data));
    const row: AgentPendingActionRow = { ...draft, payloadJson: JSON.stringify(data) };
    const archive = this.tools.archiveDetail(data.archiveId, operator);
    return this.borrowDraftReply(row, archive, operator, archive ? this.noticesForEligibility(data.archiveId, operator) : []);
  }

  /** 资格提示（不阻断）：每次回复都重新取，避免用上一轮的旧结论。 */
  private noticesForEligibility(archiveId: number, operator: UserView): string[] {
    try {
      return this.tools.borrowEligibility(archiveId, operator).notices;
    } catch {
      return [];
    }
  }

  /** 确认执行入口：只从服务端草稿取内容与目标 ID，执行前重新做权限与业务复核。 */
  private executeDraft(
    draft: AgentPendingActionRow,
    operator: UserView,
    conversationId: number,
    values: Record<string, string> | null,
  ): { content: string; payload: AgentPayload } {
    if (draft.status !== 'pending') return this.replayDraft(draft, operator, conversationId);
    if (draft.tool === AGENT_PENDING_TOOL.BORROW_REQUEST) {
      return this.executeBorrowDraft(draft, operator, conversationId, values);
    }
    return this.executeCatalogDraft(draft, operator, conversationId, values);
  }

  /** 执行借阅申请：调用现有借阅接口（其内部再校一次用途/期限/重复申请并写借阅审计）。 */
  private executeBorrowDraft(
    draft: AgentPendingActionRow,
    operator: UserView,
    conversationId: number,
    values: Record<string, string> | null,
  ): { content: string; payload: AgentPayload } {
    const data = parseDraftJson<BorrowDraftPayload>(draft.payloadJson);
    if (!data) {
      return this.failedAction(AGENT_TOOL.BORROW_REQUEST_CREATE, '待确认的借阅内容已损坏，请重新发起申请。');
    }
    // 用户可在确认卡上修正的只有 purpose / days；档案 ID 一律以服务端草稿为准
    if (values) {
      if (values.purpose !== undefined) {
        data.purpose = String(values.purpose).trim().slice(0, MAX_BORROW_PURPOSE_LENGTH);
      }
      if (values.days !== undefined && values.days !== '') {
        const n = Number(values.days);
        if (Number.isInteger(n) && n >= 1 && n <= MAX_BORROW_DAYS) data.days = n;
      }
    }
    const missing: string[] = [];
    if (!data.purpose) missing.push('purpose');
    if (!data.days) missing.push('days');
    if (missing.length) {
      // 未补齐现有接口的真实必填字段：不执行任何写操作
      const archive = this.tools.archiveDetail(data.archiveId, operator);
      return this.borrowDraftReply(
        { ...draft, payloadJson: JSON.stringify(data) },
        archive,
        operator,
        this.noticesForEligibility(data.archiveId, operator),
        '还不能提交：',
      );
    }
    const eligibility = this.tools.borrowEligibility(data.archiveId, operator);
    if (!eligibility.allowed) {
      return {
        content: `本次不能提交借阅申请：\n${eligibility.reasons.map((r) => `· ${r}`).join('\n')}`,
        payload: {
          kind: 'borrow_denied',
          intent: 'borrow_apply',
          conditions: {},
          matched: true,
          total: 1,
          shown: 1,
          items: [],
          aiUsed: false,
          aiNote: null,
          reason: eligibility.reasons[0] ?? '不满足现有借阅规则',
          notices: eligibility.notices,
        },
      };
    }
    this.pendingRepo.updatePayload(draft.id, JSON.stringify(data));
    // 条件抢占：抢不到说明已有其他提交在处理/已处理 → 不重复调业务接口
    if (!this.pendingRepo.claim(draft.id)) {
      const fresh = this.pendingRepo.find(draft.token, operator.id, conversationId);
      return this.replayDraft(fresh ?? draft, operator, conversationId);
    }
    try {
      const created = this.tools.createBorrowRequest(
        { archiveId: data.archiveId, purpose: data.purpose, days: data.days as number },
        operator,
      );
      this.pendingRepo.finalize(draft.id, 'executed', JSON.stringify(created), '');
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.AGENT_TOOL_EXECUTE,
        AUDIT_OBJECT.BORROW,
        created.id,
        {
          tool: AGENT_TOOL.BORROW_REQUEST_CREATE,
          aiAssisted: true,
          conversationId,
          pendingId: draft.id,
          archiveId: data.archiveId,
          archiveNo: created.archiveNo,
          title: created.archiveTitle,
          days: created.days,
        },
      );
      return this.actionSuccess(created, data, operator);
    } catch (err) {
      const message = describeToolError(err);
      this.pendingRepo.finalize(draft.id, 'failed', null, message);
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.AGENT_TOOL_EXECUTE,
        AUDIT_OBJECT.BORROW,
        draft.id,
        {
          tool: AGENT_TOOL.BORROW_REQUEST_CREATE,
          aiAssisted: true,
          conversationId,
          archiveId: data.archiveId,
          archiveNo: data.archiveNo,
          error: message,
        },
        'failure',
      );
      // 接口未成功绝不说「已提交」：如实回显失败原因
      return this.failedAction(AGENT_TOOL.BORROW_REQUEST_CREATE, `借阅申请未能提交：${message}`);
    }
  }

  /** 执行辅助著录保存：走现有创建/编辑接口，因此归档只读、创建者归属、字段校验全部继续生效。 */
  private executeCatalogDraft(
    draft: AgentPendingActionRow,
    operator: UserView,
    conversationId: number,
    values: Record<string, string> | null,
  ): { content: string; payload: AgentPayload } {
    const data = parseDraftJson<CatalogDraftPayload>(draft.payloadJson);
    if (!data) {
      return this.failedAction(AGENT_TOOL.ARCHIVE_CATALOG_SAVE, '待确认的著录内容已损坏，请重新发起。');
    }
    // 只允许用户修改「字段值」；模式、目标档案 ID、分类 ID 定自服务端草稿，外部无法改写
    if (values) {
      const byKey = new Map(data.fields.map((f) => [f.key, f]));
      for (const [key, raw] of Object.entries(values)) {
        const field = byKey.get(key);
        if (!field) continue;
        const text = raw === null || raw === undefined ? '' : String(raw).trim();
        field.value = text;
        field.hasValue = !!text;
      }
    }
    const missingRequired = data.fields
      .filter((f) => (f.key === 'title' || f.required) && !(f.value || f.original))
      .map((f) => f.label);
    if (missingRequired.length) {
      const card = data.archiveId ? this.loadDetailForAgent(data.archiveId, operator) : null;
      return {
        content: `还不能保存：以下字段为必填但仍为空——${missingRequired.join('、')}。`,
        payload: {
          kind: 'catalog_preview',
          intent: 'catalog_suggest',
          conditions: {},
          matched: true,
          total: data.fields.filter((f) => f.hasValue).length,
          shown: 0,
          items: card ? [this.toCard(card, operator)] : [],
          aiUsed: false,
          aiNote: null,
          reason: `必填字段缺失：${missingRequired.join('、')}`,
          catalogDraft: this.toCatalogDraftView(draft, 'pending', data, missingRequired, true, null),
        },
      };
    }
    this.pendingRepo.updatePayload(draft.id, JSON.stringify(data));
    if (!this.pendingRepo.claim(draft.id)) {
      const fresh = this.pendingRepo.find(draft.token, operator.id, conversationId);
      return this.replayDraft(fresh ?? draft, operator, conversationId);
    }
    try {
      const values2: Record<string, string> = {};
      for (const f of data.fields) {
        // 未识别的字段保持为空，但绝不用空值覆盖现有著录值（避免辅助著录反向清空元数据）
        const value = f.value || f.original;
        if (value) values2[f.key] = value;
      }
      const saved = this.tools.saveCatalog(
        {
          mode: data.mode,
          archiveId: data.archiveId,
          categoryId: data.categoryId,
          values: values2,
        },
        operator,
      );
      this.pendingRepo.finalize(draft.id, 'executed', JSON.stringify(saved), '');
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.AGENT_TOOL_EXECUTE,
        AUDIT_OBJECT.ARCHIVE,
        saved.id,
        {
          tool: AGENT_TOOL.ARCHIVE_CATALOG_SAVE,
          aiAssisted: true,
          conversationId,
          pendingId: draft.id,
          mode: data.mode,
          title: saved.title,
          archiveNo: saved.archiveNo,
          categoryId: data.categoryId,
        },
      );
      return {
        content:
          (data.mode === 'update'
            ? `已保存《${saved.title}》的著录信息（档号 ${saved.archiveNo}，状态：${saved.statusLabel}）。`
            : `已新建草稿档案《${saved.title}》（档号 ${saved.archiveNo}）。`)
          + (data.mode === 'create'
              ? '新档案为草稿状态，可继续上传附件、校对著录项，归档后会自动只读。'
              : '归档只读与字段校验仍按现有规则生效。'),
        payload: {
          kind: 'action_result',
          intent: 'catalog_suggest',
          conditions: {},
          matched: true,
          total: 1,
          shown: 1,
          items: [this.toCard(saved, operator)],
          aiUsed: false,
          aiNote: null,
          reason: null,
          action: {
            tool: AGENT_TOOL.ARCHIVE_CATALOG_SAVE,
            ok: true,
            message:
              data.mode === 'update' ? '著录信息已保存至现有档案。' : '已按确认内容创建草稿档案。',
            nextStep: data.mode === 'create' ? '后续可在档案详情页上传附件并提交归档（归档由人工完成）。' : null,
            archive: {
              id: saved.id,
              title: saved.title,
              archiveNo: saved.archiveNo,
              statusLabel: saved.statusLabel,
              detailPath: `/archives/${saved.id}`,
            },
          },
        },
      };
    } catch (err) {
      const message = describeToolError(err);
      this.pendingRepo.finalize(draft.id, 'failed', null, message);
      this.audit.record(
        { id: operator.id, role: operator.role, ip: null },
        AUDIT_ACTION.AGENT_TOOL_EXECUTE,
        AUDIT_OBJECT.ARCHIVE,
        draft.id,
        {
          tool: AGENT_TOOL.ARCHIVE_CATALOG_SAVE,
          aiAssisted: true,
          conversationId,
          mode: data.mode,
          archiveId: data.archiveId,
          error: message,
        },
        'failure',
      );
      return this.failedAction(AGENT_TOOL.ARCHIVE_CATALOG_SAVE, `著录信息未能保存：${message}`);
    }
  }

  /** 取消确认：只作废服务端草稿，不调用任何业务接口。 */
  private cancelDraft(
    draft: AgentPendingActionRow,
    operator: UserView,
    conversationId: number,
  ): { content: string; payload: AgentPayload } {
    if (draft.status !== 'pending') {
      return this.replayDraft(draft, operator, conversationId);
    }
    this.pendingRepo.discard(draft.id);
    const label = draft.tool === AGENT_PENDING_TOOL.BORROW_REQUEST ? '借阅申请' : '著录保存';
    this.audit.record(
      { id: operator.id, role: operator.role, ip: null },
      AUDIT_ACTION.AGENT_TOOL_EXECUTE,
      draft.tool === AGENT_PENDING_TOOL.BORROW_REQUEST ? AUDIT_OBJECT.BORROW : AUDIT_OBJECT.ARCHIVE,
      draft.id,
      { tool: draft.tool, aiAssisted: true, conversationId, outcome: 'cancelled', action: 'cancel' },
    );
    return {
      content: `已取消本次${label}草稿，没有向系统提交任何数据。需要时可重新发起。`,
      payload: {
        kind: 'action_result',
        intent: draft.tool === AGENT_PENDING_TOOL.BORROW_REQUEST ? 'borrow_apply' : 'catalog_suggest',
        conditions: {},
        matched: false,
        total: 0,
        shown: 0,
        items: [],
        aiUsed: false,
        aiNote: null,
        reason: '用户取消',
        action: {
          tool: draft.tool,
          ok: false,
          message: `本次${label}已取消，未产生任何业务数据。`,
          nextStep: null,
        },
      },
    };
  }

  /**
   * 非 pending 草稿的回显：绝不重复调业务接口，只把已有真实结果回给用户。
   * 这是防「重复点击造成重复申请」的第二道防线（第一道是 claim 条件更新）。
   */
  private replayDraft(
    draft: AgentPendingActionRow,
    operator: UserView,
    conversationId: number,
  ): { content: string; payload: AgentPayload } {
    const base = {
      kind: 'action_result' as AgentReplyKind,
      intent: draft.tool === AGENT_PENDING_TOOL.BORROW_REQUEST ? 'borrow_apply' : 'catalog_suggest',
      conditions: {} as AgentSearchConditions,
      matched: true,
      total: 0,
      shown: 0,
      items: [] as AgentArchiveCard[],
      aiUsed: false,
      aiNote: null,
      reason: null as string | null,
    };
    if (draft.status === 'executed') {
      if (draft.tool === AGENT_PENDING_TOOL.BORROW_REQUEST) {
        const created = parseDraftJson<BorrowRequestView>(draft.resultJson);
        if (created) {
          return {
            content: `该借阅申请此前已提交成功（申请编号 #${created.id}，状态「${created.statusLabel}」），本次未重复提交。`,
            payload: {
              ...base,
              borrowRecords: this.toBorrowRecords([created], operator),
              borrowScope: 'mine',
              action: {
                tool: draft.tool,
                ok: true,
                replayed: true,
                message: '申请此前已提交，未重复提交。',
                nextStep: BORROW_NEXT_STEP,
                borrow: this.toBorrowRecord(created, operator),
              },
            },
          };
        }
      }
      const saved = parseDraftJson<ArchiveView>(draft.resultJson);
      if (saved) {
        return {
          content: `该著录信息此前已保存（《${saved.title}》，档号 ${saved.archiveNo}），本次未重复写入。`,
          payload: {
            ...base,
            items: [this.toCard(saved, operator)],
            action: {
              tool: draft.tool,
              ok: true,
              replayed: true,
              message: '此前已保存，未重复写入。',
              nextStep: null,
              archive: {
                id: saved.id,
                title: saved.title,
                archiveNo: saved.archiveNo,
                statusLabel: saved.statusLabel,
                detailPath: `/archives/${saved.id}`,
              },
            },
          },
        };
      }
      return {
        content: '该操作此前已完成，本次未重复提交。',
        payload: { ...base, action: { tool: draft.tool, ok: true, replayed: true, message: '此前已完成。', nextStep: null } },
      };
    }
    if (draft.status === 'running') {
      return {
        content: '上一次提交仍在处理中，请稍后在借阅记录/档案列表里确认结果，不要重复提交。',
        payload: { ...base, matched: false, action: { tool: draft.tool, ok: false, message: '上一次提交仍在处理中。', nextStep: null } },
      };
    }
    if (draft.status === 'failed') {
      return {
        content: `此前的提交未成功：${draft.error || '业务服务拒绝了本次操作'}。请重新发起申请。`,
        payload: {
          ...base,
          matched: false,
          reason: draft.error || '上次执行失败',
          action: { tool: draft.tool, ok: false, message: '此前提交未成功。', nextStep: '请重新发起。' },
        },
      };
    }
    return {
      content: '该草稿已取消，未提交任何数据。需要时可重新发起。',
      payload: { ...base, matched: false, reason: '已取消', action: { tool: draft.tool, ok: false, message: '草稿已取消。', nextStep: null } },
    };
  }

  /** 借阅提交成功的回复（完全使用真实接口响应，不自编状态与编号）。 */
  private actionSuccess(
    created: BorrowRequestView,
    data: BorrowDraftPayload,
    operator: UserView,
  ): { content: string; payload: AgentPayload } {
    const record = this.toBorrowRecord(created, operator);
    return {
      content:
        `借阅申请已提交成功。\n` +
        `档案：《${data.archiveTitle}》（档号 ${data.archiveNo}）\n` +
        `申请人：${data.applicantName}（${data.applicantRoleLabel}）\n` +
        `借阅用途：${data.purpose}\n借阅期限：${data.days} 天\n` +
        `申请编号：#${created.id}　当前状态：${created.statusLabel}\n${BORROW_NEXT_STEP}`,
      payload: {
        kind: 'action_result',
        intent: 'borrow_apply',
        conditions: {},
        matched: true,
        total: 1,
        shown: 1,
        items: [],
        aiUsed: false,
        aiNote: null,
        reason: null,
        borrowDraft: null,
        borrowRecords: [record],
        borrowScope: 'mine',
        action: {
          tool: AGENT_TOOL.BORROW_REQUEST_CREATE,
          ok: true,
          message: '借阅申请已提交成功。',
          nextStep: BORROW_NEXT_STEP,
          borrow: record,
        },
      },
    };
  }

  private failedAction(tool: string, message: string): { content: string; payload: AgentPayload } {
    return {
      content: message,
      payload: {
        kind: 'action_result',
        intent: tool === AGENT_TOOL.ARCHIVE_CATALOG_SAVE ? 'catalog_suggest' : 'borrow_apply',
        conditions: {},
        matched: false,
        total: 0,
        shown: 0,
        items: [],
        aiUsed: false,
        aiNote: null,
        reason: message,
        action: { tool, ok: false, message, nextStep: '可重新发起，或改用页面录入。' },
      },
    };
  }

  /** 借阅记录视图：详情入口指向现有档案详情路由（不新建借阅详情页）。 */
  private toBorrowRecords(items: BorrowRequestView[], operator: UserView): AgentBorrowRecordView[] {
    return items.map((item) => this.toBorrowRecord(item, operator));
  }

  private toBorrowRecord(item: BorrowRequestView, operator: UserView): AgentBorrowRecordView {
    return {
      id: item.id,
      archiveId: item.archiveId,
      archiveTitle: item.archiveTitle,
      archiveNo: item.archiveNo,
      applicantName: item.applicantName,
      purpose: item.purpose,
      days: item.days,
      status: item.status,
      statusLabel: item.statusLabel,
      createdAt: item.createdAt,
      startAt: item.startAt,
      dueAt: item.dueAt,
      reviewedAt: item.reviewedAt,
      reviewerName: item.reviewerName,
      reviewNote: item.reviewNote,
      canReturn: item.canReturn,
      canOpenDetail: this.canOpenDetail(item.archiveId, operator),
      detailPath: `/archives/${item.archiveId}`,
    };
  }

  /** 只接受用户可编辑字段（借阅：purpose/days；著录：各字段值），其余一律丢弃。 */
  private pickEditableValues(raw: unknown): Record<string, string> | null {
    if (!raw || typeof raw !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      const text = String(value);
      if (key === 'purpose') out.purpose = text.slice(0, MAX_BORROW_PURPOSE_LENGTH);
      else if (key === 'days') out.days = text.slice(0, 8);
      else if (/^[A-Za-z0-9_\u4e00-\u9fa5-]{1,64}$/.test(key)) out[key] = text.slice(0, 2000);
    }
    return out;
  }

  // ==================== 第二阶段：附件正文检索与内容问答 ====================

  /**
   * 内容问答主流程：定位取证范围 → 权限复核 → 检索正文片段 → 调用模型 → 核验引用 → 返回答案与来源。
   *
   * 降级链（每一级都不伪装成上一级）：
   * 1. 无可用证据 → content_no_evidence（如实说明未找到依据，并附各附件的真实提取状态）；
   * 2. 模型不可用/超时/报错 → content_evidence（直接展示检索到的原文片段）；
   * 3. 模型作答但未给出可核验引用 → content_evidence（不声称已 AI 归纳）；
   * 4. 引用可核验 → content_answer（sources 只包含引用命中的证据）。
   */
  /** Resolve a historical reference, then fetch every entity again using today's permissions. */
  private async answerReference(
    question: string, conversationId: number, operator: UserView, model: AiModelClient,
  ): Promise<{ content: string; payload: AgentPayload }> {
    const request = parseReference(question)!;
    const state = this.context.load(conversationId, operator.id);
    const base: AgentPayload = { kind: 'target_ask', intent: request.content ? 'content_question' : 'context_reference', conditions: {}, matched: false,
      total: 0, shown: 0, items: [], aiUsed: false, aiNote: null, reason: null };
    const ask = (content: string) => ({ content, payload: { ...base } });
    if (!state.archives.length && !state.attachments.length) {
      if (request.content) base.kind = 'content_no_evidence';
      return ask('没有找到当前会话可引用的检索结果。你指的是哪份档案或附件？');
    }
    const type = request.type ?? state.focus ?? 'archive';
    const listFiles = type === 'attachment' && !request.content && !request.upload && !request.name && request.ordinal === undefined && !/哪一份|哪份|哪一个|哪个/u.test(question);
    let refs = request.ordinal !== undefined || request.name ? state.attachments :
      state.attachments.filter(f => !state.activeFiles.length || state.activeFiles.includes(f.fileId));
    let archiveIds = request.ordinal !== undefined || request.name ? state.archives : state.activeArchives;
    if (listFiles && /这个档案|那个档案|这些档案|那些档案/u.test(question)) refs = [];
    if (type === 'attachment' && request.ordinal !== undefined) refs = state.attachments.slice(request.ordinal - 1, request.ordinal);
    if (type === 'archive' && request.ordinal !== undefined) archiveIds = state.archives.slice(request.ordinal - 1, request.ordinal);
    if (request.ordinal !== undefined && (request.ordinal < 1 || (type === 'attachment' ? !refs.length : !archiveIds.length))) {
      return ask('上一轮展示的结果中没有这个序号。你要查看哪一份？');
    }
    if (type === 'attachment' && refs.length) archiveIds = [...new Set(refs.map(f => f.archiveId))];
    if (!archiveIds.length) return ask('当前没有可确定的目标。你指的是哪份档案或附件？');
    const checked = await this.dispatcher.execute(archiveIds.map(id => ({ id: `context:${id}`, toolName: 'archive.detail', params: { archiveId: id } })), operator);
    base.toolResults = checked.results;
    base.toolExecutionStatus = checked.status;
    if (checked.status !== 'success') return { content: '历史引用的资料当前已不存在、无权访问或查询失败，无法继续读取。',
      payload: { ...base, kind: 'error', reason: '历史引用重新校验失败', contextSelection: { archives: [], files: [], focus: null } } };
    if (/其他合同.{0,12}类似规定/u.test(question)) {
      const previousTopic = /付款|支付/u.test(state.previousQuestion) ? '付款条款' : /违约/u.test(state.previousQuestion) ? '违约责任' : '';
      if (!previousTopic) return ask('请说明希望比较哪项规定，例如付款条款或违约责任。');
      const others: number[] = [];
      for (let page = 1; page <= 50; page++) {
        const located = await this.dispatcher.execute([{ id: 'contracts', toolName: 'archive.search', params: { keyword: '合同', page, pageSize: 100 } }], operator);
        const result = located.results[0];
        if (result.status !== 'success') return ask('其他合同定位失败，请稍后重新查询。');
        others.push(...result.data.items.map((a: { id: number }) => a.id).filter((id: number) => !archiveIds.includes(id)));
        if (!result.pagination?.hasMore) break;
        if (page === 50) return ask('当前合同范围过大，请指定分类或合同名称后继续比较。');
      }
      if (!others.length) return { content: '未找到其他当前有权访问的合同。', payload: { ...base, kind: 'content_no_evidence', sources: [] } };
      return this.answerContentQuestion({ kind: 'content_question' }, {
        question: `比较当前有权访问的其他合同的${previousTopic}`, operator, conversationId, model, aiNote: null,
        evidenceArchiveIds: [...new Set(others)],
      }, base);
    }
    let details = checked.results.flatMap(r => r.data.items) as Array<ArchiveView & { files: Array<{ id: number }> }>;
    if (type === 'archive' && request.name) details = details.filter(a => a.title.toLowerCase().includes(request.name!.toLowerCase()));
    if (type === 'archive' && !details.length) return ask('上一轮结果中没有符合名称的档案。你指的是哪份档案？');
    if (type === 'archive' && details.length > 1 && !request.plural) return {
      content: '当前有多份候选档案。你要查看其中哪一份？',
      payload: { ...base, items: details.map(d => this.toCard(d, operator)), total: details.length, shown: details.length },
    };
    archiveIds = details.map(a => a.id);
    const intent = parseDeterministic({ question, categories: this.categoryHints() }).intent;
    const selection = { archives: archiveIds, files: [] as number[], focus: type };
    if (type === 'archive') refs = [];
    if (type === 'archive' && intent.kind === 'unified_search' && intent.scopes?.includes('audit')) {
      const scopes = intent.scopes.filter(scope => ['archive', 'attachment', 'audit', 'content'].includes(scope));
      const plan = this.dispatcher.plan({ ...intent, title: undefined, archiveNo: undefined, keyword: undefined, scopes }, question)
        .filter(call => call.toolName !== 'archive.search' && call.toolName !== 'archive.detail')
        .map(call => ({ ...call, dependsOn: undefined, archiveFrom: undefined, params: { ...call.params, archiveIds } }));
      const related = await this.dispatcher.execute(plan, operator);
      const results = [...related.results, { callId: 'archives', toolName: 'archive.detail', status: 'success' as const,
        data: { items: details }, total: details.length, pagination: null, error: null }];
      const execution: AgentToolExecution = { status: related.status === 'error' ? 'partial' : related.status, results };
      const rendered = await this.handleUnifiedSearch({ kind: 'unified_search', scopes }, { question, operator, execution }, base);
      rendered.payload.contextSelection = selection;
      return rendered;
    }
    if (type === 'attachment' || (intent.kind === 'unified_search' && intent.scopes?.includes('attachment'))) {
      const listed = await this.dispatcher.execute([{ id: 'attachments', toolName: 'attachment.search', params: {
        archiveIds, fileIds: refs.length ? refs.map(f => f.fileId) : undefined, pageSize: 100,
      } }], operator);
      const result = listed.results[0];
      if (result.status !== 'success') return { content: '附件查询失败，请稍后重试。', payload: { ...base, kind: 'error', toolExecutionStatus: 'partial', reason: result.error?.message ?? '附件查询失败', toolResults: [...checked.results, ...listed.results] } };
      let rows = result.data.items as FileSearchRow[];
      // Preserve the order actually displayed to the user, even if database ordering changed.
      if (refs.length) rows = refs.flatMap(ref => rows.filter(row => row.fileId === ref.fileId && row.archiveId === ref.archiveId));
      if (request.name) rows = rows.filter(f => f.fileName.toLowerCase().includes(request.name!.toLowerCase()));
      if (!rows.length) return { content: '上一轮附件结果中没有符合条件且当前可访问的附件。',
        payload: { ...base, reason: '附件不存在或未匹配', toolResults: [...checked.results, ...listed.results] } };
      const enumerateFiles = listFiles || (type === 'archive' && intent.kind === 'unified_search' && intent.scopes?.includes('attachment'));
      if (rows.length > 1 && !request.plural && !enumerateFiles) {
        const rendered = await this.handleUnifiedSearch({ kind: 'unified_search', scopes: ['attachment'] }, {
          question, operator, execution: { ...listed, results: [{ ...result, data: { items: rows }, total: rows.length }] },
        }, base);
        rendered.content = '当前有多份候选附件。你要查看其中哪一份？\n' + answerAttachments(rows.map(r => this.toAttachmentCard(r, operator)));
        // Keep the original ordered candidate list for a subsequent ordinal selection.
        rendered.payload.contextSelection = { archives: archiveIds, files: rows.map(f => f.fileId), focus: 'attachment' };
        return rendered;
      }
      selection.files = rows.map(f => f.fileId);
      selection.archives = [...new Set(rows.map(f => f.archiveId))];
      selection.focus = 'attachment';
      if (request.content) {
        base.toolResults = [...checked.results, ...listed.results];
        const answered = await this.answerContentQuestion({ kind: 'content_question' }, {
          question, operator, conversationId, model, aiNote: null,
          evidenceArchiveIds: selection.archives, evidenceFileIds: selection.files,
        }, base);
        answered.payload.contextSelection = selection;
        return answered;
      }
      const rendered = await this.handleUnifiedSearch({ kind: 'unified_search', scopes: ['attachment'] }, {
        question, operator, execution: { ...listed, results: [{ ...result, data: { items: rows }, total: rows.length }] },
      }, base);
      rendered.content = `找到 ${rows.length} 个附件：\n` + answerAttachments(rows.map(r => this.toAttachmentCard(r, operator)), request.upload);
      rendered.payload.toolResults = [...checked.results, ...listed.results];
      rendered.payload.contextSelection = selection;
      return rendered;
    }
    if (request.content) {
      const answered = await this.answerContentQuestion({ kind: 'content_question' }, {
        question, operator, conversationId, model, aiNote: null, evidenceArchiveIds: archiveIds,
      }, base);
      answered.payload.contextSelection = selection;
      return answered;
    }
    const cards = details.map(d => this.toCard(d, operator));
    return { content: answerArchives(cards.length, cards), payload: { ...base, kind: 'archive_info', items: cards,
      total: cards.length, shown: cards.length, matched: true, contextSelection: selection } };
  }

  private async answerContentQuestion(
    intent: ParsedIntent,
    ctx: {
      question: string;
      operator: UserView;
      aiNote: string | null;
      conversationId: number;
      model: AiModelClient;
      evidenceArchiveIds?: number[];
      evidenceFileIds?: number[];
    },
    base: AgentPayload,
  ): Promise<{ content: string; payload: AgentPayload }> {
    intent = structureRetrievalIntent(ctx.question, intent);
    base.modelCall = { provider: ctx.model.provider ?? 'unknown', model: ctx.model.model, attempted: false,
      status: 'not_attempted', reason: '未找到正文证据，未调用模型', evidenceCount: 0, modelEvidenceCount: 0 };
    const results: AgentToolResult[] = [...(base.toolResults ?? [])];
    const comparison = ctx.question.match(/(?:比较(?:一下)?|对比(?:一下)?)\s*[《「]?(.{2,40}?)[》」]?(?:和|与|跟)[《「]?(.{2,40}?)[》」]?(?:中|里|的)(?:的)?(?:违约|付款|支付|条款|正文)/u);
    const plan = this.dispatcher.planContentRetrieval(intent);
    if (comparison && !ctx.evidenceArchiveIds) {
      plan.splice(0, plan.length, ...[comparison[1], comparison[2]].map((title, i) => ({
        id: `compare:${i}`, toolName: 'archive.search', params: { title: title.trim(), pageSize: 100 },
      })));
    }
    const located = ctx.evidenceArchiveIds ? { status: 'success' as const, results: [] as AgentToolResult[] }
      : await this.dispatcher.executeAllPages(plan, ctx.operator);
    results.push(...located.results);
    const hits = located.results.filter(r => r.status === 'success').flatMap(r => r.data.items as ArchiveView[]);
    const numberHits = hits.filter(a => a.archiveNo === intent.archiveNumber);
    const titleOnly = /(?<!附件|文件|文档)(?:档案标题|档案题名|标题|题名)/u.test(ctx.question);
    const scopeHits = titleOnly ? located.results.filter(r => r.status === 'success' && r.callId?.startsWith('title:')).flatMap(r => r.data.items as ArchiveView[]) : hits;
    const exactTitles = scopeHits.filter(a => intent.archiveTitleCandidates?.includes(a.title));
    const locatedIds = [...new Set((intent.archiveNumber ? numberHits : exactTitles.length ? exactTitles : scopeHits).map(a => a.id))];
    const explicit = !!ctx.evidenceArchiveIds || !!intent.isExplicitScope || !!comparison;
    // Empty explicit scope stays empty. It never becomes undefined (the global search sentinel).
    const scoped = ctx.evidenceArchiveIds ?? (explicit ? locatedIds : undefined);
    const scopeMissing = scoped !== undefined && !scoped.length;
    const attachments = !scopeMissing && (intent.attachmentNameCandidates?.length ?? 0) > 0
      ? await this.dispatcher.executeAllPages(intent.attachmentNameCandidates!.map((attachmentFileName, i) => ({
          id: `attachment-title:${i}`, toolName: 'attachment.search', params: {
            attachmentFileName, archiveIds: scoped, categoryId: intent.categoryId, status: intent.status, pageSize: 100,
          },
        })), ctx.operator)
      : { status: 'success' as const, results: [] as AgentToolResult[] };
    results.push(...attachments.results);
    if (new Set(exactTitles.map(a => a.id)).size > 1 && !isComparisonQuestion(ctx.question)) {
      const cards = [...new Map(exactTitles.map(a => [a.id, this.toCard(a, ctx.operator)])).values()];
      return { content: '找到多份名称相同的档案。你要查看其中哪一份？',
        payload: { ...base, kind: 'search', total: cards.length, shown: cards.length, items: cards, matched: true, toolResults: results } };
    }
    const files = attachments.results.filter(r => r.status === 'success').flatMap(r => r.data.items as FileSearchRow[]);
    const archiveIds = scoped ?? [...new Set([...locatedIds, ...files.map(f => f.archiveId)])];
    const allowed = archiveIds.filter(id => this.canOpenDetail(id, ctx.operator));
    const terms = intent.contentTerms ?? [];
    const summary = !!intent.isSummaryQuestion || /(?:正文|全文)(?:是什么)?[？?。]?$/u.test(ctx.question);
    if (comparison && located.results.some(r => r.status !== 'success' || !r.total)) {
      base.toolResults = results;
      return { content: '未能完整定位双方可访问的档案，请提供更具体的档案名称或档号。', payload: { ...base, kind: 'content_no_evidence', sources: [] } };
    }
    if (scopeMissing || (intent.attachmentFileName && !files.length)) {
      recordStep('content', 'skipped', 0, 0, '未找到指定的可访问档案或附件，未执行正文检索');
      recordStep('answer', 'skipped', 0, 0, '缺少指定档案的正文依据，未调用模型');
      return { content: '没有找到你指定的档案或附件，或当前无权访问，无法获取对应正文依据。',
        payload: { ...base, kind: 'content_no_evidence', sources: [], toolResults: results,
          contextSelection: { archives: [], files: [], focus: null } } };
    }
    // Attachment ownership is resolved from real search rows; permissions and versions are checked by content.read.
    const fileIds = ctx.evidenceFileIds ?? (files.length && (!locatedIds.length || intent.attachmentFileName) ? [...new Set(files.map(f => f.fileId))] : undefined);
    const execution = await this.dispatcher.execute([{ id: 'evidence', toolName: 'content.read', params: {
      query: terms.join(' '),
      archiveIds: scoped !== undefined || (summary && archiveIds.length) ? allowed : undefined,
      terms, comparison: isComparisonQuestion(ctx.question), fileIds, summary,
    } }], ctx.operator);
    base.toolResults = [...results, ...execution.results];
    base.toolExecutionStatus = base.toolResults.some(r => r.status !== 'success') ? 'partial' : execution.status;
    const found = execution.results[0];
    if (found.status !== 'success') return { content: '这次没有读到正文内容，可以稍后重试，或先用档号、标题重新定位档案。',
      payload: { ...base, kind: 'error', reason: found.error?.message ?? '正文查询失败',
        diagnostics: [...(base.diagnostics ?? []), `content.read：${found.error?.message ?? 'unknown'}`] } };
    const evidenceStarted = performance.now();
    const assembled = summary ? buildSummaryEvidence(found.data.items) : selectEvidence(this.rankEvidence(found.data.items), ctx.question, ctx.model.contextWindowTokens);
    base.evidenceSelection = assembled.selection;
    const items = assembled.items;
    base.evidenceCount = found.data.items.length;
    base.modelCall.evidenceCount = found.data.items.length;
    recordStep('evidence', items.length ? 'completed' : 'empty', items.length, performance.now() - evidenceStarted);
    const notes: string[] = [...found.data.notes, ...assembled.notes];
    if (base.toolExecutionStatus === 'partial') notes.push('有一部分查询没有成功，本次回答只基于查询到的部分。');

    if (!items.length) {
      recordStep('answer','empty',0,0,'没有找到正文证据，未调用模型；请同时核对附件索引状态');
      const scopeMessage = scoped?.length && !allowed.length
        ? '你指定的档案当前不可查看或不存在。'
        : allowed.length
          ? `关于${this.describeScope(allowed)}，`
          : '';
      const content = `${scopeMessage}${INSUFFICIENT_ANSWER}`;
      return {
        content,
        payload: {
          ...base,
          kind: 'content_no_evidence',
          intent: 'content_question',
          matched: false,
          total: 0,
          shown: 0,
          items: [],
          sources: [],
          contentNotes: userReadableNotes(notes),
          diagnostics: notes.filter(note => !isUserReadableNote(note)),
          reason: '未检索到可核验的正文证据',
        },
      };
    }

    return this.answerFromEvidence(items,notes,ctx,base);
  }

  private async answerFromEvidence(items: EvidenceItem[], notes: string[],
    ctx: {question:string;operator:UserView;model:AiModelClient;aiNote:string|null}, base: AgentPayload,
    limitations: string[] = []
  ): Promise<{content:string;payload:AgentPayload}> {
    const evidenceStarted=performance.now();
    const sourceCards = this.cardsFor(items, ctx.operator);
    const selection = base.evidenceSelection;
    recordStep('evidence',items.length?'completed':'empty',items.length,performance.now()-evidenceStarted,
      selection ? JSON.stringify({strategy:selection.strategy,before:selection.before,after:selection.after,excluded:selection.excluded}) : undefined);
    const archiveIds = [...new Set(items.map((item) => item.row.archiveId))];
    const graphCitations = this.buildGraphCitations(base.toolResults ?? [], ctx.operator);
    const scopedPayload: AgentPayload = {
      ...base,
      intent: 'content_question',
      matched: true,
      total: archiveIds.length,
      shown: sourceCards.length,
      items: sourceCards,
      contentNotes: userReadableNotes(notes),
      ...(graphCitations.length ? { graphCitations } : {}),
      modelCall: { provider: ctx.model.provider ?? 'unknown', model: ctx.model.model, attempted: false,
        status: ctx.model.available ? 'not_attempted' : 'unavailable', reason: ctx.model.available ? '附件正文理解、总结或条款问答' : '模型未配置或连接不可用',
        evidenceCount: base.evidenceCount ?? items.length, modelEvidenceCount: 0 },
    };

    scopedPayload.aiUsed = false;
    const authorized = this.revalidateReply({content:'',payload:{...scopedPayload,sources:items.map(item=>this.toSource(item))}},ctx.operator);
    if(authorized.payload.kind==='error') return authorized;
    const started=performance.now();
    recordStep('answer',ctx.model.available?'running':'skipped',0,0,ctx.model.available?'正在生成并核验回答':'模型未配置，AI 总结未完成');
    const riskAnalysis=/风险/u.test(ctx.question) && /分析|排序|整改|严重|措施|影响/u.test(ctx.question);
    // Completeness is required only for attachments the user explicitly named. Retrieved
    // chunks that do not support the answer are allowed to remain uncited reference material.
    const requiredFileIds = base.retrievalPlan?.hardConstraints.attachmentNames.length
      ? [...new Set((base.toolResults ?? []).filter(r => r.callId?.startsWith('constraint:file:') && r.status === 'success')
        .flatMap(r => Array.isArray(r.data?.items) ? r.data.items : [])
        .map((f: { fileId?: unknown }) => Number(f.fileId))
        .filter((id): id is number => Number.isSafeInteger(id) && id > 0))]
      : [];
    // 原始检索备注可能包含图谱算法说明、工具执行状态或内部判定；模型只接收经过筛选的业务提示。
    const generated=await generateGroundedAnswer(ctx.model,ctx.question,items,userReadableNotes(notes),{
      requireAllFiles:requiredFileIds.length>0,requiredFileIds,
      requireComparison:base.retrievalPlan?.responseMode==='compare' && isComparisonQuestion(ctx.question),requireRiskAnalysis:riskAnalysis,graphEvidence:graphCitations});
    scopedPayload.answerGeneration=generated.state;
    // 生成阶段可能带出「证据条数/分块截断」等实现细节：面板只展示用户能读懂的说明。
    scopedPayload.contentNotes=userReadableNotes(generated.notes);
    scopedPayload.diagnostics=[...(base.diagnostics ?? []), ...generated.notes.filter((note) => !isUserReadableNote(note))];
    scopedPayload.modelCall!.attempted=generated.state.calls>0;
    scopedPayload.modelCall!.modelEvidenceCount=generated.state.evidenceCount;
    scopedPayload.modelCall!.status=generated.state.modelResponse==='received'?'success':generated.state.modelResponse==='failed'?'failed':ctx.model.available?'not_attempted':'unavailable';
    scopedPayload.modelCall!.reason=generated.state.modelResponse==='received'?'已收到模型响应；最终答案状态见生成与引用核验结果':'模型未返回有效响应';
    const afterModel = this.revalidateReply({content:'',payload:{...scopedPayload,sources:items.map(item=>this.toSource(item))}},ctx.operator);
    if(afterModel.payload.kind==='error')return afterModel;
    const verified=generated.verified;
    if(!verified?.valid) {
      const insufficient=generated.state.failure==='insufficient_evidence';
      const note=generated.state.status==='unavailable'?'未配置模型服务，未启用可用的个人 AI 模型。':answerFailureMessage[generated.state.failure??'call_failed'];
      recordStep('answer',generated.state.status==='unavailable'?'skipped':insufficient?'empty':'failed',0,performance.now()-started,note);
      // 失败原因只进诊断；正文固定说明，检索片段以 retrievedEvidence 单独承载，
      // 绝不把未经核验的模型结论或大段原文拼进回答。
      scopedPayload.diagnostics=[...(scopedPayload.diagnostics ?? []), note];
      const safeLimitations=userReadableNotes([...limitations,...generated.notes]);
      return {content:insufficient?INSUFFICIENT_ANSWER:renderEvidenceFallback(),
        payload:{...scopedPayload,kind:insufficient?'content_no_evidence':'content_evidence',aiUsed:false,aiNote:note,
          ...(insufficient?{matched:false,total:0,shown:0,items:[]}:{}),
          sources:[],retrievedEvidence:insufficient?[]:items.map(item=>this.toSource(item)),limitations:safeLimitations,
          graphCitations:[],reason:note}};
    }
    const paragraphs=verified.cleaned.split('\n\n');
    const summary=isSummaryQuestion(ctx.question) || base.retrievalPlan?.responseMode==='summary';
    const body=summary && paragraphs.length>1?`内容概述\n${paragraphs[0]}\n\n主要内容\n${paragraphs.slice(1).map(p=>`• ${p}`).join('\n\n')}`:verified.cleaned;
    // answer 只包含经核验的结论；限制说明单独下发，由 UI 在回答下方以简洁样式展示。
    const riskCaveat=/风险/u.test(ctx.question)?['处理状态以本次查阅资料的记录时点为准，资料之外的后续变化无法确认。']:[];
    const safeLimitations = userReadableNotes([...limitations,...generated.notes.filter(note=>isUserReadableNote(note)),...riskCaveat]);
    const citedChunks = new Set(verified.citations.map(item=>item.row.chunkId));
    const retrievedEvidence = items.filter(item=>!citedChunks.has(item.row.chunkId)).map(item=>this.toSource(item));
    recordStep('answer','completed',verified.citations.length,performance.now()-started,'回答已生成，事实与引用核验通过，最终内容已完成');
    return {content:body,payload:{...scopedPayload,kind:'content_answer',aiUsed:true,aiNote:null,claims:verified.claims,
      sources:verified.citations.map(item=>this.toSource(item)),retrievedEvidence,limitations:safeLimitations,
      graphCitations:verified.graphCitations ?? []}};
  }

  /** Only successful tool results may mint G references; IDs are checked against the live graph. */
  private buildGraphCitations(results: AgentToolResult[], operator: UserView): AgentGraphCitation[] {
    const candidates=results.filter(r=>r.toolName==='graph.relations' && r.status==='success')
      .flatMap(r=>Array.isArray(r.data?.items)?r.data.items:[]);
    const citations:AgentGraphCitation[]=[], edges=new Set<number>(), nodes=new Set<number>();
    for(const item of candidates) {
      if(edges.has(item.edgeId))continue;
      try {
        const detail=this.graph.edge(operator,item.edgeId);
        const owners=[detail.from.archiveId,detail.to.archiveId];
        if(!owners.includes(item.sourceArchiveId) || !owners.includes(item.archiveId))continue;
        const added=[detail.from,detail.to,...detail.supportingNodes].map(n=>n.id);
        if(new Set([...nodes,...added]).size>48)continue;
        added.forEach(id=>nodes.add(id));edges.add(detail.edge.id);
        citations.push(graphCitation(detail,'G'+(citations.length+1)));
      }catch { /* Fail closed: neither cached labels nor stale evidence may escape. */ }
      if(citations.length>=8)break;
    }
    return citations;
  }

  /** 从本会话历史回复里拿最近一次结果卡片的档案 ID（只能拿到当前用户自己会话里的历史）。 */
  private scopeFromConversation(conversationId: number, limit: number): number[] {
    const messages = this.repo.listMessages(conversationId, MESSAGE_HISTORY_LIMIT);
    const ids: number[] = [];
    for (let i = messages.length - 1; i >= 0 && ids.length < limit; i -= 1) {
      const message = messages[i];
      if (message.role !== 'assistant' || !message.payloadJson) continue;
      let payload: AgentPayload | null = null;
      try {
        payload = JSON.parse(message.payloadJson) as AgentPayload;
      } catch {
        continue; // 载荷损坏：跳过该条，不猜范围
      }
      if (!payload || !Array.isArray(payload.items)) continue;
      if (payload.kind !== 'search' && payload.kind !== 'archive_info') continue;
      for (const card of payload.items) {
        if (ids.length >= limit) break;
        if (Number.isInteger(card?.id) && !ids.includes(card.id)) ids.push(card.id);
      }
    }
    return ids;
  }

  /** 按附件轮流取证，避免一份长附件挤占全部证据预算。 */
  private rankEvidence(rows: EvidenceRow[]): EvidenceRow[] {
    const unique = new Map<number, EvidenceRow>();
    for (const row of rows) {
      const exist = unique.get(row.chunkId);
      if (!exist || (row.score ?? 0) > (exist.score ?? 0)) unique.set(row.chunkId, row);
    }
    const sorted = [...unique.values()].sort((a, b) => b.score - a.score || a.chunkId - b.chunkId);
    return sorted;
  }

  private describeScope(archiveIds: number[]): string {
    const titles = archiveIds
      .map((id) => {
        try {
          return `《${this.access.loadArchive(id).title}》`;
        } catch {
          return '';
        }
      })
      .filter(Boolean);
    return titles.slice(0, 3).join('、') || `档案 #${archiveIds.join(', #')}`;
  }

  /** 来源条目：全部字段取自真实索引行（附件名/版本/位置都来自已入库数据）。 */
  private toSource(item: EvidenceItem): AgentSource {
    const archive = this.access.loadArchive(item.row.archiveId);
    return {
      categoryName: this.categories.findById(archive.categoryId)?.name ?? '', archiveStatus: archive.status,
      hitType: item.row.hitType ?? 'content', searchSource: item.row.searchSource ?? 'current_version_content',
      relevance: { score: item.row.score ?? 0, algorithm: item.row.searchSource ?? 'legacy_content_score' },
      versionId:item.row.versionId,chunkId:item.row.chunkId,pageNo:item.row.pageNo,posFrom:item.row.posFrom,posTo:item.row.posTo,
      attachmentId: item.row.fileId,
      attachmentName: item.row.fileName,
      fileVersion: item.row.versionNo === null ? '上传原件' : `第 ${item.row.versionNo} 版`,
      score: item.row.score,
      unitId: item.row.unitId,
      ref: item.ref,
      archiveId: item.row.archiveId,
      archiveTitle: item.row.archiveTitle,
      archiveNo: item.row.archiveNo,
      fileId: item.row.fileId,
      fileName: item.row.fileName,
      versionNo: item.row.versionNo,
      locator: item.row.locator,
      excerpt: item.excerpt,
      detailPath: `/archives/${item.row.archiveId}`,
    };
  }

  /** 来源档案卡片（复用目录检索的权限判定，详情入口指向现有路由）。 */
  private cardsFor(items: EvidenceItem[], operator: UserView): AgentArchiveCard[] {
    const ids: number[] = [];
    for (const item of items) {
      if (!ids.includes(item.row.archiveId)) ids.push(item.row.archiveId);
    }
    const cards: AgentArchiveCard[] = [];
    for (const id of ids) {
      const detail = this.loadDetailForAgent(id, operator);
      if (!detail) continue;
      cards.push(this.toCard(detail, operator));
    }
    return cards;
  }

  /**
   * 卡片可执行动作由服务端真实权限决定：
   * 能被检索出来即代表当前用户至少可见目录级信息，因此开放详情入口；
   * 详情页内的附件/下载仍由既有接口逐次校验（Agent 不额外授权）。
   */
  private toCard(item: ArchiveView, operator: UserView): AgentArchiveCard {
    const snippetParts = [
      item.keywords ? `关键词：${item.keywords}` : '',
      item.responsible ? `责任者：${item.responsible}` : '',
      item.formationDate ? `形成时间：${item.formationDate}` : '',
      item.remarks ? `备注：${item.remarks}` : '',
    ].filter(Boolean);
    return {
      id: item.id,
      title: item.title,
      archiveNo: item.archiveNo,
      categoryName: item.categoryName,
      categoryPath: item.categoryPath,
      archiveType: item.archiveType,
      status: item.status,
      statusLabel: item.statusLabel,
      formationDate: item.formationDate,
      responsible: item.responsible,
      keywords: item.keywords,
      snippet: snippetParts.join('　|　'),
      canOpenDetail: this.canOpenDetail(item.id, operator),
      detailPath: `/archives/${item.id}`,
    };
  }

  /** 二次复核（默认拒绝）：卡片入口必须真实通过既有访问控制，不依赖检索结果本身。 */
  private canOpenDetail(archiveId: number, operator: UserView): boolean {
    try {
      this.access.assertView(operator, this.access.loadArchive(archiveId));
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) return false;
      throw err;
    }
  }

  /** 详情补充字段（附件数量等）；无权或失败时返回 null，不展示也不报错。 */
  private loadDetailForAgent(archiveId: number, operator: UserView) {
    try {
      return this.archives.getArchiveDetail(archiveId, operator);
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) return null;
      console.warn(`[agent] 详情读取失败：${(err as Error)?.message ?? err}`);
      return null;
    }
  }

  private describeConditions(conditions: AgentSearchConditions): string {
    const parts: string[] = [];
    if (conditions.archiveNo) parts.push(`档号 ${conditions.archiveNo}`);
    if (conditions.title) parts.push(`标题含「${conditions.title}」`);
    if (conditions.keyword) parts.push(`关键词「${conditions.keyword}」`);
    if (conditions.categoryName) parts.push(`分类「${conditions.categoryName}」`);
    if (conditions.status) parts.push(conditions.status === 'archived' ? '已归档' : '草稿');
    return parts.join('，');
  }

  private categoryHints(): CategoryHint[] {
    return this.categories.listAll().map((c) => ({ id: c.id, name: c.name, code: c.code }));
  }

  private normalizeClientRequestId(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const text = String(raw).trim();
    if (!text) return null;
    if (text.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
      throw new BadRequestException('请求标识过长，请刷新后重试');
    }
    return text;
  }

  /** 从当前用户自己的会话历史中找回上一条有效问题，跳过重答指令、确认/取消和纯期限补充。 */
  private findPreviousUserQuestion(conversationId: number): string | null {
    const messages = this.repo.listMessages(conversationId, MESSAGE_HISTORY_LIMIT);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      const candidate = normalizeFollowUpQuestion(message.content);
      if (!candidate || isReanswerRequest(candidate)) continue;
      if (CONFIRM_TEXT_RE.test(candidate) || CANCEL_TEXT_RE.test(candidate)) continue;
      if (/^\d{1,3}\s*(?:天|日|周|个月)?$/u.test(candidate)) continue;
      return candidate;
    }
    return null;
  }

  /** 幂等回放时找回配对的提问消息（同会话内紧邻该回复的前一条 user 消息）。 */
  private findPairedUserMessage(conversationId: number, assistant: AgentMessageRow): AgentMessageRow {
    const messages = this.repo.listMessages(conversationId, MESSAGE_HISTORY_LIMIT);
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role === 'user' && m.id < assistant.id) return m;
    }
    // 理论上不会出现（回复与提问同事务写入）；兜底返回回复本身，避免抛错污染对话
    return assistant;
  }

  private toConversationView(row: {
    id: number;
    title: string;
    createdAt: string;
    updatedAt: string;
    messageCount?: number;
  }): AgentConversationView {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      messageCount: row.messageCount ?? this.repo.countMessages(row.id),
    };
  }

  /** History/replays and responses generated across an async model call are not permissions. */
  private revalidateReply(reply: { content: string; payload: AgentPayload }, operator: UserView): { content: string; payload: AgentPayload } {
    const p = reply.payload;
    const originalRole = (p as AgentPayload & {authorizationRole?:string}).authorizationRole ?? operator.role;
    try {
      const current = this.users.findById(operator.id);
      if (!current || current.status !== 'active') throw new Error('User unavailable');
      operator = { ...operator, role: current.role, status: current.status, roleLabel: roleLabel(current.role) };
    } catch { return { content: '当前账号权限已变化，请重新登录后查询。', payload: { kind: 'error', intent: p.intent,
      conditions: {}, matched: false, total: 0, shown: 0, items: [], aiUsed: false, aiNote: null, reason: '当前账号不可访问' } }; }
    if (originalRole !== operator.role) return {content:'账号角色已变化，请重新查询。',payload:{kind:'error',intent:p.intent,conditions:{},matched:false,total:0,shown:0,items:[],aiUsed:false,aiNote:null,reason:'角色已变化'}};
    for (const result of p.toolResults ?? []) {
      if (result.status==='success' && result.toolName.startsWith('borrow.') && (result.data?.scope==='review' || result.data?.items?.some((row: {applicantId?:number})=>row.applicantId !== operator.id)) && !hasPermission(operator.role,'borrowReview')) return {content:'借阅审核权限已变化，请重新查询。',payload:{kind:'error',intent:p.intent,conditions:{},matched:false,total:0,shown:0,items:[],aiUsed:false,aiNote:null,reason:'借阅权限已变化'}};
      const perm = result.toolName === 'audit.search' ? 'auditView' : result.toolName === 'template.search' ? 'templateView' : result.toolName.startsWith('borrow.') ? 'borrowRequest' : 'archiveView';
      if (result.status === 'success' && !hasPermission(operator.role, perm)) return { content: '当前权限已变化，请重新查询。', payload: { kind:'error',intent:p.intent,conditions:{},matched:false,total:0,shown:0,items:[],aiUsed:false,aiNote:null,reason:'业务工具权限已变化' } };
    }
    // Earlier versions stored every queried edge. Only references actually used in the visible answer survive history reloads.
    if(reply.content && p.graphCitations){
      const used=new Set([...reply.content.matchAll(/\[(G\d+)\]/giu)].map(m=>m[1].toUpperCase()));
      p.graphCitations=p.graphCitations.filter(c=>used.has(c.ref));
    }
    const ids = new Set([
      ...(p.toolResults ?? []).flatMap(r => r.data?.authorizationArchiveIds ?? []),
      ...(p.metadataSources ?? []).flatMap(s => s.archiveId ? [s.archiveId] : []), ...p.items.map(a => a.id),
      ...(p.sources ?? []).map(s => s.archiveId), ...(p.retrievedEvidence ?? []).map(s => s.archiveId),
      ...(p.graphCitations ?? []).flatMap(citation => [citation.fromArchiveId, citation.toArchiveId].filter((id):id is number=>typeof id==='number')),
      ...(p.unified?.archives.items ?? []).map(a => a.id),
      ...(p.unified?.attachments.items ?? []).map(f => f.archiveId),
      ...(p.unified?.contents.items ?? []).map(s => s.archiveId),
    ]);
    for (const result of p.toolResults ?? []) {
      if (!/^(archive\.|attachment\.|content\.)/u.test(result.toolName)) continue;
      for (const item of result.data?.items ?? []) {
        const id = result.toolName.startsWith('archive.') ? item.id : item.archiveId;
        if (Number.isSafeInteger(id) && id > 0) ids.add(id);
      }
      for (const status of result.data?.indexStatuses ?? []) if (Number.isSafeInteger(status.archiveId)) ids.add(status.archiveId);
    }
    for (const id of ids) {
      try { this.access.assertView(operator, this.access.loadArchive(id)); }
      catch {
        return { content: '这条回复引用的资料当前已不存在或无权访问，请重新查询。', payload: {
          kind: 'error', intent: p.intent, conditions: {}, matched: false, total: 0, shown: 0, items: [],
          aiUsed: false, aiNote: null, reason: '资料访问权限已变化',
          contextSelection: { archives: [], files: [], focus: null },
        } };
      }
    }
    const refreshed:AgentGraphCitation[]=[];
    for (const citation of p.graphCitations ?? []) {
      try {
        const live=this.graph.edge(operator,citation.edgeId,citation.edge ? {fromId:citation.edge.fromId,toId:citation.edge.toId}:undefined);
        if(citation.edge && (citation.edge.id!==live.edge.id || citation.edge.from!==live.edge.from || citation.edge.to!==live.edge.to || citation.edge.type!==live.edge.type))throw new Error('Changed edge endpoints');
        if(citation.from && (citation.from.key!==live.from.key || citation.from.refId!==live.from.refId || citation.from.id!==live.from.id || citation.from.type!==live.from.type) ||
           citation.to && (citation.to.key!==live.to.key || citation.to.refId!==live.to.refId || citation.to.id!==live.to.id || citation.to.type!==live.to.type)) throw new Error('Changed endpoints');
        const owners=[live.from.archiveId,live.to.archiveId];
        if(!owners.includes(citation.fromArchiveId) || !owners.includes(citation.toArchiveId))throw new Error('Changed archives');
        refreshed.push(graphCitation(live,citation.ref));
      } catch {
        return { content: '这条回复中的关联资料已变化或当前无权查看，请重新查询。', payload: {
          kind: 'error', intent: p.intent, conditions: {}, matched: false, total: 0, shown: 0, items: [],
          aiUsed: false, aiNote: null, reason: '图谱引用重新校验失败', contextSelection: { archives: [], files: [], focus: null },
        } };
      }
    }
    // Refresh source metadata from the same authorized current-chunk endpoint used by previews.
    // Verified citations and retrieved-only reference material are both rechecked (fail closed).
    for(const source of [...(p.sources ?? []), ...(p.retrievedEvidence ?? [])]) {
      if(!source.chunkId)continue; // Existing messages without chunk IDs retain the legacy attachment checks below.
      try {
        const row=this.knowledge.sourceLocation(source.fileId,source.chunkId,operator,source.archiveId);
        if(!source.excerpt || !row.text.includes(source.excerpt) || source.unitId && row.unitId!==source.unitId)throw new Error('Changed original');
        Object.assign(source,this.toSource({ref:source.ref,row,excerpt:source.excerpt}));
      }catch {
        return {content:'这条回复的原文来源已变化或当前无权查看，请重新查询。',payload:{kind:'error',intent:p.intent,
          conditions:{},matched:false,total:0,shown:0,items:[],aiUsed:false,aiNote:null,reason:'来源重新校验失败'}};
      }
    }
    if(p.graphCitations)p.graphCitations=refreshed;
    const references:Array<{archiveId:number;fileId:number;unitId?:number}> = [...(p.metadataSources ?? []).filter((s): s is typeof s & { archiveId: number; fileId: number } => !!s.archiveId && !!s.fileId), ...(p.sources ?? []), ...(p.retrievedEvidence ?? []), ...(p.unified?.attachments.items ?? []), ...(p.unified?.contents.items ?? [])];
    for(const result of p.toolResults??[])for(const item of result.data?.items??[])
      if(Number.isSafeInteger(item.archiveId)&&Number.isSafeInteger(item.fileId))references.push(item);
    for(const result of p.toolResults??[])for(const status of result.data?.indexStatuses??[])references.push(status);
    const filesByArchive = new Map<number, Set<number>>();
    for (const ref of references) {
      try {
        let files = filesByArchive.get(ref.archiveId);
        if (!files) {
          files = new Set(this.archives.getArchiveDetail(ref.archiveId, operator).files.map(f => f.id));
          filesByArchive.set(ref.archiveId, files);
        }
        if (!files.has(ref.fileId)) throw new Error('Source attachment no longer exists');
        if ('unitId' in ref && typeof ref.unitId === 'number' && !this.contentIndex.isCurrentEvidence(ref.fileId, ref.unitId)) throw new Error('Source version has changed');
      } catch {
        return { content: '回复引用的附件当前已不存在或无权访问，请重新查询。', payload: {
          kind: 'error', intent: p.intent, conditions: {}, matched: false, total: 0, shown: 0, items: [],
          aiUsed: false, aiNote: null, reason: '附件来源重新校验失败',
          contextSelection: { archives: [], files: [], focus: null },
        } };
      }
    }
    return reply;
  }

  private toMessageView(row: AgentMessageRow, operator?: UserView): AgentMessageView {
    let payload: AgentPayload | null = null;
    let content = row.content;
    if (row.payloadJson) {
      try {
        payload = JSON.parse(row.payloadJson) as AgentPayload;
        delete payload.context;
        delete payload.contextSelection;
      } catch {
        payload = null; // 载荷损坏时只回文本，不让整条会话加载失败
      }
    }
    if (payload) {
      if (payload.kind === 'content_evidence' && payload.aiUsed === false) {
        // Legacy fallback replies embedded excerpts and unverified sources in the answer.
        // Keep the original row for authorized audit; present a safe, compact view instead.
        if (!payload.retrievedEvidence?.length && payload.sources?.length) payload.retrievedEvidence = payload.sources;
        payload.sources = [];
        payload.graphCitations = [];
        content = EVIDENCE_FALLBACK_ANSWER;
      } else {
        const sanitized = sanitizeHistoricalContent(content, payload.diagnostics ?? []);
        if (sanitized) content = sanitized;
        else if (['content_answer', 'content_evidence', 'content_no_evidence'].includes(payload.kind)) content = EVIDENCE_FALLBACK_ANSWER;
      }
    }
    const visible = payload && operator ? this.revalidateReply({ content, payload }, operator) : { content, payload };
    if (visible.payload) {
      delete visible.payload.context; delete visible.payload.contextSelection;
      visible.payload.toolResults=visible.payload.toolResults?.map(result=>result.toolName==='graph.relations'
        ? {...result,data:null,total:0}:result);
    }
    return {
      id: row.id,
      role: row.role,
      content: visible.content,
      payload: visible.payload,
      createdAt: row.createdAt,
    };
  }
}
