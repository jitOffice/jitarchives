/**
 * 浮层公共能力（下拉面板 / 日期面板 / 弹窗复用）。
 *
 * 这三类浮层都需要「滚动锁、Tab 焦点陷阱、点击外部关闭、浮层定位」四件事，
 * 统一放在这里，避免每个组件各写一份，行为与视觉才可能真正一致。
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** body 滚动锁：引用计数，支持弹窗内再开浮层。 */
let lockCount = 0;
let previousOverflow = '';

export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (lockCount === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  lockCount += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount = Math.max(0, lockCount - 1);
    if (lockCount === 0) document.body.style.overflow = previousOverflow;
  };
}

/** 容器内可聚焦元素（排除隐藏节点）。 */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

/** 把 Tab 循环限制在容器内，弹窗打开后焦点不会跑到背后的页面。 */
export function trapTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== 'Tab') return;
  const list = focusables(root);
  if (list.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = active !== null && root.contains(active);

  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !inside)) {
    event.preventDefault();
    first.focus();
  }
}

/** 点击浮层与触发器以外的位置时触发（捕获阶段，先于业务 click）。 */
export function onOutsidePointerDown(
  inside: () => Array<HTMLElement | null | undefined>,
  handler: () => void,
): () => void {
  const listener = (event: Event) => {
    const target = event.target as Node | null;
    if (!target) return;
    const hit = inside().some((el) => el && el.contains(target));
    if (!hit) handler();
  };
  document.addEventListener('pointerdown', listener, true);
  return () => document.removeEventListener('pointerdown', listener, true);
}

export interface PanelPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'bottom' | 'top';
}

/**
 * 依据触发器位置计算 fixed 浮层坐标：
 * 下方空间不足时向上翻转；宽高都限制在视口内，避免被窄屏裁掉。
 */
export function placePanel(
  trigger: DOMRect,
  panelHeight: number,
  options: { gap?: number; minWidth?: number; maxHeight?: number } = {},
): PanelPlacement {
  const gap = options.gap ?? 6;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const maxHeightLimit = options.maxHeight ?? 320;

  const spaceBelow = viewportHeight - trigger.bottom - gap - 8;
  const spaceAbove = trigger.top - gap - 8;
  const placement: 'bottom' | 'top' =
    spaceBelow >= Math.min(panelHeight, maxHeightLimit) || spaceBelow >= spaceAbove ? 'bottom' : 'top';

  const available = Math.max(120, placement === 'bottom' ? spaceBelow : spaceAbove);
  const maxHeight = Math.min(maxHeightLimit, available);

  const width = Math.min(
    Math.max(trigger.width, options.minWidth ?? 0, 120),
    viewportWidth - 16,
  );
  const left = Math.min(Math.max(8, trigger.left), Math.max(8, viewportWidth - width - 8));
  const top = placement === 'bottom' ? trigger.bottom + gap : Math.max(8, trigger.top - gap - Math.min(panelHeight, maxHeight));

  return { top, left, width, maxHeight, placement };
}
