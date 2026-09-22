import assert from 'node:assert/strict';
import vm from 'node:vm';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  getItem(key) {
    const name = String(key || '');
    return this.map.has(name) ? this.map.get(name) : null;
  }

  setItem(key, value) {
    this.map.set(String(key || ''), String(value ?? ''));
  }

  removeItem(key) {
    this.map.delete(String(key || ''));
  }
}

globalThis.localStorage = globalThis.localStorage || new MemoryStorage();
globalThis.window = globalThis.window || {
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
};

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, delay, ...args) => {
  if (delay === 1000) return 0;
  return realSetTimeout(fn, delay, ...args);
};
const {
  buildScriptRuntimeWorkerSourceForTests,
  isEsmLikeScriptForTests,
  ScriptRuntime,
} = await import('../../src/scripts/plugins/script-runtime.js');
const { appSettings } = await import('../../src/scripts/storage/app-settings.js');
globalThis.setTimeout = realSetTimeout;

const createWorkerHarness = ({ chatMessages = [], characterRegexes = [], fetchImpl, importScriptsImpl } = {}) => {
  const messages = [];
  const networkCalls = { xhr: 0, webSocket: 0, importScripts: 0 };
  let sandbox = null;
  class FakeXhr {
    open(_method, url) {
      if (/example\.com/.test(String(url || ''))) networkCalls.xhr += 1;
      this.status = 404;
      this.responseText = '';
    }

    send() {
      this.status = 404;
      this.responseText = '';
    }
  }
  class FakeWebSocket {
    constructor(url) {
      if (/example\.com/.test(String(url || ''))) networkCalls.webSocket += 1;
      this.url = url;
    }

    close() {}
  }

  sandbox = {
    console,
    structuredClone: globalThis.structuredClone,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Date,
    Math,
    JSON,
    RegExp,
    Error,
    Promise,
    Map,
    WeakMap,
    Set,
    Array,
    Object,
    String,
    Number,
    Boolean,
    URL,
    AbortController,
    Response,
    ReadableStream,
    TextEncoder,
    TextDecoder,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    XMLHttpRequest: FakeXhr,
    WebSocket: FakeWebSocket,
    importScripts: importScriptsImpl || ((url) => {
      if (/example\.com/.test(String(url || ''))) networkCalls.importScripts += 1;
      throw new Error('blocked in test');
    }),
    postMessage: (msg) => {
      messages.push(msg);
      if (msg?.type === 'rpc' && msg.method === 'chat.getMessages') {
        queueMicrotask(() => {
          sandbox.self.onmessage({ data: { type: 'rpc_result', id: msg.id, result: chatMessages } });
        });
      } else if (msg?.type === 'rpc' && msg.method === 'regex.getCharacter') {
        queueMicrotask(() => {
          sandbox.self.onmessage({ data: { type: 'rpc_result', id: msg.id, result: characterRegexes } });
        });
      } else if (msg?.type === 'rpc') {
        queueMicrotask(() => {
          sandbox.self.onmessage({ data: { type: 'rpc_result', id: msg.id, result: true } });
        });
      }
    },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(buildScriptRuntimeWorkerSourceForTests(), sandbox, {
    filename: 'script-runtime-worker.js',
  });
  return { sandbox, messages, networkCalls };
};

const flushTimers = () => new Promise(resolve => setTimeout(resolve, 0));

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    'use strict';
    const getPreset = () => 'local declaration';
    const generate = () => 'also local';
    if (getPreset() !== 'local declaration' || generate() !== 'also local') throw Error('name collision');
    if (globalThis.getPreset().prompts[0].id !== 'p') throw Error('missing scoped preset API');
    script.data.old = true;
    replaceVariables({ owner: getScriptId() }, { type: 'script' });
    if (getVariables({ type: 'script' }).owner !== getScriptId()) throw Error('wrong script scope');
    appendInexistentScriptButtons([{ name: 'Settings', visible: true }]);
    appendInexistentScriptButtons([{ name: 'Settings', visible: true }]);
    globalThis.__compatOrder = [];
    eventOn('ordered', () => globalThis.__compatOrder.push('last'));
    eventOn('ordered', () => globalThis.__compatOrder.push('stopped')).stop();
    eventMakeFirst('ordered', () => globalThis.__compatOrder.push('first'));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
    document.body.appendChild(svg);
    const textarea = document.createElement('textarea');
    textarea.value = 'initial <text>\\n中文';
    document.body.appendChild(textarea);
  `;
  await sandbox.self.onmessage({ data: { type: 'sync', context: {
    sessionId: 'rp:scope', activePreset: { prompts: [{ identifier: 'p', content: 'prompt' }] },
  }, scripts: [
    { id: 'scope-a', name: 'scoped APIs', enabled: true, content: script },
    { id: 'scope-b', name: 'other scope', enabled: true, content: "replaceVariables({owner:getScriptId()}, {type:'script'});" },
  ] } });
  await sandbox.self.onmessage({ data: { type: 'dispatch', event: 'ordered', id: 'order', payload: {} } });
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.equal(messages.some(msg => msg.params?.scriptError), false);
  assert.deepEqual(Array.from(sandbox.__compatOrder), ['first', 'last']);
  const dataWrites = messages.filter(msg => msg.type === 'rpc' && msg.method === 'script.updateData');
  assert.equal(dataWrites.length, 3, 'two immediate writes plus one pending data flush');
  for (const message of dataWrites) assert.deepEqual(JSON.parse(JSON.stringify(message.params.data)), { owner: message.params.scriptId });
  const html = messages.filter(msg => msg.type === 'ui_update').at(-1).payload.roots.join('');
  assert.equal((html.match(/>Settings</g) || []).length, 1);
  assert.match(html, /<svg[^>]*><path/);
  assert.match(html, /<textarea[^>]*>initial &lt;text&gt;\n中文<\/textarea>/, 'textarea live value must become native textarea content');
  console.log('ok - scoped preset APIs allow local names; script data persists without delayed clearing; subscriptions and SVG work');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const loading = sandbox.self.onmessage({ data: { type: 'sync', context: { sessionId: 'rp:loading', openaiPresetId: 'p' }, scripts: [{
    id: 'middleware', enabled: true, content: `
      const previousFetch = parent.fetch;
      parent.fetch = (url, init) => {
        const body = JSON.parse(init.body); body.temperature = 0.25;
        return previousFetch(url, { ...init, body: JSON.stringify(body) });
      };
    `,
  }] } });
  await sandbox.self.onmessage({ data: { type: 'preset_request', event: 'start', id: 'early',
    sessionId: 'rp:loading', presetId: 'p', preview: true, body: { messages: [{ role: 'user', content: 'test' }] } } });
  await loading;
  await flushTimers();
  const prepared = messages.find(msg => msg.type === 'preset_request' && msg.event === 'prepared');
  assert.equal(prepared?.bypass, undefined);
  assert.equal(prepared?.body.temperature, 0.25, 'an immediate send must wait for async script loading');
  const installed = sandbox.fetch;
  await sandbox.self.onmessage({ data: { type: 'context', context: { variables: { changed: true } } } });
  assert.equal(sandbox.fetch, installed, 'context snapshots must preserve installed middleware');
  console.log('ok - requests wait for script loading and context refresh preserves middleware');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  let context = { sessionId: 'rp:a', openaiPresetId: 'p', presetName: 'preset', activePreset: { prompts: [] } };
  runtime.buildContext = () => structuredClone(context);
  runtime.context = structuredClone(context);
  const posted = [];
  runtime.worker = { postMessage: msg => posted.push(msg) };
  let reloads = 0;
  runtime.syncScripts = async () => { reloads++; };
  const events = [];
  runtime.callWorker = async (_type, data) => { events.push(data.event); };
  runtime.hasListener = () => true;
  context.variables = { updated: true };
  await runtime.syncContext();
  assert.equal(reloads, 0);
  context.activePreset.prompts.push({ id: 'new' });
  await runtime.syncContext();
  assert.deepEqual(events, ['preset.changed']);
  assert.equal(reloads, 0);
  context.sessionId = 'rp:b';
  await runtime.syncContext();
  assert.equal(reloads, 1);

  runtime.isEnabled = () => true;
  let preparations = 0;
  runtime.presetRequestTransport.prepare = async () => { preparations++; return { bypass: true }; };
  const request = { messages: [{ role: 'user', content: 'hello' }], options: { toolConfig: { unknownProviderOption: true } },
    config: { provider: 'gemini' }, client: {}, presetContext: { sessionId: 'rp:b', uiMode: 'rp' } };
  const bypass = await runtime.prepareCreativeRequest(request);
  assert.equal(bypass.options, request.options);
  assert.equal(bypass.client, request.client);
  assert.equal(await runtime.prepareCreativeRequest({ ...request, presetContext: { uiMode: 'chat' } }), null);
  assert.equal(preparations, 1, 'normal chat cannot enter the preset transport');
  runtime.presets = { state: { enabled: { openai: false } } };
  assert.equal(await runtime.prepareCreativeRequest(request), null);
  assert.equal(preparations, 1, 'disabling the preset also disables its request middleware');

  const controller = new AbortController();
  runtime.scriptGenerations.set('diagnostic', { scriptId: 'owner', controller });
  assert.equal(await runtime.processRpc('generation.stop', { generationId: 'diagnostic', scriptId: 'other' }), false);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await runtime.processRpc('generation.stop', { generationId: 'diagnostic', scriptId: 'owner' }), true);
  assert.equal(controller.signal.aborted, true);
  console.log('ok - ordinary context changes preserve panels, no-op requests preserve options, chat is excluded and cancellation is script scoped');
}

assert.equal(isEsmLikeScriptForTests("import 'https://example.com/loader.js'"), true);
assert.equal(isEsmLikeScriptForTests('export const value = 1;'), true);
assert.equal(isEsmLikeScriptForTests('const important = true;'), false);
assert.equal(isEsmLikeScriptForTests("import { ref } from 'vue';"), true);
assert.equal(isEsmLikeScriptForTests(";import{a}from'x';"), true);
assert.equal(isEsmLikeScriptForTests('}\nexport{helper}'), true);
assert.equal(isEsmLikeScriptForTests('export default function() {}'), true);
// 脚本内嵌 HTML/取值字符串不是模块语法（对话渲染系统 v7.1 误路由回归形态）
assert.equal(isEsmLikeScriptForTests('const html = `<button id="bam-btn-import" style="x">导入</button>`;'), false);
assert.equal(isEsmLikeScriptForTests("$('#bam-btn-import').addEventListener('click', () => {});"), false);
assert.equal(isEsmLikeScriptForTests("const exportBtn = doc.getElementById('bam-btn-export');"), false);
assert.equal(isEsmLikeScriptForTests('module.exports = {}; exports.foo = 1;'), false);
assert.equal(isEsmLikeScriptForTests('const data = { import: fn, export: gn };'), false);
assert.equal(isEsmLikeScriptForTests('const value = await Promise.resolve(1);'), true);
assert.equal(isEsmLikeScriptForTests('async function load() { return await Promise.resolve(1); }'), false);
console.log('ok - script runtime recognizes actual ESM import and export syntax');

{
  const { sandbox } = createWorkerHarness();
  await sandbox.self.onmessage({ data: {
    type: 'sync', settings: { allowNetwork: false }, scripts: [],
  } });
  const failures = vm.runInContext(`(() => {
    const failures = [];
    const root = document.createElement('section');
    document.body.appendChild(root);
    const user = document.createElement('div');
    user.id = 'preset-user'; user.className = 'mes is_user';
    const assistant = document.createElement('div');
    assistant.id = 'preset-assistant'; assistant.className = 'mes';
    const legacy = document.createElement('div');
    legacy.id = 'preset-legacy'; legacy.className = 'prefix sb-group-v44';
    const unrelated = document.createElement('div');
    unrelated.id = 'preset-unrelated'; unrelated.className = 'sb-settings';
    [user, assistant, legacy, unrelated].forEach(node => root.appendChild(node));
    const cleanup = $('[class*="sb-group-v"]');
    if (cleanup.length !== 1 || cleanup[0] !== legacy) failures.push('legacy cleanup selector matched unrelated nodes');
    legacy.setAttribute('data-pattern', ' sb.group#v44 ');
    legacy.setAttribute('lang', 'zh-TW');
    const matchers = [
      ['div[data-pattern=" sb.group#v44 "]', legacy],
      ['[data-pattern*="group#v"]', legacy],
      ['[class^="prefix"]', legacy],
      ['[class$="v44"]', legacy],
      ['[class~="sb-group-v44"]', legacy],
      ['[lang|="zh"]', legacy],
      ['[data-missing*="sb-group-v"]', null],
      ['[class*=""]', null],
      ['[class!="unrelated"]', null],
    ];
    for (const [selector, expected] of matchers) {
      const matches = root.querySelectorAll(selector);
      if (matches.length !== (expected ? 1 : 0) || (expected && matches[0] !== expected)) failures.push('incorrect attribute match: ' + selector);
    }
    const seen = [];
    const selected = $([user, assistant]);
    const same = selected.each(function(index, node) {
      seen.push(this === node && node === selected[index]);
      return false;
    }) === selected;
    if (!same || seen.length !== 1 || seen[0] !== true) failures.push('each callback lost node binding or early exit');
    if (typeof selected.not !== 'function') {
      failures.push('preset scan: not is not a function');
    } else {
      const scanned = [];
      selected.not('.is_user').each(function() { scanned.push(this.id); });
      if (scanned.join(',') !== assistant.id || selected.length !== 2) failures.push('not must keep only the assistant without mutating its input');
      if (selected.not(user)[0] !== assistant || selected.not($(user))[0] !== assistant || selected.not([user])[0] !== assistant) failures.push('not must accept nodes and collections');
      if (selected.not(function(index, node) { return this === node && index === 0; })[0] !== assistant) failures.push('not callback must receive the current node and index');
      if (selected.not().length !== 2 || selected.not('.is_user, .mes').length !== 0 || $([]).not('.is_user').length !== 0) failures.push('not must support empty input and selector lists');
      const detached = document.createElement('div'); detached.className = 'is_user';
      if ($(detached).not('.is_user').length !== 0) failures.push('not must filter detached elements');
      const text = document.createTextNode('plain');
      if ($([text, assistant]).not('.is_user').get().join() !== $(assistant).get().join()) failures.push('selector exclusions must omit non-elements');
    }
    // This is the original preset startup/refresh shape: remove legacy widgets,
    // clear old markers, then scan assistant messages. Keep unrelated UI intact.
    cleanup.remove();
    assistant.setAttribute('data-sb-v41-processed', 'true');
    assistant.setAttribute('data-sb-v44-processed', 'true');
    $('[data-sb-v41-processed], [data-sb-v44-processed]')
      .removeAttr('data-sb-v41-processed').removeAttr('data-sb-v44-processed');
    if (assistant.hasAttribute('data-sb-v41-processed') || assistant.hasAttribute('data-sb-v44-processed')) failures.push('preset startup did not clear stale markers');
    if (document.getElementById('preset-unrelated') !== unrelated || document.getElementById('preset-assistant') !== assistant || document.body.parentNode !== document.documentElement) failures.push('preset cleanup detached unrelated UI');
    return failures;
  })()`, sandbox);
  assert.deepEqual(Array.from(failures), []);
  console.log('ok - preset startup cleanup preserves unrelated UI and scanning excludes user messages with correctly bound callbacks');
}

{
  const { sandbox, messages } = createWorkerHarness();
  await sandbox.self.onmessage({
    data: { type: 'sync', settings: { allowNetwork: false }, context: { sessionId: 'remove-attr' }, scripts: [] },
  });
  const result = vm.runInContext(`(() => {
    const root = document.createElement('section');
    document.body.appendChild(root);
    const nodes = [document.createElement('button'), document.createElement('button')];
    nodes.forEach((node, index) => {
      node.setAttribute('id', 'remove-attr-' + index);
      node.setAttribute('disabled', 'disabled');
      node.setAttribute('data-pending', '1');
      node.setAttribute('aria-busy', 'true');
      node.setAttribute('title', 'keep');
      node.setAttribute('style', 'display: none; color: red');
      root.appendChild(node);
    });
    const styles = nodes.map(node => node.style);
    const selected = $(nodes);
    const sameCollection = selected.removeAttr('disabled  data-pending\\taria-busy\\nstyle') === selected;
    const stylesCleared = nodes.every((node, index) => node.style === styles[index] && node.style.cssText === '');
    selected.css('display', 'block').attr('data-ready', 'yes');
    const attrsRemoved = nodes.every(node => !node.hasAttribute('disabled') && !node.hasAttribute('data-pending') && !node.hasAttribute('aria-busy'));
    const indexesCleared = document.querySelectorAll('button[data-pending="1"]').length === 0;
    const chainingWorks = nodes.every(node => node.style.display === 'block' && node.getAttribute('data-ready') === 'yes' && node.getAttribute('title') === 'keep');
    const noOpInputs = [undefined, null, '', '  ', 0, {}].every(value => selected.removeAttr(value) === selected);
    const mixed = $([document, document.createTextNode('text'), nodes[0]]);
    const nonElementsIgnored = mixed.removeAttr('data-ready') === mixed && !nodes[0].hasAttribute('data-ready');
    const empty = $([]);
    return { sameCollection, stylesCleared, attrsRemoved, indexesCleared, chainingWorks, noOpInputs, nonElementsIgnored, emptySafe: empty.removeAttr('disabled') === empty };
  })()`, sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    sameCollection: true,
    stylesCleared: true,
    attrsRemoved: true,
    indexesCleared: true,
    chainingWorks: true,
    noOpInputs: true,
    nonElementsIgnored: true,
    emptySafe: true,
  });
  await flushTimers();
  const projected = messages.filter(msg => msg.type === 'ui_update').at(-1)?.payload?.roots?.join('') || '';
  assert.match(projected, /display: block/);
  assert.doesNotMatch(projected, /disabled=|data-pending=|aria-busy=|display: none|color: red/);
  console.log('ok - worker removeAttr clears selected attributes and styles, preserves chaining and updates projected UI');
}

{
  const { sandbox, messages } = createWorkerHarness({
    chatMessages: [
      { id: 'record-user-a', role: 'user', raw: 'hello' },
      { id: 'record-assistant-b', role: 'assistant', raw: 'world' },
    ],
  });
  const script = `
    eventOn('macro.compat', () => {
      const direct = substitudeMacros('{{user}}/{{char}}/{{model}}/{{input}}/{{lastMessageId}}/{{lastMessage}}/{{getvar::hp}}/{{getglobalvar::shared}}');
      const extended = SillyTavern.substituteParamsExtended(
        '{{custom}}',
        { custom: 'dynamic' },
        value => '[' + value + ']',
      );
      const legacy = substituteParams(
        '{{user}}/{{char}}/{{custom}}',
        'LegacyUser',
        'LegacyChar',
        undefined,
        undefined,
        true,
        { custom: 'legacy' },
        value => '<' + value + '>',
      );
      const fromContext = SillyTavern.getContext().substituteParams('{{lastMessageId}}');
      SillyTavern.registerMacro('registered', () => 'yes');
      const helper = TavernHelper.substitudeMacros('{{registered}}');
      const mutated = substituteParams('{{setvar::hp::7}}{{getvar::hp}}');
      return {
        direct,
        extended,
        legacy,
        fromContext,
        helper,
        mutated,
        sync: typeof direct === 'string' && !(direct && typeof direct.then === 'function'),
      };
    });
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowReadMessages: true, allowModifyVariables: true },
      context: {
        sessionId: 's1',
        userName: 'Alice',
        characterName: 'Milla',
        model: 'gpt-test',
        input: 'draft',
        variables: { hp: '2' },
        localVariables: { hp: '2' },
        globalVariables: { shared: '5' },
        variableRuntimeEnabled: true,
      },
      scripts: [{ id: 'macro-compat', name: 'macro compat', enabled: true, content: script }],
    },
  });
  await flushTimers();
  await sandbox.self.onmessage({
    data: { type: 'dispatch', id: 'macro-compat-dispatch', event: 'macro.compat', payload: {} },
  });
  await flushTimers();
  const result = messages.find(msg => msg.type === 'dispatch_result' && msg.id === 'macro-compat-dispatch')?.result;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    direct: 'Alice/Milla/gpt-test/draft/1/world/2/5',
    extended: '[dynamic]',
    legacy: '<LegacyUser>/<LegacyChar>/<legacy>',
    fromContext: '1',
    helper: 'yes',
    mutated: '7',
    sync: true,
  });
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'variables.set' && msg.params?.key === 'hp' && msg.params?.value === '7'),
    true,
    '启用脚本变量修改时宏写入应同步更新镜像并异步持久化',
  );
  console.log('ok - worker exposes synchronous ST macro API aliases backed by real macro evaluation');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    eventOn('macro.shared', () => {
      const before = substitudeMacros('{{getvar::x::fallback}}');
      const mutated = substitudeMacros('{{setvar::x::next}}{{getvar::x}}');
      return {
        before,
        mutated,
        local: getVariables().x,
        global: getVariables({ type: 'global' }).x,
      };
    });
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowReadMessages: true, allowModifyVariables: true },
      context: {
        sessionId: 's1',
        uiMode: 'chat',
        sharedVariables: true,
        variables: { x: 'global-value' },
        localVariables: { x: 'local-value' },
        globalVariables: { x: 'global-value' },
        variableRuntimeEnabled: true,
      },
      scripts: [{ id: 'macro-shared', name: 'macro shared', enabled: true, content: script }],
    },
  });
  await flushTimers();
  await sandbox.self.onmessage({
    data: { type: 'dispatch', id: 'macro-shared-dispatch', event: 'macro.shared', payload: {} },
  });
  await flushTimers();
  const result = messages.find(msg => msg.type === 'dispatch_result' && msg.id === 'macro-shared-dispatch')?.result;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    before: 'global-value',
    mutated: 'next',
    local: 'local-value',
    global: 'next',
  });
  assert.equal(
    messages.some(msg => (
      msg.type === 'rpc'
      && msg.method === 'variables.set'
      && msg.params?.key === 'x'
      && msg.params?.options?.scope === 'global'
    )),
    true,
    '共享变量会话的普通 setvar 必须与主链一样写入 global',
  );
  console.log('ok - worker macro API maps shared chat variables to the global scope');
}

