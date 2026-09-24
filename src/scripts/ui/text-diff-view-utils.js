import { buildLineDiff } from '../utils/line-diff-utils.js';
import { annotateLineDiffWords, renderWordDiffHtml } from '../utils/word-diff-utils.js';

// 正文变更的行级 diff 预览与确认对话框（Claude Code 式绿增红删）。
// 供格式修复、正文优化等“覆盖已有正文”的动作在写回前展示变更并等待用户确认。

const STYLE_ID = 'text-diff-view-style';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = `
.text-diff-overlay {
  position: fixed;
  inset: 0;
  z-index: 26240;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: calc(12px + env(safe-area-inset-top, 0px)) 12px calc(12px + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box;
  background: rgba(15, 23, 42, 0.4);
}
.text-diff-dialog {
  width: min(720px, 100%);
  max-height: min(640px, calc(var(--app-visual-height, 100dvh) - 24px));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.28));
  border-radius: 14px;
  background: var(--app-surface-card, #fff);
  color: var(--app-text-primary, #111827);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.26);
}
.text-diff-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.22));
}
.text-diff-title {
  font-weight: 800;
  font-size: 14px;
  flex: 1;
  min-width: 0;
}
.text-diff-stats {
  flex: 0 0 auto;
  display: inline-flex;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
}
.text-diff-stat-add {
  color: #047857;
}
.text-diff-stat-del {
  color: #b91c1c;
}
.text-diff-summary {
  padding: 8px 16px 0;
  font-size: 12px;
  color: var(--app-text-secondary, #6b7280);
}
.text-diff-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.55;
}
.text-diff-row {
  display: flex;
  align-items: flex-start;
  white-space: pre-wrap;
  word-break: break-word;
}
.text-diff-lineno {
  flex: 0 0 44px;
  padding: 0 8px 0 12px;
  text-align: right;
  user-select: none;
  color: var(--app-text-secondary, #94a3b8);
  opacity: 0.75;
}
.text-diff-sign {
  flex: 0 0 16px;
  user-select: none;
  font-weight: 700;
}
.text-diff-text {
  flex: 1;
  min-width: 0;
  padding-right: 12px;
}
.text-diff-row.is-add {
  background: rgba(16, 185, 129, 0.12);
}
.text-diff-row.is-add .text-diff-sign {
  color: #047857;
}
.text-diff-row.is-del {
  background: rgba(239, 68, 68, 0.1);
}
.text-diff-row.is-del .text-diff-sign {
  color: #b91c1c;
}
.text-diff-row.is-del .text-diff-text {
  text-decoration: line-through;
  opacity: 0.85;
}
.text-diff-row.is-skip {
  justify-content: center;
  padding: 2px 0;
  color: var(--app-text-secondary, #94a3b8);
  font-size: 11px;
  user-select: none;
}
.text-diff-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.22));
}
.text-diff-action {
  border: 1px solid var(--app-border-default, rgba(148, 163, 184, 0.35));
  border-radius: 8px;
  padding: 7px 16px;
  font-size: 13px;
  background: var(--app-surface-card, #fff);
  color: inherit;
  cursor: pointer;
}
.text-diff-action.is-primary {
  border-color: rgba(37, 99, 235, 0.4);
  background: rgba(37, 99, 235, 0.1);
  color: #2563eb;
  font-weight: 700;
}
/* 改写配对的行：整行浅底，具体改动的字词深底 */
.text-diff-row.has-words.is-add { background: rgba(16, 185, 129, 0.06); }
.text-diff-row.has-words.is-del { background: rgba(239, 68, 68, 0.05); }
.text-diff-row.has-words.is-del .text-diff-text { text-decoration: none; }
.text-diff-text .wd-del, .text-diff-text .wd-ins { text-decoration: none; border-radius: 3px; padding: 0 1px; }
.text-diff-text .wd-del { background: rgba(var(--app-danger-rgb, 220, 38, 38), 0.2); text-decoration: line-through; }
.text-diff-text .wd-ins { background: rgba(var(--app-success-rgb, 22, 163, 74), 0.22); }
@media (prefers-color-scheme: dark) {
  .text-diff-row.is-add {
    background: rgba(16, 185, 129, 0.18);
  }
  .text-diff-row.is-del {
    background: rgba(239, 68, 68, 0.16);
  }
}
`;
  documentRef.head.appendChild(style);
};

