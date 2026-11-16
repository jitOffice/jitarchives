/**
 * 票据 origin 策略单元测试。
 *
 * 背景：JitWord 校验票据 origin 必须与浏览器地址栏完全一致，固定单值或只放行私网
 *       会让 127.0.0.1 / localhost / 局域网 IP / 公网域名互相冲突
 *       （表现为 PERMISSION_DENIED embed ticket origin mismatch）。
 *
 * 当前策略：优先浏览器 Origin 头，其次 X-Forwarded-Host/Proto，最后 Host；
 *           默认放行任意合法 http(s) 来源，严格白名单需显式开启 JITWORD_ORIGIN_STRICT=1。
 * 仅测纯函数：不启动服务、不触网、不依赖真实厂商密钥。
 * 运行：npm test（需先 npm run build）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_MOD = path.join(__dirname, '..', 'dist', 'jitword', 'jitword.config.js');

let cached = null;

/** 加载编译产物（同一进程内只加载一次；额外来源每次调用都会重读环境变量）。 */
async function loadConfig() {
  if (!cached) cached = import(pathToFileURL(CONFIG_MOD).href);
  return cached;
}

/** 在临时环境变量下执行断言，结束后恢复原值。 */
async function withEnv(env, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('origin 解析：优先浏览器 Origin 头，代理转发头次之，最后 Host', async () => {
  const { resolveRequestOrigin } = await loadConfig();

  assert.equal(resolveRequestOrigin('127.0.0.1:3200'), 'http://127.0.0.1:3200');
  assert.equal(resolveRequestOrigin('localhost:3200'), 'http://localhost:3200');
  assert.equal(resolveRequestOrigin('192.168.31.36:3200'), 'http://192.168.31.36:3200');
  // x-forwarded-proto 的 https 生效（可能带多值，取首个）
  assert.equal(resolveRequestOrigin('example.com', 'https', 'http'), 'https://example.com');
  assert.equal(resolveRequestOrigin('127.0.0.1:3200', 'https,http'), 'https://127.0.0.1:3200');
  // 缺少转发头时按连接协议
  assert.equal(resolveRequestOrigin('127.0.0.1:3200', undefined, 'https'), 'https://127.0.0.1:3200');
  // Host 缺失时返回空串，由调用方拒绝签发
  assert.equal(resolveRequestOrigin(''), '');
  assert.equal(resolveRequestOrigin(undefined), '');
});

test('origin 解析：公网 HTTPS 域名即使代理漏配转发头，也能由 Origin 头签对', async () => {
  const { resolveRequestOrigin } = await loadConfig();

  assert.equal(
    resolveRequestOrigin('127.0.0.1:5006', 'http', 'http', '127.0.0.1:5006', 'https://archive.jitword.com'),
    'https://archive.jitword.com',
  );
  // 代理正确传入 X-Forwarded-Host/Proto 时同样可用
  assert.equal(
    resolveRequestOrigin('127.0.0.1:5006', 'https', 'http', 'archive.jitword.com'),
    'https://archive.jitword.com',
  );
  // 沙箱 Origin: null 不得被当成主机名
  assert.equal(
    resolveRequestOrigin('127.0.0.1:5006', 'https', 'http', 'archive.jitword.com', 'null'),
    'https://archive.jitword.com',
  );
});

test('默认策略：合法 http(s) 来源均可签发（公网域名无需预先登记）', async () => {
  const { isAllowedOrigin } = await loadConfig();

  await withEnv({ JITWORD_ORIGIN_STRICT: '' }, () => {
    for (const origin of [
      'http://127.0.0.1:3200',
      'http://localhost:3200',
      'http://192.168.31.36:3200',
      'https://archive.jitword.com',
      'https://docs.example.com',
    ]) {
      assert.equal(isAllowedOrigin(origin), true, `${origin} 应放行`);
    }
    // 非法协议/空值仍然拒绝
    for (const origin of ['ftp://127.0.0.1:3200', 'javascript:alert(1)', '']) {
      assert.equal(isAllowedOrigin(origin), false, `${origin} 应拒绝`);
    }
  });
});

test('严格模式 JITWORD_ORIGIN_STRICT=1：仅放行本机、私网与显式额外来源', async () => {
  const { isAllowedOrigin } = await loadConfig();

  await withEnv({ JITWORD_ORIGIN_STRICT: '1', JITWORD_ORIGIN: 'https://archive.jitword.com' }, () => {
    for (const origin of [
      'http://127.0.0.1:3200',
      'http://localhost:3200',
      'http://192.168.31.36:3200',
      'http://10.1.2.3:8080',
      'http://172.16.0.9:3200',
      'http://172.31.255.1:3200',
      'http://[::1]:3200',
      'https://127.0.0.1:3200',
      'https://archive.jitword.com',
    ]) {
      assert.equal(isAllowedOrigin(origin), true, `${origin} 应放行`);
    }
    for (const origin of [
      'http://evil.example.com',
      'https://inner.jitword.com',
      'http://8.8.8.8:3200',
      'http://172.15.0.1:3200',
      'http://172.32.0.1:3200',
      'ftp://127.0.0.1:3200',
      'javascript:alert(1)',
      '',
      'not-an-origin',
    ]) {
      assert.equal(isAllowedOrigin(origin), false, `${origin} 应拒绝`);
    }
  });
});

test('归一化：大小写、末尾斜杠、多余路径不影响判定', async () => {
  const { isAllowedOrigin } = await loadConfig();

  assert.equal(isAllowedOrigin('HTTP://127.0.0.1:3200/'), true);
  assert.equal(isAllowedOrigin('http://127.0.0.1:3200/archives/3'), true);
  assert.equal(isAllowedOrigin('  http://localhost:3200  '), true);
});

test('JITWORD_ORIGIN 解析为额外允许来源（逗号分隔，可含域名）', async () => {
  const { extraAllowedOrigins } = await loadConfig();

  await withEnv({ JITWORD_ORIGIN: 'https://docs.example.com, 192.168.50.10:3300' }, () => {
    assert.deepEqual(extraAllowedOrigins(), ['https://docs.example.com', 'http://192.168.50.10:3300']);
  });
});

test('未配置 JITWORD_ORIGIN 时额外来源为空', async () => {
  const { extraAllowedOrigins } = await loadConfig();

  await withEnv({ JITWORD_ORIGIN: '' }, () => {
    assert.deepEqual(extraAllowedOrigins(), []);
  });
});
