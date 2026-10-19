// 女仆附件的内容层：按内容识别类型（扩展名只作辅助），给出文本／压缩包／Office 文档的识别摘要，
// 并提供分页读取与关键词检索。读出的内容是资料，不是指令。
import { decodeTextBytes } from '../utils/text-decode.js';
import { findZipEntry, listZipEntries, readZipEntry, ZIP_ARCHIVE_LIMITS } from '../utils/zip-archive.js';
import { inspectAttachmentFile } from './attachment-file-inspector.js';
import { detectOfficeType, extractOfficeText } from './office-text-extractor.js';

const trim = value => String(value ?? '').trim();
const extensionOf = name => (trim(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '');

const TEXT_KIND_BY_EXTENSION = Object.freeze({
  txt: '文本', md: 'Markdown', markdown: 'Markdown', csv: 'CSV 表格', tsv: 'TSV 表格', log: '日志',
  json: 'JSON', jsonl: 'JSON Lines', yaml: 'YAML', yml: 'YAML', xml: 'XML', html: 'HTML', htm: 'HTML',
  srt: '字幕', vtt: '字幕', ass: '字幕', ini: '配置', toml: '配置', cfg: '配置', conf: '配置',
});
const CODE_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'lua', 'sql', 'css', 'scss', 'less', 'swift', 'dart']);
export const textKindOf = (name = '') => {
  const ext = extensionOf(name);
  if (TEXT_KIND_BY_EXTENSION[ext]) return TEXT_KIND_BY_EXTENSION[ext];
  return CODE_EXTENSIONS.has(ext) ? '代码' : '文本';
};

// 压缩包内可导入的格式（与 attachment.import 一致）
const IMPORTABLE_FORMATS = new Set(['worldbook', 'regex', 'script', 'preset', 'character_card']);
const IMPORT_PROBE_EXTENSIONS = new Set(['json', 'png', 'js']);
const IMPORT_PROBE_MAX_ENTRIES = 30;
const IMPORT_PROBE_MAX_BYTES = 4 * 1024 * 1024;
const LISTING_SAMPLE = 40;

const startsWith = (bytes, signature) => signature.every((byte, i) => bytes[i] === byte);
const PK_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const PK_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** 按内容判断：zip（含 Office、charx）、pdf、text（附带解码结果）或 binary。 */
export const sniffAttachmentBytes = (bytes) => {
  if (startsWith(bytes, PK_LOCAL) || startsWith(bytes, PK_EMPTY)) return { kind: 'zip' };
  if (startsWith(bytes, PDF)) return { kind: 'pdf' };
  const decoded = decodeTextBytes(bytes);
  return decoded ? { kind: 'text', decoded } : { kind: 'binary' };
};

const describeEntry = entry => ({ path: entry.path, size: entry.size });

const inspectArchive = async ({ name, bytes }) => {
  const listing = listZipEntries(bytes);
  const files = listing.entries.filter(entry => !entry.isDirectory);
  const folders = listing.entries.length - files.length;
  const diagnostics = [];
  const encrypted = files.filter(entry => entry.encrypted).length;
  const unsafe = files.filter(entry => entry.unsafe).length;
  if (encrypted) diagnostics.push(`${encrypted} 个文件已加密，无法读取`);
  if (unsafe) diagnostics.push(`${unsafe} 个文件路径不安全（如 ../），已跳过`);
  if (files.some(entry => entry.encoding === 'gb18030')) diagnostics.push('文件名按 GBK 解码（Windows 中文压缩包）');
  const importable = [];
  let budget = 40 * 1024 * 1024;
  for (const entry of files) {
    if (importable.length >= IMPORT_PROBE_MAX_ENTRIES) break;
    if (entry.unsafe || entry.encrypted || entry.duplicate || entry.size > IMPORT_PROBE_MAX_BYTES) continue;
    if (!IMPORT_PROBE_EXTENSIONS.has(extensionOf(entry.path)) || entry.size > budget) continue;
    budget -= entry.size;
    try {
      const entryBytes = await readZipEntry(bytes, entry, { maxBytes: IMPORT_PROBE_MAX_BYTES });
      const inspection = inspectAttachmentFile({ name: entry.path.split('/').pop(), mime: '', bytes: entryBytes });
      if (IMPORTABLE_FORMATS.has(inspection.format)) {
        importable.push({ path: entry.path, format: inspection.format, label: inspection.label || '', title: inspection.title || '' });
      }
    } catch {}
  }
  return {
    format: 'archive',
    label: '压缩包',
    title: name,
    counts: { files: files.length, folders, bytes: listing.totalBytes },
    details: {
      sample: files.slice(0, LISTING_SAMPLE).map(describeEntry),
      more: Math.max(0, files.length - LISTING_SAMPLE),
      importable,
    },
    diagnostics,
    targets: [],
    candidates: [],
  };
};

const inspectDocument = async ({ name, bytes, listing }) => {
  const office = await extractOfficeText(bytes, { name, listing });
  return {
    format: 'document',
    label: office.label,
    title: name,
    counts: { ...office.stats, chars: office.text.length },
    details: { type: office.type, truncated: office.truncated },
    diagnostics: office.truncated ? ['文字过长，只保留前 200 万字'] : [],
    targets: [],
    candidates: [],
  };
};

