// Windows dev WebView: isolated call UI and real mouse/touch input, with no microphone or model requests.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';

const page = await findAppPageTarget();
let socket, sequence = 0, touching = false;
const pending = new Map(), results = [];
const phase = process.env.REALTIME_SMOKE_FROM || 'desktop';
await new Promise((resolve, reject) => {
  socket = createWsClient(page.webSocketDebuggerUrl, {
    onOpen: resolve, onError: reject,
    onMessage: raw => {
      const message = JSON.parse(raw), waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    },
  });
});
const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const ev = source => evaluateInApp(`(async () => { const f = window.__rtPanelSmoke; ${source} })()`);
const pause = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms));
const state = () => ev(`
  const panel = f.host.querySelector('.realtime-call-panel'), handle = panel.querySelector('.realtime-call-handle');
  const r = panel.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
    overflow: panel.scrollWidth > panel.clientWidth + 1, expanded: handle.getAttribute('aria-expanded') === 'true',
    dragging: panel.classList.contains('is-dragging'), visible: !panel.parentElement.hidden,
    dock: panel.dataset.dock, hiddenControls: panel.querySelector('.realtime-call-body').hidden, modal: panel.getAttribute('aria-modal'),
    ends: f.ends, outside: f.outside, muted: f.muted, outputMuted: f.outputMuted, interrupts: f.interrupts,
    focused: document.activeElement === handle,
    handle: { x: r.left + r.width / 2, y: r.top + handle.offsetHeight / 2 } };
`);
const point = selector => ev(`const r = f.host.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`);
const mouse = async (type, p, extra = {}) => command('Input.dispatchMouseEvent', { type, ...p, ...extra });
const mouseClick = async p => {
  await mouse('mousePressed', p, { button: 'left', buttons: 1, clickCount: 1 });
  await mouse('mouseReleased', p, { button: 'left', buttons: 0, clickCount: 1 });
  await pause();
};
const mouseDrag = async (from, to) => {
  await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 5; i++) await mouse('mouseMoved', { x: from.x + (to.x - from.x) * i / 5, y: from.y + (to.y - from.y) * i / 5 }, { button: 'left', buttons: 1 });
  await mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1 });
  await pause();
};
const touch = async (type, p) => {
  await command('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ ...p, id: 1 }] : [] });
  touching = type !== 'touchEnd' && type !== 'touchCancel';
};
const tap = async p => { await touch('touchStart', p); await touch('touchEnd'); await pause(); };
const key = async (key, code, virtual, modifiers = 0) => {
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtual, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtual, modifiers });
  await pause();
};
const screenshot = async name => {
  await pause(260); // Let theme/control color transitions finish before visual review.
  const shot = await command('Page.captureScreenshot', { format: 'png' });
  mkdirSync('scripts/dev/tmp/realtime-pill', { recursive: true });
  writeFileSync(`scripts/dev/tmp/realtime-pill/${name}.png`, Buffer.from(shot.data, 'base64'));
};
const inBounds = (s, width, height) => {
  assert(s.left >= 9 && s.top >= 9 && s.right <= width - 9 && s.bottom <= height - 9, JSON.stringify(s));
  assert.equal(s.overflow, false, 'call widget has no horizontal overflow');
};

