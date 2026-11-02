import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { UserToolStore, USER_TOOL_LIMIT, normalizeToolShortcut, toolShortcutFromEvent, isReservedToolShortcut } = await import('../../src/scripts/storage/user-tool-store.js');
const { BUILTIN_TOOL_ACTIONS, getBuiltinToolAction, normalizeToolParams, describeUserTool, agentToolAction, userToolIconMarkup } = await import('../../src/scripts/ui/tools/user-tool-actions.js');
const { createUserToolRunner, bindUserToolShortcuts } = await import('../../src/scripts/ui/tools/user-tool-runner.js');
const { createBuiltinToolExecutors } = await import('../../src/scripts/ui/tools/user-tool-builtin-executors.js');

const makeStore = async (initial = null) => {
  let saved = initial;
  const store = new UserToolStore({ loadKv: async () => saved, saveKv: async (key, value) => { saved = JSON.parse(JSON.stringify(value)); } });
  await store.load();
  return { store, saved: () => saved };
};
const regen = { source: 'builtin', id: 'reply.regenerate', params: {} };

{
  // 工具：名称与动作必填、版本核对、编辑保持顺序
  const { store, saved } = await makeStore();
  await assert.rejects(store.saveTool({ name: '', action: regen }), /起个名字/);
  await assert.rejects(store.saveTool({ name: 'x', action: { source: 'nope', id: 'a' } }), /选择工具要执行的动作/);
  const first = await store.saveTool({ name: '重来', icon: 'regenerate', action: regen });
  assert.match(first.id, /^tool_[A-Za-z0-9]+$/);
  assert.equal(first.revision, 1);
  const second = await store.saveTool({ name: '删掉', action: { source: 'builtin', id: 'reply.delete' }, direct: true });
  await assert.rejects(store.saveTool({ id: first.id, name: '改名' }, { expectedRevision: 5 }), error => error.code === 'tool_changed');
  const renamed = await store.saveTool({ id: first.id, name: '改名' }, { expectedRevision: 1 });
  assert.deepEqual([renamed.revision, renamed.action.id, renamed.icon], [2, 'reply.regenerate', 'regenerate'], 'unspecified fields are kept');
  assert.deepEqual(store.listTools().map(tool => tool.id), [first.id, second.id], 'editing keeps the order');
  assert.equal(saved().tools.length, 2);
  console.log('ok - user tools validate names and actions, check revisions and keep their order');
}

{
  // 快捷键：必须带修饰键、组合唯一（可改绑）、删工具时绑定一起删；重载后去重
  const { store, saved } = await makeStore();
  const a = await store.saveTool({ name: 'A', action: regen });
  const b = await store.saveTool({ name: 'B', action: regen });
  await assert.rejects(store.setShortcut(a.id, { code: 'KeyR' }), /Ctrl、Alt/);
  const combo = { code: 'KeyR', alt: true, label: 'Alt + R' };
  await store.setShortcut(a.id, combo);
  assert.equal(store.findShortcut(combo).toolId, a.id);
  await assert.rejects(store.setShortcut(b.id, combo), error => error.code === 'tool_binding_taken' && error.conflictToolName === 'A');
  await store.setShortcut(b.id, combo, { replace: true });
  assert.equal(store.findShortcut(combo).toolId, b.id, 'replace moves the shortcut');
  assert.equal(store.listBindings({ toolId: a.id }).length, 0);
  await store.setShortcut(b.id, { code: 'KeyT', ctrl: true });
  assert.equal(store.listBindings({ toolId: b.id }).length, 1, 'a tool keeps one shortcut');
  await store.setShortcut(b.id, null);
  assert.equal(store.listBindings().length, 0);
  // 手势：位置不支持的手势被拒；同位置同手势唯一
  await assert.rejects(store.setGesture(a.id, { position: 'assistant_bubble', gesture: 'long' }), /不支持/);
  await store.setGesture(a.id, { position: 'assistant_bubble', gesture: 'double' });
  await assert.rejects(store.setGesture(b.id, { position: 'assistant_bubble', gesture: 'double' }), error => error.code === 'tool_binding_taken');
  await store.setGesture(a.id, { position: 'send_button', gesture: 'long' });
  assert.equal(store.listBindings({ toolId: a.id }).length, 2, 'a tool can have several gestures');
  await store.setGesture(a.id, { position: 'send_button', gesture: 'long' }, { enabled: false });
  assert.equal(store.findGesture('send_button', 'long'), null);
  await store.removeTool(a.id);
  assert.equal(store.listBindings().length, 0, 'removing a tool removes its bindings');
  // 重载：坏资料与重复绑定被丢弃
  const raw = saved();
  raw.bindings.push({ id: 'bind_dup1', toolId: b.id, kind: 'gesture', gesture: { position: 'user_bubble', gesture: 'double' } }, { id: 'bind_dup2', toolId: b.id, kind: 'gesture', gesture: { position: 'user_bubble', gesture: 'double' } }, { id: 'bind_bad', toolId: 'tool_missing', kind: 'shortcut', shortcut: { code: 'KeyQ', ctrl: true } });
  raw.tools.push({ id: 'oops', name: 'bad' });
  const { store: reloaded } = await makeStore(raw);
  assert.deepEqual([reloaded.listTools().length, reloaded.listBindings().length], [1, 1]);
  assert.equal(normalizeToolShortcut({ code: 'KeyR' }), null);
  assert.deepEqual(toolShortcutFromEvent({ code: 'KeyR', key: 'r', altKey: true }), { code: 'KeyR', ctrl: false, alt: true, meta: false, shift: false, label: 'Alt + R' });
  assert.equal(isReservedToolShortcut({ code: 'KeyC', ctrl: true }), true);
  assert.equal(isReservedToolShortcut({ code: 'KeyC', ctrl: true, alt: true }), false);
  assert.equal(isReservedToolShortcut({ code: 'Enter', alt: true }), true);
  console.log('ok - shortcuts and gestures are unique, replaceable and cleaned up with their tool');
}

