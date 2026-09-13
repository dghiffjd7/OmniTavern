import { t } from '../i18n/index.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, fallback, min, max) => Math.max(min, Math.min(max, Math.round(Number(value)) || fallback));
const help = (label, text) => `<span class="ac-label has-help" tabindex="0" data-help-mode="tap" data-help="${e(t(text))}">${e(t(label))}</span>`;
const countLabel = count => t('已选 {count} 项', { count });
const refKind = key => key === 'worldbook' ? 'worldbook' : 'prompt';

const installStyle = doc => {
  if (doc.getElementById('agent-reference-editor-style')) return;
  const style = doc.createElement('style'); style.id = 'agent-reference-editor-style';
  style.textContent = `
  .agent-config-editor .ac-reference-summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agent-config-editor .ac-reference-summary .ac-source{font-size:11px;font-weight:400}.agent-config-editor :is([data-ac-section=context],[data-ac-section=tools])>summary{display:flex;align-items:center;gap:8px;list-style:none}.agent-config-editor :is([data-ac-section=context],[data-ac-section=tools])>summary::-webkit-details-marker{display:none}.agent-config-editor :is([data-ac-section=context],[data-ac-section=tools])>summary::before{content:'›';font-size:17px;color:var(--app-text-secondary);transition:transform .16s}.agent-config-editor :is([data-ac-section=context],[data-ac-section=tools])[open]>summary::before{transform:rotate(90deg)}.agent-config-editor :is([data-ac-section=context],[data-ac-section=tools])[data-ac-expanding=false]>summary::before{transform:rotate(0deg)}
  .agent-config-editor .ac-reference-stack{display:grid;gap:10px}.agent-config-editor .ac-reference-card{border:1px solid var(--app-border-default);border-radius:15px;background:var(--app-surface-subtle);min-width:0;overflow:hidden;transition:background .16s,border-color .16s}.agent-config-editor .ac-reference-card.is-enabled{background:var(--app-surface-card);border-color:color-mix(in srgb,var(--app-accent-primary) 32%,var(--app-border-default))}
  .agent-config-editor .ac-reference-heading{display:flex;align-items:center;gap:10px;min-height:48px;padding:5px 12px}.agent-config-editor .ac-reference-heading>label{display:flex;align-items:center;gap:10px;min-height:44px;flex:1;cursor:pointer;font-size:13px;font-weight:600}.agent-config-editor .ac-reference-heading input,.agent-config-editor .ac-reference-option input,.agent-config-editor .ac-reference-check input{width:17px;height:17px;accent-color:var(--app-accent-primary);flex:0 0 auto}.agent-config-editor .ac-reference-heading>span{margin-left:auto;font-size:11px;color:var(--app-text-secondary)}
  .agent-config-editor .ac-reference-body{display:grid;gap:10px;padding:0 12px 12px}.agent-config-editor .ac-reference-choices{display:flex;gap:6px;flex-wrap:wrap}.agent-config-editor .ac-reference-choices button{min-width:44px;min-height:44px;border:1px solid var(--app-border-default);border-radius:10px;background:var(--app-surface-card);color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background .16s,color .16s,transform .12s}.agent-config-editor .ac-reference-choices button[aria-pressed=true]{color:var(--app-accent-primary);border-color:var(--app-accent-primary);background:color-mix(in srgb,var(--app-accent-primary) 8%,var(--app-surface-card))}.agent-config-editor .ac-reference-choices button:active{transform:scale(.96)}.agent-config-editor .ac-reference-choices input:not([type=checkbox]){width:64px;min-height:44px;text-align:center;padding:8px}.agent-config-editor .ac-reference-unit{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--app-text-secondary)}
  .agent-config-editor .ac-reference-check{display:flex;align-items:center;gap:8px;min-height:44px;font-size:12px;cursor:pointer}.agent-config-editor .ac-reference-picks{display:flex;flex-wrap:wrap;gap:6px}.agent-config-editor .ac-reference-pick{display:inline-flex;align-items:center;gap:5px;min-height:36px;max-width:100%;padding:0 7px 0 10px;border:1px solid var(--app-border-default);border-radius:10px;background:var(--app-surface-subtle);font-size:11px}.agent-config-editor .ac-reference-pick>span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.agent-config-editor .ac-reference-pick button{border:0;background:transparent;color:var(--app-text-secondary);min-width:32px;min-height:36px;cursor:pointer;padding:4px;font-size:18px}.agent-config-editor .ac-reference-pick.is-unavailable{border-style:dashed;color:var(--app-text-secondary)}
  .agent-config-editor .ac-reference-picker{border-top:0;padding:0}.agent-config-editor .ac-reference-picker>summary{font-size:12px;font-weight:500;padding:10px 0}.agent-config-editor .ac-reference-picker .ac-reference-search{min-height:44px;margin-bottom:7px}.agent-config-editor .ac-reference-list{max-height:260px;overflow:auto;overscroll-behavior:contain}.agent-config-editor .ac-reference-option{display:flex;align-items:center;gap:10px;min-height:48px;padding:5px 8px;border-radius:10px;cursor:pointer;transition:background .15s}.agent-config-editor .ac-reference-option:has(input:checked){background:color-mix(in srgb,var(--app-accent-primary) 8%,var(--app-surface-card))}.agent-config-editor .ac-reference-option>span{display:grid;gap:3px;min-width:0}.agent-config-editor .ac-reference-option strong{font-size:12px;font-weight:500;overflow-wrap:anywhere}.agent-config-editor .ac-reference-option small{font-size:10px;color:var(--app-text-secondary);overflow-wrap:anywhere}.agent-config-editor .ac-reference-empty{font-size:12px;color:var(--app-text-secondary);padding:12px 0;line-height:1.6}.agent-config-editor .ac-reference-tools .ac-reference-list{max-height:300px}
  .agent-config-editor .ac-reference-preview{display:grid;gap:8px}.agent-config-editor .ac-reference-manifest{display:grid;gap:5px}.agent-config-editor .ac-reference-manifest>div{display:flex;justify-content:space-between;gap:10px;font-size:11px}.agent-config-editor .ac-reference-manifest>div>span:first-child{min-width:0;overflow-wrap:anywhere}.agent-config-editor .ac-reference-manifest>div>span:last-child{flex-shrink:0;color:var(--app-text-secondary)}.agent-config-editor .ac-reference-preview pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.75 var(--app-font-family,inherit);max-height:260px;overflow:auto;padding:12px;border-radius:12px;background:var(--app-surface-subtle)}.agent-config-editor .ac-reference-warning{font-size:11px;color:var(--app-text-secondary)}
  .agent-config-editor .ac-reference-advanced{border-top:0;padding-top:0}.agent-config-editor .ac-reference-advanced>summary{font-size:12px;color:var(--app-text-secondary);font-weight:500}.agent-config-editor .ac-reference-advanced-body{display:grid;gap:8px}.agent-config-editor .ac-reference-refresh{display:flex;align-items:center;justify-content:space-between;gap:10px}
  @media(max-width:600px){.agent-config-editor .ac-reference-pick{min-height:44px}.agent-config-editor .ac-reference-pick button{min-width:36px;min-height:44px}.agent-config-editor .ac-reference-list{max-height:240px}}
  @media(prefers-reduced-motion:reduce){.agent-config-editor .ac-reference-card,.agent-config-editor .ac-reference-choices button,.agent-config-editor .ac-reference-option{transition:none!important;transform:none!important}.agent-config-editor :is([data-ac-section=context],[data-ac-section=tools])>summary::before{transition:none!important}}
  body[data-reduced-motion=on] .agent-config-editor :is(.ac-reference-card,.ac-reference-choices button,.ac-reference-option){transition:none!important;transform:none!important}
  body[data-reduced-motion=on] .agent-config-editor :is([data-ac-section=context],[data-ac-section=tools])>summary::before{transition:none!important}
  `;
  doc.head.append(style);
};

