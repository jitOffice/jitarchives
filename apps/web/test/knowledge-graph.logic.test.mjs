/**
 * 档案知识图谱 · 前端纯逻辑测试（第二阶段）。
 *
 * 覆盖不依赖 DOM 的四块核心逻辑：视觉映射、力导向布局与视口/命中、子图合并与展开、API 参数装配与过期响应守卫。
 * 这里的 node/edge 只是「喂给纯函数的入参」（真实数据链路由 knowledge-graph.store.test.mjs 用真实后端验证），
 * 产品运行时绝不生成模拟节点：GraphCanvas 与 store 只消费接口返回的节点与关系。
 * 运行：node --test test/knowledge-graph.logic.test.mjs（Node 原生剥离 TS 类型，无需构建）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KG_EDGE_STYLES,
  KG_EDGE_TYPES,
  KG_NODE_STYLES,
  KG_NODE_TYPES,
  KG_PALETTES,
  edgeAlpha,
  edgeStyle,
  nodeRadius,
  nodeStyle,
} from '../src/lib/knowledge-graph/styles.ts';
import {
  childrenOf,
  groupByType,
  hashAngle,
  highlightOf,
  isDownwardEdge,
  mergeSubgraph,
  parentKeyOf,
  pruneNodes,
  seedPositions,
} from '../src/lib/knowledge-graph/subgraph.ts';
import {
  fitView,
  focusOn,
  hitEdge,
  hitNode,
  panBy,
  settleLayout,
  stepLayout,
  toScreen,
  toWorld,
  zoomAt,
} from '../src/lib/knowledge-graph/forceLayout.ts';
import { createRequestGuard, kgGraphQuery } from '../src/api/knowledgeGraph.ts';
import { parseKgNodeKey as parseKgNodeKeyInTypes } from '../src/lib/knowledge-graph/types.ts';

/** 入参工厂：形状与后端 KgGraphNodeView / KgGraphEdgeView 完全一致。 */
function node(type, refId, extra = {}) {
  return {
    key: `${type}:${refId}`,
    id: refId,
    type,
    refId,
    label: extra.label ?? `${type}-${refId}`,
    archiveId: type === 'category' ? null : 10 + refId,
    fileId: type === 'chunk' ? 5 : null,
    expandable: extra.expandable ?? (type !== 'chunk'),
    childCount: extra.childCount ?? 0,
    facts: extra.facts ?? {},
  };
}

function edge(id, type, from, to, weight = 1) {
  return { id, type, label: type, from: from.key, to: to.key, fromId: from.refId, toId: to.refId, weight, basis: 'business_structure', reason: '' };
}

function response(nodes, edges, mode = 'overview') {
  return {
    view: 'panorama',
    mode,
    nodes,
    edges,
    page: { page: 1, pageSize: 300, totalNodes: nodes.length, returnedNodes: nodes.length, returnedEdges: edges.length, truncated: false },
    limits: { maxNodes: 600, maxDepth: 3 },
  };
}

// ==================== 视觉映射 ====================

test('四类节点与六种关系各有可区分的视觉样式', () => {
  assert.deepEqual(KG_NODE_TYPES, ['category', 'archive', 'file', 'chunk']);
  const shapes = new Set(KG_NODE_TYPES.map((t) => nodeStyle(t).shape));
  assert.equal(shapes.size, 4, '四类节点必须是四种不同形状');
  const colors = new Set(KG_NODE_TYPES.map((t) => nodeStyle(t).stroke));
  assert.equal(colors.size, 4, '四类节点描边色必须互不相同');
  assert.deepEqual(
    KG_NODE_TYPES.map((type) => nodeStyle(type).shape),
    ['square', 'circle', 'diamond', 'hexagon'],
    '分类、档案、附件、正文知识块必须分别使用圆角方形、圆形、菱形和六边形',
  );
  for (const type of KG_NODE_TYPES) {
    const style = nodeStyle(type);
    assert.notEqual(style.gradientStart, style.gradientEnd, `${type} 必须使用内部渐变填充`);
    assert.ok(style.iconLine, `${type} 必须配置内部白色图标的识别线色`);
  }

  assert.equal(KG_EDGE_TYPES.length, 6);
  const edgeColors = new Set(KG_EDGE_TYPES.map((t) => edgeStyle(t).color));
  assert.equal(edgeColors.size, 6, '六种关系的线色必须互不相同');
  // 结构关系实线，内容关联必须是虚线（不看文字也能分辨来源）
  assert.deepEqual(edgeStyle('category_contains_archive').dash, []);
  for (const type of ['chunk_similar_to', 'archive_related_to', 'archive_shared_reference']) {
    assert.ok(edgeStyle(type).dash.length >= 2, `${type} 必须是虚线`);
  }
});

