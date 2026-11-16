/**
 * 知识图谱关系计算（纯函数层，不接触数据库，便于单测与参数抽样验证）。
 *
 * 方案（轻量、可解释、零外部服务）：
 * 1. 词法向量：完全复用 CJK Bigram 分词（countLexicalTokens），不引入 Embedding；
 * 2. TF-IDF 权重：TF 取次线性 1+ln(tf)，IDF 取 ln(1+N/df)，抑制「档案／通知」这类通用高频词；
 * 3. 余弦相似度用倒排索引累加：按词项遍历倒排链，把 w(t,a)*w(t,b) 累加到候选文档对的内积上，
 *    避免「文档 × 文档 × 词项」的全量三重循环；
 * 4. 降噪硬规则：词项文档频率超过阈值占比直接跳过；倒排链只保留词权前 N 个文档；
 *    同一附件内部的知识块不参与内容关联（自我关联）；from<to 规范化杜绝重复与自环；
 * 5. Top-K 截断后再输出，档案级关联由知识块级关联聚合得到（noisy-or 合并，支持证据越多权重越高）。
 */
import { countLexicalTokens } from '../search/cjk-bigram';

/** 参与计算的文档（一个附件正文知识块即一个文档）。 */
export interface SimilarityDoc {
  /** 稳定唯一标识（本项目中为 archive_content_chunks.id） */
  id: number;
  archiveId: number;
  fileId: number;
  /** 词项 → 出现次数 */
  counts: Map<string, number>;
}

export interface SimilarityPair {
  /** 规范化端点：leftId < rightId，杜绝 (a,b) 与 (b,a) 重复 */
  leftId: number;
  rightId: number;
  score: number;
  /** 共有的高贡献词项（匹配依据，按贡献降序） */
  sharedTerms: string[];
  /** 共有词项总数（匹配广度） */
  sharedTermCount: number;
}

export interface SimilarityOptions {
  minChunkSimilarity: number;
  chunkTopK: number;
  maxTermDocFrequencyRatio: number;
  maxPostingDocsPerTerm: number;
  /** 每对最多保留的匹配依据词项数 */
  maxSharedTermsPerPair?: number;
}

export interface SimilarityResult {
  pairs: SimilarityPair[];
  /** 参与计算的有效文档数 */
  docs: number;
  /** 倒排词项总数 */
  terms: number;
  /** 因高频被跳过的词项数（噪声控制的可观测指标） */
  skippedTerms: number;
}

interface DocWeight {
  doc: SimilarityDoc;
  weights: Map<string, number>;
  norm: number;
}

const pairKey = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** 计算 TF-IDF 权重与向量模长；语料为空时返回空表。 */
export function buildTfidf(docs: SimilarityDoc[]): DocWeight[] {
  const total = docs.length;
  if (!total) return [];
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of doc.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const idf = new Map<string, number>();
  for (const [term, frequency] of df) idf.set(term, Math.log(1 + total / frequency));

  const out: DocWeight[] = [];
  for (const doc of docs) {
    const weights = new Map<string, number>();
    let sumSquare = 0;
    for (const [term, tf] of doc.counts) {
      const weight = (1 + Math.log(Math.max(1, tf))) * (idf.get(term) ?? 0);
      if (weight <= 0) continue;
      weights.set(term, weight);
      sumSquare += weight * weight;
    }
    out.push({ doc, weights, norm: Math.sqrt(sumSquare) });
  }
  return out;
}

/**
 * 倒排累加求余弦，返回通过阈值与 Top-K 筛选的知识块关联对。
 * 只处理「至少出现在两个文档中」的词项；单文档词项对相似度无贡献。
 */
