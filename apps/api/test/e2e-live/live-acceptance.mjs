/**
 * 真实 DeepSeek 端到端验收（AI 能力口径）——与 Mock 机制测试（npm run test）分开运行、分开报告。
 *
 * 运行：npm run test:e2e:live
 * 前置：必须已在环境变量配置真实个人模型（JIT_AI_API_BASE / JIT_AI_MODEL / JIT_AI_API_KEY）。
 *      未配置 → 判定为“不通过”（assert.fail），绝不 skip 蒙混过关（计划第十节 B 硬性要求）。
 *
 * 断言只按机制口径，绝不绑定固定答案串 / 关键词 / 正则：
 *   1. 是否调用 AI 规划；2. 是否产生非空且经权限过滤的真实证据；3. citation 是否全部可追溯；
 *   4. 无依据问题是否正确拒答不编造；5. 越权数据是否绝不泄漏；6. 清单数字是否与数据库一致。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '../../dist/main.js';
import { DATABASE } from '../../dist/db/database.js';
import { ContentIndexService } from '../../dist/archives/content/content-index.service.js';
import { HttpEmbeddingClient } from '../../dist/knowledge/embedding.client.js';
import { KnowledgeWorker } from '../../dist/knowledge/knowledge-worker.service.js';
import { RealAiModelClient } from '../../dist/agent/ai-model.client.js';
import { isAiModelConfigured, loadAiModelConfig } from '../../dist/agent/agent.config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const runBlind = !process.argv.includes('--no-blind');

// —— 涉密/权威标记（用于“无依据不编造”“越权不泄漏”机制判定，非固定答案串）——
const SECRET_MARKER = '8800000';           // restricted 档案独有数字，borrower 绝不应看到
const PROPRIETARY = ['四十五日', '1280000', '青岚仪器', '华锐', '8800000']; // 语料专有事实，nobasis 回答若出现即为张冠李戴式幻觉

// 真实模型 + 调用计数包装（仍走真实网络，只统计 chatCompletion 次数用于报告）。
const real = new RealAiModelClient();
let modelCalls = 0; let plannerOutput;
const countedModel = {
  get available() { return real.available; },
  get model() { return real.model; },
  get provider() { return real.provider; },
  async chatCompletion(messages, options) { modelCalls += 1; const response = await real.chatCompletion(messages, options); if (messages[0].content.startsWith('RETRIEVAL_PLAN_V1')) plannerOutput = response.content; return response; },
};

/** 解析语料 md：取形如 `| 标签 | 角色 | 问题 |` 的行（跳过表头分隔与注释）。 */
function parseCorpus(file) {
  const rows = [];
  for (const line of readFileSync(path.join(HERE, 'corpus', file), 'utf8').split(/\r?\n/u)) {
    const m = line.match(/^\s*\|\s*([a-z]+)\s*\|\s*(admin|borrower)\s*\|\s*(.+?)\s*\|\s*$/u);
    if (m && !/^{-3,}$/.test(m[1])) rows.push({ tag: m[1], actor: m[2], question: m[3] });
  }
  return rows;
}

/** 来源是否可追溯到真实档案/附件/位置。 */
function isTraceableSource(s) {
  return typeof s?.archiveTitle === 'string' && typeof s?.archiveNo === 'string' && typeof s?.fileName === 'string' && typeof s?.excerpt === 'string' && !!s.excerpt.trim() && Number.isInteger(s?.chunkId) && Number.isInteger(s?.archiveId) && s.archiveId > 0
    && Number.isInteger(s?.fileId) && s.fileId > 0
    && typeof s?.locator === 'string' && s.locator.trim().length > 0
    && typeof s?.ref === 'string';
}

/** 每条论断的引用都能回溯到本轮真实来源（sources / metadataSources 的 ref 集合内）。 */
function claimsTraceable(payload) {
  const refs = new Set([...(payload.sources ?? []), ...(payload.metadataSources ?? [])].map((x) => x.ref));
  const claims = payload.claims ?? [];
  return claims.every((c) => (c.citations ?? []).length > 0 && (c.citations ?? []).every((r) => refs.has(r)));
}

