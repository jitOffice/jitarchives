import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import {bootstrap} from '../dist/main.js';
import {DATABASE} from '../dist/db/database.js';
import {emptyRetrievalPlan} from '../dist/agent/retrieval.plan.js';
import {ContentIndexService} from '../dist/archives/content/content-index.service.js';

test('真实长 DOCX 索引 → 分章节总结 → 合并 → 原文核验 → API 状态与来源',{timeout:90000},async t=>{
 const temp=mkdtempSync(path.join(tmpdir(),'jit-summary-'));
 const themes=[['功能设计','文档介绍了任务管理的功能设计。'],['索引维护','文档说明了搜索索引的维护工作。'],['权限审计','文档强调权限管理与操作追踪。'],['最终验收','文档最后安排了交付验收工作。']];
 const model={available:true,provider:'mock-deepseek',model:'mock',mode:'ok',calls:[],async chatCompletion(messages){
  if(messages[0].content.startsWith('RETRIEVAL_PLAN_V1')){ const {originalQuestion,normalizedQuestion,...plan}=this.plan; return {content:JSON.stringify(plan),truncated:false}; }
  if(messages[0].content.startsWith('EVIDENCE_SUFFICIENCY_V1'))return {content:'{"verdict":"sufficient","note":"fixture complete","supplement":[]}',truncated:false};
  this.calls.push(messages);
  if(this.mode==='length')return {content:'{"answer":',finishReason:'length',truncated:true};
  if(this.mode==='empty')return {content:'',truncated:false};
  if(this.mode==='timeout')throw new Error('timeout');
  if(messages[0].content.startsWith('GROUNDING_REVIEW_V1')){
   const {checks,evidence}=JSON.parse(messages[1].content);
   const supported=checks.every(({claim,citations})=>themes.some(([term,text])=>text===claim&&citations.every(ref=>evidence.find(e=>e.ref===ref)?.source.includes(term))));
   return {content:JSON.stringify({supported}),truncated:false};
  }
  let claims;
  const body=messages.at(-1).content;
  if(body.includes('已核验的章节摘要：')){
   const summaries=JSON.parse(body.split('已核验的章节摘要：')[1]);
   claims=[...new Map(summaries.map(c=>[c.text,c])).values()];
  }else{
   const evidence=[...body.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
   claims=themes.flatMap(([term,text])=>{const hit=evidence.find(e=>e[2].includes(term));return hit?[{text,citations:[hit[1]]}]:[];});
  }
  if(this.mode==='unknown')claims=[{text:'这是虚假的结论。',citations:['E999']}];
  return {content:JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims}),truncated:false};
 }};
 let app,db;
 try{
  const server=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:false,knowledgeWorker:false,aiModelClient:model,
   embeddingClient:{available:false,modelKey:'disabled',async embed(){throw new Error('no network');}}});
  app=server.app;db=app.get(DATABASE);let cookie='';
  const call=async(url,body,raw=false)=>{const r=await fetch(server.baseUrl+'/api'+url,{method:'POST',headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},body:raw?body:JSON.stringify(body)});cookie=r.headers.get('set-cookie')?.match(/jit_sid=[^;]+/u)?.[0]??cookie;assert.equal(r.status,201);return r.json();};
  await call('/auth/init-admin',{username:'summary_admin',password:'Admin#12345',displayName:'总结测试'});
  const category=await call('/categories',{name:'总结专项',code:'SUMMARY'});
  const archive=await call('/archives',{title:'多章节实施记录',categoryId:category.id,archiveType:'文书档案'});
  const paragraphs=themes.flatMap(([term],chapter)=>Array.from({length:12},(_,i)=>`章节${chapter+1} 段落${i+1} ${term}。`+`${term}围绕项目实施开展工作，说明设计过程、处理方法和检查结果。`.repeat(12)));
  const zip=new PizZip();zip.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(text=>`<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  const file=await call(`/archive-files/upload?archiveId=${archive.id}&name=${encodeURIComponent('多章节实施.docx')}`,zip.generate({type:'nodebuffer'}),true);
  app.get(ContentIndexService).indexFileById(file.id);
  model.plan=emptyRetrievalPlan(''); model.plan.responseMode='summary';model.plan.allowExpansion=false;model.plan.hardConstraints.archiveNumbers=[archive.archiveNo];
  model.plan.planSteps=[{id:'read',tool:'content.read',intent:'完整读取当前附件',expects:'fullText',args:{}}];
  const ask=async()=>{model.calls=[];return (await call('/agent/ask',{question:`档号 ${archive.archiveNo} 的主要内容是什么？`})).reply;};
  await t.test('全文末章进入分层与最终总结，来源保留真实段落',async()=>{
   const reply=await ask();assert.equal(reply.payload.kind,'content_answer',JSON.stringify(reply));
   assert.ok(reply.payload.answerGeneration.sections>=3);assert.equal(reply.payload.answerGeneration.status,'success');assert.match(reply.content,/交付验收/);assert.ok(reply.content.length<1500);
   assert.ok(reply.payload.sources.every(s=>s.fileId===file.id&&s.archiveId===archive.id&&/DOCX/.test(s.locator)&&s.chunkId));
   assert.equal(reply.payload.trace.find(s=>s.id==='answer').status,'completed');assert.equal(reply.payload.modelCall.status,'success');
   const maps=model.calls.filter(m=>m[0].content.includes('章节提炼阶段'));assert.ok(maps.length>=3);assert.ok(maps.every(m=>m[1].content.length<11000));
   assert.ok(maps.some(m=>m[1].content.includes('最终验收')));assert.ok(model.calls.some(m=>m[0].content.includes('合并阶段')));
   assert.ok(model.calls.filter(m=>m[0].content.startsWith('GROUNDING_REVIEW_V1')).every(m=>JSON.parse(m[1].content).evidence.every(e=>e.source.includes('围绕项目实施'))));
  });
  await t.test('截断、空响应、超时、伪引用分类准确且降级正文不拼接原文',async()=>{
   for(const [mode,failure] of [['length','truncated'],['empty','empty_content'],['timeout','call_failed'],['unknown','unknown_citation']]){
    model.mode=mode;const reply=await ask();assert.equal(reply.payload.kind,'content_evidence');assert.equal(reply.payload.aiUsed,false);assert.equal(reply.payload.answerGeneration.failure,failure);
    assert.equal(reply.payload.trace.find(s=>s.id==='answer').status,'failed');
    assert.match(reply.content,/暂时无法根据现有证据形成可靠的完整回答/);
    assert.doesNotMatch(reply.content,/· 《|\[E\d+\]/u);
    assert.equal(reply.payload.sources.length,0,'未通过核验的片段不得冒充正式引用');
    assert.ok(reply.payload.retrievedEvidence.length>3,'完整检索证据仍保留在参考资料中');
    assert.ok(model.calls.length<3);assert.doesNotMatch(reply.content,/E999|这是虚假的结论/);
   }
  });
 }finally{if(app)await app.close();if(db)db.close();assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir())+path.sep));rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
