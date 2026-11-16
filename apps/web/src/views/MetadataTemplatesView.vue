<script setup lang="ts">
/**
 * 元数据模板管理页（阶段二第四批 · 功能一）。
 * 全部真实调后端：模板增删改查、字段配置、启停，以及分类绑定（决定著录表单动态字段）。
 * 管理权限 = templateManage（管理员）；页面不提供任何 Mock 或虚假成功提示。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can } from '../perms';
import {
  FIELD_TYPE_OPTIONS,
  type CategoryView,
  type FieldType,
  type MetadataTemplateDetailView,
  type MetadataTemplateView,
  type TemplateFieldView,
} from '../types';
import { useFlash } from '../toast';
import AppSelect from '../components/ui/AppSelect.vue';
import AppNumberInput from '../components/ui/AppNumberInput.vue';
import AppDatePicker from '../components/ui/AppDatePicker.vue';
import AppCheckbox from '../components/ui/AppCheckbox.vue';
import AppModal from '../components/ui/AppModal.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import { confirmDialog } from '../components/ui/dialog';

const auth = useAuthStore();
const canManage = computed(() => can(auth.user?.role, 'templateManage'));

const templates = ref<MetadataTemplateView[]>([]);
const categories = ref<CategoryView[]>([]);
const current = ref<MetadataTemplateDetailView | null>(null);
const loading = ref(false);
const saving = ref(false);
/** 模板/字段/绑定的操作结果提示走右上角浮层，页面内不常驻。 */
const { error, notice } = useFlash();

/** 新建/编辑模板元信息（名称、说明）。 */
const meta = reactive({ name: '', description: '' });

/**
 * 信息项编辑弹窗状态：mode=create 新建；mode=edit 编辑现有信息项。
 * field_key 改为系统自动生成（后端仍要求该字段），弹窗内不再让用户填写。
 * 注意：这几个数值项绑定的是 type="number" 输入框，Vue 会把值转成 number，
 * 所以类型写成 string | number，读取时一律经 numText() 转字符串。
 */
const fieldEditor = reactive({
  mode: '' as '' | 'create' | 'edit',
  id: 0,
  label: '',
  type: 'text' as FieldType,
  required: false,
  optionsText: '',
  maxLength: '' as string | number,
  pattern: '',
  min: '' as string | number,
  max: '' as string | number,
  maxItems: '' as string | number,
});

/** 弹窗内部校验提示（就地显示在弹窗底部，避免被页面顶部提示遮挡）。 */
const fieldError = ref('');
/** 高级设置（正则、长度/范围限制）默认折叠，普通用户无需关心。 */
const showAdvanced = ref(false);

/** 分类绑定（内联在模板配置内）：选择要绑定到当前模板的分类。 */
const bind = reactive({ categoryId: '' as string });

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

/** 数字输入框的值可能是 number 或空串，统一转成可 trim 的文本。 */
function numText(v: string | number): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

const needsOptions = computed(() => fieldEditor.type === 'select' || fieldEditor.type === 'tags');

/** 填写方式的中文名称与示例（统一取自 types.ts，保证与著录端一致）。 */
const typeLabel = (t: FieldType) => FIELD_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t;
const typeExample = (t: FieldType) => FIELD_TYPE_OPTIONS.find((o) => o.value === t)?.example ?? '';

/** 当前正在编辑的信息项；已被档案引用者不可改填写方式（与后端变更保护一致）。 */
const editingField = computed(() => current.value?.fields.find((f) => f.id === fieldEditor.id) ?? null);
const typeLocked = computed(() => fieldEditor.mode === 'edit' && !!editingField.value?.referenced);

/** 预览用选项：最多展示 4 个，避免弹窗被长选项列表撑开。 */
const previewOptions = computed(() => parseOptions().slice(0, 4));

const TYPE_TIP: Record<FieldType, string> = {
  text: '只能填写一行文字',
  textarea: '可以换行填写较长内容',
  number: '只能填写数字',
  date: '点击后从日历中选择日期',
  select: '从设定的选项中选择一个',
  bool: '选择「是」或「否」',
  tags: '可从设定的选项中勾选多个',
};

