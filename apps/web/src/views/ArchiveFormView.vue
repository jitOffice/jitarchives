<script setup lang="ts">
/**
 * 档案著录表单（新建 / 编辑复用）：
 * - 档号、状态、创建人由后端生成与维护，表单只提交业务著录字段；
 * - 编辑时先真实加载档案；已归档档案后端拒绝修改，前端同步只读展示。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, ApiError } from '../api/client';
import {
  ARCHIVE_TYPE_OPTIONS,
  type ArchiveDetailView,
  type CategoryTemplateFields,
  type CategoryView,
  type TemplateFieldView,
} from '../types';
import { useFlash } from '../toast';
import AppSelect from '../components/ui/AppSelect.vue';
import AppDatePicker from '../components/ui/AppDatePicker.vue';
import AppNumberInput from '../components/ui/AppNumberInput.vue';
import AppCheckbox from '../components/ui/AppCheckbox.vue';

const props = defineProps<{ id?: string }>();

const router = useRouter();
const isEdit = computed(() => props.id !== undefined && props.id !== '');

const categories = ref<CategoryView[]>([]);
const loading = ref(false);
const saving = ref(false);
/** 校验/保存失败提示走右上角浮层；notFound 为页级状态（整页不渲染表单），保持常驻。 */
const { error } = useFlash();
const notFound = ref('');

const form = reactive({
  title: '',
  categoryId: '' as string,
  archiveType: '文书档案',
  keywords: '',
  formationDate: '',
  responsible: '',
  remarks: '',
  accessLevel: 'public' as string,
});

const readonly = ref(false); // 已归档档案：只读展示（后端同样强制拒绝）
const archiveNo = ref('');
const statusLabel = ref('');

// 动态著录字段（按所选分类绑定的元数据模板渲染）
const renderFields = ref<TemplateFieldView[]>([]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const dyn = reactive<Record<string, any>>({});
// 编辑时从档案已存值预填（fieldKey -> 入库字符串），切分类时据此回显。
const existingValues = reactive<Record<string, string>>({});

function initialFor(f: TemplateFieldView, existing?: string): string | string[] {
  if (f.type === 'tags') {
    if (!existing) return [];
    try {
      const arr = JSON.parse(existing);
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return existing
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  if (f.type === 'bool') return existing === '1' ? '1' : '0';
  return existing ?? '';
}

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

const categoryOptions = computed(() =>
  [...categories.value]
    .sort((a, b) => a.pathCode.localeCompare(b.pathCode))
    .map((c) => ({ id: String(c.id), label: `${'　'.repeat(c.depth)}${c.name}` })),
);

/** 固定字段下拉选项：值统一为字符串，与表单字段类型保持一致。 */
const categorySelectOptions = computed(() =>
  categoryOptions.value.map((c) => ({ label: c.label, value: c.id })),
);
const archiveTypeOptions = ARCHIVE_TYPE_OPTIONS.map((t) => ({ label: t, value: t }));
const accessLevelOptions = [
  { label: '公开（具备查看权限的角色即可见）', value: 'public' },
  { label: '受限（仅创建者或持有有效借阅授权者可见）', value: 'restricted' },
];

/** 动态字段下拉选项（select / bool）。 */
function dynamicSelectOptions(options: string[]) {
  return [{ label: '请选择', value: '' }, ...options.map((o) => ({ label: o, value: o }))];
}
const boolOptions = [
  { label: '否', value: '0' },
  { label: '是', value: '1' },
];

async function loadCategories() {
  try {
    categories.value = await api.get<CategoryView[]>('/categories');
    if (!isEdit.value && categories.value.length === 1) {
      form.categoryId = String(categories.value[0].id);
      await loadTemplateFields();
    }
  } catch (e) {
    error.value = errMsg(e);
  }
}

/** 按所选分类拉取模板启用字段并初始化控件值（保留已有著录值）。 */
async function loadTemplateFields() {
  renderFields.value = [];
  const categoryId = Number(form.categoryId);
  if (!categoryId) return;
  try {
    const res = await api.get<CategoryTemplateFields>(`/categories/${categoryId}/template-fields`);
    const fields = res.fields.filter((f) => f.active);
    renderFields.value = fields;
    for (const f of fields) {
      dyn[f.fieldKey] = initialFor(f, existingValues[f.fieldKey]);
    }
  } catch (e) {
    error.value = errMsg(e);
  }
}

function toggleTag(fieldKey: string, option: string) {
  const cur = Array.isArray(dyn[fieldKey]) ? (dyn[fieldKey] as string[]) : [];
  dyn[fieldKey] = cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option];
}

/** 汇总当前模板启用字段的著录值（未绑定模板时返回 undefined，不干扰固定字段链路）。 */
function buildFieldValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of renderFields.value) {
    const v = dyn[f.fieldKey];
    if (f.type === 'tags') out[f.fieldKey] = Array.isArray(v) ? v : [];
    else if (f.type === 'bool') out[f.fieldKey] = v === '1' ? '1' : '0';
    else out[f.fieldKey] = (v as string) ?? '';
  }
  return out;
}

