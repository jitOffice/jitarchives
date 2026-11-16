import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeterministic, extractSearchTerm, shouldUseModel, normalizeFollowUpQuestion, isReanswerRequest, normalizeAgentQuestion, extractArchiveTitleFromQuestion, extractAttachmentFileName, hasPreviousResultReference, sanitizeIntent } from '../dist/agent/intent.parser.js';

function parse(question) {
  return parseDeterministic({ question, categories: [] });
}

test('已归档状态查询应进入只读档案检索，不应误判为归档操作', () => {
  for (const question of [
    '我目前有哪些文档是已经归档了呢？',
    '我目前有哪些档案是已经归档了呢？',
    '列出所有已归档的档案',
    '查询已经归档的合同',
  ]) {
    const result = parse(question);
    assert.equal(result.intent.kind, 'search', question);
    assert.equal(result.intent.status, 'archived', question);
    assert.equal(result.strong, true, question);
    assert.equal(result.intent.keyword, undefined, '状态查询不应把“文档/档案”等对象词当成标题关键词');
  }
});

test('无关键词的档案列表问题应直接进入全量权限范围检索', () => {
  for (const question of [
    '我有哪些文件',
    '我有哪些档案',
    '那我有什么档案？',
    '那我有哪些文件？',
    '我目前有什么档案？',
    '帮我看看我的档案。',
    '我的档案有哪些？',
    '那么请问所以我目前有什么档案？',
    '我目前有哪些文档？',
    '列出所有档案',
    '查看全部文件',
    '我现在有什么资料呢？',
  ]) {
    const result = parse(question);
    assert.equal(result.intent.kind, 'search', question);
    assert.equal(result.strong, true, question);
    assert.equal(result.intent.keyword, undefined, '全量列表不能把对象词或“所有”当作关键词');
    assert.equal(result.intent.status, undefined, question);
  }
  const filtered = parse('查找合同文件');
  assert.equal(filtered.intent.kind, 'search');
  assert.equal(filtered.intent.keyword, '合同', '有明确主题的检索仍应保留主题词');
});

test('组合语气词不构成关键词，也不能使规则解析跳过 AI', () => {
  for (const question of ['那我', '所以我', '那么请问帮我', '我的', '那我所以我的', '那我呢？']) {
    assert.equal(extractSearchTerm(question), '', question);
    assert.equal(parse(question).strong, false, question);
    assert.equal(shouldUseModel(parse(question)), true, question);
    assert.equal(sanitizeIntent({ kind: 'search', keyword: question }, []), null, question);
  }
  for (const question of ['帮我找采购合同。', '那么请问帮我找采购合同。', '所以我想找采购合同']) {
    const result = parse(question);
    assert.equal(result.intent.kind, 'search', question);
    assert.equal(result.intent.keyword, '采购合同', question);
    assert.equal(result.strong, true, question);
  }
  for (const question of ['哪个附件提到了违约金？', '哪些附件提到了保密义务？']) {
    const result = parse(question);
    assert.equal(result.intent.kind, 'content_question');
    assert.equal(result.intent.title, undefined);
    assert.equal(result.intent.keyword, undefined);
    assert.equal(result.strong, true);
  }
  const missing = parse('档号 HT-2099-999999 不存在');
  assert.equal(missing.intent.archiveNo, 'HT-2099-999999');
  assert.equal(missing.intent.keyword, undefined);
  assert.equal(missing.strong, true);
  assert.equal(parse('所以我觉得还行').strong, false, '残余闲聊文本不能阻止 AI 意图判断');
});

test('重答请求与用户纠正表达应恢复真实问题，不得变成搜索关键词', () => {
  for (const question of ['重新回答', '再回答一次', '重新回答我的问题', '回答我刚刚的问题']) {
    assert.equal(isReanswerRequest(question), true, question);
  }
  assert.equal(normalizeFollowUpQuestion('我说重新回答我的问题，我有哪些文件'), '我有哪些文件');
  assert.equal(normalizeFollowUpQuestion('我说的是我有哪些档案'), '我有哪些档案');
  assert.equal(isReanswerRequest(normalizeFollowUpQuestion('我说重新回答我的问题，我有哪些文件')), false);
});

