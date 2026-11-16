<script setup lang="ts">
/**
 * 文件在线预览弹窗（JitWord-Preview SDK）。
 * - 字节一律来自登录态受控接口（api.getBlob），服务端完成授权与真实格式判定；
 * - DOCX/XLSX/PPTX/OFD/PDF/TXT/MD/HTML 交给 SDK 在页面内解析渲染
 *   （懒加载，文件名用于识别格式）；
 * - 位图 SDK 不支持，用 <img> 通道展示（同一弹窗内交互一致）；
 * - 超过 SDK 上限（普通 50MB / 文本类 10MB）、格式不支持、渲染失败均如实报错。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { lockBodyScroll } from './ui/overlay';
import {locateRenderedSource} from '../lib/previewSource';
import type {AgentSourceHit} from '../types';
import {
  DEFAULT_PREVIEW_SDK_URL,
  PREVIEW_NATIVE_IMAGE_EXTS,
  PREVIEW_SDK_EXTS,
  PREVIEW_SDK_MAX_BYTES,
  PREVIEW_SDK_TEXT_EXTS,
  PREVIEW_SDK_TEXT_MAX_BYTES,
  ensurePreviewSdk,
  previewErrorMessage,
  previewProgressText,
  type PreviewSdkError,
  type PreviewSdkInstance,
  type PreviewSdkProgress,
} from '../lib/previewSdk';

const props = defineProps<{
  name: string;
  extension: string;
  fileSize: number;
  /** 受控字节流接口路径（/archive-files/:id/preview 或版本预览路径）。 */
  routePath: string;
  /** 预览 SDK 地址（后端 /jitword/status 提供）；缺省回落到官方 CDN。 */
  sdkUrl?: string;
  /** 是否允许下载原文件（与档案级授权一致）。 */
  canDownload?: boolean;
  sourceHit?:AgentSourceHit;
}>();

const emit = defineEmits<{ close: []; download: [] }>();

const ext = computed(() => String(props.extension || '').toLowerCase());
const isImage = computed(() => (PREVIEW_NATIVE_IMAGE_EXTS as readonly string[]).includes(ext.value));
/** 纯 TXT 在弹窗内直接解码并按行展示（保留命中行定位能力）。 */
const isText=computed(()=>ext.value==='txt');
/** SDK 文本类格式统一受 10MB 上限约束。 */
const isSdkText = computed(() => (PREVIEW_SDK_TEXT_EXTS as readonly string[]).includes(ext.value));
const textLines=ref<Array<{number:number;text:string;hit:boolean}>>([]);
const textWindow=ref('');
const BADGE_LABELS: Record<string, string> = {
  pdf: 'PDF 文档',
  docx: 'Word 文档',
  xlsx: 'Excel 表格',
  pptx: 'PPT 演示文稿',
  ofd: 'OFD 版式文档',
  txt: '文本文件',
  md: 'Markdown 文档',
  html: '网页文档',
  jpg: '图片',
  jpeg: '图片',
  png: '图片',
  gif: '图片',
  bmp: '图片',
};
const badgeLabel = computed(() => BADGE_LABELS[ext.value] ?? (ext.value ? ext.value.toUpperCase() : '未知格式'));

const state = ref<'loading' | 'ok' | 'error'>('loading');
const loadingText = ref('正在准备预览…');
const progressText = ref('');
const errorText = ref('');
const blobUrl = ref('');
const hostRef = ref<HTMLElement | null>(null);

let preview: PreviewSdkInstance | null = null;
let sourceObserver:MutationObserver|null=null;
let sourceTimer:ReturnType<typeof setTimeout>|undefined;
const sourceLocated=ref(false);
let objectUrl = '';
let disposed = false;
let unlockScroll: (() => void) | null = null;

/** 释放 SDK 实例与 blob 地址（重试与关闭都走这里，避免多实例叠加）。 */
function release() {
  sourceObserver?.disconnect();sourceObserver=null;clearTimeout(sourceTimer);sourceLocated.value=false;
  if (preview) {
    try {
      preview.destroy();
    } catch {
      /* 实例已销毁 */
    }
    preview = null;
  }
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = '';
  }
  blobUrl.value = '';
  textLines.value=[];textWindow.value='';
}

function close() {
  release();
  emit('close');
}

function fail(message: string) {
  errorText.value = message;
  progressText.value = '';
  state.value = 'error';
}

