import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { UserView } from '../common/roles';
import { DEFAULT_UNIFIED_SCOPES, ParsedIntent, SearchScope, extractSearchTimeRange } from './intent.parser';
import { AgentToolRegistry, assertToolUser, toolFailure } from './tool.registry';
import { AgentToolCall, AgentToolExecution, AgentToolResult, ToolParams } from './tool.types';

/** Stable, order-independent keys; duplicates share the same in-flight promise within one request only. */
function key(name: string, params: ToolParams): string {
  return JSON.stringify([name, Object.entries(params).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, Array.isArray(v) && (k === 'archiveIds' || k === 'fileIds' || k === 'actions') ? [...new Set(v)].sort() : v])]);
}

@Injectable()
export class AgentToolDispatcher {
  private readonly resolvedParams = new WeakMap<AgentToolResult, ToolParams>();
  constructor(@Inject(AgentToolRegistry) private readonly registry: AgentToolRegistry) {}

  plannerTools() {
    return this.registry.listForPlanner();
  }

  /** Five search inputs are independent; only explicit user scope may constrain downstream reads. */
  planContentRetrieval(intent: ParsedIntent): AgentToolCall[] {
    const filters = { categoryId: intent.categoryId, status: intent.status, pageSize: 100 };
    const calls: AgentToolCall[] = (intent.archiveTitleCandidates ?? []).map((title, i) => ({
      id: `title:${i}`, toolName: 'archive.search', params: { ...filters, title, archiveNo: intent.archiveNumber },
    }));
    if (intent.archiveNumber) calls.push({ id: 'number', toolName: 'archive.search', params: { ...filters, archiveNo: intent.archiveNumber } });
    for (const [i, keyword] of (intent.metadataTerms ?? []).entries()) calls.push({
      id: `metadata:${i}`, toolName: 'archive.search', params: { ...filters, keyword, archiveNo: intent.archiveNumber },
    });
    if (!calls.length && intent.categoryId) calls.push({ id: 'category', toolName: 'archive.search', params: filters });
    return calls;
  }

  /** Retrieval must not silently stop at the first presentation page. */
  async executeAllPages(plan: AgentToolCall[], operator: UserView): Promise<AgentToolExecution> {
    const execution = await this.execute(plan, operator);
    for (const call of plan) {
      let result = execution.results.find(r => r.callId === call.id)!;
      if (!result) continue;
      const resolved = this.resolvedParams.get(result) ?? call.params;
      let page = result.pagination?.page ?? 1;
      while (result.status === 'success' && result.pagination?.hasMore) {
        const recorded = execution.results.find(r => r.callId === `${call.id}:page:${page + 1}`);
        const next = recorded ? { results: [recorded] } : await this.execute([{ id: `${call.id}:page:${page + 1}`, toolName: call.toolName, params: { ...resolved, page: page + 1 } }], operator);
        if (!recorded) execution.results.push(...next.results);
        result = next.results[0];
        if (result.status !== 'success') break;
        if (!result.data?.items?.length || (result.pagination?.page ?? 0) <= page) {
          execution.results.push({ ...toolFailure(call.toolName, new BadRequestException('检索分页未取得进展，当前结果覆盖不完整')), callId: `${call.id}:pagination` });
          break;
        }
        page = result.pagination!.page;
      }
    }
    execution.status = execution.results.some(r => r.status !== 'success') ? execution.results.some(r => r.status === 'success') ? 'partial' : 'error' : 'success';
    return execution;
  }

