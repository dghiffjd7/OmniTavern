import { t } from '../i18n/index.js';
import { renderMaidMarkdownHtml } from './maid-markdown-utils.js';
import { maidSkillMessage } from './maid-skill-messages.js';
import { pickSavePath, hasTauriRuntime } from '../utils/save-dialog.js';
import { safeInvoke } from '../utils/tauri.js';

export const skillElement = (doc, tag, text = '', className = '') => {
  const el = doc.createElement(tag); el.className = className; el.textContent = text; return el;
};
export const skillButton = (doc, label, action, className = '') => {
  const el = skillElement(doc, 'button', label, `maid-skill-button ${className}`);
  el.type = 'button'; el.addEventListener('click', action); return el;
};
export const skillUserText = (doc, tag, text, className = '') => {
  const el = skillElement(doc, tag, text, className); el.dataset.i18nSkip = ''; return el;
};
export const injectMaidSkillStyle = doc => {
  if (doc.getElementById('maid-skill-style')) return;
  const style = skillElement(doc, 'style'); style.id = 'maid-skill-style';
  style.textContent = `
.maid-skills {--skill-accent:var(--app-accent-primary,#2563eb);--skill-accent-rgb:var(--app-accent-rgb,37,99,235);--skill-line:color-mix(in srgb,var(--app-border-default,#cbd5e1) 78%,transparent);min-width:0;color:var(--app-text-primary,#111827);font-size:14px;line-height:1.6}
.maid-skill-toolbar {display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.maid-skill-toolbar h3 {margin:0 auto 0 0;font-size:15px;font-weight:800;letter-spacing:.01em}
.maid-skill-toolbar.is-compact {margin:0}
.maid-settings-section.maid-skills {gap:12px}
.maid-settings-section.maid-skills>* {margin-top:0;margin-bottom:0}
.maid-settings-section.maid-skills>.maid-skill-searchbar {margin-top:2px}
.maid-skill-button {display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:13px;font-weight:700;color:inherit;background:var(--app-surface-card,#fff);border:1px solid var(--app-border-default,#cbd5e1);border-radius:10px;min-height:34px;padding:5px 13px;cursor:pointer;transition:background 120ms ease,border-color 120ms ease,transform 90ms ease;touch-action:manipulation}
.maid-skill-button:hover {border-color:rgba(var(--skill-accent-rgb),.32);background:var(--app-surface-subtle,#f8fafc)}
.maid-skill-button:active {transform:translateY(1px)}
.maid-skill-button.primary {background:var(--skill-accent);color:var(--app-text-inverse,#fff);border-color:transparent;box-shadow:0 8px 16px -12px rgba(var(--skill-accent-rgb),.9)}
.maid-skill-button.primary:hover {background:color-mix(in srgb,var(--skill-accent) 88%,var(--app-text-primary,#111827))}
.maid-skill-button.danger {color:var(--app-danger-text,#dc2626)}
.maid-skill-button.danger:hover {background:var(--app-danger-soft,rgba(220,38,38,.08));border-color:var(--app-danger-border,rgba(220,38,38,.28))}
.maid-skill-button.ghost {border-color:transparent;background:transparent;min-height:28px;padding:3px 9px;font-size:12px;color:var(--app-text-secondary,#475569)}
.maid-skill-button.ghost:hover {background:var(--app-surface-hover,#f1f5f9);color:var(--app-text-primary,#111827)}
.maid-skill-button.ghost.danger {color:var(--app-danger-text,#dc2626)}
.maid-skill-button.ghost.danger:hover {background:var(--app-danger-soft,rgba(220,38,38,.08))}
.maid-skill-button:disabled {opacity:.45;cursor:default;transform:none}
.maid-skills :focus-visible,.maid-skill-dialog :focus-visible {outline:2px solid var(--skill-accent);outline-offset:2px}
.maid-skills input[type=checkbox] {accent-color:var(--skill-accent);width:16px;height:16px;flex:0 0 auto}
.maid-skill-muted {color:var(--app-text-secondary,#64748b);font-size:12.5px}
.maid-skill-intro {margin:0 0 12px}
.maid-skill-summary {display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
.maid-skill-tag {display:inline-flex;align-items:center;min-height:20px;padding:1px 8px;border-radius:6px;background:var(--app-surface-subtle,#f1f5f9);color:var(--app-text-secondary,#64748b);font-size:11px;font-weight:650;line-height:1.5;white-space:nowrap}
.maid-skill-tag.is-accent {background:rgba(var(--skill-accent-rgb),.09);color:var(--skill-accent)}
.maid-skill-tag.is-off {background:color-mix(in srgb,var(--app-text-muted,#94a3b8) 14%,transparent);color:var(--app-text-muted,#94a3b8)}
.maid-skill-tags {display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.maid-skill-searchbar {display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-bottom:14px}
.maid-skill-searchbar .maid-skill-field {display:flex;align-items:center;gap:8px}
.maid-skill-searchbar .maid-skill-field>span {font-size:12px;color:var(--app-text-secondary,#64748b);white-space:nowrap}
.maid-skill-searchbar select {width:auto;min-width:108px}
.maid-skill-list {display:grid;gap:10px}
.maid-skill-row {display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border:1px solid var(--skill-line);border-radius:16px;background:var(--app-surface-card,#fff);box-shadow:0 1px 2px rgba(15,23,42,.03);transition:border-color 160ms ease,box-shadow 160ms ease}
.maid-skill-row:hover {border-color:rgba(var(--skill-accent-rgb),.28)}
.maid-skill-row.is-disabled .maid-skill-title,.maid-skill-row.is-disabled .maid-skill-description {opacity:.62}
.maid-skill-row>input[type=checkbox] {margin-top:3px}
.maid-skill-copy {flex:1;min-width:0;overflow-wrap:anywhere}
.maid-skill-copy p {margin:4px 0 0}
.maid-skill-description {display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.maid-skill-button.maid-skill-title {display:block;border:0;background:none;padding:0;min-height:0;text-align:left;font-size:14px;font-weight:800;line-height:1.45;box-shadow:none}
.maid-skill-button.maid-skill-title:hover {background:none;color:var(--skill-accent)}
.maid-skill-row-footer {display:flex;gap:2px;flex-wrap:wrap;margin:8px 0 0 -9px}
.maid-skill-row-actions {display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:0 0 auto}
.maid-skill-switch {display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:12px;font-weight:700;color:var(--app-text-secondary,#64748b);user-select:none}
.maid-skills .maid-skill-switch input[type=checkbox] {appearance:none;-webkit-appearance:none;position:relative;width:34px;height:20px;margin:0;border-radius:999px;background:color-mix(in srgb,var(--app-text-muted,#94a3b8) 48%,transparent);cursor:pointer;transition:background 160ms ease}
.maid-skills .maid-skill-switch input[type=checkbox]::before {content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--app-text-on-accent,#fff);box-shadow:0 1px 3px rgba(15,23,42,.24);transition:transform 160ms cubic-bezier(.22,1,.36,1)}
.maid-skills .maid-skill-switch input[type=checkbox]:checked {background:var(--skill-accent)}
.maid-skills .maid-skill-switch input[type=checkbox]:checked::before {transform:translateX(14px)}
.maid-skill-notice {display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 14px;border:1px solid color-mix(in srgb,var(--app-warning-text,#b45309) 26%,transparent);border-radius:14px;background:color-mix(in srgb,var(--app-warning-text,#b45309) 8%,var(--app-surface-card,#fff))}
.maid-skill-notice p {flex:1;min-width:180px;margin:0;color:var(--app-text-primary,#111827);font-size:13px}
.maid-skill-empty {margin:0;padding:28px 16px;border:1px dashed var(--app-border-default,#cbd5e1);border-radius:16px;text-align:center}
.maid-skill-form {display:grid;gap:14px;min-width:0}
.maid-skill-field {display:grid;gap:6px;min-width:0}
.maid-skill-field>span {font-size:12.5px;font-weight:700;color:var(--app-text-secondary,#475569)}
.maid-skills input:not([type=checkbox]),.maid-skills textarea,.maid-skills select {font:inherit;font-size:14px;width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--app-border-default,#cbd5e1);border-radius:10px;padding:8px 11px;background:var(--app-surface-input,var(--app-surface-card,#fff));color:inherit;transition:border-color 120ms ease,box-shadow 120ms ease}
.maid-skills input:not([type=checkbox]):focus,.maid-skills textarea:focus,.maid-skills select:focus {outline:none;border-color:rgba(var(--skill-accent-rgb),.5);box-shadow:0 0 0 3px rgba(var(--skill-accent-rgb),.12)}
.maid-skills input[readonly] {background:var(--app-surface-subtle,#f8fafc);color:var(--app-text-secondary,#64748b)}
.maid-skills textarea {resize:vertical;min-height:84px;line-height:1.65}
.maid-skills textarea.maid-skill-body {min-height:280px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,system-ui,sans-serif;font-size:13px;line-height:1.75}
.maid-skill-count {justify-self:end;margin-top:-8px;font-variant-numeric:tabular-nums}
.maid-skill-check {display:flex;gap:8px;align-items:flex-start;cursor:pointer;font-size:13px}
.maid-skill-check input[type=checkbox] {margin-top:3px}
.maid-skill-error {color:var(--app-danger-text,#dc2626);white-space:pre-wrap;overflow-wrap:anywhere}
.maid-skill-status {margin:0 0 10px;font-size:12.5px}
.maid-skill-status.maid-skill-error {padding:8px 12px;border:1px solid var(--app-danger-border,rgba(220,38,38,.28));border-radius:10px;background:var(--app-danger-soft,rgba(220,38,38,.08))}
.maid-skill-status:empty {display:none}
.maid-skill-disclosure {border:1px solid var(--skill-line);border-radius:14px;background:var(--app-surface-card,#fff)}
.maid-skill-disclosure>summary {display:flex;align-items:center;gap:8px;padding:11px 14px;cursor:pointer;font-size:13px;font-weight:700;list-style:none}
.maid-skill-disclosure>summary::-webkit-details-marker {display:none}
.maid-skill-disclosure>summary::after {content:'';width:7px;height:7px;margin-left:auto;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg) translateY(-2px);opacity:.55;transition:transform 160ms ease}
.maid-skill-disclosure[open]>summary::after {transform:rotate(225deg) translateY(-2px)}
.maid-skill-disclosure>:not(summary) {margin:0 14px 14px}
.maid-skill-feature-list {max-height:260px;overflow:auto;gap:8px;padding:2px}
.maid-skill-preview {overflow-wrap:anywhere;white-space:normal;line-height:1.8;padding:14px 16px;border:1px solid var(--skill-line);border-radius:14px;background:var(--app-surface-subtle,#f8fafc)}
.maid-skill-preview>:first-child {margin-top:0}
.maid-skill-preview>:last-child {margin-bottom:0}
.maid-skill-preview :is(h1,h2,h3,h4,h5,h6) {margin:14px 0 6px;font-size:14.5px;font-weight:800;line-height:1.5}
.maid-skill-preview h1 {font-size:16px}
.maid-skill-preview :is(p,ul,ol) {margin:6px 0}
.maid-skill-preview :is(ul,ol) {padding-left:1.4em}
.maid-skill-preview blockquote {margin:8px 0;padding:2px 12px;border-left:3px solid rgba(var(--skill-accent-rgb),.4);color:var(--app-text-secondary,#475569)}
.maid-skill-preview code {padding:1px 5px;border-radius:5px;background:var(--app-surface-hover,#f1f5f9);font:12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.maid-skill-preview hr {border:0;border-top:1px solid var(--app-border-default,#e2e8f0);margin:12px 0}
.maid-skill-preview a {color:var(--app-text-link,var(--skill-accent))}
.maid-skill-preview pre {white-space:pre-wrap;overflow:auto;background:var(--app-surface-hover,#f1f5f9);padding:12px;border-radius:10px}
.maid-skill-preview img {max-width:100%}
.maid-skill-dialog {box-sizing:border-box;margin:auto;width:min(620px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:20px;border:1px solid var(--app-border-default,#cbd5e1);border-radius:20px;background:var(--app-surface-card,#fff);color:var(--app-text-primary,#111827);box-shadow:var(--app-shadow-md,0 12px 34px rgba(15,23,42,.18));overflow:auto}
.maid-skill-dialog::backdrop {background:var(--app-surface-overlay,rgba(15,23,42,.42));backdrop-filter:blur(2px)}
.maid-skill-dialog h3 {margin:0;font-size:16px}
.maid-skill-dialog .maid-skill-search {margin-bottom:10px}
.maid-skill-dialog-footer {position:sticky;bottom:-20px;justify-content:flex-end;margin:14px -20px -20px;padding:12px 20px;border-top:1px solid var(--skill-line);background:var(--app-surface-card,#fff)}
.maid-skill-chips {display:flex;gap:6px;flex-wrap:wrap;flex-basis:100%;width:100%;order:-1;padding:0 4px}
.maid-skill-chips:empty {display:none}
.maid-command-input:has(.maid-skill-chips:not(:empty)) {flex-wrap:wrap;border-radius:18px}
.maid-command-input:has(.maid-skill-chips:not(:empty)) .maid-command-input-field {flex-basis:0}
.maid-skill-chip-group {display:inline-flex;align-items:center;max-width:100%;border:1px solid rgba(var(--app-accent-rgb,37,99,235),.18);border-radius:999px;background:rgba(var(--app-accent-rgb,37,99,235),.08);color:var(--app-accent-primary,#2563eb)}
.maid-skill-chip-group::before {content:'';flex:0 0 6px;height:6px;margin-left:9px;border-radius:50%;background:currentColor;opacity:.7}
.maid-skill-chip {font:inherit;font-size:12px;font-weight:700;max-width:100%;overflow-wrap:anywhere;border:0;border-radius:999px;background:transparent;color:inherit;padding:3px 6px 3px 6px;cursor:pointer;line-height:1.5}
.maid-skill-chip:hover {text-decoration:underline}
.maid-skill-chip-remove {flex:0 0 auto;width:22px;height:22px;margin-right:3px;padding:0;font-size:14px;line-height:1;opacity:.7}
.maid-skill-chip-remove:hover {opacity:1;text-decoration:none;background:rgba(var(--app-accent-rgb,37,99,235),.14)}
.maid-command-input-skills svg {fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.maid-skill-import-entry {display:grid;gap:10px;padding:14px 16px;margin-bottom:10px;border:1px solid var(--skill-line);border-radius:16px;background:var(--app-surface-card,#fff)}
.maid-skill-import-entry>* {margin:0}
.maid-skill-import-entry>.maid-skill-check:first-child {font-weight:800;font-size:14px}
.maid-skill-issue {position:relative;padding-left:14px}
.maid-skill-issue::before {content:'';position:absolute;left:2px;top:.62em;width:6px;height:6px;border-radius:50%;background:var(--app-warning-text,#b45309)}
.maid-skill-comparison {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px}
.maid-skill-comparison>div {min-width:0;padding:10px 12px;border-radius:12px;background:var(--app-surface-subtle,#f8fafc)}
.maid-skill-comparison p {margin:4px 0}
.maid-skill-compare-text {white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font:inherit;font-size:12px;margin:6px 0 0}
.maid-skill-run-skills {margin:6px 0 0;gap:6px}
.maid-skill-run-skills .maid-skill-button {min-height:24px;padding:1px 9px;border-radius:999px;font-size:11.5px;background:rgba(var(--app-accent-rgb,37,99,235),.07);border-color:rgba(var(--app-accent-rgb,37,99,235),.16);color:var(--app-accent-primary,#2563eb)}
@media(max-width:520px){.maid-skill-row{padding:13px 14px;gap:10px}.maid-skill-dialog{padding:16px;border-radius:16px}.maid-skill-dialog-footer{bottom:-16px;margin:12px -16px -16px;padding:10px 16px}.maid-skill-comparison{grid-template-columns:minmax(0,1fr)}.maid-skill-toolbar>.maid-skill-button:not(.ghost){flex:1 1 auto}.maid-skill-toolbar>h3{flex:1 1 calc(100% - 96px)}}
`;
  doc.head.append(style);
};