test('自然语言礼貌表达应剥离，不得污染档案/附件检索条件', () => {
  const raw = '你告诉我PPP里面的附件有哪些？';
  assert.equal(normalizeAgentQuestion(raw), 'PPP里面的附件有哪些');
  assert.equal(extractArchiveTitleFromQuestion(raw), 'PPP');

  const result = parse(raw);
  assert.equal(result.strong, true);
  assert.equal(result.intent.kind, 'unified_search');
  assert.deepEqual(result.intent.scopes, ['attachment']);
  assert.equal(result.intent.title, 'PPP');
  assert.equal(result.intent.attachmentMode, 'list');
  assert.equal(result.intent.keyword, undefined, '礼貌语、疑问词不能被拼进检索关键词');

  for (const variant of ['PPP的附件有哪些？', 'PPP合同有哪些附件？']) {
    const parsed = parse(variant);
    assert.equal(parsed.intent.kind, 'unified_search', variant);
    assert.deepEqual(parsed.intent.scopes, ['attachment'], variant);
    assert.ok(parsed.intent.title === 'PPP' || parsed.intent.title === 'PPP合同', variant);
  }
  const globalAttachments = parse('我有哪些附件？');
  assert.equal(globalAttachments.intent.kind, 'unified_search');
  assert.equal(globalAttachments.intent.title, undefined, '全局附件列表不能把“我”误识别为档案标题');
});

test('附件数量提问用“包含/包括/含”等动词时，应与“有”同义识别为附件清单并提取所属档案标题', () => {
  // 回归：此前「项目建设里面包含几份附件」因计数短语只认“有”，退化成整句关键词的档案元数据检索。
  for (const variant of [
    '项目建设里面包含几份附件？',
    '项目建设包含几份附件？',
    '项目建设里包含几份附件？',
    '项目建设包括多少附件？',
    '项目建设含几份附件？',
    '项目建设有几份附件？',
    '项目建设里面有几份附件？',
  ]) {
    const parsed = parse(variant);
    assert.equal(parsed.intent.kind, 'unified_search', variant);
    assert.deepEqual(parsed.intent.scopes, ['attachment'], variant);
    assert.equal(parsed.intent.attachmentMode, 'list', variant);
    assert.equal(parsed.intent.title, '项目建设', variant);
    assert.equal(parsed.intent.keyword, undefined, `${variant}：计数短语不能被拼成检索关键词`);
  }
  // “一共/分别”等修饰不得泄漏进档案标题。
  assert.equal(parse('财务合同一共有多少附件？').intent.title, '财务合同');
  // 回归：「项目建设这个档案里面有几个附件」中的指示词是给档案名做补语，不能污染标题。
  for (const variant of [
    '你告诉我项目建设这个档案里面有几个附件？',
    '项目建设这个档案里有几个附件？',
    '项目建设那份档案有多少附件？',
    '项目建设这个档案的附件有哪些？',
  ]) {
    const parsed = parse(variant);
    assert.equal(parsed.intent.attachmentMode, 'list', variant);
    assert.equal(parsed.intent.title, '项目建设', `${variant}：指示词不能被带进档案标题`);
    assert.equal(parsed.intent.keyword, undefined, variant);
  }
  // 纯指代（没有点名档案）时不得凭空产生标题，否则会话上下文引用会被误当成检索条件。
  for (const variant of ['这个档案有哪些附件？', '那份档案有多少附件？', '该档案有多少附件？']) {
    assert.equal(parse(variant).intent.title, undefined, variant);
  }
  // 明确按附件文件名筛选仍走 file_name，不被列表泛化误伤。
  const fileName = parse('项目建设附件名称包含验收报告');
  assert.equal(fileName.intent.attachmentMode, 'file_name');
  assert.equal(fileName.intent.attachmentFileName, '验收报告');
});

