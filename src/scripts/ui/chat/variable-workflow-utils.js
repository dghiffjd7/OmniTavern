import { hasStatusPlaceholderDisplayRule } from './update-variable-session-utils.js';
import { getExpressionCompatibilityDiagnostic } from '../../variables/expression-compat-diagnostics.js';

const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const entries = value => Object.entries(record(value)).filter(([key]) => key && !key.startsWith('__'));
const hasValue = value => value != null && (typeof value !== 'object' || Object.values(value).some(hasValue));
const UPDATE_CONTRACT = /<\s*\/?\s*(?:UpdateVariable|variableupdate|json_patch)\b|\b_\.(?:set|add|assign|remove|insert)\s*\(|\b(?:JSONPatch|JSON\s*Patch)\b/i;
const AUTOMATIC_TRIGGERS = new Set(['every_turn', 'every_n_turns', 'keyword', 'condition']);
const WRITING_ACTIONS = new Set(['set_value', 'increment', 'decrement', 'toggle', 'push', 'remove', 'ai_evaluate']);

// 判断当前角色实际拥有的更新能力。全局变量、预览工具开关和显示占位符均不能单独启用此节点。
export const resolveVariableWorkflowActivity = ({
  runtimeEnabled = true, persona = null, variables = {}, schemas = {}, rules = [], stageSchema = null,
  regexRules = [], promptSources = [],
} = {}) => {
  const variableEntries = entries(variables).filter(([, value]) => hasValue(value));
  const schemaEntries = entries(schemas).filter(([, schema]) => schema && (schema.type !== 'object' || hasValue(schema.default)));
  const names = new Set([...variableEntries, ...schemaEntries].map(([name]) => name));
  const hasVariables = names.size > 0;
  const source = record(persona?.source);
  const isCard = source.type === 'character_card';
  const mvuSource = String(source.mvuSource || '').trim().toLowerCase();
  const isMvu = isCard && (source.mvuConverted === true || Boolean(mvuSource && mvuSource !== 'none'));
  const hasPlaceholder = isCard && hasStatusPlaceholderDisplayRule(regexRules);
  const sourceTexts = [persona?.description, persona?.personality, persona?.scenario, persona?.systemPrompt, persona?.postHistoryInstructions, ...promptSources];
  const hasInlineContract = sourceTexts.some(text => UPDATE_CONTRACT.test(String(text || '')));
  const inline = hasVariables && hasInlineContract;
  const automaticRules = (Array.isArray(rules) ? rules : []).filter(Boolean).map(rule => ({
    ...rule,
    trigger: { ...rule.trigger, type: String(rule.trigger?.type || 'every_turn').trim().toLowerCase() },
    action: { ...rule.action, type: String(rule.action?.type || '').trim().toLowerCase() },
  })).filter(rule => {
    if (rule.enabled === false || !AUTOMATIC_TRIGGERS.has(rule.trigger.type)) return false;
    const action = rule.action || {}, target = String(action.target || '').trim();
    if (!WRITING_ACTIONS.has(action.type) || !target || ![...names].some(name => target === name || target.startsWith(`${name}.`) || target.startsWith(`${name}[`))) return false;
    if (action.type === 'ai_evaluate' && !String(action.prompt || '').trim()) return false;
    if (rule.trigger.type === 'every_n_turns' && !Number.isFinite(Number(rule.trigger.n))) return false;
    if (rule.trigger.type === 'keyword' && !(Array.isArray(rule.trigger.keywords) ? rule.trigger.keywords : String(rule.trigger.keywords || '').split(',')).some(key => String(key || '').trim())) return false;
    if (rule.trigger.type === 'condition' && (!String(rule.trigger.expr || '').trim() || getExpressionCompatibilityDiagnostic(rule.trigger.expr))) return false;
    return true;
  });
  const available = hasVariables && (inline || automaticRules.some(rule => rule.action.type === 'ai_evaluate'));
  const stVariables = hasVariables && isCard && (isMvu || hasPlaceholder || inline);
  const kinds = stVariables ? ['st'] : hasVariables ? ['app'] : [];
  if (stVariables && automaticRules.length) kinds.push('app');
  const updateModes = [];
  if (inline) updateModes.push('inline');
  if (automaticRules.some(rule => rule.action.type === 'ai_evaluate')) updateModes.push('model_rule');
  if (automaticRules.some(rule => rule.action.type !== 'ai_evaluate')) updateModes.push('local_rule');
  const effects = [];
  if (available) effects.push('values');
  if (available && (hasPlaceholder || schemaEntries.some(([, schema]) => schema.ui?.display !== 'hidden'))) effects.push('display');
  if (available && stageSchema?.stages?.some(stage => stage.condition && (stage.prompt || stage.persona || stage.worldbook))) effects.push('stage');
  if (available && sourceTexts.some(text => /\b(?:getvar|getvarraw|getvarstat|stat_data|variables\.)\b/i.test(String(text || '')))) effects.push('prompt');
  const reason = !hasVariables ? 'no_variables' : !available ? 'no_variable_updates' : runtimeEnabled === false ? 'variable_runtime_disabled' : '';
  return { enabled: available && runtimeEnabled !== false, available, runtimeEnabled: runtimeEnabled !== false,
    reason, kinds, updateModes, effects, variableCount: names.size, ruleCount: automaticRules.length, hasPlaceholder,
    rulePhases: available ? ['before', 'after'].filter(phase => automaticRules.some(rule => (rule.trigger.type === 'keyword' ? 'before' : 'after') === phase)) : [],
  };
};

export const createVariableWorkflowResolver = ({ chatStore, getEffectivePersona, listActiveRegexRules, listPromptSources, isVariableRuntimeEnabled } = {}) => (sessionId, options = {}) => {
  const sid = String(sessionId || '').trim();
  return resolveVariableWorkflowActivity({
    persona: getEffectivePersona?.(sid), runtimeEnabled: isVariableRuntimeEnabled?.(sid) !== false,
    variables: chatStore?.listVariables?.(sid), schemas: chatStore?.listVariableSchemas?.(sid),
    rules: chatStore?.listVariableRules?.(sid), stageSchema: chatStore?.getStageSchema?.(sid),
    regexRules: listActiveRegexRules?.(sid), promptSources: listPromptSources?.(sid, options) || [],
  });
};

export const collectVariableWorkflowPromptSources = (worlds = []) => worlds.flatMap(world => {
  const source = world?.entries || world?.data?.entries || [];
  return (Array.isArray(source) ? source : Object.values(record(source)))
    .filter(entry => entry && entry.disable !== true && entry.disabled !== true && entry.enabled !== false)
    .map(entry => String(entry.content || ''));
});

// 只读取已启用预设的实际提示词字段，跳过目录中未选用/已停用的区块。
export const collectVariableWorkflowPresetSources = ({ sysprompt = {}, openai = {} } = {}) => {
  const blocks = Array.isArray(openai.prompt_order) ? openai.prompt_order : [];
  const selected = blocks.find(block => String(block?.character_id) === '100001') || blocks.find(block => String(block?.character_id) === '100000') || blocks[0];
  const order = Array.isArray(selected?.order) ? selected.order : null;
  const prompts = Array.isArray(openai.prompts) ? openai.prompts : [];
  const byId = new Map(prompts.map(prompt => [prompt?.identifier, prompt]));
  const texts = [sysprompt.post_history];
  if (order?.length) {
    for (const item of order) {
      if (!item?.identifier || item.enabled === false) continue;
      const prompt = byId.get(item.identifier);
      if (item.identifier === 'main') texts.push(prompt?.content || sysprompt.content);
      else if (!prompt?.marker) texts.push(prompt?.content);
    }
  } else texts.push(sysprompt.content);
  if (sysprompt.dialogue_enabled === true && Number(sysprompt.dialogue_position) !== -1) texts.push(sysprompt.dialogue_rules);
  return texts.filter(text => typeof text === 'string' && text.trim());
};
