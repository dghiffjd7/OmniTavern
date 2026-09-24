// 字词级 diff：在行级 diff 的基础上，把“删一行 + 增一行”的改写配对，标出行内具体改动的字词。
// 中日韩文字按字切分，英文数字按词，空白与标点各自成词；夹在两处改动之间的单个字并入改动，避免碎成一粒一粒。
// 大段文本先裁前后缀，中段超过规模上限时退化为按短句切分，仍过大则整段视为替换。

const MAX_LCS_CELLS = 2_000_000;
const MIN_PAIR_SIMILARITY = 0.3;

// 表情按整个字形成词：按键帽（1️⃣）、旗帜（两个区域指示符）、带肤色/变体符/标签序列及 ZWJ 组合的表情。
// 其余字符连同其后的组合符（变体符、附加符号）作为一个词，避免只标出看不见的半个字符。
const EMOJI_SUFFIX = String.raw`(?:\p{Emoji_Modifier}|\p{M}|[\u{E0020}-\u{E007F}])*`;
const EMOJI_TOKEN = String.raw`[#*0-9]\uFE0F?\u20E3|\p{Regional_Indicator}{2}\p{M}*|\p{Extended_Pictographic}${EMOJI_SUFFIX}(?:\u200D\p{Extended_Pictographic}${EMOJI_SUFFIX})*`;
// 每个 ASCII 基字吸收自己的组合符；键帽数字交给前面的表情分支，不能被英文词提前吞掉。
const ASCII_WORD_TOKEN = String.raw`(?:[A-Za-z_]\p{M}*|[0-9](?!\uFE0F?\u20E3)\p{M}*)+`;
const CJK = String.raw`\u3400-\u9FFF\uF900-\uFAFF`;
const TOKEN_PATTERN = new RegExp(String.raw`${EMOJI_TOKEN}|${ASCII_WORD_TOKEN}|\s+|[${CJK}]\p{M}*|[^\sA-Za-z0-9_${CJK}]\p{M}*`, 'gu');
const CLAUSE_PATTERN = /[^，。！？；、,.!?;\n]*[，。！？；、,.!?;\n]?/g;

export const tokenizeForWordDiff = (text = '') => String(text ?? '').match(TOKEN_PATTERN) || [];
const tokenizeClauses = (text = '') => (String(text ?? '').match(CLAUSE_PATTERN) || []).filter(Boolean);

// 对 token 序列做 LCS，返回合并后的 [{ type: 'equal'|'del'|'ins', text }]
const diffTokenLists = (a, b) => {
  const out = [];
  const push = (type, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  push('equal', a.slice(0, prefix).join(''));
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length && midB.length && midA.length * midB.length <= MAX_LCS_CELLS) {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { push('equal', midA[i]); i += 1; j += 1; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', midA[i]); i += 1; }
      else { push('ins', midB[j]); j += 1; }
    }
    while (i < n) { push('del', midA[i]); i += 1; }
    while (j < m) { push('ins', midB[j]); j += 1; }
  } else {
    push('del', midA.join(''));
    push('ins', midB.join(''));
  }
  push('equal', a.slice(a.length - suffix).join(''));
  return out;
};

// 清理并分组：[{ type: 'equal', text } | { type: 'change', del, ins }]
const groupOps = (ops) => {
  const expanded = [];
  ops.forEach((op, index) => {
    const prev = ops[index - 1];
    const next = ops[index + 1];
    if (op.type === 'equal' && [...op.text].length === 1 && prev && next && prev.type !== 'equal' && next.type !== 'equal') {
      expanded.push({ type: 'del', text: op.text }, { type: 'ins', text: op.text });
      return;
    }
    expanded.push(op);
  });
  const groups = [];
  expanded.forEach((op) => {
    if (op.type === 'equal') {
      const last = groups[groups.length - 1];
      if (last?.type === 'equal') last.text += op.text;
      else groups.push({ type: 'equal', text: op.text });
      return;
    }
    let last = groups[groups.length - 1];
    if (last?.type !== 'change') {
      last = { type: 'change', del: '', ins: '' };
      groups.push(last);
    }
    last[op.type] += op.text;
  });
  return groups;
};

export const diffWords = (oldText = '', newText = '') => {
  const oldValue = String(oldText ?? '');
  const newValue = String(newText ?? '');
  if (oldValue === newValue) return oldValue ? [{ type: 'equal', text: oldValue }] : [];
  let a = tokenizeForWordDiff(oldValue);
  let b = tokenizeForWordDiff(newValue);
  // 裁掉前后缀后仍超出规模时，改用短句粒度
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  if ((a.length - prefix - suffix) * (b.length - prefix - suffix) > MAX_LCS_CELLS) {
    a = tokenizeClauses(oldValue);
    b = tokenizeClauses(newValue);
  }
  return groupOps(diffTokenLists(a, b));
};

