import assert from 'node:assert/strict';

import { renderMessageBubbleContentCore } from '../../src/scripts/ui/chat/message-bubble-content-ui-utils.js';
import { finishMessageDomCore } from '../../src/scripts/ui/chat/assistant-stream-ui-utils.js';
import { buildHistoryRenderMessage } from '../../src/scripts/ui/chat/message-list-ui-utils.js';
import { normalizeCheckpointSwipeState } from '../../src/scripts/ui/chat/turn-checkpoint-message-runtime-utils.js';
import { resolveActiveSwipeMessageCore } from '../../src/scripts/ui/chat/swipe-ui-utils.js';

const createFakeDocument = () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName || '').toUpperCase();
      this.nodeName = this.tagName;
      this.children = [];
      this.childNodes = this.children;
      this.dataset = {};
      this.style = {};
      this.textContent = '';
      this.className = '';
      this.src = '';
      this.alt = '';
      this.loading = '';
      this.decoding = '';
      this.controls = false;
      this.preload = '';
      this.disabled = false;
      this.innerHTML = '';
      this.listeners = new Map();
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
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }
    emit(type, event = {}) {
      return this.listeners.get(type)?.(event);
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
  const previews = [];
  const toasts = [];
  renderMessageBubbleContentCore({
    bubble,
    message: { type: 'image', content: 'cat.png' },
    documentLike,
    resolveMediaUrl: () => 'resolved://cat.png',
    toastOnce: text => toasts.push(text),
    openLightbox: url => previews.push(url),
  });
  const img = bubble.children[0];
  assert.equal(img.tagName, 'IMG');
  assert.equal(img.src, 'resolved://cat.png');
  img.emit('click');
  assert.deepEqual(previews, ['resolved://cat.png']);
  img.onerror();
  assert.equal(img.alt, '图片加载失败');
  assert.deepEqual(toasts, ['图片加载失败，请检查链接或网络']);
  console.log('ok - renderMessageBubbleContentCore renders previewable images with lightbox and failure toast');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  renderMessageBubbleContentCore({
    bubble,
    message: {
      type: 'image',
      content: '[binary omitted]',
      meta: { localPath: 'D:\\images\\generated.png' },
    },
    documentLike,
    resolveMediaAsset: () => {
      throw new Error('local generated image path should be resolved directly');
    },
  });
  const img = bubble.children[0];
  assert.equal(img.src, 'file:///D:/images/generated.png');
  console.log('ok - renderMessageBubbleContentCore resolves generated image local path from meta');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const target = documentLike.createElement('div');
  const renders = [];
  const logs = [];
  renderMessageBubbleContentCore({
    bubble,
    message: { id: 'm-rich', type: 'text', content: '<b>x</b>', meta: { renderRich: true, isGreeting: true } },
    resolvedSessionId: 'rp:test',
    documentLike,
    prepareTextContainer: () => target,
    renderRichText: (...args) => renders.push(args),
    logGreetingRender: (...args) => logs.push(args),
  });
  assert.equal(renders.length, 1);
  assert.equal(renders[0][0], target);
  assert.equal(renders[0][1], '<b>x</b>');
  assert.equal(renders[0][2].sessionId, 'rp:test');
  assert.equal(renders[0][2].debugTag, 'rp-greeting');
  assert.equal(logs.length, 1);
  console.log('ok - renderMessageBubbleContentCore routes renderRich messages through rich renderer with greeting diagnostics');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const target = documentLike.createElement('div');
  const renders = [];
  renderMessageBubbleContentCore({
    bubble,
    message: { id: 'm-content', type: 'text', content: '<content><b>x</b></content>', meta: { renderRich: true } },
    resolvedSessionId: 'rp:test',
    documentLike,
    prepareTextContainer: () => target,
    renderRichText: (...args) => renders.push(args),
  });
  assert.equal(renders.length, 1);
  assert.equal(renders[0][1], '<content><b>x</b></content>');
  console.log('ok - renderMessageBubbleContentCore preserves creative content wrapper for rich rendering');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const target = documentLike.createElement('div');
  const renders = [];
  renderMessageBubbleContentCore({
    bubble,
    message: {
      id: 'm-content-raw',
      type: 'text',
      content: '<b>x</b>',
      rawSource: '<content><b>x</b></content>',
      meta: { renderRich: true, isGreeting: true },
    },
    resolvedSessionId: 'rp:test',
    documentLike,
    prepareTextContainer: () => target,
    renderRichText: (...args) => renders.push(args),
  });
  assert.equal(renders.length, 1);
  assert.equal(renders[0][1], '<content><b>x</b></content>');
  console.log('ok - renderMessageBubbleContentCore restores raw content wrapper for rich greeting rendering');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const target = documentLike.createElement('div');
  const stickerInputs = [];
  renderMessageBubbleContentCore({
    bubble,
    message: { id: 'm-plain-content', type: 'text', role: 'assistant', content: '<content>正文</content>' },
    documentLike,
    prepareTextContainer: () => target,
    normalizeAssistantLineBreaks: text => text,
    renderTextWithStickers: (_target, text) => {
      stickerInputs.push(text);
      return false;
    },
  });
  assert.deepEqual(stickerInputs, ['正文']);
  assert.equal(target.textContent, '正文');
  console.log('ok - renderMessageBubbleContentCore hides content wrapper only in assistant plain display');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const target = documentLike.createElement('div');
  renderMessageBubbleContentCore({
    bubble,
    message: { id: 'm-user-content', type: 'text', role: 'user', content: '<content>正文</content>' },
    documentLike,
    prepareTextContainer: () => target,
    renderTextWithStickers: () => false,
  });
  assert.equal(target.textContent, '<content>正文</content>');
  console.log('ok - renderMessageBubbleContentCore preserves user literal content tags in plain display');
}

