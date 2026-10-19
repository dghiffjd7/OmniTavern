// AC 工作流导出导入：纯函数，无 DOM、无存储。
// 创意写作带房子编排；聊天模式的流程按设定推导、没有板子，带 Agent、内置提示词、卡片开关与设定。
// 文件里不放 API 配置：模型设置档 ID 一律去掉、改为「跟随当前」，另记一份提醒清单。
// 导入时预设按名称复用或新建、修改文本／输入助手 Agent 换新 ID，板子与 Agent 里的引用随之更新。
import { t } from '../i18n/index.js';
import { validateHopscotchBoard } from '../ui/chat/hopscotch-board-utils.js';

export const AGENT_WORKFLOW_FORMAT = 'omnitavern.agent-workflow';
export const AGENT_WORKFLOW_VERSION = 1;
export const AGENT_WORKFLOW_CONFIGURABLE_IDS = Object.freeze(['text_completion', 'reply_check', 'archive_naming', 'text-edit:recap']);
// 跟写作工作流有关的设定（白名单）；不整份导出 app 设定（里面有联网搜索密钥、实时语音设置档 ID 等）
export const AGENT_WORKFLOW_SETTING_KEYS = Object.freeze([
  'memoryEnabled', 'memoryStorageMode', 'memoryTableEnabledWriting', 'memoryAutoExtract', 'memoryAutoExtractMode',
  'memoryUpdateApiMode', 'memoryUpdateContextRounds', 'memoryInjectPosition', 'memoryInjectDepth', 'memoryBudgetMode',
  'memoryInputBudgetTokens', 'memoryMaxRows', 'memoryMaxTokens', 'memoryAutoConfirm', 'memoryAutoStepByStep',
  'memoryFillEveryN', 'memorySummaryRowLimit', 'memorySummaryCompactionAuto', 'memorySummaryCompactionTrigger',
  'memorySummaryCompactionChars', 'summaryCompactionRules', 'summaryCompactionPromptSource', 'summaryCompactionPresetId',
  'autoImagePromptEnabled', 'autoImagePromptWritingEnabled', 'autoImagePromptStyle', 'autoImagePromptDecisionMode',
  'autoImagePromptCooldownRounds', 'autoImagePromptWindowRounds', 'autoImagePromptWindowMax',
  'autoImagePromptMaxConcurrency', 'autoImagePromptMaxPerResponse', 'autoImagePromptSkipRepeated',
]);
// 聊天模式的相关设定（同样不含密钥、设置档 ID）
export const AGENT_WORKFLOW_CHAT_SETTING_KEYS = Object.freeze([
  'memoryEnabled', 'memoryStorageMode', 'memoryTableEnabledChat', 'memoryTableEnabledMoments', 'memoryAutoExtract', 'memoryAutoExtractMode',
  'memoryUpdateApiMode', 'memoryUpdateContextRounds', 'memoryInjectPosition', 'memoryInjectDepth', 'memoryBudgetMode',
  'memoryInputBudgetTokens', 'memoryMaxRows', 'memoryMaxTokens', 'memoryAutoConfirm', 'memoryAutoStepByStep',
  'memoryFillEveryN', 'memorySummaryRowLimitChat', 'memoryGroupMemberReferenceEnabled', 'memoryGroupMemberReferenceLimit',
  'memorySummaryCompactionAuto', 'memorySummaryCompactionTrigger', 'memorySummaryCompactionChars', 'summaryCompactionRules',
  'summaryCompactionPromptSource', 'summaryCompactionPresetId', 'momentCommentSideEffectsEnabled',
  'autoImagePromptEnabled', 'autoImagePromptStyle', 'autoImagePromptDecisionMode', 'autoImagePromptCooldownRounds',
  'autoImagePromptWindowRounds', 'autoImagePromptWindowMax', 'autoImagePromptMaxConcurrency', 'autoImagePromptMaxPerResponse',
  'autoImagePromptSkipRepeated', 'autoImagePromptMomentMediaMode',
]);
// 聊天模式的 AC 卡片开关（整台设备共用），随「相关设定」导入
export const AGENT_WORKFLOW_CHAT_CARD_IDS = Object.freeze(['dialogue_agent', 'group_agent', 'phone_format_agent', 'moment_agent']);
const cardLabel = id => ({ dialogue_agent: t('私聊协议'), group_agent: t('群聊协议'), phone_format_agent: t('手机格式'), moment_agent: t('动态 Agent') })[id] || id;
const settingKeysOf = place => (place === 'chat' ? AGENT_WORKFLOW_CHAT_SETTING_KEYS : AGENT_WORKFLOW_SETTING_KEYS);
const placeOf = value => (value === 'chat' ? 'chat' : 'writing');
const TEXT_AGENT_RE = /^text-edit:[a-zA-Z0-9_-]+$/;
const INPUT_AGENT_RE = /^input-agent:[a-zA-Z0-9_-]+$/;

