// 角色卡附带资源的写入（导入服务通过依赖注入调用；失败时由导入服务调用对应的撤销）：
// 表情 → 绑定到该角色创意写作会话的贴图包；背景 → 该会话的聊天背景；.charx 原始包 → 角色卡旁另存（导出 .charx 时写回）。
import { t } from '../i18n/index.js';

const trim = value => String(value ?? '').trim();

export const createCharacterCardAssetWriter = ({
  stickerPackStore,
  saveStickerAsset,
  deleteStickerAsset = async () => {},
  compressSticker = async dataUrl => dataUrl,
  chatStore,
  saveWallpaper,
  deleteWallpaper = async () => {},
  saveOriginalCharxFile = null,
  getRpSessionId,
  createId = prefix => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
  now = () => Date.now(),
} = {}) => ({
  async createExpressionPack({ personaId, displayName, images = [] } = {}) {
    const sessionId = getRpSessionId(personaId);
    const stickers = [];
    const paths = [];
    try {
      for (const image of images) {
        let dataUrl = image.dataUrl;
        try { dataUrl = await compressSticker(dataUrl); } catch {}
        const path = trim(await saveStickerAsset(dataUrl, image.name || 'expression'));
        if (path) paths.push(path);
        stickers.push({ id: createId('sticker'), name: trim(image.name), keyword: trim(image.name), path, dataUrl: path ? '' : dataUrl });
      }
    } catch (error) {
      // 半途失败：删掉已写出的文件再抛出，交给导入服务整体回滚
      for (const path of paths) { try { await deleteStickerAsset(path); } catch {} }
      throw error;
    }
    const packId = createId('pack');
    stickerPackStore.upsertPack({ id: packId, name: t('{name}·表情', { name: trim(displayName) }), boundSessions: [sessionId], stickers });
    return { packId, paths, count: stickers.length, sessionId };
  },

  async removeExpressionPack(created = {}) {
    if (created.packId) stickerPackStore.removePack(created.packId);
    for (const path of created.paths || []) {
      try { await deleteStickerAsset(path); } catch {}
    }
  },

  async setRoleBackground({ personaId, image } = {}) {
    const sessionId = getRpSessionId(personaId);
    const previous = chatStore.getSessionSettings(sessionId);
    const saved = await saveWallpaper({ sessionId, dataUrl: image.dataUrl, fileName: trim(image.name) || 'background' });
    const path = trim(saved?.path);
    if (!path) throw new Error('wallpaper_save_failed');
    chatStore.setSessionSettings(sessionId, {
      ...(previous || {}),
      wallpaper: { path, name: trim(image.name), zoom: 1, rotate: 0, offsetX: 0, offsetY: 0, width: 0, height: 0, opacity: 1, updatedAt: now() },
    });
    return { sessionId, path, previous: previous ? JSON.parse(JSON.stringify(previous)) : null };
  },

  async restoreRoleBackground(created = {}) {
    if (!created.sessionId) return;
    chatStore.setSessionSettings(created.sessionId, created.previous);
    try { await deleteWallpaper({ sessionId: created.sessionId, path: created.path }); } catch {}
  },

  // 原始 .charx 与角色卡 sidecar 放在一起，删除角色卡时一并删除
  async saveOriginalCharx(personaId, bytes) {
    if (typeof saveOriginalCharxFile !== 'function') return false;
    await saveOriginalCharxFile(personaId, bytes);
    return true;
  },
});
