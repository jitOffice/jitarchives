<script setup lang="ts">
/**
 * 折线趋势图（纯 SVG，无第三方图表库）。
 * 数据点由后端按自然日补齐，缺失日期由服务端补 0，因此曲线不会断点。
 */
import { computed, ref } from 'vue';

interface SeriesInput {
  key: string;
  label: string;
  color: string;
  values: number[];
}

const props = withDefaults(
  defineProps<{
    labels: string[];
    series: SeriesInput[];
    height?: number;
    unit?: string;
    emptyText?: string;
  }>(),
  { height: 240, unit: '篇', emptyText: '当前时间范围内暂无数据' },
);

/** SVG 逻辑宽度：宽度自适应，高度按 viewBox 等比缩放。 */
const W = 760;
const PAD = { top: 16, right: 16, bottom: 30, left: 44 };

const plotW = W - PAD.left - PAD.right;
const plotH = computed(() => Math.max(80, props.height - PAD.top - PAD.bottom));
const count = computed(() => props.labels.length);

const maxValue = computed(() =>
  Math.max(0, ...props.series.flatMap((s) => s.values.map((v) => (Number.isFinite(v) ? v : 0)))),
);

/** 刻度步长取整，避免出现「0.75 篇」这类无法理解的刻度。 */
const step = computed(() => {
  const m = maxValue.value;
  if (m <= 4) return 1;
  const raw = m / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return mult * pow;
});
const yMax = computed(() => step.value * 4);
const yTicks = computed(() => [0, 1, 2, 3, 4].map((i) => i * step.value));
const isEmpty = computed(() => maxValue.value <= 0);

const xTickIndices = computed(() => {
  const n = count.value;
  if (n <= 7) return props.labels.map((_, i) => i);
  const gap = Math.ceil((n - 1) / 6);
  const out: number[] = [];
  for (let i = 0; i < n; i += gap) out.push(i);
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
});

function xAt(i: number): number {
  if (count.value <= 1) return PAD.left + plotW / 2;
  return PAD.left + (i / (count.value - 1)) * plotW;
}

function yAt(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return PAD.top + plotH.value - (safe / yMax.value) * plotH.value;
}

function linePoints(values: number[]): string {
  return values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
}

function areaPoints(values: number[]): string {
  if (values.length === 0) return '';
  const base = PAD.top + plotH.value;
  const head = `M ${xAt(0).toFixed(1)},${base}`;
  const body = values.map((v, i) => `L ${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
  return `${head} ${body} L ${xAt(values.length - 1).toFixed(1)},${base} Z`;
}

function shortDay(day: string): string {
  return day.length >= 10 ? day.slice(5) : day;
}

const hoverIndex = ref<number | null>(null);

function onMove(event: MouseEvent): void {
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  if (!rect.width || count.value === 0) return;
  const relX = ((event.clientX - rect.left) / rect.width) * W;
  const ratio = (relX - PAD.left) / plotW;
  const idx = Math.round(ratio * (count.value - 1));
  hoverIndex.value = Math.min(count.value - 1, Math.max(0, idx));
}
</script>

<template>
  <div class="chart">
    <div v-if="series.length > 1" class="legend">
      <span v-for="s in series" :key="s.key" class="legend-item">
        <i :style="{ background: s.color }"></i>{{ s.label }}
      </span>
    </div>

    <div v-if="isEmpty" class="chart-empty" :style="{ height: `${height}px` }">
      {{ emptyText }}
    </div>

    <div v-else class="canvas">
      <svg
        :viewBox="`0 0 ${W} ${height}`"
        class="chart-svg"
        @mousemove="onMove"
        @mouseleave="hoverIndex = null"
      >
        <g>
          <line
            v-for="t in yTicks"
            :key="`g-${t}`"
            :x1="PAD.left"
            :x2="W - PAD.right"
            :y1="yAt(t)"
            :y2="yAt(t)"
            class="grid-line"
          />
          <text
            v-for="t in yTicks"
            :key="`ty-${t}`"
            :x="PAD.left - 10"
            :y="yAt(t) + 4"
            text-anchor="end"
            class="axis-text"
          >
            {{ t }}
          </text>
        </g>

        <g>
          <template v-for="s in series" :key="s.key">
            <path
              v-if="series.length === 1 && s.values.length > 1"
              :d="areaPoints(s.values)"
              :fill="s.color"
              opacity="0.08"
            />
            <polyline
              :points="linePoints(s.values)"
              fill="none"
              :stroke="s.color"
              stroke-width="2.2"
              stroke-linejoin="round"
              stroke-linecap="round"
            />
          </template>
        </g>

        <g v-if="hoverIndex !== null">
          <line
            :x1="xAt(hoverIndex)"
            :x2="xAt(hoverIndex)"
            :y1="PAD.top"
            :y2="PAD.top + plotH"
            class="hover-line"
          />
          <circle
            v-for="s in series"
            :key="`h-${s.key}`"
            :cx="xAt(hoverIndex)"
            :cy="yAt(s.values[hoverIndex] ?? 0)"
            r="3.6"
            :fill="s.color"
            stroke="#fff"
            stroke-width="1.4"
          />
        </g>

        <g>
          <text
            v-for="i in xTickIndices"
            :key="`x-${i}`"
            :x="xAt(i)"
            :y="height - 8"
            text-anchor="middle"
            class="axis-text"
          >
            {{ shortDay(labels[i] ?? '') }}
          </text>
        </g>
      </svg>

      <div
        v-if="hoverIndex !== null"
        class="tip"
        :style="{ left: `${(xAt(hoverIndex) / W) * 100}%` }"
      >
        <div class="tip-day">{{ labels[hoverIndex] }}</div>
        <div v-for="s in series" :key="`t-${s.key}`" class="tip-row">
          <i :style="{ background: s.color }"></i>
          <span class="tip-label">{{ s.label }}</span>
          <strong class="tip-val">{{ s.values[hoverIndex] ?? 0 }}{{ unit }}</strong>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chart { width: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; justify-content: flex-end; margin-bottom: 6px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-body); }
.legend-item i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
.canvas { position: relative; }
.chart-svg { display: block; width: 100%; height: auto; overflow: visible; }
.grid-line { stroke: #f2f3f5; stroke-width: 1; stroke-dasharray: 3 3; }
.axis-text { font-size: 11px; fill: var(--text-muted); }
.hover-line { stroke: #c9cdd4; stroke-width: 1; stroke-dasharray: 4 3; }
.chart-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  background: #fafbfc;
  border: 1px dashed var(--border-light);
  border-radius: var(--radius-control);
}
.tip {
  position: absolute;
  top: 8px;
  transform: translate(-50%, 0);
  min-width: 128px;
  background: rgba(29, 33, 41, 0.92);
  color: #fff;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  pointer-events: none;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16);
  z-index: 2;
}
.tip-day { color: rgba(255, 255, 255, 0.72); margin-bottom: 4px; }
.tip-row { display: flex; align-items: center; gap: 6px; line-height: 1.7; }
.tip-row i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
.tip-label { color: rgba(255, 255, 255, 0.86); }
.tip-val { margin-left: auto; }
</style>
