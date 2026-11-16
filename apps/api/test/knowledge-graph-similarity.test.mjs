/**
 * 知识图谱关系计算单元测试（第一阶段）。
 *
 * 覆盖交付要求第七节中与算法相关的验收点：
 *  - 相似正文能建立关联、无关正文不产生噪声关系；
 *  - 不允许自身关联、不允许重复（含反向重复）关系、不允许无差别互连；
 *  - 权重区间与 Top-K 截断、匹配依据（共有词项）的正确性；
 *  - 档案级聚合只统计跨档案证据、支持证据越多权重越高；
 *  - 词频统计与既有 CJK Bigram 分词口径一致（复用同一 tokenizer）。
 * 运行：npm run build:api 后 node --test test/knowledge-graph-similarity.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = (rel) => pathToFileURL(path.join(__dirname, '..', 'dist', rel)).href;

const { findSimilarPairs, aggregateArchiveRelations, buildTfidf, tokenizeCounts } = await import(distUrl('graph/graph.similarity.js'));
const { countLexicalTokens, extractLexicalTokens } = await import(distUrl('search/cjk-bigram.js'));

const OPTIONS = {
  minChunkSimilarity: 0.14,
  chunkTopK: 5,
  maxTermDocFrequencyRatio: 0.5,
  maxPostingDocsPerTerm: 120,
  maxSharedTermsPerPair: 8,
};

/** 由文本构造相似度文档（与图谱构建一致：同一 tokenizer 出词频）。 */
function doc(id, archiveId, fileId, text) {
  return { id, archiveId, fileId, counts: tokenizeCounts(text) };
}

const CONTRACT_A = '设备采购合同付款条款：验收合格后十五个工作日内支付合同总价的百分之三十尾款，逾期每日按千分之五计违约金。';
const CONTRACT_B = '设备采购合同付款条款：验收合格后二十个工作日内支付合同总价的百分之四十尾款，逾期每日按千分之三计违约金。';
const UNRELATED = '园林养护记录：三月补植银杏十二株，修剪绿篱三百米，喷洒药剂防止蚜虫发生，养护用水取自中水回用管道。';
const ANOTHER_UNRELATED = '服务器机房巡检台账：温湿度读数正常，UPS 电池组内阻在阈值范围内，空调滤网本季度清洗一次。';

test.describe('CJK Bigram 词频统计（图谱与检索共用同一分词）', { concurrency: false }, () => {
  test('countLexicalTokens 统计重复出现，extractLexicalTokens 去重：两者词表一致', () => {
    const text = '合同合同合同验收';
    const counts = countLexicalTokens(text);
    const unique = extractLexicalTokens(text);
    assert.deepEqual([...counts.keys()].sort(), [...unique].sort(), '两个口径必须来自同一 tokenizer');
    assert.ok(counts.get('合同') >= 2, '同一词项必须累计出现次数（TF-IDF 依赖频次）');
    assert.equal(counts.get('验收'), 1);
  });

  test('拉丁与数字保持整体词项，不做字符级切分', () => {
    const counts = countLexicalTokens('JB2026-013 档案 contract NO.7');
    assert.ok(counts.has('jb2026'), `应保留整体拉丁/数字词项，实得 ${[...counts.keys()].join(',')}`);
    assert.ok(counts.has('档案'));
  });

  test('maxTokens 限制分析量：超限后停止累计', () => {
    const long = '档案管理信息系统'.repeat(200);
    const capped = countLexicalTokens(long, 50);
    let total = 0;
    for (const value of capped.values()) total += value;
    assert.equal(total, 50, '每个文档的分析量必须受限，避免超大附件支配构建成本');
  });
});

