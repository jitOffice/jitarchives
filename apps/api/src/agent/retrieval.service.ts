import { executionBudget } from './execution.budget';
import { Inject, Injectable } from '@nestjs/common';
import { ArchivesService, ArchiveView } from '../archives/archives.service';
import { ArchiveAccessService } from '../archives/archive-access.service';
import type { UserView } from '../common/roles';
import type { EvidenceRow } from '../archives/content/content-index.repositories';
import { AgentToolDispatcher } from './tool.dispatcher';
import { AgentToolCall, AgentToolResult } from './tool.types';
import { RetrievalPlan, validatePlanSteps, type PlanStep, type ContextRef, type RetrievalSource } from './retrieval.plan';
import { emptyCoverage, isCoverageIncomplete, renderCoverageNote, deriveSupplementSteps, judgeSufficiency, type CoverageSignal } from './evidence.assessment';
import type { AiModelClient } from './ai-model.client';
import type { AgentContextSnapshot } from './agent.context';
import {recordStep} from './agent.trace';

function scopeStepId(step: PlanStep, plan: RetrievalPlan): string | undefined {
  if (step.scope?.startsWith('step:')) return step.scope.slice(5);
  const scope = step.searchScope ?? plan.searchScope;
  return scope.kind === 'fromStep' ? scope.step : undefined;
}

/** Graph-linked archives are supporting context by default, not a request to read every related file in full. */
function isGraphRelatedFullTextStep(step: PlanStep, plan: RetrievalPlan): boolean {
  if (step.expects !== 'fullText') return false;
  const upstream = scopeStepId(step, plan);
  return !!upstream && plan.planSteps.some(candidate => candidate.id === upstream && candidate.tool === 'graph.relations');
}

function requiresFullText(steps: PlanStep[], plan: RetrievalPlan): boolean {
  return steps.some(step => step.expects === 'fullText' &&
    (!isGraphRelatedFullTextStep(step, plan) || plan.includeRelatedFullText));
}

export interface RetrievalOutcome {
  results: AgentToolResult[];
  archives: ArchiveView[];
  evidence: EvidenceRow[];
  /** 面向用户的逐条说明（索引状态、未找到的对象），只在回答下方的说明面板展示。 */
  notes: string[];
  /** 面向用户的「本次范围/局限」一句话，追加到回答正文末尾；与 notes 分工，避免正文与面板重复。 */
  limitations: string[];
  /** 内部诊断：工具名、证据判定枚举、安全校验结果等，随 payload 下发但不在对话正文展示。 */
  diagnostics: string[];
  rounds: number;
  inventory?: { total: number; statuses: Record<string, number>; categories: Array<{ name: string; count: number }> };
  /** 证据覆盖率信号（仅动态计划路径产出），供诚实告知与充分性判断。 */
  coverage?: CoverageSignal;
  sufficiency?: { verdict: string; note: string };
  missingAttachments?: string[];
}

@Injectable()
export class AgentRetrievalService {
  constructor(@Inject(ArchivesService) private readonly archives: ArchivesService,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(AgentToolDispatcher) private readonly dispatcher: AgentToolDispatcher) {}

  plannerTools() {
    return this.dispatcher.plannerTools();
  }

