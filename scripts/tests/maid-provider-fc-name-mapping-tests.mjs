import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMaidProviderFcToolPlan,
  normalizeMaidProviderFcCompletedCalls,
  runMaidProviderFcAttempt,
} from '../../src/scripts/agent/maid-provider-fc-planner.js';
import { createContactProfileAgentTools } from '../../src/scripts/agent/tools/contact-profile-tools.js';
import { createMaidModelBackedPlanner, createMaidModelBackedReActPlanner } from '../../src/scripts/agent/maid-model-planner.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';

const declarations = createContactProfileAgentTools();
const featureFor = (names = ['contact_profile.list', 'contact_profile.get']) => ({
  id: 'contact_profile.read', title: 'Read contact profiles', tools: names,
  toolSchemas: Object.fromEntries(names.map(name => [name, declarations.find(tool => tool.name === name).schema])),
});
const snapshotFor = feature => ({ id: 'contact-alias-regression', useCandidates: true, candidateFeatures: [feature], promptFeatures: [feature] });
const configs = {
  gemini: { provider: 'makersuite', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  deepseek: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' },
};
const emit = (kind, options, name, args) => {
  const config = configs[kind];
  const data = kind === 'gemini'
    ? { candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] }
    : { output: [{ type: 'function_call', id: `item-${name}`, call_id: `call-${name}`, name, arguments: JSON.stringify(args) }] };
  options.onProviderToolCallDelta(data, { provider: config.provider, model: config.model });
};
const attempt = async (kind, name, args, feature = featureFor()) => {
  const usages = [];
  const result = await runMaidProviderFcAttempt({
    config: configs[kind], capabilitySnapshot: snapshotFor(feature), experimentStatus: { enabled: true },
    messages: [{ role: 'user', content: 'Read the contact profile.' }],
    onModelUsage: usage => usages.push(usage),
    client: { async chat(_messages, options) { emit(kind, options, name, args); return ''; } },
  });
  return { result, usages };
};

for (const kind of ['gemini', 'deepseek']) test(`${kind}: actual delta accumulator preserves offered profile list/get mappings`, async () => {
  for (const [name, internalName, args] of [
    ['contact_profile_list', 'contact_profile.list', {}],
    ['contact_profile_get', 'contact_profile.get', { contactId: 'contact-test' }],
  ]) {
    const { result, usages } = await attempt(kind, name, args);
    assert.equal(result.ok, true, `${name}: ${result.reason}`);
    assert.equal(result.selection.toolName, internalName);
    assert.deepEqual(result.selection.args, args);
    assert.deepEqual(usages.map(usage => usage.outcome), ['ok']);
  }
});

test('normalized aliases cannot select a contact tool outside this offered plan', async () => {
  const { result } = await attempt('deepseek', 'contact_profile_get', { contactId: 'contact-test' }, featureFor(['contact_profile.list']));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown_tool');
  assert.equal(result.selection, undefined);
});

test('internal-name resolution still validates the offered tool schema', async () => {
  for (const [name, args] of [['contact_profile_list', { limit: 'all' }], ['contact_profile_get', { name: 'test' }]]) {
    const { result } = await attempt('gemini', name, args);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_tool_arguments');
    assert.equal(result.selection, undefined);
  }
});

test('ambiguous internal names and provider/internal collisions fail closed', () => {
  const original = buildMaidProviderFcToolPlan({ config: configs.deepseek, features: [featureFor()] });
  const mapping = original.toolMappings.find(item => item.internalName === 'contact_profile.list');
  for (const conflicting of [
    { ...mapping, providerName: 'another_profile_list' },
    { ...mapping, providerName: 'contact_profile.list', internalName: 'other.list' },
  ]) {
    const result = normalizeMaidProviderFcCompletedCalls({
      toolPlan: { ...original, toolMappings: [...original.toolMappings, conflicting] },
      completedToolCalls: [{ toolName: 'contact_profile.list', arguments: {} }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ambiguous_tool');
    assert.equal(result.selection, undefined);
  }
});

test('real planner/agent chain completes a profile read without JSON fallback or repeated calls', async () => {
  const feature = featureFor(['contact_profile.list']);
  const calls = [], executed = [], decisions = [];
  const client = { async chat(_messages, options) {
    const native = Boolean(options.tools?.length);
    calls.push(native ? 'provider_fc' : 'prompted_json');
    if (!native) return JSON.stringify({ ok: false, reason: 'unexpected_alias_fallback' });
    emit('deepseek', options, executed.length ? 'maid_planner_control' : 'contact_profile_list', executed.length
      ? { action: 'final', message: 'No saved profiles.' } : {});
    return '';
  } };
  const dependencies = { features: [feature], resolveRuntimeConfig: async () => ({ config: configs.deepseek, client }),
    getProviderFcExperimentStatus: () => ({ enabled: true }), logger: { warn() {}, debug() {} } };
  const observe = fn => async (...args) => { const value = await fn(...args); decisions.push(value); return value; };
  const agent = createMaidAssistantAgent({
    planner: observe(createMaidModelBackedPlanner(dependencies)),
    reactPlanner: observe(createMaidModelBackedReActPlanner(dependencies)), maxReactSteps: 3,
    toolRegistry: { async executeTool(toolName, args) {
      executed.push({ toolName, args });
      return { toolName, status: 'succeeded', result: { count: 0, profiles: [] } };
    } }, logger: { warn() {}, debug() {} },
  });
  const result = await agent.runPrompt('List the saved contact profiles.', { capabilitySnapshot: snapshotFor(feature), sessionId: 'alias-test', uiMode: 'chat' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['provider_fc', 'provider_fc']);
  assert.deepEqual(executed, [{ toolName: 'contact_profile.list', args: {} }]);
  assert(decisions.every(decision => decision.plannerTransport.effectiveMode === 'provider_fc' && !decision.plannerTransport.fallbackReason));
});
