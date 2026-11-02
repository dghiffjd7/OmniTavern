import assert from 'node:assert/strict';

import { getVisionInputCapability } from '../../src/scripts/api/vision-capabilities.js';

{
  const gemini = getVisionInputCapability({ provider: 'gemini', model: 'gemini-2.0-flash' });
  assert.equal(gemini.supported, true);
  assert.equal(gemini.status, 'supported');

  const openai = getVisionInputCapability({ provider: 'openai', model: 'gpt-4o-mini' });
  assert.equal(openai.supported, true);

  const deepseek = getVisionInputCapability({ provider: 'deepseek', model: 'deepseek-chat' });
  assert.equal(deepseek.supported, false);
  assert.equal(deepseek.status, 'unsupported');

  const custom = getVisionInputCapability({ provider: 'custom', model: 'my-model' });
  assert.equal(custom.supported, true);
  assert.equal(custom.status, 'unknown');
  console.log('ok - vision capability helper gates known text-only models and allows unknown custom configs');
}

{
  // Claude 3 起都能看图；名字是 claude-<型号>-<版本>（如 claude-sonnet-4-5）时也要认得，只有 Claude 2／Instant 不行
  for (const model of ['claude-3-5-sonnet-20241022', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'claude-opus-5-5', 'claude-fable-5-1', 'Claude-Haiku-5-5']) {
    const result = getVisionInputCapability({ provider: 'anthropic', model });
    assert.equal(result.supported, true, model);
  }
  for (const model of ['claude-2.1', 'claude-2', 'claude-instant-1.2']) {
    assert.equal(getVisionInputCapability({ provider: 'anthropic', model }).supported, false, model);
  }
  console.log('ok - current Claude model names are recognised as accepting images');
}
