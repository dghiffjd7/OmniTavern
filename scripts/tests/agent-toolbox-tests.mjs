import assert from 'node:assert/strict';
import { normalizeToolboxPreferences, reconcileToolboxPreferences, getToolboxItems, setToolboxItemVisible, isAgentToolToggle, toolboxVisibleCount } from '../../src/scripts/ui/agent-toolbox-model.js';
import { normalizeAgentIcon, getAgentIconName, isAgentNoteConfig } from '../../src/scripts/agent/agent-icons.js';
import { createAgentConfigStore, normalizeAgentConfiguration } from '../../src/scripts/storage/agent-config-store.js';
import { createAgentConfigurationService } from '../../src/scripts/agent/agent-configuration-service.js';
import { createTextEditRuntime } from '../../src/scripts/agent/text-edit-runtime.js';
import { resolveRenderedAgentTarget } from '../../src/scripts/agent/agent-rendered-target.js';
import { resolveAgentTextTargetAsync } from '../../src/scripts/agent/agent-text-target.js';
import { createFormatReviewExecutor } from '../../src/scripts/ui/chat/format-review-runtime.js';
import { buildContextMenuActions } from '../../src/scripts/ui/chat/context-menu-ui-utils.js';

const chat = { place: 'chat', sessionId: 's', scopeId: 'p', archiveId: 'a' };
const list = [{ id: 'text_completion', kind: 'input_suggestion', enabled: true, invocationMode: 'auto' }, { id: 'reply_check', enabled: true }, { id: 'text-edit:a', enabled: true }];
let prefs = reconcileToolboxPreferences(normalizeToolboxPreferences({ pinned: ['reply_check'], order: ['text-edit:a'] }), list, chat);
assert.deepEqual(getToolboxItems(prefs, list, chat).map(c => c.id), ['text-edit:a', 'reply_check', 'text_completion']);
list[0].enabled = false;
prefs = reconcileToolboxPreferences(prefs, list, chat);
assert(getToolboxItems(prefs, list, chat).some(c => c.id === 'text_completion'), 'turning assistance off keeps its quick switch');
prefs = setToolboxItemVisible(prefs, 'reply_check', false, chat);
prefs = reconcileToolboxPreferences(prefs, list, chat);
assert(!getToolboxItems(prefs, list, chat).some(c => c.id === 'reply_check'), 'explicit hiding survives config refresh');
const other = { ...chat, sessionId: 'other' };
prefs = reconcileToolboxPreferences(prefs, list, other);
assert(getToolboxItems(prefs, list, other).some(c => c.id === 'reply_check'), 'membership is scoped to the conversation');
assert(getToolboxItems(prefs, list, other).some(c => c.id === 'text_completion'), 'the built-in input switch is available even when initially off');
let hiddenInput = setToolboxItemVisible(prefs, 'text_completion', false, other);
hiddenInput = reconcileToolboxPreferences(hiddenInput, list, other);
assert(!getToolboxItems(hiddenInput, list, other).some(c => c.id === 'text_completion'), 'explicitly hiding the built-in input switch is still respected');
assert(isAgentToolToggle(list[0]));
assert(!isAgentToolToggle({ ...list[0], invocationMode: 'manual' }), 'manual suggestion has an explicit run card');
assert.equal(toolboxVisibleCount(296, 10), 4);
assert.equal(toolboxVisibleCount(366, 4), 4);
assert.equal(normalizeAgentIcon('<svg onload=bad>'), '');
assert.equal(normalizeAgentIcon('book'), 'book');
const replyEdit = normalizeAgentConfiguration({ outputMode: 'edit' }, 'text-edit:icon');
assert.equal(getAgentIconName(replyEdit), 'pen'); assert.equal(isAgentNoteConfig(replyEdit), false, 'unused inputOutput default does not turn a reply edit into a note');
assert(!buildContextMenuActions({ id: 'a', role: 'assistant', type: 'text' }, { canEditWithAgent: true }).some(action => action.key === 'text-edit-agent'), 'message menu no longer exposes Agent tools');

let context = { ...chat }, raw = '<thinking>private</thinking>\r\n<p>Line one &amp; tea.</p>\r\n<p>Line two.</p><tableEdit>updateRow(0,0,{"1":"keep"})</tableEdit>';
let message = { id: 'm', role: 'assistant', content: 'Line one & tea.\nLine two.', rawOriginal: raw, meta: { activeSwipe: 0 } };
let requested = 0, committed = 0, loadGate = null;
const store = createAgentConfigStore({ storage: { getItem: () => null, setItem() {} } });
const id = 'text-edit:toolbox', config = normalizeAgentConfiguration({ enabled: true, title: 'Edit', modelMode: 'follow_current', invocationMode: 'manual', prompt: 'Improve selected text', target: { mode: 'rendered' }, icon: 'pen' }, id);
await store.save({ id, context, config });
await store.save({ id: 'reply_check', context, config: { enabled: true, modelMode: 'follow_current', invocationMode: 'manual' } });
const getRaw = async m => loadGate ? await loadGate : m.rawOriginal;
const resolveTarget = (source, rule, options) => typeof options.renderedSelection === 'string'
  ? resolveRenderedAgentTarget(source, options.renderedSelection)
  : rule?.mode === 'rendered' ? resolveRenderedAgentTarget(source, options.message.content) : resolveAgentTextTargetAsync(source, rule, options);
