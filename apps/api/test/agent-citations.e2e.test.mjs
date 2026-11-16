import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bootstrap} from '../dist/main.js';
import {DATABASE} from '../dist/db/database.js';
import {ContentIndexService} from '../dist/archives/content/content-index.service.js';
import {GraphBuildService} from '../dist/graph/graph.service.js';
import {GraphModule} from '../dist/graph/graph.module.js';
import {emptyRetrievalPlan} from '../dist/agent/retrieval.plan.js';
import {verifyCitations,buildEvidence} from '../dist/agent/content.evidence.js';
import {generateGroundedAnswer} from '../dist/agent/answer.generation.js';

const model={available:true,model:'citation-fixture',provider:'test',plan:null,mode:'mixed',calls:[],beforeAnswer:null,async chatCompletion(messages){
 const system=messages[0].content;
 if(system.startsWith('RETRIEVAL_PLAN_V1')){const {originalQuestion,normalizedQuestion,...plan}=this.plan;return {content:JSON.stringify(plan)};}
 if(system.startsWith('EVIDENCE_SUFFICIENCY_V1'))return {content:'{"verdict":"sufficient","note":"按真实结果核对","supplement":[]}'};
 if(system.startsWith('GROUNDING_REVIEW_V1'))return {content:'{"supported":true}'};
 this.calls.push(messages);
 if(this.beforeAnswer){const action=this.beforeAnswer;this.beforeAnswer=null;await action();}
 const text=messages.at(-1).content;
 const es=[...text.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)].slice(0,1).map(m=>({text:m[2],citations:[m[1]]}));
 const gs=[...text.matchAll(/^\[(G\d+)\] (.+)$/gmu)].slice(0,this.twoGraphs?2:1).map(m=>({text:m[2],citations:[this.mode==='forged'?'G999':m[1]]}));
 return {content:JSON.stringify({answer:'',claims:this.mode==='text'?es:this.mode==='graph'||this.mode==='forged'?gs:[...es,...gs]})};
}};
test('Agent E/G citations: real records, planning, history, and fail-closed authorization',{timeout:90000},async t=>{
 const temp=mkdtempSync(path.join(tmpdir(),'jit-citations-'));let app,db;
 try{
  const server=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:false,knowledgeWorker:false,aiModelClient:model});
  app=server.app;db=app.get(DATABASE);let admin='',borrower='';
  const req=async(url,body,cookie=admin,method='POST',raw=false)=>{
   const r=await fetch(server.baseUrl+'/api'+url,{method,headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},body:method==='GET'?undefined:raw?body:JSON.stringify(body??{})});
   return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[1]};
  };
  admin='jit_sid='+(await req('/auth/init-admin',{username:'citation_admin',password:'Admin#12345',displayName:'引用验收'})).cookie;
  assert.equal((await req('/users',{username:'citation_borrower',password:'User#12345',role:'borrower',displayName:'借阅者'})).status,201);
  borrower='jit_sid='+(await req('/auth/login',{username:'citation_borrower',password:'User#12345'})).cookie;
  const category=(await req('/categories',{name:'引用验收',code:'CITE'})).data;
  const tpl=(await req('/templates',{name:'等值著录',fields:[{fieldKey:'projectNo',label:'项目编号',type:'text'}]})).data;
  assert.equal((await req('/categories/'+category.id+'/template',{templateId:tpl.id},admin,'PUT')).status,200);
  const create=async(title,accessLevel='public',projectNo='CITE-2026-1')=>(await req('/archives',{title,categoryId:category.id,archiveType:'文书档案',accessLevel,fieldValues:{projectNo}})).data;
  const a=await create('公开采购甲'),b=await create('公开采购乙'),secret=await create('受限引用密卷','restricted'),isolated=await create('独立记录','public','OTHER-2');
  const upload=async(archive,name,text)=>{const r=await req('/archive-files/upload?archiveId='+archive.id+'&name='+encodeURIComponent(name),Buffer.from(text),admin,'POST',true);assert.equal(r.status,201);app.get(ContentIndexService).indexFileById(r.data.id);return r.data;};
  const body='设备采购付款约定：验收合格后30日内支付尾款。供货方应负责设备保修和安装调试，合同资料统一归档保存。';
  const file=await upload(a,'采购甲.txt',body);await upload(b,'采购乙.txt',body+'付款审批须留存。');await upload(secret,'受限正文.txt',body+'受限核定秘密9527。');await upload(isolated,'独立.txt','本周天气与会议室使用记录。');
  app.select(GraphModule).get(GraphBuildService).buildAll({options:{minChunkCharsForSimilarity:10,maxTermDocFrequencyRatio:1},syncContent:true});
  const plan=(archive,graph=true,content=true,structure=false)=>{
   const p=emptyRetrievalPlan('');p.responseMode='content_qa';p.allowExpansion=false;p.hardConstraints.archiveNumbers=[archive.archiveNo];
   p.planSteps=[{id:'locate',tool:'archive.search',intent:'定位真实档案',expects:'metadata',args:{}}];
   if(graph)p.planSteps.push({id:'graph',tool:'graph.relations',intent:'查询真实关系',expects:'metadata',args:structure?{includeStructure:true}:{},scope:'step:locate'});
   if(content)p.planSteps.push({id:'body',tool:'content.read',intent:'读取真实正文',expects:'fullText',args:{},scope:'step:locate'});
   model.plan=p;return p;
  };
  const ask=async(cookie=admin,extra={})=>{const r=await req('/agent/ask',{question:'请综合分析这些资料的联系并说明可以核对的依据',...extra},cookie);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
  let mixed,graphOnly;
  await t.test('自然语言规划调用图谱，E/G分别核验且只保存实际使用的关系',async()=>{
   plan(a);model.mode='mixed';mixed=await ask();const p=mixed.reply.payload;
   assert.equal(p.kind,'content_answer',JSON.stringify(p));assert.equal(p.sources.length,1);assert.equal(p.graphCitations.length,1);
   assert.match(mixed.reply.content,/\[E1\]/u);assert.match(mixed.reply.content,/\[G1\]/u);
   const c=p.graphCitations[0],row=db.prepare('SELECT * FROM kg_graph_edges WHERE id=?').get(c.edgeId);
   assert.equal(c.from.id,Number(row.from_node));assert.equal(c.to.id,Number(row.to_node));assert.equal(c.edge.from,c.from.key);assert.equal(c.edge.to,c.to.key);
   assert.equal(p.toolResults.find(r=>r.toolName==='graph.relations').data,null);
   assert.ok(model.calls.at(-1).at(-1).content.includes('[G1]'));
   const source=p.sources[0],original=await req('/knowledge/attachments/'+file.id+'/source/'+source.chunkId+'?archiveId='+a.id,undefined,admin,'GET');
   assert.equal(original.status,200);assert.ok(original.data.text.includes(source.excerpt));
   assert.ok(p.graphCitations.length<db.prepare('SELECT COUNT(*) AS n FROM kg_graph_edges').get().n);
   model.twoGraphs=true;try{plan(a,true,false);const two=await ask();assert.equal(two.reply.payload.graphCitations.length,2);
     for(const ref of ['G1','G2']){const edge=two.reply.payload.graphCitations.find(c=>c.ref===ref);assert.ok(edge);assert.ok(db.prepare('SELECT id FROM kg_graph_edges WHERE id=?').get(edge.edgeId));assert.ok(two.reply.content.includes('['+ref+']'));}
   }finally{model.twoGraphs=false;}

  });
  await t.test('G类事实必须经过独立语义复核，不能只凭真实边宣称业务结论',async()=>{
   const c=mixed.reply.payload.graphCitations[0];
   const raw=JSON.stringify({answer:'',claims:[{text:'两份档案已证实属于同一业务合同。',citations:[c.ref]}]});
   const candidate=verifyCitations(raw,[],{semanticReview:true,graphEvidence:[c]});assert.equal(candidate.valid,false);assert.equal(candidate.requiresSemantic,true);
   const reviewer={available:true,model:'reject',async chatCompletion(messages){return {content:messages[0].content.startsWith('GROUNDING_REVIEW_V1')?'{"supported":false}':raw};}};
   const rejected=await generateGroundedAnswer(reviewer,'能否证明业务关系',[],[],{graphEvidence:[c]});assert.equal(rejected.state.failure,'fact_mismatch');assert.equal(rejected.verified,undefined);
   assert.equal(verifyCitations(JSON.stringify({answer:'',claims:[{text:'伪造[G999]',citations:[c.ref]}]}),[],{semanticReview:true,graphEvidence:[c]}).failure,'unknown_citation');
  });
  await t.test('只有关系没有正文时，回答只使用G类且不伪造来源',async()=>{
   plan(a,true,false);model.mode='graph';graphOnly=await ask();const p=graphOnly.reply.payload;
   assert.equal(p.kind,'content_answer',JSON.stringify(p));assert.deepEqual(p.sources,[]);assert.equal(p.graphCitations.length,1);
   assert.match(graphOnly.reply.content,/\[G1\]/u);assert.doesNotMatch(graphOnly.reply.content,/\[E\d+\]/u);
  });
  await t.test('规划器可选择结构归属关系，档案和附件使用真实不同节点',async()=>{
   plan(a,true,false,true);model.mode='graph';const result=await ask();
   const c=result.reply.payload.graphCitations[0];assert.equal(result.reply.payload.kind,'content_answer',JSON.stringify(result.reply.payload));
   assert.equal(c.evidence.basis,'business_structure');assert.equal(c.from.type,'archive');assert.equal(c.to.type,'file');
   assert.equal(c.from.refId,a.id);assert.equal(c.to.refId,file.id);
  });
  await t.test('普通正文问答不强制调用图谱，未使用的图谱证据不保留',async()=>{
   plan(a,false);model.mode='text';const normal=await ask();assert.equal(normal.reply.payload.kind,'content_answer');
   assert.equal(normal.reply.payload.graphCitations?.length??0,0);assert.ok(!normal.reply.payload.toolResults.some(r=>r.toolName==='graph.relations'));
   plan(a,true);const unused=await ask();assert.equal(unused.reply.payload.graphCitations.length,0);
  });
  await t.test('不存在G编号和无关系的档案不会生成图谱卡片',async()=>{
   plan(a,true,false);model.mode='forged';const forged=await ask();assert.equal(forged.reply.payload.graphCitations.length,0);assert.equal(forged.reply.payload.answerGeneration.failure,'unknown_citation');
   plan(isolated,true,false);model.mode='graph';const absent=await ask();assert.equal(absent.reply.payload.graphCitations?.length??0,0);
  });
  await t.test('精确关系接口校验两端，拒绝伪造、倒换与受限关系',async()=>{
   const c=mixed.reply.payload.graphCitations[0];
   assert.equal((await req('/knowledge-graph/edges/'+c.edgeId+'?fromId='+c.from.id+'&toId='+c.to.id,undefined,admin,'GET')).status,200);
   assert.equal((await req('/knowledge-graph/edges/'+c.edgeId+'?fromId='+c.to.id+'&toId='+c.from.id,undefined,admin,'GET')).status,404);
   assert.equal((await req('/knowledge-graph/edges/999999',undefined,admin,'GET')).status,404);
   assert.equal((await req('/knowledge-graph/edges/'+c.edgeId+'?fromId=1.5&toId=1',undefined,admin,'GET')).status,400);
   const secretNode=db.prepare("SELECT id FROM kg_graph_nodes WHERE node_type='archive' AND ref_id=?").get(secret.id);
   const edge=db.prepare('SELECT id FROM kg_graph_edges WHERE from_node=? OR to_node=? LIMIT 1').get(secretNode.id,secretNode.id);
   assert.equal((await req('/knowledge-graph/edges/'+edge.id,undefined,borrower,'GET')).status,404);
  });
  await t.test('四种计算依据、支撑块和稳定节点标识均来自真实数据库',async()=>{
   for(const basis of ['business_structure','tfidf_cosine','tfidf_cosine_aggregated','metadata_exact_match']){
    const row=db.prepare('SELECT id FROM kg_graph_edges WHERE basis=? LIMIT 1').get(basis);assert.ok(row,basis);
    const r=await req('/knowledge-graph/edges/'+row.id,undefined,admin,'GET');assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.evidence.basis,basis);
    if(basis.startsWith('tfidf')){assert.ok(r.data.supportingNodes.some(n=>n.type==='chunk'));assert.ok(r.data.supportingNodes.some(n=>n.type==='file'));}
   }
  });
  await t.test('历史恢复E/G；旧版无graphCitations兼容；偷换历史端点被拒绝',async()=>{
   const history=await req('/agent/conversations/'+mixed.conversationId,undefined,admin,'GET');const reply=history.data.messages.find(m=>m.id===mixed.reply.id);
   assert.deepEqual(reply.payload.sources,mixed.reply.payload.sources);assert.equal(reply.payload.graphCitations[0].edgeId,mixed.reply.payload.graphCitations[0].edgeId);
   const stored=db.prepare('SELECT payload_json FROM agent_messages WHERE id=?').get(mixed.reply.id);
   const bad=JSON.parse(stored.payload_json);bad.graphCitations[0].to.refId=isolated.id;
   db.prepare('UPDATE agent_messages SET payload_json=? WHERE id=?').run(JSON.stringify(bad),mixed.reply.id);
   const denied=await req('/agent/conversations/'+mixed.conversationId,undefined,admin,'GET');const redacted=denied.data.messages.find(m=>m.id===mixed.reply.id);
   assert.equal(redacted.payload.kind,'error');assert.equal(redacted.payload.graphCitations,undefined);assert.doesNotMatch(redacted.content,/公开采购/u);
   const legacy=JSON.parse(stored.payload_json);delete legacy.graphCitations;db.prepare('UPDATE agent_messages SET payload_json=? WHERE id=?').run(JSON.stringify(legacy),mixed.reply.id);
   assert.equal((await req('/agent/conversations/'+mixed.conversationId,undefined,admin,'GET')).data.messages.find(m=>m.id===mixed.reply.id).payload.kind,'content_answer');
  });
  await t.test('借阅归还后，历史和重放即时移除名称、摘录、关系与来源',async()=>{
   const application=await req('/borrow-requests',{archiveId:secret.id,purpose:'引用核验',days:7},borrower);assert.equal(application.status,201);
   assert.equal((await req('/borrow-requests/'+application.data.id+'/approve',{note:'同意'},admin)).status,201);
   plan(secret,true);model.mode='mixed';const before=await ask(borrower,{clientRequestId:'citation-replay-1'});assert.equal(before.reply.payload.kind,'content_answer');
   assert.ok(before.reply.payload.graphCitations.length);assert.equal((await req('/borrow-requests/'+application.data.id+'/return',{},borrower)).status,201);
   const history=await req('/agent/conversations/'+before.conversationId,undefined,borrower,'GET');const after=history.data.messages.find(m=>m.id===before.reply.id);
   assert.equal(after.payload.kind,'error');assert.doesNotMatch(JSON.stringify(after),/受限引用密卷|受限核定秘密9527/u);
   const replay=await ask(borrower,{conversationId:before.conversationId,clientRequestId:'citation-replay-1'});assert.equal(replay.reply.payload.kind,'error');
  });
  await t.test('模型生成期间借阅归还，生成后的引用再次校验并拒绝',async()=>{
   const application=await req('/borrow-requests',{archiveId:secret.id,purpose:'并发撤权',days:7},borrower);assert.equal(application.status,201);
   await req('/borrow-requests/'+application.data.id+'/approve',{},admin);plan(secret,true);model.mode='mixed';
   model.beforeAnswer=async()=>assert.equal((await req('/borrow-requests/'+application.data.id+'/return',{},borrower)).status,201);
   const result=await ask(borrower);assert.equal(result.reply.payload.kind,'error');assert.doesNotMatch(JSON.stringify(result.reply),/受限引用密卷|受限核定秘密9527/u);
  });
  await t.test('原文摘录被篡改或关系被删除，历史引用失效',async()=>{
   const stored=db.prepare('SELECT payload_json FROM agent_messages WHERE id=?').get(mixed.reply.id),p=JSON.parse(stored.payload_json);p.sources[0].excerpt='不存在的编造摘录';
   db.prepare('UPDATE agent_messages SET payload_json=? WHERE id=?').run(JSON.stringify(p),mixed.reply.id);
   assert.equal((await req('/agent/conversations/'+mixed.conversationId,undefined,admin,'GET')).data.messages.find(m=>m.id===mixed.reply.id).payload.kind,'error');
   db.prepare('DELETE FROM kg_graph_edges WHERE id=?').run(graphOnly.reply.payload.graphCitations[0].edgeId);
   assert.equal((await req('/agent/conversations/'+graphOnly.conversationId,undefined,admin,'GET')).data.messages.find(m=>m.id===graphOnly.reply.id).payload.kind,'error');
  });
 }finally{if(app){await app.close();db.close();}assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(temp).startsWith('jit-citations-'));rmSync(temp,{recursive:true,force:true,maxRetries:3});}
});
