import { buildAgentRunListView, buildAgentUsageProfile } from '../agent/agent-run-view-model.js';
import {
  AGENT_PERMISSION_LAYERS,
  normalizeAgentPermissionRule,
} from '../agent/agent-permissions.js';
import { buildAgentFeatureList } from '../agent/agent-feature-settings.js';
import { WRITE_PREVIEW_PROVIDER_MODEL_CONTEXT_TOOLS } from '../agent/provider-tool-request-schema.js';
import { buildChatEmitCommitPreview } from '../agent/tools/chat-emit-commit-plan.js';
import {
  buildAgentCardList,
  buildAgentDiagnosticCardList,
  buildAgentPromptModuleCardList,
} from './agent-center-card-catalog.js';
import { buildAgentCenterResources } from './agent-center-resource-contract.js';
import { normalizeGlobalSemanticPromptLibrary } from '../agent/global-semantic-prompt-library.js';

export const AGENT_CENTER_TABS = Object.freeze([
  { id: 'pending', label: '待处理' },
  { id: 'agents', label: 'Agent' },
  { id: 'prompts', label: '提示词' },
  { id: 'global_prompts', label: '全局提示词' },
  { id: 'diagnostics', label: '诊断' },
  { id: 'resources', label: '资源' },
  { id: 'activity', label: '活动' },
  { id: 'safety', label: '安全' },
]);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const normalizeMemoryMode = (value = '') => {
  const text = trim(value, 'table').toLowerCase();
  if (text === 'summary') return 'summary';
  if (text === 'off' || text === 'disabled') return 'off';
  return 'table';
};

const PERMISSION_LAYER_LABELS = Object.freeze({
  default: '默认',
  plugin: '插件',
  agent: 'Agent',
  session: '当前会话',
  roleCard: '角色卡',
  global: '全局',
});

const PERMISSION_DECISION_LABELS = Object.freeze({
  allow: '允许',
  deny: '拒绝',
  ask: '每次确认',
});

const PERMISSION_LAYER_RANK = new Map(AGENT_PERMISSION_LAYERS.map((layer, index) => [layer, index]));

const permissionRuleSort = (a, b) => {
  const layerDelta = (PERMISSION_LAYER_RANK.get(b.layer) ?? 0) - (PERMISSION_LAYER_RANK.get(a.layer) ?? 0);
  if (layerDelta) return layerDelta;
  const priorityDelta = Number(b.priority || 0) - Number(a.priority || 0);
  if (priorityDelta) return priorityDelta;
  return Number(b.index || 0) - Number(a.index || 0);
};

const permissionRuleScopeKey = rule => [
  rule.layer,
  rule.toolName,
  rule.permission,
  rule.source,
  rule.sessionId,
  rule.roleCardId,
  rule.agentId,
  rule.pluginId,
].join('\u0001');

const buildPermissionRuleSummary = (permissionRules = []) => {
  const normalizedRules = (Array.isArray(permissionRules) ? permissionRules : [])
    .map((rule, index) => normalizeAgentPermissionRule(rule, index));
  const sortedRules = normalizedRules.slice().sort(permissionRuleSort);
  const decisionCounts = normalizedRules.reduce((acc, rule) => {
    acc[rule.decision] = Number(acc[rule.decision] || 0) + 1;
    return acc;
  }, { allow: 0, deny: 0, ask: 0 });
  const scopeDecisions = new Map();
  normalizedRules.forEach((rule) => {
    const key = permissionRuleScopeKey(rule);
    if (!scopeDecisions.has(key)) scopeDecisions.set(key, new Set());
    scopeDecisions.get(key).add(rule.decision);
  });
  const conflictCount = Array.from(scopeDecisions.values())
    .filter(decisions => decisions.size > 1).length;
  const orderLabels = AGENT_PERMISSION_LAYERS
    .slice()
    .reverse()
    .map(layer => PERMISSION_LAYER_LABELS[layer] || layer);
  return {
    total: normalizedRules.length,
    decisionCounts,
    conflictCount,
    orderLabels,
    orderText: orderLabels.join(' > '),
    tieBreakText: '同层先看优先级，仍相同则以后添加的规则生效。',
    visibleRules: sortedRules.slice(0, 5).map(rule => ({
      id: rule.id,
      layer: rule.layer,
      layerLabel: PERMISSION_LAYER_LABELS[rule.layer] || rule.layer,
      decision: rule.decision,
      decisionLabel: PERMISSION_DECISION_LABELS[rule.decision] || rule.decision,
      toolName: rule.toolName,
      permission: rule.permission,
      source: rule.source,
      sessionId: rule.sessionId,
      reason: rule.reason,
      priority: rule.priority,
    })),
    overflow: Math.max(0, sortedRules.length - 5),
  };
};

