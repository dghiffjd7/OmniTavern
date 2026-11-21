import { resolveMaidWorldbookComparison } from '../maid-worldbook-comparison.js';

// 世界书比较报告（只读）：APP 读取两本世界书的全文，按条目标题整理相同、同名不同、各自独有与无法核实的条目，
// 当作工具结果交给模型转述；要不要比较、比较哪两本由模型决定。
export const WORLDBOOK_COMPARE_TOOL = 'worldbook.compare_entries';

const trim = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const unwrapOutput = output => (isPlainObject(output) && Object.hasOwn(output, 'result') ? output.result : output);
const isAbort = (error, signal) => Boolean(signal?.aborted || error?.name === 'AbortError');
const READ_ARGS = Object.freeze({ includeContent: true, maxEntries: 200, maxContentLength: 12000 });

const titles = entries => entries.map(entry => trim(entry?.title));

// 报告里的原文已经在 message 里按预算引用；结构化部分只给标题，避免同一段原文传两次
const summarizeReport = report => ({
  completeComparison: report.completeComparison === true,
  same: report.pairs.filter(pair => pair.relation === 'same').map(pair => pair.title),
  different: report.pairs.filter(pair => pair.relation === 'different').map(pair => pair.title),
  leftOnly: titles(report.leftOnly),
  rightOnly: titles(report.rightOnly),
  ambiguous: report.ambiguous.map(item => ({ title: trim(item.title), reason: item.reason })),
  unverified: report.unverified.map(item => ({ title: trim(item.title), reason: item.reason })),
  coverage: report.books.map(book => ({ id: book.id, completeSnapshotPresented: book.coverage?.completeSnapshotPresented === true })),
  presentation: report.presentation,
});

export const createWorldbookCompareTools = ({ executeTool = null } = {}) => [{
  name: WORLDBOOK_COMPARE_TOOL,
  title: 'Compare two worldbooks entry by entry',
  description: 'Read two saved worldbooks in full and return the APP comparison report: entries with the same title and identical text, same title with different text (both originals quoted within the report budget), entries only in the left or right book, duplicate or untitled entries that cannot be paired, and entries whose text or inventory could not be read completely. Read-only: nothing is merged, overwritten or deleted. message is the report text to relay; the other fields list the entry titles per group.',
  source: 'maid-worldbook-compare',
  permissions: [],
  riskLevel: 'low',
  capabilities: {
    read: true,
    write: false,
    network: false,
    cost: 'none',
    undo: 'none',
    modelContext: 'allowlist',
    confirmation: 'allow_once',
  },
  schema: {
    type: 'object',
    required: ['leftWorldbookId', 'rightWorldbookId'],
    additionalProperties: false,
    properties: {
      leftWorldbookId: { type: 'string', minLength: 1, maxLength: 160, description: 'Worldbook id (name) from worldbook.list.' },
      rightWorldbookId: { type: 'string', minLength: 1, maxLength: 160, description: 'The other worldbook id (name).' },
      targetWorldbookId: { type: 'string', maxLength: 160, description: 'Optional: which of the two the user chose as the merge target; recorded in the report only.' },
    },
  },
  execute: async (args = {}, context = {}) => {
    if (typeof executeTool !== 'function') return { ok: false, reason: 'worldbook_reader_unavailable' };
    const requested = [trim(args.leftWorldbookId), trim(args.rightWorldbookId)];
    if (requested[0] === requested[1]) return { ok: false, reason: 'same_worldbook', worldbookId: requested[0] };
    const steps = [];
    for (const [position, worldbookId] of requested.entries()) {
      let output;
      try {
        output = await executeTool('worldbook.read', { worldbookId, ...READ_ARGS }, context);
      } catch (error) {
        if (isAbort(error, context?.signal)) throw error;
        return { ok: false, reason: 'worldbook_read_failed', worldbookId, message: trim(error?.message) };
      }
      const result = unwrapOutput(output);
      if ((output?.status && output.status !== 'succeeded') || !isPlainObject(result) || result.ok === false) {
        return { ok: false, reason: trim(result?.reason, 'worldbook_read_failed'), worldbookId };
      }
      steps.push({ index: position + 1, toolName: 'worldbook.read', status: 'succeeded', args: { worldbookId, ...READ_ARGS }, output });
    }
    const [leftBookId, rightBookId] = steps.map(step => trim(unwrapOutput(step.output)?.id));
    const targetIndex = requested.indexOf(trim(args.targetWorldbookId));
    if (trim(args.targetWorldbookId) && targetIndex < 0) {
      return { ok: false, reason: 'target_not_compared', targetWorldbookId: trim(args.targetWorldbookId) };
    }
    const comparison = resolveMaidWorldbookComparison({
      steps,
      context,
      comparison: {
        kind: 'worldbook_entries', leftBookId, rightBookId,
        ...(targetIndex >= 0 ? { targetBookId: [leftBookId, rightBookId][targetIndex] } : {}),
      },
    });
    if (!comparison.ok) return { ok: false, reason: trim(comparison.reason, 'comparison_unavailable') };
    if (comparison.status === 'needs_selection') {
      return { ok: false, reason: trim(comparison.reason, 'comparison_books_not_selected'), message: comparison.message };
    }
    const [left, right] = comparison.report.books;
    return {
      ok: true,
      readOnly: true,
      status: comparison.status,
      left: { id: left.id, name: left.name },
      right: { id: right.id, name: right.name },
      targetWorldbookId: comparison.report.targetBookId || null,
      message: comparison.message,
      ...summarizeReport(comparison.report),
    };
  },
  summarizeResult: result => (result?.ok === false
    ? `worldbook comparison unavailable: ${trim(result?.reason)}`
    : `compared ${trim(result?.left?.id)} and ${trim(result?.right?.id)}: ${result?.same?.length || 0} same, ${result?.different?.length || 0} different, ${result?.leftOnly?.length || 0} left only, ${result?.rightOnly?.length || 0} right only (${trim(result?.status)})`),
}];

export const registerWorldbookCompareTools = (registry, deps = {}) => {
  const tools = createWorldbookCompareTools(deps);
  if (registry && typeof registry.registerMany === 'function') registry.registerMany(tools);
  return tools;
};
