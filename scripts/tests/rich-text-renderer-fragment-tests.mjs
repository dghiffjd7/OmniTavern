import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
// buildIframeSrcDoc 构建期只读父文档主题标记；Node 下无 document 全局，补最小 stub。
globalThis.document ??= { body: { dataset: {} } };

const {
  isHeadlessScriptOnlyHtml,
  captureRichDetailsOpenStates,
  coalesceFencedHtmlTailParts,
  buildIframeBridgeScript,
  buildIframeHeightTraceEvent,
  shouldDropLegacyIframeHeightEcho,
  buildIframeSrcDoc,
  buildRichTextRenderPlan,
  buildDollarGlobalShim,
  buildFrameworkGlobalShim,
  buildMvuCompatBridge,
  cleanupRichIframeElement,
  cleanupRichText,
  expandRichImageTokensForHtml,
  getRichDetailsStateKey,
  prepareRichFragmentDisplayHtmlForParsing,
  prepareRichFragmentHtmlForParsing,
  resolveCompatRpGreetingSwipeTarget,
  restoreRichDetailsOpenStates,
  stripResidualXmlTagsForDisplay,
  splitFencedCodeBlocks,
} = await import('../../src/scripts/ui/chat/rich-text-renderer.js');

const tests = [];

tests.push({
  name: 'rich text cleanup disconnects every iframe runtime before message removal',
  fn: () => {
    const cleared = [];
    const deleted = [];
    const iframe = {
      dataset: {
        iframeId: 'iframe-cleanup-1',
        iframeAutoResize: '1',
      },
    };
    assert.equal(cleanupRichIframeElement(iframe, {
      clearObservers: target => cleared.push(target),
      deleteDebugState: id => deleted.push(id),
    }), true);
    assert.deepEqual(cleared, [iframe]);
    assert.deepEqual(deleted, ['iframe-cleanup-1']);

    const nested = {
      dataset: { iframeId: 'iframe-cleanup-2', iframeAutoResize: '1' },
      contentWindow: { document: {} },
    };
    cleanupRichText({
      matches: () => false,
      querySelectorAll: selector => selector === 'iframe' ? [nested] : [],
    });
    assert.equal('iframeAutoResize' in nested.dataset, false);
  },
});

tests.push({
  name: 'iframe height trace contains sizing evidence without rendered text',
  fn: () => {
    const event = buildIframeHeightTraceEvent({
      id: 'iframe-1',
      sessionId: 'session-1',
      messageId: 'message-1',
      seq: 8,
      source: 'observer',
      mode: 'document',
      raw: 816,
      applied: 820,
      authority: 'iframe',
      lock: false,
      event: 'apply',
    });
    assert.equal(event.category, 'rich-render');
    assert.equal(event.phase, 'iframe-height-apply');
    assert.equal(event.sessionId, 'session-1');
    assert.equal(event.messageId, 'message-1');
    assert.deepEqual(event.details, {
      iframeId: 'iframe-1',
      sequence: 8,
      source: 'observer',
      mode: 'document',
      rawHeight: 816,
      appliedHeight: 820,
      authority: 'iframe',
      locked: false,
    });
    assert.equal(JSON.stringify(event).includes('rendered text'), false);
  },
});

tests.push({
  name: 'drops only unsequenced legacy document-height echoes',
  fn: () => {
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'document',
      hasIncomingSeq: false,
      rawHeight: 274,
      currentHeight: 274,
      lastAppliedHeight: 274,
    }), true);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'document',
      hasIncomingSeq: false,
      rawHeight: 274.8,
      currentHeight: 274,
      lastAppliedHeight: 274,
    }), true);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'document',
      hasIncomingSeq: false,
      rawHeight: 120,
      currentHeight: 120,
      lastAppliedHeight: 0,
    }), false);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'document',
      hasIncomingSeq: false,
      rawHeight: 350,
      currentHeight: 274,
      lastAppliedHeight: 274,
    }), false);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'document',
      hasIncomingSeq: true,
      rawHeight: 274,
      currentHeight: 274,
      lastAppliedHeight: 274,
    }), false);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'observer',
      mode: 'document',
      hasIncomingSeq: false,
      rawHeight: 274,
      currentHeight: 274,
      lastAppliedHeight: 274,
    }), false);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'viewport',
      hasIncomingSeq: false,
      rawHeight: 274,
      currentHeight: 274,
      lastAppliedHeight: 274,
    }), false);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'document',
      hasIncomingSeq: false,
      rawHeight: 274,
      currentHeight: 274,
      lastAppliedHeight: 274,
      lock: true,
    }), false);
    assert.equal(shouldDropLegacyIframeHeightEcho({
      source: 'legacy',
      mode: 'document',
      hasIncomingSeq: false,
      rawHeight: 274,
      currentHeight: 274,
      lastAppliedHeight: 274,
      unlock: true,
    }), false);
  },
});

tests.push({
  name: 'lodash fallback supports the card entries-sort-map-join chain',
  fn: () => {
    const shim = buildDollarGlobalShim({
      iframeId: 'lodash-chain-test',
      appOrigin: '',
    });
    const inlineScript = shim.match(/<script>\s*([\s\S]*?)<\/script>\s*$/)?.[1] || '';
    assert.ok(inlineScript, 'fallback shim must contain an inline script');
    const windowRef = { postMessage() {} };
    windowRef.parent = windowRef;
    windowRef.top = windowRef;
    vm.runInNewContext(inlineScript, {
      window: windowRef,
      parent: windowRef,
      document: {
        head: null,
        documentElement: null,
        body: null,
        readyState: 'complete',
      },
      console,
      setTimeout,
      clearTimeout,
      structuredClone,
    });
    assert.equal(
      windowRef._({ type: 'message', message_id: -1 })
        .entries()
        .sortBy(([key]) => key)
        .map(([, value]) => value)
        .join('.'),
      '-1.message',
    );
    assert.deepEqual(
      Array.from(windowRef._.entries({ first: 1, second: 2 }), pair => Array.from(pair)),
      [['first', 1], ['second', 2]],
    );
    assert.equal(
      windowRef._.isEqual(
        { nested: { value: 1 }, list: ['a', { enabled: true }] },
        { nested: { value: 1 }, list: ['a', { enabled: true }] },
      ),
      true,
    );
    assert.equal(windowRef._.isEqual({ value: 1 }, { value: 2 }), false);
  },
});

