import assert from 'node:assert/strict';
import { createInputSuggestionRuntime, createInputSuggestionRequest, buildInputSuggestionMessages, splitInputSuggestionCharacters } from '../../src/scripts/ui/chat/input-suggestion-runtime.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 15));
const state = { active: true, contextKey: 'role-a:chat:a', before: '今天想去', after: '', settings: { enabled: false, modelMode: 'profile', modelProfileId: 'cheap' } };
let calls = 0, shown = '', pending, lastSignal;
let respond = async () => '公园散步。';
const runtime = createInputSuggestionRuntime({
  getSnapshot: () => ({ ...state }), delayMs: 1,
  request: async (snapshot, signal) => { calls++; lastSignal = signal; return respond(snapshot, signal); },
  onSuggestion: text => { shown = text; },
});
runtime.schedule(); await tick();
assert.equal(calls, 0, '默认关闭时零请求');
state.settings.enabled = true; state.settings.modelMode = 'follow_current';
runtime.schedule(); await tick(); assert.equal(calls, 0, '输入建议需要显式配置独立模型');
state.settings.modelMode = 'profile';
runtime.schedule(); runtime.schedule(); await tick();
assert.equal(calls, 1, '同一输入停顿只触发一次');
assert.equal(shown, '公园散步。');
assert.equal(runtime.take(), '公园散步。');
assert.equal(shown, '');
respond = () => new Promise(resolve => { pending = resolve; });
runtime.schedule(); await tick();
assert.equal(calls, 2);
state.before += '朋友家'; runtime.cancel();
assert.equal(lastSignal.aborted, true);
pending('过期建议'); await tick(); assert.equal(shown, '', '取消后迟到结果不能显示');
respond = async () => '聊聊天。';
runtime.schedule(); await tick();
state.contextKey = 'role-b:writing:b';
assert.equal(runtime.take(), '', '切换会话或角色后不能采纳旧建议');
runtime.dispose();

const visibleCharacters = ['中', '👩🏽‍💻', '🇹🇼', 'e\u0301', '\r\n', '文'];
assert.deepEqual(splitInputSuggestionCharacters(visibleCharacters.join('')), visibleCharacters);
assert.deepEqual(splitInputSuggestionCharacters(visibleCharacters.join(''), null), visibleCharacters, '旧 WebView 回退保持常见组合字符完整');
const partialState = { ...state, before: '今天想去', after: '，晚上回来。' };
let partialCalls = 0;
const partial = createInputSuggestionRuntime({
  getSnapshot: () => ({ ...partialState }), delayMs: 1,
  request: async () => { partialCalls++; return '公园👩🏽‍💻散步。'; },
});
partial.schedule(); await tick();
assert.equal(partial.peek(), '公园👩🏽‍💻散步。');
assert.equal(partial.commit(0, () => assert.fail('零字选择不能写入')), false);
assert.equal(partial.commit(2, text => { partialState.before += text; }), true);
assert.equal(partialState.before, '今天想去公园');
assert.equal(partialState.after, '，晚上回来。');
assert.equal(partial.peek(), '👩🏽‍💻散步。', '部分采纳后的剩余建议绑定到新光标');
partial.commit(1, text => { partialState.before += text; });
assert.equal(partialState.before, '今天想去公园👩🏽‍💻');
assert.equal(partial.peek(), '散步。');
assert.equal(partialCalls, 1, '逐字采纳复用现有建议，不重新请求');
partialState.contextKey = 'another-chat';
assert.equal(partial.commit(1, () => assert.fail('过期建议不能写入')), false);
partial.schedule(); await tick();
partial.commit(1, text => { partialState.before += text; partialState.after = '外部改动'; });
assert.equal(partial.peek(), '', '写入监听改变前后文后不续用剩余建议');
partial.schedule(); await tick();
partial.commit(1, text => { partialState.before += text; partial.cancel(); });
assert.equal(partial.peek(), '', '写入期间发生取消后不恢复建议');
partial.dispose();

let count = 0, status = '';
const limited = createInputSuggestionRuntime({ getSnapshot: () => state, request: async () => { count++; return '新的建议'; }, maxPerMinute: 2, delayMs: 1 });
for (let i = 0; i < 3; i++) { state.before += '字'; limited.schedule(); await tick(); }
assert.equal(count, 2, '每分钟请求上限'); limited.dispose();
count = 0;
const failed = createInputSuggestionRuntime({ getSnapshot: () => state, request: async () => { count++; throw new Error('unavailable'); }, onStatus: value => { status = value; }, delayMs: 1 });
for (let i = 0; i < 4; i++) { state.before += '字'; failed.schedule(); await tick(); }
assert.equal(count, 3); assert.equal(status, 'paused');
failed.reset(); failed.schedule(); await tick();
assert.equal(count, 4, '更新模型配置后可重新尝试'); failed.dispose();

let sent;
const request = createInputSuggestionRequest({
  getProfileConfig: async id => { assert.equal(id, 'cheap'); return { model: 'saved-model', provider: 'custom' }; },
  createClient: config => ({ chat: async (messages, options) => { sent = { config, messages, options }; return '后续'; } }),
});
const controller = new AbortController();
await request({ ...state, settings: { ...state.settings, modelOverride: 'small-model' } }, controller.signal);
assert.equal(sent.config.model, 'small-model');
assert.equal(sent.options.maxTokens, 96);
assert.equal(sent.options.signal, controller.signal);
assert.deepEqual(sent.options.tools, []);
assert.deepEqual(JSON.parse(sent.messages[1].content), { before: state.before, after: state.after });
assert.equal(buildInputSuggestionMessages({ before: 'a'.repeat(3000), after: 'b'.repeat(1000) })[1].content.length < 3100, true);
console.log('ok - input suggestions: model gate, debounce/cancellation, limits, bounded request, graphemes and partial acceptance');
