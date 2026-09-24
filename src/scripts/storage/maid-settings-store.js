import { safeInvoke } from '../utils/tauri.js';
import {
  DEFAULT_MAID_PROMPT,
  canonicalizeMaidPrompt,
  getLocalizedMaidPrompt,
} from '../agent/maid-prompt-defaults.js';
import { normalizeMaidGenerationSettings } from '../agent/maid-generation-settings.js';

export const MAID_SETTINGS_STORE_KEY = 'maid_settings_store_v1';
export const MAID_SETTINGS_STORE_VERSION = 1;

// 女仆单次任务的执行步数上限（ReAct hardMax）：与 maid-assistant-agent 的绝对上限 80 对齐
export const MAID_REACT_STEP_LIMIT_DEFAULT = 48;
export const MAID_REACT_STEP_LIMIT_MIN = 8;
export const MAID_REACT_STEP_LIMIT_MAX = 80;

export const normalizeMaidReactStepLimit = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') {
    return MAID_REACT_STEP_LIMIT_DEFAULT;
  }
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return MAID_REACT_STEP_LIMIT_DEFAULT;
  return Math.max(MAID_REACT_STEP_LIMIT_MIN, Math.min(MAID_REACT_STEP_LIMIT_MAX, numeric));
};

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const clone = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return Array.isArray(value) ? value.slice() : { ...value };
  }
};

const safeNow = (now = Date.now) => {
  try {
    const value = typeof now === 'function' ? now() : Date.now();
    return Number.isFinite(Number(value)) ? Number(value) : Date.now();
  } catch {
    return Date.now();
  }
};

const readLocalJson = (storage, key = '') => {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw || typeof raw !== 'string') return null;
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const writeLocalJson = (storage, key = '', value = {}) => {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
};

const loadKvDefault = async (key = '') => safeInvoke('load_kv', { name: key });

const saveKvDefault = async (key = '', value = {}) => safeInvoke('save_kv', { name: key, data: value });

const hasExplicitMemoryExtractionSettings = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  return Boolean(
    isPlainObject(src.memoryExtraction) ||
    Object.prototype.hasOwnProperty.call(src, 'memoryExtractionMode') ||
    Object.prototype.hasOwnProperty.call(src, 'memoryExtractionProfileId') ||
    Object.prototype.hasOwnProperty.call(src, 'memoryExtractionModelOverride') ||
    Object.prototype.hasOwnProperty.call(src, 'memoryExtractionFallbackToMain')
  );
};

const hasExplicitSettings = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  return Boolean(
    trim(src.boundProfileId) ||
    trim(src.maidPrompt) ||
    trim(src.personaPrompt) ||
    ['realtime', 'stt'].includes(src.voiceInputMode) ||
    hasExplicitMemoryExtractionSettings(src)
  );
};

const hasExplicitPrompt = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  return Boolean(trim(src.maidPrompt) || trim(src.personaPrompt));
};

const readTimestamp = (raw = {}) => {
  const value = Number(isPlainObject(raw) ? raw.updatedAt : 0);
  return Number.isFinite(value) ? value : 0;
};

const trimPersistedText = (value = '', maxLength = 160000) => {
  const text = trim(value);
  const limit = Math.max(0, Number(maxLength) || 0);
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
};

const chooseFieldFromSources = ({
  localRaw = {},
  kvRaw = {},
  localValue = '',
  kvValue = '',
  localHasValue = false,
  kvHasValue = false,
} = {}) => {
  if (localHasValue && kvHasValue) {
    return readTimestamp(kvRaw) >= readTimestamp(localRaw) ? kvValue : localValue;
  }
  if (kvHasValue) return kvValue;
  if (localHasValue) return localValue;
  return '';
};

