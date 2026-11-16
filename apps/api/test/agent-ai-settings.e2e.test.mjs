/**
 * 个人 AI 设置验收：五类登录角色均可配置，配置按 user_id 隔离，密钥只以密文落库。
 * 使用独立 SQLite 测试库与注入模型桩，不访问 DeepSeek / Kimi / 千问真实服务。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-agent-ai-settings-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-file-store-ai-settings-${process.pid}`);
const OLD_ENCRYPTION_KEY = process.env.JIT_AI_SETTINGS_ENCRYPTION_KEY;
process.env.JIT_AI_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

let baseUrl = '';
let app = null;
let adminCookie = '';
const cookies = {};
const users = [
  { key: 'cataloger', username: 'ai_cat', displayName: 'AI 著录员', password: 'Cat#12345', role: 'cataloger' },
  { key: 'reviewer', username: 'ai_rev', displayName: 'AI 审核员', password: 'Rev#12345', role: 'reviewer' },
  { key: 'borrower', username: 'ai_bor', displayName: 'AI 借阅者', password: 'Bor#12345', role: 'borrower' },
  { key: 'guest', username: 'ai_guest', displayName: 'AI 访客', password: 'Gst#12345', role: 'guest' },
];
const ADMIN = { username: 'ai_admin', displayName: 'AI 管理员', password: 'Admin#12345' };
const modelStub = {
  available: false,
  model: 'test-model',
  calls: 0,
  async chatCompletion() {
    this.calls += 1;
    return { content: 'OK', truncated: false };
  },
};

async function req(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  let nextCookie = cookie ?? '';
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const match = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (match) nextCookie = match[1] ? `jit_sid=${match[1]}` : '';
  }
  return { status: response.status, data, cookie: nextCookie };
}

function safeRm(file) {
  try { rmSync(file, { force: true }); } catch { /* ignore */ }
}
function safeRmDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
async function login(user) {
  const result = await req('/api/auth/login', { method: 'POST', body: user });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.cookie;
}

