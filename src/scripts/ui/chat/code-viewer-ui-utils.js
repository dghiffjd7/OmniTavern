import {
  buildFormatPatchReviewCandidate,
  createFormatPatchReviewSelection,
  updateFormatPatchReviewSelection,
} from './format-patch-review-utils.js';
import { bindBackdropActivation } from '../backdrop-activation-utils.js';
import { t } from '../../i18n/index.js';

const FORMAT_SOURCE_LABELS = Object.freeze({
  private_chat: '私聊场景',
  group_chat: '群聊场景',
  moment_comment: '动态评论场景',
  moment_post: '动态发布场景',
  creative_text: '创意写作场景',
  forum: '论坛场景',
  social_turn_raw: '社交聊天完整轮次',
  creative_raw_original: '创意写作原回复',
  phoneShell: '手机外壳格式',
  privateChat: '私聊格式',
  groupChat: '群聊格式',
  momentComment: '动态评论格式',
  momentPost: '动态发布格式',
  imagePrompt: '自动生图格式',
  tableEdit: '表格编辑格式',
  variableUpdate: '变量更新格式',
  sceneFormatReminder: '当前场景格式提示词',
  customFormatGuide: '自定义格式规范',
});

const CODE_VIEWER_OVERLAY_PADDING = 'calc(14px + env(safe-area-inset-top, 0px)) 14px calc(14px + env(safe-area-inset-bottom, 0px)) 14px';
const CODE_VIEWER_MAXIMIZED_PADDING = 'env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px)';
const CODE_VIEWER_MAXIMIZE_ICON = `<svg class="code-viewer-maximize-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <g class="code-viewer-maximize-expand">
    <path class="code-viewer-maximize-depth" d="M9 4.5H6.25A1.75 1.75 0 0 0 4.5 6.25V9M15 4.5h2.75a1.75 1.75 0 0 1 1.75 1.75V9M4.5 15v2.75a1.75 1.75 0 0 0 1.75 1.75H9M19.5 15v2.75a1.75 1.75 0 0 1-1.75 1.75H15"/>
    <path class="code-viewer-maximize-main" d="M9 4.5H6.25A1.75 1.75 0 0 0 4.5 6.25V9M15 4.5h2.75a1.75 1.75 0 0 1 1.75 1.75V9M4.5 15v2.75a1.75 1.75 0 0 0 1.75 1.75H9M19.5 15v2.75a1.75 1.75 0 0 1-1.75 1.75H15"/>
    <path class="code-viewer-maximize-accent" d="m8.2 8.2-2.8-2.8m10.4 2.8 2.8-2.8M8.2 15.8l-2.8 2.8m10.4-2.8 2.8 2.8"/>
  </g>
  <g class="code-viewer-maximize-restore">
    <path class="code-viewer-maximize-depth" d="M9.25 6.25h7.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-1M14.75 8.75h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5v-7.5a1.5 1.5 0 0 0-1.5-1.5Z"/>
    <path class="code-viewer-maximize-main" d="M9.25 6.25h7.5a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-1M14.75 8.75h-7.5a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h7.5a1.5 1.5 0 0 0 1.5-1.5v-7.5a1.5 1.5 0 0 0-1.5-1.5Z"/>
    <path class="code-viewer-maximize-accent" d="M9.25 11.75h4v4"/>
  </g>
</svg>`;

const resolveFormatSourceLabel = value => (
  FORMAT_SOURCE_LABELS[String(value || '').trim()] ||
  String(value || '').trim()
);

const clearChildren = (element) => {
  if (!element) return;
  if (typeof element.replaceChildren === 'function') {
    element.replaceChildren();
    return;
  }
  while (element.firstChild && typeof element.removeChild === 'function') {
    element.removeChild(element.firstChild);
  }
  if (Array.isArray(element.children)) {
    element.children.forEach((child) => {
      child.parentNode = null;
    });
    element.children.length = 0;
  }
};