const toPersistedMaidSettingsState = (state = {}, { now = Date.now } = {}) => {
  const normalized = normalizeMaidSettingsState(state, { now });
  return {
    version: normalized.version,
    updatedAt: normalized.updatedAt,
    boundProfileId: normalized.boundProfileId,
    boundModelOverride: normalized.boundModelOverride,
    voiceInputMode: normalized.voiceInputMode,
    voiceTaskExecutor: normalized.voiceTaskExecutor,
    generation: normalized.generation,
    fallbackProfileId: normalized.fallbackProfileId,
    subAgents: normalized.subAgents,
    subAgentRemindAt: normalized.subAgentRemindAt,
    maxReactSteps: normalized.maxReactSteps,
    memoryExtractionMode: normalized.memoryExtraction.mode,
    memoryExtractionProfileId: normalized.memoryExtraction.profileId,
    memoryExtractionModelOverride: normalized.memoryExtraction.modelOverride,
    memoryExtractionFallbackToMain: normalized.memoryExtraction.fallbackToMain,
    maidPrompt: normalized.maidPrompt,
    lastRequestPrompt: trimPersistedText(normalized.lastRequestPrompt),
    lastAppContext: trimPersistedText(normalized.lastAppContext, 60000),
    lastFullResponse: trimPersistedText(normalized.lastFullResponse),
    lastExchangeAt: normalized.lastExchangeAt,
    lastExchangeSource: normalized.lastExchangeSource,
  };
};

export const MAID_SUB_AGENT_SKILLS = Object.freeze([
  { id: 'tool_calling', label: '擅长调用工具' },
  { id: 'persona_writing', label: '擅长写人物设定' },
  { id: 'prose_writing', label: '擅长写正文' },
  { id: 'summarization', label: '擅长归纳总结' },
  { id: 'worldbuilding', label: '擅长世界观设定' },
  { id: 'strict_format', label: '擅长格式严格任务' },
]);
const SUB_AGENT_SKILL_ID_SET = new Set(MAID_SUB_AGENT_SKILLS.map(item => item.id));

let subAgentSeq = 0;
export const normalizeMaidSubAgent = (raw = {}, { now = Date.now } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const modelProfileId = trim(src.modelProfileId);
  if (!modelProfileId) return null;
  subAgentSeq += 1;
  return {
    id: trim(src.id) || `sub-${safeNow(now)}-${subAgentSeq}`,
    name: trim(src.name).slice(0, 40) || `Sub-agent ${subAgentSeq}`,
    modelProfileId,
    modelOverride: trim(src.modelOverride).slice(0, 120),
    skills: (Array.isArray(src.skills) ? src.skills : [])
      .map(skill => trim(skill))
      .filter(skill => SUB_AGENT_SKILL_ID_SET.has(skill))
      .slice(0, 8),
    note: trim(src.note).slice(0, 200),
    enabled: src.enabled !== false,
  };
};

export const normalizeMaidMemoryExtractionSettings = (raw = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  return {
    mode: trim(src.mode).toLowerCase() === 'custom' ? 'custom' : 'follow_main',
    profileId: trim(src.profileId).slice(0, 120),
    modelOverride: trim(src.modelOverride).slice(0, 120),
    fallbackToMain: src.fallbackToMain === true,
  };
};

export const normalizeMaidSettingsState = (raw = {}, { now = Date.now } = {}) => {
  const src = isPlainObject(raw) ? raw : {};
  const maidPrompt = trim(src.maidPrompt || src.personaPrompt, DEFAULT_MAID_PROMPT);
  const nestedMemoryExtraction = isPlainObject(src.memoryExtraction) ? src.memoryExtraction : {};
  return {
    version: MAID_SETTINGS_STORE_VERSION,
    updatedAt: Number(src.updatedAt || safeNow(now)) || safeNow(now),
    boundProfileId: trim(src.boundProfileId),
    boundModelOverride: trim(src.boundModelOverride),
    voiceInputMode: src.voiceInputMode === 'stt' ? 'stt' : 'realtime',
    // 实时语音里的应用任务由谁执行：voice = 语音设置档的推理模型，maid = 女仆设置里的模型；空 = 用户还没选（按 voice）
    voiceTaskExecutor: ['voice', 'maid'].includes(src.voiceTaskExecutor) ? src.voiceTaskExecutor : '',
    // 女仆自己的思考模式/强度（与预设参数独立）
    generation: normalizeMaidGenerationSettings(src.generation),
    fallbackProfileId: trim(src.fallbackProfileId),
    subAgents: (Array.isArray(src.subAgents) ? src.subAgents : [])
      .map(item => normalizeMaidSubAgent(item, { now }))
      .filter(Boolean)
      .slice(0, 12),
    subAgentRemindAt: Number(src.subAgentRemindAt || 0) || 0,
    maxReactSteps: normalizeMaidReactStepLimit(src.maxReactSteps),
    memoryExtraction: normalizeMaidMemoryExtractionSettings({
      mode: nestedMemoryExtraction.mode ?? src.memoryExtractionMode,
      profileId: nestedMemoryExtraction.profileId ?? src.memoryExtractionProfileId,
      modelOverride: nestedMemoryExtraction.modelOverride ?? src.memoryExtractionModelOverride,
      fallbackToMain: nestedMemoryExtraction.fallbackToMain
        ?? src.memoryExtractionFallbackToMain,
    }),
    maidPrompt,
    personaPrompt: maidPrompt,
    lastRequestPrompt: trim(src.lastRequestPrompt),
    lastAppContext: trim(src.lastAppContext),
    lastFullResponse: trim(src.lastFullResponse),
    lastExchangeAt: Number(src.lastExchangeAt || 0) || 0,
    lastExchangeSource: trim(src.lastExchangeSource),
  };
};

