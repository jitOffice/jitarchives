<script setup lang="ts">
/**
 * 图谱图例：四类节点 + 六种关系的视觉编码说明。
 * 样式全部读自 styles.ts（与 Canvas 绘制同一份映射），保证「图例上看到的」和「画布上画出来的」一致。
 * 点击节点类型可以筛选画布层（不改变后端返回的数据，只是不画该类型）。
 */
import { computed } from 'vue';
import { KG_EDGE_STYLES, KG_NODE_STYLES, KG_EDGE_TYPES, KG_NODE_TYPES } from '../../lib/knowledge-graph/styles.ts';
import type { KgEdgeType, KgNodeType } from '../../lib/knowledge-graph/types.ts';

const props = defineProps<{
  activeTypes: KgNodeType[];
  edgeCounts?: Partial<Record<KgEdgeType, number>>;
  collapsible?: boolean;
}>();

const emit = defineEmits<{ toggle: [type: KgNodeType] }>();

const collapsed = computed(() => props.collapsible === true);

/** 形状顶点：菱形 4 点、六边形 6 点，与 Canvas 的 tracePath 同算法。 */
function polygonPoints(shape: string, cx: number, cy: number, r: number): string {
  const sides = shape === 'diamond' ? 4 : 6;
  const offset = shape === 'diamond' ? 0 : Math.PI / 6;
  return Array.from({ length: sides }, (_, i) => {
    const angle = offset + (Math.PI * 2 * i) / sides;
    return `${(cx + Math.cos(angle) * r).toFixed(1)},${(cy + Math.sin(angle) * r).toFixed(1)}`;
  }).join(' ');
}
</script>

<template>
  <div class="kg-legend" data-testid="kg-legend">
    <div class="kg-legend__group">
      <span
        v-for="type in KG_NODE_TYPES"
        :key="type"
        class="kg-legend__item"
        :class="{ 'is-dimmed': activeTypes.length > 0 && !activeTypes.includes(type) }"
        :data-testid="`kg-legend-node-${type}`"
        role="button"
        tabindex="0"
        :title="activeTypes.length && activeTypes.includes(type) ? '点击取消筛选' : `只看 ${KG_NODE_STYLES[type].label}`"
        @click="emit('toggle', type)"
        @keydown.enter.prevent="emit('toggle', type)"
      >
        <svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">
          <defs>
            <linearGradient :id="`kg-legend-${type}-gradient`" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" :stop-color="KG_NODE_STYLES[type].gradientStart" />
              <stop offset="100%" :stop-color="KG_NODE_STYLES[type].gradientEnd" />
            </linearGradient>
          </defs>
          <circle
            v-if="type === 'archive'"
            cx="14"
            cy="14"
            r="11.5"
            :fill="`url(#kg-legend-${type}-gradient)`"
            :stroke="KG_NODE_STYLES[type].stroke"
            stroke-width="1.4"
          />
          <rect
            v-else-if="type === 'category'"
            x="2"
            y="2"
            width="24"
            height="24"
            rx="5"
            :fill="`url(#kg-legend-${type}-gradient)`"
            :stroke="KG_NODE_STYLES[type].stroke"
            stroke-width="1.4"
          />
          <polygon
            v-else
            :points="polygonPoints(KG_NODE_STYLES[type].shape, 14, 14, 12)"
            :fill="`url(#kg-legend-${type}-gradient)`"
            :stroke="KG_NODE_STYLES[type].stroke"
            stroke-width="1.4"
            stroke-linejoin="round"
          />

          <g v-if="type === 'category'">
            <path d="M5.5 10H11L13 12H22.5V21.5H5.5Z" fill="#fff" />
          </g>
          <g v-else-if="type === 'archive'">
            <path d="M9 5.5H16.5L20 9V22H9Z" fill="#fff" />
            <path d="M16.5 5.5V9H20M11.5 13H17.5M11.5 16.5H17.5M11.5 20H15" fill="none" :stroke="KG_NODE_STYLES[type].iconLine" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          </g>
          <g v-else-if="type === 'file'">
            <path d="M16 5.5C20.5 5.5 21.5 10.5 18.5 13.5L10.5 21.5C7.5 24.5 3.5 20.5 6.5 17.5L15 9C17 7 19.5 10 17.5 12L10 19.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </g>
          <g v-else>
            <path d="M18 8H20.5Q22 8 22 9.5V21Q22 22.5 20.5 22.5H11" fill="none" stroke="#fff" stroke-width="1.2" stroke-linecap="round" />
            <path d="M7 6.5Q7 5.5 8 5.5H16L19 8.5V21Q19 22 18 22H8Q7 22 7 21Z" fill="#fff" />
            <path d="M10 11Q8.5 11 9 13Q9.5 14 11 13.5M14 11Q12.5 11 13 13Q13.5 14 15 13.5M10 17H16M10 19.5H14" fill="none" :stroke="KG_NODE_STYLES[type].iconLine" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
          </g>
        </svg>
        <span class="kg-legend__text">{{ KG_NODE_STYLES[type].label }}</span>
      </span>
    </div>

    <div v-if="!collapsed" class="kg-legend__group">
      <span v-for="type in KG_EDGE_TYPES" :key="type" class="kg-legend__item kg-legend__item--edge">
        <svg viewBox="0 0 24 12" width="24" height="12" aria-hidden="true">
          <line
            x1="1"
            y1="6"
            x2="23"
            y2="6"
            :stroke="KG_EDGE_STYLES[type].color"
            :stroke-width="KG_EDGE_STYLES[type].width"
            :stroke-dasharray="KG_EDGE_STYLES[type].dash.join(',') || 'none'"
            stroke-linecap="round"
          />
        </svg>
        <span class="kg-legend__text">{{ KG_EDGE_STYLES[type].label }}</span>
        <span v-if="edgeCounts && edgeCounts[type]" class="kg-legend__count">{{ edgeCounts[type] }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.kg-legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--kg-border, var(--border-light));
  border-radius: 10px;
  background: var(--kg-panel, var(--bg-card));
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
  font-size: 12px;
  color: var(--kg-text, var(--text-body));
}
.kg-legend__group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.kg-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  user-select: none;
  transition: opacity 0.15s;
}
.kg-legend__item--edge {
  cursor: default;
}
.kg-legend__item.is-dimmed {
  opacity: 0.4;
}
.kg-legend__count {
  font-family: Consolas, Monaco, monospace;
  color: var(--kg-text-muted, var(--text-muted));
}
</style>
