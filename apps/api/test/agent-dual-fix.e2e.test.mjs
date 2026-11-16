import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bootstrap} from '../dist/main.js';
import {DATABASE} from '../dist/db/database.js';
import {ContentIndexService} from '../dist/archives/content/content-index.service.js';
import {ContentIndexRepository} from '../dist/archives/content/content-index.repositories.js';
import {AgentToolRegistry} from '../dist/agent/tool.registry.js';
import {parseDeterministic} from '../dist/agent/intent.parser.js';
import {archiveStatus} from '../dist/agent/archive-status.js';
import {emptyRetrievalPlan,validateRetrievalPlan} from '../dist/agent/retrieval.plan.js';
import {selectEvidence,buildSummaryEvidence} from '../dist/agent/content.evidence.js';
import {generateGroundedAnswer} from '../dist/agent/answer.generation.js';
import {requestBudget} from '../dist/agent/token.budget.js';

const negatives=['未归档','没有归档','尚未归档','还没归档','还没有归档','还没有进行归档','尚未完成归档','没有完成归档','未进行归档','待归档','尚未正式归档'];
const positives=['已经归档','已归档','完成归档','正式归档','已正式归档'];
test('状态作用范围与模型计划使用同一规则，无明确状态不增加过滤',()=>{
 for(const state of negatives)assert.equal(archiveStatus('帮我查看'+state+'的档案'),'draft',state);
 for(const state of positives)assert.equal(archiveStatus('帮我查看'+state+'的档案'),'archived',state);
 for(const q of ['我有什么档案','没有未归档的档案吗','没有附件的已归档档案','尚未归档和已经归档的档案']){
  const expected=q==='没有附件的已归档档案'?'archived':undefined;
  assert.equal(archiveStatus(q),expected,q);
 }
 const {originalQuestion,normalizedQuestion,...wire}=emptyRetrievalPlan('');
 for(const q of ['我有什么档案还没有进行归档的','没有未归档的档案吗','我有什么档案']){
  assert.equal(validateRetrievalPlan({...wire,archiveStatus:'archived'},q).archiveStatus,archiveStatus(q)??null,q);
 }
});

const row=(i,text)=>({chunkId:i,unitId:1,archiveId:1,fileId:1,archiveNo:'FIX-2026-1',archiveTitle:'项目记录',
 fileName:'正文.txt',versionNo:2,versionId:2,pageNo:null,posFrom:i,posTo:i,locator:`TXT 第 ${i} 行`,text,score:24-i});
const fixtures=Array.from({length:23},(_,i)=>row(i+1,`第${i+1}章节。${i===20?'技术架构采用消息队列。':'独立业务章节记录。'}`+'设计与测试记录。'.repeat(40)));
test('23块普通问答动态预算选证、章节位置保留与整体概述无抽样',()=>{
 const selected=selectEvidence(fixtures,'技术架构采用什么',10000);
 assert.ok(selected.items.some(e=>e.row.chunkId===21));
 assert.ok(selected.items.length>3);
 assert.ok(selected.selection.excluded.every(e=>e.reason==='token_budget'));
 assert.equal(selected.selection.before,23);
 assert.equal(selected.selection.after+selected.selection.excluded.length,23);
 const all=buildSummaryEvidence([...fixtures,fixtures[0],{...fixtures[0],chunkId:24,locator:'TXT 第24行'}]);
 assert.equal(all.items.length,24,'独立章节相同文字不能被去重');
 for(const original of fixtures)assert.equal(all.items.find(e=>e.row.chunkId===original.chunkId).row.locator,original.locator);
 assert.deepEqual(all.selection.excluded,[{chunkId:1,fileId:1,reason:'duplicate_id'}]);
});

