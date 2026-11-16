/**
 * 审计记录展示层（阶段二第五批 · 操作审计可读性优化）。
 *
 * 定位：把审计原始字段翻译成普通管理员能看懂的中文业务说明，属于「只读衍生」：
 * - 绝不写库、绝不修改 audit_logs 的既有字段，原始 action / objectType / objectId / detail 原样返回
 *   （前端「查看技术详情」仍可看到这些后端字段，追溯能力不变）；
 * - 业务对象已被删除或查不到时，objectLabel 返回 null，由前端降级显示 ID 并标注「原记录已不存在」，
 *   不编造名称、不臆测内容；
 * - 只读取业务名称类字段（档案题名、档号、附件名、账号、分类名、模板名、文档名、版本号），
 *   不读取文件正文、不读取密码或票据，避免借展示层扩大敏感面；
 * - 时间类信息以 { kind:'time', iso } 片段返回，由浏览器按用户本地时区渲染。
 */
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE } from '../db/database';
import { AuditLogItemView, AuditLogView, AuditSummaryPart } from './audit.types';

/** 动作常量 → 中文名（新增动作必须在此登记，否则页面会回退显示常量本身）。 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'auth.login': '登录成功',
  'auth.login_failure': '登录失败',
  'auth.logout': '退出登录',
  'auth.init_admin': '初始化管理员',
  'auth.register': '用户注册',
  'auth.register_failure': '注册失败',
  'user.create': '创建用户',
  'user.role_change': '变更角色',
  'user.status_change': '启用/禁用账号',
  'user.profile_update': '更新资料',
  'user.password_reset': '重置密码',
  'category.create': '新增分类',
  'category.update': '修改分类',
  'category.delete': '删除分类',
  'template.create': '创建模板',
  'template.update': '修改模板',
  'template.status_change': '模板启停',
  'template.field_change': '模板信息项变更',
  'template.bind': '分类绑定模板',
  'template.delete': '删除模板',
  'archive.create': '创建档案',
  'archive.update': '编辑档案',
  'archive.transition_archived': '归档流转',
  'archive.access_level_change': '访问级别变更',
  'archive.delete': '删除草稿档案',
  'file.upload': '上传附件',
  'file.delete': '删除附件',
  'file.download': '下载附件',
  'file.preview': '在线预览附件',
  'file.preview_denied': '预览被拒绝',
  'jitword.doc_link': '关联在线文档',
  'jitword.ticket_issue': '获取编辑/查看票据',
  'jitword.doc_saved': '在线保存',
  'jitword.doc_seed': '导入附件正文',
  'jitword.version_commit': '编辑成果入库',
  'borrow.request': '发起借阅',
  'borrow.approve': '借阅通过',
  'borrow.reject': '借阅拒绝',
  'borrow.return': '借阅归还',
  'agent.query': 'Agent 档案检索/问答',
  'agent.conversation_create': 'Agent 新建会话',
  'agent.conversation_delete': 'Agent 删除会话',
  'agent.tool_execute': 'Agent 协助办理业务',
};

/** 业务对象类型 → 中文名（objectType 常量保持英文入库，仅展示层翻译）。 */
export const AUDIT_OBJECT_LABELS: Record<string, string> = {
  auth: '登录会话',
  user: '用户',
  category: '分类',
  metadata_template: '元数据模板',
  template_field: '模板信息项',
  archive: '档案',
  archive_file: '附件',
  archive_file_version: '文件版本',
  archive_document: '在线文档',
  borrow_request: '借阅申请',
  agent_conversation: 'Agent 会话',
};

const ROLE_LABELS: Record<string, string> = {
  admin: '管理员',
  cataloger: '著录员',
  reviewer: '审核员',
  borrower: '借阅者',
  guest: '访客',
};

const USER_STATUS_LABELS: Record<string, string> = { active: '启用', disabled: '禁用' };

const TEMPLATE_STATUS_LABELS: Record<string, string> = { active: '启用', disabled: '停用' };

const ACCESS_LEVEL_LABELS: Record<string, string> = {
  public: '公开（全部角色可查）',
  restricted: '受限（需借阅授权）',
};

