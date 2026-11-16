/**
 * 借阅申请与档案级借阅授权仓储（阶段二第四批）。
 * 沿用既有仓储模式：抽象类作为 DI Token，SQLite 实现绑定集中在模块，SQL 一律参数化。
 * 借阅授权（borrow_grants）同时被 ArchiveAccessService 复用，作为受限档案的受控访问依据。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { SqliteTransaction } from '../db/transaction';

export type BorrowStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'expired'
  | 'cancelled';

export type GrantStatus = 'active' | 'revoked' | 'expired' | 'returned';

export interface BorrowRequestRow {
  id: number;
  archiveId: number;
  applicantId: number;
  purpose: string;
  days: number;
  startAt: string | null;
  dueAt: string | null;
  status: BorrowStatus;
  reviewNote: string;
  reviewerId: number | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // JOIN 展示字段
  archiveTitle?: string;
  archiveNo?: string;
  archiveAccessLevel?: string;
  applicantName?: string;
  applicantRole?: string;
  reviewerName?: string;
}

export interface BorrowSearchParams {
  applicantId?: number;
  status?: BorrowStatus;
  keyword?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

export interface BorrowSearchPage {
  items: BorrowRequestRow[];
  total: number;
}

export interface BorrowGrantRow {
  id: number;
  borrowId: number;
  archiveId: number;
  userId: number;
  canView: number;
  canDownload: number;
  grantedAt: string;
  expiresAt: string;
  status: GrantStatus;
  updatedAt: string;
}

// ---------- 借阅申请仓储 ----------

export abstract class BorrowRequestRepository {
  abstract insert(input: {
    archiveId: number;
    applicantId: number;
    purpose: string;
    days: number;
  }): BorrowRequestRow;
  abstract findById(id: number): BorrowRequestRow | undefined;
  abstract listByApplicant(applicantId: number): BorrowRequestRow[];
  abstract listByStatus(status: BorrowStatus | ''): BorrowRequestRow[];
  /** Agent 只读检索：所有过滤、排序与分页均在 SQL 层完成；申请人范围由服务端注入。 */
  abstract search(params: BorrowSearchParams): BorrowSearchPage;
  abstract findPending(archiveId: number, applicantId: number): BorrowRequestRow | undefined;
  /**
   * 状态流转（条件更新，用于并发/重复审批防护）：
   * 仅当当前状态等于 expectStatus 时更新，返回是否命中（changes>0）。
   */
  abstract transition(
    id: number,
    expectStatus: BorrowStatus,
    patch: Partial<BorrowRequestRow>,
  ): boolean;
}

const BORROW_COLUMNS = `
  b.id, b.archive_id, b.applicant_id, b.purpose, b.days, b.start_at, b.due_at, b.status,
  b.review_note, b.reviewer_id, b.reviewed_at, b.created_at, b.updated_at,
  a.title AS archive_title, a.archive_no AS archive_no, a.access_level AS archive_access_level,
  ua.display_name AS applicant_name, ua.role AS applicant_role, ur.display_name AS reviewer_name`;

const BORROW_FROM = `
  FROM borrow_requests b
  LEFT JOIN archives a ON a.id = b.archive_id
  LEFT JOIN users ua ON ua.id = b.applicant_id
  LEFT JOIN users ur ON ur.id = b.reviewer_id`;

function toBorrowRow(r: Record<string, unknown>): BorrowRequestRow {
  return {
    id: Number(r.id),
    archiveId: Number(r.archive_id),
    applicantId: Number(r.applicant_id),
    purpose: String(r.purpose ?? ''),
    days: Number(r.days),
    startAt: r.start_at == null ? null : String(r.start_at),
    dueAt: r.due_at == null ? null : String(r.due_at),
    status: String(r.status) as BorrowStatus,
    reviewNote: String(r.review_note ?? ''),
    reviewerId: r.reviewer_id == null ? null : Number(r.reviewer_id),
    reviewedAt: r.reviewed_at == null ? null : String(r.reviewed_at),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    archiveTitle: r.archive_title == null ? undefined : String(r.archive_title),
    archiveNo: r.archive_no == null ? undefined : String(r.archive_no),
    archiveAccessLevel: r.archive_access_level == null ? undefined : String(r.archive_access_level),
    applicantName: r.applicant_name == null ? undefined : String(r.applicant_name),
    applicantRole: r.applicant_role == null ? undefined : String(r.applicant_role),
    reviewerName: r.reviewer_name == null ? undefined : String(r.reviewer_name),
  };
}

