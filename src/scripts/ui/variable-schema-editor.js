import {
  buildVariableScopeImpactText,
  formatVariableScopeLabel,
  inferVariableValueType,
} from './variable-panel-state-utils.js';
import {
  formatVariableDisplayValue,
  getVariablePercent,
} from './variable-panel-views.js';
import { translateUiText } from '../i18n/index.js';

const ALLOWED_VARIABLE_TYPES = new Set([
  'number',
  'string',
  'boolean',
  'enum',
  'array',
  'object',
]);

// theme-audit-ignore: these are user-selectable variable data colors, not UI theme colors.
export const VARIABLE_COLOR_PRESETS = Object.freeze([
  '#7c3aed',
  '#2563eb',
  '#0891b2',
  '#059669',
  '#65a30d',
  '#ca8a04',
  '#ea580c',
  '#dc2626',
  '#e11d48',
  '#c026d3',
  '#64748b',
  '#334155',
]);

const cloneValue = (value) => {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {}
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

export const formatVariableSchemaInputValue = (value) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'object') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

export const inferVariableEditorType = value => inferVariableValueType(value);

const parseBoolean = (value, label = '值') => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return { ok: true, value: true };
  if (['false', '0', 'no', 'off'].includes(normalized)) return { ok: true, value: false };
  return { ok: false, error: `${label}必须是 true/false` };
};

export const parseVariableEditorValue = (rawValue, rawType = 'string') => {
  const type = String(rawType || 'string').trim().toLowerCase();
  if (type === 'number') {
    if (String(rawValue ?? '').trim() === '') return { ok: true, value: '' };
    const value = Number(rawValue);
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, error: '当前值必须是数字' };
  }
  if (type === 'boolean') return parseBoolean(rawValue, '当前值');
  if (type === 'array' || type === 'object') {
    if (String(rawValue ?? '').trim() === '') {
      return { ok: true, value: type === 'array' ? [] : {} };
    }
    try {
      const value = JSON.parse(String(rawValue));
      if (type === 'array' && !Array.isArray(value)) {
        return { ok: false, error: '当前值必须是 JSON 数组' };
      }
      if (type === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
        return { ok: false, error: '当前值必须是 JSON 对象' };
      }
      return { ok: true, value };
    } catch {
      return { ok: false, error: '当前值需为合法 JSON' };
    }
  }
  return { ok: true, value: String(rawValue ?? '') };
};

export const buildVariableSchemaDraft = ({
  key = '',
  valueRaw = '',
  type = '',
  defaultRaw = '',
  minRaw = '',
  maxRaw = '',
  optionsRaw = '',
  display = 'card',
  color = '',
  format = '',
} = {}) => {
  const name = String(key || '').trim();
  if (!name) return { ok: false, error: '变量名不能为空' };
  const normalizedType = String(type || '').trim().toLowerCase();
  if (!normalizedType) {
    return { ok: true, key: name, value: valueRaw, schema: null };
  }
  if (!ALLOWED_VARIABLE_TYPES.has(normalizedType)) {
    return { ok: false, error: '类型记号无效' };
  }

  const schema = { id: name, name, type: normalizedType };
  const defaultInput = String(defaultRaw ?? '');
  if (defaultInput !== '') {
    const parsed = parseVariableEditorValue(defaultInput, normalizedType);
    if (!parsed.ok) {
      return {
        ok: false,
        error: parsed.error.replace('当前值', '默认值'),
      };
    }
    schema.default = parsed.value;
  }

  if (normalizedType === 'number') {
    const minText = String(minRaw ?? '').trim();
    const maxText = String(maxRaw ?? '').trim();
    if (minText || maxText) {
      const min = minText ? Number(minText) : null;
      const max = maxText ? Number(maxText) : null;
      if (minText && !Number.isFinite(min)) return { ok: false, error: '最小值必须是数字' };
      if (maxText && !Number.isFinite(max)) return { ok: false, error: '最大值必须是数字' };
      if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
        return { ok: false, error: '最小值不能大于最大值' };
      }
      schema.range = { min, max };
    }
  }
  if (normalizedType === 'enum') {
    schema.options = String(optionsRaw || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
  }
  schema.ui = {
    display: String(display || 'card').trim(),
    color: String(color || '').trim(),
    format: String(format || '').trim(),
  };
  return {
    ok: true,
    key: name,
    value: valueRaw,
    schema,
  };
};

