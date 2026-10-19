import {
  buildSessionSummaryTextareaStyle,
  SESSION_SUMMARY_MODAL_STYLES,
} from './session-summary-modal-style-utils.js';

const createBottomSheetShell = ({
  overlayClass = '',
  panelClass = '',
  documentRef = globalThis.document,
} = {}) => {
  const overlay = documentRef.createElement('div');
  overlay.className = overlayClass;
  overlay.style.cssText = SESSION_SUMMARY_MODAL_STYLES.overlay;

  const panel = documentRef.createElement('div');
  panel.className = panelClass;
  panel.style.cssText = SESSION_SUMMARY_MODAL_STYLES.panel;
  panel.addEventListener('click', (event) => event.stopPropagation());

  const close = () => {
    overlay.style.display = 'none';
    panel.style.display = 'none';
  };
  overlay.addEventListener('click', close);

  documentRef.body.appendChild(overlay);
  documentRef.body.appendChild(panel);

  return { overlay, panel, close };
};

const createHeader = ({ documentRef, title = '', onClose = () => {} } = {}) => {
  const header = documentRef.createElement('div');
  header.style.cssText = SESSION_SUMMARY_MODAL_STYLES.header;

  const titleEl = documentRef.createElement('div');
  titleEl.style.cssText = SESSION_SUMMARY_MODAL_STYLES.title;
  titleEl.textContent = title;

  const closeBtn = documentRef.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.style.cssText = SESSION_SUMMARY_MODAL_STYLES.closeButton;
  closeBtn.onclick = onClose;

  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  return { header, closeBtn, titleEl };
};

const createTextareaSection = ({
  documentRef,
  helperText = '',
  minHeight = '200px',
  readOnly = false,
} = {}) => {
  const body = documentRef.createElement('div');
  body.style.cssText = SESSION_SUMMARY_MODAL_STYLES.body;

  if (helperText) {
    const helper = documentRef.createElement('div');
    helper.style.cssText = SESSION_SUMMARY_MODAL_STYLES.helper;
    helper.textContent = helperText;
    body.appendChild(helper);
  }

  const textarea = documentRef.createElement('textarea');
  textarea.readOnly = readOnly;
  textarea.style.cssText = buildSessionSummaryTextareaStyle({ minHeight, readOnly });
  body.appendChild(textarea);

  return { body, textarea };
};

const createFooterButton = ({ documentRef, label = '', style = '' } = {}) => {
  const button = documentRef.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.style.cssText = style;
  return button;
};

export const createReadonlyTextareaModal = ({
  overlayClass = '',
  panelClass = '',
  title = '',
  copySuccessMessage = '已复制原始回复',
  documentRef = globalThis.document,
  copyText = async () => {},
  toastr = null,
} = {}) => {
  const { overlay, panel, close } = createBottomSheetShell({ overlayClass, panelClass, documentRef });
  const { header, closeBtn, titleEl } = createHeader({ documentRef, title, onClose: close });
  const { body, textarea } = createTextareaSection({
    documentRef,
    minHeight: '220px',
    readOnly: true,
  });

  const footer = documentRef.createElement('div');
  footer.style.cssText = SESSION_SUMMARY_MODAL_STYLES.footer;

  const copyButton = createFooterButton({
    documentRef,
    label: '复制',
    style: SESSION_SUMMARY_MODAL_STYLES.secondaryButton,
  });
  const okButton = createFooterButton({
    documentRef,
    label: '关闭',
    style: SESSION_SUMMARY_MODAL_STYLES.primaryButton,
  });
  copyButton.onclick = async () => {
    try {
      await copyText?.(String(textarea?.value || ''));
      toastr?.success?.(copySuccessMessage);
    } catch {}
  };
  okButton.onclick = close;

  footer.appendChild(copyButton);
  footer.appendChild(okButton);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  return {
    overlay,
    panel,
    textarea,
    closeBtn,
    copyButton,
    okButton,
    close,
    show: () => {
      overlay.style.display = 'block';
      panel.style.display = 'flex';
    },
    setValue: (value) => {
      textarea.value = String(value || '');
    },
    setTitle: (value) => {
      titleEl.textContent = String(value || '');
    },
    focus: () => textarea?.focus?.(),
  };
};

export const createEditableTextareaModal = ({
  overlayClass = '',
  panelClass = '',
  title = '',
  helperText = '',
  minHeight = '200px',
  documentRef = globalThis.document,
} = {}) => {
  const { overlay, panel, close: closeShell } = createBottomSheetShell({ overlayClass, panelClass, documentRef });
  let onSave = null;
  const close = () => {
    closeShell();
    onSave = null;
  };

  const { header, closeBtn } = createHeader({ documentRef, title, onClose: close });
  const { body, textarea } = createTextareaSection({
    documentRef,
    helperText,
    minHeight,
    readOnly: false,
  });
  const footer = documentRef.createElement('div');
  footer.style.cssText = SESSION_SUMMARY_MODAL_STYLES.footer;

  const cancelButton = createFooterButton({
    documentRef,
    label: '取消',
    style: SESSION_SUMMARY_MODAL_STYLES.secondaryButton,
  });
  const saveButton = createFooterButton({
    documentRef,
    label: '保存',
    style: SESSION_SUMMARY_MODAL_STYLES.primaryButton,
  });
  cancelButton.onclick = close;
  saveButton.onclick = () => {
    onSave?.(String(textarea?.value || ''));
  };

  footer.appendChild(cancelButton);
  footer.appendChild(saveButton);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  return {
    overlay,
    panel,
    textarea,
    closeBtn,
    cancelButton,
    saveButton,
    close,
    show: () => {
      overlay.style.display = 'block';
      panel.style.display = 'flex';
    },
    setValue: (value) => {
      textarea.value = String(value || '');
    },
    setOnSave: (handler) => {
      onSave = typeof handler === 'function' ? handler : null;
    },
    focus: () => textarea?.focus?.(),
  };
};