// —— 全局：单实例、种子语料、逐题跑 ——
let app, db, server, dir;
const cookies = {};
const truth = { restrictedId: 0 };
const report = [];
const expectations=JSON.parse(readFileSync(path.join(HERE,'corpus','golden-expectations.json'),'utf8'));
const privateBlind=process.env.JIT_AGENT_BLIND_CORPUS ? JSON.parse(readFileSync(process.env.JIT_AGENT_BLIND_CORPUS,'utf8')) : [];

async function api(url, cookie = '', body, method = 'POST') {
  const r = await fetch(server.baseUrl + '/api' + url, {
    method,
    headers: { Cookie: cookie, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => null);
  const sid = r.headers.get('set-cookie')?.match(/jit_sid=([^;]+)/u)?.[0];
  return { status: r.status, data, cookie: sid ?? cookie };
}
async function upload(cookie, archiveId, name, text) {
  const r = await fetch(`${server.baseUrl}/api/archive-files/upload?archiveId=${archiveId}&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' }, body: Buffer.from(text, 'utf8'),
  });
  const j = await r.json();
  assert.equal(r.status,201,JSON.stringify(j));
  app.get(ContentIndexService).indexFileById(j.id);
  return j;
}

test('真实 DeepSeek 端到端验收脚手架', { timeout: 1200000 }, async (t) => {
  // 硬性前置：未配置真实模型 → 判定不通过（绝不 skip）。
  if (!isAiModelConfigured()) {
    assert.fail('未检测到已配置的真实个人模型（JIT_AI_API_BASE/JIT_AI_MODEL/JIT_AI_API_KEY）。'
      + '按验收规定，AI 能力项不得跳过：配置真实模型后重跑 npm run test:e2e:live。Mock 全绿不能代替此项。');
  }
  const cfg = loadAiModelConfig();
  console.log(`\n===== AI 能力验收（真实 DeepSeek：provider=${countedModel.provider} model=${cfg.model}）=====`);

  dir = mkdtempSync(path.join(tmpdir(), 'jit-live-'));
  server = await bootstrap({ port: 0, dbFile: path.join(dir, 'live.db'), fileStoreDir: path.join(dir, 'files'),
    serveWeb: false, knowledgeWorker: false, aiModelClient: countedModel,
    embeddingClient: new HttpEmbeddingClient() });
  app = server.app; db = app.get(DATABASE);

  try {
    const init = await api('/auth/init-admin', '', { username: 'live_admin', password: 'Admin#12345', displayName: '验收管理员' });
    cookies.admin = init.cookie;
    await api('/users', cookies.admin, { username: 'live_borrower', password: 'User#12345', displayName: '借阅者', role: 'borrower' });
    cookies.borrower = (await api('/auth/login', '', { username: 'live_borrower', password: 'User#12345' })).cookie;

    const catEquip = (await api('/categories', cookies.admin, { name: '设备采购', code: 'EQ' })).data;
    const catFin = (await api('/categories', cookies.admin, { name: '财务预算', code: 'FIN' })).data;
    const mk = async (title, categoryId, extra = {}) => (await api('/archives', cookies.admin, { title, categoryId, archiveType: '文书档案', ...extra })).data;

    const spec = await mk('光谱仪采购合同', catEquip.id, { responsible: '青岚仪器' });
    await upload(cookies.admin, spec.id, '光谱仪采购合同.txt',
      '甲方与乙方青岚仪器就光谱仪采购订立本合同。\n货款结算：验收合格后四十五日内支付尾款，逾期按每日万分之五计违约金。\n合同总价人民币1280000元。');
    const cent = await mk('离心机采购合同', catEquip.id, { responsible: '华锐' });
    await upload(cookies.admin, cent.id, '离心机采购合同.txt',
      '甲方与乙方华锐订立离心机采购合同。\n付款条款：验收合格后三十日内付清全款，逾期按合同总额百分之十五计违约金。');
    const restricted = await mk('涉密项目预算', catFin.id, { accessLevel: 'restricted' });
    truth.restrictedId = restricted.id;
    await upload(cookies.admin, restricted.id, '涉密项目预算.txt', `本项目涉密预算总额为 ${SECRET_MARKER} 元，专款专用，限授权人员查阅。`);

    if (new HttpEmbeddingClient().available) {
      const worker = app.get(KnowledgeWorker);
      for (let i=0;i<30;i++) {
        await worker.tick();
        if (!db.prepare("SELECT 1 FROM knowledge_index_jobs WHERE status='indexed' AND embedding_status<>'indexed'").get()) break;
      }
      assert.ok(db.prepare('SELECT COUNT(*) n FROM knowledge_embeddings').get().n > 0, '真实向量索引必须生成');
    }
    const catProject=(await api('/categories',cookies.admin,{name:'项目建设',code:'PRJ'})).data;
    const project=await mk('常规资料夹',catProject.id);truth.project=project.id;
    await upload(cookies.admin,project.id,'项目交付说明.txt','青岚建设项目采用分期交付。2026年6月完成初验，剩余接口联调待处理。');
    const stages=Array.from({length:24},(_,i)=>`阶段记录第${i+1}条：青岚建设项目开展接口测试和交付资料核对。`+'核对设备配置、连接记录和测试结果，发现差异后记录在案，待负责人复核。'.repeat(10));
    stages.push('最终验收记录：交付检查完成，归档待复核。');
    await upload(cookies.admin,project.id,'阶段记录.txt',stages.join('\n'));
    truth.spectrometer=spec.id;truth.centrifuge=cent.id;
    const rows = [...parseCorpus('自然语言问法集.md'), ...(runBlind ? parseCorpus('heldout-盲测集.md') : []),...JSON.parse(readFileSync(path.join(HERE,'corpus','capability-cases.json'),'utf8')),...privateBlind];
    assert.ok(rows.length >= 9, '语料至少解析出 9 条问题');

    for (const row of rows) {
      await t.test(`${row.tag}: ${row.question}`, {timeout:150000}, async () => {
      const expected=row.expected ?? expectations.find(e=>e.question===row.question);
      assert.ok(expected,'每条问题必须记录范围、事实、证据和回答行为');
      const entry={id:expected.id,tag:row.tag,actor:row.actor,passed:false};report.push(entry);
      const startCalls = modelCalls;
      const res = await api('/agent/ask', cookies[row.actor], { question: row.question });
      assert.equal(res.status, 201, `ask 失败：${JSON.stringify(res)}`);
      const payload = res.data.reply.payload ?? {};
      const content = res.data.reply.content ?? '';
      console.log(JSON.stringify({event:'live.case',question:row.question,planner:plannerOutput,payload,content}));
      Object.assign(entry,{modelCalls:modelCalls-startCalls,planner:payload.plannerCall?.status,kind:payload.kind,evidence:payload.sources?.length??0,cited:payload.claims?.length??0,citationTrace:claimsTraceable(payload)?'ok':'BAD'});
      const refs=(payload.sources??[]).map(s=>s.archiveId);
      if(['answerable','compare','summary','reference','attachment','semantic','project','multi','open'].includes(row.tag)) {
        assert.equal(payload.kind,'content_answer','有真实资料的黄金问题必须完成基于证据的回答');
        if(['compare','summary','reference','attachment','project','multi'].includes(row.tag)) for(const key of expected.requiredSources) assert.ok(refs.includes(truth[key]),`缺少要求的来源 ${key}`);
        const evidenceText=JSON.stringify(payload.sources??[]);for(const fact of expected.keyFacts)assert.ok(evidenceText.includes(fact),`缺少关键原文事实 ${fact}`);
      }
      if(row.tag==='multi') {
        const reads=(payload.toolResults??[]).filter(r=>r.toolName==='content.read'&&r.status==='success');
        assert.ok(reads.some(r=>new Set(r.data.items.map(e=>e.fileId)).size>=2),'多附件必须分别完整读取');
        assert.equal(payload.answerGeneration.processedEvidenceCount,payload.evidenceSelection.after,'所有要求处理的批次必须完成');
        for(const read of reads)for(const file of read.data.indexStatuses)assert.equal(new Set(read.data.items.filter(e=>e.fileId===file.fileId).map(e=>e.chunkId)).size,file.chunkCount);
      }
      if(row.tag==='listing') {
        const ids=new Set([...(payload.items??[]).map(a=>a.id),...(payload.toolResults??[]).filter(r=>r.toolName==='archive.search').flatMap(r=>(r.data?.items??[]).map(a=>a.id))]);
        for(const key of expected.requiredSources) assert.ok(ids.has(truth[key]),`清单遗漏真实档案 ${key}`);
      }

      // —— 通用安全不变量（对任何标签都必须成立）——
      const sources = payload.sources ?? [];
      assert.ok(sources.every(isTraceableSource), `[${row.tag}] 存在不可追溯来源`);
      assert.ok(claimsTraceable(payload), `[${row.tag}] 存在无法回溯到真实来源的论断（citation 不可追溯）`);
      const blob = JSON.stringify(res.data);
      if (row.actor === 'borrower') {
        assert.ok(!blob.includes(SECRET_MARKER), `[permission] 越权泄漏：borrower 响应出现涉密标记`);
        assert.ok(!sources.some((s) => s.archiveId === truth.restrictedId), `[permission] borrower 证据指向无权档案`);
      }

      // —— 分标签机制判定 ——
      if (row.tag === 'answerable' || row.tag === 'compare' || row.tag === 'summary') {
        assert.equal(payload.plannerCall?.attempted, true, `[${row.tag}] 未调用 AI 规划`);
        if (row.tag === 'answerable') {
          assert.equal(payload.plannerCall?.status, 'success', `[${row.tag}] 真实模型规划未成功`);
          assert.equal(payload.kind, 'content_answer', `[${row.tag}] 有依据问题未进入 AI 综合作答：${payload.kind}`);
          assert.ok(sources.length >= 1 && sources[0].archiveId > 0, `[${row.tag}] 缺少可追溯的授权证据`);
        } else {
          // compare/summary：要么给出可追溯作答，要么如实证据不足，二者都不得编造（通用不变量已兜底）
          assert.equal(payload.kind, 'content_answer', `[${row.tag}] 已提供真实正文，应完成有依据的分析`);
          assert.ok(sources.length > 0);
        }
      } else if (row.tag === 'listing') {
        if (payload.inventory) {
          // 数字权威来源必须是数据库：正文里出现的总数须与 inventory.total 一致（模型只叙述不改写）
          assert.ok(content.includes(String(payload.inventory.total)), `[listing] 清单数字未与数据库 inventory 对齐`);
          assert.ok(sources.every(isTraceableSource));
        } else {
          assert.ok(typeof payload.total === 'number');
        }
      } else if (row.tag === 'nobasis') {
        assert.notEqual(payload.kind, 'content_answer', `[nobasis] 无依据问题被当作有据作答，疑似编造：${row.question}`);
        for (const marker of PROPRIETARY) assert.ok(!content.includes(marker), `[nobasis] 回答混入语料专有事实（张冠李戴幻觉）：${marker}`);
      } else if (row.tag === 'reference') {
        assert.equal(payload.plannerCall?.attempted, true, `[reference] 未调用 AI 规划`);
        // 参考对象与检索范围分离：作答/检索域不应为空证据报错之外的一致性由通用不变量兜底
        assert.ok(['content_answer', 'content_no_evidence', 'search'].includes(payload.kind), `[reference] 异常应答：${payload.kind}`);
      } else if (row.tag === 'permission') {
        assert.ok(!blob.includes(SECRET_MARKER), `[permission] 越权数据泄漏`);
      }

      entry.passed=true;
      });
    }

    console.log('\n— AI 能力（真实 DeepSeek）逐条机制报告 —');
    console.table(report);
    const total = report.length;
    const cited = report.filter((r) => r.tag !== 'nobasis' && r.tag !== 'permission').filter((r) => r.evidence > 0).length;
    const answerable = report.filter((r) => ['answerable', 'compare', 'summary', 'listing', 'reference'].includes(r.tag)).length;
    console.log(`citation 可追溯率：${report.filter((r) => r.citationTrace === 'ok').length}/${total}`);
    console.log(`有依据问题产生授权证据：${cited}/${answerable}；本轮通过 ${report.filter(r=>r.passed).length}/${report.length}，安全断言失败应查看各子测试，不能把未完成测试记为安全通过。`);
    console.log(`本轮真实模型调用总次数：${modelCalls}`);
  } finally {
    if (app) await app.close();
    if (db) db.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});
