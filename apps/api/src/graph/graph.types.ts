/**
 * 档案知识图谱（第一阶段）领域类型与构建参数。
 *
 * 定位：图谱是「可重建的索引层」，不是业务事实的第二份副本。
 * - 节点通过 node_type + biz_key 幂等键与 ref_id 回指权威业务行（分类 / 档案 / 附件 / 正文片段）；
 * - 结构关系（分类→档案→附件→知识块）来自真实业务外键，内容关系（知识块相似、档案关联）
 *   由 TF-IDF 余弦计算，确定性关联只认著录字段的等值命中；
 * - 不引入 Embedding / 向量库 / Neo4j / 独立检索服务，词法能力完全复用 CJK Bigram 分词。
 */

/** 图谱节点类型（与 kg_graph_nodes.node_type 的 CHECK 约束一一对应）。 */
export type KgNodeType = 'category' | 'archive' | 'file' | 'chunk';

/** 图谱关系类型（与 kg_graph_edges.edge_type 的 CHECK 约束一一对应）。 */
export type KgEdgeType =
  /** 分类包含档案（真实业务归属） */
  | 'category_contains_archive'
  /** 档案包含附件（真实业务归属） */
  | 'archive_contains_file'
  /** 附件包含正文知识块（真实业务归属） */
  | 'file_contains_chunk'
  /** 知识块之间的内容关联（TF-IDF 余弦） */
  | 'chunk_similar_to'
  /** 档案之间的内容关联（知识块关联聚合） */
  | 'archive_related_to'
  /** 档案之间的确定性关联（著录字段真实等值，如项目编号 / 合同编号） */
  | 'archive_shared_reference';

/** 关系计算依据（用于向使用者说明「这条边是怎么来的」）。 */
export const KG_EDGE_BASIS = {
  /** 业务外键推导的结构关系 */
  STRUCTURE: 'business_structure',
  /** TF-IDF + 倒排累加余弦相似度 */
  TFIDF_COSINE: 'tfidf_cosine',
  /** 知识块相似度聚合到档案级 */
  TFIDF_COSINE_AGGREGATED: 'tfidf_cosine_aggregated',
  /** 元数据字段等值命中 */
  METADATA_EXACT: 'metadata_exact_match',
} as const;

/** 节点幂等键：同一业务对象在任何时间、任何构建方式下都落到同一个键。 */
export const kgNodeKey = {
  category: (categoryId: number) => `category:${categoryId}`,
  archive: (archiveId: number) => `archive:${archiveId}`,
  file: (fileId: number) => `file:${fileId}`,
  /** 知识块以「物理文件名 + 片段序号」定位：同一物理版本重跑不产生新节点，内容变化必然换物理文件。 */
  chunk: (storedName: string, chunkNo: number) => `chunk:${storedName}:${chunkNo}`,
} as const;

/** 图谱构建与关系计算的阈值参数（全部可配置，取值经实际数据抽样验证，见交付报告）。 */
export interface KgBuildOptions {
  /** 知识块内容关联的余弦相似度下限，低于该值视为噪声丢弃。 */
  minChunkSimilarity: number;
  /** 每个知识块保留的内容关联上限（Top-K）。 */
  chunkTopK: number;
  /** 档案级关联的聚合权重下限。 */
  minArchiveWeight: number;
  /** 每份档案保留的档案级关联上限（Top-K）。 */
  archiveTopK: number;
  /** 词项文档频率占比上限：出现在超过该比例文档中的词（如「档案」「通知」）不参与配对累加。 */
  maxTermDocFrequencyRatio: number;
  /** 单个词项倒排链最多累加的文档数（按词权取前 N），用于抑制高频词的配对成本与噪声。 */
  maxPostingDocsPerTerm: number;
  /** 参与相似度计算的知识块最小字符数：过短片段（如页眉、单行标题）不足以支撑内容关联。 */
  minChunkCharsForSimilarity: number;
  /** 参与相似度计算的知识块总量上限，超出即停止并把剩余标记为 skipped（防止单次构建失控）。 */
  maxChunksPerBuild: number;
  /** 确定性关联允许的最大共享档案数：超过则说明该字段值是类别而非唯一指称（如「2024年度」）。 */
  maxSharedReferenceFanout: number;
  /** 确定性关联要求的最小字段值长度：过短的值等同宽泛关键词。 */
  minSharedReferenceValueLength: number;
  /** 构建时同时保存的示例证据知识块数量上限（避免证据 JSON 无界膨胀）。 */
  maxEvidencePairsPerEdge: number;
}