export const mergeVariableSchemaDraft = (existingSchema, draftSchema) => {
  if (!draftSchema) return null;
  const existing = existingSchema && typeof existingSchema === 'object'
    ? existingSchema
    : {};
  const draft = draftSchema && typeof draftSchema === 'object'
    ? draftSchema
    : {};
  const merged = {
    ...existing,
    ...draft,
    ui: {
      ...(existing.ui && typeof existing.ui === 'object' ? existing.ui : {}),
      ...(draft.ui && typeof draft.ui === 'object' ? draft.ui : {}),
    },
  };
  if (draft.type !== 'number') delete merged.range;
  if (draft.type !== 'enum') delete merged.options;
  return merged;
};

const notify = (type, message) => {
  try {
    globalThis.window?.toastr?.[type]?.(message);
  } catch {}
};

const setText = (element, value) => {
  if (element) element.textContent = String(value ?? '');
};

const setHidden = (element, hidden) => {
  if (!element) return;
  element.hidden = Boolean(hidden);
};

const isHexColor = value => /^#[0-9a-f]{6}$/i.test(String(value || '').trim());

const setVariableColor = (element, color) => {
  if (!element?.style) return;
  const value = String(color || '').trim();
  if (!value) {
    element.style.removeProperty?.('--variable-color');
    return;
  }
  element.style.setProperty?.('--variable-color', value);
};

const formatInitialValue = (value) => {
  if (value === undefined) return '未设置';
  const formatted = formatVariableSchemaInputValue(value);
  return formatted === '' ? '（空字符串）' : formatted;
};

export class VariableSchemaEditor {
  constructor({
    getContext = () => ({ sid: '', scope: 'session' }),
    getSchema = () => null,
    getValue = () => undefined,
    getInitialValue = () => undefined,
    setSchema = () => false,
    deleteSchema = () => false,
    setVariable = () => false,
    isGlobalScope = () => false,
    isNestedPath = () => false,
    restoreInitialValue = null,
    onChange = () => {},
    onDelete = () => {},
    getMountRoot = () => globalThis.document?.body,
  } = {}) {
    this.getContext = getContext;
    this.getSchema = getSchema;
    this.getValue = getValue;
    this.getInitialValue = getInitialValue;
    this.setSchema = setSchema;
    this.deleteSchema = deleteSchema;
    this.setVariable = setVariable;
    this.isGlobalScope = isGlobalScope;
    // 树视图里的嵌套值（stat_data.角色.好感度）只能改值：schema 按顶层变量名存，给路径建 schema 会生出扁平变量
    this.isNestedPath = isNestedPath;
    this.restoreInitialValue = restoreInitialValue;
    this.onChange = onChange;
    this.onDelete = onDelete;
    this.getMountRoot = getMountRoot;
    this.overlay = null;
    this.panel = null;
    this.fields = null;
    this.currentKey = '';
    this.mode = 'create';
    this.existingSchema = null;
    this.pendingValue = '';
    this.initialValue = undefined;
    this.visibilityRevision = 0;
  }

