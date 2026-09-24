import assert from 'node:assert/strict';

import {
  createMessageDisplayDepthResolver,
  resolveBatchRelativeDepths,
} from '../../src/scripts/ui/chat/message-display-depth-utils.js';

// 显示深度按整个会话计算：0 = 最新一条对话消息，只数 user / assistant

const makeSession = (count) => Array.from({ length: count }, (_, i) => ({
  id: `m${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
}));

{
  const sessions = { s1: makeSession(10) };
  sessions.s1.splice(4, 0, { id: 'sys', role: 'system' });
  const resolver = createMessageDisplayDepthResolver({ getSessionMessages: sid => sessions[sid] || [] });
  const all = sessions.s1;

  // 尾部整段：与旧算法一致
  const tail = all.slice(-4);
  assert.deepEqual(resolver.resolveDepths('s1', tail), resolveBatchRelativeDepths(tail));
  assert.deepEqual(resolver.resolveDepths('s1', tail), [3, 2, 1, 0]);

  // 往上翻/进房补齐的旧片段：按整个会话计算，而不是从 0 数
  const olderChunk = all.slice(0, 4);
  assert.deepEqual(resolveBatchRelativeDepths(olderChunk), [3, 2, 1, 0], '旧算法：旧片段被当成最新几条');
  assert.deepEqual(resolver.resolveDepths('s1', olderChunk), [9, 8, 7, 6]);

  // 系统消息不计入深度，也没有深度
  assert.deepEqual(resolver.resolveDepths('s1', all.slice(3, 6)), [6, undefined, 5]);

  // 单独重绘一条旧消息（副本、带额外字段）
  assert.deepEqual(resolver.resolveDepths('s1', [{ ...all[2], sessionId: 's1' }]), [7]);
  console.log('ok - depth is measured against the whole session, not the rendered batch');
}

{
  const sessions = { s1: makeSession(3) };
  const resolver = createMessageDisplayDepthResolver({ getSessionMessages: sid => sessions[sid] || [] });
  assert.deepEqual(resolver.resolveDepths('s1', [sessions.s1[0]]), [2]);
  sessions.s1.push({ id: 'm3', role: 'user' }, { id: 'm4', role: 'assistant' });
  assert.deepEqual(resolver.resolveDepths('s1', [sessions.s1[0]]), [4], '追加新消息后深度随之增加');
  sessions.s1.splice(1, 1);
  assert.deepEqual(resolver.resolveDepths('s1', [sessions.s1[0]]), [3], '删除消息后重建');
  // 同一数组被原地替换中间一条（条数与末条不变）：未命中时重建一次
  sessions.s1[1] = { id: 'replaced', role: 'assistant' };
  assert.deepEqual(resolver.resolveDepths('s1', [sessions.s1[1]]), [2]);
  console.log('ok - depth index rebuilds when the session list changes');
}

{
  const messages = makeSession(3);
  const resolver = createMessageDisplayDepthResolver({ getSessionMessages: () => messages });
  assert.deepEqual(resolver.resolveDepths('s1', messages), [2, 1, 0]);
  messages[2] = { ...messages[2], role: 'system' };
  assert.deepEqual(resolver.resolveDepths('s1', [messages[0], messages[1]]), [1, 0], 'role changes outside the rendered batch invalidate depths');
  messages[2].role = 'assistant';
  assert.deepEqual(resolver.resolveDepths('s1', [messages[0]]), [2], 'in-place role edits are also detected');
  [messages[0], messages[1]] = [messages[1], messages[0]];
  assert.deepEqual(resolver.resolveDepths('s1', messages), [2, 1, 0], 'reordering with an unchanged tail invalidates the index');
  console.log('ok - mutable message sources detect role and order changes');
}

{
  const saved = { localStorage: globalThis.localStorage, document: globalThis.document, window: globalThis.window, setTimeout: globalThis.setTimeout };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.document = { body: { dataset: {} } };
  globalThis.window = globalThis;
  globalThis.setTimeout = () => 0;
  try {
    const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');
    const store = new ChatStore({ scopeId: 'display-depth-regression' });
    await store.fullyReady;
    store._persist = () => {};
    store.appendMessage({ id: 'older', role: 'assistant', raw: '正文' }, 's1');
    store.appendMessage({ id: 'last', role: 'user', raw: '提问' }, 's1');
    const resolver = createMessageDisplayDepthResolver({
      getSessionMessages: sid => store.getMessages(sid),
      getSessionRevision: sid => store.getMessageStructureRevision?.(sid),
    });
    const renderOlder = () => resolver.resolveDepths('s1', [store.getMessages('s1')[0]]);
    assert.deepEqual(renderOlder(), [1]);
    store.updateMessage('last', { role: 'system' }, 's1');
    assert.deepEqual(renderOlder(), [0], 'ChatStore role updates invalidate the display cache');
    const revision = store.getMessageStructureRevision('s1');
    store.updateMessage('older', { raw: '流式正文更新' }, 's1');
    assert.equal(store.getMessageStructureRevision('s1'), revision, 'text-only updates keep the structure revision');
    assert.deepEqual(renderOlder(), [0]);
    store.updateMessage('last', { role: 'user' }, 's1');
    assert.deepEqual(renderOlder(), [1]);
    console.log('ok - ChatStore role updates invalidate depths without invalidating on text updates');
  } finally {
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    });
  }
}

{
  const sessions = { s1: makeSession(4) };
  const resolver = createMessageDisplayDepthResolver({ getSessionMessages: sid => sessions[sid] || [] });
  // 流式占位等尚未入库的消息：沿用按批计算
  assert.deepEqual(resolver.resolveDepths('s1', [{ id: 'draft', role: 'assistant' }]), [0]);
  assert.deepEqual(resolver.resolveDepths('s1', [{ role: 'assistant' }, { role: 'user' }]), [1, 0], '没有 id 的消息按批计算');
  assert.deepEqual(resolver.resolveDepths('other', sessions.s1.slice(0, 2)), [1, 0], '会话列表为空时按批计算');
  assert.deepEqual(resolver.resolveDepths('', sessions.s1.slice(0, 2)), [1, 0]);
  console.log('ok - messages outside the session list keep batch-relative depth');
}
