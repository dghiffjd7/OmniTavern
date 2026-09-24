import { classifyMaidPendingActionReply, isPendingRunInContext } from './maid-pending-action.js';

export const MAID_IMPORTED_CARD_WORKFLOW_KIND = 'imported_card_session_setup';
export const MAID_IMPORTED_CARD_WORKFLOW_VERSION = 1;

const CLASSIFICATION_KINDS = new Set(['character', 'setting', 'format', 'rule', 'other']);
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeText = value => trim(value)
  .normalize('NFKC')
  .toLowerCase()
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

const uniqueStrings = (value, limit = 100) => Array.from(new Set(
  (Array.isArray(value) ? value : [])
    .map(item => trim(item))
    .filter(Boolean),
)).slice(0, limit);

const extractQuotedPersonaName = (text = '') => {
  const patterns = [
    /(?:切到|切换到|当前(?:是|在)?|现在(?:是|在)?|就在|使用)\s*[「『“"'‘]([^」』”"'’]{1,80})[」』”"'’]\s*(?:这张)?(?:角色卡|人物卡|卡)/iu,
    /[「『“"'‘]([^」』”"'’]{1,80})[」』”"'’]\s*(?:这张)?(?:角色卡|人物卡)/iu,
    /(?:角色卡|人物卡)\s*[「『“"'‘]([^」』”"'’]{1,80})[」』”"'’]/iu,
  ];
  for (const pattern of patterns) {
    const matched = String(text || '').match(pattern);
    if (trim(matched?.[1])) return trim(matched[1]);
  }
  return '';
};

const extractQuotedGroupName = (text = '') => {
  const patterns = [
    /(?:建立|创建|新建|建|开)(?:一个|一個|个|個)?\s*(?:真)?群聊\s*[「『“"'‘]([^」』”"'’]{1,80})[」』”"'’]/iu,
    /(?:建立|创建|新建|建|开)(?:一个|一個|个|個)?\s*[「『“"'‘]([^」』”"'’]{1,80})[」』”"'’]\s*(?:真)?群聊/iu,
    /(?:群聊|群组)(?:名|名称|叫|叫做|设为|设成)?\s*[「『“"'‘]([^」』”"'’]{1,80})[」』”"'’]/iu,
  ];
  for (const pattern of patterns) {
    const matched = String(text || '').match(pattern);
    if (trim(matched?.[1])) return trim(matched[1]);
  }
  return '';
};

export const classifyMaidImportedCardWorkflowIntent = (input = '') => {
  const text = String(input ?? '').normalize('NFKC');
  const hasImportedCardSource = Boolean(
    /(?:导入|匯入|自带|自帶|关联|關聯|绑定|綁定|当前|當前|这张|這張).{0,28}(?:角色卡|人物卡|世界书|世界書)|(?:角色卡|人物卡).{0,32}(?:自带|自帶|关联|關聯|世界书|世界書)|\b(?:imported?\s+)?character\s*card\b/isu.test(text),
  );
  const hasSelectionTask = Boolean(
    /(?:挑(?:出|选|選)?|筛选|篩選|识别|識別|找出|整理|候选|候選|主要人物|主要角色|核心人物|核心角色|成员|成員)|\b(?:select|identify|classify|candidate|main\s+characters?)\b/iu.test(text),
  );
  const hasChatPurpose = Boolean(
    /(?:长期聊天|長期聊天|私聊|单聊|單聊|聊天室|会话|會話|房间|房間|群聊|群组|群組|联系人|聯絡人)|\b(?:private\s+chat|chat\s*room|session|group\s*chat|contact)\b/iu.test(text),
  );
  const matched = hasImportedCardSource && hasSelectionTask && hasChatPurpose;
  if (!matched) {
    return {
      matched: false,
      createRequested: false,
      groupRequested: false,
      targetPersonaName: '',
      requestedGroupName: '',
      requestedStrategy: '',
      revealRequested: false,
    };
  }

  const rawCreateRequested = Boolean(
    /(?:创建|建立|新建|新增|生成|建|开).{0,52}(?:私聊|单聊|單聊|聊天室|会话|會話|房间|房間|群聊|群组|群組|联系人|聯絡人)|(?:给|為|为).{0,36}(?:人物|角色|成员|成員).{0,24}(?:建立|创建|新建|开).{0,24}(?:私聊|聊天室|群聊)|\b(?:create|build|add)\b.{0,48}\b(?:private\s+chat|chat\s*room|session|group\s*chat|contact)\b/isu.test(text),
  );
  const explicitPreviewOnly = Boolean(
    /(?:这一步|這一步|本轮|本輪|现在|現在)?\s*(?:先)?\s*(?:只看|只读|只讀|只整理|只给|只給).{0,20}(?:候选|候選|清单|清單)|(?:先别|先不要|不要|別|别)\s*(?:真的)?\s*(?:创建|建立|新建|修改|写入|寫入)/isu.test(text),
  );
  const stagedConfirmation = Boolean(
    /(?:先[^。！？.!?；;]{0,80}(?:(?:给|給|让|讓)我)?(?:确认|確認)|等我确认|等我確認|确认后|確認後|我确认再|我確認再|确认.*再|確認.*再)/isu.test(text),
  );
  const createRequested = rawCreateRequested && (!explicitPreviewOnly || stagedConfirmation);
  const groupRequested = createRequested && /(?:群聊|群组|群組|group\s*chat)/iu.test(text);
  const requestedStrategy = /(?:隔离|隔離|独立|獨立|专属|專屬).{0,16}(?:世界书|世界書)/iu.test(text)
    ? 'isolated_session_worldbooks'
    : 'inherit_persona_worldbook';
  return {
    matched: true,
    createRequested,
    groupRequested,
    targetPersonaName: extractQuotedPersonaName(text),
    requestedGroupName: extractQuotedGroupName(text),
    requestedStrategy,
    revealRequested: /(?:完成后|完成後|最后|最後|然后|然後).{0,24}(?:打开|打開|进入|進入|给我看|給我看)|(?:打开|打開|进入|進入).{0,18}(?:群聊|结果|結果)/isu.test(text),
  };
};

