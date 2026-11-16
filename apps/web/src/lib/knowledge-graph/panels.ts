/**
 * 档案知识图谱 · 左右侧边栏「收起 / 展开」状态（纯数据 + 纯函数，不依赖 Vue / DOM）。
 *
 * 只描述两个互相独立的布尔位：左侧「图谱概览」、右侧「节点详情」。
 * 任何操作都返回新对象，且只改被操作的那一侧——另一侧永远原样保留，
 * 因此「收左侧不动右侧」「两侧同时收起」「两侧同时展开」由类型层面直接保证。
 */

export type KgPanelSide = 'overview' | 'detail';

export interface KgPanelState {
  /** 左侧「图谱概览」面板是否收起。 */
  left: boolean;
  /** 右侧「节点详情」面板是否收起。 */
  right: boolean;
}

/** 初始状态：两侧都展开（桌面端三栏常驻）。 */
export function initialPanelState(): KgPanelState {
  return { left: false, right: false };
}

export function isPanelCollapsed(state: KgPanelState, side: KgPanelSide): boolean {
  return side === 'overview' ? state.left : state.right;
}

/** 收起某一侧（另一侧保持不变）。 */
export function collapsePanelSide(state: KgPanelState, side: KgPanelSide): KgPanelState {
  return side === 'overview' ? { ...state, left: true } : { ...state, right: true };
}

/** 展开某一侧（另一侧保持不变）。 */
export function expandPanelSide(state: KgPanelState, side: KgPanelSide): KgPanelState {
  return side === 'overview' ? { ...state, left: false } : { ...state, right: false };
}

/** 切换某一侧；另一侧仍保持不变。 */
export function togglePanelSide(state: KgPanelState, side: KgPanelSide): KgPanelState {
  return isPanelCollapsed(state, side) ? expandPanelSide(state, side) : collapsePanelSide(state, side);
}

/** 移动端抽屉打开时，同侧面板必须恢复展开，否则抽屉里只剩一条收起入口。 */
export function ensurePanelExpanded(state: KgPanelState, side: KgPanelSide): KgPanelState {
  return isPanelCollapsed(state, side) ? expandPanelSide(state, side) : state;
}
