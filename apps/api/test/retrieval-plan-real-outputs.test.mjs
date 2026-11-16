/**
 * 检索规划器「真实模型输出」回归：防止「模型服务暂时不可用或检索计划未通过校验」反复复发。
 *
 * 背景：线上降级几乎都不是模型没返回，而是返回了但校验器按理想方言一票否决。
 * 这里分两层锁死：
 *  1) fixtures/planner-real-outputs.jsonl —— 由 tools/agent-planner-probe.mjs 线上录制的真实输出，逐条必须通过校验；
 *     新增降级样本时用 `node tools/agent-planner-probe.mjs` 重录再 `--replay` 复验即可，不需要改代码。
 *  2) 手写方言漂移样本 —— 覆盖录制里出现过、但模型下次未必会再写的所有写法（purpose/start/end/previous_results/空串/缺字段），
 *     同时锁死安全边界：宽容只作用于写法，注入与越权仍必须 fail-closed。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyRetrievalPlan, validateRetrievalPlan, validatePlanSteps } from '../dist/agent/retrieval.plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 取一份「除被测试字段外全部合法」的规划对象，避免各用例互相牵连。 */
function basePlan(question = '研究设施账期') {
  return { ...emptyRetrievalPlan(question), originalQuestion: undefined, normalizedQuestion: undefined,
    taskGoal: '查询研究设施账期', responseMode: 'find', confidence: 0.9, needsClarification: false, clarificationQuestion: null,
    archiveTitleCandidates: [], archiveNumberCandidates: [], categoryCandidates: [], attachmentNameCandidates: [],
    businessEntities: [], metadataTerms: [], contentTerms: ['账期'], semanticConcepts: [], timeRange: null,
    archiveStatus: null, categoryFilter: [], contentScope: 'global',
    hardConstraints: { archiveNumbers: [], archiveTitles: [], attachmentNames: [], metadata: [] }, softHints: [],
    searchSources: ['archive', 'metadata'], searchVariants: [], allowExpansion: true, isInventoryQuery: false,
    planSteps: [], referenceSlots: [], searchScope: { kind: 'allAuthorized' } };
}

test('线上录制的真实模型输出必须全部通过校验（不再降级）', () => {
  const file = path.join(here, 'fixtures', 'planner-real-outputs.jsonl');
  const records = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(records.length >= 6, '捕获文件应至少包含 6 条黄金问题输出');
  for (const record of records) {
    const plan = validateRetrievalPlan(JSON.parse(record.content), record.question);
    // 原始提问以服务端为准，模型回显不得污染后续执行与日志。
    assert.equal(plan.originalQuestion, record.question, record.question);
    assert.ok(plan.taskGoal.length, record.question);
  }
});