const trim = value => String(value ?? '').trim();
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const isRenamedWorkflowAgentId = id => (TEXT_AGENT_RE.test(id) || INPUT_AGENT_RE.test(id)) && !AGENT_WORKFLOW_CONFIGURABLE_IDS.includes(id);

// 板子里的每个房子（含融合在正文里的成员）
const eachHouse = (board, visit) => {
  for (const row of board?.rows || []) {
    for (const house of row.houses || []) {
      visit(house, null);
      for (const member of Object.values(house.fusedMembers || {})) visit(member, house);
    }
  }
};

// 模型改为跟随当前；原本用独立模型的记进提醒清单（只记名称与模型名，不记设置档 ID）
const followCurrentModel = (config, hint, hints) => {
  if (!isPlainObject(config) || config.modelMode !== 'profile') return config;
  hints.push({ ...hint, model: trim(config.modelOverride) });
  return { ...config, modelMode: 'follow_current', modelProfileId: '', modelOverride: '' };
};

const sanitizeAgentConfig = (id, config, hints) => {
  const out = followCurrentModel(clone(config), { type: 'agent', id, label: trim(config?.title) || id }, hints);
  out.inputConsent = false;
  if (isPlainObject(out.repairProfiles) && Array.isArray(out.repairProfiles.items)) {
    out.repairProfiles = {
      ...out.repairProfiles,
      items: out.repairProfiles.items.map(item => ({
        ...item,
        config: followCurrentModel(item?.config, { type: 'repair_profile', id: `${id}/${trim(item?.id)}`, label: trim(item?.name) || trim(item?.id) }, hints),
      })),
    };
  }
  return out;
};

// 工作流里引用到的 openai 预设 ID（房子、Agent、总结压缩）
export const collectWorkflowPresetIds = ({ board = null, agents = {}, settings = {} } = {}) => {
  const ids = new Set();
  eachHouse(board, (house) => {
    if ((house.kind === 'custom_prompt' || house.kind === 'image_prompt') && house.config?.promptSource === 'preset' && trim(house.config.presetId)) ids.add(trim(house.config.presetId));
  });
  Object.values(agents || {}).forEach((config) => {
    if (config?.promptSource === 'preset' && trim(config.presetId)) ids.add(trim(config.presetId));
  });
  if (settings?.summaryCompactionPromptSource === 'preset' && trim(settings.summaryCompactionPresetId)) ids.add(trim(settings.summaryCompactionPresetId));
  return [...ids];
};

// Agent 引用的「预设条目」：prompt:<类型>:<预设 ID>:<条目>（各段已 URI 编码，不含冒号）
const PROMPT_REF_RE = /^prompt:([^:]+):([^:]*):(.+)$/;
const promptRefsOf = config => (Array.isArray(config?.context?.prompts?.ids) ? config.context.prompts.ids : []);
const decodePart = (value) => { try { return decodeURIComponent(value); } catch { return value; } };

/**
 * 组装工作流文件。place：'writing' 创意写作（board 必填）／'chat' 聊天模式（不带板子）。
 * board：要导出的板子；agents：{id: 配置}（修改文本 Agent、输入助手、可配置 Agent）；bodyRule：正文范围规则；
 * promptProfiles：{ sysprompt, openai } 内置 Agent 提示词档；settings：app 设定；cards：{卡片 ID: 是否开启}（聊天）；
 * getPreset(type, id) 取预设内容。
 */
