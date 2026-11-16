/**
 * 会话数据访问接口 + SQLite 实现（服务端会话，退出即失效）。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';

export interface SessionRow {
  token: string;
  userId: number;
  createdAt: string;
  expiresAt: number; // epoch ms
}

export abstract class SessionRepository {
  abstract create(token: string, userId: number, ttlMs: number, ip?: string): SessionRow;
  abstract find(token: string): SessionRow | undefined;
  abstract delete(token: string): void;
  abstract deleteByUser(userId: number): void;
  abstract deleteExpired(nowMs: number): void;
}

interface SessionDbRow {
  token: string;
  user_id: number | bigint;
  created_at: string;
  expires_at: number | bigint;
}

function toSession(r: SessionDbRow): SessionRow {
  return {
    token: r.token,
    userId: Number(r.user_id),
    createdAt: r.created_at,
    expiresAt: Number(r.expires_at),
  };
}

@Injectable()
export class SqliteSessionRepository implements SessionRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  create(token: string, userId: number, ttlMs: number, ip?: string): SessionRow {
    const createdAt = new Date().toISOString();
    const expiresAt = Date.now() + ttlMs;
    this.db
      .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)')
      .run(token, userId, createdAt, expiresAt, ip ?? null);
    return { token, userId, createdAt, expiresAt };
  }

  find(token: string): SessionRow | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    return row ? toSession(row as unknown as SessionDbRow) : undefined;
  }

  delete(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  deleteByUser(userId: number): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  deleteExpired(nowMs: number): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs);
  }
}
