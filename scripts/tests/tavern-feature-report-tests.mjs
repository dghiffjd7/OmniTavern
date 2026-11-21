import test from 'node:test';
import assert from 'node:assert/strict';

// 导入兼容报告（酒馆后端接口模拟第 5 步）：分析器的识别、支持表、导入提示的摘要组装。
// 脚本片段都是为测试合成的，只模仿常见写法。

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true };

const {
  TAVERN_FEATURE_SUPPORT,
  analyzeImportedScripts,
  analyzeTavernFeatures,
  buildTavernFeatureImportLine,
  buildTavernFeatureSummary,
  scanJavascriptLiterals,
  summarizeTavernFeatures,
} = await import('../../src/scripts/import/tavern-feature-report.js');
const { analyzeScriptCompatibility } = await import('../../src/scripts/import/script-capability-preflight.js');
const { buildScriptAuthorizationMessage } = await import('../../src/scripts/ui/script-authorization-utils.js');
const { createTavernApiRouter } = await import('../../src/scripts/plugins/tavern-api-router.js');
const { ScriptStore } = await import('../../src/scripts/storage/script-store.js');

const analyze = content => analyzeTavernFeatures(content);
// 顶层 await 会让脚本改走模块环境，一般脚本的片段包在 async 函数里
const inAsync = lines => ['async function run() {', ...lines, '}'].join('\n');
const byId = (report, id) => report.items.find(item => item.id === id);
const apiPaths = content => analyze(content).items.filter(item => item.category === 'tavern_api').map(item => item.label);

test('scanner skips comments and regex literals and decodes escapes in strings', () => {
  const scanned = scanJavascriptLiterals([
    "// fetch('/api/chats/get')",
    "/* '/api/worldinfo/get' */",
    "const re = /['\"`]\\/api\\/x/g;",
    "const url = '\\/api\\/settings\\/get';",
    'const tpl = `a${ fn(`inner`) }b`;',
  ].join('\n'));
  assert.deepEqual(scanned.literals.map(literal => literal.value).sort(), ['/api/settings/get', 'ab', 'inner']);
  assert.match(scanned.code, /const re = {2}__R__ ;/);
  assert.deepEqual(scanned.literals.find(literal => literal.value === 'ab').parts, [{ text: 'a' }, { expr: 'fn(`inner`)' }, { text: 'b' }]);
});

test('tavern api paths: relative, origin-relative, template, constants and concatenation', () => {
  assert.deepEqual(apiPaths([
    "await fetch('/api/backends/chat-completions/status', { method: 'POST' });",
    "await fetch(new URL('/api/settings/get', location.origin));",
    'await fetch(`${location.origin}/api/chats/get`);',
    "await fetch('api/tokenizers/openai/count');",
    "await fetch('./api/worldinfo/list');",
    "await fetch('/api/' + 'presets/save');",
    "await fetch(window.location.origin + '/api/backends/chat-completions/generate?x=1');",
  ].join('\n')), [
    '/api/backends/chat-completions/generate',
    '/api/backends/chat-completions/status',
    '/api/chats/get',
    '/api/presets/save',
    '/api/settings/get',
    '/api/tokenizers/openai/count',
    '/api/worldinfo/list',
  ]);
  // 常量当前半段：用到的地方还原出完整路径，常量本身不报
  const report = analyze([
    "const BASE = '/api/worldinfo'",
    "const ROOT = '/api/backends/chat-completions';",
    "fetch(BASE + '/get');",
    'fetch(`${BASE}/edit`);',
    "fetch(`${ROOT}/status`);",
  ].join('\n'));
  assert.deepEqual(report.items.map(item => item.label), ['/api/backends/chat-completions/status', '/api/worldinfo/edit', '/api/worldinfo/get']);
  assert.deepEqual(byId(report, 'api:/api/worldinfo/get').matches, ["BASE + '/get'"]);
  assert.deepEqual(byId(report, 'api:/api/worldinfo/edit').matches, ['`${BASE}/edit`']);
});

test('tavern api paths: unknown pieces, external hosts and prose are not reported', () => {
  assert.deepEqual(apiPaths([
    "fetch('/api/worldinfo/' + action);", // 后半段认不出
    'fetch(`/api/backends/${kind}/status`);', // 中间认不出
    "fetch('https://example.com/api/chats/get');", // 写死别的网址
    "fetch('http://127.0.0.1:8000/api/chats/get');",
    "fetch(apiBase + '/api/v1/chat/completions');", // 不是酒馆的路由分组
    "fetch('/api/v1/models');",
    "const hint = 'see /api/chats/get for details';", // 一般文字
    "if (url.includes('/api/backends/')) hook();", // 以 / 结尾的前缀
    "const openapi = 'openapi/chats/get';",
  ].join('\n')), []);
});

