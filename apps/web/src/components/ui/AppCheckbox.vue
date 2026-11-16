<script setup lang="ts">
/**
 * 统一风格复选框。
 *
 * 视觉层自绘方框与勾选动画，语义层仍保留真实 `input[type=checkbox]`：
 * - Space 键勾选、Tab 聚焦、表单禁用、屏幕阅读器识别全部由原生控件负责；
 * - 输入框透明覆盖在方框上，因此 `label` 包裹时点击文字同样生效；
 * - 不再受「`.field input` 宽度 100%」影响（该规则历史上会把复选框拉宽、挤断标签）。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    disabled?: boolean;
    id?: string;
    label?: string;
    indeterminate?: boolean;
    ariaLabel?: string;
  }>(),
  { disabled: false, label: undefined, indeterminate: false, ariaLabel: undefined },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'change', value: boolean): void;
}>();

const checked = computed(() => props.modelValue);

function onChange(event: Event): void {
  const value = (event.target as HTMLInputElement).checked;
  emit('update:modelValue', value);
  emit('change', value);
}
</script>

<template>
  <label class="ui-check" :class="{ 'is-disabled': props.disabled, 'is-checked': checked }">
    <input
      :id="props.id"
      class="ui-check__input"
      type="checkbox"
      :checked="checked"
      :disabled="props.disabled"
      :aria-label="props.ariaLabel"
      :indeterminate.prop="props.indeterminate && !checked"
      @change="onChange"
    />
    <span class="ui-check__box" aria-hidden="true">
      <svg v-if="props.indeterminate && !checked" viewBox="0 0 12 12" width="10" height="10">
        <path d="M2.5 6h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
      <svg v-else viewBox="0 0 12 10" width="10" height="10">
        <path
          d="M1 5l3.2 3.2L11 1.5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>
    <span v-if="props.label || $slots.default" class="ui-check__label">
      <slot>{{ props.label }}</slot>
    </span>
  </label>
</template>

<style scoped>
.ui-check {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-title);
  cursor: pointer;
  user-select: none;
}
.ui-check.is-disabled {
  color: var(--text-muted);
  cursor: not-allowed;
}

/* 原生输入框：透明覆盖在自绘方框上，保留语义与键盘操作 */
.ui-check__input {
  position: absolute;
  left: 0;
  top: 50%;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  opacity: 0;
  transform: translateY(-50%);
  cursor: inherit;
  z-index: 1;
}

.ui-check__box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  border: 1px solid var(--border-control);
  border-radius: 4px;
  background: #fff;
  color: #fff;
  transition: background var(--dur) ease, border-color var(--dur) ease, box-shadow var(--dur) ease;
}
.ui-check__box svg {
  opacity: 0;
  transform: scale(0.7);
  transition: opacity var(--dur) ease, transform var(--dur) ease;
}
.ui-check.is-checked .ui-check__box,
.ui-check__input:indeterminate + .ui-check__box {
  border-color: var(--color-primary);
  background: var(--color-primary);
}
.ui-check.is-checked .ui-check__box svg,
.ui-check__input:indeterminate + .ui-check__box svg {
  opacity: 1;
  transform: scale(1);
}
.ui-check:hover:not(.is-disabled) .ui-check__box {
  border-color: var(--color-primary);
}
.ui-check__input:focus-visible + .ui-check__box {
  border-color: var(--color-primary);
  box-shadow: var(--ring);
}
.ui-check.is-disabled .ui-check__box {
  border-color: var(--border-light);
  background: var(--bg-disabled);
}
.ui-check.is-disabled.is-checked .ui-check__box {
  border-color: var(--border-control);
  background: var(--border-control);
}

.ui-check__label {
  line-height: 1.5;
}

/* 移动端：放大点击区域，避免误触 */
@media (max-width: 767px) {
  .ui-check {
    gap: 10px;
    padding: 2px 0;
  }
  .ui-check__box,
  .ui-check__input {
    width: 18px;
    height: 18px;
  }
}
</style>
