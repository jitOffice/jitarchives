/**
 * 个人 AI 服务配置：按登录用户隔离保存，API Key 使用 AES-256-GCM 加密。
 * 只支持已知服务商的官方 HTTPS API 域名，避免自定义地址造成 SSRF。
 */
import {
  BadRequestException,
  Injectable,
  Inject,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DATABASE } from '../db/database';
import { appOptions } from '../app-options';
import type { AiModelConfig } from './agent.config';
import { AiModelClient, RealAiModelClient } from './ai-model.client';

export type AiProviderId = 'deepseek' | 'kimi' | 'qwen';

export interface AiProviderDefinition {
  id: AiProviderId;
  label: string;
  description: string;
  defaultApiBase: string;
  defaultModel: string;
  allowedHost: string;
}

export const AI_PROVIDER_DEFINITIONS: readonly AiProviderDefinition[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: '深度求索',
    defaultApiBase: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    allowedHost: 'api.deepseek.com',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    description: '月之暗面',
    defaultApiBase: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.5',
    allowedHost: 'api.moonshot.cn',
  },
  {
    id: 'qwen',
    label: '通义千问',
    description: '阿里云百炼',
    defaultApiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    allowedHost: 'dashscope.aliyuncs.com',
  },
];

export interface AiProviderSettingsItem {
  provider: AiProviderId;
  label: string;
  description: string;
  configured: boolean;
  enabled: boolean;
  model: string;
  apiBase: string;
  temperature: number;
  updatedAt: string | null;
}

export interface PersonalAiSettingsView {
  enabled: boolean;
  activeProvider: AiProviderId | null;
  activeProviderLabel: string | null;
  providers: AiProviderSettingsItem[];
}

interface AiProviderConfigRow {
  provider: AiProviderId;
  api_base: string;
  model: string;
  api_key_encrypted: string;
  temperature: number;
  enabled: number;
  updated_at: string;
}

export interface SaveAiProviderInput {
  apiKey?: unknown;
  model?: unknown;
  apiBase?: unknown;
  temperature?: unknown;
  enable?: unknown;
}

export interface TestAiProviderInput {
  apiKey?: unknown;
  model?: unknown;
  apiBase?: unknown;
  temperature?: unknown;
}

const KEY_AAD = Buffer.from('jitarchives:user-ai-provider-key:v1', 'utf8');
const AI_TIMEOUT_MS = 15000;

@Injectable()
export class PersonalAiSettingsService {
  constructor(@Inject(DATABASE) private readonly db: DatabaseSync) {}

  /** 返回当前账号的配置摘要；永远不返回 API Key 或密文。 */
  getSettings(userId: number): PersonalAiSettingsView {
    const rows = this.listRows(userId);
    const byProvider = new Map(rows.map((row) => [row.provider, row]));
    const active = rows.find((row) => row.enabled === 1) ?? null;
    return {
      enabled: !!active,
      activeProvider: active?.provider ?? null,
      activeProviderLabel: active ? this.definition(active.provider).label : null,
      providers: AI_PROVIDER_DEFINITIONS.map((definition) => {
        const row = byProvider.get(definition.id);
        return {
          provider: definition.id,
          label: definition.label,
          description: definition.description,
          configured: !!row,
          enabled: row?.enabled === 1,
          model: row?.model ?? definition.defaultModel,
          apiBase: row?.api_base ?? definition.defaultApiBase,
          temperature: row?.temperature ?? 0.7,
          updatedAt: row?.updated_at ?? null,
        };
      }),
    };
  }

  /** 当前账号启用的模型客户端；没有个人配置时兼容原有环境变量/测试桩。 */
  clientForUser(userId: number, fallback: AiModelClient): AiModelClient {
    const row = this.findActiveRow(userId);
    if (!row || appOptions.aiModelClient !== null && appOptions.aiModelClient !== undefined) {
      return fallback;
    }
    const config = this.toModelConfig(row);
    return new RealAiModelClient(fetch, () => config);
  }

  /** 当前账号正在使用的安全展示信息。 */
  activeModelInfo(userId: number): {
    provider: AiProviderId | null;
    providerLabel: string | null;
    model: string | null;
    configured: boolean;
  } {
    const row = this.findActiveRow(userId);
    if (row) {
      return {
        provider: row.provider,
        providerLabel: this.definition(row.provider).label,
        model: row.model,
        configured: true,
      };
    }
    return { provider: null, providerLabel: null, model: null, configured: false };
  }

