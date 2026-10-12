// 导入聊天记录对话框：预览文件里的消息，确认角色（我／AI）与存档名后导入为新存档。
// 版式沿用导出对话框（ctd- 前缀）；电脑为居中弹窗，手机为底部面板。实际写入由调用方的 onImport 完成。
import { t } from '../i18n/index.js';
import { bindSheetDragToDismiss } from './bottom-sheet-drag-utils.js';
import { CONVERSATION_TRANSFER_SHEET_QUERY } from './conversation-export-dialog.js';

const CLOSE_MS = 200;
const PREVIEW_COUNT = 3;
const SNIPPET_CHARS = 90;
const MODE_LABEL = { rp: '创意写作', chat: '聊天' };
const ROLE_LABEL = { user: '我', assistant: 'AI', system: '系统' };

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICONS = {
  upload: svg('<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  check: svg('<path d="m5 12 4.5 4.5L19 7"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
};

const speakerKey = message => `${message.role}\u0000${message.name}`;

// 按「原角色 + 名字」分组，供预览里逐个切换「我／AI」。
export const groupConversationImportSpeakers = (messages = []) => {
  const groups = new Map();
  (Array.isArray(messages) ? messages : []).forEach((message) => {
    const key = speakerKey(message);
    const group = groups.get(key) || { key, name: message.name, role: message.role, count: 0 };
    group.count += 1;
    groups.set(key, group);
  });
  return [...groups.values()];
};

export const applyConversationImportRoles = (messages = [], roleByKey = new Map()) => (
  (Array.isArray(messages) ? messages : []).map((message) => {
    const role = roleByKey.get(speakerKey(message));
    return role && role !== message.role ? { ...message, role } : message;
  })
);

export const buildConversationImportNotices = ({ parsed = {}, sessionMode = 'chat' } = {}) => {
  const notices = [];
  if (parsed.sessionMode && parsed.sessionMode !== sessionMode) {
    notices.push(t('这份记录导出自「{from}」，当前是「{to}」。仍可导入，但显示效果可能不同。', {
      from: t(MODE_LABEL[parsed.sessionMode]),
      to: t(MODE_LABEL[sessionMode] || MODE_LABEL.chat),
    }));
  }
  if (parsed.content === 'body') notices.push(t('这是正文版：格式与思考已在导出时去掉，导入后只有故事文字。'));
  if (parsed.rolesGuessed) notices.push(t('旧版导出文件没有角色标记，下方的「我／AI」是按名字推测的，请确认。'));
  return notices;
};

const STATE_ITEMS = [
  { key: 'memory', label: () => t('记忆表格'), unit: count => t('{count} 行', { count }) },
  { key: 'summaries', label: () => t('摘要'), unit: count => t('{count} 条', { count }) },
  { key: 'variables', label: () => t('变量'), unit: count => t('{count} 项', { count }) },
];
const STATE_REASON = {
  mode: () => t('记忆模式不是「表格」，不会随存档切换'),
  template: () => t('记忆表格模板不同，表格从空开始'),
};

// 底注：说明没有一起导入的部分会怎样。
export const buildConversationImportFootnote = (stateInfo = {}, include = {}) => {
  const memoryOn = include.memory === true && stateInfo.memory?.usable;
  const variablesOn = include.variables === true && stateInfo.variables?.usable;
  const parts = [];
  parts.push(memoryOn ? t('记忆表格用文件里的') : t('记忆表格从空开始'));
  parts.push(variablesOn ? t('加载时还原变量') : t('变量保持不变'));
  return parts.join(' · ');
};

const snippet = (text = '') => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS)}…` : flat || t('（空）');
};

export const openConversationImportDialog = ({
  documentRef = globalThis.document,
  fileName = '',
  parsed = { messages: [] },
  sessionMode = 'chat',
  stateInfo = null,
  defaultName = '',
  onImport = async () => '',
  isReducedMotion = () => false,
  isSheet = () => globalThis.matchMedia?.(CONVERSATION_TRANSFER_SHEET_QUERY)?.matches === true,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
} = {}) => new Promise((resolve) => {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const speakers = groupConversationImportSpeakers(messages);
  const roleByKey = new Map(speakers.map(speaker => [speaker.key, speaker.role]));
  const info = stateInfo || {};
  const stateItems = STATE_ITEMS.filter(item => Number(info[item.key]?.count) > 0);
  // 三样默认都勾选（能用的才算数），可取消。
  const include = Object.fromEntries(STATE_ITEMS.map(item => [item.key, Boolean(info[item.key]?.usable)]));
  const state = { busy: false, archiveId: '', load: false, closed: false };
  const titleId = `ctd-import-title-${Date.now().toString(36)}`;
  const overlay = documentRef.createElement('div');
  overlay.className = 'ctd-overlay';
  const panel = documentRef.createElement('div');
  panel.className = `ctd-panel ctd-import${isSheet() ? ' is-sheet' : ''}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', titleId);
  panel.tabIndex = -1;
  panel.innerHTML = `
    <span class="ctd-grabber" aria-hidden="true"></span>
    <header class="ctd-header">
      <span class="ctd-mark" aria-hidden="true">${ICONS.upload}</span>
      <div class="ctd-heading">
        <h2 id="${titleId}" class="ctd-title">导入聊天记录</h2>
        <span class="ctd-subtitle" data-i18n-skip=""></span>
      </div>
      <button type="button" class="ctd-close" data-action="close" aria-label="关闭">${ICONS.close}</button>
    </header>
    <div class="ctd-body">
      <div class="ctd-notices"></div>
      <label class="ctd-field">
        <span class="ctd-label">存档名称</span>
        <input type="text" class="ctd-input" data-role="name" maxlength="80" data-i18n-skip="">
      </label>
      <div class="ctd-field">
        <span class="ctd-label has-help" data-help="点角色标签可在「我」与「AI」之间切换，同名的消息一起改。">角色</span>
        <div class="ctd-speakers" data-role="speakers"></div>
      </div>
      <div class="ctd-field" data-role="state-field" hidden>
        <span class="ctd-label has-help" data-help="完整版导出会带上记忆表格、摘要与变量。勾选的会绑定到新存档，加载这份存档时一起还原。">一起导入</span>
        <div class="ctd-checks" data-role="state"></div>
      </div>
      <div class="ctd-field">
        <span class="ctd-label">预览</span>
        <ol class="ctd-preview" data-role="preview"></ol>
      </div>
      <p class="ctd-footnote">${ICONS.info}<span data-role="footnote"></span></p>
    </div>
    <footer class="ctd-footer">
      <button type="button" class="ctd-btn" data-action="cancel">取消</button>
      <button type="button" class="ctd-btn is-primary" data-action="import">${ICONS.upload}<span>导入</span></button>
    </footer>
  `;
  panel.querySelector('.ctd-subtitle').textContent = t('{file} · {count} 条', { file: fileName, count: messages.length });
  const nameInput = panel.querySelector('[data-role="name"]');
  nameInput.value = String(defaultName || '');
  const noticesEl = panel.querySelector('.ctd-notices');
  buildConversationImportNotices({ parsed, sessionMode }).forEach((text) => {
    const notice = documentRef.createElement('p');
    notice.className = 'ctd-notice';
    notice.textContent = text;
    noticesEl.appendChild(notice);
  });
  noticesEl.hidden = !noticesEl.childElementCount;
  const speakersEl = panel.querySelector('[data-role="speakers"]');
  const previewEl = panel.querySelector('[data-role="preview"]');
  const footer = panel.querySelector('.ctd-footer');
  const importBtn = panel.querySelector('[data-action="import"]');
  const importLabel = importBtn.querySelector('span');

  const roleChip = (role, extraClass = '') => {
    const chip = documentRef.createElement('span');
    chip.className = `ctd-role is-${role}${extraClass}`;
    chip.textContent = t(ROLE_LABEL[role] || ROLE_LABEL.assistant);
    return chip;
  };

  const renderSpeakers = () => {
    speakersEl.replaceChildren(...speakers.map((speaker) => {
      const row = documentRef.createElement('div');
      row.className = 'ctd-speaker';
      const name = documentRef.createElement('span');
      name.className = 'ctd-speaker-name';
      name.dataset.i18nSkip = '';
      name.textContent = speaker.name || t(ROLE_LABEL[speaker.role] || '');
      const count = documentRef.createElement('span');
      count.className = 'ctd-speaker-count';
      count.textContent = t('{count} 条', { count: speaker.count });
      const role = roleByKey.get(speaker.key);
      let toggle;
      if (role === 'system') {
        toggle = roleChip('system');
      } else {
        toggle = documentRef.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ctd-role-toggle';
        toggle.dataset.speaker = speaker.key;
        toggle.setAttribute('aria-label', t('切换 {name} 的角色', { name: speaker.name }));
        toggle.appendChild(roleChip(role));
      }
      row.append(name, count, toggle);
      return row;
    }));
  };

  const renderPreview = () => {
    previewEl.replaceChildren(...messages.slice(0, PREVIEW_COUNT).map((message) => {
      const item = documentRef.createElement('li');
      item.className = 'ctd-preview-item';
      const head = documentRef.createElement('div');
      head.className = 'ctd-preview-head';
      const name = documentRef.createElement('span');
      name.className = 'ctd-preview-name';
      name.dataset.i18nSkip = '';
      name.textContent = message.name || '';
      head.append(roleChip(roleByKey.get(speakerKey(message)) || message.role), name);
      const text = documentRef.createElement('p');
      text.className = 'ctd-preview-text';
      text.dataset.i18nSkip = '';
      text.textContent = snippet(message.text);
      item.append(head, text);
      return item;
    }));
    if (messages.length > PREVIEW_COUNT) {
      const more = documentRef.createElement('li');
      more.className = 'ctd-preview-more';
      more.textContent = t('…以及另外 {count} 条', { count: messages.length - PREVIEW_COUNT });
      previewEl.appendChild(more);
    }
  };

  const footnoteEl = panel.querySelector('[data-role="footnote"]');
  const renderState = () => {
    const field = panel.querySelector('[data-role="state-field"]');
    field.hidden = !stateItems.length;
    panel.querySelector('[data-role="state"]').replaceChildren(...stateItems.map((item) => {
      const entry = info[item.key];
      const row = documentRef.createElement('label');
      row.className = `ctd-check${entry.usable ? '' : ' is-disabled'}`;
      const box = documentRef.createElement('input');
      box.type = 'checkbox';
      box.dataset.state = item.key;
      box.checked = include[item.key];
      box.disabled = !entry.usable || state.busy || Boolean(state.archiveId);
      const text = documentRef.createElement('span');
      text.className = 'ctd-check-text';
      const title = documentRef.createElement('span');
      title.className = 'ctd-check-title';
      title.textContent = item.label();
      const meta = documentRef.createElement('span');
      meta.className = 'ctd-check-meta';
      meta.textContent = entry.usable ? item.unit(entry.count) : (STATE_REASON[entry.reason]?.() || '');
      text.append(title, meta);
      row.append(box, text);
      return row;
    }));
    footnoteEl.textContent = buildConversationImportFootnote(info, include);
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
      resolve({ archiveId: state.archiveId, load: state.load });
    };
    if (isReducedMotion()) {
      finish();
      return;
    }
    overlay.classList.add('is-closing');
    panel.classList.add('is-closing');
    schedule(finish, CLOSE_MS);
  }

  const showDone = () => {
    footer.innerHTML = `
      <span class="ctd-done-text">${ICONS.check}<span></span></span>
      <button type="button" class="ctd-btn" data-action="close">完成</button>
      <button type="button" class="ctd-btn is-primary" data-action="load">立即加载</button>
    `;
    footer.querySelector('.ctd-done-text span').textContent = t('已导入为新存档');
    panel.classList.add('is-done');
    try {
      footer.querySelector('[data-action="load"]').focus({ preventScroll: true });
    } catch {}
  };

  const runImport = async () => {
    if (state.busy || state.closed || state.archiveId) return;
    state.busy = true;
    panel.classList.add('is-busy');
    importBtn.disabled = true;
    nameInput.disabled = true;
    importLabel.textContent = t('导入中…');
    renderState();
    let archiveId = '';
    try {
      archiveId = String(await onImport({
        name: nameInput.value.trim() || String(defaultName || ''),
        messages: applyConversationImportRoles(messages, roleByKey),
        include: { ...include },
      }) || '');
    } catch {
      archiveId = '';
    }
    state.busy = false;
    panel.classList.remove('is-busy');
    if (!archiveId) {
      importBtn.disabled = false;
      nameInput.disabled = false;
      importLabel.textContent = t('导入');
      renderState();
      return;
    }
    state.archiveId = archiveId;
    renderState();
    showDone();
  };

  panel.addEventListener('click', (event) => {
    const target = event.target?.closest?.('[data-speaker], [data-action]');
    if (!target || state.busy) return;
    if (target.dataset.speaker) {
      const key = target.dataset.speaker;
      roleByKey.set(key, roleByKey.get(key) === 'user' ? 'assistant' : 'user');
      renderSpeakers();
      renderPreview();
      return;
    }
    const action = target.dataset.action;
    if (action === 'import') void runImport();
    else if (action === 'load') {
      state.load = true;
      close();
    } else close();
  });
  panel.addEventListener('change', (event) => {
    const key = event.target?.dataset?.state;
    if (!key || !(key in include)) return;
    include[key] = event.target.checked === true;
    footnoteEl.textContent = buildConversationImportFootnote(info, include);
  });
  nameInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    void runImport();
  });
  overlay.addEventListener('click', () => { if (!state.busy) close(); });
  documentRef.addEventListener('keydown', onKeydown, true);
  for (const handleEl of [panel.querySelector('.ctd-grabber'), panel.querySelector('.ctd-header')]) {
    bindSheetDragToDismiss({
      handleEl,
      panelEl: panel,
      isEnabled: () => panel.classList.contains('is-sheet') && !state.busy,
      onDismiss: () => close(),
    });
  }

  renderSpeakers();
  renderPreview();
  renderState();
  documentRef.body.append(overlay, panel);
  try {
    importBtn.focus({ preventScroll: true });
  } catch {}
});
