const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const list = value => (Array.isArray(value) ? value : [value])
  .map(item => trim(item))
  .filter(Boolean);

const countPendingBy = (pending = [], predicate = () => false) => (
  (Array.isArray(pending) ? pending : []).filter(item => {
    try {
      return predicate(item);
    } catch {
      return false;
    }
  }).length
);

const RESOURCE_DEFINITIONS = Object.freeze([
  {
    id: 'memory_center',
    group: '记忆',
    title: '记忆',
    summary: '整张卡的记忆、本轮注入、记忆管家。',
    detail: '记忆总览：各聊天室的表格、当前会话的注入与共享；模板和导入导出从总览进入。',
    target: { panel: 'memoryOverviewPanel' },
    actionLabel: '打开',
    chips: ['记忆总览', '记忆管家', '模板'],
  },
  {
    id: 'agent_directory',
    group: 'Agent',
    title: 'Agent 目录',
    summary: 'Sub-agent、文字与输入 Agent、女仆技能，一处看全。',
    detail: '只读目录：模型、触发方式与开关状态；设置仍在各自原本的位置。',
    target: { panel: 'agentDirectoryPanel' },
    actionLabel: '打开',
    chips: [],
  },
  {
    id: 'mcp_servers',
    group: 'Agent',
    title: 'MCP 服务',
    summary: '把外部工具接给女仆用，每次调用前先问你。',
    detail: '加入 Streamable HTTP 地址、测试连接、查看工具；可按工具设为始终允许或撤销。',
    target: { panel: 'mcpServerPanel' },
    actionLabel: '打开',
    chips: [],
  },
  {
    id: 'worldbook',
    group: '资源',
    title: '世界书',
    summary: '当前会话、全局库、写入预览。',
    detail: '世界书编辑继续使用世界书主界面。',
    target: { panel: 'worldPanel', scope: 'session' },
    actionLabel: '打开',
    chips: ['当前会话', '全局库', '写入预览'],
  },
  {
    id: 'variables',
    group: '资源',
    title: '变量',
    summary: '会话变量、全局变量、写入预览。',
    detail: '变量编辑进入变量主界面。',
    target: { panel: 'variablePanel' },
    actionLabel: '打开',
    chips: ['会话变量', '全局变量', '写入预览'],
  },
  {
    id: 'contact_profiles',
    group: '画像',
    title: '联系人画像',
    summary: '画像候选和联系人设置。',
    detail: '画像候选在待处理页确认。',
    target: { panel: 'contactSettingsPanel' },
    actionLabel: '打开',
    chips: ['画像候选', '联系人资源'],
  },
  {
    id: 'image_templates',
    group: '生图',
    title: '生图模板',
    summary: '模型、默认参数、自动标签。',
    detail: '图片参数继续在配置面板维护；提示词从提示词入口进入。',
    target: { panel: 'configPanel', tab: 'image' },
    actionLabel: '打开',
    chips: ['图片模型', '默认参数', '自动标签'],
  },
  {
    id: 'regex_postprocess',
    group: '后处理',
    title: '正则/后处理',
    summary: '输入、输出、推理等规则。',
    detail: '复杂规则继续进入正则主界面或会话正则界面。',
    target: { panel: 'regexPanel' },
    actionLabel: '打开',
    chips: ['输入', '输出', '推理'],
  },
]);

const mergeResourceOverride = (resource = {}, override = {}) => {
  const src = override && typeof override === 'object' ? override : {};
  const status = trim(src.status || resource.status, '就绪');
  const count = Number.isFinite(Number(src.count)) ? Number(src.count) : Number(resource.count || 0);
  const chips = Array.from(new Set([
    ...list(resource.chips),
    ...list(src.chips),
  ]));
  return {
    ...resource,
    ...src,
    id: resource.id,
    title: trim(src.title || resource.title, resource.id),
    group: trim(src.group || resource.group),
    summary: trim(src.summary || resource.summary),
    detail: trim(src.detail || resource.detail),
    status,
    count,
    chips,
    target: {
      ...(resource.target || {}),
      ...(src.target || {}),
    },
    actionLabel: trim(src.actionLabel || resource.actionLabel, '打开'),
  };
};

export const buildAgentCenterResources = ({
  pending = [],
  tools = [],
  safety = {},
  resourceStatus = {},
} = {}) => {
  const writePreviewPending = countPendingBy(pending, item => item?.writePreview);
  const memoryPreviewPending = countPendingBy(pending, item => item?.toolName === 'memory.preview_actions');
  const variablePreviewPending = countPendingBy(pending, item => item?.toolName === 'variable.preview_commands');
  const worldbookPreviewPending = countPendingBy(pending, item => item?.toolName === 'worldbook.preview_actions');
  const profilePending = countPendingBy(pending, item => item?.kind === 'contact_profile_update');
  const writePreviewEnabled = safety?.sessionGate?.writePreviewTools?.enabled === true;
  const toolCount = Array.isArray(tools) ? tools.length : 0;

  const computed = {
    memory_center: {
      status: memoryPreviewPending ? `${memoryPreviewPending} 个待确认` : '就绪',
      count: memoryPreviewPending,
      chips: [
        writePreviewEnabled ? '预览工具已加入' : '预览工具未加入',
        writePreviewPending ? `写入预览 ${writePreviewPending}` : '',
      ],
    },
    worldbook: {
      status: worldbookPreviewPending ? `${worldbookPreviewPending} 个待确认` : '就绪',
      count: worldbookPreviewPending,
    },
    variables: {
      status: variablePreviewPending ? `${variablePreviewPending} 个待确认` : '就绪',
      count: variablePreviewPending,
    },
    contact_profiles: {
      status: profilePending ? `${profilePending} 个候选` : '就绪',
      count: profilePending,
    },
    image_templates: {
      status: '统一配置',
      count: 0,
      chips: toolCount ? [`Agent 工具 ${toolCount}`] : [],
    },
    regex_postprocess: {
      status: '统一配置',
      count: 0,
    },
  };

  return RESOURCE_DEFINITIONS.map(definition => mergeResourceOverride(
    mergeResourceOverride(definition, computed[definition.id]),
    resourceStatus?.[definition.id],
  ));
};

export const findAgentCenterResource = (resources = [], resourceId = '') => {
  const id = trim(resourceId);
  return (Array.isArray(resources) ? resources : []).find(resource => resource?.id === id) || null;
};
