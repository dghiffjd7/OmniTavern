import assert from 'node:assert/strict';
import { normalizeAgentGenerationSettings, changeAgentReasoningMode, buildAgentGenerationOptions, getAgentReasoningControl } from '../../src/scripts/agent/agent-generation-settings.js';
import { createAgentModelRequest } from '../../src/scripts/agent/agent-model-request.js';
import { createAgentConfigStore, normalizeAgentConfiguration } from '../../src/scripts/storage/agent-config-store.js';
import { createFormatRepairProfileDraft, saveFormatRepairProfileDraft, resolveFormatRepairProfile } from '../../src/scripts/agent/format-repair-profiles.js';
import { createAgentConfigurationService } from '../../src/scripts/agent/agent-configuration-service.js';
import { createInputSuggestionRequest, createInputSuggestionRuntime, normalizeInputSuggestion } from '../../src/scripts/ui/chat/input-suggestion-runtime.js';
import { buildInputAgentRequest } from '../../src/scripts/agent/input-agent-runtime.js';
import { createCustomAgentRequestRuntime } from '../../src/scripts/agent/custom-agent-request-runtime.js';
import { createCustomAgentAppRuntime } from '../../src/scripts/ui/chat/custom-agent-app-runtime.js';
import { LLMClient } from '../../src/scripts/api/client.js';

const legacy = normalizeAgentConfiguration({}, 'text_completion');
assert.deepEqual(normalizeAgentGenerationSettings(legacy), { reasoningMode: 'off', reasoningEffort: 'auto', maxTokens: 96, timeoutSeconds: 12 });
assert.equal(normalizeAgentGenerationSettings({}, 'reply_check').timeoutSeconds, 60);
assert.equal(normalizeAgentGenerationSettings({}, 'text-edit:one').reasoningMode, 'default');
const enabled = { ...legacy, ...changeAgentReasoningMode(legacy, 'on'), reasoningEffort: 'low', modelMode: 'profile', modelProfileId: 'test', enabled: true };
assert.equal(enabled.maxTokens, 4096); assert.equal(enabled.timeoutSeconds, 60);
assert.equal(changeAgentReasoningMode({ ...enabled, maxTokens: 8000, timeoutSeconds: 180 }, 'on').timeoutSeconds, 180);
assert.equal(changeAgentReasoningMode({ ...enabled, maxTokens: 8000 }, 'on').maxTokens, 8000);
assert.equal(normalizeAgentGenerationSettings({ ...enabled, maxTokens: 96 }).maxTokens, 2048, 'thinking cannot be saved with the old tiny completion budget');

// Persist scoped values and separate repair profiles without changing other Agents.
const memory = new Map(), storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
const store = createAgentConfigStore({ storage });
const context = { place: 'chat', scopeId: 's', sessionId: 'one' }, other = { ...context, sessionId: 'two' };
await store.save({ id: legacy.id, context, scope: 'global', config: legacy });
await store.save({ id: legacy.id, context, scope: 'local', config: enabled });
assert.equal(store.read(legacy.id, context).config.reasoningMode, 'on');
assert.equal(store.read(legacy.id, other).config.reasoningMode, 'off');
assert.equal(store.read('reply_check', context).config.reasoningMode, 'default');
const restored = createAgentConfigStore({ storage }).read(legacy.id, context).config;
assert.equal(restored.reasoningEffort, 'low'); assert.equal(restored.timeoutSeconds, 60);
let repair = normalizeAgentConfiguration({}, 'reply_check');
const draft = { ...createFormatRepairProfileDraft(repair), reasoningMode: 'on', reasoningEffort: 'max', timeoutSeconds: 180, maxTokens: 12000 };
repair = saveFormatRepairProfileDraft(draft, { id: draft.repairProfileId, name: 'Thinking repair' });
await store.save({ id: 'reply_check', context, config: repair });
repair = store.read('reply_check', context).config;
assert.equal(repair.reasoningMode, 'default', 'editing a manual repair profile does not replace the automatic profile');
assert.equal(resolveFormatRepairProfile(repair, draft.repairProfileId).timeoutSeconds, 180);
assert.equal(resolveFormatRepairProfile(repair, draft.repairProfileId).reasoningEffort, 'max');

