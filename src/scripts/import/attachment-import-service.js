// 女仆附件导入：世界书与正则。复用手动导入的转换、冲突计划和正则去重；
// 存储与绑定通过依赖注入，便于测试，也保证与界面入口写入同一份数据。
import { convertSTWorld } from '../storage/worldinfo.js';
import { buildWorldbookImportPlan, WORLDBOOK_IMPORT_DECISIONS } from '../ui/worldbook-import-conflict-utils.js';
import { flattenRegexImportRules, getRegexImportSetName, getRegexRuleSignature, parseRegexImportData } from '../utils/regex-transfer.js';
import { getWorldbookBoundRegexSets, importWorldbookBoundRegexSets } from './worldbook-bound-regex-import.js';

const trim = value => String(value ?? '').trim();
const fileBaseName = (name = '') => trim(name).replace(/\.[^.]+$/, '').trim();

const parseAttachmentJson = (entry) => {
  try {
    return { json: JSON.parse(new TextDecoder('utf-8').decode(entry.bytes).replace(/^﻿/, '')) };
  } catch {
    return { error: 'attachment_json_invalid' };
  }
};

// 编译校验：支持 /pattern/flags 与裸 pattern（与 regex.upsert_rules 一致）
const compileFindRegex = (source = '') => {
  const text = String(source ?? '');
  if (!text.trim()) return 'empty_regex';
  const match = text.match(/^\/([\s\S]*)\/([a-z]*)$/);
  try {
    // eslint-disable-next-line no-new
    new RegExp(match ? match[1] : text, match ? match[2] : '');
    return '';
  } catch {
    return 'invalid_regex';
  }
};

// 同名世界书新建副本时的名称：星港 (2)、星港 (3)…
export const nextAvailableWorldbookName = (name, existingNames = []) => {
  const taken = new Set((existingNames || []).map(trim));
  if (!taken.has(name)) return name;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${name} (${index})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
};

