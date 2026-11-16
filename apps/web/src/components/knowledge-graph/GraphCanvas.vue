<script setup lang="ts">
/**
 * 图谱关系网络画布（Canvas 2D + 力导向）。
 *
 * - 数据全部由父级传入（后端真实节点/关系），本组件不生成任何节点或关系；
 * - 支持滚轮缩放、拖拽平移、节点拖动、单击选中、双击展开、关系线点击查看依据；
 * - 布局由 store 在拓扑变化时一次性算完并写入位置缓存，画布只负责绘制；
 *   重绘请求会合并成单帧（见 frameLoop.ts），画完即停，不存在持续 RAF 动画；
 * - 触控：单指拖动平移、双指缩放、点按选中、双极点按展开。
 */
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import type { KgGraphEdgeView, KgGraphNodeView } from '../../lib/knowledge-graph/types.ts';
import { edgeAlpha, edgeStyle, KG_PALETTES, nodeRadius, nodeStyle } from '../../lib/knowledge-graph/styles.ts';
import type { KgPoint } from '../../lib/knowledge-graph/subgraph.ts';
import { createFrameLoop } from '../../lib/knowledge-graph/frameLoop.ts';
import {
  fitView,
  focusOn,
  hitEdge,
  hitNode,
  panBy,
  recenterTransform,
  toWorld,
  zoomAt,
  type KgTransform,
} from '../../lib/knowledge-graph/forceLayout.ts';

const props = defineProps<{
  nodes: KgGraphNodeView[];
  edges: KgGraphEdgeView[];
  positions: Map<string, KgPoint>;
  selectedKey: string | null;
  selectedEdgeId: number | null;
  highlight: { nodes: Set<string>; edges: Set<number> };
  theme: 'light' | 'dark';
  /** 外部请求聚焦（搜索命中定位）。 */
  focusKey?: string | null;
  /** 外部请求重置视图，数值变化即触发。 */
  resetToken?: number;
  loading?: boolean;
}>();

const emit = defineEmits<{
  select: [node: KgGraphNodeView];
  selectEdge: [edge: KgGraphEdgeView];
  expand: [node: KgGraphNodeView];
}>();

const host = shallowRef<HTMLDivElement | null>(null);
const canvas = shallowRef<HTMLCanvasElement | null>(null);
const transform = shallowRef<KgTransform>({ scale: 1, tx: 0, ty: 0 });
const hovered = shallowRef<string | null>(null);
const viewport = shallowRef({ width: 0, height: 0 });

const palette = computed(() => KG_PALETTES[props.theme] ?? KG_PALETTES.light);

let drag:
  | { mode: 'pan'; lastX: number; lastY: number }
  | { mode: 'node'; key: string; lastX: number; lastY: number; moved: boolean }
  | { mode: 'pinch'; distance: number; center: { x: number; y: number } }
  | null = null;
let lastTap = { key: '', at: 0 };

/** 重绘调度：同一帧内多次请求只会排一次，画完即停（不会自我续期）。 */
const frames = createFrameLoop(() => draw());

function scheduleDraw(): void {
  frames.request();
}

/** 节点到屏幕中心的一次性聚焦（搜索命中 / 右栏定位）。 */
function focusNodeKey(key: string): void {
  const point = props.positions.get(key);
  if (!point) return;
  transform.value = focusOn(transform.value, point, viewport.value, Math.max(0.8, Math.min(1.4, transform.value.scale)));
  scheduleDraw();
}

watch(
  () => props.focusKey,
  (key) => {
    if (key) focusNodeKey(key);
  },
);

watch(
  () => props.resetToken,
  () => {
    transform.value = fitView(props.nodes, props.positions, viewport.value);
    scheduleDraw();
  },
);

/** 拓扑变化（首次入图 / 展开子图）：store 已完成布局，这里只重绘一次。 */
watch(
  () => props.nodes,
  (nodes, previous) => {
    const first = (!previous || previous.length === 0) && nodes.length > 0;
    if (first) transform.value = fitView(nodes, props.positions, viewport.value);
    scheduleDraw();
  },
);

watch(
  () => props.edges,
  () => scheduleDraw(),
);

