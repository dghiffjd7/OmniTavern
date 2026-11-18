import assert from 'node:assert/strict';

import {
  buildVariableListRows,
  buildVariableScopeImpactText,
  buildVariableTree,
  formatVariableScopeLabel,
  getSortedVariableTreeChildren,
  getVariableRenderSlice,
  inferVariableValueType,
  isVariableValueFilled,
  readVariablePathValue,
  removeVariablePathValue,
  resolveNextEnumValue,
  resolveVariablePanelScope,
  resolveVariablePath,
  variableTreeNodeMatches,
  writeVariablePathValue,
} from '../../src/scripts/ui/variable-panel-state-utils.js';

{
  assert.deepEqual(
    resolveVariablePanelScope({
      sessionId: ' chat:alice ',
      getVariableScope: sid => (sid === 'chat:alice' ? 'global' : 'session'),
    }),
    { sid: 'chat:alice', scope: 'global' },
  );
  assert.deepEqual(
    resolveVariablePanelScope({ sessionId: '', getVariableScope: () => 'bad' }),
    { sid: '', scope: 'session' },
  );
  assert.equal(formatVariableScopeLabel({ scope: 'global' }), '全局变量（所有会话共享）');
  assert.match(
    buildVariableScopeImpactText({ scope: 'session', sessionId: 's1', action: 'delete' }),
    /删除后相关提示词/,
  );
  assert.match(
    buildVariableScopeImpactText({ scope: 'session', sessionId: 's1', action: 'edit' }),
    /当前值会即时写入/,
  );
  console.log('ok - variable panel state resolves scope and impact text');
}

{
  assert.equal(inferVariableValueType(12), 'number');
  assert.equal(inferVariableValueType(false), 'boolean');
  assert.equal(inferVariableValueType([]), 'array');
  assert.equal(inferVariableValueType({ met: true }), 'object');
  assert.equal(inferVariableValueType(null), 'string');
  assert.equal(isVariableValueFilled(undefined), false);
  assert.equal(isVariableValueFilled(null), false);
  assert.equal(isVariableValueFilled('   '), false);
  assert.equal(isVariableValueFilled(0), true);
  assert.equal(isVariableValueFilled(false), true);
  assert.equal(isVariableValueFilled([]), true);
  assert.equal(isVariableValueFilled({}), true);

  const vars = {
    zeta: '',
    alpha: 0,
    beta: false,
    gamma: 'ready',
  };
  const schemas = {
    alpha: { type: 'number' },
    gamma: { type: 'string' },
  };
  assert.deepEqual(
    buildVariableListRows({ vars, schemas }).map(row => row.key),
    ['alpha', 'beta', 'gamma', 'zeta'],
  );
  assert.deepEqual(
    buildVariableListRows({ vars, schemas, filter: 'filled' }).map(row => row.key),
    ['alpha', 'beta', 'gamma'],
  );
  assert.deepEqual(
    buildVariableListRows({ vars, schemas, filter: 'empty' }).map(row => row.key),
    ['zeta'],
  );
  assert.deepEqual(
    buildVariableListRows({ vars, schemas, term: 'READY' }).map(row => row.key),
    ['gamma'],
  );
  assert.deepEqual(
    buildVariableListRows({
      vars,
      schemas,
      sort: 'updated',
      updatedAtByKey: { alpha: 2, beta: 7, gamma: 4, zeta: 1 },
    }).map(row => row.key),
    ['beta', 'gamma', 'alpha', 'zeta'],
  );
  console.log('ok - variable panel state filters searches and sorts without losing falsey values');
}

{
  const tree = buildVariableTree({
    'player.stats.hp': 12,
    'player.stats.mp': 8,
    inventory: [{ name: '木剑' }],
  });
  const roots = getSortedVariableTreeChildren(tree);
  assert.deepEqual(roots.map(node => node.name), ['inventory', 'player']);
  const player = roots[1];
  assert.equal(variableTreeNodeMatches(player, 'hp'), true);
  assert.equal(variableTreeNodeMatches(player, '木剑'), false);
  const inventory = roots[0];
  assert.equal(variableTreeNodeMatches(inventory, '木剑'), true);
  assert.equal(inventory.children.get('[0]').children.get('name').value, '木剑');
  console.log('ok - variable panel state builds searchable deep trees');
}

