import assert from 'node:assert/strict';
import { createMaidVoiceTaskRuntime } from '../../src/scripts/ui/maid-voice-task-runtime.js';
import { createMaidCommandSubmit } from '../../src/scripts/ui/maid-command-submit-runtime.js';
import { createMaidVoiceRuntime } from '../../src/scripts/ui/maid-voice-runtime.js';
import { createRealtimeCallAppRuntime } from '../../src/scripts/ui/realtime/realtime-call-app-runtime.js';
import { createRealtimeMaidTaskSession } from '../../src/scripts/ui/realtime/realtime-maid-task-session.js';
import { createMaidRealtimeTools, assertMaidRealtimeCapability, resolveMaidLiveControl } from '../../src/scripts/ui/realtime/realtime-maid-tools.js';
import { createJsonRealtimeProtocol } from '../../src/scripts/ui/realtime/realtime-json-protocol.js';
import { createGeminiLiveProtocol } from '../../src/scripts/ui/realtime/realtime-gemini-protocol.js';
import { createNovaSonicProtocol } from '../../src/scripts/ui/realtime/realtime-nova-protocol.js';
import { buildOpenAiLiveSessionConfig } from '../../src/scripts/ui/realtime/openai-live-config.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { resolvePendingMaidAction } from '../../src/scripts/agent/maid-pending-action.js';
import { createVoiceAwareMaidRuntimeResolver, createVoiceTaskModelRegistry } from '../../src/scripts/ui/realtime/voice-task-model.js';
import { readFile } from 'node:fs/promises';
import { createPresetRegexScriptAgentTools } from '../../src/scripts/agent/tools/preset-regex-script-tools.js';
import { createMaidToolConfirmationRuntime } from '../../src/scripts/ui/maid-tool-confirmation-runtime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const target = { supported: true, sessionId: 'maid', uiMode: 'maid', maidCallId: 'call-one' };

{
  let context = { sessionId: 'original', userSelection: [{ id: 'image-one' }] }, seq = 0;
  const queue = [], completed = [];
  const command = { isSubmitting: () => queue.length > 0,
    submitVoiceTask: (text, options) => { const done = deferred(); queue.push({ text, options, done }); return done.promise; },
    cancelSubmission: id => { const entry = queue.find(item => item.options.id === id); if (!entry) return false; entry.cancelled = true; return true; },
  };
  const tasks = createMaidVoiceTaskRuntime({ getCommandRuntime: () => command, captureContext: () => context, makeId: () => `task-${++seq}`, onResult: value => completed.push(value) });
  const first = await tasks.request({ target, requestId: 'request-one', args: { action: 'execute', request: '修改这张图' }, attachments: [{ id: 'ref-one', url: 'data:image/png;base64,AA==' }] });
  assert(first.accepted); assert.equal(queue.length, 1); assert.equal(queue[0].options.showInput, false);
  context.userSelection[0].id = 'another-image'; context.sessionId = 'another-room';
  assert.equal(queue[0].options.context.sessionId, 'original'); assert.equal(queue[0].options.context.userSelection[0].id, 'image-one');
  await tasks.request({ target, requestId: 'request-one', args: { action: 'execute', request: '重复事件' } }); assert.equal(queue.length, 1);
  const progress = await tasks.request({ target, args: { action: 'status' } }); assert.equal(progress.active[0].task_id, first.task_id);
  const revision = await tasks.request({ target, requestId: 'revision', args: { action: 'revise', request: '改成蓝色' } });
  assert(revision.accepted); assert(queue[0].cancelled); assert.equal(queue[1].options.context.sessionId, 'original');
  assert.deepEqual(queue[1].options.attachments, queue[0].options.attachments, 'revised image tasks retain their reference attachments');
  assert.match(queue[1].text, /修改这张图.*\n.*用户修正：改成蓝色/s);
  assert.equal(completed.length, 0, 'revision is accepted before old task drains');
  queue[0].done.resolve({ cancelled: true }); queue[1].done.resolve({ ok: true, message: '已改成蓝色' }); await tick();
  assert.equal(completed.length, 1, 'superseded cancellation is not spoken over the revision');
  const third = await tasks.request({ target, requestId: 'three', args: { request: '另一个任务' } });
  assert.equal(queue[2].options.context.sessionId, 'another-room');
  const stopped = await tasks.request({ target, args: { action: 'cancel', task_id: third.task_id } }); assert.equal(stopped.cancelled, 1);
  queue[2].done.resolve({ ok: false, status: 'cancelled' }); await tick(); assert.equal(tasks.getState().active.length, 0);
  await tasks.request({ target, args: { action: 'execute', request: '继续修改那张图', task_id: revision.task_id } });
  assert.equal(queue[3].options.context.sessionId, 'original'); assert.equal(queue[3].options.attachments[0].id, 'ref-one');
  queue[3].done.resolve({ ok: true }); await tick();
}

