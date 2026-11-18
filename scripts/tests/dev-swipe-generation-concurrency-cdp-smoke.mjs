// Run in the visible Windows dev WebView. Use an isolated DOM fixture: no provider
// calls, persona writes, conversation switches, or changes to the live handler.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  const bridge = window.appBridge;
  const stores = bridge.debugUiRegistry.stores;
  const state = () => ({
    sessionId: stores.chatStore.getCurrent(),
    scopeId: stores.chatStore.scopeId,
    isGenerating: bridge.isGenerating,
    activeNativeRequestId: bridge.activeNativeRequestId,
    workCount: stores.sessionAsyncWorkRuntime.count(stores.chatStore.getCurrent()),
  });
  const before = state();
  if (before.isGenerating || before.workCount) throw new Error('Wait for user generation to finish');
  const liveUi = bridge.getChatUI();
  const fixture = Object.create(Object.getPrototypeOf(liveUi));
  fixture.scrollEl = document.createElement('div');
  fixture.scrollEl.innerHTML = '<div class="QQ_chat_charmsg" data-msg-id="swipe-test"><div class="rp-swipe-indicator" data-msg-id="swipe-test"><button class="rp-swipe-next">Next</button></div></div>';
  const wrapper = fixture.scrollEl.firstElementChild;
  wrapper.__chatappMessage = {
    id: 'swipe-test', role: 'assistant', content: 'before',
    meta: { activeSwipe: 0, swipes: [{ content: 'before' }] },
  };
  fixture.swipeRuntime = liveUi.swipeRuntime;
  let entered = 0;
  let release;
  const prepared = new Promise(resolve => { release = resolve; });
  fixture.onSwipeRegen(async () => {
    entered += 1;
    await prepared;
    return true;
  });
  fixture._bindSwipeEvents();
  try {
    const next = wrapper.querySelector('button');
    next.click(); next.click();
    const afterDoubleClick = entered;
    const duplicateRetry = await fixture._swipeRegenHandler({ msgId: 'swipe-test' });
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    const nextAttempt = await fixture._swipeRegenHandler({ msgId: 'swipe-test' });
    return { before, after: state(), afterDoubleClick, duplicateRetry, nextAttempt, entered };
  } finally {
    release();
    fixture._unbindSwipeEvents?.();
  }
})()`);
assert.equal(result.afterDoubleClick, 1, 'double arrow clicks start only one branch operation');
assert.equal(result.duplicateRetry, false, 'guardian retry uses the same guard');
assert.equal(result.nextAttempt, true);
assert.equal(result.entered, 2);
assert.deepEqual(result.after, result.before, 'native user state is unchanged');
const directory = 'scripts/dev/tmp/swipe-generation-lock-20261113';
mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/native-after.json`, JSON.stringify(result, null, 2));
console.log('PASS native swipe registration: duplicate click / duplicate retry / subsequent generation; user state unchanged');