export const createAttachmentImportService = ({
  getAttachment,
  worldbooks,
  bindWorldbook,
  regex,
  onWorldbookImported = null,
  onRegexChanged = null,
} = {}) => {
  const readAttachment = (attachmentId, format) => {
    const entry = getAttachment?.(attachmentId);
    if (!entry) return { error: 'attachment_not_found' };
    if (entry.inspection?.format !== format) return { error: 'attachment_format_mismatch', format: entry.inspection?.format || '' };
    const parsed = parseAttachmentJson(entry);
    return parsed.error ? { error: parsed.error } : { entry, json: parsed.json };
  };

  // 计划：只读，不写入。conflict 为 copy（新建副本）、overwrite（覆盖，需确认）或空（有冲突时返回冲突信息）
  const planWorldbookImport = async ({ attachmentId, name = '', conflict = '' } = {}) => {
    const read = readAttachment(attachmentId, 'worldbook');
    if (read.error) return { ok: false, reason: read.error, format: read.format };
    const baseName = trim(name) || trim(read.json?.name) || trim(read.json?.title) || fileBaseName(read.entry.name) || 'imported';
    const worldId = conflict === 'copy'
      ? nextAvailableWorldbookName(baseName, await worldbooks.listIds())
      : baseName;
    const incomingWorld = convertSTWorld(read.json, worldId);
    const plan = buildWorldbookImportPlan({ worldId, incomingWorld, snapshot: await worldbooks.getSnapshot(worldId) });
    const boundSets = getWorldbookBoundRegexSets(read.json);
    return {
      ok: true,
      attachmentId: trim(attachmentId),
      hash: read.entry.hash,
      worldId: plan.targetId,
      entryCount: Array.isArray(incomingWorld.entries) ? incomingWorld.entries.length : 0,
      boundRegexSets: Array.isArray(boundSets) ? boundSets : [],
      conflict: plan.conflict ? {
        existingCount: Array.isArray(plan.conflict.base?.entries) ? plan.conflict.base.entries.length : 0,
        incomingCount: Array.isArray(plan.conflict.incoming?.entries) ? plan.conflict.incoming.entries.length : 0,
      } : null,
      overwrite: Boolean(plan.conflict) && conflict === WORLDBOOK_IMPORT_DECISIONS.overwrite,
      importPlan: plan,
    };
  };

  // target：{ type: 'global' } | { type: 'chat_room', sessionId } | { type: 'role_card', roleCardId } | { type: 'none' }
  const commitWorldbookImport = async (plan, { target = { type: 'none' }, includeBoundRegex = true } = {}) => {
    if (plan.conflict && !plan.overwrite) return { ok: false, reason: 'worldbook_name_conflict', worldId: plan.worldId, conflict: plan.conflict };
    await worldbooks.save(plan.importPlan.targetId, plan.importPlan.incomingWorld, plan.importPlan.saveOptions);
    const result = { ok: true, worldId: plan.worldId, entryCount: plan.entryCount, overwritten: plan.overwrite, binding: null, regex: null };
    const type = trim(target?.type) || 'none';
    // 世界书已写入后，绑定或附带正则失败要如实返回部分结果
    try {
      if (type === 'global') await bindWorldbook.global(plan.worldId);
      else if (type === 'chat_room') await bindWorldbook.chatRoom(target.sessionId, plan.worldId);
      else if (type === 'role_card') await bindWorldbook.roleCard(target.roleCardId, plan.worldId);
      result.binding = { type, ...(target.sessionId ? { sessionId: target.sessionId } : {}), ...(target.roleCardId ? { roleCardId: target.roleCardId } : {}), status: 'succeeded' };
    } catch (error) {
      result.ok = false;
      result.partial = true;
      result.binding = { type, status: 'failed', errorMessage: trim(error?.message).slice(0, 160) };
    }
    if (includeBoundRegex && plan.boundRegexSets.length) {
      try {
        await regex.ready();
        const imported = await importWorldbookBoundRegexSets({
          worldId: plan.worldId,
          boundSets: plan.boundRegexSets,
          existingSets: regex.listLocalSets(),
          upsertLocalSet: set => regex.upsertLocalSet(set),
        });
        result.regex = { status: 'succeeded', ...imported };
        if (imported.importedRuleCount) onRegexChanged?.();
      } catch (error) {
        result.ok = false;
        result.partial = true;
        result.regex = { status: 'failed', errorMessage: trim(error?.message).slice(0, 160) };
      }
    }
    onWorldbookImported?.(plan.worldId);
    return result;
  };

  // target：{ type: 'global' } | { type: 'chat_room', sessionId } | { type: 'worldbook', worldId }
  const planRegexImport = async ({ attachmentId, target = {} } = {}) => {
    const read = readAttachment(attachmentId, 'regex');
    if (read.error) return { ok: false, reason: read.error, format: read.format };
    await regex.ready();
    const parsed = parseRegexImportData(read.json);
    const rules = flattenRegexImportRules(parsed);
    const type = trim(target?.type);
    if (!['global', 'chat_room', 'worldbook'].includes(type)) return { ok: false, reason: 'regex_target_unsupported', target: type };
    if (type === 'chat_room' && !trim(target.sessionId)) return { ok: false, reason: 'missing_session' };
    if (type === 'worldbook' && !trim(target.worldId)) return { ok: false, reason: 'missing_worldbook' };
    const existing = type === 'global' ? (regex.getGlobal()?.rules || [])
      : type === 'chat_room' ? (regex.getSession(target.sessionId)?.rules || [])
        : regex.listLocalSets().filter(set => set?.bind?.type === 'world' && trim(set.bind.worldId) === trim(target.worldId)).flatMap(set => set.rules || []);
    const existingSigs = new Set(existing.map(getRegexRuleSignature));
    const items = rules.map((rule, index) => {
      const label = trim(rule.scriptName) || `规则 ${index + 1}`;
      const invalid = compileFindRegex(rule.findRegex);
      if (invalid) return { index, label, status: 'failed', reason: invalid };
      if (existingSigs.has(getRegexRuleSignature(rule))) return { index, label, status: 'skipped', reason: 'duplicate_rule' };
      return { index, label, status: 'planned', rule };
    });
    return {
      ok: true,
      attachmentId: trim(attachmentId),
      hash: read.entry.hash,
      target: { type, ...(target.sessionId ? { sessionId: trim(target.sessionId) } : {}), ...(target.worldId ? { worldId: trim(target.worldId) } : {}) },
      sourceName: trim(parsed.name),
      fileName: fileBaseName(read.entry.name),
      items,
      plannedCount: items.filter(item => item.status === 'planned').length,
    };
  };

  const commitRegexImport = async (plan) => {
    const planned = plan.items.filter(item => item.status === 'planned');
    const results = plan.items.filter(item => item.status !== 'planned').map(({ rule, ...item }) => item);
    if (!planned.length) return { ok: results.some(item => item.status === 'skipped'), results, importedCount: 0 };
    const rules = planned.map(item => item.rule);
    const { type, sessionId, worldId } = plan.target;
    let setId = '';
    if (type === 'global') {
      const current = regex.getGlobal() || {};
      await regex.setGlobal({ ...current, rules: [...(current.rules || []), ...rules] });
    } else if (type === 'chat_room') {
      const current = regex.getSession(sessionId) || { enabled: true };
      await regex.setSession(sessionId, { ...current, rules: [...(current.rules || []), ...rules] });
    } else {
      // 集合名按实际写入的规则生成（与手动导入同一命名规则）
      const setName = getRegexImportSetName(plan.sourceName, rules, plan.fileName || '导入正则');
      setId = await regex.upsertLocalSet({ name: `${setName} (${worldId})`, enabled: true, bind: { type: 'world', worldId }, rules });
    }
    onRegexChanged?.();
    planned.forEach(item => results.push({ index: item.index, label: item.label, status: 'succeeded' }));
    results.sort((a, b) => a.index - b.index);
    return { ok: true, importedCount: planned.length, results, target: plan.target, ...(setId ? { setId } : {}) };
  };

  return { planWorldbookImport, commitWorldbookImport, planRegexImport, commitRegexImport };
};