tests.push({
  name: 'mini jquery fallback supports namespaced delegated on/off plus data and val',
  fn: () => {
    const shim = buildDollarGlobalShim({
      iframeId: 'jquery-events-test',
      appOrigin: '',
    });
    const inlineScript = shim.match(/<script>\s*([\s\S]*?)<\/script>\s*$/)?.[1] || '';
    class FakeElement {
      constructor({ selectors = [], dataset = {}, value = '' } = {}) {
        this.selectors = new Set(selectors);
        this.dataset = { ...dataset };
        this.value = value;
        this.parent = null;
        this.listeners = new Map();
      }

      addEventListener(type, listener) {
        const list = this.listeners.get(type) || [];
        list.push(listener);
        this.listeners.set(type, list);
      }

      removeEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== listener));
      }

      closest(selector) {
        let current = this;
        while (current) {
          if (current.selectors?.has(selector)) return current;
          current = current.parent;
        }
        return null;
      }

      contains(candidate) {
        let current = candidate;
        while (current) {
          if (current === this) return true;
          current = current.parent;
        }
        return false;
      }

      dispatch(type, target = this) {
        const event = { type, target };
        (this.listeners.get(type) || []).slice().forEach(listener => listener.call(this, event));
      }

      getAttribute(name) {
        if (!String(name).startsWith('data-')) return null;
        const key = String(name).slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        return Object.prototype.hasOwnProperty.call(this.dataset, key) ? this.dataset[key] : null;
      }
    }
    const documentRef = {
      head: null,
      documentElement: null,
      body: null,
      readyState: 'complete',
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const windowRef = { postMessage() {} };
    windowRef.parent = windowRef;
    windowRef.top = windowRef;
    vm.runInNewContext(inlineScript, {
      window: windowRef,
      parent: windowRef,
      document: documentRef,
      Element: FakeElement,
      Node: FakeElement,
      console,
      setTimeout,
      clearTimeout,
      structuredClone,
    });

    const root = new FakeElement();
    const tab = new FakeElement({ selectors: ['.tab'], dataset: { char: 'alice' } });
    tab.parent = root;
    const select = new FakeElement({ value: 'story' });
    let firstCalls = 0;
    let secondCalls = 0;
    windowRef.$(root).on('click.card', '.tab', function handler() {
      firstCalls += 1;
      assert.equal(this, tab);
    });
    root.dispatch('click', tab);
    windowRef.$(root)
      .off('click.card')
      .on('click.card', '.tab', () => { secondCalls += 1; });
    root.dispatch('click', tab);

    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 1);
    assert.equal(windowRef.$(tab).data('char'), 'alice');
    assert.equal(windowRef.$(select).val(), 'story');
    const wrappedSelect = windowRef.$(select);
    assert.equal(wrappedSelect.val('sandbox'), wrappedSelect);
    assert.equal(select.value, 'sandbox');
  },
});

