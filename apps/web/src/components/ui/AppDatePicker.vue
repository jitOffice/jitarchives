<script setup lang="ts">
/**
 * 统一风格日期选择器（替代浏览器原生 input[type=date]）。
 *
 * 设计要点：
 * - 输入框仍可手工键入 `YYYY-MM-DD`（也接受 `YYYY/MM/DD`、`YYYY.MM.DD`），
 *   保留原生日期框「可直接打字」的能力；非法输入失焦后回填原值，不产生脏数据；
 * - 日历面板自研（周一起始、6×7 网格、今日/选中/非本月区分、可选清空与回今天），
 *   Teleport 到 body + fixed 定位，移动端改为底部抽屉；
 * - 键盘：↓ 打开，方向键移动、PageUp/PageDown 切月、Home/End 到本周首尾，
 *   Enter 选中、Esc 关闭并回焦；
 * - 取值始终是 `YYYY-MM-DD` 字符串，与后端字段格式保持一致，接口零改动。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { lockBodyScroll, onOutsidePointerDown, placePanel } from './overlay';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    disabled?: boolean;
    size?: 'md' | 'sm';
    id?: string;
    min?: string;
    max?: string;
    clearable?: boolean;
    invalid?: boolean;
    ariaLabel?: string;
  }>(),
  {
    placeholder: 'YYYY-MM-DD',
    disabled: false,
    size: 'md',
    clearable: true,
    invalid: false,
    ariaLabel: undefined,
    min: undefined,
    max: undefined,
  },
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'change', value: string): void;
}>();

interface DayCell {
  iso: string;
  day: number;
  inMonth: boolean;
  disabled: boolean;
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const uid = useId();

const inputEl = ref<HTMLInputElement | null>(null);
const panelEl = ref<HTMLElement | null>(null);
const text = ref('');
const open = ref(false);
const cursor = ref('');
const viewYear = ref(new Date().getFullYear());
const viewMonth = ref(new Date().getMonth());
const isMobile = ref(false);
const panelStyle = ref<Record<string, string>>({});

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function toIso(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 严格解析：必须是真实存在的日期（拒绝 2026-02-30）。 */
function parseIso(value: string): Date | null {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

/** 宽松解析：允许用 / 或 . 分隔，便于手输。 */
function parseLoose(value: string): string | null {
  const normalized = value.trim().replace(/[/.]/g, '-');
  const date = parseIso(normalized);
  return date ? toIso(date) : null;
}

function outOfRange(iso: string): boolean {
  if (props.min && iso < props.min) return true;
  if (props.max && iso > props.max) return true;
  return false;
}

function syncFromModel(): void {
  text.value = props.modelValue || '';
  const date = props.modelValue ? parseIso(props.modelValue) : null;
  const base = date ?? new Date();
  viewYear.value = base.getFullYear();
  viewMonth.value = base.getMonth();
  cursor.value = date ? toIso(date) : '';
}

const todayIso = toIso(new Date());

const cells = computed<DayCell[]>(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1);
  // 周一为一周起点：getDay() 中周日为 0，需要转换偏移
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(viewYear.value, viewMonth.value, 1 - offset);
  const list: DayCell[] = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    const iso = toIso(date);
    list.push({
      iso,
      day: date.getDate(),
      inMonth: date.getMonth() === viewMonth.value,
      disabled: outOfRange(iso),
    });
  }
  return list;
});

const weeks = computed(() => {
  const rows: DayCell[][] = [];
  for (let index = 0; index < cells.value.length; index += 7) {
    rows.push(cells.value.slice(index, index + 7));
  }
  return rows;
});

const monthLabel = computed(() => `${viewYear.value} 年 ${viewMonth.value + 1} 月`);

function emitValue(iso: string): void {
  if (iso === props.modelValue) return;
  emit('update:modelValue', iso);
  emit('change', iso);
}

function selectDate(iso: string): void {
  if (iso && outOfRange(iso)) return;
  closePanel();
  text.value = iso;
  emitValue(iso);
}

function commitText(): void {
  if (!text.value.trim()) {
    if (props.modelValue) {
      emitValue('');
    }
    return;
  }
  const iso = parseLoose(text.value);
  if (!iso || outOfRange(iso)) {
    // 非法或越界：回填原值，避免把脏数据写进表单
    text.value = props.modelValue || '';
    return;
  }
  text.value = iso;
  emitValue(iso);
}

function updatePlacement(): void {
  const trigger = inputEl.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const placement = placePanel(rect, panelEl.value?.offsetHeight ?? 336, {
    minWidth: Math.max(rect.width, 268),
    maxHeight: 380,
  });
  panelStyle.value = {
    top: `${placement.top}px`,
    left: `${placement.left}px`,
    width: `${placement.width}px`,
  };
}

let unlockScroll: (() => void) | null = null;
let disposeOutside: (() => void) | null = null;
const onViewportChange = () => closePanel(false);

