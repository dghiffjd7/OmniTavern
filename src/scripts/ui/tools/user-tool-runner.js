// 用户工具的统一执行入口：触发（工具箱／快捷键／手势）→ 找工具与动作 → 确定目标消息并记下快照
// → 需要时确认 → 执行前复核快照（聊天、消息、分支、正文都没变）→ 执行 → 统一结果。
// 结果：succeeded／cancelled／unavailable（条件不满足）／stale（对象已变化，没执行）／failed。
import { t } from '../../i18n/index.js';
import { normalizeToolParams } from './user-tool-actions.js';
import { toolShortcutFromEvent } from '../../storage/user-tool-store.js';

const trim = value => String(value ?? '').trim();
const RESULT_STATUSES = new Set(['succeeded', 'cancelled', 'unavailable', 'stale', 'failed']);

const snapshotOf = (sessionId, message) => (message
  ? { sessionId, messageId: trim(message.id), role: message.role, activeSwipe: Number(message.meta?.activeSwipe || 0), content: String(message.content ?? '') }
  : { sessionId, messageId: '' });

/**
 * resolveAction(source, id) → 动作说明；execute(action, context) → 结果。
 * findMessage(sessionId, id)／findLastMessage(sessionId, role) 读当前会话；confirm({title,message}) → 是否继续；
 * notify(result) 由调用方决定怎么提示（cancelled 一般不提示）。
 */
export const createUserToolRunner = ({
  store,
  resolveAction = () => null,
  execute = async () => ({ status: 'succeeded' }),
  getSessionId = () => '',
  findMessage = () => null,
  findLastMessage = () => null,
  confirm = async () => true,
  notify = () => {},
  logger = null,
} = {}) => {
  const running = new Set();

  const isCurrent = (snapshot) => {
    if (getSessionId() !== snapshot.sessionId) return false;
    if (!snapshot.messageId) return true;
    const message = findMessage(snapshot.sessionId, snapshot.messageId);
    return Boolean(message)
      && message.role === snapshot.role
      && Number(message.meta?.activeSwipe || 0) === snapshot.activeSwipe
      && String(message.content ?? '') === snapshot.content;
  };

  /** 目标消息：有指定（手势）就用它，否则取该角色最后一条。 */
  const resolveTarget = (action, sessionId, messageId = '') => {
    if (action.target === 'none') return { ok: true, message: null };
    const role = action.target === 'any' ? '' : action.target;
    if (messageId) {
      const message = findMessage(sessionId, messageId);
      if (!message) return { ok: false, status: 'stale', message: '这条消息已经不在了' };
      if (role && message.role !== role) return { ok: false, status: 'unavailable', message: role === 'assistant' ? '这个工具只能用在 AI 回复上' : '这个工具只能用在自己的消息上' };
      return { ok: true, message };
    }
    const fallbackRole = role || action.defaultTarget || 'assistant';
    const message = findLastMessage(sessionId, fallbackRole);
    if (!message) return { ok: false, status: 'unavailable', message: fallbackRole === 'assistant' ? '还没有可用的 AI 回复' : '还没有自己发的消息' };
    return { ok: true, message };
  };

  const run = async (toolId, { messageId = '', trigger = 'toolbox', selection = '' } = {}) => {
    const tool = store?.getTool?.(toolId) || null;
    const finish = (result) => {
      const status = RESULT_STATUSES.has(result?.status) ? result.status : 'succeeded';
      const out = { ...result, status, toolId: tool?.id || trim(toolId), toolName: tool?.name || '', trigger };
      try { notify(out); } catch {}
      return out;
    };
    if (!tool) return finish({ status: 'unavailable', message: '找不到这个工具' });
    if (running.has(tool.id)) return { status: 'cancelled', reason: 'already_running', toolId: tool.id };
    const action = resolveAction(tool.action.source, tool.action.id);
    if (!action) return finish({ status: 'unavailable', message: '这个工具要执行的动作已经不在了，请重新选择' });
    const sessionId = trim(getSessionId());
    if (!sessionId) return finish({ status: 'unavailable', message: '先进入一个聊天再用' });
    const target = resolveTarget(action, sessionId, trim(messageId));
    if (!target.ok) return finish({ status: target.status, message: target.message });
    const params = normalizeToolParams(action, tool.action.params);
    if (!params.ok) return finish({ status: 'unavailable', message: params.error });
    const snapshot = snapshotOf(sessionId, target.message);
    running.add(tool.id);
    try {
      if (action.effect === 'destructive' && !(action.directable && tool.direct)) {
        const ok = await confirm({ title: tool.name, message: action.confirm || t('执行「{name}」？', { name: tool.name }), danger: true });
        if (!ok) return finish({ status: 'cancelled' });
      }
      if (!isCurrent(snapshot)) return finish({ status: 'stale', message: '聊天、消息或分支已经变了，没有执行' });
      const message = snapshot.messageId ? findMessage(sessionId, snapshot.messageId) : null;
      const result = await execute(action, { tool, action, params: params.params, message, sessionId, snapshot, trigger, selection: String(selection || '') });
      return finish(result || { status: 'succeeded' });
    } catch (error) {
      logger?.warn?.('user tool failed', error);
      return finish({ status: 'failed', message: String(error?.message || error) });
    } finally {
      running.delete(tool.id);
    }
  };

  return { run, resolveTarget, isRunning: id => running.has(trim(id)) };
};

/** 快捷键：document 捕获阶段比对（必须带 Ctrl／Alt／⌘）；isEnabled() 为 false 时（例如正在录快捷键）不触发。 */
export const bindUserToolShortcuts = ({ documentRef = globalThis.document, store, run, isEnabled = () => true } = {}) => {
  const onKeyDown = (event) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
    if (!(event.ctrlKey || event.altKey || event.metaKey)) return;
    const shortcut = toolShortcutFromEvent(event);
    const binding = shortcut ? store?.findShortcut?.(shortcut) : null;
    if (!binding || !isEnabled()) return;
    event.preventDefault();
    event.stopPropagation();
    void run(binding.toolId, { trigger: 'shortcut' });
  };
  documentRef?.addEventListener?.('keydown', onKeyDown, true);
  return () => documentRef?.removeEventListener?.('keydown', onKeyDown, true);
};
