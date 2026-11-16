/** Run after npm run build. Requires Playwright and a local Chromium/Chrome; all business data is disposable. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {bootstrap} from '../../api/dist/main.js';
import {DATABASE} from '../../api/dist/db/database.js';
import {ContentIndexService} from '../../api/dist/archives/content/content-index.service.js';
import PizZip from 'pizzip';
import {emptyRetrievalPlan} from '../../api/dist/agent/retrieval.plan.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const temp=mkdtempSync(path.join(tmpdir(),'jit-agent-ui-'));
const output=process.env.JIT_E2E_OUTPUT_DIR;if(output)mkdirSync(output,{recursive:true});
let releaseModel,modelEntered;
function fixture(steps, mode='find', numbers=[]) { const p=emptyRetrievalPlan('');p.responseMode=mode;p.allowExpansion=false;p.hardConstraints.archiveNumbers=numbers;p.planSteps=steps;return p; }
const globalContent=keyword=>fixture([{id:'content',tool:'search_knowledge',intent:'独立检索正文',expects:'relevantText',args:{keyword,semanticQuery:keyword}}],'content_qa');
const model={available:true,provider:'mock-deepseek',model:'mock-ui',calls:[],delay:false,fail:false,async chatCompletion(messages){
 if(messages[0]?.content?.startsWith('RETRIEVAL_PLAN_V1')){
  model.plannerCalls=(model.plannerCalls??0)+1;
  const {originalQuestion,normalizedQuestion,...plan}=model.planOverride??{};
  return {content:JSON.stringify(plan),truncated:false};
 }
 if(messages[0]?.content?.startsWith('EVIDENCE_SUFFICIENCY_V1'))return {content:'{"verdict":"sufficient","note":"fixture evidence","supplement":[]}',truncated:false};
 if(messages[0]?.content?.startsWith('GROUNDING_REVIEW_V1'))return {content:'{\"supported\":true}',truncated:false};
 model.calls.push(structuredClone(messages));
 const text=messages.at(-1).content;
 if(model.delay){modelEntered?.();await new Promise(resolve=>releaseModel=resolve);}
 if(model.fail)throw new Error('mock failure');
 const evidence=[...text.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
 const claims=model.paraphrase?[{text:'这些条款明确了验收后的付款安排。',citations:[evidence[0][1]]}]:evidence.map(([,ref,quote])=>({text:quote,citations:[ref],evidenceQuote:quote}));
 return {content:JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims}),truncated:false};
}};
function docx(text){const zip=new PizZip();zip.file('word/document.xml',`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);return zip.generate({type:'nodebuffer'});}
function pdf(){return Buffer.from('%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R>> endobj\n4 0 obj <</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 6 0 R>> endobj\n5 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj\n6 0 obj <</Length 65>> stream\nBT /F1 12 Tf (payment agreement: pay within 30 days.) Tj ET\nendstream endobj\n%%EOF','latin1');}

test('Agent browser flow: real API trace, sources, attachment preview, authorization and conversation races',{timeout:90000},async t=>{
 let app,db,browser;try{
  const server=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:true,knowledgeWorker:false,
   aiModelClient:model,embeddingClient:{available:false,modelKey:'mock-disabled',async embed(){throw new Error('must not call');}}});
  app=server.app;db=app.get(DATABASE);let cookie='';
  const call=async(url,body,raw=false,method='POST')=>{
   const r=await fetch(server.baseUrl+'/api'+url,{method,headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},body:method==='GET'?undefined:raw?body:JSON.stringify(body??{})});
   const session=r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[1];if(session)cookie=`jit_sid=${session}`;
   return {status:r.status,data:await r.json()};
  };
  assert.equal((await call('/auth/init-admin',{username:'ui_admin',password:'Admin#12345',displayName:'界面测试'})).status,201);
  const category=(await call('/categories',{name:'界面测试',code:'UI'})).data;
  const archive=(await call('/archives',{title:'界面采购合同',categoryId:category.id,archiveType:'文书档案'})).data;
  const createFile=async(name,bytes)=>{const r=await call(`/archive-files/upload?archiveId=${archive.id}&name=${encodeURIComponent(name)}`,bytes,true);assert.equal(r.status,201);app.get(ContentIndexService).indexFileById(r.data.id);return r.data;};
  const first=await createFile('合同甲.txt',Buffer.from('付款条件：验收后30日付款。'));
  const second=await createFile('合同乙.txt',Buffer.from('付款条件：交付后15日付款。'));
  const word=await createFile('合同.docx',docx('付款条件：签署后7日付款。'));
  const pdfFile=await createFile('合同.pdf',pdf());
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--disable-gpu','--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies([{name:'jit_sid',value:cookie.slice('jit_sid='.length),url:server.baseUrl}]);
  // Only the external rendering engine is mocked. Every trace, source, byte fetch and access decision is real.
  await context.route('https://jitword.com/preview_sdk/**',route=>route.fulfill({contentType:'text/javascript',body:'window.JitWordFilePreview={createFilePreview(host,options){return {async open(blob,name){host.textContent="SDK测试容器："+name;options.onReady?.({format:"pdf",fileName:name});},destroy(){},close(){},preload(){},on(){return ()=>{}},off(){}}},setMessages(){}};'}));
  const page=await context.newPage();const failures=[];page.on('pageerror',e=>failures.push(e.message));
  const ask=async(question)=>{await page.locator('textarea').fill(question);const response=page.waitForResponse(r=>r.url().endsWith('/api/agent/ask'));await page.getByRole('button',{name:'发送',exact:true}).click();const r=await response;const data=await r.json();await page.getByRole('button',{name:'发送',exact:true}).waitFor();return data;};
  const expandSources=async()=>{for(const detail of await page.locator('.source-block').all()){if(await detail.getAttribute('open')===null)await detail.locator(':scope > summary').click();}};
  await page.goto(server.baseUrl+'/archives/search');
  model.planOverride=fixture([{id:'full',tool:'content.read',intent:'逐附件完整读取',expects:'fullText',args:{}}],'summary',[archive.archiveNo]);
  let reply;
  await t.test('真实检索过程和来源信息完成渲染',async()=>{
   reply=await ask(`档号 ${archive.archiveNo} 的主要内容是什么？`);
   assert.equal(reply.reply.payload.kind,'content_answer');
   assert.equal(await page.locator('.source-block').getAttribute('open'),null,'来源默认折叠');
   await expandSources();
   await page.locator('[data-testid="agent-source-group"]').first().waitFor();
   assert.equal(reply.reply.payload.trace.length,6);assert.equal(await page.locator('.retrieval-trace').count(),0,'诊断留在payload，保留既有产品隐藏设置');
   assert.equal(reply.reply.payload.evidenceSelection.strategy,'whole_attachment');
   assert.equal(reply.reply.payload.evidenceSelection.strategy,'whole_attachment');
   assert.equal(reply.reply.payload.evidenceSelection.excluded.length,0);
   assert.equal(await page.locator('[data-testid="agent-source-group"]').count(),4);
   assert.ok(reply.reply.payload.trace.every(step=>Number.isInteger(step.durationMs)&&step.durationMs>=0));
   if(output)await page.screenshot({path:path.join(output,'agent-trace.png'),fullPage:true});
  });
  await t.test('点击不同TXT来源打开正确附件并高亮真实行',async()=>{
   for(const file of [first,second]){
    await expandSources();
    await page.locator('[data-testid="agent-source-group"]').filter({hasText:file.originalName}).getByRole('button',{name:'查看原文 →',exact:true}).click();
    await page.locator('.preview-text .text-hit').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('fileId'),String(file.id));
    assert.match(await page.locator('.preview-source').innerText(),/TXT 第 1 行/);
    if(output&&file.id===first.id)await page.screenshot({path:path.join(output,'source-preview.png'),fullPage:true});
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.goBack();await expandSources();
   }
  });
  await t.test('PDF显示真实命中页；DOCX显示段落并请求正确受控附件',async()=>{
   for(const [file,locator] of [[pdfFile,/第 2 页/],[word,/第 1 段/]]){
    const expected=page.waitForResponse(r=>r.url().includes(`/api/archive-files/${file.id}/preview`));
    await expandSources();
    await page.locator('[data-testid="agent-source-group"]').filter({hasText:file.originalName}).getByRole('button',{name:'查看原文 →',exact:true}).click();
    assert.equal((await expected).status(),200);await page.locator('.preview-source').waitFor();
    assert.match(await page.locator('.preview-source').innerText(),locator);
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.goBack();await expandSources();
   }
  });
  await t.test('fileId归属和失效来源由后端拒绝，无结果如实显示',async()=>{
   const other=(await call('/archives',{title:'另一档案',categoryId:category.id,archiveType:'文书档案'})).data;
   await page.goto(`${server.baseUrl}/archives/${other.id}?fileId=${first.id}`);
   await page.getByText('来源附件不存在或不属于当前档案，请重新检索',{exact:true}).waitFor();assert.equal(await page.locator('.preview-modal').count(),0);
   const source=reply.reply.payload.sources.find(s=>s.fileId===first.id);
   assert.equal((await call(`/knowledge/attachments/${first.id}/source/${source.chunkId}?archiveId=${other.id}`,undefined,false,'GET')).status,400);
   const restricted=(await call('/archives',{title:'受限界面档案',categoryId:category.id,archiveType:'文书档案',accessLevel:'restricted'})).data;
   await call('/users',{username:'ui_borrower',password:'User#12345',displayName:'界面借阅者',role:'borrower'});
   const adminCookie=cookie;await call('/auth/login',{username:'ui_borrower',password:'User#12345'});
   assert.equal((await call(`/archives/${restricted.id}`,undefined,false,'GET')).status,403);
   cookie=adminCookie;
   await page.goto(server.baseUrl+'/archives/search');await page.getByRole('button',{name:'＋ 新建对话',exact:true}).click();
   model.planOverride=fixture([{id:'archives',tool:'archive.search',intent:'查找',expects:'metadata',args:{keyword:'不存在的界面唯一档案名称'}}]);
   const noHit=await ask('查找不存在的界面唯一档案名称');assert.equal(noHit.reply.payload.trace.find(step=>step.id==='archives').status,'empty');
   assert.equal(await page.locator('.retrieval-trace').count(),0);
  });
  await t.test('理解问题不显示命中数，全局正文和依赖跳过按真实状态展示',async()=>{
   model.planOverride=fixture([{id:'archives',tool:'archive.search',intent:'列出全部授权档案',expects:'metadata',args:{}}],'list');model.planOverride.isInventoryQuery=true;
   const list=await ask('那我有哪些文件？');
   assert.equal(list.reply.payload.conditions.keyword,undefined);
   assert.equal(await page.locator('.retrieval-trace').count(),0);
   assert.doesNotMatch(list.reply.payload.trace.find(s=>s.id==='understand').note,/返回/u);
   model.planOverride=globalContent('付款条件');
   const global=await ask('哪个附件提到了付款条件？');
   assert.equal(global.reply.payload.kind,'content_answer');
   assert.equal(global.reply.payload.trace.find(s=>s.id==='archives').status,'skipped');
   assert.equal(global.reply.payload.trace.find(s=>s.id==='content').hitCount,3);
   assert.equal(global.reply.payload.trace.find(s=>s.id==='content').hitCount,3);
   assert.equal(global.reply.payload.trace.find(s=>s.id==='archives').status,'skipped');
   model.planOverride=globalContent('付款条件');model.planOverride.hardConstraints.archiveNumbers=['MISSING-2099-999999'];
   const missing=await ask('搜索档号 MISSING-2099-999999 的正文');
   const skipped=missing.reply.payload.trace.find(s=>s.id==='content');
   assert.equal(skipped.status,'skipped');assert.match(skipped.note,/未找到指定|明确查询范围/u);
   assert.equal(missing.reply.payload.trace.find(s=>s.id==='content').status,'skipped');
   assert.doesNotMatch(missing.reply.payload.trace.find(s=>s.id==='content').note,/已完成|返回/u);
   model.planOverride=globalContent('星际量子密钥');
   const empty=await ask('哪个附件提到了星际量子密钥？');
   assert.equal(empty.reply.payload.kind,'content_no_evidence');
   assert.match(empty.reply.payload.trace.find(s=>s.id==='answer').note,/没有.*证据/u);
   model.fail=true;
   try{
    model.planOverride=globalContent('付款条件');
    const failed=await ask('哪个附件提到了付款条件？');
    assert.equal(failed.reply.payload.trace.find(s=>s.id==='answer').status,'failed');
    assert.equal(failed.reply.payload.answerGeneration.status,'failed');
   }finally{model.fail=false;}
  });
  await t.test('无扩展名附件独立定位且页面展示实际模型调用和证据数',async()=>{
   const finance=await createFile('财务合同附件.txt',Buffer.from('财务合同末章：验收后30日内付款。'));
   model.planOverride=fixture([{id:'archives',tool:'archive.search',intent:'查元数据',expects:'metadata',args:{keyword:'财务合同'}},{id:'files',tool:'attachment.search',intent:'独立查附件',expects:'attachmentNames',args:{attachmentFileName:'财务合同附件'}},{id:'read',tool:'content.read',intent:'读匹配附件',expects:'fullText',args:{},scope:'step:files'}],'summary');
   const before=model.calls.length;
   const response=await ask('财务合同附件的内容是什么？');
   assert.equal(response.reply.payload.kind,'content_answer');
   assert.equal(model.calls.length,before+1);
   assert.ok(response.reply.payload.sources.every(s=>s.fileId===finance.id&&s.archiveId===archive.id));
   assert.match(model.calls.at(-1).at(-1).content,/财务合同末章：验收后30日内付款/);
   assert.equal(response.reply.payload.modelCall.provider,'mock-deepseek');
   assert.equal(response.reply.payload.modelCall.model,'mock-ui');
   assert.equal(response.reply.payload.modelCall.evidenceCount,1);assert.equal(response.reply.payload.modelCall.modelEvidenceCount,1);
   assert.equal(response.reply.payload.answerGeneration.citations,'passed');
   assert.equal(response.reply.payload.trace.find(s=>s.id==='archives').status,'empty');
   assert.equal(response.reply.payload.trace.find(s=>s.id==='attachments').hitCount,1);
   if(output)await page.screenshot({path:path.join(output,'agent-independent-attachment-ai.png'),fullPage:true});
  });
  await t.test('动态模型计划、独立检索与真实正文回答展示',async()=>{
   model.planOverride=emptyRetrievalPlan('');model.planOverride.responseMode='summary';model.planOverride.attachmentNameCandidates=['财务合同附件'];model.planOverride.allowExpansion=false;model.planOverride.planSteps=[{id:'files',tool:'attachment.search',intent:'查附件',expects:'attachmentNames',args:{attachmentFileName:'财务合同附件'}},{id:'read',tool:'content.read',intent:'阅读全文',expects:'fullText',args:{},scope:'step:files'}];
   try{
    const response=await ask('把那份财务附件的安排捋一遍');
    assert.equal(response.reply.payload.plannerCall.status,'success');assert.equal(response.reply.payload.kind,'content_answer');
    assert.equal(response.reply.payload.plannerCall.status,'success');assert.equal(response.reply.payload.retrievalRounds,1);await expandSources();
    await page.locator('.source-doc-title').filter({hasText:'财务合同附件.txt'}).last().waitFor();
    if(output)await page.screenshot({path:path.join(output,'agent-dynamic-plan.png'),fullPage:true});
   }finally{model.planOverride=null;}
  });
  await t.test('完整清单支持下一页，计数不使用当前页数量',async()=>{
   for(let i=0;i<24;i++)assert.equal((await call('/archives',{title:'分页档案'+i,categoryId:category.id,archiveType:'文书档案'})).status,201);
   model.planOverride=fixture([{id:'archives',tool:'archive.search',intent:'完整清单',expects:'metadata',args:{}}],'list');model.planOverride.isInventoryQuery=true;
   const before=model.plannerCalls,response=await ask('我有哪些档案');
   assert.equal(response.reply.payload.items.length,20);assert.ok(response.reply.payload.total>20);assert.equal(model.plannerCalls,before+1);assert.equal(response.reply.payload.plannerCall.status,'success');
   const next=page.waitForResponse(r=>r.url().endsWith('/api/agent/ask'));await page.getByRole('button',{name:'下一页',exact:true}).last().click();
   const data=await (await next).json();assert.equal(data.reply.payload.pagination.page,2);assert.equal(data.reply.payload.total,response.reply.payload.total);
   assert.equal(data.reply.payload.items.length,response.reply.payload.total-20);assert.equal(model.plannerCalls,before+2);assert.equal(data.reply.payload.plannerCall.status,'success');
  });
  await t.test('自然语言总结为主内容，引用自动展开且E编号链接打开原文，失败状态真实',async()=>{
   model.planOverride=globalContent('付款条件');model.planOverride.hardConstraints.archiveNumbers=[archive.archiveNo];
   model.paraphrase=true;
   try{
    await page.getByRole('button',{name:'＋ 新建对话',exact:true}).click();
    const response=await ask(`档号 ${archive.archiveNo} 的付款条件是什么？`);
    assert.equal(response.reply.payload.kind,'content_answer');
    const bubble=page.locator('.bubble-agent').last();assert.match(await bubble.innerText(),/明确了验收后的付款安排/);assert.match(await bubble.innerText(),/\[E\d+\]/u);
    assert.equal(await page.locator('.source-block').last().getAttribute('open'),null,'来源默认折叠');
    await expandSources();
    assert.match(await page.locator('.answer-status').last().innerText(),/引用核验通过/);
    const source=response.reply.payload.sources[0];await bubble.locator('.citation-link').click();await page.locator('.preview-source').waitFor();assert.equal(new URL(page.url()).searchParams.get('fileId'),String(source.fileId));
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.goBack();
    model.fail=true;const failed=await ask(`档号 ${archive.archiveNo} 的付款条件是什么？`);
    assert.equal(failed.reply.payload.aiUsed,false);assert.equal(failed.reply.payload.answerGeneration.status,'failed');assert.match(await page.locator('.answer-status').last().innerText(),/AI 总结未完成/);
    assert.ok((await page.locator('.bubble-agent').last().innerText()).length<1400);
    if(output)await page.screenshot({path:path.join(output,'agent-summary-and-failure.png'),fullPage:true});
   }finally{model.paraphrase=false;model.fail=false;}
  });
  await t.test('点击停止生成后，首次提问和停止记录保留在当前会话',async()=>{
   await page.getByRole('button',{name:'＋ 新建对话',exact:true}).click();
   const question=`档号 ${archive.archiveNo} 的主要内容是什么？`;
   model.planOverride=fixture([{id:'full',tool:'content.read',intent:'逐附件完整读取',expects:'fullText',args:{}}],'summary',[archive.archiveNo]);
   model.delay=true;const entered=new Promise(resolve=>modelEntered=resolve);
   await page.locator('textarea').fill(question);
   const response=page.waitForResponse(r=>r.url().endsWith('/api/agent/ask'));
   await page.getByRole('button',{name:'发送',exact:true}).click();await entered;
   const cancelResponse=page.waitForResponse(r=>r.url().endsWith('/api/agent/cancel'));
   await page.getByRole('button',{name:'停止生成',exact:true}).click();
   assert.equal((await cancelResponse).status(),201);
   releaseModel();
   const stoppedResponse=await response;const stopped=await stoppedResponse.json();model.delay=false;
   assert.equal(stopped.cancelled,true);assert.ok(stopped.conversationId>0);
   await page.locator('.bubble-user').filter({hasText:question}).waitFor();
   assert.match(await page.locator('.bubble-agent').last().innerText(),/已停止生成/);
   const restored=await call(`/agent/conversations/${stopped.conversationId}`,undefined,false,'GET');
   assert.equal(restored.status,200);
   assert.deepEqual(restored.data.messages.map(message=>message.role),['user','assistant']);
   assert.equal(restored.data.messages[0].content,question);
   assert.match(restored.data.messages[1].content,/已停止生成/);
  });
  await t.test('切换会话后迟到的模型结果不会混入新会话，但会保留在历史列表',async()=>{
   await page.getByRole('button',{name:'＋ 新建对话',exact:true}).click();
   const historyBefore=await page.locator('.conv-item').count();
   model.planOverride=fixture([{id:'full',tool:'content.read',intent:'逐附件完整读取',expects:'fullText',args:{}}],'summary',[archive.archiveNo]);
   model.delay=true;const entered=new Promise(resolve=>modelEntered=resolve);
   await page.locator('textarea').fill(`档号 ${archive.archiveNo} 的主要内容是什么？`);
   const response=page.waitForResponse(r=>r.url().endsWith('/api/agent/ask'));
   await page.getByRole('button',{name:'发送',exact:true}).click();await entered;
   const cancelResponse=page.waitForResponse(r=>r.url().endsWith('/api/agent/cancel'));
   await page.getByRole('button',{name:'＋ 新建对话',exact:true}).click();
   assert.equal((await cancelResponse).status(),201);
   releaseModel();const stoppedResponse=await response;const stopped=await stoppedResponse.json();model.delay=false;
   assert.equal(stopped.cancelled,true);
   await page.locator('.welcome').waitFor();
   assert.equal(await page.locator('.msg.is-agent').count(),0);
   assert.equal(await page.locator('.source-block').count(),0);
   assert.equal(await page.locator('.conv-item').count(),historyBefore+1,'离开生成中的会话后，已保存的停止记录仍应进入历史列表');
  });
  assert.deepEqual(failures,[]);
 }finally{releaseModel?.();if(browser)await browser.close();if(app)await app.close();if(db)db.close();rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
