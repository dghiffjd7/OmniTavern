import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createAgentConfigStore, BODY_SELECTOR_ID, normalizeAgentConfiguration } from '../../src/scripts/storage/agent-config-store.js';
import { createScopedAgentFeatures } from '../../src/scripts/agent/scoped-agent-features.js';
import { resolveAgentTextTarget, spliceAgentTextTarget, mapAgentRawSelection, suggestAgentBodyRules } from '../../src/scripts/agent/agent-text-target.js';
import { buildTextEditRequest, buildConfigurableInputMessages } from '../../src/scripts/agent/agent-request-builder.js';
import { createTextEditRuntime, validateTextEditCandidate, normalizeTextEditModelResult } from '../../src/scripts/agent/text-edit-runtime.js';
import { buildChatFormatGuardianModelPrompt } from '../../src/scripts/ui/chat/chat-format-guardian-utils.js';
import { createAgentConfigurationService } from '../../src/scripts/agent/agent-configuration-service.js';
import { createAgentModelRequest } from '../../src/scripts/agent/agent-model-request.js';
import { createHopscotchExecutors, createHopscotchTurnRuntime } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { createHopscotchBoardStore } from '../../src/scripts/storage/hopscotch-board-store.js';
import { validateHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';

// A real Vertex reply used one complete JSON fence; its patch still requires
// exact revision/line validation. Prose and malformed wrappers remain errors.
const envelope = JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: 'revision', status: 'patch',
  linePatches: [{ startLine: 1, endLine: 1, originalLines: ['Body.'], replacementLines: ['Revised.'] }] });
const envelopeOptions = { originalText: 'Body.', baseRevision: 'revision' };
for (const lang of ['json', 'JSON', '']) assert.equal(normalizeTextEditModelResult('```' + lang + '\n' + envelope + '\n```', envelopeOptions).ok, true);
for (const response of ['Here is the result:\n' + envelope, '```json\n' + envelope, '```json\n' + envelope + '\n```\nextra',
  '```json\n' + envelope + '\n```\n```json\n' + envelope + '\n```', '<think>text</think>' + envelope])
  assert.equal(normalizeTextEditModelResult(response, envelopeOptions).ok, false);
assert.equal(normalizeTextEditModelResult('```json\n' + envelope + '\n```', { ...envelopeOptions, baseRevision: 'changed' }).ok, false);
assert.equal(normalizeTextEditModelResult('```json\n' + envelope + '\n```', { ...envelopeOptions, originalText: 'Different.' }).ok, false);

const local = new Map(), writing = { place: 'writing', sessionId: 'rp:card', scopeId: 'person' }, chat = { ...writing, place: 'chat', sessionId: 'contact' };
let fail = false, writes = 0;
const store = createAgentConfigStore({ storage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value) },
  saveKv: async () => { writes++; if (fail) throw Error('disk'); return true; }, logger: { warn() {} },
  getLegacy: (id, c, { includeLocal }) => id === 'reply_check' ? { enabled: true, modelMode: 'profile', modelProfileId: 'old', formatGuide: includeLocal ? 'legacy guide' : '' } : null });
assert.equal(store.read('reply_check', writing).config.formatGuide, 'legacy guide');
assert.equal(writes, 0, 'reads never rewrite legacy state');
const global = normalizeAgentConfiguration({ enabled: true, modelMode: 'profile', modelProfileId: 'new', prompt: 'global task', formatGuide: 'global guide' }, 'reply_check');
await store.save({ id: 'reply_check', context: writing, scope: 'global', config: global });
assert.equal(store.read('reply_check', writing).source, 'global');
assert.equal(store.read('reply_check', chat).config.modelProfileId, 'old', 'chat and writing are isolated');
const inherited = store.read('reply_check', writing);
await store.save({ ...inherited, config: { ...inherited.config, enabled: false } });
assert.equal(store.read('reply_check', writing).config.enabled, false, 'local disable is an override');
assert.equal(store.read('reply_check', { ...writing, scopeId: 'other-user' }).config.enabled, false, 'writing config follows card identity');
await store.reset({ ...store.read('reply_check', writing) });
assert.equal(store.read('reply_check', writing).config.formatGuide, 'global guide');
const beforeFailure = store.exportState(); fail = true;
assert.equal((await store.save({ id: 'reply_check', context: writing, config: { enabled: false } })).ok, false);
assert.deepEqual(store.exportState(), beforeFailure, 'failed persistence keeps effective config'); fail = false;
const revision = store.read('reply_check', writing).revision;
await store.save({ id: 'reply_check', context: writing, config: { ...global, prompt: 'newer' } });
assert.equal((await store.save({ id: 'reply_check', context: writing, revision, config: global })).reason, 'config_changed');

