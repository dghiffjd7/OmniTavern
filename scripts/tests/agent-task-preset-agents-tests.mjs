import assert from 'node:assert/strict';

import { setAgentTaskPresetSource } from '../../src/scripts/ui/chat/agent-task-preset.js';
import { buildTextEditRequest, buildAgentNoteRequest, buildConfigurableInputParts } from '../../src/scripts/agent/agent-request-builder.js';
import { buildInputAgentRequest } from '../../src/scripts/agent/input-agent-runtime.js';
import { buildChatFormatGuardianModelPrompt } from '../../src/scripts/ui/chat/chat-format-guardian-utils.js';
import { createAgentModelRequest } from '../../src/scripts/agent/agent-model-request.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// 第二阶段：直接发请求的 Agent 套用预设（任务由预设代替；补丁类仍由程序附加返回格式）。
const presetRenders = [];
setAgentTaskPresetSource({
  resolve: (id, sessionId) => (id === 'p1' ? {
    ok: true, id, name: '任务预设',
    sampling: { temperature: 0.9, top_p: 0.7 },
    render: data => { presetRenders.push(sessionId); return { ok: true, messages: [{ role: 'system', content: '预设条目' }, ...data] }; },
  } : { ok: false }),
});

const preset = { promptSource: 'preset', presetId: 'p1' };
const target = { text: '第一行\n第二行' };

test('text edit keeps the patch contract with the current baseRevision after the preset', () => {
  const request = buildTextEditRequest({ config: { ...preset, prompt: '用户任务', blocks: [{ text: '区块', enabled: true }], maxTokens: 900 }, target, referenceContext: { text: '参考' }, baseRevision: 'rev-123' });
  assert.deepEqual(request.messages.map(m => m.role), ['system', 'user', 'user', 'system']);
  assert.equal(request.messages[0].content, '预设条目');
  assert.match(request.messages[1].content, /参考/);
  assert.match(request.messages[2].content, /"target":"第一行\\n第二行"/);
  assert.match(request.messages[3].content, /format_patch\.v1/);
  assert.match(request.messages[3].content, /"baseRevision":"rev-123"/);
  assert.equal(JSON.stringify(request.messages).includes('用户任务'), false);
  assert.equal(JSON.stringify(request.messages).includes('区块'), false);
  assert.deepEqual(request.params, { maxTokens: 900, tools: [], toolChoice: 'none', temperature: 0.9, top_p: 0.7 });
  assert.equal(request.baseRevision, 'rev-123');
  assert.deepEqual(request.promptSource, { mode: 'preset', presetId: 'p1' });
});

test('note mode drops the readable-answer contract and prompt mode stays untouched', () => {
  const note = buildAgentNoteRequest({ config: { ...preset, prompt: '用户任务' }, target, referenceContext: { text: '' } });
  assert.deepEqual(note.messages, [{ role: 'system', content: '预设条目' }, { role: 'user', content: '第一行\n第二行' }]);
  const plain = buildAgentNoteRequest({ config: { prompt: '用户任务' }, target, referenceContext: { text: '' } });
  assert.equal(plain.messages[0].content, '用户任务');
  assert.equal(plain.promptSource, undefined);
});

test('input agent: suggestion and note use the preset; rewrite keeps the patch contract', () => {
  const snapshot = { text: '前文后文', start: 2, end: 2 };
  const suggestion = buildInputAgentRequest({ ...preset, kind: 'input_suggestion', prompt: 'x', maxTokens: 96 }, snapshot, { text: '' });
  assert.equal(suggestion.messages[0].content, '预设条目');
  assert.equal(suggestion.messages.at(-1).content, JSON.stringify({ before: '前文', after: '后文' }));
  assert.equal(suggestion.params.temperature, 0.9);
  const note = buildInputAgentRequest({ ...preset, kind: 'input_agent', inputOutput: 'note', prompt: 'x', maxTokens: 300 }, { text: '草稿', start: 0, end: 0 }, { text: '' });
  assert.deepEqual(note.messages, [{ role: 'system', content: '预设条目' }, { role: 'user', content: '草稿' }]);
  const rewrite = buildInputAgentRequest({ ...preset, kind: 'input_agent', inputOutput: 'rewrite', prompt: 'x', maxTokens: 300 }, { text: '草稿', start: 0, end: 0 }, { text: '' });
  assert.match(rewrite.messages.at(-1).content, /format_patch\.v1/);
  assert.equal(rewrite.target.text, '草稿');
});