// 建房清单是低风险写入，确认比删除宽松：短答复（含“好 / 可以 / ok / 嗯”，与语音侧同一套词）即可确认。
// 仅完整短答复走快捷入口；自然语言原话交给现有 planner，不用否定/条件关键词表抢先决定整单执行。
export const classifyMaidImportedCardConfirmation = (input = '') => {
  const text = String(input ?? '').normalize('NFKC').trim();
  if (!text || text.length > 120) return 'none';
  const shortReply = classifyMaidPendingActionReply(text);
  if (shortReply === 'confirm' || shortReply === 'cancel') return shortReply;
  if (/^(?:我)?(?:不同意|不确认|不確認|不批准|不要(?:执行|執行|创建|建立|建)|不(?:执行|執行|用了))[。.!！\s]*$/iu.test(text)) return 'cancel';
  if (/^(?:我确认|我確認|开始|開始|继续|繼續|就这样|就這樣|就按(?:这|這)(?:份|个|個)?(?:清单|清單|方案)?(?:来|來)?|照(?:这|這)(?:份|个|個)?(?:清单|清單|方案)?(?:来|來)?)[。.!！\s]*$/iu.test(text)) return 'confirm';
  return 'none';
};

export const normalizeMaidImportedCardClassification = (raw = {}, {
  entries = [],
  requestedGroupName = '',
  groupRequested = false,
} = {}) => {
  if (!isPlainObject(raw)) return { ok: false, reason: 'invalid_classification_payload' };
  const sourceEntries = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => ({
      ...entry,
      id: trim(entry?.id || entry?.entryId, `entry-${index + 1}`),
      title: trim(entry?.title || entry?.name || entry?.id, `条目 ${index + 1}`),
    }));
  const entryById = new Map(sourceEntries.map(entry => [entry.id, entry]));
  const classifications = new Map();
  for (const item of (Array.isArray(raw.entries) ? raw.entries : [])) {
    const entryId = trim(item?.entryId || item?.id);
    const kind = trim(item?.kind).toLowerCase();
    if (!entryById.has(entryId) || !CLASSIFICATION_KINDS.has(kind) || classifications.has(entryId)) continue;
    classifications.set(entryId, kind);
  }
  if (classifications.size !== entryById.size) {
    return {
      ok: false,
      reason: 'classification_coverage_incomplete',
      expectedCount: entryById.size,
      classifiedCount: classifications.size,
    };
  }

  const candidates = [];
  const seenEntries = new Set();
  const seenNames = new Set();
  for (const item of Array.isArray(raw.candidates) ? raw.candidates : []) {
    const entryId = trim(item?.entryId || item?.id);
    const source = entryById.get(entryId);
    const name = trim(item?.name || source?.title).slice(0, 80);
    const nameKey = normalizeText(name);
    if (
      !source ||
      classifications.get(entryId) !== 'character' ||
      !name ||
      seenEntries.has(entryId) ||
      seenNames.has(nameKey)
    ) continue;
    const numericConfidence = Number(item?.confidence);
    const confidence = Number.isFinite(numericConfidence)
      ? Math.max(0, Math.min(1, numericConfidence))
      : 0;
    const reason = trim(item?.reason).slice(0, 180);
    seenEntries.add(entryId);
    seenNames.add(nameKey);
    candidates.push({
      entryId,
      name,
      confidence,
      reason: reason || '世界书人物条目',
      lowConfidence: confidence < 0.65,
    });
    if (candidates.length >= 20) break;
  }
  if (!candidates.length) return { ok: false, reason: 'no_character_candidates' };

  const candidateIds = new Set(candidates.map(item => item.entryId));
  const rawGroup = isPlainObject(raw.group) ? raw.group : {};
  const groupEnabled = groupRequested === true;
  const memberEntryIds = uniqueStrings(rawGroup.memberEntryIds, 20)
    .filter(entryId => candidateIds.has(entryId));
  const normalizedMemberIds = memberEntryIds.length >= 2
    ? memberEntryIds
    : candidates.map(item => item.entryId);
  const groupName = trim(requestedGroupName || rawGroup.name, '主要人物群聊').slice(0, 80);
  const counts = {};
  CLASSIFICATION_KINDS.forEach((kind) => {
    counts[kind] = Array.from(classifications.values()).filter(value => value === kind).length;
  });
  return {
    ok: true,
    candidates,
    classificationCounts: counts,
    classifiedEntryCount: classifications.size,
    group: {
      enabled: groupEnabled,
      name: groupName,
      memberEntryIds: groupEnabled ? normalizedMemberIds : [],
    },
  };
};

