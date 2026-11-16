/**
 * 配置加载：只读取结构化 JSON 文件与环境变量，绝不执行配置文本中的任何代码。
 *
 * 优先级：环境变量 > config/config.local.json
 * clientSecret 只停留在本进程内存，任何日志/接口都不得输出其值。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_DIR = path.join(ROOT_DIR, 'config');
export const LOCAL_CONFIG_FILE = path.join(CONFIG_DIR, 'config.local.json');
export const RUNTIME_DIR = path.join(ROOT_DIR, 'runtime');
export const EXPORT_DIR = path.join(RUNTIME_DIR, 'exports');
export const STATE_FILE = path.join(RUNTIME_DIR, 'state.json');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const ENV_KEYS = {
  api: 'JITWORD_API',
  tenantKey: 'JITWORD_TENANT_KEY',
  providerKey: 'JITWORD_PROVIDER_KEY',
  clientSecret: 'JITWORD_CLIENT_SECRET',
  origin: 'JITWORD_ORIGIN',
  docId: 'JITWORD_DOC_ID',
  port: 'JITWORD_PORT',
  editorUrl: 'JITWORD_EDITOR_URL',
};

/** 该字段属于敏感值，任何时候都不得出现在日志、接口响应、前端或报告中 */
export const SECRET_FIELDS = ['clientSecret'];

const stripSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

function readEnv(env) {
  const out = {};
  for (const [field, key] of Object.entries(ENV_KEYS)) {
    const raw = env[key];
    if (raw !== undefined && String(raw).trim() !== '') out[field] = String(raw).trim();
  }
  return out;
}

export async function loadConfig({ env = process.env } = {}) {
  let fileConfig = {};
  let configSource = 'env-only';
  try {
    fileConfig = JSON.parse(await readFile(LOCAL_CONFIG_FILE, 'utf8'));
    configSource = path.relative(ROOT_DIR, LOCAL_CONFIG_FILE);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new Error(`本地配置文件解析失败（${path.relative(ROOT_DIR, LOCAL_CONFIG_FILE)}）：${error.message}`);
    }
  }

  const merged = { ...fileConfig, ...readEnv(env) };
  const config = {
    api: stripSlash(merged.api),
    tenantKey: String(merged.tenantKey || '').trim(),
    providerKey: String(merged.providerKey || '').trim(),
    clientSecret: String(merged.clientSecret || '').trim(),
    origin: stripSlash(merged.origin),
    docId: String(merged.docId || '').trim(),
    port: Number(merged.port || 3000),
    editorUrl: stripSlash(merged.editorUrl),
    configSource,
  };

  if (!config.editorUrl) {
    config.editorUrl = config.api.endsWith('/api/v1')
      ? `${config.api.slice(0, -'/api/v1'.length)}/px-editor`
      : '';
  }
  config.loaderUrl = config.editorUrl ? `${config.editorUrl}/iframe-sdk/v1/loader.js` : '';

  const missing = ['api', 'tenantKey', 'providerKey', 'clientSecret', 'editorUrl']
    .filter((field) => !config[field]);
  if (missing.length) {
    throw new Error(`接入配置缺失：${missing.join('、')}（请检查 config/config.local.json 或环境变量，值不会被打印）`);
  }

  return config;
}

/** 面向浏览器的配置视图：显式白名单，杜绝密钥随字段扩散 */
export function publicConfig(config, extra = {}) {
  return {
    apiBase: config.api,
    editorUrl: config.editorUrl,
    loaderUrl: config.loaderUrl,
    sdkChannel: 'v1',
    tenantKey: config.tenantKey,
    providerKey: config.providerKey,
    ...extra,
  };
}

/** 断言任意文本中不含密钥，用于接口/日志的兜底自检 */
export function leaksSecret(text, secret) {
  if (!secret) return false;
  return String(text).includes(secret);
}
