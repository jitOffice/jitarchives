/**
 * 档案知识图谱 · 力导向布局与视口计算（纯函数，不依赖 DOM / Canvas，可单独测试）。
 *
 * 采用 Fruchterman-Reingold 思路的轻量实现：斥力 + 弹簧引力 + 分层重心，
 * 迭代直到动能低于阈值即停止（避免每帧重复整图重排），全程无随机数：
 * 同一批节点与同一初始位置必然得到同一布局结果。
 */
import type { KgGraphEdgeView, KgGraphNodeView } from './types.ts';
import { nodeRadius } from './styles.ts';
import { hashAngle, type KgPositionMap, type KgSubgraph } from './subgraph.ts';

export interface KgTransform {
  /** 世界坐标 → 屏幕坐标：screen = world * scale + translate */
  scale: number;
  tx: number;
  ty: number;
}

export interface LayoutOptions {
  /** 单次 step 的迭代次数（会被夹在 1~6）。 */
  iterations?: number;
  /** 斥力作用半径（超过则跳过，减少 O(n²) 常数）。 */
  repulsionRadius?: number;
  /**
   * 斥力系数：单对节点的斥力位移 = repulsionStrength × 接触距离² ÷ 实际距离。
   * 位移与距离成反比：离得越远衰减越快，完全贴合时按接触距离托底。
   */
  repulsionStrength?: number;
  /** 理想边长（不含两端半径）。 */
  springLength?: number;
  /** 弹簧强度。 */
  springStrength?: number;
  /** 向心力（把散点拉回画布中部）。 */
  gravity?: number;
  /** 速度阻尼（0 = 无惯性，越接近 1 惯性越大；夹在 0~0.95）。 */
  damping?: number;
  /** 动能阈值：单帧最大位移低于该值即认为已收敛。 */
  settleThreshold?: number;
  /** 单帧位移上限，避免节点被弹飞出屏。 */
  maxDisplacement?: number;
  /** 本轮冻结不动的节点（增量布局时保住既有节点位置，避免整图重排）。 */
  fixedKeys?: Iterable<string>;
}

const DEFAULTS = {
  iterations: 1,
  repulsionRadius: 420,
  repulsionStrength: 0.5,
  springLength: 130,
  springStrength: 0.04,
  gravity: 0.012,
  // 实测（真实全景 13 节点 / 18 关系）：0.55 需要 462 轮收敛，0.6 只需 428 轮，
  // 且大图撞上轮数上限时的残余位移也更小（0.24 → 0.18），因此取 0.6。
  damping: 0.6,
  settleThreshold: 0.04,
  maxDisplacement: 46,
};

/** 接触距离的最小留白：斥力的「接触距离」= 两个节点半径 + 该值。 */
const CONTACT_PADDING = 10;
/** 节点完全重合时按接触距离的该比例计算斥力，避免 1/0 得到 Infinity。 */
const MIN_DISTANCE_RATIO = 0.6;
/**
 * 弹簧在接触距离附近平滑接入（接触距离的 0.6 倍处为 0、1.2 倍处满力）。
 * 硬开关会让节点在贴合的临界点反复跳变，形成无法收敛的极限环。
 */
const SPRING_ENGAGE_RATIO = 0.6;

interface ResolvedLayoutOptions extends Required<Omit<LayoutOptions, 'fixedKeys'>> {
  fixedKeys: ReadonlySet<string>;
}

const NO_FIXED_KEYS: ReadonlySet<string> = new Set<string>();

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function resolveOptions(options: LayoutOptions): ResolvedLayoutOptions {
  return {
    iterations: Math.max(1, Math.min(6, Math.round(finiteOr(options.iterations, DEFAULTS.iterations)))),
    repulsionRadius: Math.max(0, finiteOr(options.repulsionRadius, DEFAULTS.repulsionRadius)),
    repulsionStrength: Math.max(0, finiteOr(options.repulsionStrength, DEFAULTS.repulsionStrength)),
    springLength: Math.max(0, finiteOr(options.springLength, DEFAULTS.springLength)),
    springStrength: Math.max(0, finiteOr(options.springStrength, DEFAULTS.springStrength)),
    gravity: Math.max(0, finiteOr(options.gravity, DEFAULTS.gravity)),
    damping: Math.min(0.95, Math.max(0, finiteOr(options.damping, DEFAULTS.damping))),
    settleThreshold: Math.max(0, finiteOr(options.settleThreshold, DEFAULTS.settleThreshold)),
    maxDisplacement: Math.max(1, finiteOr(options.maxDisplacement, DEFAULTS.maxDisplacement)),
    fixedKeys: options.fixedKeys ? new Set(options.fixedKeys) : NO_FIXED_KEYS,
  };
}

