import assert from 'node:assert/strict';

import {
  compareAppVersions,
  extractChangelogSection,
  isStableAppVersion,
  pickLatestStableRelease,
  resolveAppUpdateState,
  resolveLaunchChangelog,
  shouldCheckForAppUpdate,
} from '../../src/scripts/utils/app-update-utils.js';
import {
  createAppUpdateRuntime,
  markdownToPlainText,
  renderAppUpdateUi,
} from '../../src/scripts/ui/app-update-runtime.js';
import { resolveAppUpdateProgressDisplay } from '../../src/scripts/ui/app-update-progress-card.js';

const pick = item => ({ title: item.title, percent: item.percent, indeterminate: item.indeterminate });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('version comparison follows semver including prerelease ordering', () => {
  assert.equal(compareAppVersions('0.7.4', '0.7.3'), 1);
  assert.equal(compareAppVersions('v0.7.3', '0.7.3'), 0);
  assert.equal(compareAppVersions('0.7.3', '0.7.3-diagnose-3'), 1, 'a release is newer than its prerelease');
  assert.equal(compareAppVersions('0.7.4-preview-1', '0.7.3'), 1);
  assert.equal(compareAppVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareAppVersions('0.7.4-preview.2', '0.7.4-preview.10'), -1);
  assert.equal(isStableAppVersion('0.7.4'), true);
  assert.equal(isStableAppVersion('0.7.4-preview-1'), false);
  assert.equal(isStableAppVersion('latest'), false);
});

test('only stable, published releases are offered', () => {
  const latest = pickLatestStableRelease([
    { tag_name: 'v0.7.5-preview-1', prerelease: true, assets: [] },
    { tag_name: 'v0.7.6-diagnose-1', prerelease: false, assets: [] },
    { tag_name: 'v0.7.9', draft: true, assets: [] },
    {
      tag_name: 'v0.7.4',
      html_url: 'https://github.com/dghiffjd7/OmniTavern/releases/tag/v0.7.4',
      body: '## 新增\n- 自动更新',
      published_at: '2026-10-05T00:00:00Z',
      assets: [
        { name: 'OmniTavern_0.7.4.apk', browser_download_url: 'https://github.com/dghiffjd7/OmniTavern/releases/download/v0.7.4/OmniTavern_0.7.4.apk' },
        { name: 'OmniTavern_0.7.4_x64-setup.exe', browser_download_url: 'https://github.com/dghiffjd7/OmniTavern/releases/download/v0.7.4/OmniTavern_0.7.4_x64-setup.exe' },
        { name: 'latest.json', browser_download_url: 'https://example.invalid/latest.json' },
      ],
    },
    { tag_name: 'v0.7.3', assets: [] },
  ]);
  assert.equal(latest.version, '0.7.4');
  assert.match(latest.apkUrl, /OmniTavern_0\.7\.4\.apk$/);
  assert.match(latest.windowsUrl, /x64-setup\.exe$/);
  assert.equal(pickLatestStableRelease([{ tag_name: 'v1.0.0-preview', prerelease: true }]), null);
});

test('prompt once per version; skip removes the badge, later keeps it', () => {
  const latest = { version: '0.7.4' };
  assert.deepEqual(resolveAppUpdateState({ currentVersion: '0.7.3', latest, state: {} }), {
    hasUpdate: true, latestVersion: '0.7.4', shouldPrompt: true, showBadge: true,
  });
  const prompted = resolveAppUpdateState({ currentVersion: '0.7.3', latest, state: { promptedVersion: '0.7.4' } });
  assert.equal(prompted.shouldPrompt, false);
  assert.equal(prompted.showBadge, true, 'later keeps the small badge');
  const skipped = resolveAppUpdateState({ currentVersion: '0.7.3', latest, state: { promptedVersion: '0.7.4', skippedVersion: '0.7.4' } });
  assert.equal(skipped.showBadge, false);
  assert.equal(resolveAppUpdateState({ currentVersion: '0.7.3', latest: { version: '0.7.5' }, state: { skippedVersion: '0.7.4' } }).shouldPrompt, true, 'a newer version prompts again');
  assert.equal(resolveAppUpdateState({ currentVersion: '0.7.4', latest, state: {} }).hasUpdate, false);
  // 诊断/预览版常在同号正式版之后发布：同号正式版不能当作更新（否则等于降级）
  assert.equal(resolveAppUpdateState({ currentVersion: '0.7.4-diagnose-3', latest, state: {} }).hasUpdate, false);
  assert.equal(resolveAppUpdateState({ currentVersion: '0.7.3-diagnose-3', latest, state: {} }).hasUpdate, true);
  assert.equal(shouldCheckForAppUpdate({ lastCheckedAt: 0, now: 10 }), true);
  assert.equal(shouldCheckForAppUpdate({ lastCheckedAt: 1000, now: 2000, intervalMs: 5000 }), false);
});