const restoreDetails = (host, keys) => host.querySelectorAll('details').forEach(detail => { detail.open = keys.includes(detail.dataset.acSection); });
const openedDetails = host => [...host.querySelectorAll('details[open]')].map(detail => detail.dataset.acSection);
const defaultReference = input => {
  const value = clone(input || {});
  value.history ||= { enabled: value.mode === 'recent', unit: value.mode === 'recent' ? 'messages' : 'turns', count: value.mode === 'recent' ? value.count || 8 : 3, roles: ['user', 'assistant'], includeTarget: value.mode !== 'recent' };
  value.worldbook ||= { enabled: false, ids: [] }; value.prompts ||= { enabled: false, ids: [] };
  value.maxChars ||= 10000;
  return value;
};

// This component owns only the reference draft and source picker. It never edits a reply.
export const createAgentReferenceEditor = ({ host, value, actions, getOptions, onChange, onStatus = () => {}, state = null, builtinId = '' }) => {
  const doc = host.ownerDocument; installStyle(doc);
  const builtin = builtinId === 'text_completion' || builtinId === 'reply_check';
  let draft = defaultReference(value), catalog = null, loading = false, alive = true, requestId = 0, previewId = 0, error = '', preview = null;
  const loadingBooks = new Set();
  const search = { worldbook: '', prompts: '', ...state?.search };
  let initialOpen = state?.open || [];
  const summary = () => [draft.history.enabled ? t(draft.history.unit === 'messages' ? '最近 {count} 条消息' : '最近 {count} 轮', { count: draft.history.count }) : '', draft.worldbook.enabled && draft.worldbook.ids.length ? t('世界书 {count}', { count: draft.worldbook.ids.length }) : '', draft.prompts.enabled && draft.prompts.ids.length ? t('提示词 {count}', { count: draft.prompts.ids.length }) : ''].filter(Boolean).join(' · ') || t(builtin ? '按需添加' : '未添加');
  const notify = () => {
    draft.mode = draft.history.enabled ? 'recent' : 'none'; draft.count = draft.history.count;
    previewId++; preview = null; onChange(clone(draft));
    const current = host.querySelector('[data-ac-ref-summary]'); if (current) current.textContent = summary();
    const output = host.querySelector('[data-ac-ref-preview]'); if (output) output.replaceChildren();
  };
  const names = key => new Map((catalog || []).filter(item => item.kind === refKind(key)).map(item => [item.id, item]));
  const picks = key => {
    const map = names(key);
    return draft[key].ids.map(id => {
      const item = map.get(id), unavailable = catalog && (!item || item.available === false || item.disabled === true);
      return `<span class="ac-reference-pick${unavailable ? ' is-unavailable' : ''}"><span title="${e(item?.title || id)}" data-i18n-skip="true">${e(item?.title || (catalog ? t('来源已失效') : t('已选来源')))}</span><button type="button" data-ac-ref-remove="${key}" data-source-id="${e(id)}" aria-label="${e(t('移除'))}" title="${e(t('移除'))}">×</button></span>`;
    }).join('');
  };
  const sourceList = key => {
    if (loading || !catalog) return `<div class="ac-reference-empty">${e(t(error || '正在读取来源…'))}</div>`;
    const query = search[key].trim().toLocaleLowerCase();
    const items = catalog.filter(item => item.kind === refKind(key) && (item.available !== false && item.disabled !== true || draft[key].ids.includes(item.id))
      && (!query || `${item.title} ${item.group || ''}`.toLocaleLowerCase().includes(query)));
    if (!items.length) return `<div class="ac-reference-empty">${e(t(query ? '没有匹配的来源' : key === 'worldbook' ? '暂无可选世界书' : '暂无可选提示词'))}</div>`;
    return items.slice(0, 120).map(item => `<label class="ac-reference-option"><input type="checkbox" data-ac-ref-source="${key}" data-source-id="${e(item.id)}" ${draft[key].ids.includes(item.id) ? 'checked' : ''}><span><strong data-i18n-skip="true">${e(item.title)}</strong>${item.group || item.available === false || item.disabled || item.whole ? `<small data-i18n-skip="true">${e([item.group, item.whole ? t('整本') : '', item.available === false || item.disabled ? t('来源已停用') : ''].filter(Boolean).join(' · '))}</small>` : ''}</span>${item.whole && item.hasChildren && item.entriesLoaded === false ? `<button type="button" class="agent-center-card-action" data-ac-ref-book="${e(item.bookId)}" ${loadingBooks.has(item.bookId) ? 'disabled' : ''}>${e(t(loadingBooks.has(item.bookId) ? '正在读取…' : '选择条目'))}</button>` : ''}</label>`).join('') + (items.length > 120 ? `<div class="ac-reference-empty">${e(t('显示前 {count} 项，可搜索更多来源', { count: 120 }))}</div>` : '');
  };
  const sourceCard = (key, title) => `<section class="ac-reference-card${draft[key].enabled ? ' is-enabled' : ''}"><div class="ac-reference-heading"><label><input type="checkbox" data-ac-ref-field="${key}.enabled" ${draft[key].enabled ? 'checked' : ''}>${e(t(title))}</label><span>${e(countLabel(draft[key].ids.length))}</span></div>${draft[key].enabled ? `<div class="ac-reference-body"><div class="ac-reference-picks" data-ac-ref-picks="${key}">${picks(key)}</div><details class="ac-reference-picker" data-ac-section="references-${key}"><summary>${e(t(key === 'worldbook' ? '选择世界书' : '选择提示词'))}</summary><input type="search" class="ac-reference-search" data-ac-ref-search="${key}" placeholder="${e(t('搜索来源'))}" aria-label="${e(t('搜索来源'))}" value="${e(search[key])}"><div class="ac-reference-list" data-ac-ref-list="${key}">${sourceList(key)}</div></details></div>` : ''}</section>`;
  const render = () => {
    const open = initialOpen.length ? initialOpen : openedDetails(host); initialOpen = [];
    host.innerHTML = `<details data-ac-section="context"><summary><span class="ac-reference-summary">${help(builtin ? '附加参考资料' : '参考资料', '参考资料帮助理解背景；允许修改的内容由“处理内容”单独决定。')}<span class="ac-source" data-ac-ref-summary>${e(summary())}</span></span></summary><div class="ac-reference-stack"><section class="ac-reference-card${draft.history.enabled ? ' is-enabled' : ''}"><div class="ac-reference-heading"><label><input type="checkbox" data-ac-ref-field="history.enabled" ${draft.history.enabled ? 'checked' : ''}>${e(t('最近对话'))}</label>${draft.history.enabled ? `<span>${e(t(draft.history.unit === 'messages' ? '最近 {count} 条消息' : '最近 {count} 轮', { count: draft.history.count }))}</span>` : ''}</div>${draft.history.enabled ? `<div class="ac-reference-body"><div class="ac-reference-choices">${[1, 3, 5].map(count => `<button type="button" data-ac-ref-count="${count}" aria-pressed="${count === draft.history.count}">${e(t(draft.history.unit === 'messages' ? '{count} 条' : '{count} 轮', { count }))}</button>`).join('')}<label class="ac-reference-unit"><input type="number" min="1" max="50" inputmode="numeric" data-ac-ref-field="history.count" aria-label="${e(t('参考数量'))}" value="${draft.history.count}"></label></div><div class="ac-reference-choices">${[['user','用户'],['assistant','AI']].map(([role, title]) => `<label class="ac-reference-check"><input type="checkbox" data-ac-ref-role="${role}" ${draft.history.roles.includes(role) ? 'checked' : ''}>${e(t(title))}</label>`).join('')}</div></div>` : ''}</section>${sourceCard('worldbook', '世界书')}${sourceCard('prompts', '固定提示词')}<details class="ac-reference-advanced" data-ac-section="reference-limits"><summary>${e(t('参考范围与上限'))}</summary><div class="ac-reference-advanced-body">${draft.history.enabled ? `<div class="ac-reference-choices" role="group" aria-label="${e(t('计数方式'))}">${[['turns','按轮'],['messages','按消息']].map(([unit,title]) => `<button type="button" data-ac-ref-unit="${unit}" aria-pressed="${draft.history.unit === unit}">${e(t(title))}</button>`).join('')}</div><label class="ac-reference-check"><input type="checkbox" data-ac-ref-field="history.includeTarget" ${draft.history.includeTarget ? 'checked' : ''}>${help('计入当前这一轮', '例如最近三轮：前两轮和本轮用户输入作为参考；待处理的 AI 回复单独发送。关闭时取目标之前的完整轮次。')}</label>` : ''}<label>${help('字符上限', '所有参考来源共用这个上限；展开预览可查看实际加入的来源与截断情况。')}<input type="number" min="500" max="40000" step="500" inputmode="numeric" data-ac-ref-field="maxChars" value="${draft.maxChars}"></label></div></details><div class="ac-reference-refresh"><button type="button" class="agent-center-card-action" data-ac-ref-preview-button>${e(t(builtin ? '预览附加资料' : '预览参考资料'))}</button><button type="button" class="agent-center-card-action" data-ac-ref-refresh>${e(t('刷新来源'))}</button></div><div class="ac-reference-preview" data-ac-ref-preview aria-live="polite"></div></div></details>`;
    restoreDetails(host, open);
    if (preview) renderPreview();
  };
  const load = async (force = false) => {
    if ((catalog && !force) || loading || typeof actions.listAgentReferenceSources !== 'function') return;
    loading = true; error = ''; const version = ++requestId;
    const request = getOptions(), key = JSON.stringify([request.context, request.scope]);
    try {
      const items = await actions.listAgentReferenceSources(request);
      if (!alive || version !== requestId || key !== JSON.stringify([getOptions().context, getOptions().scope])) return;
      catalog = Array.isArray(items) ? items : [];
    } catch (failure) { if (alive && version === requestId) error = failure.message || '读取来源失败'; }
    finally {
      if (alive && version === requestId) { loading = false; ['worldbook', 'prompts'].forEach(key => { const list = host.querySelector(`[data-ac-ref-list="${key}"]`), selected = host.querySelector(`[data-ac-ref-picks="${key}"]`); if (list) list.innerHTML = sourceList(key); if (selected) selected.innerHTML = picks(key); }); }
    }
  };
  const loadBook = async bookId => {
    if (loadingBooks.has(bookId) || typeof actions.listAgentReferenceSources !== 'function') return;
    loadingBooks.add(bookId); const request = { ...getOptions(), worldbookId: bookId };
    const current = requestId, key = JSON.stringify([request.context, request.scope]);
    try {
      const result = await actions.listAgentReferenceSources(request);
      if (!alive || current !== requestId || key !== JSON.stringify([getOptions().context, getOptions().scope])) return;
      const merged = new Map((catalog || []).map(item => [item.id, item]));
      for (const item of Array.isArray(result) ? result : []) merged.set(item.id, item);
      catalog = [...merged.values()];
    } catch (failure) { if (alive) error = failure.message || '读取来源失败'; }
    finally {
      loadingBooks.delete(bookId);
      if (alive) { const output = host.querySelector('[data-ac-ref-list="worldbook"]'); if (output) output.innerHTML = error ? `<div class="ac-reference-empty">${e(t(error))}</div>` + sourceList('worldbook') : sourceList('worldbook'); }
    }
  };
  const renderPreview = () => {
    const output = host.querySelector('[data-ac-ref-preview]'); if (!output || !preview) return;
    const status = { missing:'来源已失效', disabled:'来源已停用', unavailable:'暂不可用', empty:'内容为空', truncated:'已截断', covered:'已包含在整本中' };
    output.innerHTML = `<div class="ac-reference-manifest">${(preview.sources || []).map(source => `<div><span data-i18n-skip="true">${e(source.title)}</span><span>${e(source.status === 'included' ? t('{count} 字', { count: source.chars }) : t(status[source.status] || source.status))}</span></div>`).join('')}</div>${preview.truncated ? `<div class="ac-reference-warning">${e(t('已按字符上限截取'))}</div>` : ''}${(preview.warnings || []).map(warning => `<div class="ac-reference-warning">${e(t(typeof warning === 'string' ? warning : warning.message || '部分来源暂不可用'))}</div>`).join('')}${preview.text ? `<details data-ac-section="reference-content"><summary>${e(t('查看实际参考文字'))} <span class="ac-source">${e(t('{count} 字', { count: preview.chars || preview.text.length }))}</span></summary><pre data-i18n-skip="true" tabindex="0">${e(preview.text)}</pre></details>` : `<div class="ac-reference-empty">${e(t(builtin ? '本次没有附加资料' : '本次没有参考资料'))}</div>`}`;
  };
  const change = event => {
    const field = event.target, key = field.dataset.acRefField, source = field.dataset.acRefSource, role = field.dataset.acRefRole;
    if (key) {
      const parts = key.split('.'), target = parts.length > 1 ? draft[parts[0]] : draft, prop = parts.at(-1);
      target[prop] = field.type === 'checkbox' ? field.checked : clamp(field.value, prop === 'maxChars' ? 10000 : 3, prop === 'maxChars' ? 500 : 1, prop === 'maxChars' ? 40000 : 50);
      notify(); render(); host.querySelector(`[data-ac-ref-field="${key}"]`)?.focus({ preventScroll: true });
      if (key.endsWith('.enabled') && field.checked) void load();
    } else if (source) {
      const id = field.dataset.sourceId;
      let ids = [...draft[source].ids];
      if (field.checked && source === 'worldbook') {
        const selected = catalog?.find(item => item.id === id);
        if (selected?.bookId) ids = ids.filter(priorId => {
          const prior = catalog.find(item => item.id === priorId);
          return !prior || prior.bookId !== selected.bookId || (!selected.whole && !prior.whole);
        });
      }
      ids = field.checked ? [...new Set([...ids, id])] : ids.filter(value => value !== id);
      if (ids.length > 80) { field.checked = false; onStatus(t('每类最多选择 {count} 个来源', { count: 80 })); return; }
      draft[source].ids = ids;
      notify(); const selected = host.querySelector(`[data-ac-ref-picks="${source}"]`); if (selected) selected.innerHTML = picks(source);
      const count = field.closest('.ac-reference-card').querySelector('.ac-reference-heading>span'); if (count) count.textContent = countLabel(draft[source].ids.length);
      host.querySelectorAll(`[data-ac-ref-source="${source}"]`).forEach(input => { input.checked = draft[source].ids.includes(input.dataset.sourceId); });
    } else if (role) {
      if (!field.checked && draft.history.roles.length === 1) { field.checked = true; return; }
      draft.history.roles = field.checked ? [...new Set([...draft.history.roles, role])] : draft.history.roles.filter(value => value !== role); notify();
    }
  };
  const input = event => {
    const key = event.target.dataset.acRefSearch; if (!key) return;
    search[key] = event.target.value; const list = host.querySelector(`[data-ac-ref-list="${key}"]`); if (list) list.innerHTML = sourceList(key);
  };
  const click = async event => {
    const control = event.target.closest('button'); if (!control) return;
    if (control.hasAttribute('data-ac-ref-book')) { event.preventDefault(); control.disabled = true; control.textContent = t('正在读取…'); await loadBook(control.dataset.acRefBook); }
    else if (control.hasAttribute('data-ac-ref-count') || control.hasAttribute('data-ac-ref-unit')) {
      if (control.dataset.acRefCount) draft.history.count = Number(control.dataset.acRefCount);
      if (control.dataset.acRefUnit) draft.history.unit = control.dataset.acRefUnit;
      const attr = control.dataset.acRefCount ? 'data-ac-ref-count' : 'data-ac-ref-unit', key = control.getAttribute(attr);
      notify(); render(); host.querySelector(`[${attr}="${key}"]`)?.focus({ preventScroll: true });
    } else if (control.dataset.acRefRemove) {
      const key = control.dataset.acRefRemove; draft[key].ids = draft[key].ids.filter(id => id !== control.dataset.sourceId); notify(); render();
    } else if (control.hasAttribute('data-ac-ref-refresh')) await load(true);
    else if (control.hasAttribute('data-ac-ref-preview-button')) {
      if (typeof actions.previewAgentReferenceContext !== 'function') return;
      const version = ++previewId, request = getOptions(); control.disabled = true;
      const output = host.querySelector('[data-ac-ref-preview]'); output.textContent = t('正在构建预览…');
      try {
        const result = await actions.previewAgentReferenceContext(request);
        if (!alive || version !== previewId || JSON.stringify(getOptions()) !== JSON.stringify(request)) return;
        preview = result; renderPreview();
      } catch (failure) { if (alive && version === previewId) output.textContent = t(failure.message || '构建预览失败'); }
      finally { if (alive) control.disabled = false; }
    }
  };
  const toggle = event => { if (event.target.open && event.target.dataset.acSection === 'context') void load(); };
  host.addEventListener('change', change); host.addEventListener('input', input); host.addEventListener('click', click); host.addEventListener('toggle', toggle, true);
  render(); if (host.querySelector('[data-ac-section="context"]')?.open) void load();
  return { snapshot: () => ({ open: openedDetails(host), search: { ...search } }), dispose: () => { alive = false; requestId++; previewId++; host.removeEventListener('change', change); host.removeEventListener('input', input); host.removeEventListener('click', click); host.removeEventListener('toggle', toggle, true); } };
};

