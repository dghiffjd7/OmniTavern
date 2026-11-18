// 生成对话框「高级参数」（只覆盖本次）的字段：分组卡片＋按字段类型挑控件，覆盖过的项目标出并可单项恢复。
// 每个字段仍只有一个带 data-param-key 的元素承载当前值（调用方照旧读它）；分段按钮与 −／＋ 只是改这个值并发 input 事件。
import { translateUiText } from '../i18n/index.js';
import { createImageGenerationSizeControl } from './image-generation-size-control.js';

// 字段分组（没列到的归「其他」）
const GROUPS = [
  { id: 'canvas', title: '画面', keys: ['size', 'width', 'height', 'aspectRatio', 'quality', 'style', 'style_preset', 'n'] },
  { id: 'sampling', title: '生成', keys: ['steps', 'scale', 'cfg_scale', 'guidance_scale', 'cfgRescale', 'sampler', 'sampler_name', 'scheduler', 'seed', 'qualityToggle', 'sm', 'sm_dyn', 'decrisper', 'enable_hr', 'restore_faces', 'enhance'] },
  { id: 'reference', title: '精准参考', keys: ['preciseReference', 'preciseReferenceStrength', 'preciseReferenceFidelity'] },
  { id: 'output', title: '输出', keys: ['output_format', 'output_compression', 'outputCompression', 'background', 'responseMimeType', 'response_format', 'partial_images', 'moderation', 'disable_safety_checker'] },
];
const OTHER_GROUP = { id: 'other', title: '其他' };
const COMPRESSION_KEYS = ['output_compression', 'outputCompression'];

const tr = text => translateUiText(String(text ?? ''));
const groupOf = key => GROUPS.find(group => group.keys.includes(key)) || OTHER_GROUP;

/** 选项少、文字短的用分段按钮；0～1 的小数用滑杆；生成张数用 −／＋；其余照原本的下拉框与输入框。 */
export const resolveAdvancedControlKind = (field = {}) => {
  if (field.type === 'image-size') return 'size';
  if (field.type === 'select') {
    const options = Array.isArray(field.options) ? field.options : [];
    const short = options.every(option => [...String(option.label ?? option.value ?? '')].length <= 6);
    return options.length >= 2 && options.length <= 4 && short ? 'segmented' : 'select';
  }
  if (field.type === 'number') {
    if (field.key === 'n') return 'stepper';
    if (field.integer === false && Number(field.max) - Number(field.min) <= 1) return 'slider';
    return 'number';
  }
  return 'text';
};

/** 数字照字段规则整理：整数字段取整，小数字段保留小数；夹在 min／max 之间。 */
export const normalizeAdvancedNumber = (field = {}, value) => {
  const raw = Number(value);
  if (!Number.isFinite(raw) || String(value ?? '').trim() === '') return Number(field.defaultValue || 0);
  const number = field.integer === false ? raw : Math.trunc(raw);
  const min = Number.isFinite(Number(field.min)) ? Number(field.min) : -Infinity;
  const max = Number.isFinite(Number(field.max)) ? Number(field.max) : Infinity;
  return Math.min(max, Math.max(min, number));
};

const formatNumber = value => String(Number(value)).replace(/(\.\d{2})\d+$/, '$1');

/**
 * 画字段。values：预设＋本次覆盖后的值；base：预设值（判断有没有覆盖、单项恢复用）；
 * onChange()：任何字段改动后调用（调用方读 data-param-key 重算覆盖，再调 refresh）。
 * 返回 { refresh }：重画覆盖标记、压缩质量的显示与透明背景时的 JPEG 限制。
 */
