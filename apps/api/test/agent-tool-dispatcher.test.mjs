import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolRegistry } from '../dist/agent/tool.registry.js';
import { AgentToolDispatcher } from '../dist/agent/tool.dispatcher.js';
import { parseDeterministic, sanitizeIntent } from '../dist/agent/intent.parser.js';
import { withAgentTrace, understood, recordStep, tracedAnswer, finishAgentTrace } from '../dist/agent/agent.trace.js';

const user = { id: 7, role: 'borrower', status: 'active', displayName: '测试用户' };
const admin = { ...user, role: 'admin' };
const success = (toolName, items = [], total = items.length, pagination = null) => ({ toolName, status: 'success',
  data: { items }, total, pagination, error: null });
function registry(overrides = {}) {
  const archiveCalls = [];
  const archives = { searchArchives: (p, u) => { archiveCalls.push({ p, u }); return { items: [], total: 0 }; },
    listCategories: () => [], getArchiveDetail: (id) => ({ id }) };
  const access = { loadArchive: (id) => ({ id }), assertView: () => {}, canView: () => true };
  const unified = { search: () => ({ attachments: { items: [], total: 0 }, contents: { items: [], total: 0 } }) };
  const r = new AgentToolRegistry(overrides.archives ?? archives, overrides.access ?? access, overrides.unified ?? unified,
    overrides.business ?? { search: () => ({}) }, overrides.borrowing ?? {}, overrides.index ?? { describeVisible: () => [] }, overrides.units ?? {});
  return { r, archives, archiveCalls };
}

test('工具注册表包含15个只读工具，Schema 拒绝额外属性', () => {
  const { r } = registry();
  const tools = r.list();
  assert.equal(tools.length, 15);
  assert.equal(new Set(tools.map(t => t.name)).size, tools.length);
  assert.ok(tools.every(t => t.readOnly && t.description && t.parameters.additionalProperties === false));
  assert.ok(tools.every(t => !/delete|save|approve|request$/.test(t.name)));
  tools[0].parameters.properties.evil = { type: 'string' };
  assert.equal(r.list()[0].parameters.properties.evil, undefined, '元数据副本不能修改注册表');
});

test('参数必须严格通过白名单和类型校验；身份不能经模型参数注入', async () => {
  const { r, archiveCalls } = registry();
  for (const p of [{ userId: 1 }, { role: 'admin' }, { viewer: admin }, { page: '1' }, { page: 0 },
    { pageSize: 101 }, { keyword: ['合同'] }, { status: 'deleted' }, { ['__proto__']: {} }, { keyword: 'x'.repeat(101) }]) {
    assert.equal((await r.execute('archive.search', p, user)).error.code, '400');
  }
  assert.equal((await r.execute('archive.detail', {}, user)).error.code, '400');
  assert.equal((await r.execute('audit.search', { from: 'today' }, admin)).error.code, '400');
  assert.equal((await r.execute('audit.search', { from: '2026-10-30T00:00:00Z', to: '2026-10-01T00:00:00Z' }, admin)).error.code, '400');
  assert.equal(archiveCalls.length, 0);
});

test('未登录、停用账号、未知角色在调用业务服务前拦截', async () => {
  const { r, archiveCalls } = registry();
  assert.equal((await r.execute('archive.search', {}, null)).error.code, '401');
  assert.equal((await r.execute('archive.search', {}, { ...user, status: 'disabled' })).error.code, '403');
  assert.equal((await r.execute('archive.search', {}, { ...user, role: 'superadmin' })).error.code, '403');
  await assert.rejects(new AgentToolDispatcher(r).execute([], null), /请先登录/);
  assert.equal(archiveCalls.length, 0);
});

test('模型不能调用未注册方法或遗留写工具', async () => {
  const { r } = registry();
  for (const name of ['__proto__', 'constructor', 'archives.deleteArchive', 'archive.catalog_save', 'borrow.request', 'borrow.approve', 'https://example.com']) {
    const result = await r.execute(name, {}, admin);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'UNREGISTERED_TOOL');
  }
});

test('模型只可提供经过第一阶段清洗的意图，不能指定工具方法或身份', () => {
  const intent = sanitizeIntent({ kind: 'search', keyword: 'PPP', toolName: 'archive.delete', method: 'deleteArchive', userId: 1, role: 'admin' }, []);
  assert.equal(intent.userId, undefined); assert.equal(intent.role, undefined); assert.equal(intent.toolName, undefined);
  assert.deepEqual(new AgentToolDispatcher(registry().r).plan(intent).map(c => c.toolName), ['archive.search']);
});

