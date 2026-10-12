import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  bindAppChatMenuToggle,
  bindAppSheetToggleButtons,
  bindChatTitleMenuActions,
  bindChatroomMenuActions,
  bindQuickMenuActions,
  bindSettingsMenuActions,
} from '../../src/scripts/ui/app-menu-binding-runtime-utils.js';
import {
  bindDeveloperProfilePanel,
  openDeveloperExternalUrl,
} from '../../src/scripts/ui/developer-profile-panel.js';

const appSource = fs.readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');

const createButton = (action = '') => {
  const listeners = {};
  return {
    dataset: { action },
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
    trigger(type = 'click', event = {}) {
      listeners[type]?.({
        currentTarget: this,
        target: this,
        stopPropagation() {},
        ...event,
      });
    },
  };
};

const createMenu = (buttons = []) => ({
  querySelectorAll(selector) {
    return selector === 'button' ? buttons : [];
  },
  classList: {
    toggled: [],
    added: [],
    toggle(token) {
      this.toggled.push(token);
    },
    add(token) {
      this.added.push(token);
    },
  },
});

{
  const html = fs.readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8');
  const rpMenuMarkup = html.match(/<div id="rp-chatroom-menu"[\s\S]*?<\/div>\s*<!-- Chat title menu/)?.[0] || '';
  assert.match(rpMenuMarkup, /data-action="preset"[^>]*>🎛 预设<\/button>/);
  assert.match(rpMenuMarkup, /data-action="extensions"[^>]*>🧩 扩展<\/button>/);
  assert.match(rpMenuMarkup, /data-action="settings"[^>]*>⚙ 设定<\/button>/);
  assert.match(rpMenuMarkup, /data-action="config"[^>]*>🔌 API设定<\/button>/);
  console.log('ok - creative writing room menu exposes preset extensions general and API settings entries');
}

{
  const html = fs.readFileSync(new URL('../../src/index.html', import.meta.url), 'utf8');
  const developerProfileCss = fs.readFileSync(new URL('../../src/assets/css/developer-profile.css', import.meta.url), 'utf8');
  assert.match(html, /class="desktop-rail-wordmark"[^>]*data-open-developer-profile/);
  assert.match(html, /data-action="about-aria"[^>]*data-open-developer-profile/);
  assert.match(html, /data-developer-external-url[^>]*href="https:\/\/github\.com\/dghiffjd7\/OmniTavern"/);
  assert.match(html, /data-developer-external-url[^>]*href="https:\/\/ko-fi\.com\/illusion7"/);
  assert.match(developerProfileCss, /@media \(max-width: 620px\)[\s\S]*?\.developer-profile-overlay\s*\{[\s\S]*?align-items:\s*center;/);
  console.log('ok - developer profile entry is available from desktop brand and mobile settings');
}

{
  const invocations = [];
  assert.equal(await openDeveloperExternalUrl('https://github.com/dghiffjd7/OmniTavern', {
    invoke: async (...args) => invocations.push(args),
  }), true);
  assert.deepEqual(invocations, [[
    'open_external_url',
    { url: 'https://github.com/dghiffjd7/OmniTavern' },
  ]]);
  assert.equal(await openDeveloperExternalUrl('https://example.com/not-allowed', {
    invoke: async () => { throw new Error('must not invoke'); },
  }), false);
  console.log('ok - developer links use the allowlisted native external-browser command');
}

{
  const createClassList = () => ({
    values: new Set(),
    add(token) { this.values.add(token); },
    remove(token) { this.values.delete(token); },
    contains(token) { return this.values.has(token); },
  });
  const createEventTarget = () => {
    const listeners = {};
    return {
      hidden: true,
      classList: createClassList(),
      focused: false,
      addEventListener(type, handler) { listeners[type] = handler; },
      trigger(type, event = {}) { listeners[type]?.({ target: this, currentTarget: this, preventDefault() {}, ...event }); },
      focus() { this.focused = true; },
    };
  };
  const overlay = createEventTarget();
  const closeButton = createEventTarget();
  const trigger = createEventTarget();
  const externalLink = Object.assign(createEventTarget(), {
    href: 'https://github.com/dghiffjd7/OmniTavern',
  });
  const openedUrls = [];
  let linkDefaultPrevented = false;
  const body = { classList: createClassList() };
  const documentListeners = {};
  const documentRef = {
    body,
    activeElement: trigger,
    getElementById(id) { return id === 'developer-profile-overlay' ? overlay : null; },
    querySelectorAll(selector) {
      if (selector === '[data-open-developer-profile]') return [trigger];
      if (selector === '[data-developer-external-url]') return [externalLink];
      return [];
    },
    querySelector(selector) { return selector === '#developer-profile-overlay [data-developer-profile-close]' ? closeButton : null; },
    addEventListener(type, handler) { documentListeners[type] = handler; },
  };
  const panel = bindDeveloperProfilePanel({
    documentRef,
    openExternalUrl: async (url) => openedUrls.push(url),
  });
  trigger.trigger('click');
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.classList.contains('is-open'), true);
  assert.equal(body.classList.contains('developer-profile-open'), true);
  assert.equal(closeButton.focused, true);
  documentListeners.keydown?.({ key: 'Escape' });
  assert.equal(overlay.hidden, true);
  assert.equal(body.classList.contains('developer-profile-open'), false);
  assert.equal(panel.isOpen(), false);
  externalLink.trigger('click', {
    preventDefault() { linkDefaultPrevented = true; },
  });
  await Promise.resolve();
  assert.equal(linkDefaultPrevented, true);
  assert.deepEqual(openedUrls, ['https://github.com/dghiffjd7/OmniTavern']);
  console.log('ok - developer profile panel opens from shared entries and closes with Escape');
}

