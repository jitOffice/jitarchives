import { executionBudget } from './execution.budget';
import { ContentKeywordSearchService } from '../search/content-keyword-search.service';
/** Read-only whitelist. This registry intentionally does not import the legacy write-tool service. */
import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { KnowledgeSearchService } from '../knowledge/knowledge-search.service';
import { ArchivesService } from '../archives/archives.service';
import { ArchiveAccessService } from '../archives/archive-access.service';
import { ContentIndexService } from '../archives/content/content-index.service';
import { ContentIndexRepository, EvidenceRow, ViewerScope } from '../archives/content/content-index.repositories';
import { BorrowingService } from '../borrowing/borrowing.service';
import { GraphQueryService } from '../graph/graph.query.service';
import type { KgEdgeEvidence } from '../graph/graph.query.types';
import { hasPermission, PermKey } from '../common/permissions';
import { ROLE_ADMIN, UserView, isValidRole } from '../common/roles';
import { UnifiedSearchService } from '../search/unified-search.service';
import { AgentUnifiedBusinessSearchService } from './unified-business-search.service';
import { SearchTimeRange } from './intent.parser';
import { AUDIT_ACTION } from '../audit/audit.types';
import { AgentToolDefinition, AgentToolResult, ToolParams, ToolProperty, ToolSchema } from './tool.types';

const text: ToolProperty = { type: 'string', maxLength: 100 };
const id: ToolProperty = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const ids: ToolProperty = { type: 'array', items: id, maxItems: 5000 };
const paging = { page: { ...id, maximum: 1000000 }, pageSize: { ...id, maximum: 100 } };
const archive = { archiveIds: ids, keyword: text, title: text, archiveNo: text, categoryId: id, status: { ...text, enum: ['draft', 'archived'] } };
/** 第三阶段：图谱关联工具的边界（只读线索，数量受控；关系证据字段由 GraphQueryService 白名单投影）。 */
const GRAPH_RELATION_ARCHIVE_LIMIT = 10;
const GRAPH_RELATION_PAGE_SIZE = 20;
const GRAPH_RELATION_NOTE_LIMIT = 30;
const GRAPH_BASIS_DISCLAIMER: Record<string, string> = {
  tfidf_cosine: 'TF-IDF 相似度只说明正文词项相似，不能证明两份档案存在项目、合同或其他业务关系。',
  tfidf_cosine_aggregated: '档案级相似度由知识块两两相似聚合而来，只说明词项相似，不能证明真实业务关系。',
  metadata_exact_match: '著录字段等值命中来自真实字段，可作为确定性检索线索。',
  business_structure: '结构包含关系来自业务归属，不是内容证据。',
};
/** 计算依据的内部编码 → 用户语言；原始编码只留在 items[].basis，不进说明面板。 */
const GRAPH_BASIS_LABEL: Record<string, string> = {
  tfidf_cosine: '正文用词相似（TF-IDF）',
  tfidf_cosine_aggregated: '整份档案正文用词相似（TF-IDF 聚合）',
  metadata_exact_match: '著录字段等值',
  business_structure: '业务结构归属',
  unknown: '未能识别的计算依据',
};

/** 关系证据 → 原始知识块与来源位置（只取定位字段，不携带正文全文）。 */
function graphEvidenceLocators(evidence: KgEdgeEvidence): Array<Record<string, unknown>> {
  if (evidence.basis === 'tfidf_cosine') {
    return [evidence.from, evidence.to].map(l => ({ archiveId: l.archiveId, fileId: l.fileId, chunkId: l.chunkId, chunkNo: l.chunkNo, locator: l.locator, pageNo: l.pageNo, preview: l.preview }));
  }
  if (evidence.basis === 'tfidf_cosine_aggregated') {
    return evidence.supportingChunks.slice(0, 4).map(s => ({ fromChunkId: s.fromChunkId, toChunkId: s.toChunkId, fromFileId: s.fromFileId, toFileId: s.toFileId, similarity: s.similarity, sharedTerms: s.sharedTerms }));
  }
  if (evidence.basis === 'business_structure') {
    return [{ archiveId: evidence.archiveId ?? null, fileId: evidence.fileId ?? null, chunkId: evidence.chunkId ?? null, locator: evidence.locator ?? '', pageNo: evidence.pageNo ?? null }];
  }
  return [];
}
const file = { ...archive, archiveIds: ids, fileIds: ids, attachmentFileName: text, extension: { ...text, maxLength: 10, pattern: '^[a-z0-9]{1,10}$' } };
const dates = { from: { ...text, maxLength: 30 }, to: { ...text, maxLength: 30 } };
const timeRange = { ...text, enum: ['today', 'yesterday', '7d', '30d', '90d'] };

