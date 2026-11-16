<script setup lang="ts">
/**
 * 统一空状态 / 页级错误状态。
 * 替代各页面 `<p class="text-muted empty">…</p>` 与 DashboardView / SystemInfoView 的 state-card。
 */
withDefaults(
  defineProps<{
    /** default：暂无数据；error：加载失败（红色标题 + 重试按钮槽位） */
    variant?: 'default' | 'error';
    title?: string;
    description?: string;
    /** compact：表格内的紧凑占位；默认是卡片内的大块占位 */
    compact?: boolean;
  }>(),
  { variant: 'default', title: undefined, description: undefined, compact: false },
);
</script>

<template>
  <div
    class="ui-empty"
    :class="[`ui-empty--${variant}`, { 'is-compact': compact }]"
    :role="variant === 'error' ? 'alert' : 'status'"
  >
    <span class="ui-empty__icon" aria-hidden="true">
      <svg v-if="variant === 'error'" viewBox="0 0 24 24" width="22" height="22">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path d="M12 7.4v5.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        <circle cx="12" cy="16.4" r="1" fill="currentColor" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="22" height="22">
        <path
          d="M3.6 13.4l2.2-6.1a2 2 0 0 1 1.9-1.3h8.6a2 2 0 0 1 1.9 1.3l2.2 6.1v4.2a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2v-4.2z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linejoin="round"
        />
        <path d="M3.8 13.2h4.1l1.2 2.1h5.8l1.2-2.1h4.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
    </span>

    <p v-if="title" class="ui-empty__title">{{ title }}</p>
    <p v-if="description" class="ui-empty__desc">{{ description }}</p>
    <slot />
    <div v-if="$slots.action" class="ui-empty__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.ui-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 28px 16px;
  text-align: center;
  color: var(--text-muted);
}
.ui-empty.is-compact {
  padding: 16px 12px;
}

.ui-empty__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  margin-bottom: 2px;
  border-radius: 50%;
  background: #f5f6f8;
  color: var(--text-placeholder);
}
.ui-empty--error .ui-empty__icon {
  background: rgba(245, 63, 63, 0.08);
  color: var(--color-danger);
}
.ui-empty.is-compact .ui-empty__icon {
  width: 30px;
  height: 30px;
  margin-bottom: 0;
}
.ui-empty.is-compact .ui-empty__icon svg {
  width: 17px;
  height: 17px;
}

.ui-empty__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-body);
}
.ui-empty--error .ui-empty__title {
  color: var(--color-danger);
}
.ui-empty__desc {
  margin: 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-muted);
  white-space: pre-line;
  word-break: break-word;
}
.ui-empty__action {
  margin-top: 8px;
}

@media (max-width: 767px) {
  .ui-empty {
    padding: 22px 12px;
  }
}
</style>