test('tavern api paths keep a full known route even when a dynamic suffix follows', () => {
  assert.deepEqual(apiPaths("fetch('/api/worldinfo/get' + query);"), ['/api/worldinfo/get']);
  assert.deepEqual(apiPaths("fetch('/api/characters/' + id);"), []);
});

test('support table: statuses for tavern api paths follow the router', () => {
  const report = analyze([
    "fetch('/api/backends/chat-completions/status');",
    "fetch('/api/backends/chat-completions/generate');",
    "fetch('/api/tokenizers/openai/count');",
    "fetch('/api/worldinfo/list');",
    "fetch('/api/worldinfo/get');",
    "fetch('/api/worldinfo/edit');",
    "fetch('/api/chats/get');",
    "fetch('/api/settings/get');",
    "fetch('/api/presets/save');",
    "fetch('/api/secrets/find');",
    "fetch('/api/characters/all');",
    "fetch('/api/presets/save-openai');",
  ].join('\n'));
  assert.equal(report.runtime, 'worker');
  assert.deepEqual(Object.fromEntries(report.items.map(item => [item.label, item.status])), {
    '/api/backends/chat-completions/generate': 'supported',
    '/api/backends/chat-completions/status': 'supported',
    '/api/characters/all': 'unsupported',
    '/api/chats/get': 'supported',
    '/api/presets/save': 'partial',
    '/api/presets/save-openai': 'unsupported',
    '/api/secrets/find': 'unsupported',
    '/api/settings/get': 'partial',
    '/api/tokenizers/openai/count': 'supported',
    '/api/worldinfo/edit': 'supported',
    '/api/worldinfo/get': 'supported',
    '/api/worldinfo/list': 'supported',
  });
  assert.equal(byId(report, 'api:/api/secrets/find').feature, 'api:secrets');
  assert.equal(byId(report, 'api:/api/characters/all').feature, 'api:other');
  report.items.forEach(item => assert.ok(item.impact.length > 8, item.label));
});

test('support table agrees with the tavern api router (supported paths are routed, others get 501)', async () => {
  const gaps = [];
  const router = createTavernApiRouter({
    listModels: async () => ['m'],
    listWorldbooks: () => ['A'],
    readWorldbook: async () => ({ name: 'A', entries: [] }),
    getChat: () => ({ messages: [] }),
    getPresetSettings: () => ({ name: 'P', inUse: {}, saved: {} }),
    generate: async () => ({ status: 200, body: {} }),
    writeWorldbook: async () => ({ denied: false, savedEntries: [] }),
    findPreset: () => null,
    savePreset: async () => {},
    confirmWrite: async () => true,
    recordGap: gap => gaps.push(gap.path),
  });
  const access = { allowNetwork: true, allowReadMessages: true, allowModifyVariables: true, sessionId: 's1' };
  const routed = Object.entries(TAVERN_FEATURE_SUPPORT)
    .filter(([key, entry]) => key.startsWith('/api/') && entry.status !== 'unsupported')
    .map(([key]) => key);
  assert.ok(routed.length >= 9);
  for (const path of routed) {
    const result = await router.handle({ path, body: { name: 'A' } }, access);
    assert.notEqual(result.status, 501, path);
  }
  assert.equal((await router.handle({ path: '/api/secrets/find', body: {} }, access)).status, 403);
  assert.equal((await router.handle({ path: '/api/characters/all', body: {} }, access)).status, 501);
  assert.deepEqual(gaps, ['/api/characters/all']);
});

test('functions: generate, generateRaw, slash commands, database plugin', () => {
  const report = analyze(inAsync([
    'const text = await generate({ user_input: "hi" });',
    'await window.generate({});',
    'await TavernHelper.generateRaw({ ordered_prompts: [] });',
    "triggerSlash('/send hi');",
    "await SillyTavern.getContext().executeSlashCommandsWithOptions('/echo hi');",
    'const db = window.parent.AutoCardUpdaterAPI;',
  ]));
  assert.equal(report.runtime, 'worker');
  const generate = byId(report, 'generate');
  assert.equal(generate.status, 'supported');
  assert.equal(generate.label, 'generate／generateRaw');
  assert.deepEqual(generate.matches, ['generate(', 'window.generate(', 'TavernHelper.generateRaw(']);
  assert.equal(byId(report, 'slash').status, 'unsupported');
  assert.deepEqual(byId(report, 'slash').matches, ['triggerSlash', 'executeSlashCommandsWithOptions']);
  assert.equal(byId(report, 'database_plugin').status, 'unsupported');
  assert.equal(byId(analyze("if ('AutoCardUpdaterAPI' in window) start();"), 'database_plugin').status, 'unsupported');
});

