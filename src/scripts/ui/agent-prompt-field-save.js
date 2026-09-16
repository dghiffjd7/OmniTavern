import { resolveBuiltinAgentTask } from '../agent/agent-builtin-defaults.js';
import { normalizePresetBlockText } from './preset-preview-utils.js';

export const readConfiguredPromptField = (config, fieldId, currentConfig = config) => {
  if (fieldId === 'prompt') return ['text_completion','reply_check'].includes(config.id) ? resolveBuiltinAgentTask(config,config.id) : config.prompt;
  if (fieldId === 'formatGuide') return config.formatGuide;
  const match = /^blocks\.(\d+)\.text$/.exec(fieldId);
  if (!match) return undefined;
  const block = currentConfig.blocks[Number(match[1])];
  return config.blocks.find(item => item.id === block?.id)?.text ?? '';
};

// Start from the saved configuration; other controls and other prompt hunks
// remain drafts. Block identity survives reorder/insert in the live editor.
export const patchConfiguredPromptField = (saved, current, fieldId, value) => {
  const next = structuredClone(saved);
  if (fieldId === 'prompt') {
    next.prompt = value;
    if (['text_completion','reply_check'].includes(next.id)) next.taskPromptMode = 'replace';
  } else if (fieldId === 'formatGuide') next.formatGuide = value;
  else {
    const match = /^blocks\.(\d+)\.text$/.exec(fieldId);
    const block = match && current.blocks[Number(match[1])];
    if (!block) throw new Error('提示词区块已变化，请重新打开');
    const existing = next.blocks.find(item => item.id === block.id);
    if (existing) existing.text = value;
    else next.blocks.push({ ...block, text:value });
  }
  return next;
};

export const saveCatalogPromptField = async ({ actions, agentId, field, value, baseValue }) => {
  const element = field.element;
  if (!element?.isConnected) return {ok:false};
  const changed = () => { throw new Error('提示词已在其他位置修改，请重新打开'); };
  if (field.id.startsWith('memory:')) {
    const editor = element.closest('[data-memory-agent-editor]');
    if (agentId !== 'memory_table_agent' || !editor) return {ok:false};
    const templateId = editor.dataset.memoryAgentTemplateId;
    const saved = await actions.getMemoryAgentPromptConfig();
    if (!element.isConnected || saved.templateId !== templateId) changed();
    const key = field.id.slice(7), direct = key === 'template' || key === 'wrapper';
    const previous = direct ? saved[key] : saved.fields.find(item => item.id === key)?.value;
    if (typeof previous !== 'string' || normalizePresetBlockText(previous) !== baseValue) changed();
    const config = direct ? { [key]:value } : { promptFields:{[key]:value} };
    const result = await actions.setMemoryAgentPromptConfig({templateId,config});
    return {ok:Boolean(result && result.ok !== false), value};
  }
  const editor = element.closest('[data-agent-prompt-editor]');
  if (!editor || editor.dataset.agentId !== agentId || field.id !== `agent:${editor.dataset.agentPromptEditor}`) return {ok:false};
  const profileType = editor.dataset.agentPromptProfileType || 'sysprompt', presetId = editor.dataset.agentPromptPresetId;
  const view = await actions.getAgentCenterProfileView();
  const promptId = editor.dataset.agentPromptEditor;
  const profile = view?.[profileType];
  if (!element.isConnected || profile?.presetId !== presetId || normalizePresetBlockText(profile.profile?.agents?.[agentId]?.prompts?.[promptId]?.rules ?? '') !== baseValue) changed();
  const result = await actions.setAgentPromptConfig({profileType,presetId,agentId,promptId,config:{rules:value}});
  return {ok:Boolean(result && result.ok !== false),value};
};
