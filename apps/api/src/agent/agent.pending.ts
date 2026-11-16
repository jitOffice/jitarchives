/**
 * Agent 待确认业务动作仓储（第三阶段：智能档案业务办理）。
 *
 * 为什么需要它：确认提交必须绑定「服务端保存的待执行内容」，而不是大模型回传的参数。
 * 因此待办草稿（借阅申请内容 / 著录建议）先落库，确认接口只凭 token + 会话归属定位它，
 * 归档 ID、申请人身份一律来自服务端，绝不来自模型输出。
 *
 * 防重复提交：claim() 用条件更新（WHERE status='pending'）把草稿抢占为 running，
 * 第二次点击影响 0 行 → 上层直接回显既有结果，不产生第二条借阅申请。
 * 归属安全：所有读写都带 (token, userId, conversationId) 三条件，跨用户查不到（服务层转 404）。
 * SQL 一律参数化，沿用既有仓储模式（抽象类作 DI Token，SQLite 实现集中在模块绑定）。
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';

/** 受控工具白名单：新增可执行工具必须同时在此登记，否则无法写入（数据库 CHECK 也会拒绝）。 */
export const AGENT_PENDING_TOOL = {
  BORROW_REQUEST: 'borrow.request',
  ARCHIVE_CATALOG_SAVE: 'archive.catalog_save',
} as const;
export type AgentPendingTool = (typeof AGENT_PENDING_TOOL)[keyof typeof AGENT_PENDING_TOOL];

export type AgentPendingStatus = 'pending' | 'running' | 'executed' | 'cancelled' | 'failed';

export interface AgentPendingActionRow {
  id: number;
  token: string;
  conversationId: number;
  userId: number;
  tool: AgentPendingTool;
  payloadJson: string;
  status: AgentPendingStatus;
  resultJson: string | null;
  error: string;
  createdAt: string;
  updatedAt: string;
}

export abstract class AgentPendingActionRepository {
  abstract insert(input: {
    conversationId: number;
    userId: number;
    tool: AgentPendingTool;
    payload: unknown;
  }): AgentPendingActionRow;
  /** 按 (token, userId, conversationId) 定位：任一不匹配即查不到，不泄露他人草稿是否存在。 */
  abstract find(token: string, userId: number, conversationId: number): AgentPendingActionRow | undefined;
  /** 取本会话最近一条仍可操作的草稿（用于「确认提交 / 取消申请」这类纯文本确认）。 */
  abstract findLatestPending(userId: number, conversationId: number): AgentPendingActionRow | undefined;
  /** 覆盖草稿内容（用户在确认前修改字段），仅 pending 可改。 */
  abstract updatePayload(id: number, payloadJson: string): boolean;
  /** 条件抢占：pending → running，返回是否成功（防重复点击/并发重复提交）。 */
  abstract claim(id: number): boolean;
  /** 直接作废仍未确认的草稿（用户改口 / 换目标档案），仅 pending 可作废。 */
  abstract discard(id: number): boolean;
  /** 终结状态：running → executed / failed / cancelled，并写入真实业务响应。 */
  abstract finalize(
    id: number,
    status: Extract<AgentPendingStatus, 'executed' | 'failed' | 'cancelled'>,
    resultJson: string | null,
    error: string,
  ): boolean;
  /** 会话删除前的清理（正常由外键级联兜底，此处显式统计便于审计）。 */
  abstract countPendingByConversation(conversationId: number): number;
}

const COLUMNS = `
  id, token, conversation_id, user_id, tool, payload_json, status, result_json,
  error, created_at, updated_at`;

function toRow(r: Record<string, unknown>): AgentPendingActionRow {
  return {
    id: Number(r.id),
    token: String(r.token),
    conversationId: Number(r.conversation_id),
    userId: Number(r.user_id),
    tool: String(r.tool) as AgentPendingTool,
    payloadJson: String(r.payload_json ?? '{}'),
    status: String(r.status) as AgentPendingStatus,
    resultJson: r.result_json == null ? null : String(r.result_json),
    error: String(r.error ?? ''),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** token 长度上限（uuid 36；防御异常入参放大查询）。 */
export const MAX_PENDING_TOKEN_LENGTH = 64;

@Injectable()
export class SqliteAgentPendingActionRepository implements AgentPendingActionRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  insert(input: {
    conversationId: number;
    userId: number;
    tool: AgentPendingTool;
    payload: unknown;
  }): AgentPendingActionRow {
    const now = new Date().toISOString();
    // token 由服务端生成（uuid），前端与模型都无法指定，避免猜测/覆盖他人草稿
    const token = randomUUID();
    const info = this.db
      .prepare(
        `INSERT INTO agent_pending_actions
         (token, conversation_id, user_id, tool, payload_json, status, result_json, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', NULL, '', ?, ?)`,
      )
      .run(token, input.conversationId, input.userId, input.tool, JSON.stringify(input.payload), now, now);
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM agent_pending_actions WHERE id = ?`)
      .get(Number(info.lastInsertRowid));
    return toRow(row as unknown as Record<string, unknown>);
  }

  find(token: string, userId: number, conversationId: number): AgentPendingActionRow | undefined {
    if (!token || token.length > MAX_PENDING_TOKEN_LENGTH) return undefined;
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM agent_pending_actions
         WHERE token = ? AND user_id = ? AND conversation_id = ?`,
      )
      .get(token, userId, conversationId);
    return row ? toRow(row as unknown as Record<string, unknown>) : undefined;
  }

  findLatestPending(userId: number, conversationId: number): AgentPendingActionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM agent_pending_actions
         WHERE user_id = ? AND conversation_id = ? AND status = 'pending'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(userId, conversationId);
    return row ? toRow(row as unknown as Record<string, unknown>) : undefined;
  }

  updatePayload(id: number, payloadJson: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE agent_pending_actions SET payload_json = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(payloadJson, new Date().toISOString(), id);
    return Number(info.changes) > 0;
  }

  claim(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE agent_pending_actions SET status = 'running', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), id);
    return Number(info.changes) > 0;
  }

  discard(id: number): boolean {
    const info = this.db
      .prepare(
        `UPDATE agent_pending_actions SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(new Date().toISOString(), id);
    return Number(info.changes) > 0;
  }

  finalize(
    id: number,
    status: Extract<AgentPendingStatus, 'executed' | 'failed' | 'cancelled'>,
    resultJson: string | null,
    error: string,
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE agent_pending_actions SET status = ?, result_json = ?, error = ?, updated_at = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(status, resultJson, error.slice(0, 500), new Date().toISOString(), id);
    return Number(info.changes) > 0;
  }

  countPendingByConversation(conversationId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM agent_pending_actions
         WHERE conversation_id = ? AND status IN ('pending','running')`,
      )
      .get(conversationId) as unknown as { c: number | bigint };
    return Number(row.c);
  }
}
