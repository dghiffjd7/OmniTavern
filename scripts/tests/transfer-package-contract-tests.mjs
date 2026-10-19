import assert from 'node:assert/strict';

if (!globalThis.localStorage) {
  const store = new Map();
  globalThis.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

if (!globalThis.sessionStorage) {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

if (!globalThis.CustomEvent) {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  };
}

if (!globalThis.window) globalThis.window = globalThis;
globalThis.window.dispatchEvent = globalThis.window.dispatchEvent || (() => true);
globalThis.window.toastr = globalThis.window.toastr || {
  success() {},
  warning() {},
  error() {},
};
globalThis.setTimeout = () => 0;

if (!globalThis.btoa) {
  globalThis.btoa = value => Buffer.from(String(value), 'binary').toString('base64');
}
if (!globalThis.atob) {
  globalThis.atob = value => Buffer.from(String(value), 'base64').toString('binary');
}

const jsonEntry = (name, value) => ({
  name,
  text: JSON.stringify(value),
});

const base64JsonEntry = (name, value) => ({
  name,
  base64: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
});

const readDataUrlJson = (entry) => {
  const base64 = String(entry?.data_url || '').split(',', 2)[1] || '';
  return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
};

const {
  BUILTIN_PHONE_FORMAT_WORLDBOOK_ID,
} = await import('../../src/scripts/storage/builtin-worldbooks.js');
const { stickerPackStore } = await import('../../src/scripts/storage/sticker-pack-store.js');
const { CharacterCardTransfer } = await import('../../src/scripts/ui/character-card-transfer.js');
const { ExperiencePackTransfer } = await import('../../src/scripts/ui/experience-pack-transfer.js');
const { CustomBundleExporter } = await import('../../src/scripts/ui/custom-bundle-exporter.js');
const { logger } = await import('../../src/scripts/utils/logger.js');

{
  const previousDispatchEvent = globalThis.window.dispatchEvent;
  const dispatched = [];
  const progress = [];
  const traces = [];
  globalThis.window.dispatchEvent = (event) => {
    dispatched.push(event);
    return true;
  };
  try {
    const exporter = new CustomBundleExporter({
      personaStore: { getAll: () => [] },
      appBridge: {
        debugUiRegistry: {
          actions: {
            recordTraceEvent(event) {
              traces.push(event);
              return event;
            },
          },
          stores: {},
        },
      },
      onImportProgress(payload) {
        progress.push(payload);
      },
    });
    const payload = exporter.reportImportProgress({
      phase: 'read-file',
      progress: 4,
      status: '正在读取资料包文件...',
      fileName: 'bundle.zip',
    });
    assert.equal(dispatched[0]?.type, 'custom-bundle-import-progress');
    assert.equal(dispatched[0]?.detail, payload);
    assert.equal(progress[0], payload);
    assert.equal(traces.length, 1);
    assert.deepEqual(
      {
        category: traces[0].category,
        phase: traces[0].phase,
        source: traces[0].source,
        status: traces[0].status,
        summary: traces[0].summary,
        details: traces[0].details,
      },
      {
        category: 'import-export',
        phase: 'custom-bundle.import.read-file',
        source: 'custom-bundle-import',
        status: 'progress',
        summary: '自定义资料包导入：read-file 4%',
        details: {
          progress: 4,
          done: false,
          fileName: 'bundle.zip',
        },
      },
    );
  } finally {
    globalThis.window.dispatchEvent = previousDispatchEvent;
  }
  console.log('ok - CustomBundleExporter.reportImportProgress preserves UI progress events and mirrors metadata to trace timeline');
}

{
  const getMemoryQueries = [];
  const transfer = new CharacterCardTransfer({
    contactsStore: {
      getContact(id) {
        assert.equal(id, 'contact:alice');
        return {
          id,
          name: 'Alice',
          labels: ['好友', 7],
          avatar: 'data:image/webp;base64,AAAA',
          description: '角色说明',
        };
      },
    },
    chatStore: {
      listVariables: () => ({ affection: 5 }),
      listVariableSchemas: () => ({ affection: { type: 'number' } }),
      listVariableRules: () => [{ id: 'rule-1' }],
    },
    memoryTemplateStore: {
      async getTemplates(query) {
        assert.deepEqual(query, { is_default: true });
        return [{ id: 'tpl-default' }];
      },
    },
    memoryTableStore: {
      async getMemories(query) {
        getMemoryQueries.push(query);
        return [
          {
            id: 'row-1',
            table_id: 'profile',
            row_data: { name: 'Alice' },
            is_active: true,
            is_pinned: true,
            priority: '4',
            sort_order: '2',
          },
          {
            id: 'row-skip',
            table_id: '',
            row_data: { skip: true },
          },
        ];
      },
    },
    appBridge: {
      globalWorldId: 'world:global',
      getWorldIdsForSession: () => ['world:main', BUILTIN_PHONE_FORMAT_WORLDBOOK_ID, 'world:main'],
      async getWorldInfo(id) {
        return { id, name: `${id}:name`, entries: [{ key: id }] };
      },
      regex: {
        getSession: () => ({ enabled: true, rules: [{ id: 'session-rule' }] }),
        listLocalSets: () => [
          { id: 'local-main', bind: { type: 'world', worldId: 'world:main' }, rules: [{ id: 'r1' }] },
          { id: 'local-global', bind: { type: 'world', worldId: 'world:global' }, rules: [{ id: 'r2' }] },
          { id: 'local-skip', bind: { type: 'world', worldId: 'world:skip' }, rules: [{ id: 'r3' }] },
        ],
      },
    },
  });

  const { card, avatarFile, avatarDataUrl } = await transfer.buildCardPayload('contact:alice');

  assert.equal(card.format, 'chatapp.card.v1');
  assert.equal(card.contact.name, 'Alice');
  assert.deepEqual(card.contact.labels, ['好友', '7']);
  assert.equal(avatarFile, 'avatar.webp');
  assert.equal(avatarDataUrl, 'data:image/webp;base64,AAAA');
  assert.deepEqual(card.session.worldIds, ['world:main', 'world:global']);
  assert.deepEqual(Object.keys(card.worldbooks), ['world:main', 'world:global']);
  assert.deepEqual(card.variables.values, { affection: 5 });
  assert.deepEqual(card.regex.localSets.map(set => set.id), ['local-main', 'local-global']);
  assert.deepEqual(card.memory, {
    templateId: 'tpl-default',
    rows: [
      {
        id: 'row-1',
        table_id: 'profile',
        row_data: { name: 'Alice' },
        is_active: true,
        is_pinned: true,
        priority: 4,
        sort_order: 2,
      },
    ],
  });
  assert.deepEqual(getMemoryQueries, [{
    scope: 'contact',
    group_id: undefined,
    contact_id: 'contact:alice',
    template_id: 'tpl-default',
  }]);
  console.log('ok - CharacterCardTransfer buildCardPayload preserves export manifest world regex variable and memory contracts');
}

{
  const deleted = [];
  const created = [];
  let batchDeleteTried = false;
  const transfer = new CharacterCardTransfer({
    memoryTemplateStore: {
      async getTemplates(query) {
        assert.deepEqual(query, { is_default: true });
        return [{ id: 'tpl-default' }];
      },
    },
    memoryTableStore: {
      async getMemories(query) {
        assert.equal(query.contact_id, 'contact:alice');
        return [{ id: 'old-1' }, { id: 'old-2' }];
      },
      async batchDeleteMemories(ids) {
        batchDeleteTried = true;
        assert.deepEqual(ids, ['old-1', 'old-2']);
        throw new Error('force fallback');
      },
      async deleteMemory(id) {
        deleted.push(id);
      },
      async batchCreateMemories(inputs) {
        created.push(...inputs);
      },
    },
    appBridge: {},
  });

  const applied = await transfer.applyMemorySnapshot('contact:alice', {
    templateId: '',
    rows: [
      {
        id: 'row-1',
        table_id: 'profile',
        row_data: { name: 'Alice' },
        is_active: false,
        is_pinned: true,
        priority: '9',
        sort_order: '3',
      },
      { id: 'skip', table_id: '' },
    ],
  });

  assert.equal(applied, true);
  assert.equal(batchDeleteTried, true);
  assert.deepEqual(deleted, ['old-1', 'old-2']);
  assert.deepEqual(created, [{
    id: 'row-1',
    template_id: 'tpl-default',
    table_id: 'profile',
    contact_id: 'contact:alice',
    group_id: null,
    row_data: { name: 'Alice' },
    is_active: false,
    is_pinned: true,
    priority: 9,
    sort_order: 3,
  }]);
  console.log('ok - CharacterCardTransfer applyMemorySnapshot preserves delete fallback and create payload contracts');
}

{
  const transfer = new ExperiencePackTransfer({ appBridge: {} });
  const packageData = transfer.parsePackageEntries([
    jsonEntry('manifest.json', {
      format: 'chatapp.experience-pack.v1',
      layers: { chat_history: true },
    }),
    jsonEntry('character.json', { contact: { id: 'contact:alice', name: 'Alice' } }),
    base64JsonEntry('worldbook/worldbooks.json', { worldIds: ['world:main'], worldbooks: { 'world:main': { name: '世界' } } }),
    jsonEntry('chat\\session.json', { exportedRange: 'recent_50' }),
    jsonEntry('chat/current.json', [{ id: 'm1' }]),
    jsonEntry('chat/archives/archive-a.json', { id: 'archive-a', messages: [{ id: 'old' }] }),
    { name: 'assets/avatar.png', base64: 'AAAA' },
  ]);

  assert.equal(packageData.manifest.format, 'chatapp.experience-pack.v1');
  assert.equal(packageData.character.contact.name, 'Alice');
  assert.deepEqual(packageData.worldbooks.worldIds, ['world:main']);
  assert.equal(packageData.chatSession.exportedRange, 'recent_50');
  assert.deepEqual(packageData.chatArchives, [{ id: 'archive-a', messages: [{ id: 'old' }] }]);
  assert.equal(packageData.get?.('missing'), undefined);
  assert.equal(transfer.getEntryDataUrl(packageData, 'assets/avatar.png'), 'data:image/png;base64,AAAA');
  assert.throws(
    () => transfer.parsePackageEntries([jsonEntry('manifest.json', { format: 'invalid' })]),
    /不支持的体验包格式/,
  );
  console.log('ok - ExperiencePackTransfer parsePackageEntries preserves manifest archive base64 and asset contracts');
}

{
  const assetCalls = [];
  const assets = {
    addSource(preferredName, source) {
      assetCalls.push(`${preferredName}:${String(source || '').slice(0, 15)}`);
      return source ? preferredName : '';
    },
  };
  const source = { type: 'manual', nested: { ok: true } };
  const originalCard = { spec: 'card' };
  const transfer = new ExperiencePackTransfer({
    contactsStore: {
      getContact(id) {
        assert.equal(id, 'session:alice');
        return {
          id: 'contact:alice',
          name: 'Alice',
          description: 'desc',
          labels: ['friend', 7],
          avatar: 'data:image/webp;base64,AAAA',
        };
      },
    },
    personaStore: {
      getActive() {
        return {
          id: 'persona:alice',
          name: '',
          description: 'persona desc',
          avatar: 'data:image/png;base64,BBBB',
          userBubbleColor: '#fff',
          userTextColor: '#111',
          position: '2',
          depth: '3',
          role: '4',
          source,
          originalCard,
        };
      },
    },
    appBridge: {},
  });

  const payload = await transfer.collectPersonaBundle('session:alice', assets);

  assert.deepEqual(assetCalls, [
    'assets/contact_avatar.webp:data:image/webp',
    'assets/persona_avatar.png:data:image/png;',
  ]);
  assert.deepEqual(payload.contact, {
    id: 'contact:alice',
    name: 'Alice',
    description: 'desc',
    labels: ['friend', '7'],
    avatarFile: 'assets/contact_avatar.webp',
    avatarValue: '',
  });
  assert.deepEqual(payload.persona, {
    name: 'Alice',
    description: 'persona desc',
    avatarFile: 'assets/persona_avatar.png',
    avatarValue: '',
    userBubbleColor: '#fff',
    userTextColor: '#111',
    position: 2,
    depth: 3,
    role: 4,
    source,
    lockToSession: true,
  });
  assert.notEqual(payload.persona.source, source);
  assert.deepEqual(payload.personaCard, originalCard);
  assert.notEqual(payload.personaCard, originalCard);
  console.log('ok - ExperiencePackTransfer collectPersonaBundle preserves asset registration and persona payload contracts');
}

{
  const previous = globalThis.localStorage.getItem('sticker_packs_v1');
  const assetCalls = [];
  const assets = {
    addSource(preferredName, source) {
      const raw = String(source || '').trim();
      if (!raw) return '';
      assetCalls.push(`${preferredName}:${raw.slice(0, 15)}`);
      return preferredName;
    },
  };

  try {
    globalThis.localStorage.setItem('sticker_packs_v1', JSON.stringify({
      version: 1,
      defaultEnabled: false,
      packs: [
        {
          id: 'pack:bound',
          name: 'My Pack',
          colorIndex: '6',
          iconDataUrl: 'data:image/webp;base64,ICON',
          iconMeta: { zoom: 2 },
          boundSessions: ['session:alice'],
          aiEnabled: true,
          stickers: [{
            id: 'sticker:wave',
            name: 'Wave/One',
            keyword: 'hi',
            dataUrl: 'data:image/gif;base64,STICKER',
            frames: ['data:image/png;base64,F1', ''],
            fps: '12',
          }],
        },
        {
          id: 'pack:skip',
          name: 'Skip Pack',
          boundSessions: ['session:other'],
          stickers: [],
        },
      ],
    }));

    const transfer = new ExperiencePackTransfer({ appBridge: {} });
    const payload = await transfer.collectStickerBundle('session:alice', assets);

    assert.equal(stickerPackStore.getPacks().length, 2);
    assert.deepEqual(assetCalls, [
      'room/stickers/My_Pack/icon.webp:data:image/webp',
      'room/stickers/My_Pack/Wave_One.gif:data:image/gif;',
      'room/stickers/My_Pack/Wave_One_frame_01.png:data:image/png;',
    ]);
    assert.deepEqual(payload, [{
      id: 'pack:bound',
      name: 'My Pack',
      colorIndex: 6,
      aiEnabled: true,
      iconFile: 'room/stickers/My_Pack/icon.webp',
      iconMeta: {
        zoom: 2,
        rotate: 0,
        offsetX: 0,
        offsetY: 0,
        width: 0,
        height: 0,
      },
      stickers: [{
        id: 'sticker:wave',
        name: 'Wave/One',
        keyword: 'hi',
        fps: 12,
        assetFile: 'room/stickers/My_Pack/Wave_One.gif',
        frameFiles: ['room/stickers/My_Pack/Wave_One_frame_01.png'],
      }],
    }]);
    console.log('ok - ExperiencePackTransfer collectStickerBundle preserves bound-pack asset paths and payload contracts');
  } finally {
    if (previous === null) globalThis.localStorage.removeItem('sticker_packs_v1');
    else globalThis.localStorage.setItem('sticker_packs_v1', previous);
  }
}

{
  const presetTypes = ['sysprompt', 'context', 'instruct', 'openai', 'reasoning'];
  const presetState = {
    presets: Object.fromEntries(presetTypes.map(type => [type, {}])),
  };
  presetState.presets.context['context-existing-default'] = { name: 'Default' };
  const upserts = [];
  const bindings = [];
  const sessionBindings = {};
  const presetStore = {
    ready: Promise.resolve(),
    getState: () => presetState,
    upsert: async (type, payload) => {
      const id = `${type}:${payload.name}`;
      upserts.push({ type, payload });
      presetState.presets[type][id] = {
        ...(payload.data || {}),
        name: payload.name,
        app_scope: payload.appScope,
      };
      return id;
    },
    setSessionBinding: async (type, sessionId, presetId) => {
      const scope = presetState.presets[type]?.[presetId]?.app_scope || 'all';
      if (scope !== 'all' && scope !== 'chat') return { sessions: { ...sessionBindings } };
      bindings.push([type, sessionId, presetId]);
      sessionBindings[`${type}:${sessionId}`] = presetId;
      return { sessions: { [sessionId]: presetId } };
    },
    getSessionBindingId: (type, sessionId) => sessionBindings[`${type}:${sessionId}`] || null,
  };
  const exporter = new CustomBundleExporter({
    personaStore: { getAll: () => [] },
    appBridge: {},
    presetStore,
  });
  const roomPackage = {
    roomConfig: {
      presets: {
        presets: {
          context: { name: ' Default ', data: { name: 'Default' } },
          openai: { name: 'Shared Model', data: { name: 'Shared Model', temperature: 0.7 } },
        },
      },
    },
  };
  const presetImportCache = new Map();

  await exporter.importRoomSettingsToScope({
    packageData: {},
    runtime: {},
    roomPackage,
    sessionId: 'room-a',
    displayName: 'Alice',
    presetImportCache,
  });
  await exporter.importRoomSettingsToScope({
    packageData: {},
    runtime: {},
    roomPackage,
    sessionId: 'room-b',
    displayName: 'Bob',
    presetImportCache,
  });

  assert.deepEqual(upserts, [{
    type: 'openai',
    payload: {
      name: 'Shared Model',
      data: { name: 'Shared Model', temperature: 0.7 },
      appScope: 'all',
      makeActive: false,
    },
  }]);
  assert.deepEqual(bindings, [
    ['context', 'room-a', 'context-existing-default'],
    ['openai', 'room-a', 'openai:Shared Model'],
    ['context', 'room-b', 'context-existing-default'],
    ['openai', 'room-b', 'openai:Shared Model'],
  ]);
  console.log('ok - CustomBundleExporter importRoomSettingsToScope dedupes imported preset names and keeps per-session bindings');
}

{
  const presetState = {
    presets: {
      openai: {
        creativeCollision: { name: 'Room Model', app_scope: 'creative' },
      },
    },
  };
  const upserts = [];
  const sessionBindings = {};
  const presetStore = {
    ready: Promise.resolve(),
    getState: () => presetState,
    upsert: async (type, payload) => {
      const id = 'restored-room-model';
      upserts.push({ type, payload });
      presetState.presets[type][id] = {
        ...(payload.data || {}),
        name: payload.name,
        app_scope: payload.appScope,
      };
      return id;
    },
    setSessionBinding: async (type, sessionId, presetId) => {
      const scope = presetState.presets[type]?.[presetId]?.app_scope || 'all';
      if (scope === 'all' || scope === 'chat') sessionBindings[`${type}:${sessionId}`] = presetId;
      return { sessions: { [sessionId]: sessionBindings[`${type}:${sessionId}`] || '' } };
    },
    getSessionBindingId: (type, sessionId) => sessionBindings[`${type}:${sessionId}`] || null,
  };
  const transfer = new ExperiencePackTransfer({ presetStore, appBridge: {} });
  await transfer.importRoomData({
    roomConfig: {},
    roomPresets: {
      presets: {
        openai: { name: 'Room Model', data: { temperature: 0.6 } },
      },
    },
  }, 'experience-room');
  assert.equal(upserts.length, 1, 'creative-only name collision must create a restorable preset');
  assert.equal(upserts[0].payload.appScope, 'all');
  assert.equal(sessionBindings['openai:experience-room'], 'restored-room-model');
  console.log('ok - ExperiencePackTransfer restores room presets with verified chat-session eligibility');
}

{
  const warnings = [];
  const previousWarning = globalThis.window.toastr.warning;
  globalThis.window.toastr.warning = message => warnings.push(message);
  try {
    const presetStore = {
      ready: Promise.resolve(),
      getState: () => ({ presets: { openai: {} } }),
      upsert: async () => 'restored-but-rejected',
      setSessionBinding: async () => ({ sessions: {} }),
      getSessionBindingId: () => null,
    };
    const transfer = new ExperiencePackTransfer({ presetStore, appBridge: {} });
    await transfer.importRoomData({
      roomConfig: {},
      roomPresets: {
        presets: {
          openai: { name: 'Rejected Model', data: { temperature: 0.4 } },
        },
      },
    }, 'experience-rejected');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /1 项会话预设未能还原/u);
    console.log('ok - ExperiencePackTransfer reports a binding no-op instead of claiming a complete restore');
  } finally {
    globalThis.window.toastr.warning = previousWarning;
  }
}

