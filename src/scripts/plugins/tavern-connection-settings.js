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

// 脚本存预设设置时不写编号、名称与 Key 类字段
const SCRIPT_PRESET_BLOCKED_KEYS = Object.freeze(new Set([
  '__proto__', 'prototype', 'constructor', 'id', 'name',
  'key', 'apikey', 'authorization', 'accesstoken', 'secrettoken',
]));
const clonePlain = (value) => {
  if (value == null) return value;
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
};

// 脚本写回预设设置：按键合并到现有预设（脚本没给的键保留原值），跳过上面这些字段与连接字段；
// keepKey(key) 为真的键也保留预设原值（例如交给脚本前被滤掉的连线资料）
export const mergeScriptPresetSettings = (current, incoming, { keepKey = () => false } = {}) => {
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const next = clonePlain(base) || {};
  Object.entries(incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {}).forEach(([key, value]) => {
    const normalizedKey = String(key || '').replace(/[_\-\s]/g, '').toLowerCase();
    if (SCRIPT_PRESET_BLOCKED_KEYS.has(key) || SCRIPT_PRESET_BLOCKED_KEYS.has(normalizedKey)) return;
    if (TAVERN_CONNECTION_SETTING_KEYS.has(key)) return;
    if (key === 'function_calling' && !Object.hasOwn(base, key)) return;
    if ((key === 'prompts' || key === 'prompt_order' || key === 'prompts_unused') && !Array.isArray(value)) return;
    if (keepKey(key)) return;
    next[key] = clonePlain(value);
  });
  return next;
};

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
