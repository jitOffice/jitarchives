/**
 * Agent 受控业务工具（第三阶段：智能档案业务办理 · 第五节工具架构）。
 *
 * 定位：Agent 不另建一套业务系统，本文件只是既有业务服务的「白名单薄封装」。
 * 强约束：
 * 1. 工具名固定白名单（AGENT_TOOL），模型只能触发这些能力，不能任意调用 URL、不能拼 SQL、不能直接访问数据库；
 * 2. 入参一律结构化并逐字段校验（长度/取值集合/正整数），身份信息只取服务端会话用户；
 *    模型给出的 userId / 角色 / 权限结论在此一律不被读取；
 * 3. 每次调用业务接口前都重新执行后端权限判定（角色矩阵 + ArchiveAccessService），
 *    不缓存、不沿用上一轮结论，也不依赖前端是否隐藏入口；
 * 4. 结果以真实业务接口响应为准：业务异常原样上抛（受控中文信息），绝不改写为「已成功」；
 * 5. 写类工具（借阅申请 / 著录保存）只允许由「服务端保存的待确认草稿」执行，见 agent.pending.ts。
 */
import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { ARCHIVE_TYPES, ArchiveView, ArchivesService } from '../archives/archives.service';
import { BorrowCatalogItem, ArchiveRepository } from '../archives/archive.repositories';
import { ContentIndexService } from '../archives/content/content-index.service';
import { ContentIndexRepository, EvidenceRow, ViewerScope } from '../archives/content/content-index.repositories';
import { MetadataTemplatesService } from '../templates/metadata-templates.service';
import { BorrowRequestRepository } from '../borrowing/borrowing.repositories';
import { BorrowRequestView, BorrowingService } from '../borrowing/borrowing.service';
import { ROLE_ADMIN, UserView } from '../common/roles';
import { PermKey, hasPermission } from '../common/permissions';
import { CatalogFieldSpec, ExtractedValue } from './catalog.extract';

/** 白名单工具名（只读 + 需确认执行）。审计与日志以此为准，不接受模型自定义名称。 */
export const AGENT_TOOL = {
  ARCHIVE_SEARCH: 'archive.search',
  ARCHIVE_DETAIL: 'archive.detail',
  BORROW_CATALOG: 'borrow.catalog',
  BORROW_ELIGIBILITY: 'borrow.eligibility',
  BORROW_PROGRESS: 'borrow.progress',
  CONTENT_READ: 'content.read',
  FIELD_EXTRACT: 'catalog.extract',
  BORROW_REQUEST_CREATE: 'borrow.request',
  ARCHIVE_CATALOG_SAVE: 'archive.catalog_save',
} as const;
export type AgentToolName = (typeof AGENT_TOOL)[keyof typeof AGENT_TOOL];

/** 需要用户确认后才可执行的工具（其余全部只读）。 */
export const CONFIRM_REQUIRED_TOOLS: AgentToolName[] = [
  AGENT_TOOL.BORROW_REQUEST_CREATE,
  AGENT_TOOL.ARCHIVE_CATALOG_SAVE,
];

export function isConfirmRequiredTool(name: string): boolean {
  return CONFIRM_REQUIRED_TOOLS.includes(name as AgentToolName);
}

/** 档案详情（含附件与动态著录值）：与现有详情接口返回结构一致。 */
export type AgentArchiveDetail = ReturnType<ArchivesService['getArchiveDetail']>;

/** 借阅资格检查结果：allowed=false 时 reasons 必须给出真实、可解释的原因。 */
export interface BorrowEligibility {
  allowed: boolean;
  archive: AgentArchiveDetail | null;
  /** 阻断申请的原因（权限/归属/重复申请等），全部来自真实业务判定。 */
  reasons: string[];
  /** 不阻断但需要如实告知的提示（如公开档案本已可见）。 */
  notices: string[];
  /** 已存在的待处理申请编号（若有），供用户直接查进度。 */
  pendingRequestId: number | null;
}

/** 借阅进度查询结果（数据范围由现有角色权限决定，不由模型决定）。 */
export interface BorrowProgressResult {
  allowed: boolean;
  deniedReason: string | null;
  /** mine = 本人申请；review = 审核视角（仅 borrowReview 角色，沿用既有审核列表口径）。 */
  scope: 'mine' | 'review';
  items: BorrowRequestView[];
  total: number;
}