{
  const { sandbox, messages } = createWorkerHarness({
    chatMessages: [{ id: 'secret', role: 'assistant', raw: 'must-not-leak' }],
  });
  const script = `
    eventOn('macro.permission', () => ({
      output: substitudeMacros('{{setvar::hp::9}}{{getvar::hp}}'),
      hp: getVariables().hp,
      lastMessage: substitudeMacros('[{{lastMessage}}]'),
    }));
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowReadMessages: false, allowModifyVariables: false },
      context: {
        sessionId: 's1',
        variables: { hp: '2' },
        localVariables: { hp: '2' },
        globalVariables: {},
        variableRuntimeEnabled: true,
      },
      scripts: [{ id: 'macro-permission', name: 'macro permission', enabled: true, content: script }],
    },
  });
  await flushTimers();
  await sandbox.self.onmessage({
    data: { type: 'dispatch', id: 'macro-permission-dispatch', event: 'macro.permission', payload: {} },
  });
  await flushTimers();
  const result = messages.find(msg => msg.type === 'dispatch_result' && msg.id === 'macro-permission-dispatch')?.result;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { output: '9', hp: '2', lastMessage: '[]' });
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && /^variables\./.test(String(msg.method || ''))),
    false,
    '禁用脚本变量修改时宏不得绕过权限写入',
  );
  assert.equal(
    messages.filter(msg => (
      msg.type === 'rpc'
      && msg.method === 'log'
      && msg.params?.args?.[0] === '脚本权限已禁用'
      && msg.params?.args?.[1] === '修改变量'
    )).length,
    1,
    '禁用写权限时同一个宏 API 生命周期只提示一次',
  );
  console.log('ok - synchronous macro API keeps script variable write permissions');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    eventOn('macro.paused', () => ({
      output: substitudeMacros('A{{setvar::hp::9}}B{{getvar::hp}}C'),
    }));
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowReadMessages: true, allowModifyVariables: true },
      context: {
        sessionId: 's1',
        variables: {},
        localVariables: {},
        globalVariables: {},
        variableRuntimeEnabled: false,
      },
      scripts: [{ id: 'macro-paused', name: 'macro paused', enabled: true, content: script }],
    },
  });
  await flushTimers();
  await sandbox.self.onmessage({
    data: { type: 'dispatch', id: 'macro-paused-dispatch', event: 'macro.paused', payload: {} },
  });
  await flushTimers();
  const result = messages.find(msg => msg.type === 'dispatch_result' && msg.id === 'macro-paused-dispatch')?.result;
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { output: 'ABC' });
  assert.equal(messages.some(msg => msg.type === 'rpc' && /^variables\./.test(String(msg.method || ''))), false);
  console.log('ok - synchronous macro API respects the session variable-runtime pause');
}

{
  const runtime = Object.create(ScriptRuntime.prototype);
  runtime.scriptDiagnosticSignatures = new Map();
  runtime.scriptDiagnosticRevisions = new Map();
  const payload = {
    phase: 'load',
    scriptId: 'external-loader',
    scriptName: '外部扩展加载器',
    error: 'await is only valid in async functions and the top level bodies of modules',
    compatibility: {
      level: 'external_extension',
      blocked: true,
      reasons: ['host_dom_access', 'remote_asset_loader', 'top_level_await'],
      fingerprint: 'external_extension:host_dom_access+remote_asset_loader+top_level_await',
    },
  };
  runtime.syncScriptDiagnosticRevision({ id: payload.scriptId, content: 'missingGlobal();' });
  assert.equal(runtime.reportScriptRuntimeError(payload), true);
  assert.equal(runtime.reportScriptRuntimeError(payload), false);
  assert.equal(runtime.reportScriptRuntimeError({
    ...payload,
    scriptId: 'external-loader-2',
    scriptName: '另一个外部扩展加载器',
  }), true);
  runtime.syncScriptDiagnosticRevision({ id: payload.scriptId, content: 'missingGlobal(); // edited' });
  assert.equal(runtime.reportScriptRuntimeError(payload), true);
  assert.equal(runtime.reportScriptRuntimeError(payload), false);
  console.log('ok - script runtime deduplicates by script revision without hiding sibling errors');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  const storedCompatibility = {
    version: 1,
    level: 'module',
    blocked: false,
    reasons: ['top_level_await'],
    signals: {
      topLevelAwait: true,
      hostDomAccess: false,
      remoteAssetLoader: false,
      nativeExtensionApi: false,
    },
    fingerprint: 'module:top_level_await',
    message: 'stored compatibility',
    marker: 'stored-result',
  };
  runtime.store = {
    getScripts: scope => scope === 'global' ? [{
      id: 'stored-module',
      name: '已归一化模块脚本',
      content: 'const value = await Promise.resolve(1);',
      enabled: true,
      authorized: true,
      compatibility: storedCompatibility,
    }] : [],
  };
  runtime.buildContext = () => ({
    sessionId: 'session-compat-reuse',
    personaId: '',
    presetId: '',
    presetIds: [],
  });
  runtime.isEnabled = () => true;
  runtime.worker = null;
  let iframeScripts = [];
  runtime.iframeRuntime = {
    syncScripts: list => {
      iframeScripts = list;
    },
  };
  const NativeFunction = globalThis.Function;
  let compileCount = 0;
  globalThis.Function = function (...args) {
    compileCount += 1;
    return NativeFunction(...args);
  };
  try {
    await runtime.syncScripts();
  } finally {
    globalThis.Function = NativeFunction;
  }
  assert.equal(compileCount, 0);
  assert.equal(iframeScripts.length, 1);
  assert.equal(iframeScripts[0].compatibility.marker, 'stored-result');
  console.log('ok - runtime sync reuses stored compatibility without recompiling top-level await');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  runtime.context = { sessionId: 'deleted-old-session' };
  runtime.chatStore = { getCurrent: () => 'new-session' };
  runtime.worker = null;
  runtime.iframeRuntime = null;
  const enabledSessionIds = [];
  const syncedSessionIds = [];
  runtime.isEnabled = (sessionId) => {
    enabledSessionIds.push(sessionId);
    return true;
  };
  runtime.syncContext = async ({ sessionId } = {}) => {
    syncedSessionIds.push(sessionId);
  };

  await runtime.dispatchEvent('session.changed', {
    oldSession: { id: 'deleted-old-session' },
    newSession: { id: 'new-session' },
  }, {
    sessionId: 'new-session',
  });

  assert.deepEqual(enabledSessionIds, ['new-session']);
  assert.deepEqual(syncedSessionIds, ['new-session']);
  console.log('ok - script runtime lifecycle dispatch uses the explicit target session context');
}

{
  let fetchCalls = 0;
  const { sandbox, messages } = createWorkerHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, text: async () => 'remote script' };
    },
  });
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: { sessionId: 's1' },
      scripts: [{
        id: 'network-disabled',
        name: 'network disabled',
        enabled: true,
        content: `fetch('https://example.com/remote.js').catch(() => {});`,
      }],
    },
  });
  await flushTimers();
  assert.equal(fetchCalls, 0, 'disabled script network permission must block direct fetch');
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'log' && /脚本网络已禁用/.test(JSON.stringify(msg.params || {}))),
    true,
    'blocked fetch should emit an explicit script warning',
  );
  const allowed = createWorkerHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, text: async () => 'remote script' };
    },
  });
  await allowed.sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: true },
      context: { sessionId: 's1' },
      scripts: [{
        id: 'network-enabled',
        name: 'network enabled',
        enabled: true,
        content: `fetch('https://example.com/remote.js').catch(() => {});`,
      }],
    },
  });
  await flushTimers();
  assert.equal(fetchCalls, 1, 'enabled script network permission should preserve direct fetch');
  console.log('ok - worker blocks direct fetch when script network permission is disabled');
}

{
  let fetchCalls = 0;
  const disabled = createWorkerHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true };
    },
  });
  const networkScript = `
    try { const xhr = new XMLHttpRequest(); xhr.open('GET', 'https://example.com/xhr'); xhr.send(); } catch {}
    try { const XhrCtor = XMLHttpRequest.prototype.constructor; const xhr = new XhrCtor(); xhr.open('GET', 'https://example.com/xhr-constructor'); xhr.send(); } catch {}
    try { new WebSocket('wss://example.com/socket'); } catch {}
    try { const SocketCtor = WebSocket.prototype.constructor; new SocketCtor('wss://example.com/socket-constructor'); } catch {}
    try { importScripts('https://example.com/import.js'); } catch {}
    try { new Function("return fetch('https://example.com/function')")().catch(() => {}); } catch {}
  `;
  await disabled.sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: { sessionId: 's1' },
      scripts: [{ id: 'network-surfaces-disabled', name: 'network surfaces disabled', enabled: true, content: networkScript }],
    },
  });
  await flushTimers();
  assert.deepEqual(disabled.networkCalls, { xhr: 0, webSocket: 0, importScripts: 0 });
  assert.equal(fetchCalls, 0);

  const allowed = createWorkerHarness({
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true };
    },
  });
  await allowed.sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: true },
      context: { sessionId: 's1' },
      scripts: [{ id: 'network-surfaces-enabled', name: 'network surfaces enabled', enabled: true, content: networkScript }],
    },
  });
  await flushTimers();
  assert.deepEqual(allowed.networkCalls, { xhr: 2, webSocket: 2, importScripts: 1 });
  assert.equal(fetchCalls, 1);
  console.log('ok - worker network permission covers XHR, WebSocket, importScripts, and new Function fetch');
}

{
  // 禁网只拦远程：blob:/app: 本地导入不应触发网络拒绝警告（与 runImport 语义一致）
  const localImports = [];
  const { sandbox, messages } = createWorkerHarness({
    importScriptsImpl: (url) => { localImports.push(String(url || '')); },
  });
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: { sessionId: 's1' },
      scripts: [{
        id: 'local-import-net-off',
        name: 'local import net off',
        enabled: true,
        content: `
          try { importScripts('blob:http://127.0.0.1:1430/local-part'); } catch {}
          try { importScripts('https://example.com/remote.js'); } catch {}
        `,
      }],
    },
  });
  await flushTimers();
  assert.equal(localImports.includes('blob:http://127.0.0.1:1430/local-part'), true, 'local blob import must pass through when network disabled');
  assert.equal(localImports.some(url => /example\.com/.test(url)), false, 'remote import must not reach native importScripts when network disabled');
  const deniedLogs = messages
    .filter(msg => msg.type === 'rpc' && msg.method === 'log' && /脚本网络已禁用/.test(JSON.stringify(msg.params || {})))
    .map(msg => JSON.stringify(msg.params));
  assert.equal(deniedLogs.length, 1, 'only the remote import should be denied');
  assert.equal(/example\.com/.test(deniedLogs[0]), true, 'denied warning should reference the remote url');
  assert.equal(/blob:/.test(deniedLogs[0]), false, 'local blob import must not be reported as network denial');
  console.log('ok - worker network permission blocks only remote importScripts and spares local blob imports');
}

{
  const { sandbox, networkCalls } = createWorkerHarness();
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: true },
      context: { sessionId: 's1' },
      scripts: [{
        id: 'capture-network-constructors',
        name: 'capture network constructors',
        enabled: true,
        content: `
          const xhr = new XMLHttpRequest();
          self.savedXhrCtor = xhr.constructor;
          const socket = new WebSocket('wss://example.com/capture');
          self.savedSocketCtor = socket.constructor;
          socket.close();
        `,
      }],
    },
  });
  assert.deepEqual(networkCalls, { xhr: 0, webSocket: 1, importScripts: 0 });
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: { sessionId: 's1' },
      scripts: [{
        id: 'reuse-network-constructors',
        name: 'reuse network constructors',
        enabled: true,
        content: `
          try { const xhr = new self.savedXhrCtor(); xhr.open('GET', 'https://example.com/reuse'); xhr.send(); } catch {}
          try { new self.savedSocketCtor('wss://example.com/reuse'); } catch {}
        `,
      }],
    },
  });
  assert.deepEqual(networkCalls, { xhr: 0, webSocket: 1, importScripts: 0 });
  console.log('ok - native network constructors captured while allowed remain permission-aware after revocation');
}

{
  const { sandbox, messages } = createWorkerHarness({
    chatMessages: [{ id: 'm1', role: 'assistant', raw: 'must stay hidden' }],
  });
  const script = `
    if (getChatMessages().length !== 0) throw new Error('read-disabled script received messages');
    setVariables({ blockedWrite: true });
    if (getVariables().blockedWrite === true) throw new Error('modify-disabled script changed its optimistic snapshot');
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowReadMessages: false, allowModifyVariables: false, allowNetwork: false },
      context: {
        sessionId: 's1',
        chat: [{ id: 'leaked', role: 'assistant', raw: 'cached secret' }],
        variables: { mood: 'calm' },
        localVariables: { mood: 'calm' },
      },
      scripts: [{ id: 'permissions-disabled', name: 'permissions disabled', enabled: true, content: script }],
    },
  });
  await flushTimers();
  assert.equal(messages.some(msg => msg.type === 'rpc' && msg.method === 'chat.getMessages'), false);
  assert.equal(messages.some(msg => msg.type === 'rpc' && msg.method === 'variables.patch'), false);
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'log' && /脚本权限已禁用/.test(JSON.stringify(msg.params || {}))),
    true,
  );
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'log' && msg.params?.args?.[0] === '脚本加载失败'),
    false,
  );
  console.log('ok - disabled read/modify permissions degrade explicitly without leaking or optimistic writes');
}