const setButtonStyle = (button, { primary = false, danger = false } = {}) => {
  button.style.cssText = `
    border: 1px solid ${primary ? 'var(--app-accent-primary)' : (danger ? 'var(--app-danger-text)' : 'var(--app-border-default)')};
    background: ${primary ? 'var(--app-accent-primary)' : 'var(--app-surface-card)'};
    color: ${primary ? 'var(--app-text-inverse)' : (danger ? 'var(--app-danger-text)' : 'var(--app-text-primary)')};
    border-radius: 10px;
    padding: 7px 11px;
    font-size: 13px;
    cursor: pointer;
    min-height:44px;
    min-width:44px;
  `;
};

const renderLineNumbers = (gutter, text) => {
  if (!gutter) return;
  const count = String(text ?? '').split(/\r\n|\r|\n/).length;
  gutter.textContent = Array.from({ length: count }, (_value, index) => String(index + 1)).join('\n');
};

export const createCodeViewerUiRuntime = ({
  documentLike,
  windowLike,
  schedule,
  onSaveEdit,
  confirmDiscard = null,
} = {}) => {
  const applyViewerMaximized = (overlay, value) => {
    if (!overlay) return false;
    const refs = overlay.__chatappRefs || {};
    const panel = refs.panel;
    const maximizeBtn = refs.maximizeBtn;
    const maximized = value === true && overlay.__chatappCanMaximize === true;
    overlay.__chatappMaximized = maximized;
    overlay.dataset.maximized = maximized ? '1' : '0';
    overlay.style.padding = maximized ? CODE_VIEWER_MAXIMIZED_PADDING : CODE_VIEWER_OVERLAY_PADDING;
    overlay.style.background = maximized ? 'var(--app-surface-card)' : 'rgba(0,0,0,0.38)';
    if (panel) {
      panel.style.height = '100%';
      panel.style.maxHeight = '100%';
      panel.style.maxWidth = maximized ? 'none' : '920px';
      panel.style.margin = maximized ? '0px' : '0px auto';
      panel.style.borderRadius = maximized ? '0px' : '14px';
      panel.style.boxShadow = maximized ? 'none' : '0 18px 50px rgba(0,0,0,0.22)';
    }
    maximizeBtn?.classList?.toggle?.('is-on', maximized);
    maximizeBtn?.setAttribute?.('aria-pressed', maximized ? 'true' : 'false');
    maximizeBtn?.setAttribute?.('aria-label', maximized ? '还原原回复编辑器' : '放大原回复编辑器');
    if (maximizeBtn) maximizeBtn.title = maximized ? '还原面板' : '放大占满';
    return maximized;
  };

  const confirmDiscardEdit = () => {
    if (typeof confirmDiscard === 'function') return confirmDiscard() !== false;
    if (typeof windowLike?.confirm === 'function') {
      return windowLike.confirm('当前修改尚未保存，确定放弃吗？') === true;
    }
    return false;
  };

  const finishReview = (overlay, confirmed) => {
    const state = overlay?.__chatappReviewState;
    if (!state || state.finished) return;
    state.finished = true;
    const candidate = buildFormatPatchReviewCandidate({
      originalText: state.originalText,
      linePatches: state.linePatches,
      acceptedPatchIndexes: state.selection,
    });
    state.resolve?.({
      confirmed: confirmed === true,
      changed: candidate.changed,
      candidateText: candidate.candidateText,
      acceptedIndexes: candidate.acceptedIndexes,
      acceptedPatches: candidate.acceptedPatches,
      validation: state.validation || null,
    });
  };

  const hideViewer = (overlay, { force = false, reviewDecision = false } = {}) => {
    if (!overlay) return false;
    if (
      !force &&
      overlay.__chatappMode === 'edit' &&
      overlay.__chatappDirty === true &&
      !confirmDiscardEdit()
    ) {
      return false;
    }
    if (overlay.__chatappMode === 'review') finishReview(overlay, reviewDecision);
    applyViewerMaximized(overlay, false);
    overlay.style.display = 'none';
    overlay.__chatappMessage = null;
    overlay.__chatappContext = null;
    overlay.__chatappMode = '';
    overlay.__chatappDirty = false;
    overlay.__chatappReviewState = null;
    return true;
  };

  const ensureViewer = (existingOverlay = null) => {
    if (existingOverlay) return existingOverlay;
    const overlay = documentLike.createElement('div');
    overlay.id = 'code-viewer-modal';
    const reviewStyle = documentLike.createElement('style');
    reviewStyle.textContent = '.format-review-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.format-review-columns>div{min-width:0}.format-review-column-label{padding:8px 14px;font:12px/1.6 var(--app-font-family,inherit);color:var(--app-text-muted);background:var(--app-surface-subtle)}@media(max-width:600px){.format-review-columns{grid-template-columns:minmax(0,1fr)}}';
    overlay.appendChild(reviewStyle);
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 26240;
      display: none;
      background: rgba(0,0,0,0.38);
      padding: ${CODE_VIEWER_OVERLAY_PADDING};
      box-sizing: border-box;
    `;

    const panel = documentLike.createElement('div');
    panel.style.cssText = `
      height: 100%;
      max-width: 920px;
      margin: 0 auto;
      background: var(--app-surface-card);
      border-radius: 14px;
      box-shadow: 0 18px 50px rgba(0,0,0,0.22);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    `;
    panel.addEventListener('click', event => event.stopPropagation?.());

    const header = documentLike.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px;
      background: var(--app-surface-subtle);
      border-bottom: 1px solid var(--app-border-default);
    `;
    const title = documentLike.createElement('div');
    title.dataset.role = 'title';
    title.style.cssText = 'font-size:14px; font-weight:700; color:var(--app-text-primary);';
    title.textContent = '原回复';
    const hint = documentLike.createElement('div');
    hint.dataset.role = 'hint';
    hint.style.cssText = `
      font-size:12px;
      color:var(--app-text-muted);
      flex:1;
      min-width:0;
      margin-left:auto;
      max-width:55vw;
      overflow:hidden;
      text-overflow:ellipsis;
      white-space:nowrap;
    `;
    hint.textContent = '未套用正则';
    const maximizeBtn = documentLike.createElement('button');
    maximizeBtn.type = 'button';
    maximizeBtn.id = 'code-viewer-maximize';
    maximizeBtn.innerHTML = CODE_VIEWER_MAXIMIZE_ICON;
    maximizeBtn.setAttribute?.('aria-label', '放大原回复编辑器');
    maximizeBtn.setAttribute?.('aria-pressed', 'false');
    maximizeBtn.title = '放大占满';
    maximizeBtn.style.display = 'none';
    const closeBtn = documentLike.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '取消';
    setButtonStyle(closeBtn);
    const saveBtn = documentLike.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = '保存';
    saveBtn.dataset.role = 'save';
    setButtonStyle(saveBtn, { primary: true });
    header.appendChild(title);
    header.appendChild(hint);
    header.appendChild(maximizeBtn);
    header.appendChild(closeBtn);
    header.appendChild(saveBtn);

    const editBody = documentLike.createElement('div');
    editBody.dataset.role = 'edit-body';
    editBody.style.cssText = `
      flex:1;
      min-height:0;
      display:flex;
      overflow:hidden;
      background:#0b1220;
    `;
    const gutter = documentLike.createElement('pre');
    gutter.dataset.role = 'gutter';
    gutter.style.cssText = `
      flex:0 0 auto;
      min-width:42px;
      margin:0;
      padding:12px 9px;
      box-sizing:border-box;
      overflow:hidden;
      color:rgba(148,163,184,.62);
      background:#080f1c;
      border-right:1px solid rgba(148,163,184,.16);
      text-align:right;
      user-select:none;
      font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    `;
    const textarea = documentLike.createElement('textarea');
    textarea.dataset.role = 'code';
    textarea.spellcheck = false;
    textarea.autocapitalize = 'off';
    textarea.autocomplete = 'off';
    textarea.autocorrect = 'off';
    textarea.wrap = 'off';
    textarea.style.cssText = `
      flex:1;
      width:100%;
      height:100%;
      min-width:0;
      resize:none;
      border:none;
      outline:none;
      padding:12px;
      box-sizing:border-box;
      overflow:auto;
      background:transparent;
      color:#e2e8f0;
      font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      white-space:pre;
    `;
    editBody.appendChild(gutter);
    editBody.appendChild(textarea);

    const reviewBody = documentLike.createElement('div');
    reviewBody.dataset.role = 'review-body';
    reviewBody.style.cssText = `
      flex:1;
      min-height:0;
      display:none;
      overflow:auto;
      padding:12px 0;
      background:var(--app-surface-subtle);
      color:var(--app-text-primary);
      font:14px/1.7 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    `;
    const reviewSummary = documentLike.createElement('div');
    reviewSummary.dataset.role = 'review-summary';
    reviewSummary.style.cssText = 'padding:0 14px 10px; color:var(--app-text-secondary); white-space:pre-wrap;';
    const reviewHunks = documentLike.createElement('div');
    reviewHunks.dataset.role = 'review-hunks';
    reviewBody.appendChild(reviewSummary);
    reviewBody.appendChild(reviewHunks);

    const reviewFooter = documentLike.createElement('div');
    reviewFooter.dataset.role = 'review-footer';
    reviewFooter.style.cssText = `
      display:none;
      align-items:center;
      gap:8px;
      padding:10px 12px;
      border-top:1px solid var(--app-border-default);
      background:var(--app-surface-card);
    `;
    const reviewStatus = documentLike.createElement('div');
    reviewStatus.dataset.role = 'review-status';
    reviewStatus.style.cssText = 'flex:1; min-width:0; font-size:12px; color:var(--app-text-muted);';
    const reviewCancelBtn = documentLike.createElement('button');
    reviewCancelBtn.type = 'button';
    reviewCancelBtn.textContent = '取消';
    setButtonStyle(reviewCancelBtn);
    const acceptAllBtn = documentLike.createElement('button');
    acceptAllBtn.type = 'button';
    acceptAllBtn.textContent = '全部接受';
    setButtonStyle(acceptAllBtn);
    const applyReviewBtn = documentLike.createElement('button');
    applyReviewBtn.type = 'button';
    applyReviewBtn.textContent = '应用已接受修改';
    setButtonStyle(applyReviewBtn, { primary: true });
    reviewFooter.appendChild(reviewStatus);
    reviewFooter.appendChild(reviewCancelBtn);
    reviewFooter.appendChild(acceptAllBtn);
    reviewFooter.appendChild(applyReviewBtn);

    panel.appendChild(header);
    panel.appendChild(editBody);
    panel.appendChild(reviewBody);
    panel.appendChild(reviewFooter);
    overlay.appendChild(panel);
    overlay.__chatappRefs = {
      panel,
      title,
      hint,
      maximizeBtn,
      saveBtn,
      closeBtn,
      editBody,
      gutter,
      codeEl: textarea,
      reviewBody,
      reviewSummary,
      reviewHunks,
      reviewFooter,
      reviewStatus,
      reviewCancelBtn,
      acceptAllBtn,
      applyReviewBtn,
    };

    const renderReview = async () => {
      const state = overlay.__chatappReviewState;
      const refs = overlay.__chatappRefs;
      if (!state || state.finished) return;
      clearChildren(refs.reviewHunks);
      state.linePatches.forEach((patch, patchIndex) => {
        const accepted = state.selection.has(patchIndex);
        const hunk = documentLike.createElement('section');
        hunk.dataset.patchIndex = String(patchIndex);
        hunk.style.cssText = `
          margin:0 10px 12px;
          border:1px solid ${accepted ? 'var(--app-border-default)' : 'var(--app-border-subtle)'};
          border-radius:10px;
          overflow:hidden;
          opacity:${accepted ? '1' : '.66'};
        `;
        const hunkHeader = documentLike.createElement('div');
        hunkHeader.style.cssText = `
          display:flex;
          align-items:center;
          gap:8px;
          padding:7px 9px;
          background:var(--app-surface-card);
        `;
        const hunkTitle = documentLike.createElement('span');
        hunkTitle.style.cssText = 'flex:1; color:var(--app-text-secondary);';
        hunkTitle.textContent = `第 ${patch.startLine}-${patch.endLine} 行${patch.reason ? ` · ${patch.reason}` : ''}`;
        const rejectBtn = documentLike.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.textContent = '×';
        rejectBtn.title = '拒绝此处';
        setButtonStyle(rejectBtn, { danger: accepted });
        const acceptBtn = documentLike.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.textContent = '✓';
        acceptBtn.title = '接受此处';
        setButtonStyle(acceptBtn, { primary: accepted });
        rejectBtn.addEventListener('click', (event) => {
          event.stopPropagation?.();
          state.selection = updateFormatPatchReviewSelection(state.selection, patchIndex, false);
          renderReview();
        });
        acceptBtn.addEventListener('click', (event) => {
          event.stopPropagation?.();
          state.selection = updateFormatPatchReviewSelection(state.selection, patchIndex, true);
          renderReview();
        });
        hunkHeader.appendChild(hunkTitle);
        if (!state.wholeChange) { hunkHeader.appendChild(rejectBtn); hunkHeader.appendChild(acceptBtn); }
        hunk.appendChild(hunkHeader);
        const columns = documentLike.createElement('div'), beforeColumn = documentLike.createElement('div'), afterColumn = documentLike.createElement('div');
        columns.className = state.wholeChange ? 'format-review-columns' : '';
        if (state.wholeChange) for (const [column, label] of [[beforeColumn, '原文'], [afterColumn, '修改后']]) {
          const heading = documentLike.createElement('div'); heading.className = 'format-review-column-label'; heading.textContent = label; column.appendChild(heading);
        }
        columns.appendChild(beforeColumn); columns.appendChild(afterColumn); hunk.appendChild(columns);
        (Array.isArray(patch.originalLines) ? patch.originalLines : []).forEach((line, lineIndex) => {
          const row = documentLike.createElement('div');
          row.style.cssText = 'display:flex; background:var(--app-danger-soft,rgba(239,68,68,.1)); color:var(--app-text-primary);';
          const number = documentLike.createElement('span');
          number.style.cssText = 'flex:0 0 46px; padding:1px 8px; text-align:right; color:var(--app-danger-text); user-select:none;';
          number.textContent = String(Number(patch.startLine || 1) + lineIndex);
          const content = documentLike.createElement('span');
          content.style.cssText = 'flex:1; min-width:0; padding:1px 10px; white-space:pre-wrap; overflow-wrap:anywhere; text-decoration:line-through;';
          content.textContent = `- ${String(line ?? '')}`;
          row.appendChild(number);
          row.appendChild(content);
          beforeColumn.appendChild(row);
        });
        (Array.isArray(patch.replacementLines) ? patch.replacementLines : []).forEach((line, lineIndex) => {
          const row = documentLike.createElement('div');
          row.style.cssText = 'display:flex; background:var(--app-success-soft,rgba(16,185,129,.1)); color:var(--app-text-primary);';
          const number = documentLike.createElement('span');
          number.style.cssText = 'flex:0 0 46px; padding:1px 8px; text-align:right; color:var(--app-success-text); user-select:none;';
          number.textContent = String(Number(patch.startLine || 1) + lineIndex);
          const content = documentLike.createElement('span');
          content.style.cssText = 'flex:1; min-width:0; padding:1px 10px; white-space:pre-wrap; overflow-wrap:anywhere;';
          content.textContent = `+ ${String(line ?? '')}`;
          row.appendChild(number);
          row.appendChild(content);
          afterColumn.appendChild(row);
        });
        refs.reviewHunks.appendChild(hunk);
      });

      const candidate = buildFormatPatchReviewCandidate({
        originalText: state.originalText,
        linePatches: state.linePatches,
        acceptedPatchIndexes: state.selection,
      });
      state.currentCandidate = candidate;
      refs.applyReviewBtn.textContent = state.wholeChange ? t('应用修改（{count} 处）', { count: candidate.acceptedIndexes.length })
        : t('应用已接受修改（{value} 处）', { value: candidate.acceptedIndexes.length });
      refs.applyReviewBtn.disabled = true;
      refs.reviewStatus.textContent = candidate.ok
        ? '正在复查已接受的修改…'
        : (candidate.validationErrors[0]?.message || '补丁子集无效');
      if (!candidate.ok || !candidate.changed) {
        refs.reviewStatus.textContent = candidate.ok ? '请至少接受一处修改' : refs.reviewStatus.textContent;
        return;
      }
      const validationId = (state.validationId || 0) + 1;
      state.validationId = validationId;
      let validation = { canApply: true, statusText: '已通过本地复查' };
      if (typeof state.validateCandidate === 'function') {
        try {
          validation = await state.validateCandidate({
            candidateText: candidate.candidateText,
            acceptedPatches: candidate.acceptedPatches,
            acceptedIndexes: candidate.acceptedIndexes,
          }) || validation;
        } catch (error) {
          validation = {
            canApply: false,
            statusText: error?.message || '本地复查失败',
          };
        }
      }
      if (state.finished || state.validationId !== validationId) return;
      state.validation = validation;
      refs.reviewStatus.textContent = String(validation.statusText || (
        validation.canApply === false ? '当前补丁组合不可安全写回' : '已通过本地复查'
      ));
      refs.reviewStatus.style.color = validation.canApply === false
        ? '#dc2626'
        : (validation.warning === true ? '#d97706' : 'var(--app-text-muted)');
      refs.applyReviewBtn.disabled = validation.canApply === false;
    };

    bindBackdropActivation(overlay, {
      documentLike,
      onActivate: () => hideViewer(overlay),
    });
    closeBtn.addEventListener('click', () => hideViewer(overlay));
    maximizeBtn.addEventListener('click', (event) => {
      event.stopPropagation?.();
      if (overlay.__chatappCanMaximize !== true) return;
      applyViewerMaximized(overlay, overlay.__chatappMaximized !== true);
    });
    reviewCancelBtn.addEventListener('click', () => hideViewer(overlay, { force: true }));
    acceptAllBtn.addEventListener('click', () => {
      const state = overlay.__chatappReviewState;
      if (!state) return;
      state.selection = createFormatPatchReviewSelection(state.linePatches);
      renderReview();
    });
    applyReviewBtn.addEventListener('click', () => {
      const state = overlay.__chatappReviewState;
      if (!state || applyReviewBtn.disabled) return;
      finishReview(overlay, true);
      hideViewer(overlay, { force: true, reviewDecision: true });
    });
    textarea.addEventListener('input', () => {
      renderLineNumbers(gutter, textarea.value);
      overlay.__chatappDirty = textarea.value !== overlay.__chatappInitialText;
      hint.textContent = overlay.__chatappDirty ? '有未保存修改' : '未套用正则';
    });
    textarea.addEventListener('scroll', () => {
      gutter.scrollTop = textarea.scrollTop;
    });
    windowLike?.addEventListener?.('keydown', (event) => {
      if (overlay.style.display === 'none' || event.key !== 'Escape') return;
      if (overlay.__chatappMaximized === true) {
        event.preventDefault?.();
        applyViewerMaximized(overlay, false);
        return;
      }
      hideViewer(overlay);
    });
    saveBtn.addEventListener('click', async () => {
      const message = overlay.__chatappMessage;
      if (!message || message.role !== 'assistant' || typeof onSaveEdit !== 'function') return;
      const nextText = String(textarea.value ?? '');
      saveBtn.disabled = true;
      closeBtn.disabled = true;
      maximizeBtn.disabled = true;
      try {
        const saved = await onSaveEdit(message, nextText, overlay.__chatappContext || {});
        if (saved === false) {
          hint.textContent = '保存失败，修改仍保留';
          return;
        }
        overlay.__chatappDirty = false;
        hideViewer(overlay, { force: true });
      } catch (error) {
        hint.textContent = error?.message || '保存失败，修改仍保留';
      } finally {
        saveBtn.disabled = false;
        closeBtn.disabled = false;
        maximizeBtn.disabled = false;
      }
    });

    overlay.__chatappRenderReview = renderReview;
    documentLike.body.appendChild(overlay);
    return overlay;
  };

  return {
    ensureViewer,
    hideViewer,
    openCodeViewer(existingOverlay, {
      message = null,
      text = '',
      canSave = false,
      context = null,
      title = '原回复',
    } = {}) {
      const overlay = ensureViewer(existingOverlay);
      if (overlay.__chatappMode === 'review') {
        finishReview(overlay, false);
        overlay.__chatappReviewState = null;
      }
      const refs = overlay.__chatappRefs || {};
      const content = String(text ?? '');
      overlay.__chatappMessage = message && typeof message === 'object' ? message : null;
      overlay.__chatappContext = context && typeof context === 'object' ? { ...context } : {};
      overlay.__chatappMode = canSave ? 'edit' : 'view';
      overlay.__chatappInitialText = content;
      overlay.__chatappDirty = false;
      overlay.__chatappCanMaximize = Boolean(
        canSave
        && String(overlay.__chatappContext?.sourceKind || '').trim() === 'creative_raw_original'
      );
      applyViewerMaximized(overlay, false);
      if (refs.title) refs.title.textContent = String(title || '原回复');
      if (refs.hint) refs.hint.textContent = canSave ? '未套用正则' : '只读';
      if (refs.codeEl) {
        refs.codeEl.value = content;
        refs.codeEl.readOnly = !canSave;
      }
      renderLineNumbers(refs.gutter, content);
      if (refs.editBody) refs.editBody.style.display = 'flex';
      if (refs.reviewBody) refs.reviewBody.style.display = 'none';
      if (refs.reviewFooter) refs.reviewFooter.style.display = 'none';
      if (refs.saveBtn) refs.saveBtn.style.display = canSave ? 'inline-block' : 'none';
      if (refs.maximizeBtn) refs.maximizeBtn.style.display = overlay.__chatappCanMaximize ? 'inline-flex' : 'none';
      overlay.style.display = 'block';
      schedule?.(() => {
        try {
          refs.codeEl?.focus?.();
        } catch {}
      });
      return overlay;
    },
    openPatchReview(existingOverlay, {
      message = null,
      originalText = '',
      linePatches = [],
      title = '审阅格式修复',
      summary = '',
      formatSources = [],
      warning = '',
      validateCandidate = null,
      wholeChange = false,
    } = {}) {
      const overlay = ensureViewer(existingOverlay);
      if (overlay.__chatappMode === 'review') finishReview(overlay, false);
      const refs = overlay.__chatappRefs || {};
      const patches = Array.isArray(linePatches) ? linePatches : [];
      let resolveResult = null;
      const promise = new Promise((resolve) => {
        resolveResult = resolve;
      });
      overlay.__chatappMessage = message && typeof message === 'object' ? message : null;
      overlay.__chatappMode = 'review';
      overlay.__chatappDirty = false;
      overlay.__chatappCanMaximize = false;
      applyViewerMaximized(overlay, false);
      overlay.__chatappReviewState = {
        originalText: String(originalText ?? ''),
        linePatches: patches,
        selection: createFormatPatchReviewSelection(patches),
        validateCandidate,
        wholeChange,
        validation: null,
        validationId: 0,
        finished: false,
        resolve: resolveResult,
      };
      if (refs.title) refs.title.textContent = String(title || '审阅格式修复');
      if (refs.hint) refs.hint.textContent = `${patches.length} 处补丁`;
      if (refs.saveBtn) refs.saveBtn.style.display = 'none';
      if (refs.maximizeBtn) refs.maximizeBtn.style.display = 'none';
      if (refs.editBody) refs.editBody.style.display = 'none';
      if (refs.reviewBody) refs.reviewBody.style.display = 'block';
      if (refs.reviewFooter) refs.reviewFooter.style.display = 'flex';
      if (refs.acceptAllBtn) refs.acceptAllBtn.style.display = wholeChange ? 'none' : '';
      if (wholeChange && refs.panel) {
        refs.panel.style.height = 'auto'; refs.panel.style.maxHeight = '84dvh'; refs.panel.style.margin = '6vh auto 0';
      }
      if (refs.reviewSummary) {
        const sources = (Array.isArray(formatSources) ? formatSources : [])
          .map(resolveFormatSourceLabel)
          .filter(Boolean);
        refs.reviewSummary.textContent = [
          String(summary || '').trim(),
          sources.length ? `格式规范：${sources.join('、')}` : '',
          String(warning || '').trim(),
        ].filter(Boolean).join('\n');
      }
      overlay.style.display = 'block';
      overlay.__chatappRenderReview?.();
      return { overlay, promise };
    },
  };
};
