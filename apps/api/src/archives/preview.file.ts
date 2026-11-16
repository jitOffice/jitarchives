/**
 * 附件在线预览的安全格式判定（V1.0 多格式在线预览 + JitWord-Preview SDK）。
 * 原则：Content-Type 一律以磁盘真实字节（magic bytes）判定，绝不信任
 * 上传时客户端申报或库内登记的 contentType / extension；判定不了的一律
 * 按 octet-stream 附件处理，HTML、SVG、脚本等主动内容不可能被内联执行。
 *
 * 投递方式（delivery）：
 * - inline：浏览器原生能力可安全内联（PDF 查看器 / <img>）；
 * - sdk：JitWord-Preview 支持的文件（docx/xlsx/pptx/ofd/pdf/txt/md/html），
 *   浏览器不内联执行，仅以受控字节流下发给前端 SDK 在页面内解析渲染，
 *   Content-Type 固定 octet-stream；
 * - blocked：无安全预览通道（zip / tiff / 旧版 Office / 主动内容），一律 415。
 *
 * 与 SDK 同口径：OOXML 必须同时含 [Content_Types].xml 与 _rels/.rels，
 * OFD 必须含 ofd.xml 与 doc_<n>/document.xml；否则交前端后必然无法渲染。
 */
import * as fs from 'fs';
import * as path from 'path';

/** TIFF 头部标识字节：小端 "II" + 0x2a00，大端 "MM" + 0x002a（单字节比较）。 */
const TIFF_I = 0x49;
const TIFF_M = 0x4d;

export type PreviewKind =
  | 'pdf'
  | 'image'
  | 'tiff'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'ofd'
  | 'txt'
  | 'md'
  | 'html'
  | 'office'
  | 'archive'
  | 'generic';

/** 纯文本类格式（SDK 限制 10MB）：按扩展名判定，始终以 octet-stream 下发。 */
const SDK_TEXT_EXTENSIONS = new Set(['txt', 'md', 'html']);

/** 投递方式：inline 浏览器内联 / sdk 前端预览 SDK 解析 / blocked 拒绝。 */
export type PreviewDelivery = 'inline' | 'sdk' | 'blocked';

export interface PreviewFileType {
  kind: PreviewKind;
  delivery: PreviewDelivery;
  /** 可下发字节时的 Content-Type；blocked 为 null（按 octet-stream 附件处理）。 */
  mimeType: string | null;
}

/** 读取文件头 16 字节做格式判定；读取失败返回 null（由调用方转 404/500）。 */
export function detectPreviewFileType(filePath: string): PreviewFileType | null {
  let head: null | Uint8Array = null;
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(16);
    const read = fs.readSync(fd, buf, 0, 16, 0);
    head = buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
  return classifyHead(head!, filePath);
}

export function classifyHead(head: Uint8Array, filePath?: string): PreviewFileType {
  const t = (mimeType: string, kind: PreviewKind): PreviewFileType => ({
    kind,
    delivery: 'inline',
    mimeType,
  });
  const sdk = (kind: PreviewKind): PreviewFileType => ({
    kind,
    delivery: 'sdk',
    // 绝不下发文档官方 MIME：避免文档被浏览器/插件以主动方式接管，只当字节流。
    mimeType: 'application/octet-stream',
  });
  const blocked = (kind: PreviewKind): PreviewFileType => ({
    kind,
    delivery: 'blocked',
    mimeType: null,
  });
  if (head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) {
    return t('application/pdf', 'pdf'); // %PDF
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return t('image/jpeg', 'image'); // JPEG SOI
  }
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return t('image/png', 'image');
  }
  if (
    head.length >= 6 &&
    head[0] === 0x47 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x38 &&
    (head[4] === 0x37 || head[4] === 0x39) &&
    head[5] === 0x61
  ) {
    return t('image/gif', 'image'); // GIF87a / GIF89a
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return t('image/bmp', 'image'); // BM
  }
  if (
    head.length >= 4 &&
    ((head[0] === TIFF_I && head[1] === TIFF_I && head[2] === 0x2a && head[3] === 0x00) ||
      (head[0] === TIFF_M && head[1] === TIFF_M && head[2] === 0x00 && head[3] === 0x2a))
  ) {
    return blocked('tiff'); // TIFF：仅 Chrome 原生支持，明确降级
  }
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    head[2] === 0x03 &&
    head[3] === 0x04
  ) {
    // ZIP 容器：按中央目录条目识别 SDK 支持的 OOXML / OFD；
    // 普通压缩包、结构不符或损坏包一律拒绝，绝不靠扩展名放行。
    const kind = filePath ? detectSdkPackageKind(filePath) : null;
    return kind ? sdk(kind) : blocked('archive');
  }
  if (head.length >= 8 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    return blocked('office'); // OLE2（旧版 .doc/.xls/.ppt）：无安全预览通道
  }
  // 纯文本类：按扩展名放行，但仍走 octet-stream 附件通道，绝不以 text/html 内联。
  const ext = filePath ? path.extname(filePath).replace(/^\./, '').toLowerCase() : '';
  if (SDK_TEXT_EXTENSIONS.has(ext)) return sdk(ext as PreviewKind);
  // 兜底：主动内容（HTML/SVG 等）与其他未知格式一律不预览
  return blocked('generic');
}

