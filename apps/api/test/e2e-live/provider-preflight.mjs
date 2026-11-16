import test from 'node:test';
import assert from 'node:assert/strict';
import {RealAiModelClient} from '../../dist/agent/ai-model.client.js';
import {HttpEmbeddingClient, validVector} from '../../dist/knowledge/embedding.client.js';

test('real DeepSeek network preflight', {timeout:65000}, async () => {
  const model = new RealAiModelClient();
  assert.ok(model.available, '真实 DeepSeek 配置缺失');
  assert.equal(model.provider,'deepseek');
  const response = await model.chatCompletion([{role:'user',content:'请仅回复 OK'}], {maxTokens:16,timeoutMs:45000});
  assert.ok(response.content.trim());
  assert.equal(response.truncated,false);
});
test('real Embedding network preflight (required for joint acceptance)', {timeout:65000}, async () => {
  const embedding = new HttpEmbeddingClient();
  assert.ok(embedding.available, 'JIT_EMBEDDING_API_BASE / MODEL / API_KEY 缺失或无效；联合验收阻塞');
  const vectors = await embedding.embed(['设备交付完成后的资金结算期限','验收后四十五日支付尾款']);
  assert.equal(vectors.length,2); assert.ok(vectors.every(validVector));
  assert.equal(vectors[0].length,vectors[1].length);
});