{
  const documentLike = createFakeDocument();
  const generated = {
    id: 'reply-with-display-regex', role: 'assistant', type: 'text',
    raw: '<thinking>隐藏的推演过程</thinking><content>可见正文</content>',
    content: '<content>可见正文</content>',
  };
  const original = structuredClone(generated);
  const liveTarget = documentLike.createElement('div');
  finishMessageDomCore({
    finalMessage: generated,
    messageEl: liveTarget,
    normalizeAssistantLineBreaks: text => text,
    renderTextWithStickers: () => false,
  });
  assert.equal(liveTarget.textContent, '可见正文');

  // Table-memory checkpoints create a reply branch even without regeneration.
  const checkpoint = normalizeCheckpointSwipeState(generated, { clonePlainObject: structuredClone });
  const persisted = JSON.parse(JSON.stringify({
    ...generated,
    meta: { ...checkpoint.meta, swipes: checkpoint.swipes, activeSwipe: checkpoint.activeSwipeIndex },
  }));
  const restored = resolveActiveSwipeMessageCore(buildHistoryRenderMessage(persisted));
  assert.equal(restored.raw, original.raw);
  const restoredBeforeRender = structuredClone(restored);
  const restoredTarget = documentLike.createElement('div');
  renderMessageBubbleContentCore({
    bubble: restoredTarget, message: restored, documentLike,
    prepareTextContainer: bubble => bubble,
    normalizeAssistantLineBreaks: text => text,
    renderTextWithStickers: () => false,
  });
  assert.equal(restoredTarget.textContent, liveTarget.textContent);
  assert.deepEqual(restored, restoredBeforeRender);
  assert.deepEqual(generated, original);
  console.log('ok - checkpoint history restoration preserves the display-regex result shown at stream completion');
}