export const showMaidSkillDocument = (doc, skill, { revision = skill.revision, source = '' } = {}) => {
  injectMaidSkillStyle(doc);
  const dialog = skillElement(doc, 'dialog', '', 'maid-skill-dialog maid-skills');
  dialog.setAttribute('aria-label', skill.title);
  const toolbar = skillElement(doc, 'div', '', 'maid-skill-toolbar');
  toolbar.append(skillUserText(doc, 'h3', skill.title), skillButton(doc, t('关闭'), () => dialog.close()));
  const body = skillElement(doc, 'div', '', 'maid-skill-preview');
  body.dataset.i18nSkip = ''; body.innerHTML = renderMaidMarkdownHtml(skill.content);
  dialog.append(toolbar, skillElement(doc, 'p', `${t('版本')} ${revision || 1}${source ? ` · ${source}` : ''}`, 'maid-skill-muted maid-skill-intro'), body);
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  doc.body.append(dialog); dialog.showModal(); return dialog;
};

export const saveMaidSkillFile = async ({ text, fileName, mime }) => {
  const blob = new Blob([text], { type: mime });
  if (hasTauriRuntime()) {
    const pick = await pickSavePath({ defaultName: fileName, filters: [{ name: 'Skill', extensions: [fileName.endsWith('.md') ? 'md' : 'json'] }] });
    if (pick.cancelled) return false;
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
    });
    await safeInvoke('export_attachment', { dataUrl, fileName, ...(pick.path ? { path: pick.path } : {}) });
  } else {
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return true;
};

