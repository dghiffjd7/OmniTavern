import { t } from '../../i18n/index.js';
import { RISKY_PERMISSIONS, getRiskyPermissions } from '../../plugins/plugin-permissions.js';
import { downloadPluginPackage, readPluginZip, resolveInstallUrl } from '../../plugins/plugin-package.js';
import { batchResult, confirmRequest, resolveNamedTarget, summarizeBatch } from './preset-regex-script-tools.js';

/* 女仆管理插件：查看、启停、安装（附件或网址）、移除插件加到界面上的内容。
   沿用写入工具的做法：先解析并冻结目标（preflight 快照）→ 一次结构化确认 → 执行前复验 → 写入后读回，
   写入都经插件面板同一套 store／runtime。
   用户决定（11/20）：插件可从附件或网址（含 GitHub 链接）安装，下载与解析沿用插件面板；装好先保持关闭，启用另外确认；
   启用与安装的确认卡与一般写入一样，可记住允许（这个任务／这个角色卡）。 */

const trim = value => String(value ?? '').trim();
const clip = (value, max = 200) => {
  const text = trim(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : [values]).map(trim).filter(Boolean))];
const failure = (reason, extra = {}) => ({ ok: false, reason, ...extra });
const cancelledItem = (item, extra = {}) => ({ ...item, ...extra, status: 'cancelled', reason: 'user_aborted' });
const isAllowed = (context = {}, kind = '') => (
  context?.toolSafety?.decision === 'allow' && context?.toolSafety?.request?.kind === kind
);
const isPowerMode = manifest => trim(manifest?.mode).toLowerCase() === 'power';
const pluginName = item => trim(item?.manifest?.name) || trim(item?.id);
const permissionKey = manifest => [...new Set((manifest?.permissions || []).map(trim).filter(Boolean))].sort().join('|');
const riskLabel = permission => `${permission}（${t(RISKY_PERMISSIONS.get(permission) || permission)}）`;
const formatSize = (text = '') => {
  const bytes = new TextEncoder().encode(String(text)).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
};
const UI_KINDS = Object.freeze(['sidebar', 'card', 'modal']);
const UI_KIND_LABELS = Object.freeze({ sidebar: '侧边栏', card: '聊天卡片', modal: '弹窗' });

// 文件库里的原文件可能不在内存：先按需载入；载不到（已被清理）视为失效
const loadAttachment = async (registry, id) => {
  const entry = typeof registry.ensureLoaded === 'function' ? await registry.ensureLoaded(id) : registry.get(id);
  return entry?.bytes ? entry : null;
};
const isZipAttachment = entry => entry?.inspection?.format === 'archive' || /\.zip$/i.test(trim(entry?.name));

