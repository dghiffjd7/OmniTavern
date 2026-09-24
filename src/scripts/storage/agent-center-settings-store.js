import { safeInvoke } from '../utils/tauri.js';
import {
  canonicalizeOfficialPromptRecord,
  localizeOfficialPromptRecord,
} from '../i18n/prompt-locale.js';
import {
  exportGlobalSemanticPromptLibrary,
  importGlobalSemanticPromptLibrary,
  normalizeGlobalSemanticPromptLibrary,
  removeGlobalSemanticPromptBlock,
  reorderGlobalSemanticPromptBlocks,
  upsertGlobalSemanticPromptBlock,
} from '../agent/global-semantic-prompt-library.js';

export const AGENT_CENTER_SETTINGS_STORAGE_KEY = 'agent_center_settings_v1';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const clone = (value, fallback = null) => {
  try {
    if (value === undefined) return fallback;
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
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

export const makeAgentProfileKey = (profileType = '', presetId = '') => {
  const type = trim(profileType);
  const id = trim(presetId);
  return type && id ? `${type}:${id}` : '';
};

export const SYSPROMPT_AGENT_PROMPT_MAPPINGS = Object.freeze([
  {
    agentId: 'phone_format_agent',
    promptId: 'phone-format-intro',
    enabledKey: 'phone_format_intro_enabled',
    rulesKey: 'phone_format_intro_rules',
  },
  {
    agentId: 'phone_format_agent',
    promptId: 'phone-format-chat',
    enabledKey: 'phone_format_chat_enabled',
    rulesKey: 'phone_format_chat_rules',
  },
  {
    agentId: 'phone_format_agent',
    promptId: 'phone-format-moment',
    enabledKey: 'phone_format_moment_enabled',
    rulesKey: 'phone_format_moment_rules',
  },
  {
    agentId: 'phone_format_agent',
    promptId: 'phone-format-footer',
    enabledKey: 'phone_format_footer_enabled',
    rulesKey: 'phone_format_footer_rules',
  },
  {
    agentId: 'dialogue_agent',
    promptId: 'dialogue',
    enabledKey: 'dialogue_enabled',
    positionKey: 'dialogue_position',
    depthKey: 'dialogue_depth',
    roleKey: 'dialogue_role',
    rulesKey: 'dialogue_rules',
    defaults: { position: 0, depth: 1, role: 0 },
  },
  {
    agentId: 'moment_agent',
    promptId: 'moment',
    enabledKey: 'moment_create_enabled',
    positionKey: 'moment_create_position',
    depthKey: 'moment_create_depth',
    roleKey: 'moment_create_role',
    rulesKey: 'moment_create_rules',
    defaults: { position: 0, depth: 1, role: 0 },
  },
  {
    agentId: 'moment_agent',
    promptId: 'moment-comment',
    enabledKey: 'moment_comment_enabled',
    positionKey: 'moment_comment_position',
    depthKey: 'moment_comment_depth',
    roleKey: 'moment_comment_role',
    rulesKey: 'moment_comment_rules',
    defaults: { position: 0, depth: 0, role: 0 },
  },
  {
    agentId: 'moment_agent',
    promptId: 'moment-publish-comment',
    enabledKey: 'moment_publish_comment_enabled',
    positionKey: 'moment_publish_comment_position',
    depthKey: 'moment_publish_comment_depth',
    roleKey: 'moment_publish_comment_role',
    rulesKey: 'moment_publish_comment_rules',
    defaults: { position: 0, depth: 0, role: 0 },
  },
  {
    agentId: 'image_director',
    promptId: 'auto-image-prompt',
    enabledKey: 'auto_image_prompt_enabled',
    positionKey: 'auto_image_prompt_position',
    depthKey: 'auto_image_prompt_depth',
    roleKey: 'auto_image_prompt_role',
    rulesKey: 'auto_image_prompt_rules',
    defaults: { position: 4, depth: 0, role: 0 },
  },
  {
    agentId: 'group_agent',
    promptId: 'group',
    enabledKey: 'group_enabled',
    positionKey: 'group_position',
    depthKey: 'group_depth',
    roleKey: 'group_role',
    rulesKey: 'group_rules',
    defaults: { position: 0, depth: 1, role: 0 },
  },
  {
    agentId: 'summary_agent',
    promptId: 'summary',
    enabledKey: 'summary_enabled',
    positionKey: 'summary_position',
    rulesKey: 'summary_rules',
    defaults: { position: 1, depth: 1, role: 0 },
  },
]);

const getSyspromptMapping = (agentId = '', promptId = '') => (
  SYSPROMPT_AGENT_PROMPT_MAPPINGS.find(mapping => (
    mapping.agentId === trim(agentId) && mapping.promptId === trim(promptId)
  )) || null
);

const transformOfficialPromptRules = (
  rules = '',
  mapping = null,
  officialPromptDefaults = {},
  transform = localizeOfficialPromptRecord,
) => {
  const rulesKey = trim(mapping?.rulesKey);
  const canonical = rulesKey && typeof officialPromptDefaults?.[rulesKey] === 'string'
    ? officialPromptDefaults[rulesKey]
    : null;
  if (!rulesKey || canonical === null) return String(rules ?? '');
  return transform(
    { [rulesKey]: String(rules ?? '') },
    { [rulesKey]: canonical },
  )[rulesKey];
};

const localizeOfficialPromptRules = (rules, mapping, officialPromptDefaults) => (
  transformOfficialPromptRules(
    rules,
    mapping,
    officialPromptDefaults,
    localizeOfficialPromptRecord,
  )
);

const canonicalizeOfficialPromptRules = (rules, mapping, officialPromptDefaults) => (
  transformOfficialPromptRules(
    rules,
    mapping,
    officialPromptDefaults,
    canonicalizeOfficialPromptRecord,
  )
);

export const MEMORY_AGENT_SETTING_KEYS = Object.freeze({
  dataPosition: 'memory_data_position',
  dataDepth: 'memory_data_depth',
  guidePosition: 'memory_guide_position',
  guideDepth: 'memory_guide_depth',
});

const normalizePromptConfig = (prompt = {}) => {
  const src = isPlainObject(prompt) ? prompt : {};
  const out = {
    enabled: src.enabled !== false,
    rules: typeof src.rules === 'string' ? src.rules : '',
  };
  if (Number.isFinite(Number(src.position))) out.position = Math.trunc(Number(src.position));
  if (Number.isFinite(Number(src.depth))) out.depth = Math.max(0, Math.trunc(Number(src.depth)));
  if (Number.isFinite(Number(src.role))) out.role = Math.trunc(Number(src.role));
  if (Number.isFinite(Number(src.updatedAt))) out.updatedAt = Number(src.updatedAt);
  return out;
};

const normalizePromptConfigPatch = (prompt = {}) => {
  const src = isPlainObject(prompt) ? prompt : {};
  const out = {};
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.rules === 'string') out.rules = src.rules;
  if (Number.isFinite(Number(src.position))) out.position = Math.trunc(Number(src.position));
  if (Number.isFinite(Number(src.depth))) out.depth = Math.max(0, Math.trunc(Number(src.depth)));
  if (Number.isFinite(Number(src.role))) out.role = Math.trunc(Number(src.role));
  if (Number.isFinite(Number(src.updatedAt))) out.updatedAt = Number(src.updatedAt);
  return out;
};

const normalizeAgentProfile = (profile = {}) => {
  const src = isPlainObject(profile) ? profile : {};
  const prompts = {};
  const rawPrompts = isPlainObject(src.prompts) ? src.prompts : {};
  Object.entries(rawPrompts).forEach(([promptId, prompt]) => {
    const id = trim(promptId);
    if (id) prompts[id] = normalizePromptConfig(prompt);
  });
  const settings = isPlainObject(src.settings) ? clone(src.settings, {}) : {};
  return {
    enabled: src.enabled !== false,
    prompts,
    settings,
    updatedAt: Number(src.updatedAt || 0) || 0,
  };
};

const normalizeProfile = (profile = {}) => {
  const src = isPlainObject(profile) ? profile : {};
  const agents = {};
  const rawAgents = isPlainObject(src.agents) ? src.agents : {};
  Object.entries(rawAgents).forEach(([agentId, agent]) => {
    const id = trim(agentId);
    if (id) agents[id] = normalizeAgentProfile(agent);
  });
  return {
    profileType: trim(src.profileType),
    presetId: trim(src.presetId),
    presetName: trim(src.presetName),
    source: trim(src.source, 'preset'),
    agents,
    updatedAt: Number(src.updatedAt || 0) || 0,
  };
};

const localizeSyspromptProfile = (profile = null, officialPromptDefaults = {}) => {
  if (!profile || trim(profile.profileType) !== 'sysprompt') return clone(profile, null);
  const localized = normalizeProfile(profile);
  SYSPROMPT_AGENT_PROMPT_MAPPINGS.forEach((mapping) => {
    const prompt = localized.agents?.[mapping.agentId]?.prompts?.[mapping.promptId];
    if (!prompt || typeof prompt.rules !== 'string') return;
    prompt.rules = localizeOfficialPromptRules(
      prompt.rules,
      mapping,
      officialPromptDefaults,
    );
  });
  return localized;
};

const normalizeCardState = (card = {}) => {
  const src = isPlainObject(card) ? card : {};
  return {
    enabled: src.enabled !== false,
    updatedAt: Number(src.updatedAt || 0) || 0,
  };
};

export const normalizeAgentCenterSettings = (settings = {}) => {
  const src = isPlainObject(settings) ? settings : {};
  const profiles = {};
  const rawProfiles = isPlainObject(src.profiles) ? src.profiles : {};
  Object.entries(rawProfiles).forEach(([key, profile]) => {
    const id = trim(key);
    if (id) profiles[id] = normalizeProfile(profile);
  });
  const cards = {};
  const rawCards = isPlainObject(src.cards) ? src.cards : {};
  Object.entries(rawCards).forEach(([key, card]) => {
    const id = trim(key);
    if (id) cards[id] = normalizeCardState(card);
  });
  const globalSettings = isPlainObject(src.global) ? clone(src.global, {}) : {};
  return {
    version: 1,
    migrations: isPlainObject(src.migrations) ? clone(src.migrations, {}) : {},
    cards,
    profiles,
    global: {
      ...globalSettings,
      semanticPromptLibrary: normalizeGlobalSemanticPromptLibrary(
        globalSettings.semanticPromptLibrary,
      ),
    },
  };
};

export const getAgentCenterGlobalSemanticPromptLibrary = (settings = {}) => (
  normalizeAgentCenterSettings(settings).global.semanticPromptLibrary
);

const replaceGlobalSemanticPromptLibrary = (settings = {}, library = {}) => {
  const normalized = normalizeAgentCenterSettings(settings);
  normalized.global = {
    ...(normalized.global || {}),
    semanticPromptLibrary: normalizeGlobalSemanticPromptLibrary(library),
  };
  return normalizeAgentCenterSettings(normalized);
};

export const upsertAgentCenterGlobalSemanticPromptBlock = (settings = {}, patch = {}, options = {}) => {
  const current = normalizeAgentCenterSettings(settings);
  const mutation = upsertGlobalSemanticPromptBlock(
    current.global.semanticPromptLibrary,
    patch,
    options,
  );
  return {
    settings: replaceGlobalSemanticPromptLibrary(current, mutation.library),
    ...mutation,
  };
};

export const removeAgentCenterGlobalSemanticPromptBlock = (settings = {}, blockId = '') => {
  const current = normalizeAgentCenterSettings(settings);
  const library = removeGlobalSemanticPromptBlock(
    current.global.semanticPromptLibrary,
    blockId,
  );
  return {
    settings: replaceGlobalSemanticPromptLibrary(current, library),
    library,
  };
};

export const reorderAgentCenterGlobalSemanticPromptBlocks = (settings = {}, orderedIds = []) => {
  const current = normalizeAgentCenterSettings(settings);
  const library = reorderGlobalSemanticPromptBlocks(
    current.global.semanticPromptLibrary,
    orderedIds,
  );
  return {
    settings: replaceGlobalSemanticPromptLibrary(current, library),
    library,
  };
};

const ensureProfile = (settings, profileType = '', presetId = '', preset = {}, now = Date.now) => {
  const key = makeAgentProfileKey(profileType, presetId);
  if (!key) return null;
  const timestamp = toTimestamp(now);
  settings.profiles[key] = normalizeProfile({
    ...(settings.profiles[key] || {}),
    profileType,
    presetId,
    presetName: trim(preset?.name || presetId),
    updatedAt: settings.profiles[key]?.updatedAt || timestamp,
  });
  return settings.profiles[key];
};

const ensureProfileAgent = (profile, agentId = '', now = Date.now) => {
  const id = trim(agentId);
  if (!id) return null;
  const timestamp = toTimestamp(now);
  profile.agents[id] = normalizeAgentProfile({
    ...(profile.agents[id] || {}),
    updatedAt: profile.agents[id]?.updatedAt || timestamp,
  });
  return profile.agents[id];
};

const promptFromPreset = (preset = {}, mapping = {}, officialPromptDefaults = {}) => {
  const defaults = mapping.defaults || {};
  const prompt = {
    enabled: typeof preset?.[mapping.enabledKey] === 'boolean'
      ? preset[mapping.enabledKey]
      : true,
    rules: typeof preset?.[mapping.rulesKey] === 'string'
      ? canonicalizeOfficialPromptRules(
        preset[mapping.rulesKey],
        mapping,
        officialPromptDefaults,
      )
      : '',
  };
  if (mapping.positionKey) {
    prompt.position = Number.isFinite(Number(preset?.[mapping.positionKey]))
      ? Math.trunc(Number(preset[mapping.positionKey]))
      : Number(defaults.position || 0);
  }
  if (mapping.depthKey || Number.isFinite(Number(defaults.depth))) {
    prompt.depth = Number.isFinite(Number(preset?.[mapping.depthKey]))
      ? Math.max(0, Math.trunc(Number(preset[mapping.depthKey])))
      : Math.max(0, Math.trunc(Number(defaults.depth || 0)));
  }
  if (mapping.roleKey || Number.isFinite(Number(defaults.role))) {
    prompt.role = Number.isFinite(Number(preset?.[mapping.roleKey]))
      ? Math.trunc(Number(preset[mapping.roleKey]))
      : Math.trunc(Number(defaults.role || 0));
  }
  return normalizePromptConfig(prompt);
};

const mergeMissingPrompt = (target = {}, source = {}, now = Date.now) => {
  if (!isPlainObject(target) || !Object.keys(target).length) {
    return {
      ...normalizePromptConfig(source),
      updatedAt: toTimestamp(now),
    };
  }
  const next = normalizePromptConfig(target);
  const src = normalizePromptConfig(source);
  let changed = false;
  ['enabled', 'rules', 'position', 'depth', 'role'].forEach((key) => {
    if (next[key] === undefined && src[key] !== undefined) {
      next[key] = src[key];
      changed = true;
    }
    if (key === 'rules' && !String(next.rules || '').trim() && String(src.rules || '').trim()) {
      next.rules = src.rules;
      changed = true;
    }
  });
  if (changed || !next.updatedAt) next.updatedAt = toTimestamp(now);
  return next;
};

const applySyspromptPresetMigration = (settings, presetId = '', preset = {}, {
  now = Date.now,
  officialPromptDefaults = {},
} = {}) => {
  const profile = ensureProfile(settings, 'sysprompt', presetId, preset, now);
  if (!profile) return settings;
  SYSPROMPT_AGENT_PROMPT_MAPPINGS.forEach((mapping) => {
    const agent = ensureProfileAgent(profile, mapping.agentId, now);
    if (!agent) return;
    agent.prompts[mapping.promptId] = mergeMissingPrompt(
      agent.prompts[mapping.promptId],
      promptFromPreset(preset, mapping, officialPromptDefaults),
      now,
    );
  });
  profile.updatedAt = toTimestamp(now);
  return settings;
};

const memorySettingsFromPreset = (preset = {}) => ({
  dataPosition: trim(preset?.[MEMORY_AGENT_SETTING_KEYS.dataPosition]),
  dataDepth: Number.isFinite(Number(preset?.[MEMORY_AGENT_SETTING_KEYS.dataDepth]))
    ? Math.max(0, Math.trunc(Number(preset[MEMORY_AGENT_SETTING_KEYS.dataDepth])))
    : 0,
  guidePosition: trim(preset?.[MEMORY_AGENT_SETTING_KEYS.guidePosition]),
  guideDepth: Number.isFinite(Number(preset?.[MEMORY_AGENT_SETTING_KEYS.guideDepth]))
    ? Math.max(0, Math.trunc(Number(preset[MEMORY_AGENT_SETTING_KEYS.guideDepth])))
    : 0,
});

const applyOpenAIPresetMigration = (settings, presetId = '', preset = {}, { now = Date.now } = {}) => {
  const profile = ensureProfile(settings, 'openai', presetId, preset, now);
  if (!profile) return settings;
  const agent = ensureProfileAgent(profile, 'memory_table_agent', now);
  if (!agent) return settings;
  agent.settings = {
    ...memorySettingsFromPreset(preset),
    ...(isPlainObject(agent.settings) ? agent.settings : {}),
  };
  agent.updatedAt = agent.updatedAt || toTimestamp(now);
  profile.updatedAt = toTimestamp(now);
  return settings;
};

/* 注入整合语义澄清（2026-07-16）：注入选择条只管预览/列表展示，不动功能开关。
   此前 presetInjectDefaultOffV1 曾把私聊/群聊/动态发布/生图的 prompt 级启用压为 false，
   这里一次性回滚私聊/群聊/生图（动态发布在 v1 之前默认即关闭，不回滚）。 */
const INJECT_DEFAULT_OFF_ROLLBACK_PROMPTS = Object.freeze([
  { agentId: 'dialogue_agent', promptId: 'dialogue' },
  { agentId: 'group_agent', promptId: 'group' },
  { agentId: 'image_director', promptId: 'auto-image-prompt' },
]);

const applyInjectDefaultOffRollback = (settings, { now = Date.now } = {}) => {
  if (!settings.migrations?.presetInjectDefaultOffV1?.completed) return settings;
  if (settings.migrations?.presetInjectDefaultOffV1Rollback?.completed) return settings;
  Object.values(settings.profiles || {}).forEach((profile) => {
    if (trim(profile?.profileType) !== 'sysprompt') return;
    INJECT_DEFAULT_OFF_ROLLBACK_PROMPTS.forEach(({ agentId, promptId }) => {
      const prompt = profile?.agents?.[agentId]?.prompts?.[promptId];
      if (prompt && prompt.enabled === false) {
        prompt.enabled = true;
        prompt.updatedAt = toTimestamp(now);
      }
    });
  });
  settings.migrations.presetInjectDefaultOffV1Rollback = {
    completed: true,
    migratedAt: toTimestamp(now),
  };
  return settings;
};

export const migratePresetStateToAgentCenterSettings = (settings = {}, presetState = {}, {
  now = Date.now,
  force = false,
  officialPromptDefaults = {},
} = {}) => {
  const next = normalizeAgentCenterSettings(settings);
  const state = isPlainObject(presetState) ? presetState : {};
  if (!next.migrations?.presetPromptV1?.completed || force) {
    Object.entries(state.presets?.sysprompt || {}).forEach(([presetId, preset]) => {
      applySyspromptPresetMigration(next, presetId, preset, { now, officialPromptDefaults });
    });
    Object.entries(state.presets?.openai || {}).forEach(([presetId, preset]) => {
      applyOpenAIPresetMigration(next, presetId, preset, { now });
    });
    next.migrations.presetPromptV1 = {
      completed: true,
      migratedAt: toTimestamp(now),
    };
  }
  applyInjectDefaultOffRollback(next, { now });
  return normalizeAgentCenterSettings(next);
};

export const isLazyPresetMigrationNoop = (before = {}, after = {}, { profileType = '', presetId = '' } = {}) => {
  const key = makeAgentProfileKey(trim(profileType), presetId);
  const previous = normalizeAgentCenterSettings(before);
  if (!key || !previous.profiles?.[key]) return false;
  const candidate = normalizeAgentCenterSettings(after);
  if (!candidate.profiles?.[key]) return false;
  candidate.profiles[key] = { ...candidate.profiles[key], updatedAt: previous.profiles[key].updatedAt };
  return JSON.stringify(candidate) === JSON.stringify(previous);
};

export const lazyMigratePresetProfileToAgentCenterSettings = (settings = {}, {
  profileType = '',
  presetId = '',
  preset = {},
  now = Date.now,
  officialPromptDefaults = {},
} = {}) => {
  const next = normalizeAgentCenterSettings(settings);
  const type = trim(profileType);
  if (type === 'sysprompt') {
    applySyspromptPresetMigration(next, presetId, preset, { now, officialPromptDefaults });
  } else if (type === 'openai') {
    applyOpenAIPresetMigration(next, presetId, preset, { now });
  }
  return normalizeAgentCenterSettings(next);
};

const getProfileAgent = (settings = {}, profileType = '', presetId = '', agentId = '') => {
  const normalized = normalizeAgentCenterSettings(settings);
  const profile = normalized.profiles[makeAgentProfileKey(profileType, presetId)];
  return profile?.agents?.[agentId] || null;
};

const isCardEnabled = (settings = {}, agentId = '') => {
  const normalized = normalizeAgentCenterSettings(settings);
  const card = normalized.cards[trim(agentId)];
  return card ? card.enabled !== false : true;
};

export const resolveAgentSyspromptPreset = (settings = {}, {
  presetId = '',
  preset = {},
  officialPromptDefaults = {},
} = {}) => {
  const normalized = normalizeAgentCenterSettings(settings);
  const out = clone(preset, {}) || {};
  const profile = normalized.profiles[makeAgentProfileKey('sysprompt', presetId)] || null;
  SYSPROMPT_AGENT_PROMPT_MAPPINGS.forEach((mapping) => {
    const agent = profile?.agents?.[mapping.agentId] || null;
    const prompt = agent?.prompts?.[mapping.promptId] || null;
    const cardEnabled = isCardEnabled(normalized, mapping.agentId);
    const agentEnabled = agent ? agent.enabled !== false : true;
    if (prompt) {
      if (mapping.enabledKey) out[mapping.enabledKey] = cardEnabled && agentEnabled && prompt.enabled !== false;
      if (mapping.rulesKey && typeof prompt.rules === 'string') {
        out[mapping.rulesKey] = localizeOfficialPromptRules(
          prompt.rules,
          mapping,
          officialPromptDefaults,
        );
      }
      if (mapping.positionKey && prompt.position !== undefined) out[mapping.positionKey] = prompt.position;
      if (mapping.depthKey && prompt.depth !== undefined) out[mapping.depthKey] = prompt.depth;
      if (mapping.roleKey && prompt.role !== undefined) out[mapping.roleKey] = prompt.role;
    } else if (!cardEnabled && mapping.enabledKey) {
      out[mapping.enabledKey] = false;
    }
  });
  return out;
};

export const resolveAgentOpenAIPreset = (settings = {}, {
  presetId = '',
  preset = {},
} = {}) => {
  const out = clone(preset, {}) || {};
  const agent = getProfileAgent(settings, 'openai', presetId, 'memory_table_agent');
  const cfg = isPlainObject(agent?.settings) ? agent.settings : null;
  if (!cfg) return out;
  if (cfg.dataPosition !== undefined) out.memory_data_position = trim(cfg.dataPosition);
  if (cfg.dataDepth !== undefined) out.memory_data_depth = Math.max(0, Math.trunc(Number(cfg.dataDepth) || 0));
  if (cfg.guidePosition !== undefined) out.memory_guide_position = trim(cfg.guidePosition);
  if (cfg.guideDepth !== undefined) out.memory_guide_depth = Math.max(0, Math.trunc(Number(cfg.guideDepth) || 0));
  return out;
};

export const buildAgentCenterProfileView = (settings = {}, {
  syspromptResolved = null,
  openaiResolved = null,
  officialPromptDefaults = {},
} = {}) => {
  const normalized = normalizeAgentCenterSettings(settings);
  const syspromptKey = makeAgentProfileKey('sysprompt', syspromptResolved?.presetId);
  const openaiKey = makeAgentProfileKey('openai', openaiResolved?.presetId);
  return {
    sysprompt: {
      presetId: trim(syspromptResolved?.presetId),
      source: trim(syspromptResolved?.source),
      presetName: trim(syspromptResolved?.preset?.name || syspromptResolved?.presetId),
      profile: localizeSyspromptProfile(
        normalized.profiles[syspromptKey] || null,
        officialPromptDefaults,
      ),
    },
    openai: {
      presetId: trim(openaiResolved?.presetId),
      source: trim(openaiResolved?.source),
      presetName: trim(openaiResolved?.preset?.name || openaiResolved?.presetId),
      profile: clone(normalized.profiles[openaiKey] || null, null),
    },
  };
};

export const setAgentCardEnabled = (settings = {}, agentId = '', enabled = false, {
  now = Date.now,
} = {}) => {
  const normalized = normalizeAgentCenterSettings(settings);
  const id = trim(agentId);
  if (!id) return normalized;
  normalized.cards[id] = {
    enabled: enabled === true,
    updatedAt: toTimestamp(now),
  };
  return normalized;
};

export const setAgentPromptConfig = (settings = {}, {
  profileType = 'sysprompt',
  presetId = '',
  agentId = '',
  promptId = '',
  config = {},
  preset = {},
} = {}, {
  now = Date.now,
  officialPromptDefaults = {},
} = {}) => {
  const normalized = lazyMigratePresetProfileToAgentCenterSettings(settings, {
    profileType,
    presetId,
    preset,
    now,
    officialPromptDefaults,
  });
  const profile = ensureProfile(normalized, profileType, presetId, preset, now);
  const agent = ensureProfileAgent(profile, agentId, now);
  const id = trim(promptId);
  if (!agent || !id) return normalized;
  const configPatch = normalizePromptConfigPatch(config);
  if (trim(profileType) === 'sysprompt' && typeof configPatch.rules === 'string') {
    configPatch.rules = canonicalizeOfficialPromptRules(
      configPatch.rules,
      getSyspromptMapping(agentId, id),
      officialPromptDefaults,
    );
  }
  agent.prompts[id] = {
    ...normalizePromptConfig(agent.prompts[id]),
    ...configPatch,
    updatedAt: toTimestamp(now),
  };
  agent.updatedAt = toTimestamp(now);
  profile.updatedAt = toTimestamp(now);
  return normalizeAgentCenterSettings(normalized);
};

export const setMemoryAgentSettings = (settings = {}, {
  presetId = '',
  preset = {},
  config = {},
} = {}, {
  now = Date.now,
} = {}) => {
  const normalized = lazyMigratePresetProfileToAgentCenterSettings(settings, {
    profileType: 'openai',
    presetId,
    preset,
    now,
  });
  const profile = ensureProfile(normalized, 'openai', presetId, preset, now);
  const agent = ensureProfileAgent(profile, 'memory_table_agent', now);
  if (!agent) return normalized;
  agent.settings = {
    ...memorySettingsFromPreset(preset),
    ...(isPlainObject(agent.settings) ? agent.settings : {}),
    dataPosition: trim(config.dataPosition),
    dataDepth: Math.max(0, Math.trunc(Number(config.dataDepth) || 0)),
    guidePosition: trim(config.guidePosition),
    guideDepth: Math.max(0, Math.trunc(Number(config.guideDepth) || 0)),
  };
  agent.updatedAt = toTimestamp(now);
  profile.updatedAt = toTimestamp(now);
  return normalizeAgentCenterSettings(normalized);
};

export const mergeImportedAgentCenterSettings = (settings = {}, imported = {}, {
  presetIdMap = {},
  now = Date.now,
} = {}) => {
  const current = normalizeAgentCenterSettings(settings);
  const incoming = normalizeAgentCenterSettings(imported);
  const timestamp = toTimestamp(now);
  Object.entries(incoming.cards || {}).forEach(([cardId, card]) => {
    current.cards[cardId] = {
      ...normalizeCardState(card),
      updatedAt: timestamp,
    };
  });
  Object.entries(incoming.profiles || {}).forEach(([key, profile]) => {
    const type = trim(profile.profileType || key.split(':')[0]);
    const mappedPresetId = trim(presetIdMap[type]);
    const presetId = mappedPresetId || trim(profile.presetId || key.split(':').slice(1).join(':'));
    const nextKey = makeAgentProfileKey(type, presetId);
    if (!nextKey) return;
    current.profiles[nextKey] = normalizeProfile({
      ...profile,
      profileType: type,
      presetId,
      updatedAt: timestamp,
    });
  });
  current.global = {
    ...(current.global || {}),
    ...(incoming.global || {}),
  };
  current.migrations = {
    ...(current.migrations || {}),
    ...(incoming.migrations || {}),
    importedAgentCenterSettingsAt: timestamp,
  };
  // migration 是设备级历史；旧导出缺少 rollback 标记时，导入边界即视为已处理，
  // 避免下次启动把旧 default-off 历史放大到本机全部 profile。
  if (incoming.migrations?.presetInjectDefaultOffV1?.completed
    && !incoming.migrations?.presetInjectDefaultOffV1Rollback?.completed
    && !current.migrations?.presetInjectDefaultOffV1Rollback?.completed) {
    current.migrations.presetInjectDefaultOffV1Rollback = {
      completed: true,
      migratedAt: timestamp,
    };
  }
  return normalizeAgentCenterSettings(current);
};

export const readAgentCenterSettings = ({
  storage = globalThis?.localStorage,
  key = AGENT_CENTER_SETTINGS_STORAGE_KEY,
} = {}) => {
  const store = readStorage(storage);
  if (!store) return normalizeAgentCenterSettings();
  try {
    const raw = store.getItem(key);
    return normalizeAgentCenterSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return normalizeAgentCenterSettings();
  }
};

export const writeAgentCenterSettings = (settings = {}, {
  storage = globalThis?.localStorage,
  key = AGENT_CENTER_SETTINGS_STORAGE_KEY,
} = {}) => {
  const normalized = normalizeAgentCenterSettings(settings);
  const store = readStorage(storage);
  if (store) {
    try {
      store.setItem(key, JSON.stringify(normalized));
    } catch {}
  }
  return normalized;
};

export const readAgentCenterSettingsKv = async ({
  key = AGENT_CENTER_SETTINGS_STORAGE_KEY,
  loadKv = safeInvoke,
} = {}) => {
  try {
    const raw = await loadKv('load_kv', { name: key });
    if (!raw || typeof raw !== 'object') return null;
    if (raw._tooLarge) return null;
    return normalizeAgentCenterSettings(raw);
  } catch {
    return null;
  }
};

export const writeAgentCenterSettingsKv = async (settings = {}, {
  key = AGENT_CENTER_SETTINGS_STORAGE_KEY,
  saveKv = safeInvoke,
} = {}) => {
  const normalized = normalizeAgentCenterSettings(settings);
  try {
    await saveKv('save_kv', { name: key, data: normalized });
    return true;
  } catch {
    return false;
  }
};

// 状态整体的“最近更新时间”：取 profiles/agents/prompts、cards 与全局提示词块的最大 updatedAt
export const readAgentCenterSettingsRecency = (settings = {}) => {
  const normalized = normalizeAgentCenterSettings(settings);
  let latest = 0;
  const track = (value) => {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > latest) latest = numeric;
  };
  Object.values(normalized.profiles || {}).forEach((profile) => {
    track(profile?.updatedAt);
    Object.values(profile?.agents || {}).forEach((agent) => {
      track(agent?.updatedAt);
      Object.values(agent?.prompts || {}).forEach(prompt => track(prompt?.updatedAt));
    });
  });
  Object.values(normalized.cards || {}).forEach(card => track(card?.updatedAt));
  (normalized.global?.semanticPromptLibrary?.blocks || []).forEach((block) => {
    track(block?.updatedAt);
    track(block?.createdAt);
  });
  return latest;
};

