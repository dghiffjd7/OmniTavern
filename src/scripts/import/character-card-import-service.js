// 角色卡导入服务：解析计划（只读）与提交（写入）。角色卡面板的手动导入与女仆附件导入共用。
// 提交按原导入顺序逐步写入，记录本次创建的资源；任一步失败即撤销本次创建的全部内容并恢复原先的当前角色卡。
import { logger } from '../utils/logger.js';
import { convertSTWorld } from '../storage/worldinfo.js';
import { extractCharacterCardRegexScripts } from '../utils/character-card.js';
import { findPersonaNameConflict } from '../ui/import-name-conflict-utils.js';
import { buildCharacterCardMvuConversion, extractMvuTavernHelperScripts } from './mvu-card-conversion-utils.js';
import { markMvuSchemaOnlyScripts } from './mvu-script-classification.js';

export const buildGreetingList = (card = {}) => {
  const list = [];
  const push = (content, index = 0) => {
    const text = String(content || '').trim();
    if (!text) return;
    const id = `greeting_${index + 1}`;
    const title = index === 0 ? '开场白' : `开场白 ${index + 1}`;
    list.push({ id, title, content: text });
  };
  push(card.first_mes, 0);
  const alts = Array.isArray(card.alternate_greetings) ? card.alternate_greetings : [];
  alts.forEach((g, idx) => push(g, idx + 1));
  return list;
};

const sanitizeId = (value, fallback = 'worldbook') => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) return raw;
  const safe = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/_+/g, '_').slice(0, 48).trim();
  return safe || fallback;
};


export const hasSystemPrompt = (card = {}) => {
  const sys = String(card.system_prompt || '').trim();
  const post = String(card.post_history_instructions || '').trim();
  return Boolean(sys || post);
};

const buildCharacterDefinitionText = (card) => {
  const parts = [];
  if (card.description) parts.push(`角色描述:\n${card.description}`);
  if (card.personality) parts.push(`性格特点:\n${card.personality}`);
  if (card.scenario) parts.push(`场景设定:\n${card.scenario}`);
  if (card.creator_notes) parts.push(`作者注释:\n${card.creator_notes}`);
  if (card.system_prompt) parts.push(`系统提示:\n${card.system_prompt}`);
  if (card.post_history_instructions) parts.push(`后置指令:\n${card.post_history_instructions}`);
  return parts.filter(Boolean).join('\n\n').trim();
};

const withScope = (entry, scope = []) => {
  const extra = Array.isArray(scope) ? scope.map(s => String(s || '').trim()).filter(Boolean) : [];
  return { ...entry, scope: extra };
};

export const buildWorldbookEntries = (card, { defaultScope = [] } = {}) => {
  const entries = [];
  const definitionText = buildCharacterDefinitionText(card);
  if (definitionText) {
    entries.push({
      id: `entry_${Date.now()}_character`,
      comment: '角色设定',
      title: '角色设定',
      content: definitionText,
      key: card.name ? [card.name] : [],
      keysecondary: [],
      order: 100,
      priority: 100,
      depth: 4,
      position: 0,
      selective: false,
      selectiveLogic: 0,
      constant: true,
      disable: false,
      scope: Array.isArray(defaultScope) ? defaultScope.slice() : [],
    });
  }
  if (card.character_book && typeof card.character_book === 'object') {
    try {
      const converted = convertSTWorld(card.character_book, 'imported');
      if (Array.isArray(converted?.entries)) {
        const scoped = converted.entries.map(entry => withScope(entry, defaultScope));
        entries.push(...scoped);
      }
    } catch (err) {
      logger.warn('convert worldbook failed', err);
    }
  }
  return entries;
};

export const ensureUniqueWorldbookId = (baseName, hasWorldInfo) => {
  const base = sanitizeId(baseName, 'card_worldbook');
  if (!hasWorldInfo(base)) return base;
  let idx = 1;
  while (idx < 9999) {
    const next = `${base}_${idx}`;
    if (!hasWorldInfo(next)) return next;
    idx += 1;
  }
  return `${base}_${Date.now()}`;
};

const trim = value => String(value ?? '').trim();

export const CHARACTER_CARD_IMPORT_PARTS = Object.freeze(['worldbook', 'greetings', 'regex', 'scripts', 'system_prompt', 'mvu', 'expressions', 'background']);

