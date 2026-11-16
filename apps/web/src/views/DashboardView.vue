<script setup lang="ts">
/**
 * 工作台 · 数据大盘。
 *
 * 全部统计均来自后端 /api/dashboard/stats 的真实数据库聚合（只读接口），
 * 前端不写死任何数字、不使用模拟数据；角色口径由后端按会话权限决定。
 * 页面主体为业务指标、趋势与分布，待办与快捷入口只作辅助。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../perms';
import type {
  DashboardRangeKey,
  DashboardStatsView,
  DashboardTodoView,
} from '../types';
import MetricCard from '../components/dashboard/MetricCard.vue';
import TrendChart from '../components/dashboard/TrendChart.vue';
import DonutChart from '../components/dashboard/DonutChart.vue';
import BreakdownBars from '../components/dashboard/BreakdownBars.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppLoading from '../components/ui/AppLoading.vue';

const auth = useAuthStore();

const RANGES: Array<{ key: DashboardRangeKey; label: string }> = [
  { key: '7d', label: '最近 7 天' },
  { key: '30d', label: '最近 30 天' },
  { key: '90d', label: '最近 90 天' },
];
const RANGE_STORAGE_KEY = 'jit.dashboard.range';

function initialRange(): DashboardRangeKey {
  const saved = localStorage.getItem(RANGE_STORAGE_KEY);
  const hit = RANGES.find((r) => r.key === saved);
  return hit ? hit.key : '30d';
}

const range = ref<DashboardRangeKey>(initialRange());
const stats = ref<DashboardStatsView | null>(null);
const loading = ref(false);
const loadError = ref('');

const ARCHIVE_STATUS_COLORS: Record<string, string> = {
  archived: '#165DFF',
  draft: '#FF7D00',
};
const BORROW_STATUS_COLORS: Record<string, string> = {
  pending: '#FF7D00',
  approved: '#00B42A',
  rejected: '#F53F3F',
  returned: '#165DFF',
  expired: '#86909C',
  cancelled: '#C9CDD4',
};

const trendLabels = computed(() => stats.value?.archiveTrend.points.map((p) => p.day) ?? []);
const archiveSeries = computed(() => [
  {
    key: 'archives',
    label: '新增档案',
    color: '#165DFF',
    values: stats.value?.archiveTrend.points.map((p) => p.count) ?? [],
  },
]);

const borrowLabels = computed(() => stats.value?.borrow.trend.map((p) => p.day) ?? []);
const borrowSeries = computed(() => [
  {
    key: 'borrow',
    label: '借阅申请',
    color: '#FF7D00',
    values: stats.value?.borrow.trend.map((p) => p.count) ?? [],
  },
]);

const utilizationLabels = computed(() => stats.value?.utilization.series.map((p) => p.day) ?? []);
const utilizationSeries = computed(() => {
  const series = stats.value?.utilization.series ?? [];
  return [
    { key: 'preview', label: '在线预览', color: '#165DFF', values: series.map((p) => p.preview) },
    { key: 'download', label: '附件下载', color: '#36CFC9', values: series.map((p) => p.download) },
    { key: 'borrow', label: '借阅申请', color: '#FF7D00', values: series.map((p) => p.borrow) },
  ];
});

const archivedMetric = computed(() => stats.value?.metrics.find((m) => m.key === 'archived'));
const draftMetric = computed(() => stats.value?.metrics.find((m) => m.key === 'draft'));

const todoless = computed(() => (stats.value?.todos.length ?? 0) === 0);

const shortcuts = computed(() => {
  const role = auth.user?.role;
  const list: Array<{ label: string; to: string; hint: string }> = [];
  if (can(role, 'archiveManage')) list.push({ label: '新建档案', to: '/archives/new', hint: '著录新档案' });
  if (can(role, 'archiveView')) list.push({ label: '档案检索', to: '/archives/search', hint: '按题名或档号查找' });
  if (can(role, 'borrowReview')) list.push({ label: '借阅审核', to: '/borrow/review', hint: '处理待审申请' });
  if (can(role, 'borrowRequest')) list.push({ label: '我的借阅', to: '/borrow/mine', hint: '查看借阅进度' });
  if (can(role, 'categoryView')) list.push({ label: '档案分类', to: '/archives/categories', hint: '维护分类目录' });
  if (can(role, 'auditView')) list.push({ label: '操作审计', to: '/audit', hint: '追溯关键操作' });
  if (auth.isAdmin) list.push({ label: '系统信息', to: '/system', hint: '运行与账号概况' });
  return list.slice(0, 6);
});

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return '统计数据加载失败，请稍后重试';
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    stats.value = await api.get<DashboardStatsView>(`/dashboard/stats?range=${range.value}`);
  } catch (e) {
    loadError.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

function selectRange(key: DashboardRangeKey): void {
  if (range.value === key) return;
  range.value = key;
}

watch(range, (value) => {
  localStorage.setItem(RANGE_STORAGE_KEY, value);
  load();
});

onMounted(load);

function todoLink(todo: DashboardTodoView): string {
  return todo.to;
}
</script>

<template>
  <div class="dash">
    <header class="dash-head">
      <div class="head-text">
        <h2 class="page-title">数据大盘</h2>
        <p class="page-desc">
          电子档案业务运行概览：档案规模、归档进度、分类结构与借阅审批情况。
          <span v-if="stats">当前统计范围 {{ stats.range.fromDay }} 至 {{ stats.range.toDay }}。</span>
        </p>
      </div>
      <div class="range-tabs" role="group" aria-label="统计时间范围">
        <button
          v-for="r in RANGES"
          :key="r.key"
          type="button"
          :class="{ active: range === r.key }"
          :aria-pressed="range === r.key"
          :disabled="loading"
          @click="selectRange(r.key)"
        >
          {{ r.label }}
        </button>
      </div>
    </header>

    <div v-if="stats" class="scope-bar">
      <span class="scope-tag">{{ stats.scope.roleLabel }}</span>
      <span class="scope-text">{{ stats.scope.note }}</span>
      <span class="scope-divider"></span>
      <span class="scope-meta">档案口径：{{ stats.scope.archiveScopeLabel }}</span>
      <span class="scope-meta">借阅口径：{{ stats.scope.borrowScopeLabel }}</span>
    </div>

    <div v-if="loading && !stats" class="state-card">
      <AppLoading text="正在汇总统计数据…" />
    </div>

    <AppEmpty
      v-else-if="loadError"
      class="state-card"
      variant="error"
      title="统计数据未能加载"
      :description="loadError"
    >
      <template #action>
        <button class="btn btn-primary btn-sm" type="button" @click="load">重新加载</button>
      </template>
    </AppEmpty>

    <template v-else-if="stats">
      <div class="metrics" :class="{ dim: loading }">
        <MetricCard v-for="m in stats.metrics" :key="m.key" :metric="m" />
      </div>

      <div class="row row-main" :class="{ dim: loading }">
        <section class="card chart-card">
          <div class="card-head">
            <div class="card-title">档案新增趋势</div>
            <span class="card-meta">{{ stats.range.label }}新增 {{ stats.archiveTrend.periodTotal }} 篇</span>
          </div>
          <TrendChart
            :labels="trendLabels"
            :series="archiveSeries"
            :height="240"
            unit="篇"
            empty-text="当前时间范围内暂无新增档案"
          />
          <p class="card-note">{{ stats.archiveTrend.hint }}</p>
        </section>

        <section class="card todo-card">
          <div class="card-head">
            <div class="card-title">待办提醒</div>
            <span class="card-meta">按当前角色权限汇总</span>
          </div>
          <ul v-if="!todoless" class="todo-list">
            <li v-for="todo in stats.todos" :key="todo.key">
              <RouterLink :to="todoLink(todo)" class="todo-item">
                <span class="todo-main">
                  <span class="todo-label">{{ todo.label }}</span>
                  <span class="todo-hint">{{ todo.hint }}</span>
                </span>
                <span class="todo-count" :class="{ zero: todo.count === 0 }">
                  {{ todo.count.toLocaleString('zh-CN') }}
                </span>
              </RouterLink>
            </li>
          </ul>
          <AppEmpty
            v-else
            compact
            :description="auth.user?.role === 'guest' ? '访客角色不参与业务办理，无待办事项。' : '当前没有待处理事项，系统运行平稳。'"
          />
        </section>
      </div>

      <div class="row row-three" :class="{ dim: loading }">
        <section class="card">
          <div class="card-head">
            <div class="card-title">档案分类分布</div>
            <span class="card-meta">累计口径</span>
          </div>
          <DonutChart
            :items="stats.categories.items"
            :total="stats.categories.total"
            center-label="累计档案"
            unit="篇"
            empty-text="尚无可统计的档案分类数据"
          />
          <p class="card-note">
            按当前可见范围的累计档案统计{{ stats.categories.truncated ? '，长尾分类已合并显示' : '' }}。
          </p>
        </section>

        <section class="card">
          <div class="card-head">
            <div class="card-title">档案状态统计</div>
            <span class="card-meta">草稿 / 已归档</span>
          </div>
          <BreakdownBars
            :items="stats.statuses.items"
            :total="stats.statuses.total"
            total-label="累计档案"
            unit="篇"
            :colors="ARCHIVE_STATUS_COLORS"
            empty-text="当前范围内暂无档案"
          />
          <div class="mini-row">
            <span>期内新增草稿 <strong>{{ draftMetric?.period ?? 0 }}</strong></span>
            <span>期内新增归档 <strong>{{ archivedMetric?.period ?? 0 }}</strong></span>
          </div>
          <p class="card-note">草稿可继续著录，归档后著录信息只读；比例按累计档案计算。</p>
        </section>

        <section class="card">
          <div class="card-head">
            <div class="card-title">借阅审批统计</div>
            <span class="card-meta">{{ stats.borrow.scopeLabel }}</span>
          </div>
          <template v-if="stats.borrow.available">
            <BreakdownBars
              :items="stats.borrow.items"
              :total="stats.borrow.total"
              total-label="累计申请量"
              unit="条"
              :colors="BORROW_STATUS_COLORS"
              empty-text="暂无借阅申请记录"
            />
            <div class="mini-row">
              <span>期内新申请 <strong>{{ stats.borrow.periodTotal }}</strong></span>
              <span>当前待审核 <strong>{{ stats.borrow.pending }}</strong></span>
            </div>
            <div class="sub-chart">
              <div class="sub-title">{{ stats.range.label }}借阅申请趋势</div>
              <TrendChart
                :labels="borrowLabels"
                :series="borrowSeries"
                :height="150"
                unit="条"
                empty-text="当前时间范围内暂无借阅申请"
              />
            </div>
          </template>
          <AppEmpty v-else compact :description="stats.borrow.reason" />
        </section>
      </div>

      <div class="row row-main" :class="{ dim: loading }">
        <section class="card">
          <div class="card-head">
            <div class="card-title">档案利用情况</div>
            <span class="card-meta">{{ stats.utilization.available ? stats.range.label : '权限范围外' }}</span>
          </div>
          <template v-if="stats.utilization.available">
            <div class="usage-totals">
              <div class="usage-item">
                <span class="usage-label">在线预览</span>
                <strong>{{ stats.utilization.totals.preview }}</strong>
              </div>
              <div class="usage-item">
                <span class="usage-label">附件下载</span>
                <strong>{{ stats.utilization.totals.download }}</strong>
              </div>
              <div class="usage-item">
                <span class="usage-label">借阅申请</span>
                <strong>{{ stats.utilization.totals.borrow }}</strong>
              </div>
            </div>
            <TrendChart
              :labels="utilizationLabels"
              :series="utilizationSeries"
              :height="220"
              unit="次"
              empty-text="当前时间范围内暂无预览、下载或借阅记录"
            />
            <p class="card-note">{{ stats.utilization.sourceLabel }}</p>
          </template>
          <AppEmpty v-else compact :description="stats.utilization.reason" />
        </section>

        <section class="card">
          <div class="card-head">
            <div class="card-title">快捷入口</div>
            <span class="card-meta">常用功能</span>
          </div>
          <div class="shortcuts">
            <RouterLink v-for="s in shortcuts" :key="s.to" :to="s.to" class="shortcut">
              <span class="shortcut-label">{{ s.label }}</span>
              <span class="shortcut-hint">{{ s.hint }}</span>
            </RouterLink>
          </div>
          <div class="dash-foot">
            <div>统计生成时间：{{ fmtTime(stats.generatedAt) }}</div>
            <div>数据来源：系统业务数据库实时聚合（只读统计）</div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; gap: 20px; }

.dash-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.page-title { font-size: 22px; margin: 0 0 4px; }
.page-desc { margin: 0; font-size: 13px; color: var(--text-muted); }

.range-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 10px;
  box-shadow: var(--shadow-card);
}
.range-tabs button {
  border: 0;
  background: transparent;
  padding: 6px 16px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--text-body);
  cursor: pointer;
  transition: all 0.15s;
}
.range-tabs button:hover:not(.active) { background: var(--color-primary-soft); color: var(--color-primary); }
.range-tabs button.active { background: var(--color-primary); color: #fff; font-weight: 600; }
.range-tabs button:disabled { cursor: progress; opacity: 0.7; }

.scope-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 9px 14px;
  border-radius: var(--radius-control);
  background: var(--color-primary-soft);
  font-size: 13px;
  color: var(--color-primary);
}
.scope-tag {
  background: var(--color-primary);
  color: #fff;
  border-radius: 20px;
  padding: 0 10px;
  font-size: 12px;
  line-height: 20px;
}
.scope-text { color: var(--text-body); }
.scope-divider { width: 1px; height: 14px; background: rgba(22, 93, 255, 0.25); }
.scope-meta { color: var(--text-muted); font-size: 12px; }

.state-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 220px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  color: var(--text-body);
  font-size: 14px;
}

.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }

.row { display: grid; gap: 20px; }
.row-main { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
.row-three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.dim { opacity: 0.6; pointer-events: none; transition: opacity 0.15s; }

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.card-head .card-title { margin-bottom: 0; }
.card-meta { font-size: 12px; color: var(--text-muted); }
.card-note { margin: 12px 0 0; font-size: 12px; color: var(--text-muted); line-height: 1.6; }
.chart-card { display: flex; flex-direction: column; }

.todo-list { list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.todo-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fcfcfd;
  text-decoration: none;
  transition: all 0.15s;
}
.todo-item:hover { border-color: var(--color-primary); background: var(--color-primary-soft); }
.todo-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.todo-label { font-size: 13px; color: var(--text-title); font-weight: 600; }
.todo-hint { font-size: 12px; color: var(--text-muted); }
.todo-count {
  flex: none;
  min-width: 34px;
  text-align: center;
  padding: 2px 8px;
  border-radius: 20px;
  background: rgba(245, 63, 63, 0.1);
  color: var(--color-danger);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.todo-count.zero { background: #f2f3f5; color: var(--text-muted); }

.mini-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-light);
  font-size: 12px;
  color: var(--text-muted);
}
.mini-row strong { color: var(--text-title); font-variant-numeric: tabular-nums; margin-left: 2px; }

.sub-chart { margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--border-light); }
.sub-title { font-size: 12px; color: var(--text-muted); margin-bottom: 4px; }

.usage-totals { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0 6px; }
.usage-item {
  flex: 1;
  min-width: 96px;
  padding: 10px 14px;
  border-radius: var(--radius-control);
  background: #fafbfc;
  border: 1px solid var(--border-light);
}
.usage-label { display: block; font-size: 12px; color: var(--text-muted); }
.usage-item strong { font-size: 20px; color: var(--text-title); font-variant-numeric: tabular-nums; }

.shortcuts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
.shortcut {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fcfcfd;
  text-decoration: none;
  transition: all 0.15s;
}
.shortcut:hover { border-color: var(--color-primary); background: var(--color-primary-soft); }
.shortcut-label { font-size: 13px; font-weight: 600; color: var(--text-title); }
.shortcut-hint { font-size: 12px; color: var(--text-muted); }

.dash-foot {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px dashed var(--border-light);
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.8;
}

@media (max-width: 1180px) {
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .row-main { grid-template-columns: minmax(0, 1fr); }
  .row-three { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 767px) {
  .dash { gap: 14px; }
  .row { gap: 14px; }
  .page-title { font-size: 20px; }
  .metrics { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .row-three { grid-template-columns: minmax(0, 1fr); }
  .shortcuts { grid-template-columns: minmax(0, 1fr); }
  .scope-divider { display: none; }
  /* 时间范围切换在窄屏铺满一行，每个按钮等宽便于点击 */
  .range-tabs { width: 100%; }
  .range-tabs button { flex: 1; padding: 8px 0; }
  .usage-item { min-width: 0; }
  .usage-totals { gap: 10px; }
}
</style>
