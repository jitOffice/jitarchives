/**
 * 知识图谱第二阶段集成测试（查询 API / 权限过滤 / 搜索 / 数量与深度上限 / 空数据）。
 *
 * 隔离：独立测试库 storage/test-kgq-<pid>.db + 独立文件存储目录，不触碰正式库。
 * 覆盖：
 *  1. 五个接口返回库中真实数据（与直接查库的独立重算逐位对照，不使用静态数字）；
 *  2. 分类视图筛选正确；节点按需展开（center + depth + types）正确；
 *  3. 关系返回类型/权重/计算依据/证据（结构、内容、确定性三类各自成形状）；
 *  4. 搜索复用统一检索并给出图谱定位；
 *  5. 五类角色权限过滤各自正确，借阅授权建立与归还实时生效；
 *  6. 不存在受限档案信息泄露（节点/关系/详情/统计/搜索命中标识全部查无此档）；
 *  7. 深度与节点数量上限有效（越界 400，超出截断如实标记）；
 *  8. 未登录 401、非法参数 400、失效节点与空库处理正常。
 * 运行：npm run build:api 后 node --test test/knowledge-graph-query.e2e.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PizZip from 'pizzip';

import { bootstrap } from '../dist/main.js';
import { DATABASE } from '../dist/db/database.js';
import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
import { GraphBuildService } from '../dist/graph/graph.service.js';
import { GraphModule } from '../dist/graph/graph.module.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-kgq-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-kgq-store-${process.pid}`);
const KG = '/api/knowledge-graph';

let baseUrl = '';
let app = null;
let db = null;
let content = null;

async function req(pathname, { method = 'GET', body, cookie, raw, headers: extra } = {}) {
  const headers = { ...(raw ? {} : body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(extra || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: raw ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  let newCookie = cookie;
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, cookie: newCookie, text };
}

function safeRm(f) { try { rmSync(f, { force: true }); } catch { /* EPERM 忽略 */ } }
function safeRmDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }

// ==================== 权限独立重算（不依赖被测实现的 SQL 拼装） ====================

/** 与 ARCHIVE_VISIBILITY_SQL 同语义：public / 本人创建 / 未过期 active 借阅授权（别名固定 a）。 */
const VIS_A = `a.access_level = 'public' OR a.created_by = ?
  OR EXISTS (SELECT 1 FROM borrow_grants g WHERE g.archive_id = a.id AND g.user_id = ?
    AND g.can_view = 1 AND g.status = 'active' AND datetime(g.expires_at) > datetime('now'))`;

function visibleArchiveIds(userId, admin) {
  if (admin) return new Set(db.prepare('SELECT id FROM archives').all().map((r) => Number(r.id)));
  return new Set(db.prepare(`SELECT a.id FROM archives a WHERE ${VIS_A}`).all(userId, userId).map((r) => Number(r.id)));
}

