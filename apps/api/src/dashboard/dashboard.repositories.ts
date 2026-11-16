/**
 * 数据大盘只读统计仓储（工作台数据大盘）。
 *
 * 设计约束：
 * - 全部为只读聚合查询，不写任何业务表，不修改正式数据；
 * - 档案口径复用 ArchiveAccessService 同一套可见性规则（public / 本人创建 / 未过期且有
 *   active 借阅授权的受限档案），非管理员无法通过统计接口推断受限档案的存在；
 * - 借阅口径由调用方明确传入：管理员/审核员为全局，其余角色只能是本人申请；
 * - 统计日期按服务器本地自然日切分（date(...,'localtime')），与用户看到的「最近 N 天」一致；
 * - SQL 一律参数化，不拼接任何用户输入。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';

/** 聚合查询入参（由服务层按角色权限确定，不接受前端直接指定）。 */
export interface DashboardRawQuery {
  /** 档案可见性过滤的操作者；null = 管理员，不做过滤（可见全部档案）。 */
  viewerId: number | null;
  /** 是否统计借阅数据（访客为 false，绝不返回任何借阅口径）。 */
  includeBorrow: boolean;
  /** 借阅申请人过滤；null = 全局（管理员/审核员），否则仅该用户本人的申请。 */
  borrowApplicantId: number | null;
  /** 是否统计档案利用数据（操作审计仅管理员可查）。 */
  includeUtilization: boolean;
  /** 统计起始自然日（含），格式 YYYY-MM-DD。 */
  fromDay: string;
  /** 统计截止自然日（含），格式 YYYY-MM-DD。 */
  toDay: string;
  /** 「即将到期」阈值天数（借阅授权有效期）。 */
  expiringWithinDays: number;
}

export interface StatusCountRaw {
  status: string;
  count: number;
}

export interface CategoryCountRaw {
  id: number | null;
  name: string;
  count: number;
}

export interface DailyCountRaw {
  day: string;
  count: number;
}

export interface UtilizationDailyRaw {
  day: string;
  action: string;
  count: number;
}

export interface DashboardRawData {
  /** 档案状态累计数（可见范围）。 */
  archiveStatusTotals: StatusCountRaw[];
  /** 档案状态在统计范围内的新增数（按创建时间）。 */
  archiveStatusInRange: StatusCountRaw[];
  /** 档案每日新增（可见范围）。 */
  archiveDaily: DailyCountRaw[];
  /** 分类分布（可见范围，按档案数量降序）。 */
  categoryCounts: CategoryCountRaw[];
  /** 借阅申请状态累计数。 */
  borrowStatusTotals: StatusCountRaw[];
  /** 借阅申请状态在统计范围内的新增数。 */
  borrowStatusInRange: StatusCountRaw[];
  /** 借阅申请每日新增。 */
  borrowDaily: DailyCountRaw[];
  /** 本人名下的草稿档案数（用于著录员待办）。 */
  ownDrafts: number;
  /** 本人名下即将到期（仍有效）的借阅授权数。 */
  expiringGrants: number;
  /** 审计动作每日计数（仅管理员）。 */
  utilizationDaily: UtilizationDailyRaw[];
}

export abstract class DashboardRepository {
  abstract snapshot(q: DashboardRawQuery): DashboardRawData;
}

/**
 * 非管理员的档案可见范围（与 archive.repositories.ts 的 ARCHIVE_VISIBILITY_SQL 保持一致）：
 * public 档案 / 本人创建 / 存在未过期且 active 的借阅授权。参数化：用户 id 两次。
 */
const ARCHIVE_VISIBILITY_SQL = `(
  a.access_level = 'public'
  OR a.created_by = ?
  OR EXISTS (
    SELECT 1 FROM borrow_grants g
    WHERE g.archive_id = a.id AND g.user_id = ?
      AND g.status = 'active' AND datetime(g.expires_at) > datetime('now')
  )
)`;

/** 统计范围内的时间条件（按本地自然日，含首尾两天）。 */
function inRangeSql(column: string): string {
  return `date(${column}, 'localtime') BETWEEN ? AND ?`;
}

@Injectable()
export class SqliteDashboardRepository implements DashboardRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  snapshot(q: DashboardRawQuery): DashboardRawData {
    const visibility =
      q.viewerId === null
        ? { sql: '1 = 1', args: [] as number[] }
        : { sql: ARCHIVE_VISIBILITY_SQL, args: [q.viewerId, q.viewerId] };
    const rangeArgs: Array<string | number> = [q.fromDay, q.toDay];

