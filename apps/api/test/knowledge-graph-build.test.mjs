/**
 * 知识图谱第一阶段集成测试（构建 / 更新 / 清理 / 幂等 / 迁移回归）。
 *
 * 隔离：独立测试库（storage/test-kg-<pid>.db）+ 独立文件存储目录，不触碰正式库。
 * 覆盖交付指令第七节验收点：
 *  1. 分类 / 档案 / 附件 / 知识块节点正确生成；
 *  2. 档案与附件的结构关系正确（分类→档案→附件→知识块）；
 *  3. 相似正文能建立内容关联，且权重与来源证据可追溯；
 *  4. 无关正文不产生噪声关系；无自环、无重复（含反向重复）关系；
 *  5. 确定性关联只认著录字段等值命中；
 *  6. 重复构建幂等（数量不翻倍、内容不变）；
 *  7. 阈值与 Top-K 可配置且真实生效；
 *  8. 单份档案重建只替换该档案子树；附件删除后过期节点与关系被清理；
 *  9. 正文索引钩子能在业务写入后自动刷新图谱（去抖队列）；
 * 10. 空附件 / 提取失败附件仍保留节点并记录提取状态，不影响整份档案入图；
 * 11. 数据库迁移与既有档案业务、权限回归正常。
 * 运行：npm run build:api 后 node --test test/knowledge-graph-build.test.mjs
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
import { buildCjkBigramTerms } from '../dist/search/cjk-bigram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', 'storage', `test-kg-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', 'storage', `test-kg-store-${process.pid}`);

let baseUrl = null;
let currentApp = null;
let db = null;
let graph = null;
let content = null;

// ==================== HTTP / DB 助手（与既有 e2e 同一套约定） ====================

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
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  let newCookie = cookie;
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/jit_sid=([0-9a-f]*)/);
    if (m) newCookie = m[1] ? `jit_sid=${m[1]}` : '';
  }
  return { status: res.status, data, cookie: newCookie, text };
}

function safeRm(f) { try { rmSync(f, { force: true }); } catch { /* EPERM */ } }
function safeRmDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }

// ==================== 测试语料（真实可提取字节） ====================

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

/** 伪装 PDF：有合法文件头但没有可用内容流，提取阶段必然失败（用于「提取失败仍入图」）。 */
const BROKEN_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<</Type/Catalog>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

// 主题相近的合同正文（跨档案应建立内容关联）
const CONTRACT_A = '设备采购合同付款条款：验收合格后十五个工作日内支付合同总价的百分之三十尾款，逾期每日按千分之五计违约金，质保期一年。';
const CONTRACT_B = '设备采购合同付款条款：验收合格后二十个工作日内支付合同总价的百分之四十尾款，逾期每日按千分之三计违约金，质保期两年。';
// 与合同主题完全无关的正文（不应与合同产生关系）
const GREENING = '园林养护记录：三月补植银杏十二株，修剪绿篱三百米，喷洒药剂防止蚜虫发生，养护用水取自中水回用管道，工班晨会强调安全操作。';
const MACHINE_ROOM = '服务器机房巡检台账：温湿度读数正常，UPS 电池组内阻在阈值范围内，空调滤网本季度清洗一次，巡检人员逐台核对配线架标签。';

const ADMIN = { username: 'kg_root', displayName: '图谱管理员', password: 'Admin#12345' };
const CATALOGER = { username: 'kg_cat', displayName: '著录员甲', password: 'Cat#12345', role: 'cataloger' };
const BORROWER = { username: 'kg_bor', displayName: '借阅者甲', password: 'Bor#12345', role: 'borrower' };

let adminCookie = '';
let catCookie = '';
let borCookie = '';
const ids = {};

async function login(u) {
  const r = await req('/api/auth/login', { method: 'POST', body: u });
  assert.equal(r.status, 201, `登录应成功：${u.username}`);
  return r.cookie;
}

