import assert from 'node:assert/strict';
import { createCustomAgentAppRuntime } from '../../src/scripts/ui/chat/custom-agent-app-runtime.js';
import { createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createTextEditRuntime } from '../../src/scripts/agent/text-edit-runtime.js';
import { createAgentReferenceContextBuilder } from '../../src/scripts/agent/agent-reference-context.js';
import { createAgentConfigurationService } from '../../src/scripts/agent/agent-configuration-service.js';
import { createAgentConfigStore, normalizeAgentConfiguration } from '../../src/scripts/storage/agent-config-store.js';

const context = { sessionId: 'rp:test', scopeId: 'scope', archiveId: 'archive', place: 'writing' };
const model = { provider: 'vertexai', model: 'gemini-3.8-flash' };
const config = { modelMode: 'follow_current', tools: { enabled: true, ids: ['worldbook.read'], maxRounds: 1 } };
const payload = { messages: [{ role: 'user', content: 'Inspect body' }], params: { maxTokens: 200 } };
let current = context, writes = 0, asked = 0, switchDuringPrompt = false;
const permissions = createAgentPermissionEvaluator();
const registry = createAgentToolRegistry({ permissionEvaluator: permissions, logger: { warn() {} } });
const definition = { name: 'worldbook.read', title: 'Read', description: 'Read', schema: { type: 'object' },
  capabilities: { modelContext: 'allowlist', read: true, write: false }, execute: () => { writes++; return 'REFERENCE'; } };
registry.register(definition);
const bound = createCustomAgentAppRuntime({ registry, permissionEvaluator: permissions, getContext: () => current,
  resolveCurrentModel: async () => model, getProfileConfig: async () => model,
  choosePermission: async options => { assert.ok(options.signal instanceof AbortSignal, 'permission modal follows task cancellation'); asked++; if (switchDuringPrompt) current = { ...context, sessionId: 'other' }; return 'remember_allow'; },
  createClient: () => ({ async *streamChat(messages, options) {
    if (options.tools) options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: { name: 'ac_0_worldbook_read', args: {} } }] } }] });
    else yield 'RESULT';
  } }),
});
const execute = () => bound.request(payload, model, new AbortController().signal, context, { config });
assert.equal((await bound.captureModel({ ...config, modelOverride: 'chosen' }, context)).model, 'chosen');
assert.equal(await execute(), 'RESULT'); assert.equal(writes, 1); assert.equal(asked, 0);
permissions.addRule({ layer: 'global', decision: 'deny', toolName: 'worldbook.read', permission: '*' });
await assert.rejects(execute(), /权限设置停用/); assert.equal(writes, 1, 'explicit deny also covers tools with no permissions array');
permissions.setRules([]);
registry.register({ ...definition, permissions: ['worldbook.read'] }, { replace: true });
switchDuringPrompt = true;
await assert.rejects(execute(), error => error.name === 'AbortError');
assert.equal(asked, 1); assert.equal(writes, 1); assert.equal(permissions.getRules().length, 0, 'stale dialog cannot remember permission into another conversation');
current = context; switchDuringPrompt = false;
assert.equal(await execute(), 'RESULT'); assert.equal(writes, 2);
assert.equal(permissions.getRules()[0].sessionId, context.sessionId);

// Preview and real execution share reference assembly, while only the target is editable.
const messages = [
  { id: 'u1', role: 'user', content: 'Prior question' }, { id: 'a1', role: 'assistant', content: 'Prior reply' },
  { id: 'u2', role: 'user', content: 'Current question' }, { id: 'a2', role: 'assistant', content: '<body>Editable.</body>' },
  { id: 'future', role: 'assistant', content: 'FUTURE MUST NOT LEAK' },
];
const referenceConfig = { history: { enabled: true, unit: 'turns', count: 2, includeTarget: true },
  worldbook: { enabled: true, ids: ['worldbook:one'] }, prompts: { enabled: true, ids: ['prompt:one'] } };
