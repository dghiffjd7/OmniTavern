import {
  buildImportedConversationMessages,
  CONVERSATION_IMPORT_MAX_CHARS,
  parseConversationExport,
} from './chat/conversation-import-utils.js';
import { t } from '../i18n/index.js';
import { resolveConversationExportSessionMode } from './session-conversation-export-utils.js';

export const CONVERSATION_IMPORT_ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain';

export const isConversationImportFileName = name => /\.(md|markdown|txt)$/i.test(String(name || '').trim());

const parseErrorText = error => ({
  too_large: t('文件太大，最多 20MB'),
  empty: t('文件是空的'),
  no_messages: t('文件里没有找到消息'),
}[error] || t('无法识别这个文件：只支持本 APP 导出的 md／txt 聊天记录'));

// 默认存档名：文件里的标题（导出时的存档名）；标题只是「当前聊天／当前群聊」时改用文件名。
export const buildConversationImportArchiveName = ({ title = '', fileName = '' } = {}) => {
  const cleanTitle = String(title || '').trim();
  const stem = String(fileName || '').trim().replace(/\.(md|markdown|txt)$/i, '').replace(/-(full|body)-\d{8,14}$/i, '');
  const name = cleanTitle && !['当前聊天', '当前群聊', '聊天记录'].includes(cleanTitle) ? cleanTitle : (stem || cleanTitle || t('聊天记录'));
  return t('导入：{name}', { name });
};

// 文件带来的附加数据能不能用：记忆表格要「表格」记忆模式且模板相同；变量要「表格」模式（存档切换才会还原变量）；
// 摘要总能存进存档。每项 { count, usable, reason }，count 为 0 表示文件里没有。
export const describeConversationImportState = ({ state = null, templateId = '', tableMode = false } = {}) => {
  const memoryRows = state?.memoryTable?.rows?.length || 0;
  const templateMatches = Boolean(templateId) && String(state?.memoryTable?.templateId || '') === String(templateId);
  const summaryCount = (state?.summaries?.length || 0) + (state?.compactedSummary ? 1 : 0);
  const variableCount = state?.variables ? Object.keys(state.variables).length : 0;
  return {
    memory: {
      count: memoryRows,
      usable: memoryRows > 0 && tableMode && templateMatches,
      reason: !memoryRows ? '' : (!tableMode ? 'mode' : (templateMatches ? '' : 'template')),
    },
    summaries: { count: summaryCount, usable: summaryCount > 0, reason: '' },
    variables: {
      count: variableCount,
      usable: variableCount > 0 && tableMode,
      reason: variableCount && !tableMode ? 'mode' : '',
    },
  };
};

