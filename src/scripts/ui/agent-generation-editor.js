import { t } from '../i18n/index.js';
import { changeAgentReasoningMode, getAgentReasoningControl, normalizeAgentGenerationSettings } from '../agent/agent-generation-settings.js';
import { createCustomSelectWrapper, bindCustomSelectButton, refreshCustomSelectButton } from './custom-select.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// Own only the generation fields. Typing never rebuilds the Agent's prompt/editor.
export const createAgentGenerationEditor = ({ host, getConfig, onChange, model = {} }) => {
  const doc = host.ownerDocument;
  const settings = () => normalizeAgentGenerationSettings(getConfig());
  const value = settings();
  host.innerHTML = `<div class="ac-builtin-settings">
    <span class="ac-source">${escape(t('仅用于此 Agent，与预设参数独立。'))}</span>
    <div class="ac-row"><label><span class="ac-label">${escape(t('思考模式'))}</span><select name="reasoningMode"></select></label>
      <label data-agent-effort><span class="ac-label">${escape(t('思考强度'))}</span><select name="reasoningEffort"></select></label></div>
    <span class="ac-source" data-agent-reasoning-hint></span>
    <div class="ac-row"><label><span class="ac-label">${escape(t('最大输出 Tokens'))}</span><input name="maxTokens" type="number" min="16" max="16000" step="1" inputmode="numeric" value="${value.maxTokens}"></label>
      <label><span class="ac-label">${escape(t('最长等待（秒）'))}</span><input name="timeoutSeconds" type="number" min="5" max="300" step="1" inputmode="numeric" value="${value.timeoutSeconds}"></label></div>
    <span class="ac-source" data-agent-budget-hint>${escape(t(getConfig().id === 'text_completion' || getConfig().inputOutput === 'suggestion'
      ? '思考会占用输出额度；增加额度不会延长显示的续写建议。' : '最大输出额度包含思考与最终结果。'))}</span>
  </div>`;
  const mode = host.querySelector('[name="reasoningMode"]'), effort = host.querySelector('[name="reasoningEffort"]');
  const tokens = host.querySelector('[name="maxTokens"]'), timeout = host.querySelector('[name="timeoutSeconds"]');
  const controls = new Map();
  for (const field of [mode, effort]) {
    const wrapper = createCustomSelectWrapper(field); field.replaceWith(wrapper); field.hidden = true; wrapper.prepend(field);
    const button = wrapper.querySelector('button'); controls.set(field, button);
    bindCustomSelectButton({ buttonEl: button, selectEl: field, fallback: t('请选择') });
    button.addEventListener('keydown', event => {
      if (button.disabled || event.altKey || event.ctrlKey || event.metaKey || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? field.options.length - 1
        : Math.max(0, Math.min(field.options.length - 1, field.selectedIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      if (index !== field.selectedIndex) { field.selectedIndex = index; field.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); }
    });
  }
  const options = (field, rows, selected) => {
    const markup = rows.map(row => `<option value="${escape(row.value)}">${escape(t(row.label))}</option>`).join('');
    if (field.dataset.options !== markup) { field.innerHTML = markup; field.dataset.options = markup; }
    field.value = selected;
    refreshCustomSelectButton(controls.get(field), field, t('请选择'));
  };
  const refresh = (syncNumbers = false) => {
    const state = settings(), capability = getAgentReasoningControl(model);
    options(mode, [{ value: 'off', label: capability.canDisable ? '关闭' : '不额外请求' },
      { value: 'on', label: '开启' }, { value: 'default', label: '模型默认' }], state.reasoningMode);
    const rows = capability.effortOptions;
    options(effort, rows, rows.some(item => item.value === state.reasoningEffort) ? state.reasoningEffort : 'auto');
    mode.disabled = !capability.supported; controls.get(mode).disabled = mode.disabled;
    const active = capability.supported && state.reasoningMode === 'on';
    effort.disabled = !active; controls.get(effort).disabled = effort.disabled;
    host.querySelector('[data-agent-effort]').hidden = !active;
    host.querySelector('[data-agent-reasoning-hint]').textContent = t(!model.model ? '选择模型后可设置思考。'
      : !capability.supported ? '暂未识别此模型的思考参数，将使用模型默认行为。'
        : capability.canDisable ? '思考强度按当前模型支持的选项发送。'
          : '不额外请求时使用模型自身行为；部分模型无法关闭思考。');
    tokens.min = state.reasoningMode === 'on' ? '2048' : '16';
    host.querySelector('[data-agent-budget-hint]').hidden = state.reasoningMode !== 'on';
    if (syncNumbers) { tokens.value = state.maxTokens; timeout.value = state.timeoutSeconds; }
  };
  const input = event => {
    event.stopPropagation();
    const field = event.target;
    if (![tokens, timeout].includes(field) || !field.validity.valid || field.value === '') return;
    onChange({ [field.name]: Number(field.value) });
  };
  const change = event => {
    event.stopPropagation();
    const field = event.target;
    if (field === mode) onChange(changeAgentReasoningMode({ ...getConfig(), ...settings() }, field.value));
    else if (field === effort) onChange({ reasoningEffort: field.value });
    else if ([tokens, timeout].includes(field)) onChange(normalizeAgentGenerationSettings({ ...getConfig(), [field.name]: field.value }));
    refresh(true);
  };
  host.addEventListener('input', input); host.addEventListener('change', change);
  refresh();
  return { updateModel: value => { model = value || {}; refresh(); },
    dispose: () => { host.removeEventListener('input', input); host.removeEventListener('change', change); } };
};
