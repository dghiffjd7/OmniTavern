// 小管家「贴图起名」：给贴图补上 AI 用的关键词（角色用 [bqb-关键词] 发贴图）。只组请求与整理结果（纯函数）。
// 关键词要短、要能看出这张图表达什么，且在所有贴图包里不重复（重复时按出现先后找不到后面那张）。
import { parseUtilityJson } from './utility-agent-runtime.js';

export const STICKER_KEYWORD_BATCH_SIZE = 6;
export const STICKER_KEYWORD_MAX_LENGTH = 24;

const trim = value => String(value ?? '').trim();
const keyOf = value => trim(value).toLowerCase();

/** 要起名的贴图：默认只补没有关键词的；all 时整包重起。 */
export const selectStickersForKeywords = (pack = {}, { all = false } = {}) => (Array.isArray(pack?.stickers) ? pack.stickers : [])
  .filter(sticker => trim(sticker?.id) && (all || !trim(sticker?.keyword)));

/** 一张贴图用来看的图：静图本身，动图取第一帧。 */
export const stickerImageSource = (sticker = {}) => trim(sticker?.dataUrl)
  || trim(sticker?.path)
  || trim((Array.isArray(sticker?.frames) ? sticker.frames : [])[0]);

/** 关键词整理：去掉会打断 [bqb-…] 记号的方括号与换行，压成一行并限制长度。 */
export const cleanStickerKeyword = value => [...trim(value).replace(/[[\]\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()]
  .slice(0, STICKER_KEYWORD_MAX_LENGTH).join('').trim();

export const buildStickerKeywordPayload = ({ images = [], language = null, avoid = [] } = {}) => {
  const count = images.length;
  const taken = [...new Set(avoid.map(trim).filter(Boolean))].slice(0, 200);
  return {
    messages: [
      {
        role: 'system',
        content: `You will see ${count} sticker image${count === 1 ? '' : 's'}, numbered in order. For each sticker, write one short keyword in ${language?.prompt || 'Simplified Chinese'} `
          + 'that says what the sticker expresses (an emotion, action or reaction), such as a few characters in Chinese, Japanese or Korean, or one to three words otherwise. '
          + 'A chat character picks stickers by these keywords, so make each one specific and different from the others. '
          + (taken.length ? `Do not use any of these existing keywords: ${taken.join(' | ')}. ` : '')
          + `Output only JSON: {"keywords": [${count} strings in image order]}.`,
      },
      {
        role: 'user',
        content: [
          ...images.flatMap((image, index) => [
            { type: 'text', text: `#${index + 1}` },
            { type: 'image_url', image_url: { url: image.url } },
          ]),
        ],
      },
    ],
  };
};

/** 回复里的关键词：数量须与图片一致，逐个整理；不合格的整批视为失败（不猜对应关系）。 */
export const parseStickerKeywords = (raw, count = 0) => {
  const list = parseUtilityJson(raw)?.keywords;
  if (!Array.isArray(list) || list.length !== count) throw new Error('模型返回的关键词数量不对');
  const keywords = list.map(cleanStickerKeyword);
  if (keywords.some(keyword => !keyword)) throw new Error('模型返回了空的关键词');
  return keywords;
};

/** 与已有关键词（其他贴图）重复时加序号：开心 → 开心2。 */
export const dedupeStickerKeywords = (keywords = [], existing = []) => {
  const used = new Set(existing.map(keyOf).filter(Boolean));
  return keywords.map((keyword) => {
    let next = keyword;
    for (let n = 2; used.has(keyOf(next)); n += 1) next = `${keyword}${n}`;
    used.add(keyOf(next));
    return next;
  });
};
