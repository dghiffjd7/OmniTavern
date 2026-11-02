import { t } from '../../i18n/index.js';

const NODE_TYPE_LABELS = Object.freeze({
  persona_card: '角色卡',
  private_chat: '私聊',
  group_chat: '群聊',
  moment: '动态',
  creative_session: '创作',
  forum_board: '论坛板块',
  forum_thread: '论坛帖子',
  contact: '联系人',
  group_member: '群成员',
  memory_table: '记忆表格',
  memory_row: '记忆行',
  contact_profile: '联系人画像',
  worldbook: '世界书',
  worldbook_entry: '世界书条目',
  summary: '摘要',
  variable_scope: '变量',
  preset: '预设',
  regex: '正则',
  prompt: 'Prompt',
  rule: '规则',
});

const EDGE_TYPE_LABELS = Object.freeze({
  contains: '包含',
  member_of: '成员',
  binds: '绑定',
  derived_from: '派生',
  candidate_for: '候选',
  triggers: '触发',
  injects: '注入',
  visible_to: '可见',
  blocked_by: '阻止',
  trimmed_by: '裁剪',
});

const STATUS_LABELS = Object.freeze({
  active: '已启用',
  candidate: '候选',
  blocked: '已阻止',
  trimmed: '已裁剪',
  disabled: '已关闭',
  risk: '风险',
  unknown: '未知',
});

export const LINEAGE_GRAPH_STATUS_FILTERS = Object.freeze([
  { id: 'all', label: '全部' },
  { id: 'active', label: '已注入' },
  { id: 'candidate', label: '候选' },
  { id: 'blocked_trimmed', label: '阻止/裁剪' },
  { id: 'risk', label: '风险' },
]);

export const LINEAGE_GRAPH_VIEW_MODES = Object.freeze([
  { id: 'overview', label: '总览' },
  { id: 'pipeline', label: '注入链路' },
  { id: 'local', label: '局部图' },
  { id: 'full', label: '完整图' },
]);

const STRUCTURAL_EDGE_TYPES = new Set(['contains', 'member_of', 'binds', 'derived_from']);

const MAP_CATEGORY_DEFS = Object.freeze([
  { id: 'contacts', label: '联系人', en: 'CONTACTS', icon: 'contacts', types: ['contact', 'group_member'] },
  { id: 'groups', label: '群聊', en: 'GROUPS', icon: 'groups', types: ['group_chat'] },
  { id: 'creative', label: '创意写作', en: 'CREATIVE', icon: 'creative', types: ['creative_session'] },
  { id: 'worldbooks', label: '世界书', en: 'WORLDBOOK', icon: 'worldbooks', types: ['worldbook', 'worldbook_entry'] },
  { id: 'presets', label: '预设与正则', en: 'PRESET', icon: 'presets', types: ['preset', 'regex'] },
  { id: 'memories', label: '记忆与摘要', en: 'MEMORY', icon: 'memories', types: ['memory_table', 'memory_row', 'summary'] },
  { id: 'variables', label: '变量', en: 'VARIABLES', icon: 'variables', types: ['variable_scope'] },
  { id: 'profiles', label: '画像', en: 'PROFILE', icon: 'profiles', types: ['contact_profile'] },
  { id: 'moments', label: '动态', en: 'MOMENTS', icon: 'moments', types: ['moment'] },
  { id: 'contexts', label: '上下文', en: 'CONTEXT', icon: 'contexts', types: ['persona_card', 'private_chat', 'forum_board', 'forum_thread', 'rule'] },
  { id: 'prompts', label: 'Prompt', en: 'PROMPT', icon: 'prompts', types: ['prompt'] },
]);

const LINEAGE_ELK_SCRIPT_URL = '../../vendor/elk.bundled.js';

const TYPE_COLUMNS = Object.freeze({
  persona_card: 0,
  private_chat: 1,
  group_chat: 1,
  moment: 1,
  creative_session: 1,
  forum_board: 1,
  forum_thread: 1,
  contact: 1,
  group_member: 1,
  worldbook: 2,
  contact_profile: 2,
  memory_table: 2,
  summary: 2,
  variable_scope: 2,
  preset: 2,
  rule: 2,
  worldbook_entry: 3,
  regex: 3,
  memory_row: 3,
  prompt: 4,
});

const STATUS_SORT = Object.freeze({
  active: 0,
  candidate: 1,
  blocked: 2,
  trimmed: 3,
  disabled: 4,
  unknown: 5,
});

const normalizeString = value => String(value ?? '').trim();
const listOf = value => Array.isArray(value) ? value : [];
const labelFor = (map, value) => map[normalizeString(value)] || normalizeString(value) || '未知';

const escHtml = value => normalizeString(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const truncate = (value, max = 32) => {
  const text = normalizeString(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1))}…`;
};

const isCrossScopeEdge = (edge = {}, graphScopeId = '') => {
  const graphScope = normalizeString(graphScopeId);
  const sourceScope = normalizeString(edge?.sourceScopeId || graphScope);
  const targetScope = normalizeString(edge?.targetScopeId || graphScope);
  return Boolean(sourceScope && targetScope && sourceScope !== targetScope);
};

const isRiskEdge = (edge = {}, graphScopeId = '') => {
  const reason = normalizeString(edge?.reason);
  const status = normalizeString(edge?.status);
  return isCrossScopeEdge(edge, graphScopeId)
    || reason === 'scope_block'
    || reason === 'mode_block'
    || status === 'blocked';
};

const isStructuralEdge = (edge = {}) => STRUCTURAL_EDGE_TYPES.has(normalizeString(edge?.type));

const shouldIncludeEdge = (edge = {}, filter = 'all', graphScopeId = '') => {
  const status = normalizeString(edge?.status) || 'unknown';
  if (filter === 'active') return status === 'active';
  if (filter === 'candidate') return status === 'candidate';
  if (filter === 'blocked_trimmed') return status === 'blocked' || status === 'trimmed' || status === 'disabled';
  if (filter === 'risk') return isRiskEdge(edge, graphScopeId);
  return true;
};

const getNodeColumn = (node = {}, rootId = '') => {
  if (normalizeString(node?.id) === normalizeString(rootId)) return 4;
  const type = normalizeString(node?.type);
  return Number.isFinite(TYPE_COLUMNS[type]) ? TYPE_COLUMNS[type] : 2;
};

const nodeWeight = node => Math.max(0, Number(node?.meta?.weight) || 0);

const compareNode = (a, b) => {
  const sa = STATUS_SORT[normalizeString(a?.status)] ?? STATUS_SORT.unknown;
  const sb = STATUS_SORT[normalizeString(b?.status)] ?? STATUS_SORT.unknown;
  if (sa !== sb) return sa - sb;
  const ta = normalizeString(a?.type);
  const tb = normalizeString(b?.type);
  if (ta !== tb) return ta.localeCompare(tb);
  // 同类型时分量大的在前（关系图节点带的行数／变量数／共用会话数；不同类型的分量单位不同，不互比）
  const wa = nodeWeight(a);
  const wb = nodeWeight(b);
  if (wa !== wb) return wb - wa;
  return normalizeString(a?.label || a?.id).localeCompare(normalizeString(b?.label || b?.id));
};

const makeSvgId = value => normalizeString(value).replace(/[^A-Za-z0-9_-]+/g, '_') || 'item';

const roundCameraValue = value => Number((Number(value) || 0).toFixed(4));
const clampNumber = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export const fitLineageMapCamera = ({
  viewport = {},
  world = {},
  padding = 36,
  minScale = 0.24,
  maxScale = 1.1,
} = {}) => {
  const viewportWidth = Math.max(1, Number(viewport?.width) || 1);
  const viewportHeight = Math.max(1, Number(viewport?.height) || 1);
  const worldWidth = Math.max(1, Number(world?.width) || 1);
  const worldHeight = Math.max(1, Number(world?.height) || 1);
  const inset = Math.max(0, Number(padding) || 0);
  const availableWidth = Math.max(1, viewportWidth - inset * 2);
  const availableHeight = Math.max(1, viewportHeight - inset * 2);
  const scale = clampNumber(
    Math.min(availableWidth / worldWidth, availableHeight / worldHeight),
    Math.max(0.05, Number(minScale) || 0.24),
    Math.max(Number(minScale) || 0.24, Number(maxScale) || 1.1),
  );
  return {
    x: roundCameraValue((viewportWidth - worldWidth * scale) / 2),
    y: roundCameraValue((viewportHeight - worldHeight * scale) / 2),
    scale: roundCameraValue(scale),
  };
};

export const zoomLineageMapCameraAtPoint = ({
  camera = {},
  point = {},
  scale = 1,
  minScale = 0.24,
  maxScale = 2.4,
} = {}) => {
  const currentScale = Math.max(0.01, Number(camera?.scale) || 1);
  const nextScale = clampNumber(
    Number(scale) || currentScale,
    Math.max(0.05, Number(minScale) || 0.24),
    Math.max(Number(minScale) || 0.24, Number(maxScale) || 2.4),
  );
  const pointX = Number(point?.x) || 0;
  const pointY = Number(point?.y) || 0;
  const worldX = (pointX - (Number(camera?.x) || 0)) / currentScale;
  const worldY = (pointY - (Number(camera?.y) || 0)) / currentScale;
  return {
    x: roundCameraValue(pointX - worldX * nextScale),
    y: roundCameraValue(pointY - worldY * nextScale),
    scale: roundCameraValue(nextScale),
  };
};

export const centerLineageMapCamera = ({
  viewport = {},
  point = {},
  scale = 1,
} = {}) => {
  const nextScale = Math.max(0.05, Number(scale) || 1);
  return {
    x: roundCameraValue((Number(viewport?.width) || 0) / 2 - (Number(point?.x) || 0) * nextScale),
    y: roundCameraValue((Number(viewport?.height) || 0) / 2 - (Number(point?.y) || 0) * nextScale),
    scale: roundCameraValue(nextScale),
  };
};

export const buildLineageMapMiniViewport = ({
  camera = {},
  viewport = {},
  world = {},
} = {}) => {
  const scale = Math.max(0.05, Number(camera?.scale) || 1);
  const worldWidth = Math.max(1, Number(world?.width) || 1);
  const worldHeight = Math.max(1, Number(world?.height) || 1);
  const width = Math.min(worldWidth, Math.max(0, (Number(viewport?.width) || 0) / scale));
  const height = Math.min(worldHeight, Math.max(0, (Number(viewport?.height) || 0) / scale));
  const maxX = Math.max(0, worldWidth - width);
  const maxY = Math.max(0, worldHeight - height);
  return {
    x: roundCameraValue(clampNumber(-(Number(camera?.x) || 0) / scale, 0, maxX)),
    y: roundCameraValue(clampNumber(-(Number(camera?.y) || 0) / scale, 0, maxY)),
    width: roundCameraValue(width),
    height: roundCameraValue(height),
  };
};

const buildVisibleGraph = (graph = null, {
  statusFilter = 'all',
  nodeTypeFilter = 'all',
  focusId = '',
  maxDepth = 2,
  includeStructuralEdges = true,
  maxNodes = 140,
  maxEdges = 220,
} = {}) => {
  const nodes = listOf(graph?.nodes);
  const edges = listOf(graph?.edges);
  const graphScopeId = normalizeString(graph?.scopeId);
  const filterEdges = (allowStructural = includeStructuralEdges !== false) => edges
    .filter(edge => shouldIncludeEdge(edge, statusFilter, graphScopeId))
    .filter(edge => allowStructural || !isStructuralEdge(edge) || isRiskEdge(edge, graphScopeId));
  let selectedEdges = filterEdges(includeStructuralEdges !== false);
  const normalizedFocusId = normalizeString(focusId);
  if (normalizedFocusId) {
    const depthLimit = Math.max(1, Math.trunc(Number(maxDepth) || 2));
    const seen = new Set([normalizedFocusId]);
    const frontier = new Set([normalizedFocusId]);
    for (let depth = 0; depth < depthLimit; depth += 1) {
      const next = new Set();
      selectedEdges.forEach((edge) => {
        const source = normalizeString(edge?.source);
        const target = normalizeString(edge?.target);
        if (frontier.has(source) && !seen.has(target)) next.add(target);
        if (frontier.has(target) && !seen.has(source)) next.add(source);
      });
      next.forEach(id => seen.add(id));
      frontier.clear();
      next.forEach(id => frontier.add(id));
    }
    selectedEdges = selectedEdges.filter(edge => seen.has(normalizeString(edge?.source)) && seen.has(normalizeString(edge?.target)));
    if (!selectedEdges.length && includeStructuralEdges === false) {
      selectedEdges = filterEdges(true).filter(edge => seen.has(normalizeString(edge?.source)) && seen.has(normalizeString(edge?.target)));
    }
  }
  selectedEdges = selectedEdges.slice(0, Math.max(1, maxEdges));
  const edgeNodeIds = new Set();
  selectedEdges.forEach((edge) => {
    const source = normalizeString(edge?.source);
    const target = normalizeString(edge?.target);
    if (source) edgeNodeIds.add(source);
    if (target) edgeNodeIds.add(target);
  });
  if (normalizeString(graph?.rootId)) edgeNodeIds.add(normalizeString(graph.rootId));
  let selectedNodes = nodes.filter((node) => {
    const id = normalizeString(node?.id);
    if (!id || !edgeNodeIds.has(id)) return false;
    if (nodeTypeFilter && nodeTypeFilter !== 'all') return normalizeString(node?.type) === nodeTypeFilter;
    return true;
  });
  if (selectedNodes.length > maxNodes) selectedNodes = selectedNodes.slice(0, Math.max(1, maxNodes));
  const selectedNodeIds = new Set(selectedNodes.map(node => normalizeString(node?.id)).filter(Boolean));
  const visibleEdges = selectedEdges.filter(edge => selectedNodeIds.has(normalizeString(edge?.source)) && selectedNodeIds.has(normalizeString(edge?.target)));
  return { nodes: selectedNodes, edges: visibleEdges };
};

export const summarizeLineageGraph = (graph = null) => {
  const nodes = listOf(graph?.nodes);
  const edges = listOf(graph?.edges);
  const byStatus = edges.reduce((acc, edge) => {
    const key = normalizeString(edge?.status) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const byType = nodes.reduce((acc, node) => {
    const key = normalizeString(node?.type) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const riskEdges = edges.filter(edge => isRiskEdge(edge, graph?.scopeId));
  return {
    scopeId: normalizeString(graph?.scopeId) || 'default',
    mode: normalizeString(graph?.mode) || 'unknown',
    nodeCount: nodes.length,
    edgeCount: edges.length,
    byStatus,
    byType,
    riskCount: riskEdges.length,
  };
};

const nodeTypeCount = (summary = {}, type = '') => Number(summary?.byType?.[type] || 0);
const edgeStatusCount = (summary = {}, status = '') => Number(summary?.byStatus?.[status] || 0);

const nodeByIdMap = (graph = null) => new Map(listOf(graph?.nodes).map(node => [normalizeString(node?.id), node]));

const labelOfNode = (node = null) => normalizeString(node?.label || node?.id) || '未知节点';

const uniqueNodesById = (nodes = []) => {
  const seen = new Set();
  return listOf(nodes).filter((node) => {
    const id = normalizeString(node?.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const buildLineageRelationAdjacency = (graph = null) => {
  const nodes = nodeByIdMap(graph);
  const incoming = new Map();
  const outgoing = new Map();
  listOf(graph?.edges).forEach((edge) => {
    const source = normalizeString(edge?.source);
    const target = normalizeString(edge?.target);
    if (!source || !target || !nodes.has(source) || !nodes.has(target)) return;
    if (!outgoing.has(source)) outgoing.set(source, new Set());
    if (!incoming.has(target)) incoming.set(target, new Set());
    outgoing.get(source).add(target);
    incoming.get(target).add(source);
  });
  return { nodes, incoming, outgoing };
};

export const traceLineageNodeRelations = (graph = null, nodeId = '', relationAdjacency = null) => {
  const focusId = normalizeString(nodeId);
  const adjacency = relationAdjacency?.nodes instanceof Map
    && relationAdjacency?.incoming instanceof Map
    && relationAdjacency?.outgoing instanceof Map
    ? relationAdjacency
    : buildLineageRelationAdjacency(graph);
  const { nodes, incoming, outgoing } = adjacency;
  if (!focusId || !nodes.has(focusId)) {
    return {
      focusId: '',
      upstreamIds: new Set(),
      downstreamIds: new Set(),
      directUpstreamIds: new Set(),
      directDownstreamIds: new Set(),
    };
  }
  const walk = (adjacency) => {
    const visited = new Set([focusId]);
    const queue = [focusId];
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    return visited;
  };
  return {
    focusId,
    upstreamIds: walk(incoming),
    downstreamIds: walk(outgoing),
    directUpstreamIds: new Set(incoming.get(focusId) || []),
    directDownstreamIds: new Set(outgoing.get(focusId) || []),
  };
};

const lineageStateForNodeId = (nodeId = '', lineage = null) => {
  const id = normalizeString(nodeId);
  const focusId = normalizeString(lineage?.focusId);
  if (!id || !focusId) return '';
  if (id === focusId) return 'self';
  const isUpstream = lineage?.upstreamIds?.has?.(id) === true;
  const isDownstream = lineage?.downstreamIds?.has?.(id) === true;
  if (isUpstream && isDownstream) return 'both';
  if (isUpstream) return 'up';
  if (isDownstream) return 'down';
  return 'dim';
};

const lineageStateForEdge = (edge = null, lineage = null) => {
  if (!lineage?.focusId) return '';
  const source = normalizeString(edge?.source);
  const target = normalizeString(edge?.target);
  const upstream = lineage.upstreamIds || new Set();
  const downstream = lineage.downstreamIds || new Set();
  const onUpstreamPath = upstream.has(source) && upstream.has(target);
  const onDownstreamPath = downstream.has(source) && downstream.has(target);
  if (onUpstreamPath && onDownstreamPath) return 'both';
  if (onUpstreamPath) return 'up';
  if (onDownstreamPath) return 'down';
  return 'dim';
};

const categoryForNode = (node = {}) => {
  const type = normalizeString(node?.type);
  return MAP_CATEGORY_DEFS.find(category => category.types.includes(type)) || null;
};

const lineageIconSvg = (name = 'contexts') => {
  const common = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const icons = {
    contacts: `<svg ${common}><circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/><path d="M4 9.5a2.7 2.7 0 0 0 0 5.2M20 9.5a2.7 2.7 0 0 1 0 5.2"/></svg>`,
    groups: `<svg ${common}><path d="M5 5h14v10H9l-4 4V5z"/><path d="M8 9h8M8 12h5"/></svg>`,
    worldbooks: `<svg ${common}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15z"/><path d="M8 7h8M8 11h7"/></svg>`,
    memories: `<svg ${common}><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>`,
    profiles: `<svg ${common}><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="9" r="3"/><path d="M6.5 19a5.5 5.5 0 0 1 11 0"/></svg>`,
    moments: `<svg ${common}><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M5 15l.8 2.2L8 18l-2.2.8L5 21l-.8-2.2L2 18l2.2-.8L5 15z"/></svg>`,
    contexts: `<svg ${common}><path d="M8 4c-2 0-3 1-3 3v2c0 1-.5 2-2 2 1.5 0 2 1 2 2v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1 .5 2 2 2-1.5 0-2 1-2 2v2c0 2-1 3-3 3"/></svg>`,
    prompts: `<svg ${common}><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>`,
    creative: `<svg ${common}><path d="M20 4c-7 .5-12 5.5-13 12.5L5 20l3.5-2C15.5 17 19.5 12 20 4z"/><path d="M7.5 16.5 14 10"/></svg>`,
    presets: `<svg ${common}><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`,
    variables: `<svg ${common}><path d="M8 4c-2 0-3 1-3 3v2.5L3.5 12 5 14.5V17c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2.5l1.5 2.5-1.5 2.5V17c0 2-1 3-3 3"/><path d="m9.5 9.5 5 5M14.5 9.5l-5 5"/></svg>`,
  };
  return icons[normalizeString(name)] || icons.contexts;
};

