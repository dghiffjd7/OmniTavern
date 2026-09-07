const SETTINGS_KEY = 'app_settings_v1';
const LEGACY_LIGHT_CHAT_DEFAULTS = Object.freeze({
  bubbleColor: '#c9c9c9',
  textColor: '#1F2937',
});
const LEGACY_DARK_CHAT_DEFAULTS = Object.freeze({
  bubbleColor: '#000000',
  textColor: '#ffffff',
});

const normalizeChatColorMode = (value, fallback = 'theme') => {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'custom' ? 'custom' : fallback;
};

const isThemeManagedChatDefaultColor = (value, kind = 'bubble') => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return true;
  return kind === 'text'
    ? raw === LEGACY_LIGHT_CHAT_DEFAULTS.textColor.toLowerCase()
      || raw === LEGACY_DARK_CHAT_DEFAULTS.textColor.toLowerCase()
    : raw === LEGACY_LIGHT_CHAT_DEFAULTS.bubbleColor.toLowerCase()
      || raw === LEGACY_DARK_CHAT_DEFAULTS.bubbleColor.toLowerCase();
};

const inferChatColorMode = (input = {}, fallback = 'theme') => {
  const explicit = String(input?.chatDefaultColorMode || '').trim().toLowerCase();
  if (explicit === 'custom' || explicit === 'theme') return explicit;
  const bubble = String(input?.chatDefaultBubbleColor || '').trim();
  const text = String(input?.chatDefaultTextColor || '').trim();
  if (!bubble && !text) return fallback;
  return isThemeManagedChatDefaultColor(bubble, 'bubble') && isThemeManagedChatDefaultColor(text, 'text')
    ? 'theme'
    : 'custom';
};

const defaults = {
  locale: 'system',
  languageSetupCompleted: false,
  showDebugToggle: false,
  debugExecutionLogs: false,
  typingDotsEnabled: true,
  allowRichIframeScripts: false,
  chatHistoryMax: 0,
  creativeHistoryMax: 0,
  creativeWideBubble: true,
  creativeReadingSize: 'standard',
  creativeNarrativeFont: 'serif',
  creativeDialogueHighlightEnabled: true,
  // 跳房子编排（创意写作）：默认关闭；关闭或无用户板时沿用既有固定流程
  creativeHopscotchEnabled: false,
  reasoningAutoParse: false,
  reasoningAutoExpand: false,
  reasoningShowHidden: false,
  reasoningAddToPrompts: false,
  reasoningMaxAdditions: 1,
  personaBindContacts: true,
  promptCurrentTimeEnabled: false,
  momentCommentSideEffectsEnabled: true,
  autoImagePromptEnabled: false,
  autoImagePromptWritingEnabled: true,
  autoImagePromptStyle: 'auto',
  autoImagePromptDecisionMode: 'conservative',
  autoImagePromptMomentMediaMode: 'ai',
  autoImagePromptCooldownRounds: 0,
  autoImagePromptWindowRounds: 0,
  autoImagePromptWindowMax: 0,
  autoImagePromptMaxConcurrency: 1,
  autoImagePromptMaxPerResponse: 0,
  autoImagePromptConcurrencyDefaultMigrated: true,
  autoImagePromptSkipRepeated: true,
  autoImagePromptRateLimitDefaultsMigrated: true,
  templateEnabled: false,
  templateExecuteBeforeGenerate: true,
  templateExecuteAfterRender: true,
  templateShowErrorToast: true,
  templateDetectDisabled: false,
  scriptEnabled: false,
  scriptAllowModifyVariables: true,
  scriptAllowReadMessages: true,
  scriptAllowNetwork: false,
  memoryEnabled: true,
  memoryStorageMode: 'table',
  memoryTableEnabledChat: true,
  memoryTableEnabledMoments: true,
  memoryTableEnabledWriting: true,
  memoryAutoExtract: true,
  memoryAutoExtractMode: 'inline',
  memoryInjectDefaultD0Migrated: true,
  memoryInjectDefaultLatestUserMigrated: true,
  memoryUpdateApiMode: 'chat',
  memoryUpdateProfileId: '',
  memoryUpdateContextRounds: 6,
  memoryInjectPosition: 'before_latest_user',
  memoryInjectDepth: 0,
  memoryBudgetMode: 'token',
  memoryInputBudgetTokens: 100000,
  memoryMaxRows: 1000,
  memoryMaxTokens: 100000,
  memoryGroupMemberReferenceEnabled: true,
  memoryGroupMemberReferenceLimit: 5,
  memoryBridgeRpToChatEnabled: true,
  memoryBridgeRpToChatLimit: 0,
  memoryBridgeChatToRpEnabled: true,
  memoryBridgeChatToRpLimit: 5,
  memoryBridgeMomentsToChatEnabled: true,
  memoryBridgeMomentsToChatLimit: 5,
  memoryBridgeMomentsToChatTableSettings: {},
  memoryBridgeChatToMomentsEnabled: true,
  memoryBridgeChatToMomentsLimit: 5,
  memoryBridgeChatToMomentsTableSettings: {},
  memoryBridgeRpToMomentsEnabled: true,
  memoryBridgeRpToMomentsLimit: 5,
  memoryBridgeRpToMomentsTableSettings: {},
  memoryAutoConfirm: false,
  memoryAutoStepByStep: false,
  memoryFillEveryN: 1,
  chatDefaultColorMode: 'theme',
  chatDefaultBubbleColor: '#c9c9c9',
  chatDefaultTextColor: '#1F2937',
  uiThemePresetId: 'paper-ink',
  uiThemeAvatarStyle: 'system',
  uiThemeChatDisplay: 'default',
  uiThemeToastrPosition: 'toast-top-right',
  uiThemeFontScale: 1,
  uiThemeReducedMotion: false,
  uiThemeCompactInput: false,
  uiThemeHideChatAvatars: false,
  uiThemeSchemaVersion: 2,
  traditionalModelOutputProtocolEnabled: false,
  chatStructuredThinkingPreference: 'preserve',
  presetScopeMigrationNoticeShown: false,
  webSearchProvider: 'duckduckgo',
  webSearchLocale: 'zh-tw',
  webSearchApiKey: '',
  voiceConnectionMode: 'shared',
  realtimeVoiceSettings: {
    configRef: { scope: 'voice_shared', profileId: '' },
    realtimeModel: 'gpt-realtime-2.1',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    transcriptionLanguage: '',
    voice: 'marin',
    vad: {
      mode: 'server_vad',
      threshold: 0.5,
      prefixPaddingMs: 300,
      silenceDurationMs: 600,
      createResponse: false,
      interruptResponse: true,
    },
    idleTimeoutMinutes: 10,
    retentionRatio: 0.8,
    postInstructionsTokens: 8000,
  },
};

