/**
 * 档案知识图谱 · 子图合并与交互计算（纯函数，不依赖 Vue / DOM，可单独测试）。
 *
 * 画布数据只有两个来源：后端真实节点/关系，以及由已加载子图合并出的视图集合。
 * 这里不做任何「补数据」：接口没给的节点，绝不凭空生成。
 */
import type { KgGraphEdgeView, KgGraphNodeView, KgGraphResponse, KgNodeType } from './types.ts';

/** 节点在画布上的位置（按业务主键缓存，主题切换 / 增量展开都不重新洗牌）。 */
export interface KgPoint {
  x: number;
  y: number;
  /** 布局速度（力导向迭代用，缓存后可继续收敛）。 */
  vx?: number;
  vy?: number;
  /** 是否由用户拖动固定（固定节点参与度降低）。 */
  pinned?: boolean;
}

export type KgPositionMap = Map<string, KgPoint>;

export interface KgSubgraph {
  nodes: KgGraphNodeView[];
  edges: KgGraphEdgeView[];
}

/** 合并结果：新增/更新的节点与关系，以及被本次响应判定为失效而移除的节点键。 */
export interface KgMergeResult extends KgSubgraph {
  addedNodeKeys: string[];
  addedEdgeIds: number[];
  removedNodeKeys: string[];
}

/** 后端全景/分类/展开响应里都带 mode；展开响应的中心节点必须保留在画布上。 */
export function nodesOf(response: KgGraphResponse): KgGraphNodeView[] {
  return Array.isArray(response?.nodes) ? response.nodes : [];
}

export function edgesOf(response: KgGraphResponse): KgGraphEdgeView[] {
  return Array.isArray(response?.edges) ? response.edges : [];
}

/**
 * 把一批响应合并进当前画布集合：
 * - 节点按 key 幂等覆盖（同 key 以最新 facts / childCount 为准）；
 * - 关系按 id 幂等覆盖；
 * - mode=overview 的分类/全景响应是「整层快照」，用它替换同类旧快照，避免切换视图后残留上一分类的节点；
 * - expand 响应只做增量，且端点未加载的关系先挂起，等两端齐全再上画布（不画悬空线）。
 */
export function mergeSubgraph(
  current: KgSubgraph,
  incoming: KgGraphResponse,
  options: { replaceLayer?: boolean; layerTypes?: KgNodeType[] } = {},
): KgMergeResult {
  const nodeByKey = new Map(current.nodes.map((node) => [node.key, node]));
  const edgeById = new Map(current.edges.map((edge) => [edge.id, edge]));

  // 层级替换：先清掉同层旧节点（及其相连关系），保证「切换分类视图」不残留上一视图内容
  const removedNodeKeys: string[] = [];
  if (options.replaceLayer) {
    const layer = new Set(options.layerTypes ?? []);
    const dropped = new Set<string>();
    for (const [key, node] of nodeByKey) {
      if (!layer.has(node.type)) continue;
      nodeByKey.delete(key);
      dropped.add(key);
      removedNodeKeys.push(key);
    }
    for (const [id, edge] of [...edgeById]) {
      if (dropped.has(edge.from) || dropped.has(edge.to)) edgeById.delete(id);
    }
  }

  const addedNodeKeys: string[] = [];
  for (const node of nodesOf(incoming)) {
    if (!node || typeof node.key !== 'string') continue;
    if (!nodeByKey.has(node.key)) addedNodeKeys.push(node.key);
    nodeByKey.set(node.key, node);
  }
  const addedEdgeIds: number[] = [];
  for (const edge of edgesOf(incoming)) {
    if (!edge || typeof edge.id !== 'number') continue;
    if (!edgeById.has(edge.id)) addedEdgeIds.push(edge.id);
    edgeById.set(edge.id, edge);
  }

  // 端点缺失的关系不上画布（后端已保证同批返回，这里只是兜底，绝不画悬空线）
  const nodes = [...nodeByKey.values()];
  const keys = new Set(nodes.map((node) => node.key));
  const edges = [...edgeById.values()].filter((edge) => keys.has(edge.from) && keys.has(edge.to));
  return { nodes, edges, addedNodeKeys, addedEdgeIds, removedNodeKeys };
}

/** 删除子树（收起展开层）：只移除指定键集合，且同步清掉相关关系。 */
export function pruneNodes(current: KgSubgraph, keysToRemove: Iterable<string>): KgSubgraph {
  const remove = new Set(keysToRemove);
  if (!remove.size) return current;
  const nodes = current.nodes.filter((node) => !remove.has(node.key));
  const keys = new Set(nodes.map((node) => node.key));
  const edges = current.edges.filter((edge) => keys.has(edge.from) && keys.has(edge.to));
  return { nodes, edges };
}