test.describe('Agent 个人 AI 设置', { concurrency: false }, async () => {
  test.before(async () => {
    for (const suffix of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${suffix}`);
    safeRmDir(FILE_STORE);
    const modulePath = path.join(__dirname, '..', 'dist', 'main.js');
    const { bootstrap } = await import(`${pathToFileURL(modulePath).href}?ai-settings=${process.pid}-${Date.now()}`);
    const started = await bootstrap({
      port: 0,
      dbFile: DB_FILE,
      fileStoreDir: FILE_STORE,
      serveWeb: false,
      aiModelClient: modelStub,
    });
    app = started.app;
    baseUrl = started.baseUrl;

    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201, JSON.stringify(init.data));
    adminCookie = init.cookie;
    for (const user of users) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: user });
      assert.equal(created.status, 201, JSON.stringify(created.data));
      cookies[user.key] = await login(user);
    }
  });

  test.after(async () => {
    if (app) await app.close();
    for (const suffix of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${suffix}`);
    safeRmDir(FILE_STORE);
    if (OLD_ENCRYPTION_KEY === undefined) delete process.env.JIT_AI_SETTINGS_ENCRYPTION_KEY;
    else process.env.JIT_AI_SETTINGS_ENCRYPTION_KEY = OLD_ENCRYPTION_KEY;
  });

  await test('未登录不能读取或修改个人 AI 设置', async () => {
    assert.equal((await req('/api/agent/ai-settings')).status, 401);
    assert.equal((await req('/api/agent/ai-settings/deepseek', {
      method: 'PUT', body: { apiKey: 'sk-no-session', enable: true },
    })).status, 401);
  });

  await test('管理员、审核员、著录员、借阅者、访客均可读取自己的 AI 设置', async () => {
    const all = [
      ['admin', adminCookie],
      ...users.map((user) => [user.key, cookies[user.key]]),
    ];
    for (const [key, cookie] of all) {
      const result = await req('/api/agent/ai-settings', { cookie });
      assert.equal(result.status, 200, `${key} 应可进入个人 AI 设置`);
      assert.equal(result.data.enabled, false);
      assert.equal(result.data.providers.length, 3);
      assert.deepEqual(result.data.providers.map((item) => item.provider).sort(), ['deepseek', 'kimi', 'qwen']);
    }
  });

  await test('五类角色可以分别保存自己的服务商配置，互不影响', async () => {
    const scenarios = [
      ['admin', adminCookie, 'deepseek', 'sk-admin-private-key'],
      ['cataloger', cookies.cataloger, 'kimi', 'sk-cataloger-private-key'],
      ['reviewer', cookies.reviewer, 'qwen', 'sk-reviewer-private-key'],
      ['borrower', cookies.borrower, 'deepseek', 'sk-borrower-private-key'],
      ['guest', cookies.guest, 'kimi', 'sk-guest-private-key'],
    ];
    for (const [key, cookie, provider, apiKey] of scenarios) {
      const saved = await req(`/api/agent/ai-settings/${provider}`, {
        method: 'PUT', cookie,
        body: { apiKey, model: provider === 'kimi' ? 'kimi-k2.5' : provider === 'qwen' ? 'qwen-plus' : 'deepseek-chat', enable: true },
      });
      assert.equal(saved.status, 200, `${key} 保存失败：${JSON.stringify(saved.data)}`);
      assert.equal(saved.data.enabled, true);
      assert.equal(saved.data.activeProvider, provider);
      assert.equal(saved.data.providers.find((item) => item.provider === provider).enabled, true);
      assert.ok(!JSON.stringify(saved.data).includes(apiKey), '接口响应不得回传 API Key');
    }

    const adminSettings = await req('/api/agent/ai-settings', { cookie: adminCookie });
    assert.equal(adminSettings.data.providers.find((item) => item.provider === 'deepseek').configured, true);
    assert.equal(adminSettings.data.providers.find((item) => item.provider === 'kimi').configured, false);
    const guestSettings = await req('/api/agent/ai-settings', { cookie: cookies.guest });
    assert.equal(guestSettings.data.providers.find((item) => item.provider === 'kimi').configured, true);
    assert.equal(guestSettings.data.providers.find((item) => item.provider === 'deepseek').configured, false);
  });

  await test('同一用户可保存多个服务商，但同一时刻只启用一个', async () => {
    const saved = await req('/api/agent/ai-settings/kimi', {
      method: 'PUT', cookie: adminCookie,
      body: { apiKey: 'sk-admin-kimi-private', model: 'kimi-k2.5', temperature: 1.1, enable: false },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.activeProvider, 'deepseek', '仅保存不应擅自切换当前模型');
    assert.equal(saved.data.providers.find((item) => item.provider === 'kimi').configured, true);
    assert.equal(saved.data.providers.find((item) => item.provider === 'kimi').temperature, 1.1);

    const activated = await req('/api/agent/ai-settings/kimi/activate', { method: 'POST', cookie: adminCookie });
    assert.equal(activated.status, 201);
    assert.equal(activated.data.activeProvider, 'kimi');
    assert.equal(activated.data.providers.filter((item) => item.enabled).length, 1);
    const status = await req('/api/agent/status', { cookie: adminCookie });
    assert.equal(status.data.provider, 'kimi');
    assert.equal(status.data.personalAiConfigured, true);
  });

  await test('连接测试调用模型桩，不访问真实服务商，也不保存测试密钥', async () => {
    modelStub.available = true;
    const before = modelStub.calls;
    const result = await req('/api/agent/ai-settings/deepseek/test', {
      method: 'POST', cookie: cookies.borrower,
      body: { apiKey: 'sk-temporary-test-only', model: 'deepseek-chat', apiBase: 'https://api.deepseek.com/v1' },
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    assert.equal(result.data.ok, true);
    assert.equal(modelStub.calls, before + 1);
    const db = new DatabaseSync(DB_FILE);
    try {
      const rows = db.prepare('SELECT api_key_encrypted FROM user_ai_provider_configs WHERE user_id = (SELECT id FROM users WHERE username = ?)').all('ai_bor');
      assert.equal(rows.length, 1, '连接测试不应额外保存临时配置');
      assert.ok(!String(rows[0].api_key_encrypted).includes('sk-temporary-test-only'));
    } finally {
      db.close();
    }
    modelStub.available = false;
  });

  await test('API Key 使用 AES-GCM 密文存储，数据库和公开接口均不含明文', async () => {
    const db = new DatabaseSync(DB_FILE);
    try {
      const rows = db.prepare('SELECT api_key_encrypted FROM user_ai_provider_configs').all();
      assert.ok(rows.length >= 5);
      const encrypted = rows.map((row) => String(row.api_key_encrypted));
      assert.ok(encrypted.every((value) => value.startsWith('v1.')));
      assert.ok(!encrypted.join('|').includes('sk-admin-private-key'));
      assert.ok(!encrypted.join('|').includes('sk-guest-private-key'));
    } finally {
      db.close();
    }
    const status = await req('/api/agent/ai-settings', { cookie: adminCookie });
    assert.ok(!JSON.stringify(status.data).toLowerCase().includes('api_key'));
    assert.ok(!JSON.stringify(status.data).includes('sk-'));
  });

  await test('停用和删除只影响当前账号，其他用户配置不受影响', async () => {
    const disabled = await req('/api/agent/ai-settings/disable', { method: 'POST', cookie: adminCookie });
    assert.equal(disabled.status, 201);
    assert.equal(disabled.data.enabled, false);
    const adminStatus = await req('/api/agent/status', { cookie: adminCookie });
    assert.equal(adminStatus.data.personalAiConfigured, false);

    const guestBefore = await req('/api/agent/status', { cookie: cookies.guest });
    assert.equal(guestBefore.data.personalAiConfigured, true);
    const removed = await req('/api/agent/ai-settings/kimi', { method: 'DELETE', cookie: adminCookie });
    assert.equal(removed.status, 200);
    assert.equal(removed.data.providers.find((item) => item.provider === 'kimi').configured, false);
    const guestAfter = await req('/api/agent/ai-settings', { cookie: cookies.guest });
    assert.equal(guestAfter.data.providers.find((item) => item.provider === 'kimi').configured, true);
  });

  await test('拒绝非官方域名和 HTTP 地址，避免服务端请求被用作 SSRF', async () => {
    const badHost = await req('/api/agent/ai-settings/deepseek', {
      method: 'PUT', cookie: adminCookie,
      body: { apiKey: 'sk-invalid-url', apiBase: 'https://127.0.0.1:8080/v1', enable: true },
    });
    assert.equal(badHost.status, 400);
    const http = await req('/api/agent/ai-settings/qwen', {
      method: 'PUT', cookie: adminCookie,
      body: { apiKey: 'sk-invalid-url', apiBase: 'http://dashscope.aliyuncs.com/compatible-mode/v1', enable: true },
    });
    assert.equal(http.status, 400);
    const badKey = await req('/api/agent/ai-settings/deepseek', {
      method: 'PUT', cookie: adminCookie,
      body: { apiKey: 'sk-invalid\nkey', apiBase: 'https://api.deepseek.com/v1', enable: true },
    });
    assert.equal(badKey.status, 400, 'API Key 不得包含换行符');
    const badTemperature = await req('/api/agent/ai-settings/qwen', {
      method: 'PUT', cookie: adminCookie,
      body: { apiKey: 'sk-invalid-temperature', temperature: 2.1, enable: false },
    });
    assert.equal(badTemperature.status, 400, 'Temperature 不得超出 0–2');
  });
});
