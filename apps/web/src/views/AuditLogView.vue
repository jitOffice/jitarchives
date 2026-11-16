<script setup lang="ts">
/**
 * 操作审计页（仅管理员可进入，后端 auditView 同样强制 403）。
 *
 * 展示原则：
 * - 「对象」优先显示后端解析出的真实业务名称（档案题名 / 附件名 / 用户账号 / 借阅对应档案等），
 *   解析不到时降级显示追溯编号并注明「原业务记录已不存在」，不编造名称；
 * - 「详情」为中文业务说明，由后端按片段返回，其中时间片段在本机按用户本地时区渲染；
 * - 原始后端字段（动作常量、对象类型与 ID、detail、IP）收进「查看技术详情」，
 *   默认不展示，追溯能力与详情脱敏策略保持不变；
 * - 查询条件（操作人 / 动作 / 时间范围）仍全部提交后端在 SQL 层过滤与分页，前端不二次筛选。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { ROLE_LABELS, type AuditLogItemView, type AuditSummaryPart, type Role } from '../types';
import { useFlash } from '../toast';
import AppSelect from '../components/ui/AppSelect.vue';
import AppDatePicker from '../components/ui/AppDatePicker.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppLoading from '../components/ui/AppLoading.vue';
import AppPagination from '../components/ui/AppPagination.vue';

const rows = ref<AuditLogItemView[]>([]);
const actions = ref<string[]>([]);
/** 动作中文名由后端统一提供，避免前端映射与后端常量漂移。 */
const actionLabels = ref<Record<string, string>>({});
const loading = ref(false);
/** 查询失败提示走右上角浮层，数秒后自动消失。 */
const { error } = useFlash();
const total = ref(0);
/** 已展开「技术详情」的记录 ID（默认全部收起）。 */
const expanded = ref<Set<number>>(new Set());

const filters = reactive({
  actorName: '',
  action: '',
  from: '', // YYYY-MM-DD
  to: '', // YYYY-MM-DD
});
const page = reactive({ page: 1, pageSize: 10 });

function actionLabel(action: string): string {
  return actionLabels.value[action] ?? action;
}

/** 操作类型下拉选项：首项为空值，用于回到「全部」。 */
const actionOptions = computed(() => [
  { label: '全部', value: '' },
  ...actions.value.map((a) => ({ label: actionLabel(a), value: a })),
]);

