import { isRpSessionId } from '../memory/memory-context-utils.js';
import { normalizeBadgeList } from '../utils/name-badges.js';
import { translateUiText } from '../i18n/index.js';

export const runContactSettingsPopulateFlow = ({
  sessionId = '',
  contactsStore = null,
  chatStore = null,
  panel = null,
  avatarPreview = null,
  nameInput = null,
  labelsInput = null,
  voiceSelect = null,
  voiceSection = null,
  templateToggle = null,
  scriptToggle = null,
  rpBridgeSection = null,
  memoryShareSection = null,
  memoryShareSummary = null,
  exportExperiencePackBtn = null,
  onExportExperiencePack = null,
  globalSettings = {},
  setCurrentAvatar = () => {},
  getRpDisplayName = () => '',
  refreshMemoryShareSummary = () => Promise.resolve(),
  resolveAvatar = ({ avatar, name }) => avatar || name || '',
  defaultAvatar = '',
  logger = console,
} = {}) => {
  const contact = contactsStore?.getContact?.(sessionId) || { id: sessionId, name: sessionId, avatar: '' };
  const isRpSession = isRpSessionId(sessionId);
  const isGroupSession = contact?.isGroup === true || String(sessionId || '').startsWith('group:');
  const rpDisplayName = isRpSession ? getRpDisplayName(sessionId) : '';

  contactsStore?.upsertContact?.(contact);

  const savedName = String(contact?.name || '').trim();
  const displayName = isRpSession
    ? (savedName && !savedName.startsWith('rp:') ? savedName : (rpDisplayName || savedName || sessionId))
    : (savedName || sessionId);

  const title = panel?.querySelector?.('#contact-settings-title');
  if (title) {
    title.textContent = isRpSession ? '设置' : '好友设置';
    title.setAttribute?.('data-help', String(sessionId || ''));
  }
  const sub = panel?.querySelector?.('#contact-settings-sub');
  if (sub) {
    sub.setAttribute?.('data-i18n-skip', '');
    const modeLabel = isRpSession ? '创意写作' : (isGroupSession ? '群聊' : '私聊');
    sub.textContent = `${displayName} · ${translateUiText(modeLabel)}`;
  }

  const currentAvatar = contact.avatar || '';
  setCurrentAvatar(currentAvatar);

  if (avatarPreview) {
    const savedName = String(contact?.name || '').trim();
    const nameForAvatar = isRpSession
      ? (rpDisplayName || (savedName && !savedName.startsWith('rp:') ? savedName : '') || sessionId || '角色')
      : (savedName || sessionId || '好友');
    const tags = Array.isArray(contact?.libraryTags) && contact.libraryTags.length
      ? contact.libraryTags
      : Array.isArray(contact?.labels)
        ? contact.labels
        : [];
    avatarPreview.src = resolveAvatar({
      avatar: currentAvatar || defaultAvatar,
      name: nameForAvatar,
      tags,
      size: 96,
    });
  }

  if (nameInput) nameInput.value = displayName;

  if (labelsInput) {
    const labels = Array.isArray(contact?.labels) ? contact.labels : [];
    labelsInput.value = labels.join(', ');
  }
  if (voiceSelect) voiceSelect.value = String(contact?.voiceRef || '').trim();
  if (voiceSection) voiceSection.style.display = (isRpSession || isGroupSession) ? 'none' : 'block';

  const sessionSettings = chatStore?.getSessionSettings?.(sessionId) || {};
  if (templateToggle) {
    templateToggle.checked = (typeof sessionSettings.templateEnabled === 'boolean')
      ? sessionSettings.templateEnabled
      : (globalSettings.templateEnabled !== false);
  }
  if (scriptToggle) {
    scriptToggle.checked = (typeof sessionSettings.scriptEnabled === 'boolean')
      ? sessionSettings.scriptEnabled
      : (globalSettings.scriptEnabled === true);
  }

  if (rpBridgeSection) rpBridgeSection.style.display = 'none';
  if (memoryShareSection) memoryShareSection.style.display = 'block';

  if (exportExperiencePackBtn) {
    const isGroup = contact?.isGroup === true;
    const canExport = !isRpSession && !isGroup && typeof onExportExperiencePack === 'function';
    exportExperiencePackBtn.style.display = canExport ? 'flex' : 'none';
    exportExperiencePackBtn.disabled = !canExport;
  }

  Promise.resolve(refreshMemoryShareSummary(sessionId)).catch((error) => {
    logger?.warn?.('refresh memory share summary failed', error);
    if (memoryShareSummary) memoryShareSummary.textContent = '记忆共享状态读取失败';
  });

  return {
    contact,
    currentAvatar,
    isRpSession,
    rpDisplayName,
  };
};

export const runContactSettingsSaveFlow = ({
  sessionId = '',
  contactsStore = null,
  chatStore = null,
  nameInput = null,
  labelsInput = null,
  voiceSelect = null,
  currentAvatar = '',
  templateToggle = null,
  scriptToggle = null,
  onSaved = null,
  hide = () => {},
  notifySuccess = () => {},
  notifyError = () => {},
  logger = console,
} = {}) => {
  try {
    const prev = contactsStore?.getContact?.(sessionId) || { id: sessionId };
    const name = String(nameInput?.value || '').trim() || prev.name || sessionId;
    const avatar = String(currentAvatar || '');
    const rawLabels = String(labelsInput?.value || '');
    const labels = normalizeBadgeList(
      rawLabels
        .split(/[,，\n\r]/)
        .map((item) => item.trim())
        .filter(Boolean),
      { max: 8 },
    );
    const voiceRef = String(voiceSelect?.value || '').trim();

    const sessionSettings = chatStore?.getSessionSettings?.(sessionId) || {};
    if (templateToggle) sessionSettings.templateEnabled = Boolean(templateToggle.checked);
    if (scriptToggle) sessionSettings.scriptEnabled = Boolean(scriptToggle.checked);
    chatStore?.setSessionSettings?.(sessionId, sessionSettings);
    contactsStore?.upsertContact?.({ ...prev, id: sessionId, name, avatar, labels, voiceRef });

    notifySuccess(isRpSessionId(sessionId) ? '已保存设置' : '已保存好友设置');
    onSaved?.({ id: sessionId, name, avatar, labels, voiceRef });
    hide?.();
    return { sessionId, name, avatar, labels, voiceRef, sessionSettings };
  } catch (error) {
    logger?.error?.('保存好友设置失败', error);
    notifyError(error?.message || '保存失败');
    return false;
  }
};
