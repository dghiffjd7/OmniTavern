import {
  VERTEX_AUTH_MODE_EXPRESS,
  normalizeVertexAuthMode,
} from '../api/vertexai-config-utils.js';

const trim = value => String(value || '').trim();

export const createMaidOnboardingAppAdapter = ({
  documentRef = globalThis?.document || null,
  targetSelectors = {},
  isElementVisible = element => Boolean(element),
  delay = async () => {},
  openSettingsMenu = null,
  openChatroomMenu = null,
  revealSettingsEntry = null,
  openGeneralSettings = null,
  openApiConfig = null,
  openQuickMenu = null,
  openAddFriend = null,
  closeMenus = null,
  closeGeneralSettings = null,
  closeApiConfig = null,
  closeAddFriend = null,
  cancelAddFriendConfirm = null,
  closeContactDetail = null,
  isChatRoomVisible = () => false,
  exitChatRoom = null,
  switchPage = null,
  openMaidCommand = null,
  closeMaidCommand = null,
  openAgentCenter = null,
  closeAgentCenter = null,
  openAgentCenterDetail = null,
  closeAgentCenterDetail = null,
  emit = null,
  configManager = null,
} = {}) => {
  const resolveTarget = (targetKey = '') => {
    const selectors = targetSelectors?.[trim(targetKey)] || [];
    for (const selector of selectors) {
      try {
        for (const element of documentRef?.querySelectorAll?.(selector) || []) {
          if (isElementVisible(element)) return element;
        }
      } catch {}
    }
    return null;
  };

  // 列表顶栏的设置菜单打不开时：写作房间改开房间右上角菜单；手机聊天室先退回列表再打开
  const openSettingsMenuInPlace = async () => {
    let opened = await openSettingsMenu?.();
    if (opened === false && typeof openChatroomMenu === 'function') opened = await openChatroomMenu();
    if (opened === false && await revealSettingsEntry?.()) opened = await openSettingsMenu?.();
    return opened;
  };

  const preparePreviousStep = async (target = '') => {
    if (target === 'settings-entry') {
      await closeApiConfig?.();
      await closeMenus?.();
      return false;
    }
    if (target === 'settings-api-config') {
      await closeApiConfig?.();
      return false;
    }
    if (target === 'settings-general') {
      await closeGeneralSettings?.();
      return false;
    }
    if (target === 'general-ui-advanced') {
      await openGeneralSettings?.({ revealRichIframeScripts: false });
      return true;
    }
    if (target === 'general-rich-iframe-scripts') {
      await openGeneralSettings?.({ revealRichIframeScripts: true });
      return true;
    }
    if (target === 'top-plus-entry') {
      await cancelAddFriendConfirm?.();
      await closeAddFriend?.();
      await delay(260);
      await closeMenus?.();
      return false;
    }
    if (target === 'quick-add-friend') {
      await cancelAddFriendConfirm?.();
      await closeAddFriend?.();
      await delay(260);
      return false;
    }
    if (target === 'add-friend-recommendation') {
      await cancelAddFriendConfirm?.();
      await delay(220);
      return true;
    }
    if (target === 'maid-ball') {
      await closeAgentCenter?.();
      await closeMaidCommand?.();
      await closeMenus?.();
      return false;
    }
    if (target === 'maid-command-input') {
      await closeAgentCenter?.();
      await closeMenus?.();
      return false;
    }
    if (target === 'agent-center-entry') {
      await closeAgentCenter?.();
      return false;
    }
    if (target === 'agent-center-card') {
      await closeAgentCenterDetail?.();
      return false;
    }
    if (target === 'agent-center-detail-close') {
      await openAgentCenter?.();
      await openAgentCenterDetail?.();
      return true;
    }
    return false;
  };

  const prepareStep = async ({ flow = null, step = null, meta = null } = {}) => {
    const target = trim(step?.target);
    const isPrevious = trim(meta?.reason) === 'prev';
    if (isPrevious && await preparePreviousStep(target)) return;
    if (!isPrevious) await delay(0);
    if (target === 'settings-api-config' && !resolveTarget(target)) {
      await openSettingsMenuInPlace();
      return;
    }
    if (target === 'settings-general' && !resolveTarget(target)) {
      await openSettingsMenuInPlace();
      return;
    }
    if (target === 'settings-entry') {
      if (trim(flow?.id) !== 'rich-script-permission') {
        if (isChatRoomVisible?.()) await exitChatRoom?.({ animate: false, source: 'maid-onboarding' });
        await switchPage?.('chat', { animate: false });
      } else {
        // 情境引导留在原房间；只有手机聊天室盖住列表、聊天室菜单又没有「设定」时才退回列表
        await revealSettingsEntry?.();
      }
      return;
    }
    if (target === 'general-ui-advanced' && !resolveTarget(target)) {
      await closeMenus?.();
      await openGeneralSettings?.({ revealRichIframeScripts: false });
      return;
    }
    if (target === 'general-rich-iframe-scripts' && !resolveTarget(target)) {
      await closeMenus?.();
      await openGeneralSettings?.({ revealRichIframeScripts: true });
      return;
    }
    if (target.startsWith('config-') && !resolveTarget(target)) {
      await openApiConfig?.({ reason: 'guide' });
      return;
    }
    if (target === 'quick-add-friend' && !resolveTarget(target)) {
      await openQuickMenu?.();
      return;
    }
    if ((target === 'add-friend-search-input' || target === 'add-friend-recommendation') && !resolveTarget(target)) {
      const panel = await openAddFriend?.();
      if (target === 'add-friend-recommendation') panel?.nameInput?.focus?.();
      return;
    }
    if (target === 'contact-list-entry') {
      if (isChatRoomVisible?.()) await exitChatRoom?.({ animate: false, source: 'maid-onboarding' });
      await closeContactDetail?.();
      await switchPage?.('contacts', { animate: false });
      return;
    }
    if (target === 'contact-detail-message' && !resolveTarget(target)) {
      if (isChatRoomVisible?.()) await exitChatRoom?.({ animate: false, source: 'maid-onboarding' });
      await switchPage?.('contacts', { animate: false });
      return;
    }
    if (target === 'agent-center-entry') {
      await closeMaidCommand?.();
      if (resolveTarget('settings-agent-center')) return;
      await openSettingsMenu?.();
      if (resolveTarget('settings-agent-center') || resolveTarget(target)) return;
      await switchPage?.('moments', { animate: false });
      return;
    }
    if (target === 'maid-command-settings' && !resolveTarget(target)) {
      await openMaidCommand?.();
      return;
    }
    if (target === 'agent-center-detail-close' && !resolveTarget(target)) {
      await openAgentCenter?.();
      await openAgentCenterDetail?.();
      return;
    }
    if ((target === 'agent-center-card' || target === 'agent-center-close') && !resolveTarget(target)) {
      await openAgentCenter?.();
    }
  };

  const runClickFallback = async (action, target) => {
    if (typeof action !== 'function') return false;
    const result = await action();
    if (result === false) return false;
    emit?.('target-click', { target });
    return true;
  };

  const runFallback = async ({ step = null } = {}) => {
    const kind = trim(step?.fallback?.kind);
    if (kind === 'open-settings-menu') {
      return runClickFallback(openSettingsMenuInPlace, 'settings-entry');
    }
    if (kind === 'open-api-config') {
      if (typeof openApiConfig !== 'function') return false;
      return runClickFallback(() => openApiConfig?.({ reason: 'guide' }), 'settings-api-config');
    }
    if (kind === 'open-general-settings') {
      return runClickFallback(
        () => openGeneralSettings?.({ revealRichIframeScripts: false }),
        'settings-general',
      );
    }
    if (kind === 'open-quick-menu') {
      return runClickFallback(openQuickMenu, 'top-plus-entry');
    }
    if (kind === 'open-add-friend') {
      return runClickFallback(openAddFriend, 'quick-add-friend');
    }
    if (kind === 'open-maid-command') return openMaidCommand?.();
    if (kind === 'open-agent-center') {
      await closeMaidCommand?.();
      await openAgentCenter?.();
      emit?.('agent-center-opened', {});
      return true;
    }
    if (kind === 'close-agent-center') {
      await closeAgentCenter?.();
      emit?.('agent-center-closed', {});
      return true;
    }
    const target = resolveTarget(step?.fallback?.target || step?.target);
    if (kind === 'focus-target') {
      target?.focus?.();
      return Boolean(target);
    }
    if (kind === 'click-target') {
      target?.click?.();
      return Boolean(target);
    }
    return false;
  };

  const hasConfiguredProfile = () => (configManager?.getProfiles?.() || []).some((profile) => {
    if (!trim(profile?.model)) return false;
    const hasSavedKey = Boolean(trim(profile?.activeKeyId)) ||
      (configManager?.listKeys?.(profile?.id) || []).length > 0;
    const hasServiceAccount = Boolean(trim(
      profile?.vertexaiServiceAccount || profile?.serviceAccount || profile?.serviceAccountJson,
    )) || configManager?.hasVertexServiceAccount?.(profile?.id) === true;
    if (trim(profile?.provider).toLowerCase() !== 'vertexai') return hasSavedKey;
    const authMode = normalizeVertexAuthMode(profile?.vertexaiAuthMode, {
      ...profile,
      apiKey: hasSavedKey ? 'saved-key' : '',
      vertexaiServiceAccount: hasServiceAccount ? 'saved-service-account' : '',
    });
    return authMode === VERTEX_AUTH_MODE_EXPRESS ? hasSavedKey : hasServiceAccount;
  });

  return {
    hasConfiguredProfile,
    prepareStep,
    resolveTarget,
    runFallback,
  };
};
