<script setup lang="ts">
/**
 * 档案详情页：完整著录信息 + 附件列表（授权下载 / 受控在线预览）+ 权限内操作（编辑/归档/上传附件）。
 * 附件上传走裸流（octet-stream）→ 后端流式落盘 → 数据库登记元数据，刷新后仍可查询。
 * 在线预览（V1.0 + JitWord-Preview SDK）：SDK 支持的 8 种格式与位图走预览通道；
 * 不支持预览的格式（zip/tiff/旧版 .doc）不提供入口，后端同样 415 拒绝。
 * 附件与文件版本的预览入口同时要求「格式可预览」与「后端详情返回的档案级授权」，
 * 不以文件格式或前端角色单独放开受限档案访问；已归档档案同样可预览。
 */
import { computed, watch, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api, ApiError, downloadFile, previewUrl, versionPreviewUrl } from '../api/client';
import { useAuthStore } from '../stores/auth';
import { can, fmtSize } from '../perms';
import type {
  ArchiveDetailView,
  ArchiveFileView,
  ArchiveDocumentView,
  ArchiveFileVersionView,
  ArchiveContentStatus,
  FileContentStatus,
  JitWordStatus,
} from '../types';
import { useFlash } from '../toast';
import AppFilePicker from '../components/ui/AppFilePicker.vue';
import AppSelect from '../components/ui/AppSelect.vue';
import AppEmpty from '../components/ui/AppEmpty.vue';
import ArchivePreviewDialog from '../components/ArchivePreviewDialog.vue';
import { confirmDialog } from '../components/ui/dialog';
import {routePositiveId} from '../lib/agentSource';
import { PREVIEW_EXTS } from '../lib/previewSdk';
import type {AgentSourceHit} from '../types';
import { CONTENT_STATUS_LABELS } from '../types';

const props = defineProps<{ id: string }>();

const auth = useAuthStore();
const router = useRouter();
const route=useRoute();
let loadGeneration=0;

const detail = ref<ArchiveDetailView | null>(null);
const loading = ref(false);
/** 上传/归档/下载等操作结果走右上角浮层，不常驻详情页（预览失败仍内联展示并带重试）。 */
const { error, notice } = useFlash();
const uploading = ref(false);
const downloading = ref<number | null>(null);
/** 正在删除的附件 id：删除期间禁用该行按钮，防重复提交。 */
const deletingFileId = ref<number | null>(null);

// 在线编辑（阶段二第三批）
const doc = ref<ArchiveDocumentView | null>(null);
/** 该档案已建立的全部在线文档关联（每个 DOC/DOCX 附件一条）。 */
const documents = ref<ArchiveDocumentView[]>([]);
/** 用户选择要在线编辑的源附件 id（空串表示未选择）。 */
const selectedEditFileId = ref<string>('');
const versions = ref<ArchiveFileVersionView[]>([]);
const jitword = ref<JitWordStatus | null>(null);
const linking = ref(false);
const reuploading = ref(false);
// 入库版本归属的附件：空串 = 交由后端按在线文档源附件归属；选定后版本号可精确回到该附件。
const versionTargetFileId = ref<string>('');

// 附件正文索引（第二阶段）：只拉取状态与真实原因，正文本身不出后端。
const content = ref<ArchiveContentStatus | null>(null);
const contentLoading = ref(false);
const contentReindexing = ref(false);

const canManage = computed(() => can(auth.user?.role, 'archiveManage'));
const canTransition = computed(() => can(auth.user?.role, 'archiveTransition'));
const canUpload = computed(() => can(auth.user?.role, 'fileUpload'));
/**
 * 附件下载/预览授权：以详情接口返回的档案级判定为准（已含受限档案借阅授权、
 * 创建者本人、管理员等规则），前端角色矩阵仅做二次收敛，不单独放开受限档案。
 */
