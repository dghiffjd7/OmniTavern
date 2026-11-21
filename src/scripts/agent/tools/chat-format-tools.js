import { t } from '../../i18n/index.js';
import { confirmRequest } from './preset-regex-script-tools.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeManualGuideText = value => String(value ?? '').replace(/\s+/gu, '').trim();

const isExplicitManualFormatOverride = (guide = '', context = {}) => {
  const input = trim(context?.maidUserInput || context?.userInput);
  const normalizedGuide = normalizeManualGuideText(guide);
  if (!input || !normalizedGuide || !normalizeManualGuideText(input).includes(normalizedGuide)) return false;
  return /(?:(?:手动|固定|记住|保存)[^。；;！？!?\n]{0,24}(?:格式|规范)|(?:格式|规范)[^。；;！？!?\n]{0,24}(?:手动|固定|记住|保存))/iu.test(input);
};

// 女仆消息质量工具（格式修复 §4.2 + 正文优化机制层）。
// 实际执行由 app.js 注入：repairMessageFormat（guardian 修复候选）/ optimizeMessage
// （优化模型产出替换文本）；两者都经行级 diff 确认后写回。
// 用户在 diff 弹窗取消时返回 ok:true + applied:false，模型不得重试。
export const createChatFormatRepairTools = ({
  repairMessageFormat = null,
  optimizeMessage = null,
  formatProfileStore = null,
  resolveSessionId = null,
  resolveFormatProfileSourceState = null,
} = {}) => {
  const resolveSid = (args = {}) => {
    if (typeof resolveSessionId === 'function') {
      return trim(resolveSessionId({
        sessionId: trim(args.sessionId),
        sessionName: trim(args.sessionName || args.target),
      }));
    }
    return trim(args.sessionId);
  };
  const resolveSourceState = async (sessionId, sources = []) => {
    if (typeof resolveFormatProfileSourceState !== 'function') return {};
    try {
      const result = await resolveFormatProfileSourceState({
        sessionId: trim(sessionId),
        sources: Array.isArray(sources) ? sources : [],
      });
      return result && typeof result === 'object' ? result : {};
    } catch {
      return {};
    }
  };
  // 保存格式画像前的核对（preflight 与 execute 共用）：不能保存时返回原因，能保存时返回要写入的内容
  const planFormatProfileSave = async (args = {}, context = {}) => {
    if (!formatProfileStore || typeof formatProfileStore.set !== 'function') {
      return { ok: false, reason: 'format_profile_store_unavailable' };
    }
    const sid = resolveSid(args);
    if (!sid) return { ok: false, reason: 'session_not_found', message: '没有找到目标会话。' };
    const sources = Array.isArray(args.sources) ? args.sources : [];
    const sourceState = await resolveSourceState(sid, sources);
    const sourceTypes = new Set(sources.map(item => trim(item?.type).toLowerCase()).filter(Boolean));
    const hasRegexSource = sourceTypes.has('regex');
    const hasCorroboratingSource = ['preset', 'worldbook', 'world', 'persona', 'character', 'character_card', 'character-card']
      .some(type => sourceTypes.has(type));
    const guide = trim(args.guide);
    const manualOverride = args.manualOverride === true;
    if (manualOverride && !isExplicitManualFormatOverride(guide, context)) {
      return {
        ok: false,
        reason: 'manual_format_override_not_explicit',
        message: '只有用户在本轮原话中明确给出完整格式规范并要求手动保存时，才能建立手动覆盖画像。请勿把模型推断标成手动；需要时请用户提供完整规范。',
      };
    }
    const evidence = (Array.isArray(sourceState?.evidence) ? sourceState.evidence : [])
      .filter(item => (Array.isArray(item?.markers) ? item.markers : []).some((marker) => {
        const [opening = '', closing = ''] = String(marker || '').split('...');
        return opening && closing && guide.includes(opening) && guide.includes(closing);
      }));
    if (!manualOverride && hasRegexSource && !hasCorroboratingSource && evidence.length === 0) {
      return {
        ok: false,
        reason: 'regex_format_evidence_untrusted',
        message: '当前启用正则只有清理/显示用途或缺少高置信结构证据，不能据此保存必需输出格式。请继续核对预设、世界书或角色卡；仍无法确认时请用户补充格式规范。',
      };
    }
    const confidence = manualOverride
      ? 'high'
      : (hasCorroboratingSource
      ? 'medium'
      : (evidence.some(item => item?.confidence === 'high') ? 'high' : 'low'));
    return { ok: true, sid, sources, sourceState, guide, manualOverride, evidence, confidence };
  };
  const formatSourcesKey = list => (Array.isArray(list) ? list : [])
    .map(item => `${trim(item?.type).toLowerCase()}:${trim(item?.ref)}`).join('|');
  return [
  {
    name: 'chat.save_format_profile',
    title: 'Save session format profile',
    description: 'Cache a custom format spec after source investigation. Regex-only profiles are accepted only when the APP extracted high-confidence structural evidence; raw replacements are never trusted as instructions.',
    source: 'maid-chat-format',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'manual',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      required: ['guide'],
      additionalProperties: false,
      properties: {
        guide: { type: 'string', minLength: 8, maxLength: 6000 },
        sessionId: { type: 'string', maxLength: 160 },
        sessionName: { type: 'string', maxLength: 160 },
        target: { type: 'string', maxLength: 160 },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: { type: 'string', maxLength: 40 },
              ref: { type: 'string', maxLength: 160 },
            },
          },
        },
        manualOverride: {
          type: 'boolean',
          description: 'Only true when the user explicitly supplied the complete guide text in the current request and asked to save it as a manual format override.',
        },
      },
    },
    safety: {
      operationType: 'save_format_profile',
      destructive: 'conditional',
      // 保存前确认；核对不过（execute 会拒绝）或与已存画像完全相同（规范、来源、来源指纹都没变）时不弹确认
      preflight: async (args = {}, context = {}) => {
        const plan = await planFormatProfileSave(args, context);
        if (!plan.ok) return { destructive: false, operationType: 'save_format_profile' };
        const existing = typeof formatProfileStore.peek === 'function'
          ? formatProfileStore.peek(plan.sid)
          : formatProfileStore.get?.(plan.sid);
        const unchanged = Boolean(existing) &&
          trim(existing.guide) === plan.guide &&
          (existing.manualOverride === true) === plan.manualOverride &&
          formatSourcesKey(existing.sources) === formatSourcesKey(plan.sources) &&
          trim(existing.sourceFingerprint) === trim(plan.sourceState?.fingerprint || plan.sourceState?.sourceFingerprint);
        if (unchanged) return { destructive: false, operationType: 'save_format_profile' };
        const session = trim(args.sessionName || args.target) || plan.sid;
        return confirmRequest({
          kind: 'chat.save_format_profile',
          operationType: 'save_format_profile',
          title: t('保存格式画像'),
          message: existing
            ? t('将更新会话「{session}」的格式画像，之后修复该会话格式时会自动使用。', { session })
            : t('将为会话「{session}」保存格式画像，之后修复该会话格式时会自动使用。', { session }),
          confirmText: t('保存'),
          danger: false,
          items: [{ id: 'guide', label: plan.guide.length > 160 ? `${plan.guide.slice(0, 159)}…` : plan.guide, meta: t('格式规范') }],
          denyReason: 'format_profile_save_cancelled',
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const plan = await planFormatProfileSave(args, context);
      if (!plan.ok) return plan;
      const { sid, sources, sourceState, guide, manualOverride, evidence, confidence } = plan;
      const saved = formatProfileStore.set(sid, {
        guide,
        sources,
        sourceFingerprint: trim(sourceState?.fingerprint || sourceState?.sourceFingerprint),
        sourceRevisions: sourceState?.sourceRevisions,
        evidence,
        confidence,
        manualOverride,
      });
      if (!saved) return { ok: false, reason: 'format_profile_invalid', message: '格式规范内容为空或无效。' };
      return {
        ok: true,
        sessionId: saved.sessionId,
        guidePreview: saved.guide.slice(0, 120),
        sourceCount: Array.isArray(saved.sources) ? saved.sources.length : 0,
        evidenceCount: Array.isArray(saved.evidence) ? saved.evidence.length : 0,
        confidence: trim(saved.confidence, confidence),
        manualOverride: saved.manualOverride === true,
        message: `已保存「${saved.sessionId}」的格式画像，之后修复该会话格式时会自动使用。`,
      };
    },
    summarizeResult: result => (result?.ok === false
      ? `format profile save failed: ${trim(result?.reason, 'unknown')}`
      : `format profile saved for ${trim(result?.sessionId)}`),
  },
  {
    name: 'chat.read_format_profile',
    title: 'Read session format profile',
    description: 'Read the cached custom format spec of a session. If staleProfile is returned, its sources changed and must be investigated again before repair.',
    source: 'maid-chat-format',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: false,
      cost: 'none',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sessionId: { type: 'string', maxLength: 160 },
        sessionName: { type: 'string', maxLength: 160 },
        target: { type: 'string', maxLength: 160 },
      },
    },
    execute: async (args = {}) => {
      if (!formatProfileStore || typeof formatProfileStore.get !== 'function') {
        return { ok: false, reason: 'format_profile_store_unavailable' };
      }
      const sid = resolveSid(args);
      if (!sid) return { ok: false, reason: 'session_not_found', message: '没有找到目标会话。' };
      const cached = typeof formatProfileStore.peek === 'function'
        ? formatProfileStore.peek(sid)
        : formatProfileStore.get(sid);
      const sourceState = await resolveSourceState(sid, cached?.sources || []);
      const profile = formatProfileStore.get(sid, sourceState);
      const usableProfile = profile?.usable !== false ? profile : null;
      const staleProfile = profile?.stale === true ? {
        sessionId: profile.sessionId,
        sources: profile.sources,
        updatedAt: profile.updatedAt,
        sourceChanged: profile.sourceChanged,
        staleReasons: profile.staleReasons,
        manualOverride: profile.manualOverride,
      } : null;
      return {
        ok: true,
        sessionId: sid,
        hasProfile: Boolean(usableProfile),
        profile: usableProfile,
        staleProfile,
        message: staleProfile && !usableProfile
          ? '该会话的旧格式画像来源已变化或提取规则已升级，请重新调查来源后保存。'
          : (usableProfile
            ? (staleProfile ? '已读取用户手动格式画像；来源已有变化，请留意重新核对。' : '已读取该会话的格式画像。')
            : '该会话还没有保存过格式画像。'),
      };
    },
    summarizeResult: result => (result?.ok === false
      ? `format profile read failed: ${trim(result?.reason, 'unknown')}`
      : `format profile ${result?.hasProfile ? 'found' : 'absent'} for ${trim(result?.sessionId)}`),
  },
  {
    name: 'chat.optimize_message',
    title: 'Optimize assistant message text',
    description: 'Rewrite an assistant reply per the user instruction (polish, dedupe, adjust style); the user confirms a line diff before anything is written back.',
    source: 'maid-chat-format',
    permissions: [],
    riskLevel: 'medium',
    capabilities: {
      read: true,
      write: true,
      network: false,
      cost: 'variable',
      undo: 'manual',
      modelContext: 'allowlist',
      confirmation: 'required',
    },
    safety: {
      operationType: 'write',
      destructive: false,
      description: '写回前必须经用户在行级 diff 弹窗确认；取消即不写入。',
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: { type: 'string', maxLength: 120 },
        sessionId: { type: 'string', maxLength: 160 },
        sessionName: { type: 'string', maxLength: 160 },
        target: { type: 'string', maxLength: 160 },
        instruction: { type: 'string', maxLength: 2000 },
      },
    },
    execute: async (args = {}) => {
      if (typeof optimizeMessage !== 'function') {
        return { ok: false, reason: 'body_optimize_unavailable' };
      }
      return optimizeMessage({
        messageId: trim(args.messageId),
        sessionId: trim(args.sessionId),
        sessionName: trim(args.sessionName || args.target),
        instruction: trim(args.instruction),
        source: 'maid',
      });
    },
    summarizeResult: (result) => {
      if (result?.ok === false) return `body optimize failed: ${trim(result?.reason, 'unknown')}`;
      if (result?.applied === true) return `body optimize applied (+${Number(result?.added || 0)}/-${Number(result?.removed || 0)})`;
      if (result?.userDecision === 'cancelled') return 'body optimize cancelled by user in diff preview';
      return trim(result?.message, 'body optimize finished without changes');
    },
  },
  {
    name: 'chat.repair_message_format',
    title: 'Repair assistant message format',
    description: 'Repair a format-broken assistant reply via the format guardian; the user confirms a line diff before anything is written back.',
    source: 'maid-chat-format',
    permissions: [],
    riskLevel: 'medium',
    capabilities: {
      read: true,
      write: true,
      network: false,
      cost: 'variable',
      undo: 'manual',
      modelContext: 'allowlist',
      confirmation: 'required',
    },
    safety: {
      operationType: 'write',
      destructive: false,
      description: '写回前必须经用户在行级 diff 弹窗确认；取消即不写入。',
    },
    metadata: {
      // 工具产出的是 diff 提案，落盘必经 hunk 审阅 +「同意一次」确认（无自动应用路径）；
      // 只读意图下允许发起（预览后取消属合法只读流程），确认闸仍在 UI 层。
      allowInReadOnlyIntent: true,
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        messageId: { type: 'string', maxLength: 120 },
        sessionId: { type: 'string', maxLength: 160 },
        sessionName: { type: 'string', maxLength: 160 },
        target: { type: 'string', maxLength: 160 },
        formatHint: { type: 'string', maxLength: 4000 },
      },
    },
    execute: async (args = {}) => {
      if (typeof repairMessageFormat !== 'function') {
        return { ok: false, reason: 'format_repair_unavailable' };
      }
      return repairMessageFormat({
        messageId: trim(args.messageId),
        sessionId: trim(args.sessionId),
        sessionName: trim(args.sessionName || args.target),
        formatHint: trim(args.formatHint),
        source: 'maid',
      });
    },
    summarizeResult: (result) => {
      if (result?.ok === false) return `format repair failed: ${trim(result?.reason, 'unknown')}`;
      if (result?.applied === true) return `format repair applied (+${Number(result?.added || 0)}/-${Number(result?.removed || 0)})`;
      if (result?.userDecision === 'cancelled') return 'format repair cancelled by user in diff preview';
      return trim(result?.message, 'format repair finished without changes');
    },
  },
  ];
};

export const registerChatFormatRepairTools = (registry, deps = {}) => {
  const tools = createChatFormatRepairTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
