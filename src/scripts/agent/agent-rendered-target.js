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

// 可见字投影（仅快速编辑启用）：把标签、隐藏块与成对的 Markdown 记号视为透明，逐字记下每个可见字在原文中的位置。
// 用于显示行跨过标签或记号、无法落在单个文本节点内的情况；只认成对记号，单个 * 等字面字符保持可见。
const MARKDOWN_PAIR = /(\*\*\*|\*\*|\*|~~|`)(?=[^\s*~`])([^\n]*?[^\s*~`\\])\1/g;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((?:[^()\s]|\([^()\s]*\))+(?:\s+"[^"\n]*")?\)/g;
const markdownMarkers = text => {
  const hidden = new Set(), pairs = [];
  const mark = (from, to) => { for (let i = from; i < to; i++) hidden.add(i); };
  const scan = (from, to) => {
    const slice = text.slice(from, to);
    for (const match of slice.matchAll(MARKDOWN_LINK)) {
      const start = from + match.index, labelEnd = start + 1 + match[1].length;
      mark(start, start + 1); mark(labelEnd, start + match[0].length);
      pairs.push({ open: [start, start + 1], close: [labelEnd, start + match[0].length] });
    }
    for (const match of slice.matchAll(MARKDOWN_PAIR)) {
      const start = from + match.index, width = match[1].length, end = start + match[0].length;
      if ([...Array(match[0].length).keys()].some(i => hidden.has(start + i) && !(i >= width && i < match[0].length - width))) continue;
      mark(start, start + width); mark(end - width, end);
      pairs.push({ open: [start, start + width], close: [end - width, end] });
      if (match[1] !== '`') scan(start + width, end - width);
    }
  };
  scan(0, text.length);
  return { hidden, pairs };
};
const buildVisibleProjection = nodes => {
  let text = ''; const chars = [], pairs = [];
  for (const node of nodes) {
    const variant = node.variants.at(-1);
    const { hidden, pairs: nodePairs } = markdownMarkers(variant.text);
    const indexOf = new Map();
    for (let i = 0; i < variant.text.length; i++) {
      if (hidden.has(i)) continue;
      indexOf.set(i, chars.length);
      text += variant.text[i];
      chars.push({ start: variant.starts[i], end: variant.ends[i], html: node.html, nodeId: node.id });
    }
    for (const pair of nodePairs) {
      const inner = [...indexOf.entries()].filter(([i]) => i >= pair.open[1] && i < pair.close[0]).map(([, at]) => at);
      pairs.push({ open: { start: variant.starts[pair.open[0]], end: variant.ends[pair.open[1] - 1] },
        close: { start: variant.starts[pair.close[0]], end: variant.ends[pair.close[1] - 1] }, inner });
    }
  }
  return { text, chars, pairs };
};
const findAll = (text, core) => {
  const found = [];
  for (let index = text.indexOf(core); index >= 0; index = text.indexOf(core, index + 1)) found.push(index);
  return found;
};

// 快速编辑（allowProjected）时，选区首尾与每行行首行尾的空白（含全角空格）只要在原文里紧挨着所选文字、逐字相同，
// 就纳入编辑范围；原文里没有的（显示时加上的缩进等）不纳入。不跨过标签、记号或隐藏块去对应空白。
// collapseSpaces：气泡会合并连续空白（white-space: normal）时，显示的一个半角空格对应原文一整串半角空格或 Tab。
const extendEdgeSpaces = (entry, lead, trail, source, excluded, floor, collapseSpaces) => {
  const blocked = at => excluded.some(range => at >= range.start && at < range.end);
  const run = ch => collapseSpaces && ch === ' ';
  const fits = (at, ch) => at >= floor && at < source.length && !blocked(at) && (run(ch) ? /[ \t]/.test(source[at]) : source[at] === ch);
  let start = entry.start, end = entry.end;
  for (let i = lead.length - 1; i >= 0 && fits(start - 1, lead[i]); i--) {
    start--;
    if (run(lead[i])) while (fits(start - 1, ' ')) start--;
  }
  for (let i = 0; i < trail.length && fits(end, trail[i]); i++) {
    end++;
    if (run(trail[i])) while (fits(end, ' ')) end++;
  }
  const space = at => ({ start: at, end: at + 1, html: entry.html, nodeId: entry.nodeId });
  return { ...entry, start, end, edges: true, text: source.slice(start, entry.start) + entry.text + source.slice(entry.end, end),
    ...(entry.chars ? { chars: [...Array.from({ length: entry.start - start }, (_, i) => space(start + i)), ...entry.chars,
      ...Array.from({ length: end - entry.end }, (_, i) => space(entry.end + i))] } : {}) };
};