const archiveCanDownload = computed(() => detail.value?.permissions?.canDownload === true);
const canDownload = computed(() => can(auth.user?.role, 'fileDownload') && archiveCanDownload.value);
/** 预览与下载同源授权（预览向浏览器传输完整字节），因此预览权限不得宽于下载。 */
const canPreview = computed(() => canDownload.value);
const canDocumentEdit = computed(() => can(auth.user?.role, 'documentEdit'));
const canRequestBorrow = computed(() => can(auth.user?.role, 'borrowRequest'));
const isDraft = computed(() => detail.value?.status === 'draft');
const forbidden = ref(false); // 无权查看（后端 403）：展示借阅入口（仅体验补充，非安全控制）
/** 可在线编辑的格式以后端能力声明为准（.doc/.docx），缺省兼容旧后端。 */
const onlineEditExtensions = computed<string[]>(() =>
  jitword.value?.editableExtensions?.length ? jitword.value.editableExtensions : ['doc', 'docx'],
);
/** 本档案可用于在线编辑的源附件（.doc / .docx）。 */
const editableFiles = computed(() =>
  (detail.value?.files ?? []).filter((f) => onlineEditExtensions.value.includes(f.extension)),
);
const hasEditableFile = computed(() => editableFiles.value.length > 0);
/** 可在线编辑文件的下拉选项（多文件时由用户选择要改哪一个；已关联的明确标注）。 */
const editFileOptions = computed(() =>
  editableFiles.value.map((f) => {
    const linked = documents.value.some((item) => item.sourceFileId === f.id);
    return {
      label: `${f.originalName}（.${f.extension}${linked ? ' · 已关联' : ''}）`,
      value: String(f.id),
    };
  }),
);
/** 当前选择文件已建立的关联；未选择时回退到旧版单条关联。 */
const selectedDoc = computed<ArchiveDocumentView | null>(() => {
  const fileId = Number(selectedEditFileId.value);
  if (!Number.isInteger(fileId) || fileId <= 0) return doc.value;
  return (
    documents.value.find((item) => item.sourceFileId === fileId) ??
    (doc.value?.sourceFileId === fileId ? doc.value : null)
  );
});
/** 可作为版本归属目标的附件（.doc/.docx，与后端入库归属校验同口径）。 */
const versionSourceFiles = computed(() => editableFiles.value);
/** 版本归属下拉选项：空值 = 自动（后端按在线文档源附件归属），其余为本档案可编辑附件。 */
const versionTargetOptions = computed(() => [
  { label: '自动（在线文档的源附件）', value: '' },
  ...versionSourceFiles.value.map((f) => ({ label: f.originalName, value: String(f.id) })),
]);

// 在线预览（V1.0 + JitWord-Preview SDK）：SDK 格式与位图统一走受控预览接口，
// 真实字节格式判定与同级下载授权均在后端预览接口执行。

/** 预览目标：附件或文件版本（routePath 为受控字节流接口，不经浏览器直链）。 */
interface PreviewTarget {
  sourceHit?:AgentSourceHit;
  name: string;
  extension: string;
  fileSize: number;
  routePath: string;
  /** 附件对象；文件版本预览为 null（版本无独立下载入口）。 */
  file: ArchiveFileView | null;
}
const previewTarget = ref<PreviewTarget | null>(null);

/** 可预览的格式清单（真实字节格式判定仍由后端预览接口执行）。 */
function formatPreviewable(f: ArchiveFileView): boolean {
  return PREVIEW_EXTS.includes(f.extension);
}

/** 预览入口：格式支持预览 + 当前用户拥有真实预览（下载同级）授权，二者缺一不可。 */
function isPreviewable(f: ArchiveFileView): boolean {
  return canPreview.value && formatPreviewable(f);
}

/** 打开附件预览：字节一律经登录态受控接口获取，由预览弹窗交给 SDK/图片通道渲染。 */
function openPreview(f: ArchiveFileView) {
  if(!isPreviewable(f))return;
  previewTarget.value = {
    name: f.originalName,
    extension: f.extension,
    fileSize: f.fileSize,
    routePath: previewUrl(f.id),
    file: f,
  };
}

/** 打开文件版本预览：已归档档案同样可用（后端按下载同级授权复判）。 */
function openVersionPreview(v: ArchiveFileVersionView) {
  const archive = detail.value;
  if (!archive) return;
  previewTarget.value = {
    name: `${archive.title}-v${v.versionNo}.docx`,
    extension: 'docx',
    fileSize: v.fileSize,
    routePath: versionPreviewUrl(archive.id, v.id),
    file: null,
  };
}

function closePreview() {
  previewTarget.value = null;
}

/** 弹窗内的「下载」仅针对附件；版本预览不提供独立下载入口。 */
function downloadPreviewTarget() {
  const target = previewTarget.value?.file;
  if (target) void download(target);
}

/** 在线编辑入口状态与不可用原因（前端仅控显示，真实校验在后端）。 */
const editAvailability = computed(() => {
  if (!jitword.value?.available) return { ok: false, reason: 'JitWord 未配置，在线编辑暂不可用' };
  if (!canDocumentEdit.value) return { ok: false, reason: '当前角色无在线编辑权限' };
  if (!isDraft.value) return { ok: false, reason: '档案已归档，在线编辑已停用' };
  if (!hasEditableFile.value) return { ok: false, reason: '请先上传 .doc 或 .docx 电子文件后再在线编辑' };
  return { ok: true, reason: '' };
});

const editStateLabel: Record<string, string> = {
  linked: '已关联（待编辑）',
  editing: '编辑中',
  saved: '已保存（待形成文件版本）',
  unsupported: '不支持在线编辑',
};

function errMsg(e: unknown): string {
  return e instanceof ApiError ? e.message : '操作失败，请稍后重试';
}