// 选文件／拖入文件 → 解析 → 预览对话框 → 存成新存档（不切换当前聊天）。
// 勾选的附加数据：摘要写进新存档；记忆表格与变量经 bindImportedState 绑定到新存档的存档指针，加载时还原。
// 对话框关闭后调用 onImported（刷新存档列表）；点了「立即加载」再用 loadArchive 加载。返回新存档 id，未导入为 ''。
export const runSessionConversationImportFlow = async ({
  file = null,
  chatStore = null,
  sessionId = '',
  resolveMemoryTemplateId = async () => '',
  getMemoryStorageMode = () => 'off',
  bindImportedState = async () => null,
  openImportDialog = null,
  onImported = null,
  loadArchive = null,
  now = () => Date.now(),
  toastWarning = null,
  toastError = null,
  logger = console,
} = {}) => {
  const sid = String(sessionId || '').trim();
  if (!file || !chatStore || !sid || typeof openImportDialog !== 'function') return '';
  if (!isConversationImportFileName(file.name)) {
    toastWarning?.(t('只支持 md／txt 文件'));
    return '';
  }
  if (Number(file.size) > CONVERSATION_IMPORT_MAX_CHARS * 4) {
    toastError?.(parseErrorText('too_large'));
    return '';
  }
  let text = '';
  try {
    text = await file.text();
  } catch (err) {
    logger?.warn?.('read conversation import file failed', err);
    toastError?.(t('读取文件失败'));
    return '';
  }
  const parsed = parseConversationExport(text);
  if (!parsed.ok) {
    toastError?.(parseErrorText(parsed.error));
    return '';
  }
  const sessionMode = resolveConversationExportSessionMode(sid);
  let templateId = '';
  try {
    templateId = String(await resolveMemoryTemplateId?.() || '').trim();
  } catch {}
  const tableMode = String(getMemoryStorageMode?.() || '').toLowerCase() === 'table';
  const stateInfo = describeConversationImportState({ state: parsed.state, templateId, tableMode });
  const result = await openImportDialog({
    fileName: String(file.name || ''),
    parsed,
    sessionMode,
    stateInfo,
    defaultName: buildConversationImportArchiveName({ title: parsed.title, fileName: file.name }),
    onImport: async ({ name, messages, include = {} }) => {
      try {
        const state = parsed.state || {};
        const useMemory = include.memory === true && stateInfo.memory.usable;
        const useSummaries = include.summaries === true && stateInfo.summaries.usable;
        const useVariables = include.variables === true && stateInfo.variables.usable;
        const memoryRows = useMemory ? state.memoryTable.rows : [];
        const archiveId = await chatStore.importMessagesAsArchive(sid, {
          name,
          messages: buildImportedConversationMessages(messages, { sessionMode, now: now() }),
          memoryTableSnapshot: templateId ? { templateId, rows: memoryRows } : null,
          summaries: useSummaries ? state.summaries : [],
          compactedSummary: useSummaries ? state.compactedSummary : null,
        });
        if (!archiveId) {
          toastError?.(t('导入失败'));
          return '';
        }
        if (useMemory || useVariables) {
          try {
            await bindImportedState(sid, archiveId, {
              memoryTable: useMemory ? { templateId, rows: memoryRows } : null,
              variables: useVariables ? state.variables : null,
            });
          } catch (err) {
            logger?.warn?.('bind imported archive state failed', err);
            toastWarning?.(t('聊天已导入，但记忆表格或变量没能绑定到新存档'));
          }
        }
        return archiveId;
      } catch (err) {
        logger?.warn?.('import conversation failed', err);
        toastError?.(t('导入失败，请检查控制台'));
        return '';
      }
    },
  });
  const archiveId = String(result?.archiveId || '');
  // 对话框关闭后再刷新存档列表，新存档行的强调才看得到。
  if (archiveId) onImported?.({ sessionId: sid, archiveId });
  if (archiveId && result?.load) {
    try {
      await loadArchive?.(archiveId);
    } catch (err) {
      logger?.warn?.('load imported archive failed', err);
      toastError?.(t('加载存档失败'));
    }
  }
  return archiveId;
};

// 打开系统选文件；选好后调用 onFile(file)。取消时不调用。
export const pickConversationImportFile = ({ documentRef = globalThis.document, onFile = null } = {}) => {
  const input = documentRef.createElement('input');
  input.type = 'file';
  input.accept = CONVERSATION_IMPORT_ACCEPT;
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0] || null;
    input.remove();
    if (file) onFile?.(file);
  }, { once: true });
  documentRef.body.appendChild(input);
  input.click();
  return input;
};

const hasDraggedFiles = event => Array.from(event?.dataTransfer?.types || []).includes('Files');

// 电脑上把 md／txt 拖到「聊天与存档」区域即可导入；拖动中区域加 is-drop-target。返回解除绑定的函数。
export const bindConversationImportDropZone = ({ zoneEl = null, onFile = null, isEnabled = () => true } = {}) => {
  if (!zoneEl?.addEventListener) return () => {};
  let depth = 0;
  const setActive = (on) => zoneEl.classList.toggle('is-drop-target', on);
  const onEnter = (event) => {
    if (!hasDraggedFiles(event) || !isEnabled()) return;
    event.preventDefault();
    depth += 1;
    setActive(true);
  };
  const onOver = (event) => {
    if (!hasDraggedFiles(event) || !isEnabled()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = (event) => {
    if (!hasDraggedFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) setActive(false);
  };
  const onDrop = (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    depth = 0;
    setActive(false);
    if (!isEnabled()) return;
    const file = event.dataTransfer?.files?.[0] || null;
    if (file) onFile?.(file);
  };
  zoneEl.addEventListener('dragenter', onEnter);
  zoneEl.addEventListener('dragover', onOver);
  zoneEl.addEventListener('dragleave', onLeave);
  zoneEl.addEventListener('drop', onDrop);
  return () => {
    zoneEl.removeEventListener('dragenter', onEnter);
    zoneEl.removeEventListener('dragover', onOver);
    zoneEl.removeEventListener('dragleave', onLeave);
    zoneEl.removeEventListener('drop', onDrop);
  };
};
