// 跳房子编排引擎（Phase 1C）：按板逐行调度房子执行器。
// 纯逻辑、无 DOM、无存储；执行器由调用方注入。契约见计划 §6：
// - 行内并发受 policy.rowConcurrencyMax 限制；行间等待上一行全部到终态（屏障）。
// - 同行房子只看到行开始时冻结的产物快照（同行隔离）；下游按行序合并，不按完成顺序。
// - 正文失败/取消 → 其后所有行 skipped；普通房子失败按 onHouseFailure 决定是否继续。
// - 取消：未启动 → cancelled(未启动)，进行中 → 透传 signal；超时 → failed(timeout) 并封住迟到结果。
// - 执行器必须返回真实终态；resolve 的 status 只接受 succeeded/failed/cancelled/skipped。

import { t } from '../../i18n/index.js';
import { validateHopscotchBoard } from './hopscotch-board-utils.js';

export const HOUSE_STATUS = Object.freeze({
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
});
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const trim = value => String(value ?? '').trim();
const isAbortError = err => err?.name === 'AbortError';
const hasFailedWork = state => state.status === HOUSE_STATUS.failed || state.childResults?.some(child => child.status === HOUSE_STATUS.failed);
const hasCancelledWork = state => state.status === HOUSE_STATUS.cancelled || state.childResults?.some(child => child.status === HOUSE_STATUS.cancelled);

const createAbortError = (message = 'aborted') => {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
};

const freezeTree = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
};
const freezeArtifacts = (artifacts, order = Object.keys(artifacts)) => {
  const out = {};
  order.filter(key => Object.hasOwn(artifacts, key)).forEach((key) => {
    out[key] = freezeTree(structuredClone(artifacts[key]));
  });
  return Object.freeze(out);
};

const linkedController = (parentSignal) => {
  const controller = new AbortController();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else {
      const onAbort = () => controller.abort(parentSignal.reason);
      parentSignal.addEventListener('abort', onAbort, { once: true });
      controller.dispose = () => parentSignal.removeEventListener('abort', onAbort);
    }
  }
  return controller;
};

// 简单的行内并发限制：按板内顺序启动，最多 limit 个同时进行。
const runWithLimit = async (items, limit, worker) => {
  const queue = items.slice();
  const results = new Array(items.length);
  let index = 0;
  const runOne = async () => {
    while (queue.length) {
      const item = queue.shift();
      const position = index;
      index += 1;
      results[position] = await worker(item, position);
    }
  };
  const workers = [];
  const count = Math.max(1, Math.min(limit, items.length));
  for (let i = 0; i < count; i += 1) workers.push(runOne());
  await Promise.all(workers);
  return results;
};

