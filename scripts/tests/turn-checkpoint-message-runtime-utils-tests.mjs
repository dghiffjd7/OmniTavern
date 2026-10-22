import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import {
  buildSwipeMemoryStateKey,
  buildTurnCheckpointHydrationThreadKey,
  createSwipeMemoryStateTracker,
  findPreviousUserMessageIdForAssistant,
  findTailTrackedAssistantMessage,
  normalizeCheckpointSwipeState,
  resolveAssistantFloorForCheckpoint,
  resolveTurnIndexForAssistant,
  withMessageMemoryUpdateEntry,
} from '../../src/scripts/ui/chat/turn-checkpoint-message-runtime-utils.js';

{
  assert.equal(buildSwipeMemoryStateKey('s1', 'm1', 2), 's1:m1:2');
  assert.equal(buildSwipeMemoryStateKey('s1', '', 2), '');
  assert.equal(buildTurnCheckpointHydrationThreadKey('s1', 'archive-a'), 's1::archive-a');
  assert.equal(buildTurnCheckpointHydrationThreadKey('', 'archive-a'), '');
  console.log('ok - turn checkpoint key helpers normalize swipe and hydration thread identifiers');
}

{
  const tracker = createSwipeMemoryStateTracker();
  assert.equal(tracker.canPersistOutgoing('s1', 'm1', 0, {}), true);
  tracker.markActive('s1', 'm1', 1);
  assert.equal(tracker.getActiveKey(), 's1:m1:1');
  assert.equal(tracker.canPersistOutgoing('s1', 'm1', 1, { memoryTableSnapshot: { a: 1 } }), true);
  assert.equal(tracker.canPersistOutgoing('s1', 'm1', 0, { memoryTableSnapshot: { a: 1 } }), false);
  console.log('ok - createSwipeMemoryStateTracker preserves active branch persistence semantics');
}

{
  const normalized = normalizeCheckpointSwipeState({
    content: 'assistant text',
    raw: 'assistant raw',
    meta: {
      activeSwipe: 4,
      memoryTableSnapshot: { hp: 3 },
      memoryUpdateEntry: { rowId: 'r1' },
      swipes: [
        { content: 'branch a' },
        { content: 'branch b', memoryTableSnapshot: { hp: 4 } },
      ],
    },
  }, {
    clonePlainObject: value => (value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value),
    cloneMemoryUpdateEntry: value => (value && typeof value === 'object' ? { ...value } : value),
  });
  assert.equal(normalized.activeSwipeIndex, 1);
  assert.deepEqual(normalized.swipes[0].memoryTableSnapshot, { hp: 3 });
  assert.deepEqual(normalized.swipes[0].memoryUpdateEntry, { rowId: 'r1' });
  assert.deepEqual(normalized.meta.memoryTableSnapshot, { hp: 3 });
  console.log('ok - normalizeCheckpointSwipeState backfills checkpoint swipe snapshots and clamps active index');
}

{
  const messages = [
    { id: 'u1', role: 'user', content: 'hello' },
    { id: 'a1', role: 'assistant', content: 'reply' },
    { id: 'u2', role: 'user', content: 'from ai', meta: { generatedByAssistant: true } },
    { id: 'u3', role: 'user', content: 'real user' },
    { id: 'a2', role: 'assistant', content: 'second reply' },
  ];
  assert.equal(findPreviousUserMessageIdForAssistant(messages, 'a2'), 'u3');
  assert.equal(resolveTurnIndexForAssistant(messages, 'a2'), 2);
  assert.equal(
    resolveAssistantFloorForCheckpoint(
      messages,
      'a2',
      message => message?.role === 'assistant' && String(message?.content || '') !== 'reply',
    ),
    1,
  );
  assert.deepEqual(
    findTailTrackedAssistantMessage(messages, message => message?.role === 'assistant'),
    messages[4],
  );
  console.log('ok - turn checkpoint message helpers resolve previous user turn index assistant floor and tail assistant');
}

