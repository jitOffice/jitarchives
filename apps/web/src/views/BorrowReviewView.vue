<script setup lang="ts">
/**
 * 借阅审核（管理员/审核员）。真实调后端：
 * GET /borrow-requests?status=pending|processed；
 * 通过 POST /borrow-requests/:id/approve（同事务建立档案级授权）；
 * 拒绝 POST /borrow-requests/:id/reject（必须填写审核意见）。
 * 不能审核本人提交的申请（后端二次拦截），重复/并发审批由服务端条件更新拦截。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import type { BorrowRequestView } from '../types';
import { useFlash } from '../toast';
import AppModal from '../components/ui/AppModal.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppPagination from '../components/ui/AppPagination.vue';
import { confirmDialog } from '../components/ui/dialog';

const auth = useAuthStore();

const tab = ref<'pending' | 'processed'>('pending');
const rows = ref<BorrowRequestView[]>([]);
const loading = ref(false);
const acting = ref<number | null>(null);
/** 审批/拒绝结果提示走右上角浮层，页面内不常驻。 */
const { error, notice } = useFlash();

const rejectDialog = reactive({ id: 0, archiveTitle: '', note: '' });

/** 列表分页：每页 10 条，切换待处理/已处理后回到第一页。 */
const page = reactive({ page: 1, pageSize: 10 });
const pagedRows = computed(() =>
  rows.value.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
);

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    rows.value = await api.get<BorrowRequestView[]>(`/borrow-requests?status=${tab.value}`);
    page.page = Math.min(page.page, Math.max(1, Math.ceil(rows.value.length / page.pageSize)));
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

function switchTab(t: 'pending' | 'processed') {
  tab.value = t;
  page.page = 1;
  reload();
}

async function approve(r: BorrowRequestView) {
  if (acting.value) return;
  const ok = await confirmDialog({
    title: '通过借阅申请',
    message: `确认通过「${r.applicantName}」对档案「${r.archiveTitle}」的借阅申请？`,
    confirmText: '确认通过',
  });
  if (!ok) return;
  acting.value = r.id;
  error.value = '';
  notice.value = '';
  try {
    await api.post<BorrowRequestView>(`/borrow-requests/${r.id}/approve`, { note: '' });
    notice.value = '已通过，借阅授权已建立。';
    await reload();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    acting.value = null;
  }
}

function openReject(r: BorrowRequestView) {
  rejectDialog.id = r.id;
  rejectDialog.archiveTitle = r.archiveTitle;
  rejectDialog.note = '';
  error.value = '';
  notice.value = '';
}

function closeReject() {
  rejectDialog.id = 0;
}

