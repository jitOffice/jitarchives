/** Context references are planning data, never a query scope or cached authorization.
 * Bounded, server-owned context stored with the existing assistant message.
 * References locate entities only; every use must go through the read-only tools again.
 * No global cache, extra database, model-generated IDs, or cross-conversation fallback.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AgentRepository } from './agent.repositories';
import type { AgentPayload } from './agent.service';

export const CONTEXT_LIMITS = { messages: 12, entities: 24, recentTurns: 4, questionChars: 240, summaryChars: 1200 } as const;
export interface AttachmentReference { archiveId: number; fileId: number }
export interface AgentContextSnapshot {
  version: 1;
  archives: number[];
  attachments: AttachmentReference[];
  activeArchives: number[];
  activeFiles: number[];
  focus: 'archive' | 'attachment' | null;
  previousQuestion: string;
  recentTurns: string[];
  summary: string;
  tools: Array<{ name: string; status: string; total: number }>;
}
const uniqueIds = (values: number[]) => [...new Set(values.filter(v => Number.isSafeInteger(v) && v > 0))].slice(0, CONTEXT_LIMITS.entities);
const empty = (): AgentContextSnapshot => ({ version: 1, archives: [], attachments: [], activeArchives: [], activeFiles: [],
  focus: null, previousQuestion: '', recentTurns: [], summary: '', tools: [] });

export interface ReferenceRequest {
  type?: 'archive' | 'attachment';
  ordinal?: number;
  name?: string;
  plural: boolean;
  content: boolean;
  upload: boolean;
  implicit?: boolean;
}
/** Legacy compatibility helper; natural-language turns are resolved by the AI planner. */
export function parseReference(question: string): ReferenceRequest | null {
  const explicit = /(这些|那些|其中|刚才|上面提到|上述|会话中|再找其他.{0,12}类似|它|他(?:的)?附件|这个(?:档案|附件|项目)|那个档案|这份|那份|这两份|那两份|第\s*[一二三四五六七八九十\d]+\s*(?:份|个|条)|^(?:那)?里面|其他合同.{0,12}类似规定)/u.test(question);
  const implicit = /^(?:那|那么)?(?:主要内容是什么|正文是什么|上传时间|什么时候上传的|有哪些附件)[？?。]?$/u.test(question);
  if (!explicit && !implicit) return null;
  const index = question.match(/第\s*([一二三四五六七八九十\d]+)\s*(?:份|个|条)/u)?.[1];
  const ordinal = index ? (/^\d+$/u.test(index) ? Number(index) : ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'].indexOf(index)) : undefined;
  const name = question.match(/(?:哪一份|哪份|哪一个|哪个)(?:是|叫|属于)?\s*(.+?)[？?。]?$/u)?.[1]?.replace(/[？?。]+$/u, '').trim()
    ?? question.match(/上面提到的(.+?)(?=的(?:正文|内容|附件|上传|状态)|[？?。]|$)/u)?.[1]?.trim();
  return {
    type: /这个档案|那个档案|这些档案|那些档案/u.test(question) ? 'archive' : /附件/u.test(question) ? 'attachment' : /档案/u.test(question) ? 'archive' : undefined,
    ordinal, name,
    plural: /这些|那些|这两份|那两份|全部|所有|比较|对比/u.test(question),
    content: /正文|全文|主要内容|核心内容|内容(?:主要)?是什么|主要讲什么|讲了什么|完成了?哪些工作|做了什么|技术架构|总结|概括|条款|付款|违约|验收标准|比较|对比|区别|差异|类似规定/u.test(question),
    upload: /上传|何时|什么时候/u.test(question),
    implicit: !explicit && implicit,
  };
}

@Injectable()
export class AgentContextService {
  constructor(@Inject(AgentRepository) private readonly repo: AgentRepository) {}

  load(conversationId: number, userId: number): AgentContextSnapshot {
    return this.collect(conversationId, userId);
  }

  /** 重新生成时只读取目标消息之前的上下文，避免把待替换的旧回答当成最新状态。 */
  loadBefore(conversationId: number, userId: number, beforeMessageId: number): AgentContextSnapshot {
    return this.collect(conversationId, userId, beforeMessageId);
  }

  private collect(conversationId: number, userId: number, beforeMessageId?: number): AgentContextSnapshot {
    if (!this.repo.findConversation(conversationId, userId)) throw new NotFoundException('会话不存在或不属于当前用户');
    let state = empty();
    for (const message of this.repo.listMessages(conversationId, CONTEXT_LIMITS.messages)) {
      if (beforeMessageId !== undefined && message.id >= beforeMessageId) continue;
      if (message.role !== 'assistant' || !message.payloadJson) continue;
      try {
        const payload = JSON.parse(message.payloadJson) as AgentPayload;
        const stored = payload.context;
        if (stored?.version === 1) {
          state = { ...empty(), ...stored,
            archives: uniqueIds(stored.archives ?? []), activeArchives: uniqueIds(stored.activeArchives ?? []),
            activeFiles: uniqueIds(stored.activeFiles ?? []),
            attachments: (stored.attachments ?? []).filter(r => Number.isSafeInteger(r.fileId) && Number.isSafeInteger(r.archiveId) && r.fileId > 0 && r.archiveId > 0).slice(0, CONTEXT_LIMITS.entities),
            summary: String(stored.summary ?? '').slice(-CONTEXT_LIMITS.summaryChars),
            recentTurns: (stored.recentTurns ?? []).slice(-CONTEXT_LIMITS.recentTurns).map(q => q.slice(0, CONTEXT_LIMITS.questionChars)),
            previousQuestion: String(stored.previousQuestion ?? '').slice(0, CONTEXT_LIMITS.questionChars),
            tools: (stored.tools ?? []).slice(0, 12),
          };
        } else state = this.advance(state, '', payload); // Existing conversations remain usable.
      } catch { /* A damaged historical payload is not a source. */ }
    }
    return state;
  }

  advance(previous: AgentContextSnapshot, question: string, payload: AgentPayload): AgentContextSnapshot {
    const state = structuredClone(previous);
    const bounded = question.slice(0, CONTEXT_LIMITS.questionChars);
    const turns = [...state.recentTurns, bounded].filter(Boolean);
    const overflow = turns.splice(0, Math.max(0, turns.length - CONTEXT_LIMITS.recentTurns));
    state.summary = [state.summary, ...overflow.map(q => `用户曾问：${q}`)].filter(Boolean).join('\n').slice(-CONTEXT_LIMITS.summaryChars);
    state.recentTurns = turns;
    state.previousQuestion = bounded || state.previousQuestion;
    state.tools = (payload.toolResults ?? []).slice(0, 12).map(r => ({ name: r.toolName, status: r.status, total: r.total }));
    if (payload.contextSelection) {
      if (payload.contextSelection.focus === null) { state.archives = []; state.attachments = []; }
      const fresh = payload.unified?.attachments.items ?? [];
      if (!state.attachments.length && fresh.length) state.attachments = fresh.slice(0, CONTEXT_LIMITS.entities).map(f => ({ archiveId: f.archiveId, fileId: f.fileId }));
      state.activeArchives = uniqueIds(payload.contextSelection.archives);
      state.activeFiles = uniqueIds(payload.contextSelection.files);
      state.focus = payload.contextSelection.focus;
      return state;
    }
    if (['search', 'archive_info', 'unified_search'].includes(payload.kind)) {
      const files = payload.retrievedAttachments ?? payload.unified?.attachments.items ?? [];
      const cards = payload.unified?.archives.items ?? payload.items;
      state.archives = uniqueIds([...cards.map(c => c.id), ...files.map(f => f.archiveId)]);
      state.attachments = files.slice(0, CONTEXT_LIMITS.entities).map(f => ({ archiveId: f.archiveId, fileId: f.fileId }));
      state.activeArchives = [...state.archives];
      state.activeFiles = state.attachments.map(f => f.fileId);
      state.focus = state.attachments.length ? 'attachment' : state.archives.length ? 'archive' : null;
    } else if (payload.sources?.length || payload.retrievedEvidence?.length) {
      const sources = [...(payload.sources ?? []), ...(payload.retrievedEvidence ?? [])];
      state.archives = uniqueIds(sources.map(s => s.archiveId));
      state.activeArchives = [...state.archives];
      state.activeFiles = uniqueIds(sources.map(s => s.fileId));
      state.attachments = sources.filter((s, i, all) => all.findIndex(x => x.fileId === s.fileId) === i)
        .slice(0, CONTEXT_LIMITS.entities).map(s => ({ archiveId: s.archiveId, fileId: s.fileId }));
      state.focus = 'attachment';
    } else if(payload.graphCitations?.length) {
      state.archives=uniqueIds(payload.graphCitations.flatMap(c=>[c.fromArchiveId,c.toArchiveId].filter((id):id is number=>typeof id==='number')));
      state.activeArchives=[...state.archives];state.activeFiles=[];state.attachments=[];state.focus=state.archives.length?'archive':null;
    }
    return state;
  }
}
