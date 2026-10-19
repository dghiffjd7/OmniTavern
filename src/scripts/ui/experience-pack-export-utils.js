const ensureArray = value => (Array.isArray(value) ? value : []);

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

export const buildExperiencePackContactPayload = ({
  contact = {},
  sessionId = '',
  avatarFile = '',
  avatarRaw = '',
} = {}) => {
  const sid = String(sessionId || '').trim();
  return {
    id: String(contact?.id || sid),
    name: String(contact?.name || sid),
    description: String(contact?.description || ''),
    labels: ensureArray(contact?.labels).map(String),
    avatarFile: String(avatarFile || ''),
    avatarValue: avatarFile ? '' : String(avatarRaw || ''),
  };
};

export const buildExperiencePackPersonaPayload = ({
  persona = null,
  contact = {},
  sessionId = '',
  avatarFile = '',
  avatarRaw = '',
} = {}) => {
  if (!persona || typeof persona !== 'object') return null;
  const sid = String(sessionId || '').trim();
  return {
    name: String(persona?.name || '').trim() || String(contact?.name || sid),
    description: String(persona?.description || ''),
    avatarFile: String(avatarFile || ''),
    avatarValue: avatarFile ? '' : String(avatarRaw || ''),
    userBubbleColor: String(persona?.userBubbleColor || ''),
    userTextColor: String(persona?.userTextColor || ''),
    position: Number(persona?.position || 0) || 0,
    depth: Number(persona?.depth || 0) || 0,
    role: Number(persona?.role || 0) || 0,
    source: cloneJson(persona?.source || null, null),
    lockToSession: true,
  };
};

export const buildExperiencePackPersonaBundlePayload = ({
  contact = {},
  sessionId = '',
  contactAvatarFile = '',
  contactAvatarRaw = '',
  persona = null,
  personaAvatarFile = '',
  personaAvatarRaw = '',
  personaCard = null,
} = {}) => ({
  contact: buildExperiencePackContactPayload({
    contact,
    sessionId,
    avatarFile: contactAvatarFile,
    avatarRaw: contactAvatarRaw,
  }),
  persona: buildExperiencePackPersonaPayload({
    persona,
    contact,
    sessionId,
    avatarFile: personaAvatarFile,
    avatarRaw: personaAvatarRaw,
  }),
  personaCard: persona ? personaCard : null,
});

export const buildExperiencePackStickerItemPayload = ({
  sticker = {},
  assetFile = '',
  frameFiles = [],
} = {}) => ({
  id: String(sticker?.id || ''),
  name: String(sticker?.name || ''),
  keyword: String(sticker?.keyword || ''),
  fps: Number(sticker?.fps || 0) || 0,
  assetFile: String(assetFile || ''),
  frameFiles: ensureArray(frameFiles),
});

export const buildExperiencePackStickerPackPayload = ({
  pack = {},
  iconFile = '',
  stickers = [],
} = {}) => ({
  id: String(pack?.id || ''),
  name: String(pack?.name || ''),
  colorIndex: Number(pack?.colorIndex || 0) || 0,
  aiEnabled: pack?.aiEnabled === true,
  iconFile: String(iconFile || ''),
  iconMeta: cloneJson(pack?.iconMeta || {}, {}),
  stickers: ensureArray(stickers),
});

const normalizeExperiencePackWallpaperOpacity = value => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
};

const buildExperiencePackWallpaperMeta = (wallpaper = {}) => ({
  name: String(wallpaper?.name || ''),
  zoom: Number(wallpaper?.zoom || 1) || 1,
  rotate: Number(wallpaper?.rotate || 0) || 0,
  offsetX: Number(wallpaper?.offsetX || 0) || 0,
  offsetY: Number(wallpaper?.offsetY || 0) || 0,
  width: Number(wallpaper?.width || 0) || 0,
  height: Number(wallpaper?.height || 0) || 0,
  opacity: normalizeExperiencePackWallpaperOpacity(wallpaper?.opacity ?? 1),
});

export const buildExperiencePackWallpaperFilePayload = ({
  file = '',
  wallpaper = {},
} = {}) => ({
  file: String(file || ''),
  remoteUrl: '',
  meta: {
    ...buildExperiencePackWallpaperMeta(wallpaper),
    saveOriginal: wallpaper?.saveOriginal === true,
  },
});