{
  const contexts = [], saved = []; let ended = 0, cancelledInput = 0, confirmed = 0;
  const submit = createMaidCommandSubmit({
    getVoiceRuntime: () => ({ cancelInput: async () => cancelledInput++, endCall: async () => ended++ }), getOnboardingRuntime: () => null,
    matchMaidIntent: () => null, hasConfiguredMaidProfile: () => true, resolveMaidRuntimeConfig: async () => ({ configured: true }), logger: {},
    checkMaidVisionInput: async () => ({ ok: true }), maidSettingsStore: { setLastExchange() {}, getLastExchange: () => ({ source: 'done', requestPrompt: 'sent' }) },
    buildAppFeatureSearchContextText: () => '', getAppContext: () => ({ sessionId: 'current-room', activePage: 'current-page' }),
    maidAssistantAgent: { runPrompt: async (_, context) => { contexts.push(context); await context.requestToolConfirmation(); return { ok: true, message: 'verified', status: 'succeeded' }; } },
    resolveSelectionRegion: () => ({}), requestMaidToolConfirmation: async () => confirmed++, recordMaidTurnFromResult: async value => saved.push(value), toast: {},
  });
  await submit('normal');
  await submit('voice', { source: 'maid_realtime', context: { sessionId: 'accepted-room', activePage: 'accepted-page' }, voiceCallId: 'call', voiceRequestId: 'req' });
  assert.equal(ended, 1); assert.equal(cancelledInput, 2); assert.equal(confirmed, 2, 'existing confirmation hook is retained');
  assert.equal(contexts[1].sessionId, 'accepted-room'); assert.equal(contexts[1].activePage, 'accepted-page');
  assert.equal(saved[1].input, ''); assert.equal(saved[1].context.voiceRequestText, 'voice'); assert.equal(saved[1].context.voiceRequestId, 'req');
}

// The real app/call/maid runtimes share a fake transport and an application queue.
// No microphone, credentials or persistent profile data are used.
{
  let app, voice, callbacks, payload, closes = 0, collapsed = 0, page = 'first-page';
  const sent = [], submitted = [], surfaces = [], persisted = [];
  const surface = { show: () => surfaces.push('orb-show'), hide() {}, renderState() {}, setTasks() {}, setUsage() {}, setWarning() {}, setCaption() {}, setAudioLevel() {} };
  const command = { syncVoiceState() {}, collapse: () => collapsed++, isSubmitting: () => submitted.length > 0,
    submitVoiceTask: (text, options) => { const done = deferred(); submitted.push({ text, options, done }); return done.promise; },
  };
  voice = createMaidVoiceRuntime({ settingsStore: { getVoiceInputMode: () => 'realtime', getMaidPrompt: () => 'Maid', hasChosenVoiceTaskExecutor: () => true },
    conversationStore: { upsertRealtimeTranscript: async value => { persisted.push(value); return { messageId: value.id }; }, finalizeRealtimeConversation: async () => {} },
    prepareConversationContext: async () => ({}), getAppContext: () => ({ sessionId: 'original-room', activePage: page }),
    getCommandRuntime: () => command, getCallAppRuntime: () => app, createOrb: () => surface,
  });
  app = createRealtimeCallAppRuntime({ documentRef: null, windowLike: null, getCallTarget: () => voice.getTarget(),
    getMaidSurface: () => surface, createPanel: () => ({ show: () => surfaces.push('chat-show'), hide() {}, destroy() {} }),
    beforeStart: value => voice.beforeRealtimeStart(value), onStateChange: value => voice.onCallState(value),
    handleMaidTaskRequest: value => voice.handleTaskRequest(value), buildSemanticSnapshot: value => voice.buildSemanticSnapshot(value),
    isTargetCurrent: value => voice.isTargetCurrent(value), commitUserMessage: value => voice.commitUserMessage(value), commitAssistantMessage: value => voice.commitAssistantMessage(value),
    resolveConnection: async () => ({ config: { provider: 'openai' }, settings: { realtimeModel: 'gpt-realtime-2.1' } }),
    createSessionClient: options => { callbacks = options; return { connect: async value => { payload = value; }, close: async () => closes++, sendEvent: value => sent.push(value), setMicrophoneMuted: () => true }; },
  });
  assert.equal(await voice.action('realtime'), true); assert(collapsed); assert.deepEqual(surfaces, ['orb-show']);
  assert.equal(payload.sessionConfig.tools[0].name, 'maid_task');
  const emit = callbacks.onEvent;
  emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-one', transcript: '打开设置' }); await app.runtime.whenIdle();
  const call = { type: 'function_call', call_id: 'tool-one', name: 'maid_task', arguments: JSON.stringify({ action: 'execute', request: '打开设置' }) };
  emit({ type: 'response.created', response: { id: 'r-one' } });
  emit({ type: 'response.function_call_arguments.done', response_id: 'r-one', ...call });
  assert.equal(submitted.length, 0, 'partial or interrupted responses do not execute');
  const done = { type: 'response.done', response: { id: 'r-one', status: 'completed', output: [call] } };
  emit(done); emit(done); await tick();
  assert.equal(submitted.length, 1); assert.equal(closes, 0); assert(voice.isCallActive());
  assert(sent.some(event => event.item?.type === 'function_call_output' && JSON.parse(event.item.output).accepted));
  page = 'second-page'; assert.equal(submitted[0].options.context.activePage, 'first-page');
  emit({ type: 'response.created', response: { id: 'ack' } });
  submitted[0].done.resolve({ ok: true, message: '设置已打开' }); await tick();
  assert(!sent.some(event => event.item?.content?.[0]?.text?.includes('设置已打开')), 'actual result waits for current speech');
  emit({ type: 'response.done', response: { id: 'ack', status: 'completed' } }); await tick();
  assert(sent.some(event => event.item?.content?.[0]?.text?.includes('设置已打开')));
  emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'user-two', transcript: '下一个任务' }); await app.runtime.whenIdle();
  emit({ type: 'response.created', response: { id: 'two' } });
  emit({ type: 'response.done', response: { id: 'two', status: 'completed', output: [{ ...call, call_id: 'tool-two', arguments: '{"action":"execute","request":"下一个任务"}' }] } }); await tick();
  assert.equal(submitted.length, 2); assert.equal(submitted[1].options.context.activePage, 'second-page');
  await voice.endCall(); assert.equal(closes, 1); const count = sent.length;
  submitted[1].done.resolve({ ok: true, message: '后台任务完成' }); await tick();
  assert.equal(voice.getTasks().active.length, 0); assert.equal(sent.length, count, 'hanging up retains work but suppresses late speech');
  await app.destroy();
}

