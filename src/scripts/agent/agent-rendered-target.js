import { extractFormatFunctionBlocks } from '../ui/chat/format-repair-side-effect-utils.js';
import { buildLineDiff } from '../utils/line-diff-utils.js';

// This projection deliberately accepts only display lines that can be located in one
// immutable raw text node. It never guesses across inline markup, repeated text,
// rewritten regex output or script-generated content.
const BLOCKED_TAGS = new Set(['think', 'thinking', 'analysis', 'cot', 'reasoning', 'tableedit', 'update', 'updatevariable',
  'variableupdate', 'image_prompt', 'summary', 'abstract', '摘要', 'details', 'table', 'script', 'style', 'template',
  'head', 'noscript', 'svg', 'button', 'textarea', 'select']);
const HTML_TAGS = new Set(['html', 'body', 'main', 'article', 'section', 'div', 'p', 'span', 'b', 'strong', 'i', 'em', 'u',
  's', 'a', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'font', 'small']);
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'embed', 'area', 'base', 'col', 'param', 'track']);
const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™' });
const normalizeNewlines = text => String(text ?? '').replace(/\r\n?|\n/g, '\n');
const fail = (reason, message) => ({ ok: false, reason, message });
const unsafe = () => Object.assign(new Error('修改后的段落无法安全对应原文，请保留段落结构或改用指定部分'), { code: 'rendered_candidate_unmapped' });
const tagTokens = source => [...source.matchAll(/<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\s*(\/?)\s*([\p{L}][\p{L}\p{N}_:-]*)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>/gu)]
  .map(match => ({ start: match.index, end: match.index + match[0].length, raw: match[0],
    name: String(match[2] || '').toLowerCase(), closing: Boolean(match[1]),
    selfClosing: /\/\s*>$/.test(match[0]) || VOID_TAGS.has(String(match[2] || '').toLowerCase()) }));
const mergeRanges = (ranges, length) => {
  const sorted = ranges.filter(r => Number.isInteger(r?.start) && Number.isInteger(r?.end) && r.end > r.start)
    .map(r => ({ start: Math.max(0, r.start), end: Math.min(length, r.end) }))
    .filter(r => r.end > r.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
};

export const collectRenderedAgentExcludedRanges = (raw, extraRanges = []) => {
  const source = String(raw ?? ''), ranges = [...(Array.isArray(extraRanges) ? extraRanges : []), ...extractFormatFunctionBlocks(source)];
  const stack = [];
  for (const token of tagTokens(source)) {
    if (!token.name) { ranges.push(token); continue; }
    if (token.closing) {
      const index = stack.map(t => t.name).lastIndexOf(token.name);
      if (index >= 0) {
        for (const open of stack.slice(index)) if (open.blocked) ranges.push({ start: open.start, end: token.end });
        stack.length = index;
      }
    } else {
      // Inline hiding can be proven without evaluating CSS; external style rules are
      // handled by the caller's actual display projection, never executed here.
      const hidden = /\bhidden(?:\s|=|\/?>)|\baria-hidden\s*=\s*["']?true\b|\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(token.raw);
      const blocked = BLOCKED_TAGS.has(token.name) || hidden;
      if (token.selfClosing) { if (blocked) ranges.push(token); }
      else stack.push({ ...token, blocked });
    }
  }
  for (const open of stack) if (open.blocked) ranges.push({ start: open.start, end: source.length });
  return mergeRanges(ranges, source.length);
};

const decodeEntity = token => {
  const name = token.slice(1, -1);
  if (name[0] !== '#') return ENTITIES[name] ?? token;
  const value = /^#x[\da-f]+$/i.test(name) ? parseInt(name.slice(2), 16) : /^#\d+$/.test(name) ? Number(name.slice(1)) : NaN;
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value) : token;
};
const decodeWithOffsets = (source, start, end, entities) => {
  let text = ''; const starts = [], ends = [];
  for (let at = start; at < end;) {
    const from = at;
    const entity = entities && source[at] === '&' && source.slice(at, end).match(/^&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z]+);/);
    let value;
    if (entity) { value = decodeEntity(entity[0]); at += entity[0].length; }
    else if (source[at] === '\r') { value = '\n'; at += source[at + 1] === '\n' ? 2 : 1; }
    else { value = source[at]; at++; }
    text += value;
    for (let i = 0; i < value.length; i++) { starts.push(from); ends.push(at); }
  }
  return { text, starts, ends };
};
const textNodes = (source, excluded) => {
  const tokens = tagTokens(source), nodes = [], stack = [];
  let cursor = 0;
  const append = end => {
    let start = cursor;
    for (const range of excluded) {
      if (range.end <= start) continue;
      if (range.start >= end) break;
      if (range.start > start) nodes.push({ start, end: range.start, html: stack.some(name => HTML_TAGS.has(name)) });
      start = Math.max(start, range.end);
    }
    if (end > start) nodes.push({ start, end, html: stack.some(name => HTML_TAGS.has(name)) });
  };
  for (const token of tokens) {
    append(token.start);
    if (token.closing) { const index = stack.lastIndexOf(token.name); if (index >= 0) stack.length = index; }
    else if (token.name && !token.selfClosing) stack.push(token.name);
    cursor = token.end;
  }
  append(source.length);
  return nodes.map((node, id) => ({ ...node, id, variants: [decodeWithOffsets(source, node.start, node.end, false),
    ...(source.slice(node.start, node.end).includes('&') ? [decodeWithOffsets(source, node.start, node.end, true)] : [])] }));
};