/** 把高级设置翻译成普通用户看得懂的预览说明。 */
const previewHint = computed(() => {
  const parts: string[] = [TYPE_TIP[fieldEditor.type]];
  const isText = fieldEditor.type === 'text' || fieldEditor.type === 'textarea';
  const maxLen = numText(fieldEditor.maxLength);
  if (isText && maxLen && Number(maxLen) > 0) parts.push(`最多 ${maxLen} 个字`);
  if (isText && fieldEditor.pattern.trim()) parts.push(`内容需符合格式 ${fieldEditor.pattern.trim()}`);
  if (fieldEditor.type === 'number') {
    const min = numText(fieldEditor.min);
    const max = numText(fieldEditor.max);
    if (min && max) parts.push(`取值范围 ${min} ~ ${max}`);
    else if (min) parts.push(`不能小于 ${min}`);
    else if (max) parts.push(`不能大于 ${max}`);
  }
  if (fieldEditor.type === 'tags' && numText(fieldEditor.maxItems)) {
    parts.push(`最多可选 ${numText(fieldEditor.maxItems)} 项`);
  }
  parts.push(fieldEditor.required ? '创建档案时必须填写' : '可以不填');
  return parts.join(' · ');
});

const previewPlaceholder = computed(() => {
  const example = typeExample(fieldEditor.type);
  return example ? `如：${example}` : '请输入';
});

/** 分类下拉选项：带层级缩进与档号前缀，值统一为字符串。 */
const categoryBindOptions = computed(() =>
  categories.value.map((c) => ({
    label: `${'　'.repeat(c.depth)}${c.name}（${c.pathCode}）`,
    value: String(c.id),
  })),
);

/** 当前模板已绑定的分类（旧后端响应缺失时兜底为空列表）。 */
const boundCategories = computed(() => current.value?.boundCategories ?? []);

/** 可绑定分类：排除已绑定当前模板的分类。 */
const bindableCategoryOptions = computed(() => {
  const bound = new Set(boundCategories.value.map((c) => String(c.id)));
  return categoryBindOptions.value.filter((o) => !bound.has(o.value));
});

/** 已绑定分类展示名：以分类名称为主，路径编码作括注辅助识别同名分类。 */
function boundCategoryLabel(c: { id: number; name: string }): string {
  const cat = categories.value.find((x) => x.id === c.id);
  if (!cat) return c.name;
  return cat.pathCode ? `${cat.name}（${cat.pathCode}）` : cat.name;
}

/** 预览用选项（单个下拉）。 */
const previewSelectOptions = computed(() =>
  previewOptions.value.map((o) => ({ label: o, value: o })),
);

/** 预览用选项（布尔）。 */
const boolPreviewOptions = [
  { label: '是', value: '1' },
  { label: '否', value: '0' },
];

async function reloadTemplates(keepId?: number) {
  loading.value = true;
  error.value = '';
  try {
    templates.value = await api.get<MetadataTemplateView[]>('/templates');
    const target = keepId ?? current.value?.id;
    if (target && templates.value.some((t) => t.id === target)) {
      await selectTemplate(target);
    } else if (templates.value.length) {
      await selectTemplate(templates.value[0].id);
    } else {
      current.value = null;
    }
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    loading.value = false;
  }
}

async function selectTemplate(id: number) {
  error.value = '';
  try {
    current.value = await api.get<MetadataTemplateDetailView>(`/templates/${id}`);
    meta.name = current.value.name;
    meta.description = current.value.description;
  } catch (e) {
    error.value = errMsg(e);
  }
}

function startCreateTemplate() {
  current.value = null;
  meta.name = '';
  meta.description = '';
  notice.value = '';
  error.value = '';
}

