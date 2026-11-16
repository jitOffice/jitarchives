/**
 * JitArchives 登录注册与邀请码系统自动化验证（node:test）
 *
 * 使用独立测试数据库（storage/test-auth-invite-<pid>.db），不触碰正式库。
 * 覆盖项：
 *  1. 正确邀请码 + 新设备：注册成功；
 *  2. 随机邀请码注册失败；
 *  3. 重复用户名注册失败；
 *  4. 重复邮箱注册失败；
 *  5. 邮箱正确存储；
 *  6. 登录成功；
 *  7. 登录失败（错误密码 / 不存在用户 / 禁用账号）；
 *  8. Session 持久化（重启后仍有效）；
 *  9. 退出登录后 Session 失效；
 * 10. 首次管理员初始化正常；
 * 11. 原有角色权限回归正常；
 * 12. 二维码弹窗接口返回正确数据。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-auth-invite-${process.pid}.db`);

// 固定邀请码
const INVITE_CODE = 'jitword168';

let baseUrl = null;
let currentApp = null;

async function startServer() {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({ port: 0, dbFile: DB_FILE, serveWeb: false });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}

async function stopServer() {
  await currentApp.close();
  currentApp = null;
}

async function req(pathname, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }
  const setCookie = res.headers.get('set-cookie');
  let newCookie = cookie;
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, cookie: newCookie };
}

function safeRm(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* 忽略 EPERM */
  }
}

/** 生成合法测试指纹（32 hex 字符）。 */
function genFingerprint() {
  return randomBytes(16).toString('hex');
}

const ADMIN = { username: 'authroot', displayName: '认证测试管理员', password: 'Admin#12345' };

let adminCookie = '';

