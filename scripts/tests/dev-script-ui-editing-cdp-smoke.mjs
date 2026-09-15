// Windows dev WebView smoke: real DOM focus/selection/IME, no preset/chat writes.
import assert from 'node:assert/strict';
import { createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const page = await findAppPageTarget();
if (!page) throw new Error('Windows dev WebView is not running');
let socket, ready;
const pending = new Map();
let seq = 0;
const opened = new Promise(resolve => { ready = resolve; });
socket = createWsClient(page.webSocketDebuggerUrl, {
  onOpen: ready,
  onMessage: raw => {
    const message = JSON.parse(raw), call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id); clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  },
  onError: error => { for (const call of pending.values()) call.reject(error); },
});
await opened;
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => reject(new Error('CDP timed out: ' + method)), 15000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
try {
  const initial = await evaluate(`(async () => {
    const { ScriptRuntime } = await import('/scripts/plugins/script-runtime.js');
    const previousFocus = document.activeElement;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647';
    document.body.appendChild(host);
    const shadow = host.attachShadow({mode:'open'}), events = [];
    const runtime = Object.create(ScriptRuntime.prototype);
    Object.assign(runtime, { uiShadow: shadow, uiNativeStatePending: new Map(), uiNativeStateRevision: 0,
      uiComposingNodeIds: new Set(), worker: { postMessage: message => events.push(message) },
      ensureUiRoot: () => shadow, postWorkerUiLayout() {}, scheduleWorkerUiLayoutSync() {}, recordUiPerformanceSample() {} });
    for (const type of ['input','compositionstart','compositionend']) shadow.addEventListener(type, event => runtime.handleUiEvent(event), true);
    const escape = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const render = (value, counter = '', revision = 0, show = true) => runtime.renderWorkerUi({styles:[], roots:[
      '<div data-chatapp-virtual-node-id="root">' + (show ? '<textarea data-chatapp-virtual-node-id="field">' + escape(value) + '</textarea>' : '') +
      '<span data-chatapp-virtual-node-id="counter">' + counter + '</span></div>'
    ]}, null, revision);
    render('initial text');
    const field = shadow.querySelector('textarea');
    field.focus(); field.setSelectionRange(2,5,'backward');
    render('initial text','updated counter');
    const focus = field === shadow.querySelector('textarea') && shadow.activeElement === field;
    const selection = field.selectionStart === 2 && field.selectionEnd === 5 && field.selectionDirection === 'backward';
    field.value = 'a'; field.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:'a'}));
    field.value = 'ab'; field.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,data:'b'}));
    render('a','stale reply',1);
    const staleProtected = field.value === 'ab';
    render('ab','latest reply',2);
    field.value = ''; field.setSelectionRange(0,0);
    window.__scriptUiEditingTest = {host,shadow,runtime,events,render,field,previousFocus};
    return { focus, selection, staleProtected };
  })()`);
  assert.deepEqual(initial, { focus: true, selection: true, staleProtected: true });
  await command('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
  const ime = await evaluate(`(() => {
    const t = window.__scriptUiEditingTest;
    const value = t.field.value, start = t.field.selectionStart, end = t.field.selectionEnd;
    const composing = t.runtime.uiComposingNodeIds.has('field');
    t.render('old worker text','async counter update',t.runtime.uiNativeStateRevision);
    return { composing, connected: t.field.isConnected, focus: t.shadow.activeElement === t.field,
      textRetained: t.field.value === value, selectionRetained: t.field.selectionStart === start && t.field.selectionEnd === end };
  })()`);
  assert.deepEqual(ime, { composing: true, connected: true, focus: true, textRetained: true, selectionRetained: true });
  await command('Input.insertText', { text: '中文' });
  const final = await evaluate(`(() => {
    const t = window.__scriptUiEditingTest;
    t.render(t.field.value,'committed',t.runtime.uiNativeStateRevision);
    const result = { text: t.field.value, focused: t.shadow.activeElement === t.field,
      compositionEnded: !t.runtime.uiComposingNodeIds.has('field') };
    t.render('', 'next wizard step', t.runtime.uiNativeStateRevision, false);
    result.removedOnStepChange = !t.field.isConnected;
    return result;
  })()`);
  assert.deepEqual(final, { text: '中文', focused: true, compositionEnded: true, removedOnStepChange: true });
  console.log('ok - native script UI preserves nodes, focus, selection, rapid input and actual IME composition; removed controls are released');
} finally {
  await evaluate(`(() => { const t = window.__scriptUiEditingTest; if (t) { t.host.remove(); t.previousFocus?.focus?.({preventScroll:true}); delete window.__scriptUiEditingTest; } })()`).catch(() => {});
  socket.close();
}
