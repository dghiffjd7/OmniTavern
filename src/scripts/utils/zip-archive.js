// 通用 zip 读写（纯 JS，WebView 与 Node 都可用）：从中央目录列条目，按需解压单个条目；打包用于女仆产出。
// 防护：条目数上限、单条目解压边解边计（超限立即停止）、路径规范化（`..`、绝对路径、盘符、软链接标为不安全）、
// 加密条目识别。文件名：有 UTF-8 标志或 Unicode 路径扩展时按 UTF-8，否则先试 UTF-8，再按 GB18030
// （Windows 中文压缩包常见），都不行按单字节。

export const ZIP_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxEntryBytes: 20 * 1024 * 1024,
});

export class ZipArchiveError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ZipArchiveError';
    this.code = code;
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u64 = (dv, at) => Number(dv.getBigUint64(at, true));

const isAscii = raw => raw.every(byte => byte < 0x80);
const decodeEntryName = (raw, utf8Flag, unicodePath) => {
  if (unicodePath) return { name: unicodePath, encoding: 'utf-8' };
  if (utf8Flag || isAscii(raw)) return { name: new TextDecoder('utf-8').decode(raw), encoding: 'utf-8' };
  try {
    return { name: new TextDecoder('utf-8', { fatal: true }).decode(raw), encoding: 'utf-8' };
  } catch {}
  try {
    return { name: new TextDecoder('gb18030', { fatal: true }).decode(raw), encoding: 'gb18030' };
  } catch {}
  return { name: String.fromCharCode(...raw), encoding: 'latin1' };
};

// 规范成 a/b/c（目录以 / 结尾）；越界或绝对路径标为不安全，这类条目只列出、不读取
export const normalizeZipEntryPath = (name = '') => {
  const raw = String(name).replace(/\\/g, '/');
  const segments = raw.split('/');
  const unsafe = raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || segments.includes('..') || raw.includes('\0');
  const clean = segments.filter(segment => segment && segment !== '.').join('/');
  return { path: clean && raw.endsWith('/') ? `${clean}/` : clean, unsafe };
};

const findEndOfCentralDirectory = (bytes) => {
  const dv = view(bytes);
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (dv.getUint32(at, true) === SIG_EOCD) return at;
  }
  return -1;
};

const parseExtra = (bytes, start, length) => {
  const fields = new Map();
  const dv = view(bytes);
  let at = start;
  while (at + 4 <= start + length) {
    const id = dv.getUint16(at, true);
    const size = dv.getUint16(at + 2, true);
    fields.set(id, bytes.subarray(at + 4, Math.min(at + 4 + size, start + length)));
    at += 4 + size;
  }
  return fields;
};

/**
 * 列出条目（不解压）。返回 { entries, fileCount, totalBytes, zip64 }；
 * entry: { index, path, name, encoding, size, compressedSize, method, crc32, encrypted, isDirectory, unsafe, duplicate, offset }
 */
