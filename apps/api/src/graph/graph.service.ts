/**
 * 知识图谱构建服务（第一阶段：基础建设）。
 *
 * 五条构建路径（对应交付要求第五节）：
 * 1. buildAll()              —— 全量重建：先在内存算完整结果，再在单个事务里「清空 + 重写」做原子替换，
 *                               任何异常整体回滚，已有可用图谱不会变成半成品；
 * 2. rebuildArchive(id)      —— 单份档案重建：只替换该档案子树的节点与其相连的关系；
 * 3. markDirty()/flushPending() —— 附件正文更新后的关联刷新（由正文索引钩子触发，去抖合并）；
 * 4. removeArchive(id)       —— 档案删除后的显式清理（数据库触发器已兜底，重复执行不报错）；
 * 5. stats()                 —— 当前图谱规模。
 *
 * 幂等性：节点按 biz_key UPSERT、关系按 (edge_type, from_node, to_node) UPSERT；内容关系端点
 * 一律按 id 升序规范化，因此重复执行既不翻倍，也不会出现自环或 (a,b)/(b,a) 双向重复。
 *
 * 与现有索引流水线的关系：本服务不解析任何附件字节，只读取 archive_content_units /
 * archive_content_chunks 里「当前有效正文」的既有产物（与全文检索同一 SQL 口径），
 * 未索引的附件通过 ContentIndexService.ensureJob 登记给既有流水线补齐。
 */
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SqliteTransaction } from '../db/transaction';
import { DATABASE } from '../db/database';
import { ContentIndexService } from '../archives/content/content-index.service';
import { GraphRepository, KgArchiveSource, KgFieldValue, KgFileSource, KgGraphCounts } from './graph.repositories';
import {
  aggregateArchiveRelations,
  findSimilarPairs,
  tokenizeCounts,
  SimilarityDoc,
  SimilarityPair,
} from './graph.similarity';
import {
  emptyKgStats,
  KG_EDGE_BASIS,
  KgBuildOptions,
  KgBuildStats,
  KgChunkSource,
  KgEdgeDraft,
  KgEdgeType,
  KgNodeDraft,
  kgNodeKey,
  resolveKgOptions,
} from './graph.types';
import { GraphMaintenanceDelegate, GraphMaintenanceHooks } from './graph.hooks';

/** 词频缓存上限（超过即整体清空，避免长时间运行后无界增长）。 */
const COUNT_CACHE_LIMIT = 50000;
/** 附件已尝试提取但没有可入图正文的状态，计入构建失败数。 */
const FAILED_STATUSES = new Set(['no_text', 'unsupported', 'corrupt', 'encrypted', 'scanned', 'failed']);
/** 尚未进入正文索引流水线的状态（不算失败，只记警告）。 */
const PENDING_STATUSES = new Set(['', 'pending', 'processing']);
/** 可作为「确定性指称」的著录字段类型：类别型（select/bool）、日期与标签值都属于宽泛分类，不用于等值关联。 */
const DETERMINISTIC_FIELD_TYPES = new Set(['text', 'number', 'textarea']);

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

const round4 = (value: number): number => Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000;

/** 节点展示名：压平空白并截断（正文全文仍在 archive_content_chunks，图谱不复制业务事实）。 */
function displayName(text: string, max = 80): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 关系证据中的知识块定位信息（可回溯到档案 / 附件 / 页码或行号）。 */
function chunkEvidence(chunk: KgChunkSource): Record<string, unknown> {
  return {
    chunkId: chunk.chunkId,
    fileId: chunk.fileId,
    archiveId: chunk.archiveId,
    chunkNo: chunk.chunkNo,
    locator: chunk.locator,
    pageNo: chunk.pageNo,
    posFrom: chunk.posFrom,
    posTo: chunk.posTo,
    storedName: chunk.storedName,
    preview: chunk.text.slice(0, 80),
  };
}

export interface KgBuildRequest {
  /** 覆盖默认阈值参数（相似度下限、Top-K 等）。 */
  options?: Partial<KgBuildOptions>;
  /** 构建前先同步驱动既有正文索引（补齐尚未索引的附件正文，耗时随附件体量增长）。 */
  syncContent?: boolean;
}

