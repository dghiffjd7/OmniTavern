import assert from 'node:assert/strict';

import {
  buildLineageDiagnostics,
  buildLineageExportFile,
  findLineagePathBetween,
  renderLineageDiagnosticsHtml,
  renderLineageExportMenuHtml,
} from '../../src/scripts/ui/chat/lineage-map-diagnostics-utils.js';
import {
  buildLineageMapSceneModel,
  exportLineageGraphDot,
  exportLineageGraphMermaid,
  renderLineageMapDetailHtml,
  renderLineageMapDockHtml,
  renderLineageMapSceneHtml,
} from '../../src/scripts/ui/chat/lineage-graph-view-utils.js';
import { buildPersonaLineageTrace } from '../../src/scripts/ui/chat/persona-lineage-trace-utils.js';

const edge = (source, target, type = 'contains', status = 'active') => ({
  id: `e:${source}->${target}`, source, target, type, status, reason: 'default_enabled', sourceScopeId: 's', targetScopeId: 's',
});

const graph = {
  version: 1,
  scopeId: 's',
  mode: 'persona',
  rootId: 'persona:p',
  nodes: [
    { id: 'persona:p', type: 'persona_card', label: '卡', status: 'active', scopeId: 's', meta: {} },
    { id: 'contact:紫罗兰', type: 'contact', label: '紫罗兰', status: 'active', scopeId: 's', meta: {} },
    { id: 'contact:艾莉西亚', type: 'contact', label: '艾莉西亚', status: 'active', scopeId: 's', meta: {} },
    { id: 'worldbook:共用', type: 'worldbook', label: '全局世界书 "共用"', status: 'active', scopeId: 's', meta: { weight: 2, stat: '2 个会话使用' } },
    { id: 'memory:紫罗兰', type: 'memory_table', label: '记忆 · 紫罗兰', status: 'active', scopeId: 's', meta: { weight: 30, stat: '30 行 · 4 张表' } },
    { id: 'memory:艾莉西亚', type: 'memory_table', label: '记忆 · 艾莉西亚', status: 'active', scopeId: 's', meta: { weight: 2, stat: '2 行 · 1 张表' } },
  ],
  edges: [
    edge('persona:p', 'contact:紫罗兰'),
    edge('persona:p', 'contact:艾莉西亚'),
    edge('contact:紫罗兰', 'worldbook:共用', 'binds'),
    edge('contact:艾莉西亚', 'worldbook:共用', 'binds'),
    edge('contact:紫罗兰', 'memory:紫罗兰'),
    edge('contact:艾莉西亚', 'memory:艾莉西亚'),
  ],
};

{
  const forward = findLineagePathBetween(graph, 'persona:p', 'worldbook:共用');
  assert.equal(forward.direction, 'forward');
  assert.equal(forward.paths.length, 2);
  assert.deepEqual(forward.paths[0].nodeIds, ['persona:p', 'contact:紫罗兰', 'worldbook:共用']);
  assert.deepEqual(forward.paths[0].edgeIds, ['e:persona:p->contact:紫罗兰', 'e:contact:紫罗兰->worldbook:共用']);
  const reverse = findLineagePathBetween(graph, 'worldbook:共用', 'contact:艾莉西亚');
  assert.equal(reverse.direction, 'reverse');
  assert.deepEqual(reverse.paths[0].nodeIds, ['contact:艾莉西亚', 'worldbook:共用']);
  // 兄弟节点之间没有有向路径：给共同的上游与共同用到的资源
  const none = findLineagePathBetween(graph, 'contact:紫罗兰', 'contact:艾莉西亚');
  assert.equal(none.direction, 'none');
  assert.deepEqual(none.sharedDownstreamIds, ['worldbook:共用']);
  assert.deepEqual(none.sharedUpstreamIds, ['persona:p']);
  assert.equal(findLineagePathBetween(graph, 'contact:紫罗兰', 'contact:紫罗兰').direction, 'none');
  assert.equal(findLineagePathBetween(graph, 'contact:紫罗兰', 'missing').direction, 'none');
  console.log('ok - lineage path diagnostics finds forward, reverse and shared relations between two nodes');
}

{
  // 搜索量有上限：稠密图不会卡住
  const nodes = Array.from({ length: 40 }, (_, index) => ({ id: `n${index}`, type: 'rule', label: `n${index}`, status: 'active' }));
  const edges = [];
  for (let a = 0; a < 39; a += 1) for (let b = a + 1; b < 39; b += 1) edges.push(edge(`n${a}`, `n${b}`));
  const dense = { nodes, edges };
  const started = Date.now();
  const result = findLineagePathBetween(dense, 'n0', 'n39', { maxVisits: 500 });
  assert.equal(result.direction, 'none');
  assert.ok(Date.now() - started < 2000);
  console.log('ok - lineage path search stays bounded on dense graphs');
}