async function submitReject() {
  if (acting.value || !rejectDialog.id) return;
  if (!rejectDialog.note.trim()) {
    error.value = '拒绝申请必须填写审核意见';
    return;
  }
  acting.value = rejectDialog.id;
  error.value = '';
  try {
    await api.post<BorrowRequestView>(`/borrow-requests/${rejectDialog.id}/reject`, {
      note: rejectDialog.note.trim(),
    });
    notice.value = '已拒绝该借阅申请。';
    closeReject();
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
    <h2 class="page-title">借阅审核</h2>
    <p class="text-muted page-desc">审核借阅申请：通过后建立档案级借阅授权（查看 + 下载），到期或归还后失效。</p>

    <div class="tabs">
      <button :class="['tab', { on: tab === 'pending' }]" @click="switchTab('pending')">待处理</button>
      <button :class="['tab', { on: tab === 'processed' }]" @click="switchTab('processed')">已处理</button>
    </div>

    <section class="card">
      <div class="card-title">
        {{ tab === 'pending' ? '待处理申请' : '已处理记录' }}
        <span class="badge badge-muted" v-if="loading">加载中…</span>
      </div>
      <div class="table-scroll" v-if="rows.length">
        <table class="table" :class="{ 'tbl-processed': tab === 'processed' }">
        <colgroup v-if="tab === 'pending'">
          <col class="col-no" />
          <col />
          <col class="col-app" />
          <col class="col-purpose" />
          <col class="col-days" />
          <col class="col-created" />
          <col class="col-ops" />
        </colgroup>
        <colgroup v-else>
          <col class="col-no" />
          <col />
          <col class="col-app" />
          <col class="col-purpose" />
          <col class="col-days" />
          <col class="col-created" />
          <col class="col-status" />
          <col class="col-note" />
          <col class="col-ops" />
        </colgroup>
        <thead>
          <tr>
            <th>档号</th>
            <th>档案标题</th>
            <th>申请人</th>
            <th>用途</th>
            <th>期限</th>
            <th>申请时间</th>
            <th v-if="tab === 'processed'">状态</th>
            <th v-if="tab === 'processed'">审核人 / 意见</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in pagedRows" :key="r.id">
            <td class="mono ellipsis" :title="r.archiveNo">{{ r.archiveNo }}</td>
            <td>{{ r.archiveTitle }}</td>
            <td>{{ r.applicantName }}<span class="text-muted" v-if="r.applicantId === auth.user?.id"> ·本人</span></td>
            <td class="wrap">{{ r.purpose }}</td>
            <td class="nowrap">{{ r.days }} 天</td>
            <td class="nowrap">{{ fmt(r.createdAt) }}</td>
            <td v-if="tab === 'processed'" class="nowrap"><span :class="statusClass(r.status)">{{ r.statusLabel }}</span></td>
            <td v-if="tab === 'processed'" class="wrap">{{ r.reviewerName || '—' }}<span v-if="r.reviewNote">：{{ r.reviewNote }}</span></td>
            <td class="nowrap">
              <template v-if="tab === 'pending' && r.applicantId !== auth.user?.id">
                <button class="btn btn-sm btn-primary" :disabled="acting === r.id" @click="approve(r)">通过</button>
                <button class="btn btn-sm" :disabled="acting === r.id" @click="openReject(r)">拒绝</button>
              </template>
              <span v-else class="text-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <AppEmpty
        v-else-if="!loading"
        :title="tab === 'pending' ? '暂无待处理的借阅申请' : '暂无已处理记录'"
      />
      <AppPagination
        :page="page.page"
        :total="rows.length"
        :page-size="page.pageSize"
        :disabled="loading"
        @update:page="(p) => (page.page = p)"
      />
    </section>

    <AppModal
      :open="!!rejectDialog.id"
      title="拒绝借阅申请"
      :subtitle="`档案：${rejectDialog.archiveTitle}`"
      :width="460"
      @update:open="(v) => { if (!v) closeReject(); }"
    >
      <div class="field">
        <label for="r-note">审核意见 <span class="req">*</span></label>
        <textarea
          id="r-note"
          v-model="rejectDialog.note"
          rows="3"
          maxlength="500"
          placeholder="请填写拒绝理由（必填）"
        ></textarea>
      </div>

      <template #footer>
        <div class="actions">
          <button class="btn" type="button" :disabled="!!acting" @click="closeReject">取消</button>
          <button class="btn btn-primary" type="button" :disabled="!!acting" @click="submitReject">
            {{ acting ? '提交中…' : '确认拒绝' }}
          </button>
        </div>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 16px; }
.tabs { display: flex; gap: 8px; margin-bottom: 16px; }
.tab {
  padding: 8px 18px; border: 1px solid var(--border-light); background: #fff;
  border-radius: 8px; cursor: pointer; font-size: 14px; color: var(--text-body);
}
.tab.on { background: var(--color-primary); color: #fff; border-color: var(--color-primary); }
.mono { font-family: Consolas, Monaco, monospace; font-size: 13px; }
.req { color: var(--color-danger); }
.wrap { max-width: 220px; white-space: normal; word-break: break-word; }
.actions { display: flex; gap: 12px; margin-left: auto; }

/* 固定列宽：状态列按最长文案「已批准（借阅中）」预留；已处理页列多，min-width 更大，窄屏由 .table-scroll 横向滚动兜底 */
.table { table-layout: fixed; min-width: 920px; }
.table.tbl-processed { min-width: 1240px; }
.col-no { width: 130px; }
.col-app { width: 90px; }
.col-purpose { width: 120px; }
.col-days { width: 70px; }
.col-created { width: 180px; }
.col-status { width: 160px; }
.col-note { width: 160px; }
.col-ops { width: 140px; }
.nowrap { white-space: nowrap; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 移动端：弹窗按钮适配窄屏 */
@media (max-width: 767px) {
  .actions { width: 100%; }
  .actions .btn { flex: 1; }
}
</style>
