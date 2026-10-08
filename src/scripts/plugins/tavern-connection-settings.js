// 酒馆脚本从 chatCompletionSettings（即酒馆的 oai_settings）读取当前连接：
// chat_completion_source + 对应的 <source>_model 字段。APP 的连接放在 API 配置档里，
// 这里把配置档换算成酒馆的字段名，只用于让脚本读到当前 provider / 模型。

// APP provider → 酒馆 chat_completion_source
const TAVERN_SOURCE_BY_PROVIDER = Object.freeze({
  openai: 'openai',
  anthropic: 'claude',
  gemini: 'makersuite',
  makersuite: 'makersuite',
  vertexai: 'vertexai',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  kimi: 'moonshot',
  zhipu: 'zai',
  ollama: 'custom',
  opencode: 'custom',
  custom: 'custom',
});

// 酒馆各 source 存模型名的字段
const TAVERN_MODEL_FIELD_BY_SOURCE = Object.freeze({
  openai: 'openai_model',
  claude: 'claude_model',
  makersuite: 'google_model',
  vertexai: 'vertexai_model',
  openrouter: 'openrouter_model',
  deepseek: 'deepseek_model',
  moonshot: 'moonshot_model',
  zai: 'zai_model',
  custom: 'custom_model',
});

// 连接归 API 配档管，脚本保存预设设置时不得写入这些字段
export const TAVERN_CONNECTION_SETTING_KEYS = Object.freeze(new Set([
  'chat_completion_source',
  'custom_prompt_post_processing',
  ...Object.values(TAVERN_MODEL_FIELD_BY_SOURCE),
]));

export const buildTavernConnectionSettings = (config = null) => {
  const provider = String(config?.provider || '').trim().toLowerCase();
  const source = TAVERN_SOURCE_BY_PROVIDER[provider];
  if (!source) return {};
  const model = String(config?.model || '').trim();
  const postProcessing = String(config?.promptPostProcessing || '').trim().toLowerCase();
  return {
    chat_completion_source: source,
    ...(model ? { [TAVERN_MODEL_FIELD_BY_SOURCE[source]]: model } : {}),
    // 酒馆用空字符串表示「不处理」
    ...(postProcessing ? { custom_prompt_post_processing: postProcessing === 'none' ? '' : postProcessing } : {}),
  };
};