function mockModel(){
 return {available:true,provider:'mock-deepseek',model:'mock',calls:[],mode:'normal',async chatCompletion(messages,options){
  this.calls.push({messages:structuredClone(messages),options});
  if(messages[0].content.startsWith('RETRIEVAL_PLAN_V1')){
   const question=JSON.parse(messages[1].content).question;
   const {originalQuestion,normalizedQuestion,...plan}=emptyRetrievalPlan(question);
   plan.archiveTitleCandidates=['财务合同'];plan.allowExpansion=false;
   // 真实 DeepSeek 常把「主要内容/总结」问题标成 content_qa（而非 summary），并给出中文 contentTerms；
   // 中文 trigram FTS 命不中描述性短语会返回 0 条，用于复现「检索到 0 条正文」的生产现场。
   if(this.mode==='content_qa_summary'){plan.responseMode='content_qa';plan.contentTerms=['财务合同附件主要内容'];}
   return {content:JSON.stringify(plan),truncated:false};
  }
  if(this.mode==='timeout')throw new Error('mock timeout');
  if(this.mode==='truncated')return {content:'{',finishReason:'length',truncated:true};
  if(messages[0].content.startsWith('GROUNDING_REVIEW_V1')){
   const {checks,evidence}=JSON.parse(messages[1].content);
   const supported=checks.every(c=>c.citations.every(ref=>evidence.some(e=>e.ref===ref&&e.source.includes(c.claim.replace(/。$/u,'')))));
   return {content:JSON.stringify({supported}),finishReason:'stop',truncated:false};
  }
  let claims;
  const body=messages[1].content;
  if(body.includes('已核验的章节摘要：'))claims=JSON.parse(body.split('已核验的章节摘要：')[1]).slice(0,4);
  else claims=[...body.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)].slice(0,4).map(([,ref,source])=>{
   const quote=source.split('。')[0]+'。';
   return {text:quote,citations:[ref],evidenceQuote:quote};
  });
  if(this.mode==='repair'&&!messages[0].content.includes('上次回答核验失败'))claims=[{text:'不存在的结论。',citations:['E999']}];
  if(this.mode==='unrelated')claims=[{text:'乙方必须支付一百万元。',citations:[claims[0].citations[0]]}];
  return {content:JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims}),finishReason:'stop',truncated:false,usage:{inputTokens:100,outputTokens:50}};
 }};
}
test('分层请求逐个覆盖23块、预算、原始引用、修复后完整重验',async()=>{
 const model=mockModel(),items=buildSummaryEvidence(fixtures).items;
 const result=await generateGroundedAnswer(model,'概括整份附件',items);
 assert.equal(result.state.status,'success');
 assert.equal(result.state.evidenceCount,23);assert.equal(result.state.processedEvidenceCount,23);
 assert.ok(result.state.sections>1);
 for(const e of items)assert.ok(model.calls.some(c=>c.messages[1].content.includes(e.excerpt)),e.ref);
 for(const c of model.calls)assert.ok(requestBudget(c.messages,c.options.maxTokens,model).fits);
 assert.ok(result.verified.citations.every(e=>items.includes(e)));
 const small=mockModel();small.contextWindowTokens=6000;
 const limited=await generateGroundedAnswer(small,'概括整份附件',items);
 assert.equal(limited.state.status,'success');assert.equal(limited.state.processedEvidenceCount,23);
 for(const c of small.calls)assert.ok(requestBudget(c.messages,c.options.maxTokens,small).fits);
 const repair=mockModel();repair.mode='repair';
 const recovered=await generateGroundedAnswer(repair,'具体事实',items.slice(0,2));
 assert.equal(recovered.state.status,'success');assert.equal(recovered.state.retries,1);
 assert.equal(repair.calls.length,2);assert.doesNotMatch(repair.calls[1].messages[0].content,/unknown_citation|diagnostics/iu);
 assert.match(repair.calls[1].messages[0].content,/引用/u);
 for(const e of items.slice(0,2))assert.ok(repair.calls[1].messages[1].content.includes(e.excerpt));
 const wrong=mockModel();wrong.mode='unrelated';
 const failure=await generateGroundedAnswer(wrong,'责任',items.slice(0,2));
 assert.equal(failure.state.status,'failed');assert.equal(failure.state.citations,'failed');
 assert.equal(failure.state.retries,1);
 const empty=await generateGroundedAnswer(mockModel(),'内容',[]);
 assert.equal(empty.state.failure,'insufficient_evidence');assert.equal(empty.state.calls,0);
});

