<script setup lang="ts">
/**
 * 借阅管理（目录 + 申请）。真实调后端：
 * GET /borrow-requests/catalog 列出可发现并申请借阅的受限档案；
 * POST /borrow-requests 提交借阅申请（用途 + 期限 1-90 天）。
 * 是否可见/可下载一律由后端档案级判定，本页仅提交与展示。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { useRouter } from 'vue-router';
import type { BorrowCatalogItem } from '../types';
import { useFlash } from '../toast';
import AppModal from '../components/ui/AppModal.vue';
import AppNumberInput from '../components/ui/AppNumberInput.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppPagination from '../components/ui/AppPagination.vue';

const router = useRouter();

const items = ref<BorrowCatalogItem[]>([]);
const loading = ref(false);
const submitting = ref(false);
/** 申请/加载结果提示走右上角浮层，不常驻目录页。 */
const { error, notice } = useFlash();

const apply = reactive({ archiveId: 0, archiveTitle: '', purpose: '', days: 30 as string | number });

/** 列表分页：每页 10 条，超过一页才出现分页控件。 */
const page = reactive({ page: 1, pageSize: 10 });
const pagedItems = computed(() =>
  items.value.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
);

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    items.value = await api.get<BorrowCatalogItem[]>('/borrow-requests/catalog');
    page.page = Math.min(page.page, Math.max(1, Math.ceil(items.value.length / page.pageSize)));
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

function openApply(item: BorrowCatalogItem) {
  apply.archiveId = item.id;
  apply.archiveTitle = item.title;
  apply.purpose = '';
  apply.days = 30;
  notice.value = '';
  error.value = '';
}

function closeApply() {
  apply.archiveId = 0;
  apply.archiveTitle = '';
}

async function submit() {
  if (submitting.value) return;
  error.value = '';
  notice.value = '';
  if (!apply.purpose.trim()) {
    error.value = '请填写借阅用途';
    return;
  }
  const days = Number(apply.days);
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    error.value = '借阅期限需为 1-90 天';
    return;
  }
  submitting.value = true;
  try {
    await api.post('/borrow-requests', {
      archiveId: apply.archiveId,
      purpose: apply.purpose.trim(),
      days,
    });
    notice.value = '借阅申请已提交，请等待审核。可在「我的借阅」查看进度。';
    closeApply();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    submitting.value = false;
  }
}

onMounted(reload);
</script>

<template>
  <div>
    <h2 class="page-title">借阅管理</h2>
    <p class="text-muted page-desc">
      浏览可申请借阅的受限档案目录并提交借阅申请。
      <a class="link" @click="router.push('/borrow/mine')">查看我的借阅 →</a>
    </p>

    <section class="card">
      <div class="card-title">
        可借阅档案目录<span class="badge badge-muted" v-if="loading">加载中…</span>
      </div>
      <div class="table-scroll" v-if="items.length">
        <table class="table">
        <colgroup>
          <col class="col-no" />
          <col />
          <col class="col-cat" />
          <col class="col-type" />
          <col class="col-level" />
          <col class="col-ops" />
        </colgroup>
        <thead>
          <tr>
            <th>档号</th>
            <th>标题</th>
            <th>分类</th>
            <th>类型</th>
            <th>访问级别</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="it in pagedItems" :key="it.id">
            <td class="mono ellipsis" :title="it.archiveNo">{{ it.archiveNo }}</td>
            <td>{{ it.title }}</td>
            <td>{{ it.categoryName }}</td>
            <td>{{ it.archiveType }}</td>
            <td class="nowrap"><span class="badge badge-muted">{{ it.accessLevel === 'restricted' ? '受限' : '公开' }}</span></td>
            <td class="nowrap">
              <button class="btn btn-sm btn-primary" @click="openApply(it)">申请借阅</button>
            </td>
          </tr>
        </tbody>
      </table>
      </div>
      <AppEmpty
        v-else-if="!loading"
        title="暂无可借阅的受限档案"
        description="目录仅展示当前未被您借阅、且需要授权的档案。"
      />
      <AppPagination
        :page="page.page"
        :total="items.length"
        :page-size="page.pageSize"
        :disabled="loading"
        @update:page="(p) => (page.page = p)"
      />
    </section>

    <AppModal
      :open="!!apply.archiveId"
      title="申请借阅"
      :subtitle="`档案：${apply.archiveTitle}`"
      :width="460"
      @update:open="(v) => { if (!v) closeApply(); }"
    >
      <div class="field">
        <label for="b-purpose">借阅用途 <span class="req">*</span></label>
        <textarea
          id="b-purpose"
          v-model="apply.purpose"
          rows="3"
          maxlength="500"
          placeholder="简述借阅事由（1-500 字）"
        ></textarea>
      </div>
      <div class="field">
        <label for="b-days">借阅期限（天）<span class="req">*</span></label>
        <AppNumberInput id="b-days" v-model="apply.days" :min="1" :max="90" />
        <p class="text-muted hint">授权自审核通过之日起生效，到期自动失效（1-90 天）。</p>
      </div>

      <template #footer>
        <div class="actions">
          <button class="btn" type="button" :disabled="submitting" @click="closeApply">取消</button>
          <button class="btn btn-primary" type="button" :disabled="submitting" @click="submit">
            {{ submitting ? '提交中…' : '提交申请' }}
          </button>
        </div>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.link { color: var(--color-primary); cursor: pointer; }
.mono { font-family: Consolas, Monaco, monospace; font-size: 13px; }
.req { color: var(--color-danger); }
.hint { font-size: 12px; margin-top: 4px; }
.actions { display: flex; gap: 12px; margin-left: auto; }

/* 固定列宽：访问级别标签与操作按钮不折行，长档号单行省略（title 看全文），窄屏由 .table-scroll 横向滚动兜底 */
.table { table-layout: fixed; min-width: 840px; }
.col-no { width: 200px; }
.col-cat { width: 150px; }
.col-type { width: 90px; }
.col-level { width: 84px; }
.col-ops { width: 100px; }
.nowrap { white-space: nowrap; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 移动端：弹窗按钮适配窄屏 */
@media (max-width: 767px) {
  .actions { width: 100%; }
  .actions .btn { flex: 1; }
}
</style>
