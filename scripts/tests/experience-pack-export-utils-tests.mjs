import assert from 'node:assert/strict';

const {
  buildExperiencePackChatSessionPayload,
  buildExperiencePackContactPayload,
  buildExperiencePackJsonEntryPayloads,
  buildExperiencePackManifest,
  buildExperiencePackPersonaBundlePayload,
  buildExperiencePackPersonaPayload,
  buildExperiencePackStickerItemPayload,
  buildExperiencePackStickerPackPayload,
  buildExperiencePackWallpaperFilePayload,
  buildExperiencePackWallpaperRemotePayload,
} = await import('../../src/scripts/ui/experience-pack-export-utils.js');

{
  assert.deepEqual(
    buildExperiencePackContactPayload({
      contact: {
        id: 'contact:alice',
        name: 'Alice',
        description: 'desc',
        labels: ['friend', 7],
      },
      sessionId: 'session:alice',
      avatarFile: 'assets/contact_avatar.png',
      avatarRaw: 'data:image/png;base64,AAAA',
    }),
    {
      id: 'contact:alice',
      name: 'Alice',
      description: 'desc',
      labels: ['friend', '7'],
      avatarFile: 'assets/contact_avatar.png',
      avatarValue: '',
    },
  );
  assert.equal(
    buildExperiencePackContactPayload({
      contact: { avatar: 'ignored' },
      sessionId: 'session:fallback',
      avatarRaw: 'https://example.test/avatar.png',
    }).avatarValue,
    'https://example.test/avatar.png',
  );
  console.log('ok - buildExperiencePackContactPayload preserves contact export avatar fallback contract');
}

{
  const source = { type: 'manual', nested: { ok: true } };
  const payload = buildExperiencePackPersonaPayload({
    persona: {
      name: '   ',
      description: 'persona desc',
      avatar: 'ignored',
      userBubbleColor: '#fff',
      userTextColor: '#111',
      position: '2',
      depth: '3',
      role: '4',
      source,
    },
    contact: { name: ' Contact Fallback ' },
    sessionId: 'session:alice',
    avatarFile: '',
    avatarRaw: 'data:image/webp;base64,BBBB',
  });

  assert.deepEqual(payload, {
    name: ' Contact Fallback ',
    description: 'persona desc',
    avatarFile: '',
    avatarValue: 'data:image/webp;base64,BBBB',
    userBubbleColor: '#fff',
    userTextColor: '#111',
    position: 2,
    depth: 3,
    role: 4,
    source,
    lockToSession: true,
  });
  assert.notEqual(payload.source, source);
  assert.equal(buildExperiencePackPersonaPayload({ persona: null }), null);
  console.log('ok - buildExperiencePackPersonaPayload preserves persona export fallback numeric and source clone policy');
}

{
  assert.deepEqual(
    buildExperiencePackPersonaBundlePayload({
      contact: { id: 'contact:alice', name: 'Alice' },
      sessionId: 'session:alice',
      contactAvatarFile: 'assets/contact_avatar.png',
      contactAvatarRaw: 'data:image/png;base64,AAAA',
      persona: null,
      personaCard: { spec: 'card' },
    }),
    {
      contact: {
        id: 'contact:alice',
        name: 'Alice',
        description: '',
        labels: [],
        avatarFile: 'assets/contact_avatar.png',
        avatarValue: '',
      },
      persona: null,
      personaCard: null,
    },
  );
  console.log('ok - buildExperiencePackPersonaBundlePayload omits persona card when no persona exists');
}