test('changelog sections and launch display follow the installed version', () => {
  const md = '# 日志\n\n## v0.7.5（2026-10-09）\n\n- A\n- B\n\n## v0.7.4\n\n- 旧\n';
  assert.equal(extractChangelogSection(md, '0.7.5'), '- A\n- B');
  assert.equal(extractChangelogSection(md, 'v0.7.4'), '- 旧');
  assert.equal(extractChangelogSection(md, '0.7.6'), '');
  assert.deepEqual(resolveLaunchChangelog({ currentVersion: '0.7.4', lastSeenVersion: '' }), { show: false, recordVersion: '0.7.4' });
  assert.deepEqual(resolveLaunchChangelog({ currentVersion: '0.7.5', lastSeenVersion: '0.7.4' }), { show: true, recordVersion: '0.7.5' });
  assert.deepEqual(resolveLaunchChangelog({ currentVersion: '0.7.4', lastSeenVersion: '0.7.4' }), { show: false, recordVersion: '' });
  assert.equal(markdownToPlainText('## 新增\n- **自动**更新 `v1`\n'), '新增\n• 自动更新 v1');
});

const makeRuntime = (overrides = {}) => {
  let settings = { ...(overrides.settings || {}) };
  const calls = { choose: [], open: [], install: [], views: [] };
  const runtime = createAppUpdateRuntime({
    getCurrentVersion: async () => overrides.current ?? '0.7.3',
    fetchReleases: async () => overrides.releases ?? [{ tag_name: 'v0.7.4', body: '- 自动更新', html_url: 'https://github.com/dghiffjd7/OmniTavern/releases/tag/v0.7.4', assets: [{ name: 'OmniTavern_0.7.4.apk', browser_download_url: 'https://github.com/dghiffjd7/OmniTavern/releases/download/v0.7.4/OmniTavern_0.7.4.apk' }] }],
    loadChangelog: async () => overrides.changelog ?? '',
    getSettings: () => settings,
    updateSettings: patch => { settings = { ...settings, ...patch }; },
    choose: async options => { calls.choose.push(options); return overrides.choice ?? 'later'; },
    openExternal: async url => { calls.open.push(url); return true; },
    installDesktopUpdate: async (version, options) => {
      calls.install.push(version);
      return overrides.install ? overrides.install(version, options) : (overrides.installResult ?? { status: 'installing' });
    },
    isMobile: () => overrides.mobile === true,
    onStateChange: view => calls.views.push(view),
    now: () => overrides.now ?? 100000,
    logger: { debug() {}, warn() {} },
  });
  return { runtime, calls, getSettings: () => settings };
};

test('runtime prompts once, then only keeps the badge on later launches', async () => {
  const first = makeRuntime();
  await first.runtime.start();
  assert.equal(first.calls.choose.length, 1);
  assert.match(first.calls.choose[0].title, /0\.7\.4/);
  assert.equal(first.getSettings().appUpdate.promptedVersion, '0.7.4');
  assert.equal(first.calls.views.at(-1).showBadge, true);
  const again = makeRuntime({ settings: first.getSettings(), now: 100001 });
  await again.runtime.start();
  assert.equal(again.calls.choose.length, 0, 'the same version never prompts twice');
  assert.equal(again.runtime.getView().showBadge, true);
});

test('skip hides the badge; update installs on desktop and opens the APK on Android', async () => {
  const skip = makeRuntime({ choice: 'skip' });
  await skip.runtime.start();
  assert.equal(skip.getSettings().appUpdate.skippedVersion, '0.7.4');
  assert.equal(skip.runtime.getView().showBadge, false);
  const desktop = makeRuntime({ choice: 'update' });
  await desktop.runtime.start();
  assert.deepEqual(desktop.calls.install, ['0.7.4']);
  const android = makeRuntime({ choice: 'update', mobile: true });
  await android.runtime.start();
  assert.deepEqual(android.calls.install, []);
  assert.deepEqual(android.calls.open, ['https://github.com/dghiffjd7/OmniTavern/releases/download/v0.7.4/OmniTavern_0.7.4.apk']);
  const mismatch = makeRuntime({ choice: 'update', installResult: { status: 'version_mismatch' } });
  await mismatch.runtime.start();
  assert.deepEqual(mismatch.calls.open, ['https://github.com/dghiffjd7/OmniTavern/releases/tag/v0.7.4']);
});

