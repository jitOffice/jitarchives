import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {openDatabase,ensureContentFts,DATABASE} from '../dist/db/database.js';
import {extractFileContent} from '../dist/archives/content/content.extract.js';
import {KnowledgeWorker} from '../dist/knowledge/knowledge-worker.service.js';
import {ContentIndexService} from '../dist/archives/content/content-index.service.js';
import {bootstrap} from '../dist/main.js';
import {fileURLToPath} from 'node:url';

test('FTS history repair is transactional, idempotent, and synchronized for every writer',()=>{
  const temp=mkdtempSync(path.join(tmpdir(),'jit-fts-repair-'));const file=path.join(temp,'test.db');let db=openDatabase(file);
  try{
    db.exec(`DROP TRIGGER content_fts_insert; DROP TRIGGER content_fts_update; DROP TRIGGER content_fts_unit_status; DROP TRIGGER knowledge_fts_cleanup;
      DELETE FROM _migrations WHERE id='111-content-fts-backfill';
      INSERT INTO archive_content_units(id,archive_id,file_id,stored_name,status,indexed_at) VALUES(1,1,1,'history.txt','indexed','2020');
      INSERT INTO archive_content_chunks(id,unit_id,archive_id,file_id,chunk_no,locator,text) VALUES(1,1,1,1,1,'TXT 第1行','历史采购合同');
      INSERT INTO archive_content_fts(rowid,body) VALUES(999,'孤立索引');`);
    assert.equal(ensureContentFts(db),true);
    assert.deepEqual(db.prepare('SELECT rowid,body FROM archive_content_fts').all().map(r=>({...r})),[{rowid:1,body:'历史采购合同'}]);
    const stamp=db.prepare("SELECT applied_at FROM _migrations WHERE id='111-content-fts-backfill'").get().applied_at;
    db.close();db=openDatabase(file);
    assert.equal(db.prepare("SELECT applied_at FROM _migrations WHERE id='111-content-fts-backfill'").get().applied_at,stamp);
    db.exec("INSERT INTO archive_content_chunks(unit_id,archive_id,file_id,chunk_no,locator,text) VALUES(1,1,1,2,'TXT 第2行','付款期限'); UPDATE archive_content_chunks SET text='付款验收' WHERE id=1;");
    assert.equal(db.prepare('SELECT body FROM archive_content_fts WHERE rowid=1').get().body,'付款验收');
    assert.equal(db.prepare('SELECT count(*) n FROM archive_content_fts').get().n,2);
    db.exec("UPDATE archive_content_units SET status='failed' WHERE id=1");assert.equal(db.prepare('SELECT count(*) n FROM archive_content_fts').get().n,0);
    db.exec("UPDATE archive_content_units SET status='indexed' WHERE id=1; DELETE FROM archive_content_units WHERE id=1");
    assert.equal(db.prepare('SELECT count(*) n FROM archive_content_fts').get().n,0);
    db.exec(`DELETE FROM _migrations WHERE id='111-content-fts-backfill'; INSERT INTO archive_content_fts(rowid,body) VALUES(999,'回滚测试');
      CREATE TRIGGER reject_fts_marker BEFORE INSERT ON _migrations WHEN NEW.id='111-content-fts-backfill' BEGIN SELECT RAISE(ABORT,'test rollback'); END;`);
    assert.equal(ensureContentFts(db),false);assert.equal(db.prepare('SELECT body FROM archive_content_fts WHERE rowid=999').get().body,'回滚测试');
    assert.equal(db.prepare("SELECT 1 FROM _migrations WHERE id='111-content-fts-backfill'").get(),undefined);
    db.exec('DROP TRIGGER reject_fts_marker');assert.equal(ensureContentFts(db),true);
  }finally{db.close();rmSync(temp,{recursive:true,force:true});}
});

// Real PDF bytes with valid xref/trailer. Covers compressed streams and embedded CMap, not mocked extraction.
function pdf({compressed=false,cjk=false,scan=false,encrypted=false}={}){
  const operations=Buffer.from(cjk?'BT /F1 12 Tf <000100020003> Tj ET':'BT /F1 12 Tf (payment due in 30 days) Tj ET','latin1');
  const bytes=compressed?deflateSync(operations):operations;
  const font=cjk?'<</Type/Font/Subtype/Type0/Encoding/Identity-H/ToUnicode 6 0 R>>':'<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>';
  const cmap='1 beginbfchar\n<0001> <4ED8>\nendbfchar\n2 beginbfchar\n<0002> <6B3E>\n<0003> <65E5>\nendbfchar';
  const objects=['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R]/Count 1>>',`<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 800]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>`,font,
    scan?'<</Subtype/Image/Width 1/Height 1/Length 1>>\nstream\nx\nendstream':`<</Length ${bytes.length}${compressed?'/Filter/FlateDecode':''}>>\nstream\n${bytes.toString('latin1')}\nendstream`,
    `<</Length ${cmap.length}>>\nstream\n${cmap}\nendstream`];
  let text='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(Buffer.byteLength(text,'latin1'));text+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=Buffer.byteLength(text,'latin1');text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<</Size ${objects.length+1}/Root 1 0 R${encrypted?'/Encrypt 9 0 R':''}>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text,'latin1');
}
test('PDF actual bytes: plain, Flate, Chinese CMap sections, WinAnsi, corrupt, encrypted, scanned',()=>{
 const temp=mkdtempSync(path.join(tmpdir(),'jit-real-pdf-'));try{
  for(const options of [{},{compressed:true},{compressed:true,cjk:true}]){
   const file=path.join(temp,'sample.pdf');writeFileSync(file,pdf(options));const result=extractFileContent(file,'pdf');
   assert.equal(result.status,'indexed');assert.equal(result.blocks[0].page,1);assert.match(result.blocks[0].text,options.cjk?/付款日/:/payment due in 30 days/);
  }
  for(const [bytes,status] of [[pdf({encrypted:true}),'encrypted'],[pdf({scan:true}),'scanned'],[Buffer.from('%PDF-1.7 broken'),'corrupt'],[Buffer.from('broken pdf'),'corrupt']]){
   const file=path.join(temp,'bad.pdf');writeFileSync(file,bytes);const result=extractFileContent(file,'pdf');assert.equal(result.status,status);assert.equal(result.blocks.length,0);
  }
 }finally{rmSync(temp,{recursive:true,force:true});}
});