{
  const sent = [], requests = [];
  const session = createRealtimeMaidTaskSession({ target, getClient: () => ({ sendEvent: event => sent.push(event) }), handleTaskRequest: async value => { requests.push(value); return { ok: true, accepted: true }; } });
  session.handle({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u', transcript: 'stop' });
  session.handle({ type: 'response.created', response: { id: 'r' } });
  session.handle({ type: 'response.done', response: { id: 'r', status: 'completed', output: [
    { type: 'function_call', call_id: 'a', name: 'maid_task', arguments: '{"action":"status"}' },
    { type: 'function_call', call_id: 'b', name: 'maid_task', arguments: '{"action":"cancel"}' },
  ] } }); await tick();
  assert.equal(requests.length, 2); assert.equal(sent.filter(event => event.type === 'response.create').length, 1, 'parallel tools resume once after all results');
  assert.equal(sent.filter(event => event.item?.type === 'function_call_output').length, 2);
  session.handle({ type: 'response.done', response: { id: 'bad', status: 'cancelled', output: [{ type: 'function_call', call_id: 'bad', name: 'maid_task', arguments: '{}' }] } }); await tick();
  assert.equal(requests.length, 2); session.dispose();
}

{
  assert.equal(buildOpenAiLiveSessionConfig({ maidTasks: true }).delegation.type, 'client');
  assert.equal(resolveMaidLiveControl('请把当前任务停止').action, 'cancel');
  assert.equal(resolveMaidLiveControl('停止全部任务').scope, 'all');
  assert.equal(resolveMaidLiveControl('现在做到哪一步了？').action, 'status');
  assert.equal(resolveMaidLiveControl('不对，改成蓝色').action, 'revise');
  assert.equal(resolveMaidLiveControl('不要取消任务').action, 'execute');
  assert.equal(buildOpenAiLiveSessionConfig({}).delegation.type, 'responses');
  const sent = [], requests = [], timers = new Map(), groups = [{ role: 'user', fragments: [] }]; let sequence = 0;
  const session = createRealtimeMaidTaskSession({ target, live: true, getClient: () => ({ sendEvent: event => sent.push(event) }),
    getLiveGroups: () => groups, handleTaskRequest: async value => { requests.push(value); return { ok: true, accepted: true, task_id: 'live-task' }; },
    setTimeoutFn: (fn, ms) => { const id = ++sequence; timers.set(id, { fn, ms }); return id; }, clearTimeoutFn: id => timers.delete(id),
  });
  const settle = async () => { for (const [id, timer] of timers) if (timer.ms === 250) { timers.delete(id); timer.fn(); } await tick(); };
  groups[0].fragments.push({ delta: '打开', startMs: 0, endMs: 100 }); session.handle({ type: 'session.input_transcript.delta' });
  assert.equal(requests.length, 0, 'a transcript fragment never submits work');
  session.handle({ type: 'session.delegation.created', offset_ms: 400, delegation: { id: 'delegation', target: 'client' } });
  groups[0].fragments.push({ delta: '设置', startMs: 100, endMs: 400 }); session.handle({ type: 'session.input_transcript.delta' }); await settle();
  assert.equal(requests[0].args.request, '打开设置');
  session.handle({ type: 'session.delegation.created', offset_ms: 400, delegation: { id: 'delegation', target: 'client' } }); await settle(); assert.equal(requests.length, 1);
  session.notifyTaskUpdate({ target, requestId: 'delegation', task_id: 'live-task', status: 'succeeded', request: '长请求'.repeat(200), message: '完成' });
  assert(sent.some(event => event.type === 'session.commentary.append' && event.delegation_id === 'delegation' && event.content.includes('完成')));
  session.dispose(); assert.equal(timers.size, 0);
}

{
  const tools = createMaidRealtimeTools(), result = { ok: true, accepted: true, task_id: 'app-task' }, call = { id: 'provider-call', name: 'maid_task', arguments: { action: 'execute', request: 'open settings' } };
  for (const provider of ['xai_voice', 'qwen_audio_realtime', 'step_realtime']) {
    const sent = [], protocol = createJsonRealtimeProtocol({ profile: { provider, maidTools: tools }, instructions: 'test', send: value => sent.push(value), emit() {}, ready() {}, clear() {}, play() {} });
    protocol.start(); const tool = sent[0].session.tools[0]; assert.equal(provider === 'xai_voice' ? tool.name : tool.function.name, 'maid_task');
    protocol.toolResults([{ call, result }]); protocol.taskUpdate('actual result'); protocol.respond();
    assert.equal(sent[1].item.call_id, call.id); assert.equal(JSON.parse(sent[1].item.output).task_id, 'app-task'); assert.equal(sent.at(-1).type, 'response.create');
    // Step 拒收 system 角色（400 "item.role must be user or assistant" 并断线），任务更新须以 user 角色发送
    assert.equal(sent[2].item.role, provider === 'step_realtime' ? 'user' : 'system', `${provider} task update role`);
    assert.equal(sent[2].item.content[0].text, 'actual result');
  }
  const sent = [], events = [];
  const gemini = createGeminiLiveProtocol({ profile: { provider: 'gemini_live', model: 'gemini-3.1-flash-live-preview', maidTools: tools }, instructions: 'test', send: value => sent.push(value), emit: value => events.push(value), ready() {}, play() {}, clear() {} });
  gemini.start(); assert.equal(sent[0].setup.tools[0].functionDeclarations[0].name, 'maid_task');
  gemini.receive({ toolCall: { functionCalls: [{ id: call.id, name: call.name, args: call.arguments }] } }); assert.equal(events[0].type, 'maid.tools.requested');
  gemini.toolResults([{ call, result }]); assert.deepEqual(sent[1].toolResponse.functionResponses[0], { id: call.id, name: call.name, response: result });
  gemini.taskUpdate('finished'); assert.equal(sent[2].clientContent.turnComplete, true);
  const novaSent = [], novaEvents = [];
  const nova = createNovaSonicProtocol({ profile: { provider: 'nova_sonic', maidTools: tools }, instructions: 'test', send: value => novaSent.push(value), emit: value => novaEvents.push(value), ready() {}, play() {}, clear() {} });
  nova.start(); assert.equal(JSON.parse(novaSent[1].event.promptStart.toolConfiguration.tools[0].toolSpec.inputSchema.json).type, 'object');
  nova.receive({ event: { contentStart: { contentId: 'tool-content', role: 'TOOL', type: 'TOOL' } } });
  nova.receive({ event: { toolUse: { contentId: 'tool-content', toolUseId: call.id, toolName: call.name, content: JSON.stringify(call.arguments) } } });
  assert.equal(novaEvents.length, 0); nova.receive({ event: { contentEnd: { contentId: 'tool-content', stopReason: 'TOOL_USE' } } }); assert.equal(novaEvents[0].calls[0].id, call.id);
  nova.toolResults([{ call, result }]); assert(novaSent.some(event => event.event.contentStart?.toolResultInputConfiguration?.toolUseId === call.id));
  assert(novaSent.some(event => event.event.toolResult?.content === JSON.stringify(result)));
  assert.throws(() => assertMaidRealtimeCapability({ provider: 'doubao_realtime' }), error => error.code === 'realtime_config_maid_tools_unsupported');
}

{
  const observed = [], logger = { warn() {}, debug() {} };
  const registry = createAgentToolRegistry({ permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) }, logger });
  registry.register({ name: 'test.voice_target', title: 'Read target', description: 'Read a session', permissions: [], riskLevel: 'low',
    schema: { type: 'object', properties: { sessionId: { type: 'string' } } },
    capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'never' },
    execute: async args => { observed.push(args); return { ok: true, summary: 'read' }; },
  });
  const store = new AgentRunStore(); const taskRuntime = createAgentTaskRuntime({ store, toolRegistry: registry, logger });
  for (const [source, args] of [['maid_realtime', {}], ['maid_realtime', { sessionId: 'explicit-room' }], ['command', {}]]) {
    const agent = createMaidAssistantAgent({ toolRegistry: registry, agentTaskRuntime: taskRuntime, logger,
      planner: async () => ({ ok: true, action: 'tool', toolName: 'test.voice_target', args }),
      reactPlanner: async () => ({ ok: true, action: 'final', response: '已读取' }),
    });
    await agent.runPrompt('读取这个会话', { source, voiceCallId: source === 'maid_realtime' ? 'call' : '', submissionId: 'voice-task', sessionId: 'accepted-room' });
  }
  assert.equal(observed[0].sessionId, 'accepted-room'); assert.equal(observed[1].sessionId, 'explicit-room'); assert.equal(observed[2].sessionId, undefined);
  assert(store.listRuns().some(run => run.metadata?.submissionSource === 'maid_realtime' && run.metadata.submissionId === 'voice-task'));
}

