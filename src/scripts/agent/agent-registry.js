// Phase B：统一 Agent Registry。来源：女仆 Sub-agent、可配置 Agent（文本／输入／格式修复等，含用户自建）、女仆技能。
// 职责边界（见架构计划 §2）：Registry 只持有 Agent 身份/能力标签/模型引用/委派约束等「声明」投影，
// 不绕过 Tool Registry 执行工具、不保存第二份 schema 真相、不做动态统计。
// 每条记录带 role 与 execution（由哪个运行时执行）；委派与 planner 只取 role = sub_agent，其他来源加入不改变女仆行为。

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const AGENT_CAPABILITY_KIND = 'agent';
export const WORKFLOW_CAPABILITY_KIND = 'workflow';
export const SUB_AGENT_ROLE = 'sub_agent';

// 统一 CapabilityRef：id + version + namespace + kind 必须唯一定位执行契约（此处为 Agent 身份）。
export const buildCapabilityRef = ({
  id = '',
  version = '1',
  namespace = 'builtin',
  kind = AGENT_CAPABILITY_KIND,
  provider = 'app',
  ref = '',
} = {}) => {
  const capId = trim(id);
  return {
    id: capId,
    version: trim(version, '1'),
    namespace: trim(namespace, 'builtin'),
    kind: trim(kind, AGENT_CAPABILITY_KIND),
    provider: trim(provider, 'app'),
    ref: trim(ref) || capId,
  };
};

// 唯一定位键：跨 provider 去重与快照引用用它，不用裸 id（不同 namespace 可同 id）。
export const capabilityRefKey = (ref = {}) => {
  const r = isPlainObject(ref) ? ref : {};
  return `${trim(r.namespace, 'builtin')}:${trim(r.kind, AGENT_CAPABILITY_KIND)}:${trim(r.id)}@${trim(r.version, '1')}`;
};

const SUB_AGENT_PROVIDER = 'maid-sub-agent';
const SUB_AGENT_NAMESPACE = 'user';

// 把一条女仆 Sub-agent 配置投影成统一 Agent capability 记录。
// 行为兼容关键：promptShape 必须与迁移前 planner 收到的 sub-agent 形状一致（id/name/skills/note/enabled）。
export const projectSubAgentCapability = (subAgent = {}) => {
  const src = isPlainObject(subAgent) ? subAgent : {};
  const id = trim(src.id);
  if (!id) return null;
  const name = trim(src.name) || id;
  const skills = (Array.isArray(src.skills) ? src.skills : []).map(s => trim(s)).filter(Boolean);
  const note = trim(src.note);
  const enabled = src.enabled !== false;
  const timeLimitSeconds = Number(src.timeLimitSeconds) > 0 ? Number(src.timeLimitSeconds) : 0;
  const maxOutputTokens = Number(src.maxOutputTokens) > 0 ? Number(src.maxOutputTokens) : 0;
  const modelProfileRef = trim(src.modelProfileId);
  const modelOverride = trim(src.modelOverride);
  return {
    ref: buildCapabilityRef({
      id,
      version: '1',
      namespace: SUB_AGENT_NAMESPACE,
      kind: AGENT_CAPABILITY_KIND,
      provider: SUB_AGENT_PROVIDER,
      ref: id,
    }),
    id,
    name,
    role: SUB_AGENT_ROLE,
    summary: note,
    enabled,
    provider: SUB_AGENT_PROVIDER,
    source: SUB_AGENT_PROVIDER,
    invocation: 'delegated',
    execution: { runtime: 'maid-sub-agent' },
    // Agent metadata（架构计划 §3.2）：能力标签 = 用户勾选的 skills；模型引用 = 绑定的模型档。
    capabilityTags: skills,
    modelProfileRef,
    modelOverride,
    note,
    // 委派预算（由 maid-sub-agent-runtime 执行）：时间上限与输出上限；委派是单轮生成，没有工具调用
    budgets: { tokens: maxOutputTokens || null, timeMs: timeLimitSeconds ? timeLimitSeconds * 1000 : null, toolCalls: null },
    memoryScope: 'maid-run',
    delegation: { maxDepth: 1, maxConcurrency: 1 },
    // 行为兼容投影：与迁移前 buildMaidSubAgentsPromptBlock 收到的形状等价。
    promptShape: { id, name, skills, note, enabled, profileHint: '' },
  };
};