{
  const combinations = [];
  for (const allowReadMessages of [false, true]) {
    for (const allowModifyVariables of [false, true]) {
      for (const allowNetwork of [false, true]) {
        combinations.push({ allowReadMessages, allowModifyVariables, allowNetwork });
      }
    }
  }
  for (const combination of combinations) {
    let fetchCalls = 0;
    const { sandbox, messages } = createWorkerHarness({
      chatMessages: [{ id: 'm1', role: 'assistant', raw: 'visible only with read permission' }],
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true };
      },
    });
    const script = `
      (async () => {
        let networkAllowed = false;
        try { await fetch('https://example.com/matrix'); networkAllowed = true; } catch {}
        const messageCount = getChatMessages().length;
        setVariables({ matrixWrite: true });
        const variableChanged = getVariables().matrixWrite === true;
        await api.log('PERMISSION_MATRIX', JSON.stringify({ networkAllowed, messageCount, variableChanged }));
      })();
    `;
    await sandbox.self.onmessage({
      data: {
        type: 'sync',
        settings: combination,
        context: {
          sessionId: 'matrix',
          variables: {},
          localVariables: {},
          chat: [{ id: 'cached', role: 'assistant', raw: 'cached secret' }],
        },
        scripts: [{ id: 'permission-matrix', name: 'permission matrix', enabled: true, content: script }],
      },
    });
    await flushTimers();
    await flushTimers();
    const log = messages.find(msg => msg.type === 'rpc' && msg.method === 'log' && msg.params?.args?.[0] === 'PERMISSION_MATRIX');
    const observed = JSON.parse(log?.params?.args?.[1] || '{}');
    assert.equal(observed.networkAllowed, combination.allowNetwork, JSON.stringify(combination));
    assert.equal(observed.messageCount, combination.allowReadMessages ? 1 : 0, JSON.stringify(combination));
    assert.equal(observed.variableChanged, combination.allowModifyVariables, JSON.stringify(combination));
    assert.equal(fetchCalls, combination.allowNetwork ? 1 : 0, JSON.stringify(combination));
    assert.equal(
      messages.some(msg => msg.type === 'rpc' && msg.method === 'variables.patch'),
      combination.allowModifyVariables,
      JSON.stringify(combination),
    );
  }
  console.log('ok - all eight read/modify/network permission combinations remain independent');
}

