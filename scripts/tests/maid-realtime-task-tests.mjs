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
  voice = createMaidVoiceRuntime({ settingsStore: { getVoiceInputMode: () => 'realtime', getMaidPrompt: () => 'Maid' },
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

console.log('maid realtime tasks: independent lifecycle, frozen targets, revision/cancel, actual results, original UI routing and provider adapters passed');