test('input suggestion parts mark the cursor text as data', () => {
  const parts = buildConfigurableInputParts({ before: 'ab', after: 'cd', settings: { prompt: '' }, referenceContext: { text: 'r' } });
  assert.deepEqual(parts.map(p => p.part), ['task', 'data', 'data']);
});

test('format repair: the preset replaces the task, protocol and scene rules stay, revision kept', () => {
  const base = { assistantText: '<msg>坏掉的</msg>', baseRevision: 'rev-9', referenceContext: { text: '参考' }, repairTarget: { sessionId: 's9' } };
  const normal = buildChatFormatGuardianModelPrompt({ ...base, agentConfig: { prompt: '用户格式任务', blocks: [{ text: '区块', enabled: true }] } });
  const withPreset = buildChatFormatGuardianModelPrompt({ ...base, agentConfig: { ...preset, prompt: '用户格式任务', blocks: [{ text: '区块', enabled: true }] } });
  const all = JSON.stringify(withPreset.messages);
  assert.equal(withPreset.messages[0].content, '预设条目');
  assert.equal(all.includes('用户格式任务'), false);
  assert.equal(all.includes('区块'), false);
  assert.match(all, /rev-9/);
  // 返回协议（系统部分）在最后，且不含内置任务说明
  const protocolMessage = withPreset.messages.at(-1);
  assert.equal(protocolMessage.role, 'system');
  assert.equal(protocolMessage.content.includes(normal.messages[0].content.split('\n')[2]), true, '协议行保留');
  assert.equal(protocolMessage.content.includes(normal.messages[0].content.split('\n')[1]), false, '内置任务首行不在');
  assert.ok(protocolMessage.content.length < normal.messages[0].content.length, '内置任务说明不在协议里');
  assert.equal(withPreset.responseFormat, 'json_object');
  assert.deepEqual(withPreset.promptSource, { mode: 'preset', presetId: 'p1' });
  assert.equal(presetRenders.at(-1), 's9', '按被修复会话解析');
  // 预设已删除：完整走原来的提示词
  const gone = buildChatFormatGuardianModelPrompt({ ...base, agentConfig: { promptSource: 'preset', presetId: 'gone', prompt: '用户格式任务' } });
  assert.equal(JSON.stringify(gone.messages).includes('用户格式任务'), true);
  assert.equal(gone.messages[0].content, normal.messages[0].content);
  assert.deepEqual(gone.promptSource, { mode: 'prompt', fallback: 'preset_missing', presetId: 'gone' });
});

test('format repair model request takes sampling from the preset, keeps its token limit', async () => {
  const sent = [];
  const request = createAgentModelRequest({
    config: { id: 'reply_check', ...preset, maxTokens: 1200, reasoningMode: 'default' },
    requestContext: { sessionId: 's1' },
    resolveModel: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
    createClient: () => ({ chat: async (messages, params) => { sent.push(params); return 'ok'; } }),
  });
  await request.chat([{ role: 'user', content: 'x' }], { temperature: 0, maxTokens: 1200, presetContext: { sessionId: 's1' } });
  assert.equal(sent[0].temperature, 0.9);
  assert.equal(sent[0].top_p, 0.7);
  assert.equal(sent[0].maxTokens, 1200);
  const plain = createAgentModelRequest({
    config: { id: 'reply_check', maxTokens: 1200 },
    resolveModel: async () => ({ provider: 'openai', model: 'gpt-4o-mini' }),
    createClient: () => ({ chat: async (messages, params) => { sent.push(params); return 'ok'; } }),
  });
  await plain.chat([{ role: 'user', content: 'x' }], { temperature: 0, maxTokens: 1200 });
  assert.equal(sent[1].temperature, 0);
  assert.equal('top_p' in sent[1], false);
});

for (const { name, fn } of tests) {
  await fn();
  console.log(`ok - ${name}`);
}
setAgentTaskPresetSource(null);
