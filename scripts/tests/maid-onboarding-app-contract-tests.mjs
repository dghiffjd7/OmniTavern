import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const appSource = read('../../src/scripts/ui/app.js');
const configSource = read('../../src/scripts/ui/config-panel.js');
const sessionSource = read('../../src/scripts/ui/session-panel.js');
const feedbackSource = read('../../src/scripts/ui/session-add-friend-feedback-ui.js');
const agentCenterSource = read('../../src/scripts/ui/agent-center-panel.js');
const agentStatusSource = read('../../src/scripts/ui/agent-center-status-chip.js');
const indexSource = read('../../src/index.html');
const generalSettingsSource = read('../../src/scripts/ui/general-settings-panel.js');
const richRendererSource = read('../../src/scripts/ui/chat/rich-text-renderer.js');
const worldPanelSource = read('../../src/scripts/ui/world-panel.js');
const worldEditorSource = read('../../src/scripts/ui/world-editor.js');

for (const target of [
  'config-connection-fields',
  'config-profile-select',
  'config-provider-select',
  'config-custom-fields',
  'config-base-url-input',
  'config-api-key-input',
  'config-service-account-input',
  'config-refresh-models',
  'config-model-section',
  'config-model-picker',
  'config-model-select',
  'config-save-btn',
]) {
  assert.match(configSource, new RegExp(`data-maid-guide-target=["']${target}["']`));
}
assert.match(configSource, /<div class="api-config-field" data-maid-guide-target="config-profile-select">[\s\S]*?id="profile-new"/);
assert.match(configSource, /config-models-refreshed/);
assert.match(configSource, /data-maid-guide-back="api-config"/);
assert.match(configSource, /world-app-select-menu[\s\S]*?is-maid-guide-menu/);
assert.match(appSource, /document\.body\?\.dataset\?\.maidSpotlight === 'on'/);
assert.match(appSource, /maidGuideEmit\(window, 'config-profile-saved'/);
assert.match(appSource, /const bindMaidToSavedApiProfile[\s\S]*?maidSettingsStore\.setBoundProfileId\(savedProfileId\)/);
assert.match(
  appSource,
  /const bindMaidToSavedApiProfile = async \(\{[\s\S]*?tab[\s\S]*?\} = \{\}\) => \{[\s\S]*?if \(tab !== 'chat'\) return false;[\s\S]*?maidSettingsStore\.setBoundProfileId\(savedProfileId\)/,
  'the maid API picker must ignore saves from voice and image tabs',
);
assert.match(appSource, /const openMaidApiConfigPanel[\s\S]*?onSaved:\s*bindMaidToSavedApiProfile/);
assert.match(appSource, /maidGuideEmit\(window, 'chat-message-sent'/);
assert.match(appSource, /maidGuideEmit\(window, 'chat-message-received'/);
assert.match(appSource, /maidGuideEmit\(window, 'chat-reply-rejected'/);
assert.match(appSource, /maidGuideEmit\(window, 'chat-room-entered'/);
assert.match(appSource, /registerGuideStartFlowTools/);
assert.match(appSource, /maidOnboardingRuntime\?\.getSpotlight\?\.\(\)/);
assert.match(appSource, /maidOnboardingRuntime\?\.handleCommandInputOpen\?\.\(\{ open, anchorEl: rootEl \}\)/);
assert.match(appSource, /autoFocus: !maidVoiceRuntime\?\.isCallActive\(\) && maidOnboardingRuntime\?\.isFirstRunPending\?\.\(\) !== true/);
assert.match(appSource, /getMaidBallElement: \(\) => modeSwitch/);
assert.match(appSource, /createMaidRichScriptGuideRuntime\(\{[\s\S]*?getOnboardingRuntime: \(\) => maidOnboardingRuntime[\s\S]*?isExecutionEnabled:/);
assert.match(appSource, /createPresetPreviewDiscoveryGuide\(\{[\s\S]*?guideStore: maidGuideStore[\s\S]*?presetPanel\.setPreviewDiscoveryGuide/);
assert.match(appSource, /openGeneralSettings: options => generalSettingsPanel\.show\(options\)/);
assert.match(appSource, /allowRichIframeScripts[\s\S]*?void rerenderCurrentSession\(\)/);
assert.match(appSource, /const refreshModeSwitchAnchoredUi = \(\) => \{[\s\S]*?maidOnboardingRuntime\?\.getEntryUi\?\.\(\)\?\.refreshPosition\?\.\(\);[\s\S]*?\};/);
assert.match(appSource, /onPositionChange: refreshModeSwitchAnchoredUi/);
assert.match(appSource, /setModeSwitchPos: value => \{[\s\S]*?modeSwitchPos = value;[\s\S]*?refreshModeSwitchAnchoredUi\(\);[\s\S]*?\}/);
assert.match(appSource, /getProfiles: \(\) => window\.appBridge\?\.getConfigProfiles\?\.\(\)/);
assert.match(appSource, /const targetExpected = Boolean\(target \|\| getMaidGuideStepSelectors\(guide, step\)\.length\)/);
// 功能引导启动时必须收起女仆指令条：否则结果气泡（z 26095）会在聚光灯洞里挡住 z 15000 的菜单目标
assert.match(appSource, /const showMaidGuideSteps[\s\S]{0,700}?maidOnboardingRuntime\?\.skip\?\.\(\);\s*\n\s*maidCommandInputRuntime\?\.close\?\.\(\);/);
assert.match(
  appSource,
  /const restoreMaidCommandInputAfterRun = async \(\) => \{[\s\S]{0,400}?isSubmitting\?\.\(\) === true[\s\S]{0,400}?maidCommandInputRuntime\?\.open\?\.\(\{ autoFocus: false \}\);[\s\S]{0,40}?\};/,
  'the command surface must come back only after the maid run settles, not while panels are opening',
);
assert.match(
  appSource,
  /const showMaidGuideSteps[\s\S]*?const restoreMaidCommandInput = maidCommandInputRuntime\?\.isOpen\?\.\(\) === true;[\s\S]*?hideMaidGuideBubble\(\);\s*\n\s*if \(restoreMaidCommandInput\) void restoreMaidCommandInputAfterRun\(\);/,
  'feature guides must defer the command-surface restore until the maid run ends',
);
assert.match(appSource, /expectsTarget:\s*targetExpected/);
assert.match(appSource, /waitForMaidGuideStepAdvance\(targetExpected[\s\S]*?\(\) => findMaidGuideTarget\(guide, step\)/);
assert.match(appSource, /document\.addEventListener\('click', onTargetClick, true\)/);

assert.match(sessionSource, /onFriendAdded/);
assert.match(sessionSource, /enterChatRoom/);
assert.match(sessionSource, /maidGuideTarget = 'add-friend-recommendation'/);
assert.match(sessionSource, /data-maid-guide-target="add-friend-search-input"/);
assert.match(sessionSource, /maidGuideBack = 'add-friend-panel'/);
assert.match(sessionSource, /id="session-add"[^>]*data-maid-guide-target="session-add-submit"/);
assert.match(feedbackSource, /maidGuideTarget = 'add-friend-confirm'/);
assert.match(feedbackSource, /maidGuideBack = 'add-friend-confirm'/);
assert.match(agentCenterSource, /data-maid-guide-target="agent-center-card"/);
assert.match(agentCenterSource, /data-maid-guide-target="agent-center-close"/);
assert.match(agentCenterSource, /data-maid-guide-target="agent-center-detail-close"/);
assert.match(agentCenterSource, /data-maid-guide-back="agent-center"/);
assert.match(agentStatusSource, /button\.dataset\.maidGuideTarget = 'agent-center-entry'/);
assert.match(indexSource, /data-action="settings"[^>]*data-maid-guide-target="settings-general"/);
assert.match(indexSource, /data-action="chat-settings"[^>]*data-maid-guide-target="chatroom-chat-settings"/);
assert.match(indexSource, /id="chat-setting-open-regex"[^>]*data-maid-guide-target="chat-settings-regex"/);
assert.match(indexSource, /id="chat-setting-open-vars"[^>]*data-maid-guide-target="chat-settings-variables"/);
assert.match(generalSettingsSource, /id="general-open-memory-templates"[^>]*data-maid-guide-target="general-memory-templates"/);
assert.match(generalSettingsSource, /renderFoldButton\('general-ui-advanced-toggle', '调试选项', 'general-ui-advanced'\)/);
assert.match(generalSettingsSource, /guideTarget: 'general-rich-iframe-scripts'/);
assert.match(generalSettingsSource, /<label class="\$\{classes\}"\$\{guideAttr\}>/, 'guide target must cover the visible setting row, not the zero-size checkbox');
assert.match(generalSettingsSource, /detail: \{ key: 'allowRichIframeScripts', value \}/);
assert.match(generalSettingsSource, /show\(options = \{\}\)[\s\S]*?revealRichIframeScriptsSetting\(\)/);
assert.match(richRendererSource, /debugTag === 'rp-greeting'[\s\S]*?detectRichScriptExecutionRequirement/);
assert.match(richRendererSource, /new CustomEventCtor\(RICH_SCRIPT_EXECUTION_REQUIRED_EVENT,[\s\S]*?reason: richScriptRequirement\.reason/);
assert.doesNotMatch(richRendererSource, /RICH_SCRIPT_EXECUTION_REQUIRED_EVENT[\s\S]{0,500}?detail:[\s\S]{0,300}?code:/);
assert.match(worldPanelSource, /id="world-new"[^>]*data-maid-guide-target="worldbook-new"/);
assert.match(worldEditorSource, /id="world-entry-add"[^>]*data-maid-guide-target="worldbook-entry-add"/);
assert.match(worldEditorSource, /id="world-editor-save"[^>]*data-maid-guide-target="worldbook-save"/);

const guidedStepPreparationBlock = appSource.slice(
  appSource.indexOf('const prepareMaidGuideStep'),
  appSource.indexOf('const waitForMaidGuideStepAdvance'),
);
assert.match(guidedStepPreparationBlock, /label === '聊天设置'[\s\S]*?openMaidChatroomMenuForGuide/);
assert.match(guidedStepPreparationBlock, /label === '变量管理器' \|\| label === '正规表达式'[\s\S]*?openChatSettings/);
assert.match(guidedStepPreparationBlock, /label === '设定'[\s\S]*?openMaidSettingsMenuForGuide/);
assert.match(guidedStepPreparationBlock, /label === '记忆表格'[\s\S]*?generalSettingsPanel\.show/);
assert.match(guidedStepPreparationBlock, /label === '输入新好友名称' \|\| label === '添加'[\s\S]*?sessionPanel\.show/);
assert.match(guidedStepPreparationBlock, /label === '新增世界书'[\s\S]*?worldPanel\.show/);

const commandSettingsBlock = appSource.slice(
  appSource.indexOf('onSettings: async () => {'),
  appSource.indexOf('setTimeoutFn:', appSource.indexOf('onSettings: async () => {')),
);
assert.doesNotMatch(commandSettingsBlock, /maid-command-settings|agentCenterPanel\.show|agent-center-opened/);
assert.match(commandSettingsBlock, /maidSettingsPanel\.show/);

const openCommandBlock = appSource.slice(
  appSource.indexOf('const openMaidCommandOrSettings'),
  appSource.indexOf('const maidSelectionMode'),
);
assert.match(openCommandBlock, /maidCommandInputRuntime\?\.open\(\{ autoFocus \}\)/);
assert.doesNotMatch(openCommandBlock, /openMaidApiConfigPanel/);

const appBackGuideBlock = appSource.slice(
  appSource.indexOf('const closeMaidOnboardingBackLayer'),
  appSource.indexOf('const panelBackOpenChecks'),
);
assert.match(appBackGuideBlock, /maidOnboardingRuntime\?\.back\?\.\(\)/);
assert.doesNotMatch(appBackGuideBlock, /maidOnboardingRuntime\?\.skip\?\.\(\)/);
assert.match(appSource, /\.app-confirm-modal \.app-confirm-cancel,[\s\S]*?\.session-add-confirm-layer:not\(\.is-leaving\) \.session-add-confirm-action\.is-cancel[\s\S]*?const activeSelectors/);
const closeTopLayerBlock = appSource.slice(
  appSource.indexOf('const closeTopAppLayer'),
  appSource.indexOf('const nativeBackButtonRegistrar'),
);
assert.ok(
  closeTopLayerBlock.indexOf('isMaidOnboardingBackLayerOpen()') >= 0
    && closeTopLayerBlock.indexOf('isMaidOnboardingBackLayerOpen()') < closeTopLayerBlock.indexOf("'#contact-detail.is-active'"),
  'active onboarding must own Android back before the underlying contact detail layer',
);
assert.match(appSource, /const closeMaidOnboardingBackLayer = \(\) =>/);
assert.match(appSource, /const isMaidOnboardingBackLayerOpen = \(\) =>/);
assert.match(appSource, /const panelBackClosers = \[\s*closeMaidOnboardingBackLayer,/);
assert.match(appSource, /const panelBackOpenChecks = \[\s*isMaidOnboardingBackLayerOpen,/);
assert.doesNotMatch(closeTopLayerBlock, /panelBack(?:OpenChecks|Closers)\[0\]/);
assert.doesNotMatch(closeTopLayerBlock, /for \(let idx = 1;/);
console.log('ok - app onboarding contract wires real anchors, completion events, offline command access, and spotlight reuse');
