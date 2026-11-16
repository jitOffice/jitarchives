<script setup lang="ts">
/**
 * 档案知识图谱（第二阶段）· 页面骨架。
 *
 * 布局：顶部操作栏 + 左侧概览 / 中间 Canvas 关系网络 / 右侧节点详情（严格三栏）。
 * 收起：左右两栏各自带收起/展开按钮，互不影响；收起后只留一条窄入口，画布占据剩余宽度。
 * 数据：只使用 /api/knowledge-graph/* 返回的真实节点与关系，页面不生成任何模拟节点或静态数字。
 * 移动端：左右两栏收为可折叠抽屉，中间画布保持全宽可操作（缩放/拖动/双击展开均走触控事件）。
 * 主题：明暗切换只改本作用域 CSS 变量与画布配色，图谱数据与布局位置保存在 Pinia store，不会丢失。
 * 第三阶段：支持 /knowledge-graph?focus=archive:<id> 从 Agent 回答引用回到图谱定位节点；
 * 目标节点是否可见仍由后端按当前用户权限过滤，定位不到时保持默认视图不报错。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import {routePositiveId} from '../lib/agentSource';
import type { KgNodeType } from '../lib/knowledge-graph/types';
import GraphToolbar from '../components/knowledge-graph/GraphToolbar.vue';
import GraphSearchBox from '../components/knowledge-graph/GraphSearchBox.vue';
import GraphOverviewPanel from '../components/knowledge-graph/GraphOverviewPanel.vue';
import GraphDetailPanel from '../components/knowledge-graph/GraphDetailPanel.vue';
import GraphLegend from '../components/knowledge-graph/GraphLegend.vue';
import GraphCanvas from '../components/knowledge-graph/GraphCanvas.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import { useKnowledgeGraphStore } from '../stores/knowledgeGraph.ts';
import type { KgGraphEdgeView, KgGraphNodeView } from '../lib/knowledge-graph/types.ts';
import {
  collapsePanelSide,
  ensurePanelExpanded,
  expandPanelSide,
  initialPanelState,
  type KgPanelSide,
  type KgPanelState,
} from '../lib/knowledge-graph/panels.ts';

const store = useKnowledgeGraphStore();
const route = useRoute();
const canvasRef = ref<InstanceType<typeof GraphCanvas> | null>(null);
/** 移动端抽屉：none = 两栏都收起（画布全屏），overview / detail 各自展开。 */
const mobilePanel = ref<'none' | 'overview' | 'detail'>('none');
/** 桌面端左右面板各自的收起状态：两个独立布尔位，只由 panels.ts 的纯函数改写。 */
const panels = ref<KgPanelState>(initialPanelState());
const leftCollapsed = computed(() => panels.value.left);
const rightCollapsed = computed(() => panels.value.right);
const isMobile = ref(false);
const isNarrow = ref(false);

const THEME_KEY = 'jitarchives.kg-theme';

const mediaMobile = window.matchMedia('(max-width: 767px)');
const mediaNarrow = window.matchMedia('(max-width: 1023px)');

function syncMedia(): void {
  isMobile.value = mediaMobile.matches;
  isNarrow.value = mediaNarrow.matches;
}

onMounted(() => {
  syncMedia();
  mediaMobile.addEventListener('change', syncMedia);
  mediaNarrow.addEventListener('change', syncMedia);
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') store.setTheme(saved);
  void bootstrap();
});

onBeforeUnmount(() => {
  mediaMobile.removeEventListener('change', syncMedia);
  mediaNarrow.removeEventListener('change', syncMedia);
});

/** 进入页面：概览与首层数据并行拉取（store 内有缓存，重复进入不重复请求）；完成后处理外部定位请求。 */
async function bootstrap(): Promise<void> {
  store.invalidate();
  await Promise.all([store.loadOverview(), store.loadLayer()]);
  await applyRouteFocus();
}

/**
 * 第三阶段：从 AI 回答的「在图谱中定位」返回时，按 ?focus=archive:<id> 选中并居中节点。
 * 节点不在当前已加载层（未入图/被截断/无权）时静默跳过——可见性始终以后端过滤结果为准。
 */
async function applyRouteFocus(): Promise<void> {
  const edgeId=routePositiveId(route.query.edgeId);
  const fromId=routePositiveId(route.query.fromId),toId=routePositiveId(route.query.toId);
  const type=typeof route.query.nodeType==='string'?route.query.nodeType:'';
  const refId=routePositiveId(route.query.refId);
  let target=refId && ['archive','file','chunk','category'].includes(type) ? {type:type as KgNodeType,refId}:undefined;
  const legacy=typeof route.query.focus==='string'?/^archive:(\d+)$/u.exec(route.query.focus):null;
  if(!target && legacy)target={type:'archive',refId:Number(legacy[1])};
  if(route.query.edgeId!==undefined && (!edgeId || (route.query.fromId!==undefined || route.query.toId!==undefined) && (!fromId || !toId))){
    store.invalidate();store.nodes=[];store.edges=[];store.detailError='关系定位参数无效';return;
  }
  if(target || edgeId){
    const located=await store.locateReference(target,edgeId??undefined,fromId&&toId?{fromId,toId}:undefined);
    if(located){panels.value=ensurePanelExpanded(panels.value,'detail');if(isMobile.value)mobilePanel.value='detail';}
  }
}

