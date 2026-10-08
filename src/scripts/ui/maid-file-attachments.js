// 女仆附件：图片照旧压缩看图；JSON 与带角色卡数据的 PNG 另外保留原文件，供本地解析和后续导入。
// 原文件只放在内存里（按附件 ID 取用）；APP 重启后需重新上传。
import { inspectAttachmentFile } from '../import/attachment-file-inspector.js';
import { t } from '../i18n/index.js';
import { createImageAttachmentFromFile, isImageAttachmentFile } from './image-attachment-input-utils.js';

export const MAX_MAID_FILE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const REGISTRY_MAX_BYTES = 80 * 1024 * 1024;

const trim = value => String(value ?? '').trim();
const fileExtension = name => (trim(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '');

export const isJsonAttachmentFile = file => Boolean(file)
  && (trim(file.type).toLowerCase().includes('json') || fileExtension(file.name) === 'json');

export const isCharxAttachmentFile = file => Boolean(file) && fileExtension(file.name) === 'charx';

// 单个 .js 文件按一个脚本导入
export const isScriptAttachmentFile = file => Boolean(file)
  && (fileExtension(file.name) === 'js' || trim(file.type).toLowerCase().includes('javascript'));

const isPngFile = file => trim(file?.type).toLowerCase() === 'image/png' || fileExtension(file?.name) === 'png';

const RECENT_ATTACHMENT_MAX_AGE_MS = 30 * 60 * 1000;

// 原文件缓存：总量超过上限时丢弃最早的附件。
// 每项另记上传时间、首次发送时的会话／角色卡（「当前」按发送时解释）和导入记录。
export const createMaidFileAttachmentRegistry = ({ maxBytes = REGISTRY_MAX_BYTES, now = () => Date.now() } = {}) => {
  const entries = new Map();
  let totalBytes = 0;
  const release = (id) => {
    const entry = entries.get(id);
    if (!entry) return false;
    totalBytes -= entry.bytes.byteLength;
    entries.delete(id);
    return true;
  };
  return {
    register(id, entry) {
      release(id);
      entries.set(id, { ...entry, id, registeredAt: now(), submittedContext: null, imports: [] });
      totalBytes += entry.bytes.byteLength;
      for (const oldId of entries.keys()) {
        if (totalBytes <= maxBytes || oldId === id) break;
        release(oldId);
      }
    },
    get: id => entries.get(trim(id)) || null,
    release: id => release(trim(id)),
    // 只记第一次发送时的上下文：追问期间用户切卡，不会悄悄改成新目标
    markSubmitted(id, context = {}) {
      const entry = entries.get(trim(id));
      if (!entry || entry.submittedContext) return;
      entry.submittedContext = { roleCardId: trim(context.roleCardId), sessionId: trim(context.sessionId) };
    },
    recordImport(id, record) {
      entries.get(trim(id))?.imports.push({ ...record, at: now() });
    },
    // 最近上传、还没导入过的文件（供追问后的下一轮继续使用）
    listRecent({ excludeIds = [], maxAgeMs = RECENT_ATTACHMENT_MAX_AGE_MS } = {}) {
      const excluded = new Set(excludeIds.map(trim));
      return Array.from(entries.values())
        .filter(entry => !excluded.has(entry.id) && !entry.imports.length && now() - entry.registeredAt <= maxAgeMs)
        .map(entry => ({ id: entry.id, name: entry.name, hash: entry.hash, file: entry.inspection }));
    },
  };
};

const sha256Hex = async (bytes) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, value => value.toString(16).padStart(2, '0')).join('');
};

const readBytes = async file => new Uint8Array(await file.arrayBuffer());

const defaultCreateId = () => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `maid_file_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`);

export const createMaidAttachmentsFromFiles = async (files = [], {
  source = 'maid-input',
  registry,
  imageOptions = {},
  createId = defaultCreateId,
  notify = null,
  readCharx = null,
} = {}) => {
  const attachments = [];
  const warn = message => { try { notify?.(message); } catch {} };
  for (const file of Array.from(files || [])) {
    if (!file) continue;
    const name = trim(file.name);
    const isImage = isImageAttachmentFile(file);
    if (!isImage && !isJsonAttachmentFile(file) && !isScriptAttachmentFile(file) && !isCharxAttachmentFile(file)) {
      warn(t('暂不支持这类文件：{name}', { name: name || fileExtension(name) }));
      continue;
    }
    if (Number(file.size || 0) > MAX_MAID_FILE_ATTACHMENT_BYTES) {
      warn(t('文件超过 20MB，暂不支持：{name}', { name }));
      continue;
    }
    const id = createId();
    if (isImage) {
      const image = await createImageAttachmentFromFile(file, { ...imageOptions, source });
      if (!image) continue;
      // PNG 可能是角色卡：在压缩前保留原文件，否则卡数据会丢
      if (isPngFile(file)) {
        const bytes = await readBytes(file);
        const inspection = inspectAttachmentFile({ name, mime: file.type, bytes });
        if (inspection.format === 'character_card') {
          const hash = await sha256Hex(bytes);
          registry?.register(id, { bytes, hash, name, mime: trim(file.type) || 'image/png', size: bytes.byteLength, inspection });
          attachments.push({ ...image, id, hash, file: inspection });
          continue;
        }
      }
      attachments.push({ ...image, id });
      continue;
    }
    const bytes = await readBytes(file);
    let inspection;
    if (isCharxAttachmentFile(file)) {
      // .charx 在原生侧安全解包，取出 card.json 后按角色卡识别
      try {
        const charx = await readCharx(bytes);
        inspection = inspectAttachmentFile({ name, mime: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(charx.json)) });
        inspection = { ...inspection, details: { ...inspection.details, source: 'charx', entryCount: charx.entries.length } };
      } catch (error) {
        warn(t('无法读取 .charx：{reason}', { reason: trim(error?.message) || name }));
        continue;
      }
    } else {
      inspection = inspectAttachmentFile({ name, mime: file.type, bytes });
    }
    const hash = await sha256Hex(bytes);
    const mime = trim(file.type) || (isScriptAttachmentFile(file) ? 'text/javascript' : isCharxAttachmentFile(file) ? 'application/zip' : 'application/json');
    registry?.register(id, { bytes, hash, name, mime, size: bytes.byteLength, inspection });
    attachments.push({ id, kind: 'file', name, mime, size: bytes.byteLength, hash, source, file: inspection });
  }
  return attachments;
};
