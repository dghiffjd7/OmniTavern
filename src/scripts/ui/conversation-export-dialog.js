// 导出聊天记录对话框：选「完整／正文」与「Markdown／TXT」，预览文件名，导出成功后按钮变「✓ 已导出」再关闭。
// 电脑为居中弹窗，手机（≤640px）为底部面板（可往下拖关闭）。实际导出由调用方的 onExport 完成。
import { t } from '../i18n/index.js';
import { bindSheetDragToDismiss } from './bottom-sheet-drag-utils.js';

export const CONVERSATION_EXPORT_PREFS_KEY = 'chatapp_conversation_export_prefs_v1';
export const CONVERSATION_TRANSFER_SHEET_QUERY = '(max-width: 640px)';
const DEFAULT_PREFS = Object.freeze({ mode: 'full', format: 'md' });
const DONE_HOLD_MS = 800;
const CLOSE_MS = 200;

export const readConversationExportPrefs = (storage) => {
  try {
    const parsed = JSON.parse(storage?.getItem?.(CONVERSATION_EXPORT_PREFS_KEY) || 'null');
    return {
      mode: parsed?.mode === 'body' ? 'body' : DEFAULT_PREFS.mode,
      format: parsed?.format === 'txt' ? 'txt' : DEFAULT_PREFS.format,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const writeConversationExportPrefs = (storage, { mode, format } = {}) => {
  try {
    storage?.setItem?.(CONVERSATION_EXPORT_PREFS_KEY, JSON.stringify({
      mode: mode === 'body' ? 'body' : 'full',
      format: format === 'txt' ? 'txt' : 'md',
    }));
    return true;
  } catch {
    return false;
  }
};

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  download: svg('<path d="M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  check: svg('<path d="m5 12 4.5 4.5L19 7"/>'),
};

const defaultStorage = () => {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
};

export const openConversationExportDialog = ({
  documentRef = globalThis.document,
  subtitle = '',
  buildFilename = () => '',
  onExport = async () => false,
  storage = defaultStorage(),
  isReducedMotion = () => false,
  isSheet = () => globalThis.matchMedia?.(CONVERSATION_TRANSFER_SHEET_QUERY)?.matches === true,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
} = {}) => new Promise((resolve) => {
  const state = { ...readConversationExportPrefs(storage), busy: false, exported: false, closed: false };
  const titleId = `ctd-export-title-${Date.now().toString(36)}`;
  const overlay = documentRef.createElement('div');
  overlay.className = 'ctd-overlay';
  const panel = documentRef.createElement('div');
  panel.className = `ctd-panel${isSheet() ? ' is-sheet' : ''}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', titleId);
  panel.tabIndex = -1;
  panel.innerHTML = `
    <span class="ctd-grabber" aria-hidden="true"></span>
    <header class="ctd-header">
      <span class="ctd-mark" aria-hidden="true">${ICONS.download}</span>
      <div class="ctd-heading">
        <h2 id="${titleId}" class="ctd-title">导出聊天记录</h2>
        <span class="ctd-subtitle" data-i18n-skip=""></span>
      </div>
      <button type="button" class="ctd-close" data-action="close" aria-label="关闭">${ICONS.close}</button>
    </header>
    <div class="ctd-body">
      <div class="ctd-field">
        <span class="ctd-label">内容</span>
        <div class="ctd-options" role="radiogroup" aria-label="导出内容">
          <button type="button" role="radio" class="ctd-option" data-mode="full" data-help="保留原文、格式标签与思考过程，之后可用「导入聊天记录」完整导回。" data-help-mode="press">
            <span class="ctd-radio" aria-hidden="true"></span>
            <span class="ctd-option-text">
              <span class="ctd-option-title">完整<span class="ctd-badge">可导回</span></span>
              <span class="ctd-option-desc">含原文与思考，适合备份</span>
            </span>
          </button>
          <button type="button" role="radio" class="ctd-option" data-mode="body" data-help="只保留显示出来的故事文字，去掉格式标签与思考。" data-help-mode="press">
            <span class="ctd-radio" aria-hidden="true"></span>
            <span class="ctd-option-text">
              <span class="ctd-option-title">正文</span>
              <span class="ctd-option-desc">只留故事文字，适合分享</span>
            </span>
          </button>
        </div>
      </div>
      <div class="ctd-field ctd-format-field">
        <span class="ctd-label has-help" data-help="Markdown 在笔记软件里有标题和分隔，阅读更清楚；TXT 任何设备都能直接打开。">格式</span>
        <div class="ctd-segment" role="radiogroup" aria-label="文件格式">
          <span class="ctd-segment-thumb" aria-hidden="true"></span>
          <button type="button" role="radio" class="ctd-segment-btn" data-format="md">Markdown</button>
          <button type="button" role="radio" class="ctd-segment-btn" data-format="txt">TXT</button>
        </div>
      </div>
      <div class="ctd-filename">${ICONS.file}<span data-i18n-skip=""></span></div>
    </div>
    <footer class="ctd-footer">
      <button type="button" class="ctd-btn" data-action="cancel">取消</button>
      <button type="button" class="ctd-btn is-primary" data-action="export">${ICONS.download}<span>导出</span></button>
    </footer>
  `;
  panel.querySelector('.ctd-subtitle').textContent = subtitle;
  const filenameEl = panel.querySelector('.ctd-filename span');
  const exportBtn = panel.querySelector('[data-action="export"]');
  const exportLabel = exportBtn.querySelector('span');
  const segment = panel.querySelector('.ctd-segment');

  const sync = () => {
    panel.querySelectorAll('.ctd-option').forEach((option) => {
      const on = option.dataset.mode === state.mode;
      option.classList.toggle('is-selected', on);
      option.setAttribute('aria-checked', String(on));
    });
    panel.querySelectorAll('.ctd-segment-btn').forEach((button) => {
      const on = button.dataset.format === state.format;
      button.classList.toggle('is-selected', on);
      button.setAttribute('aria-checked', String(on));
    });
    segment.classList.toggle('is-second', state.format === 'txt');
    filenameEl.textContent = String(buildFilename(state.mode, state.format) || '');
  };

  const onKeydown = (event) => {
    if (event.key !== 'Escape' || state.busy) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };

  function close() {
    if (state.closed) return;
    state.closed = true;
    documentRef.removeEventListener('keydown', onKeydown, true);
    const finish = () => {
      overlay.remove();
      panel.remove();
      resolve({ exported: state.exported, mode: state.mode, format: state.format });
    };
    if (isReducedMotion()) {
      finish();
      return;
    }
    overlay.classList.add('is-closing');
    panel.classList.add('is-closing');
    schedule(finish, CLOSE_MS);
  }

  const runExport = async () => {
    if (state.busy || state.closed) return;
    state.busy = true;
    panel.classList.add('is-busy');
    exportBtn.disabled = true;
    exportLabel.textContent = t('导出中…');
    let ok = false;
    try {
      ok = await onExport({ mode: state.mode, format: state.format });
    } catch {
      ok = false;
    }
    state.busy = false;
    panel.classList.remove('is-busy');
    if (!ok) {
      // 取消了保存位置或导出失败：留在对话框里，可以换个选项再试。
      exportBtn.disabled = false;
      exportLabel.textContent = t('导出');
      return;
    }
    state.exported = true;
    writeConversationExportPrefs(storage, state);
    exportBtn.classList.add('is-done');
    exportBtn.querySelector('svg').outerHTML = ICONS.check;
    exportLabel.textContent = t('已导出');
    schedule(close, isReducedMotion() ? 0 : DONE_HOLD_MS);
  };

  panel.addEventListener('click', (event) => {
    const target = event.target?.closest?.('[data-mode], [data-format], [data-action]');
    if (!target || state.busy) return;
    if (target.dataset.mode) state.mode = target.dataset.mode;
    else if (target.dataset.format) state.format = target.dataset.format;
    else if (target.dataset.action === 'export') {
      void runExport();
      return;
    } else {
      close();
      return;
    }
    sync();
  });
  overlay.addEventListener('click', () => { if (!state.busy) close(); });
  documentRef.addEventListener('keydown', onKeydown, true);
  bindSheetDragToDismiss({
    handleEl: panel.querySelector('.ctd-grabber'),
    panelEl: panel,
    isEnabled: () => panel.classList.contains('is-sheet') && !state.busy,
    onDismiss: () => close(),
  });
  bindSheetDragToDismiss({
    handleEl: panel.querySelector('.ctd-header'),
    panelEl: panel,
    isEnabled: () => panel.classList.contains('is-sheet') && !state.busy,
    onDismiss: () => close(),
  });

  sync();
  documentRef.body.append(overlay, panel);
  try {
    exportBtn.focus({ preventScroll: true });
  } catch {}
});