export interface LayoutResult {
  positions: KgPositionMap;
  /** 本轮最大位移（用于判断收敛 / 停止重绘）。 */
  energy: number;
  settled: boolean;
}

/** 收敛结果：位置缓存仍然是同一份对象，额外给出实际迭代轮数与收敛状态。 */
export interface SettleResult {
  positions: KgPositionMap;
  /** 最后一轮的最大位移。 */
  energy: number;
  /** 是否达到收敛阈值（false 表示撞上了迭代上限，位置已被保留）。 */
  settled: boolean;
  /** 实际执行的 settle 轮数（每轮含 2 次迭代）。 */
  passes: number;
}

/** 分层权重：同一类型的节点在纵向上有期望层位，避免全景视图糊成一团。 */
const TYPE_BAND: Record<string, number> = { category: -180, archive: -20, file: 130, chunk: 260 };

function radiusOf(node: KgGraphNodeView): number {
  return nodeRadius(node.type, node.childCount);
}

/**
 * 单轮迭代：累加斥力 / 弹簧 / 向心力，再按速度阻尼积分出新位置。
 * positions 会被就地更新（调用方持有同一份缓存，主题切换 / 展开增补都不会丢位置）。
 */
export function stepLayout(graph: KgSubgraph, positions: KgPositionMap, options: LayoutOptions = {}): LayoutResult {
  const opts = resolveOptions(options);
  const nodes = graph.nodes;
  if (!nodes.length) return { positions, energy: 0, settled: true };

  const forceX = new Map<string, number>();
  const forceY = new Map<string, number>();
  let energy = 0;

  for (let pass = 0; pass < opts.iterations; pass += 1) {
    for (const node of nodes) {
      forceX.set(node.key, 0);
      forceY.set(node.key, 0);
    }
    accumulateRepulsion(nodes, positions, opts, forceX, forceY);
    accumulateSprings(graph, positions, opts, forceX, forceY);
    // 取本轮各次迭代的最大位移，保证返回的 energy 是整轮位移的上界（保守判收敛）
    energy = Math.max(energy, integrate(nodes, positions, opts, forceX, forceY));
  }

  return { positions, energy, settled: energy <= opts.settleThreshold };
}

/** 1) 斥力：位移与距离成反比；方向使用归一化向量，距离越远衰减越快。 */
function accumulateRepulsion(
  nodes: KgGraphNodeView[],
  positions: KgPositionMap,
  opts: ResolvedLayoutOptions,
  forceX: Map<string, number>,
  forceY: Map<string, number>,
): void {
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    const pa = positions.get(a.key);
    if (!pa) continue;
    const ra = radiusOf(a);
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      const pb = positions.get(b.key);
      if (!pb) continue;
      const vx = pa.x - pb.x;
      const vy = pa.y - pb.y;
      const distance = Math.hypot(vx, vy);
      // 作用半径之外不计算；边界处用线性衰减滑到 0，避免跨边界时力突变（产生极限环）
      if (!(distance < opts.repulsionRadius)) continue;
      const contact = ra + radiusOf(b) + CONTACT_PADDING;
      let unitX: number;
      let unitY: number;
      if (distance > 1e-6) {
        unitX = vx / distance;
        unitY = vy / distance;
      } else {
        // 完全重合：按 key 哈希给一个确定方向（可复现，不用随机数）
        const angle = hashAngle(`${a.key}|${b.key}`);
        unitX = Math.cos(angle);
        unitY = Math.sin(angle);
      }
      // 距离趋零时按接触距离托底：斥力有限且方向确定，不会出现 NaN / Infinity
      const effective = Math.max(distance, contact * MIN_DISTANCE_RATIO);
      const falloff = opts.repulsionRadius > 0 ? 1 - distance / opts.repulsionRadius : 0;
      const magnitude = (opts.repulsionStrength * contact * contact * falloff) / effective;
      forceX.set(a.key, (forceX.get(a.key) ?? 0) + unitX * magnitude);
      forceY.set(a.key, (forceY.get(a.key) ?? 0) + unitY * magnitude);
      forceX.set(b.key, (forceX.get(b.key) ?? 0) - unitX * magnitude);
      forceY.set(b.key, (forceY.get(b.key) ?? 0) - unitY * magnitude);
    }
  }
}

