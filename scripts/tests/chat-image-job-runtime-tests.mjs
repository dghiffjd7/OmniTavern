import assert from 'node:assert/strict';
import { createChatImageJobRuntime } from '../../src/scripts/ui/chat/chat-image-job-runtime.js';

const pending = (id, extra = {}) => ({
  id, role: 'assistant', type: 'text', content: `正在生成插图：prompt ${id}`,
  rawOriginal: 'retained original source',
  meta: {
    hideAvatar: true, swipes: [{ content: 'old image failure' }],
    generatedMedia: {
      kind: 'image', status: 'running', surface: 'writing', prompt: `prompt ${id}`,
      sourceMessageId: 'reply-1', negativePrompt: 'negative',
      generationParams: { quality: 'high', imagePromptSnapshot: { positive: 'frozen prompt', negative: 'frozen negative' } },
      ...extra,
    },
  },
});

const fixture = (initial = [], initialContext = 'scope-a/archive-1') => {
  let context = initialContext;
  const rows = new Map(initial.map(message => [`${context}/room/${message.id}`, message]));
  const updates = [];
  const events = [];
  const rowKey = (mid, sid) => `${context}/${sid}/${mid}`;
  const getMessage = (mid, sid = 'room') => rows.get(rowKey(mid, sid)) || null;
  const put = (message, sid = 'room') => rows.set(rowKey(message.id, sid), message);
  const runtime = createChatImageJobRuntime({
    getContextKey: () => context,
    getMessage,
    updateMessage: (mid, patch, sid) => {
      const current = getMessage(mid, sid);
      if (!current) return null;
      const updated = { ...current, ...patch };
      rows.set(rowKey(mid, sid), updated);
      updates.push({ mid, sid, patch });
      return updated;
    },
    onUpdated: (mid, message, sid) => events.push({ mid, message, sid }),
    now: () => 1234,
  });
  return { runtime, rows, updates, events, getMessage, put, setContext: value => { context = value; } };
};

{
  const original = pending('orphan');
  const originalJson = JSON.stringify(original);
  const f = fixture([original]);
  const loaded = JSON.parse(JSON.stringify([original])); // Persisted after a previous process stopped.
  const result = f.runtime.recover(loaded, 'room');
  const next = result[0];
  assert.equal(next.meta.generatedMedia.status, 'interrupted');
  assert.equal(next.content, '插图生成已中断');
  assert.equal(next.meta.generatedMedia.error, '生成连接已中断，可重新生成');
  assert.equal(next.meta.generatedMedia.finishedAt, 1234);
  assert.deepEqual(next.meta.generatedMedia.generationParams, original.meta.generatedMedia.generationParams);
  assert.equal(next.meta.generatedMedia.negativePrompt, original.meta.generatedMedia.negativePrompt);
  assert.equal(next.meta.generatedMedia.prompt, original.meta.generatedMedia.prompt);
  assert.deepEqual(next.meta.swipes, original.meta.swipes);
  assert.equal(next.rawOriginal, original.rawOriginal);
  assert.equal(JSON.stringify(original), originalJson, 'recovery must not mutate caller-owned snapshots');
  assert.equal(f.updates.length, 1);
  assert.equal(f.events.length, 1);
  assert.equal(f.runtime.recover(result, 'room'), result, 'terminal messages do not cause repeated writes');
  assert.equal(f.updates.length, 1);
  console.log('ok - restart recovery persists interruption and retains the original prompt, parameters and metadata');
}

{
  const f = fixture([pending('retry')]);
  const controller = new AbortController();
  const oldLease = f.runtime.register({ sessionId: 'room', messageId: 'retry', controller });
  let abortSawStatus = '';
  controller.signal.addEventListener('abort', () => {
    abortSawStatus = f.getMessage('retry').meta.generatedMedia.status;
    assert.equal(oldLease.isCurrent(), false, 'old completion loses ownership before synchronous abort listeners');
  });
  assert.equal(f.runtime.has('retry', 'room'), true);
  assert.equal(oldLease.isCurrent(), true);
  assert.throws(() => f.runtime.register({ sessionId: 'room', messageId: 'retry', controller: new AbortController() }), /already active/);
  assert.deepEqual(f.runtime.cancel('retry', 'room'), { changed: true, active: true, status: 'cancelled' });
  assert.equal(abortSawStatus, 'cancelled');
  assert.equal(controller.signal.aborted, true);
  assert.equal(f.runtime.has('retry', 'room'), false);
  f.put(pending('retry'));
  const newLease = f.runtime.register({ sessionId: 'room', messageId: 'retry', controller: new AbortController() });
  assert.equal(oldLease.isCurrent(), false);
  assert.equal(oldLease.release(), false, 'late finally cannot delete the retry owner');
  assert.equal(newLease.isCurrent(), true);
  assert.equal(f.runtime.has('retry', 'room'), true);
  assert.equal(newLease.release(), true);
  assert.equal(newLease.release(), false);
  console.log('ok - active cancel saves immediately and a late completion cannot overwrite or unregister a retry');
}

