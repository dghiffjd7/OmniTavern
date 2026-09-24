import assert from 'node:assert/strict';

import {
  applyMergePromptPostProcessing,
  applyPromptPostProcessing,
  applySemiStrictPromptPostProcessing,
  applySingleUserPromptPostProcessing,
  applyStrictPromptPostProcessing,
  buildPendingUserTextWithScenarioReminder,
  buildPresetContext,
  buildReplyPromptHint,
  createPresetRuntime,
  normalizePromptPostProcessingMode,
  resolveOpenAIPresetFormatReminderState,
  resolveEnabledPreset,
  resolveResolvedPreset,
} from '../../src/scripts/ui/chat/prompt-context-utils.js';

{
  assert.deepEqual(buildPresetContext({ sessionId: ' s1 ', uiMode: '' }), {
    sessionId: 's1',
    uiMode: 'chat',
  });
  console.log('ok - buildPresetContext normalizes session id and ui mode fallback');
}

{
  const appBridge = {
    presets: {
      getResolvedActive(type, context) {
        return {
          preset: { type, context },
        };
      },
    },
  };
  assert.deepEqual(resolveResolvedPreset(appBridge, 'openai', { sessionId: 's1' }), {
    type: 'openai',
    context: { sessionId: 's1' },
  });
  assert.deepEqual(resolveResolvedPreset({}, 'reasoning', { sessionId: 's1' }), {});
  console.log('ok - resolveResolvedPreset reads preset state and tolerates missing bridge');
}

{
  const appBridge = {
    presets: {
      getSelectionState() {
        return { active: {}, enabled: { sysprompt: true, openai: false } };
      },
      getResolvedActive(type) {
        return { preset: { type, ok: true } };
      },
    },
  };
  assert.deepEqual(resolveEnabledPreset(appBridge, 'sysprompt', { sessionId: 's1' }), {
    type: 'sysprompt',
    ok: true,
  });
  assert.deepEqual(resolveEnabledPreset(appBridge, 'openai', { sessionId: 's1' }), {});
  assert.deepEqual(resolveEnabledPreset({}, 'sysprompt', { sessionId: 's1' }), {});
  console.log('ok - resolveEnabledPreset requires enabled state before resolving preset');
}

{
  assert.deepEqual(
    resolveOpenAIPresetFormatReminderState({ presetId: 'default' }, { name: 'Custom' }),
    {
      presetId: 'default',
      presetName: 'Custom',
      hasPreset: true,
      isDefaultPreset: true,
    },
  );
  assert.deepEqual(
    resolveOpenAIPresetFormatReminderState({ presetId: 'creative' }, { name: 'Creative' }),
    {
      presetId: 'creative',
      presetName: 'Creative',
      hasPreset: true,
      isDefaultPreset: false,
    },
  );
  assert.equal(
    resolveOpenAIPresetFormatReminderState(
      { presetId: 'renamed-builtin', isBuiltinDefault: true },
      { name: '不是 Default' },
    ).isDefaultPreset,
    true,
  );
  assert.equal(
    resolveOpenAIPresetFormatReminderState(
      { presetId: 'default', isBuiltinDefault: false },
      { name: 'Default' },
    ).isDefaultPreset,
    false,
  );
  console.log('ok - resolveOpenAIPresetFormatReminderState prefers resolved builtin identity over names');
}

{
  assert.equal(
    buildPendingUserTextWithScenarioReminder({
      rawText: '你好',
      replyHint: '引用上一条',
      scenarioReminder: '正在与小夏私聊，请遵循私聊格式',
      appendScenarioReminder: true,
    }),
    '你好（引用上一条）\n\n（正在与小夏私聊，请遵循私聊格式）',
  );
  assert.equal(
    buildPendingUserTextWithScenarioReminder({
      rawText: '你好',
      scenarioReminder: '在旅行群中群聊，请遵循群聊格式',
      appendScenarioReminder: false,
    }),
    '你好',
  );
  assert.equal(
    buildPendingUserTextWithScenarioReminder({
      rawText: '你好',
      scenarioReminder: '正在与小夏私聊，请遵循私聊格式',
      suppressPendingUserTurn: true,
      appendScenarioReminder: true,
    }),
    '',
  );
  console.log('ok - buildPendingUserTextWithScenarioReminder appends non-default scenario reminders to user input');
}

{
  assert.equal(normalizePromptPostProcessingMode('strict'), 'strict');
  assert.equal(normalizePromptPostProcessingMode('merge'), 'merge');
  assert.equal(normalizePromptPostProcessingMode('semi'), 'semi');
  assert.equal(normalizePromptPostProcessingMode('single'), 'single');
  assert.equal(normalizePromptPostProcessingMode('unknown'), 'none');
  const messages = [{ role: 'assistant', content: '预填' }];
  assert.equal(applyPromptPostProcessing(messages, 'none'), messages);
  console.log('ok - normalizePromptPostProcessingMode defaults unknown modes to none');
}

