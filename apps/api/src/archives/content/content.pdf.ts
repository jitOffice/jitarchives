/**
 * 零依赖 PDF 正文提取器（第二阶段：附件全文检索）。
 *
 * 为什么自写而不引第三方库：本项目后端刻意保持「零原生/零额外运行时依赖」（Node 内置
 * node:sqlite + 内置 fetch + 已装的 pizzip），引入 PDF.js 一类库会显著扩大依赖面与体积。
 *
 * 能力边界（与需求「不给扫描件做 OCR、不猜正文」一致）：
 * - 支持：文本型 PDF，含 FlateDecode 压缩内容流、/Identity-H 等 CID 字体（依赖内嵌 ToUnicode）、
 *   /GBK-EUC-H 等中文简单编码、WinAnsi/Standard 单字节编码；
 * - 不支持：需要 OCR 的纯图像扫描件（明确返回 scanned）、加密 PDF（明确返回 encrypted）、
 *   LZW/CCITT/JBIG2 等未实现过滤器（跳过对应内容流，不产出猜测文本）；
 * - 绝不产出乱码：CID 字体若既无 ToUnicode 又不是 UCS-2 编码，该段文本一律丢弃。
 */
import * as fs from 'fs';
import * as zlib from 'zlib';
import { ContentBlock, ExtractResult } from './content.types';

/** 单次提取的 PDF 体积上限：超过则明确放弃（避免把内存与 CPU 打满）。 */
const MAX_PDF_BYTES = 40 * 1024 * 1024;
/** 单页最多保留的文本行数、全文最多保留的块数（防御性上限）。 */
const MAX_LINES_PER_PAGE = 4000;
const MAX_TOTAL_BLOCKS = 20000;
const MAX_PDF_CHARS = 400000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

type FontEncoding = 'latin' | 'gbk' | 'ucs2be' | 'cid';

interface PdfFont {
  unsupported?:boolean;
  /** 是否为双字节 CID 字体 */
  cid: boolean;
  encoding: FontEncoding;
  /** ToUnicode CMap：CID 码 → Unicode 字符 */
  toUnicode?: Map<number, string>;
}

interface PdfObject {
  num: number;
  /** 对象字典文本（latin1 切片，键值靠正则提取，不做完整 AST） */
  dict: string;
  /** 原始流字节（无流时为 null） */
  stream: Buffer | null;
}

// ==================== 对外入口 ====================

export function extractPdfContent(filePath: string): ExtractResult {
  const empty = (status: ExtractResult['status'], message: string): ExtractResult => ({
    status,
    message,
    extractor: 'pdf',
    blocks: [],
    truncated: false,
  });

  let buf: Buffer;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_PDF_BYTES) {
      return empty('unsupported', `PDF 文件过大（${Math.round(stat.size / 1024 / 1024)}MB），本阶段不做正文提取`);
    }
    buf = fs.readFileSync(filePath);
  } catch {
    return empty('failed', 'PDF 文件读取失败');
  }

  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF-')) return empty('corrupt', '文件头不是 PDF，无法按 PDF 解析正文');

  // 加密判定：交叉引用表/trailer 里的 /Encrypt 引用（对象流里不会出现该形态）
  if (/\/Encrypt\s+\d{1,10}\s+\d{1,5}\s+R/.test(buf.toString('latin1', Math.max(0, buf.length - 200000)))) {
    return empty('encrypted', 'PDF 已加密（需要打开口令），无法读取正文');
  }

  const raw = buf.toString('latin1');
  const index = parseObjects(raw, buf);
  const objects = index.objects;
  const pages = resolvePageOrder(index);
  if (!pages.length) {
    // 没有页面对象：要么不是合法 PDF，要么是纯注释/图像容器
    return index.hasImageXObject
      ? empty('scanned', 'PDF 仅包含图像（疑似扫描件），本阶段未启用 OCR，无法提取正文')
      : empty('corrupt', 'PDF 结构中未找到页面对象，文件可能已损坏');
  }

  const blocks: ContentBlock[] = [];
  let discardedCid = false;
  let charCount = 0;
  let truncated = false;
  for (let p = 0; p < pages.length; p += 1) {
    const pageNum = p + 1;
    const fonts = collectFonts(objects, pages[p]);
    const streams = collectContentStreams(objects, pages[p]);
    for (const content of streams) {
      const lines = interpretText(content, fonts);
      if (lines.length > MAX_LINES_PER_PAGE) truncated = true;
      if (lines.discardedCid) discardedCid = true;
      for (let i = 0; i < lines.length && i < MAX_LINES_PER_PAGE; i += 1) {
        let text = lines[i].trim();
        if (charCount + text.length > MAX_PDF_CHARS) { text = text.slice(0,MAX_PDF_CHARS-charCount); truncated = true; }
        charCount += text.length;
        if (!text) { if (truncated && blocks.length) return {status:'indexed',message:'',extractor:'pdf',blocks,truncated:true}; continue; }
        if (blocks.length >= MAX_TOTAL_BLOCKS) {
          return { status: 'indexed', message: '', extractor: 'pdf', blocks, truncated: true };
        }
        blocks.push({ text, unit: 'line', from: i + 1, to: i + 1, page: pageNum });
      }
    }
  }

  if (!blocks.length) {
    if (discardedCid) {
      return empty(
        'no_text',
        '该 PDF 使用了未内嵌字符映射（ToUnicode）的字体，无法可靠还原文字，因此不提取正文',
      );
    }
    return index.hasImageXObject
      ? empty('scanned', 'PDF 仅包含图像（疑似扫描件），本阶段未启用 OCR，无法提取正文')
      : empty('no_text', '该 PDF 未包含文本层，无可提取的正文');
  }
  return { status: 'indexed', message: '', extractor: 'pdf', blocks, truncated };
}

