import { t } from '../../i18n/index.js';
import { confirmRequest } from './preset-regex-script-tools.js';

/* 女仆查看与修改记忆设定（通用设定「记忆」那一块）：只开放白名单里的键，
   取值规则同通用设定面板；保存后照面板逐键发出 app-settings-changed，让各处刷新。 */

const trim = value => String(value ?? '').trim();
const isAllowed = (context = {}) => context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === 'memory.settings.update';
const INJECT_POSITIONS = Object.freeze(['template', 'after_persona', 'system_end', 'before_chat', 'history_before', 'history_after', 'history_depth', 'before_latest_user', 'after_latest_user', 'system_end+before_chat']);
const bridge = (key, label, limitLabel) => ({ [`${key}Enabled`]: { type: 'boolean', label }, [`${key}Limit`]: { type: 'integer', minimum: 0, maximum: 200, label: limitLabel } });

// 键 → 取值规则与面板上的名称
export const MEMORY_SETTING_FIELDS = Object.freeze({
  memoryTableEnabledChat: { type: 'boolean', label: '聊天使用记忆表格' },
  memoryTableEnabledWriting: { type: 'boolean', label: '创意写作使用记忆表格' },
  memoryTableEnabledMoments: { type: 'boolean', label: '动态使用记忆表格' },
  memoryAutoExtract: { type: 'boolean', label: 'AI 自动写入记忆表格' },
  memoryInjectPosition: { type: 'string', enum: INJECT_POSITIONS, label: '注入位置' },
  memoryInjectDepth: { type: 'integer', minimum: 0, maximum: 1000, label: '注入深度' },
  memoryBudgetMode: { type: 'string', enum: ['token', 'rows'], label: '预算方式' },
  memoryInputBudgetTokens: { type: 'integer', minimum: 0, maximum: 2000000, label: '输入预算（token）' },
  memoryMaxRows: { type: 'integer', minimum: 0, maximum: 100000, label: '最多行数' },
  memoryMaxTokens: { type: 'integer', minimum: 0, maximum: 2000000, label: '最多 token' },
  ...bridge('memoryBridgeRpToChat', '创意写作的记忆带进聊天', '创意写作带进聊天的条数'),
  ...bridge('memoryBridgeChatToRp', '聊天的记忆带进创意写作', '聊天带进创意写作的条数'),
  ...bridge('memoryBridgeMomentsToChat', '动态的记忆带进聊天', '动态带进聊天的条数'),
  ...bridge('memoryBridgeChatToMoments', '聊天的记忆带进动态', '聊天带进动态的条数'),
  ...bridge('memoryBridgeRpToMoments', '创意写作的记忆带进动态', '创意写作带进动态的条数'),
});
const KEYS = Object.keys(MEMORY_SETTING_FIELDS);
const show = value => (typeof value === 'boolean' ? (value ? t('开启') : t('关闭')) : String(value));

