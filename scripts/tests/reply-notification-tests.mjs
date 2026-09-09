import assert from 'node:assert/strict';
import { createReplyCompletionRuntime, openReplyNotificationRoute } from '../../src/scripts/ui/chat/reply-completion-runtime.js';
import { createReplyNotificationService } from '../../src/scripts/ui/reply-notification-service.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const fixture = () => {
  const notices = [], errors = [];
  let scope = 'persona:p', flushes = 0, sequence = 0;
  const preferences = { supported: true, enabled: true };
  const chatStore = { state: { sessions: { s: { messages: [{ id: 'old', role: 'assistant', content: 'old' }] }, other: { messages: [] } } },
    getCurrentArchiveId: sid => chatStore.state.sessions[sid]?.archive || '',
    getMessages: sid => chatStore.state.sessions[sid]?.messages || [],
    findMessage: (mid, sid) => chatStore.getMessages(sid).find(m => m.id === mid),
    flush: async () => { flushes++; },
  };
  const service = { get: () => preferences, complete: async payload => { notices.push(payload); } };
  const runtime = createReplyCompletionRuntime({ service, chatStore, getPersonaId: () => 'p', getScopeId: () => scope,
    getSessionName: sid => `name:${sid}`, formatBody: name => `done:${name}`, onError: error => errors.push(error), makeId: () => `run-${++sequence}` });
  const add = (id, patch = {}, sid = 's') => chatStore.state.sessions[sid].messages.push({ id, role: 'assistant', content: 'reply', ...patch });
  return { runtime, chatStore, service, preferences, notices, errors, add, setScope: value => { scope = value; }, get flushes() { return flushes; } };
};

test('committed multi-bubble and routed replies notify once, after persistence', async () => {
  const f = fixture(), turn = f.runtime.begin('s'), gate = deferred();
  f.chatStore.flush = () => gate.promise;
  f.add('a'); f.add('b'); f.add('other-a', {}, 'other');
  const done = turn.finish({ refs: [{ targetSessionId: 'other', messageId: 'other-a' }] });
  assert.equal(f.notices.length, 0);
  gate.resolve(); assert.equal(await done, true);
  await turn.finish();
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].route.messageId, 'b');
  assert.equal(f.notices[0].route.scopeId, 'persona:p');
  assert.equal(f.notices[0].body, 'done:name:s');
  assert.equal('content' in f.notices[0], false);
});

test('history, empty replies, greetings, cancelled and failed turns stay silent', async () => {
  for (const scenario of ['history', 'empty', 'greeting', 'cancelled', 'failed', 'agent', 'disabled']) {
    const f = fixture(), turn = f.runtime.begin('s', { eligible: scenario !== 'agent' });
    if (scenario !== 'history') f.add('new', { content: scenario === 'empty' ? '' : 'reply', meta: { isGreeting: scenario === 'greeting' } });
    if (scenario === 'disabled') f.preferences.enabled = false;
    await turn.finish({ cancelled: scenario === 'cancelled', succeeded: scenario !== 'failed' });
    assert.equal(f.notices.length, 0, scenario);
    assert.equal(f.flushes, 0, scenario);
  }
});

test('continuations and committed regenerated branches use the stable message', async () => {
  const f = fixture(), turn = f.runtime.begin('s', { existingMessageId: 'old' });
  f.chatStore.findMessage('old', 's').meta = { activeSwipe: 2, swipes: [{}, {}, { content: 'new branch' }] };
  await turn.finish({ messageId: 'old', allowExisting: true });
  assert.equal(f.notices[0].route.messageId, 'old');
  assert.equal(f.notices[0].route.swipeIndex, 2);
  const emptyContinuation = f.runtime.begin('s', { existingMessageId: 'old' });
  await emptyContinuation.finish({ messageId: 'old', allowExisting: true });
  assert.equal(f.notices.length, 1, 'An empty continuation must not notify using old text');
});

test('scope/archive changes and deletion during persistence suppress stale completion', async () => {
  for (const change of ['scope', 'archive', 'delete']) {
    const f = fixture(), turn = f.runtime.begin('s'), gate = deferred();
    f.add('new'); f.chatStore.flush = () => gate.promise;
    const done = turn.finish();
    if (change === 'scope') f.setScope('persona:other');
    if (change === 'archive') f.chatStore.state.sessions.s.archive = 'other';
    if (change === 'delete') f.chatStore.state.sessions.s.messages = [];
    gate.resolve(); await done;
    assert.equal(f.notices.length, 0, change);
  }
});

