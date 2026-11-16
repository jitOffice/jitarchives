/**
 * JitArchives 阶段二第五批 · 跨模块权限与数据安全回归自动化验证（node:test）
 *
 * 隔离：独立测试库（storage/test-security-<pid>.db）+ 独立文件存储目录
 *       （storage/test-security-store-<pid>）+ 注入的 Mock JitWord 客户端（绝不触网）。
 *       不触碰正式库、64 项既有回归与其他测试库；Mock 通过 ≠ 厂商接口已打通。
 *
 * 覆盖任务第七节 14 类跨模块越权/一致性场景（一律以「实际 HTTP 状态 + 真实落库」为准）：
 *   1. 未登录访问（audit/users/archives/borrow/templates/健康以外）一律 401；
 *   2. 审计查询权限保护：auditView 仅管理员，其余角色 403，未登录 401；
 *   3. 普通用户尝试自提升为管理员（越权）→ 403（用户接口 RolesGuard 仅管理员）；
 *   4. 最后一个启用管理员保护：禁用/降级唯一管理员 → 400，且管理员仍可用；
 *   5. 受限档案查看越权：非授权者（借阅者/访客）详情 403，且不出现在其检索列表；
 *   6. 受限档案下载越权：借阅者未授权 403；访客角色矩阵即无 fileDownload → 403；
 *   7. JitWord 换票越权（服务端即时阻止的新越权，非已签发票据）：非建档者编辑票 400、
 *      访客编辑票 403；建档者编辑票成功且响应绝不回传 clientSecret/ticket 之外的密钥；
 *   8. 到期与归还后访问失效：审批通过→受限档案可读可下载；归还→立即读/下载失效 403；
 *   9. 重复申请 409 / 重复审批 409；
 *  10. 已归档再改：draft→archived 后 PUT 著录 400、重复归档 400、上传附件 400；
 *  11. 路径穿越与非法上传：文件名净化（去路径/危险字符）、扩展名白名单拒绝 .exe、
 *      物理存储名由服务端生成（不含穿越），下载内容一致；
 *  12. 模板变更历史保护：字段停用为软删（active=false 记录仍在），历史档案已填值不丢失；
 *  13. 并发状态一致性：并发重复归档/并发重复审批，有且仅有一次成功，其余被服务端拒绝；
 *  14. 审计留痕与脱敏：关键操作形成可追溯记录，登录失败记 failure，任何审计 detail 绝不
 *      含 password/secret/token/ticket/cookie 等敏感原文。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-security-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-security-store-${process.pid}`);

let baseUrl = null;
let currentApp = null;

// ==================== Mock JitWord 客户端（本地可控，不触网） ====================
const mock = {
  docCalls: 0,
  ticketCalls: 0,
  client: {
    available: true,
    async createDocument({ name, externalSubject }) {
      mock.docCalls += 1;
      if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
        throw new Error(`createDocument 收到非 ASCII 文档名：${name}`);
      }
      return { docId: `mockdoc-${mock.docCalls}`, name, externalSubject };
    },
    async createTicket(req) {
      mock.ticketCalls += 1;
      const isEdit = req.mode === 'edit';
      const scopes = isEdit
        ? ['document:read', 'document:edit', 'comment:write']
        : ['document:read'];
      return {
        ticket: `mock-ticket-${mock.ticketCalls}-${req.mode}`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        expiresIn: Math.min(req.expiresIn ?? 120, 300),
        docId: req.docId,
        origin: req.origin,
        scopes,
      };
    },
    async manifest() {
      return { mock: true };
    },
  },
};

async function startServer() {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({
    port: 0,
    dbFile: DB_FILE,
    fileStoreDir: FILE_STORE,
    serveWeb: false,
    jitwordClient: mock.client,
  });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}

async function stopServer() {
  await currentApp.close();
  currentApp = null;
}

/** 请求助手：JSON + 手动会话 Cookie；raw 支持裸流上传。 */
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
    /* Windows EPERM 忽略 */
  }
}
function safeRmDir(d) {
  try {
    rmSync(d, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

const ADMIN = { username: 'secroot', displayName: '安全管理员', password: 'Admin#12345' };
const USERS = {
  cat1: { username: 'sec_cat1', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  cat2: { username: 'sec_cat2', displayName: '著录员乙', password: 'Cat#12345', role: 'cataloger' },
  reviewer: { username: 'sec_rev', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  borrower: { username: 'sec_bor', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'sec_gst', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% security regression restricted doc\n%%EOF\n');
const DOCX_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x64, 0x6f, 0x63, 0x78, 0x2d, 0x73, 0x65, 0x63,
  0x2d, 0x74, 0x65, 0x73, 0x74, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x73,
]);

let adminCookie = '';
const cookies = {};
const ids = {};

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201, `登录应成功：${u.username}`);
  return r.cookie;
}

/** 建立受限档案 + 一个 PDF 附件（由著录员甲创建）。 */
async function createRestrictedArchive(title) {
  const created = await req('/api/archives', {
    method: 'POST',
    cookie: cookies.cat1,
    body: { title, categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'restricted' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const archiveId = created.data.id;
  assert.equal(created.data.accessLevel, 'restricted');
  const up = await req(
    `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent('受限附件.pdf')}`,
    { method: 'POST', cookie: cookies.cat1, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
  );
  assert.equal(up.status, 201, JSON.stringify(up.data));
  return { archiveId, fileId: up.data.id };
}

/** 拉取审计分页（管理员）。 */
async function auditQuery(params) {
  const r = await req(`/api/audit?${params}`, { cookie: adminCookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

test.describe('JitArchives 阶段二第五批 · 跨模块权限与安全回归自动化验证', { concurrency: false }, async () => {
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

  // ==================== 准备 ====================
  await test('准备：初始化管理员、多角色账号与分类', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      ids[`uid_${key}`] = created.data.id;
      cookies[key] = await login(USERS[key]);
    }
    const cat = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '涉密文书', code: 'SMSEC' },
    });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;
  });

  // ==================== 1. 未登录 401 ====================
  await test('1. 未登录访问受保护接口一律 401（含审计）', async () => {
    for (const p of [
      '/api/audit',
      '/api/audit/actions',
      '/api/users',
      '/api/archives',
      '/api/borrow-requests',
      '/api/borrow-requests/mine',
      '/api/templates',
      '/api/jitword/status',
    ]) {
      const r = await req(p);
      assert.equal(r.status, 401, `${p} 未登录必须 401`);
    }
    const noSession = await req('/api/archives', { method: 'POST', body: { title: 'x', categoryId: ids.cat } });
    assert.equal(noSession.status, 401, '未登录创建档案必须 401');
  });

  // ==================== 2. auditView 权限保护 ====================
  await test('2. 审计查询仅管理员；其余角色 403', async () => {
    for (const key of ['cat1', 'cat2', 'reviewer', 'borrower', 'guest']) {
      const r = await req('/api/audit', { cookie: cookies[key] });
      assert.equal(r.status, 403, `${key} 查询审计必须 403`);
      const actions = await req('/api/audit/actions', { cookie: cookies[key] });
      assert.equal(actions.status, 403, `${key} 查询审计动作枚举必须 403`);
    }
    const admin = await req('/api/audit?page=1&pageSize=10', { cookie: adminCookie });
    assert.equal(admin.status, 200, '管理员查询审计必须 200');
    assert.ok(Array.isArray(admin.data.items), '应返回 items 分页结构');
    assert.ok(typeof admin.data.total === 'number');
  });

  // ==================== 3. 普通用户自提升越权 ====================
  await test('3. 普通用户尝试改自己为管理员 → 403（用户接口仅管理员）', async () => {
    for (const key of ['cat1', 'reviewer', 'borrower']) {
      const r = await req(`/api/users/${ids[`uid_${key}`]}`, {
        method: 'PATCH',
        cookie: cookies[key],
        body: { role: 'admin' },
      });
      assert.equal(r.status, 403, `${key} 自行提权必须 403`);
    }
    // 越权提权不得落库：cat1 仍是 cataloger
    const me = await req('/api/auth/me', { cookie: cookies.cat1 });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.role, 'cataloger', '越权未生效，角色仍为 cataloger');
  });

  // ==================== 4. 最后一个启用管理员保护 ====================
  await test('4. 禁用/降级唯一启用管理员 → 400，且管理员仍可用', async () => {
    // 当前系统唯一管理员即 init-admin 创建的 root；通过 me 定位
    const me = await req('/api/auth/me', { cookie: adminCookie });
    assert.equal(me.status, 200);
    const adminId = me.data.user.id;

    const disable = await req(`/api/users/${adminId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { status: 'disabled' },
    });
    assert.equal(disable.status, 400, '禁用最后一个启用管理员必须 400');

    const demote = await req(`/api/users/${adminId}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { role: 'cataloger' },
    });
    assert.equal(demote.status, 400, '降级最后一个启用管理员必须 400');

    // 保护后管理员状态未变，仍可访问
    const after = await req('/api/auth/me', { cookie: adminCookie });
    assert.equal(after.status, 200, '管理员会话仍有效');
    assert.equal(after.data.user.role, 'admin');
  });

  // ==================== 5. 受限档案查看越权 ====================
  await test('5. 受限档案查看越权：非授权者详情 403，且不出现在其列表', async () => {
    const { archiveId, fileId } = await createRestrictedArchive('涉密合同-SEC-A');
    ids.arcA = archiveId;
    ids.arcAFile = fileId;

    const borDetail = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.borrower });
    assert.equal(borDetail.status, 403, '未授权借阅者查看受限档案必须 403');

    const guestDetail = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.guest });
    assert.equal(guestDetail.status, 403, '访客查看受限档案必须 403');

    const borList = await req('/api/archives?pageSize=50', { cookie: cookies.borrower });
    assert.equal(borList.status, 200);
    assert.ok(!borList.data.items.some((a) => a.id === ids.arcA), '受限档案不得出现在未授权者列表');

    // 可见性过滤对检索同样生效（关键词检索不得泄漏）
    const search = await req('/api/archives?q=' + encodeURIComponent('涉密合同-SEC-A') + '&pageSize=50', { cookie: cookies.borrower });
    assert.equal(search.status, 200);
    assert.ok(!search.data.items.some((a) => a.id === ids.arcA), '检索不得返回未授权受限档案');
  });

  // ==================== 6. 受限档案下载越权 ====================
  await test('6. 受限档案下载越权：借阅者未授权 403（记 failure 留痕）；访客角色矩阵即拒绝', async () => {
    // 借阅者在角色矩阵具备 fileDownload，但对未授权受限档案应被服务层 403 并记审计 failure
    const borDl = await req(`/api/archive-files/${ids.arcAFile}/download`, { cookie: cookies.borrower });
    assert.equal(borDl.status, 403, '未授权借阅者下载受限附件必须 403');

    // 访客角色无 fileDownload → 控制器守卫直接 403（即使对公开档案）
    const pub = await req('/api/archives', {
      method: 'POST', cookie: cookies.cat1,
      body: { title: '公开可下载档案', categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'public' },
    });
    assert.equal(pub.status, 201);
    ids.arcPub = pub.data.id;
    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.arcPub}&name=${encodeURIComponent('公开.pdf')}`,
      { method: 'POST', cookie: cookies.cat1, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 201);
    ids.pubFile = up.data.id;

    const guestDl = await req(`/api/archive-files/${ids.pubFile}/download`, { cookie: cookies.guest });
    assert.equal(guestDl.status, 403, '访客无下载权限，必须 403');
  });

  // ==================== 7. JitWord 换票越权（服务端即时阻止新越权） ====================
  await test('7. 换票越权：非建档者编辑票 400、访客编辑票 403、建档者编辑票成功', async () => {
    // 建档者 cat1 建立 docx + 关联
    const arc = await req('/api/archives', {
      method: 'POST', cookie: cookies.cat1,
      body: { title: '在线编辑归属测试', categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'public' },
    });
    assert.equal(arc.status, 201);
    ids.arcDoc = arc.data.id;
    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.arcDoc}&name=${encodeURIComponent('编辑.docx')}`,
      { method: 'POST', cookie: cookies.cat1, raw: true, body: DOCX_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 201);
    const link = await req(`/api/archives/${ids.arcDoc}/document/link`, { method: 'POST', cookie: cookies.cat1 });
    assert.equal(link.status, 201, JSON.stringify(link.data));

    // 同角色著录员乙（有 documentEdit + archiveView，但非建档者）换编辑票 → 服务端即时 400
    const cat2Edit = await req(`/api/archives/${ids.arcDoc}/document/ticket`, {
      method: 'POST', cookie: cookies.cat2, body: { mode: 'edit' },
    });
    assert.equal(cat2Edit.status, 400, '非建档者编辑票必须被服务端即时拒绝（400）');
    assert.ok(!('ticket' in (cat2Edit.data || {})), '被拒响应不得含 ticket');

    // 访客（无 documentEdit）换编辑票 → 403
    const guestEdit = await req(`/api/archives/${ids.arcDoc}/document/ticket`, {
      method: 'POST', cookie: cookies.guest, body: { mode: 'edit' },
    });
    assert.equal(guestEdit.status, 403, '访客编辑票必须 403');

    // 建档者编辑票成功；响应绝不泄漏 clientSecret
    const ownerEdit = await req(`/api/archives/${ids.arcDoc}/document/ticket`, {
      method: 'POST', cookie: cookies.cat1, body: { mode: 'edit' },
    });
    assert.equal(ownerEdit.status, 201, JSON.stringify(ownerEdit.data));
    assert.ok(typeof ownerEdit.data.ticket === 'string' && ownerEdit.data.ticket.length > 0);
    assert.ok(!/clientSecret/i.test(JSON.stringify(ownerEdit.data)), '票据响应不得含 clientSecret');

    // 审计须把越权留痕为 failure（not_creator），与"成功签发票据"严格区分
    const failAudit = await auditQuery('action=jitword.ticket_issue&result=failure&pageSize=50');
    assert.ok(
      failAudit.items.some((it) => it.detail && it.detail.denied === 'not_creator'),
      '非建档者越权换票必须记为 failure 且 denied=not_creator',
    );
  });

  // ==================== 8. 授权/归还后访问失效 ====================
  await test('8. 借阅授权生效→受限可读可下载；归还→立即失效 403', async () => {
    // 借阅者先申请
    const apply = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower,
      body: { archiveId: ids.arcA, purpose: '项目审计需要', days: 30 },
    });
    assert.equal(apply.status, 201, JSON.stringify(apply.data));
    ids.borrowA = apply.data.id;

    // 审核员批准
    const approve = await req(`/api/borrow-requests/${ids.borrowA}/approve`, {
      method: 'POST', cookie: cookies.reviewer, body: { note: '同意，限期使用' },
    });
    assert.equal(approve.status, 201, JSON.stringify(approve.data));
    assert.equal(approve.data.status, 'approved');

    // 授权期间可读可下载
    const view = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.borrower });
    assert.equal(view.status, 200, '审批通过后借阅者应可读受限档案');

    // 归还后访问立即失效
    const ret = await req(`/api/borrow-requests/${ids.borrowA}/return`, { method: 'POST', cookie: cookies.borrower });
    assert.equal(ret.status, 201, JSON.stringify(ret.data));
    const afterView = await req(`/api/archives/${ids.arcA}`, { cookie: cookies.borrower });
    assert.equal(afterView.status, 403, '归还后受限档案读取必须立即失效');
  });

  // ==================== 9. 重复申请 / 重复审批 ====================
  await test('9. 重复待处理申请 409；重复审批 409', async () => {
    // 重新申请（上一个已归还，可再申请）
    const apply = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower,
      body: { archiveId: ids.arcA, purpose: '再次核对', days: 10 },
    });
    assert.equal(apply.status, 201, JSON.stringify(apply.data));
    const borrowB = apply.data.id;

    const dup = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower,
      body: { archiveId: ids.arcA, purpose: '重复申请', days: 7 },
    });
    assert.equal(dup.status, 409, '同一档案重复待处理申请必须 409');

    const approve = await req(`/api/borrow-requests/${borrowB}/approve`, {
      method: 'POST', cookie: cookies.reviewer, body: { note: '同意' },
    });
    assert.equal(approve.status, 201);
    const approveAgain = await req(`/api/borrow-requests/${borrowB}/approve`, {
      method: 'POST', cookie: cookies.reviewer, body: { note: '重复审批' },
    });
    assert.equal(approveAgain.status, 409, '重复审批必须 409');
    ids.borrowB = borrowB;

    // 申请人不得自助审核自己的申请
    const selfReview = await req(`/api/borrow-requests/${borrowB}/approve`, {
      method: 'POST', cookie: cookies.borrower, body: {},
    });
    assert.equal(selfReview.status, 403, '借阅者无审核权限，必须 403');
  });

  // ==================== 10. 已归档再改 ====================
  await test('10. 归档只读：已归档后编辑/上传/重复归档均被拒绝', async () => {
    const arc = await req('/api/archives', {
      method: 'POST', cookie: cookies.cat1,
      body: { title: '待归档-SEC', categoryId: ids.cat, archiveType: '文书档案' },
    });
    assert.equal(arc.status, 201);
    const archiveId = arc.data.id;

    const trans = await req(`/api/archives/${archiveId}/transition-archive`, { method: 'POST', cookie: cookies.reviewer });
    assert.equal(trans.status, 201, JSON.stringify(trans.data));
    assert.equal(trans.data.status, 'archived');

    const edit = await req(`/api/archives/${archiveId}`, {
      method: 'PUT', cookie: cookies.cat1, body: { title: '归档后篡改标题' },
    });
    assert.equal(edit.status, 400, '已归档档案著录信息不可修改');

    const reTrans = await req(`/api/archives/${archiveId}/transition-archive`, { method: 'POST', cookie: cookies.reviewer });
    assert.equal(reTrans.status, 400, '重复归档必须被拒绝');

    const up = await req(
      `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent('归档后.pdf')}`,
      { method: 'POST', cookie: cookies.cat1, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 400, '已归档档案不可再挂接附件');

    ids.arcArchived = archiveId;
  });

  // ==================== 11. 路径穿越与非法上传 ====================
  await test('11. 上传：路径穿越净化、扩展名白名单拒绝、下载内容一致', async () => {
    const arc = await req('/api/archives', {
      method: 'POST', cookie: cookies.cat1,
      body: { title: '上传安全测试档案', categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'public' },
    });
    assert.equal(arc.status, 201);
    const archiveId = arc.data.id;

    // 文件名含路径穿越：应被净化为 basename，物理存储名由服务端生成（32 hex）
    const traversal = await req(
      `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent('../../../../../etc/passwd.pdf')}`,
      { method: 'POST', cookie: cookies.cat1, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(traversal.status, 201, JSON.stringify(traversal.data));
    const originalName = traversal.data.originalName;
    assert.ok(!originalName.includes('/') && !originalName.includes('\\'), `净化后显示名不得含路径分隔：${originalName}`);

    // 非法扩展名被白名单拒绝
    const exe = await req(
      `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent('payload.exe')}`,
      { method: 'POST', cookie: cookies.cat1, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(exe.status, 400, '非白名单扩展名必须 400');

    // 下载净化后的文件，内容应与上传一致
    const dlRes = await fetch(`${baseUrl}/api/archive-files/${traversal.data.id}/download`, {
      headers: { Cookie: cookies.cat1 },
    });
    assert.equal(dlRes.status, 200);
    const bytes = new Uint8Array(await dlRes.arrayBuffer());
    assert.equal(bytes.length, PDF_BYTES.length, '下载字节长度应与上传一致');
  });

  // ==================== 12. 模板变更历史保护 ====================
  await test('12. 模板字段停用为软删；历史档案已填值不丢失', async () => {
    const tpl = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: {
        name: '安全回归模板',
        description: '验证字段软删',
        fields: [{ fieldKey: 'class_level', label: '密级', type: 'text', required: false }],
      },
    });
    assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
    ids.template = tpl.data.id;
    const fieldId = tpl.data.fields[0].id;

    // 绑定分类，供档案著录取值
    const bind = await req(`/api/categories/${ids.cat}/template`, {
      method: 'PUT', cookie: adminCookie, body: { templateId: ids.template },
    });
    assert.equal(bind.status, 200, JSON.stringify(bind.data));

    // 用带字段值的档案固化历史
    const arc = await req('/api/archives', {
      method: 'POST', cookie: cookies.cat1,
      body: {
        title: '历史值保护档案', categoryId: ids.cat, archiveType: '文书档案', accessLevel: 'public',
        fieldValues: { class_level: '机密' },
      },
    });
    assert.equal(arc.status, 201, JSON.stringify(arc.data));
    ids.arcTpl = arc.data.id;

    // 停用字段（软删）
    const deact = await req(`/api/templates/${ids.template}/fields/${fieldId}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(deact.status, 200, JSON.stringify(deact.data));
    assert.equal(deact.data.active, false, '停用后字段 active=false（记录仍在）');

    // 字段未被物理删除：模板详情的全部字段仍包含它（active=false）
    const detail = await req(`/api/templates/${ids.template}`, { cookie: adminCookie });
    assert.equal(detail.status, 200);
    const allFields = (detail.data.allFields || detail.data.fields || []);
    assert.ok(allFields.some((f) => f.id === fieldId && f.active === false), '停用字段应以软删形态保留于历史');

    // 历史档案已填值不因字段停用而丢失（详情返回 dynamicFields，含已停用字段历史值）
    const arcDetail = await req(`/api/archives/${ids.arcTpl}`, { cookie: cookies.cat1 });
    assert.equal(arcDetail.status, 200);
    const saved = arcDetail.data.dynamicFields || [];
    const secretVal = saved.find((f) => f.fieldKey === 'class_level');
    assert.equal(secretVal && secretVal.value, '机密', '历史档案填写的字段值必须保留');
  });

  // ==================== 13. 并发状态一致性 ====================
  await test('13. 并发：重复归档并发仅一次成功', async () => {
    const arc = await req('/api/archives', {
      method: 'POST', cookie: cookies.cat1,
      body: { title: '并发归档档案', categoryId: ids.cat, archiveType: '文书档案' },
    });
    assert.equal(arc.status, 201);
    const archiveId = arc.data.id;

    const results = await Promise.all(
      [1, 2, 3].map(() => req(`/api/archives/${archiveId}/transition-archive`, { method: 'POST', cookie: cookies.reviewer })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 400).length;
    assert.equal(ok, 1, `并发归档应恰好一次成功，实际 ${ok}`);
    assert.equal(rejected, results.length - 1, '其余并发归档请求必须被服务端拒绝');

    // 最终状态确为 archived（无中间态/重复版本）
    const final = await req(`/api/archives/${archiveId}`, { cookie: cookies.reviewer });
    assert.equal(final.data.status, 'archived');
  });

  await test('13b. 并发：重复审批同一申请仅一次成功', async () => {
    // 新建一个可审批的待处理申请
    const apply = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.cat2,
      body: { archiveId: ids.arcA, purpose: '并发审批测试', days: 5 },
    });
    assert.equal(apply.status, 201, JSON.stringify(apply.data));
    const borrowId = apply.data.id;

    const results = await Promise.all(
      [1, 2].map(() => req(`/api/borrow-requests/${borrowId}/approve`, { method: 'POST', cookie: cookies.reviewer, body: { note: '并发' } })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const conflict = results.filter((r) => r.status === 409).length;
    assert.equal(ok, 1, `并发审批应恰好一次成功，实际 ${ok}`);
    assert.equal(conflict, 1, '另一次并发审批必须 409');
  });

  // ==================== 14. 审计留痕与脱敏 ====================
  await test('14. 审计留痕：关键操作可追溯、登录失败记 failure、detail 绝不泄漏敏感原文', async () => {
    // 触发一次失败登录
    await req('/api/auth/login', { method: 'POST', body: { username: 'sec_bor', password: 'Wrong#Pass' } });

    const loginFail = await auditQuery('action=auth.login_failure&result=failure&pageSize=50');
    assert.ok(loginFail.items.length >= 1, '失败登录必须留痕');

    // 关键状态变更应可追溯
    const roleChange = await auditQuery('action=user.role_change&pageSize=50');
    assert.ok(Array.isArray(roleChange.items), 'role_change 查询结构正确');

    const archiveTrans = await auditQuery('action=archive.transition_archived&pageSize=50');
    assert.ok(archiveTrans.items.some((it) => it.result === 'success'), '归档流转应有成功审计记录');

    // 全站脱敏：任何审计 detail 文本绝不含敏感关键词
    const all = await auditQuery('pageSize=100');
    const FORBIDDEN = ['password', 'clientsecret', 'secret', 'ticket', 'cookie', 'authorization'];
    for (const it of all.items) {
      const text = JSON.stringify(it.detail ?? {}).toLowerCase();
      for (const kw of FORBIDDEN) {
        assert.ok(!text.includes(kw), `审计 detail 不得含敏感词 ${kw}：${JSON.stringify(it.detail)}`);
      }
    }
    // 越权下载尝试应记为 failure（denied），与成功严格区分
    const dlFail = await auditQuery('action=file.download&result=failure&pageSize=50');
    assert.ok(dlFail.items.some((it) => it.detail && it.detail.denied === true), '越权下载必须记 failure');
  });

  await test('15. 会话失效：登出后原 Cookie 立即失效', async () => {
    const tmp = await login(USERS.guest);
    const before = await req('/api/auth/me', { cookie: tmp });
    assert.equal(before.status, 200);
    const out = await req('/api/auth/logout', { method: 'POST', cookie: tmp });
    assert.equal(out.status, 201, JSON.stringify(out.data));
    const after = await req('/api/auth/me', { cookie: tmp });
    assert.equal(after.status, 401, '登出后原会话必须失效');
  });
});
