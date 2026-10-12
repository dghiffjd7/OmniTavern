const bindClick = (elements, handler) => {
  (elements || []).forEach((element) => {
    element?.addEventListener?.('click', handler);
  });
};

export const bindAppSheetToggleButtons = ({
  avatarBtns = [],
  settingsBtns = [],
  plusBtns = [],
  momentsSettingsBtn = null,
  renderPersonaSwitcher = () => {},
  toggleSheetAt = () => {},
  personaSwitcherMenu = null,
  settingsMenu = null,
  quickMenu = null,
  momentsMenu = null,
  onBeforeOpenMomentsMenu = () => {},
} = {}) => {
  bindClick(avatarBtns, (event) => {
    event.stopPropagation?.();
    renderPersonaSwitcher();
    toggleSheetAt(personaSwitcherMenu, event.currentTarget || event.target, { kind: 'persona' });
  });

  bindClick(settingsBtns, (event) => {
    event.stopPropagation?.();
    toggleSheetAt(settingsMenu, event.currentTarget || event.target, { alignRight: true, kind: 'settings' });
  });

  bindClick(plusBtns, (event) => {
    event.stopPropagation?.();
    toggleSheetAt(quickMenu, event.currentTarget || event.target, { alignRight: true, kind: 'quick' });
  });

  momentsSettingsBtn?.addEventListener?.('click', (event) => {
    event.stopPropagation?.();
    onBeforeOpenMomentsMenu();
    toggleSheetAt(momentsMenu, momentsSettingsBtn, { alignRight: true, kind: 'moments' });
  });
};

export const bindAppChatMenuToggle = ({
  chatMenuBtn = null,
  getActiveMenu = () => null,
  positionSheet = () => {},
  settingsMenu = null,
  quickMenu = null,
  hideQuickMenu = null,
} = {}) => {
  chatMenuBtn?.addEventListener?.('click', (event) => {
    event.stopPropagation?.();
    const menu = getActiveMenu();
    if (!menu) return;
    positionSheet(menu, chatMenuBtn, 0, 4, true);
    menu.classList.toggle('hidden');
    settingsMenu?.classList.add?.('hidden');
    if (typeof hideQuickMenu === 'function') hideQuickMenu();
    else quickMenu?.classList.add?.('hidden');
  });
};

export const bindSettingsMenuActions = ({
  settingsMenu = null,
  openSettings = () => {},
  openPreset = () => {},
  openAgentCenter = () => {},
  openWorldGlobal = () => {},
  openExtensions = () => {},
  openConfig = () => {},
  openSessionConfig = () => {},
  openLineageOverview = () => {},
  hideMenus = () => {},
} = {}) => {
  settingsMenu?.querySelectorAll?.('button').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset?.action;
      if (action === 'settings') openSettings();
      if (action === 'preset') openPreset();
      if (action === 'agent-center') openAgentCenter();
      if (action === 'world-global') openWorldGlobal();
      if (action === 'extensions') openExtensions();
      if (action === 'config') openConfig();
      if (action === 'session-config') openSessionConfig();
      if (action === 'lineage-overview') openLineageOverview();
      hideMenus();
    });
  });
};

export const bindQuickMenuActions = ({
  quickMenu = null,
  openAddFriend = () => {},
  openCreateGroup = () => {},
  openNewGroup = () => {},
  hideMenus = () => {},
} = {}) => {
  quickMenu?.querySelectorAll?.('button').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset?.action;
      if (action === 'add-friend') openAddFriend();
      if (action === 'create-group') openCreateGroup();
      if (action === 'new-group') openNewGroup();
      hideMenus();
    });
  });
};

export const bindChatroomMenuActions = ({
  menuEl = null,
  openWorld = () => {},
  openRegex = () => {},
  openVars = () => {},
  openGenerateImage = () => {},
  openWritingAssets = () => {},
  openChatSettings = () => {},
  openReadingSettings = () => {},
  openPromptPreview = () => {},
  openRawReply = () => {},
  openPreset = () => {},
  openExtensions = () => {},
  openSettings = () => {},
  openConfig = () => {},
  hideMenus = () => {},
} = {}) => {
  menuEl?.querySelectorAll?.('button').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset?.action;
      if (action === 'reading-settings') {
        // 阅读设置打开的是锚定浮层，自己会先收起其他菜单；这里不能再走尾部 hideMenus，否则刚打开就被关闭。
        openReadingSettings();
        return;
      }
      if (action === 'world') openWorld();
      if (action === 'regex') openRegex();
      if (action === 'vars') openVars();
      if (action === 'generate-image') openGenerateImage();
      if (action === 'writing-assets') openWritingAssets();
      if (action === 'chat-settings') openChatSettings();
      if (action === 'prompt-preview') openPromptPreview();
      if (action === 'raw-reply') openRawReply();
      if (action === 'preset') openPreset();
      if (action === 'extensions') openExtensions();
      if (action === 'settings') openSettings();
      if (action === 'config') openConfig();
      hideMenus();
    });
  });
};

export const bindChatTitleMenuActions = ({
  currentChatTitle = null,
  currentChatAvatarButton = null,
  chatTitleMenu = null,
  getCurrentSessionMeta = () => ({ sessionId: '', contact: null, isGroup: false }),
  hideMenus = () => {},
  renderGroupDropdown = () => {},
  toggleTitleMenu = () => {},
  onAvatarClick = null,
  openContactSettings = () => {},
  openSessionConfig = () => {},
} = {}) => {
  const handleIdentityClick = (event) => {
    event.stopPropagation?.();
    const { sessionId, isGroup } = getCurrentSessionMeta() || {};
    if (isGroup) {
      const dropdown = globalThis.document?.getElementById?.('group-management-dropdown');
      const showing = dropdown && dropdown.style.display !== 'none';
      hideMenus();
      if (!showing) renderGroupDropdown(sessionId, event.currentTarget || currentChatTitle);
      return;
    }
    toggleTitleMenu();
  };

  const handleAvatarClick = (event) => {
    if (typeof onAvatarClick === 'function' && onAvatarClick(event) === true) return;
    handleIdentityClick(event);
  };

  currentChatTitle?.addEventListener?.('click', handleIdentityClick);
  currentChatAvatarButton?.addEventListener?.('click', handleAvatarClick);

  chatTitleMenu?.querySelectorAll?.('button').forEach((button) => {
    button.addEventListener('click', () => {
      const action = button.dataset?.action;
      if (action === 'contact-settings') openContactSettings();
      if (action === 'session-config') openSessionConfig();
      hideMenus();
    });
  });
};
