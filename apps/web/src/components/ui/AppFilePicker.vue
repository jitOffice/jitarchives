<script setup lang="ts">
/**
 * 统一文件选择入口：按钮 + 隐藏 input。
 * 原生 file 控件外观不可控，统一收到按钮后面；选中后立即清空 input.value，
 * 保证连续选择同一个文件仍会触发 change。
 */
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    accept?: string;
    disabled?: boolean;
    busy?: boolean;
    label?: string;
    busyLabel?: string;
    /** primary：主按钮；default：次级按钮 */
    variant?: 'primary' | 'default';
    size?: 'sm' | 'md';
    ariaLabel?: string;
  }>(),
  {
    accept: undefined,
    disabled: false,
    busy: false,
    label: '选择文件',
    busyLabel: '处理中…',
    variant: 'default',
    size: 'sm',
    ariaLabel: undefined,
  },
);

const emit = defineEmits<{
  (event: 'picked', file: File): void;
}>();

const inputEl = ref<HTMLInputElement | null>(null);

function open(): void {
  if (props.disabled || props.busy) return;
  inputEl.value?.click();
}

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) emit('picked', file);
}
</script>

<template>
  <button
    class="btn"
    :class="[
      props.variant === 'primary' ? 'btn-primary' : '',
      props.size === 'sm' ? 'btn-sm' : '',
    ]"
    type="button"
    :disabled="props.disabled || props.busy"
    :aria-label="props.ariaLabel"
    @click="open"
  >
    <span v-if="props.busy" class="ui-spinner ui-spinner--sm" aria-hidden="true"></span>
    {{ props.busy ? props.busyLabel : props.label }}
    <input ref="inputEl" class="ui-file__input" type="file" :accept="props.accept" @change="onChange" />
  </button>
</template>

<style scoped>
.ui-file__input {
  display: none;
}
</style>
