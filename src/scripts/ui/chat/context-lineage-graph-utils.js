export const LINEAGE_NODE_TYPES = Object.freeze({
  PERSONA_CARD: 'persona_card',
  PRIVATE_CHAT: 'private_chat',
  GROUP_CHAT: 'group_chat',
  MOMENT: 'moment',
  CREATIVE_SESSION: 'creative_session',
  FORUM_BOARD: 'forum_board',
  FORUM_THREAD: 'forum_thread',
  CONTACT: 'contact',
  MEMORY_TABLE: 'memory_table',
  MEMORY_ROW: 'memory_row',
  CONTACT_PROFILE: 'contact_profile',
  WORLDBOOK: 'worldbook',
  WORLDBOOK_ENTRY: 'worldbook_entry',
  SUMMARY: 'summary',
  VARIABLE_SCOPE: 'variable_scope',
  PRESET: 'preset',
  REGEX: 'regex',
  PROMPT: 'prompt',
  RULE: 'rule',
});

export const LINEAGE_EDGE_TYPES = Object.freeze({
  CONTAINS: 'contains',
  MEMBER_OF: 'member_of',
  BINDS: 'binds',
  DERIVED_FROM: 'derived_from',
  CANDIDATE_FOR: 'candidate_for',
  TRIGGERS: 'triggers',
  INJECTS: 'injects',
  VISIBLE_TO: 'visible_to',
  BLOCKED_BY: 'blocked_by',
  TRIMMED_BY: 'trimmed_by',
});

export const LINEAGE_EDGE_STATUS = Object.freeze({
  ACTIVE: 'active',
  CANDIDATE: 'candidate',
  BLOCKED: 'blocked',
  TRIMMED: 'trimmed',
  DISABLED: 'disabled',
  UNKNOWN: 'unknown',
});

export const LINEAGE_TRIGGER_REASONS = Object.freeze({
  DEFAULT_ENABLED: 'default_enabled',
  MANUAL_BINDING: 'manual_binding',
  STRUCTURED_MENTION: 'structured_mention',
  EXACT_NAME: 'exact_name',
  ALIAS: 'alias',
  REPLY_TARGET: 'reply_target',
  COMMENT_AUTHOR: 'comment_author',
  PUBLISH_TARGET: 'publish_target',
  KEYWORD_MATCH: 'keyword_match',
  PROFILE_TAG_MATCH: 'profile_tag_match',
  MEMORY_ROW_MATCH: 'memory_row_match',
  SEMANTIC_MATCH: 'semantic_match',
  BUDGET_LIMIT: 'budget_limit',
  SCOPE_BLOCK: 'scope_block',
  MODE_BLOCK: 'mode_block',
  USER_DISABLED: 'user_disabled',
  THRESHOLD_BLOCK: 'threshold_block',
});

const SECTION_LABELS = {
  builtinEntries: '内置世界书',
  globalEntries: '全局世界书',
  roleEntries: '角色世界书',
  sessionEntries: '会话世界书',
  mergedEntries: '预算前候选',
  injectedEntries: '实际注入',
  templateEntries: '模板注入',
  initialVariableEntries: '变量初始化',
  trimmedEntries: '预算裁剪',
};

const SOURCE_KIND_LABELS = {
  builtin: '内置',
  global: '全局',
  role: '角色',
  session: '会话',
};

const normalizeString = value => String(value ?? '').trim();
const listOf = value => Array.isArray(value) ? value : [];

const normalizeIdPart = value => normalizeString(value).replace(/[\s:|/\\]+/g, '_') || 'unknown';

const inferSessionNodeType = (sessionId = '', { isGroup = false, taskType = '' } = {}) => {
  const id = normalizeString(sessionId);
  const task = normalizeString(taskType).toLowerCase();
  if (task === 'moment_comment') return LINEAGE_NODE_TYPES.MOMENT;
  if (isGroup || id.startsWith('group:')) return LINEAGE_NODE_TYPES.GROUP_CHAT;
  if (id.startsWith('rp:')) return LINEAGE_NODE_TYPES.CREATIVE_SESSION;
  return LINEAGE_NODE_TYPES.PRIVATE_CHAT;
};