test('functions: definitions, other objects, strings and comments are not usages', () => {
  const report = analyze([
    '// triggerSlash("/x"); generate();',
    "const help = 'call generate() or triggerSlash()';",
    'this.generate();',
    'client.generate({});',
    'const tools = { generate() { return 1; }, triggerSlash: null };',
    'class A { async generate(x) { return x; } }',
    'TavernHelper.generate({});', // Worker 的 TavernHelper 上没有 generate，不当作支持
  ].join('\n'));
  assert.deepEqual(report.items, []);
  // 脚本自己定义了同名函数：直接呼叫的是它自己的
  assert.deepEqual(analyze('function generate(a) { return a; }\ngenerate(1);').items, []);
});

test('host page: parent/top document and tavern selectors are partial; #send_textarea is supported', () => {
  const report = analyze([
    'const doc = window.parent.document;',
    "$('#chat .mes').last();",
    "$('#send_textarea').val('hi');",
  ].join('\n'));
  assert.equal(byId(report, 'host_dom').status, 'partial');
  assert.deepEqual(byId(report, 'host_dom').matches, ['window.parent.document', '#chat']);
  assert.equal(byId(report, 'send_textarea').status, 'supported');
  // 脚本自己的元素与一般选择器不算
  assert.deepEqual(analyze("$('#my-panel .row').hide(); document.querySelector('.message');").items, []);
});

test('jQuery requests are unsupported; collection .get() is not a request', () => {
  const report = analyze("$.ajax({ url: '/api/chats/get' });\n$('.x').get(0);\njQuery.post('/x');");
  assert.equal(byId(report, 'jquery_request').status, 'unsupported');
  assert.deepEqual(byId(report, 'jquery_request').matches, ['$.ajax(', 'jQuery.post(']);
  assert.equal(byId(analyze("$('.x').get(0); $(el).post;"), 'jquery_request'), undefined);
});

test('worldbook: whole-book writes are supported only as direct calls; entry-level and lorebook APIs are not', () => {
  const report = analyze(inAsync([
    "await createOrReplaceWorldbook('A', []);",
    "await updateWorldbookWith('A', list => list);",
    "const entries = await getLorebookEntries('A');",
  ]));
  assert.equal(byId(report, 'worldbook_write').status, 'supported');
  assert.deepEqual(byId(report, 'worldbook_write').matches, ['createOrReplaceWorldbook(']);
  assert.equal(byId(report, 'worldbook_unsupported').status, 'unsupported');
  assert.equal(byId(report, 'worldbook_unsupported').label, 'updateWorldbookWith／getLorebookEntries');
  // createWorldbook 不会被当成 createWorldbookEntries 的一部分，反之亦然
  assert.deepEqual(analyze("createWorldbookEntries('A', []);").items.map(item => item.id), ['worldbook_unsupported']);
});

test('module scripts lose the Worker-only features', () => {
  const content = "import { x } from 'https://example.com/x.js';\nawait fetch('/api/chats/get');\ngenerateRaw({});\ntriggerSlash('/x');";
  const report = analyzeTavernFeatures({ content, compatibility: analyzeScriptCompatibility(content) });
  assert.equal(report.runtime, 'module');
  assert.deepEqual(report.items.map(item => [item.label, item.status]), [
    ['/api/chats/get', 'unsupported'],
    ['generateRaw', 'unsupported'],
    ['triggerSlash', 'unsupported'],
  ]);
  assert.match(report.items[0].impact, /模块方式运行/);
  assert.doesNotMatch(report.items[2].impact, /模块方式运行/);
});

test('summary: counts per status with labels, capped list, empty when no tavern feature', () => {
  const report = analyze([
    "fetch('/api/chats/get');",
    "fetch('/api/worldinfo/get');",
    "fetch('/api/settings/get');",
    "triggerSlash('/x');",
    'parent.AutoCardUpdaterAPI.x();',
    "fetch('/api/characters/all');",
    "fetch('/api/secrets/find');",
  ].join('\n'));
  assert.equal(
    buildTavernFeatureSummary(report),
    '2 项支持、1 项部分支持（/api/settings/get）、4 项不支持（/api/characters/all、/api/secrets/find、triggerSlash 等）',
  );
  assert.equal(
    buildTavernFeatureImportLine(analyze("fetch('/api/chats/get'); triggerSlash('/x');")),
    '酒馆功能：1 项支持、1 项不支持（triggerSlash）。明细可在脚本管理里查看。',
  );
  assert.equal(buildTavernFeatureSummary(analyze("eventOn('x', () => {});")), '');
  assert.equal(buildTavernFeatureImportLine(null), '');
});