export const findLineageMapNodes = (graph = null, query = '', { limit = 8 } = {}) => {
  const q = normalizeString(query).toLowerCase();
  if (!q) return [];
  const resultLimit = Math.max(1, Math.trunc(Number(limit) || 8));
  return listOf(graph?.nodes)
    .filter((node) => {
      const values = [
        node?.label,
        node?.id,
        labelFor(NODE_TYPE_LABELS, node?.type),
        node?.type,
        node?.summary,
        node?.scopeId,
        ...Object.values(node?.meta && typeof node.meta === 'object' ? node.meta : {}),
      ];
      return values.some(value => normalizeString(value).toLowerCase().includes(q));
    })
    .sort((a, b) => {
      const aLabel = labelOfNode(a).toLowerCase();
      const bLabel = labelOfNode(b).toLowerCase();
      const prefixDelta = Number(!aLabel.startsWith(q)) - Number(!bLabel.startsWith(q));
      return prefixDelta || compareNode(a, b);
    })
    .slice(0, resultLimit)
    .map((node) => {
      const category = categoryForNode(node) || MAP_CATEGORY_DEFS.find(item => item.id === 'contexts');
      return {
        id: normalizeString(node?.id),
        label: labelOfNode(node),
        meta: labelFor(NODE_TYPE_LABELS, node?.type),
        status: mapNodeStatus(node, graph),
        categoryId: category?.id || 'contexts',
        icon: category?.icon || 'contexts',
      };
    });
};

export const renderLineageMapSearchResultsHtml = (results = []) => {
  const items = listOf(results);
  if (!items.length) return '<div class="lineage-search-empty">没有匹配的血缘节点</div>';
  return items.map(item => `
    <button type="button" class="lineage-search-result is-layer-${escHtml(item?.categoryId || 'contexts')}"
      data-lineage-jump-node-id="${escHtml(item?.id)}" data-lineage-layer-id="${escHtml(item?.categoryId || 'contexts')}">
      <span class="lineage-search-result-dot" aria-hidden="true"></span>
      <span class="lineage-search-result-icon" aria-hidden="true">${lineageIconSvg(item?.icon || item?.categoryId)}</span>
      <span class="lineage-search-result-text"><strong data-i18n-skip>${escHtml(item?.label)}</strong><small>${escHtml(item?.meta)}</small></span>
      <span class="lineage-search-result-status is-${escHtml(item?.status || 'unknown')}">${escHtml(labelFor(STATUS_LABELS, item?.status))}</span>
    </button>
  `).join('');
};

