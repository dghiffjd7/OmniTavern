import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const {
  buildInjectionContext,
  buildSandboxVariables,
  collectConditionPaths,
  collectInjectionItems,
  evaluateInjectionItem,
  extractExpressionPaths,
  groupInjectionItemsByPath,
  parseHypotheticalValue,
} = await import('../../src/scripts/variables/injection-overview.js');

{
  assert.deepEqual(extractExpressionPaths('好感度 >= 60 && 角色.心情 == "开心" || vars.flag'), ['好感度', '角色.心情', 'flag']);
  assert.deepEqual(extractExpressionPaths('tags.includes("约会") && inventory.length > 2 && Math.max(a, 3) > 1'), ['tags', 'inventory', 'Math', 'a']);
  assert.deepEqual(extractExpressionPaths('true && name == "and"'), ['name']);
  assert.deepEqual(extractExpressionPaths('vars["好感度"] >= 60 && stat[\'心情\'] == "开心"'), ['好感度', 'stat.心情']);
  const tree = { logic: 'and', clauses: [{ left: '好感度', op: '>=', right: 60, rightType: 'number' }, { logic: 'not', clause: { left: { fn: 'add', args: [{ var: '金币' }, 1] }, op: '>', right: '上限', rightType: 'variable' } }] };
  assert.deepEqual(collectConditionPaths(tree), ['好感度', '金币', '上限']);
  console.log('ok - variable paths are read from expressions and condition trees');
}

const world = {
  entries: {
    0: { uid: 0, comment: '她', constant: true, promptMode: 'blocks', promptBlocks: [
      { id: 'b1', title: '告白', content: '她鼓起勇气告白。', when: { logic: 'and', clauses: [{ left: '好感度', op: '>=', right: 80, rightType: 'number' }] } },
      { id: 'b2', title: '日常', content: '日常相处。' },
      { id: 'b3', title: '停用', enabled: false, content: 'x', when: { logic: 'and', clauses: [{ left: '好感度', op: '>', right: 1, rightType: 'number' }] } },
    ] },
    1: { uid: 1, comment: '秘密', key: ['日记'], when: { logic: 'and', clauses: [{ left: '角色.信任', op: '>', right: 5, rightType: 'number' }] }, content: '她的日记里写着……' },
    2: { uid: 2, comment: '无条件', constant: true, content: '常驻' },
    3: { uid: 3, comment: '关掉的', disable: true, when: { logic: 'and', clauses: [{ left: 'x', op: '>', right: 1, rightType: 'number' }] }, content: 'y' },
  },
};
const rules = [
  { id: 'r1', name: '好感提示', enabled: true, trigger: { type: 'condition', expr: 'vars["好感度"] >= 60' }, action: { type: 'inject_prompt', prompt: '她很在意你（{{getvar::好感度}}）。' } },
  { id: 'r2', name: '关键词', enabled: true, trigger: { type: 'keyword', keywords: ['你好'] }, action: { type: 'inject_prompt', prompt: 'x' } },
  { id: 'r3', name: '停用', enabled: false, trigger: { type: 'condition', expr: '好感度 > 0' }, action: { type: 'set_value', target: 'a', value: 1 } },
];
const stageSchema = { currentStageVar: 'stage', stages: [
  { id: 'daily', name: '日常', condition: '', prompt: '日常阶段。' },
  { id: 'close', name: '亲密', condition: 'vars["好感度"] >= 80', prompt: '亲密阶段。' },
] };

{
  const items = collectInjectionItems({ worlds: [{ id: 'w', name: '设定', world }], rules, stageSchema });
  assert.deepEqual(items.map(item => item.id), ['world:w:0:b1', 'world:w:1', 'rule:r1', 'stage']);
  assert.equal(items[0].label, '设定 · 她 · 告白');
  assert.deepEqual([items[0].activation, items[1].activation], ['constant', 'keyword']);
  assert.deepEqual(items[3].paths, ['stage', '好感度']);
  const groups = groupInjectionItemsByPath(items);
  assert.deepEqual([...groups.keys()], ['好感度', '角色.信任', 'stage']);
  assert.deepEqual(groups.get('好感度').map(item => item.id), ['world:w:0:b1', 'rule:r1', 'stage']);
  console.log('ok - world blocks/entries with conditions, condition rules and stages are collected and grouped by variable');
}

{
  const items = collectInjectionItems({ worlds: [{ id: 'w', name: '设定', world }], rules, stageSchema });
  const localVars = { 好感度: 40, 角色: { 信任: 3 }, stage: 'daily' };
  const now = buildInjectionContext({ localVars, globalVars: {} });
  const statusNow = items.map(item => evaluateInjectionItem(item, { ctx: now }).status);
  assert.deepEqual(statusNow, ['miss', 'miss', 'miss', 'hit']);

  const sandbox = buildSandboxVariables({ localVars, globalVars: {}, overrides: { 好感度: 85, 'stat_data.角色.信任': 9 } });
  assert.equal(localVars.好感度, 40, 'real variables are never changed');
  assert.deepEqual(sandbox.localVars.角色, { 信任: 9 }, 'alias prefixes are stripped and nested paths are set');
  const then = buildInjectionContext(sandbox);
  const statusThen = items.map(item => evaluateInjectionItem(item, { ctx: then }));
  assert.deepEqual(statusThen.map(result => result.status), ['hit', 'keyword', 'hit', 'hit']);
  assert.deepEqual([statusThen[3].injected.name, statusThen[3].resolved.name], ['日常', '亲密'], 'the stage variable decides injection; conditions decide the next stage');

  const stageSwitched = evaluateInjectionItem(items[3], { ctx: buildInjectionContext(buildSandboxVariables({ localVars, overrides: { stage: 'close' } })) });
  assert.equal(stageSwitched.injected.name, '亲密');
  const broken = evaluateInjectionItem({ kind: 'rule', expr: '好感度 >= 60' }, { ctx: now });
  assert.equal(broken.status, 'error', 'bare Chinese names are a syntax error in rule expressions (the engine treats them as not met)');
  const missing = evaluateInjectionItem(items[1], { ctx: buildInjectionContext({ localVars: {} }) });
  assert.equal(missing.status, 'miss', 'a missing variable compares as not met');
  console.log('ok - items are evaluated against current and hypothetical values without touching real variables');
}

{
  const shared = buildSandboxVariables({ localVars: { a: 1 }, globalVars: { a: 2 }, shared: true, overrides: { a: 5, 'global_variables.b': 7 } });
  assert.deepEqual([shared.localVars.a, shared.globalVars.a, shared.globalVars.b], [1, 5, 7], 'shared sessions write hypothetical values to globals');
  const flat = buildSandboxVariables({ localVars: { 'a.b': 1 }, overrides: { 'a.b': 2 } });
  assert.deepEqual(flat.localVars, { 'a.b': 2 }, 'flat dotted keys are replaced in place');
  assert.equal(parseHypotheticalValue('12', 3), 12);
  assert.equal(parseHypotheticalValue('否', true), false);
  assert.deepEqual(parseHypotheticalValue('{"x":1}', {}), { x: 1 });
  assert.equal(parseHypotheticalValue('abc', 'x'), 'abc');
  assert.equal(parseHypotheticalValue('5', undefined), 5);
  console.log('ok - hypothetical values follow the current type and the shared-variable scope');
}

console.log('variable-injection-overview-tests passed');
