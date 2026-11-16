/**
 * JitWord 接入配置（阶段二第三批）。
 * 安全边界：clientSecret 只在本进程内存存在，绝不进入接口响应、日志或前端构建产物。
 * 读取优先级：环境变量 > jitword-integration/config/config.local.json（已被 .gitignore 排除）。
 * 未配置密钥时视为「未接入」，在线编辑接口返回 503，不阻塞其余档案功能与回归测试。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface JitWordConfig {
  api: string;
  tenantKey: string;
  providerKey: string;
  clientSecret: string;
  editorUrl: string;
  /** 配置来源描述（不含密钥值），仅用于诊断展示。 */
  source: string;
}

/**
 * 票据 origin 策略：按当次请求动态解析，浏览器实际访问地址是什么就签给什么。
 * 背景：JitWord 校验票据 origin 必须与浏览器地址栏**完全一致**，固定单值会让 127.0.0.1、
 *       localhost、局域网 IP、公网域名互相冲突（表现为 PERMISSION_DENIED embed ticket origin mismatch）。
 * 规则（优先级从高到低）：
 *   1. 浏览器 Origin 请求头（同源 POST 由浏览器自动携带，最接近地址栏真实来源）；
 *   2. X-Forwarded-Host + X-Forwarded-Proto（反向代理/Nginx 场景）；
 *   3. Host + 连接协议或 X-Forwarded-Proto。
 * 默认不再要求预先登记公网域名，避免正式域名上线后在线编辑被旧白名单拦死；
 * 如需恢复严格白名单，设置 JITWORD_ORIGIN_STRICT=1，并用 JITWORD_ORIGIN 列出额外允许的来源。
 */

/** 取逗号分隔请求头的首个值（X-Forwarded-* 可能是数组或多值）。 */
function firstHeaderValue(input: unknown): string {
  const raw = Array.isArray(input) ? input[0] : input;
  return String(raw ?? '').split(',')[0].trim();
}

/** 归一化来源地址：只保留 scheme://host:port（小写、去路径与末尾斜杠）；非法或非 http(s) 返回 ''。 */
function normalizeOrigin(input: unknown): string {
  const text = String(input ?? '').trim();
  // 浏览器沙箱 iframe 会发送 Origin: null，不得当成主机名。
  if (!text || text.toLowerCase() === 'null') return '';
  // 容忍只写 host:port 的写法（补默认 http://）
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return '';
  }
}

/** 本机回环 / localhost / 私有网段：单机与局域网两种访问方式共用一个进程。 */
function isLocalHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

/** 是否启用严格来源白名单（显式开启后才拒绝未登记的公网域名）。 */
export function isStrictOriginMode(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.JITWORD_ORIGIN_STRICT || '').trim());
}

/** 额外允许的来源（JITWORD_ORIGIN，逗号分隔）；仅在严格模式下参与拦截。每次调用重新读取，便于测试与运行时注入。 */
export function extraAllowedOrigins(): string[] {
  return String(process.env.JITWORD_ORIGIN || '')
    .split(',')
    .map((item) => normalizeOrigin(item))
    .filter((item) => item !== '');
}

/**
 * 票据来源可用性判定。
 * 默认只要本次请求解析出的是合法 http(s) 来源就放行——origin 来自浏览器实际访问地址，
 * 不是客户端可随意指定的业务参数，厂商仍会按该值绑定 iframe。
 * 仅当显式设置 JITWORD_ORIGIN_STRICT=1 时，才退回「本机/私网/额外允许列表」的旧策略。
 */
export function isAllowedOrigin(origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (!isStrictOriginMode()) return true;
  if (extraAllowedOrigins().includes(normalized)) return true;
  try {
    return isLocalHostname(new URL(normalized).hostname);
  } catch {
    return false;
  }
}

/**
 * 由请求头解析本次访问的 origin（票据必须与浏览器地址栏一致，故不能再用固定常量）。
 * 优先使用浏览器 Origin 头；其次 X-Forwarded-*（代理场景）；最后 Host + 连接协议。
 * X-Forwarded-Proto 有多值时取首个，且仅在值为 https 时切换协议。
 */
