import assert from 'node:assert/strict';

import {
  appendStandardMessageLayoutCore,
  buildBubbleStackCore,
  scheduleSelectionModeApplyCore,
} from '../../src/scripts/ui/chat/message-layout-ui-utils.js';

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.className = '';
      this.textContent = '';
      this.children = [];
      this.childNodes = this.children;
      this.style = {};
      this.dataset = {};
      this.attributes = new Map();
      this.classList = {
        add: (...tokens) => {
          const next = new Set(String(this.className || '').split(/\s+/).filter(Boolean));
          tokens.filter(Boolean).forEach(token => next.add(token));
          this.className = [...next].join(' ');
        },
      };
    }
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    }
  }
  return {
    createElement(tagName) {
      return new FakeElement(tagName);
    },
  };
};

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const reactionSummary = documentLike.createElement('div');
  const reactionBtn = documentLike.createElement('button');
  const stack = buildBubbleStackCore({
    documentLike,
    bubble,
    isUser: true,
    reactionSummaryEl: reactionSummary,
    reactionButton: reactionBtn,
  });
  assert.equal(stack.className.includes('chat-bubble-stack'), true);
  assert.equal(stack.className.includes('is-user'), true);
  assert.deepEqual(stack.children, [bubble, reactionBtn]);
  console.log('ok - buildBubbleStackCore keeps persistent reactions out of the bubble content stack');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const sidecar = documentLike.createElement('div');
  const reactionSummary = documentLike.createElement('div');
  const stack = buildBubbleStackCore({
    documentLike,
    bubble,
    messageSidecarEl: sidecar,
    reactionSummaryEl: reactionSummary,
  });
  assert.deepEqual(stack.children, [bubble, sidecar]);
  console.log('ok - buildBubbleStackCore keeps optional sidecars adjacent to bubble content');
}

{
  const documentLike = createFakeDocument();
  const wrapper = documentLike.createElement('div');
  const avatar = documentLike.createElement('img');
  const bubbleStack = documentLike.createElement('div');
  const reactionSummary = documentLike.createElement('div');
  reactionSummary.className = 'chat-reaction-summary';
  appendStandardMessageLayoutCore({
    documentLike,
    wrapper,
    avatarImg: avatar,
    bubbleStack,
    reactionSummaryEl: reactionSummary,
    message: { id: 'chat-user-reaction', role: 'user', time: '09:45', status: 'sent', meta: {} },
    isUser: true,
    uiMode: 'chat',
  });
  const reactionFooter = bubbleStack.children[0];
  assert.equal(reactionFooter.className, 'chat-message-footer is-user');
  assert.equal(reactionFooter.children[0], reactionSummary);
  assert.equal(reactionFooter.children[1].className, 'chat-time-row');
  assert.equal(reactionFooter.children[1].children.at(-1).textContent, '09:45');
  assert.deepEqual(wrapper.children[0].children, [bubbleStack]);
  console.log('ok - chat user reactions and metadata share one two-zone bubble footer');
}

{
  const documentLike = createFakeDocument();
  const wrapper = documentLike.createElement('div');
  const avatar = documentLike.createElement('img');
  const bubbleStack = documentLike.createElement('div');
  appendStandardMessageLayoutCore({
    documentLike,
    wrapper,
    avatarImg: avatar,
    bubbleStack,
    message: { role: 'user', time: '10:00', meta: {} },
    isUser: true,
  });
  assert.equal(wrapper.children.length, 2);
  const contentWrap = wrapper.children[0];
  const timeRow = contentWrap.children[1];
  assert.equal(contentWrap.className, 'chat-message-stack');
  assert.equal(timeRow.className, 'chat-time-row');
  assert.equal(timeRow.children[0].className, 'chat-delivery-status');
  assert.equal(timeRow.children[0].textContent, '已读');
  assert.equal(timeRow.children[1].textContent, '10:00');
  console.log('ok - appendStandardMessageLayoutCore builds user-side stack with delivery row');
}

