import { agentRequestTimeoutMs, buildAgentGenerationOptions } from './agent-generation-settings.js';

// Capture the Agent's connection once; preview and execution use the same options.
// Referencing preset prompt blocks never imports preset generation parameters.
export const createAgentModelRequest = ({ config, resolveModel, createClient, requestContext,
  normalizeMessages = messages => messages } = {}) => {
  const settings = structuredClone(config);
  const timeoutMs = agentRequestTimeoutMs(settings);
  const snapshot = (async () => {
    try {
      const model = await resolveModel();
      if (!model) throw new Error('Agent 指定模型配置不存在');
      return { model: { ...model, ...(settings.modelOverride ? { model: settings.modelOverride } : {}), timeout: timeoutMs } };
    } catch (error) { return { error }; }
  })();
  const prepare = async (messages, options) => {
    const captured = await snapshot;
    if (captured.error) throw captured.error;
    const { presetContext: _preset, runtimeConfigOverride: _override, ...params } = options || {};
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
