// 跳房子单轮运行时（Phase 1C/2/3 集成层）：把板 + 编排引擎 + 执行器 + 泳道投影装配成一轮可运行对象。
// app.js 只负责注入依赖、在发送链的三个点调用（prepareTurn / waitForBodyStart / resolveBody）。
// 板模式仅在：创意写作会话、非预览、开关开启、且存在用户板（会话覆盖或全局）时启用；
// 未编辑的推导默认板继续走既有固定流程（creative-turn-tracker），保证默认行为等价。

import { t, translateUiText } from '../../i18n/index.js';
import { getActiveHopscotchFused, resolveHopscotchActivation } from './hopscotch-activation-utils.js';
import { buildDefaultHopscotchBoard, projectHopscotchVariableRules, compileBoardToLaneTasks, findBodyRowIndex, getHopscotchHouseDisplayStatus } from './hopscotch-board-utils.js';
import { createCreativeTurnOrchestrator } from './creative-turn-orchestrator.js';
import { estimateTokens } from '../../memory/memory-prompt-utils.js';

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const createAbortError = (message = 'aborted') => {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
};

export const HOPSCOTCH_PROMPT_BLOCK_SOURCE = 'hopscotch_house';
// 「全部已载入对话」的消息条数上限：仍受 contextTokenBudget 字符预算二次裁剪
export const HOPSCOTCH_FULL_CONTEXT_MESSAGE_CAP = 200;

export const trimHouseInputToBudget = (text, budget) => {
  const source = String(text || '');
  let low = 0;
  let high = source.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(source.slice(0, mid), 'rough') <= budget) low = mid;
    else high = mid - 1;
  }
  return source.slice(0, low);
};

// ---------- 自定义提示词房子：宏替换与上下文 ----------
export const renderCustomHousePrompt = (template = '', {
  userInput = '',
  bodyText = '',
  artifacts = {},
  charName = '',
  userName = '',
} = {}) => String(template ?? '').replace(
  /\{\{\s*(user_input|body|char|user|house:([A-Za-z0-9_\-]+))\s*\}\}/g,
  (_, name, id) => {
    if (!id) return String(({ user_input: userInput, body: bodyText, char: charName, user: userName })[name] ?? '');
    const artifact = artifacts?.[id];
    if (artifact?.mode === 'note') return '';
    return typeof artifact === 'string' ? artifact : String(artifact?.text ?? '');
  },
);

export const buildRecentContextText = (messages = [], { maxCount = 8, charBudget = 4000 } = {}) => {
  const list = (Array.isArray(messages) ? messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && trim(m.content))
    .slice(-Math.max(1, maxCount));
  const lines = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    const line = `${trim(m.name) || (m.role === 'user' ? 'user' : 'assistant')}: ${trim(m.content)}`;
    if (used + line.length > charBudget && lines.length) break;
    lines.unshift(line.slice(0, Math.max(0, charBudget - used)));
    used += line.length;
    if (used >= charBudget) break;
  }
  return lines.join('\n');
};

export const buildHousePromptBlock = ({ house = {}, artifact = null, order = 0 } = {}) => {
  const text = typeof artifact === 'string' ? artifact : trim(artifact?.text);
  if (!text) return null;
  return {
    content: `${t('【辅助资料 · {value}】', { value: house.label || house.id })}\n${text}`,
    role: 'system',
    position: 'before_latest_user',
    order,
    source: HOPSCOTCH_PROMPT_BLOCK_SOURCE,
    houseId: house.id,
    preRendered: true,
  };
};

