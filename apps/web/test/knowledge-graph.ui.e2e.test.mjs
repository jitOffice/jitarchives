/**
 * 档案知识图谱 · 页面 UI 端到端测试（第二阶段）。
 *
 * 前提：先执行 npm run build（后端 dist + 前端 web/dist），并安装 Playwright 与本地 Chromium。
 * 未安装 Playwright 时整个用例如实跳过（skip），不伪造 UI 结论。
 * 数据全部真实：真实 Nest 实例 + 真实著录/上传/正文索引/建图，页面加载的节点、统计、搜索、权限判断都走真实接口；
 * 只有外部 JITWord 预览 SDK 用本地桩替换（与 agent-flow.e2e.test.mjs 同一约定）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';

const require = createRequire(import.meta.url);
let chromium = null;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
} catch {
  chromium = null; // 本机未安装 Playwright：跳过并在交付报告中说明前提
}

const CONTRACT_A = '设备采购合同付款条款：验收合格后十五个工作日内支付百分之三十尾款，逾期每日千分之五违约金，质保期一年。';
const CONTRACT_B = '设备采购合同付款条款：验收合格后二十个工作日内支付百分之四十尾款，逾期每日千分之三违约金，质保期两年。';
const SECRET_TOKEN = '海豚专项津贴核定';
const RESTRICTED_TEXT = `${SECRET_TOKEN}表：科员每人每月补贴二百六十元，经费由专项预算列支，名册仅人事科可见。`;
/** 档案节点渐变填充色范围（匹配青绿色节点本体，不依赖某一个纯色像素）。 */
const DARK_BG = [0x17, 0x18, 0x1a];

const output = process.env.JIT_E2E_OUTPUT_DIR;

/** 画布真实绘制证据：青绿色节点像素数 + 全图像素哈希（缩放/平移/换主题都会改变）。 */
async function paintStats(page) {
  return page.evaluate(
    ([darkRgb]) => {
      const canvas = document.querySelector('[data-testid="kg-canvas"]');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const { width, height } = canvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let archivePixels = 0;
      let darkPixels = 0;
      let hash = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        const archiveFill = data[i] < 80 && data[i + 1] > 120 && data[i + 2] > 90 && data[i + 1] > data[i] * 1.4;
        if (archiveFill) archivePixels += 1;
        if (data[i] === darkRgb[0] && data[i + 1] === darkRgb[1] && data[i + 2] === darkRgb[2]) darkPixels += 1;
        hash = (hash * 31 + data[i] + data[i + 1] * 3 + data[i + 2] * 7) % 4294967296;
      }
      return { archivePixels, darkPixels, hash, width, height };
    },
    [DARK_BG],
  );
}

async function shot(page, name) {
  if (!output) return;
  await page.screenshot({ path: path.join(output, name), fullPage: false });
}

/** 青绿色节点像素的外接矩形与数量：侧边栏收起只应平移画面，矩形尺寸与像素数必须基本不变。 */
async function paintBounds(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="kg-canvas"]');
    if (!canvas) return null;
    const { width, height } = canvas;
    const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let count = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const archiveFill = data[i] < 80 && data[i + 1] > 120 && data[i + 2] > 90 && data[i + 1] > data[i] * 1.4;
        if (!archiveFill) continue;
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return count ? { width: maxX - minX, height: maxY - minY, count } : { width: 0, height: 0, count: 0 };
  });
}