export const createMaidSkillInput = ({ documentRef: doc = document, store, runtime, onManage = () => {} } = {}) => {
  let chips, button, count, notify = () => {};
  const refresh = () => {
    if (!chips) return;
    chips.replaceChildren();
    let skills = []; try { skills = store.list(); } catch { /* Keep removals available during a load error. */ }
    for (const id of runtime.getSelected()) {
      const skill = skills.find(item => item.id === id), row = skillElement(doc, 'span', '', 'maid-skill-chip-group');
      const view = skillButton(doc, skill?.title || t('技能不可用'), () => skill && showMaidSkillDocument(doc, skill), 'maid-skill-chip');
      view.dataset.i18nSkip = '';
      const remove = skillButton(doc, '×', () => runtime.setSelected(runtime.getSelected().filter(item => item !== id)), 'maid-skill-chip maid-skill-chip-remove');
      remove.setAttribute('aria-label', `${t('移除技能')} ${skill?.title || ''}`); row.append(view, remove); chips.append(row);
    }
    const selected = runtime.getSelected().length;
    button?.setAttribute('aria-label', `${t('选择技能')} (${selected}/3)`);
    button?.classList.toggle('has-skills', selected > 0);
    if (count) count.textContent = selected ? String(selected) : '';
    notify();
  };
  const open = async () => {
    injectMaidSkillStyle(doc);
    const dialog = skillElement(doc, 'dialog', '', 'maid-skill-dialog maid-skills');
    dialog.setAttribute('aria-label', t('选择技能'));
    const toolbar = skillElement(doc, 'div', '', 'maid-skill-toolbar');
    toolbar.append(skillElement(doc, 'h3', t('选择技能')), skillButton(doc, t('管理技能'), () => { dialog.close(); onManage(); }));
    const status = skillElement(doc, 'p', t('正在载入…'), 'maid-skill-status maid-skill-muted'); status.setAttribute('role', 'status');
    const search = skillElement(doc, 'input', '', 'maid-skill-search'); search.type = 'search'; search.placeholder = t('搜索技能'); search.setAttribute('aria-label', t('搜索技能'));
    const list = skillElement(doc, 'div', '', 'maid-skill-list');
    const chosen = new Set(runtime.getSelected());
    const footer = skillElement(doc, 'div', '', 'maid-skill-toolbar maid-skill-dialog-footer');
    footer.append(skillButton(doc, t('取消'), () => dialog.close()), skillButton(doc, t('使用所选技能'), () => { runtime.setSelected([...chosen]); dialog.close(); }, 'primary'));
    dialog.append(toolbar, skillElement(doc, 'p', t('最多选择 3 个技能，发送下一项任务时使用。'), 'maid-skill-muted maid-skill-intro'), search, status, list, footer);
    dialog.addEventListener('close', () => { unsubscribe(); dialog.remove(); refresh(); }, { once: true });
    let unsubscribe = () => {};
    doc.body.append(dialog); dialog.showModal();
    const render = () => {
      try {
        const skills = store.list().filter(item => item.enabled && `${item.title} ${item.description}`.toLowerCase().includes(search.value.toLowerCase()));
        status.textContent = `${chosen.size}/3`; list.replaceChildren();
        if (!skills.length) list.append(skillElement(doc, 'p', t('没有可用的技能'), 'maid-skill-muted maid-skill-empty'));
        for (const skill of skills) {
          const row = skillElement(doc, 'div', '', 'maid-skill-row');
          const check = skillElement(doc, 'input'); check.type = 'checkbox'; check.checked = chosen.has(skill.id); check.setAttribute('aria-label', skill.title);
          check.addEventListener('change', () => {
            if (check.checked && chosen.size >= 3) { check.checked = false; status.textContent = maidSkillMessage('skill_selection_limit'); return; }
            if (check.checked) chosen.add(skill.id); else chosen.delete(skill.id); status.textContent = `${chosen.size}/3`;
          });
          const copy = skillElement(doc, 'div', '', 'maid-skill-copy');
          const tags = skillElement(doc, 'div', '', 'maid-skill-tags');
          tags.append(skillUserText(doc, 'span', skill.name, 'maid-skill-tag'), skillElement(doc, 'span', skill.invocationMode === 'manual' ? t('仅手动使用') : t('可自动选用'), 'maid-skill-tag'));
          copy.append(skillUserText(doc, 'strong', skill.title), skillUserText(doc, 'p', skill.description, 'maid-skill-muted maid-skill-description'), tags);
          row.append(check, copy, skillButton(doc, t('查看'), () => showMaidSkillDocument(doc, skill), 'ghost')); list.append(row);
        }
      } catch (error) { status.textContent = maidSkillMessage(error); }
    };
    try { await store.ready; if (!dialog.isConnected) return; render(); unsubscribe = store.subscribe(render); search.addEventListener('input', render); }
    catch (error) { status.textContent = maidSkillMessage(error); }
  };
  // 技能入口是输入条“＋”菜单里的一项；已选技能以标签显示在输入框上方
  return { open, mount(root, menu, { onChange } = {}) {
    injectMaidSkillStyle(doc);
    chips = skillElement(doc, 'div', '', 'maid-skill-chips');
    button = skillButton(doc, '', open); button.className = 'maid-command-input-skills'; button.setAttribute('role', 'menuitem');
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg><span class="maid-command-input-menu-label">${t('技能')}</span>`;
    count = skillElement(doc, 'span', '', 'maid-command-input-skills-count'); button.append(count);
    if (typeof onChange === 'function') notify = onChange;
    menu.append(button); root.append(chips); runtime.subscribe(refresh); store.subscribe(refresh); refresh();
  } };
};

export const appendMaidSkillRunDetails = (doc, parent, run) => {
  const records = run?.metadata?.maidSkills?.loaded || [];
  if (!records.length) return;
  injectMaidSkillStyle(doc);
  const row = skillElement(doc, 'div', '', 'maid-skill-toolbar maid-skill-run-skills');
  for (const record of records) {
    const label = `${record.source === 'user' ? t('已指定') : t('已读取')} · ${record.title || record.id} · v${record.revision}`;
    const button = skillButton(doc, label, () => record.skill && showMaidSkillDocument(doc, record.skill, { source: t('任务保存的版本') }));
    button.dataset.i18nSkip = ''; button.disabled = !record.skill; row.append(button);
  }
  parent.append(row);
};