export const buildMaidImportedCardWorkflowSnapshot = ({
  now = Date.now(),
  persona = {},
  worldbook = {},
  classification = {},
  contacts = [],
  existingGroupMembers = [],
  revealRequested = false,
} = {}) => {
  const createdAt = Number(now) || Date.now();
  const contactList = Array.isArray(contacts) ? contacts : [];
  const findContact = (name = '') => {
    const key = normalizeText(name);
    return contactList.find(item => (
      normalizeText(item?.id) === key || normalizeText(item?.name) === key
    )) || null;
  };
  const candidates = (Array.isArray(classification?.candidates) ? classification.candidates : [])
    .map(item => ({
      entryId: trim(item?.entryId),
      name: trim(item?.name),
      confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
      reason: trim(item?.reason).slice(0, 180),
      lowConfidence: item?.lowConfidence === true,
    }))
    .filter(item => item.entryId && item.name)
    .slice(0, 20);
  const privateSessions = candidates.map((candidate) => {
    const existing = findContact(candidate.name);
    return {
      entryId: candidate.entryId,
      name: candidate.name,
      existingSessionId: trim(existing?.id),
      existingType: existing?.isGroup === true ? 'group' : (existing ? 'private' : ''),
    };
  });
  const groupEnabled = classification?.group?.enabled === true;
  const groupName = groupEnabled ? trim(classification?.group?.name, '主要人物群聊') : '';
  const existingGroup = groupEnabled ? findContact(groupName) : null;
  const groupMemberNames = uniqueStrings(
    classification?.group?.memberEntryIds
      ?.map(entryId => candidates.find(item => item.entryId === entryId)?.name)
      .filter(Boolean),
    20,
  );
  return {
    version: MAID_IMPORTED_CARD_WORKFLOW_VERSION,
    kind: MAID_IMPORTED_CARD_WORKFLOW_KIND,
    state: 'awaiting_confirmation',
    createdAt,
    expiresAt: createdAt + PENDING_TTL_MS,
    persona: {
      id: trim(persona?.id),
      name: trim(persona?.name || persona?.id),
      activeAtPreview: persona?.active === true,
    },
    worldbook: {
      id: trim(worldbook?.id),
      name: trim(worldbook?.name || worldbook?.id),
      enabled: worldbook?.enabled !== false,
      entryCount: Math.max(0, Math.trunc(Number(worldbook?.entryCount) || 0)),
      returnedEntryCount: Math.max(0, Math.trunc(Number(worldbook?.returnedEntryCount) || 0)),
    },
    strategy: 'inherit_persona_worldbook',
    classificationCounts: clone(classification?.classificationCounts || {}),
    candidates,
    privateSessions,
    group: {
      enabled: groupEnabled,
      name: groupName,
      memberNames: groupMemberNames,
      existingSessionId: trim(existingGroup?.id),
      existingType: existingGroup?.isGroup === true ? 'group' : (existingGroup ? 'private' : ''),
      existingMemberIds: uniqueStrings(existingGroupMembers, 50),
    },
    revealRequested: revealRequested === true,
  };
};