test('节点半径由真实子节点数驱动，透明度由真实权重驱动', () => {
  assert.ok(nodeRadius('archive', 0) < nodeRadius('archive', 9), '子节点越多节点越大');
  assert.equal(nodeRadius('archive', 9), nodeRadius('archive', 9), '同一数量必得同一半径');
  assert.ok(edgeAlpha(0.2) < edgeAlpha(0.9), '权重越高线越实');
  assert.ok(edgeAlpha(Number.NaN) > 0, '异常权重要回落为可见值');
  assert.notEqual(KG_PALETTES.light.background, KG_PALETTES.dark.background, '明暗两套画布配色必须不同');
});

// ==================== 力导向布局与视口 ====================

test('布局可复现：同一批节点与同一初始位置必得同一结果（全程无随机数）', () => {
  const nodes = [node('category', 1), node('archive', 11), node('archive', 12), node('file', 21)];
  const edges = [
    edge(1, 'category_contains_archive', nodes[0], nodes[1]),
    edge(2, 'category_contains_archive', nodes[0], nodes[2]),
    edge(3, 'archive_contains_file', nodes[1], nodes[3]),
  ];
  const run = () => {
    const positions = seedPositions(nodes, { nodes, edges }, new Map(), { x: 0, y: 0 });
    settleLayout({ nodes, edges }, positions, { maxPasses: 30 });
    return nodes.map((n) => `${n.key}:${positions.get(n.key).x.toFixed(3)},${positions.get(n.key).y.toFixed(3)}`).join('|');
  };
  assert.equal(run(), run(), '两次布局必须逐位一致');
  assert.equal(hashAngle('archive:11'), hashAngle('archive:11'), '角度哈希稳定可复现');
});

test('布局会把重叠节点推开、收敛后停止，并尊重被拖动固定的节点', () => {
  const nodes = [node('archive', 1), node('archive', 2)];
  const edges = [edge(1, 'archive_related_to', nodes[0], nodes[1], 0.8)];
  const positions = new Map([
    ['archive:1', { x: 0, y: 0 }],
    ['archive:2', { x: 0, y: 0 }],
  ]);
  const first = stepLayout({ nodes, edges }, positions, { iterations: 3 });
  assert.ok(Math.hypot(positions.get('archive:1').x - positions.get('archive:2').x, positions.get('archive:1').y - positions.get('archive:2').y) > 1, '重合节点必须被推开');
  const pinned = new Map([
    ['archive:1', { x: 500, y: 500, pinned: true }],
    ['archive:2', { x: 502, y: 502 }],
  ]);
  for (let i = 0; i < 20; i += 1) stepLayout({ nodes, edges }, pinned, { iterations: 2 });
  assert.deepEqual({ x: pinned.get('archive:1').x, y: pinned.get('archive:1').y }, { x: 500, y: 500 }, '固定节点不得被布局搬走');
  assert.equal(typeof first.settled, 'boolean');
  const converged = settleLayout({ nodes, edges }, positions, { maxPasses: 120 });
  assert.equal(converged.settled, true, `两节点必须能真正收敛（energy=${converged.energy}）`);
  assert.ok(converged.passes > 0 && converged.passes <= 120);
  assert.equal(converged.positions, positions, '收敛后继续使用同一份位置缓存');
  assert.ok(converged.positions.get('archive:1'), '收敛后仍返回同一份位置缓存');
});

