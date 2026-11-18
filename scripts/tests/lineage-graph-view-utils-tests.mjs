import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import {
  buildLineageImpactNodes,
  buildLineageMapMiniViewport,
  buildLineageMapSceneModelWithElk,
  buildLineageMapSceneModel,
  buildLineageGraphViewModel,
  centerLineageMapCamera,
  detectLineageCycles,
  exportLineageGraphDot,
  exportLineageGraphMermaid,
  findLineageMapNodes,
  findLineagePaths,
  fitLineageMapCamera,
  formatLineageEdgeDetails,
  formatLineageNodeDetails,
  formatLineagePathDiagnostics,
  renderLineageGraphSvg,
  renderLineageMapDetailHtml,
  renderLineageMapDockHtml,
  renderLineageMapSceneHtml,
  renderLineageMapSearchResultsHtml,
  renderLineageOverviewHtml,
  renderLineagePipelineHtml,
  summarizeLineageGraph,
  traceLineageNodeRelations,
  zoomLineageMapCameraAtPoint,
} from '../../src/scripts/ui/chat/lineage-graph-view-utils.js';

const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');

const graph = {
  version: 1,
  scopeId: 'persona:1',
  mode: 'moment',
  rootId: 'prompt:req-1',
  generatedAt: 1760000000000,
  nodes: [
    { id: 'contact:a', type: 'contact', label: 'Alice', status: 'active', scopeId: 'persona:1' },
    { id: 'profile:a', type: 'contact_profile', label: 'Alice 画像', status: 'active', scopeId: 'persona:1', meta: { contactId: 'contact:a' } },
    { id: 'row:a:1', type: 'memory_row', label: '拍照事件', status: 'active', scopeId: 'persona:1' },
    { id: 'contact:b', type: 'contact', label: 'Bob', status: 'blocked', scopeId: 'persona:2' },
    { id: 'prompt:req-1', type: 'prompt', label: '本次 Prompt', status: 'active', scopeId: 'persona:1' },
  ],
  edges: [
    { id: 'e1', source: 'contact:a', target: 'profile:a', type: 'contains', status: 'active', reason: 'default_enabled', sourceScopeId: 'persona:1', targetScopeId: 'persona:1' },
    { id: 'e2', source: 'profile:a', target: 'row:a:1', type: 'triggers', status: 'active', reason: 'memory_row_match', sourceScopeId: 'persona:1', targetScopeId: 'persona:1', score: 3 },
    { id: 'e3', source: 'row:a:1', target: 'prompt:req-1', type: 'injects', status: 'active', reason: 'memory_row_match', sourceScopeId: 'persona:1', targetScopeId: 'persona:1' },
    { id: 'e4', source: 'contact:b', target: 'prompt:req-1', type: 'candidate_for', status: 'blocked', reason: 'scope_block', sourceScopeId: 'persona:2', targetScopeId: 'persona:1' },
  ],
};

const buildDenseGraph = () => ({
  ...graph,
  nodes: [
    graph.nodes[4],
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `contact:dense:${index}`,
      type: 'contact',
      label: `联系人 ${index}`,
      status: 'active',
      scopeId: 'persona:1',
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `row:dense:${index}`,
      type: 'memory_row',
      label: `记忆 ${index}`,
      status: 'active',
      scopeId: 'persona:1',
    })),
  ],
  edges: [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `edge:contact:${index}`,
      source: `contact:dense:${index}`,
      target: 'prompt:req-1',
      type: 'candidate_for',
      status: 'candidate',
      sourceScopeId: 'persona:1',
      targetScopeId: 'persona:1',
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `edge:row:${index}`,
      source: `row:dense:${index}`,
      target: 'prompt:req-1',
      type: 'injects',
      status: 'active',
      sourceScopeId: 'persona:1',
      targetScopeId: 'persona:1',
    })),
  ],
});

const buildPagedGraph = () => ({
  ...graph,
  nodes: [
    graph.nodes[4],
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `contact:paged:${index}`,
      type: 'contact',
      label: `分页联系人 ${index + 1}`,
      status: 'active',
      scopeId: 'persona:1',
    })),
  ],
  edges: Array.from({ length: 30 }, (_, index) => ({
    id: `edge:paged:${index}`,
    source: `contact:paged:${index}`,
    target: 'prompt:req-1',
    type: 'candidate_for',
    status: 'candidate',
    sourceScopeId: 'persona:1',
    targetScopeId: 'persona:1',
  })),
});

