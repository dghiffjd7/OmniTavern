import assert from 'node:assert/strict';

import {
  AgentRunStore,
  buildAgentRunStoreKey,
  normalizeAgentRunStoreState,
} from '../../src/scripts/storage/agent-run-store.js';

const installLocalStorage = () => {
  const backing = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: key => backing.get(String(key)) ?? null,
    setItem: (key, value) => {
      backing.set(String(key), String(value));
    },
    removeItem: key => {
      backing.delete(String(key));
    },
  };
  return {
    backing,
    restore: () => {
      if (previous === undefined) {
        delete globalThis.localStorage;
      } else {
        globalThis.localStorage = previous;
      }
    },
  };
};

{
  assert.equal(buildAgentRunStoreKey(''), 'agent_run_store_v1');
  assert.equal(buildAgentRunStoreKey(' rp:char '), 'agent_run_store_v1__rp_char');
  console.log('ok - buildAgentRunStoreKey scopes agent run storage keys');
}

{
  const state = normalizeAgentRunStoreState({
    runs: {
      a: { id: 'a', kind: 'memory_update', updatedAt: 10 },
      b: { id: 'b', kind: 'image_generate', updatedAt: 20, exportable: false },
    },
    events: [
      { id: 'e1', runId: 'a', type: 'agent.run.started', createdAt: 11 },
      { id: 'e2', runId: 'missing', type: 'agent.run.started', createdAt: 12 },
    ],
  }, {
    now: () => 100,
    maxRuns: 1,
    maxEvents: 10,
  });
  assert.deepEqual(Object.keys(state.runs), ['b']);
  assert.deepEqual(state.events.map(event => event.id), []);
  console.log('ok - normalizeAgentRunStoreState trims stale runs and orphan events');
}

{
  const local = installLocalStorage();
  try {
    let currentTime = 1000;
    const store = new AgentRunStore({
      now: () => currentTime,
      maxRuns: 5,
      maxEvents: 10,
    });
    await store.load();
    const run = store.upsertRun({
      id: 'run-1',
      kind: 'memory_update',
      sessionId: 's1',
      status: 'running',
      createdAt: 1000,
    });
    assert.equal(run.id, 'run-1');
    currentTime = 1010;
    const step = store.addStep('run-1', {
      id: 'step-1',
      type: 'memory.update',
      status: 'running',
    });
    assert.equal(step.runId, 'run-1');
    currentTime = 1025;
    store.updateStep('run-1', 'step-1', {
      status: 'succeeded',
      output: { changed: 2 },
      finishedAt: 1025,
    });
    const event = store.recordEvent({
      id: 'event-1',
      type: 'agent.run.finished',
      runId: 'run-1',
      sessionId: 's1',
      status: 'succeeded',
      createdAt: 1030,
    });
    assert.equal(event.id, 'event-1');
    currentTime = 1030;
    store.updateRun('run-1', {
      status: 'succeeded',
      finishedAt: 1030,
      summary: 'done',
    });
    const saved = store.getRun('run-1');
    assert.equal(saved.status, 'succeeded');
    assert.equal(saved.steps[0].output.changed, 2);
    assert.deepEqual(store.listRuns({ sessionId: 's1' }).map(item => item.id), ['run-1']);
    assert.deepEqual(store.listEvents({ runId: 'run-1' }).map(item => item.id), ['event-1']);
    assert.deepEqual(Object.keys(store.exportState().runs), ['run-1']);
    const view = store.buildListView({ limit: 5 });
    assert.equal(view.meta.total, 1);
    assert.equal(view.runs[0].id, 'run-1');
    const stats = store.getStats();
    assert.equal(stats.runCount, 1);
    assert.equal(stats.eventCount, 1);
    await store.flush(); // 持久化已改防抖，测试用 flush 立即落盘
    assert.ok(local.backing.get('agent_run_store_v1')?.includes('run-1'));
    console.log('ok - AgentRunStore records runs, steps, events, exports, and persists locally');
  } finally {
    local.restore();
  }
}

