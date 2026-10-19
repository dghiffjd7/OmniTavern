// 女仆附件：图片照旧压缩看图；JSON 与带角色卡数据的 PNG 另外保留原文件，供本地解析和后续导入。
// 原文件登记进女仆文件库（APP 内持久保存，按附件 ID 取用）。
import { inspectAttachmentContent } from '../import/attachment-content.js';
import { inspectAttachmentFile } from '../import/attachment-file-inspector.js';
import { createMaidFileLibrary } from '../storage/maid-file-library.js';
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

const OFFICE_MIME = Object.freeze({
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
});
const fallbackMimeFor = (file, inspection = {}) => {
  if (isCharxAttachmentFile(file)) return 'application/zip';
  if (isScriptAttachmentFile(file)) return 'text/javascript';
  if (inspection.format === 'archive') return 'application/zip';
  if (inspection.format === 'document') return OFFICE_MIME[inspection.details?.type] || 'application/zip';
  if (inspection.format === 'text') return 'text/plain';
  return 'application/json';
};

// 纯内存的附件缓存（测试与无存储时使用）；APP 内用持久化的女仆文件库，接口相同
export const createMaidFileAttachmentRegistry = ({ maxBytes = REGISTRY_MAX_BYTES, now = () => Date.now() } = {}) => (
  createMaidFileLibrary({ now, limits: { cacheBytes: maxBytes } })
);

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
  maxCount = Infinity,
} = {}) => {
  const attachments = [];
  const leftOut = [];
  const warn = message => { try { notify?.(message); } catch {} };
  for (const file of Array.from(files || [])) {
    if (!file) continue;
    const name = trim(file.name);
    const isImage = isImageAttachmentFile(file);
    // 名额已满：不再读取，最后统一提示没加入的文件
    if (attachments.length >= maxCount) {
      leftOut.push(name);
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
      // 按内容识别：文本、压缩包、Office 文档，以及原有的世界书／正则／脚本／预设／角色卡 JSON
      const content = await inspectAttachmentContent({ name, mime: file.type, bytes });
      if (content.unsupported) {
        warn(content.unsupported === 'pdf'
          ? t('PDF 暂不支持（计划中）：{name}', { name })
          : t('暂不支持这类文件：{name}', { name: name || fileExtension(name) }));
        continue;
      }
      inspection = content.inspection;
    }
    const hash = await sha256Hex(bytes);
    const mime = trim(file.type) || fallbackMimeFor(file, inspection);
    registry?.register(id, { bytes, hash, name, mime, size: bytes.byteLength, inspection });
    attachments.push({ id, kind: 'file', name, mime, size: bytes.byteLength, hash, source, file: inspection });
  }
  if (leftOut.length) warn(t('附件数量已达上限，未加入：{names}', { names: leftOut.join('、') }));
  return attachments;
};