const truncate = (value = '', maxLength = 160) => {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  const limit = Math.max(20, Math.trunc(Number(maxLength) || 160));
  return text.length > limit ? `${text.slice(0, limit - 1)}...` : text;
};

const toFiniteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeLimit = (value, fallback = 50, max = 200) => {
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  return Math.min(max, numeric);
};

const readArgsPreview = (src = {}) => {
  const candidates = [
    src.argsPreview,
    src.request?.argsPreview,
    src.toolCall?.arguments,
  ];
  return candidates.find(isPlainObject) || {};
};

const buildChatEmitPendingPreview = (toolName = '', args = {}) => {
  const name = trim(toolName);
  if (!name.startsWith('chat.emit_')) return null;
  const src = isPlainObject(args) ? args : {};
  if (name === 'chat.emit_private') {
    return {
      kind: '私聊候选',
      target: trim(src.targetName || src.targetId),
      speaker: trim(src.speakerName || src.speakerId),
      time: trim(src.time),
      contentPreview: truncate(src.content),
    };
  }
  if (name === 'chat.emit_group') {
    return {
      kind: src.system === true ? '群系统候选' : '群聊候选',
      target: trim(src.groupName || src.groupId),
      speaker: trim(src.speakerName || src.speakerId),
      time: trim(src.time),
      contentPreview: truncate(src.content),
    };
  }
  if (name === 'chat.emit_moment_comment') {
    return {
      kind: '动态评论候选',
      target: trim(src.momentId),
      speaker: trim(src.author),
      time: trim(src.time),
      contentPreview: truncate(src.content),
    };
  }
  if (name === 'chat.emit_moment_post') {
    return {
      kind: '动态发布候选',
      target: trim(src.momentId || src.author),
      speaker: trim(src.author),
      time: trim(src.time),
      contentPreview: truncate(src.content),
    };
  }
  return null;
};

const summarizeChatEmitCommitResult = (result = {}) => {
  const refs = isPlainObject(result?.refs) ? result.refs : {};
  const createdMessages = Array.isArray(refs.createdMessages) ? refs.createdMessages.length : 0;
  const createdMessageIds = Array.isArray(refs.createdMessageIds) ? refs.createdMessageIds.length : 0;
  const createdComments = Array.isArray(refs.createdCommentIds) ? refs.createdCommentIds.length : 0;
  const createdMoments = Array.isArray(refs.createdMomentIds) ? refs.createdMomentIds.length : 0;
  const parts = [];
  if (createdMessages || createdMessageIds) parts.push(`消息 ${createdMessages || createdMessageIds}`);
  if (createdComments) parts.push(`评论 ${createdComments}`);
  if (createdMoments) parts.push(`动态 ${createdMoments}`);
  return parts.join(' · ');
};

const buildChatEmitCommitState = (entry = {}, chatEmitPreview = null, chatEmitCommitPreview = null) => {
  if (!chatEmitPreview && !chatEmitCommitPreview) return null;
  const commitStatus = trim(entry.commitStatus, 'idle');
  const undoStatus = trim(entry.commitUndoStatus, 'idle');
  const resumeStatus = trim(entry.resumeStatus, 'idle');
  const commitResult = isPlainObject(entry.commitResult) ? entry.commitResult : null;
  const undoResult = isPlainObject(entry.commitUndoResult) ? entry.commitUndoResult : null;
  const userRejected = trim(commitResult?.reviewDecision || commitResult?.reason) === 'user_rejected';
  return {
    status: commitStatus,
    undoStatus,
    reviewDecision: trim(commitResult?.reviewDecision || commitResult?.reason),
    canCommit: !userRejected && resumeStatus === 'succeeded' && commitStatus !== 'running' &&
      commitStatus !== 'committed' && commitStatus !== 'undone',
    canUndo: commitStatus === 'committed' && undoStatus !== 'running' && undoStatus !== 'undone',
    resultSummary: summarizeChatEmitCommitResult(commitResult),
    undoSummary: summarizeChatEmitCommitResult(undoResult),
    message: trim(commitResult?.displayMessage || commitResult?.reason),
    undoMessage: trim(undoResult?.displayMessage || undoResult?.reason),
    errorMessage: trim(entry.commitErrorMessage),
    undoErrorMessage: trim(entry.commitUndoErrorMessage),
  };
};

