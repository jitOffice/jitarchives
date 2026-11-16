/**
 * JitWord-Preview 文件预览 SDK 加载器（纯前端渲染，零后端转换）。
 * - 懒加载：首次打开预览时才注入 <script>，不拖慢首屏；
 * - 地址来自后端 /jitword/status 的 previewSdkUrl：默认厂商 CDN，可用环境变量
 *   JITWORD_PREVIEW_SDK_URL 切换到自托管目录（内网/离线部署）；
 * - 只接受 http(s) 绝对地址或站点内相对路径，其余一律拒绝（防被改成主动协议地址）。
 */

/** SDK 内置可渲染的格式（位图不在其中，图片仍走 <img> 通道）。 */
export const PREVIEW_SDK_EXTS = ['docx', 'xlsx', 'pptx', 'ofd', 'pdf', 'txt', 'md', 'html'] as const;
/** SDK 不支持的位图（由预览弹窗用 <img> 展示）。 */
export const PREVIEW_NATIVE_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'bmp'] as const;
/** 全部可预览格式（SDK 格式 + 浏览器原生图片通道），预览入口统一以此为准。 */
export const PREVIEW_EXTS: readonly string[] = [...PREVIEW_SDK_EXTS, ...PREVIEW_NATIVE_IMAGE_EXTS];
/** SDK 文本类格式（TXT / MD / HTML）单文件上限 10MB（官方错误码 text-file-too-large）。 */
export const PREVIEW_SDK_TEXT_EXTS = ['txt', 'md', 'html'] as const;
export const PREVIEW_SDK_TEXT_MAX_BYTES = 10 * 1024 * 1024;
/** SDK 单文件上限 50MB（官方错误码 file-too-large），超出不发起请求。 */
export const PREVIEW_SDK_MAX_BYTES = 50 * 1024 * 1024;
/** 后端未返回地址时的兜底（与后端默认值一致）。 */
export const DEFAULT_PREVIEW_SDK_URL = 'https://jitword.com/preview_sdk/file-preview.bundle.js';

export interface PreviewSdkError {
  code: string;
  title?: string;
  detail?: string;
}

export interface PreviewSdkProgress {
  phase: 'download' | 'inspect' | 'render';
  loaded?: number;
  total?: number;
}

export interface PreviewSdkInstance {
  open(input: Blob | File | ArrayBuffer, nameOrOptions?: string): Promise<void>;
  close(): void;
  destroy(): void;
  preload(...formats: string[]): void;
  on(event: string, cb: (payload: any) => void): () => void;
  off(event: string, cb: (payload: any) => void): void;
}

export interface PreviewSdkOptions {
  toolbar?: boolean;
  dropzone?: boolean;
  formats?: string[];
  assetPath?: string;
  onReady?: (info: { format: string; fileName: string }) => void;
  onError?: (error: PreviewSdkError) => void;
  onProgress?: (info: PreviewSdkProgress) => void;
  onPageChange?: (info: { page: number; total: number }) => void;
}

interface PreviewSdkGlobal {
  version?: string;
  createFilePreview(container: HTMLElement | string, options?: PreviewSdkOptions): PreviewSdkInstance;
  setMessages?: (messages: Record<string, { title?: string; detail?: string }>) => unknown;
}

declare global {
  interface Window {
    JitWordFilePreview?: PreviewSdkGlobal;
  }
}