  async retrieve(plan: RetrievalPlan, user: UserView, model: AiModelClient, context: AgentContextSnapshot): Promise<RetrievalOutcome> {
    const out: RetrievalOutcome = { results: [], archives: [], evidence: [], notes: [], limitations: [], diagnostics: [], rounds: 0 };
    const plannedTools = plan.planSteps.map((step) => step.tool);
    if (plan.categoryFilter.length || plan.hardConstraints.archiveNumbers.length || plan.hardConstraints.archiveTitles.length
      || plan.archiveStatus || plan.timeRange || plannedTools.some((tool) => [
        'archive.search', 'archive.detail', 'category.list', 'graph.relations', 'borrow.search', 'borrow.detail', 'audit.search', 'template.search',
      ].includes(tool))) {
      recordStep('archives', 'running', 0, 0);
    }
    if (plan.hardConstraints.attachmentNames.length || plannedTools.includes('attachment.search')) {
      recordStep('attachments', 'running', 0, 0);
    }
    if (plannedTools.some((tool) => ['content.search', 'content.read'].includes(tool))) {
      recordStep('content', 'running', 0, 0);
    }
    const all = (params: Parameters<ArchivesService['searchArchives']>[0]): ArchiveView[] => {
      const rows: ArchiveView[] = [];
      for (let page = 1; ; page++) {
        executionBudget()?.takeTool('archive.search');
        const found = this.archives.searchArchives({ ...params, page: String(page), pageSize: '100' }, user);
        rows.push(...found.items);
        if (page * 100 >= found.total) return rows;
        if (!found.items.length) throw Error('Archive pagination made no progress');
      }
    };
    const filters: Parameters<ArchivesService['searchArchives']>[0] = {
      status: plan.archiveStatus ?? undefined, dateField: plan.timeRange?.field,
      dateFrom: plan.timeRange?.from ?? undefined, dateTo: plan.timeRange?.to ?? undefined,
      metadataConditions: plan.hardConstraints.metadata,
    };
    let scope: number[] | undefined;
    let fileScope: number[] | undefined;
    const intersect = (ids: number[]) => { scope = scope === undefined ? [...new Set(ids)] : scope.filter(id => ids.includes(id)); };
    const timed = (id: string, params: Parameters<ArchivesService['searchArchives']>[0]) => {
      const start = performance.now();
      try { const items = all(params); out.results.push({ callId: id, toolName: 'archive.search', status: 'success', data: { items }, total: items.length, pagination: null, error: null, durationMs: Math.round(performance.now() - start) }); return items; }
      catch { out.results.push({ callId: id, toolName: 'archive.search', status: 'error', data: null, total: 0, pagination: null, error: { code: 'QUERY_FAILED', message: '档案检索失败' }, durationMs: Math.round(performance.now() - start) }); return []; }
    };
    // Hard scope is resolved from database rows only; an empty scope is never the global sentinel.
    if (plan.categoryFilter.length) {
      const categories = this.archives.listCategories(user).filter(c => plan.categoryFilter.includes(c.name) || plan.categoryFilter.includes(c.pathCode));
      intersect(categories.flatMap(c => timed(`constraint:category:${c.id}`, { ...filters, categoryId: String(c.id), includeSub: '1' }).map(a => a.id)));
    }
    let missingComparisonSide = false;
    if (plan.hardConstraints.archiveNumbers.length) intersect(plan.hardConstraints.archiveNumbers.flatMap(archiveNo => {
      const found = timed('constraint:number', { ...filters, archiveNo, archiveNoExact: true });
      if (!found.length) missingComparisonSide = true;
      return found.map(a => a.id);
    }));
    if (plan.hardConstraints.archiveTitles.length) {
      const locatedIds: number[] = [];
      for (const title of plan.hardConstraints.archiveTitles) {
        const found = timed('constraint:title', { ...filters, title });
        const exact = found.filter(a => a.title === title);
        // hardConstraints.archiveTitles means the user explicitly named an archive title.
        // Never replace a missing archive title with a same-named attachment/content hit.
        const ids = (exact.length ? exact : found).map(a => a.id);
        if (!ids.length) missingComparisonSide = true;
        locatedIds.push(...ids);
      }
      intersect(locatedIds);
    }
    if (plan.hardConstraints.attachmentNames.length) {
      const found = await this.dispatcher.executeAllPages(plan.hardConstraints.attachmentNames.map((name, i) => ({
        id:`constraint:file:${i}`,toolName:'attachment.search',params:{attachmentFileName:name,pageSize:100,...(scope ? {archiveIds:scope} : {})},
      })),user);
      out.results.push(...found.results);
      out.missingAttachments = plan.hardConstraints.attachmentNames.filter((_, i) => !found.results.some(r =>
        r.callId === `constraint:file:${i}` && r.status === 'success' && r.total > 0));
      for (const name of out.missingAttachments) out.notes.push(`附件「${name}」未找到或当前无权访问。`);
      const rows=found.results.filter(r=>r.status==='success').flatMap(r=>r.data?.items ?? []);
      fileScope=[...new Set<number>(rows.map(row=>row.fileId))];
      intersect(rows.map(row=>row.archiveId));
    }
    if (plan.contentScope === 'previous_results') intersect(context.activeArchives.length ? context.activeArchives : context.archives);
    if (plan.archiveStatus || plan.timeRange || plan.hardConstraints.metadata.length || (plan.isInventoryQuery && plan.planSteps.every(s=>s.tool==='archive.search'))) intersect(timed('constraint:filters', filters).map(a => a.id));
    // Failed optional title/metadata channels do not suppress independent attachment/content channels.
    // Explicit hard filters already narrow scope to [] when they cannot be resolved.
    if (plan.responseMode === 'compare' && missingComparisonSide) { scope = []; out.notes.push('未能完整定位全部比较对象，请补充档号或名称。'); }
    if (scope !== undefined && !scope.length && !plan.isInventoryQuery) {
      recordStep('content','skipped',0,0,'未找到指定的可访问档案或附件，未执行正文查询');
      for (const [toolName, id] of [['attachment.search', 'attachments'], ['content.search', 'content']]) out.results.push({ toolName, callId: id, status: 'skipped', data: null, total: 0, pagination: null, error: { code: 'EXPLICIT_SCOPE_EMPTY', message: '未找到指定范围内的可访问档案，保留范围限制' } });
      out.notes.push('你指定的范围内没有你可以查看的档案，本次没有扩大查找范围。');
      this.recordToolProgress(out.results);
      return this.finalize(out, user);
    }
    if (!plan.planSteps.length) throw new Error('Missing executable plan steps');
    const result = await this.runDynamic(plan, scope, context, model, out, user, fileScope);
    if (plan.isInventoryQuery && plan.responseMode === 'statistics' && result.results.some(r => r.toolName === 'archive.search')) {
      // Counts are computed only over the explicit, authorized query scope, never used as a no-hit fallback.
      const rows = result.archives;
      result.inventory = { total: rows.length, statuses: { draft: rows.filter(a => a.status === 'draft').length,
        archived: rows.filter(a => a.status === 'archived').length }, categories: this.archives.listCategories(user)
          .map(c => ({ name: c.name, count: rows.filter(a => a.categoryId === c.id).length })) };
    }
    return result;
  }