watch(()=>route.fullPath,()=>{void applyRouteFocus();});

const canvasEmpty = computed(() => !store.graphLoading && store.nodes.length === 0);

function onSelect(node: KgGraphNodeView): void {
  void store.selectNode(node);
  openMobilePanel('detail');
}

function onSelectEdge(edge: KgGraphEdgeView): void {
  void store.selectEdge(edge);
  openMobilePanel('detail');
}

/**
 * 移动端打开抽屉时，同侧面板若处于收起态先恢复展开，避免抽屉里只剩一条收起入口。
 * 桌面端不处理（三栏常驻，收起由用户自己控制）。
 */
function openMobilePanel(panel: KgPanelSide): void {
  if (!isMobile.value) return;
  panels.value = ensurePanelExpanded(panels.value, panel);
  mobilePanel.value = panel;
}

/** 收起某一侧：只改这一侧的状态，另一侧完全不受影响。 */
function collapsePanel(panel: KgPanelSide): void {
  panels.value = collapsePanelSide(panels.value, panel);
  if (mobilePanel.value === panel) mobilePanel.value = 'none';
}

/** 展开某一侧：只改这一侧的状态，另一侧保持原样。 */
function expandPanel(panel: KgPanelSide): void {
  panels.value = expandPanelSide(panels.value, panel);
}

function onExpand(node: KgGraphNodeView): void {
  void store.expandNode(node);
}

/** 搜索命中 / 外部定位：让画布把节点移到视野中心（同一节点重复定位也能生效）。 */
watch(
  () => store.focusRequest,
  (request) => {
    if (!request) return;
    if (isMobile.value) mobilePanel.value = 'none';
    canvasRef.value?.focusNodeKey(request.key);
  },
);

watch(
  () => store.resetToken,
  () => canvasRef.value?.resetView(),
);

watch(
  () => store.theme,
  (theme) => window.localStorage.setItem(THEME_KEY, theme),
);

/** 选中节点变化时，移动端自动弹详情抽屉（桌面端右栏常驻，无需处理）。 */
watch(
  () => store.selectedKey,
  (key) => {
    if (key && isMobile.value) mobilePanel.value = 'detail';
  },
);

function locateSelected(): void {
  const key = store.selectedKey;
  if (key) canvasRef.value?.focusNodeKey(key);
}

function resetView(): void {
  store.requestResetView();
}

function togglePanel(panel: 'overview' | 'detail'): void {
  if (mobilePanel.value === panel) {
    mobilePanel.value = 'none';
    return;
  }
  openMobilePanel(panel);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') mobilePanel.value = 'none';
}

const loadedCount = computed(() => store.nodes.length);
</script>

