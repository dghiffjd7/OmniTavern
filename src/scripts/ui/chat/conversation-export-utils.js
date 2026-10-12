import { pickSavePath as pickNativeSavePath } from '../../utils/save-dialog.js';
import { safeInvoke } from '../../utils/tauri.js';
import { hideCreativeContentTagsForDisplay } from './creative-content-display-utils.js';

const REASONING_KEYS = ['reasoning', 'reasoningDisplay', 'reasoningSource', 'reasoningHidden', 'reasoningLabel'];

const normalizeText = value => String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);

const escapeMarkdown = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/`/g, '\\`');

const stripBasicHtml = value => String(value ?? '')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/p\s*>/gi, '\n\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&amp;/gi, '&')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;/g, "'");

const formatDateTime = (value, { fallback = '' } = {}) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  try {
    return new Date(n).toLocaleString();
  } catch {
    return fallback;
  }
};

// ── 导出标记 v1：供「导入聊天记录」可靠拆分（Markdown 阅读器中不可见；TXT 以首行与角色后缀标示）。
// md：文件头 <!-- omnitavern-export v1 mode=rp|chat content=full|body count=N -->，
//     每条前 <!-- omnitavern-message index= role= name= ts= -->（值经 encodeURIComponent），
//     完整版的思考包在 <!-- omnitavern-reasoning --> … <!-- /omnitavern-reasoning --> 之间。
// txt：首行【OmniTavern 导出 v1 · 创意写作|聊天 · 完整|正文】，每条标题「[N] 名字（我|AI|系统）· 时间」，
//     完整版有思考时以【请求推理】…【正文】分段。
export const CONVERSATION_EXPORT_VERSION = 1;
export const CONVERSATION_EXPORT_MD_HEADER_PREFIX = '<!-- omnitavern-export';
export const CONVERSATION_EXPORT_MD_MESSAGE_PREFIX = '<!-- omnitavern-message';
export const CONVERSATION_EXPORT_MD_REASONING_OPEN = '<!-- omnitavern-reasoning -->';
export const CONVERSATION_EXPORT_MD_REASONING_CLOSE = '<!-- /omnitavern-reasoning -->';
export const CONVERSATION_EXPORT_TXT_HEADER_PREFIX = '【OmniTavern 导出 v';
export const CONVERSATION_EXPORT_TXT_REASONING = '【请求推理】';
export const CONVERSATION_EXPORT_TXT_BODY = '【正文】';
export const CONVERSATION_EXPORT_TXT_ROLE_SUFFIX = Object.freeze({ user: '（我）', assistant: '（AI）', system: '（系统）' });
const MODE_LABEL = { rp: '创意写作', chat: '聊天' };

// ── 附加数据 v1（只在「完整」导出）：记忆表格、摘要、变量，导入时可一起绑定到新存档。都放在文件最后。
// md：<!-- omnitavern-state v1 data=<base64(UTF-8 JSON)> -->（阅读器中不可见）；
// txt：一行【附加数据 v1 · …】，下一行为单行 JSON。
export const CONVERSATION_EXPORT_MD_STATE_PREFIX = '<!-- omnitavern-state';
export const CONVERSATION_EXPORT_TXT_STATE_PREFIX = '【附加数据 v';
const TXT_STATE_TITLE = `${CONVERSATION_EXPORT_TXT_STATE_PREFIX}${CONVERSATION_EXPORT_VERSION} · 记忆表格、摘要、变量，导入时用来还原】`;

const toFiniteNumber = value => (Number.isFinite(Number(value)) ? Number(value) : 0);
const normalizeSummaryItem = (item) => {
  if (typeof item === 'string') return item.trim() ? { at: 0, text: item.trim() } : null;
  const text = String(item?.text || '').trim();
  return text ? { at: toFiniteNumber(item.at), text } : null;
};