  /** 去重证据、逐条 canView 复核、补齐关联档案卡片、汇总渠道说明。 */
  private finalize(out: RetrievalOutcome, user: UserView): RetrievalOutcome {
    out.evidence = [...new Map(out.evidence.map(e => [e.chunkId, e])).values()].filter(e => {
      try { return this.access.canView(user, this.access.loadArchive(e.archiveId)); } catch { return false; }
    }).sort((a,b)=>a.fileId-b.fileId || a.unitId-b.unitId || a.chunkId-b.chunkId);
    const associated = [...new Set([...out.evidence.map(e => e.archiveId), ...out.results.filter(r => r.status === 'success' && r.toolName === 'attachment.search').flatMap(r => r.data.items.map((f: any) => f.archiveId))])];
    out.archives.push(...associated.map(id => this.archives.getArchiveDetail(id, user)));
    out.archives = [...new Map(out.archives.map(a => [a.id, a])).values()];
    // 有具体关系时不把关系日志混入正文问答；无关系时只保留「未找到关联」这类用户可读结论。
    out.notes.push(...out.results.flatMap(r => {
      if (r.toolName !== 'graph.relations') return r.data?.notes ?? [];
      const hasRelations = Array.isArray(r.data?.items) && r.data.items.length > 0;
      return hasRelations ? [] : (r.data?.notes ?? []).filter((note: string) => /没有找到|还没有纳入知识图谱/u.test(note));
    }));
    if (out.results.some(r => r.status === 'error')) out.limitations.push('有一部分查询没有成功，本次结果只包含查询成功的部分。');
    return out;
  }

  /** Publish only whether each user-facing retrieval channel actually completed; never expose tool details. */
  private recordToolProgress(results: AgentToolResult[]): void {
    const groups: Array<{ id: 'archives' | 'attachments' | 'content'; tools: string[] }> = [
      { id: 'archives', tools: ['archive.search', 'archive.detail', 'category.list', 'graph.relations', 'borrow.search', 'borrow.detail', 'audit.search', 'template.search'] },
      { id: 'attachments', tools: ['attachment.search'] },
      { id: 'content', tools: ['content.search', 'content.read'] },
    ];
    for (const group of groups) {
      const matches = results.filter((result) => group.tools.includes(result.toolName));
      if (!matches.length) continue;
      const failed = matches.some((result) => result.status === 'error');
      const executed = matches.filter((result) => result.status !== 'skipped');
      const hits = matches.filter((result) => result.status === 'success').reduce((sum, result) =>
        sum + Math.max(result.total ?? 0, result.data?.items?.length ?? 0), 0);
      const status = failed ? 'failed' : !executed.length ? 'skipped' : hits ? 'completed' : 'empty';
      recordStep(group.id, status, hits, 0);
    }
  }

  /** Tools whose authorized archive scope is injected by the server. */
  private static readonly ARCHIVE_SCOPED = new Set(['statistics.get', 'archive.search', 'attachment.search', 'content.search', 'content.read', 'audit.search', 'graph.relations']);

