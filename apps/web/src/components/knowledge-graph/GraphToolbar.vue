<script setup lang="ts">
/**
 * 图谱页顶部操作栏：返回 / 标题 / 全局搜索 / 全景·分类切换 / 明暗主题。
 * 只调用 store 动作，不直接发请求；视图切换后由页面触发 loadLayer（缓存命中不会重复请求）。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useKnowledgeGraphStore } from '../../stores/knowledgeGraph.ts';

const store = useKnowledgeGraphStore();
const router = useRouter();

const activeCategoryName = computed(() => {
  const id = store.activeCategoryId;
  if (id == null) return '';
  return store.categoryList.find((item) => item.id === id)?.name ?? '';
});

function back(): void {
  // 有历史则返回上一页，直接进图谱页时回档案检索
  if (window.history.state?.back) router.back();
  else router.push('/archives');
}

function switchMode(mode: 'panorama' | 'category'): void {
  if (mode === 'panorama') {
    store.setViewMode('panorama');
    void store.loadLayer();
    return;
  }
  const target = store.activeCategoryId ?? store.categoryList[0]?.id ?? null;
  if (target == null) return;
  void store.pickCategory(target);
}

function toggleTheme(): void {
  store.setTheme(store.theme === 'light' ? 'dark' : 'light');
}
</script>

<template>
  <header class="kg-toolbar" data-testid="kg-toolbar">
    <button class="kg-toolbar__back" type="button" data-testid="kg-back" title="返回" @click="back">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M14.5 5.5L8 12l6.5 6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>返回</span>
    </button>

    <h1 class="kg-toolbar__title">档案知识图谱</h1>

    <div class="kg-toolbar__search">
      <slot name="search" />
    </div>

    <div class="kg-toolbar__modes" role="tablist" aria-label="图谱视图">
      <button
        class="kg-toolbar__mode"
        :class="{ 'is-active': store.viewMode === 'panorama' }"
        type="button"
        role="tab"
        :aria-selected="store.viewMode === 'panorama'"
        data-testid="kg-mode-panorama"
        @click="switchMode('panorama')"
      >
        全景视图
      </button>
      <button
        class="kg-toolbar__mode"
        :class="{ 'is-active': store.viewMode === 'category' }"
        type="button"
        role="tab"
        :aria-selected="store.viewMode === 'category'"
        data-testid="kg-mode-category"
        @click="switchMode('category')"
      >
        分类视图<span v-if="activeCategoryName" class="kg-toolbar__mode-sub">{{ activeCategoryName }}</span>
      </button>
    </div>

    <button class="kg-toolbar__theme" type="button" data-testid="kg-theme" :title="store.theme === 'light' ? '切换暗色' : '切换亮色'" @click="toggleTheme">
      <svg v-if="store.theme === 'light'" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M20 14.2A8 8 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6" />
        <path
          d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </header>
</template>

<style scoped>
.kg-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--kg-border, var(--border-light));
  background: var(--kg-panel, var(--bg-card));
}
.kg-toolbar__back {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: transparent;
  color: var(--kg-text, var(--text-body));
  font-size: 13px;
  cursor: pointer;
}
.kg-toolbar__back:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.kg-toolbar__title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--kg-text, var(--text-title));
  white-space: nowrap;
}
.kg-toolbar__search {
  display: flex;
  justify-content: center;
  flex: 1;
  min-width: 0;
}
.kg-toolbar__modes {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--kg-seg-bg, rgba(22, 93, 255, 0.06));
}
.kg-toolbar__mode {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 13px;
  color: var(--kg-text-muted, var(--text-muted));
  cursor: pointer;
}
.kg-toolbar__mode.is-active {
  background: var(--kg-panel, #fff);
  color: var(--color-primary);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
}
.kg-toolbar__mode-sub {
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.kg-toolbar__theme {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: transparent;
  color: var(--kg-text, var(--text-body));
  cursor: pointer;
}
.kg-toolbar__theme:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

@media (max-width: 1023px) {
  .kg-toolbar__title {
    font-size: 15px;
  }
}
</style>