export const resolveRenderedAgentTarget = (raw, displayText, { excludedRanges = [], maxChars = 40000, allowProjected = false, collapseSpaces = false } = {}) => {
  const normalized = normalizeNewlines(displayText);
  // 快速编辑只去掉首尾的空行，保留第一行行首、最后一行行尾的空白，由 extendEdgeSpaces 判断能否编辑
  const source = String(raw ?? ''), text = allowProjected ? normalized.replace(/^\s*\n/, '').replace(/\n\s*$/, '') : normalized.trim();
  if (!source.trim()) return fail('empty_source', '这条回复没有可处理的文本');
  if (!text.trim()) return fail('empty_target', '没有识别到可处理的显示正文');
  if (text.length > maxChars || source.length > 240000) return fail('target_too_long', '处理文本过长，请缩小范围');
  const excluded = collectRenderedAgentExcludedRanges(source, excludedRanges), nodes = textNodes(source, excluded);
  const mapping = []; let previousEnd = -1, projection = null, projected = false;
  const edges = line => {
    const core = line.trim(), at = line.indexOf(core);
    return { lead: line.slice(0, at), trail: line.slice(at + core.length) };
  };
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
    if (!matches.size && allowProjected) {
      projection ||= buildVisibleProjection(nodes);
      const found = findAll(projection.text, core);
      if (found.length > 1) return fail('rendered_target_ambiguous', '显示正文在原文中重复出现，请改用指定部分');
      if (found.length === 1) {
        const chars = projection.chars.slice(found[0], found[0] + core.length);
        if (chars[0].start < previousEnd) return fail('rendered_target_order', '显示顺序与原文不同，请改用指定部分');
        const { lead, trail } = edges(line);
        const entry = extendEdgeSpaces({ start: chars[0].start, end: chars.at(-1).end, nodeId: chars[0].nodeId, html: chars[0].html, text: core, projected: true, chars },
          lead, trail, source, excluded, previousEnd, collapseSpaces);
        previousEnd = entry.end; projected = true; mapping.push(entry);
        continue;
      }
    }
    if (!matches.size) return fail('rendered_target_unmapped', '部分显示文字无法对应原文，请改用指定部分');
    // 记号渲染后可能让同一句在显示中出现多次（如 *好的*。与 好的。），严格匹配只看到一处也要按显示判断唯一。
    if (allowProjected) {
      projection ||= buildVisibleProjection(nodes);
      if (findAll(projection.text, core).length > 1) return fail('rendered_target_ambiguous', '显示正文在原文中重复出现，请改用指定部分');
    }
    let match = [...matches.values()][0];
    if (match.start < previousEnd) return fail('rendered_target_order', '显示顺序与原文不同，请改用指定部分');
    if (allowProjected) { const { lead, trail } = edges(line); match = extendEdgeSpaces(match, lead, trail, source, excluded, previousEnd, collapseSpaces); }
    previousEnd = match.end; mapping.push(match);
  }
  const mapped = mapping.filter(Boolean);
  if (projected) {
    // 逐字写回需要每一行的逐字位置：严格匹配的行按其文本节点补齐。
    for (const entry of mapped) if (!entry.chars) {
      const variant = nodes[entry.nodeId].variants.find(item => item.text.slice(item.starts.indexOf(entry.start), item.starts.indexOf(entry.start) + entry.text.length) === entry.text)
        || nodes[entry.nodeId].variants[0];
      const from = variant.starts.indexOf(entry.start);
      entry.chars = Array.from({ length: entry.text.length }, (_, i) => ({ start: variant.starts[from + i], end: variant.ends[from + i], html: entry.html, nodeId: entry.nodeId }));
    }
  }
  // 快速编辑的文字只含能写回的部分：未纳入的行首行尾空白不进编辑框
  const targetText = allowProjected ? mapping.map(entry => entry?.text ?? '').join('\n') : text;
  return { ok: true, mode: 'rendered', text: targetText, source, start: mapped[0].start, end: mapped.at(-1).end,
    mapping, excludedRanges: excluded, newline: source.includes('\r\n') ? '\r\n' : source.includes('\r') ? '\r' : '\n',
    ...(projected ? { projected: true, pairs: (projection || buildVisibleProjection(nodes)).pairs, visible: (projection || buildVisibleProjection(nodes)).chars } : {}) };
};

