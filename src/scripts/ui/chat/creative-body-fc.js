// 防截断传输：创意写作（rp）的正文改由函数调用的参数传回，不走普通文字通道。
// 只给一个正文工具并强制调用；生成参数照旧跟预设与设置档。返回时把参数里的 content
// 逐段解码成文字，交回原本的流式／存档链路，后面的显示、正则与协议解析都不用动。
// 思路参考社区预设的防截断做法（Izumi、Kemini），代码与文字均为本应用自写。
import {
  PROVIDER_FC_TOOL_CHOICE_MODES,
  buildProviderFcRequestPlan,
  resolveProviderFcTransport,
} from '../../agent/provider-fc-transport.js';
import { createProviderToolCallDeltaAccumulator } from '../../agent/provider-tool-call-delta-adapter.js';
import { getLocalizedPromptText } from '../../i18n/prompt-locale.js';
import { t } from '../../i18n/index.js';
import { resolveRequestConfigProfileId } from './request-config-profile-utils.js';

export const CREATIVE_BODY_FC_TOOL_NAME = 'submit_reply';

const CLEAN_FINISH_REASONS = new Set(['stop', 'tool_calls', 'function_call', 'end_turn', 'tool_use', 'stop_sequence', 'completed']);

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const trim = value => String(value ?? '').trim();

export const buildCreativeBodyFcTool = () => ({
  type: 'function',
  function: {
    name: CREATIVE_BODY_FC_TOOL_NAME,
    // 原文在 prompt-locale.js 的 CANONICAL_RUNTIME_PROMPT_DEFAULTS，en / zh-TW 在 prompt-locales
    description: getLocalizedPromptText('creative_body_fc.tool_description'),
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: getLocalizedPromptText('creative_body_fc.content_description'),
        },
      },
      required: ['content'],
    },
  },
});

// Vertex 的 streamFunctionCallArguments 只有部分模型认（实测 gemini-2.5-flash 回 400）：
// 被拒过的「服务商:模型」记在这里，之后不再带这个参数
const streamedArgumentsRejected = new Set();
const streamedArgumentsKey = (provider, model) => `${trim(provider).toLowerCase()}:${trim(model).toLowerCase()}`;
const isStreamedArgumentsRejection = error => /stream(?:ing)? function call arguments/iu.test(String(error?.message || ''));
const hasStreamedArguments = options => options?.toolConfig?.functionCallingConfig?.streamFunctionCallArguments !== undefined;
const withoutStreamedArguments = (options = {}) => {
  if (!hasStreamedArguments(options)) return options;
  const { streamFunctionCallArguments: _dropped, ...functionCallingConfig } = options.toolConfig.functionCallingConfig;
  return { ...options, toolConfig: { ...options.toolConfig, functionCallingConfig } };
};

// 请求里已经有工具或指定了工具选择（联网搜索、APP 工具循环等）时，强制只调用正文工具会挡掉它们
const hasCallerProvidedTools = (options = {}) => (
  (Array.isArray(options.tools) && options.tools.length > 0)
  || options.tool_choice !== undefined
  || options.toolConfig !== undefined
);

const readThinkingType = options => trim(options?.thinking?.type).toLowerCase();

/**
 * 决定本轮是否启用防截断传输。notice 为 true 的跳过原因要提示用户（开关开着却没生效）；
 * 接口不支持这类长期状态由 AC 卡片说明，不逐轮提示。
 */
export const planCreativeBodyFc = ({
  enabled = false,
  uiMode = '',
  config = {},
  requestOptions = {},
  presetRequestSession = null,
  phoneRoute = false,
} = {}) => {
  if (enabled !== true) return { active: false, reason: 'disabled', notice: false };
  if (trim(uiMode).toLowerCase() !== 'rp' || phoneRoute) return { active: false, reason: 'not_creative', notice: false };
  if (hasCallerProvidedTools(requestOptions)) return { active: false, reason: 'caller_tools', notice: true };
  if (presetRequestSession && presetRequestSession.bypass !== true) {
    // 预设请求通道会接管 onProviderToolCallDelta，正文参数到不了这里
    return { active: false, reason: 'preset_request_session', notice: true };
  }
  const transport = resolveProviderFcTransport(config);
  if (!transport.supported) return { active: false, reason: 'unsupported_provider', detail: transport.reason, notice: false };
  const thinkingType = readThinkingType(requestOptions);
  const plan = buildProviderFcRequestPlan({
    config,
    tools: [buildCreativeBodyFcTool()],
    toolChoiceMode: PROVIDER_FC_TOOL_CHOICE_MODES.forcedTerminal,
    thinkingEnabled: thinkingType === 'enabled' || thinkingType === 'adaptive',
    reasoningOptions: isPlainObject(requestOptions.thinking) ? { thinking: requestOptions.thinking } : {},
  });
  if (!plan.ok) {
    const thinkingConflict = /thinking/u.test(plan.reason);
    return { active: false, reason: thinkingConflict ? 'thinking_incompatible' : 'unsupported_provider', detail: plan.reason, notice: thinkingConflict };
  }
  // 手机 FC 遇到 DeepSeek 思考会关掉思考；正文的思考是用户在预设里开的，这里不改，改为本轮不启用
  if (plan.diagnostics?.thinkingOverrideReason) {
    return { active: false, reason: 'thinking_incompatible', detail: plan.diagnostics.thinkingOverrideReason, notice: true };
  }
  const next = JSON.parse(JSON.stringify(plan.requestOptions || {}));
  if (trim(config?.provider).toLowerCase() === 'vertexai' && isPlainObject(next.toolConfig?.functionCallingConfig)
    && !streamedArgumentsRejected.has(streamedArgumentsKey(config?.provider, config?.model))) {
    next.toolConfig.functionCallingConfig.streamFunctionCallArguments = true;
  }
  return {
    active: true,
    reason: '',
    notice: false,
    requestOptions: next,
    provider: trim(config?.provider).toLowerCase(),
    model: trim(config?.model),
  };
};

