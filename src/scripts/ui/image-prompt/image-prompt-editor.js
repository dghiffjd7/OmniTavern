import { translateUiText as tr } from '../../i18n/index.js';
import { appConfirm } from '../app-confirm.js';
import { compileImagePrompt, createImagePromptBlock, createImagePromptId, normalizeImagePromptDocument } from './image-prompt-utils.js';
import { resolveImagePromptForm, updateImagePromptFormText } from './image-prompt-form-utils.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>', chevron: '<path d="m9 5 7 7-7 7"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  grip: '<path d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01" stroke-width="3"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="3"/><path d="M15 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  trash: '<path d="M3 6h18M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M5 6l1 13a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-13M10 10v7M14 10v7"/>',
};
const imagePromptIcon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || ''}</svg>`;
const labelOf = block => block.name || tr({ scene: '正向提示词', character: '角色', style: '固定正向', negative: '负向提示词' }[block.kind]);
const btn = (action, title, icon = '', extra = '') => `<button type="button" class="ip-button ${icon ? 'ip-icon-button' : ''}" data-action="${action}" title="${escape(tr(title))}" aria-label="${escape(tr(title))}" ${extra}>${icon ? imagePromptIcon(icon) : escape(tr(title))}</button>`;
const help = (label, value) => `<span class="has-help" data-help="${escape(tr(value))}" data-help-mode="tap">${escape(tr(label))}</span>`;

export class ImagePromptEditor {
  constructor({ container, document: draft = {}, config = {}, options = {}, onChange = () => {} } = {}) {
    this.container = container; this.document = normalizeImagePromptDocument(draft); this.config = config; this.options = options;
    this.onChange = onChange;
    this.openBlocks = new Set(); this.openExtras = new Set(); this.previewState = 'closed'; this.disposed = false;
    this.root = document.createElement('section'); this.root.className = 'ip-editor'; this.root.dataset.preview = 'closed';
    container.replaceChildren(this.root);
    this.root.innerHTML = `      <div class="ip-model" data-i18n-skip></div>
      <div class="ip-workspace"><div class="ip-blocks"></div><aside class="ip-preview" aria-label="${tr('发送预览')}" hidden></aside>
        <button type="button" class="ip-pull ip-pull-open" data-pull="open" aria-label="${tr('拉出发送预览')}" title="${tr('拉出发送预览')}" aria-expanded="false"></button>
        <button type="button" class="ip-pull ip-pull-expand" data-pull="expand" aria-label="${tr('展开完整预览')}" title="${tr('展开完整预览')}" hidden></button>
        <button type="button" class="ip-pull ip-pull-back" data-pull="back" aria-label="${tr('返回编辑')}" title="${tr('返回编辑')}" hidden></button>
      </div><div class="ip-status" role="status" hidden></div>`;
    this.blocksEl = this.root.querySelector('.ip-blocks'); this.previewEl = this.root.querySelector('.ip-preview');
    this.root.addEventListener('click', e => this.handleClick(e));
    this.root.addEventListener('input', e => this.handleInput(e));
    this.root.addEventListener('change', e => this.handleChange(e));
    this.root.addEventListener('keydown', e => this.handleKey(e));
    this.root.addEventListener('pointerdown', e => this.pointerDown(e));
    this.root.addEventListener('pointermove', e => this.pointerMove(e));
    this.root.addEventListener('pointerup', e => this.pointerEnd(e));
    this.root.addEventListener('pointercancel', () => this.cancelPointer());
    this.root.addEventListener('lostpointercapture', event => { if (event.target === this.root && event.pointerId === this.pointer?.pointerId) this.cancelPointer(); });
    this.root.addEventListener('toggle', e => {
      const id = e.target?.dataset?.blockId;
      if (id) e.target.open ? this.openBlocks.add(id) : this.openBlocks.delete(id);
      if (e.target.classList?.contains('ip-character-extra')) { const parentId = e.target.closest('[data-block-id]')?.dataset.blockId; if (parentId) e.target.open ? this.openExtras.add(parentId) : this.openExtras.delete(parentId); }
    }, true);
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.disposed) return;
        this.resizeFixedInputs();
        if (!this.disposed && this.previewState === 'split' && this.root.getBoundingClientRect().width < 720) this.setPreview('expand');
      });
      this.resizeObserver.observe(this.root);
    }
    this.render();
    this.ready = Promise.resolve();
  }
  getDocument() { return normalizeImagePromptDocument(this.document); }
  setDocument(value) { this.document = normalizeImagePromptDocument(value); this.render(); }
  setConfig(config, options = {}) { this.config = config || {}; this.options = options || {}; this.render(); }
  compile() { return compileImagePrompt(this.document, this.config, this.options); }
  status(message = '', error = false) { if (this.disposed) return; const el = this.root.querySelector('.ip-status'); el.textContent = tr(message); el.hidden = !message; el.classList.toggle('is-error', error); }
  changed() { this.onChange(this.getDocument()); this.refreshPreview(); }
  field(block, key, placeholder = '') {
    return `<textarea data-field="${key}" class="ip-text" data-i18n-skip aria-label="${escape(labelOf(block))}" placeholder="${escape(tr(placeholder))}">${escape(block[key] || '')}</textarea>`;
  }
  promptMarkup(fields, negative = false) {
    const unused = negative && !this.compile().capability.negative;
    return `<section class="ip-prompt" data-kind="${negative ? 'negative' : 'scene'}">
      <div class="ip-prompt-heading">${help(negative ? '负向提示词' : '正向提示词', negative ? (unused ? this.compile().capability.negativeReason : '选填需要排除的内容；固定内容可在分隔区修改，作为本次覆盖') : '可直接粘贴完整提示词；固定内容可在分隔区修改，作为本次覆盖')}${negative ? `<span class="ip-badge">${tr(unused ? '当前模型未使用' : '选填')}</span>` : ''}</div>
      <div class="ip-prompt-surface ${unused ? 'is-unused' : ''}">${fields.map(field => {
        const fixed = !field.role.endsWith('-main');
        const label = { 'positive-prefix': '固定正向', 'positive-suffix': '固定后缀', 'negative-fixed': '固定负向', 'positive-main': '正向提示词', 'negative-main': '负向提示词' }[field.role];
        return `<div class="ip-prompt-part ${fixed ? 'is-fixed' : ''}">
          ${fixed ? `<div class="ip-fixed-label">${help(label, '来自生成参数或图片记录；此处修改随本次图片保存')}</div>` : ''}
          <textarea class="ip-text ${fixed ? 'ip-fixed-text' : ''}" data-text-part="${escape(field.key)}" data-text-role="${field.role}" data-i18n-skip aria-label="${escape(tr(label))}" rows="${fixed ? 2 : negative ? 3 : 6}" placeholder="${escape(tr(fixed ? '本次留空' : negative ? '选填需要排除的内容' : '粘贴完整提示词，或描述想生成的图片'))}">${escape(field.text)}</textarea>
        </div>`;
      }).join('')}</div></section>`;
  }
  resizeFixedInputs() { this.blocksEl.querySelectorAll('.ip-fixed-text').forEach(el => { el.style.height = 'auto'; el.style.height = `${Math.min(180, Math.max(44, el.scrollHeight))}px`; }); }
  blockMarkup(block) {
    const c = this.compile().capability;
    const activeProvider = !block.provider || block.provider === c.provider;
    const unused = !activeProvider;
    const open = this.openBlocks.has(block.id);
    return `<details class="ip-block ip-character ${!block.enabled ? 'is-disabled' : ''} ${unused ? 'is-unused' : ''}" data-block-id="${escape(block.id)}" data-kind="character" ${open ? 'open' : ''}>
      <summary>
        <span class="ip-block-heading"><strong data-i18n-skip>${escape(labelOf(block))}</strong><span class="ip-summary" data-i18n-skip>${escape(String(block.text).replace(/\s+/g, ' ').slice(0, 90))}</span></span>
        ${block.provider ? `<span class="ip-provider" data-i18n-skip>${escape(block.provider)}</span>` : ''}
        ${unused ? `<span class="ip-badge" title="${escape(tr(!activeProvider ? '适用于其他渠道' : c.negativeReason))}">${tr('当前模型未使用')}</span>` : (!block.enabled ? `<span class="ip-badge">${tr('已停用')}</span>` : '')}
        <input type="checkbox" class="ip-toggle" data-field="enabled" aria-label="${tr('启用区块')}" ${block.enabled ? 'checked' : ''}>
        ${btn('drag', '拖动排序', 'grip')}
        <span class="ip-chevron">${imagePromptIcon('chevron')}</span>
      </summary><div class="ip-block-body">
      <div class="ip-block-tools"><input class="ip-block-name" data-field="name" aria-label="${tr('区块名称')}" placeholder="${tr('区块名称')}" value="${escape(block.name)}" data-i18n-skip>
        <div class="ip-block-actions">${btn('duplicate', '复制区块', 'copy')}${btn('remove', '移除区块', 'trash')}
        ${block.provider ? `<details class="ip-menu"><summary aria-label="${tr('区块操作')}">${imagePromptIcon('more')}</summary><div>${btn('all-providers', '用于所有模型')}</div></details>` : ''}
        </div></div>
      ${this.field(block, 'text', '外观、服装、动作与特征…')}
      ${c.nativeCharacters ? `<details class="ip-character-extra" ${this.openExtras.has(block.id) ? 'open' : ''}><summary>${help('角色负向与位置', '角色负向用于排除该角色的特征；位置按当前模型的网格处理')}</summary>
        <label>${tr('角色负向')}${this.field(block, 'negative', '需要排除的角色特征…')}</label>
        ${this.document.positionMode === 'custom' ? this.positionMarkup(block) : ''}
      </details>` : ''}</div></details>`;
  }
  positionMarkup(block) {
    const column = Math.min(4, Math.max(0, Math.round(((block.center?.x ?? 0.5) - 0.1) / 0.2)));
    const row = Math.min(4, Math.max(0, Math.round(((block.center?.y ?? 0.5) - 0.1) / 0.2)));
    return `<div class="ip-position-grid" role="group" aria-label="${tr('角色位置')}">${Array.from({ length: 25 }, (_, i) => {
      const selected = i === row * 5 + column;
      return `<button type="button" data-action="position" data-x="${(0.1 + (i % 5) * 0.2).toFixed(1)}" data-y="${(0.1 + Math.floor(i / 5) * 0.2).toFixed(1)}" aria-label="${tr('角色位置')} ${Math.floor(i / 5) + 1}, ${i % 5 + 1}" aria-pressed="${selected}">${selected ? '●' : ''}</button>`;
    }).join('')}</div>`;
  }
  render() {
    const c = this.compile().capability;
    this.root.querySelector('.ip-model').textContent = [this.config.provider, this.config.model].filter(Boolean).join(' · ') || tr('未选择图片模型');
    const form = resolveImagePromptForm(this.document, this.config, this.options);
    this.textFields = [...form.positive, ...form.negative];
    const characters = this.document.blocks.filter(b => b.kind === 'character');
    this.blocksEl.innerHTML = `${this.promptMarkup(form.positive)}${form.showNegative ? this.promptMarkup(form.negative, true) : ''}
      <section class="ip-characters"><div class="ip-section-head"><span>${help('角色', c.nativeCharacters ? '分别发送每个角色的描述，可独立设置负向与位置' : '按角色整理提示词，发送时合并为画面描述')} <span class="ip-count ip-character-count"></span></span>${btn('add-character', '添加角色', 'plus')}</div>
      ${c.positions && characters.length ? `<label class="ip-position-mode">${help('角色位置', '自动根据角色顺序安排；自定义时在角色中选择位置')}<select data-role="position-mode"><option value="auto" ${this.document.positionMode !== 'custom' ? 'selected' : ''}>${tr('自动')}</option><option value="custom" ${this.document.positionMode === 'custom' ? 'selected' : ''}>${tr('自定义')}</option></select></label>` : ''}
      <div class="ip-character-list">${characters.map(b => this.blockMarkup(b)).join('')}</div></section>
      <div class="ip-undo" ${this.undoDocument ? '' : 'hidden'}>${btn('undo', '撤销移除')}</div>`;
    // Keep the handle's touch area independent of text selection and scrolling.
    this.blocksEl.querySelectorAll('[data-action="drag"]').forEach(el => el.classList.add('ip-drag'));
    this.resizeFixedInputs();
    this.refreshPreview();
  }
  refreshPreview() {
    const result = this.compile();
    const count = this.document.blocks.filter(b => b.kind === 'character' && b.enabled && b.text.trim() && (!b.provider || b.provider === result.capability.provider)).length;
    const counter = this.root.querySelector('.ip-character-count');
    if (counter) counter.textContent = this.document.blocks.some(b => b.kind === 'character') ? `${count}${result.capability.maxCharacters ? ` / ${result.capability.maxCharacters}` : ''}` : '';
    const source = (title, id) => this.textFields.some(f => f.ids.includes(id)) || this.document.blocks.some(b => b.id === id && b.kind === 'character')
      ? `<button type="button" class="ip-source" data-action="source" data-source="${escape(id)}" data-i18n-skip>${escape(title)}</button>`
      : `<span class="ip-source-label" data-i18n-skip>${escape(title)}</span>`;
    const section = (title, value, id = '') => `<section class="ip-preview-section"><div>${source(title, id)}${btn('copy-preview', '复制', 'copy')}</div><pre data-i18n-skip>${escape(value)}</pre></section>`;
    this.previewEl.innerHTML = `<div class="ip-preview-title">${help('发送预览', '展示本次发送给图片模型的提示词；点击来源可返回编辑')}</div>
      ${result.errors.length ? `<div class="ip-preview-errors" role="status">${result.errors.map(error => escape(tr(error))).join('<br>')}</div>` : ''}
      ${section(tr('正向'), result.prompt, this.textFields.find(f => f.role === 'positive-main')?.ids[0])}
      ${result.negativePrompt ? section(tr('负向'), result.negativePrompt, this.textFields.find(f => f.kind === 'negative')?.ids[0]) : ''}
      ${result.characters.map(c => section(c.name || tr('角色'), c.prompt, c.id) + (c.negative ? section(`${c.name || tr('角色')} · ${tr('负向')}`, c.negative, c.id) : '') + (result.useCoords ? `<div class="ip-coordinate" data-i18n-skip>${escape(c.name || tr('角色'))} · ${c.center.x.toFixed(2)}, ${c.center.y.toFixed(2)}</div>` : '')).join('')}
      <div class="ip-source-list">${result.sources.map(s => source(labelOf(this.document.blocks.find(b => b.id === s.id)), s.id)).join('')}</div>
      ${result.unused.length ? `<details class="ip-unused"><summary>${tr('本次未使用')} · ${result.unused.length}</summary>${result.unused.map(u => `<div>${source(labelOf(this.document.blocks.find(b => b.id === u.id)), u.id)}<span>${escape(tr(u.reason))}</span><pre data-i18n-skip>${escape(u.text)}</pre></div>`).join('')}</details>` : ''}`;
  }
  handleInput(event) {
    if (event.target.dataset.textPart) {
      const field = this.textFields.find(f => f.key === event.target.dataset.textPart);
      if (!field) return;
      this.document = updateImagePromptFormText(this.document, field, event.target.value);
      if (event.target.classList.contains('ip-fixed-text')) this.resizeFixedInputs();
      this.changed(); return;
    }
    const key = event.target.dataset.field, id = event.target.closest('[data-block-id]')?.dataset.blockId;
    if (!key || !id || event.target.type === 'checkbox' || event.target.tagName === 'SELECT') return;
    const block = this.document.blocks.find(b => b.id === id); if (!block) return;
    block[key] = event.target.value;
    const row = event.target.closest('[data-block-id]');
    if (key === 'text') row.querySelector('.ip-summary').textContent = block.text.replace(/\s+/g, ' ').slice(0, 90);
    if (key === 'name') row.querySelector('.ip-block-heading strong').textContent = labelOf(block);
    this.changed();
  }
  handleChange(event) {
    if (event.target.dataset.role === 'position-mode') { this.document.positionMode = event.target.value; this.changed(); this.render(); return; }
    const key = event.target.dataset.field, id = event.target.closest('[data-block-id]')?.dataset.blockId;
    if (!key || !id || key !== 'enabled') return;
    const block = this.document.blocks.find(b => b.id === id);
    block[key] = key === 'enabled' ? event.target.checked : event.target.value; this.changed(); this.render();
  }
  handleClick(event) {
    if (event.target.matches('.ip-toggle')) event.stopPropagation();
    const pull = event.target.closest('[data-pull]');
    if (pull) { if (this.suppressPullClick) { this.suppressPullClick = false; return; } this.setPreview(pull.dataset.pull); return; }
    const button = event.target.closest('[data-action]'); if (!button) return;
    event.preventDefault(); event.stopPropagation();
    const action = button.dataset.action, id = button.closest('[data-block-id]')?.dataset.blockId;
    const block = this.document.blocks.find(b => b.id === id);
    button.closest('.ip-menu')?.removeAttribute('open');
    if (action === 'drag') return;
    if (action === 'source') { this.setPreview('close'); this.focusBlock(button.dataset.source); return; }
    if (action === 'copy-preview') { void this.copyText(button.closest('.ip-preview-section').querySelector('pre').textContent); return; }
    if (action === 'add-character') { const b = createImagePromptBlock('character', { name: `${tr('角色')} ${this.document.blocks.filter(b => b.kind === 'character').length + 1}` }); this.document.blocks.push(b); this.openBlocks.add(b.id); this.changed(); this.render(); this.focusBlock(b.id); return; }
    if (action === 'undo') { if (this.undoDocument) this.document = this.undoDocument; this.undoDocument = null; }
    else if (block?.kind !== 'character') return;
    else if (action === 'duplicate') { const b = createImagePromptBlock(block.kind, { ...block, id: createImagePromptId(), name: `${labelOf(block)} · ${tr('副本')}` }); this.document.blocks.splice(this.document.blocks.indexOf(block) + 1, 0, b); this.openBlocks.add(b.id); }
    else if (action === 'remove') { void this.removeBlock(block, button); return; }
    else if (action === 'all-providers') block.provider = '';
    else if (action === 'position') { block.center = { x: Number(button.dataset.x), y: Number(button.dataset.y) }; }
    this.changed(); this.render();
  }
  async removeBlock(block, button) {
    if (this.disposed || this.pendingRemoval) return;
    const draft = this.document;
    if (block.text.trim() || block.negative.trim()) {
      this.pendingRemoval = block.id;
      button.disabled = true;
      let confirmed;
      try {
        confirmed = await appConfirm({
          title: `${tr('移除区块')} · ${labelOf(block)}`,
          message: tr('区块内已有提示词，确定移除吗？'),
          confirmText: tr('移除'), cancelText: tr('取消'), danger: true,
        });
      } finally {
        this.pendingRemoval = null;
        button.disabled = false;
      }
      if (!confirmed) { if (button.isConnected) button.focus({ preventScroll: true }); return; }
    }
    // A confirmation belongs to the draft and block that opened it.
    if (this.disposed || this.document !== draft || !draft.blocks.includes(block)) return;
    this.undoDocument = this.getDocument();
    this.document.blocks = draft.blocks.filter(b => b !== block);
    this.changed(); this.render();
    this.blocksEl.querySelector('[data-action="undo"]')?.focus({ preventScroll: true });
  }
  focusBlock(id) {
    const field = this.textFields.find(f => f.ids.includes(id)) || (id === 'scene' ? this.textFields.find(f => f.role === 'positive-main') : null);
    if (field) { [...this.blocksEl.querySelectorAll('[data-text-part]')].find(el => el.dataset.textPart === field.key)?.focus(); return; }
    const row = [...this.blocksEl.querySelectorAll('[data-block-id]')].find(el => el.dataset.blockId === id);
    if (row) { row.open = true; row.querySelector('[data-field="text"]')?.focus(); }
  }
  moveCharacter(id, delta) { const chars = this.document.blocks.filter(b => b.kind === 'character'), from = chars.findIndex(b => b.id === id), to = Math.max(0, Math.min(chars.length - 1, from + delta)); if (from < 0 || from === to) return; chars.splice(to, 0, chars.splice(from, 1)[0]); let i = 0; this.document.blocks = this.document.blocks.map(b => b.kind === 'character' ? chars[i++] : b); this.changed(); this.render(); [...this.blocksEl.querySelectorAll('[data-block-id]')].find(el => el.dataset.blockId === id)?.querySelector('.ip-drag')?.focus(); }
  handleKey(event) { if (event.target.closest('.ip-drag') && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); this.moveCharacter(event.target.closest('[data-block-id]').dataset.blockId, event.key === 'ArrowUp' ? -1 : 1); } if (event.key === 'Escape') { this.cancelPointer(); if (this.previewState !== 'closed') { event.preventDefault(); event.stopPropagation(); this.setPreview('close'); } } }
  setPreview(action) {
    const narrow = this.root.getBoundingClientRect().width < 720;
    this.previewState = action === 'close' ? 'closed' : action === 'back' ? (this.previewState === 'full' && !narrow ? 'split' : 'closed') : (action === 'expand' || narrow ? 'full' : 'split');
    this.root.dataset.preview = this.previewState;
    this.previewEl.hidden = this.previewState === 'closed';
    this.blocksEl.hidden = this.previewState === 'full';
    this.root.querySelector('.ip-pull-open').hidden = this.previewState !== 'closed';
    this.root.querySelector('.ip-pull-open').setAttribute('aria-expanded', String(this.previewState !== 'closed'));
    this.root.querySelector('.ip-pull-expand').hidden = this.previewState !== 'split';
    this.root.querySelector('.ip-pull-back').hidden = this.previewState === 'closed';
    if (this.previewState !== 'full') this.resizeFixedInputs();
    this.refreshPreview();
  }
  pointerDown(event) {
    if (event.button !== 0) return;
    const handle = event.target.closest('[data-pull],.ip-drag'); if (!handle) return;
    const id = handle.closest('[data-block-id]')?.dataset.blockId;
    this.cancelPointer(); this.pointer = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, lastY: event.clientY, pull: handle.dataset.pull, id, active: false };
    this.root.setPointerCapture(event.pointerId);
    if (id) this.holdTimer = setTimeout(() => this.startDrag(), event.pointerType === 'touch' ? 260 : 160);
  }
  startDrag() {
    if (!this.pointer?.id || this.pointer.active) return;
    this.pointer.active = true; this.root.classList.add('is-dragging'); this.ghost = document.createElement('div'); this.ghost.className = 'ip-drag-ghost'; this.ghost.textContent = labelOf(this.document.blocks.find(b => b.id === this.pointer.id)); document.body.append(this.ghost); this.placeGhost();
    const tick = () => { if (!this.pointer?.active) return; this.pointerMove({ pointerId: this.pointer.pointerId, clientY: this.pointer.lastY, preventDefault() {} }); this.dragFrame = requestAnimationFrame(tick); };
    this.dragFrame = requestAnimationFrame(tick);
  }
  placeGhost() { if (this.ghost) { this.ghost.style.left = `${this.pointer.x + 12}px`; this.ghost.style.top = `${this.pointer.lastY - 20}px`; } }
  pointerMove(event) {
    const p = this.pointer; if (!p || p.pointerId !== event.pointerId) return; p.lastY = event.clientY;
    if (p.pull) return;
    if (!p.active && Math.abs(event.clientY - p.y) > 7 && event.pointerType !== 'touch') this.startDrag();
    if (!p.active) return; event.preventDefault(); this.placeGhost();
    const rows = [...this.blocksEl.querySelectorAll('.ip-character')]; rows.forEach(row => row.classList.remove('ip-drop-before', 'ip-drop-after'));
    const other = rows.filter(row => row.dataset.blockId !== p.id);
    const target = other.find(row => event.clientY < row.getBoundingClientRect().bottom) || other[other.length - 1];
    if (target) { p.target = target.dataset.blockId; p.after = event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2; target.classList.add(p.after ? 'ip-drop-after' : 'ip-drop-before'); }
    const bounds = this.blocksEl.getBoundingClientRect();
    if (event.clientY < bounds.top + 40) this.blocksEl.scrollTop -= 22;
    else if (event.clientY > bounds.bottom - 40) this.blocksEl.scrollTop += 22;
  }
  pointerEnd(event) {
    const p = this.pointer; if (!p || p.pointerId !== event.pointerId) return;
    if (p.pull) { this.suppressPullClick = true; const moved = Math.abs(event.clientX - p.x) > 18; this.setPreview(moved ? (event.clientX < p.x ? (this.previewState === 'closed' ? 'open' : 'expand') : 'back') : p.pull); setTimeout(() => { this.suppressPullClick = false; }, 0); }
    if (p.active && p.target) { const chars = this.document.blocks.filter(b => b.kind === 'character'), from = chars.findIndex(b => b.id === p.id), target = chars.findIndex(b => b.id === p.target); const to = target + (p.after ? 1 : 0) - (from < target ? 1 : 0); this.moveCharacter(p.id, to - from); }
    this.cancelPointer();
  }
  cancelPointer() { clearTimeout(this.holdTimer); cancelAnimationFrame(this.dragFrame); const p = this.pointer; this.pointer = null; if (p && this.root.hasPointerCapture(p.pointerId)) this.root.releasePointerCapture(p.pointerId); this.ghost?.remove(); this.ghost = null; this.root.classList.remove('is-dragging'); this.blocksEl.querySelectorAll('.ip-drop-before,.ip-drop-after').forEach(el => el.classList.remove('ip-drop-before', 'ip-drop-after')); }
  async copyText(value) { try { await navigator.clipboard.writeText(value); this.status('已复制'); } catch { this.status('复制失败，请选择文本复制', true); } }
  destroy() { this.disposed = true; this.resizeObserver?.disconnect(); this.cancelPointer(); this.root.remove(); }
}
