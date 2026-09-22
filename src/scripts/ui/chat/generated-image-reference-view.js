import { getGeneratedImageReferenceItems, getImageGenerationReferencePreviewUrl } from '../image-generation-reference-utils.js';

export const appendGeneratedImageReferences = ({
  bubble,
  message,
  documentLike,
  openLightbox,
  translateText = value => String(value ?? ''),
} = {}) => {
  const generated = message?.meta?.generatedMedia;
  if (!generated || (generated.kind && generated.kind !== 'image')) return;
  const references = getGeneratedImageReferenceItems(generated);
  if (!references.length) return;

  const section = documentLike.createElement('div');
  section.className = 'generated-image-references';
  const list = documentLike.createElement('div');
  list.className = 'generated-image-reference-list';
  references.forEach((reference, index) => {
    const url = getImageGenerationReferencePreviewUrl(reference);
    const label = reference.name || `${translateText('参考图')} ${index + 1}`;
    const card = documentLike.createElement('button');
    card.type = 'button';
    card.className = 'generated-image-reference-card';
    card.setAttribute?.('aria-label', `${translateText('点击查看大图')} · ${label}`);
    const img = documentLike.createElement('img');
    img.className = 'generated-image-reference-thumb';
    img.src = url;
    img.alt = label;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.onerror = () => {
      card.classList?.add?.('is-broken');
      img.alt = translateText('图片加载失败');
    };
    card.appendChild(img);
    card.addEventListener?.('click', event => {
      event.stopPropagation?.();
      openLightbox?.(url);
    });
    list.appendChild(card);
  });
  section.appendChild(list);
  bubble.appendChild(section);
};
