import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import {
  buildReactionSummaryElement,
  createReactionPicker,
  createReactionQuickBar,
  createReactionQuickBarTouchRuntime,
  createReactionTriggerButton,
  hideReactionPicker,
  showReactionPicker,
  syncReactionQuickBarPlacement,
} from '../../src/scripts/ui/chat/reaction-ui-utils.js';
import {
  REACTION_EMOJI_CATEGORIES,
  filterReactionEmojiCatalog,
  getTwemojiAssetPath,
} from '../../src/scripts/ui/chat/reaction-emoji-catalog.js';
import {
  readReactionUsage,
  recordReactionUse,
  resolveQuickReactionEmojis,
} from '../../src/scripts/ui/chat/reaction-preference-utils.js';

const createClassList = (initial = []) => {
  const set = new Set(initial);
  return {
    add: (...tokens) => tokens.forEach(token => set.add(token)),
    remove: (...tokens) => tokens.forEach(token => set.delete(token)),
    contains: token => set.has(token),
    toggle: (token, force) => {
      const next = force == null ? !set.has(token) : Boolean(force);
      if (next) set.add(token);
      else set.delete(token);
      return next;
    },
  };
};

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.parentNode = null;
      this.className = '';
      this.classList = createClassList();
      this.style = { cssText: '', display: '', visibility: '', left: '', top: '' };
      this.textContent = '';
      this.type = '';
      this.id = '';
      this.dataset = {};
      this.attributes = {};
      this.listeners = new Map();
      this.offsetWidth = 240;
      this.offsetHeight = 48;
      this.value = '';
      let inner = '';
      Object.defineProperty(this, 'innerHTML', {
        get: () => inner,
        set: (value) => {
          inner = String(value || '');
          this.children = [];
        },
      });
    }
    appendChild(child) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    }
    replaceChildren(...children) {
      this.children = [];
      children.forEach(child => this.appendChild(child));
    }
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
    removeAttribute(name) {
      delete this.attributes[name];
    }
    closest(selector) {
      if (selector.includes('button') && this.tagName === 'button') return this;
      return null;
    }
    contains(target) {
      if (target === this) return true;
      return this.children.some(child => child === target || child.contains?.(target));
    }
    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }
  }

  const listeners = new Map();
  return {
    listeners,
    body: new FakeElement('body'),
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createElementNS(_namespace, tagName) {
      return new FakeElement(tagName);
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    getSelection() {
      return { toString: () => '' };
    },
  };
};

const createMemoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
};

{
  const storage = createMemoryStorage();
  recordReactionUse('🙏', { storage });
  recordReactionUse('🙏', { storage });
  recordReactionUse('😂', { storage });
  const usage = readReactionUsage({ storage });
  assert.deepEqual(usage, { '🙏': 2, '😂': 1 });
  assert.deepEqual(
    resolveQuickReactionEmojis({ usage, defaults: ['👍', '❤️', '😂'], limit: 3 }),
    ['🙏', '😂', '👍'],
  );
  console.log('ok - reaction preference storage ranks the three most-used reactions and fills defaults');
}

{
  assert.equal(getTwemojiAssetPath('❤️'), './assets/emoji/twemoji/2764.svg');
  assert.equal(getTwemojiAssetPath('👍'), './assets/emoji/twemoji/1f44d.svg');
  const matches = filterReactionEmojiCatalog('庆祝');
  assert.equal(matches.some(item => item.emoji === '🥳'), true);
  assert.equal(matches.some(item => item.emoji === '🎉'), true);
  assert.equal(filterReactionEmojiCatalog('smile').some(item => item.emoji === '😊'), true);
  assert.equal(filterReactionEmojiCatalog('THUMBS UP').some(item => item.emoji === '👍'), true);
  assert.equal(filterReactionEmojiCatalog('heart').some(item => item.emoji === '❤️'), true);
  assert.equal(filterReactionEmojiCatalog('party').some(item => item.emoji === '🎉'), true);
  assert.equal(REACTION_EMOJI_CATEGORIES.length >= 5, true);
  assert.equal(
    REACTION_EMOJI_CATEGORIES
      .flatMap(category => category.emojis)
      .every(item => /[a-z]/i.test(item.englishKeywords || '')),
    true,
    'every reaction emoji should expose an English search name',
  );
  REACTION_EMOJI_CATEGORIES.flatMap(category => [category.icon, ...category.emojis.map(item => item.emoji)])
    .forEach((emoji) => {
      const filename = getTwemojiAssetPath(emoji).split('/').at(-1);
      assert.equal(
        existsSync(new URL(`../../src/assets/emoji/twemoji/${filename}`, import.meta.url)),
        true,
        `missing Twemoji asset for ${emoji}`,
      );
    });
  assert.equal(
    existsSync(new URL('../../src/assets/emoji/twemoji/LICENSE-GRAPHICS', import.meta.url)),
    true,
  );
  console.log('ok - reaction catalog exposes searchable categorized Twemoji assets');
}