// localStorage 配额满时 setItem 会静默失败（真机已发生）；kv（Tauri 本地文件）为权威通道，
// localStorage 仅作同步读缓存。会话内以内存态为准，跨启动由 hydrate 以 __updatedAt 裁决新旧。
let memorySettings = null;
let kvChannel = null;
let persistenceMeta = { hasPersistedSettings: false, source: 'none' };

const readLocalSettings = () => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const readSettings = () => {
  if (memorySettings) return memorySettings;
  return readLocalSettings();
};

const writeSettings = (next) => {
  const stamped = { ...next, __updatedAt: Date.now() };
  memorySettings = stamped;
  persistenceMeta = { hasPersistedSettings: true, source: 'memory' };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(stamped));
  } catch {}
  if (kvChannel?.save) {
    Promise.resolve(kvChannel.save(SETTINGS_KEY, stamped)).catch(() => {});
  }
};

const migrateSettings = (settings = {}) => {
  const next = { ...(settings || {}) };
  const localeRaw = String(next.locale || '').trim().toLowerCase();
  next.locale = localeRaw === 'zh-cn'
    ? 'zh-CN'
    : localeRaw === 'zh-tw'
      ? 'zh-TW'
      : localeRaw === 'en'
        ? 'en'
        : 'system';
  next.languageSetupCompleted = next.languageSetupCompleted === true;
  if (next.memoryUpdateContextRounds == null && next.memoryUpdateContextCount != null) {
    const raw = Math.trunc(Number(next.memoryUpdateContextCount));
    const safe = Number.isFinite(raw) ? Math.max(0, raw) : defaults.memoryUpdateContextRounds;
    next.memoryUpdateContextRounds = safe;
  }
  const injectPositionRaw = String(next.memoryInjectPosition || '').trim().toLowerCase();
  if (!injectPositionRaw) {
    next.memoryInjectPosition = defaults.memoryInjectPosition;
  } else if (injectPositionRaw === 'history_depth') {
    const injectDepthRaw = Math.trunc(Number(next.memoryInjectDepth));
    if (!Number.isFinite(injectDepthRaw)) next.memoryInjectDepth = defaults.memoryInjectDepth;
  }
  const injectDepthRaw = Math.trunc(Number(next.memoryInjectDepth));
  if (!Number.isFinite(injectDepthRaw) || injectDepthRaw < 0) {
    next.memoryInjectDepth = defaults.memoryInjectDepth;
  }
  if (
    next.memoryInjectDefaultD0Migrated !== true &&
    String(next.memoryInjectPosition || '').trim().toLowerCase() === 'history_after' &&
    Number(next.memoryInjectDepth || 0) === 0
  ) {
    next.memoryInjectPosition = 'history_depth';
    next.memoryInjectDepth = 0;
  }
  next.memoryInjectDefaultD0Migrated = true;
  if (
    next.memoryInjectDefaultLatestUserMigrated !== true &&
    String(next.memoryInjectPosition || '').trim().toLowerCase() === 'history_depth' &&
    Number(next.memoryInjectDepth || 0) === 0
  ) {
    next.memoryInjectPosition = 'before_latest_user';
    next.memoryInjectDepth = 0;
  }
  next.memoryInjectDefaultLatestUserMigrated = true;
  if (next.uiThemeSchemaVersion == null) {
    if (String(next.uiThemeAvatarStyle || '').trim().toLowerCase() === 'rounded') {
      next.uiThemeAvatarStyle = 'system';
    }
    next.uiThemeSchemaVersion = defaults.uiThemeSchemaVersion;
  }
  const imageDecisionMode = String(next.autoImagePromptDecisionMode || '').trim().toLowerCase();
  if (!['conservative', 'standard', 'aggressive'].includes(imageDecisionMode)) {
    next.autoImagePromptDecisionMode = defaults.autoImagePromptDecisionMode;
  }
  const imageMomentMediaMode = String(next.autoImagePromptMomentMediaMode || '').trim().toLowerCase();
  if (!['placeholder', 'image_prompt', 'ai'].includes(imageMomentMediaMode)) {
    next.autoImagePromptMomentMediaMode = defaults.autoImagePromptMomentMediaMode;
  }
  ['autoImagePromptCooldownRounds', 'autoImagePromptWindowRounds', 'autoImagePromptWindowMax', 'autoImagePromptMaxPerResponse'].forEach((key) => {
    const raw = Math.trunc(Number(next[key]));
    next[key] = Number.isFinite(raw) ? Math.max(0, raw) : defaults[key];
  });
  if (
    next.autoImagePromptConcurrencyDefaultMigrated !== true &&
    Number(next.autoImagePromptMaxConcurrency) === 5
  ) {
    next.autoImagePromptMaxConcurrency = defaults.autoImagePromptMaxConcurrency;
  }
  next.autoImagePromptConcurrencyDefaultMigrated = true;
  const imageMaxConcurrency = Math.trunc(Number(next.autoImagePromptMaxConcurrency));
  next.autoImagePromptMaxConcurrency = Number.isFinite(imageMaxConcurrency)
    ? Math.max(1, imageMaxConcurrency)
    : defaults.autoImagePromptMaxConcurrency;
  if (
    next.autoImagePromptRateLimitDefaultsMigrated !== true &&
    Number(next.autoImagePromptCooldownRounds) === 2 &&
    Number(next.autoImagePromptWindowRounds) === 10 &&
    Number(next.autoImagePromptWindowMax) === 2
  ) {
    next.autoImagePromptCooldownRounds = 0;
    next.autoImagePromptWindowRounds = 0;
    next.autoImagePromptWindowMax = 0;
  }
  next.autoImagePromptRateLimitDefaultsMigrated = true;
  next.autoImagePromptSkipRepeated = next.autoImagePromptSkipRepeated !== false;
  next.autoImagePromptWritingEnabled = next.autoImagePromptWritingEnabled !== false;
  next.momentCommentSideEffectsEnabled = next.momentCommentSideEffectsEnabled !== false;
  next.memoryTableEnabledChat = next.memoryTableEnabledChat !== false;
  // 注入整合语义澄清（2026-07-16）：注入选择条只管预览展示，不动功能开关；
  // 一次性回滚此前 presetInjectMemoryChatDefaultOffMigrated 对聊天位的默认关闭
  if (next.presetInjectMemoryChatDefaultOffMigrated === true && next.presetInjectMemoryChatOffRolledBack !== true) {
    next.memoryTableEnabledChat = true;
  }
  next.presetInjectMemoryChatOffRolledBack = true;
  next.memoryTableEnabledMoments = next.memoryTableEnabledMoments !== false;
  next.memoryTableEnabledWriting = next.memoryTableEnabledWriting !== false;
  next.memoryBridgeMomentsToChatEnabled = next.memoryBridgeMomentsToChatEnabled !== false;
  next.memoryBridgeChatToMomentsEnabled = next.memoryBridgeChatToMomentsEnabled !== false;
  next.memoryBridgeRpToMomentsEnabled = next.memoryBridgeRpToMomentsEnabled !== false;
  next.memoryBudgetMode = String(next.memoryBudgetMode || '').trim().toLowerCase() === 'rows'
    ? 'rows'
    : defaults.memoryBudgetMode;
  [
    'memoryInputBudgetTokens',
    'memoryMaxRows',
    'memoryMaxTokens',
    'memoryGroupMemberReferenceLimit',
    'memoryBridgeRpToChatLimit',
    'memoryBridgeChatToRpLimit',
    'memoryBridgeMomentsToChatLimit',
    'memoryBridgeChatToMomentsLimit',
    'memoryBridgeRpToMomentsLimit',
  ].forEach((key) => {
    const raw = Math.trunc(Number(next[key]));
    next[key] = Number.isFinite(raw) ? Math.max(0, raw) : defaults[key];
  });
  next.memoryGroupMemberReferenceEnabled = next.memoryGroupMemberReferenceEnabled !== false;
  ['memoryBridgeMomentsToChatTableSettings', 'memoryBridgeChatToMomentsTableSettings', 'memoryBridgeRpToMomentsTableSettings'].forEach((key) => {
    if (!next[key] || typeof next[key] !== 'object' || Array.isArray(next[key])) next[key] = {};
  });
  next.chatDefaultColorMode = inferChatColorMode(next, defaults.chatDefaultColorMode);
  next.traditionalModelOutputProtocolEnabled = next.traditionalModelOutputProtocolEnabled === true;
  next.chatStructuredThinkingPreference = String(next.chatStructuredThinkingPreference || '').trim().toLowerCase() === 'stable_format'
    ? 'stable_format'
    : defaults.chatStructuredThinkingPreference;
  next.presetScopeMigrationNoticeShown = next.presetScopeMigrationNoticeShown === true;
  const searchProvider = String(next.webSearchProvider || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  next.webSearchProvider = ['duckduckgo', 'brave', 'tavily', 'serpapi'].includes(searchProvider)
    ? searchProvider
    : defaults.webSearchProvider;
  next.webSearchLocale = String(next.webSearchLocale || defaults.webSearchLocale).trim() || defaults.webSearchLocale;
  next.webSearchApiKey = String(next.webSearchApiKey || '');
  next.voiceConnectionMode = String(next.voiceConnectionMode || '').trim().toLowerCase() === 'split'
    ? 'split'
    : defaults.voiceConnectionMode;
  const realtimeInput = next.realtimeVoiceSettings && typeof next.realtimeVoiceSettings === 'object'
    ? next.realtimeVoiceSettings
    : {};
  const realtimeRef = realtimeInput.configRef && typeof realtimeInput.configRef === 'object'
    ? realtimeInput.configRef
    : {};
  const realtimeScope = String(realtimeRef.scope || '').trim().toLowerCase();
  const allowedRealtimeScopes = new Set(['chat', 'voice_shared', 'voice_tts', 'voice_stt']);
  const realtimeVad = realtimeInput.vad && typeof realtimeInput.vad === 'object'
    ? realtimeInput.vad
    : {};
  const realtimeTranscriptionLanguage = Array.from(new Set(
    String(realtimeInput.transcriptionLanguage || '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(value => /^[a-z]{2,3}(?:-[a-z]{2})?$/.test(value)),
  )).slice(0, 8).join(',');
  const clampRealtimeNumber = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  };
  next.realtimeVoiceSettings = {
    configRef: {
      scope: allowedRealtimeScopes.has(realtimeScope) ? realtimeScope : 'voice_shared',
      profileId: String(realtimeRef.profileId || '').trim(),
    },
    realtimeModel: String(realtimeInput.realtimeModel || 'gpt-realtime-2.1').trim() || 'gpt-realtime-2.1',
    transcriptionModel: String(realtimeInput.transcriptionModel || 'gpt-4o-mini-transcribe').trim() || 'gpt-4o-mini-transcribe',
    transcriptionLanguage: realtimeTranscriptionLanguage,
    voice: String(realtimeInput.voice || 'marin').trim().toLowerCase() || 'marin',
    vad: {
      mode: String(realtimeVad.mode || '').trim().toLowerCase() === 'semantic_vad'
        ? 'semantic_vad'
        : 'server_vad',
      threshold: clampRealtimeNumber(realtimeVad.threshold, 0.5, 0, 1),
      prefixPaddingMs: Math.round(clampRealtimeNumber(realtimeVad.prefixPaddingMs, 300, 0, 5000)),
      silenceDurationMs: Math.round(clampRealtimeNumber(realtimeVad.silenceDurationMs, 600, 100, 5000)),
      createResponse: false,
      interruptResponse: true,
    },
    idleTimeoutMinutes: Math.round(clampRealtimeNumber(realtimeInput.idleTimeoutMinutes, 10, 1, 30)),
    retentionRatio: clampRealtimeNumber(realtimeInput.retentionRatio, 0.8, 0.5, 1),
    postInstructionsTokens: Math.round(clampRealtimeNumber(realtimeInput.postInstructionsTokens, 8000, 1000, 16000)),
  };
  next.creativeDialogueHighlightEnabled = next.creativeDialogueHighlightEnabled !== false;
  next.creativeHopscotchEnabled = next.creativeHopscotchEnabled === true;
  return next;
};

export const appSettings = {
  // boot 早期调用：注入 kv 通道并用较新的一侧（__updatedAt）作为权威。
  async hydrate({ loadKv = null, saveKv = null } = {}) {
    kvChannel = { load: loadKv, save: saveKv };
    const localData = readLocalSettings();
    const hasLocalData = Object.keys(localData).length > 0;
    persistenceMeta = {
      hasPersistedSettings: hasLocalData,
      source: hasLocalData ? 'local' : 'none',
    };
    if (typeof loadKv !== 'function') return this.get();
    try {
      const kvRaw = await loadKv(SETTINGS_KEY);
      const kvData = kvRaw && typeof kvRaw === 'object' && !kvRaw._tooLarge ? kvRaw : null;
      if (kvData && Object.keys(kvData).length) {
        memorySettings = Number(kvData.__updatedAt || 0) >= Number(localData.__updatedAt || 0)
          ? kvData
          : localData;
        const source = memorySettings === kvData ? 'kv' : 'local';
        persistenceMeta = { hasPersistedSettings: true, source };
      }
    } catch {}
    return this.get();
  },
  getPersistenceMeta() {
    return { ...persistenceMeta };
  },
  get() {
    const { __updatedAt: _stamp, ...settings } = { ...defaults, ...migrateSettings(readSettings()) };
    return settings;
  },
  getStored() {
    const { __updatedAt: _stamp, ...settings } = migrateSettings(readSettings());
    return settings;
  },
  update(patch = {}) {
    const current = migrateSettings(readSettings());
    const { webSearchApiKey: _ignoredPlaintextSearchKey, ...safePatch } = patch || {};
    const next = { ...defaults, ...current, ...safePatch };
    delete next.__updatedAt;
    // 普通设置写入既不能新增明文凭证，也不能在迁移失败时误删尚待重试的旧凭证。
    next.webSearchApiKey = String(current.webSearchApiKey || '');
    writeSettings(next);
    return next;
  },
  clearLegacyWebSearchApiKey(expectedKey = '') {
    const current = migrateSettings(readSettings());
    const storedKey = String(current.webSearchApiKey || '');
    const expected = String(expectedKey || '');
    if (expected && storedKey !== expected) return false;
    if (!storedKey) return true;
    const next = { ...defaults, ...current, webSearchApiKey: '' };
    delete next.__updatedAt;
    writeSettings(next);
    return true;
  },
};
