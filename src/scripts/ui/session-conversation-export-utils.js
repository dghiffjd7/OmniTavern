import {
  buildConversationExportFilename,
  exportConversationTextFile,
  formatConversationExport,
} from './chat/conversation-export-utils.js';
import { t } from '../i18n/index.js';

// 创意写作会话导出为 rp，其余（私聊、群聊）为 chat；写入导出标记，导入时据此提醒模式是否相符。
export const resolveConversationExportSessionMode = sessionId => (
  String(sessionId || '').trim().startsWith('rp:') ? 'rp' : 'chat'
);

const cloneMessages = messages => (
  Array.isArray(messages)
    ? messages.map(message => (message && typeof message === 'object' ? { ...message } : message)).filter(Boolean)
    : []
);

export const loadConversationExportMessages = async ({
  chatStore = null,
  sessionId = '',
  archiveId = '',
  current = false,
} = {}) => {
  const sid = String(sessionId || '').trim();
  if (!chatStore || !sid) return [];
  const aid = current
    ? String(chatStore.getCurrentArchiveId?.(sid) || '').trim()
    : String(archiveId || '').trim();
  let messages = [];
  if (typeof chatStore.exportThreadMessages === 'function') {
    messages = await chatStore.exportThreadMessages(sid, aid);
  }
  if (current && (!Array.isArray(messages) || !messages.length)) {
    messages = chatStore.getMessages?.(sid) || [];
  }
  const out = cloneMessages(messages);
  if (typeof chatStore.prefetchRawOriginalsForMessages === 'function') {
    try {
      await chatStore.prefetchRawOriginalsForMessages(out, sid, { limit: out.length });
    } catch {}
  }
  return out;
};

// 完整导出的附加数据（记忆表格、摘要、变量）。当前聊天与当前已加载的存档取实际状态；
// 其他存档取它的存档指针所指的快照（即加载它时会还原的状态），没有指针时退回存档里存的记忆表格快照。
export const loadConversationExportState = async ({
  chatStore = null,
  sessionId = '',
  archive = null,
  current = false,
  buildMemoryTableSnapshot = async () => null,
  readArchiveState = async () => null,
} = {}) => {
  const sid = String(sessionId || '').trim();
  if (!chatStore || !sid) return null;
  const archiveId = String(archive?.id || '').trim();
  const live = current || (archiveId && archiveId === String(chatStore.getCurrentArchiveId?.(sid) || '').trim());
  if (live) {
    return {
      memoryTable: await buildMemoryTableSnapshot({ sessionId: sid }),
      summaries: chatStore.getSummaries?.(sid) || [],
      compactedSummary: chatStore.getCompactedSummary?.(sid) || null,
      variables: chatStore.listVariables?.(sid) || null,
    };
  }
  const pointerState = await readArchiveState(sid, archiveId);
  return {
    memoryTable: pointerState?.memoryTable || archive?.memoryTableSnapshot || null,
    summaries: Array.isArray(archive?.summaries) ? archive.summaries : [],
    compactedSummary: archive?.compactedSummary || null,
    variables: pointerState?.variables || null,
  };
};

export const runSessionConversationExportFlow = async ({
  chatStore = null,
  sessionId = '',
  archive = null,
  current = false,
  title = '',
  sourceLabel = '',
  openExportDialog = null,
  loadState = async () => null,
  exportTextFile = exportConversationTextFile,
  now = () => new Date(),
  toastSuccess = null,
  toastWarning = null,
  toastError = null,
  logger = console,
} = {}) => {
  const sid = String(sessionId || '').trim();
  if (!chatStore || !sid) return false;
  const archiveId = String(archive?.id || '').trim();
  const displayTitle = String(title || (current ? '当前聊天' : archive?.name) || sid || '聊天记录').trim();
  let messages = [];
  try {
    messages = await loadConversationExportMessages({ chatStore, sessionId: sid, archiveId, current });
  } catch (err) {
    logger?.warn?.('load conversation export messages failed', err);
    toastError?.('导出失败，请检查控制台');
    return false;
  }
  if (!messages.length) {
    toastWarning?.('没有可导出的聊天记录');
    return false;
  }
  const resolvedSourceLabel = sourceLabel || (current ? '当前聊天' : `存档：${archive?.name || archiveId || '未命名存档'}`);
  const sessionMode = resolveConversationExportSessionMode(sid);
  const exportWith = async ({ mode, format }) => {
    let state = null;
    if (mode === 'full') {
      try {
        state = await loadState();
      } catch (err) {
        logger?.warn?.('load conversation export state failed', err);
        toastWarning?.(t('记忆表格、摘要、变量读取失败，这次只导出聊天内容'));
      }
    }
    try {
      const exportedAt = now();
      const text = formatConversationExport({
        messages,
        title: displayTitle,
        sourceLabel: resolvedSourceLabel,
        mode,
        format,
        exportedAt,
        sessionMode,
        state,
      });
      const filename = buildConversationExportFilename({ title: displayTitle, mode, format, now: exportedAt });
      const saved = await exportTextFile({
        text,
        filename,
        format,
        onSuccess: message => toastSuccess?.(message),
      });
      return saved === true;
    } catch (err) {
      logger?.warn?.('export conversation failed', err);
      toastError?.('导出失败，请检查控制台');
      return false;
    }
  };
  if (typeof openExportDialog !== 'function') return false;
  const result = await openExportDialog({
    subtitle: t('{title} · {count} 条', { title: displayTitle, count: messages.length }),
    buildFilename: (mode, format) => buildConversationExportFilename({ title: displayTitle, mode, format, now: now() }),
    onExport: exportWith,
  });
  return result?.exported === true;
};
