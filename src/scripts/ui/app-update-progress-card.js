import { t } from '../i18n/index.js';

// 桌面自动更新的进度卡片：准备 → 下载（百分比与已下载大小）→ 下载完成、启动安装（APP 随后自动关闭）。
// 进度由原生端经 Channel 回报，运行时整理成 view.progress；这里只负责显示。

const formatMb = bytes => `${(Math.max(0, Number(bytes) || 0) / 1048576).toFixed(1)} MB`;

// 纯函数：把进度整理成卡片要显示的文字，便于测试
export const resolveAppUpdateProgressDisplay = (progress = null) => {
  if (!progress || typeof progress !== 'object') return null;
  const version = String(progress.version || '').trim();
  if (progress.stage === 'installing') {
    return {
      stage: 'installing',
      title: t('下载完成，正在启动安装'),
      percent: 100,
      indeterminate: false,
      meta: t('APP 会自动关闭，安装完成后自动重新打开'),
    };
  }
  if (progress.stage === 'downloading') {
    const percent = Number.isFinite(progress.percent) ? progress.percent : null;
    return {
      stage: 'downloading',
      title: t('正在下载 v{version}', { version }),
      percent,
      indeterminate: percent == null,
      meta: percent == null
        ? t('已下载 {size}', { size: formatMb(progress.downloaded) })
        : `${formatMb(progress.downloaded)} / ${formatMb(progress.total)}`,
    };
  }
  return {
    stage: 'preparing',
    title: t('正在准备更新 v{version}', { version }),
    percent: null,
    indeterminate: true,
    meta: t('正在连接下载服务器…'),
  };
};

const ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="aup-arrow"><path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/></g><path d="M5 19.5h14"/></svg>';
const ICON_INSTALL = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g class="aup-gear"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6"/></g></svg>';

const STYLE = `
.app-update-progress{position:fixed;right:24px;bottom:calc(24px + env(safe-area-inset-bottom,0px));z-index:23000;box-sizing:border-box;width:min(340px,calc(100vw - 32px));display:flex;gap:13px;align-items:center;padding:14px 16px 14px 14px;border:1px solid color-mix(in srgb,var(--app-accent-primary) 18%,var(--app-border-subtle));border-radius:18px;background:color-mix(in srgb,var(--app-surface-card) 92%,transparent);-webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);box-shadow:0 18px 40px -18px color-mix(in srgb,var(--app-accent-primary) 45%,rgba(0,0,0,.45)),var(--app-shadow-md);color:var(--app-text-primary);font-family:inherit;opacity:0;transform:translateY(14px) scale(.98);pointer-events:none;transition:opacity .28s ease,transform .32s cubic-bezier(.2,.8,.2,1)}
.app-update-progress.is-visible{opacity:1;transform:none;pointer-events:auto}
.app-update-progress[hidden]{display:none}
.app-update-progress .aup-icon{position:relative;flex:0 0 auto;width:42px;height:42px;border-radius:14px;display:grid;place-items:center;color:var(--app-accent-primary);background:radial-gradient(circle at 30% 25%,color-mix(in srgb,var(--app-accent-primary) 26%,transparent),color-mix(in srgb,var(--app-accent-primary) 10%,transparent) 70%)}
.app-update-progress .aup-icon::after{content:'';position:absolute;inset:-3px;border-radius:17px;border:1.5px solid color-mix(in srgb,var(--app-accent-primary) 35%,transparent);opacity:.0;animation:aupHalo 2.4s ease-out infinite}
.app-update-progress .aup-arrow{animation:aupBob 1.4s ease-in-out infinite}
.app-update-progress .aup-gear{transform-origin:12px 12px;animation:aupSpin 2.2s linear infinite}
.app-update-progress .aup-body{flex:1 1 auto;min-width:0;display:grid;gap:7px}
.app-update-progress .aup-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.app-update-progress .aup-title{min-width:0;font-size:13.5px;font-weight:650;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.app-update-progress .aup-percent{flex:0 0 auto;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--app-accent-primary)}
.app-update-progress .aup-track{position:relative;height:7px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--app-accent-primary) 12%,var(--app-surface-subtle))}
.app-update-progress .aup-fill{position:absolute;inset:0 auto 0 0;width:calc(var(--aup-progress,0) * 100%);min-width:7px;border-radius:inherit;background:linear-gradient(90deg,color-mix(in srgb,var(--app-accent-primary) 70%,var(--app-text-on-accent)),var(--app-accent-primary) 55%,var(--app-accent-strong,var(--app-accent-primary)));box-shadow:0 0 10px color-mix(in srgb,var(--app-accent-primary) 45%,transparent);transition:width .35s cubic-bezier(.2,.8,.2,1);overflow:hidden}
.app-update-progress .aup-fill::after{content:'';position:absolute;inset:0;background:linear-gradient(100deg,transparent 20%,color-mix(in srgb,var(--app-text-on-accent) 45%,transparent) 50%,transparent 80%);transform:translateX(-100%);animation:aupShine 1.6s ease-in-out infinite}
.app-update-progress.is-indeterminate .aup-fill{width:38%;min-width:0;transition:none;animation:aupSlide 1.3s ease-in-out infinite}
.app-update-progress .aup-meta{font-size:11.5px;line-height:1.35;color:var(--app-text-muted);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.app-update-progress[data-stage='installing'] .aup-meta{white-space:normal}
@keyframes aupBob{0%,100%{transform:translateY(-1.5px)}50%{transform:translateY(1.5px)}}
@keyframes aupSpin{to{transform:rotate(360deg)}}
@keyframes aupHalo{0%{opacity:.7;transform:scale(.92)}100%{opacity:0;transform:scale(1.18)}}
@keyframes aupShine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(220%)}}
@keyframes aupSlide{0%{transform:translateX(-100%)}100%{transform:translateX(270%)}}
@media (max-width:560px){.app-update-progress{right:16px;left:16px;width:auto;margin:0 auto;max-width:420px}}
@media (prefers-reduced-motion:reduce){.app-update-progress,.app-update-progress *,.app-update-progress *::after{animation:none!important;transition:none!important}}
body[data-reduced-motion='on'] .app-update-progress,body[data-reduced-motion='on'] .app-update-progress *,body[data-reduced-motion='on'] .app-update-progress *::after{animation:none!important;transition:none!important}
`;

