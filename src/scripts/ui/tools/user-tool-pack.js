// 工具包导入导出（自定义工具、动作与手势计划第五期）。
// 格式 omnitavern.tools／版本 1：工具（名称、图标、动作与参数、直接执行、脚本）、可选的快捷键与手势、
// 依赖（Agent、插件动作只记名称，导入时再对应）。不带密钥与聊天内容；脚本导入后要重新确认能力才会执行。
import { USER_TOOL_SOURCES, USER_TOOL_SCRIPT_CAPABILITIES, USER_TOOL_SCRIPT_MAX_CHARS, USER_TOOL_GESTURES, normalizeToolShortcut } from '../../storage/user-tool-store.js';

export const USER_TOOL_PACK_FORMAT = 'omnitavern.tools';
export const USER_TOOL_PACK_VERSION = 1;
const MAX_PACK_TOOLS = 60;

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** 选定的工具 → 工具包物件。describeAction(source, id) 给依赖的显示名称。 */
export const buildUserToolPack = ({ tools = [], bindings = [], includeBindings = true, describeAction = () => null, now = Date.now } = {}) => {
  const agents = new Map();
  const plugins = new Map();
  const packTools = tools.map((tool, index) => {
    const own = bindings.filter(binding => binding.toolId === tool.id);
    const shortcut = own.find(binding => binding.kind === 'shortcut')?.shortcut;
    const gestures = own.filter(binding => binding.kind === 'gesture').map(binding => ({ ...binding.gesture }));
    const action = describeAction(tool.action.source, tool.action.id);
    if (tool.action.source === 'agent') agents.set(tool.action.id, { id: tool.action.id, title: action?.title || tool.action.id });
    if (tool.action.source === 'plugin') plugins.set(tool.action.id, { id: tool.action.id, title: action?.title || tool.action.id, pluginName: action?.pluginName || '' });
    return {
      key: `t${index + 1}`,
      name: tool.name,
      icon: tool.icon || '',
      direct: tool.direct === true,
      action: { source: tool.action.source, id: tool.action.id, params: { ...(tool.action.params || {}) } },
      ...(tool.script ? { script: { code: tool.script.code, capabilities: [...(tool.script.capabilities || [])] } } : {}),
      ...(includeBindings && shortcut ? { shortcut: { ...shortcut } } : {}),
      ...(includeBindings && gestures.length ? { gestures } : {}),
    };
  });
  return {
    format: USER_TOOL_PACK_FORMAT,
    version: USER_TOOL_PACK_VERSION,
    exportedAt: new Date(now()).toISOString(),
    tools: packTools,
    requires: { agents: [...agents.values()], plugins: [...plugins.values()] },
  };
};

const normalizePackTool = (raw, index) => {
  if (!isPlainObject(raw)) return null;
  const name = trim(raw.name).slice(0, 40);
  const source = trim(raw.action?.source);
  const id = trim(raw.action?.id).slice(0, 120);
  if (!name || !USER_TOOL_SOURCES.includes(source) || !id) return null;
  let params = {};
  try { params = isPlainObject(raw.action?.params) && JSON.stringify(raw.action.params).length <= 8000 ? JSON.parse(JSON.stringify(raw.action.params)) : {}; } catch { params = {}; }
  const gestures = (Array.isArray(raw.gestures) ? raw.gestures : [])
    .map(item => ({ position: trim(item?.position), gesture: trim(item?.gesture) }))
    .filter(item => USER_TOOL_GESTURES[item.position]?.includes(item.gesture));
  const shortcut = raw.shortcut ? normalizeToolShortcut(raw.shortcut) : null;
  return {
    key: trim(raw.key) || `t${index + 1}`,
    name,
    icon: /^[a-z_]{1,24}$/.test(trim(raw.icon)) ? trim(raw.icon) : '',
    direct: raw.direct === true,
    action: { source, id, params },
    ...(source === 'script' && isPlainObject(raw.script) ? {
      script: {
        code: String(raw.script.code ?? '').slice(0, USER_TOOL_SCRIPT_MAX_CHARS),
        capabilities: USER_TOOL_SCRIPT_CAPABILITIES.filter(item => (Array.isArray(raw.script.capabilities) ? raw.script.capabilities : []).includes(item)),
      },
    } : {}),
    ...(shortcut ? { shortcut } : {}),
    ...(gestures.length ? { gestures } : {}),
  };
};

/** 读取工具包文字：格式与版本不对、或没有可用工具时 ok=false。 */
export const parseUserToolPack = (text) => {
  let data;
  try { data = JSON.parse(String(text ?? '')); } catch { return { ok: false, error: '不是有效的 JSON 文件' }; }
  if (!isPlainObject(data) || data.format !== USER_TOOL_PACK_FORMAT) return { ok: false, error: '这不是工具包文件' };
  if (Number(data.version) > USER_TOOL_PACK_VERSION) return { ok: false, error: '工具包来自较新的版本，请先更新 APP' };
  const tools = (Array.isArray(data.tools) ? data.tools : []).slice(0, MAX_PACK_TOOLS).map(normalizePackTool).filter(Boolean);
  if (!tools.length) return { ok: false, error: '工具包里没有可导入的工具' };
  return { ok: true, pack: { ...data, tools } };
};

/**
 * 导入计划：每个工具的状态与绑定冲突。
 * resolveAction(source, id) → 动作或 null；listAgentActions() 给 Agent 对应选项；
 * findShortcut(shortcut)／findGesture(position, gesture) → 现有绑定（含 toolName）或 null。
 * 状态：ready（可直接用）、needs_agent（要选对应的 Agent 或跳过）、missing_plugin（照样导入，插件装好才能用）、
 * needs_approval（脚本，导入后打开保存一次确认能力）。
 */
export const planUserToolImport = ({ pack, resolveAction = () => null, listAgentActions = () => [], findShortcut = () => null, findGesture = () => null, existingNames = [] } = {}) => {
  const names = new Set(existingNames);
  const claimed = new Map(); // 包里先出现的工具占用这个按键／手势
  const items = pack.tools.map((tool) => {
    let name = tool.name;
    for (let n = 2; names.has(name); n += 1) name = `${tool.name.slice(0, 36)} (${n})`;
    names.add(name);
    const action = resolveAction(tool.action.source, tool.action.id);
    let status = 'ready';
    if (tool.action.source === 'agent' && !action) status = 'needs_agent';
    else if (tool.action.source === 'plugin' && !action) status = 'missing_plugin';
    else if (tool.action.source === 'script') status = 'needs_approval';
    else if (!action) status = 'unknown_action';
    const bindings = [];
    const claim = (key, owner) => {
      const conflict = owner?.toolName || claimed.get(key) || '';
      if (!conflict) claimed.set(key, name);
      return conflict;
    };
    if (tool.shortcut) {
      const { code, ctrl, alt, meta, shift } = tool.shortcut;
      bindings.push({ kind: 'shortcut', shortcut: tool.shortcut, conflict: claim(`key:${code}:${ctrl}:${alt}:${meta}:${shift}`, findShortcut(tool.shortcut)) });
    }
    for (const gesture of tool.gestures || []) {
      bindings.push({ kind: 'gesture', gesture, conflict: claim(`gesture:${gesture.position}:${gesture.gesture}`, findGesture(gesture.position, gesture.gesture)) });
    }
    return {
      key: tool.key,
      tool: { ...tool, name },
      status,
      include: status !== 'unknown_action',
      agentChoice: '',
      agentOptions: status === 'needs_agent' ? listAgentActions() : [],
      bindings,
    };
  });
  return { items };
};
