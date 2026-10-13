import assert from 'node:assert/strict';

import {
  createRpMessageActionsElement,
  createRpMessageActionsUiRuntime,
  dispatchRpMessageQuickAction,
  markLatestAssistantReply,
} from '../../src/scripts/ui/chat/rp-message-actions-ui-utils.js';

const createClassList = (...initial) => {
  const classes = new Set(initial);
  return {
    add: (...tokens) => tokens.forEach(token => classes.add(token)),
    remove: (...tokens) => tokens.forEach(token => classes.delete(token)),
    contains: token => classes.has(token),
  };
};

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.className = '';
      this.children = [];
      this.dataset = {};
      this.attributes = new Map();
      this.innerHTML = '';
    }
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
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
  const swipe = documentLike.createElement('div');
  const actions = createRpMessageActionsElement({
    documentLike,
    message: { id: 'm-actions' },
    createSwipeIndicatorElement: () => swipe,
  });
  assert.equal(actions.className, 'rp-message-actions');
  assert.equal(actions.dataset.msgId, 'm-actions');
  assert.equal(actions.children[0], swipe);
  const buttons = actions.children[1].children;
  assert.deepEqual(buttons.map(button => button.dataset.rpMessageAction), ['regenerate', 'speak', 'view-code', 'copy', 'quick-delete']);
  assert.equal(buttons.every(button => button.innerHTML.includes('<svg')), true);
  assert.deepEqual(
    buttons.map(button => button.attributes.get('aria-label')),
    ['重新生成', '朗读', '编辑原回复', '复制', '删除'],
  );
  console.log('ok - createRpMessageActionsElement builds swipe and svg action controls in the requested order');
}

{
  const documentLike = createFakeDocument();
  const actions = createRpMessageActionsElement({
    documentLike,
    message: { id: 'u-actions', role: 'user' },
    kind: 'user',
  });
  assert.equal(actions.className.includes('is-user'), true);
  assert.deepEqual(
    actions.children[0].children.map(button => button.dataset.rpMessageAction),
    ['copy', 'edit'],
  );
  console.log('ok - createRpMessageActionsElement builds the compact user copy/edit action pair');
}

{
  const calls = [];
  const message = { id: 'u-edit', role: 'user' };
  assert.equal(await dispatchRpMessageQuickAction({
    action: 'edit',
    message,
    startInlineEdit: nextMessage => calls.push(['edit', nextMessage.id]),
    actionHandler: (...args) => calls.push(['action', ...args]),
  }), true);
  assert.equal(await dispatchRpMessageQuickAction({
    action: 'copy',
    message,
    wrapper: { id: 'wrapper' },
    startInlineEdit: () => {},
    actionHandler: (...args) => calls.push(['action', ...args]),
  }), true);
  assert.deepEqual(calls, [
    ['edit', 'u-edit'],
    ['action', 'copy-text', message, { wrapper: { id: 'wrapper' } }],
  ]);
  console.log('ok - creative user pencil opens inline editing while copy reuses the shared action handler');
}

const createWrapper = (id, role = 'assistant') => ({
  classList: createClassList(
    role === 'user' ? 'QQ_chat_mymsg' : 'QQ_chat_charmsg',
    'has-rp-message-actions',
    ...(role === 'assistant' ? ['has-rp-message-chrome'] : []),
  ),
  __chatappMessage: { id, role },
});

const createActionTarget = (wrapper, action) => ({
  dataset: { rpMessageAction: action },
  disabled: false,
  closest(selector) {
    if (selector === '[data-rp-message-action]') return this;
    if (selector === '.has-rp-message-actions') return wrapper;
    return null;
  },
});

const createBubbleTarget = wrapper => {
  const bubble = {
    closest(selector) {
      return selector === '.has-rp-message-actions' ? wrapper : null;
    },
  };
  return {
    closest(selector) {
      if (selector === '[data-rp-message-action]') return null;
      if (selector === 'a, button, input, textarea, select, audio, video, [contenteditable="true"]') return null;
      if (selector === '.QQ_chat_msgdiv') return bubble;
      return null;
    },
  };
};

