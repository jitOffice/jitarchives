/** OOXML text only: cached spreadsheet values and visible slide paragraphs. No macro/formula execution. */
import * as path from 'node:path';
import PizZip from 'pizzip';
import { ContentBlock, ExtractResult } from './content.types';
import { decodeXmlEntities, emptyResult, MAX_EXTRACTED_CHARS } from './content.extract';

const attr = (xml: string, name: string) => decodeXmlEntities(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`).exec(xml)?.[1] ?? '');
const tags = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'g'))].map(m => m[1]);
const texts = (xml: string, tag: string) => tags(xml, tag).map(decodeXmlEntities).join('');
function target(base: string, value: string): string {
  const resolved = value.startsWith('/') ? value.slice(1) : path.posix.normalize(`${base}/${value}`);
  if (resolved.startsWith('../') || resolved.includes('\\') || resolved.includes(':')) throw new Error('Invalid relationship');
  return resolved;
}
function relations(xml: string, base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
    if (attr(m[0], 'TargetMode') !== 'External') out.set(attr(m[0], 'Id'), target(base, attr(m[0], 'Target')));
  }
  return out;
}
export function extractOfficeContent(buf: Buffer): ExtractResult | null {
  let zip: PizZip;
  try { zip = new PizZip(buf); } catch { return null; }
  let expanded = 0;
  for (const part of Object.values(zip.files)) expanded += Number((part as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
  if (Object.keys(zip.files).length > 10000 || expanded > 64 * 1024 * 1024) return emptyResult('', 'failed', 'Office 包解压规模超出安全上限');
  const read = (name: string) => zip.file(name)?.asText() ?? '';
  const workbook = read('xl/workbook.xml'), presentation = read('ppt/presentation.xml');
  if (!workbook && !presentation) {
    // OFD 也是 ZIP 容器：明确告知不支持正文提取，避免被误判为损坏的 DOCX。
    const names = Object.keys(zip.files);
    if (names.some((name) => name.toLowerCase() === 'ofd.xml')) {
      return emptyResult('', 'unsupported', 'OFD 版式文档暂不支持正文提取，可在预览中查看版式内容');
    }
    return null;
  }
  const extractor = workbook ? 'xlsx' : 'pptx';
  const blocks: ContentBlock[] = [];
  let chars = 0, truncated = false;
  const push = (block: ContentBlock) => {
    const available = MAX_EXTRACTED_CHARS - chars;
    if (available <= 0 || blocks.length >= 20000) { truncated = true; return false; }
    if (block.text.length > available) { block.text = block.text.slice(0, available); truncated = true; }
    if (block.text.trim()) { blocks.push(block); chars += block.text.length; }
    return !truncated;
  };
  try {
    if (workbook) {
      const shared = tags(read('xl/sharedStrings.xml'), 'si').map(si => texts(si, 't'));
      const rels = relations(read('xl/_rels/workbook.xml.rels'), 'xl');
      sheets: for (const sheet of workbook.matchAll(/<sheet\b[^>]*\/?\s*>/g)) {
        const section = `工作表「${attr(sheet[0], 'name')}」`;
        const xml = read(rels.get(attr(sheet[0], 'r:id')) ?? '');
        if (!xml) throw new Error('Missing worksheet');
        for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
          const rowNo = Number(attr(row[1], 'r'));
          if (!Number.isSafeInteger(rowNo) || rowNo <= 0) continue;
          const cells: string[] = [];
          for (const cell of row[2].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
            const type = attr(cell[1], 't'), value = texts(cell[2], 'v');
            const visible = type === 's' ? shared[Number(value)] ?? '' : type === 'inlineStr' ? texts(cell[2], 't') : value;
            if (visible.trim()) cells.push(`${attr(cell[1], 'r')}: ${visible}`);
          }
          if (!push({ text: cells.join(' | '), unit: 'row', from: rowNo, to: rowNo, page: null, section })) break sheets;
        }
      }
    } else {
      const rels = relations(read('ppt/_rels/presentation.xml.rels'), 'ppt');
      let slideNo = 0;
      for (const slide of presentation.matchAll(/<p:sldId\b[^>]*\/?\s*>/g)) {
        slideNo++;
        const xml = read(rels.get(attr(slide[0], 'r:id')) ?? '');
        if (!xml) throw new Error('Missing slide');
        const text = tags(xml, 'a:p').map(p => texts(p, 'a:t')).filter(Boolean).join('\n');
        if (!push({ text, unit: 'slide', from: slideNo, to: slideNo, page: null })) break;
      }
    }
    return blocks.length ? { status: 'indexed', message: '', extractor, blocks, truncated } : emptyResult(extractor, 'no_text', '未提取到文字（公式无缓存值、图表或图片需要额外解析/OCR）');
  } catch { return emptyResult(extractor, 'corrupt', 'Office 包结构损坏或缺少正文部件'); }
}
