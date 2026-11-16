/**
 * 智能辅助著录：从「已入索引的附件正文」中提取档案著录候选值（第三阶段 · 功能三）。
 *
 * 原则（与交付要求逐条对应）：
 * 1. 只读真实正文片段（EvidenceRow.text），绝不使用文件名、档案标题猜内容 —— 因此本模块不接受 fileName；
 * 2. 每个候选值必须携带原文依据（来源编号 + 位置 + 原文行），无依据即留空，绝不编造；
 * 3. 目标字段清单来自系统真实存在的字段（档案固定著录字段 + 分类绑定模板的启用信息项），
 *    识别到但现有系统没有对应字段的信息，归入 unmapped 只做展示，等后续需求，不擅自扩表；
 * 4. 纯函数、零依赖、不触网、不写库：是否调用模型由上层决定，本模块只负责可核对的规则抽取。
 */

/** 抽取目标字段（由服务层按真实字段定义给出）。 */
export interface CatalogFieldSpec {
  /** 写入时使用的键：固定字段名或模板 fieldKey。 */
  key: string;
  label: string;
  /** text / textarea / number / date / select / bool / tags（固定字段以 text/date 表示）。 */
  type: string;
  /** true = 档案固定著录字段；false = 分类绑定模板的动态信息项。 */
  fixed: boolean;
  /** select 类型的可选值（用于校验抽取结果是否真的是合法选项）。 */
  options?: string[];
  /** 模板信息项是否必填（必填且未识别到值时，预览里需明确提示用户补全）。 */
  required?: boolean;
  /** 字段值长度上限（超出按上限截断，与既有校验保持一致）。 */
  maxLength?: number;
}

/** 单个抽取结果：hasValue=false 时 value 为空串（留空，不编造）。 */
export interface ExtractedValue {
  key: string;
  label: string;
  type: string;
  fixed: boolean;
  /** 该字段是否为必填（仅模板信息项可能为 true）。 */
  required: boolean;
  value: string;
  hasValue: boolean;
  /** 原文依据编号（对应 sources[].ref）；无依据为 null。 */
  evidenceRef: string | null;
  /** 依据所在的原文行（截断展示）。 */
  evidenceText: string;
  /** 依据位置（DOCX 第 N 段 / PDF 第 N 页 第 M 行 / TXT 第 N 行）。 */
  locator: string;
}

export interface CatalogExtraction {
  /** 可写入现有字段的候选值（含识别失败的空值项）。 */
  fields: ExtractedValue[];
  /** 正文中识别到、但现有系统暂无对应字段的要素（仅展示，不写入）。 */
  unmapped: ExtractedValue[];
  /** 面向用户的诚实说明（哪些附件有正文、哪些没有）。 */
  notes: string[];
}

/** 参与抽取的正文片段：只取必要字段，不含附件名等无关信息。 */
export interface ExtractSource {
  ref: string;
  locator: string;
  text: string;
}

const MAX_LINE_CHARS = 160;

/** 业务要素抽取规则：同一要素按顺序尝试多个表述（合同/协议/项目等叫法差异）。 */
const ELEMENT_RULES: Array<{ code: string; label: string; type: string; patterns: RegExp[] }> = [
  {
    code: 'contractNo',
    label: '合同编号',
    type: 'text',
    patterns: [
      /(?:合同编号|协议编号|合同号|文件编号|档案编号|采购编号|项目编号|招标编号)\s*[:：为是]*\s*([A-Za-z0-9][A-Za-z0-9\-_/.·]{3,63})/,
      /(?:编号)\s*[:：为是]\s*([A-Za-z0-9][A-Za-z0-9\-_/.·]{3,63})/,
    ],
  },
  {
    code: 'contractName',
    label: '合同名称',
    type: 'text',
    patterns: [
      /(?:合同名称|协议名称|项目名称|采购项目名称|工程名称|服务名称)\s*[:：为]*\s*([^\n，,。；;：:]{4,80})/,
    ],
  },
  {
    code: 'signDate',
    label: '合同签订日期',
    type: 'date',
    patterns: [
      /(?:签订日期|签署日期|订立日期|签约日期|签订时间)\s*[:：为]*\s*(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?)/,
    ],
  },
  {
    code: 'amount',
    label: '合同金额',
    type: 'text',
    patterns: [
      /(?:合同金额|合同总价|成交金额|中标金额|合同价款|总金额|金额)\s*[:：为]*\s*(?:人民币)?\s*([0-9][0-9,]*(?:\.\d+)?)\s*(万元|万|元)/,
    ],
  },
  {
    code: 'partyA',
    label: '甲方',
    type: 'text',
    patterns: [/(?:甲方|需方|发包方|买方|采购方)\s*(?:[\(（][^)）]{0,10}[\)）])?\s*[:：]\s*([^\n，,；;。：:]{2,40})/],
  },
  {
    code: 'partyB',
    label: '乙方',
    type: 'text',
    patterns: [/(?:乙方|供方|承包方|卖方|供应商|受托方)\s*(?:[\(（][^)）]{0,10}[\)）])?\s*[:：]\s*([^\n，,；;。：:]{2,40})/],
  },
  {
    code: 'term',
    label: '合同履行期限',
    type: 'text',
    patterns: [
      /(?:履行期限|合同期限|服务期限|合作期限|有效期|工期|质保期)\s*[:：为]*\s*([^\n；;。]{2,60})/,
    ],
  },
  {
    code: 'mainContent',
    label: '合同主要内容',
    type: 'textarea',
    patterns: [
      /(?:合同主要内容|主要内容|合同内容|采购内容|服务内容|项目内容|标的)\s*[:：为]*\s*([^\n；;]{4,200})/,
    ],
  },
  {
    code: 'archiveTitle',
    label: '档案标题',
    type: 'text',
    patterns: [
      /(?:档案标题|题名|标题)\s*[:：为]*\s*([^\n，,。；;：:]{4,120})/,
    ],
  },
  {
    code: 'formationDate',
    label: '形成时间',
    type: 'date',
    patterns: [
      /(?:形成日期|形成时间|成文日期|立卷日期)\s*[:：为]*\s*(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?)/,
    ],
  },
  {
    code: 'responsible',
    label: '责任者',
    type: 'text',
    patterns: [
      /(?:责任者|形成单位|承办单位|承办部门|责任部门|编制单位|归口部门)\s*[:：为]*\s*([^\n，,；;。：:]{2,60})/,
    ],
  },
  {
    code: 'keywords',
    label: '关键词',
    type: 'text',
    patterns: [/(?:关键词|主题词)\s*[:：为]*\s*([^\n，,；;。]{2,100})/],
  },
  {
    code: 'archiveType',
    label: '档案类型',
    type: 'select',
    patterns: [/(?:档案类型|档案类别)\s*[:：为]*\s*(文书档案|科技档案|会计档案|人事档案|业务档案|其他)/],
  },
];