async function load() {
  const generation=++loadGeneration,archiveId=props.id;
  previewTarget.value=null;detail.value=null;content.value=null;versions.value=[];
  doc.value=null;documents.value=[];selectedEditFileId.value='';versionTargetFileId.value='';
  loading.value = true;
  error.value = '';
  forbidden.value = false;
  try {
    const loaded=await api.get<ArchiveDetailView>(`/archives/${archiveId}`);
    if(generation!==loadGeneration)return;
    detail.value=loaded;
    syncSelectedEditFile();
  } catch (e) {
    if(generation!==loadGeneration)return;
    error.value = errMsg(e);
    forbidden.value = e instanceof ApiError && e.status === 403;
    detail.value = null;
  } finally {
    if(generation===loadGeneration)loading.value = false;
  }
  if(generation!==loadGeneration)return;
  // 并行加载在线编辑相关状态（失败不阻断详情展示）。
  try {
    jitword.value = await api.get<JitWordStatus>('/jitword/status');
  } catch {
    jitword.value = { available: false } as JitWordStatus;
  }
  if(generation!==loadGeneration)return;
  if (detail.value) await loadDocumentAndVersions();
  if(generation!==loadGeneration)return;
  void loadContentStatus();
  await openRequestedSource(generation);
}

/** 读取附件正文索引状态（失败不阻断详情展示，仅不展示面板）。 */
async function loadContentStatus() {
  const id = detail.value?.id;
  if (!id) return;
  contentLoading.value = true;
  try {
    content.value = await api.get<ArchiveContentStatus>(`/archives/${id}/content/status`);
  } catch {
    content.value = null;
  } finally {
    contentLoading.value = false;
  }
}

/**
 * 手动重建正文索引：后端只对索引表做幂等重写，不改动档案/附件/版本业务数据；
 * 已入索引当前内容的文件会直接跳过，因此重复调用不会产生重复索引。
 */
async function reindexContent() {
  if (!detail.value) return;
  contentReindexing.value = true;
  error.value = '';
  notice.value = '';
  try {
    const res = await api.post<ArchiveContentStatus>(`/archives/${detail.value.id}/content/reindex`);
    content.value = res;
    notice.value =
      res.synced > 0
        ? `正文索引已重建：本次写入 ${res.synced} 个文件的索引。`
        : '正文索引已是最新，无需重建。';
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    contentReindexing.value = false;
  }
}

/** 已入索引附件数（仅计数真实状态为 indexed 的行）。 */
const indexedFileCount = computed(() => (content.value?.files ?? []).filter((f) => f.status === 'indexed').length);

/** 索引状态徽标颜色：成功 / 不可用 / 其余分三档，不美化失败原因。 */
function contentBadge(f: FileContentStatus): string {
  if (f.status === 'indexed') return 'badge badge-success';
  if (f.status === 'corrupt' || f.status === 'encrypted' || f.status === 'failed') return 'badge badge-danger';
  return 'badge badge-muted';
}

/** 正文规模描述：仅统计字数与片段数，不展示正文。 */
function contentScale(f: FileContentStatus): string {
  if (f.status !== 'indexed') return '—';
  return `${f.charCount} 字 · ${f.chunkCount} 个片段${f.truncated ? '（已截断）' : ''}`;
}

/** 让「要编辑的文件」默认落在已有关联或首个可编辑附件上；preferLinked 用于关联列表加载完成后纠正默认值。 */
function syncSelectedEditFile(preferLinked = false) {
  const linked = doc.value?.sourceFileId;
  if (preferLinked && linked && editableFiles.value.some((f) => f.id === linked)) {
    selectedEditFileId.value = String(linked);
  } else {
    const current = Number(selectedEditFileId.value);
    if (Number.isInteger(current) && current > 0 && editableFiles.value.some((f) => f.id === current)) {
      // 已选择且仍有效：保留用户选择
    } else {
      const preferred = linked ?? editableFiles.value[0]?.id;
      selectedEditFileId.value = preferred ? String(preferred) : '';
    }
  }
  if (!versionTargetFileId.value && selectedEditFileId.value) {
    versionTargetFileId.value = selectedEditFileId.value;
  }
}

/** 拉取文档关联与文件版本列表。 */
async function loadDocumentAndVersions() {
  const id = detail.value?.id;
  if (!id) return;
  try {
    doc.value = await api.get<ArchiveDocumentView | null>(`/archives/${id}/document`);
  } catch {
    doc.value = null;
  }
  try {
    documents.value = await api.get<ArchiveDocumentView[]>(`/archives/${id}/documents`);
  } catch {
    documents.value = doc.value ? [doc.value] : [];
  }
  syncSelectedEditFile(true);
  try {
    versions.value = await api.get<ArchiveFileVersionView[]>(`/archives/${id}/versions`);
  } catch {
    versions.value = [];
  }
}

/** 点击"在线编辑"：无 DOC/DOCX 时提示并滚动到上传区域；否则为用户选中的文件幂等建立关联再跳转编辑页。 */
async function startOnlineEdit() {
  if (!detail.value || linking.value) return;
  if (!hasEditableFile.value) {
    notice.value = '请先上传 .doc 或 .docx 电子文件后再进行在线编辑。';
    const el = document.getElementById('upload-section');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (!editAvailability.value.ok) return;
  const fileId = Number(selectedEditFileId.value);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    notice.value = '请先选择要在线编辑的文件。';
    return;
  }
  linking.value = true;
  error.value = '';
  notice.value = '';
  try {
    doc.value = await api.post<ArchiveDocumentView>(`/archives/${detail.value.id}/document/link`, { fileId });
    const index = documents.value.findIndex((item) => item.sourceFileId === fileId);
    if (index >= 0) documents.value[index] = doc.value;
    else documents.value.push(doc.value);
    await router.push({
      path: `/archives/${detail.value.id}/edit-online`,
      query: { fileId: String(fileId) },
    });
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    linking.value = false;
  }
}