export const listZipEntries = (input, { maxEntries = ZIP_ARCHIVE_LIMITS.maxEntries } = {}) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const end = findEndOfCentralDirectory(bytes);
  if (end < 0) throw new ZipArchiveError('not_a_zip', '不是有效的 zip 文件');
  const dv = view(bytes);
  let count = dv.getUint16(end + 10, true);
  let cdOffset = dv.getUint32(end + 16, true);
  let zip64 = false;
  if ((count === 0xffff || cdOffset === 0xffffffff) && end >= 20 && dv.getUint32(end - 20, true) === SIG_ZIP64_LOCATOR) {
    const recordAt = u64(dv, end - 20 + 8);
    if (recordAt + 56 <= bytes.length && dv.getUint32(recordAt, true) === SIG_ZIP64_EOCD) {
      count = u64(dv, recordAt + 32);
      cdOffset = u64(dv, recordAt + 48);
      zip64 = true;
    }
  }
  if (count > maxEntries) throw new ZipArchiveError('too_many_entries', `条目过多（${count} 个，上限 ${maxEntries}）`);
  const entries = [];
  const seen = new Set();
  let at = cdOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || dv.getUint32(at, true) !== SIG_CENTRAL) {
      throw new ZipArchiveError('corrupt_zip', 'zip 目录损坏');
    }
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const crc32 = dv.getUint32(at + 16, true);
    let compressedSize = dv.getUint32(at + 20, true);
    let size = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    const externalAttr = dv.getUint32(at + 38, true);
    let offset = dv.getUint32(at + 42, true);
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength);
    const extra = parseExtra(bytes, at + 46 + nameLength, extraLength);
    const zip64Extra = extra.get(0x0001);
    if (zip64Extra) {
      const zdv = view(zip64Extra);
      let cursor = 0;
      if (size === 0xffffffff && cursor + 8 <= zip64Extra.length) { size = u64(zdv, cursor); cursor += 8; }
      if (compressedSize === 0xffffffff && cursor + 8 <= zip64Extra.length) { compressedSize = u64(zdv, cursor); cursor += 8; }
      if (offset === 0xffffffff && cursor + 8 <= zip64Extra.length) { offset = u64(zdv, cursor); }
    }
    const unicodeExtra = extra.get(0x7075);
    const unicodePath = unicodeExtra && unicodeExtra.length > 5 && unicodeExtra[0] === 1
      ? new TextDecoder('utf-8').decode(unicodeExtra.subarray(5))
      : '';
    const { name, encoding } = decodeEntryName(rawName, Boolean(flags & 0x800), unicodePath);
    const { path, unsafe } = normalizeZipEntryPath(name);
    const isSymlink = ((externalAttr >>> 16) & S_IFMT) === S_IFLNK;
    const key = path.toLowerCase();
    const duplicate = seen.has(key);
    seen.add(key);
    entries.push({
      index,
      path,
      name,
      encoding,
      size,
      compressedSize,
      method,
      crc32,
      encrypted: Boolean(flags & 0x1),
      isDirectory: path.endsWith('/'),
      unsafe: unsafe || isSymlink || !path,
      duplicate,
      offset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  const files = entries.filter(entry => !entry.isDirectory);
  return {
    entries,
    fileCount: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
    zip64,
  };
};

const inflateRawCapped = async (data, maxBytes) => {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ZipArchiveError('entry_too_large', `解压后超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ZipArchiveError) throw error;
    throw new ZipArchiveError('corrupt_entry', '条目数据损坏，无法解压');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};

/** 读取单个条目的原始字节；超过 maxBytes 立即停止解压。 */
export const readZipEntry = async (input, entry, { maxBytes = ZIP_ARCHIVE_LIMITS.maxEntryBytes } = {}) => {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!entry || entry.isDirectory) throw new ZipArchiveError('not_a_file', '这是一个文件夹');
  if (entry.unsafe) throw new ZipArchiveError('unsafe_path', `路径不安全，已跳过：${entry.name}`);
  if (entry.encrypted) throw new ZipArchiveError('encrypted', '条目已加密，无法读取');
  if (entry.size > maxBytes) throw new ZipArchiveError('entry_too_large', `解压后超过 ${Math.round(maxBytes / 1024 / 1024)}MB`);
  const dv = view(bytes);
  const at = entry.offset;
  if (at + 30 > bytes.length || dv.getUint32(at, true) !== SIG_LOCAL) throw new ZipArchiveError('corrupt_entry', '条目数据损坏');
  const start = at + 30 + dv.getUint16(at + 26, true) + dv.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (data.length < entry.compressedSize) throw new ZipArchiveError('corrupt_entry', '条目数据不完整');
  let out;
  if (entry.method === 0) out = data.slice();
  else if (entry.method === 8) out = await inflateRawCapped(data, maxBytes);
  else throw new ZipArchiveError('unsupported_compression', `不支持的压缩方式（${entry.method}）`);
  if (out.byteLength !== entry.size) throw new ZipArchiveError('corrupt_entry', '条目大小与目录记录不符');
  return out;
};

export const findZipEntry = (listing, path) => {
  const target = normalizeZipEntryPath(path).path.toLowerCase();
  return (listing?.entries || []).find(entry => !entry.duplicate && entry.path.toLowerCase() === target) || null;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const deflateRaw = async data => new Uint8Array(
  await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
);

/**
 * 打包：files 为 [{ path, bytes }]（路径用 /，文件名按 UTF-8 并设标志位）。
 * 压缩后没变小的条目原样存放。总量受 zip32 限制（单文件与总大小 < 4GB，条目 < 65535）。
 */
export const buildZip = async (files = [], { compress = true } = {}) => {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  const stamp = { time: 0, date: (1 << 5) | 1 };
  for (const file of files) {
    const { path, unsafe } = normalizeZipEntryPath(file.path);
    if (!path || unsafe || path.endsWith('/')) throw new ZipArchiveError('unsafe_path', `打包路径无效：${file.path}`);
    const data = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file.bytes || []);
    const nameBytes = encoder.encode(path);
    let method = 0;
    let body = data;
    if (compress && data.length > 0) {
      const packed = await deflateRaw(data);
      if (packed.length < data.length) {
        method = 8;
        body = packed;
      }
    }
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = view(local);
    ldv.setUint32(0, SIG_LOCAL, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true);
    ldv.setUint16(8, method, true);
    ldv.setUint16(10, stamp.time, true);
    ldv.setUint16(12, stamp.date, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, body.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    locals.push(local, body);
    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = view(central);
    cdv.setUint32(0, SIG_CENTRAL, true);
    cdv.setUint16(4, 20, true);
    cdv.setUint16(6, 20, true);
    cdv.setUint16(8, 0x0800, true);
    cdv.setUint16(10, method, true);
    cdv.setUint16(12, stamp.time, true);
    cdv.setUint16(14, stamp.date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, body.length, true);
    cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const cdSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const edv = view(end);
  edv.setUint32(0, SIG_EOCD, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdSize, true);
  edv.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