tests.push({
  name: 'shim compat-miss probes report unknown $ and _ APIs once via structured messages',
  fn: () => {
    const shim = buildDollarGlobalShim({
      iframeId: 'compat-miss-test',
      debugTag: 'miss-tag',
      appOrigin: '',
    });
    const inlineScript = shim.match(/<script>\s*([\s\S]*?)<\/script>\s*$/)?.[1] || '';
    const posts = [];
    const windowRef = { postMessage: (msg) => posts.push(msg) };
    windowRef.parent = windowRef;
    windowRef.top = windowRef;
    class FakeShimElement {}
    vm.runInNewContext(inlineScript, {
      window: windowRef,
      parent: windowRef,
      document: {
        head: null,
        documentElement: null,
        body: null,
        readyState: 'complete',
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      Element: FakeShimElement,
      Node: FakeShimElement,
      console,
      setTimeout,
      clearTimeout,
      structuredClone,
    });
    assert.equal(typeof windowRef.__chatappWithCompatMissProbe, 'function');

    windowRef._.get({ a: 1 }, 'a');
    windowRef._([1, 2]).entries().value();
    void windowRef.$('.missing').text();

    void windowRef.$.ajax;
    void windowRef.$.ajax;
    void windowRef.$('.missing').animate;
    void windowRef._.camelCase;
    void windowRef._([1]).groupBy;
    void windowRef._([1, 2]).filter(() => true).uniq;

    const misses = posts.filter(post => post?.type === 'chatapp:compat-miss');
    assert.deepEqual(misses.map(item => item.api), [
      '$.ajax',
      '$().animate',
      '_.camelCase',
      '_().groupBy',
      '_().uniq',
    ], 'known APIs stay silent; unknown APIs report exactly once, including chained links');
    misses.forEach((item) => {
      assert.equal(item.id, 'compat-miss-test');
      assert.equal(Object.prototype.hasOwnProperty.call(item, 'tag'), false);
    });
  },
});

tests.push({
  name: 'host bridge aggregates compat-miss reports and mvu bridge minis reuse the probe',
  fn: () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/scripts/ui/chat/rich-text-renderer.js'), 'utf8');
    assert.match(source, /data\.type === 'chatapp:compat-miss'/);
    assert.match(source, /resolveCompatGapMessage\(\{/);
    assert.match(source, /getCompatGapReportStore\(\)\.record\(resolved\.report\)/);
    assert.doesNotMatch(source, /reportedCompatMisses/);
    assert.match(source, /window\.__chatappWithCompatMissProbe = withCompatMissProbe/);
    const bridgeProbeUses = source.match(/window\.\$ = probeWrap\(mini, '\$\.'\);/g) || [];
    assert.equal(bridgeProbeUses.length, 2, 'both mvu bridge minis must reuse the compat-miss probe');
    assert.match(
      source,
      /!window\.\$\.__chatappMini && window\.\$\.fn && window\.\$\.fn\.jquery/,
      'bridge jQuery detection must short-circuit before touching .fn on a probed mini',
    );
  },
});

tests.push({
  name: 'framework shim defines Vue production flags before Pinia',
  fn: () => {
    const html = buildFrameworkGlobalShim({
      iframeId: 'framework-order-test',
      vueMajor: 3,
      appOrigin: 'http://127.0.0.1:1430',
    });
    const vueAt = html.indexOf('data-chatapp-framework="vue"');
    const demiAt = html.indexOf('data-chatapp-framework="vue-demi"');
    const routerAt = html.indexOf('data-chatapp-framework="vue-router"');
    const piniaAt = html.indexOf('data-chatapp-framework="pinia"');
    const readyAt = html.indexOf('data-chatapp-framework="ready"');
    const prodDevtoolsFlagAt = html.indexOf('globalThis.__VUE_PROD_DEVTOOLS__ = false');
    assert.ok(prodDevtoolsFlagAt > 0);
    assert.ok(prodDevtoolsFlagAt < piniaAt);
    assert.ok(vueAt > 0);
    assert.ok(vueAt < demiAt);
    assert.ok(demiAt < routerAt);
    assert.ok(routerAt < piniaAt);
    assert.ok(piniaAt < readyAt);
    assert.match(html, /window\.__chatappFrameworkCompat\?\.setupVueDemi/);
    assert.match(html, /window\.__chatappFrameworkReady/);
  },
});

tests.push({
  name: 'Vue 2 framework shim does not inject Pinia',
  fn: () => {
    const html = buildFrameworkGlobalShim({
      iframeId: 'framework-vue2-test',
      vueMajor: 2,
      appOrigin: 'http://127.0.0.1:1430',
    });
    assert.match(html, /data-chatapp-framework="vue"/);
    assert.match(html, /data-chatapp-framework="vue-demi"/);
    assert.doesNotMatch(html, /data-chatapp-framework="pinia"/);
  },
});

tests.push({
  name: 'enhanced MVU bridge keeps generated regexes valid and exposes seeded variables',
  fn: async () => {
    const html = buildMvuCompatBridge({
      iframeId: 'mvu-bridge-test',
      sessionId: 'rp:test',
      messageId: 'message-1',
      messageIndex: 0,
      seedVars: {
        stat_data: { '秦素霜.倾心值': 0, 秦素霜: { 倾心值: 0 } },
        variables: { '秦素霜.倾心值': 0, 秦素霜: { 倾心值: 0 } },
        global_variables: {},
        local_variables: {},
      },
    });
    const match = html.match(/^\s*<script>([\s\S]*)<\/script>\s*$/);
    assert.ok(match, 'expected one generated script');
    const script = match[1];
    assert.doesNotThrow(() => new Function(script));
    assert.match(script, /\^https\?:\\\/\\\//);
    assert.match(script, /\(\\S\+\)\\s\+/);

    const fakeWindow = {
      location: { href: 'http://127.0.0.1:1430/' },
      addEventListener: () => {},
      eval: () => {},
    };
    fakeWindow.parent = fakeWindow;
    fakeWindow.top = fakeWindow;
    const fakeDocument = {
      readyState: 'loading',
      addEventListener: () => {},
      querySelectorAll: () => [],
    };
    class FakeElement {}
    class FakeNode {}
    class FakeDomParser {}
    class FakeFormData {}
    const run = new Function(
      'window',
      'document',
      'parent',
      'Element',
      'Node',
      'DOMParser',
      'FormData',
      'fetch',
      'setTimeout',
      'structuredClone',
      'console',
      script,
    );
    run(
      fakeWindow,
      fakeDocument,
      fakeWindow,
      FakeElement,
      FakeNode,
      FakeDomParser,
      FakeFormData,
      async () => ({ ok: false }),
      () => 0,
      globalThis.structuredClone,
      { log: () => {}, warn: () => {}, error: () => {} },
    );
    assert.deepEqual(fakeWindow.getVariables(), {
      '秦素霜.倾心值': 0,
      秦素霜: { 倾心值: 0 },
    });
    assert.deepEqual(
      fakeWindow.getVariables({ type: 'message', message_id: -1 }).stat_data,
      {
        '秦素霜.倾心值': 0,
        秦素霜: { 倾心值: 0 },
      },
    );
    assert.equal(fakeWindow.getAllVariables().stat_data['秦素霜.倾心值'], 0);
    assert.equal(fakeWindow.getChatMessages(0)[0].data.stat_data['秦素霜.倾心值'], 0);

    await fakeWindow.Mvu.replaceMvuData({
      stat_data: { '秦素霜.倾心值': 2, 秦素霜: { 倾心值: 2 } },
    });
    assert.equal(fakeWindow.getChatMessages(0)[0].data.stat_data['秦素霜.倾心值'], 2);
  },
});

tests.push({
  name: 'splitFencedCodeBlocks keeps inline backticks inside a single fenced block',
  fn: () => {
    // 重前端面板场景：块内 JS 含行内 ```（正则/字符串字面量），不得截断
    const inner = [
      '<!DOCTYPE html>',
      '<script>',
      "const m = raw.match(/```html([\\s\\S]*?)```/);",
      "const stored = '```html\\n' + finalHtml + '\\n```';",
      '</script>',
      '</html>',
    ].join('\n');
    const text = '```html\n' + inner + '\n```';
    const parts = splitFencedCodeBlocks(text);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'code');
    assert.equal(parts[0].lang, 'html');
    assert.ok(parts[0].code.includes('match(/```html'));
    assert.ok(parts[0].code.endsWith('</html>'));
  },
});

tests.push({
  name: 'splitFencedCodeBlocks splits normal blocks and keeps surrounding text',
  fn: () => {
    const text = 'before\n```js\nconst a = 1;\n```\nmiddle\n```\nplain\n```\nafter';
    const parts = splitFencedCodeBlocks(text);
    assert.deepEqual(parts.map(p => p.type), ['text', 'code', 'text', 'code', 'text']);
    assert.equal(parts[1].lang, 'js');
    assert.equal(parts[1].code, 'const a = 1;');
    assert.equal(parts[3].code, 'plain');
    assert.ok(parts[4].text.includes('after'));
  },
});

tests.push({
  name: 'splitFencedCodeBlocks repairs adjacent card html fences joined by a separator',
  fn: () => {
    // 真实社区卡形态：两条 display regex 依次追加完整 HTML，前一条闭围栏与
    // 后一条 `====` 无换行粘连。不得把第二份文档吞进第一份代码块。
    const welcome = [
      '====',
      '```html',
      '<!doctype html>',
      '<html><body><main id="welcome">welcome</main></body></html>',
      '```',
    ].join('\n');
    const status = [
      '====',
      '```html',
      '<!doctype html>',
      '<html><body><aside id="status">status</aside></body></html>',
      '```',
    ].join('\n');
    const parts = splitFencedCodeBlocks(welcome + status);
    const codeParts = parts.filter(part => part.type === 'code');
    assert.equal(codeParts.length, 2);
    assert.deepEqual(parts.map(part => part.type), ['code', 'code']);
    assert.ok(codeParts[0].code.includes('id="welcome"'));
    assert.ok(codeParts[1].code.includes('id="status"'));
    assert.equal(codeParts[0].code.includes('```html'), false);
  },
});

tests.push({
  name: 'splitFencedCodeBlocks extends unclosed fence to end (streaming)',
  fn: () => {
    const text = 'intro\n```html\n<div>partial';
    const parts = splitFencedCodeBlocks(text);
    assert.equal(parts.length, 2);
    assert.equal(parts[1].type, 'code');
    assert.equal(parts[1].code, '<div>partial');
  },
});

tests.push({
  name: 'display-regex HTML closing fence joined to a prose wrapper keeps paragraphs outside both cards',
  fn: () => {
    // Regex replacements can end at the fence, immediately followed by the
    // model's prose wrapper. Both unlabeled fences and HTML fences are used.
    for (const lang of ['', 'html']) {
      const card = `\`\`\`${lang}\n<!doctype html><html><body><details><summary>Card</summary>Notes</details></body></html>\n\`\`\``;
      const prose = '<game>\nParagraph one\n\nParagraph two\n\nParagraph three\n</game>\n<details><summary>Summary</summary>Text</details>\n';
      const text = card + prose + card;
      for (const streaming of [false, true]) {
        const plan = buildRichTextRenderPlan(text, { streaming });
        assert.deepEqual(plan.parts.map(p => p.type), ['code', 'text', 'code']);
        assert.equal(plan.parts[1].text, prose);
        assert.ok(plan.parts.filter(p => p.type === 'code').every(p => !p.code.includes('Paragraph')));
      }
    }
  },
});

tests.push({
  name: 'joined HTML fence recovery leaves script literals and incomplete documents intact',
  fn: () => {
    const code = '<!doctype html><html><body>\n<script>\nconst sample = `\n</body></html>\n```<game>\nnot a boundary\n`;\n</script>\n</body></html>';
    const text = '```html\n' + code + '\n```';
    assert.deepEqual(splitFencedCodeBlocks(text), [{ type:'code', lang:'html', code }]);
    for (const [lang, inner] of [['html', '<html><body>partial'], ['js', '<html><body>example</body></html>']]) {
      const incomplete = inner + '\n```<game>\ntrailing literal';
      assert.deepEqual(splitFencedCodeBlocks('```' + lang + '\n' + incomplete), [{ type:'code', lang, code:incomplete }]);
    }
  },
});

tests.push({
  name: 'splitFencedCodeBlocks ignores non-line-start fence markers',
  fn: () => {
    const text = 'inline ```notafence``` text without real blocks';
    const parts = splitFencedCodeBlocks(text);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'text');
  },
});

tests.push({
  name: 'plain creative prose stays on the text path with original line breaks',
  fn: () => {
    const text = '第一段正文\n\n第二段正文\n第三行';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, false);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, false);
    assert.deepEqual(plan.parts, [{ type: 'text', text }]);
  },
});

