// 内建动作的执行：全部接到 APP 已有的正式流程（消息动作分发、发送、继续、停止、切换分支、打开面板），
// 不模拟点按钮、不直接改聊天数组。依赖由 app.js 注入；各流程自己的提示（例如「已复制」）照常出现。

const ok = (message = '') => ({ status: 'succeeded', ...(message ? { message } : {}) });
const unavailable = message => ({ status: 'unavailable', message });

/**
 * deps：dispatchMessageAction(action, message, payload)（消息动作分发，长按菜单用的同一个）、startInlineEdit(message)、
 * continueReply() → false 表示没有可继续的、stopGeneration() → 是否停了、selectSwipe(sessionId, messageId, index)、
 * insertInput(text, { mode })、sendInput()、openPanel(id) → 是否打开、isGenerating()。
 * deleteReply(sessionId, message)／retractMessage(sessionId, message)：可撤销的删除（没提供时走消息动作分发）。
 */
export const createBuiltinToolExecutors = ({
  dispatchMessageAction = async () => true,
  startInlineEdit = () => false,
  continueReply = async () => false,
  stopGeneration = () => false,
  selectSwipe = () => false,
  insertInput = () => {},
  sendInput = () => {},
  openPanel = () => false,
  isGenerating = () => false,
  deleteReply = null,
  retractMessage = null,
} = {}) => {
  // 会请求模型或改消息的动作：正在生成时不执行
  const whenIdle = work => async (context) => (isGenerating() ? unavailable('正在生成，结束后再试') : work(context));
  const dispatch = action => async ({ message }) => {
    await dispatchMessageAction(action, message);
    return ok();
  };
  const swipe = delta => whenIdle(async ({ message, sessionId }) => {
    const swipes = Array.isArray(message?.meta?.swipes) ? message.meta.swipes : [];
    if (swipes.length < 2) return unavailable('这条回复只有一个分支');
    const next = Number(message.meta?.activeSwipe || 0) + delta;
    if (next < 0) return unavailable('已经是第一个分支');
    if (next >= swipes.length) return unavailable('已经是最后一个分支');
    return (await selectSwipe(sessionId, message.id, next)) === false ? unavailable('现在切换不了分支') : ok();
  });
  return {
    'reply.regenerate': whenIdle(dispatch('regenerate')),
    'reply.continue': whenIdle(async () => ((await continueReply()) === false ? unavailable('没有可以继续的回复') : ok())),
    'reply.delete': whenIdle(async ({ message, sessionId }) => {
      if (deleteReply) return deleteReply(sessionId, message);
      return (await dispatchMessageAction('quick-delete', message)) === false ? unavailable('没有删除') : ok();
    }),
    'reply.swipe_prev': swipe(-1),
    'reply.swipe_next': swipe(1),
    'reply.stop': async () => ((await stopGeneration()) ? ok() : unavailable('现在没有在生成')),
    'message.edit': async ({ message }) => {
      if (message.role === 'user') return (await startInlineEdit(message)) === false ? unavailable('这条消息现在不能编辑') : ok();
      await dispatchMessageAction('view-code', message);
      return ok();
    },
    'message.restart': whenIdle(dispatch('regenerate')),
    'message.retract': async ({ message, sessionId }) => (retractMessage ? retractMessage(sessionId, message) : dispatch('retract')({ message })),
    'text.copy': dispatch('copy-text'),
    'text.phrase': async ({ params }) => {
      if (params.send && isGenerating()) return unavailable('正在生成，结束后再试');
      await insertInput(params.text, { mode: params.mode });
      if (params.send) await sendInput();
      return ok();
    },
    'text.speak': dispatch('speak'),
    'open.panel': async ({ params }) => ((await openPanel(params.panel)) === false ? unavailable('这个功能现在打不开') : ok()),
  };
};