{
  const { sandbox, messages } = createWorkerHarness();
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowReadMessages: true, allowModifyVariables: true, allowNetwork: false },
      context: { sessionId: 's1' },
      scripts: [
        {
          id: 'throws',
          name: 'throws',
          enabled: true,
          content: `on('compat.crash', () => { throw new Error('intentional script failure'); });`,
        },
        {
          id: 'survives',
          name: 'survives',
          enabled: true,
          content: `on('compat.crash', payload => {
            if (payload.script.id !== 'survives' || typeof payload.api.getvar !== 'function') throw new Error('missing handler runtime fields');
            return { ...payload, survivorRan: true };
          });`,
        },
      ],
    },
  });
  await sandbox.self.onmessage({
    data: { type: 'dispatch', id: 'crash-isolation', event: 'compat.crash', payload: { initial: true }, allowMutate: true },
  });
  await flushTimers();
  const result = messages.find(msg => msg.type === 'dispatch_result' && msg.id === 'crash-isolation');
  assert.equal(result?.result?.initial, true);
  assert.equal(result?.result?.survivorRan, true);
  assert.equal(result?.result?.script, undefined);
  assert.equal(result?.result?.api, undefined);
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'log' && /intentional script failure/.test(JSON.stringify(msg.params || {}))),
    true,
  );
  console.log('ok - one throwing script does not prevent sibling scripts from handling the same event');
}