// 真实 resolver + 提交入口：未绑定女仆主档仍可使用冻结的语音执行档，视觉门禁用同一配置。
{
  const registry = createVoiceTaskModelRegistry();
  registry.remember('voice-only', { config: { provider: 'openai', model: 'voice-text-model', apiKey: 'offline-placeholder' } });
  const resolveRuntime = createVoiceAwareMaidRuntimeResolver({ resolveMaidRuntime: async () => ({ configured: false }), registry, createClient: config => ({ config }) });
  const contexts = [], visionModels = [];
  const submit = createMaidCommandSubmit({
    getVoiceRuntime: () => ({ cancelInput: async () => {}, endCall: async () => {} }), matchMaidIntent: () => null, resolveMaidRuntimeConfig: resolveRuntime,
    checkMaidVisionInput: async (_attachments, context, runtime) => { visionModels.push(runtime.config.model); assert.equal(context.sessionId, 'original-room'); return { ok: true }; },
    getAppContext: () => ({ sessionId: 'new-room' }), maidSettingsStore: { setLastExchange() {}, getLastExchange: () => ({ source: 'done', requestPrompt: 'sent' }) },
    buildAppFeatureSearchContextText: () => '', recordMaidTurnFromResult: async () => {}, logger: { debug() {} },
    maidAssistantAgent: { runPrompt: async (_text, context) => { contexts.push(context); return { ok: true }; } },
  });
  await submit('查看附图', { source: 'maid_realtime', voiceCallId: 'voice-only', context: { sessionId: 'original-room' }, attachments: [{ kind: 'image', url: 'data:image/png;base64,AA==' }] });
  assert.equal(contexts.length, 1);
  assert.deepEqual(visionModels, ['voice-text-model']);
  assert.equal((await submit('普通文字任务', {})).responseType, 'local', 'typing still requires its own configured maid profile');
  const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const submitWiring = appSource.slice(appSource.indexOf('onSubmit: createMaidCommandSubmit('), appSource.indexOf('onCancelActive:', appSource.indexOf('onSubmit: createMaidCommandSubmit(')));
  assert.match(submitWiring, /resolveMaidRuntimeConfig:\s*resolveMaidTaskRuntimeConfig/);
}