/** 著录草稿的可写字段集合：固定字段 + 该分类绑定模板的启用信息项。 */
export const FIXED_CATALOG_FIELDS: Array<Omit<CatalogFieldSpec, 'fixed'>> = [
  { key: 'title', label: '档案标题', type: 'text', maxLength: 200 },
  { key: 'archiveType', label: '档案类型', type: 'select', options: [...ARCHIVE_TYPES], maxLength: 50 },
  { key: 'keywords', label: '关键词', type: 'text', maxLength: 200 },
  { key: 'formationDate', label: '形成时间', type: 'date', maxLength: 10 },
  { key: 'responsible', label: '责任者', type: 'text', maxLength: 100 },
  { key: 'remarks', label: '备注说明', type: 'textarea', maxLength: 500 },
];

/** 借阅期限上限：与现有借阅接口规则一致（1-90 天）。 */
const MAX_BORROW_DAYS = 90;
const MAX_PURPOSE_LENGTH = 500;

function parseJson<T>(raw: string, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

@Injectable()
export class AgentToolService {
  constructor(
    @Inject(ArchivesService) private readonly archives: ArchivesService,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(ArchiveRepository) private readonly archiveRepo: ArchiveRepository,
    @Inject(BorrowingService) private readonly borrowing: BorrowingService,
    @Inject(BorrowRequestRepository) private readonly borrowRequests: BorrowRequestRepository,
    @Inject(ContentIndexService) private readonly contentIndex: ContentIndexService,
    @Inject(ContentIndexRepository) private readonly contentUnits: ContentIndexRepository,
    @Inject(MetadataTemplatesService) private readonly templates: MetadataTemplatesService,
  ) {}

  // ==================== 只读工具 ====================

  /** 档案检索工具：完全复用既有检索（含可见性过滤），不自行拼 SQL。 */
  searchArchives(
    params: { keyword?: string; title?: string; archiveNo?: string; categoryId?: number; status?: string },
    operator: UserView,
    pageSize = 8,
  ): ArchiveView[] {
    this.assertPerm(operator, 'archiveView');
    const page = this.archives.searchArchives(
      {
        q: (params.keyword ?? '').slice(0, 100),
        title: params.title?.slice(0, 100),
        archiveNo: params.archiveNo?.slice(0, 100),
        categoryId: params.categoryId !== undefined ? String(params.categoryId) : '',
        includeSub: '1',
        status: params.status ?? '',
        page: '1',
        pageSize: String(Math.min(Math.max(pageSize, 1), 20)),
      },
      { id: operator.id, role: operator.role },
    );
    return page.items;
  }

  /** 档案详情工具：逐次通过既有访问控制（无权即 403/404，由上层转成诚实说明）。 */
  archiveDetail(archiveId: number, operator: UserView): AgentArchiveDetail | null {
    this.assertPerm(operator, 'archiveView');
    const id = positiveInt(archiveId, '档案');
    try {
      return this.archives.getArchiveDetail(id, operator);
    } catch (err) {
      if (err instanceof ForbiddenException || err instanceof NotFoundException) return null;
      throw err;
    }
  }

  /**
   * 借阅目录工具（只读）：复用既有「受限且当前用户尚未获得有效授权」的借阅目录接口。
   * 用途：受限档案不在常规检索的可见范围内，但借阅目录本身就是无权用户发起借阅申请的入口，
   * 因此 Agent 需要据此定位真实档案 ID（仍然不猜 ID、不返回正文，只返回目录级字段）。
   */
  borrowCatalog(operator: UserView, clue: { archiveNo?: string; keyword?: string }): BorrowCatalogItem[] {
    if (!hasPermission(operator.role, 'borrowRequest')) return [];
    const items = this.borrowing.borrowableCatalog(operator);
    const archiveNo = (clue.archiveNo ?? '').trim();
    const keyword = (clue.keyword ?? '').trim();
    if (!archiveNo && !keyword) return [];
    return items.filter((item) => {
      if (archiveNo) return item.archiveNo === archiveNo || item.archiveNo.startsWith(archiveNo);
      return `${item.title}${item.archiveNo}`.toLowerCase().includes(keyword.toLowerCase());
    });
  }

  /**
   * 借阅资格检查工具：复用现有借阅规则，不另设一套权限。
   * 现有真实规则 = 角色权限（borrowRequest）+ 档案存在 + 无待处理重复申请（申请本身仍由 BorrowingService 终局校验）
   * + 已持有有效借阅授权者无需重复申请。受限档案允许申请借阅（这正是借阅闭环的入口）。
   */
  borrowEligibility(archiveId: number, operator: UserView): BorrowEligibility {
    const reasons: string[] = [];
    const notices: string[] = [];
    let pendingRequestId: number | null = null;

    if (!hasPermission(operator.role, 'borrowRequest')) {
      reasons.push(`当前角色（${operator.roleLabel}）没有借阅申请权限，只能浏览档案目录信息`);
    }
    const id = positiveInt(archiveId, '档案');
    const row = this.archiveRepo.findById(id);
    if (!row) {
      reasons.push('档案不存在或已被删除');
      return { allowed: false, archive: null, reasons, notices, pendingRequestId };
    }
    if (reasons.length) {
      // 已判定无权：不再暴露更多档案信息（标题等仍由上层按其可见性决定是否展示）
      return { allowed: false, archive: null, reasons, notices, pendingRequestId };
    }

    const detail = this.archiveDetail(id, operator);
    if (!detail) {
      // 受限且未授权：允许申请借阅（既有借阅目录即为此场景）
      notices.push('该档案为受限档案，需经借阅审核通过后才能查看正文与下载附件');
    }

    const pending = this.borrowRequests.findPending(id, operator.id);
    if (pending) {
      reasons.push(`您对该档案已有待处理的借阅申请（#${pending.id}，待审核），请等待审核结果`);
      pendingRequestId = pending.id;
    }
    const grant = this.access.activeGrant(operator, id);
    if (grant) {
      notices.push(`您已获得该档案的借阅授权，有效期至 ${grant.expiresAt.slice(0, 10)}`);
    }
    if (detail && detail.accessLevel === 'public') {
      notices.push('该档案为公开档案，您现在即可查看目录与附件；如仍需借阅登记，可继续提交申请');
    }
    return { allowed: reasons.length === 0, archive: detail, reasons, notices, pendingRequestId };
  }

  /**
   * 借阅进度工具：数据范围严格沿用现有接口口径 ——
   * 本人记录 = listMine（角色需具备 borrowRequest）；他人记录仅 borrowReview 角色可见（审核列表）。
   * 借阅者/访客通过提示词或参数都拿不到别人的私有申请：这里根本不接收 userId 入参。
   */
  borrowProgress(
    operator: UserView,
    filter: { keyword?: string; status?: string; scope?: 'mine' | 'review'; limit?: number },
  ): BorrowProgressResult {
    const wantReview = filter.scope === 'review';
    if (wantReview && !hasPermission(operator.role, 'borrowReview')) {
      return {
        allowed: false,
        deniedReason: `当前角色（${operator.roleLabel}）无权查看他人的借阅申请，只能查询本人记录`,
        scope: 'mine',
        items: [],
        total: 0,
      };
    }
    if (!hasPermission(operator.role, 'borrowRequest')) {
      return {
        allowed: false,
        deniedReason: `当前角色（${operator.roleLabel}）没有借阅业务权限，无法查询借阅记录`,
        scope: 'mine',
        items: [],
        total: 0,
      };
    }
    const scope: 'mine' | 'review' = wantReview ? 'review' : 'mine';
    // 审核口径复用现有两个列表接口（待处理 + 已处理），不自定义新查询链路
    const raw =
      scope === 'review'
        ? [...this.borrowing.listForReview('pending'), ...this.borrowing.listForReview('')]
        : this.borrowing.listMine(operator);
    const keyword = (filter.keyword ?? '').trim();
    const statusKey = (filter.status ?? '').trim();
    const items = raw.filter((r) => {
      if (keyword) {
        const hay = `${r.archiveTitle}${r.archiveNo}${r.purpose}`.toLowerCase();
        if (!hay.includes(keyword.toLowerCase())) return false;
      }
      if (statusKey && statusKey !== r.status && statusKey !== r.statusLabel) return false;
      return true;
    });
    const limit = Math.min(Math.max(filter.limit ?? 8, 1), 20);
    return { allowed: true, deniedReason: null, scope, items: items.slice(0, limit), total: items.length };
  }

  /**
   * 附件内容读取工具：按当前用户权限取正文片段（复用第二阶段索引检索链路）。
   * 只返回与目标档案相关、且当前用户有权访问的片段；同时按需补齐历史附件的索引。
   */
  readContent(archiveIds: number[], operator: UserView, limit = 24): EvidenceRow[] {
    this.assertPerm(operator, 'archiveView');
    const allowed: number[] = [];
    for (const id of archiveIds) {
      try {
        this.access.assertView(operator, this.access.loadArchive(positiveInt(id, '档案')));
        allowed.push(id);
      } catch {
        continue; // 无权或不存在：直接排除，不进入取证范围
      }
    }
    if (!allowed.length) return [];
    for (const id of allowed) this.contentIndex.syncArchiveSafely(id, 'Agent 辅助著录');
    const scope: ViewerScope = { userId: operator.id, admin: operator.role === ROLE_ADMIN };
    return this.contentUnits.listChunksOfArchives(allowed, scope, limit);
  }

  /**
   * 元数据字段清单工具：只列系统里真实存在的字段
   * （档案固定著录字段 + 该分类绑定模板的启用信息项）；未绑定模板时仅返回固定字段。
   */
  catalogFieldSpecs(categoryId: number): CatalogFieldSpec[] {
    const specs: CatalogFieldSpec[] = FIXED_CATALOG_FIELDS.map((f) => ({ ...f, fixed: true }));
    const id = positiveInt(categoryId, '分类');
    for (const field of this.templates.activeFieldRowsByCategory(id)) {
      const options = parseJson<string[]>(field.optionsJson, []);
      const validation = parseJson<Record<string, unknown>>(field.validationJson, {});
      const maxLength =
        typeof validation.maxLength === 'number' && validation.maxLength > 0
          ? Math.min(validation.maxLength, 2000)
          : field.type === 'textarea'
            ? 500
            : 200;
      specs.push({
        key: field.fieldKey,
        label: field.label,
        type: field.type,
        fixed: false,
        options: Array.isArray(options) ? options.map(String) : undefined,
        required: field.required === 1,
        maxLength,
      });
    }
    return specs;
  }

  /** 现有该档案的真实著录值（区分原始数据与 AI 建议值）。 */
  currentCatalog(archiveId: number, operator: UserView) {
    const detail = this.archiveDetail(archiveId, operator);
    if (!detail) return null;
    return {
      title: detail.title,
      archiveType: detail.archiveType,
      keywords: detail.keywords,
      formationDate: detail.formationDate,
      responsible: detail.responsible,
      remarks: detail.remarks,
      dynamic: detail.dynamicFields.map((f) => ({ fieldKey: f.fieldKey, label: f.label, value: f.value })),
    };
  }

  // ==================== 需用户确认的业务工具 ====================

  /**
   * 创建借阅申请：直接调用现有借阅接口（其内部再次校验用途/期限/重复申请并写审计）。
   * archiveId 来自服务端保存的待确认草稿，绝不来自模型返回值。
   */
  createBorrowRequest(
    payload: { archiveId: number; purpose: string; days: number },
    operator: UserView,
  ): BorrowRequestView {
    this.assertPerm(operator, 'borrowRequest');
    const purpose = String(payload.purpose ?? '').trim();
    if (!purpose || purpose.length > MAX_PURPOSE_LENGTH) {
      throw new BadRequestException(`借阅用途需为 1-${MAX_PURPOSE_LENGTH} 个字符`);
    }
    const days = Number(payload.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_BORROW_DAYS) {
      throw new BadRequestException(`借阅期限需为 1-${MAX_BORROW_DAYS} 天`);
    }
    return this.borrowing.createRequest(
      { archiveId: positiveInt(payload.archiveId, '档案'), purpose, days },
      operator,
    );
  }

  /**
   * 保存用户确认后的档案著录信息：走现有创建/编辑接口，
   * 因此归档只读、创建者归属、字段校验等既有规则一律继续生效（不绕过）。
   */
  saveCatalog(
    payload: {
      mode: 'create' | 'update';
      archiveId?: number | null;
      categoryId: number;
      values: Record<string, string>;
    },
    operator: UserView,
  ): ArchiveView {
    this.assertPerm(operator, 'archiveManage');
    const values = payload.values ?? {};
    const categoryId = positiveInt(payload.categoryId, '分类');
    const fieldValues: Record<string, unknown> = {};
    const fixed: Record<string, string | null> = {};
    const specs = this.catalogFieldSpecs(categoryId);
    const dynamicKeys = new Set(specs.filter((s) => !s.fixed).map((s) => s.key));
    for (const [key, raw] of Object.entries(values)) {
      const value = raw === null || raw === undefined ? '' : String(raw).trim();
      if (key === 'categoryId') continue; // 分类由服务端草稿决定，不接受外部改写
      if (dynamicKeys.has(key)) fieldValues[key] = value;
      else fixed[key] = value;
    }
    const common = {
      title: String(fixed.title ?? '').trim(),
      categoryId,
      archiveType: String(fixed.archiveType ?? '').trim(),
      keywords: String(fixed.keywords ?? '').trim(),
      formationDate: String(fixed.formationDate ?? '').trim() || null,
      responsible: String(fixed.responsible ?? '').trim(),
      remarks: String(fixed.remarks ?? '').trim(),
      fieldValues,
    };
    if (!common.title) throw new BadRequestException('档案标题不能为空，请补充后再提交');
    if (payload.mode === 'update') {
      const id = positiveInt(payload.archiveId ?? NaN, '档案');
      return this.archives.updateArchive(id, common, operator);
    }
    return this.archives.createArchive(common, { id: operator.id, role: operator.role });
  }

  /** 编辑既有档案的前置判断：是否可编辑（沿用 canEdit + 归档只读规则），只读不写。 */
  canEditArchive(archiveId: number, operator: UserView): { editable: boolean; reason: string | null } {
    if (!hasPermission(operator.role, 'archiveManage')) {
      return { editable: false, reason: `当前角色（${operator.roleLabel}）没有档案著录权限` };
    }
    const row = this.archiveRepo.findById(archiveId);
    if (!row) return { editable: false, reason: '档案不存在或已被删除' };
    if (row.status === 'archived') return { editable: false, reason: '该档案已归档，著录信息不可修改' };
    if (!this.access.canEdit(operator, row, 'archiveManage')) {
      return { editable: false, reason: '仅管理员或该档案的创建者本人可编辑' };
    }
    return { editable: true, reason: null };
  }

  // ==================== 内部工具 ====================

  /** 角色矩阵复核：Agent 不放宽任何权限，缺权限直接 403。 */
  private assertPerm(operator: UserView, perm: PermKey): void {
    if (!hasPermission(operator.role, perm)) {
      throw new ForbiddenException(`当前角色（${operator.roleLabel}）无权执行该操作`);
    }
  }
}

/** 正整数入参校验（不接受模型给的字符串/负数/小数）。 */
export function positiveInt(raw: unknown, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BadRequestException(`${label}参数不合法`);
  return n;
}

/** 把业务异常翻译成面向用户的诚实说明（不谎报成功，也不泄露内部堆栈）。 */
export function describeToolError(err: unknown): string {
  if (err instanceof HttpException) {
    const response = err.getResponse();
    if (response && typeof response === 'object' && 'message' in response) {
      const message = (response as { message: unknown }).message;
      if (typeof message === 'string' && message.trim()) return message;
    }
    const status = err.getStatus();
    if (status === 403) return '当前账号没有执行该操作的权限';
    if (status === 404) return '目标数据不存在或已被删除';
    if (status === 409) return '该操作与现有业务状态冲突，请刷新后查看最新状态';
    return '业务服务拒绝了本次操作';
  }
  return '业务服务暂时不可用，本次操作未完成';
}

/** 供审计与展示复用的「AI 辅助」标记（区分用户主动操作与 AI 辅助操作）。 */
export function aiAssistDetail(tool: AgentToolName, extra: Record<string, unknown>): Record<string, unknown> {
  return { tool, aiAssisted: true, ...extra };
}

/** 抽取结果 → 可提交字段值（空值不写入，避免覆盖既有著录）。 */
export function extractedValuesToInput(fields: ExtractedValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) if (f.hasValue && f.value) out[f.key] = f.value;
  return out;
}
