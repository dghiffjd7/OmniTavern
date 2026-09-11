import { safeInvoke } from '../utils/tauri.js';

export const AGENT_FEATURE_SETTINGS_STORAGE_KEY = 'agent_feature_settings_v1';

export const AGENT_FEATURE_IDS = Object.freeze({
  replyCheck: 'reply_check',
  writePreview: 'write_preview',
  textCompletion: 'text_completion',
  promptManager: 'prompt_manager',
  memoryManager: 'memory_manager',
});

export const AGENT_FEATURE_TRIGGER_MODES = Object.freeze({
  auto: 'auto',
  manual: 'manual',
  // Backward-compatible aliases for older saved values and tests.
  autoModel: 'auto',
  localOnly: 'auto',
  manualOnly: 'manual',
});

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const toTimestamp = (now = Date.now) => {
  try {
    const value = typeof now === 'function' ? now() : now;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
  } catch {
    return Date.now();
  }
};

const readStorage = (storage = globalThis?.localStorage) => {
  try {
    return storage && typeof storage.getItem === 'function' && typeof storage.setItem === 'function'
      ? storage
      : null;
  } catch {
    return null;
  }
};

export const AGENT_FEATURE_DEFINITIONS = Object.freeze([
  {
    id: AGENT_FEATURE_IDS.replyCheck,
    title: '检查回复格式',
    summary: '检查聊天格式问题，或按创意写作会话的格式要求生成修复候选。',
    detailTitle: '检查回复格式',
    detail: [
      '聊天使用内建格式；创意写作先定义本会话的格式要求。',
      '创意写作启用自动触发后，每次回复完成时使用所选模型检查；修复候选通过差异预览确认。',
      '启用且 API 已配置时，会把当前已开启功能对应的格式要求一并提供给模型。',
      '只做格式缺漏、标签闭合、字段遗漏等检查；正文质量和剧情判断后续单独实现。',
      '解析失败且聊天室没有输出时会自动尝试修复；手动检查的修复候选仍由用户确认。',
    ],
    implemented: true,
    supportsModel: true,
    modelDefault: 'none',
    supportsTriggerMode: true,
    triggerDefault: AGENT_FEATURE_TRIGGER_MODES.auto,
  },
  {
    id: AGENT_FEATURE_IDS.writePreview,
    title: '预览记忆和变量变更',
    summary: 'AI 请求修改记忆、变量或世界书时，先显示可撤销预览。',
    detailTitle: '预览记忆和变量变更',
    detail: [
      '开启后会把预览工具加入当前会话可请求范围。',
      '工具只生成变更预览，不会直接写入记忆、变量或世界书。',
      '真正提交需要二次确认，提交后可撤销本次变更。',
    ],
    implemented: true,
    supportsModel: false,
    modelDefault: 'none',
    supportsTriggerMode: false,
    triggerDefault: AGENT_FEATURE_TRIGGER_MODES.autoModel,
  },
  {
    id: AGENT_FEATURE_IDS.textCompletion,
    title: '文本建议',
    summary: '输入停顿时，在光标处提供短句续写。',
    detailTitle: '文本建议',
    detail: [
      '适用于聊天与创意写作主输入框，使用独立选择的模型配置。',
      '输入停顿后将当前输入的光标前后文交给所选模型续写。',
      'Tab 或点击建议条采纳全部；按住 Tab 用左右方向键逐字选择，松开采纳。',
      '手机长按建议文本后左右拖选，松手采纳；拖到边缘可查看后续文字。',
      'Esc 关闭；继续输入可获取新建议。',
      '中文输入法组字期间暂停；每分钟最多请求 12 次。',
    ],
    implemented: true,
    supportsModel: true,
    modelDefault: 'none',
    supportsTriggerMode: false,
    triggerDefault: AGENT_FEATURE_TRIGGER_MODES.auto,
  },
  {
    id: AGENT_FEATURE_IDS.promptManager,
    title: '提示词管家',
    summary: '只读检查提示词分类、重复、变量缺失和注入位置冲突。',
    detailTitle: '提示词管家',
    detail: [
      '定位是只读审计，不会自动修改提示词。',
      '后续会输出风险列表、整理建议和只读变更预览。',
      '真正修改仍进入 Prompt Library 详情页，由用户保存。',
    ],
    implemented: false,
    supportsModel: true,
    modelDefault: 'none',
    supportsTriggerMode: false,
    triggerDefault: AGENT_FEATURE_TRIGGER_MODES.manual,
  },
  {
    id: AGENT_FEATURE_IDS.memoryManager,
    title: '记忆管家',
    summary: '只读检查空表、重复行、跨模式共享范围和待确认写表变更。',
    detailTitle: '记忆管家',
    detail: [
      '定位是只读审计，不会自动写入或删除记忆。',
      '后续会输出表格健康度、当前会话注入摘要和清理建议。',
      '涉及写入时仍走记忆写入预览、确认、提交、撤销流程。',
    ],
    implemented: false,
    supportsModel: true,
    modelDefault: 'none',
    supportsTriggerMode: false,
    triggerDefault: AGENT_FEATURE_TRIGGER_MODES.manual,
  },
]);

