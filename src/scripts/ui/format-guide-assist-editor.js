// AC 格式修复「辅助填写」面板：挂在「格式要求」下面。
// 自己保留根节点，编辑器整块重绘时重新挂上，进行中的整理不会被打断。
// 输入框不带 name，避免被编辑器按字段名写进配置。

import { t } from '../i18n/index.js';
import {
  FORMAT_GUIDE_EXAMPLE_LIMIT,
  FORMAT_GUIDE_SECTIONS,
  removeFormatGuideItem,
  renderFormatGuideDraft,
  resolvePendingFormatGuideItem,
} from '../agent/format-guide-assist.js';

const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const SECTION_LABELS = Object.freeze({ required: '必须有', conditional: '按条件出现', order: '顺序与闭合', pending: '待确认' });

const installStyle = (doc) => {
  if (doc.getElementById('format-guide-assist-style')) return;
  const style = doc.createElement('style'); style.id = 'format-guide-assist-style';
  style.textContent = `
  .agent-config-editor .ac-fga{display:grid;gap:10px}.agent-config-editor .ac-fga:empty{display:none}
  .agent-config-editor .ac-fga-entry{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agent-config-editor .ac-fga-entry>.ac-source{flex-basis:100%}
  .agent-config-editor .ac-fga-panel{display:grid;gap:10px;padding:12px;border:1px solid var(--app-border-default);border-radius:14px;background:var(--app-surface-subtle)}
  .agent-config-editor .ac-fga-title{font-size:13px;font-weight:600}.agent-config-editor .ac-fga-note{font-size:12px;color:var(--app-text-secondary);line-height:1.6}
  .agent-config-editor .ac-fga-stale{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--app-text-secondary);line-height:1.6}
  .agent-config-editor .ac-fga-sources{display:grid;gap:4px}.agent-config-editor .ac-fga-sources details{border-top:0;padding-top:0}.agent-config-editor .ac-fga-sources summary{min-height:36px;padding:8px 0;font-size:12px;font-weight:500}
  .agent-config-editor .ac-fga-sources pre,.agent-config-editor .ac-fga-item pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 var(--app-font-family,inherit);max-height:200px;overflow:auto;padding:10px;border-radius:10px;background:var(--app-surface-card)}
  .agent-config-editor .ac-fga-section{display:grid;gap:6px}.agent-config-editor .ac-fga-section>strong{font-size:12px;color:var(--app-text-secondary)}
  .agent-config-editor .ac-fga-item{display:grid;gap:6px;padding:10px;border-radius:12px;background:var(--app-surface-card);border:1px solid var(--app-border-default)}
  .agent-config-editor .ac-fga-item.is-pending{border-style:dashed}.agent-config-editor .ac-fga-rule{font-size:13px;line-height:1.6;overflow-wrap:anywhere}
  .agent-config-editor .ac-fga-detail{font-size:12px;color:var(--app-text-secondary);line-height:1.6;overflow-wrap:anywhere}
  .agent-config-editor .ac-fga-item details{border-top:0;padding-top:0}.agent-config-editor .ac-fga-item summary{min-height:32px;padding:6px 0;font-size:11px;font-weight:500;color:var(--app-text-secondary)}
  .agent-config-editor .ac-fga textarea{min-height:140px}.agent-config-editor .ac-fga input{min-height:44px}
  `;
  doc.head.append(style);
};

