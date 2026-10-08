// 女仆附件工具：读取本地解析结果；把世界书／正则／脚本附件导入到指定目标，角色卡调起现有导卡流程。
// 文件原文只从附件缓存读取，模型只传附件 ID 和目标，不改写文件内容。
import { t } from '../../i18n/index.js';
import { extractScriptTree } from '../../import/script-tree-utils.js';
import { CARD_ASSET_SKIP_LABELS } from '../../utils/character-card-assets.js';
import { resolveWorldbookCurrentPersona } from '../worldbook-resource-ownership.js';

const trim = value => String(value ?? '').trim();
const key = value => trim(value).toLowerCase().replace(/\s+/g, '');
const CURRENT_WORDS = new Set(['current', '当前', '这个', '这张', '本卡', '当前角色卡', '当前聊天室', '这个聊天室']);
const isCurrent = value => !trim(value) || CURRENT_WORDS.has(trim(value).toLowerCase());
const SUPPORTED_TARGETS = Object.freeze({
  worldbook: ['global', 'role_card', 'chat_room', 'none'],
  regex: ['global', 'chat_room', 'worldbook', 'role_card_worldbook'],
  character_card: ['new_role_card'],
  script: ['global', 'role_card', 'preset'],
  preset: ['preset_library'],
});
const EXCLUDABLE_PARTS = Object.freeze(['worldbook', 'greetings', 'regex', 'scripts', 'system_prompt', 'mvu', 'expressions', 'background']);
const SCRIPT_SCOPES = Object.freeze({ global: 'global', role_card: 'character', preset: 'preset' });
const PREVIEW_LIMIT = 20;

const failure = (reason, extra = {}) => ({ ok: false, reason, ...extra });

const listItems = store => (typeof store?.getAll === 'function' ? store.getAll()
  : typeof store?.listContacts === 'function' ? store.listContacts() : []).filter(Boolean);

// 按 id 精确命中，否则按名称；重名给候选，不猜
const resolveByIdOrName = (store, query, { getById } = {}) => {
  const direct = getById?.(query);
  if (direct) return { item: direct };
  const matches = listItems(store).filter(item => key(item?.name) === key(query) || trim(item?.id) === trim(query));
  if (matches.length === 1) return { item: matches[0] };
  if (matches.length > 1) return { error: 'ambiguous', candidates: matches.slice(0, 8).map(item => ({ id: trim(item.id), name: trim(item.name) })) };
  return { error: 'not_found' };
};

const previewAttachment = (entry) => {
  const base = {
    attachmentId: entry.id, name: entry.name, format: entry.inspection?.format || '',
    label: entry.inspection?.label || '', title: entry.inspection?.title || '',
    counts: entry.inspection?.counts || {}, targets: entry.inspection?.targets || [],
    diagnostics: entry.inspection?.diagnostics || [], candidates: entry.inspection?.candidates || [],
    imported: (entry.imports || []).map(item => ({ target: item.target, worldbookId: item.worldbookId || '' })),
  };
  try {
    const json = JSON.parse(new TextDecoder('utf-8').decode(entry.bytes).replace(/^﻿/, ''));
    if (base.format === 'worldbook') {
      const entries = Array.isArray(json.entries) ? json.entries : Object.values(json.entries || {});
      base.entryTitles = entries.slice(0, PREVIEW_LIMIT).map(item => trim(item?.comment) || (Array.isArray(item?.key) ? item.key.join('、') : trim(item?.key)) || '').filter(Boolean);
    } else if (base.format === 'regex') {
      const rules = Array.isArray(json) ? json : (json.rules || json.regex_scripts || []);
      base.ruleNames = (Array.isArray(rules) ? rules : []).slice(0, PREVIEW_LIMIT).map(item => trim(item?.scriptName || item?.name)).filter(Boolean);
    }
  } catch {}
  return base;
};