const AGENT_FEATURE_ID_SET = new Set(AGENT_FEATURE_DEFINITIONS.map(item => item.id));

export const normalizeAgentFeatureModelMode = (value = '', fallback = 'follow_current') => {
  const text = trim(value).toLowerCase();
  if (text === 'none') return 'none';
  if (text === 'profile') return 'profile';
  return fallback === 'none' ? 'none' : 'follow_current';
};

export const normalizeAgentFeatureTriggerMode = (value = '', fallback = AGENT_FEATURE_TRIGGER_MODES.autoModel) => {
  const text = trim(value).toLowerCase();
  if (text === 'manual' || text === 'manual_only') return AGENT_FEATURE_TRIGGER_MODES.manual;
  if (text === 'auto' || text === 'auto_model' || text === 'local_only') return AGENT_FEATURE_TRIGGER_MODES.auto;
  return fallback === AGENT_FEATURE_TRIGGER_MODES.manual || fallback === 'manual_only'
    ? AGENT_FEATURE_TRIGGER_MODES.manual
    : AGENT_FEATURE_TRIGGER_MODES.auto;
};

export const normalizeAgentFeatureState = (state = {}, definition = {}, { now = Date.now } = {}) => {
  const src = isPlainObject(state) ? state : {};
  const modelDefault = normalizeAgentFeatureModelMode(definition.modelDefault, 'follow_current');
  const triggerDefault = normalizeAgentFeatureTriggerMode(definition.triggerDefault, AGENT_FEATURE_TRIGGER_MODES.autoModel);
  return {
    enabled: src.enabled === true,
    modelMode: definition.id === AGENT_FEATURE_IDS.textCompletion ? (src.modelMode === 'profile' ? 'profile' : 'none') : normalizeAgentFeatureModelMode(src.modelMode, modelDefault),
    modelProfileId: trim(src.modelProfileId),
    // 可选模型覆盖：连接沿用所选设定档，仅替换 model；空 = 用档内保存的模型
    modelOverride: trim(src.modelOverride),
    triggerMode: normalizeAgentFeatureTriggerMode(src.triggerMode, triggerDefault),
    ...(definition.id === AGENT_FEATURE_IDS.textCompletion ? { inputConsent: src.inputConsent === true } : {}),
    updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : 0,
  };
};

export const normalizeAgentFeatureSettings = (settings = {}) => {
  const src = isPlainObject(settings) ? settings : {};
  const featureSrc = isPlainObject(src.features) ? src.features : {};
  const features = {};
  AGENT_FEATURE_DEFINITIONS.forEach((definition) => {
    features[definition.id] = normalizeAgentFeatureState(featureSrc[definition.id], definition);
  });
  return {
    version: 1,
    features,
  };
};

