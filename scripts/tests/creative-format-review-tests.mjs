import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeAgentFeatureSettings } from '../../src/scripts/agent/agent-feature-settings.js';
import { createMaidFormatProfileStore } from '../../src/scripts/storage/maid-format-profile-store.js';
import { createFormatGuideSettingsRuntime, resolveFormatReviewAvailability } from '../../src/scripts/ui/chat/format-review-settings-utils.js';
import { createFormatReviewExecutor, createCreativeFormatReviewRuntime } from '../../src/scripts/ui/chat/format-review-runtime.js';
import { createSessionAsyncWorkRuntime } from '../../src/scripts/ui/chat/session-async-work-runtime-utils.js';
import { buildDefaultHopscotchBoard, normalizeHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';
import { resolveHopscotchActivation } from '../../src/scripts/ui/chat/hopscotch-activation-utils.js';
import { renderHopscotchCourt } from '../../src/scripts/ui/chat/hopscotch-court-view.js';
import { createHopscotchExecutors } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { runChatFormatGuardianPreview } from '../../src/scripts/ui/chat/after-receive-dispatch-utils.js';
import { AgentCenterPanel } from '../../src/scripts/ui/agent-center-panel.js';

const enabled = { enabled: true, modelMode: 'follow_current', triggerMode: 'auto' };
const memory = new Map();
let sid = 'rp:a', scope = 'user-a', tick = 1;
const store = createMaidFormatProfileStore({ storage: { getItem: k => memory.get(k), setItem: (k,v) => memory.set(k,v) }, now: () => tick++ });
const settings = createFormatGuideSettingsRuntime({ getSessionId: () => sid, getScopeId: () => scope, getPlace: () => 'writing', getProfile: id => store.get(id), getStore: () => store });
assert.equal(normalizeAgentFeatureSettings().features.reply_check.enabled, false);
assert.equal(resolveFormatReviewAvailability({}, { place: 'chat' }).enabled, false);
assert.equal(resolveFormatReviewAvailability(enabled, { place: 'writing' }).reason, 'format_guide_missing');
assert.equal(resolveFormatReviewAvailability({ ...enabled, modelMode: 'profile' }, { place: 'writing', hasFormatGuide: true }).reason, 'model_unavailable');
assert.equal(resolveFormatReviewAvailability({ ...enabled, triggerMode: 'manual' }, { place: 'writing', hasFormatGuide: true }).reason, 'manual_only');
const original = settings.read();
let saved = settings.save({ ...original, guide: '正文必须使用 <story> 标签，并保留全部原文。' });
assert(saved.ok && saved.usable);
assert.equal(store.peek(sid).manualOverride, true);
assert(settings.save({ ...original, guide: 'obsolete' }).ok === false, 'reject a stale editor');
sid = 'rp:b';
assert.equal(settings.read().guide, '');
assert.equal(settings.save({ ...saved, guide: 'cross-session' }).ok, false);
sid = 'rp:a'; scope = 'user-b';
assert.equal(settings.save({ ...saved, guide: 'cross-persona' }).ok, false);
scope = 'user-a';
assert.equal(settings.save({ ...saved, guide: 'x'.repeat(6001) }).ok, false);
saved = settings.save({ ...saved, guide: '' });
assert(saved.ok && !saved.usable);
assert.equal(store.get(sid), null);
console.log('ok - defaults, format requirement, explicit scope/revision checks and clearing');

const empty = buildDefaultHopscotchBoard({ place: 'writing' });
const fallback = renderHopscotchCourt(empty, { formatReview: { enabled: false, reason: 'disabled' } });
assert.match(fallback, /data-hop-format-review data-hop-enabled="false"/);
const board = buildDefaultHopscotchBoard({ place: 'writing', replyCheck: { ...enabled, hasFormatGuide: true } });
assert(board.rows.some(row => row.houses.some(house => house.kind === 'format_review')));
assert.doesNotMatch(renderHopscotchCourt(board, { place: 'writing', formatReview: enabled }), /仅聊天|data-hop-format-review/);
const paused = resolveHopscotchActivation(board, { place: 'writing', replyCheck: { ...enabled, hasFormatGuide: false } });
assert.equal(paused.houses.review.reason, 'format_guide_missing');
assert.equal(resolveHopscotchActivation(board, { place: 'writing', replyCheck: { enabled: false } }).houses.review.enabled, false);
assert.equal(board.rows.flatMap(row => row.houses).find(h => h.id === 'review').enabled, true, 'availability does not rewrite a saved house');
console.log('ok - visible disabled entry, configured writing house, pause without layout changes');

let source = { id: 'm', role: 'assistant', content: 'A quiet walk.', rawOriginal: '<story>A quiet walk.</story>' };
let guide = 'Keep the story tag paired. Preserve all narrative words.', context = 'scope:a';
let calls = 0, completed = 0, previewCount = 0, quiet = false;
const runs = [];
const requests = [];
const deps = {
  findMessage: () => source, getPlace: () => 'writing', getGuide: () => guide, getScope: () => context,
  resolveTarget: async () => ({ ok: true, sourceText: source.rawOriginal, sourceKind: 'creative_raw_original', targetSessionId: 'rp:a' }),
  buildOptions: () => ({ enabled: true, manualTrigger: true, recordSucceededRun: false, modelReview: {
    enabled: true, force: true, formatTarget: 'creative_text', uiMode: 'rp', surface: 'creative', customFormatGuide: guide,
    backgroundChat: async messages => { calls++; requests.push(messages); return JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: 'format-run:creative-test', status: 'no_change', issues: [], linePatches: [], repairSummary: 'Tags are valid.' }); },
  } }),
  createRevision: () => 'format-run:creative-test', runPreview: runChatFormatGuardianPreview,
  onPreview: () => previewCount++, onRun: payload => runs.push(payload.agentRun), onQueued: payload => { quiet = payload.quiet; }, onCompleted: () => completed++, logger: { warn() {} },
};
const run = createFormatReviewExecutor(deps);
const result = await run({ sessionId: 'rp:a', messageId: 'm', automatic: true });
assert.equal(result.status, 'succeeded'); assert.equal(calls, 1); assert.equal(completed, 1);
assert.equal(quiet, true, 'automatic checking uses quiet progress');
assert.match(JSON.stringify(requests), /Keep the story tag paired/);
assert.equal(source.content, 'A quiet walk.', 'review never writes the source message');
guide = '';
assert.equal((await run({ sessionId: 'rp:a', messageId: 'm' })).reason, 'format_guide_missing');
assert.equal(calls, 1);
guide = 'Keep tags paired';
const abort = new AbortController(); abort.abort();
assert.equal((await run({ sessionId: 'rp:a', messageId: 'm', signal: abort.signal })).status, 'cancelled');
let resolveTarget;
const delayed = createFormatReviewExecutor({ ...deps, resolveTarget: () => new Promise(resolve => { resolveTarget = resolve; }) });
const previous = delayed({ sessionId: 'rp:a', messageId: 'm' });
context = 'scope:b'; resolveTarget({ ok: true, sourceText: source.rawOriginal });
assert.equal((await previous).status, 'cancelled'); assert.equal(calls, 1);
let completeModel;
const beforePreview = previewCount;
const late = createFormatReviewExecutor({ ...deps, runPreview: options => { completeModel = () => { options.onChatFormatGuardianPreview({}); options.onChatFormatGuardianRun({ agentRun: { id: 'stale-review', status: 'succeeded' } }); options.onChatFormatGuardianModelReviewCompleted({ result: { modelReview: { canRepair: true } } }); }; return { modelReviewQueued: true }; } });
const inFlight = late({ sessionId: 'rp:a', messageId: 'm' });
await Promise.resolve(); source = null; completeModel();
assert.equal((await inFlight).status, 'cancelled'); assert.equal(previewCount, beforePreview);
assert.equal(runs.at(-1).status, 'cancelled', 'finish stale in-flight records instead of leaving a running item');
console.log('ok - actual custom guide model assembly, missing guide, abort and stale-target guards');