const normalizeReason = value => {
  const reason = normalizeString(value);
  if (!reason) return LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED;
  if (reason === 'mention') return LINEAGE_TRIGGER_REASONS.STRUCTURED_MENTION;
  if (reason === 'exact_name') return LINEAGE_TRIGGER_REASONS.EXACT_NAME;
  if (reason === 'reply_target') return LINEAGE_TRIGGER_REASONS.REPLY_TARGET;
  if (reason === 'comment_author') return LINEAGE_TRIGGER_REASONS.COMMENT_AUTHOR;
  if (reason === 'publish_target') return LINEAGE_TRIGGER_REASONS.PUBLISH_TARGET;
  if (reason === 'moment_session_budget') return LINEAGE_TRIGGER_REASONS.BUDGET_LIMIT;
  return reason;
};

export const createLineageGraphBuilder = ({
  scopeId = 'default',
  mode = 'chat',
  rootId = 'prompt:this',
  generatedAt = Date.now(),
} = {}) => {
  const graph = {
    version: 1,
    scopeId: normalizeString(scopeId) || 'default',
    mode: normalizeString(mode) || 'chat',
    rootId: normalizeString(rootId) || 'prompt:this',
    generatedAt: Number(generatedAt || Date.now()) || Date.now(),
    nodes: [],
    edges: [],
  };
  const nodeIds = new Set();
  const edgeIds = new Set();

  const addNode = (node = {}) => {
    const id = normalizeString(node.id);
    if (!id || nodeIds.has(id)) return id;
    nodeIds.add(id);
    graph.nodes.push({
      id,
      type: normalizeString(node.type) || LINEAGE_NODE_TYPES.RULE,
      label: normalizeString(node.label) || id,
      status: normalizeString(node.status) || LINEAGE_EDGE_STATUS.ACTIVE,
      summary: normalizeString(node.summary),
      scopeId: normalizeString(node.scopeId) || graph.scopeId,
      meta: node.meta && typeof node.meta === 'object' ? { ...node.meta } : {},
      // 「打开设置」的跳转目标（关系图用），只有给了才带
      ...(node.open && typeof node.open === 'object' ? { open: { ...node.open } } : {}),
    });
    return id;
  };

  const addEdge = (edge = {}) => {
    const source = normalizeString(edge.source);
    const target = normalizeString(edge.target);
    if (!source || !target) return '';
    const type = normalizeString(edge.type) || LINEAGE_EDGE_TYPES.CANDIDATE_FOR;
    const id = normalizeString(edge.id) || `edge:${normalizeIdPart(source)}:${type}:${normalizeIdPart(target)}`;
    if (edgeIds.has(id)) return id;
    edgeIds.add(id);
    graph.edges.push({
      id,
      source,
      target,
      type,
      status: normalizeString(edge.status) || LINEAGE_EDGE_STATUS.UNKNOWN,
      reason: normalizeReason(edge.reason),
      score: Number.isFinite(Number(edge.score)) ? Number(edge.score) : null,
      priority: Number.isFinite(Number(edge.priority)) ? Number(edge.priority) : null,
      sourceScopeId: normalizeString(edge.sourceScopeId) || graph.scopeId,
      targetScopeId: normalizeString(edge.targetScopeId) || graph.scopeId,
      evidence: edge.evidence && typeof edge.evidence === 'object' ? { ...edge.evidence } : {},
      budget: edge.budget && typeof edge.budget === 'object' ? { ...edge.budget } : {},
      meta: edge.meta && typeof edge.meta === 'object' ? { ...edge.meta } : {},
    });
    return id;
  };

  return { graph, addNode, addEdge };
};

const getWorldNodeId = entry => {
  const worldId = normalizeString(entry?.worldId || entry?.refWorldId || 'unknown');
  return `worldbook:${worldId}`;
};

const getWorldEntryNodeId = entry => {
  const worldId = normalizeString(entry?.worldId || entry?.refWorldId || 'unknown');
  const entryId = normalizeString(entry?.entryId || 'unknown');
  const blockId = normalizeString(entry?.blockId || 'legacy') || 'legacy';
  return `worldbook_entry:${worldId}:${entryId}:${blockId}`;
};

