const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const AGENT_CARD_DEFINITIONS = Object.freeze([
  {
    id: 'archive_naming', title: '小管家', summary: '保存新存档时，在后台为默认名称生成简短标题。',
    detail: ['手动输入的名称与后续改名不会被覆盖。'], category: 'assistant', accent: 'dialogue', implemented: true,
    enabledDefault: false, toggleKind: 'feature', runtimeKinds: ['archive_naming'], promptRefs: [], resourceRefs: [], settingRefs: [],
  },
  {
    id: 'reply_scoring', title: '正文评分', summary: '按段查看正文的修改必要性评分，手动运行并保留原文。',
    detail: ['使用选定模型返回的评分作参考，不自动润色或修改消息。'], category: 'creative', accent: 'check', implemented: true,
    enabledDefault: false, toggleKind: 'feature', runtimeKinds: ['reply_scoring'], promptRefs: [], resourceRefs: [], settingRefs: [],
  },
  {
    id: 'image_director',
    title: '生图 Agent',
    summary: '根据对话自动整理生图标签和图片提示词。',
    detail: [
      '负责判断当前回复是否需要图片表达。',
      '生成给图片模型使用的标签和提示词。',
      '图片模型、尺寸和默认参数继续关联生图模板资源。',
    ],
    category: 'creative',
    accent: 'image',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['image_director_generation', 'image_generation'],
    promptRefs: [
      { id: 'auto-image-prompt', label: '自动标签生图提示词', profileType: 'sysprompt', agentId: 'image_director' },
    ],
    resourceRefs: ['image_templates'],
    settingRefs: ['自动标签策略', '生图模板'],
  },
  {
    id: 'memory_table_agent',
    title: '记忆表格 Agent',
    summary: '管理记忆表格注入、更新和写入预览。',
    detail: [
      '控制记忆表格数据和 guide 在请求中的位置。',
      '关联记忆中心、自动抽取和写入预览。',
      '记忆表格提示词和注入策略在这里统一维护。',
    ],
    category: 'memory',
    accent: 'memory',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['memory_update'],
    promptRefs: [],
    resourceRefs: ['memory_center'],
    settingRefs: ['记忆提示词模板', '记忆数据位置', '写表指导位置', '写入预览'],
  },
  {
    id: 'lineage_agent',
    title: '血缘图',
    summary: '追踪上下文来源和动态注入关系。',
    detail: [
      '把 PromptTrace、AgentRun 和注入节点整理成可视化血缘图。',
      '用于排查回复受到哪些记忆、变量、世界书和任务影响。',
    ],
    category: 'diagnostic',
    accent: 'lineage',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['lineage_layout'],
    promptRefs: [],
    resourceRefs: [],
    settingRefs: ['会话血缘图', '节点展开'],
  },
  {
    id: 'execution_lane_agent',
    title: '执行泳道',
    summary: '把创作过程按输入、模型、记忆和生图等泳道展示。',
    detail: [
      '将运行过程投影为泳道视图，便于查看每一步的来源和时序。',
      '第一阶段聚焦创作流程观察，不改变实际 prompt 行为。',
    ],
    category: 'diagnostic',
    accent: 'lane',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['creative_execution_lane'],
    promptRefs: [],
    resourceRefs: [],
    settingRefs: ['创意写作泳道', '异步任务显示'],
  },
  {
    id: 'summary_agent',
    title: '摘要 Agent',
    summary: '管理摘要提示词和摘要记忆替代策略。',
    detail: [
      '负责摘要任务时的格式要求和注入位置。',
      '与记忆模式配合，控制何时使用摘要而不是表格记忆。',
    ],
    category: 'memory',
    accent: 'summary',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['summary_compaction', 'moment_summary'],
    promptRefs: [
      { id: 'summary', label: '摘要提示词', profileType: 'sysprompt', agentId: 'summary_agent' },
    ],
    resourceRefs: ['memory_center'],
    settingRefs: ['摘要启用', '摘要注入位置'],
  },
  {
    id: 'moment_agent',
    title: '动态 Agent',
    summary: '管理动态发布、动态评论和发布后评论提示词。',
    detail: [
      '控制 QQ 空间动态相关任务的格式与决策提示词。',
      '包含发布决策、评论回复、发布后评论三类任务。',
    ],
    category: 'social',
    accent: 'moment',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['moment_comment', 'moment_publish'],
    promptRefs: [
      { id: 'moment', label: '动态发布决策提示词', profileType: 'sysprompt', agentId: 'moment_agent' },
      { id: 'moment-comment', label: '动态评论回复提示词', profileType: 'sysprompt', agentId: 'moment_agent' },
      { id: 'moment-publish-comment', label: '发布后评论提示词', profileType: 'sysprompt', agentId: 'moment_agent' },
    ],
    resourceRefs: ['contact_profiles'],
    settingRefs: ['动态发布', '动态评论', '联系人画像'],
  },
  {
    id: 'dialogue_agent',
    title: '私聊协议',
    summary: '管理私聊回复节奏、角色风格和协议提示词。',
    detail: [
      '承接原 preset 中的私聊提示词。',
      '控制私聊场景下的注入位置、深度和角色。',
    ],
    category: 'prompt_module',
    accent: 'dialogue',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['chat_guide'],
    promptRefs: [
      { id: 'dialogue', label: '私聊提示词', profileType: 'sysprompt', agentId: 'dialogue_agent' },
    ],
    resourceRefs: [],
    settingRefs: ['私聊注入位置'],
  },
  {
    id: 'group_agent',
    title: '群聊协议',
    summary: '管理群聊成员、系统消息和群聊协议提示词。',
    detail: [
      '承接原 preset 中的群聊提示词。',
      '负责群聊场景的成员上下文和格式注入策略。',
    ],
    category: 'prompt_module',
    accent: 'group',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['group_chat'],
    promptRefs: [
      { id: 'group', label: '群聊提示词', profileType: 'sysprompt', agentId: 'group_agent' },
    ],
    resourceRefs: ['contact_profiles'],
    settingRefs: ['群聊注入位置', '群成员上下文'],
  },
  {
    id: 'phone_format_agent',
    title: '手机格式',
    summary: '管理手机聊天、动态和结尾格式提示词。',
    detail: [
      '承接原 preset 中的手机格式提示词。',
      '保持固定顺序和格式约束，让聊天、动态和图片消息输出可解析。',
    ],
    category: 'prompt_module',
    accent: 'phone',
    implemented: true,
    enabledDefault: true,
    toggleKind: 'agent_card',
    runtimeKinds: ['phone_format'],
    promptRefs: [
      { id: 'phone-format-intro', label: '手机格式开头', profileType: 'sysprompt', agentId: 'phone_format_agent' },
      { id: 'phone-format-chat', label: 'QQ聊天格式', profileType: 'sysprompt', agentId: 'phone_format_agent' },
      { id: 'phone-format-moment', label: 'QQ空间格式', profileType: 'sysprompt', agentId: 'phone_format_agent' },
      { id: 'phone-format-footer', label: '手机格式结尾', profileType: 'sysprompt', agentId: 'phone_format_agent' },
    ],
    resourceRefs: [],
    settingRefs: ['手机格式开头', '聊天格式', '动态格式', '格式结尾'],
  },
]);

