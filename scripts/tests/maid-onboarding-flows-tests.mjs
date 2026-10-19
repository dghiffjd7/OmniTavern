import assert from 'node:assert/strict';

import {
  createMaidExistingApiReviewFlow,
  MAID_ONBOARDING_TARGET_SELECTORS,
  ONBOARDING_TASKS,
  getMaidOnboardingFlow,
} from '../../src/scripts/ui/maid-onboarding-flows.js';

{
  const ids = ONBOARDING_TASKS.map(task => task.flowId);
  assert.deepEqual(ids, ['setup-api', 'add-friend', 'first-chat', 'meet-maid']);
  assert.equal(ONBOARDING_TASKS.find(task => task.flowId === 'first-chat')?.requires, 'setup-api');
  ids.forEach(id => assert.ok(getMaidOnboardingFlow(id)?.steps?.length > 1, `${id} should define a flow`));
  const richScript = getMaidOnboardingFlow('rich-script-permission');
  assert.deepEqual(
    richScript.steps.map(step => step.target || ''),
    ['', 'settings-entry', 'settings-general', 'general-ui-advanced', 'general-rich-iframe-scripts'],
  );
  assert.equal(richScript.steps.at(-1).canAdvance('rich-script-enabled', { enabled: true }), true);
  assert.equal(richScript.steps.at(-1).canAdvance('rich-script-enabled', { enabled: false }), false);
  assert.equal(ids.includes('rich-script-permission'), false, 'contextual security help must not become a first-run checklist task');
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['settings-general'].includes('#settings-menu button[data-action="settings"]'));
  // 写作房间没有列表顶栏的设置按钮：「设定」在房间右上角菜单里，点「≡」也算打开了设置菜单
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['settings-entry'].includes('body[data-ui-mode="rp"] #chat-menu-btn'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['settings-general'].includes('#rp-chatroom-menu button[data-action="settings"]'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['settings-api-config'].includes('#rp-chatroom-menu button[data-action="config"]'));
  assert.equal(richScript.steps[1].canAdvance('target-click', { target: 'chatroom-menu-entry' }), true);
  assert.equal(richScript.steps[1].canAdvance('target-click', { target: 'settings-entry' }), true);
  assert.equal(getMaidOnboardingFlow('setup-api').steps[1].canAdvance('target-click', { target: 'chatroom-menu-entry' }), false);
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['general-ui-advanced'].includes('#general-ui-advanced-toggle'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['general-rich-iframe-scripts'].includes('#general-rich-iframe-scripts'));
  console.log('ok - maid onboarding exports the four planned tasks and their dependency');
}

