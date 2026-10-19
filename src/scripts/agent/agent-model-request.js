import { agentRequestTimeoutMs, applyAgentTimeout, buildAgentGenerationOptions } from './agent-generation-settings.js';
import { resolveAgentConfigTaskPreset } from '../ui/chat/agent-task-preset.js';

// Capture the Agent's connection once; preview and execution use the same options.
// Referencing preset prompt blocks never imports preset generation parameters.
// 例外：Agent 选了「套用预设」时，温度、Top P 等采样参数取自所选预设（输出上限与思考模式仍按 Agent 自己的设置）。
export const createAgentModelRequest = ({ config, resolveModel, createClient, requestContext,
  normalizeMessages = messages => messages } = {}) => {
  const settings = structuredClone(config);
  const timeoutMs = agentRequestTimeoutMs(settings);
  const snapshot = (async () => {
    try {
      const model = await resolveModel();
      if (!model) throw new Error('Agent 指定模型配置不存在');
      return { model: applyAgentTimeout({ ...model, ...(settings.modelOverride ? { model: settings.modelOverride } : {}) }, settings) };
    } catch (error) { return { error }; }
  })();
  const prepare = async (messages, options) => {
    const captured = await snapshot;
    if (captured.error) throw captured.error;
    const { presetContext: _preset, runtimeConfigOverride: _override, ...callerParams } = options || {};
    const source = resolveAgentConfigTaskPreset(settings, requestContext?.sessionId || '');
    const { temperature: _temperature, ...withoutTemperature } = callerParams;
    const params = source.mode === 'preset' ? { ...withoutTemperature, ...(source.taskPreset.sampling || {}) } : callerParams;
    const model = captured.model;
    return { model, client: createClient(model), messages: normalizeMessages(messages, model),
      params: { ...buildAgentGenerationOptions(params, model, settings), requestContext } };
  };
  return { timeoutMs,
    chat: async (messages, options) => {
      const request = await prepare(messages, options);
      return request.client.chat(request.messages, request.params);
    },
    preview: async (messages, options) => {
      const request = await prepare(messages, options);
      const prepared = request.client.prepareChatRequest?.(request.messages, { ...request.params, stream: false });
      return { messages: request.messages, params: request.params, model: request.model.model, provider: request.model.provider,
        ...(prepared?.body ? { wireRequest: { body: prepared.body, parameterReport: prepared.parameterReport || [] } } : {}) };
    },
  };
};
