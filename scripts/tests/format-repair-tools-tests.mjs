import assert from 'node:assert/strict';
import { createAgentConfigStore } from '../../src/scripts/storage/agent-config-store.js';
import { createAgentConfigurationService } from '../../src/scripts/agent/agent-configuration-service.js';
import { createFormatRepairProfileDraft, saveFormatRepairProfileDraft, resolveFormatRepairProfile } from '../../src/scripts/agent/format-repair-profiles.js';
import { createFormatRepairSelection, validateFormatRepairSelection, validateFormatRepairWriteScope } from '../../src/scripts/agent/format-repair-selection.js';
import { createFormatRepairToolRuntime } from '../../src/scripts/agent/format-repair-tool-runtime.js';
import { buildFormatRepairRequest } from '../../src/scripts/agent/format-repair-request.js';
import { buildFormatFunctionSideEffectPlan, validateFormatRepairFunctionPayloads } from '../../src/scripts/ui/chat/format-repair-side-effect-utils.js';
import { parseTableEditActions } from '../../src/scripts/memory/memory-edit-parser.js';

let context = { place: 'writing', scopeId: '', sessionId: 'rp:repair-test', archiveId: 'one' };
let writes = 0;
const legacy = { enabled: true, modelMode: 'follow_current', invocationMode: 'both', prompt: 'original task', formatGuide: 'keep tags' };
const store = createAgentConfigStore({ storage: { getItem: () => null, setItem: () => writes++ }, getLegacy: () => legacy });
assert.equal(store.read('reply_check', context).config.repairProfiles.items[0].name, '默认方案');
assert.equal(store.read('reply_check', context).config.prompt, legacy.prompt);
assert.equal(writes, 0, 'opening the new UI cannot migrate or write old configuration');
let message = { id: 'm', role: 'assistant', content: 'unchanged prose', rawOriginal: '<p>hello</p>\r\n<tableEdit>updateRow(0,0,{"1":"B",})</tableEdit>\r\nEND' };
const target = () => ({ ok: true, sourceText: message.rawOriginal, sourceKind: 'creative_raw_original', turnId: 'turn', sourceSessionId: context.sessionId, targetSessionId: context.sessionId, sourceMessageIds: ['m'] });
let requested = 0, committed = 0, invalid = false, output = '', gate = null;
const requests = [];
const backgroundChat = async messages => {
  requested++; requests.push(messages);
  if (gate) await gate;
  const text = messages.map(row => row.content).join('\n'), revision = /baseRevision: ([^\r\n]+)/.exec(text)[1];
  const original = '<tableEdit>updateRow(0,0,{"1":"B",})</tableEdit>';
  output = original.replace(',}', '}');
  return JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: revision, status: 'patch', repairSummary: '修正 JSON',
    linePatches: [{ startLine: 1, endLine: 1, originalLines: [invalid ? 'wrong original' : original], replacementLines: [output] }] });
};
const base = config => ({ surface: 'creative', uiMode: 'rp', modelReview: { enabled: true, backgroundChat, agentConfig: config,
  uiMode: 'rp', surface: 'creative', formatTarget: 'creative_text', enabledFormats: { tableEdit: true },
  resolveReferenceContext: async () => ({ text: 'REFERENCE_ONLY' }) } });
const runtime = createFormatRepairToolRuntime({ getContext: () => context, getMessage: () => message,
  getConfig: () => store.read('reply_check', context).config, resolveTarget: async () => target(), buildOptions: (_sid, config) => base(config),
  review: async options => {
    assert.equal(options.wholeChange, true);
    const check = options.validateCandidate({ candidateText: output, acceptedPatches: options.linePatches }); assert(check.canApply);
    return { confirmed: true, changed: true, candidateText: output, acceptedPatches: options.linePatches };
  }, commit: async ({ text, selection, canCommit }) => {
    assert(canCommit()); assert(validateFormatRepairWriteScope(message.rawOriginal, text, selection).ok);
    committed++; message = { ...message, rawOriginal: text }; return true;
  } });
const service = createAgentConfigurationService({ store, getContext: () => context, getMessages: () => [message], getRaw: async m => m.rawOriginal,
  getProfiles: () => [], runtime: { list: () => [] }, getFormatTarget: async () => target(), formatRuntime: runtime });
