// 女仆内置能力（计划书 Unfinished_Plans/女仆内置能力开关与实时语音对话质量设计.md 第一部分）。
// 开关在 女仆设置 → 技能 → 内置能力，默认关闭；女仆只能「请求」开启，必须经用户确认（持久开启，不给「始终允许」）。
// 能力工具在真正执行前再读一次最新开关：路由过滤只用来挑能力，不能代替执行期检查。

import { t } from '../../i18n/index.js';
import { maidRandomCardRerollArgs } from '../maid-result-cards.js';

const trim = value => String(value ?? '').trim();

export const MAID_BUILTIN_CAPABILITIES = Object.freeze({
  random: Object.freeze({
    id: 'random',
    title: '随机互动',
    // 技能页副标题：只写一个关键信息
    subtitle: '骰子 · 抽签 · 帮你选',
    purpose: '掷骰子、抽签、在几个选项里帮你选一个',
    network: '',
    tools: Object.freeze(['maid.random']),
  }),
});

export const describeMaidBuiltinCapability = id => MAID_BUILTIN_CAPABILITIES[trim(id)] || null;

// 技能页「内置能力」分组：说明 + 设置里的开关状态
export const listMaidBuiltinCapabilityStates = settingsStore => Object.values(MAID_BUILTIN_CAPABILITIES)
  .map(info => ({ ...info, enabled: false, lastUsedAt: 0, ...(settingsStore?.getBuiltinCapability?.(info.id) || {}) }));

