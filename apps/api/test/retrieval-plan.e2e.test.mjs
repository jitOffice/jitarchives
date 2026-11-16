/** Semantic planner + real SQLite/FTS; no real API calls or production writes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bootstrap} from '../dist/main.js';
import {DATABASE} from '../dist/db/database.js';
import {ContentIndexService} from '../dist/archives/content/content-index.service.js';
import {AgentToolRegistry} from '../dist/agent/tool.registry.js';
import {emptyRetrievalPlan, validateRetrievalPlan} from '../dist/agent/retrieval.plan.js';

const wire = plan => { const {originalQuestion, normalizedQuestion, ...rest} = plan; return rest; };
test('strict planner schema rejects executable, identity, unsafe scope and malformed fields', () => {
  const p = wire(emptyRetrievalPlan('研究设施账期'));
  for (const extra of [{sql:'SELECT *'}, {userId:1}, {archiveIds:[1]}, {permissions:['admin']}, {role:'admin'}]) assert.throws(() => validateRetrievalPlan({...p,...extra},'研究设施账期'));
  for (const patch of [{confidence:2}, {allowExpansion:'yes'}, {contentScope:'archive'}, {searchVariants:[{source:'content',term:'账期',expanded:false,sql:'DROP'}]}, {timeRange:{field:'formationDate',from:'2026-02-31',to:null}}, {hardConstraints:{...p.hardConstraints,metadata:[{field:'供应商',value:'青岚',userId:1}]}}]) assert.throws(() => validateRetrievalPlan({...p,...patch},'研究设施账期'));
  assert.throws(() => validateRetrievalPlan({...p, contentTerms:['请帮我研究一下这次设施交付何时结算']},'请帮我研究一下这次设施交付何时结算'));
  const valid = validateRetrievalPlan(p,'仅限 ABC-2026-000001');
  assert.deepEqual(valid.hardConstraints.archiveNumbers,['ABC-2026-000001']);
});

test('planner tolerates omitted clue keys (template defaults) but still rejects unknown/injected keys', () => {
  const p = wire(emptyRetrievalPlan('研究设施账期'));
  const omitted = { ...p }; delete omitted.softHints; delete omitted.semanticConcepts; delete omitted.searchVariants;
  const relaxed = validateRetrievalPlan(omitted,'研究设施账期');
  assert.deepEqual(relaxed.softHints, []); assert.deepEqual(relaxed.semanticConcepts, []); assert.deepEqual(relaxed.searchVariants, []);
  assert.throws(() => validateRetrievalPlan({ ...p, notes: 'x' },'研究设施账期'), /Unexpected retrieval plan keys/);
});

test('planner accepts searchVariants written as plain string clues (real DeepSeek shorthand) and still guards object form', () => {
  const p = wire(emptyRetrievalPlan('财务合同附件主要内容'));
  const str = validateRetrievalPlan({ ...p, searchVariants: ['财务合同附件主要内容', '财务类合同档案附件内容'] },'财务合同附件主要内容');
  assert.equal(str.searchVariants.length, 2);
  assert.deepEqual(str.searchVariants[0], { source: 'content', term: '财务合同附件主要内容', expanded: false });
  assert.throws(() => validateRetrievalPlan({ ...p, searchVariants: [{ source: 'content', term: '账期', expanded: false, sql: 'DROP' }] },'研究设施账期'), /Invalid retrieval plan object/);
});

test('dynamic retrieval plans, independent channels, feedback, scope, permissions and real answer evidence',{timeout:90000},async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'jit-plan-'));
  let app,db,active=emptyRetrievalPlan(''),fail=false,invalid=false,expanded;
  const calls=[];
  const model={available:true,provider:'mock-deepseek',model:'mock-semantic-planner',async chatCompletion(messages){
    calls.push(structuredClone(messages));
    if(fail)throw Error('mock provider failure');
    if(messages[0].content.startsWith('RETRIEVAL_PLAN_V1')){
      const request=JSON.parse(messages.at(-1).content);
      const p=structuredClone(request.feedback&&expanded?expanded:active);
      if(invalid)p.userId=1;
      return {content:JSON.stringify(wire(p)),truncated:false};
    }
    const items=[...messages.at(-1).content.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
    assert.ok(items.length,'answer must receive actual evidence');
    const claims=items.map(([,ref,quote])=>({text:quote,citations:[ref],evidenceQuote:quote}));
    return {content:JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims}),truncated:false};
  }};
  try{
    const server=await bootstrap({port:0,dbFile:path.join(dir,'test.db'),fileStoreDir:path.join(dir,'files'),serveWeb:false,knowledgeWorker:false,aiModelClient:model,
      embeddingClient:{available:false,modelKey:'disabled',async embed(){throw Error('must not call')}}});
    app=server.app;db=app.get(DATABASE);
    const api=async(url,cookie='',body,method='POST',raw=false)=>{const r=await fetch(server.baseUrl+'/api'+url,{method,headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},body:method==='GET'?undefined:raw?body:JSON.stringify(body??{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[0]};};
    const admin=(await api('/auth/init-admin','',{username:'plan_admin',password:'Admin#12345',displayName:'规划测试'})).cookie;
    const cookies={admin};
    for(const role of ['reviewer','cataloger','borrower','guest']){
      assert.equal((await api('/users',admin,{username:'plan_'+role,password:'User#12345',displayName:role,role})).status,201);
      cookies[role]=(await api('/auth/login','',{username:'plan_'+role,password:'User#12345'})).cookie;
    }
    const cat=(await api('/categories',admin,{name:'科研设备',code:'SCI'})).data;
    const create=async(title,extra={})=>{const r=await api('/archives',admin,{title,categoryId:cat.id,archiveType:'文书档案',...extra});assert.equal(r.status,201);return r.data;};
    const upload=async(a,name,body)=>{const r=await api(`/archive-files/upload?archiveId=${a.id}&name=${encodeURIComponent(name)}`,admin,Buffer.from(body),'POST',true);assert.equal(r.status,201);app.get(ContentIndexService).indexFileById(r.data.id);return r.data;};
    const a=await create('采购台账甲',{responsible:'青岚仪器',formationDate:'2025-05-01'});
    const file=await upload(a,'光谱仪交接纪要.txt','结算期限：验收完成后四十五日内支付尾款。\n供应商青岚仪器负责安装调试。');
    const secret=await create('隔离台账',{accessLevel:'restricted'});
    await upload(secret,'密级文档.txt','暗紫秘钥业务：付款密码9931。');
    const ask=async(q,role='admin',conversationId)=>{const r=await api('/agent/ask',cookies[role],{question:q,conversationId});assert.equal(r.status,201,JSON.stringify(r));return r.data;};
    const reset=(mode='content_qa')=>{active=emptyRetrievalPlan('');active.responseMode=mode;active.allowExpansion=false;expanded=undefined;};
    const expressions=['想核实一下，光谱仪交付后账期究竟怎么算','尾款拖多久才付，光谱仪那批','烦请说明实验设施交接完成后的结清时限','光谱设备，收货之后钱何时到账','结清时点给我说说，关于那批实验设备','账期？光谱仪那桩采购','设备交接以后的结算窗口是几日','我记不清文书叫什么，只记得涉及仪器交付和尾款'];
    for(const question of expressions)await t.test(`unseen expression: ${question}`,async()=>{
      reset();active.contentTerms=['结算期限'];active.businessEntities=['青岚仪器'];
      const before=calls.length,r=await ask(question);
      assert.equal(r.reply.payload.plannerCall.status,'success');
      assert.equal(r.reply.payload.kind,'content_answer',JSON.stringify(r.reply));
      assert.equal(calls.length,before+2,'one planning call and one grounded answer');
      assert.ok(calls.at(-1).at(-1).content.includes('四十五日'));
      assert.ok(r.reply.payload.sources.every(s=>s.archiveId===a.id&&s.fileId===file.id&&s.categoryName==='科研设备'&&s.locator));
      assert.deepEqual(r.reply.payload.retrievalPlan.contentTerms,['结算期限']);
      assert.equal(r.reply.payload.retrievalPlan.originalQuestion,question);
    });
    await t.test('title, metadata and attachment misses do not block Chinese content hits',async()=>{
      reset();active.archiveTitleCandidates=['无此目录'];active.metadataTerms=['不存在供应商'];active.attachmentNameCandidates=['无此附件'];active.contentTerms=['四十五日'];
      const r=(await ask('收货以后那笔结算有什么说法')).reply;
      assert.equal(r.payload.kind,'content_answer');
      assert.ok(r.payload.trace.find(s=>s.id==='archives').status==='empty');
      assert.equal(r.payload.trace.find(s=>s.id==='attachments').status,'empty');
      assert.equal(r.payload.trace.find(s=>s.id==='content').status,'completed');
    });
    await t.test('attachment stem only resolves parent archive and retrieves a full summary',async()=>{
      reset('summary');active.attachmentNameCandidates=['光谱仪交接'];
      const r=(await ask('那张光谱仪交接的材料帮忙捋一遍')).reply;
      assert.equal(r.payload.kind,'content_answer');assert.ok(r.payload.sources.every(s=>s.fileId===file.id));
      assert.equal(r.payload.retrievedAttachments[0].fileId,file.id);
    });
    await t.test('soft title prefix, metadata-only and entity-only queries use separate channels',async()=>{
      for(const [key,value] of [['archiveTitleCandidates','采购台账'],['metadataTerms','青岚仪器'],['businessEntities','青岚仪器']]){
        reset('find');active[key]=[value];const r=(await ask('把可能有关的条目给我定位出来')).reply;assert.ok(r.payload.items.some(i=>i.id===a.id));
      }
    });
    await t.test('multiple channels deduplicate real chunks and parent archives',async()=>{
      reset();active.contentTerms=['结算期限','四十五日'];active.attachmentNameCandidates=['光谱仪'];active.metadataTerms=['青岚仪器'];
      const r=(await ask('把仪器交付以后的结款安排说明白')).reply;
      assert.equal(new Set(r.payload.sources.map(s=>s.chunkId)).size,r.payload.sources.length);
      assert.equal(new Set(r.payload.items.map(i=>i.id)).size,r.payload.items.length);
    });
    await t.test('one failed channel leaves independent content channel operational',async()=>{
      reset();active.attachmentNameCandidates=['光谱仪'];active.contentTerms=['结算期限'];
      const registry=app.get(AgentToolRegistry),execute=registry.execute.bind(registry);
      registry.execute=async(name,...args)=>name==='attachment.search'?{toolName:name,status:'error',data:null,total:0,pagination:null,error:{code:'TEST',message:'injected'}}:execute(name,...args);
      try{const r=(await ask('说明那批设备付款的依据')).reply;assert.equal(r.payload.kind,'content_answer');assert.equal(r.payload.trace.find(s=>s.id==='attachments').status,'failed');assert.equal(r.payload.trace.find(s=>s.id==='content').status,'completed');}finally{registry.execute=execute;}
    });
    await t.test('second round expands only ordinary clues; does not repeat original conditions',async()=>{
      reset();active.allowExpansion=true;active.contentTerms=['结清窗口'];active.searchVariants=[{source:'content',term:'结算期限',expanded:true}];
      const r=(await ask('光谱那笔钱要在哪个窗口结清')).reply;
      assert.equal(r.payload.retrievalRounds,2);assert.equal(r.payload.kind,'content_answer');
      const content=r.payload.toolResults.filter(x=>x.toolName==='content.search');assert.equal(content.length,2);assert.deepEqual(content.map(x=>x.total),[0,1]);
    });
    await t.test('feedback can request another validated plan; no third round',async()=>{
      reset();active.allowExpansion=true;active.contentTerms=['不存在业务窗口'];expanded=structuredClone(active);expanded.contentTerms=['结算期限'];expanded.searchVariants=[{source:'content',term:'结算期限',expanded:false}];
      const before=calls.length,r=(await ask('这次设施买卖的结款窗口呢')).reply;
      assert.equal(r.payload.kind,'content_answer');assert.equal(r.payload.retrievalRounds,2);assert.equal(calls.length,before+3);
    });
    await t.test('feedback cannot relax hard scope or invent database identities',async()=>{
      reset();active.allowExpansion=true;active.hardConstraints.archiveTitles=['采购台账甲'];active.contentScope='archive';active.contentTerms=['绝无此词'];expanded=structuredClone(active);expanded.hardConstraints.archiveTitles=[];
      const r=(await ask('在刚指定的甲台账里查不存在的结款备注')).reply;
      assert.equal(r.payload.kind,'content_no_evidence');assert.equal(r.payload.retrievalRounds,1);
    });
    await t.test('explicit archive or attachment misses stay empty and do not send an answer prompt',async()=>{
      for(const key of ['archiveTitles','attachmentNames']){
        reset();active.hardConstraints[key]=['根本没有这个指定对象'];active.contentTerms=['结算期限'];const before=calls.length,r=(await ask('仅限特指的对象，解释结款安排')).reply;
        assert.equal(r.payload.kind,'content_no_evidence');assert.equal(calls.length,before+1);assert.equal(r.payload.sources.length,0);
      }
    });
    await t.test('date, category, status and metadata hard conditions compose in SQL',async()=>{
      reset('find');active.metadataTerms=['青岚'];active.archiveStatus='draft';active.categoryFilter=['科研设备'];active.timeRange={field:'formationDate',from:'2025-01-01',to:'2025-12-31'};active.hardConstraints.metadata=[{field:'责任者',value:'青岚仪器'}];
      const r=(await ask('限定去年形成且尚在草拟的科研设备资料，主体是青岚')).reply;
      assert.deepEqual(r.payload.items.map(i=>i.id),[a.id]);
    });
    await t.test('context is sent to the planner and previous_results never expands globally',async()=>{
      reset('find');active.attachmentNameCandidates=['光谱仪'];const first=await ask('把那张光谱交接材料定位出来');
      reset();active.contentScope='previous_results';active.contentTerms=['结算期限'];const r=await ask('刚找着的这份，尾款的安排再解释一下','admin',first.conversation.id);
      assert.equal(r.reply.payload.kind,'content_answer');assert.ok(r.reply.payload.sources.every(s=>s.archiveId===a.id));
      assert.equal(JSON.parse(calls.at(-2).at(-1).content).context.previousQuestion,'把那张光谱交接材料定位出来');
    });
    for(const role of Object.keys(cookies))await t.test(`${role}: model plan cannot widen real SQL visibility`,async()=>{
      reset();active.contentTerms=['暗紫秘钥业务'];const before=calls.length,r=(await ask('找出涉及那宗暗紫业务的实际约定',role)).reply;
      assert.equal(r.payload.sources.length>0,role==='admin');
      assert.equal(calls.length,before+(role==='admin'?2:1));
      if(role!=='admin')assert.doesNotMatch(JSON.stringify(r),/付款密码9931/);
    });
    await t.test('semantic configuration unavailability is reported as unavailable, not a fake hit',async()=>{
      reset();active.searchSources=['semantic'];active.semanticConcepts=['账期窗口'];
      const r=(await ask('拿账期窗口这个概念去查真实条款')).reply;
      assert.equal(r.payload.kind,'content_no_evidence');assert.ok(r.payload.toolResults.some(x=>x.data?.semanticAvailable===false));
    });
    await t.test('invalid planner schema and provider failures are handled honestly',async()=>{
      reset();active.contentTerms=['结算期限'];invalid=true;const bad=await ask('麻烦把设备结清时点说明白');invalid=false;
      assert.equal(bad.reply.payload.plannerCall.status,'failed');
      fail=true;const failed=await ask('交付那笔钱有什么安排呢');fail=false;
      assert.equal(failed.reply.payload.plannerCall.status,'failed');assert.notEqual(failed.reply.payload.kind,'content_answer');
    });
    await t.test('keyword-free inventory has complete pagination and real permission-consistent counts; no AI answer',async()=>{
      for(let i=0;i<23;i++)await create('盘点条目'+i);
      const before=calls.length,r=(await ask('我有哪些档案')).reply;
      assert.equal(calls.length,before);assert.equal(r.payload.total,25);assert.equal(r.payload.items.length,20);assert.equal(r.payload.inventory.statuses.draft,25);
      assert.equal(r.payload.inventory.categories.reduce((n,c)=>n+c.count,0),25);assert.equal(r.payload.pagination.hasMore,true);
      reset('list');active.isInventoryQuery=true;
      const next=(await ask('给我再列第 2 页，每页 20 条')).reply;assert.equal(next.payload.total,25);assert.equal(next.payload.items.length,5);
      const guest=(await ask('我有哪些档案','guest')).reply;assert.equal(guest.payload.total,24);assert.equal(guest.payload.inventory.categories.reduce((n,c)=>n+c.count,0),24);
    });
  }finally{if(app)await app.close();if(db)db.close();rmSync(dir,{recursive:true,force:true});}
});