export function resolveRequestOrigin(
  host: string | undefined,
  forwardedProto?: string | string[],
  fallbackProtocol = 'http',
  forwardedHost?: string | string[],
  originHeader?: string | string[],
): string {
  // 浏览器 Origin 头最接近地址栏：用户经 https 公网域名访问时，即使代理漏配转发头也能签对。
  const declared = normalizeOrigin(firstHeaderValue(originHeader));
  if (declared) return declared;

  const hostHeader = firstHeaderValue(forwardedHost) || String(host || '').trim();
  if (!hostHeader) return '';
  const forwarded = firstHeaderValue(forwardedProto).toLowerCase();
  const proto = forwarded === 'https' || (!forwarded && fallbackProtocol === 'https') ? 'https' : 'http';
  return normalizeOrigin(`${proto}://${hostHeader}`);
}

/** config.local.json 相对编译产物 apps/api/dist 与进程 cwd 的候选路径（阶段一验证程序的本地配置）。 */
function localConfigCandidates(): string[] {
  return [
    path.resolve(__dirname, '..', '..', '..', 'jitword-integration', 'config', 'config.local.json'),
    path.resolve(process.cwd(), 'jitword-integration', 'config', 'config.local.json'),
  ];
}

function readLocalFile(): Record<string, unknown> | null {
  for (const file of localConfigCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* 配置损坏时忽略该来源 */
    }
  }
  return null;
}

let cached: JitWordConfig | null | undefined;

/** 加载 JitWord 配置；密钥缺失返回 null（上层据此判定「未接入」）。 */
export function loadJitWordConfig(): JitWordConfig | null {
  if (cached !== undefined) return cached;
  const local = readLocalFile() || {};
  const str = (envVal: string | undefined, fileKey: string, fallback = '') =>
    envVal || String(local[fileKey] ?? '') || fallback;
  const api = str(process.env.JITWORD_API, 'api', 'https://inner.jitword.com/api/v1');
  const tenantKey = str(process.env.JITWORD_TENANT_KEY, 'tenantKey');
  const providerKey = str(process.env.JITWORD_PROVIDER_KEY, 'providerKey');
  const clientSecret = str(process.env.JITWORD_CLIENT_SECRET, 'clientSecret');
  const editorUrl = str(process.env.JITWORD_EDITOR_URL, 'editorUrl', 'https://inner.jitword.com/px-editor');

  if (!tenantKey || !providerKey || !clientSecret) {
    cached = null;
    return null;
  }
  const source = process.env.JITWORD_CLIENT_SECRET
    ? '环境变量 JITWORD_*'
    : 'jitword-integration/config/config.local.json（已 gitignore）';
  cached = { api, tenantKey, providerKey, clientSecret, editorUrl, source };
  return cached;
}

/** 测试用：清除配置缓存，允许注入环境后重新解析。 */
export function resetJitWordConfigCache(): void {
  cached = undefined;
}

/**
 * 文件预览 SDK 地址（JitWord-Preview，纯前端渲染，与密钥无关）。
 * 默认厂商 CDN 单文件构建；内网/离线部署可用 JITWORD_PREVIEW_SDK_URL 指向自托管目录。
 */
export const DEFAULT_PREVIEW_SDK_URL = 'https://jitword.com/preview_sdk/file-preview.bundle.js';

/** 解析预览 SDK 地址：仅接受 http(s) 绝对地址或站点内相对路径，其余回落到官方 CDN。 */
export function loadPreviewSdkUrl(): string {
  const raw = String(process.env.JITWORD_PREVIEW_SDK_URL || '').trim();
  if (!raw) return DEFAULT_PREVIEW_SDK_URL;
  if (/^https?:\/\//i.test(raw) || (raw.startsWith('/') && !raw.startsWith('//'))) return raw;
  return DEFAULT_PREVIEW_SDK_URL;
}
