import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { bindBackdropActivation } from '../../src/scripts/ui/backdrop-activation-utils.js';

const createEventTarget = () => {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type, event = {}) {
      [...(listeners.get(type) || [])].forEach(handler => handler(event));
    },
    listenerCount(type) {
      return listeners.get(type)?.size || 0;
    },
  };
};

{
  const documentLike = createEventTarget();
  const backdrop = createEventTarget();
  const activations = [];
  bindBackdropActivation(backdrop, {
    documentLike,
    onActivate: event => activations.push(event),
  });

  documentLike.emit('pointerdown', { target: backdrop, pointerId: 1 });
  documentLike.emit('pointerup', { target: backdrop, pointerId: 1 });
  backdrop.emit('click', { target: backdrop });
  assert.equal(activations.length, 1);
  console.log('ok - genuine backdrop press-and-release activates');
}

{
  const documentLike = createEventTarget();
  const backdrop = createEventTarget();
  const child = { tag: 'input' };
  let activated = 0;
  bindBackdropActivation(backdrop, {
    documentLike,
    onActivate: () => { activated += 1; },
  });

  // 按在子元素（如输入框拖选文字），拖出后在遮罩上松手：click 会落在遮罩，但不得关闭
  documentLike.emit('pointerdown', { target: child, pointerId: 2 });
  documentLike.emit('pointerup', { target: backdrop, pointerId: 2 });
  backdrop.emit('click', { target: backdrop });
  assert.equal(activated, 0);

  // 按在遮罩、拖进面板松手：同样不得关闭
  documentLike.emit('pointerdown', { target: backdrop, pointerId: 3 });
  documentLike.emit('pointerup', { target: child, pointerId: 3 });
  backdrop.emit('click', { target: backdrop });
  assert.equal(activated, 0);

  // 状态复位后，真正的遮罩点击仍可关闭
  documentLike.emit('pointerdown', { target: backdrop, pointerId: 4 });
  documentLike.emit('pointerup', { target: backdrop, pointerId: 4 });
  backdrop.emit('click', { target: backdrop });
  assert.equal(activated, 1);
  console.log('ok - drag across the backdrop boundary in either direction never closes');
}

{
  const documentLike = createEventTarget();
  const backdrop = createEventTarget();
  let activated = 0;
  bindBackdropActivation(backdrop, {
    documentLike,
    onActivate: () => { activated += 1; },
  });

  documentLike.emit('pointerdown', { target: backdrop, pointerId: 5 });
  documentLike.emit('pointercancel', { pointerId: 5 });
  backdrop.emit('click', { target: backdrop });
  assert.equal(activated, 0);

  // 无指针轨迹的合成 click（如脚本触发）不激活
  backdrop.emit('click', { target: backdrop });
  assert.equal(activated, 0);
  console.log('ok - pointercancel and synthetic clicks do not activate');
}

{
  const documentLike = createEventTarget();
  const backdrop = createEventTarget();
  let activated = 0;
  const unbind = bindBackdropActivation(backdrop, {
    documentLike,
    onActivate: () => { activated += 1; },
  });
  assert.equal(documentLike.listenerCount('pointerdown'), 1);
  assert.equal(documentLike.listenerCount('pointerup'), 1);
  assert.equal(documentLike.listenerCount('pointercancel'), 1);
  assert.equal(backdrop.listenerCount('click'), 1);

  unbind();
  assert.equal(documentLike.listenerCount('pointerdown'), 0);
  assert.equal(documentLike.listenerCount('pointerup'), 0);
  assert.equal(documentLike.listenerCount('pointercancel'), 0);
  assert.equal(backdrop.listenerCount('click'), 0);

  documentLike.emit('pointerdown', { target: backdrop, pointerId: 6 });
  documentLike.emit('pointerup', { target: backdrop, pointerId: 6 });
  backdrop.emit('click', { target: backdrop });
  assert.equal(activated, 0);
  console.log('ok - unbind removes every listener and stops activation');
}

{
  assert.equal(typeof bindBackdropActivation(null, {}), 'function');
  assert.equal(typeof bindBackdropActivation({}, { documentLike: null }), 'function');
  console.log('ok - missing backdrop or document degrades to a noop unbind');
}

// --- 迁移契约：全部 UI 遮罩关闭都走 bindBackdropActivation ---
{
  const read = rel => readFile(new URL(`../../${rel}`, import.meta.url), 'utf8');
  const migratedFiles = [
    'src/scripts/ui/app.js',
    'src/scripts/ui/agent-center-panel.js',
    'src/scripts/ui/character-card-importer.js',
    'src/scripts/ui/config-panel.js',
    'src/scripts/ui/request-params-panel.js',
    'src/scripts/ui/persona-panel.js',
    'src/scripts/ui/script-panel.js',
    'src/scripts/ui/user-panel.js',
    'src/scripts/ui/variable-panel.js',
    'src/scripts/ui/variable-panel-runtime.js',
    'src/scripts/ui/world-editor.js',
    'src/scripts/ui/world-panel.js',
    'src/scripts/ui/chat/code-viewer-ui-utils.js',
  ];
  for (const rel of migratedFiles) {
    const source = await read(rel);
    assert.match(source, /bindBackdropActivation/, `${rel} 应使用 bindBackdropActivation`);
    assert.doesNotMatch(
      source,
      /target === (this\.)?overlay\b/,
      `${rel} 不应再保留旧的遮罩点击关闭写法`,
    );
  }

  // 一次性弹窗（close 时会 overlay.remove()）必须解绑 document 级监听
  for (const rel of [
    'src/scripts/ui/character-card-importer.js',
    'src/scripts/ui/script-panel.js',
    'src/scripts/ui/request-params-panel.js',
  ]) {
    const source = await read(rel);
    const unbindName = source.match(/const\s+(\w+)\s*=\s*bindBackdropActivation\(overlay,/)?.[1];
    assert.ok(unbindName, `${rel} 的一次性弹窗应保留 backdrop 解绑函数`);
    assert.match(
      source,
      new RegExp(`\\b${unbindName}\\(\\);[\\s\\S]{0,200}?overlay\\.remove\\(\\)`),
      `${rel} 的一次性弹窗关闭时必须先解绑 backdrop 监听`,
    );
  }
  console.log('ok - all overlay dismissal sites are migrated to bindBackdropActivation');
}
