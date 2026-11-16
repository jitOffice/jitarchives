import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvidence,buildSummaryEvidence,verifyCitations,renderEvidenceFallback,EVIDENCE_FALLBACK_ANSWER} from '../dist/agent/content.evidence.js';
import {generateGroundedAnswer} from '../dist/agent/answer.generation.js';
import {sanitizeHistoricalContent,isUserReadableNote} from '../dist/agent/user.message.js';
import {RealAiModelClient} from '../dist/agent/ai-model.client.js';

const row=(text,id=1)=>({chunkId:id,unitId:id,fileId:1,archiveId:1,archiveNo:'QA-1',archiveTitle:'项目记录',fileName:'进展.docx',versionNo:null,locator:`DOCX 第 ${id} 段`,text});
const evidence=buildEvidence([row('Day 10 完成任务看板优化、搜索功能修复和数据库测试。'),row('系统采用权限控制保护档案，审计记录用于追踪操作。',2)]);
const answer=claims=>JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims});
function mock(content, supported=true){return {available:true,model:'mock-deepseek',calls:[],async chatCompletion(messages){
 this.calls.push(messages);
 if(messages[0].content.startsWith('GROUNDING_REVIEW_V1'))return {content:JSON.stringify({supported}),truncated:false};
 return {content:typeof content==='function'?content(messages):content,truncated:false};
}};}
test('合理自然语言归纳经过原文语义复核通过，未复核的候选不能直接通过',async()=>{
 const content=answer([{text:'项目第十天主要完善了任务管理、搜索体验及相关测试工作。',citations:['E1'],evidenceQuote:evidence[0].excerpt}]);
 const candidate=verifyCitations(content,evidence,{semanticReview:true});assert.equal(candidate.valid,false);assert.equal(candidate.requiresSemantic,true);
 const model=mock(content),result=await generateGroundedAnswer(model,'总结项目进展',evidence);
 assert.equal(result.state.status,'success');assert.equal(result.state.citations,'passed');assert.equal(model.calls.length,2);
 assert.match(model.calls[1][1].content,/Day 10/);assert.match(result.verified.cleaned,/完善了任务管理/);
});
test('跨章节结论保留多个原始引用，并用原始正文核验',async()=>{
 const content=answer([{text:'文档围绕功能完善与档案治理介绍了项目工作。',citations:['E1','E2'],evidenceQuotes:evidence.map(e=>({ref:e.ref,quote:e.excerpt}))}]);
 const result=await generateGroundedAnswer(mock(content),'归纳共同主题',evidence);
 assert.equal(result.state.status,'success');assert.equal(result.verified.citations.length,2);
});
test('真实但无关的引用必须经语义复核拒绝',async()=>{
 const model=mock(answer([{text:'项目已完成搜索体验优化。',citations:['E2'],evidenceQuote:evidence[1].excerpt}]),false);
 const result=await generateGroundedAnswer(model,'搜索功能进展',evidence);
 assert.equal(result.state.failure,'fact_mismatch');assert.equal(result.state.citations,'failed');assert.equal(result.state.modelResponse,'received');
});
test('不存在的证据编号独立报告，不进入语义复核',async()=>{
 const model=mock(answer([{text:'已完成测试。',citations:['E99'],evidenceQuote:evidence[0].excerpt}]));
  const result=await generateGroundedAnswer(model,'总结',evidence);assert.equal(result.state.failure,'unknown_citation');assert.equal(model.calls.length,2);
  assert.equal(result.state.retries,1);assert.doesNotMatch(model.calls[1][0].content,/unknown_citation|diagnostics/iu);
  assert.match(model.calls[1][0].content,/引用/);
  assert.ok(model.calls.every(messages=>!messages[0].content.startsWith('GROUNDING_REVIEW_V1')));
});
test('金额、日期、合同编号不能改变，主体、否定、条件和法律责任改写均必须核验',async()=>{
 const items=buildEvidence([row('甲方为甲公司。合同编号 HT-2026-A。金额为1.5万元。签署日期为2026年10月30日。验收合格后30日内付款。不得提前支付。乙方无需承担额外违约责任。')]);
 for(const text of ['金额为15万元。','签署日期为2027年10月30日。','合同编号 HT-2026-B。']){
  const result=await generateGroundedAnswer(mock(answer([{text,citations:['E1'],evidenceQuote:items[0].excerpt}])),'条款',items);
  assert.equal(result.state.failure,'fact_mismatch',text);
 }
 for(const text of ['甲方为乙公司。','可以提前支付。','30日内付款。','乙方必须承担额外违约责任。']){
  const result=await generateGroundedAnswer(mock(answer([{text,citations:['E1'],evidenceQuote:items[0].excerpt}]),false),'条款',items);
  assert.equal(result.state.failure,'fact_mismatch',text);
 }
});
test('识别 finish_reason=length，即使 JSON 完整也只重试一次',async()=>{
 const model=mock(answer([{text:evidence[0].excerpt,citations:['E1'],evidenceQuote:evidence[0].excerpt}]));
 let calls=0;model.chatCompletion=async()=>({content:answer([{text:evidence[0].excerpt,citations:['E1'],evidenceQuote:evidence[0].excerpt}]),finishReason:'length',truncated:false,calls:++calls});
 const result=await generateGroundedAnswer(model,'总结',evidence);assert.equal(calls,2);assert.equal(result.state.retries,1);assert.equal(result.state.failure,'truncated');assert.equal(result.verified,undefined);
});
test('格式损坏可恢复，截断重试后格式仍坏不会第三次调用',async()=>{
 let calls=0;const model=mock('');model.chatCompletion=async()=>({content:++calls===1?'{"answer":':answer([{text:evidence[0].excerpt,citations:['E1'],evidenceQuote:evidence[0].excerpt}]),truncated:false});
 assert.equal((await generateGroundedAnswer(model,'总结',evidence)).state.status,'success');assert.equal(calls,2);
 calls=0;model.chatCompletion=async()=>({content:'{',truncated:++calls===1});
 const failed=await generateGroundedAnswer(model,'总结',evidence);assert.equal(failed.state.failure,'invalid_json');assert.equal(calls,2);
});
test('调用失败、空内容、缺少引用和证据不足分别报告',async()=>{
 const broken=mock('');broken.chatCompletion=async()=>{throw new Error('network timeout');};
 const failure=await generateGroundedAnswer(broken,'总结',evidence);assert.equal(failure.state.failure,'call_failed');assert.equal(failure.state.calls,1);
 const empty=await generateGroundedAnswer(mock(''),'总结',evidence);assert.equal(empty.state.failure,'empty_content');assert.equal(empty.state.calls,2);
 assert.equal((await generateGroundedAnswer(mock('{"answer":"已完成","claims":[]}'),'总结',evidence)).state.failure,'missing_citations');
 assert.equal((await generateGroundedAnswer(mock('INSUFFICIENT_EVIDENCE'),'总结',evidence)).state.failure,'insufficient_evidence');
});
test('核验失败降级只返回固定说明，不把原文摘录拼进回答正文',()=>{
 const items=buildSummaryEvidence(Array.from({length:30},(_,i)=>({...row(`原文内容第${i}段。`,i+1),fileId:i%4+1}))).items;
 const fallback=renderEvidenceFallback(items,'模型失败');
 assert.equal(fallback,EVIDENCE_FALLBACK_ANSWER);
 assert.match(fallback,/暂时无法根据现有证据形成可靠的完整回答/);
 assert.doesNotMatch(fallback,/原文内容第|\[E\d+\]|覆盖说明|tfidf|toolResults/iu);
 assert.equal(items.length,30,'检索到的完整证据集合不能因降级文案而丢失');
});
test('历史消息中的内部诊断按已保存诊断与结构清理，不当作正常答案展示',()=>{
 const internal='证据充分性：sufficient。tfidf_cosine_aggregated / graph.relations';
 assert.equal(isUserReadableNote(internal),false);
 assert.equal(sanitizeHistoricalContent(`档案正文结论。\n${internal}\n覆盖说明：受检索规模上限影响。`,['覆盖说明：受检索规模上限影响。']),'档案正文结论。');
 assert.equal(sanitizeHistoricalContent(internal,[]),'');
});
test('完整性只要求明确点名或指定的附件，检索到的其他片段不强制全部引用',async()=>{
 const rows=Array.from({length:12},(_,i)=>({...row(`第${i+1}份附件正文。`,i+1),fileId:i+1,fileName:`附件${i+1}.txt`}));
 const items=buildSummaryEvidence(rows).items;
 const content=answer([{text:rows[0].text,citations:['E1'],evidenceQuote:rows[0].text}]);
 const normal=await generateGroundedAnswer(mock(content),'总结这些资料',items);
 assert.equal(normal.state.status,'success','只引用真正支撑结论的片段即可通过');
 const required=await generateGroundedAnswer(mock(content),'总结这些资料',items,[],{requiredFileIds:rows.map(r=>r.fileId)});
 assert.equal(required.state.failure,'incomplete_answer','用户明确指定的附件仍必须覆盖');
});
test('超预算附件保留全部原文用于分批总结，同一分块ID去重',()=>{
 const rows=Array.from({length:400},(_,i)=>row(`主题${i}。`+'记录内容。'.repeat(130),i+1));
 const result=buildSummaryEvidence([...rows,rows[0]]);
 assert.ok(result.items.some(e=>e.row.chunkId===400));
 assert.equal(result.items.length,400);
 assert.equal(result.items.map(e=>e.excerpt).join(''),rows.map(r=>r.text).join(''));
 assert.deepEqual(result.notes,[]);
 assert.deepEqual(result.selection.excluded,[{chunkId:1,fileId:1,reason:'duplicate_id'}]);
 assert.equal(new Set(result.items.map(e=>e.row.chunkId)).size,result.items.length);
});
test('large evidence sections run with bounded parallelism and defer semantic review to the final answer', async () => {
 const rows=Array.from({length:20},(_,i)=>({...row(`第${i+1}部分正文。`+'项目资料记录了合同履行、验收进度和付款安排。'.repeat(18),i+1),fileId:1,fileName:'大型项目报告.txt'}));
 const items=buildSummaryEvidence(rows).items;
 let active=0,maxActive=0,sectionCalls=0,groundingCalls=0;
 const model={available:true,model:'mock-parallel',async chatCompletion(messages){
  active++;maxActive=Math.max(maxActive,active);
  const section=messages[0].content.includes('章节提炼阶段');
  try {
   await new Promise(resolve=>setTimeout(resolve,25));
   if(messages[0].content.startsWith('GROUNDING_REVIEW_V1')) {
    groundingCalls++;
    return {content:'{"supported":true}',truncated:false};
   }
   if(section) {
    sectionCalls++;
    const evidenceLine=messages.at(-1).content.split('\n').find(line=>line.includes('] 来源：档案'));
    const ref=evidenceLine?evidenceLine.slice(1,evidenceLine.indexOf(']')):'E1';
    const quote=items.find(item=>item.ref===ref).excerpt;
    return {content:JSON.stringify({answer:'',claims:[{text:'本章节记录了项目相关工作。',citations:[ref],evidenceQuote:quote}]}),truncated:false};
   }
   const quote=items[0].excerpt;
   return {content:JSON.stringify({answer:'',claims:[{text:'项目资料记录了相关工作内容。',citations:['E1'],evidenceQuote:quote}]}),truncated:false};
  } finally {active--;}
 }};
 const result=await generateGroundedAnswer(model,'总结大型项目报告',items);
 assert.equal(result.state.status,'success',JSON.stringify(result.state));
 assert.equal(result.state.sections,sectionCalls,'every successfully completed section is counted');
 assert.ok(sectionCalls>=2,'large evidence should be split into multiple sections');
 assert.equal(result.state.processedEvidenceCount,20,'all original chunks must be processed');
 assert.equal(groundingCalls,1,'only the final user-facing answer needs semantic review against original evidence');
 assert.equal(maxActive,2,'independent section calls should overlap, but never exceed the concurrency cap');
 assert.ok(result.verified.valid);
 assert.ok(result.verified.citations.every(c=>items.some(item=>item.ref===c.ref)));
});

test('DeepSeek 适配器保留 finish_reason，空内容、响应 JSON 和网络失败类型不同',async()=>{
 const config=()=>({apiBase:'https://mock.invalid/v1',apiKey:'mock-key',model:'mock',timeoutMs:1000,temperature:0});
 for(const [payload,code] of [[{choices:[{finish_reason:'stop',message:{content:''}}]},'empty_content'],['{','invalid_json']]){
  const client=new RealAiModelClient(async()=>new Response(typeof payload==='string'?payload:JSON.stringify(payload)),config);
  await assert.rejects(()=>client.chatCompletion([]),error=>error.code===code);
 }
 const client=new RealAiModelClient(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{'}}]})),config);
 const result=await client.chatCompletion([]);assert.equal(result.finishReason,'length');assert.equal(result.truncated,true);
 const network=new RealAiModelClient(async()=>{throw new Error('network');},config);await assert.rejects(()=>network.chatCompletion([]),error=>error.code==='call_failed');
});
