import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { appendGeneratedImageReferences } from './chat/generated-image-reference-view.js';

export const createGeneratedImageAlbumPanel = ({
  document = globalThis.document, resolveGeneratedImagePreviewUrl, getGeneratedImageNegativePrompt,
  formatGeneratedImageAlbumTime, openLightbox, escapeHtml, translateUiText = text => text,
} = {}) => {
    const renderReferences = (container, asset) => {
      if (!container) return;
      container.querySelector('.generated-image-references')?.remove();
      appendGeneratedImageReferences({
        bubble: container, message: { meta: { generatedMedia: { ...asset, kind: 'image' } } },
        documentLike: document, openLightbox, translateText: translateUiText,
      });
      if (container.classList.contains('generated-image-album-references')) container.hidden = !container.childElementCount;
    };
	    let overlay = null;
	    let titleEl = null;
	    let subtitleEl = null;
	    let countEl = null;
	    let listEl = null;
	    let detailEl = null;
	    let detailImageEl = null;
	    let detailReferencesEl = null;
	    let detailPromptEl = null;
	    let detailPromptWrapEl = null;
	    let detailNegativePromptEl = null;
	    let detailNegativeWrapEl = null;
	    let detailMetaEl = null;
	    let detailUseBtn = null;
	    let detailDeleteBtn = null;
	    let toolbarActionBtn = null;
	    let activeDetailAsset = null;
	    let lastAssets = [];
	    let lastOptions = {};
	    let unbindBackdrop = null;
	    const ensure = () => {
	      if (overlay) return;
	      overlay = document.createElement('div');
	      overlay.id = 'generated-image-album-overlay';
	      overlay.className = 'writing-media-assets-overlay';
	      overlay.innerHTML = `
	        <div class="writing-media-assets-panel" role="dialog" aria-modal="true" aria-labelledby="generated-image-album-title">
	          <div class="writing-media-assets-header">
	            <div>
	              <div id="generated-image-album-title" class="writing-media-assets-title">相册</div>
	              <div class="writing-media-assets-subtitle">当前会话生成的图片与提示词</div>
	            </div>
	            <button type="button" class="writing-media-assets-close" aria-label="关闭">×</button>
	          </div>
	          <div class="writing-media-assets-toolbar">
	            <span class="writing-media-assets-count"></span>
	            <button type="button" data-action="album-toolbar-action" hidden></button>
	          </div>
	          <div class="writing-media-assets-list"></div>
	        </div>
	        <div class="generated-image-album-detail" hidden>
	          <div class="generated-image-album-detail-card" role="dialog" aria-modal="true" aria-labelledby="generated-image-album-detail-title">
	            <div class="generated-image-album-detail-header">
	              <div>
	                <div id="generated-image-album-detail-title" class="generated-image-album-detail-title">图片详情</div>
	                <div class="generated-image-album-detail-meta" data-i18n-skip></div>
	              </div>
	              <button type="button" class="generated-image-album-detail-close" aria-label="关闭">×</button>
	            </div>
	            <div class="generated-image-album-detail-body">
	              <img class="generated-image-album-detail-image" alt="生成图片">
	              <div class="generated-image-album-references" hidden></div>
	              <div class="generated-image-album-detail-prompt-wrap">
	                <div class="generated-image-album-detail-label">正向提示词</div>
	                <pre class="generated-image-album-detail-prompt"></pre>
	              </div>
	              <div class="generated-image-album-detail-prompt-wrap generated-image-album-detail-negative-wrap" hidden>
	                <div class="generated-image-album-detail-label">负面提示词</div>
	                <pre class="generated-image-album-detail-prompt generated-image-album-detail-negative-prompt"></pre>
	              </div>
		            </div>
		            <div class="generated-image-album-detail-actions">
		              <button type="button" data-action="use-detail-asset">使用</button>
		              <button type="button" class="is-danger" data-action="delete-detail-asset">删除</button>
		            </div>
		          </div>
		        </div>
	      `;
	      document.body.appendChild(overlay);
	      titleEl = overlay.querySelector('.writing-media-assets-title');
	      subtitleEl = overlay.querySelector('.writing-media-assets-subtitle');
	      countEl = overlay.querySelector('.writing-media-assets-count');
	      listEl = overlay.querySelector('.writing-media-assets-list');
	      detailEl = overlay.querySelector('.generated-image-album-detail');
	      detailImageEl = overlay.querySelector('.generated-image-album-detail-image');
	      detailReferencesEl = overlay.querySelector('.generated-image-album-references');
	      detailPromptEl = overlay.querySelector('.generated-image-album-detail-prompt');
	      detailPromptWrapEl = overlay.querySelector('.generated-image-album-detail-prompt-wrap');
	      detailNegativePromptEl = overlay.querySelector('.generated-image-album-detail-negative-prompt');
	      detailNegativeWrapEl = overlay.querySelector('.generated-image-album-detail-negative-wrap');
	      detailMetaEl = overlay.querySelector('.generated-image-album-detail-meta');
	      detailUseBtn = overlay.querySelector('[data-action="use-detail-asset"]');
	      detailDeleteBtn = overlay.querySelector('[data-action="delete-detail-asset"]');
	      toolbarActionBtn = overlay.querySelector('[data-action="album-toolbar-action"]');
	      const closeAlbum = () => {
	        overlay.classList.remove('is-active');
	        if (detailEl) detailEl.hidden = true;
	        activeDetailAsset = null;
	      };
	      overlay.querySelector('.writing-media-assets-close')?.addEventListener('click', closeAlbum);
	      overlay.querySelector('.generated-image-album-detail-close')?.addEventListener('click', () => {
	        if (detailEl) detailEl.hidden = true;
	        activeDetailAsset = null;
	      });
	      detailEl?.addEventListener('click', event => {
	        if (event.target === detailEl) {
	          detailEl.hidden = true;
	          activeDetailAsset = null;
	        }
	      });
	      unbindBackdrop = bindBackdropActivation(overlay, {
	        documentLike: document,
	        onActivate: () => closeAlbum(),
	      });
	      const openDetail = (asset = {}) => {
	        const url = resolveGeneratedImagePreviewUrl(asset);
	        if (!detailEl || !url) return;
	        activeDetailAsset = asset;
	        const prompt = String(asset.prompt || '').trim();
	        const negativePrompt = getGeneratedImageNegativePrompt(asset);
	        const model = [asset.provider, asset.model].filter(Boolean).join(' · ') || '图片模型';
	        const time = formatGeneratedImageAlbumTime(asset.createdAt);
	        const source = String(asset.sourceLabel || '').trim();
	        if (detailImageEl) {
	          detailImageEl.src = url;
	          detailImageEl.alt = prompt || '生成图片';
	        }
	        renderReferences(detailReferencesEl, asset);
	        if (detailPromptWrapEl) detailPromptWrapEl.hidden = !prompt;
	        if (detailPromptEl) detailPromptEl.textContent = prompt;
	        if (detailNegativeWrapEl) detailNegativeWrapEl.hidden = !negativePrompt;
	        if (detailNegativePromptEl) detailNegativePromptEl.textContent = negativePrompt;
	        if (detailMetaEl) detailMetaEl.textContent = [model, source, time].filter(Boolean).join(' · ');
	        if (detailUseBtn) {
	          detailUseBtn.disabled = !prompt;
	          detailUseBtn.hidden = lastOptions.allowUse === false;
	        }
	        if (detailDeleteBtn) detailDeleteBtn.hidden = lastOptions.allowDelete !== true;
	        detailEl.hidden = false;
	      };
	      overlay.addEventListener('click', async event => {
	        const btn = event.target?.closest?.('button[data-action]');
	        if (btn) {
		        const action = btn.dataset.action || '';
		        if (action === 'album-toolbar-action') {
		          if (typeof lastOptions.onToolbarAction !== 'function') return;
		          overlay.classList.remove('is-active');
		          if (detailEl) detailEl.hidden = true;
		          activeDetailAsset = null;
		          await lastOptions.onToolbarAction();
		          return;
		        }
	          const assetId = btn.closest('[data-asset-id]')?.dataset?.assetId || '';
		        const isDetailAction = action.includes('detail');
		        const asset = isDetailAction
		          ? activeDetailAsset
		          : lastAssets.find(item => String(item.albumId || item.id || '') === assetId);
		          if (!asset) return;
		          if (action === 'use-asset' || action === 'use-detail-asset') {
		            const handler = typeof lastOptions.onUse === 'function'
		              ? lastOptions.onUse
		              : null;
		            if (!handler) return;
		            if (detailEl) detailEl.hidden = true;
		            activeDetailAsset = null;
		            closeAlbum();
		            await handler(asset);
		          }
		          if (action === 'delete-asset' || action === 'delete-detail-asset') {
		            if (typeof lastOptions.onDelete !== 'function') return;
		            const ok = await lastOptions.onDelete(asset);
		            if (!ok) return;
		            if (detailEl) detailEl.hidden = true;
		            activeDetailAsset = null;
		            lastAssets = typeof lastOptions.collect === 'function' ? lastOptions.collect() : [];
		            render();
		          }
		          return;
		        }
	        const detailImage = event.target?.closest?.('.generated-image-album-detail-image');
	        if (detailImage && detailImage.src) {
	          openLightbox?.(detailImage.src);
	          return;
	        }
	        const card = event.target?.closest?.('.writing-media-asset-card[data-asset-id]');
	        if (!card) return;
	        const asset = lastAssets.find(item => String(item.albumId || item.id || '') === String(card.dataset.assetId || ''));
	        if (asset) openDetail(asset);
	      });
	    };
	    const render = () => {
	      ensure();
	      const title = String(lastOptions.title || '相册');
	      const subtitle = String(lastOptions.subtitle || '当前会话生成的图片与提示词');
	      if (titleEl) titleEl.textContent = title;
	      if (subtitleEl) subtitleEl.textContent = subtitle;
	      if (countEl) countEl.textContent = lastAssets.length ? `${lastAssets.length} 张图片` : '暂无图片';
	      if (toolbarActionBtn) {
	        const text = String(lastOptions.toolbarActionText || '').trim();
	        const enabled = Boolean(text && typeof lastOptions.onToolbarAction === 'function');
	        toolbarActionBtn.hidden = !enabled;
	        if (enabled) toolbarActionBtn.textContent = text;
	      }
	      if (!listEl) return;
	      if (!lastAssets.length) {
	        listEl.innerHTML = `<div class="writing-media-assets-empty">${escapeHtml(lastOptions.emptyText || '还没有生成图片。')}</div>`;
	        return;
	      }
		      listEl.innerHTML = lastAssets.map(asset => {
		        const url = resolveGeneratedImagePreviewUrl(asset);
		        const prompt = String(asset.prompt || '').trim();
		        const negative = getGeneratedImageNegativePrompt(asset);
		        const model = [asset.provider, asset.model].filter(Boolean).join(' · ') || '图片模型';
		        const time = formatGeneratedImageAlbumTime(asset.createdAt);
		        const source = String(asset.sourceLabel || '').trim();
		        const showUse = lastOptions.allowUse !== false;
		        const showDelete = lastOptions.allowDelete === true;
		        const useButton = showUse
		          ? `<button type="button" data-action="use-asset" ${prompt ? '' : 'disabled'}>使用</button>`
		          : '';
		        return `
		          <div class="writing-media-asset-card" data-asset-id="${escapeHtml(String(asset.albumId || asset.id || ''))}">
		            <img src="${escapeHtml(url)}" alt="${escapeHtml(prompt || '生成图片')}" data-preview-url="${escapeHtml(url)}">
	            <div class="writing-media-asset-meta">
	              <div class="writing-media-asset-prompt" data-i18n-skip>${escapeHtml(prompt || translateUiText('（无提示词）'))}</div>
	              ${negative ? `<div class="writing-media-asset-prompt writing-media-asset-negative"><span>负面：</span><span data-i18n-skip>${escapeHtml(negative)}</span></div>` : ''}
	              <div class="writing-media-asset-model" data-i18n-skip>${escapeHtml([model, source, time].filter(Boolean).join(' · '))}</div>
		            </div>
		            <div class="writing-media-asset-actions">
		              ${useButton}
		              ${showDelete ? '<button type="button" class="is-danger" data-action="delete-asset">删除</button>' : ''}
		            </div>
		          </div>
		        `;
	      }).join('');
	      listEl.querySelectorAll('.writing-media-asset-card').forEach((card, index) => {
	        renderReferences(card.querySelector('.writing-media-asset-meta'), lastAssets[index]);
	      });
	    };
	    return {
	      open(options = {}) {
	        ensure();
	        lastOptions = options || {};
	        lastAssets = typeof options.collect === 'function' ? options.collect() : [];
	        if (detailEl) detailEl.hidden = true;
	        activeDetailAsset = null;
	        render();
	        overlay.classList.add('is-active');
	      },
	      render,
	      destroy() {
	        unbindBackdrop?.();
	        overlay?.remove();
	        overlay = null;
	        activeDetailAsset = null;
	        lastAssets = [];
	        lastOptions = {};
	      },
	    };
};
