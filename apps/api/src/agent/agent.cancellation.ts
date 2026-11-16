import { AsyncLocalStorage } from 'node:async_hooks';

/** 用户主动终止本次回答：与普通失败区分，避免降级流程把已终止的请求继续执行或落库。 */
export class AgentCancelledError extends Error {
  constructor() {
    super('已终止本次回答');
    this.name = 'AgentCancelledError';
  }
}

const storage = new AsyncLocalStorage<AbortSignal>();

/** 在本次 Agent 请求的异步调用链中传递终止信号（不依赖逐层参数）。 */
export function withAgentCancellation<T>(signal: AbortSignal | undefined, work: () => T): T {
  return signal ? storage.run(signal, work) : work();
}

/** 当前请求的终止信号；未接入终止能力的调用返回 undefined。 */
export function agentCancellationSignal(): AbortSignal | undefined {
  return storage.getStore();
}

/** 在检索、模型调用与落库前检查终止状态。 */
export function throwIfAgentCancelled(): void {
  if (storage.getStore()?.aborted) throw new AgentCancelledError();
}

export function isAgentCancelled(error: unknown): error is AgentCancelledError {
  return error instanceof AgentCancelledError;
}
