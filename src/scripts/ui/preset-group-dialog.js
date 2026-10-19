// 预设分类的「管理分类」与「移到分类」对话框（设计页「管理分类 · 移到分类」；照联系人分组：颜色、行内确认删除）。
// 删除分类不删预设，里面的预设回到「未分类」；名称输入沿用 appPromptText。
import { CONTACT_GROUP_COLORS, resolveContactGroupColor } from '../storage/contact-group-color-utils.js';
import { appPromptText } from './app-confirm.js';
import { t } from '../i18n/index.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const COLOR_KEYS = Object.keys(CONTACT_GROUP_COLORS);
const ICONS = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"></path></svg>',
};

const REASON_TEXT = {
  empty_name: '分类名称不能为空',
  duplicate_name: '已有同名分类',
  save_failed: '保存失败，请重试',
  group_missing: '这个分类已不存在',
};
const warn = (result) => {
  if (result?.ok) return true;
  window.toastr?.warning?.(t(REASON_TEXT[result?.reason] || '操作失败'));
  return false;
};

const nextColor = (groups) => COLOR_KEYS[groups.length % COLOR_KEYS.length];

const askName = async ({ title, defaultValue = '' }) => {
  const name = await appPromptText({ title: t(title), placeholder: t('分类名称'), defaultValue, confirmText: t('确定') });
  return name === null ? null : String(name).trim();
};

const mountDialog = ({ title, className = '' }) => {
  const doc = document;
  const overlay = doc.createElement('div');
  overlay.className = 'preset-group-dialog-layer';
  overlay.innerHTML = `<div class="preset-group-dialog ${className}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="preset-group-dialog-head">
        <span class="preset-group-dialog-title" data-i18n-skip="true">${escapeHtml(title)}</span>
        <span data-preset-group-head-extra></span>
        <button type="button" class="preset-group-icon" data-preset-group-close aria-label="${escapeHtml(t('关闭'))}">${ICONS.close}</button>
      </div>
      <div class="preset-group-dialog-body" data-preset-group-body></div>
    </div>`;
  const body = overlay.querySelector('[data-preset-group-body]');
  let closed = false;
  const onKey = (event) => {
    if (event.key !== 'Escape' || doc.querySelector('.app-confirm-modal[style*="flex"]')) return;
    event.preventDefault();
    close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-preset-group-close]')) close();
  });
  doc.addEventListener('keydown', onKey);
  doc.body.appendChild(overlay);
  return { overlay, body, close, headExtra: overlay.querySelector('[data-preset-group-head-extra]') };
};

const countIn = (group, aliveIds) => (group.presetIds || []).filter(id => aliveIds.has(id)).length;

