import assert from 'node:assert/strict';

import { canInitClient, mergeBackgroundGenerationOptions } from '../../src/scripts/api/client-config-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('background options: caller camel maxTokens replaces the preset token limit', () => {
  // OpenAI 类接口按 max_completion_tokens > max_tokens > maxTokens 取值；房子只传 maxTokens 时曾被预设 30000 盖掉。
  const merged = mergeBackgroundGenerationOptions(
    { temperature: 1, max_tokens: 30000, max_completion_tokens: 30000 },
    { maxTokens: 500, tools: [] },
  );
  assert.equal(merged.maxTokens, 500);
  assert.equal('max_tokens' in merged, false);
  assert.equal('max_completion_tokens' in merged, false);
  assert.equal(merged.temperature, 1);
  assert.deepEqual(merged.tools, []);
});

test('background options: explicit snake token limits from the caller are kept', () => {
  assert.deepEqual(
    mergeBackgroundGenerationOptions({ max_tokens: 30000 }, { maxTokens: 2000, max_tokens: 2000 }),
    { max_tokens: 2000, maxTokens: 2000 },
  );
  assert.deepEqual(
    mergeBackgroundGenerationOptions({ max_tokens: 30000 }, { max_completion_tokens: 900 }),
    { max_tokens: 30000, max_completion_tokens: 900 },
  );
});

test('background options: without a caller limit the preset limit stays', () => {
  assert.deepEqual(mergeBackgroundGenerationOptions({ max_tokens: 30000, top_p: 0.9 }, { temperature: 0.2 }),
    { max_tokens: 30000, top_p: 0.9, temperature: 0.2 });
  assert.deepEqual(mergeBackgroundGenerationOptions({ maxTokens: 8000 }, { maxTokens: undefined }), { maxTokens: undefined });
  assert.deepEqual(mergeBackgroundGenerationOptions(null, null), {});
});

test('canInitClient accepts non-empty api keys', () => {
  assert.equal(canInitClient({ apiKey: 'sk-test' }), true);
  assert.equal(canInitClient({ apiKey: '   ' }), false);
});

test('canInitClient accepts vertex ai service account without api key', () => {
  assert.equal(
    canInitClient({
      provider: 'vertexai',
      vertexaiServiceAccount: '{"client_email":"demo@example.com"}',
    }),
    true,
  );
  assert.equal(
    canInitClient({
      provider: 'openai',
      vertexaiServiceAccount: '{"client_email":"demo@example.com"}',
    }),
    false,
  );
});

test('canInitClient follows the selected vertex authentication mode', () => {
  assert.equal(canInitClient({
    provider: 'vertexai',
    vertexaiAuthMode: 'express',
    apiKey: 'vertex-express-key',
  }), true);
  assert.equal(canInitClient({
    provider: 'vertexai',
    vertexaiAuthMode: 'express',
    vertexaiServiceAccount: '{"project_id":"demo"}',
  }), false);
  assert.equal(canInitClient({
    provider: 'vertexai',
    vertexaiAuthMode: 'service_account',
    apiKey: 'unrelated-key',
  }), false);
  assert.equal(canInitClient({
    provider: 'vertexai',
    vertexaiAuthMode: 'service_account',
    vertexaiServiceAccount: '{"project_id":"demo"}',
  }), true);
});

test('canInitClient lets keyless local image providers run with only a URL', () => {
  // 配置面板对这些渠道标「可不填 API Key」，生图前的检查也要一致，否则本地 ComfyUI 只能乱填 Key。
  for (const provider of ['comfyui', 'comfy', 'automatic1111', 'a1111', 'pollinations']) {
    assert.equal(canInitClient({ provider, baseUrl: 'http://127.0.0.1:8188', apiKey: '' }), true, provider);
    assert.equal(canInitClient({ provider, baseUrl: '  ', apiKey: '' }), false, `${provider} without url`);
  }
  assert.equal(canInitClient({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '' }), false);
});

test('canInitClient rejects empty configs', () => {
  assert.equal(canInitClient(null), false);
  assert.equal(canInitClient({}), false);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) process.exit(1);