test('档案检索参数与真实服务身份正确传递', async () => {
  const { r, archiveCalls } = registry();
  const result = await r.execute('archive.search', { title: '采购合同', archiveNo: 'HT-2026-000001', categoryId: 3,
    status: 'archived', keyword: '设备', page: 2, pageSize: 5 }, user);
  assert.equal(result.status, 'success');
  assert.deepEqual(archiveCalls[0].p, { title: '采购合同', archiveNo: 'HT-2026-000001', categoryId: '3', status: 'archived', q: '设备', page: '2', pageSize: '5', includeSub: '1' });
  assert.equal(archiveCalls[0].u, user);
  assert.equal(result.pagination.page, 2);
});

test('单工具与 A/B/C/D/E 多工具选择保留第一阶段解析结果', () => {
  const d = new AgentToolDispatcher(registry().r);
  const cases = [
    ['我有哪些档案', ['archive.search']],
    ['帮我查找采购合同的档案和附件。', ['archive.search', 'attachment.search']],
    ['PPP里面有哪些附件？', ['archive.search', 'attachment.search']],
    ['查找档号 HT2026-2026-000012 的 PDF 附件。', ['archive.search', 'attachment.search']],
    ['最近7天谁修改过档案？', ['audit.search']],
    ['查询采购合同的档案、附件和相关操作记录。', ['archive.search', 'attachment.search', 'audit.search']],
  ];
  for (const [question, expected] of cases) {
    const { intent } = parseDeterministic({ question, categories: [] });
    const plan = d.plan(intent, question);
    assert.deepEqual(plan.map(c => c.toolName), expected, question);
    if (question.startsWith('帮我查找采购')) assert.equal(plan[0].params.title, '采购合同');
    if (question.startsWith('PPP')) assert.equal(plan[0].params.title, 'PPP');
    if (question.includes('HT2026')) {
      assert.equal(plan[0].params.archiveNo, 'HT2026-2026-000012');
      assert.equal(plan[1].params.extension, 'pdf');
    }
    if (question.includes('最近7天')) { assert.equal(plan[0].params.timeRange, '7d'); assert.deepEqual(plan[0].params.actions, ['archive.update']); }
  }
});

test('分类、模板、借阅、统计工具选择及附件名独立筛选', () => {
  const d = new AgentToolDispatcher(registry().r);
  const calls = d.plan({ kind: 'unified_search', title: '采购合同', attachmentFileName: '验收报告',
    scopes: ['archive', 'attachment', 'template', 'category', 'stats'] });
  assert.deepEqual(calls.map(c => c.toolName), ['archive.search', 'attachment.search', 'category.list', 'template.search', 'statistics.get']);
  assert.equal(calls[1].params.attachmentFileName, '验收报告');
  assert.equal(calls[1].params.keyword, undefined);
  assert.equal(calls[1].archiveFrom, 'archives');
  assert.equal(d.plan({ kind: 'borrow_progress' })[0].toolName, 'borrow.search');
  assert.equal(d.plan({ kind: 'borrow_progress' }, '查询借阅记录ID 42')[0].params.requestId, 42);
});

test('操作人名称保留真实姓名并剥离后续查询话术，显式日期和分类ID标准化', () => {
  const d = new AgentToolDispatcher(registry().r);
  for (const question of ['查询操作人为张三的操作记录', '查询操作人员为张三的操作日志', '查询操作人：张三']) {
    const call = d.plan({ kind: 'unified_search', scopes: ['audit'] }, question)[0];
    assert.equal(call.params.actorName, '张三', question);
  }
  const audit = d.plan({ kind: 'unified_search', scopes: ['audit'] }, '查询2026-10-01至2026-10-20操作人为张三的操作记录')[0];
  assert.equal(audit.params.from, '2026-10-01T00:00:00+08:00');
  assert.equal(audit.params.to, '2026-10-20T23:59:59.999+08:00');
  const calls = d.plan({ kind: 'unified_search', scopes: ['archive', 'category'], keyword: 'ID3' }, '查询分类ID3下的档案');
  assert.ok(calls.every(c => c.params.categoryId === 3));
  assert.ok(calls.every(c => c.params.keyword === undefined));
  const contents = d.plan({ kind: 'unified_search', scopes: ['content'], keyword: '付款' }, '查询档案ID 9的正文');
  assert.equal(contents[0].params.archiveId, 9);
  assert.equal(contents[1].archiveFrom, 'archives');
});

