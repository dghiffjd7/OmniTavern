// Agent「套用预设」：按 id 把一个 openai 预设组成这个 Agent 的请求（计划书 Unfinished_Plans/Agent套用预设与任务预设计划.md 第 3、6 节）。
// 不经过主回复管线（bridge.buildMessages）：世界书、对话示例留空，不套预设绑定的正则和脚本；
// 程序要读的输出格式由预设自己写，这里不另外附加。Agent 自己的数据放在预设的「聊天记录」位置，没有这个位置就放最后。

import { t } from '../../i18n/index.js';

const FILL_MARKERS = ['charDescription', 'charPersonality', 'scenario', 'personaDescription'];
const EMPTY_MARKERS = ['worldInfoBefore', 'worldInfoAfter', 'dialogueExamples'];
const ROLES = new Set(['system', 'user', 'assistant']);

const text = value => (typeof value === 'string' ? value : '');
const isEnabled = row => row?.enabled !== false;

// 同主回复：ST 全局 dummyId 100001 优先，100000 兜底，再不然取第一组。
export const pickPresetPromptOrder = (preset) => {
  const blocks = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
  const byId = id => blocks.find(block => block && String(block.character_id) === String(id));
  const block = byId(100001) || byId(100000) || blocks[0] || null;
  return Array.isArray(block?.order) ? block.order : null;
};

const listRows = (preset) => {
  const prompts = Array.isArray(preset?.prompts) ? preset.prompts : [];
  const order = pickPresetPromptOrder(preset);
  if (order) return order.filter(row => row?.identifier && isEnabled(row)).map(row => String(row.identifier));
  return prompts.filter(prompt => prompt?.identifier && isEnabled(prompt)).map(prompt => String(prompt.identifier));
};

const promptsById = preset => new Map((Array.isArray(preset?.prompts) ? preset.prompts : [])
  .filter(prompt => prompt?.identifier)
  .map(prompt => [String(prompt.identifier), prompt]));

const isMissingOrEmpty = preset => !preset || typeof preset !== 'object';

export const describeTaskPreset = (preset) => {
  if (isMissingOrEmpty(preset) || !Array.isArray(preset.prompts)) {
    return { ok: false, enabledEntries: 0, hasHistorySlot: false, filled: [], leftEmpty: [] };
  }
  const byId = promptsById(preset);
  const summary = { ok: true, enabledEntries: 0, hasHistorySlot: false, filled: [], leftEmpty: [] };
  for (const identifier of listRows(preset)) {
    if (identifier === 'chatHistory') { summary.hasHistorySlot = true; continue; }
    if (FILL_MARKERS.includes(identifier)) { if (!summary.filled.includes(identifier)) summary.filled.push(identifier); continue; }
    if (EMPTY_MARKERS.includes(identifier)) { if (!summary.leftEmpty.includes(identifier)) summary.leftEmpty.push(identifier); continue; }
    const prompt = byId.get(identifier);
    if (prompt && !prompt.marker && text(prompt.content).trim()) summary.enabledEntries += 1;
  }
  return summary;
};

export const renderTaskPresetMessages = ({ preset = null, data = [], fill = {}, renderMacros = value => value } = {}) => {
  if (isMissingOrEmpty(preset)) return { ok: false, reason: 'preset_missing', messages: [], hasHistorySlot: false };
  if (!Array.isArray(preset.prompts)) return { ok: false, reason: 'preset_empty', messages: [], hasHistorySlot: false };
  const byId = promptsById(preset);
  const dataMessages = (Array.isArray(data) ? data : []).map(message => ({ ...message }));
  const messages = [];
  let hasHistorySlot = false;
  const push = (role, raw) => {
    const content = String(renderMacros(raw) ?? '');
    if (content.trim()) messages.push({ role, content });
  };
  for (const identifier of listRows(preset)) {
    if (identifier === 'chatHistory') {
      if (!hasHistorySlot) messages.push(...dataMessages);
      hasHistorySlot = true;
      continue;
    }
    if (FILL_MARKERS.includes(identifier)) { push('system', text(fill?.[identifier])); continue; }
    if (EMPTY_MARKERS.includes(identifier)) continue;
    const prompt = byId.get(identifier);
    if (!prompt || prompt.marker) continue;
    const role = prompt.system_prompt === true ? 'system' : String(prompt.role || 'system').toLowerCase();
    push(ROLES.has(role) ? role : 'system', text(prompt.content));
  }
  if (!hasHistorySlot) messages.push(...dataMessages);
  return { ok: true, reason: '', messages, hasHistorySlot };
};

// 由 app 注入：getPreset(id) 取预设副本；renderMacros(text, ctx) 走宏引擎（ctx.macroVariableState 让写入类宏只写进沙盒、不落盘，
// {{getvar}} 仍读真实变量）；getFill(ctx) 给出被处理会话的角色描述／性格／场景／用户设定。
// 不经过 bridge 的 Agent（直接用 LLMClient 发请求）只从预设取采样参数；推理强度仍按 Agent 自己的「思考模式」，
// 输出上限按 Agent 自己的设置（计划书第 6 节），所以这里不带 openai_max_tokens 与推理字段。
export const presetSamplingParams = (preset) => {
  const out = {};
  const num = key => { const value = preset?.[key]; if (typeof value === 'number' && Number.isFinite(value)) out[key] = value; };
  ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty'].forEach(num);
  if (typeof preset?.top_k === 'number' && Number.isFinite(preset.top_k)) out.top_k = Math.trunc(preset.top_k);
  return out;
};