{
  const rows = Array.from({ length: 215 }, (_, index) => ({ key: `v${index}` }));
  assert.deepEqual(
    getVariableRenderSlice({ rows, limit: 80, batchSize: 80 }),
    {
      rows: rows.slice(0, 80),
      rendered: 80,
      total: 215,
      hasMore: true,
      nextLimit: 160,
      canCollapse: false,
    },
  );
  assert.equal(getVariableRenderSlice({ rows, limit: 160 }).canCollapse, true, 'loaded past the first batch can fold back');
  assert.equal(getVariableRenderSlice({ rows, limit: 240 }).hasMore, false);
  assert.equal(getVariableRenderSlice({ rows, limit: 240 }).canCollapse, true);
  assert.equal(getVariableRenderSlice({ rows: rows.slice(0, 50), limit: 160 }).canCollapse, false, 'a short list never shows the fold button');
  assert.equal(resolveNextEnumValue('熟悉', ['陌生', '熟悉', '朋友']), '朋友');
  assert.equal(resolveNextEnumValue('朋友', ['陌生', '熟悉', '朋友']), '陌生');
  assert.equal(resolveNextEnumValue('', []), '');
  console.log('ok - variable panel state caps large lists and cycles enum values');
}

{
  const vars = {
    hp: 1,
    stat_data: { 角色: { 好感度: 3 }, 背包: [{ name: '木剑' }, { name: '盾' }] },
    'player.stats': { mp: 8 },
    cfg: { 'a.b': { c: 1 } },
  };
  assert.deepEqual(resolveVariablePath(vars, 'hp'), { rootKey: 'hp', segments: [] });
  assert.deepEqual(resolveVariablePath(vars, ' stat_data.角色.好感度 '), {
    rootKey: 'stat_data',
    segments: ['角色', '好感度'],
  });
  assert.deepEqual(resolveVariablePath(vars, 'stat_data.背包[1].name'), {
    rootKey: 'stat_data',
    segments: ['背包', 1, 'name'],
  });
  assert.deepEqual(resolveVariablePath(vars, 'player.stats.mp'), { rootKey: 'player.stats', segments: ['mp'] });
  assert.deepEqual(resolveVariablePath(vars, 'cfg.a.b.c'), { rootKey: 'cfg', segments: ['a.b', 'c'] });
  assert.equal(resolveVariablePath(vars, 'stat_data.角色.不存在'), null);
  assert.equal(resolveVariablePath(vars, 'stat_data.背包[5]'), null);
  assert.equal(resolveVariablePath(vars, 'nope'), null);
  assert.equal(resolveVariablePath(vars, ''), null);
  assert.deepEqual(
    resolveVariablePath({ ...vars, 'stat_data.角色.好感度': 99 }, 'stat_data.角色.好感度'),
    { rootKey: 'stat_data.角色.好感度', segments: [] },
  );
  assert.equal(readVariablePathValue(vars, { rootKey: 'stat_data', segments: ['背包', 0, 'name'] }), '木剑');
  assert.equal(readVariablePathValue(vars, { rootKey: 'hp', segments: [] }), 1);
  console.log('ok - variable panel state resolves tree paths back to top-level variables');
}

{
  const root = { 角色: { 好感度: 3 }, 背包: ['木剑', '盾'] };
  const written = writeVariablePathValue(root, ['角色', '好感度'], 99);
  assert.deepEqual(written, { 角色: { 好感度: 99 }, 背包: ['木剑', '盾'] });
  assert.equal(root.角色.好感度, 3, 'source value stays untouched');
  const removedKey = removeVariablePathValue(root, ['角色', '好感度']);
  assert.deepEqual(removedKey, { 角色: {}, 背包: ['木剑', '盾'] });
  const removedItem = removeVariablePathValue(root, ['背包', 0]);
  assert.deepEqual(removedItem, { 角色: { 好感度: 3 }, 背包: ['盾'] });
  assert.deepEqual(
    writeVariablePathValue(removedItem, ['背包', 0], '木剑', { insert: true }),
    root,
    'undo re-inserts a removed array item at its index',
  );
  assert.deepEqual(writeVariablePathValue(removedKey, ['角色', '好感度'], 3), root);
  assert.equal(root.背包.length, 2);
  console.log('ok - variable panel state writes and removes nested values without mutating the source');
}