export const createAttachmentImportAgentTools = ({
  getAttachmentRegistry = () => null,
  getImportService = () => null,
  personaStore = null,
  chatStore = null,
  contactsStore = null,
  readWorldbookSnapshot = null,
  planCharacterCardFile = null,
  commitCharacterCardPlan = null,
  scriptStore = null,
  presetStore = null,
  getScriptSettings = () => ({}),
  importPresetJson = null,
  inspectPresetBindings = () => ({ regexSetCount: 0, scriptCount: 0 }),
} = {}) => {
  const snapshots = new WeakMap();
  const completed = new Map(); // 文件哈希 + 目标 → 结果：同一文件同一目标不重复导入

  const resolveRoleCard = (query, entry, context) => {
    if (isCurrent(query)) {
      const sessionId = trim(entry.submittedContext?.sessionId || context.sessionId);
      const roleCardId = trim(entry.submittedContext?.roleCardId || context.roleCardId);
      const persona = (roleCardId && personaStore?.get?.(roleCardId))
        || resolveWorldbookCurrentPersona({ personaStore, chatStore, sessionId });
      return persona ? { item: persona } : { error: 'role_card_not_found' };
    }
    const found = resolveByIdOrName(personaStore, query, { getById: id => personaStore?.get?.(id) });
    return found.error ? { error: found.error === 'ambiguous' ? 'ambiguous_role_card' : 'role_card_not_found', candidates: found.candidates } : found;
  };

  const resolveChatRoom = async (query, entry, context) => {
    if (isCurrent(query)) {
      const sessionId = trim(entry.submittedContext?.sessionId || context.sessionId);
      return sessionId ? { sessionId, name: sessionId } : { error: 'no_current_chat_room' };
    }
    const found = resolveByIdOrName(contactsStore, query, { getById: id => contactsStore?.getContact?.(id) });
    if (found.item) return { sessionId: trim(found.item.id), name: trim(found.item.name || found.item.id) };
    if (found.error === 'ambiguous') return { error: 'ambiguous_chat_room', candidates: found.candidates };
    const sessions = typeof chatStore?.listSessions === 'function' ? await chatStore.listSessions() : [];
    const sessionId = (Array.isArray(sessions) ? sessions : []).map(trim).find(id => id === trim(query));
    return sessionId ? { sessionId, name: sessionId } : { error: 'chat_room_not_found' };
  };

  // 脚本预设作用域：按 id 或名称找 openai 预设；current 取本会话实际使用的预设
  const resolvePreset = (query, entry, context) => {
    const presets = Object.entries(presetStore?.state?.presets?.openai || {}).map(([id, preset]) => ({ id, name: trim(preset?.name) || id }));
    if (isCurrent(query)) {
      const sessionId = trim(entry.submittedContext?.sessionId || context.sessionId);
      const uiMode = sessionId.startsWith('rp:') ? 'rp' : 'chat';
      const id = trim(presetStore?.getResolvedActive?.('openai', { sessionId, uiMode })?.presetId || presetStore?.getActiveId?.('openai'));
      const preset = presets.find(item => item.id === id);
      return preset ? { item: preset } : { error: 'preset_not_found' };
    }
    const found = resolveByIdOrName({ getAll: () => presets }, query);
    return found.error ? { error: found.error === 'ambiguous' ? 'ambiguous_preset' : 'preset_not_found', candidates: found.candidates } : found;
  };

  // 预检：解析附件与目标、生成只读计划；有覆盖或正则写入时需要确认
  const capture = async (args = {}, context = {}) => {
    const service = getImportService();
    const registry = getAttachmentRegistry();
    if (!registry) return { error: failure('attachment_import_unavailable') };
    const entry = registry.get(args.attachmentId);
    if (!entry) return { error: failure('attachment_not_found', { message: '附件已失效（可能 APP 重启或超出缓存），请让用户重新上传。' }) };
    const format = entry.inspection?.format || '';
    if (!SUPPORTED_TARGETS[format]) {
      return { error: failure('format_not_supported_yet', { format, message: '这类文件（如预设）暂不支持由女仆导入，请用户在对应管理面板手动导入。' }) };
    }
    const targetType = trim(args.target);
    if (!SUPPORTED_TARGETS[format].includes(targetType)) {
      return { error: failure('target_not_supported_for_format', { format, target: targetType, supportedTargets: SUPPORTED_TARGETS[format] }) };
    }
    const target = { type: targetType };
    let targetLabel = '';
    if (targetType === 'role_card' || targetType === 'role_card_worldbook') {
      const card = resolveRoleCard(args.roleCard, entry, context);
      if (card.error) return { error: failure(card.error, { roleCard: trim(args.roleCard), candidates: card.candidates }) };
      target.roleCardId = trim(card.item.id);
      targetLabel = trim(card.item.name || card.item.id);
      // 每张卡只绑一本角色世界书：已有其他书时导入会替换绑定（原书保留），需要确认
      target.previousWorldbookId = targetType === 'role_card' && format === 'worldbook' ? trim(card.item.source?.worldbookId) : '';
      if (targetType === 'role_card_worldbook') {
        const worldId = trim(card.item.source?.worldbookId);
        if (!worldId) return { error: failure('role_card_has_no_worldbook', { roleCardId: target.roleCardId, roleCardName: targetLabel }) };
        target.type = 'worldbook';
        target.worldId = worldId;
      }
    } else if (targetType === 'chat_room') {
      const room = await resolveChatRoom(args.chatRoom, entry, context);
      if (room.error) return { error: failure(room.error, { chatRoom: trim(args.chatRoom), candidates: room.candidates }) };
      target.sessionId = room.sessionId;
      targetLabel = room.name;
    } else if (targetType === 'worldbook') {
      const worldId = trim(args.worldbook);
      if (!worldId) return { error: failure('missing_worldbook') };
      const snapshot = await readWorldbookSnapshot?.(worldId);
      if (!snapshot?.exists) return { error: failure('worldbook_not_found', { worldbook: worldId }) };
      target.worldId = worldId;
      targetLabel = worldId;
    } else if (targetType === 'preset') {
      const preset = resolvePreset(args.preset, entry, context);
      if (preset.error) return { error: failure(preset.error, { preset: trim(args.preset), candidates: preset.candidates }) };
      target.presetId = preset.item.id;
      targetLabel = preset.item.name;
    }
    const targetKey = [target.type, target.roleCardId, target.sessionId, target.worldId, target.presetId].filter(Boolean).join(':');
    let plan;
    if (format === 'worldbook' || format === 'regex') {
      if (!service) return { error: failure('attachment_import_unavailable') };
      plan = format === 'worldbook'
        ? await service.planWorldbookImport({ attachmentId: entry.id, name: args.name, conflict: trim(args.onNameConflict) })
        : await service.planRegexImport({ attachmentId: entry.id, target });
    } else if (format === 'script') {
      let scripts = [];
      const text = new TextDecoder('utf-8').decode(entry.bytes).replace(/^\uFEFF/, '');
      if (entry.inspection?.details?.source === 'js') {
        scripts = text.trim() ? [{ type: 'script', name: entry.inspection.title || entry.name, content: text }] : [];
      } else {
        try {
          scripts = extractScriptTree(JSON.parse(text));
        } catch {}
      }
      plan = scripts.length && scriptStore ? { ok: true, scripts } : { ok: false, reason: scriptStore ? 'no_scripts_in_file' : 'attachment_import_unavailable' };
    } else if (format === 'preset') {
      if (entry.inspection?.details?.presetType === 'store') return { error: failure('preset_bundle_requires_panel', { message: '整套预设设定档需要用户在预设面板选择覆盖或合并后导入。' }) };
      let json = null;
      try {
        json = JSON.parse(new TextDecoder('utf-8').decode(entry.bytes).replace(/^\uFEFF/, ''));
      } catch {}
      const exclude = new Set(Array.isArray(args.exclude) ? args.exclude : []);
      const bindings = json ? inspectPresetBindings(json) : {};
      plan = json && typeof importPresetJson === 'function'
        ? { ok: true, json, includeRegex: !exclude.has('regex'), includeScripts: !exclude.has('scripts'),
          regexSetCount: Number(bindings?.regexSetCount || 0), scriptCount: Number(bindings?.scriptCount || 0) }
        : { ok: false, reason: json ? 'attachment_import_unavailable' : 'attachment_json_invalid' };
    } else {
      // 角色卡：本地解析出计划（各部分数量、是否重名），默认全导、说了才排除，默认不切换
      if (typeof planCharacterCardFile !== 'function' || typeof commitCharacterCardPlan !== 'function') return { error: failure('attachment_import_unavailable') };
      let card;
      try {
        card = await planCharacterCardFile({ bytes: entry.bytes, name: entry.name, mime: entry.mime });
      } catch (error) {
        return { error: failure('character_card_parse_failed', { errorMessage: trim(error?.message).slice(0, 160) }) };
      }
      if (!card?.ok) return { error: failure(card?.reason || 'character_card_parse_failed') };
      if (card.nameConflict && trim(args.onNameConflict) !== 'copy') {
        return { error: failure('role_card_name_conflict', { roleCardName: card.displayName, message: '已有同名角色卡；问用户是否仍要新建一张同名卡（不会覆盖原卡），同意后带 onNameConflict: copy 重试。' }) };
      }
      const exclude = new Set(Array.isArray(args.exclude) ? args.exclude : []);
      const include = Object.fromEntries(EXCLUDABLE_PARTS.map(part => [part, !exclude.has(part)]));
      plan = { ok: true, card, include, activate: args.switchTo === true };
    }
    if (!plan.ok) return { error: failure(plan.reason, { format }) };
    return { entry, format, target, targetLabel, targetKey, plan, doneKey: `${entry.hash}|${format}|${targetKey}` };
  };

  const confirmationFor = (snap) => {
    if (snap.format === 'script') return null;
    if (snap.format === 'character_card') {
      // 只有写入卡内正则时确认（与其他正则写入一致），确认里列出本次会导入的全部内容
      const { card, include, activate } = snap.plan;
      if (!include.regex || !card.counts.regexRules) return null;
      const items = [
        include.worldbook ? { id: 'worldbook', label: t('世界书 {count} 条', { count: card.counts.worldEntries }) } : null,
        include.greetings && card.counts.greetings ? { id: 'greetings', label: t('开场白 {count} 个', { count: card.counts.greetings }) } : null,
        { id: 'regex', label: t('正则 {count} 条', { count: card.counts.regexRules }), meta: t('会改变聊天内容的显示或发送给模型的文本') },
        include.scripts && card.counts.scripts ? { id: 'scripts', label: t('脚本 {count} 个', { count: card.counts.scripts }), meta: t('导入后保持关闭，需要时再单独启用') } : null,
        include.system_prompt && card.hasSystemPrompt ? { id: 'system_prompt', label: t('系统提示词（另存为预设，不启用）') } : null,
        include.expressions && card.counts.expressions ? { id: 'expressions', label: t('表情 {count} 张（作为该角色的表情贴图包）', { count: card.counts.expressions }) } : null,
        include.background && card.counts.backgrounds ? { id: 'background', label: t('背景 1 张（设为该角色创意写作的聊天背景）') } : null,
        activate ? { id: 'activate', label: t('导入后切换到新角色卡') } : null,
      ].filter(Boolean);
      return {
        destructive: true, kind: 'attachment.import', operationType: 'import_character_card_file', danger: false,
        title: t('导入角色卡「{name}」', { name: card.displayName }),
        message: t('将从附件导入角色卡「{name}」，包含以下内容。', { name: card.displayName }),
        confirmText: t('导入'), cancelText: t('取消'), allowAlways: false,
        details: { items },
        onDeny: { action: 'skip', reason: 'attachment_import_cancelled', result: { ok: false, skipped: true, reason: 'attachment_import_cancelled' } },
      };
    }
    if (snap.format === 'preset') {
      // 与手动导入一样会切换为当前预设；只有写入附带正则时需要确认
      if (!snap.plan.includeRegex || !snap.plan.regexSetCount) return null;
      return {
        destructive: true, kind: 'attachment.import', operationType: 'import_preset_file', danger: false,
        title: t('导入预设「{name}」', { name: snap.entry.inspection?.title || snap.entry.name }),
        message: t('将导入预设并切换为当前创意写作预设，同时导入附带的正则。'),
        confirmText: t('导入'), cancelText: t('取消'), allowAlways: false,
        details: { items: [
          { id: 'regex', label: t('附带正则 {count} 组', { count: snap.plan.regexSetCount }), meta: t('绑定到该预设，会改变聊天内容的显示或发送给模型的文本') },
          ...(snap.plan.includeScripts && snap.plan.scriptCount ? [{ id: 'scripts', label: t('附带脚本 {count} 个', { count: snap.plan.scriptCount }), meta: t('导入后保持关闭，需要时再单独启用') }] : []),
        ] },
        onDeny: { action: 'skip', reason: 'attachment_import_cancelled', result: { ok: false, skipped: true, reason: 'attachment_import_cancelled' } },
      };
    }
    if (snap.format === 'worldbook') {
      const items = [];
      if (snap.plan.overwrite) items.push({ id: 'overwrite', label: t('覆盖同名世界书「{name}」', { name: snap.plan.worldId }), meta: t('现有 {before} 条 → 导入 {after} 条', { before: snap.plan.conflict.existingCount, after: snap.plan.conflict.incomingCount }) });
      if (snap.target.previousWorldbookId && snap.target.previousWorldbookId !== snap.plan.worldId) {
        items.push({ id: 'replace_binding', label: t('更换角色卡「{persona}」绑定的世界书', { persona: snap.targetLabel }), meta: t('「{previous}」→「{next}」，原世界书仍会保留', { previous: snap.target.previousWorldbookId, next: snap.plan.worldId }) });
      }
      if (snap.plan.boundRegexSets.length) items.push({ id: 'regex', label: t('附带正则 {count} 组', { count: snap.plan.boundRegexSets.length }), meta: t('导入后绑定到该世界书，会改变聊天内容的显示或发送给模型的文本') });
      if (!items.length) return null;
      return {
        destructive: true, kind: 'attachment.import', operationType: 'import_worldbook_file', danger: items.some(item => item.id !== 'regex'),
        title: t('导入世界书「{name}」', { name: snap.plan.worldId }),
        message: t('将从附件导入世界书「{name}」（{count} 条），请确认以下内容。', { name: snap.plan.worldId, count: snap.plan.entryCount }),
        confirmText: t('导入'), cancelText: t('取消'), allowAlways: false,
        details: { items },
        onDeny: { action: 'skip', reason: 'attachment_import_cancelled', result: { ok: false, skipped: true, reason: 'attachment_import_cancelled' } },
      };
    }
    if (!snap.plan.plannedCount) return null;
    return {
      destructive: true, kind: 'attachment.import', operationType: 'import_regex_file', danger: false,
      title: t('导入正则规则'),
      message: t('将从附件向「{target}」导入 {count} 条正则规则，它们会改变聊天内容的显示或发送给模型的文本。', { target: snap.targetLabel || t('全局'), count: snap.plan.plannedCount }),
      confirmText: t('导入'), cancelText: t('取消'), allowAlways: false,
      details: { items: snap.plan.items.slice(0, 100).map(item => ({ id: `rule_${item.index}`, label: item.label, status: item.status, reason: item.reason || '' })) },
      onDeny: { action: 'skip', reason: 'attachment_import_cancelled', result: { ok: false, skipped: true, reason: 'attachment_import_cancelled' } },
    };
  };

  const inspectTool = {
    name: 'attachment.inspect',
    title: 'Inspect file attachments',
    description: 'Read the local parse result of files the user attached to the Maid (worldbook, regex, character card, script JSON or character card PNG): format, name, counts, possible import targets, diagnostics, and a short list of entry titles / rule names. Without attachmentId it lists recently uploaded files that are not imported yet. File contents are never returned.',
    source: 'maid-app-content', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'summary', confirmation: 'none' },
    schema: {
      type: 'object', additionalProperties: false,
      properties: { attachmentId: { type: 'string', maxLength: 120 } },
    },
    execute: async (args = {}) => {
      const registry = getAttachmentRegistry();
      if (!registry) return failure('attachment_import_unavailable');
      const id = trim(args.attachmentId);
      if (id) {
        const entry = registry.get(id);
        return entry ? { ok: true, attachments: [previewAttachment(entry)] } : failure('attachment_not_found');
      }
      const recent = registry.listRecent().map(item => previewAttachment(registry.get(item.id)));
      return { ok: true, attachments: recent };
    },
    summarizeResult: result => (result?.ok ? `attachments inspected: ${(result.attachments || []).length}` : `attachment inspect failed: ${trim(result?.reason)}`),
  };

  const importTool = {
    name: 'attachment.import',
    title: 'Import an attached file',
    description: 'Import a file the user attached to the Maid, by attachmentId. Worldbook targets: global, role_card (roleCard id/name, "current" = the card when the file was sent), chat_room (contact name/id or "current"), none (store only). Regex targets: global, chat_room, worldbook (existing worldbook id), role_card_worldbook (the worldbook bound to roleCard). Character card: target new_role_card creates a new card with everything in the file (worldbook, greetings, regex, scripts kept disabled, system prompt as an inactive preset, MVU variables) unless excluded; it does not switch cards unless switchTo is true. A same-name card fails with role_card_name_conflict; ask, then retry with onNameConflict "copy". A failed import is fully rolled back. Script JSON targets: global, role_card, preset (preset id/name or "current"); scripts are imported disabled. Preset JSON: target preset_library imports it and switches to it as the current creative-writing preset, like the manual import. Bundled regex/scripts/worldbook/greetings/system prompt are imported unless the user excluded them (exclude). If a worldbook with the same name exists the call fails with worldbook_name_conflict; ask the user, then retry with onNameConflict "copy" (new copy) or "overwrite" (app confirmation).',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_edit', modelContext: 'none', confirmation: 'conditional' },
    schema: {
      type: 'object', required: ['attachmentId', 'target'], additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', minLength: 1, maxLength: 120 },
        target: { type: 'string', enum: ['global', 'role_card', 'chat_room', 'none', 'worldbook', 'role_card_worldbook', 'new_role_card', 'preset', 'preset_library'] },
        exclude: { type: 'array', maxItems: 8, items: { type: 'string', enum: EXCLUDABLE_PARTS } },
        switchTo: { type: 'boolean' },
        preset: { type: 'string', maxLength: 200 },
        roleCard: { type: 'string', maxLength: 200 },
        chatRoom: { type: 'string', maxLength: 200 },
        worldbook: { type: 'string', maxLength: 200 },
        onNameConflict: { type: 'string', enum: ['copy', 'overwrite'] },
        name: { type: 'string', maxLength: 120 },
      },
    },
    safety: {
      operationType: 'import_attachment_file', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await capture(args, context);
        snapshots.set(args, snap);
        if (snap.error || completed.has(snap.doneKey)) return { destructive: false };
        return confirmationFor(snap) || { destructive: false };
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await capture(args, context);
      if (snap.error) return snap.error;
      if (completed.has(snap.doneKey)) return { ...completed.get(snap.doneKey), alreadyImported: true };
      const needsConfirmation = Boolean(confirmationFor(snap));
      if (needsConfirmation && !(context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === 'attachment.import')) {
        return failure('confirmation_required');
      }
      const service = getImportService();
      let result;
      if (snap.format === 'worldbook') {
        const committed = await service.commitWorldbookImport(snap.plan, { target: snap.target });
        if (committed.reason === 'worldbook_name_conflict') return failure('worldbook_name_conflict', { worldbookId: committed.worldId, conflict: committed.conflict });
        const readBack = await readWorldbookSnapshot?.(committed.worldId);
        result = {
          ...committed, format: 'worldbook', worldbookId: committed.worldId,
          target: snap.target.type, targetName: snap.targetLabel,
          verified: Boolean(readBack?.exists) && (readBack?.data?.entries || []).length === committed.entryCount,
        };
      } else if (snap.format === 'regex') {
        const committed = await service.commitRegexImport(snap.plan);
        result = { ...committed, format: 'regex', targetName: snap.targetLabel };
      } else if (snap.format === 'script') {
        // 导入后一律保持关闭且未授权；启用由 script.toggle_many 的 APP 确认完成
        const scope = SCRIPT_SCOPES[snap.target.type];
        const scopeId = scope === 'character' ? snap.target.roleCardId : scope === 'preset' ? snap.target.presetId : '';
        const imported = await scriptStore.importTavernHelperScripts({ scripts: snap.plan.scripts, scope, scopeId, source: 'maid-attachment' });
        result = {
          ok: Number(imported?.count || 0) > 0, format: 'script', scope, scopeId, targetName: snap.targetLabel || t('全局'),
          importedCount: Number(imported?.count || 0), scriptIds: imported?.ids || [],
          runnableCount: Number(imported?.compatibility?.runnableCount || 0),
          blocked: imported?.compatibility?.blocked || [],
          enabled: false, scriptsRunGlobally: getScriptSettings()?.scriptEnabled === true,
          notice: '脚本已导入但保持关闭；用户要启用时用 script.toggle_many，由 APP 确认。被兼容性检查拦下的脚本无法启用。',
        };
      } else if (snap.format === 'preset') {
        const outcome = await importPresetJson({
          json: snap.plan.json, fileName: snap.entry.name,
          decisions: { includeRegex: snap.plan.includeRegex, includeScripts: snap.plan.includeScripts },
        });
        if (!outcome?.ok) return failure(outcome?.reason || 'preset_import_failed', { format: 'preset' });
        result = {
          ok: true, format: 'preset', presetId: outcome.presetId, presetType: outcome.presetType, presetName: outcome.name,
          switchedToPreset: true, regex: outcome.regex, scripts: outcome.scripts,
          notice: '预设已导入并切换为当前创意写作预设；附带脚本保持关闭，启用用 script.toggle_many。',
        };
      } else {
        const { card, include, activate } = snap.plan;
        const committed = await commitCharacterCardPlan(card, { include, activate });
        if (!committed?.ok) {
          return failure(committed?.reason || 'character_card_import_failed', {
            format: 'character_card', step: committed?.step || '', errorMessage: committed?.errorMessage || '',
            rolledBack: committed?.rolledBack === true, message: '导入失败，本次创建的内容已全部撤销。',
          });
        }
        result = {
          ok: true, format: 'character_card', roleCardId: committed.personaId, roleCardName: committed.displayName,
          switchedToNewCard: committed.activated === true, worldbookId: committed.worldbookId,
          imported: {
            worldbookEntries: committed.worldEntryCount, greetings: committed.greetingCount, regexRules: committed.regexRuleCount,
            scripts: Number(committed.scripts?.count || 0), systemPrompt: Boolean(committed.systemPresetId), mvuVariables: committed.mvuConverted ? committed.mvuVariableCount : 0,
            expressions: committed.expressionCount || 0, background: committed.backgroundSet === true,
          },
          excluded: Object.entries(include).filter(([, on]) => !on).map(([part]) => part),
          ...(card.v3 && (card.v3.groupOnlyGreetings || card.v3.droppedAssets) ? {
            notImported: { groupOnlyGreetings: card.v3.groupOnlyGreetings, assets: card.v3.droppedAssets, skippedAssets: (card.v3.skippedAssets || []).slice(0, 20) },
          } : {}),
          scriptsEnabled: false,
          notice: [
            committed.activated
              ? '已导入并切换到新角色卡；卡内脚本保持关闭，启用用 script.toggle_many。'
              : '已导入为新角色卡，没有切换当前角色卡；用户想用时再切换。卡内脚本保持关闭，启用用 script.toggle_many。',
            // CCv3 暂不支持的部分必须在回复里告诉用户，不能只说「导入成功」
            card.v3 && (card.v3.groupOnlyGreetings || card.v3.droppedAssets)
              ? `回复中必须告诉用户以下 CCv3 内容未导入：${[
                card.v3.groupOnlyGreetings ? `群聊专用开场白 ${card.v3.groupOnlyGreetings} 个` : '',
                card.v3.droppedAssets ? `其他资源 ${card.v3.droppedAssets} 个（${[...new Set((card.v3.skippedAssets || []).map(item => CARD_ASSET_SKIP_LABELS[item.reason] || item.reason))].join('、')}）` : '',
              ].filter(Boolean).join('、')}；原始卡片数据已完整保存。`
              : '',
          ].filter(Boolean).join(''),
        };
      }
      if (result.ok || result.partial) {
        completed.set(snap.doneKey, result);
        getAttachmentRegistry()?.recordImport(snap.entry.id, { target: snap.targetKey, worldbookId: result.worldbookId || '' });
      }
      return result;
    },
    summarizeResult: (result) => {
      if (!result?.format) return `attachment import failed: ${trim(result?.reason)}`;
      if (result.format === 'worldbook') {
        return `worldbook ${result.ok ? 'imported' : 'partially imported'}: ${trim(result.worldbookId)} (${Number(result.entryCount || 0)} entries)${result.binding ? `; binding ${result.binding.type} ${result.binding.status}` : ''}${result.regex ? `; bound regex ${result.regex.status} ${Number(result.regex.importedRuleCount || 0)} rules` : ''}`;
      }
      if (result.format === 'preset') return `preset imported and activated: ${trim(result.presetName)} (${trim(result.presetType)})`;
      if (result.format === 'script') return `scripts imported disabled: ${Number(result.importedCount || 0)} (${Number(result.runnableCount || 0)} runnable)`;
      if (result.format === 'character_card') return `character card ${result.ok ? 'imported' : 'import incomplete'}: ${trim(result.roleCardName)}`;
      return `regex ${result.ok ? 'imported' : 'import incomplete'}: ${Number(result.importedCount || 0)} rules`;
    },
  };

  return [inspectTool, importTool];
};

export const registerAttachmentImportAgentTools = (registry, deps = {}) => {
  if (!registry?.registerMany) return [];
  return registry.registerMany(createAttachmentImportAgentTools(deps));
};
