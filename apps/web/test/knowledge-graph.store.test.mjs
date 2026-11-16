/**
 * 档案知识图谱 · 前端状态层真实数据测试（第二阶段）。
 *
 * 直接对真实后端跑：起 Nest 测试实例（独立测试库 + 独立存储目录）→ 真实著录/上传/正文索引 → 真实构建图谱
 * → 在 Node 里挂载 Pinia store，让 store 通过 fetch 打真实接口。全程不使用模拟节点或静态数字，
 * 断言一律与「直接查库重算」的结果逐位对照。
 * 运行：npm run build:api 后 node --experimental-transform-types --test test/knowledge-graph.store.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPinia, setActivePinia } from 'pinia';
import PizZip from 'pizzip';

import { bootstrap } from '../../api/dist/main.js';
import { DATABASE } from '../../api/dist/db/database.js';
import { ContentIndexService } from '../../api/dist/archives/content/content-index.service.js';
import { GraphBuildService } from '../../api/dist/graph/graph.service.js';
import { GraphModule } from '../../api/dist/graph/graph.module.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = path.join(__dirname, '..', '..', 'api', 'storage', `test-kgstore-${process.pid}.db`);
const FILE_STORE = path.join(__dirname, '..', '..', 'api', 'storage', `test-kgstore-files-${process.pid}`);

const CONTRACT_A = '设备采购合同付款条款：验收合格后十五个工作日内支付百分之三十尾款，逾期每日千分之五违约金，质保期一年。';
const CONTRACT_B = '设备采购合同付款条款：验收合格后二十个工作日内支付百分之四十尾款，逾期每日千分之三违约金，质保期两年。';
const SECRET_TOKEN = '海豚专项津贴核定';
const RESTRICTED_TEXT = `${SECRET_TOKEN}表：科员每人每月补贴二百六十元，经费由专项预算列支，名册仅人事科可见。`;

let server = null;
let app = null;
let db = null;
let cookie = '';
let borrowerCookie = '';
let guestCookie = '';
const ids = {};

const nativeFetch = globalThis.fetch;
let requests = 0;
const delays = new Map();

/** 前端 api/client 用同源相对路径，这里补成真实服务地址并注入会话 Cookie；可按关键词注入延迟制造竞态。 */
globalThis.fetch = async (input, init = {}) => {
  const raw = String(input);
  const url = raw.startsWith('/api') ? `${server.baseUrl}${raw}` : raw;
  requests += 1;
  const matched = /[?&]q=([^&]*)/u.exec(url);
  if (matched) {
    const delay = delays.get(decodeURIComponent(matched[1]));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const headers = new Headers(init.headers ?? {});
  const useCookie = /\/knowledge-graph\//u.test(url) ? (globalThis.__kgCookie ?? cookie) : /\/agent\//u.test(url) ? (globalThis.__agentCookie ?? cookie) : cookie;
  if (useCookie) headers.set('Cookie', useCookie);
  return nativeFetch(url, { ...init, headers });
};

function safeRm(f) { try { rmSync(f, { force: true }); } catch { /* EPERM 忽略 */ } }
function safeRmDir(d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ } }

