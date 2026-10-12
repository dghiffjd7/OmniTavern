// 「导入聊天记录」：解析本 APP 导出的 md／txt，并整理成可写入存档的消息。
// v1 导出带隐藏标记（见 conversation-export-utils.js），按标记拆分，正文里出现「## 3.」之类的行不会误切；
// 旧版导出没有标记，按依序编号的标题拆分，角色按名字推测（导入前可在预览里改）。
import { stripTableEditBlocks } from '../../memory/memory-edit-parser.js';
import {
  CONVERSATION_EXPORT_MD_HEADER_PREFIX,
  CONVERSATION_EXPORT_MD_MESSAGE_PREFIX,
  CONVERSATION_EXPORT_MD_REASONING_CLOSE,
  CONVERSATION_EXPORT_MD_REASONING_OPEN,
  CONVERSATION_EXPORT_TXT_BODY,
  CONVERSATION_EXPORT_TXT_HEADER_PREFIX,
  CONVERSATION_EXPORT_TXT_REASONING,
  CONVERSATION_EXPORT_TXT_ROLE_SUFFIX,
  CONVERSATION_EXPORT_MD_STATE_PREFIX,
  CONVERSATION_EXPORT_TXT_STATE_PREFIX,
  decodeConversationTransferState,
  normalizeConversationTransferState,
} from './conversation-export-utils.js';
import { stripUpdateVariableBlocks } from './update-variable-block-utils.js';

export const CONVERSATION_IMPORT_MAX_CHARS = 20 * 1024 * 1024;
const TXT_MESSAGE_SEPARATOR = '-'.repeat(32);
const TXT_HEAD_SEPARATOR = '='.repeat(32);
const EMPTY_TEXT = '（空）';
const MD_REASONING_LABEL = '**请求推理**';
const TXT_MODE = { 创意写作: 'rp', 聊天: 'chat' };
const TXT_CONTENT = { 完整: 'full', 正文: 'body' };
const ROLES = ['user', 'assistant', 'system'];
const USER_NAME_HINTS = new Set(['我', '用户', 'user']);
const ASSISTANT_NAME_HINTS = new Set(['ai', '助手', 'assistant']);

const trimBlankLines = (lines) => {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
};

const joinText = (lines) => {
  const text = trimBlankLines(lines).join('\n');
  return text === EMPTY_TEXT ? '' : text;
};

const splitNameTime = (rest = '') => {
  const value = String(rest).trim();
  const at = value.lastIndexOf(' · ');
  return at < 0
    ? { name: value, time: '' }
    : { name: value.slice(0, at).trim(), time: value.slice(at + 3).trim() };
};

