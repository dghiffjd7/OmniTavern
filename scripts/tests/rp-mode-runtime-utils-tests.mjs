import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  LEGACY_SEND_MODE_STORAGE_KEY,
  UI_MODE_STORAGE_KEY,
  applyRpGreetingUpdateVariables,
  normalizeUiMode,
  readUiMode,
  refreshImportedRpGreetingsIfActive,
  removeLegacySendModeState,
  resetRpGreetingVariableState,
  resolveRpInitVarWorldIds,
  runRpGreetingStoreWrite,
  runEnterRpModeFlow,
  runExitRpModeFlow,
  writeUiMode,
} from '../../src/scripts/ui/chat/rp-mode-runtime-utils.js';

{
  const calls = [];
  const refreshed = await refreshImportedRpGreetingsIfActive({
    uiMode: 'rp',
    personaId: 'persona_new',
    activePersonaId: 'persona_new',
    currentSessionId: 'rp:persona_new',
    getRpSessionId: personaId => `rp:${personaId}`,
    seedRpGreetingIfNeeded: async sessionId => {
      calls.push(['seed', sessionId]);
      return true;
    },
    refreshRpToolbar: sessionId => calls.push(['toolbar', sessionId]),
  });
  assert.equal(refreshed, true);
  assert.deepEqual(calls, [
    ['seed', 'rp:persona_new'],
    ['toolbar', 'rp:persona_new'],
  ]);

  for (const inactive of [
    { uiMode: 'chat', activePersonaId: 'persona_new', currentSessionId: 'rp:persona_new' },
    { uiMode: 'rp', activePersonaId: 'persona_old', currentSessionId: 'rp:persona_new' },
    { uiMode: 'rp', activePersonaId: 'persona_new', currentSessionId: 'rp:persona_old' },
  ]) {
    assert.equal(await refreshImportedRpGreetingsIfActive({
      ...inactive,
      personaId: 'persona_new',
      getRpSessionId: personaId => `rp:${personaId}`,
      seedRpGreetingIfNeeded: async () => {
        throw new Error('inactive import must not seed');
      },
      refreshRpToolbar: () => {
        throw new Error('inactive import must not refresh');
      },
    }), false);
  }
  console.log('ok - imported greetings refresh the active creative-writing session without a mode toggle');
}