async function boot() {
  release();
  state.value = 'loading';
  errorText.value = '';
  progressText.value = '';

  if (!isImage.value) {
    if (isSdkText.value && props.fileSize > PREVIEW_SDK_TEXT_MAX_BYTES) {
      fail('文本文件超过 10MB，在线预览不支持，请下载原文件查看');
      return;
    }
    if (props.fileSize > PREVIEW_SDK_MAX_BYTES) {
      fail('文件大小超过 50MB，在线预览不支持，请下载原文件查看');
      return;
    }
  }
  loadingText.value = isImage.value ? '正在读取图片…' : '正在读取文件…';

  try {
    // 预检：服务端按会话授权 + 真实字节判定，失败原因（403/415）原样展示
    const blob = await api.getBlob(props.routePath);
    if (disposed) return;

    if(isText.value){
      if(blob.size>PREVIEW_SDK_TEXT_MAX_BYTES){fail('文本超过10MB，请下载原文件查看');return;}
      const bytes=new Uint8Array(await blob.arrayBuffer());
      if(disposed)return;
      let text:string;
      if(bytes[0]===0xff&&bytes[1]===0xfe)text=new TextDecoder('utf-16le').decode(bytes);
      else if(bytes[0]===0xfe&&bytes[1]===0xff)text=new TextDecoder('utf-16be').decode(bytes);
      else {try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{text=new TextDecoder('gb18030').decode(bytes);}}
      const lines=text.split(/\r\n|\r|\n/u),from=Math.max(1,props.sourceHit?.posFrom??1),to=Math.max(from,props.sourceHit?.posTo??from);
      const first=Math.max(0,from-11),last=Math.min(lines.length,Math.max(to+10,first+100));
      textLines.value=lines.slice(first,last).map((text,index)=>({number:first+index+1,text,hit:!!props.sourceHit&&first+index+1>=from&&first+index+1<=to}));
      textWindow.value=`第 ${first+1}–${last} 行，共 ${lines.length} 行`;
      state.value='ok';await nextTick();hostRef.value?.querySelector('.text-hit')?.scrollIntoView({block:'center'});return;
    }

    if (isImage.value) {
      objectUrl = URL.createObjectURL(blob);
      blobUrl.value = objectUrl;
      state.value = 'ok';
      return;
    }

    loadingText.value = '正在加载预览引擎…';
    const sdk = await ensurePreviewSdk(props.sdkUrl || DEFAULT_PREVIEW_SDK_URL);
    if (disposed) return;

    state.value = 'ok';
    await nextTick();
    if (!hostRef.value) {
      fail('预览区域初始化失败，请重试');
      return;
    }
    preview = sdk.createFilePreview(hostRef.value, {
      toolbar: true,
      dropzone: false,
      formats: [...PREVIEW_SDK_EXTS],
      onReady: () => {
        progressText.value = '';
      },
      onProgress: (info: PreviewSdkProgress) => {
        progressText.value = previewProgressText(info);
      },
      onError: (error: PreviewSdkError) => {
        fail(previewErrorMessage(error));
      },
    });
    progressText.value = '正在渲染文档…';
    await preview.open(blob, props.name);
    if(props.sourceHit && hostRef.value){
      const locate=()=>{if(!hostRef.value || !props.sourceHit)return;
        sourceLocated.value=locateRenderedSource(hostRef.value,props.sourceHit,ext.value);
        if(sourceLocated.value)sourceObserver?.disconnect();};
      locate();
      if(!sourceLocated.value){sourceObserver=new MutationObserver(locate);sourceObserver.observe(hostRef.value,{childList:true,subtree:true});
        sourceTimer=setTimeout(()=>sourceObserver?.disconnect(),5000);}
    }
  } catch (e) {
    if (disposed) return;
    if (e instanceof ApiError) {
      fail(e.message);
      return;
    }
    const msg = e instanceof Error && e.message ? e.message : '预览加载失败，请重试';
    fail(msg);
  }
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape') close();
}

onMounted(() => {
  unlockScroll = lockBodyScroll();
  window.addEventListener('keydown', onKeydown);
  void boot();
});

onBeforeUnmount(() => {
  disposed = true;
  release();
  window.removeEventListener('keydown', onKeydown);
  if (unlockScroll) {
    unlockScroll();
    unlockScroll = null;
  }
});
</script>

