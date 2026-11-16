/**
 * JitArchives 阶段二第一批 · 后端自动化验证（node:test）
 *
 * 使用独立测试数据库（storage/test-e2e-<pid>.db），不触碰正式库。
 * 覆盖项：
 *  1. 正确账号密码可以登录；
 *  2. 错误密码 / 禁用账号不能登录；
 *  3. 未登录访问受保护接口被拒绝（401）；
 *  4. 普通用户直接请求用户管理接口被拒绝（403）；
 *  5. 退出后会话失效（401）；
 *  6. 重启（同库重新启动服务）后账号数据保留；
 *  7. 密码不以明文出现在数据库；接口响应不含密码/哈希。
 *  8. 最后一名启用管理员保底：降级/禁用被拒、已禁用管理员不计入、并发请求后仍保留 1 名。
 * 运行：npm test（根目录，需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-e2e-${process.pid}.db`);

let baseUrl = null;
let currentApp = null;

async function startServer() {
  // 每次动态导入，模拟“重启进程”；main.ts 导出 bootstrap 供测试注入独立库路径
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(pathToFileURL(modPath).href);
  const result = await bootstrap({ port: 0, dbFile: DB_FILE, serveWeb: false });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}

async function stopServer() {
  await currentApp.close();
  currentApp = null;
}

/** 极简请求助手：手动管理会话 Cookie（等价于浏览器行为）。 */
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

const ADMIN = { username: 'rootadmin', displayName: '总管理员', password: 'Admin#12345' };
const TESTER = { username: 'tester_a', password: 'Tester#12345' };

/** Windows 下 sqlite 句柄可能未即时释放，清理失败不影响结论（文件名含 pid，不串用）。 */
function safeRm(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* 忽略 EPERM */
  }
}

let adminCookie = '';