export const countWordDiffChanges = groups => (Array.isArray(groups) ? groups : []).filter(group => group.type === 'change').length;

// 未变部分占比（按字符），低于阈值的配对视为整行重写，不做行内细分
export const wordDiffSimilarity = (groups = []) => {
  let same = 0;
  let total = 0;
  groups.forEach((group) => {
    if (group.type === 'equal') { same += group.text.length * 2; total += group.text.length * 2; }
    else total += group.del.length + group.ins.length;
  });
  return total ? same / total : 1;
};

/* 给行级 diff 的 rows（buildLineDiff 的输出，type: context|del|add|skip）配对：
   相邻的一段 del 与紧随的一段 add 按顺序两两配对，配对行附上 words（字词分组）；
   不改变 rows 的顺序与条数，调用方仍按行渲染，只在配对行里标出具体改动的字词。 */
export const annotateLineDiffWords = (rows = []) => {
  const list = Array.isArray(rows) ? rows.map(row => ({ ...row })) : [];
  let index = 0;
  while (index < list.length) {
    if (list[index].type !== 'del') { index += 1; continue; }
    const delStart = index;
    while (index < list.length && list[index].type === 'del') index += 1;
    const addStart = index;
    while (index < list.length && list[index].type === 'add') index += 1;
    const dels = list.slice(delStart, addStart);
    const adds = list.slice(addStart, index);
    const pairs = Math.min(dels.length, adds.length);
    for (let k = 0; k < pairs; k += 1) {
      const groups = diffWords(dels[k].text, adds[k].text);
      if (wordDiffSimilarity(groups) < MIN_PAIR_SIMILARITY) continue;
      list[delStart + k].words = groups;
      list[addStart + k].words = groups;
    }
  }
  return list;
};

/* 按行对齐两组文本行（格式修复补丁的 originalLines / replacementLines 等）：
   返回 [{ type: 'equal'|'modified'|'removed'|'added', oldText, newText, oldIndex, newIndex, words }] */
export const alignLinesWithWords = (oldLines = [], newLines = []) => {
  const a = Array.isArray(oldLines) ? oldLines.map(line => String(line ?? '')) : [];
  const b = Array.isArray(newLines) ? newLines.map(line => String(line ?? '')) : [];
  const ops = diffTokenLists(a.map(line => `${line}\u0000`), b.map(line => `${line}\u0000`));
  const rows = [];
  let oldIndex = 0;
  let newIndex = 0;
  let pendingDel = [];
  const flush = (adds = []) => {
    const count = Math.max(pendingDel.length, adds.length);
    for (let k = 0; k < count; k += 1) {
      const oldText = pendingDel[k];
      const newText = adds[k];
      if (oldText !== undefined && newText !== undefined) {
        const words = diffWords(oldText, newText);
        rows.push({ type: 'modified', oldText, newText, oldIndex: oldIndex++, newIndex: newIndex++, words: wordDiffSimilarity(words) >= MIN_PAIR_SIMILARITY ? words : null });
      } else if (oldText !== undefined) {
        rows.push({ type: 'removed', oldText, newText: null, oldIndex: oldIndex++, newIndex: null, words: null });
      } else {
        rows.push({ type: 'added', oldText: null, newText, oldIndex: null, newIndex: newIndex++, words: null });
      }
    }
    pendingDel = [];
  };
  const splitOp = text => text.split('\u0000').slice(0, -1);
  ops.forEach((op) => {
    const lines = splitOp(op.text);
    if (op.type === 'equal') {
      flush();
      lines.forEach(line => rows.push({ type: 'equal', oldText: line, newText: line, oldIndex: oldIndex++, newIndex: newIndex++, words: null }));
    } else if (op.type === 'del') {
      pendingDel.push(...lines);
    } else {
      flush(lines);
    }
  });
  flush();
  return rows;
};

const defaultEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/* 渲染为 HTML 字符串。side: 'merged'（删改合并显示）| 'old'（只显示旧文，标出删除）| 'new'（只显示新文，标出新增）。
   改动的字词用 <del class="wd-del"> / <ins class="wd-ins">，每组改动带 data-wd-change 序号供跳转。 */
export const renderWordDiffHtml = (groups = [], { side = 'merged', escape = defaultEscape, changeOffset = 0 } = {}) => {
  let change = changeOffset;
  return (Array.isArray(groups) ? groups : []).map((group) => {
    if (group.type === 'equal') return escape(group.text);
    const id = change;
    change += 1;
    const del = group.del && side !== 'new' ? `<del class="wd-del">${escape(group.del)}</del>` : '';
    const ins = group.ins && side !== 'old' ? `<ins class="wd-ins">${escape(group.ins)}</ins>` : '';
    if (!del && !ins) return `<span class="wd-gap" data-wd-change="${id}"></span>`;
    return `<span class="wd-change" data-wd-change="${id}">${del}${ins}</span>`;
  }).join('');
};
