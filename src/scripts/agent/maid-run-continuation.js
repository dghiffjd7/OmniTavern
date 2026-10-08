import { normalizeMaidVisualSpecLedger } from './maid-visual-spec.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isPlainObject(value)) return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableValue(value[key]);
    return result;
  }, {});
};

const stableStringify = (value) => {
  try {
    return JSON.stringify(stableValue(value));
  } catch {
    return String(value ?? '');
  }
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const OMITTED_KEY_PATTERN = /(?:api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret|password|credential|cookie|endpoint|base[-_]?url|service[-_]?account|workflow|originalcard|dataurl|imageurl|llmurl|rawreply|attachmentreference)/iu;
const LARGE_TEXT_KEYS = new Set([
  'avatar',
  'wallpaper',
  'image',
  'images',
  'content',
  'description',
  'prompt',
  'negativeprompt',
  'body',
  'data',
  'text',
]);

const sanitizeContinuationValue = (value, {
  key = '',
  depth = 0,
  maxDepth = 5,
  maxArrayItems = 12,
  maxKeys = 16,
  maxString = 180,
} = {}) => {
  const normalizedKey = trim(key).toLowerCase();
  if (normalizedKey && (OMITTED_KEY_PATTERN.test(normalizedKey) || LARGE_TEXT_KEYS.has(normalizedKey))) {
    return undefined;
  }
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    if (/^data:/iu.test(value) || value.length > 0 && value.includes(';base64,')) return undefined;
    const text = trim(value);
    if (!text) return '';
    return text.length > maxString ? `${text.slice(0, maxString)}…` : text;
  }
  if (depth >= maxDepth) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, maxArrayItems)
      .map(item => sanitizeContinuationValue(item, {
        depth: depth + 1,
        maxDepth,
        maxArrayItems,
        maxKeys,
        maxString,
      }))
      .filter(item => item !== undefined);
  }
  if (!isPlainObject(value)) return undefined;
  const result = {};
  Object.entries(value).slice(0, maxKeys).forEach(([childKey, childValue]) => {
    const sanitized = sanitizeContinuationValue(childValue, {
      key: childKey,
      depth: depth + 1,
      maxDepth,
      maxArrayItems,
      maxKeys,
      maxString,
    });
    if (sanitized !== undefined) result[childKey] = sanitized;
  });
  return result;
};

export const MAID_RUN_CONTINUATION_VERSION = 'maid-run-continuation-v1';

export const fingerprintMaidToolCall = (toolName = '', args = {}) => {
  const normalizedToolName = trim(toolName);
  const normalizedArgs = isPlainObject(args) ? clone(args) : {};
  if (['session.create', 'group.create'].includes(normalizedToolName)) delete normalizedArgs.open;
  if (['persona.create', 'user.create'].includes(normalizedToolName)) delete normalizedArgs.setActive;
  const source = `${normalizedToolName}\n${stableStringify(normalizedArgs)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}:${source.length}`;
};

const inferResourceKind = (toolName = '', key = '') => {
  const normalizedKey = trim(key).toLowerCase();
  if (normalizedKey.includes('persona')) return 'persona';
  if (normalizedKey.includes('worldbook')) return 'worldbook';
  if (normalizedKey.includes('session')) return 'session';
  if (normalizedKey.includes('group')) return 'group';
  if (normalizedKey.includes('user')) return 'user';
  if (normalizedKey.includes('contact')) return 'contact';
  if (normalizedKey.includes('attachment')) return 'attachment';
  if (normalizedKey.includes('entry')) return 'worldbook_entry';
  return trim(toolName).split('.')[0] || 'resource';
};

