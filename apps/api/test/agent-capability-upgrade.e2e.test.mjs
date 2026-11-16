import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bootstrap} from '../dist/main.js';
import {DATABASE} from '../dist/db/database.js';
import {ContentIndexService} from '../dist/archives/content/content-index.service.js';
import {emptyRetrievalPlan, validateRetrievalPlan} from '../dist/agent/retrieval.plan.js';
import {buildSummaryEvidence,verifyCitations} from '../dist/agent/content.evidence.js';
import {generateGroundedAnswer} from '../dist/agent/answer.generation.js';

const wire = p => {const {originalQuestion,normalizedQuestion,...v}=p;return v;};
const step=(id,tool,args={},scope)=>({id,tool,args,intent:id,expects:tool==='content.read'?'fullText':tool==='attachment.search'?'attachmentNames':'metadata',...(scope?{scope:`step:${scope}`}:{})});

test('通用能力升级：真实临时 SQLite、HTTP、动态工具执行与证据核验', {timeout:90000}, async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'jit-capability-'));
  let plan=emptyRetrievalPlan(''),available=true,broken=false,invalid=false,answerCalls=0,embeddingCalls=0;
  const model={get available(){return available;},provider:'mock',model:'mechanism-only',async chatCompletion(messages){
    const system=messages[0].content;
    if(broken)throw Error('provider unavailable');
    if(system.startsWith('RETRIEVAL_PLAN_V1'))return {content:invalid?'{}':JSON.stringify(wire(plan)),truncated:false};
    if(system.startsWith('EVIDENCE_SUFFICIENCY_V1'))return {content:'{"verdict":"sufficient","note":"测试取证","supplement":[]}',truncated:false};
    if(system.startsWith('GROUNDING_REVIEW_V1'))return {content:'{"supported":true}',truncated:false};
    answerCalls++;
    const items=[...messages[1].content.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
    const claims=items.map(([,ref,text])=>({text,citations:[ref],evidenceQuote:text}));
    if(/问题：对比/u.test(messages[1].content)) claims.push({text:'两组记录分别为：'+items.map(([,ref,text])=>text).join('；'),citations:items.map(([,ref])=>ref)});
    return {content:JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims}),truncated:false};
  }};
  const server=await bootstrap({port:0,dbFile:path.join(dir,'test.db'),fileStoreDir:path.join(dir,'files'),serveWeb:false,knowledgeWorker:false,aiModelClient:model,
    embeddingClient:{available:false,modelKey:'disabled',async embed(){embeddingCalls++;throw Error('Embedding forbidden');}}});
  const app=server.app,db=app.get(DATABASE);
  const api=async(url,cookie='',body,raw=false)=>{
    const r=await fetch(server.baseUrl+'/api'+url,{method:'POST',headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},body:raw?Buffer.from(body):JSON.stringify(body??{})});
    const data=await r.json();assert.equal(r.status,201,JSON.stringify(data));return {data,cookie:r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[0]??cookie};
  };
  try {
    const admin=(await api('/auth/init-admin','',{username:'cap_admin',password:'Admin#12345',displayName:'能力测试'})).cookie;
    await api('/users',admin,{username:'cap_reader',password:'User#12345',displayName:'读者',role:'borrower'});
    const reader=(await api('/auth/login','',{username:'cap_reader',password:'User#12345'})).cookie;
    const category=(await api('/categories',admin,{name:'工程资料',code:'ENG'})).data;
    const create=async(title,extra={})=>(await api('/archives',admin,{title,categoryId:category.id,archiveType:'文书档案',...extra})).data;
    const a=await create('星河建设'), b=await create('星河验收'), secret=await create('隔离资料',{accessLevel:'restricted'}),empty=await create('空档案');
    const upload=async(archive,name,text,index=true)=>{const f=(await api(`/archive-files/upload?archiveId=${archive.id}&name=${encodeURIComponent(name)}`,admin,text,true)).data;if(index)app.get(ContentIndexService).indexFileById(f.id);return f;};
    const f1=await upload(a,'Alpha_Progress_Day7.txt','开发进度：接口已完成。自动化测试通过12项。权限联调仍未完成。');
    const f2=await upload(b,'Beta_Progress.txt','开发进度：接口已完成。自动化测试通过15项。权限联调已经完成。');
    const pending=await upload(a,'尚未解析.txt','等待解析的资料。',false);
    const hidden=await upload(secret,'隔离报告.txt','机密标识 752964。');
    await upload(b,'Alpha_Progress_Day7.txt','同名附件属于另一档案，不能混淆。');
    db.prepare('UPDATE archives SET status=? WHERE id=?').run('archived',b.id);
    const ask=async(question,conversationId,cookie=admin)=>(await api('/agent/ask',cookie,{question,conversationId})).data;
    const reset=(mode='find')=>{plan=emptyRetrievalPlan('');plan.responseMode=mode;plan.allowExpansion=false;plan.planSteps=[];};

    await t.test('状态与空关键词清单的多种问法返回真实行数',async()=>{
      for(const q of ['有归档的档案吗？','目前有哪些已经归档的档案？','有哪些草稿档案？','告诉我状态是草稿的档案。','帮我找出所有未归档的档案。','我的档案有哪些？']){
        const r=await ask(q);const expected=/未归档|草稿/u.test(q)?3:/归档/u.test(q)?1:4;
        assert.equal(r.reply.payload.total,expected,q);assert.equal(r.reply.payload.conditions.keyword,undefined);
        assert.ok(r.reply.payload.items.every(x=>expected===4 || x.status===(expected===1?'archived':'draft')));
      }
    });
    await t.test('完整文件名规范化精确定位，反向关联及其他附件均来自真实行',async()=>{
      reset();plan.hardConstraints.archiveTitles=[a.title];plan.planSteps=[step('locate','attachment.search',{attachmentFileName:'Alpha Progress Day7.TXT'}),step('owner','archive.detail',{},'locate'),step('siblings','attachment.search',{},'locate')];
      const r=await ask('定位《Alpha Progress Day7.TXT》，限定档案星河建设，它属于哪份档案，还有哪些附件？');
      const results=r.reply.payload.toolResults;
      assert.deepEqual(results.find(x=>x.callId==='locate').data.items.map(x=>x.fileId),[f1.id]);
      assert.equal(results.find(x=>x.callId==='owner').data.items[0].id,a.id);
      assert.deepEqual(new Set(results.find(x=>x.callId==='siblings').data.items.map(x=>x.fileId)),new Set([f1.id,pending.id]));
      assert.equal(r.reply.payload.attachmentInventory.attachments,2);
      assert.equal(r.reply.payload.attachmentInventory.parsed,1);assert.equal(r.reply.payload.attachmentInventory.indexed,1);
    });
    await t.test('指定档案附件计数不受正文未解析影响；空档案不等于查无档案',async()=>{
      for(const archive of [a,empty]){
        reset();plan.hardConstraints.archiveTitles=[archive.title];plan.planSteps=[step('owner','archive.search',{title:archive.title}),step('files','attachment.search',{},'owner')];
        const r=await ask(`帮我核对${archive.title}这一档案的附件有几份？`);
        assert.equal(r.reply.payload.attachmentInventory.archives,1);
        assert.equal(r.reply.payload.attachmentInventory.attachments,archive===a?2:0);
      }
    });
    let conversation;
    await t.test('上一轮空检索不限制本轮明确文件名，即使规划器错误沿用 context',async()=>{
      reset();plan.hardConstraints.attachmentNames=['不存在.txt'];plan.planSteps=[step('files','attachment.search',{attachmentFileName:'不存在.txt'})];
      const first=await ask('找《不存在.txt》');conversation=first.conversation.id;
      reset();plan.contentScope='previous_results';plan.searchScope={kind:'context'};plan.planSteps=[{...step('files','attachment.search',{attachmentFileName:'Beta_Progress.txt'}),contextRef:{entity:'attachment',slot:1}}];
      const r=await ask('查找《Beta_Progress.txt》',conversation);
      assert.ok(r.reply.payload.retrievedAttachments.some(x=>x.fileId===f2.id));assert.equal(r.reply.payload.retrievalPlan.searchScope.kind,'allAuthorized');
    });
    await t.test('连续追问使用本会话服务端真实附件槽位',async()=>{
      reset('summary');plan.contentScope='previous_results';plan.searchScope={kind:'context'};plan.planSteps=[{...step('read','content.read'),contextRef:{entity:'attachment',slot:1}}];
      const r=await ask('总结刚才这份文件的正文',conversation);
      assert.equal(r.reply.payload.kind,'content_answer');assert.ok(r.reply.payload.sources.every(x=>x.fileId===f2.id));
    });
    await t.test('两个指定附件分别定位取证，绝不取同档案其他文件代替',async()=>{
      reset('compare');plan.hardConstraints.archiveTitles=[];plan.planSteps=[step('a','attachment.search',{attachmentFileName:'Alpha Progress Day7.txt'}),step('b','attachment.search',{attachmentFileName:'Beta Progress.txt'}),step('read-a','content.read',{},'a'),step('read-b','content.read',{},'b')];
      const r=await ask('对比《Alpha Progress Day7.txt》和《Beta Progress.txt》的开发进度、测试和未完成事项');
      assert.equal(r.reply.payload.kind,'content_answer');const ids=new Set(r.reply.payload.sources.map(s=>s.fileId));assert.ok(ids.has(f1.id)&&ids.has(f2.id));assert.ok(!ids.has(pending.id));
      assert.ok(r.reply.payload.toolResults.find(x=>x.callId==='read-b').data.items.every(x=>x.fileId===f2.id));
    });
    await t.test('缺少指定比较文件时点名报告缺失，不调用作答模型',async()=>{
      reset('compare');plan.planSteps=[step('a','attachment.search',{attachmentFileName:'Beta_Progress.txt'}),step('read','content.read',{},'a')];
      const before=answerCalls,r=await ask('比较《Beta_Progress.txt》和《Missing_Report.txt》的差异');
      assert.equal(r.reply.payload.kind,'content_no_evidence');assert.match(r.reply.content,/Missing_Report\.txt/);assert.equal(answerCalls,before);assert.equal(r.reply.payload.coverage.comparisonMissingSide,true);
    });
    await t.test('附件存在但未解析时不能宣称完成双文档比较',async()=>{
      reset('compare');plan.planSteps=[step('a','attachment.search',{attachmentFileName:'尚未解析.txt'}),step('b','attachment.search',{attachmentFileName:'Beta_Progress.txt'}),step('ra','content.read',{},'a'),step('rb','content.read',{},'b')];
      const before=answerCalls,r=await ask('对比《尚未解析.txt》和《Beta_Progress.txt》的正文差异');
      assert.equal(r.reply.payload.kind,'content_no_evidence');assert.match(r.reply.content,/尚未解析\.txt/);assert.equal(answerCalls,before);assert.equal(r.reply.payload.coverage.comparisonMissingSide,true);
    });
    await t.test('风险分析分步查建设和验收，再各自读取相关附件',async()=>{
      reset('summary');plan.businessEntities=['星河'];plan.planSteps=[step('construction','archive.search',{keyword:'星河建设'}),step('acceptance','archive.search',{keyword:'星河验收'}),step('read-c','content.read',{},'construction'),step('read-t','content.read',{},'acceptance')];
      const r=await ask('全面分析星河项目的建设资料和验收资料，按严重程度列出风险、证据、影响、整改建议及处理状态');
      const rs=r.reply.payload.toolResults;assert.ok(rs.find(x=>x.callId==='read-c').data.items.some(x=>x.fileId===f1.id));assert.ok(rs.find(x=>x.callId==='read-t').data.items.some(x=>x.fileId===f2.id));assert.equal(r.reply.payload.coverage.indexIncomplete,1);
      assert.match(r.reply.content,/未完成索引|尚无完整/u);
    });
    await t.test('无权档案附件和正文不会进入返回值',async()=>{
      reset('summary');plan.planSteps=[step('find','attachment.search',{attachmentFileName:'隔离报告.txt'}),step('read','content.read',{},'find')];
      const r=await ask('分析《隔离报告.txt》',undefined,reader);assert.doesNotMatch(JSON.stringify(r),/752964/);assert.ok(!r.reply.payload.sources?.some(x=>x.fileId===hidden.id));
    });
    await t.test('模型不可用和格式错误分开报告，简单查询仍安全执行',async()=>{
      available=false;let r=await ask('有哪些草稿档案？');assert.equal(r.reply.payload.total,3);
      r=await ask('全面分析工程项目并给出风险排序');assert.match(r.reply.content,/模型服务/);assert.equal(r.reply.payload.aiUsed,false);
      available=true;invalid=true;r=await ask('全面分析工程项目并给出风险排序');assert.match(r.reply.content,/计划未通过校验/);invalid=false;
      broken=true;r=await ask('全面分析工程项目并给出风险排序');assert.match(r.reply.content,/调用失败/);broken=false;
    });
    await t.test('FTS5 失效时 LIKE 降级仍返回实际授权正文',async()=>{
      db.exec('DROP TABLE archive_content_fts_bigram');
      reset('content_qa');plan.planSteps=[{...step('text','content.search',{query:'自动化测试'}),expects:'relevantText'}];
      const r=await ask('核对自动化测试的记录');const result=r.reply.payload.toolResults.find(x=>x.callId==='text');
      assert.equal(result.status,'success');assert.ok(result.data.items.length>0);assert.equal(result.data.retrievalMode,'like');
      assert.ok(r.reply.payload.sources.some(x=>x.fileId===f1.id));
    });
    assert.equal(embeddingCalls,0);
  } finally {await app.close();db.close();}
});