export const validateMaidImportedCardWorkflowSnapshot = (value = {}, {
  now = Date.now(),
  allowExpired = false,
} = {}) => {
  if (
    !isPlainObject(value) ||
    trim(value.kind) !== MAID_IMPORTED_CARD_WORKFLOW_KIND ||
    Number(value.version) !== MAID_IMPORTED_CARD_WORKFLOW_VERSION
  ) return { ok: false, reason: 'invalid_pending_workflow' };
  if (trim(value.state) !== 'awaiting_confirmation') {
    return { ok: false, reason: 'pending_workflow_not_active' };
  }
  if (!allowExpired && Number(value.expiresAt || 0) <= Number(now || Date.now())) {
    return { ok: false, reason: 'pending_workflow_expired' };
  }
  if (!trim(value?.persona?.id) || !trim(value?.worldbook?.id)) {
    return { ok: false, reason: 'pending_workflow_scope_missing' };
  }
  const candidates = Array.isArray(value.candidates) ? value.candidates : [];
  if (!candidates.length || candidates.some(item => !trim(item?.entryId) || !trim(item?.name))) {
    return { ok: false, reason: 'pending_workflow_candidates_invalid' };
  }
  if (
    value?.group?.enabled === true &&
    (
      !trim(value?.group?.name) ||
      !Array.isArray(value?.group?.memberNames) ||
      value.group.memberNames.length < 2
    )
  ) return { ok: false, reason: 'pending_workflow_group_invalid' };
  return { ok: true, snapshot: clone(value) };
};

export const resolvePendingMaidImportedCardWorkflow = (runs = [], {
  now = Date.now(),
  context = {},
} = {}) => {
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!isPendingRunInContext(run, context)) continue;
    const pending = run?.metadata?.pendingWorkflow;
    const validation = validateMaidImportedCardWorkflowSnapshot(pending, { now });
    if (!validation.ok) continue;
    return {
      runId: trim(run?.id),
      run: clone(run),
      snapshot: validation.snapshot,
    };
  }
  return null;
};

const formatConfidence = value => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;

export const buildMaidImportedCardPreviewMessage = (snapshot = {}, {
  previewOnly = false,
} = {}) => {
  const candidates = Array.isArray(snapshot?.candidates) ? snapshot.candidates : [];
  const lines = candidates.map((item, index) => (
    `${index + 1}. ${trim(item?.name)}（${formatConfidence(item?.confidence)}）— ${trim(item?.reason, '世界书人物条目')}`
  ));
  const worldbook = snapshot?.worldbook || {};
  const header = `已完整读取「${trim(worldbook.name || worldbook.id)}」世界书索引（${Number(worldbook.returnedEntryCount || 0)}/${Number(worldbook.entryCount || 0)}），并用一次分类整理出 ${candidates.length} 位候选：`;
  if (previewOnly) {
    return [
      header,
      ...lines,
      '',
      '本轮只读整理完成，没有创建聊天室、群聊，也没有修改或绑定世界书。',
    ].join('\n');
  }
  const privateNewCount = (Array.isArray(snapshot?.privateSessions) ? snapshot.privateSessions : [])
    .filter(item => !trim(item?.existingSessionId)).length;
  const privateReuseCount = candidates.length - privateNewCount;
  const group = snapshot?.group || {};
  const groupLine = group.enabled === true
    ? `群聊：${trim(group.name)}（${group.memberNames?.length || 0} 位成员；${trim(group.existingSessionId) ? '复用并核对现有群聊' : '新建'}）`
    : '群聊：不建立';
  return [
    header,
    ...lines,
    '',
    `私聊：预计新增 ${privateNewCount} 个，复用 ${privateReuseCount} 个。`,
    groupLine,
    '世界书策略：继承角色卡世界书（不会新增、复制或写入 session 直接绑定）。',
    '',
    '确认前尚未执行任何写入。若清单无误，请回复“确认”；要放弃请回复“取消”。',
  ].join('\n');
};

export const buildMaidImportedCardExecutionMessage = ({
  snapshot = {},
  privateCreatedCount = 0,
  privateReusedCount = 0,
  groupCreated = false,
  groupReused = false,
  opened = false,
} = {}) => {
  const group = snapshot?.group || {};
  const parts = [
    `已完成并读回验证：${Number(privateCreatedCount || 0)} 个私聊新建、${Number(privateReusedCount || 0)} 个复用。`,
  ];
  if (group.enabled === true) {
    parts.push(`群聊「${trim(group.name)}」已${groupCreated ? '建立' : (groupReused ? '复用' : '核对')}，成员与冻结清单一致。`);
  }
  parts.push(`所有目标会话均继承「${trim(snapshot?.worldbook?.name || snapshot?.worldbook?.id)}」角色卡世界书，session 直接绑定为空。`);
  if (opened) parts.push('已打开主要群聊供你查看。');
  return parts.join('\n');
};
