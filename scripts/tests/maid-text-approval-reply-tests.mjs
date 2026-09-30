import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidCommandInputRuntime } from '../../src/scripts/ui/maid-command-input-runtime-utils.js';
import { createMaidToolConfirmationRuntime } from '../../src/scripts/ui/maid-tool-confirmation-runtime.js';
import { createMaidCommandSubmit } from '../../src/scripts/ui/maid-command-submit-runtime.js';
import { MaidConversationStore } from '../../src/scripts/storage/maid-conversation-store.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const baseScope = { roleCardId: 'card-a', sessionId: 'chat-a', uiMode: 'chat' };
const groupRequest = { toolName: 'group.create', kind: 'group.create', operationType: 'create_group_chat',
  title: 'Create group', message: 'Create the named group with these members?', allowAlways: false,
  details: { groupName: 'Travel party', items: [{ id: 'member-a', label: 'A', status: 'planned' }, { id: 'member-b', label: 'B', status: 'planned' }] } };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map();
    this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ''; this.scrollHeight = 32;
    const classes = new Set(); this.classList = { add: (...xs) => xs.forEach(x => classes.add(x)),
      remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x),
      toggle: (x, on) => (on ?? !classes.has(x)) ? classes.add(x) : classes.delete(x) };
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getBoundingClientRect() { return { left: 100, top: 200, width: 26, height: 26 }; }
  addEventListener(key, fn) { const list = this.listeners.get(key) || []; list.push(fn); this.listeners.set(key, list); }
  removeEventListener(key, fn) { this.listeners.set(key, (this.listeners.get(key) || []).filter(x => x !== fn)); }
  dispatch(key, values = {}) { const event = { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; }, ...values };
    for (const fn of this.listeners.get(key) || []) { fn(event); if (event.stopped) break; } }
  focus() {}
}
const documentForClick = () => ({ body: new Element('body'), head: new Element('head'),
  createElement: tag => new Element(tag), getElementById: () => null, addEventListener() {}, removeEventListener() {} });
const descendants = node => [node, ...(node.children || []).flatMap(descendants)];

const setup = ({ prepareSubmission = null, source = '', scope = baseScope, request = groupRequest, documentRef = null } = {}) => {
  let currentScope = { ...scope }, runtime, calls = [], writes = 0, history = [];
  const confirmation = createMaidToolConfirmationRuntime({ canShowInline: () => true,
    getCurrentScope: () => ({ ...currentScope }), makeId: () => `approval-${calls.length}` });
  runtime = createMaidCommandInputRuntime({ documentRef, getAppContext: () => ({ ...currentScope }),
    setTimeoutFn: () => 0, clearTimeoutFn() {}, getViewportSize: () => ({ w: 400, h: 800 }),
    getPendingApproval: runId => confirmation.getPendingForRun?.(runId),
    resolveBoundApproval: (request, action) => confirmation.resolveBound?.(request, action),
    onTextApprovalReply: turn => history.push(turn),
    prepareSubmission,
    onSubmit: async (text, controls) => {
      calls.push({ text, controls });
      const runId = `run-${controls.submissionId}`;
      runtime.applyTraceView({ runId, status: 'waiting_permission', terminal: false, steps: [] });
      if (calls.length > 1 && !text.includes('Travel party')) return { ok: true, message: 'Independent task.' };
      const decision = await confirmation.request(request, { signal: controls.signal, runId,
        submissionId: controls.submissionId, ...currentScope });
      if (decision.decision === 'allow' && !controls.signal.aborted) writes++;
      return { ok: true, status: controls.signal.aborted ? 'cancelled' : 'succeeded', message: 'Finished.' };
    } });
  const start = (options = {}) => runtime.submitTask('Create Travel party with A and B.', { id: 'task-a', source, context: { ...currentScope }, ...options });
  return { runtime, confirmation, calls, history, start, setScope: value => { currentScope = { ...value }; },
    get writes() { return writes; }, async cleanup() {
      for (const task of runtime.getQueue()) runtime.cancelQueued(task.id);
      const active = runtime.getActiveSubmission(); if (active) runtime.cancelSubmission(active.id);
      await tick();
    } };
};