test('风险任务完成度与事实核验独立：原文摘录不能冒充风险分析',async()=>{
  const items=buildSummaryEvidence([{chunkId:1,unitId:1,archiveId:1,fileId:1,archiveTitle:'测试',archiveNo:'T-2026-001',fileName:'测试.txt',versionNo:null,locator:'第1段',text:'长文档摘要偶发遗漏，尚未修复。'}]).items;
  let structured=false;
  const model={available:true,model:'mechanism-only',async chatCompletion(messages){
    if(messages[0].content.startsWith('GROUNDING_REVIEW_V1'))return {content:'{"supported":true}',truncated:false};
    return {content:JSON.stringify({answer:'',claims:[structured?{kind:'risk',text:'风险：摘要遗漏；等级：高（分析）；表现：长文档摘要偶发遗漏；影响（分析）：可能丢失重要信息；建议：增加章节覆盖检查；状态：未关闭。',citations:['E1']}:{text:items[0].excerpt,citations:['E1'],evidenceQuote:items[0].excerpt}]}),truncated:false};
  }};
  assert.equal((await generateGroundedAnswer(model,'分析风险',items,[],{requireRiskAnalysis:true})).state.failure,'incomplete_answer');
  structured=true;assert.equal((await generateGroundedAnswer(model,'分析风险',items,[],{requireRiskAnalysis:true})).state.status,'success');
  const risk=level=>({kind:'risk',text:`风险：摘要遗漏；等级：${level}（分析）；表现：长文档摘要偶发遗漏；影响（分析）：可能丢失重要信息；建议：增加章节覆盖检查；状态：未关闭。`,citations:['E1']});
  const prior=model.chatCompletion;
  model.chatCompletion=async messages=>messages[0].content.startsWith('GROUNDING_REVIEW_V1')?prior(messages):{content:JSON.stringify({answer:'',claims:[risk('中'),risk('高')]}),truncated:false};
  const ranked=await generateGroundedAnswer(model,'分析风险',items,[],{requireRiskAnalysis:true});assert.equal(ranked.state.status,'success');assert.match(ranked.verified.claims[0].text,/等级：高/);
});

