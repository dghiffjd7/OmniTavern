import assert from 'node:assert/strict';

const memoryStorage = new Map();
globalThis.localStorage = {
  getItem: key => memoryStorage.get(String(key)) ?? null,
  setItem: (key, value) => {
    memoryStorage.set(String(key), String(value));
  },
  removeItem: key => {
    memoryStorage.delete(String(key));
  },
};
globalThis.document = { body: { dataset: {} } };
globalThis.window = globalThis;

const { ChatStore } = await import('../../src/scripts/storage/chat-store.js');

const scopeId = 'memory-fill-counter-test';
const store = new ChatStore({ scopeId });
await store.fullyReady;
store.state = {
  currentId: 'chat:alice',
  globalVariables: {},
  sessions: {},
};
store.currentId = 'chat:alice';
store._ensureSession('chat:alice');

assert.equal(store.getMemoryFillCounter('chat:alice'), 0);
assert.equal(store.setMemoryFillCounter(3, 'chat:alice'), true);
assert.equal(store.getMemoryFillCounter('chat:alice'), 3);
assert.equal(store.setMemoryFillCounter(-2, 'chat:alice'), true);
assert.equal(store.getMemoryFillCounter('chat:alice'), 0);
assert.equal(store.setMemoryFillCounter(2.8, 'chat:alice'), true);
assert.equal(store.getMemoryFillCounter('chat:alice'), 2);
console.log('ok - ChatStore stores a normalized per-session memory fill counter');

assert.equal(store.setMemoryFillCounter(1, 'chat:ghost'), false);
assert.equal(Object.prototype.hasOwnProperty.call(store.state.sessions, 'chat:ghost'), false);
assert.equal(store.getMemoryFillCounter('chat:ghost'), 0);
console.log('ok - ChatStore does not create sessions when writing a memory fill counter');

await store.flush();
const reloaded = new ChatStore({ scopeId });
await reloaded.fullyReady;
assert.equal(reloaded.getMemoryFillCounter('chat:alice'), 2);
console.log('ok - ChatStore memory fill counter survives reload');