// 删除预览释放普通任务队列后，语音确认/取消仍要作用于该通话的原任务。
const setupPendingVoice = () => {
  const deleted = [], logger = { warn() {}, debug() {} }, registry = createAgentToolRegistry({ logger });
  registry.register({ name: 'regex.delete_many', title: 'Delete regex', description: 'Delete regex', permissions: [], riskLevel: 'high',
    schema: { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, preview: { type: 'boolean' } } },
    execute: async args => args.preview
      ? { ok: true, preview: true, plannedCount: 1, items: [{ id: 'original', name: '原项目', status: 'planned' }] }
      : (deleted.push(...args.targets), { ok: true, results: args.targets.map(id => ({ id, target: id, name: id, status: 'succeeded' })) }),
  });
  const store = new AgentRunStore();
  const agent = createMaidAssistantAgent({ toolRegistry: registry, agentTaskRuntime: createAgentTaskRuntime({ store, toolRegistry: registry, logger }), logger,
    planner: async input => input.includes('删除')
      ? { ok: true, toolName: 'regex.delete_many', featureId: 'regex.delete_many', args: { targets: ['原项目'], preview: true } }
      : { ok: true, action: 'final', message: '普通答复' },
    reactPlanner: async () => ({ ok: true, action: 'final', message: '本轮结束' }),
  });
  let seq = 0, finish = () => {}, currentRoom = 'room-a';
  const submitted = [];
  const voice = createMaidVoiceTaskRuntime({ makeId: () => `task-${++seq}`, captureContext: () => ({ sessionId: currentRoom }),
    cancelPendingAction: options => agent.cancelPendingAction(options),
    getCommandRuntime: () => ({ submitVoiceTask: (input, options) => { submitted.push(options); return agent.runPrompt(input, { ...options.context, source: options.source, voiceCallId: options.voiceCallId, submissionId: options.id }); },
      cancelSubmission: async () => false,
    }), onResult: update => finish(update.result),
  });
  const request = async (input, callId = 'call-one', args = resolveMaidLiveControl(input)) => {
    const completed = new Promise(resolve => { finish = resolve; });
    const accepted = await voice.request({ target: { maidCallId: callId }, requestId: `req-${++seq}`, inputText: input, args });
    return accepted.accepted ? completed : accepted;
  };
  return { agent, voice, store, request, deleted, submitted, setRoom: id => { currentRoom = id; } };
};
{
  const env = setupPendingVoice();
  assert.equal((await env.request('删除原项目')).status, 'awaiting_confirmation');
  assert.equal((await env.request('取消任务')).cancelled, 1);
  assert.equal(resolvePendingMaidAction(env.store.listRuns()), null);
  await env.request('确认后执行');
  assert.deepEqual(env.deleted, [], 'later confirmation cannot revive a cancelled preview');
}
for (const answer of ['允许', '允許', 'allow', '允许一次', 'allow once', '']) {
  const env = setupPendingVoice();
  await env.request('删除原项目');
  env.setRoom('room-b');
  await env.request(answer, 'call-one', answer ? resolveMaidLiveControl(answer) : { action: 'confirm' });
  assert.deepEqual(env.deleted, ['original'], answer);
  assert.equal(env.submitted.at(-1).context.sessionId, 'room-a');
  assert.equal(env.submitted.at(-1).context.pendingActionSubmissionId, env.submitted[0].id);
  assert.equal(resolvePendingMaidAction(env.store.listRuns()), null);
}
{
  const env = setupPendingVoice();
  await env.request('删除原项目');
  assert.equal((await env.request('取消任务', 'another-call')).cancelled, 0);
  await env.request('允许', 'another-call');
  assert.deepEqual(env.deleted, []);
  assert.ok(resolvePendingMaidAction(env.store.listRuns(), { context: { voiceCallId: 'call-one' } }), 'another call neither consumes nor supersedes the old preview');
  await env.request('允许');
  assert.deepEqual(env.deleted, ['original']);
}
console.log('ok - voice preview confirmation/cancellation retains task ownership and frozen context');