{
  // 检查点里的写表记录不带请求提示词和原始输出；还原时要用消息自带的那份，「最近写表请求提示词」才看得到。
  const checkpointEntry = { actions: [{ action: 'insert' }], rollback: { tables: [] } };
  const messageEntry = { ...checkpointEntry, requestPrompt: 'system:\n正文请求', raw: '正文原文' };
  const checkpointBranch = { swipeIndex: 0, memorySnapshotId: 'mem_1', memoryUpdateEntry: checkpointEntry };
  const merged = withMessageMemoryUpdateEntry(checkpointBranch, { content: 'reply', memoryUpdateEntry: messageEntry });
  assert.equal(merged.memoryUpdateEntry, messageEntry);
  assert.equal(merged.memorySnapshotId, 'mem_1');
  assert.equal(checkpointBranch.memoryUpdateEntry, checkpointEntry, 'checkpoint branch must not be mutated');
  assert.equal(withMessageMemoryUpdateEntry(checkpointBranch, { content: 'reply' }).memoryUpdateEntry, checkpointEntry);
  assert.equal(withMessageMemoryUpdateEntry(checkpointBranch, null).memoryUpdateEntry, checkpointEntry);
  assert.deepEqual(withMessageMemoryUpdateEntry(null, { memoryUpdateEntry: messageEntry }), { memoryUpdateEntry: messageEntry });

  // 进房还原、补建检查点后的还原、切存档还原三处都要经过它。
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.equal((app.match(/withMessageMemoryUpdateEntry\(/g) || []).length, 3);
  console.log('ok - withMessageMemoryUpdateEntry keeps the message write record over the slimmed checkpoint copy');
}

{
  // 回归：检查点读不到（超过 30 MiB、读取失败）时拿到的是空状态，据此把这个会话的快照全判成没人引用，
  // 满 30 天后重新生成或删消息就把它们真的删掉（「user」卡 378 个记忆快照就是这样没的）。
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const refreshTurnCheckpointSnapshotReachability = ');
  const end = app.indexOf('const ensureSessionBaselineCheckpointSnapshot = ', start);
  assert.ok(start > 0 && end > start);
  const run = async ({ blocked, prune }) => {
    const calls = [];
    // 沙箱里建的数组原型不同，先复制成本环境的数组再比对。
    const spyStore = name => ({
      markReachable: async (sid, ids) => { calls.push([`${name}.markReachable`, [...ids]]); return ids; },
      pruneUnreachable: async (sid, ids) => { calls.push([`${name}.pruneUnreachable`, [...ids]]); return []; },
    });
    const sandbox = {
      isTurnCheckpointSessionEnabled: () => true,
      turnCheckpointStore: {
        getSessionState: async () => ({ baselineSnapshotId: 'mem_base', checkpoints: {} }),
        isPersistenceBlocked: () => blocked,
      },
      collectCheckpointSnapshotIds: () => ['mem_1'],
      collectCheckpointVariableSnapshotIds: () => ['var_1'],
      memorySnapshotStore: spyStore('memory'),
      variableSnapshotStore: spyStore('variable'),
      logger: { debug: () => {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${app.slice(start, end)}\nglobalThis.refresh = refreshTurnCheckpointSnapshotReachability;`, sandbox);
    const result = await sandbox.refresh('rp:persona_a', { prune });
    return { result: Array.from(result || []), calls };
  };

  for (const prune of [true, false]) {
    const blocked = await run({ blocked: true, prune });
    assert.deepEqual(blocked.calls, [], `blocked store must not ${prune ? 'prune' : 'mark'} snapshots`);
    assert.deepEqual(blocked.result, []);
  }
  const pruned = await run({ blocked: false, prune: true });
  assert.deepEqual(pruned.calls, [
    ['memory.pruneUnreachable', ['mem_1', 'mem_base']],
    ['variable.pruneUnreachable', ['var_1']],
  ]);
  const marked = await run({ blocked: false, prune: false });
  assert.deepEqual(marked.calls.map(([name]) => name), ['memory.markReachable', 'variable.markReachable']);
  console.log('ok - snapshot reachability is left untouched while the checkpoint store is blocked');
}
