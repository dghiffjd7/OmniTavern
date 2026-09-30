import {
  normalizeWorldPromptMode,
  shouldUseWorldPromptBlocks,
} from '../../variables/world-condition-core.js';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = value => String(value ?? '');
const blocksOf = entry => Array.isArray(entry?.promptBlocks) ? entry.promptBlocks : [];
// Match bridge.normalizePromptBlocks, including its positional ID for imported blocks.
const blockId = (block, index) => String(block?.id || `blk_${index}`);
const blockText = block => String(block?.content || '');
const contentLimit = value => Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 2000;
const excerpt = (value, limit) => ({
  content: value.slice(0, limit),
  contentTruncated: value.length > limit,
});

// Internal edit matching needs complete text, including disabled/conditional blocks.
// Keep this separate from the bounded summaries returned to the model.
export const getWorldbookEntrySearchText = (entry = {}) => {
  const blocks = blocksOf(entry);
  return shouldUseWorldPromptBlocks(entry?.promptMode, blocks)
    ? blocks.map(blockText).join('\n\n')
    : text(own(entry, 'content') ? entry.content : entry?.description);
};

/** Read stored content without evaluating trigger conditions or changing the entry.
 * Block text is a reference preview: enabled conditional blocks may not all inject
 * in a particular turn. Empty/disabled blocks still remain explicit edit targets.
 */
export const describeWorldbookEntryContent = (entry = {}, {
  includeContent = false,
  maxContentLength = 2000,
} = {}) => {
  const blocks = blocksOf(entry);
  const promptMode = normalizeWorldPromptMode(entry?.promptMode);
  const useBlocks = shouldUseWorldPromptBlocks(promptMode, blocks);
  const limit = contentLimit(maxContentLength);
  const content = useBlocks
    ? blocks.filter(block => block?.enabled !== false && blockText(block).trim()).map(blockText).join('\n\n')
    : text(entry?.content);
  // Block previews share one budget; the top-level preview has its own same cap.
  let remainingBlockContent = limit;
  return {
    promptMode,
    contentSource: useBlocks ? 'promptBlocks' : 'content',
    contentLength: content.length,
    ...(includeContent ? excerpt(content, limit) : {}),
    requiresPromptBlockId: useBlocks && blocks.length > 1,
    ...(useBlocks ? { conditionsEvaluated: false } : {}),
    promptBlocks: blocks.map((block, index) => {
      const id = blockId(block, index);
      const content = blockText(block);
      const preview = includeContent ? excerpt(content, remainingBlockContent) : {};
      if (includeContent) remainingBlockContent -= preview.content.length;
      return {
        id,
        title: String(block?.title || block?.name || id).trim() || id,
        enabled: block?.enabled !== false,
        contentLength: content.length,
        ...preview,
      };
    }),
  };
};

/** Resolve a content-only storage patch. Callers apply other fields only after
 * checking ok, so a rejected body edit cannot partially rename the same entry.
 * Metadata-only updates always succeed; this helper never changes promptMode.
 */
export const resolveWorldbookEntryContentPatch = (entry = {}, update = {}) => {
  if (!own(update, 'content') && !own(update, 'description')) return { ok: true, patch: {} };
  const content = text(own(update, 'content') ? update.content : update.description).trim();
  const blocks = blocksOf(entry);
  const useBlocks = shouldUseWorldPromptBlocks(entry?.promptMode, blocks);
  const requestedId = text(update.promptBlockId);
  const hasTarget = requestedId.trim().length > 0;
  const reject = (reason, message) => ({
    ok: false,
    reason,
    message,
    promptBlocks: describeWorldbookEntryContent(entry).promptBlocks,
  });
  if (!useBlocks) {
    if (hasTarget) {
      return reject(
        blocks.length ? 'prompt_blocks_inactive' : 'prompt_block_not_found',
        blocks.length
          ? '此条目使用 legacy 正文；请不传 promptBlockId，直接修改 content。'
          : '此条目没有正文块；请不传 promptBlockId，直接修改 content。',
      );
    }
    return { ok: true, patch: { content } };
  }
  if (!hasTarget && blocks.length > 1) {
    return reject('prompt_block_required', '此条目包含多个正文块；请先读取正文块，并用 promptBlockId 指定要修改的块。');
  }
  const matches = hasTarget
    ? blocks.map((block, index) => blockId(block, index) === requestedId ? index : -1).filter(index => index >= 0)
    : [0];
  if (!matches.length) return reject('prompt_block_not_found', '指定的正文块不存在；请重新读取条目中的 promptBlocks。');
  if (matches.length > 1) return reject('ambiguous_prompt_block', '此条目的正文块 ID 重复，无法安全定位；请先在世界书编辑器中修复。');
  const index = matches[0];
  if (!isRecord(blocks[index])) return reject('invalid_prompt_block', '目标正文块的存储格式无效；请先在世界书编辑器中修复。');
  const promptBlocks = blocks.map((block, current) => current === index ? { ...block, content } : block);
  // The editor mirrors the first block for flat displays; never flatten several
  // blocks into it or alter another block's conditions, role, priority or flags.
  return {
    ok: true,
    patch: { content: blockText(promptBlocks[0]).trim(), promptBlocks },
    promptBlockId: blockId(blocks[index], index),
  };
};