test('知识图谱页面 UI：三栏布局、真实节点、分类筛选、搜索定位、缩放拖动展开、主题与移动端', { skip: !chromium, timeout: 240000 }, async (t) => {
  const { bootstrap } = await import('../../api/dist/main.js');
  const { DATABASE } = await import('../../api/dist/db/database.js');
  const { ContentIndexService } = await import('../../api/dist/archives/content/content-index.service.js');
  const { GraphModule } = await import('../../api/dist/graph/graph.module.js');
  const { GraphBuildService } = await import('../../api/dist/graph/graph.service.js');

  const temp = mkdtempSync(path.join(tmpdir(), 'jit-kg-ui-'));
  const server = await bootstrap({
    port: 0,
    dbFile: path.join(temp, 'test.db'),
    fileStoreDir: path.join(temp, 'files'),
    serveWeb: true,
    knowledgeWorker: false,
    aiModelClient: { available: false, model: 'stub', async chatCompletion() { throw new Error('图谱 UI 用例不得触达模型'); } },
  });
  const app = server.app;
  const db = app.get(DATABASE);
  const base = server.baseUrl;
  let cookie = '';
  const ids = {};

  const call = async (url, body, at) => {
    const res = await fetch(`${base}/api${url}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: at ?? cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const session = res.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[1];
    if (session) cookie = `jit_sid=${session}`;
    const text = await res.text();
    // cookie 随响应一并返回：用例后续用它创建独立的浏览器会话（管理员/访客各一份）
    return { status: res.status, data: text ? JSON.parse(text) : null, cookie };
  };

  const docx = (paragraphs) => {
    const zip = new PizZip();
    zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
    return zip.generate({ type: 'nodebuffer' });
  };
  const upload = async (archiveId, name, bytes) => {
    const res = await fetch(`${base}/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(bytes),
    });
    const data = await res.json();
    assert.equal(res.status, 201, JSON.stringify(data));
    app.get(ContentIndexService).indexFileById(data.id);
    return data;
  };

  t.after(async () => {
    // 实际清理放在 browser 关闭之后（见下方注册的 after）：先释放页面与服务，再删临时目录
  });

  // ==================== 真实数据准备 ====================

  assert.equal((await call('/auth/init-admin', { username: 'kgui_root', password: 'Admin#12345', displayName: '图谱界面管理员' })).status, 201);
  const adminCookie = cookie;
  const borUser = await call('/users', { username: 'kgui_bor', password: 'User#12345', displayName: '借阅者甲', role: 'borrower' });
  assert.equal(borUser.status, 201);
  cookie = (await call('/auth/login', { username: 'kgui_bor', password: 'User#12345' }, '')).cookie;
  const guestUser = await call('/users', { username: 'kgui_gst', password: 'User#12345', displayName: '访客甲', role: 'guest' }, adminCookie);
  assert.equal(guestUser.status, 201);
  cookie = (await call('/auth/login', { username: 'kgui_gst', password: 'User#12345' }, '')).cookie;
  const guestCookie = cookie;

  cookie = adminCookie;
  ids.parent = (await call('/categories', { name: '合同类目', code: 'HT' })).data.id;
  ids.child = (await call('/categories', { name: '采购合同', code: 'HTCG', parentId: ids.parent })).data.id;
  ids.other = (await call('/categories', { name: '行政类目', code: 'XZ' })).data.id;
  const archiveA = await call('/archives', { title: '设备采购合同甲', categoryId: ids.child, archiveType: '文书档案' });
  ids.a = archiveA.data.id;
  ids.aNo = archiveA.data.archiveNo;
  ids.b = (await call('/archives', { title: '设备采购合同乙', categoryId: ids.child, archiveType: '文书档案' })).data.id;
  ids.c = (await call('/archives', { title: '车辆使用登记丙', categoryId: ids.other })).data.id;
  const restricted = await call('/archives', { title: `${SECRET_TOKEN}名册（受限）`, categoryId: ids.other, accessLevel: 'restricted' });
  ids.restricted = restricted.data.id;
  ids.fileA = (await upload(ids.a, '主合同.docx', docx([CONTRACT_A]))).id;
  await upload(ids.b, '合同副本.docx', docx([CONTRACT_B]));
  await upload(ids.c, '登记表.docx', docx(['车辆使用登记：本月出车十二次，油耗与里程见附表。']));
  await upload(ids.restricted, '名册.docx', docx([RESTRICTED_TEXT]));
  // 说明：用于验证「右栏长列表滚动」的 10 个附件与相似副本档案，放到最后一个用例里再创建，
  // 避免额外节点改变全景力导向布局，影响前面「点击画布中心节点」等既有断言的可重复性。

  const stats = app.select(GraphModule).get(GraphBuildService).buildAll({ options: { minChunkCharsForSimilarity: 10 }, syncContent: true });
  assert.ok(stats.nodes > 0 && stats.edges > 0, '图谱必须真实构建，页面才有可验证的数据');

  const adminVisible = Number(db.prepare('SELECT COUNT(1) AS c FROM archives').get().c);
  const guestVisible = Number(db.prepare("SELECT COUNT(1) AS c FROM archives WHERE access_level = 'public'").get().c);
  assert.ok(adminVisible >= 3 && guestVisible >= 3, '夹具应至少产出 3 份公开档案');

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: ['--disable-gpu', '--no-sandbox'],
  });
  // after 钩子按注册顺序执行：先关浏览器，再关服务，最后清临时目录（Windows 文件句柄释放有延迟）
  t.after(async () => {
    await browser.close();
    await app.close();
    // Windows 上 SQLite WAL / 上传文件句柄释放有延迟：先等一会儿再重试删除；
    // 临时目录清理失败不影响已完成的断言，只在输出里留下路径便于人工清理。
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      console.warn(`临时目录未能自动清理：${temp}`);
    }
  });
  const context = await contextWithCookie(browser, adminCookie, { width: 1440, height: 1000 }, base);
  // 只替换外部渲染引擎，页面拿到的节点/统计/权限判定全部来自真实接口。
  await context.route('https://jitword.com/preview_sdk/**', (route) => route.fulfill({
    contentType: 'text/javascript',
    body: 'window.JitWordFilePreview={createFilePreview(){return {async open(){},destroy(){},close(){},preload(){},on(){return ()=>{}},off(){}}},setMessages(){}};',
  }));
  const page = await context.newPage();
  const failures = [];
  /** 页面实际调用过哪些图谱接口与响应码（用于「无模拟数据」与接口可达断言）。 */
  const kgEndpoints = new Set();
  const kgStatuses = [];
  page.on('request', (req) => {
    const matched = /\/api\/knowledge-graph\/(overview|graph|search|nodes)/u.exec(req.url());
    if (matched) kgEndpoints.add(matched[1]);
  });
  page.on('response', (res) => { if (res.url().includes('/api/knowledge-graph/')) kgStatuses.push(res.status()); });
  page.on('pageerror', (err) => failures.push(String(err.message)));
  page.on('console', (msg) => { if (msg.type() === 'error') failures.push(`console:${msg.text()}`); });

  const nodeCountText = async () => Number((await page.locator('.kg-stage__meta').first().innerText()).match(/节点\s*(\d+)/u)?.[1] ?? -1);

  // ==================== 1. 页面加载与三栏布局 ====================

  await t.test('页面加载：导航入口、三栏布局与画布真实绘制', async () => {
    await page.goto(`${base}/knowledge-graph`);
    await page.locator('[data-testid="kg-canvas"]').waitFor({ state: 'visible' });

    assert.ok(await page.getByRole('link', { name: '档案知识图谱' }).first().isVisible(), '左侧导航应存在图谱入口');
    const left = await page.locator('[data-testid="kg-left-col"]').boundingBox();
    const stage = await page.locator('[data-testid="kg-stage"]').boundingBox();
    const right = await page.locator('[data-testid="kg-right-col"]').boundingBox();
    assert.ok(left && stage && right, '左中右三栏都必须渲染');
    assert.ok(left.x < stage.x && stage.x < right.x, '三栏顺序必须是 概览-画布-详情');
    assert.ok(left.width > 150 && right.width > 200 && stage.width > 300, '三栏宽度都应可用');
    assert.ok(Math.abs(left.height - right.height) < 4, '两侧栏应与画布等高');

    // 统计卡片 = 数值 + 文案标签，取数值子节点，避免把「档案」二字一起转成 NaN
    const archivesOnPage = Number(await page.locator('[data-testid="kg-stat-archives"] .kg-stat__value').innerText());
    assert.equal(archivesOnPage, adminVisible, '左栏档案数必须等于库中真实可见档案数');
    assert.ok(Number(await page.locator('[data-testid="kg-stat-chunks"] .kg-stat__value').innerText()) > 0, '知识块统计应来自真实正文');

    const paint = await paintStats(page);
    assert.ok(paint.archivePixels > 200, `画布应绘制出真实的档案节点像素（实际 ${paint.archivePixels}）`);
    assert.ok((await nodeCountText()) > 0, '首层应加载到真实节点而不是空画布');
    await shot(page, 'kg-1-desktop-light.png');
  });

  // ==================== 2. 分类切换筛选 ====================

  await t.test('点击左栏分类：图谱只保留该分类子树', async () => {
    const responsePromise = page.waitForResponse((res) => res.url().includes('/api/knowledge-graph/graph') && res.status() === 200);
    await page.locator(`[data-testid="kg-cat-${ids.child}"]`).click();
    const payload = await (await responsePromise).json();
    await page.waitForTimeout(150);

    const archiveIds = new Set(payload.nodes.filter((n) => n.type === 'archive').map((n) => n.refId));
    assert.ok(archiveIds.has(ids.a) && archiveIds.has(ids.b), '该分类（含父分类）下的档案应出现');
    assert.equal(archiveIds.has(ids.c), false, '其他分类的档案不得出现在分类视图');
    assert.ok(payload.edges.every((e) => payload.nodes.some((n) => n.key === e.from) && payload.nodes.some((n) => n.key === e.to)), '返回关系两端都必须在节点集合内');
    assert.ok((await page.locator('.kg-stage__tag').innerText()).includes('采购合同'), '中栏应标明当前分类视图');

    await shot(page, 'kg-2-category-view.png');
    await page.locator('[data-testid="kg-cat-all"]').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('.kg-stage__tag').count(), 0, '切回全景后分类标记应消失');
    assert.ok((await nodeCountText()) >= archiveIds.size + 1, '切回全景应重新拿到全景节点，不残留筛选');
  });

  // ==================== 3. 搜索定位 + 高亮 + 右栏详情 ====================

  await t.test('全局搜索真实命中并可定位到节点详情', async () => {
    await page.locator('[data-testid="kg-search-input"]').fill('设备采购合同甲');
    await page.locator('[data-testid="kg-search-panel"]').waitFor({ state: 'visible' });
    const hits = await page.locator('[data-testid="kg-search-hit-archive"]').allInnerTexts();
    assert.ok(hits.length > 0, '搜索应返回真实档案命中');
    assert.ok(hits.join('|').includes('设备采购合同甲'), '命中项标题必须是库中真实标题');
    assert.equal(hits.join('|').includes(SECRET_TOKEN), false, '受限档案不得出现在搜索结果');

    await page.locator('[data-testid="kg-search-hit-archive"]').first().click();
    await page.locator('[data-testid="kg-detail-archive"]').waitFor({ state: 'visible' });

    const detailText = await page.locator('[data-testid="kg-detail-archive"]').innerText();
    assert.ok(detailText.includes(ids.aNo), `右栏应显示该档案的真实档号 ${ids.aNo}`);
    assert.ok(detailText.includes('设备采购合同甲'), '右栏标题应与库中一致');
    const highlighted = await paintStats(page);
    assert.ok(highlighted.archivePixels > 0, '选中节点后画布仍有真实绘制');
    assert.ok(await page.locator('[data-testid="kg-locate"]').isEnabled(), '已选中节点应可定位');
    await shot(page, 'kg-3-search-located.png');

    const emptyPromise = page.waitForResponse((res) => res.url().includes('/api/knowledge-graph/search'));
    await page.locator('[data-testid="kg-search-input"]').fill('这份档案一定不存在zzz');
    await (await emptyPromise).json();
    await page.locator('[data-testid="kg-search-panel"]').waitFor({ state: 'visible' });
    assert.ok((await page.locator('[data-testid="kg-search-panel"]').innerText()).includes('没有找到'), '无结果应展示友好空状态');
    await shot(page, 'kg-3b-search-empty.png');
    await page.locator('[data-testid="kg-search-input"]').fill('');
    await page.keyboard.press('Escape');
  });

  // ==================== 4. 节点交互：选中 / 展开 / 缩放 / 拖动 / 重置 ====================

  await t.test('单击选中、双击展开、滚轮缩放与画布拖动都作用于真实节点', async () => {
    await page.locator('[data-testid="kg-search-input"]').fill('车辆使用登记');
    await page.locator('[data-testid="kg-search-hit-archive"]').first().click();
    await page.locator('[data-testid="kg-detail-archive"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(300); // 等聚焦动画与布局收敛

    const box = await page.locator('[data-testid="kg-canvas"]').boundingBox();
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    const beforeNodes = await nodeCountText();
    await page.mouse.click(center.x, center.y);
    await page.locator('[data-testid="kg-detail-archive"]').waitFor({ state: 'visible' });
    assert.ok((await page.locator('[data-testid="kg-detail-archive"]').innerText()).includes('车辆使用登记丙'), '单击画布节点应选中被定位的真实档案');

    const relationsPromise = page.waitForResponse((res) => res.url().includes('/relations')).catch(() => null);
    await page.locator('[data-testid="kg-load-relations"]').click();
    await relationsPromise;
    const relationText = await page.locator('[data-testid="kg-relations"]').innerText();
    assert.ok(/分类归属|包含附件|关联档案/u.test(relationText), `展开全部应返回真实关系类型（实际：${relationText.slice(0, 80)}）`);
    assert.ok(/(关联原因|计算依据|相似度|业务结构)/u.test(relationText), '关系应附真实依据说明，而不是只有一条线');

    const expandPromise = page.waitForResponse((res) => res.url().includes('/api/knowledge-graph/graph')).catch(() => null);
    await page.mouse.dblclick(center.x, center.y);
    await expandPromise;
    await page.waitForTimeout(350);
    const afterNodes = await nodeCountText();
    assert.ok(afterNodes > beforeNodes, `双击应展开下一层真实节点（${beforeNodes} → ${afterNodes}）`);
    const filePayload = await page.locator('[data-testid="kg-detail-archive"]').innerText();
    assert.ok(filePayload.includes('登记表'), '展开的附件应能在右栏档案详情中得到印证');

    const beforeZoom = await paintStats(page);
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -420);
    await page.waitForTimeout(250);
    const afterZoom = await paintStats(page);
    assert.notEqual(afterZoom.hash, beforeZoom.hash, '滚轮缩放应重绘画布');
    assert.ok(afterZoom.archivePixels > beforeZoom.archivePixels, '放大后档案节点屏幕面积应增大');

    await page.mouse.move(box.x + box.width - 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 150, box.y + 90, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const afterPan = await paintStats(page);
    assert.notEqual(afterPan.hash, afterZoom.hash, '拖动应平移画布');

    await page.locator('[data-testid="kg-reset"]').click();
    await page.waitForTimeout(250);
    const afterReset = await paintStats(page);
    assert.notEqual(afterReset.hash, afterPan.hash, '重置视图应重新适配全部节点');
    assert.ok(afterReset.archivePixels > 100, '重置后节点仍在画布上（数据未丢）');
    await shot(page, 'kg-4-interaction.png');
  });

  // ==================== 4b. 左右侧边栏独立收起 / 展开 ====================

  await t.test('左右侧边栏可独立收起/展开：画布随剩余空间扩宽且不重排节点', async () => {
    await page.reload();
    await page.locator('[data-testid="kg-canvas"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    const box = async (selector) => page.locator(selector).boundingBox();
    const start = {
      left: await box('[data-testid="kg-left-col"]'),
      stage: await box('[data-testid="kg-stage"]'),
      right: await box('[data-testid="kg-right-col"]'),
      canvas: await box('[data-testid="kg-canvas"]'),
    };
    const startPaint = await paintBounds(page);
    assert.ok(startPaint.count > 200, '初始画布应绘制出真实档案节点');

    // 1) 只收左侧：右栏不动，画布扩宽
    await page.locator('[data-testid="kg-overview-collapse"]').click();
    await page.waitForTimeout(450);
    const leftClosed = {
      left: await box('[data-testid="kg-left-col"]'),
      stage: await box('[data-testid="kg-stage"]'),
      right: await box('[data-testid="kg-right-col"]'),
      canvas: await box('[data-testid="kg-canvas"]'),
    };
    assert.equal(await page.locator('[data-testid="kg-left-col"]').getAttribute('data-collapsed'), 'true');
    assert.ok(leftClosed.left.width <= 50, `收起后左栏只保留窄入口（实际 ${leftClosed.left.width}）`);
    assert.ok(Math.abs(leftClosed.right.width - start.right.width) < 1, '收左侧不得改变右栏宽度');
    assert.ok(leftClosed.stage.width > start.stage.width + 150, '画布必须随左栏收起而扩宽');
    assert.ok(leftClosed.canvas.width > start.canvas.width + 150, 'Canvas 元素本身也要跟着变宽');
    assert.equal(await page.locator('[data-testid="kg-stats"]').isVisible(), false, '收起后统计卡片必须隐藏');
    assert.ok(await page.locator('[data-testid="kg-expand-overview"]').isVisible(), '收起后必须保留展开入口');

    const leftClosedPaint = await paintBounds(page);
    assert.ok(Math.abs(leftClosedPaint.width - startPaint.width) <= 2, `收起侧栏只平移画面，节点不得重新布局（外接宽 ${startPaint.width}→${leftClosedPaint.width}）`);
    assert.ok(Math.abs(leftClosedPaint.height - startPaint.height) <= 2, '节点纵向位置与缩放必须保持不变');
    assert.ok(
      Math.abs(leftClosedPaint.count - startPaint.count) <= Math.max(20, startPaint.count * 0.05),
      `节点像素量应基本一致（${startPaint.count}→${leftClosedPaint.count}），说明没有重新初始化节点`,
    );
    await shot(page, 'kg-4b-left-collapsed.png');

    // 2) 重新展开左侧：恢复原宽度
    await page.locator('[data-testid="kg-expand-overview"]').click();
    await page.waitForTimeout(450);
    assert.ok(Math.abs((await box('[data-testid="kg-left-col"]')).width - start.left.width) < 1, '重新展开后左栏宽度必须恢复原值');
    assert.ok(await page.locator('[data-testid="kg-stats"]').isVisible(), '重新展开后统计卡片必须回来');

    // 3) 只收右侧：左栏不动，画布扩宽
    await page.locator('[data-testid="kg-detail-collapse"]').click();
    await page.waitForTimeout(450);
    const rightClosed = {
      left: await box('[data-testid="kg-left-col"]'),
      stage: await box('[data-testid="kg-stage"]'),
      right: await box('[data-testid="kg-right-col"]'),
    };
    assert.equal(await page.locator('[data-testid="kg-right-col"]').getAttribute('data-collapsed'), 'true');
    assert.ok(rightClosed.right.width <= 50, `收起后右栏只保留窄入口（实际 ${rightClosed.right.width}）`);
    assert.ok(Math.abs(rightClosed.left.width - start.left.width) < 1, '收右侧不得改变左栏宽度');
    assert.ok(rightClosed.stage.width > start.stage.width + 150, '画布必须随右栏收起而扩宽');
    assert.equal(await page.locator('[data-testid="kg-detail"]').isVisible(), false, '收起后节点详情必须隐藏');
    assert.ok(await page.locator('[data-testid="kg-expand-detail"]').isVisible(), '收起后必须保留展开入口');

    // 4) 两侧同时收起：画布占据几乎整个可用宽度
    await page.locator('[data-testid="kg-overview-collapse"]').click();
    await page.waitForTimeout(450);
    const bothClosed = {
      left: await box('[data-testid="kg-left-col"]'),
      right: await box('[data-testid="kg-right-col"]'),
      stage: await box('[data-testid="kg-stage"]'),
    };
    assert.ok(bothClosed.left.width <= 50 && bothClosed.right.width <= 50, '两侧必须能同时收起');
    const expectedGain = start.left.width + start.right.width - 100;
    assert.ok(bothClosed.stage.width >= start.stage.width + expectedGain, `两侧收起后画布应占据几乎整个宽度（${start.stage.width}→${bothClosed.stage.width}）`);

    // 5) 两侧同时展开：尺寸完全回到初始值
    await page.locator('[data-testid="kg-expand-overview"]').click();
    await page.locator('[data-testid="kg-expand-detail"]').click();
    await page.waitForTimeout(450);
    assert.ok(Math.abs((await box('[data-testid="kg-left-col"]')).width - start.left.width) < 1);
    assert.ok(Math.abs((await box('[data-testid="kg-right-col"]')).width - start.right.width) < 1);
    assert.ok(Math.abs((await box('[data-testid="kg-stage"]')).width - start.stage.width) < 1);
    await shot(page, 'kg-4c-panels-expanded.png');

    // 6) 连续收起/展开 3 轮：不出现布局累积误差，节点仍在画布上
    for (let round = 0; round < 3; round += 1) {
      await page.locator('[data-testid="kg-overview-collapse"]').click();
      await page.locator('[data-testid="kg-detail-collapse"]').click();
      await page.waitForTimeout(320);
      await page.locator('[data-testid="kg-expand-overview"]').click();
      await page.locator('[data-testid="kg-expand-detail"]').click();
      await page.waitForTimeout(320);
    }
    const settled = await box('[data-testid="kg-stage"]');
    assert.ok(Math.abs(settled.width - start.stage.width) < 1, '连续切换后画布宽度必须回到初始值');
    assert.ok((await paintBounds(page)).count > 200, '连续切换后节点仍完整绘制');
  });

  // ==================== 4c. 右侧详情滚动 ====================

  await t.test('右侧详情可一直滚动到最后一条关联档案，卡片内容完整不截断', async () => {
    // 本用例需要真实的「长详情 + 多条关联」：主档案再挂 10 个附件，并建一份正文完全相同的副本档案。
    // 数据只在这里创建，不影响前面用例的画布布局与统计断言。
    for (let i = 1; i <= 10; i += 1) {
      await upload(ids.a, `履约材料${i}.docx`, docx([`第${i}期会议纪要：关于办公用房租金的讨论，参会人员与后续安排详见附表。`]));
    }
    ids.dupA = (await call('/archives', { title: '设备采购合同归档副本', categoryId: ids.child, archiveType: '文书档案' })).data.id;
    await upload(ids.dupA, '主合同副本.docx', docx([CONTRACT_A]));
    const rebuilt = app.select(GraphModule).get(GraphBuildService).buildAll({ options: { minChunkCharsForSimilarity: 10 }, syncContent: true });
    assert.ok(rebuilt.edges > 0, '新增真实数据后图谱必须重建出关系');

    await page.reload();
    await page.locator('[data-testid="kg-canvas"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    await page.locator('[data-testid="kg-search-input"]').fill('设备采购合同甲');
    // 按档号锁定主档案（同名相似副本也包含关键词，不能依赖命中顺序）
    await page.locator('[data-testid="kg-search-hit-archive"]', { hasText: ids.aNo }).first().click();
    await page.locator('[data-testid="kg-detail-archive"]').waitFor({ state: 'visible' });
    assert.ok((await page.locator('[data-testid="kg-detail-archive"]').innerText()).includes(ids.aNo), '必须先选中主档案详情');

    const relationsPromise = page.waitForResponse((res) => res.url().includes('/relations') && res.status() === 200);
    await page.locator('[data-testid="kg-load-relations"]').click();
    await relationsPromise;
    await page.waitForTimeout(300);

    const body = page.locator('[data-testid="kg-detail-body"]');
    // 点「展开全部」时浏览器会把按钮滚动到可视区，因此可滚动性以「能回顶 + 能到底」为准
    await body.evaluate((el) => { el.scrollTop = 0; });
    const before = await body.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
      overscroll: getComputedStyle(el).overscrollBehaviorY,
    }));
    assert.ok(before.scrollHeight > before.clientHeight + 200, `详情内容必须真的超出可视高度（${before.scrollHeight}/${before.clientHeight}）`);
    assert.equal(before.scrollTop, 0, '详情内容区必须能回到顶部');
    assert.equal(before.overflowY, 'auto', '详情内容区必须是纵向滚动容器');
    assert.equal(before.overscroll, 'contain', '滚动不得链式传给页面');

    const cards = await page.evaluate(() => {
      const relations = [...document.querySelectorAll('.kg-rel')];
      const truncated = [...document.querySelectorAll('.kg-rel__node')].filter((el) => {
        const style = getComputedStyle(el);
        return style.whiteSpace === 'nowrap' || style.textOverflow === 'ellipsis';
      }).length;
      return {
        total: relations.length,
        clipped: relations.filter((el) => el.scrollHeight > el.clientHeight + 1).length,
        truncated,
      };
    });
    assert.ok(cards.total >= 2, `关联档案至少应包含与乙、与副本的两条真实关系（实际 ${cards.total}）`);
    assert.equal(cards.clipped, 0, '关联卡片不得裁切内容');
    assert.equal(cards.truncated, 0, '关联档案标题不得单行省略号截断');

    const relationsText = await page.locator('[data-testid="kg-relations"]').innerText();
    for (const token of ['关联原因', '依据']) assert.ok(relationsText.includes(token), `关联卡片必须展示「${token}」`);

    const box = await body.boundingBox();
    // 鼠标滚轮 / 触控板：连续下滚直到到底
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 16; i += 1) {
      await page.mouse.wheel(0, 480);
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(200);
    const after = await body.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop }));
    assert.ok(after.scrollTop > 0, '滚轮必须能滚动右侧详情');
    assert.ok(after.scrollTop + after.clientHeight >= after.scrollHeight - 2, `必须能滚到底部（${after.scrollTop}+${after.clientHeight} vs ${after.scrollHeight}）`);
    assert.equal(await page.evaluate(() => window.scrollY), 0, '滚轮不得穿透到页面整体滚动');

    // 最后一条关联档案必须完整出现在可视区域内
    const last = page.locator('[data-testid^="kg-rel-"]').last();
    const lastBox = await last.boundingBox();
    assert.ok(lastBox, '最后一条关联档案必须存在');
    assert.ok(lastBox.y >= box.y - 1, `最后一条关联档案顶部必须可见（${lastBox.y} vs ${box.y}）`);
    assert.ok(lastBox.y + lastBox.height <= box.y + box.height + 1, `最后一条关联档案必须完整可见（${lastBox.y + lastBox.height} vs ${box.y + box.height}）`);
    await shot(page, 'kg-4d-detail-scrolled.png');

    // 回到顶部：向上滚动同样有效
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 16; i += 1) {
      await page.mouse.wheel(0, -480);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(150);
    assert.equal(await body.evaluate((el) => el.scrollTop), 0, '向上滚动必须能回到顶部');

    // 移动端视口：抽屉内的详情仍使用同一个唯一滚动容器，触摸滚动可用且不带动整页
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    await page.locator('[data-testid="kg-toggle-detail"]').click();
    await page.waitForTimeout(350);
    const mobile = await body.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      overscroll: getComputedStyle(el).overscrollBehaviorY,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    assert.equal(mobile.overflowY, 'auto', '移动端详情仍必须是纵向滚动容器');
    assert.equal(mobile.overscroll, 'contain', '移动端滚动也不得链式带动页面');
    assert.ok(mobile.scrollHeight > mobile.clientHeight + 200, `移动端详情内容同样超出视口（${mobile.scrollHeight}/${mobile.clientHeight}）`);
    const mobileBox = await body.boundingBox();
    await page.mouse.move(mobileBox.x + mobileBox.width / 2, mobileBox.y + mobileBox.height / 2);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(200);
    assert.ok((await body.evaluate((el) => el.scrollTop)) > 0, '移动端详情应可上下滚动');
    assert.equal(await page.evaluate(() => window.scrollY), 0, '移动端滚动不得穿透到整页');
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      '移动端不得出现横向溢出',
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(250);
  });

  // ==================== 5. 明暗主题 ====================

  await t.test('明暗主题切换沿用页面机制且不丢图谱数据', async () => {
    const before = await paintStats(page);
    const nodesBefore = await nodeCountText();

    await page.locator('[data-testid="kg-theme"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-testid="kg-view"]').getAttribute('data-theme'), 'dark', '应切到暗色');
    const dark = await paintStats(page);
    assert.ok(dark.darkPixels > dark.width * dark.height * 0.2, '暗色主题应真实改变画布底色');
    assert.equal(await nodeCountText(), nodesBefore, '切主题不得丢节点');
    assert.ok(dark.archivePixels > 100, '切换主题后仍应绘制真实档案节点；渐变像素数量不依赖悬停透明度完全一致');
    await shot(page, 'kg-5-dark-theme.png');

    await page.reload();
    await page.locator('[data-testid="kg-canvas"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid="kg-view"]').getAttribute('data-theme'), 'dark', '主题应持久化');
    assert.ok((await nodeCountText()) > 0, '刷新后仍应拿到真实数据');

    await page.locator('[data-testid="kg-theme"]').click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-testid="kg-view"]').getAttribute('data-theme'), 'light');
  });

  // ==================== 6. 移动端布局 ====================

  await t.test('移动端：两侧收为抽屉，画布保持可操作', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.ok(await page.locator('[data-testid="kg-toggle-overview"]').isVisible(), '移动端应出现概览抽屉开关');

    const left = await page.locator('[data-testid="kg-left-col"]').boundingBox();
    const stage = await page.locator('[data-testid="kg-stage"]').boundingBox();
    assert.ok(left.x < 0 || left.x + left.width <= 1, `左栏默认应收起（x=${left?.x}）`);
    assert.ok(stage.width >= 380, `画布应占满移动端宽度（实际 ${stage?.width}）`);

    await page.locator('[data-testid="kg-toggle-overview"]').click();
    await page.waitForTimeout(300); // 等抽屉位移动画完成
    const opened = await page.locator('[data-testid="kg-left-col"]').boundingBox();
    assert.ok(opened.x >= 0, '点击后概览抽屉应滑出');
    await shot(page, 'kg-6-mobile-drawer.png');

    const box = await page.locator('[data-testid="kg-canvas"]').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
    await page.locator('[data-testid="kg-mask"]').click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-testid="kg-mask"]').count(), 0, '点击遮罩应关闭抽屉');

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-testid="kg-toggle-overview"]').isVisible(), false, '桌面端不需抽屉开关');
    assert.ok((await page.locator('[data-testid="kg-right-col"]').boundingBox()).width > 200, '桌面端右栏应恢复常驻');
  });

  // ==================== 7. 权限在页面上的表现 ====================

  await t.test('访客页面：统计按其可见范围重算，受限档案零出现', async () => {
    const guestContext = await contextWithCookie(browser, guestCookie, { width: 1440, height: 1000 }, base);
    const guestPage = await guestContext.newPage();
    await guestPage.goto(`${base}/knowledge-graph`);
    await guestPage.locator('[data-testid="kg-canvas"]').waitFor({ state: 'visible' });

    const guestVisibleNow = Number(db.prepare("SELECT COUNT(1) AS c FROM archives WHERE access_level = 'public'").get().c);
    assert.equal(Number(await guestPage.locator('[data-testid="kg-stat-archives"] .kg-stat__value').innerText()), guestVisibleNow, '访客档案数应等于其可见真实档案数');
    const bodyText = await guestPage.locator('body').innerText();
    for (const token of [SECRET_TOKEN, '名册（受限）']) {
      assert.equal(bodyText.includes(token), false, `访客页面不得出现受限档案信息 ${token}`);
    }
    await guestPage.locator('[data-testid="kg-search-input"]').fill(SECRET_TOKEN);
    await guestPage.locator('[data-testid="kg-search-panel"]').waitFor({ state: 'visible' });
    assert.ok((await guestPage.locator('[data-testid="kg-search-panel"]').innerText()).includes('没有找到'), '访客搜索受限档案应得空结果');
    await shot(guestPage, 'kg-7-guest-view.png');
    await guestContext.close();
  });

  // ==================== 8. 无脚本错误 + 无模拟数据声明 ====================

  await t.test('全过程无脚本错误，且页面只使用数据库真实节点', async () => {
    assert.deepEqual(failures, [], `页面不应产生脚本或控制台错误：${failures.join(' / ')}`);
    for (const endpoint of ['overview', 'graph', 'search', 'nodes']) {
      assert.ok(kgEndpoints.has(endpoint), `页面应真实调用 /api/knowledge-graph/${endpoint}`);
    }
    assert.ok(kgStatuses.length >= 5, `图谱接口请求应多次真实发生（实际 ${kgStatuses.length} 次）`);
    assert.ok(kgStatuses.every((status) => status === 200), `图谱接口应全部 200（实际 ${kgStatuses.join(',')}）`);

    // 「无模拟数据」的直接证据：接口返回的每个节点键都能在 kg_graph_nodes 里找到
    const fresh = await call('/knowledge-graph/graph?view=panorama&pageSize=300', undefined, adminCookie);
    assert.equal(fresh.status, 200);
    const dbKeys = new Set(db.prepare('SELECT biz_key FROM kg_graph_nodes').all().map((row) => String(row.biz_key)));
    assert.ok(fresh.data.nodes.length > 0, '全景层必须有真实节点');
    for (const node of fresh.data.nodes) {
      assert.ok(dbKeys.has(node.key), `接口节点 ${node.key} 必须存在于 kg_graph_nodes，不得为模拟节点`);
    }
    for (const edge of fresh.data.edges) {
      assert.ok(dbKeys.has(edge.from) && dbKeys.has(edge.to), `关系 ${edge.id} 两端都必须是库内节点`);
    }
  });
});

/** 用已登录会话创建浏览上下文（Cookie 名与后端 SESSION_COOKIE 一致）。 */
async function contextWithCookie(browser, sessionCookie, viewport, baseUrl) {
  const context = await browser.newContext({ viewport });
  const value = sessionCookie.replace(/^jit_sid=/u, '');
  // Playwright 1.6x 起 url 与 path 不能同时给出，否则会抛 "Cookie should have either url or path"
  await context.addCookies([{ name: 'jit_sid', value, url: baseUrl }]);
  return context;
}
