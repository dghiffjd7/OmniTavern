import { t } from '../../i18n/index.js';

// Only fields owned by this editor enter the preview's write contract. Context,
// presets, message bodies and memory rows never become writable by text matching.
export const getAgentPromptFields = root => {
  if (!root) return [];
  const fields = [];
  const add = (element, id, label) => {
    if (!element || element.disabled || element.matches?.(':disabled') || element.readOnly) return;
    fields.push({ id, label, value: element.value, element });
  };
  add(root.querySelector('[name="prompt"]'), 'prompt', t('任务要求'));
  add(root.querySelector('[name="formatGuide"]'), 'formatGuide', t('格式要求'));
  root.querySelectorAll('[name^="blocks."][name$=".text"]').forEach(element => {
    const prefix = element.name.slice(0, -5);
    add(element, element.name, root.querySelector(`[name="${prefix}.name"]`)?.value || t('自定义区块'));
  });
  root.querySelectorAll('[data-agent-prompt-editor]').forEach(editor => {
    add(editor.querySelector('[data-agent-prompt-rules]'), `agent:${editor.dataset.agentPromptEditor}`,
      editor.querySelector('.agent-center-agent-check span')?.textContent || t('提示词'));
  });
  root.querySelectorAll('[data-memory-prompt-field]').forEach(element => {
    add(element, `memory:${element.dataset.memoryPromptField}`, element.getAttribute('aria-label') || t('记忆提示词'));
  });
  add(root.querySelector('[data-memory-prompt-template]'), 'memory:template', t('表格内容模板'));
  add(root.querySelector('[data-memory-prompt-wrapper]'), 'memory:wrapper', t('包裹模板'));
  return fields;
};

export const writeAgentPromptField = (fields, id, value) => {
  const field = fields.find(item => item.id === id);
  if (!field?.element?.isConnected || field.element.disabled || field.element.matches?.(':disabled') || field.element.readOnly) return false;
  if (field.element.value === value) return true;
  field.element.value = String(value);
  const Event = field.element.ownerDocument.defaultView.Event;
  field.element.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
};

export const getRequestPromptFieldIds = (section, fields) => {
  const allowed = new Set(fields.map(field => field.id));
  return [...new Set([section?.editField, ...(section?.editFields || [])].filter(id => allowed.has(id)))];
};
