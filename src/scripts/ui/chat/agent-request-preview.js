import { renderRequestParamReport } from '../request-param-report-view.js';
import { t } from '../../i18n/index.js';
import { createLatestPreviewBuildQueue } from '../preset-preview-utils.js';
import { getAgentPromptFields, getRequestPromptFieldIds, writeAgentPromptField } from './agent-prompt-fields.js';
import { installAgentRequestPreviewStyle } from './agent-request-preview-style.js';
import { buildAgentPromptNavigation, renderAgentPromptAnchors } from './agent-prompt-navigation-model.js';
import { mountAgentPromptNavigation } from './agent-prompt-navigation.js';
import { mountAgentPromptEditing } from './agent-prompt-editing.js';
import { mountAgentPromptSelection } from './agent-prompt-selection.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
const icons = { refresh: icon('M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1'), close: icon('m6 6 12 12M18 6 6 18') };
const button = (action, label, glyph, className = '') => `<button type="button" class="hop-request-button ${className}" data-request-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${glyph}</button>`;

export const renderAgentRequestPreview = (request, { fields = [], navigation = buildAgentPromptNavigation(request,fields), renderTarget = null } = {}) => {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  if (!messages.length) return `<p class="hop-request-empty">${escapeHtml(t(request?.previewNote || '暂无可预览的 Prompt'))}</p>`;
  const items = messages.map((message, index) => {
    const section = request.sections?.[index];
    const editable = getRequestPromptFieldIds(section, fields);
    const links = editable.map(id => `<button type="button" class="hop-request-field-link" data-request-field="${escapeHtml(id)}">${escapeHtml(t('编辑'))} · ${escapeHtml(fields.find(field => field.id === id).label)}</button>`).join('');
    return `<article class="hop-request-message" data-request-message="${escapeHtml(navigation.messages[index].key)}"><header><span>${escapeHtml(t(section?.source || message.role || 'message'))}</span><small>${String(index + 1).padStart(2, '0')} · ${escapeHtml(message.role || '')}</small>${links}</header><pre data-i18n-skip="true">${renderAgentPromptAnchors(navigation.messages[index],escapeHtml,renderTarget)}</pre>${section?.origin ? `<div class="hop-request-boundary">${escapeHtml(t(section.origin))}</div>` : ''}</article>`;
  });
  if (request.responsePrefix) items.push(`<article class="hop-request-message"><header>assistant prefill</header><pre data-i18n-skip="true">${escapeHtml(request.responsePrefix)}</pre></article>`);
  if (request.previewNote) items.unshift(`<p class="hop-request-empty">${escapeHtml(t(request.previewNote))}</p>`);
  const options = request.wireRequest?.body || { ...(request.params || {}), ...(request.options || {}), ...(request.requestOptions || {}) };
  const omitted = new Set(['model', 'messages', 'contents', 'input', 'system', 'systemInstruction',
    'stream', 'signal', 'nativeRequestId', 'requestParamConstraints', 'requestContext']);
  const params = Object.fromEntries(Object.entries(options).filter(([key, value]) => !omitted.has(key)
    && value !== undefined && typeof value !== 'function'));
  if (request.apiFormat === 'responses') params.api_format = 'responses';
  const tools = request.tools || options.tools;
  if (Array.isArray(tools) && tools.length) params.tools = tools;
  if (Object.keys(params).length) items.push(`<details class="hop-request-params"><summary>${escapeHtml(t('请求参数'))}</summary><pre data-i18n-skip="true">${escapeHtml(JSON.stringify(params, null, 2))}</pre></details>`);
  if (request.wireRequest?.body) items.push(`<details class="hop-request-params"><summary>${escapeHtml(t('请求 JSON'))}</summary><pre data-i18n-skip="true">${escapeHtml(JSON.stringify(request.wireRequest.body, null, 2))}</pre></details>`);
  if (request.wireRequest?.parameterReport?.length) items.push(`<details class="hop-request-params"><summary>${escapeHtml(t('参数处理结果'))}</summary>${renderRequestParamReport(request.wireRequest.parameterReport)}</details>`);
  (request.stages || []).forEach((stage,index) => items.push(`<details class="hop-request-params"><summary>${escapeHtml(t(stage.previewLabel || '后续请求'))}</summary>${renderAgentRequestPreview({ ...stage, stages:[] }, { fields, navigation:navigation.stages[index], renderTarget })}</details>`));
  return items.join('');
};