// Exercise the real pending workflow, delete tool and APP safety gate in memory.
const setupConfirmation = ({ gate = null } = {}) => {
  const sets = [{ id: 'a', name: 'first', rules: [] }, { id: 'b', name: 'second', rules: [] }];
  const deleted = [], confirmations = [], submissions = [], updates = [];
  const logger = { warn() {}, debug() {} };
  const registry = createAgentToolRegistry({ logger });
  registry.registerMany(createPresetRegexScriptAgentTools({ regexStore: {
    getGlobal: () => ({ rules: [] }), listLocalSets: () => sets,
    getLocalSet: id => sets.find(item => item.id === id), getSession: () => ({ rules: [] }),
    removeLocalSet: async id => { deleted.push(id); sets.splice(sets.findIndex(item => item.id === id), 1); },
  } }));
  const store = new AgentRunStore();
  const context = { sessionId: 'original-room', requestToolConfirmation: request => { confirmations.push(request); return { decision: 'allow' }; } };
  const agent = createMaidAssistantAgent({ toolRegistry: registry,
    agentTaskRuntime: createAgentTaskRuntime({ store, toolRegistry: registry, logger }), logger,
    planner: async input => input.includes('删除')
      ? { ok: true, toolName: 'regex.delete_many', featureId: 'regex.delete_many', args: { targets: input.includes('保留第二个') ? ['first'] : ['first', 'second'], preview: true } }
      : { ok: true, action: 'final', message: '请说明任务' },
    reactPlanner: async () => ({ ok: true, action: 'final', message: '本轮完成。' }),
  });
  let serial = Promise.resolve(), seq = 0;
  const results = new Map(), waiters = new Map();
  const voice = createMaidVoiceTaskRuntime({ makeId: () => `confirm-${++seq}`, captureContext: () => ({ sessionId: 'original-room' }),
    cancelPendingAction: options => agent.cancelPendingAction(options),
    getCommandRuntime: () => ({ submitVoiceTask: (input, options) => {
      submissions.push({ input, options });
      const job = serial.then(async () => {
        if (gate && input === '确认') await gate.promise;
        return agent.runPrompt(input, { ...context, ...options.context, source: options.source, voiceCallId: options.voiceCallId, submissionId: options.id });
      });
      serial = job.catch(() => {});
      return job;
    } }),
    onResult: update => { updates.push(update); results.set(update.task_id, update.result); waiters.get(update.task_id)?.(update.result); },
  });
  const request = (input, args = resolveMaidLiveControl(input)) => voice.request({ target, requestId: `confirm-request-${++seq}`, inputText: input, args });
  const resultOf = ack => results.has(ack.task_id) ? Promise.resolve(results.get(ack.task_id)) : new Promise(resolve => waiters.set(ack.task_id, resolve));
  const preview = async () => { const ack = await request('删除 first 和 second，先预览'); assert.equal((await resultOf(ack)).status, 'awaiting_confirmation'); return ack; };
  return { agent, voice, request, resultOf, preview, context, sets, deleted, confirmations, submissions, updates };
};

