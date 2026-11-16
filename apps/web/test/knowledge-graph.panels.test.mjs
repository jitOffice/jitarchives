/**
 * 档案知识图谱 · 左右侧边栏收起/展开 与 右侧详情滚动 的回归测试。
 *
 * 覆盖四件事：
 * 1. 左右面板状态彼此独立：收左侧不动右侧、收右侧不动左侧、两侧可同时收起/展开；
 * 2. 视口尺寸变化只做平移补偿：缩放比例与节点世界坐标不变（侧边栏收起不触发重排）；
 * 3. 画布组件用 ResizeObserver 监听容器尺寸，onResize 里不出现任何布局调用；
 * 4. 右侧详情只有一层滚动容器（标题固定 + 内容 overflow-y:auto + min-height:0），
 *    关联档案标题完整换行，不使用固定高度裁切内容。
 *
 * 纯函数部分直接跑真实实现；DOM/CSS 部分检查真实组件源码的关键结构（防止回退）。
 * 运行：node --experimental-transform-types --test test/knowledge-graph.panels.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  collapsePanelSide,
  ensurePanelExpanded,
  expandPanelSide,
  initialPanelState,
  isPanelCollapsed,
  togglePanelSide,
} from '../src/lib/knowledge-graph/panels.ts';
import { recenterTransform, toWorld } from '../src/lib/knowledge-graph/forceLayout.ts';

const viewSource = readFileSync(new URL('../src/views/KnowledgeGraphView.vue', import.meta.url), 'utf8');
const canvasSource = readFileSync(new URL('../src/components/knowledge-graph/GraphCanvas.vue', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('../src/components/knowledge-graph/GraphDetailPanel.vue', import.meta.url), 'utf8');
const overviewSource = readFileSync(new URL('../src/components/knowledge-graph/GraphOverviewPanel.vue', import.meta.url), 'utf8');

/** 取出某个 CSS 选择器的规则体（第一个匹配）。 */
function cssRule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'u').exec(source);
  assert.ok(matched, `必须存在 ${selector} 规则`);
  return matched[1];
}

/** 取出某个函数的函数体（用于确认里面没有布局调用）。 */
function functionBody(source, signature) {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = new RegExp(`${escaped}[^{]*\\{([\\s\\S]*?)\\n\\}`, 'u').exec(source);
  assert.ok(matched, `必须存在函数 ${signature}`);
  return matched[1];
}

// ==================== 1. 左右面板独立控制 ====================

test('初始状态两侧都展开；收左侧不影响右侧，收右侧不影响左侧', () => {
  const initial = initialPanelState();
  assert.deepEqual(initial, { left: false, right: false });
  assert.equal(isPanelCollapsed(initial, 'overview'), false);
  assert.equal(isPanelCollapsed(initial, 'detail'), false);

  const leftClosed = collapsePanelSide(initial, 'overview');
  assert.equal(leftClosed.left, true, '左栏应处于收起态');
  assert.equal(leftClosed.right, false, '收左侧不得影响右侧');

  const rightClosed = collapsePanelSide(initial, 'detail');
  assert.equal(rightClosed.right, true, '右栏应处于收起态');
  assert.equal(rightClosed.left, false, '收右侧不得影响左侧');

  // 原对象不可变：调用方不会因为历史引用被偷偷改写
  assert.deepEqual(initial, { left: false, right: false });
});

test('两侧可以同时收起、同时展开，且展开某一侧不会连带展开另一侧', () => {
  const bothClosed = collapsePanelSide(collapsePanelSide(initialPanelState(), 'overview'), 'detail');
  assert.deepEqual(bothClosed, { left: true, right: true }, '两侧必须能同时收起');

  const leftOnly = expandPanelSide(bothClosed, 'overview');
  assert.deepEqual(leftOnly, { left: false, right: true }, '只展开左侧时右侧必须保持收起');

  const rightOnly = expandPanelSide(bothClosed, 'detail');
  assert.deepEqual(rightOnly, { left: true, right: false }, '只展开右侧时左侧必须保持收起');

  const bothOpen = expandPanelSide(expandPanelSide(bothClosed, 'overview'), 'detail');
  assert.deepEqual(bothOpen, { left: false, right: false }, '两侧必须能同时展开');
});

