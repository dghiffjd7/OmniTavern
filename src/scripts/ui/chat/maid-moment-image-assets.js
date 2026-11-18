// 女仆发附图动态：把图片存成动态附件（与动态页手动发图同一种 asset），或用当前图片配置现场生图。
// 依赖都由调用方注入（app.js 接线），本模块不直接碰 store 或 Tauri。

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const extOf = (mime = '') => {
  const sub = trim(mime).split('/')[1] || '';
  return sub === 'jpeg' ? 'jpg' : (sub.replace(/[^a-z0-9]/gi, '') || 'png');
};

/** images: [{ dataUrl, name?, mime? }] → 存成附件后回 { ok, assets }；任一张存失败即整体失败。 */
export const saveMaidMomentImages = async ({
  images = [],
  saveAttachment = null,
  sessionId = '',
  idPrefix = 'maid-moment',
} = {}) => {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return { ok: true, assets: [] };
  if (typeof saveAttachment !== 'function') {
    return { ok: false, reason: 'moment_image_save_unavailable', message: '动态配图保存通道未接入。' };
  }
  const assets = [];
  for (const [index, image] of list.entries()) {
    const id = `${idPrefix}-${index + 1}`;
    const mime = trim(image?.mime, trim(String(image?.dataUrl || '').match(/^data:([^;]+);/)?.[1], 'image/png'));
    const fileName = trim(image?.name, `${id}.${extOf(mime)}`);
    let saved = null;
    try {
      saved = await saveAttachment({ sessionId, dataUrl: String(image?.dataUrl || ''), fileName });
    } catch {
      saved = null;
    }
    const path = trim(saved?.path);
    if (!path) return { ok: false, reason: 'moment_image_save_failed', message: '动态配图保存失败。' };
    assets.push({ id, kind: 'image', source: 'maid', prompt: '', output: { path, mime } });
  }
  return { ok: true, assets };
};

/** 用当前图片配置与参数预设生成一张动态配图（与角色自动发动态的配图同一条路）。 */
export const generateMaidMomentImage = async ({
  prompt = '',
  signal = null,
  loadConfig = null,
  canUseConfig = () => false,
  loadPreset = null,
  mergeOptions = null,
  generateImage = null,
  sessionId = '',
  scope = {},
} = {}) => {
  const text = trim(prompt);
  if (!text) return { ok: false, reason: 'moment_image_prompt_empty', message: '配图提示词为空。' };
  const config = typeof loadConfig === 'function' ? await loadConfig() : null;
  if (!config || !canUseConfig(config)) {
    return { ok: false, reason: 'image_config_unavailable', message: '图片配置不可用，请先在设置里配置图片生成。' };
  }
  if (typeof generateImage !== 'function') {
    return { ok: false, reason: 'moment_image_generation_unavailable', message: '动态配图生成通道未接入。' };
  }
  const preset = typeof loadPreset === 'function' ? await loadPreset() : null;
  const options = typeof mergeOptions === 'function' ? mergeOptions({ config, preset }) : {};
  try {
    const asset = await generateImage({ prompt: text, config, sessionId, scope, options, signal });
    if (!trim(asset?.output?.path || asset?.output?.url || asset?.output?.dataUrl)) {
      return { ok: false, reason: 'moment_image_generation_failed', message: '配图生成没有产出图片。' };
    }
    return { ok: true, asset };
  } catch (error) {
    return { ok: false, reason: 'moment_image_generation_failed', message: `配图生成失败：${trim(error?.message, '未知错误')}` };
  }
};

export const MAID_KEPT_MOMENT_IMAGES_KEY = 'maid_kept_moment_images_v1';

/**
 * 动态没发出去时留下的配图。任务记录会截断长字串与深层资料，放不下完整的生成资讯，所以单独存：
 * 女仆只拿到 id，下一轮按 id 取回与当初一模一样的 asset；限本卡，文件已不在就算没有。
 * 不设数量上限：用户能在动态相册里查看和删除，记录要是自己掉了，那张图就再也找不到了。
 */
export const createMaidKeptMomentImages = ({
  loadKv = null,
  saveKv = null,
  canReadFile = async () => false,
  logger = console,
} = {}) => {
  let records = [];
  const ready = Promise.resolve()
    .then(() => loadKv?.(MAID_KEPT_MOMENT_IMAGES_KEY))
    .catch(() => null)
    .then((stored) => {
      if (Array.isArray(stored?.records)) records = stored.records;
    });
  const save = () => Promise.resolve()
    .then(() => saveKv?.(MAID_KEPT_MOMENT_IMAGES_KEY, { records }))
    .catch((error) => { logger?.warn?.('kept moment images could not be saved', error); });
  const assetIdOf = record => trim(record?.asset?.id);
  return {
    ready,
    /** 相册用（同步）：本卡留下的图，最新在前。 */
    list: ({ roleCardId = '' } = {}) => records
      .filter(record => record?.asset && record.roleCardId === trim(roleCardId))
      .map(record => record.asset)
      .reverse(),
    keep: async ({ assets = [], roleCardId = '' } = {}) => {
      await ready;
      const incoming = new Set(assets.map(asset => trim(asset?.id)));
      records = [
        ...records.filter(record => !incoming.has(assetIdOf(record))),
        ...assets.map(asset => ({ roleCardId: trim(roleCardId), asset })),
      ];
      await save();
    },
    /** 发出去或删除后调用；不是留下的图就什么都不做。 */
    remove: async ({ ids = [] } = {}) => {
      await ready;
      const targets = new Set(ids.map(id => trim(id)));
      const remaining = records.filter(record => !targets.has(assetIdOf(record)));
      if (remaining.length === records.length) return;
      records = remaining;
      await save();
    },
    load: async ({ attachmentId = '', roleCardId = '' } = {}) => {
      await ready;
      const id = trim(attachmentId);
      if (!id) return null;
      const record = records.find(item => assetIdOf(item) === id && item.roleCardId === trim(roleCardId));
      if (!record?.asset?.output?.path) return null;
      try {
        return await canReadFile(record.asset) ? record.asset : null;
      } catch {
        return null;
      }
    },
  };
};

/** 动态相册里的「未发布」卡片：按钮直接拿这张图发动态，不重画。 */
export const buildKeptMomentAlbumAssets = (assets = []) => assets.map(asset => ({
  ...asset,
  albumId: `kept::${trim(asset?.id)}`,
  keptMomentImage: true,
  albumBadge: '未发布',
  albumUseText: '发布动态',
}));