// Provider serialization, automatic/manual requests and preview use one policy.
const model = { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'fixture', baseUrl: 'https://api.deepseek.com/v1' };
const sent = [], clients = [];
const createClient = config => {
  clients.push(config);
  const client = new LLMClient(config);
  client.provider.request = async ({ body }) => {
    sent.push(JSON.parse(body));
    return { ok: true, status: 200, body: JSON.stringify({ choices: [{ message: { content: '公园散步。', reasoning_content: 'private reasoning' }, finish_reason: 'stop' }] }) };
  };
  return { chat: client.chat.bind(client), prepareChatRequest: client.prepareChatRequest.bind(client) };
};
const automatic = createInputSuggestionRequest({ createClient, getProfileConfig: async () => model });
assert.equal(await automatic({ settings: enabled, before: '今天想去', after: '' }, new AbortController().signal), '公园散步。');
assert.deepEqual(sent[0].thinking, { type: 'enabled' });
assert.equal(sent[0].reasoning_effort, 'low'); assert.equal(sent[0].max_tokens, 4096);
assert.equal(clients[0].timeout, 60000);
assert.equal(Object.hasOwn(sent[0], 'temperature'), false);
const payload = buildInputAgentRequest(enabled, { text: '今天想去', start: 4 });
assert.equal(payload.params.maxTokens, 4096, 'the former 400-token manual suggestion cap must not consume the reasoning budget');
const manual = createCustomAgentRequestRuntime({ createClient });
const preview = await manual.preview({ request: payload, config: enabled, model });
assert.equal(await manual.request({ request: payload, config: enabled, model }), '公园散步。');
assert.deepEqual(sent[1], preview.wireRequest.body, 'preview is the exact serialized manual request');
for (const key of ['thinking', 'reasoning_effort', 'max_tokens']) assert.deepEqual(sent[0][key], sent[1][key]);
assert.equal(normalizeInputSuggestion('a'.repeat(600)).length, 400, 'displayed suggestion length stays bounded independently of thinking tokens');
const off = buildAgentGenerationOptions({ thinking: { type: 'enabled' }, reasoning_effort: 'max' }, model, legacy);
assert.deepEqual(off.thinking, { type: 'disabled' }); assert.equal(off.reasoning_effort, undefined);
assert.deepEqual(getAgentReasoningControl(model).effortOptions.map(row => row.value), ['auto', 'low', 'high', 'max']);
assert.equal(getAgentReasoningControl({ provider: 'custom', model: 'unknown' }).supported, false);
const claude = buildAgentGenerationOptions({ temperature: 0.3 }, { provider: 'anthropic', model: 'claude-sonnet-4' }, { ...enabled, reasoningEffort: 'auto' });
assert.equal(claude.thinking.type, 'enabled', 'auto effort must still enable an opt-in reasoning model');
assert.ok(claude.thinking.budget_tokens < claude.maxTokens); assert.equal(claude.temperature, undefined);

// Format repair no longer calls the preset-inheriting bridge background request.
let resolutions = 0;
const formatConfig = { ...resolveFormatRepairProfile(repair, draft.repairProfileId), modelOverride: 'deepseek-flash' };
const format = createAgentModelRequest({ config: formatConfig, resolveModel: async () => { resolutions++; return model; }, createClient });
formatConfig.reasoningMode = 'off'; // the request has already captured the draft
const formatOptions = { temperature: 0, presetContext: { sessionId: 'one' } };
const formatPreview = await format.preview(payload.messages, formatOptions);
await format.chat(payload.messages, formatOptions);
assert.equal(resolutions, 1); assert.equal(format.timeoutMs, 180000);
assert.deepEqual(sent.at(-1), formatPreview.wireRequest.body);
assert.deepEqual(sent.at(-1).thinking, { type: 'enabled' }); assert.equal(sent.at(-1).reasoning_effort, 'max');
assert.equal(sent.at(-1).max_tokens, 12000); assert.equal(clients.at(-1).timeout, 180000);
assert.equal(formatPreview.params.presetContext, undefined);
const unavailable = createAgentModelRequest({ config: repair, resolveModel: async () => { throw Error('missing connection'); }, createClient });
await assert.rejects(unavailable.preview(payload.messages, {}), /missing connection/);

const bound = createCustomAgentAppRuntime({ getProfileConfig: async () => model });
assert.equal((await bound.captureModel({ ...enabled, timeoutSeconds: 200 }, context)).timeout, 200000);
const service = createAgentConfigurationService({ store, getContext: () => context, getProfiles: () => [model], captureModel: async () => model });
assert.deepEqual(await service.getAgentModelInfo({ id: legacy.id, context, config: enabled }), { provider: model.provider, model: model.model, baseUrl: model.baseUrl });
assert.equal(service.getAgentConfiguration({ id: legacy.id, context }).profiles[0].apiKey, undefined);

// Configured waits reach the actual autocomplete abort timer; late output is discarded.
let serial = 0, signal, resolveReply, shown = '';
const timers = new Map();
const runtime = createInputSuggestionRuntime({
  getSnapshot: () => ({ active: true, contextKey: 'one', before: '今天想去', after: '', settings: enabled }),
  setTimer: (fn, ms) => { timers.set(++serial, { fn, ms }); return serial; }, clearTimer: id => timers.delete(id),
  request: (_snapshot, captured) => { signal = captured; return new Promise(resolve => { resolveReply = resolve; }); },
  onSuggestion: text => { shown = text; },
});
runtime.schedule();
const running = [...timers.values()][0].fn();
const deadline = [...timers.values()].find(timer => timer.ms === 60000);
assert.ok(deadline, 'the 60s Agent setting replaces the fixed 12s autocomplete timeout');
deadline.fn(); assert.equal(signal.aborted, true);
resolveReply('too late'); await running; assert.equal(shown, ''); runtime.dispose();
console.log('Agent generation settings passed: scoped storage, repair profiles, provider params, preview parity, captured models, cancellation and output bounds');
