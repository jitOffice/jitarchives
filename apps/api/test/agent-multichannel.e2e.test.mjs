import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import PizZip from 'pizzip';
import { bootstrap } from '../dist/main.js';
import { DATABASE } from '../dist/db/database.js';
import { ContentIndexService } from '../dist/archives/content/content-index.service.js';
import { ContentIndexRepository } from '../dist/archives/content/content-index.repositories.js';
import { AgentToolRegistry } from '../dist/agent/tool.registry.js';
import { parseDeterministic, sanitizeIntent } from '../dist/agent/intent.parser.js';
import { emptyRetrievalPlan } from '../dist/agent/retrieval.plan.js';

for (const question of ['财务合同附件的内容是什么？', '财务合同的附件内容是什么？', '财务合同附件里面写了什么？', '那你帮我看看财务合同附件的内容是什么？']) {
  test(`结构化理解：${question}`, () => {
    const { intent } = parseDeterministic({ question, categories: [] });
    assert.equal(intent.intentType, 'content_summary');
    assert.ok(intent.archiveTitleCandidates.includes('财务合同'));
    assert.ok(intent.attachmentNameCandidates.includes('财务合同附件'));
    assert.ok(!intent.archiveTitleCandidates.includes('财务合同附件'));
    assert.equal(intent.isExplicitScope, false);
    assert.equal(intent.contentScope, 'global');
    assert.ok(Array.isArray(intent.metadataTerms) && Array.isArray(intent.contentTerms));
  });
}
test('模型意图只接受有界字符串，不接受权限或对象 ID', () => {
  const intent = sanitizeIntent({ kind: 'content_question', archiveTitleCandidates: ['财务合同', 42, {}, 'a'.repeat(500)],
    attachmentNameCandidates: ['财务合同附件'], contentTerms: ['违约金'], archiveIds: [999], fileIds: [999], role: 'admin', isExplicitScope: true }, []);
  assert.deepEqual(intent.archiveTitleCandidates, ['财务合同', 'a'.repeat(100)]);
  for (const key of ['archiveIds', 'fileIds', 'role', 'isExplicitScope']) assert.equal(intent[key], undefined);
});
test('对话用语清理保留英文标题和文件名首尾字母s', () => {
  const intent = parseDeterministic({ question: '你告诉我附件名称为Office Terms的内容是什么？', categories: [] }).intent;
  assert.equal(intent.attachmentFileName, 'Office Terms');
  assert.ok(intent.attachmentNameCandidates.includes('Office Terms'));
});

