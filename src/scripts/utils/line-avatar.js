/**
 * LINE-style default avatar generator
 * - Colored background + first character
 * - Color scheme derived from character tags (or fallback)
 */

import { parseNameBadge } from './name-badges.js';
import { getDefaultAppIcon } from './default-icon.js';

const getFeatherDefault = () => getDefaultAppIcon();

const TAG_COLOR_SCHEMES = {
  // Gender / vibe
  女性: ['#FFB6C1', '#DDA0DD', '#FF69B4', '#FFC0CB'],
  男性: ['#4A90D9', '#5DADE2', '#45B7D1', '#3498DB'],

  // Types
  战斗: ['#E74C3C', '#C0392B', '#FF6B6B', '#D35400'],
  恋爱: ['#FF69B4', '#FFB6C1', '#FFC0CB', '#FF1493'],
  悬疑: ['#2C3E50', '#34495E', '#5D6D7E', '#707B7C'],
  搞笑: ['#F39C12', '#FFEAA7', '#F7DC6F', '#FFC312'],

  // Fallback
  default: ['#95A5A6', '#BDC3C7', '#AAB7B8', '#D5DBDB'],
};

const COLOR_TAG_PRIORITY = ['女性', '男性'];

// 群聊里对不上任何联系人的发言者（例如剧情里临时出现的角色）：彩色底色，和没打标签的联系人（灰色）区分
const STRANGER_COLOR_SCHEME = ['#E57373', '#F06292', '#BA68C8', '#9575CD', '#7986CB', '#64B5F6', '#4DB6AC', '#81C784', '#FFB74D', '#FF8A65'];

const cache = new Map();

const normalizeTags = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean);

const hashString = (value) => {
  const str = String(value || '');
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
};

const pickColorScheme = (tags) => {
  const list = normalizeTags(tags);
  if (!list.length) return TAG_COLOR_SCHEMES.default;
  const genderTag = COLOR_TAG_PRIORITY.find((t) => list.includes(t));
  if (genderTag && TAG_COLOR_SCHEMES[genderTag]) return TAG_COLOR_SCHEMES[genderTag];
  const typed = list.find((t) => TAG_COLOR_SCHEMES[t]);
  if (typed) return TAG_COLOR_SCHEMES[typed];
  return TAG_COLOR_SCHEMES.default;
};

const pickInitial = (name) => {
  const raw = String(name || '').trim();
  if (!raw) return '?';
  const base = parseNameBadge(raw).baseName || raw;
  const first = Array.from(base)[0] || '?';
  if (/^[a-z]$/i.test(first)) return first.toUpperCase();
  return first;
};

const canUseCanvas = () => {
  try {
    return typeof document !== 'undefined' && !!document.createElement;
  } catch {
    return false;
  }
};

const buildAvatarDataUrl = ({ name, tags, size = 96, palette = '' }) => {
  if (!canUseCanvas()) return '';
  const scheme = palette === 'stranger' ? STRANGER_COLOR_SCHEME : pickColorScheme(tags);
  const idx = hashString(name) % scheme.length;
  const background = scheme[idx] || scheme[0] || TAG_COLOR_SCHEMES.default[0];
  const text = pickInitial(name);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  // Background
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);

  // Text
  ctx.fillStyle = '#ffffff';
  const fontSize = Math.max(28, Math.floor(size * 0.52));
  ctx.font = `700 ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, \"PingFang SC\", \"Microsoft YaHei\", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 1);

  return canvas.toDataURL('image/png');
};

export const getLineAvatarDataUrl = ({ name = '', tags = [], size = 96, palette = '' } = {}) => {
  const keyName = String(name || '').trim();
  if (!keyName) return '';
  const keyTags = normalizeTags(tags).join('|');
  const cacheKey = `${keyName}__${keyTags}__${size}__${palette}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey) || '';
  const url = buildAvatarDataUrl({ name: keyName, tags, size, palette });
  cache.set(cacheKey, url);
  return url;
};

export const isDefaultAvatar = (avatar) => {
  const raw = String(avatar || '').trim();
  if (!raw) return true;
  return raw.includes('feather-default') || raw.includes('app-icon-dark') || raw.includes('app-icon-light');
};

export const resolveLineAvatar = ({ avatar = '', name = '', tags = [], size = 96, palette = '' } = {}) => {
  const raw = String(avatar || '').trim();
  if (raw && !isDefaultAvatar(raw)) return raw;
  const generated = getLineAvatarDataUrl({ name, tags, size, palette });
  return generated || raw || getFeatherDefault();
};

const FEATHER_DEFAULT = getFeatherDefault();
export { FEATHER_DEFAULT, TAG_COLOR_SCHEMES, STRANGER_COLOR_SCHEME };

