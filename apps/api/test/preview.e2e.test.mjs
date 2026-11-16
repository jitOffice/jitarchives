/**
 * JitArchives · V1.0 多格式在线预览后端自动化验证（node:test）
 *
 * 使用独立测试数据库（storage/test-preview-<pid>.db）与独立文件存储目录
 * （storage/test-file-store-preview-<pid>），不触碰正式库与其他测试数据。
 * 覆盖项（对齐本轮任务书第五节）：
 *  1. PDF 预览成功：200 + application/pdf + inline + nosniff + 字节一致；
 *  2. JPG/PNG/GIF/BMP 预览成功：Content-Type 按真实字节判定；
 *  3. 未登录预览一律 401；
 *  4. 无档案权限用户（受限档案）不能预览；访客角色无文件字节获取权被 403；
 *  5. 受限档案借阅授权后允许预览（200 + 正确字节）；
 *  6. 借阅归还 / 到期后预览权限立即失效（403）；
 *  7. 路径穿越（非法 fileId）与伪造他人 stored_name 不能访问其他文件；
 *  8. JitWord-Preview 支持的 DOCX/XLSX/PPTX/OFD/TXT/MD/HTML 均以 octet-stream
 *     受控字节流下发；zip/tiff/旧版 Office/伪图必须 415 拒绝；
 *  9. 预览不绕过下载限制：授权撤销后预览与下载同时失效；返回字节与下载一致；
 * 10. 原有附件下载功能仍正常；
 * 11. Range 分段读取（浏览器 PDF 查看器依赖）：206/Content-Range/416；
 * 12. HTML/SVG 等主动内容绝不以 text/html|image/svg+xml 内联返回（HTML 仅走 SDK 沙箱）；
 * 13. 预览与越权预览失败均写入操作审计（file.preview / file.preview_denied）；
 * 14. 已归档档案的 DOCX 附件与 DOCX 文件版本均可预览，跨档案版本 404。
 * 运行：npm test（需先 npm run build:api）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-preview-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-file-store-preview-${process.pid}`);

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

/** 请求助手：JSON + 手动会话 Cookie；raw 模式支持裸流上传；二进制响应保留 Uint8Array。 */
async function req(pathname, { method = 'GET', body, cookie, raw, headers: extraHeaders } = {}) {
  const headers = { ...(raw ? {} : { 'Content-Type': 'application/json' }), ...(extraHeaders || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = res.headers.get('content-type') ?? '';
  let data = null;
  let bytes = null;
  if (contentType.includes('application/json')) {
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON */
    }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  const setCookie = res.headers.get('set-cookie');
  let newCookie = cookie;
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, bytes, cookie: newCookie, headers: res.headers };
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
  cataloger: { username: 'cat_p', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  reviewer: { username: 'rev_p', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  borrower: { username: 'bor_p', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'gst_p', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

const enc = new TextEncoder();
/** 最小 PDF（%PDF 魔数 + 可读正文，用于字节一致性断言）。 */
const PDF_BYTES = enc.encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n- 预览测试内容 -');
/** PNG 魔数开头字节。 */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...enc.encode('-png-body-')]);
/** JPEG（SOI+APP0）魔数开头字节。 */
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...enc.encode('-jpeg-body-')]);
/** GIF89a 魔数开头字节。 */
const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...enc.encode('-gif-body-')]);
/** BMP（BM）魔数开头字节。 */
const BMP_BYTES = new Uint8Array([0x42, 0x4d, ...enc.encode('-bmp-body-')]);
/** TIFF（II*\0）魔数开头字节：无安全预览通道，应 415 降级。 */
const TIFF_BYTES = new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, ...enc.encode('-tiff-body-')]);

/**
 * 构造最小 ZIP（store 方式，含完整 EOCD 与中央目录）。
 * 后端只读取中央目录条目名判定是否 Word OOXML，故 CRC 可置 0。
 */
function buildZip(entries) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(0, 6); // flags + method(store)
    local.writeUInt32LE(0, 10); // time + date
    local.writeUInt32LE(0, 14); // crc32（不校验）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const localFull = Buffer.concat([local, nameBuf, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(0, 8); // flags + method
    central.writeUInt32LE(0, 12); // time + date
    central.writeUInt32LE(0, 16); // crc32
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 30); // extra + comment + disk + internal attr
    central.writeUInt32LE(0, 38); // external attr
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));

    parts.push(localFull);
    offset += localFull.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, eocd]));
}

