import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
const { MaidSettingsStore } = await import('../../src/scripts/storage/maid-settings-store.js');
const { createMaidCapabilityAgentTools, rollMaidRandom } = await import('../../src/scripts/agent/tools/maid-capability-tools.js');

// 可预测的随机源：依次返回给定的数
const sequence = (...values) => {
  let index = 0;
  return { getRandomValues: (buffer) => { buffer[0] = values[index++ % values.length]; return buffer; } };
};

// executeTool 返回包装：{ toolName, status, result }
const run = async (registry, name, args, context) => {
  const envelope = await registry.executeTool(name, args, context);
  return envelope?.result ? { ...envelope.result, status: envelope.status } : envelope;
};

const makeStore = async () => {
  const kv = new Map();
  const store = new MaidSettingsStore({ storage: null, loadKv: async key => kv.get(key) ?? null, saveKv: async (key, value) => { kv.set(key, value); }, now: () => 1000 });
  await store.load();
  return store;
};

{
  assert.deepEqual(rollMaidRandom({ mode: 'dice', count: 2, sides: 6 }, { random: sequence(0, 5) }).rolls, [1, 6]);
  assert.equal(rollMaidRandom({ mode: 'dice', count: 50, sides: 1 }, { random: sequence(1) }).count, 10, 'dice count and sides are clamped');
  const draw = rollMaidRandom({ mode: 'draw', options: ['甲', '乙', '丙', '乙'], pick: 2 }, { random: sequence(1, 0) });
  assert.deepEqual([draw.options, draw.picked], [['甲', '乙', '丙'], ['乙', '甲']], 'draws are without replacement over unique options');
  assert.equal(rollMaidRandom({ mode: 'choose', options: ['只有一个'] }).reason, 'too_few_options');
  let calls = 0;
  const biased = { getRandomValues: (buffer) => { buffer[0] = calls++ === 0 ? 0xffffffff : 2; return buffer; } };
  assert.deepEqual(rollMaidRandom({ mode: 'dice', sides: 6 }, { random: biased }).rolls, [3], 'values in the biased tail are rejected and redrawn');
  console.log('ok - random results are uniform, clamped and draw without replacement');
}

{
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store, random: sequence(3) }));
  const off = await run(registry, 'maid.random', { mode: 'dice' }, {});
  assert.deepEqual([off.ok, off.reason], [false, 'capability_disabled'], 'the tool rechecks the switch at execution time');

  const requests = [];
  const ask = decision => async (request) => { requests.push(request); return { decision }; };
  const declined = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random', reason: '用户想掷骰子' }, {
    operationIntentPolicy: { mode: 'read_only' }, requestToolConfirmation: ask('deny'),
  });
  assert.deepEqual([declined.ok, declined.reason, store.getBuiltinCapability('random').enabled], [false, 'capability_enable_declined', false]);
  assert.equal(requests.length, 1, 'a read-only request only asks once: the enable confirmation itself');
  assert.equal(requests[0].allowAlways, false, 'persistent enabling never offers always-allow');
  assert.equal(requests[0].details.purpose, 'persistent_enable');
  assert.match(requests[0].title, /开启「随机互动」/);

  const enabled = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    operationIntentPolicy: { mode: 'read_only' }, requestToolConfirmation: ask('allow'),
  });
  assert.deepEqual([enabled.ok, enabled.enabled, store.getBuiltinCapability('random').enabled], [true, true, true]);
  assert.deepEqual(store.getCapabilityLog().map(item => item.source), ['maid_request']);

  const rolled = await run(registry, 'maid.random', { mode: 'dice', count: 1, sides: 6 }, {});
  assert.deepEqual([rolled.ok, rolled.rolls, rolled.card.type, rolled.card.data.total], [true, [4], 'random', 4]);
  assert.ok(store.getBuiltinCapability('random').lastUsedAt > 0, 'using it records the time');

  const again = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, { requestToolConfirmation: ask('allow') });
  assert.deepEqual([again.ok, again.alreadyEnabled], [true, true]);
  assert.equal(requests.length, 2, 'an already enabled capability needs no confirmation');
  console.log('ok - enabling asks for a persistent confirmation, declines do not write, and the tool checks the live switch');
}