{
  const documentLike = createFakeDocument();
  for (const role of ['assistant', 'user']) {
    for (const content of ['', '经过显示规则的文字']) {
      const target = documentLike.createElement('div');
      const stickerInputs = [];
      renderMessageBubbleContentCore({
        bubble: target, message: { role, type: 'text', content, raw: '隐藏的原始文字' }, documentLike,
        prepareTextContainer: bubble => bubble,
        normalizeAssistantLineBreaks: text => text,
        renderTextWithStickers: (_target, text) => { stickerInputs.push(text); return false; },
      });
      assert.equal(target.textContent, content);
      assert.deepEqual(stickerInputs, [content]);
    }
  }
  console.log('ok - plain display and sticker rendering respect filtered content including an intentionally empty result');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const target = documentLike.createElement('div');
  const drafts = [];
  renderMessageBubbleContentCore({
    bubble,
    message: { type: 'text', meta: { activeSwipeDraft: { active: true, label: '继续生成' } } },
    documentLike,
    prepareTextContainer: () => target,
    renderSwipeDraftPlaceholder: (...args) => drafts.push(args),
  });
  assert.deepEqual(drafts, [[target, '继续生成']]);
  console.log('ok - renderMessageBubbleContentCore routes active swipe drafts into placeholder rendering');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  renderMessageBubbleContentCore({
    bubble,
    message: {
      type: 'text',
      content: '图片生成失败：429',
      meta: {
        generatedMedia: {
          status: 'failed',
          prompt: 'blue sky',
          error: 'NovelAI API Error: 429',
        },
      },
    },
    documentLike,
  });
  const card = bubble.children[0];
  assert.equal(card.tagName, 'DETAILS');
  assert.equal(card.className.includes('generated-media-error-card'), true);
  const summary = card.children[0];
  const retry = summary.children.find(node => String(node.className || '').includes('generated-media-error-retry'));
  assert.ok(retry);
  assert.equal(retry.dataset.action, 'retry-generated-media');
  assert.equal(retry.textContent, '重新生成图片');
  console.log('ok - renderMessageBubbleContentCore renders retry button for failed generated media');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const message = {
    id: 'image-retry', type: 'text', role: 'assistant', content: '正在生成插图：<content>海边的白色灯塔</content>',
    raw: '<div>上一次错误</div>', rawSource: '<div>旧显示正文</div>', rawOriginal: '<think>旧思考</think><content>旧正文</content>',
    meta: { renderRich: true, isGreeting: true, activeSwipeDraft: { active: true }, generatedMedia: {
      kind: 'image', status: 'running', prompt: '<content>海边的白色灯塔</content>', negativePrompt: '模糊', generationParams: { width: 1536, height: 1024 },
    } },
  };
  const before = structuredClone(message);
  renderMessageBubbleContentCore({ bubble, message, documentLike,
    prepareTextContainer: () => { throw Error('image status must not prepare old RP headers'); },
    renderRichText: () => { throw Error('image prompt must not use stale rich content'); },
    renderSwipeDraftPlaceholder: () => { throw Error('image attempt owns the placeholder'); },
  });
  assert.equal(bubble.textContent, message.content);
  assert.equal(bubble.style.whiteSpace, 'pre-wrap');
  assert.equal(bubble.children.length, 0);
  assert.deepEqual(message, before);
  console.log('ok - running image attempt shows its literal current prompt ahead of retained RP rich/raw metadata');
}