{
  const documentLike = createFakeDocument();
  const toggles = [];
  const message = {
    meta: {
      reactions: [
        { emoji: '👍', actors: ['__self__', 'u1'] },
        { emoji: '😂', actors: ['u2'] },
      ],
    },
  };
  const el = buildReactionSummaryElement(message, {
    documentLike,
    isThreadingEnabled: true,
    onToggleReaction: emoji => toggles.push(emoji),
  });
  assert.equal(el.className, 'chat-reaction-summary');
  assert.equal(el.children.length, 2);
  assert.equal(el.children[0].classList.contains('is-self'), true);
  el.children[0].emit('click', { preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(toggles, ['👍']);
  console.log('ok - buildReactionSummaryElement renders chips and forwards reaction toggles');
}

{
  const documentLike = createFakeDocument();
  const picker = createReactionPicker({
    documentLike,
    onOutsidePress: () => {
      picker.style.display = 'none';
    },
  });
  picker.style.display = 'flex';
  documentLike.listeners.get('pointerdown')({ target: documentLike.createElement('div') });
  assert.equal(picker.style.display, 'none');
  console.log('ok - createReactionPicker wires outside press dismissal');
}

{
  const documentLike = createFakeDocument();
  const calls = [];
  const trigger = createReactionTriggerButton({ id: 'm1' }, {
    documentLike,
    isThreadingEnabled: true,
    onShowPicker: (button, message) => calls.push([button.className, message.id]),
  });
  trigger.emit('click', { preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(calls, [['chat-reaction-trigger', 'm1']]);
  console.log('ok - createReactionTriggerButton forwards click into picker opener');
}

{
  const documentLike = createFakeDocument();
  const calls = [];
  const message = {
    id: 'm-quick',
    meta: { reactions: [{ emoji: '❤️', actors: ['__self__'] }] },
  };
  const bar = createReactionQuickBar(message, {
    documentLike,
    isThreadingEnabled: true,
    emojis: ['❤️', '👍', '😂'],
    onToggleReaction: emoji => calls.push(['toggle', emoji]),
    onShowPicker: (button, nextMessage) => calls.push(['picker', button.className, nextMessage.id]),
  });
  assert.equal(bar.className, 'chat-reaction-quick-bar');
  assert.equal(bar.children.length, 4);
  assert.equal(bar.children[0].classList.contains('is-active'), true);
  assert.equal(bar.children[0].children[0].children[0].tagName, 'img');
  assert.equal(bar.children[0].children[0].children[0].src.endsWith('/2764.svg'), true);
  assert.equal(bar.children[3].className.includes('chat-reaction-more'), true);
  assert.equal(bar.children[3].children[0].tagName, 'svg');
  bar.children[1].emit('click', { preventDefault() {}, stopPropagation() {} });
  bar.children[3].emit('click', { preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(calls, [
    ['toggle', '👍'],
    ['picker', 'chat-reaction-quick-button chat-reaction-more', 'm-quick'],
  ]);
  console.log('ok - createReactionQuickBar renders three ranked Twemoji reactions plus the more button');
}

{
  const documentLike = createFakeDocument();
  const translations = new Map([
    ['👍 2个反应', '👍 · 2 reactions'],
    ['添加反应', 'Add reaction'],
    ['快捷表情反应', 'Quick emoji reactions'],
    ['使用👍回应', 'React with 👍'],
    ['选择更多表情反应', 'Choose more emoji reactions'],
  ]);
  const translateText = value => translations.get(String(value ?? '')) || String(value ?? '');
  const message = { meta: { reactions: [{ emoji: '👍', actors: ['__self__', 'u1'] }] } };
  const summary = buildReactionSummaryElement(message, {
    documentLike,
    isThreadingEnabled: true,
    translateText,
  });
  assert.equal(summary.children[0].attributes['aria-label'], '👍 · 2 reactions');
  const trigger = createReactionTriggerButton(message, {
    documentLike,
    isThreadingEnabled: true,
    translateText,
  });
  assert.equal(trigger.attributes['aria-label'], 'Add reaction');
  const bar = createReactionQuickBar(message, {
    documentLike,
    isThreadingEnabled: true,
    emojis: ['👍'],
    translateText,
  });
  assert.equal(bar.attributes['aria-label'], 'Quick emoji reactions');
  assert.equal(bar.children[0].attributes['aria-label'], 'React with 👍');
  assert.equal(bar.children[1].attributes['aria-label'], 'Choose more emoji reactions');
  console.log('ok - reaction controls inside skipped message DOM localize their built-in labels');
}

{
  const stack = {
    classList: createClassList(),
    getBoundingClientRect: () => ({ top: 18, bottom: 90 }),
  };
  const scrollBoundary = {
    getBoundingClientRect: () => ({ top: 10, bottom: 620 }),
  };
  assert.equal(syncReactionQuickBarPlacement({ bubbleStack: stack, scrollBoundary }), 'below');
  assert.equal(stack.classList.contains('is-reaction-bar-below'), true);
  stack.getBoundingClientRect = () => ({ top: 80, bottom: 150 });
  assert.equal(syncReactionQuickBarPlacement({ bubbleStack: stack, scrollBoundary }), 'above');
  assert.equal(stack.classList.contains('is-reaction-bar-below'), false);
  console.log('ok - reaction quick bar moves below only when the scrollport clips its upper placement');
}

{
  const documentLike = createFakeDocument();
  const runtime = createReactionQuickBarTouchRuntime({ documentLike });
  const bubbleStack = documentLike.createElement('div');
  const bubble = documentLike.createElement('div');
  const bar = documentLike.createElement('div');
  bubbleStack.appendChild(bubble);
  bubbleStack.appendChild(bar);
  runtime.bind({ bubbleStack, bubble, quickBar: bar });
  bubble.emit('pointerdown', { pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 30, target: bubble });
  bubble.emit('pointerup', { pointerType: 'touch', pointerId: 1, clientX: 20, clientY: 30, target: bubble });
  assert.equal(bubbleStack.classList.contains('is-reaction-bar-open'), true);
  documentLike.listeners.get('pointerdown')({ target: documentLike.createElement('div') });
  assert.equal(bubbleStack.classList.contains('is-reaction-bar-open'), false);
  bubble.emit('pointerdown', { pointerType: 'touch', pointerId: 2, clientX: 20, clientY: 30, target: bubble });
  bubble.emit('pointermove', { pointerType: 'touch', pointerId: 2, clientX: 20, clientY: 60, target: bubble });
  bubble.emit('pointerup', { pointerType: 'touch', pointerId: 2, clientX: 20, clientY: 60, target: bubble });
  assert.equal(bubbleStack.classList.contains('is-reaction-bar-open'), false);
  bubble.emit('pointerdown', {
    pointerType: 'touch', pointerId: 3, clientX: 20, clientY: 30, timeStamp: 1000, target: bubble,
  });
  bubble.emit('pointerup', {
    pointerType: 'touch', pointerId: 3, clientX: 20, clientY: 30, timeStamp: 1600, target: bubble,
  });
  assert.equal(bubbleStack.classList.contains('is-reaction-bar-open'), false);
  runtime.destroy();
  assert.equal(documentLike.listeners.has('pointerdown'), false);
  console.log('ok - touch runtime opens a quick bar on bubble tap and dismisses it outside');
}

{
  const documentLike = createFakeDocument();
  const picker = documentLike.createElement('div');
  picker.offsetWidth = 240;
  picker.offsetHeight = 48;
  const contextMenuEl = { style: { display: 'block' } };
  const toggles = [];
  const anchor = {
    getBoundingClientRect() {
      return { left: 100, top: 60, bottom: 90, width: 30 };
    },
  };
  const message = {
    meta: {
      reactions: [{ emoji: '👍', actors: ['__self__'] }],
    },
  };
  const shown = showReactionPicker({
    picker,
    contextMenuEl,
    anchor,
    message,
    isThreadingEnabled: true,
    onToggleReaction: emoji => toggles.push(emoji),
    hidePicker: () => hideReactionPicker(picker),
    windowLike: { innerWidth: 360, innerHeight: 640 },
    documentLike,
    usage: { '😂': 4, '👍': 2 },
  });
  assert.equal(shown, true);
  assert.equal(contextMenuEl.style.display, 'none');
  assert.equal(picker.dataset.activeCategory, 'frequent');
  assert.equal(picker.children.length, 5);
  const [header, search, tabs, content] = picker.children;
  assert.equal(header.className, 'chat-reaction-picker-header');
  assert.equal(search.className, 'chat-reaction-picker-search');
  assert.equal(tabs.className, 'chat-reaction-picker-tabs');
  assert.equal(content.className, 'chat-reaction-picker-content');
  assert.equal(content.children[0].dataset.emoji, '😂');
  assert.equal(content.children[1].dataset.emoji, '👍');
  assert.equal(content.children[1].classList.contains('is-active'), true);
  assert.equal(picker.dataset.mobile, '1');
  search.value = '庆祝';
  search.emit('input');
  assert.equal(content.children.some(option => option.dataset.emoji === '🥳'), true);
  assert.equal(content.children.some(option => option.dataset.emoji === '🎉'), true);
  tabs.children[0].emit('click', { preventDefault() {} });
  assert.equal(search.value, '');
  assert.equal(content.children[0].dataset.emoji, '😂');
  content.children[1].emit('click', { preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(toggles, ['👍']);
  assert.equal(picker.style.display, 'none');
  assert.equal(Number.parseFloat(picker.style.left) >= 8, true);
  console.log('ok - showReactionPicker builds frequent/category/search UI, positions it and toggles reactions');
}

{
  const style = readFileSync(new URL('../../src/assets/css/qq-legacy.css', import.meta.url), 'utf8');
  const userAnchorRule = style.match(/\.chat-bubble-stack\.is-user\s*>\s*\.chat-reaction-quick-bar\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(userAnchorRule, /left:\s*auto/);
  assert.match(userAnchorRule, /right:\s*0/);
  const quickBarRule = style.match(/\.chat-reaction-quick-bar\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(quickBarRule, /padding:\s*0/);
  assert.match(quickBarRule, /border:\s*0/);
  assert.match(quickBarRule, /background:\s*transparent/);
  assert.match(quickBarRule, /box-shadow:\s*none/);
  assert.match(
    style,
    /\.chat-reaction-quick-bar::after\s*\{[^}]*content:\s*['"]['"][^}]*bottom:\s*-8px[^}]*height:\s*8px/s,
  );
  assert.match(style, /\.chat-message-footer\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(style, /\.chat-message-footer\s*>\s*\.chat-time-row\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(style, /\.chat-bubble-stack\.is-reaction-bar-open\s*>\s*\.chat-reaction-quick-bar/);
  assert.match(
    style,
    /\.chat-bubble-stack\.is-reaction-bar-below\s*>\s*\.chat-reaction-quick-bar\s*\{[^}]*top:\s*calc\(100% \+ 4px\)[^}]*transform-origin:\s*top right/s,
  );
  assert.match(
    style,
    /\.chat-bubble-stack\.is-reaction-bar-below\s*>\s*\.chat-reaction-quick-bar::after\s*\{[^}]*top:\s*-8px[^}]*bottom:\s*auto/s,
  );
  assert.match(style, /\.chat-reaction-picker-content\s*\{[^}]*grid-template-columns:\s*repeat\(8,/s);
  console.log('ok - reaction styles preserve viewport-safe user anchoring and categorized picker grid');
}