export const createCharacterCardImportService = ({
  personaStore,
  activatePersona,
  savePersonaCard,
  writeGreetings,
  waitForWorldReady = async () => {},
  worldExists,
  saveWorldInfo,
  deleteWorld,
  writeMvu,
  upsertSystemPreset,
  removeSystemPreset,
  upsertRegexSet,
  removeRegexSet,
  importScripts,
  removeScripts,
  deletePersona,
  createExpressionPack = null,
  removeExpressionPack = async () => {},
  setRoleBackground = null,
  restoreRoleBackground = async () => {},
  saveOriginalCharx = null,
  onWorldInfoChanged = () => {},
} = {}) => {
  // 只读：解析卡内各部分并计数，不写入任何数据
  // assets：解析出的表情／背景图片与跳过清单；charxBytes：.charx 原始包（导出时写回其余资源）
  const plan = async ({ card, raw = null, fileName = '', avatarDataUrl = '', assets = null, charxBytes = null } = {}) => {
    if (!card) return { ok: false, reason: 'character_card_parse_failed' };
    if (personaStore?.ready) await personaStore.ready;
    const displayName = trim(card.name) || '角色卡';
    const greetings = buildGreetingList(card);
    const worldEntries = buildWorldbookEntries(card, { defaultScope: [] });
    const regexScripts = extractCharacterCardRegexScripts(card);
    const tavernScripts = extractMvuTavernHelperScripts(card);
    const rawCard = raw || card.raw || card;
    const mvu = buildCharacterCardMvuConversion({ card, rawCard });
    // CCv3：公共字段照常导入；群聊专用开场白与头像以外的资源暂不导入（原始 JSON 仍完整另存）
    const cardAssets = {
      sprites: Array.isArray(assets?.sprites) ? assets.sprites : [],
      backgrounds: Array.isArray(assets?.backgrounds) ? assets.backgrounds : [],
      skipped: Array.isArray(assets?.skipped) ? assets.skipped : [],
    };
    const v3 = card.format === 'ccv3' ? {
      nickname: trim(card.nickname),
      groupOnlyGreetings: (card.group_only_greetings || []).length,
      // 未解析资源时（旧调用方）按头像以外的全部资源计；解析过则按实际跳过的数量
      droppedAssets: assets ? cardAssets.skipped.length : (card.assets || []).filter(asset => trim(asset?.type) !== 'icon').length,
      skippedAssets: cardAssets.skipped,
    } : null;
    if (mvu.errors.length) logger.warn('[character-card] Zod parse errors:', mvu.errors);
    return {
      ok: true, card, rawCard, fileName, avatarDataUrl, displayName, cardAssets, charxBytes,
      nameConflict: Boolean(findPersonaNameConflict(personaStore?.getAll?.() || [], displayName)),
      greetings, worldEntries, regexScripts, tavernScripts, mvu,
      counts: {
        greetings: greetings.length, worldEntries: worldEntries.length, regexRules: regexScripts.length,
        scripts: tavernScripts.length, mvuVariables: Object.keys(mvu.variables || {}).length,
        expressions: cardAssets.sprites.length, backgrounds: cardAssets.backgrounds.length,
      },
      hasSystemPrompt: hasSystemPrompt(card),
      v3,
    };
  };

  // 撤销本次创建的资源（倒序），再恢复原当前角色卡并删除新角色卡
  const rollback = async (created, previousActiveId) => {
    const warnings = [];
    const undo = async (label, task) => {
      try { await task(); } catch (error) { warnings.push({ step: label, message: trim(error?.message).slice(0, 160) }); }
    };
    if (created.background) await undo('background', () => restoreRoleBackground(created.background));
    if (created.expressionPack) await undo('expressions', () => removeExpressionPack(created.expressionPack));
    if (created.scripts) await undo('scripts', () => removeScripts(created.personaId));
    if (created.regexSetId) await undo('regex', () => removeRegexSet(created.regexSetId));
    if (created.presetId) await undo('system_prompt', () => removeSystemPreset(created.presetId));
    if (created.worldId) await undo('worldbook', () => deleteWorld(created.worldId));
    if (created.activated && previousActiveId) await undo('restore_active', () => activatePersona(previousActiveId));
    if (created.personaId) await undo('persona', () => deletePersona(created.personaId));
    return warnings;
  };

  // include：各部分是否导入（缺省全导）；activate：导入后是否切换到新卡
  const commit = async (planned, { include = {}, activate = false } = {}) => {
    const wants = part => include[part] !== false;
    const { card, rawCard, displayName, greetings, worldEntries, regexScripts, tavernScripts, mvu } = planned;
    const previousActiveId = trim(personaStore?.getActive?.()?.id);
    const created = { personaId: '', worldId: '', presetId: '', regexSetId: '', scripts: false, activated: false, expressionPack: null, background: null };
    let step = 'create_persona';
    try {
      const persona = await personaStore.create({
        name: displayName,
        description: '',
        avatar: planned.avatarDataUrl || '',
        source: {
          type: 'character_card',
          format: card.format || 'unknown',
          importedAt: new Date().toISOString(),
          originalFile: planned.fileName || '',
          characterName: displayName,
        },
        originalCard: null,
      });
      created.personaId = persona.id;
      if (activate) {
        step = 'activate';
        await activatePersona(persona.id);
        created.activated = true;
      }

      // 原卡另存失败时退回存在角色卡记录里（与原导入一致，不算失败）
      let originalCardStored = false;
      let originalCardSize = 0;
      try { originalCardSize = JSON.stringify(rawCard).length; } catch {}
      try {
        originalCardStored = Boolean(await savePersonaCard(persona.id, rawCard));
      } catch (err) {
        logger.warn('save persona card failed', err);
      }

      let greetingCount = 0;
      if (wants('greetings') && greetings.length) {
        step = 'greetings';
        await writeGreetings(persona.id, greetings, { activeId: greetings[0]?.id || '' });
        greetingCount = greetings.length;
      }

      if (wants('worldbook')) {
        step = 'worldbook';
        await waitForWorldReady();
        const worldId = ensureUniqueWorldbookId(displayName, id => worldExists(id));
        const saved = await saveWorldInfo(worldId, {
          name: trim(card?.name) ? displayName : '角色世界书',
          entries: worldEntries,
          source: 'character_card',
        });
        if (saved?.ok === false) throw new Error(saved.reason || 'worldbook_save_failed');
        created.worldId = worldId;
      }

      const mvuVariableCount = Object.keys(mvu.variables || {}).length;
      let mvuConverted = false;
      if (wants('mvu') && mvuVariableCount > 0) {
        step = 'mvu';
        mvuConverted = (await writeMvu(persona.id, mvu)) !== false;
      }

      if (wants('system_prompt') && hasSystemPrompt(card)) {
        step = 'system_prompt';
        const name = `${displayName}·系统提示`;
        created.presetId = trim(await upsertSystemPreset({
          name,
          appScope: 'creative',
          data: { name, content: trim(card.system_prompt), post_history: trim(card.post_history_instructions) },
          makeActive: false,
        }));
      }

      if (wants('regex') && regexScripts.length) {
        step = 'regex';
        created.regexSetId = trim(await upsertRegexSet({
          name: `${displayName}·正则`,
          enabled: true,
          bind: created.worldId ? { type: 'world', worldId: created.worldId } : null,
          rules: regexScripts,
        }));
      }

      let scripts = null;
      if (wants('scripts') && tavernScripts.length) {
        step = 'scripts';
        // 原生变量层已接管 Schema 与 MVU 引擎；卡内其余行为脚本仍须正常执行（导入后一律关闭、未授权）
        created.scripts = true;
        scripts = await importScripts({ scripts: markMvuSchemaOnlyScripts(tavernScripts), scope: 'character', scopeId: persona.id, source: 'card' });
      }

      const { cardAssets = { sprites: [], backgrounds: [] }, charxBytes = null } = planned;
      if (wants('expressions') && cardAssets.sprites.length && typeof createExpressionPack === 'function') {
        step = 'expressions';
        created.expressionPack = await createExpressionPack({ personaId: persona.id, displayName, images: cardAssets.sprites });
      }
      if (wants('background') && cardAssets.backgrounds.length && typeof setRoleBackground === 'function') {
        step = 'background';
        created.background = await setRoleBackground({ personaId: persona.id, image: cardAssets.backgrounds[0] });
      }
      // 原始 .charx 另存失败不影响导入（与原卡 sidecar 一致），只是导出 .charx 时无法写回其余资源
      let originalCharxStored = false;
      if (charxBytes && typeof saveOriginalCharx === 'function') {
        try {
          originalCharxStored = Boolean(await saveOriginalCharx(persona.id, charxBytes));
        } catch (err) {
          logger.warn('save original charx failed', err);
        }
      }

      step = 'bind';
      const source = {
        ...(persona?.source || {}),
        worldbookId: created.worldId || persona?.source?.worldbookId,
        worldbookEnabled: created.worldId ? true : (persona?.source?.worldbookEnabled !== false),
        systemPresetId: created.presetId || persona?.source?.systemPresetId,
        regexSetId: created.regexSetId || persona?.source?.regexSetId,
        mvuConverted,
        mvuVariableCount,
        mvuSource: mvuConverted ? mvu.source : 'none',
        originalCardStored,
        originalCardSize,
        ...(planned.v3 ? { cardSpec: 'ccv3', ...(planned.v3.nickname ? { nickname: planned.v3.nickname } : {}) } : {}),
        ...(originalCharxStored ? { originalCharxStored: true } : {}),
        ...(created.expressionPack ? { expressionPackId: created.expressionPack.packId } : {}),
      };
      await personaStore.update?.(persona.id, { source, ...(originalCardStored ? {} : { originalCard: rawCard }) });
      try { onWorldInfoChanged(created.worldId); } catch {}
      return {
        ok: true,
        personaId: persona.id,
        displayName,
        activated: created.activated,
        worldbookId: created.worldId,
        worldEntryCount: created.worldId ? worldEntries.length : 0,
        greetingCount,
        systemPresetId: created.presetId,
        regexSetId: created.regexSetId,
        regexRuleCount: created.regexSetId ? regexScripts.length : 0,
        scripts,
        mvuConverted,
        mvuVariableCount,
        mvuSource: mvu.source,
        originalCardStored,
        expressionCount: created.expressionPack?.count || 0,
        backgroundSet: Boolean(created.background),
        originalCharxStored,
      };
    } catch (error) {
      logger.warn(`[character-card] import failed at ${step}, rolling back`, error);
      const rollbackWarnings = await rollback(created, previousActiveId);
      return {
        ok: false,
        reason: 'character_card_import_failed',
        step,
        errorMessage: trim(error?.message).slice(0, 160),
        rolledBack: true,
        rollbackWarnings,
      };
    }
  };

  return { plan, commit };
};
