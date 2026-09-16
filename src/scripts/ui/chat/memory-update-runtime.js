import {
  buildMemoryUpdateTaskFinishTraceEvent,
  buildMemoryUpdateTaskSkippedTraceEvent,
  buildMemoryUpdateTaskStartTraceEvent,
  buildMemoryUpdateTraceEvent,
  buildMemoryUpdateRequest,
  resolveMemoryUpdateTrigger,
  setLastMemoryPlan,
} from './memory-update-runtime-utils.js';
import { loadBridgeConfig } from '../config-runtime-utils.js';
import { captureRequestContext } from '../../api/request-context.js';

const emitMemoryRuntimeTrace = (recordTraceEvent, event) => {
  if (typeof recordTraceEvent !== 'function') return null;
  try {
    return recordTraceEvent(buildMemoryUpdateTraceEvent(event));
  } catch {
    return null;
  }
};

export const resolveMemoryUpdateRuntimeConfig = async ({ appBridge, appSettings, memoryUpdateConfigManager }) => {
  const settings = appSettings.get();
  if (String(settings.memoryUpdateApiMode || 'chat').toLowerCase() !== 'profile') return loadBridgeConfig(appBridge);
  await memoryUpdateConfigManager.load();
  const profileId = String(settings.memoryUpdateProfileId || memoryUpdateConfigManager.getActiveProfileId() || '');
  return profileId ? memoryUpdateConfigManager.getRuntimeConfigByProfileId(profileId) : null;
};

