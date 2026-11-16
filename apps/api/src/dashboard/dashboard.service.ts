/**
 * 数据大盘服务（工作台）。
 *
 * 职责：把仓储层的真实聚合结果，按「当前登录角色的权限范围」组装成前端可读的中文口径，
 * 并明确区分「累计总量」与「时间范围内新增量」。
 *
 * 权限口径（与 common/permissions.ts 一致，统计接口绝不越权）：
 * - 档案：管理员为全库；其他角色沿用档案可见性规则（公开 / 本人创建 / 有效借阅授权），
 *   因此受限档案不会通过分类占比、趋势、总量等统计被间接推断；
 * - 借阅：管理员与审核员为全局统计（审核需要）；著录员/借阅者仅统计本人申请；访客不参与借阅；
 * - 档案利用（预览/下载）：数据来自操作审计，审计查询仅管理员，故仅管理员展示。
 */
import { Inject, Injectable } from '@nestjs/common';
import { DashboardRepository, DashboardRawData } from './dashboard.repositories';
import { ROLE_LABELS, UserView } from '../common/roles';
import { hasPermission } from '../common/permissions';

/** 可选统计时间范围（自然日，含今天）。 */
export const DASHBOARD_RANGES = {
  '7d': { days: 7, label: '最近 7 天' },
  '30d': { days: 30, label: '最近 30 天' },
  '90d': { days: 90, label: '最近 90 天' },
} as const;

export type DashboardRangeKey = keyof typeof DASHBOARD_RANGES;

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
  role: string;
  roleLabel: string;
  /** 档案统计口径：system=全库，visible=当前账号可见范围。 */
  archiveScope: 'system' | 'visible';
  archiveScopeLabel: string;
  /** 借阅统计口径：all=全部申请，own=本人申请，none=不参与借阅。 */
  borrowScope: 'all' | 'own' | 'none';
  borrowScopeLabel: string;
  /** 页面提示语（中文，直接展示）。 */
  note: string;
}

export interface DashboardMetricView {
  key: 'archives' | 'archived' | 'draft' | 'borrowPending';
  label: string;
  unit: string;
  /** 累计量（借阅指标为当前待审核量）；null 表示当前角色无该口径。 */
  total: number | null;
  totalLabel: string;
  /** 统计范围内的新增量；null 表示当前角色无该口径。 */
  period: number | null;
  periodLabel: string;
  available: boolean;
  hint: string;
}

export interface DashboardTrendPointView {
  day: string;
  count: number;
}

export interface DashboardTrendView {
  points: DashboardTrendPointView[];
  periodTotal: number;
  hint: string;
}

export interface DashboardBreakdownItemView {
  key: string;
  label: string;
  count: number;
  /** 占比（0-1，保留三位小数）。 */
  ratio: number;
}

export interface DashboardCategoryItemView {
  id: number | null;
  name: string;
  count: number;
  ratio: number;
}

export interface DashboardCategoryView {
  total: number;
  items: DashboardCategoryItemView[];
  /** 是否把长尾分类合并为「其他」，避免图例过长。 */
  truncated: boolean;
}

export interface DashboardBorrowView {
  available: boolean;
  reason: string;
  scopeLabel: string;
  total: number;
  pending: number;
  periodTotal: number;
  items: DashboardBreakdownItemView[];
  trend: DashboardTrendPointView[];
}

export interface DashboardUtilizationPointView {
  day: string;
  preview: number;
  download: number;
  borrow: number;
}

export interface DashboardUtilizationView {
  available: boolean;
  reason: string;
  sourceLabel: string;
  totals: { preview: number; download: number; borrow: number };
  series: DashboardUtilizationPointView[];
}

export interface DashboardTodoView {
  key: string;
  label: string;
  count: number;
  hint: string;
  /** 站内跳转路径（均为已实现页面）。 */
  to: string;
}

export interface DashboardStatusView {
  total: number;
  items: DashboardBreakdownItemView[];
}

export interface DashboardStatsView {
  generatedAt: string;
  range: DashboardRangeView;
  scope: DashboardScopeView;
  metrics: DashboardMetricView[];
  archiveTrend: DashboardTrendView;
  categories: DashboardCategoryView;
  statuses: DashboardStatusView;
  borrow: DashboardBorrowView;
  utilization: DashboardUtilizationView;
  todos: DashboardTodoView[];
}

/** 分类环形图最多展示的分类数，其余合并为「其他」。 */
const MAX_CATEGORY_SLICES = 8;
/** 借阅授权「即将到期」判定阈值（天）。 */
const EXPIRING_WITHIN_DAYS = 3;

