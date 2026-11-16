/**
 * JitArchives 阶段二第二批 · 档案核心业务后端自动化验证（node:test）
 *
 * 使用独立测试数据库（storage/test-archives-<pid>.db）与独立文件存储目录
 * （storage/test-file-store-<pid>），不触碰正式库与已上传文件。
 * 覆盖项：
 *  1. 未登录访问档案/分类/附件接口一律 401；
 *  2. 分类创建、编辑、删除（有子分类/被引用拒绝的引用保护）、层级展示、同级重名/重码拒绝、循环引用与自引用拒绝、档案数量统计；
 *  3. 档案创建（档号自动生成）、编辑、详情、列表；必填/长度/格式校验；
 *  4. 归档流转（draft → archived）后著录信息与附件上传均被拒绝（归档只读约束）；
 *  5. 附件真实上传（PDF/DOCX 字节）→ 磁盘物理文件存在 → 元数据一致 → 授权下载内容一致；
 *  6. 文件安全：扩展名白名单拒绝 .exe；路径穿越 stored_name 拒绝下载且不泄露库文件内容；
 *  7. 权限矩阵：借阅者不能著录/上传，访客不能下载，后端独立 403；
 *  8. 检索：关键词命中/未命中、特殊字符与 SQL 注入串不报错、筛选与分页同时生效；
 *  9. 重启（同库同存储目录再启动）后分类/档案/附件元数据与文件内容仍可读取；
 * 10. 草稿删除（方案 A）：仅草稿可删、非创建者与他人 403、附件元数据与物理文件同步清理、写审计；
 * 11. 登录与用户管理既有链路回归（本批新增接口不影响第一批行为）。
 * 运行：npm test（根目录，需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-archives-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-file-store-${process.pid}`);

let baseUrl = null;
let currentApp = null;

async function startServer() {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({
    port: 0,
    dbFile: DB_FILE,
    fileStoreDir: FILE_STORE,
    serveWeb: false,
  });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}

async function stopServer() {
  await currentApp.close();
  currentApp = null;
}

/** 请求助手：JSON + 手动会话 Cookie；raw 模式支持 FormData / 裸流。 */
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
    /* 非 JSON 响应 */
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
    /* 忽略 Windows EPERM */
  }
}

function safeRmDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