{
  const warnings = [];
  const failures = [];
  const error = Object.assign(new Error('store blocked'), {
    code: 'rp_session_store_read_unavailable',
  });
  const blocked = runRpGreetingStoreWrite({
    mutate: () => {
      throw error;
    },
    logger: { warn: (...args) => warnings.push(args) },
    onFailure: value => failures.push(value),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, error);
  assert.equal(blocked.errorCode, 'rp_session_store_read_unavailable');
  assert.equal(warnings.length, 1);
  assert.deepEqual(failures, [error]);

  const success = runRpGreetingStoreWrite({
    mutate: () => 'greeting-2',
  });
  assert.deepEqual(success, { ok: true, value: 'greeting-2' });
  console.log('ok - RP greeting writes catch fail-closed store errors at UI boundaries');
}

{
  const calls = [];
  const stored = { id: 'g1', role: 'assistant', raw: 'cleaned greeting' };
  const result = applyRpGreetingUpdateVariables({
    message: { id: 'g1', role: 'assistant', rawOriginal: '<UpdateVariable>...</UpdateVariable>' },
    sessionId: ' rp:hero ',
    resolveApply: () => (message, sessionId) => calls.push(['apply', message.id, sessionId]),
    getMessage: (messageId, sessionId) => {
      calls.push(['get', messageId, sessionId]);
      return stored;
    },
  });
  assert.equal(result, stored);
  assert.deepEqual(calls, [
    ['apply', 'g1', 'rp:hero'],
    ['get', 'g1', 'rp:hero'],
  ]);
  console.log('ok - rp greeting applies UpdateVariable before first render and reloads persisted message');
}

{
  let legacyRead = false;
  const ids = resolveRpInitVarWorldIds({
    bridge: {
      getResolvedWorldState(sessionId, options) {
        assert.equal(sessionId, 'rp:hero');
        assert.deepEqual(options, { uiMode: 'rp' });
        return { worldIds: ['global-book', 'role-book', 'role-book', ''] };
      },
      getWorldIdsForSession() {
        legacyRead = true;
        return ['wrong-session-only-book'];
      },
    },
    sessionId: ' rp:hero ',
    uiMode: 'rp',
  });
  assert.deepEqual(ids, ['global-book', 'role-book']);
  assert.equal(legacyRead, false);
  console.log('ok - RP init variables resolve role worldbooks through unified world state');
}

{
  const ids = resolveRpInitVarWorldIds({
    bridge: {
      getGlobalWorldId: () => 'global-book',
      getWorldIdsForSession: () => ['session-book', 'global-book'],
    },
    sessionId: 'rp:legacy',
  });
  assert.deepEqual(ids, ['global-book', 'session-book']);
  console.log('ok - RP init variable world resolution keeps legacy bridge fallback');
}

{
  const calls = [];
  assert.equal(resetRpGreetingVariableState({
    chatStore: {
      clearVariables: sessionId => calls.push(['clear-current', sessionId]),
      clearInitialVariables: sessionId => calls.push(['clear-initial', sessionId]),
    },
    sessionId: ' rp:hero ',
    applyMvuSchemaDefaults: (sessionId, options) => calls.push(['schema-defaults', sessionId, options]),
  }), true);
  assert.deepEqual(calls, [
    ['clear-current', 'rp:hero'],
    ['clear-initial', 'rp:hero'],
    ['schema-defaults', 'rp:hero', { reason: 'rp_greeting_reset' }],
  ]);
  console.log('ok - RP greeting reset rebuilds current and initial variable state before seeding');
}

const createStorage = () => {
  const values = new Map();
  return {
    values,
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
};

{
  assert.equal(UI_MODE_STORAGE_KEY, 'chat_ui_mode_v1');
  assert.equal(LEGACY_SEND_MODE_STORAGE_KEY, 'chat_send_mode_v1');
  assert.equal(normalizeUiMode('rp'), 'rp');
  assert.equal(normalizeUiMode(' RP '), 'rp');
  assert.equal(normalizeUiMode('creative'), 'chat');
  assert.equal(normalizeUiMode(''), 'chat');
  console.log('ok - ui mode storage helpers preserve legacy keys and mode normalization');
}

{
  const storage = createStorage();
  assert.equal(writeUiMode('rp', { storage }), true);
  assert.equal(storage.values.get(UI_MODE_STORAGE_KEY), 'rp');
  assert.equal(readUiMode({ storage }), 'rp');
  assert.equal(writeUiMode('bad', { storage }), true);
  assert.equal(storage.values.get(UI_MODE_STORAGE_KEY), 'chat');
  storage.values.set(UI_MODE_STORAGE_KEY, 'RP');
  assert.equal(readUiMode({ storage }), 'rp');
  storage.values.set(LEGACY_SEND_MODE_STORAGE_KEY, 'creative');
  assert.equal(removeLegacySendModeState({ storage }), true);
  assert.equal(storage.values.has(LEGACY_SEND_MODE_STORAGE_KEY), false);
  console.log('ok - ui mode read write and legacy cleanup helpers preserve storage behavior');
}

{
  const storage = {
    getItem() { throw new Error('read failed'); },
    setItem() { throw new Error('write failed'); },
    removeItem() { throw new Error('remove failed'); },
  };
  assert.equal(readUiMode({ storage }), 'chat');
  assert.equal(writeUiMode('rp', { storage }), false);
  assert.equal(removeLegacySendModeState({ storage }), false);
  console.log('ok - ui mode storage helpers tolerate storage failures');
}

{
  const calls = [];
  let savedState = null;
  let nextMode = 'chat';
  const result = await runEnterRpModeFlow({
    uiMode: 'chat',
    captureSocial: true,
    activePage: 'contacts',
    currentSessionId: 'contact:1',
    isChatRoomVisible: () => true,
    setLastChatState: (value) => {
      savedState = value;
      calls.push(['state', value]);
    },
    setUiMode: (value) => {
      nextMode = value;
      calls.push(['mode', value]);
    },
    vibrate: (value) => calls.push(['vibrate', value]),
    persistUiMode: () => calls.push(['persist']),
    applyUiModeUI: () => calls.push(['apply-ui']),
    waitForRpSessionReady: async () => calls.push(['ready']),
    setStickerPanelOpen: (value) => calls.push(['sticker', value]),
    setActionPanelOpen: (value) => calls.push(['action', value]),
    switchPage: (page, options) => calls.push(['page', page, options]),
    getRpSessionId: (personaId) => `rp:${personaId}`,
    activePersonaId: 'hero',
    ensureSession: (sessionId) => calls.push(['ensure', sessionId]),
    getSessionSettings: () => ({ alpha: 1 }),
    setSessionSettings: (sessionId, settings) => calls.push(['settings', sessionId, settings]),
    persistChatStore: () => calls.push(['store-persist']),
    applyMvuSchemaDefaults: (sessionId, payload) => calls.push(['mvu', sessionId, payload]),
    enterChatRoom: async (sessionId, title, origin) => calls.push(['enter', sessionId, title, origin]),
    getRpTitle: () => '角色甲',
    setCurrentChatTitle: (value) => calls.push(['title', value]),
    hydrateRpCharacterName: async () => calls.push(['hydrate']),
    seedRpGreetingIfNeeded: async (sessionId) => calls.push(['greet', sessionId]),
    refreshRpToolbar: (sessionId) => calls.push(['toolbar', sessionId]),
    setBackToListVisible: (visible) => calls.push(['back', visible]),
  });

  assert.equal(result.entered, true);
  assert.equal(result.rpSessionId, 'rp:hero');
  assert.equal(nextMode, 'rp');
  assert.deepEqual(savedState, {
    activePage: 'contacts',
    sessionId: 'contact:1',
    inChatRoom: true,
  });
  assert.deepEqual(calls, [
    ['state', { activePage: 'contacts', sessionId: 'contact:1', inChatRoom: true }],
    ['mode', 'rp'],
    ['vibrate', 10],
    ['persist'],
    ['apply-ui'],
    ['ready'],
    ['sticker', false],
    ['action', false],
    ['page', 'chat', { animate: false }],
    ['ensure', 'rp:hero'],
    ['settings', 'rp:hero', { alpha: 1, sharedVariables: true, sharedMemory: false }],
    ['store-persist'],
    ['mvu', 'rp:hero', { reason: 'rp_enter' }],
    ['enter', 'rp:hero', '角色甲', 'chat'],
    ['title', '角色甲'],
    ['hydrate'],
    ['greet', 'rp:hero'],
    ['toolbar', 'rp:hero'],
    ['back', false],
  ]);
  console.log('ok - runEnterRpModeFlow captures social state switches page and enters rp session');
}

{
  const calls = [];
  const result = await runEnterRpModeFlow({
    uiMode: 'chat',
    captureSocial: false,
    activePage: 'chat',
    getRpSessionId: () => 'rp:hero',
    getRpTitle: () => '角色甲',
    setLastChatState: () => calls.push('state'),
    switchPage: () => calls.push('page'),
    enterChatRoom: async () => calls.push('enter'),
    setBackToListVisible: (visible) => calls.push(['back', visible]),
  });

  assert.equal(result.entered, true);
  assert.deepEqual(calls, ['enter', ['back', false]]);
  console.log('ok - runEnterRpModeFlow skips social capture and page switch when already on chat page');
}

{
  const calls = [];
  const result = await runEnterRpModeFlow({
    uiMode: 'rp',
    forceSessionSync: true,
    captureSocial: false,
    activePage: 'chat',
    getRpSessionId: personaId => `rp:${personaId}`,
    activePersonaId: 'new-hero',
    ensureSession: sessionId => calls.push(['ensure', sessionId]),
    enterChatRoom: async (sessionId, title, origin) => calls.push(['enter', sessionId, title, origin]),
    getRpTitle: () => '新角色',
    setCurrentChatTitle: title => calls.push(['title', title]),
    setUiMode: () => calls.push(['mode']),
    vibrate: () => calls.push(['vibrate']),
    persistUiMode: () => calls.push(['persist']),
    applyUiModeUI: () => calls.push(['apply-ui']),
    setBackToListVisible: visible => calls.push(['back', visible]),
  });

  assert.equal(result.entered, false);
  assert.equal(result.rpSessionId, 'rp:new-hero');
  assert.deepEqual(calls, [
    ['ensure', 'rp:new-hero'],
    ['enter', 'rp:new-hero', '新角色', 'chat'],
    ['title', '新角色'],
    ['back', false],
  ]);
  console.log('ok - forced RP session sync rebinds an already-open creative room without replaying mode entry');
}

{
  const calls = [];
  let nextMode = 'rp';
  let currentSession = 'rp:persona_b';
  const result = runExitRpModeFlow({
    uiMode: 'rp',
    lastChatState: {
      activePage: 'contacts',
      sessionId: 'contact:9',
      inChatRoom: true,
    },
    setUiMode: (value) => {
      nextMode = value;
      calls.push(['mode', value]);
    },
    vibrate: (value) => calls.push(['vibrate', value]),
    persistUiMode: () => calls.push(['persist']),
    applyUiModeUI: () => calls.push(['apply-ui']),
    hideRpToolbar: () => calls.push(['hide-toolbar']),
    setBackToListVisible: (visible) => calls.push(['back', visible]),
    setChatOriginPage: (value) => calls.push(['origin', value]),
    exitChatRoom: (options) => calls.push(['exit-room', options]),
    clearCurrentSession: () => {
      currentSession = '';
      calls.push(['clear-current']);
    },
    resetChatRoomState: () => calls.push(['reset-room']),
    getContact: () => ({ name: '好友九' }),
    switchPage: (page, options) => calls.push(['page', page, options]),
    enterChatRoom: (sessionId, name, origin) => {
      currentSession = sessionId;
      calls.push(['enter', sessionId, name, origin]);
    },
  });

  assert.equal(result.exited, true);
  assert.equal(nextMode, 'chat');
  assert.equal(currentSession, 'contact:9');
  assert.deepEqual(calls, [
    ['mode', 'chat'],
    ['vibrate', 10],
    ['persist'],
    ['apply-ui'],
    ['hide-toolbar'],
    ['back', true],
    ['origin', 'contacts'],
    ['exit-room', { animate: false }],
    ['clear-current'],
    ['reset-room'],
    ['page', 'contacts', { animate: false }],
    ['enter', 'contact:9', '好友九', 'contacts'],
  ]);
  console.log('ok - runExitRpModeFlow restores previous room and page after leaving rp mode');
}

{
  const calls = [];
  let currentSession = 'rp:persona_b';
  const result = runExitRpModeFlow({
    uiMode: 'rp',
    lastChatState: {
      activePage: 'chat',
      sessionId: 'contact:from-persona-a',
      inChatRoom: true,
    },
    setUiMode: value => calls.push(['mode', value]),
    setChatOriginPage: value => calls.push(['origin', value]),
    exitChatRoom: options => calls.push(['exit-room', options]),
    clearCurrentSession: () => {
      currentSession = '';
      calls.push(['clear-current']);
    },
    resetChatRoomState: () => calls.push(['reset-room']),
    getContact: sessionId => {
      calls.push(['contact', sessionId]);
      return null;
    },
    switchPage: (page, options) => calls.push(['page', page, options]),
    enterChatRoom: (...args) => calls.push(['enter', ...args]),
  });

  assert.equal(result.exited, true);
  assert.equal(currentSession, '');
  assert.deepEqual(calls, [
    ['mode', 'chat'],
    ['origin', 'chat'],
    ['exit-room', { animate: false }],
    ['clear-current'],
    ['reset-room'],
    ['contact', 'contact:from-persona-a'],
    ['page', 'chat', { animate: false }],
  ]);
  console.log('ok - runExitRpModeFlow falls back to the list and detaches stale RP current when restore contact is absent');
}

{
  let currentSession = 'rp:persona_b';
  const calls = [];
  runExitRpModeFlow({
    uiMode: 'rp',
    lastChatState: {
      activePage: 'contacts',
      sessionId: 'contact:9',
      inChatRoom: true,
    },
    exitChatRoom: () => calls.push('exit-room'),
    clearCurrentSession: () => {
      currentSession = '';
      calls.push('clear-current');
    },
    resetChatRoomState: () => calls.push('reset-room'),
    getContact: () => ({ name: '好友九' }),
    switchPage: () => calls.push('page'),
    enterChatRoom: () => {
      calls.push('blocked-enter');
      return { blocked: true, reason: 'unknown-session' };
    },
  });

  assert.equal(currentSession, '');
  assert.deepEqual(calls, [
    'exit-room',
    'clear-current',
    'reset-room',
    'page',
    'blocked-enter',
  ]);
  console.log('ok - runExitRpModeFlow keeps a safe empty current when the scoped enter guard rejects restoration');
}

{
  const appSource = await readFile(
    new URL('../../src/scripts/ui/app.js', import.meta.url),
    'utf8',
  );
  const importerSource = await readFile(
    new URL('../../src/scripts/ui/character-card-importer.js', import.meta.url),
    'utf8',
  );
  const personaPanelSource = await readFile(
    new URL('../../src/scripts/ui/persona-panel.js', import.meta.url),
    'utf8',
  );
  // 写入顺序在角色卡导入服务的 commit 里：开场白 → 世界书／正则／脚本 → 回写角色来源并通知世界书变化；
  // 导入器在 commit 完成后才调用开场白就绪回调
  const serviceSource = await readFile(
    new URL('../../src/scripts/import/character-card-import-service.js', import.meta.url),
    'utf8',
  );
  const commitBody = serviceSource.slice(serviceSource.indexOf('const commit = async'));
  const greetingWriteIndex = commitBody.indexOf('await writeGreetings(');
  const importFinalizedIndex = commitBody.indexOf('onWorldInfoChanged(');
  assert.ok(greetingWriteIndex >= 0);
  assert.ok(importFinalizedIndex > greetingWriteIndex);
  assert.ok(importerSource.includes('this.rpSessionStore.setGreetings('));
  const importCardBody = importerSource.slice(importerSource.indexOf('async importCard('));
  assert.ok(
    importCardBody.indexOf('this.onGreetingsImported?.(') > importCardBody.indexOf('await this.service.commit('),
    '导入完成回调必须等世界书、正则和角色来源资料完成后，才播种并刷新开场白',
  );
  assert.match(personaPanelSource, /onGreetingsImported:[\s\S]*this\.notifyGreetingsImported/);
  assert.match(
    appSource,
    /onGreetingsImported:\s*\(\{\s*personaId\s*\}\)\s*=>\s*refreshImportedRpGreetingsIfActive\(\{/,
  );
  const scopeFlowStart = appSource.indexOf('const applyPersonaScopeNow = async');
  const scopeFlowEnd = appSource.indexOf('const applyPersonaScope =', scopeFlowStart);
  assert.ok(scopeFlowStart >= 0 && scopeFlowEnd > scopeFlowStart);
  const scopeFlowSource = appSource.slice(scopeFlowStart, scopeFlowEnd);
  const invalidateIndex = scopeFlowSource.indexOf(
    "if (uiMode === 'rp' && nextKey !== activePersonaScopeKey)",
  );
  const hydrateIndex = scopeFlowSource.indexOf('await settlePersonaScopeStores({');
  assert.ok(invalidateIndex >= 0);
  assert.ok(hydrateIndex > invalidateIndex);
  assert.match(
    scopeFlowSource.slice(invalidateIndex, hydrateIndex),
    /lastChatState\s*=\s*\{\s*activePage:\s*'chat',\s*sessionId:\s*'',\s*inChatRoom:\s*false\s*\}/,
  );

  const exitFlowStart = appSource.indexOf('const clearCurrentChatSessionState = () =>');
  const exitFlowEnd = appSource.indexOf("backToListBtn?.addEventListener('click'", exitFlowStart);
  assert.ok(exitFlowStart >= 0 && exitFlowEnd > exitFlowStart);
  const exitFlowSource = appSource.slice(exitFlowStart, exitFlowEnd);
  assert.ok(exitFlowSource.indexOf("chatStore.setCurrent('')") >= 0);
  assert.ok(exitFlowSource.indexOf("setActiveSession?.('')") >= 0);
  assert.ok(exitFlowSource.indexOf('delete chatRoom.dataset.session') >= 0);
  assert.ok(exitFlowSource.indexOf('refreshChatAndContacts({ immediate: true })') >= 0);
  assert.ok(exitFlowSource.indexOf('clearCurrentSession: clearCurrentChatSessionState') >= 0);
  assert.ok(exitFlowSource.indexOf('resetChatRoomState,') >= 0);

  const bootFlowStart = appSource.indexOf('await runAppBootRestoreFlow({');
  const bootFlowEnd = appSource.indexOf('registerHydratedUiRestoreListener({', bootFlowStart);
  assert.ok(bootFlowStart >= 0 && bootFlowEnd > bootFlowStart);
  const bootFlowSource = appSource.slice(bootFlowStart, bootFlowEnd);
  assert.ok(bootFlowSource.indexOf('getUiMode: () => uiMode') >= 0);
  assert.ok(bootFlowSource.indexOf('detachChatModeRpSession,') >= 0);

  const greetingFlowStart = appSource.indexOf('const addRpGreeting = async');
  const greetingFlowEnd = appSource.indexOf('const getRpGreetingState =', greetingFlowStart);
  const greetingSetEnd = appSource.indexOf('const resetRpHistory = async', greetingFlowEnd);
  assert.ok(greetingFlowStart >= 0 && greetingFlowEnd > greetingFlowStart);
  assert.ok(greetingSetEnd > greetingFlowEnd);
  const greetingWriteSource = appSource.slice(greetingFlowStart, greetingSetEnd);
  assert.equal(
    (greetingWriteSource.match(/const write = commitRpGreetingStoreWrite\(/g) || []).length,
    3,
    '新增、编辑与切换开场白都必须经过 fail-closed UI 边界',
  );
  assert.equal(
    (greetingWriteSource.match(/if \(!write\.ok\) return false;/g) || []).length,
    3,
  );
  const greetingEditStart = greetingWriteSource.indexOf('const editRpGreeting = async');
  const greetingEditEnd = greetingWriteSource.indexOf('const getRpGreetingState =', greetingEditStart);
  assert.ok(greetingEditStart >= 0 && greetingEditEnd > greetingEditStart);
  assert.match(
    greetingWriteSource.slice(greetingEditStart, greetingEditEnd),
    /resetRpHistory\(sessionId,\s*\{\s*keepInput:\s*true\s*\}\)/,
    '修改当前开场白的重置必须保留创意写作输入草稿',
  );
  const resetFlowStart = appSource.indexOf('const resetRpHistory = async');
  const resetFlowEnd = appSource.indexOf('if (!chatStore.__rpGreetingWrapped)', resetFlowStart);
  const resetFlowSource = appSource.slice(resetFlowStart, resetFlowEnd);
  assert.match(resetFlowSource, /if \(withArchive\) \{/);
  assert.match(resetFlowSource, /runRpPlotResetFlow\(\{/);
  assert.match(resetFlowSource, /captureArchivePointer:[\s\S]*buildArchivePointerFromCurrentThread/);
  assert.match(resetFlowSource, /resetVariableState:[\s\S]*resetRpGreetingVariableState/);
  assert.match(
    resetFlowSource,
    /const preservedInput = keepInput[\s\S]*chatStore\.setDraft\(preservedInput, sid\)[\s\S]*ui\.setInputText\(preservedInput\)/,
    'keepInput 必须同时恢复 ChatStore 草稿与当前输入框',
  );
  assert.match(
    resetFlowSource,
    /startNewChat:[\s\S]*skipRpGreetingSeed:\s*true/,
    '存档重置必须抑制 startNewChat 包装器的后台播种，改由流程末尾等待并播种一次',
  );
  const greetingWrapperStart = appSource.indexOf('if (!chatStore.__rpGreetingWrapped)', resetFlowEnd);
  const greetingWrapperEnd = appSource.indexOf('const enterRpMode = async', greetingWrapperStart);
  assert.ok(greetingWrapperStart >= 0 && greetingWrapperEnd > greetingWrapperStart);
  assert.match(
    appSource.slice(greetingWrapperStart, greetingWrapperEnd),
    /options\?\.skipRpGreetingSeed !== true/,
  );
  assert.match(appSource, /resetRpHistory\(getRpSessionId\(activePersonaId\), \{ withArchive: true \}\)/);
  assert.match(appSource, /当前剧情会先存档/);
  assert.match(appSource, /正文、记忆表与变量可在历史存档中切回/);
  const greetingEditorStart = appSource.indexOf('const promptRpGreetingEditor =');
  const greetingEditorEnd = appSource.indexOf('const promptRpGreetingCreate =', greetingEditorStart);
  assert.ok(greetingEditorStart >= 0 && greetingEditorEnd > greetingEditorStart);
  const greetingEditorSource = appSource.slice(greetingEditorStart, greetingEditorEnd);
  assert.match(appSource, /import\s*\{\s*bindBackdropActivation\s*\}\s*from\s*'\.\/backdrop-activation-utils\.js'/);
  assert.match(greetingEditorSource, /let unbindBackdropActivation = \(\) => \{\};/);
  assert.match(greetingEditorSource, /unbindBackdropActivation\(\);/);
  assert.match(
    greetingEditorSource,
    /unbindBackdropActivation = bindBackdropActivation\(overlay, \{[\s\S]*documentLike: document,[\s\S]*onActivate: \(\) => close\(null\)/,
  );
  assert.match(
    greetingEditorSource,
    /class="rp-greeting-editor-content"[\s\S]*contenteditable="plaintext-only"[\s\S]*spellcheck="false"/,
    '长开场白编辑器应使用不触发 textarea 全文重排的纯文本 contenteditable',
  );
  assert.match(
    greetingEditorSource,
    /<div class="rp-greeting-editor-field rp-greeting-editor-content-field">[\s\S]*class="rp-greeting-editor-content"/,
    '开场白内容区不能使用 label，否则点击编辑区会代理点击第一个宏按钮',
  );
  assert.doesNotMatch(
    greetingEditorSource,
    /<label class="rp-greeting-editor-field">(?:(?!<\/label>)[\s\S])*class="rp-greeting-editor-content"/,
    'contenteditable 不应嵌套在 label 中',
  );
  assert.doesNotMatch(
    greetingEditorSource,
    /<textarea class="rp-greeting-editor-content"/,
    '长开场白编辑器不能回退为多行大文本下逐键全量重排的 textarea',
  );
  assert.match(
    greetingEditorSource,
    /readRpGreetingContent = \(\) => String\(contentInput\?\.innerText \|\| ''\)/,
    'contenteditable 必须用可保留原生 Enter 换行的纯文本读取方式保存',
  );
  assert.match(
    greetingEditorSource,
    /button\.addEventListener\('pointerdown', captureRpGreetingContentSelection\)[\s\S]*insertRpGreetingContentText\(macro, \{ preferSavedSelection: true \}\)/,
    '点击宏按钮前必须保存 contenteditable 的当前选区',
  );
  const snapshotFlowStart = appSource.indexOf('const buildSwipeMemoryTableSnapshot = async');
  const snapshotFlowEnd = appSource.indexOf('const attachAssistantMemoryStateToMeta', snapshotFlowStart);
  assert.ok(snapshotFlowStart >= 0 && snapshotFlowEnd > snapshotFlowStart);
  const snapshotFlowSource = appSource.slice(snapshotFlowStart, snapshotFlowEnd);
  assert.match(
    snapshotFlowSource,
    /getMemoryStorageModeForSession\(sessionId\)\s*!==\s*'table'/,
    'RP 快照与应用必须按 rp: session 走 writing 门，不能回退默认 chat 门',
  );
  const checkpointGateStart = appSource.indexOf('const isTurnCheckpointSessionEnabled =');
  const checkpointGateEnd = appSource.indexOf('const getTurnCheckpointSessionScope =', checkpointGateStart);
  assert.ok(checkpointGateStart >= 0 && checkpointGateEnd > checkpointGateStart);
  assert.match(
    appSource.slice(checkpointGateStart, checkpointGateEnd),
    /getMemoryStorageModeForSession\(sid\)\s*!==\s*'table'/,
  );
  const restoreCheckpointStart = appSource.indexOf('const restoreCheckpointBranchMemoryState =');
  const restoreCheckpointEnd = appSource.indexOf('const syncTurnCheckpointForMessage =', restoreCheckpointStart);
  assert.ok(restoreCheckpointStart >= 0 && restoreCheckpointEnd > restoreCheckpointStart);
  assert.match(
    appSource.slice(restoreCheckpointStart, restoreCheckpointEnd),
    /getMemoryStorageModeForSession\(sid\)\s*!==\s*'table'/,
  );
  const swipeRegenStart = appSource.indexOf('ui.onSwipeRegen(async');
  const swipeRegenEnd = appSource.indexOf('// Button: open config', swipeRegenStart);
  assert.ok(swipeRegenStart >= 0 && swipeRegenEnd > swipeRegenStart);
  const updateVariableApplyDeclaration = appSource.indexOf('const applyUpdateVariableFromMessage =');
  assert.ok(
    updateVariableApplyDeclaration >= 0 && updateVariableApplyDeclaration < swipeRegenStart,
    '右滑处理只能调用其词法作用域内已经完成装配的 UpdateVariable 函数',
  );
  const swipeRegenSource = appSource.slice(swipeRegenStart, swipeRegenEnd);
  assert.match(
    swipeRegenSource,
    /applyUpdateVariableFromMessage\(newAiMsg, sid\);[\s\S]*const finalizedNewAiMsg = chatStore\.findMessage\(newAiMsg\.id, sid\) \|\| newAiMsg;[\s\S]*commitBranch\(finalizedNewAiMsg, \{/,
    '右滑最终回复必须先补跑 UpdateVariable/状态栏占位符，再提交为正式分支',
  );
  const swipeCommitStart = swipeRegenSource.indexOf('const commitBranch =');
  const swipeCommitEnd = swipeRegenSource.indexOf('const commitBufferedSwipePartial =', swipeCommitStart);
  assert.ok(swipeCommitStart >= 0 && swipeCommitEnd > swipeCommitStart);
  assert.match(
    swipeRegenSource.slice(swipeCommitStart, swipeCommitEnd),
    /if \(!partial && !cancelled\) \{[\s\S]*captureVariableSnapshotToMessage\(sid, updated\);[\s\S]*updated = chatStore\.findMessage\(msgId, sid\) \|\| updated;/,
    '右滑正式分支必须在 UpdateVariable 应用后保存该分支变量快照',
  );
  console.log('ok - app wires safe RP exit cleanup and all three greeting write entry points');
}
