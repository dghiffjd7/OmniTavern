import { createProviderToolCallDeltaAccumulator } from '../../agent/provider-tool-call-delta-adapter.js';
import {
  extractToolResultWebSources,
  mergeWebSources,
} from '../../api/web-search-runtime.js';
import { createKimiNativeWebSearchClient } from './kimi-native-web-search-client.js';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const toNullableCount = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.trunc(numeric) : null;
};

const sumNullableCounts = (items, key) => {
  const values = items.map(item => toNullableCount(item?.[key])).filter(value => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
};

const createAbortError = () => {
  try {
    return new DOMException('Web search aborted', 'AbortError');
  } catch {
    const error = new Error('Web search aborted');
    error.name = 'AbortError';
    return error;
  }
};

const waitForToolExecution = (task, signal = null) => {
  if (!signal) return Promise.resolve(task);
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
};

const mergeUsageReports = (reports = [], { provider = '', model = '' } = {}) => {
  if (!reports.length) return null;
  const last = reports[reports.length - 1] || {};
  return {
    provider: trim(last.provider, provider),
    model: trim(last.model, model),
    finishReason: trim(last.finishReason),
    promptTokens: sumNullableCounts(reports, 'promptTokens'),
    completionTokens: sumNullableCounts(reports, 'completionTokens'),
    totalTokens: sumNullableCounts(reports, 'totalTokens'),
    requestCount: reports.length,
    webSearch: true,
  };
};

const compactSearchResultForModel = (output = {}) => {
  const result = isPlainObject(output?.result) ? output.result : {};
  const compactItem = item => ({
    title: trim(item?.title || item?.name || item?.url).slice(0, 300),
    url: trim(item?.url || item?.uri || item?.link).slice(0, 1200),
    snippet: trim(item?.snippet || item?.description || item?.text).slice(0, 1200),
  });
  const documents = (Array.isArray(result.documents) ? result.documents : []).slice(0, 3).map(item => ({
    ...compactItem(item),
    text: trim(item?.text).slice(0, 5000),
  }));
  // web.fetch_url 直接返回单页 {url,title,text}，无 documents 数组；折算成单文档喂给模型
  if (!documents.length && trim(result.text) && trim(result.url)) {
    documents.push({
      title: trim(result.title || result.url).slice(0, 300),
      url: trim(result.url).slice(0, 1200),
      snippet: '',
      text: trim(result.text).slice(0, 5000),
    });
  }
  return {
    ok: result.ok !== false && output?.status !== 'failed',
    status: trim(output?.status, result.ok === false ? 'failed' : 'succeeded'),
    summary: trim(output?.summary || result?.message || result?.reason).slice(0, 600),
    query: trim(result.query).slice(0, 300),
    provider: trim(result.provider).slice(0, 80),
    results: (Array.isArray(result.results) ? result.results : []).slice(0, 8).map(compactItem),
    documents,
  };
};

const buildToolContinuationMessages = (toolCalls = [], toolResults = [], assistantCapture = {}) => {
  const nativeOutput = assistantCapture.responsesOutput || toolCalls.find(call => call?.providerContinuation?.api === 'openai_responses')
    ?.providerContinuation?.assistantOutput;
  if (Array.isArray(nativeOutput) && nativeOutput.length) {
    return [...nativeOutput, ...toolResults.map(item => ({
      type: 'function_call_output',
      call_id: trim(item.call.toolCallId || item.call.id),
      output: JSON.stringify(compactSearchResultForModel(item.output)),
    }))];
  }
  const assistantMessage = {
    role: 'assistant',
    content: assistantCapture.hasContent ? assistantCapture.content : '',
    tool_calls: toolCalls.map(call => ({
      id: trim(call.toolCallId || call.id),
      type: 'function',
      function: {
        name: trim(call.providerToolName || call.toolName),
        arguments: JSON.stringify(isPlainObject(call.arguments) ? call.arguments : {}),
      },
    })),
  };
  if (assistantCapture.hasReasoningContent) {
    assistantMessage.reasoning_content = assistantCapture.reasoningContent;
  }
  return [
    assistantMessage,
  ...toolResults.map(item => ({
    role: 'tool',
    tool_call_id: trim(item.call.toolCallId || item.call.id),
    content: JSON.stringify(compactSearchResultForModel(item.output)),
  })),
  ];
};

const captureAssistantTurnPayload = (capture, data) => {
  if (!capture || !data || typeof data !== 'object') return;
  const output = data.response?.output || data.output;
  if (Array.isArray(output)) capture.responsesOutput = output;
  const choice = Array.isArray(data.choices) ? data.choices[0] : null;
  const message = isPlainObject(choice?.message) ? choice.message : null;
  const delta = isPlainObject(choice?.delta) ? choice.delta : null;
  if (message && Object.prototype.hasOwnProperty.call(message, 'content')) {
    capture.hasContent = true;
    capture.content = message.content;
  } else if (delta && typeof delta.content === 'string') {
    capture.hasContent = true;
    capture.content = `${typeof capture.content === 'string' ? capture.content : ''}${delta.content}`;
  }
  const reasoning = message && Object.prototype.hasOwnProperty.call(message, 'reasoning_content')
    ? message.reasoning_content
    : (delta && Object.prototype.hasOwnProperty.call(delta, 'reasoning_content')
        ? delta.reasoning_content
        : undefined);
  if (reasoning !== undefined) {
    capture.hasReasoningContent = true;
    if (message) capture.reasoningContent = reasoning;
    else if (typeof reasoning === 'string') {
      capture.reasoningContent = `${typeof capture.reasoningContent === 'string' ? capture.reasoningContent : ''}${reasoning}`;
    } else {
      capture.reasoningContent = reasoning;
    }
  }
};

const withoutToolOptions = (options = {}) => {
  const {
    tools: _tools,
    tool_choice: _toolChoice,
    toolChoice: _geminiToolChoice,
    toolConfig: _toolConfig,
    onProviderToolCallDelta: _toolDelta,
    onWebSearchStatus: _webSearchStatus,
    ...rest
  } = options || {};
  return rest;
};

const getDeepSeekResponsePrefix = (options = {}) => trim(options?.deepseekPrefix?.prefix);

const createTurnCapture = ({
  options = {},
  provider = '',
  model = '',
  completedCalls = [],
  usageReports = [],
  assistantCapture = null,
  onToolCallDetected = null,
} = {}) => {
  const accumulator = createProviderToolCallDeltaAccumulator({ provider, model });
  const originalToolDelta = options.onProviderToolCallDelta;
  const { onWebSearchStatus: _webSearchStatus, ...providerOptions } = options || {};
  return {
    ...providerOptions,
    onProviderUsage: usage => {
      if (usage && typeof usage === 'object') usageReports.push(usage);
    },
    onProviderToolCallDelta: (data, meta = {}) => {
      captureAssistantTurnPayload(assistantCapture, data);
      try {
        originalToolDelta?.(data, meta);
      } catch {}
      const next = accumulator.push(data, {
        provider: trim(meta?.provider, provider),
        model: trim(meta?.model, model),
      });
      if (next.deltas.length || next.completed.length) {
        try {
          onToolCallDetected?.(next);
        } catch {}
      }
      next.completed.forEach(call => completedCalls.push(call));
    },
  };
};

const notifyWebSearchStatus = (options, state, message) => {
  if (typeof options?.onWebSearchStatus !== 'function') return;
  try {
    options.onWebSearchStatus({ state, message, execution: 'app_tool', provider: 'tool_fallback' });
  } catch {}
};

const executeFallbackCalls = async ({
  calls = [],
  plan = {},
  toolRuntime = null,
  signal = null,
  sessionId = '',
  maxToolCalls = 2,
} = {}) => {
  const allowedNames = isPlainObject(plan?.fallbackToolNames) ? plan.fallbackToolNames : {};
  const selected = [];
  for (const call of calls) {
    const providerToolName = trim(call?.toolName);
    const internalName = trim(allowedNames[providerToolName]);
    if (!internalName || selected.some(item => item.call.toolCallId === call.toolCallId)) continue;
    selected.push({
      call: { ...call, providerToolName, toolName: internalName },
      internalName,
    });
    if (selected.length >= Math.max(1, Math.trunc(Number(maxToolCalls)) || 2)) break;
  }
  const results = [];
  for (const item of selected) {
    let output;
    try {
      if (typeof toolRuntime?.executeTool !== 'function') throw new Error('web tool runtime unavailable');
      if (signal?.aborted) throw createAbortError();
      output = await waitForToolExecution(
        toolRuntime.executeTool(item.internalName, item.call.arguments || {}, {
          signal,
          sessionId,
          source: 'chat-web-search-fallback',
          operationIntent: 'read_only',
        }),
        signal,
      );
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw createAbortError();
      output = {
        toolName: item.internalName,
        status: 'failed',
        summary: trim(error?.message, 'web search failed'),
        result: { ok: false, reason: trim(error?.message, 'web_search_failed') },
      };
    }
    results.push({ ...item, output });
  }
  return results;
};

const notifySources = (options, toolResults = []) => {
  const callback = options?.onProviderSources;
  if (typeof callback !== 'function') return [];
  const sources = mergeWebSources(...toolResults.map(item => extractToolResultWebSources(item.output, {
    provider: item.internalName,
  })));
  if (!sources.length) return sources;
  try {
    callback(sources, { provider: 'tool_fallback' });
  } catch {}
  return sources;
};

const notifyUsage = (options, usageReports, context) => {
  const usage = mergeUsageReports(usageReports, context);
  if (!usage || typeof options?.onProviderUsage !== 'function') return;
  try {
    options.onProviderUsage(usage);
  } catch {}
};

export const createWebSearchGenerationClient = ({
  client = null,
  plan = null,
  toolRuntime = null,
  provider = '',
  model = '',
  sessionId = '',
  maxToolCalls = 2,
} = {}) => {
  if (client && plan?.native === true && plan?.route === 'kimi_native') {
    return createKimiNativeWebSearchClient({
      client,
      provider,
      model,
      maxContinuationTurns: plan?.diagnostics?.maxContinuationTurns,
    });
  }
  if (!client || plan?.fallback !== true) return client;

  // DeepSeek prefix 前缀补全与两轮搜索互斥：首轮去前缀会让“无搜索”回复未被前缀条件化，
  // 显示时再拼前缀就会文不对题。带前缀的请求整体绕过联网（前缀原样传递、剥掉搜索工具）。
  const isPrefixRequest = options => Boolean(getDeepSeekResponsePrefix(options));
  const fallbackProviderToolNames = new Set(Object.keys(
    isPlainObject(plan?.fallbackToolNames) ? plan.fallbackToolNames : {},
  ));
  const hasFallbackProviderCall = calls => (Array.isArray(calls) ? calls : [])
    .some(call => fallbackProviderToolNames.has(trim(call?.toolName)));

  return {
    prepareChatRequest(messages, options = {}) {
      const { onWebSearchStatus: _webSearchStatus, ...providerOptions } = options || {};
      return client.prepareChatRequest?.(
        messages,
        isPrefixRequest(options) ? withoutToolOptions(options) : providerOptions,
      ) || null;
    },

    async chat(messages, options = {}) {
      if (isPrefixRequest(options)) {
        return client.chat(messages, withoutToolOptions(options));
      }
      const completedCalls = [];
      const usageReports = [];
      const assistantCapture = {};
      const firstOptions = createTurnCapture({
        options,
        provider,
        model,
        completedCalls,
        usageReports,
        assistantCapture,
      });
      const firstResponse = await client.chat(messages, firstOptions);
      if (hasFallbackProviderCall(completedCalls)) {
        notifyWebSearchStatus(options, 'searching', '正在由 App 搜索工具联网…');
      }
      let toolResults;
      try {
        toolResults = await executeFallbackCalls({
          calls: completedCalls,
          plan,
          toolRuntime,
          signal: options.signal,
          sessionId,
          maxToolCalls,
        });
      } catch (error) {
        notifyWebSearchStatus(options, options.signal?.aborted ? 'cancelled' : 'failed', '联网搜索未完成');
        throw error;
      }
      if (!toolResults.length) {
        notifyUsage(options, usageReports, { provider, model });
        return firstResponse;
      }
      notifySources(options, toolResults);
      const continuationMessages = buildToolContinuationMessages(
        toolResults.map(item => item.call),
        toolResults,
        assistantCapture,
      );
      notifyWebSearchStatus(options, 'continuing', 'App 搜索工具已取得网页资料，正在整理回答…');
      const continuationOptions = withoutToolOptions(options);
      continuationOptions.onProviderUsage = usage => {
        if (usage && typeof usage === 'object') usageReports.push(usage);
      };
      try {
        const response = await client.chat(
          [...(Array.isArray(messages) ? messages : []), ...continuationMessages],
          continuationOptions,
        );
        notifyUsage(options, usageReports, { provider, model });
        notifyWebSearchStatus(options, 'done', '联网搜索完成');
        return response;
      } catch (error) {
        notifyWebSearchStatus(options, options.signal?.aborted ? 'cancelled' : 'failed', '联网搜索未完成');
        throw error;
      }
    },

    async *streamChat(messages, options = {}) {
      if (isPrefixRequest(options)) {
        yield* client.streamChat(messages, withoutToolOptions(options));
        return;
      }
      const completedCalls = [];
      const usageReports = [];
      const assistantCapture = {};
      let toolCallDetected = false;
      let searchStatusStarted = false;
      const firstOptions = createTurnCapture({
        options,
        provider,
        model,
        completedCalls,
        usageReports,
        assistantCapture,
        onToolCallDetected: (activity) => {
          const calls = [...(activity?.deltas || []), ...(activity?.completed || [])];
          if (!hasFallbackProviderCall(calls)) return;
          toolCallDetected = true;
          if (!searchStatusStarted) {
            searchStatusStarted = true;
            notifyWebSearchStatus(options, 'searching', '正在由 App 搜索工具联网…');
          }
        },
      });
      const bufferedAfterToolCall = [];
      for await (const chunk of client.streamChat(messages, firstOptions)) {
        if (toolCallDetected) bufferedAfterToolCall.push(chunk);
        else yield chunk;
      }
      let toolResults;
      try {
        toolResults = await executeFallbackCalls({
          calls: completedCalls,
          plan,
          toolRuntime,
          signal: options.signal,
          sessionId,
          maxToolCalls,
        });
      } catch (error) {
        notifyWebSearchStatus(options, options.signal?.aborted ? 'cancelled' : 'failed', '联网搜索未完成');
        throw error;
      }
      if (!toolResults.length) {
        for (const chunk of bufferedAfterToolCall) yield chunk;
        notifyUsage(options, usageReports, { provider, model });
        if (searchStatusStarted) notifyWebSearchStatus(options, 'done', '联网搜索完成');
        return;
      }
      notifySources(options, toolResults);
      const continuationMessages = buildToolContinuationMessages(
        toolResults.map(item => item.call),
        toolResults,
        assistantCapture,
      );
      notifyWebSearchStatus(options, 'continuing', 'App 搜索工具已取得网页资料，正在整理回答…');
      const continuationOptions = withoutToolOptions(options);
      continuationOptions.onProviderUsage = usage => {
        if (usage && typeof usage === 'object') usageReports.push(usage);
      };
      try {
        for await (const chunk of client.streamChat(
          [...(Array.isArray(messages) ? messages : []), ...continuationMessages],
          continuationOptions,
        )) {
          yield chunk;
        }
        notifyUsage(options, usageReports, { provider, model });
        notifyWebSearchStatus(options, 'done', '联网搜索完成');
      } catch (error) {
        notifyWebSearchStatus(options, options.signal?.aborted ? 'cancelled' : 'failed', '联网搜索未完成');
        throw error;
      }
    },
  };
};