/** 将用户浏览器导出的 docx 回传入库，形成正式文件版本（裸流上传）。 */
async function uploadVersion(file: File) {
  if (!detail.value) return;
  reuploading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const target = versionTargetFileId.value;
    const query = target ? `?fileId=${target}` : '';
    const v = await api.postStream<ArchiveFileVersionView>(`/archives/${detail.value.id}/versions${query}`, file);
    versions.value = [v, ...versions.value];
    const targetName = target
      ? versionSourceFiles.value.find((f) => f.id === Number(target))?.originalName || `附件 #${target}`
      : '';
    if (doc.value) {
      try {
        doc.value = await api.get<ArchiveDocumentView>(`/archives/${detail.value.id}/document`);
      } catch {
        /* 关联状态刷新失败不影响版本提示 */
      }
    }
    notice.value = target
      ? `已将「${file.name}」入库为「${targetName}」的 v${v.versionNo}（SHA ${v.sha256.slice(0, 8)}），正文索引已切换到新版本。`
      : `已将「${file.name}」入库为版本 v${v.versionNo}（SHA ${v.sha256.slice(0, 8)}）。`;
    // 版本入库后后端已同步索引新内容，刷新面板以确认旧版本不再被检索。
    await loadContentStatus();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    reuploading.value = false;
  }
}

async function transition() {
  if (!detail.value) return;
  const ok = await confirmDialog({
    title: '确认归档',
    message: `确认将档案「${detail.value.title}」归档？归档后著录信息将不可修改。`,
    confirmText: '确认归档',
    danger: true,
  });
  if (!ok) return;
  error.value = '';
  notice.value = '';
  try {
    detail.value = await api.post<ArchiveDetailView>(`/archives/${detail.value.id}/transition-archive`);
    notice.value = '档案已归档，进入只读状态。';
  } catch (e) {
    error.value = errMsg(e);
  }
}

/** 选择文件后以裸流上传：后端流式落盘并登记元数据，返回真实附件视图。 */
async function uploadFile(file: File) {
  if (!detail.value) return;
  uploading.value = true;
  error.value = '';
  notice.value = '';
  try {
    const saved = await api.postStream<ArchiveFileView>(
      `/archive-files/upload?archiveId=${detail.value.id}`,
      file,
    );
    detail.value.files.push(saved);
    syncSelectedEditFile();
    notice.value = `已上传附件「${saved.originalName}」（${fmtSize(saved.fileSize)}）。`;
    // 后端上传时已同步提取正文，此处刷新状态面板如实展示结果（含失败原因）。
    await loadContentStatus();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    uploading.value = false;
  }
}

async function download(f: ArchiveFileView) {
  error.value = '';
  downloading.value = f.id;
  try {
    await downloadFile(f.id);
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    downloading.value = null;
  }
}

/**
 * 删除单个附件：仅草稿可操作（与上传按钮同口径显隐），二次确认后调后端，
 * 成功即重新拉取详情（附件列表与正文索引状态以服务端为准）。
 */