/** EOCD 签名与中央目录文件头签名（ZIP 规范）。 */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
/** EOCD 固定长度 + 最长注释（65535），尾部读取窗口上限。 */
const EOCD_SCAN = 22 + 65535;

/**
 * 读取 ZIP 中央目录条目名（零依赖，仅读文件尾部的 EOCD 与中央目录）。
 * 解析不了（非 ZIP / Zip64 / 越界）返回空数组，由调用方按最保守结果处理。
 */
export function readZipEntryNames(filePath: string): string[] {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 22) return [];
    const tailLen = Math.min(size, EOCD_SCAN);
    const tailStart = size - tailLen;
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, tailStart);

    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return [];

    const total = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    // Zip64 与越界偏移不解析（不猜、不降级放行）
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) return [];
    if (cdOffset >= size || cdSize === 0) return [];
    const cdLen = Math.min(cdSize, size - cdOffset);
    const cd = Buffer.alloc(cdLen);
    fs.readSync(fd, cd, 0, cdLen, cdOffset);

    const names: string[] = [];
    let p = 0;
    for (let i = 0; i < total && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CEN_SIG) break;
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const next = p + 46 + nameLen + extraLen + commentLen;
      if (next > cd.length) break;
      names.push(cd.toString('utf8', p + 46, p + 46 + nameLen));
      p = next;
    }
    return names;
  } catch {
    return [];
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

/**
 * 按 ZIP 中央目录识别 JitWord-Preview 支持的包格式（与 SDK 判定同口径）：
 * - OOXML 需同时含 [Content_Types].xml 与 _rels/.rels，再看主文档条目；
 * - OFD 需含 ofd.xml 且存在 doc_<n>/document.xml。
 * 条目名统一转小写并按 POSIX 分隔符比较。
 */
export function detectSdkPackageKind(filePath: string): PreviewKind | null {
  const entries = new Set(
    readZipEntryNames(filePath).map((name) =>
      name.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase(),
    ),
  );
  if (entries.has('[content_types].xml') && entries.has('_rels/.rels')) {
    if (entries.has('word/document.xml')) return 'docx';
    if (entries.has('xl/workbook.xml')) return 'xlsx';
    if (entries.has('ppt/presentation.xml')) return 'pptx';
  }
  if (
    entries.has('ofd.xml') &&
    Array.from(entries).some((name) => /^doc_\d+\/document\.xml$/.test(name))
  ) {
    return 'ofd';
  }
  return null;
}

/** 是否为 Word OOXML 包（供既有调用方复用，与 SDK 同口径）。 */
export function isWordOoxml(filePath: string): boolean {
  return detectSdkPackageKind(filePath) === 'docx';
}

/** 内联展示时的安全文件名（仅保留基础字符，其余替换为下划线）。 */
export function safeInlineName(name: string): string {
  return String(name || 'file').replace(/[^\w.\-]/g, '_').slice(0, 120);
}