// 可配置 Agent（agent-config-store）：内置的文本建议／格式修复／小管家，与用户自建的文本、输入 Agent
const CONFIG_AGENT_PROVIDER = 'agent-config';
const CONFIG_AGENT_ROLES = Object.freeze({
  text_edit: 'text_edit', input_agent: 'input_agent', input_suggestion: 'input_suggestion',
  format_review: 'format_review', archive_naming: 'archive_naming',
});
export const projectConfiguredAgentCapability = (entry = {}) => {
  const config = isPlainObject(entry?.config) ? entry.config : (isPlainObject(entry) ? entry : {});
  const id = trim(config.id);
  const role = CONFIG_AGENT_ROLES[trim(config.kind)];
  if (!id || !role) return null;
  const custom = /^(text-edit|input-agent):/.test(id);
  const modelMode = trim(config.modelMode, 'none');
  return {
    ref: buildCapabilityRef({ id, namespace: custom ? 'user' : 'builtin', kind: AGENT_CAPABILITY_KIND, provider: CONFIG_AGENT_PROVIDER, ref: id }),
    id,
    name: trim(config.title) || id,
    role,
    summary: '',
    enabled: config.enabled === true,
    provider: CONFIG_AGENT_PROVIDER,
    source: CONFIG_AGENT_PROVIDER,
    custom,
    capabilityTags: [],
    // 模型：未选（none）／跟随当前对话（follow_current）／指定模型档
    modelMode,
    modelProfileRef: modelMode === 'profile' ? trim(config.modelProfileId) : '',
    modelOverride: modelMode === 'profile' ? trim(config.modelOverride) : '',
    invocation: trim(config.invocationMode, 'auto') === 'manual' ? 'manual' : 'auto',
    scope: trim(entry?.source),
    tools: config.tools?.enabled === true ? (Array.isArray(config.tools.ids) ? config.tools.ids.length : 0) : 0,
    execution: { runtime: 'agent-config', kind: trim(config.kind) },
  };
};
export const createConfiguredAgentRegistryProvider = (listConfigs = () => []) => ({
  provider: CONFIG_AGENT_PROVIDER,
  listCapabilities: () => (typeof listConfigs === 'function' ? listConfigs() || [] : [])
    .map(projectConfiguredAgentCapability)
    .filter(Boolean),
});

// 女仆技能（maid-skill-store）：女仆处理一类任务的流程，按 workflow 登记
const MAID_SKILL_PROVIDER = 'maid-skill';
export const projectMaidSkillCapability = (skill = {}) => {
  const src = isPlainObject(skill) ? skill : {};
  const id = trim(src.id);
  if (!id) return null;
  const custom = trim(src.kind) === 'custom';
  return {
    ref: buildCapabilityRef({ id, namespace: custom ? 'user' : 'builtin', kind: WORKFLOW_CAPABILITY_KIND, provider: MAID_SKILL_PROVIDER, ref: id }),
    id,
    name: trim(src.title) || trim(src.name) || id,
    role: 'maid_skill',
    summary: trim(src.description),
    enabled: src.enabled !== false,
    provider: MAID_SKILL_PROVIDER,
    source: MAID_SKILL_PROVIDER,
    custom,
    capabilityTags: (Array.isArray(src.featureIds) ? src.featureIds : []).map(item => trim(item)).filter(Boolean),
    invocation: trim(src.invocationMode) === 'manual' ? 'manual' : 'auto',
    execution: { runtime: 'maid-skill' },
  };
};
export const createMaidSkillRegistryProvider = (listSkills = () => []) => ({
  provider: MAID_SKILL_PROVIDER,
  listCapabilities: () => (typeof listSkills === 'function' ? listSkills() || [] : [])
    .map(projectMaidSkillCapability)
    .filter(Boolean),
});

// 女仆 Sub-agent provider：registry 的第一个来源。getSubAgents 返回原始 sub-agent 数组。
export const createSubAgentRegistryProvider = (getSubAgents = () => []) => ({
  provider: SUB_AGENT_PROVIDER,
  listCapabilities: () => (typeof getSubAgents === 'function' ? getSubAgents() : [])
    .map(projectSubAgentCapability)
    .filter(Boolean),
});

// 统一 Agent Registry：聚合多个 provider（当前仅 sub-agent；后续内建领域 Agent / 用户 Agent / MCP 复用同接口）。
export const createAgentRegistry = ({ providers = [] } = {}) => {
  const providerList = (Array.isArray(providers) ? providers : []).filter(p => p && typeof p.listCapabilities === 'function');

  const listAgents = () => {
    const out = [];
    const seen = new Set();
    providerList.forEach((p) => {
      let caps = [];
      try { caps = p.listCapabilities() || []; } catch { caps = []; }
      caps.forEach((cap) => {
        if (!cap || !cap.ref) return;
        const key = capabilityRefKey(cap.ref);
        if (seen.has(key)) return; // 先注册的 provider 优先，后者不覆盖
        seen.add(key);
        out.push(cap);
      });
    });
    return out;
  };

  // role 过滤：委派只能挑 Sub-agent，不会挑到文本 Agent 或技能
  const listEnabledAgents = ({ role = '' } = {}) => listAgents()
    .filter(cap => cap.enabled !== false && (!role || cap.role === role));

  const getAgent = (id = '') => {
    const target = trim(id);
    if (!target) return null;
    return listAgents().find(cap => cap.id === target) || null;
  };

  const getAgentByRef = (ref = {}) => {
    const key = capabilityRefKey(ref);
    return listAgents().find(cap => capabilityRefKey(cap.ref) === key) || null;
  };

  const listByProvider = (provider = '') => {
    const target = trim(provider);
    return listAgents().filter(cap => cap.provider === target);
  };

  // 供 planner 消费的行为兼容投影：等价于迁移前 settingsStore.listSubAgents() 过 enabled 的结果。
  const listPromptShapes = () => listEnabledAgents({ role: SUB_AGENT_ROLE }).map(cap => cap.promptShape).filter(Boolean);

  return {
    listAgents,
    listEnabledAgents,
    getAgent,
    getAgentByRef,
    listByProvider,
    listPromptShapes,
    get providers() { return providerList.map(p => p.provider); },
  };
};
