import { createImagePromptBlock, createImagePromptId, joinImagePromptNegativeTexts, normalizeImagePromptDocument, resolveImagePromptCapabilities } from './image-prompt-utils.js';

// Present existing snapshots as two text areas without flattening provider scope,
// disabled content, or the position of old style blocks around characters.
export const resolveImagePromptForm = (document, config = {}, options = {}) => {
  const draft = normalizeImagePromptDocument(document);
  const capability = resolveImagePromptCapabilities(config, options);
  const active = draft.blocks.filter(b => b.enabled && (!b.provider || b.provider === capability.provider));
  const separator = capability.textMode === 'tags' ? ', ' : '\n\n';
  const group = (blocks, roleOf, joiner) => {
    const fields = [];
    for (const block of blocks) {
      const role = roleOf(block), previous = fields[fields.length - 1];
      if (previous && previous.role === role && previous.provider === block.provider) {
        previous.ids.push(block.id); previous.values.push(block.text);
      } else {
        fields.push({ key: block.id, ids: [block.id], values: [block.text], role, kind: block.kind, provider: block.provider, placement: block.placement });
      }
    }
    return fields.map(({ values, ...field }) => ({ ...field, text: typeof joiner === 'function' ? joiner(values) : values.map(v => v.trim()).filter(Boolean).join(joiner) }));
  };
  const empty = (role, kind) => {
    const id = createImagePromptId();
    return { key: id, ids: [id], role, kind, provider: '', placement: 'before', text: '' };
  };
  const before = group(active.filter(b => b.kind === 'style' && b.placement !== 'after'), () => 'positive-prefix', separator);
  const main = group(active.filter(b => b.kind === 'scene'), () => 'positive-main', separator);
  if (!main.length) main.push(empty('positive-main', 'scene'));
  const after = group(active.filter(b => b.kind === 'style' && b.placement === 'after'), () => 'positive-suffix', separator);
  const negatives = group(active.filter(b => b.kind === 'negative'), b => b.parameterKey === 'negativePrompt' || b.parameterKey === 'negative_prompt' || /^legacy-.+-negative_?[Pp]rompt$/.test(b.id) ? 'negative-fixed' : 'negative-main', joinImagePromptNegativeTexts);
  if (!negatives.length || negatives[negatives.length - 1].role !== 'negative-main') negatives.push(empty('negative-main', 'negative'));
  return { positive: [...before, ...main, ...after], negative: negatives, showNegative: capability.negative || negatives.some(f => f.text.trim()), capability };
};

// Only an edited field is consolidated. Simply opening/previewing an old image
// leaves its complete snapshot and request order intact.
export const updateImagePromptFormText = (document, field, value) => {
  const next = normalizeImagePromptDocument(document);
  const blocks = field.ids.map(id => next.blocks.find(b => b.id === id)).filter(Boolean);
  if (blocks.length) {
    blocks[0].text = String(value ?? '');
    blocks.slice(1).forEach(b => { b.text = ''; });
  } else {
    next.blocks.push(createImagePromptBlock(field.kind, { id: field.ids[0], provider: field.provider, placement: field.placement, text: String(value ?? '') }));
  }
  return next;
};
