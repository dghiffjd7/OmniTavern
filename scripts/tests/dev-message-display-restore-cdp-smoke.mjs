import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

// Real WebView rendering with isolated messages and display rules; no model or storage calls.
const result = await evaluateInApp(String.raw`(async () => {
  const [{ RegexStore, regex_placement }, builders, { applyOutputRegexPairSafe }, { __chatStoreStorageInternals: storage }, { normalizeCheckpointSwipeState }, { preloadHistoryCore }, { finishMessageDomCore }] = await Promise.all([
    import('./scripts/storage/regex-store.js'), import('./scripts/ui/chat/assistant-message-builder-utils.js'),
    import('./scripts/ui/chat/output-regex-utils.js'), import('./scripts/storage/chat-store.js'),
    import('./scripts/ui/chat/turn-checkpoint-message-runtime-utils.js'), import('./scripts/ui/chat/message-list-ui-utils.js'),
    import('./scripts/ui/chat/assistant-stream-ui-utils.js'),
  ]);
  const regex = Object.create(RegexStore.prototype);
  regex.state = { global: { enabled: true, rules: [
      { id: 'hide-thinking-pair', findRegex: '<thinking>[\\s\\S]*?</thinking>', replaceString: '', placement: [2], markdownOnly: true, promptOnly: true },
      { id: 'hide-thinking-prefix', findRegex: '/^[\\s\\S]*?<\\/thinking>/i', replaceString: '', placement: [2], markdownOnly: true, promptOnly: true },
    ] }, local: { order: [], sets: {} }, session: {} };
  const filtered = {
    applyOutputStoredRegex: (text, opts) => regex.apply(text, {}, regex_placement.AI_OUTPUT, { ...opts, isMarkdown: false, isPrompt: false }),
    applyOutputDisplayRegex: (text, opts) => regex.apply(text, {}, regex_placement.AI_OUTPUT, { ...opts, isMarkdown: true, isPrompt: false }),
  };
  const ui = window.appBridge.getChatUI();
  const marker = 'HISTORY_HIDDEN_THINKING';
  const raw = '<thinking>1. 守护者AI已加载。\n'+marker+'\n</thinking>\n<content>正文验证：晚风吹过窗边。</content>';
  const cases=[];
  for (const mode of ['rp', 'chat']) {
    const sessionId = mode==='rp' ? 'rp:kuku-history-isolated' : 'kuku-history-isolated';
    const message = mode==='rp'
      ? await builders.buildCreativeAssistantMessage({ text: raw, rawOriginal: raw, sessionId, id: 'probe-rp', includeId: true, appBridge: filtered, applyOutputRegexPairSafe })
      : builders.buildChatModeAssistantMessage({ text: raw, rawOriginal: raw, id: 'probe-chat', includeId: true,
          applyChatModeAssistantRegex: text => builders.applyChatModeAssistantRegex(text, { applyStoredRegex: filtered.applyOutputStoredRegex, applyDisplayRegex: filtered.applyOutputDisplayRegex }) });
    message.sessionId = sessionId;
    for (const checkpoint of [false, true]) {
      const original=structuredClone(message);
      const live=document.createElement('div');
      const liveWrapper=document.createElement('div'); liveWrapper.appendChild(live);
      finishMessageDomCore({
        messageEl: live, wrapperEl: liveWrapper, finalMessage: original, msgId: original.id,
        applyReasoningUiState: (...args) => ui.applyReasoningUiState(...args),
        applyCreativeBubbleState: (...args) => ui.applyCreativeBubbleState(...args),
        prepareTextContainer: (...args) => ui.prepareTextContainer(...args),
        renderRichText: (...args) => ui.renderRichText(...args),
        normalizeAssistantLineBreaks: text => ui.normalizeAssistantLineBreaks(text),
        renderTextWithStickers: (...args) => ui.renderTextWithStickers(...args),
      });
      if (checkpoint) {
        const snapshot=normalizeCheckpointSwipeState(original, { clonePlainObject: value => structuredClone(value) });
        original.meta={...snapshot.meta, swipes:snapshot.swipes, activeSwipe:snapshot.activeSwipeIndex};
      }
      const persisted=JSON.parse(JSON.stringify(storage.sanitizeMessageForPersist(original, { preserveLargeFields:true })));
      persisted.id += '-history-'+checkpoint;
      const host=window.appBridge; const previousStored=host.applyOutputStoredRegex; const previousDisplay=host.applyOutputDisplayRegex;
      const history=document.createElement('div');
      let decorated;
      try {
        host.applyOutputStoredRegex=filtered.applyOutputStoredRegex;
        host.applyOutputDisplayRegex=filtered.applyOutputDisplayRegex;
        decorated=ui.messageDecorator(persisted);
        preloadHistoryCore({ messages:[decorated], keepScroll:true, scrollEl:history, documentLike:document, isRp:mode==='rp', buildMessageElement:message => ui.buildMessageElement(message) });
        cases.push({ mode, checkpoint, storedDisplayHidden: !persisted.content.includes(marker), decoratedHidden: !decorated.content.includes(marker), liveHidden: !live.textContent.includes(marker), restoredHidden: !history.textContent.includes(marker), liveBody: live.textContent.includes('晚风吹过窗边'), restoredBody: history.textContent.includes('晚风吹过窗边'), restoredRich: history.querySelector('[data-msg-id]')?.__chatappMessage?.meta?.renderRich===true });
      } finally {
        host.applyOutputStoredRegex=previousStored; host.applyOutputDisplayRegex=previousDisplay;
        ui.cleanupRichTextMounts(history); ui.cleanupRichTextMounts(liveWrapper);
      }
    }
  }
  return {cases, userMessagesWritten:0};
})()`, { timeoutMs: 20000 });

assert.equal(result.userMessagesWritten, 0);
assert.equal(result.cases.length, 4);
for (const item of result.cases) {
  for (const key of ['storedDisplayHidden', 'decoratedHidden', 'liveHidden', 'restoredHidden', 'liveBody', 'restoredBody']) {
    assert.equal(item[key], true, `${item.mode} checkpoint=${item.checkpoint}: ${key}`);
  }
  assert.equal(item.restoredRich, item.mode === 'rp');
}
console.log(JSON.stringify(result, null, 2));
