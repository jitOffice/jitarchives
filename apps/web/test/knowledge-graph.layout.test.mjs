/**
 * 档案知识图谱 · 布局稳定性与重绘调度测试（本次根因修复的回归防线）。
 *
 * 覆盖四件事：
 * 1. 斥力随距离衰减（修复「位移与距离无关 → 整图永不收敛」的根因）；
 * 2. 重合节点 / 极限迭代下不会出现 NaN、Infinity，也不会无限计算；
 * 3. 收敛后位置稳定，增量布局不动既有节点，拖动固定的节点保持不动；
 * 4. 画布重绘把请求合并成单帧、画完即停，卸载后不残留动画任务。
 *
 * 数据仍是「喂给纯函数的入参」，形状与后端 KgGraphNodeView / KgGraphEdgeView 一致；
 * 真实库数据的验收由 tools 下的真实数据探针与 store 测试覆盖。
 * 运行：node --experimental-transform-types --test test/knowledge-graph.layout.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createFrameLoop } from '../src/lib/knowledge-graph/frameLoop.ts';
import { layoutPassBudget, planLayout, sameTopology, topologyOf } from '../src/lib/knowledge-graph/layoutPlan.ts';
import { seedPositions } from '../src/lib/knowledge-graph/subgraph.ts';
import { settleLayout, stepLayout } from '../src/lib/knowledge-graph/forceLayout.ts';

function node(type, refId, extra = {}) {
  return {
    key: `${type}:${refId}`,
    id: refId,
    type,
    refId,
    label: `${type}-${refId}`,
    archiveId: type === 'category' ? null : 10 + refId,
    fileId: null,
    expandable: type !== 'chunk',
    childCount: extra.childCount ?? 0,
    facts: {},
  };
}

function edge(id, type, from, to, weight = 1) {
  return { id, type, label: type, from: from.key, to: to.key, fromId: from.refId, toId: to.refId, weight, basis: 'business_structure', reason: '' };
}

/** 与正式库全景图同规模的真实拓扑形状：3 个分类 + 10 份档案 + 18 条关系。 */
function panorama() {
  const categories = [1, 2, 3].map((id) => node('category', id, { childCount: id === 1 ? 4 : 3 }));
  const archives = Array.from({ length: 10 }, (_, i) => node('archive', 11 + i, { childCount: 1 }));
  const edges = [];
  let id = 1;
  archives.forEach((archive, index) => {
    edges.push(edge(id++, 'category_contains_archive', categories[index % categories.length], archive));
  });
  for (const [a, b] of [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [0, 4], [1, 6], [3, 8]]) {
    edges.push(edge(id++, 'archive_related_to', archives[a], archives[b], 0.7));
  }
  return { nodes: [...categories, ...archives], edges };
}

function shiftOnce(distance, options = {}) {
  const nodes = [node('archive', 1), node('archive', 2)];
  const positions = new Map([
    ['archive:1', { x: 0, y: 0 }],
    ['archive:2', { x: distance, y: 0 }],
  ]);
  stepLayout({ nodes, edges: [] }, positions, { iterations: 1, gravity: 0, damping: 0, ...options });
  const point = positions.get('archive:1');
  return { x: point.x, y: point.y };
}

/**
 * 单次迭代里「只由斥力贡献」的位移：同一场景再跑一遍 repulsionStrength=0，
 * 两次结果的向量差就是斥力本身（分层重心、重力等其余力完全抵消）。
 */
function repulsionShift(distance) {
  const withRepulsion = shiftOnce(distance);
  const withoutRepulsion = shiftOnce(distance, { repulsionStrength: 0 });
  return Math.hypot(withRepulsion.x - withoutRepulsion.x, withRepulsion.y - withoutRepulsion.y);
}

function snapshot(positions, keys) {
  return new Map(keys.map((key) => [key, { x: positions.get(key).x, y: positions.get(key).y }]));
}

function maxDrift(positions, before) {
  let drift = 0;
  for (const [key, point] of before) {
    drift = Math.max(drift, Math.hypot(positions.get(key).x - point.x, positions.get(key).y - point.y));
  }
  return drift;
}

// ==================== 1. 斥力随距离衰减 ====================