<template>
  <div
    class="kg-view"
    :data-theme="store.theme"
    :class="{ 'is-mobile': isMobile, 'is-narrow': isNarrow && !isMobile }"
    data-testid="kg-view"
    @keydown="onKeydown"
  >
    <GraphToolbar>
      <template #search>
        <GraphSearchBox />
      </template>
    </GraphToolbar>

    <div class="kg-view__body">
      <!-- 左栏：概览（可独立收起，收起后只留窄入口） -->
      <section
        class="kg-view__col kg-view__col--left"
        :class="{ 'is-collapsed': leftCollapsed, 'is-open': mobilePanel === 'overview' }"
        data-testid="kg-left-col"
        :data-collapsed="leftCollapsed ? 'true' : 'false'"
        aria-label="图谱概览"
      >
        <button
          class="kg-col__rail"
          type="button"
          data-testid="kg-expand-overview"
          title="展开图谱概览"
          aria-label="展开图谱概览"
          :aria-expanded="!leftCollapsed"
          @click="expandPanel('overview')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M9.5 5.5L16 12l-6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="kg-col__rail-text">图谱概览</span>
        </button>
        <div class="kg-col__panel" data-testid="kg-left-panel">
          <GraphOverviewPanel @collapse="collapsePanel('overview')" />
        </div>
      </section>

      <!-- 中栏：关系网络画布 -->
      <main class="kg-view__stage" data-testid="kg-stage">
        <div class="kg-stage__bar">
          <div class="kg-stage__meta text-muted">
            <span>节点 {{ loadedCount }}<template v-if="store.truncated"> / 共 {{ store.totalNodes }}（已截断）</template></span>
            <span v-if="store.viewMode === 'category' && store.activeCategoryId != null" class="kg-stage__tag">
              分类视图：{{ store.categoryList.find((c) => c.id === store.activeCategoryId)?.name ?? `#${store.activeCategoryId}` }}
            </span>
          </div>
          <div class="kg-stage__ops">
            <button class="kg-iconbtn kg-iconbtn--panel" type="button" data-testid="kg-toggle-overview" title="概览" @click="togglePanel('overview')">概览</button>
            <button class="kg-iconbtn kg-iconbtn--panel" type="button" data-testid="kg-toggle-detail" title="详情" @click="togglePanel('detail')">详情</button>
            <button class="kg-iconbtn" type="button" data-testid="kg-locate" :disabled="!store.selectedKey" title="定位选中节点" @click="locateSelected">定位</button>
            <button class="kg-iconbtn" type="button" data-testid="kg-reset" title="重置视图" @click="resetView">重置视图</button>
          </div>
        </div>

        <p v-if="store.error" class="kg-stage__error" data-testid="kg-error">{{ store.error }}</p>

        <AppEmpty
          v-if="canvasEmpty"
          class="kg-stage__empty"
          :title="store.error ? '图谱数据未能加载' : '当前没有可见的图谱节点'"
          :description="store.error ? '请稍后重试，或确认当前账号的档案访问权限。' : '图谱按你有权访问的档案生成。完成正文提取并重建知识图谱后，这里会展示真实的分类、档案、附件与正文关系。'"
        >
          <template #action>
            <button class="btn btn-sm btn-primary" type="button" @click="bootstrap">重新加载</button>
          </template>
        </AppEmpty>

        <GraphCanvas
          v-else
          ref="canvasRef"
          :nodes="store.nodes"
          :edges="store.edges"
          :positions="store.positions"
          :selected-key="store.selectedKey"
          :selected-edge-id="store.selectedEdgeId"
          :highlight="store.highlight"
          :theme="store.theme"
          :loading="store.graphLoading"
          data-testid="kg-canvas-host"
          @select="onSelect"
          @select-edge="onSelectEdge"
          @expand="onExpand"
        />

        <div class="kg-stage__legend">
          <GraphLegend :active-types="store.typeFilter" :edge-counts="store.overview.edgesByType" :collapsible="isMobile" @toggle="store.toggleTypeFilter" />
        </div>
      </main>

      <!-- 右栏：节点详情（可独立收起，收起后只留窄入口） -->
      <section
        class="kg-view__col kg-view__col--right"
        :class="{ 'is-collapsed': rightCollapsed, 'is-open': mobilePanel === 'detail' }"
        data-testid="kg-right-col"
        :data-collapsed="rightCollapsed ? 'true' : 'false'"
        aria-label="节点详情"
      >
        <button
          class="kg-col__rail"
          type="button"
          data-testid="kg-expand-detail"
          title="展开节点详情"
          aria-label="展开节点详情"
          :aria-expanded="!rightCollapsed"
          @click="expandPanel('detail')"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="kg-col__rail-text">节点详情</span>
        </button>
        <div class="kg-col__panel" data-testid="kg-right-panel">
          <GraphDetailPanel @collapse="collapsePanel('detail')" />
        </div>
      </section>
    </div>

    <div v-if="isMobile && mobilePanel !== 'none'" class="kg-view__mask" data-testid="kg-mask" @click="mobilePanel = 'none'" />
  </div>
</template>

<style scoped>
.kg-view {
  /* 亮色：与系统蓝白简约 UI 同源 */
  --kg-panel: #ffffff;
  --kg-page: #f7f9fc;
  --kg-border: #f2f3f5;
  --kg-text: #4e5969;
  --kg-text-title: #1d2129;
  --kg-text-muted: #86909c;
  --kg-input-bg: #ffffff;
  --kg-seg-bg: rgba(22, 93, 255, 0.06);
  --kg-stat-bg: rgba(22, 93, 255, 0.03);
  --kg-row-bg: rgba(22, 93, 255, 0.03);
  --kg-quote-bg: rgba(114, 46, 209, 0.05);
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--kg-page);
  color: var(--kg-text);
}
.kg-view[data-theme='dark'] {
  --kg-panel: #1f2124;
  --kg-page: #17181a;
  --kg-border: #2c2f33;
  --kg-text: #c9cdd4;
  --kg-text-title: #e8eaed;
  --kg-text-muted: #8b919b;
  --kg-input-bg: #26282c;
  --kg-seg-bg: rgba(255, 255, 255, 0.06);
  --kg-stat-bg: rgba(255, 255, 255, 0.04);
  --kg-row-bg: rgba(255, 255, 255, 0.04);
  --kg-quote-bg: rgba(114, 46, 209, 0.16);
}

