import { AsyncLocalStorage } from 'node:async_hooks';
import type { AiModelClient } from './ai-model.client';
import { estimateTokens } from './token.budget';
import { AgentCancelledError, agentCancellationSignal, throwIfAgentCancelled } from './agent.cancellation';

export class ExecutionBudget {
  readonly maxToolCallsPerRound = 24;
  readonly maxToolCallsTotal = 64;
  readonly maxSupplementRounds = 1;
  // Cumulative budget across all bounded retrieval/summarization calls; each individual
  // model request is still constrained by the provider's context window.
  readonly maxTokensTotal = 500000;
  toolCalls = 0;
  roundCalls = 0;
  tokens = 0;
  exhausted = false;
  unfinished: string[] = [];
  beginRound() { this.roundCalls = 0; }
  takeTool(name: string) {
    if (this.toolCalls >= this.maxToolCallsTotal || this.roundCalls >= this.maxToolCallsPerRound) {
      this.exhausted = true; this.unfinished.push(name); throw new Error('EXECUTION_BUDGET');
    }
    this.toolCalls++; this.roundCalls++;
  }
  reserveTokens(count: number) {
    if (this.tokens + count > this.maxTokensTotal) {
      this.exhausted = true; this.unfinished.push('model'); throw new Error('EXECUTION_BUDGET');
    }
    this.tokens += count;
  }
  snapshot() { return { maxToolCallsPerRound: this.maxToolCallsPerRound, maxToolCallsTotal: this.maxToolCallsTotal,
    maxSupplementRounds: this.maxSupplementRounds, maxTokensTotal: this.maxTokensTotal,
    toolCalls: this.toolCalls, tokens: this.tokens, exhausted: this.exhausted, unfinished: [...new Set(this.unfinished)] }; }
}
const storage = new AsyncLocalStorage<ExecutionBudget>();
export const executionBudget = () => storage.getStore();
export const withExecutionBudget = <T>(work: () => T): T => storage.run(new ExecutionBudget(), work);
export function budgetedModel(model: AiModelClient): AiModelClient {
  return { get available() { return model.available; }, get model() { return model.model; },
    get provider() { return model.provider; }, get contextWindowTokens() { return model.contextWindowTokens; },
    async chatCompletion(messages, options) {
      throwIfAgentCancelled();
      const budget = executionBudget();
      const reserved = messages.reduce((n, m) => n + estimateTokens(m.content) + 8, 0) + (options?.maxTokens ?? 512);
      budget?.reserveTokens(reserved);
      // Reserve conservatively even on provider failure; retries never receive a fresh allowance.
      const signal = agentCancellationSignal();
      try {
        const result = await model.chatCompletion(messages, signal ? { ...options, signal } : options);
        throwIfAgentCancelled();
        return result;
      } catch (error) {
        if (signal?.aborted) throw new AgentCancelledError();
        throw error;
      }
    } };
}
