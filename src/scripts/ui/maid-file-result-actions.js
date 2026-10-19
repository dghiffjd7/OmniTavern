// 女仆在 APP 内产出文件（写出、打包、从压缩包取出）后，结果里提供「查看」与「附加给女仆」：
// 查看用只读文本框（可复制）；附加把文件放回女仆输入条，方便接着让女仆处理。
import { t } from '../i18n/index.js';
import { listZipEntries } from '../utils/zip-archive.js';

const trim = value => String(value ?? '').trim();
const OUTPUT_TOOLS = new Set(['attachment.create', 'attachment.pack', 'attachment.extract']);
const MAX_PREVIEW_ACTIONS = 2;
const PREVIEW_MAX_CHARS = 200000;

// 本次运行产出的文件（同一文件续写多次只算一个，取最后一次）
export const collectMaidOutputFiles = (steps = []) => {
  const files = new Map();
  (Array.isArray(steps) ? steps : []).forEach((step) => {
    if (!OUTPUT_TOOLS.has(trim(step?.toolName)) || trim(step?.status) !== 'succeeded') return;
    const output = step.output || {};
    const list = trim(step.toolName) === 'attachment.extract' ? output.files : (output.ok ? [output] : []);
    (Array.isArray(list) ? list : []).forEach((file) => {
      const id = trim(file?.attachmentId);
      if (!id) return;
      files.delete(id);
      files.set(id, { attachmentId: id, name: trim(file.name) || id });
    });
  });
  return Array.from(files.values());
};

export const buildMaidFileResultActions = (steps = [], { preview = null, attach = null } = {}) => {
  const files = collectMaidOutputFiles(steps);
  if (!files.length) return [];
  const actions = [];
  if (typeof preview === 'function') {
    files.slice(0, MAX_PREVIEW_ACTIONS).forEach((file) => {
      actions.push({ label: t('查看「{name}」', { name: file.name }), onClick: () => preview(file.attachmentId) });
    });
  }
  if (typeof attach === 'function') {
    const ids = files.map(file => file.attachmentId);
    actions.push({
      label: ids.length > 1 ? t('附加这 {count} 个文件给女仆', { count: ids.length }) : t('附加给女仆'),
      onClick: () => attach(ids),
    });
  }
  return actions;
};

const formatSize = (bytes = 0) => {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
};

/** 预览用文字：压缩包列目录，其余读出文字（与女仆读取同一读取器）；读不出时说明原因。 */
export const buildMaidFilePreviewText = async (entry, { reader } = {}) => {
  if (!entry?.bytes) return t('文件已被清理，无法预览。');
  if (entry.inspection?.format === 'archive') {
    try {
      const files = listZipEntries(entry.bytes).entries.filter(item => !item.isDirectory);
      return [t('压缩包内共 {count} 个文件：', { count: files.length }), ...files.map(item => `${item.path}  (${formatSize(item.size)})`)].join('\n');
    } catch (error) {
      return trim(error?.message) || t('无法读取压缩包。');
    }
  }
  const read = await reader.read(entry);
  if (!read.ok) return trim(read.message) || t('这个文件无法按文字预览。');
  return read.text.length > PREVIEW_MAX_CHARS
    ? `${read.text.slice(0, PREVIEW_MAX_CHARS)}\n${t('…（内容过长，后面省略）')}`
    : read.text;
};

// 文件库条目 → 女仆输入条上的文件附件
export const toMaidFileAttachment = entry => ({
  id: entry.id,
  kind: 'file',
  name: entry.name,
  mime: entry.mime,
  size: entry.size,
  hash: entry.hash,
  source: 'library',
  file: entry.inspection,
});
