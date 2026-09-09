import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createWsClient,
  findAppPageTarget,
} from '../dev/cdp-client.mjs';

const shouldCaptureScreenshots = process.argv.includes('--screenshots');
const page = await findAppPageTarget();
if (!page?.webSocketDebuggerUrl) {
  throw new Error('OmniTavern CDP target not found; start npm run dev with WebView2 remote debugging first');
}

const pending = new Map();
let commandId = 0;
let resolveOpen;
let rejectOpen;
const opened = new Promise((resolvePromise, rejectPromise) => {
  resolveOpen = resolvePromise;
  rejectOpen = rejectPromise;
});

const socket = createWsClient(page.webSocketDebuggerUrl, {
  onOpen: () => resolveOpen(),
  onError: (error) => {
    rejectOpen(error);
    pending.forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    });
    pending.clear();
  },
  onMessage: (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw || '{}'));
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result || {});
  },
});

const command = async (method, params = {}, timeoutMs = 20000) => {
  await opened;
  const id = ++commandId;
  return new Promise((resolveCommand, rejectCommand) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectCommand(new Error(`CDP ${method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
};

const evaluate = async (expression) => {
  const response = await command('Runtime.evaluate', {
    expression: `(async () => (${expression}))()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  }
  return response.result?.value ?? null;
};

const waitForFrames = () => new Promise(resolveWait => setTimeout(resolveWait, 140));

const setupExpression = String.raw`(async () => {
  const panel = window.appBridge?.debugUiRegistry?.panels?.configPanel;
  if (!panel) throw new Error('config panel unavailable');
  const [{ themeManager }, { themeStore }] = await Promise.all([
    import('./scripts/ui/theme-manager.js'),
    import('./scripts/storage/theme-store.js'),
  ]);
  const errors = [];
  const errorHandler = event => errors.push(String(event.error?.stack || event.message || 'window error'));
  const rejectionHandler = event => errors.push(String(event.reason?.stack || event.reason || 'unhandled rejection'));
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', rejectionHandler);
  window.__apiConfigCdpProbe = {
    panel,
    errors,
    errorHandler,
    rejectionHandler,
    originalReducedMotion: document.body.dataset.reducedMotion,
    themeManager,
    themes: {
      light: themeStore.getTheme('classic-light'),
      dark: themeStore.getTheme('classic-dark'),
    },
    async cleanup() {
      panel.hide?.();
      window.removeEventListener('error', errorHandler);
      window.removeEventListener('unhandledrejection', rejectionHandler);
      if (this.originalReducedMotion === undefined) delete document.body.dataset.reducedMotion;
      else document.body.dataset.reducedMotion = this.originalReducedMotion;
      themeManager.applyCurrentTheme();
      delete window.__apiConfigCdpProbe;
      return true;
    },
  };
  return true;
})()`;

const setSceneExpression = theme => `(async () => {
  const probe = window.__apiConfigCdpProbe;
  const panel = probe.panel;
  probe.themeManager.applyThemePreset({ preset: probe.themes[${JSON.stringify(theme)}] });
  delete document.body.dataset.reducedMotion;
  await panel.show({ tab: 'chat' });
  const modelCandidates = [
    'zeta-model',
    'gpt-mini',
    'deepseek-chat',
    'chat-gpt-pro',
    ...Array.from({ length: 153 }, (_, index) => 'model-' + String(index + 1).padStart(3, '0')),
  ];
  panel.renderModelOptions(modelCandidates);
  const input = panel.element.querySelector('#config-model');
  const originalRenderModelOptions = panel.renderModelOptions;
  let filterRenderCount = 0;
  panel.renderModelOptions = function (...args) {
    filterRenderCount += 1;
    return originalRenderModelOptions.apply(this, args);
  };
  input.value = 'g';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.value = 'gp';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.value = 'gpt';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  const filterRenderCountBeforeDebounce = filterRenderCount;
  await new Promise(resolve => setTimeout(resolve, 100));
  panel.renderModelOptions = originalRenderModelOptions;
  await new Promise(resolve => setTimeout(resolve, 220));
  const modal = panel.element.querySelector('.api-config-modal');
  const close = panel.element.querySelector('#config-close');
  const footer = panel.element.querySelector('.api-config-footer');
  const note = panel.element.querySelector('.api-config-live-note');
  const chips = Array.from(panel.element.querySelectorAll('.api-config-model-chip'));
  const modalRect = modal.getBoundingClientRect();
  const footerRect = footer.getBoundingClientRect();
  const actionRects = Array.from(footer.querySelectorAll('.api-config-button'))
    .map(button => button.getBoundingClientRect());
  return {
    viewport: { width: innerWidth, height: innerHeight },
    theme: document.body.dataset.themeMode,
    modal: modalRect.toJSON(),
    radius: getComputedStyle(modal).borderRadius,
    surface: getComputedStyle(modal).backgroundColor,
    animationName: getComputedStyle(modal).animationName,
    close: close.getBoundingClientRect().toJSON(),
    footerBottomDelta: Math.abs(modalRect.bottom - footerRect.bottom),
    footerActionsFit: actionRects.every(rect => rect.left >= modalRect.left && rect.right <= modalRect.right),
    liveNoteDisplay: getComputedStyle(note).display,
    order: chips.slice(0, 4).map(chip => chip.textContent),
    matches: chips.filter(chip => chip.classList.contains('is-match')).map(chip => chip.textContent),
    candidateCount: chips.length,
    filterRenderCount,
    filterRenderCountBeforeDebounce,
    visibleCount: chips.filter(chip => {
      const rect = chip.getBoundingClientRect();
      return getComputedStyle(chip).display !== 'none' && rect.width > 0 && rect.height > 0;
    }).length,
    datalistPresent: Boolean(panel.element.querySelector('datalist')),
  };
})()`;

const exerciseExpression = String.raw`(async () => {
  const probe = window.__apiConfigCdpProbe;
  const panel = probe.panel;
  const toggle = panel.element.querySelector('#config-transport-toggle');
  const content = panel.element.querySelector('#config-transport-content');
  toggle.click();
  await new Promise(resolve => setTimeout(resolve, 340));
  const expanded = panel.element.querySelector('#config-transport-section').classList.contains('is-expanded')
    && toggle.getAttribute('aria-expanded') === 'true'
    && content.getAttribute('aria-hidden') === 'false'
    && content.getBoundingClientRect().height > 0;
  toggle.click();
  await new Promise(resolve => setTimeout(resolve, 340));
  const collapsed = !panel.element.querySelector('#config-transport-section').classList.contains('is-expanded')
    && content.getAttribute('aria-hidden') === 'true';

  panel.element.querySelector('.api-config-tab[data-tab="image"]').click();
  await new Promise(resolve => setTimeout(resolve, 180));
  const imageTabActivated = panel.activeTab === 'image'
    && panel.element.querySelector('#config-title').textContent === '图片模型配置'
    && panel.element.querySelector('.api-config-tab[data-tab="image"]').classList.contains('is-active')
    && getComputedStyle(panel.element.querySelector('#image-params-entry')).display !== 'none';
  const originalVoiceMode = panel.voiceConnectionMode;
  let voiceTabActivated = false;
  let voiceTestButtonVisible = false;
  let sharedVoiceModeVisible = false;
  let splitVoiceModeWorks = false;
  try {
    panel.element.querySelector('.api-config-tab[data-tab="voice"]').click();
    await new Promise(resolve => setTimeout(resolve, 180));
    await panel.setVoiceConnectionMode('shared', { persist: false });
    voiceTabActivated = panel.activeTab === 'voice'
      && panel.element.querySelector('#config-title').textContent === '语音模型配置'
      && panel.element.querySelector('.api-config-tab[data-tab="voice"]').classList.contains('is-active');
    voiceTestButtonVisible = getComputedStyle(panel.element.querySelector('#config-test')).display !== 'none';
    sharedVoiceModeVisible = panel.configManager.scope === 'voice_shared'
      && getComputedStyle(panel.element.querySelector('#config-voice-shared-models')).display === 'grid'
      && getComputedStyle(panel.element.querySelector('#config-voice-capability-tabs')).display === 'none';
    panel.element.querySelector('[data-voice-connection-mode="split"]').click();
    await new Promise(resolve => setTimeout(resolve, 180));
    panel.element.querySelector('[data-voice-capability="stt"]').click();
    await new Promise(resolve => setTimeout(resolve, 180));
    splitVoiceModeWorks = panel.voiceConnectionMode === 'split'
      && panel.voiceCapability === 'stt'
      && panel.configManager.scope === 'voice_stt'
      && getComputedStyle(panel.element.querySelector('#config-voice-capability-tabs')).display === 'grid'
      && panel.element.querySelector('#config-model-label').textContent === 'STT 模型';
  } finally {
    await panel.setVoiceConnectionMode(originalVoiceMode);
  }
  panel.element.querySelector('.api-config-tab[data-tab="chat"]').click();
  await new Promise(resolve => setTimeout(resolve, 180));
  const chatTabRestored = panel.activeTab === 'chat'
    && panel.element.querySelector('#config-title').textContent === '聊天模型配置';

  document.body.dataset.reducedMotion = 'on';
  panel.hide();
  await panel.show({ tab: 'chat' });
  const reducedMotionAnimation = getComputedStyle(panel.element.querySelector('.api-config-modal')).animationName;
  delete document.body.dataset.reducedMotion;

  panel.element.querySelector('#config-close').click();
  const closeButtonHidPanel = panel.element.style.display === 'none'
    && panel.overlayElement.style.display === 'none';
  return {
    expanded,
    collapsed,
    imageTabActivated,
    voiceTabActivated,
    voiceTestButtonVisible,
    sharedVoiceModeVisible,
    splitVoiceModeWorks,
    chatTabRestored,
    reducedMotionAnimation,
    closeButtonHidPanel,
    errors: probe.errors.slice(),
  };
})()`;

const secondaryExpression = theme => `(async () => {
  const probe = window.__apiConfigCdpProbe;
  const panel = probe.panel;
  probe.themeManager.applyThemePreset({ preset: probe.themes[${JSON.stringify(theme)}] });
  await panel.show({ tab: 'chat' });
  panel.setExcludedGenerationParams([], { emit: false });

  const iconSelectors = [
    '#config-close',
    '.api-config-tab[data-tab="chat"]',
    '.api-config-tab[data-tab="image"]',
    '.api-config-tab[data-tab="voice"]',
    '#profile-new',
    '#profile-rename',
    '#profile-delete',
    '#toggle-apikey',
    '#manage-keys',
    '#refresh-models',
    '#open-generation-param-filter',
    '#config-transport-toggle',
    '#toggle-proxy-token',
    '#config-test',
    '#config-save',
  ];
  const svgIconsPresent = iconSelectors.every(selector =>
    Boolean(panel.element.querySelector(selector)?.querySelector('svg'))
  );
  const actionText = iconSelectors
    .map(selector => panel.element.querySelector(selector)?.textContent || '')
    .join('');
  const legacyActionGlyphsPresent = /[🔑×›▾⌄⟳⇄]/u.test(actionText);

  panel.element.querySelector('#open-generation-param-filter').click();
  await new Promise(resolve => setTimeout(resolve, 280));
  const filterOverlay = document.querySelector('.api-param-filter-overlay');
  const filterDialog = filterOverlay?.querySelector('.api-param-filter-dialog');
  filterDialog?.querySelector('[data-rp-tab="exclude"]')?.click();
  const commonChip = filterDialog?.querySelector('[data-rp-role="exclude-common"] .api-param-filter-common-chip');
  const firstParam = commonChip?.dataset.rpExclude || '';
  commonChip?.click();
  await new Promise(resolve => setTimeout(resolve, 80));
  const activeChip = firstParam
    ? filterDialog?.querySelector('.api-param-filter-common-chip[data-rp-exclude="' + CSS.escape(firstParam) + '"]')
    : null;
  const selectedChip = filterDialog?.querySelector('.api-param-filter-selected-chip');
  const filterRect = filterDialog?.getBoundingClientRect();
  const filterStyle = filterDialog ? getComputedStyle(filterDialog) : null;
  const overlayStyle = filterOverlay ? getComputedStyle(filterOverlay) : null;
  const closeButton = filterDialog?.querySelector('.api-param-filter-icon-button');
  const closeRect = closeButton?.getBoundingClientRect();
  const closeTopElement = closeRect
    ? document.elementFromPoint(closeRect.left + closeRect.width / 2, closeRect.top + closeRect.height / 2)
    : null;
  const addButton = filterDialog?.querySelector('[data-rp-action="exclude-add"]');
  const addLabelRect = addButton?.querySelector('span')?.getBoundingClientRect();
  const filter = {
    exists: Boolean(filterDialog),
    rect: filterRect?.toJSON?.() || null,
    radius: filterStyle?.borderRadius || '',
    animationName: filterStyle?.animationName || '',
    backdropFilter: overlayStyle?.backdropFilter || overlayStyle?.webkitBackdropFilter || '',
    activeChip: Boolean(activeChip?.classList.contains('is-active')),
    activeCheck: Boolean(activeChip?.querySelector('svg')),
    selectedChip: selectedChip?.textContent?.trim() === firstParam,
    closeTopmost: Boolean(closeTopElement && filterDialog?.contains(closeTopElement)),
    addButtonWidth: addButton?.getBoundingClientRect().width || 0,
    addLabelSingleLine: Boolean(addLabelRect && addLabelRect.height < 20),
    closeTopElement: closeTopElement ? {
      tag: closeTopElement.tagName,
      id: closeTopElement.id,
      className: typeof closeTopElement.className === 'string' ? closeTopElement.className : '',
      position: getComputedStyle(closeTopElement).position,
      zIndex: getComputedStyle(closeTopElement).zIndex,
    } : null,
  };
  filterDialog?.querySelector('[data-rp-action="apply"]')?.click();
  await new Promise(resolve => setTimeout(resolve, 40));
  filter.closed = !document.querySelector('.api-param-filter-overlay');
  filter.applied = panel.excludedGenerationParams.includes(firstParam)
    && panel.element.querySelector('#generation-param-filter-summary').textContent.includes('1');
  panel.setExcludedGenerationParams([], { emit: false });

  await panel.setActiveTab('image');
  const imageModelInput = panel.element.querySelector('#config-model');
  imageModelInput.value = 'smoke-image-model';
  await panel.showImageParamsPage();
  await new Promise(resolve => setTimeout(resolve, 220));
  const modal = panel.element.querySelector('.api-config-modal');
  const mainHeader = panel.element.querySelector(':scope > .api-config-modal > .api-config-header');
  const imagePage = panel.element.querySelector('#config-image-params-page');
  const imagePanel = imagePage?.querySelector('.igp-panel-embedded');
  const imageHeader = imagePanel?.querySelector('.igp-header');
  const imageFooter = imagePanel?.querySelector('.igp-footer');
  const fieldsGrid = imagePanel?.querySelector('.igp-fields-grid');
  const firstField = imagePanel?.querySelector('.igp-field');
  const gridColumns = fieldsGrid
    ? getComputedStyle(fieldsGrid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length
    : 0;
  const modalRect = modal.getBoundingClientRect();
  const footerRect = imageFooter?.getBoundingClientRect();
  const image = {
    pageClass: panel.element.classList.contains('is-image-params-page'),
    mainHeaderHidden: getComputedStyle(mainHeader).display === 'none',
    headerVisible: Boolean(imageHeader && imageHeader.getBoundingClientRect().height > 0),
    headerSvgCount: imageHeader?.querySelectorAll('svg').length || 0,
    fieldCount: fieldsGrid?.children.length || 0,
    gridColumns,
    fieldRadius: firstField ? getComputedStyle(firstField).borderRadius : '',
    fieldPadding: firstField ? getComputedStyle(firstField).padding : '',
    draftAvailable: Boolean(panel.getDraftConfig({ tab: 'image' })),
    modelUsesDraft: imagePanel?.querySelector('.igp-model-sub')?.textContent.includes('smoke-image-model') || false,
    footerBottomDelta: footerRect ? Math.abs(modalRect.bottom - footerRect.bottom) : null,
  };
  imageHeader?.querySelector('[data-action="back"]')?.click();
  await new Promise(resolve => setTimeout(resolve, 80));
  image.backRestoredMain = !panel.element.classList.contains('is-image-params-page')
    && getComputedStyle(panel.element.querySelector('#config-main-page')).display === 'flex';
  panel.hide();

  return {
    viewport: { width: innerWidth, height: innerHeight },
    theme: document.body.dataset.themeMode,
    svgIconsPresent,
    legacyActionGlyphsPresent,
    filter,
    image,
    errors: probe.errors.slice(),
  };
})()`;

const prepareSecondaryCaptureExpression = ({ theme, surface }) => `(async () => {
  const probe = window.__apiConfigCdpProbe;
  const panel = probe.panel;
  probe.themeManager.applyThemePreset({ preset: probe.themes[${JSON.stringify(theme)}] });
  await panel.show({ tab: 'chat' });
  if (${JSON.stringify(surface)} === 'filter') {
    panel.setExcludedGenerationParams([], { emit: false });
    panel.element.querySelector('#open-generation-param-filter').click();
  } else {
    await panel.setActiveTab('image');
    await panel.showImageParamsPage();
  }
  await new Promise(resolve => setTimeout(resolve, 320));
  return true;
})()`;

const prepareVoiceCaptureExpression = ({ theme, mode }) => `(async () => {
  const probe = window.__apiConfigCdpProbe;
  const panel = probe.panel;
  probe.themeManager.applyThemePreset({ preset: probe.themes[${JSON.stringify(theme)}] });
  await panel.show({ tab: 'voice' });
  await panel.setVoiceConnectionMode(${JSON.stringify(mode)}, { persist: false });
  if (${JSON.stringify(mode)} === 'split') await panel.setVoiceCapability('stt');
  await new Promise(resolve => setTimeout(resolve, 320));
  return true;
})()`;

const cleanupSecondaryCaptureExpression = String.raw`(() => {
  document.querySelector('.api-param-filter-header [data-rp-action="cancel"]')?.click();
  window.__apiConfigCdpProbe?.panel?.hide?.();
  return true;
})()`;

const captureScene = async (name) => {
  const response = await command('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const path = resolve(`scripts/dev/tmp/${name}.png`);
  await writeFile(path, Buffer.from(response.data || '', 'base64'));
  return path;
};

const reloadAndWaitForApp = async ({ timeoutMs = 30000 } = {}) => {
  await command('Page.reload', { ignoreCache: false });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await waitForFrames();
    try {
      const ready = await evaluate(
        'Boolean(window.appBridge?.debugUiRegistry?.panels?.configPanel)',
      );
      if (ready === true) return;
    } catch {}
  }
  throw new Error('app did not become ready after reload');
};

const report = {
  desktop: [],
  mobile: [],
  exercise: null,
  secondaryDesktop: null,
  secondaryMobile: null,
  screenshots: [],
};

try {
  await command('Page.bringToFront');
  await reloadAndWaitForApp();
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1200,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(setupExpression);

  for (const theme of ['light', 'dark']) {
    const scene = await evaluate(setSceneExpression(theme));
    report.desktop.push(scene);
    await waitForFrames();
    if (shouldCaptureScreenshots) {
      report.screenshots.push(await captureScene(`api-config-desktop-${theme}`));
    }
  }

  report.exercise = await evaluate(exerciseExpression);
  assert.equal(report.exercise.expanded, true);
  assert.equal(report.exercise.collapsed, true);
  assert.equal(report.exercise.imageTabActivated, true);
  assert.equal(report.exercise.voiceTabActivated, true);
  assert.equal(report.exercise.voiceTestButtonVisible, true);
  assert.equal(report.exercise.sharedVoiceModeVisible, true);
  assert.equal(report.exercise.splitVoiceModeWorks, true);
  assert.equal(report.exercise.chatTabRestored, true);
  assert.equal(report.exercise.reducedMotionAnimation, 'none');
  assert.equal(report.exercise.closeButtonHidPanel, true);
  assert.deepEqual(report.exercise.errors, []);

  report.secondaryDesktop = await evaluate(secondaryExpression('light'));
  if (shouldCaptureScreenshots) {
    await evaluate(prepareSecondaryCaptureExpression({ theme: 'light', surface: 'filter' }));
    report.screenshots.push(await captureScene('api-config-filter-desktop-light'));
    await evaluate(cleanupSecondaryCaptureExpression);
    await evaluate(prepareSecondaryCaptureExpression({ theme: 'light', surface: 'image' }));
    report.screenshots.push(await captureScene('api-config-image-params-desktop-light'));
    await evaluate(cleanupSecondaryCaptureExpression);
    await evaluate(prepareVoiceCaptureExpression({ theme: 'light', mode: 'shared' }));
    report.screenshots.push(await captureScene('api-config-voice-shared-desktop-light'));
    await evaluate(prepareVoiceCaptureExpression({ theme: 'light', mode: 'split' }));
    report.screenshots.push(await captureScene('api-config-voice-split-desktop-light'));
    await evaluate(cleanupSecondaryCaptureExpression);
  }

  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844,
  });
  for (const theme of ['light', 'dark']) {
    const scene = await evaluate(setSceneExpression(theme));
    report.mobile.push(scene);
    await waitForFrames();
    if (shouldCaptureScreenshots) {
      report.screenshots.push(await captureScene(`api-config-mobile-${theme}`));
    }
  }
  report.secondaryMobile = await evaluate(secondaryExpression('dark'));
  if (shouldCaptureScreenshots) {
    await evaluate(prepareSecondaryCaptureExpression({ theme: 'dark', surface: 'filter' }));
    report.screenshots.push(await captureScene('api-config-filter-mobile-dark'));
    await evaluate(cleanupSecondaryCaptureExpression);
    await evaluate(prepareSecondaryCaptureExpression({ theme: 'dark', surface: 'image' }));
    report.screenshots.push(await captureScene('api-config-image-params-mobile-dark'));
    await evaluate(cleanupSecondaryCaptureExpression);
    await evaluate(prepareVoiceCaptureExpression({ theme: 'dark', mode: 'shared' }));
    report.screenshots.push(await captureScene('api-config-voice-shared-mobile-dark'));
    await evaluate(prepareVoiceCaptureExpression({ theme: 'dark', mode: 'split' }));
    report.screenshots.push(await captureScene('api-config-voice-split-mobile-dark'));
    await evaluate(cleanupSecondaryCaptureExpression);
  }

  const expectedOrder = ['gpt-mini', 'chat-gpt-pro', 'zeta-model', 'deepseek-chat'];
  for (const scene of [...report.desktop, ...report.mobile]) {
    assert.deepEqual(scene.order, expectedOrder);
    assert.deepEqual(scene.matches, ['gpt-mini', 'chat-gpt-pro']);
    assert.equal(scene.candidateCount, 157);
    assert.equal(scene.visibleCount, 157);
    assert.equal(scene.filterRenderCountBeforeDebounce, 0);
    assert.equal(scene.filterRenderCount, 1);
    assert.equal(scene.datalistPresent, false);
    assert.equal(scene.footerActionsFit, true);
    assert.ok(scene.footerBottomDelta < 1);
    assert.ok(scene.modal.top >= 0 && scene.modal.bottom <= scene.viewport.height);
    assert.ok(scene.close.width >= 34 && scene.close.height >= 34);
  }
  assert.ok(Math.abs(report.desktop[0].modal.width - 672) < 1);
  assert.equal(report.desktop[0].radius, '20px');
  assert.equal(report.desktop[0].animationName, 'api-config-modal-in');
  assert.ok(report.mobile[0].modal.width <= 375);
  assert.equal(report.mobile[0].liveNoteDisplay, 'none');

  for (const secondary of [report.secondaryDesktop, report.secondaryMobile]) {
    assert.equal(secondary.svgIconsPresent, true);
    assert.equal(secondary.legacyActionGlyphsPresent, false);
    assert.equal(secondary.filter.exists, true);
    assert.equal(secondary.filter.radius, '18px');
    assert.equal(secondary.filter.animationName, 'api-param-filter-dialog-in');
    assert.match(secondary.filter.backdropFilter, /blur\(1\.5px\)/);
    assert.equal(secondary.filter.activeChip, true);
    assert.equal(secondary.filter.activeCheck, true);
    assert.equal(secondary.filter.selectedChip, true);
    assert.equal(secondary.filter.closeTopmost, true);
    assert.ok(secondary.filter.addButtonWidth >= 72);
    assert.equal(secondary.filter.addLabelSingleLine, true);
    assert.equal(secondary.filter.closed, true);
    assert.equal(secondary.filter.applied, true);
    assert.equal(secondary.image.pageClass, true);
    assert.equal(secondary.image.mainHeaderHidden, true);
    assert.equal(secondary.image.headerVisible, true);
    assert.ok(secondary.image.headerSvgCount >= 2);
    assert.ok(secondary.image.fieldCount > 0);
    assert.equal(secondary.image.fieldRadius, '14px');
    assert.equal(secondary.image.fieldPadding, '16px');
    assert.equal(secondary.image.draftAvailable, true);
    assert.equal(secondary.image.modelUsesDraft, true);
    assert.ok(secondary.image.footerBottomDelta < 1);
    assert.equal(secondary.image.backRestoredMain, true);
    assert.deepEqual(secondary.errors, []);
  }
  assert.ok(Math.abs(report.secondaryDesktop.filter.rect.width - 600) < 1);
  assert.equal(report.secondaryDesktop.image.gridColumns, 3);
  assert.ok(report.secondaryMobile.filter.rect.left >= 0);
  assert.ok(report.secondaryMobile.filter.rect.right <= report.secondaryMobile.viewport.width);
  assert.equal(report.secondaryMobile.image.gridColumns, 1);
  assert.deepEqual(await evaluate('window.__apiConfigCdpProbe.errors.slice()'), []);
} finally {
  try {
    await evaluate('window.__apiConfigCdpProbe?.cleanup?.() ?? true');
  } catch {}
  try {
    await command('Emulation.clearDeviceMetricsOverride');
  } catch {}
  socket.close();
}

console.log(JSON.stringify(report, null, 2));