async function removeFile(f: ArchiveFileView) {
  if (!detail.value || deletingFileId.value !== null) return;
  const ok = await confirmDialog({
    title: '删除附件',
    message: `确认删除附件「${f.originalName}」？其正文索引将一并清除，且不可恢复。`,
    confirmText: '确认删除',
    danger: true,
  });
  if (!ok) return;
  deletingFileId.value = f.id;
  error.value = '';
  try {
    await api.del<{ ok: true }>(`/archive-files/${f.id}`);
    notice.value = `已删除附件「${f.originalName}」`;
    await load();
  } catch (e) {
    error.value = errMsg(e);
  } finally {
    deletingFileId.value = null;
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

/** 动态著录值回显：布尔转是/否，多选 JSON 转顿号分隔。 */
function displayDynValue(dv: { type: string; value: string }): string {
  if (dv.type === 'bool') return dv.value === '1' ? '是' : dv.value === '0' ? '否' : '—';
  if (dv.type === 'tags') {
    try {
      const arr = JSON.parse(dv.value);
      return Array.isArray(arr) && arr.length ? arr.join('、') : '—';
    } catch {
      return dv.value || '—';
    }
  }
  return dv.value || '—';
}

async function openRequestedSource(generation:number) {
  if(route.query.fileId===undefined)return;
  const fileId=routePositiveId(route.query.fileId),chunkId=routePositiveId(route.query.chunkId);
  const file=detail.value?.files.find(candidate=>candidate.id===fileId);
  if(!file){error.value='来源附件不存在或不属于当前档案，请重新检索';return;}
  if(!canPreview.value){error.value='当前没有该附件的预览权限';return;}
  try {
    let sourceHit:AgentSourceHit|undefined;
    if(route.query.chunkId!==undefined){
      if(!chunkId)throw new Error('来源定位参数无效，请重新检索');
      sourceHit=await api.get<AgentSourceHit>(`/knowledge/attachments/${file.id}/source/${chunkId}?archiveId=${detail.value!.id}`);
    }
    if(generation!==loadGeneration)return;
    if(!formatPreviewable(file)){error.value='已找到对应附件，该格式暂不支持预览，可下载查看';return;}
    openPreview(file);
    if(previewTarget.value){
      previewTarget.value.sourceHit=sourceHit;
      if(sourceHit?.versionId)previewTarget.value.routePath=versionPreviewUrl(detail.value!.id,sourceHit.versionId);
      else if(!sourceHit && file.extension==='docx'){
        // Legacy cards have no chunk ID. Resolve their latest version from the real archive version list.
        const status=await api.get<ArchiveContentStatus>(`/archives/${detail.value!.id}/content/status`);
        if(generation!==loadGeneration)return;
        const versionNo=status.files.find(candidate=>candidate.fileId===file.id)?.versionNo;
        const version=versions.value.find(candidate=>candidate.versionNo===versionNo);
        if(version && previewTarget.value)previewTarget.value.routePath=versionPreviewUrl(detail.value!.id,version.id);
      }
    }
  }catch(e){if(generation===loadGeneration){previewTarget.value=null;error.value=e instanceof Error?e.message:'来源加载失败，请重新检索';}}
}

watch(()=>[props.id,route.query.fileId,route.query.chunkId],()=>{void load();},{immediate:true});
</script>

<template>
  <div>
    <h2 class="page-title">档案详情</h2>
    <p class="text-muted page-desc">
      <a class="link" @click="router.push('/archives')">← 返回档案列表</a>
    </p>

    <div v-if="loading" class="alert alert-info">加载中…</div>

    <template v-if="detail">
      <section class="card">
        <div class="card-title">
          著录信息
          <span :class="detail.status === 'archived' ? 'badge badge-success' : 'badge'">
            {{ detail.statusLabel }}
          </span>
          <!-- 在线编辑入口：与「在线编辑与文档版本」板块按钮同一显示条件、同一动作 -->
          <button
            v-if="canDocumentEdit && isDraft"
            class="btn btn-primary btn-sm push-right"
            :disabled="linking"
            @click="startOnlineEdit"
          >
            {{ linking ? '建立关联中…' : selectedDoc ? '继续在线编辑' : '在线编辑' }}
          </button>
        </div>
        <div class="desc-grid">
          <div class="desc-item"><span class="k">档案标题</span><span class="v">{{ detail.title }}</span></div>
          <div class="desc-item"><span class="k">档号</span><span class="v mono">{{ detail.archiveNo }}</span></div>
          <div class="desc-item"><span class="k">所属分类</span><span class="v">{{ detail.categoryPath || detail.categoryName }}</span></div>
          <div class="desc-item"><span class="k">档案类型</span><span class="v">{{ detail.archiveType }}</span></div>
          <div class="desc-item">
            <span class="k">访问级别</span>
            <span class="v">
              <span :class="detail.accessLevel === 'restricted' ? 'badge' : 'badge badge-success'">
                {{ detail.accessLevel === 'restricted' ? '受限' : '公开' }}
              </span>
            </span>
          </div>
          <div class="desc-item"><span class="k">关键词</span><span class="v">{{ detail.keywords || '—' }}</span></div>
          <div class="desc-item"><span class="k">形成时间</span><span class="v">{{ detail.formationDate || '—' }}</span></div>
          <div class="desc-item"><span class="k">责任者/来源</span><span class="v">{{ detail.responsible || '—' }}</span></div>
          <div class="desc-item"><span class="k">创建人</span><span class="v">{{ detail.createdByName }}（{{ detail.createdByRoleLabel }}）</span></div>
          <div class="desc-item"><span class="k">创建时间</span><span class="v">{{ fmtTime(detail.createdAt) }}</span></div>
          <div class="desc-item"><span class="k">最近更新</span><span class="v">{{ fmtTime(detail.updatedAt) }}</span></div>
        </div>
        <div class="remarks" v-if="detail.remarks">
          <span class="text-muted">备注说明：</span>{{ detail.remarks }}
        </div>
        <div class="actions">
          <button
            v-if="canManage && isDraft"
            class="btn btn-primary btn-sm"
            @click="router.push(`/archives/${detail.id}/edit`)"
          >
            编辑著录信息
          </button>
          <button
            v-if="canTransition && isDraft"
            class="btn btn-sm"
            @click="transition"
          >
            归档
          </button>
          <span class="text-muted" v-else-if="!isDraft">已归档档案不可再修改或流转。</span>
        </div>
      </section>

      <section class="card" style="margin-top: 20px" v-if="detail.dynamicFields && detail.dynamicFields.length">
        <div class="card-title">动态著录字段<span class="badge badge-muted">元数据模板</span></div>
        <div class="desc-grid">
          <div class="desc-item" v-for="dv in detail.dynamicFields" :key="dv.fieldKey">
            <span class="k">{{ dv.label }}</span>
            <span class="v">{{ displayDynValue(dv) }}</span>
          </div>
        </div>
      </section>

      <section id="upload-section" class="card" style="margin-top: 20px">
        <div class="card-title">
          关联电子文件
          <span class="badge badge-muted">{{ detail.files.length }} 个附件</span>
          <AppFilePicker
            v-if="canUpload && isDraft"
            class="push-right"
            accept=".docx,.doc,.pdf,.txt,.xlsx,.xls,.pptx,.ppt,.ofd,.md,.html,.jpg,.jpeg,.png,.gif,.bmp,.tif,.tiff,.zip"
            :busy="uploading"
            label="上传附件"
            busy-label="上传中…"
            @picked="uploadFile"
          />
        </div>

        <div class="table-scroll" v-if="detail.files.length">
          <table class="table tbl-attach">
          <colgroup>
            <col />
            <col class="col-att-format" />
            <col class="col-att-size" />
            <col class="col-att-uploader" />
            <col class="col-att-time" />
            <col class="col-att-ops" />
          </colgroup>
          <thead>
            <tr>
              <th>文件名</th>
              <th>格式</th>
              <th>大小</th>
              <th>上传人</th>
              <th>上传时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in detail.files" :key="f.id">
              <td>{{ f.originalName }}</td>
              <td class="nowrap"><span class="badge badge-muted">.{{ f.extension }}</span></td>
              <td class="nowrap">{{ fmtSize(f.fileSize) }}</td>
              <td>{{ f.uploadedByName }}</td>
              <td class="nowrap">{{ fmtTime(f.uploadedAt) }}</td>
              <td class="nowrap">
                <button
                  v-if="isPreviewable(f)"
                  class="btn btn-sm"
                  @click="openPreview(f)"
                >
                  预览
                </button>
                <button
                  v-if="canDownload"
                  class="btn btn-sm"
                  :disabled="downloading === f.id"
                  @click="download(f)"
                >
                  {{ downloading === f.id ? '下载中…' : '下载原文件' }}
                </button>
                <button
                  v-if="canUpload && isDraft"
                  class="btn btn-sm btn-danger"
                  :disabled="deletingFileId === f.id"
                  @click="removeFile(f)"
                >
                  {{ deletingFileId === f.id ? '删除中…' : '删除' }}
                </button>
                <span v-if="!canDownload" class="text-muted">无文件查看权限</span>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <AppEmpty
          v-else-if="!uploading"
          compact
          title="暂无附件"
          :description="canUpload && isDraft ? '点击「上传附件」挂接 DOCX / PDF 等电子文件。' : '仅未归档档案可上传附件。'"
        />
      </section>

      <!-- 附件正文索引（第二阶段）：展示每个附件的可检索状态与真实原因，不展示正文本身 -->
      <section
        class="card"
        style="margin-top: 20px"
        v-if="detail.files.length && (content || contentLoading) && can(auth.user?.role, 'archiveView')"
      >
        <div class="card-title">
          附件正文索引
          <span class="badge badge-muted">{{ indexedFileCount }}/{{ content?.files.length ?? 0 }} 已入索引</span>
          <button
            class="btn btn-sm push-right"
            :disabled="contentReindexing"
            title="仅重写检索索引，不修改档案、附件与版本数据"
            @click="reindexContent"
          >
            {{ contentReindexing ? '重建中…' : '重建正文索引' }}
          </button>
        </div>
        <p class="text-muted">
          仅 DOCX / PDF / TXT 可提取正文；扫描件与旧版 .doc 本阶段不启用 OCR，不会参与正文问答。
          附件正文只在你有权访问本档案时才会被检索与交给模型，下表只展示状态与原因。
        </p>

        <div class="table-scroll" v-if="content && content.files.length">
          <table class="table tbl-index">
            <colgroup>
              <col />
              <col class="col-idx-format" />
              <col class="col-idx-ver" />
              <col class="col-idx-status" />
              <col class="col-idx-scale" />
              <col class="col-idx-note" />
              <col class="col-idx-time" />
            </colgroup>
            <thead>
              <tr>
                <th>文件名</th>
                <th>格式</th>
                <th>索引版本</th>
                <th>状态</th>
                <th>正文规模</th>
                <th>说明</th>
                <th>索引时间</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in content.files" :key="f.fileId">
                <td>{{ f.fileName }}</td>
                <td class="nowrap"><span class="badge badge-muted">.{{ f.extension }}</span></td>
                <td>{{ f.versionNo != null ? 'v' + f.versionNo : '上传原件' }}</td>
                <td class="nowrap"><span :class="contentBadge(f)">{{ CONTENT_STATUS_LABELS[f.status] || f.status }}</span></td>
                <td>{{ contentScale(f) }}</td>
                <td>
                  <span :class="f.status === 'indexed' ? 'text-muted' : ''">
                    {{ f.status === 'indexed' ? '可按正文检索' : f.message || CONTENT_STATUS_LABELS[f.status] }}
                  </span>
                </td>
                <td>{{ f.indexedAt ? fmtTime(f.indexedAt) : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-muted" v-else-if="contentLoading">正在读取正文索引状态…</p>
        <p class="text-muted" v-else>暂无索引状态，可点击「重建正文索引」为已有附件补齐。</p>
      </section>

      <section class="card" style="margin-top: 20px">
        <div class="card-title">
          在线编辑与文档版本
          <span class="badge" :class="selectedDoc && selectedDoc.canEdit ? 'badge-success' : 'badge-muted'">
            {{ selectedDoc ? (editStateLabel[selectedDoc.editState] || selectedDoc.editState) : '未建立关联' }}
          </span>
          <button
            v-if="canDocumentEdit && isDraft"
            class="btn btn-primary btn-sm push-right"
            :disabled="linking"
            @click="startOnlineEdit"
          >
            {{ linking ? '建立关联中…' : selectedDoc ? '继续在线编辑' : '在线编辑' }}
          </button>
        </div>

        <p class="text-muted" v-if="!editAvailability.ok && hasEditableFile">{{ editAvailability.reason }}</p>
        <div class="edit-file-row" v-if="canDocumentEdit && isDraft && editableFiles.length > 1">
          <span class="text-muted edit-file-title">要在线编辑的文件</span>
          <div class="edit-file-select">
            <AppSelect
              id="online-edit-file"
              v-model="selectedEditFileId"
              :options="editFileOptions"
              aria-label="选择要在线编辑的文件"
            />
          </div>
          <span class="text-muted hint-inline">本档案有 {{ editableFiles.length }} 个 DOC/DOCX 附件，请选择要修改的文件。</span>
        </div>
        <div class="desc-grid" v-if="selectedDoc">
          <div class="desc-item">
            <span class="k">源电子文件</span>
            <span class="v">{{ selectedDoc.sourceFileName || '—' }}<span v-if="selectedDoc.sourceExtension" class="badge badge-muted">.{{ selectedDoc.sourceExtension }}</span></span>
          </div>
          <div class="desc-item"><span class="k">在线文档</span><span class="v">{{ selectedDoc.docName }}</span></div>
          <div class="desc-item"><span class="k">建档人</span><span class="v">{{ selectedDoc.creatorName }}</span></div>
          <div class="desc-item">
            <span class="k">当前身份</span>
            <span class="v">{{ selectedDoc.canEdit ? '本人为建档者，可编辑' : '非建档者，受 JitWord 授权模型限制仅可只读' }}</span>
          </div>
          <div class="desc-item"><span class="k">最近保存</span><span class="v">{{ selectedDoc.lastSavedAt ? fmtTime(selectedDoc.lastSavedAt) : '尚未保存' }}</span></div>
        </div>
        <p class="text-muted" v-else>建立关联后可在本档案任选一个 DOC/DOCX 附件开启在线编辑（同一文件重复点击不会重复创建远端文档）。</p>
        <p class="text-muted" v-if="selectedDoc?.sourceExtension === 'doc'">
          旧版 .doc 会在导入编辑器前自动转换为 .docx，在线编辑成果以 .docx 文件版本入库，原 .doc 附件保持不变。
        </p>

        <div class="version-actions-block" v-if="canDocumentEdit && isDraft">
          <span class="text-muted version-target-title">入库为哪个附件的新版本</span>
          <div class="version-actions">
            <div class="version-target">
              <AppSelect
                id="ver-target"
                v-model="versionTargetFileId"
                :options="versionTargetOptions"
                aria-label="入库为哪个附件的新版本"
              />
            </div>
            <AppFilePicker
              accept=".docx"
              :busy="reuploading"
              label="上传导出件入库"
              busy-label="入库中…"
              @picked="uploadVersion"
            />
            <span
              class="text-muted hint-inline"
              title="将编辑器「导出 DOCX」得到的浏览器下载件选回此处，形成正式文件版本（厂商未开放自动入库时使用）。选定附件后，正文索引与问答来源会精确到该附件的新版本号。"
            >将编辑器「导出 DOCX」得到的浏览器下载件选回此处，形成正式文件版本（厂商未开放自动入库时使用）。选定附件后，正文索引与问答来源会精确到该附件的新版本号。</span>
          </div>
        </div>

        <div class="table-scroll" v-if="versions.length">
          <table class="table tbl-ver">
          <colgroup>
            <col class="col-ver-no" />
            <col class="col-ver-sha" />
            <col class="col-ver-size" />
            <col class="col-ver-origin" />
            <col class="col-ver-user" />
            <col class="col-ver-time" />
            <col class="col-ver-ops" />
          </colgroup>
          <thead>
            <tr>
              <th>版本</th>
              <th>SHA-256</th>
              <th>大小</th>
              <th>来源</th>
              <th>入库人</th>
              <th>入库时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.id">
              <td class="nowrap">v{{ v.versionNo }}</td>
              <td class="mono">{{ v.sha256.slice(0, 12) }}</td>
              <td class="nowrap">{{ fmtSize(v.fileSize) }}</td>
              <td class="nowrap"><span class="badge badge-muted badge-clip" :title="v.originLabel">{{ v.originLabel }}</span></td>
              <td>{{ v.createdByName }}</td>
              <td class="nowrap">{{ fmtTime(v.createdAt) }}</td>
              <td class="nowrap">
                <button v-if="canPreview" class="btn btn-sm" @click="openVersionPreview(v)">预览</button>
                <span v-else class="text-muted">无预览权限</span>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <AppEmpty v-else compact title="暂无已入库的文件版本" description="归档前需至少形成一次文件版本（保存后自动入库或上传导出件）。" />
      </section>
    </template>

    <section class="card" v-else-if="!loading">
      <p class="text-muted" v-if="forbidden">该档案为受限访问，您没有查看权限。若需借阅，请在「借阅管理」提交申请，审核通过后将获得查看与下载授权。</p>
      <p class="text-muted" v-else>未找到该档案，可能已被删除或地址有误。</p>
      <div class="actions">
        <button class="btn" @click="router.push('/archives')">返回列表</button>
        <button v-if="forbidden && canRequestBorrow" class="btn btn-primary" @click="router.push('/borrow')">前往借阅</button>
      </div>
    </section>

    <!-- 在线预览弹窗：字节经受控接口获取，PDF/DOCX 由 JitWord-Preview SDK 渲染 -->
    <ArchivePreviewDialog
      v-if="previewTarget"
      :key="previewTarget.routePath"
      :name="previewTarget.name"
      :extension="previewTarget.extension"
      :file-size="previewTarget.fileSize"
      :route-path="previewTarget.routePath"
      :source-hit="previewTarget.sourceHit"
      :sdk-url="jitword?.previewSdkUrl"
      :can-download="canDownload && !!previewTarget.file"
      @close="closePreview"
      @download="downloadPreviewTarget"
    />
  </div>
</template>

<style scoped>
.page-title { font-size: 20px; }
.page-desc { margin: 0 0 20px; }
.link { color: var(--color-primary); cursor: pointer; }
.mono { font-family: Consolas, Monaco, monospace; font-size: 13px; }
.remarks { margin-top: 12px; color: var(--text-body); font-size: 14px; }
.actions { display: flex; gap: 12px; align-items: center; margin-top: 16px; }
.push-right { margin-left: auto; }
.edit-file-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 12px 0; }
.edit-file-title { font-size: 12px; white-space: nowrap; }
.edit-file-select { width: 260px; flex-shrink: 0; }
.edit-file-row .hint-inline { flex: 1; min-width: 200px; }
.version-actions-block { margin: 14px 0; }
.version-target-title { display: block; margin-bottom: 4px; font-size: 12px; }
.version-actions { display: flex; align-items: center; flex-wrap: nowrap; gap: 12px; }
.version-target { width: 220px; flex-shrink: 0; }
/* 下拉框与入库按钮在任何显示尺寸下都不折行；说明文字窄屏时收缩并截断（悬停可看全文） */
.version-actions :deep(.btn) { white-space: nowrap; flex-shrink: 0; }
.hint-inline { flex: 1; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* 附件表格：固定列宽 + 窄屏横向滚动，格式徽章与操作按钮不折行 */
.tbl-attach { table-layout: fixed; min-width: 820px; }
.col-att-format { width: 80px; }
.col-att-size { width: 90px; }
.col-att-uploader { width: 100px; }
.col-att-time { width: 160px; }
.col-att-ops { width: 210px; }
/* 正文索引表格：状态列按最长标签「扫描件（未启用 OCR）」预留，不随窗口压缩 */
.tbl-index { table-layout: fixed; min-width: 1000px; }
.col-idx-format { width: 80px; }
.col-idx-ver { width: 100px; }
.col-idx-status { width: 180px; }
.col-idx-scale { width: 90px; }
.col-idx-note { width: 200px; }
.col-idx-time { width: 160px; }
/* 版本表格：来源徽章超长（「在线编辑自动入库（导出件）」）时单行省略，title 看全文 */
.tbl-ver { table-layout: fixed; min-width: 960px; }
.col-ver-no { width: 60px; }
.col-ver-sha { width: 130px; }
.col-ver-size { width: 90px; }
.col-ver-origin { width: 150px; }
.col-ver-user { width: 100px; }
.col-ver-time { width: 160px; }
.col-ver-ops { width: 110px; }
.nowrap { white-space: nowrap; }
/* 徽章超长文本截断：保持单行圆角外观，全文由 title 提供 */
.badge-clip { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: middle; }

/* 移动端：按钮换行、表格横向滚动 */
@media (max-width: 767px) {
  .actions { flex-wrap: wrap; gap: 10px; }
  .version-target { width: 200px; }
  .edit-file-row { align-items: flex-start; }
  .edit-file-select { width: 100%; }
}
</style>