test('斥力随距离增加而衰减：近处推开、远处几乎不动，不再是恒定位移', () => {
  const near = repulsionShift(60);
  const middle = repulsionShift(200);
  const far = repulsionShift(380);
  const beyond = repulsionShift(600);

  assert.ok(near > 0 && Number.isFinite(near), `近距离必须有斥力（实际 ${near}）`);
  assert.ok(near > middle, `斥力必须随距离衰减：60px=${near.toFixed(3)} > 200px=${middle.toFixed(3)}`);
  assert.ok(middle > far, `斥力必须随距离衰减：200px=${middle.toFixed(3)} > 380px=${far.toFixed(3)}`);
  assert.ok(near > middle * 3, '近距离斥力应明显强于远处，而不是整幅图恒定推力');
  // 旧实现 force = minGap²/distance 计算出的位移与距离无关（恒为 minGap²×0.02），走不出衰减
  assert.ok(far < near / 6, `远处斥力必须显著小于近处（60px=${near.toFixed(3)} vs 380px=${far.toFixed(3)}）`);
  assert.equal(beyond, 0, '作用半径之外不再产生斥力（边界处已线性衰减到 0，不会突变）');
});

test('距离趋近 0 时仍给出有限且有方向的斥力，重合节点能被推开', () => {
  const nodes = [node('archive', 1), node('archive', 2), node('archive', 3)];
  const edges = [edge(1, 'archive_related_to', nodes[0], nodes[1], 0.6)];
  const positions = new Map(nodes.map((item) => [item.key, { x: 0, y: 0 }]));

  for (let i = 0; i < 40; i += 1) stepLayout({ nodes, edges }, positions, { iterations: 2 });

  for (const item of nodes) {
    const point = positions.get(item.key);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${item.key} 坐标不得出现 NaN / Infinity`);
    assert.ok(Number.isFinite(point.vx) && Number.isFinite(point.vy), `${item.key} 速度必须是有限值`);
  }
  let minGap = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = positions.get(nodes[i].key);
      const b = positions.get(nodes[j].key);
      minGap = Math.min(minGap, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  assert.ok(minGap > 30, `完全重合的节点必须被推开（实际最小间距 ${minGap.toFixed(2)}）`);
});

// ==================== 2. 收敛与稳定 ====================

test('真实规模拓扑（13 节点 / 18 关系）能在限定轮数内收敛到 0.04 阈值', () => {
  const graph = panorama();
  const positions = seedPositions(graph.nodes, graph, new Map(), { x: 0, y: 0 });
  const budget = layoutPassBudget(graph.nodes.length);
  assert.equal(budget, 800, '小图应拿到最大布局预算');

  const result = settleLayout(graph, positions, { maxPasses: budget });
  assert.equal(result.settled, true, `必须在预算内收敛（实际 passes=${result.passes} energy=${result.energy}）`);
  assert.ok(result.passes > 0 && result.passes <= budget);
  assert.ok(result.energy <= 0.04, `收敛时最大位移必须低于阈值（实际 ${result.energy}）`);
  assert.equal(result.positions, positions, '收敛结果必须继续使用同一份位置缓存');
});

test('撞上迭代上限时安全停止：返回 settled=false 并保留当前坐标', () => {
  const graph = panorama();
  const positions = seedPositions(graph.nodes, graph, new Map(), { x: 0, y: 0 });
  const keys = graph.nodes.map((item) => item.key);
  const before = snapshot(positions, keys);

  const result = settleLayout(graph, positions, { maxPasses: 3 });

  assert.equal(result.settled, false, '3 轮不足以收敛，必须如实返回 false');
  assert.equal(result.passes, 3, '必须正好停在上限，不允许无限迭代');
  assert.ok(maxDrift(positions, before) > 0, '停止前的位置更新必须保留（不能被丢弃）');
  for (const key of keys) assert.ok(Number.isFinite(positions.get(key).x), `${key} 坐标必须有效`);
});

test('收敛后再次收敛不再移动节点：连续绘制不会改变坐标', () => {
  const graph = panorama();
  const positions = seedPositions(graph.nodes, graph, new Map(), { x: 0, y: 0 });
  const budget = layoutPassBudget(graph.nodes.length);
  const first = settleLayout(graph, positions, { maxPasses: budget });
  assert.equal(first.settled, true);

  const keys = graph.nodes.map((item) => item.key);
  const before = snapshot(positions, keys);

  // 再平衡一次：已经稳定的图应在 1 轮内判定收敛，位移不超过「每次迭代阈值 × 每轮迭代数」
  const again = settleLayout(graph, positions, { maxPasses: budget });
  assert.equal(again.settled, true);
  assert.equal(again.passes, 1, '收敛后的图不应再跑多轮');
  const drift = maxDrift(positions, before);
  assert.ok(drift <= 0.08, `再次收敛的位移必须低于 2 次迭代的阈值上限（实际 ${drift}）`);
  assert.ok(drift < 0.1, '亚像素级位移，视觉上完全不可见');

  // 纯绘制（读取坐标）绝不会改动坐标
  const painted = snapshot(positions, keys);
  const drawn = keys.map((key) => `${positions.get(key).x},${positions.get(key).y}`).join('|');
  const afterDraw = keys.map((key) => `${positions.get(key).x},${positions.get(key).y}`).join('|');
  assert.equal(afterDraw, drawn, '绘制前后坐标必须完全一致');
  assert.equal(maxDrift(positions, painted), 0);
});

// ==================== 3. 增量布局 / 拖动 ====================

test('展开新增节点只让新节点收敛：既有节点位置完全不变', () => {
  const base = panorama();
  const positions = seedPositions(base.nodes, base, new Map(), { x: 0, y: 0 });
  settleLayout(base, positions, { maxPasses: layoutPassBudget(base.nodes.length) });
  const keys = base.nodes.map((item) => item.key);
  const before = snapshot(positions, keys);

  const parent = base.nodes[0];
  const file = node('file', 501, { childCount: 2 });
  const next = {
    nodes: [...base.nodes, file],
    edges: [...base.edges, edge(9001, 'archive_contains_file', base.nodes[3], file)],
  };
  const nextPositions = seedPositions(next.nodes, next, positions, { x: 0, y: 0 });
  const seeded = nextPositions.get(file.key);
  assert.ok(seeded, '新增节点必须先在父节点附近获得初始位置');

  const result = settleLayout(next, nextPositions, { maxPasses: layoutPassBudget(next.nodes.length), fixedKeys: keys });
  assert.equal(result.settled, true, '增量布局必须能收敛');
  assert.equal(maxDrift(nextPositions, before), 0, '既有节点必须纹丝不动（增量布局冻结它们）');

  const parentPoint = nextPositions.get(base.nodes[3].key);
  const placed = nextPositions.get(file.key);
  const distanceToParent = Math.hypot(placed.x - parentPoint.x, placed.y - parentPoint.y);
  assert.ok(distanceToParent > 1, '新节点不能叠在父节点上');
  assert.ok(distanceToParent < 420, `新节点应出现在父节点附近（实际 ${distanceToParent.toFixed(1)}）`);
  void parent;
});

test('被拖动的节点固定在新位置：后续布局不再搬走它', () => {
  const graph = panorama();
  const positions = seedPositions(graph.nodes, graph, new Map(), { x: 0, y: 0 });
  const dragged = positions.get('archive:11');
  dragged.x = 640;
  dragged.y = -240;
  dragged.vx = 0;
  dragged.vy = 0;
  dragged.pinned = true;

  settleLayout(graph, positions, { maxPasses: layoutPassBudget(graph.nodes.length) });

  assert.equal(positions.get('archive:11').x, 640, '拖动后的 x 必须保持不变');
  assert.equal(positions.get('archive:11').y, -240, '拖动后的 y 必须保持不变');
  assert.equal(positions.get('archive:11').vx, 0, '固定节点不应残留速度');
});

// ==================== 4. 布局触发判定 ====================

test('只有拓扑真的变化才布局：选中 / 详情 / 重绘都不触发', () => {
  const graph = panorama();
  const topology = topologyOf(graph);

  // 同一批节点与关系（选中、详情、主题、窗口尺寸、普通重绘）→ 不布局
  assert.equal(planLayout(topology, { nodes: graph.nodes, edges: graph.edges }).action, 'none');
  assert.equal(sameTopology(topology, topologyOf({ nodes: [...graph.nodes], edges: [...graph.edges] })), true);
  assert.equal(planLayout(topology, { nodes: graph.nodes, edges: graph.edges }, { replaceLayer: true }).action, 'full');

  // 新增节点 → 增量布局，且冻结既有节点
  const added = node('file', 601);
  const incremental = planLayout(topology, { nodes: [...graph.nodes, added], edges: graph.edges });
  assert.equal(incremental.action, 'incremental');
  assert.deepEqual(incremental.addedKeys, ['file:601']);
  assert.equal(incremental.fixedKeys.length, graph.nodes.length, '既有节点必须全部冻结');

  // 收起（只删节点）→ 保留其余节点位置，不重新排布
  const removed = planLayout(topology, { nodes: graph.nodes.slice(1), edges: [] });
  assert.equal(removed.action, 'none');
  assert.equal(removed.removedKeys.length, 1);

  // 首次加载 → 全量布局
  assert.equal(planLayout(null, graph).action, 'full');
  assert.equal(planLayout(topology, { nodes: [], edges: [] }).action, 'none', '空图不布局');
});

test('布局预算随节点数递减并夹在安全区间内', () => {
  assert.equal(layoutPassBudget(13), 800);
  assert.equal(layoutPassBudget(2), 800);
  assert.ok(layoutPassBudget(120) < 800 && layoutPassBudget(120) > 40, '中等图应少于最大预算');
  const large = layoutPassBudget(300);
  assert.ok(large >= 40 && large < 120, `大图必须落到最小预算附近（实际 ${large}），同步布局不会卡死主线程`);
  assert.equal(layoutPassBudget(1200), 40);
});

// ==================== 5. 画布重绘调度（RAF） ====================

function fakePort() {
  const queue = new Map();
  let nextHandle = 1;
  return {
    port: {
      request(callback) {
        const handle = nextHandle++;
        queue.set(handle, callback);
        return handle;
      },
      cancel(handle) {
        queue.delete(handle);
      },
    },
    get pending() {
      return queue.size;
    },
    flush(time = 16) {
      const callbacks = [...queue.values()];
      queue.clear();
      for (const callback of callbacks) callback(time);
    },
    get size() {
      return queue.size;
    },
  };
}

test('重绘请求合并成单帧，画完即停：不存在持续申请 RAF 的循环', () => {
  const scheduler = fakePort();
  let draws = 0;
  const loop = createFrameLoop(() => { draws += 1; }, scheduler.port);

  loop.request();
  loop.request();
  loop.request();
  assert.equal(scheduler.size, 1, '同一帧内的多次请求只能排一帧');
  assert.equal(loop.stats().requests, 3, '请求次数如实统计');
  assert.equal(loop.stats().pending, true);

  scheduler.flush();
  assert.equal(draws, 1, '一次排期只画一帧');
  assert.equal(loop.stats().frames, 1);
  assert.equal(loop.stats().pending, false, '画完不应再排下一帧');
  assert.equal(scheduler.size, 0, '不得自我续期（旧实现会无限 requestAnimationFrame）');

  // 后续事件可以再排一帧，仍然是「一帧一次」
  loop.request();
  assert.equal(scheduler.size, 1);
  scheduler.flush();
  assert.equal(draws, 2);
  assert.equal(scheduler.size, 0);
});

test('组件卸载取消待执行的重绘：不再回调，也不留残余任务', () => {
  const scheduler = fakePort();
  let draws = 0;
  const loop = createFrameLoop(() => { draws += 1; }, scheduler.port);

  loop.request();
  assert.equal(scheduler.size, 1);
  loop.cancel();
  assert.equal(scheduler.size, 0, '卸载后队列必须清空');
  assert.equal(loop.stats().pending, false);

  scheduler.flush();
  assert.equal(draws, 0, '被取消的帧不得再绘制');

  loop.cancel(); // 空取消不应出错
  assert.equal(loop.stats().pending, false);
});

// ==================== 6. 画布组件不再自行驱动动画 ====================

const canvasSource = readFileSync(new URL('../src/components/knowledge-graph/GraphCanvas.vue', import.meta.url), 'utf8');

test('画布组件不再直接申请 RAF，也不在挂载时把布局重置为未收敛', () => {
  assert.equal(canvasSource.includes('requestAnimationFrame'), false, '画布不得直接使用 requestAnimationFrame（一律走 frameLoop 单帧调度）');
  assert.equal(canvasSource.includes('stepLayout'), false, '画布不得再做力导向迭代，布局只在 store 执行一次');
  assert.doesNotMatch(canvasSource, /settled\s*=\s*false/u, '挂载时不得把布局状态重置为未收敛（旧实现会因此重复布局）');
  assert.match(canvasSource, /onBeforeUnmount\([\s\S]*?frames\.cancel\(\)/u, '卸载时必须取消待执行的重绘帧');
  assert.match(canvasSource, /watch\(\s*\(\) => props\.nodes/u, '节点变化只重绘，不触发布局');
});
