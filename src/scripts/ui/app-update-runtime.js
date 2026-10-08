// APP 更新运行时：启动时展示本次更新日志、定期检查 GitHub 正式版、每个新版本只弹一次窗，
// 之后用小红点与「关于」卡片提示。依赖全部注入，便于测试。
import { t } from '../i18n/index.js';
import {
  extractChangelogSection,
  pickLatestStableRelease,
  resolveAppUpdateState,
  resolveLaunchChangelog,
  shouldCheckForAppUpdate,
} from '../utils/app-update-utils.js';

export const APP_UPDATE_RELEASES_URL = 'https://api.github.com/repos/dghiffjd7/OmniTavern/releases?per_page=15';
export const APP_UPDATE_RELEASES_PAGE = 'https://github.com/dghiffjd7/OmniTavern/releases/latest';

const trim = value => String(value ?? '').trim();

// 弹窗正文只显示纯文本：去掉常见 Markdown 记号，保留换行与列表
export const markdownToPlainText = (markdown = '') => String(markdown || '')
  .replace(/\r\n/g, '\n')
  .replace(/^#{1,6}\s*/gm, '')
  .replace(/^\s*[-*]\s+/gm, '• ')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const createAppUpdateRuntime = ({
  getCurrentVersion = async () => '',
  fetchReleases = async () => [],
  loadChangelog = async () => '',
  getSettings = () => ({}),
  updateSettings = () => {},
  choose = async () => null,
  openExternal = async () => false,
  installDesktopUpdate = async () => ({ status: 'unsupported' }),
  isMobile = () => false,
  toast = null,
  onStateChange = () => {},
  now = () => Date.now(),
  checkIntervalMs = 6 * 60 * 60 * 1000,
  logger = console,
} = {}) => {
  let currentVersion = '';
  let checking = null;
  let installing = null;

  const readState = () => {
    const state = getSettings()?.appUpdate;
    return state && typeof state === 'object' ? state : {};
  };
  const writeState = patch => updateSettings({ appUpdate: { ...readState(), ...patch } });

  const getView = () => {
    const state = readState();
    const latest = state.latest && typeof state.latest === 'object' ? state.latest : null;
    return {
      currentVersion,
      latest,
      checking: Boolean(checking),
      installing: Boolean(installing),
      lastCheckedAt: Number(state.lastCheckedAt || 0) || 0,
      ...resolveAppUpdateState({ currentVersion, latest, state }),
    };
  };
  const notify = () => {
    try { onStateChange(getView()); } catch (error) { logger?.debug?.('app update state listener failed', error); }
  };

  const runUpdate = (latest = readState().latest) => {
    if (installing) return installing;
    if (!latest?.version) return Promise.resolve(false);
    // 先记录任务，防止按钮与启动提示同时触发安装。
    installing = Promise.resolve().then(async () => {
      const fallbackUrl = trim(latest.pageUrl) || APP_UPDATE_RELEASES_PAGE;
      if (isMobile()) {
        // Android 不支持应用内安装：交给系统浏览器下载 APK，用户点开安装
        return openExternal(trim(latest.apkUrl) || fallbackUrl);
      }
      toast?.info?.(t('正在下载更新，安装完成后会自动重启。'));
      try {
        const result = await installDesktopUpdate(latest.version);
        if (result?.status === 'up_to_date' || result?.status === 'version_mismatch') {
          return openExternal(trim(latest.windowsUrl) || fallbackUrl);
        }
        // 原生端已有安装任务时不另开手动安装器。
        return true;
      } catch (error) {
        logger?.warn?.('app update install failed', error);
        toast?.error?.(t('自动更新失败，已为你打开下载页面。'));
        return openExternal(trim(latest.windowsUrl) || fallbackUrl);
      }
    }).finally(() => {
      installing = null;
      notify();
    });
    notify();
    return installing;
  };

  const promptUpdate = async (latest) => {
    writeState({ promptedVersion: latest.version });
    const notes = markdownToPlainText(latest.notes);
    const action = await choose({
      title: t('发现新版本 v{version}', { version: latest.version }),
      message: notes || t('当前版本 v{version}。', { version: currentVersion }),
      defaultActionId: 'update',
      actions: [
        { id: 'skip', label: t('跳过此版本'), variant: 'link' },
        { id: 'later', label: t('稍后'), variant: 'ghost' },
        { id: 'update', label: isMobile() ? t('下载更新') : t('立即更新'), primary: true },
      ],
    });
    if (action === 'skip') writeState({ skippedVersion: latest.version });
    notify();
    if (action === 'update') await runUpdate(latest);
    return action || 'later';
  };

  const checkNow = async ({ prompt = true, manual = false } = {}) => {
    if (checking) return checking;
    checking = (async () => {
      notify();
      try {
        const latest = pickLatestStableRelease(await fetchReleases());
        writeState({ lastCheckedAt: now(), latest });
        const view = getView();
        if (manual && !view.hasUpdate) toast?.success?.(t('已是最新版本 v{version}', { version: currentVersion }));
        if (prompt && view.shouldPrompt) await promptUpdate(latest);
        return view;
      } catch (error) {
        logger?.debug?.('app update check failed', error);
        if (manual) toast?.warning?.(t('检查更新失败，请稍后再试。'));
        return null;
      } finally {
        checking = null;
        notify();
      }
    })();
    return checking;
  };

  const showLaunchChangelog = async (version) => {
    let section = '';
    try { section = extractChangelogSection(await loadChangelog(), version); } catch {}
    const cached = readState().latest;
    if (!section && cached?.version === version) section = trim(cached.notes);
    if (!section) return false;
    await choose({
      title: t('已更新到 v{version}', { version }),
      message: markdownToPlainText(section),
      actions: [{ id: 'ok', label: t('知道了'), primary: true }],
    });
    return true;
  };

  const start = async () => {
    try {
      currentVersion = trim(await getCurrentVersion());
    } catch {
      currentVersion = '';
    }
    if (!currentVersion) return getView();
    const launch = resolveLaunchChangelog({ currentVersion, lastSeenVersion: getSettings()?.lastSeenAppVersion });
    if (launch.recordVersion) updateSettings({ lastSeenAppVersion: launch.recordVersion });
    notify();
    if (launch.show) await showLaunchChangelog(currentVersion);
    if (shouldCheckForAppUpdate({ lastCheckedAt: readState().lastCheckedAt, now: now(), intervalMs: checkIntervalMs })) {
      await checkNow({ prompt: true });
    } else {
      const view = getView();
      if (view.shouldPrompt) await promptUpdate(view.latest);
    }
    return getView();
  };

  return {
    start,
    checkNow,
    runUpdate: () => runUpdate(),
    getView,
    getCurrentVersion: () => currentVersion,
  };
};

// 把运行时状态投射到界面：body.has-app-update 驱动小红点，「关于」卡片显示版本与操作
export const renderAppUpdateUi = ({ documentRef = globalThis.document, view = {} } = {}) => {
  documentRef?.body?.classList?.toggle?.('has-app-update', Boolean(view.showBadge));
  const card = documentRef?.querySelector?.('[data-app-update-card]');
  if (!card) return;
  const versionEl = card.querySelector('[data-app-update-version]');
  const statusEl = card.querySelector('[data-app-update-status]');
  const actionEl = card.querySelector('[data-app-update-action]');
  card.classList.toggle('has-update', Boolean(view.hasUpdate));
  if (versionEl) versionEl.textContent = view.currentVersion ? `v${view.currentVersion}` : '—';
  if (statusEl) {
    statusEl.textContent = view.installing
      ? t('正在下载更新，安装完成后会自动重启。')
      : view.hasUpdate
      ? t('新版本 v{version} 可以更新', { version: view.latestVersion })
      : (view.checking ? t('正在检查更新…') : (view.lastCheckedAt ? t('已是最新正式版') : ''));
  }
  if (actionEl) {
    actionEl.textContent = view.hasUpdate ? t('更新') : t('检查更新');
    actionEl.disabled = Boolean(view.checking || view.installing) || !view.currentVersion;
  }
};

export const bindAppUpdateUi = ({ documentRef = globalThis.document, runtime = null } = {}) => {
  const actionEl = documentRef?.querySelector?.('[data-app-update-action]');
  actionEl?.addEventListener?.('click', () => {
    const view = runtime?.getView?.() || {};
    if (view.checking || view.installing) return;
    if (view.hasUpdate) void runtime.runUpdate();
    else void runtime?.checkNow?.({ prompt: true, manual: true });
  });
  return view => renderAppUpdateUi({ documentRef, view });
};
