import { IMAGE_PROMPT_TEXT_KEYS } from './image-prompt/image-prompt-utils.js';
import { getImageGenerationParamsStore } from '../storage/image-generation-params-store.js';
import { t, translateUiText } from '../i18n/index.js';
import { imageGenerationSizeControlMarkup, bindImageGenerationSizeControl, validateImageGenerationSizeControls } from './image-generation-size-control.js';
import {
  createDefaultImageGenerationPreset,
  normalizeImageGenerationPreset,
  normalizeImageProviderKey,
  resolveImageGenerationParamSchema,
  sanitizeImageGenerationParams,
} from './image-generation-params-utils.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
}[ch]));

const clone = (value) => {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
};

const FIELD_CLASS = 'image-gen-param-field';

export const resolveImageGenerationOptionLabel = (option = {}) => {
  const label = String(option?.label || option?.value || '');
  const context = String(option?.i18nContext || '').trim();
  return context ? t(label, {}, { context }) : translateUiText(label);
};

const iconSvg = (path) => `
  <svg class="igp-icon" viewBox="0 0 24 24" aria-hidden="true">
    ${path}
  </svg>
`;

const ICONS = Object.freeze({
  back: iconSvg('<path d="M15 18l-6-6 6-6"/><path d="M20 12H9"/>'),
  close: iconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  image: iconSvg('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="m21 15-4.2-4.2a2 2 0 0 0-2.8 0L6 18"/>'),
  plus: iconSvg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  rename: iconSvg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  reset: iconSvg('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/>'),
  save: iconSvg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
  trash: iconSvg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>'),
});

export class ImageGenerationParamsPanel {
  constructor({ store = null, getImageConfig = null } = {}) {
    this.store = store || getImageGenerationParamsStore();
    this.getImageConfig = typeof getImageConfig === 'function' ? getImageConfig : async () => ({});
    this.overlay = null;
    this.panel = null;
    this.body = null;
    this.statusEl = null;
    this.currentConfig = {};
    this.currentSchema = resolveImageGenerationParamSchema({});
    this.isRendering = false;
    this.mode = 'modal';
    this.embeddedContainer = null;
    this.onBack = null;
  }

  async show() {
    if (!this.panel || this.mode !== 'modal') this.createUI();
    await this.render();
    this.overlay.style.display = 'block';
    this.panel.style.display = 'flex';
  }

  async showEmbedded({ container = null, onBack = null } = {}) {
    if (!container) return;
    if (!this.panel || this.mode !== 'embedded' || this.embeddedContainer !== container) {
      this.createEmbeddedUI(container);
    }
    this.onBack = typeof onBack === 'function' ? onBack : null;
    await this.render();
    this.panel.style.display = 'flex';
  }

  hide() {
    if (this.overlay) this.overlay.style.display = 'none';
    if (this.panel) this.panel.style.display = 'none';
  }

  goBack() {
    if (typeof this.onBack === 'function') {
      this.onBack();
      return;
    }
    this.hide();
  }

  createUI() {
    if (this.panel?.parentNode) {
      this.panel.parentNode.removeChild(this.panel);
    }
    this.mode = 'modal';
    this.embeddedContainer = null;
    this.overlay = document.createElement('div');
    this.overlay.id = 'image-generation-params-overlay';
    this.overlay.style.display = 'none';
    this.overlay.addEventListener('click', () => this.hide());

    this.panel = document.createElement('div');
    this.panel.id = 'image-generation-params-panel';
    this.panel.className = 'igp-panel igp-panel-modal';
    this.panel.style.display = 'none';
    this.panel.addEventListener('click', (event) => event.stopPropagation());
    this.panel.innerHTML = `
      <div class="igp-header">
        <div class="igp-title-wrap">
          <span class="igp-title-icon">${ICONS.image}</span>
          <div style="min-width:0;">
            <div class="igp-title">图片生成参数</div>
            <div class="igp-subtitle">独立于 API Key 和连线设置档</div>
          </div>
        </div>
        <button type="button" class="igp-button is-icon" data-action="close" aria-label="关闭图片生成参数">${ICONS.close}</button>
      </div>
      <div class="igp-body" data-role="body"></div>
      <div class="igp-status" data-role="status"></div>
      <div class="igp-footer">
        <button type="button" class="igp-button is-muted" data-action="cancel">取消</button>
        <button type="button" class="igp-button is-primary" data-action="save">${ICONS.save}<span>保存参数</span></button>
      </div>
    `;
    this.body = this.panel.querySelector('[data-role="body"]');
    this.statusEl = this.panel.querySelector('[data-role="status"]');
    this.panel.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
    this.panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => this.hide());
    this.panel.querySelector('[data-action="save"]')?.addEventListener('click', () => this.saveCurrent());

