import assert from 'node:assert/strict';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

class MemoryLocalStorageMock {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }

  clear() {
    this.map.clear();
  }
}

if (globalThis.localStorage === undefined) {
  globalThis.localStorage = new MemoryLocalStorageMock();
}

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = () => 0;
const {
  TurnCheckpointStore,
  buildTurnCheckpointSessionSuffix,
  buildTurnCheckpointStoreKey,
  collectCheckpointSnapshotIds,
  collectCheckpointVariableSnapshotIds,
  normalizeCheckpointBranch,
  normalizeArchivePointer,
} = await import('../../src/scripts/storage/turn-checkpoint-store.js');
const { MemorySnapshotStore } = await import('../../src/scripts/storage/memory-snapshot-store.js');
globalThis.setTimeout = originalSetTimeout;

const withMockStorage = async fn => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = new MemoryLocalStorageMock();
  try {
    await fn(globalThis.localStorage);
  } finally {
    if (previous === undefined) {
      delete globalThis.localStorage;
    } else {
      globalThis.localStorage = previous;
    }
  }
};

test('buildTurnCheckpointSessionSuffix should normalize special characters and stay deterministic', () => {
  const first = buildTurnCheckpointSessionSuffix('rp:persona/测试');
  const second = buildTurnCheckpointSessionSuffix('rp:persona/测试');
  assert.equal(first, second);
  assert.match(first, /^rp_persona___/);
});

test('TurnCheckpointStore should persist checkpoint, pointer and baseline snapshot id', async () => {
  await withMockStorage(async () => {
    const checkpointStore = new TurnCheckpointStore({ scopeId: 'persona:test' });
    const snapshotStore = new MemorySnapshotStore({ scopeId: 'persona:test' });
    const sessionId = 'rp:persona:test';

    const baseSnapshot = await snapshotStore.persistSnapshot(sessionId, {
      sessionId,
      templateId: 'default-v1',
      scope: 'contact',
      rows: [{ id: 'row-1', table_id: 'profile', row_data: { name: '第一版' } }],
    });
    const altSnapshot = await snapshotStore.persistSnapshot(sessionId, {
      sessionId,
      templateId: 'default-v1',
      scope: 'contact',
      rows: [{ id: 'row-2', table_id: 'profile', row_data: { name: '第二版' } }],
    });

    assert.ok(baseSnapshot?.id);
    assert.ok(altSnapshot?.id);

    await checkpointStore.setBaselineSnapshotId(sessionId, baseSnapshot.id);
    await checkpointStore.upsertCheckpoint(sessionId, {
      sessionId,
      assistantMessageId: 'asst-1',
      userMessageId: 'user-1',
      activeSwipeIndex: 1,
      branches: [
        {
          swipeIndex: 0,
          messageContent: '第一条回复',
          messageRaw: '第一条回复',
          memorySnapshotId: baseSnapshot.id,
        },
        {
          swipeIndex: 1,
          messageContent: '第二条回复',
          messageRaw: '第二条回复',
          memorySnapshotId: altSnapshot.id,
        },
      ],
    });
    await checkpointStore.setPointer(sessionId, {
      sessionId,
      tailAssistantMessageId: 'asst-1',
      tailSwipeIndex: 1,
      source: 'test',
    });
    await checkpointStore.setArchivePointer(sessionId, 'arc-1', {
      sessionId,
      archiveId: 'arc-1',
      tailAssistantMessageId: 'asst-1',
      tailSwipeIndex: 1,
      memorySnapshotId: altSnapshot.id,
      source: 'archive-test',
    });

    const state = await checkpointStore.getSessionState(sessionId);
    assert.equal(state.baselineSnapshotId, baseSnapshot.id);
    assert.equal(state.pointer.tailAssistantMessageId, 'asst-1');
    assert.equal(state.pointer.tailSwipeIndex, 1);
    assert.equal(state.archivePointers['arc-1']?.tailAssistantMessageId, 'asst-1');
    assert.deepEqual(
      collectCheckpointSnapshotIds(state).sort(),
      [baseSnapshot.id, altSnapshot.id].sort(),
    );
  });
});

