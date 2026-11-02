// 记忆总览（Agent 资源中心计划 P4／P5）：上层整张角色卡（各聊天室的记忆），下层当前会话（上次发送的注入、共享、写表、待确认），
// 加上记忆管家的只读检查。总览本身不编辑记忆：聊天室的表格在页内用现有表格编辑器打开，其余跳到各自的主界面。
import { t } from '../i18n/index.js';
import { MEMORY_AUDIT_LIMITS } from '../agent/memory-audit-agent.js';

const STYLE_ID = 'memory-overview-style';
const trim = value => String(value ?? '').trim();

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
const ICONS = Object.freeze({
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
  warning: svg('<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4"/><path d="M12 17h.01"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>'),
});

const STYLE = `
.mo-overlay { position: fixed; inset: 0; z-index: 22600; display: none; align-items: center; justify-content: center; padding: 12px; background: rgba(15, 23, 42, 0.34); }
.mo-overlay.is-open { display: flex; }
.mo-panel { width: min(720px, 100%); height: min(780px, calc(var(--app-visual-height, 100dvh) - 24px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 22px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22); }
.mo-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--app-border-default, #e2e8f0); }
.mo-head-copy { flex: 1; min-width: 0; }
.mo-title { margin: 0; font-size: 17px; font-weight: 800; }
.mo-subtitle { margin: 2px 0 0; font-size: 12.5px; color: var(--app-text-secondary, #64748b); overflow-wrap: anywhere; }
.mo-icon-btn { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 50%; background: transparent; color: var(--app-text-secondary, #475569); cursor: pointer; }
.mo-icon-btn:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.mo-icon-btn svg { width: 18px; height: 18px; }
.mo-icon-btn[hidden] { display: none; }
.mo-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 20px; display: grid; gap: 14px; align-content: start; }
.mo-body > * { min-width: 0; }
.mo-section { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 16px; background: var(--app-surface-card, #fff); }
.mo-section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mo-section-title { margin: 0; flex: 1; min-width: 0; font-size: 14px; font-weight: 800; }
.mo-muted { margin: 0; font-size: 12.5px; color: var(--app-text-secondary, #64748b); overflow-wrap: anywhere; }
.mo-line { margin: 0; font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; }
.mo-btn { min-height: 30px; padding: 0 12px; border: 1px solid var(--app-border-default, #cbd5e1); border-radius: 999px; background: transparent; color: var(--app-text-secondary, #475569); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; white-space: nowrap; }
.mo-btn:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.mo-btn.is-primary { border-color: var(--app-accent-primary, #2563eb); background: var(--app-accent-primary, #2563eb); color: var(--app-text-on-accent, #fff); }
.mo-btn:disabled { opacity: .55; cursor: default; }
.mo-rooms { display: grid; gap: 6px; }
.mo-room { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 12px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 12px; background: var(--app-surface-subtle, #f8fafc); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.mo-room:hover { border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 40%, transparent); }
.mo-room-copy { flex: 1; min-width: 0; display: grid; gap: 2px; }
.mo-room-name { font-size: 13.5px; font-weight: 700; overflow-wrap: anywhere; }
.mo-room-meta { font-size: 12px; color: var(--app-text-secondary, #64748b); }
.mo-room svg { width: 16px; height: 16px; color: var(--app-text-muted, #94a3b8); flex: 0 0 auto; }
.mo-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mo-row > .mo-line { flex: 1; min-width: 180px; }
.mo-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.mo-chip { display: inline-flex; align-items: center; min-height: 22px; padding: 1px 8px; border-radius: 999px; background: var(--app-surface-subtle, #f1f5f9); color: var(--app-text-secondary, #475569); font-size: 12px; }
.mo-findings { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.mo-finding { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 12px; background: var(--app-surface-subtle, #f8fafc); }
.mo-finding > svg { width: 17px; height: 17px; flex: 0 0 auto; margin-top: 1px; color: var(--app-text-muted, #94a3b8); }
.mo-finding.is-warning > svg { color: var(--app-warning-text, #b45309); }
.mo-finding-copy { flex: 1; min-width: 0; display: grid; gap: 3px; }
.mo-finding-example { font-size: 12px; color: var(--app-text-secondary, #64748b); overflow-wrap: anywhere; }
.mo-editor { min-height: 200px; }
@media (max-width: 640px) {
  .mo-overlay { padding: var(--app-visual-offset-top, 0px) 0 0; align-items: flex-start; }
  .mo-panel { width: 100%; height: var(--app-visual-height, 100dvh); border-radius: 0; border: 0; }
  .mo-head { position: relative; padding-top: calc(14px + env(safe-area-inset-top, 0px)); }
  /* 系统深色时状态栏图标是白色：在状态栏后垫一层遮罩（同聊天页） */
  .mo-head::before { content: ''; position: absolute; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); background: linear-gradient(180deg, var(--app-statusbar-scrim, transparent) 50%, transparent); pointer-events: none; }
  .mo-body { padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px)); }
  .mo-btn { min-height: 36px; }
}
`;

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  documentRef.head.appendChild(style);
};