{
  const cyclic = {
    ...graph,
    edges: [...graph.edges, edge('worldbook:共用', 'contact:紫罗兰', 'triggers')],
  };
  const diagnostics = buildLineageDiagnostics(cyclic, { fromId: 'persona:p', toId: 'worldbook:共用' });
  assert.equal(diagnostics.cycles.length > 0, true);
  assert.ok(diagnostics.cycleNodeIds.has('worldbook:共用'));
  assert.ok(diagnostics.cycleNodeIds.has('contact:紫罗兰'));
  assert.ok(diagnostics.pathNodeIds.has('contact:紫罗兰'));
  assert.ok(diagnostics.pathEdgeIds.has('e:contact:紫罗兰->worldbook:共用'));
  const html = renderLineageDiagnosticsHtml(cyclic, diagnostics);
  assert.match(html, /路径诊断/);
  assert.match(html, /起点 → 终点可达/);
  assert.match(html, /循环关系 <b>1<\/b>/);
  assert.match(html, /data-lineage-jump-node-id="worldbook:共用"/);
  assert.match(html, /data-lineage-path-clear="1"/);
  const empty = renderLineageDiagnosticsHtml(graph, buildLineageDiagnostics(graph, {}));
  assert.match(empty, /没有发现循环关系/);
  assert.match(empty, /选好起点与终点/);
  const none = renderLineageDiagnosticsHtml(graph, buildLineageDiagnostics(graph, { fromId: 'contact:紫罗兰', toId: 'contact:艾莉西亚' }));
  assert.match(none, /没有直接的血缘路径/);
  assert.match(none, /两者都用到 <b>1<\/b>/);
  console.log('ok - lineage diagnostics card renders path verdicts and cycles');
}

