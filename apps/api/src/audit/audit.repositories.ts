/**
 * 审计日志仓储：抽象接口 + SQLite 实现（阶段二第五批 · 功能一）。
 * 安全约束：
 * - 仅提供「追加写入」与「只读查询」两类能力，不提供任何 UPDATE / DELETE 接口，
 *   从根本上保证普通业务代码无法修改或删除审计记录（应用层追加写入；
 *   注意：不宣称数据库级法律级不可篡改能力）；
 * - 查询一律参数化，分页/时间范围在 SQL 层执行，不在内存过滤。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';
import { AuditEvent, AuditLogView, AuditPage, AuditQuery } from './audit.types';

export abstract class AuditRepository {
  abstract insert(event: AuditEvent): void;
  abstract query(q: AuditQuery): AuditPage;
}

interface AuditDbRow {
  id: number | bigint;
  actor_user_id: number | bigint | null;
  actor_role: string | null;
  action: string;
  object_type: string;
  object_id: string | null;
  result: string;
  detail: string;
  ip: string | null;
  created_at: string;
  actor_name: string | null;
}

function toView(r: AuditDbRow): AuditLogView {
  let detail: Record<string, unknown> = {};
  try {
    detail = r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {};
  } catch {
    detail = { note: '详情解析失败' };
  }
  return {
    id: Number(r.id),
    actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
    actorName: r.actor_name,
    actorRole: r.actor_role,
    action: r.action,
    objectType: r.object_type,
    objectId: r.object_id == null ? null : String(r.object_id),
    result: r.result as AuditLogView['result'],
    detail,
    ip: r.ip,
    createdAt: r.created_at,
  };
}

@Injectable()
export class SqliteAuditRepository implements AuditRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  insert(event: AuditEvent): void {
    // detail 仅写入调用方显式构造的脱敏辅助信息；序列化前再兜底剔除敏感键。
    const safe = sanitizeDetail(event.detail ?? {});
    this.db
      .prepare(
        `INSERT INTO audit_logs
         (actor_user_id, actor_role, action, object_type, object_id, result, detail, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.actorUserId,
        event.actorRole,
        event.action,
        event.objectType,
        event.objectId == null ? null : String(event.objectId),
        event.result,
        JSON.stringify(safe),
        event.ip ?? null,
        new Date().toISOString(),
      );
  }

  query(q: AuditQuery): AuditPage {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (q.actorUserId !== undefined) {
      where.push('a.actor_user_id = ?');
      args.push(q.actorUserId);
    }
    if (q.actorName) {
      // 操作人名称模糊包含匹配（与档案检索一致：转义 LIKE 元字符，参数化执行）。
      where.push(`u.display_name LIKE ? ESCAPE '\\'`);
      args.push(likeContains(q.actorName));
    }
    if (q.archiveIds) {
      if (!q.archiveIds.length) where.push('1 = 0');
      else {
        const slots = q.archiveIds.map(() => '?').join(',');
        where.push(`(
          (a.object_type = 'archive' AND CAST(a.object_id AS INTEGER) IN (${slots}))
          OR CAST(json_extract(CASE WHEN json_valid(a.detail) THEN a.detail ELSE '{}' END, '$.archiveId') AS INTEGER) IN (${slots})
          OR (a.object_type = 'archive_file' AND a.object_id IN (SELECT CAST(id AS TEXT) FROM archive_files WHERE archive_id IN (${slots})))
          OR (a.object_type = 'archive_file_version' AND a.object_id IN (SELECT CAST(id AS TEXT) FROM archive_file_versions WHERE archive_id IN (${slots})))
          OR (a.object_type = 'archive_document' AND a.object_id IN (SELECT CAST(id AS TEXT) FROM archive_documents WHERE archive_id IN (${slots})))
        )`);
        args.push(...q.archiveIds, ...q.archiveIds, ...q.archiveIds, ...q.archiveIds, ...q.archiveIds);
      }
    }
    if (q.action) {
      where.push('a.action = ?');
      args.push(q.action);
    }
    const searchClauses: string[] = [];
    const actions = Array.isArray(q.actions) ? [...new Set(q.actions.filter((v) => typeof v === 'string' && v.length <= 100))] : [];
    if (actions.length) {
      (q.strictActions ? where : searchClauses).push(`a.action IN (${actions.map(() => '?').join(',')})`);
      args.push(...actions);
    }
    const keyword = String(q.keyword ?? '').trim();
    if (keyword) {
      const pattern = `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      searchClauses.push(`(
        a.action LIKE ? ESCAPE '\\'
        OR a.object_type LIKE ? ESCAPE '\\'
        OR COALESCE(a.object_id, '') LIKE ? ESCAPE '\\'
        OR a.detail LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM users ux WHERE ux.id = a.actor_user_id
            AND (COALESCE(ux.display_name, '') LIKE ? ESCAPE '\\' OR COALESCE(ux.username, '') LIKE ? ESCAPE '\\')
        )
      )`);
      args.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }
    if (searchClauses.length) where.push(`(${searchClauses.join(' OR ')})`);
    if (q.objectType) {
      where.push('a.object_type = ?');
      args.push(q.objectType);
    }
    if (q.objectId) {
      where.push('a.object_id = ?');
      args.push(q.objectId);
    }
    if (q.from) {
      where.push('datetime(a.created_at) >= datetime(?)');
      args.push(q.from);
    }
    if (q.to) {
      where.push('datetime(a.created_at) <= datetime(?)');
      args.push(q.to);
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    // 按名称过滤时需 JOIN users；LEFT JOIN 不改变其它过滤的行集（users.id 为主键，不会产生重复行）。
    const total = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) AS c FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${clause}`,
          )
          .get(...args) as unknown as { c: number | bigint }
      ).c,
    );
    const rows = this.db
      .prepare(
        `SELECT a.*, u.display_name AS actor_name
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id${clause}
         ORDER BY datetime(a.created_at) DESC, a.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...args, q.pageSize, (q.page - 1) * q.pageSize) as unknown as AuditDbRow[];
    return { items: rows.map(toView), total, page: q.page, pageSize: q.pageSize };
  }
}

/** LIKE 包含匹配：转义元字符并加前后通配（与 archive.repositories 的 like 惯例一致）。 */
function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** detail 兜底脱敏：剔除任何疑似敏感键（大小写不敏感），防止调用方误传机密。 */
const SENSITIVE_KEY_RE = /(password|passwd|secret|token|ticket|cookie|authorization|clientsecret|secretkey)/i;
function sanitizeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SENSITIVE_KEY_RE.test(k)) continue; // 命中敏感键直接丢弃
    out[k] = typeof v === 'object' && v !== null ? v : v;
  }
  return out;
}
