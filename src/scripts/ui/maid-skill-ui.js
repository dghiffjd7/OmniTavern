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
.maid-skills {min-width:0;color:var(--app-text-primary,#111827);font-size:14px;line-height:1.6}
.maid-skill-toolbar {display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.maid-skill-toolbar h3 {margin:0 auto 0 0;font-size:16px;font-weight:650}
.maid-skill-button {font:inherit;color:inherit;background:var(--app-surface-card,#fff);border:1px solid var(--app-border-default,#cbd5e1);border-radius:8px;min-height:36px;padding:6px 12px;cursor:pointer}
.maid-skill-button.primary {background:var(--app-accent-primary,#2563eb);color:var(--app-text-on-accent,#fff);border-color:transparent}
.maid-skill-button.danger {color:var(--app-danger,#b91c1c)}
.maid-skill-button:disabled {opacity:.5;cursor:default}
.maid-skills :focus-visible,.maid-skill-dialog :focus-visible {outline:2px solid var(--app-accent-primary,#2563eb);outline-offset:3px}
.maid-skills input[type=checkbox] {accent-color:var(--app-accent-primary,#2563eb)}
.maid-skill-muted {color:var(--app-text-secondary,#64748b);font-size:12px}
.maid-skill-row {display:flex;align-items:flex-start;gap:12px;padding:16px 0;border-bottom:1px solid var(--app-border-default,#e2e8f0)}
.maid-skill-copy {flex:1;min-width:0;overflow-wrap:anywhere}
.maid-skill-copy p {margin:4px 0 0}
.maid-skill-description {display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.maid-skill-button.maid-skill-title {border:0;background:none;padding:0;min-height:0;text-align:left;font-weight:650}
.maid-skill-menu>summary {cursor:pointer;min-height:32px;padding:2px 8px}
.maid-skill-menu[open] {display:grid;gap:6px;max-width:180px}
.maid-skill-menu>.maid-skill-button {display:block;width:100%;margin-top:6px}
.maid-skill-row-actions {display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.maid-skill-row input[type=checkbox] {margin-top:8px}
.maid-skill-form {display:grid;gap:14px;min-width:0}
.maid-skill-field {display:grid;gap:6px;min-width:0}
.maid-skills input:not([type=checkbox]),.maid-skills textarea,.maid-skills select {font:inherit;width:100%;min-width:0;box-sizing:border-box;border:1px solid var(--app-border-default,#cbd5e1);border-radius:8px;padding:8px 10px;background:var(--app-surface-card,#fff);color:inherit}
.maid-skills textarea {resize:vertical;min-height:80px}
.maid-skills textarea.maid-skill-body {min-height:260px;font-family:ui-monospace,monospace;line-height:1.7}
.maid-skill-check {display:flex;gap:8px;align-items:flex-start;cursor:pointer}
.maid-skill-error {color:var(--app-danger,#b91c1c);white-space:pre-wrap;overflow-wrap:anywhere}
.maid-skill-preview {overflow-wrap:anywhere;white-space:normal;line-height:1.8}
.maid-skill-preview pre {white-space:pre-wrap;overflow:auto;background:var(--app-surface-subtle,#f8fafc);padding:12px}
.maid-skill-preview img {max-width:100%}
.maid-skill-dialog {box-sizing:border-box;width:min(620px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:20px;border:1px solid var(--app-border-default,#cbd5e1);border-radius:14px;background:var(--app-surface-card,#fff);color:var(--app-text-primary,#111827);overflow:auto}
.maid-skill-dialog::backdrop {background:rgba(15,23,42,.34)}
.maid-skill-dialog h3 {margin:0;font-size:16px}
.maid-skill-chips {display:flex;gap:6px;flex-wrap:wrap;flex-basis:100%;width:100%;order:-1;padding:0 4px}
.maid-skill-chips:empty {display:none}
.maid-command-input:has(.maid-skill-chips:not(:empty)) {flex-wrap:wrap;border-radius:18px}
.maid-skill-chip {font:inherit;font-size:12px;max-width:100%;overflow-wrap:anywhere;border:0;border-radius:6px;background:var(--app-surface-subtle,#f1f5f9);color:var(--app-text-primary,#334155);padding:4px 8px;cursor:pointer}
.maid-command-input-skills {flex:0 0 30px;align-self:center;border:0;background:transparent;color:inherit;padding:4px;cursor:pointer;line-height:0}
.maid-command-input-skills svg {width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.maid-skill-import-entry {padding:16px 0;border-bottom:1px solid var(--app-border-default,#e2e8f0)}
.maid-skill-import-entry>details {margin-top:8px}
.maid-skill-import-entry summary {cursor:pointer}
.maid-skill-comparison {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:12px}
.maid-skill-compare-text {white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font:inherit;font-size:12px}
.maid-skill-status:empty {display:none}
@media(max-width:520px){.maid-skill-row{flex-wrap:wrap}.maid-skill-row-actions{margin-left:24px;width:100%}.maid-skill-dialog{padding:16px}.maid-skill-toolbar .maid-skill-search{flex-basis:100%}.maid-skill-comparison{grid-template-columns:minmax(0,1fr)}}
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
  dialog.append(toolbar, skillElement(doc, 'p', `${t('版本')} ${revision || 1}${source ? ` · ${source}` : ''}`, 'maid-skill-muted'), body);
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
  let chips, button;
  const refresh = () => {
    if (!chips) return;
    chips.replaceChildren();
    let skills = []; try { skills = store.list(); } catch { /* Keep removals available during a load error. */ }
    for (const id of runtime.getSelected()) {
      const skill = skills.find(item => item.id === id), row = skillElement(doc, 'span');
      const view = skillButton(doc, skill?.title || t('技能不可用'), () => skill && showMaidSkillDocument(doc, skill), 'maid-skill-chip');
      view.dataset.i18nSkip = '';
      const remove = skillButton(doc, '×', () => runtime.setSelected(runtime.getSelected().filter(item => item !== id)), 'maid-skill-chip');
      remove.setAttribute('aria-label', `${t('移除技能')} ${skill?.title || ''}`); row.append(view, remove); chips.append(row);
    }
    button?.setAttribute('aria-label', `${t('选择技能')} (${runtime.getSelected().length}/3)`);
  };
  const open = async () => {
    injectMaidSkillStyle(doc);
    const dialog = skillElement(doc, 'dialog', '', 'maid-skill-dialog maid-skills');
    dialog.setAttribute('aria-label', t('选择技能'));
    const toolbar = skillElement(doc, 'div', '', 'maid-skill-toolbar');
    toolbar.append(skillElement(doc, 'h3', t('选择技能')), skillButton(doc, t('管理技能'), () => { dialog.close(); onManage(); }));
    const status = skillElement(doc, 'p', t('正在载入…'), 'maid-skill-status maid-skill-muted'); status.setAttribute('role', 'status');
    const search = skillElement(doc, 'input'); search.type = 'search'; search.placeholder = t('搜索技能'); search.setAttribute('aria-label', t('搜索技能'));
    const list = skillElement(doc, 'div');
    const chosen = new Set(runtime.getSelected());
    const footer = skillElement(doc, 'div', '', 'maid-skill-toolbar');
    footer.append(skillButton(doc, t('取消'), () => dialog.close()), skillButton(doc, t('使用所选技能'), () => { runtime.setSelected([...chosen]); dialog.close(); }, 'primary'));
    dialog.append(toolbar, skillElement(doc, 'p', t('最多选择 3 个技能，发送下一项任务时使用。'), 'maid-skill-muted'), search, status, list, footer);
    dialog.addEventListener('close', () => { unsubscribe(); dialog.remove(); refresh(); }, { once: true });
    let unsubscribe = () => {};
    doc.body.append(dialog); dialog.showModal();
    const render = () => {
      try {
        const skills = store.list().filter(item => item.enabled && `${item.title} ${item.description}`.toLowerCase().includes(search.value.toLowerCase()));
        status.textContent = `${chosen.size}/3`; list.replaceChildren();
        if (!skills.length) list.append(skillElement(doc, 'p', t('没有可用的技能'), 'maid-skill-muted'));
        for (const skill of skills) {
          const row = skillElement(doc, 'div', '', 'maid-skill-row');
          const check = skillElement(doc, 'input'); check.type = 'checkbox'; check.checked = chosen.has(skill.id); check.setAttribute('aria-label', skill.title);
          check.addEventListener('change', () => {
            if (check.checked && chosen.size >= 3) { check.checked = false; status.textContent = maidSkillMessage('skill_selection_limit'); return; }
            if (check.checked) chosen.add(skill.id); else chosen.delete(skill.id); status.textContent = `${chosen.size}/3`;
          });
          const copy = skillElement(doc, 'div', '', 'maid-skill-copy');
          copy.append(skillUserText(doc, 'strong', skill.title), skillUserText(doc, 'p', skill.description, 'maid-skill-muted'), skillUserText(doc, 'small', `${skill.name} · ${skill.invocationMode === 'manual' ? t('仅手动使用') : t('可自动选用')}`));
          row.append(check, copy, skillButton(doc, t('查看'), () => showMaidSkillDocument(doc, skill))); list.append(row);
        }
      } catch (error) { status.textContent = maidSkillMessage(error); }
    };
    try { await store.ready; if (!dialog.isConnected) return; render(); unsubscribe = store.subscribe(render); search.addEventListener('input', render); }
    catch (error) { status.textContent = maidSkillMessage(error); }
  };
  return { open, mount(root, before) {
    injectMaidSkillStyle(doc);
    chips = skillElement(doc, 'div', '', 'maid-skill-chips');
    button = skillButton(doc, '', open); button.className = 'maid-command-input-skills'; button.title = t('选择技能');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/></svg>';
    root.insertBefore(button, before); root.append(chips); runtime.subscribe(refresh); store.subscribe(refresh); refresh();
  } };
};

export const appendMaidSkillRunDetails = (doc, parent, run) => {
  const records = run?.metadata?.maidSkills?.loaded || [];
  if (!records.length) return;
  injectMaidSkillStyle(doc);
  const row = skillElement(doc, 'div', '', 'maid-skill-toolbar');
  for (const record of records) {
    const label = `${record.source === 'user' ? t('已指定') : t('已读取')} · ${record.title || record.id} · v${record.revision}`;
    const button = skillButton(doc, label, () => record.skill && showMaidSkillDocument(doc, record.skill, { source: t('任务保存的版本') }));
    button.dataset.i18nSkip = ''; button.disabled = !record.skill; row.append(button);
  }
  parent.append(row);
};
