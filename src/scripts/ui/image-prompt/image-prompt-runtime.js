import { buildImagePromptRequest, createImagePromptBlock, fillImagePromptScene, imagePromptDocumentFromLegacy, joinImagePromptNegativeTexts, normalizeImagePromptDocument, resolveImagePromptCapabilities } from './image-prompt-utils.js';
import { combineImageNegativePrompts } from '../image-generation-params-utils.js';

export const createImagePromptRuntime = ({ paramsStore }) => ({
  async getDraft({ prompt = '', options = {}, config = {}, negativePrompt } = {}) {
    if (options.imagePromptDocument) return normalizeImagePromptDocument(options.imagePromptDocument);
    await paramsStore.ready;
    // New requests own their scene. Only pre-existing parameter text is carried
    // forward; per-image snapshots above always take precedence over defaults.
    const preset = (options.imagePromptParamsPresetId && paramsStore.list().find(item => item.id === options.imagePromptParamsPresetId)) || paramsStore.getActive();
    const { provider } = resolveImagePromptCapabilities(config, options);
    const fixedParams = { ...(preset.paramsByProvider?.[provider] || {}) };
    for (const key of ['promptPrefix', 'promptSuffix']) {
      if (Object.prototype.hasOwnProperty.call(options, key)) fixedParams[key] = String(options[key] ?? '');
    }
    let document = fillImagePromptScene(imagePromptDocumentFromLegacy({ ...preset, paramsByProvider: { ...preset.paramsByProvider, [provider]: fixedParams } }), prompt);
    // Keep fixed and per-run negative text separately editable. Explicit complete
    // replacements own the fixed slot for this image, including an empty override.
    const negative = negativePrompt ?? options.imagePromptNegativeOverride?.value;
    if (negative !== undefined) {
      const matches = b => b.kind === 'negative' && b.enabled && (!b.provider || b.provider === provider);
      const fixedBlocks = document.blocks.filter(matches);
      const fixed = joinImagePromptNegativeTexts(fixedBlocks.map(b => b.text));
      const replacing = negativePrompt !== undefined || options.imagePromptNegativeOverride?.mode === 'replace';
      let value = replacing ? String(negative).trim() : combineImageNegativePrompts(fixed, negative);
      if (replacing && fixedBlocks.length) {
        fixedBlocks[0].text = value;
        fixedBlocks.slice(1).forEach(b => { b.text = ''; });
      } else {
        if (!replacing && fixed && value.startsWith(fixed)) value = value.slice(fixed.length).replace(/^[,，;；\s]+/, '');
        if (value) document.blocks.push(createImagePromptBlock('negative', { text: value }));
      }
    }
    return normalizeImagePromptDocument(document);
  },
  async prepare({ prompt = '', config = {}, options = {} } = {}) {
    const document = await this.getDraft({ prompt, config, options });
    return buildImagePromptRequest(document, config, options);
  },
});
