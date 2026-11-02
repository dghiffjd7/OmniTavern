// 工具脚本与插件动作（自定义工具、动作与手势计划第四期）。
// 脚本跑在插件运行层的一次性 Worker：权限＝工具声明并经用户确认的能力；插件动作走插件自己的权限。
// 脚本／插件回传结果物件，宿主按能力套用：放进输入框或发送、改这条消息（审阅或直接执行＋可撤销）、复制、通知。
import { applyValidatedFormatLinePatches, FORMAT_PATCH_MAX_PATCHES, FORMAT_PATCH_MAX_CHANGED_LINES } from '../chat/format-patch-transaction-utils.js';

const trim = value => String(value ?? '').trim();

/** 能力 → 插件权限（改消息由宿主套用，不开插件的写聊天权限）。 */
export const scriptCapabilityPermissions = (capabilities = []) => {
  const set = new Set(capabilities);
  const out = [];
  if (set.has('read')) out.push('chat.read');
  if (set.has('input')) out.push('input.write');
  if (set.has('model')) out.push('model.call', 'network');
  return out;
};
/** 插件权限 → 可套用的结果（插件动作用）。 */
export const pluginCapabilities = (permissions = []) => {
  const set = new Set(permissions);
  return [set.has('chat.read') && 'read', set.has('input.write') && 'input', set.has('chat.write') && 'edit'].filter(Boolean);
};
const sameSet = (a = [], b = []) => a.length === b.length && a.every(item => b.includes(item));
export const isScriptApproved = script => Boolean(script) && sameSet(script.capabilities || [], script.approved || []);

const splitLines = text => String(text ?? '').split(/\r\n|\r|\n/);

/**
 * 两段文字 → 审阅用的逐行补丁（与格式修复同一套）。太大（超过补丁或行数上限）、原文是空的、
 * 或套回去对不上（换行符不同等）时 ok=false，改用简单确认。
 */
export const buildLinePatches = (original = '', candidate = '', { maxLines = 1200 } = {}) => {
  const a = splitLines(original);
  const b = splitLines(candidate);
  if (!String(original).length || a.length > maxLines || b.length > maxLines) return { ok: false, linePatches: [] };
  // LCS 回溯出逐行差异
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let current = null;
  const flush = () => { if (current) { hunks.push(current); current = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i += 1; j += 1; continue; }
    if (!current) current = { i0: i, i1: i, j0: j, j1: j };
    if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { j += 1; current.j1 = j; } else { i += 1; current.i1 = i; }
  }
  flush();
  // 纯插入没有原始行：把相邻一行（两边相同）一起算进来；扩展后若和别段重叠就合并（两边的区间各取联集）
  const ranges = [];
  for (const hunk of hunks) {
    let { i0, i1, j0, j1 } = hunk;
    if (i0 === i1) {
      if (i0 > 0) { i0 -= 1; j0 -= 1; } else if (i1 < n) { i1 += 1; j1 += 1; } else return { ok: false, linePatches: [] };
    }
    const last = ranges.at(-1);
    if (last && i0 < last.i1) {
      last.i1 = Math.max(last.i1, i1);
      last.j1 = Math.max(last.j1, j1);
    } else ranges.push({ i0, i1, j0, j1 });
  }
  const merged = ranges.map(({ i0, i1, j0, j1 }) => ({ startLine: i0 + 1, endLine: i1, originalLines: a.slice(i0, i1), replacementLines: b.slice(j0, j1) }));
  if (!merged.length) return { ok: false, linePatches: [] };
  if (merged.length > FORMAT_PATCH_MAX_PATCHES) return { ok: false, linePatches: [] };
  const applied = applyValidatedFormatLinePatches(original, merged, { maxPatches: FORMAT_PATCH_MAX_PATCHES, maxChangedLines: FORMAT_PATCH_MAX_CHANGED_LINES });
  return applied.ok && applied.candidateText === candidate ? { ok: true, linePatches: merged } : { ok: false, linePatches: [] };
};

/**
 * 套用脚本／插件的结果。result 可以是字串（当作通知）或物件：
 * { status, message, input, send, replace, copy, notify }；能力不够的项目整个结果算失败、什么都不做。
 * deps：getRaw(message, sid)、review({ message, originalText, linePatches, title })→{confirmed,changed,candidateText}、
 * confirmText({ title, text })→bool、commitEdit(message, text, original)、insertInput(text)、sendInput()、copyText(text)、
 * notify(text)、offerUndo({ sessionId, label, undo })、isGenerating()。
 */