test.describe('TF-IDF + 倒排累加余弦（知识块内容关联）', { concurrency: false }, () => {
  test('相似正文得分显著高于无关正文', () => {
    const docs = [doc(1, 10, 100, CONTRACT_A), doc(2, 11, 101, CONTRACT_B), doc(3, 12, 102, UNRELATED)];
    const similar = buildTfidf([doc(1, 10, 100, CONTRACT_A), doc(2, 11, 101, CONTRACT_B)]);
    assert.equal(similar.length, 2);
    const result = findSimilarPairs(docs, OPTIONS);
    const pairIds = new Set(result.pairs.map((p) => `${p.leftId}-${p.rightId}`));
    assert.ok(pairIds.has('1-2'), '相似正文应建立关联');
    assert.ok(!pairIds.has('1-3') && !pairIds.has('2-3'), '无关正文不应产生明显噪声关系');
    const best = result.pairs.find((p) => p.leftId === 1 && p.rightId === 2);
    assert.ok(best.score > 0.15, `相似度应落在合理区间，实得 ${best.score}`);
    assert.ok(best.score <= 1, `余弦相似度不得超过 1，实得 ${best.score}`);
  });

  test('完全无关的两份正文不建立关联（不制造无差别互连）', () => {
    const docs = [doc(1, 10, 100, UNRELATED), doc(2, 11, 101, ANOTHER_UNRELATED)];
    const result = findSimilarPairs(docs, OPTIONS);
    assert.equal(result.pairs.length, 0, `主题与用词都不相关的正文应无任何关系，实得 ${JSON.stringify(result.pairs)}`);
  });

  test('不产生自环，也不产生 (a,b) 与 (b,a) 的重复关系', () => {
    const docs = [doc(1, 10, 100, CONTRACT_A), doc(2, 11, 101, CONTRACT_A)];
    const result = findSimilarPairs(docs, OPTIONS);
    assert.ok(result.pairs.length >= 1, '同文异档应判为高度相似');
    for (const pair of result.pairs) {
      assert.notEqual(pair.leftId, pair.rightId, '禁止自身关联');
      assert.ok(pair.leftId < pair.rightId, '端点必须按 id 升序规范化，杜绝反向重复');
    }
    const keys = result.pairs.map((p) => `${p.leftId}|${p.rightId}`);
    assert.equal(new Set(keys).size, keys.length, '同一对不得出现多次');
    const identical = result.pairs.find((p) => p.leftId === 1 && p.rightId === 2);
    assert.ok(identical.score > 0.9, `相同正文应接近 1，实得 ${identical.score}`);
  });

  test('同一附件内部的知识块不建立内容关联', () => {
    const docs = [doc(1, 10, 100, CONTRACT_A), doc(2, 10, 100, CONTRACT_B)];
    const result = findSimilarPairs(docs, OPTIONS);
    assert.equal(result.pairs.length, 0, '同一附件（同 fileId）的片段属自我关联，不得入图');
  });

  test('高频通用词不导致无差别互连（文档频率过滤生效）', () => {
    // 12 份正文都含「档案管理」，仅两个词项差异；把通用词频率占比压到阈值以下后必须跳过该词
    const docs = [];
    for (let i = 0; i < 12; i += 1) docs.push(doc(i + 1, i + 1, 100 + i, `档案管理信息系统 使用说明第${i}章 附件${i} 扫描 编号`));
    const relaxed = findSimilarPairs(docs, { ...OPTIONS, maxTermDocFrequencyRatio: 1 });
    const strict = findSimilarPairs(docs, { ...OPTIONS, maxTermDocFrequencyRatio: 0.5, minChunkSimilarity: 0.01 });
    assert.ok(relaxed.pairs.length > 0, '未设频率上限时高频词会制造大量弱关联（说明过滤是必要的）');
    assert.ok(strict.skippedTerms > 0, '高频词项必须被跳过并计入可观测指标');
    const strictKeys = new Set(strict.pairs.map((p) => `${p.leftId}|${p.rightId}`));
    const relaxedKeys = new Set(relaxed.pairs.map((p) => `${p.leftId}|${p.rightId}`));
    assert.ok(strictKeys.size < relaxedKeys.size, '高频词过滤后关联数量必须显著减少');
  });

  test('Top-K 截断：每个知识块保留的关联数不超过配置上限', () => {
    const docs = [doc(1, 10, 100, '项目验收与结算办法：验收组由技术、财务与档案人员组成，验收结论形成书面报告并归档保存三年。')];
    for (let i = 0; i < 10; i += 1) {
      docs.push(doc(i + 2, 11 + i, 200 + i, `项目验收与结算办法${i}：验收组由技术、财务与档案人员组成，验收结论形成书面报告并归档保存。`));
    }
    const result = findSimilarPairs(docs, { ...OPTIONS, chunkTopK: 3 });
    const perDoc = new Map();
    for (const pair of result.pairs) {
      for (const id of [pair.leftId, pair.rightId]) perDoc.set(id, (perDoc.get(id) ?? 0) + 1);
    }
    const max = Math.max(...perDoc.values());
    assert.ok(max <= 3 + 2, `Top-K=3 时单个知识块的关联数必须受限，实得最大 ${max}`);
    const hubLinks = result.pairs.filter((p) => p.leftId === 1 || p.rightId === 1);
    assert.ok(hubLinks.length <= 3, `中心文档最多 3 条关联，实得 ${hubLinks.length}`);
  });

  test('匹配依据正确：共有词项必须真实出现在两侧正文中', () => {
    const result = findSimilarPairs([doc(1, 10, 100, CONTRACT_A), doc(2, 11, 101, CONTRACT_B)], OPTIONS);
    const pair = result.pairs[0];
    assert.ok(pair.sharedTerms.length > 0, '必须记录匹配依据（共有词项）');
    assert.ok(pair.sharedTermCount >= pair.sharedTerms.length, '共有词项总数不少于展示的样本数');
    for (const term of pair.sharedTerms) {
      assert.ok(CONTRACT_A.includes(term) && CONTRACT_B.includes(term), `词项「${term}」应同时出现在两侧正文`);
    }
  });
});

