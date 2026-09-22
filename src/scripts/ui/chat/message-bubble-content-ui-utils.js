import {
  hideCreativeContentTagsForDisplay,
  resolveCreativeRichRenderSource,
} from './creative-content-display-utils.js';
import { appendGeneratedImageReferences } from './generated-image-reference-view.js';

const appendChild = (parent, child) => {
  parent?.appendChild?.(child);
  return child;
};

const createTextChip = (documentLike, text) => {
  const chip = documentLike.createElement('span');
  chip.className = 'chip';
  chip.textContent = text;
  return chip;
};

const resolveLocalFileLikeUrl = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    const convert =
      g?.__TAURI__?.core?.convertFileSrc || g?.__TAURI__?.convertFileSrc || g?.__TAURI_INTERNALS__?.convertFileSrc;
    if (typeof convert === 'function') {
      const converted = convert(raw);
      if (converted) return converted;
    }
  } catch {}
  if (/^(file|asset|tauri|app|https?|data|blob):/i.test(raw)) return raw;
  if (/^[a-zA-Z]:[\\/]/.test(raw)) return `file:///${raw.replace(/\\/g, '/')}`;
  if (raw.startsWith('/')) return `file://${raw}`;
  return '';
};

const formatAudioTime = (seconds = 0) => {
  if (!Number.isFinite(seconds)) return '--:--';
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
};

