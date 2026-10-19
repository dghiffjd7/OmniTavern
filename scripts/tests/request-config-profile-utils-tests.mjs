import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  normalizeRequestConfigUiMode,
  resolveRequestConfigProfileId,
} from '../../src/scripts/ui/chat/request-config-profile-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const makePresetStore = ({
  sessions = {},
  modes = {},
} = {}) => ({
  getSessionProfileId(type, sessionId) {
    assert.equal(type, 'openai');
    return sessions[sessionId] || '';
  },
  getModeProfileId(type, mode) {
    assert.equal(type, 'openai');
    return modes[mode] || '';
  },
});

test('normalizes creative writing aliases to rp', () => {
  assert.equal(normalizeRequestConfigUiMode('creative'), 'rp');
  assert.equal(normalizeRequestConfigUiMode('', { sessionId: 'rp:abc' }), 'rp');
  assert.equal(normalizeRequestConfigUiMode('dynamic'), 'moments');
  assert.equal(normalizeRequestConfigUiMode('', { taskType: 'moment_comment' }), 'moments');
});

test('session profile overrides mode default profile', () => {
  const store = makePresetStore({
    sessions: { 'rp:1': 'session-claude' },
    modes: { rp: 'mode-gemini' },
  });
  assert.deepEqual(resolveRequestConfigProfileId({
    presetStore: store,
    sessionId: 'rp:1',
    uiMode: 'creative',
  }), {
    profileId: 'session-claude',
    source: 'session',
    sessionId: 'rp:1',
    uiMode: 'rp',
  });
});

test('mode profile is used when session has no explicit profile', () => {
  const store = makePresetStore({
    modes: { rp: 'mode-claude', chat: 'mode-gemini' },
  });
  assert.deepEqual(resolveRequestConfigProfileId({
    presetStore: store,
    sessionId: 'rp:2',
    uiMode: '',
  }), {
    profileId: 'mode-claude',
    source: 'mode',
    sessionId: 'rp:2',
    uiMode: 'rp',
  });
});

test('falls back to global profile when no binding exists', () => {
  assert.deepEqual(resolveRequestConfigProfileId({
    presetStore: makePresetStore(),
    sessionId: 'chat:1',
    uiMode: 'chat',
  }), {
    profileId: '',
    source: 'global',
    sessionId: 'chat:1',
    uiMode: 'chat',
  });
});

test('generation resolves request config before building provider messages', async () => {
  const bridgePath = fileURLToPath(new URL('../../src/scripts/ui/bridge.js', import.meta.url));
  const source = await readFile(bridgePath, 'utf8');
  const start = source.search(/^  async generate\(/m);
  const end = source.search(/^  async backgroundChat\(/m);
  assert.ok(start >= 0 && end > start, 'bridge generate body should be discoverable');
  const body = source.slice(start, end);
  const resolveIndex = body.indexOf('const requestRuntime = await this.resolveRequestRuntimeConfig(presetContext);');
  const buildIndex = body.indexOf('let messages = this.buildMessages(promptInput, nextContext, {');
  assert.ok(resolveIndex >= 0, 'generate should resolve request runtime config');
  assert.ok(buildIndex >= 0, 'generate should pass request config into buildMessages');
  assert.ok(resolveIndex < buildIndex, 'request config must be resolved before buildMessages');
  assert.match(
    body,
    /this\.buildMessages\(promptInput, nextContext,\s*\{\s*requestConfig: config,\s*deferPhoneTransportLayers,\s*transportAnchorNamespace: nativeRequestId,\s*\}\s*\)/,
  );
  assert.match(source, /buildMessages\(userMessage, context = \{\}, options = \{\}\)/);
});

test('bridge preserves options until the provider applies profile rules to its final body', async () => {
  const source = await readFile(fileURLToPath(new URL('../../src/scripts/ui/bridge.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /applyGenerationParamFilter/);
  assert.match(source, /const withRuntimeParamConstraints = options =>/);
  assert.match(source, /protectedParams:[\s\S]*?'tools', 'tool_choice', 'toolConfig', 'include', 'max_tool_calls'/);
  assert.match(source, /const genOptions = \{\s*...mergeBackgroundGenerationOptions\(this\.getGenerationOptions\(resolvedPresetContext, config, \{ reasoningOff: reasoningMode === 'off' \}\), requestOverrides\),\s*requestContext,\s*\};/);
  assert.match(source, /wireRequest: \{\s*url: sanitizeRequestPreviewUrl\(preparedRequest.url\),\s*body: preparedRequest.body,\s*parameterReport: preparedRequest.parameterReport/);
});

test('agent task preset: an explicit presetId picks generation params without session reasoning overrides', async () => {
  const source = await readFile(fileURLToPath(new URL('../../src/scripts/ui/bridge.js', import.meta.url)), 'utf8');
  const start = source.search(/^  getGenerationOptions\(/m);
  const body = source.slice(start, start + 2400);
  assert.match(body, /const explicitPreset = explicitPresetId \? this\.presets\?\.getPreset\?\.\('openai', explicitPresetId\) : null;/);
  assert.match(body, /if \(!explicitPreset\) \{\s*const state = this\.presets\?\.getSelectionState\?\.\(\);\s*if \(!state\?\.enabled\?\.openai\) return withoutPreset\(\);\s*\}/);
  assert.match(body, /const overrideReasoning = explicitPreset \? null : \(sessionReasoning \|\| modeReasoning\);/);
  // 模型档不受 presetId 影响：只按会话／模式／任务类型解析
  const resolver = source.slice(source.search(/^  async resolveRequestRuntimeConfig\(/m)).slice(0, 600);
  assert.doesNotMatch(resolver, /presetId/);
});

test('background tasks can ask for no reasoning: preset reasoning is ignored and providers get an explicit off switch', async () => {
  const source = await readFile(fileURLToPath(new URL('../../src/scripts/ui/bridge.js', import.meta.url)), 'utf8');
  const background = source.slice(source.search(/^  async backgroundChat\(/m)).slice(0, 2400);
  assert.match(background, /const \{ presetContext = null, runtimeConfigOverride = null, previewOnly = false, reasoningMode = '', \.\.\.requestOverrides \} = options \|\| \{\};/);
  const start = source.search(/^  getGenerationOptions\(/m);
  const body = source.slice(start, start + 3200);
  assert.match(body, /^  getGenerationOptions\(presetContext = \{\}, runtimeConfigOverride = null, \{ reasoningOff = false \} = \{\}\) \{/);
  // 没套预设（预设停用或找不到）时也要明确关闭：DeepSeek 不送参数时默认会思考
  assert.match(body, /const withoutPreset = \(\) => \(reasoningOff \? buildReasoningRequestOptions\(\{ provider: runtimeConfig\?\.provider, model: runtimeConfig\?\.model, baseUrl: runtimeConfig\?\.baseUrl, requestReasoning: false \}\) : \{\}\);/);
  assert.match(body, /if \(!p \|\| typeof p !== 'object'\) return withoutPreset\(\);/);
  // 推理关掉后采样规则也按不推理算，预设温度得以保留
  assert.match(body, /const effectiveRequestReasoning = reasoningOff\s*\? false\s*: overrideReasoning/);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
