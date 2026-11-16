/** Natural-language rendering of permission-checked structured results.
 * Business facts and links are rendered by the server, never invented by a model.
 * Content synthesis reuses content.evidence.ts and the shared AiModelClient.
 */
import type { AgentArchiveCard, AgentAttachmentCard, AgentUnifiedGroups } from './agent.service';
import type { AgentToolExecution } from './tool.types';

export function answerArchives(total: number, cards: AgentArchiveCard[]): string {
  if (!total) return '没有找到符合条件的档案。';
  return `你目前有权限查看的档案共有 ${total} 份${total > cards.length ? `，当前展示 ${cards.length} 份` : ''}：\n` +
    cards.map((a, i) => `${i + 1}. 《${a.title}》（档号 ${a.archiveNo}），状态：${a.statusLabel}，分类：${a.categoryPath}。`).join('\n');
}
export function answerAttachments(files: AgentAttachmentCard[], upload = false): string {
  if (!files.length) return '没有找到符合条件的附件。';
  return files.map((f, i) => `${i + 1}. ${f.fileName}（${f.extension}，所属档案《${f.archiveTitle}》，档号 ${f.archiveNo}）` +
    (upload ? `，上传时间：${f.uploadedAt || '未记录'}，上传人：${f.uploadedByName || '未记录'}` : '') + '。').join('\n');
}
export function answerUnified(groups: AgentUnifiedGroups, execution: AgentToolExecution): string {
  const hasPartialResults = execution.status !== 'success' || execution.results.some(result => result.status !== 'success');
  const sections: string[] = [hasPartialResults ? '以下为目前能够确认的相关资料：' : '以下是相关资料：'];
  const unavailable = (toolName: string) =>
    execution.results.some(result => result.toolName === toolName && result.status !== 'success');

  if (groups.scopes.includes('archive')) sections.push('档案信息：\n' + answerArchives(groups.archives.total, groups.archives.items));
  if (groups.scopes.includes('attachment')) sections.push(unavailable('attachment.search')
    ? '附件信息暂时无法提供。'
    : `附件信息（共 ${groups.attachments.total} 个）：\n` + answerAttachments(groups.attachments.items));
  if (groups.scopes.includes('content')) sections.push(unavailable('content.search')
    ? '相关正文资料暂时无法提供。'
    : groups.contents.total
      ? '找到相关正文资料，可在参考来源中查看。'
      : '没有找到相关正文资料。');
  if (groups.scopes.includes('audit')) sections.push('操作记录：\n' + (unavailable('audit.search')
    ? '操作记录暂时无法提供。'
    : groups.audits.items.map(a =>
      `· ${a.actorName ?? '未知操作人'} · ${a.createdAt} · ${a.objectLabel ?? a.objectRef ?? '对象已不存在'} · ${a.actionLabel} · ${a.summary}`).join('\n') || '没有可展示的操作记录。'));
  if (groups.scopes.includes('category')) sections.push(`分类：共 ${groups.categories.total} 个。`);
  if (groups.scopes.includes('borrow')) sections.push(`借阅记录：共 ${groups.borrowings.total} 条。`);
  if (groups.scopes.includes('template')) sections.push(unavailable('template.search') ? '模板信息暂时无法提供。' : `模板：共 ${groups.templates.total} 个。`);
  if (groups.scopes.includes('stats')) sections.push(groups.statistics ? `统计：${groups.statistics.note}` : '统计信息暂时无法提供。');
  if (hasPartialResults) sections.push('部分相关信息暂时无法提供，你可以稍后再试或补充更具体的条件。');
  return sections.join('\n\n');
}