{
  const f = fixture([pending('orphan-cancel')]);
  assert.deepEqual(f.runtime.cancel('orphan-cancel', 'room'), { changed: true, active: false, status: 'cancelled' });
  assert.equal(f.getMessage('orphan-cancel').content, '插图生成已取消');
  assert.equal(f.getMessage('orphan-cancel').meta.generatedMedia.prompt, 'prompt orphan-cancel');
  assert.deepEqual(f.runtime.cancel('orphan-cancel', 'room'), { changed: false, active: false, status: 'cancelled' });
  assert.equal(f.updates.length, 1);
  assert.deepEqual(f.runtime.cancel('missing', 'room'), { changed: false, active: false, status: '' });
  console.log('ok - cancel also terminates persisted orphan jobs and is idempotent');
}

{
  const initial = [
    pending('active'), pending('orphan'), pending('failed', { status: 'failed' }),
    { ...pending('success', { status: 'succeeded', output: { path: 'saved.png' } }), type: 'image', content: '[binary omitted]' },
    pending('cancelled', { status: 'cancelled' }),
    { id: 'text', type: 'text', content: 'ordinary conversation' },
    { ...pending('already-image'), type: 'image', content: 'saved image' },
    pending('other-kind', { kind: 'audio' }),
  ];
  const f = fixture(initial);
  const active = f.runtime.register({ sessionId: 'room', messageId: 'active', controller: new AbortController() });
  const result = f.runtime.recover(initial, 'room');
  assert.equal(result[1].meta.generatedMedia.status, 'interrupted');
  initial.forEach((message, index) => {
    if (index !== 1) assert.equal(result[index], message, 'other batch entries must be preserved');
  });
  assert.equal(active.isCurrent(), true);
  assert.equal(f.updates.length, 1);
  assert.equal(f.runtime.cancel('success', 'room').changed, false);
  assert.equal(f.runtime.cancel('already-image', 'room').changed, false);
  const stale = pending('completed-before-render');
  const complete = { ...stale, type: 'image', content: 'saved.png', meta: {
    ...stale.meta, generatedMedia: { ...stale.meta.generatedMedia, status: 'succeeded' },
  } };
  f.put(complete);
  assert.equal(f.runtime.recover([stale], 'room')[0], complete, 'stale loaded rows must not revive a completed job');
  assert.equal(f.updates.length, 1);
  console.log('ok - partial batches preserve active requests, completed images, failures and unrelated messages');
}

{
  const f = fixture([pending('same-id')]);
  const old = f.runtime.register({ sessionId: 'room', messageId: 'same-id', controller: new AbortController() });
  f.setContext('scope-b/archive-1');
  f.put(pending('same-id'));
  const otherScope = f.runtime.register({ sessionId: 'room', messageId: 'same-id', controller: new AbortController() });
  assert.equal(old.isCurrent(), false);
  assert.equal(otherScope.isCurrent(), true);
  assert.equal(old.release(), true);
  assert.equal(f.runtime.has('same-id', 'room'), true, 'old scope release cannot affect a new scope');
  f.setContext('scope-b/archive-2');
  f.put(pending('same-id'));
  assert.equal(otherScope.isCurrent(), false);
  assert.equal(f.runtime.has('same-id', 'room'), false);
  const recovered = f.runtime.recover([f.getMessage('same-id')], 'room');
  assert.equal(recovered[0].meta.generatedMedia.status, 'interrupted');
  f.setContext('scope-b/archive-1');
  assert.equal(otherScope.isCurrent(), true, 'a still-running job in another archive keeps its own ownership');
  f.rows.delete('scope-b/archive-1/room/same-id');
  assert.equal(otherScope.isCurrent(), false, 'a removed message cannot be recreated by a late completion');
  console.log('ok - scopes and archives isolate owners and deleted messages reject late writes');
}

{
  const f = fixture([pending('external-abort')]);
  const controller = new AbortController();
  const lease = f.runtime.register({ sessionId: 'room', messageId: 'external-abort', controller });
  controller.abort('session_deleted');
  assert.equal(f.runtime.has('external-abort', 'room'), false);
  assert.equal(lease.isCurrent(), true, 'an external abort may still settle its own cancellation');
  const result = f.runtime.recover([f.getMessage('external-abort')], 'room');
  assert.equal(result[0].meta.generatedMedia.status, 'interrupted');
  assert.equal(lease.isCurrent(), false);
  console.log('ok - externally aborted requests do not keep a message indefinitely running');
}

console.log('chat-image-job-runtime-tests passed');