const addWorldEntryLineage = ({
  builder,
  entry,
  promptId,
  sectionKey,
  status,
  edgeType,
  reason,
  scopeId,
}) => {
  if (!builder || !entry) return;
  const worldId = normalizeString(entry?.worldId || entry?.refWorldId || 'unknown');
  const sourceKind = normalizeString(entry?.sourceKind) || 'session';
  const worldNodeId = getWorldNodeId(entry);
  const entryNodeId = getWorldEntryNodeId(entry);
  const sourceLabel = SOURCE_KIND_LABELS[sourceKind] || sourceKind || '未知';
  const title = normalizeString(entry?.title) || normalizeString(entry?.entryId) || '未命名条目';
  builder.addNode({
    id: worldNodeId,
    type: LINEAGE_NODE_TYPES.WORLDBOOK,
    label: `${sourceLabel}世界书 ${worldId}`,
    scopeId,
    meta: { worldId, sourceKind },
  });
  builder.addNode({
    id: entryNodeId,
    type: LINEAGE_NODE_TYPES.WORLDBOOK_ENTRY,
    label: title,
    summary: normalizeString(entry?.contentPreview),
    scopeId,
    meta: {
      worldId,
      entryId: normalizeString(entry?.entryId),
      blockId: normalizeString(entry?.blockId || 'legacy') || 'legacy',
      sourceKind,
      role: normalizeString(entry?.role || 'system') || 'system',
      positionLabel: normalizeString(entry?.positionLabel),
      section: SECTION_LABELS[sectionKey] || sectionKey,
    },
  });
  builder.addEdge({
    id: `edge:${normalizeIdPart(worldNodeId)}:contains:${normalizeIdPart(entryNodeId)}`,
    source: worldNodeId,
    target: entryNodeId,
    type: LINEAGE_EDGE_TYPES.CONTAINS,
    status: LINEAGE_EDGE_STATUS.ACTIVE,
    reason: LINEAGE_TRIGGER_REASONS.MANUAL_BINDING,
    sourceScopeId: scopeId,
    targetScopeId: scopeId,
  });
  builder.addEdge({
    id: `edge:${normalizeIdPart(entryNodeId)}:${edgeType}:${normalizeIdPart(promptId)}:${normalizeIdPart(sectionKey)}`,
    source: entryNodeId,
    target: promptId,
    type: edgeType,
    status,
    reason,
    sourceScopeId: scopeId,
    targetScopeId: scopeId,
    evidence: {
      section: SECTION_LABELS[sectionKey] || sectionKey,
      triggerSourceName: normalizeString(entry?.triggerSourceName),
      triggerSessionId: normalizeString(entry?.triggerSessionId),
      triggerType: normalizeString(entry?.triggerType),
      triggerReason: normalizeString(entry?.triggerReason),
      trimReason: normalizeString(entry?.trimReason),
    },
  });
};

