const STORAGE_KEY = 'sticker_packs_v1';

const DEFAULT_STATE = {
  version: 1,
  defaultEnabled: false,
  packs: [],
};

const normalizeImageMeta = (meta) => {
  const raw = meta && typeof meta === 'object' ? meta : {};
  const zoom = Number(raw.zoom);
  const rotate = Number(raw.rotate);
  const offsetX = Number(raw.offsetX);
  const offsetY = Number(raw.offsetY);
  const width = Number(raw.width);
  const height = Number(raw.height);
  return {
    zoom: Number.isFinite(zoom) ? zoom : 1,
    rotate: Number.isFinite(rotate) ? rotate : 0,
    offsetX: Number.isFinite(offsetX) ? offsetX : 0,
    offsetY: Number.isFinite(offsetY) ? offsetY : 0,
    width: Number.isFinite(width) ? width : 0,
    height: Number.isFinite(height) ? height : 0,
  };
};

const safeParse = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const normalizeSticker = (sticker) => {
  const raw = sticker && typeof sticker === 'object' ? sticker : {};
  const frames = Array.isArray(raw.frames)
    ? raw.frames.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const fps = Number(raw.fps);
  return {
    id: String(raw.id || '').trim(),
    name: String(raw.name || '').trim(),
    keyword: String(raw.keyword || '').trim(),
    path: String(raw.path || '').trim(),
    dataUrl: String(raw.dataUrl || '').trim(),
    frames,
    fps: Number.isFinite(fps) ? fps : 0,
  };
};

const normalizePack = (pack) => {
  const raw = pack && typeof pack === 'object' ? pack : {};
  const stickers = Array.isArray(raw.stickers) ? raw.stickers.map(normalizeSticker) : [];
  const boundSessions = Array.isArray(raw.boundSessions)
    ? raw.boundSessions.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  return {
    id: String(raw.id || '').trim(),
    name: String(raw.name || '').trim(),
    colorIndex: Number.isFinite(Number(raw.colorIndex)) ? Number(raw.colorIndex) : 0,
    ...(raw.kind === 'reaction' ? { kind: 'reaction' } : {}),
    iconPath: String(raw.iconPath || '').trim(),
    iconDataUrl: String(raw.iconDataUrl || '').trim(),
    iconMeta: normalizeImageMeta(raw.iconMeta),
    boundSessions,
    aiEnabled: Boolean(raw.aiEnabled),
    stickers,
  };
};

const normalizeState = (state) => {
  const raw = state && typeof state === 'object' ? state : {};
  const packs = Array.isArray(raw.packs) ? raw.packs.map(normalizePack).filter(p => p.id) : [];
  return {
    ...DEFAULT_STATE,
    defaultEnabled: typeof raw.defaultEnabled === 'boolean' ? raw.defaultEnabled : DEFAULT_STATE.defaultEnabled,
    packs,
  };
};

// localStorage 配额满时 setItem 静默失败：kv 为权威通道，内存态在会话内为准。
let memoryState = null;
let kvChannel = null;

const readLocalState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return normalizeState(safeParse(raw));
  } catch {
    return { ...DEFAULT_STATE };
  }
};

const readState = () => {
  if (memoryState) return memoryState;
  return readLocalState();
};

const writeState = (state) => {
  const stamped = { ...state, __updatedAt: Date.now() };
  memoryState = stamped;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped));
  } catch {}
  if (kvChannel?.save) {
    Promise.resolve(kvChannel.save(STORAGE_KEY, stamped)).catch(() => {});
  }
};

export const stickerPackStore = {
  async hydrate({ loadKv = null, saveKv = null } = {}) {
    kvChannel = { load: loadKv, save: saveKv };
    if (typeof loadKv !== 'function') return readState();
    try {
      const kvRaw = await loadKv(STORAGE_KEY);
      if (kvRaw && typeof kvRaw === 'object' && !kvRaw._tooLarge) {
        const localRaw = readLocalState();
        memoryState = Number(kvRaw.__updatedAt || 0) >= Number(localRaw.__updatedAt || 0)
          ? normalizeState(kvRaw)
          : localRaw;
      }
    } catch {}
    return readState();
  },
  getState() {
    return readState();
  },
  getStickerState(state = readState()) {
    return { ...state, packs: (state.packs || []).filter(pack => pack.kind !== 'reaction') };
  },
  update(mutator) {
    const current = readState();
    const next = normalizeState(typeof mutator === 'function' ? mutator({ ...current }) : current);
    writeState(next);
    return next;
  },
  getPacks() {
    return readState().packs.filter(pack => pack.kind !== 'reaction');
  },
  getReactionPacks() {
    return readState().packs.filter(pack => pack.kind === 'reaction');
  },
  getPack(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return readState().packs.find(p => p.id === key) || null;
  },
  upsertPack(pack) {
    const incoming = normalizePack(pack);
    if (!incoming.id) return readState();
    return this.update((state) => {
      const packs = state.packs.slice();
      const idx = packs.findIndex(p => p.id === incoming.id);
      if (idx >= 0) packs[idx] = { ...packs[idx], ...incoming };
      else packs.push(incoming);
      return { ...state, packs };
    });
  },
  updatePack(id, patch) {
    const key = String(id || '').trim();
    if (!key) return readState();
    return this.update((state) => {
      const packs = state.packs.map(pack => {
        if (pack.id !== key) return pack;
        const next = { ...pack, ...(patch || {}) };
        return normalizePack(next);
      });
      return { ...state, packs };
    });
  },
  removePack(id) {
    const key = String(id || '').trim();
    if (!key) return readState();
    return this.update((state) => ({ ...state, packs: state.packs.filter(p => p.id !== key) }));
  },
  setDefaultEnabled(enabled) {
    return this.update(state => ({ ...state, defaultEnabled: Boolean(enabled) }));
  },
  getDefaultEnabled() {
    return readState().defaultEnabled;
  },
  getEnabledCustomKeywords() {
    const state = readState();
    const keywords = [];
    state.packs.forEach((pack) => {
      if (!pack.aiEnabled || pack.kind === 'reaction') return;
      pack.stickers.forEach((sticker) => {
        const key = String(sticker.keyword || '').trim();
        if (key) keywords.push(key);
      });
    });
    return keywords;
  },
};