test('切换与重复收起/展开幂等：连续操作不会产生第三种状态', () => {
  let state = initialPanelState();
  for (let i = 0; i < 20; i += 1) state = togglePanelSide(state, 'overview');
  assert.deepEqual(state, { left: false, right: false }, '切换偶数次应回到初始态');

  const closedTwice = collapsePanelSide(collapsePanelSide(initialPanelState(), 'detail'), 'detail');
  assert.deepEqual(closedTwice, { left: false, right: true }, '重复收起必须保持同一状态');

  const openedTwice = expandPanelSide(expandPanelSide(initialPanelState(), 'overview'), 'overview');
  assert.deepEqual(openedTwice, { left: false, right: false }, '重复展开必须保持同一状态');
});

test('移动端打开抽屉时同侧面板自动展开：抽屉里不会只剩下收起入口', () => {
  const collapsed = collapsePanelSide(initialPanelState(), 'detail');
  const opened = ensurePanelExpanded(collapsed, 'detail');
  assert.equal(opened.right, false, '抽屉打开时同侧面板必须展开');
  assert.equal(opened.left, false, '另一侧状态不得被改动');

  // 已经是展开态时返回原对象，不产生无意义的状态更新
  assert.equal(ensurePanelExpanded(opened, 'detail'), opened);
});

// ==================== 2. 视口尺寸变化只做平移补偿 ====================

test('画布扩宽/收窄时保持缩放比例，并把原视口中心挪到新视口中心', () => {
  const before = { scale: 1.25, tx: -180, ty: 40 };
  const previous = { width: 900, height: 700 };
  const next = { width: 1200, height: 700 };

  const after = recenterTransform(before, previous, next);
  assert.equal(after.scale, before.scale, '缩放比例必须完全保留（不得重新适配）');
  assert.equal(after.tx, before.tx + (next.width - previous.width) / 2, '横向只补偿宽度差的一半');
  assert.equal(after.ty, before.ty, '高度不变时不得纵向漂移');

  const oldCenter = toWorld(before, previous.width / 2, previous.height / 2);
  const newCenter = toWorld(after, next.width / 2, next.height / 2);
  assert.ok(Math.abs(oldCenter.x - newCenter.x) < 1e-9, '视口中心的世界坐标必须保持一致');
  assert.ok(Math.abs(oldCenter.y - newCenter.y) < 1e-9);
});

test('尺寸没变或首次测量（宽度为 0）时不做任何变换改动', () => {
  const transform = { scale: 0.8, tx: 12, ty: -30 };
  const size = { width: 800, height: 600 };

  assert.equal(recenterTransform(transform, size, { ...size }), transform, '尺寸未变化必须原样返回');
  assert.equal(recenterTransform(transform, { width: 0, height: 0 }, size), transform, '首次测量没有可补偿的中心');
  assert.equal(recenterTransform(transform, size, { width: 0, height: 0 }).scale, transform.scale, '极端尺寸下缩放不得变成 0/NaN');
});

test('侧边栏收起只改变视口，不触碰节点坐标缓存', () => {
  const positions = new Map([
    ['archive:1', { x: 120, y: -40, vx: 0, vy: 0, pinned: true }],
    ['archive:2', { x: -260, y: 90, vx: 0, vy: 0 }],
  ]);
  const snapshot = [...positions.entries()].map(([key, point]) => [key, { ...point }]);

  recenterTransform({ scale: 1, tx: 0, ty: 0 }, { width: 900, height: 700 }, { width: 1400, height: 700 });

  for (const [key, point] of snapshot) {
    assert.deepEqual(positions.get(key), point, `${key} 的坐标与 pinned 状态不得被尺寸变化改写`);
  }
});

