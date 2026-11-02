// 可撤销的删除（自定义工具「删除回复」「撤回我的消息」）：先暂存再清理，撤销走正式的恢复流程。
// - 整条删除：删除前暂存讯息（含从档案读回的原始回复）与前一条讯息的 id；长字段的旁挂分片会随删除清掉，
//   所以暂存拿掉 fieldRefs、插回时重写（字段只有预览、没读回全文时不提供撤销）；回合检查点先不清
//   （记忆快照因此仍被引用），撤销期过后才清。撤销＝插回原位，再按尾端讯息与它的检查点恢复记忆与变量。
// - 分支删除：删除前以存着的当前分支为准（讯息上的正文可能只是预览），补上此刻的记忆／变量状态存成副本；撤销＝插回原位并切回去，
//   走正式的切换分支流程（会存下切离分支的状态、套用切回分支的状态、重新同步检查点）。
// 撤销期间切换会话、尾端变了（例如发了新消息）或过期，就确定删除、不能再撤销。

export const DELETE_UNDO_WINDOW_MS = 10000;

const cloneValue = (value) => {
  try { return globalThis.structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
};
const idOf = value => String(value?.id ?? '').trim();
// 长字段在内存里应是全文（读分片时已读回）；只剩预览就无法完整插回
const hasFullFields = (message) => {
  const refs = message?.fieldRefs;
  if (!refs || typeof refs !== 'object') return true;
  return Object.entries(refs).every(([field, ref]) => typeof message[field] === 'string' && message[field] !== ref?.preview);
};

/**
 * deps：chatStore、ui（removeMessage／deleteCurrentSwipe／_applySwipe）、findMessageWrapper(id)、
 * beforeChange(sid)（例如先中止进行中的创意写作轮次，和长按菜单的删除一样）、
 * isTableMemory(sid)／abortMemoryUpdate(sid)、getReplyTarget(sid)／clearReplyTarget(sid)、
 * removeTurnCheckpoints(sid, messages, { prune })、restoreMemory(sid, options)、restoreVariables(sid)、
 * buildBranchFromMessage(message)（当前分支的内容、原始回复、推理等）、
 * captureBranchState(sid, branches, index)（把此刻的记忆／变量状态存进 branches[index]）、rerender()、refresh()。
 */
export const createUndoableMessageDelete = ({
  chatStore,
  ui,
  findMessageWrapper = () => null,
  beforeChange = async () => {},
  isTableMemory = () => false,
  abortMemoryUpdate = () => {},
  getReplyTarget = () => null,
  clearReplyTarget = () => {},
  removeTurnCheckpoints = async () => false,
  restoreMemory = async () => false,
  restoreVariables = async () => false,
  buildBranchFromMessage = message => ({ content: message?.content }),
  captureBranchState = async () => {},
  rerender = () => {},
  refresh = () => {},
  logger = null,
} = {}) => {
  const warn = label => (error) => { logger?.warn?.(label, error); };
  const tailId = sid => idOf((chatStore.getMessages(sid) || []).at(-1));
  const loadRaw = async (sid, message) => {
    if (message?.role !== 'assistant') return '';
    try {
      const raw = await chatStore.loadRawOriginal?.(message, sid);
      return typeof raw === 'string' ? raw : '';
    } catch {
      return '';
    }
  };

  /** 整条删除（AI 回复或自己的消息）。第一条讯息（前面没有讯息又不是唯一一条）无法按原位插回，不提供撤销。 */
  const deleteMessage = async (sid, message) => {
    const id = idOf(message);
    const messages = chatStore.getMessages(sid) || [];
    const index = messages.findIndex(item => idOf(item) === id);
    if (index < 0) return { ok: false, reason: 'missing' };
    await beforeChange(sid);
    const stored = messages[index];
    const anchorId = index > 0 ? idOf(messages[index - 1]) : '';
    const undoable = (index > 0 || messages.length === 1) && hasFullFields(stored);
    const snapshot = cloneValue(stored);
    delete snapshot.fieldRefs;
    const raw = await loadRaw(sid, stored);
    if (raw) snapshot.rawOriginal = raw;
    const unreadBefore = Number(chatStore.getUnreadCount?.(sid) || 0);
    const replyTarget = getReplyTarget(sid);
    if (isTableMemory(sid)) {
      try { abortMemoryUpdate(sid); } catch (error) { warn('abort memory update before delete failed')(error); }
    }
    chatStore.deleteMessage(id, sid);
    ui.removeMessage?.(id);
    if (idOf(replyTarget) === id) clearReplyTarget(sid);
    if (!undoable) await removeTurnCheckpoints(sid, [stored], { prune: true }).catch(warn('remove turn checkpoint after delete failed'));
    await restoreMemory(sid, { refreshBaselineWhenNoTail: false, source: 'delete_message' }).catch(warn('restore memory after delete failed'));
    await restoreVariables(sid).catch(warn('restore variables after delete failed'));
    refresh();
    const tailAfter = tailId(sid);
    let settled = !undoable;
    return {
      ok: true,
      kind: 'message',
      role: stored.role,
      sessionId: sid,
      undoable,
      commit: async () => {
        if (settled) return;
        settled = true;
        await removeTurnCheckpoints(sid, [stored], { prune: true }).catch(warn('remove turn checkpoint after delete failed'));
      },
      undo: async () => {
        if (settled) return { ok: false, reason: 'expired' };
        if (chatStore.findMessage(id, sid)) return { ok: false, reason: 'exists' };
        if (tailId(sid) !== tailAfter || (anchorId && !chatStore.findMessage(anchorId, sid))) return { ok: false, reason: 'changed' };
        settled = true;
        chatStore.insertMessageAfter(anchorId, snapshot, sid);
        if (stored.role === 'assistant' && unreadBefore === 0) chatStore.markRead?.(sid);
        await restoreMemory(sid, { refreshBaselineWhenNoTail: false, source: 'undo_delete_message' }).catch(warn('restore memory after undo failed'));
        await restoreVariables(sid).catch(warn('restore variables after undo failed'));
        rerender(sid);
        refresh();
        return { ok: true };
      },
    };
  };

  /** 删除 AI 回复的当前分支（有多个分支时）。 */
  const deleteBranch = async (sid, message) => {
    const id = idOf(message);
    const stored = chatStore.findMessage(id, sid) || message;
    const swipes = Array.isArray(stored?.meta?.swipes) ? stored.meta.swipes : [];
    if (swipes.length < 2) return { ok: false, reason: 'single' };
    await beforeChange(sid);
    const activeIndex = Math.min(Math.max(0, Math.trunc(Number(stored.meta.activeSwipe)) || 0), swipes.length - 1);
    const branches = swipes.map(branch => ({ ...(branch && typeof branch === 'object' ? branch : {}) }));
    const raw = await loadRaw(sid, stored);
    // 存着的分支优先（编辑原回复时会同步写回分支）；讯息上的字段只补分支缺的
    branches[activeIndex] = { ...buildBranchFromMessage(raw ? { ...stored, rawOriginal: raw } : stored), ...branches[activeIndex] };
    try { await captureBranchState(sid, branches, activeIndex); } catch (error) { warn('capture branch state before delete failed')(error); }
    const captured = cloneValue(branches[activeIndex]);
    const result = ui.deleteCurrentSwipe?.(id);
    if (!result?.deleted) return { ok: false, reason: result?.reason || 'not_deleted' };
    const countAfter = Array.isArray(result.message?.meta?.swipes) ? result.message.meta.swipes.length : swipes.length - 1;
    const tailAfter = tailId(sid);
    let settled = false;
    return {
      ok: true,
      kind: 'branch',
      role: 'assistant',
      sessionId: sid,
      undoable: true,
      commit: async () => { settled = true; },
      undo: async () => {
        if (settled) return { ok: false, reason: 'expired' };
        const wrapper = findMessageWrapper(id);
        const live = wrapper?.__chatappMessage;
        const current = Array.isArray(live?.meta?.swipes) ? live.meta.swipes : null;
        if (tailId(sid) !== tailAfter || !live || !current || current.length !== countAfter) return { ok: false, reason: 'changed' };
        settled = true;
        const nextSwipes = [...current];
        nextSwipes.splice(result.deletedIndex, 0, captured);
        const active = Math.trunc(Number(live.meta.activeSwipe)) || 0;
        live.meta = { ...live.meta, swipes: nextSwipes, activeSwipe: active >= result.deletedIndex ? active + 1 : active };
        wrapper.__chatappMessage = live;
        return ui._applySwipe?.(wrapper, live, result.deletedIndex) === true ? { ok: true } : { ok: false, reason: 'apply_failed' };
      },
    };
  };

  return {
    /** 快速删除的语义：有多个分支删当前分支，否则删整条。 */
    deleteReply: (sid, message) => {
      const stored = chatStore.findMessage(idOf(message), sid) || message;
      return (Array.isArray(stored?.meta?.swipes) && stored.meta.swipes.length > 1) ? deleteBranch(sid, stored) : deleteMessage(sid, stored);
    },
    deleteMessage,
    deleteBranch,
  };
};

/** 同一时间只留一个可撤销的删除：新的进来、过期或切换会话时，旧的就确定删除。 */
export const createPendingUndo = ({ windowMs = DELETE_UNDO_WINDOW_MS, schedule = (fn, ms) => setTimeout(fn, ms), cancel = timer => clearTimeout(timer) } = {}) => {
  let pending = null;
  const commitPending = async () => {
    if (!pending) return false;
    const entry = pending;
    pending = null;
    cancel(entry.timer);
    await entry.commit();
    entry.onSettled?.('committed');
    return true;
  };
  return {
    stage: async (entry) => {
      await commitPending();
      pending = { ...entry, timer: schedule(() => { void commitPending(); }, windowMs) };
      return pending;
    },
    undo: async () => {
      if (!pending) return { ok: false, reason: 'expired' };
      const entry = pending;
      pending = null;
      cancel(entry.timer);
      const result = await entry.undo();
      if (!result?.ok) await entry.commit();
      entry.onSettled?.(result?.ok ? 'undone' : 'committed');
      return result || { ok: false, reason: 'failed' };
    },
    commitPending,
    hasPending: (sessionId = '') => Boolean(pending && (!sessionId || pending.sessionId === sessionId)),
  };
};
