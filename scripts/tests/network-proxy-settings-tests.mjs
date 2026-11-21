import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  normalizeNetworkProxyMode,
  normalizeNetworkProxyUrl,
  resolveNetworkProxy,
  syncNetworkProxy,
} from '../../src/scripts/utils/network-proxy.js';

const storageMap = new Map();
globalThis.localStorage = {
  getItem: key => (storageMap.has(key) ? storageMap.get(key) : null),
  setItem: (key, value) => storageMap.set(key, String(value)),
  removeItem: key => storageMap.delete(key),
};
const { appSettings } = await import('../../src/scripts/storage/app-settings.js');

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('proxy addresses default to http and only allow http, https and socks5', () => {
  assert.equal(normalizeNetworkProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeNetworkProxyUrl(' socks5://127.0.0.1:7891 '), 'socks5://127.0.0.1:7891');
  assert.equal(normalizeNetworkProxyUrl('socks5h://proxy.lan:1080'), 'socks5h://proxy.lan:1080');
  assert.equal(normalizeNetworkProxyUrl('https://proxy.example.com:443'), 'https://proxy.example.com:443');
  assert.equal(normalizeNetworkProxyUrl(''), '');
  assert.equal(normalizeNetworkProxyUrl('ftp://127.0.0.1:21'), '');
  assert.equal(normalizeNetworkProxyUrl('http://'), '');
  assert.equal(normalizeNetworkProxyMode('DIRECT'), 'direct');
  assert.equal(normalizeNetworkProxyMode('vpn'), 'system');
});

test('custom mode without a usable address follows the system proxy', () => {
  assert.deepEqual(resolveNetworkProxy({}), { mode: 'system', url: null });
  assert.deepEqual(resolveNetworkProxy({ networkProxyMode: 'direct', networkProxyUrl: '127.0.0.1:7890' }), { mode: 'direct', url: null });
  assert.deepEqual(resolveNetworkProxy({ networkProxyMode: 'custom', networkProxyUrl: '127.0.0.1:7890' }), { mode: 'custom', url: 'http://127.0.0.1:7890' });
  assert.deepEqual(resolveNetworkProxy({ networkProxyMode: 'custom', networkProxyUrl: '' }), { mode: 'system', url: null });
  assert.deepEqual(resolveNetworkProxy({ networkProxyMode: 'custom', networkProxyUrl: 'ftp://x:1' }), { mode: 'system', url: null });
});

test('sync sends the resolved setting to the native command', async () => {
  const calls = [];
  await syncNetworkProxy(async (cmd, args) => { calls.push([cmd, args]); }, { networkProxyMode: 'custom', networkProxyUrl: 'socks5://127.0.0.1:7891' });
  assert.deepEqual(calls, [['set_network_proxy', { mode: 'custom', url: 'socks5://127.0.0.1:7891' }]]);
});

test('settings default to the system proxy and keep what the user typed', () => {
  assert.equal(appSettings.get().networkProxyMode, 'system');
  assert.equal(appSettings.get().networkProxyUrl, '');
  appSettings.update({ networkProxyMode: 'custom', networkProxyUrl: '  127.0.0.1:7890  ' });
  assert.equal(appSettings.get().networkProxyMode, 'custom');
  assert.equal(appSettings.get().networkProxyUrl, '127.0.0.1:7890');
  appSettings.update({ networkProxyMode: 'tun' });
  assert.equal(appSettings.get().networkProxyMode, 'system');
});

test('the app pushes the proxy setting at boot and the native side registers the command', () => {
  const app = read('src/scripts/ui/app.js');
  const hydrateAt = app.indexOf('await appSettings.hydrate(kvChannel)');
  const syncAt = app.indexOf('await syncNetworkProxy(safeInvoke, appSettings.get())');
  assert.ok(hydrateAt > 0 && syncAt > hydrateAt, 'sync right after settings hydrate');
  assert.match(read('src-tauri/src/lib.rs'), /network_proxy::set_network_proxy,/);
  const panel = read('src/scripts/ui/general-settings-panel.js');
  assert.match(panel, /syncNetworkProxy\(safeInvoke, settings\)/);
  for (const id of ['general-network-proxy-select', 'general-network-proxy-btn', 'general-network-proxy-url', 'general-network-proxy-status']) {
    assert.ok(panel.includes(`id="${id}"`), id);
  }
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
  }
}
if (failed) process.exitCode = 1;