export const renderImageGenerationAdvancedFields = ({
  documentRef = globalThis.document,
  container,
  fields = [],
  values = {},
  base = {},
  onChange = () => {},
} = {}) => {
  const doc = documentRef;
  const el = (tag, className = '', text = '') => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };
  const rows = new Map(); // key → { row, field, input, kind }
  const emit = (input) => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
    onChange();
  };
  const valueOf = field => (Object.prototype.hasOwnProperty.call(values, field.key) ? values[field.key] : field.defaultValue);
  const baseOf = field => (Object.prototype.hasOwnProperty.call(base, field.key) ? base[field.key] : field.defaultValue);

  const buildControl = (field, kind) => {
    const current = valueOf(field);
    if (kind === 'size') {
      const control = createImageGenerationSizeControl({ field, value: current, controlClass: 'chat-image-gen-param-field', onChange, documentLike: doc });
      return { control, input: control.querySelector?.('[data-param-key]') || null };
    }
    if (kind === 'select') {
      const select = el('select', 'chat-image-gen-param-field');
      (field.options || []).forEach((option) => {
        const node = el('option', '', tr(option.label ?? option.value));
        node.value = String(option.value ?? '');
        select.appendChild(node);
      });
      select.value = String(current ?? '');
      select.dataset.paramKey = field.key;
      select.addEventListener('change', onChange);
      return { control: select, input: select };
    }
    if (kind === 'segmented') {
      const group = el('div', 'igp-segmented');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', tr(field.label || field.key));
      const input = el('input');
      input.type = 'hidden';
      input.dataset.paramKey = field.key;
      input.value = String(current ?? '');
      (field.options || []).forEach((option) => {
        const button = el('button', 'igp-segment', tr(option.label ?? option.value));
        button.type = 'button';
        button.dataset.value = String(option.value ?? '');
        button.setAttribute('role', 'radio');
        button.addEventListener('click', () => {
          if (button.disabled || input.value === button.dataset.value) return;
          input.value = button.dataset.value;
          emit(input);
        });
        group.appendChild(button);
      });
      group.appendChild(input);
      return { control: group, input };
    }
    if (kind === 'slider') {
      const wrap = el('div', 'igp-slider');
      const input = el('input', 'igp-slider-input');
      input.type = 'range';
      input.min = String(field.min ?? 0);
      input.max = String(field.max ?? 1);
      input.step = String(field.step ?? 0.05);
      input.value = String(current ?? field.defaultValue ?? 0);
      input.dataset.paramKey = field.key;
      const readout = el('span', 'igp-slider-value', formatNumber(input.value));
      input.addEventListener('input', () => { readout.textContent = formatNumber(input.value); onChange(); });
      wrap.append(input, readout);
      return { control: wrap, input };
    }
    if (kind === 'stepper') {
      const wrap = el('div', 'igp-stepper');
      const input = el('input', 'chat-image-gen-param-field igp-stepper-value');
      input.type = 'number';
      if (field.min != null) input.min = String(field.min);
      if (field.max != null) input.max = String(field.max);
      input.value = String(current ?? field.defaultValue ?? 1);
      input.dataset.paramKey = field.key;
      const step = (delta) => {
        input.value = String(normalizeAdvancedNumber(field, Number(input.value || 0) + delta));
        emit(input);
      };
      const minus = el('button', 'igp-stepper-btn', '−');
      minus.type = 'button';
      minus.setAttribute('aria-label', tr('减少'));
      minus.addEventListener('click', () => step(-1));
      const plus = el('button', 'igp-stepper-btn', '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', tr('增加'));
      plus.addEventListener('click', () => step(1));
      input.addEventListener('input', onChange);
      wrap.append(minus, input, plus);
      return { control: wrap, input };
    }
    const input = el('input', 'chat-image-gen-param-field');
    input.type = kind === 'number' ? 'number' : 'text';
    if (kind === 'number') {
      if (field.min != null) input.min = String(field.min);
      if (field.max != null) input.max = String(field.max);
      if (field.step != null) input.step = String(field.step);
    }
    input.value = String(current ?? '');
    input.dataset.paramKey = field.key;
    input.addEventListener('input', onChange);
    input.addEventListener('change', onChange);
    return { control: input, input };
  };

  container.innerHTML = '';
  const sections = new Map();
  fields.forEach((field) => {
    const group = groupOf(field.key);
    if (!sections.has(group.id)) {
      const section = el('section', `igp-adv-group is-${group.id}`);
      section.appendChild(el('h4', 'igp-adv-group-title', tr(group.title)));
      sections.set(group.id, { section, order: group === OTHER_GROUP ? GROUPS.length : GROUPS.indexOf(group) });
    }
    const kind = resolveAdvancedControlKind(field);
    const row = el('div', `chat-image-gen-param-row igp-adv-row is-${kind}`);
    row.dataset.paramRow = field.key;
    const head = el('div', 'igp-adv-row-head');
    const label = el('div', 'chat-image-gen-param-label', tr(field.label || field.key));
    if (field.help) {
      label.classList.add('has-help');
      label.dataset.help = field.help;
      label.dataset.helpMode = 'tap';
    }
    const reset = el('button', 'igp-adv-reset', tr('恢复'));
    reset.type = 'button';
    reset.title = tr('恢复成参数预设的值');
    head.append(label, reset);
    const { control, input } = buildControl(field, kind);
    reset.addEventListener('click', () => {
      if (!input) return;
      input.value = String(baseOf(field) ?? '');
      if (kind === 'slider') control.querySelector('.igp-slider-value').textContent = formatNumber(input.value);
      if (kind === 'size') {
        // 尺寸是「预设下拉框＋数值框」：预设里有就选它，否则切到自定义
        const choice = control.querySelector('[data-image-size-choice]');
        if (choice) {
          choice.value = [...choice.options].some(option => option.value === input.value) ? input.value : '__custom__';
          input.hidden = choice.value !== '__custom__';
        }
      }
      emit(input);
    });
    row.append(head, control);
    rows.set(field.key, { row, field, input, kind, control });
    sections.get(group.id).section.appendChild(row);
  });
  [...sections.values()].sort((a, b) => a.order - b.order).forEach(({ section }) => container.appendChild(section));

  const refresh = () => {
    const format = rows.get('output_format')?.input?.value;
    const background = rows.get('background')?.input?.value;
    for (const { row, field, input, kind, control } of rows.values()) {
      if (!input) continue;
      // 透明背景不能用 JPEG
      if (field.key === 'output_format' && background === 'transparent' && input.value === 'jpeg') input.value = 'png';
      const value = kind === 'number' || kind === 'stepper' || kind === 'slider' ? normalizeAdvancedNumber(field, input.value) : input.value;
      row.classList.toggle('is-overridden', String(value) !== String(kind === 'number' || kind === 'stepper' || kind === 'slider' ? normalizeAdvancedNumber(field, baseOf(field)) : (baseOf(field) ?? '')));
      if (kind === 'segmented') {
        control.querySelectorAll('.igp-segment').forEach((button) => {
          const selected = button.dataset.value === input.value;
          button.classList.toggle('is-selected', selected);
          button.setAttribute('aria-checked', selected ? 'true' : 'false');
          button.disabled = field.key === 'output_format' && button.dataset.value === 'jpeg' && background === 'transparent';
        });
      }
      if (kind === 'select' && field.key === 'output_format') {
        const jpeg = input.querySelector('option[value="jpeg"]');
        if (jpeg) jpeg.disabled = background === 'transparent';
      }
      // 压缩质量只在 JPEG／WebP 时有用
      if (COMPRESSION_KEYS.includes(field.key)) row.hidden = Boolean(format) && format === 'png';
    }
  };
  refresh();
  return { refresh };
};
