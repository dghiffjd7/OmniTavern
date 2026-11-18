// 小管家（小模型杂务中心）的任务目录：每个任务的开关与单独模型存在小管家配置的 tasks 里。
// 小管家整体开关与共用模型沿用原「archive_naming」配置的 enabled／modelProfileId；任务没单独指定模型时用共用模型。
const text = value => String(value ?? '').trim();
const plain = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const STEWARD_CONFIG_ID = 'archive_naming';

// 翻译的目标语言：'' 表示跟随 APP 界面语言；label 是该语言自己的写法（不随界面翻译），prompt 给模型看
export const STEWARD_TRANSLATION_LANGUAGES = Object.freeze([
  Object.freeze({ id: 'zh-CN', label: '简体中文', prompt: 'Simplified Chinese' }),
  Object.freeze({ id: 'zh-TW', label: '繁體中文', prompt: 'Traditional Chinese' }),
  Object.freeze({ id: 'en', label: 'English', prompt: 'English' }),
  Object.freeze({ id: 'ja', label: '日本語', prompt: 'Japanese' }),
  Object.freeze({ id: 'ko', label: '한국어', prompt: 'Korean' }),
]);

/** 实际的目标语言：设置里指定的优先，否则跟随界面语言（界面语言不在列表里时用简体中文）。 */
export const resolveStewardTranslationLanguage = (setting = '', uiLocale = '') => {
  const byId = id => STEWARD_TRANSLATION_LANGUAGES.find(language => language.id === id);
  const locale = text(uiLocale);
  return byId(text(setting)) || byId(locale) || byId(locale.split('-')[0]) || STEWARD_TRANSLATION_LANGUAGES[0];
};

// auto：事件自动触发；defaultEnabled：小管家开启后默认是否执行（存档命名默认开，与改版前「开启即自动命名」一致）；
// maxTokens：任务自己的输出上限（存档命名沿用小管家原本可调的 maxTokens）
export const STEWARD_TASKS = Object.freeze([
  Object.freeze({ id: 'archive_naming', title: '存档命名', trigger: '保存新存档时自动', auto: true, defaultEnabled: true }),
  // 离开聊天室也会触发，默认关：之前只为存档命名开小管家的人更新后不会突然多出请求
  Object.freeze({ id: 'archive_overview', title: '存档概述', trigger: '保存存档时；离开聊天室且有新消息时更新', auto: true, defaultEnabled: false, maxTokens: 200 }),
  Object.freeze({ id: 'translate_message', title: '消息翻译', trigger: '长按气泡「翻译」，或做成工具、绑定手势', auto: false, defaultEnabled: true, maxTokens: 4096 }),
  Object.freeze({ id: 'image_tags', title: '生图描述转英文标签', trigger: '生图提示词旁的「转成英文标签」', auto: false, defaultEnabled: true, maxTokens: 600 }),
  // needsVision：要看图，模型须能接收图片
  Object.freeze({ id: 'sticker_keywords', title: '贴图起名', trigger: '贴图面板的「起名」；加贴图时自动补上 AI 用的关键词', auto: false, defaultEnabled: true, maxTokens: 800, needsVision: true }),
  // 用户自己写的小任务（列在 customTasks）；这一项是总开关与它们共用的模型
  Object.freeze({ id: 'custom_tasks', title: '自定义任务', trigger: '在 Agent 工具箱里使用；也可做成工具、绑定手势', auto: false, defaultEnabled: true, maxTokens: 2048 }),
]);

// 自定义任务：输入取哪里、结果放哪里（只显示或填入，不直接改 APP 资料）
export const STEWARD_CUSTOM_INPUTS = Object.freeze(['selection', 'message', 'recent', 'input']);
export const STEWARD_CUSTOM_OUTPUTS = Object.freeze(['popup', 'bubble', 'input']);
export const STEWARD_CUSTOM_TASK_LIMIT = 12;
const CUSTOM_ID_RE = /^ct_[A-Za-z0-9]{4,24}$/;

export const createStewardCustomTaskId = () => `ct_${(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;

export const normalizeStewardCustomTasks = (value = []) => {
  const seen = new Set();
  return (Array.isArray(value) ? value : []).filter(plain).slice(0, STEWARD_CUSTOM_TASK_LIMIT).map((raw, index) => {
    let id = CUSTOM_ID_RE.test(text(raw.id)) ? text(raw.id) : `ct_auto${index + 1}`;
    if (seen.has(id)) id = `${id}x${index + 1}`;
    seen.add(id);
    const count = Math.trunc(Number(raw.recentCount));
    return {
      id,
      name: [...text(raw.name)].slice(0, 24).join('') || '自定义任务',
      input: STEWARD_CUSTOM_INPUTS.includes(raw.input) ? raw.input : 'message',
      recentCount: Number.isFinite(count) ? Math.min(30, Math.max(2, count)) : 8,
      prompt: String(raw.prompt ?? '').slice(0, 4000),
      output: STEWARD_CUSTOM_OUTPUTS.includes(raw.output) ? raw.output : 'popup',
      enabled: raw.enabled !== false,
    };
  });
};

/** 工具箱与工具里能用的自定义任务：小管家与「自定义任务」都可用、任务本身开着且写了要求。 */
export const listReadyStewardCustomTasks = (config = {}) => (isStewardTaskReady(config, 'custom_tasks')
  ? normalizeStewardCustomTasks(config.customTasks).filter(task => task.enabled && task.prompt.trim())
  : []);

export const getStewardTask = id => STEWARD_TASKS.find(task => task.id === id) || null;

export const normalizeStewardTasks = (value = {}) => Object.fromEntries(STEWARD_TASKS.map((task) => {
  const raw = plain(value?.[task.id]) ? value[task.id] : {};
  const language = text(raw.targetLanguage);
  return [task.id, {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : task.defaultEnabled,
    modelProfileId: text(raw.modelProfileId),
    ...(task.id === 'translate_message'
      ? { targetLanguage: STEWARD_TRANSLATION_LANGUAGES.some(item => item.id === language) ? language : '' }
      : {}),
  }];
}));

/** 小管家开着、这个任务也开着，才会执行。 */
export const isStewardTaskEnabled = (config = {}, taskId = '') => Boolean(
  config?.enabled === true && getStewardTask(taskId) && config.tasks?.[taskId]?.enabled !== false,
);

/** 任务实际用的模型：单独指定的优先，否则用共用模型。 */
export const resolveStewardTaskModelConfig = (config = {}, taskId = '') => {
  const override = text(config?.tasks?.[taskId]?.modelProfileId);
  return override ? { ...config, modelMode: 'profile', modelProfileId: override } : config;
};

/** 发请求用的配置：任务的模型，加上任务自己的输出上限。 */
export const resolveStewardTaskRequestConfig = (config = {}, taskId = '') => {
  const modelConfig = resolveStewardTaskModelConfig(config, taskId);
  const maxTokens = getStewardTask(taskId)?.maxTokens;
  return maxTokens ? { ...modelConfig, maxTokens } : modelConfig;
};

/** 入口要不要出现：小管家与任务都开着，且有模型可用。 */
export const isStewardTaskReady = (config = {}, taskId = '') => isStewardTaskEnabled(config, taskId)
  && config.modelMode === 'profile' && Boolean(text(config.modelProfileId));
