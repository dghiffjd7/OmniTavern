import {
  buildMemoryUpdateHistoryText as buildMemoryUpdateHistoryTextCore,
  resolveMemoryUpdateRequestPrompt,
} from './request-prompt-utils.js';
import { buildMemoryConfirmText } from './memory-edit-utils.js';
import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';
import {
  emitLifecycleTraceEvent,
  normalizeLifecycleTraceDetails,
  normalizeLifecycleTraceText,
} from './lifecycle-trace-utils.js';

export const buildMemoryUpdateTraceEvent = ({
  phase = '',
  sessionId = '',
  status = 'info',
  summary = '',
  details,
} = {}) => {
  const event = {
    category: 'memory',
    source: 'memory-update-runtime-utils',
    phase: normalizeLifecycleTraceText(phase, 'event'),
    sessionId: normalizeLifecycleTraceText(sessionId, ''),
    status: normalizeLifecycleTraceText(status, 'info'),
    summary: normalizeLifecycleTraceText(summary, ''),
  };
  if (details !== undefined) event.details = normalizeLifecycleTraceDetails(details);
  return event;
};

export const buildMemoryUpdateTaskStartTraceEvent = ({
  sessionId = '',
  isGroup = false,
  checkpointMessageId = '',
} = {}) => ({
  phase: 'update.start',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: 'started',
  summary: 'memory update task started',
  details: {
    isGroup: Boolean(isGroup),
    checkpointMessageId: normalizeLifecycleTraceText(checkpointMessageId, '') || undefined,
  },
});

export const buildMemoryUpdateTaskSkippedTraceEvent = ({
  sessionId = '',
  reason = '',
  nextCounter,
  everyN,
} = {}) => ({
  phase: 'update.skip',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: 'skipped',
  summary: 'memory update skipped',
  details: {
    reason: normalizeLifecycleTraceText(reason, ''),
    nextCounter,
    everyN,
  },
});

export const buildMemoryUpdateTaskFinishTraceEvent = ({
  sessionId = '',
  status = 'success',
  reason = '',
  checkpointMessageId = '',
  errorMessage = '',
} = {}) => {
  const normalizedStatus = normalizeLifecycleTraceText(status, 'success');
  return {
    phase: 'update.finish',
    sessionId: normalizeLifecycleTraceText(sessionId, ''),
    status: normalizedStatus,
    summary:
      normalizedStatus === 'success'
        ? 'memory update task completed'
        : (normalizedStatus === 'skipped'
            ? 'memory update task skipped'
            : (normalizedStatus === 'cancelled'
                ? 'memory update task cancelled'
                : 'memory update task failed')),
    details: {
      reason: normalizeLifecycleTraceText(reason, '') || undefined,
      checkpointMessageId: normalizeLifecycleTraceText(checkpointMessageId, '') || undefined,
      errorMessage: normalizeLifecycleTraceText(errorMessage, '') || undefined,
    },
  };
};

export const buildMemoryRollbackStartTraceEvent = ({
  sessionId = '',
  mode = 'snapshot',
  actionCount = 0,
  tableCount = 0,
} = {}) => ({
  phase: 'rollback.start',
  sessionId: normalizeLifecycleTraceText(sessionId, ''),
  status: 'started',
  summary: 'memory rollback started',
  details: {
    mode: normalizeLifecycleTraceText(mode, 'snapshot'),
    actionCount: Number(actionCount || 0) || 0,
    tableCount: Number(tableCount || 0) || 0,
  },
});

