// Windows dev WebView: isolated API markup, no credentials or configuration writes.
// Unknown units reproduce the CSS parser rejecting dvh before Chromium 108.
// This checks that compatibility boundary, not an emulation of a Huawei device.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { evaluateInApp, createWsClient, findAppPageTarget } from '../dev/cdp-client.mjs';

const diagnose = process.argv.includes('--diagnose');
const captureDir = process.env.API_VIEWPORT_SCREENSHOT_DIR;
const run = async () => {
  let panel = window.appBridge?.debugUiRegistry?.panels?.configPanel;
  for (let i = 0; !panel && i < 50; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    panel = window.appBridge?.debugUiRegistry?.panels?.configPanel;
  }
  if (!panel) throw new Error('Open the Windows dev app with CDP enabled');
  if (!panel.element) panel.createUI();
  const cssPaths = ['main', 'qq-legacy', 'theme', 'api-config', 'api-config-secondary'];
  const css = (await Promise.all(cssPaths.map(async name => {
    const response = await fetch(new URL(`./assets/css/${name}.css`, location.href), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cannot read ${name}.css`);
    return response.text();
  }))).join('\n');
  const markup = panel.element.cloneNode(true);
  markup.classList.remove('is-image-params-page');
  markup.style.display = 'flex';
  markup.querySelector('#config-main-page').style.display = 'flex';
  markup.querySelectorAll('input, textarea').forEach(el => {
    el.value = '';
    el.removeAttribute('value');
    if (el.tagName === 'TEXTAREA') el.textContent = '';
  });
  markup.querySelectorAll('select').forEach(el => el.replaceChildren(new Option('测试配置', 'fixture')));
  markup.querySelector('#config-baseurl').value = 'https://example.invalid/v1';
  markup.querySelector('#config-model').value = 'example-model';
  markup.querySelector('#model-options').replaceChildren();
  markup.querySelector('#model-options').style.display = 'none';
  markup.querySelector('#config-status').style.display = 'none';
  const frame = document.createElement('iframe');
  frame.id = 'api-viewport-smoke';
  frame.title = 'API viewport compatibility check';
  frame.style.cssText = 'position:fixed;left:0;top:0;border:0;z-index:2147483646;background:white;';
  document.body.append(frame);
  window.__apiViewportSmokeCleanup = () => {
    frame.remove();
    delete window.__apiViewportSmokeCleanup;
  };
  const doc = frame.contentDocument;
  doc.open();
  doc.write('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>');
  doc.close();
  doc.body.dataset.themeMode = 'dark';
  doc.body.dataset.reducedMotion = 'on';
  const tokens = getComputedStyle(document.documentElement);
  for (const key of tokens) if (key.startsWith('--')) doc.documentElement.style.setProperty(key, tokens.getPropertyValue(key));
  const sheet = doc.createElement('style');
  doc.head.append(sheet);
  const extra = 'html,body{margin:0;width:100%;height:100%;overflow:hidden}*{animation:none!important;transition:none!important}';
  const results = [];
  const tall = '<div style="height:1700px">参数设置</div>';
  const surfaces = {
    main: [markup.outerHTML, '.api-config-modal', '.api-config-header', '.api-config-footer', '.api-config-scroll'],
    image: [`<div id="config-panel" class="api-config-panel is-image-params-page" style="display:flex"><div class="api-config-modal"><div id="config-image-params-page" style="display:flex;flex:1"><div class="igp-panel igp-panel-embedded" style="display:flex;width:100%"><header class="igp-header">图片生成参数</header><div class="igp-body">${tall}</div><footer class="igp-footer"><button>保存</button></footer></div></div></div></div>`, '.api-config-modal', '.igp-header', '.igp-footer', '.igp-body'],
    filter: [`<div class="api-param-filter-overlay"><div class="api-param-filter-dialog"><header class="api-param-filter-header">请求参数过滤</header><div class="api-param-filter-body">${tall}</div><footer class="api-param-filter-footer"><button>完成</button></footer></div></div>`, '.api-param-filter-dialog', '.api-param-filter-header', '.api-param-filter-footer', '.api-param-filter-body'],
    compatibility: [`<div class="api-fc-compat-panel" style="display:flex"><div class="api-fc-compat-modal"><header class="api-fc-compat-header">工具调用兼容性</header><div class="api-fc-compat-scroll">${tall}</div><footer class="api-fc-compat-footer"><button>完成</button></footer></div></div>`, '.api-fc-compat-modal', '.api-fc-compat-header', '.api-fc-compat-footer', '.api-fc-compat-scroll'],
  };
  // Run modern first, leave the narrow legacy main panel visible for a screenshot.
  for (const legacy of [false, true]) {
    sheet.textContent = (legacy ? css.replace(/\b(\d+(?:\.\d+)?)dvh\b/g, '$1unsupported-vh') : css) + extra;
    for (const [width, height] of [[1100, 860], [600, 800], [390, 844]]) {
      frame.style.width = `${width}px`;
      frame.style.height = `${height}px`;
      doc.documentElement.style.setProperty('--app-visual-height', `${height}px`);
      for (const name of ['image', 'filter', 'compatibility', 'main']) {
        const [html, modalSelector, headerSelector, footerSelector, scrollSelector] = surfaces[name];
        doc.body.innerHTML = html;
        const modal = doc.querySelector(modalSelector);
        const header = doc.querySelector(headerSelector);
        const footer = doc.querySelector(footerSelector);
        const scroll = doc.querySelector(scrollSelector);
        const modalRect = modal.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        scroll.scrollTop = 200;
        results.push({
          name, legacy, width, height,
          top: Math.round(modalRect.top), bottom: Math.round(modalRect.bottom),
          maxHeight: frame.contentWindow.getComputedStyle(modal).maxHeight,
          controlsFit: headerRect.top >= 0 && footerRect.bottom <= height && footerRect.top >= headerRect.bottom,
          scrolls: scroll.scrollTop > 0 && scroll.clientHeight > 0,
          horizontalOverflow: doc.documentElement.scrollWidth > width,
        });
      }
    }
  }
  return results;
};

try {
  const results = await evaluateInApp(`(${run.toString()})()`, { timeoutMs: 20000 });
  if (captureDir) {
    await mkdir(captureDir, { recursive: true });
    const target = await findAppPageTarget();
    const data = await new Promise((resolve, reject) => {
      let screenshot;
      const client = createWsClient(target.webSocketDebuggerUrl, {
        onOpen: () => client.send(JSON.stringify({ id: 1, method: 'Emulation.setDeviceMetricsOverride', params: { width: 390, height: 844, deviceScaleFactor: 1, mobile: false } })),
        onError: reject,
        onMessage: raw => {
          const message = JSON.parse(raw);
          if (message.error) { client.close(); reject(new Error(JSON.stringify(message.error))); return; }
          if (message.id === 1) client.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'png' } }));
          if (message.id === 2) {
            screenshot = message.result.data;
            client.send(JSON.stringify({ id: 3, method: 'Emulation.clearDeviceMetricsOverride', params: {} }));
          }
          if (message.id === 3) { client.close(); resolve(screenshot); }
        },
      });
    });
    await writeFile(`${captureDir}/api-viewport-${diagnose ? 'before' : 'after'}.png`, Buffer.from(data, 'base64'));
  }
  if (diagnose) console.log(JSON.stringify(results, null, 2));
  else {
    for (const result of results) {
      const label = JSON.stringify(result);
      assert(result.controlsFit, `Header and footer must fit: ${label}`);
      assert(result.scrolls, `Long content must scroll inside the dialog: ${label}`);
      assert(!result.horizontalOverflow, `No horizontal overflow: ${label}`);
    }
    console.log('ok - API main, image parameters, parameter filter and tool compatibility retain visible controls and internal scrolling with and without dvh, at 390/600/1100px');
  }
} finally {
  await evaluateInApp('window.__apiViewportSmokeCleanup?.()').catch(() => {});
}