test('concurrent update requests share the installation and release the lock on failure', async () => {
  let finish;
  const { runtime, calls } = makeRuntime({
    install: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }),
  });
  await runtime.start();
  const first = runtime.runUpdate();
  const second = runtime.runUpdate();
  assert.equal(first, second, 'all entry points join the pending operation');
  assert.equal(runtime.getView().installing, true);
  await Promise.resolve();
  assert.equal(calls.install.length, 1);
  finish.reject(new Error('download failed'));
  assert.equal(await first, true, 'manual download fallback remains available');
  assert.equal(await second, true);
  assert.equal(calls.open.length, 1, 'one failed attempt opens only one fallback');
  assert.equal(runtime.getView().installing, false);
  const retry = runtime.runUpdate();
  await Promise.resolve();
  assert.equal(calls.install.length, 2);
  finish.resolve({ status: 'in_progress' });
  assert.equal(await retry, true);
  assert.equal(calls.open.length, 1, 'native busy response must not open a second installer');
  assert.equal(runtime.getView().installing, false);
  assert.ok(calls.views.some(view => view.installing));
});

test('runtime shows the bundled changelog once after an upgrade and ignores prereleases', async () => {
  const upgraded = makeRuntime({
    current: '0.7.4',
    settings: { lastSeenAppVersion: '0.7.3', appUpdate: { lastCheckedAt: 100000 } },
    changelog: '## v0.7.4\n\n- 自动更新\n',
  });
  await upgraded.runtime.start();
  assert.equal(upgraded.calls.choose.length, 1);
  assert.match(upgraded.calls.choose[0].title, /已更新到 v0\.7\.4/);
  assert.equal(upgraded.calls.choose[0].message, '• 自动更新');
  assert.equal(upgraded.getSettings().lastSeenAppVersion, '0.7.4');
  const preview = makeRuntime({ releases: [{ tag_name: 'v0.7.5-preview-1', prerelease: true, assets: [] }] });
  await preview.runtime.start();
  assert.equal(preview.calls.choose.length, 0);
  assert.equal(preview.runtime.getView().hasUpdate, false);
});

test('desktop install reports download progress, then the install stage; a skipped install clears it', async () => {
  const seen = [];
  let report = null;
  let finish = null;
  const { runtime } = makeRuntime({
    install: (version, options) => {
      report = options?.onProgress;
      return new Promise(resolve => { finish = resolve; });
    },
  });
  await runtime.start();
  const pending = runtime.runUpdate();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(runtime.getView().progress?.stage, 'preparing', '点更新后先显示准备中');
  assert.equal(typeof report, 'function', '把进度回调交给原生安装');
  report({ stage: 'downloading', downloaded: 5 * 1048576, total: 20 * 1048576 });
  seen.push(runtime.getView().progress);
  report({ stage: 'downloading', downloaded: 9 * 1048576, total: null });
  seen.push(runtime.getView().progress);
  report({ stage: 'installing' });
  seen.push(runtime.getView().progress);
  assert.deepEqual(seen.map(item => [item.stage, item.percent]), [['downloading', 25], ['downloading', null], ['installing', 100]]);
  assert.equal(seen[0].version, '0.7.4');
  finish({ status: 'version_mismatch', version: '0.7.5' });
  await pending;
  assert.equal(runtime.getView().progress, null, '没有真正安装时收起进度');
});

test('progress display texts follow the stage and fall back when the size is unknown', () => {
  const view = progress => resolveAppUpdateProgressDisplay({ version: '0.7.5', ...progress });
  assert.deepEqual(pick(view({ stage: 'preparing' })), { title: '正在准备更新 v0.7.5', percent: null, indeterminate: true });
  const downloading = view({ stage: 'downloading', percent: 36, downloaded: 12.34 * 1048576, total: 34.2 * 1048576 });
  assert.deepEqual(pick(downloading), { title: '正在下载 v0.7.5', percent: 36, indeterminate: false });
  assert.equal(downloading.meta, '12.3 MB / 34.2 MB');
  const unknown = view({ stage: 'downloading', percent: null, downloaded: 3 * 1048576, total: null });
  assert.equal(unknown.indeterminate, true);
  assert.equal(unknown.meta, '已下载 3.0 MB');
  const installing = view({ stage: 'installing', percent: 100 });
  assert.equal(installing.title, '下载完成，正在启动安装');
  assert.match(installing.meta, /自动关闭/);
  assert.equal(resolveAppUpdateProgressDisplay(null), null);
});