{
  // 确认期间用户在设置里改过开关：迟到的「允许」不写
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store }));
  const result = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    requestToolConfirmation: async () => {
      await store.setBuiltinCapabilityEnabled('random', true);
      await store.setBuiltinCapabilityEnabled('random', false);
      return { decision: 'allow' };
    },
  });
  assert.deepEqual([result.ok, result.reason, store.getBuiltinCapability('random').enabled], [false, 'revision_changed', false]);
  console.log('ok - a confirmation answered after the switch changed does not overwrite the user choice');
}

{
  // 路由：没开启的内置能力不进候选与完整功能表，改列进「可开启能力」；规划器把它写进随本次变化的部分
  const { createMaidCapabilityRoutingRuntime } = await import('../../src/scripts/agent/maid-capability-routing.js');
  const { buildMaidFeatureCatalogPrompt } = await import('../../src/scripts/agent/maid-model-planner.js');
  const { listAppFeatures } = await import('../../src/scripts/agent/app-feature-catalog.js');
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store }));
  const runtime = createMaidCapabilityRoutingRuntime({
    toolRegistry: registry,
    storage: null,
    isBuiltinCapabilityEnabled: id => store.getBuiltinCapability(id)?.enabled === true,
  });
  const decide = () => {
    const request = runtime.beginRequest({ input: '帮我掷两个骰子' });
    return runtime.prepareDecision({ requestId: request.id, input: '帮我掷两个骰子', phase: 'planner' });
  };
  const off = decide();
  assert.deepEqual(off.enableableCapabilities.map(item => [item.capabilityId, item.featureId]), [['random', 'maid.random']]);
  assert.ok(off.excluded.some(item => item.id === 'maid.random' && item.reason === 'capability_disabled'));
  assert.ok(!off.candidateFeatures.some(feature => feature.id === 'maid.random'));
  assert.ok(!off.promptFeatures.some(feature => feature.id === 'maid.random'), 'disabled capabilities are not offered as executable features');
  const prompt = buildMaidFeatureCatalogPrompt({ features: off.promptFeatures, featureIndex: listAppFeatures(), enableableCapabilities: off.enableableCapabilities });
  assert.match(prompt.detailText, /<enableable_capabilities>[\s\S]*- random：随机互动[\s\S]*maid\.capability\.request_enable/);
  assert.doesNotMatch(prompt.staticText, /enableable_capabilities/, 'the cached static prefix does not change with the switch');

  await store.setBuiltinCapabilityEnabled('random', true);
  const on = decide();
  assert.deepEqual(on.enableableCapabilities, []);
  assert.ok(on.promptFeatures.some(feature => feature.id === 'maid.random'), 'the live switch is read on every decision');
  assert.doesNotMatch(buildMaidFeatureCatalogPrompt({ features: on.promptFeatures, enableableCapabilities: on.enableableCapabilities }).detailText, /enableable_capabilities/);
  // 候选模式（手机上的设定）：口语说法要靠检索进候选，否则女仆看不到工具会自己编点数
  for (const input of ['帮我掷一个六面骰子', '帮我抽个签', '抛个硬币', '随便帮我在火锅和烧烤里选一个']) {
    const request = runtime.beginRequest({ input });
    const bounded = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner', configOverride: { mode: 'bounded' } });
    assert.equal(bounded.effectiveMode, 'candidate', input);
    assert.ok(bounded.candidateFeatures.some(feature => feature.id === 'maid.random'), input);
  }
  console.log('ok - routing offers disabled built-in capabilities only as enable-able, and reads the live switch');
}

