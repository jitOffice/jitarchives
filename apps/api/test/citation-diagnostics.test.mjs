/**
 * 引用核验放宽与结构化诊断的单测（WS001-CW01-2026-000001 附件总结失败案例回归）。
 * 覆盖三类边界：日期/空格/全半角归一化、被拒规则的诊断字段、诊断透传到生成状态。
 * 注意：模型输出文本含 fileId/archiveId 等键名会被防注入规则直接拒绝，fixture 不携带这类字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvidence,normalizeNumericToken,verifyCitations} from '../dist/agent/content.evidence.js';
import {generateGroundedAnswer} from '../dist/agent/answer.generation.js';

const row=(text,id)=>({chunkId:id,unitId:id,archiveTitle:'财务合同',fileName:'AI_Office_Workspace_Work_Summary_Day10.docx',locator:`DOCX 第 ${id} 段`,text});
const evidence=buildEvidence([
  row('整理日期 2026-10-21，项目根目录 D:\\Projects\\ai-office-workspace。编号 WS001-CW01-2026-000001。',1),
  row('AI OFFICE WORKSPACE Web 全栈项目工作总结：Day 10 开发与测试，共 23 个分块。',2),
]);
const claim=(text,evidenceQuote,citations=['E1'])=>({text,evidenceQuote,citations});
const answer=claims=>JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims});
// 生产链路（generateGroundedAnswer）始终开启语义核验；改写型 claim 只有该模式才能成为候选。
const verify=raw=>verifyCitations(raw,evidence,{semanticReview:true});

test('normalizeNumericToken：日期分隔符互认、字母数字空格折叠、全角转半角',()=>{
  assert.equal(normalizeNumericToken('２０２６１０２１'),'20261021');
  assert.equal(normalizeNumericToken('2026 年 10 月 21 日'),'2026-10-21');
  assert.equal(normalizeNumericToken('2026-10-21'),'2026-10-21');
  assert.equal(normalizeNumericToken('2026/10/21'),'2026-10-21');
  assert.equal(normalizeNumericToken('2026年1月5日'),'2026-01-05');
  assert.equal(normalizeNumericToken('Day 10'),'Day10');
  assert.equal(normalizeNumericToken('第 23 段'),'第23段');
});

test('日期书写变体（2026年10月21日 ≡ 2026-10-21）不再被 protectedFacts 误杀',()=>{
  const result=verify(answer([claim('整理日期为 2026 年 10 月 21 日。','整理日期 2026-10-21，项目根目录 D:\\Projects\\ai-office-workspace。编号 WS001-CW01-2026-000001。')]));
  // 改写型结论通过本地规则后进入语义复核候选（valid 需 reviewGrounding 批准），不应被硬拒。
  assert.equal(result.failure,undefined);assert.equal(result.requiresSemantic,true);assert.equal(result.diagnostics,undefined);
});

test('字母与数字间空格（Day 10 ≡ Day10）及跨块数字在原文内即可通过',()=>{
  const result=verify(answer([
    claim('Day10 完成开发与测试。','AI OFFICE WORKSPACE Web 全栈项目工作总结：Day 10 开发与测试，共 23 个分块。',['E2']),
    claim('全文共23个分块。','AI OFFICE WORKSPACE Web 全栈项目工作总结：Day 10 开发与测试，共 23 个分块。',['E2']),
  ]));
  assert.equal(result.failure,undefined);assert.equal(result.requiresSemantic,true);assert.equal(result.diagnostics,undefined);
});

test('全角数字书写与含连字符标识符不再被误杀',()=>{
  const result=verify(answer([claim('档号 WS001-CW01-2026-000001。','整理日期 2026-10-21，项目根目录 D:\\Projects\\ai-office-workspace。编号 WS001-CW01-2026-000001。')]));
  assert.equal(result.failure,undefined);assert.equal(result.requiresSemantic,true);assert.equal(result.diagnostics,undefined);
});

test('真实不符的数字仍被拒绝',()=>{
  const result=verify(answer([claim('整理日期为 2026 年 10 月 22 日。','整理日期 2026-10-21，项目根目录 D:\\Projects\\ai-office-workspace。编号 WS001-CW01-2026-000001。')]));
  assert.equal(result.valid,false);assert.equal(result.failure,'fact_mismatch');
});

test('标识符分隔符两侧空格（Express/Node.js ≡ Express / Node.js）不再被 protectedFacts 误杀',()=>{
  const tech=buildEvidence([{chunkId:9,unitId:9,archiveTitle:'T',fileName:'f.docx',locator:'DOCX 第 14 段',text:'技术栈 Express / Node.js 与 SQLite。'}]);
  const raw=JSON.stringify({answer:'技术栈 Express/Node.js 与 SQLite。',claims:[{text:'技术栈 Express/Node.js 与 SQLite。',citations:['E1'],evidenceQuote:'技术栈 Express / Node.js 与 SQLite。'}]});
  const result=verifyCitations(raw,tech,{semanticReview:true});
  assert.equal(result.valid,true,result.failure);
});

test('answer 为流畅段落（含连接性措辞）但事实与 claims 一致时不再被 answer全等 误杀',()=>{
  const e=buildEvidence([{chunkId:8,unitId:8,archiveTitle:'T',fileName:'f.docx',locator:'DOCX 第 1 段',text:'整理日期为2026年10月21日。'}]);
  const raw=JSON.stringify({answer:'内容概述：本文件整理日期为2026年10月21日，以下为主要内容。',claims:[{text:'整理日期为2026年10月21日。',citations:['E1'],evidenceQuote:'整理日期为2026年10月21日。'}]});
  const result=verifyCitations(raw,e,{semanticReview:true});
  assert.equal(result.valid,true,result.failure);assert.equal(result.diagnostics,undefined);
});

test('answer 字段仅作包装：即使含 claims 里没有的新数字也不参与核验，不硬拒（展示只来自 claims）',()=>{
  const e=buildEvidence([{chunkId:7,unitId:7,archiveTitle:'T',fileName:'f.docx',locator:'DOCX 第 1 段',text:'合同金额为1.5万元。'}]);
  const raw=JSON.stringify({answer:'合同金额为1.5万元，另有违约金99万元。',claims:[{text:'合同金额为1.5万元。',citations:['E1'],evidenceQuote:'合同金额为1.5万元。'}]});
  const result=verifyCitations(raw,e,{semanticReview:true});
  // claims 逐字命中原文→直接通过（valid）；answer 里的 99 万元不会展示，也不会因 answer全等 被拒。
  assert.equal(result.valid,true,result.failure);assert.equal(result.diagnostics,undefined);
  assert.doesNotMatch(result.cleaned??'',/99/);
});

test('answer 与 claims 仅单位写法不同（30天 vs 30日）不会被 answer全等 误判为新事实',()=>{
  const e=buildEvidence([{chunkId:6,unitId:6,archiveTitle:'T',fileName:'f.docx',locator:'DOCX 第 1 段',text:'验收合格后30日内完成付款。'}]);
  const raw=JSON.stringify({answer:'内容概述：验收通过后30天内完成付款。',claims:[{text:'验收合格后30日内完成付款。',citations:['E1'],evidenceQuote:'验收合格后30日内完成付款。'}]});
  const result=verifyCitations(raw,e,{semanticReview:true});
  assert.equal(result.failure,undefined);assert.equal(result.diagnostics,undefined);
});

test('纯字母斜杠组合（README/GitHub）不被 protectedFacts 当编码误杀，含数字编码仍被校验',()=>{
  const e=buildEvidence([{chunkId:5,unitId:5,archiveTitle:'T',fileName:'f.docx',locator:'DOCX 第 13 段',text:'Day 13 测试记录与 README 整理、必要 Git 提交。'}]);
  const prose=verifyCitations(JSON.stringify({answer:'Day 13 完成 README/GitHub 整理。',claims:[{text:'Day 13 完成 README/GitHub 整理。',citations:['E1'],evidenceQuote:'Day 13 测试记录与 README 整理、必要 Git 提交。'}]}),e,{semanticReview:true});
  assert.equal(prose.failure,undefined);assert.equal(prose.diagnostics,undefined);
  const fake=verifyCitations(JSON.stringify({answer:'编号 HT-2026-B。',claims:[{text:'编号 HT-2026-B。',citations:['E1'],evidenceQuote:'Day 13 测试记录与 README 整理、必要 Git 提交。'}]}),e,{semanticReview:true});
  assert.equal(fake.valid,false);assert.equal(fake.diagnostics?.at(-1)?.rule,'protectedFacts');
});

test('下划线文件名与 Day 11–14 数字范围不被 protectedFacts 当伪造编码误杀（真实 WS001 附件总结场景）',()=>{
  const e=buildEvidence([{chunkId:11,unitId:11,archiveTitle:'财务合同',fileName:'AI_Office_Workspace_Work_Summary_Day10.docx',locator:'DOCX 第 20 段',text:'后续将按 Day 11 至 Day 14 推进验收与交接。'}]);
  const raw=JSON.stringify({answer:'附件为《AI_Office_Workspace_Work_Summary_Day10.docx》，含后续 Day 11–14 方向。',claims:[{text:'附件为《AI_Office_Workspace_Work_Summary_Day10.docx》，含后续 Day 11–14 方向。',citations:['E1'],evidenceQuote:'后续将按 Day 11 至 Day 14 推进验收与交接。'}]});
  const result=verifyCitations(raw,e,{semanticReview:true});
  assert.equal(result.failure,undefined,result.diagnostics?JSON.stringify(result.diagnostics):'');assert.equal(result.diagnostics,undefined);
});

test('诊断：protectedFacts 被拒时输出规则名、claim 序号与缺失数字',()=>{
  const result=verify(answer([claim('金额为 99 万元。','整理日期 2026-10-21，项目根目录 D:\\Projects\\ai-office-workspace。编号 WS001-CW01-2026-000001。')]));
  assert.equal(result.valid,false);
  const issue=result.diagnostics?.at(-1);
  assert.equal(issue?.rule,'protectedFacts');assert.equal(issue?.claimIndex,0);
  assert.deepEqual(issue?.missingNumbers,['99万元']);
  assert.match(issue?.sourceSnippet ?? '',/2026-10-21/);assert.match(issue?.claimSnippet ?? '',/99 万元/);
});

test('诊断：摘录是逐字子句但不是完整句子时按 completeQuote 规则报告',()=>{
  const result=verify(answer([claim('Day 10 完成开发与测试。','Day 10 开发与测',['E2'])]));
  assert.equal(result.valid,false);
  const issue=result.diagnostics?.at(-1);
  assert.equal(issue?.rule,'completeQuote');assert.equal(issue?.ref,'E2');assert.equal(issue?.claimIndex,0);
});

test('诊断：摘录不在原文内时按 evidenceQuote 规则报告',()=>{
  const result=verify(answer([claim('Day 10 完成开发与测试。','Day 10 开发与测试验收。')]));
  assert.equal(result.valid,false);
  const issue=result.diagnostics?.at(-1);
  assert.equal(issue?.rule,'evidenceQuote');assert.equal(issue?.ref,'E1');assert.match(issue?.sourceSnippet ?? '',/整理日期/);
});

test('answer 与 claims 不一致不再触发任何本地拒绝（answer 字段被忽略，claims 才是事实来源）',()=>{
  const raw=JSON.stringify({answer:'概述：完成开发与测试。另外支付99万元。',claims:[claim('Day 10 完成开发与测试。','AI OFFICE WORKSPACE Web 全栈项目工作总结：Day 10 开发与测试，共 23 个分块。',['E2'])]});
  const result=verify(raw);
  assert.equal(result.failure,undefined);assert.equal(result.diagnostics,undefined);
  assert.match(result.cleaned??'',/Day 10 完成开发与测试/);assert.doesNotMatch(result.cleaned??'',/99/);
});

test('诊断经 generateGroundedAnswer 透传到 answerGeneration.validationIssues',async()=>{
  const content=answer([claim('金额为 99 万元。','整理日期 2026-10-21，项目根目录 D:\\Projects\\ai-office-workspace。编号 WS001-CW01-2026-000001。')]);
  const model={available:true,model:'mock',calls:0,async chatCompletion(){
    this.calls++;return {content,truncated:false};
  }};
  const result=await generateGroundedAnswer(model,'总结一下',evidence);
  assert.equal(result.state.failure,'fact_mismatch');
  const issues=result.state.validationIssues ?? [];
  assert.ok(issues.length);
  assert.equal(issues.at(-1)?.rule,'protectedFacts');assert.deepEqual(issues.at(-1)?.missingNumbers,['99万元']);
});