// 选中 / 高亮 / 主题 / 尺寸：只重绘，不重算布局
watch(
  () => [props.selectedKey, props.selectedEdgeId, props.highlight],
  () => scheduleDraw(),
);

watch(
  () => props.theme,
  () => scheduleDraw(),
);

// ==================== 绘制 ====================

function draw(): void {
  const el = canvas.value;
  const ctx = el?.getContext('2d');
  if (!el || !ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { width, height } = viewport.value;
  if (el.width !== Math.round(width * dpr) || el.height !== Math.round(height * dpr)) {
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
  }
  const t = transform.value;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = palette.value.background;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height, t);

  ctx.setTransform(dpr * t.scale, 0, 0, dpr * t.scale, dpr * t.tx, dpr * t.ty);
  ctx.lineCap = 'round';

  // 保持整张关系网络清晰可读；选中状态通过描边强调，不把其他节点整体压暗。
  for (const edge of props.edges) drawEdge(ctx, edge, t.scale);
  for (const node of props.nodes) drawNode(ctx, node, t.scale);
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, t: KgTransform): void {
  const step = 48 * t.scale;
  if (step < 14) return;
  ctx.save();
  ctx.strokeStyle = palette.value.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = ((t.tx % step) + step) % step; x < width; x += step) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = ((t.ty % step) + step) % step; y < height; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  ctx.restore();
}

function drawEdge(ctx: CanvasRenderingContext2D, edge: KgGraphEdgeView, scale: number): void {
  const from = props.positions.get(edge.from);
  const to = props.positions.get(edge.to);
  if (!from || !to) return;
  const style = edgeStyle(edge.type);
  const active = props.highlight.edges.has(edge.id) || props.selectedEdgeId === edge.id;
  const alpha = active ? 1 : Math.max(0.48, edgeAlpha(edge.weight));
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = active ? palette.value.highlightRing : style.color;
  ctx.lineWidth = (active ? style.width + 1 : style.width) / scale;
  if (style.dash.length) ctx.setLineDash(style.dash.map((v) => v / scale));
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  if (style.arrow) drawArrow(ctx, from, to, scale);
  if (props.selectedEdgeId === edge.id) drawEdgeLabel(ctx, from, to, edge.reason ?? style.label, scale);
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, from: KgPoint, to: KgPoint, scale: number): void {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 6 / scale;
  const tipX = to.x - Math.cos(angle) * (12 / scale);
  const tipY = to.y - Math.sin(angle) * (12 / scale);
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX - Math.cos(angle - 0.4) * size, tipY - Math.sin(angle - 0.4) * size);
  ctx.lineTo(tipX - Math.cos(angle + 0.4) * size, tipY - Math.sin(angle + 0.4) * size);
  ctx.closePath();
  ctx.fill();
}

function drawEdgeLabel(ctx: CanvasRenderingContext2D, from: KgPoint, to: KgPoint, text: string, scale: number): void {
  const x = (from.x + to.x) / 2;
  const y = (from.y + to.y) / 2;
  ctx.save();
  ctx.font = `${12 / scale}px -apple-system, "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = ctx.measureText(text).width + 10 / scale;
  ctx.fillStyle = palette.value.background;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(x - width / 2, y - 9 / scale, width, 18 / scale);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.value.edgeText;
  ctx.fillText(text, x, y);
  ctx.restore();
}

function drawNode(ctx: CanvasRenderingContext2D, node: KgGraphNodeView, scale: number): void {
  const point = props.positions.get(node.key);
  if (!point) return;
  const style = nodeStyle(node.type);
  const radius = nodeRadius(node.type, node.childCount);
  const selected = props.selectedKey === node.key;
  const near = props.highlight.nodes.has(node.key);
  const emphasized = selected || near || hovered.value === node.key;
  ctx.save();
  ctx.globalAlpha = 1;

  // 仅使用节点内部渐变，不添加 shadowBlur、投影或外发光。
  const gradient = ctx.createLinearGradient(point.x - radius, point.y - radius, point.x + radius, point.y + radius);
  gradient.addColorStop(0, style.gradientStart);
  gradient.addColorStop(1, style.gradientEnd);
  ctx.fillStyle = gradient;
  ctx.strokeStyle = selected ? palette.value.selectRing : style.stroke;
  ctx.lineWidth = (selected ? 3 : emphasized ? 2.5 : 1.8) / scale;
  tracePath(ctx, style.shape, point.x, point.y, radius);
  ctx.fill();
  ctx.stroke();

  drawNodeGlyph(ctx, node.type, point.x, point.y, radius, style.iconLine);

  if (node.expandable) {
    // 未展开的下层数量：真实 childCount，提示可双击继续展开
    ctx.globalAlpha = 1;
    ctx.fillStyle = style.stroke;
    ctx.beginPath();
    ctx.arc(point.x + radius * 0.8, point.y - radius * 0.8, 9 / Math.max(0.6, scale), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `${10 / Math.max(0.6, scale)}px -apple-system, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(node.childCount), point.x + radius * 0.8, point.y - radius * 0.8);
  }
  if (scale > 0.55 || selected || near || hovered.value === node.key) drawLabel(ctx, node, point, radius, style.text, scale);
  ctx.restore();
}