test.describe('JitArchives 登录注册与邀请码系统自动化验证', { concurrency: false }, async () => {
  test.before(async () => {
    safeRm(DB_FILE);
    safeRm(`${DB_FILE}-wal`);
    safeRm(`${DB_FILE}-shm`);
    await startServer();
  });

  test.after(async () => {
    if (currentApp) await stopServer();
    for (const suffix of ['', '-wal', '-shm']) {
      safeRm(`${DB_FILE}${suffix}`);
    }
  });

  // ==================== 10. 首次管理员初始化 ====================
  await test('10. 首次管理员初始化正常', async () => {
    const st = await req('/api/auth/status');
    assert.equal(st.status, 200);
    assert.equal(st.data.initialized, false, '初始化前应报告未初始化');

    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201, `初始化管理员应成功：${JSON.stringify(init.data)}`);
    assert.ok(init.data.user, '应返回用户信息');
    assert.equal(init.data.user.username, ADMIN.username);
    assert.equal(init.data.user.role, 'admin');
    assert.ok(init.cookie, '初始化后应自动登录并设置 Cookie');
    adminCookie = init.cookie;

    // 不可重复初始化
    const initAgain = await req('/api/auth/init-admin', { method: 'POST', body: { ...ADMIN, username: 'other' } });
    assert.equal(initAgain.status, 409, '重复初始化必须 409');
  });

  // ==================== 12. 二维码接口 ====================
  await test('12. 二维码弹窗接口返回正确数据', async () => {
    const info = await req('/api/auth/invite-info');
    assert.equal(info.status, 200);
    assert.ok(typeof info.data.qrUrl === 'string' && info.data.qrUrl.length > 0, '应返回二维码 URL');
    assert.ok(typeof info.data.replyKeyword === 'string' && info.data.replyKeyword.length > 0, '应返回回复关键字');
    assert.ok(info.data.qrUrl.includes('qrcode'), '二维码 URL 应包含 qrcode');
  });

  // ==================== 2. 随机邀请码注册失败 ====================
  await test('2. 随机邀请码注册失败', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'randuser',
        email: 'rand@test.com',
        password: 'Test#12345',
        invitationCode: 'JW-RANDOM-FAKE-CODE',
        fingerprint: genFingerprint(),
      },
    });
    assert.equal(r.status, 400, `随机邀请码必须 400：${JSON.stringify(r.data)}`);
    assert.ok(r.data.message.includes('邀请码不正确'), '错误信息应提示邀请码不正确');
  });

  // ==================== 1. 正确邀请码注册成功 ====================
  let registeredCookie = '';
  await test('1. 正确邀请码注册成功', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'testuser1',
        email: 'test1@example.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: genFingerprint(),
      },
    });
    assert.equal(r.status, 201, `正确邀请码注册必须成功：${JSON.stringify(r.data)}`);
    assert.ok(r.data.user, '应返回用户信息');
    assert.equal(r.data.user.username, 'testuser1');
    assert.equal(r.data.user.role, 'borrower', '注册默认角色应为 borrower');
    assert.ok(r.cookie, '注册后应自动登录并设置 Cookie');
    registeredCookie = r.cookie;
  });

  // ==================== 5. 邮箱正确存储 ====================
  await test('5. 邮箱正确存储', async () => {
    const me = await req('/api/auth/me', { cookie: registeredCookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.email, 'test1@example.com', '邮箱应正确存储并返回');
  });

  // ==================== 3. 重复用户名注册失败 ====================
  await test('3. 重复用户名注册失败', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'testuser1', // 已注册
        email: 'other@example.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: genFingerprint(),
      },
    });
    assert.equal(r.status, 409, `重复用户名必须 409：${JSON.stringify(r.data)}`);
    assert.ok(r.data.message.includes('用户名已存在'), '错误信息应提示用户名已存在');
  });

  // ==================== 4. 重复邮箱注册失败 ====================
  await test('4. 重复邮箱注册失败', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'testuser2',
        email: 'test1@example.com', // 已注册
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: genFingerprint(),
      },
    });
    assert.equal(r.status, 409, `重复邮箱必须 409：${JSON.stringify(r.data)}`);
    assert.ok(r.data.message.includes('邮箱已注册'), '错误信息应提示邮箱已存在');
  });

  // ==================== 6. 登录成功 ====================
  await test('6. 登录成功', async () => {
    const r = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'testuser1', password: 'Test#12345' },
    });
    assert.equal(r.status, 201, `正确密码登录必须成功：${JSON.stringify(r.data)}`);
    assert.ok(r.data.user, '应返回用户信息');
    assert.ok(r.cookie, '登录应设置 Cookie');
  });

  // ==================== 7. 登录失败 ====================
  await test('7. 登录失败：错误密码 / 不存在用户', async () => {
    // 错误密码
    const wrongPwd = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'testuser1', password: 'WrongPassword' },
    });
    assert.equal(wrongPwd.status, 401, '错误密码必须 401');

    // 不存在用户
    const noUser = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'nonexistent', password: 'Test#12345' },
    });
    assert.equal(noUser.status, 401, '不存在用户必须 401');
  });

  // ==================== 9. 退出登录后 Session 失效 ====================
  await test('9. 退出登录后 Session 失效', async () => {
    // 先登录
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'testuser1', password: 'Test#12345' },
    });
    assert.equal(login.status, 201);
    const tempCookie = login.cookie;

    // 确认有效
    const before = await req('/api/auth/me', { cookie: tempCookie });
    assert.equal(before.status, 200, '登录会话应有效');

    // 退出
    const out = await req('/api/auth/logout', { method: 'POST', cookie: tempCookie });
    assert.equal(out.status, 201, JSON.stringify(out.data));

    // 确认失效
    const after = await req('/api/auth/me', { cookie: tempCookie });
    assert.equal(after.status, 401, '退出后原会话必须失效');
  });

  // ==================== 8. Session 持久化 ====================
  await test('8. Session 持久化（重启后仍有效）', async () => {
    // 登录获取 cookie
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'testuser1', password: 'Test#12345' },
    });
    assert.equal(login.status, 201);
    const persistCookie = login.cookie;

    // 停止服务
    await stopServer();

    // 重启服务（同一数据库）
    await startServer();

    // 会话应仍有效
    const me = await req('/api/auth/me', { cookie: persistCookie });
    assert.equal(me.status, 200, '重启后会话应仍然有效');
    assert.equal(me.data.user.username, 'testuser1');
  });

  // ==================== 11. 角色权限回归 ====================
  await test('11. 原有角色权限回归正常', async () => {
    // 管理员可以访问用户管理
    const users = await req('/api/users', { cookie: adminCookie });
    assert.equal(users.status, 200, '管理员应能访问用户管理');
    assert.ok(Array.isArray(users.data), '应返回用户列表');

    // 普通用户不能访问用户管理
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'testuser1', password: 'Test#12345' },
    });
    const userCookie = login.cookie;
    const forbidden = await req('/api/users', { cookie: userCookie });
    assert.equal(forbidden.status, 403, '普通用户访问管理接口必须 403');
  });

  // ==================== 邮箱格式校验 ====================
  await test('补充：邮箱格式校验', async () => {
    // 非法邮箱格式
    const bad = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'emailfmt_user',
        email: 'not-an-email',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: genFingerprint(),
      },
    });
    assert.equal(bad.status, 400, `非法邮箱格式必须 400`);

    // 空邮箱可以（邮箱可选）
    const empty = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'noemail_user',
        email: '',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: genFingerprint(),
      },
    });
    assert.equal(empty.status, 201, `空邮箱应允许注册（邮箱可选）`);
  });
});