  saveProvider(userId: number, providerId: string, input: SaveAiProviderInput): PersonalAiSettingsView {
    const definition = this.definition(providerId);
    const existing = this.findRow(userId, definition.id);
    const model = this.normalizeModel(input.model, existing?.model ?? definition.defaultModel);
    const apiBase = this.normalizeApiBase(definition, input.apiBase, existing?.api_base);
    const temperature = this.normalizeTemperature(input.temperature, existing?.temperature ?? 0.7);
    const suppliedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (suppliedKey.length > 4096) throw new BadRequestException('API Key 长度不能超过 4096 个字符');
    if (/[\r\n]/.test(suppliedKey)) throw new BadRequestException('API Key 格式不正确');
    const encryptedKey = suppliedKey
      ? this.encryptApiKey(suppliedKey)
      : existing?.api_key_encrypted ?? '';
    if (!encryptedKey) throw new BadRequestException('请填写 API Key');

    const shouldEnable = input.enable === true || existing?.enabled === 1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (shouldEnable) {
        this.db.prepare('UPDATE user_ai_provider_configs SET enabled = 0 WHERE user_id = ?').run(userId);
      }
      this.db.prepare(
        `INSERT INTO user_ai_provider_configs
          (user_id, provider, api_base, model, api_key_encrypted, temperature, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
          api_base = excluded.api_base,
          model = excluded.model,
          api_key_encrypted = excluded.api_key_encrypted,
          temperature = excluded.temperature,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at`,
      ).run(
        userId,
        definition.id,
        apiBase,
        model,
        encryptedKey,
        temperature,
        shouldEnable ? 1 : 0,
        existing?.updated_at ?? new Date().toISOString(),
        new Date().toISOString(),
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getSettings(userId);
  }

  activateProvider(userId: number, providerId: string): PersonalAiSettingsView {
    const definition = this.definition(providerId);
    const existing = this.findRow(userId, definition.id);
    if (!existing) throw new NotFoundException('该服务商尚未保存配置，请先填写 API Key 并保存');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE user_ai_provider_configs SET enabled = 0 WHERE user_id = ?').run(userId);
      this.db.prepare(
        'UPDATE user_ai_provider_configs SET enabled = 1, updated_at = ? WHERE user_id = ? AND provider = ?',
      ).run(new Date().toISOString(), userId, definition.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getSettings(userId);
  }

  disable(userId: number): PersonalAiSettingsView {
    this.db.prepare('UPDATE user_ai_provider_configs SET enabled = 0 WHERE user_id = ?').run(userId);
    return this.getSettings(userId);
  }

  removeProvider(userId: number, providerId: string): PersonalAiSettingsView {
    const definition = this.definition(providerId);
    this.db.prepare('DELETE FROM user_ai_provider_configs WHERE user_id = ? AND provider = ?').run(userId, definition.id);
    return this.getSettings(userId);
  }

  /** 测试连接只发送固定探测文本，不发送档案内容、会话历史或用户资料。 */
  async testConnection(userId: number, providerId: string, input: TestAiProviderInput): Promise<{ ok: true; message: string }> {
    const definition = this.definition(providerId);
    const existing = this.findRow(userId, definition.id);
    const suppliedKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (suppliedKey.length > 4096 || /[\r\n]/.test(suppliedKey)) {
      throw new BadRequestException('API Key 格式不正确或长度超过限制');
    }
    const apiKey = suppliedKey || (existing ? this.decryptApiKey(existing.api_key_encrypted) : '');
    if (!apiKey) throw new BadRequestException('请先填写 API Key');
    const config: AiModelConfig = {
      apiBase: this.normalizeApiBase(definition, input.apiBase, existing?.api_base),
      model: this.normalizeModel(input.model, existing?.model ?? definition.defaultModel),
      apiKey,
      timeoutMs: AI_TIMEOUT_MS,
      temperature: this.normalizeTemperature(input.temperature, existing?.temperature ?? 0.7),
    };
    // 自动化测试使用注入桩，绝不访问真实服务商；正式运行时使用本次表单的临时配置。
    const client = appOptions.aiModelClient ?? new RealAiModelClient(fetch, () => config);
    if (!client.available) throw new ServiceUnavailableException('模型客户端当前不可用');
    try {
      await client.chatCompletion([{ role: 'user', content: '请只回复 OK。' }], { maxTokens: 8 });
      return { ok: true, message: '连接成功，模型服务可以正常响应。' };
    } catch (error) {
      const message = String((error as Error)?.message ?? '');
      if (/HTTP 401|HTTP 403/.test(message)) {
        throw new BadRequestException('连接失败：API Key 无效或没有调用权限。');
      }
      if (/HTTP 404/.test(message)) {
        throw new BadRequestException('连接失败：模型名称或 API 地址不正确。');
      }
      if (/HTTP 429/.test(message)) {
        throw new BadRequestException('连接失败：请求过于频繁或账户额度不足。');
      }
      if (/HTTP 5\d\d/.test(message)) {
        throw new ServiceUnavailableException('连接失败：AI 服务商暂时不可用，请稍后重试。');
      }
      if (/超时/.test(message)) {
        throw new ServiceUnavailableException('连接失败：请求超时，请检查网络后重试。');
      }
      throw new ServiceUnavailableException('连接失败：无法访问 AI 服务，请检查配置和网络。');
    }
  }

  private listRows(userId: number): AiProviderConfigRow[] {
    return this.db.prepare(
      'SELECT provider, api_base, model, api_key_encrypted, temperature, enabled, updated_at FROM user_ai_provider_configs WHERE user_id = ? ORDER BY provider',
    ).all(userId) as unknown as AiProviderConfigRow[];
  }

  private findRow(userId: number, provider: AiProviderId): AiProviderConfigRow | null {
    return (this.db.prepare(
      'SELECT provider, api_base, model, api_key_encrypted, temperature, enabled, updated_at FROM user_ai_provider_configs WHERE user_id = ? AND provider = ?',
    ).get(userId, provider) as AiProviderConfigRow | undefined) ?? null;
  }

  private findActiveRow(userId: number): AiProviderConfigRow | null {
    return (this.db.prepare(
      'SELECT provider, api_base, model, api_key_encrypted, temperature, enabled, updated_at FROM user_ai_provider_configs WHERE user_id = ? AND enabled = 1 LIMIT 1',
    ).get(userId) as AiProviderConfigRow | undefined) ?? null;
  }

  private definition(providerId: string): AiProviderDefinition {
    const definition = AI_PROVIDER_DEFINITIONS.find((item) => item.id === providerId);
    if (!definition) throw new BadRequestException('不支持的 AI 服务商');
    return definition;
  }

  private normalizeModel(raw: unknown, fallback: string): string {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const model = value || fallback;
    if (model.length > 120 || /[\r\n]/.test(model)) {
      throw new BadRequestException('模型名称不能为空且不能超过 120 个字符');
    }
    return model;
  }

  private normalizeTemperature(raw: unknown, fallback: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      throw new BadRequestException('Temperature 必须在 0 到 2 之间');
    }
    return Math.round(value * 10) / 10;
  }

  private normalizeApiBase(definition: AiProviderDefinition, raw: unknown, existing?: string): string {
    const value = typeof raw === 'string' && raw.trim() ? raw.trim() : existing || definition.defaultApiBase;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('API 地址格式不正确');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname.toLowerCase() !== definition.allowedHost ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname) ||
      url.pathname.includes('..')
    ) {
      throw new BadRequestException('API 地址必须使用该服务商官方 HTTPS 地址');
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  private toModelConfig(row: AiProviderConfigRow): AiModelConfig {
    return {
      apiBase: row.api_base,
      model: row.model,
      apiKey: this.decryptApiKey(row.api_key_encrypted),
      timeoutMs: AI_TIMEOUT_MS,
      temperature: row.temperature ?? 0.7,
    };
  }

  private encryptionKey(): Buffer {
    const fromEnv = String(process.env.JIT_AI_SETTINGS_ENCRYPTION_KEY ?? '').trim();
    if (fromEnv) {
      const key = /^[0-9a-f]{64}$/i.test(fromEnv)
        ? Buffer.from(fromEnv, 'hex')
        : Buffer.from(fromEnv, 'base64');
      if (key.length !== 32) {
        throw new ServiceUnavailableException('服务端 AI 配置加密密钥无效，请配置 32 字节密钥');
      }
      return key;
    }

    // 未提供环境变量时，在数据库 storage 目录生成仅服务端使用的随机密钥文件。
    // 该文件已被 apps/api/storage/ 忽略，不会进入 Git；部署备份时必须一并安全备份。
    const keyFile = path.join(path.dirname(path.resolve(appOptions.dbFile)), 'ai-settings.key');
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    try {
      const existing = fs.readFileSync(keyFile);
      if (existing.length !== 32) throw new Error('invalid key length');
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ServiceUnavailableException('个人 AI 配置加密密钥文件不可用，请联系系统维护人员');
      }
    }

    const generated = randomBytes(32);
    try {
      fs.writeFileSync(keyFile, generated, { flag: 'wx', mode: 0o600 });
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ServiceUnavailableException('无法创建个人 AI 配置加密密钥文件');
      }
      const raced = fs.readFileSync(keyFile);
      if (raced.length !== 32) throw new ServiceUnavailableException('个人 AI 配置加密密钥文件格式错误');
      return raced;
    }
  }

  private encryptApiKey(apiKey: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
    cipher.setAAD(KEY_AAD);
    const encrypted = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  private decryptApiKey(envelope: string): string {
    try {
      const [version, ivText, tagText, encryptedText] = envelope.split('.');
      if (version !== 'v1' || !ivText || !tagText || !encryptedText) throw new Error('invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), Buffer.from(ivText, 'base64url'));
      decipher.setAAD(KEY_AAD);
      decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new ServiceUnavailableException('个人 AI 配置无法解密，请检查服务端加密密钥是否与保存时一致');
    }
  }
}
