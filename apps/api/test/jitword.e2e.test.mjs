/**
 * JitArchives 阶段二第三批 · JitWord 在线编辑与归档集成后端自动化验证（node:test）
 *
 * 隔离：独立测试库（storage/test-jitword-<pid>.db）+ 独立文件存储目录
 *       （storage/test-jitword-store-<pid>）+ 注入的 Mock JitWord 客户端（绝不触网）。
 *
 * 明确区分：本文件仅覆盖「不依赖真实厂商服务」的部分（关联/票据/入库/权限/迁移/补偿）。
 * 真实 JitWord 服务测试单列 tools/jitword-live-probe.mjs（有密钥时手动运行，不进 CI）。
 * Mock 通过 ≠ 厂商接口已打通。
 *
 * 覆盖项（对应计划 12 类）：
 *  1. 未登录访问文档/票据/状态接口一律 401；
 *  2. 状态接口 available 与公开参数，且响应不含 clientSecret；
 *  3. 关联建立（幂等，ASCII 文档名，失败不落错误 docId）；
 *  4. 重复 link 不重复创建远端文档；
 *  5. 编辑/只读票据 scopes 正确、TTL≤300、票据不含密钥；
 *  6. 非建档者编辑被拒、只读放行（按创建者归属模型）；
 *  7. saved 状态回调（不代表入库）；
 *  8. 版本入库持久化（SHA-256/size/origin/来源人）+ 物理文件真实落盘；
 *  9. 多次入库版本自增不覆盖历史；非 docx 入库拒绝且不留物理残件；
 * 10. 归档门禁：接入在线编辑但无版本 → 拒绝归档；入库后归档成功 → 编辑票停用（只读票仍可）；
 * 11. 仅 PDF 档案 link 明确拒绝；中文/越权场景安全；
 * 12. 禁用用户换票 401；借阅者 link/编辑票 403、只读票 200；
 * 13. seed 返回源 DOCX 真实字节（非演示固定文件）；
 * 14. 迁移 003 增量建表 + 重启保留既有档案/附件/关联/版本（兼容旧库）。
 * 运行：npm test（需先 npm run build）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import PizZip from 'pizzip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-jitword-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-jitword-store-${process.pid}`);

let baseUrl = null;
let currentApp = null;

// ==================== Mock JitWord 客户端（本地可控，不触网） ====================
const mock = {
  docCalls: 0,
  ticketCalls: 0,
  lastCreate: null,
  client: {
    available: true,
    async createDocument({ name, externalSubject }) {
      mock.docCalls += 1;
      mock.lastCreate = { name, externalSubject };
      // 文档名必须为 ASCII（规避阶段一中文导出 500）
      if (!/^[A-Za-z0-9_.\-]+$/.test(name)) {
        throw new Error(`createDocument 收到非 ASCII 文档名：${name}`);
      }
      return { docId: `mockdoc-${mock.docCalls}`, name };
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
    jitwordClient: mock.client, // 注入桩实现，避免真实触网
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

async function fetchBytes(pathname, cookie, method = 'GET') {
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: cookie ? { Cookie: cookie } : {},
  });
  return { status: res.status, buf: new Uint8Array(await res.arrayBuffer()) };
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
function listStoreFiles() {
  return existsSync(FILE_STORE) ? readdirSync(FILE_STORE) : [];
}

/** 审计展示文本（时间片段以占位符表示，避免测试依赖运行环境时区）。 */
function auditPlain(item) {
  return item.summary.map((p) => (p.kind === 'time' ? '<时间>' : p.text)).join('');
}