export const mergeAgentFeatureSettings = (...items) => {
  const merged = normalizeAgentFeatureSettings();
  items
    .map(item => normalizeAgentFeatureSettings(item))
    .forEach((settings) => {
      AGENT_FEATURE_DEFINITIONS.forEach((definition) => {
        const id = definition.id;
        const current = merged.features[id] || {};
        const next = settings.features[id] || {};
        if (Number(next.updatedAt || 0) >= Number(current.updatedAt || 0)) {
          merged.features[id] = normalizeAgentFeatureState(next, definition);
        }
      });
    });
  return merged;
};

export const buildAgentFeatureList = (settings = {}) => {
  const normalized = normalizeAgentFeatureSettings(settings);
  return AGENT_FEATURE_DEFINITIONS.map(definition => ({
    ...definition,
    state: normalized.features[definition.id],
    enabled: normalized.features[definition.id]?.enabled === true,
  }));
};

export const setAgentFeatureEnabled = (settings = {}, featureId = '', enabled = false, {
  now = Date.now,
} = {}) => {
  const normalized = normalizeAgentFeatureSettings(settings);
  const id = trim(featureId);
  if (!AGENT_FEATURE_ID_SET.has(id)) return normalized;
  const definition = AGENT_FEATURE_DEFINITIONS.find(item => item.id === id) || {};
  normalized.features[id] = {
    ...normalizeAgentFeatureState(normalized.features[id], definition),
    enabled: enabled === true,
    ...(id === AGENT_FEATURE_IDS.textCompletion ? { inputConsent: enabled === true || normalized.features[id].inputConsent === true } : {}),
    updatedAt: toTimestamp(now),
  };
  return normalized;
};

export const setAgentFeatureModel = (settings = {}, featureId = '', {
  modelMode = '',
  modelProfileId = '',
  modelOverride,
} = {}, {
  now = Date.now,
} = {}) => {
  const normalized = normalizeAgentFeatureSettings(settings);
  const id = trim(featureId);
  if (!AGENT_FEATURE_ID_SET.has(id)) return normalized;
  const definition = AGENT_FEATURE_DEFINITIONS.find(item => item.id === id) || {};
  const prev = normalizeAgentFeatureState(normalized.features[id], definition);
  normalized.features[id] = {
    ...prev,
    modelMode: normalizeAgentFeatureModelMode(modelMode, prev.modelMode),
    modelProfileId: trim(modelProfileId),
    // 未传 modelOverride 保持原值；传空串显式清除
    modelOverride: modelOverride === undefined ? prev.modelOverride : trim(modelOverride),
    updatedAt: toTimestamp(now),
  };
  return normalized;
};

export const setAgentFeatureTriggerMode = (settings = {}, featureId = '', triggerMode = '', {
  now = Date.now,
} = {}) => {
  const normalized = normalizeAgentFeatureSettings(settings);
  const id = trim(featureId);
  if (!AGENT_FEATURE_ID_SET.has(id)) return normalized;
  const definition = AGENT_FEATURE_DEFINITIONS.find(item => item.id === id) || {};
  const prev = normalizeAgentFeatureState(normalized.features[id], definition);
  normalized.features[id] = {
    ...prev,
    triggerMode: normalizeAgentFeatureTriggerMode(triggerMode, prev.triggerMode),
    updatedAt: toTimestamp(now),
  };
  return normalized;
};

export const isAgentFeatureEnabled = (settings = {}, featureId = '') => {
  const normalized = normalizeAgentFeatureSettings(settings);
  return normalized.features[trim(featureId)]?.enabled === true;
};

export const readAgentFeatureSettings = ({
  storage = globalThis?.localStorage,
  key = AGENT_FEATURE_SETTINGS_STORAGE_KEY,
} = {}) => {
  const store = readStorage(storage);
  if (!store) return normalizeAgentFeatureSettings();
  try {
    const raw = store.getItem(key);
    return normalizeAgentFeatureSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeAgentFeatureSettings();
  }
};