// actions：collectAgentFormatGuideSources / draftAgentFormatGuide；getConfig 返回编辑器当前（含未保存）的配置；
// onApply(text, source) 把草稿写进格式要求并记下来源。
export const createFormatGuideAssistEditor = ({ actions = {}, getConfig, getSessionId, onApply, documentRef = document }) => {
  installStyle(documentRef);
  const root = documentRef.createElement('div');
  root.className = 'ac-fga';
  let view = 'idle';
  let busy = false;
  let message = '';
  let sources = null;
  let example = '';
  let note = '';
  let result = null;
  let stale = false;
  let controller = null;
  let alive = true;
  let staleRequest = 0;

  const button = (action, label, attrs = '') => `<button type="button" class="agent-center-card-action" data-fga="${action}" ${busy ? 'disabled' : ''} ${attrs}>${e(t(label))}</button>`;
  const labelOf = id => result?.mode === 'example' ? t('正常回复示例') : (result?.sources || []).find(item => item.id === id)?.label || id;
  const textOf = id => (result?.sources || []).find(item => item.id === id)?.text || '';
  const hasGuide = () => Boolean(String(getConfig()?.formatGuide || '').trim());

  const renderEntry = () => {
    const entryButtons = `${button('from-sources', '从当前配置整理')}${button('from-example', '用正常回复示例整理')}`;
    const staleLine = stale
      ? `<div class="ac-fga-stale"><span>${e(t('格式要求是根据当前配置整理的，来源已经变了，建议重新整理。'))}</span>${button('from-sources', '重新整理')}</div>`
      : '';
    if (!hasGuide()) {
      return `${staleLine}<div class="ac-fga-entry"><span class="ac-source">${e(t('不知道怎么写？可以让检查模型帮你整理一份草稿。'))}</span>${entryButtons}</div>`;
    }
    return `${staleLine}<details class="ac-fga-more" data-ac-section="format-assist"><summary>${e(t('辅助填写'))}</summary><div class="ac-actions">${entryButtons}</div></details>`;
  };

  const renderSources = () => {
    if (!sources) return `<div class="ac-fga-panel"><div class="ac-fga-note">${e(t(message || '正在读取当前配置…'))}</div>${button('cancel', '取消')}</div>`;
    const items = sources.items || [];
    const notes = [
      sources.regexSkippedCount ? t('另有 {count} 条正则只用于清理或显示，不当作格式要求。', { count: sources.regexSkippedCount }) : '',
      sources.omittedCount ? t('内容较多，另有 {count} 处没有带上。', { count: sources.omittedCount }) : '',
    ].filter(Boolean);
    const list = items.length
      ? `<div class="ac-fga-sources">${items.map(item => `<details><summary data-i18n-skip>${e(item.label)}</summary><pre data-i18n-skip>${e(item.text)}</pre></details>`).join('')}</div>`
      : `<div class="ac-fga-note">${e(t('没有找到与格式有关的内容，可以改用正常回复示例整理。'))}</div>`;
    return `<div class="ac-fga-panel"><div class="ac-fga-title">${e(t('从当前配置整理'))}</div>
      ${items.length ? `<div class="ac-fga-note">${e(t('找到 {count} 处与格式有关的内容（预设、角色卡、世界书与正则结构）：', { count: items.length }))}</div>` : ''}${list}
      ${notes.map(text => `<div class="ac-fga-note">${e(text)}</div>`).join('')}
      ${items.length ? `<div class="ac-fga-note">${e(t('整理会把以上内容发给这个 Agent 选择的连线配置。'))}</div>` : ''}
      ${message ? `<div class="ac-fga-note" role="status">${e(t(message))}</div>` : ''}
      <div class="ac-actions">${items.length ? button('draft', busy ? '整理中…' : '整理') : button('from-example', '用正常回复示例整理')}${busy ? button('stop', '停止', 'data-fga-live') : button('cancel', '取消')}</div></div>`;
  };

  const renderExample = () => `<div class="ac-fga-panel"><div class="ac-fga-title">${e(t('用正常回复示例整理'))}</div>
    <div class="ac-fga-note">${e(t('贴一段格式正确的回复。固定的标签和字段会整理成要求，台词、名字、数值这些只当示例。'))}</div>
    <textarea data-fga-field="example" aria-label="${e(t('正常回复示例'))}" placeholder="${e(t('贴一段结构正确的回复'))}" maxlength="${FORMAT_GUIDE_EXAMPLE_LIMIT}" data-i18n-skip="true">${e(example)}</textarea>
    <input data-fga-field="note" aria-label="${e(t('要维持的部分'))}" placeholder="${e(t('一句话说明要维持的部分（可选）'))}" value="${e(note)}" data-i18n-skip="true">
    ${message ? `<div class="ac-fga-note" role="status">${e(t(message))}</div>` : ''}
    <div class="ac-actions">${button('draft', busy ? '整理中…' : '整理')}${busy ? button('stop', '停止', 'data-fga-live') : button('cancel', '取消')}</div></div>`;

  const renderItem = (section, item, index) => {
    const detail = section === 'conditional' ? item.when : section === 'pending' ? item.reason : '';
    const sourceList = (item.sources || []).map(id => (result.mode === 'sources' && textOf(id)
      ? `<details><summary data-i18n-skip>${e(t('来源：{sources}', { sources: labelOf(id) }))}</summary><pre data-i18n-skip>${e(textOf(id))}</pre></details>`
      : `<div class="ac-fga-detail" data-i18n-skip>${e(t('来源：{sources}', { sources: labelOf(id) }))}</div>`)).join('');
    const actionsHtml = section === 'pending'
      ? `${button(`resolve:required:${index}`, '每次都有')}${button(`resolve:conditional:${index}`, '符合条件时出现')}${button(`remove:${section}:${index}`, '删掉')}`
      : button(`remove:${section}:${index}`, '删掉');
    return `<div class="ac-fga-item${section === 'pending' ? ' is-pending' : ''}"><div class="ac-fga-rule" data-i18n-skip>${e(item.rule)}</div>
      ${detail ? `<div class="ac-fga-detail" data-i18n-skip>${e(detail)}</div>` : ''}${sourceList}<div class="ac-actions">${actionsHtml}</div></div>`;
  };

  const renderDraft = () => {
    const draft = result.draft;
    const sections = FORMAT_GUIDE_SECTIONS.filter(section => (draft[section] || []).length).map(section => `<div class="ac-fga-section"><strong>${e(t(SECTION_LABELS[section]))}</strong>${draft[section].map((item, index) => renderItem(section, item, index)).join('')}</div>`).join('');
    const empty = !sections;
    return `<div class="ac-fga-panel"><div class="ac-fga-title">${e(t('格式要求草稿'))}</div>
      <div class="ac-fga-note">${e(t(empty ? '没有整理出格式要求。' : '检查每一条；待确认的可以改成「每次都有」或「符合条件时出现」，不改就按待确认写入，检查时不会当作必须。'))}</div>
      ${sections}
      ${message ? `<div class="ac-fga-note" role="status">${e(t(message))}</div>` : ''}
      <div class="ac-actions">${empty ? '' : hasGuide() ? `${button('apply:replace', '替换格式要求')}${button('apply:append', '追加到末尾')}` : button('apply:replace', '填入格式要求')}${button('cancel', '放弃')}</div></div>`;
  };

  const render = () => {
    if (!alive) return;
    root.innerHTML = view === 'sources' ? renderSources() : view === 'example' ? renderExample() : view === 'draft' && result ? renderDraft() : renderEntry();
  };

  const checkStale = async () => {
    const source = getConfig()?.formatGuideSource;
    const request = ++staleRequest;
    if (source?.mode !== 'sources' || !source.fingerprint || typeof actions.collectAgentFormatGuideSources !== 'function') {
      stale = false;
      return;
    }
    try {
      const collected = await actions.collectAgentFormatGuideSources({ sessionId: getSessionId() });
      if (!alive || request !== staleRequest) return;
      stale = Boolean(collected?.fingerprint) && collected.fingerprint !== source.fingerprint;
      if (view === 'idle') render();
    } catch {}
  };

  const openSources = async () => {
    view = 'sources'; sources = null; message = ''; render();
    try {
      sources = await actions.collectAgentFormatGuideSources({ sessionId: getSessionId() });
    } catch (error) {
      sources = { items: [] };
      message = String(error?.message || '读取当前配置失败');
    }
    if (alive && view === 'sources') render();
  };

  const runDraft = async () => {
    if (busy) return;
    if (view === 'example' && !example.trim()) { message = '请先贴上一段正常回复'; render(); return; }
    const mode = view === 'example' ? 'example' : 'sources';
    busy = true; message = ''; controller = new AbortController(); render();
    try {
      const next = await actions.draftAgentFormatGuide({ sessionId: getSessionId(), mode, config: getConfig(), example, note, signal: controller.signal });
      if (!alive) return;
      result = next; view = 'draft';
    } catch (error) {
      if (!alive) return;
      message = controller?.signal.aborted ? '已停止' : String(error?.message || '整理失败');
    } finally {
      busy = false; controller = null;
      render();
    }
  };

  const apply = (how) => {
    const text = renderFormatGuideDraft(result.draft, { labelOf });
    const current = String(getConfig()?.formatGuide || '');
    const next = how === 'append' && current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text;
    onApply(next, { mode: result.mode, fingerprint: result.fingerprint || '', at: Date.now() });
    stale = false; view = 'idle'; result = null; message = '';
    render();
  };

  root.addEventListener('input', (event) => {
    const field = event.target?.dataset?.fgaField;
    if (field === 'example') example = event.target.value;
    else if (field === 'note') note = event.target.value;
  });
  root.addEventListener('click', (event) => {
    const action = event.target.closest?.('[data-fga]')?.dataset.fga;
    if (!action) return;
    if (action === 'stop') { controller?.abort(); return; }
    if (busy) return;
    if (action === 'from-sources') openSources();
    else if (action === 'from-example') { view = 'example'; message = ''; render(); }
    else if (action === 'draft') runDraft();
    else if (action === 'cancel') { view = 'idle'; result = null; sources = null; message = ''; render(); }
    else if (action.startsWith('apply:')) apply(action.slice(6));
    else if (action.startsWith('resolve:')) {
      const [, target, index] = action.split(':');
      result = { ...result, draft: resolvePendingFormatGuideItem(result.draft, Number(index), target) }; render();
    } else if (action.startsWith('remove:')) {
      const [, section, index] = action.split(':');
      result = { ...result, draft: removeFormatGuideItem(result.draft, section, Number(index)) }; render();
    }
  });

  checkStale();
  return {
    // 编辑器重绘后调用：把根节点挂到新的占位上，并按当前配置刷新入口（有没有格式要求）
    mount: (host) => {
      if (!host) return;
      host.replaceWith(root);
      render();
    },
    refreshStale: checkStale,
    dispose: () => { alive = false; controller?.abort(); root.remove(); },
  };
};