const resolveReference = createAgentReferenceContextBuilder({ getMessages: () => messages,
  listSources: async () => [ { id: 'worldbook:one', kind: 'worldbook', title: 'World', text: 'WORLD REFERENCE' },
    { id: 'prompt:one', kind: 'prompt', title: 'Style', text: 'PRESET REFERENCE' } ],
  getMessageText: m => m.content,
});
const store = createAgentConfigStore({ storage: { getItem: () => null, setItem() {} } });
let note = false, committed = 0, actualRequest;
const makeConfig = () => normalizeAgentConfiguration({ enabled: true, modelMode: 'follow_current', invocationMode: 'both',
  prompt: 'Polish', target: { mode: 'tags', start: '<body>', end: '</body>' }, context: referenceConfig, outputMode: note ? 'note' : 'edit' }, 'text-edit:fixture');
await store.save({ id: 'text-edit:fixture', context, config: makeConfig() });
const rt = createTextEditRuntime({ getContext: () => context, getMessage: id => messages.find(m => m.id === id), getMessages: () => messages,
  getRaw: async m => m.content, getConfig: makeConfig, getBodyRule: () => null, captureModel: async () => model, resolveReference,
  request: async (req, _model, _signal, _sid, execution) => { actualRequest = req; execution.onTrace({ steps: [{ id: '1', kind: 'answer', status: 'succeeded' }] });
    return note ? 'Readable advice' : JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: req.baseRevision, status: 'patch',
      linePatches: [{ startLine: 1, endLine: 1, originalLines: ['Editable.'], replacementLines: ['Edited.'] }] }); },
  review: async () => ({ confirmed: true, changed: true, candidateText: 'Edited.' }),
  commit: async ({ text }) => { committed++; messages[3].content = text; return true; },
});
const actions = createAgentConfigurationService({ store, getContext: () => context, getMessages: () => messages, getRaw: async m => m.content,
  getProfiles: () => [], resolveReference, runtime: rt });
const preview = await actions.buildAgentConfigurationPreview({ id: 'text-edit:fixture', messageId: 'a2', context });
const missingReference = await actions.previewAgentReferenceContext({ id: 'text-edit:fixture', messageId: 'deleted', context });
assert.doesNotMatch(missingReference.text, /Prior reply|FUTURE/, 'missing requested target never falls back to latest history');
assert.equal((await rt.run({ agentId: 'text-edit:fixture', sessionId: context.sessionId, messageId: 'a2' })).status, 'succeeded');
assert.equal(actualRequest.reference.text, preview.reference.text);
assert.match(actualRequest.reference.text, /Prior reply/); assert.match(actualRequest.reference.text, /WORLD REFERENCE/);
assert.match(actualRequest.reference.text, /PRESET REFERENCE/); assert.doesNotMatch(actualRequest.reference.text, /Editable|FUTURE/);
assert.equal(JSON.parse(actualRequest.messages.at(-1).content).target, 'Editable.');
assert.equal(await rt.open(rt.list()[0].id), true); assert.equal(committed, 1);
assert.equal(messages[3].content, '<body>Edited.</body>'); assert.equal(messages[1].content, 'Prior reply');
note = true;
assert.equal((await rt.run({ agentId: 'text-edit:fixture', sessionId: context.sessionId, messageId: 'a2', force: true })).status, 'succeeded');
const job = rt.list().at(-1); assert.equal(job.text, 'Readable advice'); assert.equal(job.trace.steps.length, 1);
assert.equal(await rt.open(job.id), false); assert.equal(committed, 1, 'note results never enter patch writeback');
rt.dispose();
// Revoking selected tools cancels even an automatic task already awaiting a model.
let liveConfig = { ...makeConfig(), tools: { enabled: true, ids: ['worldbook.read'] } }, modelStarted, modelSignal;
const started = new Promise(resolve => { modelStarted = resolve; });
const cancellable = createTextEditRuntime({ getContext: () => context, getMessage: id => messages.find(m => m.id === id), getMessages: () => messages,
  getRaw: async m => m.content, getConfig: () => liveConfig, getBodyRule: () => null, captureModel: async () => model,
  request: (_payload, _model, signal) => { modelSignal = signal; modelStarted(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true })); },
});
const pending = cancellable.run({ agentId: 'text-edit:fixture', sessionId: context.sessionId, messageId: 'a2' });
await started; liveConfig = { ...liveConfig, tools: { ...liveConfig.tools, enabled: false } }; cancellable.reconcile();
assert.equal(modelSignal.aborted, true); assert.equal((await pending).status, 'cancelled'); cancellable.dispose();
console.log('custom Agent APP permissions / captured context / reference preview / isolated target / note results passed');
