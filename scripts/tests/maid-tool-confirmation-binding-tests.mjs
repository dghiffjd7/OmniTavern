import assert from 'node:assert/strict';
import test from 'node:test';
import { createMaidToolConfirmationRuntime } from '../../src/scripts/ui/maid-tool-confirmation-runtime.js';

const binding = { submissionId: 'submission-a', roleCardId: 'card-a', sessionId: 'session-a', uiMode: 'maid' };
const options = (extra = {}) => ({ runId: 'run-a', ...binding, ...extra });
const groupRequest = () => ({
  toolName: 'group.create', kind: 'group.create', operationType: 'create_group_chat', allowAlways: false,
  title: 'Create group', message: 'Create Expedition with Kai and Luna',
  details: { groupName: 'Expedition', items: [{ id: 'kai', label: 'Kai', status: 'planned' }, { id: 'luna', label: 'Luna', status: 'planned' }] },
});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const bound = pending => ({ id: pending.id, runId: pending.runId, binding: { ...binding } });

test('modal request is registered and one exact bound text approval settles it once', async () => {
  const modal = deferred(), controller = new AbortController();
  let shown;
  const runtime = createMaidToolConfirmationRuntime({
    choose: args => { shown = args; return modal.promise; }, getCurrentScope: () => ({ ...binding }),
  });
  const decision = runtime.request(groupRequest(), options({ signal: controller.signal }));
  try {
    assert.equal(runtime.getPendingCount(), 1, 'a real modal must participate in pending request lookup');
    const pending = runtime.getPendingForRun('run-a');
    assert.equal(pending.visible, true);
    assert.equal(pending.toolName, 'group.create');
    assert.deepEqual(pending.binding, binding);
    assert.equal(pending.groupName, 'Expedition');
    assert.deepEqual(pending.members, [{ id: 'kai', name: 'Kai' }, { id: 'luna', name: 'Luna' }]);
    assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), true);
    assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), false);
    assert.deepEqual(await decision, { decision: 'allow' });
    assert.equal(shown.signal.aborted, true, 'text approval closes the same real modal');
    assert.equal(runtime.getPendingForRun('run-a'), null);
    assert.equal(runtime.getPendingCount(), 0);
    modal.resolve('deny');
    await tick();
    assert.equal(runtime.getPendingCount(), 0, 'late UI completion cannot revive a settled request');
  } finally { controller.abort(); modal.resolve('deny'); }
});

test('bound approval requires every original identity field and a fresh current scope', async () => {
  let scope = { ...binding };
  const runtime = createMaidToolConfirmationRuntime({ canShowInline: () => true, getCurrentScope: () => scope });
  const suppliedOptions = options();
  const decision = runtime.request(groupRequest(), suppliedOptions);
  const pending = runtime.getPendingForRun('run-a');
  suppliedOptions.roleCardId = 'mutated-card';
  pending.binding.roleCardId = 'mutated-copy';
  pending.members[0].id = 'mutated-member';
  assert.deepEqual(runtime.getPendingForRun('run-a').binding, binding, 'registration and public snapshots do not share mutable identity');
  assert.equal(runtime.getPendingForRun('run-a').members[0].id, 'kai');
  for (const key of ['id', 'runId']) assert.equal(runtime.resolveBound({ ...bound(pending), [key]: 'other' }, 'allow_once'), false, key);
  for (const key of Object.keys(binding)) {
    assert.equal(runtime.resolveBound({ ...bound(pending), binding: { ...binding, [key]: 'other' } }, 'allow_once'), false, key);
    const missing = { ...binding }; delete missing[key];
    assert.equal(runtime.resolveBound({ ...bound(pending), binding: missing }, 'deny'), false, `missing ${key}`);
  }
  for (const action of ['allow_always', 'allow', '', null]) assert.equal(runtime.resolveBound(bound(pending), action), false);
  for (const key of ['roleCardId', 'sessionId', 'uiMode']) {
    scope = { ...binding, [key]: 'changed' };
    assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), false, `live ${key}`);
  }
  scope = {};
  assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), false);
  scope = { ...binding };
  assert.equal(runtime.resolveBound(bound(pending), 'deny'), true);
  assert.deepEqual(await decision, { decision: 'deny' });
});

test('text is unavailable without trusted binding, a fresh scope getter, or group.create', async () => {
  for (const setup of [
    { request: groupRequest(), options: { runId: 'run-a' }, getter: () => binding },
    { request: groupRequest(), options: options(), getter: null },
    { request: groupRequest(), options: options(), getter: () => { throw new Error('scope unavailable'); } },
    { request: { ...groupRequest(), toolName: 'session.delete_many' }, options: options(), getter: () => binding },
  ]) {
    const runtime = createMaidToolConfirmationRuntime({ canShowInline: () => true, getCurrentScope: setup.getter });
    const decision = runtime.request(setup.request, setup.options);
    const pending = runtime.getPendingForRun('run-a');
    assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), false);
    assert.equal(runtime.resolve(pending.id, 'deny'), true, 'legacy buttons still work');
    assert.deepEqual(await decision, { decision: 'deny' });
  }
  const emptySession = { ...binding, sessionId: '' };
  const runtime = createMaidToolConfirmationRuntime({ canShowInline: () => true, getCurrentScope: () => emptySession });
  const decision = runtime.request(groupRequest(), options({ sessionId: '' }));
  const pending = runtime.getPendingForRun('run-a');
  assert.equal(runtime.resolveBound({ id: pending.id, runId: pending.runId, binding: emptySession }, 'allow_once'), true);
  assert.deepEqual(await decision, { decision: 'allow' }, 'an explicitly empty session is a valid scope value');
});