test('相互独立的只读工具同时开始，依赖工具在档案完成后执行且传递真实ID', async () => {
  const started = [], releases = new Map();
  const d = new AgentToolDispatcher({ execute: (name, p) => {
    started.push({ name, p });
    return new Promise(resolve => releases.set(name, () => resolve(success(name, name === 'archive.search' ? [{ id: 12 }] : []))));
  } });
  const pending = d.execute([
    { id: 'archives', toolName: 'archive.search', params: {} },
    { id: 'stats', toolName: 'statistics.get', params: {} },
    { id: 'files', toolName: 'attachment.search', params: { attachmentFileName: '验收' }, dependsOn: ['archives'], archiveFrom: 'archives' },
  ], user);
  assert.deepEqual(started.map(x => x.name), ['archive.search', 'statistics.get']);
  releases.get('archive.search')(); releases.get('statistics.get')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started[2].p, { attachmentFileName: '验收', archiveIds: [12] });
  releases.get('attachment.search')();
  assert.equal((await pending).status, 'success');
});

test('参数顺序不同的重复工具调用共用同一个进行中请求', async () => {
  let count = 0;
  const d = new AgentToolDispatcher({ execute: async name => { count++; return success(name); } });
  const r = await d.execute([{ id: 'a', toolName: 'archive.search', params: { title: 'PPP', page: 1 } },
    { id: 'b', toolName: 'archive.search', params: { page: 1, title: 'PPP' } }], user);
  assert.equal(count, 1);
  assert.equal(r.results.length, 2, '各计划节点仍可定位到同一真实结果');
});

test('单工具失败保留其他结果；失败依赖被跳过并明确标注', async () => {
  const invoked = [];
  const d = new AgentToolDispatcher({ execute: async name => {
    invoked.push(name);
    return name === 'archive.search' ? { ...success(name), status: 'error', data: null, error: { code: '500', message: '查询失败' } } : success(name, [{ id: 2 }]);
  } });
  const result = await d.execute([{ id: 'archive', toolName: 'archive.search', params: {} },
    { id: 'stats', toolName: 'statistics.get', params: {} },
    { id: 'files', toolName: 'attachment.search', params: {}, dependsOn: ['archive'], archiveFrom: 'archive' }], user);
  assert.equal(result.status, 'partial');
  assert.equal(result.results.find(r => r.callId === 'stats').total, 1);
  assert.equal(result.results.find(r => r.callId === 'files').error.code, 'DEPENDENCY_FAILED');
  assert.ok(!invoked.includes('attachment.search'));
});

test('档案依赖获取全部分页，附件和审计共享定位页且ID去重', async () => {
  const calls = [];
  const d = new AgentToolDispatcher({ execute: async (name, p) => {
    calls.push({ name, p });
    if (name === 'archive.search') return success(name, (p.page ?? 1) === 1 ? [{ id: 1 }] : [{ id: 2 }], 2,
      { page: p.page ?? 1, pageSize: 1, hasMore: (p.page ?? 1) === 1, totalPages: 2 });
    return success(name);
  } });
  await d.execute([{ id: 'a', toolName: 'archive.search', params: { page: 1 } },
    ...['attachment.search', 'audit.search'].map((toolName, i) => ({ id: String(i), toolName, params: {}, dependsOn: ['a'], archiveFrom: 'a' }))], user);
  assert.equal(calls.filter(c => c.name === 'archive.search').length, 2);
  assert.ok(calls.filter(c => c.name !== 'archive.search').every(c => JSON.stringify(c.p.archiveIds) === '[1,2]'));
});

test('空档案依赖明确跳过，绝不能升级成全局附件检索', async () => {
  let params;
  const d = new AgentToolDispatcher({ execute: async (name, p) => { if (name === 'attachment.search') params = p; return success(name); } });
  const result = await d.dispatch({ kind: 'unified_search', title: '不存在', scopes: ['attachment'] }, user);
  assert.equal(params, undefined);
  assert.equal(result.results[1].status, 'skipped');
  assert.equal(result.results[1].error.code, 'DEPENDENCY_EMPTY');
});

