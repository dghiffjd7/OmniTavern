// 大资料包导入：不把整个文件搬进前端内存。
// 旧做法把整个文件转成数组（Array.from）或 base64 字符串再交给原生端，文件一大（约 128MB 以上）就会
// 撞上数组／字符串长度上限（Invalid array length）。这里改成：识别时只读 zip 结尾的目录和 manifest.json，
// 导入时分块写进 APP 的临时文件，再让原生端从文件边读边导入。
import { t } from '../i18n/index.js';
import { normalizeZipEntryName } from './zip-entry-utils.js';

export const IMPORT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const EOCD_SEARCH_BYTES = EOCD_MIN_BYTES + 0xffff + 20;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;

const readBytes = async (blob, start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
const u16 = (view, at) => view.getUint16(at, true);
const u32 = (view, at) => view.getUint32(at, true);
const u64 = (view, at) => Number(view.getBigUint64(at, true));

// 找 zip 结尾的目录位置（含 ZIP64：条目很多或文件超过 4GB 时用）
const locateCentralDirectory = async (blob) => {
  const tailStart = Math.max(0, blob.size - EOCD_SEARCH_BYTES);
  const tail = await readBytes(blob, tailStart, blob.size);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let at = tail.length - EOCD_MIN_BYTES; at >= 0; at -= 1) {
    if (u32(view, at) === EOCD_SIGNATURE) { eocd = at; break; }
  }
  if (eocd < 0) return null;
  let entries = u16(view, eocd + 10);
  let size = u32(view, eocd + 12);
  let offset = u32(view, eocd + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || u32(view, locator) !== ZIP64_LOCATOR_SIGNATURE) return null;
    const zip64At = u64(view, locator + 8);
    const record = await readBytes(blob, zip64At, zip64At + 56);
    const recordView = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (record.length < 56 || u32(recordView, 0) !== ZIP64_EOCD_SIGNATURE) return null;
    entries = u64(recordView, 32);
    size = u64(recordView, 40);
    offset = u64(recordView, 48);
  }
  if (offset + size > blob.size) return null;
  return { entries, size, offset };
};

// 目录里某一项：名字、压缩方式、大小、本地头位置（ZIP64 的额外字段里可能放着真正的大小和位置）
const readCentralEntries = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out = [];
  let at = 0;
  while (at + 46 <= bytes.length && u32(view, at) === CENTRAL_SIGNATURE) {
    const method = u16(view, at + 10);
    let compressedSize = u32(view, at + 20);
    let size = u32(view, at + 24);
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    let localOffset = u32(view, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    let extraAt = at + 46 + nameLength;
    const extraEnd = extraAt + extraLength;
    while (extraAt + 4 <= extraEnd) {
      const id = u16(view, extraAt);
      const length = u16(view, extraAt + 2);
      if (id === 0x0001) {
        let field = extraAt + 4;
        if (size === 0xffffffff) { size = u64(view, field); field += 8; }
        if (compressedSize === 0xffffffff) { compressedSize = u64(view, field); field += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(view, field); }
      }
      extraAt += 4 + length;
    }
    out.push({ name, method, compressedSize, size, localOffset });
    at = extraEnd + commentLength;
  }
  return out;
};

const inflateRaw = async (bytes) => {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const readEntryBytes = async (blob, entry) => {
  const header = await readBytes(blob, entry.localOffset, entry.localOffset + 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 30 || u32(view, 0) !== LOCAL_SIGNATURE) throw new Error('zip local header missing');
  const dataStart = entry.localOffset + 30 + u16(view, 26) + u16(view, 28);
  const data = await readBytes(blob, dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRaw(data);
  throw new Error(`unsupported zip compression: ${entry.method}`);
};

// 读 zip 根目录的某个小 JSON（如完整资料包的 bundle.json）。ok=false：不是 zip 或读不了；json=null：没有或解析不了
export const readZipRootJsonFromBlob = async (blob, name) => {
  try {
    const directory = await locateCentralDirectory(blob);
    if (!directory) return { ok: false, reason: 'not_zip' };
    const entries = readCentralEntries(await readBytes(blob, directory.offset, directory.offset + directory.size));
    const entry = entries.find(item => normalizeZipEntryName(item.name, { trim: true }) === name);
    if (!entry || entry.size > MANIFEST_MAX_BYTES) return { ok: true, json: null };
    try {
      const json = JSON.parse(new TextDecoder().decode(await readEntryBytes(blob, entry)));
      return { ok: true, json: json && typeof json === 'object' ? json : null };
    } catch {
      return { ok: true, json: null };
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
};

// 读 zip 根目录的 manifest.json。ok=false：不是 zip 或读不了；ok=true 且 manifest=null：没有（或解析不了）manifest
export const readZipManifestFromBlob = async (blob) => {
  try {
    const directory = await locateCentralDirectory(blob);
    if (!directory) return { ok: false, reason: 'not_zip' };
    const entries = readCentralEntries(await readBytes(blob, directory.offset, directory.offset + directory.size));
    const entry = entries.find(item => normalizeZipEntryName(item.name, { trim: true }) === 'manifest.json');
    if (!entry || entry.size > MANIFEST_MAX_BYTES) return { ok: true, manifest: null };
    const text = new TextDecoder().decode(await readEntryBytes(blob, entry));
    try {
      const manifest = JSON.parse(text);
      return { ok: true, manifest: manifest && typeof manifest === 'object' ? manifest : null };
    } catch {
      return { ok: true, manifest: null };
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
};

// 分块写进 APP 的临时文件（import_upload_* 命令），返回临时文件路径；每块写完核对大小，出错就删掉临时文件
export const uploadBlobForImport = async (blob, {
  invoke,
  chunkSize = IMPORT_UPLOAD_CHUNK_BYTES,
  onProgress = null,
} = {}) => {
  const path = await invoke('import_upload_begin', {});
  try {
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
      const chunk = await readBytes(blob, offset, Math.min(blob.size, offset + chunkSize));
      const written = Number(await invoke('import_upload_append', { path, data: bytesToBase64(chunk) }));
      const expected = offset + chunk.length;
      if (written !== expected) throw new Error(t('资料包写入大小不一致（{written} / {expected}）', { written, expected }));
      onProgress?.(expected, blob.size);
    }
    return path;
  } catch (error) {
    await Promise.resolve(invoke('import_upload_discard', { path })).catch(() => {});
    throw error;
  }
};