export const createMemorySettingsAgentTools = ({ getSettings = () => ({}), updateSettings = null } = {}) => {
  const snapshots = new WeakMap();
  const current = () => {
    const settings = getSettings() || {};
    return Object.fromEntries(KEYS.map(key => [key, settings[key]]));
  };

  const capture = async (args = {}) => {
    if (typeof updateSettings !== 'function') return { error: { ok: false, reason: 'settings_unavailable' } };
    const before = current();
    const changes = Object.entries(args.settings || {})
      .filter(([key, value]) => KEYS.includes(key) && before[key] !== value)
      .map(([key, value]) => ({ key, label: t(MEMORY_SETTING_FIELDS[key].label), before: before[key], after: value }));
    const notes = [];
    const next = { ...before, ...Object.fromEntries(changes.map(change => [change.key, change.after])) };
    if (changes.some(change => change.key === 'memoryInjectDepth') && next.memoryInjectPosition !== 'history_depth') {
      notes.push(t('注入深度只在注入位置为「历史深度」时生效。'));
    }
    return { changes, notes, before };
  };

  const updateTool = {
    name: 'memory.settings.update',
    title: 'Change memory settings',
    description: 'Change the memory settings in General Settings › Memory with one confirmation: whether chat / creative writing / moments use memory tables, AI auto-writing, injection position (template, after_persona, system_end, before_chat, history_before, history_after, history_depth with memoryInjectDepth, before_latest_user, after_latest_user, system_end+before_chat), budget (memoryBudgetMode token or rows, memoryInputBudgetTokens, memoryMaxRows, memoryMaxTokens) and sharing memories between modes (memoryBridge…Enabled / …Limit). Only these keys can be changed; read current values with memory.settings.read.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['settings'], additionalProperties: false,
      properties: {
        settings: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: Object.fromEntries(KEYS.map(key => {
            const { label: _label, ...rule } = MEMORY_SETTING_FIELDS[key];
            return [key, rule];
          })),
        },
      },
    },
    safety: {
      operationType: 'write_settings', destructive: 'conditional',
      preflight: async (args) => {
        const snap = await capture(args);
        snapshots.set(args, snap);
        if (snap.error || !snap.changes.length) return { destructive: false };
        return confirmRequest({
          kind: 'memory.settings.update', operationType: 'write_settings', danger: false,
          title: t('修改记忆设定'),
          message: [t('将修改 {count} 项记忆设定。', { count: snap.changes.length }), ...snap.notes].join(''),
          confirmText: t('保存'),
          items: snap.changes.map(change => ({ id: change.key, label: change.label, status: 'planned', meta: `${show(change.before)} ⇒ ${show(change.after)}` })),
          denyReason: 'memory_settings_update_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await capture(args);
      if (snap.error) return snap.error;
      if (!snap.changes.length) return { ok: true, skipped: true, reason: 'no_change' };
      if (!isAllowed(context)) return { ok: false, reason: 'confirmation_required' };
      if (context.signal?.aborted) return { ok: false, cancelled: true, status: 'cancelled', reason: 'user_aborted' };
      const now = current();
      if (snap.changes.some(change => now[change.key] !== snap.before[change.key])) return { ok: false, reason: 'target_changed_during_confirmation' };
      await updateSettings(Object.fromEntries(snap.changes.map(change => [change.key, change.after])));
      const after = current();
      const failed = snap.changes.filter(change => after[change.key] !== change.after).map(change => change.key);
      return failed.length
        ? { ok: false, reason: 'verification_failed', failed }
        : { ok: true, changes: snap.changes, ...(snap.notes.length ? { notes: snap.notes } : {}) };
    },
    summarizeResult: result => (result?.ok
      ? (result.skipped ? 'memory settings unchanged' : `memory settings updated; ${Number(result.changes?.length || 0)} change(s)`)
      : `memory settings update failed: ${trim(result?.reason)}`),
  };

  return [
    {
      name: 'memory.settings.read',
      title: 'Read memory settings',
      description: 'Read the memory settings the maid can change (memory tables per mode, AI auto-writing, injection position and depth, budget, sharing memories between chat, creative writing and moments) with their current values and labels.',
      source: 'maid-app-content', permissions: [], riskLevel: 'low',
      capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
      schema: { type: 'object', additionalProperties: false, properties: {} },
      execute: async () => ({
        ok: true,
        settings: Object.fromEntries(Object.entries(current()).map(([key, value]) => [key, { value, label: t(MEMORY_SETTING_FIELDS[key].label) }])),
        injectPositions: INJECT_POSITIONS,
      }),
      summarizeResult: result => (result?.ok ? 'read memory settings' : `memory settings read failed: ${trim(result?.reason)}`),
    },
    updateTool,
  ];
};

export const registerMemorySettingsAgentTools = (registry, deps = {}) => registry.registerMany(createMemorySettingsAgentTools(deps));
