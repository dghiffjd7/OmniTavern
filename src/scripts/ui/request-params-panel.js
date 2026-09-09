import { t, translateUiText } from '../i18n/index.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { normalizeGenerationParamFilterList, COMMON_GENERATION_PARAM_FILTERS } from '../utils/generation-param-filter-utils.js';
import {
  MAX_REQUEST_PARAMS, REQUEST_PARAM_TYPES, normalizeCustomRequestParams, parseRequestParamPath,
  parseRequestParamValue, formatRequestParamValue, validateCustomRequestParams,
  getRequestParamProtocol, getRequestParamProtection, getCommonRequestParams,
  requestParamsToJson, requestParamsFromJson, resolveExcludedRequestParamPaths,
} from '../api/request-params.js';
import { requestParamStatusLabel, renderRequestParamReport } from './request-param-report-view.js';
import { partitionPresetRequestParam } from '../api/request-param-ownership.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const draftRow = row => ({ ...row, valueText: formatRequestParamValue(row) });
const typeLabel = type => ({ string: t('文本'), number: t('数字'), boolean: t('布尔'), object: t('对象'), array: t('数组'), null: 'null' })[type];
const help = (label, text) => `<span class="has-help" tabindex="0" data-help="${esc(text)}">${esc(label)}</span>`;

