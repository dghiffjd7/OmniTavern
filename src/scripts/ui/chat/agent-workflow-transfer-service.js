// AC 工作流导出导入服务：读取／写入房子板子（创意写作）、Agent 配置、预设、内置提示词档、卡片开关（聊天）与相关设定。
// 导入前把会被改动的内容备份到撤销槽（KV），中途失败按备份还原；「撤销这次导入」也用同一份备份。
import { t } from '../../i18n/index.js';
import {
  AGENT_WORKFLOW_CHAT_CARD_IDS,
  AGENT_WORKFLOW_CONFIGURABLE_IDS,
  buildAgentWorkflowPackage,
  buildAgentWorkflowWrites,
  isRenamedWorkflowAgentId,
  parseAgentWorkflowPackage,
  planAgentWorkflowImport,
} from '../../agent/agent-workflow-transfer.js';
import { BODY_SELECTOR_ID } from '../../storage/agent-config-store.js';
import { buildRestoredPresetUpsertPayload } from '../preset-import-dedupe-utils.js';

export const AGENT_WORKFLOW_UNDO_KV = 'agent_workflow_import_backup_v1';
const MAX_CUSTOM_AGENTS_PER_KIND = 8;

const trim = value => String(value ?? '').trim();
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const placeOf = context => (context?.place === 'writing' ? 'writing' : 'chat');
const uiModeOf = place => (place === 'writing' ? 'rp' : 'chat');

