// 用户工具与触发绑定（自定义工具、动作与手势计划）。
// 工具＝名称、图标、动作（来源＋id＋参数）、是否直接执行；绑定＝快捷键或界面手势，单独保存，
// 同一个按键组合／同一位置的同一手势只能指向一个工具。全局生效，不随预设或角色卡变化。
// 动作来源缺失（例如 Agent 被删）时保留工具与绑定，执行时说明不可用，不改指到别的动作。

export const USER_TOOLS_KEY = 'user_tools_v1';
export const USER_TOOL_LIMIT = 60;
export const USER_TOOL_SOURCES = Object.freeze(['builtin', 'agent', 'script', 'plugin']);
// 工具脚本可声明的能力（保存时由用户确认，approved 与 capabilities 一致才可执行）
export const USER_TOOL_SCRIPT_CAPABILITIES = Object.freeze(['read', 'input', 'edit', 'model']);
export const USER_TOOL_SCRIPT_MAX_CHARS = 20000;
// 每个位置支持的手势（计划 6.2：气泡长按已是消息菜单与选字，只开放双击）
export const USER_TOOL_GESTURES = Object.freeze({
  assistant_bubble: Object.freeze(['double']),
  user_bubble: Object.freeze(['double']),
  send_button: Object.freeze(['double', 'long']),
  message_avatar: Object.freeze(['click', 'double']),
});

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const makeId = prefix => `${prefix}_${globalThis.crypto?.randomUUID?.().replace(/-/g, '').slice(0, 12) || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}`;

/** 快捷键：必须带 Ctrl／Alt／⌘ 之一（避免占用日常输入）；key 用于比对唯一性。 */
export const normalizeToolShortcut = (raw) => {
  if (!isPlainObject(raw) || !/^[A-Za-z0-9]{1,24}$/.test(trim(raw.code))) return null;
  const shortcut = { code: trim(raw.code), ctrl: raw.ctrl === true, alt: raw.alt === true, meta: raw.meta === true, shift: raw.shift === true };
  if (!shortcut.ctrl && !shortcut.alt && !shortcut.meta) return null;
  return { ...shortcut, label: trim(raw.label).slice(0, 40) || shortcut.code };
};
export const toolShortcutKey = shortcut => (shortcut
  ? `${shortcut.ctrl ? 'C' : ''}${shortcut.alt ? 'A' : ''}${shortcut.meta ? 'M' : ''}${shortcut.shift ? 'S' : ''}+${shortcut.code}`
  : '');
const EDITING_CODES = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyY', 'KeyZ']);
/** 不让工具占用的组合：Ctrl／⌘＋复制、粘贴、剪下、全选、撤销、重做，以及 Enter、Esc、Tab。 */
export const isReservedToolShortcut = shortcut => Boolean(shortcut) && (
  ['Enter', 'NumpadEnter', 'Escape', 'Tab'].includes(shortcut.code)
  || (EDITING_CODES.has(shortcut.code) && (shortcut.ctrl || shortcut.meta) && !shortcut.alt)
);
/** 键盘事件 → 快捷键（不带修饰键时为 null）。 */
export const toolShortcutFromEvent = (event = {}) => normalizeToolShortcut({
  code: event.code, ctrl: event.ctrlKey, alt: event.altKey, meta: event.metaKey, shift: event.shiftKey,
  label: [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.metaKey && '⌘', event.shiftKey && 'Shift', String(event.key || '').length === 1 ? String(event.key).toUpperCase() : trim(event.key)].filter(Boolean).join(' + '),
});

const normalizeGesture = (raw) => {
  const position = trim(raw?.position);
  const gesture = trim(raw?.gesture);
  return USER_TOOL_GESTURES[position]?.includes(gesture) ? { position, gesture } : null;
};
const bindingKey = binding => (binding.kind === 'shortcut' ? `key:${toolShortcutKey(binding.shortcut)}` : `gesture:${binding.gesture.position}:${binding.gesture.gesture}`);

const normalizeParams = (raw) => {
  if (!isPlainObject(raw)) return {};
  let text = '';
  try { text = JSON.stringify(raw); } catch { return {}; }
  return text.length <= 8000 ? JSON.parse(text) : {};
};