const encodeReplacement = (value, span, newline) => span.html
  ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
  : value.replace(/\n/g, newline);
const contiguous = (target, spans) => {
  if (!spans.length || spans.some(span => span.nodeId !== spans[0].nodeId || span.html !== spans[0].html)) return false;
  for (let i = 1; i < spans.length; i++) if (target.source.slice(spans[i - 1].end, spans[i].start).trim()) return false;
  return true;
};

// 逐字比对：去掉共同前后缀后，中段较短时用最长公共子序列找出保留的字，返回连续的增删段。
const diffHunks = (oldText, newText) => {
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
  let endOld = oldText.length, endNew = newText.length;
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) { endOld--; endNew--; }
  const a = oldText.slice(start, endOld), b = newText.slice(start, endNew);
  if (!a.length || !b.length || a.length * b.length > 4_000_000) return a.length || b.length ? [{ from: start, to: endOld, insert: b }] : [];
  const width = b.length + 1, lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  }
  const hunks = []; let hunk = null, i = 0, j = 0;
  const flush = () => { if (hunk) hunks.push(hunk); hunk = null; };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; continue; }
    hunk ||= { from: start + i, to: start + i, insert: '' };
    if (j < b.length && (i === a.length || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) { hunk.insert += b[j]; j++; }
    else { i++; hunk.to = start + i; }
  }
  flush();
  return hunks;
};

// 逐字写回：只删改动到的可见字、在相邻可见字处插入新字，夹在中间的标签与 Markdown 记号原样保留；
// 一对记号里的字被删光且没有新字落入时，连同这对空记号一起删除，避免留下显示出来的 **。
// 编辑器给出的与原文对齐的修改序列（eq/del/ins）转成增删段；与原文、新文字都对得上才采用。
const hunksFromOps = (ops, oldText, newText) => {
  if (!Array.isArray(ops)) return null;
  const valid = ops.every(op => ['eq', 'del', 'ins'].includes(op?.type) && typeof op.text === 'string');
  if (!valid || ops.filter(op => op.type !== 'ins').map(op => op.text).join('') !== oldText
    || ops.filter(op => op.type !== 'del').map(op => op.text).join('') !== newText) return null;
  const hunks = []; let at = 0, hunk = null;
  for (const op of ops) {
    if (op.type === 'eq') { hunk = null; at += op.text.length; continue; }
    if (!hunk) { hunk = { from: at, to: at, insert: '' }; hunks.push(hunk); }
    if (op.type === 'del') { at += op.text.length; hunk.to = at; } else hunk.insert += op.text;
  }
  return hunks;
};