{
  const diagnosticsNotes = [];
  const presetStore = {
    ready: Promise.resolve(),
    getState: () => ({ presets: { openai: {} } }),
    upsert: async () => 'bundle-rejected',
    setSessionBinding: async () => ({ sessions: {} }),
    getSessionBindingId: () => null,
  };
  const exporter = new CustomBundleExporter({
    personaStore: { getAll: () => [] },
    appBridge: {},
    presetStore,
  });
  await exporter.importRoomSettingsToScope({
    packageData: {},
    runtime: {},
    roomPackage: {
      roomConfig: {
        presets: {
          presets: {
            openai: { name: 'Rejected Model', data: { temperature: 0.4 } },
          },
        },
      },
    },
    sessionId: 'bundle-rejected-room',
    displayName: 'Rejected Room',
    diagnosticsNotes,
  });
  assert.equal(diagnosticsNotes.length, 1);
  assert.match(diagnosticsNotes[0], /openai 预设未能还原/u);
  console.log('ok - CustomBundleExporter records rejected preset bindings in import diagnostics');
}

{
  const assetCalls = [];
  const assets = {
    addSource(preferredName, source) {
      const raw = String(source || '').trim();
      assetCalls.push(`${preferredName}:${raw}`);
      if (/^https?:\/\//i.test(raw)) return '';
      return raw ? preferredName : '';
    },
  };
  const transfer = new ExperiencePackTransfer({ appBridge: {} });

  const localPayload = await transfer.collectWallpaperBundle('session:alice', {
    wallpaper: {
      path: '/tmp/wallpaper.png',
      name: 'Wallpaper',
      zoom: '2',
      rotate: '15',
      offsetX: '3',
      offsetY: '4',
      width: '800',
      height: '600',
      opacity: '0.35',
      saveOriginal: true,
    },
  }, assets);
  const remotePayload = await transfer.collectWallpaperBundle('session:alice', {
    wallpaper: {
      url: 'https://example.test/wallpaper.webp',
      name: 'Remote',
    },
  }, assets);

  assert.deepEqual(assetCalls, [
    'room/wallpaper.png:/tmp/wallpaper.png',
    'room/wallpaper.png:https://example.test/wallpaper.webp',
  ]);
  assert.deepEqual(localPayload, {
    file: 'room/wallpaper.png',
    remoteUrl: '',
    meta: {
      name: 'Wallpaper',
      zoom: 2,
      rotate: 15,
      offsetX: 3,
      offsetY: 4,
      width: 800,
      height: 600,
      opacity: 0.35,
      saveOriginal: true,
    },
  });
  assert.deepEqual(remotePayload, {
    file: '',
    remoteUrl: 'https://example.test/wallpaper.webp',
    meta: {
      name: 'Remote',
      zoom: 1,
      rotate: 0,
      offsetX: 0,
      offsetY: 0,
      width: 0,
      height: 0,
      opacity: 1,
    },
  });
  console.log('ok - ExperiencePackTransfer collectWallpaperBundle preserves asset and remote fallback contracts');
}

{
  const calls = [];
  class BuildContractExperiencePackTransfer extends ExperiencePackTransfer {
    async collectPersonaBundle(sessionId, assets) {
      calls.push(`persona:${sessionId}`);
      const avatarFile = assets.addDataUrl('assets/avatar.png', 'data:image/png;base64,AAAA');
      return {
        contact: {
          id: sessionId,
          name: 'Alice/Share',
          avatarFile,
        },
        persona: { name: 'Alice Persona' },
        personaCard: { spec: 'card' },
      };
    }

    async collectWorldbookBundle(sessionId) {
      calls.push(`world:${sessionId}`);
      return {
        worldIds: ['world:main'],
        worldbooks: { 'world:main': { name: 'World Main' } },
      };
    }

    collectVariableCore(sessionId) {
      calls.push(`var-core:${sessionId}`);
      return { schemas: { mood: { type: 'string' } } };
    }

    collectVariableState(sessionId) {
      calls.push(`var-state:${sessionId}`);
      return { values: { mood: 'happy' } };
    }

    collectRegexBundle(sessionId, worldIds) {
      calls.push(`regex:${sessionId}:${worldIds.join('|')}`);
      return { session: { enabled: true }, localSets: [] };
    }

    async collectRoomBundle(sessionId, options) {
      calls.push(`room:${sessionId}:${options.includeStickers === true}:${options.includeMemoryTemplate === true}`);
      return {
        sessionSettings: { theme: 'cozy' },
        wallpaper: { file: 'room/wallpaper.png' },
        presets: { presets: {} },
        connection: { profile: null },
        stickers: [{ id: 'pack-1' }],
        memoryTemplate: { id: 'tpl-1' },
      };
    }

    collectAgentWorkflowBundle(sessionId) {
      calls.push(`agents:${sessionId}`);
      return { format: 'omnitavern.agent-workflow', agents: {} };
    }

    async buildMemorySnapshot(sessionId, options = {}) {
      calls.push(`memory:${sessionId}:${options.isGroup === true}`);
      return { rows: [{ id: 'row-1' }] };
    }

    async collectChatBundle(sessionId, options = {}) {
      calls.push(`chat:${sessionId}:${options.range}:${options.includeMemoryData === true}`);
      return {
        exportedRange: options.range,
        draft: 'draft',
        current: { detachedSummaries: [] },
        currentMessages: [{ id: 'current-1' }],
        archives: [{
          id: 'archive/a',
          name: 'Archive A',
          timestamp: 123,
          messageCount: 1,
          summaries: [],
          compactedSummary: null,
          compactedSummaryLastRaw: null,
          memoryTableSnapshot: { rows: [{ id: 'row-a' }] },
          messages: [{ id: 'old-1' }],
        }],
      };
    }
  }

  const transfer = new BuildContractExperiencePackTransfer({ appBridge: {} });
  const built = await transfer.buildPackage('session:alice', {
    includeRoom: true,
    includeStickers: true,
    includeMemoryTemplate: true,
    hideServiceAddresses: true,
    includeAgents: true,
    includeMemoryData: true,
    includeVariableState: true,
    includeChatHistory: true,
    chatRange: 'recent_50',
  });

  assert.deepEqual(calls, [
    'persona:session:alice',
    'world:session:alice',
    'var-core:session:alice',
    'var-state:session:alice',
    'regex:session:alice:world:main',
    'room:session:alice:true:true',
    'agents:session:alice',
    'memory:session:alice:false',
    'chat:session:alice:recent_50:true',
  ]);
  assert.equal(built.fileName, 'Alice_Share.aicpack');
  assert.deepEqual(built.entries.map(entry => entry.name), [
    'manifest.json',
    'character.json',
    'worldbook/worldbooks.json',
    'variables/core.json',
    'scripts/regex.json',
    'persona/original-card.json',
    'variables/state.json',
    'room/config.json',
    'room/presets.json',
    'room/connection-profile.json',
    'room/stickers.json',
    'memory/template.json',
    'agents/workflow.json',
    'memory/data.json',
    'chat/session.json',
    'chat/current.json',
    'chat/archives/archive_a.json',
    'assets/avatar.png',
  ]);
  assert.deepEqual(built.manifest.layers, {
    core: true,
    room: true,
    stickers: true,
    memory_template: true,
    memory_data: true,
    variable_state: true,
    chat_history: true,
    agents: true,
  });
  assert.equal(built.manifest.options.hideServiceAddresses, true);
  assert.deepEqual(readDataUrlJson(built.entries.find(entry => entry.name === 'chat/session.json')).archives, [{
    id: 'archive/a',
    name: 'Archive A',
    timestamp: 123,
    messageCount: 1,
    summaries: [],
    compactedSummary: null,
    compactedSummaryLastRaw: null,
    memoryTableSnapshot: { rows: [{ id: 'row-a' }] },
  }]);
  assert.deepEqual(readDataUrlJson(built.entries.find(entry => entry.name === 'chat/archives/archive_a.json')), {
    id: 'archive/a',
    messages: [{ id: 'old-1' }],
  });
  console.log('ok - ExperiencePackTransfer buildPackage preserves manifest json entry order archive paths and asset contracts');
}

{
  const calls = [];
  const dispatched = [];
  const previousDocument = globalThis.document;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousDispatchEvent = globalThis.window.dispatchEvent;

  class FakeElement {
    constructor() {
      this.style = {};
      this.dataset = {};
      this.className = '';
      this.textContent = '';
      this.children = [];
      this.classList = {
        toggle() {},
        add() {},
        remove() {},
      };
    }

    set innerHTML(_value) {}

    appendChild(child) {
      this.children.push(child);
      return child;
    }

    addEventListener() {}

    remove() {}

    focus() {}

    querySelector(selector) {
      if (!this._selectors) this._selectors = new Map();
      if (!this._selectors.has(selector)) this._selectors.set(selector, new FakeElement());
      return this._selectors.get(selector);
    }
  }

  globalThis.document = {
    body: {
      appendChild(child) {
        return child;
      },
    },
    createElement() {
      return new FakeElement();
    },
    addEventListener(type, handler) {
      if (type === 'keydown') {
        queueMicrotask(() => handler({
          key: 'Enter',
          preventDefault() {},
        }));
      }
    },
    removeEventListener() {},
  };
  globalThis.requestAnimationFrame = (callback) => {
    callback?.();
    return 1;
  };
  globalThis.window.dispatchEvent = (event) => {
    dispatched.push(event?.type || '');
    return true;
  };
  globalThis.window.toastr = {
    success(message) {
      calls.push(`toast:${message}`);
    },
    warning() {},
    error() {},
  };

  class ContractExperiencePackTransfer extends ExperiencePackTransfer {
    constructor() {
      const sessions = {};
      super({
        contactsStore: {
          upsertContact(record) {
            calls.push(`contact:${record.id}:${record.name}:${record.labels.join('|')}`);
          },
        },
        chatStore: {
          state: { sessions },
          _ensureSession(sessionId) {
            calls.push(`ensure:${sessionId}`);
            if (!sessions[sessionId]) sessions[sessionId] = { id: sessionId };
            return sessions[sessionId];
          },
          setVariableSchema(key, schema, sessionId) {
            calls.push(`schema:${sessionId}:${key}:${schema?.type || ''}`);
          },
          setVariableRules(rules, sessionId) {
            calls.push(`rules:${sessionId}:${Array.isArray(rules) ? rules.length : 0}`);
          },
          setStageSchema(schema, sessionId) {
            calls.push(`stage:${sessionId}:${schema?.id || ''}`);
          },
          setInitialVariable(key, value, sessionId) {
            calls.push(`initial:${sessionId}:${key}:${value}`);
          },
          setVariable(key, value, sessionId) {
            calls.push(`value:${sessionId}:${key}:${value}`);
          },
          setSessionSettings(sessionId, settings) {
            calls.push(`settings:${sessionId}:${settings?.theme || ''}:${settings?.personaLockId || ''}`);
          },
          async flush() {
            calls.push('flush');
          },
          switchSession(sessionId) {
            calls.push(`switch:${sessionId}`);
          },
        },
        personaStore: {},
        appBridge: {
          setSessionWorldIds(sessionId, worldIds, options = {}) {
            calls.push(`worlds:${sessionId}:${worldIds.join('|')}:${options.silent === true}`);
          },
          emitWorldInfoChanged(detail) {
            calls.push(`world-event:${detail?.sessionId || ''}:${detail?.roleWorldChanged === true}`);
          },
          setActiveSession(sessionId) {
            calls.push(`active:${sessionId}`);
          },
        },
      });
    }

    getUniqueSessionId(baseName) {
      calls.push(`unique:${baseName}`);
      return 'Alice Imported';
    }

    async importPersona() {
      calls.push('persona');
      return { id: 'persona:imported', name: 'Alice Persona' };
    }

    async importWorldbooks() {
      calls.push('worldbooks');
      return { 'world:source': 'world:imported' };
    }

    async importRegex(_packageData, sessionId, worldIdMap) {
      calls.push(`regex:${sessionId}:${worldIdMap['world:source']}`);
    }

    async importRoomData(_packageData, sessionId) {
      calls.push(`room:${sessionId}`);
      return { theme: 'cozy' };
    }

    async importStickerPacks(_packageData, sessionId) {
      calls.push(`stickers:${sessionId}`);
      return ['pack:imported'];
    }

    async importMemoryTemplate() {
      calls.push('memory-template');
      return 'tpl:imported';
    }

    async importAgentWorkflow(packageData, sessionId) {
      calls.push(`agents:${sessionId}:${packageData.agentWorkflow.name}`);
    }

    async resolveDefaultMemoryTemplateId() {
      calls.push('default-template');
      return 'tpl:default';
    }

    async applyMemorySnapshot(sessionId, snapshot, options = {}) {
      calls.push(`memory:${sessionId}:${snapshot?.templateId || ''}:${options.isGroup === true}:${snapshot?.rows?.length || 0}`);
      return true;
    }

    async restoreChatHistory(sessionId, _packageData, options = {}) {
      calls.push(`restore:${sessionId}:${options.includeMemoryData === true}`);
      return true;
    }
  }

  const packageData = {
    manifest: {
      format: 'chatapp.experience-pack.v1',
      character: { name: 'Alice Manifest' },
    },
    character: {
      contact: {
        name: 'Alice',
        labels: ['friend', 7],
        description: 'desc',
      },
      persona: {
        name: 'Alice Persona',
      },
    },
    worldbooks: {
      worldIds: ['world:source', 'world:raw'],
      worldbooks: {
        'world:source': { name: 'World Source' },
      },
    },
    variableCore: {
      schemas: { mood: { type: 'string' } },
      rules: [{ id: 'rule-1' }],
      stageSchema: { id: 'stage-main' },
    },
    variableState: {
      initialValues: { mood: 'calm' },
      values: { mood: 'happy' },
    },
    regex: {
      session: { enabled: true },
    },
    roomConfig: {
      sessionSettings: { theme: 'cozy' },
    },
    roomStickers: [{ id: 'pack:source' }],
    memoryTemplate: { id: 'tpl:source' },
    memoryData: { rows: [{ table_id: 'profile' }] },
    agentWorkflow: { name: 'Alice 的 Agent' },
    chatSession: { draft: 'draft' },
    chatCurrent: [{ id: 'm1' }],
    chatArchives: [],
  };

  try {
    const transfer = new ContractExperiencePackTransfer();
    const sessionId = await transfer.importPackage(packageData, {
      includeRoom: true,
      includeStickers: true,
      includeMemoryTemplate: true,
      includeAgents: true,
      includeVariableState: true,
      includeMemoryData: true,
      includeChatHistory: true,
    });

    assert.equal(sessionId, 'Alice Imported');
    assert.deepEqual(calls, [
      'unique:Alice',
      'contact:Alice Imported:Alice:friend|7',
      'ensure:Alice Imported',
      'persona',
      'worldbooks',
      'schema:Alice Imported:mood:string',
      'rules:Alice Imported:1',
      'stage:Alice Imported:stage-main',
      'regex:Alice Imported:world:imported',
      'worlds:Alice Imported:world:imported|world:raw:true',
      'room:Alice Imported',
      'stickers:Alice Imported',
      'memory-template',
      'settings:Alice Imported:cozy:persona:imported',
      'agents:Alice Imported:Alice 的 Agent',
      'initial:Alice Imported:mood:calm',
      'value:Alice Imported:mood:happy',
      'default-template',
      'memory:Alice Imported:tpl:default:false:1',
      'restore:Alice Imported:true',
      'flush',
      'world-event:Alice Imported:true',
      'switch:Alice Imported',
      'active:Alice Imported',
      'toast:角色体验包导入完成',
    ]);
    assert.deepEqual(dispatched, ['session-changed']);
    console.log('ok - ExperiencePackTransfer importPackage orchestration preserves import order settings memory restore and switch contracts');
  } finally {
    globalThis.document = previousDocument;
    globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    globalThis.window.dispatchEvent = previousDispatchEvent;
  }
}

{
  const sessions = {};
  const persistCalls = [];
  const currentMessages = [{ id: 'current-1' }];
  const transfer = new ExperiencePackTransfer({
    chatStore: {
      _useV2: false,
      state: { sessions },
      _ensureSession(sessionId) {
        if (!sessions[sessionId]) sessions[sessionId] = { id: sessionId };
        return sessions[sessionId];
      },
      _persist() {
        persistCalls.push('persist');
      },
    },
    appBridge: {},
  });

  const restored = await transfer.restoreChatHistory('session:alice', {
    chatSession: {
      draft: 'hello',
      current: {
        detachedSummaries: [{ at: '1', text: ' Summary ' }],
        compactedSummary: { at: '2', text: ' Compact ', raw: ' Raw ' },
        compactedSummaryLastRaw: { source: 'current-raw' },
      },
      archives: [{
        id: ' archive-a ',
        name: 'Archive A',
        timestamp: '10',
        messageCount: '2',
        memoryTableSnapshot: { rows: [{ id: 'row-a' }] },
      }],
    },
    chatCurrent: currentMessages,
    chatArchives: [{
      id: 'archive-a',
      messages: [{ id: 'old-1' }],
    }],
  }, {
    includeMemoryData: true,
  });

  const session = sessions['session:alice'];
  assert.equal(restored, true);
  assert.deepEqual(persistCalls, ['persist']);
  assert.equal(session.draft, 'hello');
  assert.deepEqual(session.detachedSummaries, [{ at: 1, text: 'Summary' }]);
  assert.deepEqual(session.compactedSummary, { at: 2, text: 'Compact', raw: 'Raw' });
  assert.deepEqual(session.compactedSummaryLastRaw, { source: 'current-raw' });
  assert.equal(session.currentArchiveId, null);
  assert.deepEqual(session.messages, currentMessages);
  assert.notEqual(session.messages, currentMessages);
  assert.deepEqual(session.archives, [{
    id: 'archive-a',
    name: 'Archive A',
    timestamp: 10,
    messageCount: 2,
    summaries: [],
    compactedSummary: null,
    compactedSummaryLastRaw: null,
    memoryTableSnapshot: { rows: [{ id: 'row-a' }] },
    messages: [{ id: 'old-1' }],
  }]);
  console.log('ok - ExperiencePackTransfer restoreChatHistory preserves legacy metadata messages and memory contracts');
}

{
  const calls = [];
  const sessions = {};
  const transfer = new ExperiencePackTransfer({
    chatStore: {
      _useV2: true,
      state: { sessions },
      _ensureSession(sessionId) {
        if (!sessions[sessionId]) sessions[sessionId] = { id: sessionId };
        return sessions[sessionId];
      },
      _getThreadKey(sessionId, archiveId = '') {
        return `${sessionId}::${archiveId}`;
      },
      _clearThreadState(key) {
        calls.push(`clear:${key}`);
      },
      _v2: {
        async replaceThreadMessages(sessionId, archiveId, messages) {
          calls.push(`replace:${sessionId}:${archiveId || 'current'}:${messages.map(message => message.id).join('|')}`);
        },
      },
      _persist() {
        calls.push('persist');
      },
      async ensureRecentMessagesLoaded(sessionId) {
        calls.push(`load:${sessionId}`);
      },
    },
    appBridge: {},
  });

  const restored = await transfer.restoreChatHistory('session:bob', {
    chatSession: {
      draft: 'draft',
      archives: [
        { id: 'archive-a', name: 'Archive A' },
        { id: 'archive-b', name: 'Archive B', memoryTableSnapshot: { rows: [{ id: 'row-b' }] } },
      ],
    },
    chatCurrent: [{ id: 'current-1' }, { id: 'current-2' }],
    chatArchives: [
      { id: 'archive-a', messages: [{ id: 'old-first' }] },
      { id: 'archive-a', messages: [{ id: 'old-replacement' }] },
    ],
  }, {
    includeMemoryData: false,
  });

  const session = sessions['session:bob'];
  assert.equal(restored, true);
  assert.deepEqual(calls, [
    'clear:session:bob::',
    'replace:session:bob:current:current-1|current-2',
    'replace:session:bob:archive-a:old-replacement',
    'replace:session:bob:archive-b:',
    'persist',
    'load:session:bob',
  ]);
  assert.deepEqual(session.archives.map(archive => archive.id), ['archive-a', 'archive-b']);
  assert.equal(session.archives[1].memoryTableSnapshot, null);
  assert.deepEqual(session.messages, []);
  assert.equal(session._loadedThreadKey, '');
  console.log('ok - ExperiencePackTransfer restoreChatHistory preserves v2 replace flow and archive mapping contracts');
}

{
  const exporter = new CustomBundleExporter({
    personaStore: {},
    appBridge: {},
  });
  const packageData = exporter.parsePackageEntries([
    jsonEntry('manifest.json', {
      format: 'chatapp.custom-bundle.v1',
      roles: [{ id: 'role:alice', rooms: ['room:chat'] }],
    }),
    jsonEntry('roles/role_alice/persona.json', { id: 'role:alice', name: 'Alice' }),
    jsonEntry('roles/role_alice/persona_original_card.json', { spec: 'card' }),
    jsonEntry('roles/role_alice/moments.json', { moments: [{ id: 'moment-1' }] }),
    jsonEntry('rooms/room_chat/manifest.json', { key: 'room:chat', sessionId: 'contact:alice', uiMode: 'chat' }),
    jsonEntry('rooms/room_chat/contact.json', { id: 'contact:alice', name: 'Alice' }),
    jsonEntry('rooms/room_chat/archives/archive-a.json', { id: 'archive-a', messages: [{ id: 'old' }] }),
    jsonEntry('resources/worldbooks.json', { worldIds: ['world:main'], worldbooks: { 'world:main': { name: '世界' } } }),
    { name: 'roles/role_alice/assets/avatar.webp', base64: 'BBBB' },
  ]);

  assert.equal(packageData.manifest.format, 'chatapp.custom-bundle.v1');
  assert.equal(packageData.roles.length, 1);
  assert.equal(packageData.roles[0].persona.name, 'Alice');
  assert.deepEqual(packageData.roles[0].originalCard, { spec: 'card' });
  assert.deepEqual(packageData.roles[0].momentsPayload, { moments: [{ id: 'moment-1' }] });
  assert.equal(packageData.rolesById.get('role:alice').basePath, 'roles/role_alice');
  assert.equal(packageData.roomMap.get('room:chat').contact.name, 'Alice');
  assert.deepEqual(packageData.roomMap.get('room:chat').archives, [{ id: 'archive-a', messages: [{ id: 'old' }] }]);
  assert.deepEqual(packageData.worldbooks.worldIds, ['world:main']);
  assert.equal(exporter.getEntryDataUrl(packageData, 'roles/role_alice/assets/avatar.webp'), 'data:image/webp;base64,BBBB');
  assert.throws(
    () => exporter.parsePackageEntries([jsonEntry('manifest.json', { format: 'invalid' })]),
    /不支持的自定义资料包格式/,
  );
  console.log('ok - CustomBundleExporter parsePackageEntries preserves role room archive resource and asset contracts');
}

{
  const calls = [];
  const progress = [];
  const diagnostics = [];
  const dispatched = [];
  const previousDispatchEvent = globalThis.window.dispatchEvent;
  globalThis.window.dispatchEvent = (event) => {
    dispatched.push(event?.type || '');
    return true;
  };

  const createRuntime = (scopeId) => {
    const contacts = new Map();
    const threadTotals = new Map();
    const sessions = {};
    const chatStore = {
      scopeId,
      state: { sessions },
      _v2: {
        getThreadTotal(sessionId, archiveId = '') {
          return threadTotals.get(`${sessionId}::${archiveId}`) || 0;
        },
      },
      _ensureSession(sessionId) {
        calls.push(`ensure:${sessionId}`);
        if (!sessions[sessionId]) sessions[sessionId] = { id: sessionId, archives: [] };
        return sessions[sessionId];
      },
      setVariableSchema(key, value, sessionId) {
        calls.push(`schema:${sessionId}:${key}:${value?.type || ''}`);
      },
      setVariableRules(rules, sessionId) {
        calls.push(`rules:${sessionId}:${Array.isArray(rules) ? rules.length : 0}`);
      },
      setStageSchema(value, sessionId) {
        calls.push(`stage:${sessionId}:${value?.id || 'none'}`);
      },
      setInitialVariable(key, value, sessionId) {
        calls.push(`initial:${sessionId}:${key}:${value}`);
      },
      setVariable(key, value, sessionId) {
        calls.push(`value:${sessionId}:${key}:${value}`);
      },
    };
    const runtime = {
      scopeId,
      chatStore,
      contactsStore: {
        upsertContact(record) {
          calls.push(`contact:${record.id}:${record.name}:${record.members.join('|')}`);
          contacts.set(record.id, record);
        },
        getContact(id) {
          return contacts.get(id) || null;
        },
      },
      rpSessionStore: {
        setGreetings(greetings, options = {}) {
          calls.push(`rp-greetings:${options.activeId || ''}:${greetings.length}`);
        },
      },
      getMemoryTableStore() {
        return { id: 'memory-store' };
      },
      momentsStore: {
        scopeId,
        list: () => [],
      },
      momentSummaryStore: {
        getSummaries: () => [],
        getCompactedSummary: () => null,
      },
      worldSessionMap: {},
      threadTotals,
    };
    return runtime;
  };

  class ContractCustomBundleExporter extends CustomBundleExporter {
    constructor() {
      super({
        personaStore: {
          getAll: () => [],
        },
        appBridge: {},
        onImportProgress(payload) {
          progress.push(payload);
        },
      });
      this.runtime = createRuntime('role_imported');
    }

    async importWorldbooks() {
      calls.push('worldbooks');
      return { 'world:source': 'world:imported' };
    }

    async importMemoryTemplateRecord(record) {
      calls.push(`memory-template:${record?.id || ''}`);
      return 'tpl:imported';
    }

    async collectExistingSessionIds() {
      calls.push('collect-existing');
      return new Set();
    }

    async importPersonaRecord(rolePackage, worldIdMap) {
      calls.push(`persona:${rolePackage?.persona?.name}:${worldIdMap['world:source']}`);
      return { id: 'role:imported', name: 'Alice Imported' };
    }

    async getScopeRuntime(scopeId = '') {
      calls.push(`runtime:${scopeId}`);
      assert.equal(scopeId, 'role_imported');
      return this.runtime;
    }

    async importMomentsPayload() {
      calls.push('moments');
      return null;
    }

    async importRegexPayload(regexPayload, sessionId, worldIdMap) {
      calls.push(`regex:${sessionId}:${regexPayload?.session?.enabled === true}:${worldIdMap['world:source']}`);
    }

    async setScopedWorldIds(scopeId, sessionId, worldIds) {
      calls.push(`worlds:${scopeId}:${sessionId}:${worldIds.join('|')}`);
      this.runtime.worldSessionMap[sessionId] = worldIds.slice();
    }

    async importRoomSettingsToScope({ sessionId, displayName, personaLockId }) {
      calls.push(`settings:${sessionId}:${displayName}:${personaLockId}`);
      this.runtime.chatStore.state.sessions[sessionId].settings = { personaLockId };
      return { personaLockId };
    }

    async applyMemorySnapshotToStore(memoryTableStore, sessionId, snapshot, options = {}) {
      calls.push(`memory:${memoryTableStore?.id || ''}:${sessionId}:${options.templateId}:${options.isGroup === true}:${snapshot?.rows?.length || 0}`);
      return true;
    }

    async restoreConversationToStore(chatStore, sessionId, roomPackage, options = {}) {
      calls.push(`restore:${sessionId}:${options.includeMemoryData === true}`);
      const session = chatStore.state.sessions[sessionId];
      session.archives = (roomPackage.archives || []).map((archive) => ({
        id: String(archive.id || '').trim(),
        name: String(archive.name || ''),
        messageCount: Array.isArray(archive.messages) ? archive.messages.length : 0,
      }));
      session._loadedThreadKey = '';
      this.runtime.threadTotals.set(`${sessionId}::`, roomPackage.chatCurrent?.messages?.length || 0);
      for (const archive of roomPackage.archives || []) {
        this.runtime.threadTotals.set(`${sessionId}::${archive.id}`, archive.messages?.length || 0);
      }
      return true;
    }

    async flushRuntimeState(runtime) {
      calls.push(`flush:${runtime.scopeId}`);
    }

    publishImportDiagnostics(payload) {
      calls.push('publish');
      diagnostics.push(payload);
      return payload;
    }
  }

  const packageData = {
    manifest: {
      format: 'chatapp.custom-bundle.v1',
      options: {
        includeConversationContent: true,
        includeMemoryData: true,
        includeVariableState: true,
      },
      roles: [{
        id: 'role:source',
        name: 'Alice Source',
        chats: ['room:chat'],
        creativeWriting: 'room:rp',
      }],
    },
    roles: [{
      manifest: {
        id: 'role:source',
        name: 'Alice Source',
        chats: ['room:chat'],
        creativeWriting: 'room:rp',
      },
      persona: {
        id: 'role:source',
        name: 'Alice Source',
      },
    }],
    roomMap: new Map([
      ['room:chat', {
        manifest: { key: 'room:chat', sessionId: 'contact:source', uiMode: 'chat' },
        contact: {
          id: 'contact:source',
          name: 'Alice Chat',
          members: ['contact:source', 'friend:raw'],
        },
        roomConfig: {
          variables: {
            core: {
              schemas: { mood: { type: 'string' } },
              rules: [{ id: 'rule-1' }],
              stageSchema: { id: 'stage-chat' },
            },
            state: {
              initialValues: { mood: 'calm' },
              values: { mood: 'happy' },
            },
          },
          regex: { session: { enabled: true } },
          world: { worldIds: ['world:source'] },
        },
        memoryData: { rows: [{ table_id: 'profile' }] },
        chatCurrent: { messages: [{ id: 'm1' }, { id: 'm2' }] },
        archives: [{ id: 'archive-a', name: 'Archive A', messages: [{ id: 'a1' }] }],
      }],
      ['room:rp', {
        manifest: { key: 'room:rp', sessionId: 'rp:role:source', uiMode: 'rp' },
        contact: { id: 'rp:role:source', name: 'Creative Room' },
        roomConfig: {
          variables: {
            core: {
              schemas: { rpMood: { type: 'number' } },
              rules: [],
              stageSchema: { id: 'stage-rp' },
            },
            state: {
              initialValues: { rpMood: 1 },
              values: { rpMood: 2 },
            },
          },
          regex: { session: { enabled: true } },
          world: { worldIds: ['world:source'] },
        },
        memoryData: { rows: [{ table_id: 'rp-profile' }] },
        chatCurrent: { messages: [{ id: 'rp1' }] },
        archives: [],
        rpGreetings: {
          greetings: [{ id: 'g1', title: ' Greeting ', content: ' Hello ' }],
          activeGreetingId: 'g1',
        },
      }],
    ]),
    worldbooks: { worldbooks: { 'world:source': { name: 'World Source' } } },
    memoryTemplate: { id: 'tpl:source' },
  };

  try {
    const exporter = new ContractCustomBundleExporter();
    const result = await exporter.importPackage(packageData, { fileName: 'bundle.zip' });

    assert.deepEqual(calls, [
      'worldbooks',
      'memory-template:tpl:source',
      'collect-existing',
      'persona:Alice Source:world:imported',
      'runtime:role_imported',
      'moments',
      'contact:Alice Chat:Alice Chat:Alice Chat|friend:raw',
      'ensure:Alice Chat',
      'schema:Alice Chat:mood:string',
      'rules:Alice Chat:1',
      'stage:Alice Chat:stage-chat',
      'regex:Alice Chat:true:world:imported',
      'worlds:role_imported:Alice Chat:world:imported',
      'settings:Alice Chat:Alice Imported:role:imported',
      'initial:Alice Chat:mood:calm',
      'value:Alice Chat:mood:happy',
      'memory:memory-store:Alice Chat:tpl:imported:false:1',
      'restore:Alice Chat:true',
      'runtime:role_imported',
      'ensure:rp:role:imported',
      'schema:rp:role:imported:rpMood:number',
      'rules:rp:role:imported:0',
      'stage:rp:role:imported:stage-rp',
      'regex:rp:role:imported:true:world:imported',
      'worlds:role_imported:rp:role:imported:world:imported',
      'settings:rp:role:imported:Alice Imported·创意写作:role:imported',
      'initial:rp:role:imported:rpMood:1',
      'value:rp:role:imported:rpMood:2',
      'memory:memory-store:rp:role:imported:tpl:imported:false:1',
      'restore:rp:role:imported:true',
      'rp-greetings:g1:1',
      'flush:role_imported',
      'publish',
    ]);

    assert.deepEqual(
      progress.map(item => [item.phase, item.progress, item.status]),
      [
        ['prepare', 18, '正在整理导入资料...'],
        ['worldbooks', 28, '已导入世界书映射 1 项'],
        ['rooms', 58, '正在恢复聊天室 1/2：Alice Chat'],
        ['rooms', 86, '正在恢复创意写作 2/2：Alice Imported'],
        ['flush', 92, '正在写入本地资料...'],
        ['done', 100, '导入完成：2 个会话'],
      ],
    );
    assert.deepEqual(
      dispatched.filter(type => type !== 'custom-bundle-import-progress'),
      ['contacts-updated', 'moment-summaries-updated'],
    );

    assert.deepEqual(result.importedTargets, [
      {
        personaId: 'role:imported',
        personaName: 'Alice Imported',
        scopeId: 'role_imported',
        sessionId: 'Alice Chat',
        roomName: 'Alice Chat',
        isRp: false,
      },
      {
        personaId: 'role:imported',
        personaName: 'Alice Imported',
        scopeId: 'role_imported',
        sessionId: 'rp:role:imported',
        roomName: 'Alice Imported·创意写作',
        isRp: true,
      },
    ]);
    assert.deepEqual(result.firstTarget, result.importedTargets[0]);

    assert.equal(diagnostics.length, 1);
    assert.equal(result.diagnostics, diagnostics[0]);
    assert.equal(result.diagnostics.phase, 'done');
    assert.equal(result.diagnostics.fileName, 'bundle.zip');
    assert.equal(result.diagnostics.worldbookMapSize, 1);
    assert.equal(result.diagnostics.importedMemoryTemplateId, 'tpl:imported');
    assert.equal(result.diagnostics.importedTargetsCount, 2);
    assert.deepEqual(result.diagnostics.scopes, ['role_imported']);
    assert.deepEqual(result.diagnostics.firstTarget, result.firstTarget);
    assert.equal(result.diagnostics.roles[0].personaName, 'Alice Imported');
    assert.equal(result.diagnostics.roles[0].chats[0].sessionId, 'Alice Chat');
    assert.deepEqual(result.diagnostics.roles[0].chats[0].mappedWorldIds, ['world:imported']);
    assert.deepEqual(result.diagnostics.roles[0].chats[0].mappedMembers, ['Alice Chat', 'friend:raw']);
    assert.equal(result.diagnostics.roles[0].chats[0].currentExpectedMessages, 2);
    assert.equal(result.diagnostics.roles[0].chats[0].currentStoredMessages, 2);
    assert.equal(result.diagnostics.roles[0].creativeWriting.sessionId, 'rp:role:imported');
    assert.deepEqual(result.diagnostics.roles[0].creativeWriting.mappedWorldIds, ['world:imported']);
    console.log('ok - CustomBundleExporter importPackage orchestration preserves chat rp progress diagnostics and flush contracts');
  } finally {
    globalThis.window.dispatchEvent = previousDispatchEvent;
  }
}

{
  const calls = [];
  const progress = [];
  const diagnostics = [];
  const createRuntime = (scopeId) => {
    const sessions = {};
    const totals = new Map();
    const contacts = new Map();
    return {
      scopeId,
      chatStore: {
        scopeId,
        state: { sessions },
        _v2: {
          getThreadTotal(sessionId, archiveId = '') {
            return totals.get(`${sessionId}::${archiveId}`) || 0;
          },
        },
        _ensureSession(sessionId) {
          calls.push(`ensure:${sessionId}`);
          if (!sessions[sessionId]) sessions[sessionId] = { id: sessionId, archives: [] };
          return sessions[sessionId];
        },
        setVariableSchema() {},
        setVariableRules() {},
        setStageSchema() {},
        setInitialVariable() {},
        setVariable() {},
      },
      contactsStore: {
        upsertContact(record) {
          calls.push(`contact:${record.id}`);
          contacts.set(record.id, record);
        },
        getContact(id) {
          return contacts.get(id) || null;
        },
      },
      rpSessionStore: {
        setGreetings(greetings, options = {}) {
          calls.push(`rp-greetings:${options.activeId || ''}:${greetings.length}`);
        },
      },
      getMemoryTableStore() {
        return { id: 'memory-store' };
      },
      momentsStore: { scopeId, list: () => [] },
      momentSummaryStore: {
        getSummaries: () => [],
        getCompactedSummary: () => null,
      },
      worldSessionMap: {},
      totals,
    };
  };

  class FailureContractCustomBundleExporter extends CustomBundleExporter {
    constructor() {
      super({
        personaStore: { getAll: () => [] },
        appBridge: {},
        onImportProgress(payload) {
          progress.push(payload);
        },
      });
      this.runtime = createRuntime('role_imported');
    }

    async importWorldbooks() {
      calls.push('worldbooks');
      return { 'world:source': 'world:imported' };
    }

    async importMemoryTemplateRecord() {
      calls.push('memory-template');
      return 'tpl:imported';
    }

    async collectExistingSessionIds() {
      calls.push('collect-existing');
      return new Set();
    }

    async importPersonaRecord() {
      calls.push('persona');
      return { id: 'role:imported', name: 'Alice Imported' };
    }

    async getScopeRuntime(scopeId = '') {
      calls.push(`runtime:${scopeId}`);
      return this.runtime;
    }

    async importMomentsPayload() {
      calls.push('moments');
      return null;
    }

    async importRegexPayload(_regexPayload, sessionId) {
      calls.push(`regex:${sessionId}`);
    }

    async setScopedWorldIds(scopeId, sessionId, worldIds) {
      calls.push(`worlds:${scopeId}:${sessionId}:${worldIds.join('|')}`);
    }

    async importRoomSettingsToScope({ sessionId }) {
      calls.push(`settings:${sessionId}`);
      return {};
    }

    async applyMemorySnapshotToStore(_memoryTableStore, sessionId) {
      calls.push(`memory:${sessionId}`);
      if (sessionId === 'Alice Chat') throw new Error('memory boom');
      return true;
    }

    async restoreConversationToStore(chatStore, sessionId, roomPackage) {
      calls.push(`restore:${sessionId}`);
      if (sessionId === 'Alice Chat') throw new Error('restore boom');
      const session = chatStore.state.sessions[sessionId];
      session.archives = [];
      this.runtime.totals.set(`${sessionId}::`, roomPackage.chatCurrent?.messages?.length || 0);
      return true;
    }

    async flushRuntimeState(runtime) {
      calls.push(`flush:${runtime.scopeId}`);
    }

    publishImportDiagnostics(payload) {
      calls.push('publish');
      diagnostics.push(payload);
      return payload;
    }
  }

  const packageData = {
    manifest: {
      format: 'chatapp.custom-bundle.v1',
      options: { includeMemoryData: true },
      roles: [{
        id: 'role:source',
        name: 'Alice Source',
        chats: ['room:chat'],
        creativeWriting: 'room:rp',
      }],
    },
    roles: [{
      manifest: {
        id: 'role:source',
        name: 'Alice Source',
        chats: ['room:chat'],
        creativeWriting: 'room:rp',
      },
      persona: { id: 'role:source', name: 'Alice Source' },
    }],
    roomMap: new Map([
      ['room:chat', {
        manifest: { key: 'room:chat', sessionId: 'contact:source', uiMode: 'chat' },
        contact: { id: 'contact:source', name: 'Alice Chat' },
        roomConfig: {
          regex: { session: { enabled: true } },
          world: { worldIds: ['world:source'] },
        },
        memoryData: { rows: [{ table_id: 'profile' }] },
        chatCurrent: { messages: [{ id: 'm1' }] },
        archives: [],
      }],
      ['room:rp', {
        manifest: { key: 'room:rp', sessionId: 'rp:role:source', uiMode: 'rp' },
        contact: { id: 'rp:role:source', name: 'Creative Room' },
        roomConfig: {
          regex: { session: { enabled: true } },
          world: { worldIds: ['world:source'] },
        },
        memoryData: { rows: [{ table_id: 'rp-profile' }] },
        chatCurrent: { messages: [{ id: 'rp1' }] },
        archives: [],
        rpGreetings: {
          greetings: [{ id: 'g1', title: 'Hello', content: 'Hi' }],
          activeGreetingId: 'g1',
        },
      }],
    ]),
    worldbooks: { worldbooks: { 'world:source': { name: 'World Source' } } },
    memoryTemplate: { id: 'tpl:source' },
  };

  const previousWarn = logger.warn;
  logger.warn = () => {};
  try {
    const exporter = new FailureContractCustomBundleExporter();
    const result = await exporter.importPackage(packageData, { fileName: 'bundle.zip' });

    assert.deepEqual(calls, [
      'worldbooks',
      'memory-template',
      'collect-existing',
      'persona',
      'runtime:role_imported',
      'moments',
      'contact:Alice Chat',
      'ensure:Alice Chat',
      'regex:Alice Chat',
      'worlds:role_imported:Alice Chat:world:imported',
      'settings:Alice Chat',
      'memory:Alice Chat',
      'restore:Alice Chat',
      'runtime:role_imported',
      'ensure:rp:role:imported',
      'regex:rp:role:imported',
      'worlds:role_imported:rp:role:imported:world:imported',
      'settings:rp:role:imported',
      'memory:rp:role:imported',
      'restore:rp:role:imported',
      'rp-greetings:g1:1',
      'flush:role_imported',
      'publish',
    ]);
    assert.deepEqual(result.diagnostics.notes, [
      'chat restore failed: Alice Chat -> restore boom',
    ]);
    assert.equal(result.diagnostics.phase, 'done');
    assert.equal(result.diagnostics.importedTargetsCount, 2);
    assert.equal(result.diagnostics.roles[0].chats[0].sessionId, 'Alice Chat');
    assert.equal(result.diagnostics.roles[0].chats[0].currentStoredMessages, 0);
    assert.equal(result.diagnostics.roles[0].creativeWriting.sessionId, 'rp:role:imported');
    assert.equal(result.diagnostics.roles[0].creativeWriting.currentStoredMessages, 1);
    assert.deepEqual(
      progress.map(item => item.phase),
      ['prepare', 'worldbooks', 'rooms', 'rooms', 'flush', 'done'],
    );
    console.log('ok - CustomBundleExporter importPackage continues after room memory and restore failures');
  } finally {
    logger.warn = previousWarn;
  }
}

{
  const settingsKey = 'app_settings_v1';
  const previousSettings = globalThis.localStorage.getItem(settingsKey);
  const calls = [];
  const progress = [];
  const diagnostics = [];
  const createRuntime = () => {
    const sessions = {};
    const totals = new Map();
    const contacts = new Map();
    return {
      scopeId: '',
      chatStore: {
        scopeId: '',
        state: { sessions },
        _v2: {
          getThreadTotal(sessionId, archiveId = '') {
            return totals.get(`${sessionId}::${archiveId}`) || 0;
          },
        },
        _ensureSession(sessionId) {
          calls.push(`ensure:${sessionId}`);
          if (!sessions[sessionId]) sessions[sessionId] = { id: sessionId, archives: [] };
          return sessions[sessionId];
        },
      },
      contactsStore: {
        upsertContact(record) {
          calls.push(`contact:${record.id}:${record.name}`);
          contacts.set(record.id, record);
        },
        getContact(id) {
          return contacts.get(id) || null;
        },
      },
      rpSessionStore: {},
      getMemoryTableStore() {
        return { id: 'memory-store' };
      },
      momentsStore: { scopeId: '', list: () => [] },
      momentSummaryStore: {
        getSummaries: () => [],
        getCompactedSummary: () => null,
      },
      worldSessionMap: {},
      totals,
    };
  };

  class SharedModeContractCustomBundleExporter extends CustomBundleExporter {
    constructor() {
      super({
        personaStore: { getAll: () => [] },
        appBridge: {},
        onImportProgress(payload) {
          progress.push(payload);
        },
      });
      this.runtime = createRuntime();
    }

    async importWorldbooks() {
      calls.push('worldbooks');
      return {};
    }

    async importMemoryTemplateRecord() {
      calls.push('memory-template');
      return '';
    }

    async collectExistingSessionIds() {
      calls.push('collect-existing');
      return new Set();
    }

    async importPersonaRecord(rolePackage) {
      const sourceName = String(rolePackage?.persona?.name || '');
      calls.push(`persona:${sourceName}`);
      const key = sourceName.toLowerCase().replace(/\s+/g, '-');
      return { id: `role:${key}`, name: `${sourceName.split(' ')[0]} Imported` };
    }

    async getScopeRuntime(scopeId = '') {
      calls.push(`runtime:${scopeId}`);
      assert.equal(scopeId, '');
      return this.runtime;
    }

    async importMomentsPayload({ rolePackage }) {
      calls.push(`moments:${rolePackage?.persona?.name || ''}`);
      return null;
    }

    async importRegexPayload(_regexPayload, sessionId) {
      calls.push(`regex:${sessionId}`);
    }

    async importRoomSettingsToScope({ sessionId, displayName, personaLockId }) {
      calls.push(`settings:${sessionId}:${displayName}:${personaLockId}`);
      return {};
    }

    async restoreConversationToStore(chatStore, sessionId, roomPackage) {
      calls.push(`restore:${sessionId}`);
      const session = chatStore.state.sessions[sessionId];
      session.archives = [];
      session._loadedThreadKey = '';
      this.runtime.totals.set(`${sessionId}::`, roomPackage.chatCurrent?.messages?.length || 0);
      return true;
    }

    async flushRuntimeState(runtime) {
      calls.push(`flush:${runtime.scopeId || '__shared_runtime__'}`);
    }

    publishImportDiagnostics(payload) {
      calls.push('publish');
      diagnostics.push(payload);
      return payload;
    }
  }

  const sharedRoom = {
    manifest: { key: 'room:shared', sessionId: 'contact:shared', uiMode: 'chat' },
    contact: {
      id: 'contact:shared',
      name: 'Shared Chat',
    },
    roomConfig: {
      regex: { session: { enabled: true } },
      world: { worldIds: [] },
    },
    chatCurrent: { messages: [{ id: 'm1' }, { id: 'm2' }] },
    archives: [],
  };
  const packageData = {
    manifest: {
      format: 'chatapp.custom-bundle.v1',
      options: { includeConversationContent: true },
      roles: [
        { id: 'role:alice-source', name: 'Alice Source', chats: ['room:shared'] },
        { id: 'role:bob-source', name: 'Bob Source', chats: ['room:shared'] },
      ],
    },
    roles: [
      {
        manifest: { id: 'role:alice-source', name: 'Alice Source', chats: ['room:shared'] },
        persona: { id: 'role:alice-source', name: 'Alice Source' },
      },
      {
        manifest: { id: 'role:bob-source', name: 'Bob Source', chats: ['room:shared'] },
        persona: { id: 'role:bob-source', name: 'Bob Source' },
      },
    ],
    roomMap: new Map([
      ['room:shared', sharedRoom],
    ]),
    worldbooks: { worldbooks: {} },
  };

  globalThis.localStorage.setItem(settingsKey, JSON.stringify({ personaBindContacts: false }));
  try {
    const exporter = new SharedModeContractCustomBundleExporter();
    const result = await exporter.importPackage(packageData, { fileName: 'shared.zip' });

    assert.deepEqual(calls, [
      'worldbooks',
      'memory-template',
      'collect-existing',
      'persona:Alice Source',
      'runtime:',
      'moments:Alice Source',
      'contact:Shared Chat:Shared Chat',
      'ensure:Shared Chat',
      'regex:Shared Chat',
      'settings:Shared Chat:Alice Imported:',
      'restore:Shared Chat',
      'persona:Bob Source',
      'runtime:',
      'moments:Bob Source',
      'flush:__shared_runtime__',
      'publish',
    ]);
    assert.deepEqual(
      progress.map(item => [item.phase, item.progress, item.status]),
      [
        ['prepare', 18, '正在整理导入资料...'],
        ['worldbooks', 28, '已导入世界书映射 0 项'],
        ['rooms', 86, '正在恢复聊天室 1/1：Shared Chat'],
        ['flush', 92, '正在写入本地资料...'],
        ['done', 100, '导入完成：1 个会话'],
      ],
    );
    assert.equal(result.diagnostics.sharedMode, true);
    assert.equal(result.diagnostics.importedTargetsCount, 1);
    assert.deepEqual(result.diagnostics.scopes, ['__shared__']);
    assert.deepEqual(result.importedTargets, [
      {
        personaId: 'role:alice-source',
        personaName: 'Alice Imported',
        scopeId: '',
        sessionId: 'Shared Chat',
        roomName: 'Shared Chat',
        isRp: false,
      },
    ]);
    assert.equal(result.diagnostics.roles.length, 2);
    assert.equal(result.diagnostics.roles[0].chats.length, 1);
    assert.equal(result.diagnostics.roles[1].chats.length, 0);
    assert.equal(result.diagnostics.roles[0].chats[0].currentStoredMessages, 2);
    console.log('ok - CustomBundleExporter importPackage shared mode reuses duplicate chat rooms once');
  } finally {
    if (previousSettings == null) {
      globalThis.localStorage.removeItem(settingsKey);
    } else {
      globalThis.localStorage.setItem(settingsKey, previousSettings);
    }
  }
}
