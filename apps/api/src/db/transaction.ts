/**
 * 共享写事务边界（沿用第一批 BEGIN IMMEDIATE + 嵌套复用的约定）。
 * 单进程内以深度计数实现嵌套复用；跨进程竞态由 SQLite 写锁串行化。
 * 分类/档案/附件等仓储必须统一使用本服务，保证同一连接不会重复 BEGIN。
 */
import { DatabaseSync } from 'node:sqlite';
import { Injectable, Inject } from '@nestjs/common';
import { DATABASE } from './database';

@Injectable()
export class SqliteTransaction {
  private depth = 0;

  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  run<T>(fn: () => T): T {
    if (this.depth > 0) return fn(); // 内层直接复用外层事务，避免嵌套 BEGIN 报错
    // BEGIN IMMEDIATE 立即取得写锁：并发写入被串行化，检查与写入不会被其他写入穿插
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
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
      this.depth = 0;
    }
  }
}
