import assert from 'node:assert/strict';

import { createMemoryUpdateRuntime } from '../../src/scripts/ui/chat/memory-update-runtime.js';
import { createSessionAsyncWorkRuntime } from '../../src/scripts/ui/chat/session-async-work-runtime-utils.js';

const createDeps = (overrides = {}) => {
  const calls = {
    configGets: 0,
    configLoads: 0,
    clients: [],
    edits: [],
    messages: null,
    plans: [],
    syncs: [],
    traces: [],
    warnings: [],
  };
  const runtime = createMemoryUpdateRuntime({
    appBridge: {
      config: {
        load: async () => { calls.configLoads += 1; },
        get: () => {
          calls.configGets += 1;
          return { apiKey: 'k' };
        },
      },
    },
    appSettings: {
      get: () => ({
        memoryFillEveryN: 1,
        memoryUpdateApiMode: 'chat',
      }),
    },
    buildMemoryUpdateHistoryText: () => 'user: hi',
    buildMemoryUpdatePlan: async (...args) => {
      calls.plans.push(args);
      return { enabled: true, promptText: 'system prompt' };
    },
    canInitClient: config => Boolean(config?.apiKey),
    createClient: (config) => {
      calls.clients.push(config);
      return {
        chat: async (messages) => {
          calls.messages = messages;
          return '<tableEdit>ok</tableEdit>';
        },
      };
    },
    handleMemoryEditsFromRaw: async (raw, options) => {
      calls.edits.push({ raw, options });
    },
    isMemoryAutoExtractSeparate: () => true,
    isOnline: () => true,
    logger: {
      info: () => {},
      warn: (...args) => calls.warnings.push(args),
    },
    memoryUpdateConfigManager: {
      load: async () => {},
      getActiveProfileId: () => '',
      getRuntimeConfigByProfileId: async () => null,
    },
    recordTraceEvent: event => calls.traces.push(event),
    syncTurnCheckpointForMessage: async (...args) => {
      calls.syncs.push(args);
    },
    ...overrides,
  });
  return { calls, runtime };
};

{
  const { calls, runtime } = createDeps({
    appSettings: {
      get: () => ({
        memoryFillEveryN: 2,
        memoryUpdateApiMode: 'chat',
      }),
    },
  });
  const first = await runtime.runMemoryUpdateAfterChat('s1', false, { meta: { foo: true } }, { checkpointMessageId: 'm1' });
  assert.equal(first, undefined);
  assert.equal(calls.plans.length, 0);
  await runtime.runMemoryUpdateAfterChat('s1', false, { meta: { foo: true } }, { checkpointMessageId: 'm2' });
  assert.equal(calls.plans.length, 1);
  assert.deepEqual(calls.plans[0], ['s1', false, { meta: { foo: true } }]);
  assert.equal(calls.configLoads, 1);
  assert.deepEqual(calls.messages, [
    { role: 'system', content: 'system prompt' },
    {
      role: 'user',
      content: '请根据以下聊天记录更新记忆表格。\n只输出 <tableEdit>...</tableEdit>，不要输出任何解释。\n\n<chat_history>\nuser: hi\n</chat_history>',
    },
  ]);
  assert.equal(calls.edits.length, 1);
  assert.equal(calls.edits[0].raw, '<tableEdit>ok</tableEdit>');
  assert.equal(calls.edits[0].options.sessionId, 's1');
  assert.equal(calls.edits[0].options.force, true);
  assert.equal(calls.edits[0].options.timelineMessageId, 'm2');
  assert.match(calls.edits[0].options.requestPrompt, /^system:\nsystem prompt\n\nuser:\n/);
  assert.deepEqual(calls.syncs, [['s1', 'm2', { captureCurrentActiveState: true }]]);
  assert.deepEqual(calls.traces.map(event => [event.phase, event.status, event.details]), [
    ['update.skip', 'skipped', { reason: 'cadence', nextCounter: 1, everyN: 2 }],
    ['update.start', 'started', { isGroup: false, checkpointMessageId: 'm2' }],
    ['update.finish', 'success', { checkpointMessageId: 'm2' }],
  ]);
  console.log('ok - createMemoryUpdateRuntime enforces cadence and runs queued memory update tasks');
}

{
  // app.js 每次发送都会新建 runtime；计数必须存在注入的会话存储里，否则 N>=2 永远数不到
  const counters = new Map();
  const counterDeps = {
    appSettings: {
      get: () => ({
        memoryFillEveryN: 3,
        memoryUpdateApiMode: 'chat',
      }),
    },
    getMemoryFillCounter: sessionId => counters.get(sessionId) || 0,
    setMemoryFillCounter: (sessionId, value) => counters.set(sessionId, value),
  };
  const planCounts = [];
  for (let turn = 1; turn <= 6; turn += 1) {
    const { calls, runtime } = createDeps(counterDeps);
    await runtime.runMemoryUpdateAfterChat('s-fresh', false, {}, { checkpointMessageId: `m${turn}` });
    planCounts.push(calls.plans.length);
  }
  assert.deepEqual(planCounts, [0, 0, 1, 0, 0, 1]);
  assert.equal(counters.get('s-fresh'), 0);
  console.log('ok - createMemoryUpdateRuntime keeps fill cadence across runtime instances via injected counter store');
}

