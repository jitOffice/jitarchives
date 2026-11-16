<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { api, ApiError } from '../api/client';
import type { AiProviderId, PersonalAiSettingsView } from '../types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const settings = ref<PersonalAiSettingsView | null>(null);
const selectedProvider = ref<AiProviderId>('deepseek');
const apiKey = ref('');
const model = ref('deepseek-chat');
const apiBase = ref('https://api.deepseek.com/v1');
const temperature = ref(0.7);
const revealKey = ref(false);
const privacyAcknowledged = ref(false);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const providerDropdownOpen = ref(false);
const providerDropdownRef = ref<HTMLDivElement | null>(null);
const providerTriggerRef = ref<HTMLButtonElement | null>(null);
const providerMenuRef = ref<HTMLDivElement | null>(null);

const providerOptions: Array<{ value: AiProviderId; label: string; apiBase: string; models: string[] }> = [
  { value: 'deepseek', label: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { value: 'kimi', label: 'Kimi', apiBase: 'https://api.moonshot.cn/v1', models: ['kimi-k2.5', 'kimi-k2-thinking'] },
  { value: 'qwen', label: '通义千问', apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
];

const selected = computed(() =>
  settings.value?.providers.find((item) => item.provider === selectedProvider.value) ?? null,
);
const selectedProviderOption = computed(() =>
  providerOptions.find((item) => item.value === selectedProvider.value) ?? providerOptions[0],
);
const modelOptions = computed(() => selectedProviderOption.value.models);
const currentSummary = computed(() => {
  const current = settings.value;
  if (!current?.enabled) return '尚未启用个人 AI；保存配置后即可使用所选模型。';
  const active = current.providers.find((item) => item.provider === current.activeProvider);
  return '当前使用：' + (current.activeProviderLabel ?? active?.label ?? 'AI 模型') +
    ' · ' + (active?.model ?? '');
});

function messageOf(value: unknown, fallback: string): string {
  return value instanceof ApiError ? value.message : fallback;
}

function selectProvider(provider: AiProviderId) {
  providerDropdownOpen.value = false;
  selectedProvider.value = provider;
  const option = providerOptions.find((entry) => entry.value === provider) ?? providerOptions[0];
  const item = settings.value?.providers.find((entry) => entry.provider === provider);
  model.value = item?.model ?? option.models[0];
  apiBase.value = item?.apiBase ?? option.apiBase;
  temperature.value = item?.temperature ?? 0.7;
  apiKey.value = '';
  revealKey.value = false;
  privacyAcknowledged.value = false;
  error.value = '';
  notice.value = '';
}

function focusProviderOption(index: number) {
  void nextTick(() => {
    const options = providerMenuRef.value?.querySelectorAll<HTMLButtonElement>('[role="option"]');
    options?.[Math.max(0, Math.min(index, providerOptions.length - 1))]?.focus();
  });
}

function openProviderDropdown(focusIndex = providerOptions.findIndex((item) => item.value === selectedProvider.value)) {
  if (busy.value) return;
  providerDropdownOpen.value = true;
  focusProviderOption(focusIndex >= 0 ? focusIndex : 0);
}

function closeProviderDropdown(restoreFocus = false) {
  const wasOpen = providerDropdownOpen.value;
  providerDropdownOpen.value = false;
  if (restoreFocus && wasOpen) {
    void nextTick(() => providerTriggerRef.value?.focus());
  }
}

function toggleProviderDropdown() {
  if (providerDropdownOpen.value) closeProviderDropdown();
  else openProviderDropdown();
}

function chooseProvider(provider: AiProviderId) {
  selectProvider(provider);
  void nextTick(() => providerTriggerRef.value?.focus());
}

function onProviderTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (!providerDropdownOpen.value) openProviderDropdown();
    else focusProviderOption(providerOptions.findIndex((item) => item.value === selectedProvider.value));
  } else if (event.key === 'Escape' && providerDropdownOpen.value) {
    event.preventDefault();
    event.stopPropagation();
    closeProviderDropdown(true);
  }
}