export const createAgentWorkflowTransferService = ({
  boardStore,
  getSessionSettings = () => ({}),
  agentConfigStore,
  getAgentContext,
  presetStore,
  findPresetIdByName = () => '',
  resolveImportedPresetIdByName,
  pickAgentCenterProfilesForPresets,
  agentCenterSettings,
  appSettings,
  notifySettingsChanged = () => {},
  listWorldbookNames = () => [],
  createAgentId,
  loadKv = null,
  saveKv = null,
  getAppVersion = () => '',
  now = () => Date.now(),
} = {}) => {
  let lastBackup = null;

  const resolvedPresets = (sessionId, place) => Object.fromEntries(['sysprompt', 'openai'].map(type => [
    type, presetStore?.getResolvedActive?.(type, { sessionId, uiMode: uiModeOf(place) }) || null,
  ]).filter(([, resolved]) => trim(resolved?.presetId)));
  const resolvedPresetIds = (sessionId, place) => Object.fromEntries(Object.entries(resolvedPresets(sessionId, place))
    .map(([type, resolved]) => [type, trim(resolved.presetId)]));

  // 本机这一类当前所用的预设里有没有这个条目（与 Agent 引用来源的取法一致）
  const presetHasEntry = (preset, type, entry) => {
    if (!preset) return false;
    if (type === 'openai') {
      const identifier = entry.startsWith('block:') ? entry.slice(6) : '';
      return Boolean(identifier) && (Array.isArray(preset.prompts) ? preset.prompts : []).some(block => !block?.marker && trim(block?.identifier) === identifier);
    }
    if (entry === 'content') return Boolean(trim(preset.content || preset.prompt));
    if (entry === 'post_history') return Boolean(trim(preset.post_history || preset.post_history_instructions));
    return false;
  };

  const configScopeOf = target => (target === 'global' ? 'global' : 'local');
  const currentCards = () => {
    const cards = agentCenterSettings.getSettings()?.cards || {};
    return Object.fromEntries(AGENT_WORKFLOW_CHAT_CARD_IDS.map(id => [id, cards[id]?.enabled !== false]));
  };

  /**
   * 导出：target 'global'（所有角色卡／聊天全局设置）或当前范围（'persona' 当前角色卡／'session' 当前聊天）。
   * board：面板当前看到的板子（只有创意写作需要）；context 可指定别的聊天（体验包）；agentsOnly 只带 Agent 与用到的预设。
   */
  const exportWorkflow = ({ target = 'persona', board = null, name = '', includePresets = true, context: contextOverride = null, agentsOnly = false } = {}) => {
    const context = contextOverride || getAgentContext();
    const place = placeOf(context);
    const readScope = target === 'global' ? 'global' : 'effective';
    const listed = agentConfigStore.list(context, readScope) || [];
    const inputAgentIds = listed.filter(item => item?.config?.kind === 'input_agent').map(item => item.id);
    let ids;
    if (place === 'writing') {
      const boardAgentIds = [];
      for (const row of board?.rows || []) {
        for (const house of row.houses || []) {
          if (house.kind === 'text_edit' && trim(house.config?.agentId)) boardAgentIds.push(trim(house.config.agentId));
        }
      }
      ids = [...boardAgentIds, ...inputAgentIds, ...AGENT_WORKFLOW_CONFIGURABLE_IDS.filter(id => id !== 'text-edit:recap')];
    } else {
      // 聊天的流程按设定推导：范围内的修改文本 Agent 都会出现在流程里
      const textAgentIds = listed.filter(item => item?.config?.kind === 'text_edit').map(item => item.id);
      ids = [...textAgentIds, ...inputAgentIds, ...AGENT_WORKFLOW_CONFIGURABLE_IDS.filter(id => id !== 'text-edit:recap')];
    }
    const agents = {};
    [...new Set(ids)].forEach((id) => {
      const item = agentConfigStore.read(id, context, readScope);
      // 内置 Agent 没改过（仍是默认）就不带，免得导入后盖掉对方自己的设置
      if (item?.config && !(AGENT_WORKFLOW_CONFIGURABLE_IDS.includes(id) && item.source === 'default')) agents[id] = item.config;
    });
    const bodyRule = agentConfigStore.read(BODY_SELECTOR_ID, context, readScope)?.config?.target || null;
    let promptProfiles = {};
    if (!agentsOnly) {
      const presetIds = resolvedPresetIds(context.sessionId, place);
      const picked = pickAgentCenterProfilesForPresets(agentCenterSettings.getSettings(), presetIds).profiles || {};
      promptProfiles = Object.fromEntries(Object.entries(presetIds)
        .map(([type, id]) => [type, picked[`${type}:${id}`]]).filter(([, profile]) => profile));
    }
    return buildAgentWorkflowPackage({
      place, name, scope: target === 'global' ? 'global' : 'local', board, agents, bodyRule, promptProfiles,
      settings: agentsOnly ? {} : appSettings.get(),
      cards: agentsOnly || place !== 'chat' ? {} : currentCards(),
      getPreset: (type, id) => presetStore?.getPreset?.(type, id) || null,
      includePresets, appVersion: getAppVersion(), now,
    });
  };

  const wrongPlace = (pkgPlace, context) => {
    if (pkgPlace === placeOf(context)) return null;
    return pkgPlace === 'writing'
      ? { ok: false, reason: 'not_in_writing', message: t('这是创意写作的工作流，请到创意写作房间的跳房子里导入') }
      : { ok: false, reason: 'not_in_chat', message: t('这是聊天模式的工作流，请到聊天室的跳房子里导入') };
  };

  const planImportFromText = async (text) => {
    const parsed = parseAgentWorkflowPackage(text);
    if (!parsed.ok) return parsed;
    const context = getAgentContext();
    const blocked = wrongPlace(parsed.package.source.place, context);
    if (blocked) return blocked;
    let names = [];
    try { names = await listWorldbookNames(); } catch {}
    const worldbooks = new Set((Array.isArray(names) ? names : []).map(trim));
    const presets = resolvedPresets(context.sessionId, placeOf(context));
    return {
      ok: true,
      package: parsed.package,
      plan: planAgentWorkflowImport(parsed.package, {
        findPresetByName: (type, presetName) => findPresetIdByName({ presetStore, type, presetName }),
        hasWorldbook: name => worldbooks.has(trim(name)),
        currentSettings: appSettings.get(),
        currentCards: currentCards(),
        hasPromptEntry: (type, entry) => presetHasEntry(presets[type]?.preset, type, entry),
      }),
    };
  };

  // 按备份还原（导入失败的半途，或用户撤销）
  const restore = async (backup) => {
    if (!backup) return { ok: false, reason: 'no_backup' };
    const context = {
      ...getAgentContext(),
      place: backup.place === 'chat' ? 'chat' : 'writing',
      sessionId: backup.sessionId,
      ...(backup.scopeId !== undefined ? { scopeId: backup.scopeId } : {}),
    };
    const scope = configScopeOf(backup.target);
    const problems = [];
    for (const item of backup.agents || []) {
      const result = await agentConfigStore.restoreEntry({ id: item.id, context, scope, entry: item.entry ?? null });
      if (result?.ok === false) problems.push(item.id);
    }
    if (backup.board) {
      const result = backup.target === 'global'
        ? await boardStore.setGlobalBoard(backup.board.value || null)
        : await boardStore.setSessionOverride(backup.sessionId, backup.board.value || null, { followGlobal: backup.board.followGlobal === true });
      if (result?.ok === false) problems.push('board');
    }
    const promptKeys = Object.keys(backup.promptProfiles || {});
    const cardIds = Object.keys(backup.cards || {});
    if (promptKeys.length || cardIds.length) {
      const settings = clone(agentCenterSettings.getSettings());
      promptKeys.forEach((key) => {
        const profile = backup.promptProfiles[key];
        if (profile) settings.profiles[key] = profile;
        else delete settings.profiles[key];
      });
      if (promptKeys.length) {
        // 合并导入会记下导入时间，一并还原
        const migrations = { ...(settings.migrations || {}) };
        if (backup.agentCenterImportedAt) migrations.importedAgentCenterSettingsAt = backup.agentCenterImportedAt;
        else delete migrations.importedAgentCenterSettingsAt;
        settings.migrations = migrations;
      }
      cardIds.forEach((id) => {
        if (backup.cards[id]) settings.cards[id] = backup.cards[id];
        else delete settings.cards[id];
      });
      await agentCenterSettings.replace(settings);
    }
    if (backup.settings && Object.keys(backup.settings).length) {
      appSettings.update(clone(backup.settings));
      notifySettingsChanged(Object.keys(backup.settings));
    }
    return problems.length ? { ok: false, reason: 'restore_incomplete', items: problems } : { ok: true };
  };

  /**
   * 导入：创意写作 target 'global' 所有角色卡／'persona' 当前角色卡；聊天 'global' 聊天全局设置／'session' 当前聊天。
   * context 可指定别的聊天（体验包导入到新联系人）；recordUndo 为 false 时不写撤销槽（失败仍会还原）。
   * 返回 { ok, result } 或 { ok: false, reason, message }；失败时已按备份还原。
   */
  const applyImport = async (pkg, {
    target = 'persona', includeSettings = true, includePromptProfiles = true, context: contextOverride = null, recordUndo = true,
  } = {}) => {
    const context = contextOverride || getAgentContext();
    const blocked = wrongPlace(pkg?.source?.place === 'chat' ? 'chat' : 'writing', context);
    if (blocked) return blocked;
    const place = placeOf(context);
    const scope = configScopeOf(target);
    if ((place === 'writing' || scope === 'local') && !trim(context.sessionId)) {
      return { ok: false, reason: 'no_session', message: place === 'writing' ? t('请在创意写作房间里导入工作流') : t('请先打开要导入的聊天') };
    }
    const readScope = target === 'global' ? 'global' : 'effective';
    const sessionId = trim(context.sessionId);

    // 名额：修改文本与输入助手每类最多 8 个（导入的是新建）
    const existing = agentConfigStore.list(context, readScope) || [];
    const incoming = Object.keys(pkg.agents || {}).filter(isRenamedWorkflowAgentId);
    for (const [kind, re] of [['text_edit', /^text-edit:/], ['input_agent', /^input-agent:/]]) {
      const add = incoming.filter(id => re.test(id)).length;
      const have = existing.filter(item => item?.config?.kind === kind).length;
      if (add && have + add > MAX_CUSTOM_AGENTS_PER_KIND) {
        return { ok: false, reason: 'agent_limit', message: t('{kind} Agent 合计会超过 {max} 个（现有 {have} 个，要导入 {add} 个），请先删掉一些再导入', { kind: kind === 'text_edit' ? t('修改文本') : t('输入助手'), max: MAX_CUSTOM_AGENTS_PER_KIND, have, add }) };
      }
    }

    const backup = {
      version: 1, at: now(), name: pkg.name, place, target, sessionId, scopeId: trim(context.scopeId),
      board: place !== 'writing' ? null : target === 'global'
        ? { value: clone(boardStore.getGlobalBoard()) }
        : { value: clone(boardStore.getSessionOverride(sessionId)), followGlobal: getSessionSettings(sessionId)?.hopscotchBoardFollowGlobal === true },
      agents: [], promptProfiles: {}, agentCenterImportedAt: null, cards: {}, settings: {}, presetsCreated: [],
    };
    const report = { agentsCreated: [], agentsReplaced: [], presets: [], modelHints: pkg.modelHints || [] };
    const writeAgent = async (id, config) => {
      backup.agents.push({ id, entry: agentConfigStore.readEntry({ id, context, scope }) });
      const saved = await agentConfigStore.save({ id, context, scope, config });
      if (saved?.ok === false) throw Object.assign(new Error(saved.message || saved.reason || 'agent_save_failed'), { reason: saved.reason });
    };
    try {
      // 1. 预设：同名复用，否则新建（聊天用的预设不限定创意写作）
      const presetIdMap = {};
      const cache = new Map();
      for (const [sourceId, preset] of Object.entries(pkg.presets || {})) {
        const existingId = findPresetIdByName({ presetStore, type: 'openai', presetName: preset.name });
        const id = await resolveImportedPresetIdByName({
          presetStore, type: 'openai', presetPayload: { name: preset.name, data: preset.data }, cache,
          ...(place === 'chat' ? { upsertPayloadBuilder: buildRestoredPresetUpsertPayload } : {}),
        });
        if (id) {
          presetIdMap[sourceId] = id;
          report.presets.push({ name: preset.name, action: existingId ? 'reuse' : 'create' });
          if (!existingId) backup.presetsCreated.push(id);
        }
      }
      // 2. Agent：修改文本／输入助手换新 ID 新建；可配置 Agent 与正文范围规则写入目标范围
      const newAgentIds = {};
      Object.keys(pkg.agents || {}).filter(isRenamedWorkflowAgentId).forEach((id) => {
        newAgentIds[id] = createAgentId(/^input-agent:/.test(id) ? 'input_agent' : 'text_edit');
      });
      const writes = buildAgentWorkflowWrites(pkg, {
        presetIdMap, newAgentIds, includeSettings, includePromptProfiles,
        currentPromptPresetIds: resolvedPresetIds(sessionId, place),
      });
      for (const item of writes.agents) {
        await writeAgent(item.id, item.config);
        if (newAgentIds[item.sourceId]) report.agentsCreated.push(item.config.title || item.id);
        else report.agentsReplaced.push(item.config.title || item.id);
      }
      if (writes.bodyRule) await writeAgent(BODY_SELECTOR_ID, { target: writes.bodyRule });
      // 3. 板子（只有创意写作）
      if (place === 'writing') {
        const boardResult = target === 'global'
          ? await boardStore.setGlobalBoard(writes.board)
          : await boardStore.setPersonaBoard(writes.board, { sessionId });
        if (boardResult?.ok === false) throw Object.assign(new Error((boardResult.errors || []).map(item => item.message).join('；') || boardResult.reason), { reason: boardResult.reason });
      }
      // 4. 内置提示词档：套到这个会话当前所用的预设上
      const profiles = writes.promptProfiles || {};
      if (Object.keys(profiles).length) {
        const current = resolvedPresetIds(sessionId, place);
        const imported = { profiles: {} };
        const presetIdMapForProfiles = {};
        const sourcePresetIds = {};
        const settingsBefore = agentCenterSettings.getSettings();
        Object.entries(profiles).forEach(([type, profile]) => {
          if (!current[type]) return;
          const key = `${type}:${current[type]}`;
          backup.promptProfiles[key] = clone(settingsBefore.profiles?.[key] || null);
          const sourceId = trim(profile.presetId) || `imported-${type}`;
          imported.profiles[`${type}:${sourceId}`] = { ...profile, profileType: type, presetId: sourceId };
          presetIdMapForProfiles[type] = current[type];
          sourcePresetIds[type] = sourceId;
        });
        if (Object.keys(imported.profiles).length) {
          backup.agentCenterImportedAt = settingsBefore.migrations?.importedAgentCenterSettingsAt || null;
          await agentCenterSettings.mergeImported(imported, { presetIdMap: presetIdMapForProfiles, sourcePresetIds });
        }
      }
      // 5. 聊天的 AC 卡片开关（随相关设定）
      const cardIds = Object.keys(writes.cards || {});
      if (cardIds.length) {
        const settings = clone(agentCenterSettings.getSettings());
        cardIds.forEach((id) => {
          backup.cards[id] = clone(settings.cards?.[id] || null);
          settings.cards[id] = { enabled: writes.cards[id] === true, updatedAt: now() };
        });
        await agentCenterSettings.replace(settings);
      }
      // 6. 相关设定；创意写作另打开自定义编排（与面板保存一致）
      const patch = { ...writes.settingsPatch, ...(place === 'writing' ? { creativeHopscotchEnabled: true } : {}) };
      if (Object.keys(patch).length) {
        const settingsBefore = appSettings.get();
        Object.keys(patch).forEach((key) => { backup.settings[key] = clone(settingsBefore[key]); });
        appSettings.update(patch);
        notifySettingsChanged(Object.keys(patch));
      }

      if (recordUndo) {
        lastBackup = backup;
        try { await saveKv?.(AGENT_WORKFLOW_UNDO_KV, backup); } catch {}
      }
      return { ok: true, result: report };
    } catch (error) {
      await restore(backup);
      return { ok: false, reason: error?.reason || 'import_failed', message: trim(error?.message) || t('导入失败，已还原') };
    }
  };

  const getLastImport = async () => {
    if (lastBackup) return lastBackup;
    try {
      const stored = await loadKv?.(AGENT_WORKFLOW_UNDO_KV);
      lastBackup = stored && stored.version === 1 ? stored : null;
    } catch {}
    return lastBackup;
  };

  const undoLastImport = async () => {
    const backup = await getLastImport();
    if (!backup) return { ok: false, reason: 'no_backup', message: t('没有可撤销的导入') };
    const result = await restore(backup);
    if (result.ok) {
      lastBackup = null;
      try { await saveKv?.(AGENT_WORKFLOW_UNDO_KV, {}); } catch {}
    }
    return result;
  };

  // 体验包：只带这个联系人的 Agent 与用到的预设；导入到新联系人的当前聊天范围，不写撤销槽
  const exportContactAgents = context => exportWorkflow({ target: 'session', context, agentsOnly: true });
  const importContactAgents = async (raw, context) => {
    const parsed = parseAgentWorkflowPackage(raw);
    if (!parsed.ok) return parsed;
    return applyImport(parsed.package, { target: 'session', context, includeSettings: false, includePromptProfiles: false, recordUndo: false });
  };

  return { exportWorkflow, planImportFromText, applyImport, undoLastImport, getLastImport, exportContactAgents, importContactAgents };
};
