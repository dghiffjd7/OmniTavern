const LABEL_SELECTOR = '[data-custom-select-label], .general-settings-custom-select-label, .config-custom-select-label, .pp-custom-select-label';

let customSelectMenuEl = null;
let customSelectMenuCleanup = null;
let customSelectMenuAnchor = null;
let customSelectIdSeed = 0;

const escapeHtml = (value = '') => String(value || '').replace(/[&<>"]/g, (ch) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[ch]));

const ensureCustomSelectId = (selectEl) => {
  if (!(selectEl instanceof HTMLElement)) return '';
  if (String(selectEl.id || '').trim()) return selectEl.id;
  customSelectIdSeed += 1;
  selectEl.id = `app-custom-select-${customSelectIdSeed}`;
  return selectEl.id;
};

const ensureCustomSelectMenu = () => {
  if (customSelectMenuEl) return customSelectMenuEl;
  const menu = document.createElement('div');
  menu.className = 'world-app-select-menu';
  menu.style.display = 'none';
  menu.addEventListener('click', (event) => event.stopPropagation());
  document.body.appendChild(menu);
  customSelectMenuEl = menu;
  return menu;
};

export const closeCustomSelectMenu = () => {
  if (typeof customSelectMenuCleanup === 'function') {
    try { customSelectMenuCleanup(); } catch {}
  }
  customSelectMenuCleanup = null;
  customSelectMenuAnchor = null;
  if (customSelectMenuEl) {
    customSelectMenuEl.style.display = 'none';
    customSelectMenuEl.innerHTML = '';
  }
};

export const getCustomSelectLabel = (selectEl, fallback = '请选择') => {
  const current = Array.from(selectEl?.options || []).find((opt) => opt.value === selectEl?.value)
    || selectEl?.options?.[selectEl?.selectedIndex]
    || null;
  return current?.textContent?.trim() || fallback;
};

export const refreshCustomSelectButton = (buttonEl, selectEl, fallback = '请选择') => {
  if (!(buttonEl instanceof HTMLElement) || !(selectEl instanceof HTMLElement)) return;
  const labelEl = buttonEl.querySelector(LABEL_SELECTOR);
  if (labelEl) labelEl.textContent = getCustomSelectLabel(selectEl, fallback);
  buttonEl.dataset.placeholder = fallback;
  const disabled = selectEl.disabled === true;
  buttonEl.disabled = disabled;
  buttonEl.classList.toggle('is-disabled', disabled);
};

export const openCustomSelectMenu = ({ anchorEl, options = [], currentValue = '', onSelect = null, onClose = null, menuClass = '' } = {}) => {
  if (!(anchorEl instanceof HTMLElement)) return;
  const isSameAnchorOpen =
    customSelectMenuAnchor === anchorEl &&
    customSelectMenuEl &&
    customSelectMenuEl.style.display !== 'none';
  if (isSameAnchorOpen) {
    closeCustomSelectMenu();
    return;
  }

  closeCustomSelectMenu();
  const menu = ensureCustomSelectMenu();
  if (menuClass) menu.classList.add(menuClass);
  const current = String(currentValue ?? '').trim();
  const opts = Array.isArray(options) ? options : [];
  menu.innerHTML = opts.map((opt) => {
    const value = String(opt?.value ?? '');
    const label = escapeHtml(String(opt?.label ?? value));
    const selected = value === current;
    return `
      <button type="button" class="world-app-select-item ${selected ? 'is-selected' : ''}" data-value="${value.replace(/"/g, '&quot;')}">
        <span class="world-app-select-item-label">${label}</span>
        <span class="world-app-select-item-check">${selected ? '✓' : ''}</span>
      </button>
    `;
  }).join('');

  let didSelect = false;
  const chooseItem = (item) => {
    if (didSelect || !(item instanceof HTMLElement)) return;
    didSelect = true;
      const value = String(item.dataset.value ?? '');
      if (typeof onSelect === 'function') onSelect(value);
      closeCustomSelectMenu();
  };
  menu.querySelectorAll('.world-app-select-item').forEach((item) => {
    item.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      chooseItem(item);
    });
    item.addEventListener('click', () => {
      chooseItem(item);
    });
  });

  menu.style.display = 'block';
  menu.style.visibility = 'hidden';
  menu.style.minWidth = `${Math.max(170, Math.round(anchorEl.getBoundingClientRect().width))}px`;
  menu.style.left = '0px';
  menu.style.top = '0px';

  const anchorRect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 6;
  let left = anchorRect.left;
  let top = anchorRect.bottom + gap;
  if (left + menuRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - menuRect.width - 8);
  }
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, anchorRect.top - menuRect.height - gap);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
  menu.style.visibility = 'visible';

  const onDocClick = (event) => {
    const target = event?.target;
    if (!target) return;
    if (menu.contains(target) || anchorEl.contains(target)) return;
    closeCustomSelectMenu();
  };
  const onResize = () => closeCustomSelectMenu();
  const onScroll = (event) => {
    const target = event?.target;
    if (target && (menu.contains(target) || anchorEl.contains(target))) return;
    closeCustomSelectMenu();
  };
  document.addEventListener('mousedown', onDocClick, true);
  document.addEventListener('touchstart', onDocClick, true);
  window.addEventListener('resize', onResize);
  window.addEventListener('scroll', onScroll, true);
  customSelectMenuCleanup = () => {
    document.removeEventListener('mousedown', onDocClick, true);
    document.removeEventListener('touchstart', onDocClick, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
    if (menuClass) menu.classList.remove(menuClass);
    onClose?.();
  };
  customSelectMenuAnchor = anchorEl;
  return menu;
};