  /**
   * 动态多工具执行器：把 AI 拆解的子步骤编译为已授权的工具调用，按预算执行，
   * 正文统一走 SQLite FTS5 CJK Bigram + BM25/RRF，采集证据与覆盖率，并做有界补充检索。
   * 所有数值 ID 只来自后端解析的槽位/上游真实结果，绝不来自模型；权限仍由工具层 canView 全量强制。
   */
  private async runDynamic(
    plan: RetrievalPlan, scope: number[] | undefined, context: AgentContextSnapshot,
    model: AiModelClient, out: RetrievalOutcome, user: UserView, fileScope?: number[],
  ): Promise<RetrievalOutcome> {
    const cov = emptyCoverage(); out.coverage = cov;
    const budget = executionBudget();
    let steps = plan.planSteps;
    let sufficiencyEvaluated = false;
    cov.comparisonMissingSide = plan.responseMode === 'compare' && !!out.missingAttachments?.length;
    let fullTextRequired = requiresFullText(steps, plan);
    for (let round = 0; round <= (budget?.maxSupplementRounds ?? 1); round++) {
      if (round) budget?.beginRound();
      fullTextRequired ||= requiresFullText(steps, plan);
      out.rounds = round + 1;
      const executionSteps = [...steps, ...this.queryVariantSteps(plan, round, steps)];
      const compiled: AgentToolCall[] = [];
      const compileFailures: AgentToolResult[] = [];
      for (const step of executionSteps) {
        try {
          const call = this.compileStep(step, scope, context, plan, round, out, user, fileScope);
          if (!call) throw new Error('Unresolved tool scope');
          compiled.push(call);
        } catch {
          // One malformed/unresolvable optional channel must not suppress independent safe channels.
          compileFailures.push({
            callId: step.id,
            toolName: step.tool,
            status: 'error',
            data: null,
            total: 0,
            pagination: null,
            error: { code: 'PLAN_SCOPE_UNRESOLVED', message: '该检索渠道的作用域无法安全解析，已跳过该渠道。' },
          });
        }
      }
      // A failed optional compiler node blocks its descendants, not independent channels.
      for (let changed=true;changed;) {
        changed=false;
        for(let i=compiled.length-1;i>=0;i--) if(compiled[i].dependsOn?.some(id=>!compiled.some(c=>c.id===id))) {
          const [call]=compiled.splice(i,1);changed=true;
          compileFailures.push({callId:call.id,toolName:call.toolName,status:'skipped',data:null,total:0,pagination:null,error:{code:'DEPENDENCY_FAILED',message:'依赖步骤无法安全解析，未执行关联查询。'}});
        }
      }
      const activeTools = compiled.map((call) => call.toolName);
      if (activeTools.some((tool) => ['archive.search', 'archive.detail', 'category.list', 'graph.relations', 'borrow.search', 'borrow.detail', 'audit.search', 'template.search'].includes(tool))) recordStep('archives', 'running', 0, 0);
      if (activeTools.includes('attachment.search')) recordStep('attachments', 'running', 0, 0);
      if (activeTools.some((tool) => ['content.search', 'content.read'].includes(tool))) recordStep('content', 'running', 0, 0);
      const executed = compiled.length ? await this.dispatcher.executeAllPages(compiled, user) : { results: [] as AgentToolResult[] };
      out.results.push(...compileFailures, ...executed.results);
      this.recordToolProgress(out.results);
      this.absorbResults(out, executed.results);
      cov.expectedArchives = Math.max(cov.expectedArchives, scope?.length ?? 0);
      this.computeCoverage(cov, out, fullTextRequired);
      if (plan.responseMode === 'compare') {
        const expected = out.results.filter(r=>r.callId?.startsWith('constraint:file:') && r.status==='success').flatMap(r=>r.data.items);
        cov.comparisonMissingSide = !!out.missingAttachments?.length || expected.some(f=>!out.evidence.some(e=>e.fileId===f.fileId));
      }
      if (out.results.length) recordStep('evidence', 'running', 0, 0);
      const maxSupplementRounds = budget?.maxSupplementRounds ?? 1;
      // 充分性模型只用于决定是否值得再检索一轮。明确禁止扩展时跳过；预算耗尽时保留
      // 「尚未完成全面分析」提示，但不再发起模型请求。最后一轮仍评估一次，供回答诚实标注证据状态。
      if (!plan.allowExpansion) {
        out.sufficiency = { verdict: 'unknown', note: '本轮没有安排额外检索。' };
        break;
      }
      if (budget?.exhausted) {
        sufficiencyEvaluated = true;
        out.sufficiency = { verdict: 'unknown', note: '执行预算已耗尽，无法完成充分性评估。' };
        break;
      }
      const judgement = await judgeSufficiency(model, plan.originalQuestion, this.evidenceDigest(out), cov, out.results.filter(r=>r.status==='success').map(r=>r.callId!).filter(Boolean));
      sufficiencyEvaluated = true;
      out.sufficiency = { verdict: judgement.verdict, note: judgement.note };
      if (judgement.verdict === 'sufficient' && !isCoverageIncomplete(cov)) break;
      if (round >= maxSupplementRounds || judgement.verdict === 'clarify') break;
      const supplement = fullTextRequired ? deriveSupplementSteps(cov, this.indexGapFileIds(out), steps) : [];
      if (judgement.verdict === 'supplement') {
        try { supplement.push(...validatePlanSteps(judgement.supplement, out.results.map(r => r.callId!).filter(Boolean))); }
        catch { out.diagnostics.push('补充计划未通过安全校验，未扩大检索范围。'); }
      }
      if (!supplement.length) break;
      steps = supplement;
    }
    if(cov.comparisonMissingSide) for(const file of out.results.filter(r=>r.callId?.startsWith('constraint:file:') && r.status==='success').flatMap(r=>r.data.items).filter(f=>!out.evidence.some(e=>e.fileId===f.fileId))) {
      const status=out.results.flatMap(r=>r.data?.indexStatuses??[]).find(f=>f.fileId===file.fileId);
      out.notes.push(`附件「${file.fileName}」的正文还没有读取完整${status ? '（该附件的正文尚未处理完成）' : ''}，暂时无法进行比较。`);
    }
    if (out.sufficiency?.verdict === 'sufficient' && fullTextRequired && isCoverageIncomplete(cov)) out.sufficiency = {verdict:'unknown',note:'要求的范围或索引尚未完整覆盖，只能提供已核验的局部事实。'};
    // 判定结论与技术原文只进诊断：用户面只需要「已看到哪里、还差什么」这类业务语言。
    if ((sufficiencyEvaluated && out.sufficiency?.verdict !== 'sufficient') || isCoverageIncomplete(cov)) {
      out.diagnostics.push(`证据充分性：${out.sufficiency?.verdict ?? 'unknown'}。${out.sufficiency?.note ?? ''}`);
    }
    if (out.evidence.length) {
      // 有可引用证据时才需要说明范围；完全没有证据时由「无正文依据」答复统一解释，避免与本条重复。
      if (isCoverageIncomplete(cov)) out.limitations.push(renderCoverageNote(cov));
      else if (sufficiencyEvaluated && out.sufficiency?.verdict !== 'sufficient') out.limitations.push('本次只核对了已经读到的部分正文，尚未完成全面分析，下面的结论只基于这些内容。');
    } else if (isCoverageIncomplete(cov)) {
      out.diagnostics.push(renderCoverageNote(cov));
    }
    return this.finalize(out, user);
  }

