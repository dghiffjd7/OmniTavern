import { mountAgentRequestPreview } from './chat/agent-request-preview.js';
import { t } from '../i18n/index.js';
import { saveCatalogPromptField } from './agent-prompt-field-save.js';

export const readAgentCenterPromptDraft = (root, agentId) => {
  const draft = { agentId, prompts: {} };
  for (const editor of root.querySelectorAll('[data-agent-prompt-editor]')) {
    if (editor.dataset.agentId !== agentId) continue;
    const prompt = { rules: editor.querySelector('[data-agent-prompt-rules]').value,
      enabled: editor.querySelector('[data-agent-prompt-enabled]').checked,
      presetId: editor.dataset.agentPromptPresetId };
    for (const key of ['position', 'depth', 'role']) {
      const field = editor.querySelector(`[data-agent-prompt-${key}]`);
      if (field) prompt[key] = Number(field.value);
    }
    draft.prompts[editor.dataset.agentPromptEditor] = prompt;
  }
  const memory = root.querySelector('[data-memory-agent-editor]');
  if (agentId === 'memory_table_agent' && memory) {
    draft.templateId = memory.dataset.memoryAgentTemplateId;
    for (const key of ['template', 'wrapper', 'position']) draft[key] = memory.querySelector(`[data-memory-prompt-${key}]`)?.value ?? '';
    draft.promptFields = Object.fromEntries([...memory.querySelectorAll('[data-memory-prompt-field]')].map(field => [field.dataset.memoryPromptField, field.value]));
    draft.memorySettings = Object.fromEntries(['dataPosition', 'dataDepth', 'guidePosition', 'guideDepth'].map(key => {
      const attribute = key.replace(/[A-Z]/g, part => `-${part.toLowerCase()}`);
      const value = memory.querySelector(`[data-memory-${attribute}]`)?.value;
      return [key, key.endsWith('Depth') ? Math.max(0, Number(value) || 0) : value || ''];
    }));
  }
  draft.task = root.querySelector('[data-agent-preview-task]')?.value || '';
  draft.momentId = root.querySelector('[data-agent-preview-moment]')?.value || '';
  return draft;
};

export const captureAgentPromptDraft = root => [...root.querySelectorAll('input, textarea, select')].map(field => ({field,value:field.value,checked:field.checked}));

export const markAgentPromptDraftSaved = (root, snapshot = captureAgentPromptDraft(root)) => {
  for (const {field,value,checked} of snapshot) {
    if (!root.contains(field)) continue;
    if (field.type === 'checkbox') field.defaultChecked = checked;
    else if (field.tagName === 'SELECT') for (const option of field.options) option.defaultSelected = option.value===value;
    else field.defaultValue = value;
  }
  root.dispatchEvent(new root.ownerDocument.defaultView.Event('agent-prompt-baseline-changed',{bubbles:true}));
};

export const mountAgentCenterPromptWorkspace = ({ host, agentId, actions, buildRequest, savedState, onOpenSource } = {}) => {
  const preview = mountAgentRequestPreview({ host, savedState,
    saveField:options=>saveCatalogPromptField({actions,agentId,...options}),
    buildRequest: () => {
      const draft = readAgentCenterPromptDraft(host, agentId);
      return buildRequest ? buildRequest(draft) : actions.buildAgentPromptPreview?.({ agentId, draft });
    },
  });
  const sourceClick = event => {
    const target = event.target.closest('[data-agent-context-source]');
    if (target) { preview?.close(); onOpenSource?.(target.dataset.agentContextSource); }
  };
  host.addEventListener('click', sourceClick);
  return { ...preview, dispose: () => { host.removeEventListener('click', sourceClick); preview?.dispose(); } };
};

export const renderAgentPromptBoundary = escapeHtml => `<div class="agent-prompt-boundary">
  <span>${escapeHtml(t('两侧可编辑此 Agent 的提示词，保存后生效。'))}</span>
  <span>${escapeHtml(t('预设、聊天记录与表格值按当前会话读取。'))}</span>
  <div class="agent-center-card-actions"><button type="button" class="agent-center-card-action" data-agent-context-source="preset">${escapeHtml(t('提示词组装'))}</button><button type="button" class="agent-center-card-action" data-agent-context-source="session">${escapeHtml(t('聊天室设置'))}</button></div>
</div>`;