export const createAgentTaskPresetResolver = ({ getPreset = () => null, renderMacros = value => value, getFill = () => ({}) } = {}) => ({
  resolve(presetId, { sessionId = '', userName = '', charName = '' } = {}) {
    const id = String(presetId || '').trim();
    const preset = id ? getPreset(id) : null;
    if (!preset) return { ok: false, reason: 'preset_missing', id };
    const ctx = { sessionId, userName, charName };
    return {
      ok: true,
      id,
      name: String(preset.name || id),
      describe: describeTaskPreset(preset),
      sampling: presetSamplingParams(preset),
      // transform 先于宏引擎处理每段文字（如房子的 {{user_input}} / {{body}} / {{house:id}}）。
      render: (data = [], { transform = null } = {}) => {
        const macroContext = { sessionId, user: userName, char: charName, macroVariableState: new Map() };
        return renderTaskPresetMessages({
          preset,
          data,
          fill: getFill(ctx) || {},
          renderMacros: value => renderMacros(typeof transform === 'function' ? transform(value) : value, macroContext),
        });
      },
    };
  },
});

// 设置里的「提示词／套用预设」→ 这次实际怎么组请求。选了套用预设但没选预设或预设已删除时退回提示词，
// fallback 给出原因，供卡片提示与运行记录注明。
export const resolveAgentPromptSource = ({ mode = 'prompt', presetId = '', resolver = null, ctx = {} } = {}) => {
  if (mode !== 'preset') return { mode: 'prompt', fallback: '' };
  const id = String(presetId || '').trim();
  if (!id) return { mode: 'prompt', fallback: 'preset_unset', presetId: '' };
  const resolved = resolver?.resolve?.(id, ctx);
  if (!resolved?.ok) return { mode: 'prompt', fallback: 'preset_missing', presetId: id };
  return { mode: 'preset', presetId: id, presetName: resolved.name, taskPreset: resolved };
};

// Agent 请求的各段标上 part：task（任务要求、自定义区块）由预设代替；data（参考、目标文本等）放进预设的聊天记录位置；
// format（程序要读的返回格式）只在 keepFormat 时附在最后——补丁类带当次版本标记，预设写不出来（2026-10-15 用户定）。
export const applyTaskPresetToParts = ({ parts = [], taskPreset = null, keepFormat = false } = {}) => {
  const list = Array.isArray(parts) ? parts : [];
  const has = part => String(part?.content ?? '').trim();
  const data = list.filter(part => part?.part === 'data' && has(part))
    .map(part => ({ role: part.role === 'assistant' ? 'assistant' : part.role === 'system' ? 'system' : 'user', content: String(part.content), source: part.source || '数据' }));
  const rendered = taskPreset?.render?.(data);
  if (!rendered?.ok) return { ok: false, reason: rendered?.reason || 'preset_missing' };
  const format = keepFormat ? list.filter(part => part?.part === 'format' && has(part)) : [];
  const sections = [
    ...rendered.messages.map(message => (Object.prototype.hasOwnProperty.call(message, 'source')
      ? { source: message.source, role: message.role, content: message.content, origin: '聊天记录位置' }
      : { source: t('预设 · {name}', { name: taskPreset.name || taskPreset.id || '' }), role: message.role, content: message.content, origin: '套用预设' })),
    ...format.map(part => ({ source: part.source || '返回格式', role: part.role || 'system', content: String(part.content), origin: '程序固定附加' })),
  ];
  return { ok: true, sections, messages: sections.map(({ role, content }) => ({ role, content })) };
};

// 直接发请求的 Agent 套用预设的入口：app 启动时 setAgentTaskPresetSource 注入「按预设 id 与会话解析」，
// 各请求组装（修改文本、附注、输入助手、文本建议、小管家、格式修复）组好原请求后调用；预设没选或已删除时原样返回并注明原因。
let agentTaskPresetSource = null;
export const setAgentTaskPresetSource = (source) => { agentTaskPresetSource = source || null; };

export const resolveAgentConfigTaskPreset = (config, sessionId = '') => (config?.promptSource === 'preset'
  ? resolveAgentPromptSource({ mode: 'preset', presetId: config.presetId, resolver: { resolve: id => agentTaskPresetSource?.resolve?.(id, sessionId) } })
  : { mode: 'prompt', fallback: '' });

export const applyAgentConfigTaskPreset = ({ request = {}, parts = [], config = null, sessionId = '', keepFormat = false } = {}) => {
  if (config?.promptSource !== 'preset') return request;
  const source = resolveAgentConfigTaskPreset(config, sessionId);
  if (source.mode !== 'preset') return { ...request, promptSource: { mode: 'prompt', fallback: source.fallback, presetId: source.presetId } };
  const applied = applyTaskPresetToParts({ parts, taskPreset: source.taskPreset, keepFormat });
  if (!applied.ok) return { ...request, promptSource: { mode: 'prompt', fallback: applied.reason, presetId: source.presetId } };
  const { temperature: _temperature, ...params } = request.params || {};
  return {
    ...request,
    messages: applied.messages,
    sections: applied.sections,
    params: { ...params, ...(source.taskPreset.sampling || {}) },
    promptSource: { mode: 'preset', presetId: source.presetId },
  };
};
