<script setup lang="ts">
/**
 * 关键指标卡片：左侧为业务含义与累计量，右侧为该时间范围内的新增量。
 * 所有数值由后端统计接口返回，前端不做任何推算或兜底数字。
 */
import type { DashboardMetricView } from '../../types';

defineProps<{ metric: DashboardMetricView }>();

function fmt(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('zh-CN');
}
</script>

<template>
  <section class="metric" :class="`metric-${metric.key}`">
    <div class="metric-head">
      <span class="metric-label">{{ metric.label }}</span>
      <span class="metric-unit">{{ metric.unit }}</span>
    </div>

    <div v-if="metric.available" class="metric-main">
      <div class="metric-value">{{ fmt(metric.total) }}</div>
      <div class="metric-total-label">{{ metric.totalLabel }}</div>
    </div>
    <div v-else class="metric-main">
      <div class="metric-value empty">—</div>
      <div class="metric-total-label">当前角色无此统计</div>
    </div>

    <div v-if="metric.available" class="metric-period">
      <span class="period-key">{{ metric.periodLabel }}</span>
      <span class="period-val">{{ fmt(metric.period) }}</span>
    </div>
    <div v-else class="metric-period">
      <span class="period-key">不参与借阅</span>
    </div>

    <p class="metric-hint">{{ metric.hint }}</p>
  </section>
</template>

<style scoped>
.metric {
  position: relative;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  padding: 18px 20px 16px;
  transition: box-shadow 0.2s;
}
.metric:hover { box-shadow: var(--shadow-card-hover); }
.metric::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--color-primary);
}
.metric-archived::before { background: var(--color-success); }
.metric-draft::before { background: var(--color-warning); }
.metric-borrowPending::before { background: var(--color-accent); }

.metric-head { display: flex; align-items: center; justify-content: space-between; }
.metric-label { font-size: 14px; color: var(--text-body); font-weight: 600; }
.metric-unit {
  font-size: 12px;
  color: var(--text-muted);
  background: #f7f8fa;
  border-radius: 20px;
  padding: 0 8px;
}
.metric-main { display: flex; align-items: baseline; gap: 8px; margin-top: 6px; }
.metric-value {
  font-size: 32px;
  line-height: 1.25;
  font-weight: 700;
  color: var(--text-title);
  font-variant-numeric: tabular-nums;
}
.metric-value.empty { color: var(--text-muted); }
.metric-total-label { font-size: 12px; color: var(--text-muted); }
.metric-period {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--color-primary-soft);
  font-size: 12px;
}
.metric-archived .metric-period { background: rgba(0, 180, 42, 0.08); }
.metric-draft .metric-period { background: rgba(255, 125, 0, 0.08); }
.metric-borrowPending .metric-period { background: rgba(54, 207, 201, 0.12); }
.period-key { color: var(--text-body); }
.period-val { color: var(--color-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.metric-archived .period-val { color: var(--color-success); }
.metric-draft .period-val { color: var(--color-warning); }
.metric-borrowPending .period-val { color: #0e9f99; }
.metric-hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
  min-height: 32px;
}
</style>