async function req(pathname, { method = 'GET', body, at } = {}) {
  const res = await nativeFetch(`${server.baseUrl}${pathname}`, {
    method,
    headers: { Cookie: at ?? cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: setCookie?.match(/jit_sid=([0-9a-f]*)/u)?.[1] ? `jit_sid=${setCookie.match(/jit_sid=([0-9a-f]*)/u)[1]}` : at };
}

function docx(paragraphs) {
  const zip = new PizZip();
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}

async function upload(archiveId, name, bytes) {
  const res = await nativeFetch(`${server.baseUrl}/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  const data = await res.json();
  assert.equal(res.status, 201, JSON.stringify(data));
  app.get(ContentIndexService).indexFileById(data.id);
  return data;
}

/** 直接查库重算当前用户可见规模（与接口口径独立，用于逐位对照）。 */
function expectCounts(userId, admin) {
  const where = admin ? '1=1' : `a.access_level = 'public' OR a.created_by = ? OR EXISTS (SELECT 1 FROM borrow_grants g WHERE g.archive_id = a.id AND g.user_id = ? AND g.can_view = 1 AND g.status = 'active' AND datetime(g.expires_at) > datetime('now'))`;
  const args = admin ? [] : [userId, userId];
  return {
    archives: Number(db.prepare(`SELECT COUNT(1) AS c FROM archives a WHERE ${where}`).get(...args).c),
    files: Number(db.prepare(`SELECT COUNT(1) AS c FROM archive_files f JOIN archives a ON a.id = f.archive_id WHERE ${where}`).get(...args).c),
  };
}

/** store 的全部可见状态序列化（用于「受限档案零泄露」检查）。 */
function storeDump(store) {
  return JSON.stringify({
    nodes: store.nodes,
    edges: store.edges,
    overview: store.overview,
    detail: store.detail,
    relations: store.relations,
    search: store.searchResult,
  });
}

let store = null;
let adminId = 0;

test.describe('知识图谱前端状态层（真实后端 / 权限 / 竞态 / 缓存）', { concurrency: false }, async () => {
  test.before(async () => {
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
    server = await bootstrap({
      port: 0,
      dbFile: DB_FILE,
      fileStoreDir: FILE_STORE,
      serveWeb: false,
      knowledgeWorker: false,
      aiModelClient: { available: false, model: 'stub', async chatCompletion() { throw new Error('图谱状态层用例不得触达模型'); } },
    });
    app = server.app;
    db = app.get(DATABASE);

    const init = await req('/api/auth/init-admin', { method: 'POST', body: { username: 'kgs_root', password: 'Admin#12345', displayName: '状态层管理员' }, at: '' });
    assert.equal(init.status, 201);
    cookie = init.cookie;
    adminId = init.data.id;
    const cat = await req('/api/users', { method: 'POST', body: { username: 'kgs_bor', password: 'User#12345', displayName: '借阅者甲', role: 'borrower' } });
    assert.equal(cat.status, 201);
    borrowerCookie = (await req('/api/auth/login', { method: 'POST', body: { username: 'kgs_bor', password: 'User#12345' }, at: '' })).cookie;
    const guest = await req('/api/users', { method: 'POST', body: { username: 'kgs_gst', password: 'User#12345', displayName: '访客甲', role: 'guest' } });
    assert.equal(guest.status, 201);
    guestCookie = (await req('/api/auth/login', { method: 'POST', body: { username: 'kgs_gst', password: 'User#12345' }, at: '' })).cookie;

    const parent = await req('/api/categories', { method: 'POST', body: { name: '合同类目', code: 'HT' } });
    ids.parent = parent.data.id;
    const child = await req('/api/categories', { method: 'POST', body: { name: '采购合同', code: 'HTCG', parentId: ids.parent } });
    ids.child = child.data.id;
    const other = await req('/api/categories', { method: 'POST', body: { name: '行政类目', code: 'XZ' } });
    ids.other = other.data.id;

    const a = await req('/api/archives', { method: 'POST', body: { title: '设备采购合同甲', categoryId: ids.child, archiveType: '文书档案' } });
    ids.a = a.data.id;
    ids.aNo = a.data.archiveNo;
    const b = await req('/api/archives', { method: 'POST', body: { title: '设备采购合同乙', categoryId: ids.child, archiveType: '文书档案' } });
    ids.b = b.data.id;
    const c = await req('/api/archives', { method: 'POST', body: { title: '车辆使用登记丙', categoryId: ids.other } });
    ids.c = c.data.id;
    const restricted = await req('/api/archives', { method: 'POST', body: { title: `${SECRET_TOKEN}名册（受限）`, categoryId: ids.other, accessLevel: 'restricted' } });
    ids.restricted = restricted.data.id;
    ids.restrictedNo = restricted.data.archiveNo;

    ids.fileA = (await upload(ids.a, '主合同.docx', docx([CONTRACT_A]))).id;
    ids.fileB = (await upload(ids.b, '合同副本.docx', docx([CONTRACT_B]))).id;
    ids.fileC = (await upload(ids.c, '登记表.docx', docx(['车辆使用登记：本月出车十二次，油耗与里程见附表。']))).id;
    ids.fileRestricted = (await upload(ids.restricted, '名册.docx', docx([RESTRICTED_TEXT]))).id;

    const graph = app.select(GraphModule).get(GraphBuildService);
    const stats = graph.buildAll({ options: { minChunkCharsForSimilarity: 10 }, syncContent: true });
    assert.ok(stats.nodes > 0 && stats.edges > 0, '图谱应已真实构建');

    setActivePinia(createPinia());
    const { useKnowledgeGraphStore } = await import('../src/stores/knowledgeGraph.ts');
    store = useKnowledgeGraphStore();
  });

  test.after(async () => {
    if (app) await app.close();
    for (const s of ['', '-wal', '-shm']) safeRm(`${DB_FILE}${s}`);
    safeRmDir(FILE_STORE);
  });

  await test('概览统计来自真实数据库，与直接查库一致', async () => {
    await store.loadOverview();
    const exp = expectCounts(adminId, true);
    assert.equal(store.overview.archives, exp.archives, '档案数应等于库中可见档案数');
    assert.equal(store.overview.files, exp.files, '附件数应等于库中可见附件数');
    assert.equal(store.overview.notBuilt, false);
    assert.ok(store.overview.chunks > 0, '正文知识块应已入图');
    assert.ok(store.overview.relations > 0, '关系数应来自真实边');
    const names = store.overview.categoryList.map((c) => c.name);
    assert.ok(names.includes('采购合同') && names.includes('合同类目'), '分类列表应含真实分类与父分类');
  });

  await test('默认首层只加载分类与档案，不一次性拉全部知识块', async () => {
    await store.loadLayer();
    assert.ok(store.nodes.length > 0, '首层必须有真实节点');
    const types = new Set(store.nodes.map((n) => n.type));
    assert.ok(types.has('category') && types.has('archive'), '首层应含分类与档案层');
    assert.equal(types.has('chunk'), false, '默认不得加载正文知识块层');
    const labels = store.nodes.filter((n) => n.type === 'archive').map((n) => n.label);
    assert.ok(labels.includes('设备采购合同甲'), '节点标签必须是库中真实档案标题');
    assert.equal(store.positions.size, store.nodes.length, '每个已加载节点都应有位置缓存');
  });

  await test('双击展开按需增补附件层，重复展开命中缓存不再请求', async () => {
    const archiveNode = store.nodes.find((n) => n.key === `archive:${ids.a}`);
    assert.ok(archiveNode, '画布上应有甲档案节点');
    const before = requests;
    await store.expandNode(archiveNode);
    assert.ok(requests > before, '首次展开应真实请求接口');
    const files = store.nodes.filter((n) => n.type === 'file');
    assert.ok(files.some((n) => n.refId === ids.fileA), '展开后应出现该档案的真实附件节点');
    assert.ok(store.edges.some((e) => e.type === 'archive_contains_file' && e.to === `file:${ids.fileA}`), '结构关系应随节点一起返回');
    const afterFirst = requests;
    await store.expandNode(store.nodes.find((n) => n.key === `file:${ids.fileA}`));
    assert.ok(requests > afterFirst, '附件展开是另一个中心节点，应真实请求');
    const afterFile = requests;
    await store.expandNode(archiveNode);
    assert.equal(requests, afterFile, '同一节点重复展开应命中缓存，不重复请求');
  });

  await test('分类视图只含该子树，切回全景不残留上一个分类的节点', async () => {
    await store.pickCategory(ids.child);
    assert.equal(store.viewMode, 'category');
    const archives = store.nodes.filter((n) => n.type === 'archive').map((n) => n.refId).sort((x, y) => x - y);
    assert.deepEqual(archives, [ids.a, ids.b].sort((x, y) => x - y), '分类视图只应出现该分类下的可见档案');
    assert.equal(store.nodes.some((n) => n.refId === ids.c), false, '其他分类的档案不得残留');

    await store.pickCategory(null);
    assert.equal(store.viewMode, 'panorama');
    assert.ok(store.nodes.some((n) => n.refId === ids.c), '全景视图应重新出现全部档案');
  });

  await test('受限档案对借阅者与访客完全不可见，管理员可见（零存在性泄露）', async () => {
    globalThis.__kgCookie = guestCookie;
    store.invalidate();
    await store.loadOverview(true);
    await store.loadLayer();
    const dump = storeDump(store);
    for (const token of [`archive:${ids.restricted}`, `file:${ids.fileRestricted}`, ids.restrictedNo, SECRET_TOKEN]) {
      assert.equal(dump.includes(String(token)), false, `访客可见范围不得出现受限标识 ${token}`);
    }
    const guestArchives = store.overview.archives;
    assert.equal(guestArchives, expectCounts(db.prepare("SELECT id FROM users WHERE username='kgs_gst'").get().id, false).archives, '访客统计应按其可见档案重算');

    await store.search(SECRET_TOKEN);
    assert.equal(store.searchResult.total, 0, '访客搜索不得命中受限档案');

    globalThis.__kgCookie = cookie;
    store.invalidate();
    await store.loadLayer();
    assert.ok(storeDump(store).includes(`archive:${ids.restricted}`), '管理员应看到全部真实节点');
  });

  await test('搜索定位：命中节点后自动展开、聚焦并联动右栏详情', async () => {
    globalThis.__kgCookie = cookie;
    store.invalidate();
    await store.loadLayer();
    await store.search('车辆使用登记');
    const hit = store.searchHits.find((h) => h.type === 'archive');
    assert.ok(hit, '应按真实标题命中档案节点');
    assert.equal(hit.inGraph, true);
    await store.locateHit(hit);
    assert.equal(store.selectedKey, `archive:${ids.c}`, '命中后应选中对应节点');
    assert.equal(store.focusRequest?.key, `archive:${ids.c}`, '应发出聚焦请求让画布定位');
    assert.equal(store.detail?.type, 'archive');
  });

  await test('过期搜索响应被丢弃，后发请求结果不被旧结果覆盖', async () => {
    delays.set('合同', 220);
    const slow = store.search('合同');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fast = store.search('养护记录不存在词');
    await fast;
    const fastQuery = store.searchResult.query;
    await slow;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(store.searchResult.query, fastQuery, '慢请求回包时不得覆盖新请求结果');
    delays.clear();
  });

  await test('点击关系线可读取真实依据与证据；节点详情返回真实定位', async () => {
    const edge = store.edges.find((e) => e.type === 'category_contains_archive');
    assert.ok(edge, '结构关系应已加载');
    await store.selectEdge(edge);
    assert.equal(store.selectedEdgeId, edge.id);
    assert.equal(store.selectedKey, edge.from, '选中关系线应同时定位到关系起点');
    assert.ok(store.nodeByKey.has(edge.from) && store.nodeByKey.has(edge.to), '关系两端都必须是已加载的上画布节点');
    assert.equal(edge.basis, 'business_structure', '结构关系应带真实计算依据');
    assert.ok(edge.label.length > 0 && edge.reason.length > 0, '关系名称与关联原因必须来自后端真实字段');
    assert.equal(JSON.stringify(edge).includes('meta_json'), false, '连线视图不得带出内部 meta_json');

    const chunkNode = await (async () => {
      const archiveNode = store.nodes.find((n) => n.key === `archive:${ids.a}`);
      await store.expandNode(archiveNode, 3);
      return store.nodes.find((n) => n.type === 'chunk');
    })();
    assert.ok(chunkNode, 'depth=3 展开应带出正文知识块节点');
    await store.selectNode(chunkNode);
    assert.equal(store.detail.type, 'chunk');
    assert.ok(store.detail.excerpt.length > 0, '摘录必须来自真实正文');
    assert.match(store.detail.locator, /^DOCX 第 \d+(-\d+)? 段$/u, '定位信息应为真实段落区间');
    assert.equal(store.detail.archive.id, ids.a);

    await store.loadRelations(store.nodeByKey.get(`archive:${ids.a}`));
    assert.ok(store.relations.items.length > 0, '档案关联应返回真实关系');
    assert.ok(store.relations.items.every((item) => item.evidence.basis !== 'unknown'), '证据必须带真实计算依据');
    const aggregated = store.relations.items.find((item) => item.edge.type === 'archive_related_to');
    assert.ok(aggregated, '两份相似合同之间应有真实的档案级关联');
    assert.equal(aggregated.evidence.basis, 'tfidf_cosine_aggregated');
    assert.ok(aggregated.evidence.supportCount >= 1, '聚合相似度必须有支撑知识块');
    assert.ok(String(aggregated.evidence.formula).length > 0, '应给出可解释的计算公式而不是黑箱数字');
    assert.ok(aggregated.node.key === `archive:${ids.b}`, '关联节点应指向真实的另一份合同');
    assert.equal(JSON.stringify(store.relations).includes('meta_json'), false, '关系证据不得泄露内部 meta_json');
  });

  await test('借阅授权实时生效：获批后受限档案才进入图谱', async () => {
    globalThis.__kgCookie = borrowerCookie;
    store.invalidate();
    await store.loadLayer();
    assert.equal(storeDump(store).includes(`archive:${ids.restricted}`), false, '未获授权时不应出现');
    const borrowerId = db.prepare("SELECT id FROM users WHERE username='kgs_bor'").get().id;
    const apply = await req('/api/borrow-requests', {
      method: 'POST',
      at: borrowerCookie,
      body: { archiveId: ids.restricted, purpose: '图谱权限联调', days: 7 },
    });
    assert.equal(apply.status, 201, JSON.stringify(apply.data));
    ids.loan=apply.data.id;
    await req(`/api/borrow-requests/${apply.data.id}/approve`, { method: 'POST', body: { note: '同意' } });
    store.invalidate();
    await store.loadLayer();
    assert.ok(storeDump(store).includes(`archive:${ids.restricted}`), '授权后应出现在借阅者的图谱里');
    assert.equal(borrowerId > 0, true);
    globalThis.__kgCookie = cookie;
  });

  await test('主题切换与收起子树都不会丢失或重排已加载数据', async () => {
    const before = { nodes: store.nodes.map((n) => n.key).sort(), edges: store.edges.map((e) => e.id).sort(), positions: [...store.positions.entries()].sort(([a], [b]) => a.localeCompare(b)) };
    store.setTheme('dark');
    assert.equal(store.theme, 'dark');
    assert.deepEqual(store.nodes.map((n) => n.key).sort(), before.nodes, '切主题不得丢节点');
    assert.deepEqual([...store.positions.entries()].sort(([a], [b]) => a.localeCompare(b)), before.positions, '切主题不得重排位置');
    store.setTheme('light');

    const archiveNode = store.nodeByKey.get(`archive:${ids.a}`);
    await store.expandNode(archiveNode, 3);
    assert.ok(store.nodes.some((n) => n.key === `file:${ids.fileA}`), '收起前应已展开该档案的附件层');
    const beforeCollapse = store.nodes.length;
    store.collapseNode(archiveNode);
    assert.ok(store.nodes.length < beforeCollapse, '收起应移除该节点已展开的下层');
    assert.ok(store.nodes.some((n) => n.type === 'category'), '上层分类节点应保留');
    assert.equal(store.nodes.some((n) => n.key === `file:${ids.fileA}`), false, '收起后其附件层不再在画布上');
  });

  await test('布局只随拓扑变化执行一次：主题 / 详情不重排，展开只让新节点收敛', async () => {
    globalThis.__kgCookie = cookie;
    store.invalidate();
    await store.loadLayer();
    const runsAfterLoad = store.layoutRuns;
    assert.equal(store.layoutSettled, true, '真实全景图必须真正收敛（否则会保留未稳定的位置）');
    const snapshot = new Map([...store.positions.entries()].map(([key, point]) => [key, { x: point.x, y: point.y }]));
    const drift = () => {
      let max = 0;
      for (const [key, point] of snapshot) {
        const now = store.positions.get(key);
        assert.ok(now, `${key} 的位置不得丢失`);
        max = Math.max(max, Math.hypot(now.x - point.x, now.y - point.y));
      }
      return max;
    };

    // 主题切换 / 选中详情 / 重复应用同一层缓存：都不得再次布局
    const archiveNode = store.nodes.find((n) => n.type === 'archive');
    assert.ok(archiveNode, '全景图应含真实档案节点');
    store.setTheme('dark');
    await store.selectNode(archiveNode);
    assert.equal(store.layoutRuns, runsAfterLoad, '主题切换与右栅详情不得触发布局');
    assert.equal(drift(), 0, '主题 / 详情 / 重绘后既有节点坐标必须逐位不变');
    store.setTheme('light');

    // 展开子图：只多一次增量布局，既有节点一动不动，新节点落在父节点附近
    await store.expandNode(archiveNode);
    assert.equal(store.layoutRuns, runsAfterLoad + 1, '展开新增节点应只执行一次增量布局');
    assert.equal(store.layoutSettled, true, '增量布局必须在预算内收敛');
    assert.equal(drift(), 0, '展开不得让已加载节点重新分布（增量布局冻结它们）');
    const child = store.nodes.find((n) => n.key !== archiveNode.key && (n.type === 'file' || n.type === 'archive') && store.positions.has(n.key));
    assert.ok(child, '展开后应有新增节点获得位置');
    const parentPoint = store.positions.get(archiveNode.key);
    const childPoint = store.positions.get(child.key);
    assert.ok(Math.hypot(childPoint.x - parentPoint.x, childPoint.y - parentPoint.y) < 420, '新节点应出现在父节点附近');
  });

  await test('空库与异常参数如实回落，不伪造数据', async () => {
    store.invalidate();
    store.viewMode = 'panorama';
    const before = requests;
    await store.search('   ');
    assert.equal(store.searchResult, null, '空关键词不发请求');
    assert.equal(requests, before);
    await store.selectNode({ ...store.nodeByKey.get(`archive:${ids.a}`), refId: 987654, key: 'archive:987654' });
    assert.equal(store.detail, null);
    assert.ok(store.detailError.length > 0, '失效节点应给出真实错误提示而不是空面板');
  });
  await test('借阅归还后，图谱详情、Agent当前会话重载及刷新均清除缓存资料', async()=>{
    globalThis.__kgCookie=borrowerCookie;globalThis.__agentCookie=borrowerCookie;
    assert.equal(await store.locateReference({type:'archive',refId:ids.restricted}),true);
    const node=store.selectedNode;assert.ok(node);assert.ok(JSON.stringify(store.detail).includes('受限'));
    const {useAgentStore}=await import('../src/stores/agent.ts');const agent=useAgentStore();
    assert.equal(await agent.ask(ids.restrictedNo),true);assert.ok(agent.messages.some(m=>m.payload?.items?.some(a=>a.id===ids.restricted)));
    const requestsBefore=requests;await agent.selectConversation(agent.currentId);assert.ok(requests>requestsBefore,'再次选择当前会话仍向后端重新核验');
    const returned=await req('/api/borrow-requests/'+ids.loan+'/return',{method:'POST',at:borrowerCookie,body:{}});assert.equal(returned.status,201);
    await agent.refreshReferences();assert.ok(agent.messages.some(m=>m.payload?.kind==='error'));
    assert.ok(!JSON.stringify(agent.messages).includes(SECRET_TOKEN));assert.ok(!agent.messages.some(m=>m.payload?.items?.some(a=>a.id===ids.restricted)));
    await store.selectNode(node);assert.equal(store.detail,null);assert.equal(store.nodes.length,0);assert.equal(store.edges.length,0);
    assert.ok(!storeDump(store).includes(SECRET_TOKEN));
    delete globalThis.__kgCookie;delete globalThis.__agentCookie;
  });

});
