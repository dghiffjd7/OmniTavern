import { t } from '../i18n/index.js';

// 脚本单独调用模型（酒馆 /api/backends/chat-completions/generate）的执行流记录：
// 运行记录（Agent 中心与顶栏「运行中」）；创意写作时泳道正显示这个会话，就在模型栏加一项。
export const SCRIPT_GENERATION_RUN_KIND = 'script_generation';

const trim = value => String(value ?? '').trim();
const STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

// 主程式量到的用量（provider-usage 的格式）＋这次的耗时，放进运行记录的 usage
export const buildScriptModelCallRunUsage = ({ usage = null, model = '', provider = '', latencyMs = null, aborted = false } = {}) => ({
  provider: trim(usage?.provider) || trim(provider),
  model: trim(usage?.model) || trim(model),
  promptTokens: usage?.promptTokens ?? null,
  completionTokens: usage?.completionTokens ?? null,
  totalTokens: usage?.totalTokens ?? null,
  latencyMs,
  modelCallCount: 1,
  finishReason: trim(usage?.finishReason),
  aborted: aborted === true,
});

export const createScriptModelCallRunTracker = ({
  agentTaskRuntime = null,
  getLaneRuntime = () => null,
  completeLaneIfIdle = () => {},
  logger = null,
  now = () => Date.now(),
} = {}) => {
  // info：{ sessionId, scriptId, scriptName, scope, sourceName, model, requestedModel, modelNote, provider, stream, sent }
  // sent 为 false 表示没有发出请求（拒绝、确认窗关闭、等同意时被取消），只记运行记录，不加泳道任务
  const start = (info = {}) => {
    const sessionId = trim(info.sessionId);
    const scriptName = trim(info.scriptName) || trim(info.scriptId);
    const model = trim(info.model);
    const requestedModel = trim(info.requestedModel);
    let runId = '';
    try {
      const run = agentTaskRuntime?.startRun?.({
        kind: SCRIPT_GENERATION_RUN_KIND,
        title: t('脚本调用模型 · {script}', { script: scriptName || '-' }),
        sessionId,
        surface: sessionId.startsWith('rp:') ? 'writing' : 'chat',
        trigger: 'script.tavern_api',
        source: 'tavern-api-generate',
        summary: `script model call started (${model || '-'})`,
        metadata: {
          scriptId: trim(info.scriptId),
          scriptName,
          scriptScope: trim(info.scope),
          scriptSource: trim(info.sourceName),
          model,
          ...(requestedModel && requestedModel !== model ? { requestedModel, modelNote: trim(info.modelNote) } : {}),
          stream: info.stream === true,
        },
      });
      runId = trim(run?.id);
    } catch (error) {
      logger?.debug?.('script model call run start skipped', error);
    }
    let laneTaskId = '';
    const lane = info.sent === false ? null : getLaneRuntime?.();
    const laneState = lane?.getState?.();
    // 默认泳道有「模型」栏；用跳房子流程板时泳道按房子分栏，改加在「正文生成」栏；两者都没有就不加
    const laneIds = Array.isArray(laneState?.lanes) ? new Set(laneState.lanes.map(item => trim(item?.id))) : null;
    const laneId = laneIds ? ['model', 'body'].find(id => laneIds.has(id)) : 'model';
    if (laneState?.visible && laneId && sessionId && trim(laneState.run?.sessionId) === sessionId) {
      const task = lane.appendTask?.({
        id: `script-generation-${now()}`,
        laneId,
        label: t('脚本调用模型'),
        brief: scriptName,
        summary: t('脚本调用模型中'),
        status: 'running',
      });
      laneTaskId = trim(task?.id);
    }
    return { runId, laneTaskId, lane: laneTaskId ? lane : null, model, provider: trim(info.provider), startedAt: now() };
  };

  // result：{ status: succeeded|failed|cancelled, usage, errorMessage, cancelReason, reason }
  const finish = (handle, result = {}) => {
    if (!handle) return;
    const status = STATUSES.has(result.status) ? result.status : 'failed';
    if (handle.runId) {
      try {
        agentTaskRuntime?.finishRun?.(handle.runId, {
          status,
          summary: `script model call ${status}${result.reason ? `: ${result.reason}` : ''}`,
          errorMessage: status === 'failed' ? trim(result.errorMessage) : '',
          ...(status === 'cancelled' ? { cancelReason: trim(result.cancelReason) } : {}),
          ...(result.sent === false ? {} : {
            usage: buildScriptModelCallRunUsage({
              usage: result.usage,
              model: handle.model,
              provider: handle.provider,
              latencyMs: Math.max(0, now() - handle.startedAt),
              aborted: status === 'cancelled',
            }),
          }),
        });
      } catch (error) {
        logger?.debug?.('script model call run finish skipped', error);
      }
    }
    if (handle.laneTaskId && handle.lane) {
      if (status === 'succeeded') handle.lane.finishTask?.(handle.laneTaskId, 'succeeded', { summary: t('脚本调用模型完成') });
      else if (status === 'failed') handle.lane.failTask?.(handle.laneTaskId, trim(result.errorMessage) || trim(result.reason));
      else handle.lane.finishTask?.(handle.laneTaskId, 'cancelled');
      try { completeLaneIfIdle?.(); } catch {}
    }
  };

  // 没有发出请求的调用：开了马上结束
  const record = (info = {}, result = {}) => finish(start({ ...info, sent: false }), { ...result, sent: false });

  return { start, finish, record };
};
