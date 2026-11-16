/**
 * 运行健康检查接口（阶段二第五批 · 功能四）：无鉴权，供部署探针 / Docker HEALTHCHECK 调用。
 * 仅暴露非敏感的可达性与版本信息（绝不返回密钥、连接串内容或业务数据）。
 * - status=ok 时返回 200；任一关键依赖不可用时返回 503（degraded），便于编排层判定。
 */
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATABASE } from '../db/database';
import { appOptions } from '../app-options';
import { SYSTEM_INFO } from '../config';

const STARTED_AT_MS = Date.now();
const STARTED_AT_ISO = new Date(STARTED_AT_MS).toISOString();

interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  productName: string;
  startedAt: string;
  uptimeMs: number;
  checks: {
    database: { ok: boolean; migrationsApplied: number | null; error?: string };
    storage: { ok: boolean; dir: string; error?: string };
  };
}

@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  @Get()
  health(@Res({ passthrough: true }) res: Response): HealthReport {
    let dbOk = false;
    let migrationsApplied: number | null = null;
    let dbError: string | undefined;
    try {
      this.db.prepare('SELECT 1 AS x').get();
      const rows = this.db.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>;
      migrationsApplied = rows.length;
      dbOk = true;
    } catch (err) {
      dbError = (err as Error)?.message ?? String(err);
    }

    let storeOk = false;
    let storeError: string | undefined;
    const dir = path.resolve(appOptions.fileStoreDir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.health-probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probe, 'ok', 'utf8');
      fs.rmSync(probe, { force: true });
      storeOk = true;
    } catch (err) {
      storeError = (err as Error)?.message ?? String(err);
    }

    const status: HealthReport['status'] = dbOk && storeOk ? 'ok' : 'degraded';
    if (!res.statusCode || res.statusCode === 200) {
      res.status(status === 'ok' ? 200 : 503);
    }
    return {
      status,
      version: SYSTEM_INFO.version,
      productName: SYSTEM_INFO.productName,
      startedAt: STARTED_AT_ISO,
      uptimeMs: Date.now() - STARTED_AT_MS,
      checks: {
        database: { ok: dbOk, migrationsApplied, ...(dbError ? { error: dbError } : {}) },
        storage: { ok: storeOk, dir, ...(storeError ? { error: storeError } : {}) },
      },
    };
  }
}
