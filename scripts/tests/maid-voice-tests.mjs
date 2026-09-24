import assert from 'node:assert/strict';
import { resolveMaidSubmitAction, bindMaidVoiceButton } from '../../src/scripts/ui/maid-voice-button.js';
import { createMaidVoiceRuntime, buildMaidVoiceSnapshot } from '../../src/scripts/ui/maid-voice-runtime.js';
import { MaidSettingsStore } from '../../src/scripts/storage/maid-settings-store.js';
import { MaidConversationStore } from '../../src/scripts/storage/maid-conversation-store.js';
import { createChatVoiceRuntime } from '../../src/scripts/ui/chat/voice-interaction-runtime.js';
import { realtimeTargetBindingKey } from '../../src/scripts/ui/realtime/realtime-settings-target.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const noStorage = { storage: null, loadKv: async () => null, saveKv: async () => {} };

// Text/attachments take precedence over calls, active capture and active tasks have Stop.
for (const [state, expected] of [
  [{ available: true }, 'realtime'], [{ available: true, mode: 'stt' }, 'stt'],
  [{ available: true, hasDraft: true }, 'send'], [{ available: true, call: 'listening' }, 'end-call'],
  [{ available: true, hasDraft: true, call: 'listening' }, 'send'],
  [{ available: true, hasDraft: true, recording: 'recording' }, 'stop-recording'],
  [{ available: true, recording: 'starting' }, 'stop-recording'],
  [{ available: true, recording: 'transcribing' }, 'stop-recording'],
  [{ available: true, hasDraft: true, submitting: true }, 'stop-task'], [{}, 'send'],
]) assert.equal(resolveMaidSubmitAction(state).action, expected);

{
  const listeners = new Map(), attrs = new Map();
  const button = { dataset: {}, classList: { toggle() {} }, addEventListener: (k, fn) => listeners.set(k, fn),
    removeEventListener: k => listeners.delete(k), setAttribute: (k, v) => attrs.set(k, v) };
  let timer = null, calls = 0, choices = 0, state = { available: true };
  const binding = bindMaidVoiceButton({ button, getState: () => state, schedule: fn => { timer = fn; return 1; }, clearSchedule: () => { timer = null; },
    onAction: () => calls++, onChooseMode: async () => choices++ });
  const fire = (type, extra = {}) => { const event = { button: 0, clientX: 1, clientY: 1, detail: 1, preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...extra }; listeners.get(type)?.(event); return event; };
  fire('pointerdown'); timer(); await tick(); fire('pointerup');
  assert.equal(fire('click').prevented, true); assert.equal(calls, 0); assert.equal(choices, 1);
  fire('pointerdown'); fire('pointerup'); fire('click'); assert.equal(calls, 1);
  fire('pointerdown'); fire('pointermove', { clientX: 50 }); assert.equal(timer, null);
  fire('contextmenu'); await tick(); assert.equal(choices, 2);
  fire('keydown', { key: 'F10', shiftKey: true }); await tick(); assert.equal(choices, 3);
  state = { available: true, hasDraft: true }; binding.sync();
  fire('pointerdown'); assert.equal(timer, null); assert.equal(button.type, 'submit');
  binding.dispose(); assert.equal(listeners.size, 0);
}

{
  let now = 100;
  const local = new Map(), kv = new Map();
  const storage = { getItem: k => local.get(k) || null, setItem: (k, v) => local.set(k, v) };
  const options = { storage, loadKv: async k => kv.get(k), saveKv: async (k, v) => kv.set(k, structuredClone(v)), now: () => ++now };
  const settings = new MaidSettingsStore(options); await settings.load();
  assert.equal(settings.getVoiceInputMode(), 'realtime');
  await settings.setVoiceInputMode('stt');
  const restored = new MaidSettingsStore(options); await restored.load(); assert.equal(restored.getVoiceInputMode(), 'stt');
  await restored.setVoiceInputMode('realtime');
  const again = new MaidSettingsStore(options); await again.load(); assert.equal(again.getVoiceInputMode(), 'realtime');
}