// 管理分类：新建、重命名、换颜色、删除（行内确认）；onAskMaid 存在时可交给女仆提出分法（确认后才移动）。
export const openPresetGroupManager = ({ store, getPresets = () => [], onChanged = () => {}, onAskMaid = null } = {}) => {
  if (!store) return null;
  const dialog = mountDialog({ title: t('预设分类'), className: 'is-manage' });
  let deletingId = '';
  dialog.headExtra.innerHTML = `<button type="button" class="preset-group-new" data-preset-group-create>${ICONS.plus}${escapeHtml(t('新建分类'))}</button>`;

  const render = () => {
    const presets = getPresets();
    const alive = new Set(presets.map(item => item.id));
    const groups = store.getGroups();
    const grouped = new Set(groups.flatMap(group => group.presetIds));
    const looseCount = presets.filter(item => !grouped.has(item.id)).length;
    const rows = groups.map(group => {
      const color = resolveContactGroupColor(group.color);
      const count = countIn(group, alive);
      if (group.id === deletingId) {
        return `<div class="preset-group-row is-deleting" data-group-id="${escapeHtml(group.id)}">
          <div class="preset-group-row-main"><span class="preset-group-dot" style="background:${color.value}" aria-hidden="true"></span><b data-i18n-skip="true">${escapeHtml(group.name)}</b></div>
          <p>${escapeHtml(t('删除后 {count} 个预设移入「未分类」，预设本身不会删除。', { count }))}</p>
          <div class="preset-group-row-actions">
            <button type="button" class="preset-group-btn" data-preset-group-delete-cancel>${escapeHtml(t('手滑了'))}</button>
            <button type="button" class="preset-group-btn is-danger" data-preset-group-delete-confirm="${escapeHtml(group.id)}">${escapeHtml(t('确认删除'))}</button>
          </div>
        </div>`;
      }
      return `<div class="preset-group-row" data-group-id="${escapeHtml(group.id)}">
        <button type="button" class="preset-group-color" data-preset-group-color="${escapeHtml(group.id)}" style="--preset-group-color:${color.value}" aria-label="${escapeHtml(t('换颜色：{name}', { name: group.name }))}" title="${escapeHtml(t(color.label))}"></button>
        <div class="preset-group-row-copy"><b data-i18n-skip="true">${escapeHtml(group.name)}</b><span>${escapeHtml(t('{count} 个预设', { count }))}</span></div>
        <button type="button" class="preset-group-icon" data-preset-group-rename="${escapeHtml(group.id)}" aria-label="${escapeHtml(t('重命名：{name}', { name: group.name }))}">${ICONS.edit}</button>
        <button type="button" class="preset-group-icon" data-preset-group-delete="${escapeHtml(group.id)}" aria-label="${escapeHtml(t('删除分类：{name}', { name: group.name }))}">${ICONS.trash}</button>
      </div>`;
    }).join('');
    dialog.body.innerHTML = `${groups.length ? rows : `<p class="preset-group-hint">${escapeHtml(t('还没有分类。新建分类后，在预设选单里点「⋯」把预设移进去。'))}</p>`}
      <div class="preset-group-row is-loose">
        <span class="preset-group-dot" aria-hidden="true"></span>
        <div class="preset-group-row-copy"><b>${escapeHtml(t('未分类'))}</b><span>${escapeHtml(t('{count} 个预设 · 固定在最后', { count: looseCount }))}</span></div>
      </div>
      ${typeof onAskMaid === 'function' ? `<button type="button" class="preset-group-maid" data-preset-group-maid>${escapeHtml(t('让女仆帮忙分类'))}</button>
      <p class="preset-group-hint">${escapeHtml(t('女仆按预设名称提出分法，先列出来给你看，确认后才移动。'))}</p>` : ''}`;
  };

  const changed = () => { render(); onChanged(); };

  dialog.overlay.addEventListener('click', async (event) => {
    const target = event.target;
    if (target.closest('[data-preset-group-create]')) {
      const name = await askName({ title: '新建分类' });
      if (name === null) return;
      if (warn(await store.createGroup(name, nextColor(store.getGroups())))) changed();
      return;
    }
    const rename = target.closest('[data-preset-group-rename]');
    if (rename) {
      const group = store.getGroups().find(item => item.id === rename.dataset.presetGroupRename);
      if (!group) return;
      const name = await askName({ title: '重命名分类', defaultValue: group.name });
      if (name === null || name === group.name) return;
      if (warn(await store.renameGroup(group.id, name))) changed();
      return;
    }
    const color = target.closest('[data-preset-group-color]');
    if (color) {
      const group = store.getGroups().find(item => item.id === color.dataset.presetGroupColor);
      if (!group) return;
      const next = COLOR_KEYS[(COLOR_KEYS.indexOf(group.color) + 1) % COLOR_KEYS.length];
      if (warn(await store.setGroupColor(group.id, next))) changed();
      return;
    }
    if (target.closest('[data-preset-group-maid]')) { dialog.close(); onAskMaid?.(); return; }
    const del = target.closest('[data-preset-group-delete]');
    if (del) { deletingId = del.dataset.presetGroupDelete; render(); return; }
    if (target.closest('[data-preset-group-delete-cancel]')) { deletingId = ''; render(); return; }
    const confirm = target.closest('[data-preset-group-delete-confirm]');
    if (confirm) {
      deletingId = '';
      if (warn(await store.deleteGroup(confirm.dataset.presetGroupDeleteConfirm))) changed();
      else render();
    }
  });

  render();
  return { close: dialog.close };
};

// 移到分类：点一下就移动并关闭；也可以当场新建分类。
export const openPresetMoveDialog = ({ store, presetId = '', presetName = '', onChanged = () => {} } = {}) => {
  if (!store || !presetId) return null;
  const dialog = mountDialog({ title: t('把「{name}」移到', { name: presetName || presetId }), className: 'is-move' });
  const render = () => {
    const current = store.getGroupOfPreset(presetId)?.id || '';
    const option = (id, name, color) => `<button type="button" class="preset-group-option${id === current ? ' is-current' : ''}" data-preset-group-move="${escapeHtml(id)}" aria-pressed="${id === current}">
        <span class="preset-group-dot" style="${color ? `background:${color}` : ''}" aria-hidden="true"></span>
        <span data-i18n-skip="true">${escapeHtml(name)}</span>${id === current ? '<span class="preset-picker-check" aria-hidden="true">✓</span>' : ''}
      </button>`;
    dialog.body.innerHTML = `${store.getGroups().map(group => option(group.id, group.name, resolveContactGroupColor(group.color).value)).join('')}
      ${option('', t('未分类'), '')}
      <button type="button" class="preset-group-option is-create" data-preset-group-create>${ICONS.plus}${escapeHtml(t('新建分类…'))}</button>`;
  };
  dialog.overlay.addEventListener('click', async (event) => {
    const move = event.target.closest('[data-preset-group-move]');
    if (move) {
      if (warn(await store.movePreset(presetId, move.dataset.presetGroupMove))) { dialog.close(); onChanged(); }
      return;
    }
    if (event.target.closest('[data-preset-group-create]')) {
      const name = await askName({ title: '新建分类' });
      if (name === null) return;
      const created = await store.createGroup(name, nextColor(store.getGroups()));
      if (!warn(created)) return;
      if (warn(await store.movePreset(presetId, created.group.id))) { dialog.close(); onChanged(); }
      else render();
    }
  });
  render();
  return { close: dialog.close };
};
