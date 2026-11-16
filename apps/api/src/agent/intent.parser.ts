/**
 * 自然语言检索与业务办理意图解析（第一阶段对话式查档 + 第三阶段智能业务办理）。
 *
 * 两层解析：
 *  1) 确定性规则解析（本文件，零依赖、可单测、不触网）：把中文提问映射为结构化检索/办理条件；
 *  2) 模型抽取（agent.service 调用 AI_MODEL_CLIENT）：仅在规则解析拿不到明确条件时启用，
 *     其输出必须经本文件 sanitizeIntent 逐字段校验（长度、取值集合、分类真实存在）后才可使用。
 *
 * 安全底线：解析结果只是「检索条件 / 办理意向」，不含用户身份与权限；权限一律由服务端按当前会话用户判定。
 * 业务办理类意图（borrow_apply / borrow_progress / catalog_suggest）只表示「用户想办什么」，
 * 真正能否办、能办到什么范围，全部由服务端工具层按现有业务规则重新判定；
 * 任何无法识别的问题都归为 unparsed / unsupported，由服务层给出诚实提示，绝不编造结果。
 */

/** 全系统统一检索范围：档案、附件、正文、分类，以及借阅、审计、模板、统计业务信息。 */
import { extractQuestionTerms, isSummaryQuestion } from './content.evidence';
import { archiveStatus } from './archive-status';

export const SEARCH_SCOPES = ['archive', 'attachment', 'content', 'category', 'borrow', 'audit', 'template', 'stats'] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];
/** 未明确要求统计时，通用「全部信息」检索不把统计摘要当作关键词命中结果。 */
export const DEFAULT_UNIFIED_SCOPES: SearchScope[] = SEARCH_SCOPES.filter((scope) => scope !== 'stats');
export type SearchTimeRange = 'today' | 'yesterday' | '7d' | '30d' | '90d';

export type IntentKind =
  | 'search'
  | 'archive_info'
  | 'help'
  | 'content_question'
  /** 统一检索：一次提问跨档案 / 附件 / 正文 / 分类多业务联合查询 */
  | 'unified_search'
  /** 第三阶段：发起借阅申请（需用户确认后由服务端调用既有借阅接口） */
  | 'borrow_apply'
  /** 第三阶段：查询借阅进度/记录 */
  | 'borrow_progress'
  /** 第三阶段：依据附件正文辅助著录（需用户确认后保存） */
  | 'catalog_suggest'
  | 'unsupported'
  | 'unparsed';

/** 结构化检索意图（字段与现有 /api/archives 检索参数一一对应）。 */
export interface ParsedIntent {
  intentType?: 'archive_list' | 'archive_info' | 'attachment_query' | 'content_qa' | 'content_summary';
  archiveTitleCandidates?: string[];
  archiveNumber?: string;
  attachmentNameCandidates?: string[];
  metadataTerms?: string[];
  contentTerms?: string[];
  contentScope?: 'global' | 'archive';
  isSummaryQuestion?: boolean;
  isExplicitScope?: boolean;
  kind: IntentKind;
  /** 全文关键词（标题 / 档号 / 关键词 / 动态著录值，沿用既有 OR 匹配）。 */
  keyword?: string;
  /** 仅按标题匹配（现有检索接口扩展的精确标题参数）。 */
  title?: string;
  /** 档号（精确/前缀）。 */
  archiveNo?: string;
  /** 分类名（已在真实分类中解析成功时写入 categoryId）。 */
  categoryName?: string;
  categoryId?: number;
  /** 状态筛选。 */
  status?: 'draft' | 'archived';
  /** 意图置信度（模型输出时给出；规则解析视为 1）。 */
  confidence?: number;
  /** 借阅用途（仅 borrow_apply；上限沿用现有借阅接口的 1-500 字符规则，仍需服务端复核）。 */
  purpose?: string;
  /** 借阅期限（天，仅 borrow_apply；1-90 之外的取值在此即被丢弃）。 */
  days?: number;
  /** 借阅状态筛选（仅 borrow_progress；取值必须是现有业务真实状态键）。 */
  borrowStatus?: string;
  /** 借阅查询范围（仅 borrow_progress；review 需服务端按现有 borrowReview 权限裁决）。 */
  dataScope?: 'mine' | 'review';
  /** 统一检索范围（仅 unified_search；为空时由服务层按四类全开）。 */
  scopes?: SearchScope[];
  /** 附件格式筛选（仅 unified_search；扩展名小写不带点，越界取值在服务层丢弃）。 */
  extension?: string;
  /** 统一检索时间范围；仅用于借阅、审计和统计，不影响档案/附件原始时间字段。 */
  timeRange?: SearchTimeRange;
  /** 独立的附件文件名条件；第一阶段先完成理解与结构化，第二阶段接入专用检索参数。 */
  attachmentFileName?: string;
  /** 附件查询模式：列出某档案附件，或按附件文件名查找。 */
  attachmentMode?: 'list' | 'file_name';
  /** 连续追问中的指代信号；由后续调度阶段结合当前会话历史解析实际对象。 */
  queryReference?: 'previous_results';
}

export const MAX_QUESTION_LENGTH = 500;
/** 检索词长度上限：与现有检索接口「关键词不超过 100 字符」一致。 */
export const MAX_KEYWORD_LENGTH = 100;
/** 会话标题截断长度（列表展示用）。 */
export const TITLE_MAX_LENGTH = 30;