// ---------- 执行器 ----------
export const createHopscotchExecutors = ({
  board = null,
  sessionId = '',
  isGroupChat = false,
  userInput = '',
  getTurnContext = () => ({}),
  abortBody = null,
  memory = null,          // { runMemoryUpdateAfterChat, runTimelineRepair, abortMemoryUpdate }
  compaction = null,      // { request(sessionId, { place }), place }
  tableMemoryEnabled = false,
  formatReview = null,    // { run({ sessionId, messageId, signal }) }
  image = null,           // { run({ sessionId, messageId, signal }) }
  sidecars = null,        // 独立图片提示、变量更新及分阶段原生规则
  custom = null,          // { backgroundChat, getRuntimeConfigByProfileId, getRecentMessages, getBodyText, charName, userName, recordRun }
  logger = console,
} = {}) => {
  const executors = {};
  // 同行隔离只需要本轮开始时的快照；按板内最大需求截取，避免每轮深拷贝整段已载入历史
  const historyLimit = (board?.rows?.flatMap(row => row.houses) || []).reduce((max, house) => {
    if (house.kind !== 'custom_prompt' || house.config?.includeContext === 'none') return max;
    return Math.max(max, house.config?.includeContext === 'full' ? HOPSCOTCH_FULL_CONTEXT_MESSAGE_CAP : (Number(house.config?.recentMessageCount) || 8));
  }, 0);
  const historySnapshot = historyLimit > 0 ? structuredClone(custom?.getRecentMessages?.(sessionId, historyLimit) || []) : [];
  const profileConfigs = new Map();
  for (const house of board?.rows?.flatMap(row => row.houses) || []) {
    if (house.kind !== 'custom_prompt') continue;
    const id = house.config?.modelMode === 'profile' ? house.config.modelProfileId : '';
    if (id && !profileConfigs.has(id)) profileConfigs.set(id, Promise.resolve(custom?.getRuntimeConfigByProfileId?.(id)).then(value => value ? { ...value } : null).catch(() => null));
  }
  // body：由发送链驱动的延迟执行器
  let bodyStartResolve = null;
  let bodyDoneResolve = null;
  let bodyStarted = false;
  let bodyResult = null;
  const bodyStartPromise = new Promise((resolve) => { bodyStartResolve = resolve; });
  const bodyDonePromise = new Promise((resolve) => { bodyDoneResolve = resolve; });
  executors.body = {
    run: ({ signal }) => {
      bodyStarted = true;
      bodyStartResolve({ proceed: true });
      if (bodyResult) return bodyResult;
      return new Promise((resolve) => {
        const finish = (result) => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve(result);
        };
        const onAbort = () => {
          abortBody?.(signal?.reason);
          finish({ status: 'cancelled', reason: 'user_cancelled' });
        };
        bodyDonePromise.then(finish);
        signal?.addEventListener?.('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };
  executors.__body = {
    waitForStart: () => bodyStartPromise,
    // 编排器未到正文行就结束（前置行失败停止 / 取消）时，让发送链解除等待
    releaseWithoutStart: reason => { if (!bodyStarted) bodyStartResolve({ proceed: false, reason }); },
    resolve: (result) => {
      bodyResult = result;
      bodyDoneResolve(result);
    },
  };

  if (memory) {
    executors.memory_table = {
      run: async ({ signal }) => {
        const ctx = getTurnContext()?.body;
        if (!ctx?.buildMemoryContext) return { status: 'skipped', reason: 'body_context_missing' };
        const onAbort = () => { try { memory.abortMemoryUpdate?.(sessionId); } catch {} };
        signal?.addEventListener?.('abort', onAbort, { once: true });
        try {
          const result = await memory.runMemoryUpdateAfterChat(sessionId, isGroupChat, ctx.buildMemoryContext(), {
            checkpointMessageId: ctx.checkpointMessageId || '',
            forceSeparate: true,
          });
          if (signal?.aborted) return { status: 'cancelled', reason: 'user_cancelled' };
          if (result?.skipped) return { status: 'skipped', reason: trim(result.reason) || 'cadence' };
          if (result?.status && result.status !== 'succeeded') return result;
          const repair = await memory.runTimelineRepair?.(sessionId, isGroupChat, { signal });
          if (signal?.aborted) return { status: 'cancelled', reason: 'user_cancelled' };
          return { status: 'succeeded', artifact: { kind: 'memory_table', payload: { memoryResult: result ?? null, repairResult: repair ?? null } } };
        } finally {
          signal?.removeEventListener?.('abort', onAbort);
        }
      },
    };
  }
  if (compaction) {
    executors.summary_compaction = {
      run: async ({ signal, expectedAdapterKind = '' }) => {
        const ok = await compaction.request(sessionId, { place: compaction.place, signal, detailed: true, ...(expectedAdapterKind ? { expectedAdapterKind } : {}) });
        if (isPlainObject(ok)) return ok;
        return ok
          ? { status: 'succeeded', artifact: { kind: 'summary_compaction', payload: { compacted: true } } }
          : { status: 'skipped', reason: 'threshold_not_reached' };
      },
    };
    // 新默认板把表格压缩保留为内部维护；旧板/显式压缩房仍按原配置执行。
    const houses = board?.rows?.flatMap(row => row.houses) || [];
    if (board?.policy?.tableSummaryMaintenance === true && tableMemoryEnabled
      && !houses.some(house => house.kind === 'summary_compaction')) {
      const host = houses.find(house => house.enabled !== false && (house.kind === 'memory_table'
        || (house.kind === 'body' && house.fused?.includes('memory_table'))));
      if (host && executors[host.kind]) {
        executors[host.kind].maintenance = {
          kind: 'summary_compaction',
          run: ({ signal }) => executors.summary_compaction.run({ signal, expectedAdapterKind: 'memory_table' }),
        };
      }
    }
  }
  if (formatReview) {
    executors.format_review = {
      run: async ({ signal }) => {
        if (formatReview.place === 'writing') return { status: 'skipped', reason: 'chat_only' };
        const ctx = getTurnContext()?.body;
        if (!ctx?.messageId) return { status: 'skipped', reason: 'body_message_missing' };
        return formatReview.run({ sessionId, messageId: ctx.messageId, signal });
      },
    };
  }
  if (image) {
    executors.image_generation = {
      run: async ({ signal, rowInput }) => {
        const ctx = getTurnContext()?.body;
        if (!ctx?.messageId) return { status: 'skipped', reason: 'body_message_missing' };
        const prompt = board?.rows.flatMap(row => row.houses).find(h => h.kind === 'image_prompt');
        const artifact = prompt ? rowInput?.artifacts?.[prompt.id] : null;
        if (prompt && artifact?.kind !== 'image_prompt') return { status: 'skipped', reason: 'image_prompt_missing' };
        return image.run({ sessionId, messageId: ctx.messageId, signal, ...(prompt ? { promptArtifact: artifact } : {}) });
      },
    };
  }
  if (custom) {
    executors.custom_prompt = {
      run: async ({ house, rowInput, signal }) => {
        const cfg = house.config || {};
        const ctx = getTurnContext();
        const bodyText = rowInput?.bodyDelivered && ctx?.body?.messageId
          ? String(custom.getBodyText?.(sessionId, ctx.body.messageId) || '') : '';
        const artifactsText = {};
        Object.entries(rowInput?.artifacts || {}).forEach(([id, artifact]) => { artifactsText[id] = artifact; });
        const rendered = renderCustomHousePrompt(cfg.prompt, {
          userInput, bodyText, artifacts: artifactsText, charName: custom.charName, userName: custom.userName,
        });
        const system = renderCustomHousePrompt(cfg.systemPrompt, {
          userInput, bodyText, artifacts: artifactsText, charName: custom.charName, userName: custom.userName,
        });
        if (!trim(rendered)) return { status: 'skipped', reason: 'empty_prompt' };
        const parts = [];
        if (cfg.includeContext !== 'none') {
          const maxCount = cfg.includeContext === 'full' ? HOPSCOTCH_FULL_CONTEXT_MESSAGE_CAP : (Number(cfg.recentMessageCount) || 8);
          const contextText = buildRecentContextText(historySnapshot, {
            maxCount,
            charBudget: Math.max(200, (Number(cfg.contextTokenBudget) || 2000) * 2),
          });
          if (contextText) parts.push(`${t('【最近对话】')}\n${contextText}`);
        }
        parts.push(rendered);
        const messages = [];
        const budget = Number(cfg.contextTokenBudget) || 2000;
        const boundedSystem = trimHouseInputToBudget(system, Math.floor(budget / 3));
        if (trim(boundedSystem)) messages.push({ role: 'system', content: boundedSystem });
        const inputText = parts.join('\n\n');
        // 显式占位也计入预算；优先保留任务指令，再分配历史。
        const remaining = budget - estimateTokens(boundedSystem, 'rough');
        const boundedPrompt = trimHouseInputToBudget(rendered, remaining);
        const historyText = parts.length > 1 ? trimHouseInputToBudget(parts.slice(0, -1).join('\n\n'), Math.max(0, remaining - estimateTokens(boundedPrompt, 'rough') - 2)) : '';
        messages.push({ role: 'user', content: [historyText, boundedPrompt].filter(Boolean).join('\n\n') });
        let providerUsage = null;
        const options = {
          onProviderUsage: value => { providerUsage = value; },
          signal,
          maxTokens: Number(cfg.maxTokens) || 512,
          presetContext: { sessionId, uiMode: 'rp' },
          ...(custom.runtimeConfig ? { runtimeConfigOverride: { ...custom.runtimeConfig } } : {}),
          tools: [],
        };
        let modelSource = 'follow_current';
        if (cfg.modelMode === 'profile' && cfg.modelProfileId) {
          const runtimeConfig = await (profileConfigs.get(cfg.modelProfileId) || custom.getRuntimeConfigByProfileId?.(cfg.modelProfileId));
          if (!runtimeConfig) return { status: 'failed', reason: 'model_profile_missing', error: t('指定的模型配置不存在') };
          options.runtimeConfigOverride = cfg.modelOverride ? { ...runtimeConfig, model: cfg.modelOverride } : runtimeConfig;
          modelSource = 'profile';
        }
        const startedAt = Date.now();
        const runRecord = custom.recordRun?.({ house, messages, modelSource }) || null;
        try {
          const raw = await custom.backgroundChat(messages, options);
          const text = typeof raw === 'string' ? raw : String(raw?.content ?? raw?.text ?? '');
          const result = signal?.aborted ? { status: 'cancelled', reason: 'user_cancelled' } : trim(text)
            ? { status: 'succeeded', artifact: { kind: 'text', text: trim(text), mode: cfg.output?.mode || 'context' }, usage: { latencyMs: Date.now() - startedAt, modelSource, providerUsage: providerUsage || raw?.usage || null, inputTruncated: inputText.length + system.length > messages.reduce((n, m) => n + m.content.length, 0) } }
            : { status: 'failed', reason: 'empty_response', error: t('模型返回为空') };
          runRecord?.finish?.(result);
          if (runRecord?.id) result.agentRunIds = [runRecord.id];
          return result;
        } catch (err) {
          const result = err?.name === 'AbortError'
            ? { status: 'cancelled', reason: 'user_cancelled' }
            : { status: 'failed', reason: 'request_failed', error: String(err?.message || err || '') };
          runRecord?.finish?.(result);
          if (result.status === 'failed') logger?.warn?.('hopscotch custom house failed', house.id, err);
          return result;
        }
      },
    };
  }
  if (sidecars) Object.assign(executors, sidecars);
  return executors;
};

// ---------- 泳道投影 ----------
const laneSummaryFor = (state) => {
  const label = state.kind === 'custom_prompt' ? state.label || state.id : translateUiText(state.label || state.id);
  switch (state.status) {
    case 'running': return t('{value} 执行中', { value: label });
    case 'succeeded': return t('{value} 完成', { value: label });
    case 'failed': return state.reason === 'timeout' ? t('{value} 超时', { value: label }) : t('{value} 失败', { value: label });
    case 'partial': return `${label} · ${t('部分失败')}`;
    case 'cancelled': return t('{value} 已取消', { value: label });
    case 'skipped': return t('{value} 跳过', { value: label });
    default: return label;
  }
};

export const projectHouseStateToLane = (laneRuntime, state) => {
  if (!laneRuntime || !state) return;
  const status = getHopscotchHouseDisplayStatus(state);
  const summary = laneSummaryFor({ ...state, status });
  const detail = { kind: state.kind, reason: state.reason || '', fused: state.fused, usage: state.usage || null, deliveryStatus: state.status, childResults: state.childResults || [] };
  if (status === 'running') {
    laneRuntime.activateTask?.(state.id, { summary, detail });
  } else if (status === 'succeeded') {
    laneRuntime.finishTask?.(state.id, 'succeeded', { summary, detail, output: state.artifact ?? null });
  } else if (status === 'failed' || status === 'partial') {
    laneRuntime.failTask?.(state.id, state.error || state.reason || summary, { summary, detail, output: state.artifact ?? null });
  } else if (status === 'cancelled') {
    laneRuntime.finishTask?.(state.id, 'cancelled', { summary, detail });
  } else if (status === 'skipped') {
    laneRuntime.finishTask?.(state.id, 'skipped', { summary: state.error ? `${summary} · ${state.error}` : summary, detail });
  }
};

// ---------- 运行时 ----------
export const createHopscotchTurnRuntime = ({
  getSettings = () => ({}),
  boardStore = null,
  resolveWritingSettings = () => ({}),
  laneRuntime = null,
  getLaneRuntime = null,   // 泳道运行时可能晚于本运行时创建：优先延迟读取
  createExecutors = null,   // (turnInfo) => executors（app 注入真实执行器依赖）
  now = () => Date.now(),
  sessionAsyncWorkRuntime = null,
  getCurrentSessionId = null,
  logger = console,
} = {}) => {
  const activeTurns = new Map(); // sessionId -> turn
  const latestTurns = new Map();
  const listeners = new Set();
  let sequence = 0;
  const notify = sid => listeners.forEach(fn => { try { fn(sid); } catch {} });
  const resolveLane = () => (typeof getLaneRuntime === 'function' ? getLaneRuntime() : laneRuntime);

  const isEnabled = () => getSettings()?.creativeHopscotchEnabled === true;
  const resolveBoard = (sessionId, { place = 'writing', contextSessionId = sessionId } = {}) => {
    if (!boardStore) return { board: null, source: 'derived' };
    const settings = resolveWritingSettings(contextSessionId, place);
    const derived = buildDefaultHopscotchBoard({ ...settings, place });
    // 聊天不能读到创意写作的自定义板，也不能借此接管聊天发送。
    if (place === 'chat') return { board: derived, source: 'derived' };
    const resolved = boardStore.resolveEffectiveBoard({ sessionId, derivedBoard: derived });
    return { ...resolved, board: projectHopscotchVariableRules(resolved.board, settings?.variables?.activity) };
  };

  const resolveActivation = (board, sessionId, { place = 'writing' } = {}) => resolveHopscotchActivation(board, resolveWritingSettings(sessionId, place));
  const resolveFusionCapabilities = (sessionId, { place = 'writing' } = {}) => {
    const settings = resolveWritingSettings(sessionId, place);
    return {
      memory_table: { reason: settings.memory?.independentModel ? t('记忆使用独立模型配置，需先改为跟随正文') : '' },
      variable_rules: { reason: t('变量规则按触发阶段独立执行') },
    };
  };
  const resolveExecutionPlan = (sessionId, { place = 'writing' } = {}) => {
    const resolved = resolveBoard(sessionId, { place });
    const settings = resolveWritingSettings(sessionId, place);
    const activation = resolveHopscotchActivation(resolved.board, settings);
    return { ...resolved, activation, memory: structuredClone(settings?.memory || {}), fused: getActiveHopscotchFused(resolved.board, activation), custom: place === 'writing' && isEnabled() && resolved.source !== 'derived' };
  };

  const isSessionBusy = sessionId => activeTurns.has(trim(sessionId));
  const abortSessionTurn = (sessionId, reason = 'user') => {
    const turn = activeTurns.get(trim(sessionId));
    if (!turn) return false;
    turn.abort(reason);
    return true;
  };

  const prepareTurn = ({
    sessionId = '',
    isGroupChat = false,
    rpUiMode = false,
    previewOnly = false,
    text = '',
    generationId = 0,
    title = '',
    parentSignal = null,
    executorContext = {}, executionPlan = null,
  } = {}) => {
    const sid = trim(sessionId);
    if (!sid || !rpUiMode || previewOnly || !isEnabled()) return null;
    const resolved = executionPlan || resolveExecutionPlan(sid);
    if (!resolved.board || resolved.source === 'derived') return null;
    if (activeTurns.has(sid)) return null;
    const board = structuredClone(resolved.board);
    const activation = structuredClone(resolved.activation || resolveActivation(board, sid));
    const fused = getActiveHopscotchFused(board, activation);
    // 执行器只拿有效成员；运行页仍保留完整原板与逐项启停原因。
    const executionBoard = structuredClone(board);
    for (const row of executionBoard.rows) for (const house of row.houses) {
      house.enabled = activation.houses[house.id]?.enabled !== false;
      if (house.kind === 'body') house.fused = fused.slice();
    }
    const turnRunId = `hopscotch:${now()}:${++sequence}`;
    const controller = new AbortController();
    const onParentAbort = () => controller.abort(parentSignal.reason);
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason);
      else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    const turnContext = { sessionId: sid, isGroupChat, userInput: text, body: null };
    const memorySettings = resolved.memory || resolveWritingSettings(sid, 'writing')?.memory;
    const tableMemoryEnabled = memorySettings?.storageMode === 'table' && memorySettings.placeEnabled !== false && memorySettings.writingEnabled !== false;
    const executorInfo = { sessionId: sid, turnRunId, board: executionBoard, isGroupChat, userInput: text, getTurnContext: () => turnContext, ...(isPlainObject(executorContext) ? executorContext : {}), tableMemoryEnabled };
    const executors = typeof createExecutors === 'function'
      ? createExecutors(executorInfo)
      : createHopscotchExecutors({ ...executorInfo, logger });
    const bodyHandle = executors.__body;
    const bodyRowIndex = findBodyRowIndex(board);
    const promptBlocks = [];
    const houseOrder = board.rows.flatMap(row => row.houses).map(house => house.id);
    const ownsLane = () => {
      if (getCurrentSessionId && getCurrentSessionId() !== sid) return false;
      const run = resolveLane()?.getState?.()?.run;
      return run?.id ? run.id === turnRunId : run?.generationId === generationId;
    };
    let orchestrator;
    try {
      orchestrator = createCreativeTurnOrchestrator({
        board,
        activation,
        executors,
        signal: controller.signal,
        now,
        logger,
        onHouseUpdate: (state) => {
          if (ownsLane()) projectHouseStateToLane(resolveLane(), state);
          // 前置行 context 产物且开启注入正文 → 进入本轮提示块（固定锚点 before_latest_user）
          if (state.status === 'succeeded' && state.kind === 'custom_prompt' && state.rowIndex < bodyRowIndex) {
            const house = board.rows[state.rowIndex]?.houses.find(h => h.id === state.id);
            if (house?.config?.output?.mode === 'context' && house.config.output.injectIntoBody) {
              const block = buildHousePromptBlock({ house, artifact: state.artifact, order: houseOrder.indexOf(house.id) });
              if (block) promptBlocks.push(block);
            }
          }
          notify(sid);
        },
      });
    } catch (err) {
      logger?.warn?.('hopscotch turn rejected: invalid board', err);
      return null;
    }
    const { lanes, tasks } = compileBoardToLaneTasks(board);
    const memoryPhase = fused.includes('memory_table') ? 'sync' : (executionBoard.rows.some(r => r.houses.some(h => h.kind === 'memory_table' && h.enabled)) ? 'async' : 'none');
    let laneActive = false;
    const laneRef = resolveLane();
    const startLane = () => {
      laneActive = Boolean(laneRef?.startRun?.({
        runId: turnRunId,
        sessionId: sid,
        generationId,
        title: title || t('跳房子流程'),
        text,
        executionPlan: { memoryPhase, variablePhase: fused.includes('variable') ? 'sync' : 'none' },
        lanes,
        tasks,
        board,
      }));
      if (laneActive) {
        laneRef.finishTask?.('input', 'succeeded', { summary: t('输入已整理'), output: { textLength: String(text || '').length } });
        laneRef.finishTask?.('context', 'succeeded', { summary: t('按跳房子板执行'), detail: { boardSource: resolved.source, boardId: board.id, rows: board.rows.length } });
      }
    };

    const turn = {
      sessionId: sid,
      turnRunId,
      generationId,
      board,
      boardSource: resolved.source,
      activation,
      fused,
      // 板决定是否内联抽取，但记忆表格总开关/写作位置关闭时不注入（计划 §5.1）
      memoryInline: fused.includes('memory_table') && tableMemoryEnabled,
      ownsFormatReview: true,
      ownsImage: true,
      signal: controller.signal,
      getPromptBlocks: () => promptBlocks.slice().sort((a, b) => a.order - b.order),
      getHouseStates: () => orchestrator.listHouseStates(),
      waitForBodyStart: () => bodyHandle.waitForStart(),
      setBodyContext: (ctx = {}) => { turnContext.body = { ...(turnContext.body || {}), ...ctx }; },
      resolveBody: (result = {}) => {
        const status = trim(result.status) || 'failed';
        turnContext.body = { ...(turnContext.body || {}), messageId: trim(result.messageId) || turnContext.body?.messageId || '' };
        bodyHandle.resolve({ status, reason: trim(result.reason), error: trim(result.error), artifact: status === 'succeeded' ? { kind: 'body', messageId: turnContext.body.messageId } : null });
      },
      abort: (reason = 'user') => { if (!controller.signal.aborted) controller.abort(createAbortError(String(reason || 'aborted'))); },
      result: null,
      turnPromise: null,
    };
    startLane();
    activeTurns.set(sid, turn);
    latestTurns.set(sid, turn);
    const workLease = sessionAsyncWorkRuntime?.register?.({ sessionId: sid, kind: 'hopscotch_turn', cancel: turn.abort });
    turn.turnPromise = orchestrator.runTurn(turnContext)
      .then((result) => {
        turn.result = result;
        if (laneActive && ownsLane()) {
          if (result.status === 'succeeded') laneRef.completeRun?.({ summary: t('已完成 · 查看流程') });
          else if (result.status === 'cancelled') laneRef.cancelRun?.('interrupted');
          else laneRef.failRun?.(result.status === 'partial' ? t('部分房子失败') : t('正文未完成'));
        }
        return result;
      }, (err) => {
        logger?.warn?.('hopscotch turn crashed', err);
        if (laneActive && ownsLane()) laneRef.failRun?.(String(err?.message || err || ''));
        throw err;
      })
      .finally(() => {
        bodyHandle.releaseWithoutStart('turn_finished');
        if (activeTurns.get(sid) === turn) activeTurns.delete(sid);
        parentSignal?.removeEventListener('abort', onParentAbort);
        workLease?.settle?.();
        notify(sid);
      });
    return turn;
  };

  return {
    isEnabled,
    resolveBoard,
    isSessionBusy,
    abortSessionTurn,
    prepareTurn,
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    getLatestTurn: sid => latestTurns.get(trim(sid)) || null,
    clearScope: () => {
      activeTurns.forEach(turn => turn.abort('scope_changed'));
      activeTurns.clear();
      latestTurns.clear();
    },
    getActiveTurn: sessionId => activeTurns.get(trim(sessionId)) || null,
    resolveActivation, resolveExecutionPlan, resolveFusionCapabilities,
  };
};
