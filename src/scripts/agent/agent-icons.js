// Shared by AC identity and the toolbox. Stored values are names, never markup.
export const AGENT_ICONS = Object.freeze({
  suggest: { label: '输入建议', path: '<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/>' },
  check: { label: '格式检查', path: '<path d="M7 3h10l3 3v15H4V3h3ZM8 12l3 3 5-6"/>' },
  pen: { label: '正文编辑', path: '<path d="m14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14v6Z"/>' },
  book: { label: '资料', path: '<path d="M12 5v16M3 4c4-1 6 0 9 1 3-1 5-2 9-1v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z"/>' },
  search: { label: '查找', path: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>' },
  translate: { label: '翻译', path: '<path d="M3 5h12M9 3v2M5 5c0 5 3 8 8 10M13 5c0 4-4 8-10 10M13 21l4-10 4 10M15 17h4"/>' },
  spark: { label: '灵感', path: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>' },
  list: { label: '整理', path: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>' },
});
export const normalizeAgentIcon = value => Object.hasOwn(AGENT_ICONS, value) ? value : '';
export const isAgentNoteConfig = config => config?.kind === 'input_agent' || String(config?.id).startsWith('input-agent:')
  ? config?.inputOutput === 'note' : config?.outputMode === 'note';
export const getAgentIconName = config => normalizeAgentIcon(config?.icon) || (config?.id === 'text_completion' || config?.kind === 'input_suggestion' ? 'suggest'
  : config?.id === 'reply_check' || config?.kind === 'format_review' ? 'check' : isAgentNoteConfig(config) ? 'book' : 'pen');
const controls = {
  toolbox: '<rect x="3" y="7" width="18" height="13" rx="3"/><path d="M8 7V4h8v3M3 12h18M10 12v3h4v-3"/>',
  settings: '<path d="m9 3-.6 2.4-2 .9L4 5.6 2.5 8l1.8 1.7-.2 2.3L2.5 14 4 16.5l2.3-.4L8 17.4l.5 2.6h3l.8-2.4 2-.9 2.4.7 1.5-2.4-1.8-1.7.2-2.3 1.6-2L16.7 6l-2.3.4L12.7 5l-.5-2H9Z" transform="translate(1 1)"/><circle cx="11.5" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', back: '<path d="m14 5-7 7 7 7"/>',
  forward: '<path d="m10 5 7 7-7 7"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5.1 8a8 8 0 0 1 13.2-2L20 8M4 16l1.7 2A8 8 0 0 0 18.9 16"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/>',
  visible: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  hidden: '<path d="m3 3 18 18M10.6 5.1 12 5c6 0 10 7 10 7a23 23 0 0 1-3 3.7M6.5 6.5A23 23 0 0 0 2 12s4 7 10 7c1.8 0 3.4-.6 4.8-1.5M10 10a3 3 0 0 0 4 4"/>',
  up: '<path d="m6 14 6-6 6 6"/>', down: '<path d="m6 10 6 6 6-6"/>',
  select: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M8 9h8M8 13h8M8 17h4"/>',
};
export const agentIconMarkup = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${AGENT_ICONS[name]?.path || controls[name] || AGENT_ICONS.pen.path}</svg>`;