const collectResourceRefs = (value, toolName = '', refs = new Map(), depth = 0) => {
  if (depth > 5 || refs.size >= 20) return refs;
  if (Array.isArray(value)) {
    value.slice(0, 24).forEach(item => collectResourceRefs(item, toolName, refs, depth + 1));
    return refs;
  }
  if (!isPlainObject(value)) return refs;
  const localName = trim(value.name || value.title || value.sessionName || value.worldbookName);
  Object.entries(value).forEach(([key, child]) => {
    if (refs.size >= 20) return;
    const normalizedKey = key.toLowerCase();
    if (/(?:^id$|id$)/u.test(normalizedKey) && typeof child === 'string') {
      const id = trim(child);
      if (id && !/^data:/iu.test(id)) {
        const kind = inferResourceKind(toolName, key);
        refs.set(`${kind}:${id}`, {
          kind,
          id: id.slice(0, 180),
          ...(localName ? { name: localName.slice(0, 120) } : {}),
        });
      }
    } else if (/(?:ids)$/u.test(normalizedKey) && Array.isArray(child)) {
      child.slice(0, 20).forEach((item) => {
        const id = trim(item);
        if (!id) return;
        const kind = inferResourceKind(toolName, key.replace(/s$/u, ''));
        refs.set(`${kind}:${id}`, { kind, id: id.slice(0, 180) });
      });
    }
    collectResourceRefs(child, toolName, refs, depth + 1);
  });
  return refs;
};

const unwrapStoredToolOutput = (value = {}) => (
  isPlainObject(value) && Object.hasOwn(value, 'result')
    ? value.result
    : value
);