const normalizeCapabilities = value => USER_TOOL_SCRIPT_CAPABILITIES.filter(item => (Array.isArray(value) ? value : []).includes(item));
const normalizeScript = (raw) => {
  if (!isPlainObject(raw)) return null;
  const code = String(raw.code ?? '').slice(0, USER_TOOL_SCRIPT_MAX_CHARS);
  return { code, capabilities: normalizeCapabilities(raw.capabilities), approved: normalizeCapabilities(raw.approved) };
};

const normalizeTool = (raw) => {
  if (!isPlainObject(raw)) return null;
  const id = trim(raw.id);
  const name = trim(raw.name).slice(0, 40);
  const source = trim(raw.action?.source);
  const actionId = trim(raw.action?.id).slice(0, 120);
  if (!/^tool_[A-Za-z0-9]{4,40}$/.test(id) || !name || !USER_TOOL_SOURCES.includes(source) || !actionId) return null;
  const script = source === 'script' ? normalizeScript(raw.script) : null;
  return {
    id, name,
    icon: /^[a-z_]{1,24}$/.test(trim(raw.icon)) ? trim(raw.icon) : '',
    action: { source, id: actionId, params: normalizeParams(raw.action?.params) },
    ...(script ? { script } : {}),
    direct: raw.direct === true,
    revision: Math.max(1, Math.trunc(Number(raw.revision)) || 1),
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
  };
};

const normalizeBinding = (raw, toolIds) => {
  if (!isPlainObject(raw) || !toolIds.has(trim(raw.toolId))) return null;
  const id = trim(raw.id);
  if (!/^bind_[A-Za-z0-9]{4,40}$/.test(id)) return null;
  if (raw.kind === 'shortcut') {
    const shortcut = normalizeToolShortcut(raw.shortcut);
    return shortcut ? { id, toolId: trim(raw.toolId), kind: 'shortcut', shortcut } : null;
  }
  if (raw.kind === 'gesture') {
    const gesture = normalizeGesture(raw.gesture);
    return gesture ? { id, toolId: trim(raw.toolId), kind: 'gesture', gesture } : null;
  }
  return null;
};

const clone = value => JSON.parse(JSON.stringify(value));

export class UserToolStore {
  constructor({ loadKv = null, saveKv = null, now = Date.now } = {}) {
    this.loadKv = loadKv;
    this.saveKv = saveKv;
    this.now = now;
    this.tools = [];
    this.bindings = [];
    this.loaded = false;
    this.listeners = new Set();
    this.chain = Promise.resolve();
  }

  async load() {
    let raw = null;
    try { raw = await this.loadKv?.(USER_TOOLS_KEY); } catch {}
    this.tools = (Array.isArray(raw?.tools) ? raw.tools : []).map(normalizeTool).filter(Boolean).slice(0, USER_TOOL_LIMIT);
    const toolIds = new Set(this.tools.map(tool => tool.id));
    const seen = new Set();
    this.bindings = (Array.isArray(raw?.bindings) ? raw.bindings : []).map(item => normalizeBinding(item, toolIds)).filter((binding) => {
      if (!binding || seen.has(bindingKey(binding))) return false;
      seen.add(bindingKey(binding));
      return true;
    });
    this.loaded = true;
    this.notify();
    return this.listTools();
  }

