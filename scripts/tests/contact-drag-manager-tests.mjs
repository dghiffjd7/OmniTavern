import assert from 'node:assert/strict';

// 触屏设备：走原生 dragstart（不用指针拖动）
globalThis.window = globalThis.window || { ontouchstart: null };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { ContactDragManager } = await import('../../src/scripts/ui/contact-drag-manager.js');

{
  // 手机上拖动选中的文字：dragstart 的 target 是文字节点（没有 closest），不是拖联系人，忽略且不报错
  const manager = new ContactDragManager({});
  assert.equal(manager.usePointerDrag, false);
  assert.doesNotThrow(() => manager.handleDragStart({ target: { nodeType: 3, textContent: '测' } }));
  assert.equal(manager.draggedContactId, null);

  // 拖联系人卡照常开始
  const contact = {
    getAttribute: name => (name === 'data-contact-id' ? 'c1' : null),
    closest: selector => (selector === '.contact-item' ? contact : null),
    classList: { add() {}, remove() {} },
  };
  const data = {};
  manager.handleDragStart({ target: contact, dataTransfer: { setData: (type, value) => { data[type] = value; } } });
  assert.equal(manager.draggedContactId, 'c1');
  assert.equal(data['text/plain'], 'c1');
  console.log('ok - dragging selected text does not start a contact drag or throw');
}

console.log('contact-drag-manager-tests passed');