{
  assert.deepEqual(
    applyMergePromptPostProcessing([
      { role: 'system', content: '基础设定' },
      { role: 'system', content: '格式设定' },
      { role: 'assistant', content: '历史回复', tool_calls: [{ id: 'tool-1' }] },
      { role: 'assistant', content: '继续回复' },
      { role: 'tool', content: '工具结果', tool_call_id: 'tool-1' },
    ]),
    [
      { role: 'system', content: '基础设定\n\n格式设定' },
      { role: 'assistant', content: '历史回复\n\n继续回复' },
      { role: 'user', content: '工具结果' },
    ],
  );
  console.log('ok - applyMergePromptPostProcessing merges same-role turns and drops tool metadata');
}

{
  assert.deepEqual(
    applySemiStrictPromptPostProcessing([
      { role: 'system', content: '开场系统' },
      { role: 'assistant', content: '允许不以 user 开始' },
      { role: 'system', content: '后段系统' },
      { role: 'user', content: '你好' },
    ]),
    [
      { role: 'system', content: '开场系统' },
      { role: 'assistant', content: '允许不以 user 开始' },
      { role: 'user', content: '后段系统\n\n你好' },
    ],
  );
  console.log('ok - applySemiStrictPromptPostProcessing converts mid-prompt system messages without inserting placeholders');
}

{
  assert.deepEqual(
    applyStrictPromptPostProcessing([
      { role: 'system', content: '开场系统' },
      { role: 'assistant', content: '不应直接跟在 system 后' },
      { role: 'system', content: '后段系统' },
      { role: 'system', content: '格式提醒' },
      { role: 'user', content: '你好' },
    ]),
    [
      { role: 'system', content: '开场系统' },
      { role: 'user', content: "Let's get started." },
      { role: 'assistant', content: '不应直接跟在 system 后' },
      { role: 'user', content: '后段系统\n\n格式提醒\n\n你好' },
    ],
  );

  assert.deepEqual(
    applyStrictPromptPostProcessing([
      { role: 'assistant', content: '继续写' },
      { role: 'assistant', content: '第二段' },
    ]),
    [
      { role: 'user', content: "Let's get started." },
      { role: 'assistant', content: '继续写\n\n第二段' },
    ],
  );
  assert.deepEqual(
    applyStrictPromptPostProcessing([
      { role: 'assistant', content: '历史回复' },
      { role: 'system', content: '图片提示' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }] },
    ]),
    [
      { role: 'user', content: "Let's get started." },
      { role: 'assistant', content: '历史回复' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '图片提示' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ],
      },
    ],
  );
  console.log('ok - applyStrictPromptPostProcessing enforces first user turn and merges late system messages');
}

{
  assert.deepEqual(
    applySingleUserPromptPostProcessing([
      { role: 'system', content: '基础设定' },
      { role: 'assistant', content: '历史回复' },
      { role: 'user', content: '最新消息' },
    ]),
    [
      { role: 'user', content: '基础设定\n\n历史回复\n\n最新消息' },
    ],
  );
  assert.deepEqual(applyPromptPostProcessing([], 'single'), [{ role: 'user', content: "Let's get started." }]);
  console.log('ok - applySingleUserPromptPostProcessing flattens all messages into one user turn');
}

{
  const runtime = createPresetRuntime({
    appBridge: {
      config: {
        get() {
          return { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' };
        },
      },
      presets: {
        getResolvedActive(type, context) {
          if (type === 'openai') return { preset: { type, context, continue_prefill: true } };
          return { preset: { type, context } };
        },
      },
    },
    getSessionId: () => ' s1 ',
    getUiMode: () => '',
    isDeepSeekRequest: ({ provider, model }) => provider === 'openai' && model === 'deepseek-chat',
  });
  assert.deepEqual(runtime.getPresetContext(), { sessionId: 's1', uiMode: 'chat' });
  assert.deepEqual(runtime.getOpenAIPreset(), {
    type: 'openai',
    context: { sessionId: 's1', uiMode: 'chat' },
    continue_prefill: true,
  });
  assert.deepEqual(runtime.getReasoningPreset(), {
    type: 'reasoning',
    context: { sessionId: 's1', uiMode: 'chat' },
  });
  assert.equal(runtime.canUseDeepSeekPrefixCompletion(), true);
  assert.equal(runtime.canUseDeepSeekContinuePrefill(), true);
  console.log('ok - createPresetRuntime exposes dynamic preset accessors and deepseek gating');
}

{
  assert.equal(buildReplyPromptHint([]), '');
  assert.equal(
    buildReplyPromptHint([
      {
        userMessage: '你好',
        replyTo: { author: '助手', content: '早上好' },
      },
    ]),
    '你好（回复了助手：早上好）',
  );
  assert.equal(
    buildReplyPromptHint([
      {
        userMessage: 'A',
        replyTo: { author: '甲', content: '1' },
      },
      {
        userMessage: 'B',
        replyTo: { author: '乙', content: '2' },
      },
    ]),
    '1. A（回复了甲：1）；2. B（回复了乙：2）',
  );
  console.log('ok - buildReplyPromptHint formats single and multiple reply contexts');
}