  listTools() { return this.tools.map(clone); }
  getTool(id) { const tool = this.tools.find(item => item.id === trim(id)); return tool ? clone(tool) : null; }
  listBindings({ toolId = '' } = {}) { return this.bindings.filter(binding => !toolId || binding.toolId === toolId).map(clone); }
  findShortcut(shortcut) {
    const key = toolShortcutKey(normalizeToolShortcut(shortcut));
    const binding = key ? this.bindings.find(item => item.kind === 'shortcut' && toolShortcutKey(item.shortcut) === key) : null;
    return binding ? clone(binding) : null;
  }
  findGesture(position, gesture) {
    const binding = this.bindings.find(item => item.kind === 'gesture' && item.gesture.position === position && item.gesture.gesture === gesture);
    return binding ? clone(binding) : null;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() { this.listeners.forEach((listener) => { try { listener(); } catch {} }); }

  serial(work) {
    const job = this.chain.then(work);
    this.chain = job.catch(() => {});
    return job;
  }

  async persist(tools, bindings) {
    await this.saveKv?.(USER_TOOLS_KEY, { version: 1, tools, bindings });
    this.tools = tools;
    this.bindings = bindings;
    this.notify();
  }

  /** 新增或修改工具；expectedRevision 不符时拒绝（别处刚改过）。 */
  saveTool(patch = {}, { expectedRevision } = {}) {
    return this.serial(async () => {
      if (!isPlainObject(patch)) throw fail('tool_invalid', '工具设置无效');
      const prior = patch.id ? this.tools.find(item => item.id === trim(patch.id)) : null;
      if (patch.id && !prior) throw fail('tool_not_found', '找不到这个工具');
      if (expectedRevision !== undefined && prior?.revision !== expectedRevision) throw fail('tool_changed', '工具刚被改过，请重新打开再改');
      if (!prior && this.tools.length >= USER_TOOL_LIMIT) throw fail('tool_limit', '工具数量已达上限');
      const timestamp = this.now();
      const next = normalizeTool({
        id: prior?.id || makeId('tool'),
        name: patch.name ?? prior?.name,
        icon: patch.icon ?? prior?.icon,
        action: patch.action ?? prior?.action,
        script: patch.script ?? prior?.script,
        direct: typeof patch.direct === 'boolean' ? patch.direct : prior?.direct,
        revision: (prior?.revision || 0) + 1,
        createdAt: prior?.createdAt || timestamp,
        updatedAt: timestamp,
      });
      if (!next) {
        if (!trim(patch.name ?? prior?.name)) throw fail('tool_invalid', '请给工具起个名字');
        throw fail('tool_invalid', '请选择工具要执行的动作');
      }
      const tools = prior ? this.tools.map(item => (item.id === next.id ? next : item)) : [...this.tools, next];
      await this.persist(tools, this.bindings);
      return clone(next);
    });
  }

  removeTool(id) {
    return this.serial(async () => {
      const target = trim(id);
      if (!this.tools.some(item => item.id === target)) throw fail('tool_not_found', '找不到这个工具');
      await this.persist(this.tools.filter(item => item.id !== target), this.bindings.filter(binding => binding.toolId !== target));
      return { removed: target };
    });
  }

  /** 设定或清除（null）工具的快捷键；组合已被别的工具使用时拒绝，除非 replace（改绑过来）。 */
  setShortcut(toolId, shortcut, { replace = false } = {}) {
    if (shortcut === null) return this.setBinding(toolId, 'shortcut', null, { single: true });
    const value = normalizeToolShortcut(shortcut);
    if (!value) return Promise.reject(fail('tool_invalid', '快捷键需要 Ctrl、Alt 或 ⌘ 加另一个键'));
    return this.setBinding(toolId, 'shortcut', value, { replace, single: true });
  }

  /** 设定或清除某个位置手势的绑定。 */
  setGesture(toolId, { position, gesture } = {}, { enabled = true, replace = false } = {}) {
    const value = normalizeGesture({ position, gesture });
    if (!value) return Promise.reject(fail('tool_invalid', '这个位置不支持该手势'));
    return this.setBinding(toolId, 'gesture', enabled ? value : null, { replace, clearOnly: value });
  }

  setBinding(toolId, kind, value, { replace = false, single = false, clearOnly = null } = {}) {
    return this.serial(async () => {
      const target = trim(toolId);
      if (!this.tools.some(item => item.id === target)) throw fail('tool_not_found', '找不到这个工具');
      let bindings = this.bindings;
      if (single) bindings = bindings.filter(binding => !(binding.toolId === target && binding.kind === kind));
      if (!value) {
        if (clearOnly) bindings = bindings.filter(binding => !(binding.toolId === target && binding.kind === 'gesture' && binding.gesture.position === clearOnly.position && binding.gesture.gesture === clearOnly.gesture));
        await this.persist(this.tools, bindings);
        return null;
      }
      const next = { id: makeId('bind'), toolId: target, kind, ...(kind === 'shortcut' ? { shortcut: value } : { gesture: value }) };
      const conflict = bindings.find(binding => bindingKey(binding) === bindingKey(next) && binding.toolId !== target);
      if (conflict && !replace) {
        const owner = this.tools.find(item => item.id === conflict.toolId);
        throw fail('tool_binding_taken', '这个按键或手势已被别的工具使用', { conflictToolId: conflict.toolId, conflictToolName: owner?.name || '' });
      }
      bindings = bindings.filter(binding => bindingKey(binding) !== bindingKey(next));
      await this.persist(this.tools, [...bindings, next]);
      return clone(next);
    });
  }
}
