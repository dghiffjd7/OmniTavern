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
    installDesktopUpdate: async version => {
      calls.install.push(version);
      return overrides.install ? overrides.install(version) : (overrides.installResult ?? { status: 'installing' });
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