export function findSimilarPairs(docs: SimilarityDoc[], options: SimilarityOptions): SimilarityResult {
  const weighted = buildTfidf(docs);
  const normByDoc = new Map<number, number>();
  for (const entry of weighted) normByDoc.set(entry.doc.id, entry.norm);
  const maxDocFrequency = Math.max(2, Math.floor(weighted.length * options.maxTermDocFrequencyRatio));

  // 倒排索引：词项 → [文档序号, 词权]
  const postings = new Map<string, Array<{ index: number; weight: number }>>();
  weighted.forEach((entry, index) => {
    for (const [term, weight] of entry.weights) {
      const list = postings.get(term);
      if (list) list.push({ index, weight });
      else postings.set(term, [{ index, weight }]);
    }
  });

  interface Accumulator { dot: number; terms: Array<{ term: string; contribution: number }>; shared: number }
  const accumulators = new Map<string, Accumulator>();
  const maxSharedTerms = options.maxSharedTermsPerPair ?? 8;
  let skippedTerms = 0;

  for (const [term, list] of postings) {
    if (list.length < 2) continue;
    // 高频词直接跳过：IDF 本已很低，参与配对只会制造无差别互连并放大成本
    if (list.length > maxDocFrequency) { skippedTerms += 1; continue; }
    const kept = list.length > options.maxPostingDocsPerTerm
      ? [...list].sort((a, b) => b.weight - a.weight).slice(0, options.maxPostingDocsPerTerm)
      : list;
    for (let i = 0; i < kept.length; i += 1) {
      for (let j = i + 1; j < kept.length; j += 1) {
        const left = kept[i], right = kept[j];
        if (left.index === right.index) continue;
        const a = weighted[left.index].doc, b = weighted[right.index].doc;
        // 同一附件内的知识块不建立内容关联（避免自我关联与同一文档的重复切分噪声）
        if (a.fileId === b.fileId) continue;
        const key = pairKey(a.id, b.id);
        const contribution = left.weight * right.weight;
        let bucket = accumulators.get(key);
        if (!bucket) { bucket = { dot: 0, terms: [], shared: 0 }; accumulators.set(key, bucket); }
        bucket.dot += contribution;
        bucket.shared += 1;
        bucket.terms.push({ term, contribution });
        if (bucket.terms.length > maxSharedTerms * 4) {
          bucket.terms.sort((x, y) => y.contribution - x.contribution);
          bucket.terms.length = maxSharedTerms;
        }
      }
    }
  }

  const scored: SimilarityPair[] = [];
  for (const [key, bucket] of accumulators) {
    const [leftId, rightId] = key.split('|').map(Number);
    const leftNorm = normByDoc.get(leftId) ?? 0;
    const rightNorm = normByDoc.get(rightId) ?? 0;
    if (leftNorm <= 0 || rightNorm <= 0) continue;
    const score = bucket.dot / (leftNorm * rightNorm);
    if (score < options.minChunkSimilarity) continue;
    const sharedTerms = bucket.terms
      .sort((x, y) => y.contribution - x.contribution)
      .slice(0, maxSharedTerms)
      .map((entry) => entry.term);
    scored.push({ leftId, rightId, score, sharedTerms, sharedTermCount: bucket.shared });
  }

  // Top-K：按端点分别取前 K（任一端口进入前 K 即保留），再按分数降序输出
  const byDoc = new Map<number, SimilarityPair[]>();
  for (const pair of scored) {
    for (const id of [pair.leftId, pair.rightId]) {
      const list = byDoc.get(id);
      if (list) list.push(pair);
      else byDoc.set(id, [pair]);
    }
  }
  const kept = new Set<string>();
  for (const list of byDoc.values()) {
    list.sort((a, b) => b.score - a.score || a.rightId - b.rightId);
    for (const pair of list.slice(0, options.chunkTopK)) kept.add(pairKey(pair.leftId, pair.rightId));
  }
  const pairs = scored
    .filter((pair) => kept.has(pairKey(pair.leftId, pair.rightId)))
    .sort((a, b) => b.score - a.score || a.leftId - b.leftId || a.rightId - b.rightId);

  return { pairs, docs: weighted.length, terms: postings.size, skippedTerms };
}

