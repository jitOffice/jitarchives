/** Independent server-side embedding contract. Chat-provider settings are never consulted. */
import { createHash } from 'node:crypto';

export const EMBEDDING_CLIENT = 'JIT_EMBEDDING_CLIENT';
export interface EmbeddingClient {
  readonly available: boolean;
  /** Changes when endpoint, model or operator-supplied model revision changes. */
  readonly modelKey: string;
  embed(texts: string[]): Promise<number[][]>;
}

export function validVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 8192 &&
    value.every(n => typeof n === 'number' && Number.isFinite(n)) && value.some(n => n !== 0);
}

export class HttpEmbeddingClient implements EmbeddingClient {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly send: typeof fetch = fetch) {}
  private config() {
    const base = this.env.JIT_EMBEDDING_API_BASE?.trim().replace(/\/+$/, '');
    const model = this.env.JIT_EMBEDDING_MODEL?.trim();
    const key = this.env.JIT_EMBEDDING_API_KEY?.trim();
    if (!base || !model || !key) return null;
    try {
      const url = new URL(base);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
      return { base, model, key };
    } catch { return null; }
  }
  get available(): boolean { return this.config() !== null; }
  get modelKey(): string {
    const c = this.config();
    return c ? createHash('sha256').update(JSON.stringify([c.base, c.model, this.env.JIT_EMBEDDING_REVISION ?? '1'])).digest('hex') : '';
  }
  async embed(texts: string[]): Promise<number[][]> {
    const c = this.config();
    if (!c || !texts.length || texts.length > 32 || texts.some(t => !t.trim() || t.length > 2000)) throw new Error('Embedding 未配置或输入无效');
    const timeout = Math.min(60000, Math.max(1000, Number(this.env.JIT_EMBEDDING_TIMEOUT_MS) || 15000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this.send(`${c.base}/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.key}` },
        body: JSON.stringify({ model: c.model, input: texts, encoding_format: 'float' }), signal: controller.signal,
      });
      // Provider errors may contain secrets or document text; never expose their body.
      if (!response.ok) throw new Error('provider error');
      const body = await response.text();
      if (body.length > 8_000_000) throw new Error('oversized response');
      const data = JSON.parse(body).data;
      if (!Array.isArray(data) || data.length !== texts.length) throw new Error('invalid count');
      const sorted = [...data].sort((a, b) => a.index - b.index);
      if (sorted.some((r, i) => r.index !== i || !validVector(r.embedding))) throw new Error('invalid vector');
      const vectors: number[][] = sorted.map(r => r.embedding);
      if (vectors.some(v => v.length !== vectors[0].length)) throw new Error('dimension mismatch');
      return vectors;
    } catch { throw new Error('Embedding 服务不可用或返回无效向量'); }
    finally { clearTimeout(timer); }
  }
}