export const writeAgentFeatureSettings = (settings = {}, {
  storage = globalThis?.localStorage,
  key = AGENT_FEATURE_SETTINGS_STORAGE_KEY,
} = {}) => {
  const normalized = normalizeAgentFeatureSettings(settings);
  const store = readStorage(storage);
  if (store) {
    try {
      store.setItem(key, JSON.stringify(normalized));
    } catch {}
  }
  return normalized;
};

export const readAgentFeatureSettingsKv = async ({
  key = AGENT_FEATURE_SETTINGS_STORAGE_KEY,
  loadKv = safeInvoke,
} = {}) => {
  try {
    const raw = await loadKv('load_kv', { name: key });
    if (!raw || typeof raw !== 'object') return null;
    if (raw._tooLarge) return null;
    return normalizeAgentFeatureSettings(raw);
  } catch {
    return null;
  }
};

export const writeAgentFeatureSettingsKv = async (settings = {}, {
  key = AGENT_FEATURE_SETTINGS_STORAGE_KEY,
  saveKv = safeInvoke,
} = {}) => {
  const normalized = normalizeAgentFeatureSettings(settings);
  try {
    await saveKv('save_kv', { name: key, data: normalized });
    return true;
  } catch {
    return false;
  }
};

export const createAgentFeatureSettingsStore = ({
  storage = globalThis?.localStorage,
  key = AGENT_FEATURE_SETTINGS_STORAGE_KEY,
  loadKv = safeInvoke,
  saveKv = safeInvoke,
  onChange = null,
} = {}) => {
  let current = readAgentFeatureSettings({ storage, key });
  let kvWrite = Promise.resolve(false);
  const persistKv = (next) => {
    kvWrite = kvWrite
      .catch(() => false)
      .then(() => writeAgentFeatureSettingsKv(next, { key, saveKv }));
    return kvWrite;
  };
  const save = (next, { id = '', fields = [] } = {}) => {
    const normalizedNext = normalizeAgentFeatureSettings(next);
    const featureId = trim(id);
    const previousFeature = current.features?.[featureId] || {};
    const nextFeature = normalizedNext.features?.[featureId] || {};
    const patch = featureId
      ? fields.reduce((result, field) => {
          if (!Object.is(previousFeature[field], nextFeature[field])) result[field] = nextFeature[field];
          return result;
        }, {})
      : null;
    if (patch && !Object.keys(patch).length) {
      return Promise.resolve(normalizeAgentFeatureSettings(current));
    }
    current = writeAgentFeatureSettings(normalizedNext, { storage, key });
    const snapshot = current;
    return persistKv(snapshot).then(() => {
      if (patch && typeof onChange === 'function') {
        try {
          onChange({ id: featureId, patch: { ...patch } });
        } catch {}
      }
      return normalizeAgentFeatureSettings(snapshot);
    });
  };
  return {
    getSettings: () => normalizeAgentFeatureSettings(current),
    listFeatures: () => buildAgentFeatureList(current),
    isEnabled: featureId => isAgentFeatureEnabled(current, featureId),
    setEnabled: (featureId, enabled, options = {}) => save(
      setAgentFeatureEnabled(current, featureId, enabled, options),
      { id: featureId, fields: ['enabled'] },
    ),
    setModel: (featureId, options = {}, meta = {}) => save(
      setAgentFeatureModel(current, featureId, options, meta),
      { id: featureId, fields: ['modelMode', 'modelProfileId', 'modelOverride'] },
    ),
    setTriggerMode: (featureId, triggerMode, meta = {}) => save(
      setAgentFeatureTriggerMode(current, featureId, triggerMode, meta),
      { id: featureId, fields: ['triggerMode'] },
    ),
    replace: settings => save(settings),
    hydrate: async () => {
      const disk = await readAgentFeatureSettingsKv({ key, loadKv });
      if (disk) {
        current = writeAgentFeatureSettings(mergeAgentFeatureSettings(disk, current), { storage, key });
      }
      await writeAgentFeatureSettingsKv(current, { key, saveKv });
      return normalizeAgentFeatureSettings(current);
    },
    flush: () => kvWrite.catch(() => false),
  };
};
