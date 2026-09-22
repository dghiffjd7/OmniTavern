import assert from 'node:assert/strict';
import { DeepseekProvider } from '../../src/scripts/api/providers/deepseek.js';
import { buildReasoningRequestOptions } from '../../src/scripts/api/model-capabilities.js';

const provider = new DeepseekProvider({
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiKey: 'test-key',
  baseUrl: 'https://api.deepseek.com/v1',
});

{
  assert.deepEqual(
    buildReasoningRequestOptions({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      requestReasoning: false,
    }),
    { thinking: { type: 'disabled' } },
  );
  console.log('ok - official DeepSeek reasoning-off emits the explicit V4 disable control');

  assert.deepEqual(
    buildReasoningRequestOptions({
      provider: 'custom',
      model: 'deepseek-v4-flash',
      requestReasoning: false,
    }),
    {},
  );
  console.log('ok - custom DeepSeek-compatible endpoints keep omission-based compatibility when reasoning is off');
}

{
  const options = provider.normalizeOptions({
    thinking: { type: 'disabled' },
    tools: [{ type: 'function', function: { name: 'test_tool', parameters: { type: 'object' } } }],
    tool_choice: 'required',
  });
  assert.deepEqual(options.thinking, { type: 'disabled' });
  assert.equal(options.tool_choice, 'required');
  console.log('ok - DeepSeek non-thinking requests preserve the explicit disabled toggle');
}

{
  const options = provider.normalizeOptions({
    thinking: { type: 'enabled' },
    tools: [{ type: 'function', function: { name: 'test_tool', parameters: { type: 'object' } } }],
  });
  assert.deepEqual(options.thinking, { type: 'enabled' });
  assert.equal(Object.hasOwn(options, 'tool_choice'), false);
  console.log('ok - DeepSeek thinking requests can rely on implicit auto tool choice');
}

{
  assert.deepEqual(provider.normalizeOptions({
    response_format: { type: 'json_object' },
  }).response_format, { type: 'json_object' });
  assert.deepEqual(provider.normalizeOptions({
    responseFormat: 'json_object',
  }).response_format, { type: 'json_object' });
  console.log('ok - DeepSeek chat requests preserve documented JSON Output response_format');
}

{
  const previousWindow = globalThis.window, previousCustomEvent = globalThis.CustomEvent, previousInfo = console.info;
  const logs = [];
  try {
    globalThis.window = { dispatchEvent: event => logs.push(event.detail?.message || '') };
    globalThis.CustomEvent = class { constructor(type, options) { this.type = type; this.detail = options.detail; } };
    console.info = () => {};
    const reasoning = 'upstream reasoning without final text';
    provider.request = async () => ({ ok: true, status: 200, body: JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: reasoning } }], usage: { completion_tokens: 96 } }) });
    assert.equal(await provider.chat([{ role: 'user', content: 'fixture' }], { maxTokens: 96 }), '', 'reasoning must never become the visible answer');
    const diagnostic = logs.find(log => log.includes('finish_reason=length'));
    assert.ok(diagnostic?.includes(`reasoning_chars=${reasoning.length}`), 'non-streaming diagnostics count actual upstream reasoning');
    assert.ok(diagnostic.includes('output_chars=0'));
    assert.equal(diagnostic.includes(reasoning), false, 'diagnostics include counts, not response content');
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent; else globalThis.CustomEvent = previousCustomEvent;
    console.info = previousInfo;
  }
  console.log('ok - non-streaming DeepSeek diagnostics distinguish reasoning from visible text');
}