const WRITE_PREVIEW_TOOL_META = Object.freeze({
  'memory.preview_actions': {
    kind: '记忆表写入预览',
    targetLabel: '会话',
    requestKey: 'actions',
    requestLabel: 'action',
  },
  'variable.preview_commands': {
    kind: '变量写入预览',
    targetLabel: '会话',
    requestKey: 'commands',
    requestLabel: 'command',
  },
  'worldbook.preview_actions': {
    kind: '世界书写入预览',
    targetLabel: '世界书',
    requestKey: 'actions',
    requestLabel: 'action',
  },
});

const readPreviewResult = (entry = {}) => {
  const resumeResult = isPlainObject(entry?.resumeResult) ? entry.resumeResult : null;
  const output = isPlainObject(resumeResult?.output) ? resumeResult.output : null;
  const result = output?.result ?? resumeResult?.result ?? entry?.previewResult ?? null;
  return isPlainObject(result) ? result : null;
};

const formatWritePreviewEntry = (entry = {}) => {
  const src = isPlainObject(entry) ? entry : {};
  const parts = [
    trim(src.kind || src.action || src.type, 'change'),
    trim(src.tableId || src.scope || src.path || src.entryId || src.title),
    src.reason ? `原因：${trim(src.reason)}` : '',
  ].filter(Boolean);
  const changedFields = Array.isArray(src.diff?.changedFields) ? src.diff.changedFields : [];
  if (changedFields.length) parts.push(`字段：${changedFields.slice(0, 5).join(', ')}`);
  return truncate(parts.join(' · '), 120);
};

const buildWritePreviewResultSummary = (result = {}) => {
  const src = isPlainObject(result) ? result : {};
  const parts = [];
  const changed = toFiniteNumber(src.changed, -1);
  const skipped = toFiniteNumber(src.skipped, -1);
  if (changed >= 0) parts.push(`变更 ${changed}`);
  if (skipped >= 0) parts.push(`跳过 ${skipped}`);
  ['inserted', 'updated', 'deleted'].forEach((key) => {
    const count = toFiniteNumber(src[key], 0);
    if (count > 0) parts.push(`${key} ${count}`);
  });
  if (Number.isFinite(Number(src.entryCountBefore)) && Number.isFinite(Number(src.entryCountAfter))) {
    parts.push(`条目 ${Number(src.entryCountBefore)} -> ${Number(src.entryCountAfter)}`);
  }
  return parts.join(' · ');
};

const summarizeWritePreviewCommitResult = (result = {}) => {
  const src = isPlainObject(result) ? result : {};
  const parts = [];
  const changed = toFiniteNumber(src.changed, -1);
  if (changed >= 0) parts.push(`变更 ${changed}`);
  ['inserted', 'updated', 'deleted', 'skipped'].forEach((key) => {
    const count = toFiniteNumber(src[key], 0);
    if (count > 0) parts.push(`${key} ${count}`);
  });
  const refs = isPlainObject(src.refs) ? src.refs : {};
  if (Array.isArray(refs.changedKeys) && refs.changedKeys.length) parts.push(`键 ${refs.changedKeys.length}`);
  if (refs.worldId) parts.push(`世界书 ${refs.worldId}`);
  return parts.join(' · ');
};

const buildWritePreviewCommitState = (entry = {}) => {
  const commitStatus = trim(entry.commitStatus, 'idle');
  const undoStatus = trim(entry.commitUndoStatus, 'idle');
  const resumeStatus = trim(entry.resumeStatus, 'idle');
  const commitResult = isPlainObject(entry.commitResult) ? entry.commitResult : null;
  const undoResult = isPlainObject(entry.commitUndoResult) ? entry.commitUndoResult : null;
  const userRejected = trim(commitResult?.reviewDecision || commitResult?.reason) === 'user_rejected';
  return {
    status: commitStatus,
    undoStatus,
    reviewDecision: trim(commitResult?.reviewDecision || commitResult?.reason),
    canCommit: !userRejected && resumeStatus === 'succeeded' && commitStatus !== 'running' &&
      commitStatus !== 'committed' && commitStatus !== 'undone',
    canUndo: commitStatus === 'committed' && undoStatus !== 'running' && undoStatus !== 'undone',
    resultSummary: summarizeWritePreviewCommitResult(commitResult),
    undoSummary: summarizeWritePreviewCommitResult(undoResult),
    message: trim(commitResult?.displayMessage || commitResult?.reason),
    undoMessage: trim(undoResult?.displayMessage || undoResult?.reason),
    errorMessage: trim(entry.commitErrorMessage),
    undoErrorMessage: trim(entry.commitUndoErrorMessage),
  };
};