test('ui projection toggles the badge class and fills the about card', () => {
  const classes = new Set();
  const nodes = {
    '[data-app-update-version]': { textContent: '' },
    '[data-app-update-status]': { textContent: '' },
    '[data-app-update-action]': { textContent: '', disabled: false },
  };
  const cardClasses = new Set();
  const documentRef = {
    body: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } },
    querySelector: selector => (selector === '[data-app-update-card]'
      ? { classList: { toggle: (name, on) => (on ? cardClasses.add(name) : cardClasses.delete(name)) }, querySelector: inner => nodes[inner] }
      : null),
  };
  renderAppUpdateUi({ documentRef, view: { currentVersion: '0.7.3', hasUpdate: true, showBadge: true, latestVersion: '0.7.4' } });
  assert.equal(classes.has('has-app-update'), true);
  assert.equal(cardClasses.has('has-update'), true);
  assert.equal(nodes['[data-app-update-version]'].textContent, 'v0.7.3');
  assert.match(nodes['[data-app-update-status]'].textContent, /0\.7\.4/);
  renderAppUpdateUi({ documentRef, view: { currentVersion: '0.7.3', hasUpdate: true, installing: true } });
  assert.equal(nodes['[data-app-update-action]'].disabled, true);
  renderAppUpdateUi({ documentRef, view: { currentVersion: '0.7.4', hasUpdate: false, showBadge: false, lastCheckedAt: 1 } });
  assert.equal(classes.has('has-app-update'), false);
});

test('the installed version changelog can be reopened from the about card', async () => {
  const upgraded = makeRuntime({
    current: '0.7.4',
    settings: { lastSeenAppVersion: '0.7.4', appUpdate: { lastCheckedAt: 100000 } },
    changelog: '## v0.7.4\n\n- 自动更新\n\n## v0.7.3\n\n- 旧内容\n',
  });
  await upgraded.runtime.start();
  assert.equal(upgraded.calls.choose.length, 0, 'already seen: no launch dialog');
  assert.equal(upgraded.runtime.getView().changelogAvailable, true);
  assert.equal(await upgraded.runtime.showChangelog(), true);
  assert.equal(upgraded.calls.choose.length, 1);
  assert.match(upgraded.calls.choose[0].title, /v0\.7\.4 更新内容/);
  assert.equal(upgraded.calls.choose[0].message, '• 自动更新');
  const preview = makeRuntime({ current: '0.7.5-diagnose-1', settings: { appUpdate: { lastCheckedAt: 100000 } }, changelog: '## v0.7.4\n\n- 自动更新\n' });
  await preview.runtime.start();
  assert.equal(preview.runtime.getView().changelogAvailable, false, 'no section for this version: the button stays hidden');
  assert.equal(await preview.runtime.showChangelog(), false);
  assert.equal(preview.calls.choose.length, 0);
});

test('while the update downloads the about card shows progress instead of the button', () => {
  const style = new Map();
  const classes = new Set();
  const nodes = {
    '[data-app-update-version]': { textContent: '' },
    '[data-app-update-status]': { textContent: '' },
    '[data-app-update-action]': { textContent: '', disabled: false, hidden: false },
    '[data-app-update-notes]': { hidden: true },
    '[data-app-update-progress]': { hidden: true, style: { setProperty: (key, value) => style.set(key, value) }, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) }, setAttribute() {}, removeAttribute() {} },
    '[data-app-update-percent]': { textContent: '' },
  };
  const documentRef = {
    body: { classList: { toggle() {} } },
    querySelector: selector => (selector === '[data-app-update-card]' ? { classList: { toggle() {} }, querySelector: inner => nodes[inner] } : null),
  };
  const render = view => renderAppUpdateUi({ documentRef, view: { currentVersion: '0.7.3', hasUpdate: true, latestVersion: '0.7.4', ...view } });
  render({ installing: true, progress: { version: '0.7.4', stage: 'downloading', downloaded: 42, total: 100, percent: 42 } });
  assert.equal(nodes['[data-app-update-action]'].hidden, true);
  assert.equal(nodes['[data-app-update-action]'].disabled, true);
  assert.equal(nodes['[data-app-update-progress]'].hidden, false);
  assert.equal(nodes['[data-app-update-percent]'].textContent, '42%');
  assert.equal(style.get('--aup-progress'), '0.42');
  assert.equal(classes.has('is-indeterminate'), false);
  render({ installing: true, progress: { version: '0.7.4', stage: 'preparing' } });
  assert.equal(classes.has('is-indeterminate'), true, 'unknown size: sliding bar');
  assert.equal(nodes['[data-app-update-percent]'].textContent, '');
  render({ installing: false, progress: null, changelogAvailable: true });
  assert.equal(nodes['[data-app-update-progress]'].hidden, true);
  assert.equal(nodes['[data-app-update-action]'].hidden, false);
  assert.equal(nodes['[data-app-update-action]'].disabled, false);
  assert.equal(nodes['[data-app-update-notes]'].hidden, false);
  render({ changelogAvailable: false });
  assert.equal(nodes['[data-app-update-notes]'].hidden, true);
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
