import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {bootstrap} from '../dist/main.js';
import {DATABASE} from '../dist/db/database.js';
import {ContentIndexService} from '../dist/archives/content/content-index.service.js';
import {judgeSufficiency, emptyCoverage, isCoverageIncomplete} from '../dist/agent/evidence.assessment.js';
import {withExecutionBudget, executionBudget, budgetedModel} from '../dist/agent/execution.budget.js';
import {AgentToolDispatcher} from '../dist/agent/tool.dispatcher.js';
import {emptyRetrievalPlan, validateRetrievalPlan, validatePlanSteps} from '../dist/agent/retrieval.plan.js';
import {buildCjkBigramTerms} from '../dist/search/cjk-bigram.js';

// wire：剥去服务端字段，模拟规划器只回传“线索/计划”，原始问题由后端强制保留。
const wire = plan => { const {originalQuestion, normalizedQuestion, ...rest} = plan; return rest; };

test('validatePlanSteps fails closed on injected ids, unknown tools and illegal scope references', () => {
  const ok = validatePlanSteps([{id: 's1', tool: 'content.search', intent: '定位结算正文', expects: 'relevantText', args: {query: '结算 尾款 支付 期限'}}]);
  assert.equal(ok.length, 1);
  // 数值 ID / 身份 / 未知键一律拒绝（模型绝不能自填作用域）。
  assert.throws(() => validatePlanSteps([{id: 's1', tool: 'content.read', intent: 'x', expects: 'fullText', args: {archiveIds: [1]}}]), /Unexpected step arg key/);
  assert.throws(() => validatePlanSteps([{id: 's1', tool: 'evil.tool', intent: 'x', expects: 'metadata', args: {}}]), /Invalid retrieval enum/);
  assert.throws(() => validatePlanSteps([{id: 's1', tool: 'search_knowledge', intent: 'x', expects: 'metadata', args: {userId: 1}}]), /Invalid retrieval enum/);
  // 参考对象槽位越界（>CONTEXT_LIMITS.entities）被拒。
  assert.throws(() => validatePlanSteps([{id: 's1', tool: 'attachment.search', intent: 'x', expects: 'attachmentNames', args: {}, contextRef: {entity: 'archive', slot: 99}}]), /Invalid slot/);
});

