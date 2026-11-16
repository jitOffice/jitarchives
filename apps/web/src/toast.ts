/**
 * 全局轻提示（Toast）与页面提示桥接。
 *
 * 设计约定：
 * - 所有「操作结果」类提示（保存成功、校验失败、接口错误等）统一显示在右上角浮层，
 *   短暂停留后自动消失，不再像页内横幅那样常驻占用布局（阶段二第五批后的体验修正）；
 * - 页面仍沿用 `error` / `notice` 两个 ref 的既有赋值写法，通过 useFlash 监听后转为浮层
 *   并立即清空，避免为一次体验调整去改动所有业务分支的赋值点；
 * - 加载中、页面级状态（如档案不存在、预览失败需要重试按钮）不属于瞬时提示，
 *   仍由页面自身渲染，不做自动消失。
 */
import { readonly, ref, watch } from 'vue';

export type ToastKind = 'error' | 'success' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  /** 自动关闭时长（毫秒）；0 表示不自动关闭。 */
  duration: number;
}

/** 同屏最多保留的提示条数，超出时挤掉最早的一条，避免遮挡页面内容。 */
const MAX_TOASTS = 4;
/** 默认停留时长：足够读完一句话，又不至于滞留。 */
const DEFAULT_DURATION = 3600;

const items = ref<ToastItem[]>([]);
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let seq = 0;

/** 供 ToastHost 渲染的只读列表。 */
export const toasts = readonly(items);

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  items.value = items.value.filter((t) => t.id !== id);
}

function scheduleDismiss(id: number, duration: number): void {
  if (duration <= 0) return;
  timers.set(
    id,
    setTimeout(() => dismissToast(id), duration),
  );
}

/**
 * 推送一条提示。
 * 相同类型且文案相同时不重复堆叠，而是重置该条的计时（连续点击同一操作仍能看到反馈）。
 */
export function notify(kind: ToastKind, text: string, duration = DEFAULT_DURATION): number {
  const message = String(text ?? '').trim();
  if (!message) return 0;
  const existing = items.value.find((t) => t.kind === kind && t.text === message);
  if (existing) {
    const timer = timers.get(existing.id);
    if (timer !== undefined) clearTimeout(timer);
    scheduleDismiss(existing.id, existing.duration);
    return existing.id;
  }
  const id = ++seq;
  items.value = [...items.value, { id, kind, text: message, duration }];
  if (items.value.length > MAX_TOASTS) dismissToast(items.value[0].id);
  scheduleDismiss(id, duration);
  return id;
}

export const notifyError = (text: string): number => notify('error', text);
export const notifySuccess = (text: string): number => notify('success', text);
export const notifyInfo = (text: string): number => notify('info', text);

/**
 * 页面瞬时提示桥接：保留 error / notice 的既有赋值写法，
 * 赋值后自动弹出浮层并立刻清空，因此页面内不再需要常驻横幅。
 */
export function useFlash() {
  const error = ref('');
  const notice = ref('');
  watch(error, (value) => {
    if (!value) return;
    notifyError(value);
    error.value = '';
  });
  watch(notice, (value) => {
    if (!value) return;
    notifySuccess(value);
    notice.value = '';
  });
  return { error, notice };
}