// 整理成可写进文件的附加数据；都没有内容时返回 null。表格行不带 id（导入时重新建）。
export const normalizeConversationTransferState = (state = null) => {
  if (!state || typeof state !== 'object') return null;
  const table = state.memoryTable && typeof state.memoryTable === 'object' ? state.memoryTable : null;
  const templateId = String(table?.templateId || '').trim();
  const rows = (Array.isArray(table?.rows) ? table.rows : [])
    .map((row) => {
      const tableId = String(row?.table_id || '').trim();
      if (!tableId) return null;
      return {
        table_id: tableId,
        row_data: row?.row_data && typeof row.row_data === 'object' ? JSON.parse(JSON.stringify(row.row_data)) : {},
        is_active: row?.is_active !== false,
        is_pinned: Boolean(row?.is_pinned),
        priority: toFiniteNumber(row?.priority),
        sort_order: toFiniteNumber(row?.sort_order),
      };
    })
    .filter(Boolean);
  const summaries = (Array.isArray(state.summaries) ? state.summaries : []).map(normalizeSummaryItem).filter(Boolean);
  const compactedSummary = state.compactedSummary ? normalizeSummaryItem(state.compactedSummary) : null;
  const rawVariables = state.variables;
  const variables = rawVariables && typeof rawVariables === 'object' && !Array.isArray(rawVariables) && Object.keys(rawVariables).length
    ? JSON.parse(JSON.stringify(rawVariables))
    : null;
  const memoryTable = templateId && rows.length ? { templateId, rows } : null;
  if (!memoryTable && !summaries.length && !compactedSummary && !variables) return null;
  return { memoryTable, summaries, compactedSummary, variables };
};

export const encodeConversationTransferState = state => bytesToBase64(new TextEncoder().encode(JSON.stringify(state)));

export const decodeConversationTransferState = (data = '') => {
  const binary = globalThis.atob(String(data || '').trim());
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};

const markerValue = value => encodeURIComponent(String(value ?? ''));
const buildMarkdownExportHeader = ({ sessionMode, mode, count }) =>
  `${CONVERSATION_EXPORT_MD_HEADER_PREFIX} v${CONVERSATION_EXPORT_VERSION} mode=${sessionMode === 'rp' ? 'rp' : 'chat'} content=${mode === 'full' ? 'full' : 'body'} count=${Number(count) || 0} -->`;
const buildMarkdownMessageMarker = ({ index, role, name, timestamp }) =>
  `${CONVERSATION_EXPORT_MD_MESSAGE_PREFIX} index=${index} role=${markerValue(role)} name=${markerValue(name)} ts=${Number(timestamp) > 0 ? Math.trunc(Number(timestamp)) : 0} -->`;
const buildTxtExportHeader = ({ sessionMode, mode }) =>
  `${CONVERSATION_EXPORT_TXT_HEADER_PREFIX}${CONVERSATION_EXPORT_VERSION} · ${MODE_LABEL[sessionMode === 'rp' ? 'rp' : 'chat']} · ${mode === 'full' ? '完整' : '正文'}】`;

const getRoleLabel = (message = {}) => {
  if (message.role === 'user') return message.name || '用户';
  if (message.role === 'assistant') return message.name || 'AI';
  if (message.role === 'system') return '系统';
  return message.role || '消息';
};

export const resolveConversationExportMessage = (message = {}) => {
  if (!message || typeof message !== 'object') return {};
  const meta = message.meta && typeof message.meta === 'object' ? message.meta : {};
  const swipes = Array.isArray(meta.swipes) && meta.swipes.length ? meta.swipes : null;
  if (!swipes) return { ...message, meta: { ...meta } };

  const rawIndex = Math.trunc(Number(meta.activeSwipe));
  const active = Number.isFinite(rawIndex) ? Math.min(Math.max(0, rawIndex), swipes.length - 1) : 0;
  const branch = swipes[active] && typeof swipes[active] === 'object' ? swipes[active] : {};
  const nextMeta = { ...meta, activeSwipe: active };
  const branchHasReasoning = REASONING_KEYS.some(key => hasOwn(branch, key));

  if (branchHasReasoning) {
    for (const key of REASONING_KEYS) {
      if (hasOwn(branch, key)) nextMeta[key] = branch[key];
      else delete nextMeta[key];
    }
  } else if (active > 0) {
    for (const key of REASONING_KEYS) delete nextMeta[key];
  }

  const out = {
    ...message,
    content: branch.content !== undefined ? branch.content : message.content,
    meta: nextMeta,
  };
  if (branch.raw !== undefined) out.raw = branch.raw;
  if (branch.rawSource !== undefined) out.rawSource = branch.rawSource;
  if (branch.rawOriginal !== undefined) out.rawOriginal = branch.rawOriginal;
  else if (active > 0) delete out.rawOriginal;
  return out;
};

