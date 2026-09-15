import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

// Run via Windows PowerShell against the current dev WebView. Real protocol,
// regex and bubble modules, with isolated fixtures and no model/storage calls.
const result = await evaluateInApp(String.raw`(async () => {
  const [{ DialogueStreamParser }, { buildProtocolRetryCandidates }, transaction, batchUtils, builders, { RegexStore, regex_placement }] = await Promise.all([
    import('./scripts/ui/chat/dialogue-stream-parser.js'),
    import('./scripts/ui/chat/protocol-parse-utils.js'),
    import('./scripts/ui/chat/protocol-response-transaction-utils.js'),
    import('./scripts/ui/chat/protocol-batch-utils.js'),
    import('./scripts/ui/chat/assistant-message-builder-utils.js'),
    import('./scripts/storage/regex-store.js'),
  ]);
  const ui = window.appBridge.getChatUI();
  const regex = Object.create(RegexStore.prototype);
  regex.state = { global: { enabled: true, rules: [
    { id: 'fixture-stored', findRegex: '实际回复', replaceString: '保存正文', placement: [2] },
    { id: 'fixture-display', findRegex: '保存正文', replaceString: '显示正文', placement: [2], markdownOnly: true },
  ] }, local: { order: [], sets: {} }, session: {} };
  const phone = body => 'MiPhone_start\nmsg_start\n<我和小雨的私聊>小雨--' + body + '--13:40</我和小雨的私聊>\nmsg_end\nMiPhone_end';
  const example = phone('思考示例');
  const actual = phone('实际回复');
  const cases = [
    { label: 'buffered-prefill', raw: example + '\n</thinking>\n' + actual },
    { label: 'streamed-think-and-empty-shell', raw: '<think>' + example + '</think>\nMiPhone_start\nMiPhone_end\n' + actual, stream: true },
  ];
  const results = [];
  for (const item of cases) {
    let fullRaw = item.raw;
    if (item.stream) {
      async function* chunks() {
        yield { reasoning: '原生独立 reasoning：' + example };
        for (let offset = 0; offset < item.raw.length; offset += 17) {
          yield { content: item.raw.slice(offset, offset + 17) };
        }
      }
      fullRaw = (await transaction.collectProtocolResponseStream({ stream: chunks() })).fullRaw;
    }
    const regexInputs = [];
    const messages = [];
    const outcome = await transaction.runProtocolResponseTransaction({
      rawText: fullRaw,
      buildRetryCandidates: buildProtocolRetryCandidates,
      createParser: () => new DialogueStreamParser(),
      preflightEvent: event => ({ ok: event.type === 'private_chat' && event.otherName === '小雨' && event.messages.length > 0 }),
      processEvent: async event => {
        const batch = await batchUtils.buildProtocolPrivateChatBatch(event, {
          resolveTargetSessionId: () => 'protocol-thinking-fixture',
          buildAssistantMessageFromText: (text, options) => builders.buildAssistantMessageFromText(text, {
            ...options,
            name: '小雨',
            applyChatModeAssistantRegex: source => builders.applyChatModeAssistantRegex(source, {
              applyStoredRegex: text => {
                regexInputs.push(text);
                return regex.apply(text, {}, regex_placement.AI_OUTPUT, { isMarkdown: false, isPrompt: false });
              },
              applyDisplayRegex: text => regex.apply(text, {}, regex_placement.AI_OUTPUT, { isMarkdown: true, isPrompt: false }),
            }),
          }),
        });
        messages.push(...batch.items.map(entry => entry.parsed));
        return { consumed: batch.items.length > 0, didAnything: batch.items.length > 0 };
      },
    });
    const message = messages[0];
    const element = message ? ui.buildMessageElement({ ...message, id: 'protocol-fixture-' + item.label }) : null;
    results.push({ label: item.label, handled: outcome.handled, source: outcome.candidateSource,
      originalPreserved: fullRaw === item.raw, regexInputs, messageCount: messages.length,
      rawOriginal: message?.rawOriginal, stored: message?.raw, display: message?.content,
      renderedBody: Boolean(element?.textContent.includes('显示正文')),
      renderedThinking: Boolean(element?.textContent.includes('思考示例')),
    });
    if (element) ui.cleanupRichTextMounts(element);
  }
  return { ready: document.readyState, results, userMessagesWritten: 0 };
})()`, { timeoutMs: 20000 });

assert.equal(result.ready, 'complete');
assert.equal(result.userMessagesWritten, 0);
for (const item of result.results) {
  assert.equal(item.handled, true, item.label);
  assert.equal(item.source, 'raw', item.label);
  assert.equal(item.originalPreserved, true, item.label);
  assert.deepEqual(item.regexInputs, ['实际回复'], item.label);
  assert.equal(item.messageCount, 1, item.label);
  assert.equal(item.rawOriginal, '实际回复', item.label);
  assert.equal(item.stored, '保存正文', item.label);
  assert.equal(item.display, '显示正文', item.label);
  assert.equal(item.renderedBody, true, item.label);
  assert.equal(item.renderedThinking, false, item.label);
}
console.log(JSON.stringify(result, null, 2));
