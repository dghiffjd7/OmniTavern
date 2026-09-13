import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

// 用实际 WebView 的独立 Worker 运行，所有 RPC 均在测试内响应，不接入用户存储或模型。
const result = await evaluateInApp(String.raw`(async () => {
  const { buildScriptRuntimeWorkerSourceForTests } = await import('./scripts/plugins/script-runtime.js');
  const source = buildScriptRuntimeWorkerSourceForTests();
  const run = async (label) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    const messages = [];
    const errors = [];
    const writes = [];
    const waiters = new Set();
    const waitFor = (predicate) => {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve: (value) => { clearTimeout(timer); waiters.delete(waiter); resolve(value); } };
        const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('worker smoke timed out: ' + label + ' ' + JSON.stringify(errors))); }, 7000);
        waiter.cancel = () => { clearTimeout(timer); waiters.delete(waiter); };
        waiters.add(waiter);
      });
    };
    worker.onerror = (event) => {
      errors.push(event.message);
      event.preventDefault();
    };
    worker.onmessage = ({ data }) => {
      messages.push(data);
      for (const waiter of waiters) if (waiter.predicate(data)) waiter.resolve(data);
      if (data.type !== 'rpc') return;
      const read = data.method === 'chat.getMessages' || data.method === 'regex.getCharacter';
      if (!read && data.method !== 'log') writes.push(data.method);
      worker.postMessage({ type: 'rpc_result', id: data.id, result: read ? [] : true });
    };
    const script = [
      "const node = document.createElement('button');",
      "node.id = 'remove-attr-smoke-button';",
      "document.body.appendChild(node);",
      "const refresh = (phase) => {",
      "  $(node).attr('disabled', 'disabled').attr('data-pending', '1').attr('style', 'display: none; color: red');",
      "  setTimeout(() => {",
      "    $('#remove-attr-smoke-button').removeAttr('disabled data-pending style').css('display', 'block').text(phase);",
      "    api.log('remove-attr-done', phase, { disabled: node.hasAttribute('disabled'), pending: node.hasAttribute('data-pending'), display: node.style.display, color: node.style.color });",
      "  }, 0);",
      "};",
      "eventOn(tavern_events.CHAT_CHANGED, () => refresh('switch'));",
      "eventOn(tavern_events.GENERATION_ENDED, () => refresh('generate'));",
    ].join('\n');
    try {
      const synced = waitFor(data => data.type === 'sync_done');
      worker.postMessage({ type: 'sync', settings: { allowNetwork: false }, context: { sessionId: 'isolated-remove-attr-smoke' }, scripts: [{ id: 'remove-attr-smoke', enabled: true, name: 'removeAttr smoke', content: script }] });
      await synced;
      const phases = [];
      for (const [phase, event] of [['switch', 'chat.changed'], ['generate', 'message.after_receive']]) {
        const done = waitFor(data => data.type === 'rpc' && data.method === 'log' && data.params?.args?.[0] === 'remove-attr-done' && data.params.args[1] === phase);
        worker.postMessage({ type: 'dispatch', id: phase, event, payload: { sessionId: 'isolated-remove-attr-smoke' }, allowMutate: false });
        const log = await done;
        phases.push({ phase, ...log.params.args[2] });
      }
      await new Promise(resolve => setTimeout(resolve, 60));
      const html = messages.filter(data => data.type === 'ui_update').at(-1)?.payload?.roots?.join('') || '';
      const runtimeErrors = messages.filter(data => /error/.test(data.type || ''));
      return { label, phases, errors, writes, runtimeErrorCount: runtimeErrors.length, projected: html.includes('>generate</button>') && html.includes('display: block') && !/disabled=|data-pending=|color: red/.test(html) };
    } finally {
      worker.terminate();
      for (const waiter of waiters) waiter.cancel();
    }
  };
  return { appReady: Boolean(window.appBridge?.getChatUI?.()), runs: [await run('initial'), await run('fresh-worker')] };
})()`, { timeoutMs: 25000 });

assert.equal(result.appReady, true);
for (const run of result.runs) {
  assert.deepEqual(run.phases, [
    { phase: 'switch', disabled: false, pending: false, display: 'block', color: '' },
    { phase: 'generate', disabled: false, pending: false, display: 'block', color: '' },
  ]);
  assert.deepEqual(run.errors, []);
  assert.deepEqual(run.writes, []);
  assert.equal(run.runtimeErrorCount, 0);
  assert.equal(run.projected, true);
}
console.log(JSON.stringify(result, null, 2));
