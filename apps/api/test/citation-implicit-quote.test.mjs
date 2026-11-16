/**
 * 分层总结（多附件）隐式引用回归：completeQuote 不得误杀跨句合并的忠实摘要。
 * 背景：多附件总结走 map-reduce 路径，提示词要求「省略 evidenceQuote，仅保留 text、citations」，
 * 服务端把 quote 兜底填成整段原文后，旧的逐句全等校验会把合并两句（。→ ；）的结论硬拒为
 * fact_mismatch（WS001-CG01-2026-000002 三份附件总结失败案例，日志 rule:"completeQuote"）。
 * 修复后隐式引用应转入 requiresSemantic，由独立复核员判定；显式引用的逐句校验保持不变。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCitations,buildSummaryEvidence} from '../dist/agent/content.evidence.js';
import {generateGroundedAnswer} from '../dist/agent/answer.generation.js';

const row=(fileId,chunkId,text)=>({chunkId,unitId:chunkId,archiveId:fileId,fileId,
  archiveTitle:'项目建设',archiveNo:'WS001-CG01-2026-000002',
  fileName:`附件0${fileId}_项目建设相关文件.docx`,locator:`DOCX 第 ${chunkId} 段`,text});
// 真实失败案例的原文：E1 含两个句子，模型合并为一条结论并把「。」改成「；」
const scopeText='项目范围包括 Web 前端、Node.js API 服务、SQLite 数据库、DeepSeek 模型接口及自动化测试。第一期不建设多 Agent 协作、知识图谱、Elasticsearch 或独立向量数据库。';
const mergedClaim='项目范围包括 Web 前端、Node.js API 服务、SQLite 数据库、DeepSeek 模型接口及自动化测试；第一期不建设多 Agent 协作、知识图谱、Elasticsearch 或独立向量数据库。';
const pad='项目建设实施方案的补充说明内容。'.repeat(17); // ≈459 字，保证多批次触发分层总结

/** 分层总结提示词下的模型输出形态：仅 text + citations，无 evidenceQuote（隐式引用）。 */
const sectionJson=(text,citations)=>JSON.stringify({answer:text,claims:[{text,citations}]});

test('隐式引用（省略 evidenceQuote）的合并两句结论不再被 completeQuote 硬拒，转入语义复核',()=>{
  const {items}=buildSummaryEvidence([row(1,1,scopeText),row(1,2,pad)]);
  const result=verifyCitations(sectionJson(mergedClaim,['E1']),items,{semanticReview:true});
  assert.equal(result.failure,undefined,result.diagnostics?JSON.stringify(result.diagnostics):'');
  assert.equal(result.valid,false); // 语义复核批准前不得直接放行
  assert.equal(result.requiresSemantic,true);
  assert.equal(result.diagnostics,undefined);
  assert.match(result.cleaned,/第一期不建设多 Agent 协作/);
});

test('多附件分层总结端到端：三文件 17 块触发 map-reduce，合并改写经复核后成功生成',async()=>{
  const rows=[row(1,1,scopeText)];
  for(let i=2;i<=17;i++)rows.push(row(i<=12?1:i<=15?2:3,i,pad));
  const {items}=buildSummaryEvidence(rows);
  assert.ok(items.length>16,'需超过 16 条以触发分层总结路径');
  const model={available:true,model:'mock',contextWindowTokens:8192,calls:0,async chatCompletion(messages){
    this.calls++;
    const system=messages[0].content;
    if(system.startsWith('GROUNDING_REVIEW_V1'))return {content:'{"supported":true}',truncated:false};
    // 章节提炼：引用本批实际存在的编号（从用户消息里的 [E n] 标记取首个）
    if(system.includes('章节提炼阶段')){
      const ref=/\[(E\d+)\]/u.exec(messages[1].content)?.[1] ?? 'E1';
      return {content:sectionJson('本章为项目建设相关工作的忠实摘要。',[ref]),truncated:false};
    }
    // 合并阶段：跨句合并（。→ ；）且引用原始编号，正是旧规则误杀的形状
    return {content:sectionJson(mergedClaim,['E1']),truncated:false};
  }};
  const result=await generateGroundedAnswer(model,'你给我总结一下这三份附件的主要内容',items);
  assert.equal(result.state.status,'success',result.state.failure);
  assert.equal(result.state.citations,'passed');
  assert.equal(result.state.processedEvidenceCount,17,'所有分块都必须被处理');
  assert.ok(model.calls>3,'应确实走了分批 + 合并 + 复核的多调用路径');
});

test('显式 evidenceQuote 仍执行逐句全等校验（放宽只针对隐式引用）',()=>{
  const {items}=buildSummaryEvidence([row(1,1,scopeText)]);
  const raw=JSON.stringify({answer:'项目范围覆盖前端与后端。',claims:[{
    text:'项目范围包括 Web 前端与后端服务。',citations:['E1'],evidenceQuote:'项目范围包括 Web 前端、Node.js API 服务'}]});
  const result=verifyCitations(raw,items,{semanticReview:true});
  assert.equal(result.valid,false);assert.equal(result.failure,'fact_mismatch');
  assert.equal(result.diagnostics?.at(-1)?.rule,'completeQuote');
});