{
  const { sandbox, messages } = createWorkerHarness({
    chatMessages: [
      { id: 'm1', role: 'user', raw: 'hello' },
      { id: 'm2', role: 'assistant', rawOriginal: 'world with update block', rawSource: 'world', raw: 'world' },
    ],
    characterRegexes: [
      { id: 'r1', script_name: 'desktop', enabled: true, __chatappSetId: 'set-1' },
    ],
  });
  const script = `
    if (getLastMessageId() !== 1) throw new Error('missing last message id');
    const messages = getChatMessages(1, { include_swipes: false });
    if (messages[0]?.message !== 'world' || messages[0]?.role !== 'assistant') throw new Error('missing tavern message shape');
    const latestAssistant = getChatMessages(-1, { role: 'assistant' });
    if (latestAssistant.length !== 1 || latestAssistant[0]?.message !== 'world') throw new Error('missing negative latest-message selector');
    const assistantRange = getChatMessages('0-{{lastMessageId}}', { role: 'assistant' });
    if (assistantRange.length !== 1 || assistantRange[0]?.message_id !== 1) throw new Error('missing range macro or role filter');
    if (tavern_events.GENERATION_ENDED !== 'message.after_receive') throw new Error('missing generation event alias');
    if (tavern_events.CHARACTER_MESSAGE_RENDERED !== 'message.after_render') throw new Error('missing render event alias');
    const regexes = getTavernRegexes({ scope: 'character' });
    if (regexes[0]?.script_name !== 'desktop' || regexes[0]?.enabled !== true) throw new Error('missing character regexes');
    regexes[0].enabled = false;
    replaceTavernRegexes(regexes, { scope: 'character' });
    setChatMessages([{ message_id: 1, message: 'world\\nmarker' }], { refresh: 'affected' });
    replaceScriptButtons(getScriptId(), [{ name: 'Switch', visible: true }]);
    eventOnButton('Switch', () => document.getElementById('chatapp-script-buttons-tavern-api')?.setAttribute('data-button-clicked', '1'));
    eventOn(tavern_events.GENERATION_ENDED, () => {});
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: { sessionId: 's1' },
      scripts: [{ id: 'tavern-api', name: 'tavern api', enabled: true, content: script }],
    },
  });
  await flushTimers();
  assert.equal(messages.some(msg => msg.type === 'listener_add' && msg.event === 'message.after_receive'), true);
  assert.equal(messages.some(msg => msg.type === 'rpc' && msg.method === 'chat.setMessages'), true);
  assert.equal(messages.some(msg => msg.type === 'rpc' && msg.method === 'regex.replaceCharacter'), true);
  const firstUpdate = messages.filter(msg => msg.type === 'ui_update').at(-1);
  assert.ok(firstUpdate, 'missing script button ui update');
  const html = firstUpdate.payload.roots.join('');
  assert.match(html, />Switch</);
  const nodeId = html.match(/<button[^>]*data-chatapp-virtual-node-id="([^"]+)"/)?.[1];
  assert.ok(nodeId, 'missing script button node id');
  await sandbox.self.onmessage({
    data: { type: 'ui_event', nodeId, eventType: 'click', event: { bubbles: true, cancelable: true } },
  });
  await flushTimers();
  const clicked = messages.filter(msg => msg.type === 'ui_update').at(-1)?.payload?.roots?.join('') || '';
  assert.match(clicked, /data-button-clicked="1"/);
  console.log('ok - script runtime exposes TavernHelper message, regex, event, and script-button contracts');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    const localVars = getVariables();
    const globalVars = getVariables({ type: 'global' });
    const presetVars = getVariables({ type: 'preset' });
    const characterVars = getVariables({ type: 'character' });
    if (localVars.mood !== 'calm') throw new Error('missing local variables');
    if (globalVars.globalMood !== 'shared') throw new Error('missing global variables');
    if (presetVars.tagFixerPreset !== 'preset-only') throw new Error('missing preset variables');
    if (characterVars.cardSetting !== 'character-only') throw new Error('missing character variables');
    if (getAllVariables().stat_data.mood !== 'calm') throw new Error('missing variable snapshot');
    setVariables({ tagFixerPreset: 'updated' }, { type: 'preset' });
    setVariables({ cardSetting: 'updated' }, { type: 'character' });
    if (getVariables({ type: 'preset' }).tagFixerPreset !== 'updated') throw new Error('preset variable snapshot did not update');
    if (getVariables({ type: 'character' }).cardSetting !== 'updated') throw new Error('character variable snapshot did not update');
    localStorage.setItem('compat-key', 'compat-value');
    if (localStorage.getItem('compat-key') !== 'compat-value') throw new Error('missing localStorage shim');
    const node = document.createElement('section');
    if (node.ownerDocument !== document) throw new Error('missing ownerDocument shim');
    node.setAttribute('data-test-node', '1');
    node.dataset.directValue = 'ok';
    document.body.appendChild(node);
    if (!document.body.contains(node)) throw new Error('missing document tree shim');
    if (document.querySelector('section[data-test-node="1"]') !== node) throw new Error('missing document querySelector shim');
    if (document.querySelector('section[data-direct-value="ok"]') !== node) throw new Error('missing dataset selector shim');
    if (document.querySelector('#missing-node') !== null) throw new Error('querySelector should return null for missing nodes');
    node.innerHTML = '<div class="inner"><span data-role="label">hello</span></div>';
    if (node.querySelector('.inner [data-role="label"]')?.textContent !== 'hello') throw new Error('missing innerHTML parser shim');
    const escapeNode = document.createElement('div');
    escapeNode.textContent = '<safe>';
    if (escapeNode.innerHTML !== '&lt;safe&gt;') throw new Error('missing textContent html escaping shim');
    node.style.left = '12px';
    node.style.setProperty('--orb-menu-max-height', '420px');
    node.style.setProperty('background-color', 'red');
    if (node.style.left !== '12px') throw new Error('missing direct style property shim');
    if (node.style.getPropertyValue('--orb-menu-max-height') !== '420px') throw new Error('missing custom style property shim');
    if (node.style.backgroundColor !== 'red') throw new Error('missing hyphenated style property shim');
    if (!node.style.cssText.includes('--orb-menu-max-height: 420px;')) throw new Error('missing cssText style serialization');
    if (node.style.removeProperty('--orb-menu-max-height') !== '420px') throw new Error('missing style removeProperty shim');
    if (node.style.getPropertyValue('--orb-menu-max-height') !== '') throw new Error('style removeProperty did not clear value');
    node.style.left = 'NaNpx';
    if (node.style.left === 'NaNpx') throw new Error('style shim should reject invalid NaN lengths');
    node.style.cssText = 'top: 16px; --orb-details-max-height: 240px;';
    if (node.style.top !== '16px') throw new Error('missing cssText parsing for normal property');
    if (node.style.getPropertyValue('--orb-details-max-height') !== '240px') throw new Error('missing cssText parsing for custom property');
    let windowEventSeen = false;
    window.addEventListener('chatapp-test', () => { windowEventSeen = true; });
    window.dispatchEvent(new Event('chatapp-test'));
    if (!windowEventSeen) throw new Error('missing window event target shim');
    const delegateRoot = document.createElement('div');
    const delegateButton = document.createElement('button');
    let delegatedClickSeen = false;
    delegateRoot.appendChild(delegateButton);
    document.body.appendChild(delegateRoot);
    delegateRoot.addEventListener('click', event => {
      if (event.target === delegateButton && event.currentTarget === delegateRoot) delegatedClickSeen = true;
    });
    delegateButton.click();
    if (!delegatedClickSeen) throw new Error('missing DOM event bubbling shim');
    toastr.info('compat toast');
    window.parent.toastr.warning('compat parent toast');
    const missingNode = document.createElement('div');
    missingNode.id = 'missing-node';
    document.body.appendChild(missingNode);
    missingNode.addEventListener('click', () => {});
    missingNode.setAttribute('data-ready', '1');
    missingNode.removeAttribute('data-ready');
    if (missingNode.hasAttribute('data-ready')) throw new Error('missing removeAttribute shim');
    const promptList = document.querySelector('#completion_prompt_manager_list');
    if (!promptList) throw new Error('missing virtual prompt manager');
    const promptRow = promptList.querySelector('li[data-pm-identifier="rule"]');
    if (!promptRow) throw new Error('missing virtual prompt row');
    if (!promptRow.classList.contains('completion_prompt_manager_prompt_disabled')) throw new Error('missing virtual prompt disabled state');
    const promptName = promptRow.querySelector('[data-pm-name]');
    if (promptName?.getAttribute('data-pm-name') !== 'Rule') throw new Error('missing virtual prompt name');
    promptRow.querySelector('.prompt-manager-toggle-action').click();
    if (promptRow.classList.contains('completion_prompt_manager_prompt_disabled')) throw new Error('virtual prompt toggle did not update local state');
    const presetRegexNames = Array.from(document.querySelectorAll('#saved_preset_scripts .regex_script_name')).map(node => node.textContent);
    if (!presetRegexNames.includes('TG-版本标记 V3.0.5')) throw new Error('missing virtual preset regex rows');
    const pwin = window.parent || window;
    pwin.$(document).off('keydown').on('keydown', () => {});
    const settingsRoot = document.createElement('div');
    settingsRoot.id = 'settings-root';
    document.body.appendChild(settingsRoot);
    const $root = $('#settings-root');
    const $created = $('<button class="created-btn">go</button>');
    if ($created.get(0)?.textContent !== 'go') throw new Error('missing jquery html creation shim');
    $root.html('<div>settings</div>').append('<span class="appended">tail</span>').prepend('<b class="prepended">head</b>');
    if ($root.find('.appended').text() !== 'tail') throw new Error('missing jquery append html shim');
    if ($root.find('.prepended').text() !== 'head') throw new Error('missing jquery prepend html shim');
    $root.empty();
    if ($root.html() !== '') throw new Error('missing jquery-like html shim');
    $root[0].scrollHeight = 42;
    if ($root.scrollTop($root[0].scrollHeight).scrollTop() !== 42) throw new Error('missing jquery-like scrollTop shim');
    if ($root.scrollLeft(7).scrollLeft() !== 7) throw new Error('missing jquery-like scrollLeft shim');
    if (errorCatched(() => 7)() !== 7) throw new Error('missing errorCatched shim');
    if (!Context || Context.stat_data.mood !== 'calm') throw new Error('missing Context shim');
    if (!powerUserSettings || typeof powerUserSettings !== 'object') throw new Error('missing powerUserSettings shim');
    if (replaceVariables('m={{mood}} g={{globalMood}}') !== 'm=calm g=shared') throw new Error('missing replaceVariables shim');
    if (TavernHelper.getVariables().mood !== 'calm') throw new Error('missing TavernHelper bridge');
    if (getCurrentCharacterName() !== 'Alice') throw new Error('missing character name shim');
    if (getGlobalWorldbookNames()[0] !== 'World') throw new Error('missing global worldbook names shim');
    const charBooks = getCharWorldbookNames('current');
    if (charBooks.primary !== 'World' || charBooks.additional[0] !== 'Extra') throw new Error('missing character worldbook shim');
    if (getChatWorldbookName('current') !== 'World') throw new Error('missing chat worldbook shim');
    if (getPreset('in_use').prompts[0].name !== 'Rule') throw new Error('missing getPreset shim');
    if (!isPresetPlaceholderPrompt({ placeholder: true })) throw new Error('missing placeholder helper shim');
    if (!isPresetSystemPrompt({ role: 'system' })) throw new Error('missing system prompt helper shim');
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { childList: true, subtree: true });
    observer.disconnect();
    if (!Array.isArray(observer.takeRecords())) throw new Error('missing MutationObserver shim');
    const frameId = requestAnimationFrame(() => {});
    cancelAnimationFrame(frameId);
    const stContext = SillyTavern.getContext();
    if (stContext.world_names[0] !== 'World') throw new Error('missing SillyTavern context worldbooks');
    if (typeof stContext.eventSource.on !== 'function') throw new Error('missing SillyTavern event source');
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: {
        sessionId: 's1',
        variables: { mood: 'calm' },
        localVariables: { mood: 'calm' },
        globalVariables: { globalMood: 'shared' },
        presetVariables: { tagFixerPreset: 'preset-only' },
        characterVariables: { cardSetting: 'character-only' },
        personaName: 'Alice',
        worldId: 'World',
        worldIds: ['World', 'Extra'],
        worldbookNames: ['World', 'Extra'],
        activePreset: {
          name: 'Preset',
          prompts: [{ id: 'rule', name: 'Rule', content: 'content', enabled: true, role: 'system' }],
          prompt_order: [{ character_id: 100001, order: [{ identifier: 'rule', enabled: false }] }],
          prompts_unused: [],
        },
        presetRegexes: [
          { id: 'preset-regex-1', script_name: 'TG-版本标记 V3.0.5', enabled: false },
        ],
      },
      scripts: [{ id: 'compat', name: 'compat', enabled: true, content: script }],
    },
  });
  assert.equal(messages.some(msg => msg.type === 'sync_done'), true);
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'log' && msg.params?.args?.[0] === '脚本加载失败'),
    false,
  );
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'preset.setPromptEnabled' && msg.params?.identifier === 'rule' && msg.params?.enabled === true),
    true,
  );
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'variables.patch' && msg.params?.options?.scope === 'preset' && msg.params?.patch?.tagFixerPreset === 'updated'),
    true,
  );
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'variables.patch' && msg.params?.options?.scope === 'character' && msg.params?.patch?.cardSetting === 'updated'),
    true,
  );
  console.log('ok - script runtime worker exposes legacy browser and variable globals before script load');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    const ctx = SillyTavern.getContext();
    if (typeof ctx.saveSettingsDebounced !== 'function') throw new Error('missing context saveSettingsDebounced');
    ctx.chatCompletionSettings.temperature = 0.25;
    ctx.chatCompletionSettings.prompts[0].content = 'updated prompt';
    ctx.saveSettingsDebounced();
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: {
        sessionId: 's1',
        openaiPresetId: 'preset-openai',
        chatCompletionSettings: { temperature: 0.7 },
        activePreset: {
          id: 'preset-openai',
          name: 'Preset',
          prompts: [{ identifier: 'rule', content: 'original prompt', enabled: true, role: 'system' }],
          prompt_order: [],
        },
      },
      scripts: [{ id: 'preset-save', name: 'preset save', enabled: true, content: script }],
    },
  });
  await flushTimers();
  const saveCall = messages.find(msg => msg.type === 'rpc' && msg.method === 'preset.saveChatCompletionSettings');
  assert.ok(saveCall, 'context saveSettingsDebounced must persist the mutated preset settings');
  assert.equal(saveCall.params.presetId, 'preset-openai');
  assert.equal(saveCall.params.settings.temperature, 0.25);
  assert.equal(saveCall.params.settings.prompts[0].content, 'updated prompt');
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'log' && /脚本加载失败/.test(JSON.stringify(msg.params || {}))),
    false,
  );
  console.log('ok - worker context saveSettingsDebounced forwards mutated completion settings');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    if (typeof generateRaw !== 'function') throw new Error('missing generateRaw');
    generateRaw({
      should_silence: true,
      ordered_prompts: [
        { role: 'system', content: 'repair format' },
        { role: 'user', content: 'raw text' },
      ],
      custom_api: {
        apiurl: 'https://llm.example/v1',
        source: 'openai',
        key: 'test-key',
        model: 'small-model',
        temperature: 0,
        max_tokens: 65000,
      },
    });
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: true },
      context: { sessionId: 's1' },
      scripts: [{ id: 'generate-raw', name: 'generate raw', enabled: true, content: script }],
    },
  });
  await flushTimers();
  const generateCall = messages.find(msg => msg.type === 'rpc' && msg.method === 'generation.generateRaw');
  assert.ok(generateCall, 'generateRaw must forward its compatibility payload');
  assert.equal(generateCall.params.config.custom_api.apiurl, 'https://llm.example/v1');
  assert.equal(generateCall.params.config.ordered_prompts[1].content, 'raw text');
  assert.equal(
    messages.some(msg => msg.type === 'rpc' && msg.method === 'log' && /脚本加载失败/.test(JSON.stringify(msg.params || {}))),
    false,
  );
  console.log('ok - worker exposes generateRaw and forwards role prompts plus custom API settings');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    if (window.innerWidth !== 777 || window.innerHeight !== 555) throw new Error('missing viewport globals');
    if (!window.visualViewport || window.visualViewport.width !== 777) throw new Error('missing visualViewport shim');
    const style = document.createElement('style');
    style.textContent = '.floating-box { position: fixed; right: 12px; bottom: 12px; }';
    document.head.appendChild(style);
    const internal = document.createElement('div');
    internal.setAttribute('data-chatapp-virtual', 'internal-test');
    internal.textContent = 'hidden adapter';
    document.body.appendChild(internal);
    const root = document.createElement('div');
    root.className = 'floating-box';
    root.textContent = 'open';
    root.addEventListener('click', event => {
      const rect = root.getBoundingClientRect();
      root.setAttribute('data-clicked', String(event.clientX));
      root.setAttribute('data-rect', rect.left + ',' + rect.top + ',' + rect.width + ',' + root.offsetHeight);
      root.setAttribute('data-style-read', root.getAttribute('style'));
      root.textContent = 'clicked';
    });
    document.addEventListener('mousemove', event => {
      root.setAttribute('data-doc-move', event.clientX + ',' + window.innerWidth);
    });
    document.addEventListener('mouseup', event => {
      root.setAttribute('data-doc-up', event.clientY + ',' + window.innerHeight);
    });
    window.addEventListener('resize', () => {
      root.setAttribute('data-resize', window.innerWidth + 'x' + window.innerHeight);
    });
    root.style.left = '12px';
    document.body.appendChild(root);
    const details = document.createElement('details');
    details.id = 'native-details';
    details.setAttribute('open', '');
    const summary = document.createElement('summary');
    summary.textContent = 'section';
    details.appendChild(summary);
    document.body.appendChild(details);
    const htmlRoot = document.createElement('div');
    htmlRoot.id = 'html-mounted-widget';
    htmlRoot.textContent = 'html mounted';
    document.documentElement.appendChild(htmlRoot);
  `;

  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: {
        allowNetwork: false,
        viewport: { innerWidth: 777, innerHeight: 555, devicePixelRatio: 2 },
      },
      context: { sessionId: 's1' },
      scripts: [{ id: 'ui-compat', name: 'ui compat', enabled: true, content: script }],
    },
  });
  await flushTimers();

  const firstUpdate = messages.filter(msg => msg.type === 'ui_update').at(-1);
  assert.ok(firstUpdate, 'missing worker ui update');
  assert.equal(firstUpdate.payload.styles.some(css => css.includes('.floating-box')), true);
  const initialHtml = firstUpdate.payload.roots.join('');
  assert.match(initialHtml, /data-chatapp-virtual-node-id="/);
  assert.match(initialHtml, /data-chatapp-has-ui-listener="1"/);
  assert.match(initialHtml, /html-mounted-widget/);
  assert.equal(initialHtml.includes('hidden adapter'), false);
  const nodeId = initialHtml.match(/data-chatapp-virtual-node-id="([^"]+)"/)?.[1];
  assert.ok(nodeId, 'missing mirrored node id');
  const detailsNodeId = initialHtml.match(/<details[^>]*data-chatapp-virtual-node-id="([^"]+)"/)?.[1];
  assert.ok(detailsNodeId, 'missing mirrored details node id');

  await sandbox.self.onmessage({
    data: {
      type: 'ui_layout',
      viewport: { innerWidth: 900, innerHeight: 600, devicePixelRatio: 1.5 },
      items: [{
        nodeId,
        left: 9,
        top: 10,
        right: 57,
        bottom: 59,
        width: 48,
        height: 49,
        clientWidth: 48,
        clientHeight: 49,
      }],
    },
  });
  await sandbox.self.onmessage({
    data: {
      type: 'ui_event',
      nodeId,
      eventType: 'click',
      event: { clientX: 42, bubbles: true, cancelable: true },
    },
  });
  await sandbox.self.onmessage({
    data: {
      type: 'ui_event',
      nodeId: detailsNodeId,
      eventType: 'toggle',
      nativeStateRevision: 1,
      event: { open: false, bubbles: false, cancelable: false },
    },
  });
  await sandbox.self.onmessage({
    data: {
      type: 'ui_event',
      targetType: 'document',
      eventType: 'mousemove',
      event: { clientX: 88, clientY: 99, bubbles: true, cancelable: true },
    },
  });
  await sandbox.self.onmessage({
    data: {
      type: 'ui_event',
      targetType: 'document',
      eventType: 'mouseup',
      event: { clientX: 88, clientY: 101, bubbles: true, cancelable: true },
    },
  });
  await sandbox.self.onmessage({
    data: {
      type: 'ui_viewport',
      eventType: 'resize',
      viewport: { innerWidth: 901, innerHeight: 601, devicePixelRatio: 1.5 },
    },
  });
  await flushTimers();

  const clickedUpdate = messages.filter(msg => msg.type === 'ui_update').at(-1);
  const clickedHtml = clickedUpdate.payload.roots.join('');
  assert.match(clickedHtml, /data-clicked="42"/);
  assert.match(clickedHtml, /data-rect="9,10,48,49"/);
  assert.match(clickedHtml, /data-style-read="left: 12px;"/);
  assert.match(clickedHtml, /data-doc-move="88,900"/);
  assert.match(clickedHtml, /data-doc-up="101,600"/);
  assert.match(clickedHtml, /data-resize="901x601"/);
  assert.match(clickedHtml, />clicked</);
  assert.doesNotMatch(clickedHtml, /<details[^>]*\sopen(?:=|\s|>)/, 'native details state should sync back into the worker tree');
  assert.equal(clickedUpdate.nativeStateRevision, 1, 'worker UI updates should acknowledge native state revisions');
  assert.equal(
    messages.some(msg => msg.type === 'ui_layout_interest' && msg.nodeIds?.includes(nodeId)),
    true,
    'getBoundingClientRect should subscribe the queried virtual node to future layout syncs',
  );
  console.log('ok - script runtime mirrors virtual DOM UI generically and relays UI events');
}