/** 中文错误文案：覆盖官方默认英文提示，与全站文案风格保持一致。 */
const MESSAGES: Record<string, { title: string; detail: string }> = {
  'unsupported-extension': { title: '不支持预览该格式', detail: '预览引擎不支持该文件格式，请下载后查看' },
  'legacy-doc': { title: '旧版 Word 文档', detail: '旧版 .doc 不支持在线预览，请另存为 .docx 后重新上传' },
  'file-too-large': { title: '文件过大', detail: '在线预览仅支持 50MB 以内的文件，请下载后查看' },
  'text-file-too-large': { title: '文件过大', detail: '文本文件超过 10MB，无法在线预览，请下载后查看' },
  'text-invalid': { title: '文本无法解析', detail: '文件内容无法安全解析，请下载后查看' },
  'invalid-package': { title: '文件已损坏', detail: '文档结构非法或已损坏，请下载后核对或重新上传' },
  'package-type-mismatch': { title: '格式与内容不一致', detail: '文件扩展名与实际内容不一致，出于安全考虑拒绝预览' },
  'zip64-unsupported': { title: '暂不支持的文件结构', detail: '该压缩结构暂不支持预览，请下载后查看' },
  'unsafe-package': { title: '未通过安全检查', detail: '文档未通过安全检查，请下载后自行确认' },
  'document-too-complex': { title: '文档过于复杂', detail: '文档结构过于复杂，暂时无法在线渲染，请下载后查看' },
  'layout-incompatible': { title: '版式不兼容', detail: '文档版式暂不兼容预览引擎，请下载后查看' },
  'renderer-failed': { title: '渲染失败', detail: '文档无法完成渲染，请下载后查看' },
  'fetch-failed': { title: '文件读取失败', detail: '预览引擎加载或文件读取失败，请检查网络后重试' },
  'fetch-aborted': { title: '预览已中断', detail: '预览加载被中断，请重试' },
  'url-scheme-unsupported': { title: '地址不受支持', detail: '仅支持 http/https 地址的预览' },
  'url-format-unknown': { title: '无法识别格式', detail: '无法识别该文件格式，请下载后查看' },
};

/** 只允许 http(s) 绝对地址或站点内相对路径。 */
function safeSdkUrl(url: string): string {
  const text = String(url || '').trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/') && !text.startsWith('//')) return text;
  return '';
}

/** 错误对象 → 中文原因（SDK 未给 title/detail 时也有兜底）。 */
export function previewErrorMessage(error: Partial<PreviewSdkError> | null | undefined): string {
  const code = String(error?.code ?? '');
  const hit = MESSAGES[code];
  if (hit) return `${hit.title}：${hit.detail}`;
  if (error?.title) return error.detail ? `${error.title}：${error.detail}` : error.title;
  return '预览加载失败，请重试或下载查看';
}

/** 进度阶段 → 中文进度提示。 */
export function previewProgressText(info: PreviewSdkProgress): string {
  if (info.phase === 'download') {
    if (info.total && info.loaded) {
      const percent = Math.min(100, Math.round((info.loaded / info.total) * 100));
      return `正在读取文件…${percent}%`;
    }
    return '正在读取文件…';
  }
  if (info.phase === 'inspect') return '正在校验文件…';
  return '正在渲染文档…';
}

const SCRIPT_ATTR = 'data-jitword-preview';

let pending: Promise<PreviewSdkGlobal> | null = null;
let pendingUrl = '';

/** 覆盖 SDK 中文文案（失败不影响预览本身）。 */
async function applyMessages(sdk: PreviewSdkGlobal): Promise<void> {
  try {
    await Promise.resolve(sdk.setMessages?.(MESSAGES));
  } catch {
    /* 文案覆盖失败时保留 SDK 默认提示 */
  }
}

/**
 * 懒加载预览 SDK（单例 + 并发去重）。同一地址只注入一次 script；
 * 已加载但地址变更时重新注入（自托管与 CDN 切换场景）。
 */
export function ensurePreviewSdk(url: string): Promise<PreviewSdkGlobal> {
  const target = safeSdkUrl(url) || DEFAULT_PREVIEW_SDK_URL;
  if (window.JitWordFilePreview && pendingUrl === target) {
    void applyMessages(window.JitWordFilePreview);
    return Promise.resolve(window.JitWordFilePreview);
  }
  if (pending && pendingUrl === target) return pending;

  const task = new Promise<PreviewSdkGlobal>((resolve, reject) => {
    const finish = () => {
      if (!window.JitWordFilePreview) {
        reject(new Error('预览引擎未就绪，请重试'));
        return;
      }
      void applyMessages(window.JitWordFilePreview);
      resolve(window.JitWordFilePreview);
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[${SCRIPT_ATTR}]`);
    if (existing) {
      if (window.JitWordFilePreview) {
        finish();
        return;
      }
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => reject(new Error('预览引擎加载失败，请检查网络或联系管理员')), {
        once: true,
      });
      return;
    }
    const script = document.createElement('script');
    script.src = target;
    script.async = true;
    script.setAttribute(SCRIPT_ATTR, '1');
    script.onload = finish;
    script.onerror = () => reject(new Error('预览引擎加载失败，请检查网络或联系管理员'));
    document.head.appendChild(script);
  });

  pending = task;
  pendingUrl = target;
  task.catch(() => {
    if (pending === task) {
      pending = null;
      pendingUrl = '';
    }
  });
  return task;
}
