<script setup lang="ts">
/**
 * 档案在线编辑页（阶段二第三批）：用官方 iframe SDK v1 嵌入 JitWord 编辑器。
 * - 票据一律由后端按当前登录用户现签（getEmbedTicket 每次现取，绝不缓存、绝不含密钥）；
 * - docId 由后端从档案关联记录取得，前端不接受任意文档 ID；
 * - 源附件支持 .doc/.docx：.doc 由后端转换为 .docx 后导入；fileId 由详情页选择后带入；
 * - 编辑不可用时（非建档者 / 已归档 / 未接入）自动降级为只读，展示真实原因；
 * - 「保存」= 写入在线文档服务；厂商开放导出字节回传时随后自动入库形成文件版本，
 *   未开放时如实提示并保留「导出 DOCX」+「上传导出件入库」通道（三段严格区分）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { onBeforeRouteLeave, useRoute } from 'vue-router';
import { api, ApiError, versionPreviewUrl } from '../api/client';
import type { ArchiveDocumentView, ArchiveFileVersionView, JitWordStatus } from '../types';
import { useFlash } from '../toast';
import AppLoading from '../components/ui/AppLoading.vue';
import ArchivePreviewDialog from '../components/ArchivePreviewDialog.vue';
import { confirmDialog } from '../components/ui/dialog';

const props = defineProps<{ id: string }>();
const route = useRoute();

/** 本次要编辑的源附件 id（由详情页选择后带入）；缺省时后端沿用首条关联。 */
const sourceFileId = computed<number | undefined>(() => {
  const value = Number(route.query.fileId);
  return Number.isInteger(value) && value > 0 ? value : undefined;
});
function withFileId(path: string): string {
  if (!sourceFileId.value) return path;
  return `${path}${path.includes('?') ? '&' : '?'}fileId=${sourceFileId.value}`;
}

const status = ref<JitWordStatus | null>(null);
const doc = ref<ArchiveDocumentView | null>(null);
const loading = ref(true);
/** 页级阻塞态（未配置 / 未建立关联 / 初始化失败 / 会话到期）：整页无法继续，需常驻展示。 */
const errorText = ref('');
/** 操作结果（载入正文 / 保存 / 导出 / 编辑器运行时错误）走右上角浮层，与全站一致。 */
const { error: flashError, notice: flashNotice } = useFlash();
const mode = ref<'edit' | 'view'>('edit');
const saveState = ref<'idle' | 'saving' | 'saved' | 'failed'>('idle');
/** 入库状态：与保存严格分离，未开放自动入库时如实置为 unsupported（不伪装已入库）。 */
const syncState = ref<'idle' | 'syncing' | 'synced' | 'unsupported' | 'failed'>('idle');
const syncedVersion = ref<ArchiveFileVersionView | null>(null);
const connection = ref('连接中…');
const ready = ref(false);
const dirty = ref(false);
const seeding = ref(false);
const exporting = ref(false);

/** 厂商是否已开放导出字节回传（决定保存后能否自动入库）。 */
const autoExportAvailable = computed(() => status.value?.autoExportAvailable === true);

const containerId = 'jitword-editor-host';
let editor: JitWordEditorInstance | null = null;

/**
 * 一次性诊断开关：编辑页 URL 追加 ?selfcheck=1 时，就绪后取一次 getContent()
 * 交后端走厂商 POST /export/docx 渲染，用于比对保真度。不入库、不形成版本、不展示正式按钮。
 */
const selfCheckMode = new URLSearchParams(window.location.search).get('selfcheck') === '1';

function setNotice(s: string) {
  flashNotice.value = s;
}
function setError(s: string) {
  flashError.value = s;
}
function setBlockingError(s: string) {
  errorText.value = s;
}

/** 动态加载官方 loader.js（只加载一次），返回 window.JitWord。 */
function ensureLoader(loaderUrl: string): Promise<JitWordGlobal> {
  return new Promise((resolve, reject) => {
    if (window.JitWord) return resolve(window.JitWord);
    const existing = document.querySelector(`script[data-jitword-loader]`) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => (window.JitWord ? resolve(window.JitWord) : reject(new Error('SDK 未就绪'))));
      existing.addEventListener('error', () => reject(new Error('加载编辑器脚本失败')));
      return;
    }
    const script = document.createElement('script');
    script.src = loaderUrl;
    script.async = true;
    script.dataset.jitwordLoader = '1';
    script.onload = () => (window.JitWord ? resolve(window.JitWord) : reject(new Error('SDK 未就绪')));
    script.onerror = () => reject(new Error('加载编辑器脚本失败，请检查网络'));
    document.head.appendChild(script);
  });
}

