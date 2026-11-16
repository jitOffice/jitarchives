<script setup lang="ts">
/**
 * 全局提示容器（阶段二第五批体验修正）：
 * 固定显示在右上角，数秒后自动淡出，替代原先占位的页内横幅。
 * 仅负责展示与关闭，计时逻辑在 toast.ts 中统一维护。
 */
import { dismissToast, toasts, type ToastKind } from '../toast';

const ICON: Record<ToastKind, string> = {
  success: '✓',
  error: '!',
  info: 'i',
};
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" role="status" aria-live="polite">
      <TransitionGroup name="toast">
        <div v-for="t in toasts" :key="t.id" class="toast" :class="`toast-${t.kind}`">
          <span class="toast-icon">{{ ICON[t.kind] }}</span>
          <p class="toast-text">{{ t.text }}</p>
          <button class="toast-close" type="button" aria-label="关闭提示" @click="dismissToast(t.id)">
            ×
          </button>
          <span
            v-if="t.duration > 0"
            class="toast-progress"
            :style="{ animationDuration: `${t.duration}ms` }"
          ></span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  top: 72px;
  right: 20px;
  z-index: var(--z-toast);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
  pointer-events: none;
}

.toast {
  --toast-accent: var(--color-primary);
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 340px;
  max-width: calc(100vw - 40px);
  padding: 12px 14px 13px 13px;
  border: 1px solid var(--border-light);
  border-left: 3px solid var(--toast-accent);
  border-radius: 10px;
  background: #fff;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  pointer-events: auto;
}

.toast-error { --toast-accent: var(--color-danger); }
.toast-success { --toast-accent: var(--color-success); }
.toast-info { --toast-accent: var(--color-primary); }

.toast-icon {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 50%;
  background: var(--toast-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 700;
  line-height: 18px;
  text-align: center;
}

.toast-text {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--text-title);
  font-size: 13px;
  line-height: 20px;
  word-break: break-word;
}

.toast-close {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 18px;
  cursor: pointer;
  border-radius: 4px;
}

.toast-close:hover { background: #f2f3f5; color: var(--text-title); }

/* 倒计时进度条：直观表达「几秒后自动消失」 */
.toast-progress {
  position: absolute;
  left: 0;
  bottom: 0;
  height: 2px;
  width: 100%;
  background: var(--toast-accent);
  opacity: 0.35;
  transform-origin: left center;
  animation-name: toast-countdown;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

@keyframes toast-countdown {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.24s ease, transform 0.24s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

.toast-move {
  transition: transform 0.24s ease;
}

/* 移动端：提示条改为贴顶通栏，避开刘海与圆角 */
@media (max-width: 767px) {
  .toast-stack {
    top: calc(8px + env(safe-area-inset-top));
    left: 12px;
    right: 12px;
    align-items: stretch;
  }
  .toast {
    width: 100%;
    max-width: 100%;
  }
  /* 触屏上放大关闭按钮热区 */
  .toast-close {
    width: 26px;
    height: 26px;
  }
}
</style>