// ==================== 3. 画布监听容器尺寸 ====================

test('画布用 ResizeObserver 监听容器尺寸，resize 时只平移+重绘，不重新布局', () => {
  assert.match(canvasSource, /new ResizeObserver\(/u, '必须监听 Canvas 容器尺寸变化');
  assert.match(canvasSource, /observer\.observe\(el\)/u, '必须把观察目标绑定到画布容器');

  const body = functionBody(canvasSource, 'function onResize()');
  assert.match(body, /recenterTransform\(/u, '尺寸变化必须走视口平移补偿');
  assert.match(body, /scheduleDraw\(\)/u, '尺寸变化必须重绘画布');
  for (const forbidden of ['fitView(', 'settleLayout(', 'stepLayout(', 'seedPositions(']) {
    assert.equal(body.includes(forbidden), false, `onResize 不得调用 ${forbidden}（会重新布局或重摆节点）`);
  }

  // 组件整体仍不允许自己跑力导向或持续动画
  assert.equal(canvasSource.includes('requestAnimationFrame'), false);
  assert.doesNotMatch(canvasSource, /watch\(\s*\(\) => props\.nodes[\s\S]{0,200}settleLayout/u, '节点变化不得触发布局');
});

// ==================== 4. 左右面板的 DOM / CSS 结构 ====================

test('页面提供两侧独立的收起按钮与窄入口，收起只改 width 不重建布局', () => {
  assert.match(overviewSource, /data-testid="kg-overview-collapse"/u, '左侧面板头部必须有收起按钮');
  assert.match(detailSource, /data-testid="kg-detail-collapse"/u, '右侧面板头部必须有收起按钮');
  assert.match(viewSource, /data-testid="kg-expand-overview"/u, '左侧收起后必须有展开入口');
  assert.match(viewSource, /data-testid="kg-expand-detail"/u, '右侧收起后必须有展开入口');

  // 收起状态由两个独立布尔位驱动，分别挂在左右栏上
  assert.match(viewSource, /:class="\{ 'is-collapsed': leftCollapsed, 'is-open': mobilePanel === 'overview' \}"/u);
  assert.match(viewSource, /:class="\{ 'is-collapsed': rightCollapsed, 'is-open': mobilePanel === 'detail' \}"/u);

  const body = cssRule(viewSource, '.kg-view__body');
  assert.match(body, /display:\s*flex/u, '三栏必须用 flex 布局，画布才能随剩余空间伸缩');
  assert.equal(/grid-template-columns/u.test(body), false, '不得再用固定 grid 列宽');

  const col = cssRule(viewSource, '.kg-view__col');
  assert.match(col, /transition:\s*width/u, '收起/展开必须有宽度过渡（平滑且不跳布局）');
  const collapsed = cssRule(viewSource, '.kg-view__col.is-collapsed');
  assert.match(collapsed, /width:\s*44px/u, '收起后必须保留窄入口宽度');

  // 移动端抽屉宽度与桌面端收起状态解耦，且不显示桌面窄入口
  assert.match(viewSource, /\.is-mobile \.kg-view__col,\s*\n\.is-mobile \.kg-view__col\.is-collapsed \{/u, '移动端抽屉宽度必须与收起态解耦');
  assert.match(viewSource, /\.is-mobile \.kg-view__col \.kg-col__rail \{\s*\n\s*display:\s*none;/u, '移动端不显示桌面窄入口');
});

test('左栏与右栏组件都把收起事件交给页面，面板本身保持无状态', () => {
  assert.match(overviewSource, /defineEmits<\{ collapse: \[\] \}>/u);
  assert.match(overviewSource, /data-testid="kg-overview-collapse"[\s\S]{0,300}@click="emit\('collapse'\)"/u);
  assert.match(detailSource, /defineEmits<\{ collapse: \[\] \}>/u);
  assert.match(detailSource, /data-testid="kg-detail-collapse"[\s\S]{0,300}@click="emit\('collapse'\)"/u);
});

// ==================== 5. 右侧详情滚动结构 ====================

test('右侧详情：标题区固定 + 内容区唯一滚动容器，且允许在 flex 内收缩', () => {
  const detail = cssRule(detailSource, '.kg-detail');
  assert.match(detail, /display:\s*flex/u);
  assert.match(detail, /flex-direction:\s*column/u);
  assert.match(detail, /height:\s*100%/u, '详情面板必须占满栏高，不能靠内容自撑');
  assert.match(detail, /min-height:\s*0/u, 'flex 子项必须有 min-height:0，否则内容撑高后会被父级裁切');

  const head = cssRule(detailSource, '.kg-detail__head');
  assert.match(head, /flex:\s*0 0 auto/u, '标题区不参与滚动、不伸缩');

  const body = cssRule(detailSource, '.kg-detail__body');
  assert.match(body, /flex:\s*1 1 auto/u);
  assert.match(body, /min-height:\s*0/u, '滚动区域必须设置 min-height:0 才能稳定出现滚动条');
  assert.match(body, /overflow-y:\s*auto/u, '内容区必须可纵向滚动');
  assert.match(body, /overscroll-behavior-y:\s*contain/u, '避免滚轮/触摸滚动链式传给页面');
  assert.equal(/height:\s*\d+px/u.test(body), false, '不得用固定高度裁切内容');

  // 只有一个纵向滚动容器：标题区与卡片内部都不再嵌套滚动
  const scrollContainers = detailSource.match(/overflow-y:\s*(auto|scroll)/gu) ?? [];
  assert.equal(scrollContainers.length, 1, `详情面板只允许一个纵向滚动容器（实际 ${scrollContainers.length} 个）`);

  // 滚动容器覆盖完整内容：关联关系与问 AI 区块都在 body 内
  const bodyStart = detailSource.indexOf('data-testid="kg-detail-body"');
  for (const testId of ['kg-relations', 'kg-ai-block']) {
    const at = detailSource.indexOf(`data-testid="${testId}"`);
    assert.ok(bodyStart > 0 && at > bodyStart, `${testId} 必须位于可滚动的内容区内`);
  }
});

test('关联档案卡片随内容自撑高度：标题换行、不截断、证据字段完整展示', () => {
  const node = cssRule(detailSource, '.kg-rel__node');
  assert.match(node, /white-space:\s*normal/u, '关联档案标题必须换行，不能单行截断');
  assert.equal(node.includes('text-overflow: ellipsis'), false, '不得再用省略号截断关联档案标题');
  assert.match(node, /word-break:\s*break-word/u);

  const rel = cssRule(detailSource, '.kg-rel');
  assert.equal(/height:\s*\d/u.test(rel), false, '关联卡片不得固定高度');
  assert.equal(/overflow:\s*hidden/u.test(rel), false, '关联卡片不得裁切内部文字');

  // 关联依据 / 原因 / 算式 / 峰值相似度 / 支撑块对 都有渲染出口
  for (const token of ['算式', '峰值相似', '支撑块对', '关联原因', '相似度']) {
    assert.ok((detailSource+readFileSync(new URL('../src/lib/agentSource.ts',import.meta.url),'utf8')).includes(token), `必须展示「${token}」`);
  }
});

test('左栏概览同样在栏内独立滚动，不靠父级裁切', () => {
  const overview = cssRule(overviewSource, '.kg-overview');
  assert.match(overview, /height:\s*100%/u);
  assert.match(overview, /min-height:\s*0/u);
  assert.match(overview, /overflow-y:\s*auto/u);
  assert.match(overview, /overscroll-behavior-y:\s*contain/u);
});