tests.push({
  name: 'raw or escaped body mentioned inside prose stays literal text',
  fn: () => {
    const samples = [
      '正文说明：示例是 <body>hello</body>，不要执行。',
      '正文说明：示例是 &lt;body&gt;hello&lt;/body&gt;，不要执行。',
    ];
    samples.forEach((text) => {
      const plan = buildRichTextRenderPlan(text);
      assert.equal(plan.wholeLooksLikeHtml, false);
      assert.equal(plan.hasEscapedHtmlDocumentWrapper, false);
      assert.deepEqual(plan.parts, [{ type: 'text', text }]);
    });
  },
});

tests.push({
  name: 'splits prose from a complete escaped HTML document pre-code wrapper',
  fn: () => {
    const prose = '第一段正文\n\n第二段正文\n\n';
    const wrapped = [
      '<pre><code>&lt;body&gt;',
      '&lt;style&gt;body{color:red}&lt;/style&gt;',
      '&lt;div id=&quot;status&quot;&gt;状态栏&lt;/div&gt;',
      '&lt;script&gt;window.ready=true;&lt;/script&gt;',
      '&lt;/body&gt;</code></pre>',
    ].join('\n');
    const plan = buildRichTextRenderPlan(`${prose}${wrapped}`);
    assert.equal(plan.wholeLooksLikeHtml, false);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['text', 'code']);
    assert.equal(plan.parts[0].text, prose);
    assert.match(plan.parts[1].code, /^<body>/);
    assert.match(plan.parts[1].code, /<script>window\.ready=true;<\/script>/);
    assert.doesNotMatch(plan.parts[1].code, /<pre|<code/i);
  },
});

tests.push({
  name: 'expands markdown fences in prose around an escaped document wrapper',
  fn: () => {
    const prose1 = '先看这段代码：\n';
    const fence = '```js\nconsole.log(1);\n```';
    const prose2 = '\n然后是正文结尾。\n';
    const wrapped = '<pre><code>&lt;body&gt;&lt;div&gt;状态&lt;/div&gt;&lt;script&gt;window.ready=true;&lt;/script&gt;&lt;/body&gt;</code></pre>';
    const plan = buildRichTextRenderPlan(`${prose1}${fence}${prose2}${wrapped}`);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['text', 'code', 'text', 'code']);
    assert.equal(plan.parts[0].text, prose1);
    assert.equal(plan.parts[1].lang, 'js');
    assert.equal(plan.parts[1].code, 'console.log(1);');
    assert.equal(plan.parts[2].text, prose2);
    assert.equal(plan.parts[3].lang, 'html');
    assert.match(plan.parts[3].code, /^<body>/);
  },
});

tests.push({
  name: 'expands a fence after the wrapper and keeps part order',
  fn: () => {
    const wrapped = '<pre><code>&lt;body&gt;&lt;div&gt;状态&lt;/div&gt;&lt;/body&gt;</code></pre>';
    const tail = '\n补充示例：\n```html\n<span>demo</span>\n```\n完。';
    const plan = buildRichTextRenderPlan(`正文开头\n${wrapped}${tail}`);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['text', 'code', 'text', 'code', 'text']);
    assert.equal(plan.parts[1].lang, 'html');
    assert.match(plan.parts[1].code, /^<body>/);
    assert.equal(plan.parts[3].lang, 'html');
    assert.equal(plan.parts[3].code, '<span>demo</span>');
    assert.equal(plan.parts[4].text, '\n完。');
  },
});

tests.push({
  name: 'normalizes br tags to newlines in wrapper-path prose but not in code parts',
  fn: () => {
    const prose = '第一行<br>第二行&lt;br/&gt;第三行\n';
    const wrapped = '<pre><code>&lt;body&gt;&lt;div&gt;a&lt;br&gt;b&lt;/div&gt;&lt;/body&gt;</code></pre>';
    const plan = buildRichTextRenderPlan(`${prose}${wrapped}`);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, true);
    assert.equal(plan.parts[0].text, '第一行\n第二行\n第三行\n');
    assert.match(plan.parts[1].code, /<br>/i);
  },
});