export const createPluginAgentTools = ({
  pluginStore = null,
  // 环境不支持 Worker 时为 null：可以安装与查看，无法运行
  pluginRuntime = null,
  getUiManager = () => null,
  // 女仆文件库在 app.js 较晚才建立，执行时再取
  getAttachmentRegistry = () => null,
  // 原生命令与 fetch 的替身（测试用）；不传时沿用插件面板的下载与 ZIP 解析
  invoke = undefined,
  fetchImpl = undefined,
  onPluginsChanged = null,
} = {}) => {
  const snapshots = new WeakMap();
  const ready = async () => {
    if (!pluginStore) return false;
    try { await pluginStore.ready; } catch {}
    return true;
  };
  const notify = () => { try { Promise.resolve(onPluginsChanged?.()).catch(() => {}); } catch {} };
  const runtimeStatus = id => (pluginRuntime ? pluginRuntime.getStatus?.(id) || null : null);
  const nameById = id => pluginName(pluginStore?.get?.(id)) || trim(id);

  /* ───────────── 查看 ───────────── */

  const listUi = () => {
    const ui = getUiManager?.() || null;
    if (!ui) return null;
    const modal = ui.getActiveModal?.() || null;
    return [
      ...(ui.listSidebars?.() || []).map(item => ({ kind: 'sidebar', pluginId: trim(item.pluginId), id: trim(item.id), title: trim(item.title) })),
      ...(ui.listCards?.() || []).map(item => ({ kind: 'card', pluginId: trim(item.pluginId), id: trim(item.id), position: trim(item.position) })),
      ...(modal ? [{ kind: 'modal', pluginId: trim(modal.pluginId), id: trim(modal.id), title: trim(modal.title) }] : []),
    ];
  };

  const describePlugin = (item) => {
    const manifest = item.manifest || {};
    const risky = getRiskyPermissions(manifest);
    const power = isPowerMode(manifest);
    const status = runtimeStatus(item.id);
    const source = item.source && typeof item.source === 'object' ? item.source : null;
    const author = trim(manifest.author?.name || (typeof manifest.author === 'string' ? manifest.author : ''));
    return {
      id: item.id,
      name: pluginName(item),
      version: trim(manifest.version),
      ...(trim(manifest.description) ? { description: clip(manifest.description, 300) } : {}),
      ...(author ? { author } : {}),
      mode: trim(manifest.mode) || 'safe',
      ...(power ? { powerApproved: item.powerApproved === true } : {}),
      permissions: Array.isArray(manifest.permissions) ? manifest.permissions : [],
      riskyPermissions: risky.map(permission => ({ permission, label: RISKY_PERMISSIONS.get(permission) })),
      ...(risky.length ? { permissionsApproved: pluginStore.isPermissionsApproved?.(item.id) === true } : {}),
      enabled: item.enabled === true,
      blocked: item.blocked === true,
      ...(status ? { runtime: { status: trim(status.status), ...(status.error ? { error: clip(status.error) } : {}) } } : {}),
      ...(item.failureCount ? { failureCount: item.failureCount, lastFailureReason: clip(item.lastFailureReason) } : {}),
      ...(trim(item.disabledReason) ? { disabledReason: trim(item.disabledReason) } : {}),
      source: source ? Object.fromEntries(['type', 'name', 'url', 'path'].filter(key => trim(source[key])).map(key => [key, trim(source[key])])) : null,
      backupCount: Number(item.backupCount || 0),
    };
  };

  const listPlugins = async () => {
    if (!await ready()) return failure('plugin_store_unavailable');
    const all = pluginStore.list();
    const ui = listUi();
    return {
      ok: true,
      runtimeAvailable: Boolean(pluginRuntime),
      ...(pluginRuntime ? {} : { note: '当前环境不支持插件运行：可以查看与安装插件，但无法启用。' }),
      count: all.length,
      plugins: all.slice(0, 100).map(describePlugin),
      ...(all.length > 100 ? { truncated: all.length - 100 } : {}),
      ui: ui
        ? {
          available: true,
          sidebars: ui.filter(item => item.kind === 'sidebar').map(item => ({ ...item, pluginName: nameById(item.pluginId) })),
          cards: ui.filter(item => item.kind === 'card').map(item => ({ ...item, pluginName: nameById(item.pluginId) })),
          modal: ui.find(item => item.kind === 'modal') || null,
        }
        : { available: false },
    };
  };

  /* ───────────── 启用／停用 ───────────── */

  const captureToggle = async (args = {}) => {
    if (!await ready()) return { error: failure('plugin_store_unavailable') };
    const enabled = args.enabled === true;
    if (!pluginRuntime) return { error: failure('plugin_runtime_unavailable', { enabled, message: '当前环境不支持插件运行。' }) };
    const all = pluginStore.list();
    const seen = new Set();
    const items = uniqueStrings(args.plugins).map((query) => {
      const target = resolveNamedTarget(all, query, { nameOf: pluginName });
      if (target.error) return { target: query, status: target.error === 'ambiguous_target' ? 'ambiguous' : 'missing', reason: target.error, candidates: target.candidates };
      const item = target.item;
      const base = { target: query, id: item.id, name: pluginName(item), version: trim(item.manifest?.version) };
      if (seen.has(item.id)) return { ...base, status: 'skipped', reason: 'duplicate_target' };
      seen.add(item.id);
      if (enabled && item.blocked) return { ...base, status: 'protected', reason: 'plugin_blocked', disabledReason: trim(item.disabledReason) };
      if ((item.enabled === true) === enabled) return { ...base, status: 'skipped', reason: 'already_in_state' };
      const record = pluginStore.get(item.id);
      const risky = getRiskyPermissions(record?.manifest);
      const power = isPowerMode(record?.manifest);
      return {
        ...base,
        status: 'planned',
        reason: '',
        power,
        risky,
        needsPowerApproval: enabled && power && !pluginStore.isPowerApproved(item.id),
        needsPermissionApproval: enabled && risky.length > 0 && !pluginStore.isPermissionsApproved(item.id),
        // 复验用：确认期间插件若被覆盖，用户确认的权限就不是现在这份
        manifestJson: JSON.stringify(record?.manifest || {}),
        code: String(record?.code || ''),
      };
    });
    return { enabled, items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const toggleItem = (item, enabled) => {
    const meta = item.status === 'planned' && enabled
      ? [
        item.version ? `v${item.version}` : '',
        item.power ? (item.needsPowerApproval ? t('高权限模式（将授权）') : t('高权限模式（已授权）')) : '',
        item.risky?.length ? (item.needsPermissionApproval ? t('风险权限 {count} 项（将授权）', { count: item.risky.length }) : t('风险权限 {count} 项（已授权）', { count: item.risky.length })) : '',
      ].filter(Boolean).join(' · ')
      : (item.version ? `v${item.version}` : '');
    return { id: item.id || item.target, label: item.name || item.target, meta, status: item.status, reason: item.reason };
  };

  const enableMessage = (snap) => {
    const planned = snap.items.filter(item => item.status === 'planned');
    const power = planned.filter(item => item.needsPowerApproval);
    const perms = planned.filter(item => item.needsPermissionApproval);
    return [
      t('将启用 {count} 个插件，插件会在后台运行代码。', { count: planned.length }),
      ...(power.length ? [t('确认即授予这些插件高权限（可能包含网络访问、修改提示词、写入世界书等操作）：{names}', { names: power.map(item => `「${item.name}」`).join('、') })] : []),
      ...(perms.length ? [t('确认即授予以下权限：'), ...perms.map(item => `· ${item.name}：${item.risky.map(riskLabel).join('、')}`)] : []),
    ].join('\n');
  };

  const pluginToggleTool = {
    name: 'plugin.toggle_many',
    title: 'Enable or disable plugins',
    description: 'Enable or disable installed plugins in one batch. plugins are ids or exact names from plugin.list. Enabling grants the plugin\'s high-permission (power) mode and risky permissions in the same confirmation, starts it, and rolls it back to disabled if it fails to start. Blocked plugins stay disabled until the user unblocks them in the plugin panel. Disabling stops the plugin and removes the sidebars, cards and dialogs it added.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'manual_toggle', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['plugins', 'enabled'], additionalProperties: false,
      properties: {
        plugins: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 200 } },
        enabled: { type: 'boolean' },
      },
    },
    safety: {
      operationType: 'toggle_plugins', destructive: 'conditional',
      preflight: async (args) => {
        const snap = await captureToggle(args);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        const grants = snap.items.some(item => item.needsPowerApproval || item.needsPermissionApproval);
        return snap.enabled
          ? confirmRequest({
            kind: 'plugin.enable', operationType: 'enable_plugins', danger: grants, allowAlways: true,
            title: t('启用插件'),
            message: enableMessage(snap),
            confirmText: t('启用'),
            items: snap.items.map(item => toggleItem(item, true)),
            denyReason: 'plugin_enable_cancelled',
            denyResult: { changed: false },
          })
          : confirmRequest({
            kind: 'plugin.disable', operationType: 'disable_plugins', danger: false, allowAlways: true,
            title: t('停用插件'),
            message: t('将停用 {count} 个插件，它们加到界面上的侧边栏、卡片和弹窗会一并移除。', { count: snap.plannedCount }),
            confirmText: t('停用'),
            items: snap.items.map(item => toggleItem(item, false)),
            denyReason: 'plugin_disable_cancelled',
            denyResult: { changed: false },
          });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureToggle(args);
      if (snap.error) return snap.error;
      const kind = snap.enabled ? 'plugin.enable' : 'plugin.disable';
      if (snap.plannedCount && !isAllowed(context, kind)) return failure('confirmation_required');
      const results = [];
      let touched = false;
      for (const item of snap.items) {
        const base = { target: item.target, id: item.id, name: item.name, version: item.version };
        if (item.status !== 'planned') {
          results.push({ ...base, status: item.status, reason: item.reason, ...(item.candidates ? { candidates: item.candidates } : {}), ...(item.disabledReason ? { disabledReason: item.disabledReason } : {}) });
          continue;
        }
        if (context.signal?.aborted) { results.push(cancelledItem(base)); continue; }
        const record = pluginStore.get(item.id);
        if (!record) { results.push({ ...base, status: 'failed', reason: 'target_removed_during_confirmation' }); continue; }
        if (JSON.stringify(record.manifest || {}) !== item.manifestJson || String(record.code || '') !== item.code) {
          results.push({ ...base, status: 'failed', reason: 'target_changed_during_confirmation' });
          continue;
        }
        if (snap.enabled && record.blocked) { results.push({ ...base, status: 'protected', reason: 'plugin_blocked' }); continue; }
        if ((record.enabled === true) === snap.enabled) { results.push({ ...base, status: 'skipped', reason: 'already_in_state' }); continue; }
        try {
          if (snap.enabled) {
            // 与插件面板 enablePluginWithChecks 同序：高权限授权 → 风险权限授权 → 启用 → 启动后检查，失败回滚
            const granted = [];
            if (item.power && !pluginStore.isPowerApproved(item.id)) {
              await pluginStore.setPowerApproved(item.id, true);
              granted.push('power');
            }
            if (!pluginStore.isPermissionsApproved(item.id) && item.risky.length) {
              await pluginStore.approvePermissions(item.id);
              granted.push(...item.risky);
            }
            await pluginStore.setEnabled(item.id, true);
            touched = true;
            await pluginRuntime.enablePlugin(item.id);
            const status = pluginRuntime.getStatus(item.id);
            if (status?.status === 'error') {
              await pluginStore.setEnabled(item.id, false);
              await pluginRuntime.disablePlugin(item.id);
              results.push({ ...base, status: 'failed', reason: 'plugin_start_failed', errorMessage: clip(status.error || ''), rolledBack: true, ...(granted.length ? { granted } : {}) });
              continue;
            }
            const after = pluginStore.get(item.id);
            const running = pluginRuntime.getStatus(item.id)?.status;
            const ok = after?.enabled === true && running === 'running';
            results.push({ ...base, status: ok ? 'succeeded' : 'failed', runtimeStatus: trim(running), ...(granted.length ? { granted } : {}), ...(ok ? {} : { reason: 'verification_failed', ...(trim(after?.disabledReason) ? { disabledReason: trim(after.disabledReason) } : {}) }) });
          } else {
            // 与插件面板停用开关同序：先存关闭，再停止运行（runtime 会移除它加的界面）
            await pluginStore.setEnabled(item.id, false);
            touched = true;
            await pluginRuntime.disablePlugin(item.id);
            const ok = pluginStore.get(item.id)?.enabled === false && pluginRuntime.getStatus(item.id)?.status === 'stopped';
            results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
          }
        } catch (error) {
          results.push(context.signal?.aborted
            ? cancelledItem(base, { errorMessage: clip(error?.message || error) })
            : { ...base, status: 'failed', reason: 'toggle_failed', errorMessage: clip(error?.message || error) });
        }
      }
      if (touched) notify();
      return batchResult('plugin.toggle_many', results, { requestedCount: snap.items.length, extra: { enabled: snap.enabled } });
    },
    summarizeResult: summarizeBatch('plugin toggle'),
  };

  /* ───────────── 安装 ───────────── */

  const captureInstall = async (args = {}, context = {}) => {
    if (!await ready()) return { error: failure('plugin_store_unavailable') };
    const attachmentId = trim(args.attachmentId);
    const rawUrl = trim(args.url);
    if (Boolean(attachmentId) === Boolean(rawUrl)) return { error: failure('attachment_or_url_required', { message: '请只给 attachmentId 或 url 其中一个。' }) };
    let bytes;
    let source;
    let sourceLabel;
    if (attachmentId) {
      const registry = getAttachmentRegistry?.();
      if (!registry) return { error: failure('attachment_import_unavailable') };
      const entry = await loadAttachment(registry, attachmentId);
      if (!entry) return { error: failure('attachment_not_found', { message: '附件已失效（可能已被清理或删除），请让用户重新上传。' }) };
      if (!isZipAttachment(entry)) {
        return { error: failure('attachment_not_plugin_zip', { attachmentId, name: trim(entry.name), format: trim(entry.inspection?.format), message: '插件要用 ZIP 包（含 manifest.json 与入口脚本）安装。' }) };
      }
      bytes = entry.bytes;
      sourceLabel = trim(entry.name) || attachmentId;
      source = { type: 'zip', name: trim(entry.name) };
    } else {
      if (!/^https?:\/\//i.test(rawUrl)) return { error: failure('invalid_url', { url: rawUrl, message: '仅支持 http/https 链接。' }) };
      try {
        const resolvedUrl = await resolveInstallUrl(rawUrl, { fetchImpl, signal: context.signal || null });
        const download = await downloadPluginPackage(resolvedUrl, { invoke, fetchImpl, signal: context.signal || null });
        bytes = download.bytes;
        sourceLabel = download.url;
        source = { type: 'zip', name: trim(download.name), url: download.url };
      } catch (error) {
        if (context.signal?.aborted) return { error: { ok: false, cancelled: true, reason: 'user_aborted', url: rawUrl } };
        return { error: failure('plugin_download_failed', { url: rawUrl, errorMessage: clip(error?.message || error, 300) }) };
      }
    }
    let parsed;
    try {
      parsed = await readPluginZip(bytes, { invoke });
    } catch (error) {
      return { error: failure('plugin_package_invalid', { source: sourceLabel, errorMessage: clip(error?.message || error, 300) }) };
    }
    if (context.signal?.aborted) return { error: { ok: false, cancelled: true, reason: 'user_aborted' } };
    const { manifest, code } = parsed;
    const record = pluginStore.get(manifest.id);
    const risky = getRiskyPermissions(manifest);
    const power = isPowerMode(manifest);
    let existing = null;
    if (record) {
      const permissionsApproved = pluginStore.isPermissionsApproved(record.id);
      const powerApproved = pluginStore.isPowerApproved(record.id);
      existing = {
        name: pluginName(record),
        version: trim(record.manifest?.version),
        enabled: record.enabled === true,
        running: runtimeStatus(record.id)?.status === 'running',
        manifestJson: JSON.stringify(record.manifest || {}),
        code: String(record.code || ''),
        // 覆盖后 store 保留启用与授权，但权限有变时风险权限授权失效；高权限要已授权。没授权时下次启动会被自动停用
        needsReapproval: (risky.length > 0 && !(permissionsApproved && permissionKey(record.manifest) === permissionKey(manifest)))
          || (power && !powerApproved),
      };
    }
    const unchanged = Boolean(existing) && existing.manifestJson === JSON.stringify(manifest) && existing.code === code;
    return {
      manifest, code, source, sourceLabel, sourceKind: attachmentId ? 'attachment' : 'url', attachmentId,
      risky, power, existing, unchanged,
    };
  };

  const installConfirmation = (snap) => {
    const { manifest, existing } = snap;
    const name = trim(manifest.name) || manifest.id;
    const description = trim(manifest.description);
    const items = [
      { id: 'plugin', label: name, meta: `ID ${manifest.id}` },
      { id: 'version', label: t('版本'), meta: existing ? `${existing.version || '?'} ⇒ ${manifest.version}` : manifest.version },
      { id: 'mode', label: t('模式'), meta: snap.power ? t('高权限（power）') : manifest.mode },
      { id: 'permissions', label: t('权限'), meta: manifest.permissions.join(', ') || t('无') },
      ...snap.risky.map(permission => ({ id: `risk:${permission}`, label: t('风险权限：{permission}', { permission }), meta: t(RISKY_PERMISSIONS.get(permission) || permission), warning: true })),
      { id: 'source', label: t('来源'), meta: snap.sourceKind === 'url' ? snap.sourceLabel : t('附件：{name}', { name: snap.sourceLabel }) },
      { id: 'size', label: t('代码大小'), meta: formatSize(snap.code) },
      ...(description ? [{ id: 'description', label: t('说明'), meta: clip(description, 200) }] : []),
      ...(existing ? [{ id: 'overwrite', label: t('覆盖：版本 {from} ⇒ {to}，旧版保留为备份', { from: existing.version || '?', to: manifest.version }), warning: true }] : []),
    ];
    const message = existing
      ? [
        t('插件「{name}」已存在，将覆盖为新版，旧版保留为备份（最多 3 份）。', { name }),
        !existing.enabled ? t('这个插件目前是关闭的，覆盖后仍保持关闭。')
          : existing.running ? t('这个插件目前已启用并在运行：覆盖后仍保持启用，但运行中的仍是旧版，要等 APP 重新启动或把插件停用再启用后才会换成新版。')
            : t('这个插件目前是启用状态：覆盖后仍保持启用，下次 APP 启动时载入新版。'),
        existing.enabled && existing.needsReapproval ? t('新版的高权限或风险权限需要重新授权，没授权前下次 APP 启动时会被自动停用。') : '',
      ].filter(Boolean).join('\n')
      : t('将安装插件「{name}」，装好后保持关闭，需要时再单独启用。', { name });
    return confirmRequest({
      kind: 'plugin.install', operationType: 'install_plugin', danger: Boolean(existing), allowAlways: true,
      title: existing ? t('覆盖插件「{name}」', { name }) : t('安装插件「{name}」', { name }),
      message,
      confirmText: existing ? t('覆盖') : t('安装'),
      items,
      denyReason: 'plugin_install_cancelled',
      denyResult: { installed: false },
    });
  };

  const pluginInstallTool = {
    name: 'plugin.install',
    title: 'Install a plugin',
    description: 'Install a plugin package (a ZIP with manifest.json and its entry script) from a file the user attached to the Maid (attachmentId) or from a link (url: a direct ZIP link or a GitHub repository, branch, tag, release or file link). Pass exactly one of them. The package is downloaded and checked before the confirmation, which shows its name, version, mode, permissions and source. A newly installed plugin stays disabled; enable it with plugin.toggle_many when the user wants it. Installing a plugin whose id already exists replaces it and keeps the old version as a backup; its enabled state is kept.',
    source: 'maid-app-content', permissions: [], riskLevel: 'high',
    capabilities: { read: true, write: true, network: true, cost: 'none', undo: 'manual_rollback', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        attachmentId: { type: 'string', minLength: 1, maxLength: 120 },
        url: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    },
    safety: {
      operationType: 'install_plugin', destructive: 'conditional',
      preflight: async (args, context) => {
        const snap = await captureInstall(args, context);
        snapshots.set(args, snap);
        if (snap.error || snap.unchanged) return { destructive: false };
        return installConfirmation(snap);
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || await captureInstall(args, context);
      if (snap.error) return snap.error;
      const { manifest, code, existing } = snap;
      const base = {
        pluginId: manifest.id,
        name: trim(manifest.name) || manifest.id,
        version: manifest.version,
        ...(existing ? { previousVersion: existing.version } : {}),
        source: snap.sourceKind === 'url' ? { url: snap.sourceLabel } : { attachmentId: snap.attachmentId, name: snap.sourceLabel },
      };
      if (snap.unchanged) {
        return { ok: true, installed: false, reason: 'already_installed', ...base, enabled: existing.enabled };
      }
      if (!isAllowed(context, 'plugin.install')) return failure('confirmation_required', base);
      if (context.signal?.aborted) return { ok: false, cancelled: true, reason: 'user_aborted', installed: false, ...base };
      const current = pluginStore.get(manifest.id);
      if (existing && !current) return failure('target_removed_during_confirmation', { installed: false, ...base });
      if (!existing && current) return failure('target_changed_during_confirmation', { installed: false, ...base });
      // 卡上写了覆盖前的版本与启用状态：内容或启用状态在确认期间变了，就不按这张卡写入
      if (existing && (JSON.stringify(current.manifest || {}) !== existing.manifestJson || String(current.code || '') !== existing.code
        || (current.enabled === true) !== existing.enabled)) {
        return failure('target_changed_during_confirmation', { installed: false, ...base });
      }
      try {
        await pluginStore.installPlugin({ manifest, code, source: snap.source });
      } catch (error) {
        return failure('plugin_install_failed', { installed: false, ...base, errorMessage: clip(error?.message || error, 300) });
      }
      notify();
      const after = pluginStore.get(manifest.id);
      const verified = Boolean(after) && trim(after.manifest?.version) === trim(manifest.version) && String(after.code || '').length === code.length;
      if (verified && snap.sourceKind === 'attachment') {
        try { getAttachmentRegistry?.()?.recordImport?.(snap.attachmentId, { target: `plugin:${manifest.id}` }); } catch {}
      }
      const enabled = after?.enabled === true;
      const runningOldVersion = Boolean(existing?.enabled && existing.running);
      return {
        ok: verified,
        installed: verified,
        verified,
        ...(verified ? {} : { reason: 'verification_failed' }),
        ...base,
        overwritten: Boolean(existing),
        enabled,
        mode: trim(manifest.mode) || 'safe',
        permissions: manifest.permissions,
        riskyPermissions: snap.risky,
        backupCount: Array.isArray(after?.backups) ? after.backups.length : 0,
        ...(runningOldVersion ? { runningOldVersion: true } : {}),
        ...(existing?.enabled && existing.needsReapproval ? { needsReapproval: true } : {}),
        notice: !existing
          ? '插件已安装，保持关闭；用户要启用时用 plugin.toggle_many，由 APP 确认。'
          : !existing.enabled
            ? '已覆盖为新版，旧版保留为备份；插件仍保持关闭。'
            : `已覆盖为新版，旧版保留为备份；插件仍保持启用。${runningOldVersion ? '运行中的仍是旧版，APP 重新启动或停用再启用后才会换成新版。' : '下次 APP 启动时载入新版。'}${existing.needsReapproval ? '新版需要重新授权，没授权前下次启动时会被自动停用。' : ''}`,
      };
    },
    summarizeResult: (result) => {
      if (result?.installed) return `plugin ${result.overwritten ? 'replaced' : 'installed'}: ${trim(result.name)} v${trim(result.version)}${result.enabled ? ' (enabled)' : ' (disabled)'}`;
      if (result?.reason === 'already_installed') return `plugin already installed: ${trim(result.name)} v${trim(result.version)}`;
      return `plugin install failed: ${trim(result?.reason)}`;
    },
  };

  /* ───────────── 插件加到界面上的内容 ───────────── */

  const uiKey = item => `${item.kind}:${item.pluginId}:${item.id}`;

  const captureUiRemove = (args = {}) => {
    const targets = listUi();
    if (!targets) return { error: failure('plugin_ui_unavailable', { message: '当前环境没有插件界面管理。' }) };
    const live = new Map(targets.map(item => [uiKey(item), item]));
    const seen = new Set();
    const items = (Array.isArray(args.items) ? args.items : []).map((raw) => {
      const query = { kind: trim(raw?.kind), pluginId: trim(raw?.pluginId), id: trim(raw?.id) };
      const key = uiKey(query);
      const found = live.get(key);
      const base = { ...query, pluginName: nameById(query.pluginId) };
      if (!found) return { ...base, status: 'missing', reason: 'not_found' };
      if (seen.has(key)) return { ...base, status: 'skipped', reason: 'duplicate_target' };
      seen.add(key);
      return { ...base, ...(found.title ? { title: found.title } : {}), ...(found.position ? { position: found.position } : {}), status: 'planned', reason: '' };
    });
    return { items, plannedCount: items.filter(item => item.status === 'planned').length };
  };

  const removeUi = (ui, item) => {
    if (item.kind === 'sidebar') return ui.unregisterSidebar?.(item.pluginId, item.id);
    if (item.kind === 'card') return ui.unregisterChatCard?.(item.pluginId, item.id);
    return ui.closeModal?.(item.pluginId, item.id);
  };

  const pluginUiRemoveTool = {
    name: 'plugin.ui.remove',
    title: 'Remove plugin UI',
    description: 'Remove sidebars and chat cards that plugins added, or close a plugin dialog, like the plugin panel\'s UI manager. items come from plugin.list ui (pluginId, id, kind: sidebar / card / modal). This affects the app while it stays open; the plugin may add them again when it reloads.',
    source: 'maid-app-content', permissions: [], riskLevel: 'medium',
    capabilities: { read: true, write: true, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'required' },
    schema: {
      type: 'object', required: ['items'], additionalProperties: false,
      properties: {
        items: {
          type: 'array', minItems: 1, maxItems: 30,
          items: {
            type: 'object', required: ['pluginId', 'id', 'kind'], additionalProperties: false,
            properties: {
              pluginId: { type: 'string', minLength: 1, maxLength: 200 },
              id: { type: 'string', minLength: 1, maxLength: 200 },
              kind: { type: 'string', enum: UI_KINDS },
            },
          },
        },
      },
    },
    safety: {
      operationType: 'remove_plugin_ui', destructive: 'conditional',
      preflight: async (args) => {
        const snap = captureUiRemove(args);
        snapshots.set(args, snap);
        if (snap.error || !snap.plannedCount) return { destructive: false };
        return confirmRequest({
          kind: 'plugin.ui.remove', operationType: 'remove_plugin_ui', danger: false, allowAlways: true,
          title: t('移除插件界面'),
          message: t('将移除 {count} 个插件加到界面上的内容。只影响这次开着的 APP，插件重新载入时可能再加回来。', { count: snap.plannedCount }),
          confirmText: t('移除'),
          items: snap.items.map(item => ({
            id: uiKey(item),
            label: `${t(UI_KIND_LABELS[item.kind] || item.kind)}「${item.title || item.id}」`,
            meta: item.pluginName && item.pluginName !== item.pluginId ? `${item.pluginName}（${item.pluginId}）` : item.pluginId,
            status: item.status,
            reason: item.reason,
          })),
          denyReason: 'plugin_ui_remove_cancelled',
          denyResult: { changed: false },
        });
      },
    },
    execute: async (args = {}, context = {}) => {
      const snap = snapshots.get(args) || captureUiRemove(args);
      if (snap.error) return snap.error;
      if (snap.plannedCount && !isAllowed(context, 'plugin.ui.remove')) return failure('confirmation_required');
      const ui = getUiManager?.();
      const results = [];
      let touched = false;
      for (const item of snap.items) {
        const base = { kind: item.kind, pluginId: item.pluginId, id: item.id, pluginName: item.pluginName };
        if (item.status !== 'planned') { results.push({ ...base, status: item.status, reason: item.reason }); continue; }
        if (context.signal?.aborted) { results.push(cancelledItem(base)); continue; }
        const key = uiKey(item);
        if (!(listUi() || []).some(entry => uiKey(entry) === key)) { results.push({ ...base, status: 'skipped', reason: 'already_absent' }); continue; }
        try {
          removeUi(ui, item);
          touched = true;
          const ok = !(listUi() || []).some(entry => uiKey(entry) === key);
          results.push({ ...base, status: ok ? 'succeeded' : 'failed', ...(ok ? {} : { reason: 'verification_failed' }) });
        } catch (error) {
          results.push({ ...base, status: 'failed', reason: 'remove_failed', errorMessage: clip(error?.message || error) });
        }
      }
      if (touched) notify();
      return batchResult('plugin.ui.remove', results, {
        requestedCount: snap.items.length,
        extra: { scope: 'current_app_session', notice: '只影响这次开着的 APP；插件重新载入（APP 重新启动或插件重新启用）时可能再加回来。' },
      });
    },
    summarizeResult: summarizeBatch('plugin UI removal'),
  };

  return [
    {
      name: 'plugin.list',
      title: 'List plugins',
      description: 'List installed plugins with id, name, version, description, mode (power = high-permission), permissions (risky ones with what they allow), enabled / blocked state, runtime status and errors, failure count, disabled reason, source and backup count, plus the sidebars, chat cards and dialog that plugins currently show (ui). runtimeAvailable is false when this environment cannot run plugins.',
      source: 'maid-app-content', permissions: [], riskLevel: 'low',
      capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'allow_once' },
      schema: { type: 'object', additionalProperties: false, properties: {} },
      execute: listPlugins,
      summarizeResult: result => (result?.ok
        ? `listed ${(result.plugins || []).length} plugin(s); ${(result.ui?.sidebars || []).length} sidebar(s), ${(result.ui?.cards || []).length} card(s)`
        : `plugin list failed: ${trim(result?.reason)}`),
    },
    pluginToggleTool,
    pluginInstallTool,
    pluginUiRemoveTool,
  ];
};

export const registerPluginAgentTools = (registry, deps = {}) => {
  if (!registry?.registerMany) return [];
  return registry.registerMany(createPluginAgentTools(deps));
};