test('临时SQLite：真实查询/统计/23块全文/四轮会话/权限和索引异常',{timeout:90000},async t=>{
 const temp=mkdtempSync(path.join(tmpdir(),'jit-dual-fix-'));
 const model=mockModel();let app,db;
 try{
  const server=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:false,knowledgeWorker:false,aiModelClient:model,
   embeddingClient:{available:false,modelKey:'disabled',async embed(){throw Error('network disabled');}}});
  app=server.app;db=app.get(DATABASE);let cookie='';
  const api=async(url,body,raw=false,method='POST')=>{
   const r=await fetch(server.baseUrl+'/api'+url,{method,headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},
    body:method==='GET'?undefined:raw?body:JSON.stringify(body)});
   cookie=r.headers.get('set-cookie')?.match(/jit_sid=[^;]+/u)?.[0]??cookie;
   const data=await r.json();assert.ok([200,201].includes(r.status),JSON.stringify(data));return data;
  };
  await api('/auth/init-admin',{username:'dual_admin',password:'Admin#12345',displayName:'专项管理员'});
  const adminCookie=cookie,cat=await api('/categories',{name:'专项合同',code:'DUAL'});
  const create=title=>api('/archives',{title,categoryId:cat.id,archiveType:'文书档案'});
  const draft=await create('财务合同'),archived=await create('已归档合同'),secret=await create('保密草稿');
  db.prepare("UPDATE archives SET status='archived' WHERE id=?").run(archived.id);
  db.prepare("UPDATE archives SET access_level='restricted' WHERE id=?").run(secret.id);
  const file=await api(`/archive-files/upload?archiveId=${draft.id}&name=${encodeURIComponent('正文.txt')}`,Buffer.from('项目已完成工作。'),true);
  app.get(ContentIndexService).indexFileById(file.id);
  const repo=app.get(ContentIndexRepository),unit=repo.listUnitsOfFile(file.id)[0];
  repo.replaceUnit({...unit,chunks:fixtures.map((r,i)=>({chunkNo:i+1,text:r.text,locator:r.locator,unit:'line',pageNo:null,posFrom:i+1,posTo:i+1}))});
  const ask=async(question,conversationId)=>api('/agent/ask',{question,conversationId});
  await t.test('状态解析落到真实查询、列表、分类统计及分页总数',async()=>{
   for(const [question,status,total] of [
    ['我有什么档案还没有进行归档的','draft',2],['我有哪些未归档档案','draft',2],
    ['帮我找出尚未归档的合同','draft',2],['我有哪些已经归档的档案','archived',1],
    ['帮我查看正式归档的合同','archived',1],['我有什么档案',undefined,3],['没有未归档的档案吗',undefined,3]]){
    assert.equal(parseDeterministic({question,categories:[]}).intent.status,status);
    const reply=(await ask(question)).reply;
    assert.equal(reply.payload.retrievalPlan.archiveStatus,status??null);
    assert.equal(reply.payload.total,total);assert.equal(reply.payload.items.length,total);
    assert.equal(reply.payload.inventory.total,total);
    assert.equal(reply.payload.inventory.categories.reduce((n,c)=>n+c.count,0),total);
    assert.equal(reply.payload.inventory.statuses.draft+reply.payload.inventory.statuses.archived,total);
    if(status)assert.ok(reply.payload.items.every(a=>a.status===status));
   }
  });
  await t.test('财务合同→附件数量→这些附件概述→里面完成工作，保持同一目标',async()=>{
   const first=await ask('帮我找一下财务合同');
   assert.ok(first.reply.payload.items.some(a=>a.id===draft.id));
   const second=await ask('它有几个附件',first.conversation.id);
   assert.equal(second.reply.payload.unified.attachments.total,1);
   assert.equal(second.reply.payload.usedContext,true);
   for(const question of ['这些附件主要讲什么','他附件的内容主要是什么','里面完成了哪些工作']){
    model.calls=[];
    const reply=(await ask(question,first.conversation.id)).reply;
    assert.equal(reply.payload.kind,'content_answer',JSON.stringify(reply));
    assert.equal(reply.payload.usedContext,true);
    assert.equal(reply.payload.evidenceSelection.strategy,'whole_attachment');
    assert.equal(reply.payload.modelCall.evidenceCount,23);assert.equal(reply.payload.modelCall.modelEvidenceCount,23);
    assert.equal(reply.payload.answerGeneration.processedEvidenceCount,23);
    assert.ok(reply.payload.sources.every(s=>s.fileId===file.id&&s.archiveId===draft.id&&/^TXT 第/u.test(s.locator)));
    for(const fixture of fixtures)assert.ok(model.calls.some(c=>c.messages[1].content.includes(fixture.text)),fixture.locator);
   }
   model.mode='timeout';
   const failed=(await ask('这些附件主要讲什么',first.conversation.id)).reply;
    assert.equal(failed.payload.kind,'content_evidence');assert.equal(failed.payload.sources.length,0);
    assert.equal(failed.payload.retrievedEvidence.length,23);
    assert.doesNotMatch(failed.content,/· 《|\[E\d+\]/u);
    assert.equal(failed.payload.trace.find(s=>s.id==='answer').status,'failed');
   model.mode='normal';
  });
  await t.test('规划器将总结问题误标为content_qa且中文关键词FTS不命中时，仍回退顺序读取整篇',async()=>{
   model.mode='content_qa_summary';model.calls=[];
   const reply=(await ask('你告诉我财务合同里面的附件主要内容')).reply;
   assert.equal(reply.payload.kind,'content_answer',JSON.stringify(reply.payload.kind));
   assert.equal(reply.payload.evidenceSelection.strategy,'whole_attachment');
   assert.equal(reply.payload.modelCall.evidenceCount,23);assert.equal(reply.payload.modelCall.modelEvidenceCount,23);
   assert.ok(reply.payload.sources.every(s=>s.fileId===file.id&&s.archiveId===draft.id));
   model.mode='normal';
  });
  await t.test('不同角色统计继续与同权限档案API一致',async()=>{
   for(const role of ['cataloger','guest']){
    cookie=adminCookie;
    await api('/users',{username:'dual_'+role,password:'User#12345',displayName:role,role});
    cookie='';await api('/auth/login',{username:'dual_'+role,password:'User#12345'});
    for(const status of [undefined,'draft','archived']){
     const list=await api('/archives'+(status?'?status='+status:''),undefined,false,'GET');
     const question=status==='draft'?'我有哪些未归档档案':status==='archived'?'我有哪些已归档档案':'我有什么档案';
     const reply=(await ask(question)).reply;
     assert.equal(reply.payload.total,list.total);
     assert.equal(reply.payload.inventory.categories.reduce((n,c)=>n+c.count,0),list.total);
    }
   }
   cookie=adminCookie;
  });
  await t.test('索引缺块明确披露；当前版本不一致不返回旧正文',async()=>{
   db.prepare('UPDATE archive_content_units SET chunk_count=24 WHERE file_id=?').run(file.id);
   const registry=app.get(AgentToolRegistry);
   const read=await registry.execute('content.read',{archiveIds:[draft.id],fileIds:[file.id],summary:true},{id:1,role:'admin',status:'active'});
   assert.equal(read.data.items.length,23);assert.match(read.data.notes.join(''),/应读 24 段，实际读到 23 段/);
   db.prepare("UPDATE archive_content_units SET sha256='stale' WHERE file_id=?").run(file.id);
   const stale=await registry.execute('content.read',{archiveIds:[draft.id],fileIds:[file.id],summary:true},{id:1,role:'admin',status:'active'});
   assert.equal(stale.data.items.length,0);
  });
 }finally{if(app)await app.close();if(db)db.close();assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir())+path.sep));rmSync(temp,{recursive:true,force:true});}
});
