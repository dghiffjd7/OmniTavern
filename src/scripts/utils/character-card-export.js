const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CHARACTER_TEXT_KEYWORDS = new Set(['chara', 'ccv3', 'character', 'chara_card_v2', 'card']);

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cloneJsonValue = (value, fallback) => {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
};

const textValue = value => (typeof value === 'string' ? value : '');
const stringArray = value => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);

export const sanitizeCharacterCardExportName = (value, fallback = 'character') => {
  const cleaned = String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/[.\s_]+$/g, '')
    .replace(/^\.+/g, '');
  return cleaned || String(fallback || 'character').trim() || 'character';
};

/**
 * Build a complete Tavern Card V2 object while retaining foreign fields from
 * the imported source card. OmniTavern currently edits only the display name
 * and optional description, so all other card data stays source-preserving.
 */
export const buildTavernV2CharacterCard = ({ persona = {}, rawCard = null } = {}) => {
  const raw = isRecord(rawCard) ? cloneJsonValue(rawCard, {}) : {};
  const rawData = isRecord(raw.data) ? raw.data : raw;
  const data = cloneJsonValue(rawData, {});
  const currentName = String(persona?.name || persona?.source?.characterName || data.name || raw.name || 'Character').trim()
    || 'Character';
  const currentDescription = String(persona?.description || '').trim();

  data.name = currentName;
  data.description = currentDescription || textValue(data.description || raw.description);
  data.personality = textValue(data.personality || raw.personality);
  data.scenario = textValue(data.scenario || raw.scenario);
  data.first_mes = textValue(data.first_mes || raw.first_mes);
  data.mes_example = textValue(data.mes_example || raw.mes_example);
  data.creator_notes = textValue(data.creator_notes || raw.creator_notes || raw.creatorcomment);
  data.system_prompt = textValue(data.system_prompt || raw.system_prompt);
  data.post_history_instructions = textValue(data.post_history_instructions || raw.post_history_instructions);
  data.alternate_greetings = stringArray(data.alternate_greetings || raw.alternate_greetings);
  data.tags = stringArray(data.tags || raw.tags);
  data.creator = textValue(data.creator || raw.creator);
  data.character_version = textValue(data.character_version || raw.character_version);
  data.extensions = isRecord(data.extensions)
    ? cloneJsonValue(data.extensions, {})
    : (isRecord(raw.extensions) ? cloneJsonValue(raw.extensions, {}) : {});
  if (data.character_book !== undefined && !isRecord(data.character_book)) {
    delete data.character_book;
  }

  const output = cloneJsonValue(raw, {});
  output.spec = 'chara_card_v2';
  output.spec_version = '2.0';
  output.data = data;

  // Keep the V1 mirrors used by older Tavern-compatible consumers.
  output.name = data.name;
  output.description = data.description;
  output.personality = data.personality;
  output.scenario = data.scenario;
  output.first_mes = data.first_mes;
  output.mes_example = data.mes_example;
  output.creatorcomment = data.creator_notes;
  output.tags = cloneJsonValue(data.tags, []);
  return output;
};

/**
 * CCv3 view of the same snapshot (as SillyTavern writes it): only spec/spec_version
 * change, plus the V3 fields the spec requires. Both PNG chunks therefore carry the
 * same content and cannot drift apart.
 */
export const buildCharacterCardV3 = (v2Card = {}, { assets = null } = {}) => {
  const output = cloneJsonValue(v2Card, {});
  output.spec = 'chara_card_v3';
  output.spec_version = '3.0';
  const data = isRecord(output.data) ? output.data : {};
  data.group_only_greetings = stringArray(data.group_only_greetings);
  if (Array.isArray(assets)) data.assets = cloneJsonValue(assets, []);
  else if (!Array.isArray(data.assets)) data.assets = [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }];
  output.data = data;
  return output;
};

const toPngBytes = (input) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input?.bytes instanceof Uint8Array) return input.bytes;
  if (input?.buffer instanceof ArrayBuffer) return new Uint8Array(input.buffer);
  return new Uint8Array(0);
};

const hasPngSignature = (bytes) => {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
};

const readUint32 = (bytes, offset) => (
  (((bytes[offset] << 24) >>> 0)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]) >>> 0
);

const writeUint32 = (target, offset, value) => {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
};

let crcTable = null;
const getCrcTable = () => {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  return crcTable;
};

const crc32 = (bytes) => {
  const table = getCrcTable();
  let crc = 0xffffffff;
  bytes.forEach((value) => {
    crc = table[(crc ^ value) & 0xff] ^ (crc >>> 8);
  });
  return (crc ^ 0xffffffff) >>> 0;
};

const ascii = value => new TextEncoder().encode(value);

const buildPngChunk = (type, data) => {
  const typeBytes = ascii(type);
  const payload = data instanceof Uint8Array ? data : new Uint8Array(data || 0);
  const chunk = new Uint8Array(12 + payload.length);
  writeUint32(chunk, 0, payload.length);
  chunk.set(typeBytes, 4);
  chunk.set(payload, 8);
  const crcInput = new Uint8Array(typeBytes.length + payload.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(payload, typeBytes.length);
  writeUint32(chunk, 8 + payload.length, crc32(crcInput));
  return chunk;
};

const readTextKeyword = (type, data) => {
  if (!['tEXt', 'iTXt', 'zTXt'].includes(type)) return '';
  const zero = data.indexOf(0);
  if (zero <= 0) return '';
  return new TextDecoder('utf-8').decode(data.slice(0, zero)).trim().toLowerCase();
};

const utf8ToBase64 = (text) => {
  const bytes = new TextEncoder().encode(String(text || ''));
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
};

const joinBytes = (parts) => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    result.set(part, offset);
    offset += part.length;
  });
  return result;
};

/**
 * Embed a Tavern Card V2 JSON payload in the standard PNG `chara` tEXt chunk.
 * With v3Card, also write the authoritative CCv3 `ccv3` chunk (readers prefer it).
 */
export const embedTavernV2CharacterCardInPng = (pngInput, card, { v3Card = null } = {}) => {
  const bytes = toPngBytes(pngInput);
  if (!hasPngSignature(bytes)) throw new Error('PNG image data is invalid');

  const kept = [];
  let removedCharacterChunkCount = 0;
  let foundIend = false;
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG chunk data is truncated');
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const data = bytes.slice(offset + 8, offset + 8 + length);
    const rawChunk = bytes.slice(offset, end);
    const keyword = readTextKeyword(type, data);
    if (CHARACTER_TEXT_KEYWORDS.has(keyword)) {
      removedCharacterChunkCount += 1;
    } else if (type === 'IEND') {
      const encoded = utf8ToBase64(JSON.stringify(card || {}));
      kept.push(buildPngChunk('tEXt', new TextEncoder().encode(`chara\0${encoded}`)));
      if (v3Card) {
        kept.push(buildPngChunk('tEXt', new TextEncoder().encode(`ccv3\0${utf8ToBase64(JSON.stringify(v3Card))}`)));
      }
      kept.push(rawChunk);
      foundIend = true;
    } else {
      kept.push(rawChunk);
    }
    offset = end;
    if (type === 'IEND') break;
  }
  if (!foundIend) throw new Error('PNG image is missing IEND');

  const output = joinBytes([PNG_SIGNATURE, ...kept]);
  const buffer = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength);
  return {
    bytes: output,
    buffer,
    keywordCount: v3Card ? 2 : 1,
    removedCharacterChunkCount,
  };
};