export const buildExperiencePackWallpaperRemotePayload = ({
  remoteUrl = '',
  wallpaper = {},
} = {}) => ({
  file: '',
  remoteUrl: String(remoteUrl || ''),
  meta: buildExperiencePackWallpaperMeta(wallpaper),
});

export const buildExperiencePackManifest = ({
  sessionId = '',
  character = null,
  room = null,
  memoryData = null,
  variableState = null,
  chat = null,
  agentWorkflow = null,
  options = {},
  exportedAt = new Date().toISOString(),
  exportedBy = 'OmniTavern',
  format = 'chatapp.experience-pack.v1',
  formatVersion = 1,
} = {}) => ({
  format,
  formatVersion,
  exportedAt,
  exportedBy,
  character: {
    id: String(sessionId || ''),
    name: String(character?.contact?.name || sessionId),
  },
  layers: {
    core: true,
    room: Boolean(room),
    stickers: Boolean(room && ensureArray(room.stickers).length),
    memory_template: Boolean(room?.memoryTemplate),
    memory_data: Boolean(memoryData),
    variable_state: Boolean(variableState),
    chat_history: Boolean(chat),
    agents: Boolean(agentWorkflow),
  },
  options: {
    hideServiceAddresses: options.hideServiceAddresses === true,
  },
});

export const buildExperiencePackChatSessionPayload = (chat = {}) => ({
  exportedRange: chat?.exportedRange,
  draft: chat?.draft,
  current: chat?.current,
  archives: ensureArray(chat?.archives).map(archive => ({
    id: archive?.id,
    name: archive?.name,
    timestamp: archive?.timestamp,
    messageCount: archive?.messageCount,
    summaries: archive?.summaries,
    compactedSummary: archive?.compactedSummary,
    compactedSummaryLastRaw: archive?.compactedSummaryLastRaw,
    memoryTableSnapshot: archive?.memoryTableSnapshot,
  })),
});

export const buildExperiencePackJsonEntryPayloads = ({
  manifest = null,
  character = null,
  world = null,
  variableCore = null,
  regex = null,
  variableState = null,
  room = null,
  memoryData = null,
  chat = null,
  agentWorkflow = null,
  archiveEntryNameForId = archiveId => `chat/archives/${String(archiveId || 'archive')}.json`,
} = {}) => {
  const entries = [
    { name: 'manifest.json', value: manifest },
    { name: 'character.json', value: character },
    { name: 'worldbook/worldbooks.json', value: world },
    { name: 'variables/core.json', value: variableCore },
    { name: 'scripts/regex.json', value: regex },
  ];

  if (character?.personaCard) {
    entries.push({ name: 'persona/original-card.json', value: character.personaCard });
  }
  if (variableState) {
    entries.push({ name: 'variables/state.json', value: variableState });
  }
  if (room) {
    entries.push(
      {
        name: 'room/config.json',
        value: {
          sessionSettings: room.sessionSettings,
          wallpaper: room.wallpaper,
        },
      },
      { name: 'room/presets.json', value: room.presets },
      { name: 'room/connection-profile.json', value: room.connection },
    );
    if (room.agentCenterSettings) {
      entries.push({ name: 'room/agent-center-settings.json', value: room.agentCenterSettings });
    }
    if (ensureArray(room.stickers).length) {
      entries.push({ name: 'room/stickers.json', value: room.stickers });
    }
    if (room.memoryTemplate) {
      entries.push({ name: 'memory/template.json', value: room.memoryTemplate });
    }
  }
  // 这个联系人的聊天 Agent 配置（AC 工作流格式，只含 Agent 与用到的预设）
  if (agentWorkflow) {
    entries.push({ name: 'agents/workflow.json', value: agentWorkflow });
  }
  if (memoryData) {
    entries.push({ name: 'memory/data.json', value: memoryData });
  }
  if (chat) {
    entries.push(
      { name: 'chat/session.json', value: buildExperiencePackChatSessionPayload(chat) },
      { name: 'chat/current.json', value: chat.currentMessages },
    );
    ensureArray(chat.archives).forEach(archive => {
      entries.push({
        name: archiveEntryNameForId(archive?.id),
        value: {
          id: archive?.id,
          messages: archive?.messages,
        },
      });
    });
  }

  return entries;
};
