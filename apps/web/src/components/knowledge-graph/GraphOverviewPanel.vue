<script setup lang="ts">
/**
 * 左侧图谱概览：当前用户可见规模 + 档案分类列表。
 * 数字全部来自 GET /api/knowledge-graph/overview（后端已按权限重算），此处不做任何估算或占位值。
 */
import { computed } from 'vue';
import AppEmpty from '../ui/AppEmpty.vue';
import { useKnowledgeGraphStore } from '../../stores/knowledgeGraph.ts';
import type { KgCategorySummary } from '../../lib/knowledge-graph/types.ts';

const store = useKnowledgeGraphStore();

/** 收起入口由页面控制（桌面端收窄成窄条，移动端关闭抽屉）。 */
const emit = defineEmits<{ collapse: [] }>();

const stats = computed(() => {
  const o = store.overview;
  return [
    { key: 'archives', label: '档案', value: o.archives, testid: 'kg-stat-archives' },
    { key: 'categories', label: '档案分类', value: o.categories, testid: 'kg-stat-categories' },
    { key: 'files', label: '附件', value: o.files, testid: 'kg-stat-files' },
    { key: 'chunks', label: '知识块', value: o.chunks, testid: 'kg-stat-chunks' },
    { key: 'relations', label: '关联关系', value: o.relations, testid: 'kg-stat-relations' },
  ];
});

const categories = computed<KgCategorySummary[]>(() => store.categoryList);

function pick(category: KgCategorySummary): void {
  void store.pickCategory(category.id);
}

function showAll(): void {
  void store.pickCategory(null);
}

function refresh(): void {
  void store.loadOverview(true);
}
</script>

<template>
  <aside class="kg-overview" data-testid="kg-overview">
    <div class="kg-overview__head">
      <h2 class="kg-overview__title">图谱概览</h2>
      <div class="kg-overview__ops">
        <button class="kg-overview__iconbtn" type="button" data-testid="kg-overview-refresh" title="重新统计" @click="refresh">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M20 12a8 8 0 1 1-2.4-5.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M20 4.2v4.2h-4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button
          class="kg-overview__iconbtn"
          type="button"
          data-testid="kg-overview-collapse"
          title="收起图谱概览"
          aria-label="收起图谱概览"
          aria-expanded="true"
          @click="emit('collapse')"
        >
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
            <path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <p v-if="store.overviewLoading" class="text-muted kg-overview__hint">统计加载中…</p>

    <div class="kg-overview__stats" data-testid="kg-stats">
      <div v-for="item in stats" :key="item.key" class="kg-stat" :data-testid="item.testid">
        <span class="kg-stat__value">{{ item.value }}</span>
        <span class="kg-stat__label">{{ item.label }}</span>
      </div>
    </div>

    <AppEmpty
      v-if="!categories.length && !store.overviewLoading"
      compact
      title="暂无可见的分类节点"
      description="图谱按你有权访问的档案统计。若档案已完成著录与正文提取，可在此查看分类分布。"
    />
    <template v-else>
      <div class="kg-overview__section">
        <span class="kg-overview__section-title">档案分类</span>
        <button class="kg-cat kg-cat--all" :class="{ 'is-active': store.viewMode === 'panorama' }" type="button" data-testid="kg-cat-all" @click="showAll">
          全景（全部分类）
        </button>
      </div>
      <ul class="kg-cat-list" data-testid="kg-category-list">
        <li v-for="item in categories" :key="item.key">
          <button
            class="kg-cat"
            :class="{ 'is-active': store.viewMode === 'category' && store.activeCategoryId === item.id }"
            :style="{ paddingLeft: `${8 + Math.max(0, item.depth - 1) * 12}px` }"
            type="button"
            :data-testid="`kg-cat-${item.id}`"
            :title="`${item.name}：可见档案 ${item.subtreeArchiveCount} 件`"
            @click="pick(item)"
          >
            <span class="kg-cat__name">{{ item.name }}</span>
            <span class="kg-cat__num">{{ item.subtreeArchiveCount }}</span>
          </button>
        </li>
      </ul>
    </template>

    <p v-if="store.overview.notBuilt" class="text-muted kg-overview__hint">
      尚未发现图谱节点，可能需要在档案管理页完成正文提取后重建知识图谱。
    </p>
    <p v-else class="text-muted kg-overview__hint">点击分类可在中间画布只看该分类及其下层内容。</p>
  </aside>
</template>

<style scoped>
.kg-overview {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  padding: 14px;
  /* 栏内独立滚动：父级是固定高度三栏，不能靠内容自撑高度后裁切 */
  overflow-y: auto;
  overscroll-behavior-y: contain;
  -webkit-overflow-scrolling: touch;
  background: var(--kg-panel, var(--bg-card));
  color: var(--kg-text, var(--text-body));
}
.kg-overview__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.kg-overview__ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
}
.kg-overview__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--kg-text, var(--text-title));
}
.kg-overview__iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--kg-border, var(--border-light));
  border-radius: 6px;
  background: transparent;
  color: var(--kg-text-muted, var(--text-muted));
  cursor: pointer;
}
.kg-overview__iconbtn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.kg-overview__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.kg-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px;
  border: 1px solid var(--kg-border, var(--border-light));
  border-radius: 10px;
  background: var(--kg-stat-bg, rgba(22, 93, 255, 0.03));
}
.kg-stat__value {
  font-size: 19px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--color-primary);
  font-variant-numeric: tabular-nums;
}
.kg-stat__label {
  font-size: 12px;
  color: var(--kg-text-muted, var(--text-muted));
}
.kg-overview__section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 2px;
}
.kg-overview__section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--kg-text, var(--text-title));
}
.kg-cat-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.kg-cat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  font-size: 13px;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.kg-cat:hover {
  background: var(--color-primary-soft);
}
.kg-cat.is-active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-weight: 600;
}
.kg-cat--all {
  width: auto;
}
.kg-cat__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kg-cat__num {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  color: var(--kg-text-muted, var(--text-muted));
}
.kg-overview__hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}
</style>
