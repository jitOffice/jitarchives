import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
/**
 * JitArchives 档案 Agent 第二阶段 · 附件全文检索与 AI 内容问答后端自动化验证（node:test）
 *
 * 隔离：独立测试库（storage/test-content-<pid>.db）+ 独立文件存储目录 + 桩模型客户端（绝不触网），
 * 不触碰正式库与其他回归用例。
 * 覆盖交付指令第八节验收点：
 *  1. DOCX / PDF / TXT 真实正文提取（按磁盘字节判定），并对 .doc / 图片给出明确不支持状态；
 *  2. 只出现在附件正文里的关键词能定位到档案（不是靠标题/档号命中）；
 *  3. 依据真实检索到的正文片段回答，答案编号与来源清单逐条对应；
 *  4. 证据不足时明确拒绝作答，不编造条款、金额、期限；伪造引用编号一律剔除并降级；
 *  5. 引用来源含真实档案/附件/版本/段落或页码位置，且与检索到的原文一致；
 *  6. 文件新版本入库后，旧版本正文不再被检索命中；重复重建索引不产生重复单元；
 *  7. 无权限角色的正文检索被可见性 SQL 拦截，受限正文既不返回也不进入模型 prompt；
 *  8. 会话与内容按用户隔离（他人会话一律 404）；
 *  9. 模型未配置 / 调用异常时的降级诚实标注，不伪装 AI 归纳；
 * 10. 原有目录检索、附件上传下载、正文不进审计 detail 等回归。
 * 运行：npm run build:api 后 node --test test/content-search.e2e.test.mjs
 */
import test from 'node:test';
import { readPlannerFixture } from './helpers/read-planner-fixture.mjs';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import PizZip from 'pizzip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-content-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-content-store-${process.pid}`);

let baseUrl = null;
let currentApp = null;

/**
 * 可控模型桩：available=false 表示未配置 DeepSeek（服务层不得调用）；
 * 记录最后一次收到的 messages，用于证明「只有检索到的相关片段被送出，无权正文没有送出」。
 */
const modelStub = {
  available: false,
  model: 'stub-deepseek',
  nextContent: '',
  throwOnCall: null,
  calls: 0,
  lastMessages: null,
  async chatCompletion(messages) {
    // This legacy suite exercises answer and fallback behavior. Planning is tested independently.
    const planning=readPlannerFixture(messages);if(planning)return planning;
    this.calls += 1;
    this.lastMessages = messages;
    if (!this.available) throw new Error('模型未配置');
    if (this.throwOnCall) throw this.throwOnCall;
    return { content: this.nextContent, truncated: false };
  },
};

async function startServer() {
  const modPath = path.join(__dirname, '..', 'dist', 'main.js');
  const { bootstrap } = await import(`${pathToFileURL(modPath).href}?v=${process.pid}-${Date.now()}`);
  const result = await bootstrap({
    port: 0,
    dbFile: DB_FILE,
    fileStoreDir: FILE_STORE,
    serveWeb: false, knowledgeWorker: false,
    aiModelClient: modelStub,
  });
  currentApp = result.app;
  baseUrl = result.baseUrl;
}