{
  const { store } = await makeStore();
  for (let i = 0; i < USER_TOOL_LIMIT; i += 1) await store.saveTool({ name: `t${i}`, action: regen });
  await assert.rejects(store.saveTool({ name: 'more', action: regen }), /上限/);
  console.log('ok - the tool count is capped');
}

{
  // 动作目录与参数
  assert.ok(BUILTIN_TOOL_ACTIONS.every(action => action.source === 'builtin' && action.group && action.title && action.icon));
  const phrase = getBuiltinToolAction('text.phrase');
  assert.deepEqual(normalizeToolParams(phrase, {}), { ok: false, params: {}, error: '请填写「文字」' });
  assert.deepEqual(normalizeToolParams(phrase, { text: '早安', mode: 'bogus', send: 'yes' }), { ok: true, params: { text: '早安', mode: 'insert', send: false } });
  assert.equal(describeUserTool({ action: { params: { text: '今天天气真好呀我们出去走走吧', send: true } } }, phrase), '快捷短语 · 「今天天气真好呀我们出去走走吧」 · 直接发送');
  assert.equal(describeUserTool({ direct: true }, getBuiltinToolAction('reply.delete')), '删除回复 · 直接执行');
  assert.equal(describeUserTool({ action: { params: { panel: 'memory' } } }, getBuiltinToolAction('open.panel')), '打开记忆总览');
  assert.equal(describeUserTool({}, null), '动作不可用');
  const agent = agentToolAction({ id: 'text-edit:polish', title: '润色' }, { isInputAgent: () => false, iconName: 'pen' });
  assert.deepEqual([agent.source, agent.target, agent.group], ['agent', 'assistant', 'agent']);
  assert.match(userToolIconMarkup('trash'), /<svg[\s\S]*M4 7h16/);
  assert.match(userToolIconMarkup('missing'), /m13 2-8 12h7/, 'unknown icons fall back to the bolt');
  console.log('ok - the built-in action catalog normalizes params and describes tools');
}

const makeRunner = async ({ messages, direct = false, actionId = 'reply.delete', confirmAnswer = true, beforeConfirm = null } = {}) => {
  const { store } = await makeStore();
  const tool = await store.saveTool({ name: '工具', action: { source: 'builtin', id: actionId, params: actionId === 'text.phrase' ? { text: 'hi' } : {} }, direct });
  const executed = [];
  const notes = [];
  let sessionId = 's1';
  const runner = createUserToolRunner({
    store,
    resolveAction: (source, id) => (source === 'builtin' ? getBuiltinToolAction(id) : null),
    execute: async (action, context) => { executed.push([action.id, context.message?.id || '']); return { status: 'succeeded' }; },
    getSessionId: () => sessionId,
    findMessage: (sid, id) => (sid === 's1' ? messages.find(message => message.id === id) || null : null),
    findLastMessage: (sid, role) => [...messages].reverse().find(message => message.role === role) || null,
    confirm: async () => { beforeConfirm?.(); return confirmAnswer; },
    notify: note => notes.push(note),
  });
  return { runner, tool, executed, notes, store, setSession: (id) => { sessionId = id; } };
};