for (const normalized of [false, true]) {
  const env = setupConfirmation();
  await env.preview();
  const input = '允许，但保留第二个';
  const revised = await env.request(input, { action: 'confirm', request: normalized ? '允许' : input });
  assert.equal((await env.resultOf(revised)).status, 'awaiting_confirmation');
  assert.match(env.submissions.at(-1).input, /用户修正：允许，但保留第二个/);
  assert.equal(env.confirmations.length, 0, 'conditional permission must not reach the deletion gate');
  assert.deepEqual(env.deleted, []);
  await env.resultOf(await env.request('允许'));
  assert.deepEqual(env.deleted, ['a']);
  assert.equal(env.sets[0].id, 'b');
  assert.equal(env.confirmations.length, 1);
}
{
  const env = setupConfirmation(), original = await env.preview();
  await env.agent.runPrompt('确认', { ...env.context, sessionId: 'another-room' });
  assert.deepEqual(env.deleted, [], 'bare text after hangup cannot confirm a voice preview');
  assert.equal(env.confirmations.length, 0);
  await env.agent.runPrompt('确认', { ...env.context, pendingActionSubmissionId: original.task_id });
  assert.deepEqual(env.deleted, ['a', 'b'], 'an explicitly selected task can resume through the APP confirmation');
}
{
  const gate = deferred(), env = setupConfirmation({ gate });
  const original = await env.preview();
  const first = await env.request('允许'), second = await env.request('允许', { action: 'confirm', task_id: original.task_id });
  assert.equal(second.task_id, first.task_id);
  assert.equal(second.reused, true);
  assert.equal(env.submissions.length, 2, 'preview plus exactly one continuation');
  assert.equal((await env.request('允许')).task_id, first.task_id, 'bare duplicate also reuses the continuation');
  gate.resolve();
  assert.equal((await env.resultOf(first)).ok, true);
  assert.deepEqual(env.deleted, ['a', 'b']);
  assert.equal(env.confirmations.length, 1);
  const completed = await env.request('允许');
  assert.equal(completed.reused, true);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.accepted, false);
  assert.equal(env.updates.length, 2, 'no misleading second completion is emitted');
}
{
  const env = setupConfirmation();
  await env.preview();
  assert.equal((await env.request('好', { action: 'confirm', request: '好' })).accepted, undefined);
  assert.equal(env.submissions.length, 1);
  await env.resultOf(await env.request('允许'));
  assert.deepEqual(env.deleted, ['a', 'b']);
}
{
  const queue = [], approvals = createMaidToolConfirmationRuntime({ canShowInline: () => true });
  const controller = new AbortController();
  let seq = 0;
  const voice = createMaidVoiceTaskRuntime({ makeId: () => `inline-${++seq}`,
    getCommandRuntime: () => ({
      submitVoiceTask: (input, options) => { const done = deferred(); queue.push({ input, options, done }); return done.promise; },
      cancelSubmission: () => { controller.abort(); queue[0].done.resolve({ status: 'cancelled' }); return true; },
    }), confirmApproval: ids => approvals.confirmByVoice(ids),
  });
  const task = await voice.request({ target, args: { action: 'execute', request: '删除两个项目' } });
  const decision = approvals.request({ kind: 'delete_fixture', operationType: 'delete' }, { runId: task.task_id, signal: controller.signal });
  await voice.request({ target, inputText: '允许，但保留第二个', args: { action: 'confirm', request: '允许' } });
  assert.equal((await decision).decision, 'deny', 'revision aborts the existing real inline approval');
  assert.match(queue[1].input, /用户修正：允许，但保留第二个/);
  queue[1].done.resolve({ ok: true });
  await tick();
}
{
  const submitted = [];
  let seq = 0;
  const voice = createMaidVoiceTaskRuntime({ makeId: () => `import-${++seq}`,
    getCommandRuntime: () => ({ submitVoiceTask: async input => {
      submitted.push(input);
      return submitted.length === 1 ? { ok: true, status: 'awaiting_confirmation', pendingWorkflow: { kind: 'imported_card_session_setup' } } : { ok: true };
    } }),
  });
  await voice.request({ target, args: { action: 'execute', request: '导入卡建房' } });
  await tick();
  await voice.request({ target, inputText: '可以', args: { action: 'confirm', request: '可以' } });
  await tick();
  assert.deepEqual(submitted, ['导入卡建房', '可以'], 'low-risk imported-card confirmation remains lenient');
}
console.log('ok - conditional permissions revise, repeated permissions reuse results, text scopes are isolated and imports stay lenient');

