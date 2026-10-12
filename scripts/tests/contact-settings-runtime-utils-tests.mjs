import assert from 'node:assert/strict';

import {
  runContactSettingsPopulateFlow,
  runContactSettingsSaveFlow,
} from '../../src/scripts/ui/contact-settings-runtime-utils.js';

{
  const titleAttrs = {};
  const title = { textContent: '', setAttribute: (key, value) => { titleAttrs[key] = value; } };
  const subtitle = { textContent: '' };
  const panel = {
    querySelector(selector) {
      return {
        '#contact-settings-title': title,
        '#contact-settings-sub': subtitle,
      }[selector] || null;
    },
  };
  const avatarPreview = {};
  const nameInput = {};
  const labelsInput = {};
  const voiceSelect = {};
  const voiceSection = { style: {} };
  const templateToggle = {};
  const scriptToggle = {};
  const rpBridgeSection = { style: {} };
  const memoryShareSection = { style: {} };
  const memoryShareSummary = { textContent: '' };
  const exportExperiencePackBtn = { style: {} };
  let currentAvatar = '';
  let refreshedSessionId = '';
  const upserts = [];

  const result = runContactSettingsPopulateFlow({
    sessionId: 'contact:1',
    contactsStore: {
      getContact: () => ({
        id: 'contact:1',
        name: '好友甲',
        avatar: 'avatar:1',
        labels: ['旧友', '测试'],
        voiceRef: 'voice-a',
      }),
      upsertContact: (payload) => upserts.push(payload),
    },
    chatStore: {
      getSessionSettings: () => ({
        templateEnabled: false,
      }),
    },
    panel,
    avatarPreview,
    nameInput,
    labelsInput,
    voiceSelect,
    voiceSection,
    templateToggle,
    scriptToggle,
    rpBridgeSection,
    memoryShareSection,
    memoryShareSummary,
    exportExperiencePackBtn,
    onExportExperiencePack: () => {},
    globalSettings: {
      templateEnabled: true,
      scriptEnabled: true,
    },
    setCurrentAvatar: (value) => {
      currentAvatar = value;
    },
    getRpDisplayName: () => '',
    refreshMemoryShareSummary: async (sessionId) => {
      refreshedSessionId = sessionId;
    },
    resolveAvatar: ({ avatar, name }) => `${avatar}:${name}`,
    defaultAvatar: 'default-avatar',
    logger: { warn() {} },
  });

  assert.equal(result.isRpSession, false);
  assert.equal(currentAvatar, 'avatar:1');
  assert.equal(title.textContent, '好友设置');
  assert.equal(subtitle.textContent, '好友甲 · 私聊');
  assert.equal(titleAttrs['data-help'], 'contact:1');
  assert.equal(nameInput.value, '好友甲');
  assert.equal(labelsInput.value, '旧友, 测试');
  assert.equal(voiceSelect.value, 'voice-a');
  assert.equal(voiceSection.style.display, 'block');
  assert.equal(templateToggle.checked, false);
  assert.equal(scriptToggle.checked, true);
  assert.equal(rpBridgeSection.style.display, 'none');
  assert.equal(memoryShareSection.style.display, 'block');
  assert.equal(exportExperiencePackBtn.style.display, 'flex');
  assert.equal(exportExperiencePackBtn.disabled, false);
  assert.equal(avatarPreview.src.includes('avatar:1') || avatarPreview.src.length > 0, true);
  assert.equal(refreshedSessionId, 'contact:1');
  assert.equal(upserts.length, 1);
  console.log('ok - runContactSettingsPopulateFlow fills contact fields toggles export button and refreshes memory-share summary');
}

