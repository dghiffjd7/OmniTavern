// 生图途中的中间画面（NovelAI、OpenAI 等流式渠道）：按「哪条消息的哪张图」记下最新一张，在原位显示。
// 只在内存，不保存；生成结束（成功、失败、取消）就清掉，消息重画后照常显示成图或错误。
// 定位：消息外层 [data-msg-id] 里带 data-image-preview-token 的占位（渲染器建的），
// 或重新生成时的旧图 img[data-generated-image-token]（预览期间换成中间画面，结束后还原）。
// 更新直接改这些元素，不重画整条消息；限频，重画后的新占位下一轮就补上。
import { t } from '../../i18n/index.js';

export const IMAGE_PREVIEW_JOB_TOKEN = 'job';
const STYLE_ID = 'image-generation-preview-style';
// 预览图的尺寸上限与最终图相同（qq-legacy.css `.QQ_chat_msgdiv img.previewable` 的 240×240），画完不会突然缩小。
const STYLE = `
.image-gen-preview { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 6px; max-width: 100%; vertical-align: top; }
.image-gen-preview-frame { position: relative; display: none; width: fit-content; max-width: 100%; border-radius: 12px; overflow: hidden; background: var(--app-surface-subtle, #f1f5f9); box-shadow: 0 1px 3px rgba(15, 23, 42, .08); }
.image-gen-preview.has-preview .image-gen-preview-frame { display: block; }
.image-gen-preview-img { display: block; width: auto; height: auto; max-width: min(240px, 100%); max-height: 240px; }
.image-gen-preview-bar { position: absolute; left: 0; bottom: 0; height: 3px; width: 0; background: var(--app-accent-primary, #2563eb); transition: width 120ms linear; }
.image-gen-preview-label { display: inline-flex; align-items: flex-start; gap: 6px; font-size: 12.5px; line-height: 1.5; color: var(--app-text-secondary, #475569); font-variant-numeric: tabular-nums; white-space: pre-wrap; overflow-wrap: anywhere; }
.image-gen-preview-label::before { content: ''; flex: 0 0 auto; width: 7px; height: 7px; margin-top: .5em; border-radius: 50%; background: var(--app-accent-primary, #2563eb); animation: image-gen-preview-pulse 1.2s ease-in-out infinite; }
img.is-image-gen-previewing { filter: saturate(.92); outline: 2px solid color-mix(in srgb, var(--app-accent-primary, #2563eb) 45%, transparent); outline-offset: -2px; }
@keyframes image-gen-preview-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
body[data-reduced-motion='on'] .image-gen-preview-label::before { animation: none; }
@media (prefers-reduced-motion: reduce) { .image-gen-preview-label::before { animation: none; } .image-gen-preview-bar { transition: none; } }
`;

export const injectImageGenerationPreviewStyle = (documentRef = globalThis.document) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = STYLE;
  documentRef.head.appendChild(style);
};

