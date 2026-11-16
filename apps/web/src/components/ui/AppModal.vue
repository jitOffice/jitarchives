<script setup lang="ts">
/**
 * 统一弹窗容器（替代各页面各写一套的 mask + modal）。
 *
 * 与旧实现的差异：
 * - 统一 `role="dialog"` / `aria-modal` / 标题关联，屏幕阅读器能正确播报；
 * - 打开时锁定页面滚动、把 Tab 循环限制在弹窗内，关闭后焦点回到触发元素；
 * - Esc 与遮罩点击均可关闭（可分别关闭），移动端自动转为底部抽屉；
 * - 头部 / 内容 / 底部结构统一，页面只需提供标题与底部按钮。
 */
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { focusables, lockBodyScroll, trapTab } from './overlay';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    subtitle?: string;
    width?: number | string;
    closeOnBackdrop?: boolean;
    closeOnEsc?: boolean;
    /** first：聚焦首个可交互元素；none：由调用方自行聚焦（命令式对话框用） */
    initialFocus?: 'first' | 'none';
  }>(),
  {
    title: undefined,
    subtitle: undefined,
    width: 560,
    closeOnBackdrop: true,
    closeOnEsc: true,
    initialFocus: 'first',
  },
);

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
  (event: 'close'): void;
}>();

const titleId = useId();
const dialogEl = ref<HTMLElement | null>(null);
let restoreFocus: HTMLElement | null = null;
let unlockScroll: (() => void) | null = null;

function requestClose(): void {
  emit('update:open', false);
  emit('close');
}

function onBackdrop(): void {
  if (props.closeOnBackdrop) requestClose();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (!props.closeOnEsc) return;
    event.preventDefault();
    requestClose();
    return;
  }
  if (dialogEl.value) trapTab(event, dialogEl.value);
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreFocus = document.activeElement as HTMLElement | null;
      unlockScroll = lockBodyScroll();
      await nextTick();
      if (props.initialFocus === 'none') return;
      const root = dialogEl.value;
      if (!root) return;
      const target = focusables(root).find((el) => !el.hasAttribute('data-autofocus-skip'));
      (target ?? root).focus();
    } else {
      unlockScroll?.();
      unlockScroll = null;
      restoreFocus?.focus?.();
      restoreFocus = null;
    }
  },
);

onBeforeUnmount(() => {
  unlockScroll?.();
  unlockScroll = null;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ui-modal">
      <div v-if="props.open" class="ui-modal-mask" @click.self="onBackdrop">
        <div
          ref="dialogEl"
          class="ui-modal"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="props.title ? titleId : undefined"
          :style="{ width: typeof props.width === 'number' ? `${props.width}px` : props.width }"
          tabindex="-1"
          @keydown="onKeydown"
        >
          <header v-if="props.title || props.subtitle || $slots.head" class="ui-modal__head">
            <slot name="head">
              <h3 v-if="props.title" :id="titleId" class="ui-modal__title">{{ props.title }}</h3>
              <p v-if="props.subtitle" class="ui-modal__sub">{{ props.subtitle }}</p>
            </slot>
          </header>

          <div class="ui-modal__body">
            <slot />
          </div>

          <footer v-if="$slots.footer" class="ui-modal__foot">
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-modal-mask {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.35);
}

.ui-modal {
  display: flex;
  flex-direction: column;
  max-width: 100%;
  max-height: 90vh;
  max-height: 90dvh;
  border-radius: var(--radius-card);
  background: var(--bg-card);
  box-shadow: var(--shadow-pop);
  outline: none;
  overflow: hidden;
}

.ui-modal__head {
  padding: 20px 24px 14px;
  border-bottom: 1px solid var(--border-light);
}
.ui-modal__head:empty {
  padding: 0;
  border-bottom: none;
}
.ui-modal__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-title);
}
.ui-modal__sub {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted);
}

.ui-modal__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 18px 24px;
  overflow: auto;
  font-size: 14px;
  color: var(--text-body);
}

.ui-modal__foot {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 24px;
  border-top: 1px solid var(--border-light);
  background: #fafbfc;
}

/* 进出场动画：淡入 + 轻微上浮，避免突兀 */
.ui-modal-enter-active,
.ui-modal-leave-active {
  transition: opacity 0.18s ease;
}
.ui-modal-enter-active .ui-modal,
.ui-modal-leave-active .ui-modal {
  transition: transform 0.18s ease, opacity 0.18s ease;
}
.ui-modal-enter-from,
.ui-modal-leave-to {
  opacity: 0;
}
.ui-modal-enter-from .ui-modal,
.ui-modal-leave-to .ui-modal {
  opacity: 0;
  transform: translateY(8px) scale(0.98);
}

/* 移动端：改为底部抽屉，底部按钮铺满并预留安全区 */
@media (max-width: 767px) {
  .ui-modal-mask {
    align-items: flex-end;
    padding: 0;
  }
  .ui-modal {
    width: 100% !important;
    max-height: 92vh;
    max-height: 92dvh;
    border-radius: 12px 12px 0 0;
  }
  .ui-modal__head {
    padding: 16px 16px 12px;
  }
  .ui-modal__body {
    padding: 14px 16px;
  }
  .ui-modal__foot {
    padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
    flex-wrap: wrap;
  }
  .ui-modal-enter-from .ui-modal,
  .ui-modal-leave-to .ui-modal {
    transform: translateY(24px);
  }
}
</style>
