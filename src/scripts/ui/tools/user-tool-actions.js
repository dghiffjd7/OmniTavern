// 用户工具的动作目录（自定义工具、动作与手势计划）：内建动作是纯资料（作用对象、效果、参数），
// 执行由 user-tool-builtin-executors.js 接到 APP 的正式流程；Agent 动作由 Agent 配置投影而来。
// effect：generate（会请求模型）／destructive（删除，可设直接执行）／view／control／open／read／input／agent。

import { t } from '../../i18n/index.js';

const trim = value => String(value ?? '').trim();

const svgPath = Object.freeze({
  bolt: '<path d="m13 2-8 12h7l-1 8 8-12h-7Z"/>',
  regenerate: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  continue: '<path d="M4 12h.01M8 12h.01"/><path d="M12 12h8"/><path d="m16 8 4 4-4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  prev: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14v6Z"/>',
  restart: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  retract: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  phrase: '<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/>',
  speak: '<path d="M4 9v6h4l5 4V5L8 9H4Z"/><path d="M16 9a3 3 0 0 1 0 6M18.5 6.5a7 7 0 0 1 0 11"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m4 17 5-5 4 4 3-3 4 4"/><circle cx="16" cy="9" r="1.4"/>',
  memory: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  variable: '<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  book: '<path d="M12 5v16M3 4c4-1 6 0 9 1 3-1 5-2 9-1v15c-4-1-6 0-9 2-3-2-5-3-9-2V4Z"/>',
  maid: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/>',
  preset: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9Z"/>',
  heart: '<path d="M12 20s-7-4.4-9-9a4.6 4.6 0 0 1 9-3 4.6 4.6 0 0 1 9 3c-2 4.6-9 9-9 9Z"/>',
  scissors: '<circle cx="6" cy="7" r="3"/><circle cx="6" cy="17" r="3"/><path d="M8.5 8.5 20 19M8.5 15.5 20 5"/>',
});
/** 图标挑选器的顺序。 */
export const USER_TOOL_ICON_NAMES = Object.freeze(Object.keys(svgPath));
export const userToolIconMarkup = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${svgPath[name] || svgPath.bolt}</svg>`;

export const TOOL_PANELS = Object.freeze([
  { id: 'image', title: 'AI 绘图' },
  { id: 'memory', title: '记忆总览' },
  { id: 'variables', title: '变量' },
  { id: 'worldbook', title: '世界书' },
  { id: 'maid', title: '女仆' },
  { id: 'agent_center', title: 'Agent Center' },
  { id: 'presets', title: '预设' },
]);

export const TOOL_ACTION_GROUPS = Object.freeze([
  { id: 'reply', title: '回复操作' },
  { id: 'message', title: '消息编辑' },
  { id: 'text', title: '文字与输入' },
  { id: 'open', title: '打开功能' },
  { id: 'agent', title: 'AI Agent' },
  { id: 'script', title: '脚本与插件' },
]);

/** 工具脚本可声明的能力（与 user-tool-store 的 USER_TOOL_SCRIPT_CAPABILITIES 同序）。 */
export const TOOL_SCRIPT_CAPABILITIES = Object.freeze([
  { id: 'read', title: '读消息与选区', description: '拿到这条消息、选中的文字与最近几条消息（不含密钥）。' },
  { id: 'input', title: '写输入框／发送', description: '把结果放进输入框，或直接发送。' },
  { id: 'edit', title: '改这条消息', description: '修改这条消息的正文：先红绿审阅；工具设为直接执行时直接写入，通知里可撤销。' },
  { id: 'model', title: '调用模型／联网', description: '用当前聊天的模型调用一次，或发网络请求。会产生费用，内容会送出去。', risky: true },
]);

/** 「自己写脚本」：在工具里写一段脚本（跑在插件运行层的一次性 Worker）。 */
export const SCRIPT_TOOL_ACTION = Object.freeze({
  source: 'script', id: 'inline', group: 'script', title: '自己写脚本', icon: 'code', target: 'any', defaultTarget: 'assistant', effect: 'script', directable: true,
  description: '写一段脚本处理这条消息、输入框，或调用模型。',
});

/** 插件在 manifest 宣告的动作 → 工具可选的动作。 */
export const pluginToolAction = (item = {}) => ({
  source: 'plugin',
  id: `${trim(item.pluginId)}:${trim(item.id)}`,
  group: 'script',
  title: trim(item.title) || trim(item.id),
  icon: 'code',
  target: ['assistant', 'user', 'any', 'none'].includes(item.target) ? item.target : 'none',
  effect: 'plugin',
  directable: true,
  pluginName: trim(item.pluginName),
  description: [trim(item.pluginName), trim(item.description)].filter(Boolean).join(' · '),
});

/**
 * target：assistant／user（该角色的消息；手势给了别的角色就不能用）、any（任一条，没有指定时取 defaultTarget）、none（不需要消息）。
 */
export const BUILTIN_TOOL_ACTIONS = Object.freeze([
  { id: 'reply.regenerate', group: 'reply', title: '重新生成', icon: 'regenerate', target: 'assistant', effect: 'generate', description: '重新生成这条 AI 回复；没有指定时为最后一条。' },
  { id: 'reply.continue', group: 'reply', title: '继续生成', icon: 'continue', target: 'none', effect: 'generate', description: '接着最后一条 AI 回复往下写。' },
  { id: 'reply.delete', group: 'reply', title: '删除回复', icon: 'trash', target: 'assistant', effect: 'destructive', directable: true, confirm: '删除这条 AI 回复？有多个分支时只删除当前分支。', description: '有多个分支时删除当前分支，否则删除整条。' },
  { id: 'reply.swipe_prev', group: 'reply', title: '上一个分支', icon: 'prev', target: 'assistant', effect: 'view', description: '切到这条回复的上一个分支。' },
  { id: 'reply.swipe_next', group: 'reply', title: '下一个分支', icon: 'next', target: 'assistant', effect: 'view', description: '切到下一个分支；已是最后一个时不会生成新的。' },
  { id: 'reply.stop', group: 'reply', title: '停止生成', icon: 'stop', target: 'none', effect: 'control', description: '停止正在进行的生成。' },
  { id: 'message.edit', group: 'message', title: '编辑这条', icon: 'edit', target: 'any', defaultTarget: 'assistant', effect: 'open', description: '编辑这条消息；AI 回复会打开原回复编辑。' },
  { id: 'message.restart', group: 'message', title: '从这条重来', icon: 'restart', target: 'user', effect: 'generate', description: '从这条自己的消息重新生成后面的回复；没有指定时为最后一条。' },
  { id: 'message.retract', group: 'message', title: '撤回我的消息', icon: 'retract', target: 'user', effect: 'destructive', directable: true, confirm: '撤回这条自己的消息？', description: '删除这条自己的消息；没有指定时为最后一条。' },
  { id: 'text.copy', group: 'text', title: '复制这条', icon: 'copy', target: 'any', defaultTarget: 'assistant', effect: 'read', description: '复制消息文字；没有指定时为最后一条 AI 回复。' },
  {
    id: 'text.phrase', group: 'text', title: '快捷短语', icon: 'phrase', target: 'none', effect: 'input', description: '把固定文字放进输入框，可选直接发送。',
    params: [
      { key: 'text', type: 'textarea', label: '文字', maxLength: 2000, required: true },
      { key: 'mode', type: 'select', label: '放入方式', options: [['insert', '插入到光标处'], ['replace', '替换输入框内容']], default: 'insert' },
      { key: 'send', type: 'boolean', label: '放入后直接发送', default: false },
    ],
  },
  { id: 'text.speak', group: 'text', title: '朗读这条', icon: 'speak', target: 'assistant', effect: 'read', description: '朗读这条 AI 回复；没有指定时为最后一条。' },
  {
    id: 'open.panel', group: 'open', title: '打开功能', icon: 'grid', target: 'none', effect: 'open', description: '打开指定的功能面板。',
    params: [{ key: 'panel', type: 'select', label: '要打开的功能', options: TOOL_PANELS.map(panel => [panel.id, panel.title]), default: 'image' }],
  },
].map(action => Object.freeze({ source: 'builtin', ...action })));

const builtinById = new Map(BUILTIN_TOOL_ACTIONS.map(action => [action.id, action]));
export const getBuiltinToolAction = id => builtinById.get(trim(id)) || null;

/** Agent 配置 → 动作（打开该 Agent 的工具卡，仍尊重它的调用方式与审阅）。 */
export const agentToolAction = (config = {}, { isInputAgent = () => false, iconName = '' } = {}) => ({
  source: 'agent',
  id: trim(config.id),
  group: 'agent',
  title: trim(config.title) || trim(config.id),
  icon: iconName,
  target: isInputAgent(config) ? 'none' : 'assistant',
  effect: 'agent',
  description: isInputAgent(config) ? '打开这个 Agent，处理输入框里的文字。' : '打开这个 Agent 的工具卡，处理这条或最后一条 AI 回复。',
});

/** 参数校验：按动作的参数说明补默认值、截断长度；必填没填时 ok=false。 */
export const normalizeToolParams = (action = {}, params = {}) => {
  const source = params && typeof params === 'object' ? params : {};
  const out = {};
  for (const param of action.params || []) {
    const raw = source[param.key];
    if (param.type === 'boolean') out[param.key] = typeof raw === 'boolean' ? raw : param.default === true;
    else if (param.type === 'select') out[param.key] = param.options.some(([value]) => value === raw) ? raw : param.default;
    else {
      const text = String(raw ?? '').slice(0, param.maxLength || 2000);
      if (param.required && !text.trim()) return { ok: false, params: out, error: t('请填写「{label}」', { label: t(param.label) }) };
      out[param.key] = text;
    }
  }
  return { ok: true, params: out };
};

/** 可绑定的位置手势；targets：气泡只给能作用在该角色消息（或不需要消息）的动作。 */
export const TOOL_GESTURE_OPTIONS = Object.freeze([
  { position: 'assistant_bubble', gesture: 'double', label: 'AI 气泡 · 双击', targets: ['assistant', 'any', 'none'] },
  { position: 'user_bubble', gesture: 'double', label: '用户气泡 · 双击', targets: ['user', 'any', 'none'] },
  { position: 'send_button', gesture: 'double', label: '发送键 · 双击' },
  { position: 'send_button', gesture: 'long', label: '发送键 · 长按' },
  { position: 'message_avatar', gesture: 'click', label: '消息头像 · 点击' },
  { position: 'message_avatar', gesture: 'double', label: '消息头像 · 双击' },
].map(option => Object.freeze(option)));
export const toolGestureKey = (position, gesture) => `${position}:${gesture}`;
export const isToolGestureCompatible = (option, action) => !option?.targets || !action || option.targets.includes(action.target);
export const toolGestureLabel = binding => TOOL_GESTURE_OPTIONS.find(option => option.position === binding?.position && option.gesture === binding?.gesture)?.label || '';

const targetLabels = { assistant: '这条或最后一条 AI 回复', user: '这条或最后一条自己的消息', none: '' };
/** 工具卡与列表里的一行说明，例如「删除回复 · 直接执行」。 */
export const describeUserTool = (tool = {}, action = null) => {
  if (!action) return t('动作不可用');
  const parts = [action.source === 'agent' || action.source === 'plugin' ? action.title : t(action.title)];
  if (action.source === 'plugin' && action.pluginName) parts.push(action.pluginName);
  if (action.source === 'script') {
    const capabilities = TOOL_SCRIPT_CAPABILITIES.filter(item => tool.script?.capabilities?.includes(item.id)).map(item => t(item.title));
    parts.push(capabilities.length ? capabilities.join('、') : t('不需要额外能力'));
  }
  if (action.id === 'open.panel') {
    const panel = TOOL_PANELS.find(item => item.id === tool.action?.params?.panel);
    if (panel) parts[0] = openPanelLabel(panel);
  }
  if (action.id === 'text.phrase') {
    const text = trim(tool.action?.params?.text).replace(/\s+/g, ' ');
    if (text) parts.push(`「${text.length > 16 ? `${text.slice(0, 16)}…` : text}」`);
    if (tool.action?.params?.send) parts.push(t('直接发送'));
  }
  if (action.directable && tool.direct) parts.push(t('直接执行'));
  return parts.join(' · ');
};
export const describeToolTarget = (action) => {
  if (action?.target === 'any') return action.defaultTarget === 'user' ? '这条消息或最后一条自己的消息' : '这条消息或最后一条 AI 回复';
  return targetLabels[action?.target] || '';
};
// 「打开」接面板名：汉字直接接拉丁字母时补一个空格（打开 AI 绘图）
const openPanelLabel = panel => t('打开{panel}', { panel: t(panel.title) }).replace(/([\u4e00-\u9fff])([A-Za-z])/g, '$1 $2');
/** 动作参数的默认值（选动作时先带入）。 */
export const defaultToolParams = action => Object.fromEntries((action?.params || []).map(param => [
  param.key, param.type === 'boolean' ? param.default === true : param.type === 'select' ? param.default : '',
]));
/** 新工具的预设名称：一般是动作名；打开功能按所选面板（例如「打开记忆总览」）。 */
export const defaultToolName = (action, params = {}) => {
  if (!action) return '';
  if (action.id === 'open.panel') {
    const panel = TOOL_PANELS.find(item => item.id === params.panel);
    if (panel) return openPanelLabel(panel);
  }
  return action.source === 'agent' ? action.title : t(action.title);
};