const saveProfile = async (config, scope = 'global') => {
  const saved = service.getAgentConfiguration({ id: 'reply_check', context, scope });
  const result = await service.saveAgentConfiguration({ id: 'reply_check', context, scope, revision: saved.revision,
    config, repairProfileId: config.repairProfileId }); assert(result.ok, JSON.stringify(result));
};
let original = service.getAgentConfiguration({ id: 'reply_check', context, scope: 'global' }).config;
let table = createFormatRepairProfileDraft(original, 'tableEdit'); table.repairProfileName = 'A'; await saveProfile(table);
const aId = table.repairProfileId;
let second = createFormatRepairProfileDraft(store.read('reply_check', context, 'global').config, 'structure'); second.repairProfileName = 'B'; await saveProfile(second);
const bId = second.repairProfileId;
assert.equal(store.read('reply_check', context).config.prompt, 'original task', 'saving/selecting a manual profile preserves the bound automatic task');
table = service.getAgentConfiguration({ id: 'reply_check', context, repairProfileId: aId }).config;
table.prompt = 'local A'; await saveProfile(table, 'local');
second = service.getAgentConfiguration({ id: 'reply_check', context, scope: 'global', repairProfileId: bId }).config;
second.prompt = 'global B updated'; await saveProfile(second);
assert.equal(service.getAgentConfiguration({ id: 'reply_check', context, repairProfileId: bId }).config.prompt, 'global B updated', 'a local A override still inherits updates to global B');
assert.equal(service.getAgentConfiguration({ id: 'reply_check', context, repairProfileId: aId }).config.prompt, 'local A');
assert.equal(store.read('reply_check', context).repairProfileSources[bId], 'global');
const copiedContext = { place: 'chat', scopeId: '', sessionId: '' };
assert((await service.copyAgentConfiguration({ id: 'reply_check', context, targetContext: copiedContext, targetScope: 'global',
  config: table, repairProfileId: aId })).ok);
assert.equal(store.read('reply_check', copiedContext, 'global').config.prompt, 'original task', 'copying while editing a manual profile cannot replace the automatic profile');
assert.equal(resolveFormatRepairProfile(store.read('reply_check', copiedContext, 'global').config, aId).prompt, 'local A');
let saved = service.getAgentConfiguration({ id: 'reply_check', context, repairProfileId: aId });
assert((await service.changeFormatRepairProfile({ id: 'reply_check', context, scope: 'local', action: 'restore', repairProfileId: aId, revision: saved.revision })).ok);
assert.equal(service.getAgentConfiguration({ id: 'reply_check', context, repairProfileId: aId }).config.prompt, table.repairProfiles.items.find(item => item.id === aId).config.prompt);

const source = message.rawOriginal, start = source.indexOf('<tableEdit>'), end = source.indexOf('</tableEdit>') + '</tableEdit>'.length;
assert.equal(createFormatRepairSelection(source, { range: { start: start + 4, end }, checkType: 'tableEdit' }).ok, false);
assert(createFormatRepairSelection(source, { checkType: 'tableEdit' }).ok);
const plan = createFormatRepairSelection(source, { range: { start, end }, checkType: 'tableEdit' });
const repaired = plan.text.replace(',}', '}');
const patches = [{ startLine: 1, endLine: 1, originalLines: [plan.text], replacementLines: [repaired] }];
assert.equal(validateFormatRepairSelection(source, plan, repaired, patches).text, source.replace(plan.text, repaired));
const whole = createFormatRepairSelection(source, { checkType: 'tableEdit' });
assert(!validateFormatRepairSelection(source, whole, source.replace('hello', 'changed'), [{ startLine: 1, endLine: 1, originalLines: ['<p>hello</p>'], replacementLines: ['<p>changed</p>'] }]).ok);
assert(!validateFormatRepairWriteScope(source, source.replace('END', 'bad'), { ...plan, linePatches: patches }).ok);
assert(!createFormatRepairSelection('A\r\n😀B', { range: { start: 2, end: 6 } }).ok);
assert(!createFormatRepairSelection('A😀B', { range: { start: 2, end: 4 } }).ok);