test('hidden inline requests reject text until migration preserves their exact identity', async () => {
  let visible = true;
  const modal = deferred();
  const runtime = createMaidToolConfirmationRuntime({ canShowInline: () => visible, choose: () => modal.promise, getCurrentScope: () => binding });
  const decision = runtime.request(groupRequest(), options());
  const pending = runtime.getPendingForRun('run-a');
  visible = false;
  assert.equal(runtime.getPendingForRun('run-a').visible, false);
  assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), false);
  runtime.ensureVisible();
  assert.equal(runtime.getInline('run-a'), null);
  assert.equal(runtime.getPendingForRun('run-a').id, pending.id);
  assert.equal(runtime.getPendingForRun('run-a').visible, true);
  assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), true);
  assert.deepEqual(await decision, { decision: 'allow' });
  modal.resolve('deny');
});

test('ambiguous requests fail closed and only the active modal is text-visible', async () => {
  let sequence = 0;
  const shown = [];
  const runtime = createMaidToolConfirmationRuntime({
    makeId: () => `request-${++sequence}`, getCurrentScope: () => binding,
    choose: args => { const gate = deferred(); shown.push({ args, ...gate }); return gate.promise; },
  });
  const first = runtime.request(groupRequest(), options());
  const old = runtime.getPendingForRun('run-a');
  const second = runtime.request(groupRequest(), options());
  assert.deepEqual(runtime.getPendingForRun('run-a'), { ambiguous: true, runId: 'run-a' });
  assert.equal(runtime.resolveBound(bound(old), 'allow_once'), false);
  shown[0].resolve('deny');
  assert.deepEqual(await first, { decision: 'deny' });
  const current = runtime.getPendingForRun('run-a');
  const third = runtime.request(groupRequest(), options({ runId: 'run-b' }));
  assert.equal(runtime.getPendingForRun('run-a').visible, false);
  assert.equal(runtime.resolveBound(bound(current), 'allow_once'), false);
  runtime.resolve(current.id, 'deny');
  assert.deepEqual(await second, { decision: 'deny' });
  const latest = runtime.getPendingForRun('run-b');
  assert.equal(latest.visible, true, 'settling an older modal must not hide the latest');
  assert.equal(shown[2].args.signal.aborted, false);
  assert.equal(runtime.resolveBound(bound(latest), 'allow_once'), true);
  assert.deepEqual(await third, { decision: 'allow' });
  shown[1].resolve('allow_once'); shown[2].resolve('deny');
});

test('abort, synchronous modal completion, opening errors and reentrant settle leave no phantom approval', async () => {
  for (const kind of ['preabort', 'abort-on-open', 'sync', 'throw', 'missing-choose', 'change-settle']) {
    const controller = new AbortController();
    const modal = deferred();
    let runtime;
    if (kind === 'preabort') controller.abort();
    runtime = createMaidToolConfirmationRuntime({
      getCurrentScope: () => binding,
      choose: kind === 'missing-choose' ? null : () => {
        if (kind === 'abort-on-open') controller.abort();
        if (kind === 'throw') throw new Error('dialog unavailable');
        if (kind === 'sync') return 'allow_once';
        return modal.promise;
      },
      onChange: () => {
        if (kind !== 'change-settle') return;
        const pending = runtime.getPendingForRun('run-a');
        if (pending) runtime.resolveBound(bound(pending), 'deny');
      },
    });
    const decision = runtime.request(groupRequest(), options({ signal: controller.signal }));
    assert.equal(runtime.getPendingCount(), 0, kind);
    assert.equal(runtime.getPendingForRun('run-a'), null, kind);
    assert.deepEqual(await decision, { decision: kind === 'sync' ? 'allow' : 'deny' });
    modal.resolve('allow_once');
  }
  const modal = deferred(), controller = new AbortController();
  const runtime = createMaidToolConfirmationRuntime({ choose: () => modal.promise, getCurrentScope: () => binding });
  const decision = runtime.request(groupRequest(), options({ signal: controller.signal }));
  const pending = runtime.getPendingForRun('run-a');
  controller.abort();
  assert.equal(runtime.resolveBound(bound(pending), 'allow_once'), false);
  assert.deepEqual(await decision, { decision: 'deny' });
  modal.resolve('allow_once'); await tick();
  assert.equal(runtime.getPendingCount(), 0);
});