test('dynamic plan executor runs FTS5 CJK Bigram + BM25 search, grounded AI answer, permission filter and fail-closed fallback', {timeout: 90000}, async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jit-dyn-'));
  let app, db, active, mode = 'happy';
  const calls = []; let repairRemaining = 0; let afterAnswer;
  let embeddingCalls = 0;
  const embedding = {available:true,modelKey:'unused-embedding-must-not-be-called',async embed(){embeddingCalls += 1;throw Error('Agent must not call Embedding');}};
  const model = {available: true, provider: 'mock-deepseek', model: 'mock-dynamic-executor', async chatCompletion(messages) {
    calls.push(structuredClone(messages));
    if (messages[0].content.startsWith('RETRIEVAL_PLAN_V1')) {
      if (mode === 'repairOnce' && repairRemaining++ === 0) return {content:'{}',truncated:false};
      if (mode === 'failclosed') return {content: JSON.stringify({...wire(active), planSteps: [{id: 'bad', tool: 'content.search', intent: '注入', expects: 'relevantText', args: {archiveIds: [1]}}]}), truncated: false};
      return {content: JSON.stringify(wire(active)), truncated: false};
    }
    if (messages[0].content.startsWith('EVIDENCE_SUFFICIENCY_V1')) {
      if (mode === 'insufficient') return {content:JSON.stringify({verdict:'insufficient',note:'命中资料与问题没有足够关联',supplement:[]}),truncated:false};
      if (mode === 'judgeFail') throw new Error('timeout');
      if (mode === 'supplement' && JSON.parse(messages[1].content).coverage.processedChunks === 0) return {content:JSON.stringify({verdict:'supplement',note:'需读取全文',supplement:[{id:'supplement-full',tool:'content.read',intent:'读已定位对象',expects:'fullText',args:{},scope:'step:located'}]}),truncated:false};
      return { content: JSON.stringify({verdict:'sufficient',note:'fixture evidence checked',supplement:[]}), truncated:false };
    }
    if(afterAnswer){const hook=afterAnswer;afterAnswer=undefined;await hook();}
    const items = [...messages.at(-1).content.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
    assert.ok(items.length, 'answer must receive actual grounded evidence');
    const claims = items.map(([, ref, quote]) => ({text: quote, citations: [ref], evidenceQuote: quote}));
    return {content: JSON.stringify({answer: claims.map(c => c.text).join('；'), claims}), truncated: false};
  }};
  try {
    const server = await bootstrap({port: 0, dbFile: path.join(dir, 'test.db'), fileStoreDir: path.join(dir, 'files'), serveWeb: false, knowledgeWorker: false, aiModelClient: model,
      embeddingClient: embedding});
    app = server.app; db = app.get(DATABASE);
    const api = async (url, cookie = '', body, method = 'POST', raw = false) => {const r = await fetch(server.baseUrl + '/api' + url, {method, headers: {Cookie: cookie, 'Content-Type': raw ? 'application/octet-stream' : 'application/json'}, body: method === 'GET' ? undefined : raw ? body : JSON.stringify(body ?? {})}); return {status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[0]};};
    const admin = (await api('/auth/init-admin', '', {username: 'dyn_admin', password: 'Admin#12345', displayName: '动态执行测试'})).cookie;
    assert.equal((await api('/users', admin, {username: 'dyn_borrower', password: 'User#12345', displayName: 'borrower', role: 'borrower'})).status, 201);
    const borrower = (await api('/auth/login', '', {username: 'dyn_borrower', password: 'User#12345'})).cookie;
    const cat = (await api('/categories', admin, {name: '科研设备', code: 'SCI'})).data;
    const create = async (title, extra = {}) => (await api('/archives', admin, {title, categoryId: cat.id, archiveType: '文书档案', ...extra})).data;
    const upload = async (a, name, body) => {const r = await api(`/archive-files/upload?archiveId=${a.id}&name=${encodeURIComponent(name)}`, admin, Buffer.from(body), 'POST', true); app.get(ContentIndexService).indexFileById(r.data.id); return r.data;};
    const a = await create('采购台账甲', {responsible: '青岚仪器'});
    const file = await upload(a, '光谱仪交接纪要.txt', '结算期限：验收完成后四十五日内支付尾款。\n供应商青岚仪器负责安装调试。');
    const secret = await create('隔离台账', {accessLevel: 'restricted'});
    await upload(secret, '密级文档.txt', '暗紫秘钥业务：付款密码9931。');

    const ask = async (q, cookie) => {const r = await api('/agent/ask', cookie, {question: q}); assert.equal(r.status, 201, JSON.stringify(r)); return r.data;};
    const dynPlan = (query, allowExpansion = false) => {const p = emptyRetrievalPlan(''); p.responseMode = 'content_qa'; p.allowExpansion = allowExpansion;
      p.planSteps = [{id: 's1', tool: 'content.search', intent: '定位结算/密级正文', expects: 'relevantText', args: {query}}]; return p;};

    await t.test('dynamic planSteps produce an FTS5/BM25-grounded content answer with traceable citations', async () => {
      mode = 'happy'; active = dynPlan('结算 尾款 支付 期限 四十五日');
      const before = calls.length; const r = await ask('想核实一下，光谱仪交付后账期究竟怎么算', admin);
      assert.equal(r.reply.payload.plannerCall.status, 'success');
      assert.equal(r.reply.payload.kind, 'content_answer', JSON.stringify(r.reply));
      // 正文检索固定走 SQLite FTS5 CJK Bigram + BM25；Agent 不调用 Embedding 或旧 Hybrid 工具。
      assert.ok(r.reply.payload.toolResults.some(x => x.toolName === 'content.search'), 'content step must run lexical content.search');
      assert.ok(r.reply.payload.toolResults.some(x => x.toolName === 'content.search' && x.data?.retrievalMode === 'fts5'), 'FTS5 must be the primary retrieval mode');
      assert.ok(!r.reply.payload.toolResults.some(x => ['search_knowledge','search_document_content'].includes(x.toolName)), 'legacy semantic tools must not be called');
      assert.equal(embeddingCalls, 0, 'Agent retrieval must not call Embedding');
      assert.ok(calls.length >= before + 2, 'planning plus grounded answer model calls');
      assert.ok(r.reply.payload.sources.every(s => s.archiveId === a.id && s.fileId === file.id && s.locator));
      assert.ok(calls.at(-1).at(-1).content.includes('四十五日') || r.reply.content.includes('四十五日'));
      assert.equal(r.reply.payload.retrievalPlan.planSteps.length, 1, 'dynamic plan steps are preserved on the payload');
    });

    await t.test('reference/attachment step resolves to backend-authorized slots only', async () => {
      mode = 'happy'; active = dynPlan('尾款 结算 期限');
      // 无 contextRef：在全库检索，仍能命中真实正文（说明 allAuthorized 默认检索域生效）。
      const r = await ask('那批设备交付之后尾款什么时候结清', admin);
      assert.equal(r.reply.payload.kind, 'content_answer');
      assert.ok(r.reply.payload.sources.length > 0);
    });

    await t.test('permission is enforced: a non-authorized role never leaks restricted content', async () => {
      mode = 'happy'; active = dynPlan('暗紫 秘钥 付款 密码');
      const adminHit = await ask('那宗暗紫业务的实际约定是什么', admin);
      assert.equal(adminHit.reply.payload.kind, 'content_answer');
      assert.ok(adminHit.reply.payload.sources.some(s => s.archiveId === secret.id));
      const before = calls.length; const gated = await ask('那宗暗紫业务的实际约定是什么', borrower);
      // borrower 无权访问 restricted 档案：动态执行器经 canView 过滤后无授权证据 → 不编造、不调用作答模型、绝不泄漏密码。
      assert.equal(gated.reply.payload.kind, 'content_no_evidence', JSON.stringify(gated.reply));
      assert.equal(gated.reply.payload.sources.length, 0);
      assert.doesNotMatch(JSON.stringify(gated), /付款密码9931/);
      assert.equal(calls.length, before + 1, 'a plan that forbids expansion skips the redundant sufficiency model call and never generates an answer without authorized evidence');
    });

    await t.test('metadata miss does not block independent attachment title lookup and exact full read', async () => {
      mode = 'happy';
      const other = await upload(a, '无关附件.txt', '不能误读的另一附件。');
      active = emptyRetrievalPlan(''); active.responseMode = 'find'; active.allowExpansion = false;
      active.planSteps = [
        {id:'meta', tool:'archive.search', intent:'查元数据', expects:'metadata', args:{keyword:'不存在的档案标题'}},
        {id:'files', tool:'attachment.search', intent:'独立查附件标题', expects:'attachmentNames', args:{attachmentFileName:'光谱仪交接纪要'}},
        {id:'read', tool:'content.read', intent:'只读指定附件全文', expects:'fullText', args:{}, scope:'step:files'},
      ];
      const r = await ask('请完整核对交接纪要，资料可能没有把设备名称写进档案标题', admin);
      assert.equal(r.reply.payload.kind, 'content_answer', JSON.stringify(r.reply));
      assert.ok(r.reply.payload.sources.every(s => s.fileId === file.id));
      assert.ok(!r.reply.payload.sources.some(s => s.fileId === other.id));
      assert.equal(r.reply.payload.toolResults.find(r => r.callId === 'meta').total, 0);
      const read = r.reply.payload.toolResults.find(r => r.callId === 'read');
      assert.ok(read.data.items.length > 0);
      assert.equal(read.data.items.length, read.data.indexStatuses[0].chunkCount);
      assert.equal(r.reply.payload.coverage.fullTextGaps, 0);
    });

    await t.test('multi attachment complete reads and current context reference use AI planning', async () => {
      mode = 'happy'; active = emptyRetrievalPlan(''); active.responseMode = 'summary'; active.allowExpansion = false;
      active.hardConstraints.archiveNumbers = [a.archiveNo];
      active.planSteps = [{id:'read-all',tool:'content.read',intent:'逐附件完整读取',expects:'fullText',args:{}}];
      const first = await ask('把这宗采购的各份附件分别读完再说明', admin);
      assert.equal(first.reply.payload.kind, 'content_answer', JSON.stringify(first.reply));
      assert.equal(new Set(first.reply.payload.sources.map(s => s.fileId)).size, 2);
      assert.equal(first.reply.payload.coverage.expectedFiles, 2);
      assert.equal(first.reply.payload.coverage.processedFiles, 2);
      active = emptyRetrievalPlan(''); active.allowExpansion = false;
      active.planSteps = [{id:'context',tool:'content.read',intent:'理解上文附件指代',expects:'fullText',args:{},contextRef:{entity:'attachment',slot:1}}];
      const next = await api('/agent/ask', admin, {question:'刚才第一份的约定再核对一下',conversationId:first.conversation.id});
      assert.equal(next.data.reply.payload.plannerCall.status, 'success');
      assert.equal(new Set(next.data.reply.payload.sources.map(s => s.fileId)).size, 1);
      assert.equal(next.data.reply.payload.sources[0].fileId, first.reply.payload.sources[0].fileId);
      const plannerInput = calls.filter(c => c[0].content.startsWith('RETRIEVAL_PLAN_V1')).at(-1)[1].content;
      assert.ok(JSON.parse(plannerInput).context.attachmentSlots.length > 0);
    });

    await t.test('unverified context slots never become a global search', async () => {
      active = dynPlan('结算'); active.planSteps[0].contextRef = {entity:'attachment',slot:24};
      const r = await ask('以会话中的指定资料核对', admin);
      assert.equal(r.reply.payload.plannerCall.status, 'success');
      assert.equal(r.reply.payload.items.length, 0);
      assert.ok(!r.reply.payload.sources?.length);
      assert.ok(r.reply.payload.toolResults.every(result => result.status !== 'success'), 'invalid context reference must not widen into a global query');
    });

    await t.test('sufficiency timeout remains unknown and limits the answer', async () => {
      mode = 'judgeFail'; active = dynPlan('结算 期限', true);
      const r = await ask('核对账期依据是否够用', admin);
      assert.equal(r.reply.payload.sufficiency.verdict, 'unknown');
      assert.ok(r.reply.payload.limitations?.some(note => note.includes('尚未完成全面分析')),
        'when sufficiency cannot be confirmed, the user-facing limitation is exposed in the dedicated limitations panel');
    });

    await t.test('one supplement can bind the authorized first-round result and is reassessed', async () => {
      mode='supplement';active=emptyRetrievalPlan('');active.allowExpansion=true;
      active.planSteps=[{id:'located',tool:'archive.search',intent:'定位档案',expects:'metadata',args:{archiveNo:a.archiveNo}}];
      const r=await ask('需要核对已定位材料是否足够完整',admin);
      assert.equal(r.reply.payload.retrievalRounds,2,JSON.stringify(r.reply));
      assert.equal(r.reply.payload.sufficiency.verdict,'sufficient');
      assert.ok(r.reply.payload.toolResults.some(x=>x.callId==='supplement-full'&&x.toolName==='content.read'&&x.status==='success'));
      assert.ok(r.reply.payload.sources.every(s=>s.archiveId===a.id));
    });
    await t.test('invalid format is repaired once before tools execute', async () => {
      mode='repairOnce';repairRemaining=0;active=dynPlan('结算');
      const before=calls.filter(c=>c[0].content.startsWith('RETRIEVAL_PLAN_V1')).length;
      const r=await ask('换个表达核对支付约定',admin);
      assert.equal(r.reply.payload.kind,'content_answer');
      assert.equal(calls.filter(c=>c[0].content.startsWith('RETRIEVAL_PLAN_V1')).length-before,2);
    });
    await t.test('AI-generated lexical variants and reference similarity use FTS5 without Embedding', async () => {
      mode='happy';
      const similar=await create('散存卷宗乙');
      await upload(similar,'业务约定.txt','结算期限为验收完成后四十五日支付尾款。');

      // DeepSeek 将自然语言概念转成多个词法线索；服务端统一交给 FTS5/BM25。
      active=dynPlan('费用清偿时点');
      active.contentTerms=['结算期限'];
      active.semanticConcepts=['尾款支付'];
      const lexical=await ask('用描述性的说法寻找结算资料',admin);
      assert.equal(lexical.reply.payload.kind,'content_answer');
      assert.ok(lexical.reply.payload.toolResults.some(r=>r.toolName==='content.search' && r.data?.retrievalMode==='fts5'));
      assert.ok(lexical.reply.payload.sources.some(source=>source.fileId===file.id));
      assert.equal(embeddingCalls,0,'no Embedding calls are allowed');

      // 先通过会话槽位读取真实附件，再以它为词法特征种子查找其它可访问资料。
      active=emptyRetrievalPlan('');active.allowExpansion=false;
      active.planSteps=[
        {id:'file',tool:'attachment.search',intent:'定位参考附件',expects:'attachmentNames',args:{attachmentFileName:'光谱仪交接纪要'}},
        {id:'read',tool:'content.read',intent:'完整参考内容',expects:'fullText',args:{},scope:'step:file'},
      ];
      const first=await ask('完整阅读交接纪要作为参考',admin);
      active=dynPlan('付款');
      active.referenceSlots=[{entity:'attachment',slot:1}];
      active.searchScope={kind:'fromReference'};
      const next=await api('/agent/ask',admin,{question:'再找其他内容类似的资料',conversationId:first.conversation.id});
      assert.equal(next.data.reply.payload.kind,'content_answer',JSON.stringify(next.data.reply));
      assert.ok(next.data.reply.payload.sources.some(source=>source.archiveId===similar.id),JSON.stringify(next.data.reply));
      assert.ok(next.data.reply.payload.sources.every(source=>source.archiveId!==a.id),'reference archive must not be returned as its own similar result');
      assert.equal(embeddingCalls,0,'reference similarity must remain lexical and must not call Embedding');
    });

    await t.test('real but irrelevant hits are not composed into an answer after insufficient judgement', async () => {
      mode='insufficient';active=dynPlan('结算',true);
      const before=calls.length;
      const r=await ask('没有依据的新业务目标是什么',admin);
      assert.equal(r.reply.payload.kind,'content_no_evidence');assert.equal(r.reply.payload.sources.length,0);
      assert.equal(calls.length-before,2,'planning and the required sufficiency assessment run; no answer generation without sufficient evidence');
      assert.ok(!r.reply.content.includes('四十五日'));
    });

    await t.test('role changes during generation invalidate the response', async () => {
      mode='happy';active=dynPlan('结算');
      afterAnswer=()=>db.prepare("UPDATE users SET role='borrower' WHERE username='dyn_admin'").run();
      try {
        const r=await ask('请再次核对相关资料',admin);
        assert.equal(r.reply.payload.kind,'error');assert.ok(!r.reply.payload.sources?.length);
      } finally {db.prepare("UPDATE users SET role='admin' WHERE username='dyn_admin'").run();afterAnswer=undefined;}
    });
    await t.test('aggregate statistics are discarded if a grant expires while the model is answering', async () => {
      mode='happy';
      const request=await api('/borrow-requests',borrower,{archiveId:secret.id,purpose:'统计权限隔离测试',days:1});
      assert.equal(request.status,201);
      assert.equal((await api(`/borrow-requests/${request.data.id}/approve`,admin,{})).status,201);
      const borrowerId=db.prepare("SELECT id FROM users WHERE username='dyn_borrower'").get().id;
      active=emptyRetrievalPlan('');active.allowExpansion=false;active.responseMode='statistics';
      active.planSteps=[{id:'stats',tool:'statistics.get',intent:'数据库统计',expects:'stats',args:{}}];
      afterAnswer=()=>db.prepare('DELETE FROM borrow_grants WHERE user_id=? AND archive_id=?').run(borrowerId,secret.id);
      try {
        const r=await ask('请解释当前有权访问资料的统计',borrower);
        assert.equal(r.reply.payload.kind,'error',JSON.stringify(r.reply));
        assert.ok(!r.reply.payload.toolResults?.length,'old aggregate and its authorization snapshot must be removed');
      } finally {afterAnswer=undefined;db.prepare('DELETE FROM borrow_grants WHERE user_id=? AND archive_id=?').run(borrowerId,secret.id);}
    });

    await t.test('model cannot smuggle database ids into step args: fail-closed back to deterministic boundary', async () => {
      mode = 'failclosed'; active = dynPlan('结算 期限');
      const r = await ask('麻烦说明设备交付后尾款的支付期限', admin);
      assert.equal(r.reply.payload.plannerCall.status, 'failed');
      assert.notEqual(r.reply.payload.kind, 'content_answer');
    });

    await t.test('version change invalidates old index: Agent search only returns current version content', async () => {
      mode = 'happy';
      // v1 内容已在初始 setup 中入库并索引（file: 光谱仪交接纪要.txt）
      // 确认 Agent 动态计划路径能命中 v1 内容
      active = dynPlan('四十五日 结算 尾款');
      const before = await ask('核实光谱仪交付后的账期约定', admin);
      assert.equal(before.reply.payload.kind, 'content_answer');
      assert.ok(before.reply.payload.sources.some(s => s.fileId === file.id), 'v1 内容应被 Agent 检索命中');

      // 模拟版本变更：直接写入新版本记录 + 新内容单元/片段
      const adminId = db.prepare("SELECT id FROM users WHERE username='dyn_admin'").get().id;
      const newStoredName = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab.txt';
      const newSha256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      db.prepare(`INSERT INTO archive_file_versions
        (archive_id, source_file_id, stored_name, version_no, sha256, file_size, origin, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'upload', ?, datetime('now'))`)
        .run(a.id, file.id, newStoredName, 1, newSha256, 100, adminId);
      db.prepare(`INSERT INTO archive_content_units
        (archive_id, file_id, version_id, version_no, stored_name, sha256, extension, extractor, status, message, char_count, chunk_count, truncated, indexed_at)
        VALUES (?, ?, (SELECT MAX(id) FROM archive_file_versions WHERE archive_id=?), 1, ?, ?, 'txt', 'test', 'indexed', '', ?, 1, 0, datetime('now'))`)
        .run(a.id, file.id, a.id, newStoredName, newSha256, 60);
      const newUnitId = Number(db.prepare('SELECT MAX(id) AS id FROM archive_content_units').get().id);
      const v2Text = '结算期限变更为验收完成后九十日内支付尾款。';
      db.prepare(`INSERT INTO archive_content_chunks
        (unit_id, archive_id, file_id, chunk_no, locator, page_no, pos_from, pos_to, text, search_terms)
        VALUES (?, ?, ?, 1, '1:1', 1, 0, ?, ?, ?)`)
        .run(newUnitId, a.id, file.id, v2Text.length, v2Text, buildCjkBigramTerms(v2Text));

      // Agent 搜索：应只返回 v2 内容
      active = dynPlan('九十日 结算 期限 变更');
      const after = await ask('现在的结算期限变成了多久', admin);
      assert.equal(after.reply.payload.kind, 'content_answer', JSON.stringify(after.reply));
      assert.ok(after.reply.payload.sources.length > 0, '应检索到新版本内容');
      for (const s of after.reply.payload.sources) {
        assert.equal(s.fileId, file.id, '来源应为同一附件');
        assert.ok(s.excerpt.includes('九十日'), `应包含新版本正文：${s.excerpt}`);
        assert.ok(!s.excerpt.includes('四十五日'), `不应包含旧版本正文：${s.excerpt}`);
      }
      // 旧版本内容单元仍存在于数据库中，但被 CURRENT_CONTENT_SQL 和 isCurrentEvidence 过滤
      const oldUnitCount = db.prepare(
        "SELECT COUNT(*) AS c FROM archive_content_units WHERE stored_name != ? AND file_id = ?"
      ).get(newStoredName, file.id);
      assert.ok(Number(oldUnitCount.c) >= 1, '旧版本索引单元应仍存在于数据库中');
    });
  } finally { if (app) await app.close(); if (db) db.close(); rmSync(dir, {recursive: true, force: true}); }
});