const addDynamicWorldLineage = ({ builder, dynamicWorld, promptId, scopeId }) => {
  if (!builder || !dynamicWorld || typeof dynamicWorld !== 'object') return;
  const selectedIds = new Set(listOf(dynamicWorld.selectedSources).map(item => normalizeString(item?.sessionId)).filter(Boolean));
  const addSource = (source, selected = false) => {
    const sessionId = normalizeString(source?.sessionId);
    if (!sessionId) return;
    const nodeType = inferSessionNodeType(sessionId, {
      isGroup: normalizeString(source?.type).toLowerCase() === 'group',
    });
    const nodeId = `source:${sessionId}`;
    const reasons = listOf(source?.reasons).map(normalizeReason).filter(Boolean);
    builder.addNode({
      id: nodeId,
      type: nodeType === LINEAGE_NODE_TYPES.GROUP_CHAT ? LINEAGE_NODE_TYPES.GROUP_CHAT : LINEAGE_NODE_TYPES.CONTACT,
      label: normalizeString(source?.name) || sessionId,
      status: selected ? LINEAGE_EDGE_STATUS.ACTIVE : LINEAGE_EDGE_STATUS.CANDIDATE,
      scopeId,
      meta: {
        sessionId,
        sourceType: normalizeString(source?.type),
        worldIds: listOf(source?.worldIds).map(normalizeString).filter(Boolean),
      },
    });
    builder.addEdge({
      id: `edge:${normalizeIdPart(nodeId)}:candidate_for:${normalizeIdPart(promptId)}`,
      source: nodeId,
      target: promptId,
      type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR,
      status: selected ? LINEAGE_EDGE_STATUS.ACTIVE : LINEAGE_EDGE_STATUS.CANDIDATE,
      reason: reasons[0] || LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED,
      sourceScopeId: scopeId,
      targetScopeId: scopeId,
      evidence: {
        reasons,
        worldIds: listOf(source?.worldIds).map(normalizeString).filter(Boolean),
      },
    });
    listOf(source?.worldIds).forEach((worldIdRaw) => {
      const worldId = normalizeString(worldIdRaw);
      if (!worldId) return;
      const worldNodeId = `worldbook:${worldId}`;
      builder.addNode({
        id: worldNodeId,
        type: LINEAGE_NODE_TYPES.WORLDBOOK,
        label: `会话世界书 ${worldId}`,
        scopeId,
        meta: { worldId, sourceKind: 'session' },
      });
      builder.addEdge({
        id: `edge:${normalizeIdPart(nodeId)}:binds:${normalizeIdPart(worldNodeId)}`,
        source: nodeId,
        target: worldNodeId,
        type: LINEAGE_EDGE_TYPES.BINDS,
        status: selected ? LINEAGE_EDGE_STATUS.ACTIVE : LINEAGE_EDGE_STATUS.CANDIDATE,
        reason: reasons[0] || LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED,
        sourceScopeId: scopeId,
        targetScopeId: scopeId,
      });
    });
  };
  listOf(dynamicWorld.candidates).forEach(source => addSource(source, selectedIds.has(normalizeString(source?.sessionId))));
  listOf(dynamicWorld.selectedSources).forEach(source => addSource(source, true));
};