test.describe('JitArchives 阶段二后端自动化验证', { concurrency: false }, async () => {
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

  await test('初始状态：系统未初始化，受保护接口未登录被拒绝（401）', async () => {
    const st = await req('/api/auth/status');
    assert.equal(st.status, 200);
    assert.equal(st.data.initialized, false);

    const me = await req('/api/auth/me');
    assert.equal(me.status, 401, '未登录访问 /auth/me 必须 401');

    const users = await req('/api/users');
    assert.equal(users.status, 401, '未登录访问用户管理必须 401');

    const sys = await req('/api/system/info');
    assert.equal(sys.status, 401, '未登录访问系统信息必须 401');
  });

  await test('管理员初始化：设置账号密码并进入登录态；重复初始化被拒绝（409）', async () => {
    const weak = await req('/api/auth/init-admin', {
      method: 'POST',
      body: { username: 'ab', displayName: '', password: '123' },
    });
    assert.equal(weak.status, 400, '弱口令/短账号应被拒绝');

    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    assert.equal(init.data.user.role, 'admin');
    assert.ok(init.cookie, '初始化后应返回会话 Cookie');
    assert.equal(init.data.user.password, undefined);
    assert.equal(init.data.user.passwordHash, undefined);
    adminCookie = init.cookie;

    const again = await req('/api/auth/init-admin', {
      method: 'POST',
      body: { username: 'second', password: 'Second#123' },
    });
    assert.equal(again.status, 409, '已初始化的系统不能再次创建管理员');
  });

  await test('正确账号密码可以登录，错误密码不能登录', async () => {
    const ok = await req('/api/auth/login', {
      method: 'POST',
      body: { username: ADMIN.username, password: ADMIN.password },
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.user.username, ADMIN.username);
    adminCookie = ok.cookie;

    const bad = await req('/api/auth/login', {
      method: 'POST',
      body: { username: ADMIN.username, password: 'WrongPass#999' },
    });
    assert.equal(bad.status, 401, '错误密码必须 401');

    const noUser = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'ghost_user', password: 'Whatever#123' },
    });
    assert.equal(noUser.status, 401, '不存在的账号必须 401');
  });

  await test('登录态下可访问受保护接口，响应不含密码或哈希', async () => {
    const me = await req('/api/auth/me', { cookie: adminCookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, ADMIN.username);
    const raw = JSON.stringify(me.data);
    assert.ok(!raw.includes('password'), '响应中不得出现 password 字段');
    assert.ok(!raw.includes('scrypt$'), '响应中不得出现密码哈希');

    const sys = await req('/api/system/info', { cookie: adminCookie });
    assert.equal(sys.status, 200);
    assert.equal(sys.data.runtime.database, 'SQLite');
    assert.ok(sys.data.userOverview, '管理员应看到账号概况');
  });

  await test('管理员创建测试用户（借阅者角色）并可登录', async () => {
    const created = await req('/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { ...TESTER, role: 'borrower', displayName: '测试借阅者' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.role, 'borrower');
    assert.equal(created.data.roleLabel, '借阅者');
    assert.equal(created.data.password, undefined);

    const dup = await req('/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { ...TESTER, role: 'borrower' },
    });
    assert.equal(dup.status, 409, '重复账号必须 409');

    const login = await req('/api/auth/login', { method: 'POST', body: TESTER });
    assert.equal(login.status, 201, '新建测试用户应能登录');
  });

  await test('普通用户直接请求用户管理接口被拒绝（403）', async () => {
    const login = await req('/api/auth/login', { method: 'POST', body: TESTER });
    assert.equal(login.status, 201);
    const userCookie = login.cookie;

    const list = await req('/api/users', { cookie: userCookie });
    assert.equal(list.status, 403, '借阅者读取用户列表必须 403');

    const create = await req('/api/users', {
      method: 'POST',
      cookie: userCookie,
      body: { username: 'escalate_u', password: 'Hack#12345', role: 'admin' },
    });
    assert.equal(create.status, 403, '借阅者创建账号（越权）必须 403');

    const patch = await req('/api/users/1', {
      method: 'PATCH',
      cookie: userCookie,
      body: { role: 'admin' },
    });
    assert.equal(patch.status, 403, '借阅者修改他人角色必须 403');
  });

  await test('禁用账号不能登录；禁用即时踢出在线会话', async () => {
    const login = await req('/api/auth/login', { method: 'POST', body: TESTER });
    const userCookie = login.cookie;
    const me1 = await req('/api/auth/me', { cookie: userCookie });
    assert.equal(me1.status, 200);

    const list = await req('/api/users', { cookie: adminCookie });
    const target = list.data.find((u) => u.username === TESTER.username);

    const disabled = await req(`/api/users/${target.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { status: 'disabled' },
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.data.status, 'disabled');

    const reLogin = await req('/api/auth/login', { method: 'POST', body: TESTER });
    assert.equal(reLogin.status, 401, '禁用账号重新登录必须 401');

    const me2 = await req('/api/auth/me', { cookie: userCookie });
    assert.equal(me2.status, 401, '禁用后原在线会话必须立即失效');

    const enabled = await req(`/api/users/${target.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { status: 'active' },
    });
    assert.equal(enabled.status, 200);
    const reLogin2 = await req('/api/auth/login', { method: 'POST', body: TESTER });
    assert.equal(reLogin2.status, 201, '恢复启用后可以正常登录');
  });

  await test('角色切换：借阅者升级为审核员', async () => {
    const list = await req('/api/users', { cookie: adminCookie });
    const target = list.data.find((u) => u.username === TESTER.username);
    const changed = await req(`/api/users/${target.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { role: 'reviewer' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.data.role, 'reviewer');
    assert.equal(changed.data.roleLabel, '审核员');
  });

  await test('退出登录后原会话失效', async () => {
    const login = await req('/api/auth/login', { method: 'POST', body: TESTER });
    const cookie = login.cookie;
    const before = await req('/api/auth/me', { cookie });
    assert.equal(before.status, 200);

    const out = await req('/api/auth/logout', { method: 'POST', cookie });
    assert.equal(out.status, 201);

    const after = await req('/api/auth/me', { cookie });
    assert.equal(after.status, 401, '退出后旧 Cookie 必须失效');
  });

  await test('重启保留：关闭服务后以同一数据库重启，账号数据仍在', async () => {
    await stopServer();
    await startServer();

    const st = await req('/api/auth/status');
    assert.equal(st.data.initialized, true, '重启后系统应仍处于已初始化状态');

    const login = await req('/api/auth/login', { method: 'POST', body: ADMIN });
    assert.equal(login.status, 201, '重启后管理员必须能再次登录');
    adminCookie = login.cookie;

    const list = await req('/api/users', { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.ok(list.data.some((u) => u.username === TESTER.username), '测试用户应保留');
    const tester = list.data.find((u) => u.username === TESTER.username);
    assert.equal(tester.role, 'reviewer', '角色修改应持久化');
  });

  await test('数据库中不存在明文密码', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const rows = db.prepare('SELECT username, password_hash FROM users').all();
    db.close();
    for (const row of rows) {
      assert.match(String(row.password_hash), /^scrypt\$/, '哈希必须为 scrypt 格式');
      const raw = JSON.stringify(row);
      assert.ok(!raw.includes(ADMIN.password), '不得出现管理员明文密码');
      assert.ok(!raw.includes(TESTER.password), '不得出现测试用户明文密码');
    }
  });

  // ==================== 最后一名启用管理员保护（本次修复新增） ====================

  const GUARD_A = { username: 'guard_admin_a', displayName: '保底管理员A', password: 'GuardA#12345' };
  const GUARD_B = { username: 'guard_admin_b', displayName: '保底管理员B', password: 'GuardB#12345' };
  let cookieA = '';
  let cookieB = '';
  let idA = 0;
  let idB = 0;

  const activeAdmins = (users) => users.filter((u) => u.role === 'admin' && u.status === 'active');

  async function listUsers(cookie) {
    const res = await req('/api/users', { cookie });
    assert.equal(res.status, 200, '管理员读取用户列表必须成功');
    return res.data;
  }

  await test('保底准备：新增两名管理员并把初始管理员降为审核员（三名启用管理员时降级合法）', async () => {
    const a = await req('/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { ...GUARD_A, role: 'admin' },
    });
    assert.equal(a.status, 201);
    assert.equal(a.data.role, 'admin');
    idA = a.data.id;

    const b = await req('/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { ...GUARD_B, role: 'admin' },
    });
    assert.equal(b.status, 201);
    idB = b.data.id;

    const loginA = await req('/api/auth/login', { method: 'POST', body: GUARD_A });
    assert.equal(loginA.status, 201);
    cookieA = loginA.cookie;
    const loginB = await req('/api/auth/login', { method: 'POST', body: GUARD_B });
    assert.equal(loginB.status, 201);
    cookieB = loginB.cookie;

    const users = await listUsers(cookieA);
    const root = users.find((u) => u.username === ADMIN.username);
    const demoteRoot = await req(`/api/users/${root.id}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { role: 'reviewer' },
    });
    assert.equal(demoteRoot.status, 200, '三名启用管理员时降级其中一名应成功');

    const admins = activeAdmins(await listUsers(cookieA));
    assert.deepEqual(admins.map((u) => u.username).sort(), [GUARD_A.username, GUARD_B.username]);
  });

  await test('用例6：普通用户直接调用管理接口仍被权限守卫拒绝（403）', async () => {
    const login = await req('/api/auth/login', { method: 'POST', body: TESTER });
    assert.equal(login.status, 201);
    const userCookie = login.cookie;

    const patch = await req(`/api/users/${idA}`, {
      method: 'PATCH',
      cookie: userCookie,
      body: { role: 'guest' },
    });
    assert.equal(patch.status, 403, '借阅者/审核员修改管理员角色必须 403');

    const disable = await req(`/api/users/${idA}`, {
      method: 'PATCH',
      cookie: userCookie,
      body: { status: 'disabled' },
    });
    assert.equal(disable.status, 403, '借阅者/审核员禁用账号必须 403');

    assert.equal(activeAdmins(await listUsers(cookieA)).length, 2, '越权请求不得产生任何变更');
  });

  await test('用例4：两名启用管理员时禁用其中一名应成功', async () => {
    const res = await req(`/api/users/${idB}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { status: 'disabled' },
    });
    assert.equal(res.status, 200, '两名启用管理员时禁用一名应成功');
    assert.equal(res.data.status, 'disabled');
    assert.equal(res.data.role, 'admin', '禁用不改动角色');

    const admins = activeAdmins(await listUsers(cookieA));
    assert.deepEqual(admins.map((u) => u.id), [idA], '此时只剩 A 一名启用管理员');
  });

  await test('用例1/5/7：只剩一名启用管理员时降级被拒绝，已禁用管理员不计入可用数量', async () => {
    const before = (await listUsers(cookieA)).find((u) => u.id === idA);
    const res = await req(`/api/users/${idA}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { role: 'cataloger' },
    });
    assert.equal(res.status, 400, '最后一名启用管理员降级必须被拒绝');
    assert.match(String(res.data.message), /至少需要保留一名启用的管理员/, '错误提示需为可理解的中文');
    const raw = JSON.stringify(res.data);
    assert.ok(!/SQLITE|UPDATE users|INSERT INTO/i.test(raw), '错误响应不得泄露 SQL 或数据库细节');
    assert.ok(!/\bat [^\s]+\.js/i.test(raw), '错误响应不得包含异常堆栈');

    const after = (await listUsers(cookieA)).find((u) => u.id === idA);
    assert.equal(after.role, 'admin', '失败后角色必须保持原样');
    assert.equal(after.status, 'active', '失败后状态必须保持原样');
    assert.equal(after.updatedAt, before.updatedAt, '失败后不得产生任何写入');

    // B 角色仍是 admin，但已禁用 → 不计入可用管理员数量，因此 A 仍被判定为最后一名
    const all = await listUsers(cookieA);
    const b = all.find((u) => u.id === idB);
    assert.equal(b.role, 'admin');
    assert.equal(b.status, 'disabled');

    const me = await req('/api/auth/me', { cookie: cookieA });
    assert.equal(me.status, 200, '被拒绝的修改不得误撤销当前会话');
  });

  await test('用例2：只剩一名启用管理员时禁用该管理员必须被拒绝', async () => {
    const res = await req(`/api/users/${idA}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { status: 'disabled' },
    });
    assert.equal(res.status, 400, '禁用最后一名启用管理员必须被拒绝');
    // 说明：当前只有一个启用管理员，而调用者必为该管理员，因此先命中“不能禁用当前登录的自己”；
    // 仓储层对“禁用最后一名启用管理员”的拦截由 admin-guard.repository.test.mjs 用例2 覆盖。
    assert.match(String(res.data.message), /不能禁用当前登录的自己|至少需要保留一名启用的管理员/);

    const me = await req('/api/auth/me', { cookie: cookieA });
    assert.equal(me.status, 200, '被拒绝的禁用不得撤销会话');

    const all = await listUsers(cookieA);
    const a = all.find((u) => u.id === idA);
    assert.equal(a.status, 'active', '状态必须保持启用');
    assert.equal(activeAdmins(all).length, 1, '启用管理员数量不得变成 0');
  });

  await test('用例9：恢复已禁用管理员为启用后，合法的角色调整不被误拒', async () => {
    const enable = await req(`/api/users/${idB}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { status: 'active' },
    });
    assert.equal(enable.status, 200);
    assert.equal(enable.data.role, 'admin');
    assert.equal(activeAdmins(await listUsers(cookieA)).length, 2);

    const demote = await req(`/api/users/${idB}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { role: 'reviewer' },
    });
    assert.equal(demote.status, 200, '两名启用管理员时降级其中一名不得被误拒');
    assert.equal(demote.data.role, 'reviewer');

    const restore = await req(`/api/users/${idB}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { role: 'admin' },
    });
    assert.equal(restore.status, 200);
    assert.equal(activeAdmins(await listUsers(cookieA)).length, 2);
  });

  await test('用例3：两名启用管理员时降级其中一名应成功', async () => {
    const res = await req(`/api/users/${idB}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { role: 'guest' },
    });
    assert.equal(res.status, 200, '两名启用管理员时降级一名应成功');
    assert.equal(res.data.role, 'guest');
    assert.deepEqual(activeAdmins(await listUsers(cookieA)).map((u) => u.id), [idA]);

    const restore = await req(`/api/users/${idB}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { role: 'admin' },
    });
    assert.equal(restore.status, 200);
  });

  await test('用例8：并发把两名启用管理员降级/禁用后，最终必须保留至少 1 名启用管理员', async () => {
    const reloginB = await req('/api/auth/login', { method: 'POST', body: GUARD_B });
    assert.equal(reloginB.status, 201);
    cookieB = reloginB.cookie;

    // —— 第一轮：A 降级 B、B 同时降级 A ——
    const [d1, d2] = await Promise.all([
      req(`/api/users/${idB}`, { method: 'PATCH', cookie: cookieA, body: { role: 'guest' } }),
      req(`/api/users/${idA}`, { method: 'PATCH', cookie: cookieB, body: { role: 'guest' } }),
    ]);
    assert.equal(
      [d1, d2].filter((r) => r.status === 200).length,
      1,
      `并发降级必须只成功一个，实际 ${d1.status}/${d2.status}`,
    );
    const demoteLoser = d1.status === 200 ? d2 : d1;
    assert.ok([400, 403].includes(demoteLoser.status), `被拒请求应返回业务错误，实际 ${demoteLoser.status}`);

    const survivorCookie = d1.status === 200 ? cookieA : cookieB;
    assert.equal(activeAdmins(await listUsers(survivorCookie)).length, 1, '并发降级后仍需保留 1 名启用管理员');

    // 复原：把被降级的账号改回管理员
    const demotedId = d1.status === 200 ? idB : idA;
    const back1 = await req(`/api/users/${demotedId}`, {
      method: 'PATCH',
      cookie: survivorCookie,
      body: { role: 'admin' },
    });
    assert.equal(back1.status, 200);
    assert.equal(activeAdmins(await listUsers(survivorCookie)).length, 2);

    // —— 第二轮：A 禁用 B、B 同时禁用 A（重新登录，确保两个会话都有效）——
    const la = await req('/api/auth/login', { method: 'POST', body: GUARD_A });
    assert.equal(la.status, 201);
    cookieA = la.cookie;
    const lb = await req('/api/auth/login', { method: 'POST', body: GUARD_B });
    assert.equal(lb.status, 201);
    cookieB = lb.cookie;

    const [s1, s2] = await Promise.all([
      req(`/api/users/${idB}`, { method: 'PATCH', cookie: cookieA, body: { status: 'disabled' } }),
      req(`/api/users/${idA}`, { method: 'PATCH', cookie: cookieB, body: { status: 'disabled' } }),
    ]);
    assert.equal(
      [s1, s2].filter((r) => r.status === 200).length,
      1,
      `并发禁用必须只成功一个，实际 ${s1.status}/${s2.status}`,
    );
    const disableLoser = s1.status === 200 ? s2 : s1;
    assert.ok([400, 401, 403].includes(disableLoser.status), `被拒请求应被拒绝，实际 ${disableLoser.status}`);

    const survivor2 = s1.status === 200 ? cookieA : cookieB;
    const admins2 = activeAdmins(await listUsers(survivor2));
    assert.equal(admins2.length, 1, '并发禁用后仍需保留 1 名启用管理员');

    // 复原：重新启用被禁用的管理员
    const disabledId = s1.status === 200 ? idB : idA;
    const reEnable = await req(`/api/users/${disabledId}`, {
      method: 'PATCH',
      cookie: survivor2,
      body: { status: 'active' },
    });
    assert.equal(reEnable.status, 200);
    assert.equal(activeAdmins(await listUsers(survivor2)).length, 2, '复原后应恢复为 2 名启用管理员');
  });
});