const inspectText = ({ name, decoded }) => ({
  format: 'text',
  label: textKindOf(name),
  title: name,
  counts: { lines: decoded.text.split('\n').length, chars: decoded.text.length },
  details: { encoding: decoded.encoding, extension: extensionOf(name) },
  diagnostics: decoded.encoding === 'utf-8' ? [] : [`编码为 ${decoded.encoding.toUpperCase()}，已转换`],
  targets: [],
  candidates: [],
});

/**
 * 通用附件识别（异步）：JSON／脚本／角色卡沿用原导入识别；其余按内容识别为文本、压缩包或 Office 文档。
 * 返回 { inspection } 或 { unsupported: 'pdf' | 'binary' | 'archive_unreadable', message }。
 */
export const inspectAttachmentContent = async ({ name = '', mime = '', bytes }) => {
  const ext = extensionOf(name);
  const sniff = sniffAttachmentBytes(bytes);
  if (sniff.kind === 'pdf') return { unsupported: 'pdf', message: 'PDF 暂不支持（计划中）' };
  if (sniff.kind === 'zip') {
    let listing;
    try {
      listing = listZipEntries(bytes);
    } catch (error) {
      return { unsupported: 'archive_unreadable', message: trim(error?.message) || '无法读取压缩包' };
    }
    if (detectOfficeType(listing, name)) {
      try {
        return { inspection: await inspectDocument({ name, bytes, listing }) };
      } catch (error) {
        return { unsupported: 'archive_unreadable', message: trim(error?.message) || '无法读取文档' };
      }
    }
    return { inspection: await inspectArchive({ name, bytes }) };
  }
  if (sniff.kind === 'binary') return { unsupported: 'binary', message: '无法识别的二进制文件' };
  // 文本：.json／.js 或看起来像 JSON 的，先走原导入识别（世界书、正则、脚本、预设、角色卡）
  const looksJson = /^[\s]*[[{]/.test(sniff.decoded.text);
  if (ext === 'json' || ext === 'js' || /json|javascript/i.test(mime) || looksJson) {
    const inspection = inspectAttachmentFile({ name, mime, bytes });
    if (inspection.format !== 'invalid_json' || ext === 'json') return { inspection };
  }
  return { inspection: inspectText({ name, decoded: sniff.decoded }) };
};

// ---- 读取文字 ----

// 女仆每步观察约 7000 字，超出时所有字符串会被压到 600 字：每页要留足余量
export const READ_PAGE_DEFAULT_CHARS = 4000;
export const READ_PAGE_MAX_CHARS = 6000;
const READ_PAGE_MAX_LINES = 400;

const failure = (reason, message, extra = {}) => ({ ok: false, reason, message, ...extra });

const textFromBytes = async ({ name, bytes }) => {
  const sniff = sniffAttachmentBytes(bytes);
  if (sniff.kind === 'pdf') return failure('pdf_not_supported', 'PDF 暂不支持读取（计划中）');
  if (sniff.kind === 'zip') {
    let listing;
    try { listing = listZipEntries(bytes); } catch (error) { return failure('archive_unreadable', trim(error?.message)); }
    if (detectOfficeType(listing, name)) {
      const office = await extractOfficeText(bytes, { name, listing });
      return { ok: true, text: office.text, kind: office.label };
    }
    return failure('archive_needs_entry', '这是压缩包，请指定要读取的文件路径（entry）', { isArchive: true });
  }
  if (sniff.kind === 'binary') return failure('binary_file', '这是二进制文件，无法按文字读取');
  return { ok: true, text: sniff.decoded.text, kind: textKindOf(name), encoding: sniff.decoded.encoding };
};

/**
 * 附件文字读取器：带缓存（按哈希与条目路径），供 read／search 共用。
 * entry 为文件库条目 { hash, name, bytes, inspection }；entryPath 指定压缩包内的文件。
 */
export const createAttachmentTextReader = ({ maxCachedChars = 8_000_000 } = {}) => {
  const cache = new Map();
  let cachedChars = 0;
  const remember = (key, value) => {
    if (!value.ok) return value;
    cache.set(key, value);
    cachedChars += value.text.length;
    for (const oldKey of cache.keys()) {
      if (cachedChars <= maxCachedChars || oldKey === key) break;
      cachedChars -= cache.get(oldKey).text.length;
      cache.delete(oldKey);
    }
    return value;
  };
  const read = async (entry, { entryPath = '' } = {}) => {
    const path = trim(entryPath);
    const key = `${entry.hash || entry.id}\n${path}`;
    if (cache.has(key)) return cache.get(key);
    if (!path) {
      // 角色卡 PNG：读卡内数据（JSON），而不是图片字节
      if (entry.inspection?.format === 'character_card' && entry.inspection?.details?.source === 'png') {
        return failure('card_use_inspect', '角色卡请用 attachment.inspect 查看摘要');
      }
      return remember(key, await textFromBytes({ name: entry.name, bytes: entry.bytes }));
    }
    let listing;
    try { listing = listZipEntries(entry.bytes); } catch (error) { return failure('not_an_archive', trim(error?.message) || '这不是压缩包'); }
    const zipEntry = findZipEntry(listing, path);
    if (!zipEntry || zipEntry.isDirectory) {
      return failure('entry_not_found', `压缩包里没有「${path}」`, {
        suggestions: listing.entries.filter(item => !item.isDirectory && item.path.toLowerCase().includes(path.split('/').pop().toLowerCase())).slice(0, 8).map(item => item.path),
      });
    }
    let bytes;
    try {
      bytes = await readZipEntry(entry.bytes, zipEntry, { maxBytes: ZIP_ARCHIVE_LIMITS.maxEntryBytes });
    } catch (error) {
      return failure(error?.code || 'entry_unreadable', trim(error?.message) || '无法读取这个文件');
    }
    const result = await textFromBytes({ name: zipEntry.path.split('/').pop(), bytes });
    if (!result.ok && result.reason === 'archive_needs_entry') {
      return failure('nested_archive', '这是压缩包里的压缩包，暂不支持直接读取其中的文件');
    }
    return remember(key, { ...result, path: zipEntry.path });
  };
  return { read, clear: () => { cache.clear(); cachedChars = 0; } };
};

/** 分页：字符模式（offset／limit）或行模式（startLine／endLine，带行号）。 */
export const pageText = (text, { offset = 0, limit = READ_PAGE_DEFAULT_CHARS, startLine = 0, endLine = 0 } = {}) => {
  const max = Math.min(READ_PAGE_MAX_CHARS, Math.max(200, Number(limit) || READ_PAGE_DEFAULT_CHARS));
  if (Number(startLine) > 0) {
    const lines = text.split('\n');
    const from = Math.min(lines.length, Math.floor(Number(startLine)));
    const lastWanted = Number(endLine) > 0 ? Math.floor(Number(endLine)) : from + READ_PAGE_MAX_LINES - 1;
    const out = [];
    let used = 0;
    let line = from;
    for (; line <= Math.min(lines.length, lastWanted, from + READ_PAGE_MAX_LINES - 1); line += 1) {
      const rendered = `${String(line).padStart(5)}| ${lines[line - 1]}`;
      if (used + rendered.length > max && out.length) break;
      out.push(rendered);
      used += rendered.length + 1;
    }
    const last = line - 1;
    return { text: out.join('\n'), startLine: from, endLine: last, totalLines: lines.length, nextLine: last < lines.length ? last + 1 : null };
  }
  const start = Math.max(0, Math.min(text.length, Math.floor(Number(offset) || 0)));
  const end = Math.min(text.length, start + max);
  return { text: text.slice(start, end), offset: start, nextOffset: end < text.length ? end : null, totalChars: text.length };
};

const isCjk = ch => /[㐀-鿿豈-﫿]/.test(ch);
const bigrams = (query) => {
  const chars = Array.from(query.replace(/\s+/g, ''));
  const out = new Set();
  for (let i = 0; i + 1 < chars.length; i += 1) if (isCjk(chars[i]) || isCjk(chars[i + 1])) out.add(chars[i] + chars[i + 1]);
  return [...out];
};

/**
 * 关键词检索：空格分隔的词全部按不区分大小写的字面匹配；整句没有命中且是中文时，
 * 退回中文两字切分（命中一半以上的两字组合即算）。返回 { hits: [{ line, text, before, after, score }], mode }。
 */
export const searchText = (text, query, { maxHits = 10, maxLineChars = 200, maxContextChars = 100 } = {}) => {
  const lines = text.split('\n');
  const lowerLines = lines.map(line => line.toLowerCase());
  const terms = trim(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { hits: [], mode: 'none' };
  const clip = (value, max = maxLineChars) => (value.length > max ? `${value.slice(0, max)}…` : value);
  const collect = (scoreLine, mode) => {
    const scored = [];
    lowerLines.forEach((line, index) => {
      const score = scoreLine(line);
      if (score > 0) scored.push({ index, score });
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return {
      mode,
      total: scored.length,
      hits: scored.slice(0, maxHits).sort((a, b) => a.index - b.index).map(({ index, score }) => ({
        line: index + 1,
        text: clip(lines[index]),
        before: index > 0 ? clip(lines[index - 1], maxContextChars) : '',
        after: index + 1 < lines.length ? clip(lines[index + 1], maxContextChars) : '',
        score,
      })),
    };
  };
  const literal = collect(line => {
    const matched = terms.filter(term => line.includes(term)).length;
    return matched === terms.length ? matched : 0;
  }, 'literal');
  if (literal.hits.length) return literal;
  const grams = bigrams(trim(query).toLowerCase());
  if (grams.length < 2) return literal;
  const need = Math.ceil(grams.length / 2);
  return collect(line => {
    const matched = grams.filter(gram => line.includes(gram)).length;
    return matched >= need ? matched : 0;
  }, 'bigram');
};

