<script setup lang="ts">
/**
 * 用户管理页（仅管理员可进入，后端同样强制 403）：
 * 创建测试用户、设置角色、启用/禁用账号。列表数据来自 SQLite 真实记录。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { ALL_ROLES, ROLE_LABELS, type Role, type UserView } from '../types';
import { useFlash } from '../toast';
import AppSelect from '../components/ui/AppSelect.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import AppPagination from '../components/ui/AppPagination.vue';

const auth = useAuthStore();
const users = ref<UserView[]>([]);
const loading = ref(false);
/** 错误/成功提示走右上角浮层（useFlash），页面内不再常驻横幅。 */
const { error, notice } = useFlash();
const saving = ref(false);

const createForm = reactive({ username: '', displayName: '', role: 'borrower' as string, password: '' });

/** 列表分页：每页 10 条，超过一页才出现分页控件。 */
const page = reactive({ page: 1, pageSize: 10 });
const pagedUsers = computed(() =>
  users.value.slice((page.page - 1) * page.pageSize, page.page * page.pageSize),
);

/** 角色下拉选项：与原生 select 的 value 保持字符串。 */
const roleOptions = computed(() => ALL_ROLES.map((r) => ({ label: ROLE_LABELS[r], value: String(r) })));

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    users.value = await api.get<UserView[]>('/users');
    page.page = Math.min(page.page, Math.max(1, Math.ceil(users.value.length / page.pageSize)));
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

async function createUser() {
  error.value = '';
  notice.value = '';
  saving.value = true;
  try {
    const u = await api.post<UserView>('/users', { ...createForm });
    notice.value = `已创建用户「${u.displayName}（${u.username}）」，角色：${u.roleLabel}`;
    createForm.username = '';
    createForm.displayName = '';
    createForm.password = '';
    await reload();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function changeRole(u: UserView, role: Role) {
  error.value = '';
  try {
    const updated = await api.patch<UserView>(`/users/${u.id}`, { role });
    Object.assign(u, updated);
    notice.value = `已将「${u.displayName}」角色调整为 ${updated.roleLabel}`;
  } catch (e) {
    error.value = errMsg(e);
    await reload(); // 失败回滚显示
  }
}

async function toggleStatus(u: UserView) {
  error.value = '';
  const next = u.status === 'active' ? 'disabled' : 'active';
  try {
    const updated = await api.patch<UserView>(`/users/${u.id}`, { status: next });
    Object.assign(u, updated);
    notice.value = next === 'disabled'
      ? `已禁用「${u.displayName}」，该账号在线会话已即刻失效且无法再次登录`
      : `已恢复「${u.displayName}」，该账号可以正常登录`;
  } catch (e) {
    error.value = errMsg(e);
    await reload();
  }
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('zh-CN');
}

onMounted(reload);
</script>

<template>
  <div>
    <h2 class="page-title">用户管理</h2>
    <p class="text-muted page-desc">
      创建测试账号、分配 {{ ALL_ROLES.length }} 类预设角色、启用或禁用账号。数据保存在服务器 SQLite 数据库，重启后保留。
    </p>


    <div class="cols">
      <section class="card">
        <div class="card-title">创建用户</div>
        <form @submit.prevent="createUser">
          <div class="field">
            <label for="n-username">登录账号</label>
            <input id="n-username" v-model="createForm.username" placeholder="3-32 位字母、数字、._-" />
          </div>
          <div class="field">
            <label for="n-display">姓名</label>
            <input id="n-display" v-model="createForm.displayName" placeholder="可选，默认与账号相同" />
          </div>
          <div class="field">
            <label for="n-role">角色</label>
            <AppSelect id="n-role" v-model="createForm.role" :options="roleOptions" />
          </div>
          <div class="field">
            <label for="n-password">初始密码</label>
            <input id="n-password" v-model="createForm.password" type="password" placeholder="至少 6 位" />
          </div>
          <button class="btn btn-primary" type="submit" :disabled="saving">
            {{ saving ? '创建中…' : '创建用户' }}
          </button>
        </form>
      </section>

      <section class="card">
        <div class="card-title">用户列表<span class="badge-muted badge" v-if="loading">加载中…</span></div>
        <div class="table-scroll">
          <table class="table">
          <colgroup>
            <col class="col-name" />
            <col class="col-display" />
            <col class="col-role" />
            <col class="col-status" />
            <col class="col-created" />
            <col class="col-ops" />
          </colgroup>
          <thead>
            <tr>
              <th>账号</th>
              <th>姓名</th>
              <th>角色</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in pagedUsers" :key="u.id">
              <td class="ellipsis" :title="u.username">{{ u.username }}</td>
              <td class="ellipsis" :title="u.displayName">{{ u.displayName }}</td>
              <td>
                <AppSelect
                  size="sm"
                  variant="inline"
                  :model-value="u.role"
                  :options="roleOptions"
                  :disabled="u.id === auth.user?.id"
                  :aria-label="`${u.displayName} 的角色`"
                  @change="(v) => changeRole(u, v as Role)"
                />
              </td>
              <td class="nowrap">
                <span :class="u.status === 'active' ? 'badge badge-success' : 'badge badge-danger'">
                  {{ u.status === 'active' ? '启用' : '禁用' }}
                </span>
              </td>
              <td class="nowrap">{{ fmtDate(u.createdAt) }}</td>
              <td class="nowrap">
                <button
                  v-if="u.id !== auth.user?.id"
                  class="btn btn-sm"
                  :class="{ 'btn-danger': u.status === 'active' }"
                  @click="toggleStatus(u)"
                >
                  {{ u.status === 'active' ? '禁用' : '启用' }}
                </button>
                <span v-else class="text-muted">当前登录</span>
              </td>
            </tr>
          </tbody>
          </table>
        </div>
        <AppEmpty v-if="!loading && users.length === 0" title="暂无用户" compact />
        <AppPagination
          :page="page.page"
          :total="users.length"
          :page-size="page.pageSize"
          :disabled="loading"
          @update:page="(p) => (page.page = p)"
        />
      </section>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.cols { display: grid; grid-template-columns: 320px 1fr; gap: 20px; align-items: start; }
/* 表格内的角色下拉使用 AppSelect 的 inline 变体：宽度、无边框常态、悬停浅底与禁用态
   全部由组件统一控制；负外边距抵消触发器内边距，让角色文字与其它列的文本左对齐 */
.table .ui-select { margin-left: -6px; }
/* 固定列宽：状态徽章、时间与操作不折行，账号/姓名超长单行省略（title 看全文），窄屏由 .table-scroll 横向滚动兜底 */
.table { table-layout: fixed; min-width: 700px; }
.col-name { width: 140px; }
.col-display { width: 100px; }
.col-role { width: 140px; }
.col-status { width: 76px; }
.col-created { width: 100px; }
.col-ops { width: 90px; }
.nowrap { white-space: nowrap; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* minmax(0, 1fr) 而非 1fr：防止表格 min-width 把单列轨道撑宽，导致内容区横向滚动 */
@media (max-width: 900px) { .cols { grid-template-columns: minmax(0, 1fr); } }
</style>
