<script setup lang="ts">
/**
 * 横向占比条：用于档案状态（草稿/已归档）与借阅审批状态分布。
 * 数量与占比均为后端统计结果，前端仅做长度映射与百分号格式化。
 */
import type { DashboardBreakdownItemView } from '../../types';

const props = withDefaults(
  defineProps<{
    items: DashboardBreakdownItemView[];
    total: number;
    totalLabel: string;
    unit?: string;
    colors?: Record<string, string>;
    emptyText?: string;
  }>(),
  { unit: '篇', colors: () => ({}), emptyText: '当前时间范围内暂无数据' },
);

const FALLBACK = ['#165DFF', '#36CFC9', '#FF7D00', '#00B42A', '#722ED1', '#F53F3F'];

function colorOf(item: DashboardBreakdownItemView, index: number): string {
  return props.colors[item.key] ?? FALLBACK[index % FALLBACK.length];
}

function widthOf(item: DashboardBreakdownItemView): string {
  const pct = Math.max(0, Math.min(1, item.ratio)) * 100;
  if (item.count > 0) return `${Math.max(pct, 2)}%`;
  return '0%';
}

function pct(ratio: number): string {
  if (ratio <= 0) return '0%';
  const v = ratio * 100;
  return `${v < 0.1 ? '<0.1' : v.toFixed(v >= 10 ? 0 : 1)}%`;
}
</script>

<template>
  <div class="bars">
    <div class="bars-total">
      <span class="total-label">{{ totalLabel }}</span>
      <strong class="total-value">{{ total.toLocaleString('zh-CN') }}<em>{{ unit }}</em></strong>
    </div>

    <div v-if="total <= 0" class="bars-empty">{{ emptyText }}</div>

    <ul v-else class="bar-list">
      <li v-for="(item, index) in items" :key="item.key" class="bar-row">
        <div class="row-head">
          <span class="row-label">
            <i class="dot" :style="{ background: colorOf(item, index) }"></i>{{ item.label }}
          </span>
          <span class="row-num">
            {{ item.count.toLocaleString('zh-CN') }}{{ unit }}
            <em>{{ pct(item.ratio) }}</em>
          </span>
        </div>
        <div class="track">
          <span class="fill" :style="{ width: widthOf(item), background: colorOf(item, index) }"></span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bars { display: flex; flex-direction: column; gap: 12px; }
.bars-total {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--border-light);
}
.total-label { font-size: 13px; color: var(--text-muted); }
.total-value { font-size: 22px; color: var(--text-title); font-variant-numeric: tabular-nums; }
.total-value em { font-size: 12px; font-style: normal; color: var(--text-muted); margin-left: 4px; }
.bar-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.row-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 5px; }
.row-label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-body); }
.dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.row-num { font-size: 13px; color: var(--text-title); font-variant-numeric: tabular-nums; }
.row-num em { font-style: normal; font-size: 12px; color: var(--text-muted); margin-left: 6px; }
.track { height: 8px; border-radius: 6px; background: #f5f6f8; overflow: hidden; }
.fill { display: block; height: 100%; border-radius: 6px; transition: width 0.4s ease; }
.bars-empty {
  padding: 18px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
  background: #fafbfc;
  border: 1px dashed var(--border-light);
  border-radius: var(--radius-control);
}
</style>