const quote = value => String(value ?? '').replace(/["\\]/g, '\\$&');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const progressLabel = entry => (entry?.total > 0 && entry.step > 0
  ? t('生成中 {step}/{total}', { step: Math.min(entry.step, entry.total), total: entry.total })
  : t('图片生成中'));

/** 占位的 HTML（富文本的字串渲染路径用）；token 是消息里的占位记号，或 IMAGE_PREVIEW_JOB_TOKEN。 */
export const buildImagePreviewPlaceholderHtml = (token = '', label = t('图片生成中')) => {
  injectImageGenerationPreviewStyle();
  return [
  `<span class="image-gen-preview" data-image-preview-token="${escapeHtml(token)}">`,
  '<span class="image-gen-preview-frame"><img class="image-gen-preview-img" alt=""><span class="image-gen-preview-bar"></span></span>',
  `<span class="image-gen-preview-label">${escapeHtml(label)}</span>`,
  '</span>',
  ].join('');
};

/** 占位元素（DOM 渲染路径用）。 */
export const createImagePreviewPlaceholder = (documentRef, token = '', label = t('图片生成中')) => {
  if (!documentRef?.createElement) return null;
  injectImageGenerationPreviewStyle(documentRef);
  const root = documentRef.createElement('span');
  root.className = 'image-gen-preview';
  root.dataset.imagePreviewToken = token;
  const frame = documentRef.createElement('span');
  frame.className = 'image-gen-preview-frame';
  const img = documentRef.createElement('img');
  img.className = 'image-gen-preview-img';
  img.alt = '';
  const bar = documentRef.createElement('span');
  bar.className = 'image-gen-preview-bar';
  frame.appendChild(img);
  frame.appendChild(bar);
  const text = documentRef.createElement('span');
  text.className = 'image-gen-preview-label';
  text.textContent = label;
  root.appendChild(frame);
  root.appendChild(text);
  return root;
};

export const createImageGenerationPreviews = ({
  documentRef = globalThis.document,
  schedule = fn => setTimeout(fn, 80),
} = {}) => {
  const entries = new Map(); // `${messageId}\n${token}` → { messageId, token, dataUrl, step, total }
  const swapped = new Map(); // 重新生成时被换成预览的旧图：元素 → { key, token, src }（原本的 src）
  let timer = null;

  const findTargets = (entry) => {
    const scope = `[data-msg-id="${quote(entry.messageId)}"]`;
    const token = quote(entry.token);
    const nodes = documentRef?.querySelectorAll?.(`${scope} [data-image-preview-token="${token}"], ${scope} img[data-generated-image-token="${token}"]`);
    return nodes ? Array.from(nodes) : [];
  };

  const paint = (node, entry) => {
    if (node.tagName === 'IMG') {
      if (!entry.dataUrl) return;
      if (!swapped.has(node)) swapped.set(node, { key: entry.key, token: entry.token, src: node.getAttribute?.('src') ?? node.src });
      if (node.src !== entry.dataUrl) node.src = entry.dataUrl;
      node.classList?.add?.('is-image-gen-previewing');
      return;
    }
    const img = node.querySelector?.('.image-gen-preview-img');
    if (entry.dataUrl && img && img.src !== entry.dataUrl) img.src = entry.dataUrl;
    if (entry.dataUrl) node.classList?.add?.('has-preview');
    const bar = node.querySelector?.('.image-gen-preview-bar');
    if (bar?.style) bar.style.width = entry.total > 0 ? `${Math.min(100, (entry.step / entry.total) * 100)}%` : '0%';
    const label = node.querySelector?.('.image-gen-preview-label');
    if (label) label.textContent = progressLabel(entry);
  };

  const flush = () => {
    timer = null;
    for (const entry of entries.values()) findTargets(entry).forEach(node => paint(node, entry));
  };

  /** 收到一张中间画面：{ dataUrl, step, total }。 */
  const update = (messageId, token, preview = {}) => {
    const id = String(messageId || '').trim();
    if (!id || !token) return;
    injectImageGenerationPreviewStyle(documentRef);
    entries.set(`${id}\n${token}`, {
      key: `${id}\n${token}`,
      messageId: id,
      token: String(token),
      dataUrl: String(preview.dataUrl || ''),
      step: Number(preview.step) || 0,
      total: Number(preview.total) || 0,
    });
    if (!timer) timer = schedule(flush);
  };

  /** 生成结束：清掉记录；被换成预览的旧图还原（成功时消息随即重画成新图）。 */
  const finish = (messageId, token) => {
    const key = `${String(messageId || '').trim()}\n${token}`;
    entries.delete(key);
    for (const [node, record] of swapped) {
      if (record.key !== key) continue;
      // 还是旧图（失败、取消）就还原；已原地换成新图（记号变了）就只去掉预览样式
      if (node.dataset?.generatedImageToken === record.token && record.src) node.src = record.src;
      node.classList?.remove?.('is-image-gen-previewing');
      swapped.delete(node);
    }
  };

  const get = (messageId, token) => entries.get(`${String(messageId || '').trim()}\n${token}`) || null;

  return { update, finish, get, flush };
};

// 全 APP 共用一份：渲染器与生图流程都用它
export const imageGenerationPreviews = createImageGenerationPreviews();