test('summarize across scripts keeps the worst status per item and merges forms', () => {
  const worker = analyze("fetch('/api/chats/get');");
  const module = analyzeTavernFeatures({
    content: "export const a = 1;\nfetch(`${location.origin}/api/chats/get`);",
    compatibility: { signals: { topLevelAwait: false } },
  });
  const summary = summarizeTavernFeatures([worker, module, analyze("fetch('/api/chats/get');")]);
  assert.deepEqual(summary.counts, { supported: 0, partial: 0, unsupported: 1 });
  assert.deepEqual(summary.items[0].matches, ["'/api/chats/get'", '`${location.origin}/api/chats/get`']);
});

test('imported scripts: blocked and schema-only scripts are left out', () => {
  const summary = analyzeImportedScripts([
    { content: "triggerSlash('/x');", compatibility: { blocked: true } },
    { content: "fetch('/api/chats/get');", schemaOnly: true },
    { content: 'generateRaw({});' },
  ]);
  assert.deepEqual(summary.items.map(item => item.id), ['generate']);
});

test('script authorization message adds the tavern feature line only when features are used', () => {
  const settings = { scriptAllowReadMessages: true, scriptAllowModifyVariables: true, scriptAllowNetwork: false };
  const tavernFeatures = analyzeImportedScripts([{ content: "fetch('/api/settings/get'); triggerSlash('/x');" }]);
  assert.equal(
    buildScriptAuthorizationMessage({ leadText: '检测到 1 条脚本。', settings, tavernFeatures }),
    '检测到 1 条脚本。\n酒馆功能：1 项部分支持（/api/settings/get）、1 项不支持（triggerSlash）。明细可在脚本管理里查看。\n脚本可能需要权限：\n- 读取聊天记录：允许\n- 修改变量：允许\n- 访问网络：禁用',
  );
  assert.equal(
    buildScriptAuthorizationMessage({ leadText: '检测到 1 条脚本。', settings, tavernFeatures: analyzeImportedScripts([{ content: 'void 0;' }]) }),
    '检测到 1 条脚本。\n脚本可能需要权限：\n- 读取聊天记录：允许\n- 修改变量：允许\n- 访问网络：禁用',
  );
});

test('script store import result carries the tavern feature summary of runnable scripts', async () => {
  const store = Object.create(ScriptStore.prototype);
  store.state = { version: 2, global: { scripts: [], variables: {} }, character: {}, preset: {} };
  store.persist = async () => {};
  const result = await store.importTavernHelperScripts({
    scripts: [
      { id: 'a', name: 'A', content: "fetch('/api/chats/get');" },
      { type: 'folder', scripts: [{ id: 'b', name: 'B', content: "triggerSlash('/x');" }] },
    ],
    scope: 'preset',
    scopeId: 'p1',
    source: 'preset',
  });
  assert.equal(buildTavernFeatureSummary(result.tavernFeatures), '1 项支持、1 项不支持（triggerSlash）');
  const empty = await store.importTavernHelperScripts({ scripts: [], scope: 'preset', scopeId: 'p1' });
  assert.equal(buildTavernFeatureSummary(empty.tavernFeatures), '');
});

test('analysis is cached per content and returns fresh copies', () => {
  const content = "fetch('/api/chats/get');";
  const first = analyze(content);
  first.items[0].matches.push('mutated');
  assert.deepEqual(analyze(content).items[0].matches, ["'/api/chats/get'"]);
});

test('maid attachment.import script result carries the tavern feature summary', async () => {
  const { createMaidAttachmentsFromFiles, createMaidFileAttachmentRegistry } = await import('../../src/scripts/ui/maid-file-attachments.js');
  const { createAttachmentImportAgentTools } = await import('../../src/scripts/agent/tools/attachment-import-tools.js');
  const run = async (source, id) => {
    const bytes = new TextEncoder().encode(source);
    const registry = createMaidFileAttachmentRegistry();
    await createMaidAttachmentsFromFiles([{ name: `${id}.js`, type: '', size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }], { registry, createId: () => id });
    const [, importTool] = createAttachmentImportAgentTools({
      getAttachmentRegistry: () => registry,
      scriptStore: {
        importTavernHelperScripts: async ({ scripts }) => ({
          count: 1, ids: ['s1'], runnableIds: ['s1'],
          compatibility: { runnableCount: 1, blockedCount: 0, blocked: [] },
          tavernFeatures: analyzeImportedScripts(scripts),
        }),
      },
    });
    const args = { attachmentId: id, target: 'global' };
    const preflight = await importTool.safety.preflight(args, {});
    return importTool.execute(args, { toolSafety: { decision: 'allow', request: preflight } });
  };
  const used = await run("fetch('/api/settings/get');", 'js-a');
  assert.equal(used.tavernFeatures, '1 项部分支持（/api/settings/get）');
  const plain = await run('console.log(1);', 'js-b');
  assert.equal(Object.hasOwn(plain, 'tavernFeatures'), false);
});