{
  const calls = [];
  const avatarBtn = createButton();
  const settingsBtn = createButton();
  const plusBtn = createButton();
  const momentsBtn = createButton();
  bindAppSheetToggleButtons({
    avatarBtns: [avatarBtn],
    settingsBtns: [settingsBtn],
    plusBtns: [plusBtn],
    momentsSettingsBtn: momentsBtn,
    renderPersonaSwitcher: () => calls.push(['render-persona']),
    toggleSheetAt: (...args) => calls.push(['toggle', ...args]),
    personaSwitcherMenu: 'persona-menu',
    settingsMenu: 'settings-menu',
    quickMenu: 'quick-menu',
    momentsMenu: 'moments-menu',
    onBeforeOpenMomentsMenu: () => calls.push(['sync-moments-menu']),
  });
  avatarBtn.trigger();
  settingsBtn.trigger();
  plusBtn.trigger();
  momentsBtn.trigger();

  assert.deepEqual(calls, [
    ['render-persona'],
    ['toggle', 'persona-menu', avatarBtn, { kind: 'persona' }],
    ['toggle', 'settings-menu', settingsBtn, { alignRight: true, kind: 'settings' }],
    ['toggle', 'quick-menu', plusBtn, { alignRight: true, kind: 'quick' }],
    ['sync-moments-menu'],
    ['toggle', 'moments-menu', momentsBtn, { alignRight: true, kind: 'moments' }],
  ]);
  console.log('ok - bindAppSheetToggleButtons wires avatar settings quick and moments sheet toggles');
}

{
  const calls = [];
  const menu = createMenu();
  const settingsMenu = createMenu();
  const quickMenu = createMenu();
  const chatMenuBtn = createButton();
  const quickMenuHideCalls = [];
  bindAppChatMenuToggle({
    chatMenuBtn,
    getActiveMenu: () => menu,
    positionSheet: (...args) => calls.push(['position', ...args]),
    settingsMenu,
    quickMenu,
    hideQuickMenu: () => quickMenuHideCalls.push('hide'),
  });
  chatMenuBtn.trigger();
  assert.deepEqual(calls, [['position', menu, chatMenuBtn, 0, 4, true]]);
  assert.deepEqual(menu.classList.toggled, ['hidden']);
  assert.deepEqual(settingsMenu.classList.added, ['hidden']);
  assert.deepEqual(quickMenu.classList.added, []);
  assert.deepEqual(quickMenuHideCalls, ['hide']);
  console.log('ok - bindAppChatMenuToggle positions active menu and hides sibling menus');
}

{
  const calls = [];
  const settingsMenu = createMenu([
    createButton('settings'),
    createButton('preset'),
    createButton('agent-center'),
    createButton('world-global'),
    createButton('extensions'),
    createButton('config'),
    createButton('session-config'),
    createButton('lineage-overview'),
  ]);
  bindSettingsMenuActions({
    settingsMenu,
    openSettings: () => calls.push('settings'),
    openPreset: () => calls.push('preset'),
    openAgentCenter: () => calls.push('agent-center'),
    openWorldGlobal: () => calls.push('world'),
    openExtensions: () => calls.push('extensions'),
    openConfig: () => calls.push('config'),
    openSessionConfig: () => calls.push('session-config'),
    openLineageOverview: () => calls.push('lineage-overview'),
    hideMenus: () => calls.push('hide'),
  });
  settingsMenu.querySelectorAll('button').forEach((button) => button.trigger());
  assert.deepEqual(calls, [
    'settings', 'hide',
    'preset', 'hide',
    'agent-center', 'hide',
    'world', 'hide',
    'extensions', 'hide',
    'config', 'hide',
    'session-config', 'hide',
    'lineage-overview', 'hide',
  ]);
  console.log('ok - bindSettingsMenuActions dispatches settings menu actions then hides menus');
}

{
  const calls = [];
  const quickMenu = createMenu([
    createButton('add-friend'),
    createButton('create-group'),
    createButton('new-group'),
  ]);
  bindQuickMenuActions({
    quickMenu,
    openAddFriend: () => calls.push('friend'),
    openCreateGroup: () => calls.push('create-group'),
    openNewGroup: () => calls.push('new-group'),
    hideMenus: () => calls.push('hide'),
  });
  quickMenu.querySelectorAll('button').forEach((button) => button.trigger());
  assert.deepEqual(calls, [
    'friend', 'hide',
    'create-group', 'hide',
    'new-group', 'hide',
  ]);
  console.log('ok - bindQuickMenuActions dispatches quick menu actions then hides menus');
}

