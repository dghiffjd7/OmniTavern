/* 女仆动态工具：以用户身份发布动态（QQ 空间式信息流）。
   发布本体复用 app 既有链路（normalizeMomentRecordForStore → persistComposedMomentRecord →
   可选的发布后评论生成），经依赖注入接入；本模块不直接触碰 store。 */

import { t } from '../../i18n/index.js';

const trim = (value, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

// 一条动态最多 9 张图；现场生图另限 4 张（每张都要调用图片模型）
const MOMENT_IMAGE_LIMIT = 9;
const MOMENT_IMAGE_PROMPT_LIMIT = 4;

const uniqueTexts = (value, limit) => [...new Set((Array.isArray(value) ? value : []).map(item => trim(item)).filter(Boolean))].slice(0, limit);

// 配图生成失败时由程序问用户（allowAlways:false：不吃「始终允许」，也不交给模型决定）。
// 回 publish / decline；当前环境没有确认通道时回 unavailable。
const askAboutImageFailure = async ({ context = {}, failure = {}, failedIndex = 0, pastedCount = 0, generatedCount = 0, notStartedCount = 0 }) => {
  const confirm = context?.requestToolConfirmation;
  if (typeof confirm !== 'function') return 'unavailable';
  const readyCount = pastedCount + generatedCount;
  const parts = [t('第 {index} 张：{reason}。', {
    index: failedIndex + 1,
    reason: trim(failure.message).replace(/[。.]+$/u, '').slice(0, 200),
  })];
  if (readyCount) {
    parts.push(pastedCount
      ? t('已有 {count} 张。', { count: readyCount })
      : t('已生成 {count} 张。', { count: readyCount }));
  }
  if (notStartedCount) parts.push(t('还有 {count} 张没开始画。', { count: notStartedCount }));
  let confirmText = t('只发文字');
  if (readyCount) {
    confirmText = pastedCount
      ? t('发已有的 {count} 张', { count: readyCount })
      : t('发已生成的 {count} 张', { count: readyCount });
  }
  try {
    const decision = await confirm({
      toolName: 'moments.publish',
      kind: 'moments.image_failed',
      operationType: 'create',
      riskLevel: 'medium',
      danger: false,
      allowAlways: false,
      title: t('动态配图没有全部生成'),
      message: parts.join(''),
      confirmText,
      cancelText: t('先不发'),
    }, { signal: context?.signal || null, runId: trim(context?.runId) });
    return decision === true || ['allow', 'allow_once', 'allow_always'].includes(trim(decision?.decision)) ? 'publish' : 'decline';
  } catch {
    return 'decline';
  }
};

export const createMomentsAgentTools = ({
  publishMoment = null,
  // 附图：用户贴给女仆的图或附件池里的图（attachmentId → { dataUrl, name, mime }）
  resolveImage = null,
  // 附图：用当前图片配置现场生成（prompt → { asset }）
  generateMomentImage = null,
  // 把取来的图存成动态附件（images → { ok, assets }）
  saveMomentImages = null,
  // 没发出去时留下配图、下一轮按 id 取回（女仆只拿到 id，文件路径不进工具结果）
  keepMomentImages = null,
  loadKeptMomentImage = null,
} = {}) => [
  {
    name: 'moments.publish',
    title: 'Publish a moment',
    description: 'Publish a moment (feed post) on the moments page as the user, optionally with images. Characters may then comment on it like a real social feed.',
    source: 'maid-moments',
    permissions: [],
    riskLevel: 'medium',
    capabilities: {
      read: false,
      write: true,
      network: false,
      cost: 'variable',
      undo: 'none',
      modelContext: 'allowlist',
      confirmation: 'allow_once',
    },
    schema: {
      type: 'object',
      required: ['content'],
      additionalProperties: false,
      properties: {
        content: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description: 'The moment text to publish, written in the user\'s voice. Mention contacts with @Name inside the text.',
        },
        generateComments: {
          type: 'boolean',
          description: 'Whether characters should auto-comment after publishing (default true; involves model calls).',
        },
        attachmentIds: {
          type: 'array',
          maxItems: MOMENT_IMAGE_LIMIT,
          items: { type: 'string', minLength: 1, maxLength: 160 },
          description: 'Existing images to attach: images the user attached to this request (their id, file name or 1-based order), attachmentId values returned by media.fetch_image / media.generate_image, or keptImages attachmentId values from an earlier moments.publish that did not finish (these are reused as they are, without another image generation). Never invent ids.',
        },
        imagePrompts: {
          type: 'array',
          maxItems: MOMENT_IMAGE_PROMPT_LIMIT,
          items: { type: 'string', minLength: 1, maxLength: 2000 },
          description: 'Generate new images with the active image model and attach them, one image per prompt (each costs an image generation). Write prompts in the image model\'s style.',
        },
      },
    },
    execute: async (args = {}, context = {}) => {
      if (typeof publishMoment !== 'function') {
        return { ok: false, reason: 'moments_publish_unavailable', message: '动态发布通道未接入。' };
      }
      const content = trim(args.content);
      if (!content) {
        return { ok: false, reason: 'moments_publish_empty', message: '动态正文为空。' };
      }
      const attachmentIds = uniqueTexts(args.attachmentIds, MOMENT_IMAGE_LIMIT);
      const imagePrompts = uniqueTexts(args.imagePrompts, MOMENT_IMAGE_PROMPT_LIMIT);
      if (attachmentIds.length + imagePrompts.length > MOMENT_IMAGE_LIMIT) {
        return { ok: false, reason: 'moment_images_too_many', message: `一条动态最多 ${MOMENT_IMAGE_LIMIT} 张图。` };
      }
      if ((attachmentIds.length && (typeof resolveImage !== 'function' || typeof saveMomentImages !== 'function')) || (imagePrompts.length && typeof generateMomentImage !== 'function')) {
        return { ok: false, reason: 'moment_images_unavailable', message: '动态配图通道未接入。' };
      }
      // 取不到或存不下用户指定的图时不发布（这一步还没开始画，不花钱）
      const picked = [];
      for (const attachmentId of attachmentIds) {
        // 上次没发出去留下的配图：直接用已存的文件，不重画
        const keptAsset = await loadKeptMomentImage?.({ attachmentId, roleCardId: trim(context?.roleCardId) });
        if (keptAsset) {
          picked.push({ asset: keptAsset });
          continue;
        }
        const image = await resolveImage({ attachmentId, context });
        if (!trim(image?.dataUrl)) {
          return { ok: false, reason: trim(image?.reason, 'moment_image_missing'), message: trim(image?.message, `没有找到图片 ${attachmentId}。`) };
        }
        picked.push({ image: { dataUrl: image.dataUrl, name: trim(image.name), mime: trim(image.mime) } });
      }
      const images = picked.filter(entry => entry.image).map(entry => entry.image);
      let savedAssets = [];
      if (images.length) {
        const saved = await saveMomentImages({ images });
        if (saved?.ok !== true) {
          return { ok: false, reason: trim(saved?.reason, 'moment_image_save_failed'), message: trim(saved?.message, '动态配图保存失败。') };
        }
        savedAssets = [...saved.assets];
      }
      // 照女仆指定的顺序排：留下的图、贴来的图穿插也不乱
      const assets = picked.map(entry => entry.asset || savedAssets.shift());
      // 一张一张画，失败就停（后面的也可能白花钱），已画好的一律留着
      let failure = null;
      let failedIndex = -1;
      for (const [index, prompt] of imagePrompts.entries()) {
        const generated = await generateMomentImage({ prompt, signal: context?.signal || null });
        if (generated?.ok !== true || !generated.asset) {
          failure = { reason: trim(generated?.reason, 'moment_image_generation_failed'), message: trim(generated?.message, '配图生成失败。') };
          failedIndex = index;
          break;
        }
        assets.push(generated.asset);
      }
      const remainingPrompts = failure ? imagePrompts.slice(failedIndex) : [];
      // 没发出去：图留着，女仆只拿到 id 与提示词，下一轮按 id 取回
      const stopWithKeptImages = async (buildResult) => {
        if (assets.length) {
          await Promise.resolve(keepMomentImages?.({ assets, roleCardId: trim(context?.roleCardId) })).catch(() => null);
        }
        return {
          ...buildResult(assets.length),
          content,
          remainingPrompts,
          ...(assets.length ? { keptImages: assets.map(asset => ({ attachmentId: trim(asset.id), prompt: trim(asset.prompt) })) } : {}),
        };
      };
      const keptNote = count => (count ? t('已保留 {count} 张配图。', { count }) : '');
      if (failure) {
        if (context?.signal?.aborted) {
          return stopWithKeptImages(count => ({
            ok: false,
            cancelled: true,
            reason: 'user_aborted',
            message: `${t('任务已终止，动态没有发布。')}${keptNote(count)}`,
          }));
        }
        const choice = await askAboutImageFailure({
          context,
          failure,
          failedIndex,
          pastedCount: images.length,
          generatedCount: assets.length - images.length,
          notStartedCount: remainingPrompts.length - 1,
        });
        if (choice === 'decline') {
          return stopWithKeptImages(count => ({
            ok: false,
            cancelled: true,
            reason: 'moment_images_declined',
            message: count
              ? `${t('动态没有发布。')}${keptNote(count)}${t('想继续时告诉我，我只补画没好的，已保留的不会重画。')}`
              : t('动态没有发布。'),
          }));
        }
        if (choice === 'unavailable') {
          return stopWithKeptImages(count => ({
            ok: false,
            reason: failure.reason,
            message: `${failure.message}${t('动态没有发布。')}${keptNote(count)}`,
          }));
        }
      }
      const result = await publishMoment({
        content,
        generateComments: args.generateComments !== false,
        ...(assets.length ? { assets } : {}),
      });
      if (result?.ok !== true) {
        return stopWithKeptImages(count => ({
          ok: false,
          reason: trim(result?.reason, 'moments_publish_failed'),
          message: `${trim(result?.message, '动态发布失败。')}${keptNote(count)}`,
        }));
      }
      const commentsRequested = result.commentsRequested === true;
      const missingImageCount = remainingPrompts.length;
      let message = commentsRequested ? '动态已发布，角色们稍后会来评论。' : '动态已发布。';
      if (missingImageCount) {
        message = commentsRequested
          ? t('动态已发布，少了 {count} 张配图，角色们稍后会来评论。', { count: missingImageCount })
          : t('动态已发布，少了 {count} 张配图。', { count: missingImageCount });
      }
      return {
        ok: true,
        momentId: trim(result.momentId),
        imageCount: assets.length,
        ...(missingImageCount ? { missingImageCount } : {}),
        commentsRequested,
        message,
      };
    },
    summarizeResult: (result) => {
      if (result?.ok === true) {
        return `moment published id=${trim(result?.momentId, '-')}${Number(result?.imageCount) > 0 ? ` with ${Number(result.imageCount)} image(s)` : ''} comments=${result?.commentsRequested === true}`;
      }
      // 用户选了先不发或中止了任务：这一轮到此结束，这句话就是用户看到的结果
      if (result?.cancelled === true) return trim(result?.message);
      return `moment publish failed: ${trim(result?.reason || result?.message, 'unknown')}`;
    },
  },
];

export const registerMomentsAgentTools = (registry, deps = {}) => {
  const tools = createMomentsAgentTools(deps);
  if (!registry || typeof registry.registerMany !== 'function') return tools;
  registry.registerMany(tools);
  return tools;
};
