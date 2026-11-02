// 角色卡关系图（头像菜单「关系图」）：以当前角色卡为根，画出它的联系人／群聊／创意写作，
// 以及各会话用到的世界书、预设与正则、记忆、摘要、变量和动态。
// 只做汇总（纯函数）：资料由 app.js 读好传进来。同一类资料按会话聚合成一个节点、不逐行展开，
// 节点数只随会话数增长；节点带 weight（行数／变量数／共用会话数）与 stat（卡片上显示的数字），
// 供图上排序与标出重点；open 是「打开设置」的跳转目标。
import { t } from '../../i18n/index.js';
import { memoryRoomOf } from '../../memory/memory-overview-model.js';
import {
  LINEAGE_EDGE_STATUS,
  LINEAGE_EDGE_TYPES,
  LINEAGE_NODE_TYPES,
  LINEAGE_TRIGGER_REASONS,
  createLineageGraphBuilder,
} from './context-lineage-graph-utils.js';

const trim = value => String(value ?? '').trim();
const listOf = value => (Array.isArray(value) ? value : []);
const countOf = value => Math.max(0, Math.trunc(Number(value) || 0));

const ACTIVE = LINEAGE_EDGE_STATUS.ACTIVE;

export const buildPersonaLineageTrace = ({
  at = Date.now(),
  scopeId: rawScopeId = '',
  persona = {},
  contacts = [],
  getContact = () => null,
  profiles = [],
  resolveWorldState = () => ({}),
  // { sessionId, label }：当前角色卡的创意写作会话
  creative = null,
  // (sessionId, { mode }) => { presetId, name, source, enabled } | null
  resolvePreset = () => null,
  regexSets = [],
  globalRegexCount = 0,
  sessionRegexCount = () => 0,
  // sessionId => { summaryCount, compacted, variableCount, sharedVariables }
  getSessionStats = () => ({}),
  globalVariableCount = 0,
  // { templateId, rows, tableNames: { [tableId]: name } }：只统计当前模板的行（与记忆总览一致）
  memory = null,
  getSessionLabel = sessionId => sessionId,
  moments = [],
  // { count, compacted }
  momentSummary = null,
} = {}) => {
  const scopeId = trim(rawScopeId) || 'default';
  const personaId = trim(persona?.id || scopeId || 'default') || 'default';
  const rootId = `persona:${personaId}`;
  const builder = createLineageGraphBuilder({ scopeId, mode: 'persona', rootId, generatedAt: at });
  const annotations = new Map();
  const annotate = (nodeId, patch = {}) => annotations.set(nodeId, { ...(annotations.get(nodeId) || {}), ...patch });
  // sessionId → 图上的会话节点（记忆按会话挂回去）
  const sessionNodes = new Map();
  const addEdge = (source, target, type, reason = LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED, extra = {}) => builder.addEdge({
    source,
    target,
    type,
    status: ACTIVE,
    reason,
    sourceScopeId: scopeId,
    targetScopeId: scopeId,
    ...extra,
  });

  builder.addNode({
    id: rootId,
    type: LINEAGE_NODE_TYPES.PERSONA_CARD,
    label: trim(persona?.name) || t('当前角色卡'),
    status: ACTIVE,
    scopeId,
    meta: { personaId },
    open: { kind: 'persona' },
  });

  // 世界书：同一本被几个会话用到，就是它的分量
  const worldUsers = new Map();
  const addWorldBinding = (ownerNodeId, worldId, sourceKind = 'session') => {
    const wid = trim(worldId);
    if (!wid) return;
    const worldNodeId = `worldbook:${wid}`;
    builder.addNode({
      id: worldNodeId,
      type: LINEAGE_NODE_TYPES.WORLDBOOK,
      label: sourceKind === 'global'
        ? t('全局世界书 {name}', { name: wid })
        : sourceKind === 'role' ? t('角色世界书 {name}', { name: wid }) : t('会话世界书 {name}', { name: wid }),
      status: ACTIVE,
      scopeId,
      meta: { worldId: wid, sourceKind },
      open: { kind: 'worldbook', id: wid },
    });
    addEdge(
      ownerNodeId,
      worldNodeId,
      LINEAGE_EDGE_TYPES.BINDS,
      sourceKind === 'session' ? LINEAGE_TRIGGER_REASONS.MANUAL_BINDING : LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED,
      { evidence: { sourceKind } },
    );
    if (!worldUsers.has(worldNodeId)) worldUsers.set(worldNodeId, new Set());
    worldUsers.get(worldNodeId).add(ownerNodeId);
  };
  const addWorldState = (ownerNodeId, state = {}) => {
    listOf(state.globalWorldIds).forEach(worldId => addWorldBinding(ownerNodeId, worldId, 'global'));
    listOf(state.roleWorldIds).forEach(worldId => addWorldBinding(ownerNodeId, worldId, 'role'));
    listOf(state.sessionWorldIds).forEach(worldId => addWorldBinding(ownerNodeId, worldId, 'session'));
  };

  const addContactNode = (contact = {}, { status = ACTIVE } = {}) => {
    const id = trim(contact?.id);
    if (!id) return '';
    const isGroup = Boolean(contact?.isGroup) || id.startsWith('group:');
    const nodeId = isGroup ? `group:${id}` : `contact:${id}`;
    builder.addNode({
      id: nodeId,
      type: isGroup ? LINEAGE_NODE_TYPES.GROUP_CHAT : LINEAGE_NODE_TYPES.CONTACT,
      label: trim(contact?.name || id) || id,
      status,
      scopeId,
      meta: {
        sessionId: id,
        isGroup,
        memberCount: Array.isArray(contact?.members) ? contact.members.length : 0,
      },
      open: { kind: isGroup ? 'group' : 'contact', id },
    });
    return nodeId;
  };

  // 预设：同一个预设被几个会话用到；正则规则集挂在它绑定的预设或世界书下面
  const presetUsers = new Map();
  const addPresetBinding = (ownerNodeId, sessionId, mode) => {
    const preset = resolvePreset(sessionId, { mode });
    const presetId = trim(preset?.presetId);
    if (!presetId) return;
    const presetNodeId = `preset:${presetId}`;
    builder.addNode({
      id: presetNodeId,
      type: LINEAGE_NODE_TYPES.PRESET,
      label: trim(preset?.name) || presetId,
      status: preset?.enabled === false ? LINEAGE_EDGE_STATUS.DISABLED : ACTIVE,
      scopeId,
      meta: { presetId },
      open: { kind: 'preset', id: presetId },
    });
    const source = trim(preset?.source);
    addEdge(
      ownerNodeId,
      presetNodeId,
      LINEAGE_EDGE_TYPES.BINDS,
      source === 'session' ? LINEAGE_TRIGGER_REASONS.MANUAL_BINDING : LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED,
      {
        status: preset?.enabled === false ? LINEAGE_EDGE_STATUS.DISABLED : ACTIVE,
        evidence: { source },
      },
    );
    if (!presetUsers.has(presetNodeId)) presetUsers.set(presetNodeId, new Set());
    presetUsers.get(presetNodeId).add(ownerNodeId);
  };

  // 共用全局变量的会话（会话设置「共享变量」）
  const globalVariableUsers = new Set();
  const globalVariablesNodeId = 'variables:global';
  const addSessionResources = (sessionNodeId, sessionId, { mode = 'chat', label = '' } = {}) => {
    sessionNodes.set(sessionId, sessionNodeId);
    addPresetBinding(sessionNodeId, sessionId, mode);
    const regexCount = countOf(sessionRegexCount(sessionId));
    if (regexCount) {
      const regexNodeId = `regex:session:${sessionId}`;
      builder.addNode({
        id: regexNodeId,
        type: LINEAGE_NODE_TYPES.REGEX,
        label: t('会话正则 · {name}', { name: label || sessionId }),
        status: ACTIVE,
        scopeId,
        meta: { sessionId, ruleCount: regexCount, weight: regexCount, stat: t('{count} 条规则', { count: regexCount }) },
        open: { kind: 'regex' },
      });
      addEdge(sessionNodeId, regexNodeId, LINEAGE_EDGE_TYPES.CONTAINS);
    }
    const stats = getSessionStats(sessionId) || {};
    const summaryCount = countOf(stats.summaryCount);
    if (summaryCount || stats.compacted) {
      const summaryNodeId = `summary:${sessionId}`;
      builder.addNode({
        id: summaryNodeId,
        type: LINEAGE_NODE_TYPES.SUMMARY,
        label: t('摘要 · {name}', { name: label || sessionId }),
        status: ACTIVE,
        scopeId,
        meta: {
          sessionId,
          summaryCount,
          compacted: Boolean(stats.compacted),
          weight: summaryCount + (stats.compacted ? 1 : 0),
          stat: [summaryCount ? t('{count} 条', { count: summaryCount }) : '', stats.compacted ? t('已压缩') : ''].filter(Boolean).join(' · '),
        },
        open: { kind: 'summary', id: sessionId },
      });
      addEdge(sessionNodeId, summaryNodeId, LINEAGE_EDGE_TYPES.CONTAINS);
    }
    const variableCount = countOf(stats.variableCount);
    if (variableCount) {
      const variablesNodeId = `variables:${sessionId}`;
      builder.addNode({
        id: variablesNodeId,
        type: LINEAGE_NODE_TYPES.VARIABLE_SCOPE,
        label: t('会话变量 · {name}', { name: label || sessionId }),
        status: stats.sharedVariables ? LINEAGE_EDGE_STATUS.DISABLED : ACTIVE,
        scopeId,
        meta: {
          sessionId,
          variableCount,
          weight: variableCount,
          stat: [t('{count} 个变量', { count: variableCount }), stats.sharedVariables ? t('已改用全局变量') : ''].filter(Boolean).join(' · '),
        },
        open: { kind: 'variables', id: sessionId },
      });
      addEdge(sessionNodeId, variablesNodeId, LINEAGE_EDGE_TYPES.CONTAINS, LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED, {
        status: stats.sharedVariables ? LINEAGE_EDGE_STATUS.DISABLED : ACTIVE,
      });
    }
    if (stats.sharedVariables) globalVariableUsers.add(sessionNodeId);
  };

  const contactList = listOf(contacts);
  const profileByContact = new Map(listOf(profiles).map(profile => [trim(profile?.contactId), profile]));
  contactList.forEach((contact) => {
    const id = trim(contact?.id);
    if (!id) return;
    const nodeId = addContactNode(contact);
    if (!nodeId) return;
    const isGroup = Boolean(contact?.isGroup) || id.startsWith('group:');
    addEdge(rootId, nodeId, LINEAGE_EDGE_TYPES.CONTAINS);
    if (isGroup) {
      listOf(contact?.members).forEach((memberIdRaw) => {
        const memberId = trim(memberIdRaw);
        if (!memberId) return;
        const member = getContact(memberId) || { id: memberId, name: memberId };
        const memberNodeId = addContactNode(member, { status: member?.id ? ACTIVE : LINEAGE_EDGE_STATUS.CANDIDATE });
        if (!memberNodeId) return;
        addEdge(memberNodeId, nodeId, LINEAGE_EDGE_TYPES.MEMBER_OF);
      });
    }
    addWorldState(nodeId, resolveWorldState(id, {
      isGroupChat: isGroup,
      groupMemberIds: listOf(contact?.members),
    }) || {});
    const profile = profileByContact.get(id);
    if (profile && !contact?.isGroup) {
      const profileNodeId = `contact_profile:${id}`;
      builder.addNode({
        id: profileNodeId,
        type: LINEAGE_NODE_TYPES.CONTACT_PROFILE,
        label: t('{name} 画像', { name: trim(contact?.name || id) || id }),
        status: ACTIVE,
        scopeId,
        summary: Array.isArray(profile.trigger_keywords) ? profile.trigger_keywords.slice(0, 8).join(', ') : '',
        meta: {
          contactId: id,
          sourceRefs: Array.isArray(profile.sourceRefs) ? profile.sourceRefs : [],
          updatedAt: profile.updatedAt || '',
        },
        open: { kind: 'contact', id },
      });
      addEdge(nodeId, profileNodeId, LINEAGE_EDGE_TYPES.CONTAINS);
    }
    addSessionResources(nodeId, id, { mode: 'chat', label: trim(contact?.name || id) || id });
  });

  const creativeSessionId = trim(creative?.sessionId);
  if (creativeSessionId) {
    const creativeNodeId = `creative:${creativeSessionId}`;
    const creativeLabel = trim(creative?.label);
    builder.addNode({
      id: creativeNodeId,
      type: LINEAGE_NODE_TYPES.CREATIVE_SESSION,
      label: creativeLabel ? t('创意写作 · {name}', { name: creativeLabel }) : t('创意写作'),
      status: ACTIVE,
      scopeId,
      meta: { sessionId: creativeSessionId },
      open: { kind: 'creative', id: creativeSessionId },
    });
    addEdge(rootId, creativeNodeId, LINEAGE_EDGE_TYPES.CONTAINS);
    addWorldState(creativeNodeId, resolveWorldState(creativeSessionId, { isGroupChat: false, groupMemberIds: [] }) || {});
    addSessionResources(creativeNodeId, creativeSessionId, { mode: 'rp', label: creativeLabel || t('创意写作') });
  }

  listOf(regexSets).forEach((set) => {
    const setId = trim(set?.id);
    const bind = set?.bind && typeof set.bind === 'object' ? set.bind : null;
    if (!setId || !bind) return;
    const owners = bind.type === 'preset'
      ? [...listOf(bind.presetIds), bind.presetId].map(trim).filter(Boolean).map(id => `preset:${id}`)
      : bind.type === 'world' && trim(bind.worldId) ? [`worldbook:${trim(bind.worldId)}`] : [];
    const presentOwners = owners.filter(ownerId => presetUsers.has(ownerId) || worldUsers.has(ownerId));
    if (!presentOwners.length) return;
    const rules = listOf(set?.rules);
    const ruleCount = rules.filter(rule => rule?.disabled !== true).length;
    const enabled = set?.manualEnabled !== false;
    const regexNodeId = `regex:${setId}`;
    builder.addNode({
      id: regexNodeId,
      type: LINEAGE_NODE_TYPES.REGEX,
      label: trim(set?.name) || setId,
      status: enabled ? ACTIVE : LINEAGE_EDGE_STATUS.DISABLED,
      scopeId,
      meta: {
        regexSetId: setId,
        ruleCount,
        weight: ruleCount,
        stat: [t('{count} 条规则', { count: ruleCount }), enabled ? '' : t('已关闭')].filter(Boolean).join(' · '),
      },
      open: { kind: 'regex' },
    });
    presentOwners.forEach(ownerId => addEdge(ownerId, regexNodeId, LINEAGE_EDGE_TYPES.BINDS, LINEAGE_TRIGGER_REASONS.MANUAL_BINDING, {
      status: enabled ? ACTIVE : LINEAGE_EDGE_STATUS.DISABLED,
    }));
  });
  const globalRules = countOf(globalRegexCount);
  if (globalRules) {
    builder.addNode({
      id: 'regex:global',
      type: LINEAGE_NODE_TYPES.REGEX,
      label: t('全局正则'),
      status: ACTIVE,
      scopeId,
      meta: { ruleCount: globalRules, weight: globalRules, stat: t('{count} 条规则', { count: globalRules }) },
      open: { kind: 'regex' },
    });
    addEdge(rootId, 'regex:global', LINEAGE_EDGE_TYPES.CONTAINS);
  }

  const globalVariables = countOf(globalVariableCount);
  if (globalVariables || globalVariableUsers.size) {
    builder.addNode({
      id: globalVariablesNodeId,
      type: LINEAGE_NODE_TYPES.VARIABLE_SCOPE,
      label: t('全局变量'),
      status: ACTIVE,
      scopeId,
      meta: {
        variableCount: globalVariables,
        sharedSessionCount: globalVariableUsers.size,
        weight: globalVariables,
        stat: [
          t('{count} 个变量', { count: globalVariables }),
          globalVariableUsers.size ? t('{count} 个会话共用', { count: globalVariableUsers.size }) : '',
        ].filter(Boolean).join(' · '),
      },
      // 变量管理的作用域跟着当前会话走，打不开「全局变量」本身，所以不给跳转
    });
    addEdge(rootId, globalVariablesNodeId, LINEAGE_EDGE_TYPES.CONTAINS);
    globalVariableUsers.forEach(sessionNodeId => addEdge(sessionNodeId, globalVariablesNodeId, LINEAGE_EDGE_TYPES.BINDS, LINEAGE_TRIGGER_REASONS.MANUAL_BINDING));
  }

  // 记忆表格：按聊天室聚合（每个会话一个节点，卡片显示行数与表数）
  const templateId = trim(memory?.templateId);
  const tableNames = memory?.tableNames && typeof memory.tableNames === 'object' ? memory.tableNames : {};
  const memoryRooms = new Map();
  listOf(memory?.rows).forEach((row) => {
    if (trim(row?.template_id) !== templateId) return;
    const room = memoryRoomOf(row);
    if (!memoryRooms.has(room.key)) memoryRooms.set(room.key, { ...room, rowCount: 0, inactiveCount: 0, tables: new Map() });
    const entry = memoryRooms.get(room.key);
    entry.rowCount += 1;
    if (row?.is_active === false) entry.inactiveCount += 1;
    const tableId = trim(row?.table_id);
    entry.tables.set(tableId, (entry.tables.get(tableId) || 0) + 1);
  });
  memoryRooms.forEach((room) => {
    const isGlobal = room.kind === 'global';
    const memoryNodeId = isGlobal ? 'memory:global' : `memory:${room.key}`;
    const ownerNodeId = isGlobal ? rootId : (sessionNodes.get(room.sessionId) || rootId);
    const roomLabel = isGlobal ? '' : (trim(getSessionLabel(room.sessionId)) || room.key);
    const tables = [...room.tables].sort((a, b) => b[1] - a[1]);
    builder.addNode({
      id: memoryNodeId,
      type: LINEAGE_NODE_TYPES.MEMORY_TABLE,
      label: isGlobal ? t('全局／动态记忆') : t('记忆 · {name}', { name: roomLabel }),
      status: ACTIVE,
      scopeId,
      summary: tables.map(([tableId, rows]) => `${trim(tableNames[tableId]) || tableId} ${rows}`).join(', '),
      meta: {
        sessionId: room.sessionId,
        roomKind: room.kind,
        rowCount: room.rowCount,
        inactiveCount: room.inactiveCount,
        tableCount: room.tables.size,
        weight: room.rowCount,
        stat: [
          t('{rows} 行 · {tables} 张表', { rows: room.rowCount, tables: room.tables.size }),
          room.inactiveCount ? t('{count} 行停用', { count: room.inactiveCount }) : '',
        ].filter(Boolean).join(' · '),
      },
      open: { kind: 'memory', room: isGlobal ? null : { key: room.key, kind: room.kind, sessionId: room.sessionId } },
    });
    addEdge(ownerNodeId, memoryNodeId, LINEAGE_EDGE_TYPES.CONTAINS);
  });

  // 动态：按发布者聚合
  const momentAuthors = new Map();
  listOf(moments).forEach((moment) => {
    const authorId = trim(moment?.authorId);
    const key = authorId || 'user';
    if (!momentAuthors.has(key)) momentAuthors.set(key, { authorId, name: trim(moment?.author), count: 0, comments: 0 });
    const entry = momentAuthors.get(key);
    entry.count += 1;
    entry.comments += listOf(moment?.comments).length;
  });
  momentAuthors.forEach((entry, key) => {
    const ownerNodeId = entry.authorId && sessionNodes.has(entry.authorId) && !entry.authorId.startsWith('group:')
      ? sessionNodes.get(entry.authorId)
      : rootId;
    const momentNodeId = `moment:${key}`;
    builder.addNode({
      id: momentNodeId,
      type: LINEAGE_NODE_TYPES.MOMENT,
      label: t('动态 · {name}', { name: entry.name || entry.authorId || t('我') }),
      status: ACTIVE,
      scopeId,
      meta: {
        authorId: entry.authorId,
        momentCount: entry.count,
        commentCount: entry.comments,
        weight: entry.count,
        stat: [
          t('{count} 条动态', { count: entry.count }),
          entry.comments ? t('{count} 条评论', { count: entry.comments }) : '',
        ].filter(Boolean).join(' · '),
      },
      open: { kind: 'moments' },
    });
    addEdge(ownerNodeId, momentNodeId, LINEAGE_EDGE_TYPES.CONTAINS);
  });
  const momentSummaryCount = countOf(momentSummary?.count);
  if (momentSummaryCount || momentSummary?.compacted) {
    builder.addNode({
      id: 'summary:moments',
      type: LINEAGE_NODE_TYPES.SUMMARY,
      label: t('动态摘要'),
      status: ACTIVE,
      scopeId,
      meta: {
        summaryCount: momentSummaryCount,
        compacted: Boolean(momentSummary?.compacted),
        weight: momentSummaryCount + (momentSummary?.compacted ? 1 : 0),
        stat: [momentSummaryCount ? t('{count} 条', { count: momentSummaryCount }) : '', momentSummary?.compacted ? t('已压缩') : ''].filter(Boolean).join(' · '),
      },
      open: { kind: 'moment_summary' },
    });
    addEdge(rootId, 'summary:moments', LINEAGE_EDGE_TYPES.CONTAINS);
  }

  const usedBy = users => ({ weight: users.size, stat: t('{count} 个会话使用', { count: users.size }) });
  worldUsers.forEach((users, nodeId) => annotate(nodeId, usedBy(users)));
  presetUsers.forEach((users, nodeId) => annotate(nodeId, usedBy(users)));
  const graph = builder.graph;
  graph.nodes.forEach((node) => {
    const patch = annotations.get(node.id);
    if (patch) node.meta = { ...node.meta, ...patch };
  });
  const sessionCount = contactList.length + (creativeSessionId ? 1 : 0);
  return {
    traceId: `persona-lineage-${at}`,
    requestId: 'persona-lineage-overview',
    scopeId,
    sessionId: '',
    mode: 'persona',
    generatedAt: at,
    spans: [
      {
        id: `persona-lineage-${at}:build-scope-graph`,
        parentId: '',
        name: 'buildPersonaScopeGraph',
        startedAt: at,
        endedAt: at,
        result: 'ok',
        attrs: {
          contacts: contactList.filter(item => item && !item.isGroup).length,
          groups: contactList.filter(item => item && item.isGroup).length,
          profiles: listOf(profiles).length,
          sessions: sessionCount,
          memoryRooms: memoryRooms.size,
          moments: listOf(moments).length,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
        },
      },
    ],
    graph,
  };
};