{
  const titleAttrs = {};
  const title = { textContent: '', setAttribute: (key, value) => { titleAttrs[key] = value; } };
  const subtitle = { textContent: '' };
  const panel = {
    querySelector(selector) {
      return {
        '#contact-settings-title': title,
        '#contact-settings-sub': subtitle,
      }[selector] || null;
    },
  };
  const avatarPreview = {};
  const nameInput = {};
  const labelsInput = {};
  const voiceSection = { style: {} };
  const templateToggle = {};
  const scriptToggle = {};
  const rpBridgeSection = { style: {} };
  const memoryShareSection = { style: {} };
  const exportExperiencePackBtn = { style: {} };
  let currentAvatar = '';

  const result = runContactSettingsPopulateFlow({
    sessionId: 'rp:hero',
    contactsStore: {
      getContact: () => ({
        id: 'rp:hero',
        name: 'rp:hero',
        avatar: '',
      }),
      upsertContact() {},
    },
    chatStore: {
      getSessionSettings: () => ({
        scriptEnabled: false,
      }),
    },
    panel,
    avatarPreview,
    nameInput,
    labelsInput,
    voiceSection,
    templateToggle,
    scriptToggle,
    rpBridgeSection,
    memoryShareSection,
    exportExperiencePackBtn,
    onExportExperiencePack: () => {},
    globalSettings: {
      templateEnabled: true,
      scriptEnabled: true,
    },
    setCurrentAvatar: (value) => {
      currentAvatar = value;
    },
    getRpDisplayName: () => '角色甲',
    refreshMemoryShareSummary: async () => {},
    resolveAvatar: ({ avatar, name }) => `${avatar || 'fallback'}:${name}`,
    defaultAvatar: 'default-avatar',
    logger: { warn() {} },
  });

  assert.equal(result.isRpSession, true);
  assert.equal(currentAvatar, '');
  assert.equal(title.textContent, '设置');
  assert.equal(nameInput.value, '角色甲');
  assert.equal(subtitle.textContent, '角色甲 · 创意写作');
  assert.equal(titleAttrs['data-help'], 'rp:hero');
  assert.equal(voiceSection.style.display, 'none');
  assert.equal(exportExperiencePackBtn.style.display, 'none');
  assert.equal(exportExperiencePackBtn.disabled, true);
  console.log('ok - runContactSettingsPopulateFlow resolves rp session display and hides export action');
}

{
  const voiceSection = { style: {} };
  runContactSettingsPopulateFlow({
    sessionId: 'group:friends',
    contactsStore: {
      getContact: () => ({ id: 'group:friends', name: '朋友群', isGroup: true }),
      upsertContact() {},
    },
    chatStore: { getSessionSettings: () => ({}) },
    panel: { querySelector: () => null },
    voiceSection,
    setCurrentAvatar() {},
    refreshMemoryShareSummary: async () => {},
    logger: { warn() {} },
  });
  assert.equal(voiceSection.style.display, 'none');
  console.log('ok - group settings hide the unsupported group-level voice binding');
}

{
  const notifications = [];
  const saved = [];
  const upserts = [];
  let hidden = false;

  const result = runContactSettingsSaveFlow({
    sessionId: 'contact:2',
    contactsStore: {
      getContact: () => ({
        id: 'contact:2',
        name: '旧名',
        avatar: 'old',
      }),
      upsertContact: (payload) => upserts.push(payload),
    },
    chatStore: {
      getSessionSettings: () => ({ existing: true }),
      setSessionSettings: (...args) => saved.push(args),
    },
    nameInput: { value: '新名' },
    labelsInput: { value: ' 标签A,标签B , 标签A ' },
    voiceSelect: { value: 'voice-new' },
    currentAvatar: 'avatar:new',
    templateToggle: { checked: true },
    scriptToggle: { checked: false },
    onSaved: (payload) => notifications.push(['saved', payload]),
    hide: () => {
      hidden = true;
    },
    notifySuccess: (message) => notifications.push(['success', message]),
    notifyError: (message) => notifications.push(['error', message]),
    logger: {
      error() {},
    },
  });

  assert.equal(result.sessionId, 'contact:2');
  assert.equal(saved.length, 1);
  assert.equal(saved[0][1].templateEnabled, true);
  assert.equal(saved[0][1].scriptEnabled, false);
  assert.deepEqual(upserts[0], {
    id: 'contact:2',
    name: '新名',
    avatar: 'avatar:new',
    labels: ['标签A', '标签B'],
    voiceRef: 'voice-new',
  });
  assert.equal(hidden, true);
  assert.deepEqual(notifications, [
    ['success', '已保存好友设置'],
    ['saved', { id: 'contact:2', name: '新名', avatar: 'avatar:new', labels: ['标签A', '标签B'], voiceRef: 'voice-new' }],
  ]);
  console.log('ok - runContactSettingsSaveFlow persists labels avatar and session toggles then reports success');
}