{
  // 带条件的确认/取消作用于正在等待确认的任务；引用已完成的续接任务继续做事时不继承续接授权
  let seq = 0;
  const queue = [], cancelledPending = [];
  const command = { isSubmitting: () => false,
    submitVoiceTask: (text, options) => { const done = deferred(); queue.push({ text, options, done }); return done.promise; },
    cancelSubmission: id => { const entry = queue.find(item => item.options.id === id); if (!entry) return false; entry.cancelled = true; return true; },
  };
  const tasks = createMaidVoiceTaskRuntime({ getCommandRuntime: () => command, captureContext: () => ({ sessionId: 'room-a' }), makeId: () => `task-${++seq}`,
    cancelPendingAction: ({ submissionId }) => { cancelledPending.push(submissionId); return true; } });
  await tasks.request({ target, requestId: 'preview', args: { action: 'execute', request: '删除规则集甲和乙' } });
  queue[0].done.resolve({ ok: true, status: 'awaiting_confirmation', message: '请确认', pendingWorkflow: { kind: 'maid_pending_action' } }); await tick();
  await tasks.request({ target, requestId: 'other', args: { action: 'execute', request: '打开设置' } });
  const revised = await tasks.request({ target, requestId: 'cond', inputText: '允许，但保留第二个', args: { action: 'confirm', request: '允许，但保留第二个' } });
  assert(revised.accepted);
  assert.equal(queue[1].cancelled, undefined, 'the unrelated running task is untouched');
  assert.deepEqual(cancelledPending, ['task-1'], 'the waiting list is the one closed for revision');
  assert.match(queue.at(-1).text, /删除规则集甲和乙.*用户修正：允许，但保留第二个/s);
  assert.equal(queue.at(-1).options.context.pendingActionSubmissionId, undefined);

  // 语音取消走 confirm 通道时同样只取消待确认的那一个
  seq = 10; queue.length = 0; cancelledPending.length = 0;
  const other = createMaidVoiceTaskRuntime({ getCommandRuntime: () => command, captureContext: () => ({ sessionId: 'room-a' }), makeId: () => `t-${++seq}`,
    cancelPendingAction: ({ submissionId }) => { cancelledPending.push(submissionId); return true; } });
  await other.request({ target, requestId: 'p', args: { action: 'execute', request: '删除规则集丙' } });
  queue[0].done.resolve({ ok: true, status: 'awaiting_confirmation', message: '请确认', pendingWorkflow: { kind: 'maid_pending_action' } }); await tick();
  await other.request({ target, requestId: 'o', args: { action: 'execute', request: '打开设置' } });
  const cancelled = await other.request({ target, requestId: 'c', inputText: '取消', args: { action: 'confirm', request: '取消' } });
  assert.equal(cancelled.cancelled, 1);
  assert.deepEqual(cancelledPending, ['t-11']);
  assert.equal(queue[1].cancelled, undefined);

  // 允许 → 续接任务完成；之后引用它继续交办的新请求不带续接授权
  seq = 20; queue.length = 0;
  const third = createMaidVoiceTaskRuntime({ getCommandRuntime: () => command, captureContext: () => ({ sessionId: 'room-a' }), makeId: () => `u-${++seq}` });
  await third.request({ target, requestId: 'p', args: { action: 'execute', request: '删除规则集丁' } });
  queue[0].done.resolve({ ok: true, status: 'awaiting_confirmation', message: '请确认', pendingWorkflow: { kind: 'maid_pending_action' } }); await tick();
  const confirmed = await third.request({ target, requestId: 'y', inputText: '允许', args: { action: 'confirm' } });
  assert.equal(queue[1].options.context.pendingActionSubmissionId, 'u-21');
  queue[1].done.resolve({ ok: true, message: '已删除' }); await tick();
  await third.request({ target, requestId: 'f', args: { action: 'execute', request: '再把戊也删了', task_id: confirmed.task_id } });
  assert.equal(queue[2].options.context.sessionId, 'room-a', 'the referenced room is kept');
  assert.equal(queue[2].options.context.pendingActionSubmissionId, undefined, 'a follow-up is a new request, not a continuation of the old list');
  console.log('ok - voice confirm revisions and cancels target the waiting task; follow-ups do not inherit continuation authority');
}
console.log('maid realtime tasks: independent lifecycle, frozen targets, revision/cancel, actual results, original UI routing and provider adapters passed');
