import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { VertexAIProvider } = await import('../../src/scripts/api/providers/vertexai.js');
const { GeminiProvider } = await import('../../src/scripts/api/providers/gemini.js');
const { MakersuiteProvider } = await import('../../src/scripts/api/providers/makersuite.js');
const { GEMINI_SKIP_THOUGHT_SIGNATURE } = await import('../../src/scripts/api/providers/gemini-contents.js');

// 预设里写好的工具调用示范（小猫之神 SPreset）：assistant 的 tool_calls 与 tool 结果要变成 Gemini 的 functionCall／functionResponse，
// 不能变成空的模型回合与普通用户文字
const messages = [
  { role: 'system', content: '规则' },
  { role: 'user', content: '测试连通性' },
  { role: 'assistant', content: '<think>先调用工具</think>' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'soliumbra_reply', arguments: '{"game_content":"测试"}' } }] },
  { role: 'tool', tool_call_id: 'c1', name: 'soliumbra_reply', content: '连通成功！' },
  { role: 'user', content: '继续' },
  { role: 'assistant', content: '同时调用两个', tool_calls: [
    { id: 'c2', type: 'function', function: { name: 'context', arguments: '{}' } },
    { id: 'c3', type: 'function', function: { name: 'soliumbra_reply', arguments: 'not json' }, thoughtSignature: 'sig-from-model' },
  ] },
  { role: 'tool', tool_call_id: 'c2', content: '原文' },
  { role: 'tool', tool_call_id: 'c3', content: [{ type: 'text', text: '好' }] },
];

for (const [name, Provider] of [['vertexai', VertexAIProvider], ['gemini', GeminiProvider], ['makersuite', MakersuiteProvider]]) {
  const provider = new Provider({ apiKey: 'k', model: 'gemini-test', baseUrl: 'https://example.com', projectId: 'p', region: 'us-central1' });
  const { contents, systemInstruction } = provider.convertMessages(messages);
  assert.equal(systemInstruction, '规则', name);
  assert.deepEqual(contents.map(c => c.role), ['user', 'model', 'model', 'user', 'user', 'model', 'user'], name);
  assert.deepEqual(contents[2].parts, [{
    functionCall: { name: 'soliumbra_reply', args: { game_content: '测试' } },
    thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE,
  }], `${name}: a scripted call keeps its name and arguments`);
  assert.deepEqual(contents[3].parts, [{ functionResponse: { name: 'soliumbra_reply', response: { name: 'soliumbra_reply', content: '连通成功！' } } }], name);
  assert.deepEqual(contents[5].parts[0], { text: '同时调用两个' }, `${name}: text before the calls stays in the same model turn`);
  assert.deepEqual(contents[5].parts.slice(1).map(p => [p.functionCall.name, p.functionCall.args, p.thoughtSignature]), [
    ['context', {}, GEMINI_SKIP_THOUGHT_SIGNATURE],
    ['soliumbra_reply', {}, 'sig-from-model'],
  ], `${name}: unparseable arguments become an empty object and model signatures are kept`);
  assert.deepEqual(contents[6].parts.map(p => [p.functionResponse.name, p.functionResponse.response.content]), [
    ['context', '原文'], ['soliumbra_reply', '好'],
  ], `${name}: consecutive results share one turn and names come from the call ids`);
}
console.log('ok - Gemini providers send scripted tool calls and results as functionCall and functionResponse');

// 预设脚本把内容都搬进工具说明、只剩 system 时（Dream 的 Kei_Workflow），contents 不能是空的（Vertex 会 400）：
// 跟酒馆一样至少留一条消息不移进系统指令，最后一条当 user 回合送出
for (const [name, Provider] of [['vertexai', VertexAIProvider], ['gemini', GeminiProvider], ['makersuite', MakersuiteProvider]]) {
  const provider = new Provider({ apiKey: 'k', model: 'gemini-test', baseUrl: 'https://example.com', projectId: 'p', region: 'us-central1' });
  const onlySystem = provider.convertMessages([{ role: 'system', content: '甲' }, { role: 'system', content: '乙' }]);
  assert.equal(onlySystem.systemInstruction, '甲', name);
  assert.deepEqual(onlySystem.contents, [{ role: 'user', parts: [{ text: '乙' }] }], `${name}: the last system message stays in contents`);
  const mixed = provider.convertMessages([{ role: 'system', content: '甲' }, { role: 'user', content: '你好' }, { role: 'system', content: '乙' }]);
  assert.equal(mixed.systemInstruction, '甲\n\n乙', `${name}: with a user turn present, system messages still go to systemInstruction`);
  assert.deepEqual(mixed.contents, [{ role: 'user', parts: [{ text: '你好' }] }], name);
}
console.log('ok - Gemini providers keep the last system message in contents when nothing else is left');
console.log('gemini-tool-history-tests passed');