test('real command queue consumes a bound group cancellation instead of queueing it behind the approval', async t => {
  const h = setup(); t.after(() => h.cleanup());
  const first = h.start(); await tick();
  assert.equal(h.confirmation.getPendingCount(), 1);
  const reply = h.runtime.submitTask('不要', { id: 'reply-a' });
  await tick();
  assert.equal(h.runtime.getQueue().length, 0, 'the cancellation must reach the current approval before normal queueing');
  const result = await reply;
  assert.equal(result.status, 'cancelled');
  assert.equal((await first).status, 'cancelled');
  assert.equal(h.confirmation.getPendingCount(), 0);
  assert.equal(h.writes, 0);
  assert.equal(h.calls.length, 1, 'cancellation is handled without another planner task');
  assert.equal(h.history[0].input, '不要');
  assert.equal(h.history[0].context.textApprovalReply.runId, 'run-task-a');
  assert.equal(h.history[0].context.textApprovalReply.submissionId, 'task-a');
});

test('actual submit-button click sends the approval draft rather than stopping the task', async t => {
  const doc = documentForClick(), h = setup({ documentRef: doc }); t.after(() => h.cleanup());
  const first = h.start(); await tick();
  const field = descendants(doc.body).find(el => el.tagName === 'TEXTAREA');
  const button = descendants(doc.body).find(el => el.className === 'maid-command-input-submit');
  field.value = '确认'; field.dispatch('input');
  button.dispatch('click', { detail: 1 });
  await first; await tick();
  assert.equal(h.writes, 1, 'click must approve once through the same text bridge, not cancel the original task');
  assert.equal(h.history[0].input, '确认');
});

test('concurrent pure confirmations allow once and do not confirm or swallow a later task', async t => {
  const h = setup(); t.after(() => h.cleanup());
  const first = h.start(); await tick();
  const independent = h.runtime.submitTask('Read the weather.', { id: 'independent' });
  assert.equal(h.runtime.getQueue().length, 1);
  const [one, two] = await Promise.all([h.runtime.submitTask('confirm'), h.runtime.submitTask('confirm')]);
  assert.equal(one.reason, 'approval_allowed_once');
  assert.equal(two.reason, 'approval_already_handled');
  await first; await independent;
  assert.equal(h.writes, 1);
  assert.equal(h.calls.length, 2);
  await h.runtime.submitTask('确认', { id: 'later-text-proposal' });
  assert.equal(h.calls.length, 3, 'deduplication ends with the original active task');
});

test('conditional rename withdraws old approval before replanning and retains full input and attachments', async t => {
  const h = setup(); t.after(() => h.cleanup());
  const originalAttachment = { id: 'original-image', url: 'data:original' };
  const newAttachment = { id: 'new-image', url: 'data:new' };
  const first = h.start({ attachments: [originalAttachment], context: { ...baseScope,
    pendingActionSubmissionId: 'stale', runContinuation: { sourceRunId: 'stale-run' },
    operationIntentPolicy: { mode: 'write_allowed' }, capabilitySnapshot: { id: 'stale-snapshot' },
    userSelection: [{ id: 'original-reference' }] } });
  await tick();
  const old = h.confirmation.getPendingForRun('run-task-a');
  const raw = '好，但是名字改成新的探险团';
  const revised = h.runtime.submitTask(raw, { id: 'revision-a', attachments: [newAttachment],
    context: { pendingActionSubmissionId: 'injected', runContinuation: { sourceRunId: 'injected' } } });
  const duplicate = await h.runtime.submitTask(raw, { id: 'revision-duplicate' });
  assert.equal(duplicate.reason, 'approval_already_handled');
  assert.equal(h.confirmation.resolve(old.id, 'allow_once'), false, 'old button cannot approve obsolete arguments');
  assert.equal((await first).status, 'cancelled');
  await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].text, `Create Travel party with A and B.\n\n用户修正：${raw}`);
  assert.deepEqual(h.calls[1].controls.attachments, [originalAttachment, newAttachment]);
  for (const key of ['pendingActionSubmissionId', 'runContinuation', 'operationIntentPolicy', 'capabilitySnapshot']) {
    assert.equal(h.calls[1].controls.context[key], undefined, `${key} is not a revision permission`);
  }
  assert.deepEqual(h.calls[1].controls.context.userSelection, [{ id: 'original-reference' }]);
  assert.equal(h.writes, 0);
  assert.equal(h.history[0].input, raw, 'history records the real user correction, not a synthetic planner goal');
  assert.equal(h.calls[1].controls.maidTextApprovalRevision.originalGoal, 'Create Travel party with A and B.');
  assert.equal(h.confirmation.getPendingForRun('run-revision-a').id === old.id, false);
  await h.runtime.submitTask('确认'); await revised;
  assert.equal(h.writes, 1, 'only the newly confirmed task may complete');
});