{
  const documentLike = createFakeDocument();
  const wrapper = documentLike.createElement('div');
  const avatar = documentLike.createElement('img');
  const bubbleStack = documentLike.createElement('div');
  appendStandardMessageLayoutCore({
    documentLike,
    wrapper,
    avatarImg: avatar,
    bubbleStack,
    message: { id: 'u1', role: 'user', time: '10:05', status: 'sent', meta: {} },
    isUser: true,
    uiMode: 'rp',
  });
  assert.equal(wrapper.className.includes('has-rp-message-actions'), true);
  const timeRow = wrapper.children[0].children[1];
  const actions = timeRow.children[0];
  assert.equal(actions.className.includes('is-user'), true);
  assert.equal(timeRow.children[1].className, 'chat-delivery-status');
  assert.equal(timeRow.children[2].className, 'QQ_chat_time');
  assert.deepEqual(
    actions.children[0].children.map(button => button.dataset.rpMessageAction),
    ['copy', 'edit'],
  );
  console.log('ok - creative user actions stay left of the right-aligned delivery metadata');
}

{
  const documentLike = createFakeDocument();
  const wrapper = documentLike.createElement('div');
  const avatar = documentLike.createElement('img');
  const bubbleStack = documentLike.createElement('div');
  const swipeIndicator = documentLike.createElement('div');
  appendStandardMessageLayoutCore({
    documentLike,
    wrapper,
    avatarImg: avatar,
    bubbleStack,
    message: { id: 'a1', role: 'assistant', name: '助手', time: '11:00', meta: {} },
    isUser: false,
    uiMode: 'rp',
    createSwipeIndicatorElement: () => swipeIndicator,
    resolveRpCharacterName: () => '莉莉丝',
  });
  assert.equal(wrapper.children.length, 2);
  assert.equal(wrapper.className.includes('has-rp-message-chrome'), true);
  assert.equal(wrapper.className.includes('has-rp-message-actions'), true);
  const contentWrap = wrapper.children[1];
  const header = contentWrap.children[0];
  assert.equal(header.className, 'rp-message-header');
  assert.equal(header.children[0].className, 'QQ_chat_name rp-message-name');
  assert.equal(header.children[0].textContent, '莉莉丝');
  assert.equal(header.children[1].className, 'QQ_chat_time');
  assert.equal(header.children[1].textContent, '11:00');
  assert.equal(contentWrap.children[1], bubbleStack);
  const actions = contentWrap.children[2];
  assert.equal(actions.className, 'rp-message-actions');
  assert.equal(actions.children[0], swipeIndicator);
  assert.deepEqual(
    actions.children[1].children.map(button => button.dataset.rpMessageAction),
    ['regenerate', 'speak', 'view-code', 'copy', 'quick-delete'],
  );
  assert.equal(contentWrap.children.length, 3);
  console.log('ok - appendStandardMessageLayoutCore builds compact rp assistant chrome with character header and actions');
}

{
  const documentLike = createFakeDocument();
  const wrapper = documentLike.createElement('div');
  const avatar = documentLike.createElement('img');
  const bubbleStack = documentLike.createElement('div');
  appendStandardMessageLayoutCore({
    documentLike,
    wrapper,
    avatarImg: avatar,
    bubbleStack,
    message: { role: 'assistant', name: 'Bot', time: '11:10', meta: { showName: true, isGreeting: true } },
    isUser: false,
    uiMode: 'rp',
    createSwipeIndicatorElement: () => {
      throw new Error('greeting should not build rp actions');
    },
  });
  assert.equal(wrapper.className.includes('has-rp-message-chrome'), false);
  assert.equal(wrapper.className.includes('is-rp-greeting-message'), true);
  const contentWrap = wrapper.children[1];
  assert.equal(contentWrap.children[0].className, 'QQ_chat_name');
  assert.equal(contentWrap.children[1], bubbleStack);
  assert.equal(contentWrap.children[2].className, 'QQ_chat_time');
  console.log('ok - appendStandardMessageLayoutCore leaves the rp greeting card chrome unchanged');
}

