import assert from 'node:assert/strict';

const { createUndoableMessageDelete, createPendingUndo } = await import('../../src/scripts/ui/chat/message-delete-undo.js');
const { buildSwipeBranchFromMessage } = await import('../../src/scripts/ui/chat/swipe-ui-utils.js');

// 只实现撤销会用到的 chatStore 行为：按 id 删、在某条后面插回、读原始回复、未读数
const makeChatStore = (messages, { raw = {}, unread = 0 } = {}) => {
  const state = { messages: messages.map(item => ({ ...item })), unread, rawDeleted: [], rawSaved: [], inserted: [], marked: 0 };
  return {
    state,
    getMessages: () => state.messages,
    findMessage: id => state.messages.find(item => item.id === id) || null,
    deleteMessage: (id) => { state.messages = state.messages.filter(item => item.id !== id); state.rawDeleted.push(id); return true; },
    insertMessageAfter: (anchorId, message) => {
      const at = anchorId ? state.messages.findIndex(item => item.id === anchorId) + 1 : state.messages.length;
      state.messages.splice(at, 0, message);
      state.inserted.push([anchorId, message.id]);
      if (message.rawOriginal) state.rawSaved.push([message.id, message.rawOriginal]);
      if (message.role === 'assistant') state.unread += 1;
      return message;
    },
    loadRawOriginal: async message => raw[message.id] || '',
    getUnreadCount: () => state.unread,
    markRead: () => { state.unread = 0; state.marked += 1; },
  };
};

const makeDeps = (chatStore, extra = {}) => {
  const calls = { removed: [], restored: [], variables: 0, rerender: 0, refresh: 0, captured: [], applied: [], aborted: 0, cleared: 0 };
  const deleter = createUndoableMessageDelete({
    chatStore,
    ui: { removeMessage: id => calls.removed.push(['ui', id]), ...extra.ui },
    findMessageWrapper: extra.findMessageWrapper || (() => null),
    isTableMemory: () => true,
    abortMemoryUpdate: () => { calls.aborted += 1; },
    getReplyTarget: () => ({ id: 'a2' }),
    clearReplyTarget: () => { calls.cleared += 1; },
    removeTurnCheckpoints: async (sid, messages, options) => { calls.removed.push(['checkpoint', messages.map(item => item.id).join(','), options.prune]); return true; },
    restoreMemory: async (sid, options) => { calls.restored.push(options.source); return true; },
    restoreVariables: async () => { calls.variables += 1; return true; },
    buildBranchFromMessage: buildSwipeBranchFromMessage,
    captureBranchState: async (sid, branches, index) => { calls.captured.push(index); branches[index].memoryTableSnapshot = { live: true }; },
    rerender: () => { calls.rerender += 1; },
    refresh: () => { calls.refresh += 1; },
  });
  return { deleter, calls };
};

const thread = () => [
  { id: 'u1', role: 'user', content: 'hi' },
  { id: 'a1', role: 'assistant', content: 'first' },
  { id: 'u2', role: 'user', content: 'again' },
  { id: 'a2', role: 'assistant', content: 'second', meta: { memoryTableSnapshot: { rows: 2 } } },
];

{
  // 整条删除：检查点先留着；撤销插回原位、带回原始回复、未读不变、重新恢复记忆与变量
  const chatStore = makeChatStore(thread(), { raw: { a2: 'RAW second' } });
  const { deleter, calls } = makeDeps(chatStore);
  const result = await deleter.deleteReply('s1', { id: 'a2' });
  assert.deepEqual([result.ok, result.kind, result.undoable], [true, 'message', true]);
  assert.deepEqual(chatStore.state.messages.map(item => item.id), ['u1', 'a1', 'u2']);
  assert.deepEqual(calls.removed, [['ui', 'a2']], 'checkpoints stay until the undo window ends');
  assert.deepEqual([calls.restored, calls.variables, calls.aborted, calls.cleared], [['delete_message'], 1, 1, 1]);
  const undone = await result.undo();
  assert.deepEqual(undone, { ok: true });
  assert.deepEqual(chatStore.state.messages.map(item => item.id), ['u1', 'a1', 'u2', 'a2']);
  assert.deepEqual(chatStore.state.inserted, [['u2', 'a2']]);
  assert.deepEqual(chatStore.state.rawSaved, [['a2', 'RAW second']], 'the raw reply is written back');
  assert.deepEqual(chatStore.state.messages.at(-1).meta, { memoryTableSnapshot: { rows: 2 } });
  assert.equal(chatStore.state.unread, 0, 'restoring does not add an unread badge');
  assert.deepEqual(calls.restored, ['delete_message', 'undo_delete_message']);
  assert.equal(calls.rerender, 1);
  await result.commit();
  assert.equal(calls.removed.some(entry => entry[0] === 'checkpoint'), false, 'an undone delete never prunes');
  assert.deepEqual(await result.undo(), { ok: false, reason: 'expired' });
  console.log('ok - whole-message deletes keep checkpoints and put the message, raw reply and state back on undo');
}