export const buildAgentWorkflowPackage = ({
  place = 'writing', name = '', scope = 'global', board = null, agents = {}, bodyRule = null, promptProfiles = {}, settings = {}, cards = {},
  getPreset = null, includePresets = true, appVersion = '', now = () => Date.now(),
} = {}) => {
  const where = placeOf(place);
  let outBoard = null;
  if (where === 'writing') {
    const validated = validateHopscotchBoard(board || {});
    if (!validated.ok) return { ok: false, reason: 'invalid_board', errors: validated.errors };
    outBoard = clone(validated.board);
  }
  const hints = [];
  eachHouse(outBoard, (house, parent) => {
    house.config = followCurrentModel(house.config, { type: 'house', id: house.id, label: parent ? `${parent.label} · ${house.label}` : house.label }, hints);
  });
  const outAgents = {};
  Object.entries(agents || {}).forEach(([id, config]) => {
    if (isPlainObject(config)) outAgents[id] = sanitizeAgentConfig(id, config, hints);
  });
  const outSettings = {};
  settingKeysOf(where).forEach((key) => {
    if (settings?.[key] !== undefined) outSettings[key] = clone(settings[key]);
  });
  const outCards = {};
  if (where === 'chat') {
    AGENT_WORKFLOW_CHAT_CARD_IDS.forEach((id) => {
      if (typeof cards?.[id] === 'boolean') outCards[id] = cards[id];
    });
  }
  if (outSettings.memoryUpdateApiMode === 'profile') {
    hints.push({ type: 'setting', id: 'memoryUpdateApiMode', label: t('记忆表格更新'), model: '' });
    outSettings.memoryUpdateApiMode = 'chat';
  }
  const presets = {};
  if (includePresets && typeof getPreset === 'function') {
    collectWorkflowPresetIds({ board: outBoard, agents: outAgents, settings: outSettings }).forEach((presetId) => {
      const preset = getPreset('openai', presetId);
      if (!preset) return;
      const { id: _omit, ...data } = clone(preset);
      presets[presetId] = { type: 'openai', name: trim(preset.name) || presetId, data };
    });
  }
  const profiles = {};
  ['sysprompt', 'openai'].forEach((type) => {
    if (isPlainObject(promptProfiles?.[type])) profiles[type] = clone(promptProfiles[type]);
  });
  return {
    ok: true,
    package: {
      format: AGENT_WORKFLOW_FORMAT,
      version: AGENT_WORKFLOW_VERSION,
      name: trim(name) || t('工作流'),
      exportedAt: now(),
      appVersion: trim(appVersion),
      source: { place: where, scope: scope === 'global' ? 'global' : where === 'chat' ? 'chat' : 'card' },
      board: outBoard,
      agents: outAgents,
      bodyRule: isPlainObject(bodyRule) ? clone(bodyRule) : null,
      promptProfiles: profiles,
      presets,
      settings: outSettings,
      cards: outCards,
      modelHints: hints,
    },
  };
};