export const createAppUpdateProgressCard = ({ documentRef = globalThis.document } = {}) => {
  let el = null;
  let lastStage = '';
  const ensure = () => {
    if (el || !documentRef?.body) return el;
    if (!documentRef.getElementById('app-update-progress-style')) {
      const style = documentRef.createElement('style');
      style.id = 'app-update-progress-style';
      style.textContent = STYLE;
      documentRef.head.append(style);
    }
    el = documentRef.createElement('div');
    el.className = 'app-update-progress';
    el.hidden = true;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = '<div class="aup-icon"></div><div class="aup-body"><div class="aup-head"><span class="aup-title"></span><span class="aup-percent"></span></div>'
      + '<div class="aup-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div class="aup-fill"></div></div><div class="aup-meta"></div></div>';
    documentRef.body.append(el);
    return el;
  };
  return (progress = null) => {
    const display = resolveAppUpdateProgressDisplay(progress);
    if (!display) {
      if (el) {
        el.classList.remove('is-visible');
        el.hidden = true;
      }
      lastStage = '';
      return;
    }
    const card = ensure();
    if (!card) return;
    const iconEl = card.querySelector('.aup-icon');
    const trackEl = card.querySelector('.aup-track');
    if (display.stage !== lastStage) {
      // 准备与下载共用下载图标，进入安装阶段才换成齿轮，避免图标反复重建
      if (display.stage === 'installing' || !lastStage || lastStage === 'installing') iconEl.innerHTML = display.stage === 'installing' ? ICON_INSTALL : ICON_DOWNLOAD;
      lastStage = display.stage;
    }
    card.dataset.stage = display.stage;
    card.classList.toggle('is-indeterminate', display.indeterminate);
    card.querySelector('.aup-title').textContent = display.title;
    card.querySelector('.aup-percent').textContent = display.percent == null ? '' : `${display.percent}%`;
    card.querySelector('.aup-meta').textContent = display.meta;
    card.style.setProperty('--aup-progress', String((display.percent ?? 0) / 100));
    trackEl.setAttribute('aria-label', display.title);
    if (display.percent == null) trackEl.removeAttribute('aria-valuenow');
    else trackEl.setAttribute('aria-valuenow', String(display.percent));
    if (card.hidden) {
      card.hidden = false;
      // 先显示再加类，出现时才有上浮过渡
      globalThis.requestAnimationFrame?.(() => card.classList.add('is-visible')) ?? card.classList.add('is-visible');
    }
  };
};
