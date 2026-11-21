import assert from 'node:assert/strict';
import test from 'node:test';

// plugin-store 经 logger 在载入时读 localStorage
globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const {
  normalizeInstallUrl, parseGithubRepoUrl, resolveInstallUrl, shouldRetryGithubMain, replaceGithubBranch,
  resolveDownloadedFileName, downloadPluginUrl, downloadPluginPackage, readPluginZip, isSillyTavernExtensionManifest,
} = await import('../../src/scripts/plugins/plugin-package.js');
const { getRiskyPermissions } = await import('../../src/scripts/plugins/plugin-permissions.js');

const okJson = data => ({ ok: true, json: async () => data });
const nativeOk = (text, headers = {}) => ({ ok: true, status: 200, body: Buffer.from(text).toString('base64'), headers });

test('GitHub links become direct ZIP links, using the API for latest releases and the default branch', async () => {
  assert.equal(normalizeInstallUrl('https://github.com/o/r/blob/main/dist/p.zip'), 'https://raw.githubusercontent.com/o/r/main/dist/p.zip');
  assert.equal(normalizeInstallUrl('not a url'), 'not a url');
  assert.deepEqual(parseGithubRepoUrl('https://github.com/o/r.git'), { owner: 'o', repo: 'r' });
  assert.deepEqual(parseGithubRepoUrl('https://github.com/o/r/tree/feature/x'), { owner: 'o', repo: 'r', branch: 'feature/x' });
  assert.deepEqual(parseGithubRepoUrl('https://github.com/o/r/releases/tag/v1.2'), { owner: 'o', repo: 'r', tag: 'v1.2' });
  assert.equal(parseGithubRepoUrl('https://example.com/o/r'), null);

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/releases/latest')) return okJson({ tag_name: 'v3.0.0' });
    if (url === 'https://api.github.com/repos/o/r') return okJson({ default_branch: 'trunk' });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  assert.equal(await resolveInstallUrl('https://github.com/o/r/releases/tag/v1.2', { fetchImpl }), 'https://codeload.github.com/o/r/zip/refs/tags/v1.2');
  assert.equal(await resolveInstallUrl('https://github.com/o/r/tree/dev', { fetchImpl }), 'https://codeload.github.com/o/r/zip/refs/heads/dev');
  assert.equal(await resolveInstallUrl('https://github.com/o/r/releases/latest', { fetchImpl }), 'https://codeload.github.com/o/r/zip/refs/tags/v3.0.0');
  assert.equal(await resolveInstallUrl('https://github.com/o/r', { fetchImpl }), 'https://codeload.github.com/o/r/zip/refs/heads/trunk');
  assert.equal(await resolveInstallUrl('https://github.com/x/y', { fetchImpl }), 'https://codeload.github.com/x/y/zip/refs/heads/main', 'falls back to main');
  assert.equal(await resolveInstallUrl('https://example.com/p.zip', { fetchImpl }), 'https://example.com/p.zip');
  assert.deepEqual(calls.find(call => call.url === 'https://api.github.com/repos/o/r').options, undefined, 'without a signal the API call is the same as before');

  const controller = new AbortController();
  controller.abort();
  const aborting = async (_url, options) => { if (options?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return okJson({}); };
  await assert.rejects(resolveInstallUrl('https://github.com/o/r', { fetchImpl: aborting, signal: controller.signal }), /aborted/);
});

test('downloads use the native request first and fall back to fetch when it is unavailable', async () => {
  const nativeCalls = [];
  const invoke = async (cmd, args) => { nativeCalls.push({ cmd, args }); return nativeOk('zip-bytes', { 'content-disposition': 'attachment; filename="plugin-v1.zip"' }); };
  const native = await downloadPluginUrl('https://example.com/dl?id=1', { invoke });
  assert.equal(native.ok, true);
  assert.equal(native.source, 'native');
  assert.equal(Buffer.from(native.bytes).toString(), 'zip-bytes');
  assert.equal(native.name, 'plugin-v1.zip');
  assert.equal(nativeCalls[0].cmd, 'http_request');
  assert.equal(nativeCalls[0].args.requestId, null, 'no signal: same request as the panel sent before');
  assert.equal(nativeCalls[0].args.responseBase64, true);

  const unavailable = async () => { throw new Error('Tauri invoke not available'); };
  const fetchImpl = async (url, options) => ({
    ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode('from-fetch').buffer,
    headers: new Map([['content-type', 'application/zip']]), url, options,
  });
  const fetched = await downloadPluginUrl('https://example.com/files/p.zip', { invoke: unavailable, fetchImpl });
  assert.equal(fetched.source, 'fetch');
  assert.equal(Buffer.from(fetched.bytes).toString(), 'from-fetch');
  assert.equal(fetched.name, 'p.zip');
  await assert.rejects(downloadPluginUrl('ftp://example.com/p.zip', { invoke }), /仅支持 http\/https 链接/);
  assert.equal(resolveDownloadedFileName('https://example.com/a/b.zip', { 'Content-Disposition': "attachment; filename*=UTF-8''%E6%8F%92%E4%BB%B6.zip" }), '插件.zip');
});

test('a missing main branch is retried on master, and failures keep the panel wording', async () => {
  const seen = [];
  const invoke = async (_cmd, args) => {
    seen.push(args.url);
    if (args.url.endsWith('/heads/master')) return nativeOk('master-zip');
    return { ok: false, status: 404, body: '', headers: {} };
  };
  const retries = [];
  const main = 'https://codeload.github.com/o/r/zip/refs/heads/main';
  const result = await downloadPluginPackage(main, { invoke, onRetry: url => retries.push(url) });
  assert.equal(result.url, 'https://codeload.github.com/o/r/zip/refs/heads/master');
  assert.equal(result.name, 'master');
  assert.equal(Buffer.from(result.bytes).toString(), 'master-zip');
  assert.deepEqual(retries, ['https://codeload.github.com/o/r/zip/refs/heads/master']);
  assert.equal(shouldRetryGithubMain('https://codeload.github.com/o/r/zip/refs/heads/dev', 404), false);
  assert.equal(replaceGithubBranch('https://codeload.github.com/o/r/zip/refs/heads/main', 'master'), 'https://codeload.github.com/o/r/zip/refs/heads/master');
  await assert.rejects(downloadPluginPackage('https://example.com/p.zip', { invoke }), /^Error: 下载失败 \(404\)$/);
  const bothMissing = async () => ({ ok: false, status: 403, body: '', headers: {} });
  await assert.rejects(downloadPluginPackage(main, { invoke: bothMissing }), /下载失败 \(403\)/);
});

test('aborting a download cancels the native request instead of falling back to fetch', async () => {
  const calls = [];
  const invoke = (cmd, args) => {
    calls.push({ cmd, args });
    return cmd === 'http_request' ? new Promise(() => {}) : Promise.resolve(null);
  };
  let fetched = false;
  const controller = new AbortController();
  const pending = downloadPluginPackage('https://example.com/p.zip', { invoke, fetchImpl: async () => { fetched = true; }, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error?.name === 'AbortError');
  assert.equal(fetched, false);
  assert.equal(calls[1].cmd, 'http_abort_request');
  assert.equal(calls[1].args.requestId, calls[0].args.requestId);
});

test('readPluginZip returns a validated manifest and code, with the panel error messages', async () => {
  const manifest = { id: 'a.b', name: 'AB', version: '1.0.0', apiVersion: '1', main: 'index.js', permissions: ['network'], mode: 'POWER' };
  const invokeWith = result => async (cmd, args) => {
    assert.equal(cmd, 'read_plugin_zip');
    assert.ok(Array.isArray(args.bytes));
    return result;
  };
  const parsed = await readPluginZip(new Uint8Array([80, 75]), { invoke: invokeWith({ manifestText: JSON.stringify(manifest), mainText: 'run();' }) });
  assert.equal(parsed.manifest.id, 'a.b');
  assert.equal(parsed.manifest.mode, 'power', 'manifest is normalized');
  assert.equal(parsed.code, 'run();');
  const same = [80, 75];
  let passed = null;
  await readPluginZip(same, { invoke: async (_cmd, args) => { passed = args.bytes; return { manifestText: JSON.stringify(manifest), mainText: 'x' }; } });
  assert.equal(passed, same, 'arrays from the panel are passed through unchanged');
  await assert.rejects(readPluginZip([1], { invoke: invokeWith({ manifestText: '', mainText: 'x' }) }), /^Error: ZIP 解析失败$/);
  await assert.rejects(readPluginZip([1], { invoke: invokeWith({ manifestText: JSON.stringify({ display_name: 'x', js: 'a.js' }), mainText: 'x' }) }), /SillyTavern/);
  await assert.rejects(readPluginZip([1], { invoke: invokeWith({ manifestText: JSON.stringify({ ...manifest, mode: 'safe' }), mainText: 'x' }) }), /manifest 校验失败：权限需要 power 模式: network/);
  assert.equal(isSillyTavernExtensionManifest({ display_name: 'x', id: 'y' }), false);
});

test('risky permissions are listed in manifest order', () => {
  assert.deepEqual(getRiskyPermissions({ permissions: ['chat.read', 'network', 'ui.inject'] }), ['network', 'ui.inject']);
  assert.deepEqual(getRiskyPermissions(null), []);
});