{
  const { calls, runtime } = createDeps({
    isMemoryUpdateTargetCurrent: async (sessionId, messageId) => {
      calls.validated = [sessionId, messageId];
      return false;
    },
  });
  await runtime.runMemoryUpdateAfterChat('s-stale', false, {}, { checkpointMessageId: 'gone-1' });
  assert.deepEqual(calls.validated, ['s-stale', 'gone-1']);
  assert.equal(calls.edits.length, 0);
  assert.deepEqual(calls.syncs, []);
  assert.deepEqual(calls.traces.map(event => [event.phase, event.status, event.details]), [
    ['update.start', 'started', { isGroup: false, checkpointMessageId: 'gone-1' }],
    ['update.finish', 'skipped', { reason: 'stale-checkpoint', checkpointMessageId: 'gone-1' }],
  ]);
  console.log('ok - createMemoryUpdateRuntime skips stale checkpoint targets before applying memory edits');
}

{
  const sessionAsyncWorkRuntime = createSessionAsyncWorkRuntime();
  let notifyChatStarted = null;
  const chatStarted = new Promise(resolve => { notifyChatStarted = resolve; });
  const { calls, runtime } = createDeps({
    sessionAsyncWorkRuntime,
    createClient: () => ({
      chat: async (_messages, { signal } = {}) => {
        notifyChatStarted();
        return new Promise((resolve, reject) => {
          signal?.addEventListener?.('abort', () => {
            const error = new Error('aborted by session deletion');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
    }),
  });
  const task = runtime.runMemoryUpdateAfterChat('s-delete', false, {}, { checkpointMessageId: 'm-delete' });
  await chatStarted;
  const guard = await sessionAsyncWorkRuntime.cancelAndWait('s-delete', {
    reason: 'session_deleted',
    timeoutMs: 1000,
  });
  if (guard.cancelledCount === 0) runtime.abortMemoryUpdate('s-delete');
  await task;
  assert.equal(guard.ok, true);
  assert.equal(guard.cancelledCount, 1);
  assert.equal(sessionAsyncWorkRuntime.count('s-delete'), 0);
  assert.equal(calls.edits.length, 0);
  assert.equal(calls.traces.at(-1)?.details?.reason, 'aborted');
  console.log('ok - session deletion cancels and waits for an in-flight memory update');
}

{
  const { calls, runtime } = createDeps({
    isMemoryUpdateTargetCurrent: async () => {
      throw new Error('checkpoint store unavailable');
    },
  });
  await runtime.runMemoryUpdateAfterChat('s-validation-error', false, {}, {
    checkpointMessageId: 'm-validation-error',
  });
  assert.equal(calls.edits.length, 0);
  assert.equal(calls.traces.at(-1)?.details?.reason, 'stale-checkpoint');
  assert.equal(calls.warnings.length, 1);
  console.log('ok - memory checkpoint validation errors fail closed');
}

{
  let loadCount = 0;
  let runtimeConfigId = '';
  const { calls, runtime } = createDeps({
    appBridge: {
      config: {
        load: async () => { throw new Error('chat config path should not run'); },
        get: () => ({ apiKey: 'bad' }),
      },
    },
    appSettings: {
      get: () => ({
        memoryFillEveryN: 1,
        memoryUpdateApiMode: 'profile',
        memoryUpdateProfileId: 'p1',
      }),
    },
    memoryUpdateConfigManager: {
      load: async () => { loadCount += 1; },
      getActiveProfileId: () => '',
      getRuntimeConfigByProfileId: async (profileId) => {
        runtimeConfigId = profileId;
        return { apiKey: 'profile-key' };
      },
    },
  });
  await runtime.runMemoryUpdateAfterChat('s2', true, {}, {});
  assert.equal(loadCount, 1);
  assert.equal(runtimeConfigId, 'p1');
  assert.deepEqual(calls.clients, [{ apiKey: 'profile-key' }]);
  console.log('ok - createMemoryUpdateRuntime resolves profile-scoped config when configured');
}

{
  const agentCalls = [];
  const agentTaskRuntime = {
    startRun: (run) => {
      agentCalls.push(['startRun', run]);
      return { id: 'agent-run-1', ...run };
    },
    startStep: (runId, step) => {
      agentCalls.push(['startStep', runId, step]);
      return { id: 'agent-step-1', runId, ...step };
    },
    finishStep: (runId, stepId, patch) => {
      agentCalls.push(['finishStep', runId, stepId, patch]);
      return { id: stepId, runId, ...patch };
    },
    finishRun: (runId, patch) => {
      agentCalls.push(['finishRun', runId, patch]);
      return { id: runId, ...patch };
    },
  };
  const { runtime } = createDeps({ agentTaskRuntime });
  await runtime.runMemoryUpdateAfterChat('s3', false, {}, { checkpointMessageId: 'm3' });
  assert.deepEqual(agentCalls.map(call => call[0]), [
    'startRun',
    'startStep',
    'finishStep',
    'finishRun',
  ]);
  assert.equal(agentCalls[0][1].kind, 'memory_update');
  assert.equal(agentCalls[0][1].sessionId, 's3');
  assert.equal(agentCalls[0][1].metadata.checkpointMessageId, 'm3');
  assert.equal(agentCalls[1][2].type, 'memory.update');
  assert.equal(agentCalls[2][3].status, 'succeeded');
  assert.equal(agentCalls[3][2].status, 'succeeded');
  console.log('ok - createMemoryUpdateRuntime records optional agent run lifecycle without changing memory flow');
}