tests.push({
  name: 'incomplete escaped HTML pre-code wrapper fails closed as text',
  fn: () => {
    const text = '正文\n<pre><code>&lt;body&gt;&lt;div&gt;状态&lt;/div&gt;&lt;/body&gt;</code>';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, false);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, false);
    assert.deepEqual(plan.parts, [{ type: 'text', text }]);
  },
});

tests.push({
  name: 'head-first full page routes to the whole-page sandbox',
  fn: () => {
    const text = [
      '<head>',
      '  <meta charset="utf-8">',
      '  <title>状态栏</title>',
      '  <style>body{margin:0}</style>',
      '  <script>window.boot=1;</script>',
      '</head>',
      '<body><div id="app">页面</div></body>',
    ].join('\n');
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.equal(plan.parts.length, 1);
    assert.equal(plan.parts[0].type, 'code');
    assert.equal(plan.parts[0].lang, 'html');
  },
});

tests.push({
  name: 'non-streaming full page keeps trailing prose outside the sandbox',
  fn: () => {
    const text = '<body><details><summary>思维链</summary><p>隐藏内容</p></details></body>\n正文可选';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code', 'text']);
    assert.match(plan.parts[0].code, /<\/body>$/);
    assert.equal(plan.parts[1].text, '\n正文可选');
  },
});

tests.push({
  name: 'complete fenced HTML keeps following prose outside while fragments preserve legacy coalescing',
  fn: () => {
    const documentParts = [
      { type: 'code', lang: 'html', code: '<body><details>折叠栏</details></body>' },
      { type: 'text', text: '\n正文可选' },
    ];
    assert.deepEqual(coalesceFencedHtmlTailParts(documentParts), documentParts);

    const fragmentParts = [
      { type: 'code', lang: 'html', code: '<details>折叠栏</details>' },
      { type: 'text', text: '\n同卡尾注' },
    ];
    const merged = coalesceFencedHtmlTailParts(fragmentParts);
    assert.deepEqual(merged.map(part => part.type), ['code']);
    assert.match(merged[0].code, /__chatapp-tail-text/);
    assert.match(merged[0].code, /同卡尾注/);
  },
});

tests.push({
  name: 'prose that starts with a head tag stays text',
  fn: () => {
    const text = '<head>是他的口头禅。他随手写下 <body>hello</body> 当作示例。';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, false);
    assert.deepEqual(plan.parts.map(part => part.type), ['text']);
  },
});

tests.push({
  name: 'malformed head with bare prose inside fails closed as text',
  fn: () => {
    const text = '<head>这里是裸文本<meta charset="utf-8"></head>\n<body>页面</body>';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, false);
    assert.deepEqual(plan.parts.map(part => part.type), ['text']);
  },
});

tests.push({
  name: 'leading HTML comments do not block the whole-page route',
  fn: () => {
    const text = '<!-- theme: dark -->\n<!-- v2 -->\n<body><script>window.ready=1;</script>页面</body>';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.equal(plan.parts.length, 1);
    assert.equal(plan.parts[0].type, 'code');
  },
});

tests.push({
  name: 'escaped head-first page inside a pre-code wrapper splits from prose',
  fn: () => {
    const prose = '正文段落\n\n';
    const wrapped = [
      '<pre><code>&lt;head&gt;&lt;style&gt;#s{color:red}&lt;/style&gt;&lt;/head&gt;',
      '&lt;body&gt;&lt;div id=&quot;s&quot;&gt;状态&lt;/div&gt;&lt;/body&gt;</code></pre>',
    ].join('\n');
    const plan = buildRichTextRenderPlan(`${prose}${wrapped}`);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['text', 'code']);
    assert.equal(plan.parts[0].text, prose);
    assert.match(plan.parts[1].code, /^<head>/);
    assert.match(plan.parts[1].code, /<\/body>$/);
  },
});

tests.push({
  name: 'head validator tolerates > inside attribute values',
  fn: () => {
    const text = '<head><meta content="a > b"><title>页</title></head>\n<body>正文</body>';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
  },
});

tests.push({
  name: 'head validator skips a "</head>" literal inside script content',
  fn: () => {
    const text = '<head><script>const s = "</head>";window.a=1;</script></head>\n<body>正文</body>';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
  },
});

tests.push({
  name: 'template counts as a legal head metadata element',
  fn: () => {
    const text = '<head><template><div>tpl</div></template><style>i{}</style></head>\n<body>正文</body>';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
  },
});

tests.push({
  name: 'head validator accepts nested template metadata content',
  fn: () => {
    const text = '<head><template><template><span>nested</span></template></template></head>\n<body>正文</body>';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
  },
});

tests.push({
  name: 'escaped doctype+head document without html tag is a complete shell',
  fn: () => {
    const prose = '正文\n\n';
    const wrapped = '<pre><code>&lt;!doctype html&gt;&lt;head&gt;&lt;title&gt;s&lt;/title&gt;&lt;/head&gt;&lt;body&gt;页&lt;/body&gt;</code></pre>';
    const plan = buildRichTextRenderPlan(`${prose}${wrapped}`);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['text', 'code']);
    assert.match(plan.parts[1].code, /^<!doctype html>/i);
  },
});

tests.push({
  name: 'streaming keeps a head-first page intact in one sandbox part',
  fn: () => {
    const text = [
      '<head><title>状态</title><style>#a{}</style></head>',
      '<body><div id="a">页面</div><script>window.x=1;</script></body>',
    ].join('\n');
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.match(plan.parts[0].code, /^<head>/);
    assert.match(plan.parts[0].code, /<\/body>$/);
  },
});

tests.push({
  name: 'streaming keeps an unfinished head-first body out of the text path',
  fn: () => {
    const text = '<head><script>window.x=1;</script></head><body><div>partial';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.equal(plan.parts[0].code, text);
  },
});

tests.push({
  name: 'streaming script-first page with trailing body stays one sandbox part',
  fn: () => {
    const text = '<script>window.config={a:1};</' + 'script>\n<body><div id="app">页面</div></body>';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.match(plan.parts[0].code, /<\/body>$/);
  },
});

tests.push({
  name: 'streaming standalone script snippet still closes at its own end tag',
  fn: () => {
    const text = '<script>window.only=1;</' + 'script>';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.match(plan.parts[0].code, /<\/script>$/);
  },
});

tests.push({
  name: 'streaming unclosed script with a "</body>" string stays one sandbox part',
  fn: () => {
    const text = '<script>const tpl="</body>";window.x=1';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.equal(plan.parts[0].code, text);
  },
});