/** 四类节点的白色语义图标；图形直接绘制在节点渐变内部，不使用图片或发光滤镜。 */
function drawNodeGlyph(
  ctx: CanvasRenderingContext2D,
  type: KgGraphNodeView['type'],
  x: number,
  y: number,
  radius: number,
  detailColor: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  const iconSize = Math.min(30, Math.max(23, radius * 1.2));
  ctx.scale(iconSize / 24, iconSize / 24);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (type === 'category') {
    // 分层文件夹：表示档案分类与层级目录。
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.beginPath();
    ctx.moveTo(-9, -8);
    ctx.lineTo(-2, -8);
    ctx.lineTo(0, -5);
    ctx.lineTo(8, -5);
    ctx.quadraticCurveTo(10, -5, 10, -3);
    ctx.lineTo(10, 4);
    ctx.lineTo(-9, 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(-10, -3);
    ctx.lineTo(-2, -3);
    ctx.lineTo(0, -1);
    ctx.lineTo(10, -1);
    ctx.quadraticCurveTo(11, -1, 10.5, 1);
    ctx.lineTo(9, 8);
    ctx.quadraticCurveTo(8.8, 10, 7, 10);
    ctx.lineTo(-8, 10);
    ctx.quadraticCurveTo(-10, 10, -10, 8);
    ctx.lineTo(-10, -1);
    ctx.quadraticCurveTo(-10, -3, -8, -3);
    ctx.closePath();
    ctx.fill();
  } else if (type === 'archive') {
    // 折角文档：表示一份正式档案。
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(-7, -10);
    ctx.lineTo(3, -10);
    ctx.lineTo(8, -5);
    ctx.lineTo(8, 8);
    ctx.quadraticCurveTo(8, 10, 6, 10);
    ctx.lineTo(-6, 10);
    ctx.quadraticCurveTo(-8, 10, -8, 8);
    ctx.lineTo(-8, -8);
    ctx.quadraticCurveTo(-8, -10, -7, -10);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = detailColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(3, -10);
    ctx.lineTo(3, -5);
    ctx.lineTo(8, -5);
    ctx.moveTo(-4, -1);
    ctx.lineTo(4, -1);
    ctx.moveTo(-4, 3);
    ctx.lineTo(4, 3);
    ctx.moveTo(-4, 7);
    ctx.lineTo(1, 7);
    ctx.stroke();
  } else if (type === 'file') {
    // 回形针：表示档案附件。
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.7;
    ctx.beginPath();
    ctx.moveTo(2, -9);
    ctx.bezierCurveTo(8, -9, 9, -2, 5, 2);
    ctx.lineTo(-3, 10);
    ctx.bezierCurveTo(-8, 14, -13, 8, -9, 3);
    ctx.lineTo(1, -7);
    ctx.bezierCurveTo(4, -10, 8, -6, 5, -3);
    ctx.lineTo(-4, 6);
    ctx.stroke();
  } else {
    // 引文卡片：表示从附件正文提取的知识片段。
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(5, -7);
    ctx.lineTo(8, -7);
    ctx.quadraticCurveTo(10, -7, 10, -5);
    ctx.lineTo(10, 8);
    ctx.quadraticCurveTo(10, 10, 8, 10);
    ctx.stroke();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(-8, -9);
    ctx.quadraticCurveTo(-8, -11, -6, -11);
    ctx.lineTo(3, -11);
    ctx.lineTo(7, -7);
    ctx.lineTo(7, 8);
    ctx.quadraticCurveTo(7, 10, 5, 10);
    ctx.lineTo(-6, 10);
    ctx.quadraticCurveTo(-8, 10, -8, 8);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = detailColor;
    ctx.font = 'bold 12px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('“', -5, -3);
    ctx.fillText('“', 0, -3);
    ctx.strokeStyle = detailColor;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-4, 4);
    ctx.lineTo(4, 4);
    ctx.moveTo(-4, 7);
    ctx.lineTo(2, 7);
    ctx.stroke();
  }

  ctx.restore();
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  node: KgGraphNodeView,
  point: KgPoint,
  radius: number,
  color: string,
  scale: number,
): void {
  const text = clip(node.label, node.type === 'chunk' ? 12 : 16);
  ctx.save();
  ctx.font = `600 ${(node.type === 'chunk' ? 12 : 13) / scale}px -apple-system, "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const y = point.y + radius + 4 / scale;
  ctx.lineWidth = 3 / scale;
  ctx.strokeStyle = palette.value.nodeTextHalo;
  ctx.fillStyle = palette.value.nodeText;
  ctx.strokeText(text, point.x, y);
  ctx.fillText(text, point.x, y);
  ctx.restore();
  void color;
}

function tracePath(ctx: CanvasRenderingContext2D, shape: string, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (shape === 'circle') {
    ctx.arc(x, y, r, 0, Math.PI * 2);
    return;
  }
  if (shape === 'square') {
    const corner = Math.max(2, r * 0.22);
    ctx.moveTo(x - r + corner, y - r);
    ctx.lineTo(x + r - corner, y - r);
    ctx.quadraticCurveTo(x + r, y - r, x + r, y - r + corner);
    ctx.lineTo(x + r, y + r - corner);
    ctx.quadraticCurveTo(x + r, y + r, x + r - corner, y + r);
    ctx.lineTo(x - r + corner, y + r);
    ctx.quadraticCurveTo(x - r, y + r, x - r, y + r - corner);
    ctx.lineTo(x - r, y - r + corner);
    ctx.quadraticCurveTo(x - r, y - r, x - r + corner, y - r);
    ctx.closePath();
    return;
  }

  const sides = shape === 'diamond' ? 4 : 6;
  const offset = shape === 'diamond' ? 0 : Math.PI / 6;
  const points = Array.from({ length: sides }, (_, index) => {
    const angle = offset + (Math.PI * 2 * index) / sides;
    return { x: x + Math.cos(angle) * r, y: y + Math.sin(angle) * r };
  });
  traceRoundedPolygon(ctx, points, Math.max(1.8, r * (shape === 'diamond' ? 0.16 : 0.12)));
}

function traceRoundedPolygon(
  ctx: CanvasRenderingContext2D,
  points: Array<{ x: number; y: number }>,
  cornerRadius: number,
): void {
  if (points.length < 3) return;
  const starts = points.map((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const length = Math.hypot(previous.x - point.x, previous.y - point.y);
    const distance = Math.min(cornerRadius, length * 0.35);
    return {
      x: point.x + ((previous.x - point.x) / length) * distance,
      y: point.y + ((previous.y - point.y) / length) * distance,
    };
  });
  const ends = points.map((point, index) => {
    const next = points[(index + 1) % points.length];
    const length = Math.hypot(next.x - point.x, next.y - point.y);
    const distance = Math.min(cornerRadius, length * 0.35);
    return {
      x: point.x + ((next.x - point.x) / length) * distance,
      y: point.y + ((next.y - point.y) / length) * distance,
    };
  });

  ctx.moveTo(starts[0].x, starts[0].y);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    ctx.lineTo(starts[index].x, starts[index].y);
    ctx.quadraticCurveTo(point.x, point.y, ends[index].x, ends[index].y);
    const nextStart = starts[(index + 1) % points.length];
    ctx.lineTo(nextStart.x, nextStart.y);
  }
  ctx.closePath();
}

function clip(text: string, max: number): string {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ==================== 交互 ====================

function localPoint(e: MouseEvent | Touch): { x: number; y: number } {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function nodeAt(x: number, y: number): KgGraphNodeView | undefined {
  return hitNode(props.nodes, props.positions, toWorld(transform.value, x, y));
}

function edgeAt(x: number, y: number): KgGraphEdgeView | undefined {
  return hitEdge(props.edges, props.positions, toWorld(transform.value, x, y), 8 / transform.value.scale);
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  const p = localPoint(e);
  transform.value = zoomAt(transform.value, e.deltaY < 0 ? 1.12 : 1 / 1.12, p);
  scheduleDraw();
}

function onMouseDown(e: MouseEvent): void {
  const p = localPoint(e);
  const node = nodeAt(p.x, p.y);
  if (node) {
    drag = { mode: 'node', key: node.key, lastX: p.x, lastY: p.y, moved: false };
    return;
  }
  drag = { mode: 'pan', lastX: p.x, lastY: p.y };
}

function onMouseMove(e: MouseEvent): void {
  const p = localPoint(e);
  if (drag?.mode === 'pan') {
    transform.value = panBy(transform.value, p.x - drag.lastX, p.y - drag.lastY);
    drag.lastX = p.x;
    drag.lastY = p.y;
    scheduleDraw();
    return;
  }
  if (drag?.mode === 'node') {
    const point = props.positions.get(drag.key);
    if (point) {
      const world = toWorld(transform.value, p.x, p.y);
      drag.moved = drag.moved || Math.hypot(p.x - drag.lastX, p.y - drag.lastY) > 2;
      // 拖动即固定：松手后不会被后续布局搬回去（速度清零，避免残留惯性）
      if (drag.moved) point.pinned = true;
      point.x = world.x;
      point.y = world.y;
      point.vx = 0;
      point.vy = 0;
    }
    drag.lastX = p.x;
    drag.lastY = p.y;
    scheduleDraw();
    return;
  }
  const node = nodeAt(p.x, p.y);
  const next = node?.key ?? null;
  if (next !== hovered.value) hovered.value = next;
  if (canvas.value) canvas.value.style.cursor = node ? 'pointer' : 'grab';
  scheduleDraw();
}

function onMouseUp(e: MouseEvent): void {
  const p = localPoint(e);
  const active = drag;
  if (active?.mode === 'node') {
    const node = props.nodes.find((item) => item.key === active.key);
    if (!active.moved && node) emit('select', node);
  } else if (active?.mode === 'pan') {
    // 在空白处松手且几乎没移动：视为点击空白，取消选中
    const edge = edgeAt(p.x, p.y);
    if (edge) emit('selectEdge', edge);
  }
  drag = null;
  scheduleDraw();
}

function onDblClick(e: MouseEvent): void {
  const p = localPoint(e);
  const node = nodeAt(p.x, p.y);
  if (node) emit('expand', node);
}

function onTouchStart(e: TouchEvent): void {
  if (e.touches.length === 2) {
    const [a, b] = [e.touches[0], e.touches[1]];
    drag = { mode: 'pinch', distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), center: localPoint(a) };
    return;
  }
  const p = localPoint(e.touches[0]);
  const node = nodeAt(p.x, p.y);
  if (node) {
    drag = { mode: 'node', key: node.key, lastX: p.x, lastY: p.y, moved: false };
  } else {
    drag = { mode: 'pan', lastX: p.x, lastY: p.y };
  }
}

function onTouchMove(e: TouchEvent): void {
  if (e.touches.length === 2 && drag?.mode === 'pinch') {
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const factor = distance / Math.max(1, drag.distance);
    const center = localPoint(a);
    transform.value = zoomAt(transform.value, factor, center);
    drag.distance = distance;
    scheduleDraw();
    return;
  }
  const p = localPoint(e.touches[0]);
  if (drag?.mode === 'pan') {
    transform.value = panBy(transform.value, p.x - drag.lastX, p.y - drag.lastY);
    drag.lastX = p.x;
    drag.lastY = p.y;
    scheduleDraw();
  } else if (drag?.mode === 'node') {
    e.preventDefault();
    const point = props.positions.get(drag.key);
    if (point) {
      const world = toWorld(transform.value, p.x, p.y);
      point.x = world.x;
      point.y = world.y;
      point.vx = 0;
      point.vy = 0;
      point.pinned = true;
      drag.moved = true;
    }
    scheduleDraw();
  }
}

function onTouchEnd(e: TouchEvent): void {
  const active = drag;
  if (active?.mode === 'node' && !active.moved) {
    const node = props.nodes.find((item) => item.key === active.key);
    const now = Date.now();
    if (node && lastTap.key === node.key && now - lastTap.at < 320) {
      emit('expand', node);
      lastTap = { key: '', at: 0 };
    } else if (node) {
      emit('select', node);
      lastTap = { key: node.key, at: now };
    }
  }
  drag = null;
  void e;
}

function onResize(): void {
  const el = host.value;
  if (!el) return;
  const next = { width: el.clientWidth, height: el.clientHeight };
  const previous = viewport.value;
  if (next.width === previous.width && next.height === previous.height) return;
  // 侧边栏收起/展开只会改变可用尺寸：只做视口平移补偿 + 重绘，
  // 节点坐标、用户拖动位置和缩放比例全部保留，不做任何重新布局。
  transform.value = recenterTransform(transform.value, previous, next);
  viewport.value = next;
  scheduleDraw();
}

let observer: ResizeObserver | null = null;

onMounted(() => {
  const el = host.value;
  if (!el) return;
  viewport.value = { width: el.clientWidth, height: el.clientHeight };
  transform.value = fitView(props.nodes, props.positions, viewport.value);
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => onResize());
    observer.observe(el);
  } else {
    window.addEventListener('resize', onResize);
  }
  // store 已在本批节点上完成布局，首次挂载只画一帧，不再重新初始化位置
  scheduleDraw();
});

onBeforeUnmount(() => {
  // 取消待执行的重绘帧，避免卸载后残留动画任务
  frames.cancel();
  observer?.disconnect();
  observer = null;
  window.removeEventListener('resize', onResize);
  drag = null;
});

defineExpose({
  focusNodeKey,
  resetView: () => {
    transform.value = fitView(props.nodes, props.positions, viewport.value);
    scheduleDraw();
  },
  /** 重绘统计（自动化测试用）：pending=false 说明没有挂起的动画任务。 */
  frameStats: () => frames.stats(),
});
</script>

<template>
  <div ref="host" class="kg-canvas-host" data-testid="kg-canvas-host">
    <canvas
      ref="canvas"
      class="kg-canvas"
      data-testid="kg-canvas"
      role="img"
      aria-label="档案知识图谱关系网络：节点为分类、档案、附件与正文知识块，连线为它们之间的真实关系"
      @wheel="onWheel"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="drag = null"
      @dblclick="onDblClick"
      @touchstart.passive="onTouchStart"
      @touchmove="onTouchMove"
      @touchend="onTouchEnd"
    ></canvas>
    <div class="kg-canvas-tip" data-testid="kg-canvas-tip">单击节点查看详情 · 双击展开下一层 · 滚轮缩放 · 空白处拖动平移</div>
    <div v-if="loading" class="kg-canvas-mask" data-testid="kg-canvas-loading">
      <span class="kg-spinner" aria-hidden="true"></span>
      <span>正在加载图谱数据…</span>
    </div>
    <slot name="overlay" />
  </div>
</template>

<style scoped>
.kg-canvas-host {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
  overflow: hidden;
  background: var(--kg-bg, #fff);
  border-radius: var(--radius-card, 12px);
}
.kg-canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
  cursor: grab;
}
.kg-canvas-tip {
  position: absolute;
  left: 12px;
  bottom: 10px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--kg-muted, #86909c);
  background: var(--kg-tip-bg, rgba(255, 255, 255, 0.82));
  border: 1px solid var(--kg-border, #f2f3f5);
  border-radius: 20px;
  pointer-events: none;
}
.kg-canvas-mask {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  color: var(--kg-muted, #86909c);
  background: var(--kg-mask-bg, rgba(255, 255, 255, 0.66));
}
.kg-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--kg-border, #dfe3e8);
  border-top-color: var(--color-primary, #165dff);
  border-radius: 50%;
  animation: kg-spin 0.8s linear infinite;
}
@keyframes kg-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