// ==================== 对象结构解析 ====================

interface ObjectIndex {
  objects: Map<number, PdfObject>;
  hasImageXObject: boolean;
}

function parseObjects(raw: string, buf: Buffer): ObjectIndex {
  const objects = new Map<number, PdfObject>();
  let hasImageXObject = false;
  const re = /(^|[^0-9:])(\d{1,10})[ \t\r\n]+(\d{1,5})[ \t\r\n]+obj\b/g;
  const hits: Array<{ num: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    hits.push({ num: Number(m[2]), bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < hits.length; i += 1) {
    const { num, bodyStart } = hits[i];
    const regionEnd = i + 1 < hits.length ? hits[i + 1].bodyStart : raw.length;
    const endObj = raw.indexOf('endobj', bodyStart);
    const streamKw = raw.indexOf('stream', bodyStart);
    const dictEndCandidates = [
      streamKw >= 0 && streamKw < regionEnd ? streamKw : regionEnd,
      endObj >= 0 && endObj < regionEnd ? endObj : regionEnd,
    ];
    const dictEnd = Math.min(...dictEndCandidates);
    const dict = raw.slice(bodyStart, dictEnd);
    if (/\/Subtype\s*\/Image\b/.test(dict)) hasImageXObject = true;

    let stream: Buffer | null = null;
    if (streamKw >= 0 && streamKw < dictEnd + 1 + 2) {
      let dataStart = streamKw + 'stream'.length;
      if (raw[dataStart] === '\r') dataStart += 1;
      if (raw[dataStart] === '\n') dataStart += 1;
      const dataEnd = raw.indexOf('endstream', dataStart);
      if (dataEnd > dataStart) {
        let cut = dataEnd;
        // 规范要求流尾可带一个 EOL，读取时统一剔除
        if (raw[cut - 1] === '\n') cut -= 1;
        if (raw[cut - 1] === '\r') cut -= 1;
        stream = buf.subarray(dataStart, cut);
      }
    }
    // 同号码多次出现（增量更新）时以最后一次为准
    objects.set(num, { num, dict, stream });
  }
  return { objects, hasImageXObject };
}

/** 引用解析：`N G R` 形态的取值（key 为空串时表示整段就是引用）。 */
function refOf(text: string, key: string): number | null {
  const prefix = key ? `${key}\\s*` : '';
  const m = new RegExp(`${prefix}\\[?\\s*(\\d{1,10})\\s+\\d{1,5}\\s+R`).exec(text);
  return m ? Number(m[1]) : null;
}

/** /Kids 数组内的引用（用于页面顺序还原）。 */
function refsIn(text: string, key: string): number[] {
  const m = new RegExp(`${key}\\s*\\[([\\s\\S]{0,20000})\\]`).exec(text);
  if (!m) return [];
  const out: number[] = [];
  const re = /(\d{1,10})\s+\d{1,5}\s+R/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(m[1])) !== null) out.push(Number(r[1]));
  return out;
}