{
  let currentTime = 5000;
  const store = new AgentRunStore({
    now: () => currentTime,
    maxRuns: 5,
    maxEvents: 10,
  });
  for (let index = 0; index < 4; index += 1) {
    currentTime += 10;
    const run = store.upsertRun({
      id: `run-${index}`,
      kind: 'task',
      status: 'succeeded',
      updatedAt: currentTime,
    });
    store.recordEvent({
      id: `event-${index}`,
      runId: run.id,
      type: 'agent.run.finished',
      status: 'succeeded',
      createdAt: currentTime,
    });
  }
  const compacted = store.compact({ maxRuns: 2, maxEvents: 2 });
  assert.equal(compacted.runCount, 2);
  assert.equal(compacted.eventCount, 2);
  assert.deepEqual(store.listRuns().map(run => run.id), ['run-3', 'run-2']);
  assert.deepEqual(store.listEvents().map(event => event.id), ['event-2', 'event-3']);
  console.log('ok - AgentRunStore compact trims stale runs and events on demand');
}

{
  let currentTime = 8000;
  const store = new AgentRunStore({
    now: () => currentTime,
    maxRuns: 3,
    maxEvents: 4,
  });
  for (let index = 0; index < 6; index += 1) {
    currentTime += 10;
    store.upsertRun({
      id: `long-run-${index}`,
      kind: 'long_session_task',
      sessionId: 'long-session',
      status: 'succeeded',
      updatedAt: currentTime,
      exportable: index !== 5,
    });
    store.recordEvent({
      id: `long-event-start-${index}`,
      runId: `long-run-${index}`,
      sessionId: 'long-session',
      type: 'agent.run.started',
      status: 'running',
      createdAt: currentTime,
    });
    currentTime += 1;
    store.recordEvent({
      id: `long-event-finish-${index}`,
      runId: `long-run-${index}`,
      sessionId: 'long-session',
      type: 'agent.run.finished',
      status: 'succeeded',
      createdAt: currentTime,
    });
  }

  const stats = store.getStats();
  assert.equal(stats.runCount, 3);
  assert.equal(stats.eventCount, 4);
  assert.deepEqual(store.listRuns().map(run => run.id), ['long-run-5', 'long-run-4', 'long-run-3']);

  const exported = store.exportState();
  assert.deepEqual(Object.keys(exported.runs).sort(), ['long-run-3', 'long-run-4']);
  assert.equal(exported.events.every(event => Object.hasOwn(exported.runs, event.runId)), true);

  const fullExport = store.exportState({ includeNonExportable: true });
  assert.deepEqual(Object.keys(fullExport.runs).sort(), ['long-run-3', 'long-run-4', 'long-run-5']);
  assert.equal(fullExport.events.every(event => Object.hasOwn(fullExport.runs, event.runId)), true);
  console.log('ok - AgentRunStore enforces long-session cache limits and filters export payloads');
}

{
  let currentTime = 9000;
  const store = new AgentRunStore({ now: () => currentTime });
  [['done', 'succeeded'], ['bad', 'failed'], ['busy', 'running'], ['ask', 'waiting_permission']].forEach(([id, status]) => {
    currentTime += 10;
    store.upsertRun({ id, kind: 'task', status, updatedAt: currentTime });
    store.recordEvent({ id: `event-${id}`, runId: id, type: 'agent.run.updated', status, createdAt: currentTime });
  });
  assert.deepEqual(store.removeRuns(['done', 'busy', 'ask', 'missing', '']), ['done'], 'running and waiting runs are kept');
  assert.deepEqual(store.removeRuns('bad'), ['bad']);
  assert.deepEqual(store.listRuns().map(run => run.id).sort(), ['ask', 'busy']);
  assert.deepEqual(store.listEvents().map(event => event.runId).sort(), ['ask', 'busy'], 'events of removed runs go with them');
  assert.deepEqual(store.removeRuns([]), []);
  console.log('ok - AgentRunStore removeRuns deletes finished runs with their events and keeps active ones');
}
