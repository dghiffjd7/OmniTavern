import assert from 'node:assert/strict';

import {
  analyzeScriptCompatibility,
  buildScriptRuntimeErrorDiagnostic,
  classifyScriptRuntimeErrorCategory,
  extractMissingApiIdentifier,
  hasTopLevelAwait,
  resolveScriptCompatibility,
} from '../../src/scripts/import/script-capability-preflight.js';

const externalExtensionLoader = `
const root = window.parent ?? window;
async function getLatestVersion() {
  const response = await fetch('https://api.github.com/repos/example/extension/tags');
  return (await response.json())[0]?.name;
}
const version = await getLatestVersion();
const base = \`https://cdn.jsdelivr.net/gh/example/extension@\${version}\`;
const script = root.document.createElement('script');
script.type = 'module';
script.src = \`\${base}/dist/extension.bundle.js\`;
root.document.head.appendChild(script);
`;

const external = analyzeScriptCompatibility(externalExtensionLoader);
assert.equal(external.level, 'external_extension');
assert.equal(external.blocked, true);
assert.deepEqual(external.reasons, [
  'host_dom_access',
  'remote_asset_loader',
  'top_level_await',
]);
assert.deepEqual(external.signals, {
  topLevelAwait: true,
  hostDomAccess: true,
  remoteAssetLoader: true,
  nativeExtensionApi: false,
});
assert.equal(
  external.fingerprint,
  'external_extension:host_dom_access+remote_asset_loader+top_level_await',
);
assert.match(external.message, /SillyTavern 外部扩展/);
assert.match(external.message, /不会启用/);

const moduleOnly = analyzeScriptCompatibility('const value = await Promise.resolve(1);\nexport default value;');
assert.equal(moduleOnly.blocked, false);
assert.equal(moduleOnly.level, 'module');
assert.deepEqual(moduleOnly.reasons, ['top_level_await']);
assert.equal(hasTopLevelAwait(moduleOnly ? 'const value = await Promise.resolve(1);' : ''), true);
assert.equal(hasTopLevelAwait('async function load() { return await Promise.resolve(1); }'), false);

const hostDomOnly = analyzeScriptCompatibility(`
const host = window.parent;
const button = host.document.querySelector('#send_but');
button?.click();
`);
assert.equal(hostDomOnly.blocked, false);
assert.equal(hostDomOnly.level, 'sandbox_limited');
assert.deepEqual(hostDomOnly.reasons, ['host_dom_access']);

// saveSettingsDebounced 由 SillyTavern.getContext() 提供，不代表是外部扩展；
// 酒馆助手脚本经 context 呼叫（或解构）加上宿主 DOM，只算沙箱受限，不拦截
for (const source of [`
const topWin = window.top;
const panel = topWin.document.createElement('div');
function save() {
  const ctx = SillyTavern.getContext();
  if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
  else if (typeof topWin.saveSettingsDebounced === 'function') topWin.saveSettingsDebounced();
}
`, `
const { saveSettingsDebounced } = SillyTavern.getContext();
window.parent.document.body.append(document.createElement('div'));
saveSettingsDebounced();
`]) {
  const contextSave = analyzeScriptCompatibility(source);
  assert.equal(contextSave.blocked, false);
  assert.equal(contextSave.level, 'sandbox_limited');
  assert.equal(contextSave.signals.nativeExtensionApi, false);
}
const realExtension = analyzeScriptCompatibility(`
const root = window.parent;
root.document.body.append(panel);
extension_settings.myExt = { on: true };
`);
assert.equal(realExtension.blocked, true, 'extension_settings still marks an external extension');

const ordinaryNetworkScript = analyzeScriptCompatibility(`
async function loadData() {
  return fetch('https://example.com/data.json');
}
eventOn('ready', loadData);
`);
assert.equal(ordinaryNetworkScript.blocked, false);
assert.equal(ordinaryNetworkScript.level, 'standard');

const literalOnly = analyzeScriptCompatibility(`
const example = "window.parent.document.createElement('script'); node.src = 'https://example.com/a.js'; document.head.appendChild(node)";
// window.top.document.createElement('script')
`);
assert.equal(literalOnly.blocked, false);
assert.deepEqual(literalOnly.reasons, []);

const firstDiagnostic = buildScriptRuntimeErrorDiagnostic({
  scriptId: 'script-a',
  phase: 'load',
  error: 'await is only valid in async functions and the top level bodies of modules',
  compatibility: external,
});
const secondDiagnostic = buildScriptRuntimeErrorDiagnostic({
  scriptId: 'script-a',
  phase: 'load',
  error: 'await is only valid in async functions and the top level bodies of modules',
  compatibility: external,
});
assert.equal(firstDiagnostic.category, 'syntax_top_level_await');
assert.equal(
  firstDiagnostic.signature,
  'script-a:load:syntax_top_level_await:external_extension:host_dom_access+remote_asset_loader+top_level_await',
);
assert.equal(secondDiagnostic.signature, firstDiagnostic.signature);
assert.notEqual(
  buildScriptRuntimeErrorDiagnostic({
    scriptId: 'script-b',
    phase: 'load',
    error: 'await is only valid in async functions and the top level bodies of modules',
    compatibility: external,
  }).signature,
  firstDiagnostic.signature,
);

const storedCompatibility = { ...moduleOnly, marker: 'stored-result' };
assert.equal(resolveScriptCompatibility({
  content: 'const value = await Promise.resolve(1);',
  compatibility: storedCompatibility,
}), storedCompatibility);

assert.equal(
  extractMissingApiIdentifier('TavernHelper.getCharAvatarPath is not a function'),
  'TavernHelper.getCharAvatarPath',
);
assert.equal(extractMissingApiIdentifier('AutoCardUpdaterAPI is not defined'), 'AutoCardUpdaterAPI');
assert.equal(extractMissingApiIdentifier("Cannot read properties of undefined (reading 'stat_data')"), 'stat_data');
assert.equal(extractMissingApiIdentifier("undefined is not an object (evaluating 'ctx.chat')"), 'ctx.chat');
assert.equal(extractMissingApiIdentifier('script exited early'), '');

const missingApiDiagnostic = buildScriptRuntimeErrorDiagnostic({
  scriptId: 'script-c',
  phase: 'execute',
  error: 'TavernHelper.getCharAvatarPath is not a function',
  compatibility: moduleOnly,
});
assert.equal(missingApiDiagnostic.identifier, 'TavernHelper.getCharAvatarPath');
assert.ok(missingApiDiagnostic.signature.includes(':api_shape:TavernHelper.getCharAvatarPath:'));
// 同脚本缺不同 API 必须各自成签名，聚合名单不吞条目
assert.notEqual(
  buildScriptRuntimeErrorDiagnostic({
    scriptId: 'script-c',
    phase: 'execute',
    error: 'getCharAvatarPath is not defined',
    compatibility: moduleOnly,
  }).signature,
  missingApiDiagnostic.signature,
);

assert.equal(
  classifyScriptRuntimeErrorCategory("Cannot read properties of undefined (reading 'chat')"),
  'missing_value',
);
assert.equal(
  classifyScriptRuntimeErrorCategory('SecurityError: Blocked a frame with origin "null" from accessing a cross-origin frame.'),
  'sandbox_boundary',
);

console.log('script capability preflight tests: ok');