export const getConversationMessageText = (message = {}, { mode = 'body' } = {}) => {
  const msg = resolveConversationExportMessage(message);
  const isFull = mode === 'full';
  let value = '';
  if (msg.role === 'assistant') {
    value = isFull
      ? (msg.rawOriginal ?? msg.rawSource ?? msg.raw_source ?? msg.raw ?? msg.content ?? '')
      : (msg.content ?? msg.raw ?? '');
    if (!isFull) value = hideCreativeContentTagsForDisplay(stripBasicHtml(value));
  } else if (msg.role === 'user') {
    value = isFull
      ? (msg.rawOriginal ?? msg.rawSource ?? msg.raw_source ?? msg.raw ?? msg.content ?? '')
      : (msg.content ?? msg.raw ?? '');
  } else {
    value = msg.content ?? msg.raw ?? '';
  }
  return normalizeText(value);
};

export const getConversationReasoningText = (message = {}) => {
  const msg = resolveConversationExportMessage(message);
  const meta = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
  return normalizeText(meta.reasoningDisplay ?? meta.reasoning ?? '');
};

export const formatConversationExport = ({
  messages = [],
  title = '聊天记录',
  sourceLabel = '当前聊天',
  mode = 'body',
  format = 'md',
  exportedAt = new Date(),
  sessionMode = 'chat',
  state = null,
} = {}) => {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const isFull = mode === 'full';
  const transferState = isFull ? normalizeConversationTransferState(state) : null;
  const isMarkdown = format === 'md';
  const exportedAtText = exportedAt instanceof Date ? exportedAt.toLocaleString() : String(exportedAt || '');
  const modeLabel = isFull ? '完整' : '正文';

  if (isMarkdown) {
    const lines = [
      buildMarkdownExportHeader({ sessionMode, mode, count: list.length }),
      `# ${escapeMarkdown(title || '聊天记录')}`,
      '',
      `- 来源：${escapeMarkdown(sourceLabel || '当前聊天')}`,
      `- 导出模式：${modeLabel}`,
      `- 导出时间：${escapeMarkdown(exportedAtText)}`,
      `- 消息数：${list.length}`,
      '',
      '---',
      '',
    ];
    list.forEach((message, index) => {
      const msg = resolveConversationExportMessage(message);
      const role = getRoleLabel(msg);
      const time = msg.time || formatDateTime(msg.timestamp);
      const text = getConversationMessageText(msg, { mode });
      const reasoning = isFull ? getConversationReasoningText(msg) : '';
      lines.push(buildMarkdownMessageMarker({ index: index + 1, role: msg.role, name: role, timestamp: msg.timestamp }));
      lines.push(`## ${index + 1}. ${escapeMarkdown(role)}${time ? ` · ${escapeMarkdown(time)}` : ''}`);
      if (reasoning) {
        lines.push('', CONVERSATION_EXPORT_MD_REASONING_OPEN, '**请求推理**', '', reasoning, CONVERSATION_EXPORT_MD_REASONING_CLOSE);
      }
      lines.push('', text || '（空）', '');
    });
    if (transferState) {
      lines.push('', `${CONVERSATION_EXPORT_MD_STATE_PREFIX} v${CONVERSATION_EXPORT_VERSION} data=${encodeConversationTransferState(transferState)} -->`);
    }
    return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
  }

  const lines = [
    buildTxtExportHeader({ sessionMode, mode }),
    title || '聊天记录',
    `来源：${sourceLabel || '当前聊天'}`,
    `导出模式：${modeLabel}`,
    `导出时间：${exportedAtText}`,
    `消息数：${list.length}`,
    '='.repeat(32),
    '',
  ];
  list.forEach((message, index) => {
    const msg = resolveConversationExportMessage(message);
    const role = getRoleLabel(msg);
    const time = msg.time || formatDateTime(msg.timestamp);
    const text = getConversationMessageText(msg, { mode });
    const reasoning = isFull ? getConversationReasoningText(msg) : '';
    const roleSuffix = CONVERSATION_EXPORT_TXT_ROLE_SUFFIX[msg.role] || '';
    lines.push(`[${index + 1}] ${role}${roleSuffix}${time ? ` · ${time}` : ''}`);
    if (reasoning) {
      lines.push('', CONVERSATION_EXPORT_TXT_REASONING, reasoning, '', CONVERSATION_EXPORT_TXT_BODY);
    } else {
      lines.push('');
    }
    lines.push(text || '（空）', '', '-'.repeat(32), '');
  });
  if (transferState) lines.push(TXT_STATE_TITLE, JSON.stringify(transferState), '');
  return lines.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n';
};