test('否定核验按主体及条款执行，不误杀同段另一主体的肯定条款',()=>{
  const text='甲方应当付款。乙方无需承担额外责任。';
  const items=buildSummaryEvidence([{chunkId:1,unitId:1,archiveId:1,fileId:1,fileName:'条款.txt',archiveTitle:'条款',archiveNo:'T-2026-001',versionNo:null,locator:'第1段',text}]).items;
  const result=verifyCitations(JSON.stringify({answer:'',claims:[{text:'甲方应当付款。',citations:['E1'],evidenceQuote:text}]}),items,{semanticReview:true});
  assert.equal(result.valid,true);
});

test('整句不能藏入步骤参数，核心规划字段不能省略',()=>{
  const question='帮我全面分析当前工程项目中所有尚未解决的问题及其风险';
  const p=emptyRetrievalPlan(question);p.planSteps=[step('bad','archive.search',{keyword:question})];
  assert.throws(()=>validateRetrievalPlan(wire(p),question),/Question is not a search term/);
  const raw=wire(p);delete raw.contentScope;assert.throws(()=>validateRetrievalPlan(raw,question),/Missing core/);
});

test('跨句引用经过原文核验，失败后有限重生成并再次核验，所有文件须覆盖',async()=>{
  const rows=[{chunkId:1,unitId:1,archiveId:1,fileId:1,archiveTitle:'建设',archiveNo:'A-2026-001',fileName:'建设.txt',versionNo:null,locator:'第1段',text:'接口开发已完成。自动化测试通过12项。验收尚未结束。'},
    {chunkId:2,unitId:2,archiveId:2,fileId:2,archiveTitle:'验收',archiveNo:'A-2026-002',fileName:'验收.txt',versionNo:null,locator:'第1段',text:'接口联调已完成。安全复测仍未关闭。'}];
  const items=buildSummaryEvidence(rows).items;
  const raw=JSON.stringify({answer:'',claims:[{text:'开发及测试已有结果。',citations:['E1'],evidenceQuote:'接口开发已完成。自动化测试通过12项。'}]});
  const verified=verifyCitations(raw,items,{semanticReview:true});assert.equal(verified.requiresSemantic,true);assert.equal(verified.failure,undefined);
  let attempts=0,reviews=0;
  const model={available:true,model:'mechanism',async chatCompletion(messages){
    if(messages[0].content.startsWith('GROUNDING_REVIEW_V1')){reviews++;return {content:'{"supported":true}',truncated:false};}
    attempts++;return {content:JSON.stringify({answer:'',claims:attempts===1?[{text:'测试通过999项。',citations:['E99']}]:[
      {text:'开发及测试已有结果，验收未结束。',citations:['E1']},{text:'联调完成但复测未关闭。',citations:['E2']}]}),truncated:false};
  }};
  const r=await generateGroundedAnswer(model,'分别总结两份资料',items,[],{requireAllFiles:true});assert.equal(r.state.status,'success');assert.equal(r.state.retries,1);assert.equal(reviews,1);assert.equal(r.verified.citations.length,2);
  model.chatCompletion=async()=>({content:JSON.stringify({answer:'',claims:[{text:rows[0].text,citations:['E1'],evidenceQuote:rows[0].text}]}),truncated:false});
  const missing=await generateGroundedAnswer(model,'分别总结',items,[],{requireAllFiles:true});assert.equal(missing.state.failure,'incomplete_answer');
});