const addDynamicProfileLineage = ({ builder, dynamicProfiles, promptId, scopeId }) => {
  if (!builder || !dynamicProfiles || typeof dynamicProfiles !== 'object') return;
  const selectedIds = new Set(listOf(dynamicProfiles.selectedSources).map(item => normalizeString(item?.contactId)).filter(Boolean));
  const promptInjected = dynamicProfiles.promptInjected === true;
  const addSource = (source) => {
    const contactId = normalizeString(source?.contactId);
    if (!contactId) return;
    const sourceScopeId = normalizeString(source?.scopeId) || scopeId;
    const selected = selectedIds.has(contactId);
    const blocked = normalizeString(source?.status) === LINEAGE_EDGE_STATUS.BLOCKED || normalizeString(source?.blockedReason);
    const status = selected
      ? LINEAGE_EDGE_STATUS.ACTIVE
      : (blocked ? LINEAGE_EDGE_STATUS.BLOCKED : LINEAGE_EDGE_STATUS.CANDIDATE);
    const reason = normalizeString(source?.blockedReason) || listOf(source?.reasons)[0] || LINEAGE_TRIGGER_REASONS.KEYWORD_MATCH;
    const contactNodeId = `contact:${contactId}`;
    const profileId = normalizeString(source?.profileId || contactId);
    const profileNodeId = `contact_profile:${profileId}`;
    builder.addNode({
      id: contactNodeId,
      type: LINEAGE_NODE_TYPES.CONTACT,
      label: normalizeString(source?.name) || contactId,
      status,
      scopeId: sourceScopeId,
      meta: { contactId },
    });
    builder.addNode({
      id: profileNodeId,
      type: LINEAGE_NODE_TYPES.CONTACT_PROFILE,
      label: `${normalizeString(source?.name) || contactId} 画像`,
      status,
      summary: normalizeString(source?.profileHeader),
      scopeId: sourceScopeId,
      meta: {
        contactId,
        profileId,
        hasProfile: source?.hasProfile === true,
        sourceRefs: listOf(source?.sourceRefs).map(normalizeString).filter(Boolean),
      },
    });
    builder.addEdge({
      id: `edge:${normalizeIdPart(contactNodeId)}:contains:${normalizeIdPart(profileNodeId)}`,
      source: contactNodeId,
      target: profileNodeId,
      type: LINEAGE_EDGE_TYPES.CONTAINS,
      status,
      reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED,
      sourceScopeId,
      targetScopeId: scopeId,
    });
    builder.addEdge({
      id: `edge:${normalizeIdPart(profileNodeId)}:candidate_for:${normalizeIdPart(promptId)}`,
      source: profileNodeId,
      target: promptId,
      type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR,
      status,
      reason,
      score: Number(source?.score || 0),
      sourceScopeId,
      targetScopeId: scopeId,
      evidence: {
        matchedFields: listOf(source?.matchedFields).map(normalizeString).filter(Boolean),
        matchedTerms: listOf(source?.matchedTerms).map(normalizeString).filter(Boolean),
        reasons: listOf(source?.reasons).map(normalizeString).filter(Boolean),
        threshold: Number(dynamicProfiles?.threshold || 0),
      },
    });
    listOf(source?.matchedRows).forEach((row, index) => {
      const tableId = normalizeString(row?.tableId || 'unknown');
      const rowId = normalizeString(row?.id || `${contactId}:${tableId}:${index}`);
      const tableNodeId = `memory_table:${contactId}:${tableId}`;
      const rowNodeId = `memory_row:${rowId}`;
      const rowStatus = selected && promptInjected ? LINEAGE_EDGE_STATUS.ACTIVE : status;
      builder.addNode({
        id: tableNodeId,
        type: LINEAGE_NODE_TYPES.MEMORY_TABLE,
        label: normalizeString(row?.tableName) || tableId,
        status: rowStatus,
        scopeId: sourceScopeId,
        meta: { contactId, tableId },
      });
      builder.addNode({
        id: rowNodeId,
        type: LINEAGE_NODE_TYPES.MEMORY_ROW,
        label: normalizeString(row?.rowSummary) || rowId,
        status: rowStatus,
        summary: normalizeString(row?.rowSummary),
        scopeId: sourceScopeId,
        meta: {
          contactId,
          tableId,
          rowId,
          matchedTerms: listOf(row?.matchedTerms).map(normalizeString).filter(Boolean),
        },
      });
      builder.addEdge({
        id: `edge:${normalizeIdPart(tableNodeId)}:contains:${normalizeIdPart(rowNodeId)}`,
        source: tableNodeId,
        target: rowNodeId,
        type: LINEAGE_EDGE_TYPES.CONTAINS,
        status: rowStatus,
        reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED,
        sourceScopeId,
        targetScopeId: sourceScopeId,
      });
      builder.addEdge({
        id: `edge:${normalizeIdPart(profileNodeId)}:triggers:${normalizeIdPart(rowNodeId)}`,
        source: profileNodeId,
        target: rowNodeId,
        type: LINEAGE_EDGE_TYPES.TRIGGERS,
        status: rowStatus,
        reason: LINEAGE_TRIGGER_REASONS.MEMORY_ROW_MATCH,
        score: Number(row?.score || 0),
        sourceScopeId,
        targetScopeId: sourceScopeId,
        evidence: {
          matchedTerms: listOf(row?.matchedTerms).map(normalizeString).filter(Boolean),
        },
      });
      builder.addEdge({
        id: `edge:${normalizeIdPart(rowNodeId)}:injects:${normalizeIdPart(promptId)}`,
        source: rowNodeId,
        target: promptId,
        type: selected && promptInjected ? LINEAGE_EDGE_TYPES.INJECTS : LINEAGE_EDGE_TYPES.CANDIDATE_FOR,
        status: rowStatus,
        reason: selected && promptInjected ? LINEAGE_TRIGGER_REASONS.MEMORY_ROW_MATCH : reason,
        score: Number(row?.score || source?.score || 0),
        sourceScopeId,
        targetScopeId: scopeId,
      });
    });
  };
  listOf(dynamicProfiles.candidates).forEach(addSource);
  listOf(dynamicProfiles.selectedSources)
    .filter(source => !listOf(dynamicProfiles.candidates).some(candidate => normalizeString(candidate?.contactId) === normalizeString(source?.contactId)))
    .forEach(addSource);
};

