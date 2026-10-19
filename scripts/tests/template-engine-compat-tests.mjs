import assert from 'node:assert/strict';
import vm from 'node:vm';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {} };
globalThis.window = globalThis.window || {};

const { renderTemplateText, buildTemplateWorkerScriptForTests } = await import('../../src/scripts/plugins/template-engine.js');

const makeChatStore = (locals = {}) => ({
  listGlobalVariables: () => ({}),
  listVariables: () => locals,
  listInitialVariables: () => ({}),
});
const context = { user: { name: '旅人' }, character: { name: '艾琳' } };
const helperTemplate = [
  "<%_ const d = getMessageVar('stat_data', { defaults: {} }); _%>",
  "<%= _.get(d, '世界.位置', '无') %>|<%= _.isEmpty(_.omit({ a: 1 }, 'a')) %>",
  "|<%= Object.keys(_.mapValues({ x: 1, y: 2 }, v => v * 2)).join(',') %>|<%= _.cloneDeep({ k: [1] }).k[0] %>",
  "|<%= getMessageVar('stat_data.缺', { defaults: '默认' }) %>|<%= userName %>/<%= charName %>",
].join('');
const failingTemplate = "前文\n<%_ if (missingHelper()) { _%>坏段<%_ } _%>\n<% const ok = 3; %>中段<%= ok %>\n<%= undefinedName.x %>后文";

{
  // 常用函数：getMessageVar、精简版 _、userName/charName
  // 我们的会话变量本身就是 stat_data 的内容
  const locals = { 世界: { 位置: '城镇' } };
  const result = renderTemplateText(helperTemplate, { stage: 'generate', chatStore: makeChatStore(locals), sessionId: 's', context });
  assert.equal(result.error, null);
  assert.equal(result.text, '城镇|true|x,y|1|默认|旅人/艾琳');
  console.log('ok - template runtime provides getMessageVar, common lodash helpers, userName and charName');
}

{
  // 整段失败时只丢掉出错的块；前面块声明的变量后面仍能用；不会把 <% %> 原文送出
  const result = renderTemplateText(failingTemplate, { stage: 'generate', chatStore: makeChatStore({}), sessionId: 's', context });
  assert.ok(result.error, 'the failure is still reported');
  assert.doesNotMatch(result.text, /<%|坏段/);
  assert.match(result.text, /前文/);
  assert.match(result.text, /中段3/);
  assert.match(result.text, /后文/);
  console.log('ok - a failing template block is dropped while the other blocks still render');
}

{
  // worker 版本：同样的函数与退路；退路用全新状态重跑，变量不会被改两次
  const messages = [];
  const sandbox = {
    console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, ReferenceError,
    Map, Set, WeakMap, Promise, Symbol, structuredClone, setTimeout, clearTimeout,
    postMessage: msg => messages.push(msg),
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(buildTemplateWorkerScriptForTests(), sandbox, { filename: 'template-worker.js' });
  const render = (template, locals) => {
    messages.length = 0;
    sandbox.self.onmessage({ data: { type: 'render', id: 'r', payload: {
      template, globals: {}, locals, initials: {}, messageVars: {}, defines: {}, context,
      escapeTemplateOutput: false, variableRuntimeEnabled: true,
    } } });
    return messages.find(msg => msg.type === 'render_result')?.result || messages.find(msg => msg.type === 'render_error');
  };
  const helpers = render(helperTemplate, { 世界: { 位置: '城镇' } });
  assert.equal(helpers.error, '');
  assert.equal(helpers.text, '城镇|true|x,y|1|默认|旅人/艾琳');
  const fallback = render(`<% incvar('n', 1, { scope: 'local' }) %>A${failingTemplate}<%= getMessageVar('n') %>`, { n: 0 });
  assert.ok(fallback.error, 'worker still reports the failure');
  assert.doesNotMatch(fallback.text, /<%|坏段/);
  assert.match(fallback.text, /^A前文/);
  assert.match(fallback.text, /中段3/);
  assert.match(fallback.text, /后文1$/);
  assert.equal(fallback.locals.n, 1, 'the retry starts from fresh state, so the variable changes once');
  console.log('ok - template worker shares helpers and the per-block fallback without double side effects');
}

{
  // 走完整的非同步路径（假 Worker 跑真正的 worker 源码）：worker 按块重跑成功时，要用它的结果，而不是退回原文
  const { renderTemplateTextAsync } = await import('../../src/scripts/plugins/template-engine.js');
  const source = buildTemplateWorkerScriptForTests();
  globalThis.Worker = class FakeTemplateWorker {
    constructor() {
      const sandbox = {
        console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, TypeError, ReferenceError,
        Map, Set, WeakMap, Promise, Symbol, structuredClone, setTimeout, clearTimeout,
        postMessage: msg => queueMicrotask(() => this.onmessage?.({ data: msg })),
      };
      sandbox.self = sandbox;
      vm.createContext(sandbox);
      vm.runInContext(source, sandbox);
      this.sandbox = sandbox;
    }
    postMessage(msg) { queueMicrotask(() => this.sandbox.self.onmessage({ data: msg })); }
    terminate() {}
  };
  const result = await renderTemplateTextAsync(failingTemplate, {
    stage: 'generate', chatStore: makeChatStore({}), sessionId: 's', readOnly: true, context,
  });
  delete globalThis.Worker;
  assert.ok(result.error);
  assert.doesNotMatch(result.text, /<%|坏段/);
  assert.match(result.text, /中段3/);
  console.log('ok - async render keeps the worker per-block fallback output');
}
