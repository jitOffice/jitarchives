/**
 * 操作审计公共类型与动作常量（阶段二第五批 · 功能一）。
 * 设计原则：
 * - 动作（action）用受控常量，便于按类型检索与统计；新增业务动作在此登记，避免自由字符串漂移；
 * - detail 为结构化辅助信息（禁止写入密码 / Cookie / JitWord 票据 / 接入密钥 / 文件正文），
 *   由写入方显式构造，字段级脱敏在 service 保证；
 * - actor（操作人）一律来自服务端已校验会话，禁止客户端传入。
 */

/** 审计操作结果：成功 / 失败（失败不得记成成功）。 */
export type AuditResult = 'success' | 'failure';

/** 受控动作集合（覆盖任务「审计范围」；常量值稳定，用于检索与追溯）。 */
export const AUDIT_ACTION = {
  // 认证
  LOGIN: 'auth.login',
  LOGIN_FAILURE: 'auth.login_failure',
  LOGOUT: 'auth.logout',
  INIT_ADMIN: 'auth.init_admin',
  REGISTER: 'auth.register',
  REGISTER_FAILURE: 'auth.register_failure',
  // 用户与权限
  USER_CREATE: 'user.create',
  USER_ROLE_CHANGE: 'user.role_change',
  USER_STATUS_CHANGE: 'user.status_change',
  USER_PROFILE_UPDATE: 'user.profile_update',
  USER_PASSWORD_RESET: 'user.password_reset',
  // 分类
  CATEGORY_CREATE: 'category.create',
  CATEGORY_UPDATE: 'category.update',
  CATEGORY_DELETE: 'category.delete',
  // 元数据模板
  TEMPLATE_CREATE: 'template.create',
  TEMPLATE_UPDATE: 'template.update',
  TEMPLATE_STATUS_CHANGE: 'template.status_change',
  TEMPLATE_FIELD_CHANGE: 'template.field_change',
  TEMPLATE_BIND: 'template.bind',
  TEMPLATE_DELETE: 'template.delete',
  // 档案
  ARCHIVE_CREATE: 'archive.create',
  ARCHIVE_UPDATE: 'archive.update',
  ARCHIVE_ARCHIVE: 'archive.transition_archived',
  ARCHIVE_ACCESS_CHANGE: 'archive.access_level_change',
  ARCHIVE_DELETE: 'archive.delete',
  // 文件
  FILE_UPLOAD: 'file.upload',
  /** 删除单个附件（仅未归档草稿，物理文件与正文索引一并清理）。 */
  FILE_DELETE: 'file.delete',
  FILE_DOWNLOAD: 'file.download',
  // 在线预览（V1.0 多格式预览）：与下载分开的受控字节传输事件
  FILE_PREVIEW: 'file.preview',
  FILE_PREVIEW_DENIED: 'file.preview_denied',
  // JitWord
  DOC_LINK: 'jitword.doc_link',
  DOC_TICKET: 'jitword.ticket_issue',
  DOC_SAVED: 'jitword.doc_saved',
  DOC_SEED: 'jitword.doc_seed',
  DOC_VERSION: 'jitword.version_commit',
  // 借阅
  BORROW_REQUEST: 'borrow.request',
  BORROW_APPROVE: 'borrow.approve',
  BORROW_REJECT: 'borrow.reject',
  BORROW_RETURN: 'borrow.return',
  // 档案 Agent 助理（第一阶段）：只读检索与会话管理留痕。
  // detail 仅记录意图/命中数量/检索词等最小必要信息，绝不写入完整对话正文。
  AGENT_QUERY: 'agent.query',
  AGENT_CONVERSATION_CREATE: 'agent.conversation_create',
  AGENT_CONVERSATION_DELETE: 'agent.conversation_delete',
  // 第三阶段：Agent 受控工具经「用户确认」后执行的真实业务写入（借阅申请 / 辅助著录保存）。
  // 业务本身另有 borrow.request / archive.create|update 审计；本条专门记录「由 AI 辅助发起」这一事实。
  AGENT_TOOL_EXECUTE: 'agent.tool_execute',
} as const;