{
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    const root = document.createElement('div');
    document.body.appendChild(root);
    for (let index = 0; index < 30; index += 1) {
      root.innerHTML = '<button id="registry-button">pass ' + index + '</button>';
    }
    document.getElementById('registry-button').addEventListener('click', function () {
      document.getElementById('registry-button').textContent = 'clicked';
      document.querySelector('#registry-button');
      document.body.querySelectorAll('button[id="registry-button"]');
    });
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      context: { sessionId: 'registry-test' },
      scripts: [{ id: 'registry-test', name: 'registry test', enabled: true, content: script }],
    },
  });
  await flushTimers();
  const update = messages.filter(msg => msg.type === 'ui_update').at(-1);
  const html = update?.payload?.roots?.join('') || '';
  const buttonNodeId = html.match(/<button[^>]*data-chatapp-virtual-node-id="([^"]+)"/)?.[1];
  assert.ok(buttonNodeId, 'missing final registry test button');
  assert.ok(
    Number(update?.perf?.registeredNodeCount || 0) < 25,
    'worker event registry should only retain the current reachable virtual tree',
  );
  await sandbox.self.onmessage({
    data: {
      type: 'ui_event',
      nodeId: buttonNodeId,
      eventType: 'click',
      traceStartedAt: 123,
      event: { bubbles: true, cancelable: true },
    },
  });
  await flushTimers();
  const eventPerf = messages.filter(msg => msg.type === 'ui_event_perf').at(-1);
  assert.equal(eventPerf?.eventType, 'click');
  assert.equal(eventPerf?.traceStartedAt, 123);
  assert.ok(Number(eventPerf?.workerDispatchMs) >= 0);
  assert.ok(Number(eventPerf?.workerTotalMs) >= Number(eventPerf?.workerDispatchMs));
  assert.ok(Number(eventPerf?.selectorIndexHits) >= 3, 'getElementById and exact id/attribute selectors should use the connected-node index');
  console.log('ok - worker prunes detached virtual nodes and reports discrete UI event timing');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  const posted = [];
  runtime.worker = { postMessage: message => posted.push(message) };
  runtime.uiRoot = {};
  runtime.uiShadow = {};
  runtime.postWorkerUiLayout = () => {};
  runtime.scheduleWorkerUiLayoutSync = () => {};

  runtime.beginUiPointerSequence({ type: 'pointerdown', clientX: 10, clientY: 10 });
  runtime.beginUiPointerSequence({ type: 'mousedown', clientX: 10, clientY: 10 });
  assert.equal(runtime.uiCaptureActive, true);

  runtime.endUiPointerSequence({ type: 'pointerup' });
  assert.equal(runtime.uiCaptureActive, true, 'pointerup must not end the paired mouse capture before mouseup');

  const move = {
    type: 'mousemove',
    buttons: 1,
    clientX: 20,
    clientY: 20,
    composedPath: () => [],
  };
  runtime.handleGlobalUiEvent(move);
  runtime.handleGlobalUiEvent(move);
  assert.equal(
    posted.filter(message => message.type === 'ui_event' && message.eventType === 'mousemove').length,
    1,
    'the same document/window event must only be relayed once',
  );

  const mouseup = {
    type: 'mouseup',
    buttons: 0,
    clientX: 20,
    clientY: 20,
    composedPath: () => [],
  };
  runtime.handleGlobalUiEvent(mouseup);
  assert.equal(runtime.uiCaptureActive, false);
  assert.equal(
    posted.filter(message => message.type === 'ui_event' && message.eventType === 'mouseup').length,
    1,
    'mouseup outside the shadow UI must still reach the worker after pointerup',
  );

  const css = runtime.getWorkerUiBaseCss();
  assert.match(css, /\.chatapp-script-ui-surface\s*>\s*\[data-chatapp-virtual-node-id\]/);
  assert.doesNotMatch(
    css,
    /\[data-chatapp-has-ui-listener="1"\][^{]*\{\s*pointer-events:\s*auto/,
    'host CSS must not override a script ancestor pointer-events:none contract',
  );
  assert.equal(runtime.collectUiEventPayload({ type: 'toggle' }, { open: false }).open, false);
  console.log('ok - main script UI host preserves mouse terminal events, dedupes globals, and respects hidden ancestors');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  const rendered = [];
  runtime.renderWorkerUi = payload => rendered.push(payload);
  runtime.pendingWorkerUiPayload = { roots: ['pending'] };

  runtime.beginUiPointerSequence({ type: 'pointerdown', clientX: 1, clientY: 1 });
  runtime.beginUiPointerSequence({ type: 'mousedown', clientX: 1, clientY: 1 });
  runtime.endUiPointerSequence({ type: 'pointerup' });
  assert.equal(rendered.length, 0, 'pointerup must not rebuild UI before the paired mouseup/click');
  runtime.endUiPointerSequence({ type: 'mouseup' });
  assert.equal(rendered.length, 0, 'mouseup must retain the click guard until click');
  runtime.releaseUiClickGuardForClick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(rendered.length, 1, 'the newest deferred UI should render once after click');
  console.log('ok - script UI render remains deferred for the full pointer/mouse click sequence');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  const rendered = [];
  runtime.renderWorkerUi = (payload, perf) => rendered.push({ payload, perf });
  runtime.handleWorkerMessage({ type: 'ui_update', payload: { roots: ['first'] }, perf: { workerBuildMs: 3 } });
  runtime.handleWorkerMessage({ type: 'ui_update', payload: { roots: ['second'] }, perf: { workerBuildMs: 5 } });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(rendered.length, 1, 'same-frame worker UI updates should render only once');
  assert.deepEqual(rendered[0].payload.roots, ['second']);
  assert.equal(rendered[0].perf.workerBuildMs, 5);

  for (let index = 0; index < 80; index += 1) {
    runtime.recordUiPerformanceSample?.({ type: 'layout', durationMs: index, nodeCount: index + 1 });
  }
  const perf = runtime.getUiPerformanceSnapshot?.();
  assert.ok(perf, 'missing script UI performance snapshot');
  assert.ok(perf.samples.length <= 60, 'performance samples must remain bounded');
  assert.equal(perf.latest.layout.nodeCount, 80);
  console.log('ok - script UI host coalesces render frames and exposes bounded performance metrics');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  const posted = [];
  runtime.worker = { postMessage: message => posted.push(message) };
  const traceStartedAt = runtime.getUiPerformanceNow();
  runtime.handleWorkerMessage({
    type: 'ui_event_perf',
    eventType: 'click',
    traceStartedAt,
    workerDispatchMs: 4,
    workerTotalMs: 7,
  });
  assert.equal(runtime.getUiPerformanceSnapshot().latest.event.eventType, 'click');
  assert.equal(runtime.getUiPerformanceSnapshot().latest.event.workerDispatchMs, 4);
  runtime.processRpc = async () => ({ ok: true });
  await runtime.handleRpc({ id: 'rpc-perf', method: 'chat.getMessages', params: {} });
  assert.deepEqual(posted.at(-1), { type: 'rpc_result', id: 'rpc-perf', result: { ok: true } });
  assert.equal(runtime.getUiPerformanceSnapshot().latest.rpc.method, 'chat.getMessages');
  console.log('ok - main script UI diagnostics record event roundtrip and RPC processing timing');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  let removed = false;
  runtime.uiRoot = { remove: () => { removed = true; } };
  runtime.uiShadow = { replaceChildren: () => {} };
  runtime.handleWorkerMessage({ type: 'ui_reset' });
  assert.equal(removed, true, 'worker sync reset must remove the previous script UI surface');
  assert.equal(runtime.uiRoot, null);
  assert.equal(runtime.uiShadow, null);
  console.log('ok - worker UI reset removes stale preset surfaces before the next script set mounts');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  const details = { open: true, getAttribute: () => '9' };
  const surface = { querySelectorAll: () => [details] };
  runtime.uiNativeStatePending.set('9', { revision: 2, open: false });
  runtime.applyPendingNativeUiState(surface, 1);
  assert.equal(details.open, false, 'stale worker payload must not overwrite newer native details state');
  assert.equal(runtime.uiNativeStatePending.has('9'), true);
  details.open = false;
  runtime.applyPendingNativeUiState(surface, 2);
  assert.equal(runtime.uiNativeStatePending.has('9'), false, 'acknowledged native state should leave the pending barrier');
  const field = { value: 'stale', checked: false, getAttribute: () => 'input' };
  runtime.uiNativeStatePending.set('input', { revision: 4, value: 'newer typing', checked: true });
  runtime.applyPendingNativeUiState({ querySelectorAll: () => [field] }, 3);
  assert.equal(field.value, 'newer typing');
  assert.equal(field.checked, true);
  runtime.applyPendingNativeUiState({ querySelectorAll: () => [field] }, 4);
  assert.equal(runtime.uiNativeStatePending.has('input'), false);
  console.log('ok - native details state barrier survives stale full-tree worker renders until acknowledged');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  const rectReads = [];
  const makeNode = id => ({
    getAttribute: name => (name === 'data-chatapp-virtual-node-id' ? id : ''),
    getBoundingClientRect: () => {
      rectReads.push(id);
      return { left: Number(id), top: 0, right: Number(id) + 10, bottom: 10, width: 10, height: 10 };
    },
    clientWidth: 10,
    clientHeight: 10,
    scrollWidth: 10,
    scrollHeight: 10,
  });
  const nodes = [makeNode('1'), makeNode('2'), makeNode('3')];
  runtime.uiShadow = { querySelectorAll: () => nodes };
  runtime.handleWorkerMessage({ type: 'ui_layout_interest', nodeIds: ['2'] });
  const incremental = runtime.collectWorkerUiLayout();
  assert.deepEqual(incremental.map(item => item.nodeId), ['2']);
  assert.deepEqual(rectReads, ['2']);
  rectReads.length = 0;
  const full = runtime.collectWorkerUiLayout({ full: true });
  assert.deepEqual(full.map(item => item.nodeId), ['1', '2', '3']);
  assert.deepEqual(rectReads, ['1', '2', '3']);
  console.log('ok - script UI layout sync keeps first full snapshot and filters later snapshots by queried node interest');
}

{
  const scopedVariables = {
    character: { 'character-1': { cardSetting: 'character-only' } },
    preset: { 'preset-openai': { tagFixerPreset: 'preset-only', nested: { enabled: false } } },
  };
  const scopeWrites = [];
  const runtime = new ScriptRuntime({
    ready: Promise.resolve(),
    getScripts: () => [],
    getScopeVariables: (scope, scopeId) => structuredClone(scopedVariables[scope]?.[scopeId] || {}),
    setScopeVariables: async (scope, scopeId, variables) => {
      await new Promise(resolve => setTimeout(resolve, 1));
      scopedVariables[scope][scopeId] = structuredClone(variables);
      scopeWrites.push([scope, scopeId, structuredClone(variables)]);
      return true;
    },
  });
  const calls = [];
  runtime.chatStore = {
    getCurrent: () => 's1',
    getDraft: () => 'draft text',
    listVariables: () => ({ mood: 'calm', nested: { hp: 10 } }),
    listGlobalVariables: () => ({ globalMood: 'shared' }),
    getMessages: () => [{ id: 'm1', role: 'assistant', message: 'hello' }],
    getVariable: key => ({ nested: { hp: 10 } }[key]),
    setVariable: (key, value, sessionId) => {
      calls.push(['set', key, value, sessionId]);
      return true;
    },
    deleteVariable: (key, sessionId) => {
      calls.push(['delete', key, sessionId]);
      return true;
    },
  };
  runtime.contactsStore = { getContact: () => ({ id: 's1', name: 'Milla' }) };
  const liveWorld = {
    entries: [{ id: 'entry-1', comment: 'Entry', content: 'world content', disable: false, constant: false }],
  };
  const worldSaveCalls = [];
  runtime.bridge = {
    isSharedVariableSession: () => false,
    currentWorldId: 'World',
    currentWorldIds: ['World', 'Extra'],
    worldStore: {
      list: () => ['World', 'Extra'],
      load: id => (id === 'World' ? liveWorld : null),
    },
    getWorldInfo: async id => (id === 'World' ? structuredClone(liveWorld) : null),
    saveWorldInfo: async (id, data) => {
      worldSaveCalls.push([id, structuredClone(data)]);
      return { ok: true };
    },
  };
  runtime.presets = {
    getActive: type => (type === 'openai' ? {
      name: 'Preset',
      model: 'gpt-test',
      temperature: 0.4,
      prompts: [{ id: 'rule', name: 'Rule', content: 'content', enabled: true, role: 'system' }],
      prompt_order: [{ character_id: 100001, order: [{ identifier: 'rule', enabled: true }] }],
    } : {}),
    getActiveId: type => (type === 'openai' ? 'preset-openai' : ''),
  };
  runtime.getEffectivePersona = () => ({ id: 'character-1', name: 'Alice' });
  runtime.getActiveUserProfile = () => ({ id: 'user-1', name: 'Bob' });
  const context = runtime.buildContext('s1');
  runtime.context = { ...runtime.context, ...context };
  assert.deepEqual(context.variables, { mood: 'calm', nested: { hp: 10 } });
  assert.deepEqual(context.globalVariables, { globalMood: 'shared' });
  assert.deepEqual(context.presetVariables, { tagFixerPreset: 'preset-only', nested: { enabled: false } });
  assert.deepEqual(context.characterVariables, { cardSetting: 'character-only' });
  assert.deepEqual(context.worldbookNames, ['World', 'Extra']);
  assert.equal(context.activePreset.prompts[0].name, 'Rule');
  assert.equal(context.chatCompletionSettings.temperature, 0.4);
  assert.equal(context.userName, 'Bob');
  assert.equal(context.characterName, 'Milla');
  assert.equal(context.model, 'gpt-test');
  assert.equal(context.input, 'draft text');

  const rpContext = runtime.buildContext('rp:character-1');
  assert.equal(rpContext.uiMode, 'rp');
  assert.equal(rpContext.userName, 'Bob');
  assert.equal(rpContext.characterName, 'Alice');

  const iframeHtml = runtime.iframeRuntime.buildIframeHtml(
    { id: 'esm-compat', name: 'esm compat', data: { scriptSetting: true }, content: 'export default function() {}' },
    context,
    { allowNetwork: false },
  );
  assert.match(iframeHtml, /window\.powerUserSettings/);
  assert.match(iframeHtml, /window\.tavern_events/);
  assert.match(iframeHtml, /bridgeCompatGlobalsToHost/);
  assert.match(iframeHtml, /window\.substituteParams/);
  assert.match(iframeHtml, /window\.substituteParamsExtended/);
  assert.match(iframeHtml, /window\.substitudeMacros/);
  assert.doesNotMatch(iframeHtml, /substitudeMacros\s*=\s*\(text\)\s*=>\s*String\(text/);
  assert.match(iframeHtml, /default-src 'none'; script-src 'unsafe-inline' blob:;/);
  assert.doesNotMatch(iframeHtml, /connect-src https:/);
  assert.match(iframeHtml, /script_variables/);
  const classicInlineScripts = Array.from(iframeHtml.matchAll(/<script(?![^>]*type="module")[^>]*>([\s\S]*?)<\/script>/g))
    .map(match => match[1])
    .filter(Boolean);
  assert.equal(classicInlineScripts.length, 1);
  assert.doesNotThrow(() => new Function(classicInlineScripts[0]));

  const full = await runtime.processRpc('context.getContext', { sessionId: 's1' });
  assert.equal(full.stat_data.mood, 'calm');
  assert.equal(full.global_variables.globalMood, 'shared');
  assert.equal(full.chat.length, 1);
  assert.equal(full.worldbookNames[0], 'World');

  const worldbook = await runtime.processRpc('world.getBook', { world: 'World', sessionId: 's1' });
  assert.equal(worldbook[0].uid, 'entry-1');
  assert.equal(worldbook[0].name, 'Entry');
  assert.equal(worldbook[0].enabled, true);

  assert.equal(await runtime.processRpc('world.activate', {
    world: 'World',
    title: 'Entry',
    force: true,
    sessionId: 's1',
  }), true);
  assert.equal(liveWorld.entries[0].constant, false, 'world.activate must not mutate the live store before CAS');
  assert.equal(worldSaveCalls.length, 1);
  assert.equal(worldSaveCalls[0][0], 'World');
  assert.equal(worldSaveCalls[0][1].entries[0].constant, true);

  const preset = await runtime.processRpc('context.getPreset', { name: 'in_use', sessionId: 's1' });
  assert.equal(preset.prompts[0].name, 'Rule');

  assert.equal(await runtime.processRpc('variables.delete', { key: 'mood', sessionId: 's1' }), true);
  assert.equal(await runtime.processRpc('variables.delete', { key: 'nested.hp', sessionId: 's1' }), true);
  assert.equal(await runtime.processRpc('variables.patch', {
    patch: { firstSetting: 1, secondSetting: 2 },
    options: { scope: 'preset' },
    sessionId: 's1',
  }), true);
  assert.equal(await runtime.processRpc('variables.set', {
    key: 'nested.enabled',
    value: true,
    options: { scope: 'preset' },
    sessionId: 's1',
  }), true);
  assert.equal(await runtime.processRpc('variables.delete', {
    key: 'cardSetting',
    options: { scope: 'character' },
    sessionId: 's1',
  }), true);
  assert.deepEqual(calls, [
    ['delete', 'mood', 's1'],
    ['set', 'nested', {}, 's1'],
  ]);
  assert.deepEqual(scopeWrites, [
    ['preset', 'preset-openai', {
      tagFixerPreset: 'preset-only',
      nested: { enabled: false },
      firstSetting: 1,
      secondSetting: 2,
    }],
    ['preset', 'preset-openai', {
      tagFixerPreset: 'preset-only',
      nested: { enabled: true },
      firstSetting: 1,
      secondSetting: 2,
    }],
    ['character', 'character-1', {}],
  ]);
  await Promise.all([
    runtime.processRpc('variables.patch', {
      patch: { concurrentFirst: true },
      options: { scope: 'preset' },
      sessionId: 's1',
    }),
    runtime.processRpc('variables.patch', {
      patch: { concurrentSecond: true },
      options: { scope: 'preset' },
      sessionId: 's1',
    }),
  ]);
  assert.equal(scopedVariables.preset['preset-openai'].concurrentFirst, true);
  assert.equal(scopedVariables.preset['preset-openai'].concurrentSecond, true);

  const writeCountBeforePause = calls.length;
  runtime.bridge.isVariableRuntimeEnabled = () => false;
  const pausedContext = runtime.buildContext('s1');
  assert.deepEqual(pausedContext.variables, {});
  assert.deepEqual(pausedContext.localVariables, {});
  assert.deepEqual(pausedContext.globalVariables, {});
  assert.deepEqual(pausedContext.characterVariables, {});
  assert.deepEqual(pausedContext.presetVariables, {});
  assert.equal(pausedContext.variableRuntimeEnabled, false);
  assert.equal(await runtime.processRpc('variables.get', { key: 'nested.hp', sessionId: 's1' }), undefined);
  assert.equal(await runtime.processRpc('variables.set', { key: 'blocked', value: true, sessionId: 's1' }), false);
  assert.equal(await runtime.processRpc('variables.inc', { key: 'gold', delta: 10, sessionId: 's1' }), undefined);
  assert.equal(await runtime.processRpc('variables.dec', { key: 'gold', delta: 10, sessionId: 's1' }), undefined);
  assert.equal(calls.length, writeCountBeforePause);
  const pausedFull = await runtime.processRpc('context.getContext', { sessionId: 's1' });
  assert.deepEqual(pausedFull.stat_data, {});
  assert.deepEqual(pausedFull.local_variables, {});
  assert.deepEqual(pausedFull.global_variables, {});
  assert.equal(pausedFull.variableRuntimeEnabled, false);
  console.log('ok - script runtime context and variable RPC include snapshots and delete support');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  const trustedSource = { postMessage: () => {} };
  const untrustedSource = { postMessage: () => {} };
  const replies = [];
  trustedSource.postMessage = message => replies.push(message);
  runtime.iframeRuntime.windowMap.set(trustedSource, 'trusted-script');
  const rpcCalls = [];
  runtime.processRpc = async (method, params) => {
    rpcCalls.push([method, params]);
    return { ok: true };
  };

  await runtime.iframeRuntime.onMessage({
    source: untrustedSource,
    data: { type: 'script-iframe-rpc', id: 'untrusted', scriptId: 'trusted-script', method: 'chat.getMessages', params: {} },
  });
  await runtime.iframeRuntime.onMessage({
    source: trustedSource,
    data: { type: 'script-iframe-rpc', id: 'spoofed', scriptId: 'other-script', method: 'chat.getMessages', params: {} },
  });
  assert.deepEqual(rpcCalls, []);
  assert.deepEqual(replies, []);

  await runtime.iframeRuntime.onMessage({
    source: trustedSource,
    data: { type: 'script-iframe-rpc', id: 'trusted', scriptId: 'trusted-script', method: 'chat.getMessages', params: { sessionId: 's1' } },
  });
  assert.deepEqual(rpcCalls, [['chat.getMessages', { sessionId: 's1' }]]);
  assert.deepEqual(replies, [{ type: 'script-iframe-rpc-result', id: 'trusted', result: { ok: true } }]);
  console.log('ok - iframe RPC accepts only the registered contentWindow and matching script id');
}

{
  const originalSettings = appSettings.get();
  const variableWrites = [];
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  runtime.context = { sessionId: 'permission-session' };
  runtime.chatStore = {
    getCurrent: () => 'permission-session',
    getMessages: () => [{ id: 'm1', role: 'assistant', raw: 'secret' }],
    setVariable: (key, value, sessionId) => {
      variableWrites.push([key, value, sessionId]);
      return true;
    },
  };
  try {
    appSettings.update({ scriptAllowReadMessages: false, scriptAllowModifyVariables: false });
    await assert.rejects(
      runtime.processRpc('chat.getMessages', { sessionId: 'permission-session' }),
      /脚本权限已禁用：读取消息/,
    );
    await assert.rejects(
      runtime.processRpc('variables.set', { key: 'blocked', value: true, sessionId: 'permission-session' }),
      /脚本权限已禁用：修改变量/,
    );
    assert.deepEqual(variableWrites, []);

    appSettings.update({ scriptAllowReadMessages: true, scriptAllowModifyVariables: true });
    assert.equal((await runtime.processRpc('chat.getMessages', { sessionId: 'permission-session' })).length, 1);
    assert.equal(await runtime.processRpc('variables.set', {
      key: 'allowed',
      value: true,
      sessionId: 'permission-session',
    }), true);
    assert.deepEqual(variableWrites, [['allowed', true, 'permission-session']]);
  } finally {
    appSettings.update(originalSettings);
  }
  console.log('ok - main script RPC returns explicit permission errors and preserves allowed behavior');
}

{
  const presetData = {
    name: 'Preset',
    prompts: [{ identifier: 'rule', name: 'Rule', content: 'content', enabled: true, role: 'system' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'rule', enabled: true }] }],
  };
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  runtime.context = { sessionId: 's1', openaiPresetId: 'preset-openai' };
  const upserts = [];
  runtime.presets = {
    getResolvedActive: () => ({ presetId: 'preset-openai', preset: structuredClone(presetData) }),
    getActiveId: () => 'preset-openai',
    getActive: () => structuredClone(presetData),
    upsert: async (type, payload) => {
      upserts.push({ type, payload });
      return payload.id;
    },
  };
  const ok = await runtime.processRpc('preset.setPromptEnabled', {
    sessionId: 's1',
    identifier: 'rule',
    enabled: false,
  });

  assert.equal(ok, true);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].type, 'openai');
  assert.equal(upserts[0].payload.id, 'preset-openai');
  assert.equal(upserts[0].payload.makeActive, false);
  assert.equal(upserts[0].payload.data.prompts[0].enabled, false);
  assert.equal(upserts[0].payload.data.prompt_order[0].order[0].enabled, false);
  console.log('ok - script runtime controlled prompt manager RPC updates active openai preset without switching');
}