export const buildMemoryRollbackFinishTraceEvent = ({
  sessionId = '',
  status = 'success',
  mode = 'snapshot',
  changed = 0,
  reason = '',
  errorMessage = '',
} = {}) => {
  const normalizedStatus = normalizeLifecycleTraceText(status, 'success');
  return {
    phase: 'rollback.finish',
    sessionId: normalizeLifecycleTraceText(sessionId, ''),
    status: normalizedStatus,
    summary:
      normalizedStatus === 'success'
        ? 'memory rollback completed'
        : (normalizedStatus === 'skipped'
            ? 'memory rollback skipped'
            : 'memory rollback failed'),
    details: {
      mode: normalizeLifecycleTraceText(mode, 'snapshot'),
      changed: Number(changed || 0) || 0,
      reason: normalizeLifecycleTraceText(reason, '') || undefined,
      errorMessage: normalizeLifecycleTraceText(errorMessage, '') || undefined,
    },
  };
};

const emitMemoryUpdateTrace = (recordTraceEvent, event) => {
  emitLifecycleTraceEvent(recordTraceEvent, buildMemoryUpdateTraceEvent(event));
};

const getDefaultBridge = () => {
  if (typeof window !== 'undefined') return window.appBridge || null;
  return globalThis?.window?.appBridge || null;
};

const resolveMemoryUpdateBridge = (bridge = null) => bridge || getDefaultBridge();

export const getLastMemoryUpdate = (bridge = null, sessionId = '') => {
  const runtime = resolveMemoryUpdateBridge(bridge);
  if (typeof runtime?.getLastMemoryUpdate === 'function') return runtime.getLastMemoryUpdate(sessionId) || null;
  const id = String(sessionId || '').trim();
  return id ? runtime?.['lastMemoryUpdateBySession']?.[id] || null : null;
};

export const setLastMemoryUpdate = (bridge = null, sessionId = '', payload = null) => {
  const runtime = resolveMemoryUpdateBridge(bridge);
  if (typeof runtime?.setLastMemoryUpdate === 'function') {
    runtime.setLastMemoryUpdate(sessionId, payload);
    return true;
  }
  return false;
};

export const getLastMemoryPlan = (bridge = null) => {
  const runtime = resolveMemoryUpdateBridge(bridge);
  if (typeof runtime?.getLastMemoryPlan === 'function') return runtime.getLastMemoryPlan() || null;
  return runtime?.['lastMemoryPlan'] || null;
};

export const setLastMemoryPlan = (bridge = null, plan = null) => {
  const runtime = resolveMemoryUpdateBridge(bridge);
  if (typeof runtime?.setLastMemoryPlan === 'function') {
    runtime.setLastMemoryPlan(plan);
    return true;
  }
  if (runtime && typeof runtime === 'object') {
    runtime['lastMemoryPlan'] = plan || null;
    return true;
  }
  return false;
};

export const buildMemoryPromptPlan = async (bridge = null, context = null) => {
  const runtime = resolveMemoryUpdateBridge(bridge);
  if (typeof runtime?.buildMemoryPromptPlan === 'function') return await runtime.buildMemoryPromptPlan(context);
  return null;
};

export const resolveMemoryUpdateHistoryLimit = (settings) => {
  const rawLimit = Math.trunc(Number(settings?.memoryUpdateContextRounds));
  return Number.isFinite(rawLimit) ? Math.max(0, rawLimit) : 6;
};

export const buildMemoryUpdateHistoryTextFromSettings = ({
  messages = [],
  settings = null,
  stripAssistantText,
} = {}) =>
  buildMemoryUpdateHistoryTextCore(messages, {
    limit: resolveMemoryUpdateHistoryLimit(settings),
    stripAssistantText,
  });

export const buildMemoryUpdateHistoryTextForSession = ({
  sessionId = '',
  chatStore = null,
  settings = null,
  stripAssistantText,
} = {}) => buildMemoryUpdateHistoryTextFromSettings({
  messages: chatStore?.getMessages?.(sessionId) || [],
  settings,
  stripAssistantText,
});

export const buildMemoryUpdatePlanInput = (baseContext, { sessionId, isGroup } = {}) => {
  const ctx = baseContext || {};
  return {
    ...(ctx || {}),
    session: { id: sessionId, isGroup },
    meta: {
      ...(ctx?.meta || {}),
      memoryStorageMode: 'table',
      memoryAutoExtract: true,
    },
    history: [],
  };
};

