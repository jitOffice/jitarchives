<script setup lang="ts">
/**
 * 统一加载态：转圈 + 文案。
 * 替代各页面 `<span class="badge">加载中…</span>` 与 DashboardView / SystemInfoView 的 state-card 加载块。
 */
withDefaults(
  defineProps<{
    text?: string;
    size?: 'sm' | 'md';
    /** inline：与标题同行；默认整块居中（页面级加载） */
    inline?: boolean;
  }>(),
  { text: '加载中…', size: 'sm', inline: false },
);
</script>

<template>
  <div
    class="ui-loading"
    :class="[{ 'is-inline': inline }, `ui-loading--${size}`]"
    role="status"
    aria-live="polite"
  >
    <span class="ui-spinner" :class="{ 'ui-spinner--sm': size === 'sm' }" aria-hidden="true"></span>
    <span v-if="text" class="ui-loading__text">{{ text }}</span>
  </div>
</template>

<style scoped>
.ui-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 28px 16px;
  font-size: 13px;
  color: var(--text-muted);
}
.ui-loading.is-inline {
  flex-direction: row;
  justify-content: flex-start;
  gap: 6px;
  padding: 0;
}
.ui-loading--md {
  font-size: 14px;
}
@media (max-width: 767px) {
  .ui-loading:not(.is-inline) {
    padding: 22px 12px;
  }
}
</style>