/** 合法 DOCX（OOXML 标记 + word 主文档）：交前端 SDK 渲染，不内联。 */
const DOCX_BYTES = buildZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
  ['_rels/.rels', '<?xml version="1.0"?><Relationships/>'],
  ['word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="urn:x"/>'],
]);
/** 合法 XLSX / PPTX（与 SDK 相同的中央目录判定口径）。 */
const XLSX_BYTES = buildZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
  ['_rels/.rels', '<?xml version="1.0"?><Relationships/>'],
  ['xl/workbook.xml', '<?xml version="1.0"?><workbook/>'],
]);
const PPTX_BYTES = buildZip([
  ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
  ['_rels/.rels', '<?xml version="1.0"?><Relationships/>'],
  ['ppt/presentation.xml', '<?xml version="1.0"?><p:presentation xmlns:p="urn:p"/>'],
]);
/** 合法 OFD（ofd.xml + doc_<n>/document.xml）。 */
const OFD_BYTES = buildZip([
  ['ofd.xml', '<?xml version="1.0"?><ofd:OFD xmlns:ofd="urn:ofd"/>'],
  ['doc_0/document.xml', '<?xml version="1.0"?><ofd:Document/>'],
]);
/** 文本类：TXT / MD / HTML 均应以 octet-stream 受控流交 SDK，绝不以主动内容 MIME 内联。 */
const TXT_BYTES = enc.encode('纯文本预览内容\n第二行\n');
const MD_BYTES = enc.encode('# 预览标题\n\n- 条目一\n');
const HTML_BYTES = enc.encode('<!doctype html><html><body><script>alert(1)</script>正文</body></html>');
/** 普通 ZIP 压缩包（无 SDK 支持的包条目）：预览无意义，必须 415。 */
const ZIP_BYTES = buildZip([['readme.txt', 'plain archive body']]);
/** 伪装 .png 的 HTML 主动内容（绝不允许以 text/html 内联）。 */
const FAKE_PNG_HTML = enc.encode('<html><script>alert(1)</script></html>');
/** 伪装 .pdf 的 SVG 主动内容（绝不允许以 image/svg+xml 内联）。 */
const FAKE_PDF_SVG = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(2)</script></svg>');

let adminCookie = '';
const cookies = {};
const ids = {}; // 业务对象 id

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201, `登录应成功：${u.username}`);
  return r.cookie;
}