export class MaidSettingsStore {
  constructor({
    storage = globalThis?.localStorage || null,
    loadKv = loadKvDefault,
    saveKv = saveKvDefault,
    now = Date.now,
  } = {}) {
    this.storage = storage;
    this.loadKv = typeof loadKv === 'function' ? loadKv : null;
    this.saveKv = typeof saveKv === 'function' ? saveKv : null;
    this.now = typeof now === 'function' ? now : Date.now;
    this.loaded = false;
    this.state = normalizeMaidSettingsState({}, { now: this.now });
  }

  async load() {
    const localRaw = readLocalJson(this.storage, MAID_SETTINGS_STORE_KEY) || {};
    const localState = normalizeMaidSettingsState(localRaw, {
      now: this.now,
    });
    let kvRaw = null;
    let kvState = null;
    try {
      kvRaw = await this.loadKv?.(MAID_SETTINGS_STORE_KEY);
      if (isPlainObject(kvRaw) && !kvRaw._tooLarge) {
        kvState = normalizeMaidSettingsState(kvRaw, { now: this.now });
      }
    } catch {}

    const localHasSettings = hasExplicitSettings(localRaw);
    const kvHasSettings = hasExplicitSettings(kvRaw);
    const localHasBound = Boolean(trim(localRaw.boundProfileId));
    const kvHasBound = Boolean(trim(kvRaw?.boundProfileId));
    const localHasPrompt = hasExplicitPrompt(localRaw);
    const kvHasPrompt = hasExplicitPrompt(kvRaw);
    const localHasMemoryExtraction = hasExplicitMemoryExtractionSettings(localRaw);
    const kvHasMemoryExtraction = hasExplicitMemoryExtractionSettings(kvRaw);
    const shouldWriteBackup = localHasSettings || kvHasSettings;

    const debugRaw = readTimestamp(kvRaw) >= readTimestamp(localRaw) ? kvRaw : localRaw;
    const memoryExtraction = (() => {
      if (localHasMemoryExtraction && kvHasMemoryExtraction) {
        return readTimestamp(kvRaw) >= readTimestamp(localRaw)
          ? kvState?.memoryExtraction
          : localState.memoryExtraction;
      }
      if (kvHasMemoryExtraction) return kvState?.memoryExtraction;
      if (localHasMemoryExtraction) return localState.memoryExtraction;
      return normalizeMaidMemoryExtractionSettings();
    })();

    this.state = normalizeMaidSettingsState({
      updatedAt: Math.max(readTimestamp(localRaw), readTimestamp(kvRaw), safeNow(this.now)),
      boundProfileId: chooseFieldFromSources({
        localRaw,
        kvRaw,
        localValue: localState.boundProfileId,
        kvValue: kvState?.boundProfileId || '',
        localHasValue: localHasBound,
        kvHasValue: kvHasBound,
      }),
      maidPrompt: chooseFieldFromSources({
        localRaw,
        kvRaw,
        localValue: localState.maidPrompt,
        kvValue: kvState?.maidPrompt || '',
        localHasValue: localHasPrompt,
        kvHasValue: kvHasPrompt,
      }) || DEFAULT_MAID_PROMPT,
      lastRequestPrompt: debugRaw?.lastRequestPrompt || '',
      lastAppContext: debugRaw?.lastAppContext || '',
      lastFullResponse: debugRaw?.lastFullResponse || '',
      lastExchangeAt: debugRaw?.lastExchangeAt || 0,
      lastExchangeSource: debugRaw?.lastExchangeSource || '',
      // 新增字段必须进入合并列表，否则 load 会以默认空值重建并在写回时抹掉持久化数据
      voiceInputMode: chooseFieldFromSources({ localRaw, kvRaw,
        localValue: localState.voiceInputMode, kvValue: kvState?.voiceInputMode,
        localHasValue: Object.hasOwn(localRaw, 'voiceInputMode'),
        kvHasValue: Boolean(kvRaw && Object.hasOwn(kvRaw, 'voiceInputMode')),
      }),
      voiceTaskExecutor: chooseFieldFromSources({ localRaw, kvRaw,
        localValue: localState.voiceTaskExecutor, kvValue: kvState?.voiceTaskExecutor,
        localHasValue: Object.hasOwn(localRaw, 'voiceTaskExecutor'),
        kvHasValue: Boolean(kvRaw && Object.hasOwn(kvRaw, 'voiceTaskExecutor')),
      }),
      generation: chooseFieldFromSources({ localRaw, kvRaw,
        localValue: localState.generation, kvValue: kvState?.generation,
        localHasValue: Object.hasOwn(localRaw, 'generation'),
        kvHasValue: Boolean(kvRaw && Object.hasOwn(kvRaw, 'generation')),
      }),
      boundModelOverride: (readTimestamp(kvRaw) >= readTimestamp(localRaw) ? kvState : localState)?.boundModelOverride
        || kvState?.boundModelOverride || localState.boundModelOverride || '',
      fallbackProfileId: (readTimestamp(kvRaw) >= readTimestamp(localRaw) ? kvState : localState)?.fallbackProfileId
        || kvState?.fallbackProfileId || localState.fallbackProfileId || '',
      subAgents: (() => {
        const newer = readTimestamp(kvRaw) >= readTimestamp(localRaw) ? kvState : localState;
        if (Array.isArray(newer?.subAgents) && newer.subAgents.length) return newer.subAgents;
        if (Array.isArray(kvState?.subAgents) && kvState.subAgents.length) return kvState.subAgents;
        return localState.subAgents || [];
      })(),
      subAgentRemindAt: Math.max(Number(kvState?.subAgentRemindAt || 0), Number(localState.subAgentRemindAt || 0)),
      maxReactSteps: (() => {
        const localHas = Object.prototype.hasOwnProperty.call(localRaw, 'maxReactSteps');
        const kvHas = Boolean(kvRaw && Object.prototype.hasOwnProperty.call(kvRaw, 'maxReactSteps'));
        if (localHas && kvHas) {
          return readTimestamp(kvRaw) >= readTimestamp(localRaw)
            ? kvState?.maxReactSteps
            : localState.maxReactSteps;
        }
        if (kvHas) return kvState?.maxReactSteps;
        if (localHas) return localState.maxReactSteps;
        return MAID_REACT_STEP_LIMIT_DEFAULT;
      })(),
      memoryExtraction,
    }, { now: this.now });

    if (shouldWriteBackup && this.saveKv) {
      try {
        await this.saveKv(MAID_SETTINGS_STORE_KEY, toPersistedMaidSettingsState(this.state, { now: this.now }));
      } catch {}
    }
    if (shouldWriteBackup) {
      writeLocalJson(this.storage, MAID_SETTINGS_STORE_KEY, toPersistedMaidSettingsState(this.state, { now: this.now }));
    }
    this.loaded = true;
    return this.exportState();
  }

