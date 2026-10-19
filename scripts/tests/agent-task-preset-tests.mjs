import assert from 'node:assert/strict';

import {
  createAgentTaskPresetResolver,
  describeTaskPreset,
  pickPresetPromptOrder,
  renderTaskPresetMessages,
  resolveAgentPromptSource,
  presetSamplingParams,
  applyTaskPresetToParts,
  applyAgentConfigTaskPreset,
  setAgentTaskPresetSource,
} from '../../src/scripts/ui/chat/agent-task-preset.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const preset = {
  id: 'task-summary',
  name: '大总结专用',
  prompts: [
    { identifier: 'main', name: '主指令', role: 'system', content: '你是{{char}}的记录员，为{{user}}整理。' },
    { identifier: 'charDescription', marker: true },
    { identifier: 'personaDescription', marker: true },
    { identifier: 'worldInfoBefore', marker: true },
    { identifier: 'dialogueExamples', marker: true },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'output', name: '输出要求', role: 'user', content: '把结果写在 <summary> 里。' },
    { identifier: 'disabled', name: '关掉的', role: 'system', content: '不该出现' },
    { identifier: 'blank', name: '空条目', role: 'system', content: '   ' },
    { identifier: 'prefill', name: '预填', role: 'assistant', content: '好的', system_prompt: false },
    { identifier: 'forced', name: '强制系统', role: 'user', content: '系统级', system_prompt: true },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
    { character_id: 100001, order: [
      { identifier: 'main', enabled: true },
      { identifier: 'charDescription', enabled: true },
      { identifier: 'personaDescription', enabled: true },
      { identifier: 'worldInfoBefore', enabled: true },
      { identifier: 'dialogueExamples', enabled: true },
      { identifier: 'chatHistory', enabled: true },
      { identifier: 'output', enabled: true },
      { identifier: 'disabled', enabled: false },
      { identifier: 'blank', enabled: true },
      { identifier: 'prefill', enabled: true },
      { identifier: 'forced', enabled: true },
      { identifier: 'not-in-prompts', enabled: true },
    ] },
  ],
};

const macros = text => String(text).replaceAll('{{char}}', '阿兰').replaceAll('{{user}}', '我');
const data = [{ role: 'user', content: '【已有大总结】旧的\n\n【前文内容】新的' }];

test('picks the global ST order block before the legacy one', () => {
  assert.equal(pickPresetPromptOrder(preset).length, 12);
  assert.deepEqual(pickPresetPromptOrder({ prompt_order: [{ character_id: 7, order: [{ identifier: 'a' }] }] }), [{ identifier: 'a' }]);
  assert.equal(pickPresetPromptOrder({ prompts: [] }), null);
});

test('renders entries in order, fills session markers, leaves world info empty and puts data at chatHistory', () => {
  const result = renderTaskPresetMessages({
    preset,
    data,
    fill: { charDescription: '{{char}}是猫娘', personaDescription: '我是主人', scenario: '不该出现（预设没启用 scenario）' },
    renderMacros: macros,
  });
  assert.equal(result.ok, true);
  assert.equal(result.hasHistorySlot, true);
  assert.deepEqual(result.messages, [
    { role: 'system', content: '你是阿兰的记录员，为我整理。' },
    { role: 'system', content: '阿兰是猫娘' },
    { role: 'system', content: '我是主人' },
    { role: 'user', content: '【已有大总结】旧的\n\n【前文内容】新的' },
    { role: 'user', content: '把结果写在 <summary> 里。' },
    { role: 'assistant', content: '好的' },
    { role: 'system', content: '系统级' },
  ]);
  // 数据是副本，改结果不影响调用方
  result.messages[3].content = 'x';
  assert.equal(data[0].content.startsWith('【已有大总结】'), true);
});

test('without a chatHistory slot the data goes last', () => {
  const noHistory = { ...preset, prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'output', enabled: true }] }] };
  const result = renderTaskPresetMessages({ preset: noHistory, data, renderMacros: macros });
  assert.equal(result.hasHistorySlot, false);
  assert.deepEqual(result.messages.map(m => m.content), ['你是阿兰的记录员，为我整理。', '把结果写在 <summary> 里。', data[0].content]);
});