/** 解析并校验工作流文件（文字或对象）。 */
export const parseAgentWorkflowPackage = (input) => {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input.replace(/^﻿/, ''));
    } catch {
      return { ok: false, reason: 'invalid_json', message: t('文件不是有效的 JSON') };
    }
  }
  if (!isPlainObject(data) || data.format !== AGENT_WORKFLOW_FORMAT) {
    return { ok: false, reason: 'not_a_workflow', message: t('这不是工作流文件') };
  }
  const version = Number(data.version);
  if (!Number.isInteger(version) || version < 1 || version > AGENT_WORKFLOW_VERSION) {
    return { ok: false, reason: 'unsupported_version', message: t('不支持的工作流版本 {value}，请更新 APP 后再导入', { value: trim(data.version) }) };
  }
  const place = placeOf(data.source?.place);
  let board = null;
  if (place === 'writing') {
    const validated = validateHopscotchBoard(data.board || {});
    if (!validated.ok) {
      return { ok: false, reason: 'invalid_board', message: validated.errors.map(item => item.message || item.code).join('；'), errors: validated.errors };
    }
    board = validated.board;
  }
  const agents = {};
  Object.entries(isPlainObject(data.agents) ? data.agents : {}).forEach(([id, config]) => {
    if ((AGENT_WORKFLOW_CONFIGURABLE_IDS.includes(id) || TEXT_AGENT_RE.test(id) || INPUT_AGENT_RE.test(id)) && isPlainObject(config)) {
      agents[id] = config;
    }
  });
  const settings = {};
  settingKeysOf(place).forEach((key) => {
    if (isPlainObject(data.settings) && data.settings[key] !== undefined) settings[key] = data.settings[key];
  });
  const cards = {};
  if (place === 'chat') {
    AGENT_WORKFLOW_CHAT_CARD_IDS.forEach((id) => {
      if (typeof data.cards?.[id] === 'boolean') cards[id] = data.cards[id];
    });
  }
  const presets = {};
  Object.entries(isPlainObject(data.presets) ? data.presets : {}).forEach(([id, preset]) => {
    if (trim(id) && preset?.type === 'openai' && isPlainObject(preset.data)) presets[trim(id)] = { type: 'openai', name: trim(preset.name) || trim(id), data: preset.data };
  });
  const promptProfiles = {};
  ['sysprompt', 'openai'].forEach((type) => {
    if (isPlainObject(data.promptProfiles?.[type])) promptProfiles[type] = data.promptProfiles[type];
  });
  return {
    ok: true,
    package: {
      format: AGENT_WORKFLOW_FORMAT,
      version,
      name: trim(data.name) || t('工作流'),
      exportedAt: Number(data.exportedAt) || 0,
      appVersion: trim(data.appVersion),
      source: { place, scope: data.source?.scope === 'global' ? 'global' : place === 'chat' ? 'chat' : 'card' },
      board,
      agents,
      bodyRule: isPlainObject(data.bodyRule) ? data.bodyRule : null,
      promptProfiles,
      presets,
      settings,
      cards,
      modelHints: (Array.isArray(data.modelHints) ? data.modelHints : []).filter(isPlainObject).slice(0, 100),
    },
  };
};

const worldbookNamesOf = config => (config?.context?.worldbook?.enabled ? config.context.worldbook.ids || [] : [])
  .map(id => trim(id).match(/^worldbook:([^:]+)/)?.[1] || '')
  .filter(Boolean);

/**
 * 导入预览：findPresetByName(type, name) 返回已有预设 ID（同名复用）或空；hasWorldbook(name) 判断世界书是否存在；
 * currentSettings／currentCards 用于列出设定与卡片开关的变化；hasPromptEntry(type, entryKey) 判断本机当前预设里有没有这个条目。
 */
export const planAgentWorkflowImport = (pkg, {
  findPresetByName = () => '', hasWorldbook = () => true, currentSettings = {}, currentCards = {}, hasPromptEntry = () => true,
} = {}) => {
  const houses = [];
  eachHouse(pkg.board, (house, parent) => {
    houses.push({ id: house.id, kind: house.kind, label: parent ? `${parent.label} · ${house.label}` : house.label, enabled: house.enabled !== false });
  });
  const agents = Object.entries(pkg.agents || {}).map(([id, config]) => ({
    id,
    title: trim(config.title) || id,
    kind: TEXT_AGENT_RE.test(id) && !AGENT_WORKFLOW_CONFIGURABLE_IDS.includes(id) ? 'text_edit' : INPUT_AGENT_RE.test(id) ? 'input_agent' : id,
    action: isRenamedWorkflowAgentId(id) ? 'create' : 'replace',
  }));
  const referenced = collectWorkflowPresetIds(pkg);
  const presets = referenced.map((sourceId) => {
    const bundled = pkg.presets?.[sourceId];
    if (!bundled) return { sourceId, name: '', action: 'missing' };
    const existing = trim(findPresetByName('openai', bundled.name));
    return { sourceId, name: bundled.name, action: existing ? 'reuse' : 'create', existingId: existing };
  });
  const missingWorldbooks = [...new Set(Object.values(pkg.agents || {}).flatMap(worldbookNamesOf))].filter(name => !hasWorldbook(name));
  const settingsChanges = Object.entries(pkg.settings || {})
    .filter(([key, value]) => JSON.stringify(currentSettings?.[key]) !== JSON.stringify(value))
    .map(([key, value]) => ({ key, from: currentSettings?.[key], to: value }));
  const cardChanges = Object.entries(pkg.cards || {})
    .filter(([id, enabled]) => (currentCards?.[id] !== false) !== enabled)
    .map(([id, enabled]) => ({ id, label: cardLabel(id), from: !enabled, to: enabled }));
  const missingPromptEntries = [];
  Object.values(pkg.agents || {}).forEach((config) => {
    promptRefsOf(config).forEach((ref) => {
      const match = trim(ref).match(PROMPT_REF_RE);
      if (!match) return;
      const type = decodePart(match[1]);
      const entry = decodePart(match[3]);
      if (!hasPromptEntry(type, entry)) missingPromptEntries.push({ agent: trim(config.title), type, entry: entry.replace(/^block:/, '') });
    });
  });
  return {
    name: pkg.name,
    place: placeOf(pkg.source?.place),
    houses,
    agents,
    presets,
    modelHints: pkg.modelHints || [],
    missingWorldbooks,
    missingPromptEntries,
    settingsChanges,
    cardChanges,
    promptProfileTypes: Object.keys(pkg.promptProfiles || {}),
  };
};

