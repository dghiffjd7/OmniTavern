// 记忆总览的装配：读取整张卡的记忆与当前会话状态、记忆管家、页面，以及在页内打开聊天室表格。
// app.js 只注入资料来源与各主界面的入口。
import { MemoryTableEditor } from './memory-table-editor.js';
import { resolveDefaultMemoryTemplateRecordAndDefinition } from './session-memory-table-utils.js';
import { summarizeCardMemory, summarizeSessionMemory, memoryRoomEditorContext } from '../memory/memory-overview-model.js';
import { createMemoryAuditAgent } from '../agent/memory-audit-agent.js';
import { createMemoryOverviewPanel } from './memory-overview-panel.js';

const trim = value => String(value ?? '').trim();

/** 打开另一个主界面后，把指定位置卷到可见处（界面要先渲染一帧）。 */
export const revealWhenShown = (documentRef, selector, { before = null } = {}) => {
  const run = () => {
    try { before?.(); } catch {}
    documentRef?.querySelector?.(selector)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  const raf = globalThis.requestAnimationFrame;
  if (typeof raf === 'function') raf(() => raf(run));
  else setTimeout(run, 50);
};

export const createMemoryOverviewRuntime = ({
  documentRef = globalThis.document,
  memoryTableStore,
  memoryTemplateStore,
  contactsStore = null,
  chatStore = null,
  agentTaskRuntime = null,
  getSessionId = () => '',
  isGroupSession = () => false,
  getCardName = () => '',
  getSessionLabel = sessionId => sessionId,
  // 'chat'／'writing'：当前所在位置，决定记忆模式与自动写表开关
  getMemoryPlace = () => 'chat',
  getStorageMode = () => 'table',
  isAutoWriteEnabled = () => false,
  getAutoWriteMode = () => 'inline',
  listPending = () => [],
  getLastMemoryPlan = () => null,
  openTemplates = null,
  openShare = null,
  openAutoWriteSettings = null,
  openPending = null,
} = {}) => {
  const load = async () => {
    const sessionId = trim(getSessionId());
    const resolved = await resolveDefaultMemoryTemplateRecordAndDefinition({ memoryTemplateStore });
    const templateId = trim(resolved?.record?.id) || 'default-v1';
    const rows = await memoryTableStore.getMemories({});
    const place = getMemoryPlace();
    const session = summarizeSessionMemory({
      sessionId,
      isGroup: sessionId ? isGroupSession(sessionId) === true : false,
      plan: getLastMemoryPlan(),
      storageMode: getStorageMode(place),
      autoWrite: { enabled: isAutoWriteEnabled(place) === true, mode: getAutoWriteMode() },
      pending: listPending(),
    });
    return {
      rows: Array.isArray(rows) ? rows : [],
      templateId,
      template: resolved?.template || null,
      session,
      card: summarizeCardMemory({ rows, templateId }),
      cardName: trim(getCardName()),
      templateName: trim(resolved?.record?.name),
      sessionName: sessionId ? trim(getSessionLabel(sessionId)) : '',
    };
  };

  const audit = createMemoryAuditAgent({ agentTaskRuntime, collect: load });

  const panel = createMemoryOverviewPanel({
    documentRef,
    load,
    roomName: room => trim(getSessionLabel(room?.sessionId)) || trim(room?.key),
    mountRoomEditor: (container, room) => {
      const editor = new MemoryTableEditor({
        container,
        getContext: () => memoryRoomEditorContext(room),
        memoryStore: memoryTableStore,
        templateStore: memoryTemplateStore,
        contactsStore,
        chatStore,
        includeGlobal: true,
      });
      void editor.render();
      return { destroy: () => editor.destroy() };
    },
    runAudit: options => audit.auditMemory({ ...options, source: 'memory-overview' }),
    openTemplates,
    openShare,
    openAutoWriteSettings,
    openPending,
  });

  return { panel, audit, load };
};