/** 选中节点的强调集合：自身 + 直接相邻节点 + 相连关系（其余淡出）。 */
export function highlightOf(selectedKey: string | null, graph: KgSubgraph): { nodes: Set<string>; edges: Set<number> } {
  const nodes = new Set<string>();
  const edges = new Set<number>();
  if (!selectedKey) return { nodes, edges };
  nodes.add(selectedKey);
  for (const edge of graph.edges) {
    if (edge.from !== selectedKey && edge.to !== selectedKey) continue;
    edges.add(edge.id);
    nodes.add(edge.from);
    nodes.add(edge.to);
  }
  return { nodes, edges };
}

/** 某节点已加载的下层邻接（用于「展开/收起」判断与双击时的增量请求）。 */
export function childrenOf(parentKey: string, graph: KgSubgraph): KgGraphNodeView[] {
  const parent = graph.nodes.find((node) => node.key === parentKey);
  if (!parent) return [];
  const childKeys = new Set(
    graph.edges
      .filter((edge) => edge.from === parentKey && isDownwardEdge(edge.type, parent.type))
      .map((edge) => edge.to),
  );
  return graph.nodes.filter((node) => childKeys.has(node.key));
}

/** 结构层方向：分类→档案→附件→知识块（内容关联不算「下层」）。 */
export function isDownwardEdge(type: string, fromType: KgNodeType): boolean {
  if (fromType === 'category') return type === 'category_contains_archive';
  if (fromType === 'archive') return type === 'archive_contains_file';
  if (fromType === 'file') return type === 'file_contains_chunk';
  return false;
}

/** 结构层「上一层」类型（用于按边方向定位父节点）。 */
const UPWARD_TYPE: Partial<Record<KgNodeType, KgNodeType>> = { archive: 'category', file: 'archive', chunk: 'file' };

/**
 * 视图位置缓存：新节点在父节点附近铺开（角度由 key 哈希决定，稳定可复现，不用随机数）。
 * 已有位置的节点保持不变，避免每次展开整张图重排。
 */
export function seedPositions(
  nodes: KgGraphNodeView[],
  graph: KgSubgraph,
  positions: KgPositionMap,
  anchor: { x: number; y: number } = { x: 0, y: 0 },
  spread = 220,
): KgPositionMap {
  const next: KgPositionMap = new Map(positions);
  const degree = new Map<string, number>();
  for (const node of nodes) {
    if (next.has(node.key)) continue;
    const parent = parentKeyOf(node, graph);
    const base = parent ? next.get(parent) : undefined;
    const ring = (degree.get(parent ?? '') ?? 0) + 1;
    degree.set(parent ?? '', ring);
    if (base) {
      const angle = hashAngle(node.key) + ((ring - 1) % 8) * 0.42;
      const distance = 96 + (ring % 4) * 26;
      next.set(node.key, { x: base.x + Math.cos(angle) * distance, y: base.y + Math.sin(angle) * distance });
    } else {
      const angle = hashAngle(node.key);
      const distance = spread * (0.45 + ((ring * 37) % 100) / 100);
      next.set(node.key, { x: anchor.x + Math.cos(angle) * distance, y: anchor.y + Math.sin(angle) * distance });
    }
  }
  return next;
}

/** 节点的结构父节点（档案→分类、附件→档案、知识块→附件）；没有已加载父层时返回 undefined。 */
export function parentKeyOf(node: KgGraphNodeView, graph: KgSubgraph): string | undefined {
  const parentType = UPWARD_TYPE[node.type];
  if (!parentType) return undefined;
  const typeByKey = new Map(graph.nodes.map((item) => [item.key, item.type]));
  for (const edge of graph.edges) {
    if (edge.to !== node.key) continue;
    if (typeByKey.get(edge.from) !== parentType) continue;
    if (!isDownwardEdge(edge.type, parentType)) continue;
    return edge.from;
  }
  return undefined;
}

/** 稳定哈希角：同一 key 永远得到同一角度（可复现布局，便于自动化断言）。 */
export function hashAngle(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
}

/** 按类型分组（左栏分类列表与画布分层布局共用）。 */
export function groupByType(nodes: KgGraphNodeView[]): Record<KgNodeType, KgGraphNodeView[]> {
  const out: Record<KgNodeType, KgGraphNodeView[]> = { category: [], archive: [], file: [], chunk: [] };
  for (const node of nodes) out[node.type]?.push(node);
  return out;
}