export const createAgentToolCapabilitiesEditor = ({ host, value, actions, getOptions, onChange, onStatus = () => {}, state = null }) => {
  const doc = host.ownerDocument; installStyle(doc);
  let draft = { enabled: false, ids: [], maxRounds: 4, ...clone(value || {}) }, items = null, alive = true, version = 0, loading = false, error = '';
  let search = state?.search || '', initialOpen = state?.open || [];
  const list = () => {
    if (loading || !items) return `<div class="ac-reference-empty">${e(t(error || '正在读取工具…'))}</div>`;
    const query = search.trim().toLocaleLowerCase();
    const visible = items.filter(item => !query || `${item.label} ${item.id} ${item.category || ''} ${item.description || ''}`.toLocaleLowerCase().includes(query));
    const missing = draft.ids.filter(id => !items.some(item => item.id === id)).map(id => ({ id, label: t('工具已失效'), available: false }));
    if (!visible.length && !missing.length) return `<div class="ac-reference-empty">${e(t(query ? '没有匹配的工具' : '当前没有可用工具'))}</div>`;
    return [...missing, ...visible].map(item => `<label class="ac-reference-option"><input type="checkbox" data-ac-tool-id="${e(item.id)}" ${draft.ids.includes(item.id) ? 'checked' : ''} ${item.available === false && !draft.ids.includes(item.id) ? 'disabled' : ''}><span><strong ${item.description || item.reason ? `class="has-help" tabindex="0" data-help-mode="tap" data-help="${e(t(item.reason || item.description))}"` : ''}>${e(t(item.label))}</strong>${item.category || item.available === false ? `<small>${e(t(item.available === false ? item.reason || '工具暂不可用' : item.category))}</small>` : ''}</span></label>`).join('');
  };
  const notify = () => { onChange(clone(draft)); const el = host.querySelector('[data-ac-tools-summary]'); if (el) el.textContent = draft.enabled ? countLabel(draft.ids.length) : t('未启用'); };
  const render = () => {
    const open = initialOpen.length ? initialOpen : openedDetails(host); initialOpen = [];
    host.innerHTML = `<details class="ac-reference-tools" data-ac-section="tools"><summary><span class="ac-reference-summary">${help('可用工具', '勾选允许此 Agent 按需使用的工具；工具结果作为参考，修改建议仍需确认。')}<span class="ac-source" data-ac-tools-summary>${e(draft.enabled ? countLabel(draft.ids.length) : t('未启用'))}</span></span></summary><section class="ac-reference-card${draft.enabled ? ' is-enabled' : ''}"><div class="ac-reference-heading"><label><input type="checkbox" data-ac-tools-enabled ${draft.enabled ? 'checked' : ''}>${e(t('允许调用工具'))}</label></div>${draft.enabled ? `<div class="ac-reference-body"><input type="search" class="ac-reference-search" data-ac-tools-search value="${e(search)}" placeholder="${e(t('搜索工具'))}" aria-label="${e(t('搜索工具'))}"><div class="ac-reference-list" data-ac-tools-list>${list()}</div><details class="ac-reference-advanced" data-ac-section="tool-limits"><summary>${e(t('调用上限'))}</summary><label>${help('最多工具轮次', '一次任务内最多进行的工具调用轮数；达到上限后生成结果。')}<input type="number" min="1" max="8" inputmode="numeric" data-ac-tools-rounds value="${draft.maxRounds}"></label></details><button type="button" class="agent-center-card-action" data-ac-tools-refresh>${e(t('刷新工具'))}</button></div>` : ''}</section></details>`;
    restoreDetails(host, open);
  };
  const load = async (force = false) => {
    if ((items && !force) || loading || typeof actions.listAgentAvailableTools !== 'function') return;
    const request = getOptions(), current = ++version; loading = true; error = '';
    try { const result = await actions.listAgentAvailableTools(request); if (alive && current === version) items = Array.isArray(result) ? result : []; }
    catch (failure) { if (alive && current === version) error = failure.message || '读取工具失败'; }
    finally { if (alive && current === version) { loading = false; const output = host.querySelector('[data-ac-tools-list]'); if (output) output.innerHTML = list(); } }
  };
  const change = event => {
    const field = event.target;
    if (field.hasAttribute('data-ac-tools-enabled')) { draft.enabled = field.checked; notify(); render(); host.querySelector('[data-ac-tools-enabled]')?.focus({ preventScroll: true }); if (draft.enabled) void load(); }
    else if (field.hasAttribute('data-ac-tools-rounds')) { draft.maxRounds = clamp(field.value, 4, 1, 8); field.value = draft.maxRounds; notify(); }
    else if (field.dataset.acToolId) {
      const ids = field.checked ? [...new Set([...draft.ids, field.dataset.acToolId])] : draft.ids.filter(id => id !== field.dataset.acToolId);
      if (ids.length > 12) { field.checked = false; onStatus(t('最多选择 {count} 个工具', { count: 12 })); return; }
      draft.ids = ids; notify();
      if (!field.checked && items?.find(item => item.id === field.dataset.acToolId)?.available === false) field.disabled = true;
    }
  };
  const input = event => { if (event.target.hasAttribute('data-ac-tools-search')) { search = event.target.value; host.querySelector('[data-ac-tools-list]').innerHTML = list(); } };
  const click = event => { if (event.target.closest('[data-ac-tools-refresh]')) void load(true); };
  const toggle = event => { if (event.target.open && event.target.dataset.acSection === 'tools' && draft.enabled) void load(); };
  host.addEventListener('change', change); host.addEventListener('input', input); host.addEventListener('click', click); host.addEventListener('toggle', toggle, true);
  render(); if (draft.enabled && host.querySelector('[data-ac-section="tools"]')?.open) void load();
  return { snapshot: () => ({ open: openedDetails(host), search }), dispose: () => { alive = false; version++; host.removeEventListener('change', change); host.removeEventListener('input', input); host.removeEventListener('click', click); host.removeEventListener('toggle', toggle, true); } };
};
