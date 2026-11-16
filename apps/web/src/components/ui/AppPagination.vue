<script setup lang="ts">
/**
 * 列表统一分页控件：默认每页 10 条，仅在总条数超过一页时出现，
 * 避免长表格一次性铺满页面；页码过多时折叠为省略号。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 当前页码（从 1 开始） */
    page: number;
    /** 总条数（筛选后的真实数量） */
    total: number;
    pageSize?: number;
    disabled?: boolean;
  }>(),
  { pageSize: 10, disabled: false },
);

const emit = defineEmits<{ (e: 'update:page', page: number): void }>();

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
/** 数据变化后页码可能越界，展示时收敛到有效范围。 */
const current = computed(() => Math.min(Math.max(1, props.page), totalPages.value));

/** 页码序列：总页数不超过 7 页时全部展示，否则固定首尾并围绕当前页展开。 */
const pageItems = computed<Array<number | 'gap'>>(() => {
  const last = totalPages.value;
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const cur = current.value;
  const start = Math.max(2, Math.min(cur - 2, last - 5));
  const end = Math.min(last - 1, Math.max(cur + 2, 6));
  const items: Array<number | 'gap'> = [1];
  if (start > 2) items.push('gap');
  for (let p = start; p <= end; p += 1) items.push(p);
  if (end < last - 1) items.push('gap');
  items.push(last);
  return items;
});

function go(next: number) {
  if (props.disabled) return;
  const p = Math.min(Math.max(1, next), totalPages.value);
  if (p !== props.page) emit('update:page', p);
}
</script>

<template>
  <nav v-if="total > pageSize" class="ui-pager" aria-label="分页导航">
    <span class="ui-pager__summary">共 {{ total }} 条 · 第 {{ current }} / {{ totalPages }} 页</span>
    <div class="ui-pager__controls">
      <button
        type="button"
        class="btn btn-sm"
        :disabled="disabled || current <= 1"
        @click="go(current - 1)"
      >
        上一页
      </button>
      <template v-for="(item, i) in pageItems" :key="`${item}-${i}`">
        <span v-if="item === 'gap'" class="ui-pager__gap" aria-hidden="true">…</span>
        <button
          v-else
          type="button"
          class="btn btn-sm ui-pager__num"
          :class="{ 'is-active': item === current }"
          :aria-current="item === current ? 'page' : undefined"
          :disabled="disabled"
          @click="go(item)"
        >
          {{ item }}
        </button>
      </template>
      <button
        type="button"
        class="btn btn-sm"
        :disabled="disabled || current >= totalPages"
        @click="go(current + 1)"
      >
        下一页
      </button>
    </div>
  </nav>
</template>

<style scoped>
.ui-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--border-light);
}
.ui-pager__summary {
  font-size: 13px;
  color: var(--text-muted);
  white-space: nowrap;
}
.ui-pager__controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ui-pager__num {
  min-width: 34px;
  padding-left: 8px;
  padding-right: 8px;
}
.ui-pager__num.is-active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}
.ui-pager__num.is-active:disabled {
  opacity: 1;
}
.ui-pager__gap {
  padding: 0 4px;
  color: var(--text-muted);
  font-size: 13px;
}

/* 窄屏：说明文字独占一行，按钮居中排列，触屏热区不压缩 */
@media (max-width: 767px) {
  .ui-pager {
    justify-content: center;
  }
  .ui-pager__summary {
    flex: 1 1 100%;
    text-align: center;
  }
  .ui-pager__controls {
    justify-content: center;
  }
}
</style>
