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
  const start = source.indexOf('async generate(userMessage, context = {})');
  const end = source.indexOf('async backgroundChat(messages, options = {})');
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
  assert.match(source, /const genOptions = \{\s*...this\.getGenerationOptions\(resolvedPresetContext, config\),\s*...requestOverrides,\s*requestContext,\s*\};/);
  assert.match(source, /wireRequest: \{\s*url: sanitizeRequestPreviewUrl\(preparedRequest.url\),\s*body: preparedRequest.body,\s*parameterReport: preparedRequest.parameterReport/);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