/** 档号形态：分类编码链-年度-流水号（如 WS-2026-000007）；也兼容用户手打的纯字母数字串。 */
const ARCHIVE_NO_RE = /[A-Za-z0-9\u4e00-\u9fa5]+(?:-[A-Za-z0-9\u4e00-\u9fa5]+){2,}/;
const ARCHIVE_NO_HINT_RE = /(?:档号|编号|文号)\s*(?:是|为|:\s*|：\s*)?([A-Za-z0-9\u4e00-\u9fa5-]{4,64})/;
const TITLE_HINT_RE = /(?:标题|题名|名称)(?:是|为|:\s*|：\s*)?[「《"']?([^」》"'\s，,。？?]{2,100})/;
const KEYWORD_HINT_RE = /关键词\s*(?:是|为|:\s*|：\s*)?([^，,。？?\s]{1,100})/;
const QUESTION_SHAPE_RE = /如何|怎样|怎么|为什么|什么是|能不能|可不可以|是否|什么意思|怎么办/;
/** 附件正文问答特征（第二阶段：命中后走「检索正文→取证→模型作答」链路）。 */
const CONTENT_QUESTION_RE =
  /(条款|正文|全文|内容是什么|写的什么|写了什么|付款条件|支付条件|履约期限|履行期限|违约|金额是多少|多少钱|签订日期是哪|签订日|摘要|讲了什么|讲的是什么|原文|总结|概括|核心内容|主要内容|有哪些主要|哪些条款|质保金|保证金|预付款|首付款|尾款|定金|付款方式|支付方式|付款比例|争议解决|管辖|签订时间|签订地点|生效日期|生效时间|验收标准|交付内容)/;
const CONTENT_MENTION_RE = /(?:哪个|哪些|哪份|哪一份).{0,8}(?:附件|文件).{0,8}(?:提到|涉及|包含|写到)/u;
/** 比较/差异类词：单独出现不算正文问答（「怎么用比较好」这类闲聊不应走取证链路）。 */
const COMPARE_QUESTION_RE = /(区别|差别|差异|对比|比较|哪一份|两份|多份|不同之处)/;
/** 提问里出现的真实业务对象（与比较词同时命中才计为内容问答）。 */
const CONTENT_OBJECT_RE = /(合同|协议|档案|附件|正文|全文|条款|文档)/;
/** 明确指向「找档案」而不是「问内容」的命令式开头。 */
const SEARCH_DIRECTIVE_RE =
  /^(?:请?帮我|麻烦|请问)?(?:查找一下|查一下|找一下|搜索一下|查找|检索|搜索|查询|列出|展示|看看|找找|查查|找|查)/;
/** 疑问信号：与正文问答特征同时出现时，才判定为内容问答（避免把「查找…的档案」误判）。 */
const INTERROGATIVE_MARKER_RE = /(是什么|是多少|有哪些|有几|多少|哪|吗|呢|如何|怎样|怎么|总结|概括|区别|对比|比较|讲了|写了)/;
/** 检索方法咨询特征。 */
const HELP_QUESTION_RE = /(怎样才能|怎么才能|如何|怎样|怎么).{0,8}(查|找|检索|搜索|更准确)|检索方法|搜索建议/;
/** 借阅/审批等业务引导（第三阶段：可直接由 Agent 协助发起申请，不再当作超范围拒答）。 */
const BORROW_GUIDE_RE = /(怎么|如何|怎样|哪里).{0,6}(借阅|申请借阅|借出)|借阅流程|如何续借|到期.*还/;
/** 高风险写操作：只识别明确的命令式表达，不能把「已归档档案」「审批记录」等只读查询误判为写操作。 */
const UNSUPPORTED_ACTION_RE =
  /^(?:(?:(?:请|麻烦|你|我想|我要|直接|立即|执行|进行|帮我|替我)\s*)*(?:把|将|对)?(?:这份|该|此)?(?:档案|附件|文件|文档|合同|借阅申请|申请|用户|账号)?(?:正式|重新)?(?:删除|销毁|归档|审批|批准|通过申请|拒绝申请|通过借阅|停用|下架|改一下|修改档案|改档号|改标题|重置密码|建一个档案|新建档案|上传附件))|^(?:删除|销毁|归档|重新归档|审批|批准|停用|下架|新建|创建|上传|修改|重置)(?:这份|该|此)?(?:档案|附件|文件|文档|合同|借阅申请|申请|用户|账号)|^(?:(?:请|麻烦|你|我想|我要|帮我|替我)\s*)*(?:审核|审批|批准|通过|拒绝|删除|销毁|归档|重新归档|停用|下架|新建|上传|修改|重置)/;

/**
 * 统一检索（第一批）多业务范围信号：每个正则对应一类现有检索能力。
 * 命中两个及以上不同范围，或命中显式联合/全量信号时，四类全开；
 * 仅命中单一范围但有明确检索指令时，路由到 unified_search（单范围检索）。
 */
const UNIFIED_SCOPE_SIGNALS: Array<[SearchScope, RegExp]> = [
  ['archive', /档案|条目/],
  ['attachment', /附件|文件名|文档|资料|格式|后缀|扩展名/],
  ['content', /正文|全文|原文|条款/],
  ['category', /分类|类目|类别/],
  ['borrow', /借阅记录|借阅申请|借阅审批|借阅状态|借阅进度|借阅历史/],
  ['audit', /操作审计|审计记录|审计日志|操作日志/],
  ['template', /元数据模板|著录模板|模板字段|模板信息项/],
  ['stats', /档案统计|借阅统计|分类统计|档案总数|档案数量|借阅总数|借阅数量|分类总数|分类数量|档案趋势|借阅趋势|数据大盘|数据统计|统计数据|统计概览/],
];
/** 显式联合/全量信号：命中即四类全开（无需再凑够两个范围词）。 */
const UNIFIED_MULTI_RE =
  /联合检索|综合检索|统一检索|一起查|一并查|一块查|跨.{0,4}(检索|查询)|所有信息|全部信息|全部资料|各项信息|分别查/;
/** 单一范围检索信号：命中后结合 SEARCH_DIRECTIVE_RE 判断是否走 unified_search。 */
const UNIFIED_SINGLE_RE =
  /附件|文件名|文档名称|附件名称|正文|全文|原文|分类|类目|类别|借阅记录|借阅申请|操作审计|审计记录|审计日志|操作日志|元数据模板|著录模板|模板字段|模板信息项|档案统计|借阅统计|分类统计|档案总数|档案数量|借阅总数|借阅数量|分类总数|分类数量|档案趋势|借阅趋势|数据大盘|数据统计|(?:档案|条目).{0,8}(?:是|为|叫|名)/;
/** 附件格式提取：「格式为 pdf」「后缀 docx」或行文里直接出现「docx 文件」这类。 */
const EXTENSION_HINT_RE = /(?:格式|后缀|扩展名)\s*(?:是|为|:|：|的)?\s*\.?([A-Za-z0-9]{1,10})/;
const EXTENSION_INLINE_RE = /\b(docx?|pdf|txt|xls?x?|pptx?|csv|png|jpe?g)\b/i;
/** 附件列表类自然语言：不要求用户使用“检索/搜索”等固定开头。
 * 计数短语兼容「有/包含/包括/含/含有/共有」等动词与「几份/多少/哪些/什么」等量词，
 * 并允许「里面/里/中」等方位词后接动词（如「里面包含几份附件」），避免退化成整句关键词检索。 */
const ATTACHMENT_LIST_QUESTION_RE =
  /附件(?:名称|列表|清单)?(?:里面|中|内)?(?:有哪些|有什么|有几份?|有多少|一共有|分别是|清单|列表)|(?:有哪些|有什么|列出|展示|查看|看看).{0,12}附件|^.{2,80}?(?:里面|里|中|内部|之内)(?:的)?(?:一共?|分别)?(?:有|包含|包括|含|含有|共有)(?:哪些|什么|几份?|多少|几项|几个)附件(?:有哪些|有什么|列表|清单)?$|^.{2,80}?(?:的)?(?:一共?|分别)?(?:有|包含|包括|含|含有|共有)(?:哪些|什么|几份?|多少|几项|几个)附件(?:有哪些|有什么|列表|清单)?$|^.{2,80}?(?:的)?附件(?:有哪些|有什么|列表|清单)$/u;
/** 明确按附件文件名筛选，而不是把附件所属档案标题当成文件名。 */
const ATTACHMENT_FILE_NAME_RE =
  /(?:附件名称|附件名|文件名称|文件名)\s*(?:包含|含有|为|是|叫做?|名为|等于|[：:])?\s*[“"《]?([^，,。；;？?！!"”》]{2,80}?)(?=(?:的)?(?:有哪些|有什么|的附件|附件|文件|文档|列表|清单|[”"》]|$))/u;
/** 用户询问“谁修改/创建/删除/操作过档案”时，查询对象是审计记录，不是档案目录。 */
const AUDIT_ACTIVITY_QUESTION_RE =
  /(?:谁|哪些人|什么人).{0,12}(?:修改|编辑|创建|删除|归档|操作|查看|下载)|(?:修改|编辑|创建|删除|归档|操作|查看|下载).{0,10}(?:过|了).{0,8}(?:档案|附件|文件)|最近.{0,12}(?:谁|哪些人).{0,8}(?:操作|修改|编辑|创建|删除)|(?:操作记录|操作日志|审计记录|审计日志)/u;
/** 连续追问中依赖上一轮结果的代词，解析阶段只标记，不自行猜测具体档案。 */
const PREVIOUS_RESULT_REFERENCE_RE = /(?:这些|那些|它们|其中|这份|这几个|这几份|刚才那份|刚才那些|上面这些|上一条结果|前面提到的)/u;

// ==================== 第三阶段：业务办理意图（借阅申请 / 借阅进度 / 辅助著录） ====================

/**
 * 借阅进度/记录查询特征。
 * 必须优先于借阅申请判定：「我的借阅申请现在是什么状态」里含“借阅申请”，但显然是查进度。
 */
const BORROW_PROGRESS_RE =
  /(借阅进度|借阅状态|借阅情况|借阅记录|借阅历史|借阅详情|最近的借阅|我的借阅|哪些借阅|还在审核|审核中|审核了吗|审到哪|申请通过了?吗|通过了没有|批了没|被拒绝|被拒|为什么不通过|未通过的原因|借阅到哪一步|查.*(借阅|申请).*状态)/;
/** 借阅申请意图（含「能不能申请借阅」这类资格咨询）。 */
const BORROW_APPLY_RE =
  /(申请借阅|发起借阅|我要借阅|我想借阅|帮我借阅|想借阅|要借阅|可以借阅吗|能不能借阅|能否借阅|能不能申请借阅|可不可以借阅|申请.*借出|借这份|借阅这份|申请一份借阅|提交借阅)/;
/** 智能辅助著录意图（只表示「用户想整理著录信息」，能否写入由服务端权限与归档状态判定）。 */
const CATALOG_ASSIST_RE =
  /(辅助著录|智能著录|自动著录|档案著录|著录信息|著录|整理.{0,8}(档案|合同|协议|文件).{0,6}(信息|要素|字段|元数据)|提取.{0,8}(档案|合同|协议|文件).{0,6}(信息|要素|字段|元数据)|识别.{0,8}(档案|合同).{0,6}(信息|要素|字段)|归档信息|档案根底信息)/;
/** 借阅用途（现有借阅接口的必填字段；超出 500 字即丢弃，不自行添加后端不存在的必填字段）。 */
const PURPOSE_RE = /(?:借阅用途|借阅事由|借阅原因|借阅目的|用途|事由)(?:是|为|：|:)?\s*([^。；，,\n]{1,200})/;
/** 「用于项目审查」这类表述也当作用途。 */
const PURPOSE_USE_RE = /用于([^。；，,\n]{1,60})/;
/** 借阅期限（天/周/月），最终取值范围由现有接口规则 1-90 天在工具层再次校验。 */
const DAYS_RE = /(\d{1,3})\s*(?:个?自然日|天|日)/;
const WEEKS_RE = /(\d{1,2})\s*(?:个)?周/;
const MONTHS_RE = /(\d{1,2})\s*个?月/;
/** 查询范围信号：命中则建议走审核视角（最终仍由服务端按 borrowReview 权限裁决）。 */
const REVIEW_SCOPE_RE = /(待审核|审核中|所有借阅|全部借阅|全部申请|他人的|别人.{0,4}借阅|待办|所有申请)/;
/** 借阅状态词 → 现有业务真实状态键（不自创状态名，取值集合与 borrow_requests.status 一致）。 */
const BORROW_STATUS_PATTERNS: Array<[RegExp, string]> = [
  [/待审核|未审核|还没审|审核中|还没批|未批/, 'pending'],
  [/已通过|已批准|批了|批准了|借阅中|已借到/, 'approved'],
  [/被拒绝|已拒绝|驳回|不同意|拒了|没批/, 'rejected'],
  [/已归还|归还了|还了|退还/, 'returned'],
  [/已过期|过期了|超期/, 'expired'],
  [/已取消|撤销|作废/, 'cancelled'],
];
/** 业务问句里的结果词与疑问限定词：只表达「问到哪个状态」，不能当成档案名称去筛选记录（否则「哪些…还在审核中」会被误读为关键词）。 */
const BUSINESS_RESULT_RE =
  /(?:哪些|那些|还在|审核中|待审核|已通过|未通过|通过了吗|通过了没|是否通过|通过了|通过|批准了|批了没|批了|没批|驳回|被拒绝|已拒绝|拒了|拒绝|不同意|还没|已经|了没|超期|到期|续借|多久|何时|什么时候)/g;
/** 剥离业务话术后用于定位档案的噪声词（只用于提取检索对象，不影响意图判定）。 */
const BUSINESS_STRIP_RE =
  /(?:能不能申请借阅|能不能借阅|可不可以借阅|能否借阅|可以借阅吗|申请借阅|发起借阅|提交借阅|借阅申请|我要借阅|我想借阅|帮我借阅|想借阅|要借阅|借阅这份|借这份|申请一份借阅|申请|借阅|借出|归还|进度|状态|记录|历史|详情|情况|审核|为什么|原因|查询|查看|看看|列出|展示|帮我|我想|我要|麻烦|请问|一下|这份|这个|该|是否|能不能|可以|需要|应该|怎么|如何|在哪|现在|最近|全部|所有|一些|还有|吗|呢|了|的|吧|啊)/g;
/** 确认提交 / 取消申请的纯文本指令（只绑定服务端保存的待确认草稿，参数不来自模型）。 */
export const CONFIRM_TEXT_RE = /^(确认提交|确认申请|确认无误|确定提交|确认并提交|同意提交|提交吧|确认)[。！!～~]?$/;
export const CANCEL_TEXT_RE = /^(取消申请|取消提交|不提交了|先不提交|放弃|算了)[。！!～~]?$/;

/** 从问句中剥离业务话术，得到用于定位档案的检索词。 */
function extractBusinessTarget(question: string): { keyword?: string; title?: string } {
  const titleHint = question.match(TITLE_HINT_RE)?.[1];
  if (titleHint) {
    const cleaned = extractSearchTerm(titleHint) || trim(titleHint);
    if (cleaned) return { title: cleaned.slice(0, MAX_KEYWORD_LENGTH) };
  }
  const stripped = trim(question.replace(BUSINESS_STRIP_RE, ' ').replace(BUSINESS_RESULT_RE, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const residual = extractSearchTerm(stripped) || stripped;
  if (residual && residual.length >= 2 && !STOP_WORDS.has(residual)) {
    return { keyword: residual.slice(0, MAX_KEYWORD_LENGTH) };
  }
  return {};
}

/** 抽取借阅期限：优先天数，其次周/月换算；不在现有接口允许范围内的直接丢弃（不推断）。 */
export function extractBorrowDays(question: string): number | undefined {
  const dayHit = question.match(DAYS_RE);
  if (dayHit) {
    const n = Number(dayHit[1]);
    if (Number.isInteger(n) && n >= 1 && n <= 90) return n;
  }
  const weekHit = question.match(WEEKS_RE);
  if (weekHit) {
    const n = Number(weekHit[1]) * 7;
    if (n >= 1 && n <= 90) return n;
  }
  const monthHit = question.match(MONTHS_RE);
  if (monthHit) {
    const n = Number(monthHit[1]) * 30;
    if (n >= 1 && n <= 90) return n;
  }
  return undefined;
}

/** 抽取借阅用途（服务层在「待确认草稿续答」时也复用，故导出）。 */
export function extractBorrowPurpose(question: string): string | undefined {
  const hit = question.match(PURPOSE_RE)?.[1] ?? question.match(PURPOSE_USE_RE)?.[1];
  const text = hit ? trim(hit) : '';
  if (!text || text.length > 500) return undefined;
  return text;
}

/**
 * 业务办理意图解析（放在正文问答与高风险判定之前）：
 * 只识别「想办什么」与可用于定位真实档案的条件，不输出任何权限结论。
 */
function parseBusinessIntent(
  question: string,
  categories: CategoryHint[],
): { intent: ParsedIntent; strong: boolean } | null {
  const category = matchCategory(question, categories);
  const noHint = question.match(ARCHIVE_NO_HINT_RE)?.[1] ?? question.match(ARCHIVE_NO_RE)?.[0];
  const archiveNo = noHint && !/^\d{4}-\d{2}-\d{2}$/.test(noHint) ? noHint.slice(0, MAX_KEYWORD_LENGTH) : undefined;
  const target = extractBusinessTarget(question);

  // 1) 查进度优先于发起申请
  if (BORROW_PROGRESS_RE.test(question)) {
    const borrowStatus = BORROW_STATUS_PATTERNS.find(([re]) => re.test(question))?.[1];
    return {
      intent: {
        kind: 'borrow_progress',
        keyword: target.keyword,
        title: target.title,
        archiveNo,
        borrowStatus,
        dataScope: REVIEW_SCOPE_RE.test(question) && !/我的借阅|我提交的|我最近/.test(question) ? 'review' : 'mine',
      },
      strong: true,
    };
  }
  // 2) 发起借阅申请（含资格咨询：先查档案、再查资格、后收集信息）
  if (BORROW_APPLY_RE.test(question) || BORROW_GUIDE_RE.test(question)) {
    return {
      intent: {
        kind: 'borrow_apply',
        keyword: target.keyword,
        title: target.title,
        archiveNo,
        categoryId: category?.id,
        categoryName: category?.name,
        purpose: extractBorrowPurpose(question),
        days: extractBorrowDays(question),
      },
      strong: true,
    };
  }
  // 3) 智能辅助著录
  if (CATALOG_ASSIST_RE.test(question)) {
    return {
      intent: {
        kind: 'catalog_suggest',
        keyword: target.keyword,
        title: target.title,
        archiveNo,
      },
      strong: true,
    };
  }
  return null;
}

/** 语气/前缀虚词：用于从问句中剥离出检索对象词（顺序即删除优先级，长在前）。 */
const NOISE_PREFIXES = [
  '所以我', '那么', '那我', '所以', '我目前', '我现在', '我的', '我',
  '请帮我', '帮我', '麻烦', '请问', '查找一下', '查一下', '找一下', '搜索一下',
  '帮我查找', '帮我查', '帮我找', '我想查找', '我想查', '我想找', '需要查找', '查找', '检索', '搜索', '查寻', '查询', '找找', '查查', '找到', '查找有关', '有关', '关于', '所有', '全部', '一些', '是否有', '有没有', '有没', '列出', '展示', '显示', '看看', '查', '找',
].sort((a, b) => b.length - a.length);
const NOISE_SUFFIXES = [
  '的档案', '档案', '的记录', '记录', '的文件', '文件', '的条目', '条目', '资料', '有哪些', '有什么', '是什么', '呢', '吗', '了', '的',
];
/** 中文单字虚词：作为独立检索词无意义（避免「的」「了」等命中全库）。 */
const STOP_WORDS = new Set(['的', '了', '和', '与', '及', '或', '是', '有', '在', '我', '你', '他', '她', '它', '这', '那', '吗', '呢', '吧', '啊']);

/** 纯粹的重答请求：必须从当前会话历史恢复上一条有效问题，不能当作新检索词。 */
const REANSWER_ONLY_RE = /^(?:请|麻烦)?(?:你)?(?:(?:重新回答|再回答|重新答|再答)(?:一下|一次)?(?:我)?(?:刚刚|刚才|上一条|前面)?(?:的)?(?:问题|提问)?|回答(?:一下)?(?:我)?(?:刚刚|刚才|上一条|前面)?(?:的)?(?:问题|提问)|把(?:我)?(?:刚刚|刚才|上一条|前面)?(?:的)?(?:问题|提问)重新回答)[。！!？?～~]*$/;

/** 用户纠正前一句话时，只剥离纠正话术，保留其真正想问的内容。 */
export function normalizeFollowUpQuestion(raw: string): string {
  let question = trim(raw);
  question = question.replace(/^(?:我说的是|我说|我的意思是|我是说|不对|不是|我刚才问的是|我刚刚问的是|我问的是)\s*/u, '');
  question = question.replace(/^(?:重新回答|再回答|重新答|再答)(?:一下|一次)?(?:我)?(?:刚刚|刚才|上一条|前面)?(?:的)?(?:问题|提问)[，,。:：\s]*/u, '');
  return trim(question);
}

export function isReanswerRequest(question: string): boolean {
  return REANSWER_ONLY_RE.test(trim(question));
}

function trim(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 统一自然语言预处理：去掉礼貌表达、提问引导词和句末语气词，
 * 保留档案名称、档号、附件名称、业务动作等真实语义。
 */
export function normalizeAgentQuestion(raw: string): string {
  let question = trim(raw);
  const prefixes = [
    '那么', '所以', '那你', '帮我看看', '我目前', '我现在',
    '麻烦你帮我查找一下', '麻烦帮我查找一下', '请你帮我查找一下', '请帮我查找一下',
    '麻烦你帮我查询一下', '麻烦帮我查询一下', '请你帮我查询一下', '请帮我查询一下',
    '麻烦你帮我检索一下', '麻烦帮我检索一下', '请你帮我检索一下', '请帮我检索一下',
    '麻烦你帮我看一下', '麻烦帮我看一下', '请你帮我看一下', '请帮我看一下',
    '麻烦你帮我查一下', '麻烦帮我查一下', '请你帮我查一下', '请帮我查一下',
    '麻烦你帮我找一下', '麻烦帮我找一下', '请你帮我找一下', '请帮我找一下',
    '能不能告诉我', '可不可以告诉我', '可以告诉我', '你告诉我', '请告诉我', '麻烦告诉我', '告诉我',
    '我想知道', '我想了解一下', '我想了解', '我想问一下', '我想问',
    '我想查找一下', '我想查询一下', '我想检索一下', '我想查一下', '我想找一下', '我想看一下',
    '帮我查找一下', '帮我查询一下', '帮我检索一下', '帮我查一下', '帮我找一下', '帮我看一下',
    '帮忙查找一下', '帮忙查询一下', '帮忙检索一下', '帮忙查一下', '帮忙找一下', '帮忙看一下',
    '请问一下', '请问', '麻烦你', '麻烦', '请你', '请',
  ];
  let changed = true;
  while (changed) {
    changed = false;
    // Preserve “我想找…” so the search directive can still be recognized.
    if (question.startsWith('那我')) { question = question.slice(1); changed = true; }
    for (const prefix of prefixes) {
      if (question.startsWith(prefix)) {
        question = trim(question.slice(prefix.length).replace(/^[，,：:\s]+/u, ''));
        changed = true;
        break;
      }
    }
  }
  // “吗”在“通过了吗/审批了吗”等业务问句中承担意图信号，不能提前删除。
  return trim(question.replace(/[，,。；;：:？?！!]+$/u, '').replace(/(?:呢|呀|嘛|啊)$/u, ''));
}

/** 清洗从自然语言中提取的档案标题，避免把“档案/文档”等对象词当成标题。 */
function cleanArchiveTitleCandidate(raw?: string): string | undefined {
  if (!raw) return undefined;
  let value = trim(raw)
    .replace(/^(?:请?帮我|麻烦)?(?:查找|搜索|检索|查询|找一下|查一下|找|查)/u, '')
    .replace(/相关$/u, '')
    .replace(/^[《「“"']+|[》」”"']+$/gu, '')
    .replace(/^[的之\s]+/u, '')
    .replace(/[的之\s]+$/u, '')
    .replace(/(?:档案|文档|文件)$/u, '')
    // “项目建设这个档案”“这份档案”里的指示词只是给档案名做补语，不属于标题本身；
    // 不剥掉就会拿“项目建设这个”去匹配标题，真实档案命不中。
    .replace(/(?:这|那)(?:些|个|份|件)?$/u, '')
    .replace(/(?:该|此)$/u, '')
    .replace(/[的之\s]+$/u, '');
  value = trim(value);
  if (value.length < 2 || value.length > MAX_KEYWORD_LENGTH) return undefined;
  if (
    /^(?:档案|附件|文件|文档|合同|资料|全部|所有|这些|那些|当前|目前|系统|本系统|现在)$/u.test(value) ||
    /^(?:我|我们|当前|目前|系统|本系统|现在)(?:有哪些|有什么|有几份?|有多少|的)?$/u.test(value) ||
    /^(?:哪个|哪些|哪份|哪一份|有什么|有哪些)/u.test(value)
  ) return undefined;
  return value;
}

/** 从“PPP里面的附件有哪些”“PPP合同主要讲了什么”中抽取所属档案标题。 */
export function extractArchiveTitleFromQuestion(question: string): string | undefined {
  const text = normalizeAgentQuestion(question);
  const namedArchive = text.replace(/^(?:帮我|帮忙)?(?:分析|统计|核对|查看)\s*/u,'')
    .match(/^(.{2,80}?)(?:这|那)(?:一|个|份)?档案/u)?.[1];
  if (namedArchive) return cleanArchiveTitleCandidate(namedArchive);
  // 只有明确的“标题/题名”表达才按档案标题处理；
  // “档案名称包含采购”是关键词筛选，不应把“包含采购”误识别成标题值。
  const explicit = text.match(/(?:档案标题|档案题名|标题|题名)(?:是|为|:\s*|：\s*)?[「《"'']?([^」》"'']{2,100})/u)?.[1];
  if (explicit) return cleanArchiveTitleCandidate(extractSearchTerm(explicit) || explicit);
  const paymentTitle = text.match(/^(?:我们的|我方的|请问|请帮我查一下)?(.{2,60}?(?:合同|协议))(?:规定|约定|要求).{0,18}(?:付款|支付)/u)?.[1];
  if (paymentTitle) return cleanArchiveTitleCandidate(paymentTitle);
  if (!/档案名称|关键词|包含|含有/u.test(text)) {
    const scopedContent = text.match(/^(.{2,80}?)(?:里面的|中的|里的|的)(?:附件(?:中的|里的|的)?)?(?:正文|全文|条款|内容|付款|支付|履约|履行|违约|金额|质保金|保证金|预付款|尾款|争议解决|验收标准|签订|交付|生效)/u)?.[1]
      ?? text.match(/^(.{2,60}?(?:合同|协议))(?:中|里)?(?:的)?(?:付款|支付|违约|履约|履行|金额|签订|生效|交付)/u)?.[1];
    const candidate = cleanArchiveTitleCandidate(scopedContent);
    if (candidate) return candidate;
  }
  const patterns = [
    /^(?:查找|搜索|检索|查询|找|查)?(.{2,80}?)的档案[、和与及].*附件/u,
    /^(.{2,80}?)(?:档案|文档|文件)?(?:里面|之中|中的|内的|内部|之内)(?:的)?(?:附件|文件|文档)(?:名称)?(?:有哪些|有什么|有几份?|有多少|列表|清单|包含|包括)?$/u,
    /^(?:查找|搜索|检索|查询|找|查)?(.{2,80}?)的(?:档案和附件|档案及附件|文件和附件)$/u,
    /^(.{2,80}?)(?:里面|里|中|内部|之内)(?:的)?(?:一共?|分别)?(?:有|包含|包括|含|含有|共有)(?:哪些|什么|几份?|多少|几项|几个)附件(?:有哪些|有什么|列表|清单)?$/u,
    /^(.{2,80}?)(?:的)?(?:一共?|分别)?(?:有|包含|包括|含|含有|共有)(?:哪些|什么|几份?|多少|几项|几个)附件(?:有哪些|有什么|列表|清单)?$/u,
    /^(.{2,80}?)(?:的)?附件(?:有哪些|有什么|列表|清单)$/u,
    /^(.{2,80}?)(?:主要|具体|大概|到底)?(?:讲了什么|讲的是什么|写了什么|写的是什么|内容是什么|主要内容|核心内容|约定了什么|规定了什么|说了什么|有哪些条款|条款有哪些)/u,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = cleanArchiveTitleCandidate(match?.[1]);
    if (candidate) return candidate;
  }
  return undefined;
}

/** 从“附件名称包含验收报告”中抽取附件文件名，不与所属档案标题混用。 */
export function extractAttachmentFileName(question: string): string | undefined {
  const text = normalizeAgentQuestion(question);
  const match = text.match(ATTACHMENT_FILE_NAME_RE);
  const contentName = text.match(/(?:附件名称|附件名|文件名称|文件名)\s*(?:包含|含有|为|是|叫做?|名为|等于|[：:])?\s*[“"《]?(.{2,100}?)(?:的)?(?:内容是什么|里面写了什么|主要内容|全文总结)/u)?.[1];
  const candidate = trim(contentName ?? match?.[1] ?? '').replace(/[”"》]+$/u, '').replace(/[的\s]+$/u, '');
  if (!candidate || candidate.length < 2 || candidate.length > MAX_KEYWORD_LENGTH) return undefined;
  if (/^(?:哪些|什么|所有|全部|附件|文件|文档)$/u.test(candidate)) return undefined;
  return candidate;
}

/** Literal file entities only; task interpretation remains the model planner's job. */
export function extractAttachmentNames(question: string): string[] {
  const quoted = [...question.matchAll(/[《「“"]([^》」”"\r\n]+\.[a-zA-Z0-9]{1,8})[》」”"]/gu)].map(m => m[1].trim());
  const labelled = extractAttachmentFileName(question);
  return [...new Set([...quoted, ...(labelled && /\.[a-zA-Z0-9]{1,8}$/u.test(labelled) ? [labelled] : [])])];
}

/** A degraded lookup may use explicit fields, never a residual natural-language sentence. */
export function safeDeterministicLookup(question: string, parsed: ParsedIntent): ParsedIntent | null {
  if (/分析|比较|对比|总结|概括|风险|建议|差异|正文|内容|进度|未完成/u.test(question)) return null;
  if (!['search', 'archive_info', 'unified_search'].includes(parsed.kind)) return null;
  if (parsed.queryReference) return null;
  if (parsed.archiveNo || parsed.title || parsed.attachmentFileName) return parsed;
  if (parsed.kind === 'search' && !parsed.keyword) return parsed;
  if (parsed.keyword && /(?:关键词|包含|含有)\s*[：:]?/u.test(question)) return parsed;
  return null;
}

/** Search hypotheses only. Explicit scope is derived from the user's words, never model IDs. */
export function structureRetrievalIntent(question: string, legacy: ParsedIntent): ParsedIntent {
  const text = normalizeAgentQuestion(question);
  const clean = (value: string) => value.replace(/^[《「“"']|[》」”"']$/gu, '').replace(/的$/u, '').trim();
  const candidates = (values: Array<string | undefined>) => [...new Set(values.map(v => clean(v ?? '')).filter(v => v.length >= 2 && v.length <= 100))].slice(0, 6);
  const mention = text.match(/(?:哪个|哪些|哪份|哪一份).{0,8}(?:附件|文件).{0,8}(?:提到了?|涉及|包含|写到)\s*(.+)$/u)?.[1];
  const globalQuery = !!mention || /(?:所有|整个系统|全系统|跨档案).{0,12}(?:档案|附件|正文)/u.test(text);
  const topic = text.replace(/(?:里面|里|中)?(?:的)?(?:主要|核心)?(?:内容是什么|写了什么|写的是什么|讲了什么|主要内容|核心内容|内容总结|全文总结).*$/u, '').replace(/^(?:总结|概括|摘要)(?:一下)?/u, '').trim();
  const name = extractAttachmentFileName(text);
  const declaredTitle = text.match(/(?<!附件|文件|文档)(?:档案标题|档案题名|标题|题名)\s*(?:为|是|[：:])?\s*[《「“"']?(.{2,100}?)(?=的(?:档案|附件|内容|正文|全文)|[》」”"'，,。；;？?]|$)/u)?.[1];
  const metadataQuery = /(?:元数据|著录|责任者|关键词)\s*(?:为|是|包含|[：:])/u.test(text);
  const title = globalQuery || (metadataQuery && !declaredTitle) ? undefined : (declaredTitle ?? legacy.title ?? extractArchiveTitleFromQuestion(text))
    ?.replace(/的(?:主要)?(?:内容|正文|全文)(?:是什么)?$/u, '');
  const stem = topic.replace(/(?:的)?(?:附件|正文|文件|文档|资料)$/u, '').replace(/的$/u, '').trim();
  const ambiguousAttachment = /附件|正文|文件|文档|资料|工作总结/u.test(topic) || !!name;
  const archiveTitleCandidates = declaredTitle ? candidates([declaredTitle]) : candidates([title?.replace(/(?:的)?附件(?:里面|里|中)?$/u, ''), !mention && topic !== text ? stem : undefined, ...(legacy.archiveTitleCandidates ?? [])]);
  const attachmentNameCandidates = candidates([name, !mention && topic !== text ? topic.replace(/的附件/u, '附件') : undefined,
    !mention && (ambiguousAttachment || /工作总结/u.test(topic)) ? stem : undefined, ...(legacy.attachmentNameCandidates ?? [])]);
  // A filename may look like an archive name; keep both hypotheses without turning either into authority.
  const explicit = !!legacy.archiveNo || legacy.categoryId !== undefined || legacy.status !== undefined || (metadataQuery && !globalQuery) || (!globalQuery && (
    !!declaredTitle || /档案[《「“"]|[》」”"]档案|^(?:指定)?档案|(?:仅|只)(?:在|限)|指定档案/u.test(text) ||
    (!!title && !ambiguousAttachment && !/\.(?:pdf|docx?|txt)$/iu.test(title))));
  const metadataTerms = candidates([...text.matchAll(/(?:元数据|著录|责任者|关键词)\s*(?:为|是|包含|[：:])\s*([^，,。；;？?]{2,100}?)(?=的(?:档案|附件|合同|正文|内容)|[，,。；;？?]|$)/gu)].map(m => m[1]).concat(legacy.metadataTerms ?? []));
  const contentText = (mention ?? text).replace(legacy.archiveNo ?? /$^/u, ' ').replace(explicit && title ? title : /$^/u,' ')
    .replace(/档号|编号|(?:里面|里|中)?写了什么|内容是什么|(?:的)?附件|正文|全文|什么|多少|怎么|如何|是否|的|是|吗/gu, ' ');
  const terms = extractQuestionTerms(`${contentText}？`);
  const summary = isSummaryQuestion(text);
  return { ...legacy, title: archiveTitleCandidates[0] ?? legacy.title, attachmentFileName: name ?? legacy.attachmentFileName,
    intentType: legacy.kind === 'content_question' ? summary ? 'content_summary' : 'content_qa' : legacy.kind === 'archive_info' ? 'archive_info' : legacy.kind === 'unified_search' ? 'attachment_query' : 'archive_list',
    archiveTitleCandidates, archiveNumber: legacy.archiveNo, attachmentNameCandidates, metadataTerms,
    contentTerms: candidates([...terms.strong, ...terms.weak, ...(legacy.contentTerms ?? [])]), contentScope: explicit ? 'archive' : 'global',
    isSummaryQuestion: summary, isExplicitScope: explicit };
}

export function detectAttachmentQueryMode(question: string): 'list' | 'file_name' | undefined {
  const text = normalizeAgentQuestion(question);
  // 档号已经是精确定位条件，不能把“档号为…的附件”误识别成档案标题列表。
  // 明确的多业务对象联合查询不能被降级成仅附件列表。
  if (/(?:档案和附件|档案及附件|文件和附件|附件.{0,6}(?:和|及|与).{0,6}(?:正文|档案|分类|借阅|审计|模板|统计)|(?:正文|档案|分类|借阅|审计|模板|统计).{0,6}(?:和|及|与).{0,6}附件)/u.test(text)) return undefined;
  if (extractAttachmentFileName(text)) return 'file_name';
  if (ATTACHMENT_LIST_QUESTION_RE.test(text)) return 'list';
  return undefined;
}

/** 连续追问是否需要回溯上一轮结果；本阶段只产生显式标记，不猜测实体 ID。 */
export function hasPreviousResultReference(question: string): boolean {
  return PREVIOUS_RESULT_REFERENCE_RE.test(normalizeAgentQuestion(question));
}

/** 剥离前后缀虚词与标点，得到可用于 LIKE 匹配的核心检索词。 */
export function extractSearchTerm(raw: string): string {
  let text = normalizeAgentQuestion(raw);
  // 去掉句末标点与疑问语气，保留中间内容
  text = text.replace(/[，,。.;；:：?？!！、]+$/g, '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of NOISE_PREFIXES) {
      if (text.startsWith(p)) {
        text = text.slice(p.length);
        changed = true;
      }
    }
    for (const s of NOISE_SUFFIXES) {
      if (text.endsWith(s)) {
        text = text.slice(0, text.length - s.length);
        changed = true;
      }
    }
    text = trim(text.replace(/^[，,。.;；:：?？!、\s「」《》"']+/g, ''));
  }
  // Several particles together are still noise; never treat “那我/所以我/我的” as a subject.
  if (!text || [...text].every(char => STOP_WORDS.has(char))) return '';
  return text;
}

/** 统一检索专用关键词提取：从「查找文件名包含星辰的附件」这类句式中提取核心检索词。 */
export function extractUnifiedKeyword(question: string): string | undefined {
  question = normalizeAgentQuestion(question);
  // 匹配模式：[包含|含有|是|为] + [关键词] + [的|，|。|$]
  const patterns = [
    /(?:关键词|关键字)\s*(?:是|为|:)\s*([^\s，,。？?！!]{2,50})/,
    /(?:包含|含有|为|是)\s*([^\s的，,。？?！!]{2,50}?)(?:\s*的|\s*[，,。？?！!]|$)/,
    /(?:名叫|名为|叫)\s*([^\s的，,。？?！!]{2,50}?)(?:\s*的|\s*[，,。？?！!]|$)/,
  ];
  for (const re of patterns) {
    const match = question.match(re);
    if (match && match[1]) {
      const keyword = trim(match[1]);
      if (keyword && keyword.length >= 2 && !STOP_WORDS.has(keyword)) {
        return keyword.slice(0, MAX_KEYWORD_LENGTH);
      }
    }
  }
  // 兜底：尝试提取「查找/搜索 + [类型] + [关键词]」模式
  const fallback = question.match(/(?:查找|搜索|检索|查询|查|找)\s*(?:文件名|附件|正文|全文|档案|分类|类目|借阅记录|操作审计|审计记录|元数据模板|模板字段)?\s*([^\s的，,。？?！!相关]{2,30}?)(?:\s*的|\s*相关|\s*[，,。？?！!]|$)/);
  if (fallback && fallback[1]) {
    const keyword = trim(fallback[1]);
    if (keyword && keyword.length >= 2 && !STOP_WORDS.has(keyword) && !/文件名|附件|正文|全文|档案|分类|类目|类别|借阅|审计|模板|统计|最近|今天|昨天|今日|昨日/.test(keyword)) {
      return keyword.slice(0, MAX_KEYWORD_LENGTH);
    }
  }
  // 去除检索范围词与时间修饰，保留跨业务查询共用的主题词（如「星辰档案和借阅记录」→「星辰」）。
  const cleaned = trim(question
    .replace(/最近\s*(?:7|30|90)\s*(?:天|日)|最近一周|最近一个月|最近三个月|今天|今日|昨天|昨日/g, ' ')
    .replace(/请帮我|帮我|麻烦|请问|查找|搜索|检索|查询|查看|列出|展示|看看|所有|全部|相关|信息|记录|状态|申请|审批|待审核|未审核|审核中|待处理|已处理|已通过|已批准|借阅中|已拒绝|被拒绝|已归还|已过期|已取消|统计|概览|数据大盘|数据统计|档案统计|借阅统计|分类统计|档案总数|档案数量|借阅总数|借阅数量|分类总数|分类数量|档案趋势|借阅趋势|操作审计|审计记录|审计日志|操作日志|元数据模板|著录模板|模板字段|模板信息项|借阅进度|借阅历史|借阅|档案|条目|附件|文件名|文档|资料|格式|后缀|扩展名|正文|全文|原文|条款|分类|类目|类别|的/g, ' ')
    .replace(/[和与及、，,。？?！!]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
  if (cleaned.length >= 2 && cleaned.length <= MAX_KEYWORD_LENGTH && !STOP_WORDS.has(cleaned)) return cleaned;
  return undefined;
}

/** 真实分类候选（名称/编码），由服务层从既有分类仓储取得——不信任模型给出的分类。 */
export interface CategoryHint {
  id: number;
  name: string;
  code: string;
}

/** 在提问中匹配真实存在的分类（按名称长度降序，优先更具体的子分类）。 */
export function matchCategory(question: string, categories: CategoryHint[]): CategoryHint | null {
  const sorted = [...categories].sort((a, b) => b.name.length - a.name.length);
  for (const c of sorted) {
    const name = trim(c.name);
    if (name.length >= 2 && question.includes(name)) return c;
  }
  return null;
}

export interface DeterministicParseInput {
  question: string;
  categories: CategoryHint[];
}

/** 统一检索识别结果：生效范围（有序）与可选附件格式。 */
export interface UnifiedDetect {
  scopes: SearchScope[];
  extension?: string;
  timeRange?: SearchTimeRange;
}

/**
 * 判断是否应走统一检索（多业务联合查询或单业务范围检索）：
 * - 命中两个及以上不同范围 → 仅激活命中的范围（按固定顺序去重）；
 * - 命中显式联合/全量信号但没有具体范围词 → 四类全开；
 * - 仅命中单一范围但有明确检索指令 → 路由到 unified_search（单范围检索）；
 * - 无范围信号 → 返回 null（交回既有 search/content_question 链路）。
 * 只做「范围识别」，不识别具体检索条件（条件仍由各检索分支统一解析）。
 */
function cleanArchiveNoHint(value?: string): string | undefined {
  if (!value) return undefined;
  // 档号采用系统生成的字母/数字/下划线/连字符格式；剔除「的附件」「的档案」等后续自然语言。
  return value.trim().match(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}/)?.[0];
}

export function extractSearchTimeRange(question: string): SearchTimeRange | undefined {
  if (/今天|今日/.test(question)) return 'today';
  if (/昨天|昨日/.test(question)) return 'yesterday';
  if (/最近\s*(?:7|七)\s*(?:天|日)|最近一周/.test(question)) return '7d';
  if (/最近\s*(?:30|三十)\s*(?:天|日)|最近一个月/.test(question)) return '30d';
  if (/最近\s*(?:90|九十)\s*(?:天|日)|最近三个月/.test(question)) return '90d';
  return undefined;
}

export function detectUnified(question: string): UnifiedDetect | null {
  question = normalizeAgentQuestion(question);
  const hit = new Set<SearchScope>();
  for (const [scope, re] of UNIFIED_SCOPE_SIGNALS) {
    if (re.test(question)) hit.add(scope);
  }

  const attachmentMode = detectAttachmentQueryMode(question);
  const extension = question.match(EXTENSION_HINT_RE)?.[1] ?? question.match(EXTENSION_INLINE_RE)?.[1];
  const hasArchiveNo = !!(question.match(ARCHIVE_NO_HINT_RE)?.[1] ?? question.match(ARCHIVE_NO_RE)?.[0]);
  if (attachmentMode || (extension && (hasArchiveNo || /附件|文件|文档/.test(question)))) {
    hit.add('attachment');
  }

  const auditActivity = AUDIT_ACTIVITY_QUESTION_RE.test(question) || /(?:修改|编辑|创建|删除|下载)档案的操作审计/u.test(question);
  if (auditActivity) {
    hit.add('audit');
    // “谁修改过档案”中的“档案”是审计对象，不代表同时检索档案目录。
    if (!/(?:档案有哪些|有哪些档案|列出档案|档案列表|档案总数|档案[、和与及])/u.test(question)) hit.delete('archive');
  }

  const multi = UNIFIED_MULTI_RE.test(question);
  const directArchiveSearch =
    hit.size === 1 && hit.has('archive') && /^(?:查找|搜索|检索|查询)/.test(question.trim()) && /档案$/.test(question.trim());
  const singleExplicit =
    hit.size === 1 && (
      (SEARCH_DIRECTIVE_RE.test(question) && UNIFIED_SINGLE_RE.test(question)) ||
      directArchiveSearch ||
      attachmentMode !== undefined ||
      auditActivity ||
      (!!extension && hasArchiveNo)
    );
  if (hit.size === 0 && !multi) return null;
  if (hit.size === 1 && !multi && !singleExplicit) return null;
  const scopes =
    hit.size >= 2 ? SEARCH_SCOPES.filter((s) => hit.has(s)) : multi ? [...DEFAULT_UNIFIED_SCOPES] : [...hit];
  return {
    scopes,
    extension: extension ? extension.toLowerCase() : undefined,
    timeRange: extractSearchTimeRange(question),
  };
}

/**
 * 确定性解析：规则可覆盖「档号 / 分类 / 标题 / 关键词 / 状态」以及边界类问题。
 * strong 表示得到了明确检索条件（此时无需调用模型即可直接检索）。
 */
export function parseDeterministic(input: DeterministicParseInput): { intent: ParsedIntent; strong: boolean } {
  const parsed = parseRules(input);
  if (['search', 'archive_info', 'unified_search'].includes(parsed.intent.kind)) {
    return { ...parsed, intent: structureRetrievalIntent(input.question, parsed.intent) };
  }
  return parsed;
}

function parseRules(input: DeterministicParseInput): { intent: ParsedIntent; strong: boolean } {
  const question = normalizeAgentQuestion(input.question);
  if (!question) return { intent: { kind: 'unparsed' }, strong: false };

  // 1) 检索方法咨询 / 业务办理 / 正文问答 / 高风险操作优先判定（避免被当成关键词检索）
  if (HELP_QUESTION_RE.test(question)) {
    return { intent: { kind: 'help' }, strong: true };
  }
  // 1.1) 第三阶段：业务办理意图（借阅申请 / 借阅进度 / 辅助著录）——
  // 必须早于正文问答与高风险判定，否则「借阅用途是项目审查」「整理合同信息」会被误拦。
  const multiUnified = detectUnified(question);
  const globalContentQuestion = /(?:所有|整个系统|全系统|跨档案).{0,12}(?:档案|附件|正文)/u.test(question) &&
    /正文|内容|付款|违约|条款/u.test(question) && !/借阅|审计|操作记录|删除|修改/u.test(question);
  const isContentAnswer = globalContentQuestion || CONTENT_MENTION_RE.test(question) ||
    /多少天.{0,6}(?:付款|支付)|(?:付款|支付).{0,8}多少天/u.test(question) ||
    CONTENT_QUESTION_RE.test(question) || (COMPARE_QUESTION_RE.test(question) && CONTENT_OBJECT_RE.test(question));
  const queryReference = hasPreviousResultReference(question) ? 'previous_results' as const : undefined;
  const attachmentMode = detectAttachmentQueryMode(question);
  const attachmentFileName = extractAttachmentFileName(question);
  const archiveTitle = extractArchiveTitleFromQuestion(question);
  const noHintForAttachment = cleanArchiveNoHint(question.match(ARCHIVE_NO_HINT_RE)?.[1] ?? question.match(ARCHIVE_NO_RE)?.[0]);

  // 明确的附件列表/文件名查询优先于普通关键词解析。所属档案标题与附件文件名分开存储，
  // 不再把“你告诉我PPP里面的附件有哪些”整句塞进 keyword。
  if (attachmentMode && !isContentAnswer) {
    const keyword = attachmentFileName ?? (!archiveTitle && !noHintForAttachment ? extractUnifiedKeyword(question) : undefined);
    return {
      intent: {
        kind: 'unified_search',
        scopes: ['attachment'],
        title: noHintForAttachment ? undefined : archiveTitle,
        archiveNo: noHintForAttachment,
        keyword,
        attachmentFileName,
        attachmentMode,
        extension: multiUnified?.extension,
        queryReference,
      },
      strong: true,
    };
  }

  // 审计活动问句的“档案”通常是操作对象，不是档案目录检索条件。
  // 允许“最近7天谁修改过档案”直接进入只读审计查询，无需用户再补充“审计记录”四个字。
  if (multiUnified?.scopes.length === 1 && multiUnified.scopes.includes('audit')) {
    return {
      intent: {
        kind: 'unified_search',
        scopes: ['audit'],
        title: archiveTitle,
        archiveNo: noHintForAttachment,
        timeRange: multiUnified.timeRange,
        queryReference,
      },
      strong: true,
    };
  }

  // 多业务联合查询优先于「借阅记录」单业务意图；借阅申请、辅助著录和真正的正文问答仍走原专用链路。
  if (
    multiUnified && multiUnified.scopes.length >= 2 &&
    !BORROW_APPLY_RE.test(question) && !CATALOG_ASSIST_RE.test(question) &&
    !(isContentAnswer && (!SEARCH_DIRECTIVE_RE.test(question) || INTERROGATIVE_MARKER_RE.test(question)))
  ) {
    const noHint = cleanArchiveNoHint(question.match(ARCHIVE_NO_HINT_RE)?.[1] ?? question.match(ARCHIVE_NO_RE)?.[0]);
    const category = matchCategory(question, input.categories);
    return {
      intent: {
        kind: 'unified_search',
        keyword: noHint || archiveTitle ? undefined : extractUnifiedKeyword(question),
        archiveNo: noHint ? noHint.slice(0, MAX_KEYWORD_LENGTH) : undefined,
        title: archiveTitle,
        categoryId: category?.id,
        categoryName: category?.name,
        status: archiveStatus(question),
        borrowStatus: BORROW_STATUS_PATTERNS.find(([re]) => re.test(question))?.[1],
        scopes: multiUnified.scopes,
        extension: multiUnified.extension,
        timeRange: multiUnified.timeRange,
        attachmentFileName,
        attachmentMode,
        queryReference,
      },
      strong: true,
    };
  }
  const business = parseBusinessIntent(question, input.categories);
  if (business) return business;
  if (isContentAnswer) {
    // 「查找付款条件相关的档案」这类祈使句仍是目录检索，不当作正文问答
    const isContentAsk = globalContentQuestion || !SEARCH_DIRECTIVE_RE.test(question) || INTERROGATIVE_MARKER_RE.test(question);
    if (isContentAsk) {
      // 同时解析问句里的档号/标题线索：第二阶段需要据此把取证范围锁定到具体档案
      const noHint = cleanArchiveNoHint(question.match(ARCHIVE_NO_HINT_RE)?.[1] ?? question.match(ARCHIVE_NO_RE)?.[0]);
      const titleHintRaw = question.match(TITLE_HINT_RE)?.[1];
      const cleanedTitle = titleHintRaw ? extractSearchTerm(titleHintRaw) || trim(titleHintRaw) : undefined;
      const category = matchCategory(question, input.categories);
      const naturalTitle = globalContentQuestion ? undefined : extractArchiveTitleFromQuestion(question);
      return {
        intent: structureRetrievalIntent(question, {
          kind: 'content_question',
          archiveNo: noHint ? noHint.slice(0, MAX_KEYWORD_LENGTH) : undefined,
          title: (cleanedTitle || naturalTitle)?.slice(0, MAX_KEYWORD_LENGTH),
          categoryId: category?.id,
          categoryName: category?.name,
          queryReference,
        }),
        strong: true,
      };
    }
  }
  if (UNSUPPORTED_ACTION_RE.test(question)) {
    return { intent: { kind: 'unsupported' }, strong: true };
  }

  // 状态型只读问题（如「我有哪些文档已经归档？」）不需要关键词；直接按档案状态查询，
  // 避免把「文档/档案」等对象词误当成标题关键词，也避免把「已归档」当成执行归档命令。
  const statusOnly = archiveStatus(question);
  const statusResidual = question.replace(/(?:尚未|已经|还没|未|已|待)?归档|草稿|著录中|正式档案|只读档案/gu,'')
    .replace(/告诉我|帮我|请|找出|目前|现在|当前|哪些|有什么|有多少|有|吗|的|是|状态|档案|文档|文件|资料|合同|全部|所有|列出|展示|查询|查找|检索|查看|我|了|[\s\p{P}]/gu,'');
  if (
    statusOnly &&
    (!statusResidual || !!matchCategory(question,input.categories) && statusResidual === matchCategory(question,input.categories)?.name) &&
    /档案|文档|文件|资料|合同/.test(question) &&
    /哪些|有|状态|列出|展示|查询|查找|检索|查看|找出|目前|现在|已经|已/.test(question)
  ) {
    const category = matchCategory(question, input.categories);
    return { intent: { kind: 'search', status: statusOnly, categoryId:category?.id, categoryName:category?.name }, strong: true };
  }
  if (/^(?:难道)?没有未归档的?(?:档案|文件|文档)(?:吗|么)?[？?。]?$/u.test(question)) {
    return { intent: { kind: 'search' }, strong: true };
  }

  // 无具体标题/档号/关键词的档案列表问题应直接列出当前用户有权查看的档案，
  // 不要把“我有哪些文件”清洗成空关键词后交给模型猜测，也不要把“所有”误当关键词。
  const isArchiveListQuestion =
    /档案|文件|文档|资料/.test(question) &&
    /有哪些|有什么|有多少|列出|展示|显示|查询|查看|查找|检索|看看|全部|所有|目前|当前|现在|我的/.test(question) &&
    !question.match(TITLE_HINT_RE) &&
    !question.match(KEYWORD_HINT_RE) &&
    !question.match(ARCHIVE_NO_HINT_RE) &&
    (() => {
      const residual = trim(question
        .replace(/所以我|那么|那我|所以|我目前|我现在|目前|现在|当前|请帮我|帮我|替我|请问|麻烦|请|我的|我|都有哪些|有哪些|有什么|有多少|列出|展示|显示|查询|查看|查找|检索|看看|查一下|找一下|所有|全部|可查看的|有权限查看的|档案|文件|文档|资料|列表|清单|呢|吗|啊|呀|嘛/g, ' ')
        .replace(/[，,。；;：:？?！!\s]/g, ' '));
      return residual.length === 0;
    })();
  if (isArchiveListQuestion) {
    return { intent: { kind: 'search' }, strong: true };
  }

  // 统一检索：命中多范围联合信号时，把下面各检索分支产出的条件改归 unified_search，
  // 同时保留检索条件（档号/标题/关键词/分类/状态）与识别到的范围/格式；单范围也走 unified_search。
  const unified = detectUnified(question);
  const unifiedKeyword = unified ? extractUnifiedKeyword(question) : undefined;
  const asIntent = (base: ParsedIntent): { intent: ParsedIntent; strong: boolean } =>
    unified
      ? {
          intent: {
            ...base,
            kind: 'unified_search',
            scopes: unified.scopes,
            extension: unified.extension,
            timeRange: unified.timeRange,
            attachmentFileName: base.attachmentFileName ?? attachmentFileName,
            attachmentMode: base.attachmentMode ?? attachmentMode,
            queryReference: base.queryReference ?? queryReference,
            keyword: base.archiveNo ? undefined : unifiedKeyword || (unified.scopes.some((scope) => ['borrow', 'audit', 'template', 'stats'].includes(scope)) ? undefined : base.keyword),
          },
          strong: true,
        }
      : { intent: base, strong: true };

  // 2) 档号优先：命中即按档号检索（档号本身已足够唯一）；纯日期形态不算档号
  const hintedNo = cleanArchiveNoHint(question.match(ARCHIVE_NO_HINT_RE)?.[1]);
  const shapedNo = cleanArchiveNoHint(question.match(ARCHIVE_NO_RE)?.[0]);
  const isDateShaped = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const archiveNo = hintedNo ?? (shapedNo && !isDateShaped(shapedNo) ? shapedNo : undefined);
  if (archiveNo && /\d/.test(archiveNo)) {
    return asIntent({ kind: 'search', archiveNo: archiveNo.slice(0, MAX_KEYWORD_LENGTH) });
  }

  // 3) 分类 + 显式标题/关键词
  const status = archiveStatus(question);
  const category = matchCategory(question, input.categories);
  const titleHint = question.match(TITLE_HINT_RE)?.[1];
  const keywordHint = question.match(KEYWORD_HINT_RE)?.[1];

  if (titleHint) {
    const cleaned = extractSearchTerm(titleHint) || trim(titleHint);
    if (cleaned) {
      return asIntent({
        kind: 'search',
        title: cleaned.slice(0, MAX_KEYWORD_LENGTH),
        categoryId: category?.id,
        categoryName: category?.name,
        status,
      });
    }
  }
  if (keywordHint && trim(keywordHint)) {
    return asIntent({
      kind: 'search',
      keyword: trim(keywordHint).slice(0, MAX_KEYWORD_LENGTH),
      categoryId: category?.id,
      categoryName: category?.name,
      status,
    });
  }

  // 4) 从问句中剥离虚词得到核心检索词；同时命中分类则形成「分类 + 主题词」组合条件
  const residual = extractSearchTerm(question);
  const keyword = residual && residual !== trim(category?.name ?? '') ? residual : '';
  if (category) {
    return asIntent({
      kind: 'search',
      categoryId: category.id,
      categoryName: category.name,
      keyword: keyword ? keyword.slice(0, MAX_KEYWORD_LENGTH) : undefined,
      status,
    });
  }
  if (keyword && keyword.length >= 2 && !QUESTION_SHAPE_RE.test(question)) {
    const parsed = asIntent({ kind: 'search', keyword: keyword.slice(0, MAX_KEYWORD_LENGTH), status });
    // A leftover string alone does not prove that the user asked for archive retrieval.
    parsed.strong = !!unified || SEARCH_DIRECTIVE_RE.test(question) || /档案|文件|文档|合同|协议|资料/u.test(question);
    return parsed;
  }
  if (keyword && keyword.length >= 2 && status) {
    // 疑问句式但带明确状态筛选：仍按状态检索，比拒答更有用
    return asIntent({ kind: 'search', keyword: keyword.slice(0, MAX_KEYWORD_LENGTH), status });
  }
  if (BORROW_GUIDE_RE.test(question)) {
    // 理论上已在 parseBusinessIntent 中命中；保留兜底，确保借阅咨询不会被归为无关检索
    return { intent: { kind: 'borrow_apply' }, strong: true };
  }
  // 只有状态/分类信号（检索词被虚词过滤掉）时不视为明确条件，交给模型或诚实提示
  return { intent: { kind: 'unparsed' }, strong: false };
}

/** 是否值得调用模型：规则解析无明确条件时才调用（省 token 且结果更可预期）。 */
export function shouldUseModel(parsed: { strong: boolean }): boolean {
  return !parsed.strong;
}

const INTENT_KINDS: IntentKind[] = [
  'search',
  'archive_info',
  'help',
  'content_question',
  'unified_search',
  'borrow_apply',
  'borrow_progress',
  'catalog_suggest',
  'unsupported',
  'unparsed',
];

/** 现有借阅接口的真实状态集（与 borrow_requests.status 一致，不接受模型自创状态）。 */
const BORROW_STATUS_KEYS = ['pending', 'approved', 'rejected', 'returned', 'expired', 'cancelled'];

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = trim(value);
  if (!text) return undefined;
  return text.slice(0, max);
}

/**
 * 校验并清洗模型输出的意图（不信任模型）：
 * - kind 必须落在受控集合；
 * - 检索词长度按现有接口上限截断；
 * - 分类只接受真实存在且名称精确匹配的结果（按名匹配，不接受模型给的 ID）；
 * - status 只接受现有接口支持的取值；借阅状态只接受现有业务真实状态键；
 * - 借阅用途/期限按现有借阅接口规则（1-500 字 / 1-90 天）裁剪，越界即丢弃；
 * - 业务办理类意图永远不带档案 ID：具体档案由服务层用真实检索定位；
 * - 一律剔除用户身份/权限类字段（模型即便返回也被丢弃）。
 */
export function sanitizeIntent(
  raw: unknown,
  categories: CategoryHint[],
): ParsedIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const kind = String(obj.kind ?? '') as IntentKind;
  if (!INTENT_KINDS.includes(kind)) return null;
  if (kind === 'help' || kind === 'unsupported' || kind === 'unparsed') {
    return { kind, confidence: safeNumber(obj.confidence) };
  }
  const categoryHint = safeText(obj.categoryName ?? obj.category, 50);
  const matched = categoryHint
    ? categories.find((c) => c.name === categoryHint) ?? matchCategory(categoryHint, categories)
    : undefined;
  const intent: ParsedIntent = {
    kind,
    keyword: extractSearchTerm(safeText(obj.keyword, MAX_KEYWORD_LENGTH) ?? '') || undefined,
    title: safeText(obj.title, MAX_KEYWORD_LENGTH),
    archiveNo: safeText(obj.archiveNo, MAX_KEYWORD_LENGTH),
    categoryName: matched?.name ?? categoryHint,
    categoryId: matched?.id,
    status: obj.status === 'draft' || obj.status === 'archived' ? obj.status : undefined,
    confidence: safeNumber(obj.confidence),
    attachmentFileName: safeText(obj.attachmentFileName, MAX_KEYWORD_LENGTH),
    attachmentMode: obj.attachmentMode === 'list' || obj.attachmentMode === 'file_name' ? obj.attachmentMode : undefined,
    queryReference: obj.queryReference === 'previous_results' ? 'previous_results' : undefined,
  };
  if (kind === 'content_question') {
    const safeTerms = (value: unknown): string[] => Array.isArray(value)
      ? [...new Set(value.slice(0, 6).map(v => safeText(v, MAX_KEYWORD_LENGTH)).filter((v): v is string => !!v && v.length >= 2))] : [];
    intent.archiveTitleCandidates = safeTerms(obj.archiveTitleCandidates);
    intent.attachmentNameCandidates = safeTerms(obj.attachmentNameCandidates);
    intent.metadataTerms = safeTerms(obj.metadataTerms);
    intent.contentTerms = safeTerms(obj.contentTerms);
    intent.archiveNo ??= safeText(obj.archiveNumber, MAX_KEYWORD_LENGTH);
    // 正文问答必须保留模型识别出的档案标题/档号，后续取证范围解析会再次做权限过滤。
    return intent;
  }
  if (kind === 'borrow_apply' || kind === 'borrow_progress' || kind === 'catalog_suggest') {
    if (kind === 'borrow_apply') {
      intent.purpose = safeText(obj.purpose, 500);
      const days = Number(obj.days);
      intent.days = Number.isInteger(days) && days >= 1 && days <= 90 ? days : undefined;
    }
    if (kind === 'borrow_progress') {
      const key = safeText(obj.borrowStatus, 20);
      intent.borrowStatus = key && BORROW_STATUS_KEYS.includes(key) ? key : undefined;
      intent.dataScope = obj.dataScope === 'review' ? 'review' : 'mine';
    }
    // 业务意图至少需要一个可用于定位档案/记录线索，否则不采信（交回规则结果或诚实提示）
    if (!intent.archiveNo && !intent.title && !intent.keyword && !intent.purpose && !intent.borrowStatus) {
      if (kind !== 'borrow_progress') return null;
    }
    return intent;
  }
  // archive_info 必须指向具体档案（档号 / ID / 关键词至少其一），否则降级为 search
  if (kind === 'archive_info' && !intent.archiveNo && !intent.title && !intent.keyword) {
    return null;
  }
  if (kind === 'unified_search') {
    // 范围只接受四类真实值（模型自造范围一律剔除）；全部非法或为空时四类全开
    const rawScopes = Array.isArray(obj.scopes) ? (obj.scopes as unknown[]) : [];
    const picked = new Set(
      rawScopes.filter((s): s is SearchScope => typeof s === 'string' && (SEARCH_SCOPES as readonly string[]).includes(s)),
    );
    intent.scopes = picked.size ? SEARCH_SCOPES.filter((s) => picked.has(s)) : [...DEFAULT_UNIFIED_SCOPES];
    const ext = safeText(obj.extension, 10)?.replace(/^\./, '').toLowerCase();
    intent.extension = ext && /^[a-z0-9]{1,10}$/.test(ext) ? ext : undefined;
    const range = safeText(obj.timeRange, 16);
    intent.timeRange = ['today', 'yesterday', '7d', '30d', '90d'].includes(range ?? '') ? (range as SearchTimeRange) : undefined;
    // 显式附件文件名是独立条件；为兼容现有统一检索入口，同时映射为附件范围内的 keyword。
    if (intent.attachmentFileName && !intent.keyword) intent.keyword = intent.attachmentFileName;
    // 统一检索至少需要一个可用条件（与目录检索同口径），否则不采信。
    // 附件列表与审计时间范围允许无文本关键词，由后端工具层执行受限列表查询。
    if (
      !intent.keyword &&
      !intent.title &&
      !intent.archiveNo &&
      !intent.categoryId &&
      !intent.status &&
      !intent.extension &&
      !intent.timeRange &&
      !intent.attachmentFileName &&
      intent.attachmentMode !== 'list'
    ) {
      return null;
    }
    return intent;
  }
  if (kind === 'search' && !intent.keyword && !intent.title && !intent.archiveNo && !intent.categoryId && !intent.status) {
    return null;
  }
  return intent;
}

function safeNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1) : undefined;
}

/** 从模型正文中稳健提取 JSON 对象（容忍 ```json 包裹与前后解释文字）。 */
export function extractJsonObject(text: string): unknown | null {
  const cleaned = text.replace(/```json|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 会话标题：取首条用户提问截断（超长加省略号）。 */
export function buildConversationTitle(question: string): string {
  const text = trim(question).replace(/\s+/g, ' ');
  if (!text) return '新对话';
  return text.length > TITLE_MAX_LENGTH ? `${text.slice(0, TITLE_MAX_LENGTH)}…` : text;
}
