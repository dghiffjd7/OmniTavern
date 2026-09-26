import { appSettings } from '../storage/app-settings.js';
import { BUILTIN_PHONE_FORMAT_WORLDBOOK_ID } from '../storage/builtin-worldbooks.js';
import { ChatStore } from '../storage/chat-store.js';
import { ContactsStore } from '../storage/contacts-store.js';
import { MemoryTableStore } from '../storage/memory-table-store.js';
import { MomentSummaryStore } from '../storage/moment-summary-store.js';
import { MomentsStore } from '../storage/moments-store.js';
import { RpSessionStore } from '../storage/rp-session-store.js';
import { makeScopedKey, normalizeScopeId } from '../storage/store-scope.js';
import { stickerPackStore } from '../storage/sticker-pack-store.js';
import { customReactionAssets, customReactionImportWarning } from './chat/custom-reaction-assets.js';
import { emitDebugLog } from '../utils/debug-log.js';
import { logger } from '../utils/logger.js';
import { pickSavePath } from '../utils/save-dialog.js';
import { safeInvoke } from '../utils/tauri.js';
import { appConfirm } from './app-confirm.js';
import { createConfigRuntimeAdapter } from './config-runtime-utils.js';
import {
  buildCustomBundleArchiveConversationPayload,
  buildCustomBundleCurrentConversationPayload,
  buildCustomBundleLegacyRestoredArchives,
  buildCustomBundleRestoredArchiveMetas,
  buildCustomBundleRestoredCurrentSessionState,
  getCustomBundleImportedArchiveMessages,
  normalizeCustomBundleImportedArchivePayloads,
  selectCustomBundleConversationArchives,
} from './custom-bundle-conversation-utils.js';
import {
  buildCustomBundleImportCancelledProgressDetail,
  buildCustomBundleImportCompletionPatch,
  buildCustomBundleImportDebugLogPayload,
  buildCustomBundleImportDiagnostics,
  buildCustomBundleImportDiagnosticsState,
  buildCustomBundleImportDoneProgressDetail,
  buildCustomBundleImportFailedProgressDetail,
  buildCustomBundleImportFailureDiagnostics,
  buildCustomBundleImportFileSelectedDebugLog,
  buildCustomBundleImportPreviewProgressDetail,
  buildCustomBundleImportProgressPayload,
  buildCustomBundleImportProgressTraceEvent,
  buildCustomBundleImportReadFileProgressDetail,
  buildCustomBundleImportReadZipProgressDetail,
  buildCustomBundleImportResultPayload,
  buildCustomBundleImportSwitchConfirmOptions,
  buildCustomBundleRoleImportDiagnostics,
  cloneCustomBundleImportDiagnosticsSnapshot,
  shouldPromptCustomBundleImportSwitch,
} from './custom-bundle-import-diagnostics-utils.js';
import {
  buildCustomBundleChatImportedTarget,
  buildCustomBundleChatRoomProgressDetail,
  buildCustomBundleRoomRefCounts,
  buildCustomBundleRoomDiagnosticExtra,
  buildCustomBundleImportedContactRecord,
  buildCustomBundleRoomImportDiagnostic,
  buildCustomBundleRoomRestoreFailureNote,
  buildCustomBundleRpImportedTarget,
  buildCustomBundleRpRoomProgressDetail,
  getCustomBundleRoomMemoryFailureLogMessage,
  getCustomBundleRoomRestoreFailureLogMessage,
  getCustomBundleScopeIdFromTouchedKey,
  planCustomBundleChatRoomImports,
  planCustomBundleRpRoomImport,
  markCustomBundleTouchedRuntime,
  mapCustomBundleImportedMemberIds,
  mapCustomBundleImportedWorldIds,
  resolveCustomBundlePersonaLockId,
  resolveCustomBundleContactAvatar,
} from './custom-bundle-import-room-utils.js';
import {
  buildCustomBundleImportConfirmLines,
  buildCustomBundleImportPreview,
} from './custom-bundle-import-preview-utils.js';
import {
  buildCustomBundleManifest,
  buildCustomBundlePersonaPayload,
  buildCustomBundleRoleManifest,
} from './custom-bundle-manifest-utils.js';
import { buildCustomBundleRoomEntryPayloads } from './custom-bundle-room-entry-utils.js';
import {
  buildCustomBundleRpGreetingPayload,
  normalizeCustomBundleImportedRpGreetings,
} from './custom-bundle-rp-greeting-utils.js';
import {
  collectCustomBundleWorldbookRecords,
  getCustomBundleRoleWorldIds,
  getCustomBundleSessionWorldIds,
  mergeCustomBundleExportWorldIds,
} from './custom-bundle-worldbook-utils.js';
import { ensureDebugUiRegistry as ensureSharedDebugUiRegistry } from './debug-ui-registry-utils.js';
import { getMemoryTableStore, getMemoryTemplateStore } from './memory-store-runtime-utils.js';
import {
  bindImportedPresetToSession,
  buildRestoredPresetUpsertPayload,
  resolveImportedPresetIdByName,
} from './preset-import-dedupe-utils.js';
import { getPresetStore } from './preset-store-runtime-utils.js';
import { createRegexStoreRuntimeAdapter } from './regex-store-runtime-utils.js';
import { emitMemoryRowsUpdated } from './session-memory-event-utils.js';
import { batchCreateMemoriesWithFallback } from './session-memory-write-utils.js';
import { hasStoredWorldInfo, waitForWorldStoreReady } from './world-store-runtime-utils.js';
import { emitWorldInfoChanged, getGlobalWorldId, getGlobalWorldIds, getWorldSessionMap, replaceWorldSessionMap } from './world-session-runtime-utils.js';
import { normalizeWorldIdList } from './world-id-utils.js';
import { buildZipEntryMap, readZipEntryJson } from './zip-entry-utils.js';

const CUSTOM_BUNDLE_FORMAT = 'chatapp.custom-bundle.v1';
const CUSTOM_BUNDLE_VERSION = 1;
const CUSTOM_BUNDLE_EXTENSION = 'zip';
const WORLDINFO_STORE_KEY = 'worldinfo_store';
const WORLD_GLOBAL_IDS_SHARED_KEY = 'global_world_ids_shared_v1';
const WORLD_GLOBAL_ID_SHARED_KEY = 'global_world_id_shared_v1';
const WORLD_GLOBAL_SETTINGS_SHARED_KEY = 'world_global_settings_shared_v1';
const PRESET_TYPES = ['sysprompt', 'context', 'instruct', 'openai', 'reasoning'];
const RP_SESSION_PREFIX = 'rp:';
const OVERLAY_Z_INDEX = 23100;
const CUSTOM_BUNDLE_DIAG_HISTORY_LIMIT = 6;

const hasTauriRuntime = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return Boolean(g?.__TAURI__ || g?.__TAURI_INTERNALS__ || g?.__TAURI_INVOKE__);
};

const ensureArray = (value) => (Array.isArray(value) ? value : []);

const getPerfNow = () => {
  try {
    const perf = globalThis?.performance;
    if (perf && typeof perf.now === 'function') return perf.now();
  } catch {}
  return Date.now();
};

const roundDuration = (value) => {
  const num = Number(value || 0);
  return Number.isFinite(num) ? Math.max(0, Math.round(num)) : 0;
};

const ensureDebugUiRegistry = () => {
  try {
    return ensureSharedDebugUiRegistry(window?.appBridge);
  } catch {
    return null;
  }
};

const cloneJson = (value, fallback = null) => {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const sanitizeExportName = (value, fallback = 'download.zip') => {
  const raw = String(value || '').trim();
  const cleaned = raw.replace(/[\\/:*?"<>|]+/g, '_');
  return cleaned || fallback;
};

const slugifySegment = (value, fallback = 'item') => {
  const raw = String(value || '').trim();
  const cleaned = raw
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
};

const readFileAsArrayBuffer = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result || new ArrayBuffer(0));
    reader.onerror = () => reject(reader.error || new Error('读取失败'));
    reader.readAsArrayBuffer(file);
  });

const bytesToBase64 = (bytes) => {
  const list = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < list.length; i += chunkSize) {
    const slice = list.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
};

const textToDataUrl = (text, mime = 'application/json') => {
  const bytes = new TextEncoder().encode(String(text || ''));
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
};

const inferImageExtension = (dataUrl, fallback = 'png') => {
  const raw = String(dataUrl || '').trim();
  if (!raw.startsWith('data:')) return fallback;
  const head = raw.slice(5).split(';', 1)[0] || '';
  if (head === 'image/jpeg' || head === 'image/jpg') return 'jpg';
  if (head === 'image/webp') return 'webp';
  if (head === 'image/gif') return 'gif';
  if (head === 'image/png') return 'png';
  return fallback;
};

const inferMimeFromName = (name = '') => {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
};

const toDataUrlFromEntry = (entry, fallbackName = '') => {
  if (!entry) return '';
  const text = typeof entry.text === 'string' ? entry.text : '';
  if (text.startsWith('data:')) return text;
  const base64 = String(entry.base64 || '').trim();
  if (!base64) return '';
  const mime = inferMimeFromName(String(entry.name || fallbackName || ''));
  return `data:${mime};base64,${base64}`;
};

const isRemoteUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const normalizeWallpaperOpacity = value => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
};

const looksLikeLocalPath = (value) => {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('data:') || isRemoteUrl(raw)) return false;
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\');
};