test('真实ReportLab/pypdf文件兼容：ASCII85+Flate、中文CID、WinAnsi、扫描和密码加密',()=>{
 const fixtures=path.join(path.dirname(fileURLToPath(import.meta.url)),'fixtures','pdf');
 for(const [name,status,expected] of [['plain','indexed',/30 days/],['compressed','indexed',/30 days/],['chinese','indexed',/验收合格后30日/],['winansi','indexed',/Café € 1\.5/],['scanned','scanned'],['encrypted','encrypted'],['damaged','corrupt']]){
  const result=extractFileContent(path.join(fixtures,name+'.pdf'),'pdf');assert.equal(result.status,status,name);if(expected)assert.match(result.blocks.map(b=>b.text).join(''),expected);else assert.equal(result.blocks.length,0);
 }
});

test('upload persists pending job; background extraction, leases, durable scan and bounded retry survive restart',async()=>{
 const temp=mkdtempSync(path.join(tmpdir(),'jit-index-jobs-'));let app,db;
 const disabled={available:false,modelKey:'mock-disabled',async embed(){throw new Error('must not call');}};
 try{
  const result=await bootstrap({port:0,dbFile:path.join(temp,'test.db'),fileStoreDir:path.join(temp,'files'),serveWeb:false,knowledgeWorker:false,embeddingClient:disabled,aiModelClient:{available:false,model:'mock',async chatCompletion(){throw new Error('must not call');}}});
  app=result.app;db=app.get(DATABASE);const content=app.get(ContentIndexService),worker=app.get(KnowledgeWorker);
  let cookie='';const call=async(url,body,raw=false)=>{const r=await fetch(result.baseUrl+url,{method:'POST',headers:{Cookie:cookie,'Content-Type':raw?'application/octet-stream':'application/json'},body:raw?body:JSON.stringify(body)});const session=r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/)?.[1];if(session)cookie=`jit_sid=${session}`;assert.equal(r.status,201);return r.json();};
  await call('/api/auth/init-admin',{username:'reliability',password:'Admin#12345',displayName:'索引测试'});
  const category=await call('/api/categories',{name:'可靠性',code:'INDEX'});
  const archive=await call('/api/archives',{title:'后台测试',categoryId:category.id,archiveType:'文书档案'});
  const file=await call(`/api/archive-files/upload?archiveId=${archive.id}&name=contract.txt`,Buffer.from('验收合格后30日付款'),true);
  assert.equal(db.prepare('SELECT status FROM knowledge_index_jobs WHERE file_id=?').get(file.id).status,'pending');
  assert.equal(db.prepare('SELECT count(*) n FROM archive_content_chunks').get().n,0,'upload never parses synchronously');
  const concurrent=await Promise.all([content.indexFileInBackground(file.id),content.indexFileInBackground(file.id)]);assert.equal(concurrent.filter(Boolean).length,1);
  assert.equal(content.describe(archive.id)[0].status,'indexed');
  await worker.tick();const checkpoint={...db.prepare('SELECT * FROM knowledge_scan_state').get()};assert.equal(checkpoint.completed,1);
  const second=new KnowledgeWorker(db,content,disabled);second.onModuleInit();await second.tick();
  assert.deepEqual({...db.prepare('SELECT * FROM knowledge_scan_state').get()},checkpoint,'completed scan never runs again');
  db.prepare("UPDATE knowledge_index_jobs SET status='processing',attempts=1,lease_until=0 WHERE file_id=?").run(file.id);await second.tick();
  assert.equal(content.describe(archive.id)[0].status,'indexed');
  db.prepare("UPDATE knowledge_index_jobs SET status='processing',attempts=3,lease_until=0 WHERE file_id=?").run(file.id);await second.tick();
  assert.equal(db.prepare('SELECT status FROM knowledge_index_jobs WHERE file_id=?').get(file.id).status,'failed');
  // Persist a partial 50-file checkpoint, then replace the worker to simulate restart mid-scan.
  db.exec('DELETE FROM knowledge_scan_state');
  for(let i=0;i<51;i++)db.prepare(`INSERT INTO archive_files(archive_id,original_name,stored_name,extension,file_size,content_type,sha256,uploaded_by,uploaded_at)
    SELECT archive_id,original_name,?,extension,file_size,content_type,sha256,uploaded_by,uploaded_at FROM archive_files WHERE id=?`).run(`history-${i}.txt`,file.id);
  await second.tick();const partial=db.prepare('SELECT * FROM knowledge_scan_state').get();assert.equal(partial.cursor,50);assert.equal(partial.completed,0);
  const resumed=new KnowledgeWorker(db,content,disabled);resumed.onModuleInit();await resumed.tick();
  const complete=db.prepare('SELECT * FROM knowledge_scan_state').get();assert.equal(complete.cursor,52);assert.equal(complete.completed,1);
  assert.equal(db.prepare('SELECT count(*) n FROM knowledge_index_jobs').get().n,52);await resumed.onModuleDestroy();
  await second.onModuleDestroy();
 }finally{if(app)await app.close();if(db)db.close();rmSync(temp,{recursive:true,force:true});}
});
