/**
 * AI 模型服务适配层（第一阶段：仅用于自然语言检索意图抽取）。
 *
 * 设计约束：
 * - 只走 OpenAI 兼容的 /chat/completions 接口（PRD「AI 接口可插拔，支持多厂商模型切换」）；
 * - 仅用 Node 内置 fetch，零新增依赖（与 jitword.client 同一模式）；
 * - 模型只被允许输出「结构化检索条件」，不参与权限判定、不拼接 SQL、不访问数据库、不指定 URL；
 * - 客户端接口为抽象契约，测试可注入桩实现避免触网；未配置密钥时 available=false，调用即抛错。
 */
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AiModelConfig, loadAiModelConfig } from './agent.config';
import { AgentCancelledError } from './agent.cancellation';

/** Nest DI Token：模型客户端（测试可替换为桩实现）。 */
export const AI_MODEL_CLIENT = 'JIT_AI_MODEL_CLIENT';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  /** 模型返回的正文字符串。 */
  content: string;
  /** 是否被截断（达到 max_tokens 上限）。 */
  truncated: boolean;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface AiModelClient {
  readonly contextWindowTokens?: number;
  readonly provider?: string;
  /** 是否已完成配置并可用（不触发网络请求）。 */
  readonly available: boolean;
  /** 模型名（可用于状态展示；未配置时为 null）。 */
  readonly model: string | null;
  /** 发起一次对话补全；网络失败/超时/非 2xx 一律抛 Error，由上层降级为规则解析。temperature 可逐次覆盖个人配置（结构化输出需低温度）。 */
  chatCompletion(messages: ChatMessage[], options?: { maxTokens?: number; timeoutMs?: number; temperature?: number; signal?: AbortSignal }): Promise<ChatCompletionResult>;
}

/** 单次请求的最大正文字符数保护（意图 JSON 很小，防止异常长响应拖垮内存）。 */
const MAX_CONTENT_CHARS = 24000;

export class AiModelError extends Error {
  constructor(public readonly code: 'call_failed' | 'empty_content' | 'invalid_json', message: string) { super(message); }
}

@Injectable()
export class RealAiModelClient implements AiModelClient {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly configProvider: () => AiModelConfig | null = loadAiModelConfig,
  ) {}

  /** 默认读取环境变量；个人配置场景注入仅属于当前用户的配置读取器。 */
  get available(): boolean {
    return this.configProvider() !== null;
  }

  get model(): string | null {
    return this.configProvider()?.model ?? null;
  }

  get provider(): string {
    const base = this.configProvider()?.apiBase;
    if (!base) return 'unconfigured';
    const host = new URL(base).hostname;
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com') ? 'deepseek' : 'openai-compatible';
  }

  async chatCompletion(
    messages: ChatMessage[],
    options: { maxTokens?: number; timeoutMs?: number; temperature?: number; signal?: AbortSignal } = {},
  ): Promise<ChatCompletionResult> {
    // 每次调用重新读取配置；个人配置读取器只绑定当前用户的加密配置。
    const config = this.configProvider();
    if (!config) {
      throw new ServiceUnavailableException('模型服务未配置');
    }
    const controller = new AbortController();
    const externalSignal = options.signal;
    const abortFromCaller = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutMs = options.timeoutMs === undefined ? config.timeoutMs : Math.max(1000, Math.min(60000, options.timeoutMs));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${config.apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          // 结构化 JSON 输出场景由调用方显式压低温度，不受个人配置（默认 0.7）影响。
          temperature: options.temperature === undefined ? config.temperature : Math.min(Math.max(options.temperature, 0), 2),
          max_tokens: options.maxTokens ?? 512,
          stream: false,
        }),
        signal: controller.signal,
      });
      // Keep the timeout active while reading the body, not just until headers arrive.
      text = await response.text();
    } catch (err) {
      // 用户主动停止不是模型故障：交由上层直接终止，不进入降级或重试流程。
      if (externalSignal?.aborted) throw new AgentCancelledError();
      const reason = (err as Error)?.name === 'AbortError' ? '请求超时' : '网络错误';
      throw new AiModelError('call_failed', `模型服务不可用（${reason}）`);
    } finally {
      externalSignal?.removeEventListener('abort', abortFromCaller);
      clearTimeout(timer);
    }
    if (!response.ok) {
      // 只带状态码，不回显厂商原始错误体（可能包含请求内容或账号信息）。
      throw new AiModelError('call_failed', `模型服务返回异常（HTTP ${response.status}）`);
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      throw new AiModelError('invalid_json', '模型服务返回了无法解析的内容');
    }
    const choices = payload?.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const finishReason = String(choices?.[0]?.finish_reason ?? '');
    // All three personal providers use this adapter. Some compatible gateways return
    // text blocks instead of a string. Reasoning-only fields are never business answers.
    const raw = message?.content;
    const content = typeof raw === 'string' ? raw : Array.isArray(raw)
      ? raw.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : '';
    if (!content.trim() && finishReason !== 'length') throw new AiModelError('empty_content', '模型服务未返回有效内容');
    const usage = payload?.usage as Record<string, unknown> | undefined;
    const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
    return { content: content.slice(0, MAX_CONTENT_CHARS), finishReason, truncated: finishReason === 'length' || content.length > MAX_CONTENT_CHARS,
      ...(usage ? { usage: { inputTokens: number(usage.prompt_tokens), outputTokens: number(usage.completion_tokens) } } : {}) };
  }
}