export const renderMessageBubbleContentCore = ({
  bubble,
  message,
  resolvedSessionId = '',
  documentLike,
  resolveMediaUrl,
  resolveMediaAsset,
  resolveStickerFrames,
  resolveStickerFps,
  applyImageFallback,
  registerStickerAnimation,
  toastOnce,
  openLightbox,
  renderRichText,
  prepareTextContainer,
  renderSwipeDraftPlaceholder,
  normalizeAssistantLineBreaks,
  renderTextWithStickers,
  logGreetingRender,
  createAudio = (url) => new Audio(url),
  warningToast,
  errorToast,
  translateText = value => String(value ?? ''),
} = {}) => {
  switch (message?.type) {
    case 'image': {
      const meta = message?.meta && typeof message.meta === 'object' ? message.meta : {};
      const generated = meta.generatedMedia && typeof meta.generatedMedia === 'object' ? meta.generatedMedia : {};
      const output = generated.output && typeof generated.output === 'object' ? generated.output : {};
      const content = String(message?.content || '').trim();
      const contentIsPlaceholder = !content || content === '[binary omitted]' || content === '[图片]';
      const imageRef = contentIsPlaceholder
        ? String(meta.localPath || output.path || output.url || output.dataUrl || '').trim()
        : content;
      const localFileUrl = contentIsPlaceholder ? resolveLocalFileLikeUrl(imageRef) : '';
      const resolved = localFileUrl ? null : (resolveMediaAsset?.('image', imageRef) || null);
      const imgSrc = localFileUrl || resolved?.url || resolveMediaUrl?.('image', imageRef) || imageRef || '';
      const imgEl = documentLike.createElement('img');
      imgEl.src = imgSrc;
      imgEl.alt = 'image';
      imgEl.className = 'previewable';
      imgEl.addEventListener?.('click', () => openLightbox?.(imgSrc));
      const onFail = () => {
        imgEl.classList?.add?.('broken');
        imgEl.alt = translateText('图片加载失败');
        toastOnce?.(translateText('图片加载失败，请检查链接或网络'));
      };
      const hasFallback = typeof applyImageFallback === 'function'
        ? applyImageFallback(imgEl, resolved, { onFail })
        : false;
      if (!hasFallback) imgEl.onerror = onFail;
      appendChild(bubble, imgEl);
      break;
    }
    case 'audio': {
      const audioSrc = resolveMediaUrl?.('audio', message?.content) || '';
      const toolbar = documentLike.createElement('div');
      toolbar.className = 'message-toolbar';
      appendChild(toolbar, createTextChip(documentLike, translateText('语音')));
      const audioEl = documentLike.createElement('audio');
      audioEl.controls = true;
      audioEl.preload = 'none';
      audioEl.style.width = '160px';
      const sourceEl = documentLike.createElement('source');
      sourceEl.src = audioSrc;
      appendChild(audioEl, sourceEl);
      audioEl.onerror = () => {
        toastOnce?.(translateText('语音加载失败'));
      };
      appendChild(toolbar, audioEl);
      appendChild(bubble, toolbar);
      break;
    }
    case 'document': {
      const titleText = String(message?.content || message?.meta?.name || translateText('文件'));
      const metaLine = [message?.meta?.mime, message?.meta?.sizeLabel].filter(Boolean).join(' · ');
      const card = documentLike.createElement('div');
      card.className = 'card file-card';
      const title = documentLike.createElement('div');
      title.className = 'card-title';
      title.textContent = titleText;
      appendChild(card, title);
      if (metaLine) {
        const subtitle = documentLike.createElement('div');
        subtitle.className = 'card-subtitle';
        subtitle.textContent = metaLine;
        appendChild(card, subtitle);
      }
      appendChild(bubble, card);
      break;
    }
    case 'music': {
      const artist = message?.meta?.artist || '';
      const rawUrl = message?.meta?.url || '';
      const resolved = resolveMediaAsset?.('audio', rawUrl);
      const url = resolved?.url || rawUrl;
      const statusText = translateText(url ? '待播放' : '无音频地址');
      const card = documentLike.createElement('div');
      card.className = 'card music-card';
      const title = documentLike.createElement('div');
      title.className = 'card-title';
      title.textContent = `🎵 ${message?.content || translateText('音乐')}`;
      appendChild(card, title);
      if (artist) {
        const subtitle = documentLike.createElement('div');
        subtitle.className = 'card-subtitle';
        subtitle.textContent = artist;
        appendChild(card, subtitle);
      }
      const statusEl = documentLike.createElement('div');
      statusEl.className = 'card-status';
      statusEl.dataset.role = 'status';
      statusEl.textContent = statusText;
      appendChild(card, statusEl);
      const actions = documentLike.createElement('div');
      actions.className = 'card-actions';
      const playBtn = documentLike.createElement('button');
      playBtn.className = 'card-button';
      playBtn.dataset.action = 'play';
      playBtn.textContent = translateText('播放');
      const pauseBtn = documentLike.createElement('button');
      pauseBtn.className = 'card-button';
      pauseBtn.dataset.action = 'pause';
      pauseBtn.textContent = translateText('暂停');
      appendChild(actions, playBtn);
      appendChild(actions, pauseBtn);
      if (url) {
        const urlLabel = documentLike.createElement('span');
        urlLabel.style.fontSize = '12px';
        urlLabel.style.color = '#9ca3af';
        urlLabel.textContent = url;
        appendChild(actions, urlLabel);
      }
      appendChild(card, actions);
      let progressEl = null;
      if (url) {
        progressEl = documentLike.createElement('div');
        progressEl.className = 'card-progress';
        progressEl.dataset.role = 'progress';
        progressEl.textContent = '00:00 / --:--';
        appendChild(card, progressEl);
      }
      appendChild(bubble, card);

      const audio = url ? createAudio?.(url) : null;
      let playing = false;
      const updateProgress = () => {
        if (!audio || !progressEl) return;
        const current = formatAudioTime(audio.currentTime || 0);
        const total = audio.duration ? formatAudioTime(audio.duration) : '--:--';
        progressEl.textContent = `${current} / ${total}`;
      };

      if (audio) {
        audio.onerror = () => {
          playing = false;
          playBtn.textContent = translateText('播放');
          statusEl.textContent = translateText('播放错误');
          errorToast?.(translateText('音频加载/播放失败'));
        };
        audio.addEventListener?.('timeupdate', updateProgress);
        audio.addEventListener?.('loadedmetadata', updateProgress);
        audio.addEventListener?.('ended', () => {
          playing = false;
          playBtn.textContent = translateText('播放');
          statusEl.textContent = translateText('播放完畢');
          updateProgress();
        });
      }

      playBtn.onclick = () => {
        if (!audio) {
          warningToast?.(translateText('无音频地址，播放失败'));
          return;
        }
        audio.play()
          .then(() => {
            playing = true;
            playBtn.textContent = translateText('播放中');
            statusEl.textContent = translateText('播放中');
            updateProgress();
          })
          .catch(() => warningToast?.(translateText('播放失败')));
      };
      pauseBtn.onclick = () => {
        audio?.pause?.();
        if (playing) {
          playBtn.textContent = translateText('播放');
          statusEl.textContent = translateText('已暂停');
          playing = false;
        }
      };
      break;
    }
    case 'transfer': {
      const card = documentLike.createElement('div');
      card.className = 'card transfer-card';
      const title = documentLike.createElement('div');
      title.className = 'card-title';
      title.textContent = translateText('转账');
      appendChild(card, title);
      const subtitle = documentLike.createElement('div');
      subtitle.className = 'card-subtitle';
      subtitle.textContent = translateText(`金额：${message?.content}`);
      appendChild(card, subtitle);
      const statusEl = documentLike.createElement('div');
      statusEl.className = 'card-status';
      statusEl.dataset.role = 'status';
      statusEl.textContent = translateText('待确认');
      appendChild(card, statusEl);
      const actions = documentLike.createElement('div');
      actions.className = 'card-actions';
      const confirmBtn = documentLike.createElement('button');
      confirmBtn.className = 'card-button';
      confirmBtn.dataset.action = 'confirm';
      confirmBtn.textContent = translateText('确认收款');
      confirmBtn.onclick = () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = translateText('已收款');
        const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        statusEl.textContent = translateText(`已收款 ${stamp}`);
      };
      appendChild(actions, confirmBtn);
      appendChild(card, actions);
      appendChild(bubble, card);
      break;
    }
    case 'sticker': {
      const stickerResolved = resolveMediaAsset?.('sticker', message?.content) || resolveMediaAsset?.('image', message?.content);
      if (stickerResolved) {
        const stickerImg = documentLike.createElement('img');
        stickerImg.alt = 'sticker';
        stickerImg.className = 'previewable sticker-image';
        const frames = resolveStickerFrames?.(stickerResolved, message?.content) || [];
        const fps = resolveStickerFps?.(stickerResolved, message?.content);
        const loaded = applyImageFallback?.(stickerImg, stickerResolved, {
          onFail: () => {
            stickerImg.classList?.add?.('broken');
            stickerImg.alt = translateText('表情包加载失败');
            toastOnce?.(translateText('表情包加载失败'));
          },
        });
        if (loaded) {
          if (frames.length > 1) registerStickerAnimation?.(stickerImg, frames, fps);
          stickerImg.addEventListener?.('click', () => openLightbox?.(stickerImg.currentSrc || stickerImg.src));
          bubble.innerHTML = '';
          appendChild(bubble, stickerImg);
        } else {
          appendChild(bubble, createTextChip(documentLike, translateText(`表情包：${message?.content}`)));
        }
      } else {
        appendChild(bubble, createTextChip(documentLike, translateText(`表情包：${message?.content}`)));
      }
      break;
    }
    case 'meta':
      bubble.classList?.add?.('meta');
      bubble.textContent = message?.content;
      break;
    case 'text':
    default: {
      const generated = message?.meta?.generatedMedia && typeof message.meta.generatedMedia === 'object'
        ? message.meta.generatedMedia
        : null;
      const generatedImage = generated && (!generated.kind || generated.kind === 'image');
      // An image attempt owns the displayed status; retained RP raw data belongs
      // to an older reply and must not hide the current prompt or retry action.
      if (generatedImage && generated.status === 'running') {
        bubble.textContent = String(message?.content ?? '');
        bubble.style.whiteSpace = 'pre-wrap';
        break;
      }
      if (generatedImage && ['failed', 'cancelled', 'interrupted'].includes(generated.status)) {
        const error = String(generated.error || '').trim();
        const card = documentLike.createElement(error ? 'details' : 'div');
        card.className = 'card generated-media-error-card';
        const heading = documentLike.createElement(error ? 'summary' : 'div');
        heading.className = 'card-title';
        const title = documentLike.createElement('span');
        title.className = 'generated-media-error-title';
        const fallback = generated.status === 'cancelled' ? '图片生成已取消'
          : generated.status === 'interrupted' ? '图片生成已中断' : '图片生成失败';
        title.textContent = String(message?.content || translateText(fallback));
        appendChild(heading, title);
        if (String(generated.prompt || '').trim()) {
          const retry = documentLike.createElement('button');
          retry.type = 'button';
          retry.className = 'card-button generated-media-error-retry';
          retry.dataset.action = 'retry-generated-media';
          retry.textContent = translateText('重新生成图片');
          appendChild(heading, retry);
        }
        appendChild(card, heading);
        if (error) {
          const body = documentLike.createElement('pre');
          body.className = 'card-subtitle';
          body.style.whiteSpace = 'pre-wrap';
          body.style.margin = '8px 0 0';
          body.textContent = String(generated.error);
          appendChild(card, body);
        }
        appendChild(bubble, card);
        break;
      }
      if (message?.meta?.renderRich) {
        const target = prepareTextContainer?.(bubble, message);
        if (message?.meta?.isGreeting) {
          logGreetingRender?.(message, resolvedSessionId);
        }
        renderRichText?.(target, resolveCreativeRichRenderSource(message), {
          messageId: message?.id,
          preserveHtmlNewlines: true,
          sessionId: resolvedSessionId,
          debugTag: message?.meta?.isGreeting ? 'rp-greeting' : '',
          lazyMount: message?.__lazyRichMount === true,
          openLightbox,
        });
        break;
      }
      if (message?.meta?.activeSwipeDraft?.active === true) {
        const target = prepareTextContainer?.(bubble, message);
        renderSwipeDraftPlaceholder?.(target, message?.meta?.activeSwipeDraft?.label || '生成新回复中...');
        break;
      }
      // 与流式结束一致，显示经过正则处理的 content（包括被规则清空的结果）。
      // 历史回复分支会带回 raw，仅在旧记录缺少 content 时用它回退。
      const baseText = message?.content ?? message?.raw;
      const normalizedSource = message?.role === 'assistant'
        ? (normalizeAssistantLineBreaks?.(baseText) ?? String(baseText ?? ''))
        : String(baseText ?? '');
      const normalized = message?.role === 'assistant'
        ? hideCreativeContentTagsForDisplay(normalizedSource)
        : normalizedSource;
      const target = prepareTextContainer?.(bubble, message);
      if (!renderTextWithStickers?.(target, normalized)) {
        target.textContent = normalized;
        target.style.whiteSpace = 'pre-wrap';
      }
    }
  }

  appendGeneratedImageReferences({ bubble, message, documentLike, openLightbox, translateText });
  return bubble;
};