{
  const quickMenuBindingCalls = appSource.match(/\bbindQuickMenuActions\s*\(/g) || [];
  assert.equal(quickMenuBindingCalls.length, 1);
  assert.doesNotMatch(appSource, /quickMenu\?\.querySelectorAll\('button'\)\.forEach/);
  console.log('ok - app assembly binds quick-menu actions exactly once through the runtime util');
}

{
  const calls = [];
  const menu = createMenu([
    createButton('world'),
    createButton('regex'),
    createButton('vars'),
    createButton('generate-image'),
    createButton('writing-assets'),
    createButton('chat-settings'),
    createButton('prompt-preview'),
    createButton('raw-reply'),
    createButton('preset'),
    createButton('extensions'),
    createButton('settings'),
    createButton('config'),
  ]);
  bindChatroomMenuActions({
    menuEl: menu,
    openWorld: () => calls.push('world'),
    openRegex: () => calls.push('regex'),
    openVars: () => calls.push('vars'),
    openGenerateImage: () => calls.push('generate-image'),
    openWritingAssets: () => calls.push('writing-assets'),
    openChatSettings: () => calls.push('chat-settings'),
    openPromptPreview: () => calls.push('prompt-preview'),
    openRawReply: () => calls.push('raw-reply'),
    openPreset: () => calls.push('preset'),
    openExtensions: () => calls.push('extensions'),
    openSettings: () => calls.push('settings'),
    openConfig: () => calls.push('config'),
    hideMenus: () => calls.push('hide'),
  });
  menu.querySelectorAll('button').forEach((button) => button.trigger());
  assert.deepEqual(calls, [
    'world', 'hide',
    'regex', 'hide',
    'vars', 'hide',
    'generate-image', 'hide',
    'writing-assets', 'hide',
    'chat-settings', 'hide',
    'prompt-preview', 'hide',
    'raw-reply', 'hide',
    'preset', 'hide',
    'extensions', 'hide',
    'settings', 'hide',
    'config', 'hide',
  ]);
  console.log('ok - bindChatroomMenuActions dispatches chatroom menu actions then hides menus');
}

{
  const calls = [];
  const menu = createMenu([createButton('reading-settings')]);
  bindChatroomMenuActions({
    menuEl: menu,
    openReadingSettings: () => calls.push('reading-settings'),
    hideMenus: () => calls.push('hide'),
  });
  menu.querySelectorAll('button').forEach((button) => button.trigger());
  assert.deepEqual(calls, ['reading-settings'], 'reading-settings opens its anchored sheet without the trailing hideMenus');
  console.log('ok - bindChatroomMenuActions lets reading-settings manage menu visibility itself');
}

{
  const calls = [];
  const currentChatTitle = createButton();
  const currentChatAvatarButton = createButton();
  const chatTitleMenu = createMenu([
    createButton('contact-settings'),
    createButton('session-config'),
  ]);
  const originalDocument = globalThis.document;
  globalThis.document = {
    getElementById(id) {
      if (id !== 'group-management-dropdown') return null;
      return { style: { display: 'none' } };
    },
  };
  bindChatTitleMenuActions({
    currentChatTitle,
    currentChatAvatarButton,
    chatTitleMenu,
    getCurrentSessionMeta: () => ({ sessionId: 'group:1', isGroup: true }),
    hideMenus: () => calls.push('hide'),
    renderGroupDropdown: (...args) => calls.push(['group', ...args]),
    toggleTitleMenu: () => calls.push('toggle'),
    openContactSettings: () => calls.push('contact-settings'),
    openSessionConfig: () => calls.push('session-config'),
  });
  currentChatAvatarButton.trigger();
  chatTitleMenu.querySelectorAll('button').forEach((button) => button.trigger());
  globalThis.document = originalDocument;
  assert.deepEqual(calls, [
    'hide',
    ['group', 'group:1', currentChatAvatarButton],
    'contact-settings', 'hide',
    'session-config', 'hide',
  ]);
  console.log('ok - bindChatTitleMenuActions routes title/avatar clicks and title-menu actions');
}

{
  const calls = [];
  const currentChatTitle = createButton();
  const currentChatAvatarButton = createButton();
  bindChatTitleMenuActions({
    currentChatTitle,
    currentChatAvatarButton,
    chatTitleMenu: createMenu(),
    getCurrentSessionMeta: () => ({ sessionId: 'rp:hero', isGroup: false }),
    toggleTitleMenu: () => calls.push('title-menu'),
    onAvatarClick: event => {
      calls.push(['persona-menu', event.currentTarget]);
      return true;
    },
  });
  currentChatTitle.trigger();
  currentChatAvatarButton.trigger();
  assert.deepEqual(calls, [
    'title-menu',
    ['persona-menu', currentChatAvatarButton],
  ]);
  console.log('ok - bindChatTitleMenuActions lets creative avatar open the persona selector without changing title behavior');
}
