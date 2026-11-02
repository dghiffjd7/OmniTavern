// 变量管理器的「注入总览」与「模板测试」页（计划书 M4，逻辑层模拟）。
// 假设值只存在这个面板里：判断用纯函数求值，注入文字用沙盒宏状态与只读 EJS 渲染，不写任何真实变量。

import { t } from '../i18n/index.js';
import {
  buildInjectionContext,
  buildSandboxVariables,
  collectInjectionItems,
  evaluateInjectionItem,
  groupInjectionItemsByPath,
  parseHypotheticalValue,
} from '../variables/injection-overview.js';
import { renderTemplateTextAsync, templateSettings } from '../plugins/template-engine.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const shortValue = (value) => {
  if (value === undefined) return t('（未设置）');
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
};
const STATUS_LABELS = Object.freeze({ hit: '命中', miss: '未命中', keyword: '需要关键词', pending: '缺变量', error: '表达式出错' });
const KIND_LABELS = Object.freeze({ world: '世界书', rule: '规则', stage: '阶段' });

// 宏沙盒：按 MacroEngine 的键格式预先放进假设值，读写都留在这个 Map 里
const buildMacroSandbox = (sid, { localVars = {}, globalVars = {} } = {}) => {
  const state = new Map();
  Object.entries(localVars).forEach(([key, value]) => state.set(`session:${sid}\u0000${key}`, value));
  Object.entries(globalVars).forEach(([key, value]) => state.set(`global\u0000${key}`, value));
  return state;
};