export const buildMemoryUpdatePlanForSession = async ({
  sessionId = '',
  isGroup = false,
  baseContext = null,
  buildPlan = null,
} = {}) => {
  if (typeof buildPlan !== 'function') return null;
  const next = buildMemoryUpdatePlanInput(baseContext, { sessionId, isGroup });
  return buildPlan(next);
};

export const resolveMemoryUpdatePlanForSession = ({
  rawPlan = null,
  sessionId = '',
} = {}) => {
  const planTargetId = String(rawPlan?.targetId || '').trim();
  const currentSessionId = String(sessionId || '').trim();
  return {
    planTargetId,
    currentSessionId,
    isStaleTarget: Boolean(rawPlan && planTargetId && planTargetId !== currentSessionId),
    plan:
      rawPlan && (!planTargetId || planTargetId === currentSessionId)
        ? rawPlan
        : null,
  };
};

export const buildMemoryUpdateRequest = ({ promptText, historyText } = {}) => {
  const systemText = String(promptText || '').trim();
  const userText = [
    getLocalizedPromptText('memory.update.request', '请根据以下聊天记录更新记忆表格。'),
    getLocalizedPromptText('memory.update.output', '只输出 <tableEdit>...</tableEdit>，不要输出任何解释。'),
    '',
    '<chat_history>',
    String(historyText || ''),
    '</chat_history>',
  ].join('\n');
  return {
    systemText,
    userText,
    requestPrompt: ['system:', systemText, '', 'user:', userText].join('\n'),
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userText },
    ],
  };
};

export const buildMemoryUpdateLastEntry = ({
  at = Date.now(),
  raw = '',
  parsed = null,
  force = false,
  requestPrompt = '',
  lastRequestMessages = null,
  lastEntryRequestPrompt = '',
  buildRequestPrompt,
} = {}) => {
  const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
  return {
    at,
    mode: force ? 'separate' : 'inline',
    raw: String(raw ?? ''),
    tableEditRaw: blocks.join('\n\n').trim(),
    actions,
    requestPrompt: resolveMemoryUpdateRequestPrompt({
      requestPrompt,
      lastRequestMessages,
      lastEntryRequestPrompt,
      buildRequestPrompt,
    }),
  };
};

export const resolveMemoryUpdateTrigger = (settings, previousCounter = 0) => {
  const everyN = Math.max(1, Math.trunc(Number(settings?.memoryFillEveryN)) || 1);
  const nextCounter = Math.max(0, Math.trunc(Number(previousCounter)) || 0) + 1;
  if (nextCounter < everyN) {
    return { shouldRun: false, nextCounter, everyN };
  }
  return { shouldRun: true, nextCounter: 0, everyN };
};

export const confirmMemoryEditsWithUi = async ({
  actions = [],
  settings = null,
  loadMemoryTemplateContext = async () => null,
  rawPlan = null,
  appConfirm = async () => true,
  toastr = null,
} = {}) => {
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) return [];

  const confirmBefore = settings?.memoryAutoConfirm === true;
  const stepByStep = settings?.memoryAutoStepByStep === true;
  if (!confirmBefore && !stepByStep) return list;

  let tableById = new Map();
  try {
    const templateContext = await loadMemoryTemplateContext({ filterTables: false });
    tableById = templateContext?.tableById || new Map();
  } catch {}
  const planOrder = Array.isArray(rawPlan?.tableOrder) ? rawPlan.tableOrder : [];

  if (stepByStep) {
    if (confirmBefore) {
      const ok = await appConfirm({
        title: '写表确认',
        message: buildMemoryConfirmText(list, tableById, planOrder),
      });
      if (!ok) {
        toastr?.info?.('已取消写表执行');
        return [];
      }
    }
    const confirmed = [];
    for (let i = 0; i < list.length; i += 1) {
      const action = list[i];
      const title = `写表确认（${i + 1}/${list.length}）`;
      const ok = await appConfirm({
        title,
        message: buildMemoryConfirmText([action], tableById, planOrder, {
          title,
          maxLines: 1,
        }),
      });
      if (!ok) {
        toastr?.info?.('已停止后续写表执行');
        break;
      }
      confirmed.push(action);
    }
    return confirmed;
  }

  const ok = await appConfirm({
    title: '写表确认',
    message: buildMemoryConfirmText(list, tableById, planOrder),
  });
  if (!ok) {
    toastr?.info?.('已取消写表执行');
    return [];
  }
  return list;
};

