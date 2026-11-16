<script setup lang="ts">
/**
 * 统一风格下拉选择框（替代浏览器原生 select）。
 *
 * 设计要点：
 * - 触发器仍是一个真实 `<input readonly role="combobox">`，因此页面原有的
 *   `<label for="...">` 关联、Tab 顺序与表单禁用语义保持不变；
 * - 选项面板 Teleport 到 body 并 fixed 定位，不会被表格滚动容器或弹窗裁切；
 * - 键盘完整可用：Enter/Space 打开，↑↓/Home/End 移动，Enter 选中，Esc 关闭并回焦；
 * - 移动端（≤767px）自动改为底部抽屉，触控目标与字号符合移动端规范；
 * - 选中后先 emit update:modelValue 再 emit change，兼容 `v-model` + `@change` 同时使用；
 * - 触发器自带完整控件皮肤，不依赖 `.field` 容器，任何场景都不会回落成浏览器默认输入框；
 * - variant="inline" 为表格单元格等轻量场景：默认无边框无底色，悬停浮出浅底、聚焦才显示控件形态。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { lockBodyScroll, onOutsidePointerDown, placePanel } from './overlay';
import type { SelectOption } from './types';

const props = withDefaults(
  defineProps<{
    modelValue: string | null;
    options: SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    size?: 'md' | 'sm';
    variant?: 'field' | 'inline';
    id?: string;
    invalid?: boolean;
    ariaLabel?: string;
  }>(),
  {
    placeholder: '请选择',
    disabled: false,
    size: 'md',
    variant: 'field',
    invalid: false,
    ariaLabel: undefined,
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'change', value: string): void;
}>();

const uid = useId();
const listId = `ui-select-list-${uid}`;
const triggerEl = ref<HTMLInputElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const open = ref(false);
const activeIndex = ref(-1);
const isMobile = ref(false);
const panelStyle = ref<Record<string, string>>({});

const selectedIndex = computed(() =>
  props.options.findIndex((option) => option.value === (props.modelValue ?? '')),
);
const selectedLabel = computed(() =>
  selectedIndex.value >= 0 ? props.options[selectedIndex.value].label : '',
);

function firstEnabled(from = 0, step = 1): number {
  const total = props.options.length;
  for (let offset = 0; offset < total; offset += 1) {
    const index = (from + offset * step + total * total) % total;
    if (!props.options[index].disabled) return index;
  }
  return -1;
}

function lastEnabled(): number {
  for (let index = props.options.length - 1; index >= 0; index -= 1) {
    if (!props.options[index].disabled) return index;
  }
  return -1;
}

function moveActive(step: 1 | -1): void {
  const total = props.options.length;
  if (!total) return;
  let index = activeIndex.value;
  for (let tries = 0; tries < total; tries += 1) {
    index = (index + step + total) % total;
    if (!props.options[index].disabled) {
      activeIndex.value = index;
      return;
    }
  }
}

function scrollActiveIntoView(): void {
  const el = document.getElementById(`${listId}-option-${activeIndex.value}`);
  el?.scrollIntoView({ block: 'nearest' });
}

function updatePlacement(): void {
  const trigger = triggerEl.value;
  const panel = panelEl.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const placement = placePanel(rect, panel?.offsetHeight ?? 240, {
    // 行内变体的触发器本身很窄，面板需单独给足最小宽度，避免选项文字被挤压
    minWidth: props.variant === 'inline' ? 148 : rect.width,
    maxHeight: 320,
  });
  panelStyle.value = {
    top: `${placement.top}px`,
    left: `${placement.left}px`,
    width: `${placement.width}px`,
    maxHeight: `${placement.maxHeight}px`,
  };
}

let unlockScroll: (() => void) | null = null;
let disposeOutside: (() => void) | null = null;
const onViewportResize = () => closePanel(false);

/**
 * 全局 scroll 监听用捕获阶段，页面/外部滚动容器滚动时关闭面板；
 * 但滚轮落在选项列表内部（含列表自身滚动条）时属于「面板内部滚动」，
 * 必须保持打开，否则滚动时下拉框会被误关闭。
 */
