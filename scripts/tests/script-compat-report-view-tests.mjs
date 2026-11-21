import test from 'node:test';
import assert from 'node:assert/strict';

// 脚本面板的兼容报告：摘要按钮、明细（按代码推测＋执行时实际打到）与缺口记录的对应。

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };

const {
  getScriptRuntimeGapReports,
  renderScriptCompatDetailHtml,
  renderScriptCompatToggleHtml,
} = await import('../../src/scripts/ui/script-compat-report-view.js');
const { analyzeTavernFeatures } = await import('../../src/scripts/import/tavern-feature-report.js');
const { buildTavernApiGapReport } = await import('../../src/scripts/plugins/tavern-api-router.js');
const { upsertCompatGapReport } = await import('../../src/scripts/storage/compat-gap-report-store.js');

const textOf = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const recordGaps = (entries) => {
  let state = null;
  entries.forEach(([input, now]) => { state = upsertCompatGapReport(state, input, { now }).state; });
  return state.reports;
};

test('runtime gaps are matched to the script by the same scope the router records', () => {
  const reports = recordGaps([
    [buildTavernApiGapReport({ path: '/api/characters/all', scriptId: 's1', scriptName: 'A', revision: '1:a' }), 1000],
    [buildTavernApiGapReport({ path: '/api/characters/all', scriptId: 's1', scriptName: 'A', revision: '1:a' }), 3000],
    [buildTavernApiGapReport({ path: '/api/presets/save/kobold', scriptId: 's1', scriptName: 'A', revision: '1:a' }), 2000],
    [buildTavernApiGapReport({ path: '/api/files/upload', scriptId: 's2', scriptName: 'B', revision: '1:b' }), 4000],
    // 富文本 iframe 的缺口（$ / _ 函式）不按脚本记，不算
    [{ scopeFingerprint: 'fnv1a-x', revisionFingerprint: 'r', api: '$.ajax', status: 'candidate', phase: 'shim_access' }, 5000],
  ]);
  const gaps = getScriptRuntimeGapReports(reports, 's1');
  assert.deepEqual(gaps.map(gap => [gap.api, gap.confirmedCount]), [['/api/characters/all', 2], ['/api/presets/save/kobold', 1]]);
  assert.deepEqual(getScriptRuntimeGapReports(reports, 'nobody'), []);
  assert.deepEqual(getScriptRuntimeGapReports(reports, ''), []);
});

test('toggle summary shows counts per status and runtime gaps; nothing when there is neither', () => {
  const report = analyzeTavernFeatures("fetch('/api/chats/get'); fetch('/api/settings/get'); triggerSlash('/x'); generateRaw({});");
  assert.equal(
    textOf(renderScriptCompatToggleHtml({ report, gaps: [{ api: '/api/characters/all' }] })),
    '酒馆功能 2 项支持 1 项部分支持 1 项不支持 执行时缺口 1',
  );
  assert.match(renderScriptCompatToggleHtml({ report }), /class="script-compat-count is-partial"/);
  assert.equal(renderScriptCompatToggleHtml({ report: analyzeTavernFeatures('void 0;'), gaps: [] }), '');
  assert.equal(renderScriptCompatToggleHtml({}), '');
  // 只有执行时缺口也显示
  assert.equal(textOf(renderScriptCompatToggleHtml({ report: null, gaps: [{ api: '/api/x' }] })), '酒馆功能 执行时缺口 1');
});