  /**
   * Execute AI-generated query variants through the same registered read-only tools.
   * This is generic plan expansion, not a question-specific keyword/regex route.
   */
  private queryVariantSteps(plan: RetrievalPlan, round: number, baseSteps: PlanStep[]): PlanStep[] {
    const candidates: Array<{ source: string; term: string; tool: PlanStep['tool']; args: Record<string, unknown>; expects: PlanStep['expects'] }> = [];
    // Do not synthesize broad query steps when the AI plan contains a narrower
    // per-step reference/dependency; doing so could accidentally widen its scope.
    if (baseSteps.some(step => !!step.contextRef || !!step.scope || !!step.dependsOn?.length ||
      step.searchScope?.kind === 'context' || step.searchScope?.kind === 'fromStep')) return [];

    const enabledSources = new Set(plan.searchSources);
    const sourceEnabled = (source: string) => enabledSources.size === 0 ||
      enabledSources.has(source as RetrievalSource) ||
      (source === 'archive' && enabledSources.has('metadata')) ||
      (source === 'semantic' && enabledSources.has('content'));
    const add = (source: string, term: string, tool: PlanStep['tool'], args: Record<string, unknown>, expects: PlanStep['expects']) => {
      const value = String(term ?? '').trim();
      if (value && Array.from(value).length >= 2 && sourceEnabled(source)) candidates.push({ source, term: value, tool, args, expects });
    };

    if (round === 0) {
      for (const term of plan.archiveTitleCandidates) add('archive', term, 'archive.search', { keyword: term }, 'metadata');
      for (const term of plan.archiveNumberCandidates) add('archive', term, 'archive.search', { archiveNo: term }, 'metadata');
      for (const term of plan.metadataTerms) add('metadata', term, 'archive.search', { keyword: term }, 'metadata');
      for (const term of plan.attachmentNameCandidates) add('attachment', term, 'attachment.search', { keyword: term }, 'attachmentNames');
      if (plan.contentTerms.length) {
        const query = [...new Set(plan.contentTerms)].join(' ');
        add('content', query, 'content.search', { query }, 'relevantText');
      }
      if (plan.semanticConcepts.length) {
        const query = [...new Set(plan.semanticConcepts)].join(' ');
        add('semantic', query, 'content.search', { query }, 'relevantText');
      }
      for (const term of plan.categoryCandidates) add('category', term, 'category.list', { keyword: term }, 'metadata');
    }

    for (const variant of plan.searchVariants) {
      if (variant.expanded !== (round > 0)) continue;
      if (variant.source === 'archive' || variant.source === 'metadata') {
        add(variant.source, variant.term, 'archive.search', { keyword: variant.term }, 'metadata');
      } else if (variant.source === 'attachment') {
        add(variant.source, variant.term, 'attachment.search', { keyword: variant.term }, 'attachmentNames');
      } else if (variant.source === 'content' || variant.source === 'semantic') {
        add(variant.source, variant.term, 'content.search', { query: variant.term }, 'relevantText');
      } else if (variant.source === 'category') {
        add(variant.source, variant.term, 'category.list', { keyword: variant.term }, 'metadata');
      }
    }

    const existing = new Set(baseSteps.map(step => `${step.tool}:${JSON.stringify(step.args)}`));
    const usedIds = new Set(baseSteps.map(step => step.id));
    const generated: PlanStep[] = [];
    const maxGenerated = Math.min(8, Math.max(0, 16 - baseSteps.length));
    if (!maxGenerated) return generated;
    for (const candidate of candidates) {
      const key = `${candidate.tool}:${JSON.stringify(candidate.args)}`;
      if (existing.has(key)) continue;
      existing.add(key);
      let id = `agent-query-${round + 1}-${generated.length + 1}`;
      while (usedIds.has(id)) id = `agent-${id}`;
      usedIds.add(id);
      generated.push({
        id,
        tool: candidate.tool,
        intent: `AI-generated ${candidate.source} lexical query`,
        expects: candidate.expects,
        args: candidate.args,
        searchScope: plan.searchScope,
        referenceRefs: plan.referenceSlots,
      });
      if (generated.length >= maxGenerated) break;
    }
    return generated;
  }