{
  // 确定删除：清检查点；尾端变了（发了新消息）就不能撤销
  const chatStore = makeChatStore(thread());
  const { deleter, calls } = makeDeps(chatStore);
  const result = await deleter.deleteReply('s1', { id: 'a2' });
  chatStore.state.messages.push({ id: 'u3', role: 'user', content: 'new' });
  assert.deepEqual(await result.undo(), { ok: false, reason: 'changed' });
  await result.commit();
  assert.deepEqual(calls.removed.at(-1), ['checkpoint', 'a2', true]);
  // 前面没有讯息（又不是唯一一条）：不提供撤销，立刻照常清理
  const lone = makeChatStore([{ id: 'a0', role: 'assistant', content: 'greeting' }, { id: 'u1', role: 'user', content: 'x' }]);
  const loneDeps = makeDeps(lone);
  const first = await loneDeps.deleter.deleteMessage('s1', { id: 'a0' });
  assert.equal(first.undoable, false);
  assert.deepEqual(loneDeps.calls.removed.at(-1), ['checkpoint', 'a0', true]);
  assert.deepEqual(await first.undo(), { ok: false, reason: 'expired' });
  // 唯一一条也能撤销（插回空的对话）
  const only = makeChatStore([{ id: 'a0', role: 'assistant', content: 'only' }]);
  const onlyResult = await makeDeps(only).deleter.deleteMessage('s1', { id: 'a0' });
  assert.equal(onlyResult.undoable, true);
  assert.equal((await onlyResult.undo()).ok, true);
  assert.deepEqual(only.state.messages.map(item => item.id), ['a0']);
  // 长字段只剩预览（没读回全文）：不提供撤销，照常清理；读回了全文则拿掉旧分片引用再插回
  const previewOnly = makeChatStore([{ id: 'u1', role: 'user', content: 'x' }, { id: 'a1', role: 'assistant', content: 'long…', fieldRefs: { content: { fieldId: 'f1', preview: 'long…' } } }]);
  assert.equal((await makeDeps(previewOnly).deleter.deleteMessage('s1', { id: 'a1' })).undoable, false);
  const hydrated = makeChatStore([{ id: 'u1', role: 'user', content: 'x' }, { id: 'a1', role: 'assistant', content: 'long full text', fieldRefs: { content: { fieldId: 'f1', preview: 'long…' } } }]);
  const hydratedResult = await makeDeps(hydrated).deleter.deleteMessage('s1', { id: 'a1' });
  assert.equal(hydratedResult.undoable, true);
  await hydratedResult.undo();
  assert.deepEqual([hydrated.state.messages[1].content, 'fieldRefs' in hydrated.state.messages[1]], ['long full text', false], 'a restored message writes its long fields again');
  console.log('ok - committing prunes checkpoints, and undo is refused once the chat moved on');
}

{
  // 分支删除：先把当前分支（含此刻状态）存成副本；撤销插回原位并切回去
  // 讯息上的正文是预览（长回复的存法），分支里才是全文；分支缺的字段由讯息补
  const message = { id: 'a2', role: 'assistant', content: 'B full te…', raw: 'B raw', meta: { activeSwipe: 1, reasoning: 'why B', swipes: [{ content: 'A' }, { content: 'B full text' }, { content: 'C' }] } };
  const chatStore = makeChatStore([...thread().slice(0, 3), message], { raw: { a2: 'B original' } });
  const live = { id: 'a2', meta: null };
  const wrapper = { __chatappMessage: live };
  const applied = [];
  const { deleter, calls } = makeDeps(chatStore, {
    findMessageWrapper: id => (id === 'a2' ? wrapper : null),
    ui: {
      deleteCurrentSwipe: () => {
        live.meta = { activeSwipe: 1, swipes: [{ content: 'A' }, { content: 'C' }] };
        return { deleted: true, deletedIndex: 1, newIndex: 1, message: live };
      },
      _applySwipe: (target, msg, index) => { applied.push([target === wrapper, index, msg.meta.activeSwipe, msg.meta.swipes.map(branch => branch.content)]); return true; },
    },
  });
  const result = await deleter.deleteReply('s1', { id: 'a2' });
  assert.deepEqual([result.ok, result.kind], [true, 'branch']);
  assert.deepEqual(calls.captured, [1], 'the live state is captured into the branch first');
  const undone = await result.undo();
  assert.equal(undone.ok, true);
  assert.deepEqual(applied, [[true, 1, 2, ['A', 'B full text', 'C']]], 'the stored branch (full text) goes back to its slot and becomes active again');
  const restored = live.meta.swipes[1];
  assert.deepEqual([restored.content, restored.raw, restored.rawOriginal, restored.reasoning, restored.memoryTableSnapshot], ['B full text', 'B raw', 'B original', 'why B', { live: true }]);
  // 分支数变了就不撤销
  const again = await deleter.deleteReply('s1', { id: 'a2' });
  live.meta.swipes.push({ content: 'D' });
  assert.deepEqual(await again.undo(), { ok: false, reason: 'changed' });
  console.log('ok - branch deletes capture the live branch and restore it through the normal swipe switch');
}

{
  // 待撤销只留一个：新的进来先确定旧的；过期确定；撤销失败也确定
  const timers = [];
  const pending = createPendingUndo({ windowMs: 10000, schedule: (fn) => { timers.push(fn); return timers.length; }, cancel: () => {} });
  const log = [];
  const entry = (name, ok = true) => ({ sessionId: 's1', commit: async () => log.push(`commit:${name}`), undo: async () => { log.push(`undo:${name}`); return { ok }; }, onSettled: how => log.push(`${name}:${how}`) });
  await pending.stage(entry('one'));
  assert.equal(pending.hasPending('s1'), true);
  assert.equal(pending.hasPending('s2'), false);
  await pending.stage(entry('two'));
  assert.deepEqual(log, ['commit:one', 'one:committed']);
  assert.deepEqual(await pending.undo(), { ok: true });
  assert.deepEqual(await pending.undo(), { ok: false, reason: 'expired' });
  await pending.stage(entry('three', false));
  await pending.undo();
  await pending.stage(entry('four'));
  timers.at(-1)();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(log.slice(2), ['undo:two', 'two:undone', 'undo:three', 'commit:three', 'three:committed', 'commit:four', 'four:committed']);
  assert.equal(pending.hasPending(), false);
  console.log('ok - only one delete waits for undo; expiry and failed undos commit');
}

console.log('message-delete-undo-tests passed');
