/**
 * 档案 Agent 助理 —— 模型服务配置（第一阶段）。
 * 安全边界：API Key 只在本进程内存存在，绝不进入接口响应、日志或前端构建产物。
 * 仅从环境变量读取（不提供文件回落，避免密钥被误写入仓库或被前端读取）。
 *
 * 未配置时视为「模型服务不可用」：Agent 仍可用确定性规则完成标题/档号/关键词/分类检索，
 * 但不会伪装成 AI 理解，也不会生成任何虚假回复。
 */

export interface AiModelConfig {
  /** OpenAI 兼容接口基址，形如 https://api.deepseek.com/v1（不含 /chat/completions）。 */
  apiBase: string;
  /** 模型名，如 deepseek-chat / qwen-plus。 */
  model: string;
  /** 密钥（仅服务端内存）。 */
  apiKey: string;
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number;
  /** 采样温度：意图抽取要求稳定，默认极低。 */
  temperature: number;
}

export const DEFAULT_AI_TIMEOUT_MS = 8000;
const DEFAULT_AI_TEMPERATURE = 0.1;

/** 归一化基址：去末尾斜杠，仅接受 http(s) 绝对地址。 */
function normalizeApiBase(raw: string): string {
  const text = raw.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(text) ? text : '';
}

/**
 * 读取模型服务配置。任一必填项缺失或地址非法即返回 null（上层据此走确定性兜底）。
 * 每次调用重新读取环境变量，便于测试注入与运行时开关。
 */
export function loadAiModelConfig(): AiModelConfig | null {
  const apiBase = normalizeApiBase(String(process.env.JIT_AI_API_BASE || ''));
  const model = String(process.env.JIT_AI_MODEL || '').trim();
  const apiKey = String(process.env.JIT_AI_API_KEY || '').trim();
  if (!apiBase || !model || !apiKey) return null;
  const timeoutMs = Math.max(
    1000,
    Number(process.env.JIT_AI_TIMEOUT_MS || DEFAULT_AI_TIMEOUT_MS) || DEFAULT_AI_TIMEOUT_MS,
  );
  const temperature = Number(process.env.JIT_AI_TEMPERATURE || DEFAULT_AI_TEMPERATURE);
  return {
    apiBase,
    model,
    apiKey,
    timeoutMs,
    temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 2) : DEFAULT_AI_TEMPERATURE,
  };
}

/** 模型服务是否已配置（不含密钥信息，可安全用于状态接口展示）。 */
export function isAiModelConfigured(): boolean {
  return loadAiModelConfig() !== null;
}

/** 状态展示视图：仅暴露模型名与是否已配置，绝不暴露密钥。 */
export function aiModelPublicInfo(): { configured: boolean; model: string | null; apiBase: string | null } {
  const config = loadAiModelConfig();
  return config
    ? { configured: true, model: config.model, apiBase: config.apiBase }
    : { configured: false, model: null, apiBase: null };
}
