import { t } from '../../i18n/index.js';
import { resolveExistingVariablePath, toVariablePath } from '../../variables/variable-path-utils.js';
import { confirmRequest } from './preset-regex-script-tools.js';

/* 女仆改变量：设值与删除。算变化用现有的变量指令预览（与 AI 回复里的变量指令同一套语义），
   写入用现有的变量提交处理器（与聊天 AI 待确认写入同一条路，记下复原快照）。
   冻结预览 → 一次确认（列出每个变量前 ⇒ 后）→ 执行前核对这些变量没被改过 → 读回核对。
   会话是否用共享（全局）变量由 app 判断，与回复后写变量一致。 */

const trim = value => String(value ?? '').trim();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isAllowed = (context = {}, kind = '') => context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === kind;

export const createVariableEditAgentTools = ({
  getCurrentSessionId = () => '',
  resolveUseGlobal = () => false,
  isVariableRuntimeEnabled = () => true,
  previewVariableCommands = null,
  commitVariables = null,
  listVariables = () => ({}),
} = {}) => {
  const snapshots = new WeakMap();

  const capture = async (args = {}, context = {}, mode = 'set') => {
    if (typeof previewVariableCommands !== 'function' || typeof commitVariables !== 'function') {
      return { error: { ok: false, reason: 'variable_runtime_unavailable' } };
    }
    const sessionId = trim(args.sessionId || context?.sessionId || getCurrentSessionId?.());
    if (!sessionId) return { error: { ok: false, reason: 'no_current_session' } };
    if (isVariableRuntimeEnabled?.(sessionId) === false) return { error: { ok: false, reason: 'variable_runtime_disabled', sessionId } };
    const useGlobal = resolveUseGlobal?.(sessionId) === true;
    const requested = mode === 'set'
      ? (Array.isArray(args.values) ? args.values : []).map(item => ({ path: trim(item?.path), value: item?.value }))
      : (Array.isArray(args.paths) ? args.paths : []).map(path => ({ path: trim(path) }));
    const invalid = [];
    const commands = [];
    const root = listVariables({ sessionId, useGlobal }) || {};
    requested.forEach(item => {
      const path = toVariablePath(item.path);
      if (!path.length) invalid.push({ path: item.path, reason: 'invalid_path' });
      else if (mode === 'delete') commands.push({ type: 'delete', path });
      // 已有的路径用 set（会保留 MVU「值＋说明」的包装）；没有的在上层用 insert 新增（上层不存在会一并建立）
      else if (resolveExistingVariablePath(root, path, { allowLeaf: true })?.length) commands.push({ type: 'set', path, value: item.value });
      else commands.push({ type: 'insert', path: path.slice(0, -1), key: path.at(-1), value: item.value });
    });
    const preview = commands.length ? await previewVariableCommands({ sessionId, useGlobal, commands }) : null;
    if (preview?.invalid) return { error: { ok: false, reason: 'invalid_variable_state', sessionId } };
    return {
      sessionId, useGlobal, preview, invalid,
      skipped: Array.isArray(preview?.skipped) ? preview.skipped : [],
      plannedCount: Number(preview?.changed || 0),
    };
  };

  const confirmFor = (snap, kind, mode) => confirmRequest({
    kind, operationType: mode === 'set' ? 'write_variables' : 'delete_variables', danger: mode !== 'set',
    title: mode === 'set' ? t('修改变量') : t('删除变量'),
    message: [
      mode === 'set'
        ? t(snap.useGlobal ? '将修改共享变量的 {count} 项。' : '将修改当前会话变量的 {count} 项。', { count: snap.plannedCount })
        : t(snap.useGlobal ? '将删除共享变量的 {count} 项。' : '将删除当前会话变量的 {count} 项。', { count: snap.plannedCount }),
      ...(mode === 'set' ? [] : [t('删除后要恢复只能手动重设。')]),
      ...(snap.skipped.length || snap.invalid.length ? [t('有 {count} 项无法套用，不会写入。', { count: snap.skipped.length + snap.invalid.length })] : []),
    ].join(''),
    confirmText: mode === 'set' ? t('保存') : t('删除'),
    items: (snap.preview?.entries || []).map(entry => ({
      id: entry.key, label: entry.key, status: 'planned',
      meta: entry.kind === 'create' ? t('新增：{row}', { row: entry.afterPreview }) : `${entry.beforePreview} ⇒ ${entry.afterPreview}`,
    })),
    denyReason: mode === 'set' ? 'variable_set_cancelled' : 'variable_delete_cancelled',
  });

  const execute = async (snap, context, kind) => {
    if (snap.error) return snap.error;
    const head = { sessionId: snap.sessionId, useGlobal: snap.useGlobal };
    const problems = { ...(snap.skipped.length ? { notApplied: snap.skipped } : {}), ...(snap.invalid.length ? { invalid: snap.invalid } : {}) };
    // 删除时目标本来就不存在也算达成；设值有无法套用的项目就不算成功
    if (!snap.plannedCount) {
      const ok = !snap.invalid.length && (kind === 'variable.delete' || !snap.skipped.length);
      return { ok, skipped: true, reason: 'no_change', ...head, ...problems };
    }
    if (!isAllowed(context, kind)) return { ok: false, reason: 'confirmation_required', ...head };
    if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted', ...head };
    const keys = Object.keys(snap.preview.updates || {});
    const before = listVariables({ sessionId: snap.sessionId, useGlobal: snap.useGlobal }) || {};
    // 确认期间这些变量被改过（例如又生成了一轮）就不写，免得用旧的预览盖掉
    if (keys.some(key => !same(before[key], snap.preview.rollbackSnapshot?.[key]))) {
      return { ok: false, reason: 'target_changed_during_confirmation', ...head };
    }
    const commit = await commitVariables({ args: { sessionId: snap.sessionId, useGlobal: snap.useGlobal }, previewResult: snap.preview });
    if (commit?.status !== 'committed') return { ok: false, reason: commit?.reason || 'commit_failed', ...head };
    const after = listVariables({ sessionId: snap.sessionId, useGlobal: snap.useGlobal }) || {};
    const failed = keys.filter(key => !same(after[key], snap.preview.updates[key]));
    if (failed.length) return { ok: false, reason: 'verification_failed', failed, ...head };
    return {
      ok: true, ...head,
      changes: (snap.preview.entries || []).map(entry => ({ key: entry.key, kind: entry.kind, before: entry.beforePreview, after: entry.afterPreview })),
      ...(snap.preview.truncated ? { moreChanges: keys.length - snap.preview.entries.length } : {}),
      ...problems,
    };
  };

  const summarize = label => result => (result?.ok
    ? (result.skipped ? `${label} unchanged` : `${label}; ${Number(result.changes?.length || 0)} change(s)`)
    : `${label} failed: ${trim(result?.reason)}`);

  const setTool = {
    name: 'variable.set',
    title: 'Set variables',
    description: 'Set variable values of the current conversation (or the shared variables when the conversation uses them) with one confirmation. values[].path is a variable path like 好感度 or 角色.小雅.好感 or 物品[0]; value is any JSON value. Changes are computed with the same variable command rules as AI replies, and the result lists every changed variable before ⇒ after. Read current values first with app.read_resource resource "variables".',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'restore_snapshot', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['values'], additionalProperties: false,
      properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 200 },
        values: {
          type: 'array', minItems: 1, maxItems: 30,
          items: { type: 'object', required: ['path', 'value'], additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 300 }, value: {} } },
        },
      },
    },
    safety: {
      operationType: 'write_variables', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await capture(args, context, 'set');
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmFor(snap, 'variable.set', 'set');
      },
    },
    execute: async (args = {}, context = {}) => execute(snapshots.get(args) || await capture(args, context, 'set'), context, 'variable.set'),
    summarizeResult: summarize('variables set'),
  };

  const deleteTool = {
    name: 'variable.delete',
    title: 'Delete variables',
    description: 'Delete variables (or a nested field of one) of the current conversation, or of the shared variables when the conversation uses them, with one dangerous confirmation. paths are variable paths like 临时标记 or 角色.小雅.备注. Deleting a variable a card or preset initialized cannot be undone except by setting it again.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'restore_snapshot', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['paths'], additionalProperties: false,
      properties: {
        sessionId: { type: 'string', minLength: 1, maxLength: 200 },
        paths: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 300 } },
      },
    },
    safety: {
      operationType: 'delete_variables', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await capture(args, context, 'delete');
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmFor(snap, 'variable.delete', 'delete');
      },
    },
    execute: async (args = {}, context = {}) => execute(snapshots.get(args) || await capture(args, context, 'delete'), context, 'variable.delete'),
    summarizeResult: summarize('variables delete'),
  };

  return [setTool, deleteTool];
};

export const registerVariableEditAgentTools = (registry, deps = {}) => registry.registerMany(createVariableEditAgentTools(deps));