tests.push({
  name: 'streaming closed script with an unfinished trailing body stays one sandbox part',
  fn: () => {
    const text = '<script>window.x=1;</' + 'script><body><div>partial';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.equal(plan.parts[0].code, text);
  },
});

tests.push({
  name: 'streaming body-first page ignores a "</body>" string inside script content',
  fn: () => {
    const text = '<body><script>const tpl="</body>";window.y=2';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.equal(plan.parts[0].code, text);
  },
});

tests.push({
  name: 'streaming iframe-first page with an unfinished trailing body stays one sandbox part',
  fn: () => {
    const text = '<iframe src="https://example.com/"></iframe><body><div>partial';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code']);
    assert.equal(plan.parts[0].code, text);
  },
});

tests.push({
  name: 'streaming complete body page still ends at its real close tag',
  fn: () => {
    const text = '<body><script>const tpl="</body>";</' + 'script><div>页面</div></body>\n尾注';
    const plan = buildRichTextRenderPlan(text, { streaming: true });
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.deepEqual(plan.parts.map(part => part.type), ['code', 'text']);
    assert.match(plan.parts[0].code, /<\/body>$/);
    assert.match(plan.parts[1].text, /尾注/);
  },
});

tests.push({
  name: 'iframe srcdoc keeps head-first metadata inside the head',
  fn: () => {
    const doc = buildIframeSrcDoc(
      '<head><title>状态栏</title><base href="https://example.com/"></head>\n<body>页面正文</body>',
      { vhViewportHeight: 800 },
    );
    const headClose = doc.search(/<\/head\s*>/i);
    const bodyOpen = doc.search(/<body\b/i);
    const titleIdx = doc.indexOf('<title>状态栏</title>');
    const baseIdx = doc.indexOf('<base href="https://example.com/">');
    assert.ok(headClose >= 0 && bodyOpen >= 0, 'doc must contain head close and body open');
    assert.ok(titleIdx >= 0 && titleIdx < headClose, 'title must stay inside head');
    assert.ok(baseIdx >= 0 && baseIdx < headClose, 'base must stay inside head');
    assert.ok(headClose < bodyOpen, 'head must close before body opens');
    assert.match(doc, /页面正文/);
  },
});

