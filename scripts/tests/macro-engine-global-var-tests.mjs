import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const { MacroEngine, stripPausedVariableMacros } = await import('../../src/scripts/utils/macro-engine.js');

const makeStore = () => {
  const local = new Map([['seed', '4']]);
  const global = new Map([['seed', '8']]);
  const writes = [];
  return {
    local,
    global,
    writes,
    getVariable: key => local.get(key),
    setVariable: (key, value) => { writes.push(['local', key, value]); local.set(key, value); },
    getGlobalVariable: key => global.get(key),
    setGlobalVariable: (key, value) => { writes.push(['global', key, value]); global.set(key, value); },
  };
};

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{setglobalvar::hp::10}}{{getglobalvar::hp}}|{{getvar::hp}}', { sessionId: 's1' });
  assert.equal(output, '10|', '聊天模式下显式全局宏应读写全局作用域，且不落入本地作用域');
  assert.deepEqual(store.writes, [['global', 'hp', '10']]);
  assert.equal(store.local.has('hp'), false);
  console.log('ok - 聊天模式显式全局宏写读全局作用域');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{setvar::hp::1}}{{setglobalvar::hp::2}}{{getvar::hp}}{{getglobalvar::hp}}', { sessionId: 's1' });
  assert.equal(output, '12', '同名变量的本地/全局作用域必须互不串扰');
  assert.deepEqual(store.writes, [['local', 'hp', '1'], ['global', 'hp', '2']]);
  console.log('ok - 同名变量本地/全局互不串扰');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{addglobalvar::seed::3}}{{getglobalvar::seed}}', { sessionId: 's1' });
  assert.equal(output, '11', 'addglobalvar 数值相加且自身输出为空');
  assert.equal(store.global.get('seed'), '11');
  console.log('ok - addglobalvar 数值相加');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{setglobalvar::tag::ab}}{{addglobalvar::tag::cd}}{{getglobalvar::tag}}', { sessionId: 's1' });
  assert.equal(output, 'abcd', 'addglobalvar 非数值时退化为字符串拼接（与 addvar 一致）');
  console.log('ok - addglobalvar 字符串拼接回退');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{incglobalvar::seed}}-{{decglobalvar::seed}}', { sessionId: 's1' });
  assert.equal(output, '9-8', 'incglobalvar/decglobalvar 与 incvar/decvar 一致：返回更新后的值');
  assert.equal(store.global.get('seed'), '8');
  assert.equal(store.local.get('seed'), '4', '本地同名变量不受影响');
  console.log('ok - incglobalvar/decglobalvar 返回更新值且不碰本地作用域');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{setglobalvar::g1::x}}{{getglobalvar::g1}}', {
    sessionId: 'rp:s1',
    uiMode: 'rp',
  });
  assert.equal(output, 'x');
  assert.deepEqual(store.writes, [['global', 'g1', 'x']], 'RP 模式下显式全局宏仍应只写全局作用域');
  console.log('ok - RP 模式显式全局宏语义不变');
}

{
  // 写作模式没开共享：getvar／setvar 读写这个聊天的变量（与世界书条件、EJS、脚本一致）；
  // 聊天里没有这个变量时退回读全局——旧版写作模式一律把 setvar 存在全局
  const store = makeStore();
  store.global.set('old', 'g');
  const engine = new MacroEngine(store);
  const output = engine.process('{{getvar::seed}}|{{getvar::old}}|{{setvar::hp::3}}{{getvar::hp}}', { sessionId: 'rp:s1', uiMode: 'rp' });
  assert.equal(output, '4|g|3');
  assert.deepEqual(store.writes, [['local', 'hp', '3']]);
  // 开了共享（调用方传 useGlobalVariables）：照旧读写全局
  const shared = makeStore();
  assert.equal(new MacroEngine(shared).process('{{getvar::seed}}{{setvar::hp::5}}', { sessionId: 'rp:s1', uiMode: 'rp', useGlobalVariables: true }), '8');
  assert.deepEqual(shared.writes, [['global', 'hp', '5']]);
  // 聊天模式不退回全局
  const chat = makeStore();
  chat.global.set('old', 'g');
  assert.equal(new MacroEngine(chat).process('[{{getvar::old}}]', { sessionId: 's1' }), '[]');
  console.log('ok - 写作模式变量宏按共享设定读写，聊天里没有时退回读全局');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{setglobalvar::p::5}}{{getglobalvar::p}}', {
    sessionId: 's1',
    macroVariableState: new Map(),
  });
  assert.equal(output, '5', '预览内全局宏连续写读应在模拟状态中保持语义');
  assert.deepEqual(store.writes, [], '预览全局宏不得写入真实变量存储');
  assert.equal(store.global.has('p'), false);
  console.log('ok - 全局宏预览隔离');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('A{{setglobalvar::x::1}}B{{getglobalvar::x}}C{{incglobalvar::x}}D{{decglobalvar::x}}E{{addglobalvar::x::2}}F', {
    sessionId: 's1',
    variableRuntimeEnabled: false,
  });
  assert.equal(output, 'ABCDEF', '变量运行时关闭时全局宏应被整体剥离');
  assert.deepEqual(store.writes, []);
  console.log('ok - 变量运行时关闭时剥离全局宏');
}

{
  assert.equal(stripPausedVariableMacros('A{{getglobalvar::x}}B{{ setglobalvar：：k：：v }}C'), 'ABC');
  console.log('ok - stripPausedVariableMacros 覆盖全局宏与全角冒号');
}

{
  const store = makeStore();
  const engine = new MacroEngine(store);
  const output = engine.process('{{setglobalvar：：k：：v}}{{getglobalvar：：k}}', { sessionId: 's1' });
  assert.equal(output, 'v', '全角冒号写法应被归一化处理');
  console.log('ok - 全局宏兼容全角冒号');
}