{
  const documentLike = createFakeDocument();
  const wrapper = documentLike.createElement('div');
  const avatar = documentLike.createElement('img');
  const bubbleStack = documentLike.createElement('div');
  const reactionSummary = documentLike.createElement('div');
  reactionSummary.className = 'chat-reaction-summary';
  appendStandardMessageLayoutCore({
    documentLike,
    wrapper,
    avatarImg: avatar,
    bubbleStack,
    reactionSummaryEl: reactionSummary,
    message: { role: 'assistant', name: 'Bot', time: '11:20', meta: { showName: true } },
    isUser: false,
    uiMode: 'chat',
    createSwipeIndicatorElement: () => {
      throw new Error('ordinary chat quick actions must not build a swipe indicator');
    },
    resolveRpCharacterName: () => 'should not be used',
  });
  const contentWrap = wrapper.children[1];
  assert.equal(wrapper.className.includes('has-rp-message-chrome'), false);
  assert.equal(wrapper.className.includes('has-rp-message-actions'), true);
  assert.equal(contentWrap.children[0].textContent, 'Bot');
  assert.equal(contentWrap.children[1], bubbleStack);
  assert.equal(contentWrap.children.length, 2);
  const reactionFooter = bubbleStack.children[0];
  assert.equal(reactionFooter.className, 'chat-message-footer is-assistant');
  assert.equal(reactionFooter.children[0], reactionSummary);
  const metadata = reactionFooter.children[1];
  assert.equal(metadata.className.includes('is-assistant'), true);
  assert.equal(metadata.children[0].textContent, '11:20');
  const actions = metadata.children[1];
  assert.equal(actions.children.length, 1);
  assert.deepEqual(
    actions.children[0].children.map(button => button.dataset.rpMessageAction),
    ['regenerate', 'speak', 'view-code', 'copy', 'quick-delete'],
  );
  console.log('ok - ordinary chat assistant messages expose quick actions without swipe controls');
}

{
  const documentLike = createFakeDocument();
  const wrapper = documentLike.createElement('div');
  const avatar = documentLike.createElement('img');
  const bubbleStack = documentLike.createElement('div');
  appendStandardMessageLayoutCore({
    documentLike,
    wrapper,
    avatarImg: avatar,
    bubbleStack,
    message: {
      id: 'chat-user',
      role: 'user',
      time: '11:30',
      editedAt: 123,
      status: 'sent',
      meta: {},
    },
    isUser: true,
    uiMode: 'chat',
  });
  assert.equal(wrapper.className.includes('has-rp-message-actions'), true);
  const timeRow = wrapper.children[0].children[1];
  assert.deepEqual(
    timeRow.children[0].children[0].children.map(button => button.dataset.rpMessageAction),
    ['copy', 'edit'],
  );
  assert.equal(timeRow.children[1].className, 'chat-delivery-status');
  assert.equal(timeRow.children[2].className, 'QQ_chat_time');
  assert.equal(timeRow.children[2].textContent, '11:30 · 已编辑');
  console.log('ok - ordinary chat user messages share copy and edit quick actions');
}

{
  const marked = [];
  const visibleCalls = [];
  const scheduled = [];
  const wrapper = { id: 'wrapper' };
  const scrollEl = {
    querySelector(selector) {
      return selector === '[data-msg-id="m-select"][data-role]' ? wrapper : null;
    },
  };
  const scheduledOk = scheduleSelectionModeApplyCore({
    selectionMode: true,
    messageId: 'm-select',
    scrollEl,
    markWrapperSelectable: (nextWrapper, msgId) => marked.push([nextWrapper, msgId]),
    setSelectionBarVisible: visible => visibleCalls.push(visible),
    schedule: (handler, delay) => {
      scheduled.push(delay);
      handler();
    },
  });
  assert.equal(scheduledOk, true);
  assert.deepEqual(marked, [[wrapper, 'm-select']]);
  assert.deepEqual(visibleCalls, [true]);
  assert.deepEqual(scheduled, [0]);
  assert.equal(scheduleSelectionModeApplyCore({ selectionMode: false, messageId: 'm-select' }), false);
  console.log('ok - scheduleSelectionModeApplyCore defers selectable wrapper marking only when selection mode is active');
}