export const createToolResultEffects = ({
  getRaw = async message => String(message?.content ?? ''),
  review = async () => ({ confirmed: false }),
  confirmText = async () => false,
  commitEdit = async () => false,
  insertInput = () => {},
  sendInput = () => {},
  copyText = async () => false,
  notify = () => {},
  offerUndo = async () => {},
  isGenerating = () => false,
} = {}) => async ({ tool, message, sessionId, result, capabilities = [], direct = false }) => {
  const out = typeof result === 'string' ? { notify: result } : (result && typeof result === 'object' ? result : {});
  if (out.status === 'failed' || out.status === 'unavailable' || out.status === 'cancelled') {
    return { status: out.status, message: trim(out.message) || '执行失败' };
  }
  const has = capability => capabilities.includes(capability);
  const wantsInput = typeof out.input === 'string' || out.send === true;
  if (wantsInput && !has('input')) return { status: 'failed', message: '要写输入框或发送，但没有声明「写输入框／发送」' };
  if (typeof out.replace === 'string' && !has('edit')) return { status: 'failed', message: '要改这条消息，但没有声明「改这条消息」' };
  if (typeof out.replace === 'string') {
    if (!message) return { status: 'unavailable', message: '没有要改的消息' };
    if (isGenerating()) return { status: 'unavailable', message: '正在生成，结束后再试' };
    const original = String(await getRaw(message, sessionId) ?? '');
    const next = out.replace;
    if (next === original) return { status: 'succeeded', message: '内容没有变化' };
    if (direct) {
      if (!await commitEdit(message, next, original)) return { status: 'failed', message: '没能写回这条消息' };
      await offerUndo({ sessionId, label: '已修改这条消息', undo: async () => commitEdit(message, original, next) });
    } else {
      const patches = buildLinePatches(original, next);
      let text = next;
      if (patches.ok) {
        const accepted = await review({ message, originalText: original, linePatches: patches.linePatches, title: tool?.name || '' });
        if (!accepted?.confirmed || !accepted.changed) return { status: 'cancelled' };
        text = accepted.candidateText;
      } else if (!await confirmText({ title: tool?.name || '', text: next })) {
        return { status: 'cancelled' };
      }
      if (!await commitEdit(message, text, original)) return { status: 'failed', message: '没能写回这条消息' };
    }
  }
  if (typeof out.input === 'string') await insertInput(out.input);
  if (out.send === true) {
    if (isGenerating()) return { status: 'unavailable', message: '正在生成，结束后再试' };
    await sendInput();
  }
  if (typeof out.copy === 'string') await copyText(out.copy);
  if (trim(out.notify)) notify(trim(out.notify));
  return { status: 'succeeded', ...(trim(out.message) ? { message: trim(out.message) } : {}) };
};

/**
 * 执行脚本或插件动作。buildContext({ message, sessionId, capabilities, selection, trigger, tool }) 给出 ctx；
 * applyEffects 见 createToolResultEffects。
 */
export const createScriptToolExecutor = ({ pluginRuntime, buildContext = async () => ({}), applyEffects, getPluginPermissions = () => [], timeoutMs = 60000 } = {}) => async (action, context) => {
  const { tool, message, sessionId } = context;
  if (!pluginRuntime) return { status: 'unavailable', message: '扩展运行环境还没准备好' };
  if (action.source === 'script') {
    const script = tool.script || {};
    if (!trim(script.code)) return { status: 'unavailable', message: '这个工具还没有脚本' };
    if (!isScriptApproved(script)) return { status: 'unavailable', message: '脚本要用的能力还没确认：打开这个工具保存一次即可确认' };
    const capabilities = script.capabilities || [];
    const ctx = await buildContext({ ...context, capabilities });
    const run = await pluginRuntime.runEphemeral({ id: `tool-script-${tool.id}`, name: tool.name, permissions: scriptCapabilityPermissions(capabilities), code: script.code, ctx, timeoutMs });
    if (run?.status !== 'succeeded') return { status: run?.status || 'failed', message: trim(run?.message) || '脚本执行失败' };
    return applyEffects({ tool, message, sessionId, result: run.result, capabilities, direct: tool.direct === true });
  }
  const at = String(action.id).indexOf(':');
  const pluginId = String(action.id).slice(0, at);
  const actionId = String(action.id).slice(at + 1);
  // 插件拿到消息的身份，内容用它自己的 chat.read 权限去读
  const ctx = { trigger: context.trigger, sessionId, message: message ? { id: message.id, role: message.role } : null, selection: context.selection || '' };
  const run = await pluginRuntime.runAction(pluginId, actionId, ctx, { timeoutMs });
  if (run?.status === 'failed' || run?.status === 'unavailable' || run?.status === 'cancelled') return { status: run.status, message: trim(run.message) || '插件执行失败' };
  return applyEffects({ tool, message, sessionId, result: run, capabilities: pluginCapabilities(getPluginPermissions(pluginId)), direct: tool.direct === true });
};