async function onCategoryChange() {
  await loadTemplateFields();
}

async function loadArchive() {
  loading.value = true;
  try {
    const detail = await api.get<ArchiveDetailView>(`/archives/${props.id}`);
    form.title = detail.title;
    form.categoryId = String(detail.categoryId);
    form.archiveType = detail.archiveType;
    form.keywords = detail.keywords;
    form.formationDate = detail.formationDate ?? '';
    form.responsible = detail.responsible;
    form.remarks = detail.remarks;
    form.accessLevel = detail.accessLevel;
    archiveNo.value = detail.archiveNo;
    statusLabel.value = detail.statusLabel;
    readonly.value = detail.status === 'archived';
    // 回显动态著录值：先登记已有值，再按分类模板渲染。
    for (const key of Object.keys(existingValues)) delete existingValues[key];
    for (const dv of detail.dynamicFields) existingValues[dv.fieldKey] = dv.value;
    await loadTemplateFields();
    if (readonly.value) {
      notFound.value = '';
      error.value = '该档案已归档，著录信息不可修改（归档只读约束由后端强制）。';
    }
  } catch (e) {
    notFound.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

async function save() {
  if (saving.value || readonly.value) return;
  error.value = '';
  if (!form.title.trim()) {
    error.value = '请填写档案标题';
    return;
  }
  if (!form.categoryId) {
    error.value = '请选择所属分类';
    return;
  }
  saving.value = true;
  const payload: Record<string, unknown> = {
    title: form.title.trim(),
    categoryId: Number(form.categoryId),
    archiveType: form.archiveType,
    keywords: form.keywords.trim(),
    formationDate: form.formationDate || null,
    responsible: form.responsible.trim(),
    remarks: form.remarks.trim(),
    accessLevel: form.accessLevel,
  };
  if (renderFields.value.length > 0) payload.fieldValues = buildFieldValues();
  try {
    const saved = isEdit.value
      ? await api.put<{ id: number }>(`/archives/${props.id}`, payload)
      : await api.post<{ id: number }>('/archives', payload);
    router.replace(`/archives/${saved.id}`);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  loadCategories();
  if (isEdit.value) loadArchive();
});
</script>

<template>
  <div>
    <h2 class="page-title">{{ isEdit ? '编辑档案著录信息' : '新建电子档案' }}</h2>
    <p class="text-muted page-desc">
      档号、状态、创建人与创建时间由系统自动生成和维护；带 <span class="req">*</span> 为必填项。
    </p>

    <div v-if="notFound" class="alert alert-error">{{ notFound }}</div>
    <section class="card form-card" v-if="!notFound">
      <div class="card-title">
        著录信息
        <span class="badge badge-muted" v-if="loading">加载中…</span>
        <span class="badge badge-muted" v-if="archiveNo">档号：{{ archiveNo }}</span>
        <span class="badge badge-muted" v-if="statusLabel">{{ statusLabel }}</span>
      </div>

      <form @submit.prevent="save" :class="{ dim: readonly }">
        <div class="grid2">
          <div class="field span2">
            <label for="a-title">档案标题 <span class="req">*</span></label>
            <input id="a-title" v-model="form.title" :disabled="readonly || loading" maxlength="200" placeholder="1-200 个字符" />
          </div>
          <div class="field">
            <label for="a-cat">所属分类 <span class="req">*</span></label>
            <AppSelect
              id="a-cat"
              v-model="form.categoryId"
              :options="categorySelectOptions"
              :disabled="readonly || loading"
              placeholder="请选择分类"
              @change="onCategoryChange"
            />
          </div>
          <div class="field">
            <label for="a-type">档案类型</label>
            <AppSelect
              id="a-type"
              v-model="form.archiveType"
              :options="archiveTypeOptions"
              :disabled="readonly || loading"
            />
          </div>
          <div class="field">
            <label for="a-date">形成时间</label>
            <AppDatePicker
              id="a-date"
              v-model="form.formationDate"
              :disabled="readonly || loading"
              placeholder="选择或输入日期"
            />
          </div>
          <div class="field">
            <label for="a-resp">责任者 / 来源</label>
            <input id="a-resp" v-model="form.responsible" :disabled="readonly || loading" maxlength="100" placeholder="形成或管理该档案的部门/个人" />
          </div>
          <div class="field span2">
            <label for="a-keys">关键词</label>
            <input id="a-keys" v-model="form.keywords" :disabled="readonly || loading" maxlength="200" placeholder="多个关键词用逗号分隔，用于检索" />
          </div>
          <div class="field span2">
            <label for="a-remarks">备注说明</label>
            <textarea id="a-remarks" v-model="form.remarks" :disabled="readonly || loading" maxlength="500" rows="3" placeholder="补充说明（可选，500 字以内）"></textarea>
          </div>
          <div class="field span2">
            <label for="a-access">档案访问级别</label>
            <AppSelect
              id="a-access"
              v-model="form.accessLevel"
              :options="accessLevelOptions"
              :disabled="readonly || loading"
            />
          </div>

          <template v-if="renderFields.length">
            <div class="dyn-head span2">动态著录字段<span class="text-muted dyn-sub">（按分类元数据模板渲染，带 * 为必填）</span></div>
            <div
              class="field"
              :class="{ span2: f.type === 'textarea' || f.type === 'tags' }"
              v-for="f in renderFields"
              :key="f.id"
            >
              <label :for="'dyn-' + f.id">{{ f.label }} <span class="req" v-if="f.required">*</span></label>
              <textarea
                v-if="f.type === 'textarea'"
                :id="'dyn-' + f.id"
                v-model="dyn[f.fieldKey]"
                :disabled="readonly || loading"
                :maxlength="(f.validation.maxLength as number) || 2000"
                rows="3"
              ></textarea>
              <AppSelect
                v-else-if="f.type === 'select'"
                :id="'dyn-' + f.id"
                v-model="dyn[f.fieldKey]"
                :options="dynamicSelectOptions(f.options)"
                :disabled="readonly || loading"
                placeholder="请选择"
              />
              <AppSelect
                v-else-if="f.type === 'bool'"
                :id="'dyn-' + f.id"
                v-model="dyn[f.fieldKey]"
                :options="boolOptions"
                :disabled="readonly || loading"
              />
              <div v-else-if="f.type === 'tags'" class="tags-box">
                <AppCheckbox
                  v-for="o in f.options"
                  :key="o"
                  :label="o"
                  :disabled="readonly || loading"
                  :model-value="Array.isArray(dyn[f.fieldKey]) && dyn[f.fieldKey].includes(o)"
                  @update:model-value="toggleTag(f.fieldKey, o)"
                />
              </div>
              <AppNumberInput
                v-else-if="f.type === 'number'"
                :id="'dyn-' + f.id"
                v-model="dyn[f.fieldKey]"
                :disabled="readonly || loading"
                :min="f.validation.min != null ? (f.validation.min as number) : undefined"
                :max="f.validation.max != null ? (f.validation.max as number) : undefined"
              />
              <AppDatePicker
                v-else-if="f.type === 'date'"
                :id="'dyn-' + f.id"
                v-model="dyn[f.fieldKey]"
                :disabled="readonly || loading"
              />
              <input
                v-else
                :id="'dyn-' + f.id"
                v-model="dyn[f.fieldKey]"
                :disabled="readonly || loading"
                type="text"
                :maxlength="(f.validation.maxLength as number) || 200"
              />
            </div>
          </template>
        </div>

        <div class="actions" v-if="!readonly">
          <button class="btn" type="button" :disabled="saving" @click="router.back()">返回</button>
          <button class="btn btn-primary" type="submit" :disabled="saving || loading">
            {{ saving ? '保存中…' : isEdit ? '保存修改' : '保存并创建' }}
          </button>
          <span class="text-muted" v-if="!isEdit">保存后可在详情页挂接电子文件附件。</span>
        </div>
        <div class="actions" v-else>
          <button class="btn" type="button" @click="router.push(`/archives/${props.id}`)">返回详情</button>
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.form-card { max-width: 860px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 24px; }
.grid2 .span2 { grid-column: span 2; }
.req { color: var(--color-danger); }
.actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
.dim { opacity: 0.85; }
.dyn-head { grid-column: span 2; font-weight: 600; color: var(--text-title); margin: 8px 0 4px; border-top: 1px solid var(--border-light); padding-top: 14px; }
.dyn-sub { font-weight: 400; font-size: 12px; }
/* 多选标签：每个选项整体换行，不会被拆成两行 */
.tags-box { display: flex; flex-wrap: wrap; gap: 8px 22px; padding: 8px 0; }

/* 移动端：单列表单下 span2 不能跨列，否则会生成隐式第二列把布局撑宽 */
@media (max-width: 720px) {
  .grid2 .span2,
  .dyn-head {
    grid-column: auto;
  }
  .grid2 { grid-template-columns: minmax(0, 1fr); }
  .form-card { max-width: 100%; }
  .actions { flex-wrap: wrap; gap: 10px; }
  .actions .btn { flex: 1 1 40%; }
}
</style>
