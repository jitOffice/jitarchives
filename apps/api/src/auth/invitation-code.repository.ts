/**
 * 邀请码数据访问接口 + SQLite 实现。
 * 邀请码由管理员或安全初始化流程生成，注册时校验有效性、过期、使用次数。
 * 使用记录（invitation_code_uses）与用户创建在同一事务内原子提交。
 */
import { DatabaseSync } from 'node:sqlite';
import { Injectable, Inject } from '@nestjs/common';
import { DATABASE } from '../db/database';

export interface InvitationCodeRow {
  id: number;
  code: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  status: 'active' | 'disabled' | 'exhausted';
  createdBy: number | null;
  note: string;
}

export interface InvitationCodeUseRow {
  id: number;
  invitationCodeId: number;
  userId: number;
  username: string;
  usedAt: string;
  ip: string | null;
}

export interface CreateInvitationCodeInput {
  code: string;
  expiresAt: string;
  maxUses: number;
  createdBy?: number | null;
  note?: string;
}

interface InvitationCodeDbRow {
  id: number | bigint;
  code: string;
  created_at: string;
  expires_at: string;
  max_uses: number | bigint;
  use_count: number | bigint;
  status: string;
  created_by: number | bigint | null;
  note: string;
}

interface InvitationCodeUseDbRow {
  id: number | bigint;
  invitation_code_id: number | bigint;
  user_id: number | bigint;
  username: string;
  used_at: string;
  ip: string | null;
}

function toInvitationCodeRow(r: InvitationCodeDbRow): InvitationCodeRow {
  return {
    id: Number(r.id),
    code: r.code,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    maxUses: Number(r.max_uses),
    useCount: Number(r.use_count),
    status: r.status as InvitationCodeRow['status'],
    createdBy: r.created_by != null ? Number(r.created_by) : null,
    note: r.note,
  };
}

function toInvitationCodeUseRow(r: InvitationCodeUseDbRow): InvitationCodeUseRow {
  return {
    id: Number(r.id),
    invitationCodeId: Number(r.invitation_code_id),
    userId: Number(r.user_id),
    username: r.username,
    usedAt: r.used_at,
    ip: r.ip,
  };
}

export abstract class InvitationCodeRepository {
  abstract findByCode(code: string): InvitationCodeRow | undefined;
  abstract findById(id: number): InvitationCodeRow | undefined;
  abstract create(input: CreateInvitationCodeInput): InvitationCodeRow;
  /**
   * 在同一事务内原子完成：检查邀请码有效性 → 递增使用计数 → 记录使用。
   * 调用方须确保已在外层开启事务（BEGIN IMMEDIATE），本方法不再嵌套事务。
   */
  abstract consumeCode(codeId: number, userId: number, username: string, ip: string | null): void;
  abstract recordUse(codeId: number, userId: number, username: string, ip: string | null): InvitationCodeUseRow;
  abstract getUsesByCode(codeId: number): InvitationCodeUseRow[];
  abstract getUsesByUser(userId: number): InvitationCodeUseRow[];
}

@Injectable()
export class SqliteInvitationCodeRepository implements InvitationCodeRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  findByCode(code: string): InvitationCodeRow | undefined {
    const row = this.db.prepare('SELECT * FROM invitation_codes WHERE code = ?').get(code);
    return row ? toInvitationCodeRow(row as unknown as InvitationCodeDbRow) : undefined;
  }

  findById(id: number): InvitationCodeRow | undefined {
    const row = this.db.prepare('SELECT * FROM invitation_codes WHERE id = ?').get(id);
    return row ? toInvitationCodeRow(row as unknown as InvitationCodeDbRow) : undefined;
  }

  create(input: CreateInvitationCodeInput): InvitationCodeRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO invitation_codes (code, created_at, expires_at, max_uses, use_count, status, created_by, note)
         VALUES (?, ?, ?, ?, 0, 'active', ?, ?)`,
      )
      .run(input.code, now, input.expiresAt, input.maxUses, input.createdBy ?? null, input.note ?? '');
    return this.findById(Number(info.lastInsertRowid))!;
  }

  /**
   * 原子消耗邀请码：递增 use_count，若达到 max_uses 则自动置为 exhausted。
   * 必须在事务内调用（由上层 auth.service 保证）。
   */
  consumeCode(codeId: number, userId: number, username: string, ip: string | null): void {
    // 递增使用计数
    this.db
      .prepare('UPDATE invitation_codes SET use_count = use_count + 1 WHERE id = ?')
      .run(codeId);
    // 读取更新后的状态
    const row = this.db.prepare('SELECT * FROM invitation_codes WHERE id = ?').get(codeId) as unknown as InvitationCodeDbRow | undefined;
    if (row && Number(row.use_count) >= Number(row.max_uses) && row.status === 'active') {
      this.db
        .prepare("UPDATE invitation_codes SET status = 'exhausted' WHERE id = ? AND status = 'active'")
        .run(codeId);
    }
    // 记录使用
    this.recordUse(codeId, userId, username, ip);
  }

  recordUse(codeId: number, userId: number, username: string, ip: string | null): InvitationCodeUseRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO invitation_code_uses (invitation_code_id, user_id, username, used_at, ip)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(codeId, userId, username, now, ip);
    return toInvitationCodeUseRow(
      this.db.prepare('SELECT * FROM invitation_code_uses WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as InvitationCodeUseDbRow,
    );
  }

  getUsesByCode(codeId: number): InvitationCodeUseRow[] {
    const rows = this.db
      .prepare('SELECT * FROM invitation_code_uses WHERE invitation_code_id = ? ORDER BY used_at DESC')
      .all(codeId) as unknown as InvitationCodeUseDbRow[];
    return rows.map(toInvitationCodeUseRow);
  }

  getUsesByUser(userId: number): InvitationCodeUseRow[] {
    const rows = this.db
      .prepare('SELECT * FROM invitation_code_uses WHERE user_id = ? ORDER BY used_at DESC')
      .all(userId) as unknown as InvitationCodeUseDbRow[];
    return rows.map(toInvitationCodeUseRow);
  }
}