test('正文问题应提取档案标题并保留真实取证范围', () => {
  const result = parse('PPP合同主要讲了什么？');
  assert.equal(result.strong, true);
  assert.equal(result.intent.kind, 'content_question');
  assert.equal(result.intent.title, 'PPP合同');
  assert.equal(result.intent.archiveNo, undefined);
  for (const question of ['采购合同的违约金是多少？', '《采购合同》的违约金是多少？', '采购合同违约金是多少？', '采购合同的附件中的付款条件是什么？']) {
    assert.equal(parse(question).intent.title, '采购合同', question);
    assert.equal(parse(question).intent.kind, 'content_question', question);
  }
});

test('档案与附件联合检索应区分所属档案标题和附件文件名', () => {
  const result = parse('查找采购合同的档案和附件');
  assert.equal(result.strong, true);
  assert.equal(result.intent.kind, 'unified_search');
  assert.deepEqual(result.intent.scopes, ['archive', 'attachment']);
  assert.equal(result.intent.title, '采购合同');
  assert.equal(result.intent.keyword, undefined, '明确定位档案标题时不应把同一标题重复当附件文件名关键词');
});

test('档号加文件格式应解析为指定档案的附件检索', () => {
  const result = parse('找一下档号 WS-2026-000007 的 PDF');
  assert.equal(result.strong, true);
  assert.equal(result.intent.kind, 'unified_search');
  assert.deepEqual(result.intent.scopes, ['attachment']);
  assert.equal(result.intent.archiveNo, 'WS-2026-000007');
  assert.equal(result.intent.extension, 'pdf');
});

test('最近时间范围内的“谁修改档案”应识别为审计查询', () => {
  const result = parse('最近7天谁修改过档案？');
  assert.equal(result.strong, true);
  assert.equal(result.intent.kind, 'unified_search');
  assert.deepEqual(result.intent.scopes, ['audit']);
  assert.equal(result.intent.timeRange, '7d');
  assert.equal(result.intent.keyword, undefined);
});

test('附件名称筛选应独立提取 fileName，不与档案标题混淆', () => {
  const question = '附件名称包含验收报告的有哪些？';
  assert.equal(extractAttachmentFileName(question), '验收报告');
  const result = parse(question);
  assert.equal(result.strong, true);
  assert.equal(result.intent.kind, 'unified_search');
  assert.deepEqual(result.intent.scopes, ['attachment']);
  assert.equal(result.intent.attachmentMode, 'file_name');
  assert.equal(result.intent.attachmentFileName, '验收报告');
  assert.equal(result.intent.keyword, '验收报告');
});

test('连续追问可识别依赖上一轮结果的指代，但不猜测实体 ID', () => {
  for (const question of ['这些附件中哪个是验收报告？', '那这些档案里面呢？', '其中哪一份已经归档？']) {
    assert.equal(hasPreviousResultReference(question), true, question);
  }
  assert.equal(hasPreviousResultReference('系统目前有多少份档案？'), false);
});

test('模型意图清洗保留正文定位字段和附件专用条件', () => {
  const content = sanitizeIntent({ kind: 'content_question', title: 'PPP合同', archiveNo: 'WS-2026-000007' }, []);
  assert.equal(content.title, 'PPP合同');
  assert.equal(content.archiveNo, 'WS-2026-000007');

  const attachment = sanitizeIntent({
    kind: 'unified_search',
    scopes: ['attachment'],
    attachmentMode: 'file_name',
    attachmentFileName: '验收报告',
  }, []);
  assert.equal(attachment.attachmentFileName, '验收报告');
  assert.equal(attachment.keyword, '验收报告');
  assert.equal(attachment.attachmentMode, 'file_name');
});

test('明确要求执行归档/删除/审批时仍然拦截', () => {
  for (const question of [
    '帮我把这份档案归档',
    '请执行档案归档',
    '请你帮我把这份档案归档',
    '我想把档案归档',
    '归档这份档案',
    '帮我删除这份档案',
    '请帮我审批这份借阅申请',
  ]) {
    assert.equal(parse(question).intent.kind, 'unsupported', question);
  }
});

test('查询审批或删除记录不应被当成执行写操作', () => {
  for (const question of [
    '查询审批记录',
    '查看删除记录',
  ]) {
    assert.notEqual(parse(question).intent.kind, 'unsupported', question);
  }
});