/* 三栏用 flex 宽度而不是 grid：收起某侧时只需过渡 width，画布随剩余空间自动扩宽 */
.kg-view__body {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.kg-view__col {
  position: relative;
  display: flex;
  flex: 0 0 auto;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--kg-border);
  background: var(--kg-panel);
  transition: width 0.24s ease;
}
.kg-view__col--left {
  width: 268px;
}
.kg-view__col--right {
  width: 328px;
  border-right: 0;
  border-left: 1px solid var(--kg-border);
}
/* 收起后只保留 44px 窄入口，面板内容整块隐藏（组件仍保持挂载，状态不丢） */
.kg-view__col.is-collapsed {
  width: 44px;
}
.kg-view__col.is-collapsed .kg-col__panel {
  display: none;
}
.kg-col__panel {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.kg-col__rail {
  display: none;
  flex: 0 0 44px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 44px;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--kg-text-muted);
  cursor: pointer;
}
.kg-col__rail:hover {
  color: var(--color-primary);
  background: var(--color-primary-soft);
}
.kg-col__rail:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
.kg-col__rail-text {
  writing-mode: vertical-rl;
  font-size: 12px;
  letter-spacing: 2px;
}
.kg-view__col.is-collapsed .kg-col__rail {
  display: flex;
}
.kg-view__stage {
  flex: 1 1 auto;
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--kg-page);
}
.kg-stage__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--kg-border);
  background: var(--kg-panel);
  font-size: 12px;
}
.kg-stage__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.kg-stage__tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--kg-seg-bg);
  color: var(--color-primary);
}
.kg-stage__ops {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
/* 抽屉开关只在移动端出现（桌面端三栏常驻，不需要折叠） */
.kg-iconbtn--panel {
  display: none;
}
.is-mobile .kg-iconbtn--panel {
  display: inline-flex;
  align-items: center;
}
.kg-iconbtn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--kg-border);
  border-radius: 6px;
  background: transparent;
  font-size: 12px;
  color: var(--kg-text);
  cursor: pointer;
  white-space: nowrap;
}
.kg-iconbtn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.kg-iconbtn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.kg-stage__error {
  margin: 0;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--color-danger);
  background: rgba(245, 63, 63, 0.06);
}
.kg-stage__empty {
  flex: 1;
  display: flex;
}
.kg-stage__legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 5;
  max-width: calc(100% - 24px);
}
.kg-view__col--left,
.kg-view__col--right {
  background: var(--kg-panel);
}

/* 尊重系统「减少动态效果」设置：关闭收起/展开过渡 */
@media (prefers-reduced-motion: reduce) {
  .kg-view__col {
    transition: none;
  }
}

/* 窄屏（平板）：压缩两侧宽度，保证画布可用面积 */
@media (max-width: 1279px) {
  .kg-view__col--left {
    width: 232px;
  }
  .kg-view__col--right {
    width: 296px;
  }
}

/* 移动端：两侧变抽屉，画布保持全宽（抽屉浮在画布之上，不挤压画布尺寸） */
@media (max-width: 1023px) {
  .kg-view__col--left {
    width: 224px;
  }
  .kg-view__col--right {
    width: 280px;
  }
}
.is-mobile .kg-view__body {
  display: block;
  position: relative;
}
.is-mobile .kg-view__stage {
  height: 100%;
}
/* 移动端抽屉宽度固定，不受桌面端收起状态影响；抽屉显隐只由 translateX 控制 */
.is-mobile .kg-view__col,
.is-mobile .kg-view__col.is-collapsed {
  position: absolute;
  top: 0;
  bottom: 0;
  width: min(84vw, 320px);
  z-index: 20;
  transform: translateX(-102%);
  transition: transform 0.22s ease;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.16);
  overflow: hidden;
}
.is-mobile .kg-view__col:hover {
  overflow: hidden;
}
.is-mobile .kg-view__col--left {
  left: 0;
  border-right: 1px solid var(--kg-border);
}
.is-mobile .kg-view__col--right {
  right: 0;
  left: auto;
  transform: translateX(102%);
}
.is-mobile .kg-view__col.is-open {
  transform: translateX(0);
}
.is-mobile .kg-view__col .kg-col__rail {
  display: none;
}
.is-mobile .kg-view__col .kg-col__panel,
.is-mobile .kg-view__col.is-collapsed .kg-col__panel {
  display: block;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.is-mobile .kg-view__col .kg-col__panel :deep(.kg-overview),
.is-mobile .kg-view__col .kg-col__panel :deep(.kg-detail) {
  height: 100%;
}
.kg-view__mask {
  position: fixed;
  inset: 0;
  z-index: 15;
  background: rgba(0, 0, 0, 0.28);
}
</style>