const safeFilenamePart = value => String(value || '')
  .trim()
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/\s+/g, '_')
  .replace(/_+/g, '_')
  .slice(0, 72) || 'chat';

export const buildConversationExportFilename = ({
  title = 'chat',
  mode = 'body',
  format = 'md',
  now = new Date(),
} = {}) => {
  const stamp = now instanceof Date
    ? [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('')
    : String(Date.now());
  const ext = format === 'txt' ? 'txt' : 'md';
  const modePart = mode === 'full' ? 'full' : 'body';
  return `${safeFilenamePart(title)}-${modePart}-${stamp}.${ext}`;
};

const bytesToBase64 = (bytes, encodeToBase64 = globalThis.btoa) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return encodeToBase64(binary);
};

export const buildTextDataUrl = (text, {
  mime = 'text/plain',
  TextEncoderRef = globalThis.TextEncoder,
  encodeToBase64 = globalThis.btoa,
} = {}) => {
  const bytes = new TextEncoderRef().encode(String(text || ''));
  return `data:${mime};charset=utf-8;base64,${bytesToBase64(bytes, encodeToBase64)}`;
};

export const exportConversationTextFile = async ({
  text = '',
  filename = '',
  format = 'md',
  globalRef = globalThis,
  navigatorRef = globalThis.navigator,
  documentRef = globalThis.document,
  BlobRef = globalThis.Blob,
  URLRef = globalThis.URL,
  pickSavePath = pickNativeSavePath,
  safeInvokeFn = safeInvoke,
  onSuccess = () => {},
} = {}) => {
  const content = String(text || '');
  if (!content.trim()) return false;
  const ext = format === 'txt' ? 'txt' : 'md';
  const mime = ext === 'md' ? 'text/markdown' : 'text/plain';
  const fileName = filename || `chat.${ext}`;
  const hasTauri = Boolean(globalRef?.__TAURI__ || globalRef?.__TAURI_INTERNALS__ || globalRef?.__TAURI_INVOKE__);
  const isAndroid = /android/i.test(String(navigatorRef?.userAgent || ''));

  if (!hasTauri) {
    const blob = new BlobRef([content], { type: `${mime};charset=utf-8` });
    const url = URLRef.createObjectURL(blob);
    const link = documentRef.createElement('a');
    link.href = url;
    link.download = fileName;
    link.style.display = 'none';
    documentRef.body.appendChild(link);
    link.click();
    link.remove();
    URLRef.revokeObjectURL(url);
    onSuccess?.(`聊天记录已导出：${fileName}`);
    return true;
  }

  let savedPath = '';
  const dataUrl = buildTextDataUrl(content, { mime });
  if (!isAndroid) {
    const pick = await pickSavePath({
      defaultName: fileName,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (pick.cancelled) return false;
    if (!pick.fallback && pick.path) {
      const resp = await safeInvokeFn('export_attachment', { dataUrl, fileName, path: pick.path });
      savedPath = String(resp?.path || pick.path || '').trim();
    }
  }
  if (!savedPath) {
    const resp = await safeInvokeFn('export_attachment', { dataUrl, fileName });
    savedPath = String(resp?.path || '').trim();
  }
  onSuccess?.(`聊天记录已导出：${savedPath || fileName}`);
  return true;
};
