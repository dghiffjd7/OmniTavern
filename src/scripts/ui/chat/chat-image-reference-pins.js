// 聊天参考图：固定在聊天上的参考图（例如角色三视图），这个聊天之后的生图（手动与自动配图）都自动带上。
// 存在会话资料 session.pinnedImageReferences（与 imageReferenceLibrary 相同）；图片文件由 imageGenerationReferenceStore
// 存进会话附件并按内容去重。读不到的那张跳过，不中断生成。

export const CHAT_IMAGE_REFERENCE_PIN_LIMIT = 8;

const keyOf = item => String(item?.path || '').trim();

export const createChatImageReferencePins = ({
  getSession = () => null,
  saveSessions = () => {},
  referenceStore = null,
  logger = console,
} = {}) => {
  const list = sessionId => (getSession(sessionId)?.pinnedImageReferences || [])
    .filter(item => keyOf(item))
    .map(item => ({ ...item }));

  /** 固定一张参考图（{ dataUrl, name }）：存成会话附件后记进会话；同一张图不重复。返回的 item 带 key（＝path，与 load 相同，取消固定用它）。 */
  const pin = async (sessionId, reference = {}) => {
    const session = getSession(sessionId);
    if (!session) return { ok: false, reason: 'no_session' };
    const items = list(sessionId);
    if (items.length >= CHAT_IMAGE_REFERENCE_PIN_LIMIT) return { ok: false, reason: 'limit' };
    const [stored] = await referenceStore.persist([{ dataUrl: reference.dataUrl, name: reference.name || '' }], sessionId);
    if (!keyOf(stored)) return { ok: false, reason: 'persist_failed' };
    // 等待存档期间会话可能已换掉或删掉
    if (getSession(sessionId) !== session) return { ok: false, reason: 'no_session' };
    const existing = list(sessionId).find(item => (stored.hash && item.hash === stored.hash) || keyOf(item) === keyOf(stored));
    if (existing) return { ok: true, item: { ...existing, key: keyOf(existing) }, duplicate: true };
    const item = {
      path: keyOf(stored),
      sessionId: String(stored.sessionId || sessionId),
      hash: String(stored.hash || ''),
      mime: String(stored.mime || ''),
      bytes: Number(stored.bytes) || 0,
      name: String(reference.name || stored.name || ''),
    };
    session.pinnedImageReferences = [...list(sessionId), item];
    saveSessions();
    return { ok: true, item: { ...item, key: item.path } };
  };

  const unpin = (sessionId, path) => {
    const session = getSession(sessionId);
    if (!session) return false;
    const items = list(sessionId);
    const next = items.filter(item => keyOf(item) !== String(path || '').trim());
    if (next.length === items.length) return false;
    session.pinnedImageReferences = next;
    saveSessions();
    return true;
  };

  /** 读出图片（{ key, dataUrl, name, mime }）；max 限制张数；读不到的跳过并记在 missing。 */
  const load = async (sessionId, { max = CHAT_IMAGE_REFERENCE_PIN_LIMIT } = {}) => {
    const items = [];
    const missing = [];
    for (const item of list(sessionId)) {
      if (items.length >= max) break;
      try {
        const [loaded] = await referenceStore.load([item], sessionId);
        if (loaded?.dataUrl) items.push({ key: keyOf(item), dataUrl: loaded.dataUrl, name: item.name || '', mime: loaded.mime || item.mime || '' });
      } catch (error) {
        missing.push(keyOf(item));
        logger?.warn?.('pinned image reference unavailable; skipped', error);
      }
    }
    return { items, missing };
  };

  return { list, pin, unpin, load };
};

/** 本聊天参考图排在前、本次参考图在后，去掉重复，合计不超过 max。 */
export const mergeChatReferenceImages = (pinned = [], manual = [], max = 0) => {
  const limit = Math.max(0, Math.trunc(Number(max) || 0));
  const seen = new Set();
  const out = [];
  for (const item of [...pinned, ...manual]) {
    const dataUrl = String(item?.dataUrl || '');
    if (!dataUrl || seen.has(dataUrl) || out.length >= limit) continue;
    seen.add(dataUrl);
    out.push({ dataUrl, name: String(item?.name || ''), ...(item?.mime ? { mime: item.mime } : {}) });
  }
  return out;
};