export const buildContextLineageGraphFromRequest = (request = null, {
  scopeId = '',
  generatedAt = null,
} = {}) => {
  const req = request && typeof request === 'object' ? request : {};
  const worldDebug = req?.worldDebug && typeof req.worldDebug === 'object' ? req.worldDebug : {};
  const sessionId = normalizeString(req?.session?.id || req?.presetContext?.sessionId || '');
  const mode = normalizeString(req?.task?.type) === 'moment_comment'
    ? 'moment'
    : normalizeString(req?.presetContext?.uiMode || (sessionId.startsWith('rp:') ? 'creative' : 'chat')) || 'chat';
  const graphScopeId = normalizeString(scopeId || req?.scopeId || req?.presetContext?.scopeId || sessionId || 'default') || 'default';
  const promptId = `prompt:${normalizeString(req?.requestId || req?.at || 'this') || 'this'}`;
  const builder = createLineageGraphBuilder({
    scopeId: graphScopeId,
    mode,
    rootId: promptId,
    generatedAt: generatedAt || req?.at || Date.now(),
  });
  builder.addNode({
    id: promptId,
    type: LINEAGE_NODE_TYPES.PROMPT,
    label: '本次 Prompt',
    scopeId: graphScopeId,
    meta: {
      requestId: normalizeString(req?.requestId),
      provider: normalizeString(req?.provider),
      model: normalizeString(req?.model),
      taskType: normalizeString(req?.task?.type),
    },
  });
  if (sessionId) {
    const sessionNodeId = `session:${sessionId}`;
    builder.addNode({
      id: sessionNodeId,
      type: inferSessionNodeType(sessionId, {
        isGroup: Boolean(req?.session?.isGroup),
        taskType: req?.task?.type,
      }),
      label: normalizeString(req?.session?.name) || sessionId,
      scopeId: graphScopeId,
      meta: { sessionId, isGroup: Boolean(req?.session?.isGroup) },
    });
    builder.addEdge({
      id: `edge:${normalizeIdPart(sessionNodeId)}:candidate_for:${normalizeIdPart(promptId)}`,
      source: sessionNodeId,
      target: promptId,
      type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR,
      status: LINEAGE_EDGE_STATUS.ACTIVE,
      reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED,
      sourceScopeId: graphScopeId,
      targetScopeId: graphScopeId,
    });
  }

  addDynamicWorldLineage({
    builder,
    dynamicWorld: worldDebug?.dynamicWorld,
    promptId,
    scopeId: graphScopeId,
  });
  addDynamicProfileLineage({
    builder,
    dynamicProfiles: worldDebug?.dynamicProfiles,
    promptId,
    scopeId: graphScopeId,
  });

  const sectionConfigs = [
    { key: 'builtinEntries', status: LINEAGE_EDGE_STATUS.CANDIDATE, type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR, reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED },
    { key: 'globalEntries', status: LINEAGE_EDGE_STATUS.CANDIDATE, type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR, reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED },
    { key: 'roleEntries', status: LINEAGE_EDGE_STATUS.CANDIDATE, type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR, reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED },
    { key: 'sessionEntries', status: LINEAGE_EDGE_STATUS.CANDIDATE, type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR, reason: LINEAGE_TRIGGER_REASONS.MANUAL_BINDING },
    { key: 'mergedEntries', status: LINEAGE_EDGE_STATUS.CANDIDATE, type: LINEAGE_EDGE_TYPES.CANDIDATE_FOR, reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED },
    { key: 'injectedEntries', status: LINEAGE_EDGE_STATUS.ACTIVE, type: LINEAGE_EDGE_TYPES.INJECTS, reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED },
    { key: 'templateEntries', status: LINEAGE_EDGE_STATUS.ACTIVE, type: LINEAGE_EDGE_TYPES.INJECTS, reason: LINEAGE_TRIGGER_REASONS.MANUAL_BINDING },
    { key: 'initialVariableEntries', status: LINEAGE_EDGE_STATUS.ACTIVE, type: LINEAGE_EDGE_TYPES.INJECTS, reason: LINEAGE_TRIGGER_REASONS.DEFAULT_ENABLED },
    { key: 'trimmedEntries', status: LINEAGE_EDGE_STATUS.TRIMMED, type: LINEAGE_EDGE_TYPES.TRIMMED_BY, reason: LINEAGE_TRIGGER_REASONS.BUDGET_LIMIT },
  ];
  sectionConfigs.forEach(config => {
    listOf(worldDebug?.[config.key]).forEach(entry => addWorldEntryLineage({
      builder,
      entry,
      promptId,
      sectionKey: config.key,
      status: config.status,
      edgeType: config.type,
      reason: normalizeReason(entry?.trimReason || entry?.triggerReason || config.reason),
      scopeId: graphScopeId,
    }));
  });
  return builder.graph;
};