export const bindCustomSelectButton = ({ buttonEl, selectEl, fallback = '请选择' } = {}) => {
  if (!(buttonEl instanceof HTMLElement) || !(selectEl instanceof HTMLElement)) return;
  ensureCustomSelectId(selectEl);
  if (buttonEl.dataset.bound === 'true') {
    refreshCustomSelectButton(buttonEl, selectEl, fallback);
    return;
  }
  buttonEl.dataset.bound = 'true';
  buttonEl.dataset.selectId = selectEl.id;
  buttonEl.addEventListener('click', () => {
    if (buttonEl.disabled) return;
    const options = Array.from(selectEl.options || []).map((opt) => ({
      value: opt.value,
      label: opt.textContent || opt.value,
    }));
    openCustomSelectMenu({
      anchorEl: buttonEl,
      options,
      currentValue: selectEl.value,
      onSelect: (value) => {
        if (selectEl.value !== value) {
          selectEl.value = value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          refreshCustomSelectButton(buttonEl, selectEl, fallback);
        }
      },
    });
  });
  selectEl.addEventListener('change', () => refreshCustomSelectButton(buttonEl, selectEl, fallback));
  refreshCustomSelectButton(buttonEl, selectEl, fallback);
};

export const createCustomSelectWrapper = (selectEl, {
  placeholder = '请选择',
  buttonClass = 'world-app-select-btn',
  labelClass = 'pp-custom-select-label',
  wrapperStyle = 'width:100%;',
  buttonStyle = '',
} = {}) => {
  if (!(selectEl instanceof HTMLElement)) return null;
  ensureCustomSelectId(selectEl);
  const wrap = document.createElement('div');
  wrap.style.cssText = wrapperStyle;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = buttonClass;
  if (buttonStyle) button.style.cssText = buttonStyle;
  button.dataset.selectId = selectEl.id;
  button.innerHTML = `
    <span class="${labelClass}" data-custom-select-label>${placeholder}</span>
    <span class="world-app-select-btn-chevron">▾</span>
  `;
  wrap.appendChild(button);
  // Do not move the <select> into the wrapper immediately.
  // Most call sites still do `parent.replaceChild(wrap, selectEl)`. If we append the
  // select first, its parent becomes `wrap`, and `replaceChild(wrap, selectEl)` throws:
  // "The new child element contains the parent."
  queueMicrotask(() => {
    if (!(wrap instanceof HTMLElement) || !(selectEl instanceof HTMLElement)) return;
    if (!wrap.isConnected) return;
    if (selectEl.parentNode === wrap) return;
    selectEl.style.display = 'none';
    wrap.prepend(selectEl);
  });
  return wrap;
};
