import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { MacroEngine } = await import('../../src/scripts/utils/macro-engine.js');

const messages = [
  { id: 'record-user-a', role: 'user', raw: 'hello' },
  { id: 'record-system-b', role: 'system', raw: 'note' },
  { id: 'record-assistant-c', role: 'assistant', raw: 'world' },
];
const engine = new MacroEngine({ getMessages: () => messages });

assert.equal(
  engine.process('{{lastMessageId}}|{{lastUserMessageId}}|{{lastCharMessageId}}|{{lastMessage}}', { sessionId: 's1' }),
  '2|0|2|world',
  'ST 的 MessageId 宏必须返回 0-based 聊天楼层索引，不能泄漏 App 数据库消息 id',
);

assert.equal(
  new MacroEngine({ getMessages: () => [] }).process('[{{lastMessageId}}]', { sessionId: 's1' }),
  '[]',
  '空聊天没有最后楼层时应替换为空字符串',
);

const variableEngine = new MacroEngine({
  getVariable: key => (key === 'known' ? 'local-value' : undefined),
  getGlobalVariable: key => (key === 'known' ? 'global-value' : undefined),
});
assert.equal(
  variableEngine.process(
    '{{getvar::missing::42}}|{{getglobalvar::missing::84}}|{{var::known}}',
    { sessionId: 's1' },
  ),
  '42|84|local-value',
  'getvar fallback 与 slash 既有 var 别名必须可达共享宏核心',
);

console.log('ok - MacroEngine 使用 ST 的 0-based 楼层索引语义');

{
  // ST 的 {{roll}} 与旧写法 {{random:A,B}}；固定 Math.random 让结果可预期
  const realRandom = Math.random;
  const diceEngine = new MacroEngine({ getMessages: () => [] });
  const run = (text, value) => {
    Math.random = () => value;
    try { return diceEngine.process(text, { sessionId: 's1' }); } finally { Math.random = realRandom; }
  };
  assert.equal(run('o{{roll 1d999999}}go{{roll 1d999999}}k', 0), 'o1go1k', '预设里的 {{roll 1d999999}} 要掷出数字');
  assert.equal(run('{{roll 1d999999}}', 0.999999999), '999999');
  assert.equal(run('{{roll:6}}|{{ROLL:2d6+3}}|{{roll:d20-1}}', 0), '1|5|0', '冒号写法、只写数字视为 1dN、加减修正');
  assert.equal(run('[{{roll:abc}}][{{roll:0d6}}]', 0), '[][]', '公式无效时与 ST 一样替换为空');
  assert.equal(run('{{random:A,B,C}}|{{random: 甲, 乙 }}', 0.99), 'C|乙', '逗号分隔、去掉两侧空白');
  assert.equal(run('{{random:a\\,b,c}}', 0), 'a,b', '\\, 表示字面逗号');
  assert.equal(run('{{random::X::Y}}|{{dice::2d6}}|{{dice::oops}}', 0), 'X|2|oops', '既有 random:: 与 dice:: 行为不变');
  console.log('ok - MacroEngine 支持 ST 的 {{roll}} 与 {{random:A,B}}');
}

{
  // {{// 注释}} 里夹着宏（如 {{user}}）时整段去掉，不能在第一个 }} 就结束、让后半段漏进提示词
  const commentEngine = new MacroEngine({ getMessages: () => [] });
  const run = text => commentEngine.process(text, { sessionId: 's1', user: '阿兰' });
  assert.equal(run('{{// 普通注释 }}A'), 'A');
  assert.equal(run('{{// 把“{{user}}”改掉\n只改{{user}}的部分\n}}\n|用户：{{user}}|'), '\n|用户：阿兰|');
  assert.equal(run('前{{// a {{getvar::x}} {{// 里层 }} b }}后'), '前后', 'nested comments and macros stay inside the comment');
  assert.equal(run('{{// 落单的 {{ 括号 }}B'), 'B', 'an unmatched {{ falls back to ending at the first }}');
  assert.equal(run('{{// 没有闭合'), '{{// 没有闭合', 'an unclosed comment is left as is');
  console.log('ok - MacroEngine 去掉含嵌套宏的注释，不外漏');
}

{
  // 酒馆新宏引擎：宏可以嵌套，内层先算（Dream 预设的 {{setvar::名称::…{{getvar}}…{{random}}…}}）。
  // 外层不能在第一个内层 }} 就结束，否则变量只存到半截、后半段漏进提示词
  const vars = new Map([['状态', '经期'], ['Bob_mood', '开心']]);
  const nestedEngine = new MacroEngine({
    getMessages: () => [],
    getVariable: key => vars.get(key),
    setVariable: (key, value) => { vars.set(key, value); },
  });
  const run = text => nestedEngine.process(text, { sessionId: 's1', user: '阿兰', char: 'Bob' });
  assert.equal(run('{{setvar::事件::参考 {{getvar::状态}} 与 {{getvar::影响}}）】做出反应}}正文'), '正文');
  assert.equal(vars.get('事件'), '参考 经期 与 ）】做出反应', 'inner getvar resolves before the outer setvar stores the value');
  assert.equal(run('{{setvar::选项::1. {{random::甲::甲}}\n2. {{random::乙::乙}}\n}}后'), '后');
  assert.equal(vars.get('选项'), '1. 甲\n2. 乙\n', 'multi-line value with nested random');
  assert.equal(run('{{setvar::名字::{{user}}}}[{{getvar::名字}}]'), '[]', 'a setvar waiting on inner macros does not leak');
  assert.equal(vars.get('名字'), '阿兰');
  assert.equal(run('{{getvar::{{char}}_mood}}'), '开心', 'inner macro in a variable name (ST docs example)');
  assert.equal(run('{{ {{user}}'), '{{ 阿兰', 'a stray {{ no longer hides the macro after it');
  assert.equal(run('{{setvar::json::{"a":1}}}'), '}', 'single braces in a value keep the old matching');
  // Dream「正文工作」：多行值里只嵌 getvar，内层在变量宏那步就算完，通用宏一轮没匹配也要再跑一轮外层
  assert.equal(run('{{setvar::正文工作模式::<正文要求>- 正文工作:\n状态:{{getvar::状态}}\n{{getvar::缺}}</正文要求>}}正文'), '正文');
  assert.equal(vars.get('正文工作模式'), '<正文要求>- 正文工作:\n状态:经期\n</正文要求>', 'multi-line value with only nested getvar');
  console.log('ok - MacroEngine 嵌套宏内层先算，外层变量宏完整匹配');
}
