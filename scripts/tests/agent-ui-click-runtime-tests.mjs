import assert from 'node:assert/strict';

import { createAgentUiClickRuntime } from '../../src/scripts/ui/agent-ui-click-runtime.js';

const listeners = new Map();
let hitTarget = null;
const documentRef = {
  activeElement: null,
  documentElement: {
    contains: node => node.connected !== false,
  },
  elementFromPoint: () => hitTarget,
  addEventListener(type, handler) {
    listeners.set(type, handler);
  },
  removeEventListener(type, handler) {
    if (listeners.get(type) === handler) listeners.delete(type);
  },
};

const makeButton = (label) => ({
  innerText: label,
  textContent: label,
  disabled: false,
  visible: true,
  connected: true,
  clickCount: 0,
  classList: { contains: () => false },
  getAttribute: () => null,
  contains(node) { return node === this; },
  getBoundingClientRect: () => ({ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 }),
  click() {
    this.clickCount += 1;
  },
});

const button = makeButton('打开预览');
hitTarget = button;
const panel = {
  innerText: '设置面板',
  textContent: '设置面板',
  hidden: false,
  style: {},
  classList: { contains: () => false },
  getBoundingClientRect: () => ({ width: 300, height: 400 }),
  querySelectorAll(selector) {
    if (selector === 'button, [role="button"]') return [button];
    return [];
  },
  contains: node => node === button,
};

const runtime = createAgentUiClickRuntime({
  documentRef,
  getPanels: () => [{ id: 'settings', title: '设置', element: panel }],
  getState: () => ({ activePage: 'settings', uiMode: 'chat', sessionId: 's1' }),
  isElementVisible: element => element?.visible !== false,
  settleMs: 0,
});

{
  const first = runtime.buildVisiblePanelSummary({});
  const firstRef = first.panels[0].buttons[0].ref;
  const second = runtime.buildVisiblePanelSummary({});
  const secondRef = second.panels[0].buttons[0].ref;
  assert.notEqual(firstRef, secondRef);
  assert.match(firstRef, /:r1:/);
  assert.match(secondRef, /:r2:/);
  const stale = await runtime.clickElement({ ref: firstRef });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'ref_not_found');
  assert.equal(button.clickCount, 0);
  console.log('ok - inspect revisions prevent a reused ref from resolving to a newer DOM target');
}

{
  const summary = runtime.buildVisiblePanelSummary({});
  const ref = summary.panels[0].buttons[0].ref;
  button.innerText = '执行其他操作';
  button.textContent = '执行其他操作';
  const changed = await runtime.clickElement({ ref });
  assert.equal(changed.ok, false);
  assert.equal(changed.reason, 'element_changed_since_inspect');
  assert.equal(button.clickCount, 0);
  button.innerText = '打开预览';
  button.textContent = '打开预览';
  console.log('ok - click rejects a button whose meaning changed after inspect');
}

{
  const summary = runtime.buildVisiblePanelSummary({});
  const ref = summary.panels[0].buttons[0].ref;
  button.visible = false;
  const hidden = await runtime.clickElement({ ref });
  assert.equal(hidden.ok, false);
  assert.equal(hidden.reason, 'element_not_visible');
  assert.equal(button.clickCount, 0);
  button.visible = true;
  console.log('ok - click rechecks target visibility');
}

{
  const summary = runtime.buildVisiblePanelSummary({});
  const ref = summary.panels[0].buttons[0].ref;
  hitTarget = { className: 'modal-overlay' };
  const occluded = await runtime.clickElement({ ref });
  assert.equal(occluded.ok, false);
  assert.equal(occluded.reason, 'element_occluded');
  assert.equal(button.clickCount, 0);
  hitTarget = button;
  console.log('ok - click rejects a visible target covered by another element');
}

{
  const summary = runtime.buildVisiblePanelSummary({});
  const ref = summary.panels[0].buttons[0].ref;
  listeners.get('pointerdown')?.({ type: 'pointerdown' });
  const competed = await runtime.clickElement({ ref });
  assert.equal(competed.ok, false);
  assert.equal(competed.reason, 'user_interaction_since_inspect');
  assert.equal(button.clickCount, 0);
  console.log('ok - click pauses when the user interacts after inspect');
}

{
  const summary = runtime.buildVisiblePanelSummary({});
  const ref = summary.panels[0].buttons[0].ref;
  const confirmationButton = {
    closest: selector => selector.includes('.app-confirm-modal') ? {} : null,
  };
  listeners.get('pointerdown')?.({
    type: 'pointerdown',
    target: confirmationButton,
    composedPath: () => [confirmationButton],
  });
  const blocked = await runtime.clickElement({ ref });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'user_interaction_since_inspect');
  assert.equal(button.clickCount, 0);
  console.log('ok - an unrelated app confirmation still invalidates the inspected target');
}

{
  const summary = runtime.buildVisiblePanelSummary({});
  const ref = summary.panels[0].buttons[0].ref;
  const confirmationButton = {
    closest: selector => selector.includes('.app-confirm-modal') ? {} : null,
  };
  const endConfirmation = runtime.beginConfirmation();
  listeners.get('pointerdown')?.({
    type: 'pointerdown',
    target: confirmationButton,
    composedPath: () => [confirmationButton],
  });
  listeners.get('keydown')?.({
    type: 'keydown',
    key: 'Enter',
    target: confirmationButton,
    composedPath: () => [confirmationButton],
  });
  // 运行卡内的确认（输入胶囊／执行流／语音托盘）同样是这次调用自己的确认（11/20 起每次点击都确认）
  const inlineApprovalButton = {
    closest: selector => selector.split(',').map(item => item.trim()).includes('.mrc-approval') ? {} : null,
  };
  listeners.get('pointerdown')?.({
    type: 'pointerdown',
    target: inlineApprovalButton,
    composedPath: () => [inlineApprovalButton],
  });
  endConfirmation();
  const clicked = await runtime.clickElement({ ref });
  assert.equal(clicked.ok, true);
  assert.equal(button.clickCount, 1);
  console.log('ok - an app or inline run-card confirmation choice does not invalidate the inspected target');
}

{
  const summary = runtime.buildVisiblePanelSummary({});
  const ref = summary.panels[0].buttons[0].ref;
  const clicked = await runtime.clickElement({ ref });
  assert.equal(clicked.ok, true);
  assert.equal(clicked.clicked, '打开预览');
  assert.equal(button.clickCount, 2);
  assert.equal(clicked.after.inspectRevision, summary.inspectRevision + 1);
  console.log('ok - a fresh unchanged visible ref clicks and returns a new inspect revision');
}

runtime.dispose();
assert.equal(listeners.size, 0);

console.log('agent-ui-click-runtime-tests passed');