// 预设条目引用改指本机这一类当前所用的预设（原本指的是导出时所用的预设）
const remapPromptRefs = (config, currentPromptPresetIds) => {
  const refs = promptRefsOf(config);
  if (!refs.length) return config;
  const ids = refs.map((ref) => {
    const match = trim(ref).match(PROMPT_REF_RE);
    const presetId = match ? trim(currentPromptPresetIds?.[decodePart(match[1])]) : '';
    return presetId ? `prompt:${match[1]}:${encodeURIComponent(presetId)}:${match[3]}` : ref;
  });
  return { ...config, context: { ...config.context, prompts: { ...config.context.prompts, ids } } };
};

const remapPreset = (config, presetIdMap) => {
  if (!isPlainObject(config) || !trim(config.presetId)) return config;
  const next = trim(presetIdMap[trim(config.presetId)]);
  // 预设没带来也找不到：退回提示词
  return next ? { ...config, presetId: next } : { ...config, presetId: '', ...(config.promptSource === 'preset' ? { promptSource: 'prompt' } : {}) };
};

/**
 * 把工作流换算成要写入的内容。presetIdMap：{包内预设 ID: 本机预设 ID}；newAgentIds：{包内 Agent ID: 新 ID}；
 * currentPromptPresetIds：{类型: 本机当前所用预设 ID}，预设条目引用改指这里。
 */
export const buildAgentWorkflowWrites = (pkg, {
  presetIdMap = {}, newAgentIds = {}, includeSettings = true, includePromptProfiles = true, currentPromptPresetIds = {},
} = {}) => {
  const board = pkg.board ? clone(pkg.board) : null;
  eachHouse(board, (house) => {
    if (house.kind === 'text_edit' && house.config?.agentId) {
      house.config = { ...house.config, agentId: newAgentIds[house.config.agentId] || house.config.agentId };
    }
    if (house.kind === 'custom_prompt' || house.kind === 'image_prompt') house.config = remapPreset(house.config, presetIdMap);
  });
  if (board) board.source = 'user';
  const agents = Object.entries(pkg.agents || {}).map(([id, config]) => ({
    id: newAgentIds[id] || id,
    sourceId: id,
    config: { ...remapPromptRefs(remapPreset(clone(config), presetIdMap), currentPromptPresetIds), id: newAgentIds[id] || id },
  }));
  let settingsPatch = {};
  if (includeSettings) {
    settingsPatch = clone(pkg.settings || {});
    if (settingsPatch.summaryCompactionPresetId !== undefined) {
      const remapped = remapPreset({ presetId: settingsPatch.summaryCompactionPresetId, promptSource: settingsPatch.summaryCompactionPromptSource }, presetIdMap);
      settingsPatch.summaryCompactionPresetId = remapped.presetId;
      if (settingsPatch.summaryCompactionPromptSource !== undefined) settingsPatch.summaryCompactionPromptSource = remapped.promptSource;
    }
  }
  return {
    board,
    agents,
    bodyRule: isPlainObject(pkg.bodyRule) ? clone(pkg.bodyRule) : null,
    settingsPatch,
    cards: includeSettings ? clone(pkg.cards || {}) : {},
    promptProfiles: includePromptProfiles ? clone(pkg.promptProfiles || {}) : {},
  };
};