  /** 把单个子步骤编译为带后端授权作用域的工具调用；正文检索固定使用 FTS5 Bigram + BM25。 */
  private compileStep(
    step: PlanStep, baseScope: number[] | undefined, context: AgentContextSnapshot,
    plan: RetrievalPlan, round: number, out: RetrievalOutcome, user: UserView, baseFiles?: number[],
  ): AgentToolCall | null {
    const args = step.args as Record<string, unknown>;
    const str = (k: string): string | undefined => typeof args[k] === 'string' ? (args[k] as string) : undefined;
    const contentClass = step.expects === 'relevantText' || step.expects === 'fullText'
      || ['content.search', 'content.read'].includes(step.tool);
    let tool = step.tool;
    let params: AgentToolCall['params'] = {};
    const dependsOn = [...(step.dependsOn ?? [])];
    const effectiveScope = step.searchScope ?? plan.searchScope;
    let scopeFrom: { step: string; kind: 'archive' | 'file' | 'auto' } | undefined;

    // 作用域解析：默认继承护栏 scope；contextRef 解析为已授权槽位 ID；step:<id> 走通用上游注入。
    let archiveIds = baseScope ? [...baseScope] : undefined;
    let fileIds: number[] | undefined = baseFiles ? [...baseFiles] : undefined;
    if (step.contextRef) {
      const a = this.slotArchives(context, step.contextRef); const f = this.slotFiles(context, step.contextRef);
      if (!a.length || (step.contextRef.entity === 'attachment' && !f.length)) throw new Error('Unresolved context reference');
      archiveIds = archiveIds ? a.filter(id => archiveIds!.includes(id)) : a; if (f.length) fileIds = fileIds ? fileIds.filter(id=>f.includes(id)) : f;
    }
    const scopeStep = step.scope?.startsWith('step:') ? step.scope.slice(5) : effectiveScope.kind === 'fromStep' ? effectiveScope.step : undefined;
    if (scopeStep) {
      if (!out.results.some(r => r.callId === scopeStep)) {
        if (!dependsOn.includes(scopeStep)) dependsOn.push(scopeStep);
        scopeFrom = { step: scopeStep, kind: ['archive.detail', 'attachment.search', 'archive.search', 'graph.relations'].includes(step.tool) ? 'archive' : 'auto' };
      } else {
        const found = out.results.filter(r => r.callId === scopeStep || r.callId?.startsWith(`${scopeStep}:page:`));
        if (!found.length || found.some(r => r.status !== 'success')) throw new Error('Unresolved supplement reference');
        const rows = found.flatMap(r => r.data?.items ?? []);
        const ids = [...new Set<number>(rows.map(r => r.archiveId ?? r.id).filter(Number.isSafeInteger))];
        if (!ids.length) throw new Error('Empty supplement reference');
        archiveIds = archiveIds ? ids.filter(id => archiveIds!.includes(id)) : ids;
        const files = [...new Set<number>(rows.map(r => r.fileId).filter(Number.isSafeInteger))];
        if (files.length && contentClass) fileIds = fileIds ? fileIds.filter(id=>files.includes(id)) : files;
        for (let i = dependsOn.length - 1; i >= 0; i--) if (out.results.some(r => r.callId === dependsOn[i])) dependsOn.splice(i, 1);
      }
    }
    if (effectiveScope.kind === 'context' && !step.contextRef) {
      const ctxIds = context.activeArchives.length ? context.activeArchives : context.archives;
      if (!ctxIds.length) throw new Error('Unresolved context scope');
      archiveIds = archiveIds ? archiveIds.filter(id => ctxIds.includes(id)) : [...ctxIds];
      if (context.focus === 'attachment') fileIds = fileIds ? fileIds.filter(id=>context.activeFiles.includes(id)) : [...context.activeFiles];
    }
    // allAuthorized 是默认/全局检索范围：约束收窄（categoryFilter / archiveNumbers /
    // archiveTitles / archiveStatus / timeRange）已通过 baseScope 体现在 archiveIds 初始值中，
    // 此处无需额外覆盖。其他 kind（context / fromStep）由各自分支处理。
    // 生成的查询变体步骤继承 plan.searchScope（通常为 allAuthorized），必须尊重 baseScope 收窄，
    // 否则会出现「指定档案范围检索时出现范围外结果」的问题。
    if (fileIds && !fileIds.length) throw new Error('Empty explicit attachment scope');
    if (archiveIds && !archiveIds.length) throw new Error('Empty explicit scope');

    if (args.timeRange && typeof args.timeRange === 'object' && JSON.stringify(args.timeRange) !== JSON.stringify(plan.timeRange)) throw new Error('Unresolved step date constraint');
    if (contentClass && step.expects === 'fullText' &&
      (!isGraphRelatedFullTextStep(step, plan) || plan.includeRelatedFullText)) {
      tool = 'content.read';
      // 确定性补检步骤 id 形如 supplement:read:<fileId>：按文件精确整篇读取（archiveIds 由已有证据回推）。
      if (step.serverFileRef) {
        const fileId = step.serverFileRef;
        const statuses = out.results.flatMap(r => r.data?.indexStatuses ?? []);
        const owner = statuses.find(f => f.fileId === fileId)?.archiveId;
        if (!Number.isSafeInteger(owner)) throw new Error('Unverified server file reference');
        archiveIds = archiveIds ? archiveIds.filter(id => id === owner) : [owner];
        fileIds = [fileId];
      }
      params = { ...(archiveIds?.length ? { archiveIds } : {}), ...(fileIds?.length ? { fileIds } : {}), summary: true, ...(str('extension') ? {extension:str('extension')} : {}) };
      if (!params.archiveIds?.length && !scopeFrom) throw new Error('Full text requires an authorized locator');
    } else if (contentClass) {
      // All Agent body retrieval uses the lexical content.search tool: SQLite FTS5 CJK Bigram + BM25.
      // AI-generated concepts/variants are query clues, never a vector-search request.
      tool = 'content.search';
      const explicitQuery = str('query') ?? str('semanticQuery') ?? str('keyword');
      const fallbackClues = [...plan.contentTerms, ...plan.semanticConcepts]
        .filter(Boolean);
      const query = explicitQuery ?? ([...new Set(fallbackClues)].join(' ') || plan.normalizedQuestion);
      params = { query, ...(str('extension') ? {extension:str('extension')} : {}), pageSize: 30,
        ...(archiveIds?.length ? { archiveIds } : {}), ...(fileIds?.length ? { fileIds } : {}) };
    } else {
      const scoped = AgentRetrievalService.ARCHIVE_SCOPED.has(tool);
      params = ['statistics.get', 'borrow.detail', 'archive.detail', 'graph.relations'].includes(tool) ? {} : { pageSize: 100 };
      for (const k of ['keyword', 'title', 'archiveNo', 'attachmentFileName', 'extension', 'actorName', 'status', 'from', 'to'] as const) { const v = str(k); if (v !== undefined) (params as Record<string, unknown>)[k] = v; }
      if (tool === 'graph.relations' && typeof args.includeStructure === 'boolean') params.includeStructure=args.includeStructure;
      if (tool === 'borrow.search' && str('dataScope')) params.scope = str('dataScope') as 'mine' | 'review';
      if (typeof args.timeRange === 'string') params.timeRange = args.timeRange;
      if (scoped && archiveIds?.length) params.archiveIds = archiveIds;
      if (scoped && fileIds?.length && contentClass) params.fileIds = fileIds;
      if (tool === 'archive.detail') { if (!archiveIds?.length && !scopeFrom) throw new Error('Detail requires an authorized locator'); params = archiveIds?.length ? { archiveId: archiveIds[0] } : {}; }
    }
    if (contentClass && step.expects !== 'fullText') {
      const refs = step.referenceRefs?.length ? step.referenceRefs : plan.referenceSlots;
      if (refs.length) {
        const refArchives = [...new Set(refs.flatMap(ref => this.slotArchives(context, ref)))];
        if (!refArchives.length) throw new Error('Unresolved similarity reference');
        const visibleFiles = refArchives.flatMap(id => this.archives.getArchiveDetail(id, user).files.map(f => f.id));
        const requestedFiles = refs.flatMap(ref => this.slotFiles(context, ref));
        if (requestedFiles.some(id => !visibleFiles.includes(id))) throw new Error('Invalid similarity reference');
        params.referenceFileIds = requestedFiles.length ? requestedFiles : visibleFiles;
        if (!params.referenceFileIds.length) throw new Error('Similarity reference has no content');
      }
    }
    if (scopeFrom) { if (!dependsOn.includes(scopeFrom.step)) dependsOn.push(scopeFrom.step); }
    const call: AgentToolCall = { id: step.id, toolName: tool, params };
    if (dependsOn.length) call.dependsOn = [...new Set(dependsOn)];
    if (scopeFrom) call.scopeFrom = scopeFrom;
    return call;
  }

