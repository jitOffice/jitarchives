/**
 * JitArchives 固定邀请码 + 浏览器指纹设备注册限制 自动化验证（node:test）
 *
 * 使用独立测试数据库（storage/test-device-reg-<pid>.db），不触碰正式库。
 * 覆盖项：
 *  1. 正确邀请码 + 新设备指纹：注册成功。
 *  2. 错误邀请码：注册失败（400）。
 *  3. 任意四位以上字符串作为邀请码：注册失败。
 *  4. 同一指纹第二次注册：提示激活码已使用（409）。
 *  5. 同一指纹更换用户名再次注册：仍然失败。
 *  6. 同一指纹更换邮箱再次注册：仍然失败。
 *  7. 不同指纹使用相同邀请码：允许注册。
 *  8. 同一指纹并发注册：只能成功一次。
 *  9. 注册失败不产生用户记录。
 * 10. 注册失败不产生设备使用记录。
 * 11. 注册成功后退出登录：设备记录仍然存在。
 * 12. 原注册用户可以正常重新登录。
 * 13. 浏览器指纹格式校验（非法格式拒绝）。
 * 14. 首次管理员初始化不受指纹限制。
 * 15. 原有角色权限回归正常。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-device-reg-${process.pid}.db`);

// 测试用指纹密钥（与后端默认 DEVICE_FINGERPRINT_SECRET 一致）
const FP_SECRET = 'jitarchives-dev-fp-default-secret';
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

/** 生成一个合法的测试指纹（32 hex 字符）。 */
function genFingerprint() {
  return randomBytes(16).toString('hex');
}

/** 计算指纹的 HMAC-SHA256 摘要（与后端一致）。 */
function hashFingerprint(fp) {
  return createHmac('sha256', FP_SECRET).update(fp).digest('hex');
}

const ADMIN = { username: 'devroot', displayName: '设备注册测试管理员', password: 'Admin#12345' };

let adminCookie = '';