const customId = 'text-edit:test';
const config = normalizeAgentConfiguration({ title: 'Polish', enabled: true, modelMode: 'profile', modelProfileId: 'small', prompt: 'Make concise', target: { mode: 'body' } }, customId);
const bodyRule = { mode: 'tags', start: '<body>', end: '</body>' };
await store.save({ id: customId, context: writing, scope: 'global', config });
await store.save({ id: customId, context: writing, config, bodyRule, bodyRevision: store.read(BODY_SELECTOR_ID, writing).revision });
assert.deepEqual(store.read(BODY_SELECTOR_ID, writing).config.target.start, '<body>');
assert.equal(store.list(writing).some(item => item.id === BODY_SELECTOR_ID), false);
await store.remove({ id: customId, context: writing });
assert.equal(store.read(customId, writing).config, null, 'deleted references cannot resurrect inherited agent');
await store.reset({ id: customId, context: writing });
assert.equal(store.read(customId, writing).config.title, 'Polish');

const raw = '<think>private</think>\r\n<body>Line one\r\nLine two</body><tableEdit>updateRow(0,0,{"1":"x"})</tableEdit>';
const target = resolveAgentTextTarget(raw, { mode: 'body' }, { bodyRule });
assert.equal(target.text, 'Line one\r\nLine two');
assert.equal(spliceAgentTextTarget(target, 'Short'), '<think>private</think>\r\n<body>Short</body><tableEdit>updateRow(0,0,{"1":"x"})</tableEdit>');
assert.equal(resolveAgentTextTarget('<body>one</body><body>two</body>', bodyRule).reason, 'target_ambiguous');
assert.equal(resolveAgentTextTarget('<body>one', bodyRule).reason, 'target_missing');
assert.equal(resolveAgentTextTarget(raw, { mode: 'body' }).reason, 'body_rule_missing');
assert.equal(resolveAgentTextTarget('abc', { mode: 'full' }, { maxChars: 2 }).reason, 'target_too_long');
assert.equal(resolveAgentTextTarget(raw, { mode: 'regex', pattern: '<body>([\\s\\S]*?)</body>', group: 1 }).text, target.text);
assert.equal(resolveAgentTextTarget('aa', { mode: 'regex', pattern: '(a)', group: 1 }).reason, 'target_ambiguous');
assert.equal(resolveAgentTextTarget('aaa', { mode: 'regex', pattern: '(a+)+', group: 1 }).reason, 'unsafe_regex');
assert.equal(resolveAgentTextTarget(raw, {}, { selection: { start: target.start, end: target.end, text: target.text } }).ok, true);
assert.equal(resolveAgentTextTarget(raw, {}, { selection: { start: 0, end: 4, text: 'html' } }).reason, 'selection_changed');
const normalizedRaw = raw.replace(/\r\n?/g, '\n'), selectionStart = normalizedRaw.indexOf('Line one');
const selectedRaw = mapAgentRawSelection(raw, selectionStart, selectionStart + 'Line one\nLine two'.length);
assert.equal(selectedRaw.text, target.text); assert.equal(resolveAgentTextTarget(raw, {}, { selection: selectedRaw }).ok, true);
assert.equal(suggestAgentBodyRules('', [{ text: '<story>preset content</story>' }])[0].rule.start, '<story>');
const request = buildTextEditRequest({ config: { ...config, blocks: [{ enabled: true, name: 'Voice', role: 'system', text: 'Gentle' }], context: { mode: 'recent', count: 1, maxChars: 500 } }, target, messages: [{ role: 'user', content: 'x'.repeat(800) }], baseRevision: 'test' });
assert.equal(request.reference.truncated, true);
assert.ok(request.messages.some(m => m.content === 'Gentle'));
assert.equal(request.messages.at(-1).content.includes('private'), false, 'request sends only writable target by default');
assert.ok(buildConfigurableInputMessages({ settings: { prompt: 'custom suggestion', blocks: [{ enabled: false, text: 'disabled' }] } })[0].content === 'custom suggestion');
const format = buildChatFormatGuardianModelPrompt({ assistantText: '<tableEdit>x</tableEdit>', agentConfig: { prompt: 'Check style', blocks: [{ text: 'Keep tags', enabled: true }] }, referenceContext: { text: 'previous' } });
assert.ok(format.messages.some(m => m.content === 'Check style') && format.messages.some(m => m.content.includes('previous')));
assert.equal(validateTextEditCandidate(raw, raw.replace('private', 'changed')).ok, false);
assert.equal(validateTextEditCandidate(raw, raw.replace('updateRow(0,0', 'updateRow(1,0')).ok, false);