export const createCreativeTurnOrchestrator = ({
  board = null,
  executors = {},
  signal = null,
  now = () => Date.now(),
  setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutFn = id => clearTimeout(id),
  onHouseUpdate = null,
  onRowStart = null,
  logger = console,
} = {}) => {
  const validation = validateHopscotchBoard(board);
  if (!validation.ok) {
    const err = new Error(`invalid hopscotch board: ${validation.errors.map(e => e.code).join(',')}`);
    err.code = 'invalid_board';
    err.errors = validation.errors;
    throw err;
  }
  const normalized = validation.board;
  const policy = normalized.policy;
  const houses = new Map();
  const artifacts = {};
  let bodyRowIndex = -1;
  normalized.rows.forEach((row, rowIndex) => {
    row.houses.forEach((house) => {
      if (house.kind === 'body') bodyRowIndex = rowIndex;
      houses.set(house.id, {
        id: house.id,
        kind: house.kind,
        label: house.label,
        rowIndex,
        rowId: row.id,
        status: HOUSE_STATUS.queued,
        reason: '',
        error: '',
        startedAt: 0,
        finishedAt: 0,
        artifact: null,
        usage: null,
        agentRunIds: [],
        childResults: [],
        fused: house.kind === 'body' ? house.fused.slice() : undefined,
      });
    });
  });

  const emit = (state, patch = {}) => {
    Object.assign(state, patch);
    if (typeof onHouseUpdate === 'function') {
      try {
        onHouseUpdate({ ...state, artifact: state.artifact, agentRunIds: state.agentRunIds.slice() });
      } catch (err) {
        logger?.warn?.('hopscotch onHouseUpdate failed', err);
      }
    }
  };
  const settle = (state, status, patch = {}) => {
    if (TERMINAL.has(state.status)) return false; // 终态只落一次；迟到结果不得改写
    emit(state, { status, finishedAt: now(), ...patch });
    return true;
  };
  const skipAll = (rowStart, reason, note) => {
    normalized.rows.slice(rowStart).forEach((row) => {
      row.houses.forEach((house) => {
        const state = houses.get(house.id);
        if (!TERMINAL.has(state.status)) settle(state, HOUSE_STATUS.skipped, { reason, error: note || '' });
      });
    });
  };
  const cancelRemaining = (rowStart) => {
    normalized.rows.slice(rowStart).forEach((row) => {
      row.houses.forEach((house) => {
        const state = houses.get(house.id);
        if (state.status === HOUSE_STATUS.queued) settle(state, HOUSE_STATUS.cancelled, { reason: 'user_cancelled', error: t('未启动') });
      });
    });
  };

  const runHouse = async (houseDef, rowInput, turnContext, parentState = null) => {
    // 维护复用同一超时/取消/真实终态契约，但不覆盖已交付的正文或写表结果。
    const state = parentState
      ? { id: houseDef.kind, kind: houseDef.kind, status: HOUSE_STATUS.queued, reason: '', error: '', startedAt: 0, finishedAt: 0, artifact: null, childResults: [] }
      : houses.get(houseDef.id);
    const update = (patch) => {
      Object.assign(state, patch);
      if (parentState) {
        emit(parentState, { childResults: [...parentState.childResults.filter(child => child.id !== state.id), { ...state }] });
      } else if (!(patch.status === HOUSE_STATUS.succeeded && executors[houseDef.kind]?.maintenance)) {
        emit(state);
      }
    };
    const finish = (status, patch = {}) => {
      if (TERMINAL.has(state.status)) return;
      update({ status, finishedAt: now(), ...patch });
    };
    if (signal?.aborted) {
      finish(HOUSE_STATUS.cancelled, { reason: 'user_cancelled', error: t('未启动') });
      return state;
    }
    const executor = parentState ? executors[parentState.kind]?.maintenance : executors[houseDef.kind];
    if (typeof executor?.run !== 'function') {
      finish(HOUSE_STATUS.failed, { reason: 'executor_missing', error: `no executor for ${houseDef.kind}` });
      return state;
    }
    update({ status: HOUSE_STATUS.running, startedAt: now() });
    const controller = linkedController(signal);
    let timedOut = false;
    let timer = null;
    let onAbort;
    const abortPromise = new Promise((_, reject) => {
      onAbort = () => reject(createAbortError());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const timeoutMs = Number(houseDef.kind === 'custom_prompt' ? houseDef.config?.timeoutMs : policy.houseTimeoutMs) || policy.houseTimeoutMs;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeoutFn(() => {
        timedOut = true;
        controller.abort(createAbortError('house timeout'));
        reject(createAbortError('house timeout'));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([
        Promise.resolve(executor.run({
          house: houseDef,
          state: { ...state },
          turnContext,
          rowInput,
          signal: controller.signal,
        })),
        timeoutPromise,
        abortPromise,
      ]);
      if (timedOut) throw createAbortError('house timeout');
      if (signal?.aborted) {
        finish(HOUSE_STATUS.cancelled, { reason: 'user_cancelled', error: t('已中止') });
        return state;
      }
      const status = trim(result?.status);
      if (!TERMINAL.has(status)) {
        finish(HOUSE_STATUS.failed, { reason: 'invalid_executor_result', error: `executor returned status "${status || ''}"` });
        return state;
      }
      if (!parentState && status === HOUSE_STATUS.succeeded && result?.artifact !== undefined && result?.artifact !== null) {
        artifacts[houseDef.id] = result.artifact;
      }
      finish(status, {
        reason: trim(result?.reason),
        error: status === HOUSE_STATUS.failed ? trim(result?.error || result?.reason) : '',
        artifact: result?.artifact ?? null,
        usage: isPlainObject(result?.usage) ? result.usage : null,
        agentRunIds: Array.isArray(result?.agentRunIds) ? result.agentRunIds.map(trim).filter(Boolean) : [],
        childResults: Array.isArray(result?.childResults) ? result.childResults : [],
      });
    } catch (err) {
      if (timedOut) {
        finish(HOUSE_STATUS.failed, { reason: 'timeout', error: t('超时 {value}ms', { value: timeoutMs }) });
      } else if (isAbortError(err) || signal?.aborted) {
        finish(HOUSE_STATUS.cancelled, { reason: 'user_cancelled', error: t('已中止') });
      } else {
        logger?.warn?.('hopscotch house failed', houseDef.id, err);
        finish(HOUSE_STATUS.failed, { reason: 'executor_error', error: String(err?.message || err || '') });
      }
    } finally {
      if (timer != null) clearTimeoutFn(timer);
      controller.signal.removeEventListener('abort', onAbort);
      controller.dispose?.();
    }
    if (!parentState && state.status === HOUSE_STATUS.succeeded && executor.maintenance) {
      await runHouse({ kind: executor.maintenance.kind }, rowInput, turnContext, state);
    }
    return state;
  };

  const runTurn = async (turnContext = {}) => {
    const startedAt = now();
    let bodyStatus = '';
    let stopped = false;
    for (let rowIndex = 0; rowIndex < normalized.rows.length; rowIndex += 1) {
      const row = normalized.rows[rowIndex];
      if (signal?.aborted) {
        cancelRemaining(rowIndex);
        break;
      }
      if (stopped) {
        skipAll(rowIndex, 'stop_following_rows', t('前序房子失败'));
        break;
      }
      if (bodyRowIndex >= 0 && rowIndex > bodyRowIndex && bodyStatus !== HOUSE_STATUS.succeeded) {
        skipAll(rowIndex, 'body_not_succeeded', t('正文未成功'));
        break;
      }
      const rowInput = Object.freeze({
        rowIndex,
        rowId: row.id,
        artifacts: freezeArtifacts(artifacts, [...houses.keys()]),
        bodyDelivered: bodyStatus === HOUSE_STATUS.succeeded,
      });
      if (typeof onRowStart === 'function') {
        try { onRowStart({ rowIndex, rowId: row.id, houseIds: row.houses.map(h => h.id) }); } catch {}
      }
      await runWithLimit(row.houses, policy.rowConcurrencyMax, house => runHouse(house, rowInput, turnContext));
      row.houses.forEach((house) => {
        const state = houses.get(house.id);
        if (house.kind === 'body') bodyStatus = state.status;
        if ((house.kind !== 'body' || state.status === HOUSE_STATUS.succeeded) && hasFailedWork(state) && policy.onHouseFailure === 'stop_following_rows') {
          stopped = true;
        }
      });
      if (signal?.aborted) {
        cancelRemaining(rowIndex + 1);
        break;
      }
    }
    const list = Array.from(houses.values());
    let status;
    if (signal?.aborted && list.some(hasCancelledWork)) status = 'cancelled';
    else if (bodyRowIndex >= 0 && bodyStatus !== HOUSE_STATUS.succeeded) status = bodyStatus === HOUSE_STATUS.cancelled ? 'cancelled' : 'failed';
    else if (list.some(hasFailedWork) || list.some(hasCancelledWork)) status = 'partial';
    else status = 'succeeded';
    return {
      status,
      startedAt,
      finishedAt: now(),
      bodyDelivered: bodyStatus === HOUSE_STATUS.succeeded,
      houses: Object.fromEntries(list.map(s => [s.id, { ...s }])),
      artifacts: freezeArtifacts(artifacts, [...houses.keys()]),
    };
  };

  let turnPromise;
  return {
    board: normalized,
    runTurn: context => (turnPromise ||= runTurn(context)),
    getHouseState: id => (houses.has(id) ? { ...houses.get(id) } : null),
    listHouseStates: () => Array.from(houses.values()).map(s => ({ ...s })),
  };
};