/** 每次握手 / 续期都会调用：向后端现签一张票据，返回票据字符串（先试编辑，失败降级只读）。 */
async function getEmbedTicket(): Promise<string> {
  try {
    if (mode.value === 'edit') {
      const t = await api.post<{ ticket: string }>(`/archives/${props.id}/document/ticket`, {
        mode: 'edit',
        fileId: sourceFileId.value,
      });
      return t.ticket;
    }
  } catch (e) {
    if (e instanceof ApiError && (e.status === 400 || e.status === 403)) {
      mode.value = 'view';
      setError('当前身份或档案状态不支持编辑，已切换为只读预览。');
    } else {
      throw e;
    }
  }
  const t = await api.post<{ ticket: string }>(`/archives/${props.id}/document/ticket`, {
    mode: 'view',
    fileId: sourceFileId.value,
  });
  return t.ticket;
}

async function boot() {
  loading.value = true;
  errorText.value = '';
  try {
    status.value = await api.get<JitWordStatus>('/jitword/status');
    if (!status.value.available) {
      setBlockingError('JitWord 未配置，在线编辑功能暂不可用。');
      return;
    }
    doc.value = await api.get<ArchiveDocumentView>(withFileId(`/archives/${props.id}/document`));
    if (!doc.value) {
      setBlockingError('该文件尚未建立在线文档关联，请先在详情页选择对应文件并点击「在线编辑」。');
      return;
    }
    const st = status.value;
    const JitWord = await ensureLoader(st.loaderUrl);
    editor = JitWord.createEditor({
      container: `#${containerId}`,
      editorUrl: st.editorUrl,
      apiBase: st.apiBase,
      docId: doc.value.docId,
      documentType: 'document',
      tenantKey: st.tenantKey,
      providerKey: st.providerKey,
      auth: { mode: 'embed-ticket', getEmbedTicket },
      // ui.readonly 只收紧不放大；真实权限以后端票据 scopes 为准。
      ui: { theme: 'light', chrome: 'toolbar', readonly: mode.value === 'view' },
      debug: { enabled: false },
    });

    editor.on('ready', (payload: any) => {
      ready.value = true;
      connection.value = '已连接';
      const canEdit = payload?.canEdit ?? mode.value === 'edit';
      mode.value = canEdit ? 'edit' : 'view';
      setNotice(canEdit ? '编辑器就绪，可开始在线编辑。' : '以只读模式打开（无编辑权限或档案已归档）。');
      // 从未导入过附件正文（且从未保存过）时，把档案现有 DOCX 正文导入远端文档，避免展示空白页。
      // 判据不用 editState：签第一张编辑票时它就会被推进为 editing，用它会导致永远不再自动载入。
      if (canEdit && doc.value && !doc.value.seededAt && !doc.value.lastSavedAt) {
        // 自检需在正文已载入后取值，否则 getContent() 拿到的是空文档（首次关联时先 seed）。
        void seedContent().finally(() => {
          if (selfCheckMode) void selfCheckContent();
        });
      } else if (selfCheckMode && canEdit) {
        void selfCheckContent();
      }
    });
    editor.on('saveStateChanged', (payload: any) => {
      const s = payload?.saveStatus;
      if (s === 'saved') {
        // 实测：尚未编辑时 SDK 也会推 saved；未脏且未主动保存过时不置「已保存」，避免误导。
        if (dirty.value || saveState.value === 'saving') {
          saveState.value = 'saved';
          dirty.value = false;
        }
      } else if (s === 'saving' || s === 'dirty') {
        saveState.value = 'saving';
        dirty.value = true;
      }
    });
    editor.on('contentChanged', () => {
      dirty.value = true;
    });
    editor.on('connectionChanged', (payload: any) => {
      // SDK 实测会推送与在线/离线无关的中间态；只识别明确信号，未知状态如实展示，不再一律误报「连接中断」。
      const state = String(payload?.state ?? payload?.status ?? (payload?.online === true ? 'online' : ''));
      if (state === 'online') connection.value = '已连接';
      else if (state === 'offline' || state === 'disconnected') connection.value = '连接中断';
      else if (state) connection.value = `连接状态：${state}`;
    });
    editor.on('auth.sessionExpired', () => {
      connection.value = '会话已到期';
      setBlockingError('编辑会话已到期，请返回重新打开。');
    });
    editor.on('error', (payload: any) => {
      setError(`编辑器错误：${payload?.code || ''} ${payload?.message || ''}`.trim());
    });
  } catch (e) {
    setBlockingError(e instanceof ApiError ? e.message : '初始化在线编辑器失败，请稍后重试');
  } finally {
    loading.value = false;
  }
}

