import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';import path from 'node:path';import {tmpdir} from 'node:os';
import {chromium} from 'playwright';import PizZip from 'pizzip';
import {bootstrap} from '../../api/dist/main.js';import {DATABASE} from '../../api/dist/db/database.js';
import {ContentIndexService} from '../../api/dist/archives/content/content-index.service.js';
import {GraphModule} from '../../api/dist/graph/graph.module.js';import {GraphBuildService} from '../../api/dist/graph/graph.service.js';
import {emptyRetrievalPlan} from '../../api/dist/agent/retrieval.plan.js';

test('E/G引用页面：真实数据、三种原文定位、关系详情、节点定位、历史及移动端',{timeout:90000},async t=>{
 const temp=mkdtempSync(path.join(tmpdir(),'jit-citation-ui-'));let app,db,browser;
 const output=process.env.JIT_E2E_OUTPUT_DIR;if(output)mkdirSync(output,{recursive:true});
 const model={available:true,provider:'test',model:'ui-citations',plan:null,async chatCompletion(messages){
  const system=messages[0].content;
  if(system.startsWith('RETRIEVAL_PLAN_V1')){const {originalQuestion,normalizedQuestion,...wire}=this.plan;return {content:JSON.stringify(wire)};}
  if(system.startsWith('EVIDENCE_SUFFICIENCY_V1'))return {content:'{"verdict":"sufficient","note":"核对真实结果","supplement":[]}'};
  if(system.startsWith('GROUNDING_REVIEW_V1'))return {content:'{"supported":true}'};
  const text=messages.at(-1).content;
  const claims=[...text.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)].map(m=>({text:m[2],citations:[m[1]],evidenceQuote:m[2]}));
  const graph=[...text.matchAll(/^\[(G\d+)\] (.+)$/gmu)].find(m=>m[2].includes('不能直接证明'));
  if(graph)claims.push({text:graph[2],citations:[graph[1]]});
  return {content:JSON.stringify({answer:'',claims})};
 }};
 try{
  const server=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:true,knowledgeWorker:false,aiModelClient:model});app=server.app;db=app.get(DATABASE);let cookie='';
  const req=async(url,body,raw=false,method='POST')=>{
   const r=await fetch(server.baseUrl+'/api'+url,{method,headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},body:method==='GET'?undefined:raw?body:JSON.stringify(body??{})});
   const sid=r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[1];if(sid)cookie='jit_sid='+sid;return {status:r.status,data:await r.json()};
  };
  assert.equal((await req('/auth/init-admin',{username:'citation_ui',password:'Admin#12345',displayName:'引用界面验收'})).status,201);
  const category=(await req('/categories',{name:'引用界面',code:'CUI'})).data;
  const create=async title=>(await req('/archives',{title,categoryId:category.id,archiveType:'文书档案'})).data;
  const a=await create('采购合同甲'),b=await create('采购合同乙');
  const text='设备采购付款约定：验收合格后30日内支付尾款。供货方负责设备安装调试和保修，合同正文与采购验收材料统一归档。';
  const upload=async(archive,name,bytes)=>{const r=await req('/archive-files/upload?archiveId='+archive.id+'&name='+encodeURIComponent(name),bytes,true);assert.equal(r.status,201);app.get(ContentIndexService).indexFileById(r.data.id);return r.data;};
  const txt=await upload(a,'付款甲.txt',Buffer.from(text));await upload(a,'验收明细.txt',Buffer.from('验收记录：本批设备按合同完成质量核对和测试，明细清单随卷保存。'.repeat(14)));await upload(b,'付款乙.txt',Buffer.from(text));
  const zip=new PizZip();zip.file('word/document.xml','<w:document><w:body><w:p><w:r><w:t>签署后7日完成验收记录。</w:t></w:r></w:p></w:body></w:document>');
  const word=await upload(a,'验收.docx',zip.generate({type:'nodebuffer'}));
  const pdf=await upload(a,'付款页.pdf',Buffer.from('%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R>> endobj\n4 0 obj <</Type/Page/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 6 0 R>> endobj\n5 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj\n6 0 obj <</Length 65>> stream\nBT /F1 12 Tf (payment agreement: pay within 30 days.) Tj ET\nendstream endobj\n%%EOF','latin1'));
  app.select(GraphModule).get(GraphBuildService).buildAll({syncContent:true,options:{minChunkCharsForSimilarity:10,maxTermDocFrequencyRatio:1}});
  const p=emptyRetrievalPlan('');p.responseMode='content_qa';p.allowExpansion=false;p.hardConstraints.archiveNumbers=[a.archiveNo];
  p.planSteps=[{id:'locate',tool:'archive.search',intent:'定位真实档案',expects:'metadata',args:{}},
   {id:'graph',tool:'graph.relations',intent:'关系查询',expects:'metadata',args:{},scope:'step:locate'},
   {id:'body',tool:'content.read',intent:'完整原文',expects:'fullText',args:{},scope:'step:locate'}];model.plan=p;
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH,args:['--no-sandbox','--disable-gpu']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:'jit_sid',value:cookie.slice(8),url:server.baseUrl}]);
  await context.route('https://jitword.com/preview_sdk/**',route=>route.fulfill({contentType:'text/javascript',body:'window.JitWordFilePreview={createFilePreview(host,opts){return {async open(blob,name){host.textContent="外部SDK测试容器："+name;opts.onReady?.({format:"pdf",fileName:name});},destroy(){},close(){},preload(){},on(){return ()=>{}},off(){}}},setMessages(){}};'}));
  const page=await context.newPage();page.setDefaultTimeout(12000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const openSources=async()=>{const block=page.locator('.source-block').first();if(await block.getAttribute('open')===null)await block.locator('summary').click();};
  await page.goto(server.baseUrl+'/archives/search');await page.locator('textarea').fill('请综合分析采购资料的联系并说明原文依据');
  const pending=page.waitForResponse(r=>r.url().endsWith('/api/agent/ask'));await page.getByRole('button',{name:'发送',exact:true}).click();const answer=await (await pending).json();
  assert.equal(answer.reply.payload.kind,'content_answer',JSON.stringify(answer.reply.payload));const c=answer.reply.payload.graphCitations[0];assert.ok(c);
  await page.locator('[data-testid="agent-graph-citations"]').waitFor();
  const renderedAnswer = await page.locator('.messages').innerText();
  assert.doesNotMatch(renderedAnswer,/本次只查看了|正文尚未处理|正文没有读完整|附件正文状态|OCR|AI回答已完成|引用核验通过|检索到，未作为正式引用/iu,'普通回答只展示结论和正式引用，不展示内部检索或处理状态');
  assert.equal(await page.locator('[data-testid="agent-limitations"]').count(),0);
  assert.equal(await page.locator('.answer-status').count(),0);
  assert.equal(await page.locator('.source-hint').count(),0);
  assert.equal(await page.locator('[data-testid="agent-retrieved-evidence"]').count(),0);
  await t.test('回答自动展开独立来源与图谱区域，E/G编号保持一一对应',async()=>{
   const graphBlock=page.locator('[data-testid="agent-graph-citations"]');await graphBlock.waitFor();
   assert.equal(await page.locator('.source-block').getAttribute('open'),null,'来源区域默认折叠');
   assert.equal(await page.locator('[data-testid="agent-source-group"]').count(),4,'同一附件的多个知识块必须归并为一条来源');
   assert.match(await page.locator('.source-block > summary').first().innerText(),/参考来源 · \d+ 份文档/u);
   await openSources();
   const labels=await page.locator('.bubble-agent .citation-link').allTextContents();assert.ok(labels.includes('['+c.ref+']'));assert.ok(labels.includes('[E1]'));
   const long=page.locator('[data-testid="agent-source-group"]').filter({hasText:'验收明细.txt'});
   assert.equal(await long.locator('.source-fragment').count(),0,'默认不展示片段');
   await long.locator('.source-doc-toggle').click();assert.ok(await long.locator('.source-fragment').count()>=1);
   assert.match(await long.locator('.source-fragment').first().innerText(),/\[E\d+\]/u);
   await long.locator('.source-doc-toggle').click();assert.equal(await long.locator('.source-fragment').count(),0);
   assert.equal(await graphBlock.getAttribute('open'),null,'图谱区域默认折叠');
   await graphBlock.locator('summary').click();
   assert.equal(await page.locator('[data-testid="agent-graph-detail"]').count(),0,'默认不展示关系计算说明');
   await page.locator('[data-testid="agent-graph-relation"]').click();
   await page.locator('[data-testid="agent-graph-detail"]').waitFor();
   assert.match(await page.locator('[data-testid="agent-graph-detail"]').innerText(),/不能直接证明两份档案存在实际业务关系/u);
   if(output)await page.screenshot({path:path.join(output,'citations-desktop.png'),fullPage:true});
  });
  await t.test('点击真实TXT/PDF/DOCX来源，复用受控预览与真实命中定位',async()=>{
   for(const [file,locator]of [[txt,/TXT 第/u],[word,/DOCX 第 1 段/u],[pdf,/PDF 第 2 页/u]]){
    const source=answer.reply.payload.sources.find(s=>s.fileId===file.id);assert.ok(source);
    await openSources();
    await page.locator('[data-testid="agent-source-group"]').filter({hasText:file.originalName}).getByRole('button',{name:'查看原文 →',exact:true}).click();await page.locator('.preview-source').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('fileId'),String(file.id));assert.equal(new URL(page.url()).searchParams.get('chunkId'),String(source.chunkId));
    assert.match(await page.locator('.preview-source').innerText(),locator);if(file.id===txt.id)await page.locator('.text-hit').first().waitFor();
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.goBack();await page.locator('[data-testid="agent-graph-citations"]').waitFor();
   }
  });
  await t.test('点击G编号打开真实关系详情及其独立依据',async()=>{
   await page.locator('.bubble-agent').getByRole('button',{name:'['+c.ref+']',exact:true}).click();
   await page.locator('[data-testid="kg-exact-edge-evidence"]').waitFor();assert.equal(new URL(page.url()).searchParams.get('edgeId'),String(c.edgeId));
   assert.match(await page.locator('[data-testid="kg-edge-detail"]').innerText(),/正文.*相似/u);
   await page.goBack();await page.locator('[data-testid="agent-graph-citations"]').waitFor();
  });
  await t.test('附件与知识块标签定位现有图谱，详情进一步返回正确原文',async()=>{
   for(const type of ['file','chunk']){
    const node=c.supportingNodes.find(n=>n.type===type);assert.ok(node);
    await page.locator('[data-testid="agent-graph-citations"]').locator('summary').click();await page.locator('[data-testid="agent-graph-relation"]').click();const evidence=page.locator('[data-testid="agent-graph-evidence"]');if(await evidence.getAttribute('open')===null)await evidence.locator('summary').click();
    await evidence.locator('button[data-node-key]').filter({visible:true}).all().then(async buttons=>{for(const button of buttons)if(await button.getAttribute('data-node-key')===node.key){await button.click();return;}throw new Error('Missing real node');});
    await page.locator('[data-testid="kg-detail-'+type+'"]').waitFor();assert.equal(new URL(page.url()).searchParams.get('refId'),String(node.refId));
    await page.getByRole('button',{name:'查看原文',exact:true}).click();await page.locator('.preview-modal').waitFor();assert.equal(new URL(page.url()).searchParams.get('fileId'),String(node.fileId));
    if(type==='chunk')assert.equal(new URL(page.url()).searchParams.get('chunkId'),String(node.refId));
    await page.getByRole('button',{name:'关闭',exact:true}).click();await page.goBack();await page.goBack();await page.locator('[data-testid="agent-graph-citations"]').waitFor();
   }
  });
  await t.test('移动端无横向溢出，历史重新加载仍恢复真实引用',async()=>{
   await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.conv-panel').getBoundingClientRect().right<=1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   if(output)await page.screenshot({path:path.join(output,'citations-mobile.png'),fullPage:true});
   await page.reload();await page.locator('textarea').waitFor();
   await page.getByRole('button',{name:'打开会话列表',exact:true}).click();await page.getByRole('button',{name:/请综合分析采购资料/u}).first().click();await page.locator('[data-testid="agent-graph-citations"]').waitFor();
   assert.equal(await page.locator('.graph-citation-row').count(),1);
  });
  assert.deepEqual(errors,[]);
 }finally{
  if(browser)await browser.close();if(app)await app.close();if(db)db.close();
  assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir())+path.sep)&&path.basename(temp).startsWith('jit-citation-ui-'));
  rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
