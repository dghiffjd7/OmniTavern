// Agent 目录（Agent 能力注册计划 Phase B）：统一 Agent Registry 的只读视图——女仆 Sub-agent、文字与输入 Agent、女仆技能一处看全。
// 每项列出模型、触发方式与开关状态；「设置」跳到它原本的设置位置（先关目录），目录本身不改任何配置。
import { t } from '../i18n/index.js';

const STYLE_ID = 'agent-directory-style';
const trim = value => String(value ?? '').trim();

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g></svg>`;
const ICONS = Object.freeze({
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  chevron: svg('<path d="m9 18 6-6-6-6"/>'),
  sub_agent: svg('<path d="m13 2-8 12h7l-1 8 8-12h-7Z"/>'),
  text_edit: svg('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  input_agent: svg('<rect x="3" y="6" width="18" height="12" rx="3"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>'),
  input_suggestion: svg('<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8Z"/>'),
  format_review: svg('<path d="M12 3 5 6v5c0 4.4 3 8.1 7 9 4-.9 7-4.6 7-9V6Z"/><path d="m9 12 2 2 4-4"/>'),
  archive_naming: svg('<path d="M20 12 12 20l-8-8V4h8Z"/><circle cx="8.5" cy="8.5" r="1.5"/>'),
  maid_skill: svg('<path d="M5 4h10a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4Z"/><path d="M9 9h6M9 13h4"/>'),
});

const ROLES = Object.freeze({
  sub_agent: { label: 'Sub-agent', group: 'sub_agent' },
  text_edit: { label: '正文 Agent', group: 'text' },
  input_agent: { label: '输入 Agent', group: 'text' },
  input_suggestion: { label: '文本建议', group: 'text' },
  format_review: { label: '格式修复', group: 'text' },
  archive_naming: { label: '小管家', group: 'text' },
  maid_skill: { label: '女仆技能', group: 'skill' },
});
const GROUPS = Object.freeze([
  { id: 'sub_agent', title: '女仆 Sub-agent', caption: '女仆委派长文、批量等工作时使用的模型' },
  { id: 'text', title: '文字与输入 Agent', caption: '正文润色、输入助手、格式修复等' },
  { id: 'skill', title: '女仆技能', caption: '女仆处理一类任务的流程' },
]);
const FILTERS = Object.freeze([['all', '全部'], ['sub_agent', 'Sub-agent'], ['text', '文字与输入'], ['skill', '女仆技能']]);

const STYLE = `
.ad-overlay { position: fixed; inset: 0; z-index: 22600; display: none; align-items: center; justify-content: center; padding: 12px; background: rgba(15, 23, 42, 0.34); }
.ad-overlay.is-open { display: flex; }
.ad-panel { width: min(760px, 100%); height: min(800px, calc(var(--app-visual-height, 100dvh) - 24px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 22px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22); }
.ad-head { display: flex; align-items: center; gap: 12px; padding: 16px 18px 12px; }
.ad-head-copy { flex: 1; min-width: 0; }
.ad-title { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: .01em; }
.ad-subtitle { margin: 3px 0 0; font-size: 12.5px; color: var(--app-text-secondary, #64748b); }
.ad-close { width: 36px; height: 36px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 50%; background: transparent; color: var(--app-text-secondary, #475569); cursor: pointer; }
.ad-close:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.ad-close svg { width: 18px; height: 18px; }
.ad-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 0 18px 12px; border-bottom: 1px solid var(--app-border-default, #e2e8f0); }
.ad-filters { display: inline-flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--app-surface-subtle, #f1f5f9); }
.ad-filter { min-height: 30px; padding: 0 12px; border: 0; border-radius: 999px; background: transparent; color: var(--app-text-secondary, #475569); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; transition: background 160ms ease, color 160ms ease; }
.ad-filter.is-active { background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); box-shadow: 0 1px 3px rgba(15, 23, 42, .12); }
.ad-only-on { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: var(--app-text-secondary, #475569); cursor: pointer; user-select: none; }
.ad-only-on input { accent-color: var(--app-accent-primary, #2563eb); width: 15px; height: 15px; }
.ad-body { flex: 1; min-height: 0; overflow: auto; padding: 14px 18px 22px; display: grid; gap: 18px; align-content: start; }
.ad-body > * { min-width: 0; }
.ad-group { display: grid; gap: 8px; }
.ad-group-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ad-group-title { margin: 0; font-size: 13.5px; font-weight: 800; }
.ad-group-caption { font-size: 12px; color: var(--app-text-muted, #94a3b8); }
.ad-count { display: inline-flex; min-width: 20px; height: 20px; align-items: center; justify-content: center; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 12%, transparent); color: var(--app-accent-primary, #2563eb); font-size: 11.5px; font-weight: 800; }
.ad-list { display: grid; gap: 8px; }
.ad-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 16px; background: var(--app-surface-card, #fff); color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease; }
.ad-item:hover { border-color: color-mix(in srgb, var(--app-accent-primary, #2563eb) 38%, transparent); box-shadow: 0 6px 18px rgba(15, 23, 42, .06); transform: translateY(-1px); }
.ad-item.is-off .ad-icon { background: var(--app-surface-subtle, #f1f5f9); color: var(--app-text-muted, #94a3b8); }
.ad-item.is-off .ad-name { color: var(--app-text-secondary, #64748b); }
.ad-icon { width: 40px; height: 40px; flex: 0 0 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 13px; background: linear-gradient(140deg, color-mix(in srgb, var(--app-accent-primary, #2563eb) 18%, transparent), color-mix(in srgb, var(--app-accent-primary, #2563eb) 6%, transparent)); color: var(--app-accent-primary, #2563eb); }
.ad-icon svg { width: 20px; height: 20px; }
.ad-copy { flex: 1; min-width: 0; display: grid; gap: 4px; }
.ad-name-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ad-name { font-size: 14px; font-weight: 800; overflow-wrap: anywhere; }
.ad-chip { display: inline-flex; align-items: center; min-height: 19px; padding: 0 7px; border-radius: 6px; background: var(--app-surface-subtle, #f1f5f9); color: var(--app-text-secondary, #64748b); font-size: 11px; font-weight: 700; }
.ad-chip.is-user { background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-accent-primary, #2563eb); }
.ad-meta { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 12.5px; line-height: 1.5; color: var(--app-text-secondary, #64748b); overflow-wrap: anywhere; }
.ad-state { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; font-size: 12px; font-weight: 700; color: var(--app-text-muted, #94a3b8); }
.ad-state i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.ad-state.is-on { color: var(--app-success-text, #059669); }
.ad-item > svg { width: 16px; height: 16px; flex: 0 0 auto; color: var(--app-text-muted, #94a3b8); }
.ad-empty { margin: 0; padding: 32px 16px; border: 1px dashed var(--app-border-default, #cbd5e1); border-radius: 16px; text-align: center; font-size: 13px; color: var(--app-text-secondary, #64748b); }
body[data-reduced-motion='on'] .ad-item, body[data-reduced-motion='on'] .ad-filter { transition: none; }
@media (prefers-reduced-motion: reduce) { .ad-item, .ad-filter { transition: none; } .ad-item:hover { transform: none; } }
@media (max-width: 640px) {
  .ad-overlay { padding: var(--app-visual-offset-top, 0px) 0 0; align-items: flex-start; }
  .ad-panel { width: 100%; height: var(--app-visual-height, 100dvh); border-radius: 0; border: 0; }
  .ad-head { position: relative; padding-top: calc(16px + env(safe-area-inset-top, 0px)); }
  /* 系统深色时状态栏图标是白色：在状态栏后垫一层遮罩（同聊天页） */
  .ad-head::before { content: ''; position: absolute; inset: 0 0 auto; height: env(safe-area-inset-top, 0px); background: linear-gradient(180deg, var(--app-statusbar-scrim, transparent) 50%, transparent); pointer-events: none; }
  .ad-body { padding-bottom: calc(22px + env(safe-area-inset-bottom, 0px)); }
  .ad-item { padding: 12px; }
  .ad-filter { min-height: 34px; }
}
`;

const injectStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLE;
  documentRef.head.appendChild(style);
};

export const agentDirectoryGroupOf = agent => ROLES[trim(agent?.role)]?.group || 'text';

/** 一项的说明行：模型、触发方式、预算、工具数。describeModel(agent) 给出模型名称。 */
export const describeAgentDirectoryMeta = (agent = {}, { describeModel = () => '' } = {}) => {
  const parts = [];
  if (agent.role === 'maid_skill') {
    if (trim(agent.summary)) parts.push(trim(agent.summary));
    parts.push(agent.invocation === 'manual' ? t('仅手动使用') : t('女仆可自动选用'));
    return parts.join(' · ');
  }
  const model = trim(describeModel(agent));
  if (agent.modelMode === 'follow_current') parts.push(t('跟随当前对话的模型'));
  else if (model) parts.push(t('模型：{model}', { model }));
  else parts.push(t('未选模型'));
  if (agent.role === 'sub_agent') parts.push(t('由女仆委派'));
  else parts.push(agent.invocation === 'manual' ? t('手动触发') : t('自动触发'));
  const budgets = agent.budgets || {};
  if (Number(budgets.timeMs) > 0) parts.push(t('时间上限 {seconds} 秒', { seconds: Math.round(Number(budgets.timeMs) / 1000) }));
  if (Number(budgets.tokens) > 0) parts.push(t('输出上限 {tokens} tokens', { tokens: Number(budgets.tokens) }));
  if (Number(agent.tools) > 0) parts.push(t('可查 {count} 个工具', { count: Number(agent.tools) }));
  return parts.join(' · ');
};

/**
 * listAgents() → Registry 的全部记录；describeModel(agent) → 模型名称；openAgent(agent) → 跳到它的设置位置。
 * prepare()：打开时等它完成后再画一次（例如模型档列表刚启动还没载入）。
 */
export const createAgentDirectoryPanel = ({
  documentRef = globalThis.document,
  listAgents = () => [],
  describeModel = () => '',
  openAgent = null,
  prepare = null,
} = {}) => {
  let overlay = null, body = null, subtitle = null, filtersEl = null, onlyOn = null;
  let filter = 'all';

  const h = (tag, className = '', text = '') => {
    const el = documentRef.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };

  const hide = () => {
    if (!overlay) return;
    overlay.classList.remove('is-open');
    overlay.setAttribute('aria-hidden', 'true');
  };

  const renderItem = (agent) => {
    const on = agent.enabled !== false;
    const item = h('button', `ad-item${on ? '' : ' is-off'}`);
    item.type = 'button';
    item.dataset.agentId = trim(agent.id);
    const icon = h('span', 'ad-icon');
    icon.innerHTML = ICONS[trim(agent.role)] || ICONS.text_edit;
    const copy = h('span', 'ad-copy');
    const nameRow = h('span', 'ad-name-row');
    const name = h('span', 'ad-name', trim(agent.name) || trim(agent.id));
    name.dataset.i18nSkip = '';
    nameRow.appendChild(name);
    // 类型标签只在「文字与输入」组里、且和名称不同才显示（其他组的标题已经说明类型）
    const roleLabel = t(ROLES[trim(agent.role)]?.label || '正文 Agent');
    if (agentDirectoryGroupOf(agent) === 'text' && roleLabel !== name.textContent) nameRow.appendChild(h('span', 'ad-chip', roleLabel));
    if (agent.custom === true || agent.ref?.namespace === 'user') nameRow.appendChild(h('span', 'ad-chip is-user', t('自建')));
    copy.appendChild(nameRow);
    const meta = h('span', 'ad-meta', describeAgentDirectoryMeta(agent, { describeModel }));
    meta.dataset.i18nSkip = '';
    copy.appendChild(meta);
    const state = h('span', `ad-state${on ? ' is-on' : ''}`);
    state.appendChild(h('i'));
    state.appendChild(h('span', '', on ? t('已开启') : t('已关闭')));
    item.appendChild(icon);
    item.appendChild(copy);
    item.appendChild(state);
    if (typeof openAgent === 'function') {
      item.insertAdjacentHTML('beforeend', ICONS.chevron);
      item.setAttribute('aria-label', t('打开「{name}」的设置', { name: trim(agent.name) || trim(agent.id) }));
      item.addEventListener('click', () => {
        hide();
        void Promise.resolve(openAgent(agent));
      });
    }
    return item;
  };

  const render = () => {
    if (!body) return;
    let agents = [];
    try { agents = listAgents() || []; } catch {}
    const enabledCount = agents.filter(agent => agent.enabled !== false).length;
    subtitle.textContent = t('共 {count} 个 · 已开启 {enabled} 个', { count: agents.length, enabled: enabledCount });
    filtersEl.querySelectorAll('.ad-filter').forEach(button => button.classList.toggle('is-active', button.dataset.filter === filter));
    const visible = agents.filter(agent => (filter === 'all' || agentDirectoryGroupOf(agent) === filter) && (!onlyOn.checked || agent.enabled !== false));
    body.replaceChildren();
    if (!visible.length) {
      body.appendChild(h('p', 'ad-empty', agents.length ? t('没有符合条件的 Agent') : t('还没有 Agent。')));
      return;
    }
    GROUPS.forEach((group) => {
      const items = visible.filter(agent => agentDirectoryGroupOf(agent) === group.id);
      if (!items.length) return;
      const section = h('section', 'ad-group');
      const head = h('div', 'ad-group-head');
      head.appendChild(h('h3', 'ad-group-title', t(group.title)));
      head.appendChild(h('span', 'ad-count', String(items.length)));
      head.appendChild(h('span', 'ad-group-caption', t(group.caption)));
      section.appendChild(head);
      const list = h('div', 'ad-list');
      items.forEach(agent => list.appendChild(renderItem(agent)));
      section.appendChild(list);
      body.appendChild(section);
    });
  };

  const ensure = () => {
    if (overlay) return;
    injectStyle(documentRef);
    overlay = h('div', 'ad-overlay');
    overlay.setAttribute('aria-hidden', 'true');
    const panel = h('div', 'ad-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = h('div', 'ad-head');
    const copy = h('div', 'ad-head-copy');
    copy.appendChild(h('h2', 'ad-title', t('Agent 目录')));
    subtitle = h('p', 'ad-subtitle');
    subtitle.dataset.i18nSkip = '';
    copy.appendChild(subtitle);
    const close = h('button', 'ad-close');
    close.type = 'button';
    close.innerHTML = ICONS.close;
    close.setAttribute('aria-label', t('关闭'));
    close.addEventListener('click', () => hide());
    head.appendChild(copy);
    head.appendChild(close);
    const toolbar = h('div', 'ad-toolbar');
    filtersEl = h('div', 'ad-filters');
    filtersEl.setAttribute('role', 'tablist');
    FILTERS.forEach(([id, label]) => {
      const button = h('button', 'ad-filter', t(label));
      button.type = 'button';
      button.dataset.filter = id;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => { filter = id; render(); });
      filtersEl.appendChild(button);
    });
    const onlyOnLabel = h('label', 'ad-only-on');
    onlyOn = h('input');
    onlyOn.type = 'checkbox';
    onlyOn.addEventListener('change', () => render());
    onlyOnLabel.appendChild(onlyOn);
    onlyOnLabel.appendChild(h('span', '', t('只看已开启')));
    toolbar.appendChild(filtersEl);
    toolbar.appendChild(onlyOnLabel);
    body = h('div', 'ad-body');
    panel.appendChild(head);
    panel.appendChild(toolbar);
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) hide(); });
    documentRef.body.appendChild(overlay);
  };

  return {
    show: async () => {
      ensure();
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
      render();
      if (typeof prepare !== 'function') return;
      try { await prepare(); } catch {}
      if (overlay.classList.contains('is-open')) render();
    },
    hide,
    refresh: render,
    isOpen: () => Boolean(overlay?.classList.contains('is-open')),
    closeTopLayer: () => {
      if (!overlay?.classList.contains('is-open')) return false;
      hide();
      return true;
    },
    get overlay() { return overlay; },
  };
};