function bindGlobalListeners(): void {
  disposeOutside = onOutsidePointerDown(
    () => [inputEl.value, panelEl.value],
    () => closePanel(false),
  );
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
  if (isMobile.value) unlockScroll = lockBodyScroll();
}

function unbindGlobalListeners(): void {
  disposeOutside?.();
  disposeOutside = null;
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
  unlockScroll?.();
  unlockScroll = null;
}

async function openPanel(): Promise<void> {
  if (props.disabled || open.value) return;
  const date = props.modelValue ? parseIso(props.modelValue) : null;
  const base = date ?? new Date();
  viewYear.value = base.getFullYear();
  viewMonth.value = base.getMonth();
  cursor.value = toIso(base);
  open.value = true;
  await nextTick();
  updatePlacement();
  bindGlobalListeners();
}

function closePanel(refocus = true): void {
  if (!open.value) return;
  open.value = false;
  unbindGlobalListeners();
  if (refocus) inputEl.value?.focus();
}

function togglePanel(): void {
  if (open.value) closePanel();
  else void openPanel();
}

function shiftMonth(delta: number): void {
  const date = new Date(viewYear.value, viewMonth.value + delta, 1);
  viewYear.value = date.getFullYear();
  viewMonth.value = date.getMonth();
}

function shiftYear(delta: number): void {
  viewYear.value += delta;
}

function moveCursor(days: number): void {
  const base = cursor.value ? parseIso(cursor.value) : new Date(viewYear.value, viewMonth.value, 1);
  const date = base ?? new Date();
  date.setDate(date.getDate() + days);
  cursor.value = toIso(date);
  if (date.getMonth() !== viewMonth.value || date.getFullYear() !== viewYear.value) {
    viewYear.value = date.getFullYear();
    viewMonth.value = date.getMonth();
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return;

  if (!open.value) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      void openPanel();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitText();
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
    case 'ArrowLeft':
      event.preventDefault();
      moveCursor(-1);
      break;
    case 'ArrowRight':
      event.preventDefault();
      moveCursor(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveCursor(-7);
      break;
    case 'ArrowDown':
      event.preventDefault();
      moveCursor(7);
      break;
    case 'PageUp':
      event.preventDefault();
      shiftMonth(-1);
      break;
    case 'PageDown':
      event.preventDefault();
      shiftMonth(1);
      break;
    case 'Home': {
      event.preventDefault();
      const base = cursor.value ? parseIso(cursor.value) : null;
      if (base) moveCursor(-((base.getDay() + 6) % 7));
      break;
    }
    case 'End': {
      event.preventDefault();
      const base = cursor.value ? parseIso(cursor.value) : null;
      if (base) moveCursor(6 - ((base.getDay() + 6) % 7));
      break;
    }
    case 'Enter':
      event.preventDefault();
      if (cursor.value) selectDate(cursor.value);
      break;
    default:
      // 面板打开时方向键/回车已接管，其余可打印字符不写入输入框
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
        event.preventDefault();
      }
  }
}

function onInput(event: Event): void {
  text.value = (event.target as HTMLInputElement).value;
}

function onBlur(): void {
  if (open.value) return;
  commitText();
}