/**
 * 页面顺序：优先按 /Pages 树（Kids 递归展开）还原真实页序，
 * 树上没覆盖到的页面对象再按对象号补齐（不猜，只兜底）。
 */
function resolvePageOrder(index: ObjectIndex): number[] {
  const objects = index.objects;
  const pageNums: number[] = [];
  const treeNodes = new Map<number, number[]>();
  const childSet = new Set<number>();
  for (const [num, obj] of objects) {
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const kids = refsIn(obj.dict, '/Kids');
      if (kids.length) {
        treeNodes.set(num, kids);
        kids.forEach((k) => childSet.add(k));
      }
    } else if (/\/Type\s*\/Page(?![a-zA-Z])/.test(obj.dict)) {
      pageNums.push(num);
    }
  }
  const roots = [...treeNodes.keys()].filter((n) => !childSet.has(n));
  const ordered: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number) => {
    if (seen.has(num) || depth > 32) return;
    seen.add(num);
    if (treeNodes.has(num)) {
      for (const kid of treeNodes.get(num)!) walk(kid, depth + 1);
      return;
    }
    const obj = objects.get(num);
    if (obj && /\/Type\s*\/Page(?![a-zA-Z])/.test(obj.dict)) ordered.push(num);
  };
  for (const r of roots) walk(r, 0);
  for (const p of pageNums.sort((a, b) => a - b)) if (!seen.has(p)) ordered.push(p);
  return ordered;
}

/** 取某 key 后面的值：内联字典做平衡扫描，引用则解引用到目标对象字典。 */
function resolveDict(
  objects: Map<number, PdfObject>,
  dict: string,
  key: string,
): string | null {
  const at = dict.indexOf(key);
  if (at < 0) return null;
  const tail = dict.slice(at + key.length, at + key.length + 40);
  if (/^\s*\d/.test(tail)) {
    const num = refOf(dict.slice(at), '');
    return num === null ? null : objects.get(num)?.dict ?? null;
  }
  return inlineDict(dict, key);
}

/** 沿 /Parent 继承字典属性（页面无 /Resources 时取父节点），最多 8 层。 */
function inherited(
  objects: Map<number, PdfObject>,
  start: number,
  key: string,
): string | null {
  let cur: number | null = start;
  let depth = 0;
  while (cur !== null && depth < 8) {
    const obj = objects.get(cur);
    if (!obj) return null;
    const resolved = resolveDict(objects, obj.dict, key);
    if (resolved) return resolved;
    cur = refOf(obj.dict, '/Parent');
    depth += 1;
  }
  return null;
}

/** 取某 key 后面的内联字典文本（平衡扫描 << … >>）。 */
function inlineDict(dict: string, key: string): string | null {
  const at = dict.indexOf(key);
  if (at < 0) return null;
  const open = dict.indexOf('<<', at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < dict.length - 1; i += 1) {
    const two = dict.slice(i, i + 2);
    if (two === '<<') {
      depth += 1;
      i += 1;
    } else if (two === '>>') {
      depth -= 1;
      i += 1;
      if (depth === 0) return dict.slice(open, i + 2);
    }
  }
  return null;
}

/** 收集页面可用字体（含继承的 /Resources）。 */
function collectFonts(objects: Map<number, PdfObject>, pageNum: number): Map<string, PdfFont> {
  const fonts = new Map<string, PdfFont>();
  const resText = inherited(objects, pageNum, '/Resources');
  if (!resText) return fonts;
  const fontDict = resolveDict(objects, resText, '/Font');
  if (!fontDict) return fonts;
  const re = /\/([A-Za-z0-9_.]+)\s+(\d{1,10})\s+(\d{1,5})\s+R/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fontDict)) !== null) {
    const obj = objects.get(Number(m[2]));
    if (!obj) continue;
    const font = readFont(objects, obj);
    if (font) fonts.set(m[1], font);
  }
  return fonts;
}