@Injectable()
export class GraphBuildService implements GraphMaintenanceDelegate, OnModuleInit, OnModuleDestroy {
  /** 词频缓存：chunkId → 文本指纹 + 词频（正文未变则不重复分词）。 */
  private readonly countsCache = new Map<number, { fingerprint: string; counts: Map<string, number> }>();
  /** 去抖队列：正文索引完成后合并刷新，避免一次上传触发多次全语料计算。 */
  private readonly dirty = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  /** 构建进行中标记：此时收到的刷新请求入 dirty 但不启动定时器（全量完成后统一清空）。 */
  private building = false;
  /** 全量构建进行中：此时 refreshArchive 只入 dirty 不起定时器。 */
  private fullBuildInProgress = false;
  /** 构建版本号：每次全量构建完成后递增，用于丢弃过期的增量任务。 */
  private buildVersion = 0;
  /** 增量任务入队时的版本号，执行前比对：若版本已更新则跳过。 */
  private dirtyVersion = 0;

  constructor(
    @Inject(GraphRepository) private readonly repo: GraphRepository,
    @Inject(SqliteTransaction) private readonly tx: SqliteTransaction,
    @Inject(ContentIndexService) private readonly content: ContentIndexService,
    @Inject(GraphMaintenanceHooks) private readonly hooks: GraphMaintenanceHooks,
    @Inject(DATABASE) private readonly db: DatabaseSync,
  ) {}

  onModuleInit(): void {
    this.hooks.register(this);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty.clear();
  }

  // ==================== 对外构建入口 ====================

  /** 全量重建（原子替换，输出节点数 / 关系数 / 处理量 / 失败数 / 耗时）。 */
  buildAll(request: KgBuildRequest = {}): KgBuildStats {
    return this.build(undefined, request);
  }

  /** 单份档案重新构建。 */
  rebuildArchive(archiveId: number, request: KgBuildRequest = {}): KgBuildStats {
    return this.build([archiveId], request);
  }