export const createMemoryUpdateRuntime = ({
  agentTaskRuntime = null,
  appBridge,
  appSettings,
  buildMemoryUpdateHistoryText,
  buildMemoryUpdatePlan,
  canInitClient,
  createClient,
  handleMemoryEditsFromRaw,
  isMemoryAutoExtractSeparate,
  isMemoryUpdateTargetCurrent = async () => true,
  isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false,
  logger,
  memoryUpdateConfigManager,
  recordTraceEvent = null,
  sessionAsyncWorkRuntime = null,
  syncTurnCheckpointForMessage,
} = {}) => {
  const memoryUpdateRunning = new Set();
  const memoryUpdateAbortControllers = new Map();
  const memoryUpdateQueues = new Map();
  const memoryFillSessionCounters = new Map();

  const toAgentStatus = (status = '') => {
    const token = String(status || '').trim().toLowerCase();
    if (token === 'success') return 'succeeded';
    if (token === 'error') return 'failed';
    if (token === 'cancelled' || token === 'skipped') return token;
    return 'succeeded';
  };

  const resolveMemoryUpdateConfig = () => resolveMemoryUpdateRuntimeConfig({ appBridge, appSettings, memoryUpdateConfigManager });

  const abortMemoryUpdate = (sessionId) => {
    const queue = memoryUpdateQueues.get(sessionId);
    if (queue?.pending?.length) {
      queue.pending.forEach(task => task.resolve?.({ status: 'cancelled', reason: 'aborted' }));
      queue.pending = [];
    }
    const ac = memoryUpdateAbortControllers.get(sessionId);
    if (ac) {
      try {
        ac.abort();
      } catch {}
      memoryUpdateAbortControllers.delete(sessionId);
    }
  };

  const startAgentMemoryRun = async ({ sessionId, isGroup, checkpointMessageId }) => {
    if (!agentTaskRuntime || typeof agentTaskRuntime.startRun !== 'function') return null;
    try {
      const run = await Promise.resolve(agentTaskRuntime.startRun({
        kind: 'memory_update',
        title: 'Memory update',
        sessionId,
        surface: isGroup ? 'group-chat' : 'chat',
        trigger: 'chat.after_send',
        source: 'memory-update-runtime',
        summary: 'memory update task started',
        metadata: {
          isGroup: Boolean(isGroup),
          checkpointMessageId: String(checkpointMessageId || '').trim(),
        },
      }));
      const runId = String(run?.id || '').trim();
      if (!runId || typeof agentTaskRuntime.startStep !== 'function') return runId ? { runId, stepId: '' } : null;
      const step = await Promise.resolve(agentTaskRuntime.startStep(runId, {
        type: 'memory.update',
        title: 'Update memory',
        summary: 'memory update request running',
        input: {
          sessionId,
          isGroup: Boolean(isGroup),
          checkpointMessageId: String(checkpointMessageId || '').trim(),
        },
      }));
      return {
        runId,
        stepId: String(step?.id || '').trim(),
      };
    } catch (err) {
      logger?.debug?.('agent memory run start skipped', err);
      return null;
    }
  };

  const finishAgentMemoryRun = async (agentRun, {
    status = 'success',
    reason = '',
    errorMessage = '',
  } = {}) => {
    if (!agentRun?.runId || !agentTaskRuntime) return;
    const agentStatus = toAgentStatus(status);
    try {
      if (agentRun.stepId && typeof agentTaskRuntime.finishStep === 'function') {
        await Promise.resolve(agentTaskRuntime.finishStep(agentRun.runId, agentRun.stepId, {
          status: agentStatus,
          summary: reason ? `memory update ${agentStatus}: ${reason}` : `memory update ${agentStatus}`,
          errorMessage,
          metadata: {
            reason,
          },
        }));
      }
      if (typeof agentTaskRuntime.finishRun === 'function') {
        await Promise.resolve(agentTaskRuntime.finishRun(agentRun.runId, {
          status: agentStatus,
          summary: reason ? `memory update ${agentStatus}: ${reason}` : `memory update ${agentStatus}`,
          errorMessage,
          metadata: {
            reason,
          },
        }));
      }
    } catch (err) {
      logger?.debug?.('agent memory run finish skipped', err);
    }
  };

  const runMemoryUpdateTask = async (sessionId, isGroup, baseContext, checkpointMessageId, signal) => {
    const requestContext = captureRequestContext(baseContext?.meta?.requestContext || { sessionId });
    const runId = `${sessionId}:${checkpointMessageId || Date.now()}`;
    memoryUpdateRunning.add(runId);
    const agentRun = await startAgentMemoryRun({ sessionId, isGroup, checkpointMessageId });
    const finishTrace = async ({ status = 'success', reason = '', errorMessage = '' } = {}) => {
      emitMemoryRuntimeTrace(recordTraceEvent, buildMemoryUpdateTaskFinishTraceEvent({
        sessionId,
        status,
        reason,
        checkpointMessageId,
        errorMessage,
      }));
      await finishAgentMemoryRun(agentRun, { status, reason, errorMessage });
      return { status: toAgentStatus(status), reason, error: errorMessage };
    };
    emitMemoryRuntimeTrace(recordTraceEvent, buildMemoryUpdateTaskStartTraceEvent({
      sessionId,
      isGroup,
      checkpointMessageId,
    }));
    try {
      if (signal?.aborted) {
        return finishTrace({ status: 'cancelled', reason: 'aborted' });
      }
      if (!isOnline()) {
        return finishTrace({ status: 'skipped', reason: 'offline' });
      }
      const plan = await buildMemoryUpdatePlan(sessionId, isGroup, baseContext);
      setLastMemoryPlan(appBridge, plan);
      if (!plan?.enabled || !plan.promptText) {
        return finishTrace({ status: 'skipped', reason: plan?.enabled ? 'prompt-missing' : 'plan-disabled' });
      }
      if (signal?.aborted) {
        return finishTrace({ status: 'cancelled', reason: 'aborted' });
      }
      const historyText = buildMemoryUpdateHistoryText(sessionId);
      if (!historyText.trim()) {
        return finishTrace({ status: 'skipped', reason: 'empty-history' });
      }
      const config = await resolveMemoryUpdateConfig();
      if (!config || !canInitClient(config)) {
        logger.warn('memory update config missing or invalid');
        return finishTrace({ status: 'skipped', reason: 'config-invalid' });
      }
      if (signal?.aborted) {
        return finishTrace({ status: 'cancelled', reason: 'aborted' });
      }
      const request = buildMemoryUpdateRequest({
        promptText: plan.promptText,
        historyText,
      });
      const client = createClient(config);
      const response = await client.chat(request.messages, { signal, requestContext });
      if (signal?.aborted) {
        return finishTrace({ status: 'cancelled', reason: 'aborted' });
      }
      if (checkpointMessageId) {
        let targetCurrent = true;
        try {
          targetCurrent = await isMemoryUpdateTargetCurrent(sessionId, checkpointMessageId);
        } catch (err) {
          targetCurrent = false;
          logger?.warn?.('memory update target validation failed', err);
        }
        if (!targetCurrent) {
          return finishTrace({ status: 'skipped', reason: 'stale-checkpoint' });
        }
      }
      await handleMemoryEditsFromRaw(response, {
        signal,
        throwOnError: true,
        sessionId,
        isGroup,
        timelineMessageId: checkpointMessageId,
        force: true,
        requestPrompt: request.requestPrompt,
      });
      if (signal?.aborted) return finishTrace({ status: 'cancelled', reason: 'aborted' });
      if (checkpointMessageId) {
        await syncTurnCheckpointForMessage(sessionId, checkpointMessageId, {
          captureCurrentActiveState: true,
        });
      }
      return finishTrace({ status: 'success' });
    } catch (err) {
      if (err?.name === 'AbortError') {
        logger.info('memory update aborted', sessionId);
        return finishTrace({ status: 'cancelled', reason: 'aborted' });
      }
      logger.warn('memory update failed', err);
      return finishTrace({
        status: 'error',
        reason: 'exception',
        errorMessage: err?.message ? String(err.message) : String(err || ''),
      });
    } finally {
      memoryUpdateRunning.delete(runId);
    }
  };

  const ensureMemoryQueue = (sessionId) => {
    let queue = memoryUpdateQueues.get(sessionId);
    if (!queue) {
      queue = {
        pending: [],
        promise: null,
        running: false,
      };
      memoryUpdateQueues.set(sessionId, queue);
    }
    return queue;
  };

  const drainMemoryQueue = (sessionId) => {
    const queue = ensureMemoryQueue(sessionId);
    if (queue.running) return queue.promise || Promise.resolve();
    queue.running = true;
    queue.promise = (async () => {
      try {
        while (queue.pending.length > 0) {
          const task = queue.pending.shift();
          const ac = new AbortController();
          memoryUpdateAbortControllers.set(sessionId, ac);
          const workLease = sessionAsyncWorkRuntime?.register?.({
            sessionId,
            kind: 'memory_update',
            cancel: () => abortMemoryUpdate(sessionId),
          });
          try {
            task.resolve(await runMemoryUpdateTask(sessionId, task.isGroup, task.baseContext, task.checkpointMessageId, ac.signal));
          } finally {
            workLease?.settle?.();
            if (memoryUpdateAbortControllers.get(sessionId) === ac) {
              memoryUpdateAbortControllers.delete(sessionId);
            }
          }
        }
      } finally {
        queue.running = false;
        queue.promise = null;
      }
    })();
    return queue.promise;
  };

  const enqueueMemoryUpdate = (sessionId, isGroup, baseContext, checkpointMessageId) => {
    const queue = ensureMemoryQueue(sessionId);
    const completion = new Promise(resolve => queue.pending.push({ isGroup, baseContext, checkpointMessageId, resolve }));
    if (!queue.running) void drainMemoryQueue(sessionId);
    return completion;
  };

  const runMemoryUpdateAfterChat = async (sessionId, isGroup, baseContext, options = {}) => {
    // forceSeparate：跳房子板把记忆表格作为独立房子时，以板的本轮有效配置为准（不回写全局设置）
    if (!(options?.forceSeparate === true || isMemoryAutoExtractSeparate())) return;
    if (!sessionId) return;
    const trigger = resolveMemoryUpdateTrigger(
      appSettings.get(),
      memoryFillSessionCounters.get(sessionId) || 0,
    );
    if (!trigger.shouldRun) {
      memoryFillSessionCounters.set(sessionId, trigger.nextCounter);
      emitMemoryRuntimeTrace(recordTraceEvent, buildMemoryUpdateTaskSkippedTraceEvent({
        sessionId,
        reason: 'cadence',
        nextCounter: trigger.nextCounter,
        everyN: trigger.everyN,
      }));
      // 仅跳房子显式调用需要区分“按频率跳过”与“已执行”；旧调用方保持 undefined
      if (options?.forceSeparate === true) {
        return { skipped: true, reason: 'cadence', nextCounter: trigger.nextCounter, everyN: trigger.everyN };
      }
      return;
    }
    memoryFillSessionCounters.set(sessionId, trigger.nextCounter);
    const checkpointMessageId = String(options?.checkpointMessageId || '').trim();
    const completion = enqueueMemoryUpdate(sessionId, isGroup, baseContext, checkpointMessageId);
    if (options?.forceSeparate === true) return completion;
    // 旧调用方仍等待队列排空并返回 undefined；房子只等待自己这一个任务。
    await ensureMemoryQueue(sessionId).promise;
  };

  return {
    abortMemoryUpdate,
    drainMemoryQueue,
    runMemoryUpdateAfterChat,
  };
};