const KIND_LABELS = { private: '私聊', rp: '创意写作', group: '群聊', global: '全局／动态' };
const AUTO_WRITE_MODES = { inline: '随回复写入', separate: '单独请求写入' };

export const formatMemoryAge = (at, now = Date.now()) => {
  const time = Number(at);
  if (!Number.isFinite(time) || time <= 0) return '';
  const minutes = Math.floor(Math.max(0, now - time) / 60000);
  if (minutes < 1) return t('刚刚');
  if (minutes < 60) return t('{count} 分钟前', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('{count} 小时前', { count: hours });
  return t('{count} 天前', { count: Math.floor(hours / 24) });
};

/**
 * 把管家的 finding 变成一句话和「去处理」动作（由界面给文字，便于翻译）。
 * roomName(room) 给出聊天室名称。
 */
export const describeMemoryFinding = (finding = {}, { roomName = room => trim(room?.key), now = Date.now() } = {}) => {
  const p = finding.params || {};
  const where = { room: finding.room ? roomName(finding.room) : '', table: trim(p.tableName) };
  const roomAction = finding.room ? { kind: 'room', room: finding.room, label: t('打开表格') } : null;
  switch (finding.type) {
    case 'old_template_rows': return { text: t('旧模板「{template}」留下 {count} 条记忆，当前模板不会读取', { template: trim(p.templateId) || t('未命名'), count: p.count }), action: { kind: 'templates', label: t('模板管理') } };
    case 'empty_rows': return { text: t('「{room}」的「{table}」有 {count} 条空行', { ...where, count: p.count }), action: roomAction };
    case 'duplicate_rows': return { text: t('「{room}」的「{table}」有 {count} 条重复', { ...where, count: p.count }), examples: p.examples, action: roomAction };
    case 'similar_rows': return { text: t('「{room}」的「{table}」有 {count} 组内容几乎相同', { ...where, count: p.count }), examples: p.examples, action: roomAction };
    case 'over_max_rows': return { text: t('「{room}」的「{table}」有 {count} 条，超过上限 {max} 条', { ...where, count: p.count, max: p.maxRows }), action: roomAction };
    case 'long_summaries': return { text: t('「{room}」的「{table}」有 {count} 条摘要超过 {chars} 字', { ...where, count: p.count, chars: MEMORY_AUDIT_LIMITS.longSummaryChars }), action: roomAction };
    case 'unused_tables': return { text: t('有 {count} 张表这张卡从没写过：{names}', { count: p.count, names: (p.names || []).join('、') }), action: { kind: 'templates', label: t('模板管理') } };
    case 'injection_trimmed': return { text: t('上次发送有 {count} 条记忆因超出预算没有送出', { count: p.count }), action: { kind: 'current_room', label: t('打开表格') } };
    case 'shared_heavy': return { text: t('上次发送带入 {count} 条共享记忆（{sources}）', { count: p.count, sources: (p.sources || []).join('、') }), action: { kind: 'share', label: t('管理共享') } };
    case 'auto_write_off': return { text: t('自动写表已关闭，表格不会随对话更新'), action: { kind: 'auto_write', label: t('设置') } };
    default: return { text: trim(finding.type), action: null };
  }
};

/**
 * deps：
 * - load() → { cardName, templateName, card, session, sessionName }（见 memory-overview-model.js）
 * - roomName(room)、mountRoomEditor(container, room) → { destroy }
 * - runAudit({ sessionId }) → { report, checkedAt }
 * - openTemplates()、openShare(sessionId)、openAutoWriteSettings()、openPending()：跳到各自主界面（总览先关闭）
 */
export const createMemoryOverviewPanel = ({
  documentRef = globalThis.document,
  load = async () => null,
  roomName = room => trim(room?.key),
  mountRoomEditor = null,
  runAudit = null,
  openTemplates = null,
  openShare = null,
  openAutoWriteSettings = null,
  openPending = null,
  now = () => Date.now(),
} = {}) => {
  let overlay = null, body = null, titleEl = null, subtitleEl = null, backBtn = null;
  let data = null, audit = null, auditing = false, roomView = null, editorHandle = null, loadSeq = 0;

  const h = (tag, className = '', text = '') => {
    const el = documentRef.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  const userText = (tag, className, text) => {
    const el = h(tag, className, text);
    el.dataset.i18nSkip = '';
    return el;
  };
  const button = (label, onClick, className = 'mo-btn') => {
    const el = h('button', className, label);
    el.type = 'button';
    el.addEventListener('click', onClick);
    return el;
  };
  const nameOf = room => (room?.kind === 'global' ? t('全局／动态') : (trim(roomName(room)) || trim(room?.key)));

  const hide = () => {
    if (!overlay) return;
    closeEditor();
    roomView = null;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  };
  // 跳到别的主界面：先关总览，返回键与层级都交给目标界面
  const handOff = (open, ...args) => {
    if (typeof open !== 'function') return;
    hide();
    void Promise.resolve(open(...args));
  };
  const runAction = (action) => {
    if (!action) return;
    if (action.kind === 'room') openRoom(action.room);
    else if (action.kind === 'current_room') {
      const room = data?.session?.room;
      if (room) openRoom(room);
    } else if (action.kind === 'templates') handOff(openTemplates);
    else if (action.kind === 'share') handOff(openShare, data?.session?.sessionId);
    else if (action.kind === 'auto_write') handOff(openAutoWriteSettings);
    else if (action.kind === 'pending') handOff(openPending);
  };

  const closeEditor = () => {
    try { editorHandle?.destroy?.(); } catch {}
    editorHandle = null;
  };

  const renderHeader = () => {
    if (!titleEl) return;
    if (roomView) {
      titleEl.textContent = nameOf(roomView);
      subtitleEl.textContent = t('{kind} · 记忆表格', { kind: t(KIND_LABELS[roomView.kind] || '私聊') });
    } else {
      titleEl.textContent = t('记忆总览');
      subtitleEl.textContent = data?.cardName ? t('角色卡「{name}」', { name: data.cardName }) : '';
    }
    subtitleEl.dataset.i18nSkip = '';
    backBtn.hidden = !roomView;
  };

  const renderCard = () => {
    const card = data.card || { rooms: [], otherTemplates: [], totalRows: 0 };
    const section = h('section', 'mo-section');
    const head = h('div', 'mo-section-head');
    head.appendChild(h('h3', 'mo-section-title', t('整张卡')));
    head.appendChild(button(t('模板管理'), () => handOff(openTemplates)));
    section.appendChild(head);
    section.appendChild(userText('p', 'mo-muted', t('{rooms} 个聊天室 · {rows} 条 · 模板「{template}」', {
      rooms: card.rooms.filter(room => room.kind !== 'global').length, rows: card.totalRows, template: data.templateName || card.templateId,
    })));
    if (!card.rooms.length) section.appendChild(h('p', 'mo-muted', t('这张卡还没有记忆表格的内容。')));
    const list = h('div', 'mo-rooms');
    card.rooms.forEach((room) => {
      const item = button('', () => openRoom(room), 'mo-room');
      const copy = h('span', 'mo-room-copy');
      copy.appendChild(userText('span', 'mo-room-name', nameOf(room)));
      copy.appendChild(h('span', 'mo-room-meta', [
        room.kind === 'global' ? '' : t(KIND_LABELS[room.kind] || '私聊'),
        t('{count} 条', { count: room.rowCount }),
        room.inactiveCount ? t('{count} 条停用', { count: room.inactiveCount }) : '',
        formatMemoryAge(room.lastUpdatedAt, now()),
      ].filter(Boolean).join(' · ')));
      item.appendChild(copy);
      item.insertAdjacentHTML('beforeend', ICONS.chevron);
      list.appendChild(item);
    });
    section.appendChild(list);
    card.otherTemplates.forEach((other) => {
      section.appendChild(userText('p', 'mo-muted', t('旧模板「{template}」留下 {count} 条记忆，当前模板不会读取', { template: other.templateId || t('未命名'), count: other.rowCount })));
    });
    return section;
  };

  const renderAudit = () => {
    const section = h('section', 'mo-section');
    const head = h('div', 'mo-section-head');
    head.appendChild(h('h3', 'mo-section-title', t('记忆管家')));
    const check = button(auditing ? t('检查中…') : t('检查'), () => void startAudit(), 'mo-btn is-primary');
    check.disabled = auditing || typeof runAudit !== 'function';
    head.appendChild(check);
    section.appendChild(head);
    if (!audit) {
      section.appendChild(h('p', 'mo-muted', t('只读检查空行、重复、超出上限、旧模板留下的记忆和共享过多；不会改动记忆。')));
      return section;
    }
    if (audit.error) {
      section.appendChild(userText('p', 'mo-muted', t('检查失败：{message}', { message: audit.error })));
      return section;
    }
    const findings = audit.report?.findings || [];
    section.appendChild(h('p', 'mo-muted', findings.length
      ? t('{time}检查 · {count} 项', { time: formatMemoryAge(audit.checkedAt, now()), count: findings.length })
      : t('{time}检查 · 没有发现问题', { time: formatMemoryAge(audit.checkedAt, now()) })));
    if (!findings.length) return section;
    const list = h('ul', 'mo-findings');
    findings.forEach((finding) => {
      const described = describeMemoryFinding(finding, { roomName: nameOf, now: now() });
      const item = h('li', `mo-finding${finding.severity === 'warning' ? ' is-warning' : ''}`);
      item.insertAdjacentHTML('afterbegin', finding.severity === 'warning' ? ICONS.warning : ICONS.info);
      const copy = h('div', 'mo-finding-copy');
      copy.appendChild(userText('p', 'mo-line', described.text));
      (described.examples || []).forEach(example => copy.appendChild(userText('span', 'mo-finding-example', example)));
      item.appendChild(copy);
      if (described.action) item.appendChild(button(described.action.label, () => runAction(described.action)));
      list.appendChild(item);
    });
    section.appendChild(list);
    return section;
  };

  const renderSession = () => {
    const session = data.session;
    const section = h('section', 'mo-section');
    const head = h('div', 'mo-section-head');
    head.appendChild(userText('h3', 'mo-section-title', session?.sessionId ? t('当前会话「{name}」', { name: data.sessionName || session.sessionId }) : t('当前会话')));
    if (session?.room) head.appendChild(button(t('打开表格'), () => openRoom(session.room)));
    section.appendChild(head);
    if (!session?.sessionId) {
      section.appendChild(h('p', 'mo-muted', t('还没有打开会话。')));
      return section;
    }
    const injection = session.injection || {};
    const injectionText = {
      off: t('记忆没有使用表格模式。'),
      no_send: t('启动后这个会话还没发过消息；发送后这里会显示实际注入的记忆。'),
      other_session: t('上次发送是在别的会话；在这个会话发送后会显示实际注入的记忆。'),
      disabled: t('上次发送没有注入记忆。'),
    }[injection.state];
    if (injectionText) section.appendChild(h('p', 'mo-muted', injectionText));
    else {
      section.appendChild(h('p', 'mo-line', t('上次发送注入 {local} 条本会话记忆、{shared} 条共享记忆，约 {tokens} tokens', { local: injection.localRows, shared: injection.sharedRows, tokens: injection.tokens })));
      if (injection.trimmedRows) section.appendChild(h('p', 'mo-muted', t('裁掉 {count} 条（超出预算）', { count: injection.trimmedRows })));
    }
    const share = h('div', 'mo-row');
    const chips = h('div', 'mo-chips');
    (injection.shared || []).forEach(item => chips.appendChild(userText('span', 'mo-chip', `${t(item.label)} · ${t('{count} 条', { count: item.rowCount })}`)));
    share.appendChild(h('p', 'mo-line', t('跨模式共享')));
    if (chips.children.length) share.appendChild(chips);
    if (typeof openShare === 'function') share.appendChild(button(t('管理共享'), () => handOff(openShare, session.sessionId)));
    section.appendChild(share);
    const write = h('div', 'mo-row');
    write.appendChild(h('p', 'mo-line', session.autoWrite?.enabled
      ? t('自动写表：开 · {mode}', { mode: t(AUTO_WRITE_MODES[session.autoWrite.mode] || '随回复写入') })
      : t('自动写表：关')));
    if (typeof openAutoWriteSettings === 'function') write.appendChild(button(t('设置'), () => handOff(openAutoWriteSettings)));
    section.appendChild(write);
    const pending = h('div', 'mo-row');
    pending.appendChild(h('p', 'mo-line', session.pending?.count
      ? t('{count} 个记忆写入预览等待确认（最久 {age}）', { count: session.pending.count, age: formatMemoryAge(session.pending.oldestAt, now()) })
      : t('没有等待确认的记忆写入。')));
    if (session.pending?.count && typeof openPending === 'function') pending.appendChild(button(t('去确认'), () => handOff(openPending)));
    section.appendChild(pending);
    return section;
  };

  const render = () => {
    if (!body) return;
    renderHeader();
    if (roomView) return;
    closeEditor();
    body.replaceChildren();
    if (!data) {
      body.appendChild(h('p', 'mo-muted', t('正在读取记忆…')));
      return;
    }
    if (data.error) {
      body.appendChild(userText('p', 'mo-muted', t('读取记忆失败：{message}', { message: data.error })));
      return;
    }
    body.appendChild(renderCard());
    body.appendChild(renderSession());
    body.appendChild(renderAudit());
  };

  const openRoom = (room) => {
    if (!room || typeof mountRoomEditor !== 'function') return;
    roomView = room;
    closeEditor();
    body.replaceChildren();
    renderHeader();
    const container = h('div', 'mo-editor');
    body.appendChild(container);
    body.scrollTop = 0;
    try { editorHandle = mountRoomEditor(container, room); } catch (error) {
      container.appendChild(userText('p', 'mo-muted', t('读取记忆失败：{message}', { message: String(error?.message || error) })));
    }
  };
  const closeRoom = () => {
    if (!roomView) return false;
    roomView = null;
    closeEditor();
    void refresh();
    return true;
  };

  const refresh = async () => {
    const seq = ++loadSeq;
    try {
      const next = await load();
      if (seq !== loadSeq) return;
      data = next || { card: null, session: null };
    } catch (error) {
      if (seq !== loadSeq) return;
      data = { error: String(error?.message || error) };
    }
    render();
  };

  const startAudit = async () => {
    if (auditing || typeof runAudit !== 'function') return;
    auditing = true;
    render();
    try {
      const result = await runAudit({ sessionId: data?.session?.sessionId || '' });
      audit = { report: result?.report || null, checkedAt: result?.checkedAt || now() };
    } catch (error) {
      audit = { error: String(error?.message || error) };
    } finally {
      auditing = false;
      if (!roomView) render();
    }
  };

  const ensure = () => {
    if (overlay) return;
    injectStyle(documentRef);
    overlay = h('div', 'mo-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    const panel = h('div', 'mo-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = h('div', 'mo-head');
    backBtn = button('', () => closeRoom(), 'mo-icon-btn');
    backBtn.innerHTML = ICONS.back;
    backBtn.setAttribute('aria-label', t('返回'));
    backBtn.hidden = true;
    const copy = h('div', 'mo-head-copy');
    titleEl = h('h2', 'mo-title');
    titleEl.dataset.i18nSkip = '';
    subtitleEl = h('p', 'mo-subtitle');
    copy.appendChild(titleEl);
    copy.appendChild(subtitleEl);
    const closeBtn = button('', () => hide(), 'mo-icon-btn');
    closeBtn.innerHTML = ICONS.close;
    closeBtn.setAttribute('aria-label', t('关闭'));
    head.appendChild(backBtn);
    head.appendChild(copy);
    head.appendChild(closeBtn);
    body = h('div', 'mo-body');
    panel.appendChild(head);
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) hide(); });
    documentRef.body.appendChild(overlay);
  };

  const show = async ({ room = null } = {}) => {
    ensure();
    overlay.classList.add('is-open');
    overlay.setAttribute('aria-hidden', 'false');
    roomView = null;
    render();
    await refresh();
    if (room) openRoom(room);
  };

  return {
    show,
    hide,
    refresh,
    isOpen: () => Boolean(overlay?.classList.contains('is-open')),
    // 返回键：先退出聊天室表格，再关总览
    closeTopLayer: () => {
      if (!overlay?.classList.contains('is-open')) return false;
      if (closeRoom()) return true;
      hide();
      return true;
    },
    get overlay() { return overlay; },
  };
};