const ADMIN = { username: 'rootadmin', displayName: '总管理员', password: 'Admin#12345' };
const USERS = {
  cataloger: { username: 'cat_one', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  reviewer: { username: 'rev_one', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  borrower: { username: 'bor_one', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'gst_one', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

/** 最小合法 PDF（以 %PDF 开头，便于内容比对）。 */
const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n- 档案测试内容 -',
);
/** ZIP（docx 同容器）头部字节，用于 .docx 上传。 */
const DOCX_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x64, 0x6f, 0x63, 0x78, 0x2d, 0x74, 0x65, 0x73,
  0x74,
]);

let adminCookie = '';
const cookies = {}; // 各角色会话
const ids = {}; // 业务对象 id

async function login(user) {
  const r = await req('/api/auth/login', { method: 'POST', body: user });
  assert.equal(r.status, 201, `登录应成功：${user.username}`);
  return r.cookie;
}

test.describe('JitArchives 阶段二第二批 · 档案业务自动化验证', { concurrency: false }, async () => {
  test.before(async () => {
    safeRm(DB_FILE);
    safeRm(`${DB_FILE}-wal`);
    safeRm(`${DB_FILE}-shm`);
    safeRmDir(FILE_STORE);
    await startServer();
  });

  test.after(async () => {
    if (currentApp) await stopServer();
    for (const suffix of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${suffix}`);
    safeRmDir(FILE_STORE);
  });

  // ==================== 准备：初始化 + 五类角色账号 ====================

  await test('准备：初始化管理员并创建各角色账号', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;

    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      cookies[key] = await login(USERS[key]);
    }
  });

  await test('未登录访问档案/分类/附件接口一律 401', async () => {
    for (const p of ['/api/archives', '/api/categories', '/api/archives/1/files', '/api/archive-files/1/download']) {
      const r = await req(p);
      assert.equal(r.status, 401, `${p} 未登录必须 401`);
    }
    const up = await req('/api/archive-files/upload?archiveId=1', { method: 'POST' });
    // 守卫先于请求体解析：无 Cookie 直接 401
    assert.equal(up.status, 401);
  });

  // ==================== 功能一：分类管理 ====================

  await test('分类：创建顶层与子分类，编码链与层级正确', async () => {
    const ws = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '文书档案', code: 'WS', description: '发文、合同等文书类' },
    });
    assert.equal(ws.status, 201);
    assert.equal(ws.data.depth, 0);
    ids.ws = ws.data.id;

    const ht = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '合同协议', code: 'HT', parentId: ids.ws, description: '各类合同' },
    });
    assert.equal(ht.status, 201);
    assert.equal(ht.data.parentId, ids.ws);
    assert.equal(ht.data.depth, 1);
    assert.equal(ht.data.pathCode, 'WS-HT');
    ids.ht = ht.data.id;

    const list = await req('/api/categories', { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.equal(list.data.length, 2);
    assert.equal(list.data.find((c) => c.id === ids.ws).archiveCount, 0);
  });

  await test('分类：编辑名称与说明生效；同级重名/重码被拒绝', async () => {
    const upd = await req(`/api/categories/${ids.ht}`, {
      method: 'PUT',
      cookie: adminCookie,
      body: { name: '合同协议类', description: '含采购、服务合同' },
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.name, '合同协议类');

    const dupName = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '文书档案', code: 'XX' },
    });
    assert.equal(dupName.status, 409, '同级重名必须 409');

    const dupCode = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '其他', code: 'WS' },
    });
    assert.equal(dupCode.status, 409, '同级重码必须 409');

    const badName = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '', code: 'K' },
    });
    assert.equal(badName.status, 400, '空名称必须 400');
  });

  await test('分类：自引用与循环引用被拒绝', async () => {
    const selfParent = await req(`/api/categories/${ids.ws}`, {
      method: 'PUT',
      cookie: adminCookie,
      body: { parentId: ids.ws },
    });
    assert.equal(selfParent.status, 400, '父级=自身必须 400');
    assert.match(String(selfParent.data.message), /父级|循环|自身/);

    const loop = await req(`/api/categories/${ids.ws}`, {
      method: 'PUT',
      cookie: adminCookie,
      body: { parentId: ids.ht }, // WS 挂到自己的子级 HT 之下 → 循环
    });
    assert.equal(loop.status, 400, '循环引用必须 400');

    const after = await req('/api/categories', { cookie: adminCookie });
    const ws = after.data.find((c) => c.id === ids.ws);
    assert.equal(ws.parentId, null, '失败后父级必须保持原样');
  });

  await test('分类：删除按引用保护（有子分类拒绝、叶子可删、越权 403、写审计）', async () => {
    const tmp = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '临时类目', code: 'TMP' },
    });
    assert.equal(tmp.status, 201);
    const tmpId = tmp.data.id;
    const tmpChild = await req('/api/categories', {
      method: 'POST',
      cookie: adminCookie,
      body: { name: '临时子类目', code: 'TMPC', parentId: tmpId },
    });
    assert.equal(tmpChild.status, 201);
    const childId = tmpChild.data.id;

    // 1) 有子分类：拒绝删除，并返回可读原因
    const delParent = await req(`/api/categories/${tmpId}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(delParent.status, 400, '有子分类的分类不可删除');
    assert.match(String(delParent.data.message), /子分类/);

    // 2) 叶子分类可删除，删除后目录中真实不存在
    const delChild = await req(`/api/categories/${childId}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(delChild.status, 200);
    assert.equal(delChild.data.ok, true);
    const afterChild = await req('/api/categories', { cookie: adminCookie });
    assert.equal(afterChild.data.some((c) => c.id === childId), false, '删除后必须从目录移除');

    // 3) 子级清空后父级可删
    const delParent2 = await req(`/api/categories/${tmpId}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(delParent2.status, 200, '子级清空后父级可删');

    // 4) 越权：借阅者删除必须 403（不依赖前端按钮状态）
    const forbidden = await req(`/api/categories/${ids.ws}`, {
      method: 'DELETE',
      cookie: cookies.borrower,
    });
    assert.equal(forbidden.status, 403, '借阅者删除分类必须 403');

    // 5) 删除动作写入操作审计（结果为成功，detail 保留删除前名称）
    const audit = await req('/api/audit?action=category.delete&page=1&pageSize=20', {
      cookie: adminCookie,
    });
    assert.equal(audit.status, 200);
    assert.ok(audit.data.items.length >= 2, '两次成功删除必须写入审计');
    assert.ok(
      audit.data.items.every((x) => x.result === 'success'),
      '成功删除不得记成失败',
    );
    assert.ok(
      audit.data.items.some((x) => x.detail && x.detail.name === '临时类目'),
      '审计 detail 需保留删除前的分类名称',
    );
  });

  // ==================== 功能二：档案著录 ====================

  await test('档案：必填与格式校验（空标题/非法分类/非法日期/超长字段）', async () => {
    const cases = [
      { body: { title: '', categoryId: ids.ws }, hint: /标题/ },
      { body: { title: 'x', categoryId: 999999 }, hint: /分类不存在/ },
      { body: { title: 'x', categoryId: ids.ws, formationDate: '2026-13-45' }, hint: /形成时间/ },
      { body: { title: 'x'.repeat(201), categoryId: ids.ws }, hint: /标题/ },
      { body: { title: 'x', categoryId: ids.ws, archiveType: '外星档案' }, hint: /类型/ },
    ];
    for (const c of cases) {
      const r = await req('/api/archives', { method: 'POST', cookie: cookies.cataloger, body: c.body });
      assert.equal(r.status, 400, `非法入参必须 400：${JSON.stringify(c.body)}`);
      assert.match(String(r.data.message), c.hint);
    }
  });

  await test('档案：创建成功，档号自动生成，创建人由后端维护', async () => {
    const created = await req('/api/archives', {
      method: 'POST',
      cookie: cookies.cataloger,
      body: {
        title: '2026年度信息化服务采购合同',
        categoryId: ids.ht,
        archiveType: '文书档案',
        keywords: '采购,合同,信息化',
        formationDate: '2026-09-30',
        responsible: '信息中心',
        remarks: '自动化测试档案',
      },
    });
    assert.equal(created.status, 201);
    assert.match(created.data.archiveNo, /^WS-HT-2026-\d{6}$/, '档号应为 分类链-年度-流水');
    assert.equal(created.data.status, 'draft');
    assert.equal(created.data.createdByName, USERS.cataloger.displayName, '创建人取会话用户');
    assert.ok(created.data.id > 0);
    ids.archive1 = created.data.id;

    // 客户端伪造状态/创建人被拒绝或不生效
    const forge = await req('/api/archives', {
      method: 'POST',
      cookie: cookies.cataloger,
      body: { title: '伪造测试', categoryId: ids.ws, status: 'archived', createdBy: 999 },
    });
    assert.equal(forge.status, 400, '直接指定状态必须被拒绝');

    // 分类下档案数量实时更新
    const cats = await req('/api/categories', { cookie: adminCookie });
    assert.equal(cats.data.find((c) => c.id === ids.ht).archiveCount, 1);
    assert.equal(cats.data.find((c) => c.id === ids.ws).archiveCount, 0, '数量按直接归属统计');
  });

  await test('分类：仍被档案引用时删除被拒绝，且分类保持存在', async () => {
    const delHt = await req(`/api/categories/${ids.ht}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(delHt.status, 400, '被档案引用的分类不可删除');
    assert.match(String(delHt.data.message), /引用/);
    const still = await req('/api/categories', { cookie: adminCookie });
    assert.ok(still.data.some((c) => c.id === ids.ht), '拒绝后分类必须仍存在');
    assert.equal(still.data.find((c) => c.id === ids.ht).archiveCount, 1);
  });

  await test('档案：列表与详情来自数据库真实数据，可打开刚创建的档案', async () => {
    const list = await req('/api/archives?page=1&pageSize=10', { cookie: cookies.borrower });
    assert.equal(list.status, 200);
    assert.ok(list.data.items.some((a) => a.id === ids.archive1));
    assert.equal(list.data.total >= 1, true);

    const detail = await req(`/api/archives/${ids.archive1}`, { cookie: cookies.borrower });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.title, '2026年度信息化服务采购合同');
    assert.equal(detail.data.categoryPath, '文书档案 / 合同协议类');
    assert.deepEqual(detail.data.files, []);
  });

  await test('档案：编辑著录信息；分类变更后档号自动重生成保持唯一', async () => {
    const upd = await req(`/api/archives/${ids.archive1}`, {
      method: 'PUT',
      cookie: cookies.cataloger,
      body: {
        title: '2026年度信息化服务采购合同（修订）',
        categoryId: ids.ws, // 换到顶层分类
        archiveType: '文书档案',
        keywords: '采购,合同,信息化,修订',
        formationDate: '2026-09-30',
        responsible: '信息中心',
        remarks: '已修订',
      },
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.data.title, '2026年度信息化服务采购合同（修订）');
    assert.match(upd.data.archiveNo, /^WS-2026-\d{6}$/, '分类变更后档号前缀应更新');
    assert.notEqual(upd.data.archiveNo, `${'WS-HT'}-2026-${String(ids.archive1).padStart(6, '0')}`);
  });

  // ==================== 功能三：附件上传与下载 ====================

  await test('附件：裸流上传 PDF，物理文件真实落盘且元数据一致', async () => {
    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=${encodeURIComponent('采购合同.pdf')}`,
      { method: 'POST', cookie: cookies.cataloger, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.originalName, '采购合同.pdf');
    assert.equal(up.data.extension, 'pdf');
    assert.equal(up.data.fileSize, PDF_BYTES.byteLength);
    ids.file1 = up.data.id;

    // 磁盘上真实存在服务端安全命名文件
    const storedFiles = listStoreFiles();
    assert.ok(
      storedFiles.some((f) => /^[0-9a-f]{32}\.pdf$/.test(f)),
      `受控目录内应有 32hex 命名的物理文件：${storedFiles}`,
    );
    // 无 .uploading 残留
    assert.ok(!storedFiles.some((f) => f.endsWith('.uploading')), '不得残留临时文件');

    const files = await req(`/api/archives/${ids.archive1}/files`, { cookie: cookies.borrower });
    assert.equal(files.status, 200);
    assert.equal(files.data.length, 1);
    assert.equal(files.data[0].uploadedByName, USERS.cataloger.displayName);
  });

  await test('附件：裸流上传 DOCX；同名附件显示名自动加序号', async () => {
    const up1 = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=${encodeURIComponent('验收单.docx')}`,
      { method: 'POST', cookie: cookies.reviewer, raw: true, body: DOCX_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up1.status, 201, JSON.stringify(up1.data));
    assert.equal(up1.data.extension, 'docx');
    assert.equal(up1.data.originalName, '验收单.docx');

    const up2 = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=${encodeURIComponent('验收单.docx')}`,
      { method: 'POST', cookie: cookies.reviewer, raw: true, body: DOCX_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up2.status, 201, JSON.stringify(up2.data));
    assert.equal(up2.data.originalName, '验收单(2).docx', '同名文件不得覆盖既有附件显示名');
    ids.file2 = up2.data.id;
  });

  await test('附件：扩展名白名单（.exe 拒绝）与空文件拒绝', async () => {
    const bad = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=${encodeURIComponent('virus.exe')}`,
      { method: 'POST', cookie: cookies.cataloger, raw: true, body: new TextEncoder().encode('MZ'), headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(bad.status, 400, '.exe 必须被拒绝');
    assert.match(String(bad.data.message), /暂不支持/);

    const empty = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=blank.pdf`,
      { method: 'POST', cookie: cookies.cataloger, raw: true, body: new Uint8Array(0), headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(empty.status, 400, '空文件必须被拒绝');

    const files = await req(`/api/archives/${ids.archive1}/files`, { cookie: adminCookie });
    assert.equal(files.data.length, 3, '失败上传不得登记元数据（此时仅 1 PDF + 2 DOCX）');
  });


  await test('附件：授权下载内容一致；访客下载 403；越权 fileId 与路径穿越被拒绝', async () => {
    const dl = await req(`/api/archive-files/${ids.file1}/download`, { cookie: cookies.borrower });
    assert.equal(dl.status, 200);
    const disposition = dl.headers.get('content-disposition');
    assert.match(disposition, /filename\*=UTF-8''%E9%87%87%E8%B4%AD%E5%90%88%E5%90%8C\.pdf/, '应还原中文文件名');
    const buf = new Uint8Array(await (await fetch(`${baseUrl}/api/archive-files/${ids.file1}/download`, { headers: { Cookie: cookies.borrower } })).arrayBuffer());
    assert.equal(buf.byteLength, PDF_BYTES.byteLength);
    assert.ok(Buffer.compare(Buffer.from(buf), Buffer.from(PDF_BYTES)) === 0, '下载内容必须与上传字节完全一致');

    const guestDl = await req(`/api/archive-files/${ids.file1}/download`, { cookie: cookies.guest });
    assert.equal(guestDl.status, 403, '访客下载必须 403（默认拒绝）');

    const noAuth = await req(`/api/archive-files/${ids.file1}/download`);
    assert.equal(noAuth.status, 401, '未登录下载必须 401');

    const ghost = await req('/api/archive-files/999999/download', { cookie: cookies.borrower });
    assert.equal(ghost.status, 404, '不存在的附件必须 404');

    // 存储安全：新增一份附件，再把其元数据改为路径穿越（模拟脏数据/被篡改），
    // 下载必须被路径校验拦截；使用独立 fileId 以免污染后续用例。
    const extra = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=evil-target.pdf`,
      { method: 'POST', cookie: cookies.cataloger, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(extra.status, 201);
    ids.fileEvil = extra.data.id;

    const sqlite = new DatabaseSync(DB_FILE);
    sqlite
      .prepare("UPDATE archive_files SET stored_name = '../../jitarchives.db' WHERE id = ?")
      .run(ids.fileEvil);
    sqlite.close();
    const evil = await req(`/api/archive-files/${ids.fileEvil}/download`, { cookie: cookies.borrower });
    assert.equal(evil.status, 404, '路径穿越 stored_name 必须被拒绝');
    assert.ok(!JSON.stringify(evil.data).includes('SQLite format'), '错误响应不得泄露数据库内容');
    assert.ok(!JSON.stringify(evil.data).includes('%PDF'), '错误响应不得携带文件内容');
  });

  // ==================== 功能九（权限矩阵独立校验） ====================

  await test('权限：借阅者不能新建/修改档案，借阅者/审核员不能修改分类', async () => {
    const create = await req('/api/archives', {
      method: 'POST',
      cookie: cookies.borrower,
      body: { title: '越权档案', categoryId: ids.ws },
    });
    assert.equal(create.status, 403, '借阅者新建档案必须 403');

    const update = await req(`/api/archives/${ids.archive1}`, {
      method: 'PUT',
      cookie: cookies.borrower,
      body: { title: '越权改名' },
    });
    assert.equal(update.status, 403, '借阅者修改档案必须 403');

    const cat = await req('/api/categories', {
      method: 'POST',
      cookie: cookies.borrower,
      body: { name: '越权分类', code: 'YQ' },
    });
    assert.equal(cat.status, 403, '借阅者新建分类必须 403');

    const catUpd = await req(`/api/categories/${ids.ws}`, {
      method: 'PUT',
      cookie: cookies.reviewer,
      body: { name: '审核员可管理' , code: 'WS', description: '审核员修改说明' },
    });
    assert.equal(catUpd.status, 200, '审核员允许维护分类（矩阵 categoryManage）');

    const guestCat = await req('/api/categories', { cookie: cookies.guest });
    assert.equal(guestCat.status, 200, '访客可查看分类目录');
    const guestList = await req('/api/archives', { cookie: cookies.guest });
    assert.equal(guestList.status, 200, '访客可检索档案目录（默认仅著录信息）');
  });

  await test('权限：借阅者不能上传附件，上传 403 后无元数据与物理文件', async () => {
    const before = listStoreFiles().length;
    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=尝试.pdf`,
      { method: 'POST', cookie: cookies.borrower, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 403);
    assert.equal(listStoreFiles().length, before, '越权上传不得落盘');
    const files = await req(`/api/archives/${ids.archive1}/files`, { cookie: adminCookie });
    assert.equal(files.data.length, 4, '越权上传不得登记元数据（仅此前 4 份合法附件）');
  });

  // ==================== 功能五：检索与分页 ====================

  await test('检索：关键词命中/未命中、特殊字符与 SQL 注入串安全', async () => {
    const hit = await req('/api/archives?q=' + encodeURIComponent('采购'), { cookie: cookies.borrower });
    assert.equal(hit.status, 200);
    assert.ok(hit.data.items.some((a) => a.id === ids.archive1), '标题关键词应命中');

    const byNo = await req(`/api/archives?q=${encodeURIComponent('WS-2026')}`, { cookie: cookies.borrower });
    assert.ok(byNo.data.items.some((a) => a.id === ids.archive1), '档号片段应命中');

    const miss = await req('/api/archives?q=' + encodeURIComponent('不存在的内容zzz'), { cookie: cookies.borrower });
    assert.equal(miss.status, 200);
    assert.equal(miss.data.total, 0);
    assert.deepEqual(miss.data.items, [], '无结果必须返回空列表（前端空态依据）');

    for (const inj of ["' OR '1'='1", '%', '_', '\\', '"; DROP TABLE archives; --', '合同%_\'']) {
      const r = await req('/api/archives?q=' + encodeURIComponent(inj), { cookie: cookies.admin ?? adminCookie });
      assert.equal(r.status, 200, `特殊字符不得导致 SQL 错误：${inj}`);
      assert.ok(Array.isArray(r.data.items));
    }
  });

  await test('检索：分类筛选（含子分类）与分页同时生效', async () => {
    // 批量补数据：顶层分类下 5 条
    for (let i = 1; i <= 5; i++) {
      const r = await req('/api/archives', {
        method: 'POST',
        cookie: cookies.cataloger,
        body: { title: `批量测试档案第${i}号`, categoryId: ids.ws, keywords: '批量' },
      });
      assert.equal(r.status, 201);
    }
    const subOnly = await req(`/api/archives?categoryId=${ids.ht}&includeSub=0`, { cookie: adminCookie });
    assert.equal(subOnly.status, 200);
    assert.ok(subOnly.data.items.every((a) => a.categoryId === ids.ht), '不含子分类时结果必须都属于该分类');

    const withSub = await req(`/api/archives?categoryId=${ids.ws}`, { cookie: adminCookie });
    assert.equal(withSub.data.total, 6, '顶层分类含子分类：archive1(已转入 WS) + 批量 5 条');

    const paged = await req(`/api/archives?q=批量&categoryId=${ids.ws}&page=2&pageSize=2`, { cookie: adminCookie });
    assert.equal(paged.data.total, 5, '关键词+分类过滤的总数');
    assert.equal(paged.data.items.length, 2, '第二页应有 2 条');
    assert.equal(paged.data.page, 2);

    const badPage = await req('/api/archives?page=0', { cookie: adminCookie });
    assert.equal(badPage.status, 400, '非法页码必须 400');
  });

  // ==================== 归档状态约束（PRD：归档后不可随意修改） ====================

  await test('归档：借阅者无权流转；审核员归档成功；归档后编辑与上传被拒绝', async () => {
    const byBorrower = await req(`/api/archives/${ids.archive1}/transition-archive`, {
      method: 'POST',
      cookie: cookies.borrower,
    });
    assert.equal(byBorrower.status, 403, '借阅者无权归档');

    const ok = await req(`/api/archives/${ids.archive1}/transition-archive`, {
      method: 'POST',
      cookie: cookies.reviewer,
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.data.status, 'archived');

    const edit = await req(`/api/archives/${ids.archive1}`, {
      method: 'PUT',
      cookie: cookies.cataloger,
      body: { title: '归档后篡改' },
    });
    assert.equal(edit.status, 400, '归档后不得修改著录');
    assert.match(String(edit.data.message), /已归档/);

    const up = await req(
      `/api/archive-files/upload?archiveId=${ids.archive1}&name=x.pdf`,
      { method: 'POST', cookie: cookies.cataloger, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 400, '归档后不得挂接新附件');

    const again = await req(`/api/archives/${ids.archive1}/transition-archive`, {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(again.status, 400, '重复归档应被拒绝');

    // 附件仍可下载（已归档不破坏合法读取）
    const dl = await req(`/api/archive-files/${ids.file1}/download`, { cookie: cookies.borrower });
    assert.equal(dl.status, 200);
  });

  // ==================== 重启持久化 ====================

  await test('重启保留：同库同存储目录重启后，档案/分类/附件与文件内容仍完整', async () => {
    await stopServer();
    await startServer();

    const relogin = await login(ADMIN);
    adminCookie = relogin;

    const cats = await req('/api/categories', { cookie: adminCookie });
    assert.equal(cats.status, 200);
    assert.ok(cats.data.some((c) => c.id === ids.ws), '分类应保留');

    const detail = await req(`/api/archives/${ids.archive1}`, { cookie: adminCookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.status, 'archived');
    assert.equal(detail.data.files.length, 4, '附件元数据应保留（PDF + 2 DOCX + 越权测试件）');

    const dl = await fetch(`${baseUrl}/api/archive-files/${ids.file1}/download`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(dl.status, 200);
    const buf = new Uint8Array(await dl.arrayBuffer());
    assert.ok(Buffer.compare(Buffer.from(buf), Buffer.from(PDF_BYTES)) === 0, '重启后下载内容仍与原始字节一致');
  });

  // ==================== 草稿删除（方案 A：仅草稿可删） ====================

  await test('删除：草稿可由创建者删除，附件与物理文件同步清理并写审计', async () => {
    const created = await req('/api/archives', {
      method: 'POST',
      cookie: cookies.cataloger,
      body: { title: '待删除的草稿档案', categoryId: ids.ws, keywords: '待删' },
    });
    assert.equal(created.status, 201);
    const draftId = created.data.id;

    const up = await req(
      `/api/archive-files/upload?archiveId=${draftId}&name=${encodeURIComponent('待删附件.pdf')}`,
      { method: 'POST', cookie: cookies.cataloger, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(up.status, 201, JSON.stringify(up.data));
    const storedBefore = listStoreFiles();

    // 未登录 401；借阅者/访客无 archiveManage 403
    assert.equal((await req(`/api/archives/${draftId}`, { method: 'DELETE' })).status, 401);
    assert.equal((await req(`/api/archives/${draftId}`, { method: 'DELETE', cookie: cookies.borrower })).status, 403);
    assert.equal((await req(`/api/archives/${draftId}`, { method: 'DELETE', cookie: cookies.guest })).status, 403);

    // 同角色但非创建者的著录员同样 403（服务端复核归属，不只看角色）
    const otherUser = await req('/api/users', {
      method: 'POST',
      cookie: adminCookie,
      body: { username: 'cat_two', displayName: '著录员乙', password: 'Cat2#12345', role: 'cataloger' },
    });
    assert.equal(otherUser.status, 201, JSON.stringify(otherUser.data));
    const otherCookie = await login({ username: 'cat_two', password: 'Cat2#12345' });
    const byOther = await req(`/api/archives/${draftId}`, { method: 'DELETE', cookie: otherCookie });
    assert.equal(byOther.status, 403, '非创建者著录员不得删除他人档案');

    // 越权被拒后档案必须仍在
    assert.equal((await req(`/api/archives/${draftId}`, { cookie: adminCookie })).status, 200);

    // 创建者删除成功
    const del = await req(`/api/archives/${draftId}`, { method: 'DELETE', cookie: cookies.cataloger });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal(del.data.ok, true);
    assert.equal((await req(`/api/archives/${draftId}`, { cookie: adminCookie })).status, 404, '删除后详情必须 404');

    const search = await req(`/api/archives?q=${encodeURIComponent('待删除')}`, { cookie: adminCookie });
    assert.equal(search.data.total, 0, '删除后检索不得再命中');

    // 物理文件同步清理：只少当次上传的这一份，无 .uploading 残留
    const storedAfter = listStoreFiles();
    assert.equal(storedAfter.length, storedBefore.length - 1, `物理文件应被清理：${storedBefore} → ${storedAfter}`);

    // 审计：成功留痕，detail 保留删除前题名/档号与清理数量
    const audit = await req('/api/audit?action=archive.delete&page=1&pageSize=20', { cookie: adminCookie });
    assert.equal(audit.status, 200);
    assert.equal(audit.data.items.length, 1, '删除必须且只能留下一条成功审计');
    assert.equal(audit.data.items[0].objectId, String(draftId));
    assert.equal(audit.data.items[0].result, 'success');
    assert.equal(audit.data.items[0].detail.title, '待删除的草稿档案');
    assert.match(String(audit.data.items[0].detail.archiveNo), /^WS-\d{4}-\d{6}$/);
    assert.equal(audit.data.items[0].detail.fileCount, 1);
  });

  await test('删除：已归档档案拒绝删除，数据保持可访问', async () => {
    const created = await req('/api/archives', {
      method: 'POST',
      cookie: cookies.cataloger,
      body: { title: '已归档不可删档案', categoryId: ids.ws },
    });
    assert.equal(created.status, 201);
    const archivedId = created.data.id;
    const arc = await req(`/api/archives/${archivedId}/transition-archive`, {
      method: 'POST',
      cookie: cookies.reviewer,
    });
    assert.equal(arc.status, 201);

    // 管理员也不例外：已归档档案承载归档事实，不可物理删除
    const del = await req(`/api/archives/${archivedId}`, { method: 'DELETE', cookie: adminCookie });
    assert.equal(del.status, 400, '已归档档案不可删除');
    assert.match(String(del.data.message), /已归档/);

    const detail = await req(`/api/archives/${archivedId}`, { cookie: adminCookie });
    assert.equal(detail.status, 200, '拒绝删除后档案必须仍在');
    assert.equal(detail.data.status, 'archived');
  });

  // ==================== 一体化扩展：动态元数据著录值参与检索 ====================
  await test('检索：动态元数据著录值命中，且可按 matchDynamic=0 关闭', async () => {
    // 独立顶层分类，避免影响既有 WS 树计数断言
    const cat = await req('/api/categories', {
      method: 'POST', cookie: adminCookie, body: { name: '元数据检索类', code: 'MR' },
    });
    assert.equal(cat.status, 201);
    const mrId = cat.data.id;

    const mt = await req('/api/templates', {
      method: 'POST', cookie: adminCookie,
      body: { name: '检索元数据模板', fields: [{ fieldKey: 'contractNo', label: '合同编号', type: 'text', required: false }] },
    });
    assert.equal(mt.status, 201, JSON.stringify(mt.data));

    const bind = await req(`/api/categories/${mrId}/template`, {
      method: 'PUT', cookie: adminCookie, body: { templateId: mt.data.id },
    });
    assert.equal(bind.status, 200, JSON.stringify(bind.data));

    const unique = 'META-HIT-9001';
    const arc = await req('/api/archives', {
      method: 'POST', cookie: cookies.cataloger,
      body: { title: '动态检索测试档案', categoryId: mrId, fieldValues: { contractNo: unique } },
    });
    assert.equal(arc.status, 201, JSON.stringify(arc.data));

    // 默认开启：仅动态值命中（标题/档号/关键词均不含该串）
    const hit = await req(`/api/archives?q=${encodeURIComponent(unique)}`, { cookie: adminCookie });
    assert.equal(hit.status, 200);
    assert.ok(hit.data.items.some((a) => a.id === arc.data.id), '动态元数据著录值应参与检索并命中');

    // 显式关闭：同一关键词不得命中
    const off = await req(`/api/archives?q=${encodeURIComponent(unique)}&matchDynamic=0`, { cookie: adminCookie });
    assert.equal(off.status, 200);
    assert.ok(!off.data.items.some((a) => a.id === arc.data.id), 'matchDynamic=0 时不应命中动态值');
  });

  // ==================== 第一批功能回归 ====================
  await test('回归：登录链路与用户管理接口行为不变', async () => {
    const bad = await req('/api/auth/login', { method: 'POST', body: { username: ADMIN.username, password: 'Wrong#1' } });
    assert.equal(bad.status, 401);

    const me = await req('/api/auth/me', { cookie: adminCookie });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, ADMIN.username);

    const users = await req('/api/users', { cookie: cookies.borrower });
    assert.equal(users.status, 403, '借阅者读取用户列表仍必须 403');

    // 管理员保底保护不受本批影响：禁用最后一名启用管理员仍被拒
    const list = await req('/api/users', { cookie: adminCookie });
    const admins = list.data.filter((u) => u.role === 'admin' && u.status === 'active');
    assert.equal(admins.length, 1, '当前测试库仅初始管理员一名启用管理员');
    const self = await req(`/api/users/${admins[0].id}`, { method: 'PATCH', cookie: adminCookie, body: { role: 'guest' } });
    assert.equal(self.status, 400, '最后一名启用管理员降级仍必须被拒绝');
  });
});

function listStoreFiles() {
  if (!existsSync(FILE_STORE)) return [];
  return readdirSync(FILE_STORE);
}
