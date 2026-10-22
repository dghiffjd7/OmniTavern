import assert from 'node:assert/strict';

class MemoryLocalStorageMock {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
    this.removeCalls = [];
  }

  get length() {
    return this.map.size;
  }

  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }

  getItem(key) {
    return this.map.has(String(key)) ? this.map.get(String(key)) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.removeCalls.push(String(key));
    this.map.delete(String(key));
  }
}

const previousGlobals = {
  localStorage: globalThis.localStorage,
  requestIdleCallback: globalThis.requestIdleCallback,
  tauri: globalThis.__TAURI__,
  tauriInvoke: globalThis.__TAURI_INVOKE__,
  tauriInternals: globalThis.__TAURI_INTERNALS__,
};

const installWeb = (storage = new MemoryLocalStorageMock()) => {
  globalThis.localStorage = storage;
  globalThis.requestIdleCallback = () => 0;
  delete globalThis.__TAURI__;
  delete globalThis.__TAURI_INVOKE__;
  delete globalThis.__TAURI_INTERNALS__;
  return storage;
};

const installTauri = (invoke, storage = new MemoryLocalStorageMock()) => {
  installWeb(storage);
  globalThis.__TAURI_INTERNALS__ = { invoke };
  return storage;
};

const makeState = (sessionId, label, { large = false } = {}) => ({
  version: 1,
  sessionId,
  updatedAt: 10,
  baselineSnapshotId: '',
  baselineCapturedAt: 0,
  pointer: {
    version: 1,
    sessionId,
    tailAssistantMessageId: `assistant-${label}`,
    tailSwipeIndex: 0,
    restoredAt: 10,
    source: 'test',
  },
  archivePointers: {},
  checkpoints: {
    [`assistant-${label}`]: {
      version: 1,
      sessionId,
      assistantMessageId: `assistant-${label}`,
      userMessageId: `user-${label}`,
      turnIndex: 1,
      aiFloor: 1,
      createdAt: 10,
      updatedAt: 10,
      deletedAt: 0,
      activeSwipeIndex: 0,
      state: 'final',
      branches: [{
        version: 1,
        swipeIndex: 0,
        messageContent: large ? 'x'.repeat(80_000) : label,
        messageRaw: '',
        memorySnapshotId: '',
        variableSnapshotId: '',
        memorySnapshotHash: '',
        variableSnapshotHash: '',
        checkpointState: 'final',
        replyState: 'complete',
        createdAt: 10,
      }],
    },
  },
});

const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