function onProviderOptionKeydown(event: KeyboardEvent, index: number) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    focusProviderOption((index + direction + providerOptions.length) % providerOptions.length);
  } else if (event.key === 'Home') {
    event.preventDefault();
    focusProviderOption(0);
  } else if (event.key === 'End') {
    event.preventDefault();
    focusProviderOption(providerOptions.length - 1);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeProviderDropdown(true);
  }
}

function onDocumentPointerDown(event: PointerEvent) {
  if (!providerDropdownRef.value?.contains(event.target as Node)) {
    closeProviderDropdown();
  }
}

function onProviderFocusout(event: FocusEvent) {
  const nextTarget = event.relatedTarget as Node | null;
  if (!nextTarget || !providerDropdownRef.value?.contains(nextTarget)) {
    closeProviderDropdown();
  }
}

watch(providerDropdownOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onDocumentPointerDown);
  else document.removeEventListener('pointerdown', onDocumentPointerDown);
});

async function loadSettings() {
  loading.value = true;
  error.value = '';
  notice.value = '';
  try {
    settings.value = await api.get<PersonalAiSettingsView>('/agent/ai-settings');
    const initial =
      settings.value.activeProvider ??
      settings.value.providers.find((item) => item.configured)?.provider ??
      'deepseek';
    selectProvider(initial);
  } catch (e) {
    error.value = messageOf(e, 'AI 设置加载失败，请稍后重试');
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  if (busy.value || !privacyAcknowledged.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    settings.value = await api.put<PersonalAiSettingsView>(
      '/agent/ai-settings/' + selectedProvider.value,
      {
        apiKey: apiKey.value || undefined,
        model: model.value,
        apiBase: apiBase.value,
        temperature: temperature.value,
        enable: true,
      },
    );
    apiKey.value = '';
    privacyAcknowledged.value = false;
    notice.value = '配置已保存，当前账号已启用 ' + selectedProviderOption.value.label + '。';
    emit('saved');
  } catch (e) {
    error.value = messageOf(e, '保存配置失败，请检查 API Key 和模型名称');
  } finally {
    busy.value = false;
  }
}

async function disableAi() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    settings.value = await api.post<PersonalAiSettingsView>('/agent/ai-settings/disable');
    notice.value = '个人 AI 已停用，Agent 将使用系统默认模型或规则检索。';
    emit('saved');
  } catch (e) {
    error.value = messageOf(e, '停用 AI 失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}

async function removeConfig() {
  if (!selected.value?.configured || busy.value) return;
  if (!window.confirm('确定删除已保存的 ' + selected.value.label + ' 配置吗？此操作不会影响其他用户。')) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    settings.value = await api.del<PersonalAiSettingsView>(
      '/agent/ai-settings/' + selectedProvider.value,
    );
    apiKey.value = '';
    notice.value = '该服务商配置已删除。';
    emit('saved');
  } catch (e) {
    error.value = messageOf(e, '删除配置失败，请稍后重试');
  } finally {
    busy.value = false;
  }
}

function onWindowKeydown(event: KeyboardEvent) {
  if (!props.open || event.key !== 'Escape') return;
  if (providerDropdownOpen.value) {
    closeProviderDropdown(true);
    return;
  }
  emit('close');
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      void loadSettings();
      window.addEventListener('keydown', onWindowKeydown);
    } else {
      closeProviderDropdown();
      window.removeEventListener('keydown', onWindowKeydown);
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown);
  document.removeEventListener('pointerdown', onDocumentPointerDown);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="ai-drawer">
      <div v-if="props.open" class="ai-drawer__backdrop" @click.self="emit('close')">
        <aside class="ai-drawer" role="dialog" aria-modal="true" aria-label="AI 设置">
          <header class="ai-drawer__header">
            <strong>AI 设置</strong>
            <button class="ai-drawer__close" type="button" aria-label="关闭" @click="emit('close')">×</button>
          </header>

          <div class="ai-drawer__body" aria-live="polite">
            <p v-if="loading" class="ai-drawer__loading">正在读取个人配置…</p>
            <template v-else>
              <div class="ai-drawer__field">
                <span id="agent-ai-provider-label">服务商</span>
                <div
                  ref="providerDropdownRef"
                  class="ai-drawer__provider"
                  @focusout="onProviderFocusout"
                >
                  <button
                    ref="providerTriggerRef"
                    class="ai-drawer__provider-trigger"
                    type="button"
                    role="combobox"
                    aria-labelledby="agent-ai-provider-label"
                    aria-haspopup="listbox"
                    aria-controls="agent-ai-provider-options"
                    :aria-expanded="providerDropdownOpen"
                    :disabled="busy"
                    @click="toggleProviderDropdown"
                    @keydown="onProviderTriggerKeydown"
                  >
                    <span>{{ selectedProviderOption.label }}</span>
                    <span
                      class="ai-drawer__provider-chevron"
                      :class="{ 'is-open': providerDropdownOpen }"
                      aria-hidden="true"
                    />
                  </button>
                  <div
                    v-if="providerDropdownOpen"
                    id="agent-ai-provider-options"
                    ref="providerMenuRef"
                    class="ai-drawer__provider-menu"
                    role="listbox"
                    aria-labelledby="agent-ai-provider-label"
                  >
                    <button
                      v-for="(item, index) in providerOptions"
                      :key="item.value"
                      class="ai-drawer__provider-option"
                      type="button"
                      role="option"
                      :aria-selected="selectedProvider === item.value"
                      @click="chooseProvider(item.value)"
                      @keydown="onProviderOptionKeydown($event, index)"
                    >
                      <span>{{ item.label }}</span>
                      <span v-if="selectedProvider === item.value" class="ai-drawer__provider-check" aria-hidden="true">✓</span>
                    </button>
                  </div>
                </div>
              </div>

              <label class="ai-drawer__field">
                <span>模型</span>
                <input
                  v-model="model"
                  type="text"
                  list="agent-ai-model-options"
                  maxlength="120"
                  :disabled="busy"
                  placeholder="请输入模型名称"
                />
                <datalist id="agent-ai-model-options">
                  <option v-for="item in modelOptions" :key="item" :value="item" />
                </datalist>
              </label>

              <label class="ai-drawer__field">
                <span>API Key</span>
                <div class="ai-drawer__key">
                  <input
                    v-model="apiKey"
                    :type="revealKey ? 'text' : 'password'"
                    autocomplete="off"
                    spellcheck="false"
                    :disabled="busy"
                    :placeholder="selected?.configured ? '已保存密钥，留空则保持不变' : '在此输入密钥（仅保存在服务端）'"
                  />
                  <button type="button" aria-label="显示或隐藏 API Key" @click="revealKey = !revealKey">
                    {{ revealKey ? '隐藏' : '显示' }}
                  </button>
                </div>
                <small>密钥会加密保存在服务端，不会返回到浏览器。</small>
              </label>

              <label class="ai-drawer__field ai-drawer__temperature">
                <span>Temperature</span>
                <input
                  v-model.number="temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  :disabled="busy"
                />
                <small>取值 0–2，数值越高，回答越灵活；建议使用 0.7。</small>
              </label>

              <div class="ai-drawer__hint">
                <strong>{{ currentSummary }}</strong>
                <p>{{ selected?.configured
                  ? '该服务商已有保存配置；API Key 留空将沿用已保存的密钥。'
                  : '首次配置需要填写该服务商的 API Key。模型地址由系统按服务商自动匹配。' }}</p>
              </div>

              <label class="ai-drawer__consent">
                <input v-model="privacyAcknowledged" type="checkbox" />
                <span>我已了解：启用后，本次问答所需内容及我有权查看的档案片段会发送给所选 AI 服务商处理。</span>
              </label>

              <p v-if="error" class="ai-drawer__message error">{{ error }}</p>
              <p v-else-if="notice" class="ai-drawer__message success">{{ notice }}</p>

              <div class="ai-drawer__manage">
                <button
                  v-if="settings?.enabled"
                  type="button"
                  :disabled="busy"
                  @click="disableAi"
                >停用个人 AI</button>
                <button
                  v-if="selected?.configured"
                  type="button"
                  class="danger"
                  :disabled="busy"
                  @click="removeConfig"
                >删除当前配置</button>
              </div>
            </template>
          </div>

          <footer class="ai-drawer__footer">
            <button class="ai-drawer__save" type="button" :disabled="busy || loading || !privacyAcknowledged" @click="saveConfig">
              {{ busy ? '保存中…' : '保存' }}
            </button>
            <button class="ai-drawer__cancel" type="button" :disabled="busy" @click="emit('close')">关闭</button>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ai-drawer__backdrop {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  justify-content: flex-end;
  background: rgba(20, 27, 40, .55);
}
.ai-drawer {
  display: flex;
  flex-direction: column;
  width: min(440px, 100vw);
  height: 100%;
  max-height: 100dvh;
  background: var(--bg-card, #fff);
  color: var(--text-body, #303744);
  box-shadow: -12px 0 36px rgba(0, 0, 0, .14);
}
.ai-drawer__header {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  min-height: 54px;
  padding: 0 18px;
  border-bottom: 1px solid var(--border-light, #e5e7eb);
}
.ai-drawer__header strong { color: var(--text-title, #202633); font-size: 16px; font-weight: 650; }
.ai-drawer__close {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted, #7b8492);
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}
.ai-drawer__close:hover { background: var(--bg-page, #f3f4f6); }
.ai-drawer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}
.ai-drawer__loading { margin: 0; color: var(--text-muted, #7b8492); font-size: 13px; }
.ai-drawer__field {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 18px;
  color: var(--text-title, #303744);
  font-size: 13px;
  font-weight: 600;
}
.ai-drawer__field > span { line-height: 1.3; }
.ai-drawer__field input {
  box-sizing: border-box;
  width: 100%;
  min-height: 38px;
  padding: 8px 11px;
  border: 1px solid var(--border-light, #e1e4e9);
  border-radius: 5px;
  outline: none;
  background: var(--bg-page, #f3f4f6);
  color: var(--text-body, #303744);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
}
.ai-drawer__field input:focus { border-color: var(--color-primary, #2563eb); background: var(--bg-card, #fff); }
.ai-drawer__provider { width: 100%; }
.ai-drawer__provider-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  box-sizing: border-box;
  width: 100%;
  min-height: 38px;
  padding: 8px 11px;
  border: 1px solid var(--border-light, #e1e4e9);
  border-radius: 6px;
  background: var(--bg-page, #f3f4f6);
  color: var(--text-body, #303744);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  text-align: left;
  cursor: pointer;
  transition: border-color .16s ease, background .16s ease, box-shadow .16s ease;
}
.ai-drawer__provider-trigger:hover:not(:disabled) {
  border-color: var(--color-primary, #2563eb);
  background: var(--bg-card, #fff);
}
.ai-drawer__provider-trigger:focus-visible {
  border-color: var(--color-primary, #2563eb);
  outline: 3px solid rgba(37, 99, 235, .13);
  outline-offset: 1px;
  background: var(--bg-card, #fff);
}
.ai-drawer__provider-trigger:disabled { opacity: .6; cursor: not-allowed; }
.ai-drawer__provider-chevron {
  flex: none;
  width: 8px;
  height: 8px;
  margin: -4px 3px 0 0;
  border-right: 1.5px solid var(--text-muted, #7b8492);
  border-bottom: 1.5px solid var(--text-muted, #7b8492);
  transform: rotate(45deg);
  transition: transform .16s ease, margin .16s ease;
}
.ai-drawer__provider-chevron.is-open { margin-top: 4px; transform: rotate(225deg); }
.ai-drawer__provider-menu {
  position: static;
  display: flex;
  flex-direction: column;
  gap: 3px;
  box-sizing: border-box;
  width: 100%;
  max-height: 156px;
  margin-top: 6px;
  padding: 5px;
  overflow-y: auto;
  border: 1px solid var(--border-light, #e1e4e9);
  border-radius: 8px;
  background: var(--bg-card, #fff);
  box-shadow: 0 7px 20px rgba(28, 43, 67, .1);
  overscroll-behavior: contain;
}
.ai-drawer__provider-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  min-height: 35px;
  padding: 7px 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-body, #303744);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  text-align: left;
  cursor: pointer;
  transition: background .14s ease, color .14s ease;
}
.ai-drawer__provider-option:hover,
.ai-drawer__provider-option:focus-visible,
.ai-drawer__provider-option[aria-selected='true'] {
  outline: none;
  background: var(--color-primary-soft, #eef3ff);
  color: var(--color-primary, #2563eb);
}
.ai-drawer__provider-option[aria-selected='true'] { font-weight: 600; }
.ai-drawer__provider-check { color: var(--color-primary, #2563eb); font-weight: 700; }
.ai-drawer__key { display: flex; gap: 6px; }
.ai-drawer__key input { flex: 1; min-width: 0; }
.ai-drawer__key button {
  flex: none;
  min-width: 44px;
  border: 0;
  border-radius: 5px;
  background: var(--bg-page, #f3f4f6);
  color: var(--text-muted, #6b7280);
  font-size: 12px;
  cursor: pointer;
}
.ai-drawer__field small { color: var(--text-muted, #8a93a1); font-size: 11px; font-weight: 400; line-height: 1.45; }
.ai-drawer__temperature input { width: 126px; }
.ai-drawer__hint {
  margin: 0 0 14px;
  padding: 10px 11px;
  border-radius: 6px;
  background: var(--color-primary-soft, #f0f3ff);
  color: var(--text-muted, #7b8492);
  font-size: 12px;
  line-height: 1.55;
}
.ai-drawer__hint strong { color: var(--text-body, #303744); font-weight: 600; }
.ai-drawer__hint p { margin: 5px 0 0; }
.ai-drawer__consent {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 12px;
  color: var(--text-muted, #687386);
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
}
.ai-drawer__consent input { flex: none; margin: 2px 0 0; accent-color: var(--color-primary, #2563eb); }
.ai-drawer__message { margin: 0 0 12px; padding: 9px 10px; border-radius: 6px; font-size: 12px; line-height: 1.5; }
.ai-drawer__message.error { color: #b42318; background: rgba(220, 38, 38, .08); }
.ai-drawer__message.success { color: #16794c; background: rgba(22, 163, 106, .09); }
.ai-drawer__manage { display: flex; flex-wrap: wrap; gap: 14px; }
.ai-drawer__manage button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-primary, #2563eb);
  font-size: 12px;
  cursor: pointer;
}
.ai-drawer__manage button.danger { color: var(--color-danger, #dc2626); }
.ai-drawer__footer {
  display: flex;
  flex: none;
  gap: 10px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-light, #e5e7eb);
  background: var(--bg-card, #fff);
}
.ai-drawer__footer button {
  min-width: 66px;
  min-height: 36px;
  padding: 7px 15px;
  border: 0;
  border-radius: 7px;
  font-size: 13px;
  cursor: pointer;
}
.ai-drawer__save { background: var(--color-primary, #2563eb); color: #fff; }
.ai-drawer__cancel { background: var(--bg-page, #f3f4f6); color: var(--text-body, #303744); }
.ai-drawer__footer button:disabled { opacity: .55; cursor: not-allowed; }
.ai-drawer-enter-active, .ai-drawer-leave-active { transition: opacity .2s ease; }
.ai-drawer-enter-active .ai-drawer, .ai-drawer-leave-active .ai-drawer { transition: transform .24s ease; }
.ai-drawer-enter-from, .ai-drawer-leave-to { opacity: 0; }
.ai-drawer-enter-from .ai-drawer, .ai-drawer-leave-to .ai-drawer { transform: translateX(100%); }
@media (max-width: 520px) {
  .ai-drawer { width: 100vw; }
}
</style>
