// 总开关与调用方式独立。旧回复 Agent 的自动模式同时有手动入口，迁移时保留该能力。
export const isInputAgent = config => ['input_suggestion', 'input_agent'].includes(config?.kind)
  || config?.id === 'text_completion' || String(config?.id || '').startsWith('input-agent:');
export const getAgentInvocationMode = (config = {}) => ['auto', 'manual', 'both'].includes(config.invocationMode)
  ? config.invocationMode : config.triggerMode === 'manual' ? 'manual' : isInputAgent(config) ? 'auto' : 'both';
export const allowsAgentInvocation = (config, invocation = 'auto') => config?.enabled === true
  && (invocation === 'manual' ? getAgentInvocationMode(config) !== 'auto' : getAgentInvocationMode(config) !== 'manual');
export const agentInvocationLabel = config => ({ auto: '自动', manual: '手动', both: '自动＋手动' })[getAgentInvocationMode(config)];

// 所有输入自动任务共用窗口预算；显式手动调用只受并发和去重约束。
export const createInputRequestBudget = ({ maxPerMinute = 12, now = Date.now } = {}) => {
  let recent = [], context = '';
  return { take: key => {
    if (key !== context) { context = key; recent = []; }
    recent = recent.filter(at => now() - at < 60000);
    if (recent.length >= maxPerMinute) return false;
    recent.push(now()); return true;
  } };
};

// 需要独立模型配置才能开启的 Agent（小管家、正文评分、输入助手）。编辑器保存与卡片开关共用，
// 避免从卡片开启后显示“已开启”却因缺模型而从不运行。满足时返回空字符串。
export const agentIndependentModelRequirement = (config = {}) => {
  if (config?.enabled !== true || config.modelMode === 'profile' && String(config.modelProfileId || '').trim()) return '';
  if (['archive_naming', 'reply_scoring'].includes(config.kind)) return '请选择独立模型配置';
  if (isInputAgent(config)) return '输入建议请选择独立模型配置';
  return '';
};