const unescapeMarkdown = value => String(value ?? '').replace(/\\([\\`])/g, '$1');

const parseMarkerAttrs = (line = '') => {
  const out = {};
  for (const match of String(line).matchAll(/(\w+)=([^\s]*)/g)) {
    try {
      out[match[1]] = decodeURIComponent(match[2]);
    } catch {
      out[match[1]] = match[2];
    }
  }
  return out;
};

const previousFilledLine = (lines, index) => {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (lines[i].trim()) return lines[i].trim();
  }
  return '';
};

const message = ({ role = '', name = '', time = '', timestamp = 0, text = '', reasoning = '' } = {}) => ({
  role: ROLES.includes(role) ? role : '',
  name: String(name || '').trim(),
  time: String(time || '').trim(),
  timestamp: Number(timestamp) > 0 ? Math.trunc(Number(timestamp)) : 0,
  text,
  reasoning,
});

const parseMarkdownV1 = (lines) => {
  const header = parseMarkerAttrs(lines[0]);
  const titleLine = lines.find(line => line.startsWith('# '));
  const starts = [];
  lines.forEach((line, index) => {
    if (!line.startsWith(CONVERSATION_EXPORT_MD_MESSAGE_PREFIX) || !line.trimEnd().endsWith('-->')) return;
    const attrs = parseMarkerAttrs(line.slice(CONVERSATION_EXPORT_MD_MESSAGE_PREFIX.length));
    const expected = starts.length + 1;
    // 真正的标记后面紧跟同编号的「## N.」标题；正文里抄来的标记行不算。
    if (Number(attrs.index) !== expected || !String(lines[index + 1] || '').startsWith(`## ${expected}. `)) return;
    starts.push({ index, attrs });
  });
  const messages = starts.map(({ index, attrs }, i) => {
    let block = lines.slice(index + 1, i + 1 < starts.length ? starts[i + 1].index : lines.length);
    let time = '';
    const heading = block[0]?.match(/^## \d+\. (.*)$/);
    if (heading) {
      time = unescapeMarkdown(splitNameTime(heading[1]).time);
      block = block.slice(1);
    }
    let reasoning = '';
    const body = trimBlankLines(block);
    if (body[0] === CONVERSATION_EXPORT_MD_REASONING_OPEN) {
      const close = body.indexOf(CONVERSATION_EXPORT_MD_REASONING_CLOSE);
      if (close > 0) {
        const inner = body.slice(1, close);
        if (inner[0] === MD_REASONING_LABEL) inner.shift();
        reasoning = joinText(inner);
        block = body.slice(close + 1);
      }
    }
    return message({ role: attrs.role, name: attrs.name, time, timestamp: attrs.ts, text: joinText(block), reasoning });
  });
  return {
    version: Number(lines[0].match(/ v(\d+)/)?.[1]) || 1,
    sessionMode: header.mode === 'rp' ? 'rp' : header.mode === 'chat' ? 'chat' : '',
    content: header.content === 'full' ? 'full' : header.content === 'body' ? 'body' : '',
    title: titleLine ? unescapeMarkdown(titleLine.slice(2)).trim() : '',
    messages,
  };
};

const parseMarkdownLegacy = (lines) => {
  const titleLine = lines.find(line => line.startsWith('# '));
  const starts = [];
  lines.forEach((line, index) => {
    const match = line.match(/^## (\d+)\. (.*)$/);
    if (!match || Number(match[1]) !== starts.length + 1) return;
    if (index > 0 && lines[index - 1].trim()) return;
    starts.push({ index, ...splitNameTime(match[2]) });
  });
  const messages = starts.map(({ index, name, time }, i) => message({
    name: unescapeMarkdown(name),
    time: unescapeMarkdown(time),
    text: joinText(lines.slice(index + 1, i + 1 < starts.length ? starts[i + 1].index : lines.length)),
  }));
  const contentLine = lines.find(line => line.startsWith('- 导出模式：'));
  return {
    version: 0,
    sessionMode: '',
    content: TXT_CONTENT[contentLine?.slice('- 导出模式：'.length).trim()] || '',
    title: titleLine ? unescapeMarkdown(titleLine.slice(2)).trim() : '',
    messages,
  };
};

const splitTxtRole = (name = '') => {
  for (const [role, suffix] of Object.entries(CONVERSATION_EXPORT_TXT_ROLE_SUFFIX)) {
    if (name.endsWith(suffix)) return { role, name: name.slice(0, -suffix.length) };
  }
  return null;
};

const parseTxt = (lines, { v1 }) => {
  const header = v1 ? lines[0].match(/^【OmniTavern 导出 v(\d+) · (.+?) · (.+?)】$/) : null;
  const title = (v1 ? lines[1] : lines[0])?.trim() || '';
  const headEnd = lines.indexOf(TXT_HEAD_SEPARATOR);
  const starts = [];
  for (let index = headEnd + 1; index > 0 && index < lines.length; index += 1) {
    const match = lines[index].match(/^\[(\d+)\] (.*)$/);
    if (!match || Number(match[1]) !== starts.length + 1) continue;
    const prev = previousFilledLine(lines, index);
    if (prev !== TXT_MESSAGE_SEPARATOR && prev !== TXT_HEAD_SEPARATOR) continue;
    const { name, time } = splitNameTime(match[2]);
    const tagged = splitTxtRole(name);
    if (v1 && !tagged) continue;
    starts.push({ index, name: tagged?.name ?? name, role: tagged?.role || '', time });
  }
  const messages = starts.map(({ index, name, role, time }, i) => {
    let block = trimBlankLines(lines.slice(index + 1, i + 1 < starts.length ? starts[i + 1].index : lines.length));
    if (block[block.length - 1] === TXT_MESSAGE_SEPARATOR) block = block.slice(0, -1);
    let reasoning = '';
    block = trimBlankLines(block);
    if (v1 && block[0] === CONVERSATION_EXPORT_TXT_REASONING) {
      const bodyAt = block.indexOf(CONVERSATION_EXPORT_TXT_BODY);
      if (bodyAt > 0) {
        reasoning = joinText(block.slice(1, bodyAt));
        block = block.slice(bodyAt + 1);
      }
    }
    return message({ role, name, time, text: joinText(block), reasoning });
  });
  const contentLine = lines.find(line => line.startsWith('导出模式：'));
  return {
    version: header ? Number(header[1]) || 1 : 0,
    sessionMode: TXT_MODE[header?.[2]] || '',
    content: TXT_CONTENT[header?.[3]] || TXT_CONTENT[contentLine?.slice('导出模式：'.length).trim()] || '',
    title,
    messages,
  };
};

// 旧版文件没有角色：「系统」为系统消息；「我／用户／user」「AI／助手／assistant」按名字；其余名字里平均篇幅最短的当作「我」。
export const guessConversationImportRoles = (messages = []) => {
  const list = Array.isArray(messages) ? messages : [];
  const stats = new Map();
  list.forEach((item) => {
    if (item.role) return;
    const entry = stats.get(item.name) || { count: 0, chars: 0 };
    entry.count += 1;
    entry.chars += String(item.text || '').length;
    stats.set(item.name, entry);
  });
  const roleByName = new Map();
  let hasUser = list.some(item => item.role === 'user');
  for (const name of stats.keys()) {
    if (name === '系统') roleByName.set(name, 'system');
    else if (USER_NAME_HINTS.has(name.toLowerCase())) {
      roleByName.set(name, 'user');
      hasUser = true;
    } else if (ASSISTANT_NAME_HINTS.has(name.toLowerCase())) roleByName.set(name, 'assistant');
  }
  const open = [...stats.entries()].filter(([name]) => !roleByName.has(name));
  if (!hasUser && open.length > 1) {
    const [shortest] = open.slice().sort((a, b) => a[1].chars / a[1].count - b[1].chars / b[1].count)[0];
    roleByName.set(shortest, 'user');
  }
  open.forEach(([name]) => { if (!roleByName.has(name)) roleByName.set(name, 'assistant'); });
  return list.map(item => (item.role ? item : { ...item, role: roleByName.get(item.name) || 'assistant' }));
};

// 文件最后的附加数据（记忆表格、摘要、变量）：取出后从正文里去掉，免得并进最后一条消息。
// 标记认得但内容坏掉时仍去掉，state 为 null。
const extractTransferState = (lines, format) => {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end -= 1;
  const last = String(lines[end - 1] || '').trim();
  try {
    if (format === 'md' && last.startsWith(CONVERSATION_EXPORT_MD_STATE_PREFIX) && last.endsWith('-->')) {
      const data = parseMarkerAttrs(last.slice(CONVERSATION_EXPORT_MD_STATE_PREFIX.length)).data;
      return { lines: lines.slice(0, end - 1), state: normalizeConversationTransferState(decodeConversationTransferState(data)) };
    }
    if (format === 'txt' && String(lines[end - 2] || '').startsWith(CONVERSATION_EXPORT_TXT_STATE_PREFIX) && last.startsWith('{')) {
      return { lines: lines.slice(0, end - 2), state: normalizeConversationTransferState(JSON.parse(last)) };
    }
  } catch {
    return { lines: lines.slice(0, format === 'md' ? end - 1 : end - 2), state: null };
  }
  return { lines, state: null };
};

// 返回 { ok, format, version, sessionMode, content, title, messages, rolesGuessed, state } 或 { ok:false, error }。
// state：完整版导出带的 { memoryTable, summaries, compactedSummary, variables }，没有时为 null。
// sessionMode：rp｜chat｜''（旧版未知）；content：full｜body｜''。
export const parseConversationExport = (rawText = '') => {
  const text = String(rawText ?? '');
  if (text.length > CONVERSATION_IMPORT_MAX_CHARS) return { ok: false, error: 'too_large' };
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const first = lines.findIndex(line => line.trim());
  if (first < 0) return { ok: false, error: 'empty' };
  const body = lines.slice(first);
  const head = body[0].trim();
  let format = '';
  let parse = null;
  if (head.startsWith(CONVERSATION_EXPORT_MD_HEADER_PREFIX)) {
    format = 'md';
    parse = parseMarkdownV1;
  } else if (head.startsWith(CONVERSATION_EXPORT_TXT_HEADER_PREFIX)) {
    format = 'txt';
    parse = content => parseTxt(content, { v1: true });
  } else if (head.startsWith('# ') && body.some(line => line.startsWith('## 1. '))) {
    format = 'md';
    parse = parseMarkdownLegacy;
  } else if (body.includes(TXT_HEAD_SEPARATOR) && body.some(line => line.startsWith('[1] '))) {
    format = 'txt';
    parse = content => parseTxt(content, { v1: false });
  }
  if (!parse) return { ok: false, error: 'unrecognized' };
  const extracted = extractTransferState(body, format);
  const parsed = parse(extracted.lines);
  if (!parsed.messages.length) return { ok: false, error: 'no_messages' };
  const rolesGuessed = parsed.messages.some(item => !item.role);
  return {
    ok: true,
    format,
    ...parsed,
    messages: rolesGuessed ? guessConversationImportRoles(parsed.messages) : parsed.messages,
    rolesGuessed,
    state: extracted.state,
  };
};

// 整理成聊天消息。AI 原文另存为 rawOriginal（与平常回复相同，可在「编辑原文」里看到）；
// 显示用的正文去掉变量与表格更新块，导入后不会再执行。没有时间戳的按顺序补，最后一条为导入时刻。
export const buildImportedConversationMessages = (messages = [], { sessionMode = 'chat', now = Date.now() } = {}) => {
  const list = Array.isArray(messages) ? messages : [];
  const isRp = sessionMode === 'rp';
  return list.map((item, index) => {
    const role = ROLES.includes(item?.role) ? item.role : 'assistant';
    const text = String(item?.text ?? '');
    const timestamp = Number(item?.timestamp) > 0 ? Number(item.timestamp) : now - (list.length - 1 - index) * 1000;
    const base = { role, type: 'text', timestamp };
    if (item?.time) base.time = item.time;
    if (role !== 'system' && item?.name) base.name = item.name;
    const reasoning = String(item?.reasoning || '');
    if (role !== 'assistant') return { ...base, content: text, raw: text };
    const shown = stripTableEditBlocks(stripUpdateVariableBlocks(text));
    const meta = isRp ? { renderRich: true } : {};
    if (reasoning) meta.reasoning = reasoning;
    const out = { ...base, content: shown, raw: shown, rawOriginal: text, meta };
    if (isRp) out.rawSource = shown;
    return out;
  });
};
