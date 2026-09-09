// Windows PowerShell: node scripts/tests/dev-iframe-template-cdp-smoke.mjs
// Uses isolated iframe hosts in the inspectable dev App; no chat/settings writes.
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const smoke = async () => {
  const options = Array.from({ length: 7 }, (_, index) => `${index + 1}. 选项 ${index + 1}`);
  const doc = `<!doctype html><html><head>
    <template id="head-data"><span>头部模板</span></template>
    </head><body>
    <template id="raw-data"><SUOT>\n${options.join('\n')}\n</SUOT></template>
    <template id="nested-data"><template id="inner-data">
      <button onclick="window.__templateClicks = 1">模板按钮</button>
      <script>window.__templateScriptRan = true;</script>
    </template></template>
    <div id="ordinary"><strong>正文</strong></div>
    <div id="listRoot"></div>
    <script>
      window.__liveScriptRan = true;
      const raw = document.getElementById('raw-data').innerHTML;
      const match = raw.match(/<SUOT\\b[^>]*>([\\s\\S]*?)<\\/SUOT>/i);
      if (match) {
        for (const line of match[1].trim().split(/\\r?\\n/)) {
          const button = document.createElement('button');
          button.className = 'option-btn';
          button.textContent = line;
          document.getElementById('listRoot').appendChild(button);
        }
      }
    </script></body></html>`;

  const check = async (allowScripts) => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:300px;';
    const id = `template-smoke-${allowScripts}-${Date.now()}`;
    const errors = [];
    let ready = false;
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow || event.data?.id !== id) return;
      if (/^chatapp:iframe-(?:host-)?error$/.test(event.data.type)) errors.push(event.data.message);
      if (event.data.type === 'chatapp:iframe-debug' && String(event.data.message).startsWith('script-settled ')) ready = true;
    };
    window.addEventListener('message', onMessage);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('iframe host load timed out')), 8000);
        frame.onload = () => { clearTimeout(timeout); resolve(); };
        frame.onerror = () => { clearTimeout(timeout); reject(new Error('iframe host failed to load')); };
        frame.src = new URL('/iframe-host.html', location.href).href;
        document.body.appendChild(frame);
      });
      frame.contentWindow.postMessage({ type: 'chatapp:iframe-load', id, doc, allowScripts }, location.origin);
      const deadline = Date.now() + 8000;
      while (!ready && !errors.length && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!ready) throw new Error(`iframe host did not settle: ${errors.join('; ')}`);
      const d = frame.contentDocument;
      const raw = d.getElementById('raw-data');
      const inner = d.getElementById('nested-data')?.content.querySelector('#inner-data');
      const expectedRaw = new DOMParser().parseFromString(doc, 'text/html').getElementById('raw-data');
      return {
        allowScripts,
        errors,
        rawPreserved: raw?.innerHTML === expectedRaw.innerHTML,
        templateHasNoOrdinaryChildren: raw?.childNodes.length === 0,
        headPreserved: d.head.querySelector('#head-data')?.content.textContent === '头部模板',
        nestedPreserved: inner?.content.querySelector('button')?.textContent === '模板按钮',
        inertScriptPreserved: inner?.content.querySelector('script')?.textContent.includes('__templateScriptRan'),
        inertHandlerPreserved: inner?.content.querySelector('button')?.getAttribute('onclick') === 'window.__templateClicks = 1',
        templateScriptRan: Boolean(frame.contentWindow.__templateScriptRan),
        templateClickRan: Boolean(frame.contentWindow.__templateClicks),
        liveScriptRan: Boolean(frame.contentWindow.__liveScriptRan),
        optionLabels: [...d.querySelectorAll('.option-btn')].map(button => button.textContent),
        ordinaryContent: d.getElementById('ordinary')?.textContent,
      };
    } finally {
      window.removeEventListener('message', onMessage);
      frame.remove();
    }
  };

  return { options, cases: [await check(true), await check(false)] };
};

try {
  const result = await evaluateInApp(`(${smoke.toString()})()`, { timeoutMs: 25000 });
  for (const item of result.cases) {
    assert.deepEqual(item.errors, []);
    for (const key of ['rawPreserved', 'templateHasNoOrdinaryChildren', 'headPreserved', 'nestedPreserved', 'inertScriptPreserved', 'inertHandlerPreserved']) {
      assert.equal(item[key], true, `${key}, allowScripts=${item.allowScripts}`);
    }
    assert.equal(item.templateScriptRan, false);
    assert.equal(item.templateClickRan, false);
    assert.equal(item.liveScriptRan, item.allowScripts);
    assert.deepEqual(item.optionLabels, item.allowScripts ? result.options : []);
    assert.equal(item.ordinaryContent, '正文');
  }
  console.log('ok - iframe template data, head/nested templates, inert scripts, and action options (scripts enabled/disabled)');
  process.exit(0);
} catch (error) {
  console.error(error.stack || error);
  process.exit(1);
}
