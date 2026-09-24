import { buildLineDiff } from '../../utils/line-diff-utils.js';
import { annotateLineDiffWords, renderWordDiffHtml } from '../../utils/word-diff-utils.js';
import { applyPresetBlockHunk, normalizePresetBlockText } from '../preset-preview-utils.js';
import { t } from '../../i18n/index.js';
import { promptLineOffsets } from './agent-prompt-selection-model.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const glyph = path => `<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path class="prompt-diff-depth" d="${path}"/><path d="${path}"/></svg>`;
const acceptIcon = glyph('m3.9 10.15 3.8 3.8 8.4-8.4');
const rejectIcon = glyph('m5 5 10 10M15 5 5 15');

// The same line/hunk semantics as preset and global prompt editing. Cache only
// owned fields, never the assembled request or its potentially large history.
export const createAgentPromptDiffCache = () => {
  const cache = new Map(); let version = 0;
  return {
    get(field) {
      const base = normalizePresetBlockText(field.baseValue ?? field.element?.defaultValue ?? field.value);
      const draft = normalizePresetBlockText(field.value);
      const prior = cache.get(field.id);
      if (prior?.base === base && prior.draft === draft) return prior;
      const diff = buildLineDiff(base, draft, { collapseContext:false });
      let hunk = -1, changing = false;
      // 改写配对的删行/增行附上字词分组：行结构与文字不变，只在行内标出具体改动
      const rows = annotateLineDiffWords(diff.rows).map(row => {
        const changed = row.type === 'add' || row.type === 'del';
        if (changed && !changing) hunk++;
        changing = changed;
        return { ...row, hunk:changed ? hunk : -1 };
      });
      const result = { ...diff, rows, base, draft, version:++version, hunks:hunk+1 };
      cache.set(field.id,result); return result;
    },
    prune(ids) { for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id); },
  };
};

export const applyAgentPromptDiffHunk = (diff, index, mode) => {
  if (!Number.isInteger(index) || index < 0 || index >= diff.hunks || !['accept','reject'].includes(mode)) return null;
  return applyPresetBlockHunk(diff.base,diff.draft,index,mode);
};

export const renderAgentPromptDiff = (diff, fieldId, { busy = false, canSave = true } = {}) => {
  if (!diff.changed) return escapeHtml(diff.draft);
  const before=promptLineOffsets(diff.base),after=promptLineOffsets(diff.draft);
  const body=diff.rows.map((row,index) => {
    const text = escapeHtml(row.text) || '&#8203;';
    const words = row.words && (row.type === 'del' || row.type === 'add')
      ? renderWordDiffHtml(row.words, { side: row.type === 'del' ? 'old' : 'new', escape: escapeHtml })
      : '';
    const body = row.type === 'del' ? `<del class="prompt-diff-del${words ? ' is-partial' : ''}">${words || text}</del>`
      : row.type === 'add' ? `<ins class="prompt-diff-add${words ? ' is-partial' : ''}">${words || text}</ins>` : text;
    const last = row.hunk >= 0 && diff.rows[index+1]?.hunk !== row.hunk;
    const action = (mode,label,svg) => `<button type="button" class="prompt-diff-${mode}" data-prompt-diff-action="${mode}" data-prompt-diff-field="${escapeHtml(fieldId)}" data-prompt-diff-hunk="${row.hunk}" data-prompt-diff-version="${diff.version}" aria-label="${escapeHtml(t(label))}" title="${escapeHtml(t(label))}"${busy || (mode==='accept' && !canSave)?' disabled':''}>${svg}</button>`;
    const attrs=[['base',row.oldLine,before],['draft',row.newLine,after]].filter(([,line])=>line!==null).map(([mode,line,offsets])=>` data-prompt-${mode}-start="${offsets[line-1]}" data-prompt-${mode}-end="${offsets[line-1]+row.text.length}"`).join('');
    return `<span${attrs}>${body}</span>` + (last ? `<span class="prompt-diff-actions" contenteditable="false">${action('accept','接受此处修改并保存',acceptIcon)}${action('reject','回滚此处修改',rejectIcon)}</span>` : '') + (index < diff.rows.length-1 ? '\n' : '');
  }).join('');
  return `<span data-prompt-draft-length="${diff.draft.length}" data-prompt-base-length="${diff.base.length}">${body}</span>`;
};

// Exact source ownership AND identical rendered content are required. Expanded
// macros, ambiguous anchors and assembled table values remain read-only.
export const isAgentPromptInlineEditable = (target, text, field) => Boolean(field && target.fieldId === field.id
  && !target.anchorKey && target.exact !== false && String(field.value) === text && text.length
  // A label might also occur verbatim in a table value. Edit its source field,
  // never promote a text match inside the data body to an editable range.
  && (!field.id.startsWith('memory:') || /(?:^|:)memory:guide$/.test(target.parentKey || '')));
