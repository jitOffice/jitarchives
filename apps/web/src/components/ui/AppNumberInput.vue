<script setup lang="ts">
/**
 * 统一风格数字输入框。
 *
 * 内部仍然是原生 `input[type=number]`：
 * - 保留浏览器对 min / max / step 的原生校验、滚轮调值与 ↑↓ 键步进；
 * - 只是用全局样式隐藏原生上下箭头，再在右侧加一对自绘 −/+ 按钮，视觉与其它控件一致；
 * - 清空时向父组件回传空字符串（与 Vue 对 `type=number` 的原生行为一致），
 *   读取处沿用既有的 `Number(...)` 转换，业务校验分支不做改动。
 */
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string | number;
    min?: number;
    max?: number;
    step?: number;
    disabled?: boolean;
    size?: 'md' | 'sm';
    id?: string;
    placeholder?: string;
    invalid?: boolean;
    ariaLabel?: string;
  }>(),
  {
    min: undefined,
    max: undefined,
    step: 1,
    disabled: false,
    size: 'md',
    placeholder: undefined,
    invalid: false,
    ariaLabel: undefined,
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string | number): void;
  (event: 'change', value: string | number): void;
}>();

const inputEl = ref<HTMLInputElement | null>(null);

const numericValue = computed<number | null>(() => {
  if (props.modelValue === '') return null;
  const parsed = Number(props.modelValue);
  return Number.isFinite(parsed) ? parsed : null;
});

const canStepDown = computed(
  () => !props.disabled && (props.min === undefined || numericValue.value === null || numericValue.value > props.min),
);
const canStepUp = computed(
  () => !props.disabled && (props.max === undefined || numericValue.value === null || numericValue.value < props.max),
);

/** 与 Vue 的 looseToNumber 保持一致：能转成数字就转，转不了就保留原始字符串。 */
function normalize(raw: string): string | number {
  if (raw === '') return '';
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
}

function commit(value: string | number): void {
  if (value === props.modelValue) return;
  emit('update:modelValue', value);
  emit('change', value);
}

function onInput(event: Event): void {
  commit(normalize((event.target as HTMLInputElement).value));
}

function stepBy(direction: 1 | -1): void {
  if (props.disabled) return;
  const base = numericValue.value ?? props.min ?? 0;
  let next = base + direction * props.step;
  if (props.min !== undefined) next = Math.max(props.min, next);
  if (props.max !== undefined) next = Math.min(props.max, next);
  // 避免浮点步进出现 0.30000000000000004 之类的尾数
  next = Number(next.toFixed(10));
  commit(next);
  inputEl.value?.focus();
}
</script>

<template>
  <div class="ui-number" :class="[`ui-number--${props.size}`, { 'is-disabled': props.disabled }]">
    <input
      :id="props.id"
      ref="inputEl"
      class="ui-number__input"
      type="number"
      :value="props.modelValue"
      :min="props.min"
      :max="props.max"
      :step="props.step"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      :aria-label="props.ariaLabel"
      :aria-invalid="props.invalid || undefined"
      @input="onInput"
    />
    <div class="ui-number__steppers">
      <button
        class="ui-number__step"
        type="button"
        tabindex="-1"
        aria-label="减少"
        :disabled="!canStepDown"
        @click="stepBy(-1)"
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M1.5 5h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="ui-number__step"
        type="button"
        tabindex="-1"
        aria-label="增加"
        :disabled="!canStepUp"
        @click="stepBy(1)"
      >
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M5 1.5v7M1.5 5h7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.ui-number {
  position: relative;
  width: 100%;
}

.ui-number__input {
  width: 100%;
  padding-right: 32px;
  transition: border-color var(--dur) ease, box-shadow var(--dur) ease;
}
.ui-number__input:focus {
  border-color: var(--color-primary);
  box-shadow: var(--ring);
}
.ui-number--sm .ui-number__input {
  padding: 3px 28px 3px 8px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

/* 自绘步进按钮：替换原生上下箭头，尺寸与控件高度匹配 */
.ui-number__steppers {
  position: absolute;
  right: 4px;
  top: 50%;
  display: flex;
  flex-direction: column;
  gap: 1px;
  transform: translateY(-50%);
}
.ui-number__step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 14px;
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background var(--dur) ease, color var(--dur) ease;
}
.ui-number__step:hover:not(:disabled) {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.ui-number__step:disabled {
  color: var(--text-placeholder);
  cursor: not-allowed;
}
.ui-number--sm .ui-number__step {
  width: 18px;
  height: 11px;
}

/* 移动端：不显示步进按钮，直接用系统数字键盘，保证触控与空间 */
@media (max-width: 767px) {
  .ui-number__steppers {
    display: none;
  }
  .ui-number__input {
    padding-right: 12px;
  }
}
</style>
