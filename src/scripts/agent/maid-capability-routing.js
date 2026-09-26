import {
  listAppFeatures,
  searchAppFeatures,
} from './app-feature-catalog.js';
import {
  searchMaidCapabilityConcepts,
  stripNegatedMaidCapabilityActions,
} from './maid-capability-concept-retriever.js';
import { readMaidSkill } from './maid-skill-catalog.js';
import { getMaidLoadedSkillFeatures } from './maid-skill-context.js';

export const MAID_CAPABILITY_ROUTING_CONFIG_KEY = 'maid_capability_routing_v1';
export const MAID_CAPABILITY_RETRIEVER_VERSION = 'maid-capability-retriever-v4';

export const MAID_CAPABILITY_ROUTING_MODES = Object.freeze({
  shadow: 'shadow',
  canary: 'canary',
  bounded: 'bounded',
});

const ROUTING_MODE_SET = new Set(Object.values(MAID_CAPABILITY_ROUTING_MODES));
const CONTROL_CAPABILITY_ID = 'app.capabilities.search';
const MULTI_STEP_TODO_CAPABILITY_ID = 'maid.todo';
const DEFAULT_CANDIDATE_LIMIT = 8;
const SKILL_REFERENCE_SCORE = 40;
const DEFAULT_STICKY_LIMIT = 4;
const DEFAULT_MIN_SCORE = 45;
const MAX_SNAPSHOT_CACHE = 256;

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const clone = (value, fallback = null) => {
  if (value === undefined) return fallback;
  if (value === null || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

const clampInteger = (value, min, max, fallback) => {
  const number = Math.trunc(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
};

const clampNumber = (value, min, max, fallback) => {
  const number = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
};

const canonicalToken = (value = '') => trim(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s_-]+/g, '.')
  .replace(/\.+/g, '.')
  .replace(/^\.|\.$/g, '');

const compactSearchToken = (value = '') => trim(value)
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '');

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};