{
  const setup = getMaidOnboardingFlow('setup-api');
  assert.deepEqual(
    setup.steps.map(step => step.target || ''),
    [
      '',
      'settings-entry',
      'settings-api-config',
      'config-provider-select',
      'config-api-key-input',
      'config-model-section',
      'config-model-picker',
      'config-save-btn',
    ],
  );
  assert.equal(setup.steps.at(-1).target, 'config-save-btn');
  assert.equal(setup.steps.at(-1).canAdvance('config-profile-saved', { profileCount: 1 }), true);
  assert.equal(setup.steps.at(-1).canAdvance('config-profile-saved', { profileCount: 0 }), false);
  assert.equal(setup.steps.at(-1).canAdvance('config-draft-changed', { profileCount: 1 }), false);
  const providerStep = setup.steps.find(step => step.configRequirement === 'provider');
  assert.equal(providerStep.canAdvance('config-provider-confirmed', { provider: 'openai' }), true);
  assert.equal(providerStep.canAdvance('target-click', { target: 'config-provider-select' }), false);
  const credentialsStep = setup.steps.find(step => step.configRequirement === 'credentials');
  assert.deepEqual(credentialsStep.fallback, { kind: 'focus-target', target: 'config-api-key-input' });
  assert.equal(credentialsStep.canAdvance('config-credentials-ready', { ready: true }), true);
  assert.equal(credentialsStep.canAdvance('config-credentials-ready', { ready: false }), false);
  const refreshStep = setup.steps.find(step => step.configRequirement === 'model-refresh');
  assert.equal(refreshStep.canAdvance('config-models-refreshed', { tab: 'chat', count: 2 }), true);
  assert.equal(refreshStep.canAdvance('config-models-refreshed', { tab: 'chat', count: 0 }), false);
  // 兜底：服务商不支持模型列表时，手动填写模型也能推进刷新步
  assert.equal(refreshStep.canAdvance('config-model-selected', { model: 'my-model' }), true);
  assert.equal(refreshStep.canAdvance('config-model-selected', { model: '  ' }), false);
  const modelStep = setup.steps.find(step => step.configRequirement === 'model-selection');
  assert.equal(modelStep.canAdvance('config-model-selected', { model: 'gpt-test' }), true);
  assert.equal(modelStep.canAdvance('config-model-selected', { model: '' }), false);
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['config-connection-fields'].includes('#config-main-page'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['config-api-key-input'].includes('#config-apikey'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['config-refresh-models'].includes('#refresh-models'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['config-model-section'].includes('#config-model-section'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['config-model-picker'].includes('#config-model-picker'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['config-save-btn'].includes('#config-save'));
  console.log('ok - setup API flow guides provider, credentials, model refresh, model selection, and real save');
}

{
  const setup = createMaidExistingApiReviewFlow();
  assert.deepEqual(
    setup.steps.map(step => step.target || ''),
    [
      '',
      'settings-entry',
      'settings-api-config',
      'config-profile-select',
      'config-model-section',
    ],
  );
  const profileStep = setup.steps[3];
  assert.equal(profileStep.action, 'observe');
  assert.equal(profileStep.primaryLabel, '沿用当前连线');
  const modelStep = setup.steps[4];
  assert.deepEqual(modelStep.fallback, { kind: 'click-target', target: 'config-save-btn' });
  assert.equal(modelStep.primaryLabel, '保存并绑定女仆');
  assert.equal(modelStep.canAdvance('config-model-selected', { model: 'gpt-test' }), false);
  assert.equal(modelStep.canAdvance('config-profile-saved', { profileCount: 1 }), true);
  assert.equal(modelStep.canAdvance('config-profile-saved', { profileCount: 0 }), false);
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['config-profile-select'].includes('#config-profile'));
  console.log('ok - existing API first-run flow reviews profile and model but only requires a real save');
}

{
  const addFriend = getMaidOnboardingFlow('add-friend');
  assert.equal(addFriend.steps.at(-1).canAdvance('friend-added', { sessionId: 'Aria' }), true);
  const firstChat = getMaidOnboardingFlow('first-chat');
  assert.deepEqual(
    firstChat.steps.map(step => step.target || ''),
    ['', 'contact-list-entry', 'contact-detail-message', 'chat-input', 'chat-send', 'chat-body'],
  );
  assert.equal(firstChat.steps[1].canAdvance('target-click', { target: 'contact-list-entry' }), true);
  assert.equal(firstChat.steps[2].canAdvance('target-click', { target: 'contact-detail-message' }), false);
  assert.equal(firstChat.steps[2].canAdvance('chat-room-entered', { sessionId: 'Aria' }), true);
  assert.equal(firstChat.steps.at(-1).canAdvance('chat-message-received', { role: 'assistant' }), true);
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['contact-list-entry'].includes('.contact-item'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['contact-detail-message'].includes('[data-action="contact-detail-message"]'));
  assert.equal(Object.hasOwn(MAID_ONBOARDING_TARGET_SELECTORS, 'chat-list-entry'), false);
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['format-repair-banner'].includes('#rejected-format-repair-banner'));
  const meetMaid = getMaidOnboardingFlow('meet-maid');
  assert.deepEqual(
    meetMaid.steps.map(step => step.target || ''),
    [
      '',
      'maid-ball',
      'maid-command-input',
      'agent-center-entry',
      'agent-center-card',
      'agent-center-detail-close',
      'agent-center-close',
    ],
  );
  assert.equal(meetMaid.steps[3].canAdvance('target-click', { target: 'settings-agent-center' }), true);
  assert.equal(meetMaid.steps[3].canAdvance('target-click', { target: 'agent-center-entry' }), true);
  assert.equal(meetMaid.steps[4].canAdvance('target-click', { target: 'agent-center-card' }), true);
  assert.equal(meetMaid.steps[5].canAdvance('target-click', { target: 'agent-center-detail-close' }), true);
  assert.equal(meetMaid.steps.at(-1).canAdvance('agent-center-closed'), true);
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['agent-center-entry'].includes('.agent-status-chip'));
  assert.ok(MAID_ONBOARDING_TARGET_SELECTORS['agent-center-detail-close'].includes('[data-agent-float-close]'));
  console.log('ok - add-friend, first-chat, and meet-maid flows use completion events');
}
