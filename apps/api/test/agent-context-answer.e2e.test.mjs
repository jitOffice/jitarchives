/** Stage 3: real services + disposable SQLite/files, injected model only. Never uses production data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrap } from '../dist/main.js';
import { DATABASE } from '../dist/db/database.js';
import { AgentRepository } from '../dist/agent/agent.repositories.js';
import { AgentContextService, CONTEXT_LIMITS } from '../dist/agent/agent.context.js';
import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
import { readPlannerFixture } from './helpers/read-planner-fixture.mjs';

const temp = mkdtempSync(path.join(os.tmpdir(), 'jit-agent-context-'));
let app, baseUrl, adminCookie, borrowerCookie, db;
const ids = {};
const model = {
  available: false, model: 'mock', calls: [], mode: 'answer', afterEvidence: null,
  async chatCompletion(messages) {
    const planning=readPlannerFixture(messages);if(planning)return planning;
    this.calls.push(messages);
    if (this.mode === 'error') throw new Error('mock timeout');
    if (this.mode === 'invalid') return { content: '伪造条款 [E1]。不存在的来源 [E99]。', truncated: false };
    if (this.mode === 'uncited') return { content: '验收合格 [E1]。另外应支付999999元。', truncated: false };
    if (this.mode === 'insufficient') return { content: 'INSUFFICIENT_EVIDENCE\n证据不足。', truncated: false };
    if (this.mode === 'link') return { content: '伪造来源 https://evil.test/archives/123 [E1]。', truncated: false };
    if (this.mode === 'truncated') return { content: '伪造条款 [E1]', truncated: true };
    const content = messages.at(-1).content;
    const excerpt = content.match(/"""([\s\S]*?)"""/u)?.[1];
    if (!excerpt) return { content: '{"kind":"unparsed"}', truncated: false };
    if (this.afterEvidence) await this.afterEvidence();
    if(this.mode==='structured'){
      const quote=excerpt.split(/[。]/u)[0]+'。';
      const text=quote.replace(/验收合格/gu,'验收通过').replace(/30日/gu,'30天');
      return {content:JSON.stringify({answer:text,claims:[{text,citations:['E1'],evidenceQuote:excerpt.includes(quote)?quote:excerpt}]}),truncated:false};
    }
    return { content: `${excerpt} [E1]。`, truncated: false };
  },
};
async function request(url, cookie = adminCookie, body, method = 'POST', raw = false) {
  const r = await fetch(baseUrl + url, { method, headers: { ...(cookie ? { Cookie: cookie } : {}),
    'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
    body: ['GET', 'DELETE'].includes(method) ? undefined : raw ? body : JSON.stringify(body ?? {}) });
  return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.match(/jit_sid=([0-9a-f]+)/u)?.[1] };
}
async function ask(question, conversationId, cookie = adminCookie, clientRequestId) {
  const r = await request('/api/agent/ask', cookie, { question, conversationId, clientRequestId });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.reply.payload.context, undefined, 'internal state is not an API field');
  return r.data;
}
async function create(title) {
  const r = await request('/api/archives', adminCookie, { title, archiveType: '文书档案', categoryId: ids.category });
  assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data;
}
async function upload(archiveId, name, body) {
  const r = await request(`/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,
    adminCookie, new TextEncoder().encode(body), 'POST', true);
  assert.equal(r.status, 201, JSON.stringify(r.data)); // Explicit fixture indexing; the upload API itself only enqueues.
  app.get(ContentIndexService).indexFileById(r.data.id); return r.data;
}
test.describe('第三阶段：智能回答与隔离的多轮上下文', { concurrency: false }, () => {
  test.before(async () => {
    ({ app, baseUrl } = await bootstrap({ port: 0, dbFile: path.join(temp, 'test.db'), fileStoreDir: path.join(temp, 'files'), serveWeb: false, knowledgeWorker: false, aiModelClient: model }));
    db = app.get(DATABASE);
    const init = await request('/api/auth/init-admin', null, { username: 'context_admin', password: 'Admin#12345', displayName: '上下文管理员' });
    assert.equal(init.status, 201); adminCookie = `jit_sid=${init.cookie}`;
    assert.equal((await request('/api/users', adminCookie, { username: 'context_borrower', role: 'borrower', password: 'User#12345', displayName: '上下文借阅者' })).status, 201);
    const login = await request('/api/auth/login', null, { username: 'context_borrower', password: 'User#12345' });
    borrowerCookie = `jit_sid=${login.cookie}`;
    const category = await request('/api/categories', adminCookie, { name: '上下文合同', code: 'CTX' });
    ids.category = category.data.id;
    ids.ppp = await create('PPP');
    ids.contract = await create('PPP合同');
    ids.other = await create('无关卷宗');
    ids.acceptance = await upload(ids.ppp.id, '项目验收报告.txt', '验收结论：设备运行正常，验收合格');
    await upload(ids.ppp.id, '合作合同.txt', '合作双方按合同约定履行义务');
    await upload(ids.ppp.id, '上传说明.txt', '这是上传说明的真实正文');
    await upload(ids.contract.id, 'PPP合同.txt', '付款条件：验收后七日内付款');
    await upload(ids.other.id, '另一份验收报告.txt', '不得混入的无关附件正文。质保金比例：百分之五');
  });
  test.beforeEach(() => { model.available = false; model.mode = 'answer'; model.calls = []; model.afterEvidence = null; });
  test.after(async () => {
    if (app) { await app.close(); db.close(); }
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('jit-agent-context-'));
    rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  test('单轮档案回答展示真实数量、名称和状态', async () => {
    const r = await ask('我有哪些档案？');
    assert.equal(r.reply.payload.kind, 'search');
    assert.ok(r.reply.payload.items.length >= 3);
    assert.match(r.reply.content, /PPP.*草稿/u);
    assert.ok(r.reply.content.includes(String(r.reply.payload.total)));
  });
  test('单轮附件回答展示名称、格式、所属档案', async () => {
    const r = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    assert.equal(r.reply.payload.unified.attachments.total, 3);
    assert.match(r.reply.content, /项目验收报告.txt.*txt.*PPP/u);
    assert.equal((await ask('PPP里面有哪些附件？')).reply.payload.unified.attachments.total, 3, '单档附件列表优先精确标题');
  });
  test('“PPP这个档案”是点名档案而非回指上一轮，新会话也要真实检到附件', async () => {
    const r = await ask('你告诉我PPP这个档案里面有几个附件？');
    assert.equal(r.reply.payload.kind, 'unified_search', '不能被会话引用链路拦下变成 target_ask');
    assert.equal(r.reply.payload.conditions.title, 'PPP', '指示词不能污染档案标题');
    assert.equal(r.reply.payload.unified.attachments.total, 3);
  });
  test('正文回答引用真实索引、附件、版本和位置', async () => {
    model.available = true;
    const r = await ask('PPP合同主要讲了什么？');
    assert.equal(r.reply.payload.kind, 'content_answer');
    assert.match(r.reply.content, /验收后七日内付款/u);
    assert.ok(r.reply.payload.sources.every(s => s.archiveId === ids.contract.id && s.fileName === 'PPP合同.txt' && s.locator && s.detailPath === `/archives/${ids.contract.id}`));
  });
  test('可按真实附件名称直接定位正文，找不到档案时不猜正文', async () => {
    model.available = true;
    const r = await ask('项目验收报告.txt主要讲了什么？');
    assert.equal(r.reply.payload.kind, 'content_answer');
    assert.ok(r.reply.payload.sources.every(s => s.fileId === ids.acceptance.id));
  });
  test('连续四轮：附件名称→选中验收报告→正文→真实上传时间', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    const cid = first.conversationId;
    const second = await ask('其中哪个是验收报告？', cid);
    assert.deepEqual(second.reply.payload.unified.attachments.items.map(f => f.fileId), [ids.acceptance.id]);
    model.available = true;
    const third = await ask('那它的主要内容是什么？', cid);
    assert.equal(third.reply.payload.kind, 'content_answer');
    assert.ok(third.reply.payload.sources.every(s => s.fileId === ids.acceptance.id));
    assert.match(third.reply.content, /设备运行正常/u);
    assert.ok(!JSON.stringify(model.calls).includes('不得混入'));
    const fourth = await ask('它是什么时候上传的？', cid);
    assert.match(fourth.reply.content, /项目验收报告.txt.*上传时间/u);
    assert.ok(fourth.reply.content.includes(ids.acceptance.uploadedAt));
  });
  test('第二份附件按上一轮真实展示顺序定位', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    const expected = first.reply.payload.unified.attachments.items[1];
    const next = await ask('第二份附件', first.conversationId);
    assert.deepEqual(next.reply.payload.unified.attachments.items.map(f => f.fileId), [expected.fileId]);
  });
  test('这些附件、刚才那份与它的正文保持附件范围', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    const files = await ask('这些附件', first.conversationId);
    assert.equal(files.reply.payload.unified.attachments.total, 3);
    await ask('第二份附件', first.conversationId);
    const selected = await ask('刚才那份', first.conversationId);
    const body = await ask('它的正文', first.conversationId);
    assert.ok(body.reply.payload.sources.length > 0);
    assert.ok(body.reply.payload.sources.every(s => s.fileId === selected.reply.payload.unified.attachments.items[0].fileId));
  });
  test('那些档案、这个档案、上面提到的合同与档案序号', async () => {
    const first = await ask('我有哪些档案？');
    const all = await ask('那些档案', first.conversationId);
    assert.equal(all.reply.payload.items.length, first.reply.payload.items.length);
    const one = await ask('第一份档案', first.conversationId);
    const again = await ask('这个档案', first.conversationId);
    assert.equal(again.reply.payload.items[0].id, one.reply.payload.items[0].id);
    const contract = await ask('上面提到的PPP合同', first.conversationId);
    assert.equal(contract.reply.payload.items[0].id, ids.contract.id);
  });
  test('单档案上下文可继续查询附件，无需重复档号', async () => {
    const first = await ask(`查询档号 ${ids.ppp.archiveNo} 的档案`);
    const files = await ask('这个档案有哪些附件？', first.conversationId);
    assert.equal(files.reply.payload.unified.attachments.total, 3);
  });
  test('省略问句沿用当前附件，联合追问按当前档案范围分组', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    await ask('其中哪个是验收报告？', first.conversationId);
    const body = await ask('主要内容是什么？', first.conversationId);
    assert.ok(body.reply.payload.sources.every(s => s.fileId === ids.acceptance.id));
    const uploaded = await ask('什么时候上传的？', first.conversationId);
    assert.ok(uploaded.reply.content.includes(ids.acceptance.uploadedAt));
    const related = await ask('这个档案的档案、附件和操作记录', first.conversationId);
    assert.equal(related.reply.payload.unified.attachments.total, 3);
    assert.ok(related.reply.payload.unified.archives.items.every(a => a.id === ids.ppp.id));
  });
  test('多个附件正文分别取证，不能被其他附件的片段挤占', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    const answered = await ask('这些附件的主要内容是什么？', first.conversationId);
    assert.equal(new Set(answered.reply.payload.sources.map(s => s.fileId)).size, 3);
  });
  test('新会话、缺失历史和跨用户访问隔离', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    const fresh = await ask('它的正文');
    assert.equal(fresh.reply.payload.kind, 'content_no_evidence');
    assert.equal(fresh.reply.payload.sources, undefined);
    const cross = await request('/api/agent/ask', borrowerCookie, { question: '它的正文', conversationId: first.conversationId });
    assert.equal(cross.status, 404);
    assert.equal((await request('/api/agent/ask', adminCookie, { question: '它的正文', conversationId: 999999 })).status, 404);
    const other = await ask('它的正文', undefined, borrowerCookie);
    assert.equal(other.reply.payload.kind, 'content_no_evidence');
  });
  test('历史权限变化后，续问、历史加载和幂等回放均重新拦截', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`, undefined, borrowerCookie, 'context-replay');
    db.prepare("UPDATE archives SET access_level='restricted' WHERE id=?").run(ids.ppp.id);
    try {
      const next = await ask('其中哪个是验收报告？', first.conversationId, borrowerCookie);
      assert.equal(next.reply.payload.kind, 'error');
      assert.ok(!JSON.stringify(next.reply).includes('项目验收报告'));
      const history = await request(`/api/agent/conversations/${first.conversationId}`, borrowerCookie, undefined, 'GET');
      assert.ok(!JSON.stringify(history.data.messages.filter(m => m.role === 'assistant')).includes('项目验收报告'));
      const replay = await ask('重试', first.conversationId, borrowerCookie, 'context-replay');
      assert.equal(replay.reply.payload.kind, 'error');
    } finally { db.prepare("UPDATE archives SET access_level='public' WHERE id=?").run(ids.ppp.id); }
  });
  test('等待模型期间权限撤销，正文及来源在落库和响应前再次拦截', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`, undefined, borrowerCookie);
    await ask('其中哪个是验收报告？', first.conversationId, borrowerCookie);
    model.available = true;
    model.afterEvidence = () => db.prepare("UPDATE archives SET access_level='restricted' WHERE id=?").run(ids.ppp.id);
    try {
      const r = await ask('主要内容是什么？', first.conversationId, borrowerCookie);
      assert.equal(r.reply.payload.kind, 'error');
      assert.ok(!JSON.stringify(r.reply).includes('设备运行正常'));
      assert.equal(r.reply.payload.sources, undefined);
    } finally { db.prepare("UPDATE archives SET access_level='public' WHERE id=?").run(ids.ppp.id); }
  });
  test('无匹配、指代不明确与同名档案只问一个澄清问题', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    const ambiguous = await ask('它的正文', first.conversationId);
    assert.equal((ambiguous.reply.content.match(/？/gu) ?? []).length, 1);
    assert.equal(ambiguous.reply.payload.sources, undefined);
    const noFile = await ask('其中哪个是不存在的材料？', first.conversationId);
    assert.equal(noFile.reply.payload.total, 0);
    const duplicate = await create('同名合同'); await create('同名合同');
    const dup = await ask('同名合同主要讲了什么？');
    assert.equal(dup.reply.payload.total, 2);
    assert.equal((dup.reply.content.match(/？/gu) ?? []).length, 1);
    assert.ok(dup.reply.payload.items.some(a => a.id === duplicate.id));
    const duplicateFiles = await ask('同名合同里面有哪些附件？');
    assert.equal(duplicateFiles.reply.payload.kind, 'search');
    assert.equal(duplicateFiles.reply.payload.total, 2);
    assert.equal((duplicateFiles.reply.content.match(/？/gu) ?? []).length, 1);
  });
  test('空档案和无附件结果真实返回，显式新目标不回退旧会话', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    const missing = await ask('不存在的项目合同主要讲了什么？', first.conversationId);
    assert.equal(missing.reply.payload.kind, 'content_no_evidence');
    assert.equal(missing.reply.payload.sources.length, 0);
    const empty = await create('空附件档案');
    const files = await ask(`档号 ${empty.archiveNo} 里面有哪些附件？`);
    assert.equal(files.reply.payload.unified.attachments.total, 0);
  });
  test('正文未索引或提取失败时绝不根据名称推测', async () => {
    const broken = await create('提取失败合同');
    await upload(broken.id, '年度验收报告.pdf', '%PDF-1.4\n%%EOF');
    model.available = true;
    const failed = await ask('提取失败合同主要讲了什么？');
    assert.equal(failed.reply.payload.kind, 'content_no_evidence');
    assert.equal(model.calls.length, 0);
    assert.ok(failed.reply.payload.contentNotes.length > 0, '内部仍保留正文处理诊断，供服务端排查');
    assert.doesNotMatch(failed.reply.content, /正文处理|OCR|索引状态|附件正文状态|本次只查看|未处理|不支持正文提取/iu, '用户回答不得包含附件解析或检索过程');
    const pending = await create('尚未索引合同');
    const file = await upload(pending.id, '验收合格.txt', '不应自动重建的正文');
    db.prepare('DELETE FROM archive_content_units WHERE file_id=?').run(file.id);
    const result = await ask('尚未索引合同主要讲了什么？');
    assert.equal(result.reply.payload.kind, 'content_no_evidence');
    assert.equal(model.calls.length, 0);
    assert.doesNotMatch(result.reply.content, /正文处理|OCR|索引状态|附件正文状态|本次只查看|未处理|不支持正文提取/iu, '未索引附件的内部状态不得拼入回答');
    app.get(ContentIndexService).syncArchive(pending.id); // Restore this test fixture only.
  });
  test('单点问题正文没有对应依据时不使用其他片段凑答案', async () => {
    model.available = true;
    const r = await ask('PPP合同的质保金比例是多少？');
    assert.equal(r.reply.payload.kind, 'content_no_evidence');
    assert.equal(model.calls.length, 0);
    assert.ok(!r.reply.content.includes('百分之五'), '显式档案定位不能改为其他档案的全局正文检索');
  });
  test('模型超时、混合伪引用、漏引用、伪链接、截断均诚实降级', async () => {
    model.available = true;
    for (const mode of ['error', 'invalid', 'uncited', 'link', 'truncated']) {
      model.mode = mode;
      const r = await ask('PPP合同主要讲了什么？');
      assert.equal(r.reply.payload.kind, 'content_evidence', mode);
      assert.ok(r.reply.payload.aiNote);
      assert.equal(r.reply.payload.trace.find(step=>step.id==='answer').status,'failed');
      assert.ok(!r.reply.content.includes('伪造') && !r.reply.content.includes('999999') && !r.reply.content.includes('evil.test'));
    }
    model.mode = 'insufficient';
    assert.equal((await ask('PPP合同主要讲了什么？')).reply.payload.kind, 'content_no_evidence');
  });
  test('多工具部分失败按业务分组保留成功结果', async () => {
    const r = await ask(`查询档号 ${ids.ppp.archiveNo} 的档案、附件和操作记录`, undefined, borrowerCookie);
    assert.equal(r.reply.payload.toolExecutionStatus, 'partial');
    assert.match(r.reply.content, /档案信息/u); assert.match(r.reply.content, /附件信息/u);
    assert.match(r.reply.content, /操作记录/u); assert.match(r.reply.content, /部分相关信息暂时无法提供/u);
    assert.doesNotMatch(r.reply.content, /attachment\.search|content\.search|查询失败|工具/u);
    assert.equal(r.reply.payload.unified.attachments.total, 3);
  });
  test('压缩摘要持久化、长度有界，删除会话同时删除上下文', async () => {
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    for (let i = 0; i < 7; i++) await ask('这些附件', first.conversationId);
    const repo = app.get(AgentRepository);
    const owner = db.prepare('SELECT user_id FROM agent_conversations WHERE id=?').get(first.conversationId).user_id;
    const loaded = new AgentContextService(repo).load(first.conversationId, Number(owner));
    assert.ok(loaded.summary.length > 0 && loaded.summary.length <= CONTEXT_LIMITS.summaryChars);
    assert.ok(loaded.recentTurns.length <= CONTEXT_LIMITS.recentTurns && loaded.attachments.length <= CONTEXT_LIMITS.entities);
    assert.ok(loaded.previousQuestion && loaded.tools.length);
    assert.equal((await request(`/api/agent/conversations/${first.conversationId}`, adminCookie, undefined, 'DELETE')).status, 200);
    assert.equal(repo.listMessages(first.conversationId, 12).length, 0);
    assert.throws(() => new AgentContextService(repo).load(first.conversationId, Number(owner)), /会话不存在/u);
  });
  test('上下文读取只持久化会话与审计，不产生业务写操作', async () => {
    const tables = ['archives', 'archive_files', 'archive_file_versions', 'borrow_requests'];
    const counts = () => tables.map(table => Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c));
    const before = counts();
    const first = await ask(`档号 ${ids.ppp.archiveNo} 里面有哪些附件？`);
    await ask('其中哪个是验收报告？', first.conversationId);
    await ask('它的正文', first.conversationId);
    await ask('它是什么时候上传的？', first.conversationId);
    assert.deepEqual(counts(), before);
  });
  test('结构化自然语言改写及统一检索归纳使用本轮证据，简单列表不调用模型',async()=>{
    const target=await create('归纳付款条款合同');
    await upload(target.id,'付款条款.txt','付款条款：验收合格后30日内完成付款。');
    model.available=true;model.mode='structured';
    const direct=await ask('归纳付款条款合同主要讲了什么？');
    assert.equal(direct.reply.payload.kind,'content_answer',JSON.stringify(direct.reply));assert.match(direct.reply.content,/验收通过后30天/);assert.equal(direct.reply.payload.claims[0].citations[0],'E1');
    const combined=await ask('搜索档案和正文包含付款条款的内容，归纳检索结果');
    assert.equal(combined.reply.payload.kind,'unified_search');assert.equal(combined.reply.payload.aiUsed,true);assert.ok(combined.reply.payload.unified.contents.items.length);assert.ok(combined.reply.payload.sources.length);
    const metadata=await ask('查找档案和附件，关键词是归纳付款条款合同，分析检索结果');
    assert.equal(metadata.reply.payload.kind,'unified_search');assert.equal(metadata.reply.payload.aiUsed,true);assert.ok(metadata.reply.payload.metadataSources.every(s=>s.kind==='archive'||s.kind==='attachment'));
    const calls=model.calls.length;await ask('我有哪些档案？');assert.equal(model.calls.length,calls);
  });
});