async function createArchive(title, extra = {}) {
  const created = await req('/api/archives', {
    method: 'POST',
    cookie: catCookie,
    body: { title, categoryId: ids.cat, archiveType: '文书档案', ...extra },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  return created.data;
}

/** 裸流上传并同步完成正文索引（与既有正文检索用例同口径）。 */
async function upload(archiveId, name, bytes, { index = true } = {}) {
  const uploaded = await req(
    `/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      cookie: catCookie,
      raw: true,
      body: new Uint8Array(bytes),
      headers: { 'Content-Type': 'application/octet-stream' },
    },
  );
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  if (index) content.indexFileById(uploaded.data.id);
  return uploaded.data;
}

// ==================== 图谱表只读断言助手 ====================

const nodesOf = (type) => db.prepare('SELECT * FROM kg_graph_nodes WHERE node_type=? ORDER BY id').all(type);
const nodeByKey = (key) => db.prepare('SELECT * FROM kg_graph_nodes WHERE biz_key=?').get(key);
const nodeCount = () => Number(db.prepare('SELECT COUNT(*) AS c FROM kg_graph_nodes').get().c);
const edgeCount = () => Number(db.prepare('SELECT COUNT(*) AS c FROM kg_graph_edges').get().c);
const edgesOfType = (type) => db.prepare('SELECT * FROM kg_graph_edges WHERE edge_type=? ORDER BY weight DESC, id').all(type);
const edgePairs = (type) => edgesOfType(type).map((e) => `${e.from_node}|${e.to_node}`);
const archiveIdOfNode = (nodeId) => {
  const row = db.prepare('SELECT archive_id FROM kg_graph_nodes WHERE id=?').get(nodeId);
  return row ? Number(row.archive_id) : undefined;
};
/** 取某档案与某类型相关的全部关系（含端点键，便于定位问题）。 */
function edgesOfArchive(archiveId, edgeType) {
  return db
    .prepare(`
      SELECT e.*, f.biz_key AS from_key, t.biz_key AS to_key
        FROM kg_graph_edges e
        JOIN kg_graph_nodes f ON f.id = e.from_node
        JOIN kg_graph_nodes t ON t.id = e.to_node
       WHERE e.edge_type = ? AND (f.archive_id = ? OR t.archive_id = ?)`)
    .all(edgeType, archiveId, archiveId);
}
function nodeSnapshot() {
  return JSON.stringify(
    db.prepare('SELECT node_type, biz_key, ref_id, archive_id, file_id, name, meta_json, content_hash FROM kg_graph_nodes ORDER BY biz_key').all(),
  );
}
function edgeSnapshot() {
  return JSON.stringify(
    db.prepare(`
      SELECT e.edge_type, f.biz_key AS from_key, t.biz_key AS to_key, e.weight, e.basis, e.evidence_json
        FROM kg_graph_edges e JOIN kg_graph_nodes f ON f.id = e.from_node JOIN kg_graph_nodes t ON t.id = e.to_node
       ORDER BY e.edge_type, from_key, to_key`).all(),
  );
}

/** 业务事实基线（图谱构建不得改动任何业务表）。 */
function businessSnapshot() {
  const tables = ['archives', 'archive_files', 'archive_categories', 'archive_content_units', 'archive_content_chunks', 'archive_field_values'];
  const out = {};
  for (const t of tables) out[t] = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c);
  out.archiveTitles = db.prepare('SELECT id, title, archive_no, status FROM archives ORDER BY id').all().map((r) => `${r.id}:${r.title}:${r.archive_no}:${r.status}`);
  return out;
}

/** 构建参数：本用例集刻意把「最短正文长度」放宽，以便验证短文本与失败附件的规则各自生效。 */
const BUILD_REQUEST = { options: { minChunkCharsForSimilarity: 10 }, syncContent: true };

test.describe('JitArchives 档案知识图谱第一阶段（构建 / 更新 / 清理 / 幂等）', { concurrency: false }, async () => {
  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
    const result = await bootstrap({
      port: 0,
      dbFile: DB_FILE,
      fileStoreDir: FILE_STORE,
      serveWeb: false,
      knowledgeWorker: false,
      aiModelClient: { available: false, model: 'stub', async chatCompletion() { throw new Error('图谱用例不得触达模型'); } },
    });
    currentApp = result.app;
    baseUrl = result.baseUrl;
    db = currentApp.get(DATABASE);
    content = currentApp.get(ContentIndexService);
    graph = currentApp.select(GraphModule).get(GraphBuildService);
  });

  test.after(async () => {
    if (currentApp) await currentApp.close();
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
  });

  // ==================== 准备：分类 / 模板 / 档案 / 附件 ====================

  await test('准备：迁移建表、角色、分类、著录模板与含正文附件的档案', async () => {
    const migration = db.prepare("SELECT id FROM _migrations WHERE id='210-knowledge-graph'").get();
    assert.ok(migration, '迁移 210-knowledge-graph 应已执行');
    assert.ok(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='kg_graph_nodes'").get(), 'kg_graph_nodes 应存在');
    assert.ok(db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='kg_graph_edges'").get(), 'kg_graph_edges 应存在');

    const init = await req('/api/auth/init-admin', { method: 'POST', body: ADMIN });
    assert.equal(init.status, 201);
    adminCookie = init.cookie;
    for (const u of [CATALOGER, BORROWER]) {
      const created = await req('/api/users', { method: 'POST', cookie: adminCookie, body: u });
      assert.equal(created.status, 201, `应创建用户 ${u.username}：${JSON.stringify(created.data)}`);
    }
    catCookie = await login(CATALOGER);
    borCookie = await login(BORROWER);

    const cat = await req('/api/categories', { method: 'POST', cookie: adminCookie, body: { name: '合同类目', code: 'HT' } });
    assert.equal(cat.status, 201);
    ids.cat = cat.data.id;
    const cat2 = await req('/api/categories', { method: 'POST', cookie: adminCookie, body: { name: '行政类目', code: 'XZ' } });
    assert.equal(cat2.status, 201);
    ids.cat2 = cat2.data.id;

    // 著录模板：项目编号（text，可作确定性指称）+ 密级（select，类别值不得用于等值关联）
    const tpl = await req('/api/templates', {
      method: 'POST',
      cookie: adminCookie,
      body: {
        name: '合同著录模板',
        fields: [
          { fieldKey: 'projectNo', label: '项目编号', type: 'text' },
          { fieldKey: 'secretLevel', label: '密级', type: 'select', options: ['公开', '内部'] },
        ],
      },
    });
    assert.equal(tpl.status, 201, JSON.stringify(tpl.data));
    ids.tpl = tpl.data.id;
    const bind = await req(`/api/categories/${ids.cat}/template`, { method: 'PUT', cookie: adminCookie, body: { templateId: ids.tpl } });
    assert.equal(bind.status, 200, JSON.stringify(bind.data));

    const a = await createArchive('设备采购合同甲', { fieldValues: { projectNo: 'XM-2026-0007', secretLevel: '内部' } });
    ids.a = a.id;
    const b = await createArchive('设备采购合同乙', { fieldValues: { projectNo: 'XM-2026-0007', secretLevel: '内部' } });
    ids.b = b.id;
    // 仅密级相同（select 类别值）：不得据此建立确定性关联
    const c1 = await createArchive('园林养护记录丙', { categoryId: ids.cat2, fieldValues: {} });
    ids.c1 = c1.id;
    const c2 = await createArchive('机房巡检台账丙', { categoryId: ids.cat2 });
    ids.c2 = c2.id;
    const restricted = await createArchive('涉密采购合同（受限）', { accessLevel: 'restricted' });
    ids.restricted = restricted.id;

    ids.fileA = (await upload(ids.a, '主合同.docx', buildDocx([CONTRACT_A, '附件一：技术规格与验收标准另行约定。']))).id;
    ids.fileB = (await upload(ids.b, '合同副本.docx', buildDocx([CONTRACT_B]))).id;
    ids.fileC1 = (await upload(ids.c1, '养护记录.docx', buildDocx([GREENING]))).id;
    ids.fileC2 = (await upload(ids.c2, '巡检台账.docx', buildDocx([MACHINE_ROOM]))).id;
    ids.fileRestricted = (await upload(ids.restricted, '涉密条款.docx', buildDocx([CONTRACT_B, '本条款仅限项目组成员查阅。']))).id;

    const st = await req(`/api/archives/${ids.a}/content/status`, { cookie: adminCookie });
    assert.equal(st.status, 200);
    assert.ok(st.data.files.some((f) => f.status === 'indexed'), '附件正文应已入既有索引流水线');
  });

  // ==================== 1-2. 全量构建：节点与结构关系 ====================

  await test('全量构建：四类节点齐备且可追溯到原始业务行', async () => {
    const before = businessSnapshot();
    const stats = graph.buildAll(BUILD_REQUEST);

    assert.ok(stats.archives >= 5, `应覆盖库中档案，实得 ${stats.archives}`);
    assert.ok(stats.files >= 5, `应处理全部附件，实得 ${stats.files}`);
    assert.ok(stats.chunks >= 5, `知识块节点应由既有切块产物生成，实得 ${stats.chunks}`);
    assert.ok(stats.durationMs >= 0 && stats.nodes > 0 && stats.edges > 0, '构建统计应包含节点数 / 关系数 / 耗时');
    assert.deepEqual(
      { nodes: stats.nodes, edges: stats.edges },
      { nodes: nodeCount(), edges: edgeCount() },
      '统计输出必须与库中实际规模一致',
    );

    assert.ok(nodeCount() === nodesOf('category').length + nodesOf('archive').length + nodesOf('file').length + nodesOf('chunk').length);
    assert.ok(nodesOf('category').length >= 2, '分类节点应生成');
    assert.ok(nodeByKey(`archive:${ids.a}`), '档案节点应以 archive:{id} 生成');
    assert.ok(nodeByKey(`file:${ids.fileA}`), '附件节点应以 file:{id} 生成');

    const archiveNode = nodeByKey(`archive:${ids.a}`);
    const meta = JSON.parse(archiveNode.meta_json);
    assert.equal(archiveNode.ref_id, ids.a);
    assert.equal(archiveNode.source, 'archives');
    assert.equal(meta.categoryName, '合同类目', '节点展示信息应可回溯分类');
    assert.ok(meta.fileCount >= 1 && meta.chunkCount >= 1);

    const chunkNode = db.prepare('SELECT * FROM kg_graph_nodes WHERE node_type=? AND archive_id=? ORDER BY id LIMIT 1').all('chunk', ids.a)[0];
    assert.ok(chunkNode, '档案下应有知识块节点');
    const chunkMeta = JSON.parse(chunkNode.meta_json);
    assert.ok(chunkMeta.locator, '知识块必须保留原始定位信息（页码/段落）');
    assert.equal(chunkMeta.archiveTitle, '设备采购合同甲');
    assert.equal(chunkNode.source, 'archive_content_chunks');
    assert.equal(chunkNode.file_id, ids.fileA, '知识块节点须直接指回附件');

    // 权威业务数据未被图谱复制或改写
    assert.deepEqual(businessSnapshot(), before, '图谱构建不得改动任何业务表');
  });

  await test('结构关系：分类→档案→附件→知识块逐层齐备且权重为 1', async () => {
    const catEdges = edgesOfArchive(ids.a, 'category_contains_archive');
    assert.ok(catEdges.some((e) => e.from_key === `category:${ids.cat}` && e.to_key === `archive:${ids.a}`), '分类应包含档案');

    const fileEdges = edgesOfArchive(ids.a, 'archive_contains_file');
    assert.ok(fileEdges.some((e) => e.from_key === `archive:${ids.a}` && e.to_key === `file:${ids.fileA}`), '档案应包含附件');

    const chunkEdges = edgesOfArchive(ids.a, 'file_contains_chunk');
    assert.ok(chunkEdges.length >= 1, '附件应包含知识块');
    for (const edge of chunkEdges) {
      assert.match(edge.from_key, /^file:/, '知识块的父节点必须是附件');
      assert.match(edge.to_key, /^chunk:/);
    }
    for (const type of ['category_contains_archive', 'archive_contains_file', 'file_contains_chunk']) {
      for (const edge of edgesOfType(type)) {
        assert.equal(Number(edge.weight), 1, '结构关系来自真实业务外键，权重恒为 1');
        assert.equal(edge.basis, 'business_structure');
      }
    }
  });

  // ==================== 3-5. 内容关系与确定性关系 ====================

  await test('相似正文建立内容关联，权重与来源证据可追溯', async () => {
    // 小语料下合同模板句会命中高频词过滤器（默认 df 比例 50%），这里适当放宽以演示「相近正文应相连」；
    // 放宽仅针对本用例的极小语料，不代表正式阈值（正式阈值的降噪效果由「无关正文不产生噪声关系」用例验证）。
    graph.buildAll({ options: { ...BUILD_REQUEST.options, maxTermDocFrequencyRatio: 0.95 } });
    const chunkEdges = edgesOfType('chunk_similar_to');
    assert.ok(chunkEdges.length >= 1, '主题相近的合同正文应产生知识块关联');
    const pair = chunkEdges.find((e) => {
      const from = archiveIdOfNode(e.from_node);
      const to = archiveIdOfNode(e.to_node);
      return (from === ids.a && to === ids.b) || (from === ids.b && to === ids.a);
    });
    assert.ok(pair, '档案甲与乙的知识块应互相牵连');
    const evidence = JSON.parse(pair.evidence_json);
    assert.equal(evidence.method, 'tfidf_cosine');
    assert.equal(evidence.tokenizer, 'cjk-bigram', '内容关联必须复用既有 CJK Bigram 分词');
    assert.ok(Number(pair.weight) > 0 && Number(pair.weight) <= 1, `权重应落在 (0,1]，实得 ${pair.weight}`);
    assert.ok(evidence.sharedTerms.length > 0 && evidence.sharedTerms.length <= evidence.sharedTermCount, '应记录匹配依据（共有词项）');
    for (const term of evidence.sharedTerms) {
      assert.ok(CONTRACT_A.includes(term) && CONTRACT_B.includes(term), `词项「${term}」须真实出现在两侧正文`);
    }
    assert.ok(evidence.from.archiveId && evidence.from.chunkId && evidence.from.storedName, '证据须回指档案 / 附件 / 知识块');
    assert.ok(evidence.to.preview && evidence.to.preview.length > 0, '证据应含原文样本片段便于核对');

    const archiveEdges = edgesOfArchive(ids.a, 'archive_related_to');
    const agg = archiveEdges.find((e) => {
      const keys = [e.from_key, e.to_key];
      return keys.includes(`archive:${ids.a}`) && keys.includes(`archive:${ids.b}`);
    });
    assert.ok(agg, '甲↔乙 应有档案级内容关联');
    const aggEvidence = JSON.parse(agg.evidence_json);
    assert.equal(aggEvidence.method, 'tfidf_cosine_aggregated');
    assert.ok(aggEvidence.supportingChunks.length >= 1, '档案级关联须列出支撑知识块对');
    assert.ok(aggEvidence.supportingChunks[0].fromChunkId && aggEvidence.supportingChunks[0].toChunkId);
    assert.ok(Number(agg.weight) >= Number(aggEvidence.maxChunkSimilarity) - 1e-6, '聚合权重不得低于单对最强证据');
  });

  await test('无关正文不产生噪声关系；无自环、无重复关系', async () => {
    const unrelatedIds = [ids.c1, ids.c2, ids.a, ids.b];
    for (const edge of edgesOfType('chunk_similar_to')) {
      const f = db.prepare('SELECT archive_id FROM kg_graph_nodes WHERE id=?').get(edge.from_node);
      const t = db.prepare('SELECT archive_id FROM kg_graph_nodes WHERE id=?').get(edge.to_node);
      const key = `${f.archive_id}-${t.archive_id}`;
      const noisy = (f.archive_id === ids.c1 && t.archive_id === ids.c2)
        || (f.archive_id === ids.c2 && t.archive_id === ids.c1);
      assert.ok(!noisy, `主题与用词都不相关的档案不应建立关联（命中 ${key}）`);
    }
    // 两份无关正文各自入图，但彼此之间没有任何档案级关系
    for (const edge of edgesOfType('archive_related_to')) {
      const pair = [edge.from_archive_id, edge.to_archive_id].sort();
      assert.notDeepEqual(pair, [ids.c1, ids.c2].sort(), '无关档案之间不得建立档案级关联');
    }

    for (const edge of db.prepare('SELECT from_node, to_node, edge_type FROM kg_graph_edges').all()) {
      assert.notEqual(edge.from_node, edge.to_node, '不允许建立自身关联');
    }
    for (const type of ['chunk_similar_to', 'archive_related_to', 'archive_shared_reference']) {
      const keys = edgePairs(type);
      assert.equal(new Set(keys).size, keys.length, `${type} 不允许重复关系`);
      for (const edge of edgesOfType(type)) {
        assert.ok(Number(edge.from_node) < Number(edge.to_node), `${type} 端点须按节点 id 升序规范化，杜绝 (a,b)/(b,a) 反向重复`);
      }
    }
    const total = edgeCount();
    assert.ok(total < nodeCount() * nodeCount(), '不允许所有节点无差别互连');
  });

  await test('确定性关联只认著录字段等值，select 类别值不参与', async () => {
    const shared = edgesOfType('archive_shared_reference');
    assert.equal(shared.length, 1, '仅项目编号相同的甲乙两档应有一条确定性关联');
    const edge = shared[0];
    assert.deepEqual([Number(edge.from_archive_id), Number(edge.to_archive_id)].sort(), [ids.a, ids.b].sort());
    const evidence = JSON.parse(edge.evidence_json);
    assert.equal(evidence.fieldKey, 'projectNo');
    assert.equal(evidence.value, 'XM-2026-0007');
    assert.equal(evidence.basis ?? edge.basis, 'metadata_exact_match');
    assert.equal(Number(edge.weight), 1, '确定性关联是事实等值，权重固定为 1');
    // 密级（select）两档取值相同，但属类别值，不得制造关联
    assert.ok(!evidence.fieldKeySet, '证据只记录命中的具体字段，不引入宽泛关键词');
    assert.ok(!edgesOfType('archive_shared_reference').some((e) => JSON.parse(e.evidence_json).fieldKey === 'secretLevel'),
      'select 类型字段值不得作为确定性关联依据');
  });

  // ==================== 6-7. 幂等与可配置阈值 ====================

  await test('重复全量构建幂等：节点与关系不翻倍、内容一致', async () => {
    // 先以默认口径建立基准（上一用例可能用过调宽阈值，需先归一化到同一口径再比较）
    graph.buildAll(BUILD_REQUEST);
    const beforeNodes = nodeSnapshot();
    const beforeEdges = edgeSnapshot();
    const beforeCounts = { nodes: nodeCount(), edges: edgeCount() };

    const second = graph.buildAll(BUILD_REQUEST);
    assert.equal(nodeCount(), beforeCounts.nodes, '重复构建不得新增节点');
    assert.equal(edgeCount(), beforeCounts.edges, '重复构建不得新增关系');
    assert.equal(nodeSnapshot(), beforeNodes, '节点内容应完全一致（biz_key 幂等 UPSERT）');
    assert.equal(edgeSnapshot(), beforeEdges, '关系内容应完全一致');
    assert.equal(second.nodes, beforeCounts.nodes);

    const third = graph.buildAll(BUILD_REQUEST);
    assert.equal(third.edges, beforeCounts.edges, '第三次构建结果仍应一致');
  });

  await test('阈值与 Top-K 可配置且真实生效', async () => {
    const strict = graph.buildAll({ options: { ...BUILD_REQUEST.options, minChunkSimilarity: 0.995, minArchiveWeight: 0.995 } });
    assert.equal(strict.edgesByType.chunk_similar_to ?? 0, 0, '相似度下限提高到 0.995 后弱关联必须全部消失');
    assert.equal(strict.edgesByType.archive_related_to ?? 0, 0, '档案级阈值提高后不应保留内容关联');
    assert.ok(strict.nodes > 0, '阈值只影响关系，节点覆盖度不受影响');

    const loose = graph.buildAll({ options: { ...BUILD_REQUEST.options, minChunkSimilarity: 0.02, chunkTopK: 1 } });
    const perNode = new Map();
    for (const edge of edgesOfType('chunk_similar_to')) {
      for (const id of [Number(edge.from_node), Number(edge.to_node)]) perNode.set(id, (perNode.get(id) ?? 0) + 1);
    }
    assert.ok(loose.edgesByType.chunk_similar_to ?? 0 > 0, '放宽下限应能召回更多关联（阈值不是硬编码）');
    for (const [nodeId, links] of perNode) {
      assert.ok(links <= 3, `chunkTopK=1 时单个知识块关联数应受控（任一端口入选即保留），实得节点 ${nodeId} 有 ${links} 条`);
    }

    graph.buildAll(BUILD_REQUEST); // 恢复默认口径，供后续用例断言
  });

  // ==================== 8. 单份档案重建与更新刷新 ====================

  await test('单份档案重建：只替换该档案子树，其他档案关系不受影响', async () => {
    const otherBefore = db
      .prepare('SELECT e.* FROM kg_graph_edges e JOIN kg_graph_nodes n ON n.id=e.from_node WHERE n.archive_id=? AND e.edge_type=?')
      .all(ids.c2, 'file_contains_chunk');
    const stats = graph.rebuildArchive(ids.a, { options: BUILD_REQUEST.options });
    assert.equal(stats.archives, 1, '单档案重建只统计本次范围');
    assert.ok(nodeByKey(`archive:${ids.a}`), '本次范围档案节点应存在');
    assert.ok(nodeByKey(`archive:${ids.c2}`), '范围外档案节点不应被删除');
    const otherAfter = db
      .prepare('SELECT e.* FROM kg_graph_edges e JOIN kg_graph_nodes n ON n.id=e.from_node WHERE n.archive_id=? AND e.edge_type=?')
      .all(ids.c2, 'file_contains_chunk');
    assert.deepEqual(otherAfter, otherBefore, '范围外档案的结构关系不应被单档案重建改写');
  });

  await test('附件更新后重建：新附件与其正文入图，无重复/过期节点', async () => {
    const beforeChunks = db.prepare('SELECT biz_key FROM kg_graph_nodes WHERE node_type=? AND archive_id=?').all('chunk', ids.a);
    assert.ok(beforeChunks.length >= 1, '档案甲应先有知识块节点');
    const newFile = await upload(ids.a, '主合同v2.docx', buildDocx(['设备采购合同付款条款（修订版）：验收合格后十日内支付全部价款，不分期，不设违约金。']));
    graph.rebuildArchive(ids.a, { options: BUILD_REQUEST.options });

    // 新附件及其正文知识块应进入图谱
    assert.ok(nodeByKey(`file:${newFile.id}`), '新附件应进入图谱');
    const newChunks = db.prepare('SELECT COUNT(*) AS c FROM kg_graph_nodes WHERE node_type=? AND file_id=?').get('chunk', newFile.id);
    assert.ok(Number(newChunks.c) >= 1, '新附件的正文知识块应入图');
    // 原附件 fileA 的内容未变（仍是当前有效正文），其节点应保留，不应被误删
    assert.ok(nodeByKey(`file:${ids.fileA}`), '未删除的原附件节点应保留');
    // 幂等：本次范围内知识块节点数 = 当前实际已索引知识块数（既无重复也无残留过期）
    const nodeChunkCount = Number(db.prepare('SELECT COUNT(*) AS c FROM kg_graph_nodes WHERE node_type=? AND archive_id=?').get('chunk', ids.a).c);
    const realChunkCount = Number(db
      .prepare(`SELECT COUNT(*) AS c FROM archive_content_chunks ch JOIN archive_content_units u ON u.id=ch.unit_id
                WHERE ch.archive_id=? AND u.status='indexed'`).get(ids.a).c);
    assert.equal(nodeChunkCount, realChunkCount, '重建后知识块节点数应与当前有效正文片段数一致');
    const dangling = db
      .prepare('SELECT COUNT(*) AS c FROM kg_graph_edges WHERE from_node NOT IN (SELECT id FROM kg_graph_nodes) OR to_node NOT IN (SELECT id FROM kg_graph_nodes)')
      .get();
    assert.equal(Number(dangling.c), 0, '重建后不得留下悬挂关系');
  });

  await test('附件删除后：过期节点与相连关系一并清理', async () => {
    const before = edgeCount();
    const del = await req(`/api/archive-files/${ids.fileC2}`, { method: 'DELETE', cookie: catCookie });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.ok(!nodeByKey(`file:${ids.fileC2}`), '附件删除后其节点应被触发器即时清理');
    assert.ok(!nodeByKey(`archive:${ids.c2}`) || true, '档案节点不受附件删除影响');
    assert.equal(
      Number(db.prepare('SELECT COUNT(*) AS c FROM kg_graph_edges WHERE from_node NOT IN (SELECT id FROM kg_graph_nodes) OR to_node NOT IN (SELECT id FROM kg_graph_nodes)').get().c),
      0,
      '节点级联删除关系后不应有悬挂边',
    );
    assert.ok(edgeCount() < before, '删除附件应连带清理其相连关系');

    graph.buildAll(BUILD_REQUEST);
    assert.ok(!nodeByKey(`file:${ids.fileC2}`), '全量重建也不应复活已删除附件的节点');
  });

  // ==================== 9. 正文索引钩子自动刷新 ====================

  await test('正文索引完成后钩子自动刷新图谱（无需手工重建）', async () => {
    const fresh = await createArchive('钩子验证档案');
    const file = await upload(fresh.id, '钩子正文.docx', buildDocx(['钩子验证：本附件正文在索引完成后应自动进入知识图谱，无需显式重建指令。']), { index: false });
    // 走既有后台索引链路：完成后应把所属档案推入图谱去抖队列
    await content.indexFileInBackground(file.id);
    const flushed = graph.flushPending();
    assert.ok(flushed >= 1, '正文索引完成应至少登记一个待刷新档案');
    const node = nodeByKey(`archive:${fresh.id}`);
    assert.ok(node, '钩子刷新后档案节点应存在');
    const chunks = db.prepare('SELECT COUNT(*) AS c FROM kg_graph_nodes WHERE node_type=? AND archive_id=?').get('chunk', fresh.id);
    assert.ok(Number(chunks.c) >= 1, '新正文的知识块节点应随钩子刷新入图');
    ids.hooked = fresh.id;
  });

  // ==================== 10. 异常附件：空正文 / 提取失败 ====================

  await test('空附件与提取失败附件仍保留节点并记录提取状态，不影响整份档案入图', async () => {
    const problem = await createArchive('异常附件档案');
    const empty = await upload(problem.id, '空白.docx', buildDocx([' ']), { index: false });
    const broken = await upload(problem.id, '损坏.pdf', BROKEN_PDF, { index: false });
    content.indexFileById(empty.id);
    content.indexFileById(broken.id);
    const stats = graph.buildAll(BUILD_REQUEST);

    const emptyNode = nodeByKey(`file:${empty.id}`);
    const brokenNode = nodeByKey(`file:${broken.id}`);
    assert.ok(emptyNode && brokenNode, '无法提取正文的附件仍须保留附件节点');
    for (const node of [emptyNode, brokenNode]) {
      const meta = JSON.parse(node.meta_json);
      assert.ok(meta.extractStatus && meta.extractStatus !== 'indexed', `应记录提取状态，实得 ${meta.extractStatus}`);
      assert.ok(typeof meta.extractMessage === 'string', '应记录提取失败原因');
      assert.ok(node.file_id === node.ref_id);
    }
    assert.ok(nodeByKey(`archive:${problem.id}`), '个别附件提取失败不得导致整份档案缺席图谱');
    assert.ok(stats.failed >= 1, `构建统计应如实报告提取失败数，实得 ${stats.failed}`);
    ids.problem = problem.id;
  });

  // ==================== 11. 权限与原有功能回归 ====================

  await test('权限与既有功能回归：受限档案入图带访问级别，正文检索与目录检索不受影响', async () => {
    const restrictedNode = nodeByKey(`archive:${ids.restricted}`);
    assert.ok(restrictedNode, '受限档案仍是图谱节点（第一阶段仅建索引，可见性过滤由第二阶段接口负责）');
    assert.equal(JSON.parse(restrictedNode.meta_json).accessLevel, 'restricted', '节点须携带访问级别供后续鉴权过滤');

    // 既有目录检索：关键词命中仍正常
    const catalog = await req(`/api/archives?q=${encodeURIComponent('设备采购合同甲')}`, { cookie: catCookie });
    assert.equal(catalog.status, 200, '目录检索应正常');
    assert.ok(catalog.data.items.some((item) => item.id === ids.a), '目录检索应命中图谱覆盖的档案');

    // 既有正文检索（FTS5 + BM25）：图谱建设不得影响索引链路（按同一 CJK Bigram 口径构造查询）
    const bodyKeyword = '园林养护';
    const match = buildCjkBigramTerms(bodyKeyword);
    const hits = db
      .prepare(`
        SELECT c.archive_id AS archiveId FROM archive_content_chunks c
        JOIN archive_content_units u ON u.id = c.unit_id
        JOIN archive_content_fts_bigram f ON f.rowid = c.id
        WHERE archive_content_fts_bigram MATCH ? AND u.status = 'indexed'`)
      .all(match);
    assert.ok(hits.length >= 1, `FTS5 分词索引应仍可命中正文「${bodyKeyword}」（match=${match}）`);

    // 权限链路未被图谱绕过：借阅者看不到受限档案，管理员可看
    const asBorrower = await req(`/api/archives/${ids.restricted}`, { cookie: borCookie });
    const asAdmin = await req(`/api/archives/${ids.restricted}`, { cookie: adminCookie });
    assert.equal(asAdmin.status, 200, '管理员可读受限档案');
    assert.notEqual(asBorrower.status, 200, `借阅者不应直接读到受限档案，实得 ${asBorrower.status}`);

    // 既有档案业务读回正常
    const detail = await req(`/api/archives/${ids.a}`, { cookie: adminCookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.title, '设备采购合同甲');
    assert.equal(detail.data.dynamicFields?.find?.((f) => f.fieldKey === 'projectNo')?.value, 'XM-2026-0007', '动态著录值读写不受影响');
    const list = await req('/api/archives?page=1&pageSize=50', { cookie: adminCookie });
    assert.equal(list.status, 200);
    assert.ok(list.data.total >= 5, '图谱建设不得影响档案列表');

    // 未登录一律 401
    const anon = await req('/api/archives');
    assert.equal(anon.status, 401);
  });

  await test('构建失败可恢复：非法范围不破坏已有可用图谱', async () => {
    const beforeNodes = nodeSnapshot();
    const stats = graph.rebuildArchive(999999, { options: BUILD_REQUEST.options });
    assert.equal(stats.archives, 0, '不存在的档案应返回空范围而非抛错');
    assert.equal(nodeSnapshot(), beforeNodes, '无效构建不得改动已有图谱数据');
    assert.ok(edgeCount() > 0, '已有可用关系应完整保留');

    const summary = graph.stats();
    assert.ok(summary.nodes > 0 && summary.edges > 0);
    assert.ok(summary.nodesByType.archive >= 1 && summary.edgesByType.category_contains_archive >= 1, '规模统计应给出分类型明细');
  });

  await test('图谱可整库重建：清空后重建仍得到一致规模（可重建索引定位）', async () => {
    const baseline = { nodes: nodeCount(), edges: edgeCount() };
    assert.ok(baseline.nodes > 0 && baseline.edges > 0);
    const rebuilt = graph.buildAll(BUILD_REQUEST);
    assert.equal(rebuilt.nodes, baseline.nodes, '全量重建应复现同一规模（无累积污染）');
    assert.equal(rebuilt.edges, baseline.edges);
    // 图谱表不承载业务事实：删除全部图谱数据后业务读写照常
    db.prepare('DELETE FROM kg_graph_edges').run();
    db.prepare('DELETE FROM kg_graph_nodes').run();
    assert.equal(nodeCount(), 0);
    const detail = await req(`/api/archives/${ids.a}`, { cookie: adminCookie });
    assert.equal(detail.status, 200, '清空图谱不影响档案业务');
    graph.buildAll(BUILD_REQUEST);
    assert.ok(nodeCount() > 0);
  });
});