/** 2) 弹簧引力：端点齐全才生效；节点已贴在一起时交给斥力分开，弹簧不再回压。 */
function accumulateSprings(
  graph: KgSubgraph,
  positions: KgPositionMap,
  opts: ResolvedLayoutOptions,
  forceX: Map<string, number>,
  forceY: Map<string, number>,
): void {
  if (!graph.edges.length) return;
  const byKey = new Map(graph.nodes.map((node) => [node.key, node]));
  for (const edge of graph.edges) {
    const from = byKey.get(edge.from);
    const to = byKey.get(edge.to);
    if (!from || !to) continue;
    const pf = positions.get(from.key);
    const pt = positions.get(to.key);
    if (!pf || !pt) continue;
    const vx = pt.x - pf.x;
    const vy = pt.y - pf.y;
    const distance = Math.hypot(vx, vy);
    if (!(distance > 1e-6) || !Number.isFinite(distance)) continue; // 重合时方向未定义，留给斥力处理
    const contact = radiusOf(from) + radiusOf(to) + CONTACT_PADDING;
    const rest = opts.springLength + radiusOf(from) + radiusOf(to);
    const weight = Number.isFinite(edge.weight) ? Math.min(1, Math.max(0, edge.weight)) : 1;
    // 平滑接入：贴合的节点不会被弹簧直接硬拽回去，也不会在临界点跳变
    const engage = Math.min(1, Math.max(0, (distance - contact * SPRING_ENGAGE_RATIO) / Math.max(1, contact * SPRING_ENGAGE_RATIO)));
    if (engage <= 0) continue;
    const magnitude = (distance - rest) * opts.springStrength * (0.5 + weight * 0.5) * engage;
    const unitX = vx / distance;
    const unitY = vy / distance;
    forceX.set(from.key, (forceX.get(from.key) ?? 0) + unitX * magnitude);
    forceY.set(from.key, (forceY.get(from.key) ?? 0) + unitY * magnitude);
    forceX.set(to.key, (forceX.get(to.key) ?? 0) - unitX * magnitude);
    forceY.set(to.key, (forceY.get(to.key) ?? 0) - unitY * magnitude);
  }
}

/**
 * 3) 向心 + 分层 + 速度阻尼积分。
 * 返回本轮所有可动节点的最大位移；冻结（pinned / fixedKeys）节点速度清零且不参与位移。
 */
function integrate(
  nodes: KgGraphNodeView[],
  positions: KgPositionMap,
  opts: ResolvedLayoutOptions,
  forceX: Map<string, number>,
  forceY: Map<string, number>,
): number {
  let energy = 0;
  for (const node of nodes) {
    const point = positions.get(node.key);
    if (!point) continue;
    if (point.pinned || opts.fixedKeys.has(node.key)) {
      point.vx = 0;
      point.vy = 0;
      continue;
    }
    let shiftX = (forceX.get(node.key) ?? 0) - point.x * opts.gravity;
    let shiftY = (forceY.get(node.key) ?? 0) - point.y * opts.gravity;
    const band = TYPE_BAND[node.type];
    if (band !== undefined) shiftY += (band - point.y) * 0.008;
    if (!Number.isFinite(shiftX)) shiftX = 0;
    if (!Number.isFinite(shiftY)) shiftY = 0;

    let vx = (point.vx ?? 0) * opts.damping + shiftX;
    let vy = (point.vy ?? 0) * opts.damping + shiftY;
    const speed = Math.hypot(vx, vy);
    if (!Number.isFinite(speed)) {
      vx = 0;
      vy = 0;
    } else if (speed > opts.maxDisplacement) {
      vx = (vx / speed) * opts.maxDisplacement;
      vy = (vy / speed) * opts.maxDisplacement;
    }
    point.vx = vx;
    point.vy = vy;
    point.x += vx;
    point.y += vy;
    if (!Number.isFinite(point.x)) point.x = 0;
    if (!Number.isFinite(point.y)) point.y = 0;
    energy = Math.max(energy, Math.hypot(vx, vy));
  }
  return energy;
}

/**
 * 迭代到收敛（带轮数上限，避免大图死循环）。
 * 达到上限时如实返回 settled=false，并把当前节点位置原样保留，不继续无限计算。
 */
export function settleLayout(
  graph: KgSubgraph,
  positions: KgPositionMap,
  options: LayoutOptions & { maxPasses?: number } = {},
): SettleResult {
  const maxPasses = Math.max(1, Math.min(2000, Math.round(options.maxPasses ?? 120)));
  if (!graph.nodes.length) return { positions, energy: 0, settled: true, passes: 0 };
  let last: LayoutResult = { positions, energy: 0, settled: true };
  for (let pass = 0; pass < maxPasses; pass += 1) {
    last = stepLayout(graph, positions, { ...options, iterations: 2 });
    if (last.settled) return { positions, energy: last.energy, settled: true, passes: pass + 1 };
  }
  return { positions, energy: last.energy, settled: false, passes: maxPasses };
}

