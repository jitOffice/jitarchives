/**
 * 档案知识图谱 · 布局触发判定（纯函数，不依赖 Vue / DOM，可单独测试）。
 *
 * 位置缓存只在「拓扑真的变了」时才重算：
 * - 首次加载 / 切换整层 → 全量布局（新一批节点重新初始化）；
 * - 展开子图新增节点 → 增量布局（冻结既有节点，只有新节点在父节点附近收敛）；
 * - 选中、详情、关系面板、主题、窗口尺寸、普通重绘 → 一律不布局。
 *
 * 这样同一批节点不会被 store 与画布重复初始化，也不会因为右栏刷新把整张图重新洗牌。
 */
import type { KgGraphEdgeView, KgGraphNodeView } from './types.ts';

/** 当前画布的拓扑指纹：节点键集合 + 关系 id 集合。 */
export interface KgTopology {
  nodeKeys: ReadonlySet<string>;
  edgeIds: ReadonlySet<number>;
}

export type KgLayoutAction = 'none' | 'incremental' | 'full';

export interface KgLayoutPlan {
  action: KgLayoutAction;
  /** 增量布局时必须冻结的既有节点（它们在本次布局中位置不变）。 */
  fixedKeys: string[];
  addedKeys: string[];
  removedKeys: string[];
}

export function topologyOf(graph: { nodes: KgGraphNodeView[]; edges: KgGraphEdgeView[] }): KgTopology {
  return {
    nodeKeys: new Set(graph.nodes.map((node) => node.key)),
    edgeIds: new Set(graph.edges.map((edge) => edge.id)),
  };
}

export function sameTopology(a: KgTopology, b: KgTopology): boolean {
  if (a.nodeKeys.size !== b.nodeKeys.size || a.edgeIds.size !== b.edgeIds.size) return false;
  for (const key of a.nodeKeys) if (!b.nodeKeys.has(key)) return false;
  for (const id of a.edgeIds) if (!b.edgeIds.has(id)) return false;
  return true;
}

/**
 * 布局预算：每次布局最多消耗的「节点对 × 迭代」次数。
 * 小图（真实全景 13 节点 / 18 关系，实测约 450 轮收敛）能跑满 800 轮直到真正收敛，
 * 留出 1.7 倍余量应对不同拓扑；大图按预算减少轮数，达到上限时保留当前位置并安全停止，
 * 绝不在画布上无限迭代。因为「轮数 × 节点对」被总额封顶，单次同步布局的耗时始终有界。
 */
const LAYOUT_PAIR_BUDGET = 4_000_000;
const LAYOUT_MAX_PASSES = 800;
const LAYOUT_MIN_PASSES = 40;

/** 按节点数给出的 settle 轮数上限（每轮含 2 次迭代）。 */
export function layoutPassBudget(nodeCount: number): number {
  const pairs = Math.max(1, (nodeCount * (nodeCount - 1)) / 2);
  const budget = Math.round(LAYOUT_PAIR_BUDGET / (pairs * 2));
  return Math.max(LAYOUT_MIN_PASSES, Math.min(LAYOUT_MAX_PASSES, budget));
}

/**
 * 根据「上一份拓扑」与「合并后的子图」决定这次要不要布局、布哪种局。
 * replaceLayer 表示整层快照替换（切换全景 / 分类视图），这类切换必须重新初始化位置。
 */
export function planLayout(
  previous: KgTopology | null | undefined,
  next: { nodes: KgGraphNodeView[]; edges: KgGraphEdgeView[] },
  options: { replaceLayer?: boolean } = {},
): KgLayoutPlan {
  const nodeKeys = new Set(next.nodes.map((node) => node.key));
  const prevKeys = previous?.nodeKeys ?? new Set<string>();
  const addedKeys = next.nodes.filter((node) => !prevKeys.has(node.key)).map((node) => node.key);
  const removedKeys = [...prevKeys].filter((key) => !nodeKeys.has(key));

  if (!next.nodes.length) return { action: 'none', fixedKeys: [], addedKeys, removedKeys };
  if (options.replaceLayer || prevKeys.size === 0) {
    return { action: 'full', fixedKeys: [], addedKeys, removedKeys };
  }
  if (addedKeys.length) {
    // 增量布局：冻结上一批节点，只让新节点在父节点附近收敛，整图不会被重新拉扯
    const fixedKeys = [...prevKeys].filter((key) => nodeKeys.has(key));
    return { action: 'incremental', fixedKeys, addedKeys, removedKeys };
  }
  // 只删节点 / 只增删关系：既有位置仍然有效（不会凭空产生重叠），保持原样最稳定
  return { action: 'none', fixedKeys: [], addedKeys, removedKeys };
}