test('方言漂移按写法归一，不再报废整份计划', () => {
  // 步骤说明写成 purpose/description、作用域写成 previous_results（历史线上样本）。
  const steps = validatePlanSteps([
    { tool: 'archive.search', args: { title: '项目建设' }, purpose: '定位档案' },
    { tool: 'attachment.search', args: { scope: 'previous_results' } },
    { tool: 'content.read', args: { query: '主要内容' }, description: '读取正文' },
  ]);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].intent, '定位档案');
  assert.equal(steps[1].intent, '按 attachment.search 检索');
  assert.equal(steps[1].scope, 'step:step-1', 'previous_results 归一成紧接的上游步骤');
  assert.deepEqual(steps[1].args, {}, 'scope 是作用域声明，不是检索线索');
  assert.equal(steps[2].intent, '读取正文');
  assert.equal(steps[2].scope, undefined, '未声明作用域的步骤不得被凭空缩窄');
  // 第一步没有上游可引用，只能留空（不得凭空造依赖）。
  assert.equal(steps[0].scope, undefined);

  // timeRange 写成 start/end、可选字段写成空串或缺失。
  const plan = validateRetrievalPlan({
    ...basePlan('最近7天谁修改过档案'),
    taskGoal: '', clarificationQuestion: '', timeRange: { field: 'updatedAt', start: '2026-10-25', end: '2026-11-01' },
    hardConstraints: { archiveNumbers: [] }, searchVariants: [], responseMode: 'list', isInventoryQuery: true,
  }, '最近7天谁修改过档案');
  assert.deepEqual(plan.timeRange, { field: 'updatedAt', from: '2026-10-25', to: '2026-11-01' });
  assert.equal(plan.taskGoal, '按提问检索');
  assert.equal(plan.clarificationQuestion, null);
  assert.deepEqual(plan.hardConstraints.archiveTitles, [], '缺失的硬约束子键按空处理');

  // 模型回显 originalQuestion/normalizedQuestion 时以服务端提问为准，且不报未知键。
  const echoed = validateRetrievalPlan({ ...basePlan(), originalQuestion: '乱写的', normalizedQuestion: '乱写的' }, '研究设施账期');
  assert.equal(echoed.originalQuestion, '研究设施账期');

  // 线上真实失败样本（录制于旧校验器报 Unexpected step arg key 的那一轮）：整份计划必须能过。
  const smuggledCategory = {
    taskGoal: '查看财务类合同档案中附件的主要内容', responseMode: 'summary', confidence: 0.9,
    needsClarification: false, clarificationQuestion: null,
    archiveTitleCandidates: [], archiveNumberCandidates: [], categoryCandidates: ['合同', '财务'], attachmentNameCandidates: [],
    businessEntities: [], metadataTerms: [], contentTerms: ['合同', '财务'], semanticConcepts: ['财务合同附件内容'],
    timeRange: null, archiveStatus: null, categoryFilter: ['合同', '财务'], contentScope: 'global',
    hardConstraints: { archiveNumbers: [], archiveTitles: [], attachmentNames: [], metadata: [] }, softHints: ['财务合同'],
    searchSources: ['archive', 'metadata', 'attachment', 'content'], searchVariants: ['财务合同附件主要内容'],
    allowExpansion: true, isInventoryQuery: false, referenceSlots: [], searchScope: { kind: 'allAuthorized' },
    planSteps: [
      { id: 'step1', tool: 'archive.search', intent: '按分类与关键词定位财务类合同档案', args: { keyword: '财务合同', categoryFilter: ['合同', '财务'] } },
      { id: 'step2', tool: 'attachment.search', intent: '检索上述档案的附件', args: { keyword: '合同附件', scope: 'step:step1' } },
      { id: 'step3', tool: 'content.read', intent: '读取附件正文并总结主要内容', args: { query: '财务合同附件主要内容', scope: 'step:step2' } },
    ],
  };
  const recovered = validateRetrievalPlan(smuggledCategory, '你告诉我财务合同里面的附件主要内容');
  assert.equal(recovered.responseMode, 'summary');
  assert.deepEqual(recovered.categoryFilter, ['合同', '财务'], '分类限定仍在顶层生效');
  assert.equal(recovered.planSteps.length, 3);
  assert.equal(recovered.planSteps[1].scope, 'step:step1');

  // 重复写同一检索渠道是写法问题，去重后继续用，不能算“渠道数越界”（8 项去重后只剩 4 个合法渠道）。
  const dup = validateRetrievalPlan({ ...basePlan(), searchSources: ['archive', 'archive', 'metadata', 'metadata', 'attachment', 'attachment', 'content', 'content'] }, '研究设施账期');
  assert.deepEqual(dup.searchSources, ['archive', 'metadata', 'attachment', 'content']);
  assert.throws(() => validateRetrievalPlan({ ...basePlan(), searchSources: ['archive', 'everything'] }, '研究设施账期'), /Invalid retrieval enum/);
});

test('清单位与 responseMode 自相矛盾时取保守侧归一，不再报 Invalid inventory mode', () => {
  // 「我有什么档案」历史线上写法：isInventoryQuery=true + find → 升成 list。
  const find = validateRetrievalPlan({ ...basePlan(), responseMode: 'find', isInventoryQuery: true }, '我有什么档案');
  assert.equal(find.responseMode, 'list');
  assert.equal(find.isInventoryQuery, true);
  // 内容型问题被误挂清单位：取消清单位（清单会绕过空范围短路去列全库，取消它只会收窄）。
  for (const mode of ['content_qa', 'summary', 'compare']) {
    const plan = validateRetrievalPlan({ ...basePlan(), responseMode: mode, isInventoryQuery: true }, 'PPP合同主要讲了什么');
    assert.equal(plan.responseMode, mode);
    assert.equal(plan.isInventoryQuery, false, `${mode} 不得同时是清单检索`);
  }
  // 统计一律带清单位（原语义保留）。
  assert.equal(validateRetrievalPlan({ ...basePlan(), responseMode: 'statistics', isInventoryQuery: false }, '我有多少档案').isInventoryQuery, true);
});