export const createAgentCenterSettingsStore = ({
  storage = globalThis?.localStorage,
  key = AGENT_CENTER_SETTINGS_STORAGE_KEY,
  loadKv = safeInvoke,
  saveKv = safeInvoke,
  officialPromptDefaults = {},
} = {}) => {
  let current = readAgentCenterSettings({ storage, key });
  let kvWrite = Promise.resolve(false);
  const persistKv = (next) => {
    kvWrite = kvWrite
      .catch(() => false)
      .then(() => writeAgentCenterSettingsKv(next, { key, saveKv }));
    return kvWrite;
  };
  const save = (next) => {
    current = writeAgentCenterSettings(next, { storage, key });
    const snapshot = current;
    return persistKv(snapshot).then(() => normalizeAgentCenterSettings(snapshot));
  };
  const migratePresetState = (presetState = {}, options = {}) => save(migratePresetStateToAgentCenterSettings(
    current,
    presetState,
    { ...(options || {}), officialPromptDefaults },
  ));
  // 懒迁移在读取路径上被频繁调用（Agent Center 视图、状态胶囊）：结果除目标配置的 updatedAt 外
  // 与当前完全相同时视为无变化，不写盘、也不刷新时间戳
  const lazyMigratePresetProfile = (options = {}, meta = {}) => {
    const next = lazyMigratePresetProfileToAgentCenterSettings(current, {
      ...(options || {}),
      now: meta.now || Date.now,
      officialPromptDefaults,
    });
    if (isLazyPresetMigrationNoop(current, next, options)) return Promise.resolve(normalizeAgentCenterSettings(current));
    return save(next);
  };
  const saveGlobalPromptMutation = mutation => save(mutation.settings).then(settings => ({
    ok: true,
    settings,
    library: getAgentCenterGlobalSemanticPromptLibrary(settings),
    ...(mutation.block ? { block: mutation.block } : {}),
    ...(mutation.validation ? { validation: mutation.validation } : {}),
    ...(mutation.forcedDisabled === true ? { forcedDisabled: true } : {}),
  }));
  return {
    getSettings: () => normalizeAgentCenterSettings(current),
    getGlobalSemanticPromptLibrary: () => getAgentCenterGlobalSemanticPromptLibrary(current),
    exportGlobalSemanticPromptLibrary: options => exportGlobalSemanticPromptLibrary(
      getAgentCenterGlobalSemanticPromptLibrary(current),
      options || {},
    ),
    upsertGlobalSemanticPromptBlock: (patch = {}, options = {}) => saveGlobalPromptMutation(
      upsertAgentCenterGlobalSemanticPromptBlock(current, patch, options),
    ),
    removeGlobalSemanticPromptBlock: (blockId = '') => saveGlobalPromptMutation(
      removeAgentCenterGlobalSemanticPromptBlock(current, blockId),
    ),
    reorderGlobalSemanticPromptBlocks: (orderedIds = []) => saveGlobalPromptMutation(
      reorderAgentCenterGlobalSemanticPromptBlocks(current, orderedIds),
    ),
    importGlobalSemanticPromptLibrary: (payload = {}, options = {}) => {
      const imported = importGlobalSemanticPromptLibrary(payload, options);
      if (!imported.ok) return Promise.resolve(imported);
      return save(replaceGlobalSemanticPromptLibrary(current, imported.library)).then(settings => ({
        ...imported,
        settings,
        library: getAgentCenterGlobalSemanticPromptLibrary(settings),
      }));
    },
    setCardEnabled: (agentId, enabled, options = {}) => save(setAgentCardEnabled(current, agentId, enabled, options)),
    setPromptConfig: (options = {}, meta = {}) => save(setAgentPromptConfig(current, options, {
      ...(meta || {}),
      officialPromptDefaults,
    })),
    setMemorySettings: (options = {}, meta = {}) => save(setMemoryAgentSettings(current, options, meta)),
    mergeImported: (imported = {}, options = {}) => save(mergeImportedAgentCenterSettings(current, imported, options)),
    migratePresetState,
    lazyMigratePresetProfile,
    replace: settings => save(settings),
    hydrate: async () => {
      const disk = await readAgentCenterSettingsKv({ key, loadKv });
      // 新者优先：KV 写盘可能在上次退出时失败/滞后，无条件采用磁盘态会把
      // 较新的本地态（localStorage）回滚成旧值（表现为「保存过的设置重启后丢失」）
      if (disk && readAgentCenterSettingsRecency(disk) >= readAgentCenterSettingsRecency(current)) {
        current = writeAgentCenterSettings(disk, { storage, key });
      }
      await writeAgentCenterSettingsKv(current, { key, saveKv });
      return normalizeAgentCenterSettings(current);
    },
    resolveSyspromptPreset: options => resolveAgentSyspromptPreset(current, {
      ...(options || {}),
      officialPromptDefaults,
    }),
    resolveOpenAIPreset: options => resolveAgentOpenAIPreset(current, options || {}),
    buildProfileView: options => buildAgentCenterProfileView(current, {
      ...(options || {}),
      officialPromptDefaults,
    }),
    flush: () => kvWrite.catch(() => false),
  };
};
