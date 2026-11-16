/**
 * 附件正文提取的公共类型（第二阶段：全文检索与内容问答）。
 *
 * 约定：
 * - 提取结果只有两种合法形态——真实正文块（blocks）或明确的失败状态（status + 中文原因）；
 *   绝不允许把附件文件名、档案标题或占位文本当作正文返回；
 * - 每个正文块自带来源位置（段落号 / 行号 / 页码），供答案引用逐条回溯到真实文件与版本。
 */

/** 提取状态：indexed 之外一律不产生可检索正文。 */
export type ExtractStatus =
  /** 已提取到正文并入索引 */
  | 'indexed'
  /** 文件可读但没有文本层（如纯文本文件为空、PDF 无文本对象） */
  | 'no_text'
  /** 格式不在本阶段支持范围（图片、压缩包、旧版 .doc 等） */
  | 'unsupported'
  /** 文件结构损坏或不是所申报的格式 */
  | 'corrupt'
  /** 已加密，无法读取正文（需要口令，本阶段不解密） */
  | 'encrypted'
  /** 判定为扫描件/图像型文档，需 OCR（本阶段明确不做） */
  | 'scanned'
  /** 提取过程异常（文件实体缺失、内部错误等） */
  | 'failed';

/** 正文定位单位。 */
export type BlockUnit = 'paragraph' | 'line' | 'row' | 'slide';

export interface ContentBlock {
  text: string;
  unit: BlockUnit;
  /** 起始定位序号（1 起：DOCX 段落号 / TXT 行号 / PDF 页内行号） */
  from: number;
  /** 结束定位序号（单块时等于 from） */
  to: number;
  /** 页码（仅 PDF 有，其余为 null） */
  page: number | null;
  section?: string;
}

export interface ExtractResult {
  status: ExtractStatus;
  /** 面向用户的中文说明；indexed 时为空串 */
  message: string;
  /** 实际使用的提取器标识 */
  extractor: 'docx' | 'pdf' | 'txt' | 'xlsx' | 'pptx' | '';
  blocks: ContentBlock[];
  /** 是否因超出单文件正文上限而截断 */
  truncated: boolean;
}

export const EMPTY_RESULT_LABEL: Record<ExtractStatus, string> = {
  indexed: '',
  no_text: '未在该文件中读到可检索的文本内容',
  unsupported: '该格式暂不支持正文提取',
  corrupt: '文件已损坏或格式与扩展名不符，无法读取正文',
  encrypted: '文件已加密，无法读取正文',
  scanned: '该文件为扫描件（图像型），本阶段未启用 OCR，无法提取正文',
  failed: '正文提取失败',
};

/** 生成人类可读的位置描述，例如「DOCX 第 12 段」「PDF 第 3 页 第 5-8 行」。 */
export function formatLocator(formatLabel: string, block: {
  unit: BlockUnit;
  from: number;
  to: number;
  page: number | null;
  section?: string;
}): string {
  const unitLabel = block.unit === 'paragraph' ? '段' : block.unit === 'slide' ? '张幻灯片' : '行';
  const range = block.to > block.from ? `${block.from}-${block.to}` : `${block.from}`;
  if (block.section) return `${formatLabel} ${block.section} 第 ${range} ${unitLabel}`;
  if (block.page !== null) return `${formatLabel} 第 ${block.page} 页 第 ${range} ${unitLabel}`;
  return `${formatLabel} 第 ${range} ${unitLabel}`;
}

/** 提取器标识 → 展示用格式名。 */
export const EXTRACTOR_LABEL: Record<string, string> = {
  docx: 'DOCX',
  pdf: 'PDF',
  txt: 'TXT',
  xlsx: 'XLSX',
  pptx: 'PPTX',
};
