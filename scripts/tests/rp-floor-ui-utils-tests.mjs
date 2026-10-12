import assert from 'node:assert/strict';

import { createRpFloorUiRuntime } from '../../src/scripts/ui/chat/rp-floor-ui-utils.js';

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.className = '';
      this.dataset = {};
      this.textContent = '';
      this.children = [];
      this.parentNode = null;
      this.removed = false;
    }
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    remove() {
      this.removed = true;
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
  let floorCount = 4;
  const runtime = createRpFloorUiRuntime({
    documentLike,
    getUiMode: () => 'rp',
    getRpFloorLabel: floor => `第 ${floor} 轮`,
    buildRpFloorAssignments: () => [],
  });
  const greeting = { role: 'assistant', meta: { isGreeting: true } };
  const greetingMarker = runtime.createFloorMarker(greeting, {
    getFloorCount: () => floorCount,
    setFloorCount: value => {
      floorCount = value;
    },
  });
  assert.equal(greeting.meta.floor, 0);
  assert.equal(floorCount, 0);
  assert.equal(greetingMarker.dataset.floor, '0');
  assert.equal(greetingMarker.children[0].textContent, '第 0 轮');

  const userMessage = { role: 'user', meta: {} };
  const userMarker = runtime.createFloorMarker(userMessage, {
    getFloorCount: () => floorCount,
    setFloorCount: value => {
      floorCount = value;
    },
  });
  assert.equal(userMessage.meta.floor, 1);
  assert.equal(floorCount, 1);
  assert.equal(userMarker.dataset.floor, '1');

  const assistantMessage = { role: 'assistant', meta: {} };
  assert.equal(runtime.createFloorMarker(assistantMessage, {
    getFloorCount: () => floorCount,
    setFloorCount: value => {
      floorCount = value;
    },
  }), null);
  assert.equal(assistantMessage.meta.floor, 1);
  console.log('ok - createFloorMarker resets greeting floor increments user floor and reuses current assistant floor');
}

{
  const documentLike = createFakeDocument();
  let floorCount = -1;
  const inserted = [];
  const oldMarker = { remove() { this.removed = true; }, removed: false };
  const parentNode = {
    insertBefore(node, reference) {
      inserted.push([node, reference]);
      node.parentNode = this;
    },
  };
  const wrappers = [
    { __chatappMessage: { role: 'user', meta: {} }, dataset: {}, parentNode },
    { __chatappMessage: { role: 'assistant', meta: {} }, dataset: {}, parentNode },
  ];
  const scrollEl = {
    querySelectorAll(selector) {
      if (selector === '.rp-floor-marker') return [oldMarker];
      if (selector === '.QQ_chat_mymsg, .QQ_chat_charmsg') return wrappers;
      return [];
    },
  };
  const runtime = createRpFloorUiRuntime({
    documentLike,
    getUiMode: () => 'rp',
    getRpFloorLabel: floor => `楼层 ${floor}`,
    buildRpFloorAssignments: () => [
      { floor: 0, marker: true },
      { floor: 1, marker: false },
    ],
  });
  runtime.refreshAllFloorMarkers(scrollEl, {
    setFloorCount: value => {
      floorCount = value;
    },
  });
  assert.equal(oldMarker.removed, true);
  assert.equal(wrappers[0].dataset.rpFloor, '0');
  assert.equal(wrappers[1].dataset.rpFloor, '1');
  assert.equal(wrappers[0].__chatappMessage.meta.floor, 0);
  assert.equal(wrappers[1].__chatappMessage.meta.floor, 1);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0].children[0].textContent, '楼层 0');
  assert.equal(floorCount, 1);
  console.log('ok - refreshAllFloorMarkers removes stale markers reapplies assignments and updates latest floor count');
}

{
  // 楼层按整个存档计算：已加载范围之前已有 40 楼；画面中间折叠了一段也不影响后面的编号
  const { resolveAbsoluteRpFloorAssignments, buildRpFloorAssignments: build } = await import('../../src/scripts/ui/chat/message-interaction-utils.js');
  assert.deepEqual(build([{ role: 'assistant' }, { role: 'user' }], { initialFloor: 40 }).map(a => a.floor), [40, 41]);
  const loaded = [
    { id: 'a0', role: 'assistant' },
    { id: 'u1', role: 'user' }, { id: 'a1', role: 'assistant' },
    { id: 'u2', role: 'user' }, { id: 'a2', role: 'assistant' },
    { id: 'u3', role: 'user' }, { id: 'a3', role: 'assistant' },
  ];
  const wrappers = [loaded[1], loaded[2], loaded[5], loaded[6], { id: 'streaming', role: 'assistant' }];
  const result = resolveAbsoluteRpFloorAssignments({ wrapperMessages: wrappers, loadedMessages: loaded, initialFloor: 40 });
  assert.deepEqual(result.map(a => `${a.floor}${a.marker ? '*' : ''}`), ['41*', '41', '43*', '43', '43']);
  console.log('ok - rp floors follow the whole archive across collapsed history');
}