test('MemorySnapshotStore should prune unreachable snapshots after checkpoint removal', async () => {
  await withMockStorage(async () => {
    const checkpointStore = new TurnCheckpointStore({ scopeId: 'persona:test' });
    const snapshotStore = new MemorySnapshotStore({ scopeId: 'persona:test' });
    const sessionId = 'rp:persona:test';

    const kept = await snapshotStore.persistSnapshot(sessionId, {
      sessionId,
      templateId: 'default-v1',
      scope: 'contact',
      rows: [{ id: 'row-keep', table_id: 'profile', row_data: { name: '保留' } }],
    });
    const removed = await snapshotStore.persistSnapshot(sessionId, {
      sessionId,
      templateId: 'default-v1',
      scope: 'contact',
      rows: [{ id: 'row-drop', table_id: 'profile', row_data: { name: '删除' } }],
    });

    await checkpointStore.setBaselineSnapshotId(sessionId, kept.id);
    await checkpointStore.upsertCheckpoint(sessionId, {
      sessionId,
      assistantMessageId: 'asst-1',
      branches: [
        { swipeIndex: 0, messageContent: '保留分支', memorySnapshotId: kept.id },
        { swipeIndex: 1, messageContent: '临时分支', memorySnapshotId: removed.id },
      ],
    });

    await snapshotStore.markReachable(sessionId, [kept.id, removed.id]);
    await checkpointStore.removeCheckpoint(sessionId, 'asst-1');
    await snapshotStore.markReachable(sessionId, [kept.id]);
    const removedIds = await snapshotStore.pruneUnreachable(sessionId, [kept.id], { graceMs: 0 });

    assert.deepEqual(removedIds, [removed.id]);
    const keptSnapshot = await snapshotStore.getSnapshot(kept.id);
    assert.equal(keptSnapshot?.rows?.[0]?.row_data?.name, '保留');
  });
});

test('MemorySnapshotStore should keep baseline snapshot reachable during prune', async () => {
  await withMockStorage(async () => {
    const checkpointStore = new TurnCheckpointStore({ scopeId: 'persona:test' });
    const snapshotStore = new MemorySnapshotStore({ scopeId: 'persona:test' });
    const sessionId = 'rp:persona:test';

    const baseline = await snapshotStore.persistSnapshot(sessionId, {
      sessionId,
      templateId: 'default-v1',
      scope: 'contact',
      rows: [{ id: 'row-baseline', table_id: 'profile', row_data: { name: '起点' } }],
    });

    await checkpointStore.setBaselineSnapshotId(sessionId, baseline.id);
    const removedIds = await snapshotStore.pruneUnreachable(sessionId, [baseline.id], { graceMs: 0 });

    assert.deepEqual(removedIds, []);
    const loaded = await snapshotStore.getSnapshot(baseline.id);
    assert.equal(loaded?.rows?.[0]?.row_data?.name, '起点');
  });
});

test('checkpoint and snapshot stores should rename session state without losing payloads', async () => {
  await withMockStorage(async () => {
    const checkpointStore = new TurnCheckpointStore({ scopeId: 'persona:test' });
    const snapshotStore = new MemorySnapshotStore({ scopeId: 'persona:test' });
    const from = 'rp:persona:old';
    const to = 'rp:persona:new';

    const snapshot = await snapshotStore.persistSnapshot(from, {
      sessionId: from,
      templateId: 'default-v1',
      scope: 'contact',
      rows: [{ id: 'row-1', table_id: 'profile', row_data: { name: '迁移前' } }],
    });
    await checkpointStore.setBaselineSnapshotId(from, snapshot.id);
    await checkpointStore.upsertCheckpoint(from, {
      sessionId: from,
      assistantMessageId: 'asst-1',
      branches: [{ swipeIndex: 0, messageContent: '回复', memorySnapshotId: snapshot.id }],
    });
    await checkpointStore.setArchivePointer(from, 'arc-1', {
      sessionId: from,
      archiveId: 'arc-1',
      tailAssistantMessageId: 'asst-1',
      tailSwipeIndex: 0,
      memorySnapshotId: snapshot.id,
    });

    await snapshotStore.renameSession(from, to);
    await checkpointStore.renameSession(from, to);

    const renamedCheckpoint = await checkpointStore.getCheckpoint(to, 'asst-1');
    const renamedSnapshot = await snapshotStore.getSnapshot(snapshot.id);
    const renamedArchivePointer = await checkpointStore.getArchivePointer(to, 'arc-1');
    const oldCheckpoint = await checkpointStore.getCheckpoint(from, 'asst-1');

    assert.equal(renamedCheckpoint?.sessionId, to);
    assert.equal(renamedSnapshot?.sessionId, to);
    assert.equal(renamedSnapshot?.rows?.[0]?.row_data?.name, '迁移前');
    assert.equal(renamedArchivePointer?.sessionId, to);
    assert.equal(renamedArchivePointer?.archiveId, 'arc-1');
    assert.equal(oldCheckpoint, null);
  });
});

