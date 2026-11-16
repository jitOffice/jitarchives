/**
 * Agent 统一检索第二批业务范围聚合。
 * 只读复用既有借阅、审计、模板和工作台统计服务；权限始终由服务端当前会话用户决定。
 */
import { Injectable } from '@nestjs/common';
import { hasPermission } from '../common/permissions';
import { ROLE_LABELS, UserView } from '../common/roles';
import { BorrowingService, BorrowRequestView } from '../borrowing/borrowing.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTION_LABELS } from '../audit/audit.presentation';
import { MetadataTemplatesService, TemplateDetailView } from '../templates/metadata-templates.service';
import { DashboardRangeKey, DashboardService } from '../dashboard/dashboard.service';
import { SearchScope, SearchTimeRange } from './intent.parser';

export interface UnifiedAuditHit {
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

export interface UnifiedTemplateHit {
  id: number;
  name: string;
  description: string;
  status: 'active' | 'disabled';
  statusLabel: string;
  fieldCount: number;
  fields: Array<{ fieldKey: string; label: string; type: string; required: boolean; active: boolean }>;
  boundCategories: Array<{ id: number; name: string; code: string }>;
}

export interface UnifiedStatsHit {
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

export interface UnifiedBusinessSearchResult {
  borrowings: { total: number; shown: number; scope: 'mine' | 'review' | null; items: BorrowRequestView[] };
  audits: { total: number; shown: number; items: UnifiedAuditHit[] };
  templates: { total: number; shown: number; items: UnifiedTemplateHit[] };
  statistics: UnifiedStatsHit | null;
  restrictedScopes: Array<{ scope: SearchScope; label: string; reason: string }>;
  totalHits: number;
}

export interface UnifiedBusinessSearchInput {
  actorName?: string;
  actions?: string[];
  archiveIds?: number[];
  from?: string;
  to?: string;
  page?: number;
  categoryId?: number;
  scopes: SearchScope[];
  keyword?: string;
  title?: string;
  archiveNo?: string;
  borrowStatus?: string;
  timeRange?: SearchTimeRange;
  limit: number;
}

function resolveTimeBounds(range: SearchTimeRange | undefined, defaultRange?: SearchTimeRange): { from?: string; to?: string } {
  const selected = range ?? defaultRange;
  if (!selected) return {};
  const now = new Date();
  if (selected === 'today') {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    return { from: from.toISOString(), to: now.toISOString() };
  }
  if (selected === 'yesterday') {
    const from = new Date(now);
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setHours(23, 59, 59, 999);
    return { from: from.toISOString(), to: to.toISOString() };
  }
  const days = selected === '7d' ? 7 : selected === '90d' ? 90 : 30;
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: now.toISOString() };
}

function statsRange(range?: SearchTimeRange): DashboardRangeKey {
  return range === '7d' ? '7d' : range === '90d' ? '90d' : '30d';
}

function searchTerm(input: UnifiedBusinessSearchInput): string | undefined {
  const value = String(input.keyword ?? input.title ?? input.archiveNo ?? '').trim();
  return value ? value.slice(0, 100) : undefined;
}

@Injectable()
export class AgentUnifiedBusinessSearchService {
  constructor(
    private readonly borrowing: BorrowingService,
    private readonly audit: AuditService,
    private readonly templates: MetadataTemplatesService,
    private readonly dashboard: DashboardService,
  ) {}