  ensureLoaded() {
    if (!this.loaded) {
      this.state = normalizeMaidSettingsState(readLocalJson(this.storage, MAID_SETTINGS_STORE_KEY) || {}, {
        now: this.now,
      });
      this.loaded = true;
    }
  }

  async write() {
    this.ensureLoaded();
    this.state.updatedAt = safeNow(this.now);
    const persisted = toPersistedMaidSettingsState(this.state, { now: this.now });
    let kvSaved = false;
    try {
      await this.saveKv?.(MAID_SETTINGS_STORE_KEY, persisted);
      kvSaved = Boolean(this.saveKv);
    } catch {}
    const localSaved = writeLocalJson(this.storage, MAID_SETTINGS_STORE_KEY, persisted);
    return kvSaved || localSaved;
  }

  getBoundProfileId() {
    this.ensureLoaded();
    return trim(this.state.boundProfileId);
  }

  // 可选模型覆盖：连接沿用绑定档，仅替换 model；空 = 用档内保存的模型
  getBoundModelOverride() {
    this.ensureLoaded();
    return trim(this.state.boundModelOverride);
  }

  getVoiceInputMode() {
    this.ensureLoaded();
    return this.state.voiceInputMode;
  }

  async setVoiceInputMode(mode) {
    this.ensureLoaded();
    this.state.voiceInputMode = mode === 'stt' ? 'stt' : 'realtime';
    await this.write();
    return this.getVoiceInputMode();
  }

