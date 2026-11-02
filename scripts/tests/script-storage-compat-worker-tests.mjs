import assert from 'node:assert/strict';
import vm from 'node:vm';

// 酒馆助手相容：Worker 里的 localStorage 持久化、chatMetadata／saveMetadata、chatId／name1、prompt／confirm
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || globalThis;
const { buildScriptRuntimeWorkerSourceForTests } = await import('../../src/scripts/plugins/script-runtime.js');

const createWorker = ({ rpc = null } = {}) => {
  const messages = [];
  const sandbox = {
    console, structuredClone: globalThis.structuredClone, setTimeout, clearTimeout, queueMicrotask,
    Date, Math, JSON, RegExp, Error, TypeError, Promise, Map, WeakMap, Set, Array, Object, String, Number, Boolean,
    URL, AbortController, Response, ReadableStream, TextEncoder, TextDecoder,
    postMessage: (msg) => {
      messages.push(msg);
      if (msg?.type !== 'rpc') return;
      const result = msg.method === 'chat.getMessages' || msg.method === 'regex.getCharacter' ? [] : rpc?.(msg);
      queueMicrotask(() => sandbox.self.onmessage({ data: { type: 'rpc_result', id: msg.id, result: result === undefined ? true : result } }));
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(buildScriptRuntimeWorkerSourceForTests(), sandbox, { filename: 'script-runtime-worker.js' });
  const rpcCalls = method => messages.filter(msg => msg.type === 'rpc' && msg.method === method).map(msg => JSON.parse(JSON.stringify(msg.params)));
  const sync = (context, scripts = [], extra = {}) => sandbox.self.onmessage({ data: { type: 'sync', context, scripts, ...extra } });
  const setContext = context => sandbox.self.onmessage({ data: { type: 'context', context } });
  return { sandbox, messages, rpcCalls, sync, setContext };
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const metadataContext = (sessionId, key, data) => ({ sessionId, chatMetadataSessionId: sessionId, chatMetadataKey: key, chat_metadata: data });

{
  // localStorage：sync 带来已存的资料；写入合并成一批送主线程；超过上限丢 QuotaExceededError
  const { sandbox, rpcCalls, sync } = createWorker();
  await sync({ sessionId: 's1' }, [], { localStorage: { kept: 'yes' } });
  const ls = sandbox.localStorage;
  assert.equal(ls.getItem('kept'), 'yes');
  ls.setItem('a', 1);
  ls.setItem('b', 'two');
  ls.removeItem('kept');
  await wait(260);
  assert.deepEqual(rpcCalls('storage.local.write'), [{ clear: false, set: { a: '1', b: 'two' }, remove: ['kept'] }]);
  assert.throws(() => ls.setItem('huge', 'x'.repeat(5000000)), error => error.name === 'QuotaExceededError');
  assert.equal(ls.getItem('huge'), null);
  ls.clear();
  ls.setItem('c', '3');
  await wait(260);
  assert.deepEqual(rpcCalls('storage.local.write').at(-1), { clear: true, set: { c: '3' }, remove: [] });
  // 之后的 sync 不带 localStorage：Worker 的副本不被覆盖
  await sync({ sessionId: 's1' }, []);
  assert.equal(ls.getItem('c'), '3');
  console.log('ok - worker localStorage is seeded once, batches writes and enforces the quota');
}

{
  // chatMetadata：主线程送来的资料就是 ctx.chatMetadata（与 chat_metadata 同一个物件）；saveMetadata 只存这个会话、不带 world_info
  const { sandbox, rpcCalls, sync } = createWorker({ rpc: msg => (msg.method === 'chat.metadata.save' ? { key: 'k1' } : undefined) });
  const script = `
    const ctx = SillyTavern.getContext();
    globalThis.__seen = { chatId: ctx.chatId, name1: ctx.name1, same: ctx.chatMetadata === ctx.chat_metadata, a: ctx.chatMetadata.a };
    ctx.chatMetadata.b = 2;
    globalThis.__saved = ctx.saveMetadata();
  `;
  await sync({ ...metadataContext('s1', 'k1', { a: 1 }), userName: '阿青' }, [{ id: 'm', enabled: true, content: script }]);
  await sandbox.__saved;
  assert.deepEqual({ ...sandbox.__seen }, { chatId: 's1', name1: '阿青', same: true, a: 1 });
  assert.deepEqual(rpcCalls('chat.metadata.save'), [{ sessionId: 's1', data: { a: 1, b: 2 } }]);
  assert.equal(sandbox.SillyTavern.getContext().chatMetadata.b, 2, 'later reads see the same object');
  console.log('ok - chatMetadata, chatId and name1 follow SillyTavern and saveMetadata stores the session copy');
}

{
  // 主线程还没送来资料的会话：读到空物件、不保存（免得盖掉已存的资料）；同 key 再送来不覆盖 Worker 的副本，换 key 才重来
  const { sandbox, rpcCalls, sync, setContext } = createWorker();
  await sync(metadataContext('s1', 'k1', { a: 1 }));
  const st = sandbox.SillyTavern;
  await setContext({ sessionId: 's2' });
  assert.deepEqual({ ...st.getContext().chatMetadata, world_info: undefined }, { world_info: undefined });
  assert.equal(await st.getContext().saveMetadata(), false);
  assert.equal(rpcCalls('chat.metadata.save').length, 0);
  await setContext({ sessionId: 's1' });
  st.getContext().chatMetadata.edited = true;
  await setContext(metadataContext('s1', 'k1', { a: 1 }));
  assert.equal(st.getContext().chatMetadata.edited, true, 'the same data is not replaced');
  await setContext(metadataContext('s1', 'k2', { fresh: true }));
  assert.equal(st.getContext().chatMetadata.edited, undefined, 'a different key means a different chat');
  assert.equal(st.getContext().chatMetadata.fresh, true);
  console.log('ok - chatMetadata waits for its session data and only reseeds for a different chat');
}

{
  // saveMetadataDebounced：之间切到别的会话，到时间仍各存各的
  const { sandbox, rpcCalls, sync, setContext } = createWorker();
  await sync(metadataContext('s1', 'k1', { who: 's1' }));
  sandbox.SillyTavern.getContext().saveMetadataDebounced();
  await setContext(metadataContext('s2', 'k2', { who: 's2' }));
  await wait(1100);
  assert.deepEqual(rpcCalls('chat.metadata.save'), [{ sessionId: 's1', data: { who: 's1' } }]);
  console.log('ok - debounced metadata saves keep the session they were made in');
}

{
  // prompt／confirm：Worker 不能同步弹窗，当作取消并提示一次
  const { sandbox, rpcCalls, sync } = createWorker();
  await sync({ sessionId: 's1' });
  assert.equal(sandbox.window.prompt('名字？'), null);
  assert.equal(sandbox.top.prompt('再一次'), null);
  assert.equal(sandbox.window.confirm('确定？'), false);
  await wait(0);
  assert.deepEqual(rpcCalls('ui.dialogUnsupported'), [{ kind: 'prompt' }, { kind: 'confirm' }], 'one notice each, translated by the main thread');
  console.log('ok - prompt and confirm cancel safely with a one-time notice');
}

console.log('script-storage-compat-worker-tests passed');
