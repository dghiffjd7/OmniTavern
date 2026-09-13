// Windows dev WebView. Isolated textarea and mocked model; no user configuration writes.
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const smoke = async () => {
  const { bindInputSuggestionComposer } = await import('/scripts/ui/chat/input-suggestion-composer.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;z-index:2147483647;top:35%;left:16px;width:calc(100% - 32px);max-width:540px;background:var(--app-surface-card);padding:24px;border-radius:20px;box-sizing:border-box;';
  host.innerHTML = '<div class="chat-input-wrap"><textarea class="chat-input" rows="3" aria-label="测试输入"></textarea></div>';
  document.body.append(host);
  const input = host.querySelector('textarea');
  let requests = 0, inputEvents = 0, capturedContext;
  let settings = { enabled: false, modelMode: 'profile', modelProfileId: 'mock' };
  let key = 'chat:a';
  const controller = bindInputSuggestionComposer({
    input, getSettings: () => settings, getContext: () => ({ key, agentContext: { sessionId: 'fixture', place: 'chat', archiveId: 'fixture-archive' } }),
    request: async snapshot => { requests++; capturedContext = snapshot.agentContext; return '公园散步。'; }, runtimeOptions: { delayMs: 10 },
  });
  const check = (value, message) => { if (!value) throw new Error(message); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 60));
  const type = value => { input.value = value; input.focus(); input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event('input', { bubbles: true })); };
  const keyEvent = (type, key, extra) => { const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...extra }); input.dispatchEvent(event); return event; };
  const down = (key, extra) => keyEvent('keydown', key, extra);
  const up = (key, extra) => keyEvent('keyup', key, extra);
  const tab = extra => { const event = down('Tab', extra); up('Tab', extra); return event; };
  const selected = () => host.querySelector('.input-suggestion-label .input-suggestion-selected').textContent;
  const remaining = () => host.querySelector('.input-suggestion-label .input-suggestion-remaining').textContent;
  input.addEventListener('input', () => { inputEvents++; });
  try {
    type('今天想去'); await pause();
    check(requests === 0, 'disabled feature sent a request');
    check(!tab().defaultPrevented, 'Tab without suggestion must retain native behavior');
    settings = { ...settings, enabled: true };
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    type('今天想去公'); await pause();
    check(requests === 0, 'IME composition must not request');
    check(!tab({ isComposing: true }).defaultPrevented, 'IME Tab was intercepted');
    input.dispatchEvent(new CompositionEvent('compositionend')); await pause();
    check(requests === 1, 'composition end should request once');
    check(capturedContext?.sessionId === 'fixture' && capturedContext?.archiveId === 'fixture-archive', 'request must retain the captured agent context for lazy reference resolution');
    check(input.value === '今天想去公', 'ghost changed the draft');
    check(!host.querySelector('.input-suggestion-mirror').hidden, 'ghost is missing');
    check(!host.querySelector('.input-suggestion-shortcut'), 'suggestion bar should contain text without shortcut icons');
    const beforeEvents = inputEvents;
    check(tab().defaultPrevented, 'Tab should accept visible suggestion');
    check(input.value === '今天想去公公园散步。', 'accepted text was not inserted at cursor');
    check(inputEvents > beforeEvents, 'acceptance must trigger existing input/draft listeners');
    check(host.querySelector('.input-suggestion-mirror').hidden, 'accepted ghost should disappear');
    const undoSupported = document.execCommand('undo');
    check(undoSupported && input.value === '今天想去公', 'acceptance must support native undo');
    controller.cancel();

    type('今天想去'); await pause();
    const partialRequests = requests, partialEvents = inputEvents;
    check(down('Tab').defaultPrevented, 'Tab should arm acceptance');
    down('Tab', { repeat: true });
    check(input.value === '今天想去' && selected() === '', 'holding or repeating Tab must not insert or highlight');
    check(!host.querySelector('.input-suggestion-accept').classList.contains('is-selecting'), 'Tab alone changed selection styling');
    down('ArrowRight');
    check(selected() === '公', 'the first right arrow starts at one character');
    down('ArrowRight'); down('ArrowRight'); down('ArrowLeft');
    check(selected() === '公园' && remaining() === '散步。', 'arrow keys should adjust the prefix in both directions');
    check(input.value === '今天想去' && inputEvents === partialEvents, 'selection preview must not change the draft or emit input');
    up('Tab');
    check(input.value === '今天想去公园', 'Tab release must commit just the selected prefix');
    check(selected() === '' && remaining() === '散步。', 'unaccepted characters should remain as a fresh suggestion');
    check(requests === partialRequests, 'partial acceptance must not request another suggestion');
    check(document.execCommand('undo') && input.value === '今天想去', 'partial acceptance must be one undoable insertion');
    controller.cancel();

    type('明天想去'); await pause();
    down('Tab'); down('ArrowRight'); down('ArrowLeft'); up('Tab');
    check(input.value === '明天想去' && remaining() === '公园散步。', 'returning to zero must leave the draft and suggestion intact');
    down('Tab'); down('ArrowRight'); down('Escape'); up('Tab');
    check(input.value === '明天想去' && host.querySelector('.input-suggestion-accept').hidden, 'Escape during selection must cancel without inserting');

    type('周末想去，晚上回来。'); input.setSelectionRange(4, 4); input.dispatchEvent(new Event('input', { bubbles: true })); await pause();
    down('Tab'); down('ArrowRight'); down('ArrowRight'); up('Tab');
    check(input.value === '周末想去公园，晚上回来。', 'partial acceptance must preserve text after the cursor');
    check(remaining() === '散步。' && host.querySelector('.input-suggestion-mirror').hidden, 'middle-of-text remainder belongs in the suggestion bar');
    tab();
    check(input.value === '周末想去公园散步。，晚上回来。', 'a later Tab should accept the remainder');

    type('今晚想去'); await pause();
    down('Tab'); down('ArrowRight'); input.blur(); up('Tab');
    check(input.value === '今晚想去', 'blur during selection must not commit');
    type('今天想去'); await pause();
    down('Tab'); down('ArrowRight');
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    up('Tab', { isComposing: true });
    check(input.value === '今天想去' && host.querySelector('.input-suggestion-accept').hidden, 'IME composition must cancel partial selection');
    input.dispatchEvent(new CompositionEvent('compositionend')); controller.cancel();

    type('明天想去'); await pause();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }); input.dispatchEvent(escape);
    check(host.querySelector('.input-suggestion-accept').hidden, 'Escape should dismiss');
    type('周末想去'); await pause();
    host.querySelector('.input-suggestion-accept').click();
    check(input.value === '周末想去公园散步。', 'touch/click accept failed');
    type('晚上想去'); await pause();
    key = 'writing:b';
    check(!tab().defaultPrevented && input.value === '晚上想去', 'stale context suggestion was accepted');
    type('下午想去'); await pause();
    const send = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); input.dispatchEvent(send);
    check(!send.defaultPrevented && host.querySelector('.input-suggestion-accept').hidden, 'suggestion must yield to send');
    settings = { ...settings, enabled: false };
    type('关闭以后'); await pause();
    check(host.querySelector('.input-suggestion-accept').hidden, 'disabled suggestion remains visible');
    return { passed: true, requests, undoSupported, modelRequests: 0 };
  } finally { controller.dispose(); host.remove(); }
};

try {
  const result = await evaluateInApp(`(${smoke.toString()})()`);
  assert.equal(result.passed, true);
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (error) { console.error(error.stack || error); process.exit(1); }
