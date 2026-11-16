/**
 * JitArchives 工作台 · 数据大盘统计接口自动化验证（node:test）。
 *
 * 使用独立测试数据库（storage/test-dashboard-<pid>.db）与独立文件存储目录，
 * 不接触正式库 storage/jitarchives.db。
 *
 * 覆盖点：
 *  1. 未登录 401；非法时间范围 400；
 *  2. 指标为真实库内计数（与 SQLite 直查一致），累计量与范围内新增量分开返回；
 *  3. 趋势按自然日补齐（7/30/90 天点数正确），范围为 0 时不为空；
 *  4. 分类分布仅统计可见档案：非管理员看不到只含受限档案的分类（不泄露受限档案存在）；
 *  5. 借阅口径：管理员/审核员为全局，著录员/借阅者为本人，访客不参与；
 *  6. 档案利用（预览/下载/借阅）仅管理员可见，其他角色返回明确中文原因；
 *  7. 五种角色的 scope 口径与待办内容差异；
 *  8. 统计接口只读：调用前后关键业务表行数不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-dashboard-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-file-store-dashboard-${process.pid}`);

let baseUrl = null;
let currentApp = null;

async function startServer() {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({ port: 0, dbFile: DB_FILE, fileStoreDir: FILE_STORE, serveWeb: false });
  currentApp = result.app;
  baseUrl = result.baseUrl;
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
    /* 非 JSON 响应（如文件流） */
  }
  const setCookie = res.headers.get('set-cookie');
  let newCookie = cookie;
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, cookie: newCookie, headers: res.headers };
}

function safeRm(file) {
  try {
    rmSync(file, { force: true });
  } catch {
    /* EPERM 忽略 */
  }
}
function safeRmDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

