import { safeInvoke } from './tauri.js';
import { CARD_ASSET_LIMITS, planCardAssetImport, resolveCardAssetImages } from './character-card-assets.js';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const readFileAsArrayBuffer = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result || new ArrayBuffer(0));
  reader.onerror = () => reject(reader.error || new Error('读取失败'));
  reader.readAsArrayBuffer(file);
});

const readFileAsText = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('读取失败'));
  reader.readAsText(file);
});

const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('读取失败'));
  reader.readAsDataURL(file);
});

const ensureArray = (val) => Array.isArray(val) ? val : (val ? [val] : []);

const safeJsonParse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isLikelyBase64 = (text) => {
  const raw = String(text || '').trim();
  if (!raw || raw.length < 16) return false;
  if (raw.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(raw);
};

const decodeBase64Text = (text) => {
  const raw = String(text || '').trim();
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
};

const parseCardText = (text) => {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    return safeJsonParse(raw);
  }
  if (isLikelyBase64(raw)) {
    const decoded = decodeBase64Text(raw).trim();
    if (decoded.startsWith('{') || decoded.startsWith('[')) {
      return safeJsonParse(decoded);
    }
  }
  const decodedUri = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return '';
    }
  })();
  if (decodedUri && (decodedUri.startsWith('{') || decodedUri.startsWith('['))) {
    return safeJsonParse(decodedUri);
  }
  return null;
};

const readPngTextChunks = (buffer) => {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  if (bytes.length < PNG_SIGNATURE.length) return chunks;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return chunks;
  }
  const view = new DataView(buffer);
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    const data = bytes.slice(dataStart, dataEnd);
    chunks.push({ type, data });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
};

const parseTextChunk = (type, data) => {
  const decoder = new TextDecoder('utf-8');
  if (type === 'tEXt') {
    const zeroIdx = data.indexOf(0);
    if (zeroIdx <= 0) return null;
    const keyword = decoder.decode(data.slice(0, zeroIdx));
    const text = decoder.decode(data.slice(zeroIdx + 1));
    return { keyword, text };
  }
  if (type === 'iTXt') {
    let offset = 0;
    const readZero = () => {
      const idx = data.indexOf(0, offset);
      if (idx === -1) return null;
      const part = data.slice(offset, idx);
      offset = idx + 1;
      return part;
    };
    const keywordBytes = readZero();
    if (!keywordBytes) return null;
    const keyword = decoder.decode(keywordBytes);
    const compressionFlag = data[offset];
    offset += 1;
    offset += 1; // compression method
    const languageTag = readZero();
    if (languageTag === null) return null;
    const translatedKeyword = readZero();
    if (translatedKeyword === null) return null;
    if (compressionFlag !== 0) return null;
    const text = decoder.decode(data.slice(offset));
    return { keyword, text };
  }
  return null;
};

// 读取 PNG 中的角色卡数据：CCv3 的权威 keyword 是 ccv3，同时存在时优先于 chara（V2 兼容副本）。
// 返回 { json, keyword, keywords }；keywords 为图片里出现过的角色卡 keyword。
export const extractCharacterCardFromPng = (buffer) => {
  const chunks = readPngTextChunks(buffer);
  if (!chunks.length) return null;
  const byKeyword = new Map();
  chunks.forEach(({ type, data }) => {
    const parsed = parseTextChunk(type, data);
    if (!parsed) return;
    const keyword = String(parsed.keyword || '').trim().toLowerCase();
    if (!keyword || byKeyword.has(keyword)) return;
    byKeyword.set(keyword, parsed.text);
  });
  const keywords = ['ccv3', 'chara', 'character', 'chara_card_v2', 'card'].filter(keyword => byKeyword.has(keyword));
  for (const keyword of keywords) {
    const parsed = parseCardText(byKeyword.get(keyword));
    if (parsed) return { json: parsed, keyword, keywords };
  }
  // Fallback: try any text chunk
  for (const [keyword, text] of byKeyword) {
    const candidate = parseCardText(text);
    if (candidate) return { json: candidate, keyword, keywords };
  }
  return null;
};

export const extractCharacterCardJsonFromPng = buffer => extractCharacterCardFromPng(buffer)?.json || null;

