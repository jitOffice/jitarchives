<script setup lang="ts">
/**
 * 档案分类管理页（阶段二第二批）：
 * 树形展示层级与各分类档案数；创建/编辑名称、编码、说明与父级。
 * 删除按「引用保护」开放：仅无子分类且无档案引用的分类可删，前后端独立校验
 * （后端为权威判定，数据库外键强制兜底）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { can } from '../perms';
import type { CategoryView } from '../types';
import { useFlash } from '../toast';
import AppSelect from '../components/ui/AppSelect.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import { confirmDialog } from '../components/ui/dialog';

const auth = useAuthStore();
const router = useRouter();

const categories = ref<CategoryView[]>([]);
const loading = ref(false);
const saving = ref(false);
/** 正在删除的分类 id（0 = 空闲），用于按行置灰按钮。 */
const removing = ref(0);
/** 操作结果统一走右上角浮层（数秒后自动消失），页面内不再常驻提示条。 */
const { error, notice } = useFlash();

const canManage = computed(() => can(auth.user?.role, 'categoryManage'));

/** null = 新建顶层；数字 = 新建为该分类的子级；'edit' = 正在编辑的分类 id */
const editing = reactive({
  mode: '' as '' | 'create' | 'edit',
  id: 0,
  name: '',
  code: '',
  description: '',
  parentId: '' as string,
});

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