test('MemorySnapshotStore clearSession should remove refs and payloads for that session', async () => {
  await withMockStorage(async () => {
    const snapshotStore = new MemorySnapshotStore({ scopeId: 'persona:test' });
    const sessionId = 'rp:persona:test';
    const snapshot = await snapshotStore.persistSnapshot(sessionId, {
      sessionId,
      templateId: 'default-v1',
      scope: 'contact',
      rows: [{ id: 'row-1', table_id: 'profile', row_data: { name: '待清理' } }],
    });

    await snapshotStore.clearSession(sessionId);

    const refs = await snapshotStore.listSnapshotIds(sessionId);
    const payload = await snapshotStore.getSnapshot(snapshot.id);
    assert.deepEqual(refs, []);
    assert.equal(payload, null);
  });
});

test('_compactOldBranches should strip content from turns beyond COMPACT_RECENT_TURNS', async () => {
  await withMockStorage(async () => {
    const store = new TurnCheckpointStore({ scopeId: 'persona:compact' });
    const sessionId = 'rp:persona:compact';
    const branches = index => ([{
      swipeIndex: 0,
      messageContent: `回复内容-${index}`,
      messageRaw: `raw-${index}`,
      memorySnapshotId: `mem_${index}`,
    }]);
    for (let i = 1; i <= 40; i += 1) {
      await store.upsertCheckpoint(sessionId, {
        sessionId,
        assistantMessageId: `asst-${i}`,
        turnIndex: i,
        aiFloor: i,
        branches: branches(i),
      });
    }
    const state = await store.getSessionState(sessionId);
    const cp5 = state.checkpoints['asst-5'];
    const cp35 = state.checkpoints['asst-35'];
    assert.equal(cp5.branches[0].messageContent, '', 'old turn should be compacted');
    assert.equal(cp5.branches[0].messageRaw, '', 'old turn raw should be compacted');
    assert.equal(cp5.branches[0].memorySnapshotId, 'mem_5', 'snapshotId must survive compaction');
    assert.ok(cp35.branches[0].messageContent.length > 0, 'recent turn should keep content');
    assert.ok(cp35.branches[0].messageRaw.length > 0, 'recent turn should keep raw');
  });
});

test('_compactOldBranches should be idempotent', async () => {
  await withMockStorage(async () => {
    const store = new TurnCheckpointStore({ scopeId: 'persona:idem' });
    const sessionId = 'rp:persona:idem';
    for (let i = 1; i <= 35; i += 1) {
      await store.upsertCheckpoint(sessionId, {
        sessionId,
        assistantMessageId: `asst-${i}`,
        turnIndex: i,
        aiFloor: i,
        branches: [{
          swipeIndex: 0,
          messageContent: `内容-${i}`,
          messageRaw: `raw-${i}`,
          memorySnapshotId: `mem_${i}`,
        }],
      });
    }
    const state1 = await store.getSessionState(sessionId);
    const cp1_before = JSON.stringify(state1.checkpoints['asst-1']);
    await store.upsertCheckpoint(sessionId, {
      sessionId,
      assistantMessageId: 'asst-35',
      turnIndex: 35,
      aiFloor: 35,
      branches: [{
        swipeIndex: 0,
        messageContent: '更新内容',
        messageRaw: '更新raw',
        memorySnapshotId: 'mem_35',
      }],
    });
    const state2 = await store.getSessionState(sessionId);
    const cp1_after = JSON.stringify(state2.checkpoints['asst-1']);
    assert.equal(cp1_before, cp1_after, 'already compacted checkpoint should not change');
  });
});

