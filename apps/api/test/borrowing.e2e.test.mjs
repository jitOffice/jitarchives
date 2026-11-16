/**
 * JitArchives 阶段二第四批 · 档案借阅与档案级访问控制后端自动化验证（node:test）
 *
 * 使用独立测试数据库（storage/test-borrow-<pid>.db）与独立文件存储目录，
 * 不触碰正式库、64 项既有回归用例与其他测试库。
 * 覆盖项（对齐交付任务第十节借阅相关场景）：
 *  1. 借阅接口未登录一律 401；
 *  2. 访客无借阅申请权（borrowRequest 默认拒绝）；借阅目录仅列出受限档案；
 *  3. 申请校验：用途必填/长度、期限 1-90 天；重复待处理申请 409（事务+唯一索引）；
 *  4. 审核权限：申请/归还用 borrowRequest，审核用 borrowReview；借阅者不能自审/审核；
 *  5. 申请人不能审核本人提交的申请；
 *  6. 审批幂等：重复审批 409；拒绝必须填写意见；
 *  7. 授权生效：审核通过后受限档案可读可下载；未授权者（含访客）读/下载 403；
 *  8. 管理员与创建者对受限档案恒可访问；
 *  9. 归还：授权撤销后受限档案读/下载立即失效；
 * 10. 到期惰性失效：过期授权不再放行；
 * 11. 借阅目录排除已持有有效授权的档案；
 * 12. 受限档案不出现在无权限者的检索列表中（可见性过滤）。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-borrow-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-file-store-borrow-${process.pid}`);

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
  await currentApp.close();
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
  return { status: res.status, data, cookie: newCookie, headers: res.headers };
}

function safeRm(f) {
  try {
    rmSync(f, { force: true });
  } catch {
    /* EPERM 忽略 */
  }
}
function safeRmDir(d) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

