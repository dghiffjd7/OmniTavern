// The maid registry's `write:false` also includes internal run updates and asset
// preparation. Custom reference lookup therefore needs an explicit, audited
// capability catalog in addition to the registry's normal permission checks.
// Add a tool here only after checking its executor for persistent/UI side effects.
export const CUSTOM_AGENT_REFERENCE_TOOLS = Object.freeze({
  'worldbook.list': { title: '查找世界书', group: '资料', description: '列出已保存的世界书，按名称或关键词查找。' },
  'worldbook.read': { title: '读取世界书', group: '资料', description: '读取指定世界书的条目、关键词与正文。' },
  'app.read_resource': { title: '读取应用资料', group: '资料', description: '按需读取对话、记忆表格、角色、变量、预设等资料。' },
  'session.list': { title: '查看会话列表', group: '资料', description: '查找会话及其基本信息。' },
  'contact_profile.list': { title: '读取联系人列表', group: '资料', description: '查找保存的联系人画像。' },
  'contact_profile.get': { title: '读取联系人画像', group: '资料', description: '读取指定联系人的资料与关系。' },
  'maid.memory.list': { title: '读取女仆记忆', group: '资料', description: '查询女仆保存的偏好、关系与重要事件。' },
  'chat.read_format_profile': { title: '读取格式规范', group: '资料', description: '读取会话已保存的输出格式规范及其来源。' },
  'memory.preview_actions': { title: '记忆变更预览', group: '变更预览', description: '检查拟议的记忆表格变更及差异。' },
  'variable.preview_commands': { title: '变量变更预览', group: '变更预览', description: '检查拟议的变量更新及差异。' },
  'worldbook.preview_actions': { title: '世界书变更预览', group: '变更预览', description: '检查拟议的世界书条目变更及差异。' },
  'web.search': { title: '联网搜索', group: '联网', description: '搜索公开网页与最新资料。' },
  'web.fetch_url': { title: '读取网页', group: '联网', description: '读取用户提供或搜索结果中的公开网页正文。' },
  'web.research': { title: '搜索并核对资料', group: '联网', description: '结合搜索与网页阅读，整理带来源的资料。' },
  'web.search_images': { title: '搜索参考图片', group: '联网', description: '搜索公开图片的链接与出处。' },
  'app.get_current_state': { title: '读取应用状态', group: '应用', description: '查看当前页面、会话与应用状态。' },
  'app.ui.inspect': { title: '查看当前界面', group: '应用', description: '读取当前可见面板的文字与结构。' },
  'app.search_feature': { title: '查找应用功能', group: '应用', description: '按需求搜索应用内建功能。' },
  'app.read_feature_doc': { title: '读取功能说明', group: '应用', description: '查看指定应用功能的使用方法。' },
  'app.read_recent_errors': { title: '读取近期错误', group: '应用', description: '查看近期错误记录，辅助定位问题。' },
});

export const getCustomAgentReferenceTool = tool => {
  if (!Object.prototype.hasOwnProperty.call(CUSTOM_AGENT_REFERENCE_TOOLS, tool?.name)) return null;
  const entry = CUSTOM_AGENT_REFERENCE_TOOLS[tool?.name];
  if (!entry || tool.capabilities?.modelContext !== 'allowlist' || tool.capabilities?.read !== true
    || tool.capabilities?.write !== false || tool.riskLevel !== 'low') return null;
  // A changed registry declaration can only narrow this entry's authority.
  if (tool.safety?.destructive && tool.safety.destructive !== 'never') return null;
  if (tool.safety?.operationType && !['read', 'preview'].includes(tool.safety.operationType)) return null;
  if (!Array.isArray(tool.permissions) || tool.permissions.some(permission =>
    !['storage', 'network'].includes(permission) && !/^[a-zA-Z0-9_.-]+[.:]read$/u.test(permission))) return null;
  return entry;
};