const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(gb < 10 ? 1 : 0)} GB`;
};

const buildButtonStyle = (variant = 'default') => {
  if (variant === 'primary') {
    return 'padding:10px 14px; border:none; border-radius:10px; background:#019aff; color:var(--app-text-inverse); cursor:pointer; font-weight:800;';
  }
  if (variant === 'danger') {
    return 'padding:10px 14px; border:1px solid #fecaca; border-radius:10px; background:var(--app-surface-card); color:#b91c1c; cursor:pointer; font-weight:700;';
  }
  return 'padding:10px 14px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-card); color:var(--app-text-primary); cursor:pointer; font-weight:700;';
};

const createOverlay = ({ title = '', width = 'min(980px, 96vw)' } = {}) => {
  const overlay = document.createElement('div');
  overlay.className = 'app-themed-overlay custom-bundle-export-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(15,23,42,0.56);
    display:flex; align-items:center; justify-content:center;
    padding:16px; z-index:${OVERLAY_Z_INDEX};
  `;
  const panel = document.createElement('div');
  panel.className = 'app-themed-panel custom-bundle-export-panel';
  panel.style.cssText = `
    width:${width};
    max-height:min(88vh, 960px);
    background:var(--app-surface-card);
    border-radius:16px;
    box-shadow:0 24px 80px rgba(0,0,0,0.35);
    display:flex; flex-direction:column;
    overflow:hidden;
  `;
  panel.innerHTML = `
    <div style="padding:14px 16px; border-bottom:1px solid var(--app-border-subtle); display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <div style="font-weight:900; color:var(--app-text-primary);">${escapeHtml(title)}</div>
      <button type="button" data-role="close" style="border:none; background:transparent; color:var(--app-text-primary); font-size:22px; cursor:pointer;">×</button>
    </div>
    <div data-role="body" style="padding:16px; overflow:auto; display:flex; flex-direction:column; gap:12px;"></div>
    <div data-role="footer" style="padding:14px 16px; border-top:1px solid var(--app-border-subtle); display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap;"></div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  panel.addEventListener('click', (event) => event.stopPropagation());
  panel.querySelector('[data-role="close"]')?.addEventListener('click', close);
  return {
    overlay,
    panel,
    body: panel.querySelector('[data-role="body"]'),
    footer: panel.querySelector('[data-role="footer"]'),
    close,
  };
};

const createAssetCollector = () => {
  const usedNames = new Set();
  const entries = [];
  const allocate = (preferredName) => {
    const raw = String(preferredName || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = raw
      .split('/')
      .map((part, index, list) => {
        if (index === list.length - 1) {
          const dot = part.lastIndexOf('.');
          if (dot > 0) {
            const stem = slugifySegment(part.slice(0, dot), 'file');
            const ext = slugifySegment(part.slice(dot + 1), 'bin');
            return `${stem}.${ext}`;
          }
        }
        return slugifySegment(part, 'item');
      })
      .filter(Boolean);
    const base = parts.join('/') || 'asset.bin';
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let index = 2;
    while (index < 10000) {
      const candidate = `${stem}_${index}${ext}`;
      if (!usedNames.has(candidate)) {
        usedNames.add(candidate);
        return candidate;
      }
      index += 1;
    }
    const fallback = `${stem}_${Date.now()}${ext}`;
    usedNames.add(fallback);
    return fallback;
  };
  const addDataUrl = (preferredName, dataUrl) => {
    const payload = String(dataUrl || '').trim();
    if (!payload.startsWith('data:')) return '';
    const name = allocate(preferredName);
    entries.push({ name, data_url: payload });
    return name;
  };
  const addPath = (preferredName, path) => {
    const raw = String(path || '').trim();
    if (!raw) return '';
    const name = allocate(preferredName);
    entries.push({ name, path: raw });
    return name;
  };
  const addSource = (preferredName, source) => {
    const raw = String(source || '').trim();
    if (!raw) return '';
    if (raw.startsWith('data:')) return addDataUrl(preferredName, raw);
    if (looksLikeLocalPath(raw)) return addPath(preferredName, raw);
    return '';
  };
  return { entries, addDataUrl, addPath, addSource };
};

const normalizeSummaryList = (list = []) =>
  ensureArray(list)
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = String(item.text || '').trim();
      if (!text) return null;
      return {
        at: Number(item.at || 0) || 0,
        text,
      };
    })
    .filter(Boolean);

const normalizeCompactedSummary = (value) => {
  if (!value || typeof value !== 'object') return null;
  const text = String(value.text || '').trim();
  if (!text) return null;
  const out = {
    at: Number(value.at || 0) || 0,
    text,
  };
  const raw = String(value.raw || '').trim();
  if (raw) out.raw = raw;
  return out;
};

const normalizeCompactedSummaryRaw = (value) => {
  if (!value || typeof value !== 'object') return null;
  const raw = String(value.raw || '').trim();
  if (!raw) return null;
  return {
    at: Number(value.at || 0) || 0,
    raw,
  };
};

const mergeSummaryItems = (...sources) => {
  const map = new Map();
  sources.forEach((items) => {
    normalizeSummaryList(items).forEach((item) => {
      const at = Number(item?.at || 0) || 0;
      const text = String(item?.text || '').trim();
      if (!text) return;
      map.set(`${at}|${text}`, { at, text });
    });
  });
  return Array.from(map.values()).sort((a, b) => {
    const ta = Number(a?.at || 0) || 0;
    const tb = Number(b?.at || 0) || 0;
    if (ta !== tb) return ta - tb;
    return String(a?.text || '').localeCompare(String(b?.text || ''), 'zh-Hans-CN');
  });
};

const pickLatestByAt = (values = [], normalizer = (value) => value) => {
  const normalized = ensureArray(values).map((value) => normalizer(value)).filter(Boolean);
  if (!normalized.length) return null;
  return normalized.sort((a, b) => {
    const ta = Number(a?.at || 0) || 0;
    const tb = Number(b?.at || 0) || 0;
    if (tb !== ta) return tb - ta;
    return JSON.stringify(b).localeCompare(JSON.stringify(a), 'zh-Hans-CN');
  })[0] || null;
};

const sanitizeProfileForBundle = (profile, { hideServiceAddresses = false } = {}) => {
  if (!profile || typeof profile !== 'object') return null;
  const next = {
    ...cloneJson(profile, {}),
    id: '',
    activeKeyId: null,
    proxyAuthToken: '',
    vertexaiServiceAccount: '',
    _saEncrypted: false,
  };
  delete next.apiKey;
  delete next.createdAt;
  delete next.updatedAt;
  if (hideServiceAddresses) {
    next.baseUrl = '';
    next.proxyBaseUrl = '';
  }
  return next;
};

const isRpSessionId = (sessionId = '') => String(sessionId || '').trim().startsWith(RP_SESSION_PREFIX);

const getRpSessionId = (roleId = '') => `${RP_SESSION_PREFIX}${String(roleId || 'default').trim() || 'default'}`;

const buildRoomKey = (scopeId = '', sessionId = '') =>
  `${normalizeScopeId(scopeId) || 'shared'}::${String(sessionId || '').trim()}`;

const buildRoomSlug = (scopeId = '', sessionId = '') =>
  `${slugifySegment(normalizeScopeId(scopeId) || 'shared', 'shared')}/${slugifySegment(sessionId || 'room', 'room')}`;

const readSafeTimestamp = (value) => {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
};

const getSessionCurrentMessageCount = (chatStore, sessionId) => {
  const sid = String(sessionId || '').trim();
  if (!sid) return 0;
  const session = chatStore?.state?.sessions?.[sid] || {};
  if (chatStore?._useV2) {
    try {
      return Number(chatStore?._v2?.getThreadTotal?.(sid, '') || 0) || 0;
    } catch {
      return 0;
    }
  }
  return Array.isArray(session?.messages) ? session.messages.length : 0;
};

const chip = (text, tone = 'default') => {
  let colors = 'background:rgba(148,163,184,0.16); color:var(--app-text-muted);';
  if (tone === 'danger') colors = 'background:rgba(239,68,68,0.14); color:#ef4444;';
  if (tone === 'info') colors = 'background:rgba(1,154,255,0.14); color:#019aff;';
  if (tone === 'success') colors = 'background:rgba(34,197,94,0.14); color:#22c55e;';
  return `<span style="${colors} border-radius:999px; padding:2px 8px; font-size:11px; font-weight:700;">${escapeHtml(text)}</span>`;
};

const buildModeDescription = (mode = 'full') => {
  if (mode === 'share') return '默认保留角色与房间设定，关闭聊天正文、记忆表格和变量快照，并隐藏服务地址。';
  if (mode === 'custom') return '保留当前勾选结果，你可以继续细调角色、聊天室、动态和历史存档。';
  return '默认全选角色、聊天室、创意写作、动态与历史存档，连线设定保留但不含 API Key。';
};

const buildBundleFileName = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `chatapp_custom_export_${ts}.zip`;
};

export class CustomBundleExporter {
  constructor({
    personaStore,
    appBridge,
    getPersonaScopeKey,
    chatStore = null,
    contactsStore = null,
    rpSessionStore = null,
    memoryTableStore = null,
    memoryTemplateStore = null,
    presetStore = null,
    momentsStore = null,
    momentSummaryStore = null,
    onImportProgress = null,
  } = {}) {
    this.personaStore = personaStore || null;
    this.appBridge = appBridge || window.appBridge || null;
    this.getPersonaScopeKey = typeof getPersonaScopeKey === 'function' ? getPersonaScopeKey : ((personaId) => normalizeScopeId(personaId));
    this.chatStore = chatStore || this.appBridge?.chatStore || null;
    this.contactsStore = contactsStore || null;
    this.rpSessionStore = rpSessionStore || null;
    this.memoryTableStore = memoryTableStore || getMemoryTableStore(this.appBridge);
    this.momentsStore = momentsStore || this.appBridge?.momentsStore || null;
    this.momentSummaryStore = momentSummaryStore || this.appBridge?.momentSummaryStore || null;
    this.presetStore = presetStore || getPresetStore(this.appBridge);
    this.configManager = this.appBridge ? createConfigRuntimeAdapter(this.appBridge) : null;
    this.memoryTemplateStore = memoryTemplateStore || getMemoryTemplateStore(this.appBridge);
    this.regexStore = this.appBridge ? createRegexStoreRuntimeAdapter(this.appBridge) : null;
    this.onImportProgress = typeof onImportProgress === 'function' ? onImportProgress : null;
    this.scopeCache = new Map();
    this.worldStorePromise = null;
    this.defaultMemoryTemplatePromise = null;
    this.styleInjected = false;
  }

  ensureStyles() {
    if (this.styleInjected) return;
    this.styleInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .custom-bundle-card {
        border: 1px solid var(--app-border-subtle);
        border-radius: 14px;
        background: var(--app-surface-subtle);
        padding: 14px;
      }
      .custom-bundle-role-row,
      .custom-bundle-session-row,
      .custom-bundle-archive-row {
        border: 1px solid var(--app-border-subtle);
        border-radius: 12px;
        background: var(--app-surface-card);
      }
      .custom-bundle-role-row {
        display:flex;
        align-items:center;
        gap:12px;
        padding:12px 14px;
      }
      .custom-bundle-session-row {
        display:flex;
        flex-direction:column;
        gap:8px;
        padding:10px 12px;
      }
      .custom-bundle-session-head {
        display:flex;
        align-items:center;
        gap:10px;
      }
      .custom-bundle-archive-row {
        display:flex;
        align-items:center;
        gap:10px;
        padding:8px 10px;
      }
      .custom-bundle-avatar {
        width:42px;
        height:42px;
        border-radius:12px;
        object-fit:cover;
        background:rgba(148,163,184,0.16);
        flex:0 0 auto;
      }
      .custom-bundle-avatar-fallback {
        width:42px;
        height:42px;
        border-radius:12px;
        background:rgba(148,163,184,0.16);
        color:var(--app-text-muted);
        display:flex;
        align-items:center;
        justify-content:center;
        font-weight:800;
        flex:0 0 auto;
      }
      .custom-bundle-segment {
        display:flex;
        gap:8px;
        flex-wrap:wrap;
      }
      .custom-bundle-segment-btn {
        border:1px solid var(--app-border-default);
        border-radius:999px;
        padding:8px 12px;
        background:var(--app-surface-card);
        color:var(--app-text-secondary);
        cursor:pointer;
        font-weight:700;
      }
      .custom-bundle-segment-btn.is-active {
        border-color: rgba(1,154,255,0.45);
        background: rgba(1,154,255,0.12);
        color: var(--app-text-primary);
      }
      .custom-bundle-filter {
        display:flex;
        align-items:center;
        gap:8px;
        flex-wrap:wrap;
      }
      .custom-bundle-check {
        display:flex;
        align-items:center;
        gap:8px;
        cursor:pointer;
      }
      .custom-bundle-subtle {
        color:var(--app-text-muted);
        font-size:12px;
      }
      .custom-bundle-title {
        color:var(--app-text-primary);
        font-weight:800;
      }
      .custom-bundle-archives {
        display:flex;
        flex-direction:column;
        gap:8px;
        padding-top:4px;
      }
      .custom-bundle-expand {
        border:none;
        background:transparent;
        color:var(--app-text-muted);
        cursor:pointer;
        font-weight:700;
        padding:0;
      }
      .custom-bundle-summary {
        display:flex;
        align-items:center;
        gap:8px;
        flex-wrap:wrap;
        color:var(--app-text-primary);
        font-size:12px;
      }
      .custom-bundle-footer-actions {
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:wrap;
      }
      @media (max-width: 760px) {
        .custom-bundle-role-row {
          align-items:flex-start;
        }
        .custom-bundle-session-head {
          align-items:flex-start;
        }
      }
    `;
    document.head.appendChild(style);
  }

  async openExportWizard() {
    if (!hasTauriRuntime()) {
      window.toastr?.warning?.('当前环境不支持自定义资料包导出');
      return '';
    }
    this.ensureStyles();
    const loading = createOverlay({ title: '自定义资料包导出', width: 'min(420px, 92vw)' });
    loading.body.innerHTML = `
      <div class="custom-bundle-card" style="display:flex; align-items:center; justify-content:center; min-height:120px;">
        <div class="custom-bundle-subtle" style="font-size:14px;">正在整理角色、聊天室、动态与历史存档...</div>
      </div>
    `;
    loading.footer.innerHTML = `<button type="button" style="${buildButtonStyle()}">关闭</button>`;
    loading.footer.querySelector('button')?.addEventListener('click', () => loading.close());
    try {
      await this.personaStore?.ready;
      await this.presetStore?.ready;
      await this.regexStore?.ready;
      const roles = await this.collectRoleEntries();
      loading.close();
      if (!roles.length) {
        window.toastr?.info?.('当前没有可导出的角色数据');
        return '';
      }
      return this.showWizard(roles);
    } catch (err) {
      loading.close();
      window.toastr?.error?.(err?.message || '整理导出数据失败');
      throw err;
    }
  }

  async getWorldStoreMap() {
    if (this.worldStorePromise) return this.worldStorePromise;
    this.worldStorePromise = (async () => {
      try {
        const kv = await safeInvoke('load_kv', { name: WORLDINFO_STORE_KEY });
        if (kv && typeof kv === 'object' && !kv._tooLarge) return kv;
      } catch (err) {
        logger.debug('load world store for custom bundle failed', err);
      }
      return {};
    })();
    return this.worldStorePromise;
  }

  async getDefaultMemoryTemplate() {
    if (this.defaultMemoryTemplatePromise) return this.defaultMemoryTemplatePromise;
    this.defaultMemoryTemplatePromise = (async () => {
      const store = this.memoryTemplateStore;
      if (!store?.getTemplates) return null;
      try {
        const list = await store.getTemplates({ is_default: true });
        if (Array.isArray(list) && list.length) return cloneJson(list[0], null);
      } catch {}
      try {
        const fallback = await store.getTemplates({ id: 'default-v1' });
        if (Array.isArray(fallback) && fallback.length) return cloneJson(fallback[0], null);
      } catch {}
      return null;
    })();
    return this.defaultMemoryTemplatePromise;
  }

  publishImportDiagnostics(snapshot) {
    const payload = cloneCustomBundleImportDiagnosticsSnapshot(snapshot);
    if (!payload) return;
    try {
      const registry = ensureDebugUiRegistry();
      if (registry) {
        const current = registry.stores?.customBundleDiagnostics;
        registry.stores.customBundleDiagnostics = buildCustomBundleImportDiagnosticsState({
          currentState: current,
          snapshot: payload,
          historyLimit: CUSTOM_BUNDLE_DIAG_HISTORY_LIMIT,
        });
      }
    } catch {}
    try {
      emitDebugLog(buildCustomBundleImportDebugLogPayload(payload));
    } catch {}
  }

  reportImportProgress(detail = {}) {
    const payload = buildCustomBundleImportProgressPayload({ detail, at: Date.now() });
    try {
      window.dispatchEvent(new CustomEvent('custom-bundle-import-progress', { detail: payload }));
    } catch {}
    try {
      this.onImportProgress?.(payload);
    } catch {}
    try {
      const registry = this.appBridge?.debugUiRegistry || window.appBridge?.debugUiRegistry || null;
      const actionRecordTraceEvent = registry?.actions?.recordTraceEvent;
      const timelineRecordTraceEvent = registry?.stores?.traceTimeline?.record;
      const recordTraceEvent = typeof actionRecordTraceEvent === 'function'
        ? actionRecordTraceEvent
        : (typeof timelineRecordTraceEvent === 'function' ? timelineRecordTraceEvent : null);
      recordTraceEvent?.(buildCustomBundleImportProgressTraceEvent(payload));
    } catch {}
    return payload;
  }

  buildRoomImportDiagnostic(runtime, sessionId, roomPackage, extra = {}) {
    return buildCustomBundleRoomImportDiagnostic({
      runtime,
      sessionId,
      roomPackage,
      extra,
      getSessionWorldIds: (currentRuntime, sid) => this.getSessionWorldIds(currentRuntime, sid),
    });
  }

  buildMomentsImportDiagnostic(runtime, momentsPayload, extra = {}) {
    const summaryStore = runtime?.momentSummaryStore || null;
    return {
      ...cloneJson(extra, {}),
      scopeId: normalizeScopeId(runtime?.momentsStore?.scopeId || runtime?.scopeId || ''),
      expectedMoments: ensureArray(momentsPayload?.moments).length,
      storedMoments: ensureArray(runtime?.momentsStore?.list?.()).length,
      expectedSummaries: normalizeSummaryList(momentsPayload?.summaries || []).length,
      storedSummaries: normalizeSummaryList(summaryStore?.getSummaries?.() || summaryStore?.state?.summaries || []).length,
      expectedCompactedSummary: Boolean(normalizeCompactedSummary(momentsPayload?.compactedSummary || null)),
      storedCompactedSummary: Boolean(
        normalizeCompactedSummary(summaryStore?.getCompactedSummary?.() || summaryStore?.state?.compactedSummary || null),
      ),
    };
  }

  async loadScopedKv(baseKey, scopeId = '', { fallbackLegacy = true } = {}) {
    const scope = normalizeScopeId(scopeId);
    const key = makeScopedKey(baseKey, scope);
    try {
      const kv = await safeInvoke('load_kv', { name: key });
      if (kv && !kv._tooLarge) return kv;
    } catch {}
    if (fallbackLegacy && scope === 'default') {
      try {
        const legacy = await safeInvoke('load_kv', { name: baseKey });
        if (legacy && !legacy._tooLarge) return legacy;
      } catch {}
    }
    return null;
  }

  async getScopeRuntime(scopeId = '') {
    const normalized = normalizeScopeId(scopeId);
    const liveScopeId = normalizeScopeId(this.chatStore?.scopeId || this.appBridge?.scopeId || '');
    const canUseLiveRuntime =
      this.chatStore
      && this.contactsStore
      && this.rpSessionStore
      && this.momentsStore
      && this.momentSummaryStore
      && liveScopeId === normalized;
    if (canUseLiveRuntime) {
      await Promise.allSettled([
        this.chatStore?.ready,
        this.chatStore?._v2Ready,
        this.contactsStore?.ready,
        this.rpSessionStore?.ready,
        this.memoryTableStore?.ready,
        this.momentsStore?.ready,
        this.momentSummaryStore?.ready,
      ]);
      return {
        scopeId: normalized,
        chatStore: this.chatStore,
        contactsStore: this.contactsStore,
        rpSessionStore: this.rpSessionStore,
        getMemoryTableStore: () => this.memoryTableStore,
        momentsStore: this.momentsStore,
        momentSummaryStore: this.momentSummaryStore,
        worldSessionMap: getWorldSessionMap(this.appBridge),
        globalWorldId: getGlobalWorldId(this.appBridge),
        globalWorldIds: getGlobalWorldIds(this.appBridge),
        worldGlobalSettings:
          this.appBridge?.worldGlobalSettings && typeof this.appBridge.worldGlobalSettings === 'object'
            ? this.appBridge.worldGlobalSettings
            : {},
      };
    }
    const cacheKey = normalized || '__shared__';
    if (this.scopeCache.has(cacheKey)) return this.scopeCache.get(cacheKey);
    const runtimePromise = (async () => {
      const chatStore = new ChatStore({ scopeId: normalized });
      const contactsStore = new ContactsStore({ scopeId: normalized });
      const rpSessionStore = new RpSessionStore({ scopeId: normalized });
      const momentsStore = new MomentsStore({ scopeId: normalized });
      const momentSummaryStore = new MomentSummaryStore({ scopeId: normalized });
      let memoryTableStore = null;
      await Promise.allSettled([
        chatStore.ready,
        chatStore._v2Ready,
        contactsStore.ready,
        rpSessionStore.ready,
        momentsStore.ready,
        momentSummaryStore.ready,
      ]);
      const worldSessionMap = (await this.loadScopedKv('world_session_map_v1', normalized)) || {};
      let globalWorldIds = [];
      let globalWorldIdsLoaded = false;
      try {
        const shared = await safeInvoke('load_kv', { name: WORLD_GLOBAL_IDS_SHARED_KEY });
        if (Array.isArray(shared) || typeof shared === 'string') {
          globalWorldIds = normalizeWorldIdList(shared);
          globalWorldIdsLoaded = true;
        }
      } catch {}
      if (!globalWorldIdsLoaded) {
        try {
          const shared = await safeInvoke('load_kv', { name: WORLD_GLOBAL_ID_SHARED_KEY });
          if (typeof shared === 'string') {
            globalWorldIds = normalizeWorldIdList(shared);
            globalWorldIdsLoaded = true;
          }
        } catch {}
      }
      if (!globalWorldIdsLoaded) {
        try {
          const legacy = await safeInvoke('load_kv', { name: makeScopedKey('global_world_id_v1', normalized) });
          if (typeof legacy === 'string') globalWorldIds = normalizeWorldIdList(legacy);
        } catch {}
      }
      let worldGlobalSettings = {};
      try {
        const shared = await safeInvoke('load_kv', { name: WORLD_GLOBAL_SETTINGS_SHARED_KEY });
        if (shared && typeof shared === 'object' && !shared._tooLarge) worldGlobalSettings = shared;
      } catch {}
      if (!Object.keys(worldGlobalSettings || {}).length) {
        try {
          const legacy = await safeInvoke('load_kv', { name: makeScopedKey('world_global_settings_v1', normalized) });
          if (legacy && typeof legacy === 'object' && !legacy._tooLarge) worldGlobalSettings = legacy;
        } catch {}
      }
      return {
        scopeId: normalized,
        chatStore,
        contactsStore,
        rpSessionStore,
        getMemoryTableStore: () => {
          if (!memoryTableStore) memoryTableStore = new MemoryTableStore({ scopeId: normalized });
          return memoryTableStore;
        },
        momentsStore,
        momentSummaryStore,
        worldSessionMap: worldSessionMap && typeof worldSessionMap === 'object' ? worldSessionMap : {},
        globalWorldId: globalWorldIds[0] || '',
        globalWorldIds,
        worldGlobalSettings: worldGlobalSettings && typeof worldGlobalSettings === 'object' ? worldGlobalSettings : {},
      };
    })();
    this.scopeCache.set(cacheKey, runtimePromise);
    return runtimePromise;
  }

  async flushRuntimeState(runtime) {
    if (!runtime || typeof runtime !== 'object') return;
    try {
      await runtime.chatStore?.flush?.();
    } catch {}
    try {
      await runtime.momentsStore?.flush?.();
    } catch {}
    try {
      const contactsPayload = {
        ...(runtime.contactsStore?.state || { contacts: {} }),
        scopeId: normalizeScopeId(runtime.contactsStore?.scopeId || runtime.scopeId || ''),
      };
      if (runtime.contactsStore?.storeKey) {
        try {
          localStorage.setItem(runtime.contactsStore.storeKey, JSON.stringify(contactsPayload));
        } catch {}
        await safeInvoke('save_kv', { name: runtime.contactsStore.storeKey, data: contactsPayload });
      }
    } catch {}
    try {
      if (runtime.rpSessionStore?.persistenceBlocked !== true) {
        await runtime.rpSessionStore?.flush?.();
      }
    } catch {}
    try {
      const summaryPayload = runtime.momentSummaryStore?.state && typeof runtime.momentSummaryStore.state === 'object'
        ? cloneJson(runtime.momentSummaryStore.state, {})
        : { version: 1, summaries: [], compactedSummary: null, compactedSummaryLastRaw: null };
      if (runtime.momentSummaryStore?.storeKey) {
        try {
          localStorage.setItem(runtime.momentSummaryStore.storeKey, JSON.stringify(summaryPayload));
        } catch {}
        await safeInvoke('save_kv', { name: runtime.momentSummaryStore.storeKey, data: summaryPayload });
      }
    } catch {}
  }

  getSessionWorldIds(runtime, sessionId) {
    return getCustomBundleSessionWorldIds(runtime, sessionId);
  }

  getRoleWorldIds(role) {
    return getCustomBundleRoleWorldIds(role);
  }

  remapPersonaSource(sourceInput, worldIdMap = {}) {
    const source = sourceInput && typeof sourceInput === 'object'
      ? cloneJson(sourceInput, {})
      : {};
    const worldbookId = String(source?.worldbookId || '').trim();
    if (worldbookId) {
      source.worldbookId = String(worldIdMap?.[worldbookId] || worldbookId).trim();
      if (source.worldbookEnabled === undefined) source.worldbookEnabled = true;
    } else {
      source.worldbookId = '';
      if (source.worldbookEnabled === undefined) source.worldbookEnabled = true;
    }
    return source;
  }

  buildContactDescriptor(runtime, sessionId, contact = null) {
    const sid = String(sessionId || '').trim();
    const fallback = contact && typeof contact === 'object' ? contact : {};
    const archives = ensureArray(runtime?.chatStore?.getArchives?.(sid)).map((archive) => ({
      id: String(archive?.id || '').trim(),
      name: String(archive?.name || '').trim(),
      timestamp: Number(archive?.timestamp || 0) || 0,
      messageCount: Number(archive?.messageCount || 0) || 0,
      hasSummary: normalizeSummaryList(archive?.summaries || []).length > 0,
      hasCompactedSummary: Boolean(normalizeCompactedSummary(archive?.compactedSummary || null)),
      hasMemorySnapshot: Boolean(archive?.memoryTableSnapshot),
    })).filter((archive) => archive.id);
    const lastMessageAt = readSafeTimestamp(runtime?.chatStore?.getLastMessage?.(sid)?.timestamp || 0);
    return {
      id: sid,
      name: String(fallback?.name || sid),
      avatar: String(fallback?.avatar || ''),
      description: String(fallback?.description || ''),
      labels: ensureArray(fallback?.labels).map(String),
      members: ensureArray(fallback?.members).map(String),
      libraryTags: ensureArray(fallback?.libraryTags).map(String),
      isGroup: fallback?.isGroup === true || sid.startsWith('group:'),
      currentMessageCount: getSessionCurrentMessageCount(runtime?.chatStore, sid),
      hasCurrentDraft: Boolean(String(runtime?.chatStore?.getDraft?.(sid) || '').trim()),
      worldIds: this.getSessionWorldIds(runtime, sid),
      archives,
      lastMessageAt,
      hasSettings: Boolean(runtime?.chatStore?.getSessionSettings?.(sid)),
    };
  }

  buildRpDescriptor(role, runtime) {
    const sid = getRpSessionId(role?.id);
    const archives = ensureArray(runtime?.chatStore?.getArchives?.(sid)).map((archive) => ({
      id: String(archive?.id || '').trim(),
      name: String(archive?.name || '').trim(),
      timestamp: Number(archive?.timestamp || 0) || 0,
      messageCount: Number(archive?.messageCount || 0) || 0,
      hasSummary: normalizeSummaryList(archive?.summaries || []).length > 0,
      hasCompactedSummary: Boolean(normalizeCompactedSummary(archive?.compactedSummary || null)),
      hasMemorySnapshot: Boolean(archive?.memoryTableSnapshot),
    })).filter((archive) => archive.id);
    const greetings = ensureArray(runtime?.rpSessionStore?.getGreetings?.());
    return {
      id: sid,
      name: role?.name || '创意写作',
      avatar: String(role?.avatar || ''),
      currentMessageCount: getSessionCurrentMessageCount(runtime?.chatStore, sid),
      hasCurrentDraft: Boolean(String(runtime?.chatStore?.getDraft?.(sid) || '').trim()),
      worldIds: this.getSessionWorldIds(runtime, sid),
      archives,
      greetingCount: greetings.length,
      activeGreetingId: String(runtime?.rpSessionStore?.getActiveGreetingId?.() || '').trim(),
      hasSettings: Boolean(runtime?.chatStore?.getSessionSettings?.(sid)),
      hasMeaningfulData:
        greetings.length > 0
        || getSessionCurrentMessageCount(runtime?.chatStore, sid) > 0
        || archives.length > 0
        || Boolean(String(runtime?.chatStore?.getDraft?.(sid) || '').trim())
        || Boolean(runtime?.chatStore?.getSessionSettings?.(sid)),
    };
  }

  buildMomentsDescriptor(runtime) {
    const moments = ensureArray(runtime?.momentsStore?.exportState?.()?.moments || runtime?.momentsStore?.list?.());
    const summaries = normalizeSummaryList(
      runtime?.momentSummaryStore?.getSummaries?.() || runtime?.momentSummaryStore?.state?.summaries || [],
    );
    const compactedSummary = normalizeCompactedSummary(
      runtime?.momentSummaryStore?.getCompactedSummary?.() || runtime?.momentSummaryStore?.state?.compactedSummary || null,
    );
    return {
      momentCount: moments.length,
      summaryCount: summaries.length,
      hasCompactedSummary: Boolean(compactedSummary),
      hasMeaningfulData: moments.length > 0 || summaries.length > 0 || Boolean(compactedSummary),
    };
  }

  async collectRoleEntries() {
    const personas = ensureArray(this.personaStore?.getAll?.()).filter((persona) => persona?.id);
    const sharedContacts = appSettings.get().personaBindContacts === false;
    const roles = [];
    for (const persona of personas) {
      const scopeId = normalizeScopeId(this.getPersonaScopeKey(persona.id) || '');
      const runtime = await this.getScopeRuntime(scopeId);
      const contacts = ensureArray(runtime?.contactsStore?.listContacts?.());
      const orderedIds = [];
      const seen = new Set();
      const pushId = (id) => {
        const sid = String(id || '').trim();
        if (!sid || isRpSessionId(sid) || seen.has(sid)) return;
        seen.add(sid);
        orderedIds.push(sid);
      };
      ensureArray(runtime?.chatStore?.listSessions?.()).forEach(pushId);
      contacts.forEach((contact) => pushId(contact?.id));
      const contactsMap = new Map(contacts.map((contact) => [String(contact?.id || '').trim(), contact]));
      const chats = orderedIds.map((sid) => this.buildContactDescriptor(runtime, sid, contactsMap.get(sid))).sort((a, b) => {
        const ta = Number(a?.lastMessageAt || 0) || 0;
        const tb = Number(b?.lastMessageAt || 0) || 0;
        if (tb !== ta) return tb - ta;
        return String(a?.name || a?.id || '').localeCompare(String(b?.name || b?.id || ''), 'zh-Hans-CN');
      });
      const rp = this.buildRpDescriptor(persona, runtime);
      const moments = this.buildMomentsDescriptor(runtime);
      const archiveCount = chats.reduce((sum, item) => sum + ensureArray(item?.archives).length, 0) + ensureArray(rp?.archives).length;
      roles.push({
        id: String(persona.id || '').trim(),
        name: String(persona.name || '').trim() || '角色',
        avatar: String(persona.avatar || '').trim(),
        description: String(persona.description || ''),
        source: cloneJson(persona.source || null, null),
        originalCard: cloneJson(persona.originalCard || null, null),
        userBubbleColor: String(persona.userBubbleColor || ''),
        userTextColor: String(persona.userTextColor || ''),
        position: Number(persona.position || 0) || 0,
        depth: Number(persona.depth || 0) || 0,
        roleValue: Number(persona.role || 0) || 0,
        created: Number(persona.created || 0) || 0,
        updated: Number(persona.updated || 0) || 0,
        scopeId,
        sharedContacts,
        chats,
        rp,
        moments,
        stats: {
          chatCount: chats.length,
          rpCount: 1,
          archiveCount,
          momentCount: moments.momentCount,
          momentSummaryCount: moments.summaryCount,
          hasMomentCompactedSummary: moments.hasCompactedSummary,
        },
      });
    }
    return roles;
  }

  makeDefaultRoleSelection(role, { includeConversationContent = true } = {}) {
    const chats = {};
    ensureArray(role?.chats).forEach((chat) => {
      const archives = {};
      ensureArray(chat?.archives).forEach((archive) => {
        archives[String(archive.id || '').trim()] = true;
      });
      chats[String(chat?.id || '').trim()] = {
        selected: true,
        expanded: false,
        archives,
      };
    });
    const rpArchives = {};
    ensureArray(role?.rp?.archives).forEach((archive) => {
      rpArchives[String(archive.id || '').trim()] = true;
    });
    return {
      selected: true,
      includeChats: true,
      includeRp: true,
      includeMoments: role?.moments?.hasMeaningfulData === true,
      chats,
      moments: {
        selected: role?.moments?.hasMeaningfulData === true,
      },
      rp: {
        selected: true,
        expanded: false,
        archives: rpArchives,
      },
      ui: {
        openChatArchives: includeConversationContent,
      },
    };
  }

  createState(roles, mode = 'full') {
    const state = {
      mode,
      view: {
        activeRoleId: '',
        query: '',
        onlySelected: false,
        onlyChats: false,
        onlyCreative: false,
      },
      options: {
        includeConversationContent: true,
        includeMemoryData: true,
        includeVariableState: true,
        hideServiceAddresses: false,
      },
      roles: {},
    };
    if (mode === 'share') {
      state.options.includeConversationContent = false;
      state.options.includeMemoryData = false;
      state.options.includeVariableState = false;
      state.options.hideServiceAddresses = true;
    }
    roles.forEach((role) => {
      state.roles[role.id] = this.makeDefaultRoleSelection(role, {
        includeConversationContent: state.options.includeConversationContent,
      });
    });
    return state;
  }

  applyModePreset(state, roles, mode = 'full') {
    const next = this.createState(roles, mode);
    state.mode = next.mode;
    state.options = next.options;
    state.roles = next.roles;
  }

  markCustomMode(state) {
    if (state.mode !== 'custom') state.mode = 'custom';
  }

  resetRoleToDefault(state, role) {
    const defaults = this.makeDefaultRoleSelection(role, {
      includeConversationContent: state.options.includeConversationContent,
    });
    state.roles[role.id] = defaults;
  }

  setRoleSelected(state, role, checked) {
    const next = Boolean(checked);
    const current = state.roles[role.id];
    if (!current) return;
    current.selected = next;
    current.includeChats = next;
    current.includeRp = next;
    current.includeMoments = next && role?.moments?.hasMeaningfulData === true;
    if (current.moments) current.moments.selected = current.includeMoments;
    Object.values(current.chats || {}).forEach((chatSel) => {
      chatSel.selected = next;
      Object.keys(chatSel.archives || {}).forEach((archiveId) => {
        chatSel.archives[archiveId] = next;
      });
    });
    current.rp.selected = next;
    Object.keys(current.rp.archives || {}).forEach((archiveId) => {
      current.rp.archives[archiveId] = next;
    });
  }

  getSessionSelection(state, roleId, sessionId) {
    return state.roles?.[roleId]?.chats?.[sessionId] || null;
  }

  computeRoleProgress(role, selection) {
    const totalChats = ensureArray(role?.chats).length;
    const totalRp = role?.rp ? 1 : 0;
    const totalMoments = role?.moments?.hasMeaningfulData ? 1 : 0;
    const totalArchives = ensureArray(role?.chats).reduce((sum, chat) => sum + ensureArray(chat?.archives).length, 0)
      + ensureArray(role?.rp?.archives).length;
    const totalUnits = totalChats + totalRp + totalMoments + totalArchives;
    if (!selection) return { checked: false, indeterminate: false, selectedUnits: 0, totalUnits };
    let selectedUnits = 0;
    if (selection.includeChats) {
      ensureArray(role?.chats).forEach((chat) => {
        const chatSel = selection.chats?.[chat.id];
        if (chatSel?.selected) selectedUnits += 1;
        ensureArray(chat?.archives).forEach((archive) => {
          if (chatSel?.archives?.[archive.id]) selectedUnits += 1;
        });
      });
    }
    if (role?.rp && selection.includeRp) {
      if (selection.rp?.selected) selectedUnits += 1;
      ensureArray(role?.rp?.archives).forEach((archive) => {
        if (selection.rp?.archives?.[archive.id]) selectedUnits += 1;
      });
    }
    if (role?.moments?.hasMeaningfulData && selection.includeMoments && selection.moments?.selected) {
      selectedUnits += 1;
    }
    const checked =
      Boolean(selection.selected)
      && totalUnits > 0
      && selectedUnits === totalUnits
      && selection.includeChats === true
      && selection.includeRp === true
      && (role?.moments?.hasMeaningfulData ? selection.includeMoments === true : true);
    const indeterminate = selectedUnits > 0 && !checked;
    return { checked, indeterminate, selectedUnits, totalUnits };
  }

  computeSectionProgress(items = [], sectionSelection = {}, { enabled = true } = {}) {
    const totalRows = items.length;
    const totalArchives = items.reduce((sum, item) => sum + ensureArray(item?.archives).length, 0);
    const totalUnits = totalRows + totalArchives;
    let selectedUnits = 0;
    items.forEach((item) => {
      const rowSel = sectionSelection?.[item.id] || null;
      if (rowSel?.selected) selectedUnits += 1;
      ensureArray(item?.archives).forEach((archive) => {
        if (rowSel?.archives?.[archive.id]) selectedUnits += 1;
      });
    });
    const checked = Boolean(enabled) && totalUnits > 0 && selectedUnits === totalUnits;
    const indeterminate = selectedUnits > 0 && !checked;
    return { checked, indeterminate, selectedUnits, totalUnits };
  }

  computeSummary(roles, state) {
    const roleCount = new Set();
    const chatRooms = new Set();
    const rpRooms = new Set();
    const archives = new Set();
    let moments = 0;
    let momentScopes = 0;
    let momentSummaries = 0;
    let momentCompacted = 0;
    roles.forEach((role) => {
      const selection = state.roles?.[role.id];
      if (!selection?.selected) return;
      roleCount.add(role.id);
      if (selection.includeChats) {
        ensureArray(role?.chats).forEach((chat) => {
          const chatSel = selection.chats?.[chat.id];
          if (!chatSel?.selected) return;
          const roomKey = buildRoomKey(role.scopeId, chat.id);
          chatRooms.add(roomKey);
          ensureArray(chat?.archives).forEach((archive) => {
            if (chatSel.archives?.[archive.id]) {
              archives.add(`${roomKey}::${archive.id}`);
            }
          });
        });
      }
      if (selection.includeRp && selection.rp?.selected && role?.rp?.id) {
        const roomKey = buildRoomKey(role.scopeId, role.rp.id);
        rpRooms.add(roomKey);
        ensureArray(role?.rp?.archives).forEach((archive) => {
          if (selection.rp?.archives?.[archive.id]) {
            archives.add(`${roomKey}::${archive.id}`);
          }
        });
      }
      if (selection.includeMoments && selection.moments?.selected && role?.moments?.hasMeaningfulData) {
        momentScopes += 1;
        moments += Number(role?.moments?.momentCount || 0) || 0;
        momentSummaries += Number(role?.moments?.summaryCount || 0) || 0;
        if (role?.moments?.hasCompactedSummary) momentCompacted += 1;
      }
    });
    const chips = [];
    if (state.options.includeConversationContent) chips.push(chip('含聊天正文', 'danger'));
    else chips.push(chip('仅设定资源', 'info'));
    if (momentScopes > 0) chips.push(chip('含动态内容', 'danger'));
    if (state.options.includeMemoryData) chips.push(chip('含记忆表格', 'danger'));
    if (state.options.includeVariableState) chips.push(chip('含变量快照', 'danger'));
    if (state.options.hideServiceAddresses) chips.push(chip('已隐藏服务地址', 'success'));
    else chips.push(chip('保留服务地址', 'info'));
    return {
      roles: roleCount.size,
      chats: chatRooms.size,
      creative: rpRooms.size,
      archives: archives.size,
      moments,
      momentScopes,
      momentSummaries,
      momentCompacted,
      chips,
    };
  }

  getFilteredRoles(roles, state) {
    const query = String(state.view.query || '').trim().toLowerCase();
    return roles.filter((role) => {
      const selection = state.roles?.[role.id];
      const progress = this.computeRoleProgress(role, selection);
      if (state.view.onlySelected && !(progress.checked || progress.indeterminate)) return false;
      if (state.view.onlyChats && ensureArray(role?.chats).length <= 0) return false;
      if (state.view.onlyCreative && !role?.rp?.hasMeaningfulData) return false;
      if (!query) return true;
      const targets = [
        role.name,
        role.id,
        ...ensureArray(role?.chats).map((chat) => chat?.name || chat?.id),
      ].map((value) => String(value || '').toLowerCase());
      return targets.some((value) => value.includes(query));
    });
  }

  renderAvatar(value = '', label = '') {
    const src = String(value || '').trim();
    if (src) {
      return `<img class="custom-bundle-avatar" src="${escapeHtml(src)}" alt="">`;
    }
    const initials = String(label || '').trim().slice(0, 1) || '角';
    return `<div class="custom-bundle-avatar-fallback">${escapeHtml(initials)}</div>`;
  }

  renderModeCard(state) {
    return `
      <div class="custom-bundle-card">
        <div class="custom-bundle-title" style="margin-bottom:10px;">导出模式</div>
        <div class="custom-bundle-segment" style="margin-bottom:10px;">
          <button type="button" class="custom-bundle-segment-btn ${state.mode === 'full' ? 'is-active' : ''}" data-action="mode" data-mode="full">完整迁移</button>
          <button type="button" class="custom-bundle-segment-btn ${state.mode === 'share' ? 'is-active' : ''}" data-action="mode" data-mode="share">分享精简</button>
          <button type="button" class="custom-bundle-segment-btn ${state.mode === 'custom' ? 'is-active' : ''}" data-action="mode" data-mode="custom">自定义</button>
        </div>
        <div class="custom-bundle-subtle">${escapeHtml(buildModeDescription(state.mode))}</div>
      </div>
    `;
  }

  renderGlobalOptions(state) {
    return `
      <div class="custom-bundle-card">
        <div class="custom-bundle-title" style="margin-bottom:10px;">运行时内容</div>
        <div style="display:flex; flex-direction:column; gap:8px;">
          <label class="custom-bundle-check">
            <input type="checkbox" data-action="toggle-option" data-key="includeConversationContent" ${state.options.includeConversationContent ? 'checked' : ''}>
            <span>包含聊天正文与创作正文</span>
          </label>
          <label class="custom-bundle-check">
            <input type="checkbox" data-action="toggle-option" data-key="includeMemoryData" ${state.options.includeMemoryData ? 'checked' : ''}>
            <span>包含记忆表格已填数据</span>
          </label>
          <label class="custom-bundle-check">
            <input type="checkbox" data-action="toggle-option" data-key="includeVariableState" ${state.options.includeVariableState ? 'checked' : ''}>
            <span>包含变量当前值与初始值快照</span>
          </label>
          <label class="custom-bundle-check">
            <input type="checkbox" data-action="toggle-option" data-key="hideServiceAddresses" ${state.options.hideServiceAddresses ? 'checked' : ''}>
            <span>隐藏服务地址（分享推荐）</span>
          </label>
        </div>
      </div>
    `;
  }

  renderRoleList(roles, state) {
    const filtered = this.getFilteredRoles(roles, state);
    return `
      ${this.renderModeCard(state)}
      ${this.renderGlobalOptions(state)}
      <div class="custom-bundle-card">
        <div style="display:flex; flex-direction:column; gap:10px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
            <label class="custom-bundle-check">
              <input type="checkbox" data-action="toggle-all-roles">
              <span>全选所有角色</span>
            </label>
            <input type="search" value="${escapeHtml(state.view.query)}" data-action="query" placeholder="搜索角色或聊天室" style="min-width:220px; flex:1 1 240px; max-width:360px; border-radius:10px; border:1px solid var(--app-border-default); background:var(--app-surface-card); color:var(--app-text-primary); padding:10px 12px;">
          </div>
          <div class="custom-bundle-filter">
            <label class="custom-bundle-check">
              <input type="checkbox" data-action="toggle-filter" data-key="onlySelected" ${state.view.onlySelected ? 'checked' : ''}>
              <span>仅看已选</span>
            </label>
            <label class="custom-bundle-check">
              <input type="checkbox" data-action="toggle-filter" data-key="onlyChats" ${state.view.onlyChats ? 'checked' : ''}>
              <span>仅看含聊天</span>
            </label>
            <label class="custom-bundle-check">
              <input type="checkbox" data-action="toggle-filter" data-key="onlyCreative" ${state.view.onlyCreative ? 'checked' : ''}>
              <span>仅看含创作</span>
            </label>
          </div>
        </div>
      </div>
      <div style="display:flex; flex-direction:column; gap:10px;">
        ${filtered.length ? filtered.map((role) => {
          const selection = state.roles?.[role.id];
          const progress = this.computeRoleProgress(role, selection);
          const sharedHint = role.sharedContacts ? `<div class="custom-bundle-subtle">联系人与聊天室为共享范围</div>` : '';
          return `
            <div class="custom-bundle-role-row" data-role-row="${escapeHtml(role.id)}">
              <input type="checkbox" data-action="toggle-role" data-role-id="${escapeHtml(role.id)}" ${progress.checked ? 'checked' : ''}>
              ${this.renderAvatar(role.avatar, role.name)}
              <div style="min-width:0; flex:1 1 auto;">
                <div class="custom-bundle-title" style="margin-bottom:4px;">${escapeHtml(role.name)}</div>
                <div class="custom-bundle-subtle">聊天 ${role.stats.chatCount} · 创作 1 · 动态 ${role.stats.momentCount}${role.stats.momentSummaryCount ? ` / 摘要 ${role.stats.momentSummaryCount}` : ''}${role.stats.hasMomentCompactedSummary ? ' / 大总结' : ''} · 存档 ${role.stats.archiveCount}</div>
                ${sharedHint}
              </div>
              <button type="button" data-action="open-role" data-role-id="${escapeHtml(role.id)}" style="border:none; background:transparent; color:var(--app-text-muted); cursor:pointer; font-size:18px;">›</button>
            </div>
          `;
        }).join('') : `<div class="custom-bundle-card"><div class="custom-bundle-subtle">没有匹配的角色。</div></div>`}
      </div>
    `;
  }

  renderArchiveRows(roleId, section, sessionId, archives = [], selection, disabled = false) {
    if (!archives.length) {
      return `<div class="custom-bundle-subtle" style="padding-left:28px;">暂无历史存档</div>`;
    }
    return `
      <div class="custom-bundle-archives">
        ${archives.map((archive) => `
          <label class="custom-bundle-archive-row ${disabled ? 'is-disabled' : ''}" style="${disabled ? 'opacity:0.55;' : ''}">
            <input type="checkbox"
                   data-action="toggle-archive"
                   data-role-id="${escapeHtml(roleId)}"
                   data-section="${escapeHtml(section)}"
                   data-session-id="${escapeHtml(sessionId)}"
                   data-archive-id="${escapeHtml(archive.id)}"
                   ${selection?.archives?.[archive.id] ? 'checked' : ''}
                   ${disabled ? 'disabled' : ''}>
            <div style="min-width:0; flex:1 1 auto;">
              <div class="custom-bundle-title" style="font-size:13px; margin-bottom:2px;">${escapeHtml(archive.name || archive.id)}</div>
              <div class="custom-bundle-subtle">消息 ${archive.messageCount || 0}${archive.hasSummary ? ' · 含摘要' : ''}${archive.hasCompactedSummary ? ' · 含大总结' : ''}${archive.hasMemorySnapshot ? ' · 含记忆快照' : ''}</div>
            </div>
          </label>
        `).join('')}
      </div>
    `;
  }

  renderChatSection(role, state) {
    const selection = state.roles?.[role.id];
    const chats = ensureArray(role?.chats);
    const progress = this.computeSectionProgress(chats, selection?.chats || {}, {
      enabled: selection?.includeChats === true,
    });
    const contentDisabled = state.options.includeConversationContent !== true;
    return `
      <div class="custom-bundle-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap;">
          <label class="custom-bundle-check">
            <input type="checkbox" data-action="toggle-role-section" data-role-id="${escapeHtml(role.id)}" data-section="chat" ${progress.checked ? 'checked' : ''}>
            <span class="custom-bundle-title">聊天界面</span>
          </label>
          <div class="custom-bundle-subtle">${contentDisabled ? '当前模式不含正文，仅导出聊天室设定与资源。' : '可逐个选择联系人与历史存档。'}</div>
        </div>
        <div style="display:flex; flex-direction:column; gap:10px;">
          ${chats.length ? chats.map((chat) => {
            const chatSel = selection?.chats?.[chat.id];
            return `
              <div class="custom-bundle-session-row" data-session-row="${escapeHtml(chat.id)}">
                <div class="custom-bundle-session-head">
                  <input type="checkbox" data-action="toggle-session" data-role-id="${escapeHtml(role.id)}" data-section="chat" data-session-id="${escapeHtml(chat.id)}" ${chatSel?.selected ? 'checked' : ''}>
                  ${this.renderAvatar(chat.avatar, chat.name)}
                  <div style="min-width:0; flex:1 1 auto;">
                    <div class="custom-bundle-title" style="margin-bottom:4px;">${escapeHtml(chat.name || chat.id)}</div>
                    <div class="custom-bundle-subtle">当前 ${chat.currentMessageCount || 0} 条${chat.archives.length ? ` · 存档 ${chat.archives.length}` : ''}${chat.worldIds.length ? ` · 世界书 ${chat.worldIds.length}` : ''}</div>
                  </div>
                  ${chat.archives.length ? `<button type="button" class="custom-bundle-expand" data-action="toggle-archives-expand" data-role-id="${escapeHtml(role.id)}" data-section="chat" data-session-id="${escapeHtml(chat.id)}">${chatSel?.expanded ? '收起存档' : '展开存档'}</button>` : ''}
                </div>
                ${chatSel?.expanded ? this.renderArchiveRows(role.id, 'chat', chat.id, chat.archives, chatSel, contentDisabled) : ''}
              </div>
            `;
          }).join('') : `<div class="custom-bundle-subtle">该角色下暂无聊天室。</div>`}
        </div>
      </div>
    `;
  }

  renderRpSection(role, state) {
    const selection = state.roles?.[role.id];
    const rp = role?.rp || null;
    const contentDisabled = state.options.includeConversationContent !== true;
    if (!rp) {
      return `
        <div class="custom-bundle-card">
          <div class="custom-bundle-title">创意写作</div>
          <div class="custom-bundle-subtle" style="margin-top:8px;">当前没有可导出的创意写作会话。</div>
        </div>
      `;
    }
    return `
      <div class="custom-bundle-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap;">
          <label class="custom-bundle-check">
            <input type="checkbox" data-action="toggle-role-section" data-role-id="${escapeHtml(role.id)}" data-section="rp" ${selection?.includeRp && selection?.rp?.selected ? 'checked' : ''}>
            <span class="custom-bundle-title">创意写作</span>
          </label>
          <div class="custom-bundle-subtle">${contentDisabled ? '当前模式不含正文，仅导出创作设定与资源。' : '可导出当前创作会话与历史存档。'}</div>
        </div>
        <div class="custom-bundle-session-row">
          <div class="custom-bundle-session-head">
            <input type="checkbox" data-action="toggle-rp" data-role-id="${escapeHtml(role.id)}" ${selection?.rp?.selected ? 'checked' : ''}>
            ${this.renderAvatar(role.avatar, role.name)}
            <div style="min-width:0; flex:1 1 auto;">
              <div class="custom-bundle-title" style="margin-bottom:4px;">${escapeHtml(role.name)} · 创意写作</div>
              <div class="custom-bundle-subtle">当前 ${rp.currentMessageCount || 0} 条 · 开场白 ${rp.greetingCount || 0}${rp.archives.length ? ` · 存档 ${rp.archives.length}` : ''}</div>
            </div>
            ${rp.archives.length ? `<button type="button" class="custom-bundle-expand" data-action="toggle-archives-expand" data-role-id="${escapeHtml(role.id)}" data-section="rp" data-session-id="${escapeHtml(rp.id)}">${selection?.rp?.expanded ? '收起存档' : '展开存档'}</button>` : ''}
          </div>
          ${selection?.rp?.expanded ? this.renderArchiveRows(role.id, 'rp', rp.id, rp.archives, selection.rp, contentDisabled) : ''}
        </div>
      </div>
    `;
  }

  renderMomentsSection(role, state) {
    const selection = state.roles?.[role.id];
    const moments = role?.moments || {};
    if (!moments?.hasMeaningfulData) {
      return `
        <div class="custom-bundle-card">
          <div class="custom-bundle-title">动态</div>
          <div class="custom-bundle-subtle" style="margin-top:8px;">当前没有可导出的动态或动态摘要。</div>
        </div>
      `;
    }
    return `
      <div class="custom-bundle-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap;">
          <label class="custom-bundle-check">
            <input type="checkbox" data-action="toggle-role-section" data-role-id="${escapeHtml(role.id)}" data-section="moments" ${selection?.includeMoments && selection?.moments?.selected ? 'checked' : ''}>
            <span class="custom-bundle-title">动态</span>
          </label>
          <div class="custom-bundle-subtle">导出当前角色的动态正文与动态摘要。</div>
        </div>
        <div class="custom-bundle-session-row">
          <div class="custom-bundle-session-head">
            ${this.renderAvatar(role.avatar, role.name)}
            <div style="min-width:0; flex:1 1 auto;">
              <div class="custom-bundle-title" style="margin-bottom:4px;">${escapeHtml(role.name)} · 动态</div>
              <div class="custom-bundle-subtle">当前 ${moments.momentCount || 0} 条${moments.summaryCount ? ` · 摘要 ${moments.summaryCount}` : ''}${moments.hasCompactedSummary ? ' · 含大总结' : ''}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderRoleDetail(role, state) {
    return `
      ${this.renderModeCard(state)}
      ${this.renderGlobalOptions(state)}
      <div class="custom-bundle-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <button type="button" data-action="back-to-list" style="${buildButtonStyle()}">返回角色列表</button>
          <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
            <label class="custom-bundle-check">
              <input type="checkbox" data-action="toggle-role" data-role-id="${escapeHtml(role.id)}">
              <span>全选该角色全部内容</span>
            </label>
            <button type="button" data-action="reset-role" data-role-id="${escapeHtml(role.id)}" style="${buildButtonStyle()}">恢复默认</button>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:12px; margin-top:12px;">
          ${this.renderAvatar(role.avatar, role.name)}
          <div style="min-width:0;">
            <div class="custom-bundle-title">${escapeHtml(role.name)}</div>
            <div class="custom-bundle-subtle">${escapeHtml(role.sharedContacts ? '联系人与聊天室为共享范围，动态也会按当前作用域导出。' : '当前角色下的聊天室、创意写作和动态可分别勾选。')}</div>
          </div>
        </div>
      </div>
      ${this.renderChatSection(role, state)}
      ${this.renderRpSection(role, state)}
      ${this.renderMomentsSection(role, state)}
    `;
  }

  syncRenderedCheckboxStates(container, roles, state) {
    const findByDataset = (selector, matcher) =>
      Array.from(container.querySelectorAll(selector)).find((node) => matcher(node?.dataset || {})) || null;
    const allToggle = container.querySelector('[data-action="toggle-all-roles"]');
    if (allToggle) {
      const progressList = roles.map((role) => this.computeRoleProgress(role, state.roles?.[role.id]));
      const checkedCount = progressList.filter((item) => item.checked).length;
      const partial = progressList.some((item) => item.indeterminate);
      allToggle.checked = roles.length > 0 && checkedCount === roles.length;
      allToggle.indeterminate = !allToggle.checked && (checkedCount > 0 || partial);
    }
    roles.forEach((role) => {
      const selection = state.roles?.[role.id];
      const progress = this.computeRoleProgress(role, selection);
      const roleToggle = findByDataset('[data-action="toggle-role"]', (data) => String(data.roleId || '') === role.id);
      if (roleToggle) {
        roleToggle.checked = progress.checked;
        roleToggle.indeterminate = progress.indeterminate;
      }
      const chatToggle = findByDataset(
        '[data-action="toggle-role-section"]',
        (data) => String(data.roleId || '') === role.id && String(data.section || '') === 'chat',
      );
      if (chatToggle) {
        const chatProgress = this.computeSectionProgress(ensureArray(role?.chats), selection?.chats || {}, {
          enabled: selection?.includeChats === true,
        });
        chatToggle.checked = chatProgress.checked;
        chatToggle.indeterminate = chatProgress.indeterminate;
      }
      const rpToggle = findByDataset(
        '[data-action="toggle-role-section"]',
        (data) => String(data.roleId || '') === role.id && String(data.section || '') === 'rp',
      );
      if (rpToggle) {
        const rpItems = role?.rp ? [role.rp] : [];
        const rpProgress = this.computeSectionProgress(rpItems, role?.rp ? { [role.rp.id]: selection?.rp || {} } : {}, {
          enabled: selection?.includeRp === true,
        });
        rpToggle.checked = rpProgress.checked;
        rpToggle.indeterminate = rpProgress.indeterminate;
      }
      const momentsToggle = findByDataset(
        '[data-action="toggle-role-section"]',
        (data) => String(data.roleId || '') === role.id && String(data.section || '') === 'moments',
      );
      if (momentsToggle) {
        const checked = Boolean(role?.moments?.hasMeaningfulData) && selection?.includeMoments === true && selection?.moments?.selected === true;
        momentsToggle.checked = checked;
        momentsToggle.indeterminate = false;
      }
    });
  }

  async showWizard(roles) {
    const state = this.createState(roles, 'full');
    const modal = createOverlay({ title: '自定义资料包导出', width: 'min(960px, 96vw)' });
    let exporting = false;
    const render = () => {
      const activeRole = roles.find((role) => role.id === state.view.activeRoleId) || null;
      modal.body.innerHTML = activeRole ? this.renderRoleDetail(activeRole, state) : this.renderRoleList(roles, state);
      const summary = this.computeSummary(roles, state);
      modal.footer.innerHTML = `
        <div class="custom-bundle-summary">
          <span>角色 ${summary.roles}</span>
          <span>聊天室 ${summary.chats}</span>
          <span>创作 ${summary.creative}</span>
          <span>动态 ${summary.moments}</span>
          <span>存档 ${summary.archives}</span>
          ${summary.chips.join('')}
        </div>
        <div class="custom-bundle-footer-actions">
          <button type="button" data-action="close" style="${buildButtonStyle()}">关闭</button>
          <button type="button" data-action="export" style="${buildButtonStyle('primary')}" ${exporting ? 'disabled' : ''}>${exporting ? '打包中...' : '导出'}</button>
        </div>
      `;
      this.bindWizardEvents(modal, roles, state, render);
      this.syncRenderedCheckboxStates(modal.body, roles, state);
    };
    render();
    modal.footer.addEventListener('click', async (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = target?.dataset?.action || '';
      if (action === 'close') {
        modal.close();
        return;
      }
      if (action !== 'export' || exporting) return;
      exporting = true;
      render();
      try {
        const savedPath = await this.exportSelected(roles, state);
        if (savedPath) {
          modal.close();
          return savedPath;
        }
      } finally {
        exporting = false;
        render();
      }
    });
    return '';
  }

  bindWizardEvents(modal, roles, state, render) {
    modal.body.querySelectorAll('[data-action="mode"]').forEach((button) => {
      button.addEventListener('click', async () => {
        const mode = String(button.dataset.mode || '').trim() || 'custom';
        if (mode === 'custom') {
          state.mode = 'custom';
          render();
          return;
        }
        const changed = state.mode !== mode;
        if (changed) {
          this.applyModePreset(state, roles, mode);
        }
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="toggle-option"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target) return;
        const key = String(target.dataset.key || '').trim();
        if (!key) return;
        state.options[key] = target.checked;
        this.markCustomMode(state);
        render();
      });
    });

    modal.body.querySelector('[data-action="toggle-all-roles"]')?.addEventListener('change', (event) => {
      const checked = Boolean(event?.target?.checked);
      roles.forEach((role) => this.setRoleSelected(state, role, checked));
      this.markCustomMode(state);
      render();
    });

    modal.body.querySelectorAll('[data-action="toggle-role"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target) return;
        const roleId = String(target.dataset.roleId || '').trim();
        const role = roles.find((item) => item.id === roleId);
        if (!role) return;
        this.setRoleSelected(state, role, target.checked);
        this.markCustomMode(state);
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="query"]').forEach((input) => {
      input.addEventListener('input', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        state.view.query = String(target?.value || '');
        const caret = Number(target?.selectionStart || 0);
        render();
        const next = modal.body.querySelector('[data-action="query"]');
        if (next instanceof HTMLInputElement) {
          next.focus();
          try {
            next.setSelectionRange(caret, caret);
          } catch {}
        }
      });
    });

    modal.body.querySelectorAll('[data-action="toggle-filter"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target) return;
        const key = String(target.dataset.key || '').trim();
        state.view[key] = target.checked;
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="open-role"]').forEach((button) => {
      button.addEventListener('click', () => {
        state.view.activeRoleId = String(button.dataset.roleId || '').trim();
        render();
      });
    });

    modal.body.querySelector('[data-action="back-to-list"]')?.addEventListener('click', () => {
      state.view.activeRoleId = '';
      render();
    });

    modal.body.querySelectorAll('[data-action="reset-role"]').forEach((button) => {
      button.addEventListener('click', () => {
        const roleId = String(button.dataset.roleId || '').trim();
        const role = roles.find((item) => item.id === roleId);
        if (!role) return;
        this.resetRoleToDefault(state, role);
        this.markCustomMode(state);
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="toggle-role-section"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target) return;
        const roleId = String(target.dataset.roleId || '').trim();
        const section = String(target.dataset.section || '').trim();
        const selection = state.roles?.[roleId];
        const role = roles.find((item) => item.id === roleId);
        if (!selection || !role) return;
        const checked = target.checked;
        if (section === 'chat') {
          selection.includeChats = checked;
          ensureArray(role?.chats).forEach((chat) => {
            const chatSel = selection.chats?.[chat.id];
            if (!chatSel) return;
            chatSel.selected = checked;
            Object.keys(chatSel.archives || {}).forEach((archiveId) => {
              chatSel.archives[archiveId] = checked;
            });
          });
        } else if (section === 'rp') {
          selection.includeRp = checked;
          if (selection.rp) {
            selection.rp.selected = checked;
            Object.keys(selection.rp.archives || {}).forEach((archiveId) => {
              selection.rp.archives[archiveId] = checked;
            });
          }
        } else if (section === 'moments') {
          selection.includeMoments = checked && role?.moments?.hasMeaningfulData === true;
          if (selection.moments) selection.moments.selected = selection.includeMoments;
        }
        selection.selected = selection.includeChats || selection.includeRp || selection.includeMoments;
        this.markCustomMode(state);
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="toggle-session"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target) return;
        const roleId = String(target.dataset.roleId || '').trim();
        const sessionId = String(target.dataset.sessionId || '').trim();
        const selection = this.getSessionSelection(state, roleId, sessionId);
        const roleSel = state.roles?.[roleId];
        if (!selection || !roleSel) return;
        selection.selected = target.checked;
        Object.keys(selection.archives || {}).forEach((archiveId) => {
          selection.archives[archiveId] = target.checked;
        });
        roleSel.includeChats = true;
        roleSel.selected = true;
        this.markCustomMode(state);
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="toggle-rp"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target) return;
        const roleId = String(target.dataset.roleId || '').trim();
        const roleSel = state.roles?.[roleId];
        if (!roleSel?.rp) return;
        roleSel.rp.selected = target.checked;
        Object.keys(roleSel.rp.archives || {}).forEach((archiveId) => {
          roleSel.rp.archives[archiveId] = target.checked;
        });
        roleSel.includeRp = true;
        roleSel.selected = true;
        this.markCustomMode(state);
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="toggle-archives-expand"]').forEach((button) => {
      button.addEventListener('click', () => {
        const roleId = String(button.dataset.roleId || '').trim();
        const section = String(button.dataset.section || '').trim();
        const sessionId = String(button.dataset.sessionId || '').trim();
        const roleSel = state.roles?.[roleId];
        if (!roleSel) return;
        if (section === 'chat') {
          const chatSel = roleSel.chats?.[sessionId];
          if (chatSel) chatSel.expanded = !chatSel.expanded;
        } else if (section === 'rp' && roleSel.rp) {
          roleSel.rp.expanded = !roleSel.rp.expanded;
        }
        render();
      });
    });

    modal.body.querySelectorAll('[data-action="toggle-archive"]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const target = event.target instanceof HTMLInputElement ? event.target : null;
        if (!target) return;
        const roleId = String(target.dataset.roleId || '').trim();
        const section = String(target.dataset.section || '').trim();
        const sessionId = String(target.dataset.sessionId || '').trim();
        const archiveId = String(target.dataset.archiveId || '').trim();
        const roleSel = state.roles?.[roleId];
        if (!roleSel) return;
        if (section === 'chat') {
          const chatSel = roleSel.chats?.[sessionId];
          if (!chatSel) return;
          chatSel.archives[archiveId] = target.checked;
          chatSel.selected = true;
          roleSel.includeChats = true;
        } else if (section === 'rp' && roleSel.rp) {
          roleSel.rp.archives[archiveId] = target.checked;
          roleSel.rp.selected = true;
          roleSel.includeRp = true;
        }
        roleSel.selected = true;
        this.markCustomMode(state);
        render();
      });
    });
  }

  async loadPersonaCardData(role) {
    if (role?.originalCard && typeof role.originalCard === 'object') {
      return cloneJson(role.originalCard, null);
    }
    try {
      return cloneJson(await this.appBridge?.loadPersonaCard?.(role.id), null);
    } catch (err) {
      logger.debug('load persona card for custom bundle failed', err);
      return null;
    }
  }

  async collectWorldbookRecords(worldIds = []) {
    const store = await this.getWorldStoreMap();
    return collectCustomBundleWorldbookRecords({
      worldIds,
      worldStoreMap: store,
      getWorldInfo: id => this.appBridge?.getWorldInfo?.(id),
      cloneWorldbook: value => cloneJson(value, {}),
      onError: err => logger.warn('collect worldbook for custom bundle failed', err),
    });
  }

  collectRegexBundle(sessionId, worldIds = []) {
    const sid = String(sessionId || '').trim();
    const regexStore = this.regexStore;
    const sessionRegex = cloneJson(regexStore?.getSession?.(sid) || null, null);
    const localSets = ensureArray(regexStore?.listLocalSets?.())
      .filter((set) => set?.bind?.type === 'world' && worldIds.includes(String(set.bind.worldId || '').trim()))
      .map((set) => cloneJson(set, null))
      .filter(Boolean);
    return {
      session: sessionRegex,
      localSets,
    };
  }

  collectVariableCore(chatStore, sessionId) {
    const sid = String(sessionId || '').trim();
    return {
      schemas: cloneJson(chatStore?.listVariableSchemas?.(sid) || {}, {}),
      rules: cloneJson(chatStore?.listVariableRules?.(sid) || [], []),
      stageSchema: cloneJson(chatStore?.getStageSchema?.(sid) || null, null),
    };
  }

  collectVariableState(chatStore, sessionId) {
    const sid = String(sessionId || '').trim();
    return {
      values: cloneJson(chatStore?.listVariables?.(sid) || {}, {}),
      initialValues: cloneJson(chatStore?.listInitialVariables?.(sid) || {}, {}),
    };
  }

  collectResolvedPresetBundle(sessionId, uiMode = 'chat') {
    const sid = String(sessionId || '').trim();
    const store = this.presetStore;
    if (!store) return { presets: {} };
    const presets = {};
    PRESET_TYPES.forEach((type) => {
      try {
        const resolved = store.getResolvedActive?.(type, { sessionId: sid, uiMode }) || null;
        if (!resolved?.preset) return;
        presets[type] = {
          name: String(resolved.preset?.name || type),
          source: String(resolved.source || 'global'),
          data: cloneJson(resolved.preset, {}),
        };
      } catch (err) {
        logger.warn('collect resolved preset for custom bundle failed', err);
      }
    });
    return { presets };
  }

  async collectConnectionProfileBundle(sessionId, { hideServiceAddresses = false, uiMode = 'chat' } = {}) {
    const sid = String(sessionId || '').trim();
    const presetStore = this.presetStore;
    const configManager = this.configManager;
    if (!presetStore || !configManager) return { profile: null, reasoning: null };
    try {
      await configManager.ensureStores?.();
    } catch {}
    let profileId = '';
    try {
      profileId =
        String(presetStore.getSessionProfileId?.('openai', sid) || '').trim()
        || String(presetStore.getModeProfileId?.('openai', uiMode) || '').trim()
        || String(configManager.getActiveProfileId?.() || '').trim();
    } catch {}
    let profile = null;
    if (profileId) {
      try {
        profile = configManager.getProfileById?.(profileId) || null;
      } catch {}
    }
    if (!profile) {
      try {
        profile = configManager.getActiveProfile?.() || null;
      } catch {}
    }
    const reasoning = cloneJson(
      presetStore.getSessionReasoning?.('openai', sid)
      || presetStore.getModeReasoning?.('openai', uiMode)
      || null,
      null,
    );
    return {
      profile: sanitizeProfileForBundle(profile, { hideServiceAddresses }),
      reasoning,
    };
  }

  collectWallpaperBundle(settings, assets, basePath) {
    const wallpaper = settings?.wallpaper;
    if (!wallpaper || typeof wallpaper !== 'object') return null;
    const path = String(wallpaper.path || '').trim();
    const url = String(wallpaper.url || wallpaper.dataUrl || '').trim();
    const source = path || url;
    const ext = path ? inferMimeFromName(path).split('/')[1] || 'png' : inferImageExtension(url, 'png');
    const file = assets.addSource(`${basePath}/wallpaper.${ext}`, source);
    if (file) {
      return {
        file,
        remoteUrl: '',
        meta: {
          name: String(wallpaper.name || ''),
          zoom: Number(wallpaper.zoom || 1) || 1,
          rotate: Number(wallpaper.rotate || 0) || 0,
          offsetX: Number(wallpaper.offsetX || 0) || 0,
          offsetY: Number(wallpaper.offsetY || 0) || 0,
          width: Number(wallpaper.width || 0) || 0,
          height: Number(wallpaper.height || 0) || 0,
          opacity: normalizeWallpaperOpacity(wallpaper.opacity ?? 1),
          saveOriginal: wallpaper.saveOriginal === true,
        },
      };
    }
    if (isRemoteUrl(url)) {
      return {
        file: '',
        remoteUrl: url,
        meta: {
          name: String(wallpaper.name || ''),
          zoom: Number(wallpaper.zoom || 1) || 1,
          rotate: Number(wallpaper.rotate || 0) || 0,
          offsetX: Number(wallpaper.offsetX || 0) || 0,
          offsetY: Number(wallpaper.offsetY || 0) || 0,
          width: Number(wallpaper.width || 0) || 0,
          height: Number(wallpaper.height || 0) || 0,
          opacity: normalizeWallpaperOpacity(wallpaper.opacity ?? 1),
        },
      };
    }
    return null;
  }

  collectStickerBundle(sessionId, assets, basePath) {
    const sid = String(sessionId || '').trim();
    const packs = ensureArray(stickerPackStore.getPacks?.()).filter((pack) => ensureArray(pack?.boundSessions).includes(sid));
    return packs.map((pack, packIndex) => {
      const packSlug = slugifySegment(pack?.name || pack?.id || `pack_${packIndex + 1}`, `pack_${packIndex + 1}`);
      const iconSource = String(pack?.iconDataUrl || pack?.iconPath || '').trim();
      const iconFile = assets.addSource(`${basePath}/stickers/${packSlug}/icon.${inferImageExtension(iconSource, 'png')}`, iconSource);
      const stickers = ensureArray(pack?.stickers).map((sticker, stickerIndex) => {
        const stickerSlug = slugifySegment(sticker?.name || sticker?.id || `sticker_${stickerIndex + 1}`, `sticker_${stickerIndex + 1}`);
        const stickerSource = String(sticker?.dataUrl || sticker?.path || '').trim();
        const assetFile = assets.addSource(
          `${basePath}/stickers/${packSlug}/${stickerSlug}.${inferImageExtension(stickerSource, 'png')}`,
          stickerSource,
        );
        const frameFiles = ensureArray(sticker?.frames)
          .map((frame, frameIndex) => assets.addSource(
            `${basePath}/stickers/${packSlug}/${stickerSlug}_frame_${String(frameIndex + 1).padStart(2, '0')}.${inferImageExtension(frame, 'png')}`,
            frame,
          ))
          .filter(Boolean);
        return {
          id: String(sticker?.id || ''),
          name: String(sticker?.name || ''),
          keyword: String(sticker?.keyword || ''),
          fps: Number(sticker?.fps || 0) || 0,
          assetFile: assetFile || '',
          frameFiles,
        };
      });
      return {
        id: String(pack?.id || ''),
        name: String(pack?.name || ''),
        colorIndex: Number(pack?.colorIndex || 0) || 0,
        aiEnabled: pack?.aiEnabled === true,
        iconFile: iconFile || '',
        iconMeta: cloneJson(pack?.iconMeta || {}, {}),
        stickers,
      };
    });
  }

  async collectMemorySnapshot(memoryTableStore, sessionId, { isGroup = false } = {}) {
    if (!memoryTableStore?.getMemories) return null;
    const templateRecord = await this.getDefaultMemoryTemplate();
    const templateId = String(templateRecord?.id || '').trim();
    if (!templateId) return null;
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    let rows = [];
    try {
      rows = await memoryTableStore.getMemories({
        scope: isGroup ? 'group' : 'contact',
        group_id: isGroup ? sid : undefined,
        contact_id: isGroup ? undefined : sid,
        template_id: templateId,
      });
    } catch {
      return null;
    }
    const picked = Array.isArray(rows)
      ? rows.map((row) => {
        const tableId = String(row?.table_id || '').trim();
        if (!tableId) return null;
        return {
          id: String(row?.id || '').trim(),
          table_id: tableId,
          row_data: row?.row_data ?? {},
          is_active: row?.is_active !== false,
          is_pinned: Boolean(row?.is_pinned),
          priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : 0,
          sort_order: Number.isFinite(Number(row?.sort_order)) ? Number(row.sort_order) : 0,
        };
      }).filter(Boolean)
      : [];
    return { templateId, rows: picked };
  }

  async buildRoomBundle({ role, runtime, descriptor, uiMode = 'chat', selection, options, assets, worldbookIds }) {
    const sid = String(descriptor?.id || '').trim();
    const basePath = `rooms/${buildRoomSlug(role.scopeId, sid)}`;
    const chatStore = runtime.chatStore;
    const rawSettings = cloneJson(chatStore?.getSessionSettings?.(sid) || {}, {});
    const wallpaper = this.collectWallpaperBundle(rawSettings, assets, `${basePath}/assets`);
    const memoryTemplate = await this.getDefaultMemoryTemplate();
    const worldIds = this.getSessionWorldIds(runtime, sid);
    const roleWorldIds = this.getRoleWorldIds(role);
    const exportWorldIds = mergeCustomBundleExportWorldIds(worldIds, roleWorldIds);
    exportWorldIds.forEach((worldId) => worldbookIds.add(worldId));
    const roomConfig = {
      sessionSettings: rawSettings,
      personaLockId: String(chatStore?.getPersonaLock?.(sid) || '').trim(),
      wallpaper,
      presets: this.collectResolvedPresetBundle(sid, uiMode),
      connection: await this.collectConnectionProfileBundle(sid, {
        hideServiceAddresses: options.hideServiceAddresses === true,
        uiMode,
      }),
      stickers: this.collectStickerBundle(sid, assets, `${basePath}/assets`),
      memoryTemplateId: String(memoryTemplate?.id || '').trim(),
      world: {
        worldIds,
        globalWorldId: String(runtime?.globalWorldId || '').trim(),
        globalWorldIds: normalizeWorldIdList(runtime?.globalWorldIds),
        globalSettings: cloneJson(runtime?.worldGlobalSettings || {}, {}),
      },
      regex: this.collectRegexBundle(sid, exportWorldIds),
      variables: {
        core: this.collectVariableCore(chatStore, sid),
        state: options.includeVariableState ? this.collectVariableState(chatStore, sid) : null,
      },
    };
    const content = options.includeConversationContent
      ? await this.buildConversationContent({ runtime, descriptor, selection, options })
      : null;
    const memoryData = options.includeMemoryData
      ? await this.collectMemorySnapshot(runtime?.getMemoryTableStore?.(), sid, { isGroup: Boolean(descriptor?.isGroup) })
      : null;
    roomConfig.reactions = customReactionAssets.collect([
      ...(content?.current?.messages || []), ...(content?.archives || []).flatMap(archive => archive.messages || []),
    ], assets, `${basePath}/assets/reactions`);
    const contactPayload = uiMode === 'chat'
      ? this.buildContactPayload(descriptor, assets, `${basePath}/assets`)
      : null;
    const rpGreetingPayload = uiMode === 'rp'
      ? buildCustomBundleRpGreetingPayload({
        greetings: runtime?.rpSessionStore?.getGreetings?.(),
        activeGreetingId: runtime?.rpSessionStore?.getActiveGreetingId?.(),
      })
      : null;
    return {
      key: buildRoomKey(role.scopeId, sid),
      basePath,
      sessionId: sid,
      scopeId: role.scopeId,
      uiMode,
      roomConfig,
      content,
      memoryData,
      contactPayload,
      rpGreetingPayload,
    };
  }

  buildContactPayload(descriptor, assets, basePath) {
    const avatarRaw = String(descriptor?.avatar || '').trim();
    const avatarFile = assets.addSource(`${basePath}/contact_avatar.${inferImageExtension(avatarRaw, 'png')}`, avatarRaw);
    return {
      id: String(descriptor?.id || '').trim(),
      name: String(descriptor?.name || '').trim(),
      description: String(descriptor?.description || '').trim(),
      labels: ensureArray(descriptor?.labels).map(String),
      members: ensureArray(descriptor?.members).map(String),
      libraryTags: ensureArray(descriptor?.libraryTags).map(String),
      isGroup: descriptor?.isGroup === true,
      avatarFile: avatarFile || '',
      avatarValue: avatarFile ? '' : avatarRaw,
    };
  }

  async buildConversationContent({ runtime, descriptor, selection, options }) {
    const sid = String(descriptor?.id || '').trim();
    if (!sid) return null;
    const session = runtime?.chatStore?.state?.sessions?.[sid] || {};
    const currentMessages = ensureArray(await runtime?.chatStore?.exportThreadMessages?.(sid, ''));
    const current = buildCustomBundleCurrentConversationPayload({
      session,
      messages: currentMessages,
    });
    const selectedArchives = selectCustomBundleConversationArchives({
      archives: descriptor?.archives,
      selection,
    });
    const archives = await Promise.all(selectedArchives.map(async (archive) => {
      const archiveId = String(archive?.id || '').trim();
      if (!archiveId) return null;
      const source = ensureArray(runtime?.chatStore?.getArchives?.(sid)).find((item) => String(item?.id || '').trim() === archiveId) || {};
      const messages = ensureArray(await runtime?.chatStore?.exportThreadMessages?.(sid, archiveId));
      return buildCustomBundleArchiveConversationPayload({
        archive,
        source,
        messages,
        includeMemoryData: options?.includeMemoryData,
      });
    }));
    return {
      current,
      archives: archives.filter(Boolean),
    };
  }

  async addRoomEntries(bundle, room) {
    const pushJson = (name, payload) => {
      bundle.entries.push({
        name,
        data_url: textToDataUrl(JSON.stringify(payload, null, 2), 'application/json'),
      });
    };
    for (const { name, payload } of buildCustomBundleRoomEntryPayloads(room)) {
      pushJson(name, payload);
    }
  }

  buildMomentsBundle(runtime, assets, roleBase) {
    const sourceMoments = ensureArray(runtime?.momentsStore?.exportState?.()?.moments || runtime?.momentsStore?.list?.());
    const summaries = normalizeSummaryList(
      runtime?.momentSummaryStore?.getSummaries?.() || runtime?.momentSummaryStore?.state?.summaries || [],
    );
    const compactedSummary = normalizeCompactedSummary(
      runtime?.momentSummaryStore?.getCompactedSummary?.() || runtime?.momentSummaryStore?.state?.compactedSummary || null,
    );
    const compactedSummaryLastRaw = normalizeCompactedSummaryRaw(
      runtime?.momentSummaryStore?.state?.compactedSummaryLastRaw || null,
    );
    if (!sourceMoments.length && !summaries.length && !compactedSummary) return null;
    const moments = sourceMoments.map((moment, index) => {
      const next = cloneJson(moment, {});
      const avatarRaw = String(next?.authorAvatar || '').trim();
      const avatarFile = assets.addSource(
        `${roleBase}/assets/moments/${slugifySegment(next?.authorId || next?.author || `moment_${index}`, 'moment')}_${index}.${inferImageExtension(avatarRaw, 'png')}`,
        avatarRaw,
      );
      delete next.authorAvatar;
      if (avatarFile) next.authorAvatarFile = avatarFile;
      else if (avatarRaw) next.authorAvatarValue = avatarRaw;
      return next;
    });
    return {
      exported: true,
      momentCount: moments.length,
      summaryCount: summaries.length,
      hasCompactedSummary: Boolean(compactedSummary),
      moments,
      summaries,
      compactedSummary,
      compactedSummaryLastRaw,
    };
  }

  async buildPackage(roles, state) {
    const assets = createAssetCollector();
    const manifestRoles = [];
    const roomMap = new Map();
    const worldbookIds = new Set();
    const entries = [];
    const templateRecord = await this.getDefaultMemoryTemplate();

    for (const role of roles) {
      const selection = state.roles?.[role.id];
      if (!selection?.selected) continue;
      const roleSlug = slugifySegment(role.name || role.id, role.id);
      const roleBase = `roles/${roleSlug}`;
      const roleManifest = buildCustomBundleRoleManifest(role);
      const personaAvatarRaw = String(role.avatar || '').trim();
      const personaAvatarFile = assets.addSource(`${roleBase}/assets/persona_avatar.${inferImageExtension(personaAvatarRaw, 'png')}`, personaAvatarRaw);
      const personaCard = await this.loadPersonaCardData(role);
      const personaPayload = buildCustomBundlePersonaPayload({
        role,
        avatarFile: personaAvatarFile || '',
        avatarValue: personaAvatarFile ? '' : personaAvatarRaw,
      });
      this.getRoleWorldIds(role).forEach((worldId) => worldbookIds.add(worldId));
      entries.push({
        name: `${roleBase}/persona.json`,
        data_url: textToDataUrl(JSON.stringify(personaPayload, null, 2), 'application/json'),
      });
      if (personaCard) {
        entries.push({
          name: `${roleBase}/persona_original_card.json`,
          data_url: textToDataUrl(JSON.stringify(personaCard, null, 2), 'application/json'),
        });
      }
      const runtime = await this.getScopeRuntime(role.scopeId);
      if (selection.includeMoments && selection.moments?.selected) {
        const momentsPayload = this.buildMomentsBundle(runtime, assets, roleBase);
        if (momentsPayload) {
          roleManifest.hasMoments = true;
          entries.push({
            name: `${roleBase}/moments.json`,
            data_url: textToDataUrl(JSON.stringify(momentsPayload, null, 2), 'application/json'),
          });
        }
      }
      if (selection.includeChats) {
        for (const chat of ensureArray(role?.chats)) {
          const chatSel = selection.chats?.[chat.id];
          if (!chatSel?.selected) continue;
          const roomKey = buildRoomKey(role.scopeId, chat.id);
          roleManifest.chats.push(roomKey);
          if (!roomMap.has(roomKey)) {
            roomMap.set(roomKey, await this.buildRoomBundle({
              role,
              runtime,
              descriptor: chat,
              uiMode: 'chat',
              selection: chatSel,
              options: state.options,
              assets,
              worldbookIds,
            }));
          }
        }
      }
      if (selection.includeRp && selection.rp?.selected && role?.rp?.id) {
        const roomKey = buildRoomKey(role.scopeId, role.rp.id);
        roleManifest.creativeWriting = roomKey;
        if (!roomMap.has(roomKey)) {
          roomMap.set(roomKey, await this.buildRoomBundle({
            role,
            runtime,
            descriptor: role.rp,
            uiMode: 'rp',
            selection: selection.rp,
            options: state.options,
            assets,
            worldbookIds,
          }));
        }
      }
      manifestRoles.push(roleManifest);
    }

    const worldbooks = await this.collectWorldbookRecords(Array.from(worldbookIds));
    const summary = this.computeSummary(roles, state);
    const manifest = buildCustomBundleManifest({
      format: CUSTOM_BUNDLE_FORMAT,
      formatVersion: CUSTOM_BUNDLE_VERSION,
      exportedAt: new Date().toISOString(),
      mode: state.mode,
      options: state.options,
      summary,
      roles: manifestRoles,
      rooms: Array.from(roomMap.values()),
    });

    entries.push({
      name: 'manifest.json',
      data_url: textToDataUrl(JSON.stringify(manifest, null, 2), 'application/json'),
    });
    entries.push({
      name: 'resources/worldbooks.json',
      data_url: textToDataUrl(JSON.stringify({
        worldIds: Array.from(worldbookIds),
        worldbooks,
      }, null, 2), 'application/json'),
    });
    if (templateRecord) {
      entries.push({
        name: 'resources/memory_template.json',
        data_url: textToDataUrl(JSON.stringify(templateRecord, null, 2), 'application/json'),
      });
    }
    for (const room of roomMap.values()) {
      await this.addRoomEntries({ entries }, room);
    }
    entries.push(...assets.entries);

    const fileName = sanitizeExportName(buildBundleFileName(), 'chatapp_custom_export.zip');
    return {
      entries,
      fileName,
      manifest,
    };
  }

  async confirmRiskyExport(summary, state) {
    const risks = [];
    if (state.options.includeConversationContent) risks.push('聊天正文 / 创作正文');
    if (summary?.momentScopes > 0) risks.push('动态正文 / 动态摘要');
    if (state.options.includeMemoryData) risks.push('记忆表格已填数据');
    if (state.options.includeVariableState) risks.push('变量当前值 / 初始值快照');
    if (!state.options.hideServiceAddresses) risks.push('服务地址');
    if (!risks.length) return true;
    return appConfirm({
      title: '确认导出内容',
      message: `本次导出将包含以下敏感内容：\n- ${risks.join('\n- ')}\n\n确认继续吗？`,
      confirmText: '继续导出',
      cancelText: '取消',
      danger: true,
    });
  }

  readJsonEntry(entryMap, name, fallback = null) {
    const entry = entryMap.get(name);
    if (!entry) return fallback;
    try {
      return readZipEntryJson(entry, { fallback });
    } catch (err) {
      logger.warn(`read custom bundle entry failed: ${name}`, err);
    }
    return fallback;
  }

  parsePackageEntries(entries = []) {
    const list = ensureArray(entries);
    const entryMap = buildZipEntryMap(list);
    const manifest = this.readJsonEntry(entryMap, 'manifest.json', null);
    if (!manifest || String(manifest.format || '').trim() !== CUSTOM_BUNDLE_FORMAT) {
      throw new Error('不支持的自定义资料包格式');
    }
    const rolesById = new Map();
    entryMap.forEach((_entry, name) => {
      if (!name.startsWith('roles/') || !name.endsWith('/persona.json')) return;
      const basePath = name.slice(0, -'/persona.json'.length);
      const persona = this.readJsonEntry(entryMap, name, null);
      if (!persona) return;
      const roleId = String(persona?.id || '').trim();
      if (!roleId) return;
      rolesById.set(roleId, {
        basePath,
        persona,
        originalCard: this.readJsonEntry(entryMap, `${basePath}/persona_original_card.json`, null),
        momentsPayload: this.readJsonEntry(entryMap, `${basePath}/moments.json`, null),
      });
    });
    const roomMap = new Map();
    entryMap.forEach((_entry, name) => {
      if (!name.startsWith('rooms/') || !name.endsWith('/manifest.json')) return;
      const basePath = name.slice(0, -'/manifest.json'.length);
      const roomManifest = this.readJsonEntry(entryMap, name, null);
      const key = String(roomManifest?.key || '').trim();
      if (!roomManifest || !key) return;
      const archives = [];
      entryMap.forEach((_archiveEntry, archiveName) => {
        if (!archiveName.startsWith(`${basePath}/archives/`) || !archiveName.endsWith('.json')) return;
        const archive = this.readJsonEntry(entryMap, archiveName, null);
        if (archive) archives.push(archive);
      });
      roomMap.set(key, {
        manifest: roomManifest,
        basePath,
        roomConfig: this.readJsonEntry(entryMap, `${basePath}/room.json`, {}),
        contact: this.readJsonEntry(entryMap, `${basePath}/contact.json`, null),
        rpGreetings: this.readJsonEntry(entryMap, `${basePath}/rp_greetings.json`, null),
        memoryData: this.readJsonEntry(entryMap, `${basePath}/memory_data.json`, null),
        chatCurrent: this.readJsonEntry(entryMap, `${basePath}/chat_current.json`, null),
        archives,
      });
    });
    const roles = ensureArray(manifest?.roles).map((role) => {
      const roleId = String(role?.id || '').trim();
      const linked = rolesById.get(roleId) || null;
      return {
        manifest: cloneJson(role, {}),
        ...cloneJson(linked || {}, {}),
      };
    });
    return {
      manifest,
      entryMap,
      roles,
      rolesById,
      roomMap,
      worldbooks: this.readJsonEntry(entryMap, 'resources/worldbooks.json', { worldIds: [], worldbooks: {} }),
      memoryTemplate: this.readJsonEntry(entryMap, 'resources/memory_template.json', null),
    };
  }

  getEntryDataUrl(packageData, refName = '') {
    const key = String(refName || '').trim().replace(/\\/g, '/');
    if (!key) return '';
    return toDataUrlFromEntry(packageData?.entryMap?.get(key), key);
  }

  getUniqueWorldbookId(baseId) {
    const source = String(baseId || '').trim() || 'world';
    let nextId = source;
    let index = 1;
    while (hasStoredWorldInfo(this.appBridge, nextId)) {
      nextId = `${source}-${index}`;
      index += 1;
    }
    return nextId;
  }

  getUniqueStickerPackId(baseId = 'pack') {
    const source = String(baseId || '').trim() || 'pack';
    const existing = new Set(ensureArray(stickerPackStore.getState().packs).map((pack) => String(pack?.id || '').trim()).filter(Boolean));
    if (!existing.has(source)) return source;
    let index = 1;
    while (index < 9999) {
      const next = `${source}-${index}`;
      if (!existing.has(next)) return next;
      index += 1;
    }
    return `${source}-${Date.now()}`;
  }

  getUniquePresetName(baseName) {
    const name = String(baseName || '').trim() || '导入预设';
    const existing = new Set();
    const state = this.presetStore?.getState?.() || {};
    Object.values(state?.presets || {}).forEach((bucket) => {
      Object.values(bucket || {}).forEach((preset) => {
        const presetName = String(preset?.name || '').trim();
        if (presetName) existing.add(presetName);
      });
    });
    if (!existing.has(name)) return name;
    let index = 2;
    while (index < 9999) {
      const next = `${name} ${index}`;
      if (!existing.has(next)) return next;
      index += 1;
    }
    return `${name} ${Date.now()}`;
  }

  async importWorldbooks(packageData) {
    const worldPayload = packageData?.worldbooks || {};
    const worldbooks = worldPayload?.worldbooks && typeof worldPayload.worldbooks === 'object'
      ? worldPayload.worldbooks
      : (worldPayload && typeof worldPayload === 'object' ? worldPayload : {});
    const worldIdMap = {};
    try {
      await waitForWorldStoreReady(this.appBridge);
    } catch {}
    for (const [rawId, data] of Object.entries(worldbooks)) {
      const sourceId = String(rawId || '').trim();
      if (!sourceId || sourceId === BUILTIN_PHONE_FORMAT_WORLDBOOK_ID) continue;
      const nextId = this.getUniqueWorldbookId(sourceId);
      worldIdMap[sourceId] = nextId;
      try {
        await this.appBridge?.saveWorldInfo?.(nextId, { ...cloneJson(data, {}), name: String(data?.name || nextId) });
      } catch (err) {
        logger.warn('import worldbook from custom bundle failed', err);
      }
    }
    return worldIdMap;
  }

  async importRegexPayload(regexPayload, sessionId, worldIdMap = {}, importedLocalSetKeys = null) {
    const sid = String(sessionId || '').trim();
    if (!sid || !regexPayload) return;
    const regexStore = this.regexStore;
    if (!regexStore) return;
    try {
      await regexStore.ready;
    } catch {}
    for (const set of ensureArray(regexPayload?.localSets)) {
      let bind = cloneJson(set?.bind || null, null);
      if (bind?.type === 'world') {
        const rawWorldId = String(bind.worldId || '').trim();
        bind.worldId = worldIdMap[rawWorldId] || rawWorldId;
      }
      const signature = JSON.stringify({
        name: String(set?.name || ''),
        bind: bind || null,
        rules: cloneJson(set?.rules || [], []),
      });
      if (importedLocalSetKeys?.has(signature)) continue;
      if (importedLocalSetKeys) importedLocalSetKeys.add(signature);
      try {
        await regexStore.upsertLocalSet({
          name: String(set?.name || '导入正则').trim() || '导入正则',
          enabled: set?.enabled !== false,
          bind,
          rules: cloneJson(set?.rules || [], []),
        });
      } catch (err) {
        logger.warn('import local regex set from custom bundle failed', err);
      }
    }
    if (regexPayload?.session) {
      try {
        await regexStore.setSession?.(sid, cloneJson(regexPayload.session, {}));
      } catch (err) {
        logger.warn('import session regex from custom bundle failed', err);
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('regex-changed'));
    } catch {}
  }

  importVariableCoreToStore(chatStore, payload, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid || !payload || !chatStore) return;
    Object.entries(payload?.schemas || {}).forEach(([key, schema]) => {
      chatStore?.setVariableSchema?.(key, cloneJson(schema, schema), sid);
    });
    chatStore?.setVariableRules?.(cloneJson(payload?.rules || [], []), sid);
    chatStore?.setStageSchema?.(cloneJson(payload?.stageSchema || null, null), sid);
  }

  importVariableStateToStore(chatStore, payload, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid || !payload || !chatStore) return;
    Object.entries(payload?.initialValues || {}).forEach(([key, value]) => {
      chatStore?.setInitialVariable?.(key, cloneJson(value, value), sid);
    });
    Object.entries(payload?.values || {}).forEach(([key, value]) => {
      chatStore?.setVariable?.(key, cloneJson(value, value), sid);
    });
  }

  async importPersonaRecord(rolePackage, worldIdMap = {}) {
    const persona = rolePackage?.persona || null;
    const manifestRole = rolePackage?.manifest || {};
    if (!this.personaStore?.create) return null;
    const avatarFile = String(persona?.avatarFile || '').trim();
    const avatarDataUrl = avatarFile
      ? this.getEntryDataUrl(rolePackage?.packageData, avatarFile)
      : String(persona?.avatarValue || '').trim();
    const created = await this.personaStore.create({
      name: String(persona?.name || manifestRole?.name || '角色').trim() || '角色',
      description: String(persona?.description || ''),
      avatar: avatarDataUrl || '',
      userBubbleColor: String(persona?.userBubbleColor || ''),
      userTextColor: String(persona?.userTextColor || ''),
      position: Number(persona?.position || 0) || 0,
      depth: Number(persona?.depth || 0) || 0,
      role: Number(persona?.role || 0) || 0,
      source: {
        ...this.remapPersonaSource(persona?.source || null, worldIdMap),
        type: 'custom_bundle',
      },
      originalCard: null,
    });
    const originalCard = rolePackage?.originalCard || null;
    if (created && originalCard) {
      try {
        await this.appBridge?.savePersonaCard?.(created.id, originalCard);
        await this.personaStore.update?.(created.id, {
          source: {
            ...(created?.source || {}),
            type: 'custom_bundle',
            originalCardStored: true,
            originalCardSize: JSON.stringify(originalCard).length,
          },
        });
      } catch (err) {
        logger.warn('save imported custom bundle persona card failed', err);
        try {
          await this.personaStore.update?.(created.id, {
            originalCard,
            source: { ...(created?.source || {}), type: 'custom_bundle' },
          });
        } catch {}
      }
    }
    return created || null;
  }

  async importMemoryTemplateRecord(record) {
    if (!record || !this.memoryTemplateStore?.saveTemplate) return '';
    const baseId = String(record?.id || '').trim() || `imported-template-${Date.now()}`;
    let nextId = baseId;
    try {
      await this.memoryTemplateStore.ensureReady?.();
    } catch {}
    try {
      while (await this.memoryTemplateStore.getTemplateById?.(nextId)) {
        nextId = `${baseId}-${Math.random().toString(16).slice(2, 6)}`;
      }
    } catch {}
    const input = {
      id: nextId,
      name: String(record?.name || record?.schema?.meta?.name || nextId),
      author: record?.author ? String(record.author) : null,
      version: record?.version ? String(record.version) : null,
      description: record?.description ? String(record.description) : null,
      schema: cloneJson(record?.schema || {}, {}),
      injection: cloneJson(record?.injection || null, null),
      is_default: false,
      is_builtin: false,
    };
    await this.memoryTemplateStore.saveTemplate(input);
    return nextId;
  }

  async importMomentsPayload({ packageData, rolePackage, runtime }) {
    const payload = rolePackage?.momentsPayload || null;
    if (!payload || !runtime?.momentsStore || !runtime?.momentSummaryStore) return null;
    const started = getPerfNow();
    const importedMoments = ensureArray(payload?.moments).map((moment) => {
      const next = cloneJson(moment, {});
      const avatarFile = String(next?.authorAvatarFile || '').trim();
      const avatarValue = avatarFile
        ? this.getEntryDataUrl(packageData, avatarFile)
        : String(next?.authorAvatarValue || next?.authorAvatar || '').trim();
      delete next.authorAvatarFile;
      delete next.authorAvatarValue;
      if (avatarValue) next.authorAvatar = avatarValue;
      else delete next.authorAvatar;
      return next;
    });
    runtime.momentsStore.addMany(importedMoments);
    const summaryStore = runtime.momentSummaryStore;
    const mergedSummaries = mergeSummaryItems(
      summaryStore?.getSummaries?.() || summaryStore?.state?.summaries || [],
      payload?.summaries || [],
    );
    summaryStore?.setSummaries?.(mergedSummaries);
    const latestRaw = pickLatestByAt(
      [
        summaryStore?.state?.compactedSummaryLastRaw || null,
        payload?.compactedSummaryLastRaw || null,
      ],
      normalizeCompactedSummaryRaw,
    );
    if (latestRaw?.raw) {
      summaryStore?.setCompactedSummaryRaw?.(latestRaw.raw, { at: latestRaw.at || Date.now() });
    }
    const latestCompacted = pickLatestByAt(
      [
        summaryStore?.getCompactedSummary?.() || summaryStore?.state?.compactedSummary || null,
        payload?.compactedSummary || null,
      ],
      normalizeCompactedSummary,
    );
    if (latestCompacted?.text) {
      summaryStore?.setCompactedSummary?.(latestCompacted.text, {
        at: latestCompacted.at || Date.now(),
        raw: latestCompacted.raw || latestRaw?.raw || '',
      });
    }
    return {
      restoreMs: getPerfNow() - started,
    };
  }

  async applyMemorySnapshotToStore(memoryTableStore, sessionId, snapshot, { templateId = '', isGroup = false } = {}) {
    if (!snapshot || !memoryTableStore?.getMemories) return false;
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    const nextTemplateId = String(templateId || snapshot?.templateId || '').trim() || String((await this.getDefaultMemoryTemplate())?.id || '').trim();
    if (!nextTemplateId) return false;
    let existing = [];
    try {
      existing = await memoryTableStore.getMemories({
        scope: isGroup ? 'group' : 'contact',
        group_id: isGroup ? sid : undefined,
        contact_id: isGroup ? undefined : sid,
        template_id: nextTemplateId,
      });
    } catch {}
    const ids = Array.isArray(existing)
      ? existing.map((row) => String(row?.id || '').trim()).filter(Boolean)
      : [];
    if (ids.length) {
      try {
        await memoryTableStore.batchDeleteMemories?.(ids);
      } catch {
        for (const id of ids) {
          try {
            await memoryTableStore.deleteMemory?.(id);
          } catch {}
        }
      }
    }
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const inputs = rows.map((row) => {
      const tableId = String(row?.table_id || '').trim();
      if (!tableId) return null;
      return {
        id: row?.id ? String(row.id) : undefined,
        template_id: nextTemplateId,
        table_id: tableId,
        contact_id: isGroup ? null : sid,
        group_id: isGroup ? sid : null,
        row_data: row?.row_data ?? {},
        is_active: row?.is_active !== false,
        is_pinned: Boolean(row?.is_pinned),
        priority: Number.isFinite(Number(row?.priority)) ? Number(row.priority) : 0,
        sort_order: Number.isFinite(Number(row?.sort_order)) ? Number(row.sort_order) : 0,
      };
    }).filter(Boolean);
    if (inputs.length) {
      await batchCreateMemoriesWithFallback({ memoryTableStore, inputs });
    }
    emitMemoryRowsUpdated({ target: window, sessionId: sid, templateId: nextTemplateId });
    return true;
  }

  async persistScopedWorldMap(scopeId = '', worldSessionMap = {}) {
    const key = makeScopedKey('world_session_map_v1', normalizeScopeId(scopeId));
    const payload = worldSessionMap && typeof worldSessionMap === 'object' ? worldSessionMap : {};
    try {
      localStorage.setItem(key, JSON.stringify(payload));
    } catch {}
    await safeInvoke('save_kv', { name: key, data: payload });
    const activeScopeId = normalizeScopeId(this.appBridge?.scopeId || '');
    const targetScopeId = normalizeScopeId(scopeId);
    if (activeScopeId === targetScopeId && this.appBridge) {
      try {
        replaceWorldSessionMap(this.appBridge, cloneJson(payload, {}));
      } catch {}
    }
  }

  async setScopedWorldIds(scopeId = '', sessionId = '', worldIds = []) {
    const sid = String(sessionId || '').trim();
    if (!sid) return;
    const runtime = await this.getScopeRuntime(scopeId);
    const list = normalizeWorldIdList(worldIds, { excludeBuiltin: BUILTIN_PHONE_FORMAT_WORLDBOOK_ID });
    if (!list.length) delete runtime.worldSessionMap[sid];
    else runtime.worldSessionMap[sid] = Array.from(new Set(list));
    await this.persistScopedWorldMap(scopeId, runtime.worldSessionMap);
  }

  async collectExistingSessionIds() {
    const ids = new Set();
    const scopes = new Set();
    const personas = ensureArray(this.personaStore?.getAll?.()).filter((persona) => persona?.id);
    if (appSettings.get().personaBindContacts === false) {
      scopes.add('');
    } else {
      personas.forEach((persona) => {
        scopes.add(normalizeScopeId(this.getPersonaScopeKey(persona.id) || persona.id));
      });
      const active = this.personaStore?.getActive?.();
      if (active?.id) scopes.add(normalizeScopeId(this.getPersonaScopeKey(active.id) || active.id));
    }
    if (!scopes.size) scopes.add('');
    for (const scopeId of scopes) {
      const runtime = await this.getScopeRuntime(scopeId);
      ensureArray(runtime?.chatStore?.listSessions?.()).forEach((id) => ids.add(String(id || '').trim()));
      ensureArray(runtime?.contactsStore?.listContacts?.()).forEach((contact) => ids.add(String(contact?.id || '').trim()));
    }
    return ids;
  }

  allocateUniqueChatSessionId(roomPackage, usedIds) {
    const contact = roomPackage?.contact || {};
    const sourceId = String(contact?.id || roomPackage?.manifest?.sessionId || '').trim();
    const sourceName = String(contact?.name || sourceId || '聊天').trim() || '聊天';
    const isGroup = contact?.isGroup === true || sourceId.startsWith('group:');
    let base = '';
    if (isGroup) {
      base = sourceId.startsWith('group:') ? sourceId : `group:${sourceName || '群聊'}`;
    } else {
      base = sourceName || sourceId || '聊天';
    }
    if (!usedIds.has(base)) {
      usedIds.add(base);
      return base;
    }
    let index = 2;
    while (index < 9999) {
      const candidate = `${base}-${index}`;
      if (!usedIds.has(candidate)) {
        usedIds.add(candidate);
        return candidate;
      }
      index += 1;
    }
    const fallback = `${base}-${Date.now()}`;
    usedIds.add(fallback);
    return fallback;
  }

  async importRoomSettingsToScope({
    packageData,
    runtime,
    roomPackage,
    sessionId,
    displayName,
    personaLockId = '',
    presetImportCache = null,
    diagnosticsNotes = null,
  }) {
    const sid = String(sessionId || '').trim();
    if (!sid) return {};
    const roomConfig = cloneJson(roomPackage?.roomConfig || {}, {});
    const settings = cloneJson(roomConfig?.sessionSettings || {}, {});
    if (personaLockId) settings.personaLockId = personaLockId;
    else delete settings.personaLockId;

    const wallpaper = roomConfig?.wallpaper || null;
    if (wallpaper?.file) {
      const dataUrl = this.getEntryDataUrl(packageData, wallpaper.file);
      if (dataUrl) {
        try {
          const saved = await safeInvoke('save_wallpaper', {
            sessionId: sid,
            dataUrl,
            fileName: wallpaper?.meta?.name || wallpaper.file.split('/').pop() || 'wallpaper',
          });
          settings.wallpaper = {
            path: String(saved?.path || '').trim(),
            name: String(wallpaper?.meta?.name || ''),
            zoom: Number(wallpaper?.meta?.zoom || 1) || 1,
            rotate: Number(wallpaper?.meta?.rotate || 0) || 0,
            offsetX: Number(wallpaper?.meta?.offsetX || 0) || 0,
            offsetY: Number(wallpaper?.meta?.offsetY || 0) || 0,
            width: Number(wallpaper?.meta?.width || 0) || 0,
            height: Number(wallpaper?.meta?.height || 0) || 0,
            opacity: normalizeWallpaperOpacity(wallpaper?.meta?.opacity ?? 1),
            saveOriginal: wallpaper?.meta?.saveOriginal === true,
          };
        } catch (err) {
          logger.warn('import wallpaper from custom bundle failed', err);
        }
      }
    } else if (wallpaper?.remoteUrl) {
      settings.wallpaper = {
        ...(settings.wallpaper && typeof settings.wallpaper === 'object' ? settings.wallpaper : {}),
        url: String(wallpaper.remoteUrl || ''),
        name: String(wallpaper?.meta?.name || ''),
        zoom: Number(wallpaper?.meta?.zoom || 1) || 1,
        rotate: Number(wallpaper?.meta?.rotate || 0) || 0,
        offsetX: Number(wallpaper?.meta?.offsetX || 0) || 0,
        offsetY: Number(wallpaper?.meta?.offsetY || 0) || 0,
        width: Number(wallpaper?.meta?.width || 0) || 0,
        height: Number(wallpaper?.meta?.height || 0) || 0,
        opacity: normalizeWallpaperOpacity(wallpaper?.meta?.opacity ?? 1),
      };
    }

    const restoredPresetIds = {};
    try {
      await this.presetStore?.ready;
    } catch {}
    const roomPresets = cloneJson(roomConfig?.presets || {}, {});
    for (const type of PRESET_TYPES) {
      const presetPayload = roomPresets?.presets?.[type];
      if (!presetPayload?.data || !this.presetStore?.upsert) continue;
      try {
        const presetId = await resolveImportedPresetIdByName({
          presetStore: this.presetStore,
          type,
          presetPayload,
          cache: presetImportCache,
          upsertPayloadBuilder: buildRestoredPresetUpsertPayload,
          requiredAppScope: 'all',
        });
        if (presetId) restoredPresetIds[type] = presetId;
      } catch (err) {
        logger.warn('import preset from custom bundle failed', err);
      }
    }
    for (const [type, presetId] of Object.entries(restoredPresetIds)) {
      try {
        const result = await bindImportedPresetToSession({
          presetStore: this.presetStore,
          type,
          sessionId: sid,
          presetId,
        });
        if (!result.ok) {
          diagnosticsNotes?.push?.(`会话「${String(displayName || sid)}」的 ${type} 预设未能还原：${result.reason}`);
        }
      } catch (err) {
        diagnosticsNotes?.push?.(`会话「${String(displayName || sid)}」的 ${type} 预设未能还原：${String(err?.message || 'bind_failed')}`);
        logger.warn('bind imported preset to session failed', err);
      }
    }

    const roomConnection = cloneJson(roomConfig?.connection || {}, {});
    if (roomConnection?.profile && this.configManager?.createProfile) {
      let previousActiveProfileId = '';
      try {
        previousActiveProfileId = String(this.configManager.getActiveProfileId?.() || '').trim();
      } catch {}
      try {
        const profileName = this.getUniquePresetName(
          `${String(displayName || '角色').trim() || '角色'}·连线`
        );
        const createdProfile = await this.configManager.createProfile(profileName, cloneJson(roomConnection.profile, {}));
        if (previousActiveProfileId && createdProfile?.id && previousActiveProfileId !== createdProfile.id) {
          try {
            await this.configManager.setActiveProfile(previousActiveProfileId);
          } catch {}
        }
        if (createdProfile?.id) {
          await this.presetStore?.setSessionProfile?.('openai', sid, createdProfile.id);
        }
      } catch (err) {
        logger.warn('import connection profile from custom bundle failed', err);
      }
    }
    if (roomConnection?.reasoning) {
      try {
        await this.presetStore?.setSessionReasoning?.('openai', sid, cloneJson(roomConnection.reasoning, {}));
      } catch (err) {
        logger.warn('import session reasoning from custom bundle failed', err);
      }
    }

    for (const rawPack of ensureArray(roomConfig?.stickers)) {
      const packId = this.getUniqueStickerPackId(rawPack?.id || slugifySegment(rawPack?.name || 'pack', 'pack'));
      const iconDataUrl = rawPack?.iconFile ? this.getEntryDataUrl(packageData, rawPack.iconFile) : '';
      const stickers = ensureArray(rawPack?.stickers).map((sticker) => ({
        id: String(sticker?.id || `${packId}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`),
        name: String(sticker?.name || ''),
        keyword: String(sticker?.keyword || ''),
        path: '',
        dataUrl: sticker?.assetFile ? this.getEntryDataUrl(packageData, sticker.assetFile) : '',
        frames: ensureArray(sticker?.frameFiles).map((ref) => this.getEntryDataUrl(packageData, ref)).filter(Boolean),
        fps: Number(sticker?.fps || 0) || 0,
      }));
      stickerPackStore.upsertPack({
        id: packId,
        name: String(rawPack?.name || packId),
        colorIndex: Number(rawPack?.colorIndex || 0) || 0,
        iconPath: '',
        iconDataUrl: iconDataUrl || '',
        iconMeta: cloneJson(rawPack?.iconMeta || {}, {}),
        boundSessions: [sid],
        aiEnabled: rawPack?.aiEnabled === true,
        stickers,
      });
    }

    runtime?.chatStore?.setSessionSettings?.(sid, settings);
    return settings;
  }

  async restoreConversationToStore(chatStore, sessionId, roomPackage, { includeMemoryData = false } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid || !roomPackage?.chatCurrent || !chatStore) return false;
    const currentPayload = cloneJson(roomPackage.chatCurrent, {});
    const archivesPayload = normalizeCustomBundleImportedArchivePayloads(roomPackage.archives);
    const session = chatStore?._ensureSession?.(sid);
    if (!session) return false;
    const currentState = buildCustomBundleRestoredCurrentSessionState({ currentPayload });
    const currentMessages = currentState.currentMessages;
    session.draft = currentState.draft;
    session.detachedSummaries = currentState.detachedSummaries;
    session.compactedSummary = currentState.compactedSummary;
    session.compactedSummaryLastRaw = currentState.compactedSummaryLastRaw;
    session.currentArchiveId = currentState.currentArchiveId;
    session.archives = buildCustomBundleRestoredArchiveMetas({
      archivesPayload,
      includeMemoryData,
    });

    if (!chatStore?._useV2) {
      session.messages = currentMessages.slice();
      session.archives = buildCustomBundleLegacyRestoredArchives({
        archiveMetas: session.archives,
        archivesPayload,
      });
      chatStore?._persist?.();
      return true;
    }

    try {
      chatStore._clearThreadState?.(chatStore._getThreadKey?.(sid, '') || '');
    } catch {}
    try {
      await chatStore._v2.replaceThreadMessages(sid, '', currentMessages);
    } catch (err) {
      logger.warn('restore current thread for custom bundle failed', err);
    }
    for (const archive of session.archives) {
      const messages = getCustomBundleImportedArchiveMessages({
        archivesPayload,
        archiveId: archive.id,
      });
      try {
        await chatStore._v2.replaceThreadMessages(sid, archive.id, messages);
      } catch (err) {
        logger.warn('restore archive thread for custom bundle failed', err);
      }
    }
    session.messages = [];
    session._loadedThreadKey = '';
    chatStore?._persist?.();
    try {
      await chatStore.ensureRecentMessagesLoaded?.(sid);
    } catch {}
    return true;
  }

  async importCustomBundleRoomMemorySnapshot({
    runtime,
    sessionId,
    roomPackage,
    importedMemoryTemplateId = '',
    isGroup = false,
    restoreFailureKind = 'chat',
  } = {}) {
    if (!roomPackage?.memoryData) return false;
    try {
      await this.applyMemorySnapshotToStore(
        runtime.getMemoryTableStore?.(),
        sessionId,
        cloneJson(roomPackage.memoryData, {}),
        {
          templateId: importedMemoryTemplateId,
          isGroup,
        },
      );
      return true;
    } catch (err) {
      logger.warn(getCustomBundleRoomMemoryFailureLogMessage(restoreFailureKind), err);
      return false;
    }
  }

  async restoreCustomBundleRoomConversation({
    packageData,
    runtime,
    sessionId,
    roomPackage,
    diagnosticsNotes = null,
    restoreFailureKind = 'chat',
    restoreFailureName = '',
  } = {}) {
    if (!roomPackage?.chatCurrent) return 0;
    const restoreStarted = getPerfNow();
    let reactionImport = null;
    try {
      reactionImport = await customReactionAssets.import(roomPackage.roomConfig?.reactions, ref => this.getEntryDataUrl(packageData, ref));
      if (reactionImport.failed.length) {
        const warning = customReactionImportWarning(reactionImport);
        diagnosticsNotes?.push?.(warning);
        window.toastr?.warning?.(warning);
      }
      await this.restoreConversationToStore(runtime.chatStore, sessionId, roomPackage, {
        includeMemoryData: Boolean(packageData?.manifest?.options?.includeMemoryData),
      });
    } catch (err) {
      // The conversation did not restore, so reactions added only for it would just occupy slots.
      await customReactionAssets.rollbackImport(reactionImport);
      logger.warn(getCustomBundleRoomRestoreFailureLogMessage(restoreFailureKind), err);
      diagnosticsNotes?.push?.(buildCustomBundleRoomRestoreFailureNote({
        restoreFailureKind,
        restoreFailureName,
        sessionId,
        error: err,
      }));
    }
    return roundDuration(getPerfNow() - restoreStarted);
  }

  async importCustomBundleRoomContent({
    packageData,
    runtime,
    scopeId = '',
    roomPackage,
    sessionId,
    worldIdMap = {},
    importedLocalSetKeys = null,
    importedMemoryTemplateId = '',
    presetImportCache = null,
    displayName = '',
    personaLockId = '',
    roomKey = '',
    isGroup = false,
    mappedMembers,
    diagnosticsNotes = null,
    restoreFailureKind = 'chat',
    restoreFailureName = '',
  } = {}) {
    runtime.chatStore?._ensureSession?.(sessionId);
    this.importVariableCoreToStore(runtime.chatStore, roomPackage?.roomConfig?.variables?.core || null, sessionId);
    await this.importRegexPayload(
      roomPackage?.roomConfig?.regex || null,
      sessionId,
      worldIdMap,
      importedLocalSetKeys,
    );
    const mappedWorldIds = mapCustomBundleImportedWorldIds({
      worldIds: roomPackage?.roomConfig?.world?.worldIds || [],
      worldIdMap,
    });
    if (mappedWorldIds.length) {
      await this.setScopedWorldIds(scopeId, sessionId, mappedWorldIds);
    }
    await this.importRoomSettingsToScope({
      packageData,
      runtime,
      roomPackage,
      sessionId,
      displayName,
      personaLockId,
      presetImportCache,
      diagnosticsNotes,
    });
    if (roomPackage?.roomConfig?.variables?.state) {
      this.importVariableStateToStore(runtime.chatStore, roomPackage.roomConfig.variables.state, sessionId);
    }
    await this.importCustomBundleRoomMemorySnapshot({
      runtime,
      sessionId,
      roomPackage,
      importedMemoryTemplateId,
      isGroup,
      restoreFailureKind,
    });
    const restoreMs = await this.restoreCustomBundleRoomConversation({
      packageData,
      runtime,
      sessionId,
      roomPackage,
      diagnosticsNotes,
      restoreFailureKind,
      restoreFailureName,
    });
    const diagnosticExtra = buildCustomBundleRoomDiagnosticExtra({
      roomKey,
      restoreMs,
      mappedWorldIds,
      isGroup,
      mappedMembers,
    });
    return {
      mappedWorldIds,
      diagnostic: this.buildRoomImportDiagnostic(runtime, sessionId, roomPackage, diagnosticExtra),
    };
  }

  async importCustomBundleChatRoom({
    packageData,
    runtime,
    chatScopeId = '',
    roomKey = '',
    roomPackage,
    sessionId = '',
    roomRefCount = 0,
    importedPersona = {},
    currentSharedMode = false,
    sourceSessionIdMap = null,
    worldIdMap = {},
    importedLocalSetKeys = null,
    importedMemoryTemplateId = '',
    presetImportCache = null,
    diagnosticsNotes = null,
  } = {}) {
    const personaLockId = resolveCustomBundlePersonaLockId({
      personaId: importedPersona?.id,
      currentSharedMode,
      roomRefCount,
    });
    const contactPayload = roomPackage?.contact || {};
    const avatarDataUrl = resolveCustomBundleContactAvatar({
      contactPayload,
      getEntryDataUrl: file => this.getEntryDataUrl(packageData, file),
    });
    const mappedMembers = mapCustomBundleImportedMemberIds({
      members: contactPayload?.members,
      sourceSessionIdMap,
    });
    runtime.contactsStore?.upsertContact?.(buildCustomBundleImportedContactRecord({
      contactPayload,
      sessionId,
      avatar: avatarDataUrl,
      mappedMembers,
    }));
    const importedRoom = await this.importCustomBundleRoomContent({
      packageData,
      runtime,
      scopeId: chatScopeId,
      roomPackage,
      sessionId,
      worldIdMap,
      importedLocalSetKeys,
      importedMemoryTemplateId,
      presetImportCache,
      displayName: String(importedPersona?.name || roomPackage?.contact?.name || sessionId),
      personaLockId,
      roomKey,
      isGroup: Boolean(contactPayload?.isGroup),
      mappedMembers,
      diagnosticsNotes,
      restoreFailureKind: 'chat',
      restoreFailureName: String(contactPayload?.name || sessionId),
    });
    return {
      contactPayload,
      diagnostic: importedRoom.diagnostic,
      target: buildCustomBundleChatImportedTarget({
        importedPersona,
        scopeId: chatScopeId,
        sessionId,
        contactPayload,
      }),
    };
  }

  async importCustomBundleRpRoom({
    packageData,
    rpRoomImportPlan = null,
    importedPersona = {},
    usedSessionIds = null,
    worldIdMap = {},
    importedLocalSetKeys = null,
    importedMemoryTemplateId = '',
    presetImportCache = null,
    diagnosticsNotes = null,
  } = {}) {
    if (!rpRoomImportPlan) return null;
    const {
      roomKey,
      roomPackage,
      scopeId,
      sessionId,
      displayName,
      personaLockId,
    } = rpRoomImportPlan;
    const runtime = await this.getScopeRuntime(scopeId);
    usedSessionIds?.add?.(sessionId);
    const importedRoom = await this.importCustomBundleRoomContent({
      packageData,
      runtime,
      scopeId,
      roomPackage,
      sessionId,
      worldIdMap,
      importedLocalSetKeys,
      importedMemoryTemplateId,
      presetImportCache,
      displayName,
      personaLockId,
      roomKey,
      isGroup: false,
      diagnosticsNotes,
      restoreFailureKind: 'rp',
      restoreFailureName: String(importedPersona?.name || sessionId),
    });
    if (roomPackage?.rpGreetings) {
      const { greetings, activeId } = normalizeCustomBundleImportedRpGreetings(roomPackage.rpGreetings);
      runtime.rpSessionStore?.setGreetings?.(greetings, {
        activeId,
      });
    }
    return {
      runtime,
      scopeId,
      sessionId,
      diagnostic: importedRoom.diagnostic,
      target: buildCustomBundleRpImportedTarget({
        importedPersona,
        scopeId,
        sessionId,
      }),
    };
  }

  async importCustomBundleRoleRooms({
    packageData,
    roleManifest = {},
    importedPersona = {},
    targetScopeId = '',
    chatScopeId = '',
    runtime = null,
    currentSharedMode = false,
    roomRefCounts = new Map(),
    sharedImportedRooms = new Map(),
    usedSessionIds = null,
    worldIdMap = {},
    importedLocalSetKeys = null,
    importedMemoryTemplateId = '',
    presetImportCache = null,
    diagnosticsNotes = null,
    roleDiagnostics = null,
    importedTargets = null,
    completedRoomUnits = 0,
    totalRoomUnits = 1,
    fileName = '',
    markTouchedRuntime = null,
  } = {}) {
    let nextCompletedRoomUnits = completedRoomUnits;
    const chatRoomImportPlan = planCustomBundleChatRoomImports({
      chatRoomKeys: roleManifest?.chats,
      roomMap: packageData?.roomMap,
      sharedImportedRooms,
      currentSharedMode,
      allocateSessionId: roomPackage => this.allocateUniqueChatSessionId(roomPackage, usedSessionIds),
    });
    const { plannedChatSessions, sourceSessionIdMap } = chatRoomImportPlan;

    for (const { roomKey, roomPackage } of chatRoomImportPlan.roomEntries) {
      const sessionId = String(plannedChatSessions.get(roomKey) || '').trim()
        || this.allocateUniqueChatSessionId(roomPackage, usedSessionIds);
      const roomRefCount = Number(roomRefCounts.get(roomKey) || 0);

      const importedChatRoom = await this.importCustomBundleChatRoom({
        packageData,
        runtime,
        chatScopeId,
        roomKey,
        roomPackage,
        sessionId,
        roomRefCount,
        importedPersona,
        currentSharedMode,
        sourceSessionIdMap,
        worldIdMap,
        importedLocalSetKeys,
        importedMemoryTemplateId,
        presetImportCache,
        diagnosticsNotes,
      });
      roleDiagnostics?.chats?.push?.(importedChatRoom.diagnostic);
      markTouchedRuntime?.(chatScopeId, runtime);
      importedTargets?.push?.(importedChatRoom.target);
      nextCompletedRoomUnits += 1;
      this.reportImportProgress(buildCustomBundleChatRoomProgressDetail({
        completedRoomUnits: nextCompletedRoomUnits,
        totalRoomUnits,
        contactPayload: importedChatRoom.contactPayload,
        sessionId,
        fileName,
      }));
      if (currentSharedMode) {
        sharedImportedRooms.set(roomKey, { sessionId });
      }
    }

    const rpRoomImportPlan = planCustomBundleRpRoomImport({
      creativeWritingRoomKey: roleManifest?.creativeWriting,
      roomMap: packageData?.roomMap,
      importedPersona,
      targetScopeId,
      currentSharedMode,
    });
    if (rpRoomImportPlan) {
      const importedRpRoom = await this.importCustomBundleRpRoom({
        packageData,
        rpRoomImportPlan,
        importedPersona,
        usedSessionIds,
        worldIdMap,
        importedLocalSetKeys,
        importedMemoryTemplateId,
        presetImportCache,
        diagnosticsNotes,
      });
      if (roleDiagnostics) roleDiagnostics.creativeWriting = importedRpRoom.diagnostic;
      markTouchedRuntime?.(importedRpRoom.scopeId, importedRpRoom.runtime);
      importedTargets?.push?.(importedRpRoom.target);
      nextCompletedRoomUnits += 1;
      this.reportImportProgress(buildCustomBundleRpRoomProgressDetail({
        completedRoomUnits: nextCompletedRoomUnits,
        totalRoomUnits,
        importedPersona,
        fileName,
      }));
    }

    return {
      completedRoomUnits: nextCompletedRoomUnits,
    };
  }

  async importCustomBundleRoleRuntime({
    packageData,
    rawRole = null,
    worldIdMap = {},
    currentSharedMode = false,
    diagnostics = null,
    markTouchedRuntime = null,
  } = {}) {
    const roleManifest = rawRole?.manifest || {};
    const importedPersona = await this.importPersonaRecord({
      ...rawRole,
      packageData,
    }, worldIdMap);
    if (!importedPersona) return null;
    const targetScopeId = normalizeScopeId(this.getPersonaScopeKey(importedPersona.id) || importedPersona.id);
    const chatScopeId = currentSharedMode ? '' : targetScopeId;
    const runtime = await this.getScopeRuntime(chatScopeId);
    const roleDiagnostics = buildCustomBundleRoleImportDiagnostics({
      importedPersona,
      roleManifest,
      targetScopeId,
      chatScopeId,
    });
    diagnostics?.roles?.push?.(roleDiagnostics);
    const importedMoments = await this.importMomentsPayload({
      packageData,
      rolePackage: rawRole,
      runtime,
    });
    if (importedMoments) {
      roleDiagnostics.moments = this.buildMomentsImportDiagnostic(runtime, rawRole?.momentsPayload || null, {
        restoreMs: roundDuration(importedMoments.restoreMs),
      });
      markTouchedRuntime?.(chatScopeId, runtime);
    }
    return {
      roleManifest,
      importedPersona,
      targetScopeId,
      chatScopeId,
      runtime,
      roleDiagnostics,
    };
  }

  async flushCustomBundleTouchedRuntimes({
    touchedScopes = new Set(),
    touchedRuntimes = new Map(),
  } = {}) {
    const flushStarted = getPerfNow();
    for (const scopeKey of touchedScopes) {
      const runtime = touchedRuntimes.get(scopeKey);
      if (runtime) {
        await this.flushRuntimeState(runtime);
        continue;
      }
      const scopeId = getCustomBundleScopeIdFromTouchedKey(scopeKey);
      try {
        const nextRuntime = await this.getScopeRuntime(scopeId);
        await this.flushRuntimeState(nextRuntime);
      } catch {}
    }
    return roundDuration(getPerfNow() - flushStarted);
  }

  emitCustomBundleImportCompletionEvents() {
    try {
      window.dispatchEvent(new CustomEvent('contacts-updated'));
    } catch {}
    try {
      window.dispatchEvent(new CustomEvent('moment-summaries-updated'));
    } catch {}
    try {
      emitWorldInfoChanged(this.appBridge, { roleWorldChanged: true });
    } catch {}
  }

  buildImportPreview(packageData) {
    return buildCustomBundleImportPreview(packageData);
  }

  async confirmImport(packageData, fileName = '') {
    const preview = this.buildImportPreview(packageData);
    const lines = buildCustomBundleImportConfirmLines({ preview, fileName });
    return appConfirm({
      title: '导入自定义资料包',
      message: `${lines.join('\n')}\n\n确定继续导入吗？`,
      confirmText: '开始导入',
      cancelText: '取消',
      danger: true,
    });
  }

  async importPackage(packageData, { fileName = '' } = {}) {
    const startedAt = Date.now();
    const startedPerf = getPerfNow();
    const preview = this.buildImportPreview(packageData);
    const totalRoomUnits = Math.max(1, Number(preview.chats || 0) + Number(preview.creative || 0));
    let completedRoomUnits = 0;
    const diagnostics = buildCustomBundleImportDiagnostics({
      fileName,
      preview,
      sharedMode: appSettings.get().personaBindContacts === false,
      startedAt,
    });
    this.reportImportProgress({
      phase: 'prepare',
      progress: 18,
      status: '正在整理导入资料...',
      fileName,
    });
    const currentSharedMode = appSettings.get().personaBindContacts === false;
    const worldbookStarted = getPerfNow();
    const worldIdMap = await this.importWorldbooks(packageData);
    diagnostics.phases.worldbooksMs = roundDuration(getPerfNow() - worldbookStarted);
    diagnostics.worldbookMapSize = Object.keys(worldIdMap || {}).length;
    this.reportImportProgress({
      phase: 'worldbooks',
      progress: 28,
      status: `已导入世界书映射 ${diagnostics.worldbookMapSize} 项`,
      fileName,
    });
    const memoryTemplateStarted = getPerfNow();
    const importedMemoryTemplateId = await this.importMemoryTemplateRecord(packageData?.memoryTemplate || null);
    diagnostics.phases.memoryTemplateMs = roundDuration(getPerfNow() - memoryTemplateStarted);
    diagnostics.importedMemoryTemplateId = String(importedMemoryTemplateId || '').trim();
    const usedSessionIds = await this.collectExistingSessionIds();
    const importedLocalSetKeys = new Set();
    const presetImportCache = new Map();
    const roomRefCounts = buildCustomBundleRoomRefCounts(packageData?.manifest?.roles);
    const sharedImportedRooms = new Map();
    const touchedScopes = new Set();
    const touchedRuntimes = new Map();
    const importedTargets = [];
    const markTouchedRuntime = (scopeId, runtime) => {
      markCustomBundleTouchedRuntime({
        touchedScopes,
        touchedRuntimes,
        scopeId,
        runtime,
      });
    };

    for (const rawRole of ensureArray(packageData?.roles)) {
      const roleRuntime = await this.importCustomBundleRoleRuntime({
        packageData,
        rawRole,
        worldIdMap,
        currentSharedMode,
        diagnostics,
        markTouchedRuntime,
      });
      if (!roleRuntime) continue;
      const importedRoleRooms = await this.importCustomBundleRoleRooms({
        packageData,
        roleManifest: roleRuntime.roleManifest,
        importedPersona: roleRuntime.importedPersona,
        targetScopeId: roleRuntime.targetScopeId,
        chatScopeId: roleRuntime.chatScopeId,
        runtime: roleRuntime.runtime,
        currentSharedMode,
        roomRefCounts,
        sharedImportedRooms,
        usedSessionIds,
        worldIdMap,
        importedLocalSetKeys,
        importedMemoryTemplateId,
        presetImportCache,
        diagnosticsNotes: diagnostics.notes,
        roleDiagnostics: roleRuntime.roleDiagnostics,
        importedTargets,
        completedRoomUnits,
        totalRoomUnits,
        fileName,
        markTouchedRuntime,
      });
      completedRoomUnits = importedRoleRooms.completedRoomUnits;
    }

    this.reportImportProgress({
      phase: 'flush',
      progress: 92,
      status: '正在写入本地资料...',
      fileName,
    });
    diagnostics.phases.flushMs = await this.flushCustomBundleTouchedRuntimes({
      touchedScopes,
      touchedRuntimes,
    });
    diagnostics.scopes = Array.from(touchedScopes.values());
    this.emitCustomBundleImportCompletionEvents();
    const result = buildCustomBundleImportResultPayload({ importedTargets });
    Object.assign(diagnostics, buildCustomBundleImportCompletionPatch({
      importedTargets,
      firstTarget: result.firstTarget,
      durationMs: getPerfNow() - startedPerf,
      finishedAt: Date.now(),
    }));
    this.publishImportDiagnostics(diagnostics);
    this.reportImportProgress(buildCustomBundleImportDoneProgressDetail({
      importedTargets,
      fileName,
    }));
    return {
      ...result,
      diagnostics,
    };
  }

  async switchToImportedTarget(target) {
    const personaId = String(target?.personaId || '').trim();
    const sessionId = String(target?.sessionId || '').trim();
    if (personaId) {
      try {
        await this.appBridge?.switchPersona?.(personaId);
      } catch (err) {
        logger.warn('switch imported persona failed', err);
      }
    }
    if (sessionId) {
      try {
        await Promise.allSettled([
          this.appBridge?.chatStore?.fullyReady,
          this.appBridge?.chatStore?.ready,
          this.appBridge?.chatStore?._v2Ready,
          this.contactsStore?.ready,
        ]);
        this.appBridge?.chatStore?.switchSession?.(sessionId);
        this.appBridge?.setActiveSession?.(sessionId);
        await this.appBridge?.chatStore?.ensureRecentMessagesLoaded?.(sessionId);
        window.dispatchEvent(new CustomEvent('session-changed', { detail: { id: sessionId } }));
      } catch (err) {
        logger.warn('switch imported session failed', err);
      }
    }
  }

  async importFromFile(file, { prefetchedEntries = null } = {}) {
    if (!file) return false;
    if (!hasTauriRuntime()) {
      window.toastr?.warning?.('当前环境不支持自定义资料包导入');
      return false;
    }
    const importStarted = getPerfNow();
    const fileName = String(file?.name || '').trim();
    emitDebugLog(buildCustomBundleImportFileSelectedDebugLog({ fileName }));
    this.reportImportProgress(buildCustomBundleImportReadFileProgressDetail({
      fileName,
    }));
    try {
      let entries = Array.isArray(prefetchedEntries) ? prefetchedEntries : null;
      if (!entries) {
        const buffer = await readFileAsArrayBuffer(file);
        const bytes = Array.from(new Uint8Array(buffer));
        this.reportImportProgress(buildCustomBundleImportReadZipProgressDetail({
          fileName,
        }));
        entries = await safeInvoke('read_zip_entries', { bytes });
      } else {
        this.reportImportProgress(buildCustomBundleImportReadZipProgressDetail({
          fileName,
          reusedPrefetchedEntries: true,
        }));
      }
      const packageData = this.parsePackageEntries(entries);
      this.reportImportProgress(buildCustomBundleImportPreviewProgressDetail({
        fileName,
      }));
      const confirmed = await this.confirmImport(packageData, fileName);
      if (!confirmed) {
        this.reportImportProgress(buildCustomBundleImportCancelledProgressDetail({
          fileName,
        }));
        return false;
      }
      const result = await this.importPackage(packageData, { fileName });
      const target = result?.firstTarget || null;
      if (shouldPromptCustomBundleImportSwitch(target)) {
        const shouldSwitch = await appConfirm(buildCustomBundleImportSwitchConfirmOptions({
          importedTargets: result?.importedTargets,
        }));
        if (shouldSwitch) {
          await this.switchToImportedTarget(target);
        }
      }
      window.toastr?.success?.('自定义资料包导入完成');
      return true;
    } catch (err) {
      this.reportImportProgress(buildCustomBundleImportFailedProgressDetail({
        error: err,
        fileName,
      }));
      this.publishImportDiagnostics(buildCustomBundleImportFailureDiagnostics({
        fileName,
        error: err,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: roundDuration(getPerfNow() - importStarted),
      }));
      throw err;
    }
  }

  async exportSelected(roles, state) {
    const summary = this.computeSummary(roles, state);
    if (!summary.roles || (!summary.chats && !summary.creative && !summary.momentScopes)) {
      window.toastr?.warning?.('请至少选择一个角色会话、创意写作或动态内容');
      return '';
    }
    const confirmed = await this.confirmRiskyExport(summary, state);
    if (!confirmed) return '';
    const built = await this.buildPackage(roles, state);
    const pick = await pickSavePath({
      defaultName: built.fileName,
      filters: [{ name: 'ZIP', extensions: [CUSTOM_BUNDLE_EXTENSION] }],
    });
    if (pick.cancelled) return '';
    try {
      const resp = await safeInvoke('export_sticker_zip', {
        entries: built.entries,
        fileName: built.fileName,
        path: pick.path || '',
      });
      const savedPath = String(resp?.path || '').trim();
      const bytes = Number(resp?.bytes || 0);
      const sizeText = bytes ? `（${formatBytes(bytes)}）` : '';
      if (savedPath) {
        window.toastr?.success?.(`已导出自定义资料包：${savedPath}${sizeText}`);
      } else {
        window.toastr?.success?.(`已导出自定义资料包${sizeText}`);
      }
      return savedPath;
    } catch (err) {
      window.toastr?.error?.(`自定义资料包导出失败：${err?.message || '未知错误'}`);
      throw err;
    }
  }
}
