import assert from 'node:assert/strict';

import {
  dispatchContextMenuAction,
  resolveContextMenuCopyText,
} from '../../src/scripts/ui/chat/context-menu-action-runtime-utils.js';

{
  const calls = [], inlineGeneratedImage = { id: 'selected-image' }, wrapper = {};
  const result = await dispatchContextMenuAction({ actionKey: 'repeat-image-generation', wrapper, inlineGeneratedImage,
    hideMenu: () => calls.push('hide'), clearLongPress: () => calls.push('clear'),
    tryAction: async (...args) => calls.push(args),
  });
  assert.equal(result, 'repeat-image-generation');
  assert.deepEqual(calls, ['hide', 'clear', ['repeat-image-generation', { wrapper, inlineGeneratedImage }, { skipFallback: true }]]);
}

{
  const text = resolveContextMenuCopyText(
    {
      content: '',
      rawSource: 'raw-source',
      meta: { renderRich: true },
    },
    {
      wrapper: {},
      getBubbleCopyText: () => '',
    },
  );
  assert.equal(text, 'raw-source');
  console.log('ok - resolveContextMenuCopyText falls back from rich bubble copy to raw source');
}

{
  const calls = [];
  const result = await dispatchContextMenuAction({
    actionKey: 'check-format',
    message: { id: 'm-format', role: 'assistant', content: 'raw' },
    wrapper: { id: 'wrapper' },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    tryAction: async (key, payload, options) => {
      calls.push(['try', key, payload, options]);
      return true;
    },
  });
  assert.equal(result, 'check-format');
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try', 'check-format', undefined, { skipFallback: true }],
  ]);
  console.log('ok - dispatchContextMenuAction routes manual format check through app action');
}

{
  const wrapper = { id: 'speech-wrapper' };
  const calls = [];
  const result = await dispatchContextMenuAction({
    actionKey: 'speak',
    message: { id: 'm-speech', role: 'assistant', content: 'hello' },
    wrapper,
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    tryAction: async (key, payload, options) => {
      calls.push(['try', key, payload, options]);
      return true;
    },
  });
  assert.equal(result, 'speak');
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try', 'speak', { wrapper }, { skipFallback: true }],
  ]);
  console.log('ok - long-press speech forwards its message wrapper for visible playback state');
}

{
  const calls = [];
  const result = await dispatchContextMenuAction({
    actionKey: 'view-code',
    message: { id: 'm1', role: 'assistant', content: 'content', raw: 'raw' },
    wrapper: { id: 'wrapper' },
    codeBlock: { id: 'code' },
    hasCode: true,
    tryAction: async (key, payload) => {
      calls.push(['try', key, payload]);
      return false;
    },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    openCodeViewer: payload => calls.push(['open', payload.text]),
  });
  assert.equal(result, 'view-code');
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try', 'view-code', { wrapper: { id: 'wrapper' }, codeBlock: { id: 'code' } }],
    ['open', 'raw'],
  ]);
  console.log('ok - dispatchContextMenuAction opens code viewer when view-code is not intercepted');
}

{
  const calls = [];
  const result = await dispatchContextMenuAction({
    actionKey: 'view-code',
    message: { id: 'm-rich', role: 'assistant', content: 'rendered', rawSource: 'raw-rich', meta: { renderRich: true } },
    wrapper: { id: 'wrapper' },
    hasCode: false,
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    tryAction: async (key, payload) => {
      calls.push(['try', key, payload]);
      return false;
    },
    openCodeViewer: payload => calls.push(['open', payload.text]),
  });
  assert.equal(result, 'view-code');
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try', 'view-code', { wrapper: { id: 'wrapper' }, codeBlock: null }],
    ['open', 'raw-rich'],
  ]);
  console.log('ok - dispatchContextMenuAction opens raw viewer for rich assistant messages without code blocks');
}