{
  const store = new MaidConversationStore(noStorage); await store.load();
  const settings = new MaidSettingsStore(noStorage); await settings.load();
  await settings.setMaidPrompt('只属于女仆的人设');
  const command = { syncVoiceState() {}, submitVoiceTask: async text => ({ queued: text }) };
  let finalized = null, prepared = 0, sequence = 0;
  const finalize = store.finalizeRealtimeConversation.bind(store);
  store.finalizeRealtimeConversation = async id => { finalized = id; return finalize(id); };
  const voice = createMaidVoiceRuntime({ settingsStore: settings, conversationStore: store, getCommandRuntime: () => command,
    makeId: () => `call-${++sequence}`, prepareConversationContext: async () => { prepared++; return { memoryText: '女仆记忆', historyText: '女仆历史' }; } });
  const target = voice.getTarget();
  assert.notEqual(realtimeTargetBindingKey(target), realtimeTargetBindingKey({ ...target, uiMode: 'chat' }));
  await voice.beforeRealtimeStart(target);
  voice.onCallState({ status: 'listening', target });
  const snapshot = await voice.buildSemanticSnapshot({ target, inputText: '你好' });
  assert.equal(prepared, 1);
  assert.match(snapshot.instructions, /只属于女仆的人设/); assert.match(snapshot.instructions, /女仆记忆/); assert.match(snapshot.instructions, /女仆历史/);
  assert.match(snapshot.instructions, /不得声称已执行操作/);
  await voice.commitUserMessage({ target, text: '你好', meta: { realtimeItemId: 'u1' } });
  await voice.commitUserMessage({ target, text: '你好', meta: { realtimeItemId: 'u1' } });
  await voice.commitAssistantMessage({ target, text: '欢迎回来', meta: { realtimeResponseId: 'a1' } });
  assert.equal(store.state.turns.length, 2, 'repeated provider events do not duplicate history');
  const group = { id: 'live-1', role: 'assistant', text: '实时字幕', messageId: '', savedText: '' };
  const committed = await voice.commitLiveTranscript({ target, group, meta: {} });
  group.messageId = committed.messageId; group.savedText = group.text; group.text += '修订';
  await voice.commitLiveTranscript({ target, group, meta: {} });
  assert.equal(store.state.turns.length, 3); assert.equal(store.state.turns.at(-1).message, '实时字幕修订');
  assert.ok(store.state.turns.every(turn => turn.compactionProtection === 'realtime_transcript'));
  group.savedText = '旧版本'; group.text = '不得覆盖手动修改';
  assert.equal((await voice.commitLiveTranscript({ target, group, meta: {} })).ignored, true);
  assert.deepEqual(await voice.executeTranscript('打开设置'), { queued: '打开设置' });
  voice.onCallState({ status: 'idle', target }); await tick();
  assert.equal(finalized, target.maidCallId); assert.ok(store.state.turns.every(turn => !turn.compactionProtection));
  assert.equal(voice.getState().call, 'idle');
  assert.equal((await voice.commitUserMessage({ target, text: '晚到结果', meta: { realtimeItemId: 'late' } })).ignored, true);
  assert.equal(store.state.turns.length, 3);
}

// 首次实时通话先说明任务执行方式；关掉不选按语音执行且不再重复询问，之后可从默认语音模式里改
{
  const store = new MaidConversationStore(noStorage); await store.load();
  const settings = new MaidSettingsStore(noStorage); await settings.load();
  const asked = [];
  let answer = null, started = 0;
  const voice = createMaidVoiceRuntime({ settingsStore: settings, conversationStore: store,
    getCommandRuntime: () => ({ syncVoiceState() {}, collapse() {} }),
    getCallAppRuntime: () => ({ startCall: async () => { started++; return true; }, runtime: { getState: () => ({ status: 'listening' }) } }),
    choose: async (options) => { asked.push(options); return typeof answer === 'function' ? answer(options) : answer; },
  });
  await voice.action('realtime');
  assert.equal(asked.length, 1);
  assert.match(asked[0].title, /由谁执行/);
  assert.deepEqual(asked[0].actions.map(action => action.id), ['maid', 'voice']);
  assert.equal(asked[0].actions[0].primary, true, '推荐交给女仆');
  assert.equal(settings.getVoiceTaskExecutor(), 'voice', '关掉不选：由语音模型执行');
  assert.equal(settings.hasChosenVoiceTaskExecutor(), true);
  assert.equal(started, 1);
  await voice.action('realtime');
  assert.equal(asked.length, 1, '不再重复询问');
  answer = options => (options.actions.some(action => action.id === 'executor') ? 'executor' : 'maid');
  await voice.chooseMode();
  assert.equal(settings.getVoiceTaskExecutor(), 'maid', '默认语音模式里可改为交给女仆');
}

// A permission result arriving after cancellation must release its own stream,
// without interfering with a later recorder or inserting any transcript.
{
  const acquired = deferred(); let stopped = 0, recorderCreations = 0;
  const recorder = createChatVoiceRuntime({ resolveConfig: async () => ({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'test', model: 'stt' }),
    microphoneAccess: { acquire: () => acquired.promise }, mediaDevices: { getUserMedia() {} },
    MediaRecorderCtor: class { constructor() { recorderCreations++; } }, documentLike: null, windowLike: null });
  const starting = recorder.toggleRecording(); await tick();
  assert.equal(recorder.getRecorderState(), 'starting');
  await recorder.cancel(); assert.equal(recorder.getRecorderState(), 'idle');
  acquired.resolve({ getTracks: () => [{ stop: () => stopped++ }] });
  assert.equal(await starting, false); assert.equal(stopped, 1); assert.equal(recorderCreations, 0);
  await recorder.destroy();
}

assert.ok(buildMaidVoiceSnapshot({ conversationContext: {} }).instructions.length > 0);
{
  // 语音模型直接交办、不自行先确认（授权由 APP 权限请求发起）；汇报只依据本次任务的实际结果，不沿用历史里的旧结果
  const { instructions } = buildMaidVoiceSnapshot({ conversationContext: {} });
  assert.match(instructions, /不要在交给女仆前自己先问用户要不要执行/);
  assert.match(instructions, /需要授权时 APP 会发来权限请求/);
  assert.match(instructions, /不能沿用历史里相似的结果/);
}

{
  const store = new MaidConversationStore(noStorage); await store.load();
  store.write = async () => false;
  const options = { id: 'failed-save', callId: 'call', role: 'user', text: '必须确认保存成功' };
  assert.equal(await store.upsertRealtimeTranscript(options), null, 'new voice transcript must not report a failed save as committed');
  assert.equal(await store.upsertRealtimeTranscript(options), null, 'revised voice transcript also checks persistence');
}
console.log('maid voice tests passed: button, gestures, preferences, isolated context/history, Live revisions, task handoff, microphone cancellation');
