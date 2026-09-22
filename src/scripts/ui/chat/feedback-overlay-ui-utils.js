export const createFeedbackOverlayUiRuntime = ({
  documentLike,
  scheduleHide,
} = {}) => ({
  openLightbox(url) {
    const overlay = documentLike.createElement('div');
    overlay.className = 'lightbox';
    const img = documentLike.createElement('img');
    img.src = url;
    img.alt = 'preview';
    overlay.appendChild(img);
    overlay.onclick = () => overlay.remove?.();
    documentLike.body.appendChild(overlay);
    return overlay;
  },
  showErrorBanner(existingBanner, text, action) {
    let banner = existingBanner;
    if (!banner) {
      banner = documentLike.createElement('div');
      banner.style.cssText = `
                position: fixed; top: 0; left: 0; right:0; padding: 10px 12px;
                background: #fef2f2; color: #b91c1c; text-align:center;
                font-size: 13px; z-index: 12000; box-shadow: 0 2px 10px rgba(0,0,0,0.08);
            `;
      documentLike.body.appendChild(banner);
    }
    banner.innerHTML = '';
    const span = documentLike.createElement('span');
    span.textContent = text;
    banner.appendChild(span);

    if (action && typeof action.handler === 'function') {
      const btn = documentLike.createElement('button');
      btn.textContent = action.label || '重试';
      btn.style.cssText =
        'margin-left:8px; padding:4px 10px; border:1px solid #ef4444; background:var(--app-surface-card); color:#b91c1c; border-radius:6px; cursor:pointer;';
      btn.onclick = () => action.handler();
      banner.appendChild(btn);
    }

    banner.style.display = 'block';
    scheduleHide?.(() => {
      if (banner) banner.style.display = 'none';
    }, action ? 6000 : 4000);
    return banner;
  },
});