try {
  await evaluateInApp(`(async () => {
    const { createRealtimeCallPanel } = await import('/scripts/ui/realtime/realtime-call-panel.js');
    const { REALTIME_PROVIDERS } = await import('/scripts/ui/realtime/realtime-provider-catalog.js');
    const { initializeI18n, getCurrentLocale, localizeDomSubtree } = await import('/scripts/i18n/index.js');
    const previousFocus = document.activeElement, host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:22599;background:var(--app-surface-page);color:var(--app-text-primary)';
    host.innerHTML = '<div data-i18n-skip style="padding:100px 24px 24px;max-width:720px;margin:auto;font-size:14px"><div style="display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--app-border-subtle);padding-bottom:20px"><img src="/assets/external/feather-default.png" style="width:44px;height:44px;border-radius:50%"><div><b>森屿</b><div style="font-size:12px;color:var(--app-text-muted);margin-top:5px">在线</div></div></div><div style="margin:28px 0;padding:16px 18px;background:var(--app-surface-card);border-radius:4px 18px 18px;max-width:290px;line-height:1.8">窗外的雨停了。<br>要不要一起出去走走？</div><div style="margin:20px 0 20px auto;padding:16px 18px;background:var(--app-accent-soft);border-radius:18px 4px 18px 18px;max-width:220px">好呀，边走边聊。</div></div><button class="rt-smoke-outside" style="position:absolute;bottom:20px;left:20px;border:0;border-radius:16px;padding:12px 20px;background:var(--app-surface-card);color:inherit">聊天</button><textarea aria-label="Test chat input" style="position:absolute;bottom:20px;left:110px;width:160px;height:42px;border:1px solid var(--app-border-subtle);border-radius:14px;background:var(--app-surface-card);color:inherit"></textarea>';
    document.body.append(host);
    const f = { host, previousFocus, providers: REALTIME_PROVIDERS, locale: getCurrentLocale(), initializeI18n, localizeDomSubtree,
      ends: 0, outside: 0, muted: false, outputMuted: false, interrupts: 0 };
    host.querySelector('.rt-smoke-outside').onclick = () => f.outside++;
    f.panel = createRealtimeCallPanel({ documentRef: { body: host, createElement: name => document.createElement(name) },
      onToggleMute: () => { f.muted = !f.muted; f.panel.renderState({ muted: f.muted }); },
      onToggleOutputMute: () => { f.outputMuted = !f.outputMuted; f.panel.renderState({ outputMuted: f.outputMuted }); },
      onInterrupt: () => f.interrupts++, onEnd: () => { f.ends++; f.panel.hide(); },
    });
    window.__rtPanelSmoke = f;
  })()`);
  await command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
  await ev(`await f.initializeI18n({ preference: 'zh-CN' }); f.host.querySelector('textarea').focus();
    f.panel.show({ name: '森屿' }); f.panel.renderState({ status: 'listening', provider: 'gemini_live', elapsedMs: 83000 });
    f.panel.setCaption({ role: 'assistant', text: '窗外的雨停了，要不要一起出去走走？' }); f.panel.setUsage({});`);
  await pause();
  let current = await state();
  if (phase === 'desktop') {
    assert.equal(current.expanded, true); assert.equal(current.hiddenControls, false); assert.equal(current.modal, 'true');
    assert(Math.abs(current.top + current.height / 2 - 400) < 2, 'call starts as a centered dialog');
    const measured = await ev(`
      const { createRealtimeAudioMeter } = await import('/scripts/ui/realtime/realtime-audio-meter.js');
      f.audioContext = new AudioContext(); await f.audioContext.resume();
      const input = f.audioContext.createOscillator(), output = f.audioContext.createOscillator();
      const inputGain = f.audioContext.createGain(), outputGain = f.audioContext.createGain();
      input.frequency.value = 440; output.frequency.value = 900; inputGain.gain.value = .06; outputGain.gain.value = .2;
      input.connect(inputGain); output.connect(outputGain);
      f.meter = createRealtimeAudioMeter({ context: f.audioContext, onLevel: value => { f.lastLevel = value; f.panel.setAudioLevel(value); } });
      f.meter.attach('input', inputGain); f.meter.attach('output', outputGain);
      input.start(); output.start();
      const audioDeadline = Date.now() + 2000;
      while (!(f.lastLevel?.input.level > .1 && f.lastLevel?.output.level > .3) && Date.now() < audioDeadline) await new Promise(resolve => setTimeout(resolve, 40));
      return { input: f.lastLevel?.input.level, output: f.lastLevel?.output.level, bars: [...f.host.querySelectorAll('.realtime-call-wave i')].map(bar => Number(bar.style.getPropertyValue('--bar-level'))) };
    `);
    assert(measured.input > .1 && measured.output > measured.input, JSON.stringify(measured));
    assert(measured.bars.some(value => value > .2), 'real Web Audio drives the waveform');
    await ev(`f.meter.setMuted('input', true); f.meter.setMuted('output', true);`);
    assert.equal(await ev(`return f.lastLevel.input.level + f.lastLevel.output.level;`), 0);
    await ev(`f.meter.setMuted('input', false); f.meter.setMuted('output', false);`);
    results.push({ audio: 'real Web Audio input/playback levels and mute passed, no microphone or network' });
    await screenshot('desktop-dialog');
    await mouseClick(await point('[data-call-action="minimize"]')); current = await state();
    assert.equal(current.expanded, false); assert.equal(current.modal, null);
    assert(current.height <= 64 && Math.abs(current.left + current.width / 2 - 550) < 2);
    assert.equal(current.focused, true, 'minimize moves focus to the floating handle');
    inBounds(current, 1100, 800);
    await screenshot('desktop-pill');

    const rows = await ev(`const rows = []; for (const provider of Object.keys(f.providers)) {
      f.panel.renderState({ status: 'connecting', provider });
      rows.push({ provider, label: f.host.querySelector('.realtime-call-status').textContent,
        disclosure: f.host.querySelector('.realtime-call-disclosure').dataset.help });
    } f.panel.renderState({ status: 'listening', provider: 'gemini_live' }); return rows;`);
    for (const row of rows) {
      if (row.provider !== 'openai') assert(!row.label.includes('OpenAI') && !row.disclosure.includes('OpenAI'));
      if (row.provider === 'gemini_live') assert(row.label.includes('Gemini Live') && row.disclosure.includes('Gemini Live'));
    }
    results.push({ providers: rows.length });
    await mouseClick(current.handle);
    current = await state(); assert(current.expanded); inBounds(current, 1100, 800);
    await screenshot('desktop-controls');
    await mouseClick(await point('.rt-smoke-outside'));
    current = await state(); assert.equal(current.outside, 0); assert.equal(current.ends, 0); assert.equal(current.expanded, false);

  }
  if (['desktop', 'docking'].includes(phase)) {
    await ev(`f.panel.show({ name: '森屿' }); f.panel.setAudioLevel({ input: { level: .75, bands: [.2,.4,.6,.8,1,.8,.6,.4,.2] } });`);
    await mouseDrag((await state()).handle, { x: 1080, y: 760 });
    current = await state(); assert.equal(current.expanded, false, 'drag does not become a click'); assert.equal(current.dragging, false);
    inBounds(current, 1100, 800); assert(current.left > 950 && current.top > 650); assert.equal(current.dock, 'right'); assert.equal(current.width, 88);
    await screenshot('desktop-orb');
    const compact = current;
    await mouseClick(current.handle);
    current = await state(); assert(current.expanded); inBounds(current, 1100, 800);
    await mouseClick(current.handle); current = await state();
    assert.equal(current.left, compact.left); assert.equal(current.top, compact.top, 'collapse restores compact anchor');
  }
  if (['desktop', 'docking', 'keyboard'].includes(phase)) {
    await ev(`f.host.querySelector('.realtime-call-handle').focus();`);
    await key('Home', 'Home', 36, 1); current = await state(); assert(current.top <= 11);
    await key('ArrowLeft', 'ArrowLeft', 37, 1); assert.equal((await state()).dock, 'left'); assert.equal((await state()).left, 10);
    await key('Enter', 'Enter', 13); assert((await state()).expanded);
    await key('Escape', 'Escape', 27); current = await state(); assert(!current.expanded && current.focused && current.ends === 0);
    results.push({ keyboard: 'move, return to top, Enter and Escape passed' });
  }

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  await ev(`f.host.querySelector('.realtime-call-handle').focus();`); await key('Home', 'Home', 36, 1);
  current = await state(); inBounds(current, 390, 780);
  if (phase !== 'details') {
    await touch('touchStart', current.handle);
    for (const [x, y] of [[160, 180], [80, 350], [30, 510]]) { await touch('touchMove', { x, y }); await pause(40); }
    await touch('touchEnd'); await pause();
    current = await state(); assert.equal(current.expanded, false); assert(current.top > 400); inBounds(current, 390, 780);
    await tap(current.handle); current = await state(); assert(current.expanded); inBounds(current, 390, 780);
    await tap(await point('[data-call-action="mute"]')); assert.equal((await state()).muted, true);
    assert.equal(await ev(`return f.host.querySelector('.realtime-call-muted-mark').hidden;`), false);
    await tap(await point('[data-call-action="output"]')); assert.equal((await state()).outputMuted, true);
    await tap(await point('[data-call-action="interrupt"]')); assert.equal((await state()).interrupts, 0, 'interrupt disabled while listening');
    await ev(`f.panel.renderState({ status: 'speaking' });`);
    await tap(await point('[data-call-action="interrupt"]')); assert.equal((await state()).interrupts, 1);
  } else await ev(`f.panel.show({ name: '森屿' }, { expanded: true }); f.panel.renderState({ status: 'speaking' });`);
  await ev(`f.panel.setWarning('连接暂时中断，请稍候'); f.panel.setCaption({ role: 'user', text: '<img src=x onerror=alert(1)>'.repeat(20) });`);
  assert.equal(await ev(`return f.host.querySelector('.realtime-call-caption p').children.length;`), 0);
  await tap(await point('.realtime-call-disclosure'));
  assert.equal(await ev(`const tip = document.querySelector('.app-help-tip.is-visible'); return !!tip && tip.textContent.includes('Gemini Live');`), true, 'disclosure opens with a touch');
  await tap({ x: 380, y: 120 }); current = await state(); assert.equal(current.ends, 0); assert(!current.expanded);
  assert.equal(await ev(`return f.host.querySelector('.realtime-call-alert').hidden;`), false, 'compact warning visible');
  const beforeCancel = current;
  await touch('touchStart', current.handle); await touch('touchMove', { x: 300, y: 150 }); await touch('touchCancel'); await pause();
  current = await state(); assert.equal(current.left, beforeCancel.left); assert.equal(current.top, beforeCancel.top); assert(!current.dragging);
  await ev(`f.panel.setWarning(''); f.panel.renderState({ status: 'listening', muted: false, outputMuted: false });
    f.panel.setCaption({ role: 'assistant', text: '窗外的雨停了，要不要一起出去走走？' });
    f.host.querySelector('.realtime-call-handle').focus();`);
  await key('Home', 'Home', 36, 1); await screenshot('mobile-pill');
  await tap((await state()).handle); await screenshot('mobile-controls');
  results.push({ mobile: phase === 'details' ? 'disclosure, warnings, text safety and cancellation passed' : 'touch drag/tap, controls, disclosure, warnings, text safety and cancellation passed' });

  await command('Emulation.setDeviceMetricsOverride', { width: 320, height: 440, deviceScaleFactor: 1, mobile: true });
  await ev(`await f.initializeI18n({ preference: 'en' }); f.panel.show({ name: 'A very long character display name' }, { expanded: true });
    f.panel.renderState({ status: 'connecting', provider: 'gemini_live' }); f.localizeDomSubtree(f.host);`);
  await pause(); current = await state(); inBounds(current, 320, 440);
  assert.equal(await ev(`return f.host.querySelector('.realtime-call-handle').getAttribute('aria-label');`), 'Minimize call');
  await ev(`f.panel.setCaption({ role: 'assistant', text: '结束' });`); await pause();
  assert.equal(await ev(`return f.host.querySelector('.realtime-call-caption p').textContent;`), '结束', 'captions retain original content across UI languages');
  await screenshot('narrow-english');
  await ev(`f.host.style.setProperty('--app-surface-page', '#191c23'); f.host.style.setProperty('--app-surface-card', '#252932');
    f.host.style.setProperty('--app-surface-input', '#2c303a'); f.host.style.setProperty('--app-surface-subtle', '#2c303a');
    f.host.style.setProperty('--app-text-primary', '#eef0f6'); f.host.style.setProperty('--app-text-secondary', '#b2b9c8');
    f.host.style.setProperty('--app-text-muted', '#929cad'); f.host.style.setProperty('--app-border-subtle', '#414753');
    f.host.style.setProperty('--app-accent-primary', '#81baff'); f.host.style.setProperty('--app-accent-strong', '#81baff');`);
  await screenshot('narrow-dark');
  await command('Emulation.setDeviceMetricsOverride', { width: 640, height: 240, deviceScaleFactor: 1, mobile: true });
  await pause(); inBounds(await state(), 640, 240);
  results.push({ layouts: '390, 320, English, dark surfaces and short landscape passed' });

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 1, mobile: true });
  await pause();
  await ev(`f.panel.show({ name: '森屿' });`);
  await tap(await point('[data-call-action="end"]'));
  current = await state(); assert.equal(current.ends, 1); assert.equal(current.visible, false);
  await ev(`f.panel.show({ name: '森屿' });`); assert.equal((await state()).expanded, true);
  await ev(`f.panel.destroy(); f.panel.destroy();`);
  assert.equal(await ev(`return f.host.querySelector('.realtime-call-layer') === null;`), true);
  results.push({ lifecycle: 'explicit hangup, re-show and idempotent destroy passed' });
  console.log(JSON.stringify({ passed: true, phase, results }, null, 2));
} finally {
  if (touching) await touch('touchCancel');
  await evaluateInApp(`(async () => { const f = window.__rtPanelSmoke; if (!f) return; await f.meter?.close(); await f.audioContext?.close(); f.panel.destroy(); f.host.remove();
    await f.initializeI18n({ preference: f.locale }); f.previousFocus?.focus?.({ preventScroll: true }); delete window.__rtPanelSmoke; })()`);
  await command('Emulation.setTouchEmulationEnabled', { enabled: false });
  await command('Emulation.clearDeviceMetricsOverride');
  socket.close();
}