function roleLabel(role: string | null): string {
  return role && role in ROLE_LABELS ? ROLE_LABELS[role as Role] : (role ?? '—');
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '查询失败，请稍后重试';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 统一转换为用户本地时区的时间（YYYY-MM-DD HH:mm:ss），不用服务器时区代替用户时区。 */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return iso || '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** 对象主名称：解析不到时降级显示追溯编号。 */
function objectText(item: AuditLogItemView): string {
  if (item.objectLabel) return item.objectLabel;
  return item.objectId ? `#${item.objectId}` : '—';
}

/** 对象副标题：中文类型 + 业务标识；对象已不存在时如实标注，不补造信息。 */
function objectSub(item: AuditLogItemView): string {
  const parts: string[] = [item.objectTypeLabel];
  if (!item.objectResolved && item.objectId) parts.push('原业务记录已不存在，仅保留追溯编号');
  else if (item.objectRef) parts.push(item.objectRef);
  return parts.filter(Boolean).join(' · ');
}

/** 单个描述片段：文本直接展示，时间片段按本机时区格式化。 */
function partText(p: AuditSummaryPart): string {
  return p.kind === 'time' ? fmtDateTime(p.iso) : p.text;
}

/** 详情纯文本（时间按本机时区渲染），用于单元格 title 与复制。 */
function detailText(item: AuditLogItemView): string {
  if (item.summary.length === 0) return '—';
  return item.summary.map(partText).join('');
}

function prettyDetail(item: AuditLogItemView): string {
  try {
    return JSON.stringify(item.detail ?? {}, null, 2);
  } catch {
    return '{}';
  }
}

function toggleTech(id: number): void {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function isExpanded(id: number): boolean {
  return expanded.value.has(id);
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.queryAudit({
      actorName: filters.actorName || undefined,
      action: filters.action || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
      page: page.page,
      pageSize: page.pageSize,
    });
    rows.value = res.items;
    total.value = res.total;
    expanded.value = new Set();
  } catch (e) {
    error.value = errMsg(e);
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function applyFilters() {
  page.page = 1;
  void reload();
}

function resetFilters() {
  filters.actorName = '';
  filters.action = '';
  filters.from = '';
  filters.to = '';
  page.page = 1;
  void reload();
}

function goPage(next: number) {
  if (next === page.page) return;
  page.page = next;
  void reload();
}

onMounted(async () => {
  try {
    const res = await api.auditActions();
    actions.value = res.actions;
    actionLabels.value = res.labels ?? {};
  } catch {
    actions.value = [];
    actionLabels.value = {};
  }
  await reload();
});
</script>

<template>
  <div>
    <h2 class="page-title">操作审计</h2>
    <p class="text-muted page-desc">
      系统关键操作的留痕记录（登录、用户与权限、分类、模板、档案、附件、在线编辑、借阅）。
      记录只追加、不删除，保留不少于 6 个月；时间按本机时区显示，详情已脱敏，
      不含密码、Cookie、票据或接入密钥，原始追溯字段可展开「技术详情」查看。
    </p>

    <section class="card">
      <div class="card-title">查询条件</div>
      <form class="filters" @submit.prevent="applyFilters">
        <div class="field">
          <label for="f-actor">操作人名称</label>
          <input id="f-actor" v-model="filters.actorName" placeholder="按操作人名称模糊过滤" />
        </div>
        <div class="field">
          <label for="f-action">操作类型</label>
          <AppSelect id="f-action" v-model="filters.action" :options="actionOptions" />
        </div>
        <div class="field">
          <label for="f-from">起始日期</label>
          <AppDatePicker id="f-from" v-model="filters.from" clearable placeholder="不限" />
        </div>
        <div class="field">
          <label for="f-to">截止日期</label>
          <AppDatePicker id="f-to" v-model="filters.to" clearable placeholder="不限" />
        </div>
        <div class="field actions-btns">
          <button class="btn btn-primary" type="submit" :disabled="loading">{{ loading ? '查询中…' : '查询' }}</button>
          <button class="btn" type="button" @click="resetFilters">重置</button>
        </div>
      </form>
    </section>

    <section class="card">
      <div class="card-title">
        审计记录
        <span class="badge-muted badge">{{ total }} 条</span>
        <AppLoading v-if="loading" text="加载中…" size="sm" inline />
      </div>
      <div class="table-wrap">
        <table class="table">
        <thead>
          <tr>
            <th class="col-time">时间</th>
            <th class="col-actor">操作人</th>
            <th class="col-action">操作类型</th>
            <th class="col-object">对象</th>
            <th class="col-result">结果</th>
            <th>详情</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="item in rows" :key="item.id">
            <tr>
              <td class="nowrap">{{ fmtDateTime(item.createdAt) }}</td>
              <td class="nowrap">
                {{ item.actorName ?? '（匿名/系统）' }}
                <span class="text-muted"> · {{ roleLabel(item.actorRole) }}</span>
              </td>
              <td class="nowrap">{{ item.actionLabel }}</td>
              <td class="object-cell">
                <div class="object-main" :title="objectText(item)">{{ objectText(item) }}</div>
                <div class="text-muted object-sub" :title="objectSub(item)">{{ objectSub(item) }}</div>
              </td>
              <td class="nowrap">
                <span :class="item.result === 'success' ? 'badge badge-success' : 'badge badge-danger'">
                  {{ item.result === 'success' ? '成功' : '失败' }}
                </span>
              </td>
              <td class="detail-cell" :title="detailText(item)">
                <div class="summary">
                  <template v-if="item.summary.length === 0">
                    <span class="text-muted">—</span>
                  </template>
                  <span
                    v-for="(p, i) in item.summary"
                    :key="i"
                    :class="{ nowrap: p.kind === 'time' }"
                  >{{ partText(p) }}</span>
                </div>
                <button
                  type="button"
                  class="tech-toggle"
                  :aria-expanded="isExpanded(item.id)"
                  @click="toggleTech(item.id)"
                >
                  {{ isExpanded(item.id) ? '收起技术详情' : '查看技术详情' }}
                </button>
              </td>
            </tr>
            <tr v-if="isExpanded(item.id)" class="tech-row">
              <td colspan="6">
                <div class="tech">
                  <div class="tech-item"><span class="k">记录编号</span><span>{{ item.id }}</span></div>
                  <div class="tech-item"><span class="k">操作类型</span><span>{{ item.action }}（{{ item.actionLabel }}）</span></div>
                  <div class="tech-item"><span class="k">对象类型</span><span>{{ item.objectType }}（{{ item.objectTypeLabel }}）</span></div>
                  <div class="tech-item"><span class="k">对象 ID</span><span>{{ item.objectId ?? '—' }}</span></div>
                  <div class="tech-item"><span class="k">操作 IP</span><span>{{ item.ip ?? '—' }}</span></div>
                  <div class="tech-item"><span class="k">操作时间</span><span>{{ fmtDateTime(item.createdAt) }}（本地时间）</span></div>
                  <div class="tech-item"><span class="k">记录结果</span><span>{{ item.result === 'success' ? '成功' : '失败' }}</span></div>
                  <div class="tech-detail">
                    <div class="k">原始详情（已脱敏 JSON）</div>
                    <pre class="json">{{ prettyDetail(item) }}</pre>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
        </table>
      </div>
      <AppEmpty v-if="!loading && rows.length === 0" title="暂无符合条件的审计记录" compact />

      <AppPagination
        :page="page.page"
        :total="total"
        :page-size="page.pageSize"
        :disabled="loading"
        @update:page="goPage"
      />
    </section>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.filters { display: grid; grid-template-columns: repeat(4, 1fr) auto; gap: 16px; align-items: end; }
.actions-btns { display: flex; gap: 8px; }
.nowrap { white-space: nowrap; }
/* 窄屏时表格内部横向滚动，不让长中文对象名把详情列挤成竖排。 */
.table-wrap { overflow-x: auto; }
/* 固定列宽 + 单行省略：长题名/文件名不会撑破表格布局。 */
.table { min-width: 1040px; table-layout: fixed; }
.table th { white-space: nowrap; }
.col-time { width: 156px; }
.col-actor { width: 168px; }
.col-action { width: 136px; }
.col-object { width: 236px; }
.col-result { width: 76px; }
.object-cell { vertical-align: top; }
.object-main { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.object-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-cell { vertical-align: top; }
.summary { line-height: 1.6; overflow-wrap: anywhere; }
.tech-toggle {
  margin-top: 4px;
  padding: 0;
  background: none;
  border: none;
  color: var(--color-primary);
  font-size: 12px;
  cursor: pointer;
}
.tech-toggle:hover { text-decoration: underline; }
.tech-row td { background: #fafbfc; }
.tech { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 24px; font-size: 13px; }
.tech-item { display: flex; gap: 8px; }
.tech-item .k { color: var(--text-muted); flex: none; min-width: 64px; }
.tech-detail { grid-column: 1 / -1; }
.tech-detail .k { color: var(--text-muted); margin-bottom: 4px; }
.json {
  margin: 0;
  padding: 8px 12px;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 220px;
  overflow: auto;
}
.pager { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
@media (max-width: 960px) {
  .filters { grid-template-columns: 1fr 1fr; }
  .tech { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  .filters { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .actions-btns .btn { flex: 1; }
  .pager { flex-wrap: wrap; }
}
@media (max-width: 767px) {
  /* 触屏没有 hover 提示，对象列在窄屏改为换行完整展示 */
  .object-main,
  .object-sub { white-space: normal; overflow-wrap: anywhere; }
  /* 文字链接扩充上下热区，便于手指点击 */
  .tech-toggle { padding: 6px 0; }
}
</style>
