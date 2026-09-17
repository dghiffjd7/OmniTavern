import { extractFormatFunctionBlocks, FORMAT_FUNCTION_BLOCK_KINDS } from '../ui/chat/format-repair-side-effect-utils.js';
import { applyValidatedFormatLinePatches } from '../ui/chat/format-patch-transaction-utils.js';

const within = (range, start, end) => start >= range.start && end <= range.end;
const error = message => ({ ok: false, message });
const splitsCharacter = (source, offset) => offset > 0 && offset < source.length
  && ((/[\uD800-\uDBFF]/.test(source[offset - 1]) && /[\uDC00-\uDFFF]/.test(source[offset]))
    || source[offset - 1] === '\r' && source[offset] === '\n');

export const createFormatRepairSelection = (source, { range = null, checkType = 'custom' } = {}) => {
  if (typeof source !== 'string' || !source.length) return error('这条回复没有可用的完整原文');
  const start = range?.start ?? 0, end = range?.end ?? source.length;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length
    || splitsCharacter(source, start) || splitsCharacter(source, end)
    || range?.text !== undefined && range.text !== source.slice(start, end)) return error('原文选区已变化，请重新选择');
  const fragment = Boolean(range), blocks = extractFormatFunctionBlocks(source);
  const crossing = fragment && blocks.find(block => start < block.end && end > block.start && !within({ start, end }, block.start, block.end));
  if (crossing) return { ...error('请包含完整的功能标签'), expand: { start: Math.min(start, crossing.start), end: Math.max(end, crossing.end) } };
  const tables = blocks.filter(block => block.kind === FORMAT_FUNCTION_BLOCK_KINDS.tableEdit && within({ start, end }, block.start, block.end));
  if (checkType === 'tableEdit' && (!tables.length || !fragment && tables.some(block => !block.valid))) {
    return error('未找到边界完整的 tableEdit，请在回复原文中选择');
  }
  const tableRanges = (fragment || checkType === 'tableEdit' ? tables : []).map(({ start, end }) => ({ start, end }));
  const ranges = checkType === 'tableEdit' ? tableRanges : [{ start, end }];
  return { ok: true, fragment, start, end, ranges, tableRanges, checkType,
    text: source.slice(start, end), count: checkType === 'tableEdit' ? tables.length : 0 };
};

export const mergeFormatRepairSelection = (source, selection, candidate) => source.slice(0, selection.start) + candidate + source.slice(selection.end);

// Validate each exact line patch after trimming unchanged line prefixes/suffixes.
// This also permits an inline tag to share a physical line with read-only prose.
export const validateFormatRepairSelection = (source, selection, candidate, patches) => {
  const original = source.slice(selection.start, selection.end);
  const applied = applyValidatedFormatLinePatches(original, patches);
  if (!applied.ok || applied.candidateText !== candidate) return error('修改与所选原文不一致');
  for (const patch of patches) {
    const single = applyValidatedFormatLinePatches(original, [patch]);
    if (!single.ok) return error('修改与所选原文不一致');
    const next = single.candidateText;
    let prefix = 0, suffix = 0;
    while (prefix < original.length && prefix < next.length && original[prefix] === next[prefix]) prefix++;
    while (suffix < original.length - prefix && suffix < next.length - prefix
      && original[original.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
    if (original !== next && !selection.ranges.some(range => within(range, selection.start + prefix, selection.start + original.length - suffix))) {
      return error('修改超出所选范围，请重新检查');
    }
  }
  return { ok: true, text: mergeFormatRepairSelection(source, selection, candidate) };
};

export const validateFormatRepairWriteScope = (source, candidate, selection) => {
  if (!selection) return { ok: true };
  const plan = createFormatRepairSelection(source, { range: selection.fragment ? { start: selection.start, end: selection.end } : null, checkType: selection.checkType });
  if (!plan.ok) return plan;
  const prefix = source.slice(0, plan.start), suffix = source.slice(plan.end);
  if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix) || candidate.length < prefix.length + suffix.length) return error('修改超出所选范围');
  // The caller supplies the validated line patches; recheck at the transaction
  // boundary instead of relying on the review UI's enabled button.
  return validateFormatRepairSelection(source, plan, candidate.slice(prefix.length, candidate.length - suffix.length), selection.linePatches || []);
};