    window.addEventListener('config-draft-changed', (event) => {
      if (event?.detail?.tab && event.detail.tab !== 'image') return;
      if (this.panel?.style.display !== 'none') this.render();
    });
    window.addEventListener('config-profile-changed', (event) => {
      if (event?.detail?.tab && event.detail.tab !== 'image') return;
      if (this.panel?.style.display !== 'none') this.render();
    });

    document.body.appendChild(this.overlay);
    document.body.appendChild(this.panel);
  }

  createEmbeddedUI(container) {
    if (this.panel?.parentNode) {
      this.panel.parentNode.removeChild(this.panel);
    }
    this.mode = 'embedded';
    this.overlay = null;
    this.embeddedContainer = container;

    this.panel = document.createElement('div');
    this.panel.id = 'image-generation-params-panel';
    this.panel.className = 'igp-panel igp-panel-embedded';
    this.panel.style.display = 'none';
    this.panel.innerHTML = `
      <div class="igp-header">
        <div class="igp-title-wrap">
          <button type="button" class="igp-button is-muted" data-action="back">${ICONS.back}<span>返回</span></button>
          <span class="igp-title-icon">${ICONS.image}</span>
          <div style="min-width:0;">
            <div class="igp-title">图片生成参数</div>
            <div class="igp-subtitle">质量、尺寸、输出格式等共享参数</div>
          </div>
        </div>
      </div>
      <div class="igp-body" data-role="body"></div>
      <div class="igp-status" data-role="status"></div>
      <div class="igp-footer">
        <button type="button" class="igp-button is-muted" data-action="cancel">返回</button>
        <button type="button" class="igp-button is-primary" data-action="save">${ICONS.save}<span>保存参数</span></button>
      </div>
    `;
    this.body = this.panel.querySelector('[data-role="body"]');
    this.statusEl = this.panel.querySelector('[data-role="status"]');
    this.panel.querySelector('[data-action="back"]')?.addEventListener('click', () => this.goBack());
    this.panel.querySelector('[data-action="cancel"]')?.addEventListener('click', () => this.goBack());
    this.panel.querySelector('[data-action="save"]')?.addEventListener('click', () => this.saveCurrent());
    container.innerHTML = '';
    container.appendChild(this.panel);
  }

  async resolveConfig() {
    try {
      const config = await this.getImageConfig();
      return config && typeof config === 'object' ? config : {};
    } catch {
      return {};
    }
  }

  getProviderParams(preset, config) {
    const provider = normalizeImageProviderKey(config?.provider);
    const normalized = normalizeImageGenerationPreset(preset);
    return normalized.paramsByProvider?.[provider] || {};
  }

  async render() {
    if (!this.body || this.isRendering) return;
    this.isRendering = true;
    try {
      await this.store.ready;
      this.currentConfig = await this.resolveConfig();
      this.currentSchema = resolveImageGenerationParamSchema(this.currentConfig);
      const presets = this.store.list();
      const active = this.store.getActive();
      const provider = normalizeImageProviderKey(this.currentConfig?.provider);
      const params = {
        ...this.getProviderParams(createDefaultImageGenerationPreset(), this.currentConfig),
        ...this.getProviderParams(active, this.currentConfig),
      };
      const modelLabel = [this.currentConfig?.provider, this.currentConfig?.model].filter(Boolean).join(' / ') || '未选择图片模型';

      this.body.innerHTML = `
        <div class="igp-preset-bar">
          <div>
            <label class="igp-label">参数预设</label>
            <select class="igp-select" data-role="preset-select">
              ${presets.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === active.id ? 'selected' : ''}>${escapeHtml(p.name || p.id)}</option>`).join('')}
            </select>
          </div>
          <div class="igp-preset-actions">
            <button type="button" class="igp-button" data-action="new">${ICONS.plus}<span>新建</span></button>
            <button type="button" class="igp-button" data-action="rename">${ICONS.rename}<span>重命名</span></button>
            <button type="button" class="igp-button is-danger" data-action="delete">${ICONS.trash}<span>删除</span></button>
          </div>
        </div>
        <div class="igp-model-card">
          <span class="igp-title-icon">${ICONS.image}</span>
          <div style="min-width:0;">
            <div class="igp-model-title">${escapeHtml(this.currentSchema.title)}</div>
            <div class="igp-model-sub">当前图片模型：${escapeHtml(modelLabel)}</div>
          </div>
        </div>
        <div class="igp-fields-grid">
          ${this.currentSchema.fields.map(field => this.renderField(field, params[field.key])).join('')}
        </div>
        <div class="igp-reset-row">
          <button type="button" class="igp-button is-muted" data-action="reset-provider">${ICONS.reset}<span>重置当前模型参数</span></button>
        </div>
      `;

      this.body.querySelector('[data-role="preset-select"]')?.addEventListener('change', async (event) => {
        await this.store.setActive(event.target.value);
        this.emitChanged();
        await this.render();
      });
      this.body.querySelector('[data-action="new"]')?.addEventListener('click', () => this.createPreset());
      this.body.querySelector('[data-action="rename"]')?.addEventListener('click', () => this.renamePreset());
      this.body.querySelector('[data-action="delete"]')?.addEventListener('click', () => this.deletePreset());
      this.body.querySelector('[data-action="reset-provider"]')?.addEventListener('click', () => this.resetProviderParams(provider));
      this.bindFieldInteractions();
    } finally {
      this.isRendering = false;
    }
  }

  renderField(field, value) {
    const safeValue = value ?? field.defaultValue ?? '';
    const headingHelp = field.help && (field.type === 'image-size' || IMAGE_PROMPT_TEXT_KEYS.includes(field.key));
    const help = field.help && !headingHelp ? `<div class="igp-field-help">${escapeHtml(field.help)}</div>` : '';
    const common = `data-param-key="${escapeHtml(field.key)}"`;
    const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
    const fieldClasses = [
      'igp-field',
      field.fullWidth ? 'is-full-width' : '',
      field.variant ? `is-${field.variant}` : '',
    ].filter(Boolean).join(' ');
    const title = headingHelp ? `<span class="has-help" data-help="${escapeHtml(translateUiText(field.help))}" data-help-mode="tap">${escapeHtml(field.label)}</span>` : escapeHtml(field.label);
    const label = field.badge
      ? `<div class="igp-field-heading">
          <div class="igp-label">${title}</div>
          <span class="igp-field-badge">${escapeHtml(field.badge)}</span>
        </div>`
      : `<div class="igp-label">${title}</div>`;
    let control = '';
    if (field.type === 'image-size') {
      control = imageGenerationSizeControlMarkup(field, safeValue, { selectClass: 'igp-select', inputClass: `${FIELD_CLASS} igp-input` });
    } else if (field.type === 'select') {
      control = `<select ${common} class="${FIELD_CLASS} igp-select">
        ${(field.options || []).map(opt => `<option value="${escapeHtml(opt.value)}" ${String(opt.value) === String(safeValue) ? 'selected' : ''}>${escapeHtml(resolveImageGenerationOptionLabel(opt))}</option>`).join('')}
      </select>`;
    } else if (field.type === 'number') {
      control = `<input ${common} class="${FIELD_CLASS} igp-input" type="number" min="${escapeHtml(field.min ?? '')}" max="${escapeHtml(field.max ?? '')}" step="${escapeHtml(field.step ?? 1)}" value="${escapeHtml(safeValue)}">`;
    } else if (field.type === 'textarea') {
      control = `<textarea ${common}${placeholder} class="${FIELD_CLASS} igp-textarea">${escapeHtml(safeValue)}</textarea>`;
    } else {
      control = `<input ${common}${placeholder} class="${FIELD_CLASS} igp-input" type="text" value="${escapeHtml(safeValue)}">`;
    }
    return `
      <label class="${fieldClasses}">
        ${label}
        ${control}
        ${help}
      </label>
    `;
  }

  bindFieldInteractions() {
    this.body?.querySelectorAll('.image-size-control').forEach(bindImageGenerationSizeControl);
    const samplerEl = this.body?.querySelector('[data-param-key="sampler"]');
    const smEl = this.body?.querySelector('[data-param-key="sm"]');
    const smDynEl = this.body?.querySelector('[data-param-key="sm_dyn"]');
    if (!samplerEl || !smEl || !smDynEl || this.currentSchema?.provider !== 'novelai') return;
    const syncNovelAiSmea = () => {
      const isDdim = String(samplerEl.value || '') === 'ddim';
      const hasSmea = !isDdim && String(smEl.value || '') === 'true';
      smEl.disabled = isDdim;
      smDynEl.disabled = !hasSmea;
      if (isDdim) smEl.value = '';
      if (!hasSmea) smDynEl.value = '';
      smEl.style.opacity = smEl.disabled ? '0.55' : '';
      smDynEl.style.opacity = smDynEl.disabled ? '0.55' : '';
    };
    samplerEl.addEventListener('change', syncNovelAiSmea);
    smEl.addEventListener('change', syncNovelAiSmea);
    syncNovelAiSmea();
  }

  collectParams() {
    const params = Object.fromEntries(IMAGE_PROMPT_TEXT_KEYS.filter(key => Object.hasOwn(this.getProviderParams(this.store.getActive(), this.currentConfig), key)).map(key => [key, this.getProviderParams(this.store.getActive(), this.currentConfig)[key]]));
    this.currentSchema.fields.forEach((field) => {
      const el = this.body?.querySelector(`[data-param-key="${CSS.escape(field.key)}"]`);
      if (!el) return;
      if (field.type === 'number') params[field.key] = Number(el.value);
      else params[field.key] = String(el.value || '');
    });
    return sanitizeImageGenerationParams(params, this.currentConfig);
  }

  async saveCurrent() {
    if (!validateImageGenerationSizeControls(this.body)) return;
    await this.store.ready;
    const active = this.store.getActive();
    const provider = normalizeImageProviderKey(this.currentConfig?.provider);
    const next = normalizeImageGenerationPreset({
      ...active,
      paramsByProvider: {
        ...(active.paramsByProvider || {}),
        [provider]: this.collectParams(),
      },
      updatedAt: Date.now(),
    });
    await this.store.upsert(next);
    this.showStatus('图片生成参数已保存', 'success');
    this.emitChanged();
    await this.render();
  }

  async createPreset() {
    const active = this.store.getActive();
    const name = prompt('新图片参数预设名称', `${active.name || '图片参数'} 副本`);
    if (!name) return;
    const copy = {
      ...clone(active),
      id: '',
      name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.store.upsert(copy);
    this.emitChanged();
    await this.render();
  }

  async renamePreset() {
    const active = this.store.getActive();
    const name = prompt('重命名图片参数预设', active.name || '');
    if (!name) return;
    await this.store.rename(active.id, name);
    this.emitChanged();
    await this.render();
  }

  async deletePreset() {
    const active = this.store.getActive();
    if (active.id === 'default') {
      this.showStatus('默认参数预设不能删除', 'error');
      return;
    }
    if (!confirm(`删除图片参数预设「${active.name}」？`)) return;
    await this.store.delete(active.id);
    this.emitChanged();
    await this.render();
  }

  async resetProviderParams(provider) {
    const active = this.store.getActive();
    const fallback = createDefaultImageGenerationPreset();
    const next = normalizeImageGenerationPreset({
      ...active,
      paramsByProvider: {
        ...(active.paramsByProvider || {}),
        [provider]: {
          ...(fallback.paramsByProvider?.[provider] || {}),
          ...Object.fromEntries(IMAGE_PROMPT_TEXT_KEYS.filter(key => Object.hasOwn(active.paramsByProvider?.[provider] || {}, key)).map(key => [key, active.paramsByProvider[provider][key]])),
        },
      },
      updatedAt: Date.now(),
    });
    await this.store.upsert(next);
    this.showStatus('已重置当前模型参数', 'success');
    this.emitChanged();
    await this.render();
  }

  showStatus(message, type = 'info') {
    if (!this.statusEl) return;
    this.statusEl.style.display = 'block';
    this.statusEl.className = `igp-status ${type === 'error' ? 'is-error' : 'is-success'}`;
    this.statusEl.textContent = message;
    setTimeout(() => {
      if (this.statusEl) this.statusEl.style.display = 'none';
    }, 2600);
  }

  emitChanged() {
    try {
      window.dispatchEvent(new CustomEvent('image-generation-params-changed'));
    } catch {}
  }
}