export const openRequestParamsPanel = ({ config = {}, onApply, onClose, onOpenPreset, buildPreview, icons = {} } = {}) => {
  const protocol = getRequestParamProtocol(config);
  const common = getCommonRequestParams(protocol, { config });
  let rows = normalizeCustomRequestParams(config.customRequestParams).map(draftRow);
  let excluded = normalizeGenerationParamFilterList(config.excludedGenerationParams);
  let tab = 'custom', jsonMode = false, disposed = false, previewTimer = null, previewVersion = 0;
  const returnFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'api-param-filter-overlay';
  overlay.innerHTML = `
    <div class="api-param-filter-dialog" role="dialog" aria-modal="true" aria-labelledby="api-request-params-title">
      <header class="api-param-filter-header">
        <h3 id="api-request-params-title">${help(t('请求参数'), t('保存在当前连线设置档；生成参数在预设中编辑，附加参数补充接口字段，排除规则最后执行。'))}</h3>
        <button type="button" class="api-param-filter-icon-button" data-rp-action="cancel" aria-label="${esc(t('关闭'))}">${icons.close || '×'}</button>
      </header>
      <div class="api-request-param-tabs" role="tablist" aria-label="${esc(t('请求参数'))}">
        <button type="button" id="request-params-custom-tab" role="tab" aria-controls="request-params-custom" aria-selected="true" data-rp-tab="custom">${esc(t('附加'))}<span data-rp-count="custom"></span></button>
        <button type="button" id="request-params-exclude-tab" role="tab" aria-controls="request-params-exclude" aria-selected="false" tabindex="-1" data-rp-tab="exclude">${esc(t('排除'))}<span data-rp-count="exclude"></span></button>
      </div>
      <div class="api-param-filter-body">
        <section id="request-params-custom" role="tabpanel" aria-labelledby="request-params-custom-tab">
          <div class="api-request-param-toolbar">
            ${help(t('附加参数'), t('补充预设尚未提供的接口字段；点号表示嵌套路径。对象按字段合并，数组整体替换。归预设管理的旧项保留原值。'))}
            <div><button type="button" class="api-param-filter-button is-secondary" data-rp-action="json" aria-pressed="false">JSON</button><button type="button" class="api-param-filter-button is-primary" data-rp-action="add">${icons.plus || '+'}<span>${esc(t('添加参数'))}</span></button></div>
          </div>
          <div data-rp-role="rows-editor">
            <details class="api-request-param-common" ${rows.length ? '' : 'open'}><summary>${esc(t('常用参数'))}</summary>
              <div class="api-param-filter-common">${common.map((row, index) => `<button type="button" class="api-param-filter-common-chip" data-rp-common="${index}" data-i18n-skip="true">${esc(row.name)}</button>`).join('')}</div>
            </details>
            ${typeof onOpenPreset === 'function' ? `<button type="button" class="api-request-param-preset-link" data-rp-action="preset">${esc(t('生成参数'))}${icons.chevronRight || '›'}</button>` : ''}
            <div class="api-request-param-rows" data-rp-role="rows"></div>
          </div>
          <div class="api-request-param-json" data-rp-role="json-editor" hidden>
            <label>${help(t('JSON 编辑'), t('编辑启用项的附加字段；停用项保留在列表。生成参数仍由预设管理，原值保留供整理。'))}</label>
            <textarea class="api-param-filter-input" data-rp-role="json" rows="10" spellcheck="false" aria-label="${esc(t('JSON 编辑'))}" data-i18n-skip="true"></textarea>
            <div class="api-request-param-json-ownership" data-rp-role="json-ownership" aria-live="polite"></div>
          </div>
        </section>
        <section id="request-params-exclude" role="tabpanel" aria-labelledby="request-params-exclude-tab" hidden>
          <div class="api-param-filter-section-heading">${help(t('排除参数'), t('在实际请求 JSON 中删除所选字段，支持嵌套路径。旧参数别名按当前接口转换；必填字段和任务所需字段按对应约束处理。'))}</div>
          <div class="api-param-filter-common" data-rp-role="exclude-common"></div>
          <div class="api-param-filter-custom">
            <input class="api-param-filter-input" data-rp-role="exclude-input" type="text" maxlength="160" placeholder="${esc(t('输入参数名'))}" aria-label="${esc(t('排除参数名'))}" spellcheck="false">
            <button type="button" class="api-param-filter-button is-primary" data-rp-action="exclude-add">${icons.plus || '+'}<span>${esc(t('加入'))}</span></button>
          </div>
          <div class="api-param-filter-selected" data-rp-role="excluded"></div>
        </section>
        <div class="api-param-filter-error" data-rp-role="error" role="alert"></div>
        <details class="api-request-param-preview" data-rp-role="preview">
          <summary>${help(t('请求预览'), t('使用当前配置与预设组装示例请求；实际正文和 Agent 使用各自上下文与任务限制。'))}</summary>
          <div data-rp-role="report"></div>
          <pre data-rp-role="preview-json" data-i18n-skip="true"></pre>
        </details>
      </div>
      <footer class="api-param-filter-footer">
        <button type="button" class="api-param-filter-button is-clear" data-rp-action="clear">${esc(t('清空'))}</button>
        <div class="api-param-filter-footer-actions">
          <button type="button" class="api-param-filter-button is-secondary" data-rp-action="cancel">${esc(t('取消'))}</button>
          <button type="button" class="api-param-filter-button is-primary is-apply" data-rp-action="apply">${esc(t('完成'))}</button>
        </div>
      </footer>
    </div>`;
  const q = selector => overlay.querySelector(selector);
  const role = name => q(`[data-rp-role="${name}"]`);
  const error = message => { role('error').textContent = translateUiText(String(message || '')); };
  const ownershipFor = row => {
    let value = row.value;
    try { value = parseRequestParamValue(row.type, row.valueText); } catch {}
    return partitionPresetRequestParam({ ...row, value }, { config });
  };
  const statusFor = row => {
    const ownership = ownershipFor(row);
    if (ownership.status) return ownership.status;
    if (!row.enabled) return 'disabled';
    const reason = getRequestParamProtection(row.name, { config, protocol });
    if (reason) return reason;
    const paths = excluded.flatMap(name => resolveExcludedRequestParamPaths(name, protocol));
    if (paths.some(path => row.name === path || row.name.startsWith(path + '.'))) return 'excluded';
    if (paths.some(path => path.startsWith(row.name + '.'))) return 'partially_excluded';
    return '';
  };
  const readRows = () => {
    const parsed = rows.map((row, index) => {
      try { return { name: row.name.trim(), type: row.type, enabled: row.enabled, value: parseRequestParamValue(row.type, row.valueText) }; }
      catch (err) { throw new Error(t('第 {count} 项：{message}', { count: index + 1, message: translateUiText(err.message) })); }
    });
    const errors = validateCustomRequestParams(parsed);
    if (errors.length) throw new Error(t('第 {count} 项：{message}', { count: errors[0].index + 1, message: translateUiText(errors[0].message) }));
    return parsed;
  };
  const currentRows = () => jsonMode ? requestParamsFromJson(role('json').value, readRows()) : readRows();
  const updateCounts = () => {
    q('[data-rp-count="custom"]').textContent = rows.filter(row => row.enabled && ownershipFor(row).hasValue && !getRequestParamProtection(row.name, { config, protocol })).length || '';
    q('[data-rp-count="exclude"]').textContent = excluded.length || '';
  };
  const valueField = row => row.type === 'boolean'
    ? `<select class="api-param-filter-input" data-rp-field="valueText" aria-label="${esc(t('参数值'))}"><option value="true" ${row.valueText === 'true' ? 'selected' : ''}>true</option><option value="false" ${row.valueText !== 'true' ? 'selected' : ''}>false</option></select>`
    : row.type === 'null'
      ? `<input class="api-param-filter-input" value="null" readonly aria-label="${esc(t('参数值'))}">`
      : `<textarea class="api-param-filter-input" data-rp-field="valueText" rows="${['array', 'object'].includes(row.type) ? 3 : 1}" spellcheck="false" aria-label="${esc(t('参数值'))}" ${row.type === 'number' ? 'inputmode="decimal"' : ''} data-i18n-skip="true">${esc(row.valueText)}</textarea>`;
  const renderRows = () => {
    role('rows').innerHTML = rows.length ? rows.map((row, index) => {
      const status = statusFor(row);
      return `<article class="api-request-param-row${row.enabled ? '' : ' is-disabled'}" data-rp-row="${index}">
        <header><label class="api-request-param-toggle"><input type="checkbox" data-rp-field="enabled" ${row.enabled ? 'checked' : ''} aria-label="${esc(t('启用参数'))}"><span aria-hidden="true"></span></label><span class="api-request-param-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><small class="api-request-param-state" data-rp-state>${status ? esc(requestParamStatusLabel(status)) : ''}</small><button type="button" class="api-param-filter-icon-button" data-rp-action="remove" aria-label="${esc(t('删除参数'))}">${icons.trash || icons.close || '×'}</button></header>
        <div class="api-request-param-fields">
          <label class="api-request-param-name"><span>${esc(t('参数名'))}</span><input class="api-param-filter-input" data-rp-field="name" value="${esc(row.name)}" maxlength="160" spellcheck="false" autocapitalize="off" placeholder="${esc(t('输入参数名'))}" data-i18n-skip="true"></label>
          <label class="api-request-param-type"><span>${esc(t('类型'))}</span><select class="api-param-filter-input" data-rp-field="type">${REQUEST_PARAM_TYPES.map(type => `<option value="${type}" ${type === row.type ? 'selected' : ''}>${esc(typeLabel(type))}</option>`).join('')}</select></label>
          <label class="api-request-param-value"><span>${esc(t('参数值'))}</span>${valueField(row)}</label>
        </div>
      </article>`;
    }).join('') : `<div class="api-param-filter-empty">${esc(t('暂无附加参数'))}</div>`;
    role('rows').querySelectorAll('[data-rp-row]').forEach(article => updateRowState(article, rows[Number(article.dataset.rpRow)]));
    updateCounts();
  };
  const updateRowState = (article, row) => {
    const status = statusFor(row), ownership = ownershipFor(row);
    const state = article.querySelector('[data-rp-state]');
    state.innerHTML = `${status ? esc(requestParamStatusLabel(status)) : ''}${ownership.status && typeof onOpenPreset === 'function' ? ` <button type="button" class="api-request-param-preset-link" data-rp-action="preset" data-rp-preset-field="${esc(ownership.blocked[0]?.field || '')}">${esc(t('前往设置'))}</button>` : ''}`;
    const managed = status === 'preset';
    article.classList.toggle('is-preset-managed', managed);
    for (const input of article.querySelectorAll('[data-rp-field="enabled"], [data-rp-field="type"], .api-request-param-value input, .api-request-param-value textarea, .api-request-param-value select')) input.disabled = managed;
    article.querySelector('[data-rp-field="enabled"]').checked = row.enabled && !managed;
  };
  const updateJsonOwnership = () => {
    const host = role('json-ownership');
    if (!jsonMode) { host.innerHTML = ''; return; }
    try {
      const affected = currentRows().map(row => ({ row, parts: partitionPresetRequestParam(row, { config }) })).filter(item => item.parts.status);
      host.innerHTML = affected.map(({ row, parts }) => `<div><code data-i18n-skip="true">${esc(row.name)}</code><span>${esc(requestParamStatusLabel(parts.status))}</span>${typeof onOpenPreset === 'function' ? `<button type="button" class="api-request-param-preset-link" data-rp-action="preset" data-rp-preset-field="${esc(parts.blocked[0]?.field || '')}">${esc(t('前往设置'))}</button>` : ''}</div>`).join('');
    } catch { host.innerHTML = ''; }
  };
  const renderExcluded = () => {
    const commonNames = [...new Set([...getCommonRequestParams(protocol, { forExclusion: true }).map(row => row.name), ...COMMON_GENERATION_PARAM_FILTERS.filter(name => excluded.includes(name))])];
    role('exclude-common').innerHTML = commonNames.map(name => `<button type="button" class="api-param-filter-common-chip${excluded.includes(name) ? ' is-active' : ''}" data-rp-exclude="${esc(name)}" aria-pressed="${excluded.includes(name)}"><span data-i18n-skip="true">${esc(name)}</span>${excluded.includes(name) ? icons.check || '' : ''}</button>`).join('');
    role('excluded').innerHTML = excluded.length ? excluded.map(name => `<span class="api-param-filter-selected-chip"><span data-i18n-skip="true">${esc(name)}</span><button type="button" data-rp-exclude="${esc(name)}" aria-label="${esc(t('移除参数'))}">${icons.close || '×'}</button></span>`).join('') : `<div class="api-param-filter-empty">${esc(t('暂无排除项'))}</div>`;
    updateCounts();
  };
  const refreshPreview = async () => {
    clearTimeout(previewTimer);
    if (!role('preview').open || typeof buildPreview !== 'function') return;
    const version = ++previewVersion;
    try {
      const prepared = await buildPreview({ customRequestParams: currentRows(), excludedGenerationParams: [...excluded] });
      if (disposed || version !== previewVersion) return;
      role('preview-json').textContent = JSON.stringify(prepared?.body || prepared?.payload || {}, null, 2);
      role('report').innerHTML = renderRequestParamReport(prepared?.parameterReport);
    } catch (err) {
      if (disposed || version !== previewVersion) return;
      role('preview-json').textContent = translateUiText(err.message);
      role('report').innerHTML = '';
    }
  };
  const changed = () => {
    error(''); updateCounts(); updateJsonOwnership(); ++previewVersion;
    clearTimeout(previewTimer);
    if (role('preview').open) previewTimer = setTimeout(refreshPreview, 150);
  };
  const switchTab = next => {
    tab = next;
    overlay.querySelectorAll('[data-rp-tab]').forEach(button => {
      const selected = button.dataset.rpTab === tab;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
    q('#request-params-custom').hidden = tab !== 'custom';
    q('#request-params-exclude').hidden = tab !== 'exclude';
    error('');
    if (tab === 'custom') renderRows();
  };
  const close = () => {
    if (disposed) return;
    disposed = true; ++previewVersion; clearTimeout(previewTimer);
    unbindBackdrop(); overlay.remove(); onClose?.();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const unbindBackdrop = bindBackdropActivation(overlay, { onActivate: close });
  const addRow = row => {
    if (rows.length >= MAX_REQUEST_PARAMS) { error(t('自定义参数最多 100 项')); return; }
    if (jsonMode) {
      try { rows = currentRows().map(draftRow); } catch (err) { error(err.message); return; }
      jsonMode = false; role('json-editor').hidden = true; role('rows-editor').hidden = false;
      q('[data-rp-action="json"]').setAttribute('aria-pressed', 'false');
    }
    rows.push(draftRow(row || { name: '', type: 'string', value: '', enabled: true }));
    renderRows(); changed();
    role('rows').lastElementChild?.querySelector('[data-rp-field="name"]')?.focus();
  };
  const addExclusion = () => {
    const names = role('exclude-input').value.split(/[\s,，;；]+/).filter(Boolean);
    try {
      if (!names.length) throw new Error(t('请输入参数名'));
      names.forEach(parseRequestParamPath);
      if (new Set([...excluded, ...names]).size > MAX_REQUEST_PARAMS) throw new Error(t('排除参数最多 100 项'));
      excluded = normalizeGenerationParamFilterList([...excluded, ...names]);
      role('exclude-input').value = ''; renderExcluded(); changed();
    } catch (err) { error(err.message); }
  };
  overlay.addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target || !overlay.contains(target)) return;
    if (target.dataset.rpTab) { switchTab(target.dataset.rpTab); return; }
    if (target.dataset.rpCommon !== undefined) { addRow(common[Number(target.dataset.rpCommon)]); return; }
    if (target.dataset.rpExclude) {
      const name = target.dataset.rpExclude;
      if (!excluded.includes(name) && excluded.length >= MAX_REQUEST_PARAMS) { error(t('排除参数最多 100 项')); return; }
      excluded = excluded.includes(name) ? excluded.filter(item => item !== name) : [...excluded, name];
      renderExcluded(); renderRows(); changed(); return;
    }
    const action = target.dataset.rpAction;
    if (action === 'preset' && typeof onOpenPreset === 'function') {
      try {
        const rules = { customRequestParams: currentRows(), excludedGenerationParams: [...excluded] };
        overlay.classList.add('is-suspended');
        await onOpenPreset({ field: target.dataset.rpPresetField || '', rules });
      } catch (err) { if (!disposed) error(err.message); }
      finally {
        if (!disposed) { overlay.classList.remove('is-suspended'); target.focus({ preventScroll: true }); refreshPreview(); }
      }
    } else if (action === 'cancel') close();
    else if (action === 'add') addRow();
    else if (action === 'remove') { rows.splice(Number(target.closest('[data-rp-row]').dataset.rpRow), 1); renderRows(); changed(); }
    else if (action === 'exclude-add') addExclusion();
    else if (action === 'clear') {
      if (tab === 'custom') { rows = []; role('json').value = '{}'; renderRows(); }
      else { excluded = []; renderExcluded(); }
      changed();
    } else if (action === 'json') {
      try {
        if (jsonMode) { rows = currentRows().map(draftRow); renderRows(); }
        else role('json').value = requestParamsToJson(readRows());
        jsonMode = !jsonMode;
        role('rows-editor').hidden = jsonMode; role('json-editor').hidden = !jsonMode;
        target.setAttribute('aria-pressed', String(jsonMode)); error('');
        updateJsonOwnership();
        if (jsonMode) role('json').focus();
      } catch (err) { error(err.message); }
    } else if (action === 'apply') {
      try { onApply?.({ customRequestParams: currentRows(), excludedGenerationParams: [...excluded] }); close(); }
      catch (err) { error(err.message); }
    }
  });
  const updateRow = event => {
    const input = event.target, field = input.dataset.rpField;
    if (!field) { if (input === role('json')) changed(); return; }
    const article = input.closest('[data-rp-row]');
    if (!article) return;
    const row = rows[Number(article.dataset.rpRow)];
    if (!row) return;
    if (field === 'enabled') {
      row.enabled = input.checked;
      article.classList.toggle('is-disabled', !row.enabled);
    } else if (field === 'type') {
      if (row.type === input.value) return;
      row.type = input.value;
      // Retain the draft for text/numeric edits; initialize structured types explicitly.
      if (row.type === 'null') row.valueText = 'null';
      else if (row.type === 'boolean' && !['true', 'false'].includes(row.valueText)) row.valueText = 'false';
      else if (row.type === 'object' && !row.valueText.trim().startsWith('{')) row.valueText = '{}';
      else if (row.type === 'array' && !row.valueText.trim().startsWith('[')) row.valueText = '[]';
      const valueLabel = article.querySelector('.api-request-param-value');
      valueLabel.innerHTML = `<span>${esc(t('参数值'))}</span>${valueField(row)}`;
    } else row[field] = input.value;
    updateRowState(article, row);
    changed();
  };
  overlay.addEventListener('input', updateRow);
  overlay.addEventListener('change', updateRow);
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.target === role('exclude-input') && event.key === 'Enter') { event.preventDefault(); addExclusion(); return; }
    if (event.target.dataset.rpTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); switchTab(event.key === 'Home' ? 'custom' : event.key === 'End' ? 'exclude' : tab === 'custom' ? 'exclude' : 'custom');
      q(`[data-rp-tab="${tab}"]`).focus(); return;
    }
    if (event.key === 'Tab') {
      const focusable = [...overlay.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length && el.tabIndex >= 0);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  role('preview').addEventListener('toggle', refreshPreview);
  renderRows(); renderExcluded();
  document.body.append(overlay);
  q('[data-rp-tab="custom"]').focus({ preventScroll: true });
  return { close, element: overlay };
};
