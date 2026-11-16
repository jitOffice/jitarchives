/**
 * Agent 会话与消息仓储（第一阶段）。
 * 沿用既有模式：抽象类作为 DI Token，SQLite 实现集中绑定，切换 PostgreSQL 替换 useClass 即可。
 * 归属安全：所有读写都以 (id, userId) 双条件定位，跨用户访问一律查不到（服务层转 404/403），
 * 不接受客户端传入 userId，也不依赖前端隐藏入口。
 * 所有 SQL 一律参数化。
 */
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE } from '../db/database';

export interface AgentConversationRow {
  id: number;
  userId: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 消息条数（列表展示用，由聚合查询补齐，可能为空）。 */
  messageCount?: number;
}

export type AgentMessageRole = 'user' | 'assistant';

export interface AgentMessageRow {
  id: number;
  conversationId: number;
  role: AgentMessageRole;
  content: string;
  /** 结构化回复载荷（JSON 文本）；用户消息为 null。 */
  payloadJson: string | null;
  /** 前端提交幂等键（仅 assistant 消息写入）。 */
  clientRequestId: string | null;
  createdAt: string;
}

export abstract class AgentRepository {
  abstract createConversation(userId: number, title: string): AgentConversationRow;
  abstract findConversation(id: number, userId: number): AgentConversationRow | undefined;
  /** 当前用户的会话列表（按最近更新倒序），附带真实消息条数。 */
  abstract listConversations(userId: number, limit: number): AgentConversationRow[];
  abstract touchConversation(id: number, userId: number, title?: string): void;
  /** 删除会话及其消息（归属由 userId 条件保证）；返回是否真正删除。 */
  abstract deleteConversation(id: number, userId: number): boolean;
  abstract countMessages(conversationId: number): number;
  abstract appendMessage(input: {
    conversationId: number;
    role: AgentMessageRole;
    content: string;
    payloadJson?: string | null;
    clientRequestId?: string | null;
  }): AgentMessageRow;
  abstract listMessages(conversationId: number, limit: number): AgentMessageRow[];
  /** 按 (会话, 消息 ID) 定位消息；越权或跨会话一律查不到。 */
  abstract findMessage(conversationId: number, id: number): AgentMessageRow | undefined;
  /** 原地替换一条回复消息的正文与载荷（重新生成时保留原消息 ID 与时间顺序）。 */
  abstract updateMessage(
    conversationId: number,
    id: number,
    content: string,
    payloadJson: string | null,
  ): AgentMessageRow | undefined;
  /** 幂等：按 (会话, clientRequestId) 取已生成的回复消息。 */
  abstract findMessageByClientRequest(
    conversationId: number,
    clientRequestId: string,
  ): AgentMessageRow | undefined;
}

const CONVERSATION_COLUMNS = `id, user_id, title, created_at, updated_at`;

function toConversationRow(r: Record<string, unknown>): AgentConversationRow {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    title: String(r.title),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    messageCount: r.message_count === undefined || r.message_count === null
      ? undefined
      : Number(r.message_count),
  };
}

function toMessageRow(r: Record<string, unknown>): AgentMessageRow {
  return {
    id: Number(r.id),
    conversationId: Number(r.conversation_id),
    role: String(r.role) as AgentMessageRole,
    content: String(r.content ?? ''),
    payloadJson: r.payload_json == null ? null : String(r.payload_json),
    clientRequestId: r.client_request_id == null ? null : String(r.client_request_id),
    createdAt: String(r.created_at),
  };
}

@Injectable()
export class SqliteAgentRepository implements AgentRepository {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  createConversation(userId: number, title: string): AgentConversationRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO agent_conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .run(userId, title, now, now);
    return this.findConversation(Number(info.lastInsertRowid), userId)!;
  }

  findConversation(id: number, userId: number): AgentConversationRow | undefined {
    const row = this.db
      .prepare(`SELECT ${CONVERSATION_COLUMNS} FROM agent_conversations WHERE id = ? AND user_id = ?`)
      .get(id, userId);
    return row ? toConversationRow(row as unknown as Record<string, unknown>) : undefined;
  }

  listConversations(userId: number, limit: number): AgentConversationRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.user_id, c.title, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM agent_messages m WHERE m.conversation_id = c.id) AS message_count
         FROM agent_conversations c
         WHERE c.user_id = ?
         ORDER BY datetime(c.updated_at) DESC, c.id DESC
         LIMIT ?`,
      )
      .all(userId, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(toConversationRow);
  }

  touchConversation(id: number, userId: number, title?: string): void {
    const now = new Date().toISOString();
    if (title) {
      this.db
        .prepare(
          `UPDATE agent_conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
        )
        .run(title, now, id, userId);
      return;
    }
    this.db
      .prepare(`UPDATE agent_conversations SET updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(now, id, userId);
  }

  deleteConversation(id: number, userId: number): boolean {
    // 先确认归属再删除：WHERE 同时带 user_id，越权删除影响 0 行。
    const owned = this.findConversation(id, userId);
    if (!owned) return false;
    this.db.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id);
    this.db.prepare('DELETE FROM agent_conversations WHERE id = ? AND user_id = ?').run(id, userId);
    return true;
  }

  countMessages(conversationId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM agent_messages WHERE conversation_id = ?')
      .get(conversationId) as unknown as { c: number | bigint };
    return Number(row.c);
  }

  appendMessage(input: {
    conversationId: number;
    role: AgentMessageRole;
    content: string;
    payloadJson?: string | null;
    clientRequestId?: string | null;
  }): AgentMessageRow {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO agent_messages (conversation_id, role, content, payload_json, client_request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.role,
        input.content,
        input.payloadJson ?? null,
        input.clientRequestId ?? null,
        now,
      );
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, payload_json, client_request_id, created_at
         FROM agent_messages WHERE id = ?`,
      )
      .get(Number(info.lastInsertRowid));
    return toMessageRow(row as unknown as Record<string, unknown>);
  }

  findMessage(conversationId: number, id: number): AgentMessageRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, payload_json, client_request_id, created_at
         FROM agent_messages WHERE conversation_id = ? AND id = ?`,
      )
      .get(conversationId, id);
    return row ? toMessageRow(row as unknown as Record<string, unknown>) : undefined;
  }

  updateMessage(
    conversationId: number,
    id: number,
    content: string,
    payloadJson: string | null,
  ): AgentMessageRow | undefined {
    const info = this.db
      .prepare(
        `UPDATE agent_messages SET content = ?, payload_json = ?
         WHERE conversation_id = ? AND id = ? AND role = 'assistant'`,
      )
      .run(content, payloadJson, conversationId, id);
    if (Number(info.changes) === 0) return undefined;
    return this.findMessage(conversationId, id);
  }

  listMessages(conversationId: number, limit: number): AgentMessageRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, payload_json, client_request_id, created_at
         FROM agent_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(conversationId, limit) as unknown as Array<Record<string, unknown>>;
    return rows.map(toMessageRow).reverse();
  }

  findMessageByClientRequest(
    conversationId: number,
    clientRequestId: string,
  ): AgentMessageRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, conversation_id, role, content, payload_json, client_request_id, created_at
         FROM agent_messages WHERE conversation_id = ? AND client_request_id = ? AND role = 'assistant'
         ORDER BY id ASC LIMIT 1`,
      )
      .get(conversationId, clientRequestId);
    return row ? toMessageRow(row as unknown as Record<string, unknown>) : undefined;
  }
}
