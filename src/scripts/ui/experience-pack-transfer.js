import { stickerPackStore } from '../storage/sticker-pack-store.js';
import { customReactionAssets, customReactionImportWarning } from './chat/custom-reaction-assets.js';
import { BUILTIN_PHONE_FORMAT_WORLDBOOK_ID } from '../storage/builtin-worldbooks.js';
import { logger } from '../utils/logger.js';
import { pickSavePath } from '../utils/save-dialog.js';
import { safeInvoke } from '../utils/tauri.js';
import { appConfirm } from './app-confirm.js';
import { CharacterCardTransfer } from './character-card-transfer.js';
import { createConfigRuntimeAdapter } from './config-runtime-utils.js';
import {
  buildExperiencePackPersonaBundlePayload,
  buildExperiencePackJsonEntryPayloads,
  buildExperiencePackManifest,
  buildExperiencePackStickerItemPayload,
  buildExperiencePackStickerPackPayload,
  buildExperiencePackWallpaperFilePayload,
  buildExperiencePackWallpaperRemotePayload,
} from './experience-pack-export-utils.js';
import {
  buildExperiencePackArchiveMessageRestoreJobs,
  buildExperiencePackImportedConnectionProfileNameBase,
  buildExperiencePackImportedContactRecord,
  buildExperiencePackImportSwitchConfirmOptions,
  buildExperiencePackLegacyRestoredArchives,
  buildExperiencePackPresetUpsertPayload,
  buildExperiencePackRemoteWallpaperSettings,
  buildExperiencePackRoomBaseSettings,
  buildExperiencePackRestoredSessionChatState,
  buildExperiencePackSavedWallpaperSettings,
  buildExperiencePackSessionChangedDetail,
  buildExperiencePackSessionSettings,
  buildExperiencePackWallpaperSaveRequest,
  getExperiencePackImportBaseName,
  mapExperiencePackImportedWorldIds,
  normalizeExperiencePackChatArchivePayloads,
  normalizeExperiencePackCompactedSummary,
  normalizeExperiencePackSummaryList,
} from './experience-pack-import-utils.js';
import {
  bindImportedPresetToSession,
  resolveImportedPresetIdByName,
} from './preset-import-dedupe-utils.js';
import { getPresetStore } from './preset-store-runtime-utils.js';
import { collectTransferWorldbookBundle } from './transfer-worldbook-utils.js';
import { hasStoredWorldInfo, waitForWorldStoreReady } from './world-store-runtime-utils.js';
import { emitWorldInfoChanged } from './world-session-runtime-utils.js';
import { buildZipEntryMap, readZipEntryJson } from './zip-entry-utils.js';

const EXPERIENCE_PACK_FORMAT = 'chatapp.experience-pack.v1';
const EXPERIENCE_PACK_EXTENSION = 'aicpack';
const EXPERIENCE_PACK_VERSION = 1;
const CHAT_RANGE_OPTIONS = ['opening_only', 'recent_50', 'all'];
const PRESET_TYPES = ['sysprompt', 'context', 'instruct', 'openai', 'reasoning'];

const hasTauriRuntime = () => {
  const g = typeof globalThis !== 'undefined' ? globalThis : window;
  return Boolean(g?.__TAURI__ || g?.__TAURI_INTERNALS__ || g?.__TAURI_INVOKE__);
};

const ensureArray = (value) => (Array.isArray(value) ? value : []);

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

const sanitizeExportName = (value, fallback = 'download') => {
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

const readFileAsArrayBuffer = file =>
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
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain';
  return 'application/octet-stream';
};

const isRemoteUrl = (value) => /^https?:\/\//i.test(String(value || '').trim());

const looksLikeLocalPath = (value) => {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('data:') || isRemoteUrl(raw)) return false;
  return /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/') || raw.startsWith('\\');
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

const estimateDataUrlBytes = (dataUrl) => {
  const raw = String(dataUrl || '').trim();
  if (!raw.startsWith('data:')) return raw.length;
  const comma = raw.indexOf(',');
  if (comma < 0) return raw.length;
  const base64 = raw.slice(comma + 1);
  const padding = (base64.match(/=+$/) || [''])[0].length;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
};

const escapeHtml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildDialogButtonStyle = (variant = 'default') => {
  if (variant === 'primary') {
    return 'padding:10px 14px; border:none; border-radius:10px; background:#019aff; color:var(--app-text-inverse); cursor:pointer; font-weight:800;';
  }
  if (variant === 'danger') {
    return 'padding:10px 14px; border:1px solid #fecaca; border-radius:10px; background:var(--app-surface-card); color:#b91c1c; cursor:pointer; font-weight:700;';
  }
  return 'padding:10px 14px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-card); color:var(--app-text-primary); cursor:pointer; font-weight:700;';
};

