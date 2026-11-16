/**
 * 第三阶段专项：图谱上下文规划夹具。
 * 触发条件只有一个——后端注入的 context.graphNote（resolveGraphContext 复核产物），
 * 完全不读取用户问句措辞：以此证明「图谱联动检索」由服务端已验证上下文驱动，
 * 不是按固定问题/关键词/正则逐题编写的答案逻辑。真实行数据、权限与引用仍来自 SQLite。
 */
import { emptyRetrievalPlan } from '../../dist/agent/retrieval.plan.js';
import { readPlannerFixture } from './read-planner-fixture.mjs';

function buildGraphPlan(question, kind, note) {
  const p = emptyRetrievalPlan(question);
  p.allowExpansion = false;
  p.responseMode = kind === 'archive' ? 'summary' : 'content_qa';
  p.searchSources = ['archive', 'metadata', 'content'];
  const add = (id, tool, args, expects, extra = {}) => p.planSteps.push({ id, tool, args, expects, intent: id, ...extra });
  // 从档案节点定位（标题只取后端已复核 note 里的真实题名，作为「线索键」入参，数值 ID 仍由后端注入）
  const titled = /档案《([^》]+)》/.exec(note)?.[1];
  if (kind === 'archive') {
    add('locate', 'archive.search', { title: titled }, 'metadata');
    add('graph', 'graph.relations', {}, 'metadata', { scope: 'step:locate' });
    // 即使模型误把关联档案规划为全文读取，服务端也应默认降为相关片段检索；主档案仍完整读取。
    add('relatedBody', 'content.read', {}, 'fullText', { scope: 'step:graph' });
    add('selfBody', 'content.read', {}, 'fullText', { scope: 'step:locate' });
  } else if (kind === 'edge') {
    // 边场景两端档案已由后端复核并钉入槽位；按槽位定位，避免对 note 做脆弱解析
    add('locate', 'archive.search', {}, 'metadata', { contextRef: { entity: 'archive', slot: 'all' } });
    add('graph', 'graph.relations', {}, 'metadata', { scope: 'step:locate' });
    add('body', 'content.search', { query: '移植付款条款' }, 'relevantText', { scope: 'step:graph' });
    // 关系解释需要两端各自的正文证据：目标档案不在 graph 返回的关联集里，补一个按定位步骤取证的动作
    add('bodyLocate', 'content.search', { query: '移植付款条款' }, 'relevantText', { scope: 'step:locate' });
  } else if (kind === 'file') {
    add('body', 'content.read', {}, 'fullText', { contextRef: { entity: 'attachment', slot: 1 } });
  } else if (kind === 'chunk') {
    add('body', 'content.search', { query: '移植养护标准' }, 'relevantText', { contextRef: { entity: 'archive', slot: 1 } });
  } else if (kind === 'isolated') {
    add('locate', 'archive.search', { title: titled }, 'metadata');
    add('graph', 'graph.relations', {}, 'metadata', { scope: 'step:locate' });
    add('body', 'content.search', { query: '会议纪要归档范围' }, 'relevantText', { scope: 'step:graph' });
  } else {
    // unknownGraphKind：规划器在图谱上下文存在时必须给出含 graph.relations 的计划
    add('locate', 'archive.search', { title: titled }, 'metadata');
    add('graph', 'graph.relations', {}, 'metadata', { scope: 'step:locate' });
  }
  return p;
}

export function graphPlannerFixture(messages) {
  const system = messages[0]?.content ?? '';
  if (system.startsWith('EVIDENCE_SUFFICIENCY_V1')) {
    return { content: '{"verdict":"sufficient","note":"读取测试按实际工具结果核对","supplement":[]}', truncated: false };
  }
  if (!system.startsWith('RETRIEVAL_PLAN_V1')) return null;
  const { question, context = {} } = JSON.parse(messages[1].content);
  const note = typeof context.graphNote === 'string' ? context.graphNote : null;
  if (note === null) return readPlannerFixture(messages);
  const kind = note.startsWith('图谱选中关系') ? 'edge'
    : note.startsWith('图谱选中节点') && note.includes('附件《')
      ? (note.includes('正文知识块') ? 'chunk' : 'file')
        : note.startsWith('图谱选中节点') && note.includes('档案《') ? 'archive' : 'unknown';
  const { originalQuestion, normalizedQuestion, ...wire } = buildGraphPlan(question, kind, note);
  return { content: JSON.stringify(wire), truncated: false };
}