{
  // 目标：手势给的消息优先；角色不对拒绝；没给就取最后一条
  const messages = [{ id: 'u1', role: 'user', content: 'hi' }, { id: 'a1', role: 'assistant', content: 'one' }, { id: 'a2', role: 'assistant', content: 'two' }];
  const { runner, tool, executed, notes } = await makeRunner({ messages, direct: true });
  assert.equal((await runner.run(tool.id)).status, 'succeeded');
  assert.equal((await runner.run(tool.id, { messageId: 'a1', trigger: 'gesture' })).status, 'succeeded');
  assert.deepEqual(executed, [['reply.delete', 'a2'], ['reply.delete', 'a1']]);
  const wrongRole = await runner.run(tool.id, { messageId: 'u1' });
  assert.deepEqual([wrongRole.status, wrongRole.message], ['unavailable', '这个工具只能用在 AI 回复上']);
  assert.equal((await runner.run(tool.id, { messageId: 'gone' })).status, 'stale');
  assert.equal(notes.at(-1).toolName, '工具');
  assert.equal((await runner.run('tool_missing')).status, 'unavailable');
  console.log('ok - the runner targets the gestured message or the latest one of the right role');
}

{
  // 删除类：没设直接执行要确认；拒绝不执行；确认期间对象变了就不执行
  const messages = [{ id: 'a1', role: 'assistant', content: 'one', meta: { activeSwipe: 0 } }];
  const denied = await makeRunner({ messages, confirmAnswer: false });
  assert.equal((await denied.runner.run(denied.tool.id)).status, 'cancelled');
  assert.deepEqual(denied.executed, []);
  const confirmed = await makeRunner({ messages: [{ ...messages[0] }] });
  assert.equal((await confirmed.runner.run(confirmed.tool.id)).status, 'succeeded');
  const live = [{ id: 'a1', role: 'assistant', content: 'one', meta: { activeSwipe: 0 } }];
  const racing = await makeRunner({ messages: live, beforeConfirm: () => { live[0].meta.activeSwipe = 1; } });
  const raced = await racing.runner.run(racing.tool.id);
  assert.deepEqual([raced.status, racing.executed.length], ['stale', 0], 'a branch switch during the confirm stops the action');
  const switched = await makeRunner({ messages: [{ id: 'a1', role: 'assistant', content: 'x' }] });
  switched.setSession('');
  assert.equal((await switched.runner.run(switched.tool.id)).message, '先进入一个聊天再用');
  // 非删除类不确认
  const phrase = await makeRunner({ messages: [], actionId: 'text.phrase', confirmAnswer: false });
  assert.equal((await phrase.runner.run(phrase.tool.id)).status, 'succeeded', 'non-destructive actions never ask');
  console.log('ok - destructive tools confirm unless direct, and re-check the target before acting');
}

{
  // 同一工具执行中再次触发：忽略
  const { store } = await makeStore();
  const tool = await store.saveTool({ name: '慢', action: regen });
  let release;
  const runner = createUserToolRunner({
    store,
    resolveAction: (source, id) => getBuiltinToolAction(id),
    execute: () => new Promise((resolve) => { release = () => resolve({ status: 'succeeded' }); }),
    getSessionId: () => 's1',
    findLastMessage: () => ({ id: 'a1', role: 'assistant', content: '' }),
    findMessage: () => ({ id: 'a1', role: 'assistant', content: '' }),
  });
  const first = runner.run(tool.id);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runner.isRunning(tool.id), true);
  assert.equal((await runner.run(tool.id)).reason, 'already_running');
  release();
  assert.equal((await first).status, 'succeeded');
  console.log('ok - a running tool ignores repeated triggers');
}

