(async () => {
  const mod = await import(`/scripts/plugins/script-runtime.js?isolation-smoke=${Date.now()}`);
  const { PresetRequestTransport } = await import('/scripts/plugins/preset-request-transport.js');
  const source = mod.buildScriptRuntimeWorkerSourceForTests();
  const createWorker = () => {
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    return { worker: new Worker(url), url };
  };
  const destroyWorker = ({ worker, url }) => {
    try { worker.terminate(); } catch {}
    URL.revokeObjectURL(url);
  };

  const permissionEntry = createWorker();
  const permissionRpcMethods = [];
  let permissionProbe = null;
  const permissionDone = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('permission probe timeout')), 8000);
    permissionEntry.worker.onerror = event => {
      clearTimeout(timer);
      reject(new Error(event?.message || 'permission worker error'));
    };
    permissionEntry.worker.onmessage = event => {
      const msg = event.data || {};
      if (msg.type !== 'rpc') return;
      permissionRpcMethods.push(msg.method);
      if (msg.method === 'log' && msg.params?.args?.[0] === 'ISOLATION_PERMISSION_PROBE') {
        permissionProbe = JSON.parse(msg.params.args[1]);
        clearTimeout(timer);
        resolve();
      }
      permissionEntry.worker.postMessage({ type: 'rpc_result', id: msg.id, result: true });
    };
  });
  permissionEntry.worker.postMessage({
    type: 'sync',
    settings: { allowReadMessages: false, allowModifyVariables: false, allowNetwork: false },
    context: {
      sessionId: 'isolation-permission-smoke',
      chat: [{ id: 'secret', role: 'assistant', raw: 'must not leak' }],
      variables: { original: true },
      localVariables: { original: true },
      globalVariables: {},
    },
    scripts: [{
      id: 'permission-probe',
      name: 'permission probe',
      enabled: true,
      content: `
        (async () => {
          const result = {};
          try { new XMLHttpRequest(); result.xhr = 'open'; } catch (e) { result.xhr = String(e && e.message || e); }
          try { new XMLHttpRequest.prototype.constructor(); result.xhrCtor = 'open'; } catch (e) { result.xhrCtor = String(e && e.message || e); }
          try { new WebSocket('ws://127.0.0.1:9'); result.ws = 'open'; } catch (e) { result.ws = String(e && e.message || e); }
          try { importScripts('http://127.0.0.1:9/import.js'); result.importScripts = 'open'; } catch (e) { result.importScripts = String(e && e.message || e); }
          try { await new Function("return fetch('http://127.0.0.1:9/function')")(); result.functionFetch = 'open'; } catch (e) { result.functionFetch = String(e && e.message || e); }
          result.messageCount = getChatMessages().length;
          setVariables({ forbidden: true });
          result.variableChanged = getVariables().forbidden === true;
          await api.log('ISOLATION_PERMISSION_PROBE', JSON.stringify(result));
        })();
      `,
    }],
  });

  let permissionError = '';
  try {
    await permissionDone;
  } catch (error) {
    permissionError = String(error?.message || error);
  } finally {
    destroyWorker(permissionEntry);
  }

  const crashEntry = createWorker();
  const runtime = Object.create(mod.ScriptRuntime.prototype);
  runtime.worker = crashEntry.worker;
  runtime.workerWarmingUp = false;
  runtime.pending = new Map();
  runtime.seq = 0;
  runtime.listenerEvents = new Set();
  runtime.uiLayoutInterestIds = new Set();
  runtime.uiLayoutPendingIds = new Set();
  runtime.uiNativeStatePending = new Map();
  runtime.uiPerformanceSamples = [];
  // 与 ScriptRuntime 构造函数一致：handleWorkerMessage 每条消息都先交给它
  runtime.presetRequestTransport = new PresetRequestTransport({
    post: value => runtime.worker?.postMessage(value),
    onTimeout: () => runtime.restartWorker('preset request timeout'),
  });
  let restarted = false;
  runtime.restartWorker = () => {
    restarted = true;
    destroyWorker(crashEntry);
    runtime.worker = null;
  };
  const crashSyncDone = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('crash probe sync timeout')), 8000);
    crashEntry.worker.onerror = event => {
      clearTimeout(timer);
      reject(new Error(event?.message || 'crash worker error'));
    };
    crashEntry.worker.onmessage = event => {
      const msg = event.data || {};
      if (msg.type === 'rpc') {
        crashEntry.worker.postMessage({
          type: 'rpc_result',
          id: msg.id,
          result: msg.method === 'chat.getMessages' || msg.method === 'regex.getCharacter' ? [] : true,
        });
      } else {
        runtime.handleWorkerMessage(msg);
      }
      if (msg.type === 'sync_done') {
        clearTimeout(timer);
        resolve();
      }
    };
  });
  crashEntry.worker.postMessage({
    type: 'sync',
    settings: { allowReadMessages: true, allowModifyVariables: true, allowNetwork: false },
    context: { sessionId: 'isolation-crash-smoke' },
    scripts: [
      { id: 'throws', name: 'throws', enabled: true, content: `on('probe.throw', () => { throw new Error('intentional'); });` },
      { id: 'survives', name: 'survives', enabled: true, content: `on('probe.throw', payload => ({ initial: payload.initial, survivor: true }));` },
      { id: 'hangs', name: 'hangs', enabled: true, content: `on('probe.hang', () => { while (true) {} });` },
    ],
  });

  let siblingSurvived = false;
  let timeoutMessage = '';
  let crashError = '';
  try {
    await crashSyncDone;
    const result = await runtime.callWorker('dispatch', {
      event: 'probe.throw',
      payload: { initial: true },
      allowMutate: true,
    }, 1000);
    siblingSurvived = result?.survivor === true;
    try {
      await runtime.callWorker('dispatch', {
        event: 'probe.hang',
        payload: {},
        allowMutate: true,
      }, 150);
    } catch (error) {
      timeoutMessage = String(error?.message || error);
    }
  } catch (error) {
    crashError = String(error?.message || error);
  } finally {
    if (runtime.worker) destroyWorker(crashEntry);
  }

  const blocked = value => /脚本网络已禁用/.test(String(value || ''));
  const permissionPass = Boolean(
    !permissionError &&
    permissionProbe &&
    blocked(permissionProbe.xhr) &&
    blocked(permissionProbe.xhrCtor) &&
    blocked(permissionProbe.ws) &&
    blocked(permissionProbe.importScripts) &&
    blocked(permissionProbe.functionFetch) &&
    permissionProbe.messageCount === 0 &&
    permissionProbe.variableChanged === false &&
    !permissionRpcMethods.includes('chat.getMessages') &&
    !permissionRpcMethods.includes('variables.set') &&
    !permissionRpcMethods.includes('variables.patch')
  );
  const crashPass = !crashError && siblingSurvived && restarted && /script runtime timeout/.test(timeoutMessage);
  return {
    pass: permissionPass && crashPass && document.readyState === 'complete',
    detail: {
      permissionPass,
      permissionProbe,
      permissionRpcMethods,
      permissionError,
      crashPass,
      siblingSurvived,
      restarted,
      timeoutMessage,
      crashError,
      pageReadyState: document.readyState,
    },
  };
})()
