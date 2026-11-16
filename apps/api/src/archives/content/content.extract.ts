/**
 * 附件正文提取调度器（第二阶段）：按磁盘真实字节判定格式后分发到具体提取器。
 *
 * 原则（与需求「不允许把文件名/档案标题当作正文」对应）：
 * - 只认磁盘字节特征（magic bytes），不信任库内登记的扩展名与客户端申报的 Content-Type；
 * - 每个提取器必须返回明确状态：拿不到真实文本就返回 no_text / unsupported / corrupt / encrypted / scanned，
 *   绝不返回由文件名或标题拼出来的「伪正文」；
 * - 本阶段不做 OCR：图片、扫描件 PDF、压缩包、旧版 .doc 一律标注为暂不支持并给出原因。
 */
import * as fs from 'fs';
import PizZip from 'pizzip';
import { ContentBlock, ExtractResult } from './content.types';
import { extractPdfContent } from './content.pdf';
import { extractOfficeContent } from './content.office';

/** 单文件参与索引的正文规模上限（防御超大文档拖垮检索与问答）。 */
export const MAX_EXTRACTED_CHARS = 400000;

const NOT_ZIP_MSG = '文件不是有效的 ZIP/OOXML 包';

export function emptyResult(
  extractor: ExtractResult['extractor'],
  status: ExtractResult['status'],
  message: string,
): ExtractResult {
  return { status, message, extractor, blocks: [], truncated: false };
}

/**
 * 提取入口：filePath 必须来自受控存储层（FileStorage.resolveStored 的返回值）。
 * extension 仅作为「无 magic 可辨」时的辅助判断（如纯文本），可信格式一律按字节判定。
 */
export function extractFileContent(filePath: string, extension: string): ExtractResult {
  let buf: Buffer;
  try {
    if (fs.statSync(filePath).size > 40 * 1024 * 1024) return emptyResult('', 'unsupported', '文件超过40MB正文提取上限');
    buf = fs.readFileSync(filePath);
  } catch {
    return emptyResult('', 'failed', '文件读取失败');
  }
  const ext = (extension || '').toLowerCase();
  if (isZipMagic(buf)) {
    const office = extractOfficeContent(buf);
    if (office) return office;
    return extractDocxContent(buf);
  }
  if (isPdfMagic(buf) || ext === 'pdf') return extractPdfContent(filePath);
  if (isOle2Magic(buf)) {
    return emptyResult(
      '',
      'unsupported',
      '旧版 .doc/.xls/.ppt 或加密的 Office（OLE 二进制）暂不支持正文提取，请另存为未加密的 DOCX/XLSX/PPTX 后重新上传',
    );
  }
  if (isImageMagic(buf)) {
    return emptyResult('', 'unsupported', '图片类附件需 OCR 才能提取正文，本阶段未启用 OCR');
  }
  if (ext === 'txt' || looksLikeText(buf)) {
    return extractTextContent(buf);
  }
  return emptyResult('', 'unsupported', '该格式暂不支持正文提取（当前支持 DOCX、PDF、TXT、XLSX、PPTX）');
}

// ==================== DOCX ====================

/**
 * DOCX 正文：解 word/document.xml，按 <w:p> 段落切块（表格单元格内段落同样计入段落序号）。
 * 加密的 docx（Word「常规访问设置」）包内是 EncryptedPackage/EncryptionInfo，明确返回 encrypted。
 */