async function req(pathname, { method = 'GET', body, cookie, raw, headers: extra } = {}) {
  const headers = { ...(raw ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(extra || {}) };
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
  let newCookie = cookie;
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, cookie: newCookie, text };
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

// ==================== 真实可提取的测试文件构造 ====================

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
/** DOCX：每个字符串一个自然段落（word/document.xml 的 w:p）。 */
function buildDocx(paragraphs) {
  const zip = new PizZip();
  zip.file(
    '[Content_Types].xml',
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('');
  zip.file(
    'word/document.xml',
    `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generate({ type: 'nodebuffer' });
}

/** UTF-16BE 十六进制串（UniGB-UCS2-H 形态下 CID 即 Unicode 码位）。 */
function ucs(text) {
  const buf = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i += 1) buf.writeUInt16BE(text.charCodeAt(i), i * 2);
  return buf.toString('hex').toUpperCase();
}

/** 中文 PDF 常见形态：Type0 字体 + UniGB-UCS2-H 编码 + 未压缩内容流（每行一个 Tj）。 */
function buildCjkPdf(lines) {
  const ops = ['BT /F1 12 Tf 72 760 Td 14 TL', String.fromCharCode(10)];
  lines.forEach((line, i) => {
    const eol = String.fromCharCode(10);
    ops.push(i === 0 ? `<${ucs(line)}> Tj${eol}` : `T* <${ucs(line)}> Tj${eol}`);
  });
  ops.push('ET');
  const content = Buffer.from(ops.join(''), 'latin1');
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type0/BaseFont/STSong-Light/Encoding/UniGB-UCS2-H/DescendantFonts[6 0 R]>>',
    `<</Length ${content.length}>> stream ${content.toString('latin1')} endstream`,
    '<</Type/Font/Subtype/CIDFontType0/BaseFont/STSong-Light>>',
  ];
  const NL = String.fromCharCode(10);
  let out = `%PDF-1.4${NL}`;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj ${body} endobj${NL}`;
  });
  const xrefPos = Buffer.byteLength(out, 'latin1');
  out += `xref 0 ${objs.length + 1} 0000000000 65535 f ${NL}`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n ${NL}`;
  out += `trailer <</Size ${objs.length + 1}/Root 1 0 R>> startxref ${xrefPos} %%EOF${NL}`;
  return Buffer.from(out, 'latin1');
}

/** 旧版 .doc：OLE2 复合文档魔数（按字节即判定为「暂不支持」）。 */
const DOC_OLE2_BYTES = Buffer.concat([
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
  Buffer.alloc(512, 0x20),
]);
/** 伪装成附件的 JPEG：只能靠 OCR 取正文，本阶段必须给出不支持状态。 */
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('JFIF dummy image bytes', 'latin1'),
  Buffer.from([0xff, 0xd9]),
]);

const ADMIN = { username: 'ct_root', displayName: '总管理员', password: 'Admin#12345' };
const USERS = {
  cat: { username: 'ct_cat', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  bor: { username: 'ct_bor', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
};
let adminCookie = '';
const cookies = {};
const ids = {};

/** 正文关键词（刻意与标题/档号/关键词字段都不重叠，确保命中只可能来自正文）。 */
const BODY_PAYMENT_OLD = '付款条件：验收合格后十五个工作日内支付合同总价的百分之三十尾款。';
const BODY_TERM_OLD = '履约期限：自合同签订之日起一百八十日内完成全部交付与初验。';
const BODY_TERM_NEW = '履约期限：自合同签订之日起九十日内完成全部交付，逾期每日按千分之五计违约金。';
const BODY_PDF = '保密条款：乙方对甲方提供的全部技术资料承担保密义务，保密期限三年。';
const BODY_TXT = '补充协议：争议解决由甲方住所地人民法院管辖。';
const BODY_SECRET = '玄鸟项目专用付款条款：全部款项于交付后一次性支付，不分期。';

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201, `登录应成功：${u.username}`);
  return r.cookie;
}

async function createArchive(title, { categoryId, accessLevel, keywords = '' }) {
  const body = { title, categoryId, archiveType: '文书档案', keywords };
  if (accessLevel) body.accessLevel = accessLevel;
  const created = await req('/api/archives', { method: 'POST', cookie: cookies.cat, body });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

/** 裸流上传附件。 */
async function upload(archiveId, name, bytes, cookie) {
  const uploaded = await req(
    `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      cookie,
      raw: true,
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream' },
    },
  );
  // This fixture explicitly completes the queued job before testing retrieval.
  if (uploaded.status === 201) currentApp.get(ContentIndexService).indexFileById(uploaded.data.id);
  return uploaded;
}

async function ask(cookie, body) {
  return req('/api/agent/ask', { method: 'POST', cookie, body });
}

/** 取正文索引状态（按档案）。 */
async function contentStatus(archiveId, cookie) {
  return req(`/api/archives/${archiveId}/content/status`, { cookie });
}

function findFileStatus(items, name) {
  return items.find((f) => f.fileName === name);
}

