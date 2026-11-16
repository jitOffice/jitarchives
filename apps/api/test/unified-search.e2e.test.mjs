import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
/**
 * JitArchives 全系统统一智能检索（第一批）后端自动化验证（node:test）
 *
 * 隔离：独立测试库（storage/test-unified-<pid>.db）+ 独立文件存储目录 + 桩模型客户端（绝不触网），
 * 不触碰正式库与其他回归用例。模型 available=false 时服务层不调用，全部走确定性规则解析。
 *
 * 覆盖计划「测试与验证」小节验收点：
 *  1. 关键词同时命中档案与附件时四组真实返回，各组计数来自数据库；
 *  2. 附件按文件名 / 扩展名 / 所属档案 / 版本号检索正确，受限档案的附件对新用户不出现、管理员可见；
 *  3. 正文组复用既有 FTS5/LIKE 索引，只出现在正文里的关键词也能定位（且无权正文不外泄）；
 *  4. 分类组名称/编码/层级与档案数量与 GET /api/categories（listCategories）完全一致；
 *  5. 五类角色各自可见范围不越权，受限档案不因统一检索而泄露；
 *  6. 既有意图回归：纯目录检索仍走 search；借阅进度 / 内容问答行为不变。
 * 运行：npm run build:api 后 node --test test/unified-search.e2e.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import PizZip from 'pizzip';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-unified-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-unified-store-${process.pid}`);

let baseUrl = null;
let currentApp = null;

/** 桩模型：available=false 表示未配置（服务层不调用，走确定性规则）。 */
const modelStub = {
  available: false,
  model: 'stub-model',
  calls: 0,
  async chatCompletion() {
    this.calls += 1;
    if (!this.available) throw new Error('模型未配置');
    return { content: '', truncated: false };
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
  return { status: res.status, data, cookie: newCookie };
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

// ==================== 真实可提取的 DOCX 构造（正文入既有索引链路） ====================

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
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

const ADMIN = { username: 'un_root', displayName: '总管理员', password: 'Admin#12345' };
const USERS = {
  cat: { username: 'un_cat', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  rev: { username: 'un_rev', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  bor: { username: 'un_bor', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  gst: { username: 'un_gst', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

let adminCookie = '';
const cookies = {};
const ids = {};

/** 贯穿四组的统一关键词：同时作为档案标题、附件文件名、附件正文、分类名称的子串。 */
const KW = '星辰';
/** 只出现在正文里、不进入标题与文件名的关键词档案（用于证明正文组独立命中）。 */
const BODY_ONLY = `${KW}项目在本季度内的采购执行情况汇总与履约进度说明。`;

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

/** 裸流上传附件（上传钩子会把可读正文写入既有索引）。 */
async function upload(archiveId, name, bytes) {
  const uploaded = await req(
    `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      cookie: cookies.cat,
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

/** 统一检索提问（走确定性规则：命中多范围联合信号 → unified_search）。 */
async function unifiedAsk(cookie, question, clientRequestId) {
  const r = await ask(cookie, { question, clientRequestId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.reply;
}

function groupIds(group) {
  return group.items.map((x) => x.fileId ?? x.archiveId ?? x.id);
}

test.describe('JitArchives 全系统统一智能检索（第一批）自动化验证', { concurrency: false }, async () => {
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

  await test('准备：角色、分类，以及公开/受限/正文专属档案与附件', async () => {
    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    for (const key of Object.keys(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: USERS[key] });
      assert.equal(created.status, 201, `应创建 ${key}`);
      cookies[key] = await login(USERS[key]);
    }
    const cat = await req('/api/categories', {
      method: 'POST', cookie: adminCookie, body: { name: `${KW}计划`, code: 'XJHC' },
    });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;

    // A：公开，标题含关键词，附件文件名与正文均含关键词
    const a = await createArchive(`${KW}设备采购合同甲`, { categoryId: ids.cat });
    ids.a = a.id;
    ids.aNo = a.archiveNo;
    const docA = await upload(ids.a, `${KW}采购主合同.docx`, buildDocx([
      `甲方与乙方就${KW}设备采购事宜达成如下协议。`,
      '付款条件：验收合格后十五个工作日内支付合同总价的百分之三十尾款。',
    ]));
    assert.equal(docA.status, 201, JSON.stringify(docA.data));
    ids.fileA = docA.data.id;

    // B：受限（著录员自建），标题/文件名/正文均含关键词，用于验证越权不外泄
    const b = await createArchive(`${KW}涉密专项协议乙`, { categoryId: ids.cat, accessLevel: 'restricted' });
    ids.b = b.id;
    const docB = await upload(ids.b, `${KW}专项条款.docx`, buildDocx([
      `${KW}涉密专项条款：全部款项于交付后一次性支付，资料不得对外披露。`,
    ]));
    assert.equal(docB.status, 201);
    ids.fileB = docB.data.id;

    // D：公开，标题与附件文件名都不含关键词，仅正文含关键词 → 只应由正文组命中
    const d = await createArchive('季度总结丁', { categoryId: ids.cat });
    ids.d = d.id;
    const docD = await upload(ids.d, '季度记录.docx', buildDocx([BODY_ONLY]));
    assert.equal(docD.status, 201);
    ids.fileD = docD.data.id;

    // 无关档案：标题/附件均不含关键词，四组都不应出现
    const c = await createArchive('无关卷宗丙', { categoryId: ids.cat });
    ids.c = c.id;
    await upload(ids.c, '普通说明.docx', buildDocx(['本文件与关键词无关。']));
  });

  await test('准备第二批：创建本人/审核视角借阅记录与元数据模板', async () => {
    const mine = await req('/api/borrow-requests', {
      method: 'POST',
      cookie: cookies.bor,
      body: { archiveId: ids.a, purpose: `${KW}项目审查`, days: 15 },
    });
    assert.equal(mine.status, 201, JSON.stringify(mine.data));
    ids.borrowA = mine.data.id;

    const other = await req('/api/borrow-requests', {
      method: 'POST',
      cookie: cookies.cat,
      body: { archiveId: ids.d, purpose: `${KW}补充材料核对`, days: 10 },
    });
    assert.equal(other.status, 201, JSON.stringify(other.data));
    ids.borrowB = other.data.id;

    const template = await req('/api/templates', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        name: `${KW}合同元数据模板`,
        description: '统一检索第二批测试模板',
        fields: [{ fieldKey: 'contractNo', label: '合同编号', type: 'text', required: true }],
      },
    });
    assert.equal(template.status, 201, JSON.stringify(template.data));
    ids.template = template.data.id;
  });

  // ==================== 能力上报 ====================

  await test('状态接口：如实上报统一检索能力已开放', async () => {
    const st = await req('/api/agent/status', { cookie: cookies.bor });
    assert.equal(st.status, 200);
    assert.equal(st.data.capabilities.unifiedSearch, true, '第一批已开放统一智能检索');
  });

  // ==================== 1. 四组真实返回 ====================

  await test('统一检索：多范围信号触发 unified_search，四组均真实返回且计数来自数据库', async () => {
    const reply = await unifiedAsk(cookies.bor, `帮我统一检索这批资料，关键词为${KW}`, 'uni-all-1');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.equal(p.intent, 'unified_search');
    assert.equal(p.matched, true);
    assert.equal(p.aiUsed, false, '未配置模型时不得伪称用了 AI');
    const u = p.unified;
    assert.ok(u, '应带分组结果视图');
    for (const scope of ['archive', 'attachment', 'content', 'category']) {
      assert.ok(u.scopes.includes(scope), `显式联合检索应激活 ${scope} 范围`);
    }
    // 档案组：命中公开 A（标题含关键词），不含 D（标题无关键词）
    assert.ok(groupIds(u.archives).includes(ids.a), '档案组应命中标题含关键词的公开档案');
    assert.ok(!groupIds(u.archives).includes(ids.d), '标题不含关键词的档案不得进入档案组');
    assert.ok(u.archives.total >= 1, '档案组计数应来自真实命中');
    // 附件组：命中 A 的附件（文件名含关键词），不含 D（文件名/标题均无关键词）
    assert.ok(u.attachments.items.some((f) => f.fileId === ids.fileA), '附件组应命中文件名含关键词的附件');
    assert.ok(!u.attachments.items.some((f) => f.fileId === ids.fileD), '附件既非同名档案又无关键词者不进附件组');
    assert.ok(u.attachments.total >= 1);
    // 正文组：命中 A 与 D（正文含关键词），证明正文检索独立于目录
    assert.ok(u.contents.items.some((s) => s.archiveId === ids.a), '正文组应命中 A 的正文');
    assert.ok(u.contents.items.some((s) => s.archiveId === ids.d), '正文组应命中仅正文含关键词的 D');
    assert.ok(u.contents.items.every((s) => s.excerpt.includes(KW)), '正文摘录必须真实含关键词，不编造');
    // 分类组：命中名称含关键词的分类
    assert.ok(u.categories.items.some((c) => c.id === ids.cat), '分类组应命中名称含关键词的分类');
    assert.equal(typeof u.degraded, 'boolean', '降级与否必须如实上报');
    assert.match(reply.content, /统一检索/, '中文摘要应说明已按范围完成统一检索');
  });

  // ==================== 2. 附件维度检索 + 越权防护 ====================

  await test('附件检索：按扩展名过滤只返回该格式；受限档案附件对借阅者不出现', async () => {
    const reply = await unifiedAsk(cookies.bor, `查档案和附件，格式为docx，关键词为${KW}`, 'uni-ext-1');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    const u = p.unified;
    assert.ok(u.scopes.includes('archive') && u.scopes.includes('attachment'));
    assert.ok(!u.scopes.includes('content'), '仅命中档案+附件两个范围时不应打开正文范围');
    assert.ok(u.attachments.items.length >= 1);
    assert.ok(u.attachments.items.every((f) => f.extension === 'docx'), '扩展名过滤应全部命中 docx');
    assert.ok(!u.attachments.items.some((f) => f.fileId === ids.fileB), '受限档案 B 的附件不得出现在借阅者结果');
  });

  await test('附件检索：管理员可见受限档案附件，卡片携带真实所属档案/版本/大小字段', async () => {
    const reply = await unifiedAsk(adminCookie, `查档案和附件，格式为docx，关键词为${KW}`, 'uni-admin-att');
    const u = reply.payload.unified;
    const attB = u.attachments.items.find((f) => f.fileId === ids.fileB);
    assert.ok(attB, '管理员应见受限档案 B 的附件');
    assert.equal(attB.archiveId, ids.b, '附件必须回真实所属档案 ID');
    assert.equal(attB.archiveTitle, `${KW}涉密专项协议乙`, '所属档案标题真实');
    assert.ok(attB.fileSize > 0, '文件大小来自磁盘字节');
    assert.equal(attB.canOpenDetail, true, '管理员对详情有权限');
    assert.equal(attB.detailPath, `/archives/${ids.b}`, '详情入口复用既有路由');
  });

  // ==================== 3. 正文组：无权不外泄 + 不编造 ====================

  await test('正文检索：受限档案正文不出现在无权限者结果，也不泄露其存在', async () => {
    const reply = await unifiedAsk(cookies.bor, `帮我统一检索这批资料，关键词为${KW}`, 'uni-content-1');
    const u = reply.payload.unified;
    // 结构化复核：任何一组都不得引用受限档案 B（小整数 ID 不宜做裸子串判断）
    assert.ok(!u.contents.items.some((s) => s.archiveId === ids.b), '无权档案 B 的正文不得返回');
    assert.ok(!u.attachments.items.some((f) => f.archiveId === ids.b), '无权档案 B 的附件不得返回');
    assert.ok(!u.archives.items.some((c) => c.id === ids.b), '无权档案 B 不得进入档案组');
    const serialized = JSON.stringify(u);
    assert.ok(!serialized.includes('涉密专项'), '统一检索不得泄露受限档案标题');
    assert.ok(!serialized.includes('/archives/' + ids.b), '统一检索不得给出受限档案详情入口');
  });

  await test('正文检索：管理员可见受限档案正文（同一关键词命中真实片段）', async () => {
    const reply = await unifiedAsk(adminCookie, `帮我统一检索这批资料，关键词为${KW}`, 'uni-content-admin');
    const u = reply.payload.unified;
    assert.ok(u.contents.items.some((s) => s.archiveId === ids.b), '管理员正文组应命中受限档案 B');
  });

  // ==================== 4. 分类组与 listCategories 一致 ====================

  await test('分类检索：档案数量与层级与 GET /api/categories（listCategories）完全一致', async () => {
    const reply = await unifiedAsk(cookies.bor, `查档案和分类，关键词为${KW}`, 'uni-cat-1');
    const u = reply.payload.unified;
    assert.ok(u.scopes.includes('category'));
    const uniCat = u.categories.items.find((c) => c.id === ids.cat);
    assert.ok(uniCat, '分类组应命中目标分类');
    const list = await req('/api/categories', { cookie: cookies.bor });
    assert.equal(list.status, 200);
    const ref = list.data.find((c) => c.id === ids.cat);
    assert.ok(ref, '参照接口应含该分类');
    assert.equal(uniCat.archiveCount, ref.archiveCount, '档案数量必须与 listCategories 一致');
    assert.equal(uniCat.name, ref.name);
    assert.equal(uniCat.pathCode, ref.pathCode, '编码链必须一致');
    assert.equal(typeof uniCat.depth, 'number', '层级为真实数值');
  });

  // ==================== 5. 五类角色可见范围不越权 ====================

  await test('角色越权防护：受限档案仅管理员与自建著录员可见，审核/借阅/访客一律不可见', async () => {
    const q = `帮我统一检索这批资料，关键词为${KW}`;
    const visibleFor = {};
    for (const key of ['cat', 'rev', 'bor', 'gst']) {
      const reply = await unifiedAsk(cookies[key], q, `uni-role-${key}`);
      visibleFor[key] = groupIds(reply.payload.unified.archives).includes(ids.b);
    }
    const adminReply = await unifiedAsk(adminCookie, q, 'uni-role-admin');
    visibleFor.admin = groupIds(adminReply.payload.unified.archives).includes(ids.b);

    assert.equal(visibleFor.admin, true, '管理员可见受限档案');
    assert.equal(visibleFor.cat, true, '著录员对自建受限档案可见');
    assert.equal(visibleFor.rev, false, '审核员不得因统一检索越权看到受限档案');
    assert.equal(visibleFor.bor, false, '借阅者不得越权');
    assert.equal(visibleFor.gst, false, '访客不得越权');
  });

  // ==================== 6. 单一类型检索 ====================

  await test('单一类型检索：附件检索（文件名包含关键词）', async () => {
    const reply = await unifiedAsk(cookies.bor, `查找文件名包含${KW}的附件`, 'single-attachment');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search', '单一附件检索应进入 unified_search');
    assert.ok(p.unified.scopes.includes('attachment'), '应激活附件范围');
    assert.ok(p.unified.attachments.items.some((f) => f.fileId === ids.fileA), '应命中文件名含关键词的附件');
    assert.ok(!p.unified.attachments.items.some((f) => f.fileId === ids.fileB), '受限档案附件不得出现');
  });

  await test('单一类型检索：正文检索（正文包含关键词）', async () => {
    const reply = await unifiedAsk(cookies.bor, `搜索正文包含付款条件的内容`, 'single-content');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search', '单一正文检索应进入 unified_search');
    assert.ok(p.unified.scopes.includes('content'), '应激活正文范围');
    assert.ok(p.unified.contents.items.some((s) => s.archiveId === ids.a), '应命中 A 的正文');
    assert.ok(!p.unified.contents.items.some((s) => s.archiveId === ids.b), '受限档案正文不得出现');
  });

  await test('单一类型检索：分类检索（分类名称匹配）', async () => {
    const reply = await unifiedAsk(cookies.bor, `查找${KW}计划分类`, 'single-category');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search', '单一分类检索应进入 unified_search');
    assert.ok(p.unified.scopes.includes('category'), '应激活分类范围');
    assert.ok(p.unified.categories.items.some((c) => c.id === ids.cat), '应命中名称含关键词的分类');
  });

  await test('单一类型检索：档案检索（档案标题匹配）', async () => {
    const reply = await unifiedAsk(cookies.bor, `查找${KW}设备采购合同档案`, 'single-archive');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search', '单一档案检索应进入 unified_search');
    assert.ok(p.unified.scopes.includes('archive'), '应激活档案范围');
    assert.ok(p.unified.archives.items.some((a) => a.id === ids.a), '应命中标题含关键词的档案');
  });

  // ==================== 7. 多类型组合检索 ====================

  await test('多类型组合检索：附件+正文', async () => {
    const reply = await unifiedAsk(cookies.bor, `查找文件名包含${KW}的附件和正文`, 'multi-att-content');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.ok(p.unified.scopes.includes('attachment') && p.unified.scopes.includes('content'));
    assert.ok(p.unified.attachments.items.length >= 1);
    assert.ok(p.unified.contents.items.length >= 1);
  });

  await test('多类型组合检索：档案+附件+分类', async () => {
    const reply = await unifiedAsk(cookies.bor, `查找${KW}相关的档案、附件和分类`, 'multi-archive-att-cat');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.ok(p.unified.scopes.includes('archive') && p.unified.scopes.includes('attachment') && p.unified.scopes.includes('category'));
    assert.ok(p.unified.archives.items.length >= 1);
    assert.ok(p.unified.attachments.items.length >= 1);
    assert.ok(p.unified.categories.items.length >= 1);
  });

  // ==================== 8. 超过 100 条档案时的检索 ====================

  await test('超过 100 条档案：附件检索不遗漏', async () => {
    // 创建 120 个档案，每个都有一个附件
    const bulkIds = [];
    for (let i = 0; i < 120; i++) {
      const arch = await createArchive(`批量测试档案${i.toString().padStart(3, '0')}`, { categoryId: ids.cat });
      const file = await upload(arch.id, `批量附件${i.toString().padStart(3, '0')}.docx`, buildDocx([`这是第 ${i} 个测试档案的附件内容。`]));
      bulkIds.push({ archiveId: arch.id, fileId: file.data.id });
    }
    // 检索所有附件
    const reply = await unifiedAsk(adminCookie, `查找批量测试相关的附件`, 'bulk-attachment');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.ok(p.unified.scopes.includes('attachment'));
    // 验证超过 100 条时不遗漏
    assert.ok(p.unified.attachments.total >= 120, `附件总数应 >= 120，实际为 ${p.unified.attachments.total}`);
    // 清理
    for (const { archiveId } of bulkIds) {
      await req(`/api/archives/${archiveId}`, { method: 'DELETE', cookie: adminCookie });
    }
  });

  await test('超过 100 条档案：正文检索不遗漏', async () => {
    // 创建 110 个档案，每个都有一个包含特定关键词的附件
    const bulkIds = [];
    for (let i = 0; i < 110; i++) {
      const arch = await createArchive(`正文批量档案${i.toString().padStart(3, '0')}`, { categoryId: ids.cat });
      const file = await upload(arch.id, `正文批量附件${i.toString().padStart(3, '0')}.docx`, buildDocx([`这是第 ${i} 个测试档案的正文内容，包含特殊关键词“批量正文测试”。`]));
      bulkIds.push({ archiveId: arch.id, fileId: file.data.id });
    }
    // 检索正文
    const reply = await unifiedAsk(adminCookie, `搜索正文包含批量正文测试的内容`, 'bulk-content');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.ok(p.unified.scopes.includes('content'));
    // 验证超过 100 条时不遗漏
    assert.ok(p.unified.contents.total >= 110, `正文总数应 >= 110，实际为 ${p.unified.contents.total}`);
    // 清理
    for (const { archiveId } of bulkIds) {
      await req(`/api/archives/${archiveId}`, { method: 'DELETE', cookie: adminCookie });
    }
  });

  // ==================== 9. 检索条件筛选 ====================

  await test('检索条件：按档号筛选附件', async () => {
    const reply = await unifiedAsk(cookies.bor, `查找档号为${ids.aNo}的附件`, 'filter-archiveNo-attachment');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.ok(p.unified.scopes.includes('attachment'));
    assert.ok(p.unified.attachments.items.some((f) => f.archiveNo === ids.aNo), '应命中指定档号的附件');
  });

  await test('检索条件：按档案名称筛选正文', async () => {
    const reply = await unifiedAsk(cookies.bor, `搜索档案名称包含${KW}的正文内容`, 'filter-title-content');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.ok(p.unified.scopes.includes('content'));
    assert.ok(p.unified.contents.items.some((s) => s.archiveTitle.includes(KW)), '应命中档案名称含关键词的正文');
  });

  await test('检索条件：分类名称精确匹配', async () => {
    const reply = await unifiedAsk(cookies.bor, `查找分类名为${KW}计划的分类`, 'filter-category-name');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.ok(p.unified.scopes.includes('category'));
    assert.ok(p.unified.categories.items.some((c) => c.name === `${KW}计划`), '应精确命中分类名称');
  });

  // ==================== 第二批：借阅 / 审计 / 模板 / 统计 ====================

  await test('第二批：借阅记录按本人/审核权限检索，访客不能查看', async () => {
    const own = await unifiedAsk(cookies.bor, `查找${KW}档案和借阅记录`, 'business-borrow-own');
    assert.equal(own.payload.kind, 'unified_search');
    assert.ok(own.payload.unified.scopes.includes('borrow'));
    assert.equal(own.payload.unified.borrowings.scope, 'mine');
    assert.ok(own.payload.unified.borrowings.items.some((r) => r.id === ids.borrowA));
    assert.ok(!own.payload.unified.borrowings.items.some((r) => r.id === ids.borrowB), '借阅者只能检索本人记录');

    const review = await unifiedAsk(cookies.rev, `查找${KW}档案和借阅记录`, 'business-borrow-review');
    assert.equal(review.payload.unified.borrowings.scope, 'review');
    assert.ok(review.payload.unified.borrowings.items.some((r) => r.id === ids.borrowA));
    assert.ok(review.payload.unified.borrowings.items.some((r) => r.id === ids.borrowB), '审核员可按审核权限查看申请');

    const pending = await unifiedAsk(cookies.rev, `查找${KW}档案和待审核的借阅记录`, 'business-borrow-status-filter');
    assert.ok(pending.payload.unified.borrowings.items.length > 0);
    assert.ok(pending.payload.unified.borrowings.items.every((r) => r.status === 'pending'), '借阅状态筛选应在数据库查询中生效');

    const guest = await unifiedAsk(cookies.gst, `查找${KW}档案和借阅记录`, 'business-borrow-guest');
    assert.equal(guest.payload.unified.borrowings.total, 0);
    assert.ok(guest.payload.unified.restrictedScopes.some((s) => s.scope === 'borrow'));
  });

  await test('第二批：操作审计仅管理员可检索，结果不返回 IP 或原始 detail', async () => {
    const admin = await unifiedAsk(adminCookie, '查询最近7天的操作审计', 'business-audit-admin');
    assert.equal(admin.payload.kind, 'unified_search');
    assert.ok(admin.payload.unified.scopes.includes('audit'));
    assert.ok(admin.payload.unified.audits.total > 0, '应查到测试过程中真实产生的审计记录');
    const byAction = await unifiedAsk(adminCookie, '查询最近7天创建档案的操作审计', 'business-audit-action-filter');
    assert.ok(byAction.payload.unified.audits.items.some((item) => item.actionLabel === '创建档案'), '应支持按操作类型筛选审计');
    for (const item of admin.payload.unified.audits.items) {
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'ip'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'detail'), false);
    }

    for (const key of ['cat', 'rev', 'bor', 'gst']) {
      const denied = await unifiedAsk(cookies[key], '查询最近7天的操作审计', `business-audit-denied-${key}`);
      assert.equal(denied.payload.unified.audits.total, 0);
      assert.ok(denied.payload.unified.restrictedScopes.some((s) => s.scope === 'audit'), `${key} 不得查看审计`);
    }
  });

  await test('第二批：元数据模板与字段仅管理员/著录员可检索', async () => {
    const cataloger = await unifiedAsk(cookies.cat, `查找${KW}合同元数据模板`, 'business-template-cataloger');
    assert.equal(cataloger.payload.kind, 'unified_search');
    assert.ok(cataloger.payload.unified.scopes.includes('template'));
    assert.ok(cataloger.payload.unified.templates.items.some((t) => t.id === ids.template));
    assert.ok(cataloger.payload.unified.templates.items.find((t) => t.id === ids.template).fields.some((f) => f.fieldKey === 'contractNo'));
    const byField = await unifiedAsk(cookies.cat, '查找合同编号的元数据模板', 'business-template-field-search');
    assert.ok(byField.payload.unified.templates.items.some((t) => t.id === ids.template), '应支持直接按字段标签检索模板');

    const admin = await unifiedAsk(adminCookie, `查找${KW}合同元数据模板`, 'business-template-admin');
    assert.ok(admin.payload.unified.templates.items.some((t) => t.id === ids.template));

    for (const key of ['rev', 'bor', 'gst']) {
      const denied = await unifiedAsk(cookies[key], `查找${KW}合同元数据模板`, `business-template-denied-${key}`);
      assert.equal(denied.payload.unified.templates.total, 0);
      assert.ok(denied.payload.unified.restrictedScopes.some((s) => s.scope === 'template'));
    }
  });

  await test('第二批：档案统计复用 DashboardService，并按当前角色返回统计口径', async () => {
    const admin = await unifiedAsk(adminCookie, '查询最近30天的档案统计', 'business-stats-admin');
    assert.ok(admin.payload.unified.scopes.includes('stats'));
    assert.ok(admin.payload.unified.statistics);
    assert.equal(admin.payload.unified.statistics.archiveScopeLabel, '全库档案');

    const guest = await unifiedAsk(cookies.gst, '查询最近30天的档案统计', 'business-stats-guest');
    assert.ok(guest.payload.unified.statistics);
    assert.notEqual(guest.payload.unified.statistics.archiveScopeLabel, '全库档案');
    assert.equal(guest.payload.unified.statistics.utilization.available, false, '访客不能通过统计间接查看审计利用数据');
  });

  await test('第二批：八类范围可在一次 Agent 检索中联合汇总', async () => {
    const reply = await unifiedAsk(
      adminCookie,
      `查找${KW}相关的档案、附件、正文、分类、借阅记录、操作审计、元数据模板和档案统计`,
      'business-all-scopes',
    );
    assert.equal(reply.payload.kind, 'unified_search');
    const u = reply.payload.unified;
    for (const scope of ['archive', 'attachment', 'content', 'category', 'borrow', 'audit', 'template', 'stats']) {
      assert.ok(u.scopes.includes(scope), `应激活 ${scope} 范围`);
    }
    assert.ok(u.borrowings.items.length > 0);
    assert.ok(u.templates.items.length > 0);
    assert.ok(u.statistics);
  });

  // ==================== 10. 既有意图回归：路由不改变旧行为 ====================

  await test('回归：借阅进度查询与正文问答意图不被统一检索劫持', async () => {
    const prog = await unifiedAsk(cookies.bor, '帮我查看最近的借阅记录', 'reg-progress');
    assert.notEqual(prog.payload.kind, 'unified_search');
    assert.equal(prog.payload.intent, 'borrow_progress');

    const qa = await unifiedAsk(cookies.bor, `这份合同的付款条件是什么，请依据正文原文回答`, 'reg-qa');
    assert.notEqual(qa.payload.kind, 'unified_search', '正文问答仍走 content_question 链路');
    assert.equal(qa.payload.intent, 'content_question');
  });

  await test('回归：空条件不触发统一检索全库扫描（诚实返回未找到）', async () => {
    const reply = await unifiedAsk(cookies.bor, '帮我统一检索所有信息，关键词为不存在的词汇zzzqqq', 'uni-empty');
    const p = reply.payload;
    assert.equal(p.kind, 'unified_search');
    assert.equal(p.matched, false);
    assert.equal(p.unified.archives.total + p.unified.attachments.total + p.unified.contents.total + p.unified.categories.total, 0);
  });
});
