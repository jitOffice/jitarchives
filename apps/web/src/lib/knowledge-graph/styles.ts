/**
 * 档案知识图谱 · 画布视觉映射（纯数据，供 Canvas 绘制、图例与自动化测试共用）。
 *
 * 四类节点用「形状 + 颜色 + 尺寸」三重区分，六种关系用「线型 + 颜色」区分：
 * 结构关系实线、内容关系细虚线、确定性关系点线，保证不看文字也能分辨来源。
 */
import type { KgEdgeType, KgNodeType } from './types.ts';

export interface KgNodeStyle {
  /** 节点中文名（图例与详情标题用）。 */
  label: string;
  /** 绘制形状。 */
  shape: 'square' | 'circle' | 'diamond' | 'hexagon';
  /** 基础半径（按 childCount 微调）。 */
  radius: number;
  /** 渐变中间色（兼容统计与图例取色）。 */
  fill: string;
  stroke: string;
  /** 文字颜色（画布上标签用）。 */
  text: string;
  /** 节点本体渐变起止色；只绘制渐变，不添加阴影或外发光。 */
  gradientStart: string;
  gradientEnd: string;
  /** 白色语义图标内部线条颜色。 */
  iconLine: string;
}

export interface KgEdgeStyle {
  label: string;
  color: string;
  /** 虚线段长（0 表示实线）。 */
  dash: number[];
  width: number;
  /** 是否绘制方向箭头（结构归属关系有方向）。 */
  arrow: boolean;
}

export interface KgPalette {
  background: string;
  grid: string;
  nodeText: string;
  nodeTextHalo: string;
  dimFill: string;
  dimStroke: string;
  highlightRing: string;
  selectRing: string;
  edgeText: string;
  hoverFill: string;
}

/** 明暗两套画布配色：与系统蓝白简约 UI 同源（主色 #165DFF）。 */
export const KG_PALETTES: Record<'light' | 'dark', KgPalette> = {
  light: {
    background: '#fbfdff',
    grid: 'rgba(65, 119, 205, 0.09)',
    nodeText: '#1d2129',
    nodeTextHalo: 'rgba(255, 255, 255, 0.92)',
    dimFill: 'rgba(242, 243, 245, 0.55)',
    dimStroke: 'rgba(134, 144, 156, 0.35)',
    highlightRing: '#165dff',
    selectRing: '#ff7d00',
    edgeText: '#4e5969',
    hoverFill: 'rgba(22, 93, 255, 0.08)',
  },
  dark: {
    background: '#17181a',
    grid: 'rgba(255, 255, 255, 0.05)',
    nodeText: '#e8eaed',
    nodeTextHalo: 'rgba(23, 24, 26, 0.9)',
    dimFill: 'rgba(255, 255, 255, 0.06)',
    dimStroke: 'rgba(255, 255, 255, 0.18)',
    highlightRing: '#6ea8ff',
    selectRing: '#ffb266',
    edgeText: '#b8bdc7',
    hoverFill: 'rgba(110, 168, 255, 0.14)',
  },
};

export const KG_NODE_STYLES: Record<KgNodeType, KgNodeStyle> = {
  category: {
    label: '档案分类',
    shape: 'square',
    radius: 25,
    fill: '#1678f5',
    stroke: '#0755df',
    text: '#0e4fe0',
    gradientStart: '#35a7ff',
    gradientEnd: '#0755e9',
    iconLine: '#0755e9',
  },
  archive: {
    label: '档案',
    shape: 'circle',
    radius: 22,
    fill: '#0bb39e',
    stroke: '#008f7d',
    text: '#0b7a70',
    gradientStart: '#25d2bc',
    gradientEnd: '#008f7d',
    iconLine: '#008f7d',
  },
  file: {
    label: '附件',
    shape: 'diamond',
    radius: 19,
    fill: '#f69a19',
    stroke: '#e66d00',
    text: '#c25a00',
    gradientStart: '#ffc15b',
    gradientEnd: '#f07800',
    iconLine: '#e66d00',
  },
  chunk: {
    label: '正文知识块',
    shape: 'hexagon',
    radius: 18,
    fill: '#9256ef',
    stroke: '#6d32d9',
    text: '#531dab',
    gradientStart: '#bd8bff',
    gradientEnd: '#6d32d9',
    iconLine: '#6d32d9',
  },
};

export const KG_EDGE_STYLES: Record<KgEdgeType, KgEdgeStyle> = {
  category_contains_archive: { label: '分类归属', color: '#165dff', dash: [], width: 1.4, arrow: true },
  archive_contains_file: { label: '档案包含附件', color: '#0f9d90', dash: [], width: 1.2, arrow: true },
  file_contains_chunk: { label: '附件切出知识块', color: '#722ed1', dash: [], width: 1, arrow: true },
  chunk_similar_to: { label: '正文相似', color: '#a5a9b5', dash: [4, 4], width: 1, arrow: false },
  archive_related_to: { label: '档案内容关联', color: '#ff7d00', dash: [8, 4], width: 1.8, arrow: false },
  archive_shared_reference: { label: '著录字段相同', color: '#f53f3f', dash: [2, 3], width: 1.6, arrow: false },
};

export const KG_NODE_TYPES: KgNodeType[] = ['category', 'archive', 'file', 'chunk'];
export const KG_EDGE_TYPES: KgEdgeType[] = [
  'category_contains_archive',
  'archive_contains_file',
  'file_contains_chunk',
  'chunk_similar_to',
  'archive_related_to',
  'archive_shared_reference',
];

export function nodeStyle(type: KgNodeType): KgNodeStyle {
  return KG_NODE_STYLES[type] ?? {
    label: type,
    shape: 'circle',
    radius: 10,
    fill: '#86909c',
    stroke: '#6b7280',
    text: '#4e5969',
    gradientStart: '#aeb6c2',
    gradientEnd: '#6b7280',
    iconLine: '#6b7280',
  };
}

export function edgeStyle(type: KgEdgeType): KgEdgeStyle {
  return KG_EDGE_STYLES[type] ?? { label: type, color: '#a5a9b5', dash: [3, 3], width: 1, arrow: false };
}

/** 节点半径：子节点越多越大（真实数量驱动，不使用随机值）。 */
export function nodeRadius(type: KgNodeType, childCount: number): number {
  const base = nodeStyle(type).radius;
  const extra = Math.min(8, Math.round(Math.sqrt(Math.max(0, childCount)) * 2));
  return base + (type === 'chunk' ? 0 : extra);
}

/** 关系线透明度：权重越高越实（权重来自后端真实相似度 / 结构固定 1）。 */
export function edgeAlpha(weight: number): number {
  if (!Number.isFinite(weight)) return 0.75;
  return Math.min(1, Math.max(0.25, 0.35 + weight * 0.65));
}