export const buildPromptTraceFromRequest = (request = null, options = {}) => {
  const req = request && typeof request === 'object' ? request : {};
  const at = Number(req?.at || Date.now()) || Date.now();
  const traceId = normalizeString(options.traceId || req?.traceId || `prompt-trace-${at}`);
  const graph = buildContextLineageGraphFromRequest(req, {
    scopeId: options.scopeId,
    generatedAt: at,
  });
  const worldDebug = req?.worldDebug && typeof req.worldDebug === 'object' ? req.worldDebug : {};
  const dynamicWorld = worldDebug?.dynamicWorld && typeof worldDebug.dynamicWorld === 'object' ? worldDebug.dynamicWorld : null;
  const dynamicProfiles = worldDebug?.dynamicProfiles && typeof worldDebug.dynamicProfiles === 'object' ? worldDebug.dynamicProfiles : null;
  const spans = [
    {
      id: `${traceId}:build-prompt`,
      parentId: '',
      name: 'buildPrompt',
      startedAt: at,
      endedAt: at,
      result: 'ok',
      attrs: {
        messageCount: listOf(req?.messages).length,
        sessionId: normalizeString(req?.session?.id),
        mode: graph.mode,
      },
    },
    {
      id: `${traceId}:resolve-worldbook`,
      parentId: `${traceId}:build-prompt`,
      name: 'resolveWorldbook',
      startedAt: at,
      endedAt: at,
      result: 'ok',
      attrs: {
        builtin: listOf(worldDebug?.builtinEntries).length,
        global: listOf(worldDebug?.globalEntries).length,
        role: listOf(worldDebug?.roleEntries).length,
        session: listOf(worldDebug?.sessionEntries).length,
        injected: listOf(worldDebug?.injectedEntries).length + listOf(worldDebug?.templateEntries).length,
        trimmed: listOf(worldDebug?.trimmedEntries).length,
        budgetTokens: Number.isFinite(Number(worldDebug?.budgetTokens)) ? Number(worldDebug.budgetTokens) : null,
        usedTokens: Number.isFinite(Number(worldDebug?.usedTokens)) ? Number(worldDebug.usedTokens) : null,
      },
    },
  ];
  if (dynamicWorld?.enabled) {
    spans.push({
      id: `${traceId}:resolve-dynamic-world`,
      parentId: `${traceId}:resolve-worldbook`,
      name: 'resolveDynamicWorld',
      startedAt: at,
      endedAt: at,
      result: 'ok',
      attrs: {
        candidates: listOf(dynamicWorld?.candidates).length,
        selected: listOf(dynamicWorld?.selectedSources).length,
        sessionBudgetTokens: Number.isFinite(Number(dynamicWorld?.sessionBudgetTokens)) ? Number(dynamicWorld.sessionBudgetTokens) : null,
        sessionUsedTokens: Number.isFinite(Number(dynamicWorld?.sessionUsedTokens)) ? Number(dynamicWorld.sessionUsedTokens) : null,
        sessionTrimmedCount: Number.isFinite(Number(dynamicWorld?.sessionTrimmedCount)) ? Number(dynamicWorld.sessionTrimmedCount) : 0,
      },
    });
  }
  if (dynamicProfiles?.enabled) {
    spans.push({
      id: `${traceId}:resolve-dynamic-profiles`,
      parentId: `${traceId}:build-prompt`,
      name: 'resolveDynamicProfiles',
      startedAt: at,
      endedAt: at,
      result: 'ok',
      attrs: {
        candidates: listOf(dynamicProfiles?.candidates).length,
        selected: listOf(dynamicProfiles?.selectedSources).length,
        blocked: listOf(dynamicProfiles?.blockedCandidates).length,
        injectedRows: listOf(dynamicProfiles?.injectedRows).length,
        promptInjected: dynamicProfiles?.promptInjected === true,
      },
    });
  }
  return {
    traceId,
    requestId: normalizeString(options.requestId || req?.requestId),
    scopeId: graph.scopeId,
    sessionId: normalizeString(req?.session?.id || req?.presetContext?.sessionId),
    mode: graph.mode,
    generatedAt: at,
    spans,
    graph,
  };
};

