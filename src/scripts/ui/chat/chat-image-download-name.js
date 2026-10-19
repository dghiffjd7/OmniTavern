// 聊天图片下载的文件名。
// 生成图：「角色名_生成时间」（同一次生成的第 2 张起加 _2、_3），同一张图每次下载同名、不同图不会撞名；
// 用户发的图：原文件名；都没有时用「发送者_时间」。不用图片地址（本机路径编码后又长又一样）。

const pad = value => String(value).padStart(2, '0');

const toDate = (value) => {
  if (value instanceof Date) return value;
  const numeric = Number(value);
  const time = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(String(value ?? ''));
  return new Date(Number.isFinite(time) && time > 0 ? time : Date.now());
};

// 20261016-173512（本地时间）
export const formatFileTimestamp = (value) => {
  const date = toDate(value);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};

// 文件名里的一段：去掉非法字符与控制字符，空白改下划线，按字符截断（中文不被截半）
export const safeFileNamePart = (value, maxChars = 40) => Array.from(
  String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, ''),
).slice(0, maxChars).join('');

const extensionOf = name => (String(name ?? '').toLowerCase().match(/\.([a-z0-9]{1,5})$/)?.[1] || '');

// 存储文件名 generated_image_<毫秒>_<序号>.png 里的序号（同一次生成的第几张）
const generatedIndexOf = (path) => {
  const base = String(path ?? '').split(/[\\/]/).pop() || '';
  return Number(base.match(/generated_image_\d+_(\d+)\./)?.[1] || 0);
};

/**
 * message：聊天消息（type image）；characterName：当前会话的角色／联系人名；ext：不带点的扩展名。
 */
export const resolveChatImageDownloadName = (message = {}, { characterName = '', ext = 'png' } = {}) => {
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
  const extension = String(ext || 'png').replace(/^\./, '').toLowerCase() || 'png';
  const generated = meta.generatedMedia && typeof meta.generatedMedia === 'object' ? meta.generatedMedia : null;
  if (generated) {
    const who = safeFileNamePart(characterName) || '生成图片';
    const index = generatedIndexOf(meta.localPath || generated.output?.path);
    return `${who}_${formatFileTimestamp(generated.createdAt || message.timestamp)}${index > 1 ? `_${index}` : ''}.${extension}`;
  }
  const original = safeFileNamePart(meta.originalName, 80);
  if (original) return extensionOf(original) ? original : `${original}.${extension}`;
  const who = safeFileNamePart(message?.name || characterName) || '图片';
  return `${who}_${formatFileTimestamp(message?.timestamp || meta.savedAt)}.${extension}`;
};
