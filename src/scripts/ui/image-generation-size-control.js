import { translateUiText } from '../i18n/index.js';
import { normalizeImageGenerationSize, getImageGenerationSizeError } from './image-generation-params-utils.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const tr = text => escape(translateUiText(text));

// The value input remains the single data-param-key control, including preset choices.
// All listeners belong to the DOM subtree, so replacing/closing a panel needs no global cleanup.
export const imageGenerationSizeControlMarkup = (field, value, { selectClass = '', inputClass = '' } = {}) => {
  const size = normalizeImageGenerationSize(value);
  const custom = !field.options.some(option => option.value === size);
  return `<span class="image-size-control">
    <select class="${escape(selectClass)}" data-image-size-choice aria-label="${tr('尺寸')}">
      ${field.options.map(option => `<option value="${escape(option.value)}" ${option.value === size ? 'selected' : ''}>${tr(option.label)}</option>`).join('')}
      <option value="__custom__" ${custom ? 'selected' : ''}>${tr('自定义尺寸')}</option>
    </select>
    <input type="text" class="${escape(inputClass)} image-size-value" data-param-key="${escape(field.key)}" value="${escape(size)}" ${custom ? '' : 'hidden'} maxlength="32" autocomplete="off" aria-label="${tr('自定义尺寸')}" placeholder="3840 × 2160">
    <span class="image-size-error" role="status" aria-live="polite" hidden></span>
  </span>`;
};

export const bindImageGenerationSizeControl = (root) => {
  const select = root.querySelector('[data-image-size-choice]'), input = root.querySelector('.image-size-value');
  if (!select || !input || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  const error = root.querySelector('.image-size-error');
  let customDraft = select.value === '__custom__' ? input.value : '';
  const validate = () => {
    const message = translateUiText(getImageGenerationSizeError(input.value));
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', String(Boolean(message)));
    error.textContent = message; error.hidden = !message;
    return !message;
  };
  select.addEventListener('change', () => {
    const custom = select.value === '__custom__';
    input.hidden = !custom;
    input.value = custom ? customDraft : select.value;
    validate();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (custom) { input.focus(); input.select(); }
  });
  input.addEventListener('input', () => { if (!input.hidden) customDraft = input.value; validate(); });
  input.addEventListener('change', () => {
    if (validate()) input.value = normalizeImageGenerationSize(input.value);
    if (!input.hidden) customDraft = input.value;
  });
  validate();
};

export const createImageGenerationSizeControl = ({ field, value, controlClass, onChange, documentLike = document }) => {
  const holder = documentLike.createElement('div');
  holder.innerHTML = imageGenerationSizeControlMarkup(field, value, { selectClass: controlClass, inputClass: controlClass });
  const root = holder.firstElementChild;
  bindImageGenerationSizeControl(root);
  if (onChange) {
    const input = root.querySelector('.image-size-value');
    input.addEventListener('input', onChange);
    input.addEventListener('change', onChange);
  }
  return root;
};

export const validateImageGenerationSizeControls = (container, { report = true } = {}) => {
  for (const input of container?.querySelectorAll('.image-size-value') || []) {
    if (!input.checkValidity()) {
      if (report) { input.focus(); input.reportValidity(); }
      return false;
    }
  }
  return true;
};
