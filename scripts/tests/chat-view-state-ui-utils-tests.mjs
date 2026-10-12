import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  clearInputCore,
  clearMessagesCore,
  scrollToBottomCore,
  scrollToMessageCore,
  showConversationLoadingCore,
  updateSendButtonStateCore,
} from '../../src/scripts/ui/chat/chat-view-state-ui-utils.js';

const createClassList = () => {
  const set = new Set();
  return {
    add: token => set.add(token),
    remove: token => set.delete(token),
    contains: token => set.has(token),
    toggle: (token, force) => {
      if (force) set.add(token);
      else set.delete(token);
    },
  };
};

{
  let focused = 0;
  const inputEl = {
    value: 'text',
    focus() { focused += 1; },
  };
  clearInputCore({ inputEl, options: { focus: true } });
  assert.equal(inputEl.value, '');
  assert.equal(focused, 1);
  console.log('ok - clearInputCore clears composer text and focuses when requested');
}

{
  let removed = 0;
  const floatingTypingEl = { remove() { removed += 1; } };
  const scrollEl = { innerHTML: '<div></div>' };
  const cleared = clearMessagesCore({
    scrollEl,
    cleanupRichTextMounts() {},
    hideReactionPicker() {},
    hideScrollDateBadge() {},
    hideScrollBottomButton() {},
    clearDeliverySequence() {},
    clearTypingTimers() {},
    getReadCountTimer: () => null,
    setReadCountTimer() {},
    setReadCountCurrent() {},
    setReadCountMax() {},
    setReadCountTargets() {},
    setDeliverySequenceDone() {},
    setTypingEl() {},
    getFloatingTypingEl: () => floatingTypingEl,
    setFloatingTypingEl(value) { assert.equal(value, null); },
    setRpFloorCount(value) { assert.equal(value, 0); },
  });
  assert.equal(cleared, true);
  assert.equal(scrollEl.innerHTML, '');
  assert.equal(removed, 1);
  console.log('ok - clearMessagesCore resets scroll content and floating typing state');
}

{
  const children = [];
  const documentLike = {
    createElement() {
      return {
        style: {},
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
      };
    },
  };
  const scrollEl = {
    appendChild(node) { children.push(node); },
    scrollTop: 99,
  };
  const wrapper = showConversationLoadingCore({
    title: '测试会话',
    scrollEl,
    documentLike,
    clearMessages() {},
    scheduleScrollBottomButtonRefresh() {},
  });
  assert.equal(Boolean(wrapper), true);
  assert.equal(children.length, 1);
  assert.equal(scrollEl.scrollTop, 0);
  console.log('ok - showConversationLoadingCore mounts loading skeleton and resets scroll top');
}

{
  const sendBtn = {
    disabled: false,
    classList: createClassList(),
    attrs: new Map(),
    setAttribute(name, value) { this.attrs.set(name, value); },
  };
  const contBtn = { disabled: false };
  const state = updateSendButtonStateCore({
    sendBtn,
    isSending: true,
    isStreaming: false,
    isOnline: true,
    continueButton: contBtn,
  });
  assert.equal(state.isBusy, true);
  assert.equal(sendBtn.classList.contains('is-generating'), true);
  assert.equal(sendBtn.attrs.get('aria-label'), '停止生成');
  assert.equal(contBtn.disabled, true);
  console.log('ok - updateSendButtonStateCore synchronizes busy state aria label and continue button');
}

{
  const makeSendBtn = () => ({
    disabled: false,
    classList: createClassList(),
    attrs: new Map(),
    setAttribute(name, value) { this.attrs.set(name, value); },
  });

  // 揭示动画播放中：发送键化为跳过键（无论输入内容），标签与样式态都要切换。
  const revealBtn = makeSendBtn();
  const revealState = updateSendButtonStateCore({
    sendBtn: revealBtn,
    isSending: false,
    isStreaming: false,
    isRevealing: true,
    isOnline: true,
  });
  assert.equal(revealState.revealing, true);
  assert.equal(revealBtn.classList.contains('is-revealing'), true);
  assert.equal(revealBtn.classList.contains('is-generating'), false);
  assert.equal(revealBtn.attrs.get('aria-label'), '跳过动画');
  assert.equal(revealBtn.attrs.get('title'), '跳过动画');

  // 生成中的停止语义优先于跳过。
  const busyBtn = makeSendBtn();
  const busyState = updateSendButtonStateCore({
    sendBtn: busyBtn,
    isSending: true,
    isRevealing: true,
    isOnline: true,
  });
  assert.equal(busyState.revealing, false);
  assert.equal(busyBtn.classList.contains('is-generating'), true);
  assert.equal(busyBtn.classList.contains('is-revealing'), false);
  assert.equal(busyBtn.attrs.get('aria-label'), '停止生成');

  // 揭示结束后回到发送态。
  const idleBtn = makeSendBtn();
  const idleState = updateSendButtonStateCore({
    sendBtn: idleBtn,
    isRevealing: false,
    isOnline: true,
  });
  assert.equal(idleState.revealing, false);
  assert.equal(idleBtn.classList.contains('is-revealing'), false);
  assert.equal(idleBtn.attrs.get('aria-label'), '发送');
  console.log('ok - updateSendButtonStateCore turns the send button into a skip key only while revealing');
}

{
  const scrollEl = { scrollTop: 0, scrollHeight: 320 };
  let autoFollow = false;
  scrollToBottomCore({
    scrollEl,
    isStreaming: true,
    setProgrammaticScroll() {},
    setProgrammaticStreamFollowScroll() {},
    setStreamAutoFollow(value) { autoFollow = value; },
    scheduleScrollBottomButtonRefresh() {},
  });
  assert.equal(scrollEl.scrollTop, 320);
  assert.equal(autoFollow, true);
  console.log('ok - scrollToBottomCore jumps to the bottom and reenables stream auto-follow');
}