function onWindowScroll(event: Event): void {
  const panel = panelEl.value;
  const target = event.target as Node | null;
  if (panel && target instanceof Node && panel.contains(target)) {
    // 移动端抽屉：列表滚到边界后继续滚动会带动 body，需拦截冒泡保住抽屉打开态
    event.stopPropagation();
    return;
  }
  closePanel(false);
}

function bindGlobalListeners(): void {
  disposeOutside = onOutsidePointerDown(
    () => [triggerEl.value, panelEl.value],
    () => closePanel(false),
  );
  window.addEventListener('resize', onViewportResize);
  window.addEventListener('scroll', onWindowScroll, true);
  if (isMobile.value) unlockScroll = lockBodyScroll();
}

function unbindGlobalListeners(): void {
  disposeOutside?.();
  disposeOutside = null;
  window.removeEventListener('resize', onViewportResize);
  window.removeEventListener('scroll', onWindowScroll, true);
  unlockScroll?.();
  unlockScroll = null;
}

async function openPanel(mode: 'selected' | 'first' | 'last' = 'selected'): Promise<void> {
  if (props.disabled || open.value || props.options.length === 0) return;
  open.value = true;
  const initial =
    mode === 'last' ? lastEnabled() : mode === 'first' ? firstEnabled() : selectedIndex.value;
  activeIndex.value = initial >= 0 && !props.options[initial]?.disabled ? initial : firstEnabled();
  await nextTick();
  updatePlacement();
  scrollActiveIntoView();
  bindGlobalListeners();
}

function closePanel(refocus = true): void {
  if (!open.value) return;
  open.value = false;
  unbindGlobalListeners();
  if (refocus) triggerEl.value?.focus();
}

function togglePanel(): void {
  if (open.value) closePanel();
  else void openPanel();
}

function choose(option: SelectOption): void {
  if (option.disabled) return;
  const changed = option.value !== (props.modelValue ?? '');
  closePanel();
  if (!changed) return;
  emit('update:modelValue', option.value);
  emit('change', option.value);
}

let typeBuffer = '';
let typeTimer: ReturnType<typeof setTimeout> | null = null;

function typeahead(char: string): void {
  if (typeTimer) clearTimeout(typeTimer);
  typeBuffer += char.toLowerCase();
  typeTimer = setTimeout(() => {
    typeBuffer = '';
  }, 600);
  const start = activeIndex.value < 0 ? 0 : activeIndex.value;
  const total = props.options.length;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (start + offset) % total;
    const option = props.options[index];
    if (!option.disabled && option.label.toLowerCase().startsWith(typeBuffer)) {
      activeIndex.value = index;
      scrollActiveIntoView();
      return;
    }
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;
  if (!open.value) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      void openPanel(event.key === 'ArrowUp' ? 'last' : 'first');
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      void openPanel();
    }
    return;
  }

  switch (event.key) {
    case 'Escape':
      event.preventDefault();
      closePanel();
      break;
    case 'Tab':
      closePanel(false);
      break;
    case 'ArrowDown':
      event.preventDefault();
      moveActive(1);
      scrollActiveIntoView();
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveActive(-1);
      scrollActiveIntoView();
      break;
    case 'Home':
      event.preventDefault();
      activeIndex.value = firstEnabled();
      scrollActiveIntoView();
      break;
    case 'End':
      event.preventDefault();
      activeIndex.value = lastEnabled();
      scrollActiveIntoView();
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (activeIndex.value >= 0) choose(props.options[activeIndex.value]);
      break;
    default:
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        typeahead(event.key);
      }
  }
}

watch(
  () => props.options,
  () => {
    if (open.value && props.options.length === 0) closePanel(false);
  },
);

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) closePanel(false);
  },
);

const mobileQuery = '(max-width: 767px)';
let mediaQuery: MediaQueryList | null = null;
const onMediaChange = (event: MediaQueryListEvent) => {
  isMobile.value = event.matches;
  if (open.value) closePanel(false);
};

