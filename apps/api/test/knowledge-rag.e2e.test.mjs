/** Stage 4: disposable database/files, deterministic embeddings/chat and no network credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { bootstrap } from '../dist/main.js';
import { DATABASE, openDatabase, ensureContentFts, ensureContentBigramFts } from '../dist/db/database.js';
import { SqliteTransaction } from '../dist/db/transaction.js';
import { SqliteContentIndexRepository } from '../dist/archives/content/content-index.repositories.js';
import { ContentKeywordSearchService } from '../dist/search/content-keyword-search.service.js';
import { UnifiedSearchService } from '../dist/search/unified-search.service.js';
import { KnowledgeWorker } from '../dist/knowledge/knowledge-worker.service.js';
import { KnowledgeSearchService } from '../dist/knowledge/knowledge-search.service.js';
import { AgentToolRegistry } from '../dist/agent/tool.registry.js';
import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
import { FileRepository } from '../dist/archives/archive.repositories.js';
import { extractFileContent } from '../dist/archives/content/content.extract.js';
import { chunkBlocks, CHUNK_MAX_CHARS } from '../dist/archives/content/content.chunk.js';
import {emptyRetrievalPlan} from '../dist/agent/retrieval.plan.js';
import { HttpEmbeddingClient } from '../dist/knowledge/embedding.client.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'jit-rag-v4-'));
let app, baseUrl, db, adminCookie, borrowerCookie, otherCookie, admin, borrower, other, category, worker, content, registry;
const ids = {};
const embedding = { available: true, modelKey: 'mock-embedding-v1', fail: false, calls: [], after: null,
  async embed(texts) {
    this.calls.push(texts);
    if (this.after) { const hook=this.after; this.after=null; await hook(); }
    if (this.fail) throw new Error('mock provider timeout');
    return texts.map(t => /付款|支付|结算|款项|资金|现金流/u.test(t) ? [1,0,0] : /违约|责任|逾期/u.test(t) ? [0,1,0] : [0,0,1]);
  },
};
const model = { available: false, model: 'mock-chat', calls: [],
  async chatCompletion(messages) {
    if (messages[0].content.startsWith('RETRIEVAL_PLAN_V1')) { const {originalQuestion,normalizedQuestion,...plan}=this.plan; return {content:JSON.stringify(plan),truncated:false}; }
    if (messages[0].content.startsWith('EVIDENCE_SUFFICIENCY_V1')) return {content:'{"verdict":"sufficient","note":"fixture evidence","supplement":[]}',truncated:false};
    this.calls.push(messages);
    const evidence=[...messages.at(-1).content.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
    const claims=evidence.map(([,ref,quote])=>({text:quote,citations:[ref],evidenceQuote:quote}));
    return {content:JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims}),truncated:false};
  },
};
async function request(url, cookie=adminCookie, body, method='POST', raw=false) {
  const r=await fetch(baseUrl+url, { method, headers: { ...(cookie?{Cookie:cookie}:{}), 'Content-Type':raw?'application/octet-stream':'application/json' },
    body: ['GET','DELETE'].includes(method)?undefined:raw?body:JSON.stringify(body??{}) });
  return { status:r.status, data:await r.json(), cookie:r.headers.get('set-cookie')?.match(/jit_sid=([0-9a-f]+)/u)?.[1] };
}
async function create(title, accessLevel='public') {
  const r=await request('/api/archives',adminCookie,{title,categoryId:category,archiveType:'文书档案',accessLevel});
  assert.equal(r.status,201,JSON.stringify(r.data)); return r.data;
}
async function upload(archiveId,name,bytes) {
  const r=await request(`/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,adminCookie,Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes),'POST',true);
  assert.equal(r.status,201,JSON.stringify(r.data)); // Explicit fixture indexing; the upload API itself only enqueues.
  app.get(ContentIndexService).indexFileById(r.data.id); return r.data;
}
async function search(query, cookie=adminCookie, extra={}) {
  const r=await request('/api/knowledge/search',cookie,{query,...extra});
  assert.equal(r.status,201,JSON.stringify(r.data)); return r.data;
}
async function ask(question,conversationId,cookie=adminCookie) {
  const r=await request('/api/agent/ask',cookie,{question,conversationId}); assert.equal(r.status,201,JSON.stringify(r.data)); return r.data;
}
function fixturePlan(archives=[], query='付款 违约', context=false, similar=false) {
  const p=emptyRetrievalPlan('');p.responseMode=archives.length>1?'compare':archives.length?'summary':'content_qa';p.allowExpansion=false;
  p.hardConstraints.archiveNumbers=archives.map(a=>a.archiveNo);
  p.planSteps=[{id:'evidence',tool:archives.length||context?'content.read':'content.search',intent:'测试显式规划证据',expects:archives.length||context?'fullText':'relevantText',args:archives.length||context?{}:{query:query},...(context?{contextRef:{entity:'archive',slot:'focus'}}:{})}];
  if(similar){p.referenceSlots=[{entity:'archive',slot:'focus'}];p.searchScope={kind:'fromReference'};}
  return p;
}
async function planned(plan,question,conversationId,cookie=borrowerCookie){
  model.plan=plan;model.available=true;
  try{return await ask(question,conversationId,cookie);}finally{model.available=false;}
}
function packageFile(parts) { const zip=new PizZip(); for(const [name,xml] of Object.entries(parts))zip.file(name,xml); return zip.generate({type:'nodebuffer'}); }
const docx = text => packageFile({'word/document.xml':`<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`});
const xlsx = packageFile({
  'xl/workbook.xml':'<workbook><sheets><sheet name="付款表" r:id="r1"/><sheet name="预算表" r:id="r2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet7.xml"/><Relationship Id="r2" Target="worksheets/sheet3.xml"/></Relationships>',
  'xl/sharedStrings.xml':'<sst><si><t>分期付款</t></si></sst>',
  'xl/worksheets/sheet7.xml':'<worksheet><sheetData><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>30</v></c><c r="C2" t="inlineStr"><is><t>天内</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet3.xml':'<worksheet><sheetData><row r="1"><c r="A1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>',
});
const pptx=packageFile({
  'ppt/presentation.xml':'<p:presentation><p:sldIdLst><p:sldId r:id="r2"/><p:sldId r:id="r1"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels':'<Relationships><Relationship Id="r2" Target="slides/slide8.xml"/><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>',
  'ppt/slides/slide8.xml':'<p:sld><a:p><a:r><a:t>违约责任：逾期每日收取违约金</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide1.xml':'<p:sld><a:p><a:r><a:t>项目结算说明</a:t></a:r></a:p></p:sld>',
});

test.describe('第四阶段 RAG 索引、检索、引用及权限',()=>{
  test.before(async()=>{
    ({app,baseUrl}=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:false,
      aiModelClient:model,embeddingClient:embedding,knowledgeWorker:false}));
    db=app.get(DATABASE); worker=app.get(KnowledgeWorker); content=app.get(ContentIndexService); registry=app.get(AgentToolRegistry);
    const init=await request('/api/auth/init-admin',null,{username:'rag_admin',password:'Admin#12345',displayName:'知识管理员'});
    assert.equal(init.status,201); adminCookie=`jit_sid=${init.cookie}`; admin=db.prepare('SELECT id FROM users WHERE username=?').get('rag_admin');
    for(const username of ['rag_borrower','rag_other']) assert.equal((await request('/api/users',adminCookie,{username,password:'User#12345',displayName:username,role:'borrower'})).status,201);
    const login=await request('/api/auth/login',null,{username:'rag_borrower',password:'User#12345'}); borrowerCookie=`jit_sid=${login.cookie}`;
    const login2=await request('/api/auth/login',null,{username:'rag_other',password:'User#12345'}); otherCookie=`jit_sid=${login2.cookie}`;
    const user=role=>({id:Number(db.prepare('SELECT id FROM users WHERE username=?').get(role).id),role:'borrower',status:'active'});
    borrower=user('rag_borrower'); other=user('rag_other');
    category=(await request('/api/categories',adminCookie,{name:'知识合同',code:'RAG4'})).data.id;
    ids.purchase=await create('采购合同'); ids.sales=await create('销售合同'); ids.ppp=await create('PPP合同'); ids.secret=await create('保密采购合同','restricted');
    ids.purchaseFile=await upload(ids.purchase.id,'采购合同.docx',docx('付款条款：验收后30日内支付。违约责任：逾期承担赔偿责任。'));
    ids.salesFile=await upload(ids.sales.id,'销售合同.txt','付款条款：交货后15日内付款。违约责任：逾期每日收取违约金。');
    ids.pppFile=await upload(ids.ppp.id,'PPP合同.txt','PPP项目正文：合同约定验收后七日内支付款项。付款条款：款项应一次性结清。');
    ids.secretFile=await upload(ids.secret.id,'机密附件.txt','极密标记雪豹。付款条款：秘密项目支付999万元。');
    ids.sheet=await upload(ids.purchase.id,'付款表.xlsx',xlsx); ids.slides=await upload(ids.sales.id,'条款.pptx',pptx);
  });
  test.after(async()=>{
    if(app){await app.close();db.close();}
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(temp).startsWith('jit-rag-v4-'));
    rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  });
  test('DOCX/XLSX/PPTX按真实正文及关系顺序提取并保留工作表/幻灯片位置',()=>{
    for(const [ext,bytes,term] of [['docx',docx('真实付款原文'),'真实付款原文'],['xlsx',xlsx,'分期付款'],['pptx',pptx,'违约责任']]){
      const file=path.join(temp,`fixture.${ext}`);writeFileSync(file,bytes);const r=extractFileContent(file,ext);
      assert.equal(r.status,'indexed'); assert.ok(r.blocks.some(b=>b.text.includes(term)));
      if(ext==='xlsx'){assert.equal(r.blocks[0].section,'工作表「付款表」'); assert.equal(r.blocks[0].from,2);}
      if(ext==='pptx'){assert.equal(r.blocks[0].from,1);assert.match(r.blocks[0].text,/违约责任/);}
    }
  });
  test('TXT长段落必须分段，不跨页、不跨工作表合并且内容完整',()=>{
    const text='标题。'+ '这是付款条款的长段落。'.repeat(200);
    const chunks=chunkBlocks([{text,unit:'paragraph',from:1,to:1,page:1},{text:'短页二',unit:'paragraph',from:2,to:2,page:2}], 'pdf');
    assert.ok(chunks.length>3);assert.ok(chunks.every(c=>c.text.length<=CHUNK_MAX_CHARS));
    assert.equal(chunks.filter(c=>c.pageNo===1).map(c=>c.text).join(''),text);assert.equal(chunks.at(-1).pageNo,2);
    const sheets=chunkBlocks([{text:'第一页',unit:'row',from:1,to:1,page:null,section:'甲表'},{text:'第二页',unit:'row',from:2,to:2,page:null,section:'乙表'}],'xlsx');
    assert.equal(sheets.length,2);assert.match(sheets[1].locator,/乙表/);
  });
  test('PDF真实文本提取保留页码，UTF16与超长TXT正确标记截断',()=>{
    const pdf=Buffer.from('%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>> endobj\n4 0 obj <</Type/Font/Subtype/Type1/BaseFont/Helvetica>> endobj\n5 0 obj <</Length 60>> stream\nBT /F1 12 Tf 72 720 Td (payment due in 30 days) Tj ET\nendstream endobj\n%%EOF','latin1');
    const file=path.join(temp,'sample.pdf');writeFileSync(file,pdf);
    const parsed=extractFileContent(file,'pdf');assert.equal(parsed.status,'indexed');assert.equal(parsed.blocks[0].page,1);assert.match(parsed.blocks[0].text,/payment due in 30 days/);
    const txt=path.join(temp,'utf16.txt');writeFileSync(txt,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('付款条款真实文本','utf16le')]));
    assert.match(extractFileContent(txt,'txt').blocks[0].text,/付款条款/);
    writeFileSync(txt,'长'.repeat(450000));const long=extractFileContent(txt,'txt');assert.equal(long.status,'indexed');assert.equal(long.truncated,true);assert.equal(long.blocks[0].text.length,400000);
  });
  test('DOC/XLS/PPT二进制和扫描件明确标记不支持，不生成伪正文',async()=>{
    for(const ext of ['doc','xls','ppt']){
      const f=await upload(ids.purchase.id,`旧格式.${ext}`,Buffer.concat([Buffer.from([0xd0,0xcf,0x11,0xe0]),Buffer.alloc(100)]));
      const s=(await request(`/api/knowledge/attachments/${f.id}/status`,adminCookie,undefined,'GET')).data.items[0];
      assert.equal(s.status,'unsupported');assert.equal(s.chunkCount,0);
    }
  });
  test('同一版本不重复索引，同内容不同附件复用解析但保留独立真实来源',async()=>{
    const count=db.prepare('SELECT COUNT(*) n FROM archive_content_chunks').get().n;
    content.indexFileById(ids.purchaseFile.id);content.syncArchive(ids.purchase.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_content_chunks').get().n,count);
    const stored=db.prepare('SELECT stored_name FROM archive_files WHERE id=?').get(ids.purchaseFile.id).stored_name;
    const duplicate=await upload(ids.sales.id,'采购合同副本.docx',readFileSync(path.join(temp,'files',String(stored))));
    const rows=db.prepare('SELECT sha256 FROM archive_content_units WHERE file_id IN (?,?)').all(duplicate.id,ids.purchaseFile.id);
    assert.equal(rows.length,2);assert.equal(rows[0].sha256,rows[1].sha256);ids.duplicate=duplicate;
  });
  test('跨档案关键词检索、真实引用和每附件最多3条去重',async()=>{
    const r=await search('违约责任',borrowerCookie,{mode:'keyword'});
    assert.equal(r.retrievalMode,'keyword');assert.ok(new Set(r.items.map(i=>i.archiveId)).size>=2);
    for(const row of r.items){assert.equal(row.attachmentId,row.fileId);assert.ok(row.archiveNo&&row.attachmentName&&row.locator&&row.fileVersion);}
    assert.ok(!JSON.stringify(r).includes('雪豹'));
  });
  test('知识库元数据复用实时业务查询，覆盖描述、分类和创建时间并遵守范围',async()=>{
    db.prepare('UPDATE archives SET remarks=? WHERE id=?').run('元数据描述唯一星辰',ids.purchase.id);
    const r=await search('元数据描述唯一星辰',borrowerCookie,{mode:'keyword'});
    assert.equal(r.archives.source,'live_business');assert.ok(r.archives.items.some(a=>a.id===ids.purchase.id));
    assert.equal((await search('元数据描述唯一星辰',borrowerCookie,{mode:'keyword',archiveIds:[ids.sales.id]})).archives.items.length,0);
    db.prepare('UPDATE archives SET remarks=? WHERE id=?').run('已经更新全新银河内容',ids.purchase.id);
    assert.equal((await search('元数据描述唯一星辰',borrowerCookie,{mode:'keyword',archiveIds:[ids.purchase.id]})).archives.items.length,0);
    assert.ok((await search('知识合同',borrowerCookie,{mode:'keyword'})).archives.items.length>0);
    assert.ok((await search(new Date().toISOString().slice(0,10),borrowerCookie,{mode:'keyword'})).archives.items.length>0);
  });
  test('共享正文检索：自然问句、两字词、多词排序、去重、附件范围与真实LIKE降级',async()=>{
    const target=await create('共享检索验收合同');
    const both=await upload(target.id,'双关键词.txt','验收合格后30日内付款。');
    const one=await upload(target.id,'单关键词.txt','仅约定付款。');
    const units=new SqliteContentIndexRepository(db,new SqliteTransaction(db));
    const shared=new ContentKeywordSearchService(units);
    const p={query:'验收 付款',scope:{userId:admin.id,admin:true},archiveIds:[target.id]};
    const combined=shared.search(p);assert.equal(combined.items[0].fileId,both.id);assert.equal(new Set(combined.items.map(r=>r.chunkId)).size,combined.items.length);
    assert.ok(shared.search({...p,query:'什么时候付款'}).items.length>=2);
    assert.equal(shared.search({...p,fileIds:[one.id]}).items.length,1);
    const unified=app.get(UnifiedSearchService).search({keyword:'验收 付款',archiveIds:[target.id],scopes:['content'],limit:20},{id:admin.id,role:'admin'});
    assert.deepEqual(unified.contents.items.map(i=>i.chunkId),combined.items.map(i=>i.chunkId));
    const knowledge=await app.get(KnowledgeSearchService).search({query:'验收 付款',archiveIds:[target.id],mode:'keyword'},{id:admin.id,role:'admin'});
    assert.deepEqual(knowledge.items.map(i=>i.chunkId),combined.items.map(i=>i.chunkId));
    db.exec('DROP TRIGGER content_bigram_insert; DROP TRIGGER content_bigram_update; DROP TRIGGER content_bigram_delete; DROP TRIGGER content_bigram_unit_status; DROP TABLE archive_content_fts_bigram;');
    try{
      const fallback=new ContentKeywordSearchService(new SqliteContentIndexRepository(db,new SqliteTransaction(db))).search(p);
      assert.equal(fallback.retrievalMode,'like');assert.match(fallback.degradedReason,/FTS5/);assert.equal(fallback.items[0].fileId,both.id);
    }finally{assert.equal(ensureContentBigramFts(db),true);}
  });
  test('生成真实Mock向量，纯语义检索可以匹配没有原字面的同义问题',async()=>{
    for(let i=0;i<14;i++)await worker.tick();
    assert.ok(db.prepare('SELECT COUNT(*) n FROM knowledge_embeddings').get().n>0);
    const r=await search('现金流安排',borrowerCookie,{mode:'semantic'});
    assert.equal(r.retrievalMode,'semantic');assert.ok(r.items.length>0);
    assert.ok(r.items.every(i=>!i.text.includes('现金流安排')&&i.relevance.cosine>0.9));
  });
  test('混合RRF排序保留关键词和语义相关度，双命中优先',async()=>{
    const r=await search('付款条款',borrowerCookie);
    assert.equal(r.retrievalMode,'hybrid');assert.ok(r.items[0].relevance.keywordRank);assert.ok(r.items[0].relevance.semanticRank);
    assert.ok(r.items[0].score>=r.items.at(-1).score);
  });
  test('Embedding模型变更时不混用旧向量，重建后使用新模型',async()=>{
    embedding.modelKey='mock-embedding-v2';
    const before=await search('现金流安排',borrowerCookie,{mode:'semantic'});assert.equal(before.retrievalMode,'unavailable');
    for(let i=0;i<14;i++)await worker.tick();
    assert.equal((await search('现金流安排',borrowerCookie,{mode:'semantic'})).retrievalMode,'semantic');
  });
  test('Embedding失败/未配置时关键词继续可用，纯语义如实返回unavailable',async()=>{
    embedding.fail=true;
    try{const r=await search('付款条款',borrowerCookie);assert.equal(r.retrievalMode,'keyword');assert.ok(r.items.length);assert.match(r.degradedReason,/不可用/);}
    finally{embedding.fail=false;}
    embedding.available=false;
    try{const r=await search('现金流安排',borrowerCookie,{mode:'semantic'});assert.equal(r.retrievalMode,'unavailable');assert.equal(r.items.length,0);}
    finally{embedding.available=true;}
  });
  test('附件证据/状态工具执行Schema、归属和当前用户访问校验',async()=>{
    for(const p of [{query:'付款',userId:1},{query:'付款',mode:'fake'},{query:'付款',pageSize:31},{query:'付款',archiveIds:['1']}])assert.equal((await request('/api/knowledge/search',borrowerCookie,p)).status,400);
    assert.equal((await request('/api/knowledge/evidence',borrowerCookie,{attachmentId:ids.secretFile.id})).status,403);
    assert.equal((await request('/api/knowledge/evidence',borrowerCookie,{attachmentId:ids.purchaseFile.id,archiveIds:[ids.sales.id]})).status,400);
    const r=await request('/api/knowledge/evidence',borrowerCookie,{attachmentId:ids.purchaseFile.id});
    assert.equal(r.status,201);assert.ok(r.data.items.every(i=>i.fileId===ids.purchaseFile.id));
    assert.equal((await search('付款',borrowerCookie,{archiveIds:[]})).items.length,0);
    assert.equal((await request('/api/knowledge/status',null,undefined,'GET')).status,401);
    const tools=registry.list().map(t=>t.name);for(const name of ['content.search','content.read'])assert.ok(tools.includes(name));
  for(const name of ['search_document_content','search_knowledge','get_document_evidence','get_attachment_index_status'])assert.ok(!tools.includes(name));
  const plannerTools=registry.listForPlanner().map(t=>t.name);assert.ok(plannerTools.includes('content.search'));assert.ok(!plannerTools.some(name=>['search_document_content','search_knowledge','get_document_evidence','get_attachment_index_status'].includes(name)));
  });
  test('不同用户隔离，借阅授权撤销/到期后向量结果立即失效',async()=>{
    const apply=await request('/api/borrow-requests',borrowerCookie,{archiveId:ids.secret.id,purpose:'测试知识库访问授权',days:1});
    assert.equal(apply.status,201);assert.equal((await request(`/api/borrow-requests/${apply.data.id}/approve`,adminCookie,{})).status,201);
    try{
      assert.ok((await search('现金流安排',borrowerCookie,{mode:'semantic'})).items.some(i=>i.archiveId===ids.secret.id));
      assert.ok(!(await search('现金流安排',otherCookie,{mode:'semantic'})).items.some(i=>i.archiveId===ids.secret.id));
      db.prepare("UPDATE borrow_grants SET expires_at=? WHERE user_id=? AND archive_id=?").run(new Date(Date.now()-10000).toISOString(),borrower.id,ids.secret.id);
      assert.ok(!(await search('现金流安排',borrowerCookie,{mode:'semantic'})).items.some(i=>i.archiveId===ids.secret.id));
    }finally{db.prepare('DELETE FROM borrow_grants WHERE user_id=? AND archive_id=?').run(borrower.id,ids.secret.id);}
  });
  test('等待Embedding期间权限变化，片段返回及模型上下文前再次拦截',async()=>{
    embedding.after=()=>{db.prepare("UPDATE archives SET access_level='restricted' WHERE id=?").run(ids.purchase.id);};
    try{const r=await search('付款条款',borrowerCookie);assert.ok(!r.items.some(i=>i.archiveId===ids.purchase.id));}
    finally{db.prepare("UPDATE archives SET access_level='public' WHERE id=?").run(ids.purchase.id);}
  });
  test('等待Embedding期间撤销管理员角色，旧admin身份不能读取受限向量',async()=>{
    embedding.after=()=>{db.prepare("UPDATE users SET role='borrower' WHERE id=?").run(admin.id);};
    // The archive creator still has access; change ownership to test removal of the admin privilege.
    const owner=db.prepare('SELECT created_by FROM archives WHERE id=?').get(ids.secret.id).created_by;
    db.prepare('UPDATE archives SET created_by=? WHERE id=?').run(other.id,ids.secret.id);
    try{const r=await search('现金流安排',adminCookie,{mode:'semantic'});assert.ok(!r.items.some(i=>i.archiveId===ids.secret.id));}
    finally{db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);db.prepare('UPDATE archives SET created_by=? WHERE id=?').run(owner,ids.secret.id);}
  });
  test('自然语言跨档案问答只向聊天模型提交有权限的原文证据',async()=>{
    model.available=true;model.calls=[];
    try{
      model.plan=fixturePlan();
      const r=await ask('帮我找出所有档案中涉及付款违约责任的内容。',undefined,borrowerCookie);
      assert.ok(r.reply.payload.sources.length>0);assert.ok(new Set(r.reply.payload.sources.map(i=>i.archiveId)).size>=1);
      assert.ok(!JSON.stringify(model.calls).includes('雪豹'));assert.ok(!JSON.stringify(r.reply).includes('999万元'));
    }finally{model.available=false;}
  });
  test('采购/销售合同比较分别定位双方，不误用其他档案',async()=>{
    const r=await planned(fixturePlan([ids.purchase,ids.sales]),'比较一下采购合同和销售合同中的违约责任有什么区别。');
    assert.ok(r.reply.payload.sources?.length,JSON.stringify(r.reply));
    assert.ok(r.reply.payload.sources.every(s=>[ids.purchase.id,ids.sales.id].includes(s.archiveId)));
    assert.ok(new Set(r.reply.payload.sources.map(s=>s.archiveId)).size===2);
  });
  test('采购付款期限问句按合同名称限定范围',async()=>{
    const r=await planned(fixturePlan([ids.purchase]),'我们的采购合同规定了多少天内付款？');
    assert.ok(r.reply.payload.sources?.length);assert.ok(r.reply.payload.sources.every(s=>s.archiveId===ids.purchase.id));
  });
  test('连续对话：PPP摘要→里面付款条款→扩大查找其他合同',async()=>{
    const first=await planned(fixturePlan([ids.ppp]),'PPP合同主要讲了什么？');const cid=first.conversationId;
    assert.ok(first.reply.payload.sources.every(s=>s.archiveId===ids.ppp.id));
    const second=await planned(fixturePlan([], '付款', true),'里面的付款条款呢？',cid);
    assert.ok(second.reply.payload.sources?.length);assert.ok(second.reply.payload.sources.every(s=>s.archiveId===ids.ppp.id));
    const third=await planned(fixturePlan([], '付款', false, true),'有没有其他合同也有类似规定？',cid);
    assert.ok(third.reply.payload.sources?.some(s=>s.archiveId!==ids.ppp.id),JSON.stringify(third.reply));
    assert.ok(third.reply.payload.sources.every(s=>s.archiveId!==ids.ppp.id));
  });
  test('缺少正文证据时诚实返回，不调用模型编造',async()=>{
    const r=await request('/api/knowledge/evidence',borrowerCookie,{attachmentId:ids.purchaseFile.id,query:'完全不存在的火星飞船',mode:'keyword'});
    assert.equal(r.status,201);assert.equal(r.data.items.length,0);
  });
  test('附件版本替换后旧索引及向量立即失效，新版本索引更新',async()=>{
    const archive=await create('版本测试');const f=await upload(archive.id,'版本.txt','旧版唯一正文灯塔付款');
    const actual=db.prepare('SELECT * FROM archive_files WHERE id=?').get(f.id);
    const bytes=Buffer.from('新版唯一正文银河违约');writeFileSync(path.join(temp,'files',String(actual.stored_name)),bytes);
    const {createHash}=await import('node:crypto');db.prepare('UPDATE archive_files SET sha256=? WHERE id=?').run(createHash('sha256').update(bytes).digest('hex'),f.id);
    assert.equal((await search('灯塔付款',borrowerCookie,{mode:'keyword',archiveIds:[archive.id]})).items.length,0,'重建前也不能使用旧哈希正文');
    content.indexFileById(f.id);assert.equal((await search('灯塔付款',borrowerCookie,{mode:'keyword',archiveIds:[archive.id]})).items.length,0);
    assert.ok((await search('银河违约',borrowerCookie,{mode:'keyword'})).items.some(i=>i.fileId===f.id));
  });
  test('附件/档案删除级联清理正文、FTS、任务与向量',async()=>{
    const archive=await create('删除测试');const f=await upload(archive.id,'待删除.txt','删除测试专用正文');
    for(let i=0;i<5;i++)await worker.tick();
    app.get(FileRepository).delete(f.id);
    for(const table of ['archive_content_units','archive_content_chunks','knowledge_index_jobs'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE file_id=?`).get(f.id).n,0);
    assert.equal((await search('删除测试专用',borrowerCookie,{mode:'keyword'})).items.length,0);
    assert.equal((await request(`/api/archives/${archive.id}`,adminCookie,undefined,'DELETE')).status,200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM knowledge_embeddings WHERE chunk_id NOT IN (SELECT id FROM archive_content_chunks)').get().n,0);
  });
  test('检测到磁盘内容哈希不一致时清除旧证据并记录真实失败原因',async()=>{
    const archive=await create('哈希校验测试');const f=await upload(archive.id,'校验.txt','哈希校验专用旧正文');
    const row=db.prepare('SELECT stored_name FROM archive_files WHERE id=?').get(f.id);
    writeFileSync(path.join(temp,'files',String(row.stored_name)),'被直接改动的文件实体');
    content.indexFileById(f.id,true);
    const job=db.prepare('SELECT * FROM knowledge_index_jobs WHERE file_id=?').get(f.id);
    assert.equal(job.status,'failed');assert.match(job.message,/哈希/);
    assert.equal((await search('哈希校验专用旧正文',borrowerCookie,{mode:'keyword',archiveIds:[archive.id]})).items.length,0);
  });
  test('索引失败持久化、管理员重试、完整恢复成功且非管理员不能重试',async()=>{
    const archive=await create('失败测试');const f=await upload(archive.id,'重试.txt','重试的原始正文');
    const row=db.prepare('SELECT * FROM archive_files WHERE id=?').get(f.id), stored=path.join(temp,'files',String(row.stored_name)), bytes=readFileSync(stored);
    rmSync(stored);content.indexFileById(f.id,true);
    assert.equal(db.prepare('SELECT status FROM knowledge_index_jobs WHERE file_id=?').get(f.id).status,'failed');
    assert.equal((await request(`/api/knowledge/attachments/${f.id}/retry`,borrowerCookie,{})).status,403);
    writeFileSync(stored,bytes);assert.equal((await request(`/api/knowledge/attachments/${f.id}/retry`,adminCookie,{})).status,201);
    content.indexFileById(f.id);assert.equal(content.describe(archive.id)[0].status,'indexed');
  });
  test('Embedding任务失败记录原因和重试，关键词结果始终可用',async()=>{
    embedding.fail=true;
    const f=await upload(ids.purchase.id,'向量失败.txt','付款条款：本期应支付123元。');
    try{for(let i=0;i<20;i++)await worker.tick();assert.equal(db.prepare('SELECT embedding_status FROM knowledge_index_jobs WHERE file_id=?').get(f.id).embedding_status,'failed');}
    finally{embedding.fail=false;}
    assert.ok((await search('本期应支付',borrowerCookie,{mode:'keyword'})).items.some(r=>r.fileId===f.id));
    db.prepare('UPDATE knowledge_index_jobs SET embedding_attempts=0,embedding_retry_at=0 WHERE file_id=?').run(f.id);
    for(let i=0;i<8;i++)await worker.tick();assert.equal(db.prepare('SELECT embedding_status FROM knowledge_index_jobs WHERE file_id=?').get(f.id).embedding_status,'indexed');
  });
  test('服务重启恢复processing任务，历史补录和重复扫描不膨胀',async()=>{
    const before=db.prepare('SELECT COUNT(*) n FROM archive_content_chunks').get().n;
    db.prepare("UPDATE knowledge_index_jobs SET status='processing',embedding_status='processing' WHERE file_id=?").run(ids.pppFile.id);
    worker.onModuleInit();assert.equal(db.prepare('SELECT status FROM knowledge_index_jobs WHERE file_id=?').get(ids.pppFile.id).status,'pending');
    for(let i=0;i<5;i++)await worker.tick();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_content_chunks').get().n,before);
    assert.equal((await request('/api/knowledge/backfill',borrowerCookie,{})).status,403);
    assert.ok((await request('/api/knowledge/backfill',adminCookie,{afterId:0})).data.scanned>0);
    const second=openDatabase(path.join(temp,'test.db'));assert.ok(second.prepare("SELECT 1 FROM _migrations WHERE id='109-knowledge-rag'").get());second.close();
  });
  test('管理计数按权限统计、不泄露其他用户附件或密钥',async()=>{
    const r=await request('/api/knowledge/status',borrowerCookie,undefined,'GET');assert.equal(r.status,200);
    assert.equal(r.data.total,r.data.indexed+r.data.pending+r.data.processing+r.data.failed+r.data.unsupported);
    assert.ok(!JSON.stringify(r.data).includes('API_KEY'));
    assert.equal((await request(`/api/knowledge/attachments/${ids.secretFile.id}/status`,borrowerCookie,undefined,'GET')).status,403);
  });
  test('实际关闭并重新启动服务后恢复未完成任务且数据不重复',async()=>{
    const count=db.prepare('SELECT COUNT(*) n FROM archive_content_chunks').get().n;
    db.prepare("UPDATE knowledge_index_jobs SET status='processing',embedding_status='processing' WHERE file_id=?").run(ids.pppFile.id);
    await app.close();db.close();
    ({app,baseUrl}=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:false,
      aiModelClient:model,embeddingClient:embedding,knowledgeWorker:false}));
    db=app.get(DATABASE);worker=app.get(KnowledgeWorker);content=app.get(ContentIndexService);registry=app.get(AgentToolRegistry);
    assert.equal(db.prepare('SELECT status FROM knowledge_index_jobs WHERE file_id=?').get(ids.pppFile.id).status,'pending');
    for(let i=0;i<5;i++)await worker.tick();
    assert.equal(db.prepare('SELECT status FROM knowledge_index_jobs WHERE file_id=?').get(ids.pppFile.id).status,'indexed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM archive_content_chunks').get().n,count);
  });
});

test('独立Embedding HTTP适配器不读取聊天配置、顺序/维度/错误体/密钥隔离',async()=>{
  const disabled=new HttpEmbeddingClient({JIT_AI_API_KEY:'chat-only',JIT_AI_MODEL:'chat'});assert.equal(disabled.available,false);
  let sent;
  const client=new HttpEmbeddingClient({JIT_EMBEDDING_API_BASE:'https://embedding.example/v1',JIT_EMBEDDING_MODEL:'vectors',JIT_EMBEDDING_API_KEY:'server-secret'},
    async(url,options)=>{sent={url,options};return new Response(JSON.stringify({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]}));});
  assert.deepEqual(await client.embed(['a','b']),[[1,0],[0,1]]);assert.equal(sent.url,'https://embedding.example/v1/embeddings');
  assert.equal(sent.options.headers.Authorization,'Bearer server-secret');assert.ok(!client.modelKey.includes('secret'));
  const bad=new HttpEmbeddingClient({JIT_EMBEDDING_API_BASE:'https://embedding.example/v1',JIT_EMBEDDING_MODEL:'vectors',JIT_EMBEDDING_API_KEY:'server-secret'},async()=>new Response('server-secret document contents',{status:500}));
  await assert.rejects(bad.embed(['a']),error=>!error.message.includes('server-secret')&&!error.message.includes('document contents'));
});
