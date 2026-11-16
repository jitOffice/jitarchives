/**
 * 用户数据访问接口 + SQLite 实现。
 * 接口即扩展边界：切换 PostgreSQL 时另写实现类，业务层不变。
 */
import { DatabaseSync } from 'node:sqlite';
import { Injectable, Inject } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { ROLE_ADMIN, Role, UserStatus } from '../common/roles';

/** 数据库行结构（含 passwordHash，仅在后端流转，禁止直接返回前端）。 */
export interface UserRow {
  id: number;
  username: string;
  displayName: string;
  email: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserInput {
  username: string;
  displayName: string;
  email?: string;
  passwordHash: string;
  role: Role;
  status?: UserStatus;
}

export interface UpdateUserInput {
  displayName?: string;
  email?: string;
  role?: Role;
  status?: UserStatus;
  passwordHash?: string;
}

export interface RoleCount {
  role: Role;
  count: number;
}

/** 受保护写入的结果：校验不通过时不写库，由业务层映射为业务错误。 */
export type GuardedUpdateResult =
  | { ok: true; user: UserRow }
  | { ok: false; reason: 'not-found' | 'last-active-admin' };

export abstract class UserRepository {
  abstract countUsers(): number;
  abstract findByUsername(username: string): UserRow | undefined;
  abstract findByEmail(email: string): UserRow | undefined;
  abstract findById(id: number): UserRow | undefined;
  abstract listUsers(): UserRow[];
  abstract create(input: CreateUserInput): UserRow;
  abstract countByRole(): RoleCount[];
  /** 当前“可用管理员”数量：角色为 admin 且状态为 active，已禁用的管理员不计入。 */
  abstract countActiveAdmins(): number;
  /**
   * 用户信息修改的唯一写入入口：在同一写事务内重读目标用户、校验
   * “修改后仍至少保留一名启用管理员”，通过后才落库；不通过时不产生任何写入。
   * onSuccess 在同一事务内、写入成功后回调（用于将成功审计与业务写入原子提交）。
   */
  abstract updateWithActiveAdminGuard(
    id: number,
    input: UpdateUserInput,
    onSuccess?: (updated: UserRow) => void,
  ): GuardedUpdateResult;
  /** 写事务边界：BEGIN IMMEDIATE 串行化写入，异常自动回滚；可嵌套复用外层事务。 */
  abstract transaction<T>(fn: () => T): T;
}

interface UserDbRow {
  id: number | bigint;
  username: string;
  display_name: string;
  email: string;
  password_hash: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function toUserRow(r: UserDbRow): UserRow {
  return {
    id: Number(r.id),
    username: r.username,
    displayName: r.display_name,
    email: r.email || '',
    passwordHash: r.password_hash,
    role: r.role as Role,
    status: r.status as UserStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

@Injectable()
export class SqliteUserRepository implements UserRepository {
  /** 事务嵌套深度：同一连接只开一层 SQLite 事务，内层复用外层。 */
  private txDepth = 0;

  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as unknown as {
      c: number | bigint;
    };
    return Number(row.c);
  }

  findByUsername(username: string): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    return row ? toUserRow(row as unknown as UserDbRow) : undefined;
  }

  findByEmail(email: string): UserRow | undefined {
    if (!email) return undefined;
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    return row ? toUserRow(row as unknown as UserDbRow) : undefined;
  }

  findById(id: number): UserRow | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return row ? toUserRow(row as unknown as UserDbRow) : undefined;
  }

  listUsers(): UserRow[] {
    const rows = this.db
      .prepare('SELECT * FROM users ORDER BY id ASC')
      .all() as unknown as UserDbRow[];
    return rows.map(toUserRow);
  }

  create(input: CreateUserInput): UserRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO users (username, display_name, email, password_hash, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.username,
        input.displayName,
        input.email ?? '',
        input.passwordHash,
        input.role,
        input.status ?? 'active',
        now,
        now,
      );
    return this.findById(Number(info.lastInsertRowid))!;
  }

  updateWithActiveAdminGuard(
    id: number,
    input: UpdateUserInput,
    onSuccess?: (updated: UserRow) => void,
  ): GuardedUpdateResult {
    return this.transaction<GuardedUpdateResult>(() => {
      // 关键：目标用户与启用管理员数量都在事务内重读，避免“先查后写”的竞态窗口
      const current = this.findById(id);
      if (!current) return { ok: false, reason: 'not-found' };

      const nextRole = input.role ?? current.role;
      const nextStatus = input.status ?? current.status;
      const wasActiveAdmin = current.role === ROLE_ADMIN && current.status === 'active';
      const staysActiveAdmin = nextRole === ROLE_ADMIN && nextStatus === 'active';

      // 只有本次修改会让“启用管理员”变少时才校验；已禁用的管理员不计入可用数量
      if (wasActiveAdmin && !staysActiveAdmin && this.countActiveAdmins() <= 1) {
        return { ok: false, reason: 'last-active-admin' };
      }
      const updated = this.writeRow(id, current, input);
      // 成功审计与业务写入处于同一事务：onSuccess 抛错会连同业务一起回滚
      if (onSuccess) onSuccess(updated);
      return { ok: true, user: updated };
    });
  }

  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn(); // 内层直接复用外层事务，避免嵌套 BEGIN 报错
    // BEGIN IMMEDIATE 立即取得写锁：并发写入被串行化，检查与写入不会被其他写入穿插
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite 可能已自动回滚，勿让回滚失败掩盖原始异常
      }
      throw err;
    } finally {
      this.txDepth = 0;
    }
  }

  countActiveAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE role = ? AND status = 'active'")
      .get(ROLE_ADMIN) as unknown as { c: number | bigint };
    return Number(row.c);
  }

  /** 仅事务内部使用：按当前行补齐未修改字段后整行更新（不对外暴露，避免绕过保底校验）。 */
  private writeRow(id: number, current: UserRow, input: UpdateUserInput): UserRow {
    this.db
      .prepare(
        `UPDATE users SET display_name = ?, email = ?, role = ?, status = ?, password_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.displayName ?? current.displayName,
        input.email ?? current.email,
        input.role ?? current.role,
        input.status ?? current.status,
        input.passwordHash ?? current.passwordHash,
        new Date().toISOString(),
        id,
      );
    return this.findById(id)!;
  }

  countByRole(): RoleCount[] {
    const rows = this.db
      .prepare('SELECT role, COUNT(*) AS c FROM users GROUP BY role')
      .all() as unknown as Array<{ role: string; c: number | bigint }>;
    return rows.map((r) => ({ role: r.role as Role, count: Number(r.c) }));
  }
}
