import { stickerPackStore } from '../../storage/sticker-pack-store.js';
import { safeInvoke } from '../../utils/tauri.js';
import { reactionDataUrlFromFile, isReactionImageBytes } from '../../utils/image.js';
import { t } from '../../i18n/index.js';

export const CUSTOM_REACTION_LIMIT = 60;
export const isCustomReaction = value => /^custom:[a-f0-9]{64}$/.test(String(value || ''));
const assetId = value => isCustomReaction(value) ? value.slice(7) : '';
const native = () => globalThis.__TAURI__ || globalThis.__TAURI_INTERNALS__ || globalThis.__TAURI_INVOKE__;
const cleanName = value => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40) || '自定义反应';

const digestImage = async dataUrl => {
  if (!/^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl)) throw new Error('反应素材格式无效');
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0));
  if (!isReactionImageBytes(bytes)) throw new Error('反应素材格式无效');
  if (bytes.length > 30 * 1024) throw new Error('反应素材超过 30KB');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
};

const persistImage = async (dataUrl, id) => {
  if (!native()) return { path: '', dataUrl };
  const ext = dataUrl.startsWith('data:image/webp') ? 'webp' : dataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png';
  const result = await safeInvoke('save_attachment', { sessionId: 'sticker_pack_assets', fileName: `reaction-${id}.${ext}`, dataUrl });
  if (!result?.path) throw new Error('反应素材保存失败');
  return { path: result.path, dataUrl: '' };
};

export const createCustomReactionAssets = ({ store = stickerPackStore, saveImage = persistImage,
  removeImage = path => native() ? safeInvoke('delete_attachment', { sessionId: 'sticker_pack_assets', path }) : null } = {}) => {
  const list = () => [...new Map(store.getReactionPacks().flatMap(pack => pack.stickers || [])
    .filter(item => /^[a-f0-9]{64}$/.test(item.id)).map(item => [item.id, { ...item, emoji: `custom:${item.id}` }])).values()];
  const find = emoji => list().find(item => item.id === assetId(emoji)) || null;
  let tail = Promise.resolve();
  const serialize = action => {
    const pending = tail.then(action);
    tail = pending.catch(() => {});
    return pending;
  };
  const put = async (dataUrl, name, expectedId = '') => {
    const id = await digestImage(dataUrl);
    if (expectedId && expectedId !== id) throw new Error('反应素材与记录不匹配');
    const existing = find(`custom:${id}`);
    if (existing) return existing;
    if (list().length >= CUSTOM_REACTION_LIMIT) throw new Error('最多保存 60 个自定义反应，请先移除不再使用的图片');
    const image = await saveImage(dataUrl, id);
    // Content IDs are independent of pack IDs, so importing a renamed pack cannot break message references.
    const idBase = `reaction-${id}`;
    let packId = idBase, suffix = 1;
    while (store.getPack(packId)) packId = `${idBase}-${suffix++}`;
    store.upsertPack({ id: packId, name: cleanName(name), kind: 'reaction', aiEnabled: false,
      stickers: [{ id, name: cleanName(name), ...image }] });
    return find(`custom:${id}`);
  };
  return {
    list, find,
    addFile: file => serialize(async () => put(await reactionDataUrlFromFile(file), file.name?.replace(/\.[^.]+$/, ''))),
    addDataUrl: (dataUrl, name) => serialize(() => put(dataUrl, name)),
    remove: emoji => serialize(async () => {
      const id = assetId(emoji);
      const paths = new Set();
      for (const pack of store.getReactionPacks()) {
        if (!pack.stickers.some(item => item.id === id)) continue;
        pack.stickers.filter(item => item.id === id && item.path).forEach(item => paths.add(item.path));
        const remaining = pack.stickers.filter(item => item.id !== id);
        if (remaining.length) store.updatePack(pack.id, { stickers: remaining });
        else store.removePack(pack.id);
      }
      for (const path of paths) await removeImage(path);
    }),
    collect: (messages, assets, basePath = 'reactions') => {
      const ids = new Set((messages || []).flatMap(message => (message?.meta?.reactions || []).map(entry => entry.emoji)));
      return list().filter(item => ids.has(item.emoji)).map(item => {
        const source = item.path || item.dataUrl;
        const ext = /webp/i.test(source.slice(0, 100)) || /\.webp$/i.test(source) ? 'webp' : /jpe?g/i.test(source.slice(0, 100)) || /\.jpe?g$/i.test(source) ? 'jpg' : 'png';
        return { id: item.id, name: item.name, assetFile: assets.addSource(`${basePath}/${item.id}.${ext}`, source) };
      }).filter(item => item.assetFile);
    },
    import: (records, readAsset) => serialize(async () => {
      const failed = [];
      for (const record of (Array.isArray(records) ? records : []).slice(0, CUSTOM_REACTION_LIMIT)) {
        try {
          if (!/^[a-f0-9]{64}$/.test(record?.id || '')) throw new Error('反应素材 ID 无效');
          await put(await readAsset(record.assetFile), record.name, record.id);
        } catch (error) { failed.push({ id: record?.id, message: error.message }); }
      }
      return { failed };
    }),
  };
};

export const customReactionAssets = createCustomReactionAssets();
export const customReactionImportWarning = result => result?.failed?.length
  ? t('有 {count} 个反应素材未导入，消息保留名称。原因：{reason}', { count: result.failed.length, reason: t(result.failed[0].message) }) : '';
export const customReactionImageSource = asset => {
  if (asset?.dataUrl) return asset.dataUrl;
  const path = asset?.path;
  if (!path) return '';
  const convert = globalThis.__TAURI__?.core?.convertFileSrc || globalThis.__TAURI__?.convertFileSrc || globalThis.__TAURI_INTERNALS__?.convertFileSrc;
  return convert ? convert(path) : path;
};