<template>
  <div
    class="preview-mask"
    role="dialog"
    aria-modal="true"
    aria-label="文件在线预览"
    @click.self="close"
  >
    <div class="preview-modal">
      <div class="preview-head">
        <span class="preview-title" :title="name">{{ name }}</span>
        <span class="badge badge-muted">{{ badgeLabel }}</span>
        <span class="preview-spacer"></span>
        <button v-if="canDownload" class="btn btn-sm" @click="emit('download')">下载</button>
        <button class="btn btn-sm" @click="close">关闭</button>
      </div>

      <div class="preview-body" :class="{'has-source':!!sourceHit || isText}">
        <aside v-if="state==='ok' && sourceHit" class="preview-source" aria-label="命中正文位置">
          <strong>命中位置：{{ sourceHit.locator }}</strong><span v-if="!isText"> · {{ sourceLocated ? '已定位原文' : '预览未提供可定位文本，请按上述位置核对' }}</span>
          <span v-if="sourceHit.pageNo"> · 第 {{ sourceHit.pageNo }} 页</span>
          <p>{{ sourceHit.text }}</p>
          <small v-if="!isText">请在文档中核对上述位置和摘录。</small>
        </aside>
        <div v-if="state === 'loading'" class="alert alert-info">{{ loadingText }}</div>
        <div v-else-if="state === 'error'" class="alert alert-error">
          <span>{{ errorText }}</span>
          <span class="preview-actions">
            <button class="btn btn-sm" @click="boot">重试</button>
            <button v-if="canDownload" class="btn btn-sm" @click="emit('download')">下载原文件</button>
          </span>
        </div>

        <img
          v-if="state === 'ok' && isImage"
          :src="blobUrl"
          :alt="name"
          class="preview-img"
          @error="fail('图片无法显示，请重试或下载查看')"
        />
        <div v-if="state==='ok' && isText" ref="hostRef" class="preview-text">
          <p>{{ textWindow }}</p>
          <pre><span v-for="line in textLines" :key="line.number" :class="{'text-hit':line.hit}"><span class="text-line-no">{{ line.number }}</span>{{ line.text }}{{ '\n' }}</span></pre>
        </div>
        <div v-else v-show="state === 'ok' && !isImage" ref="hostRef" class="preview-host"></div>

        <div v-if="state === 'ok' && progressText" class="preview-progress">{{ progressText }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-source { background:var(--bg-soft, #f1f5f9);color:var(--text-body,#334155);padding:12px 16px;border-radius:8px;margin-bottom:12px;max-height:180px;overflow:auto; }
.preview-source p { white-space:pre-wrap; margin:8px 0; }
.preview-text { overflow:auto; padding:12px; color:var(--text-body,#334155); }
.preview-text pre { white-space:pre-wrap;overflow-wrap:anywhere; }
.text-line-no { display:inline-block;min-width:3em;color:var(--text-muted,#64748b);user-select:none; }
.text-hit { background:#fbbf2440; }
.preview-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.preview-modal {
  background: #fff;
  border-radius: 12px;
  padding: 16px 20px;
  width: min(1080px, 94vw);
  height: min(86vh, 900px);
  display: flex;
  flex-direction: column;
}
.preview-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.preview-title {
  font-weight: 600;
  color: var(--text-title);
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}
.preview-spacer {
  flex: 1;
}
.preview-body {
  flex: 1;
  position: relative;
  overflow: auto;
  background: #f5f6fa;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.preview-body .alert {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 2;
  width: min(640px, 90%);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.preview-body.has-source { flex-direction:column;align-items:stretch;justify-content:flex-start; }
.has-source .preview-source { flex-shrink:0; margin:12px; }
.has-source .preview-host { flex:1; min-height:300px; height:auto; }
.has-source .preview-text { flex:1; }
.preview-actions {
  display: inline-flex;
  gap: 8px;
}
/* SDK 容器必须占满弹窗内容区，否则工具栏会挤在零高度里 */
.preview-host {
  width: 100%;
  height: 100%;
  min-height: 420px;
}
.preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
  margin: auto;
}
.preview-progress {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 12px;
  padding: 6px 12px;
  border-radius: 999px;
  pointer-events: none;
}

/* 移动端：全屏弹层，标题独占一行 */
@media (max-width: 767px) {
  .preview-modal {
    width: 100%;
    height: 100vh;
    height: 100dvh;
    border-radius: 0;
    padding: calc(10px + env(safe-area-inset-top)) 10px calc(10px + env(safe-area-inset-bottom));
  }
  .preview-head {
    gap: 8px;
  }
  .preview-title {
    max-width: none;
    flex: 1;
  }
  .preview-head .btn {
    padding: 7px 10px;
    min-height: 36px;
  }
  .preview-host {
    min-height: 0;
  }
}
</style>
