import { getGeneratedImageReferenceItems, normalizeImageGenerationReferenceItems } from './image-generation-reference-utils.js';

// Image bytes live in session attachments. The small session library also finds
// duplicates whose generation messages have not been paged into memory yet.
export const collectStoredImageReferences = ({ messages = [], assets = [] } = {}) => [
  ...assets,
  ...messages.flatMap(message => [message?.meta?.generatedMedia, ...(message?.meta?.generatedInlineImages || [])]),
].flatMap(asset => getGeneratedImageReferenceItems(asset));

const fingerprint = async (dataUrl) => {
  const match = /^data:(image\/[^;,]+);base64,([\s\S]+)$/i.exec(dataUrl);
  if (!match) return null;
  const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  return { hash, mime: match[1].toLowerCase(), bytes: bytes.length };
};

export const createImageGenerationReferenceStore = ({ saveDataUrl, readDataUrl, listReferences = () => [], getLibrary = () => ({}), logger = console } = {}) => {
  const pending = new Map();
  const cached = new Map();

  const load = async (references = [], sessionId = '') => {
    const out = [];
    for (const [index, item] of references.entries()) {
      if (!item?.path) {
        out.push(...normalizeImageGenerationReferenceItems([item], { supported: true, max: 1 }));
        continue;
      }
      try {
        const dataUrl = await readDataUrl(item, sessionId);
        if (!String(dataUrl || '').startsWith('data:image/')) throw new Error('invalid reference image');
        out.push({ dataUrl, name: item.name || '', mime: item.mime || '', size: item.bytes || 0 });
      } catch (cause) {
        throw new Error(`参考图 ${index + 1} 读取失败，请重新附加后再生成`, { cause });
      }
    }
    return out;
  };

  const persistOne = async (item, sessionId) => {
    const library = getLibrary(sessionId);
    const dataUrl = typeof item === 'string' ? item : item?.dataUrl || item?.url || '';
    const info = await fingerprint(dataUrl);
    if (!info) return item; // Legacy remote URLs retain their original representation.
    const key = `${sessionId}:${info.hash}`;
    if (!pending.has(key)) {
      const task = (async () => {
        const existing = cached.get(key) || [...(library.items || []), ...listReferences(sessionId)].find(ref => ref.path && ref.hash === info.hash && ref.sessionId === sessionId);
        if (existing) {
          // Session deletion/import or manual file removal may invalidate a cache hit.
          try {
            const saved = await readDataUrl(existing, sessionId);
            if ((await fingerprint(saved))?.hash === info.hash) return existing;
          } catch {}
        }
        const extension = info.mime === 'image/jpeg' ? 'jpg' : info.mime.split('/')[1];
        const saved = await saveDataUrl(dataUrl, `image_reference_${info.hash.slice(0, 16)}.${extension}`, { sessionId });
        const path = typeof saved === 'string' ? saved : saved?.path;
        if (!path) throw new Error('reference image persistence failed');
        const reference = { path, sessionId, ...info };
        cached.set(key, reference);
        return reference;
      })();
      pending.set(key, task);
      task.finally(() => { if (pending.get(key) === task) pending.delete(key); }).catch(() => {});
    }
    const saved = await pending.get(key);
    library.remember?.(saved);
    return { ...saved, name: String(item?.name || '') };
  };

  const persist = async (references = [], sessionId = '') => {
    const out = [];
    for (const item of references) {
      try { out.push(await persistOne(item, sessionId)); }
      catch (error) {
        // Never lose a paid generation or its references if the disk is unavailable.
        logger?.warn?.('reference attachment persistence failed; keeping inline reference', error);
        out.push(item);
      }
    }
    return out;
  };

  // Individual asset deletion retains shared inputs; session attachment cleanup
  // owns their lifetime, including references used by in-flight generations.
  return { persist, load };
};