test.describe('档案级关联聚合', { concurrency: false }, () => {
  const pairs = [
    { leftId: 1, rightId: 5, score: 0.3, sharedTerms: ['验收'], sharedTermCount: 3 },
    { leftId: 2, rightId: 6, score: 0.2, sharedTerms: ['付款'], sharedTermCount: 2 },
    { leftId: 3, rightId: 3, score: 0.9, sharedTerms: ['同档'], sharedTermCount: 9 },
    { leftId: 1, rightId: 7, score: 0.25, sharedTerms: ['合同'], sharedTermCount: 2 },
  ];
  const index = new Map([
    [1, { archiveId: 10, fileId: 100 }],
    [2, { archiveId: 10, fileId: 101 }],
    [3, { archiveId: 10, fileId: 102 }],
    [5, { archiveId: 11, fileId: 110 }],
    [6, { archiveId: 11, fileId: 111 }],
    [7, { archiveId: 12, fileId: 120 }],
  ]);

  test('跨档案证据聚合为档案关联，同档案内部证据不参与', () => {
    const relations = aggregateArchiveRelations(pairs, index, { minArchiveWeight: 0.1, archiveTopK: 10, evidenceLimit: 8 });
    const keys = relations.map((r) => `${r.leftArchiveId}-${r.rightArchiveId}`);
    assert.ok(keys.includes('10-11'), '10 与 11 两条证据应聚合为档案关联');
    assert.ok(keys.includes('10-12'), '10 与 12 的跨档案证据应聚合');
    assert.ok(!keys.some((k) => k.split('-').every((part) => part === '10')), '同一档案不得自我关联');
    for (const relation of relations) assert.notEqual(relation.leftArchiveId, relation.rightArchiveId);
  });

  test('证据越多权重越高（noisy-or 单调），权重上限为 1', () => {
    const relations = aggregateArchiveRelations(pairs, index, { minArchiveWeight: 0.1, archiveTopK: 10, evidenceLimit: 8 });
    const two = relations.find((r) => r.leftArchiveId === 10 && r.rightArchiveId === 11);
    const single = relations.find((r) => r.leftArchiveId === 10 && r.rightArchiveId === 12);
    assert.ok(two.supportCount === 2 && single.supportCount === 1);
    assert.ok(two.weight > single.weight, `多条支撑证据应提升权重：${two.weight} vs ${single.weight}`);
    assert.ok(two.weight <= 1 && single.weight <= 1);
    assert.ok(two.maxScore >= 0.3 - 1e-9 && two.maxScore <= 0.3 + 1e-9, '应保留最强单对相似度作为可解释指标');
  });

  test('低于阈值的聚合关联被丢弃，且每档只保留 Top-K', () => {
    const dropped = aggregateArchiveRelations(pairs, index, { minArchiveWeight: 0.95, archiveTopK: 10, evidenceLimit: 8 });
    assert.equal(dropped.length, 0, '阈值提高后弱关联必须全部消失（阈值可调且真实生效）');
    const limited = aggregateArchiveRelations(
      [
        { leftId: 1, rightId: 5, score: 0.9, sharedTerms: [], sharedTermCount: 1 },
        { leftId: 1, rightId: 6, score: 0.8, sharedTerms: [], sharedTermCount: 1 },
        { leftId: 1, rightId: 7, score: 0.7, sharedTerms: [], sharedTermCount: 1 },
      ],
      index,
      { minArchiveWeight: 0.1, archiveTopK: 2, evidenceLimit: 8 },
    );
    assert.equal(limited.length, 2, 'archiveTopK=2 时每档最多两条关联');
    assert.deepEqual(limited.map((r) => r.weight).sort((a, b) => b - a), [limited[0].weight, limited[1].weight], '输出按权重降序');
  });
});
