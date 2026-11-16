import type { AiModelClient, ChatMessage } from './ai-model.client';

/** Conservative estimate, not a vendor tokenizer. CJK costs more than Latin text. */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u2e80-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  return Math.ceil((cjk * 1.25 + (text.length - cjk) / 3) * 1.1);
}
export function contextWindow(model?: Pick<AiModelClient, 'contextWindowTokens'>): number {
  const configured = model?.contextWindowTokens ?? Number(process.env.JIT_AI_CONTEXT_TOKENS || 16384);
  return Number.isFinite(configured) ? Math.max(4096, Math.min(131072, configured)) : 16384;
}
export function requestBudget(messages: ChatMessage[], outputTokens: number, model?: Pick<AiModelClient, 'contextWindowTokens'>) {
  const contextTokens = contextWindow(model);
  const systemTokens = estimateTokens(messages.filter(m => m.role === 'system').map(m => m.content).join('\n'));
  const inputTokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 8, 0);
  const safetyTokens = Math.max(512, Math.ceil(contextTokens * 0.1));
  return { contextTokens, systemTokens, inputTokens, outputTokens, safetyTokens,
    fits: inputTokens + outputTokens + safetyTokens <= contextTokens };
}