try {
  installWeb();
  const {
    TurnCheckpointStore,
    buildTurnCheckpointStoreKey,
    migrateTurnCheckpointLocalMirrors,
  } = await import('../../src/scripts/storage/turn-checkpoint-store.js');

  {
    const scopeId = 'persona:verified';
    const sessionId = 'session-verified';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const staleLocal = makeState(sessionId, 'stale');
    staleLocal.updatedAt = 5;
    const storage = installTauri(async (cmd) => {
      if (cmd === 'load_kv') return makeState(sessionId, 'disk');
      return true;
    }, new MemoryLocalStorageMock({ [key]: JSON.stringify(staleLocal) }));
    const store = new TurnCheckpointStore({ scopeId });
    const state = await store.getSessionState(sessionId);

    assert.equal(state.pointer.tailAssistantMessageId, 'assistant-disk');
    assert.equal(storage.map.has(key), false);
    console.log('ok - verified turn checkpoints hydrate from KV and remove the local mirror');
  }

  {
    const scopeId = 'persona:backfill';
    const sessionId = 'session-backfill';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const localState = makeState(sessionId, 'local', { large: true });
    const calls = [];
    const storage = installTauri(async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') return {};
      if (cmd === 'save_kv') return true;
      return null;
    }, new MemoryLocalStorageMock({ [key]: JSON.stringify(localState) }));
    const store = new TurnCheckpointStore({ scopeId });
    const state = await store.getSessionState(sessionId);

    assert.equal(state.pointer.tailAssistantMessageId, 'assistant-local');
    assert.equal(calls.some(([cmd, args]) => cmd === 'save_kv' && args.name === key), true);
    assert.equal(storage.map.has(key), false);
    console.log('ok - oversized legacy checkpoints backfill missing KV before local removal');
  }

  {
    const scopeId = 'persona:persist';
    const sessionId = 'session-persist';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const storage = installTauri(async (cmd) => {
      if (cmd === 'load_kv') return {};
      if (cmd === 'save_kv') return true;
      return null;
    });
    const store = new TurnCheckpointStore({ scopeId });
    await store.upsertCheckpoint(sessionId, makeState(sessionId, 'new').checkpoints['assistant-new']);

    assert.equal(storage.map.has(key), false);
    console.log('ok - Tauri turn checkpoint writes stay KV-only');
  }

  {
    const scopeId = 'persona:fallback';
    const sessionId = 'session-fallback';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const storage = installTauri(async (cmd) => {
      if (cmd === 'load_kv') return {};
      if (cmd === 'save_kv') throw new Error('disk unavailable');
      return null;
    });
    const store = new TurnCheckpointStore({ scopeId });
    await store.upsertCheckpoint(sessionId, makeState(sessionId, 'fallback', { large: true }).checkpoints['assistant-fallback']);

    assert.equal(storage.map.has(key), true);
    assert.equal(String(storage.map.get(key)).length > 64_000, true, 'emergency fallback must preserve oversized state');
    console.log('ok - failed turn checkpoint KV writes retain an emergency local fallback');
  }

  {
    const scopeId = 'persona:unreadable';
    const sessionId = 'session-unreadable';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const calls = [];
    installTauri(async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') throw new Error('disk unreadable');
      if (cmd === 'save_kv') throw new Error('must remain blocked');
      return null;
    }, new MemoryLocalStorageMock({ [key]: JSON.stringify(makeState(sessionId, 'local')) }));
    const store = new TurnCheckpointStore({ scopeId });
    const state = await store.getSessionState(sessionId);

    assert.equal(state.pointer.tailAssistantMessageId, 'assistant-local');
    await assert.rejects(
      store.upsertCheckpoint(sessionId, makeState(sessionId, 'new').checkpoints['assistant-new']),
      error => error?.code === 'turn_checkpoint_store_read_unavailable',
    );
    assert.equal(calls.some(([cmd]) => cmd === 'save_kv'), false);
    console.log('ok - unreadable turn checkpoint KV remains read-only instead of accepting an empty overwrite');
  }

  {
    // 超过 load_kv 上限：原生端修不了（旧版没有这个命令、或失败）时照旧挡住写入，并能查到被挡住。
    const scopeId = 'persona:oversized';
    const sessionId = 'session-oversized';
    const calls = [];
    installTauri(async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'load_kv') return { _tooLarge: true, size: 32_873_620 };
      if (cmd === 'compact_oversized_turn_checkpoint') throw new Error('command not found');
      if (cmd === 'save_kv') throw new Error('must remain blocked');
      return null;
    });
    const store = new TurnCheckpointStore({ scopeId });
    const state = await store.getSessionState(sessionId);

    assert.deepEqual(state.checkpoints, {});
    assert.equal(store.isPersistenceBlocked(sessionId), true);
    await assert.rejects(
      store.setPointer(sessionId, { sessionId, tailAssistantMessageId: 'assistant-x' }),
      error => error?.code === 'turn_checkpoint_store_read_unavailable',
    );
    assert.equal(calls.includes('save_kv'), false);

    installTauri(async cmd => (cmd === 'load_kv' ? makeState('session-ok', 'ok') : null));
    const readable = new TurnCheckpointStore({ scopeId: 'persona:readable' });
    await readable.getSessionState('session-ok');
    assert.equal(readable.isPersistenceBlocked('session-ok'), false);
    console.log('ok - oversized turn checkpoint KV stays blocked and reports it when native compaction is unavailable');
  }

  {
    // 超过上限：原生端备份后去掉请求提示词与原始输出，重新读取就能照常使用。
    const scopeId = 'persona:compact-oversized';
    const sessionId = 'session-compact-oversized';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const calls = [];
    let compacted = false;
    installTauri(async (cmd, args) => {
      calls.push(cmd);
      if (cmd === 'load_kv') return compacted ? makeState(sessionId, 'slim') : { _tooLarge: true, size: 32_873_620 };
      if (cmd === 'compact_oversized_turn_checkpoint') {
        assert.equal(args?.name, key);
        compacted = true;
        return { compacted: true, before: 32_873_620, after: 9_000_000 };
      }
      return null;
    });
    const store = new TurnCheckpointStore({ scopeId });
    const state = await store.getSessionState(sessionId);

    assert.deepEqual(calls.slice(0, 3), ['load_kv', 'compact_oversized_turn_checkpoint', 'load_kv']);
    assert.equal(state.pointer.tailAssistantMessageId, 'assistant-slim');
    assert.equal(store.isPersistenceBlocked(sessionId), false);
    await store.setPointer(sessionId, { sessionId, tailAssistantMessageId: 'assistant-slim' });
    assert.equal(calls.includes('save_kv'), true);
    console.log('ok - oversized turn checkpoint KV is compacted natively, then loads and accepts writes');
  }

  {
    // 检查点一律不带缩进写入；原生端拒绝写入超过读取上限的文件时，去掉除还原目标外的写表记录后重写一次。
    const scopeId = 'persona:too-large';
    const sessionId = 'session-too-large';
    const saves = [];
    let rejectSaves = 0;
    installTauri(async (cmd, args) => {
      if (cmd === 'load_kv') return {};
      if (cmd === 'save_kv') {
        saves.push(JSON.parse(JSON.stringify(args)));
        if (rejectSaves > 0) {
          rejectSaves -= 1;
          throw 'kv_too_large:31457281';
        }
      }
      return null;
    });
    const store = new TurnCheckpointStore({ scopeId });
    const entry = { actions: [{ action: 'insert' }], rollback: { tables: [] } };
    const upsert = id => store.upsertCheckpoint(sessionId, {
      sessionId,
      assistantMessageId: id,
      aiFloor: Number(id.split('-')[1]),
      branches: [{ swipeIndex: 0, memorySnapshotId: `mem_${id}`, memoryUpdateEntry: entry }],
    });
    await upsert('asst-1');
    await store.setPointer(sessionId, { sessionId, tailAssistantMessageId: 'asst-1' });
    await upsert('asst-2');
    rejectSaves = 1;
    await upsert('asst-3');

    assert.equal(saves.every(args => args.compact === true), true, 'checkpoint writes skip indentation');
    const written = saves[saves.length - 1].data.checkpoints;
    assert.equal(saves.length, 5, 'one rejected write is retried once');
    assert.equal(written['asst-2'].branches[0].memoryUpdateEntry, null);
    assert.equal(written['asst-3'].branches[0].memoryUpdateEntry, null);
    assert.equal(written['asst-3'].branches[0].memorySnapshotId, 'mem_asst-3');
    assert.deepEqual(written['asst-1'].branches[0].memoryUpdateEntry.actions, entry.actions, 'restore target keeps its write record');

    rejectSaves = 2;
    await upsert('asst-4');
    assert.equal(saves.length, 7, 'a write still too large after slimming is given up without throwing');
    console.log('ok - checkpoint writes are compact and shrink to fit when the native side refuses an oversized file');
  }

  {
    // 回归：同一会话两处同时读取，另一处刚修好时原生端回「已不超限」，这里也要重新读取，不能当成修不了而挡住写入。
    const scopeId = 'persona:compacted-elsewhere';
    const sessionId = 'session-compacted-elsewhere';
    let loads = 0;
    installTauri(async cmd => {
      if (cmd === 'load_kv') {
        loads += 1;
        return loads === 1 ? { _tooLarge: true, size: 32_873_620 } : makeState(sessionId, 'slim');
      }
      if (cmd === 'compact_oversized_turn_checkpoint') return { compacted: false, reason: 'not_oversized', size: 9_000_000 };
      return null;
    });
    const store = new TurnCheckpointStore({ scopeId });
    const state = await store.getSessionState(sessionId);

    assert.equal(loads, 2);
    assert.equal(state.pointer.tailAssistantMessageId, 'assistant-slim');
    assert.equal(store.isPersistenceBlocked(sessionId), false);
    console.log('ok - oversized turn checkpoint already compacted by another reader is reloaded instead of blocked');
  }

  {
    const scopeId = 'persona:unreadable-clear';
    const sessionId = 'session-unreadable-clear';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const calls = [];
    const storage = installTauri(async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv') throw new Error('disk unreadable');
      if (cmd === 'save_kv') throw new Error('save_kv must remain blocked');
      return null;
    }, new MemoryLocalStorageMock({ [key]: JSON.stringify(makeState(sessionId, 'local')) }));
    const store = new TurnCheckpointStore({ scopeId });

    await assert.rejects(
      store.clearSession(sessionId),
      error => error?.code === 'turn_checkpoint_store_read_unavailable',
    );
    assert.equal(calls.some(([cmd]) => cmd === 'save_kv'), false);
    assert.equal(storage.map.has(key), true, 'blocked clear must preserve the recovery mirror');
    console.log('ok - clearSession cannot bypass an unreadable checkpoint store');
  }

  {
    const scopeId = 'persona:unreadable-rename';
    const from = 'session-unreadable-from';
    const to = 'session-unreadable-to';
    const fromKey = buildTurnCheckpointStoreKey(scopeId, from);
    const toKey = buildTurnCheckpointStoreKey(scopeId, to);
    const calls = [];
    const storage = installTauri(async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'load_kv' && args.name === fromKey) throw new Error('source unreadable');
      if (cmd === 'load_kv' && args.name === toKey) return {};
      if (cmd === 'save_kv') throw new Error('save_kv must remain blocked');
      return null;
    }, new MemoryLocalStorageMock({ [fromKey]: JSON.stringify(makeState(from, 'local')) }));
    const store = new TurnCheckpointStore({ scopeId });

    await assert.rejects(
      store.renameSession(from, to),
      error => error?.code === 'turn_checkpoint_store_read_unavailable',
    );
    assert.equal(calls.some(([cmd]) => cmd === 'save_kv'), false);
    assert.equal(storage.map.has(fromKey), true, 'blocked rename must preserve its source recovery mirror');
    assert.equal(storage.map.has(toKey), false, 'blocked rename must not create an empty destination');
    console.log('ok - renameSession cannot bypass an unreadable checkpoint source');
  }

  {
    const sameSession = 'session-same';
    const missingSession = 'session-missing';
    const conflictSession = 'session-conflict';
    const sameKey = buildTurnCheckpointStoreKey('scope', sameSession);
    const missingKey = buildTurnCheckpointStoreKey('scope', missingSession);
    const conflictKey = buildTurnCheckpointStoreKey('scope', conflictSession);
    const same = makeState(sameSession, 'same');
    const missing = makeState(missingSession, 'missing');
    const conflict = makeState(conflictSession, 'local');
    const storage = installTauri(async (cmd, args) => {
      if (cmd === 'load_kv' && args.name === sameKey) return same;
      if (cmd === 'load_kv' && args.name === missingKey) return {};
      if (cmd === 'load_kv' && args.name === conflictKey) return makeState(conflictSession, 'disk');
      if (cmd === 'save_kv' && args.name === missingKey) return true;
      throw new Error(`unexpected ${cmd}:${args.name}`);
    }, new MemoryLocalStorageMock({
      [sameKey]: JSON.stringify(same),
      [missingKey]: JSON.stringify(missing),
      [conflictKey]: JSON.stringify(conflict),
    }));

    const result = await migrateTurnCheckpointLocalMirrors();

    assert.deepEqual(result, {
      scanned: 3,
      removed: 2,
      backfilled: 1,
      retained: 1,
    });
    assert.equal(storage.map.has(sameKey), false);
    assert.equal(storage.map.has(missingKey), false);
    assert.equal(storage.map.has(conflictKey), true);
    console.log('ok - bulk turn checkpoint migration removes only verified mirrors');
  }

  {
    const scopeId = 'web';
    const sessionId = 'session-web';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    const storage = installWeb();
    const store = new TurnCheckpointStore({ scopeId });
    await store.upsertCheckpoint(sessionId, makeState(sessionId, 'web').checkpoints['assistant-web']);

    assert.equal(storage.map.has(key), true);
    console.log('ok - browser-only turn checkpoints retain localStorage availability');
  }
  await flushMicrotasks();
} finally {
  if (previousGlobals.localStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = previousGlobals.localStorage;
  if (previousGlobals.requestIdleCallback === undefined) delete globalThis.requestIdleCallback;
  else globalThis.requestIdleCallback = previousGlobals.requestIdleCallback;
  if (previousGlobals.tauri === undefined) delete globalThis.__TAURI__;
  else globalThis.__TAURI__ = previousGlobals.tauri;
  if (previousGlobals.tauriInvoke === undefined) delete globalThis.__TAURI_INVOKE__;
  else globalThis.__TAURI_INVOKE__ = previousGlobals.tauriInvoke;
  if (previousGlobals.tauriInternals === undefined) delete globalThis.__TAURI_INTERNALS__;
  else globalThis.__TAURI_INTERNALS__ = previousGlobals.tauriInternals;
}