const PREVIEW_KIND_LABELS: Record<string, string> = {
  pdf: 'PDF 文档',
  image: '图片',
  tiff: 'TIFF 图片',
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  pptx: 'PowerPoint 演示文稿',
  ofd: 'OFD 版式文档',
  txt: '文本文件',
  md: 'Markdown 文档',
  html: '网页文档',
  office: 'Office 文档',
  archive: '压缩包',
  generic: '其他格式',
};

const FIELD_CHANGE_LABELS: Record<string, string> = {
  add: '新增',
  update: '修改',
  deactivate: '停用',
};

/** Agent 检索意图 → 中文说明（审计展示用；未知意图回退显示原值，不编造）。 */
const AGENT_INTENT_LABELS: Record<string, string> = {
  search: '关键词检索',
  archive_info: '档案基础信息查询',
  help: '检索方法咨询',
  content_question: '附件正文问答',
  borrow_apply: '借阅申请办理',
  borrow_progress: '借阅进度查询',
  catalog_suggest: '智能辅助著录',
  unsupported: '超出能力范围',
  unparsed: '未能理解',
};

/** Agent 受控工具白名单 → 中文说明（与 agent.tools.ts 的 AGENT_TOOL 一一对应）。 */
const AGENT_TOOL_LABELS: Record<string, string> = {
  'borrow.request': '创建借阅申请',
  'archive.catalog_save': '保存档案著录信息',
};

/** 展示所需的业务名称（全部来自业务表的只读查询结果，可能缺失）。 */
export interface AuditRefs {
  archive?: { title: string; archiveNo: string };
  file?: { name: string };
  version?: { versionNo: number };
  document?: { docName: string };
  user?: { username: string; displayName: string };
  applicant?: { username: string; displayName: string };
  category?: { name: string; code: string };
  template?: { name: string };
  field?: { label: string; fieldKey: string };
  borrow?: { days: number; dueAt: string | null };
}

/** 生成对外视图：原始字段 + 中文展示字段。 */
export function describeAudit(row: AuditLogView, refs: AuditRefs): AuditLogItemView {
  const object = objectOf(row, refs);
  return {
    ...row,
    actionLabel: AUDIT_ACTION_LABELS[row.action] ?? row.action,
    objectTypeLabel: AUDIT_OBJECT_LABELS[row.objectType] ?? row.objectType,
    objectLabel: object.label,
    objectRef: object.ref,
    objectResolved: object.label !== null,
    summary: buildSummary(row, refs),
  };
}

const T = (text: string): AuditSummaryPart => ({ kind: 'text', text });
const TIME = (iso: string | null | undefined): AuditSummaryPart[] => (iso ? [{ kind: 'time', iso }] : []);

function label(map: Record<string, string>, key: string | null): string {
  if (!key) return '未知';
  return map[key] ?? key;
}

/** 对象列：优先真实业务名称；解析不到时返回 null（由前端显示 ID 并标注不存在）。 */
function objectOf(row: AuditLogView, refs: AuditRefs): { label: string | null; ref: string | null } {
  const none = { label: null, ref: null } as const;
  const archive = refs.archive;
  switch (row.objectType) {
    case 'archive':
      return archive ? { label: archive.title, ref: `档号 ${archive.archiveNo}` } : none;
    case 'archive_file':
      return refs.file
        ? { label: refs.file.name, ref: archive ? `所属档案《${archive.title}》` : null }
        : none;
    case 'archive_file_version':
      return refs.version
        ? { label: `第 ${refs.version.versionNo} 版`, ref: archive ? `所属档案《${archive.title}》` : null }
        : none;
    case 'archive_document':
      return refs.document
        ? { label: refs.document.docName, ref: archive ? `所属档案《${archive.title}》` : null }
        : none;
    case 'borrow_request':
      // 借阅申请对外显示其对应档案的题名，申请编号仅在技术详情里出现。
      return archive
        ? { label: archive.title, ref: `借阅申请 #${row.objectId ?? '—'}` }
        : none;
    case 'user':
      return refs.user ? { label: refs.user.username, ref: refs.user.displayName } : none;
    case 'category':
      return refs.category ? { label: refs.category.name, ref: `分类编码 ${refs.category.code}` } : none;
    case 'metadata_template':
      return refs.template ? { label: refs.template.name, ref: null } : none;
    case 'template_field':
      return refs.field
        ? {
            label: refs.field.label,
            ref: refs.template ? `所属模板「${refs.template.name}」` : `字段标识 ${refs.field.fieldKey}`,
          }
        : none;
    case 'auth': {
      // 登录/退出以用户主键为对象；登录失败以「尝试登录的账号」为对象（本就非主键）。
      const raw = row.objectId;
      const account = refs.user?.username ?? (raw && !/^\d+$/.test(raw) ? raw : null);
      return account ? { label: account, ref: '登录账号' } : none;
    }
    default:
      return none;
  }
}