  /** 会话档案槽位 → 后端已授权 archiveId 列表（slot 越界/缺失返回空，绝不臆造 ID）。 */
  private slotArchives(context: AgentContextSnapshot, ref: ContextRef): number[] {
    const list = context.activeArchives.length ? context.activeArchives : context.archives;
    if (ref.entity === 'attachment') {
      if (ref.slot === undefined || ref.slot === 'all') return [...new Set(context.attachments.map(a => a.archiveId))];
      if (ref.slot === 'focus') { const a = context.attachments[0]; return a ? [a.archiveId] : []; }
      const a = context.attachments[ref.slot - 1]; return a ? [a.archiveId] : [];
    }
    if (ref.slot === undefined || ref.slot === 'all') return [...list];
    if (ref.slot === 'focus') return list.length ? [list[0]] : [];
    return ref.slot - 1 < list.length ? [list[ref.slot - 1]] : [];
  }

  /** 会话附件槽位 → 后端已授权 fileId 列表。 */
  private slotFiles(context: AgentContextSnapshot, ref: ContextRef): number[] {
    if (ref.entity !== 'attachment') return [];
    if (ref.slot === undefined || ref.slot === 'all') return context.attachments.map(a => a.fileId);
    if (ref.slot === 'focus') return context.focus === 'attachment' ? [...context.activeFiles] : [];
    const a = context.attachments[ref.slot - 1]; return a ? [a.fileId] : [];
  }

  /** 收集工具结果：内容类结果并入证据，档案类结果并入卡片；附件/其它保留在 results 供 finalize 关联。 */
  private absorbResults(out: RetrievalOutcome, results: AgentToolResult[]): void {
    for (const r of results) {
      if (r.status !== 'success' || !r.data?.items) continue;
      if (['content.search', 'content.read'].includes(r.toolName)) {
        const searchSource = r.data.keywordMode ?? r.data.retrievalMode ?? r.toolName;
        const hitType = r.toolName === 'content.read' ? 'full_content' : 'content';
        out.evidence.push(...r.data.items.map((e: EvidenceRow) => ({ ...e, searchSource, hitType })));
      } else if (r.toolName === 'archive.search' || r.toolName === 'archive.detail') {
        out.archives.push(...r.data.items);
      }
    }
  }

