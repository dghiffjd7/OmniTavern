import assert from 'node:assert/strict';

import {
  buildMaidChatResponderMessages,
  createMaidChatResponder,
} from '../../src/scripts/agent/maid-chat-responder.js';
import { setPromptLocale } from '../../src/scripts/i18n/prompt-locale.js';

{
  setPromptLocale('en');
  const messages = buildMaidChatResponderMessages({
    input: '请用女仆回复',
    maidPrompt: '自定义人格可使用中文撰写。',
  });
  assert.match(messages[0].content, /every user-visible response in English/);
  assert.match(messages[0].content, /internal instructions, app knowledge, tool results, or source data are written in Chinese/);
  setPromptLocale('zh-CN');
  console.log('ok - English maid chat responses keep the output-language guard with custom persona prompts');
}

{
  const messages = buildMaidChatResponderMessages({
    input: '你好啊',
    context: { sessionId: 's1', uiMode: 'chat', activePage: 'chat' },
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /女仆助手/);
  assert.match(messages[0].content, /不要输出 JSON/);
  assert.match(messages[0].content, /优先选择非破坏性做法/);
  assert.match(messages[0].content, /危险操作包括/);
  assert.match(messages[1].content, /你好啊/);
  assert.match(messages[1].content, /s1/);
  assert.match(messages[1].content, /APP 相关讯息/);
  console.log('ok - maid chat responder builds natural reply messages');
}

{
  const messages = buildMaidChatResponderMessages({
    input: '帮我打开世界书',
    context: { sessionId: 's1' },
  });
  assert.match(messages[1].content, /命中：打开世界书/);
  assert.match(messages[1].content, /worldbook\.open/);
  console.log('ok - maid chat responder includes searched app context');
}

{
  const messages = buildMaidChatResponderMessages({
    input: '新手任务有哪些',
  });
  const prompt = messages.map(message => (
    typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content)
  )).join('\n');
  assert.match(prompt, /APP 存在由本地界面直接处理的内建新手任务/);
  assert.doesNotMatch(prompt, /maid\.onboarding|女仆新手引导|guide\.start_flow|setup-api|add-friend|first-chat|meet-maid/);
  console.log('ok - maid chat responder does not receive built-in onboarding flow details');
}

{
  const messages = buildMaidChatResponderMessages({
    input: '你好啊',
    maidPrompt: '自定义女仆 system prompt',
  });
  assert.match(messages[0].content, /自定义女仆 system prompt/);
  assert.match(messages[0].content, /<maid_history>/);
  assert.match(messages[0].content, /未确认时跳过/);
  console.log('ok - maid chat responder uses editable maid prompt as system prompt');
}

{
  const messages = buildMaidChatResponderMessages({
    input: '继续刚才那个',
    context: { sessionId: 's1' },
    conversationContext: {
      historyText: '- 用户: 创建角色卡 A\n  结果: 已完成',
      memoryText: '| 1 | 摘要 |\n| 内容 | 用户创建了角色卡 A。 |',
    },
  });
  assert.match(messages[1].content, /<maid_memory today="\d{4}-\d{2}-\d{2}">\n\| 1 \| 摘要/, 'memory is wrapped and dated');
  assert.match(messages[1].content, /<\/maid_memory>\n<maid_history>/);
  assert.match(messages[0].content, /仅供参考/);
  assert.match(messages[0].content, /先用工具重新读取/, 'changeable app state must be re-read');
  assert.match(messages[1].content, /用户创建了角色卡 A/);
  assert.match(messages[1].content, /<\/maid_history>/);
  assert.match(messages[1].content, /创建角色卡 A/);
  console.log('ok - maid chat responder injects history and memory context');
}

{
  const messages = buildMaidChatResponderMessages({
    input: '帮我看看这张图',
    context: {
      maidAttachments: [{ kind: 'image', url: 'data:image/png;base64,abc', name: 'screen.png' }],
    },
  });
  assert.equal(Array.isArray(messages[1].content), true);
  assert.match(messages[1].content[0].text, /用户附图/);
  assert.equal(messages[1].content[1].type, 'image_url');
  assert.equal(messages[1].content[1].image_url.url, 'data:image/png;base64,abc');
  console.log('ok - maid chat responder includes image attachments as multimodal parts');
}

