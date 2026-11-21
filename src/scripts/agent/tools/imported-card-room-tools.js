import {
  MAID_IMPORTED_CARD_PLAN_TOOL,
  buildMaidImportedCardPreviewMessage,
  buildMaidImportedCardWorkflowSnapshot,
  normalizeMaidImportedCardClassification,
  validateMaidImportedCardWorkflowSnapshot,
} from '../maid-imported-card-workflow.js';

// 从当前角色卡关联世界书挑主要人物建房：读卡、有界读世界书完整索引、一次分类、冻结建房清单。
// 本工具只读（分类会调用一次模型）；createRooms:true 时返回冻结清单，女仆执行层据此停下等用户确认，
// 确认后才切卡、建私聊、建群（各写入工具照常弹确认卡）。

const MAX_INDEX_ENTRIES = 200;
const MAX_AMBIGUOUS_READS = 6;
const AMBIGUOUS_CONTENT_LENGTH = 1200;

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const compactText = value => trim(value)
  .toLowerCase()
  .replace(/[「」『』“”"'`]/g, '')
  .replace(/\s+/g, '');

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

const unwrapOutput = output => (
  isPlainObject(output) && Object.prototype.hasOwnProperty.call(output, 'result') ? output.result : output
);

const isOutputOk = (output) => {
  if (output?.status && output.status !== 'succeeded') return false;
  const result = unwrapOutput(output);
  return !(isPlainObject(result) && result.ok === false);
};

const isAbort = (error, signal) => Boolean(signal?.aborted || error?.name === 'AbortError');

const failure = (reason, message, { needsInput = false } = {}) => ({
  ok: false,
  reason,
  message,
  ...(needsInput ? { needsInput: true } : {}),
});

const resolvePersona = (result = {}, personaName = '') => {
  const items = Array.isArray(result?.items) ? result.items : [];
  if (personaName) {
    const targetKey = compactText(personaName);
    const matches = items.filter(item => (
      compactText(item?.id) === targetKey || compactText(item?.name) === targetKey
    ));
    if (matches.length === 1) return { persona: matches[0], reason: '' };
    return {
      persona: null,
      reason: matches.length > 1 ? 'persona_target_ambiguous' : 'persona_target_not_found',
    };
  }
  const activeId = trim(result?.activeId);
  const active = items.find(item => (
    item?.active === true || (activeId && trim(item?.id) === activeId)
  )) || null;
  if (active) return { persona: active, reason: '' };
  return {
    persona: null,
    reason: items.length > 1 ? 'persona_target_required' : 'active_persona_not_found',
  };
};

// 只凭标题判断不出是不是人物的少数条目，补读正文片段再分类
const isAmbiguousEntry = (entry = {}) => {
  const title = compactText(entry?.title || entry?.name || entry?.id);
  const keys = [
    ...(Array.isArray(entry?.keys) ? entry.keys : []),
    ...(Array.isArray(entry?.secondaryKeys) ? entry.secondaryKeys : []),
  ].map(item => trim(item)).filter(Boolean);
  return (
    /^(?:角色|人物|角色设定|人物设定|角色资料|人物资料|character|profile|设定)$/iu.test(title) ||
    (!keys.length && /^(?:entry|条目|资料)\d*$/iu.test(title))
  );
};

export const createImportedCardRoomTools = ({
  executeTool = null,
  classify = null,
} = {}) => {
  const runTool = async (toolName, args, context) => {
    try {
      const output = await executeTool(toolName, args, context);
      return { ok: isOutputOk(output), output, result: unwrapOutput(output) };
    } catch (error) {
      if (isAbort(error, context?.signal)) throw error;
      return {
        ok: false,
        output: null,
        result: { ok: false, reason: trim(error?.code || error?.message, 'tool_failed') },
        errorMessage: trim(error?.message),
      };
    }
  };
  const describeFailure = read => trim(
    read?.output?.summary ||
    read?.result?.message ||
    read?.result?.reason ||
    read?.errorMessage,
    '女仆执行失败。',
  );

  const planCharacterRooms = async (args = {}, context = {}) => {
    if (trim(args.worldbookStrategy) === 'isolated_session_worldbooks') {
      return failure(
        'isolated_worldbook_strategy_not_supported_in_imported_card_workflow',
        '这张导入卡已有共用世界书；当前有界流程只支持安全继承。若确实要为每个聊天室建立隔离世界书，请另行明确每位人物的隔离范围。',
        { needsInput: true },
      );
    }
    if (typeof classify !== 'function' || typeof executeTool !== 'function') {
      return failure('imported_card_classifier_unavailable', '导入角色卡的人物分类器尚未配置，未执行任何写入。');
    }
    const personaName = trim(args.personaName);
    const createRooms = args.createRooms === true;
    const groupName = trim(args.groupName);
    const groupRequested = createRooms && (args.includeGroup === true || Boolean(groupName));

    const personaRead = await runTool('app.read_resource', {
      resource: 'persona',
      ...(personaName ? { name: personaName } : {}),
      include: ['associations'],
    }, context);
    if (!personaRead.ok) return failure('persona_read_failed', describeFailure(personaRead));
    const resolved = resolvePersona(personaRead.result, personaName);
    if (!resolved.persona) {
      return failure(
        resolved.reason,
        resolved.reason === 'persona_target_ambiguous'
          ? '找到多张同名角色卡，请先明确要处理的角色卡 ID。'
          : '没有找到唯一的目标角色卡；请先切到目标角色卡，或在指令中写出角色卡名称。',
        { needsInput: true },
      );
    }
    const persona = resolved.persona;
    const personaLabel = trim(persona?.name || persona?.id);
    const activePersonaId = trim(personaRead.result?.activeId);
    if (persona?.active !== true && (!activePersonaId || trim(persona?.id) !== activePersonaId)) {
      return failure(
        'target_persona_not_active',
        `「${personaLabel}」目前不是活动角色卡。请先切换到它再预览，避免读取或冻结到其他角色卡的聊天室作用域。`,
        { needsInput: true },
      );
    }
    const worldbookId = trim(persona?.associations?.worldbookId);
    if (!worldbookId || persona?.associations?.worldbookEnabled === false) {
      return failure(
        worldbookId ? 'persona_worldbook_disabled' : 'persona_worldbook_missing',
        worldbookId
          ? `角色卡「${personaLabel}」关联的世界书目前未启用。`
          : `角色卡「${personaLabel}」没有可继承的关联世界书。`,
        { needsInput: true },
      );
    }

    const worldbookRead = await runTool('worldbook.read', { name: worldbookId, maxEntries: MAX_INDEX_ENTRIES }, context);
    if (!worldbookRead.ok) return failure('worldbook_read_failed', describeFailure(worldbookRead));
    const entryCount = Math.max(0, Math.trunc(Number(worldbookRead.result?.entryCount) || 0));
    const returnedEntryCount = Math.max(0, Math.trunc(Number(worldbookRead.result?.returnedEntryCount) || 0));
    if (entryCount > MAX_INDEX_ENTRIES || returnedEntryCount !== entryCount || worldbookRead.result?.truncated === true) {
      return failure(
        'worldbook_index_incomplete',
        `关联世界书共有 ${entryCount} 条，但本轮只能安全取得 ${returnedEntryCount} 条完整索引；未分类、未创建任何资源。`,
        { needsInput: true },
      );
    }
    let entries = (Array.isArray(worldbookRead.result?.entries) ? worldbookRead.result.entries : [])
      .map(item => clone(item));
    for (const entry of entries.filter(isAmbiguousEntry).slice(0, MAX_AMBIGUOUS_READS)) {
      const detailRead = await runTool('worldbook.read', {
        name: worldbookId,
        entryId: trim(entry?.id),
        includeContent: true,
        maxEntries: 1,
        maxContentLength: AMBIGUOUS_CONTENT_LENGTH,
      }, context);
      const detailed = detailRead.ok && Array.isArray(detailRead.result?.entries) ? detailRead.result.entries[0] : null;
      if (!detailed) continue;
      entries = entries.map(item => (
        trim(item?.id) === trim(entry?.id)
          ? { ...item, content: trim(detailed?.content).slice(0, AMBIGUOUS_CONTENT_LENGTH) }
          : item
      ));
    }

    const worldbook = {
      id: trim(worldbookRead.result?.id || worldbookId),
      name: trim(worldbookRead.result?.name || worldbookId),
      enabled: true,
      entryCount,
      returnedEntryCount,
    };
    let rawClassification = null;
    try {
      rawClassification = await classify({
        input: trim(args.criteria) || trim(context?.maidUserInput),
        persona: { id: trim(persona?.id), name: personaLabel },
        worldbook: { id: worldbook.id, name: worldbook.name, entryCount },
        entries,
      }, context);
    } catch (error) {
      if (isAbort(error, context?.signal)) throw error;
      return failure('imported_card_classification_failed', trim(error?.message, '人物分类模型调用失败；未执行任何写入。'));
    }
    const classification = normalizeMaidImportedCardClassification(rawClassification, {
      entries,
      requestedGroupName: groupName,
      groupRequested,
    });
    if (!classification.ok) {
      return failure(
        classification.reason,
        `人物分类结果未通过完整性校验（${classification.reason}）；未执行任何写入。`,
      );
    }
    if (!createRooms) {
      const previewSnapshot = buildMaidImportedCardWorkflowSnapshot({ persona, worldbook, classification });
      return {
        ok: true,
        createRooms: false,
        persona: { id: trim(persona?.id), name: personaLabel },
        worldbook,
        candidates: clone(classification.candidates),
        classificationCounts: clone(classification.classificationCounts),
        message: buildMaidImportedCardPreviewMessage(previewSnapshot, { previewOnly: true }),
      };
    }

    const sessionList = await runTool('session.list', { limit: 100, includeGroups: true }, context);
    if (!sessionList.ok) return failure('session_list_failed', describeFailure(sessionList));
    const contacts = Array.isArray(sessionList.result?.contacts) ? sessionList.result.contacts : [];
    const groupKey = compactText(classification?.group?.name);
    const existingGroup = classification?.group?.enabled === true
      ? contacts.find(item => compactText(item?.id) === groupKey || compactText(item?.name) === groupKey)
      : null;
    let existingGroupMembers = [];
    if (existingGroup?.isGroup === true) {
      const groupRead = await runTool('app.read_resource', {
        resource: 'session',
        id: trim(existingGroup?.id),
        include: ['members'],
      }, context);
      if (!groupRead.ok) return failure('existing_group_read_failed', describeFailure(groupRead));
      existingGroupMembers = (groupRead.result?.sessions?.[0]?.members || [])
        .map(item => trim(item?.id || item))
        .filter(Boolean);
    }
    const snapshot = buildMaidImportedCardWorkflowSnapshot({
      persona,
      worldbook,
      classification,
      contacts,
      existingGroupMembers,
      revealRequested: args.openWhenDone === true,
    });
    const privateConflict = snapshot.privateSessions.find(item => item.existingType === 'group');
    if (privateConflict) {
      return failure(
        'private_session_name_conflict',
        `候选人物「${privateConflict.name}」与现有群聊同名，无法安全冻结建房清单。`,
        { needsInput: true },
      );
    }
    if (snapshot.group.enabled && snapshot.group.existingType === 'private') {
      return failure(
        'group_name_conflict',
        `拟建群聊「${snapshot.group.name}」与现有私聊同名，请先换一个群名。`,
        { needsInput: true },
      );
    }
    const validation = validateMaidImportedCardWorkflowSnapshot(snapshot);
    if (!validation.ok) {
      return failure(validation.reason, `冻结清单未通过校验（${validation.reason}）；未执行任何写入。`);
    }
    return {
      ok: true,
      createRooms: true,
      awaitingConfirmation: true,
      pendingWorkflow: validation.snapshot,
      message: buildMaidImportedCardPreviewMessage(validation.snapshot),
    };
  };

  return [{
    name: MAID_IMPORTED_CARD_PLAN_TOOL,
    title: 'Pick characters from the card worldbook and plan chats',
    description: 'Read the full entry index of the worldbook linked to the active character card, classify the entries once, and pick the main characters. createRooms:false lists the candidates. createRooms:true also freezes a plan of one private chat per picked character (plus one group chat when requested); the task then pauses for the user to reply confirm or cancel, and on confirmation the APP creates the chats under that card, each write with its own confirmation card. The chats inherit the card worldbook. This tool itself writes nothing.',
    source: 'maid-imported-card',
    permissions: [],
    riskLevel: 'low',
    capabilities: {
      read: true,
      write: false,
      network: true,
      cost: 'variable',
      undo: 'none',
      modelContext: 'none',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        personaName: { type: 'string', maxLength: 80, description: 'Name or id of the character card. It must be the active card; omit to use the active card.' },
        criteria: { type: 'string', maxLength: 400, description: 'Which characters to pick, in the user\'s words (a team, faction or scope). Omit to pick the main characters.' },
        createRooms: { type: 'boolean', description: 'true: freeze a chat plan and wait for the user\'s confirmation before creating. Omit or false: only list the candidates.' },
        includeGroup: { type: 'boolean', description: 'With createRooms:true, also plan one group chat of the picked characters.' },
        groupName: { type: 'string', maxLength: 80, description: 'Name of that group chat; giving a name also plans the group.' },
        worldbookStrategy: {
          type: 'string',
          enum: ['inherit_persona_worldbook', 'isolated_session_worldbooks'],
          description: 'inherit_persona_worldbook (default): the chats inherit the card worldbook. This tool supports inheritance only; with isolated_session_worldbooks it stops before reading and explains.',
        },
        openWhenDone: { type: 'boolean', description: 'After the confirmed chats are created, open the group chat, or the first private chat when no group is planned.' },
      },
    },
    timeoutMs: 0,
    execute: planCharacterRooms,
    summarizeResult: (result) => {
      if (result?.ok === false) return `character room plan failed: ${trim(result?.reason, 'unknown')}`;
      if (result?.awaitingConfirmation) {
        return `froze a chat plan for ${Number(result?.pendingWorkflow?.candidates?.length || 0)} character(s); waiting for the user to confirm`;
      }
      return `picked ${Number(result?.candidates?.length || 0)} candidate character(s); nothing created`;
    },
  }];
};

export const registerImportedCardRoomTools = (registry, deps = {}) => {
  const tools = createImportedCardRoomTools(deps);
  if (registry && typeof registry.registerMany === 'function') registry.registerMany(tools);
  return tools;
};