test('缩放围绕焦点、平移与适配视图后世界坐标可逆，命中测试取最上层', () => {
  const viewport = { width: 900, height: 600 };
  const nodes = [node('category', 1), node('archive', 11), node('chunk', 31)];
  const positions = new Map([
    ['category:1', { x: -300, y: -180 }],
    ['archive:11', { x: 0, y: 0 }],
    ['chunk:31', { x: 260, y: 240 }],
  ]);
  const base = { scale: 1, tx: 450, ty: 300 };
  const zoomed = zoomAt(base, 1.5, { x: 200, y: 120 });
  const focusWorld = toWorld(base, 200, 120);
  assert.equal(toWorld(zoomed, 200, 120).x.toFixed(6), focusWorld.x.toFixed(6), '围绕焦点缩放：焦点下内容不漂移');
  const panned = panBy(base, 40, -25);
  assert.equal(panned.scale, base.scale);
  assert.equal(panned.tx, base.tx + 40);
  assert.equal(toScreen(panned, 0, 0).x, 0 * panned.scale + panned.tx);

  const fit = fitView(nodes, positions, viewport);
  assert.ok(fit.scale > 0.25 && fit.scale <= 2, '适配视图的缩放要夹在可用区间');
  const empty = fitView([], new Map(), viewport);
  assert.equal(empty.scale, 1, '空图不缩放');

  const hit = hitNode(nodes, positions, { x: 2, y: -2 });
  assert.equal(hit?.key, 'archive:11', '命中测试应取覆盖该点的节点');
  assert.equal(hitNode(nodes, positions, { x: 9000, y: 9000 }), undefined, '空白处不得命中');
  const edgeHit = hitEdge([edge(2, 'archive_contains_file', nodes[1], nodes[2])], positions, { x: 130, y: 120 }, 8);
  assert.equal(edgeHit?.id, 2, '关系线附近应命中该条线（点击查看依据）');
  assert.equal(hitEdge([edge(2, 'archive_contains_file', nodes[1], nodes[2])], positions, { x: 600, y: -400 }, 6), undefined);
  const focused = focusOn(fit, positions.get('chunk:31'), viewport, 1.2);
  assert.equal(toScreen(focused, 260, 240).x.toFixed(3), (900 / 2).toFixed(3), '定位后节点应落在视口中心');
});

// ==================== 子图合并 / 展开 / 收起 ====================

test('合并是幂等的：同批数据重复合并不会堆出重复节点或关系', () => {
  const nodes = [node('category', 1), node('archive', 11)];
  const edges = [edge(1, 'category_contains_archive', nodes[0], nodes[1])];
  const first = mergeSubgraph({ nodes: [], edges: [] }, response(nodes, edges));
  const second = mergeSubgraph({ nodes: first.nodes, edges: first.edges }, response(nodes, edges));
  assert.equal(second.nodes.length, 2);
  assert.equal(second.edges.length, 1);
  assert.deepEqual(second.addedNodeKeys, [], '重复合并不应报告新增节点');
});

test('切换视图按层替换：新分类快照不残留旧分类节点，悬空关系不上画布', () => {
  const catA = node('category', 1);
  const catB = node('category', 2);
  const arcA = node('archive', 11, { childCount: 3 });
  const arcB = node('archive', 12);
  const current = { nodes: [catA, arcA], edges: [edge(1, 'category_contains_archive', catA, arcA)] };
  const next = mergeSubgraph(current, response([catB, arcB], [edge(2, 'category_contains_archive', catB, arcB)]), {
    replaceLayer: true,
    layerTypes: ['category', 'archive'],
  });
  assert.deepEqual(next.nodes.map((n) => n.key).sort(), ['archive:12', 'category:2']);
  assert.deepEqual(next.removedNodeKeys.sort(), ['archive:11', 'category:1']);
  assert.deepEqual(next.edges.map((e) => e.id), [2], '旧分类的关系随节点一起清掉');

  // 端点未加载的关系先挂起
  const dangling = mergeSubgraph(current, response([catA], [edge(9, 'archive_related_to', catA, node('archive', 99))]));
  assert.equal(dangling.edges.length, 1, '端点缺失的关系不得上画布');
  assert.equal(dangling.edges[0].id, 1);
});

