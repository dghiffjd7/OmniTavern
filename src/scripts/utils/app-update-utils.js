// APP 更新检查的纯函数：版本比较、挑选 GitHub 最新正式版、提示状态与更新日志截取。
// 只提示正式版：带预发布后缀（如 0.7.4-preview-1）或标记为 prerelease 的发布一律忽略。

const trim = (value) => String(value ?? '').trim();

export const normalizeAppVersion = value => trim(value).replace(/^v/i, '');

export const parseAppVersion = (value = '') => {
  const match = normalizeAppVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
};

export const isStableAppVersion = value => {
  const parsed = parseAppVersion(value);
  return Boolean(parsed) && parsed.prerelease.length === 0;
};

const comparePrereleaseIdentifiers = (left = [], right = []) => {
  // 语义化版本：无预发布标识的版本更大；逐段比较，数字段按数值比较且小于字母段
  if (!left.length || !right.length) return left.length ? -1 : (right.length ? 1 : 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b);
      if (diff) return Math.sign(diff);
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
};

// 返回 -1 / 0 / 1；无法解析的版本视为最小
export const compareAppVersions = (left = '', right = '') => {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  if (!a || !b) return a ? 1 : (b ? -1 : 0);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return comparePrereleaseIdentifiers(a.prerelease, b.prerelease);
};

const pickAsset = (assets = [], pattern) => {
  const asset = (Array.isArray(assets) ? assets : []).find(item => pattern.test(trim(item?.name)));
  return asset ? trim(asset.browser_download_url) : '';
};

// GitHub /releases 列表 → 最新正式版摘要；没有可用正式版时返回 null
export const pickLatestStableRelease = (releases = []) => {
  const candidates = (Array.isArray(releases) ? releases : [])
    .filter(release => release && !release.draft && !release.prerelease)
    .map(release => ({ release, version: normalizeAppVersion(release.tag_name) }))
    .filter(item => isStableAppVersion(item.version))
    .sort((a, b) => compareAppVersions(b.version, a.version));
  const top = candidates[0];
  if (!top) return null;
  return {
    version: top.version,
    tag: trim(top.release.tag_name),
    pageUrl: trim(top.release.html_url),
    notes: String(top.release.body || '').trim(),
    publishedAt: trim(top.release.published_at),
    apkUrl: pickAsset(top.release.assets, /\.apk$/i),
    windowsUrl: pickAsset(top.release.assets, /-setup\.exe$/i),
  };
};

// 当前是预览/诊断版时，同号正式版不算更新：这类版本常在正式版之后发布（如 0.7.3 之后的 0.7.3-diagnose-3），
// 按语义化版本会被判为更旧，提示“更新”等于降级。只有 x.y.z 更大的正式版才提示。
const compareVersionCores = (left = '', right = '') => {
  const a = parseAppVersion(left);
  const b = parseAppVersion(right);
  if (!a || !b) return a ? 1 : (b ? -1 : 0);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
};

export const isNewerStableRelease = (latestVersion = '', currentVersion = '') => {
  if (!isStableAppVersion(latestVersion)) return false;
  if (!parseAppVersion(currentVersion)) return true;
  return isStableAppVersion(currentVersion)
    ? compareAppVersions(latestVersion, currentVersion) > 0
    : compareVersionCores(latestVersion, currentVersion) > 0;
};

// 每个新版本只弹一次窗；“跳过此版本”同时去掉该版本的小红点，“稍后”保留小红点
export const resolveAppUpdateState = ({ currentVersion = '', latest = null, state = {} } = {}) => {
  const latestVersion = normalizeAppVersion(latest?.version);
  const hasUpdate = Boolean(latestVersion) && isNewerStableRelease(latestVersion, currentVersion);
  const skipped = hasUpdate && normalizeAppVersion(state?.skippedVersion) === latestVersion;
  return {
    hasUpdate,
    latestVersion: hasUpdate ? latestVersion : '',
    shouldPrompt: hasUpdate && !skipped && normalizeAppVersion(state?.promptedVersion) !== latestVersion,
    showBadge: hasUpdate && !skipped,
  };
};

export const shouldCheckForAppUpdate = ({ lastCheckedAt = 0, now = Date.now(), intervalMs = 6 * 60 * 60 * 1000 } = {}) => (
  !(Number(lastCheckedAt) > 0) || Number(now) - Number(lastCheckedAt) >= intervalMs
);

// 从 CHANGELOG.md 取指定版本的一节：标题形如「## v0.7.4」或「## 0.7.4（2026-10-01）」
export const extractChangelogSection = (markdown = '', version = '') => {
  const target = normalizeAppVersion(version);
  if (!target) return '';
  const lines = String(markdown || '').split(/\r?\n/);
  const isHeading = line => /^##\s+/.test(line);
  const headingVersion = line => normalizeAppVersion(line.replace(/^##\s+/, '').split(/[\s（(]/)[0]);
  const start = lines.findIndex(line => isHeading(line) && headingVersion(line) === target);
  if (start < 0) return '';
  const end = lines.findIndex((line, index) => index > start && isHeading(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
};

// 更新后首次启动：只在版本升高时展示一次更新日志；首次安装只记录版本
export const resolveLaunchChangelog = ({ currentVersion = '', lastSeenVersion = '' } = {}) => {
  const current = normalizeAppVersion(currentVersion);
  const lastSeen = normalizeAppVersion(lastSeenVersion);
  if (!current) return { show: false, recordVersion: '' };
  if (!lastSeen) return { show: false, recordVersion: current };
  return {
    show: compareAppVersions(current, lastSeen) > 0,
    recordVersion: current === lastSeen ? '' : current,
  };
};
