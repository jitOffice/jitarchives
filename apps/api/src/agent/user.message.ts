/**
 * 面向用户的措辞层（Agent 降级答复）。
 *
 * 检索链路的工具名、证据判定枚举、覆盖率计数等内部信号只保留在 payload（trace / diagnostics），
 * 对话正文与 contentNotes 一律使用业务语言：用户只需要知道「为什么没有答案」和「下一步怎么做」。
 */

/** 内部实现词：工具名、判定枚举、索引字段名、覆盖率计数。出现即说明这段文字不能原样展示给用户。 */
const INTERNAL_WORDS = new RegExp(
  [
    'content\\.(read|search)', 'archive\\.(search|detail)', 'attachment\\.search', 'graph\\.relations',
    'audit\\.search', 'borrow\\.(search|detail)', 'category\\.list', 'statistics\\.get', 'template\\.search',
    'supplement', 'sufficient', 'insufficient', 'clarify', 'unknown',
    'tfidf[_ -]?cosine(?:[_ -]?aggregated)?', 'metadata_exact_match', 'business_structure',
    'factGrade', 'toolResults', 'retrievalPlan', 'authorizationArchiveIds', 'indexStatuses', 'chunkCount', 'topK', 'scope',
    // 覆盖率/判定结果的旧式表述（含「档案 0/1」这类计数比值），一律不当作用户可读说明。
    '覆盖说明', '受检索规模上限', '证据充分性', '索引状态[:：]', '未通过安全校验', '补充计划',
    '(?:档案|附件|正文分块|正文段落)\\s*\\d+\\s*/\\s*\\d+',
  ].join('|'),
  'iu',
);

/** 说明文字是否可以直接展示给用户（含工具名、枚举或索引字段即视为不可直接展示）。 */
export function isUserReadableNote(note: string): boolean {
  const text = (note ?? '').trim();
  return !!text && !INTERNAL_WORDS.test(text);
}

/** 过滤去重，只保留用户能读懂的说明。 */
export function userReadableNotes(notes: string[]): string[] {
  return [...new Set(notes.map((note) => (note ?? '').trim()).filter(isUserReadableNote))];
}

/**
 * 历史消息兼容：旧版本可能把内部诊断拼进 content。
 * 这里按「已保存的 diagnostics 原文」与逐行可读性做结构性清理，
 * 不修改数据库原始记录；原始内容仍可由授权诊断接口读取。
 */
export function sanitizeHistoricalContent(content: string, diagnostics: string[] = []): string {
  let text = String(content ?? '');
  for (const diagnostic of diagnostics) {
    const value = (diagnostic ?? '').trim();
    if (value) text = text.split(value).join('');
  }
  const kept = text.split(/\r?\n/u).filter((line) => {
    const body = line.replace(/^\s*[·\-*•]\s*/u, '').trim();
    return !body || isUserReadableNote(body);
  });
  return kept.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

export interface NoEvidenceArchive {
  title: string;
  archiveNo: string;
  /** 该档案的附件数量（由后端真实详情统计）；-1 表示详情读取失败，不能据此断言「没有附件」。 */
  fileCount: number;
}

/**
 * 「没有正文依据」时的用户语言答复。
 * 只说明当前能够确认的业务事实和下一步建议；附件解析、索引与检索过程不进入回答正文。
 * notes 仅供服务端内部留存，普通聊天界面不展示。
 */
export function noEvidenceAnswer(input: { archives: NoEvidenceArchive[]; notes: string[]; relationCount?: number }): { content: string; notes: string[] } {
  const archives = input.archives.slice(0, 3);
  const notes = userReadableNotes(input.notes);
  const relationCount = Math.max(0, Math.trunc(Number(input.relationCount ?? 0)));
  const one = archives.length === 1;
  const head = archives.length
    ? `已找到${archives.map((a) => `档案《${a.title}》（档号 ${a.archiveNo}）`).join('、')}。\n`
    : '';
  let body: string;
  if (archives.length && archives.every((a) => a.fileCount === 0)) {
    body =
      `${one ? '这份档案' : '这些档案'}目前还没有上传附件，因此没有可以阅读的正文内容。\n` +
      (relationCount
        ? `知识图谱显示${one ? '它' : '这些档案'}与 ${relationCount} 份档案存在关联，具体关联和判断依据见下方说明。\n`
        : `也没有找到可以与${one ? '它' : '它们'}关联的其他档案。\n`) +
      '如果需要我总结正文或分析关联，可以先在档案详情里补充相关附件，再向我提问。';
  } else if (archives.length) {
    body =
      '目前没有找到足以回答这个问题的资料。\n' +
      '你可以补充档案名称、相关附件或更具体的问题后再试。';
  } else {
    body =
      '没有找到与这个问题相关的、你有权限查看的资料。\n' +
      '可以补充档案名称、档号或业务关键词后再问一次。';
  }
  return { content: `${head}${body}`, notes };
}