export function assertToolUser(operator: UserView): void {
  if (!operator || !Number.isSafeInteger(operator.id) || operator.id <= 0) throw new UnauthorizedException('请先登录');
  if (operator.status !== 'active' || !isValidRole(operator.role)) throw new ForbiddenException('当前账号不可访问工具');
}

/** Strict JSON-style schema validation: no coercion, unknown keys or identity fields. */
function validateValue(value: unknown, spec: ToolProperty, path: string): void {
  if (spec.type === 'integer') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < spec.minimum! || value > spec.maximum!) {
      throw new BadRequestException(`工具参数 ${path} 必须是有效范围内的整数`);
    }
  } else if (spec.type === 'array') {
    if (!Array.isArray(value) || value.length > spec.maxItems!) throw new BadRequestException(`工具参数 ${path} 必须是有界数组`);
    value.forEach((item, index) => validateValue(item, spec.items!, `${path}[${index}]`));
  } else if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') throw new BadRequestException(`工具参数 ${path} 必须是布尔值`);
  } else if (typeof value !== 'string' || !value.trim() || value.length > spec.maxLength! ||
      (spec.enum && !spec.enum.includes(value)) || (spec.pattern && !new RegExp(spec.pattern).test(value))) {
    throw new BadRequestException(`工具参数 ${path} 类型或取值不合法`);
  }
}

function validate(raw: unknown, schema: ToolSchema): ToolParams {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    throw new BadRequestException('工具参数必须是普通对象');
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(schema.properties, key)) throw new BadRequestException(`工具不接受参数 ${key}`);
    if (value === undefined) continue;
    validateValue(value, schema.properties[key], key);
    out[key] = typeof value === 'string' ? value.trim() : Array.isArray(value) ? [...new Set(value)] : value;
  }
  for (const key of schema.required) if (out[key] === undefined) throw new BadRequestException(`工具缺少参数 ${key}`);
  for (const key of ['from', 'to']) {
    if (out[key] && (!/^\d{4}-\d{2}-\d{2}T/.test(String(out[key])) || !Number.isFinite(Date.parse(String(out[key]))))) {
      throw new BadRequestException(`工具参数 ${key} 必须是 ISO 时间`);
    }
  }
  if (out.from && out.to && Date.parse(String(out.from)) > Date.parse(String(out.to))) throw new BadRequestException('起始时间不能晚于结束时间');
  return out as ToolParams;
}

export function toolFailure(toolName: string, error: unknown): AgentToolResult {
  const status = error instanceof HttpException ? error.getStatus() : 500;
  return { toolName, status: 'error', data: null, total: 0, pagination: null,
    error: { code: String(status), message: status < 500 && error instanceof Error ? error.message : '业务查询失败，请稍后重试' } };
}

export function toolPage(data: unknown, total: number, params: ToolParams): AgentToolResult {
  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 8;
  return { toolName: '', status: 'success', data, total,
    pagination: { page, pageSize, totalPages: Math.ceil(total / pageSize), hasMore: page * pageSize < total }, error: null };
}

@Injectable()
export class AgentToolRegistry {
  private readonly definitions = new Map<string, AgentToolDefinition>();

