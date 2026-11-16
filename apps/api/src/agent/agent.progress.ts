import { Injectable } from '@nestjs/common';
import type { AgentTraceStep } from './agent.trace';

export type AgentProgressStageId = 'understand' | 'archives' | 'content' | 'evidence' | 'answer';
export type AgentProgressStageStatus = AgentTraceStep['status'];
export interface AgentProgressStageView {
  id: AgentProgressStageId;
  status: AgentProgressStageStatus;
  /** 仅允许服务端生成的回答阶段提示，不透传原始诊断或模型内容。 */
  detail?: string;
}
export interface AgentProgressView {
  status: 'running' | 'completed' | 'failed';
  steps: AgentProgressStageView[];
}

interface ProgressRecord extends AgentProgressView {
  expiresAt: number;
  /** 用户点击「停止生成」时中止正在执行的模型请求。 */
  controller: AbortController;
}

const STAGE_IDS: AgentProgressStageId[] = ['understand', 'archives', 'content', 'evidence', 'answer'];
const INITIAL_STEPS: AgentProgressStageView[] = STAGE_IDS.map((id) => ({
  id,
  status: id === 'understand' ? 'running' : 'waiting',
}));
const RECORD_TTL_MS = 10 * 60 * 1000;
const COMPLETED_TTL_MS = 2 * 60 * 1000;

function key(userId: number, requestId: string): string {
  return `${userId}:${requestId}`;
}

function publicAnswerDetail(note?: string): string | undefined {
  if (!note) return undefined;
  if (/^正在整理分段资料（共 \d+ 部分）$/u.test(note) || /^已整理 \d+\/\d+ 部分资料$/u.test(note)) return note;
  if (['正在合并各部分内容', '正在核对事实与引用', '正在生成最终回答'].includes(note)) return note;
  return undefined;
}

function combinedStatus(steps: AgentTraceStep[], ids: string[]): AgentProgressStageStatus {
  const states = ids.map((id) => steps.find((step) => step.id === id)?.status)
    .filter((status): status is AgentProgressStageStatus => status !== undefined);
  if (!states.length) return 'waiting';
  if (states.includes('running')) return 'running';
  if (states.includes('failed')) return 'failed';
  if (states.includes('completed')) return 'completed';
  if (states.includes('empty')) return 'empty';
  if (states.every((status) => status === 'skipped')) return 'skipped';
  return 'waiting';
}

/**
 * Short-lived, per-user progress snapshots for an in-flight Agent request.
 * Only public stage IDs and statuses are exposed; internal trace labels, notes,
 * tool names, counts and diagnostics never leave the server through this API.
 */
@Injectable()
export class AgentProgressService {
  private readonly records = new Map<string, ProgressRecord>();
  /** 终止请求可能先于 ask 到达服务端：先登记墓碑，start 时立即生成已中止的信号。 */
  private readonly cancelled = new Map<string, number>();

  start(userId: number, requestId: string): void {
    this.prune();
    const recordKey = key(userId, requestId);
    const controller = new AbortController();
    if (this.cancelled.delete(recordKey)) controller.abort();
    this.records.set(recordKey, {
      status: 'running',
      steps: INITIAL_STEPS.map((step) => ({ ...step })),
      expiresAt: Date.now() + RECORD_TTL_MS,
      controller,
    });
    while (this.records.size > 500) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  update(userId: number, requestId: string, trace: AgentTraceStep[]): void {
    const record = this.records.get(key(userId, requestId));
    if (!record || record.status !== 'running') return;
    const answerTrace = trace.find((step) => step.id === 'answer');
    const incoming: AgentProgressStageView[] = [
      { id: 'understand', status: combinedStatus(trace, ['understand']) },
      { id: 'archives', status: combinedStatus(trace, ['archives']) },
      { id: 'content', status: combinedStatus(trace, ['attachments', 'content']) },
      { id: 'evidence', status: combinedStatus(trace, ['evidence']) },
      { id: 'answer', status: combinedStatus(trace, ['answer']), ...(publicAnswerDetail(answerTrace?.note) ? { detail: publicAnswerDetail(answerTrace?.note) } : {}) },
    ];
    const current = new Map(record.steps.map((step) => [step.id, step]));
    record.steps = incoming.map((step) => {
      const previous = current.get(step.id);
      const status = step.status === 'waiting' ? previous?.status ?? 'waiting' : step.status;
      const detail = step.detail ?? previous?.detail;
      return { id: step.id, status, ...(step.id === 'answer' && detail ? { detail } : {}) };
    });
    record.expiresAt = Date.now() + RECORD_TTL_MS;
  }

  complete(userId: number, requestId: string): void {
    const record = this.records.get(key(userId, requestId));
    if (!record || record.controller.signal.aborted) return;
    record.status = 'completed';
    record.steps = record.steps.map((step) => ({
      ...step,
      status: step.status === 'running' ? 'completed' : step.status === 'waiting' ? 'skipped' : step.status,
    }));
    record.expiresAt = Date.now() + COMPLETED_TTL_MS;
  }

  fail(userId: number, requestId: string): void {
    const record = this.records.get(key(userId, requestId));
    if (!record) return;
    record.status = 'failed';
    record.steps = record.steps.map((step) => ({
      ...step,
      status: step.status === 'running' ? 'failed' : step.status,
    }));
    record.expiresAt = Date.now() + COMPLETED_TTL_MS;
  }

  get(userId: number, requestId: string): AgentProgressView | null {
    this.prune();
    const record = this.records.get(key(userId, requestId));
    if (!record) return null;
    return { status: record.status, steps: record.steps.map((step) => ({ ...step })) };
  }

  /** 当前请求的终止信号；请求不存在或已结束时返回 undefined。 */
  signal(userId: number, requestId: string): AbortSignal | undefined {
    return this.records.get(key(userId, requestId))?.controller.signal;
  }

  /** 用户主动停止：只中止仍在执行的请求，重复调用无副作用。 */
  cancel(userId: number, requestId: string): boolean {
    const recordKey = key(userId, requestId);
    const record = this.records.get(recordKey);
    if (record) {
      if (record.status !== 'running' || record.controller.signal.aborted) return false;
      record.controller.abort();
      return true;
    }
    // ask 尚未登记：留下短时墓碑，避免「立即停止」时请求仍继续执行。
    this.cancelled.set(recordKey, Date.now() + COMPLETED_TTL_MS);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [recordKey, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(recordKey);
    }
    for (const [recordKey, expiresAt] of this.cancelled) {
      if (expiresAt <= now) this.cancelled.delete(recordKey);
    }
  }
}