export const handleMemoryEditsFromRawWithUi = async ({
  signal = null,
  throwOnError = false,
  raw = '',
  sessionId = '',
  isGroup = false,
  contextType = '',
  uiMode = '',
  memoryPlace = '',
  useSharedGlobalScope = false,
  timelineTurnNumber = null,
  timelineMessageId = '',
  resolveTimelineTurnNumber = null,
  force = false,
  requestPrompt = '',
  isMemoryAutoExtractInline = () => false,
  extractTableEditBlocks = value => ({ text: String(value ?? ''), blocks: [], actions: [] }),
  appBridge = null,
  buildRequestPrompt = null,
  confirmMemoryEdits = async (actions) => actions,
  applyMemoryEdits = async () => null,
  logger = null,
  recordTraceEvent = null,
} = {}) => {
  signal?.throwIfAborted();
  const resolvedMemoryPlace = String(
    memoryPlace ||
      (String(uiMode || '').trim().toLowerCase() === 'rp'
        ? 'writing'
        : String(uiMode || '').trim().toLowerCase() === 'moments'
          ? 'moments'
          : ''),
  ).trim();
  if (!force && !isMemoryAutoExtractInline(resolvedMemoryPlace)) {
    emitMemoryUpdateTrace(recordTraceEvent, {
      phase: 'edit.skip',
      sessionId,
      status: 'skipped',
      summary: 'memory inline extraction disabled',
    });
    return { text: raw, blocks: [], actions: [] };
  }
  const parsed = extractTableEditBlocks(raw);
  try {
    const lastEntry = getLastMemoryUpdate(appBridge, sessionId);
    setLastMemoryUpdate(
      appBridge,
      sessionId,
      buildMemoryUpdateLastEntry({
        raw,
        parsed,
        force,
        requestPrompt,
        lastRequestMessages: appBridge?.lastRequest?.messages,
        lastEntryRequestPrompt: lastEntry?.requestPrompt,
        buildRequestPrompt,
      }),
    );
  } catch {}
  if (Array.isArray(parsed?.actions) && parsed.actions.length) {
    emitMemoryUpdateTrace(recordTraceEvent, {
      phase: 'edit.apply',
      sessionId,
      status: 'started',
      summary: 'memory edit apply started',
      details: {
        actionCount: parsed.actions.length,
        force: Boolean(force),
        isGroup: Boolean(isGroup),
      },
    });
    try {
      const confirmedActions = await confirmMemoryEdits(parsed.actions);
      signal?.throwIfAborted();
      if (confirmedActions.length) {
        const payload = {
          actions: confirmedActions,
          sessionId,
          isGroup,
          ...(signal ? { signal } : {}),
        };
        if (contextType) payload.contextType = contextType;
        if (uiMode) payload.uiMode = uiMode;
        if (useSharedGlobalScope) payload.useSharedGlobalScope = true;
        const normalizedTimelineTurnNumber = Math.trunc(Number(timelineTurnNumber));
        if (Number.isFinite(normalizedTimelineTurnNumber) && normalizedTimelineTurnNumber > 0) {
          payload.timelineTurnNumber = normalizedTimelineTurnNumber;
        }
        if (timelineMessageId) {
          payload.timelineMessageId = String(timelineMessageId || '').trim();
        }
        if (typeof resolveTimelineTurnNumber === 'function') {
          payload.resolveTimelineTurnNumber = resolveTimelineTurnNumber;
        }
        await applyMemoryEdits(payload);
        emitMemoryUpdateTrace(recordTraceEvent, {
          phase: 'edit.apply',
          sessionId,
          status: 'success',
          summary: 'memory edit apply completed',
          details: {
            actionCount: confirmedActions.length,
          },
        });
      } else {
        emitMemoryUpdateTrace(recordTraceEvent, {
          phase: 'edit.apply',
          sessionId,
          status: 'cancelled',
          summary: 'memory edit apply cancelled',
          details: {
            actionCount: parsed.actions.length,
          },
        });
      }
    } catch (err) {
      emitMemoryUpdateTrace(recordTraceEvent, {
        phase: 'edit.apply',
        sessionId,
        status: 'error',
        summary: 'memory edit apply failed',
        details: {
          message: err?.message ? String(err.message) : String(err || ''),
        },
      });
      logger?.warn?.('apply memory edits failed', err);
      if (throwOnError || signal?.aborted) throw err;
    }
  }
  return parsed;
};