{
  assert.deepEqual(
    buildExperiencePackStickerItemPayload({
      sticker: {
        id: 'sticker-1',
        name: 'Wave',
        keyword: 'hi',
        fps: '12',
      },
      assetFile: 'room/stickers/pack/wave.png',
      frameFiles: ['frame-1.png', 'frame-2.png'],
    }),
    {
      id: 'sticker-1',
      name: 'Wave',
      keyword: 'hi',
      fps: 12,
      assetFile: 'room/stickers/pack/wave.png',
      frameFiles: ['frame-1.png', 'frame-2.png'],
    },
  );
  assert.equal(buildExperiencePackStickerItemPayload({ sticker: { fps: 'bad' } }).fps, 0);
  console.log('ok - buildExperiencePackStickerItemPayload preserves sticker payload and fps fallback');
}

{
  const iconMeta = { crop: { x: 1 } };
  const payload = buildExperiencePackStickerPackPayload({
    pack: {
      id: 'pack-1',
      name: 'Pack',
      colorIndex: '5',
      aiEnabled: true,
      iconMeta,
    },
    iconFile: 'room/stickers/pack/icon.png',
    stickers: [{ id: 'sticker-1' }],
  });
  assert.deepEqual(payload, {
    id: 'pack-1',
    name: 'Pack',
    colorIndex: 5,
    aiEnabled: true,
    iconFile: 'room/stickers/pack/icon.png',
    iconMeta,
    stickers: [{ id: 'sticker-1' }],
  });
  assert.notEqual(payload.iconMeta, iconMeta);
  console.log('ok - buildExperiencePackStickerPackPayload preserves pack payload and icon meta clone policy');
}

