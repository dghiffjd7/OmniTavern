import assert from 'node:assert/strict';

import { createSessionSummaryCompactionRuntime } from '../../src/scripts/ui/chat/summary-compaction-runtime-utils.js';

{
  const calls = [];
  const chatStore = {
    getSummaries(sessionId) {
      assert.equal(sessionId, 's1');
      return [
        { text: 'a' },
        { text: 'b' },
        { text: 'c' },
      ];
    },
    getCompactedSummary() {
      return { text: 'old' };
    },
    setCompactedSummaryRaw(raw, sessionId) {
      calls.push(['raw', raw, sessionId]);
    },
    setCompactedSummary(text, sessionId, options) {
      calls.push(['set', text, sessionId, options]);
    },
    setSummaries(items, sessionId) {
      calls.push(['summaries', items, sessionId]);
    },
  };
  const updated = [];
  const runtime = createSessionSummaryCompactionRuntime({
    chatStore,
    getIsSummaryMemoryEnabled: () => true,
    getIsConfigured: () => true,
    buildMessages: () => [],
    backgroundChat: async () => '',
    buildSessionContext: (sessionId) => ({ sessionId, scope: 'chat' }),
    requestCompactionRaw: async (payload) => {
      calls.push(['request', payload.context, payload.compactedText, payload.items.length]);
      return '<details><summary>摘要</summary> 新摘要 </details>';
    },
    parseCompactionResult: () => ({ text: '新摘要', valid: true }),
    normalizeItems: items => items.map((item, index) => ({ ...item, keep: index })),
    shouldCompact: ({ items, force }) => items.length >= 3 && force === false,
    refreshChatAndContacts: () => calls.push(['refresh']),
    dispatchUpdated: (sessionId) => updated.push(sessionId),
    setTimeoutFn: async (fn) => fn(),
    delayMs: 0,
  });
  const ok = await runtime('s1');
  assert.equal(ok, true);
  assert.deepEqual(calls, [
    ['request', { sessionId: 's1', scope: 'chat' }, 'old', 3],
    ['raw', '<details><summary>摘要</summary> 新摘要 </details>', 's1'],
    ['set', '新摘要', 's1', { raw: '<details><summary>摘要</summary> 新摘要 </details>' }],
    ['summaries', [{ text: 'b', keep: 1 }, { text: 'c', keep: 2 }], 's1'],
    ['refresh'],
  ]);
  assert.deepEqual(updated, ['s1']);
  console.log('ok - createSessionSummaryCompactionRuntime compacts summaries and keeps the latest normalized snapshots');
}

{
  const failed = [];
  const runtime = createSessionSummaryCompactionRuntime({
    chatStore: {
      getSummaries() {
        return [{ text: 'a' }];
      },
      getCompactedSummary() {
        return { text: '' };
      },
      setCompactedSummary() {
        throw new Error('should not persist invalid payload');
      },
    },
    getIsSummaryMemoryEnabled: () => true,
    getIsConfigured: () => true,
    buildMessages: () => [],
    backgroundChat: async () => '',
    buildSessionContext: () => ({}),
    requestCompactionRaw: async () => '<details><summary>摘要</summary> raw </details>',
    parseCompactionResult: () => ({ text: '', valid: false }),
    normalizeItems: items => items,
    shouldCompact: () => true,
    dispatchFailed: (sessionId, reason) => failed.push([sessionId, reason]),
    setTimeoutFn: async (fn) => fn(),
    delayMs: 0,
  });
  const ok = await runtime('s2');
  assert.equal(ok, false);
  assert.deepEqual(failed, [['s2', 'missing_summary_tag']]);
  console.log('ok - createSessionSummaryCompactionRuntime reports missing summary tag failures');
}

{
  const failed = [];
  const runtime = createSessionSummaryCompactionRuntime({
    chatStore: {
      getSummaries() {
        return [{ text: 'a' }];
      },
      getCompactedSummary() {
        return { text: '' };
      },
      setCompactedSummaryRaw() {},
      setCompactedSummary() {
        throw new Error('should not persist invalid format');
      },
    },
    getIsSummaryMemoryEnabled: () => true,
    getIsConfigured: () => true,
    buildMessages: () => [],
    backgroundChat: async () => '',
    buildSessionContext: () => ({}),
    requestCompactionRaw: async () => '<details><summary>摘要</summary> raw </details>',
    parseCompactionResult: () => ({ text: '有内容', valid: false }),
    normalizeItems: items => items,
    shouldCompact: () => true,
    dispatchFailed: (sessionId, reason) => failed.push([sessionId, reason]),
    setTimeoutFn: async (fn) => fn(),
    delayMs: 0,
  });
  const ok = await runtime('s3');
  assert.equal(ok, false);
  assert.deepEqual(failed, [['s3', 'format']]);
  console.log('ok - createSessionSummaryCompactionRuntime reports invalid summary format failures');
}