const createOverlay = ({ title = '', width = 'min(420px, 92vw)' } = {}) => {
  const overlay = document.createElement('div');
  overlay.className = 'app-themed-overlay experience-pack-overlay';
  overlay.style.cssText = `
    position:fixed; inset:0; background:rgba(15,23,42,0.5);
    display:flex; align-items:center; justify-content:center;
    padding:16px; z-index:23000;
  `;
  const panel = document.createElement('div');
  panel.className = 'app-themed-panel experience-pack-panel';
  panel.style.cssText = `
    width:${width};
    max-height:min(82vh, 760px);
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
    <div data-role="footer" style="padding:14px 16px; border-top:1px solid var(--app-border-subtle); display:flex; gap:10px; justify-content:flex-end;"></div>
  `;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', close);
  panel.addEventListener('click', event => event.stopPropagation());
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

const sanitizeProfileForPack = (profile, { hideServiceAddresses = false } = {}) => {
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

export class ExperiencePackTransfer extends CharacterCardTransfer {
  constructor({
    chatStore,
    contactsStore,
    memoryTableStore,
    memoryTemplateStore,
    personaStore,
    presetStore = null,
    appBridge,
  } = {}) {
    super({ chatStore, contactsStore, memoryTableStore, memoryTemplateStore, appBridge });
    this.personaStore = personaStore || null;
    this.presetStore = presetStore || getPresetStore(appBridge);
    this.configManager = appBridge ? createConfigRuntimeAdapter(appBridge) : null;
  }

  getEffectivePersona(sessionId) {
    const sid = String(sessionId || '').trim();
    const lockedId = String(this.chatStore?.getPersonaLock?.(sid) || '').trim();
    if (lockedId && this.personaStore?.get) {
      const locked = this.personaStore.get(lockedId);
      if (locked) return locked;
    }
    return this.personaStore?.getActive?.() || null;
  }

  async loadPersonaCardData(persona) {
    if (!persona || typeof persona !== 'object') return null;
    if (persona.originalCard && typeof persona.originalCard === 'object') {
      return cloneJson(persona.originalCard, null);
    }
    try {
      return cloneJson(await this.appBridge?.loadPersonaCard?.(persona.id), null);
    } catch (err) {
      logger.warn('load persona card for experience pack failed', err);
      return null;
    }
  }

  async collectExportPreview(sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) throw new Error('未选择聊天');
    const contact = this.contactsStore?.getContact?.(sid) || { id: sid, name: sid };
    const worldIds = Array.from(
      new Set(
        ensureArray(this.appBridge?.getWorldIdsForSession?.(sid))
          .map(id => String(id || '').trim())
          .filter(id => id && id !== BUILTIN_PHONE_FORMAT_WORLDBOOK_ID)
      )
    );
    const regexStore = this.regexStore;
    const sessionRegex = regexStore?.getSession?.(sid) || null;
    const localSets = ensureArray(regexStore?.listLocalSets?.()).filter((set) =>
      set?.bind?.type === 'world' && worldIds.includes(String(set.bind.worldId || '').trim())
    );
    const packs = ensureArray(stickerPackStore.getPacks?.()).filter(pack =>
      ensureArray(pack?.boundSessions).includes(sid)
    );
    const currentMessages = ensureArray(await this.chatStore?.exportThreadMessages?.(sid, ''));
    const archives = ensureArray(this.chatStore?.getArchives?.(sid));
    const archiveMessageCounts = [];
    for (const archive of archives) {
      const archiveId = String(archive?.id || '').trim();
      if (!archiveId) continue;
      const messages = ensureArray(await this.chatStore?.exportThreadMessages?.(sid, archiveId));
      archiveMessageCounts.push(messages.length);
    }
    const memorySnapshot = await this.buildMemorySnapshot(sid, { isGroup: Boolean(contact?.isGroup) });
    const persona = this.getEffectivePersona(sid);
    const settings = this.chatStore?.getSessionSettings?.(sid) || {};
    const activeProfileId = this.presetStore?.getSessionProfileId?.('openai', sid)
      || this.presetStore?.getModeProfileId?.('openai', 'chat')
      || this.configManager?.getActiveProfileId?.()
      || '';
    return {
      sessionId: sid,
      contactName: String(contact?.name || sid).trim() || sid,
      worldCount: worldIds.length,
      regexCount: ensureArray(sessionRegex?.rules).length + localSets.reduce((sum, set) => sum + ensureArray(set?.rules).length, 0),
      localRegexSetCount: localSets.length,
      stickerPackCount: packs.length,
      currentMessageCount: currentMessages.length,
      archiveCount: archives.length,
      totalMessageCount: currentMessages.length + archiveMessageCounts.reduce((sum, count) => sum + count, 0),
      memoryRowCount: ensureArray(memorySnapshot?.rows).length,
      hasPersona: Boolean(persona),
      hasWallpaper: Boolean(settings?.wallpaper),
      hasConnectionProfile: Boolean(activeProfileId),
    };
  }

  async showExportDialog(sessionId) {
    const preview = await this.collectExportPreview(sessionId);
    return new Promise((resolve) => {
      const modal = createOverlay({ title: '导出角色体验包', width: 'min(460px, 92vw)' });
      const body = modal.body;
      const footer = modal.footer;
      body.innerHTML = `
        <div style="color:var(--app-text-secondary); font-size:13px; line-height:1.5;">
          角色：<strong style="color:var(--app-text-primary);">${escapeHtml(preview.contactName)}</strong>
        </div>
        <div style="padding:12px; border:1px solid var(--app-border-default); border-radius:12px; background:var(--app-surface-subtle); display:flex; flex-direction:column; gap:10px;">
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" checked disabled style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">核心内容</div>
              <div style="font-size:12px; color:var(--app-text-muted);">联系人资料、角色卡、世界书、正则、变量定义</div>
            </div>
          </label>
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-export-room" checked style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">聊天室设定</div>
              <div style="font-size:12px; color:var(--app-text-muted);">壁纸、颜色、预设覆盖、连线设定、记忆共享配置</div>
            </div>
          </label>
          <div style="padding-left:28px; display:flex; flex-direction:column; gap:8px;">
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px;">
              <input type="checkbox" id="xp-export-stickers" ${preview.stickerPackCount ? 'checked' : ''} style="width:16px; height:16px;">
              <span>贴图包 (${preview.stickerPackCount})</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px;">
              <input type="checkbox" id="xp-export-memory-template" checked style="width:16px; height:16px;">
              <span>记忆表格模板</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px;">
              <input type="checkbox" id="xp-export-hide-addresses" style="width:16px; height:16px;">
              <span>隐藏服务地址（分享推荐）</span>
            </label>
          </div>
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-export-memory-data" style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">记忆数据</div>
              <div style="font-size:12px; color:var(--app-text-muted);">当前角色记忆行 (${preview.memoryRowCount})</div>
            </div>
          </label>
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-export-variable-state" style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">会话变量快照</div>
              <div style="font-size:12px; color:var(--app-text-muted);">导出当前变量值与初始值</div>
            </div>
          </label>
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-export-chat" style="width:18px; height:18px; margin-top:2px;">
            <div style="flex:1;">
              <div style="font-weight:800; color:var(--app-text-primary);">聊天记录</div>
              <div style="font-size:12px; color:var(--app-text-muted);">当前 ${preview.currentMessageCount} 条，历史存档 ${preview.archiveCount} 份</div>
              <select id="xp-export-chat-range" style="margin-top:8px; width:100%; padding:8px 10px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-card); color:var(--app-text-primary); font-size:13px;" disabled>
                <option value="opening_only">仅开场白</option>
                <option value="recent_50">最近 50 条</option>
                <option value="all" selected>全部</option>
              </select>
            </div>
          </label>
        </div>
        <div style="padding:10px 12px; border:1px solid #fcd34d; border-radius:12px; background:rgba(254,243,199,0.18); color:var(--app-text-secondary); font-size:12px; line-height:1.6;">
          勾选聊天记录、记忆数据或变量快照后，包中会包含当前角色的运行内容。公开分享前请确认。
        </div>
      `;
      const roomToggle = body.querySelector('#xp-export-room');
      const stickersToggle = body.querySelector('#xp-export-stickers');
      const memoryTemplateToggle = body.querySelector('#xp-export-memory-template');
      const hideAddressesToggle = body.querySelector('#xp-export-hide-addresses');
      const memoryDataToggle = body.querySelector('#xp-export-memory-data');
      const variableStateToggle = body.querySelector('#xp-export-variable-state');
      const chatToggle = body.querySelector('#xp-export-chat');
      const chatRange = body.querySelector('#xp-export-chat-range');
      const syncRoomChildren = () => {
        const enabled = roomToggle?.checked !== false;
        [stickersToggle, memoryTemplateToggle, hideAddressesToggle].forEach((input) => {
          if (!input) return;
          input.disabled = !enabled;
        });
      };
      const syncChatRange = () => {
        if (chatRange) chatRange.disabled = chatToggle?.checked !== true;
      };
      roomToggle?.addEventListener('change', syncRoomChildren);
      chatToggle?.addEventListener('change', syncChatRange);
      syncRoomChildren();
      syncChatRange();

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = buildDialogButtonStyle();
      cancelBtn.addEventListener('click', () => {
        modal.close();
        resolve(null);
      });
      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.textContent = '导出';
      submitBtn.style.cssText = buildDialogButtonStyle('primary');
      submitBtn.addEventListener('click', async () => {
        const options = {
          includeCore: true,
          includeRoom: roomToggle?.checked !== false,
          includeStickers: roomToggle?.checked === true && stickersToggle?.checked === true,
          includeMemoryTemplate: roomToggle?.checked === true && memoryTemplateToggle?.checked === true,
          hideServiceAddresses: roomToggle?.checked === true && hideAddressesToggle?.checked === true,
          includeMemoryData: memoryDataToggle?.checked === true,
          includeVariableState: variableStateToggle?.checked === true,
          includeChatHistory: chatToggle?.checked === true,
          chatRange: CHAT_RANGE_OPTIONS.includes(String(chatRange?.value || '').trim()) ? String(chatRange.value) : 'all',
        };
        if (options.includeChatHistory || options.includeMemoryData || options.includeVariableState) {
          const ok = await appConfirm({
            title: '确认导出内容',
            message: '当前选择包含聊天内容或运行时数据。分享前请确认资料来源和接收对象可信。',
            confirmText: '继续导出',
            cancelText: '返回检查',
            danger: true,
          });
          if (!ok) return;
        }
        modal.close();
        resolve(options);
      });
      footer.append(cancelBtn, submitBtn);
    });
  }

  async collectWorldbookBundle(sessionId) {
    return collectTransferWorldbookBundle({
      appBridge: this.appBridge,
      sessionId,
      cloneWorldbook: data => cloneJson(data, {}),
      onError: err => logger.warn('collect worldbook for experience pack failed', err),
    });
  }

  collectVariableCore(sessionId) {
    const sid = String(sessionId || '').trim();
    return {
      schemas: cloneJson(this.chatStore?.listVariableSchemas?.(sid) || {}, {}),
      rules: cloneJson(this.chatStore?.listVariableRules?.(sid) || [], []),
      stageSchema: cloneJson(this.chatStore?.getStageSchema?.(sid) || null, null),
    };
  }

  collectVariableState(sessionId) {
    const sid = String(sessionId || '').trim();
    return {
      values: cloneJson(this.chatStore?.listVariables?.(sid) || {}, {}),
      initialValues: cloneJson(this.chatStore?.listInitialVariables?.(sid) || {}, {}),
    };
  }

  collectRegexBundle(sessionId, worldIds = []) {
    const sid = String(sessionId || '').trim();
    const regexStore = this.regexStore;
    const sessionRegex = cloneJson(regexStore?.getSession?.(sid) || null, null);
    const localSets = ensureArray(regexStore?.listLocalSets?.())
      .filter(set => set?.bind?.type === 'world' && worldIds.includes(String(set.bind.worldId || '').trim()))
      .map(set => cloneJson(set, null))
      .filter(Boolean);
    return { session: sessionRegex, localSets };
  }

  async collectPersonaBundle(sessionId, assets) {
    const sid = String(sessionId || '').trim();
    const contact = this.contactsStore?.getContact?.(sid) || { id: sid, name: sid };
    const avatarRaw = String(contact?.avatar || '').trim();
    const avatarFile = assets.addSource(`assets/contact_avatar.${inferImageExtension(avatarRaw, 'png')}`, avatarRaw);
    const persona = this.getEffectivePersona(sid);
    if (!persona) {
      return buildExperiencePackPersonaBundlePayload({
        contact,
        sessionId: sid,
        contactAvatarFile: avatarFile || '',
        contactAvatarRaw: avatarRaw,
      });
    }
    const personaAvatarRaw = String(persona?.avatar || '').trim();
    const personaAvatarFile = assets.addSource(
      `assets/persona_avatar.${inferImageExtension(personaAvatarRaw, 'png')}`,
      personaAvatarRaw
    );
    const originalCard = await this.loadPersonaCardData(persona);
    return buildExperiencePackPersonaBundlePayload({
      contact,
      sessionId: sid,
      contactAvatarFile: avatarFile || '',
      contactAvatarRaw: avatarRaw,
      persona,
      personaAvatarFile: personaAvatarFile || '',
      personaAvatarRaw,
      personaCard: originalCard,
    });
  }

  async collectMemoryTemplateRecord() {
    try {
      const templateId = await this.resolveDefaultMemoryTemplateId();
      if (!templateId || !this.memoryTemplateStore?.getTemplateById) return null;
      return cloneJson(await this.memoryTemplateStore.getTemplateById(templateId), null);
    } catch (err) {
      logger.warn('collect memory template failed', err);
      return null;
    }
  }

  collectResolvedPresetBundle(sessionId) {
    const sid = String(sessionId || '').trim();
    const store = this.presetStore;
    if (!store) return { presets: {}, profile: null, reasoning: null };
    const presets = {};
    PRESET_TYPES.forEach((type) => {
      try {
        const resolved = store.getResolvedActive?.(type, { sessionId: sid, uiMode: 'chat' }) || null;
        if (!resolved?.preset) return;
        presets[type] = {
          name: String(resolved.preset?.name || type),
          source: String(resolved.source || 'global'),
          data: cloneJson(resolved.preset, {}),
        };
      } catch (err) {
        logger.warn('collect resolved preset failed', err);
      }
    });
    return { presets };
  }

  collectAgentCenterSettingsBundle() {
    try {
      const actions = this.appBridge?.debugUiRegistry?.actions || {};
      const settings = typeof actions.getAgentCenterSettings === 'function'
        ? actions.getAgentCenterSettings()
        : null;
      return settings && typeof settings === 'object' ? cloneJson(settings, null) : null;
    } catch (err) {
      logger.warn('collect agent center settings failed', err);
      return null;
    }
  }

  async collectConnectionProfileBundle(sessionId, { hideServiceAddresses = false } = {}) {
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
        || String(presetStore.getModeProfileId?.('openai', 'chat') || '').trim()
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
      || presetStore.getModeReasoning?.('openai', 'chat')
      || null,
      null
    );
    return {
      profile: sanitizeProfileForPack(profile, { hideServiceAddresses }),
      reasoning,
    };
  }

  async collectWallpaperBundle(sessionId, settings, assets) {
    const wallpaper = settings?.wallpaper;
    if (!wallpaper || typeof wallpaper !== 'object') return null;
    const path = String(wallpaper.path || '').trim();
    const url = String(wallpaper.url || wallpaper.dataUrl || '').trim();
    const source = path || url;
    const ext = path ? inferMimeFromName(path).split('/')[1] || 'png' : inferImageExtension(url, 'png');
    const file = assets.addSource(`room/wallpaper.${ext}`, source);
    if (file) {
      return buildExperiencePackWallpaperFilePayload({ file, wallpaper });
    }
    if (isRemoteUrl(url)) {
      return buildExperiencePackWallpaperRemotePayload({ remoteUrl: url, wallpaper });
    }
    return null;
  }

  async collectStickerBundle(sessionId, assets) {
    const sid = String(sessionId || '').trim();
    const packs = ensureArray(stickerPackStore.getPacks?.()).filter(pack =>
      ensureArray(pack?.boundSessions).includes(sid)
    );
    return packs.map((pack, packIndex) => {
      const packSlug = slugifySegment(pack?.name || pack?.id || `pack_${packIndex + 1}`, `pack_${packIndex + 1}`);
      const iconSource = String(pack?.iconDataUrl || pack?.iconPath || '').trim();
      const iconFile = assets.addSource(`room/stickers/${packSlug}/icon.${inferImageExtension(iconSource, 'png')}`, iconSource);
      const stickers = ensureArray(pack?.stickers).map((sticker, stickerIndex) => {
        const stickerSlug = slugifySegment(sticker?.name || sticker?.id || `sticker_${stickerIndex + 1}`, `sticker_${stickerIndex + 1}`);
        const stickerSource = String(sticker?.dataUrl || sticker?.path || '').trim();
        const assetFile = assets.addSource(
          `room/stickers/${packSlug}/${stickerSlug}.${inferImageExtension(stickerSource, 'png')}`,
          stickerSource
        );
        const frameFiles = ensureArray(sticker?.frames)
          .map((frame, frameIndex) => assets.addSource(
            `room/stickers/${packSlug}/${stickerSlug}_frame_${String(frameIndex + 1).padStart(2, '0')}.${inferImageExtension(frame, 'png')}`,
            frame
          ))
          .filter(Boolean);
        return buildExperiencePackStickerItemPayload({
          sticker,
          assetFile: assetFile || '',
          frameFiles,
        });
      });
      return buildExperiencePackStickerPackPayload({
        pack,
        iconFile: iconFile || '',
        stickers,
      });
    });
  }

  async collectRoomBundle(sessionId, options, assets) {
    const sid = String(sessionId || '').trim();
    const rawSettings = cloneJson(this.chatStore?.getSessionSettings?.(sid) || {}, {});
    delete rawSettings.personaLockId;
    const wallpaper = await this.collectWallpaperBundle(sid, rawSettings, assets);
    if (rawSettings.wallpaper) rawSettings.wallpaper = null;
    return {
      sessionSettings: rawSettings,
      wallpaper,
      presets: this.collectResolvedPresetBundle(sid),
      agentCenterSettings: this.collectAgentCenterSettingsBundle(),
      connection: await this.collectConnectionProfileBundle(sid, {
        hideServiceAddresses: options.hideServiceAddresses === true,
      }),
      stickers: options.includeStickers ? await this.collectStickerBundle(sid, assets) : [],
      memoryTemplate: options.includeMemoryTemplate ? await this.collectMemoryTemplateRecord() : null,
    };
  }

  async collectChatBundle(sessionId, { range = 'all', includeMemoryData = false } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    const session = this.chatStore?.state?.sessions?.[sid] || {};
    let currentMessages = ensureArray(await this.chatStore?.exportThreadMessages?.(sid, ''));
    let archives = [];
    let exportedRange = CHAT_RANGE_OPTIONS.includes(String(range || '').trim()) ? String(range) : 'all';
    if (exportedRange === 'opening_only') {
      currentMessages = currentMessages.length ? [currentMessages[0]] : [];
    } else if (exportedRange === 'recent_50') {
      currentMessages = currentMessages.slice(-50);
    } else {
      const archiveList = ensureArray(this.chatStore?.getArchives?.(sid));
      archives = await Promise.all(
        archiveList.map(async (archive) => {
          const archiveId = String(archive?.id || '').trim();
          if (!archiveId) return null;
          const messages = ensureArray(await this.chatStore?.exportThreadMessages?.(sid, archiveId));
          return {
            id: archiveId,
            name: String(archive?.name || ''),
            timestamp: Number(archive?.timestamp || 0) || 0,
            messageCount: Number(archive?.messageCount || messages.length) || messages.length,
            summaries: normalizeExperiencePackSummaryList(archive?.summaries || []),
            compactedSummary: normalizeExperiencePackCompactedSummary(archive?.compactedSummary || null),
            compactedSummaryLastRaw: cloneJson(archive?.compactedSummaryLastRaw || null, null),
            memoryTableSnapshot: includeMemoryData ? cloneJson(archive?.memoryTableSnapshot || null, null) : null,
            messages,
          };
        })
      );
      archives = archives.filter(Boolean);
    }
    return {
      exportedRange,
      draft: String(session?.draft || ''),
      current: {
        detachedSummaries: normalizeExperiencePackSummaryList(session?.detachedSummaries || []),
        compactedSummary: normalizeExperiencePackCompactedSummary(session?.compactedSummary || null),
        compactedSummaryLastRaw: cloneJson(session?.compactedSummaryLastRaw || null, null),
      },
      currentMessages,
      archives,
    };
  }

  async buildPackage(sessionId, options = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) throw new Error('未选择聊天');
    const assets = createAssetCollector();
    const character = await this.collectPersonaBundle(sid, assets);
    const world = await this.collectWorldbookBundle(sid);
    const variableCore = this.collectVariableCore(sid);
    const variableState = options.includeVariableState ? this.collectVariableState(sid) : null;
    const regex = this.collectRegexBundle(sid, world.worldIds);
    const room = options.includeRoom ? await this.collectRoomBundle(sid, options, assets) : null;
    const memoryData = options.includeMemoryData
      ? await this.buildMemorySnapshot(sid, { isGroup: false })
      : null;
    const chat = options.includeChatHistory
      ? await this.collectChatBundle(sid, {
          range: options.chatRange || 'all',
          includeMemoryData: options.includeMemoryData === true,
        })
      : null;

    const reactions = customReactionAssets.collect([
      ...(chat?.currentMessages || []), ...(chat?.archives || []).flatMap(archive => archive.messages || []),
    ], assets, 'chat/reactions');
    const manifest = buildExperiencePackManifest({
      sessionId: sid,
      character,
      room,
      memoryData,
      variableState,
      chat,
      options,
      format: EXPERIENCE_PACK_FORMAT,
      formatVersion: EXPERIENCE_PACK_VERSION,
    });

    const entries = buildExperiencePackJsonEntryPayloads({
      manifest,
      character,
      world,
      variableCore,
      regex,
      variableState,
      room,
      memoryData,
      chat,
      archiveEntryNameForId: archiveId => `chat/archives/${slugifySegment(archiveId, 'archive')}.json`,
    }).map(entry => ({
      name: entry.name,
      data_url: textToDataUrl(JSON.stringify(entry.value, null, 2), 'application/json'),
    }));
    if (reactions.length) entries.push({ name: 'chat/reactions.json', data_url: textToDataUrl(JSON.stringify(reactions), 'application/json') });
    entries.push(...assets.entries);

    const fileName = sanitizeExportName(`${character?.contact?.name || sid}.${EXPERIENCE_PACK_EXTENSION}`, `experience_pack.${EXPERIENCE_PACK_EXTENSION}`);
    return { manifest, entries, fileName };
  }

  async exportExperiencePack(sessionId, options = null) {
    if (!hasTauriRuntime()) {
      window.toastr?.warning?.('当前环境不支持体验包导出');
      return '';
    }
    const sid = String(sessionId || '').trim();
    if (!sid) {
      window.toastr?.warning?.('未选择聊天');
      return '';
    }
    const exportOptions = options || await this.showExportDialog(sid);
    if (!exportOptions) return '';
    const built = await this.buildPackage(sid, exportOptions);
    const pick = await pickSavePath({
      defaultName: built.fileName,
      filters: [{ name: 'OmniTavern Experience Pack', extensions: [EXPERIENCE_PACK_EXTENSION, 'zip'] }],
    });
    if (pick.cancelled) return '';
    try {
      const resp = await safeInvoke('export_sticker_zip', {
        entries: built.entries,
        fileName: built.fileName,
        path: pick.path || '',
      });
      const savedPath = String(resp?.path || '').trim();
      if (savedPath) window.toastr?.success?.(`已导出体验包：${savedPath}`);
      return savedPath;
    } catch (err) {
      window.toastr?.error?.(`体验包导出失败：${err?.message || '未知错误'}`);
      throw err;
    }
  }

  readJsonEntry(entryMap, name, fallback = null) {
    const entry = entryMap.get(name);
    if (!entry) return fallback;
    try {
      return readZipEntryJson(entry, { fallback });
    } catch (err) {
      logger.warn(`read experience pack entry failed: ${name}`, err);
    }
    return fallback;
  }

  parsePackageEntries(entries = []) {
    const list = ensureArray(entries);
    const entryMap = buildZipEntryMap(list);
    const manifest = this.readJsonEntry(entryMap, 'manifest.json', null);
    if (!manifest || String(manifest.format || '').trim() !== EXPERIENCE_PACK_FORMAT) {
      throw new Error('不支持的体验包格式');
    }
    const sessionJson = this.readJsonEntry(entryMap, 'chat/session.json', null);
    const archives = [];
    entryMap.forEach((_entry, name) => {
      if (!name.startsWith('chat/archives/') || !name.endsWith('.json')) return;
      const parsed = this.readJsonEntry(entryMap, name, null);
      if (parsed) archives.push(parsed);
    });
    return {
      manifest,
      entryMap,
      character: this.readJsonEntry(entryMap, 'character.json', {}),
      worldbooks: this.readJsonEntry(entryMap, 'worldbook/worldbooks.json', {}),
      variableCore: this.readJsonEntry(entryMap, 'variables/core.json', null),
      variableState: this.readJsonEntry(entryMap, 'variables/state.json', null),
      regex: this.readJsonEntry(entryMap, 'scripts/regex.json', null),
      roomConfig: this.readJsonEntry(entryMap, 'room/config.json', null),
      roomPresets: this.readJsonEntry(entryMap, 'room/presets.json', null),
      roomAgentCenterSettings: this.readJsonEntry(entryMap, 'room/agent-center-settings.json', null),
      roomConnection: this.readJsonEntry(entryMap, 'room/connection-profile.json', null),
      roomStickers: this.readJsonEntry(entryMap, 'room/stickers.json', []),
      memoryTemplate: this.readJsonEntry(entryMap, 'memory/template.json', null),
      memoryData: this.readJsonEntry(entryMap, 'memory/data.json', null),
      personaCard: this.readJsonEntry(entryMap, 'persona/original-card.json', null),
      chatSession: sessionJson,
      chatCurrent: this.readJsonEntry(entryMap, 'chat/current.json', []),
      reactionAssets: this.readJsonEntry(entryMap, 'chat/reactions.json', []),
      chatArchives: archives,
    };
  }

  getEntryDataUrl(packageData, refName = '') {
    const key = String(refName || '').trim().replace(/\\/g, '/');
    if (!key) return '';
    return toDataUrlFromEntry(packageData?.entryMap?.get(key), key);
  }

  async showImportDialog(packageData, fileName = '') {
    const manifest = packageData?.manifest || {};
    const layers = manifest.layers || {};
    const characterName =
      String(packageData?.character?.contact?.name || manifest?.character?.name || fileName || '角色体验包').trim()
      || '角色体验包';
    const worldCount = Object.keys(packageData?.worldbooks?.worldbooks || packageData?.worldbooks || {}).length;
    const stickerCount = ensureArray(packageData?.roomStickers).length;
    const currentMessages = ensureArray(packageData?.chatCurrent);
    const archiveCount = ensureArray(packageData?.chatArchives).length;
    return new Promise((resolve) => {
      const modal = createOverlay({ title: '导入角色体验包', width: 'min(460px, 92vw)' });
      modal.body.innerHTML = `
        <div style="color:var(--app-text-secondary); font-size:13px; line-height:1.6;">
          角色：<strong style="color:var(--app-text-primary);">${escapeHtml(characterName)}</strong><br>
          导出时间：${escapeHtml(String(manifest.exportedAt || '未知'))}
        </div>
        <div style="padding:12px; border:1px solid var(--app-border-default); border-radius:12px; background:var(--app-surface-subtle); display:flex; flex-direction:column; gap:10px;">
          <label style="display:flex; align-items:flex-start; gap:10px;">
            <input type="checkbox" checked disabled style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">核心内容</div>
              <div style="font-size:12px; color:var(--app-text-muted);">联系人/角色卡、世界书(${worldCount})、正则、变量定义</div>
            </div>
          </label>
          ${layers.room ? `
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-import-room" checked style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">聊天室设定</div>
              <div style="font-size:12px; color:var(--app-text-muted);">壁纸、外观、预设、连线设定</div>
            </div>
          </label>
          ` : ''}
          ${layers.stickers ? `
          <label style="display:flex; align-items:center; gap:10px; cursor:pointer; padding-left:28px; font-size:13px;">
            <input type="checkbox" id="xp-import-stickers" checked style="width:16px; height:16px;">
            <span>贴图包 (${stickerCount})</span>
          </label>
          ` : ''}
          ${layers.memory_template ? `
          <label style="display:flex; align-items:center; gap:10px; cursor:pointer; padding-left:28px; font-size:13px;">
            <input type="checkbox" id="xp-import-memory-template" checked style="width:16px; height:16px;">
            <span>记忆模板</span>
          </label>
          ` : ''}
          ${layers.memory_data ? `
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-import-memory-data" checked style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">记忆数据</div>
              <div style="font-size:12px; color:var(--app-text-muted);">导入角色已有记忆行</div>
            </div>
          </label>
          ` : ''}
          ${layers.variable_state ? `
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-import-variable-state" checked style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">变量快照</div>
              <div style="font-size:12px; color:var(--app-text-muted);">恢复会话变量当前值</div>
            </div>
          </label>
          ` : ''}
          ${layers.chat_history ? `
          <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer;">
            <input type="checkbox" id="xp-import-chat" checked style="width:18px; height:18px; margin-top:2px;">
            <div>
              <div style="font-weight:800; color:var(--app-text-primary);">聊天记录</div>
              <div style="font-size:12px; color:var(--app-text-muted);">当前 ${currentMessages.length} 条，历史存档 ${archiveCount} 份</div>
            </div>
          </label>
          ` : ''}
        </div>
        <div style="padding:10px 12px; border:1px solid var(--app-border-default); border-radius:12px; background:var(--app-surface-card); color:var(--app-text-secondary); font-size:12px; line-height:1.6;">
          导入时若遇到同名资源，将自动创建副本，不会覆盖现有联系人、世界书、贴图包或预设。
        </div>
      `;
      const roomToggle = modal.body.querySelector('#xp-import-room');
      const stickersToggle = modal.body.querySelector('#xp-import-stickers');
      const memoryTemplateToggle = modal.body.querySelector('#xp-import-memory-template');
      const syncRoomChildren = () => {
        const enabled = roomToggle?.checked !== false;
        [stickersToggle, memoryTemplateToggle].forEach((input) => {
          if (!input) return;
          input.disabled = !enabled;
        });
      };
      roomToggle?.addEventListener('change', syncRoomChildren);
      syncRoomChildren();

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = buildDialogButtonStyle();
      cancelBtn.addEventListener('click', () => {
        modal.close();
        resolve(null);
      });
      const submitBtn = document.createElement('button');
      submitBtn.type = 'button';
      submitBtn.textContent = '导入';
      submitBtn.style.cssText = buildDialogButtonStyle('primary');
      submitBtn.addEventListener('click', async () => {
        const includeChatHistory = modal.body.querySelector('#xp-import-chat')?.checked === true;
        const includeMemoryData = modal.body.querySelector('#xp-import-memory-data')?.checked === true;
        const includeVariableState = modal.body.querySelector('#xp-import-variable-state')?.checked === true;
        if (includeChatHistory || includeMemoryData || includeVariableState) {
          const ok = await appConfirm({
            title: '确认导入内容',
            message: '当前选择包含聊天内容或运行时数据。导入后会创建一份新的角色副本并写入这些内容。',
            confirmText: '继续导入',
            cancelText: '返回检查',
            danger: true,
          });
          if (!ok) return;
        }
        modal.close();
        resolve({
          includeCore: true,
          includeRoom: roomToggle ? roomToggle.checked === true : false,
          includeStickers: stickersToggle ? stickersToggle.checked === true : false,
          includeMemoryTemplate: memoryTemplateToggle ? memoryTemplateToggle.checked === true : false,
          includeMemoryData,
          includeVariableState,
          includeChatHistory,
        });
      });
      modal.footer.append(cancelBtn, submitBtn);
    });
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
    const existing = new Set(ensureArray(stickerPackStore.getState().packs).map(pack => String(pack?.id || '').trim()).filter(Boolean));
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
        logger.warn('import worldbook from experience pack failed', err);
      }
    }
    return worldIdMap;
  }

  async importRegex(packageData, sessionId, worldIdMap = {}) {
    const sid = String(sessionId || '').trim();
    const regex = packageData?.regex || null;
    if (!sid || !regex) return;
    const regexStore = this.regexStore;
    if (!regexStore) return;
    try {
      await regexStore.ready;
    } catch {}
    for (const set of ensureArray(regex?.localSets)) {
      let bind = cloneJson(set?.bind || null, null);
      if (bind?.type === 'world') {
        const rawWorldId = String(bind.worldId || '').trim();
        bind.worldId = worldIdMap[rawWorldId] || rawWorldId;
      }
      try {
        await regexStore.upsertLocalSet({
          name: String(set?.name || '导入正则').trim() || '导入正则',
          enabled: set?.enabled !== false,
          bind,
          rules: cloneJson(set?.rules || [], []),
        });
      } catch (err) {
        logger.warn('import local regex set failed', err);
      }
    }
    if (regex?.session) {
      try {
        await regexStore.setSession?.(sid, cloneJson(regex.session, {}));
      } catch (err) {
        logger.warn('import session regex failed', err);
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('regex-changed'));
    } catch {}
  }

  importVariableCore(packageData, sessionId) {
    const sid = String(sessionId || '').trim();
    const payload = packageData?.variableCore || null;
    if (!sid || !payload) return;
    Object.entries(payload?.schemas || {}).forEach(([key, schema]) => {
      this.chatStore?.setVariableSchema?.(key, cloneJson(schema, schema), sid);
    });
    this.chatStore?.setVariableRules?.(cloneJson(payload?.rules || [], []), sid);
    this.chatStore?.setStageSchema?.(cloneJson(payload?.stageSchema || null, null), sid);
  }

  importVariableState(packageData, sessionId) {
    const sid = String(sessionId || '').trim();
    const payload = packageData?.variableState || null;
    if (!sid || !payload) return;
    Object.entries(payload?.initialValues || {}).forEach(([key, value]) => {
      this.chatStore?.setInitialVariable?.(key, cloneJson(value, value), sid);
    });
    Object.entries(payload?.values || {}).forEach(([key, value]) => {
      this.chatStore?.setVariable?.(key, cloneJson(value, value), sid);
    });
  }

  async importPersona(packageData) {
    const persona = packageData?.character?.persona || null;
    if (!persona || !this.personaStore?.create) return null;
    const avatarFile = String(persona.avatarFile || '').trim();
    const avatarDataUrl = avatarFile ? this.getEntryDataUrl(packageData, avatarFile) : String(persona.avatarValue || '').trim();
    const created = await this.personaStore.create({
      name: String(persona.name || '角色').trim() || '角色',
      description: String(persona.description || ''),
      avatar: avatarDataUrl || '',
      userBubbleColor: String(persona.userBubbleColor || ''),
      userTextColor: String(persona.userTextColor || ''),
      position: Number(persona.position || 0) || 0,
      depth: Number(persona.depth || 0) || 0,
      role: Number(persona.role || 0) || 0,
      source: persona?.source && typeof persona.source === 'object'
        ? { ...cloneJson(persona.source, {}), type: 'experience_pack' }
        : { type: 'experience_pack' },
      originalCard: null,
    });
    const originalCard = packageData?.personaCard;
    if (created && originalCard) {
      try {
        await this.appBridge?.savePersonaCard?.(created.id, originalCard);
        await this.personaStore.update?.(created.id, {
          source: {
            ...(created?.source || {}),
            type: 'experience_pack',
            originalCardStored: true,
            originalCardSize: JSON.stringify(originalCard).length,
          },
        });
      } catch (err) {
        logger.warn('save imported persona card failed', err);
        try {
          await this.personaStore.update?.(created.id, {
            originalCard,
            source: { ...(created?.source || {}), type: 'experience_pack' },
          });
        } catch {}
      }
    }
    return created || null;
  }

  async importRoomData(packageData, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return null;
    const roomConfig = cloneJson(packageData?.roomConfig || {}, {});
    const roomPresets = cloneJson(packageData?.roomPresets || {}, {});
    const roomConnection = cloneJson(packageData?.roomConnection || {}, {});
    const settings = buildExperiencePackRoomBaseSettings(roomConfig);

    const wallpaper = roomConfig?.wallpaper || null;
    if (wallpaper?.file) {
      const dataUrl = this.getEntryDataUrl(packageData, wallpaper.file);
      if (dataUrl) {
        try {
          const saved = await safeInvoke('save_wallpaper', buildExperiencePackWallpaperSaveRequest({
            sessionId: sid,
            dataUrl,
            wallpaper,
          }));
          settings.wallpaper = buildExperiencePackSavedWallpaperSettings({
            wallpaper,
            savedPath: saved?.path,
          });
        } catch (err) {
          logger.warn('import wallpaper from experience pack failed', err);
        }
      }
    } else if (wallpaper?.remoteUrl) {
      settings.wallpaper = buildExperiencePackRemoteWallpaperSettings({
        currentWallpaper: settings.wallpaper,
        wallpaper,
      });
    }

    const restoredPresetIds = {};
    const presetBindingFailures = [];
    try {
      await this.presetStore?.ready;
    } catch {}
    for (const type of PRESET_TYPES) {
      const presetPayload = roomPresets?.presets?.[type];
      if (!presetPayload?.data || !this.presetStore?.upsert) continue;
      try {
        const presetId = await resolveImportedPresetIdByName({
          presetStore: this.presetStore,
          type,
          presetPayload,
          upsertPayloadBuilder: buildExperiencePackPresetUpsertPayload,
          requiredAppScope: 'all',
        });
        if (presetId) restoredPresetIds[type] = presetId;
      } catch (err) {
        logger.warn('import preset from experience pack failed', err);
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
        if (!result.ok) presetBindingFailures.push({ type, reason: result.reason });
      } catch (err) {
        presetBindingFailures.push({ type, reason: String(err?.message || 'bind_failed') });
        logger.warn('bind imported preset to session failed', err);
      }
    }
    if (presetBindingFailures.length) {
      logger.warn('experience pack preset bindings were not fully restored', presetBindingFailures);
      window.toastr?.warning?.(`体验包已导入，但有 ${presetBindingFailures.length} 项会话预设未能还原。`);
    }
    if (packageData?.roomAgentCenterSettings) {
      try {
        await this.appBridge?.debugUiRegistry?.actions?.importAgentCenterSettings?.({
          settings: packageData.roomAgentCenterSettings,
          presetIdMap: restoredPresetIds,
        });
      } catch (err) {
        logger.warn('import agent center settings from experience pack failed', err);
      }
    } else {
      try {
        await this.appBridge?.debugUiRegistry?.actions?.getAgentCenterProfileView?.({
          sessionId: sid,
          uiMode: 'chat',
        });
      } catch {}
    }

    if (roomConnection?.profile && this.configManager?.createProfile) {
      let previousActiveProfileId = '';
      try {
        previousActiveProfileId = String(this.configManager.getActiveProfileId?.() || '').trim();
      } catch {}
      try {
        const profileName = this.getUniquePresetName(
          buildExperiencePackImportedConnectionProfileNameBase(packageData)
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
        logger.warn('import connection profile from experience pack failed', err);
      }
    }
    if (roomConnection?.reasoning) {
      try {
        await this.presetStore?.setSessionReasoning?.('openai', sid, cloneJson(roomConnection.reasoning, {}));
      } catch (err) {
        logger.warn('import session reasoning failed', err);
      }
    }

    return settings;
  }

  async importStickerPacks(packageData, sessionId) {
    const sid = String(sessionId || '').trim();
    if (!sid) return [];
    const importedIds = [];
    for (const rawPack of ensureArray(packageData?.roomStickers)) {
      const packId = this.getUniqueStickerPackId(rawPack?.id || slugifySegment(rawPack?.name || 'pack', 'pack'));
      const iconDataUrl = rawPack?.iconFile ? this.getEntryDataUrl(packageData, rawPack.iconFile) : '';
      const stickers = ensureArray(rawPack?.stickers).map((sticker) => ({
        id: String(sticker?.id || `${packId}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`),
        name: String(sticker?.name || ''),
        keyword: String(sticker?.keyword || ''),
        path: '',
        dataUrl: sticker?.assetFile ? this.getEntryDataUrl(packageData, sticker.assetFile) : '',
        frames: ensureArray(sticker?.frameFiles).map(ref => this.getEntryDataUrl(packageData, ref)).filter(Boolean),
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
      importedIds.push(packId);
    }
    return importedIds;
  }

  async importMemoryTemplate(packageData) {
    const record = packageData?.memoryTemplate;
    if (!record || !this.memoryTemplateStore?.saveTemplate) return null;
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

  async restoreChatHistory(sessionId, packageData, { includeMemoryData = false } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) return false;
    const chatSession = packageData?.chatSession || null;
    if (!chatSession) return false;
    const currentMessages = ensureArray(packageData?.chatCurrent);
    const archivesPayload = normalizeExperiencePackChatArchivePayloads(packageData?.chatArchives);
    const session = this.chatStore?._ensureSession?.(sid);
    if (!session) return false;
    const reactionImport = await customReactionAssets.import(packageData?.reactionAssets, ref => this.getEntryDataUrl(packageData, ref));
    if (reactionImport.failed.length) window.toastr?.warning?.(customReactionImportWarning(reactionImport));
    const restoredState = buildExperiencePackRestoredSessionChatState(chatSession, { includeMemoryData });
    session.draft = restoredState.draft;
    session.detachedSummaries = restoredState.detachedSummaries;
    session.compactedSummary = restoredState.compactedSummary;
    session.compactedSummaryLastRaw = restoredState.compactedSummaryLastRaw;
    session.currentArchiveId = restoredState.currentArchiveId;
    session.archives = restoredState.archives;

    if (!this.chatStore?._useV2) {
      session.messages = currentMessages.slice();
      session.archives = buildExperiencePackLegacyRestoredArchives(session.archives, archivesPayload);
      this.chatStore?._persist?.();
      return true;
    }

    try {
      this.chatStore._clearThreadState?.(this.chatStore._getThreadKey?.(sid, '') || '');
    } catch {}
    try {
      await this.chatStore._v2.replaceThreadMessages(sid, '', currentMessages);
    } catch (err) {
      logger.warn('restore current thread for experience pack failed', err);
    }
    for (const job of buildExperiencePackArchiveMessageRestoreJobs(session.archives, archivesPayload)) {
      try {
        await this.chatStore._v2.replaceThreadMessages(sid, job.archiveId, job.messages);
      } catch (err) {
        logger.warn('restore archive thread for experience pack failed', err);
      }
    }
    session.messages = [];
    session._loadedThreadKey = '';
    this.chatStore?._persist?.();
    try {
      await this.chatStore.ensureRecentMessagesLoaded?.(sid);
    } catch {}
    return true;
  }

  async importPackage(packageData, options = {}) {
    const character = packageData?.character || {};
    const baseName = getExperiencePackImportBaseName(packageData);
    const newSessionId = this.getUniqueSessionId(baseName);
    const avatarFile = String(character?.contact?.avatarFile || '').trim();
    const avatarDataUrl = avatarFile ? this.getEntryDataUrl(packageData, avatarFile) : String(character?.contact?.avatarValue || '').trim();
    this.contactsStore?.upsertContact?.(buildExperiencePackImportedContactRecord({
      packageData,
      sessionId: newSessionId,
      baseName,
      avatar: avatarDataUrl,
      addedAt: Date.now(),
    }));
    this.chatStore?._ensureSession?.(newSessionId);

    let importedPersona = null;
    if (character?.persona) {
      try {
        importedPersona = await this.importPersona(packageData);
      } catch (err) {
        logger.warn('import persona for experience pack failed', err);
      }
    }

    const worldIdMap = await this.importWorldbooks(packageData);
    this.importVariableCore(packageData, newSessionId);
    await this.importRegex(packageData, newSessionId, worldIdMap);

    const mappedWorldIds = mapExperiencePackImportedWorldIds({
      worldIds: packageData?.worldbooks?.worldIds || [],
      worldIdMap,
    });
    if (mappedWorldIds.length) {
      try {
        this.appBridge?.setSessionWorldIds?.(newSessionId, mappedWorldIds, { silent: true });
      } catch (err) {
        logger.warn('bind imported worldbooks to session failed', err);
      }
    }

    let sessionSettings = {};
    if (options.includeRoom) {
      try {
        sessionSettings = await this.importRoomData(packageData, newSessionId) || {};
      } catch (err) {
        logger.warn('import room data failed', err);
      }
      if (options.includeStickers) {
        try {
          await this.importStickerPacks(packageData, newSessionId);
        } catch (err) {
          logger.warn('import sticker packs failed', err);
        }
      }
      if (options.includeMemoryTemplate) {
        try {
          await this.importMemoryTemplate(packageData);
        } catch (err) {
          logger.warn('import memory template failed', err);
        }
      }
    }

    sessionSettings = buildExperiencePackSessionSettings({
      sessionSettings,
      importedPersona,
    });
    this.chatStore?.setSessionSettings?.(newSessionId, sessionSettings);

    if (options.includeVariableState) {
      this.importVariableState(packageData, newSessionId);
    }
    if (options.includeMemoryData && packageData?.memoryData) {
      try {
        const snapshot = cloneJson(packageData.memoryData, {});
        const defaultTemplateId = await this.resolveDefaultMemoryTemplateId();
        if (defaultTemplateId) snapshot.templateId = defaultTemplateId;
        await this.applyMemorySnapshot(newSessionId, snapshot, { isGroup: false });
      } catch (err) {
        logger.warn('import memory snapshot failed', err);
      }
    }
    if (options.includeChatHistory) {
      try {
        await this.restoreChatHistory(newSessionId, packageData, {
          includeMemoryData: options.includeMemoryData === true,
        });
      } catch (err) {
        logger.warn('import chat history failed', err);
      }
    }

    try {
      await this.chatStore?.flush?.();
    } catch {}
    try {
      emitWorldInfoChanged(this.appBridge, { sessionId: newSessionId, roleWorldChanged: true });
    } catch {}

    const shouldSwitch = await appConfirm(buildExperiencePackImportSwitchConfirmOptions({ baseName }));
    if (shouldSwitch) {
      this.chatStore?.switchSession?.(newSessionId);
      this.appBridge?.setActiveSession?.(newSessionId);
      try {
        window.dispatchEvent(new CustomEvent('session-changed', {
          detail: buildExperiencePackSessionChangedDetail(newSessionId),
        }));
      } catch {}
    }
    window.toastr?.success?.('角色体验包导入完成');
    return newSessionId;
  }

  async importFromFile(file) {
    if (!file) return false;
    if (!hasTauriRuntime()) {
      window.toastr?.warning?.('当前环境不支持体验包导入');
      return false;
    }
    const buffer = await readFileAsArrayBuffer(file);
    const bytes = Array.from(new Uint8Array(buffer));
    const entries = await safeInvoke('read_zip_entries', { bytes });
    const packageData = this.parsePackageEntries(entries);
    const options = await this.showImportDialog(packageData, String(file?.name || '').trim());
    if (!options) return false;
    await this.importPackage(packageData, options);
    return true;
  }

  async openImportPicker() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = `.${EXPERIENCE_PACK_EXTENSION},.zip,application/zip`;
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const file = input.files?.[0] || null;
        input.remove();
        if (!file) {
          resolve(false);
          return;
        }
        try {
          const ok = await this.importFromFile(file);
          resolve(ok);
        } catch (err) {
          logger.error('import experience pack failed', err);
          window.toastr?.error?.(`导入失败：${err?.message || '未知错误'}`);
          resolve(false);
        }
      }, { once: true });
      document.body.appendChild(input);
      input.click();
    });
  }
}