/** 详情列：中文业务说明，按「片段」构造，时间片段交给浏览器本地化。 */
function buildSummary(row: AuditLogView, refs: AuditRefs): AuditSummaryPart[] {
  const d = row.detail ?? {};
  const text = (key: string): string | null => {
    const v = d[key];
    return typeof v === 'string' && v.trim() ? v : null;
  };
  const num = (key: string): number | null => {
    const n = Number(d[key]);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const flag = (key: string): boolean => d[key] === true;

  const archiveTitle = refs.archive?.title ?? text('title');
  const archiveNo = refs.archive?.archiveNo ?? text('archiveNo');
  const archiveDesc = archiveTitle ? `档案《${archiveTitle}》` : '相关档案';
  const fileName = refs.file?.name ?? text('name');
  const fileDesc = fileName ? `附件《${fileName}》` : '相关附件';
  const account = refs.user?.username ?? text('username');
  const accountDesc = account ? `用户 ${account}` : '该用户';
  const applicantDesc = refs.applicant?.username ?? '借阅人';
  const categoryName = refs.category?.name ?? null;
  const categoryDesc = categoryName ? `分类「${categoryName}」` : '相关分类';
  const templateName = refs.template?.name ?? text('templateName') ?? null;
  const templateDesc = templateName ? `元数据模板「${templateName}」` : '相关模板';
  const docName = refs.document?.docName ?? text('docName') ?? null;
  const docDesc = docName ? `在线文档「${docName}」` : '在线文档';
  const days = refs.borrow?.days ?? num('days');
  const dueAt = refs.borrow?.dueAt ?? text('dueAt');

  switch (row.action) {
    case 'auth.login':
      return account ? [T(`账号 ${account} 登录系统成功`)] : [T('账号登录系统成功')];
    case 'auth.login_failure': {
      const attempted = text('attemptedUsername');
      const reason = text('reason');
      return [
        T(attempted ? `账号 ${attempted} 登录失败` : '登录失败'),
        ...(reason ? [T(`（${reason}）`)] : []),
      ];
    }
    case 'auth.logout':
      return account ? [T(`账号 ${account} 退出登录`)] : [T('账号退出登录')];
    case 'auth.init_admin':
      return account ? [T(`初始化管理员账号 ${account}`)] : [T('初始化管理员账号')];
    case 'auth.register':
      return account ? [T(`用户 ${account} 通过邀请码注册成功`)] : [T('用户通过邀请码注册成功')];
    case 'auth.register_failure': {
      const attempted = text('attemptedUsername');
      const reason = text('reason');
      return [
        T(attempted ? `账号 ${attempted} 注册失败` : '注册失败'),
        ...(reason ? [T(`（${reason}）`)] : []),
      ];
    }

    case 'user.create': {
      const role = text('role');
      return [T(`创建用户 ${account ?? '（未记录账号）'}`), ...(role ? [T(`，角色为${label(ROLE_LABELS, role)}`)] : [])];
    }
    case 'user.role_change':
      return [
        T(`将${accountDesc} 的角色由「${label(ROLE_LABELS, text('from'))}」变更为「${label(ROLE_LABELS, text('to'))}」`),
      ];
    case 'user.status_change':
      return [T(`将${accountDesc} 的状态由「${label(USER_STATUS_LABELS, text('from'))}」改为「${label(USER_STATUS_LABELS, text('to'))}」`)];
    case 'user.profile_update':
      return [T(`更新${accountDesc} 的显示名等资料`)];
    case 'user.password_reset':
      return [T(`重置${accountDesc} 的登录密码（旧会话已失效）`)];

    case 'category.create':
      return [T(`新增${categoryDesc}${text('code') ? `（编码 ${text('code')}）` : ''}`)];
    case 'category.update':
      return [T(`修改${categoryDesc}${text('code') ? `（编码 ${text('code')}）` : ''}`)];
    case 'category.delete':
      return [T(`删除${categoryDesc}${text('pathCode') ? `（分类路径 ${text('pathCode')}）` : ''}`)];

    case 'template.create':
      return [
        T(`创建${templateDesc}`),
        ...(num('fieldCount') !== null ? [T(`，包含 ${num('fieldCount')} 个信息项`)] : []),
      ];
    case 'template.update':
      return [T(`修改${templateDesc}`)];
    case 'template.status_change':
      return [
        T(`将${templateDesc}由「${label(TEMPLATE_STATUS_LABELS, text('from'))}」改为「${label(TEMPLATE_STATUS_LABELS, text('to'))}」`),
      ];
    case 'template.field_change': {
      const change = label(FIELD_CHANGE_LABELS, text('change'));
      const fieldLabel = refs.field?.label ?? refs.field?.fieldKey ?? text('fieldKey') ?? '信息项';
      return [T(`在${templateDesc}中${change}信息项「${fieldLabel}」`)];
    }
    case 'template.bind':
      return refs.template || text('templateName')
        ? [T(`为${categoryDesc}绑定${templateDesc}`)]
        : [T(`解除${categoryDesc}的模板绑定`)];
    case 'template.delete':
      return [
        T(`删除${templateDesc}`),
        ...(num('fieldCount') !== null ? [T(`（含 ${num('fieldCount')} 个信息项）`)] : []),
      ];

    case 'archive.create':
      return [T(`创建${archiveTitle ? `档案《${archiveTitle}》` : '档案'}${archiveNo ? `，档号 ${archiveNo}` : ''}`)];
    case 'archive.update':
      return [
        T(`编辑${archiveDesc}的著录信息`),
        ...(flag('renumbered') ? [T('（档号已重新生成）')] : []),
      ];
    case 'archive.transition_archived':
      return [T(`将${archiveDesc}${archiveNo ? `（档号 ${archiveNo}）` : ''}标记为已归档（此后只读）`)];
    case 'archive.access_level_change':
      return [
        T(`将${archiveDesc}的访问级别由「${label(ACCESS_LEVEL_LABELS, text('from'))}」调整为「${label(ACCESS_LEVEL_LABELS, text('to'))}」`),
      ];
    case 'archive.delete':
      // 档案本体已删除，题名/档号只能来自 detail；附加的清理数量如实展示。
      return [
        T(`删除${archiveDesc}${archiveNo ? `（档号 ${archiveNo}）` : ''}`),
        ...(num('fileCount') !== null ? [T(`及其 ${num('fileCount')} 个附件`)] : []),
        ...(num('versionCount') !== null ? [T(`、${num('versionCount')} 个文件版本`)] : []),
      ];

    case 'file.upload':
      return [T(`向${archiveDesc}上传${fileDesc}`)];
    case 'file.delete':
      // 附件本体已删除，名称只能来自 detail；与上传同源展示所属档案。
      return [T(`删除${archiveDesc}的${fileDesc}`)];
    case 'file.download':
      return flag('denied')
        ? [T(`尝试下载${fileDesc}，因无该档案的下载权限被拒绝`)]
        : [T(`下载${archiveDesc}的${fileDesc}`)];
    case 'file.preview': {
      const kind = text('kind');
      // 版本预览（objectType=archive_file_version）按「第 N 版」说明，不谎称为附件
      const isVersion = row.objectType === 'archive_file_version';
      const versionNo = refs.version?.versionNo ?? num('versionNo');
      const target = isVersion
        ? versionNo
          ? `第 ${versionNo} 版文件`
          : '文件版本'
        : fileDesc;
      return [
        T(`在线预览${archiveDesc}的${target}`),
        ...(kind ? [T(`（${label(PREVIEW_KIND_LABELS, kind)}）`)] : []),
      ];
    }
    case 'file.preview_denied':
      return [T(`尝试在线预览${fileDesc}，因无该档案的查看权限被拒绝`)];

    case 'jitword.doc_link':
      return [T(`为${archiveDesc}关联${docDesc}`)];
    case 'jitword.ticket_issue': {
      if (row.result === 'failure') {
        const denied = text('denied');
        const reason =
          denied === 'archived'
            ? '档案已归档，编辑票据已停用'
            : denied === 'not_creator'
              ? '仅在线文档的建档者可申请编辑票据'
              : '服务端拒绝了本次票据申请';
        return [T(`申请${docDesc}的编辑票据被拒绝：${reason}`)];
      }
      const mode = text('mode') === 'edit' ? '编辑' : '查看';
      return [T(`获取${docDesc}的${mode}票据`)];
    }
    case 'jitword.doc_saved':
      return [T(`在线保存${archiveDesc}的编辑内容`)];
    case 'jitword.doc_seed':
      return [T(`将${archiveDesc}的附件正文导入${docDesc}`)];
    case 'jitword.version_commit':
      return [
        T(`将在线编辑成果入库为${archiveDesc}`),
        ...(refs.version ? [T(`的第 ${refs.version.versionNo} 个文件版本`)] : [T('的新文件版本')]),
      ];

    case 'borrow.request':
      return [
        T(`申请借阅${archiveTitle ? `《${archiveTitle}》` : '档案'}`),
        ...(archiveNo ? [T(`（档号 ${archiveNo}）`)] : []),
        ...(days !== null ? [T(`，期限 ${days} 天`)] : []),
      ];
    case 'borrow.approve':
      return [
        T(`批准 ${applicantDesc} 借阅${archiveTitle ? `《${archiveTitle}》` : '档案'}`),
        ...(days !== null ? [T(`，期限 ${days} 天`)] : []),
        ...(dueAt ? [T('，应于 '), ...TIME(dueAt), T(' 前归还')] : []),
      ];
    case 'borrow.reject':
      return [T(`拒绝 ${applicantDesc} 对${archiveTitle ? `《${archiveTitle}》` : '档案'}的借阅申请`)];
    case 'borrow.return':
      return [T(`${applicantDesc} 归还${archiveTitle ? `《${archiveTitle}》` : '档案'}的借阅`)];

    case 'agent.query': {
      // Agent 检索留痕：只描述意图与命中数量，不回显完整提问原文，也不回显正文片段。
      const intent = text('intent');
      const total = typeof d.total === 'number' ? Number(d.total) : null;
      const sourceCount = typeof d.sourceCount === 'number' ? Number(d.sourceCount) : null;
      return [
        T(`通过档案 Agent 助理发起${intent ? `「${label(AGENT_INTENT_LABELS, intent)}」` : '档案'}检索`),
        ...(total !== null ? [T(`，命中 ${total} 条`)] : []),
        ...(sourceCount ? [T(`，引用 ${sourceCount} 条正文来源`)] : []),
        ...(flag('aiUsed') ? [T('（意图理解由大模型完成）')] : flag('aiUnavailable') ? [T('（模型服务不可用，按规则解析）')] : []),
      ];
    }
    case 'agent.conversation_create':
      return [T('新建档案 Agent 助理会话')];
    case 'agent.conversation_delete':
      return [
        T('删除档案 Agent 助理会话'),
        ...(num('messageCount') !== null ? [T(`（含 ${num('messageCount')} 条消息）`)] : []),
      ];
    case 'agent.tool_execute': {
      // 第三阶段：区分「用户主动操作」与「AI 辅助操作」——两者操作人均为当前登录用户，
      // 本条只额外记录「由 Agent 协助、经用户确认」这一事实与真实执行结果。
      const toolLabel = label(AGENT_TOOL_LABELS, text('tool'));
      const failed = row.result === 'failure';
      const error = text('error');
      return [
        T(`由档案 Agent 协助、用户确认后${failed ? '尝试' : ''}${toolLabel}`),
        ...(archiveTitle ? [T(`：${archiveNo ? `档案《${archiveTitle}》（档号 ${archiveNo}）` : `档案《${archiveTitle}》`}`)] : []),
        ...(days !== null && !failed ? [T(`，借阅期限 ${days} 天`)] : []),
        ...(failed ? [T(`，执行失败：${error ?? '业务服务拒绝'}`)] : []),
      ];
    }

    default:
      // 未登记的新动作：不编造说明，前端显示「—」，技术详情仍完整可查。
      return [];
  }
}

// ==================== 业务名称解析（只读 SQL，按页批量查询，避免逐行 N+1） ====================

interface ArchiveRow {
  id: number;
  title: string;
  archive_no: string;
}
interface FileRow {
  id: number;
  archive_id: number;
  original_name: string;
}
interface VersionRow {
  id: number;
  archive_id: number;
  version_no: number;
}
interface DocumentRow {
  id: number;
  archive_id: number;
  doc_name: string;
}
interface UserRow {
  id: number;
  username: string;
  display_name: string;
}
interface CategoryRow {
  id: number;
  name: string;
  code: string;
}
interface TemplateRow {
  id: number;
  name: string;
}
interface FieldRow {
  id: number;
  template_id: number;
  field_key: string;
  label: string;
}
interface BorrowRow {
  id: number;
  archive_id: number;
  applicant_id: number;
  days: number;
  due_at: string | null;
}

function toId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function addId(target: Set<number>, v: unknown): void {
  const n = toId(v);
  if (n !== null) target.add(n);
}

/** 为审计页一次性补齐业务名称；只读查询，不写入、不改动任何数据。 */
@Injectable()
export class AuditPresenter {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  present(items: AuditLogView[]): AuditLogItemView[] {
    if (items.length === 0) return [];
    const refs = this.resolveAll(items);
    return items.map((row) => describeAudit(row, refs.get(row.id) ?? {}));
  }

  private resolveAll(items: AuditLogView[]): Map<number, AuditRefs> {
    const want = {
      archive: new Set<number>(),
      file: new Set<number>(),
      version: new Set<number>(),
      document: new Set<number>(),
      user: new Set<number>(),
      category: new Set<number>(),
      template: new Set<number>(),
      field: new Set<number>(),
      borrow: new Set<number>(),
    };
    const byObjectType: Record<string, Set<number>> = {
      archive: want.archive,
      archive_file: want.file,
      archive_file_version: want.version,
      archive_document: want.document,
      user: want.user,
      category: want.category,
      metadata_template: want.template,
      template_field: want.field,
      borrow_request: want.borrow,
      auth: want.user, // 登录/退出以用户主键为对象
    };

    for (const row of items) {
      const id = toId(row.objectId);
      if (id !== null) byObjectType[row.objectType]?.add(id);
      // detail 中的关联 ID：即使对象本身已删除，也尽量补全所属档案 / 用户 / 模板名称。
      addId(want.archive, row.detail?.archiveId);
      addId(want.user, row.detail?.applicantId);
      addId(want.template, row.detail?.templateId);
    }

    const files = this.byIds<FileRow>(want.file, 'SELECT id, archive_id, original_name FROM archive_files WHERE id IN ($)');
    const versions = this.byIds<VersionRow>(
      want.version,
      'SELECT id, archive_id, version_no FROM archive_file_versions WHERE id IN ($)',
    );
    const documents = this.byIds<DocumentRow>(
      want.document,
      'SELECT id, archive_id, doc_name FROM archive_documents WHERE id IN ($)',
    );
    const borrows = this.byIds<BorrowRow>(
      want.borrow,
      'SELECT id, archive_id, applicant_id, days, due_at FROM borrow_requests WHERE id IN ($)',
    );
    const fields = this.byIds<FieldRow>(
      want.field,
      'SELECT id, template_id, field_key, label FROM template_fields WHERE id IN ($)',
    );
    const categories = this.byIds<CategoryRow>(
      want.category,
      'SELECT id, name, code FROM archive_categories WHERE id IN ($)',
    );

    // 第二轮：由间接引用补齐档案 / 用户 / 模板主键
    for (const f of files.values()) addId(want.archive, f.archive_id);
    for (const v of versions.values()) addId(want.archive, v.archive_id);
    for (const doc of documents.values()) addId(want.archive, doc.archive_id);
    for (const b of borrows.values()) {
      addId(want.archive, b.archive_id);
      addId(want.user, b.applicant_id);
    }
    for (const f of fields.values()) addId(want.template, f.template_id);

    const archives = this.byIds<ArchiveRow>(want.archive, 'SELECT id, title, archive_no FROM archives WHERE id IN ($)');
    const users = this.byIds<UserRow>(want.user, 'SELECT id, username, display_name FROM users WHERE id IN ($)');
    const templates = this.byIds<TemplateRow>(want.template, 'SELECT id, name FROM metadata_templates WHERE id IN ($)');

    const ctx = { archives, files, versions, documents, users, categories, templates, fields, borrows };
    const out = new Map<number, AuditRefs>();
    for (const row of items) out.set(row.id, this.refsOf(row, ctx));
    return out;
  }

  private refsOf(
    row: AuditLogView,
    ctx: {
      archives: Map<number, ArchiveRow>;
      files: Map<number, FileRow>;
      versions: Map<number, VersionRow>;
      documents: Map<number, DocumentRow>;
      users: Map<number, UserRow>;
      categories: Map<number, CategoryRow>;
      templates: Map<number, TemplateRow>;
      fields: Map<number, FieldRow>;
      borrows: Map<number, BorrowRow>;
    },
  ): AuditRefs {
    const refs: AuditRefs = {};
    const id = toId(row.objectId);
    const user = (uid: unknown) => {
      const u = ctx.users.get(toId(uid) ?? -1);
      return u ? { username: u.username, displayName: u.display_name } : undefined;
    };
    const archive = (aid: unknown) => {
      const a = ctx.archives.get(toId(aid) ?? -1);
      return a ? { title: a.title, archiveNo: a.archive_no } : undefined;
    };
    const template = (tid: unknown) => {
      const t = ctx.templates.get(toId(tid) ?? -1);
      return t ? { name: t.name } : undefined;
    };

    switch (row.objectType) {
      case 'archive':
        refs.archive = archive(id);
        break;
      case 'archive_file': {
        const f = ctx.files.get(id ?? -1);
        if (f) {
          refs.file = { name: f.original_name };
          refs.archive = archive(f.archive_id);
        }
        break;
      }
      case 'archive_file_version': {
        const v = ctx.versions.get(id ?? -1);
        if (v) {
          refs.version = { versionNo: v.version_no };
          refs.archive = archive(v.archive_id);
        }
        break;
      }
      case 'archive_document': {
        const doc = ctx.documents.get(id ?? -1);
        if (doc) {
          refs.document = { docName: doc.doc_name };
          refs.archive = archive(doc.archive_id);
        }
        break;
      }
      case 'user':
      case 'auth':
        refs.user = user(id);
        break;
      case 'category': {
        const c = ctx.categories.get(id ?? -1);
        if (c) refs.category = { name: c.name, code: c.code };
        break;
      }
      case 'metadata_template':
        refs.template = template(id);
        break;
      case 'template_field': {
        const f = ctx.fields.get(id ?? -1);
        if (f) {
          refs.field = { label: f.label, fieldKey: f.field_key };
          refs.template = template(f.template_id);
        }
        break;
      }
      case 'borrow_request': {
        const b = ctx.borrows.get(id ?? -1);
        if (b) {
          refs.borrow = { days: b.days, dueAt: b.due_at };
          refs.archive = archive(b.archive_id);
          refs.applicant = user(b.applicant_id);
        }
        break;
      }
      default:
        break;
    }

    // 兜底：对象本身已删除时，用 detail 中记录的关联 ID 继续解析（不编造，只做只读关联）
    if (!refs.archive) refs.archive = archive(row.detail?.archiveId);
    if (!refs.applicant) refs.applicant = user(row.detail?.applicantId);
    if (!refs.template) refs.template = template(row.detail?.templateId);
    return refs;
  }

  /** 参数化 IN 查询：'$' 占位符展开为与 ID 数量一致的问号，绝不拼接字面值。 */
  private byIds<T>(ids: Set<number>, sql: string): Map<number, T> {
    const out = new Map<number, T>();
    if (ids.size === 0) return out;
    const list = [...ids];
    const placeholders = list.map(() => '?').join(', ');
    const rows = this.db.prepare(sql.replace('$', placeholders)).all(...list) as unknown as Array<T & { id: number }>;
    for (const r of rows) out.set(Number(r.id), r);
    return out;
  }
}