test('全局正文不依赖元数据命中或成功，指定档案正文严格绑定上游', async () => {
  for (const status of ['success', 'error']) {
    const invoked = [];
    const d = new AgentToolDispatcher({ execute: async (name, p) => {
      invoked.push({ name, p });
      return name === 'archive.search' ? { ...success(name), status, data: status === 'error' ? null : { items: [] } } : success(name, [{ chunkId: 8 }]);
    } });
    const global = await d.dispatch({ kind: 'unified_search', scopes: ['archive', 'content'], keyword: '违约金' }, user);
    assert.equal(global.results.find(r => r.toolName === 'content.search').total, 1);
    assert.equal(invoked.find(r => r.name === 'content.search').p.archiveIds, undefined);
    invoked.length = 0;
    const scoped = await d.dispatch({ kind: 'unified_search', scopes: ['content'], title: '指定档案', keyword: '违约金' }, user);
    assert.equal(scoped.results[1].status, 'skipped');
    assert.equal(scoped.results[1].error.code, status === 'error' ? 'DEPENDENCY_FAILED' : 'DEPENDENCY_EMPTY');
    assert.ok(!invoked.some(r => r.name === 'content.search'));
  }
});

test('执行过程记录实际数量、未执行与依赖原因，理解问题不虚报命中', async () => {
  await withAgentTrace(async () => {
    understood();
    recordStep('evidence', 'completed', 3, 4);
    const trace = finishAgentTrace([success('archive.search', [{ id: 1 }, { id: 2 }]),
      { ...success('content.search'), status: 'skipped', error: { code: 'DEPENDENCY_FAILED', message: '依赖档案查询失败' } }], 1);
    assert.equal(trace.find(s => s.id === 'understand').hitCount, 0);
    assert.equal(trace.find(s => s.id === 'archives').hitCount, 2);
    assert.equal(trace.find(s => s.id === 'content').status, 'skipped');
    assert.match(trace.find(s => s.id === 'content').note, /依赖档案查询失败/u);
    assert.equal(trace.find(s => s.id === 'attachments').status, 'skipped');
    assert.equal(trace.find(s => s.id === 'evidence').hitCount, 3, '证据组装数量独立于最终引用数量');
    assert.equal(trace.find(s => s.id === 'answer').status, 'skipped');
  });
  await withAgentTrace(async () => {
    await tracedAnswer(async () => {
      assert.equal(finishAgentTrace().find(s => s.id === 'answer').status, 'running');
    });
    assert.equal(finishAgentTrace().find(s => s.id === 'answer').status, 'completed');
  });
  await withAgentTrace(async () => {
    await assert.rejects(tracedAnswer(async () => { throw new Error('mock failure'); }));
    assert.equal(finishAgentTrace().find(s => s.id === 'answer').status, 'failed');
  });
  await withAgentTrace(async () => {
    assert.equal(finishAgentTrace([success('content.search')]).find(s => s.id === 'answer').status, 'empty');
  });
});

test('附件及正文逐次继承档案访问控制，审计和模板执行现有角色限制', async () => {
  let queries = 0;
  const { r } = registry({ access: { loadArchive: () => { throw new Error('access denied'); } },
    unified: { search: () => { queries++; } } });
  assert.equal((await r.execute('attachment.search', { archiveIds: [99] }, user)).status, 'error');
  assert.equal((await r.execute('content.read', { archiveIds: [99] }, user)).status, 'error');
  assert.equal((await r.execute('audit.search', {}, user)).error.code, '403');
  assert.equal((await r.execute('template.search', {}, user)).error.code, '403');
  assert.equal(queries, 0);
});

test('拒绝缺失依赖、循环依赖与重复节点ID', async () => {
  const d = new AgentToolDispatcher(registry().r);
  await assert.rejects(d.execute([{ id: 'a', toolName: 'archive.search', params: {}, dependsOn: ['b'] }], user), /依赖计划/);
  await assert.rejects(d.execute([{ id: 'a', toolName: 'archive.search', params: {}, dependsOn: ['a'] }], user), /循环/);
  await assert.rejects(d.execute([{ id: 'a', toolName: 'archive.search', params: {} }, { id: 'a', toolName: 'archive.search', params: {} }], user), /依赖计划/);
});