async function reload() {
  loading.value = true;
  error.value = '';
  try {
    categories.value = await api.get<CategoryView[]>('/categories');
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

/** 树形展开：按父子关系生成带层级的展示序列。 */
const tree = computed(() => {
  const childrenOf = new Map<number | 'root', CategoryView[]>();
  for (const c of categories.value) {
    const key = c.parentId ?? 'root';
    const list = childrenOf.get(key) ?? [];
    list.push(c);
    childrenOf.set(key, list);
  }
  const out: Array<CategoryView & { indent: number }> = [];
  const walk = (key: number | 'root', indent: number) => {
    for (const c of childrenOf.get(key) ?? []) {
      out.push({ ...c, indent });
      walk(c.id, indent + 1);
    }
  };
  walk('root', 0);
  // 挂在已失效父级下的极端情况兜底：未入树的也平铺展示
  const placed = new Set(out.map((c) => c.id));
  for (const c of categories.value) {
    if (!placed.has(c.id)) out.push({ ...c, indent: 0 });
  }
  return out;
});

/** 父级下拉候选：编辑时排除自身及其全部后代，防止形成循环引用。 */
function parentOptions(excludeId: number | null) {
  let banned = new Set<number>();
  if (excludeId) {
    const childrenOf = new Map<number, number[]>();
    for (const c of categories.value) {
      if (c.parentId == null) continue;
      const list = childrenOf.get(c.parentId) ?? [];
      list.push(c.id);
      childrenOf.set(c.parentId, list);
    }
    banned = new Set<number>();
    const queue = [excludeId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const child of childrenOf.get(id) ?? []) {
        if (!banned.has(child)) {
          banned.add(child);
          queue.push(child);
        }
      }
    }
    banned.add(excludeId);
  }
  return categories.value
    .filter((c) => !banned.has(c.id))
    .map((c) => ({ id: c.id, label: `${'　'.repeat(c.depth)}${c.name}` }));
}

/** 父级下拉选项：首项为空值，用于把分类改为顶层。 */
const parentSelectOptions = computed(() => [
  { label: '（顶层分类）', value: '' },
  ...parentOptions(editing.mode === 'edit' ? editing.id : null).map((p) => ({
    label: p.label,
    value: String(p.id),
  })),
]);

function startCreate(parent?: CategoryView) {
  editing.mode = 'create';
  editing.id = 0;
  editing.name = '';
  editing.code = '';
  editing.description = '';
  editing.parentId = parent ? String(parent.id) : '';
  notice.value = '';
}

function startEdit(c: CategoryView) {
  editing.mode = 'edit';
  editing.id = c.id;
  editing.name = c.name;
  editing.code = c.code;
  editing.description = c.description;
  editing.parentId = c.parentId == null ? '' : String(c.parentId);
  notice.value = '';
}

function cancelEdit() {
  editing.mode = '';
}

/** 直接子分类数量：有子级时不允许删除，避免整棵子树被误删。 */
function childCountOf(id: number): number {
  return categories.value.filter((c) => c.parentId === id).length;
}

/**
 * 删除分类：有子分类或仍被档案引用时直接拒绝（后端同样强制校验），
 * 前端先给出具体原因，避免用户反复尝试；其余情况二次确认后才发请求。
 */
async function removeCategory(c: CategoryView) {
  if (removing.value) return;
  error.value = '';
  notice.value = '';
  const children = childCountOf(c.id);
  if (children > 0) {
    error.value = `「${c.name}」下仍有 ${children} 个子分类，请先删除或移走子分类。`;
    return;
  }
  if (c.archiveCount > 0) {
    error.value = `「${c.name}」仍被 ${c.archiveCount} 个档案引用，不可删除（需保留历史档案的类目归属）。`;
    return;
  }
  const ok = await confirmDialog({
    title: '删除分类',
    message: `确认删除分类「${c.name}」？删除后不可恢复。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  removing.value = c.id;
  try {
    await api.del<{ ok: true }>(`/categories/${c.id}`);
    if (editing.mode === 'edit' && editing.id === c.id) editing.mode = '';
    notice.value = `已删除分类「${c.name}」。`;
    await reload();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    removing.value = 0;
  }
}

async function submit() {
  if (saving.value) return;
  error.value = '';
  notice.value = '';
  if (!editing.name.trim() || !editing.code.trim()) {
    error.value = '分类名称与编码均为必填项';
    return;
  }
  const payload = {
    name: editing.name.trim(),
    code: editing.code.trim(),
    description: editing.description.trim(),
    parentId: editing.parentId === '' ? null : Number(editing.parentId),
  };
  saving.value = true;
  try {
    if (editing.mode === 'create') {
      await api.post<CategoryView>('/categories', payload);
      notice.value = `已创建分类「${payload.name}」。`;
    } else {
      await api.put<CategoryView>(`/categories/${editing.id}`, payload);
      notice.value = '分类已更新。';
    }
    editing.mode = '';
    await reload();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

function gotoCategoryArchives(c: CategoryView) {
  router.push({ path: '/archives', query: { categoryId: String(c.id) } });
}

onMounted(reload);
</script>

<template>
  <div>
    <h2 class="page-title">档案分类管理</h2>
    <p class="text-muted page-desc">
      维护多级档案分类（类目），分类与档案数量实时来自服务器数据库。
      {{ canManage ? '' : '当前角色仅可查看目录，分类维护由管理员/著录员/审核员负责。' }}
    </p>

    <div class="cols">
      <section class="card">
        <div class="card-title">分类目录<span class="badge badge-muted" v-if="loading">加载中…</span></div>
        <div class="table-scroll">
          <table class="table cat-table">
            <colgroup>
              <col />
              <col class="col-code" />
              <col class="col-count" />
              <col class="col-ops" />
            </colgroup>
            <thead>
              <tr>
                <th>分类名称 / 说明</th>
                <th>编码</th>
                <th class="cell-count">档案数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in tree" :key="c.id">
                <td class="cell-name">
                  <div
                    class="cat-label"
                    :class="{ 'is-child': c.indent > 0 }"
                    :style="{ paddingLeft: `${c.indent * 18}px` }"
                  >
                    <span class="cat-name" :title="c.name">{{ c.name }}</span>
                  </div>
                  <p
                    class="cat-desc"
                    v-if="c.description"
                    :style="{ paddingLeft: `${c.indent * 18}px` }"
                  >
                    {{ c.description }}
                  </p>
                </td>
                <td class="mono cell-code" :title="c.pathCode">{{ c.pathCode }}</td>
                <td class="cell-count">
                  <a
                    class="count-chip"
                    :class="{ 'is-zero': c.archiveCount === 0 }"
                    :title="`查看该分类下的 ${c.archiveCount} 条档案`"
                    @click="gotoCategoryArchives(c)"
                  >
                    {{ c.archiveCount }}
                  </a>
                </td>
                <td class="cell-ops">
                  <div class="row-actions" v-if="canManage">
                    <button class="btn btn-sm" @click="startEdit(c)">编辑</button>
                    <button class="btn btn-sm" @click="startCreate(c)">添加子分类</button>
                    <button
                      class="btn btn-sm btn-danger"
                      :disabled="removing === c.id"
                      @click="removeCategory(c)"
                    >
                      {{ removing === c.id ? '删除中' : '删除' }}
                    </button>
                  </div>
                  <span v-else class="text-muted">只读</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <AppEmpty
          v-if="!loading && tree.length === 0"
          title="暂无分类"
          :description="canManage ? '点击下方「新建顶层分类」开始建立档案类目体系。' : '请联系管理员先建立分类。'"
        />
        <p class="text-muted delnote" v-if="tree.length">
          注：仅「无子分类且无档案引用」的分类可删除；已被档案引用的分类需保留类目归属，
          删除会被服务端拒绝。
        </p>
        <button
          v-if="canManage && editing.mode !== 'create'"
          class="btn btn-primary btn-sm new-top"
          @click="startCreate()"
        >
          新建顶层分类
        </button>
      </section>

      <section class="card" v-if="canManage && editing.mode">
        <div class="card-title">{{ editing.mode === 'create' ? '新建分类' : '编辑分类' }}</div>
        <form @submit.prevent="submit">
          <div class="field">
            <label for="c-parent">父级分类</label>
            <AppSelect
              id="c-parent"
              v-model="editing.parentId"
              :options="parentSelectOptions"
              placeholder="（顶层分类）"
            />
          </div>
          <div class="field">
            <label for="c-name">分类名称 <span class="req">*</span></label>
            <input id="c-name" v-model="editing.name" maxlength="50" placeholder="1-50 个字符，同级不可重名" />
          </div>
          <div class="field">
            <label for="c-code">分类编码 <span class="req">*</span></label>
            <input id="c-code" v-model="editing.code" maxlength="20" placeholder="如 WS，用于自动生成档号，同级不可重复" />
          </div>
          <div class="field">
            <label for="c-desc">分类说明</label>
            <textarea id="c-desc" v-model="editing.description" maxlength="200" rows="3" placeholder="可选，200 字以内"></textarea>
          </div>
          <div class="actions">
            <button class="btn" type="button" :disabled="saving" @click="cancelEdit">取消</button>
            <button class="btn btn-primary" type="submit" :disabled="saving">
              {{ saving ? '保存中…' : '保存分类' }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.cols { display: grid; grid-template-columns: 1fr 340px; gap: 20px; align-items: start; }
.cols .card:last-child { position: sticky; top: 0; }
/* 表格水平滚动容器：窄屏下不挤压操作列，按钮始终保持一行 */
.table-scroll { overflow-x: auto; margin: 0 -4px; padding: 0 4px; }
/* 固定列宽：名称/说明只影响自身换行与行高，不改变操作列宽度与按钮排列 */
.cat-table { table-layout: fixed; min-width: 650px; }
.cat-table th { vertical-align: middle; white-space: nowrap; }
/* 单元格顶部对齐：说明换行变高时，按钮仍与分类名称首行平齐 */
.cat-table td { vertical-align: top; }
.col-code { width: 150px; }
.col-count { width: 80px; }
.col-ops { width: 240px; }
.cell-name { min-width: 0; }
.cat-label { display: flex; align-items: center; min-width: 0; }
.cat-label.is-child::before {
  content: '';
  flex: 0 0 auto;
  width: 12px;
  height: 10px;
  margin: 0 6px 6px 0;
  border-left: 1px solid #dcdfe6;
  border-bottom: 1px solid #dcdfe6;
  border-bottom-left-radius: 6px;
}
.cat-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-title);
}
.cat-desc {
  margin: 3px 0 0;
  font-size: 12px;
  line-height: 19px;
  color: var(--text-muted);
  /* 说明完整展示：正常换行，不截断；超长无空格的串也能在单元格内断行 */
  white-space: normal;
  overflow-wrap: anywhere;
}
.cell-code {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cell-count { text-align: center; }
.count-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 34px;
  height: 24px;
  padding: 0 9px;
  border-radius: 12px;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}
.count-chip:hover { background: rgba(22, 93, 255, 0.16); }
.count-chip.is-zero { background: #f2f3f5; color: var(--text-muted); font-weight: 500; }
.cell-ops { white-space: nowrap; }
.row-actions { display: flex; align-items: center; gap: 6px; }
.row-actions .btn { flex: 0 0 auto; white-space: nowrap; padding: 4px 9px; }
.mono { font-family: Consolas, Monaco, monospace; font-size: 13px; }
.req { color: var(--color-danger); }
.delnote { margin-top: 10px; }
.new-top { margin-top: 12px; }
.actions { display: flex; gap: 12px; }
@media (max-width: 1100px) {
  /* minmax(0, 1fr) 而非 1fr：防止表格 min-width 把单列轨道撑宽，导致内容区横向滚动 */
  .cols { grid-template-columns: minmax(0, 1fr); }
  /* 单列堆叠后编辑卡片不再吸顶，否则会遮住分类列表 */
  .cols .card:last-child { position: static; }
}
</style>
