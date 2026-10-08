// 快速编辑的逐字来源：当前文字的每个字记着是原文第几个字（orig）还是新加的（orig = null），
// 被删的原文字另记。显示（绿增红删）与保存都按这份记录，不再拿原文与当前文字从头猜对应关系。
// 纯数据，无 DOM。

export const createInlineEditProvenance = (original = '') => {
  const text = String(original ?? '');
  return { original: text, tokens: Array.from({ length: text.length }, (_, orig) => ({ ch: text[orig], orig })), deleted: new Set() };
};

export const provenanceText = state => state.tokens.map(token => token.ch).join('');

export const cloneInlineEditProvenance = state => ({ original: state.original, tokens: state.tokens.map(token => ({ ...token })), deleted: new Set(state.deleted) });

// 只看光标附近真正变动的一段：插入的字结束在光标处、删除从光标处开始，
// 以此消除「大度的大度的」这类重复文字的歧义。删掉自己新加的字直接消失。
export const applyInlineEditTextChange = (state, next, caret = next.length) => {
  const previous = provenanceText(state);
  if (previous === next) return false;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  start = Math.min(start, Math.max(0, caret - Math.max(0, next.length - previous.length)));
  let tail = 0;
  while (tail < previous.length - start && tail < next.length - start
    && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const removed = state.tokens.slice(start, previous.length - tail);
  removed.forEach(token => { if (token.orig != null) state.deleted.add(token.orig); });
  const inserted = Array.from({ length: next.length - tail - start }, (_, i) => ({ ch: next[start + i], orig: null }));
  state.tokens.splice(start, removed.length, ...inserted);
  return true;
};

// 把一段被删的原文放回原位；同一空隙里新加的字保留，排在它后面。返回放回后光标应在的位置。
export const restoreInlineEditDeleted = (state, from, to) => {
  let at = 0;
  state.tokens.forEach((token, index) => { if (token.orig != null && token.orig < from) at = index + 1; });
  const back = [];
  for (let i = from; i < to; i++) if (state.deleted.has(i)) { state.deleted.delete(i); back.push({ ch: state.original[i], orig: i }); }
  state.tokens.splice(at, 0, ...back);
  return at + back.length;
};

// 与原文对齐的 eq / del / ins 序列：同一空隙里被删的原文排在新增之前；del 带原文区间，便于点击恢复。
export const inlineEditSegments = state => {
  const segments = [];
  const push = (type, ch, orig) => {
    const last = segments[segments.length - 1];
    if (last && last.type === type && (type !== 'del' || last.to === orig)) { last.text += ch; if (type === 'del') last.to = orig + 1; return; }
    segments.push(type === 'del' ? { type, text: ch, from: orig, to: orig + 1 } : { type, text: ch });
  };
  let last = -1;
  const flushDeleted = until => { for (let i = last + 1; i < until; i++) if (state.deleted.has(i)) push('del', state.original[i], i); };
  state.tokens.forEach((token, index) => {
    if (token.orig == null) {
      const next = state.tokens.slice(index).find(item => item.orig != null);
      const until = next ? next.orig : state.original.length;
      flushDeleted(until); last = Math.max(last, until - 1);
      push('ins', token.ch); return;
    }
    flushDeleted(token.orig); push('eq', token.ch); last = token.orig;
  });
  flushDeleted(state.original.length);
  return segments;
};

// 写回用：只保留类型与文字
export const inlineEditOps = state => inlineEditSegments(state).map(({ type, text }) => ({ type, text }));