@Injectable()
export class SqliteBorrowRequestRepository implements BorrowRequestRepository {
  constructor(
    @Inject(DATABASE) private readonly db: DatabaseSync,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
  ) {}

  insert(input: {
    archiveId: number;
    applicantId: number;
    purpose: string;
    days: number;
  }): BorrowRequestRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO borrow_requests
         (archive_id, applicant_id, purpose, days, start_at, due_at, status, review_note,
          reviewer_id, reviewed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, 'pending', '', NULL, NULL, ?, ?)`,
      )
      .run(input.archiveId, input.applicantId, input.purpose, input.days, now, now);
    return this.findById(Number(info.lastInsertRowid))!;
  }

  findById(id: number): BorrowRequestRow | undefined {
    const row = this.db.prepare(`SELECT ${BORROW_COLUMNS} ${BORROW_FROM} WHERE b.id = ?`).get(id);
    return row ? toBorrowRow(row as unknown as Record<string, unknown>) : undefined;
  }

  listByApplicant(applicantId: number): BorrowRequestRow[] {
    const rows = this.db
      .prepare(
        `SELECT ${BORROW_COLUMNS} ${BORROW_FROM} WHERE b.applicant_id = ?
         ORDER BY datetime(b.created_at) DESC, b.id DESC`,
      )
      .all(applicantId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toBorrowRow);
  }

  listByStatus(status: BorrowStatus | ''): BorrowRequestRow[] {
    const rows = this.db
      .prepare(
        status
          ? `SELECT ${BORROW_COLUMNS} ${BORROW_FROM} WHERE b.status = ?
             ORDER BY datetime(b.created_at) DESC, b.id DESC`
          : `SELECT ${BORROW_COLUMNS} ${BORROW_FROM}
             ORDER BY datetime(b.created_at) DESC, b.id DESC`,
      )
      .all(...(status ? [status] : [])) as unknown as Array<Record<string, unknown>>;
    return rows.map(toBorrowRow);
  }

  search(params: BorrowSearchParams): BorrowSearchPage {
    const where: string[] = [];
    const args: Array<string | number> = [];
    const like = (value: string) => `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    if (params.applicantId !== undefined) {
      where.push('b.applicant_id = ?');
      args.push(params.applicantId);
    }
    if (params.status) {
      where.push('b.status = ?');
      args.push(params.status);
    }
    const keyword = String(params.keyword ?? '').trim();
    if (keyword) {
      const pattern = like(keyword);
      where.push(`(COALESCE(a.title, '') LIKE ? ESCAPE '\\'
        OR COALESCE(a.archive_no, '') LIKE ? ESCAPE '\\'
        OR b.purpose LIKE ? ESCAPE '\\'
        OR COALESCE(ua.display_name, '') LIKE ? ESCAPE '\\')`);
      args.push(pattern, pattern, pattern, pattern);
    }
    if (params.from) {
      where.push('datetime(b.created_at) >= datetime(?)');
      args.push(params.from);
    }
    if (params.to) {
      where.push('datetime(b.created_at) <= datetime(?)');
      args.push(params.to);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (this.db.prepare(`SELECT COUNT(*) AS c ${BORROW_FROM}${clause}`).get(...args) as unknown as { c: number | bigint }).c,
    );
    const page = Math.max(1, Math.trunc(params.page));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(params.pageSize)));
    const rows = this.db
      .prepare(
        `SELECT ${BORROW_COLUMNS} ${BORROW_FROM}${clause}
         ORDER BY datetime(b.created_at) DESC, b.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, pageSize, (page - 1) * pageSize) as unknown as Array<Record<string, unknown>>;
    return { items: rows.map(toBorrowRow), total };
  }

  findPending(archiveId: number, applicantId: number): BorrowRequestRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${BORROW_COLUMNS} ${BORROW_FROM}
         WHERE b.archive_id = ? AND b.applicant_id = ? AND b.status = 'pending' LIMIT 1`,
      )
      .get(archiveId, applicantId);
    return row ? toBorrowRow(row as unknown as Record<string, unknown>) : undefined;
  }

  transition(
    id: number,
    expectStatus: BorrowStatus,
    patch: Partial<BorrowRequestRow>,
  ): boolean {
    return this.tx.run(() => {
      const sets: string[] = [];
      const args: Array<string | number | null> = [];
      const map: Array<[keyof BorrowRequestRow, string]> = [
        ['purpose', 'purpose'],
        ['days', 'days'],
        ['startAt', 'start_at'],
        ['dueAt', 'due_at'],
        ['status', 'status'],
        ['reviewNote', 'review_note'],
        ['reviewerId', 'reviewer_id'],
        ['reviewedAt', 'reviewed_at'],
      ];
      for (const [key, col] of map) {
        if (patch[key] !== undefined) {
          sets.push(`${col} = ?`);
          args.push(patch[key] as string | number | null);
        }
      }
      sets.push('updated_at = ?');
      args.push(new Date().toISOString(), id, expectStatus);
      const info = this.db
        .prepare(`UPDATE borrow_requests SET ${sets.join(', ')} WHERE id = ? AND status = ?`)
        .run(...args);
      return Number(info.changes) > 0;
    });
  }
}

