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
