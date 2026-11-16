<script setup lang="ts">
/**
 * 我的借阅：列出本人提交的借阅申请及状态。真实调后端。
 * 借阅中（approved）且归属本人/管理员可归还：POST /borrow-requests/:id/return。
 * 归还后受限授权立即失效（后端档案级判定）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { useRouter } from 'vue-router';
import type { BorrowRequestView } from '../types';
import { useFlash } from '../toast';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppPagination from '../components/ui/AppPagination.vue';
import { confirmDialog } from '../components/ui/dialog';

const router = useRouter();

const rows = ref<BorrowRequestView[]>([]);
const loading = ref(false);
const acting = ref<number | null>(null);
/** 列表分页：每页 10 条，超过一页才出现分页控件。 */
const page = reactive({ page: 1, pageSize: 10 });
const pagedRows = computed(() =>
  rows.value.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
);
/** 归还/加载结果提示走右上角浮层，页面内不常驻。 */
const { error, notice } = useFlash();

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    rows.value = await api.get<BorrowRequestView[]>('/borrow-requests/mine');
    page.page = Math.min(page.page, Math.max(1, Math.ceil(rows.value.length / page.pageSize)));
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

async function doReturn(r: BorrowRequestView) {
  if (acting.value) return;
  const ok = await confirmDialog({
    title: '归还借阅',
    message: `确认归还档案「${r.archiveTitle}」的借阅？归还后将立即失去访问授权。`,
    confirmText: '确认归还',
    danger: true,
  });
  if (!ok) return;
  acting.value = r.id;
  error.value = '';
  notice.value = '';
  try {
    await api.post<BorrowRequestView>(`/borrow-requests/${r.id}/return`);
    notice.value = '已归还，授权撤销。';
    await reload();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    acting.value = null;
  }
}

function statusClass(status: BorrowRequestView['status']): string {
  if (status === 'approved') return 'badge badge-success';
  if (status === 'rejected' || status === 'expired') return 'badge badge-muted';
  if (status === 'pending') return 'badge';
  return 'badge badge-muted';
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

onMounted(reload);
</script>

<template>
  <div>
    <h2 class="page-title">我的借阅</h2>
    <p class="text-muted page-desc">
      查看本人借阅申请的审核进度与授权状态。
      <a class="link" @click="router.push('/borrow')">前往借阅目录 →</a>
    </p>

    <section class="card">
      <div class="card-title">借阅记录<span class="badge badge-muted" v-if="loading">加载中…</span></div>
      <div class="table-scroll" v-if="rows.length">
        <table class="table">
        <colgroup>
          <col class="col-no" />
          <col />
          <col class="col-purpose" />
          <col class="col-days" />
          <col class="col-status" />
          <col class="col-note" />
          <col class="col-due" />
          <col class="col-ops" />
        </colgroup>
        <thead>
          <tr>
            <th>档号</th>
            <th>档案标题</th>
            <th>用途</th>
            <th>期限</th>
            <th>状态</th>
            <th>审核意见</th>
            <th>授权到期</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in pagedRows" :key="r.id">
            <td class="mono ellipsis" :title="r.archiveNo">{{ r.archiveNo }}</td>
            <td><a class="link" @click="router.push(`/archives/${r.archiveId}`)">{{ r.archiveTitle }}</a></td>
            <td class="wrap">{{ r.purpose }}</td>
            <td class="nowrap">{{ r.days }} 天</td>
            <td class="nowrap"><span :class="statusClass(r.status)">{{ r.statusLabel }}</span></td>
            <td class="wrap">{{ r.reviewNote || '—' }}</td>
            <td class="nowrap">{{ fmt(r.dueAt) }}</td>
            <td class="nowrap">
              <button
                v-if="r.canReturn"
                class="btn btn-sm"
                :disabled="acting === r.id"
                @click="doReturn(r)"
              >
                {{ acting === r.id ? '归还中…' : '归还' }}
              </button>
              <span v-else class="text-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <AppEmpty
        v-else-if="!loading"
        title="暂无借阅记录"
        description="请到「借阅管理」提交借阅申请。"
      />
      <AppPagination
        :page="page.page"
        :total="rows.length"
        :page-size="page.pageSize"
        :disabled="loading"
        @update:page="(p) => (page.page = p)"
      />
    </section>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.link { color: var(--color-primary); cursor: pointer; }
.mono { font-family: Consolas, Monaco, monospace; font-size: 13px; }
.wrap { max-width: 240px; white-space: normal; word-break: break-word; }
/* 固定列宽：状态列按最长文案「已批准（借阅中）」预留，窄屏由 .table-scroll 横向滚动兜底，不挤压状态标签 */
.table { table-layout: fixed; min-width: 1050px; }
.col-no { width: 130px; }
.col-purpose { width: 120px; }
.col-days { width: 70px; }
.col-status { width: 160px; }
.col-note { width: 160px; }
.col-due { width: 180px; }
.col-ops { width: 105px; }
.nowrap { white-space: nowrap; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