export type AuditAction = (typeof AUDIT_ACTION)[keyof typeof AUDIT_ACTION];

/** 业务对象类型（受控），与 object_id 组合用于精确定位追溯。 */
export const AUDIT_OBJECT = {
  AUTH: 'auth',
  USER: 'user',
  CATEGORY: 'category',
  TEMPLATE: 'metadata_template',
  FIELD: 'template_field',
  ARCHIVE: 'archive',
  FILE: 'archive_file',
  FILE_VERSION: 'archive_file_version',
  DOCUMENT: 'archive_document',
  BORROW: 'borrow_request',
  /** Agent 会话（第一阶段：对话式查档）。 */
  AGENT_CONVERSATION: 'agent_conversation',
} as const;

export type AuditObjectType = (typeof AUDIT_OBJECT)[keyof typeof AUDIT_OBJECT];

/** 待写入的审计事件（detail 为可序列化辅助信息）。 */
export interface AuditEvent {
  actorUserId: number | null;
  actorRole: string | null;
  action: AuditAction;
  objectType: AuditObjectType;
  objectId?: number | string | null;
  result: AuditResult;
  detail?: Record<string, unknown>;
  ip?: string | null;
}

/** 审计记录对外视图（detail 已解析为对象；绝不包含任何敏感原文）。 */
export interface AuditLogView {
  id: number;
  actorUserId: number | null;
  actorName: string | null;
  actorRole: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  result: AuditResult;
  detail: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/**
 * 业务化描述片段：文本由服务端生成，时间由浏览器按本地时区渲染。
 * 之所以不在服务端直接格式化时间，是为了避免把服务器时区当成用户时区（同一记录在不同时区应显示本地时间）。
 */
export type AuditSummaryPart =
  | { kind: 'text'; text: string }
  | { kind: 'time'; iso: string };

/**
 * 审计记录对外视图：原始字段（追溯用，如 objectType / objectId / detail）原样保留，
 * 另追加中文展示字段。展示字段为只读衍生，绝不回写或修改已有审计记录。
 */
export interface AuditLogItemView extends AuditLogView {
  actionLabel: string;
  objectTypeLabel: string;
  /** 真实业务名称（档案题名 / 附件名 / 用户账号 / 分类名等）；查不到时为 null，绝不伪造。 */
  objectLabel: string | null;
  /** 业务辅助标识（档号 / 分类编码 / 所属档案 / 显示名等）。 */
  objectRef: string | null;
  /** objectLabel 是否来自真实业务记录；false 表示原对象已不存在，仅保留 ID 供追溯。 */
  objectResolved: boolean;
  /** 中文业务说明（按片段返回，时间片段由前端按本地时区渲染）。 */
  summary: AuditSummaryPart[];
}

/** 服务端查询过滤条件（分页 + 时间范围，按后端 SQL 执行）。 */
export interface AuditQuery {
  /** Server-resolved visible archive IDs; an empty array means no matches. */
  archiveIds?: number[];
  actorUserId?: number;
  /** 操作人名称（users.display_name），模糊包含匹配。 */
  actorName?: string;
  action?: string;
  /** Agent 只读检索：由服务端映射的受控动作集合。 */
  actions?: string[];
  /** Explicit tool filters intersect other conditions; legacy label searches keep their OR semantics. */
  strictActions?: boolean;
  /** Agent 只读检索：匹配操作人、动作、对象、对象 ID 与脱敏 detail。 */
  keyword?: string;
  objectType?: string;
  objectId?: string;
  from?: string; // ISO 时间下界（含）
  to?: string; // ISO 时间上界（含）
  page: number;
  pageSize: number;
}

export interface AuditPage {
  items: AuditLogView[];
  total: number;
  page: number;
  pageSize: number;
}

/** 接口返回页（items 已附加中文展示字段）。 */
export interface AuditItemPage {
  items: AuditLogItemView[];
  total: number;
  page: number;
  pageSize: number;
}