const buildWritePreviewState = (toolName = '', args = {}, entry = {}) => {
  const meta = WRITE_PREVIEW_TOOL_META[trim(toolName)];
  if (!meta) return null;
  const payload = isPlainObject(args) ? args : {};
  const requestItems = Array.isArray(payload[meta.requestKey]) ? payload[meta.requestKey] : [];
  const result = readPreviewResult(entry);
  const resultEntries = Array.isArray(result?.entries) ? result.entries : [];
  const target = trim(payload.worldId || payload.sessionId || entry.sessionId);
  return {
    kind: meta.kind,
    targetLabel: meta.targetLabel,
    target,
    requestCount: requestItems.length,
    requestLabel: meta.requestLabel,
    requestSummary: `${requestItems.length} ${meta.requestLabel}${requestItems.length === 1 ? '' : 's'}`,
    previewReady: Boolean(result),
    resultSummary: result ? buildWritePreviewResultSummary(result) : '',
    changed: result ? toFiniteNumber(result.changed, 0) : 0,
    skipped: result ? toFiniteNumber(result.skipped, 0) : 0,
    rollbackReady: Boolean(result?.rollbackSnapshot),
    entries: resultEntries.slice(0, 6).map(formatWritePreviewEntry).filter(Boolean),
    entryOverflow: Math.max(0, resultEntries.length - 6),
    currentExecutionWrites: false,
    commitRequiresUserConfirmation: true,
    commit: buildWritePreviewCommitState(entry),
  };
};

const normalizePendingPermission = (entry = {}) => {
  const src = isPlainObject(entry) ? entry : {};
  const toolName = trim(src.toolName || src.request?.toolName || src.toolCall?.toolName, 'tool');
  const argsPreview = readArgsPreview(src);
  const chatEmitPreview = buildChatEmitPendingPreview(toolName, argsPreview);
  const chatEmitCommitPreview = buildChatEmitCommitPreview({
    toolName,
    args: argsPreview,
    sessionId: trim(src.sessionId || src.interaction?.sessionId),
  });
  return {
    kind: 'tool_permission',
    id: trim(src.id),
    status: trim(src.status, 'pending'),
    toolName,
    sessionId: trim(src.sessionId || src.interaction?.sessionId),
    source: trim(src.source, 'provider-tool-permission'),
    riskLevel: trim(src.riskLevel || src.request?.riskLevel, 'low'),
    permissions: list(src.permissions?.length ? src.permissions : src.request?.permissions),
    createdAt: toFiniteNumber(src.createdAt, 0),
    expiresAt: toFiniteNumber(src.expiresAt, 0),
    reason: trim(src.reason),
    resumeStatus: trim(src.resumeStatus, 'idle'),
    continuationStatus: trim(src.continuationStatus, 'idle'),
    chatEmitPreview,
    chatEmitCommitPreview,
    chatEmitCommit: buildChatEmitCommitState(src, chatEmitPreview, chatEmitCommitPreview),
    writePreview: buildWritePreviewState(toolName, argsPreview, src),
  };
};

const summarizeProfileCandidate = (profile = null) => {
  const src = isPlainObject(profile) ? profile : {};
  const parts = [];
  if (src.displayName) parts.push(trim(src.displayName));
  const traits = Array.isArray(src.stable_traits) ? src.stable_traits : [];
  const focus = Array.isArray(src.interaction_focus) ? src.interaction_focus : [];
  if (traits.length) parts.push(`特征 ${traits.length}`);
  if (focus.length) parts.push(`互动重点 ${focus.length}`);
  return parts.filter(Boolean).join(' · ');
};

