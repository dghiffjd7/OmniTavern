import { openCustomSelectMenu, closeCustomSelectMenu } from '../custom-select.js';
import { translateUiText } from '../../i18n/index.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const tr = value => escape(translateUiText(value));
export const realtimeReplyLanguageField = (id, value = '') => `
  <div class="api-config-realtime-field">
    <label for="${id}"><span class="has-help" data-help="${tr('通过通话指令引导角色的回复语言；可填写语言或口音，效果取决于模型与音色。留空时跟随对话。')}" data-help-mode="tap">${tr('回复语言')}</span></label>
    <div class="realtime-reply-language-picker">
      <input id="${id}" type="text" value="${escape(value)}" maxlength="80" autocomplete="off" placeholder="${tr('自动（跟随对话）')}">
      <button type="button" class="realtime-reply-language-toggle" aria-label="${tr('选择回复语言')}" aria-haspopup="menu" aria-expanded="false">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
      </button>
    </div>
  </div>`;

export const bindRealtimeReplyLanguagePicker = (input, { provider = 'openai' } = {}) => {
  const root = input?.closest('.realtime-reply-language-picker'), button = root?.querySelector('button');
  if (!button) return null;
  const doc = input.ownerDocument;
  let menu = null;
  const close = () => { if (menu) closeCustomSelectMenu(); };
  const menuKey = event => {
    if (!menu || (!menu.contains(event.target) && !root.contains(event.target))) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(); button.focus({ preventScroll: true }); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menu.querySelectorAll('button')], index = items.indexOf(doc.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
    items[next]?.focus();
  };
  const open = (keyboard = false) => {
    if (input.disabled || button.disabled) return;
    const labels = provider === 'nova_sonic'
      ? ['英文', '法语', '德语', '西班牙语']
      : ['普通话／中文', '台湾普通话', '粤语', '英文', '日文', '韩文', '法语', '德语', '西班牙语'];
    const options = [{ value: '', label: translateUiText('自动（跟随对话）') }, ...labels.map(label => ({ value: translateUiText(label), label: translateUiText(label) }))];
    const current = input.value.trim();
    const knownLabel = labels.find(label => label === current || translateUiText(label) === current);
    menu = openCustomSelectMenu({ anchorEl: root, options, currentValue: knownLabel ? translateUiText(knownLabel) : current, menuClass: 'realtime-reply-language-menu',
      onSelect: value => {
        if (input.disabled || button.disabled || !input.isConnected) return;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        button.focus({ preventScroll: true });
      },
      onClose: () => {
        menu?.removeAttribute('role'); menu?.removeAttribute('aria-label');
        menu = null; button.setAttribute('aria-expanded', 'false');
        doc.removeEventListener('keydown', menuKey, true);
      },
    });
    if (!menu) return;
    button.setAttribute('aria-expanded', 'true');
    menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', translateUiText('选择回复语言'));
    menu.querySelectorAll('button').forEach(item => {
      item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(item.classList.contains('is-selected')));
    });
    doc.addEventListener('keydown', menuKey, true);
    if (keyboard) (menu.querySelector('.is-selected') || menu.querySelector('button'))?.focus();
  };
  const click = event => open(event.detail === 0);
  const inputKey = event => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault(); event.stopPropagation(); open(true);
  };
  button.addEventListener('click', click);
  input.addEventListener('keydown', inputKey);
  input.addEventListener('input', close);
  return { close, destroy() { close(); button.removeEventListener('click', click); input.removeEventListener('keydown', inputKey); input.removeEventListener('input', close); } };
};