{
  const listeners = new Map();
  const scheduled = [];
  const cleared = [];
  const calls = [];
  const first = createWrapper('a1');
  const second = createWrapper('u2', 'user');
  const scrollEl = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
  };
  const runtime = createRpMessageActionsUiRuntime({
    schedule(handler, delay) {
      const id = scheduled.length + 1;
      scheduled.push({ id, handler, delay });
      return id;
    },
    clearSchedule: id => cleared.push(id),
    isTouchLike: event => event?.pointerType === 'touch',
  });
  assert.equal(runtime.reveal({ classList: createClassList('QQ_chat_charmsg') }), false);
  const unbind = runtime.bind({
    scrollEl,
    onAction: (action, context) => calls.push([action, context.message.id, context.wrapper]),
  });
  const click = listeners.get('click');
  click({ target: createActionTarget(first, 'copy'), pointerType: 'mouse' });
  click({ target: createActionTarget(first, 'regenerate'), pointerType: 'mouse' });
  click({ target: createActionTarget(first, 'speak'), pointerType: 'mouse' });
  click({ target: createActionTarget(first, 'view-code'), pointerType: 'mouse' });
  assert.deepEqual(calls.map(([action, id]) => [action, id]), [
    ['copy', 'a1'],
    ['regenerate', 'a1'],
    ['speak', 'a1'],
    ['view-code', 'a1'],
  ]);

  click({ target: createBubbleTarget(first), pointerType: 'mouse' });
  assert.equal(first.classList.contains('is-rp-actions-visible'), false);
  click({ target: createBubbleTarget(first), pointerType: 'touch' });
  assert.equal(first.classList.contains('is-rp-actions-visible'), true);
  assert.equal(scheduled[0].delay, 5000);

  click({ target: createBubbleTarget(second), pointerType: 'touch' });
  assert.equal(first.classList.contains('is-rp-actions-visible'), false);
  assert.equal(second.classList.contains('is-rp-actions-visible'), true);
  assert.deepEqual(cleared, [1]);
  scheduled[1].handler();
  assert.equal(second.classList.contains('is-rp-actions-visible'), false);

  click({ target: createBubbleTarget(first), pointerType: 'touch' });
  unbind();
  assert.equal(listeners.has('click'), false);
  assert.equal(first.classList.contains('is-rp-actions-visible'), false);
  assert.deepEqual(cleared, [1, 3]);
  console.log('ok - delegated rp actions route existing behavior and touch reveal expires after five seconds');
}

{
  // 快捷删除：点第一下只变红（不触发），0.35 秒内的第二下不算，之后再点才删除；3 秒没点、滚动或点了别的就恢复
  const listeners = new Map();
  const scheduled = [];
  const calls = [];
  let clock = 1000;
  const wrapper = createWrapper('a-last');
  const button = {
    ...createActionTarget(wrapper, 'quick-delete'),
    classList: createClassList('rp-message-action', 'rp-message-action-quick-delete'),
    attributes: new Map([['aria-label', '删除']]),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
  };
  const scrollEl = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
  };
  const runtime = createRpMessageActionsUiRuntime({
    schedule(handler, delay) { scheduled.push({ handler, delay }); return scheduled.length; },
    clearSchedule: () => {},
    isTouchLike: event => event?.pointerType === 'touch',
    now: () => clock,
  });
  const unbind = runtime.bind({ scrollEl, onAction: (action, context) => calls.push([action, context.message.id]) });
  const click = listeners.get('click');
  const tap = (target = button) => click({ target, pointerType: 'touch' });

  tap();
  assert.deepEqual(calls, [], '第一下不删除');
  assert.equal(button.classList.contains('is-armed'), true, '第一下变红');
  assert.equal(button.attributes.get('aria-label'), '再点一次删除');
  assert.equal(wrapper.classList.contains('is-rp-actions-visible'), true, '变红期间操作栏保持显示');
  clock += 200;
  tap();
  assert.deepEqual(calls, [], '0.35 秒内的连点不算');
  clock += 300;
  tap();
  assert.deepEqual(calls, [['quick-delete', 'a-last']], '变红后再点才删除');
  assert.equal(button.classList.contains('is-armed'), false);
  assert.equal(button.attributes.get('aria-label'), '删除');

  tap();
  const disarmTimer = scheduled.filter(item => item.delay === 3000).pop();
  disarmTimer.handler();
  assert.equal(button.classList.contains('is-armed'), false, '3 秒没点就恢复');
  clock += 1000;
  tap();
  listeners.get('scroll')();
  assert.equal(button.classList.contains('is-armed'), false, '滚动就恢复');
  tap();
  click({ target: createActionTarget(wrapper, 'copy'), pointerType: 'mouse' });
  assert.equal(button.classList.contains('is-armed'), false, '点了别的按钮就恢复');
  assert.deepEqual(calls.map(([action]) => action), ['quick-delete', 'copy']);

  unbind();
  assert.equal(listeners.has('scroll'), false);
  console.log('ok - quick delete needs a second deliberate tap and disarms on timeout, scroll or other actions');
}