// ---------- 借阅授权仓储（受控访问依据） ----------

export abstract class BorrowGrantRepository {
  abstract insert(input: {
    borrowId: number;
    archiveId: number;
    userId: number;
    canView: number;
    canDownload: number;
    expiresAt: string;
  }): BorrowGrantRow;
  /** 取当前有效（active 且未过期）授权；命中即将过期者惰性置 expired 后返回 undefined。 */
  abstract findActive(userId: number, archiveId: number): BorrowGrantRow | undefined;
  abstract listActiveByUser(userId: number): BorrowGrantRow[];
  /** 按借阅申请更新授权状态（归还 / 撤销）。 */
  abstract setStatusByBorrow(borrowId: number, status: GrantStatus): number;
}

const GRANT_COLUMNS = `
  id, borrow_id, archive_id, user_id, can_view, can_download,
  granted_at, expires_at, status, updated_at`;

function toGrantRow(r: Record<string, unknown>): BorrowGrantRow {
  return {
    id: Number(r.id),
    borrowId: Number(r.borrow_id),
    archiveId: Number(r.archive_id),
    userId: Number(r.user_id),
    canView: Number(r.can_view),
    canDownload: Number(r.can_download),
    grantedAt: String(r.granted_at),
    expiresAt: String(r.expires_at),
    status: String(r.status) as GrantStatus,
    updatedAt: String(r.updated_at),
  };
}

@Injectable()
export class SqliteBorrowGrantRepository implements BorrowGrantRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  insert(input: {
    borrowId: number;
    archiveId: number;
    userId: number;
    canView: number;
    canDownload: number;
    expiresAt: string;
  }): BorrowGrantRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO borrow_grants
         (borrow_id, archive_id, user_id, can_view, can_download, granted_at, expires_at, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      )
      .run(
        input.borrowId,
        input.archiveId,
        input.userId,
        input.canView,
        input.canDownload,
        now,
        input.expiresAt,
        now,
      );
    const row = this.db
      .prepare(`SELECT ${GRANT_COLUMNS} FROM borrow_grants WHERE id = ?`)
      .get(Number(info.lastInsertRowid));
    return toGrantRow(row as unknown as Record<string, unknown>);
  }

  findActive(userId: number, archiveId: number): BorrowGrantRow | undefined {
    // 惰性到期：把命中档案但已过期仍标 active 的授权置 expired，避免过期授权继续放行。
    this.db
      .prepare(
        `UPDATE borrow_grants SET status = 'expired', updated_at = ?
         WHERE user_id = ? AND archive_id = ? AND status = 'active'
           AND datetime(expires_at) <= datetime('now')`,
      )
      .run(new Date().toISOString(), userId, archiveId);
    const row = this.db
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM borrow_grants
         WHERE user_id = ? AND archive_id = ? AND status = 'active'
           AND datetime(expires_at) > datetime('now')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(userId, archiveId);
    return row ? toGrantRow(row as unknown as Record<string, unknown>) : undefined;
  }

  listActiveByUser(userId: number): BorrowGrantRow[] {
    this.db
      .prepare(
        `UPDATE borrow_grants SET status = 'expired', updated_at = ?
         WHERE user_id = ? AND status = 'active' AND datetime(expires_at) <= datetime('now')`,
      )
      .run(new Date().toISOString(), userId);
    const rows = this.db
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM borrow_grants
         WHERE user_id = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
         ORDER BY datetime(expires_at) ASC`,
      )
      .all(userId) as unknown as Array<Record<string, unknown>>;
    return rows.map(toGrantRow);
  }

  setStatusByBorrow(borrowId: number, status: GrantStatus): number {
    const info = this.db
      .prepare('UPDATE borrow_grants SET status = ?, updated_at = ? WHERE borrow_id = ?')
      .run(status, new Date().toISOString(), borrowId);
    return Number(info.changes);
  }
}
