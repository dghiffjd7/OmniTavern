// 创意写作单轮执行泳道追踪器：从 app.js handleSend 闭包内等价抽出的泳道上报逻辑。
// 只负责在发送链各阶段向 creativeExecutionLaneRuntime 上报状态，不参与任何业务决策、
// 请求构造、保存或副作用；调用时序与 payload 与抽取前逐字一致（见 scripts/tests/creative-turn-tracker-tests.mjs）。
// 跳房子计划 Phase 1B（Unfinished_Plans/创意写作Agent跳房子编排计划.md §14）。

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
const trim = value => String(value || '').trim();

export const createCreativeTurnTracker = ({
  laneRuntime = null,
  generationId = 0,
  getGenerationId = null,
  sessionId = '',
  rpUiMode = false,
  place = 'chat',
  isMemoryAutoExtractInline = () => false,
  isMemoryAutoExtractSeparate = () => false,
  completeIfIdle = () => {},
  // 跳房子板接管本轮时（用户板 + 开关开启），固定泳道追踪器整体静默，由板运行时投影泳道
  isSuppressed = () => false,
  logger = console,
} = {}) => {
  let active = false;
  let memoryTask = null;
  // handleSend 的 generationId 在创建 tracker 之后才分配，必须延迟读取（与抽取前闭包语义一致）
  const currentGenerationId = () => (typeof getGenerationId === 'function' ? getGenerationId() : generationId);

  const getMemoryPhase = () => {
    if (isMemoryAutoExtractInline(place)) return 'sync';
    if (isMemoryAutoExtractSeparate(place)) return 'async';
    return 'none';
  };
  const isTaskTerminal = (taskId) => {
    const status = String(
      laneRuntime?.getState?.()?.tasks?.find(task => task.id === taskId)?.status || '',
    );
    return TERMINAL.has(status);
  };
  const isRunCurrent = () => {
    const run = laneRuntime?.getState?.()?.run;
    if (!run) return false;
    return (Number(run.generationId) || 0) === (Number(currentGenerationId()) || 0);
  };
  const syncPostModelTasks = () => {
    if (!active || !isRunCurrent()) return;
    const memoryPhase = getMemoryPhase();
    if (memoryPhase === 'sync') {
      laneRuntime?.finishTask?.('memory', 'succeeded', {
        summary: '记忆表已随正文同步处理',
      });
    } else if (memoryPhase === 'async') {
      laneRuntime?.markPostModelTasksRunning?.('同步记忆表与轮次快照');
    } else {
      laneRuntime?.skipTask?.('memory', {
        summary: '本次未触发记忆表同步',
      });
    }
  };

  const start = ({ title = '', text = '', input = null, context = null, model = null } = {}) => {
    if (!rpUiMode || isSuppressed()) return false;
    active = Boolean(laneRuntime?.startRun?.({
      sessionId,
      generationId: currentGenerationId(),
      title,
      text,
      executionPlan: {
        memoryPhase: getMemoryPhase(),
        variablePhase: 'sync',
      },
    }));
    if (active) {
      laneRuntime?.finishTask?.('input', 'succeeded', input);
      laneRuntime?.finishTask?.('context', 'succeeded', context);
      laneRuntime?.activateTask?.('model', model);
    }
    return active;
  };

  const modelRequested = (detail = {}) => {
    if (!active) return;
    laneRuntime?.activateTask?.('model', {
      summary: '模型请求已发送',
      detail,
    });
  };
  const modelStreaming = () => {
    if (!active) return;
    laneRuntime?.activateTask?.('model', '正在接收流式内容');
  };
  const modelBuffered = () => {
    if (!active) return;
    laneRuntime?.activateTask?.('model', '已收到完整模型回复，正在保存与解析');
  };
  const modelDone = ({ checkpointTargetMessageId = '', stream = false, branch = '' } = {}) => {
    if (!active) return;
    laneRuntime?.finishTask?.('model', 'succeeded', {
      summary: '模型回复已生成',
      output: stream
        ? { checkpointTargetMessageId, stream: true }
        : { checkpointTargetMessageId, branch, stream: false },
    });
    syncPostModelTasks();
  };

  const variableApplied = ({ changed = false, targetSessionId = '', messageId = '' } = {}) => {
    if (
      changed &&
      active &&
      trim(targetSessionId) === sessionId &&
      isRunCurrent()
    ) {
      laneRuntime?.finishTask?.('variable', 'succeeded', {
        summary: '回复内变量编辑已应用',
        output: {
          messageId: String(messageId || ''),
        },
      });
    }
  };

  const runMemoryTask = ({
    targetSessionId = '',
    targetIsGroup = false,
    run = () => null,
    afterSuccess = async () => null,
  } = {}) => {
    const track = isMemoryAutoExtractSeparate(place);
    if (active && track) {
      laneRuntime?.activateTask?.('memory', {
        summary: '同步记忆表与轮次快照',
        detail: {
          targetSessionId,
          targetIsGroup: Boolean(targetIsGroup),
        },
      });
    }
    const task = Promise.resolve(run()).then(
      async (memoryResult) => {
        const repairResult = await afterSuccess(memoryResult);
        if (active && track && isRunCurrent()) {
          laneRuntime?.finishTask?.('memory', 'succeeded', {
            summary: '记忆表同步完成',
            output: {
              memoryResult,
              repairResult,
            },
          });
        }
        return repairResult;
      },
      (err) => {
        logger?.warn?.('memory update before timeline auto repair failed', err);
        if (active && track && isRunCurrent()) {
          laneRuntime?.failTask?.('memory', err);
        }
        throw err;
      },
    );
    if (active && track) {
      memoryTask = task;
    }
    return task;
  };

  const afterSendSucceeded = ({ imagePromptScheduled = false } = {}) => {
    if (!active) return;
    if (imagePromptScheduled) {
      laneRuntime?.finishTask?.('image', 'succeeded', {
        summary: '图片提示词已进入生成队列',
      });
    } else {
      laneRuntime?.finishTask?.('image', 'skipped', {
        summary: '本次未触发图片提示词任务',
      });
    }
    if (!isTaskTerminal('variable')) {
      laneRuntime?.finishTask?.('variable', 'skipped', {
        summary: '本次未触发变量更新',
      });
    }
    if (!isTaskTerminal('profile')) {
      laneRuntime?.finishTask?.('profile', 'skipped', {
        summary: '本次未触发画像任务',
      });
    }
    const completeRun = () => {
      if (!isRunCurrent()) return;
      // 生图等异步任务可能仍在跑：全部终态才收尾，未完成的由对应任务完成时补收尾。
      completeIfIdle();
    };
    if (memoryTask?.then) {
      memoryTask.then(completeRun, () => {});
    } else {
      completeRun();
    }
  };

  const afterSendFailed = ({ interrupted = false, message = '' } = {}) => {
    if (!active) return;
    if (interrupted) {
      laneRuntime?.cancelRun?.('interrupted');
    } else {
      laneRuntime?.failRun?.(message || '发送失败');
    }
  };

  return {
    isActive: () => active,
    getMemoryPhase,
    start,
    modelRequested,
    modelStreaming,
    modelBuffered,
    modelDone,
    variableApplied,
    runMemoryTask,
    afterSendSucceeded,
    afterSendFailed,
  };
};