export const buildLineageImpactNodes = (graph = null, limit = 5) => {
  const rootId = normalizeString(graph?.rootId);
  const relationAdjacency = buildLineageRelationAdjacency(graph);
  return listOf(graph?.nodes)
    .filter(node => normalizeString(node?.id) && normalizeString(node?.id) !== rootId)
    .map((node) => {
      const lineage = traceLineageNodeRelations(graph, node?.id, relationAdjacency);
      return { node, score: Math.max(0, lineage.downstreamIds.size - 1) };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || compareNode(a.node, b.node))
    .slice(0, Math.max(1, Math.trunc(Number(limit) || 5)));
};

export const renderLineageMapDockHtml = (graph = null, { expandedIds = [] } = {}) => {
  const expanded = new Set(listOf(expandedIds).map(normalizeString).filter(Boolean));
  const rootId = normalizeString(graph?.rootId);
  const categories = MAP_CATEGORY_DEFS.map((definition) => {
    const nodes = listOf(graph?.nodes)
      .filter(node => normalizeString(node?.id) !== rootId)
      .filter(node => definition.types.includes(normalizeString(node?.type)));
    const ids = new Set(nodes.map(node => normalizeString(node?.id)).filter(Boolean));
    const counts = summarizeEdgesForNodes(graph, ids);
    return { ...definition, count: nodes.length, status: statusFromCounts(counts) };
  }).filter(category => category.count);
  const impacts = buildLineageImpactNodes(graph, 5);
  const maxImpact = Math.max(1, ...impacts.map(item => item.score));
  return `
    <section class="lineage-layer-dock-card lineage-glass">
      <div class="lineage-dock-heading"><span>血缘分层</span>${lineageIconSvg('contexts')}</div>
      <div class="lineage-layer-list">
        ${categories.map((category, index) => `
          <button type="button" class="lineage-layer-item is-layer-${escHtml(category.id)}${expanded.has(category.id) ? ' is-expanded' : ''}"
            data-lineage-map-category="${escHtml(category.id)}" data-lineage-expanded="${expanded.has(category.id) ? 'true' : 'false'}"
            aria-expanded="${expanded.has(category.id) ? 'true' : 'false'}" aria-label="${expanded.has(category.id) ? '收合' : '展开'}${escHtml(category.label)}分层">
            <span class="lineage-layer-index">${String(index + 1).padStart(2, '0')}</span>
            <span class="lineage-layer-icon" aria-hidden="true">${lineageIconSvg(category.icon)}</span>
            <span class="lineage-layer-copy"><strong>${escHtml(category.label)}</strong><small>${escHtml(category.en)}</small></span>
            <span class="lineage-layer-count">${category.count}</span>
            <span class="lineage-layer-eye" aria-hidden="true">${expanded.has(category.id) ? '−' : '+'}</span>
          </button>
        `).join('')}
      </div>
      <p>点击分层可展开或收合对应节点，聚焦查看上下文来源。</p>
    </section>
    <section class="lineage-layer-dock-card lineage-glass lineage-impact-card">
      <div class="lineage-dock-heading"><span>影响面 TOP 5</span><span class="lineage-impact-flame" aria-hidden="true">◇</span></div>
      <div class="lineage-impact-list">
        ${impacts.length ? impacts.map(({ node, score }, index) => {
          const category = categoryForNode(node) || { id: 'contexts', icon: 'contexts' };
          return `
            <button type="button" class="lineage-impact-item is-layer-${escHtml(category.id)}"
              data-lineage-jump-node-id="${escHtml(node?.id)}" data-lineage-layer-id="${escHtml(category.id)}">
              <span class="lineage-impact-rank">${index + 1}</span>
              <span class="lineage-impact-icon" aria-hidden="true">${lineageIconSvg(category.icon)}</span>
              <span class="lineage-impact-copy"><strong data-i18n-skip>${escHtml(labelOfNode(node))}</strong><small>下游影响 ${score}</small></span>
              <span class="lineage-impact-meter"><i style="width:${Math.round(score / maxImpact * 100)}%"></i></span>
            </button>
          `;
        }).join('') : '<div class="lineage-impact-empty">暂无可计算的影响节点</div>'}
      </div>
    </section>
  `;
};

const renderLineageDetailRelation = (node = null, label = '', category = null) => {
  if (!node) return '';
  const resolvedCategory = category || categoryForNode(node) || { id: 'contexts', icon: 'contexts' };
  return `
    <button type="button" class="lineage-detail-relation is-layer-${escHtml(resolvedCategory.id)}"
      data-lineage-jump-node-id="${escHtml(node?.id)}" data-lineage-layer-id="${escHtml(resolvedCategory.id)}">
      <span class="lineage-detail-relation-icon" aria-hidden="true">${lineageIconSvg(resolvedCategory.icon)}</span>
      <span><strong data-i18n-skip>${escHtml(labelOfNode(node))}</strong><small>${escHtml(label || labelFor(NODE_TYPE_LABELS, node?.type))}</small></span>
      <b aria-hidden="true">↗</b>
    </button>
  `;
};

// 详情卡「打开」按钮的文字（按节点的跳转目标）
const openActionLabel = (kind = '') => {
  switch (kind) {
    case 'persona': return t('角色卡设置');
    case 'contact': return t('聊天设置');
    case 'group': return t('群聊设置');
    case 'creative': return t('进入创意写作');
    case 'worldbook': return t('编辑世界书');
    case 'preset': return t('打开预设');
    case 'regex': return t('打开正则');
    case 'memory': return t('查看记忆表格');
    case 'summary': return t('查看摘要');
    case 'variables': return t('变量管理');
    case 'moments': return t('打开动态');
    case 'moment_summary': return t('动态摘要');
    default: return t('打开设置');
  }
};

const renderLineageDetailActions = (node = null, { pathFromId = '', pathToId = '' } = {}) => {
  const id = normalizeString(node?.id);
  if (!id) return '';
  const openKind = normalizeString(node?.open?.kind);
  const isFrom = normalizeString(pathFromId) === id;
  const isTo = normalizeString(pathToId) === id;
  return `
    <div class="lineage-detail-actions">
      ${openKind ? `<button type="button" class="lineage-detail-action is-primary" data-lineage-open-node="${escHtml(id)}">${escHtml(openActionLabel(openKind))}<b aria-hidden="true">↗</b></button>` : ''}
      <button type="button" class="lineage-detail-action${isFrom ? ' is-active' : ''}" data-lineage-path-role="from" data-lineage-path-node="${escHtml(id)}" aria-pressed="${isFrom ? 'true' : 'false'}">${escHtml(isFrom ? t('已设为起点') : t('设为起点'))}</button>
      <button type="button" class="lineage-detail-action${isTo ? ' is-active' : ''}" data-lineage-path-role="to" data-lineage-path-node="${escHtml(id)}" aria-pressed="${isTo ? 'true' : 'false'}">${escHtml(isTo ? t('已设为终点') : t('设为终点'))}</button>
    </div>
  `;
};

// 诊断卡片复用：节点按钮（点了跳到该节点）与关系类型文字
export const renderLineageNodeJumpHtml = (node = null, note = '') => renderLineageDetailRelation(node, note);
export const getLineageEdgeTypeLabel = type => labelFor(EDGE_TYPE_LABELS, type);

export const renderLineageMapDetailHtml = (kind = '', item = null, graph = null, options = {}) => {
  if (!item) return '';
  const nodes = nodeByIdMap(graph);
  const isEdge = normalizeString(kind) === 'edge';
  const node = isEdge ? nodes.get(normalizeString(item?.source)) : item;
  const category = categoryForNode(node) || { id: 'contexts', icon: 'contexts', en: 'CONTEXT' };
  const status = isEdge
    ? (isRiskEdge(item, graph?.scopeId) ? 'risk' : (normalizeString(item?.status) || 'unknown'))
    : mapNodeStatus(node, graph);
  const fullText = isEdge ? formatLineageEdgeDetails(item, graph) : formatLineageNodeDetails(item);
  const directIncoming = uniqueNodesById(isEdge
    ? [nodes.get(normalizeString(item?.source))].filter(Boolean)
    : listOf(graph?.edges).filter(edge => normalizeString(edge?.target) === normalizeString(item?.id)).map(edge => nodes.get(normalizeString(edge?.source))).filter(Boolean));
  const directOutgoing = uniqueNodesById(isEdge
    ? [nodes.get(normalizeString(item?.target))].filter(Boolean)
    : listOf(graph?.edges).filter(edge => normalizeString(edge?.source) === normalizeString(item?.id)).map(edge => nodes.get(normalizeString(edge?.target))).filter(Boolean));
  const lineage = isEdge ? null : traceLineageNodeRelations(graph, item?.id);
  const incomingCount = isEdge ? directIncoming.length : Math.max(0, lineage.upstreamIds.size - 1);
  const outgoingCount = isEdge ? directOutgoing.length : Math.max(0, lineage.downstreamIds.size - 1);
  const title = isEdge
    ? `${labelOfNode(directIncoming[0])} → ${labelOfNode(directOutgoing[0])}`
    : labelOfNode(item);
  const stat = isEdge ? '' : normalizeString(item?.meta?.stat);
  const subtitle = isEdge
    ? labelFor(EDGE_TYPE_LABELS, item?.type)
    : [labelFor(NODE_TYPE_LABELS, item?.type), stat].filter(Boolean).join(' · ');
  const scope = normalizeString(isEdge ? item?.targetScopeId || item?.sourceScopeId : item?.scopeId) || 'default';
  const total = incomingCount + outgoingCount;
  const upstreamWidth = total ? Math.round(incomingCount / total * 100) : 50;
  return `
    <div class="lineage-map-detail-card is-layer-${escHtml(category.id)} is-${escHtml(status)}">
      <div class="lineage-detail-accent" aria-hidden="true"></div>
      <div class="lineage-detail-head">
        <span class="lineage-detail-icon" aria-hidden="true">${lineageIconSvg(category.icon)}</span>
        <span class="lineage-detail-heading">
          <span><b>${escHtml(category.en || category.id)}</b><i>${escHtml(labelFor(STATUS_LABELS, status))}</i></span>
          <strong data-i18n-skip>${escHtml(title)}</strong>
        </span>
        <button type="button" class="lineage-detail-close" data-lineage-detail-close="1" aria-label="关闭详情">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="lineage-detail-subtitle"><span>${escHtml(subtitle)}</span><code>${escHtml(scope)}</code></div>
      <div class="lineage-detail-impact-grid">
        <div class="is-upstream"><span>↗ 上游溯源</span><strong>${incomingCount}<small>节点</small></strong></div>
        <div class="is-downstream"><span>↙ 下游影响</span><strong>${outgoingCount}<small>节点</small></strong></div>
      </div>
      <div class="lineage-detail-spread">
        <span>血缘传播 <b>${total} 节点</b></span>
        <i><em style="width:${upstreamWidth}%"></em><b></b><em class="is-downstream"></em></i>
      </div>
      ${isEdge ? '' : renderLineageDetailActions(item, options)}
      ${directIncoming.length ? `<section class="lineage-detail-relations"><h4>直接上游 <b>${directIncoming.length}</b></h4>${directIncoming.slice(0, 5).map(parent => renderLineageDetailRelation(parent, '上游来源')).join('')}</section>` : ''}
      ${directOutgoing.length ? `<section class="lineage-detail-relations"><h4>直接下游 <b>${directOutgoing.length}</b></h4>${directOutgoing.slice(0, 5).map(child => renderLineageDetailRelation(child, '下游影响')).join('')}</section>` : ''}
      <details class="lineage-map-detail-full">
        <summary>完整资料</summary>
        <pre>${escHtml(fullText)}</pre>
      </details>
    </div>
  `;
};

const edgeTouchesNodeSet = (edge = {}, nodeIds = new Set()) => (
  nodeIds.has(normalizeString(edge?.source)) || nodeIds.has(normalizeString(edge?.target))
);

const statusFromCounts = ({
  risk = 0,
  blocked = 0,
  trimmed = 0,
  active = 0,
  candidate = 0,
} = {}) => {
  if (risk || blocked) return 'blocked';
  if (trimmed) return 'trimmed';
  if (active) return 'active';
  if (candidate) return 'candidate';
  return 'unknown';
};

const summarizeEdgesForNodes = (graph = null, nodeIds = new Set()) => {
  const counts = {
    active: 0,
    candidate: 0,
    blocked: 0,
    trimmed: 0,
    disabled: 0,
    unknown: 0,
    injects: 0,
    risk: 0,
  };
  listOf(graph?.edges).forEach((edge) => {
    if (!edgeTouchesNodeSet(edge, nodeIds)) return;
    const status = normalizeString(edge?.status) || 'unknown';
    counts[status] = Number(counts[status] || 0) + 1;
    if (normalizeString(edge?.type) === 'injects' && status === 'active') counts.injects += 1;
    if (isRiskEdge(edge, graph?.scopeId)) counts.risk += 1;
  });
  return counts;
};

const mapNodeStatus = (node = {}, graph = null) => {
  const scope = normalizeString(node?.scopeId);
  const graphScope = normalizeString(graph?.scopeId);
  if (scope && graphScope && scope !== graphScope) return 'blocked';
  return normalizeString(node?.status) || 'unknown';
};

const makeMapEdgePath = (source = {}, target = {}, {
  laneIndex = 0,
  laneCount = 1,
} = {}) => {
  const forward = Number(target?.x || 0) >= Number(source?.x || 0);
  const sourceX = Number(source?.x || 0) + (forward ? Number(source?.width || 0) / 2 : -Number(source?.width || 0) / 2);
  const targetX = Number(target?.x || 0) + (forward ? -Number(target?.width || 0) / 2 : Number(target?.width || 0) / 2);
  const laneOffset = (Number(laneIndex) - (Math.max(1, Number(laneCount) || 1) - 1) / 2) * 8;
  const sourceY = Number(source?.y || 0) + laneOffset;
  const targetY = Number(target?.y || 0) - laneOffset * 0.32;
  const delta = Math.max(76, Math.abs(targetX - sourceX) * 0.42);
  const c1x = sourceX + (forward ? delta : -delta);
  const c2x = targetX + (forward ? -delta : delta);
  return `M ${sourceX.toFixed(1)} ${sourceY.toFixed(1)} C ${c1x.toFixed(1)} ${sourceY.toFixed(1)}, ${c2x.toFixed(1)} ${targetY.toFixed(1)}, ${targetX.toFixed(1)} ${targetY.toFixed(1)}`;
};

const makeMapNode = ({
  id = '',
  label = '',
  meta = '',
  kind = 'item',
  status = 'unknown',
  x = 0,
  y = 0,
  width = 176,
  height = 58,
  nodeId = '',
  categoryId = '',
  moreCategoryId = '',
  layerId = '',
  lineageState = '',
  count = 0,
  flags = [],
} = {}) => ({
  id: normalizeString(id),
  label: normalizeString(label),
  meta: normalizeString(meta),
  kind: normalizeString(kind) || 'item',
  status: normalizeString(status) || 'unknown',
  x: Number(x) || 0,
  y: Number(y) || 0,
  width: Number(width) || 176,
  height: Number(height) || 58,
  nodeId: normalizeString(nodeId),
  categoryId: normalizeString(categoryId),
  moreCategoryId: normalizeString(moreCategoryId),
  layerId: normalizeString(layerId),
  lineageState: normalizeString(lineageState),
  count: Number(count) || 0,
  // key：同层分量最大的几个；cycle／path：诊断标出的循环与路径
  flags: listOf(flags).map(normalizeString).filter(Boolean),
});

// 节点卡片第二行：关系图节点带的数字（如「12 行 · 4 张表」），没有就显示类型
const mapNodeMeta = node => normalizeString(node?.meta?.stat) || labelFor(NODE_TYPE_LABELS, node?.type);

// 同层同类型的重点：分量 ≥2、不低于同类最大值的四分之一，每类最多 3 个（如预设按共用会话数、正则按规则数各自比）
const pickKeyNodeIds = (nodes = []) => {
  const byType = new Map();
  listOf(nodes).filter(node => nodeWeight(node) >= 2).forEach((node) => {
    const type = normalizeString(node?.type);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push(node);
  });
  const keyIds = new Set();
  byType.forEach((list) => {
    const sorted = list.sort((a, b) => nodeWeight(b) - nodeWeight(a));
    const max = nodeWeight(sorted[0]);
    sorted.filter(node => nodeWeight(node) >= max / 4).slice(0, 3).forEach(node => keyIds.add(normalizeString(node?.id)));
  });
  return keyIds;
};

const toIdSet = value => new Set((value instanceof Set ? Array.from(value) : listOf(value)).map(normalizeString).filter(Boolean));

const shouldRenderLineageMapEdge = (edge = {}, model = {}, nodeByMapId = new Map()) => {
  if (!normalizeString(edge?.path)) return false;
  const kind = normalizeString(edge?.kind);
  if (kind !== 'contains') return true;
  const focusId = normalizeString(model?.focusId);
  if (!focusId) return false;
  const source = nodeByMapId.get(normalizeString(edge?.sourceId));
  const target = nodeByMapId.get(normalizeString(edge?.targetId));
  return normalizeString(source?.nodeId) === focusId || normalizeString(target?.nodeId) === focusId;
};

let lineageElkConstructorPromise = null;
let lineageElkInstancePromise = null;

const loadLineageElkConstructor = async () => {
  if (typeof globalThis === 'undefined') return null;
  if (typeof globalThis.ELK === 'function') return globalThis.ELK;
  const doc = globalThis.document;
  if (!doc?.createElement) return null;
  if (!lineageElkConstructorPromise) {
    lineageElkConstructorPromise = new Promise((resolve) => {
      const finish = (script = null) => {
        const ElkCtor = typeof globalThis.ELK === 'function' ? globalThis.ELK : null;
        if (!ElkCtor) script?.remove?.();
        resolve(ElkCtor);
      };
      const existing = doc.querySelector('script[data-lineage-elk-loader="true"]');
      if (existing) {
        existing.addEventListener('load', () => finish(existing), { once: true });
        existing.addEventListener('error', () => finish(existing), { once: true });
        return;
      }
      const script = doc.createElement('script');
      script.src = new URL(LINEAGE_ELK_SCRIPT_URL, import.meta.url).href;
      script.async = true;
      script.dataset.lineageElkLoader = 'true';
      script.onload = () => finish(script);
      script.onerror = () => finish(script);
      doc.head.appendChild(script);
    });
  }
  const pending = lineageElkConstructorPromise;
  let ElkCtor = null;
  try {
    ElkCtor = await pending;
  } catch {}
  if (lineageElkConstructorPromise === pending && typeof ElkCtor !== 'function') {
    lineageElkConstructorPromise = null;
  }
  return ElkCtor;
};

const getLineageElkInstance = async (elkConstructor = null) => {
  const ElkCtor = elkConstructor || await loadLineageElkConstructor();
  if (typeof ElkCtor !== 'function') return null;
  if (elkConstructor) return new ElkCtor();
  if (!lineageElkInstancePromise) {
    lineageElkInstancePromise = Promise.resolve(new ElkCtor());
  }
  return lineageElkInstancePromise;
};

export const buildLineageMapSceneModel = (graph = null, {
  focusId = '',
  expandedIds = [],
  maxItemsPerCategory = 12,
  categoryItemLimits = {},
  maxNeighbors = 36,
  cycleNodeIds = [],
  pathNodeIds = [],
  pathEdgeIds = [],
} = {}) => {
  const nodes = listOf(graph?.nodes);
  const cycleIds = toIdSet(cycleNodeIds);
  const pathIds = toIdSet(pathNodeIds);
  const pathEdges = toIdSet(pathEdgeIds);
  const diagnosticFlags = (nodeId = '') => [
    cycleIds.has(nodeId) ? 'cycle' : '',
    pathIds.has(nodeId) ? 'path' : '',
  ].filter(Boolean);
  const rootId = normalizeString(graph?.rootId);
  const nodeById = nodeByIdMap(graph);
  const rootNode = nodeById.get(rootId) || nodes.find(node => normalizeString(node?.type) === 'prompt') || nodes[0] || null;
  const rootMapId = rootNode ? `node:${normalizeString(rootNode.id)}` : 'root:empty';
  const expanded = new Set(listOf(expandedIds).map(normalizeString).filter(Boolean));
  const focus = normalizeString(focusId);
  const focusNode = nodeById.get(focus) || null;
  const lineage = traceLineageNodeRelations(graph, focus);
  const rootLineage = traceLineageNodeRelations(graph, rootNode?.id);
  const mapNodes = [];
  const mapEdges = [];
  const baseItemLimit = Math.max(1, Math.trunc(Number(maxItemsPerCategory) || 12));
  const itemLimits = categoryItemLimits && typeof categoryItemLimits === 'object' ? categoryItemLimits : {};
  const itemGap = 110;
  const categoryGap = 36;

  const categoryRows = MAP_CATEGORY_DEFS
    .map((definition) => {
      const categoryNodes = nodes
        .filter((node) => normalizeString(node?.id) !== normalizeString(rootNode?.id))
        .filter((node) => definition.types.includes(normalizeString(node?.type)));
      const ids = new Set(categoryNodes.map(node => normalizeString(node?.id)).filter(Boolean));
      const counts = summarizeEdgesForNodes(graph, ids);
      const sortedNodes = categoryNodes.sort(compareNode);
      const expandedRow = expanded.has(definition.id);
      const configuredLimit = itemLimits instanceof Map
        ? itemLimits.get(definition.id)
        : itemLimits?.[definition.id];
      const itemLimit = Math.max(baseItemLimit, Math.trunc(Number(configuredLimit) || baseItemLimit));
      const visibleCount = expandedRow ? Math.min(sortedNodes.length, itemLimit) : 0;
      const hasMore = expandedRow && sortedNodes.length > visibleCount;
      const itemSlots = visibleCount + (hasMore ? 1 : 0);
      return {
        ...definition,
        nodes: sortedNodes,
        nodeIds: ids,
        counts,
        expanded: expandedRow,
        visibleCount,
        itemLimit,
        hasMore,
        keyIds: pickKeyNodeIds(sortedNodes),
        bandHeight: expandedRow ? Math.max(112, itemSlots * itemGap + 24) : 98,
        status: statusFromCounts(counts),
      };
    })
    .filter(category => category.nodes.length);

  const sceneTop = 120;
  const totalBandHeight = categoryRows.reduce((sum, category, index) => (
    sum + category.bandHeight + (index > 0 ? categoryGap : 0)
  ), 0);
  const rootY = Math.max(320, sceneTop + totalBandHeight / 2);
  const rootMapNode = makeMapNode({
    id: rootMapId,
    label: rootNode ? labelOfNode(rootNode) : '当前上下文',
    meta: rootNode ? labelFor(NODE_TYPE_LABELS, rootNode.type) : '上下文',
    kind: 'root',
    status: rootNode ? mapNodeStatus(rootNode, graph) : 'active',
    x: 320,
    y: rootY,
    width: 236,
    height: 92,
    nodeId: rootNode ? normalizeString(rootNode.id) : '',
    layerId: categoryForNode(rootNode)?.id || 'prompts',
    lineageState: lineageStateForNodeId(rootNode?.id, lineage),
  });
  mapNodes.push(rootMapNode);

  let cursorY = sceneTop;
  categoryRows.forEach((category, index) => {
    if (index > 0) cursorY += categoryGap;
    const y = cursorY + category.bandHeight / 2;
    cursorY += category.bandHeight;
    const keyNode = category.nodes.find(node => category.keyIds.has(normalizeString(node?.id)));
    const meta = category.counts.risk
      ? `${category.counts.risk} 风险`
      : category.counts.injects
        ? `${category.counts.injects} 注入`
        : category.counts.candidate
          ? `${category.counts.candidate} 候选`
          : keyNode
            ? t('重点 {name}', { name: truncate(labelOfNode(keyNode), 14) })
            : `${category.nodes.length}`;
    const categoryFlags = ['cycle', 'path'].filter(flag => category.nodes.some(node => (
      diagnosticFlags(normalizeString(node?.id)).includes(flag)
    )));
    const categoryNode = makeMapNode({
      id: `category:${category.id}`,
      label: category.label,
      meta,
      kind: 'category',
      status: category.status,
      x: 700,
      y,
      width: 210,
      height: 78,
      categoryId: category.id,
      layerId: category.id,
      lineageState: focus
        ? (category.nodes.some(node => {
          const state = lineageStateForNodeId(node?.id, lineage);
          return state && state !== 'dim';
        }) ? 'related' : 'dim')
        : '',
      count: category.nodes.length,
      flags: categoryFlags,
    });
    mapNodes.push(categoryNode);
    const hasRootToCategory = category.nodes.some(node => rootLineage.downstreamIds.has(normalizeString(node?.id)));
    const hasCategoryToRoot = category.nodes.some(node => rootLineage.upstreamIds.has(normalizeString(node?.id)));
    if (hasRootToCategory) {
      mapEdges.push({
        id: `map-edge-root-${category.id}-out`,
        sourceId: rootMapNode.id,
        targetId: categoryNode.id,
        status: category.status,
        kind: 'aggregate',
        lineageState: focus && categoryNode.lineageState === 'dim' ? 'dim' : (focus ? 'active' : ''),
      });
    }
    if (hasCategoryToRoot) {
      mapEdges.push({
        id: `map-edge-root-${category.id}-in`,
        sourceId: categoryNode.id,
        targetId: rootMapNode.id,
        status: category.status,
        kind: 'aggregate',
        lineageState: focus && categoryNode.lineageState === 'dim' ? 'dim' : (focus ? 'active' : ''),
      });
    }

    if (!category.expanded) return;
    const visibleItems = category.nodes.slice(0, category.itemLimit);
    const itemSlots = visibleItems.length + (category.hasMore ? 1 : 0);
    const itemStartY = y - Math.max(0, itemSlots - 1) * itemGap / 2;
    visibleItems.forEach((node, itemIndex) => {
      const nodeId = normalizeString(node?.id);
      const itemNode = makeMapNode({
        id: `item:${nodeId}`,
        label: labelOfNode(node),
        meta: mapNodeMeta(node),
        kind: nodeId === focus ? 'focus' : 'item',
        status: mapNodeStatus(node, graph),
        x: 1080,
        y: itemStartY + itemIndex * itemGap,
        width: 236,
        height: 84,
        nodeId,
        layerId: category.id,
        lineageState: lineageStateForNodeId(nodeId, lineage),
        flags: [category.keyIds.has(nodeId) ? 'key' : '', ...diagnosticFlags(nodeId)],
      });
      mapNodes.push(itemNode);
      mapEdges.push({
        id: `map-edge-${category.id}-${nodeId}`,
        sourceId: categoryNode.id,
        targetId: itemNode.id,
        status: itemNode.status,
        kind: 'contains',
        lineageState: focus && itemNode.lineageState === 'dim' ? 'dim' : (focus ? 'active' : ''),
      });
    });
    if (category.hasMore) {
      const moreNode = makeMapNode({
        id: `more:${category.id}`,
        label: `+${category.nodes.length - visibleItems.length}`,
        meta: '更多',
        kind: 'more',
        status: 'unknown',
        x: 1080,
        y: itemStartY + visibleItems.length * itemGap,
        width: 132,
        height: 52,
        layerId: category.id,
        moreCategoryId: category.id,
        lineageState: focus ? 'dim' : '',
      });
      mapNodes.push(moreNode);
      mapEdges.push({
        id: `map-edge-${category.id}-more`,
        sourceId: categoryNode.id,
        targetId: moreNode.id,
        status: 'unknown',
        kind: 'contains',
        lineageState: focus ? 'dim' : '',
      });
    }
  });

  if (focusNode) {
    const mapNodeByGraphNodeId = new Map(
      mapNodes
        .filter(node => normalizeString(node?.nodeId))
        .map(node => [normalizeString(node.nodeId), node]),
    );
    let focusMapNode = mapNodeByGraphNodeId.get(focus);
    if (!focusMapNode) {
      focusMapNode = makeMapNode({
        id: `focus:${focus}`,
        label: labelOfNode(focusNode),
        meta: mapNodeMeta(focusNode),
        kind: 'focus',
        status: mapNodeStatus(focusNode, graph),
        x: 1080,
        y: rootY,
        width: 236,
        height: 84,
        nodeId: focus,
        layerId: categoryForNode(focusNode)?.id || 'contexts',
        lineageState: 'self',
        flags: diagnosticFlags(focus),
      });
      mapNodes.push(focusMapNode);
      mapNodeByGraphNodeId.set(focus, focusMapNode);
    } else {
      focusMapNode.lineageState = 'self';
      if (focusMapNode.kind === 'item') focusMapNode.kind = 'focus';
    }

    const closureIds = new Set([
      ...lineage.upstreamIds,
      ...lineage.downstreamIds,
    ]);
    closureIds.delete(focus);
    const directIds = new Set([
      ...lineage.directUpstreamIds,
      ...lineage.directDownstreamIds,
    ]);
    const relatedNodes = uniqueNodesById(
      Array.from(closureIds)
        .map(id => nodeById.get(id))
        .filter(Boolean),
    ).sort((a, b) => {
      // 诊断路径上的节点排最前（相关节点有数量上限，路径不能被截掉）
      const pathDelta = Number(pathIds.has(normalizeString(b?.id))) - Number(pathIds.has(normalizeString(a?.id)));
      const directDelta = Number(directIds.has(normalizeString(b?.id))) - Number(directIds.has(normalizeString(a?.id)));
      return pathDelta || directDelta || compareNode(a, b);
    });
    const neighborLimit = Math.max(1, Math.trunc(Number(maxNeighbors) || relatedNodes.length || 1));
    const visibleRelatedNodes = relatedNodes.slice(0, neighborLimit);
    const relatedGap = 102;
    const relatedStartY = focusMapNode.y - Math.max(0, visibleRelatedNodes.length - 1) * relatedGap / 2;
    visibleRelatedNodes.forEach((node, index) => {
      const nodeId = normalizeString(node?.id);
      if (mapNodeByGraphNodeId.has(nodeId)) return;
      const state = lineageStateForNodeId(nodeId, lineage);
      const relatedNode = makeMapNode({
        id: `related:${nodeId}`,
        label: labelOfNode(node),
        meta: mapNodeMeta(node),
        kind: 'related',
        status: mapNodeStatus(node, graph),
        x: state === 'up' ? focusMapNode.x - 360 : focusMapNode.x + 360,
        y: relatedStartY + index * relatedGap,
        width: 220,
        height: 78,
        nodeId,
        layerId: categoryForNode(node)?.id || 'contexts',
        lineageState: state,
        flags: diagnosticFlags(nodeId),
      });
      mapNodes.push(relatedNode);
      mapNodeByGraphNodeId.set(nodeId, relatedNode);
    });

    const visibleGraphNodeIds = new Set(mapNodeByGraphNodeId.keys());
    const realEdgeIds = new Set();
    listOf(graph?.edges).forEach((edge, index) => {
      const sourceId = normalizeString(edge?.source);
      const targetId = normalizeString(edge?.target);
      if (!visibleGraphNodeIds.has(sourceId) || !visibleGraphNodeIds.has(targetId)) return;
      if (!closureIds.has(sourceId) && sourceId !== focus) return;
      if (!closureIds.has(targetId) && targetId !== focus) return;
      const edgeId = normalizeString(edge?.id);
      const identity = edgeId || `${sourceId}->${targetId}:${normalizeString(edge?.type)}:${index}`;
      if (realEdgeIds.has(identity)) return;
      realEdgeIds.add(identity);
      mapEdges.push({
        id: edgeId || `map-edge-lineage-${makeSvgId(identity)}`,
        sourceId: mapNodeByGraphNodeId.get(sourceId).id,
        targetId: mapNodeByGraphNodeId.get(targetId).id,
        status: normalizeString(edge?.status) || 'unknown',
        kind: 'related',
        edgeId,
        isRisk: isRiskEdge(edge, graph?.scopeId),
        isPath: pathEdges.has(edgeId),
        lineageState: lineageStateForEdge(edge, lineage),
      });
    });
  }

  const mapNodeById = new Map(mapNodes.map(node => [node.id, node]));
  const edgeLaneBySource = new Map();
  mapEdges.forEach((edge) => {
    const key = normalizeString(edge.sourceId);
    if (!edgeLaneBySource.has(key)) edgeLaneBySource.set(key, []);
    edgeLaneBySource.get(key).push(edge);
  });
  const renderedEdges = mapEdges
    .map((edge) => {
      const source = mapNodeById.get(edge.sourceId);
      const target = mapNodeById.get(edge.targetId);
      if (!source || !target) return null;
      const laneGroup = edgeLaneBySource.get(normalizeString(edge.sourceId)) || [];
      return {
        ...edge,
        path: makeMapEdgePath(source, target, {
          laneIndex: Math.max(0, laneGroup.indexOf(edge)),
          laneCount: laneGroup.length,
        }),
      };
    })
    .filter(Boolean);
  const right = Math.max(1180, ...mapNodes.map(node => node.x + node.width / 2 + 140));
  const bottom = Math.max(640, ...mapNodes.map(node => node.y + node.height / 2 + 100));
  const top = Math.min(80, ...mapNodes.map(node => node.y - node.height / 2 - 80));
  const offsetY = Math.min(0, top);
  const shiftedNodes = mapNodes.map(node => ({ ...node, y: node.y - offsetY }));
  const shiftedNodeById = new Map(shiftedNodes.map(node => [node.id, node]));
  const shiftedEdges = renderedEdges.map((edge) => {
    const source = shiftedNodeById.get(edge.sourceId);
    const target = shiftedNodeById.get(edge.targetId);
    const laneGroup = edgeLaneBySource.get(normalizeString(edge.sourceId)) || [];
    return source && target
      ? {
        ...edge,
        path: makeMapEdgePath(source, target, {
          laneIndex: Math.max(0, laneGroup.indexOf(edge)),
          laneCount: laneGroup.length,
        }),
      }
      : edge;
  });
  return {
    width: Math.ceil(right),
    height: Math.ceil(bottom - offsetY),
    offsetY,
    nodes: shiftedNodes,
    edges: shiftedEdges,
    expandedIds: Array.from(expanded),
    focusId: focus,
  };
};

const toElkLayoutGraph = (model = null) => ({
  id: 'lineage-map',
  layoutOptions: {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.edgeRouting': 'SPLINES',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.spacing.nodeNode': '34',
    'elk.layered.spacing.nodeNodeBetweenLayers': '138',
    'elk.layered.spacing.edgeNodeBetweenLayers': '28',
    'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.layered.mergeEdges': 'true',
    'elk.padding': '[top=90,left=90,bottom=90,right=90]',
  },
  children: listOf(model?.nodes).map((node) => ({
    id: normalizeString(node?.id),
    width: Number(node?.width || 176),
    height: Number(node?.height || 58),
    ports: [
      {
        id: `${normalizeString(node?.id)}:in`,
        width: 2,
        height: 2,
        layoutOptions: { 'elk.port.side': 'WEST' },
      },
      {
        id: `${normalizeString(node?.id)}:out`,
        width: 2,
        height: 2,
        layoutOptions: { 'elk.port.side': 'EAST' },
      },
    ],
    layoutOptions: {
      'elk.portConstraints': 'FIXED_SIDE',
    },
  })),
  edges: listOf(model?.edges).map((edge) => ({
    id: normalizeString(edge?.id),
    sources: [`${normalizeString(edge?.sourceId)}:out`],
    targets: [`${normalizeString(edge?.targetId)}:in`],
  })),
});

const mergeElkLayoutIntoMapModel = (model = null, elkGraph = null) => {
  const elkNodeById = new Map(listOf(elkGraph?.children).map(node => [normalizeString(node?.id), node]));
  const nodes = listOf(model?.nodes).map((node) => {
    const elkNode = elkNodeById.get(normalizeString(node?.id));
    if (!elkNode) return node;
    const width = Number(elkNode.width || node.width || 176);
    const height = Number(elkNode.height || node.height || 58);
    return {
      ...node,
      x: Number(elkNode.x || 0) + width / 2,
      y: Number(elkNode.y || 0) + height / 2,
      width,
      height,
    };
  });
  const nodeByMapId = new Map(nodes.map(node => [normalizeString(node?.id), node]));
  const edgeLaneBySource = new Map();
  listOf(model?.edges).forEach((edge) => {
    const key = normalizeString(edge?.sourceId);
    if (!edgeLaneBySource.has(key)) edgeLaneBySource.set(key, []);
    edgeLaneBySource.get(key).push(edge);
  });
  const edges = listOf(model?.edges).map((edge) => {
    const source = nodeByMapId.get(normalizeString(edge?.sourceId));
    const target = nodeByMapId.get(normalizeString(edge?.targetId));
    const laneGroup = edgeLaneBySource.get(normalizeString(edge?.sourceId)) || [];
    return source && target
      ? {
        ...edge,
        path: makeMapEdgePath(source, target, {
          laneIndex: Math.max(0, laneGroup.indexOf(edge)),
          laneCount: laneGroup.length,
        }),
        layoutEngine: 'curve',
      }
      : edge;
  });
  const right = Math.max(760, Number(elkGraph?.width || 0) + 40, ...nodes.map(node => node.x + node.width / 2 + 90));
  const bottom = Math.max(420, Number(elkGraph?.height || 0) + 40, ...nodes.map(node => node.y + node.height / 2 + 90));
  return {
    ...model,
    width: Math.ceil(right),
    height: Math.ceil(bottom),
    nodes,
    edges,
    layoutEngine: 'elk',
  };
};

export const buildLineageMapSceneModelWithElk = async (graph = null, options = {}) => {
  const fallbackModel = buildLineageMapSceneModel(graph, options);
  try {
    const elk = await getLineageElkInstance(options.elkConstructor || null);
    if (!elk?.layout) return { ...fallbackModel, layoutEngine: 'fallback' };
    const elkGraph = await elk.layout(toElkLayoutGraph(fallbackModel));
    return mergeElkLayoutIntoMapModel(fallbackModel, elkGraph);
  } catch {
    return { ...fallbackModel, layoutEngine: 'fallback' };
  }
};

const edgeLabel = (edge = {}, nodes = new Map()) => {
  const source = nodes.get(normalizeString(edge?.source));
  const target = nodes.get(normalizeString(edge?.target));
  return `${labelOfNode(source)} → ${labelOfNode(target)}`;
};

const renderBadge = (label = '', value = '', className = '') => (
  `<span class="lineage-mini-badge ${escHtml(className)}"><span>${escHtml(label)}</span><b>${escHtml(value)}</b></span>`
);

const renderGraphCard = ({
  title = '',
  value = '',
  hint = '',
  className = '',
  nodeId = '',
  edgeId = '',
} = {}) => {
  const attrs = [
    nodeId ? `data-lineage-node-id="${escHtml(nodeId)}"` : '',
    edgeId ? `data-lineage-edge-id="${escHtml(edgeId)}"` : '',
  ].filter(Boolean).join(' ');
  return `
    <button type="button" class="lineage-readable-card ${escHtml(className)}" ${attrs}>
      <span class="lineage-readable-title">${escHtml(title)}</span>
      <strong>${escHtml(value)}</strong>
      ${hint ? `<span class="lineage-readable-hint">${escHtml(hint)}</span>` : ''}
    </button>
  `;
};

const renderEdgeList = (graph = null, edges = [], emptyText = '暂无记录') => {
  const nodes = nodeByIdMap(graph);
  const list = listOf(edges).slice(0, 10);
  if (!list.length) return `<div class="lineage-readable-empty">${escHtml(emptyText)}</div>`;
  return list.map((edge) => renderGraphCard({
    title: edgeLabel(edge, nodes),
    value: `${labelFor(EDGE_TYPE_LABELS, edge?.type)} · ${labelFor(STATUS_LABELS, edge?.status)}`,
    hint: normalizeString(edge?.reason) || 'default',
    className: `is-${normalizeString(edge?.status) || 'unknown'}${isRiskEdge(edge, graph?.scopeId) ? ' is-risk' : ''}`,
    edgeId: normalizeString(edge?.id),
  })).join('');
};

const summarizeWorldbookGroups = (graph = null) => {
  const nodes = nodeByIdMap(graph);
  const groups = new Map();
  listOf(graph?.edges).forEach((edge) => {
    const source = nodes.get(normalizeString(edge?.source));
    if (normalizeString(source?.type) !== 'worldbook_entry') return;
    const worldId = normalizeString(source?.meta?.worldId || source?.id || 'unknown');
    const sourceKind = normalizeString(source?.meta?.sourceKind || 'session') || 'session';
    const key = `${sourceKind}:${worldId}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        worldId,
        sourceKind,
        label: `${sourceKind === 'global' ? '全局' : sourceKind === 'role' ? '角色' : sourceKind === 'builtin' ? '内置' : '会话'}世界书 ${worldId}`,
        active: 0,
        candidate: 0,
        blocked: 0,
        trimmed: 0,
        unknown: 0,
      });
    }
    const group = groups.get(key);
    const status = normalizeString(edge?.status) || 'unknown';
    group[status] = Number(group[status] || 0) + 1;
  });
  return Array.from(groups.values()).sort((a, b) => (b.active + b.candidate + b.trimmed + b.blocked) - (a.active + a.candidate + a.trimmed + a.blocked));
};

export const renderLineageOverviewHtml = (graph = null) => {
  const summary = summarizeLineageGraph(graph);
  const nodes = listOf(graph?.nodes);
  const edges = listOf(graph?.edges);
  const injectedEdges = edges.filter(edge => normalizeString(edge?.type) === 'injects' && normalizeString(edge?.status) === 'active');
  const blockedEdges = edges.filter(edge => ['blocked', 'trimmed', 'disabled'].includes(normalizeString(edge?.status)));
  const riskEdges = edges.filter(edge => isRiskEdge(edge, graph?.scopeId));
  const worldGroups = summarizeWorldbookGroups(graph).slice(0, 8);
  const activeSignalLabel = injectedEdges.length ? '已注入' : '启用边';
  const activeSignalCount = injectedEdges.length || edgeStatusCount(summary, 'active');
  const statCards = [
    ['联系人', nodeTypeCount(summary, 'contact')],
    ['群聊', nodeTypeCount(summary, 'group_chat')],
    ['世界书', nodeTypeCount(summary, 'worldbook')],
    ['条目', nodeTypeCount(summary, 'worldbook_entry')],
    ['画像', nodeTypeCount(summary, 'contact_profile')],
    ['记忆行', nodeTypeCount(summary, 'memory_row')],
    [activeSignalLabel, activeSignalCount],
    ['风险', summary.riskCount],
  ];
  return `
    <div class="lineage-readable-view lineage-overview-view">
      <div class="lineage-overview-stats">
        ${statCards.map(([label, value]) => renderGraphCard({ title: label, value: String(value), hint: label === '风险' && value ? '需要检查' : '' })).join('')}
      </div>
      <div class="lineage-readable-grid">
        <section class="lineage-readable-section">
          <h4>世界书聚合</h4>
          ${worldGroups.length
            ? worldGroups.map(group => renderGraphCard({
                title: group.label,
                value: `${group.active} 注入 / ${group.candidate} 候选`,
                hint: `${group.trimmed} 裁剪 / ${group.blocked} 阻止`,
                className: group.blocked || group.trimmed ? 'is-trimmed' : 'is-active',
              })).join('')
            : '<div class="lineage-readable-empty">暂无世界书条目聚合</div>'}
        </section>
        <section class="lineage-readable-section">
          <h4>已注入</h4>
          ${renderEdgeList(graph, injectedEdges, '暂无实际注入边')}
        </section>
        <section class="lineage-readable-section">
          <h4>阻止 / 裁剪</h4>
          ${renderEdgeList(graph, blockedEdges, '暂无阻止或裁剪')}
        </section>
        <section class="lineage-readable-section">
          <h4>风险</h4>
          ${renderEdgeList(graph, riskEdges, '暂无风险边')}
        </section>
      </div>
      <div class="lineage-readable-note">
        ${renderBadge('scope', summary.scopeId)}
        ${renderBadge('mode', summary.mode)}
        ${renderBadge('节点', nodes.length)}
        ${renderBadge('边', edges.length)}
      </div>
    </div>
  `;
};

const collectPipelineItems = (graph = null) => {
  const nodes = nodeByIdMap(graph);
  const edges = listOf(graph?.edges);
  const rootId = normalizeString(graph?.rootId);
  const scopeNodes = listOf(graph?.nodes).filter(node => {
    const type = normalizeString(node?.type);
    return normalizeString(node?.id) === rootId
      || ['persona_card', 'private_chat', 'group_chat', 'moment', 'creative_session', 'forum_board', 'forum_thread', 'prompt'].includes(type);
  });
  const candidateEdges = edges.filter(edge => normalizeString(edge?.type) === 'candidate_for' || normalizeString(edge?.status) === 'candidate');
  const triggerEdges = edges.filter(edge => normalizeString(edge?.type) === 'triggers');
  const injectedEdges = edges.filter(edge => normalizeString(edge?.type) === 'injects' && normalizeString(edge?.status) === 'active');
  const blockedEdges = edges.filter(edge => ['blocked', 'trimmed', 'disabled'].includes(normalizeString(edge?.status)) || isRiskEdge(edge, graph?.scopeId));
  const toNodeCards = list => list.slice(0, 8).map(node => renderGraphCard({
    title: labelFor(NODE_TYPE_LABELS, node?.type),
    value: labelOfNode(node),
    hint: normalizeString(node?.scopeId) || normalizeString(graph?.scopeId) || 'default',
    className: `is-${normalizeString(node?.status) || 'unknown'}`,
    nodeId: normalizeString(node?.id),
  })).join('') || '<div class="lineage-readable-empty">暂无</div>';
  const toEdgeCards = (list, empty = '暂无') => renderEdgeList(graph, list, empty);
  return {
    scope: toNodeCards(scopeNodes),
    candidates: toEdgeCards(candidateEdges, '暂无候选来源'),
    triggers: toEdgeCards(triggerEdges, '暂无触发边'),
    injected: toEdgeCards(injectedEdges, '暂无注入边'),
    blocked: toEdgeCards(blockedEdges, '暂无阻止/裁剪/风险'),
  };
};

export const renderLineagePipelineHtml = (graph = null) => {
  const items = collectPipelineItems(graph);
  return `
    <div class="lineage-readable-view lineage-pipeline-view">
      <div class="lineage-pipeline-stage">
        <h4>当前范围</h4>
        ${items.scope}
      </div>
      <div class="lineage-pipeline-arrow">→</div>
      <div class="lineage-pipeline-stage">
        <h4>候选来源</h4>
        ${items.candidates}
      </div>
      <div class="lineage-pipeline-arrow">→</div>
      <div class="lineage-pipeline-stage">
        <h4>触发 / 筛选</h4>
        ${items.triggers}
      </div>
      <div class="lineage-pipeline-arrow">→</div>
      <div class="lineage-pipeline-stage">
        <h4>已注入</h4>
        ${items.injected}
      </div>
      <div class="lineage-pipeline-arrow">→</div>
      <div class="lineage-pipeline-stage is-risk-stage">
        <h4>阻止 / 裁剪 / 风险</h4>
        ${items.blocked}
      </div>
    </div>
  `;
};

export const renderLineageMapSceneHtml = (graph = null, options = {}) => {
  const model = buildLineageMapSceneModel(graph, options);
  return renderLineageMapSceneModelHtml(model);
};

export const renderLineageMapSceneHtmlAsync = async (graph = null, options = {}) => {
  const model = await buildLineageMapSceneModelWithElk(graph, options);
  return renderLineageMapSceneModelHtml(model);
};

const renderLineageMapSceneModelHtml = (model = null) => {
  if (!model.nodes.length) {
    return '<div class="lineage-graph-empty">暂无血缘图节点</div>';
  }
  const nodeByMapId = new Map(model.nodes.map(node => [normalizeString(node?.id), node]));
  const visibleEdges = model.edges.filter(edge => shouldRenderLineageMapEdge(edge, model, nodeByMapId));
  const markerStatuses = ['active', 'candidate', 'blocked', 'trimmed', 'disabled', 'unknown', 'risk', 'lineage-up', 'lineage-down', 'lineage-both'];
  const edgeDefs = `
    <defs>
      <pattern id="lineage-map-dots" width="30" height="30" patternUnits="userSpaceOnUse">
        <circle cx="1.5" cy="1.5" r="1.2" fill="var(--lineage-dot-grid)" />
      </pattern>
      <linearGradient id="lineage-edge-gradient-active"><stop offset="0%" stop-color="var(--lineage-active-start)"/><stop offset="100%" stop-color="var(--lineage-active)"/></linearGradient>
      <linearGradient id="lineage-edge-gradient-candidate"><stop offset="0%" stop-color="var(--lineage-accent)"/><stop offset="100%" stop-color="var(--lineage-violet)"/></linearGradient>
      <linearGradient id="lineage-edge-gradient-blocked"><stop offset="0%" stop-color="var(--lineage-warning)"/><stop offset="100%" stop-color="var(--lineage-danger)"/></linearGradient>
      <linearGradient id="lineage-edge-gradient-trimmed"><stop offset="0%" stop-color="var(--lineage-warning-soft-strong)"/><stop offset="100%" stop-color="var(--lineage-warning)"/></linearGradient>
      <linearGradient id="lineage-edge-gradient-disabled"><stop offset="0%" stop-color="var(--lineage-edge-muted)"/><stop offset="100%" stop-color="var(--lineage-muted)"/></linearGradient>
      <linearGradient id="lineage-edge-gradient-unknown"><stop offset="0%" stop-color="var(--lineage-edge-muted)"/><stop offset="100%" stop-color="var(--lineage-accent-soft-strong)"/></linearGradient>
      <linearGradient id="lineage-edge-gradient-risk"><stop offset="0%" stop-color="var(--lineage-warning)"/><stop offset="100%" stop-color="var(--lineage-danger)"/></linearGradient>
      <filter id="lineage-edge-glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="2.2" result="blur"/>
        <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      ${markerStatuses.map(status => `
        <marker id="lineage-map-arrow-${status}" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M1,1 L8,4 L1,7" class="lineage-map-arrow is-${status}" />
        </marker>
      `).join('')}
    </defs>
  `;
  const layerXs = Array.from(new Set(model.nodes.map(node => Math.round(Number(node?.x) || 0)))).sort((a, b) => a - b);
  const layerGuides = layerXs.slice(1).map((x, index) => {
    const previous = layerXs[index];
    const guideX = (previous + x) / 2;
    return `<line class="lineage-map-layer-guide" x1="${guideX}" y1="46" x2="${guideX}" y2="${Math.max(46, Number(model.height) - 46)}" />`;
  }).join('');
  const edgeHtml = visibleEdges.map((edge, index) => {
    const status = normalizeString(edge?.status) || 'unknown';
    const directionalMarker = ['up', 'down', 'both'].includes(normalizeString(edge?.lineageState))
      ? `lineage-${normalizeString(edge.lineageState)}`
      : '';
    const markerStatus = directionalMarker || (edge?.isRisk ? 'risk' : (markerStatuses.includes(status) ? status : 'unknown'));
    const particleStatus = edge?.isRisk ? 'risk' : (markerStatuses.includes(status) ? status : 'unknown');
    const riskClass = `${edge?.isRisk ? ' is-risk' : ''}${edge?.isPath ? ' is-path' : ''}`;
    const kindClass = edge?.kind ? ` is-${escHtml(normalizeString(edge.kind))}` : '';
    const lineageClass = edge?.lineageState ? ` is-lineage-${escHtml(normalizeString(edge.lineageState))}` : '';
    const edgeAttr = edge?.edgeId ? ` data-lineage-edge-id="${escHtml(edge.edgeId)}"` : '';
    const source = nodeByMapId.get(normalizeString(edge?.sourceId));
    const target = nodeByMapId.get(normalizeString(edge?.targetId));
    const statusLabel = edge?.isRisk ? STATUS_LABELS.risk : labelFor(STATUS_LABELS, status);
    const tooltip = `${labelOfNode(source)} → ${labelOfNode(target)} · ${statusLabel}`;
    const interactiveAttrs = edge?.edgeId
      ? ` role="button" tabindex="0" aria-label="${escHtml(tooltip)}"`
      : '';
    const delay = Math.min(640, index * 46);
    const duration = 2.5 + (index % 4) * 0.52;
    const particles = edge?.lineageState === 'dim' ? '' : `
      <circle class="lineage-map-particle is-${particleStatus}" r="3">
        <animateMotion dur="${duration.toFixed(2)}s" begin="${(index % 5 * 0.38).toFixed(2)}s" repeatCount="indefinite" path="${escHtml(edge?.path)}" />
      </circle>
      <circle class="lineage-map-particle-core" r="1.35">
        <animateMotion dur="${duration.toFixed(2)}s" begin="${(index % 5 * 0.38).toFixed(2)}s" repeatCount="indefinite" path="${escHtml(edge?.path)}" />
      </circle>
    `;
    return `
      <g class="lineage-map-edge-group is-${escHtml(status)}${riskClass}${kindClass}${lineageClass}"${edgeAttr}${interactiveAttrs}
        data-lineage-edge-label="${escHtml(tooltip)}" style="--lineage-edge-delay:${delay}ms;--lineage-edge-duration:${duration.toFixed(2)}s">
        <title>${escHtml(tooltip)}</title>
        <path class="lineage-map-link-hit" d="${escHtml(edge?.path)}" />
        <path class="lineage-map-link is-${escHtml(status)}${riskClass}${kindClass}${lineageClass}" d="${escHtml(edge?.path)}"
          marker-end="url(#lineage-map-arrow-${markerStatus})" />
        ${particles}
      </g>
    `;
  }).join('');
  const outgoingMapIds = new Set(visibleEdges.map(edge => normalizeString(edge?.sourceId)));
  const incomingMapIds = new Set(visibleEdges.map(edge => normalizeString(edge?.targetId)));
  const nodeHtml = model.nodes.map((node, index) => {
    const status = normalizeString(node?.status) || 'unknown';
    const layerId = normalizeString(node?.layerId) || 'contexts';
    const category = MAP_CATEGORY_DEFS.find(item => item.id === layerId) || { icon: 'contexts', en: 'CONTEXT' };
    const attrs = [
      node.nodeId ? `data-lineage-node-id="${escHtml(node.nodeId)}"` : '',
      node.categoryId ? `data-lineage-map-category="${escHtml(node.categoryId)}"` : '',
      node.moreCategoryId ? `data-lineage-show-more-category="${escHtml(node.moreCategoryId)}"` : '',
      node.categoryId && model.expandedIds.includes(node.categoryId) ? 'data-lineage-expanded="true"' : '',
      node.categoryId ? `aria-expanded="${model.expandedIds.includes(node.categoryId) ? 'true' : 'false'}"` : '',
      `data-lineage-layer-id="${escHtml(layerId)}"`,
    ].filter(Boolean).join(' ');
    const style = `left:${Number(node.x).toFixed(1)}px;top:${Number(node.y).toFixed(1)}px;width:${Number(node.width).toFixed(1)}px;min-height:${Number(node.height).toFixed(1)}px;--lineage-node-delay:${Math.min(680, 120 + index * 38)}ms;`;
    const count = node.count ? `<span class="lineage-map-count">${escHtml(node.count)}</span>` : '';
    const mapId = normalizeString(node?.id);
    const inPort = incomingMapIds.has(mapId) ? '<span class="lineage-node-port is-in" aria-hidden="true"></span>' : '';
    const outPort = outgoingMapIds.has(mapId) ? '<span class="lineage-node-port is-out" aria-hidden="true"></span>' : '';
    const isInteractive = Boolean(node.nodeId || node.categoryId || node.moreCategoryId);
    const lineageClass = node?.lineageState ? ` is-lineage-${escHtml(normalizeString(node.lineageState))}` : '';
    const flags = listOf(node?.flags);
    const flagClass = flags.map(flag => ` is-${escHtml(flag)}`).join('');
    const flagChips = [
      flags.includes('key') ? `<em class="lineage-node-flag is-key">${escHtml(t('重点'))}</em>` : '',
      flags.includes('cycle') ? `<em class="lineage-node-flag is-cycle">${escHtml(t('循环'))}</em>` : '',
      flags.includes('path') && node.kind !== 'category' ? `<em class="lineage-node-flag is-path">${escHtml(t('路径'))}</em>` : '',
    ].join('');
    const ariaLabel = node.moreCategoryId
      ? `显示${node.label}个${category.label || '节点'}`
      : node.categoryId
        ? `${model.expandedIds.includes(node.categoryId) ? '收合' : '展开'}${node.label}`
        : `${node.label}，状态：${labelFor(STATUS_LABELS, status)}`;
    return `
      <div class="lineage-map-node is-${escHtml(node.kind)} is-${escHtml(status)} is-layer-${escHtml(layerId)}${lineageClass}${flagClass}" ${attrs}
        role="${isInteractive ? 'button' : 'img'}" tabindex="${isInteractive ? '0' : '-1'}" aria-label="${escHtml(ariaLabel)}" style="${escHtml(style)}">
        <span class="lineage-node-topline" aria-hidden="true"></span>
        ${inPort}${outPort}
        <span class="lineage-map-node-icon" aria-hidden="true">${lineageIconSvg(node.kind === 'root' ? 'prompts' : category.icon)}</span>
        <span class="lineage-map-text">
          <span class="lineage-map-node-eyebrow"><b>${escHtml(category.en || layerId)}</b><i class="is-${escHtml(status)}">${escHtml(labelFor(STATUS_LABELS, status))}</i>${flagChips}</span>
          <strong data-i18n-skip>${escHtml(truncate(node.label, node.kind === 'root' ? 26 : 20))}</strong>
          ${node.meta ? `<small data-i18n-skip>${escHtml(truncate(node.meta, 24))}</small>` : ''}
        </span>
        ${count}
      </div>
    `;
  }).join('');
  const minimapNodes = model.nodes.map(node => `
    <rect class="lineage-minimap-node is-${escHtml(node?.status || 'unknown')} is-layer-${escHtml(node?.layerId || 'contexts')}${node?.lineageState ? ` is-lineage-${escHtml(node.lineageState)}` : ''}"
      x="${(Number(node?.x) - Number(node?.width) / 2).toFixed(1)}" y="${(Number(node?.y) - Number(node?.height) / 2).toFixed(1)}"
      width="${Number(node?.width).toFixed(1)}" height="${Number(node?.height).toFixed(1)}" rx="10" />
  `).join('');
  return `
    <div class="lineage-map-scene" style="width:${Number(model.width)}px;height:${Number(model.height)}px;">
      <svg class="lineage-map-links" viewBox="0 0 ${Number(model.width)} ${Number(model.height)}" role="group" aria-label="血缘关系连线">
        ${edgeDefs}
        <rect class="lineage-map-world-dots" x="0" y="0" width="${Number(model.width)}" height="${Number(model.height)}" fill="url(#lineage-map-dots)" />
        <g class="lineage-map-layer-guides">${layerGuides}</g>
        ${edgeHtml}
      </svg>
      ${nodeHtml}
    </div>
    <template data-lineage-minimap-template data-lineage-world-width="${Number(model.width)}" data-lineage-world-height="${Number(model.height)}">
      <svg class="lineage-minimap-svg" viewBox="0 0 ${Number(model.width)} ${Number(model.height)}" aria-label="血缘图小地图">
        ${minimapNodes}
        <rect class="lineage-minimap-viewport" x="0" y="0" width="0" height="0" rx="14" />
      </svg>
    </template>
  `;
};

export const buildLineageGraphViewModel = (graph = null, options = {}) => {
  const sourceGraph = graph && typeof graph === 'object' ? graph : {};
  const { nodes, edges } = buildVisibleGraph(sourceGraph, options);
  const rootId = normalizeString(sourceGraph.rootId);
  const nodeWidth = 190;
  const nodeHeight = 58;
  const columnGap = 94;
  const rowGap = 24;
  const marginX = 42;
  const marginY = 44;
  const columns = new Map();
  nodes.forEach((node) => {
    const column = getNodeColumn(node, rootId);
    if (!columns.has(column)) columns.set(column, []);
    columns.get(column).push(node);
  });
  columns.forEach(list => list.sort(compareNode));
  const positionedNodes = [];
  Array.from(columns.keys()).sort((a, b) => a - b).forEach((column) => {
    const list = columns.get(column) || [];
    list.forEach((node, index) => {
      positionedNodes.push({
        ...node,
        x: marginX + column * (nodeWidth + columnGap),
        y: marginY + index * (nodeHeight + rowGap),
        width: nodeWidth,
        height: nodeHeight,
        column,
      });
    });
  });
  const nodeById = new Map(positionedNodes.map(node => [normalizeString(node?.id), node]));
  const positionedEdges = edges
    .map((edge) => {
      const source = nodeById.get(normalizeString(edge?.source));
      const target = nodeById.get(normalizeString(edge?.target));
      if (!source || !target) return null;
      const sourceX = source.x + source.width;
      const sourceY = source.y + source.height / 2;
      const targetX = target.x;
      const targetY = target.y + target.height / 2;
      const delta = Math.max(48, Math.abs(targetX - sourceX) * 0.45);
      const c1x = sourceX + delta;
      const c2x = targetX - delta;
      const path = `M ${sourceX} ${sourceY} C ${c1x} ${sourceY}, ${c2x} ${targetY}, ${targetX} ${targetY}`;
      return {
        ...edge,
        path,
        labelX: (sourceX + targetX) / 2,
        labelY: (sourceY + targetY) / 2,
        isRisk: isRiskEdge(edge, sourceGraph.scopeId),
      };
    })
    .filter(Boolean);
  const width = Math.max(760, ...positionedNodes.map(node => node.x + node.width + marginX));
  const height = Math.max(420, ...positionedNodes.map(node => node.y + node.height + marginY));
  return {
    graph: sourceGraph,
    summary: summarizeLineageGraph(sourceGraph),
    statusFilter: normalizeString(options.statusFilter || 'all') || 'all',
    nodeTypeFilter: normalizeString(options.nodeTypeFilter || 'all') || 'all',
    nodes: positionedNodes,
    edges: positionedEdges,
    width,
    height,
    truncated: {
      nodes: listOf(sourceGraph?.nodes).length > positionedNodes.length,
      edges: listOf(sourceGraph?.edges).length > positionedEdges.length,
    },
  };
};

export const renderLineageGraphSvg = (model = null) => {
  const nodes = listOf(model?.nodes);
  const edges = listOf(model?.edges);
  if (!nodes.length && !edges.length) {
    return '<div class="lineage-graph-empty">暂无血缘图节点</div>';
  }
  const markerIds = ['active', 'candidate', 'blocked', 'trimmed', 'disabled', 'unknown', 'risk']
    .map(status => `lineage-arrow-${status}`);
  const defs = `
    <defs>
      ${markerIds.map((id) => `
        <marker id="${id}" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L0,6 L8,3 z" class="lineage-arrow-head ${id.replace('lineage-arrow-', 'is-')}" />
        </marker>
      `).join('')}
    </defs>
  `;
  const edgeHtml = edges.map((edge, index) => {
    const status = normalizeString(edge?.status) || 'unknown';
    const marker = edge?.isRisk ? 'risk' : status;
    const typeLabel = truncate(labelFor(EDGE_TYPE_LABELS, edge?.type), 8);
    return `
      <g class="lineage-edge is-${escHtml(status)}${edge?.isRisk ? ' is-risk' : ''}" data-lineage-edge-id="${escHtml(edge?.id || `edge-${index}`)}">
        <path d="${escHtml(edge?.path)}" marker-end="url(#lineage-arrow-${escHtml(marker)})" />
        <text x="${Number(edge?.labelX || 0).toFixed(1)}" y="${Number(edge?.labelY || 0).toFixed(1)}">${escHtml(typeLabel)}</text>
      </g>
    `;
  }).join('');
  const nodeHtml = nodes.map((node) => {
    const status = normalizeString(node?.status) || 'unknown';
    const label = truncate(node?.label || node?.id, 18);
    const type = truncate(labelFor(NODE_TYPE_LABELS, node?.type), 14);
    const scope = normalizeString(node?.scopeId);
    const graphScope = normalizeString(model?.graph?.scopeId);
    const isRisk = Boolean(scope && graphScope && scope !== graphScope);
    return `
      <g class="lineage-node is-${escHtml(status)}${isRisk ? ' is-risk' : ''}" data-lineage-node-id="${escHtml(node?.id)}" transform="translate(${Number(node?.x || 0).toFixed(1)} ${Number(node?.y || 0).toFixed(1)})">
        <rect width="${Number(node?.width || 190)}" height="${Number(node?.height || 58)}" rx="8" ry="8" />
        <circle cx="16" cy="17" r="5" />
        <text class="lineage-node-label" x="28" y="20">${escHtml(label)}</text>
        <text class="lineage-node-meta" x="14" y="42">${escHtml(type)} · ${escHtml(labelFor(STATUS_LABELS, status))}</text>
      </g>
    `;
  }).join('');
  return `
    <svg class="lineage-graph-svg" viewBox="0 0 ${Number(model?.width || 760)} ${Number(model?.height || 420)}" role="img" aria-label="上下文血缘节点图">
      ${defs}
      <g class="lineage-edge-layer">${edgeHtml}</g>
      <g class="lineage-node-layer">${nodeHtml}</g>
    </svg>
  `;
};

export const formatLineageNodeDetails = (node = null) => {
  if (!node || typeof node !== 'object') return '请选择一个节点或一条边查看详情。';
  const meta = node.meta && typeof node.meta === 'object' ? node.meta : {};
  const lines = [
    `节点：${normalizeString(node.label || node.id)}`,
    `类型：${labelFor(NODE_TYPE_LABELS, node.type)} (${normalizeString(node.type) || 'unknown'})`,
    `状态：${labelFor(STATUS_LABELS, node.status)} (${normalizeString(node.status) || 'unknown'})`,
    `scope：${normalizeString(node.scopeId) || 'default'}`,
    node.summary ? `摘要：${normalizeString(node.summary)}` : '',
    `id：${normalizeString(node.id)}`,
  ].filter(Boolean);
  const metaLines = Object.entries(meta)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.join(', ') : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      return `meta.${key}：${text}`;
    });
  return [...lines, ...metaLines].join('\n');
};

export const formatLineageEdgeDetails = (edge = null, graph = null) => {
  if (!edge || typeof edge !== 'object') return '请选择一个节点或一条边查看详情。';
  const nodes = listOf(graph?.nodes);
  const nodeById = new Map(nodes.map(node => [normalizeString(node?.id), node]));
  const labelOf = id => normalizeString(nodeById.get(normalizeString(id))?.label || id);
  const evidence = edge.evidence && typeof edge.evidence === 'object' ? edge.evidence : {};
  const budget = edge.budget && typeof edge.budget === 'object' ? edge.budget : {};
  const lines = [
    `边：${labelOf(edge.source)} → ${labelOf(edge.target)}`,
    `关系：${labelFor(EDGE_TYPE_LABELS, edge.type)} (${normalizeString(edge.type) || 'unknown'})`,
    `状态：${labelFor(STATUS_LABELS, edge.status)} (${normalizeString(edge.status) || 'unknown'})`,
    `原因：${normalizeString(edge.reason) || 'unknown'}`,
    Number.isFinite(Number(edge.score)) ? `分数：${Number(edge.score)}` : '',
    Number.isFinite(Number(edge.priority)) ? `优先级：${Number(edge.priority)}` : '',
    `sourceScope：${normalizeString(edge.sourceScopeId) || 'default'}`,
    `targetScope：${normalizeString(edge.targetScopeId) || 'default'}`,
    isCrossScopeEdge(edge, graph?.scopeId) ? '风险：跨角色卡 scope 边' : '',
    `id：${normalizeString(edge.id)}`,
  ].filter(Boolean);
  const evidenceLines = Object.entries(evidence)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const text = Array.isArray(value) ? value.join(', ') : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      return `evidence.${key}：${text}`;
    });
  const budgetLines = Object.entries(budget)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `budget.${key}：${value}`);
  return [...lines, ...evidenceLines, ...budgetLines].join('\n');
};

export const getLineageGraphItem = (graph = null, kind = '', id = '') => {
  const key = normalizeString(id);
  if (!key) return null;
  if (kind === 'edge') return listOf(graph?.edges).find(edge => normalizeString(edge?.id) === key) || null;
  return listOf(graph?.nodes).find(node => normalizeString(node?.id) === key) || null;
};

const makeMermaidIdMap = (nodes = []) => {
  const used = new Set();
  const map = new Map();
  nodes.forEach((node, index) => {
    const base = `N_${makeSvgId(node?.id || index)}`.slice(0, 48);
    let id = base;
    let suffix = 1;
    while (used.has(id)) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(id);
    map.set(normalizeString(node?.id), id);
  });
  return map;
};

// Mermaid 引号内的文字：引号写成 #quot;，换行用 <br/>（\n 和 \" 它都不认）
const mermaidText = value => normalizeString(value).replace(/"/g, '#quot;');

export const exportLineageGraphMermaid = (graph = null) => {
  const nodes = listOf(graph?.nodes);
  const edges = listOf(graph?.edges);
  const idMap = makeMermaidIdMap(nodes);
  const lines = [
    'flowchart LR',
    `%% scope: ${normalizeString(graph?.scopeId) || 'default'}, mode: ${normalizeString(graph?.mode) || 'unknown'}`,
  ];
  nodes.forEach((node) => {
    const id = idMap.get(normalizeString(node?.id));
    if (!id) return;
    lines.push(`  ${id}["${mermaidText(node?.label || node?.id)}<br/>${mermaidText(labelFor(NODE_TYPE_LABELS, node?.type))}"]`);
  });
  edges.forEach((edge) => {
    const source = idMap.get(normalizeString(edge?.source));
    const target = idMap.get(normalizeString(edge?.target));
    if (!source || !target) return;
    const label = mermaidText([labelFor(EDGE_TYPE_LABELS, edge?.type), labelFor(STATUS_LABELS, edge?.status), normalizeString(edge?.reason)]
      .filter(Boolean)
      .join(' / '));
    lines.push(`  ${source} -->|"${label}"| ${target}`);
  });
  return lines.join('\n');
};

// DOT 的引号字符串可放任意文字：直接用原 id（中文 id 不会被换成同一个下划线 id 而撞在一起）
const dotText = value => normalizeString(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export const exportLineageGraphDot = (graph = null) => {
  const nodes = listOf(graph?.nodes);
  const edges = listOf(graph?.edges);
  const lines = [
    'digraph ContextLineageGraph {',
    '  rankdir=LR;',
    `  label="scope: ${dotText(graph?.scopeId) || 'default'} / mode: ${dotText(graph?.mode) || 'unknown'}";`,
  ];
  nodes.forEach((node) => {
    const label = [node?.label || node?.id, labelFor(NODE_TYPE_LABELS, node?.type), labelFor(STATUS_LABELS, node?.status)].map(dotText).join('\\n');
    lines.push(`  "${dotText(node?.id)}" [label="${label}"];`);
  });
  edges.forEach((edge) => {
    const label = dotText([labelFor(EDGE_TYPE_LABELS, edge?.type), labelFor(STATUS_LABELS, edge?.status), normalizeString(edge?.reason)]
      .filter(Boolean)
      .join(' / '));
    lines.push(`  "${dotText(edge?.source)}" -> "${dotText(edge?.target)}" [label="${label}"];`);
  });
  lines.push('}');
  return lines.join('\n');
};

const nodeMatchesQuery = (node = {}, query = '') => {
  const q = normalizeString(query).toLowerCase();
  if (!q) return false;
  return [
    node?.id,
    node?.label,
    node?.type,
    node?.summary,
    node?.meta?.sessionId,
    node?.meta?.contactId,
    node?.meta?.worldId,
    node?.meta?.entryId,
  ].some(value => normalizeString(value).toLowerCase().includes(q));
};

const formatPathText = (path = {}, nodeById = new Map()) => {
  const parts = [];
  listOf(path.edges).forEach((edge, index) => {
    const source = index === 0 ? normalizeString(edge?.source) : '';
    if (source) parts.push(normalizeString(nodeById.get(source)?.label || source));
    parts.push(`${labelFor(EDGE_TYPE_LABELS, edge?.type)}(${labelFor(STATUS_LABELS, edge?.status)}:${normalizeString(edge?.reason) || 'unknown'})`);
    parts.push(normalizeString(nodeById.get(normalizeString(edge?.target))?.label || edge?.target));
  });
  return parts.join(' -> ');
};

export const findLineagePaths = (graph = null, {
  query = '',
  targetId = '',
  maxDepth = 7,
  maxPaths = 8,
} = {}) => {
  const nodes = listOf(graph?.nodes);
  const edges = listOf(graph?.edges);
  const nodeById = new Map(nodes.map(node => [normalizeString(node?.id), node]));
  const resolvedTargetId = normalizeString(targetId || graph?.rootId);
  const normalizedQuery = normalizeString(query);
  const riskSources = new Set(
    edges
      .filter(edge => isRiskEdge(edge, graph?.scopeId))
      .map(edge => normalizeString(edge?.source))
      .filter(Boolean)
  );
  const startNodes = nodes.filter((node) => {
    const id = normalizeString(node?.id);
    if (!id || id === resolvedTargetId) return false;
    if (normalizedQuery) return nodeMatchesQuery(node, normalizedQuery);
    return riskSources.has(id);
  });
  const outEdges = new Map();
  edges.forEach((edge) => {
    const source = normalizeString(edge?.source);
    const target = normalizeString(edge?.target);
    if (!source || !target) return;
    if (!outEdges.has(source)) outEdges.set(source, []);
    outEdges.get(source).push(edge);
  });
  const paths = [];
  const depthLimit = Math.max(1, Math.trunc(Number(maxDepth) || 7));
  const pathLimit = Math.max(1, Math.trunc(Number(maxPaths) || 8));
  const visit = (nodeId, pathEdges = [], visited = new Set()) => {
    if (paths.length >= pathLimit) return;
    if (pathEdges.length > depthLimit) return;
    if (nodeId === resolvedTargetId && pathEdges.length) {
      paths.push({
        startId: normalizeString(pathEdges[0]?.source),
        targetId: resolvedTargetId,
        edges: pathEdges.slice(),
        text: formatPathText({ edges: pathEdges }, nodeById),
      });
      return;
    }
    if (visited.has(nodeId)) return;
    const nextVisited = new Set(visited);
    nextVisited.add(nodeId);
    const nextEdges = outEdges.get(nodeId) || [];
    nextEdges.forEach((edge) => {
      const target = normalizeString(edge?.target);
      if (!target) return;
      visit(target, [...pathEdges, edge], nextVisited);
    });
  };
  startNodes.forEach((node) => {
    if (paths.length >= pathLimit) return;
    visit(normalizeString(node?.id), [], new Set());
  });
  return {
    query: normalizedQuery,
    targetId: resolvedTargetId,
    paths,
    startCount: startNodes.length,
  };
};

export const detectLineageCycles = (graph = null, {
  maxCycles = 8,
  maxDepth = 64,
  maxVisits = 10000,
} = {}) => {
  const edges = listOf(graph?.edges);
  const outEdges = new Map();
  edges.forEach((edge) => {
    const source = normalizeString(edge?.source);
    const target = normalizeString(edge?.target);
    if (!source || !target) return;
    if (!outEdges.has(source)) outEdges.set(source, []);
    outEdges.get(source).push(edge);
  });
  const cycles = [];
  // 每个节点都会当一次起点，同一个环会从不同入口被找到多次：按环上的边去重
  const cycleKeys = new Set();
  const limit = Math.max(1, Math.trunc(Number(maxCycles) || 8));
  const depthLimit = Math.max(1, Math.trunc(Number(maxDepth) || 64));
  const visitLimit = Math.max(1, Math.trunc(Number(maxVisits) || 10000));
  let visits = 0;
  const dfs = (nodeId, stack = [], seen = new Set()) => {
    if (cycles.length >= limit || visits >= visitLimit || stack.length > depthLimit) return;
    visits += 1;
    if (seen.has(nodeId)) {
      const start = stack.findIndex(edge => normalizeString(edge?.source) === nodeId);
      if (start < 0) return;
      const cycle = stack.slice(start);
      const key = cycle
        .map(edge => normalizeString(edge?.id) || `${normalizeString(edge?.source)}->${normalizeString(edge?.target)}:${normalizeString(edge?.type)}`)
        .sort()
        .join('|');
      if (cycleKeys.has(key)) return;
      cycleKeys.add(key);
      cycles.push(cycle);
      return;
    }
    const nextSeen = new Set(seen);
    nextSeen.add(nodeId);
    for (const edge of outEdges.get(nodeId) || []) {
      if (cycles.length >= limit || visits >= visitLimit) break;
      dfs(normalizeString(edge?.target), [...stack, edge], nextSeen);
    }
  };
  for (const nodeId of outEdges.keys()) {
    if (cycles.length >= limit || visits >= visitLimit) break;
    dfs(nodeId);
  }
  return cycles.slice(0, limit).map(edgesInCycle => ({
    edges: edgesInCycle,
    text: edgesInCycle.map(edge => `${normalizeString(edge?.source)} -> ${normalizeString(edge?.target)}`).join(' -> '),
  }));
};

export const formatLineagePathDiagnostics = (result = null, graph = null) => {
  const paths = listOf(result?.paths);
  const cycles = detectLineageCycles(graph, { maxCycles: 3 });
  const header = normalizeString(result?.query)
    ? `路径诊断：${normalizeString(result.query)} -> ${normalizeString(result?.targetId) || 'root'}`
    : `风险路径诊断 -> ${normalizeString(result?.targetId) || 'root'}`;
  const lines = [
    header,
    `起点候选：${Number(result?.startCount || 0)}`,
    `路径数量：${paths.length}`,
  ];
  if (!paths.length) {
    lines.push('未找到可达路径。');
  } else {
    paths.forEach((path, index) => {
      lines.push(`${index + 1}. ${path.text || formatPathText(path, new Map(listOf(graph?.nodes).map(node => [normalizeString(node?.id), node])))}`);
    });
  }
  if (cycles.length) {
    lines.push('', `循环关系：${cycles.length}`);
    cycles.forEach((cycle, index) => lines.push(`${index + 1}. ${cycle.text}`));
  }
  return lines.join('\n');
};
