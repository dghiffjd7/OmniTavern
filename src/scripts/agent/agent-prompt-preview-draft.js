import { SYSPROMPT_AGENT_PROMPT_MAPPINGS } from '../storage/agent-center-settings-store.js';

// Capture the already-rendered source without adding markers to provider text
// or evaluating macros for a second time. Only AC previews carry this metadata.
export const recordAgentPreviewPromptSource = (context, promptId, content) => {
  const meta=context?.meta;
  if (meta?.previewOnly !== true || !Array.isArray(meta.agentPromptSources) || !String(content || '').trim()) return;
  if (!SYSPROMPT_AGENT_PROMPT_MAPPINGS.some(mapping=>mapping.agentId===meta.agentPromptDraft?.agentId && mapping.promptId===promptId)) return;
  const fieldId=`agent:${promptId}`;
  if (!meta.agentPromptSources.some(source=>source.fieldId===fieldId)) meta.agentPromptSources.push({fieldId,content:String(content).trim()});
};

// Request-local overlay. Never install drafts into shared preset/config stores.
export const applyAgentPreviewPresetDraft = (preset, context = {}, presetId = null) => {
  const draft = context?.meta?.previewOnly === true ? context.meta.agentPromptDraft : null;
  if (!draft || !preset || typeof preset !== 'object') return preset;
  let result = preset;
  for (const mapping of SYSPROMPT_AGENT_PROMPT_MAPPINGS) {
    if (mapping.agentId !== draft.agentId) continue;
    const prompt = draft.prompts?.[mapping.promptId];
    if (!prompt) continue;
    if (presetId !== null && prompt.presetId && prompt.presetId !== presetId) throw new Error('此任务使用另一个预设配置，请切换到对应聊天室后编辑。');
    if (result === preset) result = { ...preset };
    if (typeof prompt.rules === 'string') result[mapping.rulesKey] = prompt.rules;
    if (typeof prompt.enabled === 'boolean') result[mapping.enabledKey] = prompt.enabled;
    for (const key of ['position','depth','role']) {
      const target = mapping[`${key}Key`];
      if (target && Number.isFinite(Number(prompt[key]))) result[target] = Math.trunc(Number(prompt[key]));
    }
  }
  return result;
};

export const applyAgentPreviewMemorySettings = (context, defaults = {}) => {
  const draft = context?.meta?.previewOnly === true ? context.meta.agentPromptDraft : null;
  if (draft?.agentId !== 'memory_table_agent') return context;
  const settings = draft.memorySettings || {}, meta = { ...context.meta };
  for (const [field,key] of Object.entries({ dataPosition:'memoryInjectPosition',dataDepth:'memoryInjectDepth',guidePosition:'memoryGuidePosition',guideDepth:'memoryGuideDepth' })) {
    if (settings[field] !== undefined) meta[key] = settings[field];
  }
  // Clearing a preset placement inherits the same general settings as a saved
  // configuration, including depth; it must not fall back to the table template.
  if (settings.dataPosition !== undefined && !String(settings.dataPosition || '').trim()) {
    meta.memoryInjectPosition = String(defaults.memoryInjectPosition || 'before_latest_user').trim();
    meta.memoryInjectDepth = Math.max(0, Math.trunc(Number(defaults.memoryInjectDepth) || 0));
  }
  return { ...context, meta };
};