export const formatContextLineageGraphText = (graph = null) => {
  if (!graph || typeof graph !== 'object') return '';
  const nodes = listOf(graph.nodes);
  const edges = listOf(graph.edges);
  if (!nodes.length && !edges.length) return '';
  const labelOf = id => nodes.find(node => node.id === id)?.label || id;
  const statusCounts = edges.reduce((acc, edge) => {
    const status = normalizeString(edge?.status) || LINEAGE_EDGE_STATUS.UNKNOWN;
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const lines = [
    '[上下文血缘图]',
    `- scope: ${normalizeString(graph.scopeId) || 'default'}`,
    `- mode: ${normalizeString(graph.mode) || 'chat'}`,
    `- nodes: ${nodes.length} / edges: ${edges.length}`,
    `- edge status: ${Object.entries(statusCounts).map(([key, value]) => `${key}=${value}`).join(', ') || 'none'}`,
    '',
    '节点',
    ...nodes.map(node => `- ${normalizeString(node.type)} | ${node.label} | ${node.id}`),
    '',
    '边',
    ...edges.map(edge => {
      const evidence = edge?.evidence && typeof edge.evidence === 'object' ? edge.evidence : {};
      const evidenceParts = [
        normalizeString(evidence.section),
        normalizeString(evidence.triggerSourceName),
        normalizeString(evidence.trimReason),
      ].filter(Boolean);
      return [
        `- ${labelOf(edge.source)} -> ${labelOf(edge.target)}`,
        normalizeString(edge.type),
        normalizeString(edge.status),
        normalizeString(edge.reason),
        evidenceParts.length ? evidenceParts.join('/') : '',
      ].filter(Boolean).join(' | ');
    }),
  ];
  return lines.join('\n').trim();
};

export const formatPromptTraceText = (trace = null) => {
  if (!trace || typeof trace !== 'object') return '';
  const graphText = formatContextLineageGraphText(trace.graph);
  const spans = listOf(trace.spans);
  const spanLines = spans.map(span => {
    const attrs = span?.attrs && typeof span.attrs === 'object'
      ? Object.entries(span.attrs)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')
      : '';
    return `- ${normalizeString(span?.name) || span?.id || 'span'}${attrs ? ` | ${attrs}` : ''}`;
  });
  return [
    '[PromptTrace]',
    `- traceId: ${normalizeString(trace.traceId)}`,
    `- requestId: ${normalizeString(trace.requestId) || 'none'}`,
    `- scope: ${normalizeString(trace.scopeId) || 'default'}`,
    `- session: ${normalizeString(trace.sessionId) || 'none'}`,
    `- mode: ${normalizeString(trace.mode) || 'chat'}`,
    '',
    'Spans',
    ...spanLines,
    '',
    graphText,
  ].filter(Boolean).join('\n').trim();
};