const BORROW_STATUS_ORDER = [
  'pending',
  'approved',
  'rejected',
  'returned',
  'expired',
  'cancelled',
] as const;

const BORROW_STATUS_LABELS: Record<string, string> = {
  pending: '待审核',
  approved: '已通过（借阅中）',
  rejected: '已拒绝',
  returned: '已归还',
  expired: '已过期',
  cancelled: '已取消',
};

const ARCHIVE_STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  archived: '已归档',
};

@Injectable()
export class DashboardService {
  constructor(@Inject(DashboardRepository) private readonly repo: DashboardRepository) {}

  stats(user: UserView, rangeKey?: string): DashboardStatsView {
    const range = resolveRange(rangeKey);
    const isAdmin = user.role === 'admin';
    const canBorrow = hasPermission(user.role, 'borrowRequest');
    const canReview = hasPermission(user.role, 'borrowReview');
    const canAudit = hasPermission(user.role, 'auditView');

    const raw = this.repo.snapshot({
      viewerId: isAdmin ? null : user.id,
      includeBorrow: canBorrow,
      borrowApplicantId: canBorrow && !canReview ? user.id : null,
      includeUtilization: canAudit,
      fromDay: range.fromDay,
      toDay: range.toDay,
      expiringWithinDays: EXPIRING_WITHIN_DAYS,
    });

    const days = daySeries(range.fromDay, range.toDay);
    const statuses = buildStatusView(raw);
    const borrow = this.buildBorrowView(raw, days, user, canBorrow, canReview);
    const statusMap = toCountMap(raw.archiveStatusTotals);
    const periodStatusMap = toCountMap(raw.archiveStatusInRange);

    return {
      generatedAt: new Date().toISOString(),
      range,
      scope: buildScope(user, isAdmin, canBorrow, canReview),
      metrics: buildMetrics(
        range,
        isAdmin,
        canBorrow,
        canReview,
        statusMap,
        periodStatusMap,
        borrow,
      ),
      archiveTrend: {
        points: fillDaily(days, raw.archiveDaily),
        periodTotal: sumValues(raw.archiveStatusInRange.map((r) => r.count)),
        hint: '按档案创建日期统计每日新增数量（含草稿与已归档）。',
      },
      categories: buildCategories(raw, statuses.total),
      statuses,
      borrow: {
        available: borrow.available,
        reason: borrow.reason,
        scopeLabel: borrow.scopeLabel,
        total: borrow.total,
        pending: borrow.pending,
        periodTotal: sumValues(raw.borrowStatusInRange.map((r) => r.count)),
        items: borrow.items,
        trend: borrow.trend,
      },
      utilization: this.buildUtilization(raw, days, canAudit),
      todos: buildTodos(user, raw, statusMap, borrow, isAdmin, canReview),
    };
  }

  private buildBorrowView(
    raw: DashboardRawData,
    days: string[],
    user: UserView,
    canBorrow: boolean,
    canReview: boolean,
  ) {
    const scopeLabel = !canBorrow
      ? '当前角色不参与借阅'
      : canReview
        ? '全部借阅申请'
        : '本人借阅申请';
    if (!canBorrow) {
      return {
        available: false,
        reason: '访客角色不参与借阅，未展示借阅统计数据。',
        scopeLabel,
        total: 0,
        pending: 0,
        items: [] as DashboardBreakdownItemView[],
        trend: [] as DashboardTrendPointView[],
      };
    }
    const counts = toCountMap(raw.borrowStatusTotals);
    const total = sumValues(raw.borrowStatusTotals.map((r) => r.count));
    const items = BORROW_STATUS_ORDER.map((status) => ({
      key: status,
      label: BORROW_STATUS_LABELS[status] ?? status,
      count: counts.get(status) ?? 0,
      ratio: ratio(counts.get(status) ?? 0, total),
    }));
    return {
      available: true,
      reason: '',
      scopeLabel: `${scopeLabel}（${ROLE_LABELS[user.role]}口径）`,
      total,
      pending: counts.get('pending') ?? 0,
      items,
      trend: fillDaily(days, raw.borrowDaily),
    };
  }

