import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createWsClient, findAppPageTarget, evaluateInApp } from '../dev/cdp-client.mjs';
const output = '../realtime-checks'; mkdirSync(output, { recursive: true });
await evaluateInApp(readFileSync('scripts/dev/realtime-voice-picker-smoke.js','utf8'));
const page = await findAppPageTarget(), pending = new Map(); let socket, sequence = 0;
await new Promise((resolve,reject) => { socket = createWsClient(page.webSocketDebuggerUrl, { onOpen: resolve, onError: reject, onMessage: raw => {
  const message = JSON.parse(raw), waiter = pending.get(message.id); if (!waiter) return; pending.delete(message.id); if (message.error) waiter.reject(new Error(JSON.stringify(message.error))); else waiter.resolve(message.result);
} }); });
const command = (method,params = {}) => new Promise((resolve,reject) => { const id = ++sequence; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params})); });
const settlePaint = () => evaluateInApp('(async () => { await new Promise(r=>setTimeout(r,350)); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); })()');
const results = [];
try {
  if (!process.argv.includes('--hover-only') && !process.argv.includes('--visual-only')) results.push(await evaluateInApp('window.__voicePickerSmoke.verify()'));
  for (const [width,locale] of (process.argv.includes('--hover-only') ? [[1100,'zh-CN']] : [[1100,'zh-CN'],[390,'zh-CN'],[320,'en'],[390,'zh-TW']])) {
    await command('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    await command('Emulation.setTouchEmulationEnabled', { enabled: width < 600 });
    if (width >= 600) await command('Input.dispatchMouseEvent', { type:'mouseMoved', x:10, y:10 });
    await evaluateInApp(`window.__voicePickerSmoke.prepare(${width},${JSON.stringify(locale)})`);
    await settlePaint();
    const point = await evaluateInApp(`(() => { const f = window.__voicePickerSmoke, b = f.query('rt-voice-options').querySelector('[data-rt-voice="Puck"]'), r = b.getBoundingClientRect(); return { x:r.x+r.width/2,y:r.y+r.height/2 }; })()`);
    if (width >= 600) {
      await evaluateInApp(`(() => { const f=window.__voicePickerSmoke; f.events=[]; for(const type of ['pointerover','pointerout','scroll','keydown','keyup']) f.fixture.addEventListener(type,e=>f.events.push({type, pointerType:e.pointerType, target:e.target.tagName, voice:e.target.closest?.('[data-rt-voice]')?.dataset.rtVoice}),{capture:true}); })()`);
      await command('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await settlePaint();
      const tooltip = await evaluateInApp(`(async () => { const deadline=Date.now()+1500; while (!document.querySelector('.rt-voice-tooltip') && Date.now()<deadline) await new Promise(r=>setTimeout(r,20)); return {visible:!!document.querySelector('.rt-voice-tooltip'),text:document.querySelector('.rt-voice-tooltip')?.textContent}; })()`);
      const shot = await command('Page.captureScreenshot', { format:'png' }); writeFileSync(`${output}/realtime-voice-picker-hover.png`, Buffer.from(shot.data,'base64'));
      const hit = await evaluateInApp(`({point:${JSON.stringify(point)},hit:document.elementFromPoint(${point.x},${point.y})?.outerHTML?.slice(0,500),scroll:window.__voicePickerSmoke.fixture.scrollTop,events:window.__voicePickerSmoke.events})`);
      assert(tooltip.visible && tooltip.text.includes('Puck') && tooltip.text.includes('男声'), `Desktop hover lacks metadata: ${JSON.stringify({tooltip,hit})}`);
      await evaluateInApp(`window.__voicePickerSmoke.query('rt-voice-options').querySelector('[data-rt-voice="Puck"]').focus()`);
      await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code:'Enter', windowsVirtualKeyCode:13, text:'\r', unmodifiedText:'\r' });
      await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code:'Enter', windowsVirtualKeyCode:13 });
    } else {
      await command('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{...point,id:1}] });
      await command('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    }
    await evaluateInApp(`(async () => { const deadline=Date.now()+1500; while (window.__voicePickerSmoke.query('rt-voice').value !== 'Puck' && Date.now()<deadline) await new Promise(r=>setTimeout(r,20)); })()`);
    await settlePaint();
    const layout = await evaluateInApp(`(() => {
      const f = window.__voicePickerSmoke, list = f.query('rt-voice-options'), bounds = f.fixture.getBoundingClientRect();
      return { selected:f.query('rt-voice').value, detail:f.query('rt-voice-detail').textContent, count:list.querySelectorAll('button').length,
        overflow:f.fixture.scrollWidth>f.fixture.clientWidth+2 || [...f.fixture.querySelectorAll('input,button,select')].filter(e=>e.getClientRects().length).some(e=>e.getBoundingClientRect().right>bounds.right+2),
        touchSize:[...list.querySelectorAll('button')].every(b=>b.getBoundingClientRect().height>=44), tooltip:!!document.querySelector('.rt-voice-tooltip') };
    })()`);
    const focus = await evaluateInApp(`({active:document.activeElement?.outerHTML?.slice(0,300),hasFocus:document.hasFocus(),events:window.__voicePickerSmoke.events})`);
    assert.equal(layout.selected,'Puck',JSON.stringify(focus)); assert.equal(layout.count,30); assert(!layout.overflow); assert(layout.touchSize);
    if (width < 600) assert(!layout.tooltip, 'Touch requires no hover');
    if (locale === 'en') assert(layout.detail.includes('Male voice') && layout.detail.includes('Upbeat'));
    const shot = await command('Page.captureScreenshot', { format:'png' }); writeFileSync(`${output}/realtime-voice-picker-${width}-${locale}.png`, Buffer.from(shot.data,'base64'));
    results.push({width,locale,...layout});
  }
  console.log(JSON.stringify({passed:true,results,screenshots:output},null,2));
} finally {
  await command('Emulation.setTouchEmulationEnabled',{enabled:false}); await command('Emulation.clearDeviceMetricsOverride');
  await evaluateInApp('window.__voicePickerSmoke?.cleanup()'); socket.close();
}