/** 档案级关联（知识块级关联聚合）。 */
export interface ArchiveRelation {
  /** 规范化档案端点：leftArchiveId < rightArchiveId */
  leftArchiveId: number;
  rightArchiveId: number;
  /** 聚合权重（noisy-or 合并 Top-3 知识块关联，∈(0,1)） */
  weight: number;
  /** 支撑该关联的知识块对（按相似度降序，最多取 evidenceLimit 条） */
  supportingPairs: SimilarityPair[];
  /** 支撑知识块对总数 */
  supportCount: number;
  /** 单对最高相似度 */
  maxScore: number;
}

export interface ArchiveAggregateOptions {
  minArchiveWeight: number;
  archiveTopK: number;
  evidenceLimit: number;
}

/**
 * 把知识块级关联聚合为档案级关联：只聚合跨档案的知识块对。
 * 权重用 noisy-or 合并最强的至多 3 条支撑证据：`1 - Π(1 - s)`，
 * 即「多角度的内容呼应」会提升置信度，但单一强证据也不会被抹掉。
 */
export function aggregateArchiveRelations(
  pairs: SimilarityPair[],
  docIndex: Map<number, { archiveId: number; fileId: number }>,
  options: ArchiveAggregateOptions,
): ArchiveRelation[] {
  interface Group { pairs: SimilarityPair[] }
  const groups = new Map<string, Group>();
  for (const pair of pairs) {
    const left = docIndex.get(pair.leftId);
    const right = docIndex.get(pair.rightId);
    if (!left || !right) continue;
    if (left.archiveId === right.archiveId) continue;
    const [archiveA, archiveB] = left.archiveId < right.archiveId
      ? [left.archiveId, right.archiveId]
      : [right.archiveId, left.archiveId];
    const key = `${archiveA}|${archiveB}`;
    const group = groups.get(key);
    if (group) group.pairs.push(pair);
    else groups.set(key, { pairs: [pair] });
  }

  const relations: ArchiveRelation[] = [];
  for (const [key, group] of groups) {
    const [leftArchiveId, rightArchiveId] = key.split('|').map(Number);
    const sorted = [...group.pairs].sort((a, b) => b.score - a.score);
    const strongest = sorted.slice(0, 3);
    let weight = 1;
    for (const pair of strongest) weight *= 1 - Math.min(0.999, Math.max(0, pair.score));
    weight = Math.min(1, 1 - weight);
    if (weight < options.minArchiveWeight) continue;
    relations.push({
      leftArchiveId,
      rightArchiveId,
      weight,
      supportingPairs: sorted.slice(0, options.evidenceLimit),
      supportCount: sorted.length,
      maxScore: sorted[0]?.score ?? 0,
    });
  }

  // 每份档案只保留权重最高的 archiveTopK 条关联（任一端口入选即保留）
  const perArchive = new Map<number, ArchiveRelation[]>();
  for (const relation of relations) {
    for (const id of [relation.leftArchiveId, relation.rightArchiveId]) {
      const list = perArchive.get(id);
      if (list) list.push(relation);
      else perArchive.set(id, [relation]);
    }
  }
  const kept = new Set<string>();
  for (const list of perArchive.values()) {
    list.sort((a, b) => b.weight - a.weight || a.rightArchiveId - b.rightArchiveId);
    for (const relation of list.slice(0, options.archiveTopK)) kept.add(`${relation.leftArchiveId}|${relation.rightArchiveId}`);
  }
  return relations
    .filter((relation) => kept.has(`${relation.leftArchiveId}|${relation.rightArchiveId}`))
    .sort((a, b) => b.weight - a.weight || a.leftArchiveId - b.leftArchiveId);
}

/** 文本 → 词频（与全文索引同一 tokenizer，保证图谱口径与检索口径一致）。 */
export function tokenizeCounts(text: string): Map<string, number> {
  return countLexicalTokens(text);
}
