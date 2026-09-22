// Real Windows WebView, original ball markup/styles, isolated memory and transport.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const setup = async () => {
  const check = (value, message) => { if (!value) throw Error(message); };
  const { createMaidVoiceRuntime } = await import('/scripts/ui/maid-voice-runtime.js');
  const { createMaidCommandInputRuntime } = await import('/scripts/ui/maid-command-input-runtime-utils.js');
  const { createRealtimeCallAppRuntime } = await import('/scripts/ui/realtime/realtime-call-app-runtime.js');
  const { createModeSwitchInteractionRuntime } = await import('/scripts/ui/app-mode-switch-interaction-runtime-utils.js');
  const original = document.querySelector('#mode-switch');
  check(window.__chatappBootDiag?.runtimeReady, 'application boot is ready');
  check(original && !original.classList.contains('is-maid-voice-active') && !original.classList.contains('is-maid-input-open'), 'original ball is idle');
  const visibility = original.style.visibility, ball = original.cloneNode(true);
  ball.id = 'maid-realtime-smoke-ball'; ball.classList.remove('is-hidden', 'is-dim');
  ball.querySelectorAll('.maid-voice-wave,.maid-voice-mic').forEach(el => el.remove());
  ball.style.left = `${innerWidth - 90}px`; ball.style.top = `${innerHeight - 280}px`;
  document.body.append(ball); original.style.visibility = 'hidden';
  const button = ball.querySelector('.mode-switch-btn'), background = getComputedStyle(button).backgroundImage, ring = getComputedStyle(button, '::before').backgroundImage;
  let app, voice, callbacks, connection, modeChanges = 0, mode = 'chat', closed = 0, commands = [], frames = [], sequence = 0;
  const command = createMaidCommandInputRuntime({ documentRef: document, modeSwitchEl: ball,
    getViewportSize: () => ({ w: innerWidth, h: innerHeight }), getVoiceState: () => voice?.getState() || {},
    onVoiceAction: kind => voice?.action(kind), onCloseVoiceInput: () => voice?.cancelInput(),
    onOpenStateChange: value => voice?.setInputOpen(value.open),
    onVoiceTextSubmit: (text, attachments) => voice.submitText(text, attachments),
    onAttachFiles: async files => files.map(file => ({ id: file.name, kind: 'image', name: file.name, url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=' })),
    onSubmit: (text, controls) => new Promise(resolve => {
      commands.push({ text, controls, resolve }); controls.setStatus('正在读取设置', 'progress');
      controls.signal.addEventListener('abort', () => resolve({ cancelled: true, message: '任务已停止' }));
    }),
  });
  voice = createMaidVoiceRuntime({ documentRef: document, windowLike: window, modeSwitchEl: ball,
    settingsStore: { getVoiceInputMode: () => 'realtime', getMaidPrompt: () => '女仆测试' },
    conversationStore: { upsertRealtimeTranscript: async value => ({ messageId: value.id }), finalizeRealtimeConversation: async () => {} },
    prepareConversationContext: async () => ({}), getAppContext: () => ({ sessionId: 'smoke', activePage: 'settings' }),
    getCommandRuntime: () => command, getCallAppRuntime: () => app,
  });
  const root = document.querySelectorAll('.maid-voice-orb-ui'); const voiceRoot = root[root.length - 1];
  const interaction = createModeSwitchInteractionRuntime({ documentRef: document, modeSwitchEl: ball, modeSwitchBtnEl: button,
    getViewportSize: () => ({ w: innerWidth, h: innerHeight }), getModeSwitchSize: () => ball.getBoundingClientRect().width,
    normalizeModeSwitchPos: (x, y) => ({ x, y }), setModeSwitchPos: value => { ball.style.left = `${value.x}px`; ball.style.top = `${value.y}px`; voice.position(); },
    matchMediaFn: () => ({ matches: true }),
    getUiMode: () => mode,
    enterRpMode: () => { mode = 'rp'; modeChanges++; }, exitRpMode: () => { mode = 'chat'; modeChanges++; },
    onLongPress: () => { voice.prepareOpenInput(); command.open({ autoFocus: false }); return true; },
  }); interaction.bind();
  app = createRealtimeCallAppRuntime({ documentRef: document, windowLike: window, getCallTarget: () => voice.getTarget(),
    registerSettingsTarget: () => () => {},
    createPanel: () => ({ show() { throw Error('maid must not open the room call panel'); }, hide() {}, destroy() {} }),
    resolveProfileBinding: () => null,
    resolveConnection: async () => ({ config: { provider: 'openai' }, settings: { realtimeModel: 'gpt-realtime-2.1' } }),
    beforeStart: value => voice.beforeRealtimeStart(value), onStateChange: value => voice.onCallState(value),
    getMaidSurface: () => voice.getSurface(), handleMaidTaskRequest: value => voice.handleTaskRequest(value),
    buildSemanticSnapshot: value => voice.buildSemanticSnapshot(value), isTargetCurrent: value => voice.isTargetCurrent(value),
    commitUserMessage: value => voice.commitUserMessage(value), commitAssistantMessage: value => voice.commitAssistantMessage(value),
    createSessionClient: value => { callbacks = value; return { connect: async payload => { connection = payload; }, close: async () => closed++, sendEvent: frame => frames.push(frame), setMicrophoneMuted: () => true, setOutputMuted: () => true }; },
  });
  window.__maidOrbSmoke = { app, voice, command, button, ball, voiceRoot, check, frames, commands, get closed() { return closed; },
    pause: () => new Promise(resolve => setTimeout(resolve, 40)),
    emit: event => callbacks.onEvent(event), levels: value => callbacks.onAudioLevel(value),
    request: async text => {
      const id = `request-${++sequence}`;
      callbacks.onEvent({ type: 'conversation.item.input_audio_transcription.completed', item_id: `input-${id}`, transcript: text }); await app.runtime.whenIdle();
      callbacks.onEvent({ type: 'response.created', response: { id } });
      callbacks.onEvent({ type: 'response.done', response: { id, status: 'completed', output: [{ type: 'function_call', call_id: id, name: 'maid_task', arguments: JSON.stringify({ action: 'execute', request: text }) }] } });
      await new Promise(resolve => setTimeout(resolve, 20));
      callbacks.onEvent({ type: 'response.created', response: { id: `ack-${id}` } });
      callbacks.onEvent({ type: 'response.done', response: { id: `ack-${id}`, status: 'completed' } });
    },
    get modeChanges() { return modeChanges; },
    cleanup: async () => { commands.forEach(entry => entry.resolve({ cancelled: true })); await app.destroy(); await voice.destroy(); command.close(); interaction.destroy?.(); command.getElements().rootEl?.remove(); ball.remove(); original.style.visibility = visibility; delete window.__maidOrbSmoke; },
  };
  command.open({ autoFocus: false }); command.getElements().inputEl.value = '未发送的草稿';
  await command.addFiles([{ name: 'reference.png', type: 'image/png', size: 20 }]); command.setStatus('之前的结果', 'success');
  check(await voice.action('realtime'), 'maid realtime starts');
  check(!command.isOpen() && command.getAttachments().length === 1, 'start collapses input and preserves attachments');
  check(command.getElements().inputEl.value === '未发送的草稿', 'draft is preserved');
  check(getComputedStyle(button).backgroundImage === background && getComputedStyle(button, '::before').backgroundImage === ring, 'original ball artwork is unchanged');
  check(connection.sessionConfig.tools[0].name === 'maid_task', 'connected tool contract');
  check(!document.querySelector('.realtime-call-panel.is-visible'), 'no call panel opens');
  return { bootReady: true, originalBallPreserved: true, externalRequests: 0 };
};

const page = await findAppPageTarget(); let socket, sequence = 0; const pending = new Map();
await new Promise((resolve, reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => { const data = JSON.parse(raw), request = pending.get(data.id); if (request) { pending.delete(data.id); data.error ? request.reject(Error(data.error.message)) : request.resolve(data.result); } } }); });
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const ev = body => evaluateInApp(`(async () => { const f = window.__maidOrbSmoke; ${body} })()`);
const output = 'scripts/dev/tmp/maid-realtime'; mkdirSync(output, { recursive: true });
const screenshot = async name => { const value = await cdp('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${output}/${name}.png`, Buffer.from(value.data, 'base64')); };
try {
  await evaluateInApp(`(async () => { const deadline = Date.now() + 30000; while (!window.__chatappBootDiag?.runtimeReady && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200)); if (!window.__chatappBootDiag?.runtimeReady) throw Error('Application boot timeout'); })()`, { timeoutMs: 35000 });
  const result = await evaluateInApp(`(${setup.toString()})()`);
  await ev(`f.levels({ input: { level: .7, bands: [.2,.3,.8,.5,.6,.4,.9] }, output: { level: 0 } }); await f.pause();`);
  await screenshot('listening');
  await ev(`f.button.click(); await f.pause(); f.check(f.modeChanges === 1, 'ball changes mode during voice'); f.check(f.voice.isCallActive(), 'mode change keeps voice connected'); f.check(f.voiceRoot.querySelector('.maid-voice-orb-controls').hidden, 'ball does not open controls'); f.check(!f.button.hasAttribute('aria-controls'), 'ball keeps its mode-switch semantics'); f.voiceRoot.querySelector('.maid-voice-orb-badge').click(); f.check(!f.voiceRoot.querySelector('.maid-voice-orb-controls').hidden, 'summary opens controls'); f.voiceRoot.querySelector('[data-action="mute"]').click(); await f.pause(); f.check(f.app.runtime.getState().muted, 'pause microphone');`);
  await screenshot('controls-paused');
  await ev(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); f.check(f.voiceRoot.querySelector('.maid-voice-orb-controls').hidden, 'Escape closes controls only'); f.check(document.activeElement === f.voiceRoot.querySelector('.maid-voice-orb-badge'), 'focus returns to summary'); f.check(f.voice.isCallActive(), 'Escape keeps call active'); await f.request('帮我检查语音设置');`);
  await screenshot('task-running');
  const point = await ev(`const r = f.button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - 50, y: point.y - 20, button: 'left', buttons: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x - 50, y: point.y - 20, button: 'left', clickCount: 1 });
  await ev(`await new Promise(r => setTimeout(r, 250)); f.check(f.modeChanges === 1 && f.voice.isCallActive(), 'drag keeps voice active without an extra mode switch');`);
  const moved = await ev(`const r = f.button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  assert(moved.x < point.x - 20, 'ball moves with its controls');
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...moved, button: 'left', clickCount: 1 });
  await ev(`await new Promise(r => setTimeout(r, 650));`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...moved, button: 'left', clickCount: 1 });
  await ev(`f.check(f.command.isOpen(), 'long press opens maid input'); f.check(document.activeElement !== f.command.getElements().inputEl, 'long press avoids the keyboard'); f.command.collapse(); await new Promise(r => setTimeout(r, 250));`);
  await ev(`f.voiceRoot.querySelector('.maid-voice-orb-badge').click(); f.voiceRoot.querySelector('[data-action="input"]').click(); await f.pause(); f.check(f.command.isOpen(), 'history/input opens'); f.check(document.activeElement !== f.command.getElements().inputEl, 'voice input does not force keyboard'); f.check(f.command.getAttachments().length === 1, 'reference retained after task submission'); f.command.collapse();`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await ev(`f.ball.style.left = '330px'; f.ball.style.top = '570px'; f.voiceRoot.querySelector('.maid-voice-orb-badge').click(); f.voice.position(); await f.pause(); const rect = f.voiceRoot.querySelector('.maid-voice-orb-controls').getBoundingClientRect(); f.check(rect.left >= 10 && rect.right <= innerWidth - 10, 'controls stay within narrow viewport');`);
  await screenshot('controls-mobile');
  await ev(`f.voiceRoot.querySelector('[data-action="end"]').click(); await f.pause(); f.check(f.closed === 1, 'ending voice closes transport'); f.check(!f.commands[0].controls.signal.aborted, 'ending voice retains accepted task'); f.commands[0].resolve({ ok: true, message: '语音设置检查完成' }); await f.pause(); f.check(f.voice.getTasks().active.length === 0, 'background work finishes'); f.button.click(); f.check(f.modeChanges === 2, 'ball changes mode after call ends');`);
  assert.equal(result.originalBallPreserved, true);
  console.log(JSON.stringify({ ...result, controls: true, keyboard: true, drag: true, longPress: true, responsive: true, backgroundCompletion: true, screenshots: output }, null, 2));
} finally {
  await cdp('Emulation.clearDeviceMetricsOverride');
  await ev(`if (f) await f.cleanup();`); socket.close();
}