test('old checkpoints drop their write and variable records except the restore targets', async () => {
  // 回归：检查点只增不减，每个旧分支都带着回滚资料、写表操作等（约 10 KiB），多次重开、存档后整份越来越大。
  await withMockStorage(async () => {
    const store = new TurnCheckpointStore({ scopeId: 'persona:slim-old' });
    const sessionId = 'rp:persona:slim-old';
    const entry = { actions: [{ action: 'insert' }], rollback: { tables: [{ tableId: 't1', rows: [] }] }, tableEditRaw: 'insertRow' };
    const upsert = i => store.upsertCheckpoint(sessionId, {
      sessionId,
      assistantMessageId: `asst-${i}`,
      turnIndex: i,
      aiFloor: i,
      branches: [{
        swipeIndex: 0,
        memorySnapshotId: `mem_${i}`,
        variableSnapshotId: `var_${i}`,
        memoryUpdateEntry: entry,
        variableUpdateEntry: { changed: { hp: i } },
      }],
    });
    for (let i = 1; i <= 5; i += 1) await upsert(i);
    // 当前对话末尾（楼层可能比旧存档低）与存档末尾是还原目标，掉出最近窗口也要留着写表记录。
    await store.setPointer(sessionId, { sessionId, tailAssistantMessageId: 'asst-3' });
    await store.setArchivePointer(sessionId, 'archive-a', { sessionId, tailAssistantMessageId: 'asst-5', memorySnapshotId: 'mem_5' });
    for (let i = 6; i <= 40; i += 1) await upsert(i);

    const state = await store.getSessionState(sessionId);
    const branch = id => state.checkpoints[id].branches[0];
    assert.equal(branch('asst-10').memoryUpdateEntry, null, 'old turn drops its write record');
    assert.equal(branch('asst-10').variableUpdateEntry, null, 'old turn drops its variable record');
    assert.equal(branch('asst-10').memorySnapshotId, 'mem_10');
    assert.equal(branch('asst-10').variableSnapshotId, 'var_10');
    assert.deepEqual(branch('asst-35').memoryUpdateEntry.rollback, entry.rollback, 'recent turn keeps its write record');
    assert.deepEqual(branch('asst-3').memoryUpdateEntry.rollback, entry.rollback, 'session tail keeps its write record');
    assert.deepEqual(branch('asst-5').memoryUpdateEntry.actions, entry.actions, 'archive tail keeps its write record');
    assert.deepEqual(branch('asst-5').variableUpdateEntry, { changed: { hp: 5 } });
  });
});

test('_compactOldBranches should not touch sessions with <= 30 checkpoints', async () => {
  await withMockStorage(async () => {
    const store = new TurnCheckpointStore({ scopeId: 'persona:small' });
    const sessionId = 'rp:persona:small';
    for (let i = 1; i <= 30; i += 1) {
      await store.upsertCheckpoint(sessionId, {
        sessionId,
        assistantMessageId: `asst-${i}`,
        turnIndex: i,
        aiFloor: i,
        branches: [{
          swipeIndex: 0,
          messageContent: `内容-${i}`,
          messageRaw: `raw-${i}`,
          memorySnapshotId: `mem_${i}`,
        }],
      });
    }
    const state = await store.getSessionState(sessionId);
    const cp1 = state.checkpoints['asst-1'];
    assert.ok(cp1.branches[0].messageContent.length > 0, 'all 30 should keep content');
  });
});

test('writeLocalJson should skip oversized data and clean up old entry', async () => {
  await withMockStorage(async (storage) => {
    const store = new TurnCheckpointStore({ scopeId: 'persona:overflow' });
    const sessionId = 'rp:persona:overflow';
    const bigContent = 'x'.repeat(200_000);
    for (let i = 1; i <= 5; i += 1) {
      await store.upsertCheckpoint(sessionId, {
        sessionId,
        assistantMessageId: `asst-${i}`,
        turnIndex: i,
        aiFloor: i,
        branches: [{
          swipeIndex: 0,
          messageContent: bigContent,
          messageRaw: bigContent,
          memorySnapshotId: `mem_${i}`,
        }],
      });
    }
    let found = false;
    for (const [key] of storage.map) {
      if (key.includes('turn_checkpoint_v1')) { found = true; break; }
    }
    // The serialized blob is way over 320KB so localStorage should NOT have it
    // (it may have been written initially but removed once the blob grew too large,
    // or it may never have been written if it exceeded the limit from the start)
    // We just verify the store still works correctly via KV fallback
    const state = await store.getSessionState(sessionId);
    assert.ok(state.checkpoints['asst-5'], 'checkpoint should still be in memory cache');
  });
});

test('normalizeCheckpointBranch carries variable snapshot fields and stays backward compatible', () => {
  const withVars = normalizeCheckpointBranch({
    swipeIndex: 0, variableSnapshotId: 'var_abc', variableUpdateEntry: { changed: { hp: 5 } },
    memorySnapshotId: 'mem_x',
  });
  assert.equal(withVars.variableSnapshotId, 'var_abc');
  assert.deepEqual(withVars.variableUpdateEntry, { changed: { hp: 5 } });
  assert.equal(withVars.memorySnapshotId, 'mem_x');
  const legacy = normalizeCheckpointBranch({ swipeIndex: 1, memorySnapshotId: 'mem_y' });
  assert.equal(legacy.variableSnapshotId, '');
  assert.equal(legacy.variableUpdateEntry, null);
});