{
  // 卡内确认带用途；确认等待期间开关在设置里被改过：旧确认自动取消，不写入
  const { createMaidToolConfirmationRuntime } = await import('../../src/scripts/ui/maid-tool-confirmation-runtime.js');
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store }));
  const confirmations = createMaidToolConfirmationRuntime({ canShowInline: () => true });
  store.subscribeCapabilities(() => confirmations.cancelWhere(request => request?.details?.purpose === 'persistent_enable'
    && store.getBuiltinCapability(request.details.capabilityId)?.revision !== request.details.revision));
  const pending = run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    runId: 'run-1', requestToolConfirmation: (request, options) => confirmations.request(request, options),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const inline = confirmations.getInline('run-1');
  assert.deepEqual([inline.purpose, inline.capabilityTitle, inline.confirmLabel, inline.cancelLabel, inline.allowAlways], ['persistent_enable', '随机互动', '确认开启', '不用了', false]);
  await store.setBuiltinCapabilityEnabled('random', true);
  assert.equal(confirmations.getInline('run-1'), null, 'the stale confirmation is withdrawn as soon as the switch changes');
  await store.setBuiltinCapabilityEnabled('random', false);
  const result = await pending;
  assert.deepEqual([result.ok, result.reason, store.getBuiltinCapability('random').enabled], [false, 'capability_enable_declined', false]);
  assert.deepEqual(store.getCapabilityLog().map(item => item.source), ['settings', 'settings'], 'only the user settings changes were written');

  // 无关变化（记录使用时间）不取消等待中的确认
  const next = run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    runId: 'run-2', requestToolConfirmation: (request, options) => confirmations.request(request, options),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await store.markBuiltinCapabilityUsed('random');
  assert.ok(confirmations.getInline('run-2'), 'a change that keeps the revision does not cancel');
  confirmations.resolve(confirmations.getInline('run-2').id, 'allow_once');
  assert.deepEqual([(await next).ok, store.getBuiltinCapability('random').enabled], [true, true]);
  console.log('ok - persistent enable confirmations carry their purpose and are withdrawn when the switch changes');
}

{
  // 语音：持久开启的确认说明会一直开着，不说成“允许一次”
  const { maidTaskUpdateText, formatMaidConfirmationUpdate } = await import('../../src/scripts/ui/realtime/realtime-maid-tools.js');
  const update = { kind: 'confirmation', task_id: 't1', request: '掷骰子', message: '开启「随机互动」？', purpose: 'persistent_enable' };
  assert.match(formatMaidConfirmationUpdate(update), /"effect":"turns a built-in capability on until/);
  assert.match(maidTaskUpdateText(update), /stays on until they turn it off/);
  assert.doesNotMatch(maidTaskUpdateText(update), /allow once/);
  assert.match(maidTaskUpdateText({ kind: 'confirmation', task_id: 't1', message: '删除？' }), /to allow once/, 'ordinary confirmations keep their wording');
  assert.doesNotMatch(formatMaidConfirmationUpdate({ kind: 'confirmation', task_id: 't1' }), /effect/);
  // GPT-Live 同样要请用户说「允许」：只说「只认允许」时，模型问完会自己接「这就开始处理」
  const { createRealtimeMaidTaskSession } = await import('../../src/scripts/ui/realtime/realtime-maid-task-session.js');
  const target = { uiMode: 'maid', sessionId: 'maid', maidCallId: 'c1' };
  const sent = [];
  const live = createRealtimeMaidTaskSession({ target, live: true, getClient: () => ({ sendEvent: event => sent.push(event) }), handleTaskRequest: async () => ({ ok: true }) });
  live.notifyTaskUpdate({ ...update, target });
  live.notifyTaskUpdate({ kind: 'confirmation', task_id: 't2', message: '删除？', target });
  assert.match(sent[0].content, /stays on until they turn it off/);
  assert.match(sent[0].content, /Tell them to say "允许"/);
  assert.match(sent[1].content, /Tell them to say "允许".*to allow once/);
  live.dispose();
  console.log('ok - voice confirmation wording distinguishes persistent enabling');
}

console.log('maid-capability-tools-tests passed');
