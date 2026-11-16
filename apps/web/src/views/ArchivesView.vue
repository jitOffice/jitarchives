<script setup lang="ts">
/**
 * 档案资源管理列表页（阶段二第二批）：
 * 标题/档号/关键词检索 + 分类筛选 + 分页，数据全部来自后端 SQLite（无前端假数据）。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../perms';
import type { ArchiveListView, ArchiveView, CategoryView } from '../types';
import { useFlash } from '../toast';
import AppSelect from '../components/ui/AppSelect.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppLoading from '../components/ui/AppLoading.vue';
import AppPagination from '../components/ui/AppPagination.vue';
import { confirmDialog } from '../components/ui/dialog';

const props = defineProps<{ searchMode?: boolean }>();

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const categories = ref<CategoryView[]>([]);
const result = ref<ArchiveListView | null>(null);
const loading = ref(false);
/** 检索失败提示走右上角浮层，不常驻列表页。 */
const { error, notice } = useFlash();
/** 正在删除的档案 id：删除期间禁用该行按钮，防重复提交。 */
const deletingId = ref<number | null>(null);

const filters = reactive({
  q: '',
  categoryId: '' as string,
  status: '' as string,
  page: 1,
  pageSize: 10,
});

const items = computed<ArchiveView[]>(() => result.value?.items ?? []);
const total = computed(() => result.value?.total ?? 0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / filters.pageSize)));
const canManage = computed(() => can(auth.user?.role, 'archiveManage'));

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '加载失败，请稍后重试';
}

/** 分类下拉：带层级缩进，真实统计各分类档案数。 */
const categoryOptions = computed(() =>
  [...categories.value]
    .sort((a, b) => a.pathCode.localeCompare(b.pathCode))
    .map((c) => ({ id: c.id, label: `${'　'.repeat(c.depth)}${c.name}（${c.archiveCount}）` })),
);

/** 下拉选项：首项为「全部分类」，保证选中后仍可回到不筛选。 */
const categorySelectOptions = computed(() => [
  { label: '全部分类', value: '' },
  ...categoryOptions.value.map((c) => ({ label: c.label, value: String(c.id) })),
]);

const statusSelectOptions = [
  { label: '全部状态', value: '' },
  { label: '草稿（可著录）', value: 'draft' },
  { label: '已归档（只读）', value: 'archived' },
];

async function loadCategories() {
  try {
    categories.value = await api.get<CategoryView[]>('/categories');
  } catch (e) {
    error.value = errMsg(e);
  }
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const qs = new URLSearchParams();
    if (filters.q.trim()) qs.set('q', filters.q.trim());
    if (filters.categoryId) qs.set('categoryId', filters.categoryId);
    if (filters.status) qs.set('status', filters.status);
    qs.set('page', String(filters.page));
    qs.set('pageSize', String(filters.pageSize));
    result.value = await api.get<ArchiveListView>(`/archives?${qs.toString()}`);
  } catch (e) {
    error.value = errMsg(e);
    result.value = null;
  } finally {
    loading.value = false;
  }
}

function search() {
  filters.page = 1;
  load();
}

function goPage(p: number) {
  if (p < 1 || p > totalPages.value || p === filters.page) return;
  filters.page = p;
  load();
}

/**
 * 删除草稿档案（仅草稿可删，后端二次强制）：二次确认后调用接口，
 * 成功后回到上一页（当前页只剩这一条时）并重新拉取列表，数据以服务端为准。
 */
