const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);

export const isImageAttachmentFile = (file = null) => {
  if (!file) return false;
  const type = trim(file.type).toLowerCase();
  if (type.startsWith('image/')) return true;
  const name = trim(file.name).toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return IMAGE_EXTENSIONS.has(ext);
};

const collectFilesFromItems = (items = []) => {
  const files = [];
  Array.from(items || []).forEach((item) => {
    if (!item) return;
    if (typeof item.getAsFile === 'function') {
      const file = item.getAsFile();
      if (file) files.push(file);
      return;
    }
    if (typeof File !== 'undefined' && item instanceof File) files.push(item);
  });
  return files;
};

// 取出剪贴板／拖放里的全部文件（去重）；filter 为空时不按类型过滤
export const collectFilesFromDataTransfer = (dataTransfer = null, { filter = null } = {}) => {
  if (!dataTransfer) return [];
  const files = [];
  if (dataTransfer.files?.length) files.push(...Array.from(dataTransfer.files));
  if (dataTransfer.items?.length) files.push(...collectFilesFromItems(dataTransfer.items));
  const seen = new Set();
  return files
    .filter(file => (typeof filter === 'function' ? filter(file) : true))
    .filter((file) => {
      const key = `${trim(file.name)}:${trim(file.type)}:${Number(file.size || 0)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

export const collectImageFilesFromDataTransfer = (dataTransfer = null) => (
  collectFilesFromDataTransfer(dataTransfer, { filter: isImageAttachmentFile })
);

export const collectImageFilesFromPasteEvent = (event = null) => (
  collectImageFilesFromDataTransfer(event?.clipboardData || null)
);

export const collectImageFilesFromDropEvent = (event = null) => (
  collectImageFilesFromDataTransfer(event?.dataTransfer || null)
);

export const eventHasImageFiles = (event = null) => {
  const transfer = event?.dataTransfer || event?.clipboardData || null;
  if (!transfer) return false;
  if (collectImageFilesFromDataTransfer(transfer).length > 0) return true;
  const types = Array.from(transfer.types || []).map(item => trim(item).toLowerCase());
  return types.some(type => type === 'files' || type.startsWith('image/'));
};

export const createImageAttachmentFromFile = async (file = null, {
  readFileAsDataUrl = null,
  compressImageDataUrl = null,
  isGifFile = null,
  maxDim = 1280,
  quality = 0.82,
  maxBytes = 1_200_000,
  mime = 'image/jpeg',
  source = '',
} = {}) => {
  if (!isImageAttachmentFile(file)) return null;
  if (typeof readFileAsDataUrl !== 'function') return null;
  const rawDataUrl = await readFileAsDataUrl(file);
  if (!trim(rawDataUrl)) return null;
  let url = rawDataUrl;
  const keepOriginal = typeof isGifFile === 'function' && isGifFile(file);
  if (!keepOriginal && typeof compressImageDataUrl === 'function') {
    try {
      const compressed = await compressImageDataUrl(rawDataUrl, {
        maxDim,
        quality,
        maxBytes,
        mime,
      });
      if (trim(compressed)) url = compressed;
    } catch {}
  }
  return {
    kind: 'image',
    url,
    name: trim(file?.name),
    mime: trim(file?.type),
    size: Number(file?.size || 0) || 0,
    source: trim(source),
  };
};

export const createImageAttachmentsFromFiles = async (files = [], options = {}) => {
  const attachments = [];
  for (const file of Array.from(files || [])) {
    const attachment = await createImageAttachmentFromFile(file, options);
    if (attachment) attachments.push(attachment);
  }
  return attachments;
};
