import { normalizeProviderToolCall } from './provider-tool-call-parts.js';

export const PROVIDER_TOOL_CALL_DELTA_TYPE = 'provider_tool_call_delta';

export const PROVIDER_TOOL_CALL_DELTA_PHASES = Object.freeze({
  start: 'start',
  argumentsDelta: 'arguments_delta',
  complete: 'complete',
});

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const readIndex = (value, fallback = -1) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const parseArgumentsText = (text = '') => {
  const raw = String(text || '').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const stringifyArguments = (value) => {
  if (!isPlainObject(value)) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

const hasObjectKeys = value => isPlainObject(value) && Object.keys(value).length > 0;

const buildDelta = ({
  phase = PROVIDER_TOOL_CALL_DELTA_PHASES.start,
  provider = '',
  model = '',
  id = '',
  toolCallId = '',
  index = -1,
  toolName = '',
  argumentsDelta = '',
  argumentsText = '',
  arguments: args = null,
  all = false,
  source = 'provider-tool-call-delta',
  raw = null,
  providerContinuation = null,
  geminiStream = '',
  argumentPatches = null,
  now = Date.now,
} = {}) => {
  const delta = {
    type: PROVIDER_TOOL_CALL_DELTA_TYPE,
    phase,
    provider: trim(provider),
    model: trim(model),
    id: trim(id || toolCallId),
    toolCallId: trim(toolCallId || id),
    index: readIndex(index, -1),
    toolName: trim(toolName),
    argumentsDelta: String(argumentsDelta ?? ''),
    argumentsText: String(argumentsText ?? ''),
    arguments: isPlainObject(args) ? clone(args) : null,
    all: all === true,
    source,
    raw: raw ? clone(raw) : null,
    createdAt: Number(now?.() || Date.now()) || Date.now(),
  };
  if (isPlainObject(providerContinuation)) {
    Object.defineProperty(delta, 'providerContinuation', {
      configurable: false,
      enumerable: false,
      value: clone(providerContinuation),
      writable: false,
    });
  }
  // Vertex 分段参数（streamFunctionCallArguments）专用，不改其他服务商的 delta 形状
  if (geminiStream) {
    Object.defineProperty(delta, 'geminiStream', { enumerable: false, value: geminiStream });
    Object.defineProperty(delta, 'argumentPatches', { enumerable: false, value: Array.isArray(argumentPatches) ? clone(argumentPatches) : [] });
  }
  return delta;
};

// partialArgs 的 jsonPath（如 $.content、$.items[0].name）拆成路径；危险键不写入
const parseGeminiArgumentPath = (jsonPath = '') => {
  const text = String(jsonPath || '').trim();
  if (!text.startsWith('$')) return [];
  const path = [];
  const pattern = /\.([^.[\]]+)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/gu;
  let match;
  let consumed = 1;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index !== consumed) return [];
    consumed = pattern.lastIndex;
    path.push(match[2] !== undefined ? Number(match[2]) : (match[1] ?? match[3] ?? match[4]));
  }
  if (consumed !== text.length) return [];
  return path.some(key => ['__proto__', 'constructor', 'prototype'].includes(key)) ? [] : path;
};

// 字符串值是分段片段，接在已有内容后面；数字、布尔与 null 直接设值
const applyGeminiArgumentPatch = (target, patch = {}) => {
  const path = parseGeminiArgumentPath(patch.jsonPath);
  if (!path.length || !isPlainObject(target)) return;
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = typeof path[index + 1] === 'number' ? [] : {};
    cursor = cursor[key];
  }
  const last = path[path.length - 1];
  if (Object.hasOwn(patch, 'stringValue')) cursor[last] = `${typeof cursor[last] === 'string' ? cursor[last] : ''}${String(patch.stringValue ?? '')}`;
  else if (Object.hasOwn(patch, 'numberValue')) cursor[last] = Number(patch.numberValue);
  else if (Object.hasOwn(patch, 'boolValue')) cursor[last] = patch.boolValue === true;
  else if (Object.hasOwn(patch, 'nullValue')) cursor[last] = null;
};