test('plan schema aliases preserve per-step depth and reject dangling, cyclic and invalid scopes', () => {
  const steps = validatePlanSteps([
    {stepId:'locate',tool:'attachment.search',intent:'定位',args:{keyword:'业务线索'},expectedEvidence:'attachment',searchScope:{kind:'allAuthorized'},referenceRefs:[],dependsOn:[]},
    {stepId:'read',tool:'content.read',intent:'全文',args:{},expectedEvidence:'fullText',searchScope:{kind:'fromStep',step:'locate'},dependsOn:['locate'],referenceRefs:[]},
  ]);
  assert.equal(steps[0].expects, 'attachmentNames'); assert.equal(steps[1].expects, 'fullText');
  assert.throws(() => validatePlanSteps([{id:'a',tool:'content.read',args:{},scope:'step:missing'}]), /scope reference/);
  assert.throws(() => validatePlanSteps([{id:'a',tool:'content.read',args:{},scope:{kind:'global'}}]), /scope reference/);
  assert.throws(() => validatePlanSteps([{id:'a',tool:'archive.search',args:{},dependsOn:['b']},{id:'b',tool:'archive.search',args:{},dependsOn:['a']}]), /dependency reference/);
  const explicitRelatedRead = emptyRetrievalPlan('请逐份阅读全文');
  explicitRelatedRead.includeRelatedFullText = true;
  assert.equal(validateRetrievalPlan(wire(explicitRelatedRead), '请逐份阅读全文').includeRelatedFullText, true,
    'explicit full-text requests for related archives must remain supported');
  assert.equal(validateRetrievalPlan({...wire(explicitRelatedRead), includeRelatedFullText:'yes'}, '请逐份阅读全文').includeRelatedFullText, false,
    'invalid optional optimization hints must fall back to the safe snippet-only default');
});

