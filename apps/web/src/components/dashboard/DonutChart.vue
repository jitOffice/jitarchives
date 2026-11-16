<script setup lang="ts">
/**
 * 环形占比图（纯 SVG）：用于档案分类分布。
 * 占比由后端按真实分类数量计算后下发，前端只负责绘制，不重新推算分母。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    items: Array<{ name: string; count: number; ratio: number }>;
    total: number;
    centerLabel?: string;
    unit?: string;
    emptyText?: string;
  }>(),
  { centerLabel: '累计档案', unit: '篇', emptyText: '暂无档案数据' },
);

const COLORS = [
  '#165DFF',
  '#36CFC9',
  '#FF7D00',
  '#00B42A',
  '#722ED1',
  '#F53F3F',
  '#FFC53D',
  '#14C9C9',
  '#C9CDD4',
];

const SIZE = 220;
const CENTER = SIZE / 2;
const RADIUS = 78;
const STROKE = 26;
const CIRC = 2 * Math.PI * RADIUS;

interface Segment {
  name: string;
  count: number;
  ratio: number;
  color: string;
  dash: number;
  offset: number;
}

const segments = computed<Segment[]>(() => {
  const list = props.items.filter((it) => it.count > 0);
  const gap = list.length > 1 ? CIRC * 0.004 : 0;
  let acc = 0;
  return list.map((it, index) => {
    const dash = Math.max(0, it.ratio * CIRC - gap);
    const seg: Segment = {
      name: it.name,
      count: it.count,
      ratio: it.ratio,
      color: COLORS[index % COLORS.length],
      dash,
      offset: acc,
    };
    acc += it.ratio * CIRC;
    return seg;
  });
});

const isEmpty = computed(() => props.total <= 0 || segments.value.length === 0);

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio >= 0.999 ? 0 : 1)}%`;
}
</script>

<template>
  <div class="donut">
    <div class="ring">
      <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="ring-svg">
        <circle :cx="CENTER" :cy="CENTER" :r="RADIUS" fill="none" stroke="#f2f3f5" :stroke-width="STROKE" />
        <g :transform="`rotate(-90 ${CENTER} ${CENTER})`">
          <circle
            v-for="seg in segments"
            :key="seg.name"
            :cx="CENTER"
            :cy="CENTER"
            :r="RADIUS"
            fill="none"
            :stroke="seg.color"
            :stroke-width="STROKE"
            :stroke-dasharray="`${seg.dash} ${CIRC - seg.dash}`"
            :stroke-dashoffset="-seg.offset"
          />
        </g>
      </svg>
      <div class="ring-center">
        <div class="ring-value">{{ total.toLocaleString('zh-CN') }}</div>
        <div class="ring-label">{{ centerLabel }}（{{ unit }}）</div>
      </div>
    </div>

    <div v-if="isEmpty" class="donut-empty">{{ emptyText }}</div>
    <ul v-else class="legend">
      <li v-for="seg in segments" :key="seg.name" class="legend-row">
        <i class="dot" :style="{ background: seg.color }"></i>
        <span class="legend-name" :title="seg.name">{{ seg.name }}</span>
        <span class="legend-count">{{ seg.count }}{{ unit }}</span>
        <span class="legend-pct">{{ pct(seg.ratio) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.donut { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
.ring { position: relative; width: 190px; flex: none; }
.ring-svg { display: block; width: 100%; height: auto; }
.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.ring-value { font-size: 26px; font-weight: 700; color: var(--text-title); font-variant-numeric: tabular-nums; }
.ring-label { font-size: 12px; color: var(--text-muted); }
.legend { list-style: none; margin: 0; padding: 0; flex: 1; min-width: 180px; }
.legend-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-body);
}
.legend-row:hover { background: #fafbfc; }
.dot { width: 9px; height: 9px; border-radius: 3px; flex: none; }
.legend-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.legend-count { color: var(--text-title); font-variant-numeric: tabular-nums; }
.legend-pct { width: 52px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.donut-empty {
  flex: 1;
  min-width: 160px;
  font-size: 13px;
  color: var(--text-muted);
  text-align: center;
}

/* 移动端：环形图缩窄并居中，图例独占下一行 */
@media (max-width: 767px) {
  .donut { gap: 12px; justify-content: center; }
  .ring { width: min(190px, 62vw); }
  .legend { flex: 1 1 100%; min-width: 0; }
  .donut-empty { flex: 1 1 100%; min-width: 0; }
}
</style>
