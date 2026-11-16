<script setup lang="ts">
/**
 * 图谱全局搜索框。
 * - 输入走 store.search（后端复用统一全文检索，前端不自己翻数据）；
 * - 本地 260ms 防抖，过期响应由 store 的请求序号守卫丢弃；
 * - 结果按分类 / 档案 / 附件 / 知识块分组展示，点击即定位画布节点并联动右栏详情。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import AppEmpty from '../ui/AppEmpty.vue';
import { useKnowledgeGraphStore } from '../../stores/knowledgeGraph.ts';
import { KG_NODE_STYLES } from '../../lib/knowledge-graph/styles.ts';
import type { KgNodeType, KgSearchHit } from '../../lib/knowledge-graph/types.ts';

const store = useKnowledgeGraphStore();
const text = ref(store.keyword);
const open = ref(false);
const input = ref<HTMLInputElement | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

type KgSearchGroup = { type: KgNodeType; label: string; hits: KgSearchHit[] };

const grouped = computed<KgSearchGroup[]>(() => {
  const groups = store.searchResult?.groups;
  if (!groups) return [];
  const types: KgNodeType[] = ['category', 'archive', 'file', 'chunk'];
  return types
    .map((type) => ({ type, label: KG_NODE_STYLES[type].label, hits: groups[type] }))
    .filter((group) => group.hits.length > 0);
});

const total = computed(() => store.searchResult?.total ?? 0);
const showEmpty = computed(() => !store.searching && !!store.searchResult && total.value === 0);

watch(text, (value) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    store.search(value);
  }, 260);
});

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

async function pick(hit: KgSearchHit): Promise<void> {
  open.value = false;
  await store.locateHit(hit);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    open.value = false;
    input.value?.blur();
  }
}

function clear(): void {
  text.value = '';
  store.clearSearch();
  open.value = false;
}

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="kg-search" data-testid="kg-search" @keydown="onKeydown">
    <div class="kg-search__box">
      <svg class="kg-search__icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <circle cx="11" cy="11" r="6.4" fill="none" stroke="currentColor" stroke-width="1.8" />
        <path d="M16 16l4.4 4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <input
        ref="input"
        v-model="text"
        class="kg-search__input"
        type="search"
        maxlength="80"
        placeholder="搜索档号、档案名称、分类、附件或正文"
        aria-label="图谱搜索"
        data-testid="kg-search-input"
        @focus="open = true"
      />
      <button v-if="text" class="kg-search__clear" type="button" aria-label="清空搜索" @click="clear">×</button>
      <span v-if="store.searching" class="badge badge-muted">搜索中…</span>
    </div>

    <div v-if="open && (grouped.length || showEmpty || store.searchError)" class="kg-search__panel" data-testid="kg-search-panel">
      <p v-if="store.searchError" class="kg-search__error" data-testid="kg-search-error">{{ store.searchError }}</p>
      <AppEmpty
        v-else-if="showEmpty"
        compact
        title="没有找到匹配的档案知识"
        description="换个关键词试试，例如档号片段、档案标题或正文中的词。"
      />
      <template v-else>
        <div v-for="group in grouped" :key="group.type" class="kg-search__group">
          <div class="kg-search__group-title">
            <span class="kg-search__dot" :style="{ background: KG_NODE_STYLES[group.type].stroke }"></span>
            {{ group.label }}<span class="kg-search__num">{{ group.hits.length }}</span>
          </div>
          <button
            v-for="hit in group.hits"
            :key="`${hit.type}-${hit.refId}-${hit.key ?? 'loose'}`"
            class="kg-search__hit"
            type="button"
            :data-testid="`kg-search-hit-${hit.type}`"
            @click="pick(hit)"
          >
            <span class="kg-search__hit-title">{{ hit.title }}</span>
            <span class="kg-search__hit-sub">{{ hit.subtitle }}</span>
            <span v-if="hit.locator" class="kg-search__hit-loc">{{ hit.locator }}</span>
          </button>
        </div>
        <p class="kg-search__foot text-muted">
          结果只包含你有权访问的档案
          <button class="kg-search__close" type="button" @click="open = false">收起</button>
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.kg-search {
  position: relative;
  flex: 1;
  min-width: 200px;
  max-width: 460px;
}
.kg-search__box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  height: 34px;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: var(--kg-input-bg, #fff);
  color: var(--text-muted);
}
.kg-search__box:focus-within {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-soft);
}
.kg-search__input {
  flex: 1;
  border: 0;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--kg-text, var(--text-title));
  min-width: 0;
}
/* 浏览器原生的 search 清除按钮与自绘的「清空搜索」按钮重叠（两个 ×），只保留后者。 */
.kg-search__input::-webkit-search-cancel-button,
.kg-search__input::-webkit-search-decoration {
  -webkit-appearance: none;
  appearance: none;
  display: none;
}
.kg-search__clear {
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  cursor: pointer;
  line-height: 1;
}
.kg-search__panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  z-index: 30;
  max-height: 62vh;
  overflow-y: auto;
  padding: 8px;
  border: 1px solid var(--border-light);
  border-radius: 10px;
  background: var(--kg-panel, var(--bg-card));
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.1);
}
.kg-search__group + .kg-search__group {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-light);
}
.kg-search__group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--kg-text, var(--text-title));
  padding: 2px 4px;
}
.kg-search__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.kg-search__num {
  font-family: Consolas, Monaco, monospace;
  color: var(--text-muted);
  font-weight: 400;
}
.kg-search__hit {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
}
.kg-search__hit:hover {
  background: var(--color-primary-soft);
}
.kg-search__hit-title {
  font-size: 13px;
  color: var(--kg-text, var(--text-title));
}
.kg-search__hit-sub,
.kg-search__hit-loc {
  font-size: 12px;
  color: var(--text-muted);
}
.kg-search__error {
  margin: 4px;
  font-size: 12px;
  color: var(--color-danger);
}
.kg-search__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 6px 4px 0;
  font-size: 12px;
}
.kg-search__close {
  border: 0;
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 12px;
}
</style>