const PROMPT_MODULE_CARD_IDS = new Set([
  'dialogue_agent',
  'group_agent',
  'phone_format_agent',
]);

const DIAGNOSTIC_VIEW_CARD_IDS = new Set([
  'lineage_agent',
  'execution_lane_agent',
]);

const normalizeMemoryMode = (value = '') => {
  const text = trim(value, 'table').toLowerCase();
  if (text === 'summary') return 'summary';
  if (text === 'off' || text === 'disabled') return 'off';
  return 'table';
};

const classifyCatalogCard = (id = '') => {
  const value = trim(id);
  if (PROMPT_MODULE_CARD_IDS.has(value)) return 'prompt_module';
  if (DIAGNOSTIC_VIEW_CARD_IDS.has(value)) return 'diagnostic';
  return 'agent';
};

const cardMatchesMemoryMode = (card = {}, memoryMode = 'table') => {
  const mode = normalizeMemoryMode(memoryMode);
  const id = trim(card.id);
  if (id === 'memory_table_agent') return true;
  if (id === 'summary_agent') return mode === 'summary';
  return true;
};

const runtimeStatusPriority = Object.freeze({
  running: 4,
  waiting_permission: 4,
  failed: 3,
  cancelled: 2,
  succeeded: 1,
});

const pickLatestRuntimeState = (runtimeKinds = [], runs = []) => {
  const kinds = new Set(list(runtimeKinds));
  if (!kinds.size) return null;
  const matching = (Array.isArray(runs) ? runs : [])
    .filter(run => kinds.has(trim(run?.kind)))
    .sort((a, b) => {
      const statusDelta = (runtimeStatusPriority[trim(b?.status)] || 0) - (runtimeStatusPriority[trim(a?.status)] || 0);
      if (statusDelta) return statusDelta;
      return Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0);
    });
  const latest = matching[0] || null;
  if (!latest) return null;
  return {
    kind: trim(latest.kind),
    status: trim(latest.status, 'idle'),
    title: trim(latest.title || latest.kind),
    summary: trim(latest.summary || latest.lastStep?.summary || latest.errorMessage),
    updatedAt: Number(latest.updatedAt || latest.createdAt || 0) || 0,
  };
};