// {"content": "…"} 的逐段读取：参数文字只会往后长，从上次读到的位置继续；残缺的转义先不输出
const createContentFieldReader = () => {
  let start = -1;
  let position = 0;
  let output = '';
  let closed = false;
  const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  return (text = '') => {
    const raw = String(text || '');
    if (start < 0) {
      const match = /^\s*\{\s*"content"\s*:\s*"/u.exec(raw);
      if (!match) return output;
      start = match[0].length;
      position = start;
    }
    while (!closed && position < raw.length) {
      const char = raw[position];
      if (char === '"') { closed = true; break; }
      if (char !== '\\') { output += char; position += 1; continue; }
      if (position + 1 >= raw.length) break;
      const code = raw[position + 1];
      if (code === 'u') {
        if (position + 6 > raw.length) break;
        const value = Number.parseInt(raw.slice(position + 2, position + 6), 16);
        output += Number.isFinite(value) ? String.fromCharCode(value) : '';
        position += 6;
        continue;
      }
      output += escapes[code] ?? code;
      position += 2;
    }
    return output;
  };
};

const readFinishReason = (data = {}) => {
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  if (candidate?.finishReason) return String(candidate.finishReason);
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (choice?.finish_reason) return String(choice.finish_reason);
  if (trim(data?.type) === 'message_delta' && data?.delta?.stop_reason) return String(data.delta.stop_reason);
  if (data?.stop_reason) return String(data.stop_reason);
  if (trim(data?.type) === 'response.completed') return 'completed';
  if (trim(data?.type) === 'response.incomplete') return String(data?.response?.incomplete_details?.reason || 'incomplete');
  return '';
};

/** 正文工具的逐段解码：push 回传本次新增的正文文字，finish 回传收尾状态。 */
export const createCreativeBodyFcDecoder = ({ provider = '', model = '' } = {}) => {
  const accumulator = createProviderToolCallDeltaAccumulator({ provider, model });
  const readers = new Map();
  let emitted = '';
  let toolStarted = false;
  let toolCompleted = false;
  let finalContent = null;
  let finishReason = '';

  const currentContent = () => {
    if (finalContent !== null) return finalContent;
    const state = accumulator.getSnapshot().find(item => !item.toolName || item.toolName === CREATIVE_BODY_FC_TOOL_NAME);
    if (!state) return emitted;
    if (state.toolName === CREATIVE_BODY_FC_TOOL_NAME) toolStarted = true;
    if (isPlainObject(state.arguments) && typeof state.arguments.content === 'string') return state.arguments.content;
    if (!readers.has(state.key)) readers.set(state.key, createContentFieldReader());
    return readers.get(state.key)(state.argumentsText);
  };

  // 只输出接在已输出内容后面的部分；结尾的半个代理对留到下一段
  const takeSuffix = (content) => {
    if (!content.startsWith(emitted)) return '';
    let suffix = content.slice(emitted.length);
    const last = suffix.charCodeAt(suffix.length - 1);
    if (finalContent === null && last >= 0xd800 && last <= 0xdbff) suffix = suffix.slice(0, -1);
    emitted += suffix;
    return suffix;
  };

  return {
    push(data = {}, meta = {}) {
      const reason = readFinishReason(data);
      if (reason) finishReason = reason;
      const { completed } = accumulator.push(data, { provider: trim(meta?.provider) || provider, model: trim(meta?.model) || model });
      const call = completed.find(item => item.toolName === CREATIVE_BODY_FC_TOOL_NAME);
      if (call) {
        toolStarted = true;
        toolCompleted = true;
        finalContent = typeof call.arguments?.content === 'string' ? call.arguments.content : currentContent();
      }
      return takeSuffix(currentContent());
    },
    finish() {
      const content = currentContent();
      const remainder = takeSuffix(content);
      return { toolStarted, toolCompleted, toolContent: emitted, finishReason, remainder };
    },
  };
};

export const resolveCreativeBodyFcOutcome = ({
  toolStarted = false,
  toolCompleted = false,
  toolContent = '',
  plainText = '',
  finishReason = '',
} = {}) => {
  const reason = String(finishReason || '');
  const abnormalFinish = Boolean(reason) && !CLEAN_FINISH_REASONS.has(reason.toLowerCase());
  if (toolContent) {
    return { outcome: 'transported', text: toolContent, incomplete: !toolCompleted || abnormalFinish, finishReason: reason };
  }
  if (trim(plainText)) return { outcome: 'no_tool_call', text: String(plainText), incomplete: abnormalFinish, finishReason: reason };
  return { outcome: 'empty', text: '', incomplete: toolStarted || abnormalFinish, finishReason: reason };
};

// 完全没取到正文：交给原本的错误处理（不然会留下一条空回复）
const emptyReplyError = () => Object.assign(new Error(t('模型返回了空回复（防截断传输没有取到正文）')), { code: 'creative_body_fc_empty' });

const withDecoderCallback = (options = {}, decoder, onText = null) => {
  const previous = options.onProviderToolCallDelta;
  return {
    ...options,
    onProviderToolCallDelta: (data, meta) => {
      try { previous?.(data, meta); } catch {}
      const text = decoder.push(data, meta);
      if (text) onText?.(text);
    },
  };
};

/**
 * 流式：参数片段在服务商回调里到达（这期间服务商的流不一定有东西可吐），
 * 所以用队列把解码出的正文、思考事件与其他事件按到达顺序交出去。
 * 普通文字先暂存，只有完全没调用工具时才补上。
 */
export const streamCreativeBodyFc = ({
  streamChat,
  options = {},
  decoder,
  isReasoningEvent = () => false,
  onOutcome = () => {},
  provider = '',
  model = '',
} = {}) => {
  const queue = [];
  let wake = null;
  let ended = false;
  let failure = null;
  let plainText = '';
  const push = (item) => {
    queue.push(item);
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  let delivered = false;
  const consume = async (requestOptions) => {
    const stream = streamChat(withDecoderCallback(requestOptions, decoder, (text) => { delivered = true; push(text); }));
    for await (const chunk of stream) {
      if (isReasoningEvent(chunk)) { delivered = true; push(chunk); }
      else if (typeof chunk === 'string') plainText += chunk;
      else if (chunk !== undefined && chunk !== null) { delivered = true; push(chunk); }
    }
  };
  (async () => {
    try {
      try {
        await consume(options);
      } catch (error) {
        // 模型不认分段参数：还没交出任何内容时，记下来并去掉参数重试一次
        if (delivered || !hasStreamedArguments(options) || !isStreamedArgumentsRejection(error)) throw error;
        streamedArgumentsRejected.add(streamedArgumentsKey(provider, model));
        plainText = '';
        await consume(withoutStreamedArguments(options));
      }
      const end = decoder.finish();
      if (end.remainder) push(end.remainder);
      const outcome = resolveCreativeBodyFcOutcome({ ...end, plainText });
      if (outcome.outcome === 'empty') throw emptyReplyError();
      if (outcome.outcome === 'no_tool_call') push(outcome.text);
      try { onOutcome(outcome); } catch {}
    } catch (error) {
      failure = error;
    } finally {
      ended = true;
      const resolve = wake;
      wake = null;
      resolve?.();
    }
  })();
  return (async function* () {
    while (true) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (failure) throw failure;
      if (ended) return;
      await new Promise((resolve) => { wake = resolve; });
    }
  })();
};

/** 非流式：服务商把完整回应交给 onProviderToolCallDelta，从中取出正文。 */
export const chatCreativeBodyFc = async ({ chat, options = {}, decoder } = {}) => {
  // 非流式用不到分段参数，也免得较旧模型因此回 400
  const plain = await chat(withDecoderCallback(withoutStreamedArguments(options), decoder));
  const end = decoder.finish();
  const plainText = typeof plain === 'string' ? plain : String(plain?.content ?? '');
  const outcome = resolveCreativeBodyFcOutcome({ ...end, plainText });
  if (outcome.outcome === 'empty') throw emptyReplyError();
  return outcome;
};

// 轻提示（右上角）：开关开着却没生效、没调用工具、可能不完整才提示；接口不支持由 AC 卡片说明，不逐轮提示
const SKIP_NOTICES = {
  caller_tools: '请求带有其他工具，本轮未启用防截断传输',
  preset_request_session: '预设脚本接管了本轮请求，未启用防截断传输',
  thinking_incompatible: '当前模型开着思考时不支持强制工具调用，本轮未启用防截断传输',
};

export const describeCreativeBodyFcNotice = ({ reason = '', outcome = '', incomplete = false } = {}) => {
  if (incomplete) return { level: 'warning', message: t('防截断传输：上游提前断流，本条回复可能不完整') };
  if (outcome === 'no_tool_call') return { level: 'info', message: t('防截断传输：模型这轮没有调用工具，已按普通文字输出') };
  return SKIP_NOTICES[reason] ? { level: 'info', message: t(SKIP_NOTICES[reason]) } : null;
};

/**
 * AC「正文生成」卡片的开关：显示本会话实际用的设置档（会话绑定 > 模式绑定 > 全局）并读写它的值。
 * 读写都用 bridge 的设置档（发请求时读的就是它）；写入后由 onChanged 让设置面板那份重新载入，
 * 免得之后在面板保存时把开关盖回旧值。
 */
export const createBodyToolTransportSetting = ({ getConfigManager = () => null, presetStore = null, onChanged = async () => {} } = {}) => {
  const describe = (sessionId = '') => {
    const manager = getConfigManager();
    if (!manager) return { available: false };
    const resolved = resolveRequestConfigProfileId({ presetStore, sessionId, uiMode: 'rp' });
    const profileId = trim(resolved?.profileId) || trim(manager.getActiveProfileId?.());
    const profile = profileId ? manager.getProfileById?.(profileId) : null;
    if (!profile) return { available: false };
    return {
      available: true,
      profileId,
      profileName: String(profile.name || ''),
      enabled: profile.bodyToolTransport === true,
      supported: resolveProviderFcTransport(profile).supported === true,
    };
  };
  return {
    describe,
    async set(sessionId = '', enabled = false) {
      const view = describe(sessionId);
      if (!view.available) return false;
      const saved = await getConfigManager().setProfileBodyToolTransport(view.profileId, enabled === true);
      if (saved) await onChanged();
      return saved === true;
    },
  };
};

// 普通文字模式下的截断判断：以接口回报的结束原因为准（用户记录里 Vertex 约五分之一是 SAFETY）。
// 达到输出上限（MAX_TOKENS / length）不算，那是上限太低；OTHER、RECITATION、refusal 这类防截断传输未必救得了，不提示。
const CENSORED_FINISH_REASONS = new Set(['safety', 'prohibited_content', 'blocklist', 'spii', 'content_filter']);
const CUT_FINISH_REASONS = new Set(['error']);
// 会稳定回报结束原因的服务商：回报了用量却没有结束原因，视为流没有正常结束；其余（如自建接口）不猜
const FINISH_REASON_REPORTING_PROVIDERS = new Set(['vertexai', 'makersuite', 'gemini', 'openai', 'openrouter', 'deepseek', 'anthropic']);

export const classifyReplyTruncation = ({ provider = '', finishReason = '', usageReported = false } = {}) => {
  const reason = trim(finishReason).toLowerCase();
  if (CENSORED_FINISH_REASONS.has(reason)) return { truncated: true, reason: 'safety' };
  if (CUT_FINISH_REASONS.has(reason)) return { truncated: true, reason: 'stream_cut' };
  if (!reason && usageReported && FINISH_REASON_REPORTING_PROVIDERS.has(trim(provider).toLowerCase())) {
    return { truncated: true, reason: 'stream_cut' };
  }
  return { truncated: false, reason: '' };
};

// 开关关着却遇到截断时，右上角提示一次（同一会话本次运行只提示一次），点击跳到卡片的开关
const truncationHintedSessions = new Set();

export const planCreativeBodyFcTruncationHint = ({
  plan = {},
  uiMode = '',
  phoneRoute = false,
  previewOnly = false,
  config = {},
  usage = null,
  sessionId = '',
} = {}) => {
  if (previewOnly || phoneRoute || plan?.active || plan?.reason !== 'disabled') return { show: false };
  if (trim(uiMode).toLowerCase() !== 'rp') return { show: false };
  const truncation = classifyReplyTruncation({ provider: config?.provider, finishReason: usage?.finishReason, usageReported: Boolean(usage) });
  if (!truncation.truncated || !resolveProviderFcTransport(config).supported) return { show: false };
  const key = trim(sessionId) || 'default';
  if (truncationHintedSessions.has(key)) return { show: false };
  truncationHintedSessions.add(key);
  return {
    show: true,
    reason: truncation.reason,
    message: truncation.reason === 'safety'
      ? t('这条回复被内容审查中途截断了。点这里打开「防截断传输」')
      : t('这条回复中途断掉了，可能不完整。点这里打开「防截断传输」'),
  };
};
