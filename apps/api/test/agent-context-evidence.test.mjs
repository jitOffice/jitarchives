import test from 'node:test';
import assert from 'node:assert/strict';
import { RealAiModelClient } from '../dist/agent/ai-model.client.js';
import { AI_PROVIDER_DEFINITIONS } from '../dist/agent/ai-settings.service.js';
import { parseReference } from '../dist/agent/agent.context.js';
import { buildEvidence, verifyCitations } from '../dist/agent/content.evidence.js';
import { AgentToolRegistry } from '../dist/agent/tool.registry.js';

test('所要求的指代、省略和序号均被识别', () => {
  for (const q of ['这些附件', '那些档案', '其中哪一份', '刚才那份', '上面提到的合同', '它的正文', '这个档案', '第二份附件']) assert.ok(parseReference(q), q);
  assert.equal(parseReference('第二份附件').ordinal, 2);
  assert.equal(parseReference('其中哪个是验收报告？').name, '验收报告');
  assert.equal(parseReference('PPP里面有哪些附件？'), null);
});
test('引用编号混合伪造、漏标、生成链接和未出现数值均不能通过', () => {
  const evidence = buildEvidence([{ chunkId: 1, text: '验收后7天付款', fileId: 2, archiveId: 3 }]);
  assert.equal(verifyCitations('验收后7天付款 [E1]。', evidence).valid, true);
  for (const answer of ['真实 [E1]。伪造 [E99]。', '真实 [E1]。无引用的事实。', '真实 [E1]。https://evil.test', '验收后99天付款 [E1]。', '无需付款 [E1]。']) assert.equal(verifyCitations(answer, evidence).valid, false, answer);
});
test('三家服务商复用单一适配器，兼容字符串及文本块，忽略推理字段', async () => {
  for (const provider of AI_PROVIDER_DEFINITIONS) {
    for (const content of ['真实回答', [{ type: 'text', text: '真实回答' }]]) {
      const calls = [];
      const client = new RealAiModelClient(async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: '不能使用的推理' }, finish_reason: 'stop' }] }));
      }, () => ({ apiBase: provider.defaultApiBase, model: provider.defaultModel, apiKey: 'mock-key', temperature: 0, timeoutMs: 100 }));
      const result = await client.chatCompletion([{ role: 'user', content: '问题' }]);
      assert.equal(result.content, '真实回答');
      assert.equal(calls[0].url, `${provider.defaultApiBase}/chat/completions`);
      assert.equal(calls[0].body.model, provider.defaultModel);
    }
  }
});
test('模型无正文、非法响应和网络失败都明确报错；响应体读取也受超时约束', async () => {
  const config = () => ({ apiBase: 'https://mock.test', model: 'mock', apiKey: 'mock-key', temperature: 0, timeoutMs: 20 });
  for (const body of ['invalid', JSON.stringify({ choices: [{ message: { reasoning_content: '只有推理' } }] }), JSON.stringify({ choices: [] })]) {
    await assert.rejects(new RealAiModelClient(async () => new Response(body), config).chatCompletion([]));
  }
  await assert.rejects(new RealAiModelClient(async () => { throw Error('network'); }, config).chatCompletion([]), /网络错误/u);
  const slow = new RealAiModelClient(async (_url, { signal }) => ({ text: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('abort'), { name: 'AbortError' })), { once: true });
  }) }), config);
  await assert.rejects(slow.chatCompletion([]), /请求超时/u);
});
test('正文 fileIds 必须属于已重新校验的档案，不能注入其他档案附件', async () => {
  const access = { assertView() {}, loadArchive: id => ({ id }) };
  const r = new AgentToolRegistry({ getArchiveDetail: () => ({ files: [{ id: 8 }] }) }, access, {}, {}, {}, {}, {});
  const user = { id: 1, role: 'borrower', status: 'active' };
  const result = await r.execute('content.read', { archiveIds: [3], fileIds: [99], summary: true }, user);
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, '400');
  assert.equal((await r.execute('content.read', { fileIds: [8] }, user)).error.code, '400');
});