const clampNumber = (raw: string | undefined, fallback: number, min: number, max: number): number => {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
};

/** 默认参数：偏保守（宁可漏一些弱关联，也不制造无差别互连）。 */
export const KG_DEFAULT_OPTIONS: KgBuildOptions = {
  minChunkSimilarity: 0.14,
  chunkTopK: 5,
  minArchiveWeight: 0.16,
  archiveTopK: 8,
  maxTermDocFrequencyRatio: 0.5,
  maxPostingDocsPerTerm: 120,
  minChunkCharsForSimilarity: 60,
  maxChunksPerBuild: 20000,
  maxSharedReferenceFanout: 25,
  minSharedReferenceValueLength: 3,
  maxEvidencePairsPerEdge: 8,
};

/** 环境变量覆盖（JIT_KG_*），便于不改代码即可按实际语料调参。 */
export function resolveKgOptions(overrides: Partial<KgBuildOptions> = {}): KgBuildOptions {
  const fromEnv: KgBuildOptions = {
    minChunkSimilarity: clampNumber(process.env.JIT_KG_MIN_CHUNK_SIMILARITY, KG_DEFAULT_OPTIONS.minChunkSimilarity, 0.01, 1),
    chunkTopK: Math.round(clampNumber(process.env.JIT_KG_CHUNK_TOP_K, KG_DEFAULT_OPTIONS.chunkTopK, 1, 50)),
    minArchiveWeight: clampNumber(process.env.JIT_KG_MIN_ARCHIVE_WEIGHT, KG_DEFAULT_OPTIONS.minArchiveWeight, 0.01, 1),
    archiveTopK: Math.round(clampNumber(process.env.JIT_KG_ARCHIVE_TOP_K, KG_DEFAULT_OPTIONS.archiveTopK, 1, 100)),
    maxTermDocFrequencyRatio: clampNumber(process.env.JIT_KG_MAX_TERM_DF_RATIO, KG_DEFAULT_OPTIONS.maxTermDocFrequencyRatio, 0.05, 1),
    maxPostingDocsPerTerm: Math.round(clampNumber(process.env.JIT_KG_MAX_POSTING_DOCS, KG_DEFAULT_OPTIONS.maxPostingDocsPerTerm, 2, 5000)),
    minChunkCharsForSimilarity: Math.round(clampNumber(process.env.JIT_KG_MIN_CHUNK_CHARS, KG_DEFAULT_OPTIONS.minChunkCharsForSimilarity, 0, 5000)),
    maxChunksPerBuild: Math.round(clampNumber(process.env.JIT_KG_MAX_CHUNKS, KG_DEFAULT_OPTIONS.maxChunksPerBuild, 100, 200000)),
    maxSharedReferenceFanout: Math.round(clampNumber(process.env.JIT_KG_MAX_SHARED_FANOUT, KG_DEFAULT_OPTIONS.maxSharedReferenceFanout, 2, 500)),
    minSharedReferenceValueLength: Math.round(clampNumber(process.env.JIT_KG_MIN_SHARED_LENGTH, KG_DEFAULT_OPTIONS.minSharedReferenceValueLength, 1, 100)),
    maxEvidencePairsPerEdge: Math.round(clampNumber(process.env.JIT_KG_MAX_EVIDENCE_PAIRS, KG_DEFAULT_OPTIONS.maxEvidencePairsPerEdge, 1, 50)),
  };
  return { ...fromEnv, ...overrides };
}