/** 现有固定字段与业务要素的映射：目标字段没有同名的动态信息项时才回落到这里。 */
const FIXED_FIELD_ELEMENT: Record<string, string[]> = {
  title: ['archiveTitle', 'contractName'],
  formationDate: ['formationDate', 'signDate'],
  responsible: ['responsible'],
  archiveType: ['archiveType'],
  keywords: ['keywords'],
  remarks: ['mainContent'],
};

/** 动态信息项按标签别名匹配（模板常见叫法，仍要求正文里出现该标签或该要素表述）。 */
const DYNAMIC_ELEMENT_HINT: Array<{ match: RegExp; codes: string[] }> = [
  { match: /(合同编号|协议编号|编号)/, codes: ['contractNo'] },
  { match: /(合同名称|项目名称)/, codes: ['contractName'] },
  { match: /(签订|签署|订立)/, codes: ['signDate'] },
  { match: /(金额|价款|总价)/, codes: ['amount'] },
  { match: /(甲方|需方|发包方)/, codes: ['partyA'] },
  { match: /(乙方|供方|承包方|供应商)/, codes: ['partyB'] },
  { match: /(双方|当事人)/, codes: ['partyA', 'partyB'] },
  { match: /(期限|工期|质保)/, codes: ['term'] },
  { match: /(内容|标的|摘要)/, codes: ['mainContent'] },
];