test('complex confirmation stays on the same approval without queueing or rebuilding it', async t => {
  const h = setup(); t.after(() => h.cleanup());
  const first = h.start(); await tick();
  const before = h.confirmation.getPendingForRun('run-task-a');
  for (const input of ['确认，按这个名字建。', '确认按这个名字建']) {
    const reply = await h.runtime.submitTask(input);
    assert.equal(reply.reason, 'approval_reply_unclear');
    assert.equal(h.confirmation.getPendingForRun('run-task-a').id, before.id);
    assert.equal(h.runtime.getQueue().length, 0);
    assert.equal(h.calls.length, 1);
  }
  const attached = await h.runtime.submitTask('确认', { attachments: [{ id: 'new', url: 'data:image' }] });
  assert.equal(attached.reason, 'approval_reply_unclear', 'new attached content is not silently treated as approval');
  assert.equal(h.writes, 0);
  await h.runtime.submitTask('取消'); await first;
});

test('changed scope and stale trace cannot approve the bound task', async t => {
  const h = setup(); t.after(() => h.cleanup());
  const first = h.start(); await tick();
  const old = h.confirmation.getPendingForRun('run-task-a');
  h.setScope({ ...baseScope, roleCardId: 'card-b' });
  assert.equal((await h.runtime.submitTask('确认')).reason, 'approval_target_unavailable');
  assert.equal(h.confirmation.getPendingForRun('run-task-a').id, old.id);
  h.setScope(baseScope);
  h.runtime.applyTraceView({ runId: 'unrelated-run', status: 'running', terminal: false, steps: [] });
  const queued = h.runtime.submitTask('确认', { id: 'not-bound' });
  assert.equal(h.writes, 0);
  assert.equal(h.confirmation.getPendingForRun('run-task-a').id, old.id);
  h.runtime.cancelQueued('not-bound'); await queued;
  h.runtime.applyTraceView({ runId: 'run-task-a', status: 'waiting_permission', terminal: false, steps: [] });
  await h.runtime.submitTask('取消'); await first;
});

test('voice submissions and approvals for other tools retain their original entry paths', async t => {
  for (const scenario of ['voice-task', 'voice-reply', 'other-tool']) {
    const h = setup({ ...(scenario === 'voice-task' ? { source: 'maid_realtime' } : {}),
      ...(scenario === 'other-tool' ? { request: { ...groupRequest, toolName: 'worldbook.update_entries' } } : {}) });
    t.after(() => h.cleanup());
    const first = h.start(); await tick();
    const reply = h.runtime.submitTask('不要', { id: `reply-${scenario}`,
      ...(scenario === 'voice-reply' ? { source: 'maid_realtime', voiceCallId: 'call-a' } : {}) });
    assert.equal(h.runtime.getQueue().length, 1);
    assert.equal(h.confirmation.getPendingCount(), 1);
    assert.equal(h.history.length, 0);
    h.runtime.cancelQueued(`reply-${scenario}`); await reply;
    h.runtime.cancelSubmission('task-a'); await first;
    assert.equal(h.writes, 0);
  }
});

test('scope changes during revision preparation stop the revised task before queue acceptance', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const h = setup({ prepareSubmission: async (text, attachments, controls) => {
    if (text.includes('用户修正：')) { entered(); await gate; }
    return { ...controls, attachments, skillsPrepared: true };
  } });
  t.after(() => h.cleanup());
  const first = h.start(); await tick();
  const revision = h.runtime.submitTask('好，但是名字改成新的探险团');
  await started;
  h.setScope({ ...baseScope, sessionId: 'chat-b' }); release();
  assert.equal((await revision).reason, 'approval_revision_scope_changed');
  assert.equal((await first).status, 'cancelled');
  assert.equal(h.calls.length, 1);
  assert.equal(h.runtime.getQueue().length, 0);
  assert.equal(h.writes, 0);
  assert.equal(h.history[0].input, '好，但是名字改成新的探险团');
});

