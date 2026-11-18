import assert from 'node:assert/strict';

import {
  buildMessageTranslationElement,
  buildMessageTranslationSignature,
  createMessageTranslation,
  getMessageTranslation,
  messageTranslationKey,
} from '../../src/scripts/ui/chat/message-translation-ui-utils.js';
import { buildContextMenuActions } from '../../src/scripts/ui/chat/context-menu-ui-utils.js';
import { createMessagePatchUiRuntime } from '../../src/scripts/ui/chat/message-patch-ui-utils.js';

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.className = '';
      this.textContent = '';
      this.children = [];
      this.dataset = {};
      this.style = { cssText: '' };
      this.listeners = {};
    }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
  }
  return { createElement: tagName => new FakeElement(tagName) };
};

const message = { id: 'm1', role: 'assistant', type: 'text', content: 'Hello there.\nHow are you?', meta: {} };
const translation = createMessageTranslation({ message, text: '你好。\n你好吗？', language: { id: 'zh-CN', label: '简体中文' }, now: 1 });
const translated = { ...message, meta: { stewardTranslation: translation } };

{
  assert.equal(translation.sourceKey, messageTranslationKey(message));
  assert.notEqual(messageTranslationKey(message), messageTranslationKey({ content: 'Hello there.' }));
  assert.equal(getMessageTranslation(translated).text, '你好。\n你好吗？');
  // 切换分支、编辑或重新生成后内容不同：不显示旧译文
  assert.equal(getMessageTranslation({ ...translated, content: 'Another reply' }), null);
  assert.equal(buildMessageTranslationSignature({ ...translated, content: 'Another reply' }), '');
  assert.notEqual(buildMessageTranslationSignature(translated), '');
  assert.equal(getMessageTranslation({ ...message, meta: { stewardTranslation: { ...translation, text: '  ' } } }), null);
  console.log('ok - translations are shown only for the content they were made from');
}

{
  const removed = [];
  const element = buildMessageTranslationElement({ documentLike: createFakeDocument(), message: translated, onRemove: value => removed.push(value.id) });
  assert.equal(element.className, 'chat-message-translation');
  assert.equal(element.open, true);
  const [summary, body] = element.children;
  assert.equal(summary.children[0].textContent, '译文 · 简体中文');
  assert.equal(body.textContent, '你好。\n你好吗？');
  assert.equal(body.dataset.i18nSkip, 'true', 'the translated text is not run through UI translation');
  const event = { preventDefault() {}, stopPropagation() {} };
  summary.children[1].listeners.click(event);
  assert.deepEqual(removed, ['m1']);
  assert.equal(buildMessageTranslationElement({ documentLike: createFakeDocument(), message }), null);
  console.log('ok - the translation sidecar shows the language, the text and a remove button');
}

{
  const keys = (msg, options) => buildContextMenuActions(msg, options).map(action => `${action.key}:${action.label}`);
  assert.ok(keys(message, { canTranslate: true }).includes('steward-translate:翻译'));
  assert.ok(keys(translated, { canTranslate: true }).includes('steward-translate:重新翻译'));
  assert.equal(keys(message, {}).some(key => key.startsWith('steward-translate')), false, 'hidden unless the app says it can translate');
  assert.equal(keys({ ...message, status: 'sending' }, { canTranslate: true }).some(key => key.startsWith('steward-translate')), false);
  assert.ok(keys({ id: 'u', role: 'user', type: 'text', content: '你好' }, { canTranslate: true }).includes('steward-translate:翻译'));
  console.log('ok - the bubble menu offers translate or re-translate when available');
}

{
  const patch = createMessagePatchUiRuntime({ resolveActiveSwipeMessage: value => value });
  assert.notEqual(patch.getMessageRenderSignature(message), patch.getMessageRenderSignature(translated),
    'adding or removing a translation re-renders the bubble');
  console.log('ok - translations take part in the message render signature');
}