{
  const originalSettings = appSettings.get();
  let storedPreset = {
    name: 'Preset',
    temperature: 0.7,
    prompts: [{ identifier: 'rule', name: 'Rule', content: 'original', enabled: true, role: 'system' }],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'rule', enabled: true }] }],
  };
  const upserts = [];
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  runtime.context = { sessionId: 's1', openaiPresetId: 'preset-openai' };
  runtime.presets = {
    getResolvedActive: () => ({ presetId: 'preset-openai', preset: structuredClone(storedPreset) }),
    getResolvedActiveId: () => ({ presetId: 'preset-openai' }),
    getActiveId: () => 'preset-openai',
    getActive: () => structuredClone(storedPreset),
    upsert: async (type, payload) => {
      if (payload.data.temperature === 0.1) await new Promise(resolve => setTimeout(resolve, 10));
      upserts.push({ type, payload: structuredClone(payload) });
      storedPreset = structuredClone(payload.data);
      return payload.id;
    },
  };
  try {
    appSettings.update({ scriptAllowModifyVariables: true });
    await Promise.all([
      runtime.processRpc('preset.saveChatCompletionSettings', {
        sessionId: 's1',
        presetId: 'preset-openai',
        settings: { ...structuredClone(storedPreset), temperature: 0.1 },
      }),
      runtime.processRpc('preset.saveChatCompletionSettings', {
        sessionId: 's1',
        presetId: 'preset-openai',
        settings: {
          ...structuredClone(storedPreset),
          name: 'must not replace identity',
          apiKey: 'must-not-be-persisted',
          function_calling: false,
          temperature: 0.2,
          prompts: [{ identifier: 'rule', name: 'Rule', content: 'updated', enabled: true, role: 'system' }],
        },
      }),
    ]);
    assert.equal(upserts.length, 2);
    assert.equal(storedPreset.name, 'Preset');
    assert.equal(storedPreset.temperature, 0.2, 'later save must win even when an earlier write is slower');
    assert.equal(storedPreset.prompts[0].content, 'updated');
    assert.equal(Object.hasOwn(storedPreset, 'apiKey'), false);
    assert.equal(Object.hasOwn(storedPreset, 'function_calling'), false);

    const beforeMismatch = upserts.length;
    assert.equal(await runtime.processRpc('preset.saveChatCompletionSettings', {
      sessionId: 's1',
      presetId: 'another-preset',
      settings: { temperature: 0.9 },
    }), false);
    assert.equal(upserts.length, beforeMismatch, 'a script must not save through a stale/different preset id');

    appSettings.update({ scriptAllowModifyVariables: false });
    await assert.rejects(
      runtime.processRpc('preset.saveChatCompletionSettings', {
        sessionId: 's1',
        presetId: 'preset-openai',
        settings: { temperature: 0.9 },
      }),
      /脚本权限已禁用：修改变量/,
    );
  } finally {
    appSettings.update(originalSettings);
  }
  console.log('ok - preset settings RPC persists safe active-preset edits in call order and respects permissions');
}