test('real command-submit wrapper binds trustworthy task scope and records only the actual correction', async () => {
  const approvals = [], turns = [], tasks = [];
  const raw = '好，但是名字改成新的探险团';
  const command = createMaidCommandSubmit({ getAppContext: () => ({ ...baseScope, agentId: 'maid-assistant' }),
    getVoiceRuntime: () => null, matchMaidIntent: () => null,
    resolveMaidRuntimeConfig: async () => ({ configured: true }),
    logger: { debug() {} }, checkMaidVisionInput: async () => ({ ok: true }),
    maidSettingsStore: { setLastExchange() {}, getLastExchange: () => ({ requestPrompt: 'captured', source: 'model' }) },
    buildAppFeatureSearchContextText: () => '',
    requestMaidToolConfirmation: async (request, options) => { approvals.push({ request, options }); return { decision: 'deny' }; },
    maidAssistantAgent: { async runPrompt(text, context) {
      tasks.push({ text, context });
      await context.requestToolConfirmation(groupRequest, { runId: 'real-run', submissionId: 'forged', roleCardId: 'forged', uiMode: 'forged' });
      return { ok: true, status: 'cancelled', message: 'Stopped.' };
    } }, recordMaidTurnFromResult: async turn => turns.push(turn) });
  const result = await command(`Original task\n\n用户修正：${raw}`, {
    submissionId: 'revision-submission', context: baseScope,
    maidTextApprovalRevision: { scope: baseScope, input: raw, originalGoal: 'Original task', requestId: 'old-request' },
  });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual({ submissionId: approvals[0].options.submissionId, roleCardId: approvals[0].options.roleCardId,
    sessionId: approvals[0].options.sessionId, uiMode: approvals[0].options.uiMode }, { submissionId: 'revision-submission', ...baseScope });
  assert.equal(turns[0].input, '', 'the raw correction is already recorded by the input runtime');
  assert.equal(turns[0].context.textApprovalRevision.input, raw);
  assert.equal(turns[0].context.textApprovalRevision.replanningInput, tasks[0].text);
});

test('real conversation store records original task then raw revision before the revised planner starts', async t => {
  const store = new MaidConversationStore({ storage: null, loadKv: async () => null, saveKv: async () => {}, compactionTurnThreshold: 1000 });
  await store.load();
  const record = ({ input, result, context }) => store.appendTurn({ input, message: result.message, status: result.status, context });
  const confirmation = createMaidToolConfirmationRuntime({ canShowInline: () => true, getCurrentScope: () => baseScope });
  let runtime, count = 0, historyAtRevision;
  const command = createMaidCommandSubmit({ getAppContext: () => ({ ...baseScope, agentId: 'maid-assistant' }),
    getVoiceRuntime: () => null, matchMaidIntent: () => null, resolveMaidRuntimeConfig: async () => ({ configured: true }),
    logger: { debug() {} }, checkMaidVisionInput: async () => ({ ok: true }),
    maidSettingsStore: { setLastExchange() {}, getLastExchange: () => ({ requestPrompt: 'captured', source: 'model' }) },
    buildAppFeatureSearchContextText: () => '', recordMaidTurnFromResult: record,
    requestMaidToolConfirmation: (request, options) => confirmation.request(request, options),
    maidAssistantAgent: { async runPrompt(text, context) {
      count++;
      if (count === 2) historyAtRevision = store.exportState().turns.map(turn => turn.input);
      const runId = `run-${context.submissionId}`;
      runtime.applyTraceView({ runId, status: 'waiting_permission', terminal: false, steps: [] });
      await context.requestToolConfirmation(groupRequest, { runId, signal: context.signal });
      return { ok: true, status: context.signal.aborted ? 'cancelled' : 'succeeded', message: 'Finished.' };
    } } });
  runtime = createMaidCommandInputRuntime({ documentRef: null, getAppContext: () => baseScope,
    getPendingApproval: runId => confirmation.getPendingForRun(runId),
    resolveBoundApproval: (request, action) => confirmation.resolveBound(request, action),
    onTextApprovalReply: record, onSubmit: command });
  t.after(async () => { const active = runtime.getActiveSubmission(); if (active) runtime.cancelSubmission(active.id); await tick(); });
  const original = 'Create Travel party with A and B.', correction = '好，但是名字改成新的探险团';
  const first = runtime.submitTask(original, { id: 'initial' }); await tick();
  const revision = runtime.submitTask(correction, { id: 'revised' });
  await tick();
  assert.deepEqual(historyAtRevision, [original, correction], 'pending reply must not precede its original task in real history');
  runtime.cancelSubmission('revised'); await revision; await first;
  assert.equal(store.exportState().turns.filter(turn => turn.input === correction).length, 1);
});