/** 从 SDK 各种包裹形态里取出真正的 ProseMirror doc JSON（type:"doc"）；取不到返回 null。 */
function pickDocJson(value: unknown): { type: string } | null {
  if (typeof value === 'string') {
    try {
      return pickDocJson(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'doc') return obj as { type: string };
  for (const key of ['result', 'content', 'data', 'doc', 'json']) {
    const nested = pickDocJson(obj[key]);
    if (nested) return nested;
  }
  return null;
}

/** 正文自检：取 getContent() → 回传后端渲染 → 展示条目差异（失败如实报厂商原文）。 */
async function selfCheckContent() {
  if (!editor) return;
  try {
    try {
      await editor.ready();
    } catch {
      /* ready 事件已触发，内部 ready() reject 时仍尝试取值 */
    }
    const raw = await editor.getContent();
    const content = pickDocJson(raw);
    if (!content) {
      setError(`正文自检未取到文档 JSON，getContent() 返回形态：${Object.keys((raw as object) ?? {})}`);
      return;
    }
    const r = await api.postRaw<{
      contentBytes: number;
      exported: { fileName: string; size: number; sha256: string; entries: number };
      source: { originalName: string; size: number; entries: number } | null;
      lostEntries: string[];
      addedEntries: string[];
      hasHeader: boolean;
      hasFooter: boolean;
      artifactDir: string;
    }>(withFileId(`/archives/${props.id}/document/content-selfcheck`), JSON.stringify(content));
    setNotice(
      `正文自检完成：渲染 ${r.exported.entries} 条目/${Math.round(r.exported.size / 1024)}KB，` +
        `源附件 ${r.source?.entries ?? 0} 条目，缺失 ${r.lostEntries.length}，新增 ${r.addedEntries.length}，` +
        `页眉${r.hasHeader ? '有' : '无'}、页脚${r.hasFooter ? '有' : '无'}；产物在 ${r.artifactDir}`,
    );
    console.info('[selfcheck]', r);
  } catch (e) {
    setError(`正文自检失败：${e instanceof ApiError ? e.message : (e as Error)?.message ?? '未知错误'}`);
  }
}

/** 拉取源 DOCX 并 importDocx 灌入真实正文（仅编辑模式、首次关联时）。 */
async function seedContent() {
  if (!editor) return;
  seeding.value = true;
  try {
    const blob = await api.getBlob(withFileId(`/archives/${props.id}/document/seed`), { method: 'POST' });
    // 真实浏览器验证发现：ready 事件后 SDK 内部可能尚未就绪（报 Editor is not ready），
    // 先等内部 ready()，失败再短延时重试两次。
    try {
      await editor.ready();
    } catch {
      /* 外层事件已 ready，内部 ready()  Reject 时直接尝试导入 */
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await editor.importDocx({ content: blob, fileName: 'seed.docx', mode: 'replace', timeout: 60000 });
        break;
      } catch (e) {
        if (attempt >= 3 || !/not ready/i.test(e instanceof Error ? e.message : '')) throw e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    // 标记「已导入」：仅记录事实，不代表保存或入库；写入失败不影响已完成的导入，但不得谎报成功。
    try {
      doc.value = await api.post<ArchiveDocumentView>(withFileId(`/archives/${props.id}/document/seeded`));
      setNotice('已载入档案现有 DOCX 正文，可继续编辑。');
    } catch (e) {
      const detail = e instanceof ApiError ? e.message : '';
      setError(`已载入正文，但导入标记未写入${detail ? `：${detail}` : ''}。刷新页面可能再次自动载入。`);
    }
  } catch (e) {
    // SDK 抛出的非 ApiError（如 importDocx 解析失败）也要展示真实原因，方便定位厂商侧拒绝。
    const detail = e instanceof Error ? e.message : '';
    setError(`载入正文失败${detail ? `：${detail}` : ''}`);
  } finally {
    seeding.value = false;
  }
}

async function onSave() {
  if (!editor) return;
  saveState.value = 'saving';
  syncState.value = 'idle';
  syncedVersion.value = null;
  try {
    await editor.save();
    await api.post(withFileId(`/archives/${props.id}/document/saved`));
    saveState.value = 'saved';
    dirty.value = false;
    // 保存只写入在线文档服务；能否直接形成正式版本取决于厂商是否开放导出字节回传。
    if (!autoExportAvailable.value) {
      syncState.value = 'unsupported';
      setNotice('已保存。当前在线文档服务未开放导出字节回传，形成正式文件版本请「导出 DOCX」后在详情页上传入库。');
      return;
    }
    syncState.value = 'syncing';
    try {
      const v = await api.post<ArchiveFileVersionView>(withFileId(`/archives/${props.id}/document/sync`));
      syncedVersion.value = v;
      syncState.value = 'synced';
      setNotice(`已保存并自动入库为文件版本 v${v.versionNo}。`);
    } catch (e) {
      syncState.value = 'failed';
      const detail = e instanceof ApiError ? e.message : '';
      setError(`已保存，但自动入库失败${detail ? `：${detail}` : '，请尝试导出 DOCX 后上传入库'}。`);
    }
  } catch (e) {
    saveState.value = 'failed';
    setError(e instanceof Error ? `保存失败：${e.message}` : '保存失败，请重试');
  }
}

/** 已入库版本的内嵌预览（保存后直接查看，不必回详情页）。 */
const versionPreview = ref<ArchiveFileVersionView | null>(null);
const versionPreviewRoute = computed(() =>
  versionPreview.value ? versionPreviewUrl(Number(props.id), versionPreview.value.id) : '',
);
function openVersionPreview() {
  versionPreview.value = syncedVersion.value;
}
function closeVersionPreview() {
  versionPreview.value = null;
}

/** 导出：调用 SDK 触发浏览器下载，仅代表“文件导出”，不入库。 */
async function onExport() {
  if (!editor) return;
  exporting.value = true;
  try {
    const res: any = await editor.exportDocx({ timeout: 60000 });
    if (res && res.success === false) throw new Error(res.message || '导出失败');
    setNotice('文件已导出到浏览器下载。请在档案详情页用「上传导出件入库」把该文件登记为正式档案版本。');
  } catch (e) {
    setError(e instanceof Error ? `导出失败：${e.message}` : '导出失败，请稍后重试');
  } finally {
    exporting.value = false;
  }
}

function beforeUnload(ev: BeforeUnloadEvent) {
  if (dirty.value && mode.value === 'edit') {
    ev.preventDefault();
    ev.returnValue = '';
  }
}

onMounted(() => {
  boot();
  window.addEventListener('beforeunload', beforeUnload);
});

onBeforeRouteLeave(async () => {
  if (dirty.value && mode.value === 'edit') {
    return await confirmDialog({
      title: '离开编辑器',
      message: '存在未保存的编辑内容，确定离开编辑器？',
      confirmText: '确定离开',
      danger: true,
    });
  }
  return true;
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beforeUnload);
  try {
    editor?.destroy();
  } catch {
    /* 销毁失败不影响离开 */
  }
  editor = null;
});

function backToDetail() {
  history.back();
}
</script>

<template>
  <div class="editor-page">
    <div class="editor-head">
      <div>
        <h2 class="page-title">在线编辑</h2>
        <p class="text-muted page-desc">
          档案 #{{ id }}
          <span v-if="doc" class="badge badge-muted" :title="doc.docName">
            {{ doc.sourceFileName || doc.docName }}
            <template v-if="doc.sourceExtension">（.{{ doc.sourceExtension }}）</template>
          </span>
          <span v-if="doc?.sourceExtension === 'doc'" class="badge badge-muted">旧版 DOC 已转为 DOCX 编辑</span>
          <span class="badge" :class="mode === 'edit' ? 'badge-success' : 'badge-muted'">
            {{ mode === 'edit' ? '编辑模式' : '只读模式' }}
          </span>
        </p>
      </div>
      <div class="head-actions">
        <button class="btn btn-sm" :disabled="seeding || !ready || mode !== 'edit'" @click="seedContent">
          {{ seeding ? '载入中…' : '载入附件正文' }}
        </button>
        <button
          class="btn btn-sm"
          :disabled="!ready || mode !== 'edit' || saveState === 'saving' || syncState === 'syncing'"
          @click="onSave"
        >
          {{ syncState === 'syncing' ? '入库中…' : saveState === 'saving' ? '保存中…' : '保存' }}
        </button>
        <button v-if="syncedVersion" class="btn btn-sm" @click="openVersionPreview">
          预览已入库 v{{ syncedVersion.versionNo }}
        </button>
        <button class="btn btn-primary btn-sm" :disabled="!ready || exporting" @click="onExport">
          {{ exporting ? '导出中…' : '导出 DOCX' }}
        </button>
        <button class="btn btn-sm" @click="backToDetail">返回详情</button>
      </div>
    </div>

    <div class="status-bar">
      <span>连接：{{ connection }}</span>
      <span>
        保存：
        <em v-if="saveState === 'idle'">未开始</em>
        <em v-else-if="saveState === 'saving'">正在保存…</em>
        <em v-else-if="saveState === 'saved'">已保存</em>
        <em v-else>失败</em>
      </span>
      <span>
        入库：
        <em v-if="syncState === 'idle'">未入库</em>
        <em v-else-if="syncState === 'syncing'">正在入库…</em>
        <em v-else-if="syncState === 'synced'">已入库 v{{ syncedVersion?.versionNo }}</em>
        <em v-else-if="syncState === 'unsupported'">未开放自动入库</em>
        <em v-else>失败</em>
      </span>
    </div>

    <div v-if="errorText" class="alert alert-error">{{ errorText }}</div>
    <AppLoading v-if="loading" text="正在加载编辑器…" />

    <div :id="containerId" class="editor-host"></div>

    <p class="text-muted hint">
      提示：「保存」把内容写入在线文档服务；厂商开放导出字节回传时会在保存后自动入库并形成文件版本 vN，
      未开放时请用「导出 DOCX」将导出件在详情页上传入库。只有形成文件版本后方可归档。
      如需编辑本档案的其他 DOC/DOCX 文件，请返回详情页重新选择。
    </p>

    <!-- 已入库版本预览：字节经受控接口获取，DOCX 由 JitWord-Preview SDK 渲染 -->
    <ArchivePreviewDialog
      v-if="versionPreview"
      :key="versionPreviewRoute"
      :name="'版本 v' + versionPreview.versionNo + '.docx'"
      extension="docx"
      :file-size="versionPreview.fileSize"
      :route-path="versionPreviewRoute"
      :sdk-url="status?.previewSdkUrl"
      :can-download="false"
      @close="closeVersionPreview"
    />
  </div>
</template>

<style scoped>
.editor-page { display: flex; flex-direction: column; height: 100%; }
.editor-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.page-title { font-size: 20px; margin: 0; }
.page-desc { margin: 4px 0 0; }
.head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.status-bar { display: flex; gap: 24px; margin: 12px 0; font-size: 13px; color: var(--text-muted); }
.status-bar em { font-style: normal; color: var(--color-primary); }
.editor-host {
  flex: 1;
  min-height: 560px;
  width: 100%;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  background: #fff;
}
.hint { margin-top: 10px; font-size: 12px; }

/* 移动端：标题与操作换行，编辑区高度改为视口相对值 */
@media (max-width: 767px) {
  .editor-page { height: auto; min-height: 100%; }
  .editor-head { flex-wrap: wrap; }
  .status-bar { flex-wrap: wrap; gap: 6px 16px; }
  .editor-host {
    min-height: 60vh;
    min-height: 60dvh;
  }
}
</style>