{
  // 内建执行：接到注入的正式流程
  const calls = [];
  let generating = false;
  const executors = createBuiltinToolExecutors({
    dispatchMessageAction: async (action, message) => { calls.push(['dispatch', action, message?.id]); return true; },
    startInlineEdit: (message) => { calls.push(['edit', message.id]); return true; },
    continueReply: async () => false,
    stopGeneration: () => generating,
    selectSwipe: (sid, id, index) => { calls.push(['swipe', id, index]); return true; },
    insertInput: (text, { mode }) => calls.push(['insert', text, mode]),
    sendInput: () => calls.push(['send']),
    openPanel: id => id === 'memory',
    isGenerating: () => generating,
  });
  const assistant = { id: 'a1', role: 'assistant', meta: { swipes: ['x', 'y', 'z'], activeSwipe: 1 } };
  assert.equal((await executors['reply.swipe_next']({ message: assistant, sessionId: 's' })).status, 'succeeded');
  assert.equal((await executors['reply.swipe_prev']({ message: { ...assistant, meta: { swipes: ['x', 'y'], activeSwipe: 0 } } })).message, '已经是第一个分支');
  assert.equal((await executors['reply.swipe_next']({ message: { id: 'a2', role: 'assistant' } })).message, '这条回复只有一个分支');
  await executors['message.edit']({ message: { id: 'u1', role: 'user' } });
  await executors['message.edit']({ message: assistant });
  await executors['text.phrase']({ params: { text: '早安', mode: 'replace', send: true } });
  assert.equal((await executors['reply.continue']({})).message, '没有可以继续的回复');
  assert.equal((await executors['open.panel']({ params: { panel: 'variables' } })).status, 'unavailable');
  assert.equal((await executors['reply.stop']({})).message, '现在没有在生成');
  generating = true;
  assert.equal((await executors['reply.regenerate']({ message: assistant })).message, '正在生成，结束后再试');
  assert.equal((await executors['text.phrase']({ params: { text: 'x', mode: 'insert', send: true } })).status, 'unavailable', 'sending waits for the current generation');
  assert.equal((await executors['reply.stop']({})).status, 'succeeded');
  assert.deepEqual(calls, [['swipe', 'a1', 2], ['edit', 'u1'], ['dispatch', 'view-code', 'a1'], ['insert', '早安', 'replace'], ['send']]);
  assert.deepEqual(Object.keys(executors).sort(), BUILTIN_TOOL_ACTIONS.map(action => action.id).sort(), 'every built-in action has an executor');
  // 提供可撤销的删除时，删除与撤回走它（不走消息动作分发）
  generating = false;
  const undoable = [];
  const withUndo = createBuiltinToolExecutors({
    dispatchMessageAction: async (action) => { undoable.push(['dispatch', action]); return true; },
    deleteReply: async (sid, message) => { undoable.push(['deleteReply', sid, message.id]); return { status: 'succeeded' }; },
    retractMessage: async (sid, message) => { undoable.push(['retract', sid, message.id]); return { status: 'succeeded' }; },
    isGenerating: () => generating,
  });
  await withUndo['reply.delete']({ message: { id: 'a1' }, sessionId: 's' });
  await withUndo['message.retract']({ message: { id: 'u1' }, sessionId: 's' });
  generating = true;
  assert.equal((await withUndo['reply.delete']({ message: { id: 'a1' }, sessionId: 's' })).status, 'unavailable', 'deleting waits for the current generation');
  assert.deepEqual(undoable, [['deleteReply', 's', 'a1'], ['retract', 's', 'u1']]);
  console.log('ok - built-in executors call the injected app flows and respect generation');
}

{
  // 快捷键：带修饰键才触发；停用时不触发
  const { store } = await makeStore();
  const tool = await store.saveTool({ name: 'A', action: regen });
  await store.setShortcut(tool.id, { code: 'KeyR', alt: true });
  const runs = [];
  let enabled = true;
  const listeners = [];
  const doc = { addEventListener: (type, fn) => listeners.push(fn), removeEventListener() {} };
  bindUserToolShortcuts({ documentRef: doc, store, run: id => runs.push(id), isEnabled: () => enabled });
  const fire = (extra) => { const event = { code: 'KeyR', key: 'r', preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra }; listeners.forEach(fn => fn(event)); return event; };
  assert.equal(fire({ altKey: true }).prevented, true);
  fire({});
  fire({ altKey: true, repeat: true });
  enabled = false;
  fire({ altKey: true });
  assert.deepEqual(runs, [tool.id]);
  console.log('ok - tool shortcuts fire once with a modifier and stay quiet while disabled');
}

console.log('user-tool-core-tests passed');