export const createMemoryEditUiRuntime = ({
  appSettings = null,
  chatStore = null,
  loadMemoryTemplateContext = async () => null,
  rawPlan = () => null,
  appConfirm = async () => true,
  toastr = null,
  isMemoryAutoExtractInline = () => false,
  extractTableEditBlocks = value => ({ text: String(value ?? ''), blocks: [], actions: [] }),
  appBridge = null,
  buildRequestPrompt = null,
  applyMemoryEdits = async () => null,
  logger = null,
  stripAssistantText = text => text,
  buildPlan = async () => null,
  recordTraceEvent = null,
} = {}) => ({
  confirmMemoryEditsIfNeeded: async (actions = []) => confirmMemoryEditsWithUi({
    actions,
    settings: appSettings?.get?.() || null,
    loadMemoryTemplateContext,
    rawPlan: typeof rawPlan === 'function' ? rawPlan() : rawPlan,
    appConfirm,
    toastr,
  }),
  handleMemoryEditsFromRaw: async (
    raw,
    {
      sessionId,
      isGroup,
      contextType = '',
      uiMode = '',
      memoryPlace = '',
      useSharedGlobalScope = false,
      timelineTurnNumber = null,
      timelineMessageId = '',
      resolveTimelineTurnNumber = null,
      force = false,
      requestPrompt,
      signal = null,
      throwOnError = false,
    } = {},
  ) =>
    handleMemoryEditsFromRawWithUi({
      signal,
      throwOnError,
      raw,
      sessionId,
      isGroup,
      contextType,
      uiMode,
      memoryPlace,
      useSharedGlobalScope,
      timelineTurnNumber,
      timelineMessageId,
      resolveTimelineTurnNumber,
      force,
      requestPrompt,
      isMemoryAutoExtractInline,
      extractTableEditBlocks,
      appBridge,
      buildRequestPrompt,
      confirmMemoryEdits: async actions => confirmMemoryEditsWithUi({
        actions,
        settings: appSettings?.get?.() || null,
        loadMemoryTemplateContext,
        rawPlan: typeof rawPlan === 'function' ? rawPlan() : rawPlan,
        appConfirm,
        toastr,
      }),
      applyMemoryEdits,
      logger,
      recordTraceEvent,
    }),
  buildMemoryUpdateHistoryText: sessionId => buildMemoryUpdateHistoryTextForSession({
    sessionId,
    chatStore,
    settings: appSettings?.get?.() || null,
    stripAssistantText,
  }),
  buildMemoryUpdatePlan: async (sessionId, isGroup, baseContext) => buildMemoryUpdatePlanForSession({
    sessionId,
    isGroup,
    baseContext,
    buildPlan,
  }),
});
