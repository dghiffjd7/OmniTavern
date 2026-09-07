import { t } from '../../i18n/index.js';
import { buildFullPromptDocument } from './prompt-preview-view-utils.js';
import { createLatestPreviewBuildQueue } from '../preset-preview-utils.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = path => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
const icons = { refresh: icon('M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1'), close: icon('m6 6 12 12M18 6 6 18') };
const button = (action, label, glyph, className = '') => `<button type="button" class="hop-request-button ${className}" data-request-action="${action}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${glyph}</button>`;

export const renderAgentRequestPreview = request => {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  if (!messages.length) return `<p class="hop-request-empty">${escapeHtml(t('暂无可预览的 Prompt'))}</p>`;
  const items = messages.map((message, index) => {
    const plain = buildFullPromptDocument({ messages: [message] }).plain;
    return `<article class="hop-request-message"><header><span>${escapeHtml(message.role || 'message')}</span><small>${String(index + 1).padStart(2, '0')}</small></header><pre data-i18n-skip="true">${escapeHtml(plain.slice(plain.indexOf('\n') + 1))}</pre></article>`;
  });
  if (request.responsePrefix) items.push(`<article class="hop-request-message"><header>assistant prefill</header><pre data-i18n-skip="true">${escapeHtml(request.responsePrefix)}</pre></article>`);
  const options = { ...(request.options || {}), ...(request.requestOptions || {}) };
  const params = Object.fromEntries(['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'reasoning', 'reasoning_effort', 'response_format', 'tool_choice', 'parallel_tool_calls'].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
  const tools = request.tools || options.tools;
  if (Array.isArray(tools) && tools.length) params.tools = tools;
  if (Object.keys(params).length) items.push(`<details class="hop-request-params"><summary>${escapeHtml(t('请求参数'))}</summary><pre data-i18n-skip="true">${escapeHtml(JSON.stringify(params, null, 2))}</pre></details>`);
  return items.join('');
};

// 与 preset 相同的 closed / split / full 提环语义；草稿 DOM 保持原节点。
export const mountAgentRequestPreview = ({ host, buildRequest, savedState = null } = {}) => {
  const back = host?.querySelector('.agent-center-floating-face-back');
  if (!back || typeof buildRequest !== 'function') return null;
  const doc = back.ownerDocument;
  const workspace = doc.createElement('div');
  workspace.className = 'hop-request-workspace';
  const editor = doc.createElement('div'); editor.className = 'hop-request-editor';
  [...back.children].slice(1).forEach(node => editor.append(node));
  workspace.append(editor);
  workspace.insertAdjacentHTML('beforeend', `<aside class="hop-request-pane" aria-label="${escapeHtml(t('请求预览'))}">
    <header class="hop-request-head"><div><strong class="has-help" data-help="${escapeHtml(t('按当前会话、输入草稿与已保存设置组装；发送脚本和前置 Agent 的新产物在执行时加入。'))}">${escapeHtml(t('请求预览'))}</strong><small class="hop-request-meta" data-i18n-skip="true"></small></div><div>${button('refresh', t('重新构建'), icons.refresh)}${button('close', t('关闭预览'), icons.close)}</div></header>
    <div class="hop-request-scroll" tabindex="0"></div></aside>
    ${button('open', t('展开请求预览'), '', 'hop-request-handle hop-request-open')}
    ${button('expand', t('拉出全屏预览'), '', 'hop-request-handle hop-request-expand')}
    ${button('close', t('收起预览'), '', 'hop-request-handle hop-request-collapse')}
    ${button('return', t('返回编辑'), '', 'hop-request-handle hop-request-return')}`);
  back.classList.add('has-request-preview'); back.append(workspace);
  const pane = workspace.querySelector('.hop-request-pane');
  const output = workspace.querySelector('.hop-request-scroll');
  let state = savedState?.state || 'closed', request = savedState?.request || null, disposed = false;
  let returnFocus = null;
  const phone = () => doc.defaultView?.matchMedia('(max-width: 600px)').matches;
  const render = () => {
    output.innerHTML = renderAgentRequestPreview(request);
    workspace.querySelector('.hop-request-meta').textContent = [request?.model, request?.messages?.length ? `${request.messages.length} ${t('消息')}` : ''].filter(Boolean).join(' · ');
  };
  const queue = createLatestPreviewBuildQueue({
    build: buildRequest,
    onStart: () => { output.setAttribute('aria-busy', 'true'); output.innerHTML = `<p class="hop-request-empty" role="status">${escapeHtml(t('正在构建预览…'))}</p>`; },
    onResult: value => { if (disposed) return; request = value; output.removeAttribute('aria-busy'); render(); },
    onFailure: () => { if (disposed) return; request = null; output.removeAttribute('aria-busy'); output.innerHTML = `<p class="hop-request-empty" role="alert">${escapeHtml(t('构建失败：请确认当前有可用会话。'))}</p>`; },
  });
  const applyState = next => {
    state = phone() && next === 'split' ? 'full' : next;
    workspace.dataset.preview = state;
    editor.inert = state === 'full';
    pane.inert = state === 'closed'; pane.setAttribute('aria-hidden', String(state === 'closed'));
    host.querySelector('.agent-center-floating-card')?.classList.toggle('has-wide-request-preview', state === 'split');
    workspace.querySelector('[data-request-action="open"]').setAttribute('aria-expanded', String(state !== 'closed'));
  };
  const open = () => {
    if (state === 'closed') returnFocus = doc.activeElement;
    applyState('split');
    pane.querySelector('button')?.focus({ preventScroll: true });
    if (request) render();
    else void queue.request();
  };
  const close = () => {
    if (state === 'closed') return false;
    queue.invalidate(); output.removeAttribute('aria-busy'); applyState('closed');
    if (returnFocus?.isConnected && !returnFocus.closest('[inert]')) returnFocus.focus({ preventScroll: true });
    else workspace.querySelector('[data-request-action="open"]')?.focus({ preventScroll: true });
    return true;
  };
  const act = action => {
    if (action === 'open') open();
    else if (action === 'expand') { applyState('full'); pane.querySelector('button')?.focus({ preventScroll: true }); }
    else if (action === 'return') { if (phone()) close(); else applyState('split'); }
    else if (action === 'close') close();
    else if (action === 'refresh') void queue.request();
  };
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
  const onResize = () => { if (phone() && state === 'split') applyState('full'); };
  doc.defaultView?.addEventListener('resize', onResize);
  render(); applyState(state);
  if (state !== 'closed' && !request) void queue.request();
  if (savedState?.scrollTop) output.scrollTop = savedState.scrollTop;
  if (savedState?.editorScrollTop) editor.scrollTop = savedState.editorScrollTop;
  return {
    open, close,
    snapshot: () => ({ state, request, scrollTop: output.scrollTop, editorScrollTop: editor.scrollTop }),
    dispose: () => { disposed = true; queue.invalidate(); doc.defaultView?.removeEventListener('resize', onResize); },
  };
};