let source = { id: 'm', role: 'assistant', type: 'text', rawOriginal: raw, content: raw, meta: { activeSwipe: 0 } }, archive = 'a', commits = 0, requested = 0, held;
let respond = async req => JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: req.baseRevision, status: 'patch', issues: [], repairSummary: 'concise', linePatches: [{ startLine: 1, endLine: 1, originalLines: ['Line one'], replacementLines: ['First line'] }] });
const runtime = createTextEditRuntime({ getContext: () => ({ ...writing, archiveId: archive }), getMessage: () => source,
  getMessages: () => [source], getRaw: async m => m?.rawOriginal || '', getConfig: () => config, getBodyRule: () => bodyRule,
  captureModel: async () => ({ model: 'mock' }), request: async req => { requested++; return respond(req); },
  review: async options => { const text = options.originalText.replace('Line one', 'First line'); assert.equal(options.validateCandidate({ candidateText: text }).canApply, true); return { confirmed: true, changed: true, candidateText: text }; },
  commit: async ({ text, canCommit }) => { assert.equal(canCommit(), true); commits++; source = { ...source, rawOriginal: text, content: text }; return true; } });
const first = await runtime.run({ agentId: customId, sessionId: writing.sessionId, messageId: 'm' });
assert.equal(first.status, 'succeeded'); assert.equal(commits, 0, 'automatic completion only queues candidate');
assert.equal((await runtime.run({ agentId: customId, sessionId: writing.sessionId, messageId: 'm' })).reason, 'already_running');
assert.equal(await runtime.open(first.artifact.runId), true); assert.equal(commits, 1);
assert.equal(source.rawOriginal.includes('<think>private</think>'), true);
source = { ...source, rawOriginal: raw, content: raw };
const second = await runtime.run({ agentId: customId, sessionId: writing.sessionId, messageId: 'm', force: true });
archive = 'b'; assert.equal(await runtime.open(second.artifact.runId), false); assert.equal(commits, 1, 'archive change expires candidates'); archive = 'a';
respond = req => new Promise(resolve => { held = () => resolve(JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: req.baseRevision, status: 'no_change', linePatches: [] })); });
const pending = runtime.run({ agentId: customId, sessionId: writing.sessionId, messageId: 'm', force: true });
while (!held) await new Promise(resolve => setTimeout(resolve, 0));
runtime.cancel(runtime.list().at(-1).id); held();
assert.equal((await pending).status, 'cancelled'); assert.equal(commits, 1);
runtime.dispose();

// Disk hydration must not invalidate its own run, while a raw-only user edit must.
source = { id: 'm', role: 'assistant', type: 'text', content: 'rendered', rawSource: 'body', meta: {} };
const loadingRuntime = createTextEditRuntime({ getContext: () => writing, getMessage: () => source,
  getMessages: () => [source], getRaw: async m => { m.rawOriginal ||= raw; return m.rawOriginal; }, getConfig: () => config, getBodyRule: () => bodyRule,
  captureModel: async () => ({}), request: async req => JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: req.baseRevision, status: 'patch', linePatches: [{startLine:1,endLine:1,originalLines:['Line one'],replacementLines:['Short']}] }),
  review: async () => { throw Error('stale candidate cannot reach review'); }, commit: async () => { throw Error('stale candidate cannot commit'); } });