onMounted(() => {
  mediaQuery = window.matchMedia(mobileQuery);
  isMobile.value = mediaQuery.matches;
  mediaQuery.addEventListener('change', onMediaChange);
});

onBeforeUnmount(() => {
  mediaQuery?.removeEventListener('change', onMediaChange);
  unbindGlobalListeners();
});
</script>

<template>
  <div
    class="ui-select"
    :class="[
      `ui-select--${props.size}`,
      `ui-select--${props.variant}`,
      { 'is-open': open, 'is-disabled': props.disabled },
    ]"
  >
    <input
      :id="props.id"
      ref="triggerEl"
      class="ui-select__input"
      type="text"
      readonly
      autocomplete="off"
      :value="selectedLabel || props.placeholder"
      :class="{ 'is-placeholder': !selectedLabel }"
      :disabled="props.disabled"
      :aria-label="props.ariaLabel"
      :aria-invalid="props.invalid || undefined"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined"
      :data-value="props.modelValue ?? ''"
      @click="togglePanel"
      @keydown="onKeydown"
    />
    <span class="ui-select__caret" aria-hidden="true">
      <svg viewBox="0 0 12 7" width="12" height="7">
        <path
          d="M1 1l5 5 5-5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </span>

    <Teleport to="body">
      <div v-if="open" class="ui-select__layer" :class="{ 'is-sheet': isMobile }">
        <div v-if="isMobile" class="ui-select__mask" @click="closePanel(false)"></div>
        <div
          ref="panelEl"
          class="ui-select__panel"
          :style="isMobile ? undefined : panelStyle"
        >
          <ul :id="listId" class="ui-select__list" role="listbox" :aria-labelledby="props.id">
            <li
              v-for="(option, index) in props.options"
              :id="`${listId}-option-${index}`"
              :key="option.value"
              class="ui-select__option"
              :class="{
                'is-active': index === activeIndex,
                'is-selected': option.value === (props.modelValue ?? ''),
                'is-disabled': option.disabled,
              }"
              role="option"
              :aria-selected="option.value === (props.modelValue ?? '')"
              :aria-disabled="option.disabled || undefined"
              @click="choose(option)"
              @pointermove="activeIndex = option.disabled ? activeIndex : index"
            >
              <span class="ui-select__label">{{ option.label }}</span>
              <span v-if="option.value === (props.modelValue ?? '')" class="ui-select__check" aria-hidden="true">
                <svg viewBox="0 0 12 10" width="12" height="10">
                  <path
                    d="M1 5l3.2 3.2L11 1.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ui-select {
  position: relative;
  width: 100%;
}

/* 触发器：自带完整控件皮肤（尺寸、边框、圆角、底色、字号），
   不依赖页面是否把它包在 .field 里——否则表格等场景会回落成浏览器默认输入框，
   出现比周围文本重得多的深色内嵌边框 */