const runtime = createTextEditRuntime({ getContext: () => ({ ...context }), getMessages: () => [message], getMessage: () => message, getRaw,
  getConfig: agentId => store.read(agentId, context).config, getBodyRule: () => null, resolveTarget,
  captureModel: async () => ({}), request: async request => {
    requested++; const target = JSON.parse(request.messages.at(-1).content).target;
    assert.equal(target, 'Line one & tea.', 'request sees exactly the selected visible text');
    return JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: request.baseRevision, status: 'patch',
      linePatches: [{ startLine: 1, endLine: 1, originalLines: [target], replacementLines: ['First line & tea.'] }] });
  }, review: async options => {
    assert(options.validateCandidate({ candidateText: 'First line & tea.' }).canApply);
    return { confirmed: true, changed: true, candidateText: 'First line & tea.' };
  }, commit: async ({ text, sourceSnapshot, canCommit }) => {
    assert(canCommit()); assert.equal(sourceSnapshot, message.rawOriginal);
    committed++; message = { ...message, rawOriginal: text }; return true;
  } });
let formatSource = { ok: true, sourceKind: 'social_turn_raw', sourceSessionId: chat.sessionId, sourceMessageIds: ['m', 'm2'], sourceText: '<MiPhone>entire turn</MiPhone>', turnId: 'turn1' };
const actions = createAgentConfigurationService({ store, getContext: () => ({ ...context }), getMessages: () => [message], getRaw, getProfiles: () => [],
  runtime, resolveTarget, getFormatTarget: async () => ({ ...formatSource }), runFormat: async () => { throw Error('not needed'); } });
const selected = await actions.captureAgentToolSelection({ messageId: 'm', selectedText: 'Line one & tea.' });
assert(selected.ok); assert.equal(selected.snapshot.target.mapping.length, 1);
const pickedIdentity = actions.captureAgentToolSelectionIdentity({ messageId: 'm' });
message.meta.activeSwipe = 1;
assert.equal((await actions.captureAgentToolSelection({ messageId: 'm', selectedText: 'Line one & tea.', expectedIdentity: pickedIdentity })).ok, false, 'selection identity precedes the click even when another branch contains identical text');
message.meta.activeSwipe = 0;
assert.equal((await actions.captureAgentToolSelection({ messageId: 'm', selectedText: 'private' })).ok, false, 'hidden thinking cannot become a selection');
const prepared = await actions.prepareAgentToolTarget({ id, messageId: 'm', selectionSnapshot: selected.snapshot });
assert(prepared.ok); assert.equal(requested, 0, 'opening a target preview cannot call a model');
const result = await actions.runTextEditAgent({ id, messageId: 'm', targetSnapshot: prepared.snapshot });
assert.equal(result.status, 'succeeded'); assert.equal(committed, 0, 'request only produces a review');
assert(await runtime.open(result.artifact.runId));
assert.equal(committed, 1); assert.equal(message.rawOriginal, raw.replace('Line one &amp; tea.', 'First line &amp; tea.'), 'only the mapped span changes; entities, CRLF, thinking and tables stay intact');
assert.equal((await actions.runTextEditAgent({ id, messageId: 'm', targetSnapshot: prepared.snapshot })).status, 'skipped');
assert.equal(requested, 1, 'raw-only change cannot reuse the earlier target');

message = { ...message, rawOriginal: raw };
const branchTarget = await actions.prepareAgentToolTarget({ id, selectionSnapshot: selected.snapshot });
message = { ...message, meta: { activeSwipe: 1 } };
assert.equal((await actions.runTextEditAgent({ id, messageId: 'm', targetSnapshot: branchTarget.snapshot })).status, 'skipped');
message = { ...message, meta: { activeSwipe: 0 } };
context = { ...chat, archiveId: 'b' };
assert.equal((await actions.prepareAgentToolTarget({ id, selectionSnapshot: selected.snapshot })).ok, false);
context = { ...chat };
let release;
loadGate = new Promise(resolve => { release = resolve; });
const loading = actions.captureAgentToolSelection({ messageId: 'm', selectedText: 'Line one & tea.' });
message = { ...message, meta: { activeSwipe: 2 } }; release(raw);
assert.equal((await loading).ok, false, 'branch change during disk load rejects the selection');
loadGate = null; message = { ...message, meta: { activeSwipe: 0 } };
message.rawOriginal = '<p>repeat</p><p>repeat</p>';
assert.equal((await actions.captureAgentToolSelection({ messageId: 'm', selectedText: 'repeat' })).ok, false, 'ambiguous repeated source never guesses');
message.rawOriginal = raw;
const turn = await actions.prepareAgentToolTarget({ id: 'reply_check', messageId: 'm', selectionSnapshot: selected.snapshot });
assert(turn.ok); assert.equal(turn.snapshot.target.text, formatSource.sourceText); assert.equal(turn.snapshot.formatTarget.sourceMessageIds.length, 2, 'format target remains the whole turn');

let formatRequests = 0;
const format = createFormatReviewExecutor({ findMessage: () => message, getScope: () => 'p:a', getPlace: () => 'chat', getCurrentSessionId: () => chat.sessionId,
  getGuide: () => '', getConfig: () => store.read('reply_check', chat).config, resolveTarget: async () => formatSource,
  buildOptions: () => ({ enabled: true, modelReview: { enabled: true, backgroundChat() {} } }), createRevision: () => 'r',
  runPreview: () => { formatRequests++; return { modelReviewQueued: false }; } });
formatSource = { ...formatSource, sourceText: '<MiPhone>changed turn</MiPhone>' };
assert.equal((await format({ sessionId: chat.sessionId, messageId: 'm', expectedTarget: turn.snapshot.formatTarget })).status, 'skipped');
assert.equal(formatRequests, 0, 'whole-turn changes after opening the card stop before model review');
runtime.dispose();
console.log('agent toolbox preferences, snapshots, selection review and format guards passed');