function normalizeDate(raw: string): string {
  const m = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (Number(y) < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cleanValue(type: string, raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  // 去掉尾部残留标点（「签订日期：2026年1月5日，」这类）
  text = text.replace(/[，,。.；;：:、]+$/g, '');
  if (type === 'date') return normalizeDate(text);
  if (type === 'number') {
    const m = text.match(/[0-9][0-9,]*(?:\.\d+)?/);
    return m ? m[0].replace(/,/g, '') : '';
  }
  return text;
}

/** 把正文按行拆开（保留来源编号与位置），行级匹配便于给出精确原文依据。 */
function linesOf(source: ExtractSource): Array<{ ref: string; locator: string; line: string }> {
  return source.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({ ref: source.ref, locator: source.locator, line }));
}

/** 在正文行中查找某要素：命中即返回原文行（依据可核对）。 */
function findElement(
  code: string,
  lines: Array<{ ref: string; locator: string; line: string }>,
): { value: string; ref: string; locator: string; line: string } | null {
  const rule = ELEMENT_RULES.find((r) => r.code === code);
  if (!rule) return null;
  for (const item of lines) {
    for (const re of rule.patterns) {
      const m = item.line.match(re);
      if (!m) continue;
      const value = cleanValue(rule.type, m[1] ?? '');
      if (!value) continue;
      if (rule.code === 'amount' && m[2]) {
        return { value: `${value}${m[2]}`, ref: item.ref, locator: item.locator, line: item.line };
      }
      if (rule.code === 'partyA' || rule.code === 'partyB') {
        // 排除「甲方法定代表人」这类干扰：捕获组必须是机构/单位名形态
        if (/^(法定代表人|代表|联系人|电话|地址)/.test(value)) continue;
      }
      return { value, ref: item.ref, locator: item.locator, line: item.line };
    }
  }
  return null;
}

/** 直接按字段标签在正文里找值（覆盖任意模板：如信息项就叫「合同金额（元）」）。 */
function findByLabel(
  spec: CatalogFieldSpec,
  lines: Array<{ ref: string; locator: string; line: string }>,
): { value: string; ref: string; locator: string; line: string } | null {
  const label = spec.label.replace(/[（(].*$/, '').trim();
  if (label.length < 2) return null;
  const re = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：为]*\\s*([^\\n；;，,]{2,120})`);
  for (const item of lines) {
    const m = item.line.match(re);
    if (!m) continue;
    const value = cleanValue(spec.type, m[1]);
    if (!value) continue;
    if (spec.type === 'select' && spec.options?.length && !spec.options.includes(value)) continue;
    return { value, ref: item.ref, locator: item.locator, line: item.line };
  }
  return null;
}

function toValue(spec: CatalogFieldSpec, hit: ReturnType<typeof findElement>): ExtractedValue {
  const max = spec.maxLength ?? (spec.type === 'textarea' ? 500 : 200);
  const raw = hit ? hit.value : '';
  const value = raw ? raw.slice(0, max) : '';
  return {
    key: spec.key,
    label: spec.label,
    type: spec.type,
    fixed: spec.fixed,
    required: spec.required === true,
    value,
    hasValue: !!value,
    evidenceRef: hit ? hit.ref : null,
    evidenceText: hit ? hit.line.slice(0, MAX_LINE_CHARS) : '',
    locator: hit ? hit.locator : '',
  };
}

/**
 * 抽取入口：按传入的真实字段清单产出候选值 + 原文依据。
 * @param specs  目标字段（固定字段 + 该分类模板启用信息项）
 * @param sources 已按当前用户权限检索到的正文片段（含 ref / locator / text）
 */
export function extractCatalogFields(specs: CatalogFieldSpec[], sources: ExtractSource[]): CatalogExtraction {
  const lines = sources.flatMap(linesOf);
  const hits = new Map<string, NonNullable<ReturnType<typeof findElement>>>();
  for (const rule of ELEMENT_RULES) {
    const hit = findElement(rule.code, lines);
    if (hit) hits.set(rule.code, hit);
  }

  const fields: ExtractedValue[] = [];
  for (const spec of specs) {
    // 1) 优先按字段标签直接命中正文（模板字段最常见、也最可靠）
    const byLabel = findByLabel(spec, lines);
    if (byLabel) {
      fields.push(toValue(spec, byLabel));
      continue;
    }
    // 2) 再按业务要素别名回落（固定字段用固定映射，动态字段用标签关键词）
    const codes = spec.fixed
      ? FIXED_FIELD_ELEMENT[spec.key] ?? []
      : DYNAMIC_ELEMENT_HINT.filter((h) => h.match.test(spec.label)).flatMap((h) => h.codes);
    const hit = codes.map((c) => hits.get(c)).find((h): h is NonNullable<typeof h> => !!h);
    fields.push(toValue(spec, hit ?? null));
  }

  // 3) 正文里识别到、但没有对应字段的要素 → 只展示，不写入（不擅自扩表）
  const unmapped: ExtractedValue[] = [];
  const takenKeys = new Set(specs.map((s) => s.key));
  for (const rule of ELEMENT_RULES) {
    const hit = hits.get(rule.code);
    if (!hit) continue;
    // 该要素是否已被某个字段吸收（按依据行一致判定，避免重复展示）
    const absorbed = fields.some(
      (f) => f.hasValue && f.evidenceRef === hit.ref && f.evidenceText === hit.line.slice(0, MAX_LINE_CHARS),
    );
    const fixedTarget = Object.entries(FIXED_FIELD_ELEMENT).some(
      ([key, codes]) => codes.includes(rule.code) && takenKeys.has(key),
    );
    const dynamicTarget = DYNAMIC_ELEMENT_HINT.some(
      (h) => h.codes.includes(rule.code) && specs.some((s) => !s.fixed && h.match.test(s.label)),
    );
    if (absorbed || fixedTarget || dynamicTarget) continue;
    unmapped.push({
      key: rule.code,
      label: rule.label,
      type: rule.type,
      fixed: false,
      required: false,
      value: hit.value,
      hasValue: true,
      evidenceRef: hit.ref,
      evidenceText: hit.line.slice(0, MAX_LINE_CHARS),
      locator: hit.locator,
    });
  }

  const notes: string[] = [];
  if (!sources.length) {
    notes.push('当前档案没有可读取的已索引正文，未作任何提取（不会按文件名猜测）。');
  } else {
    notes.push(`已核对 ${sources.length} 段正文，字段值均附带原文依据；未识别的字段留空。`);
  }
  return { fields, unmapped, notes };
}

/** 抽取结果转成可提交的字段值（只保留有值项，空值不覆盖既有著录）。 */
export function extractionToValues(fields: ExtractedValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) if (f.hasValue) out[f.key] = f.value;
  return out;
}