test('安全边界不随宽容而放松：注入与越权仍 fail-closed', () => {
  const question = '仅限 ABC-2026-000001';
  const p = basePlan(question);
  // 顶层未知键 / 核心键缺失。
  assert.throws(() => validateRetrievalPlan({ ...p, notes: 'x' }, question), /Unexpected retrieval plan keys/);
  assert.throws(() => validateRetrievalPlan({ sql: 'SELECT *' }, question), /Unexpected retrieval plan keys/);
  const { taskGoal, ...noCore } = p;
  assert.throws(() => validateRetrievalPlan(noCore, question), /Missing retrieval plan core keys/);
  assert.throws(() => validateRetrievalPlan({ ...p, confidence: 2 }, question), /Invalid confidence/);
  assert.throws(() => validateRetrievalPlan({ ...p, responseMode: 'everything' }, question), /Invalid retrieval enum/);
  // 硬约束里的未知键（可执行/身份注入）仍拒绝；非法日期仍拒绝。
  assert.throws(() => validateRetrievalPlan({ ...p, hardConstraints: { ...p.hardConstraints, userId: 1 } }, question), /Unexpected retrieval plan keys/);
  assert.throws(() => validateRetrievalPlan({ ...p, timeRange: { field: 'createdAt', from: '2026-02-31', to: null } }, question), /Invalid date/);
  // 子步骤：非白名单工具、args 里的数值 ID/身份都是越权尝试，整份计划 fail-closed。
  assert.throws(() => validatePlanSteps([{ tool: 'archive.delete', args: { archiveNo: 'ABC-2026-000001' } }]), /Invalid retrieval enum/);
  assert.throws(() => validatePlanSteps([{ tool: 'attachment.search', args: { archiveIds: [1, 2], keyword: '图纸' } }]), /Unexpected step arg key/);
  assert.throws(() => validatePlanSteps([{ tool: 'attachment.search', args: { archive_ids: [1] } }]), /Unexpected step arg key/, '下划线写法同样算越权');
  assert.throws(() => validatePlanSteps([{ tool: 'attachment.search', args: { userId: 1 } }]), /Unexpected step arg key/);
  assert.throws(() => validatePlanSteps([{ tool: 'attachment.search', args: {}, contextRef: { entity: 'archive', slot: 99 } }]), /Invalid slot/);
  // 回归（线上真实样本）：模型把顶层 categoryFilter 塞进 args 是写法噪声，不能拿它报废整份计划。
  const noisy = validatePlanSteps([{ id: 'step1', tool: 'archive.search', intent: '按分类定位', args: { keyword: '财务合同', categoryFilter: ['合同', '财务'], note: '先看合同' } }]);
  assert.deepEqual(noisy[0].args, { keyword: '财务合同' }, '非线索且非越权的键按丢弃处理，保留可用线索');
  // 写法漂移与越权的分界：previous_results 是写法（归一），step:不存在 是无效引用（丢弃该作域，不缩窄到错误集合）。
  assert.throws(() => validatePlanSteps([
    { id: 'a', tool: 'archive.search', args: { title: '项目' } },
    { id: 'b', tool: 'attachment.search', args: {}, scope: 'step:missing', dependsOn: ['missing', 'a'] },
  ]), /scope reference/, '无法验证的作用域必须拒绝，禁止丢弃后扩大检索范围');
  // 整句问题当检索词仍判为无效线索。
  assert.throws(() => validateRetrievalPlan({ ...p, contentTerms: ['仅限 ABC-2026-000001'] }, question), /Question is not a search term/);
});