  constructor(
    @Inject(ArchivesService) private readonly archives: ArchivesService,
    @Inject(ArchiveAccessService) private readonly access: ArchiveAccessService,
    @Inject(UnifiedSearchService) private readonly unified: UnifiedSearchService,
    @Inject(AgentUnifiedBusinessSearchService) private readonly business: AgentUnifiedBusinessSearchService,
    @Inject(BorrowingService) private readonly borrowing: BorrowingService,
    @Inject(ContentIndexService) private readonly contentIndex: ContentIndexService,
    @Inject(ContentIndexRepository) private readonly contentUnits: ContentIndexRepository,
    @Inject(ContentKeywordSearchService) private readonly keywords: ContentKeywordSearchService,
    @Inject(KnowledgeSearchService) private readonly knowledge: KnowledgeSearchService,
    @Inject(GraphQueryService) private readonly graph: GraphQueryService,
  ) {
    this.add('archive.search', '按标题、档号、分类、状态和关键词分页查询当前用户可见的档案', { ...archive, ...paging }, 'archiveView', (p, user) => {
      this.assertArchives(p.archiveIds, user);
      const page = this.archives.searchArchives({ ...(p.archiveIds ? { archiveIds: p.archiveIds } : {}), q: p.keyword, title: p.title, archiveNo: p.archiveNo,
        categoryId: p.categoryId === undefined ? undefined : String(p.categoryId), includeSub: '1', status: p.status,
        page: String(p.page ?? 1), pageSize: String(p.pageSize ?? 8) }, user);
      return toolPage({ items: page.items }, page.total, p);
    });
    this.add('archive.detail', '获取有权访问的档案真实详情与附件', { archiveId: id }, 'archiveView', (p, user) => {
      const detail = this.archives.getArchiveDetail(p.archiveId!, user);
      return toolPage({ items: [detail] }, 1, {});
    }, ['archiveId']);
    this.add('attachment.search', '全局或按档案 ID 查询附件，独立筛选文件名及格式', { ...file, ...paging }, 'archiveView', (p, user) => {
      this.assertArchives(p.archiveIds, user);
      const group = this.unified.search({ ...p, status: p.status as 'draft' | 'archived' | undefined,
        scopes: ['attachment'], limit: p.pageSize ?? 8 }, user).attachments;
      const indexStatuses = group.items.length ? this.contentIndex.describeVisible(
        {userId:user.id, admin:user.role === ROLE_ADMIN}, [...new Set(group.items.map(f=>f.archiveId))], group.items.map(f=>f.fileId)) : [];
      return toolPage({...group, indexStatuses}, group.total, p);
    });
    this.add('content.search', '通过 SQLite FTS5 CJK Bigram + BM25 查询有权限的附件正文片段，可使用参考附件生成词法检索特征', {
      ...file, query: { ...text, maxLength: 1000 }, referenceFileIds: { ...ids, maxItems: 100 }, ...paging,
    }, 'archiveView', (p, user) => {
      this.assertArchives(p.archiveIds, user);
      for (const fileId of p.referenceFileIds ?? []) {
        const ownerIds = [...new Set(this.contentUnits.listUnitsOfFile(fileId).map(unit => unit.archiveId))];
        if (!ownerIds.length) throw new BadRequestException('参考附件不存在或没有可用正文索引');
        for (const archiveId of ownerIds) {
          this.access.assertView(user, this.access.loadArchive(archiveId));
          if (!this.archives.getArchiveDetail(archiveId, user).files.some(file => file.id === fileId)) {
            throw new BadRequestException('参考附件不属于当前可访问档案');
          }
        }
      }
      const scope: ViewerScope = { userId: user.id, admin: user.role === ROLE_ADMIN };
      const found = this.keywords.search({
        query: p.query ?? p.keyword ?? '',
        scope,
        archiveIds: p.archiveIds,
        fileIds: p.fileIds,
        archiveNo: p.archiveNo,
        archiveTitle: p.title,
        extension: p.extension,
        referenceFileIds: p.referenceFileIds,
      });
      const safe = found.items.filter(row => {
        try {
          return this.access.canView(user, this.access.loadArchive(row.archiveId)) &&
            this.archives.getArchiveDetail(row.archiveId, user).files.some(file => file.id === row.fileId) &&
            this.contentIndex.isCurrentEvidence(row.fileId, row.unitId);
        } catch { return false; }
      });
      const page = p.page ?? 1;
      const pageSize = p.pageSize ?? 30;
      const items = safe.slice((page - 1) * pageSize, page * pageSize);
      // Do not disclose every accessible attachment's index status for a global query.
      // Only return statuses for explicit scope or files that actually matched the query.
      const statusScope = p.archiveIds?.length || p.fileIds?.length
        ? p
        : { ...p, fileIds: [...new Set(safe.map(row => row.fileId))] };
      const indexState = safe.length || p.archiveIds?.length || p.fileIds?.length
        ? this.indexState(statusScope, user)
        : { indexStatuses: [], notes: [] };
      return toolPage({
        items,
        ...indexState,
        retrievalMode: found.retrievalMode,
        degradedReason: found.degradedReason,
        tokens: found.tokens,
        truncated: found.truncated,
      }, safe.length, p);
    });
    this.add('content.read', '复用已有提取与索引取证，提供正文问答的片段和真实提取状态', {
      archiveIds: ids, fileIds: ids, extension: file.extension, query: { ...text, maxLength: 1000 }, summary: { type: 'boolean' }, terms: { type: 'array', items: { ...text, maxLength: 500 }, maxItems: 30 }, comparison: { type: 'boolean' },
    }, 'archiveView', (p, user) => this.readEvidence(p, user));
    // Keep existing /api/knowledge endpoints backward-compatible. These tools
    // are NOT offered to the new DeepSeek Agent planner or its execution path.
    const legacyKnowledge = {
      extension: file.extension,
      referenceFileIds: { ...ids, maxItems: 100 },
      keywordQuery: { ...text, maxLength: 1000 },
      query: { ...text, maxLength: 1000 },
      archiveIds: { ...ids, maxItems: 500 },
      fileIds: { ...ids, maxItems: 100 },
      mode: { ...text, enum: ['keyword', 'semantic', 'hybrid'] },
      pageSize: { ...id, maximum: 30 },
    };
    for (const name of ['search_document_content', 'search_knowledge']) {
      this.add(name, '兼容既有知识检索接口，不参与新版 Agent 工具规划',
        legacyKnowledge, 'archiveView', async (p, user) => {
          const data = await this.knowledge.search(p, user, name === 'search_knowledge');
          return { ...toolPage({ ...data, ...this.indexState(p, user) }, data.total, {}), pagination: null };
        }, ['query'], false);
    }
    this.add('get_document_evidence', '兼容既有附件证据接口，不参与新版 Agent 工具规划',
      { ...legacyKnowledge, attachmentId: id }, 'archiveView', async (p, user) => {
        const status = this.knowledge.attachmentStatus(p.attachmentId!, user);
        const data = await this.knowledge.search({ ...p, archiveIds: p.archiveIds ?? [status.archiveId], summary: !p.query }, user);
        return { ...toolPage({ ...data, indexStatus: status }, data.total, {}), pagination: null };
      }, ['attachmentId'], false);
    this.add('get_attachment_index_status', '兼容既有附件索引状态接口',
      { attachmentId: id }, 'archiveView',
      (p, user) => toolPage({ items: [this.knowledge.attachmentStatus(p.attachmentId!, user)] }, 1, {}),
      ['attachmentId'], false);

    // 第三阶段：图谱关联只读工具。复用第二阶段 GraphQueryService（三层权限闸门 + 证据白名单投影），
    // 不重复实现关系计算；结果只是检索线索，证据与事实仍由 content.search/content.read 取证。
    this.add('graph.relations', '按指定档案查询知识图谱中的真实关联档案、关系类型与计算依据；includeStructure=true 时也查询该档案的附件归属关系（第三阶段检索线索）：返回关联档案、关系依据证据与原始知识块定位，已按当前用户权限过滤；TF-IDF 依据只表示正文词项相似，不证明业务关系，必须继续用 content.search/content.read 获取真实证据', { archiveIds: ids, includeStructure: { type: 'boolean' } }, 'archiveView', (p, user) => {
      this.assertArchives(p.archiveIds, user);
      const requested = [...new Set(p.archiveIds ?? [])];
      if (!requested.length) throw new BadRequestException('图谱关联查询需要指定可访问的档案');
      const scoped = requested.slice(0, GRAPH_RELATION_ARCHIVE_LIMIT);
      const items: Array<Record<string, unknown>> = [];
      const notes: string[] = [];
      if (scoped.length < requested.length) notes.push(`图谱关联查询一次最多处理 ${GRAPH_RELATION_ARCHIVE_LIMIT} 份档案，其余档案未查询。`);
      for (const archiveId of scoped) {
        executionBudget()?.takeTool('graph.relations');
        const start = this.archives.getArchiveDetail(archiveId, user);
        let found; // 借阅过期/归还后立即按最新权限过滤（GraphQueryService 按 scope 实时查询）
        try {
          found = this.graph.relations(user, 'archive', archiveId, undefined, 1, GRAPH_RELATION_PAGE_SIZE);
        } catch {
          notes.push(`档案《${start.title}》还没有纳入知识图谱，或当前无权查看它的关联。`);
          continue;
        }
        for (const candidate of found.items) {
          let rel=candidate;
          try { const live=this.graph.edge(user,candidate.edge.id); rel={edge:live.edge,node:candidate.node,evidence:live.evidence}; } catch { continue; }
          const related = rel.node.archiveId ?? null;
          // 只保留指向其他档案的关系线索（同档案的结构包含边对跨档案检索无意义）
          if (related == null || related === archiveId && !p.includeStructure) continue;
          if (notes.length < GRAPH_RELATION_NOTE_LIMIT) {
            const basisLabel = GRAPH_BASIS_LABEL[rel.edge.basis] ?? '未能识别的计算依据';
            // 关系名称与计算依据同义时不再重复一遍（如「著录字段等值关联 / 判断依据是著录字段等值」）。
            const label = (rel.edge.label ?? '').trim() || basisLabel;
            const basisClause = label.includes(basisLabel) ? '' : `，判断依据是${basisLabel}`;
            notes.push(`档案《${start.title}》与《${rel.node.label}》：${label}${basisClause}${rel.edge.reason ? `（${rel.edge.reason}）` : ''}${GRAPH_BASIS_DISCLAIMER[rel.edge.basis] ? `；注意：${GRAPH_BASIS_DISCLAIMER[rel.edge.basis]}` : ''}`);
          }
          items.push({
            edgeId: rel.edge.id,
            archiveId: related,
            title: rel.node.label,
            archiveNo: rel.node.facts.archiveNo ?? '',
            sourceArchiveId: archiveId,
            sourceArchiveTitle: start.title,
            nodeType: rel.node.type,
            nodeRefId: rel.node.refId,
            edgeType: rel.edge.type,
            relationLabel: rel.edge.label,
            basis: rel.edge.basis,
            basisLabel: rel.edge.basis === 'metadata_exact_match' ? '著录信息相同' : rel.edge.basis === 'business_structure' ? '档案归属关系' : rel.edge.basis === 'tfidf_cosine' ? '正文内容相似' : rel.edge.basis === 'tfidf_cosine_aggregated' ? '多处正文内容相似' : '关联依据待核实',
            userExplanation: rel.edge.basis === 'metadata_exact_match' ? '两份档案存在相同的著录信息，可作为进一步核对的线索。' : rel.edge.basis === 'business_structure' ? '这条关系来自系统中的档案归属结构。' : rel.edge.basis === 'tfidf_cosine' ? '系统发现两份档案的部分正文片段存在用词相似。' : rel.edge.basis === 'tfidf_cosine_aggregated' ? '系统发现两份档案的多组正文片段存在相似内容。' : '系统记录了这条关联，但暂时无法确认具体依据。',
            caveat: rel.edge.basis === 'tfidf_cosine' || rel.edge.basis === 'tfidf_cosine_aggregated' ? '正文相似只能作为查找线索，不能单独证明两份档案存在真实业务关系。' : rel.edge.basis === 'metadata_exact_match' ? '著录信息相同仍需结合原文核对，不能仅凭字段相同认定业务关系。' : null,
            supportCount: rel.evidence.basis === 'tfidf_cosine_aggregated' ? rel.evidence.supportCount : undefined,
            factGrade: rel.edge.basis === 'metadata_exact_match' || rel.edge.basis === 'business_structure' ? 'deterministic_clue' : 'similarity_clue',
            evidence: rel.evidence,
            locators: graphEvidenceLocators(rel.evidence),
          });
        }
      }
      if (!items.length) notes.push('知识图谱中没有找到当前档案的其他关联档案；不能臆造关联。');
      return { ...toolPage({ items, notes }, items.length, {}), pagination: null };
    }, ['archiveIds']);

    this.add('category.list', '按分类名称、编码或 ID 查询现有分类及可见档案数量', { keyword: text, categoryId: id, ...paging }, 'categoryView', (p, user) => {
      const all = this.archives.listCategories(user).filter(c => (!p.categoryId || c.id === p.categoryId) &&
        (!p.keyword || [c.name, c.code, c.pathCode].some(v => v.toLowerCase().includes(p.keyword!.toLowerCase()))));
      const size = p.pageSize ?? 8, start = ((p.page ?? 1) - 1) * size;
      return toolPage({ items: all.slice(start, start + size) }, all.length, p);
    });
    this.add('borrow.search', '分页查询本人借阅或有审核权限的待处理申请及状态', {
      keyword: text, status: { ...text, enum: ['pending', 'approved', 'rejected', 'returned', 'expired', 'cancelled'] },
      scope: { ...text, enum: ['mine', 'review'] }, ...dates, ...paging,
    }, 'borrowRequest', (p, user) => {
      const page = this.borrowing.searchForAgent({ ...p, page: p.page ?? 1, pageSize: p.pageSize ?? 8 }, user);
      return toolPage(page, page.total, p);
    });
    this.add('borrow.detail', '获取本人或审核角色可见的借阅记录详情', { requestId: id }, 'borrowRequest', (p, user) =>
      toolPage({ items: [this.borrowing.detailForAgent(p.requestId!, user)] }, 1, {}), ['requestId']);
    this.add('audit.search', '仅按现有审计角色权限查询操作人、操作类型、时间范围及指定档案操作历史', {
      keyword: text, actorName: text, actions: { type: 'array', items: { ...text, enum: Object.values(AUDIT_ACTION) }, maxItems: 60 },
      archiveIds: ids, ...dates, timeRange, ...paging,
    }, 'auditView', (p, user) => {
      this.assertArchives(p.archiveIds, user);
      const found = this.business.search({ scopes: ['audit'], keyword: p.keyword, actorName: p.actorName, actions: p.actions,
        archiveIds: p.archiveIds, from: p.from, to: p.to, timeRange: p.timeRange as SearchTimeRange,
        page: p.page, limit: p.pageSize ?? 8 }, user).audits;
      return toolPage(found, found.total, p);
    });
    this.add('template.search', '查询真实模板、字段及关联档案分类', { keyword: text, categoryId: id, ...paging }, 'templateView', (p, user) => {
      const found = this.business.search({ scopes: ['template'], keyword: p.keyword, categoryId: p.categoryId,
        page: p.page, limit: p.pageSize ?? 8 }, user).templates;
      return toolPage(found, found.total, p);
    });
    this.add('statistics.get', '复用工作台统计，按账号可见范围返回数量、分类、状态、借阅和利用统计', { timeRange, archiveIds: ids }, 'archiveView', (p, user) => {
      const authorizationArchiveIds: number[] = [];
      for (let page=1;;page++) {
        executionBudget()?.takeTool('statistics.authorized-scope');
        const found=this.archives.searchArchives({archiveIds:p.archiveIds,page:String(page),pageSize:'100'},user);
        authorizationArchiveIds.push(...found.items.map(a=>a.id));
        if(page*100>=found.total)break;
        if(!found.items.length)throw new BadRequestException('统计授权范围分页未取得进展');
      }
      if (p.archiveIds) {
        this.assertArchives(p.archiveIds, user);
        const count = (status?: string) => this.archives.searchArchives({ archiveIds: p.archiveIds, status, page: '1', pageSize: '1' }, user).total;
        return { ...toolPage({ authorizationArchiveIds,rangeLabel:'指定档案范围',archiveScopeLabel:'当前授权的指定档案',borrowScopeLabel:'未查询',note:'仅统计指定档案，未查询借阅和利用数据',metrics:[{key:'archives',label:'档案总数',unit:'份',total:count(),period:null,available:true,hint:''}],statuses:[{key:'draft',label:'草稿',count:count('draft')},{key:'archived',label:'已归档',count:count('archived')}],categories:[],borrow:{available:false,reason:'未查询',total:0,pending:0,periodTotal:0,scopeLabel:'未查询'},utilization:{available:false,reason:'未查询',previewTotal:0,downloadTotal:0} }, 1, {}), pagination: null };
      }
      const stats = this.business.search({ scopes: ['stats'], timeRange: p.timeRange as SearchTimeRange, limit: 1 }, user).statistics;
      return { ...toolPage(stats ? {...stats, authorizationArchiveIds} : null, stats ? 1 : 0, {}), pagination: null };
    });
  }