test('detail lists static items (worst first) with status, impact and recognised forms', () => {
  const report = analyzeTavernFeatures("fetch('/api/chats/get'); triggerSlash('/x'); fetch('/api/settings/get');");
  const html = renderScriptCompatDetailHtml({ report, gaps: [] });
  const rows = html.match(/<li class="script-compat-row">[\s\S]*?<\/li>/g);
  assert.deepEqual(rows.map(row => textOf(row).split(' ').slice(0, 2).join(' ')), [
    '不支持 triggerSlash',
    '部分支持 /api/settings/get',
    '支持 /api/chats/get',
  ]);
  assert.match(rows[0], /class="script-compat-badge is-unsupported"/);
  assert.match(rows[0], /斜杠命令/);
  assert.match(rows[1], /只回当前对话预设的设定/);
  assert.match(rows[2], /识别到：<\/span><code>&#39;\/api\/chats\/get&#39;<\/code>/);
  assert.match(html, /按代码推测/);
  assert.match(html, /执行时实际打到/);
  assert.match(html, /还没有记录/);
  assert.doesNotMatch(html, /模块方式运行/);
});

test('detail shows runtime gaps with call count and last time, and the module hint', () => {
  const content = "export const x = 1;\nfetch('/api/chats/get');";
  const report = analyzeTavernFeatures({ content, compatibility: { signals: { topLevelAwait: false } } });
  const gaps = [{ api: '/api/characters/all', confirmedCount: 3, candidateCount: 0, lastSeenAt: 1700000000000 }];
  const html = renderScriptCompatDetailHtml({ report, gaps, formatTime: value => `T${value}` });
  assert.match(html, /模块方式运行/);
  const section = html.slice(html.indexOf('执行时实际打到'));
  assert.equal(textOf(section), '执行时实际打到 不支持 /api/characters/all 调用 3 次，最后一次 T1700000000000');
  assert.match(textOf(renderScriptCompatDetailHtml({ report: { runtime: 'worker', items: [] }, gaps })), /没有认出用到的酒馆功能/);
});

test('detail escapes script-provided text', () => {
  const report = {
    runtime: 'worker',
    items: [{
      id: 'x', category: 'tavern_api', label: '/api/<b>', status: 'unsupported', impact: 'a & b', matches: ['"<img src=x>"'],
    }],
  };
  const html = renderScriptCompatDetailHtml({ report, gaps: [{ api: '/api/<i>', confirmedCount: 1, lastSeenAt: 0 }] });
  assert.doesNotMatch(html, /<b>|<img|<i>/);
  assert.match(html, /\/api\/&lt;b&gt;/);
  assert.match(html, /a &amp; b/);
  assert.match(html, /&quot;&lt;img src=x&gt;&quot;/);
  assert.match(html, /最后一次 -/);
});

// 脚本卡片上的摘要按钮与明细：用最小的假 DOM 驱动 ScriptPanel.appendCompatReport
const makeFakeElement = (tagName) => {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    tagName: String(tagName).toUpperCase(),
    children: [],
    innerHTML: '',
    hidden: false,
    title: '',
    type: '',
    classList: {
      add: name => classes.add(name),
      contains: name => classes.has(name),
      toggle: (name, force) => { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); },
    },
    set className(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); },
    get className() { return Array.from(classes).join(' '); },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
    addEventListener: (type, fn) => listeners.set(type, fn),
    click() { listeners.get('click')?.(); },
    appendChild(child) { this.children.push(child); return child; },
  };
};

test('script card: summary toggle opens and closes the detail, and remembers it across renders', async () => {
  globalThis.document = { createElement: makeFakeElement };
  const { ScriptPanel } = await import('../../src/scripts/ui/script-panel.js');
  const panel = new ScriptPanel({ compatGapStore: { getReports: async () => [] } });
  const script = { id: 's1', content: "fetch('/api/settings/get'); triggerSlash('/x');" };

  const card = makeFakeElement('div');
  const column = makeFakeElement('div');
  panel.appendCompatReport(card, column, script, []);
  const [toggle, detail] = column.children;
  assert.equal(toggle.className, 'script-panel-compat-toggle');
  assert.equal(textOf(toggle.innerHTML), '酒馆功能 1 项部分支持 1 项不支持');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(detail.hidden, true);
  assert.equal(detail.innerHTML, '');

  toggle.click();
  assert.equal(detail.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(card.classList.contains('is-compat-open'), true);
  assert.match(detail.innerHTML, /部分支持[\s\S]*\/api\/settings\/get/);

  // 重新渲染时保持展开
  const nextColumn = makeFakeElement('div');
  panel.appendCompatReport(makeFakeElement('div'), nextColumn, script, []);
  assert.equal(nextColumn.children[1].hidden, false);
  assert.match(nextColumn.children[1].innerHTML, /triggerSlash/);

  toggle.click();
  assert.equal(detail.hidden, true);
  assert.equal(card.classList.contains('is-compat-open'), false);
  assert.equal(panel.compatExpanded.has('s1'), false);

  // 没有用到酒馆功能、也没有缺口：不显示；只取结构的 MVU 脚本不分析，但执行时缺口照样显示
  const empty = makeFakeElement('div');
  panel.appendCompatReport(makeFakeElement('div'), empty, { id: 's2', content: 'console.log(1);' }, []);
  assert.equal(empty.children.length, 0);
  const schemaOnly = makeFakeElement('div');
  panel.appendCompatReport(makeFakeElement('div'), schemaOnly, { id: 's3', schemaOnly: true, content: "triggerSlash('/x');" }, []);
  assert.equal(schemaOnly.children.length, 0);
  const gaps = recordGaps([[buildTavernApiGapReport({ path: '/api/characters/all', scriptId: 's3', scriptName: 'C' }), 1000]]);
  panel.appendCompatReport(makeFakeElement('div'), schemaOnly, { id: 's3', schemaOnly: true, content: "triggerSlash('/x');" }, gaps);
  assert.equal(textOf(schemaOnly.children[0].innerHTML), '酒馆功能 执行时缺口 1');

  // 缺口记录读不到时当作没有
  assert.deepEqual(await new ScriptPanel({ compatGapStore: { getReports: async () => { throw new Error('x'); } } }).loadCompatGapReports(), []);
  assert.deepEqual(await panel.loadCompatGapReports(), []);
  delete globalThis.document;
});