export const renderLineDiffElement = (documentRef, diff = {}) => {
  if (!documentRef?.createElement) return null;
  const container = documentRef.createElement('div');
  container.className = 'text-diff-body';
  const rows = annotateLineDiffWords(Array.isArray(diff.rows) ? diff.rows : []);
  rows.forEach((row) => {
    const rowEl = documentRef.createElement('div');
    if (row.type === 'skip') {
      rowEl.className = 'text-diff-row is-skip';
      rowEl.textContent = `⋯ ${Number(row.count) || 0} 行未变更 ⋯`;
      container.appendChild(rowEl);
      return;
    }
    rowEl.className = `text-diff-row is-${row.type}${row.words ? ' has-words' : ''}`;
    const lineno = documentRef.createElement('span');
    lineno.className = 'text-diff-lineno';
    lineno.textContent = String(row.type === 'add' ? (row.newLine ?? '') : (row.oldLine ?? ''));
    const sign = documentRef.createElement('span');
    sign.className = 'text-diff-sign';
    sign.textContent = row.type === 'add' ? '+' : (row.type === 'del' ? '-' : '');
    const text = documentRef.createElement('span');
    text.className = 'text-diff-text';
    if (row.words) text.innerHTML = renderWordDiffHtml(row.words, { side: row.type === 'del' ? 'old' : 'new' });
    else text.textContent = String(row.text ?? '');
    rowEl.append(lineno, sign, text);
    container.appendChild(rowEl);
  });
  return container;
};

// 展示 oldText -> newText 的行级 diff，返回 Promise<boolean>：确认 true / 取消 false。
// 无变化时不弹窗，直接 resolve { confirmed: false, changed: false }。
export const showTextDiffConfirmDialog = ({
  documentRef = globalThis?.document || null,
  title = '确认正文变更',
  summary = '',
  oldText = '',
  newText = '',
  confirmText = '应用变更',
  cancelText = '取消',
  diff = null,
} = {}) => {
  const resolvedDiff = diff || buildLineDiff(oldText, newText);
  if (!resolvedDiff.changed) {
    return Promise.resolve({ confirmed: false, changed: false, diff: resolvedDiff });
  }
  if (!documentRef?.body?.appendChild) {
    // 无 DOM 环境（如测试或异常状态）不静默应用，按取消处理。
    return Promise.resolve({ confirmed: false, changed: true, diff: resolvedDiff, reason: 'dom_unavailable' });
  }
  injectStyle(documentRef);
  return new Promise((resolve) => {
    const overlay = documentRef.createElement('div');
    overlay.className = 'text-diff-overlay';
    const dialog = documentRef.createElement('div');
    dialog.className = 'text-diff-dialog';
    dialog.addEventListener?.('click', event => event.stopPropagation?.());

    const header = documentRef.createElement('div');
    header.className = 'text-diff-header';
    const titleEl = documentRef.createElement('div');
    titleEl.className = 'text-diff-title';
    titleEl.textContent = trim(title, '确认正文变更');
    const stats = documentRef.createElement('div');
    stats.className = 'text-diff-stats';
    const addStat = documentRef.createElement('span');
    addStat.className = 'text-diff-stat-add';
    addStat.textContent = `+${resolvedDiff.added}`;
    const delStat = documentRef.createElement('span');
    delStat.className = 'text-diff-stat-del';
    delStat.textContent = `-${resolvedDiff.removed}`;
    stats.append(addStat, delStat);
    header.append(titleEl, stats);

    const body = renderLineDiffElement(documentRef, resolvedDiff);

    const footer = documentRef.createElement('div');
    footer.className = 'text-diff-footer';
    const cancelBtn = documentRef.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'text-diff-action';
    cancelBtn.textContent = trim(cancelText, '取消');
    const confirmBtn = documentRef.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'text-diff-action is-primary';
    confirmBtn.textContent = trim(confirmText, '应用变更');
    footer.append(cancelBtn, confirmBtn);

    const finish = (confirmed) => {
      try {
        overlay.parentNode?.removeChild?.(overlay);
      } catch {}
      resolve({ confirmed, changed: true, diff: resolvedDiff });
    };
    cancelBtn.addEventListener?.('click', () => finish(false));
    confirmBtn.addEventListener?.('click', () => finish(true));
    overlay.addEventListener?.('click', () => finish(false));

    dialog.appendChild(header);
    const summaryText = trim(summary);
    if (summaryText) {
      const summaryEl = documentRef.createElement('div');
      summaryEl.className = 'text-diff-summary';
      summaryEl.textContent = summaryText;
      dialog.appendChild(summaryEl);
    }
    if (resolvedDiff.truncated) {
      const truncatedEl = documentRef.createElement('div');
      truncatedEl.className = 'text-diff-summary';
      truncatedEl.textContent = '变更过大，已按整段替换显示。';
      dialog.appendChild(truncatedEl);
    }
    dialog.append(body, footer);
    overlay.appendChild(dialog);
    documentRef.body.appendChild(overlay);
  });
};