{
  const documentLike = createFakeDocument();
  for (const status of ['failed', 'cancelled', 'interrupted']) {
    for (const error of ['', '服务商返回的错误详情']) {
      const bubble = documentLike.createElement('div');
      const message = {
        type: 'text', role: 'assistant', content: `本次图片状态：${status}`, raw: '旧错误', rawSource: '<div>旧正文</div>',
        meta: { renderRich: true, generatedMedia: { kind: 'image', status, error, prompt: '海边灯塔', negativePrompt: '模糊', generationParams: { quality: 'high' } } },
      };
      const before = structuredClone(message);
      renderMessageBubbleContentCore({ bubble, message, documentLike,
        renderRichText: () => { throw Error('terminal image state must expose retry ahead of rich rendering'); },
      });
      const card = bubble.children[0], heading = card.children[0];
      assert.equal(card.tagName, error ? 'DETAILS' : 'DIV');
      assert.equal(heading.tagName, error ? 'SUMMARY' : 'DIV');
      assert.equal(heading.children[0].textContent, message.content);
      assert.equal(heading.children[1].dataset.action, 'retry-generated-media');
      assert.equal(card.children.length, error ? 2 : 1);
      if (error) assert.equal(card.children[1].textContent, error);
      assert.deepEqual(message, before);
    }
  }
  const withoutPrompt = documentLike.createElement('div');
  renderMessageBubbleContentCore({ bubble: withoutPrompt, documentLike,
    message: { type: 'text', meta: { renderRich: true, generatedMedia: { kind: 'image', status: 'interrupted' } } },
    translateText: value => value === '图片生成已中断' ? 'Image generation interrupted' : value,
  });
  assert.equal(withoutPrompt.children[0].children[0].children.length, 1);
  assert.equal(withoutPrompt.children[0].children[0].children[0].textContent, 'Image generation interrupted');
  console.log('ok - failed/cancelled/interrupted image attempts retain parameters and expose retry, with details only for an error');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  renderMessageBubbleContentCore({ bubble, documentLike,
    message: { type: 'image', content: 'https://example.test/ready.png', raw: '旧失败', meta: { renderRich: true, generatedMedia: { kind: 'image', status: 'succeeded', prompt: '海边灯塔' } } },
    resolveMediaUrl: (kind, url) => url,
  });
  assert.equal(bubble.children[0].tagName, 'IMG');
  assert.equal(bubble.children[0].src, 'https://example.test/ready.png');
  console.log('ok - successful generated images keep the existing image renderer despite old RP metadata');
}

{
  const documentLike = createFakeDocument();
  const bubble = documentLike.createElement('div');
  const target = documentLike.createElement('div');
  let normalizedInput = null;
  const stickerCalls = [];
  renderMessageBubbleContentCore({
    bubble,
    message: { type: 'text', role: 'assistant', raw: 'a\nb' },
    documentLike,
    prepareTextContainer: () => target,
    normalizeAssistantLineBreaks: text => {
      normalizedInput = text;
      return 'normalized text';
    },
    renderTextWithStickers: (...args) => {
      stickerCalls.push(args);
      return false;
    },
  });
  assert.equal(normalizedInput, 'a\nb');
  assert.equal(stickerCalls.length, 1);
  assert.equal(target.textContent, 'normalized text');
  assert.equal(target.style.whiteSpace, 'pre-wrap');
  console.log('ok - renderMessageBubbleContentCore falls back to normalized plain text when sticker rendering does not intercept');
}

{
  const translations = new Map([
    ['图片加载失败', 'Image failed to load'],
    ['图片加载失败，请检查链接或网络', 'Image failed to load. Check the link or network connection.'],
    ['图片生成失败', 'Image generation failed'],
    ['重新生成图片', 'Regenerate image'],
  ]);
  const translateText = value => translations.get(String(value ?? '')) || String(value ?? '');
  const documentLike = createFakeDocument();
  const imageBubble = documentLike.createElement('div');
  const toasts = [];
  renderMessageBubbleContentCore({
    bubble: imageBubble,
    message: { type: 'image', content: 'cat.png' },
    documentLike,
    resolveMediaUrl: value => value,
    toastOnce: text => toasts.push(text),
    translateText,
  });
  imageBubble.children[0].onerror();
  assert.equal(imageBubble.children[0].alt, 'Image failed to load');
  assert.deepEqual(toasts, ['Image failed to load. Check the link or network connection.']);

  const generatedBubble = documentLike.createElement('div');
  renderMessageBubbleContentCore({
    bubble: generatedBubble,
    message: {
      type: 'text',
      content: '保留模型错误标题',
      meta: { generatedMedia: { status: 'failed', prompt: 'blue sky', error: '保留错误详情' } },
    },
    documentLike,
    translateText,
  });
  const generatedSummary = generatedBubble.children[0].children[0];
  assert.equal(generatedSummary.children[0].textContent, '保留模型错误标题');
  assert.equal(generatedSummary.children[1].textContent, 'Regenerate image');
  assert.equal(generatedBubble.children[0].children[1].textContent, '保留错误详情');
  console.log('ok - skipped media cards localize built-in chrome without translating message data');
}
