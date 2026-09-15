import { buildLlmContextPayload } from '../ui/chat/llm-context-builder-utils.js';
import { buildLlmHistoryForSession } from '../ui/chat/llm-history-builder-utils.js';

// Use the normal preset/worldbook/macro builder, with independent cancellation
// and no insertion into either visible chat or the bridge's history storage.
export async function runScriptGeneration(runtime, config, sessionId, signal, settings) {
  const bridge = runtime.bridge;
  if (!bridge?.generate) throw new Error('生成服务尚未就绪');
  if (config.image || config.images?.length) throw new Error('脚本 generate 暂不支持图片输入');
  const uiMode = sessionId.startsWith('rp:') ? 'rp' : 'chat';
  const presetContext = { sessionId, uiMode };
  const activePersona = runtime.getEffectivePersona?.(sessionId);
  const activeUser = runtime.getActiveUserProfile?.();
  const rawHistory = runtime.chatStore?.getMessages?.(sessionId) || [];
  const limit = Number.isFinite(Number(config.max_chat_history))
    ? Math.max(0, Math.trunc(Number(config.max_chat_history))) : rawHistory.length;
  if (limit > 0 && settings.scriptAllowReadMessages === false) throw new Error('脚本权限已禁用：读取消息');
  const userInput = String(config.user_input ?? '');
  const openaiPreset = runtime.presets?.getResolvedActive?.('openai', presetContext)?.preset;
  const history = buildLlmHistoryForSession({
    messages: limit > 0 ? rawHistory.slice(-limit) : [], pendingUserText: userInput,
    isRpMode: uiMode === 'rp', rpUiMode: uiMode === 'rp', settings, openaiPreset,
    reasoningPreset: runtime.presets?.getResolvedActive?.('reasoning', presetContext)?.preset,
    creativeSummaryGetters: {
      getCompactedSummary: () => runtime.chatStore?.getCompactedSummary?.(sessionId),
      getSummaries: () => runtime.chatStore?.getSummaries?.(sessionId),
    },
    applyMacros: text => bridge.processTextMacros(text, presetContext),
  });
  const context = buildLlmContextPayload({
    activePersona, activeUser, sessionId, uiMode, rpUiMode: uiMode === 'rp', isRpMode: uiMode === 'rp',
    characterName: activePersona?.name || runtime.contactsStore?.getContact?.(sessionId)?.name || 'Assistant',
    promptUserName: activeUser?.name || 'User', settings, openaiPreset, pendingUserText: userInput,
    sessionSettings: runtime.chatStore?.getSessionSettings?.(sessionId), buildHistory: () => history,
    injectedPromptBlocks: runtime.getScriptPromptInjections(sessionId),
  });
  const overrides = config.overrides || {};
  if (typeof overrides.char_description === 'string') context.character.description = overrides.char_description;
  if (typeof overrides.persona_description === 'string') context.user.persona = overrides.persona_description;
  if (Array.isArray(overrides.chat_history)) context.history = overrides.chat_history.map(item => ({ role: item.role, content: String(item.content || '') }));
  const runtimeConfig = { stream: config.should_stream === true };
  const generationOptions = {};
  const custom = config.custom_api;
  if (custom && typeof custom === 'object') {
    if (!['openai', 'custom'].includes(custom.source || 'openai')) throw new Error('custom_api 暂只支持 OpenAI 兼容接口');
    const url = new URL(String(custom.apiurl || custom.baseUrl || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('自定义 API 地址无效');
    url.search = ''; url.hash = '';
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|models)\/?$/i, '').replace(/\/+$/, '');
    if (!/\/v1$/i.test(url.pathname)) url.pathname += '/v1';
    Object.assign(runtimeConfig, { provider: 'custom', baseUrl: String(url).replace(/\/+$/, ''),
      apiKey: String(custom.key || custom.apiKey || ''), excludedGenerationParams: [],
      connectionMode: 'direct', proxyBaseUrl: '', proxyAuthHeaderName: '', proxyAuthToken: '',
      ...(custom.model ? { model: String(custom.model) } : {}),
    });
    for (const key of ['temperature', 'top_p', 'top_k', 'max_tokens', 'seed', 'frequency_penalty', 'presence_penalty']) {
      if (custom[key] === 'unset') generationOptions[key] = undefined;
      else if (typeof custom[key] === 'number' && Number.isFinite(custom[key])) generationOptions[key] = custom[key];
    }
  }
  const response = await bridge.generate(userInput, context, {
    config: runtimeConfig, generationOptions, signal, saveHistory: false, purpose: 'script_generate',
  });
  if (typeof response === 'string') return response;
  let text = '';
  for await (const part of response) if (typeof part === 'string') text += part;
  return text;
}