const ADMIN = { username: 'rootadmin_dash', displayName: '系统管理员', password: 'Admin#12345' };
const USERS = {
  cataloger: { username: 'cat_dash', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  reviewer: { username: 'rev_dash', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  borrower: { username: 'bor_dash', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'gst_dash', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n- 大盘统计测试 -',
);

let adminCookie = '';
const cookies = {};
const ids = {};

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201, `登录应成功：${u.username}`);
  return r.cookie;
}

async function stats(cookie, range) {
  const qs = range ? `?range=${range}` : '';
  const r = await req(`/api/dashboard/stats${qs}`, { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

function metric(view, key) {
  const hit = view.metrics.find((m) => m.key === key);
  assert.ok(hit, `指标卡应包含 ${key}`);
  return hit;
}

function statusCount(view, key) {
  const hit = view.statuses.items.find((s) => s.key === key);
  assert.ok(hit, `状态分布应包含 ${key}`);
  return hit.count;
}

function borrowCount(view, key) {
  const hit = view.borrow.items.find((s) => s.key === key);
  assert.ok(hit, `借阅分布应包含 ${key}`);
  return hit.count;
}

/** 直接查询测试库，作为「真实数据」的独立比对基准。 */
function sqlCount(sql, ...args) {
  const db = new DatabaseSync(DB_FILE);
  try {
    const row = db.prepare(sql).get(...args);
    return Number(row.c);
  } finally {
    db.close();
  }
}

test.describe('工作台数据大盘统计接口', { concurrency: false }, async () => {
  test.before(async () => {
    safeRm(DB_FILE);
    safeRm(`${DB_FILE}-wal`);
    safeRm(`${DB_FILE}-shm`);
    safeRmDir(FILE_STORE);
    await startServer();
  });

  test.after(async () => {
    if (currentApp) {
      await currentApp.close();
      currentApp = null;
    }
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
  });

  await test('准备：初始化管理员、五类角色、分类与档案', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201, JSON.stringify(init.data));
    adminCookie = init.cookie;

    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      cookies[key] = await login(USERS[key]);
    }

    for (const [key, def] of Object.entries({ 综合文书: 'ZH', 涉密专题: 'SM' })) {
      const cat = await req('/api/categories', {
        method: 'POST',
        cookie: adminCookie,
        body: { name: key, code: def },
      });
      assert.equal(cat.status, 201, JSON.stringify(cat.data));
      ids[def === 'ZH' ? 'catA' : 'catB'] = cat.data.id;
    }

    const create = async (title, categoryId, accessLevel) => {
      const r = await req('/api/archives', {
        method: 'POST',
        cookie: cookies.cataloger,
        body: { title, categoryId, archiveType: '文书档案', accessLevel },
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data.id;
    };

    ids.arcPublicDraft = await create('公开草稿档案', ids.catA, 'public');
    ids.arcPublicArchived = await create('公开待归档档案', ids.catA, 'public');
    ids.arcRestrictedOwn = await create('涉密档案（著录员自建）', ids.catB, 'restricted');

    // 管理员创建一份仅管理员可见的受限档案，用于验证「非管理员不可见」口径。
    const adminArc = await req('/api/archives', {
      method: 'POST',
      cookie: adminCookie,
      body: { title: '涉密档案（管理员创建）', categoryId: ids.catB, archiveType: '文书档案', accessLevel: 'restricted' },
    });
    assert.equal(adminArc.status, 201, JSON.stringify(adminArc.data));
    ids.arcRestrictedAdmin = adminArc.data.id;

    // 审核员把其中一份公开档案归档（draft → archived）
    const trans = await req(`/api/archives/${ids.arcPublicArchived}/transition-archive`, {
      method: 'POST',
      cookie: cookies.reviewer,
    });
    assert.equal(trans.status, 201, JSON.stringify(trans.data));
    assert.equal(trans.data.status, 'archived');

    // 上传 PDF 到一个公开档案，用于产生真实的预览/下载审计事件
    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.arcPublicDraft}&name=${encodeURIComponent('公开附件.pdf')}`,
      {
        method: 'POST',
        cookie: cookies.cataloger,
        raw: true,
        body: PDF_BYTES,
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    );
    assert.equal(up.status, 201, JSON.stringify(up.data));
    ids.filePublic = up.data.id;

    const dl = await req(`/api/archive-files/${ids.filePublic}/download`, { cookie: cookies.cataloger });
    assert.equal(dl.status, 200, '公开档案附件应可下载');
    const pv = await req(`/api/archive-files/${ids.filePublic}/preview`, { cookie: cookies.cataloger });
    assert.equal(pv.status, 200, 'PDF 应支持在线预览');
  });

  await test('未登录 401；非法时间范围 400', async () => {
    const anon = await req('/api/dashboard/stats');
    assert.equal(anon.status, 401, '未登录不得读取统计');

    const bad = await req('/api/dashboard/stats?range=1y', { cookie: adminCookie });
    assert.equal(bad.status, 400, '非法范围必须 400');
    assert.match(String(bad.data?.message ?? ''), /时间范围/, '应给出中文范围提示');
  });

  await test('管理员：指标为真实库内计数，累计量与范围内新增量分开', async () => {
    const total = sqlCount('SELECT COUNT(*) AS c FROM archives');
    const archived = sqlCount("SELECT COUNT(*) AS c FROM archives WHERE status = 'archived'");
    const draft = sqlCount("SELECT COUNT(*) AS c FROM archives WHERE status = 'draft'");

    const view = await stats(adminCookie, '30d');
    assert.equal(view.scope.archiveScope, 'system');
    assert.equal(view.scope.role, 'admin');
    assert.equal(metric(view, 'archives').total, total);
    assert.equal(metric(view, 'archived').total, archived);
    assert.equal(metric(view, 'draft').total, draft);
    assert.ok(total >= 4, '测试数据应至少 4 份档案');

    // 所有档案都在今天创建 → 范围内新增量与累计量一致
    assert.equal(metric(view, 'archives').period, total);
    assert.equal(metric(view, 'archived').period, archived);
    assert.equal(metric(view, 'draft').period, draft);
    assert.match(metric(view, 'archives').periodLabel, /最近 30 天/, '新增量需标明时间范围');

    assert.equal(view.statuses.total, total);
    assert.equal(statusCount(view, 'archived'), archived);
    assert.equal(statusCount(view, 'draft'), draft);

    assert.equal(view.archiveTrend.points.length, 30, '30 天应有 30 个自然日点');
    assert.equal(view.archiveTrend.periodTotal, total);
    assert.equal(
      view.archiveTrend.points.reduce((sum, p) => sum + p.count, 0),
      total,
      '趋势求和应等于范围内新增总量',
    );
    const days = view.archiveTrend.points.map((p) => p.day);
    assert.deepEqual([...days].sort(), days, '趋势日期需升序');
    assert.equal(new Date(view.generatedAt).getTime() > 0, true);
  });

  await test('管理员：分类分布与借阅口径为全库/全部申请', async () => {
    const view = await stats(adminCookie, '30d');
    const byName = new Map(view.categories.items.map((c) => [c.name, c.count]));
    assert.equal(byName.get('综合文书'), 2, '综合文书分类应有 2 份公开档案');
    assert.equal(byName.get('涉密专题'), 2, '涉密专题分类应有 2 份受限档案');
    assert.equal(view.categories.total, 4, '分类分布合计应等于可见档案总数');

    // 借阅：先由借阅者提交两条申请（一条之后通过、一条之后拒绝）
    const reqA = await req('/api/borrow-requests', {
      method: 'POST',
      cookie: cookies.borrower,
      body: { archiveId: ids.arcRestrictedOwn, purpose: '项目审计需要', days: 10 },
    });
    assert.equal(reqA.status, 201, JSON.stringify(reqA.data));
    ids.borrowApproved = reqA.data.id;

    const reqB = await req('/api/borrow-requests', {
      method: 'POST',
      cookie: cookies.borrower,
      body: { archiveId: ids.arcRestrictedAdmin, purpose: '临时查阅', days: 3 },
    });
    assert.equal(reqB.status, 201, JSON.stringify(reqB.data));
    ids.borrowRejected = reqB.data.id;

    const pendingView = await stats(adminCookie, '30d');
    assert.equal(pendingView.borrow.available, true);
    assert.equal(pendingView.borrow.total, 2);
    assert.equal(borrowCount(pendingView, 'pending'), 2);
    assert.equal(metric(pendingView, 'borrowPending').total, 2, '管理员待审核数应为全局待审核数');
    assert.match(pendingView.borrow.scopeLabel, /全部借阅申请/);

    // 拒绝一条、通过一条
    const reject = await req(`/api/borrow-requests/${ids.borrowRejected}/reject`, {
      method: 'POST',
      cookie: cookies.reviewer,
      body: { note: '资料涉密程度较高，暂不外借' },
    });
    assert.equal(reject.status, 201, JSON.stringify(reject.data));

    const approve = await req(`/api/borrow-requests/${ids.borrowApproved}/approve`, {
      method: 'POST',
      cookie: cookies.reviewer,
      body: { note: '同意借阅' },
    });
    assert.equal(approve.status, 201, JSON.stringify(approve.data));

    const doneView = await stats(adminCookie, '30d');
    assert.equal(doneView.borrow.total, 2);
    assert.equal(borrowCount(doneView, 'pending'), 0);
    assert.equal(borrowCount(doneView, 'approved'), 1);
    assert.equal(borrowCount(doneView, 'rejected'), 1);
    assert.equal(metric(doneView, 'borrowPending').total, 0);
    assert.equal(doneView.borrow.periodTotal, 2, '范围内新申请数应为 2');
    assert.equal(
      doneView.borrow.trend.reduce((sum, p) => sum + p.count, 0),
      2,
      '借阅趋势求和应等于范围内新申请数',
    );
  });

  await test('管理员：档案利用数据来自真实审计记录', async () => {
    const view = await stats(adminCookie, '30d');
    assert.equal(view.utilization.available, true);
    assert.ok(view.utilization.totals.download >= 1, '应统计到真实下载事件');
    assert.ok(view.utilization.totals.preview >= 1, '应统计到真实预览事件');
    assert.ok(view.utilization.totals.borrow >= 2, '应统计到真实借阅申请事件');
    assert.equal(view.utilization.series.length, 30);
    assert.match(view.utilization.sourceLabel, /操作审计/);
  });

  await test('借阅者：档案按可见范围统计，不泄露受限档案分类', async () => {
    const view = await stats(cookies.borrower, '30d');
    assert.equal(view.scope.archiveScope, 'visible');
    assert.equal(view.scope.borrowScope, 'own');

    // 借阅者看不到「仅管理员创建」的受限档案；通过授权后可看到自己获授权的那份
    const publicCount = sqlCount("SELECT COUNT(*) AS c FROM archives WHERE access_level = 'public'");
    assert.equal(metric(view, 'archives').total, publicCount + 1, '可见范围=公开档案+已授权借阅档案');

    // 分类分布必须只统计可见档案：管理员创建的受限档案与借阅者无关，
    // 因此「涉密专题」只应出现已获授权的那 1 份。
    const byName = new Map(view.categories.items.map((c) => [c.name, c.count]));
    assert.equal(byName.get('综合文书'), 2, '公开档案分类计数应准确');
    const smCount = byName.get('涉密专题') ?? 0;
    assert.equal(smCount, 1, '仅统计已获授权的受限档案，不得含他人未授权受限档案');
    assert.equal(view.categories.total, publicCount + 1);

    assert.equal(metric(view, 'borrowPending').total, 0, '本人待审核申请已处理');
    assert.equal(view.borrow.total, 2, '仅统计本人申请');
    assert.match(view.borrow.scopeLabel, /本人借阅申请/);

    assert.equal(view.utilization.available, false);
    assert.match(view.utilization.reason, /仅管理员/, '非管理员应收到明确的中文说明');
  });

  await test('审核员：借阅为全局口径，档案仍按可见范围', async () => {
    const view = await stats(cookies.reviewer, '30d');
    assert.equal(view.scope.borrowScope, 'all');
    assert.equal(view.scope.archiveScope, 'visible');
    assert.equal(view.borrow.total, 2, '审核员应看到全部借阅申请');
    assert.equal(borrowCount(view, 'approved'), 1);
    assert.equal(borrowCount(view, 'rejected'), 1);
    assert.equal(metric(view, 'archives').total, 2, '审核员仅可见公开档案（两份）');
    assert.ok(view.todos.some((t) => t.key === 'drafts' && t.count > 0), '审核员应有草稿待归档待办');
    assert.ok(
      !view.todos.some((t) => t.key === 'pending-borrow'),
      '待审核为 0 时不应出现空的待办条目',
    );
  });

  await test('著录员：借阅仅本人申请，待办含本人草稿', async () => {
    const view = await stats(cookies.cataloger, '30d');
    assert.equal(view.scope.borrowScope, 'own');
    assert.equal(view.borrow.total, 0, '著录员本人未提交借阅申请');
    assert.equal(metric(view, 'borrowPending').total, 0);
    assert.equal(metric(view, 'archives').total, 3, '公开档案 2 份 + 本人受限档案 1 份');
    const todo = view.todos.find((t) => t.key === 'my-drafts');
    assert.ok(todo, '著录员应有本人草稿待办');
    assert.ok(todo.count >= 1);
  });

  await test('访客：不参与借阅，仅公开档案口径', async () => {
    const view = await stats(cookies.guest, '30d');
    assert.equal(view.borrow.available, false);
    assert.match(view.borrow.reason, /访客/);
    assert.equal(metric(view, 'borrowPending').available, false);
    assert.equal(metric(view, 'borrowPending').total, null);
    assert.equal(view.borrow.total, 0);
    assert.equal(view.todos.length, 0, '访客无待办');
    assert.equal(view.utilization.available, false);

    const publicCount = sqlCount("SELECT COUNT(*) AS c FROM archives WHERE access_level = 'public'");
    assert.equal(metric(view, 'archives').total, publicCount);
  });

  await test('时间范围切换：7/30/90 天点数与范围内新增量同步', async () => {
    const seven = await stats(adminCookie, '7d');
    assert.equal(seven.range.key, '7d');
    assert.equal(seven.range.days, 7);
    assert.equal(seven.archiveTrend.points.length, 7);
    assert.match(seven.range.label, /7 天/);

    const ninety = await stats(adminCookie, '90d');
    assert.equal(ninety.range.days, 90);
    assert.equal(ninety.archiveTrend.points.length, 90);
    assert.equal(ninety.archiveTrend.periodTotal, metric(ninety, 'archives').period);

    const fallback = await stats(adminCookie, '');
    assert.equal(fallback.range.key, '30d', '缺省范围应为最近 30 天');
  });

  await test('只读性：统计前后业务表行数不变', async () => {
    const before = {
      archives: sqlCount('SELECT COUNT(*) AS c FROM archives'),
      borrows: sqlCount('SELECT COUNT(*) AS c FROM borrow_requests'),
      audits: sqlCount('SELECT COUNT(*) AS c FROM audit_logs'),
      grants: sqlCount('SELECT COUNT(*) AS c FROM borrow_grants'),
    };
    await stats(adminCookie, '30d');
    await stats(cookies.borrower, '7d');
    const after = {
      archives: sqlCount('SELECT COUNT(*) AS c FROM archives'),
      borrows: sqlCount('SELECT COUNT(*) AS c FROM borrow_requests'),
      audits: sqlCount('SELECT COUNT(*) AS c FROM audit_logs'),
      grants: sqlCount('SELECT COUNT(*) AS c FROM borrow_grants'),
    };
    assert.deepEqual(after, before, '统计接口不得写入任何业务表');
  });
});