const normalizeCardSettingState = (settings = {}, cardId = '', fallbackEnabled = true) => {
  const src = isPlainObject(settings) ? settings : {};
  const cards = isPlainObject(src.cards) ? src.cards : {};
  const card = isPlainObject(cards[cardId]) ? cards[cardId] : {};
  return {
    enabled: typeof card.enabled === 'boolean' ? card.enabled : fallbackEnabled,
    updatedAt: Number(card.updatedAt || 0) || 0,
  };
};

const buildFeatureCards = (featureAgents = []) => (Array.isArray(featureAgents) ? featureAgents : [])
  .map(agent => ({
    ...agent,
    cardType: 'feature',
    toggleKind: 'feature',
    category: agent.id === 'write_preview' ? 'safety' : 'assistant',
    accent: agent.id === 'write_preview' ? 'preview' : 'check',
    runtimeKinds: agent.id === 'reply_check'
      ? ['chat_format_guardian', 'chat_body_quality_guardian']
      : [],
    promptRefs: [],
    resourceRefs: [],
    settingRefs: [
      agent.supportsTriggerMode ? '触发方式' : '',
      agent.supportsModel ? '检查模型' : '',
      agent.id === 'reply_check' ? '检查提示词来源' : '',
    ].filter(Boolean),
  }));

const buildCatalogCards = ({
  agentCenterSettings = {},
  runs = [],
  memoryMode = 'table',
} = {}) => AGENT_CARD_DEFINITIONS.map((definition) => {
  const state = normalizeCardSettingState(agentCenterSettings, definition.id, definition.enabledDefault !== false);
  const cardGroup = classifyCatalogCard(definition.id);
  return {
    ...definition,
    cardType: cardGroup === 'agent' ? 'catalog' : cardGroup,
    cardGroup,
    enabled: state.enabled,
    updatedAt: state.updatedAt,
    runtimeState: pickLatestRuntimeState(definition.runtimeKinds, runs),
  };
}).filter(card => cardMatchesMemoryMode(card, memoryMode));

export const buildAgentCardList = ({
  featureAgents = [],
  agentCenterSettings = {},
  runView = {},
  memoryMode = 'table',
} = {}) => {
  const runs = Array.isArray(runView?.runs) ? runView.runs : [];
  const featureCards = buildFeatureCards(featureAgents)
    .filter(card => card.implemented === true)
    .map(card => ({
      ...card,
      cardGroup: 'agent',
      runtimeState: pickLatestRuntimeState(card.runtimeKinds, runs),
    }));
  const catalogCards = buildCatalogCards({ agentCenterSettings, runs, memoryMode });
  return featureCards.concat(catalogCards.filter(card => card.cardGroup === 'agent')).filter(card => trim(card.id));
};

export const buildAgentPromptModuleCardList = ({
  agentCenterSettings = {},
  runView = {},
  memoryMode = 'table',
} = {}) => {
  const runs = Array.isArray(runView?.runs) ? runView.runs : [];
  return buildCatalogCards({ agentCenterSettings, runs, memoryMode })
    .filter(card => card.cardGroup === 'prompt_module' && trim(card.id));
};

export const buildAgentDiagnosticCardList = ({
  agentCenterSettings = {},
  runView = {},
  memoryMode = 'table',
} = {}) => {
  const runs = Array.isArray(runView?.runs) ? runView.runs : [];
  return buildCatalogCards({ agentCenterSettings, runs, memoryMode })
    .filter(card => card.cardGroup === 'diagnostic' && trim(card.id));
};

export const getAgentCardDefinitions = () => AGENT_CARD_DEFINITIONS.map(definition => ({
  ...definition,
  cardGroup: classifyCatalogCard(definition.id),
  detail: list(definition.detail),
  promptRefs: Array.isArray(definition.promptRefs) ? definition.promptRefs.map(item => ({ ...item })) : [],
  resourceRefs: list(definition.resourceRefs),
  settingRefs: list(definition.settingRefs),
  runtimeKinds: list(definition.runtimeKinds),
}));