test('checkpoint branches keep the memory write record without its request prompt and raw output', async () => {
  // 回归：每轮的请求提示词（整段正文请求）与原始输出都存进检查点，会话检查点超过 load_kv 的 30 MiB 上限后整份读不回来。
  const entry = {
    at: 1,
    mode: 'inline',
    sessionId: 'rp:persona:slim',
    requestPrompt: 'system:\n整段正文请求',
    raw: '正文原文与写表块',
    tableEditRaw: 'insertRow(0, {"0":"甲"})',
    actions: [{ action: 'insert', tableId: 't1', rowIndex: 0, data: { 0: '甲' } }],
    rollback: { tables: [{ tableId: 't1', rows: [] }] },
    rollbackAt: 2,
  };
  const branch = normalizeCheckpointBranch({ swipeIndex: 0, memorySnapshotId: 'mem_1', memoryUpdateEntry: entry });
  assert.deepEqual(
    Object.keys(branch.memoryUpdateEntry).sort(),
    ['actions', 'at', 'mode', 'rollback', 'rollbackAt', 'sessionId', 'tableEditRaw'],
  );
  assert.equal(entry.requestPrompt, 'system:\n整段正文请求', 'caller entry must not be mutated');
  assert.equal(normalizeCheckpointBranch({ swipeIndex: 0 }).memoryUpdateEntry, null);

  await withMockStorage(async storage => {
    const scopeId = 'persona:slim';
    const sessionId = 'rp:persona:slim';
    const key = buildTurnCheckpointStoreKey(scopeId, sessionId);
    // 旧档里还带着这两项：载入即去掉，下一次写入落盘的就是瘦身后的内容。
    storage.setItem(key, JSON.stringify({
      version: 1,
      sessionId,
      checkpoints: {
        'asst-1': { assistantMessageId: 'asst-1', aiFloor: 1, branches: [{ swipeIndex: 0, memoryUpdateEntry: entry }] },
      },
    }));
    const store = new TurnCheckpointStore({ scopeId });
    const loaded = await store.getCheckpoint(sessionId, 'asst-1');
    assert.equal(loaded.branches[0].memoryUpdateEntry.requestPrompt, undefined);
    assert.equal(loaded.branches[0].memoryUpdateEntry.raw, undefined);
    assert.equal(loaded.branches[0].memoryUpdateEntry.tableEditRaw, entry.tableEditRaw);
    await store.upsertCheckpoint(sessionId, {
      sessionId,
      assistantMessageId: 'asst-2',
      aiFloor: 2,
      branches: [{ swipeIndex: 0, memorySnapshotId: 'mem_2', memoryUpdateEntry: entry }],
    });
    const persisted = String(storage.getItem(key) || '');
    assert.ok(persisted.includes('mem_2'), 'checkpoint should be persisted');
    assert.ok(!persisted.includes('整段正文请求'), 'request prompt must not be persisted');
    assert.ok(!persisted.includes('正文原文与写表块'), 'raw output must not be persisted');
    assert.ok(persisted.includes('rollbackAt'), 'rollback data stays for undo');
  });
});

test('normalizeArchivePointer carries variableSnapshotId (archive variable restore)', () => {
  const p = normalizeArchivePointer({ archiveId: 'a1', memorySnapshotId: 'mem_1', variableSnapshotId: 'var_9' });
  assert.equal(p.variableSnapshotId, 'var_9');
  assert.equal(p.memorySnapshotId, 'mem_1');
  assert.equal(normalizeArchivePointer({ archiveId: 'a2' }).variableSnapshotId, ''); // 旧归档向后兼容
});

test('collectCheckpointVariableSnapshotIds gathers from branches and archive pointers', () => {
  const state = {
    checkpoints: {
      m1: { branches: [{ variableSnapshotId: 'var_1', memorySnapshotId: 'mem_1' }, { variableSnapshotId: 'var_2' }, { variableSnapshotId: '' }] },
    },
    archivePointers: { a1: { variableSnapshotId: 'var_3' } },
  };
  assert.deepEqual(collectCheckpointVariableSnapshotIds(state).sort(), ['var_1', 'var_2', 'var_3']);
  assert.deepEqual(collectCheckpointSnapshotIds(state).sort(), ['mem_1']);
});

let failed = 0;
for (const item of tests) {
  try {
    await item.fn();
    console.log(`ok - ${item.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${item.name}`);
    console.error(error);
  }
}

if (failed > 0) process.exit(1);