/** 著录员在指定档案下上传裸流附件，返回附件视图。 */
async function upload(archiveId, name, bytes, cookie) {
  const r = await req(
    `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,
    { method: 'POST', cookie, raw: true, body: bytes, headers: { 'Content-Type': 'application/octet-stream' } },
  );
  assert.equal(r.status, 201, `上传应成功：${name} → ${JSON.stringify(r.data)}`);
  return r.data;
}

async function createArchive(title, accessLevel) {
  const created = await req('/api/archives', {
    method: 'POST',
    cookie: cookies.cataloger,
    body: { title, categoryId: ids.cat, archiveType: '文书档案', accessLevel },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

test.describe('JitArchives · V1.0 多格式在线预览自动化验证', { concurrency: false }, async () => {
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

  await test('准备：初始化管理员与四类角色，建立公开/受限档案与多格式附件', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      cookies[key] = await login(USERS[key]);
    }
    const cat = await req('/api/categories', { method: 'POST', cookie: adminCookie, body: { name: '预览测试类', code: 'YP' } });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;

    const pub = await createArchive('公开多格式档案', 'public');
    ids.pubArc = pub.id;
    const rest = await createArchive('受限预览档案', 'restricted');
    ids.restArc = rest.id;

    ids.pdf = (await upload(ids.pubArc, '测试文件.pdf', PDF_BYTES, cookies.cataloger)).id;
    ids.png = (await upload(ids.pubArc, '图片.png', PNG_BYTES, cookies.cataloger)).id;
    ids.jpg = (await upload(ids.pubArc, '照片.jpg', JPG_BYTES, cookies.cataloger)).id;
    ids.gif = (await upload(ids.pubArc, '动图.gif', GIF_BYTES, cookies.cataloger)).id;
    ids.bmp = (await upload(ids.pubArc, '位图.bmp', BMP_BYTES, cookies.cataloger)).id;
    ids.tiff = (await upload(ids.pubArc, '扫描件.tif', TIFF_BYTES, cookies.cataloger)).id;
    ids.docx = (await upload(ids.pubArc, '文稿.docx', DOCX_BYTES, cookies.cataloger)).id;
    ids.xlsx = (await upload(ids.pubArc, '表格.xlsx', XLSX_BYTES, cookies.cataloger)).id;
    ids.pptx = (await upload(ids.pubArc, '演示.pptx', PPTX_BYTES, cookies.cataloger)).id;
    ids.ofd = (await upload(ids.pubArc, '版式.ofd', OFD_BYTES, cookies.cataloger)).id;
    ids.txt = (await upload(ids.pubArc, '说明.txt', TXT_BYTES, cookies.cataloger)).id;
    ids.md = (await upload(ids.pubArc, '说明.md', MD_BYTES, cookies.cataloger)).id;
    ids.html = (await upload(ids.pubArc, '页面.html', HTML_BYTES, cookies.cataloger)).id;
    ids.zip = (await upload(ids.pubArc, '打包.zip', ZIP_BYTES, cookies.cataloger)).id;
    ids.fakePng = (await upload(ids.pubArc, '伪装.png', FAKE_PNG_HTML, cookies.cataloger)).id;
    ids.fakePdf = (await upload(ids.pubArc, '伪装.pdf', FAKE_PDF_SVG, cookies.cataloger)).id;
    ids.restPdf = (await upload(ids.restArc, '受限附件.pdf', PDF_BYTES, cookies.cataloger)).id;

    // 已归档档案（DOCX 附件）：归档后预览仍应可用
    const archArc = await createArchive('归档预览档案', 'public');
    ids.archArc = archArc.id;
    ids.archDocx = (await upload(ids.archArc, '归档文稿.docx', DOCX_BYTES, cookies.cataloger)).id;
    const archived = await req(`/api/archives/${ids.archArc}/transition-archive`, {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(archived.status, 201, JSON.stringify(archived.data));

    // 文件版本预览：版本入库仅接受 docx（documentEdit：管理员）
    const verArc = await createArchive('版本预览档案', 'public');
    ids.verArc = verArc.id;
    const verUp = await req(`/api/archives/${ids.verArc}/versions?name=${encodeURIComponent('导出件.docx')}`, {
      method: 'POST',
      cookie: adminCookie,
      raw: true,
      body: DOCX_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(verUp.status, 201, JSON.stringify(verUp.data));
    ids.version = verUp.data.id;
    const verArchived = await req(`/api/archives/${ids.verArc}/transition-archive`, {
      method: 'POST',
      cookie: adminCookie,
    });
    assert.equal(verArchived.status, 201, JSON.stringify(verArchived.data));

    // 受限档案的版本：未获借阅授权前预览必须 403
    const restVer = await req(`/api/archives/${ids.restArc}/versions?name=${encodeURIComponent('受限导出.docx')}`, {
      method: 'POST',
      cookie: adminCookie,
      raw: true,
      body: DOCX_BYTES,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(restVer.status, 201, JSON.stringify(restVer.data));
    ids.restVersion = restVer.data.id;
  });

  // ==================== 1. PDF 预览 ====================

  await test('PDF 预览：200 + application/pdf + inline + nosniff，字节与磁盘一致', async () => {
    const r = await req(`/api/archive-files/${ids.pdf}/preview`, { cookie: cookies.cataloger });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    const disp = r.headers.get('content-disposition') ?? '';
    assert.ok(disp.startsWith('inline;'), `应为 inline 展示：${disp}`);
    assert.ok(/filename\*=UTF-8''/.test(disp), '应携带 RFC5987 中文文件名');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual([...r.bytes], [...PDF_BYTES], '预览字节必须与上传内容一致');
    assert.equal(Number(r.headers.get('content-length')), PDF_BYTES.length);
  });

  // ==================== 2. 图片预览 ====================

  await test('图片预览：PNG/JPG/GIF/BMP 均按真实字节返回对应 image/* 且字节一致', async () => {
    const cases = [
      [ids.png, 'image/png'],
      [ids.jpg, 'image/jpeg'],
      [ids.gif, 'image/gif'],
      [ids.bmp, 'image/bmp'],
    ];
    const source = { [ids.png]: PNG_BYTES, [ids.jpg]: JPG_BYTES, [ids.gif]: GIF_BYTES, [ids.bmp]: BMP_BYTES };
    for (const [fileId, mime] of cases) {
      const r = await req(`/api/archive-files/${fileId}/preview`, { cookie: cookies.cataloger });
      assert.equal(r.status, 200, `图片预览应成功：${mime}`);
      assert.equal(r.headers.get('content-type'), mime);
      assert.ok((r.headers.get('content-disposition') ?? '').startsWith('inline;'));
      assert.deepEqual([...r.bytes], [...source[fileId]], `字节应一致：${mime}`);
    }
  });

  // ==================== 3. 未登录 ====================

  await test('未登录预览一律 401，不返回任何文件字节', async () => {
    for (const fileId of [ids.pdf, ids.png, ids.restPdf]) {
      const r = await req(`/api/archive-files/${fileId}/preview`);
      assert.equal(r.status, 401, `未登录必须 401：fileId=${fileId}`);
      assert.equal(r.bytes, null, '401 响应不得携带文件字节');
    }
  });

  // ==================== 4. 无权限用户 ====================

  await test('权限：借阅者未授权不能预览受限档案；访客角色不能经预览获取文件字节', async () => {
    const byBorrower = await req(`/api/archive-files/${ids.restPdf}/preview`, { cookie: cookies.borrower });
    assert.equal(byBorrower.status, 403, '借阅者未获授权预览受限档案必须 403');
    assert.equal(byBorrower.bytes, null, '403 响应不得携带文件字节');

    const guestPublicPdf = await req(`/api/archive-files/${ids.pdf}/preview`, { cookie: cookies.guest });
    assert.equal(guestPublicPdf.status, 403, '访客不得以预览绕过「访客无原文获取权」的下载限制');
    assert.equal(guestPublicPdf.bytes, null);

    const guestDetail = await req(`/api/archives/${ids.pubArc}`, { cookie: cookies.guest });
    assert.equal(guestDetail.status, 200, '访客仍可浏览公开档案目录级著录信息（预览权限独立于详情查看）');
  });

  // ==================== 4b. 详情接口的附件授权标志（前端按钮显隐唯一依据） ====================

  await test('详情返回档案级附件授权：访客无文件查看权，可下载角色按后端规则放开', async () => {
    // 访客：可看公开档案著录信息，但不得因「文件格式可预览」而出现预览/下载入口。
    const guestPublic = await req(`/api/archives/${ids.pubArc}`, { cookie: cookies.guest });
    assert.equal(guestPublic.status, 200);
    assert.equal(guestPublic.data.permissions?.canDownload, false, '访客对公开档案也不得有附件授权');

    // 普通可下载角色（著录员/审核员/借阅者）对公开档案：授权为真。
    for (const key of ['cataloger', 'reviewer', 'borrower']) {
      const r = await req(`/api/archives/${ids.pubArc}`, { cookie: cookies[key] });
      assert.equal(r.status, 200, `应可查看公开档案：${key}`);
      assert.equal(r.data.permissions?.canDownload, true, `${key} 对公开档案应有附件授权`);
    }

    // 未授权受限档案：详情本身 403，不返回任何授权标志或档案内容（前端无从渲染操作按钮）。
    const borrowerRestricted = await req(`/api/archives/${ids.restArc}`, { cookie: cookies.borrower });
    assert.equal(borrowerRestricted.status, 403, '未获借阅授权的受限档案详情必须 403');
    assert.equal(borrowerRestricted.data?.permissions, undefined, '403 响应不得携带授权标志');

    // 授权标志不得虚报：同一访客走真实预览仍被 403 拦截。
    const guestPreview = await req(`/api/archive-files/${ids.pdf}/preview`, { cookie: cookies.guest });
    assert.equal(guestPreview.status, 403);
  });

  // ==================== 8b. DOCX 预览（JitWord-Preview SDK 通道） ====================

  await test('DOCX 预览：200 + octet-stream + attachment，字节与磁盘一致且不内联执行', async () => {
    const r = await req(`/api/archive-files/${ids.docx}/preview`, { cookie: cookies.cataloger });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    const disp = r.headers.get('content-disposition') ?? '';
    assert.ok(disp.startsWith('attachment;'), `DOCX 必须走附件通道：${disp}`);
    assert.ok(/filename\*=UTF-8''/.test(disp), '应携带 RFC5987 中文文件名');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual([...r.bytes], [...DOCX_BYTES], '预览字节必须与上传内容一致');
  });

  await test('SDK 支持格式：XLSX/PPTX/OFD/TXT/MD/HTML 均以 octet-stream 受控流下发', async () => {
    const cases = [
      [ids.xlsx, XLSX_BYTES, 'XLSX'],
      [ids.pptx, PPTX_BYTES, 'PPTX'],
      [ids.ofd, OFD_BYTES, 'OFD'],
      [ids.txt, TXT_BYTES, 'TXT'],
      [ids.md, MD_BYTES, 'MD'],
      [ids.html, HTML_BYTES, 'HTML'],
    ];
    for (const [fileId, source, label] of cases) {
      const r = await req(`/api/archive-files/${fileId}/preview`, { cookie: cookies.cataloger });
      assert.equal(r.status, 200, `${label} 预览应成功：${JSON.stringify(r.data)}`);
      assert.equal(r.headers.get('content-type'), 'application/octet-stream', `${label} 必须走字节流通道`);
      const disp = r.headers.get('content-disposition') ?? '';
      assert.ok(disp.startsWith('attachment;'), `${label} 必须走附件通道：${disp}`);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual([...r.bytes], [...source], `${label} 预览字节必须与上传内容一致`);
      // HTML 属于主动内容：即使受 SDK 支持，也绝不能以 text/html 内联返回。
      assert.ok(!String(r.headers.get('content-type')).includes('text/html'), 'HTML 不得以 text/html 内联');
    }
  });

  await test('归档后 DOCX 附件仍可预览；文件版本可预览，跨档案版本 404、无授权 403', async () => {
    const archivedDocx = await req(`/api/archive-files/${ids.archDocx}/preview`, { cookie: cookies.cataloger });
    assert.equal(archivedDocx.status, 200, '已归档档案的附件应可预览');
    assert.equal(archivedDocx.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...archivedDocx.bytes], [...DOCX_BYTES]);

    const version = await req(`/api/archives/${ids.verArc}/versions/${ids.version}/preview`, {
      cookie: cookies.cataloger,
    });
    assert.equal(version.status, 200, JSON.stringify(version.data));
    assert.equal(version.headers.get('content-type'), 'application/octet-stream');
    assert.ok((version.headers.get('content-disposition') ?? '').startsWith('attachment;'));
    assert.deepEqual([...version.bytes], [...DOCX_BYTES], '版本预览字节应与入库内容一致');

    const cross = await req(`/api/archives/${ids.pubArc}/versions/${ids.version}/preview`, {
      cookie: cookies.cataloger,
    });
    assert.equal(cross.status, 404, '版本不属于该档案必须 404');
    assert.equal(cross.bytes, null);

    const restrictedVersion = await req(`/api/archives/${ids.restArc}/versions/${ids.restVersion}/preview`, {
      cookie: cookies.borrower,
    });
    assert.equal(restrictedVersion.status, 403, '未获借阅授权不得预览受限档案版本');
    assert.equal(restrictedVersion.bytes, null);
  });

  // ==================== 5/6/9. 借阅授权与失效 ====================

  await test('借阅授权：审核通过后受限档案允许预览，字节与下载一致', async () => {
    const apply = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower, body: { archiveId: ids.restArc, purpose: '项目审计需要', days: 30 },
    });
    assert.equal(apply.status, 201, JSON.stringify(apply.data));
    ids.borrowRest = apply.data.id;
    const approve = await req(`/api/borrow-requests/${ids.borrowRest}/approve`, {
      method: 'POST', cookie: cookies.reviewer, body: { note: '同意借阅' },
    });
    assert.equal(approve.status, 201, JSON.stringify(approve.data));

    // 有效借阅授权：详情应返回附件授权为真，前端才展示预览/下载入口。
    const grantedDetail = await req(`/api/archives/${ids.restArc}`, { cookie: cookies.borrower });
    assert.equal(grantedDetail.status, 200, '授权后可查看受限档案详情');
    assert.equal(grantedDetail.data.permissions?.canDownload, true, '借阅授权后详情应放开附件授权');

    const pv = await req(`/api/archive-files/${ids.restPdf}/preview`, { cookie: cookies.borrower });
    assert.equal(pv.status, 200, '授权后借阅者可预览受限附件');
    assert.equal(pv.headers.get('content-type'), 'application/pdf');
    assert.deepEqual([...pv.bytes], [...PDF_BYTES]);

    // 预览与下载传输的字节必须完全一致（预览不是弱化通道）
    const dl = await req(`/api/archive-files/${ids.restPdf}/download`, { cookie: cookies.borrower });
    assert.equal(dl.status, 200);
    assert.deepEqual([...dl.bytes], [...pv.bytes], '预览与下载字节应一致');
  });

  await test('归还后预览权限立即失效（下载同时失效，预览不构成旁路）', async () => {
    const ret = await req(`/api/borrow-requests/${ids.borrowRest}/return`, { method: 'POST', cookie: cookies.borrower });
    assert.equal(ret.status, 201, JSON.stringify(ret.data));

    const detailAfter = await req(`/api/archives/${ids.restArc}`, { cookie: cookies.borrower });
    assert.equal(detailAfter.status, 403, '归还后受限档案详情立即 403（授权标志随之消失）');

    const pv = await req(`/api/archive-files/${ids.restPdf}/preview`, { cookie: cookies.borrower });
    assert.equal(pv.status, 403, '归还后预览必须 403');
    assert.equal(pv.bytes, null);
    const dl = await req(`/api/archive-files/${ids.restPdf}/download`, { cookie: cookies.borrower });
    assert.equal(dl.status, 403, '归还后下载必须 403');
  });

  await test('到期后预览权限失效：过期授权惰性置 expired 后立即 403', async () => {
    const apply = await req('/api/borrow-requests', {
      method: 'POST', cookie: cookies.borrower, body: { archiveId: ids.restArc, purpose: '短期查阅', days: 2 },
    });
    assert.equal(apply.status, 201);
    ids.borrowExpiring = apply.data.id;
    const approve = await req(`/api/borrow-requests/${ids.borrowExpiring}/approve`, {
      method: 'POST', cookie: cookies.reviewer, body: {},
    });
    assert.equal(approve.status, 201);
    const before = await req(`/api/archive-files/${ids.restPdf}/preview`, { cookie: cookies.borrower });
    assert.equal(before.status, 200, '到期前预览应放行');

    // 直接把授权到期时间改到过去，模拟借阅到期（findActive 惰性失效）
    const sqlite = new DatabaseSync(DB_FILE);
    sqlite
      .prepare("UPDATE borrow_grants SET expires_at = datetime('now','-1 day') WHERE borrow_id = ?")
      .run(ids.borrowExpiring);
    sqlite.close();

    const after = await req(`/api/archive-files/${ids.restPdf}/preview`, { cookie: cookies.borrower });
    assert.equal(after.status, 403, '到期后预览权限必须失效');
    assert.equal(after.bytes, null);
  });

  // ==================== 7. 路径穿越与伪造存储名 ====================

  await test('文件定位安全：非法 fileId（穿越串）、不存在 id、伪造库内存储指向均不能越权读取', async () => {
    const traversal = await req('/api/archive-files/..%2F..%2Fstorage%2Fmain/preview', { cookie: adminCookie });
    assert.ok([400, 404].includes(traversal.status), `路径穿越必须被拒绝：${traversal.status}`);

    const missing = await req('/api/archive-files/99999999/preview', { cookie: adminCookie });
    assert.equal(missing.status, 404, '不存在附件应 404');

    // 伪造场景一：客户端直接拿物理存储名当 fileId 请求 → ParseIntPipe 400，接口不接受任意文件名。
    const nameAsId = new DatabaseSync(DB_FILE)
      .prepare('SELECT stored_name FROM archive_files WHERE id = ?')
      .get(ids.restPdf).stored_name;
    const byStoredName = await req(`/api/archive-files/${encodeURIComponent(String(nameAsId))}/preview`, { cookie: adminCookie });
    assert.equal(byStoredName.status, 400, '物理存储名不能当 fileId 直取');
    assert.equal(byStoredName.bytes, null);

    // 伪造场景二（纵深防御）：即使库内 stored_name 被篡改指向他人文件，
    // 权限仍按「fileId → 归属档案 → 授权」判定；指向不存在的存储名则 404。
    const sqlite = new DatabaseSync(DB_FILE);
    const target = sqlite
      .prepare('SELECT stored_name FROM archive_files WHERE id = ?')
      .get(ids.restPdf);
    // UNIQUE(stored_name) 禁止两行共用同一物理名，故用越界假想名验证「元数据与磁盘不一致时不放行」
    sqlite.prepare('UPDATE archive_files SET stored_name = ? WHERE id = ?').run('f'.repeat(32) + '.pdf', ids.png);
    sqlite.close();

    const forgedPng = await req(`/api/archive-files/${ids.png}/preview`, { cookie: cookies.cataloger });
    assert.equal(forgedPng.status, 404, '存储标识指向不存在的物理文件必须 404，不得盲读其他文件');
    assert.equal(forgedPng.bytes, null);

    const asGuest = await req(`/api/archive-files/${ids.png}/preview`, { cookie: cookies.guest });
    assert.ok([403, 404].includes(asGuest.status), `访客对伪造指向的附件无法取得字节：${asGuest.status}`);

    // 任意文件名直取物理文件：存储目录未静态托管，绕过接口不可达
    const direct = await req(`/${encodeURIComponent(path.basename(String(target.stored_name)))}`);
    assert.ok([401, 404].includes(direct.status), `物理文件名直取必须被拒绝：${direct.status}`);
  });

  // ==================== 8. 不支持类型安全拒绝 ====================

  await test('无安全预览通道的格式：415 + 通俗中文原因，不虚假放行', async () => {
    const cases = [
      [ids.tiff, 'TIFF'],
      [ids.zip, '压缩包'],
    ];
    for (const [fileId, keyword] of cases) {
      const r = await req(`/api/archive-files/${fileId}/preview`, { cookie: cookies.cataloger });
      assert.equal(r.status, 415, `应 415 拒绝：fileId=${fileId}`);
      assert.ok(String(r.data?.message ?? '').includes(keyword), `提示应包含「${keyword}」：${JSON.stringify(r.data)}`);
      assert.equal(r.bytes, null, '415 响应不得携带文件字节');
    }
    // .doc（OLE2）：扩展名在上传白名单内，真实字节判定后同样拒绝内联
    const oldDoc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...enc.encode('-doc-body-')]);
    const docFile = await upload(ids.pubArc, '旧文档.doc', oldDoc, cookies.cataloger);
    const docPreview = await req(`/api/archive-files/${docFile.id}/preview`, { cookie: cookies.cataloger });
    assert.equal(docPreview.status, 415, '.doc 无安全内联格式应 415');
  });

  // ==================== 12. 主动内容绝不内联 ====================

  await test('主动内容防护：伪装 png/pdf 的 HTML、SVG 一律不按 text/html 或 svg 内联', async () => {
    for (const fileId of [ids.fakePng, ids.fakePdf]) {
      const r = await req(`/api/archive-files/${fileId}/preview`, { cookie: adminCookie });
      assert.equal(r.status, 415, `伪装主动内容必须拒绝内联：fileId=${fileId}`);
      const ct = r.headers.get('content-type') ?? '';
      assert.ok(!ct.includes('text/html') && !ct.includes('image/svg+xml'), `不得以主动内容类型返回：${ct}`);
      assert.equal(r.bytes, null);
    }
  });

  // ==================== 11. Range 分段读取 ====================

  await test('Range：单段 206 正确切片，越界 416，浏览器 PDF 查看器所需头齐备', async () => {
    const part = await req(`/api/archive-files/${ids.pdf}/preview`, {
      cookie: cookies.cataloger,
      headers: { Range: 'bytes=0-9' },
    });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 0-9/${PDF_BYTES.length}`);
    assert.deepEqual([...part.bytes], [...PDF_BYTES.slice(0, 10)]);

    const tail = await req(`/api/archive-files/${ids.pdf}/preview`, {
      cookie: cookies.cataloger,
      headers: { Range: `bytes=${PDF_BYTES.length - 5}-` },
    });
    assert.equal(tail.status, 206);
    assert.deepEqual([...tail.bytes], [...PDF_BYTES.slice(-5)]);

    const bad = await req(`/api/archive-files/${ids.pdf}/preview`, {
      cookie: cookies.cataloger,
      headers: { Range: `bytes=${PDF_BYTES.length + 10}-` },
    });
    assert.equal(bad.status, 416, '越界 Range 必须 416');
    assert.ok(String(bad.headers.get('content-range') ?? '').startsWith('bytes */'), '416 应携带总长度');

    const multi = await req(`/api/archive-files/${ids.pdf}/preview`, {
      cookie: cookies.cataloger,
      headers: { Range: 'bytes=0-1,3-4' },
    });
    assert.equal(multi.status, 416, '多段 Range 明确拒绝，不做部分假装');
  });

  // ==================== 9/10. 下载回归 + 权限同源 ====================

  await test('回归：原有下载不受影响，预览与下载授权同源（预览非更弱通道）', async () => {
    const dl = await req(`/api/archive-files/${ids.pdf}/download`, { cookie: cookies.cataloger });
    assert.equal(dl.status, 200, '著录员（创建者）下载仍正常');
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.ok((dl.headers.get('content-disposition') ?? '').startsWith('attachment;'), '下载仍为附件通道');
    assert.deepEqual([...dl.bytes], [...PDF_BYTES]);

    // 借阅者对公开档案：预览与下载同时放行（同集合同源授权）。
    // 注：ids.png 的 stored_name 已在安全用例中被改为越界假想名，此处只能 404（不得盲读其他文件）
    const pv = await req(`/api/archive-files/${ids.png}/preview`, { cookie: cookies.borrower });
    assert.equal(pv.status, 404, '指向不存在存储名的附件不得放行');
    const pvPdf = await req(`/api/archive-files/${ids.pdf}/preview`, { cookie: cookies.borrower });
    assert.equal(pvPdf.status, 200);
    const dlB = await req(`/api/archive-files/${ids.pdf}/download`, { cookie: cookies.borrower });
    assert.equal(dlB.status, 200);

    // 访客两者同时拒绝（预览未开放更弱通道）
    const gpv = await req(`/api/archive-files/${ids.pdf}/preview`, { cookie: cookies.guest });
    const gdl = await req(`/api/archive-files/${ids.pdf}/download`, { cookie: cookies.guest });
    assert.equal(gpv.status, 403);
    assert.equal(gdl.status, 403);

    // 上传白名单回归：非法扩展名仍被拒绝
    const exe = await req(
      `/api/archive-files/upload?archiveId=${ids.pubArc}&name=${encodeURIComponent('木马.exe')}`,
      { method: 'POST', cookie: cookies.cataloger, raw: true, body: PDF_BYTES, headers: { 'Content-Type': 'application/octet-stream' } },
    );
    assert.equal(exe.status, 400, '扩展名白名单回归不破');
  });

  // ==================== 13. 审计留痕 ====================

  await test('审计留痕：成功预览与越权预览失败均落审计（管理员可查）', async () => {
    const ok = await req(`/api/audit?action=${encodeURIComponent('file.preview')}`, { cookie: adminCookie });
    assert.equal(ok.status, 200);
    assert.ok(ok.data.items.some((it) => it.objectId === String(ids.pdf)), '成功预览应留痕 file.preview');

    const denied = await req(`/api/audit?action=${encodeURIComponent('file.preview_denied')}`, { cookie: adminCookie });
    assert.equal(denied.status, 200);
    assert.ok(denied.data.items.length > 0, '越权预览尝试应留痕 failure 记录');

    const actions = await req('/api/audit/actions', { cookie: adminCookie });
    assert.ok(actions.data.actions.includes('file.preview'), '预览动作应进入审计枚举');
  });
});