let automaticCalls = 0, finish;
const sessionWork = createSessionAsyncWorkRuntime();
const automatic = createCreativeFormatReviewRuntime({
  getSettings: () => enabled, getGuide: () => guide, getPlace: id => id.startsWith('rp:') ? 'writing' : 'chat', getScope: () => context,
  sessionAsyncWorkRuntime: sessionWork,
  run: options => { automaticCalls++; return new Promise(resolve => { finish = () => resolve({ status: options.signal.aborted ? 'cancelled' : 'succeeded' }); }); },
});
const input = { message: { id: 'auto', role: 'assistant' }, sessionId: 'rp:a' };
assert.equal(automatic.afterReceive({ ...input, suppressed: true }), null);
assert.equal(automatic.afterReceive({ ...input, sessionId: 'chat:a' }), null);
guide = ''; assert.equal(automatic.afterReceive(input), null); guide = 'Keep tags';
const autoAbort = new AbortController();
const first = automatic.afterReceive({ ...input, signal: autoAbort.signal });
assert.equal(automatic.afterReceive(input), first);
await Promise.resolve(); assert.equal(automaticCalls, 1); autoAbort.abort(); finish();
assert.equal((await first).status, 'cancelled');
let inBoard = 0;
const executors = createHopscotchExecutors({ board: normalizeHopscotchBoard(board), sessionId: 'rp:a', getTurnContext: () => ({ body: { messageId: 'm' } }), formatReview: { place: 'writing', run: async () => { inBoard++; return { status: 'succeeded' }; } } });
assert.equal((await executors.format_review.run({})).status, 'succeeded'); assert.equal(inBoard, 1);
console.log('ok - ordinary writing, explicit workflow ownership, request deduplication and cancellation');

const panel = new AgentCenterPanel();
panel.view.agentFormatGuide = { place: 'writing', sessionId: 'rp:a', scopeId: 's', guide: '<script>alert(1)</script>', usable: true };
const editor = panel.renderFormatGuideEditor({ id: 'reply_check' });
assert.match(editor, /&lt;script&gt;/); assert.doesNotMatch(editor, /<script>/);
assert.match(editor, /data-help-mode="tap"/);
assert.match(panel.renderAgentConfiguration({ id: 'reply_check' }), /data-agent-format-guide-editor/);
panel.view.agentFormatGuide.place = 'chat';
assert.equal(panel.renderFormatGuideEditor({ id: 'reply_check' }), '');
const app = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
assert.match(app, /getAgentFormatGuide: \(\) => formatGuideSettingsRuntime.read\(\)/);
assert.match(app, /creativeFormatReviewRuntime.afterReceive\(/);
assert.match(app, /suppressFormatGuardianModelReview: Boolean\(hopscotchTurn\?\.board\?\.rows.some/);
assert.match(app, /formatReviewSignal: abortSignal/);
console.log('ok - shared card editor, escaping, desktop/touch help and app wiring');