.ui-select__input {
  width: 100%;
  min-height: var(--control-h);
  padding: 7px 32px 7px 12px;
  border: 1px solid var(--border-control);
  border-radius: var(--radius-control);
  background: #fff;
  color: var(--text-title);
  font-family: inherit;
  font-size: 14px;
  /* 不设 line-height：.field 内的文本输入框用浏览器默认行高，
     保持一致才能让下拉框与左右输入框同高 */
  cursor: pointer;
  caret-color: transparent;
  text-overflow: ellipsis;
  transition: border-color var(--dur) ease, box-shadow var(--dur) ease, background var(--dur) ease;
}
.ui-select__input.is-placeholder {
  color: var(--text-placeholder);
}
.ui-select__input:hover:not(:disabled):not(:focus) {
  border-color: var(--border-control-hover);
}
.ui-select__input:focus,
.ui-select.is-open .ui-select__input {
  border-color: var(--color-primary);
  box-shadow: var(--ring);
}
.ui-select__input:disabled {
  cursor: not-allowed;
}
.ui-select--sm .ui-select__input {
  min-height: var(--control-h-sm);
  padding: 3px 28px 3px 8px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.ui-select__caret {
  position: absolute;
  right: 12px;
  top: 50%;
  display: inline-flex;
  color: var(--text-muted);
  transform: translateY(-50%);
  transition: transform var(--dur) ease;
  pointer-events: none;
}
.ui-select.is-open .ui-select__caret {
  transform: translateY(-50%) rotate(180deg);
}
.ui-select__input:disabled + .ui-select__caret {
  color: var(--text-placeholder);
}

/* 行内变体：表格单元格等「轻量可编辑」场景——
   常态无边框、无底色，与相邻单元格文本保持同一视觉层级；
   悬停时浮出浅底提示可点，展开/聚焦时才呈现完整控件形态 */
.ui-select--inline {
  display: inline-block;
  width: 96px;
  max-width: 100%;
  vertical-align: middle;
}
.ui-select--inline .ui-select__input {
  min-height: 26px;
  padding: 1px 22px 1px 6px;
  border-color: transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-body);
  /* 与所在表格单元格字号一致，角色读起来是「可点的文字」而不是嵌入的输入控件 */
  font-size: 14px;
}
.ui-select--inline .ui-select__input:hover:not(:disabled) {
  border-color: transparent;
  background: #f2f3f5;
  color: var(--text-title);
}
.ui-select--inline .ui-select__input:focus,
.ui-select--inline.is-open .ui-select__input {
  border-color: var(--color-primary);
  background: #fff;
  color: var(--text-title);
  box-shadow: var(--ring);
}
/* 禁用态（如当前登录账号）：只保留灰色文字，不再出现灰底块；
   重复叠加 `.ui-select.is-disabled` 是为了盖过 controls.css 中全局 `input:disabled` 的灰底规则 */
.ui-select--inline .ui-select__input:disabled,
.ui-select.ui-select--inline.is-disabled .ui-select__input {
  border-color: transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: not-allowed;
}
.ui-select--inline .ui-select__caret {
  right: 6px;
  color: var(--border-control-hover);
}
.ui-select--inline .ui-select__input:hover:not(:disabled) + .ui-select__caret,
.ui-select--inline.is-open .ui-select__caret {
  color: var(--color-primary);
}
.ui-select--inline .ui-select__input:disabled + .ui-select__caret {
  visibility: hidden;
}

/* 桌面端面板：fixed 定位，避免被表格滚动容器裁切 */
.ui-select__panel {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  padding: 6px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-control);
  background: #fff;
  box-shadow: var(--shadow-pop);
  overflow: hidden;
  animation: ui-select-in 0.14s ease;
}
@keyframes ui-select-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.ui-select__list {
  margin: 0;
  padding: 0;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior: contain;
}

.ui-select__option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 14px;
  color: var(--text-title);
  cursor: pointer;
  transition: background var(--dur) ease, color var(--dur) ease;
}
.ui-select__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ui-select__check {
  flex: 0 0 auto;
  color: var(--color-primary);
}
.ui-select__option.is-active {
  background: var(--color-primary-soft);
}
.ui-select__option.is-selected {
  color: var(--color-primary);
  font-weight: 600;
}
.ui-select__option.is-disabled {
  color: var(--text-placeholder);
  cursor: not-allowed;
  background: transparent;
}

/* 移动端：底部抽屉，选项行高按触控目标放大 */
.ui-select__layer.is-sheet {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.ui-select__mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  animation: ui-fade-in 0.18s ease;
}
.ui-select__layer.is-sheet .ui-select__panel {
  position: relative;
  width: 100%;
  max-height: 60vh;
  border-radius: 12px 12px 0 0;
  border-bottom: none;
  padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
  animation: ui-sheet-in 0.2s ease;
}
.ui-select__layer.is-sheet .ui-select__option {
  padding: 12px 14px;
  font-size: 16px;
}

@keyframes ui-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes ui-sheet-in {
  from { transform: translateY(16px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}
</style>