test.describe('JitArchives 附件全文检索与 AI 内容问答（第二阶段）自动化验证', { concurrency: false }, async () => {
  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
    await startServer();
  });

  test.after(async () => {
    if (currentApp) await currentApp.close();
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
  });

  await test('准备：角色、分类、公开/受限档案与 DOCX/PDF/TXT 附件', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      cookies[key] = await login(USERS[key]);
    }
    const cat = await req('/api/categories', {
      method: 'POST', cookie: adminCookie, body: { name: '合同类目', code: 'HT' },
    });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;

    const a = await createArchive('设备采购合同甲', { categoryId: ids.cat });
    ids.a = a.id;
    ids.aNo = a.archiveNo;
    const b = await createArchive('设备采购合同乙', {
      categoryId: ids.cat, keywords: '货到付款',
    });
    ids.b = b.id;
    const r = await createArchive('专项采购合同（受限）', {
      categoryId: ids.cat, accessLevel: 'restricted',
    });
    ids.r = r.id;

    const docxA = await upload(ids.a, '主合同.docx', buildDocx([
      '甲方与乙方就设备采购事宜达成如下协议。',
      BODY_PAYMENT_OLD,
      BODY_TERM_OLD,
    ]), cookies.cat);
    assert.equal(docxA.status, 201, JSON.stringify(docxA.data));
    ids.docxA = docxA.data.id;

    const pdfA = await upload(ids.a, '技术附件.pdf', buildCjkPdf([BODY_PDF, '本附件随主合同一并归档。']), cookies.cat);
    assert.equal(pdfA.status, 201, JSON.stringify(pdfA.data));
    const txtA = await upload(
      ids.a,
      '补充协议.txt',
      Buffer.from(`${BODY_TXT}${String.fromCharCode(13, 10)}第二条 本补充协议与主合同不一致的，以主合同为准。${String.fromCharCode(13, 10)}`, 'utf8'),
      cookies.cat,
    );
    assert.equal(txtA.status, 201, 'TXT 附件应在白名单内并成功上传');
    ids.txtA = txtA.data.id;

    const docxB = await upload(ids.b, '交付清单.docx', buildDocx([
      '交付清单包含主机、显示器与键鼠套件。',
      '付款方式为货到付款百分之五十，安装完成后支付余款。',
    ]), cookies.cat);
    assert.equal(docxB.status, 201);
    ids.docxB = docxB.data.id;
    const secret = await upload(ids.r, '专项条款.docx', buildDocx([BODY_SECRET, '玄鸟项目资料不得对外披露。']), cookies.cat);
    assert.equal(secret.status, 201);
    ids.secret = secret.data.id;

    // 上传钩子应已把三份可读附件的正文写入索引
    const st = await contentStatus(ids.a, adminCookie);
    assert.equal(st.status, 200);
    assert.ok(st.data.files.length >= 3, '应返回该档案下附件的正文状态清单');
  });

  // ==================== 1. 正文提取（含明确的不支持状态） ====================

  await test('正文提取：DOCX/PDF/TXT 均按真实字节提取入索引，位置信息可追溯', async () => {
    const st = await contentStatus(ids.a, adminCookie);
    assert.equal(st.status, 200);
    const docx = findFileStatus(st.data.files, '主合同.docx');
    const pdf = findFileStatus(st.data.files, '技术附件.pdf');
    const txt = findFileStatus(st.data.files, '补充协议.txt');
    assert.equal(docx.status, 'indexed', `DOCX 应提取成功：${docx.message}`);
    assert.equal(docx.extractor, 'docx');
    assert.ok(docx.chunkCount >= 1 && docx.charCount > 20, 'DOCX 应有片段与字符统计');
    assert.equal(pdf.status, 'indexed', `PDF 应提取成功：${pdf.message}`);
    assert.equal(pdf.extractor, 'pdf');
    assert.equal(txt.status, 'indexed', `TXT 应提取成功：${txt.message}`);
    assert.equal(txt.extractor, 'txt');

    const db = new DatabaseSync(DB_FILE);
    const rows = db
      .prepare(
        `SELECT c.locator AS locator, c.text AS text, f.extension AS ext
           FROM archive_content_chunks c JOIN archive_files f ON f.id = c.file_id
          WHERE c.archive_id = ? ORDER BY c.id`,
      )
      .all(ids.a);
    db.close();
    const docxRow = rows.find((x) => x.ext === 'docx' && String(x.text).includes('履约期限'));
    const pdfRow = rows.find((x) => x.ext === 'pdf' && String(x.text).includes('保密条款'));
    const txtRow = rows.find((x) => x.ext === 'txt' && String(x.text).includes('争议解决'));
    assert.ok(docxRow, 'DOCX 正文片段应含真实段落文本');
    assert.match(docxRow.locator, /^DOCX 第 \d+(-\d+)? 段$/, `DOCX 位置应为段落：${docxRow.locator}`);
    assert.ok(pdfRow, 'PDF 正文片段应含真实文本层');
    assert.match(pdfRow.locator, /^PDF 第 1 页 第 \d+(-\d+)? 行$/, `PDF 位置应为页+行：${pdfRow.locator}`);
    assert.ok(txtRow, 'TXT 正文片段应存在');
    assert.match(txtRow.locator, /^TXT 第 \d+(-\d+)? 行$/, `TXT 位置应为行号：${txtRow.locator}`);
  });

  await test('格式边界：旧版 .doc 与图片附件给出明确的「不支持」状态而非伪正文', async () => {
    const d1 = await upload(ids.b, '遗留文档.doc', DOC_OLE2_BYTES, cookies.cat);
    assert.equal(d1.status, 201);
    const d2 = await upload(ids.b, '现场照片.jpg', JPEG_BYTES, cookies.cat);
    assert.equal(d2.status, 201);
    const st = await contentStatus(ids.b, adminCookie);
    const docRow = findFileStatus(st.data.files, '遗留文档.doc');
    const imgRow = findFileStatus(st.data.files, '现场照片.jpg');
    assert.equal(docRow.status, 'unsupported');
    assert.match(docRow.message, /docx|不支持/);
    assert.equal(imgRow.status, 'unsupported');
    assert.match(imgRow.message, /OCR/);
    assert.equal(docRow.chunkCount, 0, '不支持的格式不得产生正文片段');
    const db = new DatabaseSync(DB_FILE);
    const n = db
      .prepare('SELECT COUNT(*) AS c FROM archive_content_chunks WHERE file_id IN (?, ?)')
      .get(d1.data.id, d2.data.id);
    db.close();
    assert.equal(Number(n.c), 0, '不支持的格式绝不允许写入正文片段');
  });

  await test('诚实边界：文件名与档案标题不会被当作正文命中', async () => {
    // 「设备采购合同甲」只出现在标题字段，不在任何正文里；正文检索不应把它当证据
    modelStub.available = false;
    const r = await ask(cookies.bor, { question: '保密条款约定了什么内容', clientRequestId: 'name-not-body' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const text = JSON.stringify(r.data.reply.payload.sources || []);
    assert.ok(!text.includes('设备采购合同甲的正文'), '不得用标题拼造正文');
    for (const s of r.data.reply.payload.sources || []) {
      assert.ok(s.excerpt && s.excerpt.length > 4, '来源摘录必须是真实正文');
      assert.notEqual(s.excerpt, s.fileName, '摘录不得等于附件名');
      assert.notEqual(s.excerpt, s.archiveTitle, '摘录不得等于档案标题');
    }
  });

  // ==================== 2. 按正文关键词定位档案 ====================

  await test('正文关键词定位：仅存在于附件正文里的词也能定位到档案（未配置模型时展示原文）', async () => {
    modelStub.available = false;
    const r = await ask(cookies.bor, { question: '履约期限是多长', clientRequestId: 'body-term' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const p = r.data.reply.payload;
    assert.equal(p.intent, 'content_question');
    assert.equal(p.kind, 'content_evidence', '未配置模型时必须降级为原文展示，不得伪造 AI 归纳');
    assert.match(String(p.aiNote), /未配置模型服务/);
    assert.ok((p.retrievedEvidence ?? []).length >= 1, '降级时仍应保留检索到的参考资料');
    const hit = (p.retrievedEvidence ?? []).find((s) => s.archiveId === ids.a);
    assert.ok(hit, '履约期限只写在甲的附件正文里，应据此定位到甲');
    assert.equal(hit.archiveNo, ids.aNo, '来源档号必须真实');
    assert.match(hit.locator, /^DOCX 第 \d+(-\d+)? 段$/, '来源位置必须是真实段落号');
    assert.ok(hit.excerpt.includes('一百八十日'), '摘录必须是检索到的原文');
    assert.equal(hit.detailPath, `/archives/${ids.a}`, '来源需给出既有详情入口');
  });

  await test('比较类问题：跨两份档案取证，来源分别指向各自的真实附件', async () => {
    const scoped = await ask(cookies.bor, { question: '帮我查找设备采购合同', clientRequestId: 'cmp-scope' });
    assert.equal(scoped.status, 201, JSON.stringify(scoped.data));
    assert.equal(scoped.data.reply.payload.kind, 'search');
    const conversationId = scoped.data.conversationId;

    modelStub.available = false;
    const r = await ask(cookies.bor, {
      conversationId,
      question: '比较这两份合同的主要区别',
      clientRequestId: 'cmp-body',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const p = r.data.reply.payload;
    assert.equal(p.intent, 'content_question', '「比较…区别」应走正文取证而不是目录检索');
    const archiveIds = new Set((p.sources || p.retrievedEvidence || []).map((s) => s.archiveId));
    assert.ok(archiveIds.has(ids.a) && archiveIds.has(ids.b), `比较类需跨两份档案取证（实际 ${[...archiveIds].join(',')}）`);
    const hitB = (p.sources || p.retrievedEvidence || []).find((s) => s.archiveId === ids.b);
    assert.ok(hitB.excerpt.includes('货到付款'), '来源摘录必须是对应档案附件的真实正文');
    assert.ok(!(p.sources || p.retrievedEvidence || []).some((s) => s.archiveId === ids.r), '受限档案不得进入比较来源');
  });

  // ==================== 3~5. 依据证据回答 / 证据不足 / 伪造引用 ====================

  await test('基于证据回答：答案编号与来源清单逐条对应，来源含附件与版本与位置', async () => {
    // 取证范围来自本会话的目录检索结果，证据来自该档案多个附件的真实正文片段
    const scoped = await ask(cookies.bor, { question: '帮我查找设备采购合同甲', clientRequestId: 'qa-scope' });
    assert.equal(scoped.status, 201, JSON.stringify(scoped.data));
    assert.equal(scoped.data.reply.payload.kind, 'search');
    const conversationId = scoped.data.conversationId;

    // 探针：未配置模型时返回的 sources 就是本轮全部证据，据此构造「确实存在」的引用编号
    modelStub.available = false;
    const probe = await ask(cookies.bor, {
      conversationId,
      question: '帮我总结这份合同的核心内容',
      clientRequestId: 'qa-probe',
    });
    assert.equal(probe.status, 201, JSON.stringify(probe.data));
    const evidence = probe.data.reply.payload.retrievedEvidence || probe.data.reply.payload.sources || [];
    assert.ok(evidence.length >= 2, `总结类问题应跨附件取证多条正文（实际 ${evidence.length} 条）`);
    const cited = [evidence[0], evidence[1]];

    modelStub.available = true;
    modelStub.throwOnCall = null;
    modelStub.nextContent =
      cited.map(s => `${s.excerpt.replace(/[。！？；\n]/gu, '，')} [${s.ref}]`).join('；') + '。';
    const before = modelStub.calls;
    const r = await ask(cookies.bor, {
      conversationId,
      question: '帮我总结这份合同的核心内容',
      clientRequestId: 'qa-answer',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const p = r.data.reply.payload;
    assert.equal(modelStub.calls, before + 1, '有证据时才调用模型作答');
    assert.equal(p.kind, 'content_answer');
    assert.deepEqual(p.sources.map((s) => s.ref), cited.map((s) => s.ref), '引用编号与来源清单逐条对应');
    for (const s of p.sources) {
      assert.ok(s.archiveTitle && s.archiveNo && s.fileName, '来源必须含档案标题/档号/附件名');
      assert.equal(s.archiveNo, ids.aNo, '来源档号必须真实');
      assert.match(s.locator, /^(DOCX|PDF|TXT) 第 /, '来源必须含可读的段落或页码位置');
      assert.equal(s.detailPath, `/archives/${s.archiveId}`, '来源需给出既有详情入口');
      const origin = cited.find((c) => c.ref === s.ref);
      assert.equal(s.excerpt, origin.excerpt, '来源摘录必须与本轮检索到的原文一致');
    }
    const userPrompt = modelStub.lastMessages[modelStub.lastMessages.length - 1].content;
    assert.ok(userPrompt.includes(`[${cited[0].ref}]`), '交给模型的证据必须带编号');
    assert.ok(userPrompt.includes(cited[0].excerpt.slice(0, 30)), '模型看到的证据应包含命中的真实原文');
    assert.ok(!userPrompt.includes(BODY_SECRET), '模型不得拿到无权访问的正文');
    assert.ok(userPrompt.length < 9000, `prompt 只含相关片段而非整库内容（实际 ${userPrompt.length}）`);
    assert.equal(modelStub.lastMessages[0].role, 'system', '问答 prompt 首位是受控系统提示');
  });

  await test('证据不足（检索侧）：正文里没依据时直接拒答，不消耗模型调用', async () => {
    modelStub.available = true;
    modelStub.throwOnCall = null;
    modelStub.nextContent = '质保金比例为百分之五 [E1]。';
    const before = modelStub.calls;
    const r = await ask(cookies.bor, { question: '质保金的比例是多少', clientRequestId: 'qa-no-evidence' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const p = r.data.reply.payload;
    assert.equal(p.intent, 'content_question', '质保金类问题应走正文问答而不是目录检索');
    assert.equal(p.kind, 'content_no_evidence');
    assert.equal((p.sources || []).length, 0, '无依据时不得给出任何来源');
    assert.equal(modelStub.calls, before, '没有证据时不得把问题交给模型去猜');
    assert.match(r.data.reply.content, /不会猜测|不作答/);
    assert.ok(!r.data.reply.content.includes('百分之五'), '拒答文案不得出现编造的比例');
  });

  await test('证据不足（模型侧）：模型判定依据不够时如实拒答，不外泄内部标记', async () => {
    const scoped = await ask(cookies.bor, { question: '帮我查找设备采购合同甲', clientRequestId: 'insp-scope' });
    assert.equal(scoped.status, 201);
    const conversationId = scoped.data.conversationId;
    modelStub.available = true;
    modelStub.nextContent = 'INSUFFICIENT_EVIDENCE\n证据不足：所给片段未约定质保金的比例与返还时间。';
    const before = modelStub.calls;
    const r = await ask(cookies.bor, {
      conversationId,
      question: '帮我总结这份合同的核心内容',
      clientRequestId: 'insp-model',
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const p = r.data.reply.payload;
    assert.equal(modelStub.calls, before + 1, '有证据时确实调用了模型并由其判定不足');
    assert.equal(p.kind, 'content_no_evidence');
    assert.equal((p.sources || []).length, 0, '模型拒答时不得给出任何来源');
    assert.match(r.data.reply.content, /不会猜测|不作答/);
    assert.ok(!r.data.reply.content.includes('INSUFFICIENT_EVIDENCE'), '内部标记不外泄给用户');
    assert.ok(!r.data.reply.content.includes('质保金的比例与返还时间'), '不把模型的自述当成答案回显');
  });

  await test('引用核验：模型给出的引用编号不存在于证据集时一律剔除并降级', async () => {
    modelStub.available = true;
    modelStub.nextContent = '付款条件为交付后七日内一次性付清全款 [E99]。';
    const r = await ask(cookies.bor, { question: '付款条件是什么', clientRequestId: 'qa-fake-ref' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const p = r.data.reply.payload;
    assert.equal(p.kind, 'content_evidence', '无可核验引用时不得声称已 AI 归纳');
    assert.match(String(p.aiNote), /未按可核验方式标注引用/);
    assert.ok(!r.data.reply.content.includes('七日内一次性付清全款'), '伪造结论不得作为答案返回');
    for (const s of p.retrievedEvidence ?? []) assert.match(s.excerpt, /\S/, '降级后的参考资料仍是真实原文');
  });

  // ==================== 6. 版本变更后旧索引不被误用 ====================

  await test('文件更新：新版本入库后旧正文片段不再被检索命中', async () => {
    modelStub.available = false;
    const before = await contentStatus(ids.a, adminCookie);
    const docxBefore = findFileStatus(before.data.files, '主合同.docx');
    assert.equal(docxBefore.versionNo, null, '未入库版本前应无版本号');

    const vUp = await uploadVersion(ids.a, ids.docxA, '主合同-修订.docx', buildDocx([
      '甲方与乙方就设备采购事宜达成补充协议。',
      BODY_PAYMENT_OLD,
      BODY_TERM_NEW,
    ]), cookies.cat);
    assert.equal(vUp.status, 201, JSON.stringify(vUp.data));

    const after = await contentStatus(ids.a, adminCookie);
    const docxAfter = findFileStatus(after.data.files, '主合同.docx');
    assert.equal(docxAfter.status, 'indexed');
    assert.ok(Number.isInteger(docxAfter.versionNo), '入库版本后状态应带真实版本号');
    assert.ok(docxAfter.versionNo >= 1, `版本号应来自真实版本链：${docxAfter.versionNo}`);

    const r = await ask(cookies.bor, { question: '履约期限是多长', clientRequestId: 'body-term-v2' });
    const p = r.data.reply.payload;
    assert.ok((p.retrievedEvidence ?? p.sources ?? []).length >= 1);
    const hit = (p.sources?.length ? p.sources : p.retrievedEvidence ?? []).find((s) => s.fileName === '主合同.docx');
    assert.ok(hit, '仍应命中主合同');
    assert.ok(hit.excerpt.includes('九十日'), `应检索到新版本正文：${hit.excerpt}`);
    assert.ok(!hit.excerpt.includes('一百八十日'), '旧版本正文不得再被使用');
    assert.equal(hit.versionNo, docxAfter.versionNo, '来源版本号必须与当前有效版本一致');
    const located=await req(`/api/knowledge/attachments/${hit.fileId}/source/${hit.chunkId}?archiveId=${hit.archiveId}`,{cookie:cookies.bor});
    assert.equal(located.status,200);assert.equal(located.data.versionNo,hit.versionNo);assert.ok(Number.isInteger(located.data.versionId));
    const preview=await req(`/api/archives/${hit.archiveId}/versions/${located.data.versionId}/preview`,{cookie:adminCookie});
    assert.equal(preview.status,200,'定位版本仍须通过原有版本预览权限接口');
    const wrong=await req(`/api/knowledge/attachments/${ids.docxB}/source/${hit.chunkId}?archiveId=${ids.b}`,{cookie:adminCookie});
    assert.equal(wrong.status,404,'不能将真实片段绑定到其他附件');

    const db = new DatabaseSync(DB_FILE);
    const stale = db
      .prepare('SELECT COUNT(*) AS c FROM archive_content_chunks WHERE text LIKE ?')
      .get('%一百八十日%');
    const units = db.prepare('SELECT COUNT(*) AS c FROM archive_content_units WHERE file_id = ?').get(ids.docxA);
    db.close();
    assert.equal(Number(stale.c), 0, '旧版本正文索引必须被清除');
    assert.equal(Number(units.c), 1, '同一文件不得同时保留多份可检索索引单元');
  });

  await test('参数篡改：版本入库的 fileId 指向其他档案附件时拒绝，不留版本也不改变索引', async () => {
    const before = await contentStatus(ids.a, adminCookie);
    const versionsBefore = await req(`/api/archives/${ids.a}/versions`, { cookie: adminCookie });
    assert.equal(versionsBefore.status, 200);

    // 借阅者无 documentEdit：改参数同样越不过角色守卫
    const denied = await uploadVersion(ids.a, ids.docxA, '越权.docx', buildDocx([BODY_TERM_NEW]), cookies.bor);
    assert.equal(denied.status, 403, '无文档编辑权时必须 403');

    // fileId 指向另一份档案的附件：不得借「版本入库」把正文写进他人附件的版本链
    const tampered = await uploadVersion(ids.a, ids.docxB, '跨档案.docx', buildDocx([BODY_TERM_NEW]), cookies.cat);
    assert.equal(tampered.status, 400, JSON.stringify(tampered.data));
    assert.match(String(tampered.data.message), /不属于该档案/);

    const after = await contentStatus(ids.a, adminCookie);
    assert.deepEqual(after.data.files, before.data.files, '被拒绝的入库不得改变任何附件的索引状态');
    const versionsAfter = await req(`/api/archives/${ids.a}/versions`, { cookie: adminCookie });
    assert.equal(versionsAfter.data.length, versionsBefore.data.length, '被拒绝的入库不得留下版本');

    // 归属合法时才能入库（与上一条构成对照，排除“接口整体不可用”的假阳性）
    const ok = await uploadVersion(ids.a, ids.docxA, '主合同-再修订.docx', buildDocx([
      '甲方与乙方就设备采购事宜达成再补充协议。',
      BODY_PAYMENT_OLD,
      BODY_TERM_NEW,
    ]), cookies.cat);
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    const st = await contentStatus(ids.a, adminCookie);
    assert.ok(Number.isInteger(findFileStatus(st.data.files, '主合同.docx').versionNo), '合法归属后应回报真实版本号');
  });

  await test('索引幂等：重复重建索引不会产生重复单元，也不改变命中数量', async () => {
    const countUnits = () => {
      const db = new DatabaseSync(DB_FILE);
      const v = db.prepare('SELECT COUNT(*) AS c FROM archive_content_units').get();
      const c = db.prepare('SELECT COUNT(*) AS c FROM archive_content_chunks').get();
      db.close();
      return { units: Number(v.c), chunks: Number(c.c) };
    };
    const first = countUnits();
    const re1 = await req(`/api/archives/${ids.a}/content/reindex`, { method: 'POST', cookie: adminCookie });
    assert.equal(re1.status, 201, JSON.stringify(re1.data));
    assert.equal(re1.data.synced, 0, '全部附件都已是当前内容，不应重复索引');
    const second = countUnits();
    assert.deepEqual(second, first, '重复重建不得新增索引行');
  });

  // ==================== 7~8. 权限隔离 ====================

  await test('权限：受限档案的正文既检索不到也不会进入模型 prompt', async () => {
    const question = '玄鸟项目专用付款条款是怎么约定的';
    modelStub.available = false;
    const asBorrower = await ask(cookies.bor, { question, clientRequestId: 'perm-bor' });
    assert.equal(asBorrower.status, 201, JSON.stringify(asBorrower.data));
    const bp = asBorrower.data.reply.payload;
    const serialized = JSON.stringify(bp.retrievedEvidence || bp.sources || []);
    assert.ok(!serialized.includes('玄鸟'), '借阅者不得检索到受限档案正文');
    assert.ok(!(bp.retrievedEvidence || bp.sources || []).some((s) => s.archiveId === ids.r), '受限档案不得出现在来源中');

    modelStub.available = true;
    modelStub.throwOnCall = null;
    modelStub.nextContent = '未约定相关内容 [E1]。';
    const asBorrowerAi = await ask(cookies.bor, { question, clientRequestId: 'perm-bor-ai' });
    assert.equal(asBorrowerAi.status, 201);
    assert.ok(!modelStub.lastMessages[1].content.includes('玄鸟'), '无权正文绝不能交给模型');
    assert.ok(!JSON.stringify(asBorrowerAi.data.reply.payload.retrievedEvidence ?? asBorrowerAi.data.reply.payload.sources).includes('玄鸟'));

    // 同一问题：受限档案的创建者可检索到真实正文（证明上一步是权限作用，而非提取失败）
    const asOwner = await ask(cookies.cat, { question, clientRequestId: 'perm-cat' });
    assert.equal(asOwner.status, 201);
    const cp = asOwner.data.reply.payload;
    const ownerHit = (cp.retrievedEvidence || cp.sources || []).find((s) => s.archiveId === ids.r);
    assert.ok(ownerHit, '创建者应能检索到自己受限档案的正文');
    assert.ok(ownerHit.excerpt.includes('玄鸟'), '来源摘录必须是受限档案的真实正文');
  });

  await test('会话与内容按用户隔离：他人会话（含来源清单）一律不可读', async () => {
    modelStub.available = false;
    const owner = await ask(cookies.cat, { question: '履约期限是多长', clientRequestId: 'iso-owner' });
    assert.equal(owner.status, 201);
    const conversationId = owner.data.conversationId;
    assert.ok((owner.data.reply.payload.retrievedEvidence || owner.data.reply.payload.sources || []).length >= 1, '本人会话内可回看参考资料');

    const read = await req(`/api/agent/conversations/${conversationId}`, { cookie: cookies.bor });
    assert.equal(read.status, 404, '他人读取会话必须 404');
    const followUp = await ask(cookies.bor, { conversationId, question: '保密条款呢', clientRequestId: 'iso-intrude' });
    assert.equal(followUp.status, 404, '他人续问他人会话必须 404');
    const del = await req(`/api/agent/conversations/${conversationId}`, { method: 'DELETE', cookie: cookies.bor });
    assert.equal(del.status, 404, '他人删除会话必须 404');
    const back = await req(`/api/agent/conversations/${conversationId}`, { cookie: cookies.cat });
    assert.equal(back.status, 200, '本人仍可读');
  });

  // ==================== 9. 模型不可用/异常 ====================

  await test('模型异常与超时：降级为原文展示并如实标注，不影响检索可用性', async () => {
    modelStub.available = true;
    modelStub.throwOnCall = new Error('request timed out');
    const r = await ask(cookies.bor, { question: '履约期限是多长', clientRequestId: 'model-timeout' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const p = r.data.reply.payload;
    assert.equal(p.kind, 'content_evidence');
    assert.match(String(p.aiNote), /模型服务暂时不可用/);
    assert.ok((p.retrievedEvidence || p.sources || []).length >= 1, '异常时仍应返回真实检索到的参考资料');

    modelStub.throwOnCall = null;
    modelStub.available = false;
    const st = await req('/api/agent/status', { cookie: cookies.bor });
    assert.equal(st.status, 200);
    assert.equal(st.data.aiConfigured, false, '未设环境变量时必须报告未配置（Key 只从后端环境变量读取）');
    assert.equal(st.data.capabilities.attachmentContentQa, true, '第二阶段能力如实开放');
    assert.equal(st.data.capabilities.ocr, false);
    assert.equal(st.data.capabilities.autoApproval, false);
    assert.equal(typeof st.data.contentFts, 'boolean');
    const fallback = await ask(cookies.bor, { question: '履约期限是多长', clientRequestId: 'model-unset' });
    assert.equal(fallback.status, 201);
    assert.equal(fallback.data.reply.payload.kind, 'content_evidence');
    assert.match(String(fallback.data.reply.payload.aiNote), /未配置模型服务/);
  });

  // ==================== 10. 原有业务回归 ====================

  await test('回归：目录检索仍只查元数据，正文词不污染档案字段检索', async () => {
    const byBody = await req(`/api/archives?q=${encodeURIComponent('玄鸟')}`, { cookie: adminCookie });
    assert.equal(byBody.status, 200);
    assert.equal(byBody.data.total, 0, '正文关键词不得让目录检索误命中（字段检索仍用真实元数据）');
    const byTitle = await req(`/api/archives?q=${encodeURIComponent('设备采购合同甲')}`, { cookie: cookies.bor });
    assert.equal(byTitle.data.total, 1, '既有元数据检索照常工作');
    const agent = await ask(cookies.bor, { question: `档号 ${ids.aNo}`, clientRequestId: 'reg-no' });
    assert.equal(agent.status, 201);
    assert.equal(agent.data.reply.payload.kind, 'search', '档号检索仍是目录检索');
    assert.ok(agent.data.reply.payload.items.some((c) => c.id === ids.a));
  });

  await test('回归：附件下载字节一致，Agent 不产生任何业务写入', async () => {
    const dl = await fetch(`${baseUrl}/api/archive-files/${ids.txtA}/download`, {
      headers: { Cookie: cookies.cat },
    });
    assert.equal(dl.status, 200);
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.ok(buf.toString('utf8').includes('争议解决'), '下载内容仍是原始 TXT 文件');
    const guestDl = await req(`/api/archive-files/${ids.txtA}/download`, { cookie: null });
    assert.equal(guestDl.status, 401, '未登录下载仍必须 401');

    const db = new DatabaseSync(DB_FILE);
    const archives = db.prepare('SELECT COUNT(*) AS c FROM archives').get();
    const files = db.prepare('SELECT COUNT(*) AS c FROM archive_files').get();
    const borrows = db.prepare('SELECT COUNT(*) AS c FROM borrow_requests').get();
    db.close();
    assert.equal(Number(archives.c), 3, 'Agent 问答与索引不得新增档案');
    assert.ok(Number(files.c) >= 6, '既有附件保持不变');
    assert.equal(Number(borrows.c), 0, '本阶段不做任何借阅/审批写入');
  });

  await test('审计：Agent 正文问答留痕引用条数，且不含任何正文内容', async () => {
    const audit = await req('/api/audit?action=agent.query&pageSize=50', { cookie: adminCookie });
    assert.equal(audit.status, 200);
    assert.ok(audit.data.total >= 1);
    const qa = audit.data.items.find((x) => x.detail && x.detail.intent === 'content_question');
    assert.ok(qa, '应留下内容问答审计');
    assert.equal(typeof qa.detail.sourceCount, 'number', '审计应记录引用条数');
    const serialized = JSON.stringify(audit.data.items);
    assert.ok(!serialized.includes('一百八十日'), '审计 detail 不得写入附件正文');
    assert.ok(!serialized.includes('玄鸟'), '受限正文不得进入审计');
  });
});

/** 版本入库（复用在线编辑「导出件回传入库」真实接口，非直接改库）。 */
async function uploadVersion(archiveId, fileId, name, bytes, cookie) {
  const uploaded = await req(
    `/api/archives/${archiveId}/versions?fileId=${fileId}&name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      cookie,
      raw: true,
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream' },
    },
  );
  if (uploaded.status === 201) currentApp.get(ContentIndexService).indexFileById(fileId);
  return uploaded;
}