export function extractDocxContent(buf: Buffer): ExtractResult {
  let zip: PizZip;
  try {
    zip = new PizZip(buf);
  } catch {
    return emptyResult('docx', 'corrupt', NOT_ZIP_MSG);
  }
  const names = Object.keys(zip.files ?? {});
  if (names.some((n) => /EncryptedPackage|EncryptionInfo/i.test(n))) {
    return emptyResult('docx', 'encrypted', '该 Word 文档已加密（需要密码打开），无法读取正文');
  }
  const part = zip.file('word/document.xml');
  if (!part) {
    return emptyResult(
      'docx',
      'corrupt',
      `${NOT_ZIP_MSG}（包内缺少 Word 主文档 word/document.xml）`,
    );
  }
  let xml: string;
  try {
    const node = part as unknown as { asNodeBuffer?: () => Buffer; asText?: () => string };
    xml = typeof node.asNodeBuffer === 'function'
      ? node.asNodeBuffer().toString('utf8')
      : node.asText!();
  } catch {
    return emptyResult('docx', 'corrupt', NOT_ZIP_MSG);
  }
  // 正文主体只在 <w:body> 内；w:instrText（域代码）与 w:delText（修订删除）不属于可见正文
  const body = /<w:body[\s\S]*?<\/w:body>/.exec(xml)?.[0] ?? xml;
  const blocks: ContentBlock[] = [];
  let total = 0;
  let truncated = false;
  const paraRe = /<w:p[ \t/>][\s\S]*?<\/w:p>|<w:p\/>/g;
  let m: RegExpExecArray | null;
  let index = 0;
  let section: string | undefined;
  while ((m = paraRe.exec(body)) !== null) {
    index += 1;
    let text = paragraphText(m[0]);
    if (!text) continue;
    if (/<w:pStyle\b[^>]*w:val=["'](?:Heading\d*|Title|标题\d*)["']/i.test(m[0])) section = text.slice(0, 120);
    if (total + text.length > MAX_EXTRACTED_CHARS) {
      truncated = true;
      text = text.slice(0, MAX_EXTRACTED_CHARS - total);
    }
    total += text.length;
    blocks.push({ text, unit: 'paragraph', from: index, to: index, page: null, section });
    if (truncated) break;
    if (blocks.length >= 20000) {
      truncated = true;
      break;
    }
  }
  if (!blocks.length) {
    return emptyResult('docx', 'no_text', '该 Word 文档没有可提取的文字内容（可能仅含图片），本阶段未启用 OCR');
  }
  return { status: 'indexed', message: '', extractor: 'docx', blocks, truncated };
}

/** 段落内可见文本：制表符转空格、换行符转空格、去标签、还原实体。 */
function paragraphText(xml: string): string {
  const cleaned = xml
    .replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
    .replace(/<w:delText[\s\S]*?<\/w:delText>/g, '')
    .replace(/<w:tab[^>]*\/>/g, ' ')
    .replace(/<w:br[^>]*\/>/g, ' ');
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) out += decodeXmlEntities(m[1]);
  return out.replace(/\s+/g, ' ').trim();
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_s, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_s, d) => safeCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// ==================== TXT ====================

/**
 * 纯文本：按 BOM → UTF-8 → GB18030/GBK → latin1 顺序试解码。
 * 二进制特征（大量 NUL/控制字符）判为 corrupt，避免把图片/压缩包当文本索引。
 */
export function extractTextContent(buf: Buffer): ExtractResult {
  if (buf.length === 0) return emptyResult('txt', 'no_text', '文本文件为空');
  let control = 0;
  const probe = Math.min(buf.length, 8192);
  for (let i = 0; i < probe; i += 1) {
    const b = buf[i];
    if (b === 0x00) {
      control += 1;
    } else if (b < 0x09 && b !== 0x0d && b !== 0x0a) control += 0.5;
  }
  const utf16Bom = (buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff);
  if (!utf16Bom && control / probe > 0.02) {
    return emptyResult('txt', 'corrupt', '文件含大量二进制内容，不是可提取的纯文本');
  }
  const text = decodeText(buf);
  if (!text.trim()) return emptyResult('txt', 'no_text', '文本文件没有可提取的文字内容');
  const lines = text.split(/\r\n|\r|\n/);
  const blocks: ContentBlock[] = [];
  let total = 0;
  let truncated = false;
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (total + line.length > MAX_EXTRACTED_CHARS) {
      truncated = true;
      line = line.slice(0, MAX_EXTRACTED_CHARS - total);
    }
    total += line.length;
    blocks.push({ text: line, unit: 'line', from: i + 1, to: i + 1, page: null });
    if (truncated) break;
    if (blocks.length >= 40000) {
      truncated = true;
      break;
    }
  }
  if (!blocks.length) return emptyResult('txt', 'no_text', '文本文件没有可提取的文字内容');
  return { status: 'indexed', message: '', extractor: 'txt', blocks, truncated };
}

function decodeText(buf: Buffer): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const body = buf.subarray(2);
    let out = '';
    for (let i = 0; i + 1 < body.length; i += 2) out += String.fromCharCode(body.readUInt16BE(i));
    return out;
  }
  const utf8 = buf.toString('utf8');
  // Buffer.toString('utf8') 对非法序列产出 U+FFFD：出现即说明不是 UTF-8，再尝试中文旧编码
  if (!utf8.includes('\uFFFD')) return utf8;
  for (const encoding of ['gb18030', 'gbk', 'big5']) {
    try {
      const decoded = new TextDecoder(encoding).decode(buf).replace(/\uFFFD/g, '');
      if (decoded.trim()) return decoded;
    } catch {
      /* 当前 Node 未带该编码则继续下一个 */
    }
  }
  return utf8.replace(/\uFFFD/g, '');
}

// ==================== 字节特征 ====================

function isZipMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

function isPdfMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46;
}

function isOle2Magic(buf: Buffer): boolean {
  return (
    buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
  );
}

function isImageMagic(buf: Buffer): boolean {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return true; // PNG
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // GIF
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return true; // BM
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a))
  ) {
    return true; // TIFF
  }
  return false;
}

function looksLikeText(buf: Buffer): boolean {
  const probe = Math.min(buf.length, 2048);
  for (let i = 0; i < probe; i += 1) {
    const b = buf[i];
    if (b === 0x00) return false;
  }
  const text = decodeText(buf);
  const printable = [...text].filter((ch) => {
    const code = ch.codePointAt(0)!;
    return code >= 0x20 || ch === '\n' || ch === '\r' || ch === '\t';
  }).length;
  return text.length > 0 && printable / text.length > 0.85;
}