const loaded = await loadingRuntime.run({ agentId: customId, sessionId: writing.sessionId, messageId: 'm' });
assert.equal(loaded.status, 'succeeded', 'raw disk cache hydration is allowed');
source.rawOriginal = raw + 'edited';
assert.equal(await loadingRuntime.open(loaded.artifact.runId), false, 'raw-only edit expires previous target');
loadingRuntime.dispose();

// Rules and reference context are captured before asynchronous model/raw loading.
let capturedModel, mutableRule = { ...bodyRule }, historyText = { role: 'user', content: 'original reference' };
const frozenRuntime = createTextEditRuntime({ getContext: () => writing, getMessage: () => source,
  getMessages: () => [historyText, source], getRaw: async () => raw,
  getConfig: () => ({ ...config, context: { mode: 'recent' } }), getBodyRule: () => mutableRule,
  captureModel: () => new Promise(resolve => { capturedModel = resolve; }), request: async req => {
    assert.equal(req.reference.text, 'user: original reference'); assert.equal(JSON.parse(req.messages.at(-1).content).target, target.text);
    return JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: req.baseRevision, status: 'no_change', linePatches: [] });
  } });
const frozenRun = frozenRuntime.run({ agentId: customId, sessionId: writing.sessionId, messageId: 'm' });
mutableRule.start = '<changed>'; historyText.content = 'later reference'; capturedModel({});
assert.equal((await frozenRun).status, 'succeeded'); frozenRuntime.dispose();

const legacy = { getSettings: () => ({ features: { reply_check: { enabled: true }, text_completion: { enabled: false }, write_preview: { enabled: true } } }), listFeatures: () => [] };
const facade = createScopedAgentFeatures({ legacy, store, getContext: sid => sid === 'contact' ? chat : writing });
assert.equal(facade.getSettings('contact').features.reply_check.modelProfileId, 'old');
assert.equal(facade.getSettings(writing.sessionId).features.reply_check.prompt, 'newer');
assert.equal(facade.isEnabled('write_preview'), true, 'unrelated legacy features retain their behavior');

const workflowStore = createHopscotchBoardStore({ storage: { getItem: () => null, setItem() {} } });
const workflowBoard = { rows: [{ id: 'body-row', houses: [{ id: 'body', kind: 'body' }] },
  { id: 'edit-row', houses: [{ id: 'edit', kind: 'text_edit', label: config.title, config: { agentId: customId } }] }] };
assert.equal(validateHopscotchBoard(workflowBoard).ok, true);
assert.equal(validateHopscotchBoard({ rows: [...workflowBoard.rows].reverse() }).ok, false, 'text modification must follow body');
await workflowStore.setGlobalBoard(workflowBoard);
let automaticCalls = 0;
const workflow = createHopscotchTurnRuntime({ boardStore: workflowStore, getSettings: () => ({ creativeHopscotchEnabled: true }), getTextAgents: () => [config],
  createExecutors: info => createHopscotchExecutors({ ...info, textEdit: { run: async options => {
    automaticCalls++; assert.equal(options.agentId, customId); assert.equal(options.messageId, 'generated-body');
    return { status: 'succeeded', artifact: { kind: 'text_edit_candidate', runId: 'candidate' } };
  } } }) });
const turn = workflow.prepareTurn({ sessionId: writing.sessionId, rpUiMode: true });
assert.ok(turn);
await turn.waitForBodyStart(); turn.resolveBody({ status: 'succeeded', messageId: 'generated-body' });
await turn.turnPromise;
assert.equal(automaticCalls, 1, 'workflow actually executes text-edit house after completed body');
assert.equal(workflow.isSessionBusy(writing.sessionId), false, 'pending candidate does not retain workflow lock');