const normalizeContactProfilePendingUpdate = (entry = {}) => {
  const src = isPlainObject(entry) ? entry : {};
  const contactId = trim(src.contactId || src.contact_id || src.profile?.contactId || src.profile?.id);
  return {
    kind: 'contact_profile_update',
    id: trim(src.id),
    status: trim(src.status, 'pending'),
    toolName: '联系人画像更新',
    sessionId: contactId,
    source: 'contact-profiler-agent',
    riskLevel: 'medium',
    permissions: ['storage:write'],
    createdAt: toFiniteNumber(src.createdAt || src.created_at, 0),
    expiresAt: 0,
    reason: trim(src.reason),
    resumeStatus: 'idle',
    continuationStatus: 'idle',
    contactId,
    profileSummary: summarizeProfileCandidate(src.profile),
  };
};

const hasPendingCenterAction = (item = {}) => {
  if (!isPlainObject(item)) return false;
  if (item.kind === 'contact_profile_update') return item.status === 'pending';
  if (item.kind !== 'tool_permission') return item.status === 'pending';
  if (item.status === 'pending') return true;
  const chatCommit = item.chatEmitCommit || null;
  if (chatCommit?.canCommit || chatCommit?.canUndo) return true;
  const writeCommit = item.writePreview?.commit || null;
  if (writeCommit?.canCommit || writeCommit?.canUndo) return true;
  return false;
};

const normalizeTool = (tool = {}) => {
  const src = isPlainObject(tool) ? tool : {};
  const capabilities = isPlainObject(src.capabilities) ? src.capabilities : {};
  return {
    name: trim(src.name, 'tool'),
    title: trim(src.title || src.label, trim(src.name, 'tool')),
    description: trim(src.description),
    source: trim(src.source, 'internal'),
    riskLevel: trim(src.riskLevel || src.risk, 'low'),
    permissions: list(src.permissions),
    executionMode: trim(src.executionMode, 'sequential'),
    capabilities: {
      read: capabilities.read === true,
      write: capabilities.write === true,
      network: capabilities.network === 'opt_in' ? 'opt_in' : capabilities.network === true,
      cost: trim(capabilities.cost, 'none'),
      undo: trim(capabilities.undo, 'none'),
      modelContext: trim(capabilities.modelContext, 'none'),
      confirmation: trim(capabilities.confirmation, 'allow_once'),
    },
  };
};

const MODEL_MODE_LABELS = Object.freeze({
  follow_current: '跟随当前聊天模型',
  profile: '使用指定模型',
  none: '不调用模型',
});

const TRIGGER_MODE_LABELS = Object.freeze({
  auto: '自动触发',
  auto_model: '自动触发',
  local_only: '自动触发',
  manual: '手动触发',
  manual_only: '手动触发',
});

const normalizeAgentModelProfile = (profile = {}) => {
  const src = isPlainObject(profile) ? profile : {};
  const id = trim(src.id);
  const name = trim(src.name || src.label || src.id);
  const provider = trim(src.provider);
  const model = trim(src.model);
  const providerModel = [provider, model].filter(Boolean).join(' / ');
  return {
    id,
    name,
    provider,
    model,
    label: trim([name, providerModel].filter(Boolean).join(' · '), name || providerModel || id),
  };
};

const resolveAgentModelLabel = (modelMode = '', modelProfileId = '', modelProfiles = [], modelOverride = '') => {
  const mode = trim(modelMode, 'follow_current');
  if (mode !== 'profile') return MODEL_MODE_LABELS[mode] || '跟随当前聊天模型';
  const profile = (Array.isArray(modelProfiles) ? modelProfiles : []).find(item => item.id === trim(modelProfileId));
  const base = profile?.label || (modelProfileId ? `指定模型：${modelProfileId}` : '使用指定模型');
  const override = trim(modelOverride);
  return override ? `${base} · ${override}` : base;
};