// ==================== 视口 / 命中 ====================

export function toScreen(transform: KgTransform, x: number, y: number): { x: number; y: number } {
  return { x: x * transform.scale + transform.tx, y: y * transform.scale + transform.ty };
}

export function toWorld(transform: KgTransform, x: number, y: number): { x: number; y: number } {
  return { x: (x - transform.tx) / transform.scale, y: (y - transform.ty) / transform.scale };
}

/** 缩放（围绕屏幕焦点），并夹在合理区间内，避免无限放大后画布空白。 */
export function zoomAt(transform: KgTransform, factor: number, focus: { x: number; y: number }, min = 0.25, max = 3): KgTransform {
  const scale = Math.min(max, Math.max(min, transform.scale * factor));
  const world = toWorld(transform, focus.x, focus.y);
  return { scale, tx: focus.x - world.x * scale, ty: focus.y - world.y * scale };
}

export function panBy(transform: KgTransform, dx: number, dy: number): KgTransform {
  return { scale: transform.scale, tx: transform.tx + dx, ty: transform.ty + dy };
}

/**
 * 视口尺寸变化（侧边栏收起/展开、窗口缩放）时的平移补偿：
 * 保持缩放比例与节点世界坐标不变，只把原视口中心对准新视口中心。
 * 这样画布扩宽/收窄时图谱不会甩到一侧，也绝不会触发重排或重新初始化节点位置。
 */
export function recenterTransform(
  transform: KgTransform,
  previous: { width: number; height: number },
  next: { width: number; height: number },
): KgTransform {
  // 首次测量（尺寸还是 0）时没有可补偿的中心，保持原变换由 fitView 负责
  if (previous.width <= 0 || previous.height <= 0) return transform;
  const dx = (next.width - previous.width) / 2;
  const dy = (next.height - previous.height) / 2;
  if (dx === 0 && dy === 0) return transform;
  return { scale: transform.scale, tx: transform.tx + dx, ty: transform.ty + dy };
}

/** 适配视图：把所有节点铺进视口并留出边距。 */
export function fitView(nodes: KgGraphNodeView[], positions: KgPositionMap, viewport: { width: number; height: number }, padding = 60): KgTransform {
  if (!nodes.length || viewport.width <= 0 || viewport.height <= 0) {
    return { scale: 1, tx: viewport.width / 2, ty: viewport.height / 2 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const point = positions.get(node.key);
    if (!point) continue;
    const r = radiusOf(node);
    minX = Math.min(minX, point.x - r);
    maxX = Math.max(maxX, point.x + r);
    minY = Math.min(minY, point.y - r);
    maxY = Math.max(maxY, point.y + r);
  }
  if (!Number.isFinite(minX)) return { scale: 1, tx: viewport.width / 2, ty: viewport.height / 2 };
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const scale = Math.min(2, Math.max(0.25, Math.min((viewport.width - padding * 2) / width, (viewport.height - padding * 2) / height)));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return { scale, tx: viewport.width / 2 - centerX * scale, ty: viewport.height / 2 - centerY * scale };
}

/** 定位某个节点到视口中心（搜索命中、右栏「定位」按钮共用）。 */
export function focusOn(
  transform: KgTransform,
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  scale?: number,
): KgTransform {
  const next = scale ?? Math.max(0.6, Math.min(1.6, transform.scale));
  return { scale: next, tx: viewport.width / 2 - point.x * next, ty: viewport.height / 2 - point.y * next };
}

/** 命中测试：倒序取最上层节点（半径按类型与子节点数真实计算）。 */
export function hitNode(
  nodes: KgGraphNodeView[],
  positions: KgPositionMap,
  world: { x: number; y: number },
): KgGraphNodeView | undefined {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    const point = positions.get(node.key);
    if (!point) continue;
    const r = radiusOf(node) + 4;
    if (Math.abs(world.x - point.x) <= r && Math.abs(world.y - point.y) <= r) return node;
  }
  return undefined;
}

/** 关系线命中测试：点到线段距离阈值内，取最近的一条（点击关系线查看关联依据）。 */
export function hitEdge(
  edges: KgGraphEdgeView[],
  positions: KgPositionMap,
  world: { x: number; y: number },
  threshold = 7,
): KgGraphEdgeView | undefined {
  let best: KgGraphEdgeView | undefined;
  let bestDistance = threshold;
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const distance = distanceToSegment(world, from, to);
    if (distance <= bestDistance) {
      bestDistance = distance;
      best = edge;
    }
  }
  return best;
}

function distanceToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSq = vx * vx + vy * vy;
  if (!lengthSq) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}