const actions = createAgentConfigurationService({ store, getContext: () => writing, getMessages: () => [source], getRaw: async m => m.rawOriginal, getProfiles: () => [], runtime, buildFormatPreview: async () => ({}) });
const draft = await actions.createTextEditAgent({ context: writing });
assert.equal(draft.ok, true); assert.equal(draft.config.enabled, false);
assert.equal(draft.config.target.mode, 'rendered'); assert.equal(draft.config.modelMode, 'follow_current'); assert.equal(draft.config.invocationMode, 'auto');
const invalid = await actions.saveAgentConfiguration({ ...store.read(draft.id, writing), config: { ...draft.config, enabled: true, modelMode: 'none' } });
assert.equal(invalid.ok, false, 'cannot enable missing model');
const beforePreview = writes;
await actions.getAgentTargetPreview({ id: draft.id, context: writing });
await actions.buildAgentConfigurationPreview({ id: draft.id, context: writing });
assert.equal(writes, beforePreview, 'preview never persists configuration');
assert.equal((await actions.runTextEditAgent({ id: draft.id, context: { ...writing, scopeId: 'other-person' } })).status, 'failed');
const older = { ...source, id: 'older', rawOriginal: '<body>older reply</body>' };
let picked;
const messageActions = createAgentConfigurationService({ store, getContext: () => writing, getMessages: () => [older, source], getRaw: async m => m.rawOriginal, getProfiles: () => [],
  runtime: { run: async options => { picked = options.messageId; return { status: 'succeeded' }; } } });
await messageActions.runTextEditAgent({ id: customId, context: writing, messageId: older.id });
assert.equal(picked, older.id, 'manual call stays pinned to chosen message');

const limitStore = createAgentConfigStore({ storage: { getItem: () => null, setItem() {} } });
for (let i = 0; i < 8; i++) assert.equal((await limitStore.save({ id: `text-edit:limit${i}`, context: writing, config: {} })).ok, true);
assert.equal((await limitStore.save({ id: 'text-edit:shared', context: writing, scope: 'global', config: {} })).reason, 'agent_limit', 'global additions respect inherited local capacity');
await limitStore.remove({ id: 'text-edit:limit0', context: writing });
assert.equal((await limitStore.save({ id: 'text-edit:shared', context: writing, scope: 'global', config: {} })).ok, true);

// Exercise the actual app assembly while switching the selected API after capture.
const appSource = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const assembly = appSource.slice(appSource.indexOf('  const buildChatFormatGuardianModelReviewOptions ='), appSource.indexOf('  const buildChatFormatGuardianOptions ='));
let activeModel = { model: 'before' }, sentModel, modelMode = 'follow_current';
const buildOptions = runInNewContext(`${assembly}; buildChatFormatGuardianModelReviewOptions`, {
  createAgentModelRequest,
  agentFeatureSettingsStore: { isEnabled: () => true, getSettings: () => ({ features: { reply_check: { modelMode, modelProfileId: 'profile' } } }) },
  AGENT_FEATURE_IDS: { replyCheck: 'reply_check' }, resolveUiModeForSession: () => 'rp',
  buildChatFormatGuardianModelContext: () => ({ enabledFormats: {} }), captureRequestContext: () => ({ captured: true }),
  chatConfigManager: { getRuntimeConfigByProfileId: async () => ({ ...activeModel }) },
  window: { appBridge: { resolveRequestRuntimeConfig: async () => ({ config: { ...activeModel } }), backgroundChat: async () => { assert.fail('Agent requests must not inherit preset generation settings'); } } },
  LLMClient: class { constructor(config) { this.config = config; } async chat() { sentModel = this.config.model; } },
  isBridgeConfigured: () => true, getChatFormatGuardianSessionLabel: () => '', getSessionFormatGuide: () => 'guide',
  getAgentConfigContext: () => writing, agentReferenceRuntime: { resolveReference: async options => ({ text: options.targetMessageId || '' }) }, chatStore: { getMessages: () => [], getCurrentArchiveId: () => '' }, contactsStore: { getContact: () => null },
  resolveFormatTargetForSession: () => 'auto', FORMAT_PATCH_MODEL_MAX_TOKENS: 6000,
});
for (const mode of ['follow_current', 'profile']) {
  modelMode = mode; activeModel = { model: 'before' };
  const options = buildOptions(writing.sessionId); activeModel = { model: 'after' };
  await options.backgroundChat([{ role: 'user', content: 'review' }]);
  assert.equal(sentModel, 'before', `${mode} keeps the model captured at request start`);
}
console.log('agent configuration / targets / requests / candidate transactions passed');