test('展开增补保留已加载层，收起只移除该子树', () => {
  const cat = node('category', 1);
  const arc = node('archive', 11);
  const file = node('file', 21);
  const chunk = node('chunk', 31);
  const panorama = { nodes: [cat, arc], edges: [edge(1, 'category_contains_archive', cat, arc)] };
  const expanded = mergeSubgraph(panorama, response([file, arc], [edge(2, 'archive_contains_file', arc, file)]), { layerTypes: ['file'] });
  assert.deepEqual(expanded.nodes.map((n) => n.key).sort(), ['archive:11', 'category:1', 'file:21']);
  assert.deepEqual(childrenOf(arc.key, expanded).map((n) => n.key), ['file:21']);
  assert.equal(parentKeyOf(file, expanded), 'archive:11', '附件的结构父节点是档案');
  assert.equal(parentKeyOf(arc, expanded), 'category:1');
  assert.equal(parentKeyOf(cat, expanded), undefined, '分类没有上层');
  assert.equal(isDownwardEdge('archive_related_to', 'archive'), false, '内容关联不算下层');

  const withChunks = mergeSubgraph(expanded, response([chunk], [edge(3, 'file_contains_chunk', file, chunk)]));
  const pruned = pruneNodes(withChunks, new Set(['chunk:31']));
  assert.deepEqual(pruned.nodes.map((n) => n.key).sort(), ['archive:11', 'category:1', 'file:21']);
  assert.equal(pruned.edges.some((e) => e.id === 3), false, '收起后其关系一并移除');
  const hl = highlightOf('archive:11', withChunks);
  assert.deepEqual([...hl.nodes].sort(), ['archive:11', 'category:1', 'file:21'], '选中后突出显示一跳邻居');
  assert.deepEqual([...hl.edges], [1, 2]);
  assert.deepEqual(groupByType(withChunks.nodes).chunk.map((n) => n.key), ['chunk:31']);
});

test('节点键解析：知识块键含物理文件名，不能当成数字主键', () => {
  assert.deepEqual(parseKgNodeKeyInTypes('category:7'), { type: 'category', refId: 7, rawId: '7' });
  assert.deepEqual(parseKgNodeKeyInTypes('archive:12'), { type: 'archive', refId: 12, rawId: '12' });
  const chunk = parseKgNodeKeyInTypes('chunk:2026-file.docx:3');
  assert.equal(chunk.type, 'chunk');
  assert.equal(chunk.refId, null, '知识块键内没有数据库主键，必须回 null 让调用方走节点对象');
  assert.equal(chunk.rawId, '2026-file.docx:3');
  assert.equal(parseKgNodeKeyInTypes('nonsense'), undefined);
});

// ==================== API 参数装配 / 过期响应 ====================

test('图谱查询参数：空值不拼接、center 与布尔量按后端格式', () => {
  assert.equal(kgGraphQuery({}), '');
  assert.equal(
    kgGraphQuery({ view: 'category', categoryId: 3, center: { type: 'archive', refId: 12 }, depth: 2, types: ['archive', 'file'], includeRelations: true, page: 2, pageSize: 300 }),
    '?view=category&categoryId=3&center=archive%3A12&depth=2&types=archive%2Cfile&includeRelations=1&page=2&pageSize=300',
  );
  assert.match(kgGraphQuery({ view: 'panorama', includeRelations: false }), /includeRelations=0/);
  assert.doesNotMatch(kgGraphQuery({ view: 'panorama', categoryId: undefined, types: [] }), /categoryId|types/, '空参数不得进入 query');
});

test('过期响应守卫：后发先至时旧结果被丢弃（搜索与展开都不串数据）', () => {
  const guard = createRequestGuard();
  const slow = guard.next();
  const fast = guard.next();
  assert.equal(guard.isCurrent(slow), false, '慢请求回包时已非最新，必须丢弃');
  assert.equal(guard.isCurrent(fast), true);
  guard.cancel();
  assert.equal(guard.isCurrent(fast), false, '取消后在途响应全部作废');
});