  /** 正文索引变化后刷新所属档案（钩子实现：入去抖队列，不阻塞业务请求）。 */
  refreshArchive(archiveId: number): void {
    if (this.building) {
      // 全量构建进行中：只入 dirty，不启动定时器（全量完成后统一清空）
      this.dirty.add(archiveId);
      return;
    }
    this.dirty.add(archiveId);
    this.dirtyVersion = this.buildVersion;
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flushPending(); }, 1000);
    this.timer.unref?.();
  }

  /** 附件更新后的关联刷新：解析所属档案后并入队。 */
  refreshFile(fileId: number): void {
    const file = this.repo.findFile(fileId);
    if (file) this.refreshArchive(file.archiveId);
  }

  /** 立即处理去抖队列（测试与 CLI 用；正常业务无需调用）。 */
  flushPending(): number {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = [...this.dirty];
    this.dirty.clear();
    // 若全量构建已更新版本，过期的增量任务直接丢弃（全量已包含最新状态）
    if (this.dirtyVersion < this.buildVersion) {
      return 0;
    }
    for (const archiveId of pending) {
      try {
        this.rebuildArchive(archiveId);
      } catch (err) {
        console.warn(`[graph] 档案 ${archiveId} 增量刷新失败，可重新全量构建：${(err as Error)?.message ?? err}`);
      }
    }
    return pending.length;
  }

  /** 档案删除后的显式清理（数据库触发器已兜底；重复执行为 0）。 */
  removeArchive(archiveId: number): number {
    const keys = this.repo.listNodeKeys(archiveId).map((node) => node.bizKey);
    if (!keys.length) return 0;
    // 关系随节点外键级联删除，不存在悬挂边
    return this.tx.run(() => this.repo.deleteNodesByKeys(keys));
  }

  /** 当前图谱规模。 */
  stats(): KgGraphCounts {
    return this.repo.counts();
  }

  /** 某档案的子图节点（排障与第二阶段接口复用）。 */
  nodesOfArchive(archiveId: number) {
    return this.repo.listNodesByArchive(archiveId);
  }

  /** 某类型关系样本（按权重降序），用于关联质量抽样。 */
  edgesOfType(edgeType: KgEdgeType, limit = 200) {
    return this.repo.listEdgesByType(edgeType, limit);
  }

  // ==================== 构建主流程 ====================

  private build(archiveIds: number[] | undefined, request: KgBuildRequest): KgBuildStats {
    if (this.building) throw new Error('图谱构建正在进行中，请稍后重试（避免同一连接内交叉写入产生半成品）');
    this.building = true;
    const fullBuild = !archiveIds;
    if (fullBuild) this.fullBuildInProgress = true;
    const buildType = fullBuild ? 'full' : 'incremental';
    const logId = this.logBuildStart(buildType);
    try {
      const stats = this.buildGraph(archiveIds, request);
      if (fullBuild) {
        // 全量构建完成后清空 dirty 队列：全量已包含所有档案最新状态，之前积累的增量任务过期
        this.dirty.clear();
        if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
        this.buildVersion += 1;
      }
      this.logBuildEnd(logId, 'success', stats);
      return stats;
    } catch (err) {
      this.logBuildEnd(logId, 'failed', null, (err as Error)?.message ?? String(err));
      throw err;
    } finally {
      this.building = false;
      this.fullBuildInProgress = false;
    }
  }

  private buildGraph(archiveIds: number[] | undefined, request: KgBuildRequest): KgBuildStats {
    const options = resolveKgOptions(request.options);
    const fullBuild = !archiveIds;
    const startedAt = Date.now();
    const stats = emptyKgStats();

    const archives: KgArchiveSource[] = fullBuild ? this.repo.listArchives() : this.repo.listArchives(archiveIds);
    stats.archives = archives.length;
    if (!archives.length) {
      stats.durationMs = Date.now() - startedAt;
      stats.warnings.push(fullBuild ? '库中暂无档案，图谱为空' : '指定档案不存在或已被清理');
      return stats;
    }
    const scopedArchiveIds = archives.map((a) => a.id);
    const scopedIds = new Set(scopedArchiveIds);

    // 1) 正文补齐：只驱动既有流水线（登记任务或同步索引），不重复实现解析
    this.ensureContent(archives, request.syncContent === true, stats);

    // 2) 只读投影：分类 / 附件 / 索引状态 / 当前有效正文知识块（全库一次，供相似度与过期清理共用）
    const categories = this.repo.listCategoryNames();
    const files = this.repo.listFiles(scopedArchiveIds);
    const unitStatuses = this.repo.listUnitStatuses(scopedArchiveIds);
    const allChunks = this.repo.listChunkSources();
    stats.files = files.length;

    const fileById = new Map<number, KgFileSource>(files.map((file) => [file.id, file]));
    const archiveById = new Map<number, KgArchiveSource>(archives.map((a) => [a.id, a]));
    const chunksOfArchive = new Map<number, KgChunkSource[]>();
    for (const chunk of allChunks) {
      if (!scopedIds.has(chunk.archiveId)) continue;
      const list = chunksOfArchive.get(chunk.archiveId);
      if (list) list.push(chunk);
      else chunksOfArchive.set(chunk.archiveId, [chunk]);
    }

    // 3) 节点：分类 / 档案 / 附件（含提取失败者）/ 知识块
    const nodeDrafts: KgNodeDraft[] = [];
    for (const [categoryId, category] of categories) {
      if (!fullBuild && !archives.some((a) => a.categoryId === categoryId)) continue;
      nodeDrafts.push({
        nodeType: 'category',
        bizKey: kgNodeKey.category(categoryId),
        refId: categoryId,
        archiveId: null,
        fileId: null,
        name: category.name,
        source: 'archive_categories',
        contentHash: hash(`${category.name}|${category.code}|${category.parentId ?? ''}`),
        meta: {
          code: category.code,
          parentId: category.parentId,
          description: category.description,
          archiveCount: archives.filter((a) => a.categoryId === categoryId).length,
        },
      });
    }

    for (const file of files) {
      const unit = unitStatuses.get(file.id);
      const archive = archiveById.get(file.archiveId);
      const status = unit?.status ?? 'pending';
      if (FAILED_STATUSES.has(status)) stats.failed += 1;
      else if (PENDING_STATUSES.has(status)) {
        stats.warnings.push(`附件 ${file.id}（${file.originalName}）正文尚未入索引：${unit?.message || '已登记给正文索引流水线，稍后自动补齐'}`);
      }
      // 提取失败/不支持的附件仍保留节点，并把状态与原因写进 meta（图谱覆盖度可见）
      nodeDrafts.push({
        nodeType: 'file',
        bizKey: kgNodeKey.file(file.id),
        refId: file.id,
        archiveId: file.archiveId,
        fileId: file.id,
        name: file.originalName,
        source: 'archive_files',
        contentHash: hash(`${file.originalName}|${file.storedName}|${file.sha256}|${status}|${unit?.chunkCount ?? 0}`),
        meta: {
          archiveId: file.archiveId,
          archiveNo: archive?.archiveNo ?? '',
          archiveTitle: archive?.title ?? '',
          extension: file.extension,
          fileSize: file.fileSize,
          storedName: file.storedName,
          sha256: file.sha256,
          uploadedAt: file.uploadedAt,
          versionNo: unit?.versionNo ?? null,
          extractStatus: status,
          extractMessage: unit?.message ?? '',
          extractor: unit?.extractor ?? '',
          charCount: unit?.charCount ?? 0,
          chunkCount: unit?.chunkCount ?? 0,
          truncated: unit?.truncated ?? false,
        },
      });
    }

    for (const archive of archives) {
      const archiveChunks = chunksOfArchive.get(archive.id) ?? [];
      for (const chunk of archiveChunks) {
        nodeDrafts.push({
          nodeType: 'chunk',
          bizKey: kgNodeKey.chunk(chunk.storedName, chunk.chunkNo),
          refId: chunk.chunkId,
          archiveId: chunk.archiveId,
          fileId: chunk.fileId,
          name: displayName(chunk.text),
          source: 'archive_content_chunks',
          contentHash: hash(chunk.text),
          meta: {
            chunkNo: chunk.chunkNo,
            unitId: chunk.unitId,
            locator: chunk.locator,
            pageNo: chunk.pageNo,
            posFrom: chunk.posFrom,
            posTo: chunk.posTo,
            extractor: chunk.extractor,
            extension: chunk.extension,
            storedName: chunk.storedName,
            fileName: fileById.get(chunk.fileId)?.originalName ?? '',
            archiveNo: archive.archiveNo,
            archiveTitle: archive.title,
            textLength: chunk.text.length,
            versionNo: chunk.versionNo,
            preview: chunk.text.slice(0, 200),
          },
        });
      }
      const archiveFiles = files.filter((f) => f.archiveId === archive.id);
      nodeDrafts.push({
        nodeType: 'archive',
        bizKey: kgNodeKey.archive(archive.id),
        refId: archive.id,
        archiveId: archive.id,
        fileId: null,
        name: archive.title,
        source: 'archives',
        contentHash: hash(`${archive.title}|${archive.archiveNo}|${archive.categoryId}|${archive.status}|${archive.accessLevel}|${archive.keywords}|${archive.responsible}|${archive.formationDate ?? ''}|${archive.archiveType}`),
        meta: {
          archiveNo: archive.archiveNo,
          categoryId: archive.categoryId,
          categoryName: categories.get(archive.categoryId)?.name ?? '',
          archiveType: archive.archiveType,
          status: archive.status,
          accessLevel: archive.accessLevel,
          responsible: archive.responsible,
          formationDate: archive.formationDate,
          keywords: archive.keywords,
          fileCount: archiveFiles.length,
          indexedFileCount: archiveFiles.filter((f) => unitStatuses.get(f.id)?.status === 'indexed').length,
          failedFileCount: archiveFiles.filter((f) => FAILED_STATUSES.has(unitStatuses.get(f.id)?.status ?? 'pending')).length,
          chunkCount: archiveChunks.length,
        },
      });
    }

    // 4) 结构关系（来自真实业务归属，权重恒为 1）
    const edgeDrafts: KgEdgeDraft[] = [];
    for (const archive of archives) {
      edgeDrafts.push({
        edgeType: 'category_contains_archive',
        fromKey: kgNodeKey.category(archive.categoryId),
        toKey: kgNodeKey.archive(archive.id),
        weight: 1,
        basis: KG_EDGE_BASIS.STRUCTURE,
        fromArchiveId: null,
        toArchiveId: archive.id,
        evidence: { origin: 'archives.category_id', archiveId: archive.id, categoryId: archive.categoryId },
      });
      for (const file of files.filter((f) => f.archiveId === archive.id)) {
        edgeDrafts.push({
          edgeType: 'archive_contains_file',
          fromKey: kgNodeKey.archive(archive.id),
          toKey: kgNodeKey.file(file.id),
          weight: 1,
          basis: KG_EDGE_BASIS.STRUCTURE,
          fromArchiveId: archive.id,
          toArchiveId: archive.id,
          evidence: { origin: 'archive_files.archive_id', archiveId: archive.id, fileId: file.id },
        });
      }
      for (const chunk of chunksOfArchive.get(archive.id) ?? []) {
        edgeDrafts.push({
          edgeType: 'file_contains_chunk',
          fromKey: kgNodeKey.file(chunk.fileId),
          toKey: kgNodeKey.chunk(chunk.storedName, chunk.chunkNo),
          weight: 1,
          basis: KG_EDGE_BASIS.STRUCTURE,
          fromArchiveId: chunk.archiveId,
          toArchiveId: chunk.archiveId,
          evidence: {
            origin: 'archive_content_chunks.file_id',
            fileId: chunk.fileId,
            chunkId: chunk.chunkId,
            archiveId: chunk.archiveId,
            locator: chunk.locator,
            pageNo: chunk.pageNo,
          },
        });
      }
    }

    // 5) 内容关系：TF-IDF + 倒排累加余弦 + Top-K
    const corpus = this.selectCorpus(allChunks, scopedIds, fullBuild, options, stats);
    const docIndex = new Map<number, KgChunkSource>(corpus.map((chunk) => [chunk.chunkId, chunk]));
    const docs: SimilarityDoc[] = corpus.map((chunk) => ({
      id: chunk.chunkId,
      archiveId: chunk.archiveId,
      fileId: chunk.fileId,
      counts: this.countsOf(chunk),
    }));
    const similarity = findSimilarPairs(docs, {
      minChunkSimilarity: options.minChunkSimilarity,
      chunkTopK: options.chunkTopK,
      maxTermDocFrequencyRatio: options.maxTermDocFrequencyRatio,
      maxPostingDocsPerTerm: options.maxPostingDocsPerTerm,
      maxSharedTermsPerPair: options.maxEvidencePairsPerEdge,
    });
    if (similarity.skippedTerms) {
      stats.warnings.push(`跳过 ${similarity.skippedTerms} 个高频词项（文档频率超过 ${Math.round(options.maxTermDocFrequencyRatio * 100)}% 语料），不参与内容关联`);
    }

    // 增量重建只落「与本次范围相关」的关系；其他档案之间的关系由其自身子树保持不变
    const touchesScope = (pair: SimilarityPair) =>
      scopedIds.has(docIndex.get(pair.leftId)?.archiveId ?? -1) || scopedIds.has(docIndex.get(pair.rightId)?.archiveId ?? -1);
    const persistedPairs = fullBuild ? similarity.pairs : similarity.pairs.filter(touchesScope);

    for (const pair of persistedPairs) {
      const left = docIndex.get(pair.leftId);
      const right = docIndex.get(pair.rightId);
      if (!left || !right) continue;
      edgeDrafts.push({
        edgeType: 'chunk_similar_to',
        fromKey: kgNodeKey.chunk(left.storedName, left.chunkNo),
        toKey: kgNodeKey.chunk(right.storedName, right.chunkNo),
        weight: round4(pair.score),
        basis: KG_EDGE_BASIS.TFIDF_COSINE,
        fromArchiveId: left.archiveId,
        toArchiveId: right.archiveId,
        evidence: {
          method: 'tfidf_cosine',
          tokenizer: 'cjk-bigram',
          similarity: round4(pair.score),
          sharedTermCount: pair.sharedTermCount,
          sharedTerms: pair.sharedTerms,
          from: chunkEvidence(left),
          to: chunkEvidence(right),
        },
      });
    }

    const relations = aggregateArchiveRelations(persistedPairs, docIndex, {
      minArchiveWeight: options.minArchiveWeight,
      archiveTopK: options.archiveTopK,
      evidenceLimit: options.maxEvidencePairsPerEdge,
    });
    for (const relation of relations) {
      if (!fullBuild && !(scopedIds.has(relation.leftArchiveId) || scopedIds.has(relation.rightArchiveId))) continue;
      edgeDrafts.push({
        edgeType: 'archive_related_to',
        fromKey: kgNodeKey.archive(relation.leftArchiveId),
        toKey: kgNodeKey.archive(relation.rightArchiveId),
        weight: round4(relation.weight),
        basis: KG_EDGE_BASIS.TFIDF_COSINE_AGGREGATED,
        fromArchiveId: relation.leftArchiveId,
        toArchiveId: relation.rightArchiveId,
        evidence: {
          method: 'tfidf_cosine_aggregated',
          formula: 'weight = 1 - Π(1 - 最强的至多3条知识块相似度)',
          maxChunkSimilarity: round4(relation.maxScore),
          supportCount: relation.supportCount,
          supportingChunks: relation.supportingPairs.map((pair) => ({
            fromChunkId: pair.leftId,
            toChunkId: pair.rightId,
            fromFileId: docIndex.get(pair.leftId)?.fileId ?? null,
            toFileId: docIndex.get(pair.rightId)?.fileId ?? null,
            fromArchiveId: relation.leftArchiveId,
            toArchiveId: relation.rightArchiveId,
            similarity: round4(pair.score),
            sharedTerms: pair.sharedTerms,
          })),
        },
      });
    }

    // 6) 确定性关联：真实著录字段等值（不猜字段、不用宽泛关键词）
    edgeDrafts.push(...this.deterministicEdges(scopedIds, fullBuild, options));

    // 7) 原子写入：全量走「清空 + 重写」，增量走「子树替换 + 过期清理」
    stats.chunks = nodeDrafts.reduce((sum, node) => sum + (node.nodeType === 'chunk' ? 1 : 0), 0);
    const draftKeys = new Set(nodeDrafts.map((n) => n.bizKey));
    const currentChunkKeys = new Set(allChunks.map((chunk) => kgNodeKey.chunk(chunk.storedName, chunk.chunkNo)));

    this.tx.run(() => {
      if (fullBuild) this.repo.deleteAllNodes(); // 关系由外键级联一并清空，不留半成品
      const written = this.repo.upsertNodes(nodeDrafts);

      if (!fullBuild) {
        // 本次范围内已消失的节点（附件删除、正文清空、知识块减少）
        const staleKeys: string[] = [];
        for (const archiveId of scopedIds) {
          for (const node of this.repo.listNodeKeys(archiveId)) if (!draftKeys.has(node.bizKey)) staleKeys.push(node.bizKey);
        }
        // 其他档案里已失效的知识块节点（正文重建后 stored_name / chunk_no 已变化）
        for (const node of this.repo.listAllNodeKeys()) {
          if (node.nodeType !== 'chunk' || draftKeys.has(node.bizKey) || currentChunkKeys.has(node.bizKey)) continue;
          staleKeys.push(node.bizKey);
        }
        if (staleKeys.length) this.repo.deleteNodesByKeys(staleKeys);
        // 增量重建：只删除两端都属于本次范围的边（保留跨档案关联，避免误删全量构建的产物）
        this.repo.deleteEdgesWithinArchives(scopedArchiveIds);
      }

      const nodeIdByKey = new Map(written);
      const edgeKeys = new Set<string>();
      for (const edge of edgeDrafts) {
        edgeKeys.add(edge.fromKey);
        edgeKeys.add(edge.toKey);
      }
      const missing = [...edgeKeys].filter((key) => !nodeIdByKey.has(key));
      for (const [key, id] of this.repo.nodeIdsByKeys(missing)) nodeIdByKey.set(key, id);
      // 端点节点不存在的边由仓储层跳过：宁可不建也不留指向未知对象的关系
      this.repo.upsertEdges(edgeDrafts, nodeIdByKey);
    });

    const totals = this.repo.counts();
    stats.nodes = totals.nodes;
    stats.edges = totals.edges;
    stats.edgesByType = totals.edgesByType;
    stats.durationMs = Date.now() - startedAt;
    return stats;
  }

  // ==================== 内部工具 ====================

  /** 补齐正文：默认只登记任务（交给既有流水线），syncContent 时同步索引当前档案。 */
  private ensureContent(archives: KgArchiveSource[], syncContent: boolean, stats: KgBuildStats): void {
    for (const archive of archives) {
      try {
        if (syncContent) this.content.syncArchive(archive.id, true);
        else this.content.syncArchiveSafely(archive.id, '图谱构建前登记');
      } catch (err) {
        stats.warnings.push(`档案 ${archive.id} 正文索引登记失败：${(err as Error)?.message ?? err}`);
      }
    }
  }

  /** 相似度语料选择：范围内知识块必进，其余按上限补足（超出记 skipped，节点仍照常建立）。 */
  private selectCorpus(
    allChunks: KgChunkSource[],
    scopedIds: Set<number>,
    fullBuild: boolean,
    options: KgBuildOptions,
    stats: KgBuildStats,
  ): KgChunkSource[] {
    const eligible = allChunks.filter((chunk) => chunk.text.length >= options.minChunkCharsForSimilarity);
    const inScope = fullBuild ? eligible : eligible.filter((chunk) => scopedIds.has(chunk.archiveId));
    const outside = fullBuild ? [] : eligible.filter((chunk) => !scopedIds.has(chunk.archiveId));
    const remaining = Math.max(0, options.maxChunksPerBuild - inScope.length);
    if (outside.length > remaining) {
      stats.skipped = outside.length - remaining;
      stats.truncated = true;
      stats.warnings.push(`语料超过上限 ${options.maxChunksPerBuild}：${stats.skipped} 个范围外知识块本轮不参与内容关联`);
    }
    return [...inScope, ...outside.slice(0, remaining)];
  }

  /** 词频（带缓存）：文本指纹一致即复用，增量刷新不重复分词。 */
  private countsOf(chunk: KgChunkSource): Map<string, number> {
    const fingerprint = hash(chunk.text);
    const cached = this.countsCache.get(chunk.chunkId);
    if (cached && cached.fingerprint === fingerprint) return cached.counts;
    if (this.countsCache.size >= COUNT_CACHE_LIMIT) this.countsCache.clear();
    const counts = tokenizeCounts(chunk.text);
    this.countsCache.set(chunk.chunkId, { fingerprint, counts });
    return counts;
  }

  /**
   * 确定性关联：同一著录字段值完全相等的档案对。
   * 约束（防噪声）：字段类型限 text/number/textarea；值长度 ≥ 下限；
   * 同值档案数在 2..上限之间（共享面过宽说明该值是分类而非唯一指称）。
   */
  private deterministicEdges(scopedIds: Set<number>, fullBuild: boolean, options: KgBuildOptions): KgEdgeDraft[] {
    const rows = this.repo.listFieldValues();
    if (!rows.length) return [];
    const groups = new Map<string, Set<number>>();
    const detail = new Map<string, KgFieldValue>();
    for (const row of rows) {
      if (!DETERMINISTIC_FIELD_TYPES.has(row.fieldType)) continue;
      if (row.value.length < options.minSharedReferenceValueLength) continue;
      const normalized = row.value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '');
      if (!normalized) continue;
      const key = `${row.fieldKey}\u0000${normalized}`;
      const members = groups.get(key);
      if (members) members.add(row.archiveId);
      else groups.set(key, new Set([row.archiveId]));
      detail.set(key, row);
    }

    const drafts: KgEdgeDraft[] = [];
    const seen = new Set<string>();
    for (const [key, members] of groups) {
      if (members.size < 2 || members.size > options.maxSharedReferenceFanout) continue;
      const row = detail.get(key)!;
      const sorted = [...members].sort((a, b) => a - b);
      // 增量重建只写「至少一端在本次范围内」的关联，其余由各自子树维护
      if (!fullBuild && !sorted.some((id) => scopedIds.has(id))) continue;
      for (const archiveId of sorted) {
        if (!fullBuild && !scopedIds.has(archiveId)) continue;
        for (const other of sorted) {
          if (other === archiveId) continue;
          const [left, right] = archiveId < other ? [archiveId, other] : [other, archiveId];
          const pairKey = `${left}|${right}|${key}`;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          drafts.push({
            edgeType: 'archive_shared_reference',
            fromKey: kgNodeKey.archive(left),
            toKey: kgNodeKey.archive(right),
            weight: 1,
            basis: KG_EDGE_BASIS.METADATA_EXACT,
            fromArchiveId: left,
            toArchiveId: right,
            evidence: {
              fieldKey: row.fieldKey,
              fieldLabel: row.fieldLabel,
              fieldType: row.fieldType,
              value: row.value,
              matchedOn: 'archive_field_values.value_text（同一著录字段取值完全相同，非关键词匹配）',
              sharedArchiveIds: sorted,
            },
          });
        }
      }
    }
    return drafts;
  }

  // ==================== 构建日志与状态查询 ====================

  private logBuildStart(buildType: 'full' | 'incremental'): number {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO kg_build_log (build_type, status, started_at) VALUES (?, 'running', ?)`,
        )
        .run(buildType, new Date().toISOString());
      return Number(info.lastInsertRowid);
    } catch {
      return 0;
    }
  }

  private logBuildEnd(logId: number, status: 'success' | 'failed', stats: KgBuildStats | null, error = ''): void {
    if (!logId) return;
    try {
      this.db
        .prepare(
          `UPDATE kg_build_log SET status=?, archives=?, nodes=?, edges=?, duration_ms=?, error_message=?, finished_at=?
           WHERE id=?`,
        )
        .run(
          status,
          stats?.archives ?? 0,
          stats?.nodes ?? 0,
          stats?.edges ?? 0,
          stats?.durationMs ?? 0,
          error,
          new Date().toISOString(),
          logId,
        );
      // 保留最近 100 条，FIFO 清理
      this.db.prepare(`DELETE FROM kg_build_log WHERE id NOT IN (SELECT id FROM kg_build_log ORDER BY started_at DESC LIMIT 100)`).run();
    } catch {
      // 日志写入失败不影响构建本身
    }
  }

  /** 构建状态查询（供控制器接口使用）。 */
  buildStatus(): {
    lastBuild: { type: string; status: string; startedAt: string; durationMs: number; archives: number; nodes: number; edges: number; error: string } | null;
    pendingTasks: number;
    totalSuccess: number;
    totalFailed: number;
    buildVersion: number;
  } {
    const last = this.db
      .prepare(`SELECT * FROM kg_build_log ORDER BY started_at DESC LIMIT 1`)
      .get() as Record<string, unknown> | undefined;
    const successRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM kg_build_log WHERE status='success'`)
      .get() as { c: number | bigint };
    const failedRow = this.db
      .prepare(`SELECT COUNT(*) AS c FROM kg_build_log WHERE status='failed'`)
      .get() as { c: number | bigint };
    return {
      lastBuild: last
        ? {
            type: String(last.build_type),
            status: String(last.status),
            startedAt: String(last.started_at),
            durationMs: Number(last.duration_ms ?? 0),
            archives: Number(last.archives ?? 0),
            nodes: Number(last.nodes ?? 0),
            edges: Number(last.edges ?? 0),
            error: String(last.error_message ?? ''),
          }
        : null,
      pendingTasks: this.dirty.size,
      totalSuccess: Number(successRow.c),
      totalFailed: Number(failedRow.c),
      buildVersion: this.buildVersion,
    };
  }
}