function readFont(objects: Map<number, PdfObject>, obj: PdfObject): PdfFont | null {
  const dict = obj.dict;
  const isType0 = /\/Type0\b/.test(dict) || /\/Subtype\s*\/Type0\b/.test(dict);
  if (isType0) {
    const encName = (dict.match(/\/Encoding\s*\/([A-Za-z0-9_+\-.]+)/) ?? [])[1] ?? '';
    const toUnicodeRef = (/\/ToUnicode\s+(\d{1,10})\s+\d{1,5}\s+R/.exec(dict) ?? [])[1];
    let toUnicode: Map<number, string> | undefined;
    if (toUnicodeRef) {
      const tu = objects.get(Number(toUnicodeRef));
      const text = tu?.stream ? decodeStream(tu) : null;
      if (text) toUnicode = parseToUnicode(text);
    }
    if (toUnicode && toUnicode.size) return { cid: true, encoding: 'cid', toUnicode };
    if (/UCS2|UTF16|UTF-16/i.test(encName)) return { cid: true, encoding: 'ucs2be' };
    if (/GBK|GBPC|EUC-CN|GB18030/i.test(encName))return {cid:false,encoding:'gbk'};
    // CID 字体但没有可核验的字符映射：丢弃文本，绝不产出乱码
    return { cid: true, encoding: 'cid' };
  }
  const encName = (dict.match(/\/Encoding\s*\/([A-Za-z0-9_+\-.]+)/) ?? [])[1] ?? '';
  const mapping=refOf(dict,'/ToUnicode');
  if(mapping){const stream=objects.get(mapping);const text=stream?decodeStream(stream):null;if(text)return {cid:false,encoding:'latin',toUnicode:parseToUnicode(text)};}
  const encoding=resolveDict(objects,dict,'/Encoding');
  if(/\/Differences\b/u.test(encoding??dict))return {cid:false,encoding:'latin',unsupported:true};
  if (/GBK|GBPC|EUC-CN|GB18030|UniGB/i.test(encName)) return { cid: false, encoding: 'gbk' };
  return { cid: false, encoding: 'latin' };
}

/** ToUnicode CMap：解析 bfchar 与两种形态的 bfrange。 */
function parseToUnicode(text: string): Map<number, string> {
  const map = new Map<number, string>();
  const hexToUtf16 = (hex: string): string => {
    const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
    let out = '';
    for (let i = 0; i + 3 < clean.length + 1 && i + 4 <= clean.length + 1; i += 4) {
      const unit = clean.slice(i, i + 4);
      if (unit.length < 4) break;
      out += String.fromCharCode(parseInt(unit, 16));
    }
    return out;
  };
  for (const sections of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sections[1])) !== null) {
      const code = parseInt(m[1], 16);
      const value = hexToUtf16(m[2]);
      if (Number.isFinite(code) && value) map.set(code, value);
    }
  }
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  let rm: RegExpExecArray | null;
  while ((rm = rangeRe.exec(text)) !== null) {
    const body = rm[1];
    const arrayForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
    let am: RegExpExecArray | null;
    let consumed = 0;
    while ((am = arrayForm.exec(body)) !== null) {
      consumed += 1;
      const lo = parseInt(am[1], 16);
      const codes = (am[3].match(/<([0-9A-Fa-f]+)>/g) ?? []).map((s) => hexToUtf16(s.slice(1, -1)));
      for (let i = 0; i < codes.length; i += 1) {
        if (codes[i]) map.set(lo + i, codes[i]);
      }
    }
    const simpleForm = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let sm: RegExpExecArray | null;
    let simple = 0;
    while ((sm = simpleForm.exec(body)) !== null) {
      // 已被数组形态消费的行跳过（数组形态的第三个 <> 后紧跟 [ ... ]，此处按空白边界再判一次）
      const after = body.slice(sm.index + sm[0].length).trimStart();
      if (after.startsWith('[')) continue;
      simple += 1;
      const lo = parseInt(sm[1], 16);
      const hi = parseInt(sm[2], 16);
      const base = parseInt(sm[3], 16);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo > 65535) continue;
      for (let i = lo; i <= hi; i += 1) map.set(i, String.fromCharCode(base + (i - lo)));
    }
    if (!consumed && !simple) continue;
  }
  return map;
}

