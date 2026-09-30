import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMaidProviderFcToolPlan, normalizeMaidProviderFcCompletedCalls, runMaidProviderFcAttempt } from '../../src/scripts/agent/maid-provider-fc-planner.js';

// Captured failure shape: a write feature exposes its prerequisite list tool
// before the list capability. Keep the fixture independent of catalog cleanup.
const readSchema = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } };
const providers = {
  gemini: { provider: 'makersuite', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  deepseek: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' },
};
const featurePair = toolName => {
  const writeId = toolName === 'session.list' ? 'session.create' : 'worldbook.bind_persona';
  const read = { id: toolName, title: `Read ${toolName}`, summary: 'Read saved resource summaries.', argsHint: 'limit is optional.', writes: false, tools: [toolName], toolSchemas: { [toolName]: readSchema } };
  const write = { id: writeId, title: `Write ${writeId}`, summary: 'Create or bind a resource.', argsHint: 'Supply the write target.', writes: true, tools: [writeId, toolName], toolSchemas: { [toolName]: readSchema, [writeId]: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false } } };
  return { write, read };
};
const declarations = options => {
  const result = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.name === 'string' && typeof value.description === 'string') result.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
  };
  walk(options.tools);
  return result;
};

for (const [provider, config] of Object.entries(providers)) test(`${provider}: actual FC declaration and delta choose the offered read owner in either order`, async () => {
  for (const toolName of ['session.list', 'worldbook.list']) {
    const { write, read } = featurePair(toolName);
    for (const features of [[write, read], [read, write]]) {
      let offered;
      const result = await runMaidProviderFcAttempt({
        config, capabilitySnapshot: { id: 'shared-list-owner', useCandidates: true, candidateFeatures: features },
        experimentStatus: { enabled: true }, messages: [{ role: 'user', content: 'Read the list.' }],
        client: { async chat(_messages, options) {
          offered = declarations(options).find(tool => tool.name === toolName.replaceAll('.', '_'));
          const name = toolName.replaceAll('.', '_'), args = { limit: 20 };
          const delta = provider === 'gemini'
            ? { candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] }
            : { output: [{ type: 'function_call', id: 'read-owner-item', call_id: 'read-owner-call', name, arguments: JSON.stringify(args) }] };
          options.onProviderToolCallDelta(delta, { provider: config.provider, model: config.model });
          return '';
        } },
      });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.selection.featureId, read.id, 'candidate registration order must not turn a list into a write capability');
      assert.equal(result.selection.title, read.title);
      assert.ok(offered.description.includes(`APP capability: ${read.id};`));
      assert.ok(!offered.description.includes(write.summary));
      assert.deepEqual(result.selection.args, { limit: 20 });
    }
  }
});

test('offered read-only owner wins over a write feature even when its id differs from tool name', () => {
  const { write, read } = featurePair('session.list');
  const alias = { ...read, id: 'session.inventory' };
  const plan = buildMaidProviderFcToolPlan({ config: providers.deepseek, features: [write, alias] });
  assert.equal(plan.toolMappings.find(tool => tool.internalName === 'session.list').featureId, alias.id);
});

test('missing read owner keeps its offered authority but describes only the auxiliary read', () => {
  const { write, read } = featurePair('session.list');
  const plan = buildMaidProviderFcToolPlan({ config: providers.deepseek, features: [write] });
  const mapping = plan.toolMappings.find(tool => tool.internalName === 'session.list');
  assert.equal(mapping.featureId, write.id, 'do not authorize a catalog owner absent from this offered snapshot');
  assert.notEqual(mapping.title, write.title);
  assert.ok(!mapping.description.includes(write.summary));
  assert.match(mapping.description, /read-only/i);
  assert.ok(!plan.toolMappings.some(tool => tool.featureId === read.id));
  assert.deepEqual(plan.toolMappings.filter(tool => !tool.control).map(tool => tool.internalName).sort(), write.tools.slice().sort());
});

test('owner preference does not weaken schema checks or admit unoffered tools', () => {
  const { write, read } = featurePair('session.list');
  const plan = buildMaidProviderFcToolPlan({ config: providers.deepseek, features: [write, read] });
  const normalize = (toolName, args) => normalizeMaidProviderFcCompletedCalls({ toolPlan: plan, completedToolCalls: [{ toolName, arguments: args }] });
  assert.equal(normalize('session_list', { limit: 'all' }).reason, 'invalid_tool_arguments');
  assert.equal(normalize('worldbook_list', {}).reason, 'unknown_tool');
  assert.equal(normalize('session_create', {}).reason, 'invalid_tool_arguments');
  assert.equal(normalize('session_create', { name: 'Allowed explicit creation' }).selection.featureId, write.id);
});
