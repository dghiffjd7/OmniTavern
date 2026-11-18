// 小管家写在气泡下方的两种内容：消息译文（meta.stewardTranslation）与自定义任务的附注（meta.stewardNote），可收起或删除。
// 记下翻译当时的原文指纹（sourceKey）；切换分支、编辑或重新生成后内容不同就不显示，避免对不上的译文。
// 译文不改原文，也不进模型上下文（组请求只读 content）。
import { t } from '../../i18n/index.js';

const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** 原文指纹：对当前显示的内容做简单哈希（只用来判断内容有没有变）。 */
export const messageTranslationKey = (message = {}) => {
  const source = String(message?.content ?? '');
  let hash = 5381;
  for (let i = 0; i < source.length; i += 1) hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  return `${source.length}:${hash.toString(36)}`;
};

const readSidecarMeta = (message, key) => {
  const value = isPlainObject(message?.meta?.[key]) ? message.meta[key] : null;
  if (!value || typeof value.text !== 'string' || !value.text.trim()) return null;
  return value.sourceKey === messageTranslationKey(message) ? value : null;
};

export const getMessageTranslation = (message = {}) => readSidecarMeta(message, 'stewardTranslation');
export const getMessageStewardNote = (message = {}) => readSidecarMeta(message, 'stewardNote');

export const buildMessageTranslationSignature = (message = {}) => {
  const translation = getMessageTranslation(message);
  const note = getMessageStewardNote(message);
  return translation || note
    ? JSON.stringify([translation?.text || '', translation?.languageLabel || '', note?.title || '', note?.text || ''])
    : '';
};

export const createMessageTranslation = ({ message = {}, text = '', language = null, now = Date.now() } = {}) => ({
  text: String(text),
  language: String(language?.id || ''),
  languageLabel: String(language?.label || ''),
  sourceKey: messageTranslationKey(message),
  at: Number(now) || Date.now(),
});

export const createMessageStewardNote = ({ message = {}, title = '', text = '', now = Date.now() } = {}) => ({
  title: String(title).slice(0, 40),
  text: String(text),
  sourceKey: messageTranslationKey(message),
  at: Number(now) || Date.now(),
});

export const MESSAGE_TRANSLATION_STYLES = Object.freeze({
  root: `
    width:min(100%, 560px);
    box-sizing:border-box;
    border:1px solid color-mix(in srgb, var(--app-accent-primary) 22%, var(--app-border-subtle));
    border-radius:10px;
    background:color-mix(in srgb, var(--app-accent-soft) 46%, var(--app-surface-card));
    overflow:hidden;
    font-size:13px;
    color:var(--app-text-primary);
  `,
  summary: `
    min-height:30px;
    display:flex;
    align-items:center;
    gap:6px;
    padding:5px 10px;
    box-sizing:border-box;
    cursor:pointer;
    list-style:none;
    color:var(--app-accent-strong, var(--app-accent-primary));
    font-size:11.5px;
    font-weight:700;
  `,
  body: `
    padding:0 10px 9px;
    line-height:1.6;
    white-space:pre-wrap;
    overflow-wrap:anywhere;
  `,
  remove: `
    margin-left:auto;
    padding:2px 8px;
    border:1px solid var(--app-border-subtle);
    border-radius:999px;
    background:var(--app-surface-card);
    color:var(--app-text-secondary);
    font-size:11px;
    cursor:pointer;
  `,
});

const buildSidecar = ({ documentLike, className, label, text, removeLabel, onRemove, message }) => {
  const root = documentLike.createElement('details');
  root.className = className;
  root.open = true;
  if (root.style) root.style.cssText = MESSAGE_TRANSLATION_STYLES.root;

  const summary = documentLike.createElement('summary');
  if (summary.style) summary.style.cssText = MESSAGE_TRANSLATION_STYLES.summary;
  const labelEl = documentLike.createElement('span');
  labelEl.textContent = label;
  summary.appendChild(labelEl);
  if (typeof onRemove === 'function') {
    const remove = documentLike.createElement('button');
    remove.type = 'button';
    remove.className = `${className}-remove`;
    remove.textContent = removeLabel;
    if (remove.style) remove.style.cssText = MESSAGE_TRANSLATION_STYLES.remove;
    remove.addEventListener?.('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onRemove(message);
    });
    summary.appendChild(remove);
  }
  root.appendChild(summary);

  const body = documentLike.createElement('div');
  body.className = `${className}-text`;
  body.dataset.i18nSkip = 'true';
  if (body.style) body.style.cssText = MESSAGE_TRANSLATION_STYLES.body;
  body.textContent = text;
  root.appendChild(body);
  return root;
};

export const buildMessageTranslationElement = ({
  documentLike = globalThis.document,
  message = {},
  onRemove = null,
} = {}) => {
  if (!documentLike?.createElement) return null;
  const translation = getMessageTranslation(message);
  if (!translation) return null;
  return buildSidecar({
    documentLike, message, onRemove,
    className: 'chat-message-translation',
    label: translation.languageLabel ? `${t('译文')} · ${translation.languageLabel}` : t('译文'),
    text: translation.text,
    removeLabel: t('删除译文'),
  });
};

// 自定义任务「显示在气泡下方」的结果：标题是任务名（用户写的，不翻译）
export const buildMessageStewardNoteElement = ({
  documentLike = globalThis.document,
  message = {},
  onRemove = null,
} = {}) => {
  if (!documentLike?.createElement) return null;
  const note = getMessageStewardNote(message);
  if (!note) return null;
  return buildSidecar({
    documentLike, message, onRemove,
    className: 'chat-message-steward-note',
    label: note.title ? `${t('小管家')} · ${note.title}` : t('小管家'),
    text: note.text,
    removeLabel: t('删除附注'),
  });
};