/** 页面 /Contents（可单个引用或数组，均可继承）。 */
function collectContentStreams(objects: Map<number, PdfObject>, pageNum: number): string[] {
  const out: string[] = [];
  const page = objects.get(pageNum);
  if (!page) return out;
  const holder = page.dict;
  const m = /\/Contents\s*(\[[^\]]*\]|\d{1,10}\s+\d{1,5}\s+R)/.exec(holder);
  const refs: number[] = [];
  if (m) {
    const re = /(\d{1,10})\s+\d{1,5}\s+R/g;
    let r: RegExpExecArray | null;
    while ((r = re.exec(m[1])) !== null) refs.push(Number(r[1]));
  }
  for (const num of refs) {
    const obj = objects.get(num);
    if (!obj?.stream) continue;
    const text = decodeStream(obj);
    if (text) out.push(text);
  }
  return out;
}

/** 内容流解码：仅实现 FlateDecode（失败即跳过，不做猜测式解压）。 */
function decodeStream(obj: PdfObject): string | null {
  if (!obj.stream) return null;
  const specification=obj.dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/u)?.[1];
  const filters=specification?.match(/[A-Za-z0-9]+/gu)??[];
  let data=obj.stream;
  try{
    for(const filter of filters){
      if(filter==='ASCII85Decode'||filter==='A85')data=decodeAscii85(data);
      else if(filter==='ASCIIHexDecode'||filter==='AHx'){
        let text=data.toString('latin1').replace(/\s/gu,'').replace(/>$/u,'');
        if(/[^\da-f]/iu.test(text))return null;if(text.length%2)text+='0';data=Buffer.from(text,'hex');
      }else if(filter==='FlateDecode'||filter==='Fl'){
        try{data=zlib.inflateSync(data,{maxOutputLength:MAX_STREAM_BYTES});}
        catch{data=zlib.inflateRawSync(data,{maxOutputLength:MAX_STREAM_BYTES});}
      }else return null;
      if(data.length>MAX_STREAM_BYTES)return null;
    }
    return data.length<=MAX_STREAM_BYTES?data.toString('latin1'):null;
  }catch{return null;}
}

function decodeAscii85(data:Buffer):Buffer{
  const text=data.toString('latin1').replace(/\s/gu,'').replace(/^<~/u,'').replace(/~>$/u,'');
  const output:number[]=[],group:number[]=[];
  const flush=(count:number)=>{
    while(group.length<5)group.push(84);
    const value=group.reduce((sum,digit)=>sum*85+digit,0);if(value>0xffffffff)throw new Error('Invalid ASCII85');
    for(let shift=3;shift>=4-count;shift--)output.push((value/2**(shift*8))&255);
    group.length=0;
    if(output.length>MAX_STREAM_BYTES)throw new Error('Stream limit');
  };
  for(const ch of text){
    if(ch==='z'&&!group.length){output.push(0,0,0,0);continue;}
    const code=ch.charCodeAt(0)-33;if(code<0||code>84)throw new Error('Invalid ASCII85');group.push(code);
    if(group.length===5)flush(4);
  }
  if(group.length===1)throw new Error('Invalid ASCII85 tail');if(group.length)flush(group.length-1);
  return Buffer.from(output);
}

// ==================== 内容流文本解释 ====================

interface TextLineResult extends Array<string> {
  discardedCid: boolean;
}

const WS = new Set([' ', '\t', '\r', '\n', '\f', '\0']);

