// 记忆总览（Agent 资源中心计划 P4）：记忆资料库按角色卡分，一张卡一个库，含它所有聊天室与全局／动态记忆。
// 这里只做汇总（纯函数）：整张卡按聊天室统计；当前会话取最近一次真实发送的注入计划。不编辑任何记忆。

const trim = value => String(value ?? '').trim();
const toTime = (value) => {
  const time = Number(value);
  return Number.isFinite(time) && time > 0 ? time : 0;
};

export const MEMORY_PREVIEW_TOOL = 'memory.preview_actions';
// 跨会话带进来的段落（跨模式共享、群／私聊互相参考、关键词召回）
const SHARED_SEGMENT_RE = /^memory_(?:bridge_|hardcoded_|keyword_recall|dynamic_weak_recall|cross_scope)/;

/** 一行记忆属于哪个聊天室：私聊与创意写作按 contact_id，群聊按 group_id，都没有的是全局／动态。 */
export const memoryRoomOf = (row) => {
  const groupId = trim(row?.group_id);
  if (groupId) return { key: groupId, kind: 'group', sessionId: groupId };
  const contactId = trim(row?.contact_id);
  if (contactId) return { key: contactId, kind: contactId.startsWith('rp:') ? 'rp' : 'private', sessionId: contactId };
  return { key: '', kind: 'global', sessionId: '' };
};

/**
 * 整张卡：只统计当前模板的行（其他模板的行当前不会被读取，单独列出）。
 * 返回 { templateId, totalRows, rooms: [{ key, kind, sessionId, rowCount, inactiveCount, tableCount, lastUpdatedAt }], otherTemplates: [{ templateId, rowCount }] }。
 */
export const summarizeCardMemory = ({ rows = [], templateId = '' } = {}) => {
  const current = trim(templateId);
  const rooms = new Map();
  const otherTemplates = new Map();
  let totalRows = 0;
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const rowTemplate = trim(row?.template_id);
    if (rowTemplate !== current) {
      otherTemplates.set(rowTemplate, (otherTemplates.get(rowTemplate) || 0) + 1);
      return;
    }
    totalRows += 1;
    const room = memoryRoomOf(row);
    if (!rooms.has(room.key)) rooms.set(room.key, { ...room, rowCount: 0, inactiveCount: 0, tables: new Set(), lastUpdatedAt: 0 });
    const entry = rooms.get(room.key);
    entry.rowCount += 1;
    if (row?.is_active === false) entry.inactiveCount += 1;
    entry.tables.add(trim(row?.table_id));
    entry.lastUpdatedAt = Math.max(entry.lastUpdatedAt, toTime(row?.updated_at), toTime(row?.created_at));
  });
  return {
    templateId: current,
    totalRows,
    // 最近写入的在前；全局／动态排最后
    rooms: [...rooms.values()]
      .map(({ tables, ...room }) => ({ ...room, tableCount: tables.size }))
      .sort((a, b) => (a.kind === 'global') - (b.kind === 'global') || b.lastUpdatedAt - a.lastUpdatedAt),
    otherTemplates: [...otherTemplates].map(([id, rowCount]) => ({ templateId: id, rowCount })),
  };
};

/** 当前会话还没确认的记忆写入预览（最旧的时间用来提示搁置太久）。 */
export const summarizePendingMemoryPreviews = (pending = [], sessionId = '') => {
  const sid = trim(sessionId);
  const items = (Array.isArray(pending) ? pending : []).filter(item => trim(item?.toolName) === MEMORY_PREVIEW_TOOL
    && trim(item?.status || 'pending') === 'pending' && (!sid || trim(item?.sessionId) === sid));
  const times = items.map(item => toTime(item?.createdAt)).filter(Boolean);
  return { count: items.length, oldestAt: times.length ? Math.min(...times) : 0 };
};

/**
 * 当前会话：只用最近一次真实发送留下的注入计划（预览不会覆盖它），不另外拼请求。
 * injection.state：off（记忆没开表格模式）／no_send（启动后还没发过）／other_session（上次发送在别的会话）／disabled／ok。
 */
export const summarizeSessionMemory = ({ sessionId = '', isGroup = false, plan = null, storageMode = 'table', autoWrite = null, pending = [] } = {}) => {
  const sid = trim(sessionId);
  const room = sid ? { key: sid, kind: isGroup ? 'group' : (sid.startsWith('rp:') ? 'rp' : 'private'), sessionId: sid } : null;
  let injection;
  if (storageMode !== 'table') injection = { state: 'off', storageMode };
  else if (!plan) injection = { state: 'no_send' };
  else if (trim(plan.targetId) !== sid) injection = { state: 'other_session' };
  else if (plan.enabled === false) injection = { state: 'disabled', reason: trim(plan.reason) };
  else {
    const segments = Array.isArray(plan.audit?.segments) ? plan.audit.segments : [];
    const shared = segments.filter(segment => SHARED_SEGMENT_RE.test(trim(segment?.id)) && Number(segment?.rowCount) > 0)
      .map(segment => ({ id: trim(segment.id), label: trim(segment.label), rowCount: Number(segment.rowCount) || 0, trimmedCount: Number(segment.trimmedCount) || 0 }));
    injection = {
      state: 'ok',
      localRows: (Array.isArray(plan.items) ? plan.items.length : 0) + (Array.isArray(plan.recallItems) ? plan.recallItems.length : 0),
      sharedRows: shared.reduce((sum, item) => sum + item.rowCount, 0),
      trimmedRows: (Array.isArray(plan.truncated) ? plan.truncated.length : 0) + shared.reduce((sum, item) => sum + item.trimmedCount, 0),
      tokens: Number(plan.tokenTotal) || 0,
      shared,
    };
  }
  return {
    sessionId: sid,
    room,
    storageMode,
    injection,
    autoWrite: { enabled: autoWrite?.enabled === true, mode: trim(autoWrite?.mode) },
    pending: summarizePendingMemoryPreviews(pending, sid),
  };
};

/** 在总览里打开某个聊天室的表格：转成现有表格编辑器认的上下文。 */
export const memoryRoomEditorContext = (room) => {
  const key = trim(room?.key);
  if (room?.kind === 'group') return { type: 'group', groupId: key };
  if (room?.kind === 'rp') return { type: 'rp', contactId: key };
  if (room?.kind === 'private') return { type: 'contact', contactId: key };
  return { type: 'global' };
};