const extractOpenAIToolDeltas = (data = {}, context = {}) => {
  const choice = data?.choices?.[0] && typeof data.choices[0] === 'object' ? data.choices[0] : {};
  const delta = isPlainObject(choice.delta)
    ? choice.delta
    : (isPlainObject(data.delta) ? data.delta : {});
  const message = isPlainObject(choice.message) ? choice.message : {};
  const toolCalls = Array.isArray(delta.tool_calls)
    ? delta.tool_calls
    : (Array.isArray(message.tool_calls)
        ? message.tool_calls
        : (Array.isArray(data.tool_calls) ? data.tool_calls : []));
  const items = [];
  toolCalls.forEach((call, idx) => {
    const src = isPlainObject(call) ? call : {};
    const fn = isPlainObject(src.function) ? src.function : {};
    const id = trim(src.id || src.tool_call_id || src.call_id);
    const toolName = trim(fn.name || src.name);
    const argumentsDelta = typeof fn.arguments === 'string'
      ? fn.arguments
      : (typeof src.arguments === 'string' ? src.arguments : '');
    const base = {
      provider: context.provider,
      model: context.model,
      id,
      toolCallId: id,
      index: readIndex(src.index, idx),
      toolName,
      raw: src,
      now: context.now,
    };
    if (id || toolName) {
      items.push(buildDelta({
        ...base,
        phase: PROVIDER_TOOL_CALL_DELTA_PHASES.start,
      }));
    }
    if (argumentsDelta) {
      items.push(buildDelta({
        ...base,
        phase: PROVIDER_TOOL_CALL_DELTA_PHASES.argumentsDelta,
        argumentsDelta,
      }));
    }
  });
  if (trim(choice.finish_reason || data.finish_reason) === 'tool_calls') {
    items.push(buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.complete,
      all: true,
      raw: data,
      now: context.now,
    }));
  }
  return items;
};

const extractOpenAIResponseDeltas = (data = {}, context = {}) => {
  const response = isPlainObject(data.response) ? data.response : data;
  const output = Array.isArray(response.output) ? response.output : [];
  const responseCalls = output.filter(item => isPlainObject(item) && trim(item.type) === 'function_call');
  if (responseCalls.length) {
    return responseCalls.map((item, index) => buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.complete,
      id: item.id || item.call_id,
      toolCallId: item.call_id || item.id,
      index,
      toolName: item.name,
      argumentsText: item.arguments,
      providerContinuation: {
        api: 'openai_responses',
        assistantOutput: output,
      },
      raw: item,
      now: context.now,
    }));
  }
  const type = trim(data.type).toLowerCase();
  if (!type.startsWith('response.')) return [];
  const item = isPlainObject(data.item) ? data.item : {};
  if (type === 'response.output_item.added' && trim(item.type) === 'function_call') {
    return [buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.start,
      id: item.id || item.call_id,
      toolCallId: item.call_id || item.id,
      index: data.output_index,
      toolName: item.name,
      providerContinuation: {
        api: 'openai_responses',
        assistantOutput: [item],
      },
      raw: data,
      now: context.now,
    })];
  }
  if (type === 'response.function_call_arguments.delta') {
    return [buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.argumentsDelta,
      id: data.item_id || data.call_id,
      toolCallId: data.call_id || data.item_id,
      index: data.output_index,
      argumentsDelta: data.delta,
      raw: data,
      now: context.now,
    })];
  }
  if (type === 'response.function_call_arguments.done') {
    return [buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.argumentsDelta,
      id: data.item_id || data.call_id,
      toolCallId: data.call_id || data.item_id,
      index: data.output_index,
      argumentsText: data.arguments,
      raw: data,
      now: context.now,
    })];
  }
  if (type === 'response.output_item.done' && trim(item.type) === 'function_call') {
    return [buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.complete,
      id: item.id || item.call_id,
      toolCallId: item.call_id || item.id,
      index: data.output_index,
      toolName: item.name,
      argumentsText: item.arguments,
      providerContinuation: {
        api: 'openai_responses',
        assistantOutput: [item],
      },
      raw: data,
      now: context.now,
    })];
  }
  return [];
};