export const createVariableInjectionPages = ({
  chatStore,
  getSessionId = () => '',
  isSharedSession = () => false,
  getBridge = () => globalThis.window?.appBridge || null,
  openWorldEditor = null,
  openRuleEditor = null,
} = {}) => {
  const overrides = new Map();
  let items = [];
  let overviewHost = null;
  let labHost = null;
  let labSource = '';
  let labUseHypothetical = true;
  let labTimer = null;
  let labRequest = 0;
  let loadRequest = 0;

  const sid = () => String(getSessionId() || '').trim();
  const realVars = () => ({
    localVars: chatStore?.listVariables?.(sid()) || {},
    globalVars: chatStore?.listGlobalVariables?.() || {},
    shared: Boolean(isSharedSession(sid())),
  });
  const sandboxVars = () => {
    const real = realVars();
    return { ...buildSandboxVariables({ ...real, overrides: Object.fromEntries(overrides) }), shared: real.shared };
  };
  const contexts = vars => ({
    ctx: buildInjectionContext(vars),
    localCtx: buildInjectionContext({ ...vars, shared: false }),
  });

  // 注入文字：先跑宏（沙盒状态），再跑 EJS（只读、假的变量来源），与发送时的先后一致
  const renderInjectedText = async (raw, vars) => {
    const bridge = getBridge();
    const id = sid();
    let textOut = String(raw ?? '');
    try {
      textOut = bridge?.processTextMacros?.(textOut, { sessionId: id, macroVariableState: buildMacroSandbox(id, vars) }) ?? textOut;
    } catch {}
    const fakeStore = {
      listVariables: () => vars.localVars,
      listGlobalVariables: () => vars.globalVars,
      listInitialVariables: () => chatStore?.listInitialVariables?.(id) || {},
    };
    const result = await renderTemplateTextAsync(textOut, {
      stage: 'generate', chatStore: fakeStore, sessionId: id, readOnly: true,
      context: { meta: { useGlobalVariables: vars.shared } },
    });
    return { text: result?.text ?? textOut, error: result?.error ? String(result.error.message || result.error) : '' };
  };

  const loadItems = async () => {
    const id = sid();
    const bridge = getBridge();
    const worldIds = new Set((bridge?.getResolvedWorldState?.(id, { uiMode: id.startsWith('rp:') ? 'rp' : 'chat' })?.worldIds || []).map(String).filter(Boolean));
    const worlds = [];
    for (const worldId of worldIds) {
      const world = await bridge?.getWorldInfo?.(worldId);
      if (world) worlds.push({ id: worldId, name: String(world.name || worldId), world });
    }
    return collectInjectionItems({
      worlds,
      rules: chatStore?.listVariableRules?.(id) || [],
      stageSchema: chatStore?.getStageSchema?.(id) || null,
    });
  };

  const statusHtml = (item, result) => {
    if (item.kind === 'stage') {
      return result.injected ? t('注入阶段「{name}」', { name: result.injected.name }) : t('不注入（{var} 没有对应阶段）', { var: item.stageVar });
    }
    return t(STATUS_LABELS[result.status] || result.status);
  };

  const updateStatuses = () => {
    if (!overviewHost) return;
    const now = contexts(realVars());
    const hasOverrides = overrides.size > 0;
    const then = hasOverrides ? contexts(sandboxVars()) : null;
    overviewHost.querySelectorAll('[data-inj-item]').forEach((row) => {
      const item = items.find(entry => entry.id === row.dataset.injItem);
      if (!item) return;
      const before = evaluateInjectionItem(item, now);
      const after = then ? evaluateInjectionItem(item, then) : null;
      const changed = Boolean(after) && (after.status !== before.status || after.injected?.id !== before.injected?.id);
      row.classList.toggle('is-changed', changed);
      row.querySelector('[data-inj-now]').textContent = statusHtml(item, before);
      row.querySelector('[data-inj-now]').dataset.status = before.status;
      const thenEl = row.querySelector('[data-inj-then]');
      thenEl.hidden = !after;
      if (after) {
        thenEl.textContent = `→ ${statusHtml(item, after)}`;
        thenEl.dataset.status = after.status;
      }
      const next = row.querySelector('[data-inj-next-stage]');
      if (next) {
        const resolved = (after || before).resolved;
        const injected = (after || before).injected;
        next.hidden = !resolved || resolved.id === injected?.id;
        next.textContent = resolved ? t('按条件应处于「{name}」，下一次回复后切换', { name: resolved.name }) : '';
      }
    });
    const clear = overviewHost.querySelector('[data-inj-action="clear"]');
    if (clear) clear.disabled = !hasOverrides;
  };

  const itemHtml = item => `<div class="var-inj-item" data-inj-item="${e(item.id)}">
      <div class="var-inj-item-head">
        <span class="var-inj-kind">${e(t(KIND_LABELS[item.kind]))}</span>
        <span class="var-inj-label" data-i18n-skip>${e(item.kind === 'stage' ? t('阶段变量 {var}', { var: item.stageVar }) : item.label)}</span>
        <span class="var-inj-status" data-inj-now></span><span class="var-inj-status is-then" data-inj-then hidden></span>
      </div>
      ${item.kind === 'stage' ? '<div class="var-inj-note" data-inj-next-stage hidden></div>' : ''}
      ${item.kind === 'rule' ? `<div class="var-inj-note" data-i18n-skip>${e(t('条件：{expr} · 动作：{action}', { expr: item.expr, action: t(item.actionLabel) }))}</div>` : ''}
      ${item.kind === 'world' && item.activation === 'keyword' ? `<div class="var-inj-note">${e(t('条件满足后，还要聊天里出现关键词才会注入。'))}</div>` : ''}
      <div class="var-inj-actions">
        ${(item.kind === 'stage' || item.content) ? `<button type="button" class="variable-secondary-button" data-inj-action="preview" data-inj-target="${e(item.id)}">${e(t('看要注入的文字'))}</button>` : ''}
        ${(item.kind === 'world' && openWorldEditor) || (item.kind === 'rule' && openRuleEditor) ? `<button type="button" class="variable-secondary-button" data-inj-action="open" data-inj-target="${e(item.id)}">${e(t('打开'))}</button>` : ''}
      </div>
      <pre class="var-inj-preview" data-inj-preview hidden data-i18n-skip></pre>
    </div>`;

  const renderOverview = async (host) => {
    overviewHost = host;
    if (!host) return;
    const id = sid();
    if (!id) {
      host.innerHTML = `<div class="var-inj-empty">${e(t('打开一个会话后，这里会列出变量会影响哪些注入。'))}</div>`;
      return;
    }
    const request = ++loadRequest;
    host.innerHTML = `<div class="var-inj-empty">${e(t('正在读取世界书与规则…'))}</div>`;
    const loaded = await loadItems().catch(() => []);
    if (request !== loadRequest || overviewHost !== host) return;
    items = loaded;
    const groups = groupInjectionItemsByPath(items);
    const nowCtx = buildInjectionContext(realVars());
    const toolbar = `<div class="var-inj-toolbar"><p>${e(t('只按条件判断，不拼完整提示词。填假设值看会有什么变化，不会改动真实变量。'))}</p>
      <button type="button" class="variable-secondary-button" data-inj-action="clear" disabled>${e(t('清空假设值'))}</button></div>`;
    if (!items.length) {
      host.innerHTML = `${toolbar}<div class="var-inj-empty">${e(t('当前会话没有受变量控制的注入（世界书条件、条件触发的规则、阶段）。'))}</div>`;
      return;
    }
    host.innerHTML = toolbar + [...groups.entries()].map(([path, groupItems]) => {
      const current = path ? nowCtx.resolvePathValue(path) : undefined;
      const override = path && overrides.has(path) ? overrides.get(path) : undefined;
      const inputValue = override === undefined ? '' : (typeof override === 'string' ? override : JSON.stringify(override));
      return `<section class="var-inj-group">
        ${path ? `<div class="var-inj-var"><code data-i18n-skip>${e(path)}</code><span class="var-inj-current" data-i18n-skip>${e(t('现在 {value}', { value: shortValue(current) }))}</span>
          <input class="var-inj-input" data-inj-path="${e(path)}" value="${e(inputValue)}" placeholder="${e(t('假设值'))}" aria-label="${e(t('{path} 的假设值', { path }))}" autocomplete="off" data-i18n-skip></div>`
          : `<div class="var-inj-var"><span>${e(t('其他（条件里没有读到变量）'))}</span></div>`}
        ${groupItems.map(itemHtml).join('')}
      </section>`;
    }).join('');
    updateStatuses();
  };

  const previewItem = async (button) => {
    const row = button.closest('[data-inj-item]');
    const item = items.find(entry => entry.id === row?.dataset.injItem);
    const pre = row?.querySelector('[data-inj-preview]');
    if (!item || !pre) return;
    if (!pre.hidden) { pre.hidden = true; return; }
    const vars = overrides.size ? sandboxVars() : realVars();
    let raw = item.content;
    if (item.kind === 'stage') raw = evaluateInjectionItem(item, contexts(vars)).injected?.prompt || '';
    pre.hidden = false;
    pre.textContent = t('渲染中…');
    const result = await renderInjectedText(raw, vars);
    pre.textContent = `${overrides.size ? `${t('（按假设值渲染）')}\n` : ''}${result.text || t('（空）')}${result.error ? `\n\n${t('模板出错：{error}', { error: result.error })}` : ''}`;
  };

  const openItem = (button) => {
    const item = items.find(entry => entry.id === button.dataset.injTarget);
    if (item?.kind === 'world') openWorldEditor?.(item.worldId, { entryId: item.entryId, blockId: item.blockId });
    if (item?.kind === 'rule') openRuleEditor?.(item.ruleId);
  };

  const onOverviewInput = (event) => {
    const input = event.target.closest?.('[data-inj-path]');
    if (!input) return;
    const path = input.dataset.injPath;
    const raw = input.value;
    if (!raw.trim()) overrides.delete(path);
    else overrides.set(path, parseHypotheticalValue(raw, buildInjectionContext(realVars()).resolvePathValue(path)));
    updateStatuses();
  };

  const onOverviewClick = (event) => {
    const button = event.target.closest?.('[data-inj-action]');
    if (!button) return;
    const action = button.dataset.injAction;
    if (action === 'preview') previewItem(button);
    else if (action === 'open') openItem(button);
    else if (action === 'clear') {
      overrides.clear();
      overviewHost.querySelectorAll('[data-inj-path]').forEach((input) => { input.value = ''; });
      overviewHost.querySelectorAll('[data-inj-preview]').forEach((pre) => { pre.hidden = true; });
      updateStatuses();
    }
  };

  // —— 模板测试 ——
  const knownPaths = () => {
    const vars = realVars();
    const base = vars.shared ? vars.globalVars : vars.localVars;
    return [...new Set([...items.flatMap(item => item.paths), ...Object.keys(base)])].filter(Boolean).sort();
  };

  const SNIPPETS = Object.freeze({
    var: path => `<%= getvar('${path}') %>`,
    if: path => `<% if (getvar('${path}') >= 1) { %>\n${t('条件成立时的内容')}\n<% } else { %>\n${t('否则的内容')}\n<% } %>`,
    macro: path => `{{getvar::${path.split('.')[0]}}}`,
    random: () => `{{random::${t('甲')},${t('乙')},${t('丙')}}}`,
  });

  const runLab = async () => {
    if (!labHost) return;
    const out = labHost.querySelector('[data-lab-output]');
    const request = ++labRequest;
    const vars = labUseHypothetical && overrides.size ? sandboxVars() : realVars();
    const result = await renderInjectedText(labSource, vars);
    if (request !== labRequest || !out) return;
    out.textContent = result.text;
    const err = labHost.querySelector('[data-lab-error]');
    err.hidden = !result.error;
    err.textContent = result.error ? t('模板出错：{error}', { error: result.error }) : '';
  };

  const renderTemplateLab = (host) => {
    labHost = host;
    if (!host) return;
    const id = sid();
    const settings = chatStore?.getSessionSettings?.(id) || {};
    const enabled = templateSettings.shouldRun('generate', { session: { settings } });
    const paths = knownPaths();
    host.innerHTML = `<div class="var-lab">
      ${enabled ? '' : `<div class="var-inj-note is-warning">${e(t('当前会话或设置里关闭了模板，发送时不会渲染 EJS；这里仍可试写。'))}</div>`}
      <div class="var-lab-tools">
        <select data-lab-path aria-label="${e(t('变量'))}" data-i18n-skip>${paths.map(path => `<option value="${e(path)}">${e(path)}</option>`).join('') || `<option value="">${e(t('（没有变量）'))}</option>`}</select>
        <button type="button" class="variable-secondary-button" data-lab-insert="var">${e(t('插入变量'))}</button>
        <button type="button" class="variable-secondary-button" data-lab-insert="if">${e(t('插入条件'))}</button>
        <button type="button" class="variable-secondary-button" data-lab-insert="macro">${e(t('插入宏'))}</button>
        <button type="button" class="variable-secondary-button" data-lab-insert="random">${e(t('插入随机'))}</button>
      </div>
      <textarea class="var-lab-source" data-lab-source spellcheck="false" placeholder="${e(t('在这里写或贴上模板，例如：好感度是 <%= getvar(\'好感度\') %>'))}" data-i18n-skip>${e(labSource)}</textarea>
      <label class="var-lab-toggle"><input type="checkbox" data-lab-hypo ${labUseHypothetical ? 'checked' : ''}> ${e(t('用注入总览里填的假设值（{count} 项）', { count: overrides.size }))}</label>
      <div class="var-lab-heading">${e(t('渲染结果'))}</div>
      <pre class="var-inj-preview var-lab-output" data-lab-output data-i18n-skip></pre>
      <div class="var-inj-note is-warning" data-lab-error hidden data-i18n-skip></div>
      <div class="var-inj-note">${e(t('只读渲染：模板里的 setvar 不会写进真实变量。写好后复制到世界书或预设。'))}</div>
    </div>`;
    runLab();
  };

  const onLabInput = (event) => {
    if (event.target.matches?.('[data-lab-source]')) {
      labSource = event.target.value;
      clearTimeout(labTimer);
      labTimer = setTimeout(runLab, 350);
    }
  };

  const onLabChange = (event) => {
    if (event.target.matches?.('[data-lab-hypo]')) {
      labUseHypothetical = event.target.checked;
      runLab();
    }
  };

  const onLabClick = (event) => {
    const kind = event.target.closest?.('[data-lab-insert]')?.dataset.labInsert;
    if (!kind || !labHost) return;
    const path = labHost.querySelector('[data-lab-path]')?.value || '';
    if (kind !== 'random' && !path) return;
    const area = labHost.querySelector('[data-lab-source]');
    const snippet = SNIPPETS[kind](path);
    area.focus();
    area.setRangeText(snippet, area.selectionStart, area.selectionEnd, 'end');
    labSource = area.value;
    runLab();
  };

  return {
    renderOverview,
    renderTemplateLab,
    bindOverview: (host) => { host.addEventListener('input', onOverviewInput); host.addEventListener('click', onOverviewClick); },
    bindTemplateLab: (host) => { host.addEventListener('input', onLabInput); host.addEventListener('change', onLabChange); host.addEventListener('click', onLabClick); },
    getOverrides: () => new Map(overrides),
  };
};