const normalizeAgentFeature = (feature = {}, { modelProfiles = [] } = {}) => {
  const src = isPlainObject(feature) ? feature : {};
  const state = isPlainObject(src.state) ? src.state : {};
  const modelMode = trim(state.modelMode || src.modelDefault, 'none');
  const modelProfileId = trim(state.modelProfileId);
  const modelOverride = trim(state.modelOverride);
  return {
    id: trim(src.id),
    title: trim(src.title, 'Agent'),
    summary: trim(src.summary),
    detailTitle: trim(src.detailTitle || src.title, 'Agent'),
    detail: list(src.detail),
    enabled: src.enabled === true || state.enabled === true,
    implemented: src.implemented === true,
    ...(src.id === 'text_completion' ? { inputConsent: state.inputConsent === true } : {}),
    supportsModel: src.supportsModel === true,
    supportsTriggerMode: src.supportsTriggerMode === true,
    modelMode,
    modelProfileId,
    modelOverride,
    modelLabel: resolveAgentModelLabel(modelMode, modelProfileId, modelProfiles, modelOverride),
    triggerMode: trim(state.triggerMode || src.triggerDefault, 'auto'),
    triggerLabel: TRIGGER_MODE_LABELS[trim(state.triggerMode || src.triggerDefault, 'auto')] || '自动触发',
    updatedAt: toFiniteNumber(state.updatedAt, 0),
  };
};

const normalizeSafety = ({
  sessionGate = null,
  experimentStatus = null,
  permissionRules = [],
  continuationCommitPolicy = null,
} = {}) => {
  const gate = isPlainObject(sessionGate) ? sessionGate : {};
  const experiment = isPlainObject(experimentStatus) ? experimentStatus : {};
  const policy = isPlainObject(continuationCommitPolicy) ? continuationCommitPolicy : {};
  const gateAllowedTools = list(gate.allowedTools);
  const writePreviewTools = Array.from(WRITE_PREVIEW_PROVIDER_MODEL_CONTEXT_TOOLS);
  const activeWritePreviewTools = writePreviewTools.filter(tool => gateAllowedTools.includes(tool));
  return {
    sessionGate: {
      enabled: gate.enabled === true,
      networkAllowed: gate.networkAllowed === true,
      realRunnerAllowed: gate.realRunnerAllowed === true,
      source: trim(gate.source),
      allowedTools: gateAllowedTools,
      writePreviewTools: {
        enabled: activeWritePreviewTools.length === writePreviewTools.length,
        activeTools: activeWritePreviewTools,
        availableTools: writePreviewTools,
      },
    },
    providerTools: {
      enabled: experiment.enabled === true,
      allowedTools: list(experiment.allowedTools),
    },
    permissionRules: Array.isArray(permissionRules) ? permissionRules.slice() : [],
    permissionRuleSummary: buildPermissionRuleSummary(permissionRules),
    continuationCommitPolicy: {
      defaultStrategy: trim(policy.defaultStrategy, 'preview_only'),
      strategies: list(policy.strategies),
    },
  };
};

const buildTabs = ({
  pending = [],
  runView = {},
  agents = [],
  promptModules = [],
  globalPromptLibrary = null,
  diagnosticViews = [],
  resources = [],
} = {}) => AGENT_CENTER_TABS.map((tab) => {
  let count = 0;
  if (tab.id === 'pending') count = pending.length;
  if (tab.id === 'agents') count = agents.length;
  if (tab.id === 'prompts') count = promptModules.length;
  if (tab.id === 'global_prompts') count = Number(globalPromptLibrary?.blocks?.length || 0);
  if (tab.id === 'diagnostics') count = diagnosticViews.length;
  if (tab.id === 'resources') count = resources.filter(item => Number(item.count || 0) > 0).length;
  if (tab.id === 'activity') count = Number(runView?.meta?.scopedActive ?? runView?.meta?.active ?? 0);
  if (tab.id === 'safety') count = 0;
  return { ...tab, count };
});