test('sufficiency failures and malformed decisions cannot become sufficient', async () => {
  for (const value of ['{}', 'null', 'garbage', '{"verdict":"unexpected"}']) {
    const result = await judgeSufficiency({available:true,async chatCompletion(){return {content:value,truncated:false};}},'question','evidence',emptyCoverage());
    assert.equal(result.verdict, 'unknown');
  }
  assert.equal((await judgeSufficiency({available:false},'q','',emptyCoverage())).verdict,'unknown');
  const result = await judgeSufficiency({available:true,async chatCompletion(){throw Error('timeout');}},'q','',emptyCoverage());
  assert.equal(result.verdict,'unknown');
  assert.equal(isCoverageIncomplete({...emptyCoverage(),expectedFiles:100,processedFiles:10}),true);
});

test('global tool and token budgets are shared across rounds and async calls', async () => {
  await withExecutionBudget(async () => {
    const budget = executionBudget();
    for (let r = 0; r < 2; r++) { budget.beginRound(); for (let i=0;i<24;i++) budget.takeTool('read'); }
    budget.beginRound(); for(let i=0;i<16;i++) budget.takeTool('read');
    assert.throws(() => budget.takeTool('read'), /EXECUTION_BUDGET/);
    assert.equal(budget.toolCalls,64);
    assert.equal(budget.snapshot().exhausted,true);
    const mock=budgetedModel({available:true,model:'test',async chatCompletion(){return {content:'{}',truncated:false};}});
    budget.reserveTokens(budget.maxTokensTotal-10);
    await assert.rejects(mock.chatCompletion([{role:'user',content:'request'}],{maxTokens:100}), /EXECUTION_BUDGET/);
  });
});