test.describe('JitArchives 固定邀请码 + 浏览器指纹设备注册限制', { concurrency: false }, async () => {
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

  // ==================== 14. 首次管理员初始化 ====================
  await test('14. 首次管理员初始化不受指纹限制', async () => {
    const st = await req('/api/auth/status');
    assert.equal(st.status, 200);
    assert.equal(st.data.initialized, false);

    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201, `初始化管理员应成功：${JSON.stringify(init.data)}`);
    assert.ok(init.data.user, '应返回用户信息');
    assert.equal(init.data.user.role, 'admin');
    assert.ok(init.cookie, '初始化后应自动登录');
    adminCookie = init.cookie;
  });

  // ==================== 1. 正确邀请码 + 新设备 ====================
  let fp1 = '';
  let regCookie1 = '';
  await test('1. 正确邀请码 + 新设备指纹：注册成功', async () => {
    fp1 = genFingerprint();
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'device_user1',
        email: 'dev1@test.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: fp1,
      },
    });
    assert.equal(r.status, 201, `正确邀请码+新设备应注册成功：${JSON.stringify(r.data)}`);
    assert.ok(r.data.user);
    assert.equal(r.data.user.username, 'device_user1');
    assert.equal(r.data.user.role, 'borrower');
    assert.ok(r.cookie, '注册后应自动登录');
    regCookie1 = r.cookie;
  });

  // ==================== 12. 原注册用户正常登录 ====================
  await test('12. 原注册用户可以正常重新登录', async () => {
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'device_user1', password: 'Test#12345' },
    });
    assert.equal(login.status, 201, '已注册用户应能正常登录');
    assert.ok(login.cookie);
  });

  // ==================== 4. 同一指纹第二次注册 ====================
  await test('4. 同一指纹第二次注册：提示激活码已使用', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'device_user_dup',
        email: 'dup@test.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: fp1,
      },
    });
    assert.equal(r.status, 409, `同一指纹重复注册必须 409：${JSON.stringify(r.data)}`);
    assert.ok(r.data.message.includes('激活码已使用'), '应提示激活码已使用');
  });

  // ==================== 5. 同一指纹更换用户名 ====================
  await test('5. 同一指纹更换用户名再次注册：仍然失败', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'totally_different_name',
        email: 'different@test.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: fp1,
      },
    });
    assert.equal(r.status, 409, '同一指纹换用户名也必须 409');
    assert.ok(r.data.message.includes('激活码已使用'));
  });

  // ==================== 6. 同一指纹更换邮箱 ====================
  await test('6. 同一指纹更换邮箱再次注册：仍然失败', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'another_name',
        email: 'totally_new@test.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: fp1,
      },
    });
    assert.equal(r.status, 409, '同一指纹换邮箱也必须 409');
  });

  // ==================== 7. 不同指纹使用相同邀请码 ====================
  await test('7. 不同指纹使用相同邀请码：允许注册', async () => {
    const fp2 = genFingerprint();
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'device_user2',
        email: 'dev2@test.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: fp2,
      },
    });
    assert.equal(r.status, 201, `不同指纹应允许注册：${JSON.stringify(r.data)}`);
    assert.equal(r.data.user.username, 'device_user2');
  });

  // ==================== 2. 错误邀请码 ====================
  await test('2. 错误邀请码：注册失败', async () => {
    const fp = genFingerprint();
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'wrongcode_user',
        email: 'wrong@test.com',
        password: 'Test#12345',
        invitationCode: 'wrong-code-123',
        fingerprint: fp,
      },
    });
    assert.equal(r.status, 400, `错误邀请码必须 400：${JSON.stringify(r.data)}`);
    assert.ok(r.data.message.includes('邀请码不正确'), '应提示邀请码不正确');
  });

  // ==================== 3. 任意四位以上字符串 ====================
  await test('3. 任意四位以上字符串作为邀请码：注册失败', async () => {
    const fp = genFingerprint();
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'anystr_user',
        email: 'any@test.com',
        password: 'Test#12345',
        invitationCode: 'abcd',
        fingerprint: fp,
      },
    });
    assert.equal(r.status, 400, '任意字符串必须 400');
  });

  // ==================== 13. 指纹格式校验 ====================
  await test('13. 浏览器指纹格式校验（非法格式拒绝）', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'badfp_user',
        email: 'badfp@test.com',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: 'not-a-valid-fp',
      },
    });
    assert.equal(r.status, 400, `非法指纹格式必须 400：${JSON.stringify(r.data)}`);
    assert.ok(r.data.message.includes('设备标识格式无效'), '应提示格式无效');
  });

  // ==================== 9. 注册失败不产生用户记录 ====================
  await test('9. 注册失败不产生用户记录', async () => {
    const fp = genFingerprint();
    // 用错误邀请码注册
    await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'ghost_user',
        email: 'ghost@test.com',
        password: 'Test#12345',
        invitationCode: 'wrong',
        fingerprint: fp,
      },
    });
    // 验证用户不存在
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'ghost_user', password: 'Test#12345' },
    });
    assert.equal(login.status, 401, '注册失败不应产生可登录的用户');

    // 验证设备记录不存在
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const hash = hashFingerprint(fp);
    const row = db.prepare('SELECT * FROM registration_device_uses WHERE fingerprint_hash = ?').get(hash);
    db.close();
    assert.equal(row, undefined, '注册失败不应产生设备记录');
  });

  // ==================== 10. 注册失败不产生设备使用记录 ====================
  await test('10. 注册失败不产生设备使用记录', async () => {
    const fp = genFingerprint();
    // 用正确邀请码但用户名太短（校验失败）
    await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'ab',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: fp,
      },
    });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const hash = hashFingerprint(fp);
    const row = db.prepare('SELECT * FROM registration_device_uses WHERE fingerprint_hash = ?').get(hash);
    db.close();
    assert.equal(row, undefined, '校验失败不应产生设备记录');
  });

  // ==================== 11. 退出登录后设备记录仍存在 ====================
  await test('11. 注册成功后退出登录：设备记录仍然存在', async () => {
    // 先退出
    const out = await req('/api/auth/logout', { method: 'POST', cookie: regCookie1 });
    assert.equal(out.status, 201);

    // 验证设备记录
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_FILE);
    const hash = hashFingerprint(fp1);
    const row = db.prepare('SELECT * FROM registration_device_uses WHERE fingerprint_hash = ?').get(hash);
    db.close();
    assert.ok(row, '退出登录后设备记录应仍然存在');
    assert.equal(Number(row.user_id), 2, '设备记录应关联到正确的用户'); // 用户 ID=2（管理员是1）
  });

  // ==================== 8. 并发注册 ====================
  await test('8. 同一指纹并发注册：只能成功一次', async () => {
    const fp = genFingerprint();
    const results = await Promise.all(
      [1, 2, 3].map((i) =>
        req('/api/auth/register', {
          method: 'POST',
          body: {
            username: `concurrent_dev_${i}`,
            email: `conc${i}@test.com`,
            password: 'Test#12345',
            invitationCode: INVITE_CODE,
            fingerprint: fp,
          },
        })
      )
    );
    const successCount = results.filter((r) => r.status === 201).length;
    const conflictCount = results.filter((r) => r.status === 409).length;
    assert.equal(successCount, 1, `并发注册应恰好一次成功，实际 ${successCount}`);
    assert.equal(conflictCount, 2, '其余并发应被 409 拒绝');
  });

  // ==================== 15. 角色权限回归 ====================
  await test('15. 原有角色权限回归正常', async () => {
    // 管理员可以访问用户管理
    const users = await req('/api/users', { cookie: adminCookie });
    assert.equal(users.status, 200, '管理员应能访问用户管理');
    assert.ok(Array.isArray(users.data), '应返回用户列表');

    // 普通用户不能访问用户管理
    const login = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'device_user1', password: 'Test#12345' },
    });
    const userCookie = login.cookie;
    const forbidden = await req('/api/users', { cookie: userCookie });
    assert.equal(forbidden.status, 403, '普通用户访问管理接口必须 403');
  });

  // ==================== 补充：空邀请码 ====================
  await test('补充：空邀请码注册失败', async () => {
    const fp = genFingerprint();
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'empty_code_user',
        password: 'Test#12345',
        invitationCode: '',
        fingerprint: fp,
      },
    });
    assert.equal(r.status, 400, '空邀请码必须 400');
  });

  // ==================== 补充：空指纹 ====================
  await test('补充：空指纹注册失败', async () => {
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'empty_fp_user',
        password: 'Test#12345',
        invitationCode: INVITE_CODE,
        fingerprint: '',
      },
    });
    assert.equal(r.status, 400, '空指纹必须 400');
  });

  // ==================== 补充：邀请码首尾空格 ====================
  await test('补充：邀请码首尾空格自动忽略后匹配成功', async () => {
    const fp = genFingerprint();
    const r = await req('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'space_code_user',
        email: 'space@test.com',
        password: 'Test#12345',
        invitationCode: '  jitword168  ',
        fingerprint: fp,
      },
    });
    assert.equal(r.status, 201, `首尾空格应自动忽略并匹配成功：${JSON.stringify(r.data)}`);
  });
});
