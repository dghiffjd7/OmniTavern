import { t } from '../i18n/index.js';
import { appConfirm } from './app-confirm.js';
import { makeMaidSkillName, skillClone, normalizeMaidSkillDraft, skillLength, skillBytes } from '../agent/maid-skill-schema.js';
import { renderMaidMarkdownHtml } from './maid-markdown-utils.js';
import { maidSkillMessage } from './maid-skill-messages.js';
import { readMaidSkillImportFiles, commitMaidSkillImport, exportMaidSkillMarkdown, exportMaidSkillPackage } from './maid-skill-transfer.js';
import { skillElement as el, skillButton as button, skillUserText as userText, injectMaidSkillStyle, saveMaidSkillFile } from './maid-skill-ui.js';

export const createMaidSkillPanel = ({ store, documentRef: doc = document, listFeatures = () => [], onUseSkill = null, confirm = appConfirm, saveFile = saveMaidSkillFile } = {}) => {
  let root, status, view = 'list', draft = null, original = '', saveOptions = {}, busy = false, refreshList = null;
  let disableBuiltin = true, importEntries = null;
  const exported = new Set();
  const message = (text = '', error = false) => { if (status) { status.textContent = text; status.className = `maid-skill-status ${error ? 'maid-skill-error' : 'maid-skill-muted'}`; } };
  const report = error => message(maidSkillMessage(error), true);
  const isDirty = () => view === 'import' || (view === 'editor' && draft && JSON.stringify(draft) !== original);
  const beforeLeave = async () => {
    if (busy) return false;
    if (!isDirty()) return true;
    if (!await confirm({ title: t('放弃未保存的内容？'), message: t('离开后，本次编辑或导入预览不会保存。'), danger: true, confirmText: t('放弃'), cancelText: t('继续编辑') })) return false;
    view = 'list'; draft = null; importEntries = null; renderList(); return true;
  };
  const run = async action => {
    if (busy) return;
    busy = true; root?.setAttribute('aria-busy', 'true');
    try { await action(); } catch (error) { report(error); }
    finally { busy = false; root?.removeAttribute('aria-busy'); }
  };
  const reset = (title, back = false) => {
    root.replaceChildren();
    const toolbar = el(doc, 'div', '', 'maid-skill-toolbar');
    if (back) toolbar.append(button(doc, `‹ ${t('返回')}`, async () => { if (await beforeLeave()) renderList(); }, 'ghost'));
    toolbar.append(el(doc, 'h3', title));
    status = el(doc, 'p', '', 'maid-skill-status'); status.setAttribute('role', 'status');
    root.append(toolbar, status); return toolbar;
  };
  const field = (container, label, value, onInput, { type = 'input', readOnly = false, className = '', maxLength, placeholder = '' } = {}) => {
    const wrap = el(doc, 'label', '', 'maid-skill-field'), node = el(doc, type, '', className);
    node.value = value || ''; node.readOnly = readOnly; node.dataset.i18nSkip = ''; node.placeholder = placeholder;
    if (type === 'input') node.type = 'text';
    if (maxLength) node.maxLength = maxLength;
    node.addEventListener('input', () => onInput(node.value));
    wrap.append(el(doc, 'span', label), node); container.append(wrap); return node;
  };
  const check = (container, label, checked, action, className = 'maid-skill-check') => {
    const wrap = el(doc, 'label', '', className), input = el(doc, 'input'); input.type = 'checkbox'; input.checked = checked;
    input.addEventListener('change', () => action(input.checked)); wrap.append(input, el(doc, 'span', label)); container.append(wrap); return input;
  };
  const select = (container, label, options, value, action) => {
    const wrap = el(doc, 'label', '', 'maid-skill-field'), input = el(doc, 'select');
    for (const [id, text] of options) { const option = userText(doc, 'option', text); option.value = id; input.append(option); }
    input.value = value; input.addEventListener('change', () => action(input.value)); wrap.append(el(doc, 'span', label), input); container.append(wrap); return input;
  };
  const startEditor = (skill = null, copy = false) => {
    if (busy) return;
    const builtin = skill?.kind === 'builtin' && !copy;
    draft = skill ? skillClone(skill) : { title: '', name: makeMaidSkillName(), description: '', content: '', enabled: true, invocationMode: 'auto', featureIds: [], portableMetadata: {} };
    saveOptions = skill && !copy ? { id: skill.id, expectedRevision: skill.revision } : {};
    if (copy) {
      draft.title = `${draft.title} ${t('副本')}`; draft.name = makeMaidSkillName(); draft.enabled = false;
      saveOptions = { derivedFrom: { id: skill.id, revision: skill.revision }, ...(skill.kind === 'builtin' ? { disableBuiltinId: skill.id } : {}) };
    }
    disableBuiltin = true; view = builtin ? 'detail' : 'editor'; original = JSON.stringify(draft);
    const toolbar = reset(builtin ? t('内置技能') : skill && !copy ? t('编辑技能') : copy ? t('复制技能') : t('新建技能'), true);
    const form = el(doc, 'div', '', 'maid-skill-form'); root.append(form);
    if (builtin) {
      toolbar.append(button(doc, t('复制并编辑'), () => startEditor(skill, true)));
      if (onUseSkill && skill.enabled) toolbar.append(button(doc, t('用于下一次请求'), () => onUseSkill(skill.id)));
      form.append(userText(doc, 'h3', skill.title), userText(doc, 'p', skill.description), el(doc, 'p', t('内置流程只读，可复制后修改。'), 'maid-skill-muted maid-skill-notice'));
      select(form, t('使用方式'), [['auto', t('可自动选用')], ['manual', t('仅手动使用')]], skill.invocationMode, invocationMode => run(() => store.setAvailability(skill.id, { invocationMode })));
      const body = el(doc, 'div', '', 'maid-skill-preview'); body.dataset.i18nSkip = ''; body.innerHTML = renderMaidMarkdownHtml(skill.content); form.append(body);
      form.append(userText(doc, 'p', skill.featureIds.map(id => { const feature = listFeatures().find(item => item.id === id); return feature?.title || id; }).join(' · '), 'maid-skill-muted'));
    } else {
      const saveDraft = use => run(async () => {
        if (use && !draft.enabled) throw Object.assign(new Error(), { code: 'skill_disabled' });
        const version = JSON.stringify(draft), submitted = skillClone(draft);
        const saved = await store.save(submitted, { ...saveOptions, ...(!disableBuiltin ? { disableBuiltinId: undefined } : {}) });
        // Typing during native persistence remains a draft based on the new revision.
        saveOptions = { id: saved.id, expectedRevision: saved.revision };
        if (JSON.stringify(draft) === version) { view = 'list'; draft = null; renderList(); message(t('技能已保存')); if (use) await onUseSkill?.(saved.id); }
        else { original = version; message(t('已保存，当前还有未保存的修改')); }
      });
      toolbar.append(button(doc, t('保存'), () => saveDraft(false), 'primary'));
      if (onUseSkill) toolbar.append(button(doc, t('保存并用于下一次请求'), () => saveDraft(true)));
      field(form, t('标题'), draft.title, value => { draft.title = value; }, { maxLength: 160 });
      field(form, t('适用说明'), draft.description, value => { draft.description = value; }, { type: 'textarea', placeholder: t('说明何时适合使用这个技能，供模型选择。'), maxLength: 2048 });
      const count = el(doc, 'small', `${skillLength(draft.content)}/16000`, 'maid-skill-muted maid-skill-count');
      const preview = el(doc, 'div', '', 'maid-skill-preview'); preview.hidden = true; preview.dataset.i18nSkip = '';
      const body = field(form, t('流程正文（Markdown）'), draft.content, value => { draft.content = value; count.textContent = `${skillLength(value)}/16000`; }, { type: 'textarea', className: 'maid-skill-body' });
      body.placeholder = t('写明目标、步骤、参考资料和输出要求。女仆会结合本次任务使用这些说明。');
      const previewButton = button(doc, t('预览'), () => {
        preview.hidden = !preview.hidden; body.hidden = !preview.hidden;
        previewButton.textContent = preview.hidden ? t('预览') : t('继续编辑'); preview.innerHTML = renderMaidMarkdownHtml(draft.content);
      });
      const writingActions = el(doc, 'div', '', 'maid-skill-toolbar is-compact');
      writingActions.append(previewButton, button(doc, t('插入写作提纲'), () => {
        const outline = [t('目标'), t('步骤'), t('注意事项'), t('输出要求')].map(title => `## ${title}`).join('\n\n');
        draft.content += `${draft.content.trim() ? '\n\n' : ''}${outline}\n`;
        body.value = draft.content; count.textContent = `${skillLength(draft.content)}/16000`; preview.innerHTML = renderMaidMarkdownHtml(draft.content);
      }));
      form.append(count, writingActions, preview);
      check(form, t('启用此技能'), draft.enabled, value => { draft.enabled = value; });
      select(form, t('使用方式'), [['auto', t('可自动选用')], ['manual', t('仅手动使用')]], draft.invocationMode, value => { draft.invocationMode = value; });
      if (saveOptions.disableBuiltinId) check(form, t('启用此副本时，同时停用内置版本'), true, value => { disableBuiltin = value; });
      const references = el(doc, 'details', '', 'maid-skill-disclosure'); references.append(el(doc, 'summary', t('功能引用（可选，最多 12 项）')));
      const featureList = el(doc, 'div', '', 'maid-skill-form maid-skill-feature-list'), filter = el(doc, 'input'); filter.type = 'search'; filter.placeholder = t('搜索功能'); filter.setAttribute('aria-label', t('搜索功能'));
      references.append(filter, featureList); form.append(references);
      const renderFeatures = () => {
        featureList.replaceChildren();
        const known = listFeatures(), all = [...known, ...draft.featureIds.filter(id => !known.some(item => item.id === id)).map(id => ({ id, title: `${id} (${t('当前不可用')})` }))];
        for (const feature of all.filter(item => `${item.id} ${item.title || item.label || ''}`.toLowerCase().includes(filter.value.toLowerCase()))) {
          const input = check(featureList, `${feature.title || feature.label || feature.id} · ${feature.id}`, draft.featureIds.includes(feature.id), checked => {
            if (checked && draft.featureIds.length >= 12) { input.checked = false; report({ code: 'skill_invalid_features' }); return; }
            draft.featureIds = checked ? [...draft.featureIds, feature.id] : draft.featureIds.filter(id => id !== feature.id);
          });
        }
      };
      references.addEventListener('toggle', () => { if (references.open) renderFeatures(); }); filter.addEventListener('input', renderFeatures);
      const identifier = el(doc, 'details', '', 'maid-skill-disclosure'); identifier.append(el(doc, 'summary', t('文件标识'))); form.append(identifier);
      field(identifier, t('标识'), draft.name, value => { draft.name = value; }, { maxLength: 64 });
      form.append(el(doc, 'p', t('流程用于指导任务，不会增加工具权限，也不会改变模型配置。'), 'maid-skill-muted'));
    }
    toolbar.append(button(doc, t('导出 Markdown'), () => run(() => saveFile(exportMaidSkillMarkdown(draft)))));
  };
  const renderImport = entries => {
    view = 'import'; importEntries = entries; const toolbar = reset(t('导入预览'), true);
    let enabled = true;
    check(root, t('导入后启用'), true, value => { enabled = value; });
    root.append(el(doc, 'p', t('仅导入流程说明与元数据；脚本、外部资源和执行权限不会被导入。'), 'maid-skill-muted maid-skill-intro'));
    const customs = store.list().filter(item => item.kind === 'custom');
    for (const entry of entries) {
      const block = el(doc, 'div', '', 'maid-skill-import-entry'); root.append(block);
      if (entry.error) { block.append(userText(doc, 'strong', entry.fileName), el(doc, 'p', maidSkillMessage(entry.error), 'maid-skill-error')); continue; }
      const chosen = check(block, entry.skill.title || entry.fileName, entry.selected, value => { entry.selected = value; });
      chosen.parentElement.dataset.i18nSkip = '';
      block.append(userText(doc, 'small', entry.fileName, 'maid-skill-muted'));
      if (entry.duplicateId) block.append(el(doc, 'p', t('内容相同，默认跳过'), 'maid-skill-muted'));
      else if (entry.sameTitle) block.append(el(doc, 'p', t('存在同名技能，默认另存为新技能'), 'maid-skill-muted'));
      const options = [['new', t('另存为新技能')], ['skip', t('跳过')], ...(customs.length ? [['replace', t('替换已有技能')]] : [])];
      const targets = el(doc, 'div'); targets.hidden = entry.action !== 'replace';
      select(block, t('导入方式'), options, entry.action, action => { entry.action = action; entry.selected = action !== 'skip'; block.querySelector('input[type=checkbox]').checked = entry.selected; targets.hidden = action !== 'replace'; });
      const comparison = el(doc, 'div', '', 'maid-skill-comparison');
      const refreshComparison = () => {
        comparison.replaceChildren();
        const target = customs.find(item => item.id === entry.targetId);
        if (target) {
          for (const [label, value] of [[t('现有版本'), target], [t('待导入版本'), entry.skill]]) {
            const pane = el(doc, 'div'); pane.append(el(doc, 'strong', label), userText(doc, 'p', value.title), userText(doc, 'p', value.description, 'maid-skill-muted'), userText(doc, 'pre', value.content, 'maid-skill-compare-text')); comparison.append(pane);
          }
        }
      };
      select(targets, t('替换目标'), [['', t('请选择')], ...customs.map(item => [item.id, `${item.title} · v${item.revision}`])], '', id => {
        entry.targetId = id; entry.expectedRevision = customs.find(item => item.id === id)?.revision ?? null;
        refreshComparison();
      }); block.append(targets); targets.append(comparison);
      for (const issue of entry.issues) block.append(userText(doc, 'p', `${maidSkillMessage(issue.code)}${issue.fields?.length ? `：${issue.fields.join(', ')}` : ''}`, 'maid-skill-muted maid-skill-issue'));
      if (entry.issues.some(issue => issue.requiresTextOnly)) check(block, t('仅导入流程说明，接受上述兼容差异'), false, value => { entry.textOnlyAccepted = value; });
      const detail = el(doc, 'details', '', 'maid-skill-disclosure'); detail.append(el(doc, 'summary', t('查看和补全内容')));
      const fields = el(doc, 'div', '', 'maid-skill-form'); detail.append(fields);
      field(fields, t('标题'), entry.skill.title, value => { entry.skill.title = value; refreshComparison(); });
      field(fields, t('标识'), entry.skill.name, value => { entry.skill.name = value; });
      field(fields, t('适用说明'), entry.skill.description, value => { entry.skill.description = value; refreshComparison(); }, { type: 'textarea' });
      field(fields, t('流程正文（Markdown）'), entry.skill.content, value => { entry.skill.content = value; refreshComparison(); }, { type: 'textarea', className: 'maid-skill-body' });
      select(fields, t('使用方式'), [['auto', t('可自动选用')], ['manual', t('仅手动使用')]], entry.skill.invocationMode, value => { entry.skill.invocationMode = value; });
      if (!entry.skill.description || !entry.skill.content) detail.open = true;
      block.append(detail);
    }
    toolbar.append(button(doc, t('确认导入'), () => run(async () => {
      // Validate before a destructive replacement confirmation.
      entries.filter(entry => entry.selected && entry.action !== 'skip').forEach(entry => normalizeMaidSkillDraft(entry.skill));
      const replacing = entries.filter(entry => entry.selected && entry.action === 'replace');
      if (replacing.length && !await confirm({ title: t('替换已有技能？'), message: replacing.map(entry => customs.find(item => item.id === entry.targetId)?.title || t('请选择替换目标')).join('\n'), danger: true })) return;
      const saved = await commitMaidSkillImport(store, entries, { enabled });
      view = 'list'; importEntries = null; renderList(); message(`${t('已导入')} ${saved.length}`);
    }), 'primary'));
  };
  const renderList = () => {
    if (!root) return;
    view = 'list'; draft = null; importEntries = null; refreshList = null;
    const toolbar = reset(t('技能'));
    toolbar.append(button(doc, t('新建技能'), () => startEditor(), 'primary'));
    const file = el(doc, 'input'); file.type = 'file'; file.accept = '.md,.json'; file.multiple = true; file.hidden = true;
    file.addEventListener('change', () => run(async () => {
      if (!file.files?.length) return;
      const entries = await readMaidSkillImportFiles(file.files, { existing: store.list(), featureIds: listFeatures().map(item => item.id) });
      renderImport(entries);
    }));
    toolbar.append(button(doc, t('导入'), () => file.click()), button(doc, t('导出技能包'), () => run(() => {
      const skills = store.list().filter(item => exported.size ? exported.has(item.id) : item.kind === 'custom');
      if (!skills.length) throw Object.assign(new Error(), { code: 'skill_import_empty' });
      return saveFile(exportMaidSkillPackage(skills));
    })), file);
    const searchbar = el(doc, 'div', '', 'maid-skill-searchbar'), search = el(doc, 'input', '', 'maid-skill-search');
    search.type = 'search'; search.placeholder = t('搜索技能'); search.setAttribute('aria-label', t('搜索技能'));
    let filter = 'all';
    searchbar.append(search); select(searchbar, t('筛选'), [['all', t('全部')], ['custom', t('自定义')], ['builtin', t('内置')], ['enabled', t('已启用')], ['disabled', t('已停用')]], filter, value => { filter = value; refreshList(); });
    const summary = el(doc, 'div', '', 'maid-skill-summary'), rows = el(doc, 'div', '', 'maid-skill-list');
    root.append(el(doc, 'p', t('告诉女仆如何处理一类任务；自动选用或在输入框手动指定。'), 'maid-skill-muted maid-skill-intro'), summary, searchbar, rows);
    const showSummary = (all, state) => summary.replaceChildren(el(doc, 'span', `${t('自定义')} ${all.filter(item => item.kind === 'custom').length}/100`, 'maid-skill-tag'),
      el(doc, 'span', `${(skillBytes(state) / 1024).toFixed(1)} KiB / 2 MiB`, 'maid-skill-tag'),
      ...(exported.size ? [el(doc, 'span', t('已选 {count} 个用于导出', { count: exported.size }), 'maid-skill-tag is-accent')] : []));
    refreshList = () => {
      if (view !== 'list') return;
      try {
        const all = store.list(), state = store.exportState();
        for (const id of exported) if (!all.some(item => item.id === id)) exported.delete(id);
        showSummary(all, state);
        const visible = all.filter(item => (filter === 'all' || filter === item.kind || filter === 'enabled' && item.enabled || filter === 'disabled' && !item.enabled) && `${item.title} ${item.description}`.toLowerCase().includes(search.value.toLowerCase()));
        rows.replaceChildren();
        const broken = (state.quarantined || []).length;
        if (broken) {
          // 无法读取的记录被隔离，不影响其他技能与女仆任务；由用户决定是否删除
          const notice = el(doc, 'div', '', 'maid-skill-notice');
          notice.append(el(doc, 'p', t('有 {count} 条技能记录无法读取，已暂时忽略；其他技能照常可用。', { count: broken })),
            button(doc, t('删除无法读取的记录'), () => run(async () => {
              if (!await confirm({ title: t('删除无法读取的技能记录？'), message: t('将删除 {count} 条无法读取的记录，此操作无法恢复。', { count: broken }), danger: true })) return;
              await store.removeQuarantined(); refreshList();
            }), 'danger'));
          rows.append(notice);
        }
        if (!visible.length) rows.append(el(doc, 'p', t('还没有符合条件的技能'), 'maid-skill-muted maid-skill-empty'));
        for (const skill of visible) {
          const row = el(doc, 'div', '', `maid-skill-row${skill.enabled ? '' : ' is-disabled'}`), selected = el(doc, 'input'); selected.type = 'checkbox'; selected.checked = exported.has(skill.id);
          selected.setAttribute('aria-label', `${t('选择导出')} ${skill.title}`); selected.title = t('选择导出');
          selected.addEventListener('change', () => { if (selected.checked) exported.add(skill.id); else exported.delete(skill.id); showSummary(all, state); });
          const copy = el(doc, 'div', '', 'maid-skill-copy');
          const title = button(doc, skill.title, () => startEditor(skill), 'maid-skill-title'); title.dataset.i18nSkip = '';
          const tags = el(doc, 'div', '', 'maid-skill-tags');
          tags.append(el(doc, 'span', skill.kind === 'builtin' ? t('内置') : t('自定义'), `maid-skill-tag${skill.kind === 'custom' ? ' is-accent' : ''}`),
            el(doc, 'span', skill.invocationMode === 'manual' ? t('仅手动使用') : t('可自动选用'), 'maid-skill-tag'), el(doc, 'span', `v${skill.revision}`, 'maid-skill-tag'),
            ...(skill.enabled ? [] : [el(doc, 'span', t('已停用'), 'maid-skill-tag is-off')]));
          // Row actions stay visible instead of hiding behind a menu; the delete button keeps its confirmation.
          const footer = el(doc, 'div', '', 'maid-skill-row-footer');
          if (onUseSkill) { const use = button(doc, t('用于下一次请求'), () => run(() => onUseSkill(skill.id)), 'ghost'); use.disabled = !skill.enabled; footer.append(use); }
          footer.append(button(doc, t('复制'), () => startEditor(skill, true), 'ghost'), button(doc, t('导出 Markdown'), () => run(() => saveFile(exportMaidSkillMarkdown(skill))), 'ghost'));
          if (skill.kind === 'custom') footer.append(button(doc, t('删除'), () => run(async () => {
            if (!await confirm({ title: t('删除技能？'), message: skill.title, danger: true })) return;
            await store.remove(skill.id, { expectedRevision: skill.revision }); refreshList();
          }), 'ghost danger'));
          copy.append(title, userText(doc, 'p', skill.description, 'maid-skill-muted maid-skill-description'), tags, footer);
          const actions = el(doc, 'div', '', 'maid-skill-row-actions');
          check(actions, t('启用'), skill.enabled, enabled => run(async () => { try { await store.setAvailability(skill.id, { enabled }); } finally { refreshList?.(); } }), 'maid-skill-switch');
          row.append(selected, copy, actions); rows.append(row);
        }
      } catch (error) {
        report(error); rows.replaceChildren(button(doc, t('重新载入'), () => run(async () => { await store.load(); renderList(); })));
      }
    };
    search.addEventListener('input', refreshList); refreshList();
  };
  return {
    mount(container) { root = container; root.classList.add('maid-skills'); injectMaidSkillStyle(doc); renderList(); store.subscribe(() => refreshList?.()); store.ready.then(() => refreshList?.(), report); },
    refresh() { if (view === 'list') refreshList?.(); },
    isDirty, beforeLeave,
  };
};