const mixed = '<tableEdit>insertRow(0,{"0":"A"})\nupdateRow(0,0,{"1":"B",})</tableEdit>';
const fixed = mixed.replace(',}', '}');
assert.equal(parseTableEditActions(mixed).length, 1);
const effects = buildFormatFunctionSideEffectPlan({ originalText: mixed, candidateText: fixed });
assert.equal(effects.executeEntries.length, 1);
assert.deepEqual(parseTableEditActions(effects.executeEntries[0].executionText).map(action => action.action), ['update'], 'an already readable insert is not repeated');
assert(validateFormatRepairFunctionPayloads({ originalText: mixed, candidateText: fixed, allowedTableRanges: [{ start: 0, end: mixed.length }] }).ok);
assert(!validateFormatRepairFunctionPayloads({ originalText: mixed, candidateText: fixed.replace('"A"', '"changed"'), allowedTableRanges: [{ start: 0, end: mixed.length }] }).ok, 'repair cannot rewrite an existing parsed operation');
assert(!validateFormatRepairFunctionPayloads({ originalText: mixed, candidateText: fixed }).ok, 'ordinary reply editors retain the functional payload guard');
const interleaved = mixed.replace('</tableEdit>', '\ninsertRow(0,{"0":"last"})</tableEdit>');
assert(!validateFormatRepairFunctionPayloads({ originalText: interleaved, candidateText: interleaved.replace(',}', '}'), allowedTableRanges: [{ start: 0, end: interleaved.length }] }).ok, 'a repair cannot replay an operation before a later already readable operation');
assert(!validateFormatRepairFunctionPayloads({ originalText: '<UpdateVariable>x</UpdateVariable>', candidateText: '<UpdateVariable>y</UpdateVariable>', allowedTableRanges: [{ start: 0, end: 100 }] }).ok);

const prepared = await service.prepareAgentToolTarget({ id: 'reply_check', context, messageId: 'm', repairProfileId: aId, rawRange: { start, end }, rawSource: source });
assert(prepared.ok);
const config = service.getAgentConfiguration({ id: 'reply_check', context, repairProfileId: aId }).config;
const preview = await buildFormatRepairRequest({ config, repairTarget: target(), message, range: { start, end }, baseOptions: base(config), baseRevision: 'preview' });
assert(preview.messages.some(item => item.content.includes(plan.text)));
assert(preview.messages.some(item => item.content.includes('REFERENCE_ONLY')));
assert(preview.messages[0].content.includes('Only the selected tableEdit blocks'));
assert(!preview.messages[0].content.includes('载荷必须逐字保持不变'), 'selected tables are explicitly permitted while other functions remain protected');
assert(!preview.messages.some(item => item.content.includes('<p>hello</p>')), 'fragment requests do not secretly send the whole reply');
const result = await service.runConfiguredFormatReview({ id: 'reply_check', context, messageId: 'm', repairProfileId: aId, targetSnapshot: prepared.snapshot });
assert.equal(result.status, 'succeeded', JSON.stringify(result)); assert.equal(committed, 0);
assert.equal(runtime.list().at(-1).status, 'ready');
assert(await runtime.open(result.artifact.runId)); assert.equal(committed, 1);
assert.equal(message.rawOriginal, source.replace(plan.text, repaired));
assert.equal(message.rawOriginal.slice(0, start), source.slice(0, start), 'CRLF and outside bytes survive apply');
message = { ...message, rawOriginal: source };
invalid = true;
const bad = await service.runConfiguredFormatReview({ id: 'reply_check', context, messageId: 'm', repairProfileId: aId, targetSnapshot: prepared.snapshot });
assert.equal(bad.status, 'failed'); assert.equal(committed, 1); assert.equal(requested, 3, 'one bounded retry only');
assert.equal(runtime.list().at(-1).unread, true, 'a failure remains available after the toolbox was closed');
runtime.ignore(bad.artifact.runId); assert.equal(runtime.list().at(-1).unread, false);
invalid = false;
const stale = await service.runConfiguredFormatReview({ id: 'reply_check', context, messageId: 'm', repairProfileId: aId, targetSnapshot: prepared.snapshot });
message = { ...message, rawOriginal: source + 'new branch' };
assert.equal(await runtime.open(stale.artifact.runId), false, 'a ready result rechecks authoritative raw at apply');
message = { ...message, rawOriginal: source };
let release; gate = new Promise(resolve => { release = resolve; });
const pending = service.runConfiguredFormatReview({ id: 'reply_check', context, messageId: 'm', repairProfileId: aId, targetSnapshot: prepared.snapshot });
while (runtime.list().at(-1).status !== 'running') await new Promise(resolve => setTimeout(resolve, 1));
context = { ...context, archiveId: 'two' }; runtime.reconcile(); release();
await pending; assert.notEqual(runtime.list().at(-1).status, 'ready'); assert.equal(committed, 1);
runtime.dispose();
console.log('format repair profiles, inheritance, exact source ranges, table operation reuse and manual candidate lifecycle passed');