{
  const originalSettings = appSettings.get();
  const calls = [];
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  runtime.context = { sessionId: 's1' };
  runtime.bridge = {
    backgroundChat: async (messages, options) => {
      calls.push({ messages, options });
      return 'fixed response';
    },
  };
  const params = {
    sessionId: 's1',
    config: {
      should_silence: true,
      ordered_prompts: [
        { role: 'system', content: 'repair format' },
        { role: 'user', content: 'raw text' },
      ],
      custom_api: {
        apiurl: 'https://llm.example/v1/chat/completions',
        source: 'openai',
        key: 'test-key',
        model: 'small-model',
        temperature: 0,
        max_tokens: 65000,
      },
    },
  };
  try {
    appSettings.update({ scriptAllowNetwork: false });
    await assert.rejects(
      runtime.processRpc('generation.generateRaw', params),
      /脚本权限已禁用：访问网络/,
    );
    assert.equal(calls.length, 0);

    appSettings.update({ scriptAllowNetwork: true });
    assert.equal(await runtime.processRpc('generation.generateRaw', params), 'fixed response');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].messages, [
      { role: 'system', content: 'repair format' },
      { role: 'user', content: 'raw text' },
    ]);
    assert.equal(calls[0].options.runtimeConfigOverride.provider, 'custom');
    assert.equal(calls[0].options.runtimeConfigOverride.baseUrl, 'https://llm.example/v1');
    assert.equal(calls[0].options.runtimeConfigOverride.apiKey, 'test-key');
    assert.equal(calls[0].options.runtimeConfigOverride.model, 'small-model');
    assert.equal(calls[0].options.runtimeConfigOverride.connectionMode, 'direct');
    assert.equal(calls[0].options.runtimeConfigOverride.proxyAuthToken, '');
    assert.equal(calls[0].options.temperature, 0);
    assert.equal(calls[0].options.max_tokens, 65000);

    const anonymousParams = structuredClone(params);
    delete anonymousParams.config.custom_api.key;
    assert.equal(await runtime.processRpc('generation.generateRaw', anonymousParams), 'fixed response');
    assert.equal(calls[1].options.runtimeConfigOverride.apiKey, '');
  } finally {
    appSettings.update(originalSettings);
  }
  console.log('ok - generateRaw RPC uses explicit role prompts, a transient custom API, and network permission');
}

{
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  runtime.isEnabled = () => true;
  runtime.context = { sessionId: 's1' };
  runtime.worker = {};
  runtime.syncContext = async () => {};
  let calls = 0;
  runtime.callWorker = async (_type, payload) => {
    calls += 1;
    return payload.payload;
  };

  await runtime.dispatchEvent('variable.changed', { sessionId: 's1', name: 'mood' });
  assert.equal(calls, 0);

  runtime.recordListener('variable.changed');
  await runtime.dispatchEvent('variable.changed', { sessionId: 's1', name: 'mood' });
  assert.equal(calls, 1);
  console.log('ok - script runtime skips variable changed dispatch when no script listens');
}

{
  // 缺陷 #1 修复：worker 端 setExtensionPrompt / injectPrompts 通过 RPC 到达主线程
  const { sandbox, messages } = createWorkerHarness();
  const script = `
    if (typeof SillyTavern.setExtensionPrompt !== 'function') throw new Error('missing SillyTavern.setExtensionPrompt');
    if (typeof SillyTavern.getContext().setExtensionPrompt !== 'function') throw new Error('missing getContext().setExtensionPrompt');
    if (typeof TavernHelper.injectPrompts !== 'function') throw new Error('missing TavernHelper.injectPrompts');
    if (typeof TavernHelper.uninjectPrompts !== 'function') throw new Error('missing TavernHelper.uninjectPrompts');
    SillyTavern.setExtensionPrompt('bubble_rules', '格式规则内容', 1, 2, false, 'system');
    TavernHelper.injectPrompts([{ id: 'fmt-1', content: '注入内容', position: 'in_chat', depth: 3, role: 'user' }]);
    TavernHelper.uninjectPrompts(['fmt-1']);
  `;
  await sandbox.self.onmessage({
    data: {
      type: 'sync',
      settings: { allowNetwork: false },
      context: { sessionId: 's1' },
      scripts: [{ id: 'sc-1', name: 'inject test', enabled: true, authorized: true, content: script }],
    },
  });
  await flushTimers();
  const rpcs = messages.filter(msg => msg.type === 'rpc');
  const setCall = rpcs.find(msg => msg.method === 'prompt.setExtensionPrompt');
  assert.ok(setCall, 'setExtensionPrompt rpc missing');
  assert.equal(setCall.params.key, 'bubble_rules');
  assert.equal(setCall.params.position, 'in_chat');
  assert.equal(setCall.params.depth, 2);
  const injectCall = rpcs.find(msg => msg.method === 'prompt.injectPrompts');
  assert.ok(injectCall, 'injectPrompts rpc missing');
  assert.equal(injectCall.params.injects[0].id, 'fmt-1');
  assert.equal(injectCall.params.injects[0].role, 'user');
  const uninjectCall = rpcs.find(msg => msg.method === 'prompt.uninjectPrompts');
  assert.ok(uninjectCall, 'uninjectPrompts rpc missing');
  const loadErrors = messages.filter(msg => msg.type === 'rpc' && msg.method === 'log' && /脚本加载失败/.test(JSON.stringify(msg.params || {})));
  assert.equal(loadErrors.length, 0, 'script should load without errors');
  console.log('ok - worker exposes setExtensionPrompt/injectPrompts and forwards RPC');
}

{
  // 缺陷 #1 修复：主线程注入表 upsert/删除/查询/sync 清空/isEnabled 门控
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  runtime.isEnabled = () => true;
  runtime.context = { sessionId: 's1' };

  await runtime.processRpc('prompt.setExtensionPrompt', { key: 'k1', value: '规则A', position: 'in_chat', depth: 2, role: 'system' });
  await runtime.processRpc('prompt.injectPrompts', { injects: [{ id: 'i1', content: '注入B', position: 'before_prompt', depth: 0, role: 'user' }] });
  let blocks = runtime.getScriptPromptInjections('s1');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].content, '规则A');
  assert.equal(blocks[0].position, 'in_chat');
  assert.equal(blocks[1].role, 'user');

  // 空 value = 删除；uninject 删除
  await runtime.processRpc('prompt.setExtensionPrompt', { key: 'k1', value: '' });
  await runtime.processRpc('prompt.uninjectPrompts', { ids: ['i1'] });
  assert.equal(runtime.getScriptPromptInjections('s1').length, 0);

  // 重新写入后：脚本禁用时不注入；sync 清空
  await runtime.processRpc('prompt.setExtensionPrompt', { key: 'k2', value: '规则C' });
  runtime.isEnabled = () => false;
  assert.equal(runtime.getScriptPromptInjections('s1').length, 0);
  runtime.isEnabled = () => true;
  assert.equal(runtime.getScriptPromptInjections('s1').length, 1);
  runtime.buildContext = () => ({ sessionId: 's1' });
  runtime.worker = null;
  await runtime.syncScripts();
  assert.equal(runtime.getScriptPromptInjections('s1').length, 0);
  console.log('ok - main thread script prompt injection table upsert/remove/gate/sync-clear');
}

{
  // 缺陷 #2 修复：预热期超时放宽、sync_done 结束预热、dispatch_error 选择性重启
  const runtime = new ScriptRuntime({ ready: Promise.resolve(), getScripts: () => [] });
  await runtime.ready;
  runtime.isEnabled = () => true;
  runtime.context = { sessionId: 's1' };
  // 预热期：timeout 放宽到 >=15000（用 fake worker 观察不触发 3s 超时）
  runtime.workerWarmingUp = true;
  const posted = [];
  runtime.worker = { postMessage: msg => posted.push(msg), terminate: () => {} };
  const slowCall = runtime.callWorker('dispatch', { event: 'test.slow', payload: {} }, 3000);
  let settled = false;
  slowCall.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(r => setTimeout(r, 3200));
  assert.equal(settled, false, 'warmup call should not timeout at 3s');
  // sync_done 结束预热
  runtime.handleWorkerMessage({ type: 'sync_done' });
  assert.equal(runtime.workerWarmingUp, false);
  // 手动 resolve 挂起的调用（模拟 worker 回复）
  runtime.handleWorkerMessage({ type: 'dispatch_result', id: posted[0].id, result: { ok: true } });
  await slowCall;

  // dispatch_error：普通错误不重启（其他 pending 不受殃及）
  let restarts = 0;
  runtime.restartWorker = () => { restarts += 1; };
  const callA = runtime.callWorker('dispatch', { event: 'a', payload: {} }, 3000);
  const callB = runtime.callWorker('dispatch', { event: 'b', payload: {} }, 3000);
  const idA = posted[1].id;
  runtime.handleWorkerMessage({ type: 'dispatch_error', id: idA, error: '某脚本抛出异常' });
  await assert.rejects(callA, /某脚本抛出异常/);
  assert.equal(restarts, 0, 'normal dispatch error must not restart worker');
  // 结果过大才重启
  const idB = posted[2].id;
  runtime.handleWorkerMessage({ type: 'dispatch_error', id: idB, error: '脚本结果过大' });
  await assert.rejects(callB, /脚本结果过大/);
  assert.equal(restarts, 1, 'oversized result should restart worker');

  // 卡死脚本不会回包时，主线程 watchdog 拒绝本次派发并重启隔离 worker。
  runtime.workerWarmingUp = false;
  const timedOut = runtime.callWorker('dispatch', { event: 'intentional.hang', payload: {} }, 20);
  await assert.rejects(timedOut, /script runtime timeout \(intentional\.hang, 20ms\)/);
  assert.equal(restarts, 2, 'dispatch timeout should restart the isolated worker');
  console.log('ok - warmup grace, sync_done clears warmup, dispatch_error restarts selectively');
}