test('presets without prompt_order fall back to the prompts list and their enabled flags', () => {
  const result = renderTaskPresetMessages({
    preset: { prompts: [
      { identifier: 'a', role: 'system', content: 'A' },
      { identifier: 'b', role: 'system', content: 'B', enabled: false },
      { identifier: 'chatHistory', marker: true },
    ] },
    data,
  });
  assert.deepEqual(result.messages.map(m => m.content), ['A', data[0].content]);
});

test('missing or empty presets are reported instead of sending only the data', () => {
  assert.deepEqual(renderTaskPresetMessages({ preset: null, data }), { ok: false, reason: 'preset_missing', messages: [], hasHistorySlot: false });
  assert.equal(renderTaskPresetMessages({ preset: { name: 'x' }, data }).reason, 'preset_empty');
});

test('describe counts enabled non-empty entries and the session fields it will fill', () => {
  assert.deepEqual(describeTaskPreset(preset), {
    ok: true,
    enabledEntries: 4,
    hasHistorySlot: true,
    filled: ['charDescription', 'personaDescription'],
    leftEmpty: ['worldInfoBefore', 'dialogueExamples'],
  });
  assert.equal(describeTaskPreset(null).ok, false);
});

test('resolver renders with sandboxed macros and per-session fill, and reports deleted presets', () => {
  const calls = [];
  const resolver = createAgentTaskPresetResolver({
    getPreset: id => (id === 'task-summary' ? structuredClone(preset) : null),
    renderMacros: (text, ctx) => {
      calls.push(ctx);
      return macros(text);
    },
    getFill: ctx => ({ charDescription: `${ctx.sessionId} 的角色`, personaDescription: '' }),
  });
  assert.deepEqual(resolver.resolve('gone', { sessionId: 's1' }), { ok: false, reason: 'preset_missing', id: 'gone' });
  const resolved = resolver.resolve('task-summary', { sessionId: 's1', userName: '我', charName: '阿兰' });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.name, '大总结专用');
  assert.equal(resolved.describe.enabledEntries, 4);
  const rendered = resolved.render(data);
  assert.equal(rendered.messages[1].content, 's1 的角色');
  assert.equal(rendered.messages.some(m => m.content === ''), false);
  assert.ok(calls.length > 0);
  const states = new Set(calls.map(ctx => ctx.macroVariableState));
  assert.equal(states.size, 1, 'one render shares one sandbox');
  assert.ok([...states][0] instanceof Map);
  assert.deepEqual([...new Set(calls.map(ctx => `${ctx.sessionId}/${ctx.user}/${ctx.char}`))], ['s1/我/阿兰']);
  const transformed = resolved.render(data, { transform: text => String(text).replace('记录员', '{{body}}').replace('{{body}}', '正文') });
  assert.equal(transformed.messages[0].content, '你是阿兰的正文，为我整理。');
});

test('prompt source: preset mode falls back to the prompt when no preset is set or it was deleted', () => {
  const resolver = { resolve: (id, ctx) => (id === 'ok' ? { ok: true, id, name: '大总结专用', ctx } : { ok: false, reason: 'preset_missing', id }) };
  assert.deepEqual(resolveAgentPromptSource({ mode: 'prompt', presetId: 'ok', resolver }), { mode: 'prompt', fallback: '' });
  assert.deepEqual(resolveAgentPromptSource({ mode: 'preset', presetId: ' ', resolver }), { mode: 'prompt', fallback: 'preset_unset', presetId: '' });
  assert.deepEqual(resolveAgentPromptSource({ mode: 'preset', presetId: 'gone', resolver }), { mode: 'prompt', fallback: 'preset_missing', presetId: 'gone' });
  const used = resolveAgentPromptSource({ mode: 'preset', presetId: 'ok', resolver, ctx: { sessionId: 's1' } });
  assert.equal(used.mode, 'preset');
  assert.equal(used.presetName, '大总结专用');
  assert.deepEqual(used.taskPreset.ctx, { sessionId: 's1' });
  assert.deepEqual(resolveAgentPromptSource({ mode: 'preset', presetId: 'ok' }), { mode: 'prompt', fallback: 'preset_missing', presetId: 'ok' });
});