  // 用户是否已在首次语音时选过任务执行方式
  hasChosenVoiceTaskExecutor() {
    this.ensureLoaded();
    return ['voice', 'maid'].includes(this.state.voiceTaskExecutor);
  }

  getVoiceTaskExecutor() {
    this.ensureLoaded();
    return this.state.voiceTaskExecutor === 'maid' ? 'maid' : 'voice';
  }

  async setVoiceTaskExecutor(executor) {
    this.ensureLoaded();
    this.state.voiceTaskExecutor = executor === 'maid' ? 'maid' : 'voice';
    await this.write();
    return this.getVoiceTaskExecutor();
  }

  getGenerationSettings() {
    this.ensureLoaded();
    return normalizeMaidGenerationSettings(this.state.generation);
  }

  async setGenerationSettings(patch = {}) {
    this.ensureLoaded();
    this.state.generation = normalizeMaidGenerationSettings({ ...this.state.generation, ...patch });
    await this.write();
    return this.getGenerationSettings();
  }

  async setBoundModelOverride(model = '') {
    this.ensureLoaded();
    this.state.boundModelOverride = trim(model);
    await this.write();
    return this.getBoundModelOverride();
  }

  getFallbackProfileId() {
    this.ensureLoaded();
    return trim(this.state.fallbackProfileId);
  }

  async setFallbackProfileId(profileId = '') {
    this.ensureLoaded();
    this.state.fallbackProfileId = trim(profileId);
    await this.write();
    return this.getFallbackProfileId();
  }

  listSubAgents() {
    this.ensureLoaded();
    return (this.state.subAgents || []).map(item => ({ ...item, skills: [...item.skills] }));
  }

  async upsertSubAgent(subAgent = {}) {
    this.ensureLoaded();
    const normalized = normalizeMaidSubAgent(subAgent, { now: this.now });
    if (!normalized) return null;
    const list = this.state.subAgents || [];
    const index = list.findIndex(item => item.id === normalized.id);
    if (index >= 0) list[index] = normalized;
    else list.push(normalized);
    this.state.subAgents = list.slice(0, 12);
    await this.write();
    return { ...normalized };
  }

  async removeSubAgent(subAgentId = '') {
    this.ensureLoaded();
    const id = trim(subAgentId);
    const before = (this.state.subAgents || []).length;
    this.state.subAgents = (this.state.subAgents || []).filter(item => item.id !== id);
    const removed = this.state.subAgents.length < before;
    if (removed) await this.write();
    return removed;
  }

  getSubAgentRemindAt() {
    this.ensureLoaded();
    return Number(this.state.subAgentRemindAt || 0) || 0;
  }

  async setSubAgentRemindAt(at = 0) {
    this.ensureLoaded();
    this.state.subAgentRemindAt = Number(at) || 0;
    await this.write();
  }