export const buildAgentCenterView = ({
  pendingPermissions = [],
  contactProfilePendingUpdates = [],
  agentRunView = null,
  agentRuns = [],
  agentRunEvents = [],
  tools = [],
  agentFeatureSettings = null,
  agentFeatures = null,
  agentCenterSettings = null,
  agentProfileView = null,
  agentModelProfiles = [],
  permissionRules = [],
  sessionGate = null,
  experimentStatus = null,
  continuationCommitPolicy = null,
  resourceStatus = {},
  memoryMode = 'table',
  limit = 50,
} = {}) => {
  const normalizedMemoryMode = normalizeMemoryMode(memoryMode);
  const pending = (Array.isArray(pendingPermissions) ? pendingPermissions : [])
    .map(normalizePendingPermission)
    .concat((Array.isArray(contactProfilePendingUpdates) ? contactProfilePendingUpdates : [])
      .map(normalizeContactProfilePendingUpdate))
    .filter(hasPendingCenterAction)
    .sort((a, b) => toFiniteNumber(b.createdAt, 0) - toFiniteNumber(a.createdAt, 0));
  const runView = isPlainObject(agentRunView)
    ? agentRunView
    : buildAgentRunListView(agentRuns, {
      events: agentRunEvents,
      limit: normalizeLimit(limit),
    });
  const normalizedTools = (Array.isArray(tools) ? tools : [])
    .map(normalizeTool)
    .sort((a, b) => a.name.localeCompare(b.name));
  const normalizedModelProfiles = (Array.isArray(agentModelProfiles) ? agentModelProfiles : [])
    .map(normalizeAgentModelProfile)
    .filter(profile => profile.id)
    .sort((a, b) => a.label.localeCompare(b.label));
  const normalizedAgents = (Array.isArray(agentFeatures) ? agentFeatures : buildAgentFeatureList(agentFeatureSettings || {}))
    .map(feature => normalizeAgentFeature(feature, { modelProfiles: normalizedModelProfiles }))
    .filter(agent => agent.id);
  const agentCards = buildAgentCardList({
    featureAgents: normalizedAgents,
    agentCenterSettings,
    runView,
    memoryMode: normalizedMemoryMode,
  });
  const promptModules = buildAgentPromptModuleCardList({
    agentCenterSettings,
    runView,
    memoryMode: normalizedMemoryMode,
  });
  const diagnosticViews = buildAgentDiagnosticCardList({
    agentCenterSettings,
    runView,
    memoryMode: normalizedMemoryMode,
  });
  const safety = normalizeSafety({
    sessionGate,
    experimentStatus,
    permissionRules,
    continuationCommitPolicy,
  });
  const resources = buildAgentCenterResources({
    pending,
    tools: normalizedTools,
    agents: normalizedAgents,
    safety,
    resourceStatus,
  });
  const globalPromptLibrary = normalizeGlobalSemanticPromptLibrary(
    agentCenterSettings?.global?.semanticPromptLibrary,
  );
  const tabs = buildTabs({
    pending,
    runView,
    agents: agentCards,
    promptModules,
    diagnosticViews,
    resources,
    globalPromptLibrary,
  });
  return {
    tabs,
    meta: {
      pending: pending.length,
      activeRuns: Number(runView?.meta?.scopedActive ?? runView?.meta?.active ?? 0),
      failedRuns: Number(runView?.meta?.scopedFailures ?? runView?.meta?.failures ?? 0),
      unreadFailedRuns: Number(runView?.meta?.scopedUnreadFailures ?? runView?.meta?.unreadFailures ?? runView?.meta?.scopedFailures ?? runView?.meta?.failures ?? 0),
      newestFailureAt: Number(runView?.meta?.scopedNewestFailureAt ?? runView?.meta?.newestFailureAt ?? 0),
      tools: normalizedTools.length,
      resources: resources.length,
      resourceAlerts: resources.filter(item => Number(item.count || 0) > 0).length,
      agents: agentCards.length,
      promptModules: promptModules.length,
      globalPromptBlocks: globalPromptLibrary.blocks.length,
      diagnosticViews: diagnosticViews.length,
      featureAgents: normalizedAgents.length,
      enabledAgents: agentCards.filter(item => item.enabled).length,
      enabledPromptModules: promptModules.filter(item => item.enabled).length,
      enabledFeatureAgents: normalizedAgents.filter(item => item.enabled).length,
      memoryMode: normalizedMemoryMode,
      providerToolsEnabled: safety.providerTools.enabled,
      sessionGateEnabled: safety.sessionGate.enabled,
    },
    pending,
    activity: {
      meta: runView?.meta || {},
      filters: runView?.filters || {},
      runs: Array.isArray(runView?.runs) ? runView.runs : [],
      // 原始 runs 未直传时退回已建列表视图的 runs（summary 已带 usage/kind），只读画像用当前可见集
      usageProfile: buildAgentUsageProfile(
        Array.isArray(agentRuns) && agentRuns.length ? agentRuns : (Array.isArray(runView?.runs) ? runView.runs : []),
      ),
    },
    agents: agentCards,
    agentCards,
    promptModules,
    globalPromptLibrary,
    diagnosticViews,
    featureAgents: normalizedAgents,
    agentProfileView: isPlainObject(agentProfileView) ? agentProfileView : null,
    agentModelProfiles: normalizedModelProfiles,
    resources,
    tools: normalizedTools,
    safety,
  };
};