export const resolveRenderedAgentTarget = (raw, displayText, { excludedRanges = [], maxChars = 40000 } = {}) => {
  const source = String(raw ?? ''), text = normalizeNewlines(displayText).trim();
  if (!source.trim()) return fail('empty_source', '这条回复没有可处理的文本');
  if (!text) return fail('empty_target', '没有识别到可处理的显示正文');
  if (text.length > maxChars || source.length > 240000) return fail('target_too_long', '处理文本过长，请缩小范围');
  const excluded = collectRenderedAgentExcludedRanges(source, excludedRanges), nodes = textNodes(source, excluded);
  const mapping = []; let previousEnd = -1;
  for (const line of text.split('\n')) {
    const core = line.trim();
    if (!core) { mapping.push(null); continue; }
    const matches = new Map();
    for (const node of nodes) for (const [variantIndex, variant] of node.variants.entries()) {
      for (let index = variant.text.indexOf(core); index >= 0; index = variant.text.indexOf(core, index + 1)) {
        const start = variant.starts[index], end = variant.ends[index + core.length - 1];
        // A display line cannot target half of a decoded astral entity.
        if ((index > 0 && variant.starts[index - 1] === start) || variant.ends[index + core.length] === end) continue;
        const key = `${start}:${end}`;
        if (!matches.has(key)) matches.set(key, { start, end, nodeId: node.id, html: node.html || variantIndex > 0, text: core });
      }
    }
    if (matches.size > 1) return fail('rendered_target_ambiguous', '显示正文在原文中重复出现，请改用指定部分');
    if (!matches.size) return fail('rendered_target_unmapped', '部分显示文字无法对应原文，请改用指定部分');
    const match = [...matches.values()][0];
    if (match.start < previousEnd) return fail('rendered_target_order', '显示顺序与原文不同，请改用指定部分');
    previousEnd = match.end; mapping.push(match);
  }
  const mapped = mapping.filter(Boolean);
  return { ok: true, mode: 'rendered', text, source, start: mapped[0].start, end: mapped.at(-1).end,
    mapping, excludedRanges: excluded, newline: source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n' };
};

const encodeReplacement = (value, span, newline) => span.html
  ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  : value.replace(/\n/g, newline);
const contiguous = (target, spans) => {
  if (!spans.length || spans.some(span => span.nodeId !== spans[0].nodeId || span.html !== spans[0].html)) return false;
  for (let i = 1; i < spans.length; i++) if (target.source.slice(spans[i - 1].end, spans[i].start).trim()) return false;
  return true;
};

// Returns raw text, or throws before any write if a requested paragraph change
// crosses markup/hidden text without a provable one-to-one correspondence.
export const spliceRenderedAgentTarget = (target, candidateText) => {
  if (!target?.ok || target.mode !== 'rendered' || !Array.isArray(target.mapping)) throw unsafe();
  const candidate = normalizeNewlines(candidateText);
  if (candidate === target.text) return target.source;
  if (candidate.length > 80000) throw unsafe();
  const spans = target.mapping.filter(Boolean), edits = [];
  // One contiguous source text node can freely gain/lose paragraphs. Outside
  // whitespace, HTML wrappers and hidden blocks remain byte-for-byte identical.
  if (contiguous(target, spans)) {
    const span = spans[0];
    return target.source.slice(0, span.start) + encodeReplacement(candidate, span, target.newline)
      + target.source.slice(spans.at(-1).end);
  }
  const rows = buildLineDiff(target.text, candidate, { collapseContext: false }).rows;
  let removed = [], added = [];
  const flush = () => {
    if (!removed.length && !added.length) return;
    const oldSpans = removed.map(row => target.mapping[row.oldLine - 1]).filter(Boolean);
    const newLines = added.map(row => row.text), nonemptyNew = newLines.filter(line => line.trim());
    if (!oldSpans.length || removed.some(row => !target.mapping[row.oldLine - 1])) {
      // A layout-only edit has no writable text span in multiple HTML nodes.
      // Reject it rather than silently showing a candidate different from raw.
      throw unsafe();
    } else if (contiguous(target, oldSpans)) {
      edits.push({ start: oldSpans[0].start, end: oldSpans.at(-1).end,
        text: encodeReplacement(newLines.join('\n'), oldSpans[0], target.newline) });
    } else if (oldSpans.length === nonemptyNew.length) {
      oldSpans.forEach((span, index) => edits.push({ start: span.start, end: span.end,
        text: encodeReplacement(nonemptyNew[index].trim(), span, target.newline) }));
    } else throw unsafe();
    removed = []; added = [];
  };
  for (const row of rows) {
    if (row.type === 'context') flush();
    else if (row.type === 'del') removed.push(row);
    else if (row.type === 'add') added.push(row);
  }
  flush();
  let result = target.source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
};
