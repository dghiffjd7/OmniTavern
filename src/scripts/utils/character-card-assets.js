// CCv3 资源（data.assets）分类：决定哪些导入、导入到哪里、哪些跳过及原因。
// 头像（icon）由导卡流程另行处理；表情（emotion／expression）→ 角色表情贴图包；第一张背景 → 角色创意写作会话背景。
// 远程资源（http／https）一律不静默下载，只列出。

export const CARD_ASSET_IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp']);
export const CARD_ASSET_LIMITS = Object.freeze({ maxAssets: 300, maxAssetBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });

const trim = value => String(value ?? '').trim();
const SPRITE_TYPES = new Set(['emotion', 'expression']);

const extOf = (asset = {}, path = '') => {
  const ext = trim(asset.ext).toLowerCase().replace(/^\./, '');
  if (ext) return ext;
  return (trim(path).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '');
};

// 资源来源：package（.charx 包内）、png_chunk（PNG 内嵌块）、data（data URL）、ccdefault、remote、unknown
export const resolveCardAssetSource = (uri = '', container = 'json') => {
  const text = trim(uri);
  const lower = text.toLowerCase();
  if (lower.startsWith('embeded://') || lower.startsWith('embedded://')) {
    return { source: container === 'charx' ? 'package' : 'missing_package', path: text.replace(/^embedd?ed:\/\//i, '').replace(/^\/+/, '') };
  }
  if (lower.startsWith('__asset:')) {
    const path = text.slice('__asset:'.length).replace(/^\/+/, '');
    return { source: container === 'charx' ? 'package' : container === 'png' ? 'png_chunk' : 'missing_package', path };
  }
  if (lower.startsWith('data:image/')) return { source: 'data', path: '' };
  if (lower.startsWith('ccdefault:')) return { source: 'ccdefault', path: '' };
  if (lower.startsWith('http://') || lower.startsWith('https://')) return { source: 'remote', path: '' };
  return { source: 'unknown', path: '' };
};

const LOADABLE_SOURCES = new Set(['package', 'png_chunk', 'data']);
const SKIP_REASON_BY_SOURCE = Object.freeze({
  remote: 'remote_not_downloaded',
  missing_package: 'not_embedded_in_file',
  ccdefault: 'default_asset',
  unknown: 'unsupported_uri',
});

// 规划：sprites（表情）、backgrounds（背景，只取第一张）、skipped（跳过的资源及原因）
export const planCardAssetImport = (card = {}, { container = 'json' } = {}) => {
  const assets = Array.isArray(card?.assets) ? card.assets : [];
  const sprites = [];
  const backgrounds = [];
  const skipped = [];
  assets.forEach((asset) => {
    if (!asset || typeof asset !== 'object') return;
    const type = trim(asset.type).toLowerCase();
    if (type === 'icon') return;
    const name = trim(asset.name) || type || 'asset';
    const { source, path } = resolveCardAssetSource(asset.uri, container);
    const ext = extOf(asset, path || asset.uri);
    const item = { type, name, uri: trim(asset.uri), source, path, ext };
    const role = SPRITE_TYPES.has(type) ? 'sprite' : type === 'background' ? 'background' : '';
    if (!role) {
      skipped.push({ type, name, reason: 'unsupported_asset_type' });
    } else if (!LOADABLE_SOURCES.has(source)) {
      skipped.push({ type, name, reason: SKIP_REASON_BY_SOURCE[source] || 'unsupported_uri' });
    } else if (source !== 'data' && !CARD_ASSET_IMAGE_EXTENSIONS.includes(ext)) {
      skipped.push({ type, name, reason: 'not_an_image' });
    } else if (role === 'background' && backgrounds.length) {
      skipped.push({ type, name, reason: 'extra_background' });
    } else if (sprites.length + backgrounds.length >= CARD_ASSET_LIMITS.maxAssets) {
      skipped.push({ type, name, reason: 'too_many_assets' });
    } else {
      (role === 'sprite' ? sprites : backgrounds).push(item);
    }
  });
  return { sprites, backgrounds, skipped };
};

// 合并各来源取到的图片：byPath（包内路径或 PNG 块 key → data URL）；data URL 资源直接使用
export const resolveCardAssetImages = (planned = {}, byPath = new Map()) => {
  const skipped = [...(planned.skipped || [])];
  let totalBytes = 0;
  const resolve = list => list.map((item) => {
    const dataUrl = item.source === 'data' ? item.uri : byPath.get(item.path);
    if (!dataUrl || !/^data:image\//i.test(dataUrl)) {
      skipped.push({ type: item.type, name: item.name, reason: 'missing_asset' });
      return null;
    }
    const bytes = Math.floor((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4);
    totalBytes += bytes;
    if (bytes > CARD_ASSET_LIMITS.maxAssetBytes || totalBytes > CARD_ASSET_LIMITS.maxTotalBytes) {
      skipped.push({ type: item.type, name: item.name, reason: 'asset_too_large' });
      return null;
    }
    return { type: item.type, name: item.name, dataUrl };
  }).filter(Boolean);
  return { sprites: resolve(planned.sprites || []), backgrounds: resolve(planned.backgrounds || []), skipped };
};

export const CARD_ASSET_SKIP_LABELS = Object.freeze({
  unsupported_asset_type: '暂不支持的资源类型',
  remote_not_downloaded: '远程资源（不自动下载）',
  not_embedded_in_file: '文件中没有附带',
  default_asset: '默认资源',
  unsupported_uri: '无法识别的资源地址',
  not_an_image: '不是图片',
  extra_background: '多余的背景（只导入第一张）',
  too_many_assets: '资源数量超出上限',
  missing_asset: '资源缺失',
  asset_too_large: '资源过大',
});