const hashText = (value = '') => {
  const text = String(value ?? '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const createId = (prefix = 'cap') => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
};

const levenshteinDistance = (left = '', right = '') => {
  const a = String(left || '');
  const b = String(right || '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
};

const isLowRiskReadOnly = feature => (
  trim(feature?.riskLevel, 'low') === 'low' && feature?.writes !== true
);

const RISK_LEVEL_WEIGHT = Object.freeze({ low: 0, medium: 1, high: 2 });
const getRiskLevelWeight = value => (
  Object.hasOwn(RISK_LEVEL_WEIGHT, value) ? RISK_LEVEL_WEIGHT[value] : RISK_LEVEL_WEIGHT.high
);

const highestRiskLevel = (values = []) => (Array.isArray(values) ? values : [values])
  .map(value => trim(value, 'low').toLowerCase())
  .map(value => (Object.hasOwn(RISK_LEVEL_WEIGHT, value) ? value : 'high'))
  .reduce((highest, value) => (
    getRiskLevelWeight(value) > getRiskLevelWeight(highest) ? value : highest
  ), 'low');

const buildNearestCandidates = (featureId = '', features = [], limit = 3) => {
  const target = canonicalToken(featureId);
  if (!target) return [];
  return (Array.isArray(features) ? features : [])
    .map(feature => ({
      id: trim(feature?.id),
      distance: levenshteinDistance(target, canonicalToken(feature?.id)),
    }))
    .filter(item => item.id)
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
};

const findExactFeature = (featureId = '', features = []) => {
  const token = canonicalToken(featureId);
  if (!token) return null;
  return (Array.isArray(features) ? features : []).find(feature => (
    canonicalToken(feature?.id) === token ||
    canonicalToken(feature?.title) === token ||
    list(feature?.aliases).some(alias => canonicalToken(alias) === token)
  )) || null;
};

const findExactToolInFeature = (toolName = '', feature = {}) => {
  const token = canonicalToken(toolName);
  if (!token) return '';
  return list(feature?.tools).find(tool => canonicalToken(tool) === token) || '';
};

const findToolOwners = (toolName = '', features = []) => {
  const token = canonicalToken(toolName);
  if (!token) return [];
  return (Array.isArray(features) ? features : []).filter(feature => (
    list(feature?.tools).some(tool => canonicalToken(tool) === token)
  ));
};

const resolveUniqueFuzzyFeature = (featureId = '', features = []) => {
  const target = canonicalToken(featureId);
  if (!target) return null;
  const prefixMatches = (Array.isArray(features) ? features : []).filter(feature => {
    const id = canonicalToken(feature?.id);
    return id && (id.startsWith(target) || target.startsWith(id));
  });
  if (prefixMatches.length === 1 && isLowRiskReadOnly(prefixMatches[0])) {
    return { feature: prefixMatches[0], rule: 'unique_prefix', confidence: 0.96 };
  }

  const ranked = (Array.isArray(features) ? features : [])
    .filter(isLowRiskReadOnly)
    .map(feature => ({ feature, distance: levenshteinDistance(target, canonicalToken(feature?.id)) }))
    .sort((a, b) => a.distance - b.distance || trim(a.feature?.id).localeCompare(trim(b.feature?.id)));
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return null;
  const maxDistance = target.length >= 12 ? 2 : 1;
  if (best.distance > maxDistance) return null;
  if (second && second.distance - best.distance < 2) return null;
  return { feature: best.feature, rule: 'edit_distance', confidence: best.distance === 1 ? 0.92 : 0.86 };
};

const resolveUniqueFuzzyTool = (toolName = '', feature = {}) => {
  if (!isLowRiskReadOnly(feature)) return null;
  const target = canonicalToken(toolName);
  if (!target) return null;
  const tools = list(feature?.tools);
  const prefixMatches = tools.filter(tool => {
    const token = canonicalToken(tool);
    return token.startsWith(target) || target.startsWith(token);
  });
  if (prefixMatches.length === 1) {
    return { toolName: prefixMatches[0], rule: 'unique_tool_prefix', confidence: 0.96 };
  }
  const ranked = tools
    .map(tool => ({ tool, distance: levenshteinDistance(target, canonicalToken(tool)) }))
    .sort((a, b) => a.distance - b.distance || a.tool.localeCompare(b.tool));
  const best = ranked[0];
  const second = ranked[1];
  if (!best) return null;
  const maxDistance = target.length >= 12 ? 2 : 1;
  if (best.distance > maxDistance || (second && second.distance - best.distance < 2)) return null;
  return { toolName: best.tool, rule: 'tool_edit_distance', confidence: best.distance === 1 ? 0.92 : 0.86 };
};

export const resolveCandidateCapabilitySelection = ({
  featureId = '',
  toolName = '',
  features = [],
  allowFuzzy = true,
} = {}) => {
  const candidates = Array.isArray(features) ? features : [];
  const originalFeatureId = trim(featureId);
  const originalToolName = trim(toolName);
  const exactToolOwners = findToolOwners(originalToolName, candidates);
  let feature = findExactFeature(originalFeatureId, candidates);
  let resolvedToolName = feature ? findExactToolInFeature(originalToolName, feature) : '';
  let correction = null;

  if ((!feature || !resolvedToolName) && exactToolOwners.length === 1) {
    feature = exactToolOwners[0];
    resolvedToolName = findExactToolInFeature(originalToolName, feature);
    correction = {
      originalId: originalFeatureId,
      resolvedId: trim(feature.id),
      rule: 'unique_tool_owner',
      confidence: 1,
    };
  }

  if (!feature && allowFuzzy) {
    const fuzzyFeature = resolveUniqueFuzzyFeature(originalFeatureId, candidates);
    if (fuzzyFeature) {
      feature = fuzzyFeature.feature;
      correction = {
        originalId: originalFeatureId,
        resolvedId: trim(feature.id),
        rule: fuzzyFeature.rule,
        confidence: fuzzyFeature.confidence,
      };
      resolvedToolName = findExactToolInFeature(originalToolName, feature);
    }
  }

  if (!feature) {
    return {
      ok: false,
      reason: 'feature_not_found',
      nearestCandidates: buildNearestCandidates(originalFeatureId, candidates),
    };
  }

  if (!resolvedToolName && allowFuzzy) {
    const fuzzyTool = resolveUniqueFuzzyTool(originalToolName, feature);
    if (fuzzyTool) {
      resolvedToolName = fuzzyTool.toolName;
      correction = correction || {
        originalId: originalToolName,
        resolvedId: resolvedToolName,
        rule: fuzzyTool.rule,
        confidence: fuzzyTool.confidence,
      };
    }
  }

  if (!resolvedToolName) {
    return {
      ok: false,
      reason: 'tool_not_allowed',
      feature,
      nearestCandidates: buildNearestCandidates(originalFeatureId, candidates),
    };
  }

  return {
    ok: true,
    feature,
    toolName: resolvedToolName,
    correction,
    nearestCandidates: [],
  };
};

export const normalizeMaidCapabilityRoutingConfig = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const mode = trim(src.mode, MAID_CAPABILITY_ROUTING_MODES.shadow).toLowerCase();
  const candidateLimit = clampInteger(src.candidateLimit, 3, 8, DEFAULT_CANDIDATE_LIMIT);
  return {
    mode: ROUTING_MODE_SET.has(mode) ? mode : MAID_CAPABILITY_ROUTING_MODES.shadow,
    canaryPercent: clampNumber(src.canaryPercent, 0, 100, 0),
    candidateLimit,
    stickyLimit: clampInteger(
      src.stickyLimit,
      1,
      Math.min(4, Math.max(1, candidateLimit - 2)),
      DEFAULT_STICKY_LIMIT,
    ),
    minScore: clampNumber(src.minScore, 1, 100, DEFAULT_MIN_SCORE),
  };
};

export const readMaidCapabilityRoutingConfig = ({
  storage = globalThis?.localStorage || null,
  globalOverride = globalThis?.__MAID_CAPABILITY_ROUTING__ || null,
} = {}) => {
  let persisted = {};
  try {
    const raw = storage?.getItem?.(MAID_CAPABILITY_ROUTING_CONFIG_KEY);
    if (raw) persisted = JSON.parse(raw);
  } catch {}
  return normalizeMaidCapabilityRoutingConfig({
    ...(isPlainObject(persisted) ? persisted : {}),
    ...(isPlainObject(globalOverride) ? globalOverride : {}),
  });
};

export const writeMaidCapabilityRoutingConfig = (raw = {}, {
  storage = globalThis?.localStorage || null,
} = {}) => {
  const config = normalizeMaidCapabilityRoutingConfig(raw);
  try {
    storage?.setItem?.(MAID_CAPABILITY_ROUTING_CONFIG_KEY, JSON.stringify(config));
  } catch {}
  return config;
};

export const createMaidCapabilityRetriever = ({
  version = MAID_CAPABILITY_RETRIEVER_VERSION,
  search = searchAppFeatures,
  conceptSearch = searchMaidCapabilityConcepts,
} = {}) => ({
  version: trim(version, MAID_CAPABILITY_RETRIEVER_VERSION),
  retrieve: (query = '', { limit = 20, features = [] } = {}) => {
    const merged = new Map();
    for (const backend of [search, conceptSearch]) {
      if (typeof backend !== 'function') continue;
      const result = backend(query, { limit, features });
      for (const match of Array.isArray(result) ? result : []) {
        const id = trim(match?.id);
        if (!id) continue;
        const existing = merged.get(id);
        if (!existing || Number(match?.score || 0) > Number(existing?.score || 0)) {
          merged.set(id, { ...(existing || {}), ...match });
        } else if (trim(match?.retrievalReason)) {
          merged.set(id, {
            ...existing,
            retrievalReason: trim(match.retrievalReason),
            conceptCodes: Array.from(new Set([
              ...list(existing?.conceptCodes),
              ...list(match?.conceptCodes),
            ])),
          });
        }
      }
    }
    return Array.from(merged.values())
      .sort((left, right) => (
        Number(right?.score || 0) - Number(left?.score || 0) ||
        trim(left?.id).localeCompare(trim(right?.id))
      ))
      .slice(0, Math.max(1, Math.min(40, Math.trunc(Number(limit) || 20))));
  },
});

const hasExplicitHighRiskIntent = (input = '', feature = {}) => {
  if (trim(feature?.riskLevel, 'low') !== 'high') return true;
  const text = String(input || '').normalize('NFKC');
  if (
    /(?:只读|只查询|只查|仅查询|仅核对)/iu.test(text) &&
    !/(?:删除预览|预览.{0,12}删除|preview)/iu.test(text)
  ) return false;
  const positiveText = stripNegatedMaidCapabilityActions(text);
  return /(?:删除|删掉|移除|清空|清除|清理(?!后)|去重|覆盖|替换|delete|remove|clear|dedupe|overwrite|replace)/iu.test(positiveText);
};

const detectLanguage = (input = '') => (/\p{Script=Han}/u.test(String(input || '')) ? 'zh' : 'other');

const inferPlatform = (context = {}) => {
  const explicit = trim(context?.platform).toLowerCase();
  if (explicit) return explicit;
  const userAgent = trim(globalThis?.navigator?.userAgent).toLowerCase();
  if (userAgent.includes('android')) return 'android';
  if (userAgent.includes('windows')) return 'windows';
  return 'unknown';
};

const buildSchemaIndexText = (toolSchemas = {}) => compactSearchToken(
  Object.entries(isPlainObject(toolSchemas) ? toolSchemas : {})
    .flatMap(([toolName, schema]) => [toolName, stableJson(schema)])
    .join(' '),
);

const estimateToolSchemaTokens = (features = []) => Math.ceil(
  (Array.isArray(features) ? features : []).reduce((total, feature) => (
    total + stableJson(isPlainObject(feature?.toolSchemas) ? feature.toolSchemas : {}).length
  ), 0) / 4,
);

const buildToolProjection = ({ feature = {}, toolRegistry = null, permissionEvaluator = null, context = {} } = {}) => {
  const allowedTools = [];
  const allowedDefinitions = [];
  const toolSchemas = {};
  const excludedTools = [];
  for (const toolName of list(feature?.tools)) {
    const definition = toolRegistry?.get?.(toolName) || null;
    if (!definition) {
      excludedTools.push({ toolName, reason: 'tool_missing' });
      continue;
    }
    let permission = { decision: 'allow' };
    try {
      permission = permissionEvaluator?.evaluateTool?.(definition, {
        sessionId: trim(context?.sessionId),
        agentId: 'maid-assistant',
        source: definition.source || 'maid-assistant',
        toolName: definition.name,
      }) || permission;
    } catch {
      permission = { decision: 'deny' };
    }
    if (permission.decision === 'deny') {
      excludedTools.push({ toolName, reason: 'permission_denied' });
      continue;
    }
    allowedTools.push(toolName);
    allowedDefinitions.push(definition);
    toolSchemas[toolName] = clone(definition.schema, { type: 'object' });
  }
  if (!allowedTools.length) return { feature: null, excludedTools };
  const version = trim(feature?.version, '1');
  const riskLevel = highestRiskLevel([
    feature?.riskLevel,
    ...allowedDefinitions.map(definition => definition?.riskLevel),
  ]);
  const writes = feature?.writes === true || allowedDefinitions.some(definition => definition?.capabilities?.write === true);
  const schemaHash = hashText(stableJson({
    id: feature.id,
    version,
    tools: allowedTools,
    toolSchemas,
    riskLevel,
    writes,
    confirmation: feature.confirmation,
    verification: feature.verification,
  }));
  return {
    feature: {
      ...clone(feature, {}),
      tools: allowedTools,
      toolSchemas,
      riskLevel,
      writes,
      capabilityRef: {
        id: trim(feature.id),
        version,
        namespace: trim(feature.namespace, 'builtin'),
        kind: trim(feature.kind, 'tool'),
        provider: trim(feature.provider, 'app'),
        ref: trim(feature.id),
        schemaHash,
      },
      schemaHash,
    },
    excludedTools,
  };
};

// 多步任务的步骤级意图藏在女仆自己的 todo 计划文本里（用户原话不含线索）：
// 取最近一次 todo 读写步骤的未完成项文本，作为低权重检索查询。
const extractTodoPlanText = (steps = []) => {
  const listSteps = Array.isArray(steps) ? steps : [];
  for (let i = listSteps.length - 1; i >= 0; i -= 1) {
    const step = listSteps[i];
    const tool = trim(step?.toolName);
    if (tool !== 'maid.todo.write' && tool !== 'maid.todo.read') continue;
    const todos = Array.isArray(step?.output?.todos) && step.output.todos.length
      ? step.output.todos
      : (Array.isArray(step?.args?.todos) ? step.args.todos : []);
    const pending = todos
      .filter(todo => trim(todo?.status, 'pending') !== 'completed')
      .map(todo => trim(todo?.content))
      .filter(Boolean);
    if (pending.length) return pending.join(' ').slice(0, 400);
  }
  return '';
};

const buildRetrievalTexts = (input = '', context = {}, steps = []) => {
  const texts = [];
  const add = (text, weight, reason) => {
    const value = trim(text);
    if (value) texts.push({ text: value.slice(0, 1000), weight, reason });
  };
  add(input, 1, 'intent');
  String(input || '')
    .split(/(?:[，,、；;。]|然后|并且|以及|同时|接着|再帮我)/u)
    .map(item => trim(item))
    .filter(item => item && item !== trim(input))
    .slice(0, 6)
    .forEach(item => add(item, 0.95, 'sub_intent'));
  const listSteps = Array.isArray(steps) ? steps : [];
  const last = listSteps.at(-1) || null;
  if (last) {
    add([
      last.toolName,
      last.featureId,
      last.status,
      last.failureCode,
      last.summary,
      last.errorMessage,
      stableJson(last.output || {}).slice(0, 600),
    ].filter(Boolean).join(' '), 0.7, 'observation');
  }
  add([context?.activePage, context?.uiMode].filter(Boolean).join(' '), 0.35, 'ui_context');
  const historyText = trim(context?.maidConversationContext?.historyText);
  if (historyText) {
    add(`${historyText.slice(-800)}\n当前请求：${trim(input)}`, 0.6, 'history_context');
  }
  add(extractTodoPlanText(listSteps), 0.6, 'todo_plan');
  return texts;
};

const getMissingExplicitMessageSessions = (input = '', steps = []) => {
  const text = String(input || '').normalize('NFKC');
  if (!/(?:发送|写入|发出).{0,20}(?:用户)?消息/iu.test(text)) return [];
  const targets = Array.from(text.matchAll(/「([^」]{1,100})」/gu))
    .map(match => trim(match[1]))
    .filter(Boolean);
  if (!targets.length) return [];
  const listStep = (Array.isArray(steps) ? steps : []).findLast(step => (
    step?.status === 'succeeded' &&
    trim(step?.toolName) === 'session.list' &&
    Array.isArray(step?.output?.contacts)
  ));
  if (!listStep) return [];
  const existing = new Set(
    listStep.output.contacts
      .flatMap(item => [trim(item?.id), trim(item?.name)])
      .filter(Boolean)
      .map(item => item.normalize('NFKC').toLowerCase()),
  );
  return Array.from(new Set(targets)).filter(target => (
    !existing.has(target.normalize('NFKC').toLowerCase())
  ));
};

const getReactDependencyCapabilityIds = (input = '', steps = []) => {
  const text = String(input || '').normalize('NFKC');
  const source = Array.isArray(steps) ? steps : [];
  const last = source.at(-1) || null;
  if (!last) return [];
  const ids = new Set();
  const lastTool = trim(last?.toolName);
  const lastOutputText = stableJson(last?.output || {});

  if (
    lastTool === 'session.list' &&
    /(?:创建|新建|新增|建立).{0,32}(?:会话|聊天室|房间)/iu.test(text)
  ) {
    ids.add('session.create');
  }
  if (
    lastTool === 'session.delete_many' &&
    /(?:取消|验证|核对|仍(?:然)?存在|不应删除)/iu.test(text)
  ) {
    ids.add('session.list');
  }
  if (
    lastTool === 'media.generate_image' &&
    last?.status !== 'succeeded' &&
    /(?:配置|渠道|模型|尺寸|比例|方形|横向|preset|profile|aspect)/iu.test(lastOutputText)
  ) {
    ids.add('config.model.switch');
  }
  if (
    lastTool === 'app.read_resource' &&
    last?.status !== 'succeeded' &&
    /(?:session_not_found|会话不存在|聊天室不存在|无法解析.{0,12}(?:会话|聊天室))/iu.test(lastOutputText)
  ) {
    ids.add('session.list');
  }
  if (
    lastTool === 'maid.memory.list' &&
    /(?:maid\.memory\.archive|归档|忘掉|忘记|软归档)/iu.test(text)
  ) {
    ids.add('maid.memory.archive');
  }
  if (
    ['app.read_resource', 'session.list'].includes(lastTool) &&
    /(?:当前角色卡下|当前角色卡|当前身份).{0,32}(?:会话|聊天室|清单|列表)/iu.test(text)
  ) {
    ids.add('app.state.read');
  }
  return Array.from(ids);
};

const getFeatureById = (features = [], featureId = '') => {
  const target = canonicalToken(featureId);
  return (Array.isArray(features) ? features : []).find(feature => canonicalToken(feature?.id) === target) || null;
};

const hashBucket = (value = '') => Number.parseInt(hashText(value).slice(-6), 16) % 10000 / 100;

export const createMaidCapabilityRoutingRuntime = ({
  features = listAppFeatures(),
  toolRegistry = null,
  permissionEvaluator = null,
  retrievalStore = null,
  retriever = null,
  getConversationContext = null,
  storage = globalThis?.localStorage || null,
  now = Date.now,
  retrieverVersion = MAID_CAPABILITY_RETRIEVER_VERSION,
  logger = console,
} = {}) => {
  const allFeatures = (Array.isArray(features) ? features : []).map(item => clone(item, {}));
  const activeRetriever = retriever?.retrieve
    ? retriever
    : createMaidCapabilityRetriever({ version: retrieverVersion });
  const activeRetrieverVersion = trim(activeRetriever.version, retrieverVersion);
  const snapshotCache = new Map();
  const requestStates = new Map();
  let config = readMaidCapabilityRoutingConfig({ storage });

  const rememberSnapshot = (snapshot) => {
    snapshotCache.set(snapshot.id, snapshot);
    while (snapshotCache.size > MAX_SNAPSHOT_CACHE) {
      snapshotCache.delete(snapshotCache.keys().next().value);
    }
    return snapshot;
  };

  const getConfig = () => ({ ...config });
  const setConfig = (patch = {}) => {
    config = writeMaidCapabilityRoutingConfig({ ...config, ...(isPlainObject(patch) ? patch : {}) }, { storage });
    return getConfig();
  };

  const beginRequest = ({ input = '' } = {}) => {
    const id = createId('cap-request');
    requestStates.set(id, {
      id,
      input: trim(input),
      usedFeatureIds: [],
      snapshotIds: [],
      validSelectionCount: 0,
      hitCount: 0,
      policyExcludedCount: 0,
      candidateModeDecisionCount: 0,
      fullFallbackDecisionCount: 0,
      lastSnapshot: null,
      selectionCohort: null,
    });
    return { id };
  };

  const prepareDecision = ({
    requestId = '',
    input = '',
    context = {},
    steps = [],
    phase = 'planner',
    configOverride = null,
  } = {}) => {
    const startedAt = now();
    const state = requestStates.get(trim(requestId)) || {
      id: trim(requestId) || createId('cap-request'),
      input: trim(input),
      usedFeatureIds: [],
      snapshotIds: [],
      validSelectionCount: 0,
      hitCount: 0,
      policyExcludedCount: 0,
      candidateModeDecisionCount: 0,
      fullFallbackDecisionCount: 0,
      lastSnapshot: null,
      selectionCohort: null,
    };
    if (!requestStates.has(state.id)) requestStates.set(state.id, state);
    const currentConfig = isPlainObject(configOverride)
      ? normalizeMaidCapabilityRoutingConfig({ ...getConfig(), ...configOverride })
      : getConfig();
    const platform = inferPlatform(context);
    const records = new Map();
    const excluded = [];
    const projectedById = new Map();
    const primaryIntent = input || state.input;
    // 对上一份待确认清单的修改回复：原清单的功能不需要这句话再写一次“删除”
    const revisionFeatureId = trim(context?.pendingActionRevision?.featureId);

    for (const rawFeature of allFeatures) {
      const allowedPlatforms = list(rawFeature?.allowedPlatforms || rawFeature?.platforms).map(item => item.toLowerCase());
      if (rawFeature?.enabled === false) {
        excluded.push({ id: trim(rawFeature.id), tools: list(rawFeature.tools), reason: 'disabled' });
        continue;
      }
      if (allowedPlatforms.length && platform !== 'unknown' && !allowedPlatforms.includes(platform)) {
        excluded.push({ id: trim(rawFeature.id), tools: list(rawFeature.tools), reason: 'platform_mismatch' });
        continue;
      }
      const projection = buildToolProjection({
        feature: rawFeature,
        toolRegistry,
        permissionEvaluator,
        context,
      });
      if (!projection.feature) {
        excluded.push({
          id: trim(rawFeature.id),
          tools: list(rawFeature.tools),
          reason: projection.excludedTools[0]?.reason || 'tool_unavailable',
        });
        continue;
      }
      projection.excludedTools.forEach((item) => {
        excluded.push({ id: trim(rawFeature.id), tools: [item.toolName], reason: item.reason });
      });
      if (trim(rawFeature.id) !== revisionFeatureId && !hasExplicitHighRiskIntent(primaryIntent, projection.feature)) {
        excluded.push({
          id: trim(rawFeature.id),
          tools: list(projection.feature.tools),
          reason: 'risk_intent_not_explicit',
        });
        continue;
      }
      projectedById.set(trim(rawFeature.id), projection.feature);
    }

    const addRecord = (feature, score, reason, { pinned = false } = {}) => {
      if (!feature) return;
      const id = trim(feature.id);
      const existing = records.get(id) || { feature, score: 0, reasons: new Set(), pinned: false };
      existing.score = Math.max(existing.score, Number(score) || 0);
      existing.reasons.add(reason);
      existing.pinned = existing.pinned || pinned;
      records.set(id, existing);
    };

    let retrievalContext = context;
    const frozenConversationContext = isPlainObject(context?.maidConversationContextRef?.current)
      ? context.maidConversationContextRef.current
      : null;
    if (isPlainObject(context?.maidConversationContext)) {
      retrievalContext = context;
    } else if (frozenConversationContext) {
      retrievalContext = { ...context, maidConversationContext: frozenConversationContext };
    } else if (typeof getConversationContext === 'function') {
      try {
        const maidConversationContext = getConversationContext({
          input: input || state.input,
          context,
          phase,
        });
        if (isPlainObject(maidConversationContext)) {
          if (
            isPlainObject(context?.maidConversationContextRef) &&
            !isPlainObject(context.maidConversationContextRef.current)
          ) {
            context.maidConversationContextRef.current = maidConversationContext;
          }
          retrievalContext = { ...context, maidConversationContext };
        }
      } catch (error) {
        logger?.debug?.('maid capability conversation context skipped', error);
      }
    }
    const retrievalTexts = buildRetrievalTexts(input || state.input, retrievalContext, steps);
    for (const query of retrievalTexts) {
      const matches = activeRetriever.retrieve(query.text, { limit: 20, features: allFeatures });
      for (const match of matches) {
        const projected = projectedById.get(trim(match.id));
        if (!projected) continue;
        const weightedScore = Number(match.score || 0) * query.weight;
        addRecord(projected, weightedScore, query.reason);
        if (trim(match.retrievalReason)) {
          addRecord(projected, weightedScore, trim(match.retrievalReason));
        }
      }
    }

    const normalizedIntent = compactSearchToken(input || state.input);
    for (const projected of projectedById.values()) {
      const tags = compactSearchToken([
        ...list(projected.tags),
        ...list(projected.categories),
        ...list(projected.resources),
      ].join(' '));
      if (normalizedIntent && tags && (tags.includes(normalizedIntent) || normalizedIntent.includes(tags))) {
        addRecord(projected, 50, 'tag');
      }
      const schemaText = buildSchemaIndexText(projected.toolSchemas);
      if (normalizedIntent && schemaText && schemaText.includes(normalizedIntent)) {
        addRecord(projected, 45, 'schema');
      }
      const page = canonicalToken(context?.activePage);
      if (page && (
        canonicalToken(projected.panel) === page ||
        list(projected.uiPath).some(item => canonicalToken(item).includes(page))
      )) {
        addRecord(projected, 20, 'page_context');
      }
    }

    const missingMessageSessions = getMissingExplicitMessageSessions(primaryIntent, steps);
    if (missingMessageSessions.length) {
      addRecord(
        projectedById.get('session.create'),
        121,
        'missing_session_prerequisite',
        { pinned: true },
      );
    }
    getReactDependencyCapabilityIds(primaryIntent, steps).forEach((featureId) => {
      addRecord(
        projectedById.get(featureId),
        119,
        'bounded_react_dependency',
        { pinned: true },
      );
    });

    if (revisionFeatureId) addRecord(projectedById.get(revisionFeatureId), 118, 'pending_action_revision', { pinned: true });
    // 模型读过说明的功能进入下一步候选：提示词只给其余功能的名称索引，“查说明→使用”这条路要走得通
    (Array.isArray(steps) ? steps : []).forEach((step) => {
      if (trim(step?.toolName) !== 'app.read_feature_doc' || trim(step?.status) === 'failed') return;
      addRecord(projectedById.get(trim(step?.args?.featureId)), 118, 'looked_up_feature', { pinned: true });
    });
    const stickyIds = state.usedFeatureIds.slice(-currentConfig.stickyLimit).reverse();
    // Workflow references aid discovery without pinning a whole workflow or bypassing availability checks.
    const loadedSkillStep = (Array.isArray(steps) ? steps : []).filter(step => step?.toolName === 'app.read_skill' && step.status === 'succeeded').slice(-1)[0];
    const loadedSkill = loadedSkillStep && readMaidSkill(loadedSkillStep.args?.skillId);
    const skillFeatureIds = context.maidSkillContext ? getMaidLoadedSkillFeatures(context.maidSkillContext) : loadedSkill?.featureIds || [];
    // 技能引用的功能只补空位：分数低于意图及格线，不挤掉按本句意图检索到的功能，也不单独触发候选模式
    skillFeatureIds.forEach(featureId => addRecord(projectedById.get(featureId), SKILL_REFERENCE_SCORE, 'skill_reference'));
    stickyIds.forEach((featureId, index) => {
      addRecord(projectedById.get(featureId), 120 - index, index === 0 ? 'previous_capability' : 'sticky', { pinned: true });
    });
    state.usedFeatureIds
      .slice(0, -currentConfig.stickyLimit)
      .slice(-8)
      .forEach(featureId => addRecord(projectedById.get(featureId), 10, 'used_history'));
    addRecord(projectedById.get(CONTROL_CAPABILITY_ID), 110, 'control_plane', { pinned: true });
    // react 中段：todo 清单是女仆自发维护的工具，用户原话不含其线索，常驻候选（Shadow 下仅影响指标）。
    if (trim(phase) === 'react') {
      addRecord(projectedById.get(MULTI_STEP_TODO_CAPABILITY_ID), 90, 'multi_step_todo', { pinned: true });
    }

    const ranked = Array.from(records.values())
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score || trim(a.feature.id).localeCompare(trim(b.feature.id)));
    const selected = ranked
      .slice(0, currentConfig.candidateLimit)
      .sort((a, b) => (
        Number(trim(a.feature?.id) === CONTROL_CAPABILITY_ID) -
        Number(trim(b.feature?.id) === CONTROL_CAPABILITY_ID)
      ));
    const intentMatches = selected.filter(item => !item.pinned && item.score >= currentConfig.minScore
      && !(item.reasons.size === 1 && item.reasons.has('skill_reference')));
    const confidence = intentMatches[0]?.score || 0;
    const hasConfidentMatch = intentMatches.length > 0;
    const bucketKey = [state.id, context?.sessionId].filter(Boolean).join('|');
    const rolloutBucket = hashBucket(bucketKey);
    const canarySelected = currentConfig.mode === MAID_CAPABILITY_ROUTING_MODES.canary &&
      rolloutBucket < currentConfig.canaryPercent;
    const requestedCandidateMode = currentConfig.mode === MAID_CAPABILITY_ROUTING_MODES.bounded || canarySelected;
    const useCandidates = requestedCandidateMode && hasConfidentMatch;
    const effectiveMode = useCandidates
      ? 'candidate'
      : (requestedCandidateMode ? 'full_fallback' : 'shadow');
    const candidateFeatures = selected.map(item => item.feature);
    const estimatedFullSchemaTokens = estimateToolSchemaTokens(Array.from(projectedById.values()));
    const estimatedCandidateSchemaTokens = estimateToolSchemaTokens(candidateFeatures);
    const candidateRefs = selected.map((item, index) => ({
      ...item.feature.capabilityRef,
      rank: index + 1,
      score: Math.round(item.score * 100) / 100,
      reasonCodes: Array.from(item.reasons),
    }));
    const snapshot = rememberSnapshot({
      id: createId('cap-snapshot'),
      requestId: state.id,
      phase: trim(phase, 'planner'),
      mode: currentConfig.mode,
      effectiveMode,
      useCandidates,
      retrieverVersion: activeRetrieverVersion,
      createdAt: startedAt,
      latencyMs: Math.max(0, now() - startedAt),
      confidence,
      rolloutBucket,
      candidateCount: candidateFeatures.length,
      estimatedFullSchemaTokens,
      estimatedCandidateSchemaTokens,
      candidateFeatures,
      candidateRefs,
      candidateIds: new Set(candidateFeatures.map(feature => trim(feature.id))),
      excluded,
      promptFeatures: useCandidates ? candidateFeatures : allFeatures,
      cohort: {
        uiMode: trim(context?.uiMode),
        activePage: trim(context?.activePage),
        language: detectLanguage(input || state.input),
        taskDomain: trim(candidateFeatures[0]?.id).split('.')[0] || '',
        maidContextVersion: trim(retrievalContext?.maidConversationContext?.maidContextVersion),
      },
    });
    state.snapshotIds.push(snapshot.id);
    if (effectiveMode === 'candidate') state.candidateModeDecisionCount += 1;
    if (effectiveMode === 'full_fallback') state.fullFallbackDecisionCount += 1;
    state.lastSnapshot = snapshot;
    return snapshot;
  };

  const observeDecision = (snapshot = null, decision = null, {
    countForRecall = true,
    metricEligible = true,
  } = {}) => {
    if (!snapshot) return decision;
    const selectedCapabilityId = trim(decision?.selectedCapabilityId || decision?.featureId);
    const selectedToolName = trim(decision?.selectedToolName || decision?.toolName);
    const hasToolSelection = Boolean(decision?.ok && selectedToolName);
    let selectedCandidateIndex = snapshot.candidateFeatures.findIndex(feature => (
      canonicalToken(feature?.id) === canonicalToken(selectedCapabilityId) &&
      list(feature?.tools).some(tool => canonicalToken(tool) === canonicalToken(selectedToolName))
    ));
    if (selectedCandidateIndex < 0) {
      selectedCandidateIndex = snapshot.candidateFeatures.findIndex(feature => (
        list(feature?.tools).some(tool => canonicalToken(tool) === canonicalToken(selectedToolName))
      ));
    }
    const candidateHit = hasToolSelection && selectedCandidateIndex >= 0;
    const selectedRank = candidateHit ? selectedCandidateIndex + 1 : 0;
    const selectedToolOwners = findToolOwners(selectedToolName, allFeatures);
    const selectedFeature = (candidateHit ? snapshot.candidateFeatures[selectedCandidateIndex] : null) ||
      findExactFeature(selectedCapabilityId, allFeatures) ||
      (selectedToolOwners.length === 1 ? selectedToolOwners[0] : null);
    const selectedToolDefinition = selectedToolName ? toolRegistry?.get?.(selectedToolName) || null : null;
    const selectedRiskLevel = selectedToolName
      ? highestRiskLevel([selectedFeature?.riskLevel, selectedToolDefinition?.riskLevel])
      : '';
    const candidateViolation = decision?.candidateViolation === true || Boolean(
      snapshot.useCandidates && selectedToolName && decision?.ok === false,
    );
    const policyExcluded = hasToolSelection && snapshot.excluded.some((item) => {
      const sameCapability = canonicalToken(item.id) === canonicalToken(selectedCapabilityId);
      const tools = list(item.tools);
      const sameTool = tools.some(tool => canonicalToken(tool) === canonicalToken(selectedToolName));
      return selectedCapabilityId
        ? sameCapability && (!tools.length || sameTool)
        : sameTool;
    });
    const validSelection = Boolean(countForRecall && hasToolSelection && !policyExcluded);
    const decisionCohort = {
      ...snapshot.cohort,
      taskDomain: trim(selectedFeature?.id).split('.')[0] || trim(snapshot.cohort?.taskDomain),
      riskLevel: selectedRiskLevel,
    };
    const state = requestStates.get(snapshot.requestId);
    if (state && hasToolSelection) {
      if (validSelection) state.selectionCohort = decisionCohort;
      const previousIndex = state.usedFeatureIds.indexOf(selectedCapabilityId);
      if (previousIndex >= 0) state.usedFeatureIds.splice(previousIndex, 1);
      if (selectedCapabilityId) state.usedFeatureIds.push(selectedCapabilityId);
      if (policyExcluded) state.policyExcludedCount += 1;
      else if (countForRecall) {
        state.validSelectionCount += 1;
        if (candidateHit) state.hitCount += 1;
      }
    }
    try {
      retrievalStore?.recordDecision?.({
        id: snapshot.id,
        requestId: snapshot.requestId,
        phase: snapshot.phase,
        mode: snapshot.mode,
        effectiveMode: snapshot.effectiveMode,
        retrieverVersion: snapshot.retrieverVersion,
        createdAt: snapshot.createdAt,
        latencyMs: snapshot.latencyMs,
        candidates: snapshot.candidateRefs,
        candidateCount: snapshot.candidateCount,
        selectedCapabilityId,
        selectedToolName,
        selectedRank,
        reciprocalRank: selectedRank > 0 ? 1 / selectedRank : 0,
        candidateHit,
        candidateViolation,
        metricEligible,
        validSelection,
        policyExcluded,
        estimatedFullSchemaTokens: snapshot.estimatedFullSchemaTokens,
        estimatedCandidateSchemaTokens: snapshot.estimatedCandidateSchemaTokens,
        correction: decision?.capabilityCorrection || null,
        cohort: decisionCohort,
      });
    } catch (error) {
      logger?.debug?.('capability retrieval decision log skipped', error);
    }
    if (!isPlainObject(decision)) return decision;
    return {
      ...decision,
      candidateSnapshotId: snapshot.id,
      retrieverVersion: snapshot.retrieverVersion,
      selectedCapabilityId: selectedCapabilityId || '',
      candidateHit: hasToolSelection ? candidateHit : undefined,
      selectedCandidateRank: selectedRank || undefined,
      capabilityRoutingMode: snapshot.effectiveMode,
    };
  };

  const validatePlan = (plan = {}, { context = {} } = {}) => {
    const snapshotId = trim(plan?.candidateSnapshotId);
    const snapshot = snapshotCache.get(snapshotId) || null;
    if (!snapshot) {
      if (!snapshotId && trim(plan?.capabilityRoutingMode) !== 'candidate') return { ok: true, plan };
      return {
        ok: false,
        reason: 'candidate_snapshot_missing',
        message: '候选快照已失效，请重新检索后再执行。',
        nearestCandidates: [],
      };
    }
    if (!snapshot.useCandidates) return { ok: true, plan };
    const resolved = resolveCandidateCapabilitySelection({
      featureId: plan?.featureId,
      toolName: plan?.toolName,
      features: snapshot.candidateFeatures,
      allowFuzzy: true,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason,
        message: `能力不属于当前候选快照（snapshot=${snapshot.id}）。`,
        nearestCandidates: resolved.nearestCandidates,
      };
    }
    const currentRawFeature = getFeatureById(allFeatures, resolved.feature.id);
    const currentProjection = buildToolProjection({
      feature: currentRawFeature,
      toolRegistry,
      permissionEvaluator,
      context,
    }).feature;
    if (!currentProjection || currentProjection.schemaHash !== resolved.feature.schemaHash) {
      return {
        ok: false,
        reason: currentProjection ? 'candidate_schema_stale' : 'candidate_policy_changed',
        message: '候选能力在规划后发生版本、schema 或权限变化，请重新检索。',
        nearestCandidates: [],
      };
    }
    return {
      ok: true,
      plan: {
        ...plan,
        featureId: trim(resolved.feature.id),
        toolName: resolved.toolName,
        ...(resolved.correction ? { capabilityCorrection: resolved.correction } : {}),
      },
    };
  };

  const authorizeChildPlan = ({
    requestId = '',
    parentPlan = {},
    childPlan = {},
    context = {},
    phase = 'verification',
    snapshotPrefix = 'cap-verify',
    reasonCode = 'verification_dependency',
  } = {}) => {
    const parentSnapshot = snapshotCache.get(trim(parentPlan?.candidateSnapshotId)) || null;
    const owners = findToolOwners(childPlan?.toolName, allFeatures);
    const rawFeature = findExactFeature(childPlan?.featureId, owners) || (owners.length === 1 ? owners[0] : null);
    const projection = rawFeature ? buildToolProjection({
      feature: rawFeature,
      toolRegistry,
      permissionEvaluator,
      context,
    }).feature : null;
    if (!projection) {
      if (!parentSnapshot?.useCandidates) return childPlan;
      return {
        ...childPlan,
        candidateSnapshotId: parentSnapshot.id,
        retrieverVersion: activeRetrieverVersion,
        capabilityRoutingMode: parentSnapshot.effectiveMode,
      };
    }
    const snapshot = rememberSnapshot({
      id: createId(snapshotPrefix),
      requestId: trim(requestId || parentSnapshot?.requestId),
      phase,
      mode: parentSnapshot?.mode || getConfig().mode,
      effectiveMode: parentSnapshot?.effectiveMode || 'shadow',
      useCandidates: parentSnapshot?.useCandidates === true,
      retrieverVersion: activeRetrieverVersion,
      createdAt: now(),
      latencyMs: 0,
      confidence: 100,
      candidateFeatures: [projection],
      candidateRefs: [{ ...projection.capabilityRef, rank: 1, score: 100, reasonCodes: [reasonCode] }],
      candidateIds: new Set([trim(projection.id)]),
      excluded: [],
      promptFeatures: [projection],
      cohort: clone(parentSnapshot?.cohort, {}),
    });
    const plan = {
      ...childPlan,
      featureId: trim(projection.id),
      candidateSnapshotId: snapshot.id,
      retrieverVersion: activeRetrieverVersion,
      capabilityRoutingMode: snapshot.effectiveMode,
    };
    return observeDecision(snapshot, plan, { countForRecall: false, metricEligible: false });
  };

  const authorizeVerification = ({
    requestId = '',
    parentPlan = {},
    verificationPlan = {},
    context = {},
  } = {}) => authorizeChildPlan({
    requestId,
    parentPlan,
    childPlan: verificationPlan,
    context,
  });

  const authorizeWorkflowPlan = ({
    requestId = '',
    parentPlan = {},
    workflowPlan = {},
    context = {},
  } = {}) => authorizeChildPlan({
    requestId,
    parentPlan,
    childPlan: workflowPlan,
    context,
    phase: 'deterministic_workflow',
    snapshotPrefix: 'cap-workflow',
    reasonCode: 'deterministic_workflow_dependency',
  });

  const finishRequest = (requestId = '', result = {}) => {
    const state = requestStates.get(trim(requestId));
    if (!state) return null;
    const lastSnapshot = state.lastSnapshot;
    const allValidSelectionsCovered = state.validSelectionCount > 0 && state.hitCount === state.validSelectionCount;
    const summary = {
      requestId: state.id,
      retrieverVersion: activeRetrieverVersion,
      mode: lastSnapshot?.mode || getConfig().mode,
      effectiveMode: state.candidateModeDecisionCount > 0
        ? 'candidate'
        : (state.fullFallbackDecisionCount > 0 ? 'full_fallback' : 'shadow'),
      decisionCount: state.snapshotIds.length,
      validSelectionCount: state.validSelectionCount,
      hitCount: state.hitCount,
      policyExcludedCount: state.policyExcludedCount,
      allValidSelectionsCovered,
      lastCandidateSnapshotId: lastSnapshot?.id || '',
      taskOk: result?.ok === true,
    };
    if (state.validSelectionCount > 0) {
      try {
        retrievalStore?.recordRequestSummary?.({
          retrieverVersion: activeRetrieverVersion,
          mode: summary.mode,
          effectiveMode: summary.effectiveMode,
          cohort: state.selectionCohort || lastSnapshot?.cohort || {},
          allValidSelectionsCovered,
        });
      } catch (error) {
        logger?.debug?.('capability retrieval request summary skipped', error);
      }
    }
    requestStates.delete(state.id);
    return summary;
  };

  return {
    authorizeVerification,
    authorizeWorkflowPlan,
    beginRequest,
    finishRequest,
    getConfig,
    getSnapshot: snapshotId => snapshotCache.get(trim(snapshotId)) || null,
    observeDecision,
    prepareDecision,
    setConfig,
    validatePlan,
  };
};
