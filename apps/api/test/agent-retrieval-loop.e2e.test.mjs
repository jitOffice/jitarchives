/** Full retrieval loop with disposable SQLite/files and injected AI/embedding doubles only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap } from '../dist/main.js';
import { DATABASE } from '../dist/db/database.js';
import { AgentToolRegistry } from '../dist/agent/tool.registry.js';
import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
import { readPlannerFixture } from './helpers/read-planner-fixture.mjs';

test('档案 Agent 检索、正文、证据、AI 和权限完整闭环', { timeout: 90000 }, async t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'jit-agent-loop-'));
  const model = { available: true, model: 'mock-loop', calls: [], mode: 'answer', async chatCompletion(messages) {
    const planning=readPlannerFixture(messages);if(planning)return planning;
    this.calls.push(messages);
    const text = messages.at(-1).content;
    const quotes = [...text.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
    if (!quotes.length) return { content: '{"kind":"unparsed"}', truncated: false };
    if (this.mode === 'fake') return { content: '立即支付999999元 [E99]', truncated: false };
    if (this.mode === 'fail') throw new Error('mock AI failure');
    if (this.mode === 'insufficient') return { content: 'INSUFFICIENT_EVIDENCE', truncated: false };
    const claims = quotes.map(([, ref, quote]) => ({ text: quote, citations: [ref], evidenceQuote: quote }));
    return { content: JSON.stringify({ answer: claims.map(c => c.text).join('；'), claims }), truncated: false };
  } };
  let app, db;
  try {
    const server = await bootstrap({ port: 0, dbFile: path.join(temp, 'test.db'), fileStoreDir: path.join(temp, 'files'),
      serveWeb: false, knowledgeWorker: false, aiModelClient: model,
      embeddingClient: { available: false, modelKey: 'disabled-test', async embed() { throw new Error('must not call'); } } });
    app = server.app; db = app.get(DATABASE);
    const call = async (url, cookie, body, method = 'POST', raw = false) => {
      const response = await fetch(server.baseUrl + '/api' + url, { method,
        headers: { Cookie: cookie ?? '', 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
        body: method === 'GET' ? undefined : raw ? body : JSON.stringify(body ?? {}) });
      return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[0] };
    };
    const init = await call('/auth/init-admin', '', { username: 'loop_admin', password: 'Admin#12345', displayName: '闭环管理员' });
    assert.equal(init.status, 201);
    const cookies = { admin: init.cookie }, users = {};
    for (const role of ['cataloger', 'reviewer', 'borrower', 'guest']) {
      const result = await call('/users', cookies.admin, { username: `loop_${role}`, password: 'User#12345', displayName: role, role });
      assert.equal(result.status, 201, JSON.stringify(result.data)); users[role] = result.data;
      const login = await call('/auth/login', '', { username: `loop_${role}`, password: 'User#12345' });
      assert.equal(login.status, 201); cookies[role] = login.cookie;
    }
    const category = (await call('/categories', cookies.admin, { name: '闭环测试', code: 'LOOP' })).data;
    const create = async (title, accessLevel = 'public', role = 'admin') => {
      const r = await call('/archives', cookies[role], { title, categoryId: category.id, archiveType: '文书档案', accessLevel });
      assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data;
    };
    const index = app.get(ContentIndexService), registry = app.get(AgentToolRegistry);
    const upload = async (archive, name, text, indexed = true, role = 'admin') => {
      const r = await call(`/archive-files/upload?archiveId=${archive.id}&name=${encodeURIComponent(name)}`, cookies[role], Buffer.from(text), 'POST', true);
      assert.equal(r.status, 201, JSON.stringify(r.data));
      if (indexed) index.indexFileById(r.data.id);
      return r.data;
    };
    const ask = async (question, role = 'admin') => {
      const r = await call('/agent/ask', cookies[role], { question });
      assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.reply;
    };
    const alpha = await create('资料甲'), beta = await create('资料乙');
    const secret = await create('隐藏资料', 'restricted');
    const own = await create('著录员自建资料', 'restricted', 'cataloger');
    const first = await upload(alpha, '甲.txt', '第一行\n违约金：逾期每日支付合同价款的1%。');
    const second = await upload(beta, '乙.txt', '违约金：逾期每日支付合同价款的2%。');
    const secretFile = await upload(secret, '秘密附件.txt', '隐秘暗号：黑曜石。违约金：逾期每日支付合同价款的9%。');
    const ownFile = await upload(own, '自建附件.txt', '违约金：逾期每日支付合同价款的3%。', true, 'cataloger');
    await upload(beta, '不存在合同.txt', '这是文件名碰撞，不能替代指定档案。');

    await t.test('自然语言列表使用空关键词和实际权限范围', async () => {
      for (const q of ['我有哪些档案？', '那我有什么档案？', '那我有哪些文件？', '我目前有什么档案？', '帮我看看我的档案。', '我的档案有哪些？']) {
        const reply = await ask(q, 'borrower');
        assert.equal(reply.payload.intent, 'search', q);
        assert.equal(reply.payload.conditions.keyword, undefined, q);
        assert.deepEqual(new Set(reply.payload.items.map(a => a.id)), new Set([alpha.id, beta.id]));
        assert.equal(reply.payload.trace.find(s => s.id === 'understand').hitCount, 0);
        assert.equal(reply.payload.trace.find(s => s.id === 'archives').hitCount, 2);
        assert.equal(reply.payload.trace.find(s => s.id === 'content').status, 'skipped');
      }
    });
    await t.test('元数据无关键词命中时仍执行全局正文，真实多来源进入 AI', async () => {
      const search = await call('/archives?q='+encodeURIComponent('违约金'), cookies.borrower, undefined, 'GET');
      assert.equal(search.data.total, 0, '先核对真实目录API，不能以Agent跨渠道查找结果代替元数据基线');
      const reply = await ask('哪个附件提到了违约金？', 'borrower');
      assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
      assert.equal(reply.payload.trace.find(s => s.id === 'archives').status, 'skipped');
      assert.equal(reply.payload.trace.find(s => s.id === 'content').hitCount, 2);
      assert.equal(reply.payload.trace.find(s => s.id === 'answer').status, 'completed');
      assert.deepEqual(new Set(reply.payload.sources.map(s => s.fileId)), new Set([first.id, second.id]));
      for (const source of reply.payload.sources) {
        assert.ok([alpha.id, beta.id].includes(source.archiveId));
        assert.ok(source.chunkId > 0 && source.unitId > 0);
        assert.ok(source.archiveTitle && source.fileName && source.locator);
        assert.match(source.locator, /TXT 第 [12](?:-[12])? 行/u);
      }
      assert.match(reply.content, /资料甲/u); assert.match(reply.content, /资料乙/u);
      assert.match(reply.content, /甲.txt/u); assert.match(reply.content, /乙.txt/u);
    });
    await t.test('指定档案取证不扩大范围，档号与名称未命中均不调用正文或 AI', async () => {
      const reply = await ask(`档号 ${alpha.archiveNo} 的违约责任是什么？`, 'borrower');
      assert.equal(reply.payload.kind, 'content_answer');
      assert.ok(reply.payload.sources.every(s => s.archiveId === alpha.id));
      for (const q of ['档号 LOOP-2099-999999 的违约责任是什么？', '不存在合同主要内容是什么？', '不存在合同的违约金是多少？']) {
        const before = model.calls.length;
        const missing = await ask(q, 'borrower');
        assert.equal(missing.payload.kind, 'content_no_evidence', q);
        assert.ok(!missing.payload.toolResults.some(r => r.toolName.startsWith('content.') && r.status!=='skipped'), q);
        assert.equal(model.calls.length, before, q);
        assert.ok(!missing.payload.sources.length);
        assert.equal(missing.payload.trace.find(s => s.id === 'content').status, 'skipped');
        assert.match(missing.payload.trace.find(s => s.id === 'content').note, /未找到指定/u);
      }
    });
    await t.test('没有证据不调用回答模型，伪引用与模型失败均退回原文', async () => {
      const before = model.calls.length;
      const empty = await ask('哪个附件提到了星际量子密钥？', 'borrower');
      assert.equal(empty.payload.kind, 'content_no_evidence');
      assert.equal(model.calls.length, before);
      assert.equal(empty.payload.trace.find(s => s.id === 'answer').status, 'empty');
      for (const mode of ['fake', 'fail', 'insufficient']) {
        model.mode = mode;
        const reply = await ask('哪个附件提到了违约金？', 'borrower');
        assert.equal(reply.payload.kind, mode === 'insufficient' ? 'content_no_evidence' : 'content_evidence');
        assert.equal(reply.payload.trace.find(s => s.id === 'answer').status, mode === 'insufficient' ? 'empty' : 'failed');
        assert.doesNotMatch(reply.content, /999999元|E99/u);
      }
      model.mode = 'answer';
    });
    for (const role of ['admin', 'cataloger', 'reviewer', 'borrower', 'guest']) {
      await t.test(`${role}：目录、全局正文、定向读取和隐藏索引状态均遵循后端权限`, async () => {
        const expected = role === 'admin' ? [first.id, second.id, secretFile.id, ownFile.id] : role === 'cataloger' ? [first.id, second.id, ownFile.id] : [first.id, second.id];
        const visibleArchives = role === 'admin' ? [alpha.id, beta.id, secret.id, own.id] : role === 'cataloger' ? [alpha.id, beta.id, own.id] : [alpha.id, beta.id];
        const list = await ask('我有哪些档案？', role);
        assert.deepEqual(new Set(list.payload.items.map(a => a.id)), new Set(visibleArchives));
        const reply = await ask('哪个附件提到了违约金？', role);
        assert.equal(reply.payload.kind, 'content_answer');
        assert.deepEqual(new Set(reply.payload.sources.map(s => s.fileId)), new Set(expected));
        const login = await call('/auth/login', '', { username: `loop_${role}`, password: role === 'admin' ? 'Admin#12345' : 'User#12345' });
        const me = (await call('/auth/me', login.cookie, undefined, 'GET')).data;
        const user = me.user ?? me;
        for (const name of ['content.search', 'content.read']) {
          const params = name === 'content.read' ? { query: '违约金' } : { keyword: '违约金' };
          const result = await registry.execute(name, params, user);
          assert.equal(result.status, 'success', JSON.stringify(result));
          assert.deepEqual(new Set(result.data.items.map(s => s.fileId)), new Set(expected));
          const direct = await registry.execute(name, { ...params, archiveIds: [secret.id] }, user);
          assert.equal(direct.status, role === 'admin' ? 'success' : 'error');
          if (role !== 'admin') {
            assert.doesNotMatch(JSON.stringify(result), /黑曜石|秘密附件/u);
            assert.ok(!result.data.indexStatuses.some(s => s.archiveId === secret.id));
          }
        }
      });
    }
    await t.test('有效借阅按 can_view 过滤目录、正文与索引状态，撤销及到期立即生效', async () => {
      const application = await call('/borrow-requests', cookies.borrower, { archiveId: secret.id, purpose: '检索权限回归', days: 1 });
      assert.equal(application.status, 201, JSON.stringify(application.data));
      assert.equal((await call(`/borrow-requests/${application.data.id}/approve`, cookies.admin, {})).status, 201);
      const grant = db.prepare('SELECT id FROM borrow_grants WHERE borrow_id=?').get(application.data.id);
      const visible = await ask('哪个附件提到了违约金？', 'borrower');
      assert.ok(visible.payload.sources.some(s => s.fileId === secretFile.id));
      for (const [sql, args] of [
        ["UPDATE borrow_grants SET can_view=0 WHERE id=?", [grant.id]],
        ["UPDATE borrow_grants SET can_view=1,status='revoked' WHERE id=?", [grant.id]],
        ["UPDATE borrow_grants SET can_view=1,status='active',expires_at=? WHERE id=?", [new Date(Date.now() - 10000).toISOString(), grant.id]],
      ]) {
        db.prepare(sql).run(...args);
        const list = await ask('我有哪些档案？', 'borrower');
        assert.ok(!list.payload.items.some(a => a.id === secret.id));
        const reply = await ask('哪个附件提到了违约金？', 'borrower');
        assert.ok(!reply.payload.sources.some(s => s.fileId === secretFile.id));
        const result = reply.payload.toolResults.find(r => r.toolName === 'content.read');
        assert.ok(!result.data.indexStatuses.some(s => s.archiveId === secret.id));
        assert.doesNotMatch(JSON.stringify(reply), /黑曜石|秘密附件/u);
      }
    });
    await t.test('全局查询如实显示未索引、索引中、失败，重复当前版本索引不重建', async () => {
      const pending = await upload(alpha, '等待.txt', '排队中的正文', false);
      const processing = await upload(alpha, '处理中.txt', '正在处理的正文', false);
      db.prepare("UPDATE knowledge_index_jobs SET status='processing',lease_until=? WHERE file_id=?").run(Date.now() + 60000, processing.id);
      const failed = await upload(beta, '损坏.pdf', 'broken PDF');
      const reply = await ask('哪个附件提到了星际量子密钥？', 'borrower');
      const statuses = reply.payload.toolResults.find(r => r.toolName === 'content.read').data.indexStatuses;
      assert.equal(statuses.find(s => s.fileId === pending.id).status, 'pending');
      assert.equal(statuses.find(s => s.fileId === processing.id).status, 'processing');
      assert.equal(statuses.find(s => s.fileId === failed.id).status, 'failed');
      assert.match(reply.content, /未索引/u); assert.match(reply.content, /索引中/u); assert.match(reply.content, /索引失败/u);
      const unit = db.prepare('SELECT id,indexed_at FROM archive_content_units WHERE file_id=?').get(first.id);
      assert.equal(index.indexFileById(first.id), false);
      assert.equal(index.indexFileById(first.id, true), false);
      assert.deepEqual(db.prepare('SELECT id,indexed_at FROM archive_content_units WHERE file_id=?').get(first.id), unit);
    });
  } finally {
    if (app) await app.close(); if (db) db.close();
    rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