const ADMIN = { username: 'jroot', displayName: '总管理员', password: 'Admin#12345' };
const USERS = {
  cat1: { username: 'cat_one', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  cat2: { username: 'cat_two', displayName: '著录员乙', password: 'Cat#12345', role: 'cataloger' },
  reviewer: { username: 'rev_one', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  borrower: { username: 'bor_one', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'gst_one', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

const DOCX_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x64, 0x6f, 0x63, 0x78, 0x2d, 0x6a, 0x69, 0x74,
  0x77, 0x6f, 0x72, 0x64, 0x2d, 0x74, 0x65, 0x73, 0x74, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x73,
]);
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% 仅 PDF 档案，用于不支持在线编辑的拒绝用例\n%%EOF\n');
/** 真实旧版 .doc 样本（Apache POI 测试数据），用于验证服务端转换后导入 DOCX。 */
const DOC_BYTES = readFileSync(path.join(__dirname, 'fixtures', 'sample.doc'));

let adminCookie = '';
const cookies = {};
const ids = {};

async function login(user) {
  const r = await req('/api/auth/login', { method: 'POST', body: user });
  assert.equal(r.status, 201, `登录应成功：${user.username}`);
  return r.cookie;
}

async function createArchive(cookie, title) {
  const r = await req('/api/archives', {
    method: 'POST',
    cookie,
    body: { title, categoryId: ids.cat, archiveType: '文书档案' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

async function uploadBytes(cookie, archiveId, name, bytes) {
  const r = await req(
    `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      cookie,
      raw: true,
      body: bytes,
      headers: { 'Content-Type': 'application/octet-stream' },
    },
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}

async function uploadDocx(cookie, archiveId, name = '合同.docx') {
  return uploadBytes(cookie, archiveId, name, DOCX_BYTES);
}

test.describe('JitArchives 阶段二第三批 · JitWord 集成自动化验证', { concurrency: false }, async () => {
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
      body: { name: '文书档案', code: 'WS', description: '第三批测试' },
    });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;
  });

  // ==================== 1. 未登录 401 ====================
  await test('未登录访问状态/文档/票据接口一律 401', async () => {
    for (const p of [
      '/api/jitword/status',
      '/api/archives/1/document',
      '/api/archives/1/versions',
    ]) {
      const r = await req(p);
      assert.equal(r.status, 401, `${p} 未登录必须 401`);
    }
    const ticket = await req('/api/archives/1/document/ticket', { method: 'POST', body: { mode: 'view' } });
    assert.equal(ticket.status, 401, '未登录换票必须 401');
  });

  // ==================== 2. 状态接口安全 ====================
  await test('状态接口 available 且响应绝不包含 clientSecret', async () => {
    const r = await req('/api/jitword/status', { cookie: cookies.cat1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.available, true, '注入桩客户端应视为已接入');
    assert.ok(typeof r.data.loaderUrl === 'string' && r.data.loaderUrl.includes('loader'), '应提供 loader 地址');
    assert.ok(!('clientSecret' in r.data), '响应不得含 clientSecret 字段');
    const raw = JSON.stringify(r.data);
    assert.ok(!/clientSecret/i.test(raw), '响应文本不得出现 clientSecret');
    assert.equal(r.data.origin, baseUrl, '状态接口应回显本次请求解析出的票据 origin');
    // 模块桩未实现 exportDocument → 自动入库能力必须如实报告为不可用
    assert.equal(r.data.autoExportAvailable, false, '未开放导出字节回传时 autoExportAvailable 必须为 false');
  });

  // ==================== 3/4. 关联建立与幂等 ====================
  await test('关联：DOCX 档案建立关联，返回真实 docId 与 ASCII 文档名', async () => {
    ids.archiveMain = await createArchive(cookies.cat1, '在线编辑主测试档案');
    ids.fileMain = await uploadDocx(cookies.cat1, ids.archiveMain);

    const before = mock.docCalls;
    const link = await req(`/api/archives/${ids.archiveMain}/document/link`, {
      method: 'POST',
      cookie: cookies.cat1,
    });
    assert.equal(link.status, 201, JSON.stringify(link.data));
    assert.ok(link.data.docId, '应返回远端 docId');
    assert.equal(link.data.editState, 'linked');
    assert.equal(link.data.canEdit, true, '建档者本人可编辑');
    assert.equal(link.data.seededAt, null, '刚建立关联时尚未导入正文');
    assert.match(link.data.docName, /^[A-Za-z0-9_.\-]+$/, '文档名必须 ASCII');
    assert.equal(mock.docCalls, before + 1, '应创建一次远端文档');
    ids.docMain = link.data;
  });

  await test('关联：重复 link 幂等，不重复创建远端文档', async () => {
    const before = mock.docCalls;
    const again = await req(`/api/archives/${ids.archiveMain}/document/link`, {
      method: 'POST',
      cookie: cookies.cat1,
    });
    assert.equal(again.status, 201);
    assert.equal(again.data.docId, ids.docMain.docId, '重复点击返回既有 docId');
    assert.equal(mock.docCalls, before, '重复 link 不得再创建远端文档');
  });

  await test('关联：仅 PDF 档案拒绝建立在线编辑关联', async () => {
    const pdfArchive = await createArchive(cookies.cat1, '仅PDF档案');
    await req(`/api/archive-files/upload?archiveId=${pdfArchive}&name=${encodeURIComponent('扫描.pdf')}`, {
      method: 'POST',
      cookie: cookies.cat1,
      raw: true,
      body: PDF_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    const link = await req(`/api/archives/${pdfArchive}/document/link`, { method: 'POST', cookie: cookies.cat1 });
    assert.equal(link.status, 400, '非 DOCX 必须拒绝');
    assert.match(String(link.data.message), /DOCX|docx/);
    // 未落库错误 docId
    const doc = await req(`/api/archives/${pdfArchive}/document`, { cookie: cookies.cat1 });
    assert.equal(doc.data, null, '失败后不得存在关联记录');
  });

  // ==================== 多文件选择 + 旧版 DOC 转换 ====================
  await test('多文件：同一档案的多个 DOC/DOCX 可分别关联，按 fileId 定位与转换', async () => {
    const multiArchive = await createArchive(cookies.cat1, '多文件在线编辑档案');
    const firstDocx = await uploadDocx(cookies.cat1, multiArchive, '甲.docx');
    const legacyDoc = await uploadBytes(cookies.cat1, multiArchive, '乙.doc', DOC_BYTES);
    const secondDocx = await uploadDocx(cookies.cat1, multiArchive, '丙.docx');

    const linkDocx = await req(`/api/archives/${multiArchive}/document/link`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { fileId: firstDocx },
    });
    assert.equal(linkDocx.status, 201, JSON.stringify(linkDocx.data));
    assert.equal(linkDocx.data.sourceFileId, firstDocx);
    assert.equal(linkDocx.data.sourceExtension, 'docx');

    const linkDoc = await req(`/api/archives/${multiArchive}/document/link`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { fileId: legacyDoc },
    });
    assert.equal(linkDoc.status, 201, JSON.stringify(linkDoc.data));
    assert.equal(linkDoc.data.sourceFileId, legacyDoc);
    assert.equal(linkDoc.data.sourceExtension, 'doc');
    assert.notEqual(linkDoc.data.docId, linkDocx.data.docId, '不同源附件应建立各自独立的远端文档');

    // 同一文件重复 link 幂等
    const again = await req(`/api/archives/${multiArchive}/document/link`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { fileId: legacyDoc },
    });
    assert.equal(again.status, 201);
    assert.equal(again.data.id, linkDoc.data.id, '同一源附件重复关联不得新建记录');

    // 列表与按 fileId 精确定位
    const list = await req(`/api/archives/${multiArchive}/documents`, { cookie: cookies.cat1 });
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 2, '两个源附件应各有一条关联');
    assert.deepEqual(
      list.data.map((item) => item.sourceFileId).sort((a, b) => a - b),
      [firstDocx, legacyDoc].sort((a, b) => a - b),
    );
    const byFile = await req(`/api/archives/${multiArchive}/document?fileId=${legacyDoc}`, {
      cookie: cookies.cat1,
    });
    assert.equal(byFile.status, 200);
    assert.equal(byFile.data.docId, linkDoc.data.docId);

    // 编辑票必须落到所选文档
    const ticket = await req(`/api/archives/${multiArchive}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { mode: 'edit', fileId: legacyDoc },
    });
    assert.equal(ticket.status, 201, JSON.stringify(ticket.data));
    assert.equal(ticket.data.docId, linkDoc.data.docId);
    assert.ok(ticket.data.scopes.includes('document:edit'));

    // .doc 的 seed 必须返回转换后的真实 DOCX（PK 开头且含主文档部件）
    const seeded = await fetchBytes(
      `/api/archives/${multiArchive}/document/seed?fileId=${legacyDoc}`,
      cookies.cat1,
      'POST',
    );
    assert.equal(seeded.status, 200);
    assert.equal(seeded.buf[0], 0x50);
    assert.equal(seeded.buf[1], 0x4b);
    const zip = new PizZip(Buffer.from(seeded.buf));
    assert.ok(zip.file('word/document.xml'), '转换结果必须是可导入的 DOCX');
    assert.match(zip.file('word/document.xml').asText(), /test document/i);

    // 版本入库可归属到 .doc 源附件，正文索引版本号随之落到该文件
    const version = await req(
      `/api/archives/${multiArchive}/versions?fileId=${legacyDoc}&name=${encodeURIComponent('乙-在线编辑.docx')}`,
      {
        method: 'POST',
        cookie: cookies.cat1,
        raw: true,
        body: DOCX_BYTES,
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    );
    assert.equal(version.status, 201, JSON.stringify(version.data));
    assert.equal(version.data.versionNo, 1);
    const status = await req(`/api/archives/${multiArchive}/content/status`, { cookie: cookies.cat1 });
    assert.equal(status.status, 200);
    assert.equal(
      status.data.files.find((item) => item.fileId === legacyDoc)?.versionNo,
      1,
      '.doc 源附件的最新版本应指向新入库的 DOCX 版本',
    );

    // 未建立关联的第三个文件不能直接按 fileId 定位
    const unlinked = await req(`/api/archives/${multiArchive}/document?fileId=${secondDocx}`, {
      cookie: cookies.cat1,
    });
    assert.equal(unlinked.status, 200);
    assert.equal(unlinked.data, null);
  });

  // ==================== seed：真实正文字节 ====================
  await test('seed：返回源 DOCX 真实字节（非演示固定文件）', async () => {
    const got = await fetchBytes(`/api/archives/${ids.archiveMain}/document/seed`, cookies.cat1, 'POST');
    assert.equal(got.status, 200);
    assert.equal(got.buf.byteLength, DOCX_BYTES.byteLength, 'seed 字节大小应与上传附件一致');
    assert.ok(Buffer.compare(Buffer.from(got.buf), Buffer.from(DOCX_BYTES)) === 0, 'seed 内容应与源附件一致');
  });

  // ==================== seed 标记：导入正文的事实记录 ====================
  await test('seed 标记：非建档者 400；建档者写入时间且可重复标记', async () => {
    const denied = await req(`/api/archives/${ids.archiveMain}/document/seeded`, {
      method: 'POST',
      cookie: cookies.cat2,
    });
    assert.equal(denied.status, 400, JSON.stringify(denied.data));
    const stillNull = await req(`/api/archives/${ids.archiveMain}/document`, { cookie: cookies.cat1 });
    assert.equal(stillNull.data.seededAt, null, '被拒后不得写入导入标记');

    const ok = await req(`/api/archives/${ids.archiveMain}/document/seeded`, {
      method: 'POST',
      cookie: cookies.cat1,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.ok(ok.data.seededAt, '建档者导入成功后应记录导入时间');
    assert.ok(!Number.isNaN(Date.parse(ok.data.seededAt)), '导入时间应为可解析时间');
    assert.equal(ok.data.editState, 'linked', '导入正文不等于保存，不得推进保存态');

    // 手动重导可重复标记（幂等语义：每次成功导入覆盖为最新时间）
    const again = await req(`/api/archives/${ids.archiveMain}/document/seeded`, {
      method: 'POST',
      cookie: cookies.cat1,
    });
    assert.equal(again.status, 201, JSON.stringify(again.data));
    assert.ok(Date.parse(again.data.seededAt) >= Date.parse(ok.data.seededAt), '重复导入应更新为最新时间');

    // 审计留痕（导入与保存、入库严格区分）
    const audit = await req('/api/audit?pageSize=50', { cookie: adminCookie });
    assert.equal(audit.status, 200);
    const seedEvents = audit.data.items.filter((it) => it.action === 'jitword.doc_seed');
    assert.ok(seedEvents.length >= 2, '应有导入正文的审计记录');
    assert.equal(seedEvents[0].actionLabel, '导入附件正文');
  });

  // ==================== 5. 票据 ====================
  await test('票据：编辑票含 document:edit、只读票仅 read，TTL≤300，不含密钥', async () => {
    const edit = await req(`/api/archives/${ids.archiveMain}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { mode: 'edit' },
    });
    assert.equal(edit.status, 201, JSON.stringify(edit.data));
    assert.ok(Array.isArray(edit.data.scopes) && edit.data.scopes.includes('document:edit'), '编辑票应含编辑 scope');
    assert.ok(edit.data.expiresIn <= 300, 'TTL 不得超 300s');
    assert.ok(!('clientSecret' in edit.data), '票据响应不得含密钥');
    assert.ok(edit.data.ticket, '应返回票据字符串');
    assert.equal(edit.data.origin, baseUrl, '票据 origin 必须取自当次请求地址（不得用固定常量）');

    const view = await req(`/api/archives/${ids.archiveMain}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { mode: 'view' },
    });
    assert.equal(view.status, 201);
    assert.deepEqual(view.data.scopes, ['document:read'], '只读票仅 read scope');
    assert.equal(view.data.origin, baseUrl, '只读票 origin 同样随请求地址解析');
  });

  // ==================== 6. 非建档者 ====================
  await test('归属：非建档者编辑票被拒、只读票放行', async () => {
    const edit = await req(`/api/archives/${ids.archiveMain}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat2,
      body: { mode: 'edit' },
    });
    assert.equal(edit.status, 400, '非建档者索取编辑票必须被拒（绝不借用他人身份）');
    assert.match(String(edit.data.message), /建档者|归属|限制/);

    const view = await req(`/api/archives/${ids.archiveMain}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat2,
      body: { mode: 'view' },
    });
    assert.equal(view.status, 201, '有查看权限者可取只读票');
  });

  // ==================== 7. saved 回调 ====================
  await test('saved：编辑器保存回调更新状态与时间（不等于入库）', async () => {
    const r = await req(`/api/archives/${ids.archiveMain}/document/saved`, { method: 'POST', cookie: cookies.cat1 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.editState, 'saved');
    assert.ok(r.data.lastSavedAt, '应记录最近保存时间');
  });

  // ==================== 7.1 自动入库未开放时如实拒绝 ====================
  await test('自动入库：厂商未开放导出字节回传 → 503 且不产生空版本', async () => {
    const before = (await req(`/api/archives/${ids.archiveMain}/versions`, { cookie: cookies.cat1 })).data.length;
    const r = await req(`/api/archives/${ids.archiveMain}/document/sync`, { method: 'POST', cookie: cookies.cat1 });
    assert.equal(r.status, 503, JSON.stringify(r.data));
    assert.match(String(r.data.message), /导出字节|自动入库/);
    const after = (await req(`/api/archives/${ids.archiveMain}/versions`, { cookie: cookies.cat1 })).data.length;
    assert.equal(after, before, '能力未开放时绝不生成空版本');
  });

  await test('自动入库：非建档者调用不再被归属拦截（编辑权限由票据签发层保证），能力未开放时返回 503', async () => {
    const r = await req(`/api/archives/${ids.archiveMain}/document/sync`, { method: 'POST', cookie: cookies.cat2 });
    assert.equal(r.status, 503, JSON.stringify(r.data));
    assert.match(String(r.data.message), /导出字节|自动入库/);
  });

  // ==================== 8/9. 版本入库 ====================
  await test('入库：回传 DOCX 形成版本 v1，SHA/size/来源/入库人正确且物理落盘', async () => {
    const before = listStoreFiles().length;
    const up = await req(`/api/archives/${ids.archiveMain}/versions?name=${encodeURIComponent('在线编辑导出.docx')}`, {
      method: 'POST',
      cookie: cookies.cat1,
      raw: true,
      body: DOCX_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.versionNo, 1);
    assert.match(up.data.sha256, /^[0-9a-f]{64}$/, '应为 SHA-256');
    assert.equal(up.data.fileSize, DOCX_BYTES.byteLength);
    assert.equal(up.data.origin, 'jitword_export_reupload');
    assert.equal(up.data.originLabel, '在线编辑回传入库');
    assert.equal(up.data.createdByName, USERS.cat1.displayName);
    ids.version1 = up.data;

    // 物理文件真实落盘且一致性（版本行数 == store 新增文件）
    const files = listStoreFiles();
    assert.equal(files.length, before + 1, '入库应新增且仅新增一个物理文件');
    assert.ok(files.some((f) => /^[0-9a-f]{32}\.docx$/.test(f)), '受控目录内应有 32hex .docx 物理文件');

    const list = await req(`/api/archives/${ids.archiveMain}/versions`, { cookie: cookies.cat1 });
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 1);
  });

  await test('入库：再次回传版本自增为 v2，不覆盖历史 v1', async () => {
    const up = await req(`/api/archives/${ids.archiveMain}/versions?name=${encodeURIComponent('再编辑.docx')}`, {
      method: 'POST',
      cookie: cookies.cat1,
      raw: true,
      body: DOCX_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(up.status, 201);
    assert.equal(up.data.versionNo, 2, '版本号应自增');

    const list = await req(`/api/archives/${ids.archiveMain}/versions`, { cookie: cookies.cat1 });
    assert.equal(list.data.length, 2, '历史版本不被覆盖');
    assert.deepEqual(list.data.map((v) => v.versionNo).sort(), [1, 2]);
  });

  await test('入库：非 DOCX 回传被拒且不留物理文件', async () => {
    const before = listStoreFiles().length;
    const up = await req(`/api/archives/${ids.archiveMain}/versions?name=${encodeURIComponent('伪造.pdf')}`, {
      method: 'POST',
      cookie: cookies.cat1,
      raw: true,
      body: PDF_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(up.status, 400, '非 docx 入库必须拒绝');
    assert.match(String(up.data.message), /docx/);
    assert.equal(listStoreFiles().length, before, '拒绝入库不得留下物理文件');
  });

  // ==================== 10. 归档门禁 + 只读 ====================
  await test('归档门禁：接入在线编辑但无版本 → 拒绝归档', async () => {
    ids.archiveGate = await createArchive(cookies.cat1, '归档门禁测试档案');
    await uploadDocx(cookies.cat1, ids.archiveGate, '待归档.docx');
    const link = await req(`/api/archives/${ids.archiveGate}/document/link`, { method: 'POST', cookie: cookies.cat1 });
    assert.equal(link.status, 201);

    const bad = await req(`/api/archives/${ids.archiveGate}/transition-archive`, {
      method: 'POST',
      cookie: cookies.reviewer,
    });
    assert.equal(bad.status, 400, '无入库版本不得归档（避免 DB 已归档但文件缺失）');
    assert.match(String(bad.data.message), /版本|入库|回传/);
  });

  await test('归档：主档案入库版本后归档成功 → 编辑票停用、只读票仍可', async () => {
    const ok = await req(`/api/archives/${ids.archiveMain}/transition-archive`, {
      method: 'POST',
      cookie: cookies.reviewer,
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.status, 'archived');

    const edit = await req(`/api/archives/${ids.archiveMain}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { mode: 'edit' },
    });
    assert.equal(edit.status, 400, '已归档档案拒绝签发编辑票');

    const view = await req(`/api/archives/${ids.archiveMain}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat1,
      body: { mode: 'view' },
    });
    assert.equal(view.status, 201, '已归档仍可只读预览');

    // 归档后不得再加接新版本
    const vUp = await req(`/api/archives/${ids.archiveMain}/versions?name=x.docx`, {
      method: 'POST',
      cookie: cookies.cat1,
      raw: true,
      body: DOCX_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(vUp.status, 400, '已归档禁止新版本入库');
  });

  // ==================== 12. 权限与禁用 ====================
  await test('权限：借阅者 link/编辑票 403、只读票 200；访客同样无编辑权', async () => {
    const link = await req(`/api/archives/${ids.archiveGate}/document/link`, { method: 'POST', cookie: cookies.borrower });
    assert.equal(link.status, 403, '借阅者无 documentEdit，link 必须 403');

    const edit = await req(`/api/archives/${ids.archiveGate}/document/ticket`, {
      method: 'POST',
      cookie: cookies.borrower,
      body: { mode: 'edit' },
    });
    assert.equal(edit.status, 403, '借阅者索取编辑票必须 403（前端隐藏不等于安全）');

    const view = await req(`/api/archives/${ids.archiveGate}/document/ticket`, {
      method: 'POST',
      cookie: cookies.borrower,
      body: { mode: 'view' },
    });
    assert.equal(view.status, 201, '借阅者有 archiveView，可取只读票');

    const guestLink = await req(`/api/archives/${ids.archiveGate}/document/link`, { method: 'POST', cookie: cookies.guest });
    assert.equal(guestLink.status, 403, '访客无编辑权限');
  });

  await test('禁用用户：会话失效后换票 401', async () => {
    const off = await req(`/api/users/${ids.uid_cat2}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: { status: 'disabled' },
    });
    assert.equal(off.status, 200, JSON.stringify(off.data));

    const ticket = await req(`/api/archives/${ids.archiveMain}/document/ticket`, {
      method: 'POST',
      cookie: cookies.cat2,
      body: { mode: 'view' },
    });
    assert.equal(ticket.status, 401, '被禁用用户的会话应立即失效（拒绝继续签发）');
  });

  // ==================== 14. 迁移 003 兼容 + 重启保留 ====================
  await test('迁移 003：archive_documents / archive_file_versions 表存在', async () => {
    const sqlite = new DatabaseSync(DB_FILE);
    const rows = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('archive_documents','archive_file_versions')")
      .all()
      .map((r) => r.name);
    sqlite.close();
    assert.ok(rows.includes('archive_documents'), '应增量创建 archive_documents');
    assert.ok(rows.includes('archive_file_versions'), '应增量创建 archive_file_versions');
  });

  await test('重启保留：同库同存储重启后，档案/附件/关联/版本仍可读取（不覆盖 001/002 数据）', async () => {
    await stopServer();
    await startServer();
    adminCookie = await login(ADMIN);

    // 既有档案与附件保持
    const detail = await req(`/api/archives/${ids.archiveMain}`, { cookie: adminCookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.status, 'archived', '归档状态应持久');
    assert.ok(detail.data.files.length >= 1, '附件元数据应保留');

    // 关联与版本保留（迁移增量不破坏既有数据）
    const doc = await req(`/api/archives/${ids.archiveMain}/document`, { cookie: adminCookie });
    assert.equal(doc.status, 200);
    assert.equal(doc.data.docId, ids.docMain.docId, '关联 docId 重启后不变');
    assert.equal(doc.data.editState, 'saved');

    const versions = await req(`/api/archives/${ids.archiveMain}/versions`, { cookie: adminCookie });
    assert.equal(versions.data.length, 2, '两个版本记录应保留');
    assert.equal(versions.data[0].sha256, ids.version1.sha256, '版本内容指纹保留');
  });

  // ==================== 15. 审计展示层（对象名称解析） ====================
  await test('审计展示层：JitWord 关联/保存/入库显示文档名与中文说明', async () => {
    const list = await req('/api/audit?pageSize=100', { cookie: adminCookie });
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const items = list.data.items;
    const pick = (action) => items.filter((it) => it.action === action);
    /** 同一动作可能有多个档案的记录，按所属档案定位到主测试档案。 */
    const onMain = (action) =>
      pick(action).filter((it) => it.objectRef === '所属档案《在线编辑主测试档案》');

    const link = onMain('jitword.doc_link').find((it) => it.objectLabel === ids.docMain.docName);
    assert.ok(link, '应有主测试档案的 jitword.doc_link 审计');
    assert.equal(link.actionLabel, '关联在线文档');
    assert.equal(link.objectType, 'archive_document', '原始对象类型保留');
    assert.equal(link.objectLabel, ids.docMain.docName, '对象列应显示在线文档名');
    assert.equal(link.objectRef, '所属档案《在线编辑主测试档案》');
    assert.equal(auditPlain(link), `为档案《在线编辑主测试档案》关联在线文档「${ids.docMain.docName}」`);

    const saved = onMain('jitword.doc_saved')[0];
    assert.ok(saved, '应有主测试档案的 jitword.doc_saved 审计');
    assert.equal(auditPlain(saved), '在线保存档案《在线编辑主测试档案》的编辑内容');

    const version = onMain('jitword.version_commit')[0];
    assert.ok(version, '应有主测试档案的 jitword.version_commit 审计');
    assert.equal(version.objectLabel, '第 2 版', '文件版本对象应显示版本号');
    assert.equal(version.objectRef, '所属档案《在线编辑主测试档案》');
    assert.equal(auditPlain(version), '将在线编辑成果入库为档案《在线编辑主测试档案》的第 2 个文件版本');

    const tickets = pick('jitword.ticket_issue');
    assert.ok(tickets.length >= 2, '应有多次换票审计');
    for (const t of tickets) {
      assert.ok(!/mock-ticket/i.test(auditPlain(t)), '展示文本绝不出现票据原文');
      assert.ok(!/clientSecret/i.test(JSON.stringify(t)), '展示字段不得含接入密钥');
    }
    assert.ok(
      tickets.some((t) => t.result === 'failure' && auditPlain(t).includes('仅在线文档的建档者可申请编辑票据')),
      '非建档者换票失败应翻译为中文原因',
    );

    // 追溯能力：每条记录仍保留原始动作、对象类型与对象 ID
    for (const it of items) {
      assert.ok(it.action && it.objectType, '原始动作与对象类型必须保留');
      assert.ok(Array.isArray(it.summary), '详情应以结构化片段返回');
    }
  });
});

// ==================== 保存后自动入库（桩环境：厂商已开放导出字节回传） ====================
const SYNC_DB = path.join(__dirname, '..', 'storage', `test-jitword-sync-${process.pid}.db`);
const SYNC_STORE = path.join(__dirname, '..', 'storage', `test-jitword-sync-store-${process.pid}`);
/** 厂商导出件字节：故意与源附件不同，用于证明入库内容来自导出件而非上传件。 */
const EXPORT_BYTES = new Uint8Array([...DOCX_BYTES, ...new TextEncoder().encode('-jitword-auto-export')]);
const EXPORT_SHA256 = createHash('sha256').update(Buffer.from(EXPORT_BYTES)).digest('hex');
/** 第二次导出返回的更新字节（模拟厂商同步完成后返回新版本）。 */
const UPDATED_EXPORT_BYTES = new Uint8Array([...DOCX_BYTES, ...new TextEncoder().encode('-jitword-auto-export-v2')]);
const UPDATED_EXPORT_SHA256 = createHash('sha256').update(Buffer.from(UPDATED_EXPORT_BYTES)).digest('hex');

test.describe('JitArchives · 保存后自动入库（桩能力已开放）', { concurrency: false }, async () => {
  let app = null;
  let syncBase = '';
  const exportCalls = [];

  const syncClient = {
    available: true,
    async createDocument({ name }) {
      return { docId: 'syncdoc-1', name };
    },
    async createTicket(req) {
      const isEdit = req.mode === 'edit';
      return {
        ticket: `sync-ticket-${req.mode}`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        expiresIn: 120,
        docId: req.docId,
        origin: req.origin,
        scopes: isEdit ? ['document:read', 'document:edit'] : ['document:read'],
      };
    },
    async manifest() {
      return { mock: true };
    },
    async exportDocument(docId, externalSubject, origin) {
      exportCalls.push({ docId, externalSubject, origin });
      // 首次返回 EXPORT_BYTES，后续返回 UPDATED_EXPORT_BYTES（模拟厂商同步延迟后刷新）
      const bytes = exportCalls.length <= 1 ? EXPORT_BYTES : UPDATED_EXPORT_BYTES;
      return { buffer: Buffer.from(bytes), fileName: 'auto-export.docx' };
    },
  };

  /** 本 describe 的请求助手（独立服务实例与 Cookie）。 */
  async function call(pathname, { method = 'GET', body, cookie, raw } = {}) {
    const headers = { ...(raw ? {} : { 'Content-Type': 'application/json' }) };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${syncBase}${pathname}`, {
      method,
      headers,
      body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON */
    }
    const setCookie = res.headers.get('set-cookie');
    let nextCookie = cookie;
    if (setCookie) {
      const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
      if (m) nextCookie = m[1] ? `jit_sid=${m[1]}` : '';
    }
    return { status: res.status, data, cookie: nextCookie };
  }

  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${SYNC_DB}${s}`);
    safeRmDir(SYNC_STORE);
    const modPath = path.join(__dirname, '..', 'dist', 'main.js');
    const { bootstrap } = await import(`${pathToFileURL(modPath).href}?sync=${process.pid}-${Date.now()}`);
    const result = await bootstrap({
      port: 0,
      dbFile: SYNC_DB,
      fileStoreDir: SYNC_STORE,
      serveWeb: false,
      jitwordClient: syncClient,
    });
    app = result.app;
    syncBase = result.baseUrl;
  });

  test.after(async () => {
    if (app) await app.close();
    for (const s of ['', '-wal', '-shm']) safeRm(`${SYNC_DB}${s}`);
    safeRmDir(SYNC_STORE);
  });

  await test('自动入库：保存后同步形成 v1，字节与来源均来自导出件', async () => {
    const init = await call('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201, JSON.stringify(init.data));
    const cookie = init.cookie;

    const cat = await call('/api/categories', {
      method: 'POST',
      cookie,
      body: { name: '自动入库分类', code: 'AU', description: '自动入库用例' },
    });
    assert.equal(cat.status, 201, JSON.stringify(cat.data));

    const arc = await call('/api/archives', {
      method: 'POST',
      cookie,
      body: { title: '自动入库测试档案', categoryId: cat.data.id, archiveType: '文书档案' },
    });
    assert.equal(arc.status, 201, JSON.stringify(arc.data));
    const archiveId = arc.data.id;

    const up = await call(`/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent('源附件.docx')}`, {
      method: 'POST',
      cookie,
      raw: true,
      body: DOCX_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(up.status, 201, JSON.stringify(up.data));

    const link = await call(`/api/archives/${archiveId}/document/link`, { method: 'POST', cookie });
    assert.equal(link.status, 201, JSON.stringify(link.data));

    const status = await call('/api/jitword/status', { cookie });
    assert.equal(status.data.autoExportAvailable, true, '桩已实现 exportDocument，能力应为可用');

    const saved = await call(`/api/archives/${archiveId}/document/saved`, { method: 'POST', cookie });
    assert.equal(saved.status, 201, JSON.stringify(saved.data));

    const sync = await call(`/api/archives/${archiveId}/document/sync`, { method: 'POST', cookie });
    assert.equal(sync.status, 201, JSON.stringify(sync.data));
    assert.equal(sync.data.versionNo, 1);
    assert.equal(sync.data.origin, 'jitword_auto_export');
    assert.equal(sync.data.originLabel, '在线编辑自动入库（导出件）');
    assert.equal(sync.data.sha256, EXPORT_SHA256, '入库指纹必须来自导出件字节');
    assert.equal(sync.data.fileSize, EXPORT_BYTES.byteLength);
    assert.equal(sync.data.createdByName, ADMIN.displayName);
    assert.equal(exportCalls.length, 1, '应仅调用一次厂商导出');
    assert.equal(exportCalls[0].docId, 'syncdoc-1', '导出请求必须使用后端关联的 docId');
    assert.match(exportCalls[0].externalSubject, /^jitarchives-user-\d+$/, '导出请求必须携带建档者标识');
    assert.match(exportCalls[0].origin, /^https?:\/\//, '导出请求必须携带票据来源');

    const list = await call(`/api/archives/${archiveId}/versions`, { cookie });
    assert.equal(list.data.length, 1, '自动入库后版本列表应立即可见');

    const again = await call(`/api/archives/${archiveId}/document/sync`, { method: 'POST', cookie });
    assert.equal(again.status, 201, JSON.stringify(again.data));
    assert.equal(again.data.versionNo, 2, '再次自动入库版本号应自增，不覆盖历史');
    assert.equal(again.data.sha256, UPDATED_EXPORT_SHA256, '第二次入库指纹应来自更新后的导出件字节');
    assert.ok(exportCalls.length >= 2, '第二次入库至少应调用一次厂商导出（可能含重试）');
  });
});

// ==================== 正文渲染自检（厂商 POST /export/docx 白名单通道，只读诊断） ====================
const CHECK_DB = path.join(__dirname, '..', 'storage', 'test-jitword-check-' + process.pid + '.db');
const CHECK_STORE = path.join(__dirname, '..', 'storage', 'test-jitword-check-store-' + process.pid);
const CHECK_ARTIFACT_DIR = path.join(__dirname, '..', 'storage', 'doc-selfcheck');

/**
 * 构造最小可解析 ZIP（stored 条目）：readZipEntryNames 只读中央目录，
 * CRC 置 0 不影响条目名解析，足以验证「包内条目差异」的计算。
 */
function buildZip(names) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of names) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from('<xml name="' + name + '"/>', 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 源附件含页眉、渲染件不含：差异必须被如实报出。 */
const CHECK_SOURCE_ZIP = buildZip(['[Content_Types].xml', 'word/document.xml', 'word/header1.xml']);
const CHECK_RENDERED_ZIP = buildZip(['[Content_Types].xml', 'word/document.xml', 'word/styles.xml']);

test.describe('JitArchives · 正文渲染自检（只读诊断，不形成版本）', { concurrency: false }, async () => {
  let app = null;
  let checkBase = '';
  const renderCalls = [];
  let renderError = null;
  let knownArtifacts = [];

  const checkClient = {
    available: true,
    async createDocument({ name }) {
      return { docId: 'checkdoc-1', name };
    },
    async createTicket(req) {
      return {
        ticket: `check-ticket-${req.mode}`,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        expiresIn: 120,
        docId: req.docId,
        origin: req.origin,
        scopes: ['document:read', 'document:edit'],
      };
    },
    async manifest() {
      return { mock: true };
    },
    // 只实现 renderDocx（按正文渲染），不实现 exportDocument（按 docId 取件）：
    // 自检通路不得让「自动入库」被误判为已可用。
    async renderDocx(content, fileName) {
      renderCalls.push({ content, fileName });
      if (renderError) throw new Error(renderError);
      return { buffer: Buffer.from(CHECK_RENDERED_ZIP), fileName };
    },
  };

  /** 本 describe 的请求助手（raw 为原始体提交）。 */
  async function call(pathname, { method = 'GET', body, cookie, raw, headers: extra } = {}) {
    const headers = { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(extra || {}) };
    if (cookie) headers.Cookie = cookie;
    const payload = raw || body === undefined ? body : JSON.stringify(body);
    const res = await fetch(`${checkBase}${pathname}`, { method, headers, body: payload });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON */
    }
    let nextCookie = cookie;
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
      if (m) nextCookie = m[1] ? `jit_sid=${m[1]}` : '';
    }
    return { status: res.status, data, cookie: nextCookie };
  }

  /** 以原始流提交正文 JSON（与前端 api.postRaw 同形：application/octet-stream）。 */
  const postContent = (archiveId, content, cookie) =>
    call(`/api/archives/${archiveId}/document/content-selfcheck`, {
      method: 'POST',
      cookie,
      raw: true,
      body: typeof content === 'string' ? content : JSON.stringify(content),
      headers: { 'Content-Type': 'application/octet-stream' },
    });

  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${CHECK_DB}${s}`);
    safeRmDir(CHECK_STORE);
    const modPath = path.join(__dirname, '..', 'dist', 'main.js');
    const { bootstrap } = await import(`${pathToFileURL(modPath).href}?check=${process.pid}-${Date.now()}`);
    const result = await bootstrap({
      port: 0,
      dbFile: CHECK_DB,
      fileStoreDir: CHECK_STORE,
      serveWeb: false,
      jitwordClient: checkClient,
    });
    app = result.app;
    checkBase = result.baseUrl;
    knownArtifacts = existsSync(CHECK_ARTIFACT_DIR) ? readdirSync(CHECK_ARTIFACT_DIR) : [];
  });

  test.after(async () => {
    if (app) await app.close();
    for (const s of ['', '-wal', '-shm']) safeRm(`${CHECK_DB}${s}`);
    safeRmDir(CHECK_STORE);
    // 仅清理本次测试新增的自检产物，不动历史留档（供人工拆包比对）。
    if (existsSync(CHECK_ARTIFACT_DIR)) {
      for (const name of readdirSync(CHECK_ARTIFACT_DIR)) {
        if (!knownArtifacts.includes(name)) safeRm(path.join(CHECK_ARTIFACT_DIR, name));
      }
    }
  });

  let archiveId = 0;
  let cookie = '';

  await test('准备：建档 + 上传含页眉的 DOCX + 建立在线文档关联', async () => {
    const init = await call('/api/auth/init-admin', { method: 'POST', body: { ...ADMIN, username: 'croot' } });
    assert.equal(init.status, 201, JSON.stringify(init.data));
    cookie = init.cookie;
    const cat = await call('/api/categories', {
      method: 'POST',
      cookie,
      body: { name: '自检分类', code: 'SC', description: '正文自检用例' },
    });
    assert.equal(cat.status, 201, JSON.stringify(cat.data));
    const arc = await call('/api/archives', {
      method: 'POST',
      cookie,
      body: { title: '正文自检档案', categoryId: cat.data.id, archiveType: '文书档案' },
    });
    assert.equal(arc.status, 201, JSON.stringify(arc.data));
    archiveId = arc.data.id;
    const up = await call(
      `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent('源附件.docx')}`,
      { method: 'POST', cookie, raw: true, body: CHECK_SOURCE_ZIP, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 201, JSON.stringify(up.data));
    const link = await call(`/api/archives/${archiveId}/document/link`, { method: 'POST', cookie });
    assert.equal(link.status, 201, JSON.stringify(link.data));
  });

  await test('能力口径：仅有 renderDocx 时 autoExportAvailable 仍必须为 false', async () => {
    const st = await call('/api/jitword/status', { cookie });
    assert.equal(st.status, 200, JSON.stringify(st.data));
    assert.equal(
      st.data.autoExportAvailable,
      false,
      '按正文渲染可用≠可按 docId 取回导出件，不得谎报自动入库已开放',
    );
  });

  await test('自检：返回条目差异与页眉判定，不形成任何文件版本', async () => {
    const before = await call(`/api/archives/${archiveId}/versions`, { cookie });
    const content = { type: 'doc', content: [] };
    const r = await postContent(archiveId, content, cookie);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.exported.entries, 3, '渲染件条目数应来自真实 ZIP 解析');
    assert.deepEqual(r.data.lostEntries, ['word/header1.xml'], '源附件有而渲染件缺失的条目必须如实报出');
    assert.deepEqual(r.data.addedEntries, ['word/styles.xml']);
    assert.equal(r.data.hasHeader, false);
    assert.equal(r.data.hasFooter, false);
    assert.ok(r.data.source && r.data.source.entries === 3, '应回显源附件条目数');
    assert.equal(r.data.contentBytes, Buffer.byteLength(JSON.stringify(content)), '正文体积按 utf8 字节计');
    assert.match(r.data.exported.sha256, /^[0-9a-f]{64}$/);

    const after = await call(`/api/archives/${archiveId}/versions`, { cookie });
    assert.equal(after.data.length, before.data.length, '自检是只读诊断，绝不形成文件版本');
    assert.equal(renderCalls.length, 1, '应仅调用一次厂商渲染');
    assert.deepEqual(renderCalls[0].content, content);
    assert.match(
      renderCalls[0].fileName,
      /^JITARCHIVES_A\d+_.+-selfcheck\.docx$/,
      '渲染文件名应为 ASCII，规避导出头非法字符',
    );

    // 产物落盘供人工拆包比对
    const written = readdirSync(CHECK_ARTIFACT_DIR).filter((n) => !knownArtifacts.includes(n));
    assert.ok(written.some((n) => n.endsWith('.docx')), '应落盘渲染件');
    assert.ok(written.some((n) => n.endsWith('.content.json')), '应落盘正文 JSON');
  });

  await test('自检：归属与形态校验（非建档者 400、非法 JSON 400、缺 type 400、未登录 401）', async () => {
    const other = await call('/api/users', {
      method: 'POST',
      cookie,
      body: { username: 'sc_two', displayName: '著录员乙', password: 'Cat#12345', role: 'cataloger' },
    });
    assert.equal(other.status, 201, JSON.stringify(other.data));
    const otherLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'sc_two', password: 'Cat#12345' } });
    assert.equal(otherLogin.status, 201, JSON.stringify(otherLogin.data));
    const denied = await postContent(archiveId, { type: 'doc', content: [] }, otherLogin.cookie);
    assert.equal(denied.status, 400, JSON.stringify(denied.data));
    assert.match(String(denied.data.message), /建档者/);

    const broken = await postContent(archiveId, '{不是 JSON', cookie);
    assert.equal(broken.status, 400, JSON.stringify(broken.data));
    assert.match(String(broken.data.message), /JSON/);

    const noType = await postContent(archiveId, { content: [] }, cookie);
    assert.equal(noType.status, 400, JSON.stringify(noType.data));
    assert.match(String(noType.data.message), /type/);

    const empty = await postContent(archiveId, '   ', cookie);
    assert.equal(empty.status, 400, JSON.stringify(empty.data));

    const anonymous = await call('/api/archives/' + archiveId + '/document/content-selfcheck', {
      method: 'POST',
      raw: true,
      body: JSON.stringify({ type: 'doc', content: [] }),
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(anonymous.status, 401, '未登录不得触达自检通路');
  });

  await test('自检：厂商渲染失败如实 503，不伪造结果、不落库', async () => {
    renderError = '导出接口返回 HTTP 403：无权访问此文档';
    const r = await postContent(archiveId, { type: 'doc', content: [] }, cookie);
    renderError = null;
    assert.equal(r.status, 503, JSON.stringify(r.data));
    assert.match(String(r.data.message), /403/, '厂商原文必须如实回传，否则无法区分归属/路由/网络问题');
    const list = await call(`/api/archives/${archiveId}/versions`, { cookie });
    assert.equal(list.data.length, 0, '失败路径同样不得产生版本');
  });

  await test('自检：客户端未实现渲染通道时如实 503（不谎报能力）', async () => {
    await app.close();
    const noop = {
      available: true,
      createDocument: checkClient.createDocument,
      createTicket: checkClient.createTicket,
      manifest: checkClient.manifest,
    };
    const modPath = path.join(__dirname, '..', 'dist', 'main.js');
    const { bootstrap } = await import(`${pathToFileURL(modPath).href}?nope=${process.pid}-${Date.now()}`);
    const result = await bootstrap({
      port: 0,
      dbFile: CHECK_DB,
      fileStoreDir: CHECK_STORE,
      serveWeb: false,
      jitwordClient: noop,
    });
    app = result.app;
    checkBase = result.baseUrl;
    const login = await call('/api/auth/login', { method: 'POST', body: { username: 'croot', password: ADMIN.password } });
    assert.equal(login.status, 201, JSON.stringify(login.data));
    const r = await postContent(archiveId, { type: 'doc', content: [] }, login.cookie);
    assert.equal(r.status, 503, JSON.stringify(r.data));
    assert.match(String(r.data.message), /未实现|无法自检/);
  });
});