  /** Describe only; callers cannot register arbitrary methods or get executable closures. */
  list(): Array<Omit<AgentToolDefinition, 'execute'>> {
    return [...this.definitions.values()]
      .filter(definition => definition.plannerVisible !== false)
      .map(({ execute, ...description }) => structuredClone(description));
  }

  /** The planner sees only tools that are safe and intentionally supported by the final lexical Agent route. */
  listForPlanner(): Array<Omit<AgentToolDefinition, 'execute' | 'plannerVisible'>> {
    return [...this.definitions.values()]
      .filter(definition => definition.plannerVisible !== false)
      .map(({ execute, plannerVisible, ...description }) => structuredClone(description));
  }

  async execute(name: string, raw: unknown, operator: UserView): Promise<AgentToolResult> {
    const started=performance.now();
    try {
      assertToolUser(operator);
      executionBudget()?.takeTool(name);
      const tool = this.definitions.get(name);
      if (!tool) return { ...toolFailure(name, new BadRequestException('工具未注册或未授权')), error: { code: 'UNREGISTERED_TOOL', message: '工具未注册或未授权' } };
      const params = validate(raw, tool.parameters);
      const result = await tool.execute(params, operator) as AgentToolResult;
      return { ...result, toolName: name, durationMs:Math.max(0,Math.round(performance.now()-started)) };
    } catch (error) {
      return {...toolFailure(name, error),durationMs:Math.max(0,Math.round(performance.now()-started))};
    }
  }