{
  const target = { offsetTop: 88 };
  const scrollEl = {
    scrollTop: 0,
    querySelector(selector) {
      if (selector.includes('msg-1')) return target;
      return null;
    },
  };
  const resolved = scrollToMessageCore({
    msgId: 'msg-1',
    scrollEl,
    setProgrammaticStreamFollowScroll() {},
    scheduleScrollBottomButtonRefresh() {},
  });
  assert.equal(resolved, target);
  assert.equal(scrollEl.scrollTop, 76);
  console.log('ok - scrollToMessageCore resolves target wrapper and scrolls near it');
}

{
  const [indexSource, cssSource, appSource, chatUiSource] = await Promise.all([
    readFile(new URL('../../src/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/assets/css/qq-legacy.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/scripts/ui/chat/chat-ui.js', import.meta.url), 'utf8'),
  ]);
  // 跳过键 SVG 必须挂在发送按钮内，样式只消费主题 token。
  const sendButtonBlock = indexSource.slice(
    indexSource.indexOf('id="send-button"'),
    indexSource.indexOf('</button>', indexSource.indexOf('id="send-button"')),
  );
  assert.match(sendButtonBlock, /class="chat-skip-icon"/);
  assert.equal(
    (sendButtonBlock.match(/chat-skip-icon-play/g) || []).length,
    2,
    '跳过键必须是圆角实心双三角',
  );
  assert.match(
    cssSource,
    /\.chat-send-btn\.is-revealing\s*\{[\s\S]*?var\(--app-text-primary\)[\s\S]*?var\(--app-surface-card\)[\s\S]*?var\(--app-shadow-sm\)/,
    '跳过键底座必须消费主题 token（深浅色自动翻转）',
  );
  assert.match(cssSource, /\.chat-skip-icon-play\s*\{[\s\S]*?fill:\s*currentColor[\s\S]*?stroke-linejoin:\s*round/);
  assert.match(cssSource, /\.chat-send-btn\.is-revealing \.chat-send-icon\s*\{\s*display:\s*none/);
  // 揭示态由投放 runtime 驱动：调度、完成与进房都要同步按钮态；点击在停止语义之后、发送之前拦截为跳过。
  assert.match(appSource, /const syncProtocolRevealButtonState = \(\) =>/);
  const scheduleBlock = appSource.slice(
    appSource.indexOf('const scheduleProtocolDeliveryQueue'),
    appSource.indexOf('const fastForwardProtocolDeliveryQueues'),
  );
  assert.equal(
    (scheduleBlock.match(/syncProtocolRevealButtonState\(\)/g) || []).length,
    2,
    '队列调度与完成清理都必须同步跳过键状态',
  );
  const composerBlock = appSource.slice(
    appSource.indexOf('const handleComposerSend = () => {'),
    appSource.indexOf('handleSend();', appSource.indexOf('const handleComposerSend = () => {')),
  );
  assert.match(composerBlock, /cancelActiveGeneration\('user'\)/);
  assert.match(composerBlock, /protocolDeliveryQueuesBySession\.has\(revealSid\)/);
  assert.ok(
    composerBlock.indexOf("cancelActiveGeneration('user')") < composerBlock.indexOf('protocolDeliveryQueuesBySession.has(revealSid)'),
    '生成中的停止语义必须优先于跳过动画',
  );
  assert.match(chatUiSource, /setRevealingState\(isRevealing\)/);
  console.log('ok - skip-animation send button is wired through delivery runtime, composer, and themed svg');
}

{
  // 平滑跳转：远距离先移到目标前一小段（约 240px），再平滑滑到目标；近距离直接滑
  const calls = [];
  const makeScrollEl = (scrollTop) => ({
    scrollTop,
    clientHeight: 800,
    querySelector: () => ({ offsetTop: 10_012 }),
    scrollTo(options) { calls.push({ from: this.scrollTop, ...options }); },
  });
  const far = makeScrollEl(50_000);
  scrollToMessageCore({ msgId: 'm', scrollEl: far, smooth: true });
  assert.deepEqual(calls.pop(), { from: 10_240, top: 10_000, behavior: 'smooth' });
  const near = makeScrollEl(10_500);
  scrollToMessageCore({ msgId: 'm', scrollEl: near, smooth: true });
  assert.deepEqual(calls.pop(), { from: 10_500, top: 10_000, behavior: 'smooth' });
  const instant = makeScrollEl(50_000);
  scrollToMessageCore({ msgId: 'm', scrollEl: instant });
  assert.equal(instant.scrollTop, 10_000);
  assert.equal(calls.length, 0);
  console.log('ok - scrollToMessageCore slides to far targets from a short distance');
}

{
  // 远距离时把「移到目标附近」交给 teleport（淡出→移动→淡入），近距离不经过它
  const seen = [];
  const el = { scrollTop: 50_000, clientHeight: 800, querySelector: () => ({ offsetTop: 10_012 }), scrollTo(o) { seen.push(['slide', this.scrollTop, o.top]); } };
  scrollToMessageCore({ msgId: 'm', scrollEl: el, smooth: true, teleport: (move, direction) => { seen.push(['teleport', direction, el.scrollTop]); move(); } });
  assert.deepEqual(seen, [['teleport', 'up', 50_000], ['slide', 10_240, 10_000]]);
  seen.length = 0;
  el.scrollTop = 10_400;
  scrollToMessageCore({ msgId: 'm', scrollEl: el, smooth: true, teleport: () => seen.push(['teleport']) });
  assert.deepEqual(seen, [['slide', 10_400, 10_000]]);
  console.log('ok - scrollToMessageCore hands far jumps to the fade-through teleport');
}