test('sampling params come from the preset; token limits and unknown values are left out', () => {
  assert.deepEqual(presetSamplingParams({ temperature: 0.8, top_p: 0.95, top_k: 40.7, presence_penalty: 0, frequency_penalty: 'x', openai_max_tokens: 30000, seed: 3 }),
    { temperature: 0.8, top_p: 0.95, top_k: 40, presence_penalty: 0 });
  assert.deepEqual(presetSamplingParams(null), {});
});

test('agent parts: task parts give way to the preset, data goes to chatHistory, format kept only when asked', () => {
  const taskPreset = { ok: true, id: 'p1', name: '分析用', render: data => ({ ok: true, messages: [{ role: 'system', content: '预设主指令' }, ...data] }) };
  const parts = [
    { part: 'task', role: 'system', content: '任务要求', source: '任务要求' },
    { part: 'format', role: 'system', content: '返回 format_patch.v1', source: '返回格式' },
    { part: 'data', role: 'user', content: '参考', source: '参考上下文' },
    { part: 'data', role: 'user', content: '  ', source: '空的' },
    { part: 'data', role: 'user', content: '正文', source: '允许修改的文本' },
  ];
  const kept = applyTaskPresetToParts({ parts, taskPreset, keepFormat: true });
  assert.deepEqual(kept.messages, [
    { role: 'system', content: '预设主指令' }, { role: 'user', content: '参考' }, { role: 'user', content: '正文' }, { role: 'system', content: '返回 format_patch.v1' },
  ]);
  assert.deepEqual(kept.sections.map(s => [s.source, s.origin]), [
    ['预设 · 分析用', '套用预设'], ['参考上下文', '聊天记录位置'], ['允许修改的文本', '聊天记录位置'], ['返回格式', '程序固定附加'],
  ]);
  assert.equal(kept.sections.some(s => 'editField' in s), false, '套用预设时没有可编辑的区块');
  const dropped = applyTaskPresetToParts({ parts, taskPreset });
  assert.deepEqual(dropped.messages.map(m => m.content), ['预设主指令', '参考', '正文']);
  assert.deepEqual(applyTaskPresetToParts({ parts, taskPreset: { ok: true, render: () => ({ ok: false, reason: 'preset_empty' }) } }), { ok: false, reason: 'preset_empty' });
});

test('agent config: preset mode swaps the request, keeps the agent token limit and falls back when the preset is gone', () => {
  const calls = [];
  setAgentTaskPresetSource({ resolve: (id, sessionId) => {
    calls.push([id, sessionId]);
    return id === 'p1' ? { ok: true, id, name: '分析用', sampling: { temperature: 0.9, top_p: 0.8 }, render: data => ({ ok: true, messages: [{ role: 'system', content: 'P' }, ...data] }) } : { ok: false };
  } });
  const request = { messages: [{ role: 'system', content: 'T' }, { role: 'user', content: 'D' }], sections: [{ source: '任务要求', editField: 'prompt' }],
    params: { temperature: 0.3, maxTokens: 600, tools: [] } };
  const parts = [{ part: 'task', role: 'system', content: 'T' }, { part: 'data', role: 'user', content: 'D', source: '数据' }];
  assert.equal(applyAgentConfigTaskPreset({ request, parts, config: { promptSource: 'prompt', presetId: 'p1' } }), request, '提示词模式原样返回');
  const used = applyAgentConfigTaskPreset({ request, parts, config: { promptSource: 'preset', presetId: 'p1' }, sessionId: 's1' });
  assert.deepEqual(used.messages, [{ role: 'system', content: 'P' }, { role: 'user', content: 'D' }]);
  assert.deepEqual(used.params, { maxTokens: 600, tools: [], temperature: 0.9, top_p: 0.8 });
  assert.deepEqual(used.promptSource, { mode: 'preset', presetId: 'p1' });
  assert.deepEqual(calls.at(-1), ['p1', 's1']);
  const gone = applyAgentConfigTaskPreset({ request, parts, config: { promptSource: 'preset', presetId: 'gone' } });
  assert.equal(gone.messages, request.messages);
  assert.deepEqual(gone.promptSource, { mode: 'prompt', fallback: 'preset_missing', presetId: 'gone' });
  setAgentTaskPresetSource(null);
  assert.deepEqual(applyAgentConfigTaskPreset({ request, parts, config: { promptSource: 'preset', presetId: 'p1' } }).promptSource, { mode: 'prompt', fallback: 'preset_missing', presetId: 'p1' }, '未装配时退回提示词');
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