// 与 preset 相同的 closed / split / full 提环语义；草稿 DOM 保持原节点。
export const mountAgentRequestPreview = ({ host, buildRequest, savedState = null, getFields = null, onRequest = null, saveField = null } = {}) => {
  const back = host?.querySelector('.agent-center-floating-face-back');
  if (!back || typeof buildRequest !== 'function') return null;
  const doc = back.ownerDocument;
  installAgentRequestPreviewStyle(doc);
  // Re-attaching a retained editor must not nest a second workspace.
  const previousWorkspace = back.querySelector(':scope > .hop-request-workspace');
  if (previousWorkspace) {
    [...previousWorkspace.querySelector('.hop-request-editor').children].forEach(node => back.append(node));
    previousWorkspace.remove();
  }
  const workspace = doc.createElement('div');
  workspace.className = 'hop-request-workspace';
  const editor = doc.createElement('div'); editor.className = 'hop-request-editor';
  [...back.children].slice(1).forEach(node => editor.append(node));
  editor.querySelector('[data-agent-assembled-context]')?.remove();
  const contextPanel = doc.createElement('section');
  contextPanel.className = 'agent-prompt-context';
  contextPanel.dataset.agentAssembledContext = '';
  const memoryEditor = editor.querySelector('[data-memory-agent-editor]');
  if (memoryEditor) memoryEditor.querySelector('.agent-center-memory-mode-setting')?.after(contextPanel);
  else if (editor.querySelector('.ac-footer')) editor.querySelector('.ac-footer').before(contextPanel);
  else editor.append(contextPanel);
  workspace.append(editor);
  workspace.insertAdjacentHTML('beforeend', `<aside class="hop-request-pane" aria-label="${escapeHtml(t('请求预览'))}">
    <header class="hop-request-head"><div><strong class="has-help" tabindex="0" data-help="${escapeHtml(t('按当前会话与此页草稿组装。这里只能修改本 Agent 的提示词；其他来源需回到对应设置。'))}">${escapeHtml(t('请求预览'))}</strong><small class="hop-request-meta" data-i18n-skip="true"></small></div><div>${button('refresh', t('重新构建'), icons.refresh)}${button('close', t('关闭预览'), icons.close)}</div></header>
    <button type="button" class="hop-request-current" data-request-action="locate" hidden aria-label="${escapeHtml(t('定位当前区块'))}"></button>
    <div class="hop-request-scroll" tabindex="0"><div class="hop-request-sources" hidden>
      <div class="hop-request-source-head"><span>${escapeHtml(t('本 Agent 的提示词'))}</span><small>${escapeHtml(t('两侧同步 · 保存后生效'))}</small></div>
      <p class="hop-request-boundary">${escapeHtml(t('绿色为新增，红色为删除；✔ 仅保存该处修改，× 撤回该处草稿。'))}</p>
      <div class="hop-request-source-links"></div>
      <div class="hop-request-field-editor" hidden><label></label><textarea spellcheck="false" data-i18n-skip="true"></textarea><small>${escapeHtml(t('编辑来源模板；下方显示组装后的请求。'))}</small></div>
    </div><div class="hop-request-edit-status" role="status" aria-live="polite"></div><div class="hop-request-status" role="status" aria-live="polite"></div><div class="hop-request-output"></div></div></aside>
    ${button('open', t('展开请求预览'), '', 'hop-request-handle hop-request-open')}
    ${button('expand', t('拉出全屏预览'), '', 'hop-request-handle hop-request-expand')}
    ${button('close', t('收起预览'), '', 'hop-request-handle hop-request-collapse')}
    ${button('return', t('返回编辑'), '', 'hop-request-handle hop-request-return')}`);
  back.classList.add('has-request-preview'); back.append(workspace);
  const pane = workspace.querySelector('.hop-request-pane');
  const scroll = workspace.querySelector('.hop-request-scroll');
  const output = workspace.querySelector('.hop-request-output');
  const status = workspace.querySelector('.hop-request-status');
  const sourceHost = workspace.querySelector('.hop-request-sources');
  const sourceLinks = workspace.querySelector('.hop-request-source-links');
  const sourceEditor = workspace.querySelector('.hop-request-field-editor');
  const sourceArea = sourceEditor.querySelector('textarea');
  const fields = () => (getFields ? getFields(editor) : getAgentPromptFields(editor)) || [];
  let state = savedState?.state || 'closed', request = savedState?.request || null, disposed = false;
  let fieldId = savedState?.fieldId || '', fieldsKey = '', composing = false, timer = null, dirty = false;
  let animations = [];
  let returnFocus = null;
  let navigationModel = null, lastContextHtml = '', contextByKey = new Map();
  let editing = null, selection = null;
  const outputHtml = new WeakMap();
  const phone = () => doc.defaultView?.matchMedia('(max-width: 600px)').matches;
  const syncFields = () => {
    const current = fields(), selected = current.find(field => field.id === fieldId);
    sourceHost.hidden = !current.length;
    const key = JSON.stringify(current.map(field => [field.id, field.label]));
    if (key !== fieldsKey) {
      fieldsKey = key;
      sourceLinks.innerHTML = current.length > 8
        ? `<select class="agent-center-agent-input" data-request-field-select aria-label="${escapeHtml(t('选择提示词区块'))}"><option value="">${escapeHtml(t('选择提示词区块'))}</option>${current.map(field => `<option value="${escapeHtml(field.id)}">${escapeHtml(field.label)}</option>`).join('')}</select>`
        : current.map(field => `<button type="button" class="hop-request-field-link" data-request-field="${escapeHtml(field.id)}">${escapeHtml(field.label)}</button>`).join('');
    }
    const select = sourceLinks.querySelector('select');
    if (select && select.value !== fieldId) select.value = fieldId;
    sourceLinks.querySelectorAll('[data-request-field]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.requestField === fieldId)));
    sourceEditor.hidden = !selected;
    if (selected) {
      sourceEditor.querySelector('label').textContent = selected.label;
      sourceArea.setAttribute('aria-label', selected.label);
      if (!composing && doc.activeElement !== sourceArea && sourceArea.value !== selected.value) sourceArea.value = selected.value;
    }
    editing?.schedule();
  };
  const navigation = mountAgentPromptNavigation({editor,scroll,output,getState:()=>state,isSourceEditing:()=>doc.activeElement===sourceArea,initialActive:savedState?.activePrompt,revealContext:detail=>fillContext({target:detail}),onActive:(key,target,{reason}={}) => {
    workspace.dataset.promptActive = key || '';
    const id = target?.fieldId || (key?.startsWith('field:') ? key.slice(6) : '');
    const current=workspace.querySelector('.hop-request-current');
    const label=target?.label || fields().find(field=>field.id===id)?.label;
    current.hidden=!label;current.disabled=!target;
    current.textContent=label ? `${t(label)}${target?'':` · ${t('当前请求无法定位此区块')}`}` : '';
    current.title=label ? t(label) : '';
    if (reason!=='scroll' && id && id !== fieldId && fields().some(field=>field.id===id) && !composing && doc.activeElement!==sourceArea) {
      fieldId=id;syncFields();
    }
  }});
  const patchOutput = html => {
    const template=doc.createElement('template');template.innerHTML=html;
    const previous=[...output.children], nodes=[...template.content.children];
    nodes.forEach((next,index)=>{
      const old=previous[index], markup=next.outerHTML;
      if (old && editing?.isEditing(old)) return;
      if (old && outputHtml.get(old)===markup) return;
      if (old?.tagName==='DETAILS' && old.open) next.open=true;
      outputHtml.set(next,markup);
      if(old)old.replaceWith(next);else output.append(next);
    });
    previous.slice(nodes.length).forEach(node=>node.remove());
  };
  const render = () => {
    syncFields();
    const top = scroll.scrollTop;
    const currentFields=fields();
    editing?.sync();
    navigationModel=buildAgentPromptNavigation(request,currentFields);
    patchOutput(renderAgentRequestPreview(request, { fields:currentFields,navigation:navigationModel,renderTarget:editing?.renderTarget }));
    scroll.scrollTop = top;
    workspace.querySelector('.hop-request-meta').textContent = [request?.session?.name || request?.session?.id, request?.previewLabel, request?.model, request?.messages?.length ? `${request.messages.length} ${t('消息')}` : ''].filter(Boolean).join(' · ');
    const expanded = new Set([...contextPanel.querySelectorAll('details[open]')].map(detail => detail.dataset.contextKey));
    const memory = request?.agentPromptContext?.memory;
    // Keep the agent's assembled blocks first; external context stays collapsed.
    const contexts = [...navigationModel.contexts,...navigationModel.stages.flatMap(stage=>stage.contexts)].sort((a,b)=>Number(b.key.startsWith('memory:'))-Number(a.key.startsWith('memory:')));
    contextByKey=new Map(contexts.map(item=>[item.key,item]));
    const contextHtml = `<div class="agent-center-agent-section-title">${escapeHtml(t('当前上下文组装'))}</div><p class="hop-request-boundary">${escapeHtml(t('以下为只读组装结果；提示词在对应区块编辑，表格值和聊天内容在聊天室设置修改。'))}</p>`
      + (contexts.filter(item => item.content).map(item => {
        const open=expanded.has(item.key) || (memory && !contextPanel.dataset.loaded && item.key === 'memory:data');
        return `<details data-context-key="${escapeHtml(item.key)}" data-prompt-context-key="${escapeHtml(item.key)}"${open?' open':''}><summary>${escapeHtml(t(item.label))}<span>${escapeHtml(t('只读'))}</span></summary><pre data-i18n-skip="true">${open?escapeHtml(item.content):''}</pre></details>`;
      }).join('') || `<p class="hop-request-empty">${escapeHtml(t(request?.previewNote || (request ? '当前请求没有此类上下文' : '展开右侧预览后，显示当前会话的组装结果。')))}</p>`);
    if(contextHtml!==lastContextHtml){
      const positions=new Map([...contextPanel.querySelectorAll('details')].map(detail=>[detail.dataset.contextKey,detail.querySelector('pre')?.scrollTop || 0]));
      contextPanel.innerHTML=contextHtml;lastContextHtml=contextHtml;
      contextPanel.querySelectorAll('details[open]').forEach(detail=>{detail.querySelector('pre').scrollTop=positions.get(detail.dataset.contextKey) || 0;});
    }
    if (request) contextPanel.dataset.loaded = 'true';
    navigation.update(navigationModel,currentFields);
    selection?.update(navigationModel,currentFields);
  };
  const fillContext = event => {
    const detail=event.target;
    if(detail.tagName!=='DETAILS' || !detail.open)return;
    const pre=detail.querySelector('pre'), content=contextByKey.get(detail.dataset.contextKey)?.content || '';
    if(pre && pre.textContent!==content)pre.textContent=content;
  };
  contextPanel.addEventListener('toggle',fillContext,true);
  const queue = createLatestPreviewBuildQueue({
    build: buildRequest,
    onStart: () => { output.setAttribute('aria-busy', 'true'); status.textContent = t('正在构建预览…'); },
    onResult: value => { if (disposed) return; request = value; dirty = false; status.textContent = ''; output.removeAttribute('aria-busy'); onRequest?.(value); render(); },
    onFailure: error => { if (disposed) return; request = null; output.removeAttribute('aria-busy'); status.textContent = t(error?.message || '构建失败：请确认当前有可用会话。'); render(); },
  });
  const invalidate = () => {
    if (disposed) return;
    dirty = true; queue.invalidate(); clearTimeout(timer); syncFields();
    if (state !== 'closed') {
      status.textContent = t('草稿已变化，正在更新预览…');
      if (!composing) timer = setTimeout(() => { if (!disposed && state !== 'closed') void queue.request(); }, 400);
    }
  };
  const applyState = next => {
    const previous = state;
    state = phone() && next === 'split' ? 'full' : next;
    if(state==='closed')selection?.clear();
    animations.forEach(animation => animation.cancel()); animations = [];
    workspace.dataset.preview = state;
    editor.inert = state === 'full';
    pane.inert = state === 'closed'; pane.setAttribute('aria-hidden', String(state === 'closed'));
    host.querySelector('.agent-center-floating-card')?.classList.toggle('has-wide-request-preview', state === 'split');
    workspace.querySelector('[data-request-action="open"]').setAttribute('aria-expanded', String(state !== 'closed'));
    const reduced = doc.body?.dataset.reducedMotion === 'on' || doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (previous !== state && !reduced) {
      const surface = state === 'closed' ? editor : pane;
      if (surface.animate) animations.push(surface.animate([
        { opacity: .5, transform: `translateX(${state === 'closed' ? '-12px' : '18px'})` },
        { opacity: 1, transform: 'translateX(0)' },
      ], { duration: 180, easing: 'ease-out' }));
    }
  };
  const open = () => {
    if (state === 'closed') { returnFocus = doc.activeElement;navigation.captureOpen(fields()); }
    applyState('split');
    pane.querySelector('button')?.focus({ preventScroll: true });
    navigation.opened();
    if (!request || dirty) void queue.request();
  };
  const close = () => {
    if (state === 'closed') return false;
    dirty = true;
    clearTimeout(timer); queue.invalidate(); output.removeAttribute('aria-busy'); applyState('closed');navigation.closed();
    if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
    else workspace.querySelector('[data-request-action="open"]')?.focus({ preventScroll: true });
    return true;
  };
  const act = action => {
    const realign = () => {const active=navigation.getActive();if(active && doc.activeElement!==sourceArea)navigation.select(active.key,{...active,side:'left'});};
    if (action === 'open') open();
    else if (action === 'expand') { applyState('full'); pane.querySelector('button')?.focus({ preventScroll: true });realign(); }
    else if (action === 'return') { if (phone()) close(); else {applyState('split');realign();} }
    else if (action === 'close') close();
    else if (action === 'refresh') { clearTimeout(timer); void queue.request(); }
    else if (action === 'locate') { const active=navigation.getActive();if(active)navigation.select(active.key,{side:'left',reason:'locate'}); }
  };
  const selectField = id => {
    const field = fields().find(item => item.id === id); if (!field) return;
    fieldId = id; sourceArea.value = field.value; syncFields();
    sourceEditor.scrollIntoView({ block: 'nearest' }); sourceArea.focus({ preventScroll: true });
    for (let parent = field.element?.parentElement; parent && parent !== editor; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
    editor.querySelector('[data-preview-active]')?.removeAttribute('data-preview-active');
    field.element?.setAttribute('data-preview-active', 'true');
    if (state !== 'full') field.element?.scrollIntoView({ block: 'nearest' });
    navigation.select(`field:${id}`,{side:'right',alignOther:false});
  };
  workspace.addEventListener('click', event => {
    const control = event.target.closest('[data-request-field]');
    if (control) selectField(control.dataset.requestField);
  });
  sourceLinks.addEventListener('change', event => { if (event.target.matches('[data-request-field-select]')) selectField(event.target.value); });
  sourceArea.addEventListener('input', () => {
    if (!composing) writeAgentPromptField(fields(), fieldId, sourceArea.value);
  });
  sourceArea.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
  sourceArea.addEventListener('compositionend', () => { composing = false; writeAgentPromptField(fields(), fieldId, sourceArea.value); invalidate(); });
  sourceArea.addEventListener('blur', syncFields);
  const onInput = () => {workspace.querySelector('.hop-request-edit-status').textContent='';invalidate();};
  const onCompositionStart = () => { composing = true; clearTimeout(timer); };
  const onCompositionEnd = () => { composing = false; invalidate(); };
  editor.addEventListener('input', onInput); editor.addEventListener('change', onInput);
  editor.addEventListener('agent-prompt-draft-changed', onInput);
  editor.addEventListener('compositionstart', onCompositionStart); editor.addEventListener('compositionend', onCompositionEnd);
  output.addEventListener('compositionstart', onCompositionStart); output.addEventListener('compositionend', onCompositionEnd);
  workspace.querySelectorAll('[data-request-action]').forEach(control => {
    let start = null, suppressClick = false;
    control.addEventListener('click', () => { if (suppressClick) { suppressClick = false; return; } act(control.dataset.requestAction); });
    if (!control.classList.contains('hop-request-handle')) return;
    control.addEventListener('pointerdown', event => { if (event.button !== 0) return; suppressClick = false; start = {x:event.clientX,y:event.clientY}; control.setPointerCapture?.(event.pointerId); });
    control.addEventListener('pointerup', event => {
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y; start = null;
      if (Math.abs(dx) < 22 || Math.abs(dx) <= Math.abs(dy)) return;
      suppressClick = true;
      if (dx < 0) act(state === 'closed' ? 'open' : 'expand');
      else act(state === 'full' ? 'return' : 'close');
    });
    control.addEventListener('pointercancel', () => { start = null; suppressClick = false; });
  });
  const onResize = () => {
    if (phone() && state === 'split') applyState('full');
    const active=navigation.getActive();
    if(state!=='closed' && active && !composing && doc.activeElement!==sourceArea)navigation.select(active.key,{...active,side:'left'});
  };
  doc.defaultView?.addEventListener('resize', onResize);
  const contextEvents = ['session-changed', 'config-profile-changed', 'memory-templates-updated', 'memory-storage-mode-changed', 'chatapp-summaries-updated', 'variables-changed'];
  for (const name of contextEvents) doc.defaultView?.addEventListener(name, invalidate);
  editing = mountAgentPromptEditing({workspace,editor,output,sourceArea,getFields:fields,getSourceId:()=>fieldId,saveField,
    onChange:invalidate,onRender:changedNode=>{if(changedNode)outputHtml.delete(changedNode.closest('.hop-request-message'));render();},onStatus:message=>{workspace.querySelector('.hop-request-edit-status').textContent=message;}});
  selection = mountAgentPromptSelection({workspace,editor,output,sourceArea,getSourceId:()=>fieldId,getState:()=>state,onReveal:navigation.revealSelection});
  render(); applyState(state);
  if (state !== 'closed' && !request) void queue.request();
  if (savedState?.scrollTop) scroll.scrollTop = savedState.scrollTop;
  if (savedState?.editorScrollTop) editor.scrollTop = savedState.editorScrollTop;
  return {
    open, close, invalidate,
    snapshot: () => ({ state, request: dirty ? null : request, fieldId, activePrompt:navigation.getActive(), scrollTop: scroll.scrollTop, editorScrollTop: editor.scrollTop }),
    dispose: () => {
      disposed = true; clearTimeout(timer); queue.invalidate(); navigation.dispose();animations.forEach(animation => animation.cancel());
      editing.dispose();
      selection.dispose();
      contextPanel.removeEventListener('toggle',fillContext,true);
      editor.removeEventListener('input', onInput); editor.removeEventListener('change', onInput); editor.removeEventListener('agent-prompt-draft-changed', onInput);
      editor.removeEventListener('compositionstart', onCompositionStart); editor.removeEventListener('compositionend', onCompositionEnd);
      output.removeEventListener('compositionstart', onCompositionStart); output.removeEventListener('compositionend', onCompositionEnd);
      doc.defaultView?.removeEventListener('resize', onResize);
      for (const name of contextEvents) doc.defaultView?.removeEventListener(name, invalidate);
    },
  };
};