{
  // 只有对话的最后一条是 AI 回复（且有操作栏、不在生成中）时才标记，快捷删除只在它上面显示
  const node = (role, ...classes) => ({
    classList: createClassList(role === 'user' ? 'QQ_chat_mymsg' : 'QQ_chat_charmsg', ...classes),
    __chatappMessage: { role },
  });
  const makeScroll = list => ({
    querySelectorAll(selector) {
      if (selector === '.is-latest-reply') return list.filter(el => el.classList.contains('is-latest-reply'));
      return list;
    },
  });
  const a1 = node('assistant', 'has-rp-message-actions');
  const u2 = node('user', 'has-rp-message-actions');
  const a3 = node('assistant', 'has-rp-message-actions');
  assert.equal(markLatestAssistantReply({ scrollEl: makeScroll([a1, u2, a3]) }), a3);
  assert.equal(a3.classList.contains('is-latest-reply'), true);
  assert.equal(a1.classList.contains('is-latest-reply'), false);
  assert.equal(markLatestAssistantReply({ scrollEl: makeScroll([a1, u2, a3, node('user', 'has-rp-message-actions')]) }), null, '最后一条是用户输入时不显示');
  assert.equal(a3.classList.contains('is-latest-reply'), false, '旧标记被清掉');
  assert.equal(markLatestAssistantReply({ scrollEl: makeScroll([a1, u2, a3]), disabled: true }), null, '生成中不显示');
  assert.equal(markLatestAssistantReply({ scrollEl: makeScroll([u2, node('assistant', 'has-rp-message-actions', 'message-pending')]) }), null);
  assert.equal(markLatestAssistantReply({ scrollEl: makeScroll([u2, node('assistant')]) }), null, '开场白等没有操作栏的不显示');
  console.log('ok - only the final assistant reply in the conversation is marked for quick delete');
}

{
  // app.js：快捷删除生成中不动；有多个版本只删当前版本，否则删整条（与长按删除走同一套回滚）
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  const start = app.indexOf("if (action === 'quick-delete'");
  assert.ok(start > 0, 'app.js 处理 quick-delete');
  const body = app.slice(start, app.indexOf("if (action === 'delete')", start));
  assert.match(body, /ui\.isSending/);
  assert.match(body, /canDeleteCurrentSwipe\(current\)[\s\S]*deleteCurrentSwipeFromMessage\(current\)/);
  assert.match(body, /deleteWholeMessage\(current\)/);
  assert.match(app, /\['regenerate', 'delete', 'quick-delete',/, '快捷删除前同样中止进行中的跳房子');
  console.log('ok - app quick delete removes only the current version when several exist');
}