tests.push({
  name: 'iframe bridges give selectable text time to enter native selection',
  fn: () => {
    const sources = [
      buildIframeBridgeScript(),
      buildIframeSrcDoc('<body><p>可选择正文</p></body>', { vhViewportHeight: 800 }),
    ];
    sources.forEach((source) => {
      assert.match(source, /const isSelectableTextTarget = \(target\) =>/);
      assert.match(source, /const pressDelay = isSelectableTextTarget\(ev\?\.target\) \? 680 : 520;/);
      assert.match(source, /if \(isSelectableTextTarget\(ev\?\.target\)\) \{[\s\S]{0,180}?return;/);
      // contextmenu 的可选文本分支不得清定时器：quirk WebView 不启动原生选择时靠定时器兜底出菜单
      const selectableBranch = source.match(/contextmenu[\s\S]{0,120}?if \(isSelectableTextTarget\(ev\?\.target\)\) \{([\s\S]{0,300}?)return;/);
      assert.ok(selectableBranch, 'contextmenu must keep a selectable-text branch');
      assert.ok(!/clearTimeout|clear\(\)/.test(selectableBranch[1]), 'selectable-text branch must not cancel the long-press timer');
    });
  },
});

tests.push({
  name: 'iframe srcdoc preserves quoted greater-than signs on the head tag',
  fn: () => {
    const doc = buildIframeSrcDoc(
      '<head data-note="a > b"><title>状态栏</title></head>\n<body>页面正文</body>',
      { injectBridgeScript: false, vhViewportHeight: 800 },
    );
    const headOpen = doc.indexOf('<head data-note="a > b">');
    const headClose = doc.search(/<\/head\s*>/i);
    const titleIdx = doc.indexOf('<title>状态栏</title>');
    assert.ok(headOpen >= 0, 'quoted head attribute must remain byte-stable');
    assert.ok(titleIdx > headOpen && titleIdx < headClose, 'title must remain inside the attributed head');
  },
});

tests.push({
  name: 'iframe srcdoc does not duplicate an existing viewport meta',
  fn: () => {
    const viewport = '<meta name="viewport" content="width=320,initial-scale=2">';
    const doc = buildIframeSrcDoc(
      `<head>${viewport}<title>状态栏</title></head>\n<body>页面正文</body>`,
      { injectBridgeScript: false, vhViewportHeight: 800 },
    );
    assert.equal((doc.match(/<meta\b[^>]*\bname=["']viewport["'][^>]*>/gi) || []).length, 1);
    assert.match(doc, /content="width=320,initial-scale=2"/i);
  },
});

tests.push({
  name: 'standalone escaped HTML document keeps existing sandbox route',
  fn: () => {
    const text = '&lt;body&gt;&lt;script&gt;window.ready=true;&lt;/script&gt;&lt;/body&gt;';
    const plan = buildRichTextRenderPlan(text);
    assert.equal(plan.wholeLooksLikeHtml, true);
    assert.equal(plan.hasEscapedHtmlDocumentWrapper, false);
    assert.deepEqual(plan.parts, [{
      type: 'code',
      lang: 'html',
      code: '<body><script>window.ready=true;</script></body>',
    }]);
  },
});

const test = (name, fn) => tests.push({ name, fn });

test('keeps iframe diagnostic regex escapes inside generated srcdoc script', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/scripts/ui/chat/rich-text-renderer.js'), 'utf8');
  assert.ok(source.includes("replace(/\\\\s+/g, ' ').trim()"));
  assert.ok(source.includes('const contentHasBr = /<br\\\\s*\\\\/?>/i.test(contentHtml) ? 1 : 0;'));
  assert.ok(source.includes("match(/\\\\[旁白\\\\]\\\\|/g)"));
  assert.match(source, /else if \(!directBodyLoadUrl\) \{\s*\/\/ direct-load/);
  assert.equal((source.match(/const nodes = Array\.from\(body\.children \|\| \[\]\);/g) || []).length, 2);
  assert.doesNotMatch(source, /const nodes = body\.querySelectorAll\('\*'\);/);
  assert.ok(source.includes("hasOwnProperty.call(item, 'swipe_id')"));
  assert.ok(source.includes('fields.swipe_id = item.swipe_id'));
  assert.match(source, /\*, \*::before, \*::after \{ box-sizing: border-box; min-width: 0 !important; \}/);
  assert.doesNotMatch(source, /\*, \*::before, \*::after \{[^}]*max-width/i);
});

test('runtime toggle skips the doomed iframe broadcast for the active session', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/scripts/ui/chat/rich-text-renderer.js'), 'utf8');
  const start = source.indexOf("window.addEventListener('chatapp-variable-runtime-changed'");
  const body = source.slice(start, source.indexOf('\n    });', start) + 8);
  assert.match(body, /getActiveSessionId/);
  assert.match(body, /sid\s*&&\s*sid\s*!==\s*activeSid/);
  assert.doesNotMatch(body, /if \(sid\) broadcastMvuVars\(sid\)/);
});

test('maps Tavern swipe_id to RP alternate greetings without card-specific rules', () => {
  const greetingState = {
    greetings: [
      { id: 'greeting_1', title: '开场白' },
      { id: 'greeting_2', title: '开场白 2' },
    ],
    activeId: 'greeting_1',
    locked: false,
  };
  assert.deepEqual(resolveCompatRpGreetingSwipeTarget({
    sessionId: 'rp:persona_test',
    message: { meta: { isGreeting: true } },
    swipeId: 1,
    greetingState,
  }), {
    ok: true,
    greetingId: 'greeting_2',
    swipeId: 1,
    swipeCount: 2,
    unchanged: false,
  });
  assert.equal(resolveCompatRpGreetingSwipeTarget({
    sessionId: 'rp:persona_test',
    message: { meta: { isGreeting: true } },
    swipeId: 2,
    greetingState,
  }).reason, 'swipe-out-of-range');
  assert.equal(resolveCompatRpGreetingSwipeTarget({
    sessionId: 'normal-chat',
    message: { meta: { isGreeting: true } },
    swipeId: 1,
    greetingState,
  }).reason, 'unsupported-swipe-target');
  assert.equal(resolveCompatRpGreetingSwipeTarget({
    sessionId: 'rp:persona_test',
    message: { meta: { isGreeting: true } },
    swipeId: 1,
    greetingState: { ...greetingState, locked: true },
  }).reason, 'greeting-locked');
});

test('keeps balanced style scaffolds intact', () => {
  const input = '<style>.pf-wrap{display:block}</style><details><summary>cot</summary><div>body</div></details>';
  assert.equal(prepareRichFragmentHtmlForParsing(input), input);
});

test('escapes literal unclosed style mentions inside rich fragments', () => {
  const input = [
    '<style>.pf-wrap{display:block}</style>',
    '<details class="pf-wrap"><summary>cot</summary><div>',
    '同时根据<style>中的Baseline_Anchors，保持中景镜头。',
    '</div></details>',
    '<p>正文仍应显示</p>',
  ].join('');
  const output = prepareRichFragmentHtmlForParsing(input);
  assert.match(output, /^<style>\.pf-wrap/);
  assert.match(output, /根据&lt;style&gt;中的Baseline_Anchors/);
  assert.match(output, /<p>正文仍应显示<\/p>/);
});

test('escapes unsupported protocol tags as text in rich fragments', () => {
  const input = '<details><summary>cot</summary><div>正文用<content></content>包裹，末尾有<ztl>状态</ztl></div></details>';
  const output = prepareRichFragmentHtmlForParsing(input);
  assert.match(output, /正文用&lt;content&gt;&lt;\/content&gt;包裹/);
  assert.match(output, /末尾有&lt;ztl&gt;状态&lt;\/ztl&gt;/);
});

test('hides creative content wrapper before rich fragment display parsing', () => {
  const input = '<content><details><summary>cot</summary><div>正文</div></details></content>';
  const output = prepareRichFragmentDisplayHtmlForParsing(input);
  assert.equal(output, '<details><summary>cot</summary><div>正文</div></details>');
});

test('hides escaped creative content wrapper before display fallback', () => {
  const input = '&lt;content type=&quot;story&quot;&gt;正文&lt;/content&gt;';
  const output = prepareRichFragmentDisplayHtmlForParsing(input);
  assert.equal(output, '正文');
});

test('unwraps residual XML tags only in the final display copy', () => {
  const input = '<output mode="story"><ztl>状态正常</ztl><正文>继续前进</正文></output>';
  assert.equal(stripResidualXmlTagsForDisplay(input), '状态正常继续前进');
  assert.equal(prepareRichFragmentDisplayHtmlForParsing(input), '状态正常继续前进');
});

test('keeps supported HTML while unwrapping nested residual XML tags', () => {
  const input = '<details><summary>状态</summary><ztl level="1"><strong>正常</strong></ztl></details>';
  assert.equal(
    stripResidualXmlTagsForDisplay(input),
    '<details><summary>状态</summary><strong>正常</strong></details>',
  );
});

test('keeps escaped and inline-code XML examples visible', () => {
  const input = '字面量 &lt;ztl&gt;状态&lt;/ztl&gt;，代码 `<ztl>状态</ztl>`，协议 <ztl>状态</ztl>';
  assert.equal(
    stripResidualXmlTagsForDisplay(input),
    '字面量 &lt;ztl&gt;状态&lt;/ztl&gt;，代码 `<ztl>状态</ztl>`，协议 状态',
  );
});

test('keeps unpaired angle-bracket prose without closing evidence', () => {
  assert.equal(
    stripResidualXmlTagsForDisplay('他使出<全力一击>击退敌人'),
    '他使出<全力一击>击退敌人',
  );
  assert.equal(
    stripResidualXmlTagsForDisplay('若 a<x && y>b 则成立'),
    '若 a<x && y>b 则成立',
  );
});

test('strips residual tags once closing or self-closing evidence exists', () => {
  assert.equal(stripResidualXmlTagsForDisplay('残留</正文>孤立闭合'), '残留孤立闭合');
  assert.equal(stripResidualXmlTagsForDisplay('<pause/>自闭标记'), '自闭标记');
  assert.equal(
    stripResidualXmlTagsForDisplay('<全力一击>成对出现</全力一击>'),
    '成对出现',
  );
  // 代码段里的闭合不构成剥除证据
  assert.equal(
    stripResidualXmlTagsForDisplay('示例 `</ztl>` 之外的 <ztl>保持原样'),
    '示例 `</ztl>` 之外的 <ztl>保持原样',
  );
});

test('treats common formatting tags as supported instead of residual XML', () => {
  const input = '<b>粗体</b><dl><dt>词</dt><dd>释义</dd></dl><ruby>漢<rt>かん</rt></ruby><figure><figcaption>图注</figcaption></figure><q>引文</q><wbr>';
  assert.equal(stripResidualXmlTagsForDisplay(input), input);
});

test('expands generated image tokens in sandbox html text nodes', () => {
  const imagePath = String.raw`C:\tmp\generated.png`;
  const scriptPath = String.raw`C:\tmp\script-only.png`;
  const input = `<body><section>正文 [img-${imagePath}]</section><script>const token="[img-${scriptPath}]"</script></body>`;
  const output = expandRichImageTokensForHtml(input);
  assert.match(output, /<img\b/);
  assert.match(output, /src="file:\/\/\/C:\/tmp\/generated\.png"/);
  assert.match(output, /data-inline-image-ref="C:\\tmp\\generated\.png"/);
  assert.match(output, /<script>const token="\[img-C:\\tmp\\script-only\.png\]"<\/script>/);
});

test('does not let a stray raw-text tag claim a later valid block', () => {
  const input = '说明<script>只是字面量<style>.x{color:red}</style><div>尾部</div>';
  const output = prepareRichFragmentHtmlForParsing(input);
  assert.match(output, /说明&lt;script&gt;只是字面量/);
  assert.match(output, /<style>\.x\{color:red\}<\/style>/);
  assert.match(output, /<div>尾部<\/div>/);
});

const fakeDetails = ({ summary = '', open = false, attrs = {} } = {}) => ({
  tagName: 'DETAILS',
  open,
  getAttribute: name => attrs[name] || '',
  children: [{ tagName: 'SUMMARY', textContent: summary }],
});

const fakeDetailsContainer = details => ({
  querySelectorAll: selector => (selector === 'details' ? details : []),
});

test('builds stable details state keys from explicit ids before summary text', () => {
  const details = fakeDetails({
    summary: '  推理   请求  ',
    attrs: { 'data-rich-details-key': 'reasoning-request' },
  });
  assert.equal(getRichDetailsStateKey(details, 4), 'id:reasoning-request');
  assert.equal(getRichDetailsStateKey(fakeDetails({ summary: '  推理   请求  ' }), 4), 'idx:4|summary:推理 请求');
});

test('restores user details open state across rich streaming rerenders', () => {
  const state = { openByKey: new Map() };
  captureRichDetailsOpenStates(
    fakeDetailsContainer([fakeDetails({ summary: '推理请求', open: true })]),
    state,
  );

  const rerendered = fakeDetails({ summary: '推理请求', open: false });
  restoreRichDetailsOpenStates(fakeDetailsContainer([rerendered]), state);

  assert.equal(rerendered.open, true);
});

test('plain code blocks ship a one-tap copy button for the raw payload', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/scripts/ui/chat/rich-text-renderer.js'), 'utf8');
  const plainBranch = source.indexOf("renderLevel === RICH_RENDER_LEVELS.SAFE && !(looksLikeHtmlDoc || isHtmlLang)");
  assert.ok(plainBranch >= 0, '纯代码块分支必须存在');
  const branchBody = source.slice(plainBranch, plainBranch + 3200);
  const copyIndex = branchBody.indexOf("copyBtn.className = 'chat-codeblock-copy'");
  const copySource = branchBody.indexOf('copyToClipboard(String(wrap.__chatappCode ?? code');
  const stopIndex = branchBody.indexOf('ev.stopPropagation()');
  const preIndex = branchBody.indexOf("document.createElement('pre')");
  assert.ok(copyIndex >= 0, '纯代码块必须带一键复制按钮');
  assert.ok(copySource > copyIndex, '复制内容必须来自原始代码载荷而非渲染文本');
  assert.ok(stopIndex >= 0 && stopIndex < copySource, '复制点击必须阻止冒泡，避免误触消息交互');
  assert.ok(preIndex > copyIndex, '头部按钮在代码区之前挂载');
  assert.ok(branchBody.includes("createRpMessageIconMarkup('copy'"), '复制按钮必须复用气泡操作条的同一图标源');
});

test('headless script-only html blocks are detected and never trigger blank fallback', () => {
  const konata = '<script>\n(function(){ var d = document.querySelector(".konata-thinking-details"); if (!d) { setTimeout(arguments.callee, 200); } })();\n</script>';
  assert.equal(isHeadlessScriptOnlyHtml(konata), true, '纯 script 块');
  assert.equal(isHeadlessScriptOnlyHtml('<style>.a{color:red}</style>\n<script>console.log("<div>inside string</div>")</script>'), true, 'style+script，脚本字符串里的标签不算可见内容');
  assert.equal(isHeadlessScriptOnlyHtml('<!DOCTYPE html><html><head><meta charset="utf-8"><title>t</title><script>1</script></head><body></body></html>'), true, '只有脚本的完整文档骨架');
  assert.equal(isHeadlessScriptOnlyHtml('<!-- note --><script>1</script>'), true, '注释不算内容');
  assert.equal(isHeadlessScriptOnlyHtml('<script>1</script><div class="card">内容</div>'), false, '有可见标签不是无头块');
  assert.equal(isHeadlessScriptOnlyHtml('<script>1</script>正文文字'), false, '有裸文本不是无头块');
  assert.equal(isHeadlessScriptOnlyHtml('<div>no script at all</div>'), false, '没有脚本/样式不参与判定');
  assert.equal(isHeadlessScriptOnlyHtml(''), false);

  const source = fs.readFileSync(path.join(process.cwd(), 'src/scripts/ui/chat/rich-text-renderer.js'), 'utf8');
  const gate = source.indexOf("if (iframe.dataset.richHeadless === '1') {");
  const inspect = source.indexOf('const blankState = inspectIframeBlankState(iframe);', gate);
  assert.ok(gate >= 0 && inspect > gate, '空白回退必须在探针之前对无头块短路');
  assert.ok(source.includes("const headlessScriptBlock = isHeadlessScriptOnlyHtml(code);"), '沙箱分支必须判定无头块');
  assert.ok(source.includes("wrap.dataset.richHeadless = '1';"), '无头块折叠标记');
  const probe = source.indexOf("if (headlessScriptBlock) {\n                // 无头块不回退");
  const fallbackCall = source.indexOf("applyIframeBlankFallbackIfNeeded(iframe, iframeId, 'post-load-blank-probe'", probe);
  assert.ok(probe >= 0 && fallbackCall > probe, '探针定时器里无头块必须先于回退调用返回');
  assert.ok(source.includes("wrap.dataset.richHeadless = 'revealed';"), '画出内容时要能展开');
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) {
  process.exit(1);
}
process.exit(0);