function interpretText(content: string, fonts: Map<string, PdfFont>): TextLineResult {
  const lines: string[] = [];
  let current = '';
  let font: PdfFont | undefined;
  let discardedCid = false;
  let charCount = 0;
  let truncated = false;
  let i = 0;
  const operands: Operand[] = [];
  const n = content.length;

  const pushLine = () => {
    if (current.trim()) lines.push(current);
    current = '';
  };
  const append = (bytes: Buffer) => {
    const decoded = decodePdfString(bytes, font);
    if (decoded === null) discardedCid = true;
    else current += decoded;
  };

  while (i < n) {
    const ch = content[i];
    if (WS.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === '%') {
      while (i < n && content[i] !== '\n' && content[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '(') {
      const [bytes, next] = readLiteral(content, i);
      operands.push({ k: 'str', v: bytes });
      i = next;
      continue;
    }
    if (ch === '<' && content[i + 1] !== '<') {
      const end = content.indexOf('>', i);
      if (end < 0) break;
      operands.push({ k: 'str', v: hexToBuffer(content.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (ch === '<' && content[i + 1] === '<') {
      // 字典（如 /BDC 属性）：整段跳过，避免其中的数字/名称被误当成文本操作数
      let depth = 0;
      let j = i;
      while (j < n - 1) {
        if (content[j] === '<' && content[j + 1] === '<') {
          depth += 1;
          j += 2;
        } else if (content[j] === '>' && content[j + 1] === '>') {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
        } else j += 1;
      }
      operands.push({ k: 'other' });
      i = j;
      continue;
    }
    if (ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      i += 1;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !WS.has(content[j]) && '()<>[]{}%/'.indexOf(content[j]) < 0) j += 1;
      operands.push({ k: 'name', v: content.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9+\-.]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9+\-.]/.test(content[j])) j += 1;
      operands.push({ k: 'num', v: Number(content.slice(i, j)) || 0 });
      i = j;
      continue;
    }
    // 关键字（操作符）
    let j = i;
    while (j < n && /[A-Za-z*'"\\]/.test(content[j])) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    const op = content.slice(i, j);
    i = j;
    switch (op) {
      case 'BT':
        pushLine();
        break;
      case 'ET':
        pushLine();
        break;
      case 'Tj': {
        const s = operands.find((o) => o.k === 'str');
        if (s && s.k === 'str') append(s.v);
        break;
      }
      case "'":
      case '"': {
        pushLine();
        const s = operands.find((o) => o.k === 'str');
        if (s && s.k === 'str') append(s.v);
        break;
      }
      case 'TJ': {
        for (const o of operands) {
          if (o.k === 'str') append(o.v);
          else if (o.k === 'num' && o.v <= -300) current += ' '; // 大幅负字距视为空格
        }
        break;
      }
      case 'Tf': {
        const named = operands.find((o) => o.k === 'name');
        font = named && named.k === 'name' ? fonts.get(named.v) : undefined;
        break;
      }
      case 'Td':
      case 'TD':
      case 'T*':
      case 'TL':
        pushLine();
        break;
      case 'BI': {
        // 内联图像：跳到 EI，不参与文本
        const ei = content.indexOf('EI', i);
        i = ei < 0 ? n : ei + 2;
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  pushLine();

  const out = lines as TextLineResult;
  out.discardedCid = discardedCid;
  return out;
}

/** 内容流解释器的操作数（只需文本相关的那几类，其余按 other 丢弃）。 */
type Operand =
  | { k: 'str'; v: Buffer }
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'other' };

function readLiteral(content: string, start: number): [Buffer, number] {
  const bytes: number[] = [];
  let depth = 1;
  let i = start + 1;
  const n = content.length;
  while (i < n && depth > 0) {
    const ch = content[i];
    if (ch === '\\') {
      const next = content[i + 1];
      if (next === 'n') bytes.push(10), (i += 2);
      else if (next === 'r') bytes.push(13), (i += 2);
      else if (next === 't') bytes.push(9), (i += 2);
      else if (next === 'b') bytes.push(8), (i += 2);
      else if (next === 'f') bytes.push(12), (i += 2);
      else if (next === '(') bytes.push(40), (i += 2);
      else if (next === ')') bytes.push(41), (i += 2);
      else if (next === '\\') bytes.push(92), (i += 2);
      else if (next === '\r' || next === '\n') i += 2; // 行续接
      else if (/[0-7]/.test(next ?? '')) {
        const oct = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))?.[0] ?? '';
        bytes.push(parseInt(oct, 8) & 0xff);
        i += 1 + oct.length;
      } else {
        bytes.push(next?.charCodeAt(0) ?? 92);
        i += 2;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff);
    i += 1;
  }
  return [Buffer.from(bytes), i];
}

function hexToBuffer(hex: string): Buffer {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  const len = Math.floor(clean.length / 2);
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) buf[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return buf;
}

/**
 * 字节 → 文字。返回 null 表示「这段无法可靠还原」，调用方据此丢弃而不是猜。
 */
function decodePdfString(bytes: Buffer, font: PdfFont | undefined): string | null {
  if (!bytes.length) return '';
  if (!font) return bytes.toString('latin1');
  if(font.unsupported)return null;
  if (font.cid) {
    if (font.encoding === 'ucs2be') {
      let out = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
      return out;
    }
    if (!font.toUnicode) return null;
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += font.toUnicode.get(bytes.readUInt16BE(i)) ?? '';
    }
    return out;
  }
  if(font.toUnicode)return [...bytes].map(code=>font.toUnicode!.get(code)??'').join('');
  if (font.encoding === 'gbk') {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return bytes.toString('latin1');
    }
  }
  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}