  plan(intent: ParsedIntent, question = ''): AgentToolCall[] {
    const page = Number(question.match(/第\s*(\d+)\s*页/u)?.[1] ?? 1);
    const pageSize = Number(question.match(/每页\s*(\d+)\s*条/u)?.[1] ?? 8);
    const paging = { page, pageSize };
    const archiveId = question.match(/档案\s*(?:ID|id|编号|#)\s*[：:]?\s*(\d+)/u)?.[1];
    const categoryIdHint = question.match(/分类\s*(?:ID|id|编号|#)\s*[：:]?\s*(\d+)/u)?.[1];
    const categoryId = categoryIdHint === undefined ? intent.categoryId : Number(categoryIdHint);
    const keyword = categoryIdHint === undefined ? intent.keyword : undefined;
    const archive: ToolParams = { keyword, title: intent.title, archiveNo: intent.archiveNo,
      categoryId, status: intent.status, ...paging };
    const calls: AgentToolCall[] = [];
    const add = (id: string, toolName: string, params: ToolParams, archiveFrom?: string) => {
      calls.push({ id, toolName, params, ...(archiveFrom ? { archiveFrom, dependsOn: [archiveFrom] } : {}) });
    };
    if (intent.kind === 'search' || intent.kind === 'archive_info') {
      if (archiveId) { add('detail', 'archive.detail', { archiveId: Number(archiveId) }); return calls; }
      add('archives', 'archive.search', archive);
      if (intent.kind === 'archive_info') calls.push({ id: 'detail', toolName: 'archive.detail', params: {}, dependsOn: ['archives'], archiveFrom: 'archives' });
      return calls;
    }
    if (intent.kind === 'borrow_progress') {
      const requestId = question.match(/(?:借阅(?:申请|记录)?|申请)\s*(?:编号|ID|id|#)\s*(\d+)/u)?.[1];
      if (requestId) add('borrowings', 'borrow.detail', { requestId: Number(requestId) });
      else add('borrowings', 'borrow.search', { keyword: intent.keyword ?? intent.title ?? intent.archiveNo,
        status: intent.borrowStatus, scope: intent.dataScope ?? 'mine', ...paging });
      return calls;
    }
    if (intent.kind !== 'unified_search') return calls;
    const scopes = new Set<SearchScope>(intent.scopes ?? DEFAULT_UNIFIED_SCOPES);
    const fileKeyword = intent.attachmentFileName ? undefined : keyword;
    const hasLocator = !!(archiveId || intent.title || intent.archiveNo || categoryId || intent.status ||
      (fileKeyword && scopes.has('archive')));
    const linked = hasLocator && (scopes.has('attachment') || scopes.has('audit') || scopes.has('content'));
    if (archiveId && (scopes.has('archive') || linked)) add('archives', 'archive.detail', { archiveId: Number(archiveId) });
    else if (scopes.has('archive') || linked) add('archives', 'archive.search', {
      ...archive, keyword: intent.attachmentFileName === keyword ? undefined : keyword,
      // Resolve dependency scope from page 1; presentation pagination is independent of this locator.
      ...(linked ? { page: 1, pageSize: 100 } : {}),
    });
    const source = linked ? 'archives' : undefined;
    if (scopes.has('attachment')) add('attachments', 'attachment.search', {
      keyword: source ? undefined : fileKeyword, attachmentFileName: intent.attachmentFileName,
      extension: intent.extension, ...paging,
    }, source);
    if (scopes.size === 1 && scopes.has('attachment') && intent.title && source) calls[calls.length - 1].preferExactArchiveTitle = intent.title;
    if (scopes.has('content')) add('contents', 'content.search', {
      keyword: intent.keyword ?? intent.title, extension: intent.extension, ...paging,
    }, archiveId || intent.title || intent.archiveNo || categoryId || intent.status ? source : undefined);
    if (scopes.has('category')) add('categories', 'category.list', { keyword: categoryId ? undefined : keyword ?? intent.title,
      categoryId, ...paging });
    if (scopes.has('borrow')) add('borrowings', 'borrow.search', { keyword: intent.keyword ?? intent.title ?? intent.archiveNo,
      status: intent.borrowStatus ?? (/待处理|待审核/u.test(question) ? 'pending' : undefined),
      scope: intent.dataScope ?? (/我的|本人/u.test(question) ? 'mine' : /待处理|待审核|所有借阅|他人/u.test(question) ? 'review' : undefined), ...paging });
    if (scopes.has('audit')) {
      const actions = /修改|编辑/u.test(question) ? ['archive.update'] : /创建/u.test(question) ? ['archive.create'] :
        /删除/u.test(question) ? ['archive.delete'] : /下载/u.test(question) ? ['file.download'] : undefined;
      const actorName = question.match(/(?:操作人员|操作人)\s*(?:为|是|[：:])?\s*[“"]?([^”"，,。\s]{1,30}?)(?=的?(?:操作记录|操作日志|操作审计|审计记录|修改|编辑|创建|删除)|[”"，,。\s]|$)/u)?.[1]
        ?? question.match(/(?:查询|查看|查找)\s*(.{2,12}?)(?:最近\d+天)?(?:修改|编辑|创建|删除)过/u)?.[1];
      const bounds = [...question.matchAll(/\d{4}-\d{2}-\d{2}/gu)].map(m => m[0]);
      add('audits', 'audit.search', { keyword: source || actions || actorName ? undefined : intent.keyword,
        actions, actorName, timeRange: intent.timeRange ?? extractSearchTimeRange(question),
        ...(bounds.length ? { from: `${bounds[0]}T00:00:00+08:00`, to: `${bounds[1] ?? bounds[0]}T23:59:59.999+08:00` } : {}),
        ...paging }, source);
    }
    if (scopes.has('template')) add('templates', 'template.search', { keyword: keyword ?? intent.title, categoryId, ...paging });
    if (scopes.has('stats')) add('statistics', 'statistics.get', { timeRange: intent.timeRange });
    return calls;
  }

  async dispatch(intent: ParsedIntent, operator: UserView, question = ''): Promise<AgentToolExecution> {
    return this.execute(this.plan(intent, question), operator);
  }

  /**
   * 拉取上游步骤的全部分页行（不因展示页漏检）；分页失败或无进展一律抛错，
   * 交由调用方 fail-closed，绝不将不完整的关联作用域当作全量。
   */
  private async collectUpstreamRows(
    upstream: AgentToolCall, found: AgentToolResult,
    once: (name: string, params: ToolParams) => Promise<AgentToolResult>, extra: AgentToolResult[],
  ): Promise<Array<Record<string, unknown>>> {
    const rows: Array<Record<string, unknown>> = [...(found.data?.items ?? [])];
    const scopedParams = this.resolvedParams.get(found) ?? upstream.params;
    let previousPage = found.pagination?.page ?? 1;
    while (found.pagination?.hasMore) {
      const page = await once(upstream.toolName, { ...scopedParams, page: previousPage + 1 });
      const callId = `${upstream.id}:page:${previousPage + 1}`;
      if (!extra.some(r => r.callId === callId)) extra.push({ ...page, callId });
      if (page.status !== 'success') throw new BadRequestException('上游结果分页失败，未执行不完整的关联查询');
      if (!page.data?.items?.length || (page.pagination?.page ?? 0) <= previousPage) throw new BadRequestException('上游结果分页未取得进展');
      rows.push(...page.data.items);
      previousPage = page.pagination!.page;
      found = page;
    }
    return rows;
  }

  async execute(plan: AgentToolCall[], operator: UserView): Promise<AgentToolExecution> {
    assertToolUser(operator);
    const nodes = new Map(plan.map(call => [call.id, call]));
    if (nodes.size !== plan.length || plan.some(call => (call.dependsOn ?? []).some(id => !nodes.has(id)) ||
      (call.archiveFrom && !(call.dependsOn ?? []).includes(call.archiveFrom)) ||
      (call.scopeFrom && !(call.dependsOn ?? []).includes(call.scopeFrom.step)))) throw new BadRequestException('工具依赖计划不合法');
    const completed = new Map<string, AgentToolResult>();
    const memo = new Map<string, Promise<AgentToolResult>>();
    const extra: AgentToolResult[] = [];
    const once = (name: string, params: ToolParams) => {
      const cacheKey = key(name, params);
      let pending = memo.get(cacheKey);
      if (!pending) { pending = this.registry.execute(name, params, operator); memo.set(cacheKey, pending); }
      return pending;
    };
    while (completed.size < plan.length) {
      const ready = plan.filter(call => !completed.has(call.id) && (call.dependsOn ?? []).every(id => completed.has(id)));
      if (!ready.length) throw new BadRequestException('工具依赖计划存在循环');
      // Only registered read-only tools can reach this scheduler. Independent async calls start together.
      await Promise.all(ready.map(async call => {
        const blocked = (call.dependsOn ?? []).find(id => completed.get(id)!.status !== 'success');
        if (blocked) {
          completed.set(call.id, { toolName: call.toolName, callId: call.id, status: 'skipped', data: null, total: 0,
            pagination: null, error: { code: 'DEPENDENCY_FAILED', message: `依赖工具 ${blocked} 查询失败，未执行关联查询` } });
          return;
        }
        try {
          let params = { ...call.params };
          if (call.archiveFrom) {
            const upstream = nodes.get(call.archiveFrom)!;
            let found = completed.get(call.archiveFrom)!;
            const ids: number[] = found.data.items.map((row: { id: number }) => row.id);
            const located: Array<{ id: number; title: string }> = [...found.data.items];
            // Fetch every locator page, so attachments/audits are never silently limited to the first result cards.
            let previousPage = found.pagination?.page ?? 1;
            while (call.toolName !== 'archive.detail' && found.pagination?.hasMore) {
              const page = await once(upstream.toolName, { ...(this.resolvedParams.get(found) ?? upstream.params), page: previousPage + 1 });
              const callId = `${upstream.id}:page:${previousPage + 1}`;
              if (!extra.some(r => r.callId === callId)) extra.push({ ...page, callId });
              if (page.status !== 'success') throw new BadRequestException('档案定位分页失败，未执行不完整的关联查询');
              if (!page.data.items.length || (page.pagination?.page ?? 0) <= previousPage) throw new BadRequestException('档案定位分页未取得进展');
              ids.push(...page.data.items.map((row: { id: number }) => row.id));
              located.push(...page.data.items);
              previousPage = page.pagination!.page;
              found = page;
            }
            const exact = call.preferExactArchiveTitle ? located.filter(row => row.title === call.preferExactArchiveTitle) : [];
            if (exact.length) ids.splice(0, ids.length, ...exact.map(row => row.id));
            if (call.toolName === 'archive.detail') {
              if (!ids.length) {
                completed.set(call.id, { toolName: call.toolName, callId: call.id, status: 'skipped', data: null, total: 0,
                  pagination: null, error: { code: 'DEPENDENCY_EMPTY', message: '未找到指定的可访问档案，未执行详情查询' } });
                return;
              }
              params.archiveId = ids[0];
            } else {
              if (!ids.length) {
                completed.set(call.id, { toolName: call.toolName, callId: call.id, status: 'skipped', data: null, total: 0,
                  pagination: null, error: { code: 'DEPENDENCY_EMPTY', message: '未找到指定的可访问档案，未执行关联查询' } });
                return;
              }
              params.archiveIds = [...new Set(ids)];
            }
          }
          // 泛化作用域注入：任意上游步骤的真实（全量分页）结果都能作为下游作用域，
          // 支持「先定位档案→再读其全部附件正文」这类链；数值 ID 只来自后端已授权结果，绝不来自模型。
          if (call.scopeFrom) {
            const skipped = (message: string) => { completed.set(call.id, { toolName: call.toolName, callId: call.id, status: 'skipped', data: null, total: 0,
              pagination: null, error: { code: 'DEPENDENCY_EMPTY', message } }); };
            const upstreamNode = nodes.get(call.scopeFrom.step)!;
            const rows = await this.collectUpstreamRows(upstreamNode, completed.get(call.scopeFrom.step)!, once, extra);
            const valid = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
            if (call.toolName === 'borrow.detail') {
              if (upstreamNode.toolName !== 'borrow.search' || !valid(rows[0]?.id)) { skipped('没有可验证的借阅记录引用'); return; }
              params = { requestId: rows[0].id as number };
            } else if (call.scopeFrom.kind === 'file' || (call.scopeFrom.kind === 'auto' && rows.some(r => valid(r.fileId)))) {
              const fileIds = [...new Set<number>(rows.map(r => r.fileId).filter(valid))];
              const archiveIds = [...new Set<number>(rows.map(r => r.archiveId ?? r.id).filter(valid))];
              if (!fileIds.length) { skipped('未找到指定的可访问附件，未执行关联查询'); return; }
              params.fileIds = params.fileIds ? params.fileIds.filter(id => fileIds.includes(id)) : fileIds;
              if (!params.fileIds.length) { skipped('附件作用域交集为空'); return; }
              if (!params.archiveIds?.length && archiveIds.length) params.archiveIds = archiveIds;
            } else {
              const archiveIds = [...new Set<number>(rows.map(r => r.archiveId ?? r.id).filter(valid))];
              if (!archiveIds.length) { skipped('未找到指定的可访问档案，未执行关联查询'); return; }
              if (call.toolName === 'archive.detail') params.archiveId = archiveIds[0];
              else params.archiveIds = params.archiveIds ? params.archiveIds.filter(id => archiveIds.includes(id)) : archiveIds;
              if (params.archiveIds && !params.archiveIds.length) { skipped('档案作用域交集为空'); return; }
            }
          }
          const result = { ...await once(call.toolName, params), callId: call.id };
          this.resolvedParams.set(result, params);
          completed.set(call.id, result);
        } catch (error) { completed.set(call.id, { ...toolFailure(call.toolName, error), callId: call.id }); }
      }));
    }
    const results = [...completed.values(), ...extra];
    const failed = results.filter(r => r.status !== 'success').length;
    return { status: failed ? results.some(r => r.status === 'success') ? 'partial' : 'error' : 'success', results };
  }
}