  private add(name: string, description: string, properties: Record<string, ToolProperty>, permission: PermKey,
    run: (p: ToolParams, user: UserView) => AgentToolResult | Promise<AgentToolResult>, required: string[] = [],
    plannerVisible = true): void {
    if (this.definitions.has(name)) throw new Error(`Duplicate tool ${name}`);
    this.definitions.set(name, { name, description, readOnly: true, plannerVisible,
      parameters: { type: 'object', additionalProperties: false, properties, required },
      execute: (p, user) => {
        assertToolUser(user);
        if (!hasPermission(user.role, permission)) throw new ForbiddenException(permission === 'borrowRequest' ? '当前角色没有借阅业务权限' : `当前角色无权调用 ${name}`);
        return run(p, user);
      } });
  }

  private assertArchives(archiveIds: number[] | undefined, user: UserView): void {
    for (const archiveId of archiveIds ?? []) this.access.assertView(user, this.access.loadArchive(archiveId));
  }

  private indexState(p: ToolParams, user: UserView) {
    let archiveIds = p.archiveIds;
    if (p.title || p.archiveNo || p.categoryId || p.status) {
      const located: number[] = [];
      for (let page = 1; ; page++) {
        const found = this.archives.searchArchives({ title: p.title, archiveNo: p.archiveNo,
          categoryId: p.categoryId === undefined ? undefined : String(p.categoryId), includeSub: '1', status: p.status,
          page: String(page), pageSize: '100' }, user);
        located.push(...found.items.map(row => row.id));
        if (page * 100 >= found.total || !found.items.length) break;
      }
      archiveIds = archiveIds ? archiveIds.filter(id => located.includes(id)) : located;
    }
    const indexStatuses = this.contentIndex.describeVisible({ userId: user.id, admin: user.role === ROLE_ADMIN }, archiveIds, p.fileIds, p.extension);
    const labels: Record<string, string> = { pending: '未索引（等待处理）', processing: '索引中', failed: '索引失败',
      corrupt: '索引失败（文件损坏）', encrypted: '索引失败（文件加密）', no_text: '未提取到正文', unsupported: '不支持正文提取', scanned: '扫描件暂无可检索正文' };
    const incomplete = indexStatuses.filter(file => file.status !== 'indexed');
    const notes = incomplete.slice(0, 6).map(file => `档案《${file.archiveTitle}》附件《${file.fileName}》：${labels[file.status] ?? file.status}${file.message ? `，${file.message}` : ''}`);
    if (incomplete.length) notes.unshift('下面这些附件尚无完整正文（正文还没有处理完），暂时无法判断其中是否包含相关内容。');
    if (incomplete.length > 6) notes.push(`另有 ${incomplete.length - 6} 个附件尚无完整正文，可以在档案详情里查看状态`);
    for (const file of indexStatuses.filter(file => file.truncated)) notes.push(`附件「${file.fileName}」的正文只提取了一部分，不能当作全文总结。`);
    return { indexStatuses, notes };
  }