const extractAnthropicToolDeltas = (data = {}, context = {}) => {
  const type = trim(data.type).toLowerCase();
  const content = Array.isArray(data?.content) ? data.content : [];
  const nonStreamToolUses = content.filter(block => (
    isPlainObject(block) && trim(block.type).toLowerCase() === 'tool_use'
  ));
  if (nonStreamToolUses.length) {
    return nonStreamToolUses.map((block, index) => buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.complete,
      id: block.id,
      toolCallId: block.id,
      index,
      toolName: block.name,
      argumentsText: stringifyArguments(block.input),
      arguments: isPlainObject(block.input) ? block.input : {},
      providerContinuation: {
        api: 'anthropic_messages',
        assistantContent: content,
      },
      raw: block,
      now: context.now,
    }));
  }
  const block = isPlainObject(data.content_block) ? data.content_block : {};
  if (type === 'content_block_start' && trim(block.type) === 'tool_use') {
    const hasInput = hasObjectKeys(block.input);
    return [buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.start,
      id: block.id,
      toolCallId: block.id,
      index: data.index,
      toolName: block.name,
      argumentsText: hasInput ? stringifyArguments(block.input) : '',
      arguments: hasInput ? block.input : null,
      providerContinuation: {
        api: 'anthropic_messages',
        assistantContent: [block],
      },
      raw: data,
      now: context.now,
    })];
  }
  const delta = isPlainObject(data.delta) ? data.delta : {};
  if (type === 'content_block_delta' && trim(delta.type) === 'input_json_delta') {
    return [buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.argumentsDelta,
      index: data.index,
      argumentsDelta: delta.partial_json,
      raw: data,
      now: context.now,
    })];
  }
  if (type === 'content_block_stop') {
    return [buildDelta({
      provider: context.provider,
      model: context.model,
      phase: PROVIDER_TOOL_CALL_DELTA_PHASES.complete,
      index: data.index,
      raw: data,
      now: context.now,
    })];
  }
  return [];
};

const extractGeminiToolDeltas = (data = {}, context = {}) => {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const calls = [];
  candidates.forEach((candidate) => {
    const content = isPlainObject(candidate?.content) ? candidate.content : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];
    parts.forEach((part) => {
      if (!isPlainObject(part?.functionCall)) return;
      calls.push({ part, content });
    });
  });
  return calls.map(({ part, content }, index) => {
      const call = part.functionCall;
      // Vertex 分段参数：开始（只有名称与 id）→ partialArgs 片段 → 空 functionCall 结束
      if (Array.isArray(call.partialArgs)) {
        return buildDelta({
          provider: context.provider,
          model: context.model,
          phase: PROVIDER_TOOL_CALL_DELTA_PHASES.argumentsDelta,
          geminiStream: 'patch',
          argumentPatches: call.partialArgs.filter(isPlainObject),
          raw: part,
          now: context.now,
        });
      }
      if (call.willContinue === true && trim(call.name)) {
        return buildDelta({
          provider: context.provider,
          model: context.model,
          phase: PROVIDER_TOOL_CALL_DELTA_PHASES.start,
          geminiStream: 'start',
          id: call.id,
          toolCallId: call.id,
          toolName: call.name,
          providerContinuation: { api: 'gemini_generate_content', assistantContent: content },
          raw: part,
          now: context.now,
        });
      }
      if (!trim(call.name) && !Object.hasOwn(call, 'args')) {
        return buildDelta({
          provider: context.provider,
          model: context.model,
          phase: PROVIDER_TOOL_CALL_DELTA_PHASES.complete,
          geminiStream: 'end',
          raw: part,
          now: context.now,
        });
      }
      return buildDelta({
        provider: context.provider,
        model: context.model,
        phase: PROVIDER_TOOL_CALL_DELTA_PHASES.complete,
        id: call.id,
        toolCallId: call.id,
        index,
        toolName: call.name,
        arguments: isPlainObject(call.args) ? call.args : {},
        argumentsText: stringifyArguments(call.args),
        providerContinuation: {
          api: 'gemini_generate_content',
          assistantContent: content,
        },
        raw: part,
        now: context.now,
      });
    });
};

export const normalizeProviderToolCallDeltas = (data = {}, {
  provider = '',
  model = '',
  now = Date.now,
} = {}) => {
  const context = { provider, model, now };
  const src = isPlainObject(data) ? data : {};
  return [
    ...extractOpenAIResponseDeltas(src, context),
    ...extractOpenAIToolDeltas(src, context),
    ...extractAnthropicToolDeltas(src, context),
    ...extractGeminiToolDeltas(src, context),
  ];
};