{
  // 图上标出：同层分量最大的为重点；诊断的循环与路径；节点第二行显示数字
  const model = buildLineageMapSceneModel(graph, {
    expandedIds: ['memories', 'worldbooks'],
    pathNodeIds: ['contact:紫罗兰', 'worldbook:共用'],
    cycleNodeIds: ['memory:艾莉西亚'],
  });
  const item = id => model.nodes.find(node => node.nodeId === id && node.kind !== 'root');
  assert.ok(item('memory:紫罗兰').flags.includes('key'));
  assert.equal(item('memory:艾莉西亚').flags.includes('key'), false, 'weight below a quarter of the max is not key');
  assert.ok(item('memory:艾莉西亚').flags.includes('cycle'));
  assert.ok(item('worldbook:共用').flags.includes('path'));
  assert.equal(item('memory:紫罗兰').meta, '30 行 · 4 张表');
  const memoryCategory = model.nodes.find(node => node.id === 'category:memories');
  assert.equal(memoryCategory.meta, '重点 记忆 · 紫罗兰');
  assert.ok(memoryCategory.flags.includes('cycle'));
  // 同层按分量排：大的在前
  const memoryItems = model.nodes.filter(node => node.layerId === 'memories' && node.kind === 'item');
  assert.deepEqual(memoryItems.map(node => node.nodeId), ['memory:紫罗兰', 'memory:艾莉西亚']);
  const html = renderLineageMapSceneHtml(graph, { expandedIds: ['memories'], cycleNodeIds: ['memory:艾莉西亚'] });
  assert.match(html, /is-key[^"]*" data-lineage-node-id="memory:紫罗兰"/);
  assert.match(html, /lineage-node-flag is-key">重点/);
  assert.match(html, /lineage-node-flag is-cycle">循环/);
  console.log('ok - lineage map marks key nodes, diagnostics flags and node stats');
}

{
  // 新分层：创意写作、预设与正则、记忆与摘要、变量
  const { graph: persona } = buildPersonaLineageTrace({
    scopeId: 'card',
    persona: { id: 'card', name: '卡' },
    contacts: [{ id: 'a', name: 'A' }],
    creative: { sessionId: 'rp:card', label: '卡' },
    resolvePreset: () => ({ presetId: 'p1', name: '预设一', source: 'mode' }),
    regexSets: [{ id: 'r1', name: '正则一', bind: { type: 'preset', presetId: 'p1' }, rules: [{}] }],
    getSessionStats: sid => (sid === 'a' ? { summaryCount: 2, variableCount: 5 } : {}),
  });
  const dock = renderLineageMapDockHtml(persona);
  ['creative', 'presets', 'memories', 'variables'].forEach((id) => {
    assert.match(dock, new RegExp(`data-lineage-map-category="${id}"`), id);
  });
  assert.match(dock, /预设与正则/);
  assert.match(dock, /记忆与摘要/);
  const scene = renderLineageMapSceneHtml(persona, { expandedIds: ['presets'] });
  assert.match(scene, /is-layer-presets/);
  assert.match(scene, /data-lineage-node-id="regex:r1"/);
  console.log('ok - lineage map places creative, preset/regex, summary and variable nodes in their own layers');
}

{
  // 详情卡：数字、打开设置、设为起点／终点
  const node = graph.nodes.find(item => item.id === 'memory:紫罗兰');
  const html = renderLineageMapDetailHtml('node', { ...node, open: { kind: 'memory', room: null } }, graph, { pathFromId: 'memory:紫罗兰' });
  assert.match(html, /记忆表格 · 30 行 · 4 张表/);
  assert.match(html, /data-lineage-open-node="memory:紫罗兰">查看记忆表格/);
  assert.match(html, /data-lineage-path-role="from"[^>]*aria-pressed="true">已设为起点/);
  assert.match(html, /data-lineage-path-role="to"[^>]*aria-pressed="false">设为终点/);
  const plain = renderLineageMapDetailHtml('node', graph.nodes[1], graph);
  assert.doesNotMatch(plain, /data-lineage-open-node/);
  assert.match(plain, /data-lineage-path-role="from"/);
  const edgeHtml = renderLineageMapDetailHtml('edge', graph.edges[0], graph);
  assert.doesNotMatch(edgeHtml, /data-lineage-path-role/);
  console.log('ok - lineage detail card offers open-settings and path endpoint actions');
}

{
  // 导出：中文 id 在 DOT 里不撞在一起；Mermaid 用 <br/> 换行、引号转成 #quot;
  const dot = exportLineageGraphDot(graph);
  assert.match(dot, /"contact:紫罗兰" \[label=/);
  assert.match(dot, /"contact:艾莉西亚" \[label=/);
  assert.match(dot, /"contact:紫罗兰" -> "worldbook:共用"/);
  assert.match(dot, /label="全局世界书 \\"共用\\"\\n世界书\\n已启用"/);
  const mermaid = exportLineageGraphMermaid(graph);
  assert.match(mermaid, /\["全局世界书 #quot;共用#quot;<br\/>世界书"\]/);
  assert.doesNotMatch(mermaid, /\\n|\\"/);
  const ids = mermaid.split('\n').filter(line => /^\s+N_/.test(line) && line.includes('["')).map(line => line.trim().split('[')[0]);
  assert.equal(new Set(ids).size, graph.nodes.length);

  const file = buildLineageExportFile(graph, 'dot', { at: new Date(2026, 10, 2, 9, 5).getTime() });
  assert.equal(file.fileName, 'lineage-persona-20261102-0905.dot');
  assert.equal(file.extension, 'dot');
  assert.equal(file.text, dot);
  const mmd = buildLineageExportFile(graph, 'mermaid', { at: new Date(2026, 10, 2, 9, 5).getTime() });
  assert.equal(mmd.fileName, 'lineage-persona-20261102-0905.mmd');
  assert.equal(mmd.text, mermaid);
  const menu = renderLineageExportMenuHtml();
  ['copy-mermaid', 'copy-dot', 'save-mermaid', 'save-dot'].forEach(action => assert.match(menu, new RegExp(`data-lineage-export="${action}"`)));
  console.log('ok - lineage export keeps unicode ids distinct and builds file payloads');
}

{
  // 不同类型的分量单位不同：同层里按类型分组排序，各自挑重点
  const mixed = {
    ...graph,
    nodes: [
      graph.nodes[0],
      { id: 'preset:a', type: 'preset', label: '预设 A', status: 'active', meta: { weight: 6 } },
      { id: 'preset:b', type: 'preset', label: '预设 B', status: 'active', meta: { weight: 1 } },
      { id: 'regex:r', type: 'regex', label: '正则 R', status: 'active', meta: { weight: 21 } },
      { id: 'regex:s', type: 'regex', label: '正则 S', status: 'active', meta: { weight: 2 } },
    ],
    edges: ['preset:a', 'preset:b', 'regex:r', 'regex:s'].map(id => edge('persona:p', id)),
  };
  const model = buildLineageMapSceneModel(mixed, { expandedIds: ['presets'] });
  const items = model.nodes.filter(node => node.layerId === 'presets' && node.kind === 'item');
  assert.deepEqual(items.map(node => node.nodeId), ['preset:a', 'preset:b', 'regex:r', 'regex:s']);
  assert.deepEqual(items.filter(node => node.flags.includes('key')).map(node => node.nodeId), ['preset:a', 'regex:r']);
  assert.equal(model.nodes.find(node => node.id === 'category:presets').meta, '重点 预设 A');
  console.log('ok - lineage key nodes are ranked within each node type');
}