const spliceProjectedTarget = (target, candidate, ops) => {
  const oldText = target.text, map = new Array(oldText.length).fill(null);
  let offset = 0;
  target.text.split('\n').forEach((line, index) => {
    const entry = target.mapping[index];
    if (entry?.chars) {
      const lead = entry.edges ? 0 : line.length - line.trimStart().length;
      entry.chars.forEach((char, i) => { map[offset + lead + i] = char; });
    }
    offset += line.length + 1;
  });
  const lineOf = at => oldText.slice(0, at).split('\n').length - 1;
  const nearest = (from, step, sameLine) => {
    const line = lineOf(Math.max(0, Math.min(oldText.length - 1, from)));
    for (let at = from; at >= 0 && at < oldText.length; at += step) {
      if (sameLine && oldText[at] === '\n') return null;
      if (map[at]) return { char: map[at], line: lineOf(at) === line };
    }
    return null;
  };
  const deletions = new Map(), insertions = [];
  (hunksFromOps(ops, oldText, candidate) || diffHunks(oldText, candidate)).forEach((hunk, order) => {
    const removed = [];
    for (let at = hunk.from; at < hunk.to; at++) {
      if (map[at]) { removed.push(map[at]); deletions.set(map[at].start, map[at].end); continue; }
      // 行首尾空白与换行没有逐字位置：删去两侧可见字之间「可见的空白」，记号、标签与隐藏块保留；
      // 中间夹着其他可见文字时无法安全合并段落。
      const before = nearest(at - 1, -1, false), after = nearest(at + 1, 1, false);
      if (!before || !after) continue;
      for (const char of target.visible) {
        if (char.start < before.char.end || char.start >= after.char.start) continue;
        if (target.source.slice(char.start, char.end).trim()) throw unsafe();
        deletions.set(char.start, char.end);
      }
    }
    if (!hunk.insert) return;
    const anchor = removed.length ? { at: removed[0].start, html: removed[0].html }
      : (() => {
        const previous = nearest(hunk.from - 1, -1, true), next = nearest(hunk.to, 1, true);
        if (previous) return { at: previous.char.end, html: previous.char.html };
        if (next) return { at: next.char.start, html: next.char.html };
        const anyPrevious = nearest(hunk.from - 1, -1, false), anyNext = nearest(hunk.to, 1, false);
        if (anyPrevious) return { at: anyPrevious.char.end, html: anyPrevious.char.html };
        if (anyNext) return { at: anyNext.char.start, html: anyNext.char.html };
        throw unsafe();
      })();
    insertions.push({ at: anchor.at, text: encodeReplacement(hunk.insert, anchor, target.newline), order });
  });
  for (const pair of target.pairs || []) {
    if (!pair.inner.length || !pair.inner.every(index => deletions.has(target.visible[index].start))) continue;
    if (insertions.some(item => item.at >= pair.open.end && item.at <= pair.close.start)) continue;
    deletions.set(pair.open.start, pair.open.end); deletions.set(pair.close.start, pair.close.end);
  }
  const edits = [...[...deletions].map(([start, end]) => ({ start, end, text: '', kind: 0, order: 0 })),
    ...insertions.map(item => ({ start: item.at, end: item.at, text: item.text, kind: 1, order: item.order }))]
    .sort((a, b) => b.start - a.start || a.kind - b.kind || b.order - a.order);
  let result = target.source;
  for (const edit of edits) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
};

// Returns raw text, or throws before any write if a requested paragraph change
// crosses markup/hidden text without a provable one-to-one correspondence.
// options.ops：编辑器记录的逐字来源（与原文对齐的 eq/del/ins），有则按它写回，保证与屏幕上的标记一致。
export const spliceRenderedAgentTarget = (target, candidateText, { ops = null } = {}) => {
  if (!target?.ok || target.mode !== 'rendered' || !Array.isArray(target.mapping)) throw unsafe();
  const candidate = normalizeNewlines(candidateText);
  if (candidate === target.text) return target.source;
  if (candidate.length > 80000) throw unsafe();
  if (target.projected) return spliceProjectedTarget(target, candidate, ops);
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
        text: encodeReplacement(span.edges ? nonemptyNew[index] : nonemptyNew[index].trim(), span, target.newline) }));
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