    return {
      archiveStatusTotals: this.statusCounts(
        `SELECT a.status AS status, COUNT(*) AS cnt
         FROM archives a WHERE ${visibility.sql} GROUP BY a.status`,
        visibility.args,
      ),
      archiveStatusInRange: this.statusCounts(
        `SELECT a.status AS status, COUNT(*) AS cnt
         FROM archives a
         WHERE ${visibility.sql} AND ${inRangeSql('a.created_at')}
         GROUP BY a.status`,
        [...visibility.args, ...rangeArgs],
      ),
      archiveDaily: this.dailyCounts(
        `SELECT date(a.created_at, 'localtime') AS day, COUNT(*) AS cnt
         FROM archives a
         WHERE ${visibility.sql} AND ${inRangeSql('a.created_at')}
         GROUP BY day ORDER BY day ASC`,
        [...visibility.args, ...rangeArgs],
      ),
      categoryCounts: this.categoryCounts(
        `SELECT a.category_id AS category_id, c.name AS name, COUNT(*) AS cnt
         FROM archives a LEFT JOIN archive_categories c ON c.id = a.category_id
         WHERE ${visibility.sql}
         GROUP BY a.category_id
         ORDER BY cnt DESC, a.category_id ASC`,
        visibility.args,
      ),
      borrowStatusTotals: q.includeBorrow
        ? this.statusCounts(
            `SELECT b.status AS status, COUNT(*) AS cnt
             FROM borrow_requests b WHERE ${this.borrowScope(q)} GROUP BY b.status`,
            this.borrowScopeArgs(q),
          )
        : [],
      borrowStatusInRange: q.includeBorrow
        ? this.statusCounts(
            `SELECT b.status AS status, COUNT(*) AS cnt
             FROM borrow_requests b
             WHERE ${this.borrowScope(q)} AND ${inRangeSql('b.created_at')}
             GROUP BY b.status`,
            [...this.borrowScopeArgs(q), ...rangeArgs],
          )
        : [],
      borrowDaily: q.includeBorrow
        ? this.dailyCounts(
            `SELECT date(b.created_at, 'localtime') AS day, COUNT(*) AS cnt
             FROM borrow_requests b
             WHERE ${this.borrowScope(q)} AND ${inRangeSql('b.created_at')}
             GROUP BY day ORDER BY day ASC`,
            [...this.borrowScopeArgs(q), ...rangeArgs],
          )
        : [],
      ownDrafts:
        q.viewerId === null
          ? 0
          : this.scalar(
              "SELECT COUNT(*) AS cnt FROM archives WHERE created_by = ? AND status = 'draft'",
              [q.viewerId],
            ),
      expiringGrants:
        q.viewerId === null
          ? 0
          : this.scalar(
              `SELECT COUNT(*) AS cnt FROM borrow_grants
               WHERE user_id = ? AND status = 'active'
                 AND datetime(expires_at) > datetime('now')
                 AND datetime(expires_at) <= datetime('now', ?)`,
              [q.viewerId, `+${Math.max(1, q.expiringWithinDays)} days`],
            ),
      utilizationDaily: q.includeUtilization
        ? this.utilization(
            `SELECT date(created_at, 'localtime') AS day, action, COUNT(*) AS cnt
             FROM audit_logs
             WHERE action IN ('file.preview', 'file.download', 'borrow.request')
               AND result = 'success' AND ${inRangeSql('created_at')}
             GROUP BY day, action ORDER BY day ASC`,
            rangeArgs,
          )
        : [],
    };
  }

  private borrowScope(q: DashboardRawQuery): string {
    return q.borrowApplicantId === null ? '1 = 1' : 'b.applicant_id = ?';
  }

  private borrowScopeArgs(q: DashboardRawQuery): number[] {
    return q.borrowApplicantId === null ? [] : [q.borrowApplicantId];
  }

  private scalar(sql: string, args: Array<string | number>): number {
    const row = this.db.prepare(sql).get(...args) as unknown as
      | { cnt: number | bigint }
      | undefined;
    return row ? Number(row.cnt) : 0;
  }

  private statusCounts(sql: string, args: Array<string | number>): StatusCountRaw[] {
    const rows = this.db.prepare(sql).all(...args) as unknown as Array<{
      status: string;
      cnt: number | bigint;
    }>;
    return rows.map((r) => ({ status: String(r.status), count: Number(r.cnt) }));
  }

  private dailyCounts(sql: string, args: Array<string | number>): DailyCountRaw[] {
    const rows = this.db.prepare(sql).all(...args) as unknown as Array<{
      day: string;
      cnt: number | bigint;
    }>;
    return rows.map((r) => ({ day: String(r.day), count: Number(r.cnt) }));
  }

  private categoryCounts(sql: string, args: number[]): CategoryCountRaw[] {
    const rows = this.db.prepare(sql).all(...args) as unknown as Array<{
      category_id: number | bigint | null;
      name: string | null;
      cnt: number | bigint;
    }>;
    return rows.map((r) => ({
      id: r.category_id === null ? null : Number(r.category_id),
      name: r.name === null ? '未分类' : String(r.name),
      count: Number(r.cnt),
    }));
  }

  private utilization(sql: string, args: Array<string | number>): UtilizationDailyRaw[] {
    const rows = this.db.prepare(sql).all(...args) as unknown as Array<{
      day: string;
      action: string;
      cnt: number | bigint;
    }>;
    return rows.map((r) => ({
      day: String(r.day),
      action: String(r.action),
      count: Number(r.cnt),
    }));
  }
}