function word(paragraphs) {
  const zip = new PizZip();
  zip.file('word/document.xml', `<w:document><w:body>${paragraphs.map(s => `<w:p><w:r><w:t>${s}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generate({ type: 'nodebuffer' });
}
function pdf() {
  return Buffer.from('%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R/Contents 5 0 R>> endobj\n4 0 obj <</Type/Page/Parent 2 0 R/Contents 6 0 R>> endobj\n5 0 obj <</Length 40>> stream\nBT (First payment section.) Tj ET\nendstream endobj\n6 0 obj <</Length 40>> stream\nBT (Final delivery section.) Tj ET\nendstream endobj\n%%EOF', 'latin1');
}

test('五路独立检索、全文读取与实际 Mock AI 调用', { timeout: 90000 }, async t => {
  const temp = mkdtempSync(path.join(tmpdir(), 'jit-multi-'));
  const model = { available: true, provider: 'mock-deepseek', model: 'mock-deepseek-chat', calls: [], fail: false,
    async chatCompletion(messages) {
      if (messages[0]?.content?.startsWith('RETRIEVAL_PLAN_V1')) {
        const input = JSON.parse(messages.at(-1).content);
        const question = String(input.question ?? '');
        const intent = parseDeterministic({ question, categories: [] }).intent;
        const plan = emptyRetrievalPlan(question);
        plan.taskGoal = intent.intentType ?? 'content_qa';
        plan.responseMode = intent.isSummaryQuestion ? 'summary' : 'content_qa';
        plan.archiveTitleCandidates = intent.archiveTitleCandidates ?? [];
        const archiveNo = intent.archiveNo ?? intent.archiveNumber;
        plan.archiveNumberCandidates = archiveNo ? [archiveNo] : [];
        plan.attachmentNameCandidates = intent.attachmentNameCandidates ?? [];
        plan.metadataTerms = intent.metadataTerms ?? [];
        plan.contentTerms = intent.contentTerms ?? [];
        plan.searchSources = ['archive', 'metadata', 'attachment', 'content'];
        if (archiveNo) plan.hardConstraints.archiveNumbers = [archiveNo];
        if (/档案标题为/u.test(question) && plan.archiveTitleCandidates[0]) {
          plan.hardConstraints.archiveTitles = [plan.archiveTitleCandidates[0]];
        }
        if (/附件名称为/u.test(question)) {
          const name = intent.attachmentFileName ?? plan.attachmentNameCandidates[0];
          if (name) plan.hardConstraints.attachmentNames = [name];
        }
        const steps = [];
        const archiveTerm = archiveNo ?? plan.archiveTitleCandidates[0];
        if (archiveTerm) steps.push({ id: 'archives', tool: 'archive.search', intent: '定位档案', expects: 'metadata',
          args: archiveNo ? { archiveNo } : { keyword: archiveTerm }, searchScope: { kind: 'allAuthorized' }, dependsOn: [], referenceRefs: [] });
        const metadataOnly = /元数据为青山集团/u.test(question);
        const asksWhichAttachment = /哪个附件|哪些附件|什么附件/u.test(question);
        const attachmentTerm = plan.hardConstraints.attachmentNames[0] ??
          (!metadataOnly && !asksWhichAttachment && !archiveNo ? plan.attachmentNameCandidates[0] : undefined);
        if (attachmentTerm) steps.push({ id: 'attachments', tool: 'attachment.search', intent: '定位附件', expects: 'attachmentNames',
          args: { attachmentFileName: attachmentTerm }, searchScope: { kind: 'allAuthorized' }, dependsOn: [], referenceRefs: [] });
        if (plan.contentTerms.length) steps.push({ id: 'content', tool: 'content.search', intent: '检索正文', expects: 'relevantText',
          args: { query: plan.contentTerms.join(' ') }, searchScope: { kind: 'allAuthorized' }, dependsOn: [], referenceRefs: [] });
        for (let i = 0; i < plan.metadataTerms.length; i++) steps.push({ id: `metadata:${i + 1}`, tool: 'archive.search', intent: '检索元数据线索', expects: 'metadata',
          args: { keyword: plan.metadataTerms[i] }, searchScope: { kind: 'allAuthorized' }, dependsOn: [], referenceRefs: [] });
        if (plan.responseMode === 'summary') {
          const locator = metadataOnly ? 'metadata:1'
            : plan.hardConstraints.attachmentNames.length ? 'attachments'
            : plan.hardConstraints.archiveTitles.length || archiveNo ? 'archives'
            : attachmentTerm ? 'attachments'
            : archiveTerm ? 'archives'
            : plan.contentTerms.length ? 'content' : null;
          if (locator) steps.push({ id: 'read', tool: 'content.read', intent: '读取定位结果的完整正文', expects: 'fullText',
            args: {}, scope: `step:${locator}`, dependsOn: [locator], referenceRefs: [] });
        }
        if (!steps.length) steps.push({ id: 'content', tool: 'content.search', intent: '按原问题检索正文', expects: 'relevantText',
          args: { query: question }, searchScope: { kind: 'allAuthorized' }, dependsOn: [], referenceRefs: [] });
        plan.planSteps = steps;
        return { content: JSON.stringify(plan), truncated: false };
      }
      if (messages[0]?.content?.startsWith('EVIDENCE_SUFFICIENCY_V1')) {
        return { content: JSON.stringify({ verdict: 'sufficient', note: 'mock evidence is sufficient', supplement: [] }), truncated: false };
      }
      this.calls.push(structuredClone(messages));
      if (this.fail) throw Error('mock connection failure');
      if(messages.at(-1).content.includes('已核验的章节摘要：')){
        const summaries=JSON.parse(messages.at(-1).content.split('已核验的章节摘要：')[1]);
        const claims=summaries.slice(0,4).map(c=>({...c,evidenceQuote:c.text}));
        return {content:JSON.stringify({answer:claims.map(c=>c.text).join('；'),claims}),truncated:false};
      }
      const quotes = [...messages.at(-1).content.matchAll(/\[(E\d+)\] 来源：[\s\S]*?"""([\s\S]*?)"""/gu)];
      assert.ok(quotes.length, '内容回答必须传入真实证据');
      const claims = quotes.slice(0, 4).map(([, ref, quote]) => ({ text: quote.slice(0, 120), citations: [ref], evidenceQuote: quote.slice(0, 120) }));
      return { content: JSON.stringify({ answer: claims.map(c => c.text).join('；'), claims }), truncated: false };
    } };
  let app, db;
  try {
    const server = await bootstrap({ port: 0, dbFile: path.join(temp, 'db.sqlite'), fileStoreDir: path.join(temp, 'files'),
      serveWeb: false, knowledgeWorker: false, aiModelClient: model,
      embeddingClient: { available: false, modelKey: 'disabled', async embed() { throw Error('unexpected embedding'); } } });
    app = server.app; db = app.get(DATABASE);
    const call = async (url, cookie, body, method = 'POST', raw = false) => {
      const r = await fetch(`${server.baseUrl}/api${url}`, { method, headers: { Cookie: cookie ?? '', 'Content-Type': raw ? 'application/octet-stream' : 'application/json' },
        body: method === 'GET' ? undefined : raw ? body : JSON.stringify(body ?? {}) });
      return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[0] };
    };
    const admin = await call('/auth/init-admin', '', { username: 'multi_admin', password: 'Admin#12345', displayName: '多路管理员' });
    assert.equal(admin.status, 201);
    const cookies = { admin: admin.cookie }, users = {};
    const me = async role => { const r = await call('/auth/me', cookies[role], undefined, 'GET'); return r.data.user ?? r.data; };
    users.admin = await me('admin');
    for (const role of ['reviewer', 'cataloger', 'borrower', 'guest']) {
      assert.equal((await call('/users', cookies.admin, { username: `multi_${role}`, password: 'User#12345', displayName: role, role })).status, 201);
      cookies[role] = (await call('/auth/login', '', { username: `multi_${role}`, password: 'User#12345' })).cookie;
      users[role] = await me(role);
    }
    const category = (await call('/categories', cookies.admin, { name: '多路验收', code: 'MULTI' })).data;
    const create = async (title, accessLevel = 'public', role = 'admin', fieldValues) => {
      const r = await call('/archives', cookies[role], { title, accessLevel, categoryId: category.id, archiveType: '文书档案', fieldValues });
      assert.equal(r.status, 201); return r.data;
    };
    const index = app.get(ContentIndexService), repo = app.get(ContentIndexRepository), registry = app.get(AgentToolRegistry);
    const upload = async (archive, name, bytes, role = 'admin') => {
      const r = await call(`/archive-files/upload?archiveId=${archive.id}&name=${encodeURIComponent(name)}`, cookies[role], Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), 'POST', true);
      assert.equal(r.status, 201); index.indexFileById(r.data.id); return r.data;
    };
    const ask = async (question, role = 'admin') => {
      const r = await call('/agent/ask', cookies[role], { question });
      assert.equal(r.status, 201); return r.data.reply;
    };
    const finance = await create('财务合同'), unrelated = await create('无关目录');
    const txt = await upload(finance, '财务合同附件.txt', '付款条件：验收合格后30日内付款。\n违约金：逾期每日支付1%。\n末章：争议提交约定法院处理。');
    const workspace = await upload(unrelated, 'AI Office Workspace 工作总结.docx', word(['首章：完成文档整理。', '末章：下阶段进行档案验收。']));
    const body = await upload(unrelated, '普通资料.txt', '唯一业务关键字：星河工程履约保障。');

    for (const question of ['财务合同附件的内容是什么？', '财务合同的附件内容是什么？', '财务合同附件里面写了什么？']) {
      await t.test(`无自定义元数据仍能总结：${question}`, async () => {
        const before = model.calls.length, reply = await ask(question);
        assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
        assert.equal(model.calls.length, before + 1);
        assert.match(model.calls.at(-1).at(-1).content, /付款条件：验收合格后30日内付款/);
        assert.match(model.calls.at(-1).at(-1).content, /末章：争议提交约定法院处理/);
        assert.equal(new Set(reply.payload.sources.map(s => s.fileId)).size, 1);
        assert.ok(reply.payload.sources.every(s => s.archiveId === finance.id && s.fileId === txt.id));
        assert.equal(reply.payload.modelCall.attempted, true);
        assert.equal(reply.payload.modelCall.status, 'success');
        assert.equal(reply.payload.modelCall.provider, 'mock-deepseek');
        assert.equal(reply.payload.modelCall.modelEvidenceCount, reply.payload.modelCall.evidenceCount);
      });
    }
    await t.test('档案标题无结果：无扩展名附件名称直接定位所属档案', async () => {
      const before = model.calls.length, reply = await ask('AI Office Workspace 工作总结的内容是什么？');
      assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
      assert.equal(model.calls.length, before + 1);
      assert.ok(reply.payload.sources.every(s => s.archiveId === unrelated.id && s.fileId === workspace.id));
      assert.match(model.calls.at(-1).at(-1).content, /首章：完成文档整理/);
      assert.match(model.calls.at(-1).at(-1).content, /末章：下阶段进行档案验收/);
      assert.ok(reply.payload.toolResults.some(r => r.toolName === 'archive.search' && r.total === 0));
      assert.ok(reply.payload.toolResults.some(r => r.toolName === 'attachment.search' && r.total > 0));
    });
    await t.test('档案标题、附件名称均无结果：全局正文继续执行', async () => {
      const reply = await ask('星河工程履约保障附件的内容是什么？');
      assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
      assert.ok(reply.payload.sources.some(s => s.fileId === body.id));
      for (const name of ['archive.search', 'attachment.search']) assert.ok(reply.payload.toolResults.filter(r => r.toolName === name).every(r => r.total === 0));
      assert.match(model.calls.at(-1).at(-1).content, /唯一业务关键字：星河工程履约保障/);
    });
    await t.test('元数据无命中不会阻断标题、附件与正文；多路命中去重', async () => {
      const reply = await ask('财务合同附件的内容是什么？元数据为不存在的元数据');
      assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
      assert.ok(reply.payload.toolResults.some(r => r.callId?.startsWith('metadata:') && r.total === 0));
      const rows = reply.payload.toolResults.find(r => r.toolName === 'content.read').data.items;
      assert.equal(new Set(rows.map(r => r.chunkId)).size, rows.length);
      assert.ok(reply.payload.sources.every(s => s.archiveId === finance.id));
    });
    await t.test('档案标题检索异常后附件与正文仍执行，部分覆盖如实标注', async () => {
      const original = registry.execute.bind(registry);
      registry.execute = async (name, params, user) => name === 'archive.search' ? { toolName: name, status: 'error', data: null, total: 0, pagination: null, error: { code: '500', message: 'mock archive failure' } } : original(name, params, user);
      try {
        const before = model.calls.length, reply = await ask('财务合同附件的内容是什么？');
        assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
        assert.equal(model.calls.length, before + 1);
        assert.ok(reply.payload.toolResults.some(r => r.toolName === 'attachment.search' && r.total));
        assert.match(reply.content, /有一部分查询没有成功/);
      } finally { registry.execute = original; }
    });
    await t.test('全局问题传入多个附件真实正文及所属档案，调用次数准确', async () => {
      const other = await upload(unrelated, '另一合同.txt', '违约金：逾期每日支付2%。');
      const before = model.calls.length, reply = await ask('哪个附件提到了违约金？');
      assert.equal(model.calls.length, before + 1);
      assert.equal(reply.payload.kind, 'content_answer');
      assert.deepEqual(new Set(reply.payload.sources.map(s => s.fileId)), new Set([txt.id, other.id]));
      assert.match(model.calls.at(-1).at(-1).content, /支付1%/);
      assert.match(model.calls.at(-1).at(-1).content, /支付2%/);
    });
    await t.test('不存在或仅为其他档号子串的明确档号不能扩大范围', async () => {
      await upload(unrelated, 'MISSING-2099-999999.txt', '违约金：文件名称不能替代档号。');
      for (const no of ['MISSING-2099-999999', finance.archiveNo.slice(0, -1)]) {
        const before = model.calls.length, reply = await ask(`档号 ${no} 的内容是什么？`);
        assert.equal(reply.payload.kind, 'content_no_evidence');
        assert.equal(model.calls.length, before);
        assert.equal(reply.payload.sources.length, 0);
        assert.ok(!reply.payload.toolResults.some(r => r.toolName.startsWith('content.') && r.status === 'success'));
      }
    });
    await t.test('明确档案名称无命中不能用同名附件替代', async () => {
      await upload(unrelated, '不存在档案.txt', '违约金：不能跨越用户明确范围。');
      const before = model.calls.length, reply = await ask('档案标题为不存在档案的内容是什么？');
      assert.equal(reply.payload.kind, 'content_no_evidence');
      assert.equal(model.calls.length, before);
      assert.equal(reply.payload.sources.length, 0);
    });
    await t.test('明确档案标题定位成功时不把内容问法粘到标题，也不扩大到其他档案', async () => {
      const before = model.calls.length, reply = await ask('档案标题为财务合同的内容是什么？');
      assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
      assert.equal(model.calls.length, before + 1);
      assert.ok(reply.payload.sources.every(s => s.archiveId === finance.id));
    });
    await t.test('明确档号与附件名称同时限定时只读取指定附件', async () => {
      await upload(finance, '财务合同其他材料.txt', '其他附件独有暗语：不应交给模型。');
      const before = model.calls.length, reply = await ask(`档号 ${finance.archiveNo} 的附件名称为财务合同附件的内容是什么？`);
      assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
      assert.equal(model.calls.length, before + 1);
      assert.ok(reply.payload.sources.every(s => s.fileId === txt.id && s.archiveId === finance.id));
      assert.doesNotMatch(model.calls.at(-1).at(-1).content, /其他附件独有暗语/);
      const after = model.calls.length, missing = await ask(`档号 ${finance.archiveNo} 的附件名称为根本不存在的正文材料的内容是什么？`);
      assert.equal(missing.payload.kind, 'content_no_evidence');
      assert.equal(model.calls.length, after);
      assert.equal(missing.payload.sources.length, 0);
    });
    await t.test('无证据和档案列表均不调用 AI，模型异常与未配置有明确状态', async () => {
      const before = model.calls.length;
      assert.equal((await ask('哪个附件提到了不存在的哈希暗语？')).payload.kind, 'content_no_evidence');
      assert.equal((await ask('我有哪些档案？')).payload.intent, 'search');
      assert.equal(model.calls.length, before);
      model.fail = true;
      const failed = await ask('哪个附件提到了违约金？');
      assert.equal(model.calls.length, before + 1);
      assert.equal(failed.payload.modelCall.status, 'failed');
      assert.match(failed.content, /AI 服务异常/);
      model.fail = false; model.available = false;
      const unavailable = await ask('哪个附件提到了违约金？');
      assert.equal(model.calls.length, before + 1);
      assert.equal(unavailable.payload.modelCall.status, 'unavailable');
      assert.equal(unavailable.payload.modelCall.attempted, false);
      assert.equal(unavailable.payload.modelCall.modelEvidenceCount, 0);
      assert.match(unavailable.content, /未启用可用/);
      model.available = true;
    });
    for (const [extension, bytes, expected, locator] of [
      ['txt', '首章：总则。\n末章：交付要求。', ['首章：总则', '末章：交付要求'], /TXT 第/],
      ['docx', word(['首章：总则。', '末章：交付要求。']), ['首章：总则', '末章：交付要求'], /DOCX 第/],
      ['pdf', pdf(), ['First payment section', 'Final delivery section'], /PDF 第/],
    ]) {
      await t.test(`${extension} 全部分块按原文顺序传入模型并保留真实位置`, async () => {
        const archive = await create(`全文验收${extension}`), file = await upload(archive, `全文样本.${extension}`, bytes);
        const all = repo.listChunksOfArchives([archive.id], { userId: users.admin.id, admin: true }, -1, [file.id]);
        assert.ok(all.length > 0);
        const before = model.calls.length, reply = await ask(`档号 ${archive.archiveNo} 的内容是什么？`);
        assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
        assert.equal(model.calls.length, before + 1);
        const prompt = model.calls.at(-1).at(-1).content;
        assert.ok(prompt.indexOf(expected[0]) < prompt.indexOf(expected[1]));
        for (const row of all) assert.ok(prompt.includes(row.text), row.locator);
        assert.equal(reply.payload.modelCall.modelEvidenceCount, all.length);
        assert.ok(reply.payload.sources.every(s => s.fileId === file.id && locator.test(s.locator)));
        if (extension === 'pdf') assert.deepEqual(new Set(reply.payload.sources.map(s => s.pageNo)), new Set([1, 2]));
      });
    }
    await t.test('超过500分块分页完整读取并通过分层总结覆盖全文，受累计预算约束', async () => {
      const archive = await create('长篇合同'), file = await upload(archive, '长篇合同.txt', '原始正文。');
      const unit = repo.listUnitsOfFile(file.id)[0];
      const chunks = Array.from({ length: 520 }, (_, i) => ({ chunkNo: i + 1, text: `第${i + 1}章：${'长文测试内容'.repeat(60)}。`, locator: `TXT 第 ${i + 1} 行`, unit: 'line', pageNo: null, posFrom: i + 1, posTo: i + 1 }));
      repo.replaceUnit({ ...unit, chunks });
      const read = await registry.execute('content.read', { archiveIds: [archive.id], fileIds: [file.id], summary: true }, users.admin);
      assert.equal(read.status, 'success');
      assert.equal(read.data.items.length, 520);
      assert.equal(read.data.items[519].text, chunks[519].text);
      const reply = await ask(`档号 ${archive.archiveNo} 的内容是什么？`);
      assert.equal(reply.payload.modelCall.evidenceCount, 520);
      assert.equal(reply.payload.modelCall.modelEvidenceCount,520);
      assert.equal(reply.payload.answerGeneration.processedEvidenceCount,520);
      assert.equal(reply.payload.kind,'content_answer');
      assert.ok(reply.payload.answerGeneration.sections>24);
      for(const chunk of chunks)assert.ok(model.calls.some(messages=>messages.at(-1).content.includes(chunk.text)),chunk.locator);
      assert.doesNotMatch(reply.content,/未覆盖全文|不能视为全文总结/);
      assert.ok(model.calls.some(messages=>messages.at(-1).content.includes(chunks[519].text)), '跨全文选取必须覆盖末章');
    });
    const template = await call('/templates', cookies.admin, { name: '多路元数据模板', fields: [{ fieldKey: 'business', label: '业务标识', type: 'text', required: false }] });
    assert.equal(template.status, 201);
    assert.equal((await call(`/categories/${category.id}/template`, cookies.admin, { templateId: template.data.id }, 'PUT')).status, 200);
    await t.test('仅自定义元数据命中可定位附件并将真实全文交给AI', async () => {
      const archive = await create('独立目录元数据样本', 'public', 'admin', { business: '青山集团' });
      const file = await upload(archive, '普通正文材料.txt', '合同约定：验收后进行结算。');
      const before = model.calls.length, reply = await ask('元数据为青山集团的档案附件的内容是什么？');
      assert.equal(reply.payload.kind, 'content_answer', JSON.stringify(reply));
      assert.equal(model.calls.length, before + 1);
      assert.ok(reply.payload.toolResults.some(r => r.callId?.startsWith('metadata:') && r.total > 0));
      assert.ok(reply.payload.sources.every(s => s.archiveId === archive.id && s.fileId === file.id));
      assert.match(model.calls.at(-1).at(-1).content, /合同约定：验收后进行结算/);
      const after = model.calls.length, missing = await ask('档案标题为根本不存在的指定档案，元数据为青山集团的内容是什么？');
      assert.equal(missing.payload.kind, 'content_no_evidence');
      assert.equal(model.calls.length, after);
      assert.equal(missing.payload.sources.length, 0);
    });
    const restricted = await create('权限隐秘合同', 'restricted', 'admin', { business: '权限隐秘元数据' });
    const secret = await upload(restricted, '权限隐秘附件.txt', '权限隐秘正文：黑曜石。');
    const own = await create('著录员权限合同', 'restricted', 'cataloger');
    await upload(own, '著录员私有附件.txt', '著录员私有正文。', 'cataloger');
    for (const role of ['admin', 'reviewer', 'cataloger', 'borrower', 'guest']) {
      await t.test(`${role} 五种检索入口在SQL阶段过滤权限，并拒绝直接附件读取越权`, async () => {
        for (const [tool, params] of [
          ['archive.search', { title: restricted.title }], ['archive.search', { archiveNo: restricted.archiveNo }],
          ['archive.search', { keyword: '权限隐秘元数据' }], ['attachment.search', { attachmentFileName: '权限隐秘附件' }],
          ['content.search', { keyword: '权限隐秘正文' }],
        ]) {
          const r = await registry.execute(tool, params, users[role]);
          assert.equal(r.status, 'success');
          assert.equal(r.total > 0, role === 'admin', `${role} ${tool}`);
          if (role !== 'admin') assert.doesNotMatch(JSON.stringify(r), /黑曜石|权限隐秘附件/);
        }
        const direct = await registry.execute('content.read', { archiveIds: [restricted.id], fileIds: [secret.id], summary: true }, users[role]);
        assert.equal(direct.status, role === 'admin' ? 'success' : 'error');
        const before = model.calls.length, reply = await ask('哪个附件提到了权限隐秘正文？', role);
        assert.equal(model.calls.length, before + (role === 'admin' ? 1 : 0));
        if (role !== 'admin') assert.doesNotMatch(JSON.stringify(reply), /黑曜石/);
      });
    }
  } finally {
    if (app) await app.close();
    if (db) db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