  private buildUtilization(
    raw: DashboardRawData,
    days: string[],
    canAudit: boolean,
  ): DashboardUtilizationView {
    if (!canAudit) {
      return {
        available: false,
        reason: '档案利用数据来自系统操作审计，仅管理员可查看预览与下载情况。',
        sourceLabel: '系统操作审计',
        totals: { preview: 0, download: 0, borrow: 0 },
        series: [],
      };
    }
    const totals = { preview: 0, download: 0, borrow: 0 };
    const series = days.map((day) => {
      const point = { day, preview: 0, download: 0, borrow: 0 };
      for (const row of raw.utilizationDaily) {
        if (row.day !== day) continue;
        if (row.action === 'file.preview') point.preview += row.count;
        else if (row.action === 'file.download') point.download += row.count;
        else if (row.action === 'borrow.request') point.borrow += row.count;
      }
      totals.preview += point.preview;
      totals.download += point.download;
      totals.borrow += point.borrow;
      return point;
    });
    return {
      available: true,
      reason: '',
      sourceLabel: '来源：系统操作审计（仅统计成功事件）',
      totals,
      series,
    };
  }
}

// ---------- 组装辅助 ----------

function resolveRange(rangeKey?: string): DashboardRangeView {
  const key = (rangeKey && rangeKey in DASHBOARD_RANGES ? rangeKey : '30d') as DashboardRangeKey;
  const def = DASHBOARD_RANGES[key];
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (def.days - 1));
  return {
    key,
    days: def.days,
    label: def.label,
    fromDay: localDay(from),
    toDay: localDay(now),
  };
}

function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 生成连续自然日序列（含首尾），保证趋势图没有断点。 */
function daySeries(fromDay: string, toDay: string): string[] {
  const [fy, fm, fd] = fromDay.split('-').map(Number);
  const [ty, tm, td] = toDay.split('-').map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  const out: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function toCountMap(rows: Array<{ status: string; count: number }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.status, (map.get(r.status) ?? 0) + r.count);
  return map;
}

function dailyValue(rows: Array<{ day: string; count: number }>, day: string): number {
  return rows.find((r) => r.day === day)?.count ?? 0;
}

function fillDaily(
  days: string[],
  rows: Array<{ day: string; count: number }>,
): DashboardTrendPointView[] {
  return days.map((day) => ({ day, count: dailyValue(rows, day) }));
}

function sumValues(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0);
}

function ratio(count: number, total: number): number {
  if (!total) return 0;
  return Math.round((count / total) * 1000) / 1000;
}

function buildStatusView(raw: DashboardRawData): DashboardStatusView {
  const counts = toCountMap(raw.archiveStatusTotals);
  const total = sumValues(raw.archiveStatusTotals.map((r) => r.count));
  return {
    total,
    items: ['archived', 'draft'].map((status) => ({
      key: status,
      label: ARCHIVE_STATUS_LABELS[status] ?? status,
      count: counts.get(status) ?? 0,
      ratio: ratio(counts.get(status) ?? 0, total),
    })),
  };
}

function buildCategories(raw: DashboardRawData, total: number): DashboardCategoryView {
  const sorted = [...raw.categoryCounts].sort((a, b) => b.count - a.count);
  const head = sorted.slice(0, MAX_CATEGORY_SLICES);
  const rest = sorted.slice(MAX_CATEGORY_SLICES);
  const items: DashboardCategoryItemView[] = head.map((c) => ({
    id: c.id,
    name: c.name,
    count: c.count,
    ratio: ratio(c.count, total),
  }));
  if (rest.length > 0) {
    const restCount = sumValues(rest.map((c) => c.count));
    items.push({
      id: null,
      name: `其他 ${rest.length} 个分类`,
      count: restCount,
      ratio: ratio(restCount, total),
    });
  }
  return { total, items, truncated: rest.length > 0 };
}

function buildScope(
  user: UserView,
  isAdmin: boolean,
  canBorrow: boolean,
  canReview: boolean,
): DashboardScopeView {
  const archiveScope: 'system' | 'visible' = isAdmin ? 'system' : 'visible';
  const borrowScope: 'all' | 'own' | 'none' = !canBorrow ? 'none' : canReview ? 'all' : 'own';
  const notes: Record<string, string> = {
    admin: '当前为系统全局口径：可查看全部档案、全部分类与全部借阅申请。',
    reviewer: '档案按您的可见范围统计；借阅审批为全局口径，可查看全部申请。',
    cataloger: '档案按您的可见范围统计；借阅仅统计您本人提交的申请。',
    borrower: '档案按您的可见范围统计；借阅仅统计您本人提交的申请。',
    guest: '访客仅统计公开档案；不参与借阅，故不展示借阅数据。',
  };
  return {
    role: user.role,
    roleLabel: ROLE_LABELS[user.role],
    archiveScope,
    archiveScopeLabel: isAdmin ? '全库档案' : '当前账号可见范围',
    borrowScope,
    borrowScopeLabel: !canBorrow ? '不参与借阅' : canReview ? '全部借阅申请' : '本人借阅申请',
    note: notes[user.role] ?? '按当前账号权限范围统计。',
  };
}