export const createProviderToolCallDeltaAccumulator = ({
  provider = '',
  model = '',
  now = Date.now,
} = {}) => {
  const states = new Map();
  const completedKeys = new Set();
  const openAIResponseOutput = new Map();
  const anthropicAssistantContent = new Map();
  const anthropicPartialJson = new Map();
  // Vertex 分段参数：片段不带 id／名称，接到最近一个尚未结束的调用上
  let openGeminiKey = '';

  const collectOpenAIResponseOutput = (data = {}) => {
    const responseOutput = Array.isArray(data?.output)
      ? data.output
      : (Array.isArray(data?.response?.output) ? data.response.output : []);
    responseOutput.forEach((item, index) => {
      if (!isPlainObject(item)) return;
      openAIResponseOutput.set(trim(item.id || item.call_id, `index:${index}`), clone(item));
    });
    if (trim(data?.type).toLowerCase() === 'response.output_item.done' && isPlainObject(data?.item)) {
      const item = data.item;
      openAIResponseOutput.set(trim(item.id || item.call_id, `index:${readIndex(data.output_index, 0)}`), clone(item));
    }
  };

  const collectAnthropicAssistantContent = (data = {}) => {
    const content = Array.isArray(data?.content) ? data.content : [];
    content.forEach((block, index) => {
      if (isPlainObject(block)) anthropicAssistantContent.set(index, clone(block));
    });
    const type = trim(data?.type).toLowerCase();
    const index = readIndex(data?.index, -1);
    if (index < 0) return;
    if (type === 'content_block_start' && isPlainObject(data?.content_block)) {
      anthropicAssistantContent.set(index, clone(data.content_block));
      return;
    }
    if (type !== 'content_block_delta' || !isPlainObject(data?.delta)) return;
    const delta = data.delta;
    const block = anthropicAssistantContent.get(index);
    if (!isPlainObject(block)) return;
    const deltaType = trim(delta.type).toLowerCase();
    if (deltaType === 'input_json_delta') {
      const partial = `${anthropicPartialJson.get(index) || ''}${String(delta.partial_json || '')}`;
      anthropicPartialJson.set(index, partial);
      if (partial) block.input = parseArgumentsText(partial);
    } else if (deltaType === 'text_delta') {
      block.text = `${String(block.text || '')}${String(delta.text || '')}`;
    } else if (deltaType === 'thinking_delta') {
      block.thinking = `${String(block.thinking || '')}${String(delta.thinking || '')}`;
    } else if (deltaType === 'signature_delta') {
      block.signature = `${String(block.signature || '')}${String(delta.signature || '')}`;
    }
    anthropicAssistantContent.set(index, block);
  };

  const getKey = (delta = {}) => {
    const id = trim(delta.toolCallId || delta.id);
    if (id) return `id:${id}`;
    const index = readIndex(delta.index, -1);
    return index >= 0 ? `index:${index}` : 'default';
  };

  const getState = (delta = {}) => {
    const id = trim(delta.toolCallId || delta.id);
    const index = readIndex(delta.index, -1);
    if (id) {
      const idKey = `id:${id}`;
      const existingById = states.get(idKey);
      if (existingById) return existingById;
      const existingByIndex = Array.from(states.values())
        .find(state => state.index >= 0 && state.index === index);
      if (existingByIndex) {
        states.delete(existingByIndex.key);
        existingByIndex.key = idKey;
        states.set(idKey, existingByIndex);
        return existingByIndex;
      }
    }
    if (!id && index >= 0) {
      const existingByIndex = Array.from(states.values())
        .find(state => state.index >= 0 && state.index === index);
      if (existingByIndex) return existingByIndex;
    }
    const key = getKey(delta);
    const current = states.get(key) || {
      key,
      id: '',
      toolCallId: '',
      index: -1,
      toolName: '',
      argumentsText: '',
      arguments: null,
      provider: trim(delta.provider, provider),
      model: trim(delta.model, model),
      providerContinuation: null,
    };
    states.set(key, current);
    return current;
  };

  const updateState = (state, delta = {}) => {
    state.id = trim(delta.id, state.id);
    state.toolCallId = trim(delta.toolCallId, state.toolCallId || state.id);
    state.index = readIndex(delta.index, state.index);
    state.toolName = trim(delta.toolName, state.toolName);
    state.provider = trim(delta.provider, state.provider);
    state.model = trim(delta.model, state.model);
    if (delta.argumentsText) state.argumentsText = String(delta.argumentsText);
    if (delta.argumentsDelta) state.argumentsText += String(delta.argumentsDelta);
    if (isPlainObject(delta.arguments)) state.arguments = clone(delta.arguments);
    if (isPlainObject(delta.providerContinuation)) {
      state.providerContinuation = clone(delta.providerContinuation);
    }
    return state;
  };

  const completeState = (state) => {
    const completionKey = trim(state.toolCallId || state.id)
      ? `id:${trim(state.toolCallId || state.id)}`
      : `index:${state.index}`;
    if (completedKeys.has(completionKey)) {
      states.delete(state.key);
      return null;
    }
    const args = isPlainObject(state.arguments)
      ? state.arguments
      : parseArgumentsText(state.argumentsText);
    const providerContinuation = isPlainObject(state.providerContinuation)
      ? clone(state.providerContinuation)
      : null;
    if (providerContinuation?.api === 'openai_responses' && openAIResponseOutput.size) {
      providerContinuation.assistantOutput = Array.from(openAIResponseOutput.values()).map(clone);
    }
    if (providerContinuation?.api === 'anthropic_messages' && anthropicAssistantContent.size) {
      providerContinuation.assistantContent = Array.from(anthropicAssistantContent.entries())
        .sort(([left], [right]) => left - right)
        .map(([, block]) => clone(block));
    }
    const completed = normalizeProviderToolCall({
      id: state.id || state.toolCallId,
      toolCallId: state.toolCallId || state.id,
      toolName: state.toolName,
      provider: state.provider,
      model: state.model,
      arguments: args,
      status: 'succeeded',
      metadata: {
        streamingArgumentsText: state.argumentsText,
        streamingIndex: state.index,
      },
      providerContinuation,
    }, { provider, model, now });
    completedKeys.add(completionKey);
    states.delete(state.key);
    return completed;
  };

  const push = (data = {}, context = {}) => {
    collectOpenAIResponseOutput(data);
    collectAnthropicAssistantContent(data);
    const deltas = normalizeProviderToolCallDeltas(data, {
      provider: trim(context.provider, provider),
      model: trim(context.model, model),
      now,
    });
    const completed = [];
    deltas.forEach((delta) => {
      if (delta.geminiStream) {
        if (delta.geminiStream === 'start') {
          const state = updateState(getState(delta), delta);
          state.arguments = {};
          openGeminiKey = state.key;
          return;
        }
        const state = openGeminiKey ? states.get(openGeminiKey) : null;
        if (!state) return;
        if (delta.geminiStream === 'patch') {
          if (!isPlainObject(state.arguments)) state.arguments = {};
          delta.argumentPatches.forEach(patch => applyGeminiArgumentPatch(state.arguments, patch));
          return;
        }
        openGeminiKey = '';
        const item = completeState(state);
        if (item) completed.push(item);
        return;
      }
      if (delta.phase === PROVIDER_TOOL_CALL_DELTA_PHASES.complete && delta.all) {
        Array.from(states.values()).forEach((state) => {
          const item = completeState(state);
          if (item) completed.push(item);
        });
        return;
      }
      if (
        delta.phase === PROVIDER_TOOL_CALL_DELTA_PHASES.complete
        && !trim(delta.toolCallId || delta.id || delta.toolName)
        && !Array.from(states.values()).some(state => state.index === readIndex(delta.index, -1))
      ) {
        return;
      }
      const state = updateState(getState(delta), delta);
      if (delta.phase === PROVIDER_TOOL_CALL_DELTA_PHASES.complete) {
        const item = completeState(state);
        if (item) completed.push(item);
      }
    });
    return { deltas, completed };
  };

  return {
    clear: () => {
      states.clear();
      completedKeys.clear();
      openAIResponseOutput.clear();
      anthropicAssistantContent.clear();
      anthropicPartialJson.clear();
      openGeminiKey = '';
    },
    getSnapshot: () => Array.from(states.values()).map(state => ({ ...state })),
    push,
  };
};