{
  assert.deepEqual(
    buildExperiencePackWallpaperFilePayload({
      file: 'room/wallpaper.png',
      wallpaper: {
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
    }),
    {
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
    },
  );
  assert.deepEqual(
    buildExperiencePackWallpaperRemotePayload({
      remoteUrl: 'https://example.test/wallpaper.png',
      wallpaper: {
        name: 'Remote',
        zoom: 'bad',
        rotate: '',
      },
    }),
    {
      file: '',
      remoteUrl: 'https://example.test/wallpaper.png',
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
    },
  );
  console.log('ok - experience pack wallpaper export helpers preserve local and remote payload contracts');
}

{
  const manifest = buildExperiencePackManifest({
    sessionId: 'session:alice',
    character: { contact: { name: 'Alice' } },
    room: {
      stickers: [{ id: 'pack-1' }],
      memoryTemplate: { id: 'tpl-1' },
    },
    memoryData: { rows: [] },
    variableState: { values: {} },
    chat: { currentMessages: [] },
    agentWorkflow: { format: 'omnitavern.agent-workflow' },
    options: { hideServiceAddresses: true },
    exportedAt: '2026-05-08T13:50:00.000Z',
  });

  assert.deepEqual(manifest, {
    format: 'chatapp.experience-pack.v1',
    formatVersion: 1,
    exportedAt: '2026-05-08T13:50:00.000Z',
    exportedBy: 'OmniTavern',
    character: {
      id: 'session:alice',
      name: 'Alice',
    },
    layers: {
      core: true,
      room: true,
      stickers: true,
      memory_template: true,
      memory_data: true,
      variable_state: true,
      chat_history: true,
      agents: true,
    },
    options: {
      hideServiceAddresses: true,
    },
  });
  console.log('ok - buildExperiencePackManifest preserves layer flags character and options contract');
}

{
  assert.deepEqual(
    buildExperiencePackManifest({
      sessionId: 'session:fallback',
      character: { contact: { name: '' } },
      options: { hideServiceAddresses: false },
      exportedAt: 'now',
    }),
    {
      format: 'chatapp.experience-pack.v1',
      formatVersion: 1,
      exportedAt: 'now',
      exportedBy: 'OmniTavern',
      character: {
        id: 'session:fallback',
        name: 'session:fallback',
      },
      layers: {
        core: true,
        room: false,
        stickers: false,
        memory_template: false,
        memory_data: false,
        variable_state: false,
        chat_history: false,
        agents: false,
      },
      options: {
        hideServiceAddresses: false,
      },
    },
  );
  console.log('ok - buildExperiencePackManifest preserves fallback name and empty layer policy');
}

{
  const payload = buildExperiencePackChatSessionPayload({
    exportedRange: 'all',
    draft: 'draft text',
    current: { detachedSummaries: [{ text: 'current' }] },
    archives: [{
      id: 'archive-a',
      name: 'Archive A',
      timestamp: 123,
      messageCount: 2,
      summaries: [{ text: 'summary' }],
      compactedSummary: { text: 'compact' },
      compactedSummaryLastRaw: { raw: true },
      memoryTableSnapshot: { rows: [{ id: 'row-1' }] },
      messages: [{ id: 'must-not-be-in-session' }],
    }],
  });

  assert.deepEqual(payload, {
    exportedRange: 'all',
    draft: 'draft text',
    current: { detachedSummaries: [{ text: 'current' }] },
    archives: [{
      id: 'archive-a',
      name: 'Archive A',
      timestamp: 123,
      messageCount: 2,
      summaries: [{ text: 'summary' }],
      compactedSummary: { text: 'compact' },
      compactedSummaryLastRaw: { raw: true },
      memoryTableSnapshot: { rows: [{ id: 'row-1' }] },
    }],
  });
  console.log('ok - buildExperiencePackChatSessionPayload preserves archive metadata without messages');
}

{
  const entries = buildExperiencePackJsonEntryPayloads({
    manifest: { format: 'chatapp.experience-pack.v1' },
    character: {
      contact: { name: 'Alice' },
      personaCard: { spec: 'card' },
    },
    world: { worldIds: ['world-a'] },
    variableCore: { schemas: {} },
    regex: { session: null },
    variableState: { values: { mood: 'happy' } },
    room: {
      sessionSettings: { theme: 'cozy' },
      wallpaper: { file: 'room/wallpaper.png' },
      presets: { presets: {} },
      connection: { profile: null },
      stickers: [{ id: 'pack-1' }],
      memoryTemplate: { id: 'tpl-1' },
    },
    memoryData: { rows: [{ id: 'row-1' }] },
    chat: {
      exportedRange: 'recent_50',
      draft: 'draft',
      current: { detachedSummaries: [] },
      currentMessages: [{ id: 'm1' }],
      archives: [{
        id: 'archive/a',
        name: 'Archive A',
        messages: [{ id: 'old-1' }],
      }],
    },
    agentWorkflow: { format: 'omnitavern.agent-workflow' },
    archiveEntryNameForId: archiveId => `chat/archives/${String(archiveId).replace('/', '_')}.json`,
  });

  assert.deepEqual(entries.map(entry => entry.name), [
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
  ]);
  assert.deepEqual(entries.find(entry => entry.name === 'room/config.json').value, {
    sessionSettings: { theme: 'cozy' },
    wallpaper: { file: 'room/wallpaper.png' },
  });
  assert.deepEqual(entries.find(entry => entry.name === 'chat/session.json').value.archives, [{
    id: 'archive/a',
    name: 'Archive A',
    timestamp: undefined,
    messageCount: undefined,
    summaries: undefined,
    compactedSummary: undefined,
    compactedSummaryLastRaw: undefined,
    memoryTableSnapshot: undefined,
  }]);
  assert.deepEqual(entries.find(entry => entry.name === 'chat/archives/archive_a.json').value, {
    id: 'archive/a',
    messages: [{ id: 'old-1' }],
  });
  console.log('ok - buildExperiencePackJsonEntryPayloads preserves json entry order and optional payload contracts');
}

{
  const entries = buildExperiencePackJsonEntryPayloads({
    manifest: {},
    character: {},
    world: {},
    variableCore: {},
    regex: {},
  });
  assert.deepEqual(entries.map(entry => entry.name), [
    'manifest.json',
    'character.json',
    'worldbook/worldbooks.json',
    'variables/core.json',
    'scripts/regex.json',
  ]);
  console.log('ok - buildExperiencePackJsonEntryPayloads omits optional layers when absent');
}