{
  const messages = buildMaidChatResponderMessages({
    input: '女王最后回了我什么？',
    context: {
      sessionId: 's1',
      maidToolObservation: {
        plan: { toolName: 'app.read_resource' },
        output: { messages: [{ role: 'assistant', rawOriginal: '晚上好，今天辛苦了。' }] },
      },
    },
  });
  assert.match(messages[0].content, /工具观察结果/);
  assert.match(messages[0].content, /不要只说已查看/);
  assert.match(messages[1].content, /已执行工具观察结果/);
  assert.match(messages[1].content, /今天辛苦了/);
  console.log('ok - maid chat responder can summarize tool observations');
}

{
  const calls = [];
  const injected = [];
  const debugSnapshots = [];
  const responder = createMaidChatResponder({
    resolveRuntimeConfig: async () => ({
      configured: true,
      maidPrompt: '活泼一点',
      client: {
        chat: async (messages, options) => {
          calls.push({ messages, options });
          return '你好，我在。';
        },
      },
    }),
    isConfigReady: () => true,
    getConversationContext: () => ({
      historyText: '- 用户: 你好',
      memoryText: '| 内容 | 用户在打招呼 |',
      tokenCount: 12,
    }),
    onContextInjected: payload => injected.push(payload),
    onDebugSnapshot: snapshot => debugSnapshots.push(snapshot),
    logger: { warn() {} },
  });
  const result = await responder('你好啊', { sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'responded');
  assert.equal(result.message, '你好，我在。');
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[0].content, /活泼一点/);
  assert.match(calls[0].messages[0].content, /<maid_history>/);
  assert.equal(calls[0].options.maxTokens, 800);
  assert.equal(debugSnapshots.length, 1);
  assert.equal(debugSnapshots[0].source, 'maid_chat_responder');
  assert.equal(debugSnapshots[0].responseText, '你好，我在。');
  assert.match(debugSnapshots[0].messages[1].content, /你好啊/);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].conversationContext.tokenCount, 12);
  console.log('ok - maid chat responder calls bound runtime client');
}

{
  const responder = createMaidChatResponder({
    resolveRuntimeConfig: async () => ({
      configured: true,
      client: {
        chat: async () => '{"ok":true,"action":"tool","toolName":"worldbook.update_entries","featureId":"worldbook.update_entries","args":{"name":"W","updates":[]}}',
      },
    }),
    logger: { warn() {} },
  });
  const result = await responder('是的，替换成扩展版');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'chat_response_contains_tool_plan');
  assert.match(result.message, /工具执行流程/);
  console.log('ok - maid chat responder refuses tool plans emitted as chat text');
}

{
  const responder = createMaidChatResponder({
    resolveRuntimeConfig: async () => ({
      configured: false,
      reason: 'maid_profile_not_bound',
    }),
    logger: { warn() {} },
  });
  const result = await responder('你好啊');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.reason, 'maid_profile_not_bound');
  console.log('ok - maid chat responder refuses without bound runtime client');
}

{
  // 取消贯通：signal 传入 client.chat；AbortError 向上穿透，不转「女仆暂时无法回复」普通失败
  const controller = new AbortController();
  let capturedSignal = null;
  const responder = createMaidChatResponder({
    resolveRuntimeConfig: async () => ({
      configured: true,
      client: {
        chat: async (_messages, options) => {
          capturedSignal = options?.signal || null;
          controller.abort();
          const error = new Error('stopped by user');
          error.name = 'AbortError';
          throw error;
        },
      },
    }),
    logger: { warn() {} },
  });
  await assert.rejects(
    () => responder('随便聊聊', { signal: controller.signal }),
    error => error?.name === 'AbortError',
  );
  assert.equal(capturedSignal, controller.signal);
  console.log('ok - maid chat responder forwards signal and rethrows AbortError');
}

{
  // 外层 signal 仍存活的 AbortError 是供应商失败，不是用户点击停止。
  const controller = new AbortController();
  const responder = createMaidChatResponder({
    resolveRuntimeConfig: async () => ({
      configured: true,
      client: {
        chat: async () => {
          const error = new Error('provider timeout aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
    }),
    logger: { warn() {} },
  });
  const result = await responder('随便聊聊', { signal: controller.signal });
  assert.equal(controller.signal.aborted, false);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /provider timeout aborted/);
  console.log('ok - provider AbortError with a live caller signal is reported as a chat failure');
}