/** 可见分类：直接归属分类及其各级祖先（画布不能断链）。 */
function visibleCategoryIds(userId, admin) {
  const vis = visibleArchiveIds(userId, admin);
  const parentOf = new Map(db.prepare('SELECT id, parent_id FROM archive_categories').all().map((r) => [Number(r.id), r.parent_id == null ? null : Number(r.parent_id)]));
  const out = new Set();
  for (const row of db.prepare('SELECT id, category_id FROM archives').all()) {
    if (!vis.has(Number(row.id))) continue;
    let cursor = Number(row.category_id);
    const seen = new Set();
    while (cursor != null && !seen.has(cursor)) {
      out.add(cursor);
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  return out;
}

/** 从原始表独立重算可见节点/关系集合与计数（接口必须与之完全一致）。 */
function expectedGraph(userId, admin) {
  const visArchives = visibleArchiveIds(userId, admin);
  const visCategories = visibleCategoryIds(userId, admin);
  // 失效节点（图谱索引还在、权威业务行已没了）既不外显也不计数：接口与预期都按同一口径剔除
  const idSet = (table) => new Set(db.prepare(`SELECT id FROM ${table}`).all().map((r) => Number(r.id)));
  const factRows = { category: idSet('archive_categories'), archive: idSet('archives'), file: idSet('archive_files'), chunk: idSet('archive_content_chunks') };
  const factAlive = (n) => factRows[n.node_type]?.has(Number(n.ref_id)) === true;
  const nodes = db.prepare('SELECT id, node_type, ref_id, archive_id, biz_key, name FROM kg_graph_nodes').all();
  const visibleNodes = nodes.filter((n) =>
    factAlive(n) && (n.node_type === 'category' ? visCategories.has(Number(n.ref_id)) : n.archive_id != null && visArchives.has(Number(n.archive_id))));
  const nodeIds = new Set(visibleNodes.map((n) => Number(n.id)));
  const visibleEdges = db
    .prepare('SELECT id, edge_type, from_node, to_node, weight, basis, evidence_json FROM kg_graph_edges')
    .all()
    .filter((e) => nodeIds.has(Number(e.from_node)) && nodeIds.has(Number(e.to_node)));
  const nodesByType = { category: 0, archive: 0, file: 0, chunk: 0 };
  for (const n of visibleNodes) nodesByType[n.node_type] += 1;
  const args = admin ? [] : [userId, userId];
  const where = admin ? '1=1' : VIS_A;
  const count = (sql) => Number(db.prepare(sql).get(...args).c);
  return {
    archives: count(`SELECT COUNT(1) AS c FROM archives a WHERE ${where}`),
    files: count(`SELECT COUNT(1) AS c FROM archive_files f JOIN archives a ON a.id = f.archive_id WHERE ${where}`),
    categories: visCategories.size,
    chunks: nodesByType.chunk,
    relations: visibleEdges.length,
    nodesByType,
    visibleNodes,
    visibleEdges,
  };
}

// ==================== 语料（真实可提取字节，非模拟节点） ====================

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

const CONTRACT_A = '设备采购合同付款条款：验收合格后十五个工作日内支付合同总价的百分之三十尾款，逾期每日按千分之五计违约金，质保期一年。';
const CONTRACT_B = '设备采购合同付款条款：验收合格后二十个工作日内支付合同总价的百分之四十尾款，逾期每日按千分之三计违约金，质保期两年。';
const GREENING = '园林养护记录：三月补植银杏十二株，修剪绿篱三百米，喷洒药剂防止蚜虫发生，养护用水取自中水回用管道，工班晨会强调安全操作。';
const SECRET_TOKEN = '蓝鲸专项津贴核定';
const RESTRICTED_TEXT = `${SECRET_TOKEN}表：科员每人每月补贴二百六十元，技术岗另加岗位津贴，经费由专项预算列支，名册仅人事科可见。`;

const ADMIN = { username: 'kgq_root', displayName: '图谱查询管理员', password: 'Admin#12345' };
const USERS = {
  cataloger: { username: 'kgq_cat', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' },
  reviewer: { username: 'kgq_rev', displayName: '审核员甲', password: 'Rev#12345', role: 'reviewer' },
  borrower: { username: 'kgq_bor', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' },
  guest: { username: 'kgq_gst', displayName: '访客甲', password: 'Gst#12345', role: 'guest' },
};

const cookie = { admin: '', cataloger: '', reviewer: '', borrower: '', guest: '' };
const userId = {};
const ids = {};
let RESTRICTED_TITLE = '';
let RESTRICTED_NO = '';

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201, `登录应成功：${u.username}`);
  return r.cookie;
}

async function createArchive(title, extra = {}) {
  const created = await req('/api/archives', {
    method: 'POST',
    cookie: cookie.cataloger,
    body: { title, categoryId: ids.child, archiveType: '文书档案', ...extra },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

async function upload(archiveId, name, bytes) {
  const uploaded = await req(`/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    cookie: cookie.cataloger,
    raw: true,
    body: new Uint8Array(bytes),
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  content.indexFileById(uploaded.data.id);
  return uploaded.data;
}

/** 响应体全文不得出现受限档案的任何标识（存在性本身也是泄露）。 */
function assertNoRestrictedLeak(payload, label, { allowKeywordEcho = false } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const forbidden = [`archive:${ids.restricted}`, `file:${ids.fileRestricted}`, RESTRICTED_TITLE, RESTRICTED_NO];
  // 搜索结果会把用户输入的关键词原样回显，因此只对检索响应放宽「关键词本身」这一项
  if (!allowKeywordEcho) forbidden.push(SECRET_TOKEN);
  for (const item of forbidden) {
    assert.ok(!text.includes(String(item)), `${label} 不应出现受限档案标识 ${item}`);
  }
}

test.describe('JitArchives 档案知识图谱第二阶段（查询 API / 权限 / 搜索）', { concurrency: false }, async () => {
  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
    const result = await bootstrap({
      port: 0,
      dbFile: DB_FILE,
      fileStoreDir: FILE_STORE,
      serveWeb: false,
      knowledgeWorker: false,
      aiModelClient: { available: false, model: 'stub', async chatCompletion() { throw new Error('图谱查询用例不得触达模型'); } },
    });
    app = result.app;
    baseUrl = result.baseUrl;
    db = app.get(DATABASE);
    content = app.get(ContentIndexService);

    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    cookie.admin = init.cookie;
    userId.admin = init.data.id;
    for (const [key, u] of Object.entries(USERS)) {
      const created = await req('/api/users', { method: 'POST', cookie: cookie.admin, body: u });
      assert.equal(created.status, 201, `应创建用户 ${u.username}：${JSON.stringify(created.data)}`);
      userId[key] = created.data.id;
      cookie[key] = await login(u);
    }

    const parent = await req('/api/categories', { method: 'POST', cookie: cookie.admin, body: { name: '合同类目', code: 'HT' } });
    assert.equal(parent.status, 201);
    ids.parent = parent.data.id;
    const child = await req('/api/categories', { method: 'POST', cookie: cookie.admin, body: { name: '采购合同', code: 'HTCG', parentId: ids.parent } });
    assert.equal(child.status, 201, JSON.stringify(child.data));
    ids.child = child.data.id;
    const other = await req('/api/categories', { method: 'POST', cookie: cookie.admin, body: { name: '行政类目', code: 'XZ' } });
    assert.equal(other.status, 201);
    ids.other = other.data.id;

    // 著录模板：项目编号相同才能建立确定性关联
    const tpl = await req('/api/templates', {
      method: 'POST',
      cookie: cookie.admin,
      body: { name: '合同著录模板', fields: [{ fieldKey: 'projectNo', label: '项目编号', type: 'text' }] },
    });
    assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
    const bind = await req(`/api/categories/${ids.child}/template`, { method: 'PUT', cookie: cookie.admin, body: { templateId: tpl.data.id } });
    assert.equal(bind.status, 200, JSON.stringify(bind.data));

    const a = await createArchive('设备采购合同甲', { fieldValues: { projectNo: 'XM-2026-0007' } });
    ids.a = a.id;
    ids.aNo = a.archiveNo;
    const b = await createArchive('设备采购合同乙', { fieldValues: { projectNo: 'XM-2026-0007' } });
    ids.b = b.id;
    const c = await createArchive('园林养护记录丙', { categoryId: ids.other });
    ids.c = c.id;
    const restricted = await createArchive(`${SECRET_TOKEN}（受限）`, { accessLevel: 'restricted' });
    ids.restricted = restricted.id;
    RESTRICTED_TITLE = restricted.title;
    RESTRICTED_NO = restricted.archiveNo;

    ids.fileA = (await upload(ids.a, '主合同.docx', buildDocx([CONTRACT_A, '附件一：技术规格与验收标准另行约定。']))).id;
    ids.fileB = (await upload(ids.b, '合同副本.docx', buildDocx([CONTRACT_B]))).id;
    ids.fileC = (await upload(ids.c, '养护记录.docx', buildDocx([GREENING]))).id;
    ids.fileRestricted = (await upload(ids.restricted, '名册.docx', buildDocx([RESTRICTED_TEXT]))).id;

    const graph = app.select(GraphModule).get(GraphBuildService);
    const stats = graph.buildAll({ options: { minChunkCharsForSimilarity: 10 }, syncContent: true });
    assert.ok(stats.nodes > 0 && stats.edges > 0, '图谱应已真实构建');
  });

  test.after(async () => {
    if (app) await app.close();
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
  });

  await test('概览返回库中真实数据，并与独立重算一致', async () => {
    const r = await req(`${KG}/overview`, { cookie: cookie.admin });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const exp = expectedGraph(userId.admin, true);
    assert.equal(r.data.archives, exp.archives, '可见档案数应等于库中档案数');
    assert.equal(r.data.files, exp.files, '可见附件数应等于库中附件数');
    assert.equal(r.data.chunks, exp.chunks, '知识块数应等于库中知识块节点数');
    assert.equal(r.data.relations, exp.relations, '关联数应等于两端皆可见的关系数');
    assert.deepEqual(r.data.nodesByType, exp.nodesByType);
    assert.equal(r.data.notBuilt, false);
    assert.deepEqual(
      r.data.categoryList.map((c) => c.id).sort((x, y) => x - y),
      [...visibleCategoryIds(userId.admin, true)].sort((x, y) => x - y),
      '分类列表应等于自身或子树内有可见档案的分类集合',
    );
    const childRow = r.data.categoryList.find((c) => c.id === ids.child);
    assert.equal(childRow.archiveCount, 3, '子分类下应有甲/乙/受限三份档案');
    const parentRow = r.data.categoryList.find((c) => c.id === ids.parent);
    assert.equal(parentRow.archiveCount, 0, '父分类无直接归档');
    assert.equal(parentRow.subtreeArchiveCount, 3, '父分类子树档案数应累加子分类');
    assert.ok(r.data.edgesByType.chunk_similar_to > 0, '相似正文应产生内容关联');
    assert.equal(r.data.edgesByType.archive_shared_reference, 1, '同项目编号应产生一条确定性关联');
  });

  await test('概览权限：五类角色各自重算，受限档案不计入任何统计', async () => {
    for (const role of ['cataloger', 'reviewer', 'borrower', 'guest']) {
      const r = await req(`${KG}/overview`, { cookie: cookie[role] });
      assert.equal(r.status, 200, `${role} 应可读取概览`);
      const exp = expectedGraph(userId[role], false);
      assert.deepEqual(
        [r.data.archives, r.data.files, r.data.chunks, r.data.relations],
        [exp.archives, exp.files, exp.chunks, exp.relations],
        `${role} 统计应按可见范围重算`,
      );
      assertNoRestrictedLeak(r.data, `${role} 概览`);
    }
    const cat = await req(`${KG}/overview`, { cookie: cookie.cataloger });
    const rev = await req(`${KG}/overview`, { cookie: cookie.reviewer });
    assert.equal(cat.data.archives, 4, '著录员是受限档案创建人，本人创建可见（沿用既有可见性规则）');
    assert.equal(rev.data.archives, 3, '审核员未获授权，受限档案不计入');
    assert.ok(cat.data.relations > rev.data.relations, '受限档案相关关系不得计入审核员关联数');
    assert.ok(rev.data.categoryList.every((c) => c.subtreeArchiveCount > 0), '列出的分类都必须有可见档案');
  });

  await test('全景视图：默认只给分类与档案层，关系端点皆在返回节点内', async () => {
    const r = await req(`${KG}/graph`, { cookie: cookie.reviewer });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.mode, 'overview');
    assert.deepEqual([...new Set(r.data.nodes.map((n) => n.type))].sort(), ['archive', 'category'], '全景默认不下钻附件与知识块');
    const keys = new Set(r.data.nodes.map((n) => n.key));
    assert.ok(keys.has(`archive:${ids.a}`) && keys.has(`archive:${ids.c}`), '可见档案应出现');
    assert.ok(keys.has(`category:${ids.parent}`), '父分类无直接归档但子分类可见时仍须出现');
    assert.ok(!keys.has(`archive:${ids.restricted}`), '受限档案节点不得出现');
    assertNoRestrictedLeak(r.data, '审核员全景');
    for (const edge of r.data.edges) {
      assert.ok(keys.has(edge.from) && keys.has(edge.to), '关系端点必须都在返回节点集合内');
    }
    const archiveNode = r.data.nodes.find((n) => n.key === `archive:${ids.a}`);
    assert.equal(archiveNode.facts.archiveNo, ids.aNo, '档号应取档案表当前值');
    assert.ok(archiveNode.expandable && archiveNode.childCount >= 1, '有附件的档案应可展开并给出真实子节点数');
    assert.equal(JSON.stringify(r.data).includes('meta_json'), false, '不得透传内部 meta_json');
  });

  await test('分类视图：只返回该分类子树；缺少或非法参数一律 400', async () => {
    const scoped = await req(`${KG}/graph?view=category&categoryId=${ids.other}`, { cookie: cookie.admin });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.data.view, 'category');
    assert.deepEqual(
      new Set(scoped.data.nodes.map((n) => n.key)),
      new Set([`category:${ids.other}`, `archive:${ids.c}`]),
      '行政分类视图应只含该分类及其档案',
    );
    assert.equal((await req(`${KG}/graph?view=category`, { cookie: cookie.admin })).status, 400, '分类视图必须带 categoryId');
    assert.equal((await req(`${KG}/graph?view=category&categoryId=abc`, { cookie: cookie.admin })).status, 400, '非数字分类编号应 400');
    assert.equal((await req(`${KG}/graph?view=random`, { cookie: cookie.admin })).status, 400, '未知视图类型应 400');
    assert.equal((await req(`${KG}/graph?types=person`, { cookie: cookie.admin })).status, 400, '未知节点类型应 400');

    const guestView = await req(`${KG}/graph?view=category&categoryId=${ids.child}`, { cookie: cookie.guest });
    assert.equal(guestView.status, 200);
    const guestKeys = guestView.data.nodes.map((n) => n.key);
    assert.ok(!guestKeys.includes(`archive:${ids.restricted}`), '受限档案不出现在访客分类视图');
    const childNode = guestView.data.nodes.find((n) => n.key === `category:${ids.child}`);
    assert.equal(childNode.facts.archiveCount, 2, '分类节点上的档案数必须是当前用户可见数');
    assertNoRestrictedLeak(guestView.data, '访客分类视图');
  });

  await test('按需展开：逐层取附件与知识块，深度与类型过滤生效', async () => {
    const oneHop = await req(`${KG}/graph?center=archive:${ids.a}&depth=1`, { cookie: cookie.admin });
    assert.equal(oneHop.status, 200, JSON.stringify(oneHop.data));
    assert.equal(oneHop.data.mode, 'expand');
    assert.equal(oneHop.data.center.key, `archive:${ids.a}`);
    assert.deepEqual([...new Set(oneHop.data.nodes.map((n) => n.type))].sort(), ['archive', 'file'], '第一层应只展开附件');
    assert.ok(oneHop.data.nodes.some((n) => n.key === `file:${ids.fileA}`));

    const twoHop = await req(`${KG}/graph?center=archive:${ids.a}&depth=2`, { cookie: cookie.admin });
    const chunkNode = twoHop.data.nodes.find((n) => n.type === 'chunk');
    assert.ok(chunkNode, '第二层应展开出正文知识块');
    assert.ok(chunkNode.facts.locator, '知识块节点须带真实定位信息');
    assert.equal(chunkNode.archiveId, ids.a);

    const filtered = await req(`${KG}/graph?center=archive:${ids.a}&depth=2&types=file`, { cookie: cookie.admin });
    assert.deepEqual([...new Set(filtered.data.nodes.map((n) => n.type))].sort(), ['archive', 'file'], 'types 过滤应剔除知识块');

    const fromCategory = await req(`${KG}/graph?center=category:${ids.parent}&depth=3`, { cookie: cookie.admin });
    assert.ok(fromCategory.data.nodes.length > 3, '从父分类应能逐层展开到子分类与档案');

    const limited = await req(`${KG}/graph?center=archive:${ids.a}&depth=2&pageSize=2`, { cookie: cookie.admin });
    assert.ok(limited.data.nodes.length <= 2, `节点数不得超过 pageSize，实得 ${limited.data.nodes.length}`);
    assert.equal(limited.data.page.truncated, limited.data.page.totalNodes > limited.data.nodes.length, '截断须如实标记');
  });

  await test('查询上限：深度与节点数越界 400，非法中心节点格式 400', async () => {
    assert.equal((await req(`${KG}/graph?pageSize=1000`, { cookie: cookie.admin })).status, 400, '节点上限越界应 400');
    assert.equal((await req(`${KG}/graph?center=archive:${ids.a}&depth=4`, { cookie: cookie.admin })).status, 400, '深度上限越界应 400');
    assert.equal((await req(`${KG}/graph?center=archive`, { cookie: cookie.admin })).status, 400, '中心节点格式非法应 400');
    assert.equal((await req(`${KG}/graph?edgeTypes=nonsense`, { cookie: cookie.admin })).status, 400, '非法关系类型应 400');
    assert.equal((await req(`${KG}/graph?page=0`, { cookie: cookie.admin })).status, 400, '页码 0 非法应 400');
  });

  await test('展开权限：受限档案不能作为中心节点，无权即为 404', async () => {
    const denied = await req(`${KG}/graph?center=archive:${ids.restricted}&depth=2`, { cookie: cookie.reviewer });
    assert.equal(denied.status, 404, '存在但无权的节点与不存在的节点同为 404');
    assertNoRestrictedLeak(denied.data, '无权展开响应');
    const allowed = await req(`${KG}/graph?center=archive:${ids.restricted}&depth=1`, { cookie: cookie.admin });
    assert.equal(allowed.status, 200);
    assert.ok(allowed.data.nodes.some((n) => n.key === `file:${ids.fileRestricted}`), '管理员可展开受限档案附件');
  });

  await test('档案详情：目录字段、附件、关联档案与关联原因全部来自真实数据', async () => {
    const r = await req(`${KG}/nodes/archive/${ids.a}`, { cookie: cookie.reviewer });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.type, 'archive');
    assert.equal(r.data.title, '设备采购合同甲');
    assert.equal(r.data.archiveNo, ids.aNo);
    assert.equal(r.data.categoryName, '采购合同');
    assert.equal(r.data.statusLabel, '草稿（可著录）');
    assert.ok(r.data.files.some((f) => f.id === ids.fileA && f.name === '主合同.docx'), '附件列表应与库中一致');
    assert.equal(r.data.permissions.canView, true);
    const related = r.data.relatedArchives.map((x) => x.node.key);
    assert.ok(related.includes(`archive:${ids.b}`), '正文相近的合同乙应列为关联档案');
    assert.ok(!related.includes(`archive:${ids.c}`), '主题无关的养护记录不应成为关联');
    const relB = r.data.relatedArchives.find((x) => x.node.key === `archive:${ids.b}`);
    assert.ok(relB.edge.reason.length > 4, '关联原因须给出真实说明');
    assert.ok(['archive_related_to', 'archive_shared_reference'].includes(relB.edge.type));
  });

  await test('关系与证据：结构 / 内容 / 确定性三类各自可追溯', async () => {
    const structure = await req(`${KG}/nodes/category/${ids.child}/relations`, { cookie: cookie.admin });
    assert.equal(structure.status, 200);
    assert.ok(structure.data.items.length >= 3, '分类应列出其下可见档案');
    assert.ok(structure.data.items.every((x) => x.edge.type === 'category_contains_archive'));
    assert.equal(structure.data.items[0].evidence.basis, 'business_structure');
    assert.equal(structure.data.items[0].evidence.origin, 'archives.category_id', '结构关系须说明来源字段');

    const archiveRelations = await req(`${KG}/nodes/archive/${ids.a}/relations`, { cookie: cookie.admin });
    assert.equal(archiveRelations.status, 200);
    const agg = archiveRelations.data.items.find((x) => x.edge.type === 'archive_related_to');
    assert.equal(agg.evidence.basis, 'tfidf_cosine_aggregated');
    assert.ok(agg.evidence.supportCount >= 1 && agg.evidence.supportingChunks.length >= 1, '档案级关联须给出支撑知识块对');
    const exact = archiveRelations.data.items.find((x) => x.edge.type === 'archive_shared_reference');
    assert.equal(exact.evidence.basis, 'metadata_exact_match');
    assert.equal(exact.evidence.fieldKey, 'projectNo');
    assert.equal(exact.evidence.value, 'XM-2026-0007', '等值关联须给出真实字段值');
    assert.ok(archiveRelations.data.total >= 3, '附件包含 + 内容关联 + 确定性关联都应可查');

    const chunkRow = db.prepare('SELECT ref_id FROM kg_graph_nodes WHERE node_type=? AND file_id=? ORDER BY ref_id').get('chunk', ids.fileA);
    assert.ok(chunkRow, '附件应已切出正文知识块');
    const chunkRelations = await req(`${KG}/nodes/chunk/${Number(chunkRow.ref_id)}/relations?edgeTypes=chunk_similar_to`, { cookie: cookie.admin });
    assert.equal(chunkRelations.status, 200, JSON.stringify(chunkRelations.data));
    assert.ok(chunkRelations.data.items.length >= 1, '正文相似关系应可查到');
    const sim = chunkRelations.data.items[0];
    assert.equal(sim.evidence.basis, 'tfidf_cosine');
    assert.ok(sim.evidence.sharedTerms.length >= 1 && sim.evidence.similarity > 0, '内容关联须给出共有词项与真实相似度');
    assert.ok(sim.evidence.from.locator && sim.evidence.to.locator, '证据须带两端定位信息');
    assert.ok(sim.edge.weight > 0 && sim.edge.weight <= 1);

    const paged = await req(`${KG}/nodes/chunk/${Number(chunkRow.ref_id)}/relations?pageSize=1`, { cookie: cookie.admin });
    assert.equal(paged.data.items.length, 1, '关系列表分页应生效');
    assert.equal(paged.data.pageSize, 1);
  });

  await test('知识块与附件详情：正文摘录、定位与所属链路真实', async () => {
    const expanded = await req(`${KG}/graph?center=archive:${ids.a}&depth=2&pageSize=200`, { cookie: cookie.admin });
    const chunkNode = expanded.data.nodes.find((n) => n.type === 'chunk');
    const detail = await req(`${KG}/nodes/chunk/${chunkNode.refId}`, { cookie: cookie.admin });
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.type, 'chunk');
    assert.ok(detail.data.excerpt.length > 5, '正文摘录应来自真实切块文本');
    assert.ok(detail.data.locator, '须返回真实定位信息');
    assert.equal(detail.data.archive.id, ids.a);
    assert.equal(detail.data.file.id, ids.fileA);
    assert.ok(detail.data.permissions.canView);

    const fileDetail = await req(`${KG}/nodes/file/${ids.fileA}`, { cookie: cookie.reviewer });
    assert.equal(fileDetail.status, 200);
    assert.equal(fileDetail.data.name, '主合同.docx');
    assert.ok(fileDetail.data.chunks.length >= 1, '附件详情应列出其正文知识块');
    assert.ok(fileDetail.data.chunks.every((c) => c.excerpt.length > 0), '知识块列表须带摘录');
    assert.equal(fileDetail.data.archive.title, '设备采购合同甲');

    const categoryDetail = await req(`${KG}/nodes/category/${ids.child}`, { cookie: cookie.reviewer });
    assert.equal(categoryDetail.status, 200);
    assert.equal(categoryDetail.data.name, '采购合同');
    assert.equal(categoryDetail.data.parentName, '合同类目');
    assert.equal(categoryDetail.data.archives.length, 2, '分类详情只列可见档案');
    assertNoRestrictedLeak(categoryDetail.data, '审核员分类详情');
  });

  await test('详情权限：受限档案对未授权角色 404，附件与知识块继承同一权限', async () => {
    for (const role of ['reviewer', 'borrower', 'guest']) {
      assert.equal((await req(`${KG}/nodes/archive/${ids.restricted}`, { cookie: cookie[role] })).status, 404, `${role} 受限档案详情应 404`);
      const fileDenied = await req(`${KG}/nodes/file/${ids.fileRestricted}`, { cookie: cookie[role] });
      assert.equal(fileDenied.status, 404, `${role} 受限附件详情应 404（继承所属档案权限）`);
      assertNoRestrictedLeak(fileDenied.data, `${role} 受限附件详情`);
    }
    const restrictedChunks = db.prepare("SELECT ref_id FROM kg_graph_nodes WHERE node_type='chunk' AND archive_id=?").all(ids.restricted);
    assert.ok(restrictedChunks.length >= 1, '受限档案应已入图知识块（用于验证权限继承）');
    assert.equal((await req(`${KG}/nodes/chunk/${Number(restrictedChunks[0].ref_id)}`, { cookie: cookie.guest })).status, 404, '知识块须继承所属档案权限');
    assert.equal((await req(`${KG}/nodes/person/1`, { cookie: cookie.admin })).status, 400, '非法节点类型应 400');
    assert.equal((await req(`${KG}/nodes/archive/999999`, { cookie: cookie.admin })).status, 404, '不存在节点应 404');
    assert.equal((await req(`${KG}/nodes/archive/0`, { cookie: cookie.admin })).status, 400, '编号 0 非法应 400');
    assert.equal((await req(`${KG}/nodes/archive/${ids.a}/relations?pageSize=500`, { cookie: cookie.admin })).status, 400, '关系分页上限越界应 400');
  });

  await test('借阅授权：审批通过后可见范围实时扩大，归还后回落', async () => {
    const before = await req(`${KG}/overview`, { cookie: cookie.borrower });
    assert.equal(before.data.archives, 3);
    const application = await req('/api/borrow-requests', {
      method: 'POST',
      cookie: cookie.borrower,
      body: { archiveId: ids.restricted, purpose: '付款条款复核', days: 7 },
    });
    assert.equal(application.status, 201, JSON.stringify(application.data));
    const approved = await req(`/api/borrow-requests/${application.data.id}/approve`, { method: 'POST', cookie: cookie.admin, body: { note: '同意借阅' } });
    assert.equal(approved.status, 201, JSON.stringify(approved.data));

    const after = await req(`${KG}/overview`, { cookie: cookie.borrower });
    assert.equal(after.data.archives, 4, '授权后可见档案数应增加');
    const exp = expectedGraph(userId.borrower, false);
    assert.equal(after.data.relations, exp.relations, '关联数应随授权按可见范围重算');
    const detail = await req(`${KG}/nodes/archive/${ids.restricted}`, { cookie: cookie.borrower });
    assert.equal(detail.status, 200, '借阅授权期间应可查看该档案节点详情');
    assert.equal(detail.data.permissions.canView, true);

    const returned = await req(`/api/borrow-requests/${application.data.id}/return`, { method: 'POST', cookie: cookie.borrower });
    assert.equal(returned.status, 201, JSON.stringify(returned.data));
    const afterReturn = await req(`${KG}/nodes/archive/${ids.restricted}`, { cookie: cookie.borrower });
    assert.equal(afterReturn.status, 404, '归还后授权失效，图谱入口同步关闭');
  });

  await test('搜索：复用统一检索，四类命中分组并给出图谱定位', async () => {
    const r = await req(`${KG}/search?q=采购合同`, { cookie: cookie.admin });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.query, '采购合同');
    assert.ok(r.data.groups.archive.length >= 2, '档案组应命中甲/乙');
    assert.ok(r.data.groups.file.length >= 1, '附件组应命中文件名');
    assert.ok(r.data.groups.chunk.length >= 1, '正文组应命中知识块');
    assert.ok(r.data.groups.archive.every((h) => h.inGraph && h.key), '档案命中须能定位图谱节点');
    for (const hit of r.data.groups.chunk) {
      assert.ok(hit.locator, '正文命中须带真实定位');
      assert.ok(hit.excerpt.length > 0 && hit.excerpt.length <= 200, '摘录长度受控');
    }
    const none = await req(`${KG}/search?q=绝不存在的词汇组合`, { cookie: cookie.admin });
    assert.equal(none.status, 200);
    assert.equal(none.data.total, 0);
    assert.deepEqual(none.data.groups, { category: [], archive: [], file: [], chunk: [] });
    assert.equal((await req(`${KG}/search`, { cookie: cookie.admin })).status, 400, '空关键词应 400');
    assert.equal((await req(`${KG}/search?q=${'超'.repeat(101)}`, { cookie: cookie.admin })).status, 400, '超长关键词应 400');
  });

  await test('搜索权限：受限档案目录与正文对未授权角色完全不可见', async () => {
    const leak = await req(`${KG}/search?q=${encodeURIComponent(SECRET_TOKEN)}`, { cookie: cookie.admin });
    assert.equal(leak.status, 200);
    assert.ok(leak.data.total > 0, '管理员应能搜到受限内容');

    for (const role of ['reviewer', 'borrower', 'guest']) {
      const r = await req(`${KG}/search?q=${encodeURIComponent(SECRET_TOKEN)}`, { cookie: cookie[role] });
      assert.equal(r.status, 200);
      assert.equal(r.data.total, 0, `${role} 不得搜到受限内容`);
      assertNoRestrictedLeak(r.data, `${role} 搜索结果`, { allowKeywordEcho: true });
    }
    assertNoRestrictedLeak((await req(`${KG}/search?q=名册`, { cookie: cookie.guest })).data, '访客按附件名搜索');
    assertNoRestrictedLeak((await req(`${KG}/nodes/archive/${ids.a}/relations`, { cookie: cookie.guest })).data, '访客关系列表');
  });

  await test('未登录 401；图谱与业务表不一致的失效节点不外显、不计数', async () => {
    for (const pathname of [`${KG}/overview`, `${KG}/graph`, `${KG}/search?q=合同`, `${KG}/nodes/archive/${ids.a}`, `${KG}/nodes/archive/${ids.a}/relations`]) {
      assert.equal((await req(pathname)).status, 401, `${pathname} 未登录应 401`);
    }
    const now = new Date().toISOString();
    const insert = `INSERT INTO kg_graph_nodes (node_type, biz_key, ref_id, archive_id, file_id, name, meta_json, source, content_hash, built_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, '', ?, ?)`;
    db.prepare(insert).run('archive', 'archive:999999', 999999, 999999, null, '已删除档案', 'archives', now, now);
    db.prepare(insert).run('file', 'file:888888', 888888, ids.a, 888888, '已删除附件.docx', 'archive_files', now, now);

    const graph = await req(`${KG}/graph?types=archive,file&pageSize=800`, { cookie: cookie.admin });
    assert.equal(graph.status, 200);
    const keys = graph.data.nodes.map((n) => n.key);
    assert.ok(!keys.includes('archive:999999'), '指向不存在档案的节点必须被剔除');
    assert.ok(!keys.includes('file:888888'), '附件事实取不到的节点必须被剔除');
    assert.equal((await req(`${KG}/nodes/archive/999999`, { cookie: cookie.admin })).status, 404, '失效节点详情应 404');
    const overview = await req(`${KG}/overview`, { cookie: cookie.admin });
    const realNodes = Number(db.prepare('SELECT COUNT(1) AS c FROM kg_graph_nodes').get().c);
    const byType = overview.data.nodesByType;
    assert.equal(byType.category + byType.archive + byType.file + byType.chunk, realNodes - 2, '概览不得把失效节点计入可见规模');
    db.prepare("DELETE FROM kg_graph_nodes WHERE biz_key IN ('archive:999999','file:888888')").run();
  });

  await test('真实数据非模拟：接口节点与关系集合同库中可见行完全相等', async () => {
    const r = await req(`${KG}/graph?types=archive,file,chunk,category&pageSize=800`, { cookie: cookie.admin });
    const exp = expectedGraph(userId.admin, true);
    assert.deepEqual(r.data.nodes.map((n) => n.key).sort(), exp.visibleNodes.map((n) => n.biz_key).sort(), '节点集合不得包含库外键，也不得遗漏可见节点');
    assert.deepEqual(r.data.edges.map((e) => e.id).sort((x, y) => x - y), exp.visibleEdges.map((e) => e.id).sort((x, y) => x - y), '关系集合同样须与库中可见关系一致');
    assert.ok(r.data.nodes.every((n) => n.type && n.key && Number.isInteger(n.refId)), '每个节点都要有真实类型与业务主键');
  });

  await test('展示事实取权威表：档案改名后节点标签与详情同步', async () => {
    const before = await req(`${KG}/nodes/archive/${ids.c}`, { cookie: cookie.admin });
    assert.equal(before.data.title, '园林养护记录丙');
    const renamed = await req(`/api/archives/${ids.c}`, {
      method: 'PUT',
      cookie: cookie.cataloger,
      body: { title: '园林养护记录丙改名', categoryId: ids.other },
    });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
    const after = await req(`${KG}/nodes/archive/${ids.c}`, { cookie: cookie.admin });
    assert.equal(after.data.title, '园林养护记录丙改名', '详情须反映权威表当前值');
    const listed = await req(`${KG}/graph?types=archive&pageSize=800`, { cookie: cookie.admin });
    assert.ok(listed.data.nodes.some((n) => n.label === '园林养护记录丙改名'), '画布标签同样取当前值');
  });
});

test.describe('JitArchives 图谱查询：空库与未构建', { concurrency: false }, async () => {
  let emptyApp = null;
  let emptyCookie = '';
  const EMPTY_DB = path.join(__dirname, '..', 'storage', `test-kgq-empty-${process.pid}.db`);
  const EMPTY_STORE = path.join(__dirname, '..', 'storage', `test-kgq-empty-store-${process.pid}`);

  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${EMPTY_DB}${s}`);
    safeRmDir(EMPTY_STORE);
    // 上一组用例已关闭实例，这里把 req 助手指向空库实例
    const result = await bootstrap({
      port: 0,
      dbFile: EMPTY_DB,
      fileStoreDir: EMPTY_STORE,
      serveWeb: false,
      knowledgeWorker: false,
      aiModelClient: { available: false, model: 'stub', async chatCompletion() { throw new Error('空库用例不得触达模型'); } },
    });
    emptyApp = result.app;
    baseUrl = result.baseUrl;
    const init = await req('/api/auth/init-admin', {
      method: 'POST',
      body: { username: 'kgq_empty', displayName: '空库管理员', password: 'Admin#12345' },
    });
    assert.equal(init.status, 201);
    emptyCookie = init.cookie;
  });

  test.after(async () => {
    if (emptyApp) await emptyApp.close();
    for (const s of ['', '-wal', '-shm']) safeRm(`${EMPTY_DB}${s}`);
    safeRmDir(EMPTY_STORE);
  });

  await test('空库：概览全 0 且标记未构建，图谱与搜索给出干净空结果', async () => {
    const overview = await req(`${KG}/overview`, { cookie: emptyCookie });
    assert.equal(overview.status, 200);
    assert.equal(overview.data.archives, 0);
    assert.equal(overview.data.relations, 0);
    assert.deepEqual(overview.data.categoryList, []);
    assert.equal(overview.data.notBuilt, true, '图谱尚未构建时应如实标记');

    const graph = await req(`${KG}/graph`, { cookie: emptyCookie });
    assert.equal(graph.status, 200);
    assert.deepEqual(graph.data.nodes, []);
    assert.deepEqual(graph.data.edges, []);
    assert.equal(graph.data.page.totalNodes, 0);
    assert.equal(graph.data.page.truncated, false);

    const search = await req(`${KG}/search?q=合同`, { cookie: emptyCookie });
    assert.equal(search.status, 200);
    assert.equal(search.data.total, 0);
    assert.equal((await req(`${KG}/nodes/archive/1`, { cookie: emptyCookie })).status, 404);
    assert.equal((await req(`${KG}/nodes/archive/1/relations`, { cookie: emptyCookie })).status, 404);
  });
});