async function removeArchive(a: ArchiveView) {
  if (deletingId.value !== null) return;
  const ok = await confirmDialog({
    title: '删除档案',
    message: `确认删除草稿档案「${a.title}」（档号 ${a.archiveNo}）？档案下的附件与著录信息将一并删除，且不可恢复。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  deletingId.value = a.id;
  try {
    await api.del<{ ok: true }>(`/archives/${a.id}`);
    notice.value = `已删除档案「${a.title}」`;
    if (items.value.length === 1 && filters.page > 1) filters.page -= 1;
    await load();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    deletingId.value = null;
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

watch(
  () => props.searchMode,
  () => load(),
);

onMounted(() => {
  // 支持从分类目录带 query 进入（?categoryId= / ?q=）
  const q = route.query.q;
  const categoryId = route.query.categoryId;
  const status = route.query.status;
  if (typeof q === 'string') filters.q = q;
  if (typeof categoryId === 'string') filters.categoryId = categoryId;
  if (status === 'draft' || status === 'archived') filters.status = status;
  loadCategories();
  load();
});
</script>

<template>
  <div>
    <h2 class="page-title">{{ props.searchMode ? '档案检索利用' : '档案资源管理' }}</h2>
    <p class="text-muted page-desc">
      {{
        props.searchMode
          ? '按标题、档号、关键词检索档案，支持分类范围筛选；检索由后端在数据库中真实执行。'
          : '档案目录与著录信息来自服务器数据库；支持检索、筛选、分页与新建档案著录。'
      }}
    </p>


    <section class="card filter-card">
      <form class="filters" @submit.prevent="search">
        <div class="field grow">
          <label for="f-q">关键词（标题 / 档号 / 关键词）</label>
          <input id="f-q" v-model="filters.q" placeholder="输入检索内容，留空展示全部" @keyup.enter="search" />
        </div>
        <div class="field">
          <label for="f-cat">所属分类（含子分类）</label>
          <AppSelect
            id="f-cat"
            v-model="filters.categoryId"
            :options="categorySelectOptions"
            placeholder="全部分类"
            @change="search"
          />
        </div>
        <div class="field">
          <label for="f-status">状态</label>
          <AppSelect
            id="f-status"
            v-model="filters.status"
            :options="statusSelectOptions"
            placeholder="全部状态"
            @change="search"
          />
        </div>
        <div class="field btn-field">
          <button class="btn btn-primary" type="submit" :disabled="loading">
            {{ loading ? '检索中…' : '检索' }}
          </button>
        </div>
      </form>
    </section>

    <section class="card" style="margin-top: 20px">
      <div class="card-title">
        档案列表
        <span class="badge badge-muted" v-if="result">共 {{ total }} 条</span>
        <AppLoading v-if="loading" text="加载中…" inline />
        <button
          v-if="canManage && !props.searchMode"
          class="btn btn-primary btn-sm push-right"
          @click="router.push('/archives/new')"
        >
          新建档案
        </button>
      </div>

      <div class="table-scroll" v-if="items.length">
        <table class="table">
        <colgroup>
          <col />
          <col class="col-no" />
          <col class="col-cat" />
          <col class="col-type" />
          <col class="col-status" />
          <col class="col-time" />
          <col class="col-owner" />
          <col class="col-ops" />
        </colgroup>
        <thead>
          <tr>
            <th>档案标题</th>
            <th>档号</th>
            <th>所属分类</th>
            <th>类型</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>创建人</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in items" :key="a.id">
            <td class="cell-title">
              <a class="link" :title="a.title" @click="router.push(`/archives/${a.id}`)">{{ a.title }}</a>
            </td>
            <td class="mono">{{ a.archiveNo }}</td>
            <td>{{ a.categoryName }}</td>
            <td>{{ a.archiveType }}</td>
            <td class="cell-status">
              <span :class="a.status === 'archived' ? 'badge badge-success' : 'badge'">
                {{ a.status === 'archived' ? '已归档' : '草稿' }}
              </span>
            </td>
            <td class="cell-time">{{ fmtDate(a.createdAt) }}</td>
            <td>{{ a.createdByName }}</td>
            <td class="cell-ops">
              <button class="btn btn-sm" @click="router.push(`/archives/${a.id}`)">详情</button>
              <button
                v-if="canManage && a.status === 'draft'"
                class="btn btn-sm btn-danger"
                :disabled="deletingId === a.id"
                @click="removeArchive(a)"
              >
                {{ deletingId === a.id ? '删除中…' : '删除' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>

      <AppEmpty
        v-else-if="!loading && filters.q"
        :description="`未检索到匹配「${filters.q}」的档案，请调整关键词或筛选条件。`"
      />
      <AppEmpty
        v-else-if="!loading"
        title="暂无档案记录"
        :description="canManage ? '点击右上角「新建档案」开始著录。' : '当前角色仅可查看，著录请联系档案管理员。'"
      />

      <AppPagination
        :page="filters.page"
        :total="total"
        :page-size="filters.pageSize"
        :disabled="loading"
        @update:page="goPage"
      />
    </section>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.filters { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; }
.filters .field { margin-bottom: 0; }
.filters .grow { flex: 1; min-width: 220px; }
.filters .btn-field { padding-bottom: 1px; }
.push-right { margin-left: auto; }
.link { color: var(--color-primary); cursor: pointer; text-decoration: none; }
.link:hover { text-decoration: underline; }

/* 固定列宽：短列不参与挤压，标题列吃掉剩余空间，窄屏由 .table-scroll 横向滚动兜底 */
.table { table-layout: fixed; min-width: 1060px; }
.table th { white-space: nowrap; }
/* 短列宽度取内容自然宽度：既不折行，也不多占标题列空间；状态列按徽章宽预留 */
.col-no { width: 152px; }
.col-cat { width: 144px; }
.col-type { width: 86px; }
.col-status { width: 82px; }
.col-time { width: 162px; }
.col-owner { width: 104px; }
.col-ops { width: 148px; }
/* 标题最多两行，超出截断显示省略号（全文由 title 提示） */
.cell-title .link {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
/* 状态徽章与操作按钮始终保持单行，与宽屏显示一致 */
.cell-status,
.cell-ops { white-space: nowrap; }
.cell-ops .btn + .btn { margin-left: 8px; }
.cell-status .badge { white-space: nowrap; }
/* 创建时间单行展示（日期 + 时间），窄屏由表格横向滚动兑现 */
.cell-time { white-space: nowrap; }
.mono { font-family: Consolas, Monaco, monospace; font-size: 13px; }

/* 移动端：筛选项单列排布，表格横向滚动 */
@media (max-width: 767px) {
  .filters { gap: 12px; }
  .filters .grow { flex: 1 1 100%; min-width: 0; }
  .filters .field { flex: 1 1 100%; }
  .filters .btn-field .btn { width: 100%; }
  .filters .btn-field { padding-bottom: 0; }
}
</style>