  search(input: UnifiedBusinessSearchInput, operator: UserView): UnifiedBusinessSearchResult {
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit) || 8));
    const term = searchTerm(input);
    const result: UnifiedBusinessSearchResult = {
      borrowings: { total: 0, shown: 0, scope: null, items: [] },
      audits: { total: 0, shown: 0, items: [] },
      templates: { total: 0, shown: 0, items: [] },
      statistics: null,
      restrictedScopes: [],
      totalHits: 0,
    };

    if (input.scopes.includes('borrow')) {
      if (!hasPermission(operator.role, 'borrowRequest') && !hasPermission(operator.role, 'borrowReview')) {
        result.restrictedScopes.push({ scope: 'borrow', label: '借阅记录', reason: '当前角色无权检索借阅记录' });
      } else {
        const bounds = resolveTimeBounds(input.timeRange);
        const page = this.borrowing.searchForAgent(
          {
            keyword: term,
            status: input.borrowStatus,
            from: bounds.from,
            to: bounds.to,
            page: 1,
            pageSize: limit,
          },
          operator,
        );
        result.borrowings = { total: page.total, shown: page.items.length, scope: page.scope, items: page.items };
      }
    }

    if (input.scopes.includes('audit')) {
      if (!hasPermission(operator.role, 'auditView')) {
        result.restrictedScopes.push({ scope: 'audit', label: '操作审计', reason: '操作审计仅向管理员开放' });
      } else {
        // Broad audit queries default to 30 days; a resolved archive history can inspect its full lifetime.
        const bounds = resolveTimeBounds(input.timeRange, input.archiveIds ? undefined : '30d');
        const actions = term
          ? Object.entries(AUDIT_ACTION_LABELS)
              .filter(([key, label]) => label.includes(term) || key.toLowerCase().includes(term.toLowerCase()))
              .map(([key]) => key)
          : [];
        const page = this.audit.query({
          keyword: term,
          actions: input.actions ?? actions,
          strictActions: input.actions !== undefined,
          actorName: input.actorName,
          archiveIds: input.archiveIds,
          from: input.from ?? bounds.from,
          to: input.to ?? bounds.to,
          page: input.page ?? 1,
          pageSize: limit,
        });
        result.audits = {
          total: page.total,
          shown: page.items.length,
          items: page.items.map((row) => ({
            id: row.id,
            actorName: row.actorName,
            actorRoleLabel: row.actorRole ? (ROLE_LABELS as Record<string, string>)[row.actorRole] ?? row.actorRole : '未知',
            actionLabel: row.actionLabel,
            objectTypeLabel: row.objectTypeLabel,
            objectLabel: row.objectLabel,
            objectRef: row.objectRef,
            result: row.result,
            resultLabel: row.result === 'success' ? '成功' : '失败',
            summary: row.summary.filter((part) => part.kind === 'text').map((part) => part.kind === 'text' ? part.text : '').join(''),
            createdAt: row.createdAt,
          })),
        };
      }
    }

    if (input.scopes.includes('template')) {
      if (!hasPermission(operator.role, 'templateView')) {
        result.restrictedScopes.push({ scope: 'template', label: '元数据模板', reason: '当前角色无权查看元数据模板及字段定义' });
      } else {
        const all = this.templates.listTemplates();
        const matched: UnifiedTemplateHit[] = [];
        for (const item of all) {
          const detail: TemplateDetailView = this.templates.getTemplate(item.id);
          if (input.categoryId && !detail.boundCategories.some(category => category.id === input.categoryId)) continue;
          const templateMatches = !term || [detail.name, detail.description].some((v) => v.toLowerCase().includes(term.toLowerCase()));
          const matchingFields = detail.fields.filter((field) =>
            !term || templateMatches || [field.label, field.fieldKey, field.type].some((v) => v.toLowerCase().includes(term.toLowerCase())),
          );
          const categoryMatches = detail.boundCategories.some((category) =>
            !term || [category.name, category.code].some((v) => v.toLowerCase().includes(term.toLowerCase())),
          );
          if (term && !templateMatches && matchingFields.length === 0 && !categoryMatches) continue;
          matched.push({
            id: detail.id,
            name: detail.name,
            description: detail.description,
            status: detail.status,
            statusLabel: detail.status === 'active' ? '启用' : '停用',
            fieldCount: detail.fieldCount,
            fields: matchingFields.map((field) => ({
              fieldKey: field.fieldKey,
              label: field.label,
              type: field.type,
              required: field.required,
              active: field.active,
            })),
            boundCategories: detail.boundCategories.map((category) => ({ id: category.id, name: category.name, code: category.code })),
          });
        }
        const items = matched.slice(((input.page ?? 1) - 1) * limit, (input.page ?? 1) * limit);
        result.templates = { total: matched.length, shown: items.length, items };
      }
    }

    if (input.scopes.includes('stats')) {
      if (!hasPermission(operator.role, 'archiveView')) {
        result.restrictedScopes.push({ scope: 'stats', label: '档案统计', reason: '当前角色无权查看档案统计' });
      } else {
        const stats = this.dashboard.stats(operator, statsRange(input.timeRange));
        result.statistics = {
          rangeLabel: stats.range.label,
          archiveScopeLabel: stats.scope.archiveScopeLabel,
          borrowScopeLabel: stats.scope.borrowScopeLabel,
          note: stats.scope.note,
          metrics: stats.metrics.map((metric) => ({
            key: metric.key,
            label: metric.label,
            unit: metric.unit,
            total: metric.total,
            period: metric.period,
            available: metric.available,
            hint: metric.hint,
          })),
          statuses: stats.statuses.items.map((item) => ({ key: item.key, label: item.label, count: item.count })),
          categories: stats.categories.items.map((item) => ({ label: item.name, count: item.count, ratio: item.ratio })),
          borrow: {
            available: stats.borrow.available,
            reason: stats.borrow.reason,
            total: stats.borrow.total,
            pending: stats.borrow.pending,
            periodTotal: stats.borrow.periodTotal,
            scopeLabel: stats.borrow.scopeLabel,
          },
          utilization: {
            available: stats.utilization.available,
            reason: stats.utilization.reason,
            previewTotal: stats.utilization.totals.preview,
            downloadTotal: stats.utilization.totals.download,
          },
        };
      }
    }

    result.totalHits =
      result.borrowings.total + result.audits.total + result.templates.total + (result.statistics ? 1 : 0);
    return result;
  }
}