// 均匀的随机整数 [0, max)：拒绝采样，避免取模偏差
const randomInt = (max, random = globalThis.crypto) => {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do { random.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max;
};

const createCardId = () => globalThis.crypto?.randomUUID?.() || `card-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * 随机结果（工具与结果卡的「再来一次」共用）：
 * dice 掷 count 个 sides 面骰；draw 从 options 里不放回抽 pick 个；choose 从 options 里选 1 个。
 */
export const rollMaidRandom = ({ mode = 'dice', count = 1, sides = 6, options = [], pick = 1 } = {}, { random = globalThis.crypto } = {}) => {
  if (mode === 'dice') {
    const diceCount = Math.min(10, Math.max(1, Math.trunc(Number(count) || 1)));
    const diceSides = Math.min(100, Math.max(2, Math.trunc(Number(sides) || 6)));
    const rolls = Array.from({ length: diceCount }, () => randomInt(diceSides, random) + 1);
    return { ok: true, mode, count: diceCount, sides: diceSides, rolls, total: rolls.reduce((sum, value) => sum + value, 0) };
  }
  const choices = [...new Set((Array.isArray(options) ? options : []).map(item => trim(item).slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (choices.length < 2) return { ok: false, reason: 'too_few_options', message: '至少要有两个不同的选项' };
  const wanted = mode === 'draw' ? Math.min(choices.length, Math.max(1, Math.trunc(Number(pick) || 1))) : 1;
  const pool = choices.slice();
  const picked = [];
  while (picked.length < wanted) picked.push(pool.splice(randomInt(pool.length, random), 1)[0]);
  return { ok: true, mode: mode === 'draw' ? 'draw' : 'choose', options: choices, picked };
};

// 结果卡数据只来自真实的随机结果；标题与「由 APP 随机生成」由渲染按种类给出（见 maid-result-cards.js）
export const buildMaidRandomCard = (result, { now = Date.now } = {}) => ({
  id: createCardId(),
  type: 'random',
  createdAt: now(),
  data: result.mode === 'dice'
    ? { mode: 'dice', sides: result.sides, rolls: result.rolls, total: result.total }
    : { mode: result.mode, options: result.options, picked: result.picked },
});

const capabilityOffResult = () => ({ ok: false, reason: 'capability_disabled', capabilityId: 'random', message: '「随机互动」没有开启；需要时先用 maid.capability.request_enable 请用户开启' });

/** 结果卡「再来一次」：和工具走同一个执行期检查（读最新开关），产生新卡，不改旧卡。 */
export const rerollMaidRandomCard = async (card, { settingsStore = null, random = globalThis.crypto, now = Date.now } = {}) => {
  if (!settingsStore?.getBuiltinCapability?.('random')?.enabled) {
    return { ...capabilityOffResult(), message: t('「{name}」已关闭，可在女仆设置 → 技能重新开启', { name: t(MAID_BUILTIN_CAPABILITIES.random.title) }) };
  }
  const args = maidRandomCardRerollArgs(card);
  const result = args ? rollMaidRandom(args, { random }) : { ok: false, reason: 'invalid_card' };
  if (!result.ok) return result;
  await settingsStore.markBuiltinCapabilityUsed?.('random');
  return { ok: true, card: buildMaidRandomCard(result, { now }) };
};

export const createMaidCapabilityAgentTools = ({
  getSettingsStore = () => null,
  random = globalThis.crypto,
  now = Date.now,
} = {}) => {
  const store = () => getSettingsStore();
  const pinnedRevisions = new WeakMap();

  const requestEnableTool = {
    name: 'maid.capability.request_enable',
    title: 'Ask the user to turn on a built-in capability',
    description: 'Ask the user to turn on a built-in Maid capability that is currently off (listed in <enableable_capabilities>). The user confirms in the APP; this persistently turns it on until they turn it off in Maid settings → Skills. Pass capabilityId and a short reason. If the user declines, do not ask again in this task.',
    source: 'maid-builtin-capability', permissions: [], riskLevel: 'medium',
    capabilities: { read: false, write: true, network: false, cost: 'none', undo: 'manual', modelContext: 'none', confirmation: 'required' },
    // 用户问「掷个骰子」属于只读请求：这里的确认就是开启确认本身，不再额外问「允许一次」
    metadata: { allowInReadOnlyIntent: true },
    schema: {
      type: 'object', additionalProperties: false, required: ['capabilityId'],
      properties: {
        capabilityId: { type: 'string', enum: Object.keys(MAID_BUILTIN_CAPABILITIES) },
        reason: { type: 'string', maxLength: 160 },
      },
    },
    safety: {
      operationType: 'enable_builtin_capability',
      destructive: 'conditional',
      description: 'Persistently turns on one built-in capability after the user confirms; writes only if the switch is unchanged since the confirmation was shown.',
      preflight: async (args = {}) => {
        const info = describeMaidBuiltinCapability(args.capabilityId);
        const current = info ? store()?.getBuiltinCapability?.(info.id) : null;
        if (!info || !current || current.enabled) return { destructive: false };
        pinnedRevisions.set(args, current.revision);
        // 确认卡上给用户看的文字按界面语言显示；拒绝后的结果是给模型看的
        const name = t(info.title);
        return {
          requiresConfirmation: true,
          kind: 'maid.capability.enable',
          operationType: 'enable_builtin_capability',
          title: t('开启「{name}」？', { name }),
          message: [
            t('开启后女仆可以直接{purpose}。', { purpose: t(info.purpose) }),
            info.network ? t('会联网到 {host}。', { host: info.network }) : '',
            t('会一直开着，可在女仆设置 → 技能随时关闭。'),
          ].filter(Boolean).join(''),
          confirmText: t('确认开启'),
          cancelText: t('不用了'),
          danger: false,
          allowAlways: false,
          argsPreview: { capabilityId: info.id, reason: trim(args.reason).slice(0, 160) },
          details: { purpose: 'persistent_enable', capabilityId: info.id, capabilityTitle: info.title, revision: current.revision },
          onDeny: {
            action: 'skip',
            reason: 'capability_enable_declined',
            result: { ok: false, enabled: false, reason: 'capability_enable_declined', capabilityId: info.id, message: `「${info.title}」这次没有开启（用户拒绝，或确认期间开关在设置里被改过）；本任务里不要再请求开启，若它已经开着可以直接用` },
          },
        };
      },
    },
    execute: async (args = {}) => {
      const info = describeMaidBuiltinCapability(args.capabilityId);
      const settings = store();
      if (!info || !settings?.setBuiltinCapabilityEnabled) return { ok: false, reason: 'unknown_capability' };
      const current = settings.getBuiltinCapability(info.id);
      if (current?.enabled) return { ok: true, enabled: true, alreadyEnabled: true, capabilityId: info.id };
      // 没经过确认（找不到确认时的版本）就不写
      if (!pinnedRevisions.has(args)) return { ok: false, reason: 'confirmation_missing', capabilityId: info.id };
      const result = await settings.setBuiltinCapabilityEnabled(info.id, true, { source: 'maid_request', expectedRevision: pinnedRevisions.get(args) });
      if (!result.ok) {
        return {
          ok: false, enabled: false, reason: result.reason, capabilityId: info.id,
          message: result.reason === 'revision_changed' ? '确认期间开关被改过，这次没有开启' : '保存失败，没有开启',
        };
      }
      return { ok: true, enabled: true, capabilityId: info.id, message: `已开启「${info.title}」` };
    },
    summarizeResult: result => (result?.ok ? `capability ${trim(result.capabilityId)} enabled` : `capability not enabled: ${trim(result?.reason)}`),
  };

  const randomTool = {
    name: 'maid.random',
    title: 'Random dice / draw / choose',
    description: 'Roll dice (mode dice: count 1-10, sides 2-100), draw lots without replacement (mode draw: options, pick), or pick one of several options (mode choose: options). The APP generates the result and shows it as a card; summarize it in one sentence without repeating every number.',
    source: 'maid-builtin-capability', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'none' },
    schema: {
      type: 'object', additionalProperties: false, required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['dice', 'draw', 'choose'] },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        sides: { type: 'integer', minimum: 2, maximum: 100 },
        options: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
        pick: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
    execute: async (args = {}) => {
      const settings = store();
      // 执行期检查：读最新开关，不信任路由时的快照
      if (!settings?.getBuiltinCapability?.('random')?.enabled) return capabilityOffResult();
      const result = rollMaidRandom(args, { random });
      if (!result.ok) return result;
      await settings.markBuiltinCapabilityUsed?.('random');
      return { ...result, card: buildMaidRandomCard(result, { now }) };
    },
    summarizeResult: result => (result?.ok ? `random ${trim(result.mode)}: ${result.mode === 'dice' ? result.rolls.join(',') : result.picked.join(',')}` : `random failed: ${trim(result?.reason)}`),
  };

  return [requestEnableTool, randomTool];
};

export const registerMaidCapabilityAgentTools = (registry, deps = {}) => {
  if (!registry?.registerMany) return [];
  return registry.registerMany(createMaidCapabilityAgentTools(deps));
};