  /** 计算结构化覆盖率：应处理 vs 实际处理、索引缺口、整篇读取缺口、降级渠道。 */
  private computeCoverage(cov: CoverageSignal, out: RetrievalOutcome, expectsFullText: boolean): void {
    const statusResults = out.results.filter(r => r.status === 'success' && !r.callId?.startsWith('constraint:') &&
      Array.isArray(r.data?.indexStatuses) && (!expectsFullText || r.toolName === 'content.read'));
    const indexStatuses = statusResults.flatMap(r => r.data.indexStatuses as Array<{ fileId: number; status: string; chunkCount?: number; fileName?: string; truncated?: boolean }>);
    const seenFiles = new Set(indexStatuses.map(f => f.fileId));
    cov.expectedFiles = expectsFullText ? Math.max(cov.expectedFiles, seenFiles.size) : new Set(out.evidence.map(e=>e.fileId)).size;
    cov.processedFiles = [...new Set(out.evidence.map(e => e.fileId))].length;
    cov.indexIncomplete = indexStatuses.filter(f => f.status !== 'indexed').length;
    cov.skippedSamples.push(...indexStatuses.filter(f => f.status !== 'indexed').slice(0, 4).map(f => f.fileName ?? `附件#${f.fileId}`));
    const statuses = [...new Map(indexStatuses.map(f => [f.fileId, f])).values()];
    cov.indexIncomplete = statuses.filter(f => f.status !== 'indexed' || f.truncated).length;
    const attachmentResults = out.results.filter(r => r.status === 'success' && r.toolName === 'attachment.search');
    const archiveResults = out.results.filter(r => r.status === 'success' && !r.callId?.startsWith('constraint:') && ['archive.search', 'archive.detail'].includes(r.toolName));
    cov.candidateArchives = new Set([...out.archives.map(a => a.id), ...out.evidence.map(e => e.archiveId)]).size;
    cov.expectedArchives = Math.max(cov.expectedArchives, ...archiveResults.map(r => r.total), cov.candidateArchives);
    cov.processedArchives = new Set(expectsFullText ? out.evidence.map(e => e.archiveId) : [...out.archives.map(a => a.id), ...out.evidence.map(e => e.archiveId)]).size;
    cov.expectedFiles = Math.max(cov.expectedFiles, ...attachmentResults.map(r => r.total), new Set(attachmentResults.flatMap(r => r.data.items.map((f: any) => f.fileId))).size);
    cov.expectedChunks = expectsFullText ? statuses.reduce((n, f) => n + (f.chunkCount ?? 0), 0) : 0;
    cov.processedChunks = new Set(out.evidence.map(e => e.chunkId)).size;
    cov.processedFiles = expectsFullText ? statuses.filter(f => f.status === 'indexed' && !f.truncated &&
      new Set(out.evidence.filter(e => e.fileId === f.fileId).map(e => e.chunkId)).size === f.chunkCount).length
      : new Set([...out.evidence.map(e => e.fileId), ...attachmentResults.flatMap(r => r.data.items.map((f: any) => f.fileId))]).size;
    cov.topKTruncated = out.results.some(r => r.data?.truncated === true);
    cov.budgetExhausted = executionBudget()?.exhausted ?? false;
    cov.tokenUsage = executionBudget()?.tokens ?? 0;
    cov.unprocessedObjects = Math.max(0, cov.expectedArchives - cov.processedArchives) + Math.max(0, cov.expectedFiles - cov.processedFiles);
    cov.degradedChannels = [...new Set(out.results.filter(r => r.status !== 'success' || r.data?.degradedReason).map(r => r.toolName))];
    if (expectsFullText) cov.fullTextGaps = this.indexGapFileIds(out).length;
  }

  /** 已索引但整篇分块未读全的附件（仅在期望 fullText 时视为缺口，触发补检）。 */
  private indexGapFileIds(out: RetrievalOutcome): number[] {
    // A global content.search may report only files that actually matched, while
    // content.read reports the files in its explicit archive/file scope.
    // Never turn an unfiltered index-status inventory into a full-library read.
    const relevantFileIds = new Set<number>(out.evidence.map(e => e.fileId));
    for (const result of out.results) {
      if (result.status !== 'success') continue;
      if (result.toolName === 'attachment.search') {
        for (const row of result.data?.items ?? []) {
          if (Number.isSafeInteger(row?.fileId)) relevantFileIds.add(Number(row.fileId));
        }
      }
      if (result.toolName === 'content.read') {
        for (const row of result.data?.indexStatuses ?? []) {
          if (Number.isSafeInteger(row?.fileId)) relevantFileIds.add(Number(row.fileId));
        }
      }
    }
    if (!relevantFileIds.size) return [];
    const indexed = out.results
      // Full-text gaps must be derived only from explicit content.read scopes. A related content.search
      // is intentionally a snippet lookup and must never trigger a whole-file supplement read.
      .filter(result => result.status === 'success' && result.toolName === 'content.read' && !result.callId?.startsWith('constraint:') && Array.isArray(result.data?.indexStatuses))
      .flatMap(result => result.data.indexStatuses as Array<{ fileId: number; status: string; chunkCount?: number }>)
      .filter(file => file.status === 'indexed' && relevantFileIds.has(file.fileId));
    return [...new Set(indexed.filter(file => {
      const actual = new Set(out.evidence.filter(evidence => evidence.fileId === file.fileId).map(evidence => evidence.chunkId)).size;
      return typeof file.chunkCount === 'number' && actual < file.chunkCount;
    }).map(file => file.fileId))];
  }

  /** 证据摘要（非全文）供充分性裁判，控制 Token 并不泄露越权内容（finalize 前仅含已授权证据）。 */
  private evidenceDigest(out: RetrievalOutcome): string {
    const steps = out.results.map(r => ({stepId:r.callId,tool:r.toolName,status:r.status,total:r.total,
      items:!['content.read','content.search'].includes(r.toolName) ? (r.data?.items??[]).map((x:any)=>({title:x.title,fileName:x.fileName,archiveTitle:x.archiveTitle,archiveNo:x.archiveNo,attachmentCount:x.files?.length})) : undefined}));
    const files=[...new Set(out.evidence.map(e=>e.fileId))];
    const perFile=Math.max(300,Math.floor(6000/Math.max(files.length,1)));
    const evidence=files.map(fileId=>{const rows=out.evidence.filter(e=>e.fileId===fileId);const text=rows.map(e=>e.text).join('\n');return {file:rows[0].fileName,archive:rows[0].archiveTitle,chunks:rows.length,text:text.slice(0,perFile),sampleTruncated:text.length>perFile};});
    return JSON.stringify({steps,evidence,digestIsSample:true,notice:'这是分文档的摘要采样，全文完整性以 coverage 和工具实际分块数为准。不要因采样截断而重复读取已完整读取的文件。'});
  }
}