{
  const calls = [];
  const result = await dispatchContextMenuAction({
    actionKey: 'copy-text',
    message: { content: '', rawOriginal: 'raw-original', meta: { renderRich: true } },
    wrapper: { id: 'wrapper' },
    codeBlock: { id: 'code' },
    tryAction: async (key, payload) => {
      calls.push(['try', key, payload]);
      return false;
    },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    getBubbleCopyText: () => '',
    copyToClipboard: async text => {
      calls.push(['copy', text]);
      return true;
    },
    showCopyToast: ok => calls.push(['toast', ok]),
  });
  assert.equal(result, 'copied');
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try', 'copy-text', { wrapper: { id: 'wrapper' }, codeBlock: { id: 'code' } }],
    ['copy', 'raw-original'],
    ['toast', true],
  ]);
  console.log('ok - dispatchContextMenuAction copies resolved text and reports toast state');
}

{
  const calls = [];
  await dispatchContextMenuAction({
    actionKey: 'delete',
    message: {
      id: 'm-swipe',
      role: 'assistant',
      meta: {
        activeSwipe: 0,
        swipes: [
          { content: 'one' },
          { content: 'two' },
        ],
      },
    },
    wrapper: { id: 'wrapper' },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    tryAction: async (key, payload, options) => {
      calls.push(['try-delete', key, payload, options]);
      return true;
    },
    enterSelectionMode: id => calls.push(['delete', id]),
  });
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try-delete', 'delete', { wrapper: { id: 'wrapper' }, deleteScope: 'choose-swipe-or-message' }, { skipFallback: true }],
  ]);
  console.log('ok - dispatchContextMenuAction lets app choose current swipe or whole assistant delete for multi-swipe messages');
}

{
  const calls = [];
  const inlineGeneratedImage = { token: '[img-D:\\\\assets\\\\cat.png]' };
  const result = await dispatchContextMenuAction({
    actionKey: 'generate-image',
    message: { id: 'm-image', role: 'assistant' },
    wrapper: { id: 'wrapper' },
    inlineGeneratedImage,
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    tryAction: async (key, payload, options) => {
      calls.push(['try', key, payload, options]);
      return true;
    },
  });
  assert.equal(result, 'generate-image');
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try', 'generate-image', { wrapper: { id: 'wrapper' }, inlineGeneratedImage }, { skipFallback: true }],
  ]);
  console.log('ok - dispatchContextMenuAction forwards inline generated image context to image generation');
}

{
  const calls = [];
  await dispatchContextMenuAction({
    actionKey: 'reply',
    message: { id: 'm2' },
    wrapper: { id: 'wrapper' },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    tryAction: async (key, payload, options) => {
      calls.push(['try', key, payload, options]);
      return false;
    },
  });
  await dispatchContextMenuAction({
    actionKey: 'edit',
    message: { id: 'm2' },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    startInlineEdit: message => calls.push(['edit', message.id]),
  });
  await dispatchContextMenuAction({
    actionKey: 'delete',
    message: { id: 'm3', role: 'assistant' },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    enterSelectionMode: id => calls.push(['delete', id]),
  });
  await dispatchContextMenuAction({
    actionKey: 'download',
    message: { id: 'm4' },
    hideMenu: () => calls.push(['hide']),
    clearLongPress: () => calls.push(['clear']),
    tryAction: async (key, payload, options) => {
      calls.push(['default', key, payload, options]);
      return false;
    },
  });
  assert.deepEqual(calls, [
    ['hide'],
    ['clear'],
    ['try', 'reply', { wrapper: { id: 'wrapper' } }, { skipFallback: true }],
    ['hide'],
    ['clear'],
    ['edit', 'm2'],
    ['hide'],
    ['clear'],
    ['delete', 'm3'],
    ['hide'],
    ['clear'],
    ['default', 'download', undefined, { skipFallback: true }],
  ]);
  console.log('ok - dispatchContextMenuAction preserves reply edit delete and default action routing');
}