function buildMetrics(
  range: DashboardRangeView,
  isAdmin: boolean,
  canBorrow: boolean,
  canReview: boolean,
  statusMap: Map<string, number>,
  periodMap: Map<string, number>,
  borrow: { pending: number; total: number; available: boolean },
): DashboardMetricView[] {
  const archived = statusMap.get('archived') ?? 0;
  const draft = statusMap.get('draft') ?? 0;
  const periodArchived = periodMap.get('archived') ?? 0;
  const periodDraft = periodMap.get('draft') ?? 0;
  const periodTotal = periodArchived + periodDraft;
  const archiveHint = isAdmin
    ? '统计系统内全部档案（含受限档案）。'
    : '仅统计当前账号可见的档案：公开档案、本人创建档案及已获授权的借阅档案。';
  const borrowHint = !canBorrow
    ? '访客角色不参与借阅，无借阅统计口径。'
    : canReview
      ? '统计系统内全部借阅申请，审核工作在此处汇总。'
      : '仅统计您本人提交的借阅申请。';

  return [
    {
      key: 'archives',
      label: '档案总数',
      unit: '篇',
      total: archived + draft,
      totalLabel: '累计档案',
      period: periodTotal,
      periodLabel: `${range.label}新增`,
      available: true,
      hint: archiveHint,
    },
    {
      key: 'archived',
      label: '已归档',
      unit: '篇',
      total: archived,
      totalLabel: '累计已归档',
      period: periodArchived,
      periodLabel: '期内新增并归档',
      available: true,
      hint: '状态为「已归档」的档案，归档后著录信息只读。',
    },
    {
      key: 'draft',
      label: '草稿',
      unit: '篇',
      total: draft,
      totalLabel: '累计草稿',
      period: periodDraft,
      periodLabel: '期内新增草稿',
      available: true,
      hint: '状态为「草稿」的档案，可继续著录后提交归档。',
    },
    {
      key: 'borrowPending',
      label: '待审核借阅',
      unit: '条',
      total: canBorrow ? borrow.pending : null,
      totalLabel: '当前待审核',
      period: canBorrow ? borrow.total : null,
      periodLabel: '累计申请量',
      available: canBorrow,
      hint: borrowHint,
    },
  ];
}

function buildTodos(
  user: UserView,
  raw: DashboardRawData,
  statusMap: Map<string, number>,
  borrow: { pending: number; available: boolean },
  isAdmin: boolean,
  canReview: boolean,
): DashboardTodoView[] {
  if (user.role === 'guest') return [];
  const todos: DashboardTodoView[] = [];

  if (!isAdmin && !canReview && borrow.available) {
    todos.push({
      key: 'my-pending-borrow',
      label: '我提交的待审核借阅',
      count: borrow.pending,
      hint: '审核通过后即可在有效期内查阅受限档案。',
      to: '/borrow/mine',
    });
  }
  if (canReview) {
    todos.push({
      key: 'pending-borrow',
      label: '待审核借阅申请',
      count: borrow.pending,
      hint: '请及时处理申请，避免申请人长时间等待。',
      to: '/borrow/review',
    });
  }

  if (user.role === 'cataloger') {
    todos.push({
      key: 'my-drafts',
      label: '我的草稿档案',
      count: raw.ownDrafts,
      hint: '补全著录信息并提交归档后即可对外提供利用。',
      to: '/archives',
    });
  } else if (isAdmin || canReview) {
    todos.push({
      key: 'drafts',
      label: '草稿档案待归档',
      count: statusMap.get('draft') ?? 0,
      hint: '草稿状态档案需完成著录后归档，归档后只读。',
      to: '/archives',
    });
  }

  if (raw.expiringGrants > 0) {
    todos.push({
      key: 'expiring-grants',
      label: '即将到期的借阅授权',
      count: raw.expiringGrants,
      hint: '授权将在 3 天内到期，如需继续查阅请提前续借。',
      to: '/borrow/mine',
    });
  }
  // 只保留真正需要处理的事项；全为 0 时由前端展示「暂无待办」。
  return todos.filter((t) => t.count > 0);
}