watch(() => props.modelValue, syncFromModel, { immediate: true });

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
  <div class="ui-date" :class="[`ui-date--${props.size}`, { 'is-open': open, 'is-disabled': props.disabled }]">
    <input
      :id="props.id"
      ref="inputEl"
      class="ui-date__input"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      :value="text"
      :placeholder="props.placeholder"
      :disabled="props.disabled"
      :aria-label="props.ariaLabel"
      :aria-invalid="props.invalid || undefined"
      role="combobox"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="`${uid}-panel`"
      @input="onInput"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <button
      class="ui-date__trigger"
      type="button"
      tabindex="-1"
      aria-label="打开日历选择日期"
      :disabled="props.disabled"
      @click="togglePanel"
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="1.8" y="3" width="12.4" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4" />
        <path d="M1.8 6.4h12.4M5.2 1.6v2.6M10.8 1.6v2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>

    <Teleport to="body">
      <div v-if="open" class="ui-date__layer" :class="{ 'is-sheet': isMobile }">
        <div v-if="isMobile" class="ui-date__mask" @click="closePanel(false)"></div>
        <div
          :id="`${uid}-panel`"
          ref="panelEl"
          class="ui-date__panel"
          :style="isMobile ? undefined : panelStyle"
          role="dialog"
          :aria-label="'选择日期，当前显示 ' + monthLabel"
        >
          <div class="ui-date__head">
            <button class="ui-date__nav" type="button" aria-label="上一年" @click="shiftYear(-1)">«</button>
            <button class="ui-date__nav" type="button" aria-label="上个月" @click="shiftMonth(-1)">‹</button>
            <span class="ui-date__title" aria-live="polite">{{ monthLabel }}</span>
            <button class="ui-date__nav" type="button" aria-label="下个月" @click="shiftMonth(1)">›</button>
            <button class="ui-date__nav" type="button" aria-label="下一年" @click="shiftYear(1)">»</button>
          </div>

          <div class="ui-date__week" aria-hidden="true">
            <span v-for="label in WEEK_LABELS" :key="label">{{ label }}</span>
          </div>

          <div class="ui-date__grid" role="grid" :aria-label="monthLabel">
            <div v-for="(week, weekIndex) in weeks" :key="weekIndex" class="ui-date__row" role="row">
              <button
                v-for="(cell, dayIndex) in week"
                :id="`${uid}-cell-${weekIndex * 7 + dayIndex}`"
                :key="cell.iso"
                type="button"
                role="gridcell"
                class="ui-date__day"
                :class="{
                  'is-out': !cell.inMonth,
                  'is-today': cell.iso === todayIso,
                  'is-selected': cell.iso === props.modelValue,
                  'is-cursor': cell.iso === cursor,
                }"
                :aria-selected="cell.iso === props.modelValue"
                :aria-disabled="cell.disabled || undefined"
                :aria-label="cell.iso"
                :disabled="cell.disabled"
                @click="selectDate(cell.iso)"
              >
                {{ cell.day }}
              </button>
            </div>
          </div>

          <div class="ui-date__foot">
            <button class="ui-date__link" type="button" @click="selectDate(todayIso)">今天</button>
            <button v-if="props.clearable" class="ui-date__link" type="button" @click="selectDate('')">清空</button>
            <button class="ui-date__link is-primary" type="button" @click="closePanel()">完成</button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.ui-date {
  position: relative;
  width: 100%;
}

.ui-date__input {
  width: 100%;
  padding-right: 38px;
  transition: border-color var(--dur) ease, box-shadow var(--dur) ease;
}
.ui-date__input:focus,
.ui-date.is-open .ui-date__input {
  border-color: var(--color-primary);
  box-shadow: var(--ring);
}
.ui-date--sm .ui-date__input {
  padding: 3px 34px 3px 8px;
  border-radius: var(--radius-sm);
  font-size: 13px;
}

.ui-date__trigger {
  position: absolute;
  right: 6px;
  top: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transform: translateY(-50%);
  transition: background var(--dur) ease, color var(--dur) ease;
}
.ui-date__trigger:hover:not(:disabled) {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.ui-date__trigger:disabled {
  cursor: not-allowed;
  color: var(--text-placeholder);
}

.ui-date__panel {
  position: fixed;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  background: #fff;
  box-shadow: var(--shadow-pop);
  animation: ui-date-in 0.14s ease;
}
@keyframes ui-date-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

.ui-date__head {
  display: flex;
  align-items: center;
  gap: 2px;
}
.ui-date__nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-body);
  font-size: 15px;
  cursor: pointer;
}
.ui-date__nav:hover {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.ui-date__title {
  flex: 1 1 auto;
  text-align: center;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-title);
}

.ui-date__week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.ui-date__grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ui-date__row {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.ui-date__day {
  height: 32px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-title);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background var(--dur) ease, color var(--dur) ease, border-color var(--dur) ease;
}
.ui-date__day:hover:not(:disabled) {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.ui-date__day.is-out {
  color: var(--text-placeholder);
}
.ui-date__day.is-today {
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}
.ui-date__day.is-cursor {
  background: var(--color-primary-soft);
}
.ui-date__day.is-selected {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
  font-weight: 600;
}
.ui-date__day:disabled {
  color: var(--text-placeholder);
  background: transparent;
  cursor: not-allowed;
  text-decoration: line-through;
}

.ui-date__foot {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 6px;
  border-top: 1px solid var(--border-light);
}
.ui-date__link {
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: var(--text-body);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.ui-date__link:hover {
  color: var(--color-primary);
}
.ui-date__link.is-primary {
  color: var(--color-primary);
  font-weight: 600;
}

/* 移动端：底部抽屉 */
.ui-date__layer.is-sheet {
  position: fixed;
  inset: 0;
  z-index: var(--z-popover);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.ui-date__mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
}
.ui-date__layer.is-sheet .ui-date__panel {
  position: relative;
  width: 100%;
  border-radius: 12px 12px 0 0;
  padding: 14px 12px calc(14px + env(safe-area-inset-bottom));
  animation: ui-date-sheet-in 0.2s ease;
}
.ui-date__layer.is-sheet .ui-date__day {
  height: 40px;
  font-size: 15px;
}
.ui-date__layer.is-sheet .ui-date__nav {
  width: 34px;
  height: 34px;
}
@keyframes ui-date-sheet-in {
  from { transform: translateY(16px); opacity: 0.6; }
  to { transform: translateY(0); opacity: 1; }
}
</style>