  ensure() {
    if (this.overlay) return;
    const documentRef = globalThis.document;
    if (!documentRef) return;
    const overlay = documentRef.createElement('div');
    overlay.className = 'variable-inspector-layer variable-schema-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <button type="button" class="variable-inspector-backdrop" aria-label="关闭变量详情"></button>
      <aside class="variable-inspector-panel variable-schema-panel" role="dialog" aria-modal="true" aria-labelledby="variable-inspector-title">
        <header class="variable-inspector-header">
          <div>
            <div class="variable-inspector-eyebrow">VARIABLE DETAIL</div>
            <h2 id="variable-inspector-title">变量详情</h2>
          </div>
          <button type="button" class="variable-icon-button" data-action="close" aria-label="关闭">×</button>
        </header>
        <div class="variable-inspector-scroll">
          <section class="variable-inspector-preview" aria-live="polite">
            <div class="variable-field-label">实时预览</div>
            <div data-field="preview"></div>
          </section>

          <section class="variable-inspector-section">
            <label class="variable-field-label" for="variable-inspector-key">变量名</label>
            <input id="variable-inspector-key" class="variable-input variable-name-input" data-field="key" autocomplete="off">
            <div class="variable-scope-line" data-field="impact"></div>
            <button type="button" class="variable-reference-copy" data-action="copy-reference">
              <code data-field="reference"></code>
              <span>复制引用</span>
            </button>
          </section>

          <section class="variable-inspector-section">
            <div class="variable-field-label">当前值 · 即时保存</div>
            <div data-field="value-editor"></div>
            <div class="variable-field-error" data-field="value-error" hidden></div>
          </section>

          <div class="variable-inspector-draft-note" data-field="draft-note">
            以下类型与展示配置会在点击「保存配置」后写入。
          </div>

          <div data-field="schema-config">
            <section class="variable-inspector-section variable-schema-grid">
              <label>
                <span class="variable-field-label">类型</span>
                <select class="variable-input" data-field="type">
                  <option value="">无 Schema</option>
                  <option value="string">文本</option>
                  <option value="number">数值</option>
                  <option value="boolean">布尔</option>
                  <option value="enum">枚举</option>
                  <option value="array">数组</option>
                  <option value="object">对象</option>
                </select>
              </label>
              <label>
                <span class="variable-field-label">默认值</span>
                <input class="variable-input" data-field="default" autocomplete="off">
              </label>
            </section>

            <section class="variable-inspector-section variable-schema-grid" data-field="range" hidden>
              <label>
                <span class="variable-field-label">最小值</span>
                <input type="number" class="variable-input" data-field="min">
              </label>
              <label>
                <span class="variable-field-label">最大值</span>
                <input type="number" class="variable-input" data-field="max">
              </label>
            </section>

            <section class="variable-inspector-section" data-field="options-wrap" hidden>
              <label class="variable-field-label" for="variable-inspector-options">枚举选项（逗号分隔）</label>
              <input id="variable-inspector-options" class="variable-input" data-field="options" autocomplete="off">
            </section>

            <section class="variable-inspector-section">
              <div class="variable-field-label">展示方式</div>
              <input type="hidden" data-field="display">
              <div class="variable-display-picker" data-field="display-picker">
                <button type="button" data-display="card"><span class="variable-display-mini is-card"></span><span>卡片</span></button>
                <button type="button" data-display="progress"><span class="variable-display-mini is-progress"></span><span>进度</span></button>
                <button type="button" data-display="badge"><span class="variable-display-mini is-badge"></span><span>徽章</span></button>
                <button type="button" data-display="ring"><span class="variable-display-mini is-ring"></span><span>圆环</span></button>
              </div>
            </section>

            <section class="variable-inspector-section">
              <div class="variable-field-label">颜色</div>
              <div class="variable-color-picker" data-field="color-picker"></div>
              <div class="variable-custom-color">
                <input type="color" data-field="color-native" aria-label="自定义颜色">
                <input class="variable-input" data-field="color" placeholder="自定义颜色" spellcheck="false">
              </div>
            </section>

            <section class="variable-inspector-section">
              <label class="variable-field-label" for="variable-inspector-format">格式模板</label>
              <input id="variable-inspector-format" class="variable-input variable-mono-input" data-field="format" placeholder="{value}/100" spellcheck="false">
              <div class="variable-format-preview"><span>使用 {value} 占位</span><strong data-field="format-preview"></strong></div>
            </section>
          </div>

          <section class="variable-inspector-section variable-initial-card">
            <div>
              <div class="variable-field-label">初始值</div>
              <code data-field="initial-value"></code>
            </div>
            <button type="button" class="variable-secondary-button" data-action="restore-initial">恢复初始值</button>
          </section>

          <button type="button" class="variable-danger-button variable-inspector-delete" data-action="delete">删除此变量</button>
        </div>
        <footer class="variable-inspector-footer">
          <button type="button" class="variable-secondary-button" data-action="cancel">取消</button>
          <button type="button" class="variable-primary-button" data-action="save">保存配置</button>
        </footer>
      </aside>
    `;

    const query = selector => overlay.querySelector(selector);
    const fields = {
      title: query('#variable-inspector-title'),
      preview: query('[data-field="preview"]'),
      key: query('[data-field="key"]'),
      impact: query('[data-field="impact"]'),
      reference: query('[data-field="reference"]'),
      valueEditor: query('[data-field="value-editor"]'),
      valueError: query('[data-field="value-error"]'),
      draftNote: query('[data-field="draft-note"]'),
      schemaConfig: query('[data-field="schema-config"]'),
      type: query('[data-field="type"]'),
      def: query('[data-field="default"]'),
      range: query('[data-field="range"]'),
      min: query('[data-field="min"]'),
      max: query('[data-field="max"]'),
      optionsWrap: query('[data-field="options-wrap"]'),
      options: query('[data-field="options"]'),
      display: query('[data-field="display"]'),
      displayPicker: query('[data-field="display-picker"]'),
      colorPicker: query('[data-field="color-picker"]'),
      colorNative: query('[data-field="color-native"]'),
      color: query('[data-field="color"]'),
      format: query('[data-field="format"]'),
      formatPreview: query('[data-field="format-preview"]'),
      initialValue: query('[data-field="initial-value"]'),
      restore: query('[data-action="restore-initial"]'),
      delete: query('[data-action="delete"]'),
      save: query('[data-action="save"]'),
    };

    VARIABLE_COLOR_PRESETS.forEach((color) => {
      const button = documentRef.createElement('button');
      button.type = 'button';
      button.className = 'variable-color-swatch';
      button.dataset.color = color;
      button.title = color;
      button.style.setProperty('--swatch-color', color);
      button.addEventListener('click', () => {
        fields.color.value = color;
        fields.colorNative.value = color;
        this.updateColorPicker();
        this.renderPreview();
      });
      fields.colorPicker?.appendChild(button);
    });

    query('.variable-inspector-backdrop')?.addEventListener('click', () => this.hide());
    query('[data-action="close"]')?.addEventListener('click', () => this.hide());
    query('[data-action="cancel"]')?.addEventListener('click', () => this.hide());
    query('[data-action="copy-reference"]')?.addEventListener('click', () => this.copyReference());
    query('[data-action="restore-initial"]')?.addEventListener('click', () => this.restoreInitial());
    query('[data-action="delete"]')?.addEventListener('click', () => this.removeVariable());
    query('[data-action="save"]')?.addEventListener('click', () => this.save());
    fields.key?.addEventListener('input', () => this.updateIdentity());
    fields.type?.addEventListener('change', () => {
      this.updateTypeUI();
      this.renderValueEditor();
      this.renderPreview();
    });
    [fields.def, fields.min, fields.max, fields.options, fields.format].forEach((field) => {
      field?.addEventListener('input', () => {
        if (field === fields.min || field === fields.max || field === fields.options) {
          this.renderValueEditor();
        }
        this.renderPreview();
      });
    });
    fields.displayPicker?.querySelectorAll?.('[data-display]')?.forEach?.((button) => {
      button.addEventListener('click', () => {
        fields.display.value = button.dataset.display || 'card';
        this.updateDisplayPicker();
        this.renderPreview();
      });
    });
    fields.color?.addEventListener('input', () => {
      if (isHexColor(fields.color.value)) fields.colorNative.value = fields.color.value;
      this.updateColorPicker();
      this.renderPreview();
    });
    fields.colorNative?.addEventListener('input', () => {
      fields.color.value = fields.colorNative.value;
      this.updateColorPicker();
      this.renderPreview();
    });

    const mountRoot = this.getMountRoot?.() || documentRef.body;
    mountRoot?.appendChild?.(overlay);
    this.overlay = overlay;
    this.panel = query('.variable-inspector-panel');
    this.fields = fields;
  }

  updateIdentity() {
    const key = String(this.fields?.key?.value || '').trim();
    setText(this.fields?.title, key || '新建变量');
    setText(this.fields?.reference, `{{getvar::${key || 'name'}}}`);
  }

  updateImpact() {
    const impact = this.fields?.impact;
    if (!impact) return;
    const { sid, scope } = this.getContext();
    const text = translateUiText(buildVariableScopeImpactText({
      scope,
      sessionId: sid,
      action: 'edit',
    }));
    impact.dataset.i18nSkip = '';
    impact.textContent = translateUiText(formatVariableScopeLabel({ scope, sessionId: sid }));
    impact.title = text;
    impact.setAttribute('aria-label', text);
  }

  updateTypeUI() {
    const type = String(this.fields?.type?.value || '');
    setHidden(this.fields?.range, type !== 'number');
    setHidden(this.fields?.optionsWrap, type !== 'enum');
  }

  updateDisplayPicker() {
    const selected = String(this.fields?.display?.value || 'card');
    this.fields?.displayPicker?.querySelectorAll?.('[data-display]')?.forEach?.((button) => {
      const active = button.dataset.display === selected;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  updateColorPicker() {
    const selected = String(this.fields?.color?.value || '').trim().toLowerCase();
    this.fields?.colorPicker?.querySelectorAll?.('[data-color]')?.forEach?.((button) => {
      button.classList.toggle('is-active', button.dataset.color?.toLowerCase() === selected);
    });
    setVariableColor(this.panel, selected);
  }

  getDraftSchema() {
    const fields = this.fields;
    if (!fields) return null;
    const result = buildVariableSchemaDraft({
      key: fields.key?.value,
      valueRaw: this.pendingValue,
      type: fields.type?.value,
      defaultRaw: fields.def?.value,
      minRaw: fields.min?.value,
      maxRaw: fields.max?.value,
      optionsRaw: fields.options?.value,
      display: fields.display?.value,
      color: fields.color?.value,
      format: fields.format?.value,
    });
    return result.ok ? result.schema : {
      ...(this.existingSchema || {}),
      type: fields.type?.value || 'string',
      range: {
        min: fields.min?.value === '' ? null : Number(fields.min?.value),
        max: fields.max?.value === '' ? null : Number(fields.max?.value),
      },
      options: String(fields.options?.value || '').split(',').map(item => item.trim()).filter(Boolean),
      ui: {
        display: fields.display?.value || 'card',
        color: fields.color?.value || '',
        format: fields.format?.value || '',
      },
    };
  }

  commitValue(value, { announceError = false } = {}) {
    const type = String(this.fields?.type?.value || this.existingSchema?.type || 'string');
    const parsed = typeof value === 'string'
      ? parseVariableEditorValue(value, type)
      : { ok: true, value };
    if (!parsed.ok) {
      setText(this.fields?.valueError, parsed.error);
      setHidden(this.fields?.valueError, false);
      if (announceError) notify('warning', parsed.error);
      return false;
    }
    setHidden(this.fields?.valueError, true);
    this.pendingValue = cloneValue(parsed.value);
    const key = String(this.fields?.key?.value || this.currentKey || '').trim();
    if (this.mode !== 'create' && key) {
      this.setVariable(key, cloneValue(parsed.value));
      this.onChange({ kind: 'value', key, value: cloneValue(parsed.value) });
    }
    this.renderPreview();
    return true;
  }

  renderValueEditor() {
    const documentRef = globalThis.document;
    const target = this.fields?.valueEditor;
    if (!documentRef || !target) return;
    target.replaceChildren();
    const schema = this.getDraftSchema() || this.existingSchema || {};
    const type = String(this.fields?.type?.value || schema?.type || 'string');

    if (type === 'number') {
      const wrapper = documentRef.createElement('div');
      wrapper.className = 'variable-number-editor';
      const minus = documentRef.createElement('button');
      minus.type = 'button';
      minus.className = 'variable-icon-button';
      minus.textContent = '−';
      const slider = documentRef.createElement('input');
      slider.type = 'range';
      slider.className = 'variable-range-input';
      const min = Number(schema?.range?.min ?? 0);
      const max = Number(schema?.range?.max ?? 100);
      slider.min = Number.isFinite(min) ? String(min) : '0';
      slider.max = Number.isFinite(max) && max > min ? String(max) : '100';
      slider.step = '1';
      slider.value = Number.isFinite(Number(this.pendingValue)) ? String(this.pendingValue) : slider.min;
      const plus = documentRef.createElement('button');
      plus.type = 'button';
      plus.className = 'variable-icon-button';
      plus.textContent = '+';
      const number = documentRef.createElement('input');
      number.type = 'number';
      number.className = 'variable-input variable-number-input';
      number.value = this.pendingValue === '' ? '' : String(this.pendingValue);
      const commitNumber = (next) => {
        if (!this.commitValue(String(next))) return;
        const value = String(this.pendingValue);
        number.value = value;
        slider.value = value || slider.min;
      };
      minus.addEventListener('click', () => commitNumber((Number(this.pendingValue) || 0) - 1));
      plus.addEventListener('click', () => commitNumber((Number(this.pendingValue) || 0) + 1));
      slider.addEventListener('input', () => commitNumber(slider.value));
      number.addEventListener('input', () => commitNumber(number.value));
      wrapper.appendChild(minus);
      wrapper.appendChild(slider);
      wrapper.appendChild(plus);
      wrapper.appendChild(number);
      target.appendChild(wrapper);
      return;
    }

    if (type === 'enum') {
      const wrapper = documentRef.createElement('div');
      wrapper.className = 'variable-enum-editor';
      const options = Array.isArray(schema?.options) ? schema.options : [];
      options.forEach((option) => {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = `variable-enum-option${String(this.pendingValue) === String(option) ? ' is-active' : ''}`;
        button.textContent = String(option);
        button.addEventListener('click', () => {
          this.commitValue(String(option));
          this.renderValueEditor();
        });
        wrapper.appendChild(button);
      });
      if (!options.length) {
        const empty = documentRef.createElement('span');
        empty.className = 'variable-editor-empty';
        empty.textContent = '先在下方添加枚举选项';
        wrapper.appendChild(empty);
      }
      target.appendChild(wrapper);
      return;
    }

    if (type === 'boolean') {
      const wrapper = documentRef.createElement('div');
      wrapper.className = 'variable-boolean-editor';
      [true, false].forEach((value) => {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = `variable-enum-option${this.pendingValue === value ? ' is-active' : ''}`;
        button.textContent = value ? 'true' : 'false';
        button.addEventListener('click', () => {
          this.commitValue(value);
          this.renderValueEditor();
        });
        wrapper.appendChild(button);
      });
      target.appendChild(wrapper);
      return;
    }

    const textarea = documentRef.createElement('textarea');
    textarea.className = 'variable-input variable-value-textarea';
    textarea.placeholder = type === 'array' || type === 'object' ? '输入 JSON' : '输入变量内容';
    textarea.value = formatVariableSchemaInputValue(this.pendingValue);
    const autoGrow = () => {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(220, Math.max(92, textarea.scrollHeight || 92))}px`;
    };
    textarea.addEventListener('input', () => {
      autoGrow();
      this.commitValue(textarea.value);
    });
    target.appendChild(textarea);
    globalThis.requestAnimationFrame?.(autoGrow);
  }

  renderPreview() {
    const documentRef = globalThis.document;
    const target = this.fields?.preview;
    if (!documentRef || !target) return;
    target.replaceChildren();
    const schema = this.getDraftSchema() || this.existingSchema || {};
    const display = String(schema?.ui?.display || 'card');
    const key = String(this.fields?.key?.value || this.currentKey || '变量');
    const valueText = formatVariableDisplayValue(this.pendingValue);
    const rendered = String(schema?.ui?.format || '').trim()
      ? String(schema.ui.format).replace(/\{value\}/g, valueText)
      : valueText;
    setText(this.fields?.formatPreview, rendered || '—');
    setVariableColor(this.panel, schema?.ui?.color);

    const preview = documentRef.createElement('div');
    preview.className = `variable-status-preview is-${display}`;
    const label = documentRef.createElement('span');
    label.className = 'variable-status-preview-label';
    label.textContent = key;
    const value = documentRef.createElement('strong');
    value.className = 'variable-status-preview-value';
    value.textContent = rendered || '（空）';
    preview.appendChild(label);
    preview.appendChild(value);

    if (display === 'progress') {
      const track = documentRef.createElement('span');
      track.className = 'variable-inspector-progress-track';
      const fill = documentRef.createElement('span');
      fill.className = 'variable-inspector-progress-fill';
      fill.style.setProperty('--variable-progress', `${getVariablePercent(this.pendingValue, schema)}%`);
      track.appendChild(fill);
      preview.appendChild(track);
    }
    if (display === 'ring') {
      const namespace = 'http://www.w3.org/2000/svg';
      const svg = documentRef.createElementNS?.(namespace, 'svg') || documentRef.createElement('svg');
      svg.classList.add('variable-inspector-preview-ring');
      svg.setAttribute('viewBox', '0 0 72 72');
      svg.setAttribute('aria-label', `${getVariablePercent(this.pendingValue, schema)}%`);
      const track = documentRef.createElementNS?.(namespace, 'circle') || documentRef.createElement('circle');
      track.setAttribute('cx', '36');
      track.setAttribute('cy', '36');
      track.setAttribute('r', '29');
      track.classList.add('variable-ring-track');
      const fill = documentRef.createElementNS?.(namespace, 'circle') || documentRef.createElement('circle');
      fill.setAttribute('cx', '36');
      fill.setAttribute('cy', '36');
      fill.setAttribute('r', '29');
      fill.classList.add('variable-ring-fill');
      fill.style.setProperty('--variable-ring-offset', String(182.22 * (1 - getVariablePercent(this.pendingValue, schema) / 100)));
      svg.appendChild(track);
      svg.appendChild(fill);
      preview.appendChild(svg);
    }
    target.appendChild(preview);
  }

  show({ key = '', value = undefined, schema = null, mode = 'create' } = {}) {
    this.ensure();
    const fields = this.fields;
    if (!fields || !this.overlay) return;
    const name = String(key || '').trim();
    this.currentKey = name;
    this.mode = mode === 'create' ? 'create' : 'edit';
    this.existingSchema = cloneValue(schema || this.getSchema(name) || {});
    const currentValue = value !== undefined ? value : this.getValue(name);
    this.pendingValue = cloneValue(currentValue ?? '');
    this.initialValue = this.getInitialValue(name);
    if (this.initialValue === undefined && this.existingSchema?.default !== undefined) {
      this.initialValue = cloneValue(this.existingSchema.default);
    }
    const valueOnly = this.isGlobalScope() || this.isNestedPath(name);

    fields.key.value = name;
    fields.key.disabled = this.mode !== 'create';
    fields.type.value = this.existingSchema?.type || inferVariableEditorType(currentValue);
    fields.def.value = formatVariableSchemaInputValue(this.existingSchema?.default);
    fields.min.value = this.existingSchema?.range?.min ?? '';
    fields.max.value = this.existingSchema?.range?.max ?? '';
    fields.options.value = Array.isArray(this.existingSchema?.options)
      ? this.existingSchema.options.join(', ')
      : '';
    fields.display.value = this.existingSchema?.ui?.display || 'card';
    fields.color.value = this.existingSchema?.ui?.color || '';
    fields.colorNative.value = isHexColor(fields.color.value) ? fields.color.value : VARIABLE_COLOR_PRESETS[0];
    fields.format.value = this.existingSchema?.ui?.format || '';
    setText(fields.initialValue, formatInitialValue(this.initialValue));
    fields.restore.disabled = this.initialValue === undefined;
    fields.delete.hidden = this.mode === 'create';
    fields.schemaConfig.hidden = valueOnly;
    fields.draftNote.hidden = valueOnly;
    fields.save.textContent = valueOnly ? '保存变量' : '保存配置';

    this.updateIdentity();
    this.updateImpact();
    this.updateTypeUI();
    this.updateDisplayPicker();
    this.updateColorPicker();
    this.renderValueEditor();
    this.renderPreview();
    const visibilityRevision = ++this.visibilityRevision;
    this.overlay.style.display = '';
    globalThis.requestAnimationFrame?.(() => {
      if (
        this.visibilityRevision === visibilityRevision
        && this.overlay?.style?.display !== 'none'
      ) {
        this.overlay.classList?.add?.('is-open');
      }
    });
    globalThis.setTimeout?.(() => fields.key?.focus?.(), 0);
  }

  hide() {
    if (!this.overlay) return;
    this.visibilityRevision += 1;
    this.overlay.classList?.remove?.('is-open');
    const finish = () => {
      if (this.overlay && !this.overlay.classList?.contains?.('is-open')) {
        this.overlay.style.display = 'none';
      }
    };
    if (
      globalThis.document?.body?.dataset?.reducedMotion === 'on'
      || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    ) {
      finish();
      return;
    }
    globalThis.setTimeout?.(finish, 360);
  }

  isVisible() {
    return Boolean(this.overlay && this.overlay.style.display !== 'none');
  }

  copyReference() {
    const key = String(this.fields?.key?.value || this.currentKey || '').trim();
    if (!key) return;
    const reference = `{{getvar::${key}}}`;
    globalThis.navigator?.clipboard?.writeText?.(reference)
      ?.then?.(() => notify('success', '变量引用已复制'))
      ?.catch?.(() => notify('warning', '复制失败'));
  }

  restoreInitial() {
    const key = String(this.fields?.key?.value || this.currentKey || '').trim();
    if (!key || this.initialValue === undefined) return false;
    const value = cloneValue(this.initialValue);
    const restored = typeof this.restoreInitialValue === 'function'
      ? this.restoreInitialValue(key, value)
      : this.setVariable(key, value);
    if (restored === false) return false;
    this.pendingValue = cloneValue(value);
    this.onChange({ kind: 'restore', key, value: cloneValue(value) });
    this.renderValueEditor();
    this.renderPreview();
    notify('success', '已恢复初始值');
    return true;
  }

  save() {
    const fields = this.fields;
    if (!fields) return false;
    const { sid } = this.getContext();
    if (!sid) {
      notify('warning', '请先进入聊天室');
      return false;
    }
    const result = buildVariableSchemaDraft({
      key: fields.key?.value,
      valueRaw: this.pendingValue,
      type: fields.type?.value,
      defaultRaw: fields.def?.value,
      minRaw: fields.min?.value,
      maxRaw: fields.max?.value,
      optionsRaw: fields.options?.value,
      display: fields.display?.value,
      color: fields.color?.value,
      format: fields.format?.value,
    });
    if (!result.ok) {
      notify('warning', result.error);
      return false;
    }
    const parsedValue = typeof this.pendingValue === 'string'
      ? parseVariableEditorValue(this.pendingValue, fields.type?.value || 'string')
      : { ok: true, value: this.pendingValue };
    if (!parsedValue.ok) {
      notify('warning', parsedValue.error);
      return false;
    }
    if (!this.isGlobalScope() && !this.isNestedPath(result.key)) {
      if (result.schema) {
        this.setSchema(result.key, mergeVariableSchemaDraft(this.existingSchema, result.schema));
      } else {
        this.deleteSchema(result.key);
      }
    }
    this.setVariable(result.key, cloneValue(parsedValue.value));
    this.onChange({
      kind: 'save',
      key: result.key,
      value: cloneValue(parsedValue.value),
      schema: result.schema,
    });
    this.hide();
    notify('success', this.mode === 'create' ? '变量已创建' : '变量配置已保存');
    return true;
  }

  removeVariable() {
    const key = String(this.fields?.key?.value || this.currentKey || '').trim();
    if (!key) return false;
    this.onDelete(key);
    this.hide();
    return true;
  }

  removeSchema() {
    const key = String(this.fields?.key?.value || this.currentKey || '').trim();
    if (!key) return false;
    this.deleteSchema(key);
    this.onChange({ kind: 'schema-delete', key });
    this.hide();
    return true;
  }
}