async function saveTemplateMeta() {
  if (!current.value || saving.value) return;
  error.value = '';
  notice.value = '';
  saving.value = true;
  try {
    await api.put<MetadataTemplateView>(`/templates/${current.value.id}`, {
      name: meta.name.trim(),
      description: meta.description.trim(),
    });
    notice.value = '模板信息已更新。';
    await reloadTemplates(current.value.id);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function createTemplate() {
  if (saving.value) return;
  error.value = '';
  notice.value = '';
  if (!meta.name.trim()) {
    error.value = '请填写模板名称';
    return;
  }
  saving.value = true;
  try {
    const created = await api.post<MetadataTemplateDetailView>('/templates', {
      name: meta.name.trim(),
      description: meta.description.trim(),
      fields: [],
    });
    notice.value = `已创建模板「${created.name}」，可继续为其添加档案信息项。`;
    await reloadTemplates(created.id);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function toggleStatus() {
  if (!current.value || saving.value) return;
  error.value = '';
  notice.value = '';
  saving.value = true;
  const next = current.value.status === 'active' ? 'disabled' : 'active';
  try {
    await api.post<MetadataTemplateView>(`/templates/${current.value.id}/status`, { status: next });
    notice.value = next === 'active' ? '模板已启用。' : '模板已停用（不影响历史著录值）。';
    await reloadTemplates(current.value.id);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

/**
 * 删除模板：仅未被分类绑定、也没有历史著录值时才可删；
 * 已被绑定的分类与历史填写内容必须保留，此时后端拒绝并提示改为停用（引用保护）。
 */
async function removeTemplate() {
  if (!current.value || saving.value) return;
  const target = current.value;
  error.value = '';
  notice.value = '';
  const ok = await confirmDialog({
    title: '删除模板',
    message: `确认删除模板「${target.name}」及其 ${target.fieldCount} 个信息项？删除后不可恢复。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  saving.value = true;
  try {
    await api.del<{ ok: true }>(`/templates/${target.id}`);
    notice.value = `已删除模板「${target.name}」。`;
    current.value = null;
    await reloadTemplates();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

// ==================== 字段配置 ====================

function startAddField() {
  fieldEditor.mode = 'create';
  fieldEditor.id = 0;
  fieldEditor.label = '';
  fieldEditor.type = 'text';
  fieldEditor.required = false;
  fieldEditor.optionsText = '';
  fieldEditor.maxLength = '';
  fieldEditor.pattern = '';
  fieldEditor.min = '';
  fieldEditor.max = '';
  fieldEditor.maxItems = '';
  fieldError.value = '';
  showAdvanced.value = false;
}

function startEditField(f: TemplateFieldView) {
  fieldEditor.mode = 'edit';
  fieldEditor.id = f.id;
  fieldEditor.label = f.label;
  fieldEditor.type = f.type;
  fieldEditor.required = f.required;
  fieldEditor.optionsText = f.options.join('\n');
  fieldEditor.maxLength = f.validation.maxLength != null ? String(f.validation.maxLength) : '';
  fieldEditor.pattern = f.validation.pattern != null ? String(f.validation.pattern) : '';
  fieldEditor.min = f.validation.min != null ? String(f.validation.min) : '';
  fieldEditor.max = f.validation.max != null ? String(f.validation.max) : '';
  fieldEditor.maxItems = f.validation.maxItems != null ? String(f.validation.maxItems) : '';
  fieldError.value = '';
  // 已有进阶配置时自动展开，避免编辑时看不到已存在的规则。
  showAdvanced.value = hasAdvancedValue(f);
}

function cancelField() {
  fieldEditor.mode = '';
  fieldError.value = '';
}

/** 该信息项是否已配置进阶规则（用于编辑时决定高级设置是否展开）。 */
function hasAdvancedValue(f: TemplateFieldView): boolean {
  return ['maxLength', 'pattern', 'min', 'max', 'maxItems'].some(
    (k) => f.validation[k] != null && f.validation[k] !== '',
  );
}

/** 把「可选项」文本解析为数组：支持换行、英文逗号、中文逗号分隔。 */
function parseOptions(): string[] {
  return fieldEditor.optionsText
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 生成字段标识（field_key）：字母开头、仅字母/数字/下划线、不超过 40 位，
 * 并保证与当前模板已有标识（含已停用）不重复，满足后端唯一约束。
 */
function generateFieldKey(): string {
  const used = new Set((current.value?.fields ?? []).map((f) => f.fieldKey));
  let key = '';
  do {
    key = 'f' + Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 10);
  } while (key.length < 2 || used.has(key));
  return key;
}

function buildValidation(): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  if (fieldEditor.type === 'number') {
    if (numText(fieldEditor.min) !== '') v.min = Number(fieldEditor.min);
    if (numText(fieldEditor.max) !== '') v.max = Number(fieldEditor.max);
  }
  if (fieldEditor.type === 'text' || fieldEditor.type === 'textarea') {
    if (numText(fieldEditor.maxLength) !== '') v.maxLength = Number(fieldEditor.maxLength);
    if (fieldEditor.pattern.trim()) v.pattern = fieldEditor.pattern.trim();
  }
  if (fieldEditor.type === 'tags' && numText(fieldEditor.maxItems) !== '') {
    v.maxItems = Number(fieldEditor.maxItems);
  }
  return v;
}

/** 提交前的就地校验：把明显的输入错误提前提示，不必等后端报错。 */
function validateFieldEditor(): string {
  const label = fieldEditor.label.trim();
  if (!label) return '请填写信息项名称';
  if (label.length > 50) return '信息项名称不能超过 50 个字符';
  if (needsOptions.value) {
    const options = parseOptions();
    if (!options.length) return '请至少填写一个可选项';
    if (new Set(options).size !== options.length) return '可选项不能重复';
    if (options.some((o) => o.length > 50)) return '单个可选项不能超过 50 个字符';
  }
  const isText = fieldEditor.type === 'text' || fieldEditor.type === 'textarea';
  if (isText && numText(fieldEditor.maxLength)) {
    const n = Number(fieldEditor.maxLength);
    if (!Number.isInteger(n) || n < 1 || n > 5000) return '“最多填写多少字”需为 1-5000 的整数';
  }
  if (isText && fieldEditor.pattern.trim()) {
    try {
      new RegExp(fieldEditor.pattern.trim());
    } catch {
      return '格式校验规则不是合法的正则表达式，请修改或留空';
    }
  }
  if (fieldEditor.type === 'number') {
    const min = numText(fieldEditor.min);
    const max = numText(fieldEditor.max);
    if (min && !Number.isFinite(Number(min))) return '最小值需为数字';
    if (max && !Number.isFinite(Number(max))) return '最大值需为数字';
    if (min && max && Number(min) > Number(max)) return '最小值不能大于最大值';
  }
  if (fieldEditor.type === 'tags' && numText(fieldEditor.maxItems)) {
    const n = Number(fieldEditor.maxItems);
    if (!Number.isInteger(n) || n < 1) return '“最多可选几项”需为正整数';
  }
  return '';
}

async function submitField() {
  if (!current.value || saving.value) return;
  fieldError.value = '';
  const problem = validateFieldEditor();
  if (problem) {
    fieldError.value = problem;
    return;
  }
  saving.value = true;
  const options = needsOptions.value ? parseOptions() : [];
  const payload: Record<string, unknown> = {
    label: fieldEditor.label.trim(),
    type: fieldEditor.type,
    required: fieldEditor.required,
    options,
    validation: buildValidation(),
  };
  try {
    if (fieldEditor.mode === 'create') {
      payload.fieldKey = generateFieldKey();
      await api.post<TemplateFieldView>(`/templates/${current.value.id}/fields`, payload);
      notice.value = '档案信息项已添加。';
    } else {
      await api.put<TemplateFieldView>(`/templates/${current.value.id}/fields/${fieldEditor.id}`, payload);
      notice.value = '档案信息项已更新。';
    }
    fieldEditor.mode = '';
    await reloadTemplates(current.value.id);
  } catch (e) {
    fieldError.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function deactivateField(f: TemplateFieldView) {
  if (!current.value || saving.value) return;
  const ok = await confirmDialog({
    title: '停用信息项',
    message: `确认停用信息项「${f.label}」？已被档案引用的历史值将保留。`,
    confirmText: '确认停用',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  saving.value = true;
  try {
    await api.del<TemplateFieldView>(`/templates/${current.value.id}/fields/${f.id}`);
    notice.value = '档案信息项已停用。';
    await reloadTemplates(current.value.id);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

// ==================== 分类绑定（内联在模板配置内） ====================

async function doBind() {
  if (!current.value) return;
  error.value = '';
  notice.value = '';
  if (!bind.categoryId) {
    error.value = '请选择要绑定的分类';
    return;
  }
  saving.value = true;
  try {
    await api.put<{ categoryId: number; templateId: number | null }>(
      `/categories/${bind.categoryId}/template`,
      { templateId: current.value.id },
    );
    notice.value = '分类已绑定本模板，著录表单将按模板渲染动态字段。';
    bind.categoryId = '';
    await reloadTemplates(current.value.id);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

async function unbindCategory(categoryId: string | number) {
  if (!current.value || saving.value) return;
  error.value = '';
  notice.value = '';
  saving.value = true;
  try {
    await api.put<{ categoryId: number; templateId: number | null }>(
      `/categories/${categoryId}/template`,
      { templateId: null },
    );
    notice.value = '已解除该分类的模板绑定。';
    await reloadTemplates(current.value.id);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  try {
    categories.value = await api.get<CategoryView[]>('/categories');
  } catch {
    categories.value = [];
  }
  await reloadTemplates();
});
</script>

<template>
  <div>
    <h2 class="page-title">元数据模板管理</h2>
    <p class="text-muted page-desc">
      为档案著录表单配置要填写的信息项（七种填写方式），并在模板配置中直接将模板绑定到分类。{{ canManage ? '' : '当前角色仅可查看，模板维护由管理员负责。' }}
    </p>


    <div class="cols">
      <!-- 模板列表 -->
      <section class="card">
        <div class="card-title">
          模板列表<span class="badge badge-muted" v-if="loading">加载中…</span>
          <button v-if="canManage" class="btn btn-primary btn-sm push-right" @click="startCreateTemplate">
            新建模板
          </button>
        </div>
        <ul class="tpl-list">
          <li
            v-for="t in templates"
            :key="t.id"
            :class="{ active: current?.id === t.id }"
            @click="selectTemplate(t.id)"
          >
            <span class="tpl-name">{{ t.name }}</span>
            <span :class="t.status === 'active' ? 'badge badge-success' : 'badge badge-muted'">
              {{ t.status === 'active' ? '启用' : '停用' }}
            </span>
            <span class="text-muted tpl-count">{{ t.fieldCount }} 个信息项</span>
          </li>
        </ul>
        <AppEmpty v-if="!loading && templates.length === 0" title="暂无模板" compact />
      </section>

      <!-- 模板详情 / 新建 -->
      <section class="card">
        <template v-if="current">
          <div class="card-title">
            模板配置
            <span :class="current.status === 'active' ? 'badge badge-success' : 'badge badge-muted'">
              {{ current.status === 'active' ? '启用' : '停用' }}
            </span>
          </div>
          <div class="field">
            <label for="t-name">模板名称 <span class="req">*</span></label>
            <input id="t-name" v-model="meta.name" :disabled="!canManage || saving" maxlength="50" />
          </div>
          <div class="field">
            <label for="t-desc">模板说明</label>
            <textarea id="t-desc" v-model="meta.description" :disabled="!canManage || saving" maxlength="200" rows="2"></textarea>
          </div>
          <div class="actions" v-if="canManage">
            <button class="btn btn-primary btn-sm" :disabled="saving" @click="saveTemplateMeta">保存信息</button>
            <button class="btn btn-sm" :disabled="saving" @click="toggleStatus">
              {{ current.status === 'active' ? '停用模板' : '启用模板' }}
            </button>
            <button class="btn btn-sm btn-danger" :disabled="saving" @click="removeTemplate">
              删除模板
            </button>
          </div>

          <!-- 分类绑定：内联在模板配置内，靠近顶部不被信息项表格挤出视野 -->
          <div class="card-title sub">适用分类（模板绑定）</div>
          <p class="text-muted section-desc">
            著录表单按所选分类绑定的模板动态渲染字段；停用模板不可新增绑定。
          </p>
          <div class="bind-row">
            <div class="field">
              <label for="b-cat">选择分类</label>
              <AppSelect
                id="b-cat"
                v-model="bind.categoryId"
                :options="bindableCategoryOptions"
                :disabled="!canManage || saving || current.status !== 'active'"
                placeholder="请选择分类"
              />
            </div>
            <button
              v-if="canManage"
              class="btn btn-primary btn-sm"
              :disabled="saving || current.status !== 'active'"
              @click="doBind"
            >
              绑定
            </button>
          </div>
          <p class="text-muted hint" v-if="current.status !== 'active'">模板已停用，启用后才能绑定分类。</p>
          <div class="bound-list" v-if="boundCategories.length">
            <span class="bound-item" v-for="c in boundCategories" :key="c.id">
              {{ boundCategoryLabel(c) }}
              <button
                v-if="canManage"
                class="bound-remove"
                type="button"
                :disabled="saving"
                :title="`解除分类「${c.name}」的绑定`"
                @click="unbindCategory(c.id)"
              >
                × 解除
              </button>
            </span>
          </div>
          <p class="text-muted hint" v-else>尚未绑定任何分类，绑定后该分类创建档案时将按本模板填写信息项。</p>

          <div class="card-title sub">
            档案信息项
            <button v-if="canManage" class="btn btn-sm push-right" @click="startAddField">添加档案信息项</button>
          </div>
          <p class="text-muted section-desc">
            这里配置创建档案时要填的内容，例如「保管期限」「密级」；信息项标识由系统自动生成，无需填写。
          </p>
          <div class="table-wrap">
            <table class="table tbl-fields">
              <colgroup>
                <col />
                <col class="col-f-type" />
                <col class="col-f-req" />
                <col class="col-f-status" />
                <col class="col-f-ops" />
              </colgroup>
              <thead>
                <tr>
                  <th>信息项名称</th>
                  <th>填写方式</th>
                  <th>是否必填</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in current.fields" :key="f.id">
                  <td>{{ f.label }}<span class="text-muted" v-if="f.referenced"> · 已引用</span></td>
                  <td>{{ typeLabel(f.type) }}</td>
                  <td>{{ f.required ? '必须填写' : '选填' }}</td>
                  <td>
                    <span :class="f.active ? 'badge badge-success' : 'badge badge-muted'">
                      {{ f.active ? '启用' : '停用' }}
                    </span>
                  </td>
                  <td v-if="canManage">
                    <button class="btn btn-sm" @click="startEditField(f)">编辑</button>
                    <button class="btn btn-sm" v-if="f.active" @click="deactivateField(f)">停用</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <AppEmpty
            v-if="!current.fields.length"
            compact
            title="还没有档案信息项"
            description="点击上方「添加档案信息项」开始配置。"
          />
        </template>

        <template v-else>
          <div class="card-title">新建模板</div>
          <div class="field">
            <label for="n-name">模板名称 <span class="req">*</span></label>
            <input id="n-name" v-model="meta.name" :disabled="!canManage || saving" maxlength="50" placeholder="1-50 个字符，不可重名" />
          </div>
          <div class="field">
            <label for="n-desc">模板说明</label>
            <textarea id="n-desc" v-model="meta.description" :disabled="!canManage || saving" maxlength="200" rows="2"></textarea>
          </div>
          <div class="actions" v-if="canManage">
            <button class="btn btn-primary" :disabled="saving" @click="createTemplate">
              {{ saving ? '创建中…' : '创建模板' }}
            </button>
          </div>
          <p class="text-muted" v-else>仅管理员可创建模板。</p>
        </template>
      </section>
    </div>

    <!-- 档案信息项 添加 / 编辑弹窗 -->
    <AppModal
      :open="!!fieldEditor.mode"
      :title="fieldEditor.mode === 'create' ? '添加档案信息项' : '编辑档案信息项'"
      subtitle="档案信息项就是创建档案时额外要填写的内容，例如「保管期限」「密级」。填好名称和填写方式即可使用，信息项标识由系统自动生成。"
      :width="600"
      @update:open="(v) => { if (!v) cancelField(); }"
    >
      <div class="field">
        <label for="f-label">信息项名称 <span class="req">*</span></label>
        <input id="f-label" v-model="fieldEditor.label" maxlength="50" placeholder="如：保管期限" />
        <p class="text-muted hint">填写时这一项的名称，建议 2-8 个字。</p>
      </div>

      <div class="field">
        <label>填写方式 <span class="req">*</span></label>
        <div class="type-grid">
          <button
            v-for="o in FIELD_TYPE_OPTIONS"
            :key="o.value"
            type="button"
            class="type-card"
            :class="{ active: fieldEditor.type === o.value }"
            :disabled="typeLocked"
            @click="fieldEditor.type = o.value"
          >
            <span class="type-name">{{ o.label }}</span>
            <span class="type-tip">{{ o.hint }}</span>
          </button>
        </div>
        <p class="text-muted hint" v-if="typeLocked">
          该信息项已被档案使用，填写方式不可修改；如需更换请停用后重新添加。
        </p>
        <p class="text-muted hint" v-else>选好后，下方会显示这一项需要的设置和填写效果预览。</p>
      </div>

      <div class="field" v-if="needsOptions">
        <label for="f-opts">可选项 <span class="req">*</span></label>
        <textarea
          id="f-opts"
          v-model="fieldEditor.optionsText"
          rows="4"
          placeholder="每行一个选项，例如：&#10;永久&#10;30 年&#10;10 年"
        ></textarea>
        <p class="text-muted hint">
          每行一个（也可用逗号分隔）。{{ fieldEditor.type === 'tags' ? '填写档案时可从中勾选多个。' : '填写档案时可从中选择一个。' }}
        </p>
      </div>

      <div class="field check-field">
        <AppCheckbox id="f-req" v-model="fieldEditor.required" label="创建档案时必须填写" />
        <p class="text-muted hint">勾选后，这一项在创建档案时不能留空。</p>
      </div>

      <div class="advanced">
        <button type="button" class="adv-toggle" @click="showAdvanced = !showAdvanced">
          <span class="adv-arrow">{{ showAdvanced ? '▾' : '▸' }}</span>
          <span>高级设置</span>
          <span class="text-muted" v-if="!showAdvanced">（选填：字数/范围限制、格式校验）</span>
        </button>
        <div class="adv-body" v-if="showAdvanced">
          <div class="field" v-if="fieldEditor.type === 'text' || fieldEditor.type === 'textarea'">
            <label for="f-maxlen">最多填写多少字</label>
            <AppNumberInput
              id="f-maxlen"
              v-model="fieldEditor.maxLength"
              :min="1"
              :max="5000"
              placeholder="留空表示不限制"
            />
          </div>
          <div class="field" v-if="fieldEditor.type === 'text' || fieldEditor.type === 'textarea'">
            <label for="f-pattern">内容格式校验（正则表达式）</label>
            <input id="f-pattern" v-model="fieldEditor.pattern" placeholder="如 ^[0-9]+$ 表示只能填数字" />
            <p class="text-muted hint">不确定请留空；填写不合法的规则会导致保存失败。</p>
          </div>
          <div class="field" v-if="fieldEditor.type === 'number'">
            <label for="f-min">最小值</label>
            <AppNumberInput id="f-min" v-model="fieldEditor.min" placeholder="留空表示不限制" />
          </div>
          <div class="field" v-if="fieldEditor.type === 'number'">
            <label for="f-max">最大值</label>
            <AppNumberInput id="f-max" v-model="fieldEditor.max" placeholder="留空表示不限制" />
          </div>
          <div class="field" v-if="fieldEditor.type === 'tags'">
            <label for="f-maxitems">最多可选几项</label>
            <AppNumberInput
              id="f-maxitems"
              v-model="fieldEditor.maxItems"
              :min="1"
              placeholder="留空表示不限制"
            />
          </div>
          <p
            class="text-muted hint adv-empty"
            v-if="!['text', 'textarea', 'number', 'tags'].includes(fieldEditor.type)"
          >
            当前填写方式没有更多高级设置。
          </p>
        </div>
      </div>

      <div class="preview">
        <div class="preview-title">填写效果预览 <span class="text-muted">（创建档案时看到的样子）</span></div>
        <div class="preview-box">
          <span class="preview-label">
            {{ fieldEditor.label.trim() || '未命名信息项' }}<span class="req" v-if="fieldEditor.required"> *</span>
          </span>
          <textarea
            v-if="fieldEditor.type === 'textarea'"
            class="ui-textarea"
            rows="2"
            disabled
            :placeholder="previewPlaceholder"
          ></textarea>
          <AppSelect
            v-else-if="fieldEditor.type === 'select'"
            size="sm"
            disabled
            model-value=""
            :options="previewSelectOptions"
            :placeholder="previewOptions.length ? '请选择' : '请先在「可选项」中填写选项'"
          />
          <AppSelect
            v-else-if="fieldEditor.type === 'bool'"
            size="sm"
            disabled
            model-value=""
            :options="boolPreviewOptions"
            placeholder="请选择"
          />
          <div v-else-if="fieldEditor.type === 'tags'" class="preview-tags">
            <span class="preview-tag" v-for="o in previewOptions" :key="o">{{ o }}</span>
            <span class="text-muted" v-if="!previewOptions.length">先在「可选项」中填写选项</span>
          </div>
          <AppNumberInput
            v-else-if="fieldEditor.type === 'number'"
            size="sm"
            disabled
            model-value=""
            :placeholder="previewPlaceholder"
          />
          <AppDatePicker v-else-if="fieldEditor.type === 'date'" size="sm" disabled model-value="" />
          <input v-else type="text" disabled :placeholder="previewPlaceholder" />
          <p class="preview-hint">{{ previewHint }}</p>
        </div>
      </div>

      <template #footer>
        <span class="modal-error" v-if="fieldError">{{ fieldError }}</span>
        <div class="modal-btns">
          <button class="btn" type="button" :disabled="saving" @click="cancelField">取消</button>
          <button class="btn btn-primary" type="button" :disabled="saving" @click="submitField">
            {{ saving ? '保存中…' : fieldEditor.mode === 'create' ? '确认添加' : '保存修改' }}
          </button>
        </div>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.cols { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 20px; align-items: start; }
.tpl-list { list-style: none; margin: 0; padding: 0; }
.tpl-list li {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 8px; cursor: pointer; margin-bottom: 4px;
}
.tpl-list li:hover { background: var(--color-primary-soft); }
.tpl-list li.active { background: var(--color-primary-soft); font-weight: 600; }
.tpl-name { flex: 1; }
.tpl-count { font-size: 12px; }
.card-title.sub { margin-top: 20px; }
.section-desc { margin: 0 0 12px; }
/* 信息项表格：短列不折行，长名称列自适应换行；窄屏时表格内部横向滚动而不是撑破卡片 */
.table-wrap { overflow-x: auto; }
.tbl-fields { table-layout: fixed; min-width: 540px; }
.col-f-type { width: 110px; }
.col-f-req { width: 90px; }
.col-f-status { width: 76px; }
.col-f-ops { width: 140px; }
.table th { white-space: nowrap; }
.table td { vertical-align: middle; }
.table td:nth-child(2),
.table td:nth-child(3),
.table td:nth-child(4),
.table td:last-child { white-space: nowrap; }
.table td .badge { white-space: nowrap; }
.table td .btn + .btn { margin-left: 6px; }
.req { color: var(--color-danger); }
.push-right { margin-left: auto; }
.actions { display: flex; gap: 12px; margin-top: 8px; }
.bind-row { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
/* .field 全局带 margin-bottom:16px，会让「绑定」按钮相对下拉框下沉错位，此处清零 */
.bind-row .field { min-width: 220px; margin-bottom: 0; }
/* 按钮与「下拉框本体」垂直居中：行底对齐后，按钮底边抬高（下拉框高 − 按钮高）/2，
   只依赖已知控件高度，不受 label 字体行高影响 */
.bind-row .field + .btn { margin-bottom: calc((var(--control-h) - 26px) / 2); }
.bound-list { display: flex; flex-wrap: wrap; gap: 8px; }
.bound-item {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; border: 1px solid #e5e6eb; border-radius: 20px;
  font-size: 13px; color: var(--text-body);
}
.bound-remove {
  border: none; background: none; padding: 0; font-family: inherit;
  font-size: 12px; color: var(--color-danger); cursor: pointer;
}
.bound-remove:hover:not(:disabled) { text-decoration: underline; }
.bound-remove:disabled { opacity: 0.55; cursor: not-allowed; }
.hint { font-size: 12px; margin-top: 4px; }

/* ===== 信息项弹窗（壳层样式由 AppModal 提供，此处只保留页内布局） ===== */
.modal-error { font-size: 13px; color: var(--color-danger); }
.modal-btns { display: flex; gap: 10px; margin-left: auto; }
.modal-btns .btn { min-width: 96px; }

/* 填写方式选择卡片 */
.type-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.type-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  padding: 8px 12px; border: 1px solid #e5e6eb; border-radius: var(--radius-control);
  background: #fff; text-align: left; font-family: inherit; cursor: pointer; transition: all 0.15s;
}
.type-card:hover:not(:disabled) { border-color: var(--color-primary); }
.type-card.active { border-color: var(--color-primary); background: var(--color-primary-soft); }
.type-card:disabled { opacity: 0.55; cursor: not-allowed; }
.type-name { font-size: 13px; font-weight: 500; color: var(--text-title); }
.type-card.active .type-name { color: var(--color-primary); font-weight: 600; }
.type-tip { font-size: 12px; color: var(--text-muted); line-height: 1.5; }

/* 必填勾选：提示文案与自绘复选框对齐 */
.check-field .hint { margin: 6px 0 0 24px; }

/* 高级设置（默认折叠） */
.advanced {
  border: 1px dashed #e5e6eb; border-radius: 10px; background: #fcfcfd;
  padding: 0 12px; margin-bottom: 16px;
}
.adv-toggle {
  display: flex; align-items: center; gap: 6px; width: 100%;
  padding: 10px 0; border: none; background: none; font-family: inherit;
  font-size: 13px; color: var(--text-body); cursor: pointer; text-align: left;
}
.adv-toggle:hover { color: var(--color-primary); }
.adv-arrow { width: 12px; color: var(--text-muted); }
.adv-body { padding: 2px 0 4px; }
.adv-body .field { margin-bottom: 12px; }
.adv-empty { margin: 0 0 10px; }

/* 填写效果预览 */
.preview {
  background: #f7f8fa; border: 1px solid var(--border-light); border-radius: 10px;
  padding: 12px 14px; margin-bottom: 16px;
}
.preview-title { font-size: 13px; font-weight: 600; color: var(--text-title); margin-bottom: 10px; }
.preview-title .text-muted { font-weight: 400; }
.preview-box {
  background: #fff; border: 1px solid var(--border-light);
  border-radius: var(--radius-control); padding: 12px 14px;
}
.preview-label { display: block; font-size: 13px; color: var(--text-body); margin-bottom: 6px; }
.preview-box input {
  width: 100%; border: 1px solid var(--border-control); border-radius: var(--radius-control);
  padding: 7px 11px; font-size: 13px; font-family: inherit; color: var(--text-title);
  background: #fff; outline: none;
}
.preview-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.preview-tag {
  padding: 2px 10px; border: 1px solid #e5e6eb; border-radius: 20px;
  font-size: 12px; color: var(--text-body);
}
.preview-hint { margin: 8px 0 0; font-size: 12px; color: var(--text-muted); }

@media (max-width: 1100px) { .cols { grid-template-columns: minmax(0, 1fr); } }

/* 移动端：绑定条件单列、信息项表格横向滚动 */
@media (max-width: 767px) {
  .bind-row .field { flex: 1 1 100%; min-width: 0; }
  .table { min-width: 620px; }
  .type-grid { grid-template-columns: minmax(0, 1fr); }
}
</style>
