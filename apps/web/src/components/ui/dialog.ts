/**
 * 命令式确认 / 输入对话框（替代 window.confirm / window.prompt）。
 *
 * 用法与原生一致，只是换成系统风格弹窗并返回 Promise：
 *   if (await confirmDialog({ message: '确认删除？', danger: true })) { ... }
 *   const note = await promptDialog({ title: '审核意见', required: true });
 *
 * - 同一时刻只展示一个对话框，后续请求自动排队，避免并发覆盖导致 Promise 悬挂；
 * - Esc / 遮罩 / 取消 都按「取消」处理（confirm 返回 false，prompt 返回 null）。
 */
import { ref } from 'vue';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title?: string;
  message?: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  maxlength?: number;
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export interface DialogState {
  kind: 'confirm' | 'prompt';
  confirm: ConfirmOptions | PromptOptions;
  prompt: PromptOptions | null;
  resolve: (value: boolean | string | null) => void;
}

/** 当前展示的对话框（DialogHost 渲染用）。 */
export const currentDialog = ref<DialogState | null>(null);

const queue: DialogState[] = [];

function enqueue(state: DialogState): void {
  if (currentDialog.value) {
    queue.push(state);
  } else {
    currentDialog.value = state;
  }
}

/** 结束当前对话框并让下一个排队项上屏。 */
export function settleDialog(value: boolean | string | null): void {
  const done = currentDialog.value;
  if (!done) return;
  currentDialog.value = queue.shift() ?? null;
  done.resolve(value);
}

export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const confirm = typeof options === 'string' ? { message: options } : options;
  return new Promise<boolean>((resolve) => {
    enqueue({
      kind: 'confirm',
      confirm,
      prompt: null,
      resolve: (value) => resolve(value === true),
    });
  });
}

export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    enqueue({
      kind: 'prompt',
      confirm: options,
      prompt: options,
      resolve: (value) => resolve(typeof value === 'string' ? value : null),
    });
  });
}