const collectNodeOverlaps = (nodes = []) => {
  const overlaps = [];
  const visibleNodes = nodes.filter(node => node.kind !== 'root');
  visibleNodes.forEach((node, index) => {
    visibleNodes.slice(index + 1).forEach((other) => {
      const intersects = Math.abs(node.x - other.x) < (node.width + other.width) / 2 + 6
        && Math.abs(node.y - other.y) < (node.height + other.height) / 2 + 10;
      if (intersects) overlaps.push(`${node.id}/${other.id}`);
    });
  });
  return overlaps;
};

{
  const summary = summarizeLineageGraph(graph);
  assert.equal(summary.nodeCount, 5);
  assert.equal(summary.edgeCount, 4);
  assert.equal(summary.riskCount, 1);
  assert.equal(summary.byStatus.active, 3);
  assert.equal(summary.byStatus.blocked, 1);
  console.log('ok - summarizeLineageGraph counts status and scope risks');
}

{
  const model = buildLineageGraphViewModel(graph, { statusFilter: 'active' });
  assert.equal(model.nodes.some(node => node.id === 'contact:b'), false);
  assert.equal(model.edges.length, 3);
  assert.ok(model.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  const svg = renderLineageGraphSvg(model);
  assert.match(svg, /lineage-graph-svg/);
  assert.match(svg, /data-lineage-node-id="contact:a"/);
  assert.doesNotMatch(svg, /data-lineage-node-id="contact:b"/);
  console.log('ok - buildLineageGraphViewModel lays out filtered SVG nodes');
}

{
  const riskModel = buildLineageGraphViewModel(graph, { statusFilter: 'risk' });
  assert.equal(riskModel.edges.length, 1);
  assert.equal(riskModel.edges[0].id, 'e4');
  assert.equal(riskModel.nodes.some(node => node.id === 'contact:b'), true);
  console.log('ok - lineage graph risk filter keeps cross-scope blocked paths');
}

{
  const localModel = buildLineageGraphViewModel(graph, {
    focusId: 'prompt:req-1',
    includeStructuralEdges: false,
  });
  assert.equal(localModel.edges.some(edge => edge.id === 'e1'), false);
  assert.equal(localModel.edges.some(edge => edge.id === 'e3'), true);
  assert.equal(localModel.nodes.some(node => node.id === 'prompt:req-1'), true);
  console.log('ok - local lineage graph hides low-signal structural edges by default');
}

{
  const scene = renderLineageMapSceneHtml(graph);
  assert.match(scene, /lineage-map-scene/);
  assert.match(scene, /data-lineage-map-category="contacts"/);
  assert.match(scene, /联系人/);
  assert.match(scene, /lineage-map-layer-guide/);
  assert.match(scene, /lineage-map-link-hit/);
  assert.match(scene, /<animateMotion/);
  assert.match(scene, /data-lineage-minimap-template/);
  assert.match(scene, /lineage-node-topline/);
  assert.match(scene, /--lineage-node-delay:/);
  assert.doesNotMatch(scene, /NaN/);
  assert.doesNotMatch(scene, /Alice 画像/);
  const expandedCategory = renderLineageMapSceneHtml(graph, { expandedIds: ['contacts'] });
  assert.doesNotMatch(expandedCategory, /is-contains/);
  const expanded = renderLineageMapSceneHtml(graph, { expandedIds: ['contacts'], focusId: 'contact:a' });
  assert.match(expanded, /data-lineage-node-id="contact:a"/);
  assert.match(expanded, /Alice/);
  assert.match(expanded, /is-contains/);
  assert.match(expanded, /data-lineage-edge-id="e1"/);
  assert.match(expanded, /is-lineage-down/);
  assert.match(expanded, /is-layer-contacts is-lineage-self/);
  assert.doesNotMatch(expanded, /is-layer-[^"\s]+is-lineage-/);
  assert.doesNotMatch(expanded, /is-(?:active|candidate|blocked|trimmed|disabled|unknown)is-(?:aggregate|contains|related)/);
  assert.match(expanded, /M1,1 L8,4 L1,7/);
  const more = renderLineageMapSceneHtml(buildDenseGraph(), {
    expandedIds: ['contacts'],
    maxItemsPerCategory: 3,
  });
  assert.match(more, /data-lineage-show-more-category="contacts"/);
  console.log('ok - lineage map scene renders first-layer categories and expands on demand');
}

{
  const lineage = traceLineageNodeRelations(graph, 'contact:a');
  assert.deepEqual(Array.from(lineage.directDownstreamIds), ['profile:a']);
  assert.equal(lineage.downstreamIds.has('prompt:req-1'), true);
  assert.equal(lineage.upstreamIds.size, 1);

  const model = buildLineageMapSceneModel(graph, {
    expandedIds: ['contacts'],
    focusId: 'contact:a',
  });
  const graphNodeIds = model.nodes.map(node => node.nodeId).filter(Boolean);
  assert.equal(new Set(graphNodeIds).size, graphNodeIds.length);
  const nodeByGraphId = new Map(model.nodes.filter(node => node.nodeId).map(node => [node.nodeId, node.id]));
  const e1 = model.edges.find(edge => edge.edgeId === 'e1');
  const e3 = model.edges.find(edge => edge.edgeId === 'e3');
  assert.equal(e1.sourceId, nodeByGraphId.get('contact:a'));
  assert.equal(e1.targetId, nodeByGraphId.get('profile:a'));
  assert.equal(e1.lineageState, 'down');
  assert.equal(e3.sourceId, nodeByGraphId.get('row:a:1'));
  assert.equal(e3.targetId, nodeByGraphId.get('prompt:req-1'));
  const contactAggregate = model.edges.find(edge => edge.id === 'map-edge-root-contacts-in');
  assert.equal(contactAggregate.sourceId, 'category:contacts');
  assert.equal(contactAggregate.targetId, 'node:prompt:req-1');
  assert.equal(model.edges.some(edge => edge.id === 'map-edge-root-contacts-out'), false);
  console.log('ok - lineage focus preserves real graph direction, transitive closure, and node identity');
}

{
  let edgeReads = 0;
  const measuredGraph = {
    ...graph,
    get edges() {
      edgeReads += 1;
      return graph.edges;
    },
  };
  const impacts = buildLineageImpactNodes(measuredGraph, 5);
  assert.equal(edgeReads, 1, '影响面排行应只构建一次邻接表');
  assert.equal(impacts[0].node.id, 'contact:a');
  assert.equal(impacts[0].score, 3);
  console.log('ok - lineage 影响面排行复用单次邻接表构建');
}

{
  const results = findLineageMapNodes(graph, 'Alice');
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(item => item.categoryId).sort(), ['contacts', 'profiles']);
  const resultHtml = renderLineageMapSearchResultsHtml(results);
  assert.match(resultHtml, /data-lineage-jump-node-id="contact:a"/);
  assert.match(resultHtml, /lineage-search-result-dot/);

  const dock = renderLineageMapDockHtml(graph, { expandedIds: ['contacts'] });
  assert.match(dock, /lineage-layer-dock-card/);
  assert.match(dock, /data-lineage-map-category="contacts"/);
  assert.match(dock, /data-lineage-expanded="true"/);
  assert.match(dock, /lineage-impact-list/);

  const detail = renderLineageMapDetailHtml('node', graph.nodes[0], graph);
  assert.match(detail, /lineage-detail-impact-grid/);
  assert.match(detail, /lineage-detail-accent/);
  assert.match(detail, /data-lineage-jump-node-id="profile:a"/);
  assert.match(detail, /下游影响<\/span><strong>3/);
  const riskDetail = renderLineageMapDetailHtml('edge', graph.edges[3], graph);
  assert.match(riskDetail, />风险<\/i>/);
  console.log('ok - lineage map HUD search dock and glass detail preserve graph navigation');
}

{
  const fitted = fitLineageMapCamera({
    viewport: { width: 1000, height: 600 },
    world: { width: 1200, height: 800 },
    padding: 40,
  });
  assert.deepEqual(fitted, { x: 110, y: 40, scale: 0.65 });

  const zoomed = zoomLineageMapCameraAtPoint({
    camera: { x: 10, y: 20, scale: 1 },
    point: { x: 100, y: 100 },
    scale: 2,
  });
  assert.deepEqual(zoomed, { x: -80, y: -60, scale: 2 });

  const centered = centerLineageMapCamera({
    viewport: { width: 1000, height: 600 },
    point: { x: 300, y: 200 },
    scale: 0.8,
  });
  assert.deepEqual(centered, { x: 260, y: 140, scale: 0.8 });

  const miniViewport = buildLineageMapMiniViewport({
    camera: centered,
    viewport: { width: 1000, height: 600 },
    world: { width: 1400, height: 900 },
  });
  assert.deepEqual(miniViewport, { x: 0, y: 0, width: 1250, height: 750 });
  console.log('ok - lineage map camera helpers preserve cursor zoom fit center and minimap viewport');
}

{
  const css = readFileSync(new URL('../../src/assets/css/theme.css', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(css, /@keyframes lineage-node-in/);
  assert.match(css, /@keyframes lineage-flow-dash/);
  assert.match(css, /@keyframes lineage-glow-drift/);
  assert.match(css, /@keyframes lineage-scanline/);
  assert.match(css, /@keyframes lineage-detail-in/);
  assert.match(css, /\.lineage-map-particle/);
  assert.match(css, /:not\(\.lineage-graph-panel \*\)/);
  assert.match(css, /\.lineage-map-link-hit\s*\{[^}]*vector-effect:\s*non-scaling-stroke/s);
  assert.match(css, /\.lineage-map-arrow\s*\{[^}]*fill:\s*none/s);
  assert.match(css, /\.lineage-map-node\.is-lineage-self/);
  assert.match(css, /\.lineage-map-node\.is-lineage-dim/);
  assert.match(css, /body\[data-theme-mode='dark'\] \.lineage-graph-panel/);
  assert.match(css, /body\[data-reduced-motion='on'\] \.lineage-graph-panel/);
  assert.match(appSource, /const escHtml = \(s\) => escapeHtml\(s\);/,
    'Prompt/血缘预览应复用含引号转义的共享 escapeHtml');
  console.log('ok - lineage visual contract includes reference atmosphere motion and theme fallbacks');
}

{
  const model = buildLineageMapSceneModel(buildDenseGraph(), { expandedIds: ['contacts', 'memories'] });
  assert.deepEqual(collectNodeOverlaps(model.nodes), []);
  assert.ok(model.edges.every(edge => /C/.test(edge.path)));
  console.log('ok - lineage map scene allocates expanded bands without node overlap');
}

{
  const firstPage = buildLineageMapSceneModel(buildPagedGraph(), { expandedIds: ['contacts'] });
  assert.equal(firstPage.nodes.filter(node => node.kind === 'item').length, 12);
  assert.equal(firstPage.nodes.find(node => node.moreCategoryId === 'contacts')?.label, '+18');
  const secondPage = buildLineageMapSceneModel(buildPagedGraph(), {
    expandedIds: ['contacts'],
    categoryItemLimits: { contacts: 24 },
  });
  assert.equal(secondPage.nodes.filter(node => node.kind === 'item').length, 24);
  assert.equal(secondPage.nodes.find(node => node.moreCategoryId === 'contacts')?.label, '+6');
  const finalPage = buildLineageMapSceneModel(buildPagedGraph(), {
    expandedIds: ['contacts'],
    categoryItemLimits: new Map([['contacts', 36]]),
  });
  assert.equal(finalPage.nodes.filter(node => node.kind === 'item').length, 30);
  assert.equal(finalPage.nodes.some(node => node.moreCategoryId === 'contacts'), false);
  console.log('ok - lineage category paging expands by configured object or Map limits');
}

{
  const model = await buildLineageMapSceneModelWithElk(buildDenseGraph(), {
    expandedIds: ['contacts', 'memories'],
    elkConstructor: ELK,
  });
  assert.equal(model.layoutEngine, 'elk');
  assert.deepEqual(collectNodeOverlaps(model.nodes), []);
  assert.ok(model.edges.every(edge => /C/.test(edge.path)));
  console.log('ok - lineage map scene uses ELK layered layout and smooth curves without node overlap');
}

{
  const nodeText = formatLineageNodeDetails(graph.nodes[1]);
  assert.match(nodeText, /Alice 画像/);
  assert.match(nodeText, /meta.contactId/);
  const edgeText = formatLineageEdgeDetails(graph.edges[3], graph);
  assert.match(edgeText, /跨角色卡 scope 边/);
  assert.match(edgeText, /scope_block/);
  console.log('ok - lineage node and edge detail formatters expose evidence');
}

{
  const mermaid = exportLineageGraphMermaid(graph);
  assert.match(mermaid, /flowchart LR/);
  assert.match(mermaid, /注入/);
  const dot = exportLineageGraphDot(graph);
  assert.match(dot, /digraph ContextLineageGraph/);
  assert.match(dot, /scope: persona:1/);
  console.log('ok - lineage graph exports Mermaid and DOT');
}

{
  const result = findLineagePaths(graph, { query: 'Alice' });
  assert.equal(result.startCount, 2);
  assert.equal(result.paths.length, 2);
  assert.match(result.paths[0].text, /Alice/);
  assert.match(result.paths[0].text, /本次 Prompt/);
  const risk = findLineagePaths(graph);
  assert.equal(risk.paths.length, 1);
  assert.match(formatLineagePathDiagnostics(risk, graph), /风险路径诊断/);
  assert.deepEqual(detectLineageCycles(graph), []);
  console.log('ok - lineage path diagnostics finds query and risk paths');
}

{
  const cyclicGraph = {
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
      { source: 'c', target: 'a' },
    ],
  };
  assert.deepEqual(detectLineageCycles(cyclicGraph, { maxDepth: 1 }), [],
    '深度预算应截断超出范围的环检测');
  assert.deepEqual(detectLineageCycles(cyclicGraph, { maxVisits: 1 }), [],
    '访问预算应截断高复杂度遍历');
  assert.equal(detectLineageCycles(cyclicGraph, { maxDepth: 4, maxVisits: 32 }).length > 0, true,
    '预算充足时仍应检出环');
  console.log('ok - lineage 环检测受深度与访问预算约束');
}

{
  const previousDocument = globalThis.document;
  const previousElk = globalThis.ELK;
  const scripts = [];
  globalThis.document = {
    createElement: () => ({
      dataset: {},
      remove() { this.removed = true; },
    }),
    querySelector: () => scripts.find(script => !script.removed) || null,
    head: {
      appendChild(script) {
        scripts.push(script);
        queueMicrotask(() => {
          if (scripts.length === 1) {
            script.onerror?.(new Error('load failed'));
            return;
          }
          globalThis.ELK = ELK;
          script.onload?.();
        });
      },
    },
  };
  try {
    delete globalThis.ELK;
    const fallback = await buildLineageMapSceneModelWithElk(graph);
    assert.equal(fallback.layoutEngine, 'fallback');
    const retried = await buildLineageMapSceneModelWithElk(graph);
    assert.equal(scripts.length, 2, 'ELK 首次加载失败后应在后续调用重新加载');
    assert.equal(retried.layoutEngine, 'elk');
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousElk === undefined) delete globalThis.ELK;
    else globalThis.ELK = previousElk;
  }
  console.log('ok - lineage ELK 加载失败后可在同一会话重试');
}

{
  const overview = renderLineageOverviewHtml(graph);
  assert.match(overview, /lineage-overview-view/);
  assert.match(overview, /已注入/);
  assert.match(overview, /风险/);
  const pipeline = renderLineagePipelineHtml(graph);
  assert.match(pipeline, /lineage-pipeline-view/);
  assert.match(pipeline, /候选来源/);
  assert.match(pipeline, /阻止 \/ 裁剪 \/ 风险/);
  console.log('ok - lineage readable views render overview and pipeline summaries');
}

{
  // 地图上的分层节点名、计数小字与影响排行小字是系统文字，即使在 data-i18n-skip 里也要按界面语言显示
  const { initializeI18n } = await import('../../src/scripts/i18n/index.js');
  try {
    await initializeI18n({
      preference: 'en',
      documentLike: null,
      fetchFn: async () => ({ ok: true, json: async () => ({ 联系人: 'Contacts', '{value} 注入': '{value} Injected', '{value} 候选': '{value} Candidates', '{value} 风险': '{value} risk', '下游影响 {value}': 'Downstream impact {value}' }) }),
    });
    const scene = renderLineageMapSceneHtml(graph);
    assert.match(scene, /data-i18n-skip>Contacts<\/strong>/);
    assert.doesNotMatch(scene, /data-i18n-skip>联系人<\/strong>/);
    assert.doesNotMatch(scene, /<small data-i18n-skip>\d+ (注入|候选|风险)<\/small>/);
    const dock = renderLineageMapDockHtml(graph);
    assert.doesNotMatch(dock, /下游影响/);
    const expandedScene = renderLineageMapSceneHtml(graph, { expandedIds: ['contacts'] });
    assert.match(expandedScene, /<small data-i18n-skip>Contacts<\/small>/);
    assert.doesNotMatch(expandedScene, /<small data-i18n-skip>联系人<\/small>/);
  } finally {
    await initializeI18n({ preference: 'zh-CN', documentLike: null });
  }
  console.log('ok - lineage map system labels follow the UI language');
}
