// 导出／导入聊天记录时的「附加数据」与存档的绑定（记忆表格、变量）。
// 存档加载时由存档指针还原记忆与变量（见 app.js restoreArchivePointerForLoadedThread）：
// - 导出某份存档：读它的存档指针所指的记忆快照与变量快照，也就是加载它时会还原的状态；
// - 导入为新存档：把文件里的记忆表格与变量存成快照，并为新存档写一个存档指针（尾部 AI 消息 + 两个快照），
//   之后加载这份存档就走与平常存档相同的还原流程。
// 只在启用回合检查点（记忆模式为「表格」）的会话有效；其余情况返回 null／false，不做任何写入。

const findTailAssistant = (messages = []) => {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    if (message?.role === 'assistant' && !message?.meta?.isGreeting) return message;
  }
  return null;
};

// 切走存档时存档指针要记的变量快照（加载回来时据此还原变量）：
// 优先用尾部 AI 消息当前分支已存的变量快照；没有（如导入的存档、没有 AI 回复）就记下此刻的会话变量；
// 会话没有任何变量活动时不记（加载时变量不变）。
export const resolveArchivePointerVariableSnapshotId = async ({
  sessionId = '',
  branch = null,
  meta = null,
  isActive = () => false,
  buildSnapshot = async () => null,
  persistSnapshot = async () => null,
} = {}) => {
  const existing = String(branch?.variableSnapshotId || meta?.variableSnapshotId || '').trim();
  if (existing) return existing;
  if (!isActive()) return '';
  const snapshot = await buildSnapshot(sessionId);
  if (!snapshot) return '';
  const persisted = await persistSnapshot(sessionId, snapshot);
  return String(persisted?.id || '').trim();
};

export const createArchiveTransferStateRuntime = ({
  isEnabled = () => false,
  turnCheckpointStore = null,
  memorySnapshotStore = null,
  variableSnapshotStore = null,
  buildMemorySnapshot = async () => null,
  listArchiveMessages = async () => [],
  refreshReachability = async () => {},
  now = () => Date.now(),
} = {}) => ({
  // 返回 { memoryTable: { templateId, rows } | null, variables: object | null }；没有存档指针时为 null。
  async readArchiveTransferState(sessionId, archiveId) {
    const sid = String(sessionId || '').trim();
    const aid = String(archiveId || '').trim();
    if (!sid || !aid || !isEnabled(sid)) return null;
    const pointer = await turnCheckpointStore?.getArchivePointer?.(sid, aid);
    if (!pointer) return null;
    let memoryTable = null;
    const memorySnapshotId = String(pointer.memorySnapshotId || '').trim();
    if (memorySnapshotId) {
      const snapshot = await memorySnapshotStore?.getSnapshot?.(memorySnapshotId);
      if (snapshot) memoryTable = { templateId: String(snapshot.templateId || ''), rows: Array.isArray(snapshot.rows) ? snapshot.rows : [] };
    }
    let variables = null;
    const variableSnapshotId = String(pointer.variableSnapshotId || '').trim();
    if (variableSnapshotId) {
      const snapshot = await variableSnapshotStore?.getSnapshot?.(variableSnapshotId);
      if (snapshot?.variables && typeof snapshot.variables === 'object') variables = snapshot.variables;
    }
    return { memoryTable, variables };
  },

  // memoryTable 为 null 时记忆快照用空表（加载时清空表格）；variables 为 null 时不记变量（加载时变量不变）。
  async bindImportedArchiveState(sessionId, archiveId, { memoryTable = null, variables = null } = {}) {
    const sid = String(sessionId || '').trim();
    const aid = String(archiveId || '').trim();
    const result = { memory: false, variables: false };
    if (!sid || !aid || !isEnabled(sid)) return result;
    const tail = findTailAssistant(await listArchiveMessages(sid, aid));
    const memorySnapshot = await buildMemorySnapshot({
      sessionId: sid,
      templateId: String(memoryTable?.templateId || ''),
      rows: Array.isArray(memoryTable?.rows) ? memoryTable.rows : [],
    });
    const persistedMemory = memorySnapshot ? await memorySnapshotStore?.persistSnapshot?.(sid, memorySnapshot) : null;
    const memorySnapshotId = String(persistedMemory?.id || '').trim();
    let variableSnapshotId = '';
    if (variables && typeof variables === 'object') {
      const persistedVariables = await variableSnapshotStore?.persistSnapshot?.(sid, { scope: 'session', variables, capturedAt: now() });
      variableSnapshotId = String(persistedVariables?.id || '').trim();
    }
    if (!memorySnapshotId && !variableSnapshotId) return result;
    await turnCheckpointStore?.setArchivePointer?.(sid, aid, {
      sessionId: sid,
      archiveId: aid,
      tailAssistantMessageId: String(tail?.id || ''),
      tailSwipeIndex: 0,
      memorySnapshotId,
      variableSnapshotId,
      restoredAt: now(),
      source: 'conversation_import',
    });
    await refreshReachability(sid);
    result.memory = Boolean(memorySnapshotId);
    result.variables = Boolean(variableSnapshotId);
    return result;
  },
});
