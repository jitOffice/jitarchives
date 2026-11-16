/**
 * JitArchives 阶段二第五批 · 操作审计自动化验证（node:test）
 *
 * 隔离：独立测试库（storage/test-audit-<pid>.db）+ 独立文件存储目录，绝不触碰正式库。
 *
 * 覆盖：
 *  1. 迁移 006 生效：/api/audit 可查询即证明 audit_logs 表已建立；
 *  2. 关键操作留痕：初始化/登录/建用户/角色变更/建档案/归档流转/失败登录均产生记录；
 *  3. 服务端查询过滤（后端 SQL 执行，非前端二次筛选）：
 *     按 action、按 actorUserId、按 actorName（操作人名称模糊）、按时间范围 from/to、分页 page/pageSize、结果 result；
 *  4. 排序稳定：按时间倒序、同日按 id 倒序（最新在前）；
 *  5. 脱敏：任何审计 detail 绝不出现密码原文；
 *  6. 只追加（无删除）：total 随操作单调不减，天然满足「不少于 6 个月」保留下限；
 *  7. 重启持久化：停止并重新打开同一库后，既有审计记录与档案数据仍在；
 *  8. 展示层（本次新增）：对象列显示真实业务名称（档案题名 / 附件名 / 账号 / 借阅对应档案），
 *     详情列为中文业务说明，借阅、附件、档案、用户均可读；原始字段与详情仍完整保留。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-audit-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-audit-store-${process.pid}`);

let baseUrl = null;
let currentApp = null;

async function startServer() {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({ port: 0, dbFile: DB_FILE, fileStoreDir: FILE_STORE, serveWeb: false });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}
async function stopServer() {
  if (currentApp) await currentApp.close();
  currentApp = null;
}

async function req(pathname, { method = 'GET', body, cookie, raw, headers: extraHeaders } = {}) {
  const headers = { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(extraHeaders || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  const setCookie = res.headers.get('set-cookie');
  let newCookie = cookie;
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, cookie: newCookie };
}
async function audit(params, cookie) {
  const r = await req(`/api/audit?${params}`, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
function safeRm(f) {
  try {
    rmSync(f, { force: true });
  } catch {
    /* 忽略 */
  }
}
function cleanFiles() {
  for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
  try {
    rmSync(FILE_STORE, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

const ADMIN = { username: 'auditroot', displayName: '审计管理员', password: 'Admin#12345' };
const CAT = { username: 'audit_cat', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' };
const PDF = new TextEncoder().encode('%PDF-1.4\n% audit test\n%%EOF\n');

let adminCookie = '';
let adminId = null;
let catId = null;
const ids = {};

test.describe('JitArchives 阶段二第五批 · 操作审计自动化验证', { concurrency: false }, async () => {
  test.before(async () => {
    cleanFiles();
    await startServer();
  });
  test.after(async () => {
    await stopServer();
    cleanFiles();
  });

  await test('准备：初始化并产生一批真实操作', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    adminId = init.data.user.id;

    // 显式登录一次（验证 auth.login 留痕；init-admin 的自动登录仅记 init_admin）
    const relogin = await req('/api/auth/login', { method: 'POST', body: { username: ADMIN.username, password: ADMIN.password } });
    assert.equal(relogin.status, 201);
    adminCookie = relogin.cookie;

    const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: CAT });
    assert.equal(created.status, 201);
    catId = created.data.id;

    const cat = await req('/api/categories', { method: 'POST', cookie: adminCookie, body: { name: '审计测试分类', code: 'AUDIT' } });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;

    const arc = await req('/api/archives', {
      method: 'POST', cookie: adminCookie,
      body: { title: '审计追溯档案', categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'public' },
    });
    assert.equal(arc.status, 201);
    ids.arc = arc.data.id;

    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.arc}&name=${encodeURIComponent('a.pdf')}`,
      { method: 'POST', cookie: adminCookie, raw: true, body: PDF, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 201);
    ids.file = up.data.id;

    const trans = await req(`/api/archives/${ids.arc}/transition-archive`, { method: 'POST', cookie: adminCookie });
    assert.equal(trans.status, 201);

    // 角色变更（cataloger → reviewer）——关键状态变更应与成功审计同事务
    const roleChange = await req(`/api/users/${catId}`, { method: 'PATCH', cookie: adminCookie, body: { role: 'reviewer' } });
    assert.equal(roleChange.status, 200, JSON.stringify(roleChange.data));
    assert.equal(roleChange.data.role, 'reviewer');

    // 失败登录留痕
    await req('/api/auth/login', { method: 'POST', body: { username: 'audit_cat', password: 'Wrong#Pwd' } });
  });

  await test('1. 迁移 006 生效且关键操作留痕（成功/失败可区分）', async () => {
    const page = await audit('pageSize=100', adminCookie);
    const actions = new Set(page.items.map((it) => it.action));
    for (const expected of [
      'auth.init_admin',
      'auth.login',
      'user.create',
      'category.create',
      'archive.create',
      'file.upload',
      'archive.transition_archived',
      'user.role_change',
      'auth.login_failure',
    ]) {
      assert.ok(actions.has(expected), `审计应包含动作 ${expected}`);
    }
    // 失败登录必须记 result=failure，绝不与成功混淆
    const failEntry = page.items.find((it) => it.action === 'auth.login_failure');
    assert.equal(failEntry.result, 'failure', '失败登录必须记 failure');
  });

  await test('2. 按 action 过滤由后端执行', async () => {
    const r = await audit('action=user.role_change&pageSize=100', adminCookie);
    assert.ok(r.items.length >= 1);
    assert.ok(r.items.every((it) => it.action === 'user.role_change'), 'action 过滤结果必须全部匹配');
    const role = r.items[0];
    assert.equal(role.detail.from, 'cataloger');
    assert.equal(role.detail.to, 'reviewer');
    assert.equal(String(role.objectId), String(catId));
  });

  await test('3. 按 actorUserId 过滤', async () => {
    const r = await audit(`actorUserId=${adminId}&pageSize=100`, adminCookie);
    assert.ok(r.items.length >= 1);
    assert.ok(r.items.every((it) => it.actorUserId === adminId), 'actor 过滤结果操作人必须一致');
    // 不存在的操作人 → 空
    const none = await audit('actorUserId=999999&pageSize=10', adminCookie);
    assert.equal(none.items.length, 0, '不存在操作人应返回空集');
  });

  await test('3b. 按 actorName（操作人名称）过滤', async () => {
    const byName = await audit(`actorName=${encodeURIComponent(ADMIN.displayName)}&pageSize=100`, adminCookie);
    assert.ok(byName.items.length >= 1);
    assert.ok(
      byName.items.every((it) => it.actorName === ADMIN.displayName),
      '按名称过滤结果操作人名称必须一致',
    );
    // 名称模糊包含匹配（子串命中）
    const fuzzy = await audit(`actorName=${encodeURIComponent('计管理')}&pageSize=100`, adminCookie);
    assert.ok(fuzzy.items.length >= 1, '名称模糊包含匹配应命中');
    // 与 actorUserId 组合仍按 AND 生效
    const both = await audit(
      `actorUserId=${adminId}&actorName=${encodeURIComponent(ADMIN.displayName)}&pageSize=100`,
      adminCookie,
    );
    assert.ok(both.items.length >= 1, 'ID 与名称同时给定时应取交集且能命中');
    // 不存在的名称 → 空
    const none = await audit(`actorName=${encodeURIComponent('不存在名称')}&pageSize=10`, adminCookie);
    assert.equal(none.items.length, 0, '不存在操作人名称应返回空集');
  });

  await test('4. 按时间范围 from/to 过滤', async () => {
    const all = await audit('from=2000-01-01&pageSize=100', adminCookie);
    assert.ok(all.items.length >= 1, '宽松下界应命中全部近期记录');
    const old = await audit('to=2000-01-01&pageSize=100', adminCookie);
    assert.equal(old.items.length, 0, '过去上界应无记录');
    const future = await audit('from=2099-01-01&pageSize=100', adminCookie);
    assert.equal(future.items.length, 0, '未来下界应无记录');
    // 非法时间格式 → 400
    const bad = await req('/api/audit?from=not-a-date', { cookie: adminCookie });
    assert.equal(bad.status, 400, '非法时间参数必须 400');
  });

  await test('5. 分页与稳定倒序', async () => {
    const p1 = await audit('page=1&pageSize=1', adminCookie);
    assert.equal(p1.items.length, 1, 'pageSize=1 只应返回 1 条');
    assert.ok(p1.total > 1, 'total 应大于页容量');
    assert.equal(p1.pageSize, 1);
    const p2 = await audit('page=2&pageSize=1', adminCookie);
    assert.equal(p2.items.length, 1);
    assert.notEqual(p2.items[0].id, p1.items[0].id, '不同页不得返回同一条');
    // 全局按 id 倒序（最新在前）
    const big = await audit('pageSize=100', adminCookie);
    for (let i = 0; i + 1 < big.items.length; i += 1) {
      assert.ok(big.items[i].id >= big.items[i + 1].id, '审计列表应按 id 倒序');
    }
  });

  await test('6. detail 绝不含密码原文（脱敏）', async () => {
    // 触发一次带密码的重置
    const reset = await req(`/api/users/${catId}`, { method: 'PATCH', cookie: adminCookie, body: { password: 'NewCat#99999' } });
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    const r = await audit('action=user.password_reset&pageSize=100', adminCookie);
    assert.ok(r.items.length >= 1, '密码重置应有审计');
    for (const it of r.items) {
      const text = JSON.stringify(it.detail);
      assert.ok(!text.includes('NewCat#99999'), '审计 detail 绝不含明文密码');
      assert.ok(!/password/i.test(JSON.stringify(Object.keys(it.detail))), '审计 detail 键不得为 password');
    }
  });

  await test('7. 只追加：total 随新操作单调不减', async () => {
    const before = (await audit('pageSize=1', adminCookie)).total;
    // 追加一条操作（改显示名 → user.profile_update）
    await req(`/api/users/${catId}`, { method: 'PATCH', cookie: adminCookie, body: { displayName: '审计改名' } });
    const after = (await audit('pageSize=1', adminCookie)).total;
    assert.ok(after > before, `审计记录应只追加不减：${before} → ${after}`);
  });

  await test('8. 重启持久化：重新打开同一库后审计与档案数据仍在', async () => {
    const totalBefore = (await audit('pageSize=1', adminCookie)).total;
    await stopServer();

    // 重新在同一个库文件上启动（模拟重启；库已存在，不再初始化）
    await startServer();
    const relogin = await req('/api/auth/login', { method: 'POST', body: { username: ADMIN.username, password: ADMIN.password } });
    assert.equal(relogin.status, 201, '重启后管理员应可再次登录');
    const adminCookie2 = relogin.cookie;

    const page = await audit('pageSize=1', adminCookie2);
    assert.ok(page.total >= totalBefore, '重启后审计记录总数不减少（持久化）');

    const detail = await req(`/api/archives/${ids.arc}`, { cookie: adminCookie2 });
    assert.equal(detail.status, 200, '重启后档案仍可读取');
    assert.equal(detail.data.title, '审计追溯档案');
    assert.equal(detail.data.status, 'archived', '重启保留归档状态');
  });

  await test('9. 展示层：对象显示真实业务名称，详情为中文业务说明（借阅/附件/档案/用户）', async () => {
    const relogin = await req('/api/auth/login', {
      method: 'POST',
      body: { username: ADMIN.username, password: ADMIN.password },
    });
    assert.equal(relogin.status, 201);
    const cookie = relogin.cookie;

    // 借阅者 + 受限档案 → 申请 → 通过，产生 borrow.request / borrow.approve 审计
    const borrower = await req('/api/users', {
      method: 'POST',
      cookie,
      body: { username: 'audit_bor', displayName: '借阅者乙', password: 'Bor#12345', role: 'borrower' },
    });
    assert.equal(borrower.status, 201, JSON.stringify(borrower.data));
    const restricted = await req('/api/archives', {
      method: 'POST',
      cookie,
      body: { title: '审计借阅合同', categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'restricted' },
    });
    assert.equal(restricted.status, 201, JSON.stringify(restricted.data));
    const borrowerLogin = await req('/api/auth/login', {
      method: 'POST',
      body: { username: 'audit_bor', password: 'Bor#12345' },
    });
    assert.equal(borrowerLogin.status, 201);
    const request = await req('/api/borrow-requests', {
      method: 'POST',
      cookie: borrowerLogin.cookie,
      body: { archiveId: restricted.data.id, purpose: '展示层验收', days: 30 },
    });
    assert.equal(request.status, 201, JSON.stringify(request.data));
    const approved = await req(`/api/borrow-requests/${request.data.id}/approve`, {
      method: 'POST',
      cookie,
      body: { note: '同意' },
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.data));

    // 在线预览 PDF 附件，产生 file.preview 审计
    const preview = await req(`/api/archive-files/${ids.file}/preview`, { cookie });
    assert.equal(preview.status, 200);

    const page = await audit('pageSize=100', cookie);
    const byAction = (a) => page.items.filter((it) => it.action === a);
    const plain = (it) => it.summary.map((p) => (p.kind === 'time' ? '<时间>' : p.text)).join('');

    // 借阅：对象为对应档案题名；详情为中文说明；到期时间以时间片段返回
    const approve = byAction('borrow.approve')[0];
    assert.ok(approve, '应有 borrow.approve 审计');
    assert.equal(approve.actionLabel, '借阅通过');
    assert.equal(approve.objectTypeLabel, '借阅申请');
    assert.equal(approve.objectLabel, '审计借阅合同', '借阅对象的真实业务名称应为档案题名');
    assert.match(String(approve.objectRef), /^借阅申请 #\d+$/);
    assert.match(plain(approve), /^批准 audit_bor 借阅《审计借阅合同》，期限 30 天/);
    assert.ok(approve.summary.some((p) => p.kind === 'time'), '到期时间应作为时间片段返回（由浏览器本地化）');
    assert.ok(!/archiveId|applicantId|dueAt/.test(plain(approve)), '详情不得直接暴露后端字段名');
    // 原始追溯字段必须保留
    assert.equal(approve.objectType, 'borrow_request');
    assert.equal(approve.objectId, String(request.data.id));
    assert.equal(approve.detail.archiveId, restricted.data.id, '原始 detail 必须保留');

    // 附件：对象为附件名，副标题为所属档案；动作已中文化
    const preview0 = byAction('file.preview')[0];
    assert.ok(preview0, '应有 file.preview 审计');
    assert.equal(preview0.actionLabel, '在线预览附件', 'file.preview 必须中文化');
    assert.equal(preview0.objectLabel, 'a.pdf', '附件对象应显示附件名');
    assert.equal(preview0.objectRef, '所属档案《审计追溯档案》');
    assert.match(plain(preview0), /^在线预览档案《审计追溯档案》的附件《a\.pdf》（PDF 文档）$/);

    // 档案：对象为档案题名 + 档号
    const create = byAction('archive.create').find((it) => it.objectId === String(ids.arc));
    assert.ok(create, '应有目标档案的 archive.create 审计');
    assert.equal(create.objectLabel, '审计追溯档案');
    assert.match(String(create.objectRef), /^档号 /);

    // 用户：对象为登录账号，角色枚举已中文化
    const roleChange = byAction('user.role_change')[0];
    assert.ok(roleChange, '应有 user.role_change 审计');
    assert.equal(roleChange.objectLabel, 'audit_cat');
    assert.equal(plain(roleChange), '将用户 audit_cat 的角色由「著录员」变更为「审核员」');

    // 上传：附件名 + 所属档案，均可读
    const upload = byAction('file.upload').find((it) => it.objectId === String(ids.file));
    assert.ok(upload, '应有目标附件的 file.upload 审计');
    assert.equal(upload.objectLabel, 'a.pdf');
    assert.equal(plain(upload), '向档案《审计追溯档案》上传附件《a.pdf》');

    // 动作下拉与列表同源，且覆盖 file.preview
    const acts = await req('/api/audit/actions', { cookie });
    assert.equal(acts.status, 200);
    assert.ok(acts.data.actions.includes('file.preview'));
    assert.equal(acts.data.labels['file.preview'], '在线预览附件');

    // 展示层不得泄露敏感信息（详情仍来自已脱敏 detail）
    assert.ok(!JSON.stringify(page.items.map((it) => it.detail)).includes('Bor#12345'));
  });
});