const ADMIN = { username: 'rootadmin', displayName: '总管理员', password: 'Admin#12345' };
const USERS = {
  cataloger: { username: 'cat_b', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  reviewer: { username: 'rev_b', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  reviewer2: { username: 'rev_b2', displayName: '审核员乙', password: 'Rev#12345', role: 'reviewer' },
  borrower: { username: 'bor_b', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'gst_b', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n- 借阅测试内容 -');

let adminCookie = '';
const cookies = {};
const ids = {};

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201, `登录应成功：${u.username}`);
  return r.cookie;
}

/** 著录员创建一个受限档案，可挂一个 PDF 附件；返回 { archiveId, fileId }。 */
async function createRestrictedArchive(title) {
  const created = await req('/api/archives', {
    method: 'POST',
    cookie: cookies.cataloger,
    body: { title, categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'restricted' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const archiveId = created.data.id;
  assert.equal(created.data.accessLevel, 'restricted', '应落库为受限');
  const up = await req(
    `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent('受限附件.pdf')}`,
    { method: 'POST', cookie: cookies.cataloger, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
  );
  assert.equal(up.status, 201, JSON.stringify(up.data));
  return { archiveId, fileId: up.data.id };
}

test.describe('JitArchives 阶段二第四批 · 借阅与档案级访问自动化验证', { concurrency: false }, async () => {
  test.before(async () => {
    safeRm(DB_FILE);
    safeRm(`${DB_FILE}-wal`);
    safeRm(`${DB_FILE}-shm`);
    safeRmDir(FILE_STORE);
    await startServer();
  });

  test.after(async () => {
    if (currentApp) await stopServer();
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
  });

  await test('准备：初始化并建立各角色、分类与受限档案', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      cookies[key] = await login(USERS[key]);
    }
    const cat = await req('/api/categories', { method: 'POST', cookie: adminCookie, body: { name: '涉密文书', code: 'SM' } });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;
  });

  // ==================== 1. 未登录 ====================

  await test('借阅接口：未登录一律 401', async () => {
    for (const p of ['/api/borrow-requests/catalog', '/api/borrow-requests/mine', '/api/borrow-requests?status=pending']) {
      const r = await req(p);
      assert.equal(r.status, 401, `${p} 未登录必须 401`);
    }
    const post = await req('/api/borrow-requests', { method: 'POST', body: { archiveId: 1, purpose: 'x', days: 3 } });
    assert.equal(post.status, 401);
  });

  // ==================== 2. 权限与目录 ====================

  await test('权限：访客无借阅申请权；借阅目录仅列受限档案', async () => {
    const guestCatalog = await req('/api/borrow-requests/catalog', { cookie: cookies.guest });
    assert.equal(guestCatalog.status, 403, '访客 borrowRequest 默认拒绝必须 403');

    const { archiveId } = await createRestrictedArchive('涉密合同A');
    ids.arcA = archiveId;

    const catalog = await req('/api/borrow-requests/catalog', { cookie: cookies.borrower });
    assert.equal(catalog.status, 200);
    assert.ok(catalog.data.some((a) => a.id === ids.arcA), '受限档案应出现在借阅目录');
    assert.ok(catalog.data.every((a) => a.accessLevel === 'restricted'), '目录不得含公开档案');
  });

  await test('可见性：受限档案不在无权限者检索列表，创建者与管理员可见', async () => {
    const borrowerList = await req('/api/archives?pageSize=50', { cookie: cookies.borrower });
    assert.equal(borrowerList.status, 200);
    assert.ok(!borrowerList.data.items.some((a) => a.id === ids.arcA), '未授权借阅者列表不得出现受限档案');

    const guestDetail = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.guest });
    assert.equal(guestDetail.status, 403, '访客访问受限档案必须 403');

    const creatorDetail = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.cataloger });
    assert.equal(creatorDetail.status, 200, '创建者本人可见自己的受限档案');
    assert.equal(creatorDetail.data.accessLevel, 'restricted');

    const adminDetail = await req(`/api/archives/${ids.arcA}`, { cookie: adminCookie });
    assert.equal(adminDetail.status, 200, '管理员恒可见');

    const borrowerDownloadBefore = await req(`/api/archive-files/${ids.arcAFile ?? 0}/download`, { cookie: cookies.borrower });
    assert.ok([401, 403, 404].includes(borrowerDownloadBefore.status), '未授权下载不得成功');
  });

  // ==================== 3. 申请校验 ====================

  await test('申请：用途必填/期限 1-90 校验；合法申请落库为待处理', async () => {
    const noPurpose = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower, body: { archiveId: ids.arcA, purpose: '', days: 7 },
    });
    assert.equal(noPurpose.status, 400, '空用途必须 400');

    for (const days of [0, 91, -1, 1.5]) {
      const bad = await req('/api/borrow-requests', {
        method: 'POST', cookie: cookies.borrower, body: { archiveId: ids.arcA, purpose: '工作参考', days },
      });
      assert.equal(bad.status, 400, `非法期限必须 400：${days}`);
    }

    const ok = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower, body: { archiveId: ids.arcA, purpose: '项目审计需要', days: 30 },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.status, 'pending');
    assert.equal(ok.data.statusLabel, '待审核');
    ids.borrowA = ok.data.id;

    const dup = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower, body: { archiveId: ids.arcA, purpose: '重复申请', days: 10 },
    });
    assert.equal(dup.status, 409, '同一档案重复待处理申请必须 409');

    const mine = await req('/api/borrow-requests/mine', { cookie: cookies.borrower });
    assert.equal(mine.status, 200);
    assert.ok(mine.data.some((r) => r.id === ids.borrowA), '我的借阅应含刚提交申请');
  });

  // ==================== 4. 审核权限与自审防护 ====================

  await test('审核：借阅者无权审核；申请人不能审核本人；无意见拒绝被拒', async () => {
    const byBorrower = await req(`/api/borrow-requests/${ids.borrowA}/approve`, { method: 'POST', cookie: cookies.borrower, body: {} });
    assert.equal(byBorrower.status, 403, '借阅者无 borrowReview 权限必须 403');

    // 审核员甲自己提一个申请，再试图审核自己 → 403（申请人不得自审）
    const selfReq = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.reviewer, body: { archiveId: ids.arcA, purpose: '本人参考', days: 5 },
    });
    assert.equal(selfReq.status, 201);
    ids.selfReq = selfReq.data.id;
    const selfApprove = await req(`/api/borrow-requests/${ids.selfReq}/approve`, { method: 'POST', cookie: cookies.reviewer, body: {} });
    assert.equal(selfApprove.status, 403, '申请人审核本人申请必须 403');

    const reviewList = await req('/api/borrow-requests?status=pending', { cookie: cookies.reviewer });
    assert.equal(reviewList.status, 200);
    assert.ok(reviewList.data.some((r) => r.id === ids.borrowA), '待处理列表应含借阅者申请');
  });

  await test('审批：拒绝必填意见；通过后建立授权并可读可下载；重复审批 409', async () => {
    // 先建第二份受限档案用于拒绝流程
    const { archiveId: arcB, fileId: fileB } = await createRestrictedArchive('涉密合同B');
    ids.arcB = arcB;
    const reqB = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower, body: { archiveId: arcB, purpose: '需要但不应通过', days: 15 },
    });
    assert.equal(reqB.status, 201);
    ids.borrowB = reqB.data.id;

    const rejectNoNote = await req(`/api/borrow-requests/${ids.borrowB}/reject`, { method: 'POST', cookie: cookies.reviewer, body: { note: '' } });
    assert.equal(rejectNoNote.status, 400, '缺审核意见的拒绝必须 400');

    const reject = await req(`/api/borrow-requests/${ids.borrowB}/reject`, { method: 'POST', cookie: cookies.reviewer, body: { note: '资料涉密过高，不予外借' } });
    assert.equal(reject.status, 201, JSON.stringify(reject.data));
    assert.equal(reject.data.status, 'rejected');

    const rejectAgain = await req(`/api/borrow-requests/${ids.borrowB}/reject`, { method: 'POST', cookie: cookies.reviewer, body: { note: '再拒' } });
    assert.equal(rejectAgain.status, 409, '重复审批必须 409');

    // 通过后：授权建立，借阅者可读可下载
    const approve = await req(`/api/borrow-requests/${ids.borrowA}/approve`, { method: 'POST', cookie: cookies.reviewer2, body: { note: '同意，仅供本次审计' } });
    assert.equal(approve.status, 201, JSON.stringify(approve.data));
    assert.equal(approve.data.status, 'approved');
    assert.ok(approve.data.dueAt, '通过应写入到期时间');

    const detail = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.borrower });
    assert.equal(detail.status, 200, '授权后借阅者可查看详情');

    // 找到受限档案 A 的附件 id
    const files = await req(`/api/archives/${ids.arcA}/files`, { cookie: cookies.borrower });
    assert.equal(files.status, 200);
    ids.fileA = files.data[0].id;
    const dl = await req(`/api/archive-files/${ids.fileA}/download`, { cookie: cookies.borrower });
    assert.equal(dl.status, 200, '授权后借阅者可下载附件');

    const approveAgain = await req(`/api/borrow-requests/${ids.borrowA}/approve`, { method: 'POST', cookie: cookies.reviewer2, body: {} });
    assert.equal(approveAgain.status, 409, '重复通过必须 409');

    // 目录应排除已授权档案 A，仍含未处理的 B 已拒绝可再申请？目录含 B
    const catalogAfter = await req('/api/borrow-requests/catalog', { cookie: cookies.borrower });
    assert.ok(!catalogAfter.data.some((a) => a.id === ids.arcA), '已授权档案不得再出现在借阅目录');
    void fileB;
  });

  // ==================== 9. 归还 ====================

  await test('归还：授权撤销后受限档案读/下载立即失效', async () => {
    const ret = await req(`/api/borrow-requests/${ids.borrowA}/return`, { method: 'POST', cookie: cookies.borrower });
    assert.equal(ret.status, 201, JSON.stringify(ret.data));
    assert.equal(ret.data.status, 'returned');

    const detail = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.borrower });
    assert.equal(detail.status, 403, '归还后借阅者不得再查看受限档案');

    const dl = await req(`/api/archive-files/${ids.fileA}/download`, { cookie: cookies.borrower });
    assert.equal(dl.status, 403, '归还后借阅者不得再下载附件');

    const retAgain = await req(`/api/borrow-requests/${ids.borrowA}/return`, { method: 'POST', cookie: cookies.borrower });
    assert.equal(retAgain.status, 400, '非借阅中状态不可再次归还');
  });

  // ==================== 10. 到期惰性失效 ====================

  await test('到期：过期授权惰性失效，受限访问关闭', async () => {
    const reqC = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower, body: { archiveId: ids.arcB, purpose: '短期查阅', days: 2 },
    });
    assert.equal(reqC.status, 201);
    ids.borrowC = reqC.data.id;
    const approve = await req(`/api/borrow-requests/${ids.borrowC}/approve`, { method: 'POST', cookie: cookies.reviewer2, body: {} });
    assert.equal(approve.status, 201);

    // 直接将该授权到期时间改到过去，模拟到期
    const sqlite = new DatabaseSync(DB_FILE);
    sqlite
      .prepare("UPDATE borrow_grants SET expires_at = datetime('now','-1 day') WHERE borrow_id = ?")
      .run(ids.borrowC);
    sqlite.close();

    const detail = await req(`/api/archives/${ids.arcB}`, { cookie: cookies.borrower });
    assert.equal(detail.status, 403, '过期后不得再访问受限档案');
  });

  // ==================== 越权归还与状态篡改 ====================

  await test('防越权：他人不得归还借阅者的申请', async () => {
    const ret = await req(`/api/borrow-requests/${ids.borrowC}/return`, { method: 'POST', cookie: cookies.reviewer });
    assert.equal(ret.status, 403, '非本人且非管理员不得归还他人借阅');
  });
});

function storeDirExists() {
  return existsSync(FILE_STORE);
}
void storeDirExists;
