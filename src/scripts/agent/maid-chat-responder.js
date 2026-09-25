import {
  DEFAULT_MAID_PROMPT,
  getLocalizedMaidOperationSafetyPrompt,
  getLocalizedMaidOutputLanguagePrompt,
  getLocalizedMaidPrompt,
} from './maid-prompt-defaults.js';
import {
  buildAppFeatureSearchContextText,
  getMaidModelFeatureContext,
  listAppFeatures,
} from './app-feature-catalog.js';
import {
  extractMaidModelPlannerJson,
  resolveMaidConversationContextSnapshot,
} from './maid-model-planner.js';
import {
  buildMaidImageAttachmentSummary,
  buildMaidUserContentWithImages,
  getMaidImageAttachmentsFromContext,
} from './maid-attachment-parts.js';
import { isMaidUserAbort } from './maid-failure-codes.js';
import { buildMaidGenerationOptions } from './maid-generation-settings.js';
import { MAID_MEMORY_REFERENCE_RULE, buildMaidMemoryPromptBlock } from './maid-memory-prompt.js';
import { MAID_SKILL_INSTRUCTIONS, buildMaidSkillContextPrompt, assertMaidSkillRequestBudget } from './maid-skill-context.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const truncate = (value = '', max = 6000) => {
  const text = trim(value);
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}...`;
};

const safeJsonStringify = (value, max = 6000) => {
  try {
    return truncate(JSON.stringify(value, null, 2), max);
  } catch {
    return truncate(String(value ?? ''), max);
  }
};

const isToolPlanLikeJson = value => (
  isPlainObject(value) &&
  (
    trim(value.toolName) ||
    trim(value.featureId) ||
    trim(value.action).toLowerCase() === 'tool'
  )
);

const detectToolPlanLikeChatResponse = (text = '') => {
  const parsed = extractMaidModelPlannerJson(text);
  if (isToolPlanLikeJson(parsed)) return parsed;
  const raw = trim(text);
  if (!raw) return null;
  if (/"toolName"\s*:|["']action["']\s*:\s*["']tool["']|["']featureId["']\s*:/i.test(raw)) {
    return { rawText: truncate(raw, 1000) };
  }
  return null;
};

const emitDebugSnapshot = (callback, payload = {}, logger = console) => {
  if (typeof callback !== 'function') return;
  try {
    callback(payload);
  } catch (error) {
    logger?.debug?.('maid chat responder debug snapshot failed', error);
  }
};

export const buildMaidChatResponderMessages = ({
  input = '',
  context = {},
  conversationContext = null,
  features = listAppFeatures(),
  maidPrompt = DEFAULT_MAID_PROMPT,
} = {}) => {
  const modelFeatureContext = getMaidModelFeatureContext(features);
  const appContext = buildAppFeatureSearchContextText(input, {
    features: modelFeatureContext.features,
    limit: 5,
  });
  const memoryText = trim(conversationContext?.memoryText);
  const historyText = trim(conversationContext?.historyText);
  const observationText = context?.maidToolObservation
    ? safeJsonStringify(context.maidToolObservation, 9000)
    : '';
  const imageAttachments = getMaidImageAttachmentsFromContext(context);
  const imageSummary = buildMaidImageAttachmentSummary(imageAttachments);
  const userText = [
    buildMaidSkillContextPrompt(context.maidSkillContext),
    `用户输入：${trim(input)}`,
    imageSummary ? `用户附图：\n${imageSummary}` : '',
    `当前会话：${trim(context?.sessionId, '-')}`,
    `UI 模式：${trim(context?.uiMode, '-')}`,
    `当前页面：${trim(context?.activePage, '-')}`,
    buildMaidMemoryPromptBlock({ memoryText, historyText }),
    `APP 相关讯息：\n${appContext}`,
    observationText ? `已执行工具观察结果：\n${observationText}` : '',
  ].filter(Boolean).join('\n');
  return [
    {
      role: 'system',
      content: [
        getLocalizedMaidPrompt(trim(maidPrompt, DEFAULT_MAID_PROMPT)),
        getLocalizedMaidOperationSafetyPrompt(),
        modelFeatureContext.awareness,
        '你可以参考 <maid_memory> 和 <maid_history> 来延续对话、理解“刚才那个”等省略指代；不要编造不存在的历史。',
        MAID_MEMORY_REFERENCE_RULE,
        context.maidSkillContext ? MAID_SKILL_INSTRUCTIONS : '',
        observationText ? '如果提供了工具观察结果，请基于观察结果直接回答用户本次问题；不要只说已查看，也不要输出 JSON。' : '',
        getLocalizedMaidOutputLanguagePrompt(),
      ].filter(Boolean).join('\n'),
    },
    {
      role: 'user',
      content: buildMaidUserContentWithImages(userText, imageAttachments),
    },
  ];
};

export const createMaidChatResponder = ({
  resolveRuntimeConfig = null,
  createClient = null,
  isConfigReady = () => false,
  getConversationContext = null,
  onContextInjected = null,
  onDebugSnapshot = null,
  logger = console,
} = {}) => async (input = '', context = {}) => {
  const text = trim(input);
  if (!text) {
    return {
      ok: false,
      status: 'empty',
      reason: 'empty_input',
      message: '请输入想和女仆说的话。',
    };
  }
  if (typeof resolveRuntimeConfig !== 'function') {
    return {
      ok: false,
      status: 'unavailable',
      reason: 'maid_runtime_unavailable',
      message: '女仆还没有可用的 API 配置。',
    };
  }

  let runtime = null;
  try {
    runtime = await resolveRuntimeConfig({
      sessionId: trim(context?.sessionId),
      uiMode: trim(context?.uiMode),
      taskType: 'maid_chat',
      voiceCallId: trim(context?.voiceCallId),
    });
  } catch (error) {
    logger?.warn?.('maid chat responder runtime unavailable', error);
    return {
      ok: false,
      status: 'failed',
      reason: error?.message || 'maid_runtime_error',
      message: '女仆暂时无法连接 API。',
      error,
    };
  }

  let client = runtime?.client || null;
  const config = isPlainObject(runtime?.config) ? runtime.config : {};
  if (!client && typeof createClient === 'function' && isConfigReady(config)) {
    try {
      client = createClient(config);
    } catch (error) {
      logger?.warn?.('maid chat responder client creation failed', error);
      return {
        ok: false,
        status: 'failed',
        reason: error?.message || 'maid_client_error',
        message: '女仆暂时无法建立 API 连接。',
        error,
      };
    }
  }
  if (!client || typeof client.chat !== 'function') {
    return {
      ok: false,
      status: 'unavailable',
      reason: runtime?.reason || 'maid_api_not_configured',
      message: '请先为女仆绑定可用的 API 配置。',
    };
  }

  try {
    const conversationContext = resolveMaidConversationContextSnapshot({
      getConversationContext,
      input: text,
      context,
      taskType: 'maid_chat',
    });
    const messages = buildMaidChatResponderMessages({
      input: text,
      context,
      conversationContext,
      maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
    });
    onContextInjected?.({
      source: 'maid_chat_responder',
      input: text,
      conversationContext,
    });
    assertMaidSkillRequestBudget(messages, runtime?.config, 800);
    const responseText = await client.chat(messages, buildMaidGenerationOptions({
      temperature: 0.7,
      maxTokens: 800,
      max_tokens: 800,
      signal: context?.signal,
    }, runtime?.config, runtime?.generationSettings));
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_chat_responder',
      input: text,
      messages,
      responseText,
    }, logger);
    const toolPlanLike = detectToolPlanLikeChatResponse(responseText);
    if (toolPlanLike) {
      return {
        ok: false,
        status: 'failed',
        reason: 'chat_response_contains_tool_plan',
        source: 'maid_chat_responder',
        input: text,
        message: '这个请求需要进入女仆工具执行流程，不能把工具调用当作聊天回复完成。',
        toolPlanLike,
      };
    }
    return {
      ok: true,
      status: 'responded',
      source: 'maid_chat_responder',
      input: text,
      message: trim(responseText, '我在的。'),
    };
  } catch (error) {
    // 用户取消要向上穿透，不能落成「女仆暂时无法回复」的普通失败
    if (isMaidUserAbort(error, context?.signal)) throw error;
    logger?.warn?.('maid chat responder failed', error);
    emitDebugSnapshot(onDebugSnapshot, {
      source: 'maid_chat_responder',
      input: text,
      messages: buildMaidChatResponderMessages({
        input: text,
        context,
        conversationContext: resolveMaidConversationContextSnapshot({
          getConversationContext,
          input: text,
          context,
          taskType: 'maid_chat',
        }),
        maidPrompt: runtime?.maidPrompt || runtime?.personaPrompt,
      }),
      responseText: error?.message || '女仆暂时无法回复。',
      error,
    }, logger);
    return {
      ok: false,
      status: 'failed',
      reason: error?.message || 'maid_chat_failed',
      message: error?.message || '女仆暂时无法回复。',
      error,
    };
  }
};