test('notification errors are isolated from a successful reply', async () => {
  const f = fixture(), turn = f.runtime.begin('s'); f.add('new');
  f.service.complete = async () => { throw new Error('OS notification error'); };
  assert.equal(await turn.finish(), false);
  assert.equal(f.errors.length, 1);
  assert.equal(f.chatStore.findMessage('new', 's').content, 'reply');
});

test('preferences ignore legacy timing, serialize the switch and retain it on save failure', async () => {
  const calls = []; let fail = false;
  const service = createReplyNotificationService({ invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'reply_notification_settings') return { supported: true, enabled: true, timing: 'minimized' };
    if (fail) throw new Error('disk full');
  } });
  await service.load();
  assert.deepEqual(service.get(), { supported: true, enabled: true });
  await Promise.all([service.configure({ enabled: false }), service.configure({ enabled: true })]);
  assert.deepEqual(service.get(), { supported: true, enabled: true });
  assert.deepEqual(calls.filter(c => c.command === 'reply_notification_configure').map(c => c.args.preferences), [
    { enabled: false }, { enabled: true },
  ]);
  fail = true;
  await assert.rejects(service.configure({ enabled: false }), /disk full/);
  assert.equal(service.get().enabled, true);
  assert.equal(calls.filter(c => c.command === 'reply_notification_settings').length, 1);
});

test('activation handles boot and repeated clicks through one serialized listener', async () => {
  let callback, pending = { messageId: 'boot' }, watched = 0;
  const opened = [];
  const service = createReplyNotificationService({ makeChannel: options => { callback = options.callback; return {}; }, invoke: async command => {
    if (command === 'reply_notification_settings') return { supported: true };
    if (command === 'reply_notification_watch') watched++;
    if (command === 'reply_notification_take_activation') { const value = pending; pending = null; return value; }
  } });
  await service.start({ open: route => opened.push(route.messageId) });
  pending = { messageId: 'running' }; callback(); callback();
  await service.start({ open: route => opened.push(route.messageId) });
  assert.deepEqual(opened, ['boot', 'running']); assert.equal(watched, 1);
});

test('navigation preserves drafts and validates persona, scope, archive and message target', async () => {
  const order = [], route = { personaId: 'p', scopeId: 'persona:p', sessionId: 'rp:p', archiveId: 'saved', messageId: 'm', swipeIndex: 1 };
  let persona = 'q';
  const deps = { chatStore: { getCurrentArchiveId: () => '', getArchives: () => [{ id: 'saved' }] },
    getPersona: id => id === 'p', getPersonaId: () => persona, switchPersona: async id => { order.push('persona'); persona = id; return true; },
    getScopeId: () => `persona:${persona}`, saveDraft: () => order.push('draft'), hasSession: () => true,
    loadArchive: async () => { order.push('archive'); return true; }, setMode: mode => order.push(mode),
    enterRoom: async (sid, mid) => { assert.equal(sid, route.sessionId); assert.equal(mid, 'm'); order.push('room'); return {}; },
    locateMessage: async () => { order.push('locate'); return true; }, selectSwipe: async () => order.push('swipe'),
  };
  assert.equal(await openReplyNotificationRoute(route, deps), true);
  assert.deepEqual(order, ['draft', 'persona', 'archive', 'rp', 'room', 'locate', 'swipe']);
  order.length = 0;
  assert.equal(await openReplyNotificationRoute({ ...route, personaId: 'missing' }, deps), false);
  assert.deepEqual(order, []);
  assert.equal(await openReplyNotificationRoute({ ...route, scopeId: 'wrong' }, deps), false);
  assert.equal(order.includes('room'), false);
});

const filter = process.argv.find(arg => arg.startsWith('--match='))?.slice(8);
const selected = filter ? tests.filter(test => new RegExp(filter).test(test.name)) : tests;
for (const { name, fn } of selected) { await fn(); console.log(`PASS ${name}`); }
console.log(`Reply notifications: ${selected.length} focused groups passed`);
