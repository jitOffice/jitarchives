<script setup lang="ts">
/**
 * 命令式对话框渲染宿主（挂在 App.vue，与 ToastHost 同级）。
 * 业务侧只调用 `confirmDialog()` / `promptDialog()`，不直接使用本组件。
 */
import { computed, nextTick, ref, watch } from 'vue';
import AppModal from './AppModal.vue';
import { currentDialog, settleDialog } from './dialog';

const promptInput = ref<HTMLInputElement | null>(null);
const cancelBtn = ref<HTMLButtonElement | null>(null);
const confirmBtn = ref<HTMLButtonElement | null>(null);
const promptValue = ref('');

const open = computed(() => currentDialog.value !== null);
const isPrompt = computed(() => currentDialog.value?.kind === 'prompt');
const options = computed(() => currentDialog.value?.confirm ?? null);
const promptOptions = computed(() => currentDialog.value?.prompt ?? null);
const message = computed(() => {
  const opts = options.value;
  return opts && 'message' in opts ? opts.message ?? '' : '';
});
const danger = computed(() => options.value?.danger === true);
const confirmText = computed(() => options.value?.confirmText ?? '确认');
const cancelText = computed(() => options.value?.cancelText ?? '取消');
const title = computed(() => options.value?.title ?? (isPrompt.value ? '填写内容' : '操作确认'));

function cancel(): void {
  settleDialog(isPrompt.value ? null : false);
}

function accept(): void {
  if (isPrompt.value) {
    const opts = promptOptions.value;
    const value = promptValue.value.trim();
    if (opts?.required && !value) {
      promptInput.value?.focus();
      return;
    }
    settleDialog(value);
    return;
  }
  settleDialog(true);
}

function onOpenChange(value: boolean): void {
  if (!value) cancel();
}

watch(currentDialog, async (dialog) => {
  if (!dialog) return;
  promptValue.value = dialog.prompt?.initialValue ?? '';
  await nextTick();
  if (dialog.kind === 'prompt') {
    promptInput.value?.focus();
    promptInput.value?.select();
  } else if (dialog.confirm.danger) {
    cancelBtn.value?.focus();
  } else {
    confirmBtn.value?.focus();
  }
});
</script>

<template>
  <AppModal
    :open="open"
    :title="title"
    :width="440"
    initial-focus="none"
    @update:open="onOpenChange"
  >
    <p v-if="message" class="dialog-message">{{ message }}</p>

    <div v-if="isPrompt && promptOptions" class="field dialog-field">
      <label v-if="promptOptions.label" for="ui-dialog-input">{{ promptOptions.label }}</label>
      <input
        id="ui-dialog-input"
        ref="promptInput"
        v-model="promptValue"
        type="text"
        class="ui-textarea"
        :placeholder="promptOptions.placeholder"
        :maxlength="promptOptions.maxlength"
        @keydown.enter.prevent="accept"
      />
    </div>

    <template #footer>
      <div class="dialog-btns">
        <button ref="cancelBtn" class="btn" type="button" @click="cancel">{{ cancelText }}</button>
        <button
          ref="confirmBtn"
          class="btn"
          :class="danger ? 'btn-danger-solid' : 'btn-primary'"
          type="button"
          @click="accept"
        >
          {{ confirmText }}
        </button>
      </div>
    </template>
  </AppModal>
</template>

<style scoped>
.dialog-message {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-body);
  word-break: break-word;
}
.dialog-field {
  margin: 14px 0 0;
}
.dialog-field label {
  margin-bottom: 6px;
}
.dialog-btns {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-left: auto;
}
.dialog-btns .btn {
  min-width: 88px;
}
@media (max-width: 767px) {
  .dialog-btns {
    width: 100%;
    margin-left: 0;
  }
  .dialog-btns .btn {
    flex: 1;
    min-width: 0;
  }
}
</style>
