import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
/** Read-only tool execution against a disposable SQLite DB. All fixture writes target this DB only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootstrap } from '../dist/main.js';
import { AgentToolRegistry } from '../dist/agent/tool.registry.js';
import { AgentToolDispatcher } from '../dist/agent/tool.dispatcher.js';
import { UserRepository } from '../dist/users/user.repository.js';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE } from '../dist/db/database.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'jit-agent-tools-'));
const dbFile = path.join(temp, 'test.db');
let app, baseUrl, adminCookie, borrowerCookie, guestCookie, admin, borrower, r, d;
const ids = {};
const noModel = { available: false, model: 'test-only', async chatCompletion() { throw new Error('must not use a real model'); } };
async function request(url, cookie, body, method = 'POST', raw = false) {
  const response = await fetch(baseUrl + url, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': raw ? 'application/octet-stream' : 'application/json',
  }, body: method === 'GET' ? undefined : raw ? body : JSON.stringify(body) });
  const data = await response.json();
  const newCookie = response.headers.get('set-cookie')?.match(/jit_sid=([0-9a-f]+)/)?.[1];
  return { status: response.status, data, cookie: newCookie ? `jit_sid=${newCookie}` : cookie };
}
async function ask(question, cookie = adminCookie) {
  const response = await request('/api/agent/ask', cookie, { question });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data.reply;
}
async function create(title, extra = {}) {
  const response = await request('/api/archives', adminCookie, { title, archiveType: '文书档案', categoryId: ids.category, ...extra });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  return response.data;
}
async function upload(archiveId, name, content) {
  const response = await request(`/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`,
    adminCookie, new TextEncoder().encode(content), 'POST', true);
  assert.equal(response.status, 201, JSON.stringify(response.data));
  // Explicit fixture indexing; the upload API itself only enqueues.
  app.get(ContentIndexService).indexFileById(response.data.id); return response.data;
}
function assertTools(reply, names) {
  assert.deepEqual(reply.payload.toolResults.map(t => t.toolName).sort(), [...names].sort());
  assert.ok(reply.payload.toolResults.every(t => t.status === 'success'), JSON.stringify(reply.payload.toolResults));
}

test.describe('Agent 第二阶段真实服务工具调度', { concurrency: false }, () => {
  test.before(async () => {
    ({ app, baseUrl } = await bootstrap({ port: 0, dbFile, fileStoreDir: path.join(temp, 'files'), serveWeb: false, knowledgeWorker: false, aiModelClient: noModel }));
    const initialized = await request('/api/auth/init-admin', null, { username: 'tools_admin', password: 'Admin#12345', displayName: '工具管理员' });
    assert.equal(initialized.status, 201);
    adminCookie = initialized.cookie;
    for (const [username, role] of [['tools_borrower', 'borrower'], ['tools_guest', 'guest']]) {
      assert.equal((await request('/api/users', adminCookie, { username, role, password: 'User#12345', displayName: username })).status, 201);
      const login = await request('/api/auth/login', null, { username, password: 'User#12345' });
      assert.equal(login.status, 201);
      if (role === 'borrower') borrowerCookie = login.cookie; else guestCookie = login.cookie;
    }
    const category = await request('/api/categories', adminCookie, { name: '工具测试合同', code: 'TC' });
    assert.equal(category.status, 201);
    ids.category = category.data.id;
    ids.contract = await create('采购合同');
    ids.ppp = await create('PPP');
    ids.other = await create('无关卷宗');
    ids.secret = await create('保密采购合同', { accessLevel: 'restricted' });
    ids.txt = await upload(ids.contract.id, '验收说明.txt', '付款条件：验收后七日内付款。');
    ids.pdf = await upload(ids.contract.id, '签署原件.pdf', '%PDF-1.4\n%%EOF');
    ids.pppFile = await upload(ids.ppp.id, '项目清单.txt', 'PPP项目附件真实内容');
    await upload(ids.other.id, '采购合同旁支.txt', '不属于采购合同档案');
    await upload(ids.secret.id, '秘密材料.txt', '不可向无权用户展示');
    const users = app.get(UserRepository);
    admin = users.findByUsername('tools_admin');
    borrower = users.findByUsername('tools_borrower');
    // Repository rows are mapped to the same public UserView shape used by the session guard.
    admin = { ...admin, status: 'active', roleLabel: '管理员' };
    borrower = { ...borrower, status: 'active', roleLabel: '借阅者' };
    r = app.get(AgentToolRegistry); d = app.get(AgentToolDispatcher);
  });
  test.after(async () => {
    if (app) { const db = app.get(DATABASE); await app.close(); db.close(); }
    const target = path.resolve(temp);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('jit-agent-tools-'));
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  test('A：先检索档案，再用真实ID取得全部关联附件，不误选同名的全局文件', async () => {
    const reply = await ask('帮我查找采购合同的档案和附件。', borrowerCookie);
    assertTools(reply, ['archive.search', 'attachment.search']);
    assert.deepEqual(reply.payload.unified.archives.items.map(a => a.id), [ids.contract.id]);
    assert.equal(reply.payload.unified.attachments.total, 2);
    assert.ok(reply.payload.unified.attachments.items.every(f => f.archiveId === ids.contract.id));
    assert.ok(reply.payload.unified.attachments.items.some(f => f.fileId === ids.txt.id));
    assert.match(reply.content, /验收说明\.txt/);
  });
  test('B：PPP 标题定位后返回真实附件名称、格式和所属档案', async () => {
    const reply = await ask('PPP里面有哪些附件？');
    assertTools(reply, ['archive.search', 'attachment.search']);
    assert.equal(reply.payload.unified.attachments.items[0].fileName, '项目清单.txt');
    assert.equal(reply.payload.unified.attachments.items[0].extension, 'txt');
    assert.equal(reply.payload.unified.attachments.items[0].archiveTitle, 'PPP');
    assert.match(reply.content, /项目清单.txt.*txt.*PPP/);
  });
  test('C：用数据库中的真实档号定位，再筛选 PDF', async () => {
    const reply = await ask(`查找档号 ${ids.contract.archiveNo} 的 PDF 附件。`, borrowerCookie);
    assertTools(reply, ['archive.search', 'attachment.search']);
    assert.equal(reply.payload.unified.attachments.total, 1);
    assert.equal(reply.payload.unified.attachments.items[0].fileId, ids.pdf.id);
  });
  test('D：最近7天修改审计使用受控动作和时间，不混入创建记录', async () => {
    const changed = await request(`/api/archives/${ids.contract.id}`, adminCookie,
      { title: '采购合同', archiveType: '文书档案', categoryId: ids.category, keywords: '审计测试' }, 'PUT');
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    const reply = await ask('最近7天谁修改过档案？');
    assertTools(reply, ['audit.search']);
    assert.ok(reply.payload.unified.audits.items.length > 0);
    assert.ok(reply.payload.unified.audits.items.every(a => a.actionLabel === '编辑档案'));
    assert.ok(reply.payload.unified.audits.items.every(a => a.actorName === '工具管理员'));
    assert.match(reply.content, /工具管理员/);
    const intersection = await r.execute('audit.search', { actions: ['archive.update'], keyword: 'PPP' }, admin);
    assert.equal(intersection.total, 0, '动作与关键词必须共同生效');
  });
  test('E：档案、附件和相关审计联合调度，审计按档案ID关联', async () => {
    const reply = await ask('查询采购合同的档案、附件和相关操作记录。', borrowerCookie);
    assert.equal(reply.payload.toolExecutionStatus, 'partial');
    assert.equal(reply.payload.unified.attachments.total, 2);
    assert.equal(reply.payload.unified.audits.total, 0);
    assert.equal(reply.payload.toolResults.find(t => t.toolName === 'audit.search').error.code, '403');
    const all = await ask('查询采购合同的档案、附件和相关操作记录。');
    assertTools(all, ['archive.search', 'attachment.search', 'audit.search']);
    assert.ok(all.payload.unified.audits.items.some(a => a.actionLabel === '编辑档案'));
    assert.ok(all.payload.unified.audits.items.every(a => !String(a.objectLabel).includes('PPP')));
  });
  test('附件名称独立筛选与分页；空档案定位不会变成全局查询', async () => {
    const selected = await r.execute('attachment.search', { archiveIds: [ids.contract.id], attachmentFileName: '验收', extension: 'txt' }, borrower);
    assert.equal(selected.total, 1);
    assert.equal(selected.data.items[0].fileId, ids.txt.id);
    const page = await r.execute('attachment.search', { archiveIds: [ids.contract.id], page: 2, pageSize: 1 }, borrower);
    assert.equal(page.total, 2); assert.equal(page.data.items.length, 1); assert.equal(page.pagination.page, 2);
    const empty = await ask('并不存在的档案里面有哪些附件？', borrowerCookie);
    assert.equal(empty.payload.unified.attachments.total, 0);
    const byId = await ask(`查询档案ID ${ids.ppp.id} 的附件`, borrowerCookie);
    assert.equal(byId.payload.unified.attachments.items[0].archiveId, ids.ppp.id);
    assert.equal(byId.payload.toolResults.find(t => t.callId === 'archives').toolName, 'archive.detail');
  });
  test('拒绝直接指定无权档案ID、受限附件和正文；全局检索不外泄', async () => {
    for (const name of ['attachment.search', 'content.search', 'content.read']) {
      const result = await r.execute(name, { archiveIds: [ids.secret.id] }, borrower);
      assert.equal(result.status, 'error'); assert.equal(result.error.code, '403');
    }
    const detail = await r.execute('archive.detail', { archiveId: ids.secret.id }, borrower);
    assert.equal(detail.error.code, '403');
    const global = await r.execute('attachment.search', {}, borrower);
    assert.ok(global.data.items.every(f => f.archiveId !== ids.secret.id));
  });
  test('业务失败只影响自己的工具；已成功的档案、附件结果仍可显示', async () => {
    const original = r.execute.bind(r);
    r.execute = async (name, params, user) => name === 'audit.search'
      ? { toolName: name, status: 'error', data: null, total: 0, pagination: null, error: { code: '500', message: '模拟审计查询故障' } }
      : original(name, params, user);
    try {
      const reply = await ask('查询采购合同的档案、附件和相关操作记录。');
      assert.equal(reply.payload.toolExecutionStatus, 'partial');
      assert.ok(reply.payload.unified.archives.total > 0);
      assert.equal(reply.payload.unified.attachments.total, 3, '管理员也可查看同名受限档案的附件');
      assert.match(reply.content, /模拟审计查询故障/);
    } finally { r.execute = original; }
  });
  test('分类/模板/统计、本人借阅/详情与审核视角均复用真实服务', async () => {
    const template = await request('/api/templates', adminCookie, { name: '工具测试模板', description: '真实字段模板',
      fields: [{ fieldKey: 'contract_ref', label: '合同编号', type: 'text', required: false }] });
    assert.equal(template.status, 201);
    const categories = await r.execute('category.list', { categoryId: ids.category }, borrower);
    assert.equal(categories.total, 1);
    const byCategory = await ask(`查询分类ID ${ids.category} 下的档案`, borrowerCookie);
    assert.ok(byCategory.payload.unified.archives.items.length > 0);
    assert.ok(byCategory.payload.unified.archives.items.every(a => a.categoryName === '工具测试合同'));
    const templates = await r.execute('template.search', { keyword: '工具测试模板' }, admin);
    assert.equal(templates.total, 1);
    assert.equal(templates.data.items[0].id, template.data.id);
    assert.equal(templates.data.items[0].fields[0].fieldKey, 'contract_ref');
    assert.equal((await request(`/api/categories/${ids.category}/template`, adminCookie, { templateId: template.data.id }, 'PUT')).status, 200);
    const bound = await r.execute('template.search', { categoryId: ids.category }, admin);
    assert.ok(bound.data.items[0].boundCategories.some(c => c.id === ids.category));
    const stats = await r.execute('statistics.get', { timeRange: '7d' }, borrower);
    assert.equal(stats.status, 'success'); assert.ok(stats.data.metrics.length > 0);
    const borrow = await request('/api/borrow-requests', borrowerCookie, { archiveId: ids.contract.id, purpose: '隔离测试', days: 7 });
    assert.equal(borrow.status, 201);
    const mine = await r.execute('borrow.search', { scope: 'mine' }, admin);
    assert.equal(mine.total, 0, '管理员查询我的借阅不能看到他人记录');
    const record = await r.execute('borrow.detail', { requestId: borrow.data.id }, borrower);
    assert.equal(record.data.items[0].id, borrow.data.id);
    assert.equal((await r.execute('borrow.search', { scope: 'review' }, borrower)).error.code, '403');
    const pending = await ask('查询待处理借阅申请');
    assert.ok(pending.payload.unified.borrowings.items.every(x => x.status === 'pending'));
    const guest = await ask('查询我的借阅记录', guestCookie);
    assert.equal(guest.payload.toolExecutionStatus, 'error');
  });
  test('正文取证经过注册工具，保留原有附件问答响应和来源', async () => {
    const reply = await ask('采购合同的付款条件是什么？', borrowerCookie);
    assert.deepEqual(reply.payload.toolResults.map(t => t.toolName), ['archive.search', 'content.read']);
    assert.ok(['content_evidence', 'content_answer'].includes(reply.payload.kind));
    assert.ok(reply.payload.sources.some(s => s.fileId === ids.txt.id));
  });
  test('未登录、未知工具、写工具、身份注入均被拒绝；执行只读工具不改业务表', async () => {
    assert.equal((await request('/api/agent/ask', null, { question: 'PPP里面有哪些附件？' })).status, 401);
    assert.equal((await r.execute('archive.delete', { archiveId: ids.contract.id }, admin)).error.code, 'UNREGISTERED_TOOL');
    assert.equal((await r.execute('borrow.request', {}, admin)).error.code, 'UNREGISTERED_TOOL');
    assert.equal((await r.execute('archive.search', { userId: admin.id }, borrower)).error.code, '400');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    try {
      const tables = ['archives', 'archive_files', 'archive_categories', 'borrow_requests', 'metadata_templates'];
      const snapshot = () => tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all());
      const before = snapshot();
      await d.dispatch({ kind: 'unified_search', title: '采购合同', scopes: ['archive', 'attachment', 'audit', 'template', 'stats'] }, admin);
      assert.deepEqual(snapshot(), before);
    } finally { db.close(); }
  });
});
