// 血缘图工具栏的「诊断」与「导出」：两个节点之间的路径、图里的循环关系，以及导出 Mermaid／DOT。
// 纯函数；起终点状态、复制与存文件由 app.js 负责。
import { t } from '../../i18n/index.js';
import {
  detectLineageCycles,
  exportLineageGraphDot,
  exportLineageGraphMermaid,
  getLineageEdgeTypeLabel,
  renderLineageNodeJumpHtml,
  traceLineageNodeRelations,
} from './lineage-graph-view-utils.js';

const trim = value => String(value ?? '').trim();
const listOf = value => (Array.isArray(value) ? value : []);
const escHtml = value => trim(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const buildOutEdges = (graph = null) => {
  const outEdges = new Map();
  listOf(graph?.edges).forEach((edge) => {
    const source = trim(edge?.source);
    const target = trim(edge?.target);
    if (!source || !target) return;
    if (!outEdges.has(source)) outEdges.set(source, []);
    outEdges.get(source).push(edge);
  });
  return outEdges;
};

// 沿关系方向逐层找，先找到的最短；走过的节点不重复，搜索量有上限（大图不卡）
const searchPaths = (outEdges, start, goal, { maxDepth, maxPaths, maxVisits }) => {
  const paths = [];
  const queue = [{ nodeId: start, edges: [], visited: new Set([start]) }];
  let visits = 0;
  while (queue.length && paths.length < maxPaths && visits < maxVisits) {
    const current = queue.shift();
    visits += 1;
    if (current.edges.length >= maxDepth) continue;
    for (const edge of outEdges.get(current.nodeId) || []) {
      const next = trim(edge?.target);
      if (current.visited.has(next)) continue;
      const pathEdges = [...current.edges, edge];
      if (next === goal) {
        paths.push(pathEdges);
        if (paths.length >= maxPaths) break;
        continue;
      }
      if (queue.length < maxVisits) queue.push({ nodeId: next, edges: pathEdges, visited: new Set([...current.visited, next]) });
    }
  }
  return paths.map(pathEdges => ({
    nodeIds: [start, ...pathEdges.map(edge => trim(edge?.target))],
    edgeIds: pathEdges.map(edge => trim(edge?.id)).filter(Boolean),
    edges: pathEdges,
  }));
};

/**
 * 两个节点之间的有向路径：先找起点 → 终点（forward），找不到再找终点 → 起点（reverse）；
 * 两个方向都没有时 direction 为 none，另给两者共同的上游／下游（如都绑定同一本世界书）。
 */
export const findLineagePathBetween = (graph = null, fromId = '', toId = '', {
  maxDepth = 8,
  maxPaths = 3,
  maxVisits = 20000,
} = {}) => {
  const from = trim(fromId);
  const to = trim(toId);
  const result = { fromId: from, toId: to, direction: 'none', paths: [], sharedUpstreamIds: [], sharedDownstreamIds: [] };
  const nodeIds = new Set(listOf(graph?.nodes).map(node => trim(node?.id)));
  if (!from || !to || from === to || !nodeIds.has(from) || !nodeIds.has(to)) return result;
  const outEdges = buildOutEdges(graph);
  const limits = {
    maxDepth: Math.max(1, Math.trunc(Number(maxDepth) || 8)),
    maxPaths: Math.max(1, Math.trunc(Number(maxPaths) || 3)),
    maxVisits: Math.max(1, Math.trunc(Number(maxVisits) || 20000)),
  };
  const forward = searchPaths(outEdges, from, to, limits);
  if (forward.length) return { ...result, direction: 'forward', paths: forward };
  const reverse = searchPaths(outEdges, to, from, limits);
  if (reverse.length) return { ...result, direction: 'reverse', paths: reverse };
  const fromLineage = traceLineageNodeRelations(graph, from);
  const toLineage = traceLineageNodeRelations(graph, to);
  const shared = (a, b) => Array.from(a).filter(id => id !== from && id !== to && b.has(id));
  return {
    ...result,
    sharedUpstreamIds: shared(fromLineage.upstreamIds, toLineage.upstreamIds),
    sharedDownstreamIds: shared(fromLineage.downstreamIds, toLineage.downstreamIds),
  };
};

/** 诊断结果：循环关系（总是检查）与起终点之间的路径；节点／关系 id 集合用来在图上标出来。 */
export const buildLineageDiagnostics = (graph = null, { fromId = '', toId = '' } = {}) => {
  const cycles = detectLineageCycles(graph, { maxCycles: 8 });
  const cycleNodeIds = new Set(cycles.flatMap(cycle => listOf(cycle?.edges).flatMap(edge => [trim(edge?.source), trim(edge?.target)])));
  const path = trim(fromId) && trim(toId) ? findLineagePathBetween(graph, fromId, toId) : null;
  const pathNodeIds = new Set(listOf(path?.paths).flatMap(item => item.nodeIds));
  const pathEdgeIds = new Set(listOf(path?.paths).flatMap(item => item.edgeIds));
  return { fromId: trim(fromId), toId: trim(toId), cycles, cycleNodeIds, path, pathNodeIds, pathEdgeIds };
};

const nodeMap = graph => new Map(listOf(graph?.nodes).map(node => [trim(node?.id), node]));
const nodeLabel = node => trim(node?.label || node?.id) || t('未知节点');

const renderEndpoint = (node, role) => `
  <div class="lineage-diag-endpoint is-${role}">
    <span>${escHtml(role === 'from' ? t('起点') : t('终点'))}</span>
    ${node ? renderLineageNodeJumpHtml(node) : `<em>${escHtml(role === 'from' ? t('点选节点后按「设为起点」') : t('点选节点后按「设为终点」'))}</em>`}
  </div>
`;

const renderPathSteps = (pathItem, nodes) => `
  <ol class="lineage-diag-path">
    ${pathItem.nodeIds.map((nodeId, index) => {
      const hop = pathItem.edges[index];
      return `
        <li>
          ${renderLineageNodeJumpHtml(nodes.get(nodeId) || { id: nodeId, label: nodeId })}
          ${hop ? `<span class="lineage-diag-hop">${escHtml(getLineageEdgeTypeLabel(hop?.type))} ↓</span>` : ''}
        </li>
      `;
    }).join('')}
  </ol>
`;

const renderNodeList = (ids, nodes, limit = 5) => {
  const list = listOf(ids).slice(0, limit).map(id => nodes.get(id)).filter(Boolean);
  const rest = listOf(ids).length - list.length;
  return `${list.map(node => renderLineageNodeJumpHtml(node)).join('')}${rest > 0 ? `<p class="lineage-diag-more">${escHtml(t('还有 {count} 个', { count: rest }))}</p>` : ''}`;
};

const renderPathResult = (diagnostics, nodes) => {
  const path = diagnostics?.path;
  if (!diagnostics?.fromId || !diagnostics?.toId) {
    return '<p class="lineage-diag-hint">选好起点与终点，就能看出两者之间经过哪些关系。</p>';
  }
  if (!path || diagnostics.fromId === diagnostics.toId) {
    return '<p class="lineage-diag-hint">起点与终点是同一个节点。</p>';
  }
  if (path.direction === 'none') {
    const sharedDown = listOf(path.sharedDownstreamIds);
    const sharedUp = listOf(path.sharedUpstreamIds);
    return `
      <p class="lineage-diag-verdict is-none">两者之间没有直接的血缘路径</p>
      ${sharedDown.length ? `<h5>两者都用到 <b>${sharedDown.length}</b></h5>${renderNodeList(sharedDown, nodes)}` : ''}
      ${sharedUp.length ? `<h5>共同的上游 <b>${sharedUp.length}</b></h5>${renderNodeList(sharedUp, nodes)}` : ''}
    `;
  }
  const count = path.paths.length;
  const verdict = path.direction === 'forward'
    ? t('起点 → 终点可达 · {count} 条最短路径', { count })
    : t('方向相反：终点 → 起点可达 · {count} 条最短路径', { count });
  return `
    <p class="lineage-diag-verdict is-${escHtml(path.direction)}">${escHtml(verdict)}</p>
    ${path.paths.map(item => renderPathSteps(item, nodes)).join('')}
  `;
};

const renderCycles = (diagnostics, nodes) => {
  const cycles = listOf(diagnostics?.cycles);
  if (!cycles.length) return '<p class="lineage-diag-hint is-ok">没有发现循环关系</p>';
  return cycles.map((cycle) => {
    const ids = listOf(cycle?.edges).map(edge => trim(edge?.source));
    return `
      <div class="lineage-diag-cycle">
        ${ids.map(id => `<button type="button" data-lineage-jump-node-id="${escHtml(id)}" data-i18n-skip>${escHtml(nodeLabel(nodes.get(id) || { id }))}</button>`).join('<i aria-hidden="true">→</i>')}
        <i aria-hidden="true">↺</i>
      </div>
    `;
  }).join('');
};

export const renderLineageDiagnosticsHtml = (graph = null, diagnostics = null) => {
  const nodes = nodeMap(graph);
  const from = nodes.get(trim(diagnostics?.fromId)) || null;
  const to = nodes.get(trim(diagnostics?.toId)) || null;
  const cycleCount = listOf(diagnostics?.cycles).length;
  return `
    <section class="lineage-layer-dock-card lineage-glass lineage-diagnostics-card">
      <div class="lineage-dock-heading">
        <span>路径诊断</span>
        <button type="button" class="lineage-diag-close" data-lineage-tool="diagnostics" aria-label="关闭诊断">×</button>
      </div>
      <div class="lineage-diag-endpoints">${renderEndpoint(from, 'from')}${renderEndpoint(to, 'to')}</div>
      ${from || to ? '<button type="button" class="lineage-diag-clear" data-lineage-path-clear="1">清除起终点</button>' : ''}
      <div class="lineage-diag-result">${renderPathResult(diagnostics, nodes)}</div>
      <h4 class="lineage-diag-section${cycleCount ? ' is-warning' : ''}">循环关系 <b>${cycleCount}</b></h4>
      ${renderCycles(diagnostics, nodes)}
    </section>
  `;
};

export const renderLineageExportMenuHtml = () => `
  <button type="button" role="menuitem" data-lineage-export="copy-mermaid"><strong>复制 Mermaid</strong><small>可贴到 Mermaid Live 等工具查看</small></button>
  <button type="button" role="menuitem" data-lineage-export="copy-dot"><strong>复制 DOT</strong><small>Graphviz 格式</small></button>
  <i aria-hidden="true"></i>
  <button type="button" role="menuitem" data-lineage-export="save-mermaid"><strong>保存 .mmd 文件</strong></button>
  <button type="button" role="menuitem" data-lineage-export="save-dot"><strong>保存 .dot 文件</strong></button>
`;

const pad = value => String(value).padStart(2, '0');

/** 导出整张图（不只画面上展开的部分）。format：mermaid／dot。 */
export const buildLineageExportFile = (graph = null, format = 'mermaid', { at = Date.now() } = {}) => {
  const isDot = trim(format) === 'dot';
  const time = new Date(Number(at) || Date.now());
  const stamp = `${time.getFullYear()}${pad(time.getMonth() + 1)}${pad(time.getDate())}-${pad(time.getHours())}${pad(time.getMinutes())}`;
  const mode = trim(graph?.mode).replace(/[^A-Za-z0-9_-]+/g, '') || 'graph';
  const extension = isDot ? 'dot' : 'mmd';
  return {
    text: isDot ? exportLineageGraphDot(graph) : exportLineageGraphMermaid(graph),
    fileName: `lineage-${mode}-${stamp}.${extension}`,
    extension,
    filterName: isDot ? 'Graphviz DOT' : 'Mermaid',
  };
};
