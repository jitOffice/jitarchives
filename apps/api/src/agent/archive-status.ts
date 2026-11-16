/** Resolve polarity inside the archive-state phrase, independent of regex ordering.
 * Negation outside that phrase (e.g. “没有未归档的档案”) is ambiguous as a filter.
 */
export function archiveStatus(question: string): 'draft' | 'archived' | undefined {
  const states = new Set<'draft' | 'archived'>();
  let ambiguous = false;
  const phrases = /(?:(?:还)?没有|尚未|还没|未|待)(?:进行|完成|正式)*归档|(?:已经|已)?(?:完成|正式)归档|已经归档|已归档|草稿|著录中|正式档案|只读归档|只读档案|归档(?=的?(?:档案|文件|文档|资料)|状态)/gu;
  for (const match of question.matchAll(phrases)) {
    const before = question.slice(0, match.index).split(/[，,。；;？！?！]/u).at(-1) ?? '';
    if (/(?:没有|没|并非|不是|不再|无需|不必|不要|排除|除去)\s*$/u.test(before)) {
      ambiguous = true;
      continue;
    }
    states.add(/^(?:(?:还)?没有|尚未|还没|未|待|草稿|著录中)/u.test(match[0]) ? 'draft' : 'archived');
  }
  return !ambiguous && states.size === 1 ? [...states][0] : undefined;
}