{
  // 压缩失败或被取消后，不在下一轮立刻重试同一批摘要；多出足够的新摘要或手动强制时才再试。
  let items = ['a', 'b', 'c', 'd'];
  let requests = 0;
  let answer = '';
  const warnings = [];
  const runtime = createSessionSummaryCompactionRuntime({
    getIsCompactionEnabled: () => true,
    getIsConfigured: () => true,
    buildMessages: () => [],
    backgroundChat: async () => '',
    createAdapter: async () => ({ kind: 'memory_table', getItems: () => items, persist: () => {} }),
    requestCompactionRaw: async () => { requests += 1; return answer; },
    parseCompactionResult: raw => ({ text: raw, valid: Boolean(raw) }),
    shouldCompact: () => true,
    logger: { warn: (...args) => warnings.push(args), debug() {} },
    setTimeoutFn: async fn => fn(),
    delayMs: 0,
  });
  const first = await runtime('rp:a', { place: 'writing', detailed: true });
  assert.equal(first.status, 'failed');
  assert.equal(warnings.length, 1, '失败要留下记录');

  const second = await runtime('rp:a', { place: 'writing', detailed: true });
  assert.deepEqual(second, { status: 'skipped', reason: 'retry_after_unsuccessful', error: '' });
  items = [...items, 'e', 'f'];
  assert.equal((await runtime('rp:a', { place: 'writing', detailed: true })).reason, 'retry_after_unsuccessful');
  assert.equal(requests, 1, '同一批失败的摘要不能每轮都再发请求');

  items = [...items, 'g'];
  answer = '新摘要';
  assert.equal((await runtime('rp:a', { place: 'writing', detailed: true })).status, 'succeeded', '新增 3 条摘要后自动重试');
  assert.equal(requests, 2);

  // 成功后清除记录；另一个会话不受影响；手动强制不受冷却限制
  answer = '';
  assert.equal((await runtime('rp:a', { place: 'writing', detailed: true })).status, 'failed');
  assert.equal((await runtime('rp:b', { place: 'writing', detailed: true })).status, 'failed');
  assert.equal((await runtime('rp:a', { place: 'writing', detailed: true, force: true })).status, 'failed');
  assert.equal(requests, 5);
  console.log('ok - unsuccessful compaction is recorded and not retried every turn until enough new summaries arrive');
}

{
  // 被取消也算一次未成功：用户停止后下一轮不再立刻重发
  let requests = 0;
  const controller = new AbortController();
  const runtime = createSessionSummaryCompactionRuntime({
    getIsCompactionEnabled: () => true,
    getIsConfigured: () => true,
    buildMessages: () => [],
    backgroundChat: async () => '',
    createAdapter: async () => ({ kind: 'memory_table', getItems: () => ['a', 'b', 'c'], persist: () => {} }),
    requestCompactionRaw: async () => { requests += 1; controller.abort(); return 'late'; },
    parseCompactionResult: raw => ({ text: raw, valid: true }),
    shouldCompact: () => true,
    logger: { warn() {}, debug() {} },
    setTimeoutFn: async fn => fn(),
    delayMs: 0,
  });
  assert.equal((await runtime('rp:a', { place: 'writing', detailed: true, signal: controller.signal })).status, 'cancelled');
  assert.equal((await runtime('rp:a', { place: 'writing', detailed: true })).reason, 'retry_after_unsuccessful');
  assert.equal(requests, 1);
  console.log('ok - a cancelled compaction is not resent on the next turn');
}

{
  // 表格适配器自带条数判断时以它为准；请求选项（模型）与运行记录由外部提供。
  const events = [];
  const adapter = {
    kind: 'memory_table',
    getItems: async () => [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 'c', text: 'z' }],
    shouldCompact: ({ items }) => items.length >= 3,
    persist: async () => events.push(['persist']),
  };
  const make = (overrides = {}) => createSessionSummaryCompactionRuntime({
    getIsCompactionEnabled: () => true,
    createAdapter: async () => adapter,
    buildMessages: () => [],
    backgroundChat: async () => '',
    requestCompactionRaw: async ({ options }) => { events.push(['request', options]); return 'raw'; },
    parseCompactionResult: () => ({ text: '新', valid: true }),
    shouldCompact: () => false,
    resolveRequestOptions: async ({ sessionId, place }) => ({ runtimeConfigOverride: { model: `m-${sessionId}-${place}` } }),
    onRunStart: async info => { events.push(['start', info]); return 'run-1'; },
    onRunFinish: async (handle, info) => events.push(['finish', handle, info]),
    setTimeoutFn: async fn => fn(),
    delayMs: 0,
    ...overrides,
  });
  assert.equal(await make()('rp:s', { place: 'writing' }), true);
  assert.deepEqual(events, [
    ['start', { sessionId: 'rp:s', place: 'writing', itemCount: 3, managed: false }],
    ['request', { presetContext: { sessionId: 'rp:s', uiMode: 'rp' }, runtimeConfigOverride: { model: 'm-rp:s-writing' }, temperature: 0.2 }],
    ['persist'],
    ['finish', 'run-1', { status: 'succeeded', reason: '', error: '' }],
  ], '按目标会话决定模型；运行开始、结束都有记录');

  events.length = 0;
  await make({ requestCompactionRaw: async () => '' })('chat:s', { place: 'chat' });
  assert.deepEqual(events.map(e => e[0]), ['start', 'finish']);
  assert.deepEqual(events[1][2], { status: 'failed', reason: 'empty_response', error: '' });

  events.length = 0;
  const few = { ...adapter, getItems: async () => [{ id: 'a', text: 'x'.repeat(5000) }] };
  assert.equal(await make({ createAdapter: async () => few })('chat:s2', { place: 'chat' }), false);
  assert.deepEqual(events, [], '条数未满时不请求、也不记运行');

  events.length = 0;
  const controller = new AbortController();
  await make()('rp:s3', { place: 'writing', signal: controller.signal, detailed: true });
  assert.equal(events[0][1].managed, true, '跳房子带 signal 调用时由它自己显示进度');
  assert.equal(events[1][1].signal, controller.signal);
  console.log('ok - summary compaction runtime uses the adapter row-count check, per-session request options and run hooks');
}