/** 知识块节点视图（图谱内部读取正文片段用，字段与 archive_content_chunks 对齐）。 */
export interface KgChunkSource {
  /** archive_content_chunks.id */
  chunkId: number;
  /** archive_content_units.id */
  unitId: number;
  archiveId: number;
  fileId: number;
  chunkNo: number;
  storedName: string;
  extension: string;
  extractor: string;
  /** 提取状态（indexed / no_text / unsupported / …），非 indexed 的附件仍要保留附件节点。 */
  status: string;
  message: string;
  locator: string;
  pageNo: number | null;
  posFrom: number | null;
  posTo: number | null;
  text: string;
  sha256: string;
  versionNo: number | null;
}

/** 待写入的节点（服务层组装，仓储层按 biz_key 幂等落库）。 */
export interface KgNodeDraft {
  nodeType: KgNodeType;
  bizKey: string;
  refId: number;
  archiveId: number | null;
  fileId: number | null;
  name: string;
  meta: Record<string, unknown>;
  /** 来源业务表名（溯源用，如 archive_content_chunks）。 */
  source: string;
  /** 内容指纹：用于变更检测（正文变化、文件名变化等）。 */
  contentHash: string;
}

/** 待写入的关系。 */
export interface KgEdgeDraft {
  edgeType: KgEdgeType;
  /** 幂等键（从节点），由服务层用 biz_key 解析出节点 id 后填入 nodeId 字段。 */
  fromKey: string;
  toKey: string;
  weight: number;
  basis: string;
  evidence: Record<string, unknown>;
  fromArchiveId: number | null;
  toArchiveId: number | null;
}

/** 已落库节点（含 id，供测试与后续阶段查询用）。 */
export interface KgNodeRow {
  id: number;
  nodeType: KgNodeType;
  bizKey: string;
  refId: number;
  archiveId: number | null;
  fileId: number | null;
  name: string;
  meta: Record<string, unknown>;
  source: string;
  contentHash: string;
  builtAt: string;
}

/** 已落库关系。 */
export interface KgEdgeRow {
  id: number;
  edgeType: KgEdgeType;
  fromNode: number;
  toNode: number;
  weight: number;
  basis: string;
  evidence: Record<string, unknown>;
  fromArchiveId: number | null;
  toArchiveId: number | null;
}

/** 构建结果统计（全量重建与单档案重建共用）。 */
export interface KgBuildStats {
  /** 本次构建覆盖的档案数 */
  archives: number;
  /** 处理的附件数（含提取失败者） */
  files: number;
  /** 纳入相似度计算的知识块数 */
  chunks: number;
  /** 提取失败或不支持格式而仅保留附件节点的个数 */
  failed: number;
  /** 因超过语料上限而未纳入相似度计算的知识块数 */
  skipped: number;
  nodes: number;
  edges: number;
  edgesByType: Partial<Record<KgEdgeType, number>>;
  /** 本次构建耗时（毫秒） */
  durationMs: number;
  /** 语料被上限截断时为 true */
  truncated: boolean;
  /** 失败原因汇总（不阻断构建，仅如实说明） */
  warnings: string[];
}

export function emptyKgStats(): KgBuildStats {
  return {
    archives: 0,
    files: 0,
    chunks: 0,
    failed: 0,
    skipped: 0,
    nodes: 0,
    edges: 0,
    edgesByType: {},
    durationMs: 0,
    truncated: false,
    warnings: [],
  };
}

/** 关系类型 → 中文说明（交付报告与后续阶段展示用，不参与计算）。 */
export const KG_EDGE_TYPE_LABEL: Record<KgEdgeType, string> = {
  category_contains_archive: '分类包含档案',
  archive_contains_file: '档案包含附件',
  file_contains_chunk: '附件包含正文知识块',
  chunk_similar_to: '知识块内容关联',
  archive_related_to: '档案内容关联',
  archive_shared_reference: '档案著录字段等值关联',
};