const sanitizeStepSummary = (value = '') => {
  const text = trim(value);
  if (!text || /^[{[]/u.test(text) || /data:/iu.test(text)) return '';
  return text.slice(0, 160);
};

const normalizeRunStep = (step = {}, fallbackIndex = 0) => {
  const input = isPlainObject(step?.input) ? step.input : {};
  const toolName = trim(step?.toolName || input.toolName);
  const args = isPlainObject(step?.args)
    ? step.args
    : (isPlainObject(input.args) ? input.args : {});
  const rawResult = unwrapStoredToolOutput(step?.output);
  const refs = collectResourceRefs(args, toolName);
  collectResourceRefs(rawResult, toolName, refs);
  return {
    index: Number(step?.index || fallbackIndex + 1) || fallbackIndex + 1,
    toolName,
    status: trim(step?.status),
    summary: sanitizeStepSummary(step?.summary),
    argsDigest: fingerprintMaidToolCall(toolName, args),
    args: sanitizeContinuationValue(args, { maxDepth: 4, maxArrayItems: 10, maxString: 140 }) || {},
    result: sanitizeContinuationValue(rawResult, { maxDepth: 4, maxArrayItems: 10, maxString: 160 }) || {},
    resourceRefs: Array.from(refs.values()),
    metadata: sanitizeContinuationValue(step?.metadata, { maxDepth: 3, maxArrayItems: 8, maxString: 120 }) || {},
  };
};

const isReadLikeTool = (toolName = '') => (
  /(?:^|\.)(?:read|list|get|inspect|exists|search)(?:_|\.|$)/iu.test(trim(toolName))
);

const isWriteLikeTool = (toolName = '') => (
  /(?:^|\.)(?:create|update|delete|set|bind|write|send|generate|archive)(?:_|\.|$)/iu.test(trim(toolName))
);

const resolveStepVerification = (step = {}, steps = [], index = 0) => {
  if (isReadLikeTool(step.toolName)) return 'observation';
  const verifiedLater = steps.slice(index + 1).some(candidate => (
    candidate.status === 'succeeded' &&
    trim(candidate?.metadata?.verificationFor) === step.toolName
  ));
  if (verifiedLater) return 'readback';
  if (
    step?.result?.verified === true ||
    step?.result?.reusedVerifiedAction === true ||
    step?.result?.applied === true && step?.result?.fileExists !== false
  ) return 'tool_result';
  return isWriteLikeTool(step.toolName) ? 'unverified' : 'tool_result';
};

const normalizePreviousSuccessfulStep = (step = {}) => ({
  index: Number(step?.index || 0) || 0,
  toolName: trim(step?.toolName),
  status: 'succeeded',
  summary: sanitizeStepSummary(step?.summary),
  argsDigest: trim(step?.argsDigest),
  args: sanitizeContinuationValue(step?.args, { maxDepth: 4, maxArrayItems: 10, maxString: 140 }) || {},
  result: sanitizeContinuationValue(step?.result, { maxDepth: 4, maxArrayItems: 10, maxString: 160 }) || {},
  resourceRefs: (Array.isArray(step?.resourceRefs) ? step.resourceRefs : [])
    .map(ref => sanitizeContinuationValue(ref, { maxDepth: 2, maxString: 180 }))
    .filter(Boolean)
    .slice(0, 20),
  verification: trim(step?.verification, 'unverified'),
});

const mergeSuccessfulSteps = (previous = [], current = []) => {
  const merged = new Map();
  [...previous, ...current].forEach((step) => {
    const normalized = normalizePreviousSuccessfulStep(step);
    if (!normalized.toolName || !normalized.argsDigest) return;
    const refs = normalized.resourceRefs.map(ref => `${ref.kind}:${ref.id}`).sort().join('|');
    merged.set(`${normalized.toolName}:${normalized.argsDigest}:${refs}`, normalized);
  });
  return Array.from(merged.values()).slice(-24);
};

const normalizeTodo = (todo = {}) => ({
  id: trim(todo?.id).slice(0, 120),
  content: trim(todo?.content || todo?.title || todo?.text).slice(0, 240),
  status: trim(todo?.status, 'pending').slice(0, 40),
});

const isRemainingTodo = todo => !['completed', 'cancelled', 'resolved', 'done'].includes(trim(todo?.status).toLowerCase());

export const normalizeMaidRunContinuationSnapshot = (snapshot = {}) => {
  if (!isPlainObject(snapshot)) return null;
  const sourceRunId = trim(snapshot.sourceRunId).slice(0, 180);
  if (!sourceRunId) return null;
  return {
    version: MAID_RUN_CONTINUATION_VERSION,
    sourceRunId,
    rootRunId: trim(snapshot.rootRunId || sourceRunId).slice(0, 180),
    resumedFromRunId: trim(snapshot.resumedFromRunId).slice(0, 180),
    priorRunIds: (Array.isArray(snapshot.priorRunIds) ? snapshot.priorRunIds : [])
      .map(id => trim(id).slice(0, 180))
      .filter(Boolean)
      .slice(-8),
    goal: trim(snapshot.goal).slice(0, 1200),
    reason: trim(snapshot.reason).slice(0, 240),
    successfulSteps: (Array.isArray(snapshot.successfulSteps) ? snapshot.successfulSteps : [])
      .map(normalizePreviousSuccessfulStep)
      .filter(step => step.toolName && step.argsDigest)
      .slice(-24),
    failedSteps: (Array.isArray(snapshot.failedSteps) ? snapshot.failedSteps : [])
      .map(step => sanitizeContinuationValue(step, { maxDepth: 3, maxArrayItems: 6, maxString: 140 }))
      .filter(Boolean)
      .slice(-6),
    remainingTodos: (Array.isArray(snapshot.remainingTodos) ? snapshot.remainingTodos : [])
      .map(normalizeTodo)
      .filter(todo => todo.content && isRemainingTodo(todo))
      .slice(0, 24),
    pendingPlan: sanitizeContinuationValue(snapshot.pendingPlan, {
      maxDepth: 4,
      maxArrayItems: 10,
      maxString: 160,
    }) || null,
    visualSpecLedger: normalizeMaidVisualSpecLedger(snapshot.visualSpecLedger),
  };
};

export const buildMaidRunContinuationSnapshot = ({
  run = {},
  result = {},
  previousSnapshot = null,
  visualSpecLedger = null,
} = {}) => {
  const previous = normalizeMaidRunContinuationSnapshot(previousSnapshot) || null;
  const sourceRunId = trim(run?.id || result?.runId);
  if (!sourceRunId) return null;
  const rawSteps = Array.isArray(result?.steps) && result.steps.length
    ? result.steps
    : (Array.isArray(run?.steps) ? run.steps : []);
  const normalizedSteps = rawSteps.map(normalizeRunStep);
  const currentSuccessful = normalizedSteps
    .filter(step => step.status === 'succeeded')
    .map((step, index, list) => ({
      ...step,
      verification: resolveStepVerification(step, normalizedSteps, normalizedSteps.indexOf(step)),
    }));
  const failedSteps = normalizedSteps
    .filter(step => step.status === 'failed')
    .slice(-6)
    .map(step => ({
      toolName: step.toolName,
      argsDigest: step.argsDigest,
      summary: step.summary,
      errorMessage: sanitizeStepSummary(
        rawSteps.find(raw => trim(raw?.toolName || raw?.input?.toolName) === step.toolName)?.errorMessage,
      ),
    }));
  const metadata = isPlainObject(run?.metadata) ? run.metadata : {};
  const hasCurrentTodos = Array.isArray(metadata.todos);
  const todoSource = hasCurrentTodos ? metadata.todos : (previous?.remainingTodos || []);
  const pendingPlan = isPlainObject(result?.pendingPlan)
    ? result.pendingPlan
    : (isPlainObject(previous?.pendingPlan) ? previous.pendingPlan : null);
  const priorRunIds = Array.from(new Set([
    ...(previous?.priorRunIds || []),
    previous?.sourceRunId,
    trim(metadata.resumedFromRunId),
  ].filter(Boolean))).slice(-8);
  return normalizeMaidRunContinuationSnapshot({
    version: MAID_RUN_CONTINUATION_VERSION,
    sourceRunId,
    rootRunId: previous?.rootRunId || sourceRunId,
    resumedFromRunId: previous?.sourceRunId || trim(metadata.resumedFromRunId),
    priorRunIds,
    goal: trim(previous?.goal || metadata.goal || result?.input || run?.title || run?.summary),
    reason: trim(result?.reason || metadata.reason || run?.errorMessage),
    successfulSteps: mergeSuccessfulSteps(previous?.successfulSteps || [], currentSuccessful),
    failedSteps: [...(previous?.failedSteps || []), ...failedSteps].slice(-6),
    remainingTodos: todoSource.map(normalizeTodo).filter(isRemainingTodo),
    pendingPlan,
    visualSpecLedger: visualSpecLedger || previous?.visualSpecLedger,
  });
};

export const resolveMaidRunContinuationFromRun = (run = {}) => {
  if (!isPlainObject(run) || trim(run.kind) !== 'maid_assistant') return null;
  const stored = normalizeMaidRunContinuationSnapshot(run?.metadata?.continuationSnapshot);
  if (stored && stored.sourceRunId === trim(run.id)) return stored;
  return buildMaidRunContinuationSnapshot({
    run,
    visualSpecLedger: run?.metadata?.visualSpecLedger,
  });
};

export const extractMaidResumeRunId = (input = '') => {
  const match = String(input ?? '').match(
    /^继续这条已中断的女仆任务。[ \t]*\r?\nrunId:\s*([A-Za-z0-9._:-]{1,180})(?:\r?\n|$)/u,
  );
  return trim(match?.[1]);
};

export const buildMaidRunContinuationPromptBlock = (snapshot = {}) => {
  const normalized = normalizeMaidRunContinuationSnapshot(snapshot);
  if (!normalized) return '';
  return [
    `<maid_run_continuation version="${MAID_RUN_CONTINUATION_VERSION}">`,
    JSON.stringify(normalized),
    '</maid_run_continuation>',
  ].join('\n');
};

export const findMaidRunContinuationSuccess = (snapshot = {}, toolName = '', args = {}) => {
  const normalized = normalizeMaidRunContinuationSnapshot(snapshot);
  if (!normalized) return null;
  const digest = fingerprintMaidToolCall(toolName, args);
  const match = normalized.successfulSteps.findLast(step => (
    step.toolName === trim(toolName) && step.argsDigest === digest
  ));
  return match ? clone(match) : null;
};

const valueContainsExactString = (value, expected = '', depth = 0) => {
  if (depth > 6) return false;
  if (typeof value === 'string') return trim(value) === expected;
  if (Array.isArray(value)) return value.some(item => valueContainsExactString(item, expected, depth + 1));
  if (!isPlainObject(value)) return false;
  return Object.values(value).some(item => valueContainsExactString(item, expected, depth + 1));
};

export const maidContinuationRefsExistInOutput = (resourceRefs = [], output = {}) => {
  const refs = (Array.isArray(resourceRefs) ? resourceRefs : [])
    .map(ref => trim(ref?.id))
    .filter(Boolean);
  if (!refs.length) return false;
  const result = unwrapStoredToolOutput(output);
  return refs.every(id => valueContainsExactString(result, id));
};
