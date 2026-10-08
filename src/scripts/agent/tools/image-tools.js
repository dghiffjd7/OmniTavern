const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const createImageAgentTools = ({
  mediaGenerationService = null,
} = {}) => [
  {
    name: 'image.generate',
    title: 'Generate image',
    description: 'Generate and persist an image through the existing media generation service.',
    source: 'media-generation-service',
    permissions: ['network', 'storage'],
    riskLevel: 'high',
    capabilities: {
      read: false,
      write: true,
      network: true,
      cost: 'variable',
      undo: 'delete_asset',
      modelContext: 'none',
      confirmation: 'required',
    },
    // 生图时长跟随生图模型配置的请求超时。
    timeoutMs: 0,
    outputLimit: 600,
    schema: {
      type: 'object',
      required: ['prompt', 'config'],
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1 },
        config: { type: 'object' },
        sessionId: { type: 'string' },
        scope: { type: 'object' },
        options: { type: 'object' },
      },
    },
    execute: async (args = {}, context = {}) => {
      if (!mediaGenerationService || typeof mediaGenerationService.generateImage !== 'function') {
        throw new Error('media generation service not available');
      }
      return mediaGenerationService.generateImage({
        prompt: String(args.prompt || '').trim(),
        config: isPlainObject(args.config) ? args.config : {},
        sessionId: String(args.sessionId || '').trim(),
        scope: isPlainObject(args.scope) ? args.scope : {},
        options: isPlainObject(args.options) ? args.options : {},
        signal: context.signal,
        agentTask: !context.runId,
      });
    },
    summarizeResult: result => {
      const output = result?.output && typeof result.output === 'object' ? result.output : {};
      const target = String(output.path || output.url || '').trim();
      return target ? `image generated: ${target}` : 'image generated';
    },
  },
];

export const registerImageAgentTools = (registry, deps = {}) => {
  const tools = createImageAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