  getMaxReactSteps() {
    this.ensureLoaded();
    return normalizeMaidReactStepLimit(this.state.maxReactSteps);
  }

  async setMaxReactSteps(value = MAID_REACT_STEP_LIMIT_DEFAULT) {
    this.ensureLoaded();
    this.state.maxReactSteps = normalizeMaidReactStepLimit(value);
    await this.write();
    return this.getMaxReactSteps();
  }

  getMemoryExtractionSettings() {
    this.ensureLoaded();
    return clone(this.state.memoryExtraction);
  }

  async setMemoryExtractionSettings(patch = {}) {
    this.ensureLoaded();
    this.state.memoryExtraction = normalizeMaidMemoryExtractionSettings({
      ...this.state.memoryExtraction,
      ...(isPlainObject(patch) ? patch : {}),
    });
    await this.write();
    return this.getMemoryExtractionSettings();
  }

  getPersonaPrompt() {
    return this.getMaidPrompt();
  }

  getMaidPrompt() {
    this.ensureLoaded();
    return getLocalizedMaidPrompt(trim(this.state.maidPrompt, DEFAULT_MAID_PROMPT));
  }

  getLastRequestPrompt() {
    this.ensureLoaded();
    return trim(this.state.lastRequestPrompt);
  }

  getLastFullResponse() {
    this.ensureLoaded();
    return trim(this.state.lastFullResponse);
  }

  getLastAppContext() {
    this.ensureLoaded();
    return trim(this.state.lastAppContext);
  }

  getLastExchange() {
    this.ensureLoaded();
    return {
      requestPrompt: trim(this.state.lastRequestPrompt),
      appContext: trim(this.state.lastAppContext),
      fullResponse: trim(this.state.lastFullResponse),
      at: Number(this.state.lastExchangeAt || 0) || 0,
      source: trim(this.state.lastExchangeSource),
    };
  }

  async setBoundProfileId(profileId = '') {
    this.ensureLoaded();
    this.state.boundProfileId = trim(profileId);
    await this.write();
    return this.getBoundProfileId();
  }

  async setPersonaPrompt(personaPrompt = '') {
    return this.setMaidPrompt(personaPrompt);
  }

  async setMaidPrompt(maidPrompt = '') {
    this.ensureLoaded();
    this.state.maidPrompt = canonicalizeMaidPrompt(trim(maidPrompt, DEFAULT_MAID_PROMPT));
    this.state.personaPrompt = this.state.maidPrompt;
    await this.write();
    return this.getMaidPrompt();
  }

  async savePatch(patch = {}) {
    this.ensureLoaded();
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'boundProfileId')) {
      this.state.boundProfileId = trim(patch.boundProfileId);
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'personaPrompt')) {
      this.state.maidPrompt = canonicalizeMaidPrompt(trim(patch.personaPrompt, DEFAULT_MAID_PROMPT));
      this.state.personaPrompt = this.state.maidPrompt;
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'maidPrompt')) {
      this.state.maidPrompt = canonicalizeMaidPrompt(trim(patch.maidPrompt, DEFAULT_MAID_PROMPT));
      this.state.personaPrompt = this.state.maidPrompt;
    }
    if (Object.prototype.hasOwnProperty.call(patch || {}, 'memoryExtraction')) {
      this.state.memoryExtraction = normalizeMaidMemoryExtractionSettings({
        ...this.state.memoryExtraction,
        ...(isPlainObject(patch.memoryExtraction) ? patch.memoryExtraction : {}),
      });
    }
    await this.write();
    return this.exportState();
  }

  setLastExchange({
    requestPrompt = '',
    appContext = '',
    fullResponse = '',
    at = safeNow(this.now),
    source = '',
  } = {}) {
    this.ensureLoaded();
    this.state.lastRequestPrompt = trim(requestPrompt);
    this.state.lastAppContext = trim(appContext);
    this.state.lastFullResponse = trim(fullResponse);
    this.state.lastExchangeAt = Number(at || 0) || safeNow(this.now);
    this.state.lastExchangeSource = trim(source);
    void this.write();
    return this.getLastExchange();
  }

  exportState() {
    this.ensureLoaded();
    return clone(this.state);
  }
}