const IMAGE_MIME_BY_EXT = Object.freeze({ png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' });

// 按文件头判断图片类型，识别不了再看扩展名
const sniffImageMime = (bytes, ext = '') => {
  const b = bytes || [];
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return IMAGE_MIME_BY_EXT[String(ext || '').toLowerCase()] || '';
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

// CCv3 PNG 内嵌资源块：tEXt keyword 为 chara-ext-asset_:<key>（兼容 chara-ext-asset_<key>），内容为 Base64。
// items：需要的资源 { path, ext }；按数量、单个与总体积上限读取，返回 path → data URL
export const extractPngEmbeddedAssets = (buffer, items = []) => {
  const wanted = new Map((items || []).filter(item => item?.path).map(item => [String(item.path), item]));
  const out = new Map();
  if (!wanted.size) return out;
  let total = 0;
  for (const { type, data } of readPngTextChunks(buffer)) {
    const parsed = parseTextChunk(type, data);
    const keyword = String(parsed?.keyword || '');
    const key = keyword.startsWith('chara-ext-asset_:') ? keyword.slice('chara-ext-asset_:'.length)
      : keyword.startsWith('chara-ext-asset_') ? keyword.slice('chara-ext-asset_'.length) : '';
    const item = key ? wanted.get(key) : null;
    if (!item || out.has(key)) continue;
    let bytes;
    try {
      bytes = Uint8Array.from(atob(String(parsed.text || '').trim()), c => c.charCodeAt(0));
    } catch {
      continue;
    }
    total += bytes.length;
    if (bytes.length > CARD_ASSET_LIMITS.maxAssetBytes || total > CARD_ASSET_LIMITS.maxTotalBytes) break;
    const mime = sniffImageMime(bytes, item.ext);
    if (mime) out.set(key, `data:${mime};base64,${bytesToBase64(bytes)}`);
  }
  return out;
};

const pickText = (...values) => {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
};

export const normalizeCharacterCard = (input = {}) => {
  const raw = (input && typeof input === 'object') ? input : {};
  const spec = String(raw.spec || raw.format || '').trim().toLowerCase();
  const isV3 = spec.includes('chara_card_v3');
  const hasV2 = isV3 || Boolean(raw.data) || spec.includes('chara_card_v2') || spec.includes('chub');
  const data = hasV2 ? (raw.data && typeof raw.data === 'object' ? raw.data : {}) : raw;
  const format = isV3 ? 'ccv3' : hasV2 ? 'tavern_v2' : 'tavern_v1';
  return {
    format,
    name: pickText(data.name, raw.name),
    description: pickText(data.description, raw.description),
    personality: pickText(data.personality, raw.personality),
    scenario: pickText(data.scenario, raw.scenario),
    first_mes: pickText(data.first_mes, raw.first_mes),
    mes_example: pickText(data.mes_example, raw.mes_example),
    system_prompt: pickText(data.system_prompt, raw.system_prompt),
    post_history_instructions: pickText(data.post_history_instructions, raw.post_history_instructions),
    creator_notes: pickText(data.creator_notes, raw.creator_notes),
    alternate_greetings: ensureArray(data.alternate_greetings || raw.alternate_greetings).map(String).filter(Boolean),
    character_book: data.character_book || raw.character_book || null,
    extensions: data.extensions || raw.extensions || {},
    // CCv3 字段（V2 卡为空）：原始 JSON 另存 sidecar 保真；这里只把需要用到的字段取出来
    ...(isV3 ? {
      specVersion: String(raw.spec_version || '').trim(),
      nickname: pickText(data.nickname),
      creator_notes_multilingual: data.creator_notes_multilingual && typeof data.creator_notes_multilingual === 'object' ? data.creator_notes_multilingual : null,
      group_only_greetings: ensureArray(data.group_only_greetings).map(String).filter(Boolean),
      source: ensureArray(data.source).map(String).filter(Boolean),
      assets: Array.isArray(data.assets) ? data.assets.filter(item => item && typeof item === 'object') : [],
      creation_date: Number(data.creation_date) || null,
      modification_date: Number(data.modification_date) || null,
    } : {}),
    raw,
  };
};

// 卡内正则（extensions 里的几种写法）；导卡器与附件识别共用
export const extractCharacterCardRegexScripts = (card = {}) => {
  const ext = card?.extensions && typeof card.extensions === 'object' ? card.extensions : {};
  const list = [];
  const push = (val) => {
    if (Array.isArray(val)) {
      val.forEach(item => {
        if (item && typeof item === 'object') list.push(item);
      });
    }
  };
  push(ext.regex_scripts);
  push(ext.regexScripts);
  push(ext.regex);
  push(ext.regexes);
  return list;
};

// 原生侧解包错误码 → 用户提示（CCv3 与 charx 兼容计划 §3.5 的冻结文案）
const describeCharxError = (error) => {
  const code = String(error?.message || error || '');
  if (code.startsWith('charx_missing_card_json')) return '无效的 .charx：根目录缺少 card.json。';
  if (code.startsWith('charx_card_json_invalid')) return `无效的 CCv3 角色数据：${code.split(':').slice(1).join(':').trim() || 'card.json 解析失败'}`;
  if (code.startsWith('charx_encrypted')) return '暂不支持加密的 .charx 文件。';
  if (/^charx_(unsafe_path|symlink|duplicate_path)/.test(code)) return '此 .charx 包含不安全的资源路径，已拒绝导入。';
  if (/^charx_(too_large|too_many_entries|entry_too_large)/.test(code)) return '此 .charx 资源过大，已停止导入。';
  if (code.startsWith('charx_invalid_zip') || code.startsWith('charx_empty')) return '无效的 .charx：不是有效的 ZIP 文件。';
  return code || '读取 .charx 失败';
};

// .charx（CCv3 ZIP 容器）：在原生侧安全解包，取根目录 card.json 与头像（icon 资源）；其余资源只返回清单
export const readCharxCard = async (bytes, { invoke = safeInvoke, assetPaths = [] } = {}) => {
  let result;
  try {
    result = await invoke('read_charx', {
      bytes: Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0)),
      ...(assetPaths.length ? { assetPaths } : {}),
    });
  } catch (error) {
    throw new Error(describeCharxError(error));
  }
  const json = safeJsonParse(String(result?.cardText || '').replace(/^\uFEFF/, ''));
  if (!json) throw new Error('无效的 CCv3 角色数据：card.json 解析失败');
  const icon = result?.icon?.base64 && result?.icon?.mime ? `data:${result.icon.mime};base64,${result.icon.base64}` : '';
  const assets = new Map((Array.isArray(result?.assets) ? result.assets : [])
    .filter(item => item?.path && item?.base64 && item?.mime)
    .map(item => [String(item.path), `data:${item.mime};base64,${item.base64}`]));
  return { json, avatarDataUrl: icon, entries: Array.isArray(result?.entries) ? result.entries : [], assets };
};

// 取出卡内可导入的表情／背景图片：.charx 走原生解包，PNG 读内嵌资源块，data URL 直接用
export const loadCharacterCardAssets = async (card, { container = 'json', pngBuffer = null, charxBytes = null, invoke = safeInvoke } = {}) => {
  const planned = planCardAssetImport(card, { container });
  const needed = [...planned.sprites, ...planned.backgrounds].filter(item => item.source !== 'data');
  let byPath = new Map();
  if (needed.length && container === 'charx' && charxBytes) {
    byPath = (await readCharxCard(charxBytes, { invoke, assetPaths: needed.map(item => item.path) })).assets;
  } else if (needed.length && container === 'png' && pngBuffer) {
    byPath = extractPngEmbeddedAssets(pngBuffer, needed);
  }
  return resolveCardAssetImages(planned, byPath);
};

export const parseCharacterCardFile = async (file) => {
  if (!file) throw new Error('未选择文件');
  const name = String(file.name || '').toLowerCase();
  if (name.endsWith('.json')) {
    const text = await readFileAsText(file);
    const json = safeJsonParse(text);
    if (!json) throw new Error('JSON 解析失败');
    const card = normalizeCharacterCard(json);
    const assets = await loadCharacterCardAssets(card, { container: 'json' });
    return { card, raw: json, avatarDataUrl: '', assets };
  }
  if (name.endsWith('.png')) {
    const [buffer, avatarDataUrl] = await Promise.all([
      readFileAsArrayBuffer(file),
      readFileAsDataUrl(file),
    ]);
    const json = extractCharacterCardJsonFromPng(buffer);
    if (!json) throw new Error('未找到角色卡数据');
    const card = normalizeCharacterCard(json);
    const assets = await loadCharacterCardAssets(card, { container: 'png', pngBuffer: buffer });
    return { card, raw: json, avatarDataUrl, assets };
  }
  if (name.endsWith('.charx')) {
    const charxBytes = new Uint8Array(await readFileAsArrayBuffer(file));
    const { json, avatarDataUrl } = await readCharxCard(charxBytes);
    const card = normalizeCharacterCard(json);
    const assets = await loadCharacterCardAssets(card, { container: 'charx', charxBytes });
    return { card, raw: json, avatarDataUrl, assets, charxBytes };
  }
  throw new Error('仅支持 PNG、JSON 或 .charx 角色卡');
};