  private async readEvidence(p: ToolParams, user: UserView): Promise<AgentToolResult> {
    this.assertArchives(p.archiveIds, user);
    if (p.fileIds) {
      if (!p.archiveIds?.length) throw new BadRequestException('附件正文取证必须限定所属档案');
      const files = p.archiveIds.flatMap(id => this.archives.getArchiveDetail(id, user).files);
      if (p.fileIds.some(id => !files.some(f => f.id === id))) throw new BadRequestException('附件已不存在或不属于当前取证档案');
    }
    if (p.archiveIds && !p.archiveIds.length) return toolPage({ items: [], notes: [] }, 0, {});
    if (p.extension) {
      if (!p.archiveIds?.length) throw new BadRequestException('按格式读取正文必须先定位档案');
      const eligible = p.archiveIds.flatMap(id => this.archives.getArchiveDetail(id,user).files).filter(f=>f.extension.toLowerCase()===p.extension!.toLowerCase()).map(f=>f.id);
      p = { ...p, fileIds: p.fileIds ? p.fileIds.filter(id=>eligible.includes(id)) : eligible };
    }
    const archiveIds = p.archiveIds ?? [];
    // Read established indexes only; missing/extraction-failed statuses are reported below.
    const scope: ViewerScope = { userId: user.id, admin: user.role === ROLE_ADMIN };
    const lexical = p.summary && archiveIds.length ? { items: [] as EvidenceRow[], retrievalMode: 'ordered', degradedReason: undefined }
      : this.keywords.search({query:p.query ?? (p.terms??[]).join(' '),scope,archiveIds:p.archiveIds,fileIds:p.fileIds});
    const items: EvidenceRow[] = [...lexical.items];
    let retrieval: Record<string, unknown> = {retrievalMode:'keyword',keywordMode:lexical.retrievalMode,degradedReason:lexical.degradedReason};
    // Agent full-text reads are lexical and deterministic. Embedding/vector search is not part of this route.
    const summaryArchiveIds = archiveIds.length ? archiveIds : [...new Set(items.map(row => row.archiveId))];
    const summaryFileIds = p.fileIds ?? (archiveIds.length ? undefined : [...new Set(items.map(row => row.fileId))]);
    if (p.summary && summaryArchiveIds.length) {
      // Read every current chunk in document order. Keyword hits must not replace a whole-document read.
      items.length = 0;
      for (let offset = 0; ; offset += 500) {
        if (offset) executionBudget()?.takeTool('content.read:page');
        const page = this.contentUnits.listChunksOfArchives(summaryArchiveIds, scope, 500, summaryFileIds, offset);
        items.push(...page);
        if (page.length < 500) break;
      }
    }
    // Re-check lexical evidence against current grants, file ownership and active versions.
    const currentUser = user;
    const safe = items.filter(row => {
      try {
        if (!this.access.canView(currentUser, this.access.loadArchive(row.archiveId))) return false;
        return this.archives.getArchiveDetail(row.archiveId, currentUser).files.some(f => f.id === row.fileId) &&
          this.contentIndex.isCurrentEvidence(row.fileId, row.unitId);
      } catch { return false; }
    });
    const indexScope = {
      ...p,
      archiveIds: p.archiveIds?.length ? p.archiveIds : (summaryArchiveIds.length ? summaryArchiveIds : undefined),
      fileIds: p.fileIds?.length ? p.fileIds : (summaryFileIds?.length ? summaryFileIds : undefined),
    };
    const indexState = indexScope.archiveIds?.length || indexScope.fileIds?.length
      ? this.indexState(indexScope, currentUser)
      : { indexStatuses: [], notes: [] };
    if(p.summary)for(const file of indexState.indexStatuses.filter(f=>f.status==='indexed')){
      const actual=new Set(safe.filter(row=>row.fileId===file.fileId).map(row=>row.chunkId)).size;
      if(actual!==file.chunkCount)indexState.notes.push('附件「'+file.fileName+'」的正文没有读取完整（应读 '+file.chunkCount+' 段，实际读到 '+actual+' 段），暂时无法做完整总结。');
    }
    return { ...toolPage({ items: safe, ...indexState, ...retrieval }, safe.length, {}), pagination: null };
  }
}
