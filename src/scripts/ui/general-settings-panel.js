import { appSettings } from '../storage/app-settings.js';
import { LANGUAGE_OPTIONS } from '../i18n/first-run-language.js';
import { localizeDomSubtree, t } from '../i18n/index.js';
import { ConfigManager } from '../storage/config.js';
import { pickSavePath } from '../utils/save-dialog.js';
import { safeInvoke } from '../utils/tauri.js';
import { bindReplyNotificationSettings } from './reply-notification-service.js';
import { appConfirm } from './app-confirm.js';
import { resolveImportKindFromZipEntries } from './import-package-kind-utils.js';
import {
  applyMemoryStorageMode,
  deriveMemoryStorageMode,
} from './memory-storage-mode-utils.js';
import {
  THEME_AVATAR_STYLE_OPTIONS,
  THEME_CHAT_DISPLAY_OPTIONS,
  THEME_TOAST_POSITION_OPTIONS,
  themeManager,
} from './theme-manager.js';
import { themeStore } from '../storage/theme-store.js';

const GENERAL_SETTINGS_ICONS = Object.freeze({
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>',
  reply: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 8L4 12l5 4"></path>
      <path d="M4 12h8c4.4 0 8 3.6 8 8"></path>
    </svg>
  `.trim(),
  expand: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3.5" y="6" width="17" height="12" rx="2"></rect>
      <path d="M8 9H6v6h2"></path>
      <path d="M16 9h2v6h-2"></path>
    </svg>
  `.trim(),
  history: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16"></path>
      <path d="M4 12h10"></path>
      <path d="M4 18h7"></path>
      <path d="M17 15v4"></path>
      <path d="M15 17h4"></path>
    </svg>
  `.trim(),
  bug: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8a4 4 0 0 1 8 0"></path>
      <path d="M8 10h8v4a4 4 0 0 1-8 0z"></path>
      <path d="M6 13H4"></path>
      <path d="M20 13h-2"></path>
      <path d="M7 7L5.5 5.5"></path>
      <path d="M17 7l1.5-1.5"></path>
      <path d="M8 17l-2 2"></path>
      <path d="M16 17l2 2"></path>
    </svg>
  `.trim(),
  log: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="5" cy="6" r="1"></circle>
      <circle cx="5" cy="12" r="1"></circle>
      <circle cx="5" cy="18" r="1"></circle>
      <path d="M9 6h10"></path>
      <path d="M9 12h10"></path>
      <path d="M9 18h10"></path>
    </svg>
  `.trim(),
  code: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 8l-4 4 4 4"></path>
      <path d="M16 8l4 4-4 4"></path>
      <path d="M13 5l-2 14"></path>
    </svg>
  `.trim(),
  link: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 13a5 5 0 0 1 0-7l1-1a5 5 0 0 1 7 7l-1 1"></path>
      <path d="M14 11a5 5 0 0 1 0 7l-1 1a5 5 0 0 1-7-7l1-1"></path>
    </svg>
  `.trim(),
  clock: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8"></circle>
      <path d="M12 8v4l3 2"></path>
    </svg>
  `.trim(),
  brain: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 6a3 3 0 0 1 6 0 3 3 0 0 1 3 3c1.1.4 2 1.5 2 2.9 0 1.8-1.4 3.1-3.2 3.1H7.2C5.4 15 4 13.7 4 11.9c0-1.4.9-2.5 2-2.9A3 3 0 0 1 9 6z"></path>
      <path d="M10 10v5"></path>
      <path d="M14 10v5"></path>
      <path d="M10 12h4"></path>
    </svg>
  `.trim(),
  notes: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="4" width="14" height="16" rx="2"></rect>
      <path d="M8 8h8"></path>
      <path d="M8 12h8"></path>
      <path d="M8 16h5"></path>
    </svg>
  `.trim(),
  table: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="5" width="16" height="14" rx="2"></rect>
      <path d="M4 10h16"></path>
      <path d="M9 5v14"></path>
      <path d="M15 5v14"></path>
    </svg>
  `.trim(),
  template: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5C6 5 6 7 6 8.5S5 12 3.5 12C5 12 6 14 6 15.5S6 19 8 19"></path>
      <path d="M16 5c2 0 2 2 2 3.5S19 12 20.5 12C19 12 18 14 18 15.5S18 19 16 19"></path>
    </svg>
  `.trim(),
  script: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h8l3 3v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"></path>
      <path d="M15 5v4h4"></path>
      <path d="M9 12h6"></path>
      <path d="M9 16h4"></path>
    </svg>
  `.trim(),
  sliders: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6h14"></path>
      <path d="M9 12h10"></path>
      <path d="M5 18h14"></path>
      <circle cx="8" cy="6" r="2"></circle>
      <circle cx="14" cy="12" r="2"></circle>
      <circle cx="11" cy="18" r="2"></circle>
    </svg>
  `.trim(),
  palette: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4a8 8 0 1 0 0 16h1.2a2.3 2.3 0 0 0 0-4.6H12a1.2 1.2 0 0 1 0-2.4h3.3A4.7 4.7 0 0 0 20 8.3 8.3 8.3 0 0 0 12 4z"></path>
      <circle cx="7.5" cy="10" r="1"></circle>
      <circle cx="10" cy="7.5" r="1"></circle>
      <circle cx="14" cy="7.5" r="1"></circle>
      <circle cx="16.5" cy="10.5" r="1"></circle>
    </svg>
  `.trim(),
});

export class GeneralSettingsPanel {
  constructor(actions = {}) {
    this.element = null;
    this.overlayElement = null;
    this.modalElement = null;
    this.languageSelect = null;
    this.languageButton = null;
    this.languageStatus = null;
    this.themePresetSelect = null;
    this.themePresetButton = null;
    this.themeAdvancedToggle = null;
    this.themeAdvancedWrap = null;
    this.themeAvatarStyleSelect = null;
    this.themeAvatarStyleButton = null;
    this.themeChatDisplaySelect = null;
    this.themeChatDisplayButton = null;
    this.themeToastPositionSelect = null;
    this.themeToastPositionButton = null;
    this.themeFontScaleInput = null;
    this.themeFontScaleValue = null;
    this.themeReducedMotionToggle = null;
    this.themeCompactInputToggle = null;
    this.themeHideAvatarsToggle = null;
    this.themeImportBtn = null;
    this.themeExportBtn = null;
    this.themeStatus = null;
    this.themeImportInput = null;
    this.debugToggle = null;
    this.debugLogToggle = null;
    this.toastEnabledToggle = null;
    this.typingDotsToggle = null;
    this.richIframeScriptsToggle = null;
    this.traditionalProtocolToggle = null;
    this.chatHistoryMaxInput = null;
    this.creativeHistoryInput = null;
    this.creativeWideToggle = null;
    this.personaBindToggle = null;
    this.promptTimeToggle = null;
    this.chatAiTimeToggle = null;
    this.momentCommentSideEffectsToggle = null;
    this.autoImagePromptToggle = null;
    this.autoImagePromptWritingToggle = null;
    this.autoImagePromptStyleSelect = null;
    this.autoImagePromptAdvancedToggle = null;
    this.autoImagePromptAdvancedWrap = null;
    this.autoImagePromptDecisionModeSelect = null;
    this.autoImagePromptMomentMediaModeSelect = null;
    this.autoImagePromptCooldownInput = null;
    this.autoImagePromptWindowRoundsInput = null;
    this.autoImagePromptWindowMaxInput = null;
    this.autoImagePromptMaxConcurrencyInput = null;
    this.autoImagePromptMaxPerResponseInput = null;
    this.autoImagePromptSkipRepeatedToggle = null;
    this.memoryEnabledToggle = null;
    this.memoryModeSummary = null;
    this.memoryModeTable = null;
    this.memoryAutoToggle = null;
    this.memoryAutoModeInline = null;
    this.memoryAutoModeSeparate = null;
    this.memoryAutoOptions = null;
    this.memoryUpdateApiChat = null;
    this.memoryUpdateApiProfile = null;
    this.memoryUpdateProfileSelect = null;
    this.memoryUpdateProfileButton = null;
    this.memoryUpdateProfileManageBtn = null;
    this.memoryUpdateApiBlock = null;
    this.memoryUpdateContextInput = null;
    this.memoryBudgetBlock = null;
    this.memoryBudgetModeSelect = null;
    this.memoryTokenBudgetWrap = null;
    this.memoryInputBudgetInput = null;
    this.memoryRowsBudgetWrap = null;
    this.memoryMaxRowsInput = null;
    this.memoryMaxTokensInput = null;
    this.memoryInjectPositionSelect = null;
    this.memoryInjectPositionButton = null;
    this.memoryInjectDepthWrap = null;
    this.memoryInjectDepthInput = null;
    this.memoryBridgeBlock = null;
    this.memoryBridgeMomentsToChatToggle = null;
    this.memoryBridgeMomentsToChatLimitInput = null;
    this.memoryBridgeChatToMomentsToggle = null;
    this.memoryBridgeChatToMomentsLimitInput = null;
    this.memoryBridgeRpToMomentsToggle = null;
    this.memoryBridgeRpToMomentsLimitInput = null;
    this.memoryGroupMemberReferenceToggle = null;
    this.memoryGroupMemberReferenceLimitInput = null;
    this.memoryAutoConfirmToggle = null;
    this.memoryAutoStepToggle = null;
    this.memoryFillEveryNInput = null;
    this.memoryPlacesButton = null;
    this.memoryPlacesDialogOverlay = null;
    this.memoryPlacesDialog = null;
    this.memoryPlacesChecks = {};
    this.templateEnabledToggle = null;
    this.templateBeforeToggle = null;
    this.templateAfterToggle = null;
    this.templateErrorToggle = null;
    this.templateOptionsWrap = null;
    this.templateAdvancedToggle = null;
    this.templateAdvancedWrap = null;
    this.scriptAdvancedToggle = null;
    this.scriptAdvancedWrap = null;
    this.scriptEnabledToggle = null;
    this.scriptAllowVarsToggle = null;
    this.scriptAllowMessagesToggle = null;
    this.scriptAllowNetworkToggle = null;
    this.scriptOptionsWrap = null;
    this.uiAdvancedToggle = null;
    this.uiAdvancedWrap = null;
    this.memoryAdvancedToggle = null;
    this.memoryAdvancedWrap = null;
    this.cleanWallpapersBtn = null;
    this.cleanWallpapersStatus = null;
    this.bundleExportBtn = null;
    this.bundleImportBtn = null;
    this.customBundleExportBtn = null;
    this.bundleStatus = null;
    this.bundleProgressWrap = null;
    this.bundleProgressBar = null;
    this.bundleProgressText = null;
    this.bundleImportInput = null;
    this.openSessionBtn = null;
    this.openMemoryTemplatesBtn = null;
    this.externalActions = {
      openSession: null,
      openMemoryTemplates: null,
      openConfig: null,
      restartApp: null,
      importExperiencePackFile: null,
      importCustomBundleFile: null,
      exportCustomBundle: null,
    };
    this.customSelectMenuEl = null;
    this.customSelectMenuCleanup = null;
    this.customSelectMenuAnchor = null;
    this.configManager = new ConfigManager();
    this.setExternalActions(actions);
  }

  setExternalActions(actions = {}) {
    this.externalActions.openSession =
      typeof actions.openSession === 'function' ? actions.openSession : null;
    this.externalActions.openMemoryTemplates =
      typeof actions.openMemoryTemplates === 'function' ? actions.openMemoryTemplates : null;
    this.externalActions.openConfig =
      typeof actions.openConfig === 'function' ? actions.openConfig : null;
    this.externalActions.restartApp =
      typeof actions.restartApp === 'function' ? actions.restartApp : null;
    this.externalActions.importExperiencePackFile =
      typeof actions.importExperiencePackFile === 'function' ? actions.importExperiencePackFile : null;
    this.externalActions.importCustomBundleFile =
      typeof actions.importCustomBundleFile === 'function' ? actions.importCustomBundleFile : null;
    this.externalActions.exportCustomBundle =
      typeof actions.exportCustomBundle === 'function' ? actions.exportCustomBundle : null;
    this.updateShortcutButtons();
  }

  setBundleProgress({ visible = false, progress = 0, text = '', indeterminate = false, tone = 'normal' } = {}) {
    if (this.bundleProgressWrap) {
      this.bundleProgressWrap.style.display = visible ? 'flex' : 'none';
    }
    if (this.bundleProgressBar) {
      const pct = Math.max(0, Math.min(100, Number(progress || 0) || 0));
      this.bundleProgressBar.style.width = indeterminate ? '32%' : `${pct}%`;
      this.bundleProgressBar.style.transition = 'width 180ms ease';
      this.bundleProgressBar.style.transform = 'translateX(0)';
      this.bundleProgressBar.style.opacity = indeterminate ? '0.92' : '1';
      this.bundleProgressBar.style.background = tone === 'error'
        ? 'linear-gradient(90deg, rgba(239,68,68,0.92), rgba(248,113,113,0.92))'
        : tone === 'success'
          ? 'linear-gradient(90deg, rgba(34,197,94,0.92), rgba(74,222,128,0.92))'
          : 'linear-gradient(90deg, rgba(59,130,246,0.92), rgba(96,165,250,0.92))';
    }
    if (this.bundleProgressText) {
      this.bundleProgressText.textContent = String(text || '').trim();
    }
  }

  resetBundleProgress() {
    this.setBundleProgress({ visible: false, progress: 0, text: '', indeterminate: false, tone: 'normal' });
  }

  show(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    if (!this.element) {
      this.createUI();
    }
    const settings = appSettings.get();
    if (this.languageSelect) {
      this.languageSelect.value = String(settings.locale || 'system');
      if (!Array.from(this.languageSelect.options || []).some(option => option.value === this.languageSelect.value)) {
        this.languageSelect.value = 'system';
      }
    }
    this.refreshThemeSelectButton(this.languageButton, this.languageSelect, t('选择语言'));
    if (this.languageStatus) this.languageStatus.textContent = t('更改语言后需要重启应用。');
    if (this.debugToggle) {
      this.debugToggle.checked = Boolean(settings.showDebugToggle);
    }
    this.refreshThemePresetOptions();
    if (this.themePresetSelect) {
      this.themePresetSelect.value = String(settings.uiThemePresetId || 'classic-dark');
    }
    this.refreshThemeSelectButton(this.themePresetButton, this.themePresetSelect, '选择主题…');
    if (this.themeAvatarStyleSelect) {
      this.themeAvatarStyleSelect.value = String(settings.uiThemeAvatarStyle || 'system');
    }
    this.refreshThemeSelectButton(this.themeAvatarStyleButton, this.themeAvatarStyleSelect, '头像样式');
    if (this.themeChatDisplaySelect) {
      this.themeChatDisplaySelect.value = String(settings.uiThemeChatDisplay || 'default');
    }
    this.refreshThemeSelectButton(this.themeChatDisplayButton, this.themeChatDisplaySelect, '聊天风格');
    if (this.themeToastPositionSelect) {
      this.themeToastPositionSelect.value = String(settings.uiThemeToastrPosition || 'toast-top-right');
    }
    this.refreshThemeSelectButton(this.themeToastPositionButton, this.themeToastPositionSelect, '通知位置');
    if (this.themeFontScaleInput) {
      const scale = Number.isFinite(Number(settings.uiThemeFontScale))
        ? Math.round(Number(settings.uiThemeFontScale) * 100)
        : 100;
      this.themeFontScaleInput.value = String(Math.max(85, Math.min(135, scale)));
    }
    this.updateThemeFontScaleValue();
    if (this.themeReducedMotionToggle) {
      this.themeReducedMotionToggle.checked = settings.uiThemeReducedMotion === true;
    }
    if (this.themeCompactInputToggle) {
      this.themeCompactInputToggle.checked = settings.uiThemeCompactInput === true;
    }
    if (this.themeHideAvatarsToggle) {
      this.themeHideAvatarsToggle.checked = settings.uiThemeHideChatAvatars === true;
    }
    this.updateThemeStatus();
    if (this.debugLogToggle) {
      this.debugLogToggle.checked = settings.debugExecutionLogs === true;
    }
    if (this.typingDotsToggle) {
      this.typingDotsToggle.checked = settings.typingDotsEnabled !== false;
    }
    if (this.richIframeScriptsToggle) {
      this.richIframeScriptsToggle.checked = Boolean(settings.allowRichIframeScripts);
    }
    if (this.traditionalProtocolToggle) {
      this.traditionalProtocolToggle.checked = settings.traditionalModelOutputProtocolEnabled === true;
    }
    if (this.toastEnabledToggle) {
      this.toastEnabledToggle.checked = settings.toastEnabled !== false;
    }
    if (this.chatHistoryMaxInput) {
      const n = Number(settings.chatHistoryMax);
      this.chatHistoryMaxInput.value = String(Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    }
    if (this.creativeHistoryInput) {
      const n = Number(settings.creativeHistoryMax);
      this.creativeHistoryInput.value = String(Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    }
    if (this.creativeWideToggle) {
      this.creativeWideToggle.checked = Boolean(settings.creativeWideBubble);
    }
    if (this.personaBindToggle) {
      this.personaBindToggle.checked = settings.personaBindContacts !== false;
    }
    if (this.promptTimeToggle) {
      this.promptTimeToggle.checked = settings.promptCurrentTimeEnabled === true;
    }
    if (this.chatAiTimeToggle) this.chatAiTimeToggle.checked = settings.chatAiTimeEnabled === true;
    if (this.momentCommentSideEffectsToggle) {
      this.momentCommentSideEffectsToggle.checked = settings.momentCommentSideEffectsEnabled !== false;
    }
    if (this.autoImagePromptToggle) {
      this.autoImagePromptToggle.checked = settings.autoImagePromptEnabled === true;
    }
    if (this.autoImagePromptWritingToggle) {
      this.autoImagePromptWritingToggle.checked = settings.autoImagePromptWritingEnabled !== false;
    }
    if (this.autoImagePromptStyleSelect) {
      const raw = String(settings.autoImagePromptStyle || 'auto').trim();
      const allowed = new Set(['auto', 'natural', 'nai_tags']);
      this.autoImagePromptStyleSelect.value = allowed.has(raw) ? raw : 'auto';
    }
    if (this.autoImagePromptDecisionModeSelect) {
      const raw = String(settings.autoImagePromptDecisionMode || 'conservative').trim();
      const allowed = new Set(['conservative', 'standard', 'aggressive']);
      this.autoImagePromptDecisionModeSelect.value = allowed.has(raw) ? raw : 'conservative';
    }
    if (this.autoImagePromptMomentMediaModeSelect) {
      const raw = String(settings.autoImagePromptMomentMediaMode || 'ai').trim();
      const allowed = new Set(['placeholder', 'image_prompt', 'ai']);
      this.autoImagePromptMomentMediaModeSelect.value = allowed.has(raw) ? raw : 'ai';
    }
    if (this.autoImagePromptCooldownInput) {
      const n = Number(settings.autoImagePromptCooldownRounds);
      this.autoImagePromptCooldownInput.value = String(Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    }
    if (this.autoImagePromptWindowRoundsInput) {
      const n = Number(settings.autoImagePromptWindowRounds);
      this.autoImagePromptWindowRoundsInput.value = String(Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    }
    if (this.autoImagePromptWindowMaxInput) {
      const n = Number(settings.autoImagePromptWindowMax);
      this.autoImagePromptWindowMaxInput.value = String(Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    }
    if (this.autoImagePromptMaxConcurrencyInput) {
      const n = Number(settings.autoImagePromptMaxConcurrency);
      this.autoImagePromptMaxConcurrencyInput.value = String(Number.isFinite(n) ? Math.max(1, Math.trunc(n)) : 1);
    }
    if (this.autoImagePromptMaxPerResponseInput) {
      const n = Number(settings.autoImagePromptMaxPerResponse);
      this.autoImagePromptMaxPerResponseInput.value = String(Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
    }
    if (this.autoImagePromptSkipRepeatedToggle) {
      this.autoImagePromptSkipRepeatedToggle.checked = settings.autoImagePromptSkipRepeated !== false;
    }
    const memoryMode = deriveMemoryStorageMode(settings);
    const memoryEnabled = memoryMode !== 'off';
    if (this.memoryEnabledToggle) {
      this.memoryEnabledToggle.checked = memoryEnabled;
    }
    if (this.memoryModeSummary) {
      this.memoryModeSummary.checked = memoryMode !== 'table';
    }
    if (this.memoryModeTable) {
      this.memoryModeTable.checked = memoryMode === 'table';
    }
    if (this.memoryAutoToggle) {
      this.memoryAutoToggle.checked = Boolean(settings.memoryAutoExtract);
    }
    const memoryAutoMode = String(settings.memoryAutoExtractMode || 'inline').toLowerCase();
    if (this.memoryAutoModeInline) {
      this.memoryAutoModeInline.checked = memoryAutoMode !== 'separate';
    }
    if (this.memoryAutoModeSeparate) {
      this.memoryAutoModeSeparate.checked = memoryAutoMode === 'separate';
    }
    const memoryApiMode = String(settings.memoryUpdateApiMode || 'chat').toLowerCase();
    if (this.memoryUpdateApiChat) {
      this.memoryUpdateApiChat.checked = memoryApiMode !== 'profile';
    }
    if (this.memoryUpdateApiProfile) {
      this.memoryUpdateApiProfile.checked = memoryApiMode === 'profile';
    }
    if (this.memoryUpdateProfileSelect) {
      this.memoryUpdateProfileSelect.value = String(settings.memoryUpdateProfileId || '');
      this.refreshMemoryUpdateProfileSelectButton();
    }
    if (this.memoryUpdateContextInput) {
      const raw = Math.trunc(Number(settings.memoryUpdateContextRounds ?? settings.memoryUpdateContextCount));
      const safe = Number.isFinite(raw) ? Math.max(0, raw) : 6;
      this.memoryUpdateContextInput.value = String(safe);
    }
    if (this.memoryAutoConfirmToggle) {
      this.memoryAutoConfirmToggle.checked = settings.memoryAutoConfirm === true;
    }
    if (this.memoryAutoStepToggle) {
      this.memoryAutoStepToggle.checked = settings.memoryAutoStepByStep === true;
    }
    if (this.memoryFillEveryNInput) {
      const rawN = Math.trunc(Number(settings.memoryFillEveryN));
      const safeN = Number.isFinite(rawN) && rawN >= 1 ? rawN : 1;
      this.memoryFillEveryNInput.value = String(safeN);
    }
    const budgetMode = String(settings.memoryBudgetMode || '').trim().toLowerCase() === 'rows'
      ? 'rows'
      : 'token';
    if (this.memoryBudgetModeSelect) this.memoryBudgetModeSelect.value = budgetMode;
    const syncNonNegativeNumber = (input, value, fallback) => {
      if (!input) return;
      const raw = Math.trunc(Number(value));
      input.value = String(Number.isFinite(raw) ? Math.max(0, raw) : fallback);
    };
    syncNonNegativeNumber(this.memoryInputBudgetInput, settings.memoryInputBudgetTokens, 100000);
    syncNonNegativeNumber(this.memoryMaxRowsInput, settings.memoryMaxRows, 1000);
    syncNonNegativeNumber(this.memoryMaxTokensInput, settings.memoryMaxTokens, 100000);
    if (this.memoryGroupMemberReferenceToggle) {
      this.memoryGroupMemberReferenceToggle.checked = settings.memoryGroupMemberReferenceEnabled !== false;
    }
    syncNonNegativeNumber(
      this.memoryGroupMemberReferenceLimitInput,
      settings.memoryGroupMemberReferenceLimit,
      5,
    );
    this.refreshMemoryPlacesDialog(settings);
    if (this.memoryInjectPositionSelect) {
      const raw = String(settings.memoryInjectPosition || 'before_latest_user').toLowerCase();
      const allowed = new Set(['template', 'after_persona', 'system_end', 'before_chat', 'history_before', 'history_after', 'history_depth', 'before_latest_user', 'after_latest_user', 'system_end+before_chat']);
      this.memoryInjectPositionSelect.value = allowed.has(raw) ? raw : 'before_latest_user';
      this.refreshThemeSelectButton(this.memoryInjectPositionButton, this.memoryInjectPositionSelect, '注入位置');
    }
    if (this.memoryInjectDepthInput) {
      const raw = Math.trunc(Number(settings.memoryInjectDepth));
      const safe = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      this.memoryInjectDepthInput.value = String(safe);
    }
    const syncBridgeLimit = (input, value, fallback = 5) => {
      if (!input) return;
      const raw = Math.trunc(Number(value));
      input.value = String(Number.isFinite(raw) ? Math.max(0, raw) : fallback);
    };
    if (this.memoryBridgeMomentsToChatToggle) {
      this.memoryBridgeMomentsToChatToggle.checked = settings.memoryBridgeMomentsToChatEnabled !== false;
    }
    syncBridgeLimit(this.memoryBridgeMomentsToChatLimitInput, settings.memoryBridgeMomentsToChatLimit, 5);
    if (this.memoryBridgeChatToMomentsToggle) {
      this.memoryBridgeChatToMomentsToggle.checked = settings.memoryBridgeChatToMomentsEnabled !== false;
    }
    syncBridgeLimit(this.memoryBridgeChatToMomentsLimitInput, settings.memoryBridgeChatToMomentsLimit, 5);
    if (this.memoryBridgeRpToMomentsToggle) {
      this.memoryBridgeRpToMomentsToggle.checked = settings.memoryBridgeRpToMomentsEnabled !== false;
    }
    syncBridgeLimit(this.memoryBridgeRpToMomentsLimitInput, settings.memoryBridgeRpToMomentsLimit, 5);
    if (this.templateEnabledToggle) {
      this.templateEnabledToggle.checked = settings.templateEnabled !== false;
    }
    if (this.templateBeforeToggle) {
      this.templateBeforeToggle.checked = settings.templateExecuteBeforeGenerate !== false;
    }
    if (this.templateAfterToggle) {
      this.templateAfterToggle.checked = settings.templateExecuteAfterRender !== false;
    }
    if (this.templateErrorToggle) {
      this.templateErrorToggle.checked = settings.templateShowErrorToast !== false;
    }
    if (this.scriptEnabledToggle) {
      this.scriptEnabledToggle.checked = settings.scriptEnabled === true;
    }
    if (this.scriptAllowVarsToggle) {
      this.scriptAllowVarsToggle.checked = settings.scriptAllowModifyVariables !== false;
    }
    if (this.scriptAllowMessagesToggle) {
      this.scriptAllowMessagesToggle.checked = settings.scriptAllowReadMessages !== false;
    }
    if (this.scriptAllowNetworkToggle) {
      this.scriptAllowNetworkToggle.checked = settings.scriptAllowNetwork === true;
    }
    this.syncAdvancedFoldVisibility();
    this.updateTemplateScriptVisibility();
    this.updateShortcutButtons();
    this.refreshMemoryUpdateProfiles().catch(() => {});
    this.updateMemoryAutoVisibility();
    this.updateSelectableCards();
    this.applyTypingDotsSetting(settings.typingDotsEnabled !== false);
    this.applyCreativeWideSetting(Boolean(settings.creativeWideBubble));
    this.element.style.display = 'block';
    this.overlayElement.style.display = 'block';
    if (opts.revealRichIframeScripts === true) this.revealRichIframeScriptsSetting();
  }

  hide() {
    this.closeCustomSelectMenu();
    this.hideMemoryPlacesDialog();
    if (this.element) this.element.style.display = 'none';
    if (this.overlayElement) this.overlayElement.style.display = 'none';
  }

  applyTypingDotsSetting(enabled) {
    if (!document?.body) return;
    if (enabled) {
      delete document.body.dataset.typingDots;
    } else {
      document.body.dataset.typingDots = 'off';
    }
  }

  applyCreativeWideSetting(enabled) {
    if (!document?.body) return;
    if (enabled) {
      document.body.dataset.creativeWide = 'on';
    } else {
      delete document.body.dataset.creativeWide;
    }
  }

  getThemeButtonLabel(selectEl, fallback = '请选择') {
    const current = Array.from(selectEl?.options || []).find((opt) => opt.value === selectEl?.value)
      || selectEl?.options?.[selectEl?.selectedIndex]
      || null;
    return current?.textContent?.trim() || fallback;
  }

  refreshThemeSelectButton(buttonEl, selectEl, fallback = '请选择') {
    if (!buttonEl || !selectEl) return;
    const labelEl = buttonEl.querySelector('.general-settings-custom-select-label');
    if (labelEl) labelEl.textContent = this.getThemeButtonLabel(selectEl, fallback);
  }

  populateThemeSelect(selectEl, options = [], currentValue = '') {
    if (!selectEl) return;
    const current = String(currentValue ?? selectEl.value ?? '').trim();
    selectEl.innerHTML = '';
    options.forEach((item) => {
      const option = document.createElement('option');
      option.value = String(item?.value ?? '');
      option.textContent = String(item?.label ?? option.value);
      if (option.value === current) option.selected = true;
      selectEl.appendChild(option);
    });
    if (selectEl.options.length && !Array.from(selectEl.options).some((opt) => opt.selected)) {
      selectEl.options[0].selected = true;
    }
  }

  refreshThemePresetOptions() {
    if (!this.themePresetSelect) return;
    const localizeBuiltinThemeName = (item) => {
      if (item.id === 'classic-light') return t('经典白');
      if (item.id === 'classic-dark') return t('经典黑');
      if (item.id === 'paper-ink') return t('纸墨 Paper Ink');
      return item.name;
    };
    const list = themeStore.listThemes().map((item) => ({
      value: item.id,
      label: `${themeStore.isBuiltin(item.id) ? localizeBuiltinThemeName(item) : item.name}${themeStore.isBuiltin(item.id) ? ` · ${t('内建')}` : ''}`,
    }));
    this.populateThemeSelect(this.themePresetSelect, list, this.themePresetSelect.value || appSettings.get().uiThemePresetId);
  }

  openThemeSelectMenu(buttonEl, selectEl, fallback = '请选择') {
    if (!buttonEl || !selectEl) return;
    const options = Array.from(selectEl.options || []).map((opt) => ({
      value: opt.value,
      label: opt.textContent || opt.value,
    }));
    this.openCustomSelectMenu({
      anchorEl: buttonEl,
      options,
      currentValue: selectEl.value,
      onSelect: (value) => {
        if (selectEl.value !== value) {
          selectEl.value = value;
          selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          this.refreshThemeSelectButton(buttonEl, selectEl, fallback);
        }
      },
    });
  }

  updateThemeFontScaleValue() {
    if (!this.themeFontScaleValue || !this.themeFontScaleInput) return;
    const raw = Math.trunc(Number(this.themeFontScaleInput.value));
    const safe = Number.isFinite(raw) ? Math.max(85, Math.min(135, raw)) : 100;
    this.themeFontScaleValue.textContent = `${safe}%`;
  }

  updateThemeStatus(text = '') {
    if (!this.themeStatus) return;
    if (text) {
      this.themeStatus.textContent = text;
      return;
    }
    const preset = themeStore.getTheme(this.themePresetSelect?.value || appSettings.get().uiThemePresetId);
    const kind = themeStore.isBuiltin(preset?.id) ? '内建主题' : '自定义主题';
    const mode = String(preset?.mode || 'light') === 'dark' ? '深色' : '浅色';
    const source = String(preset?.source || '').trim() === 'sillytavern' ? ' · ST 导入' : '';
    this.themeStatus.textContent = `${kind} · ${mode}${source}`;
  }

  updateMemoryAutoVisibility() {
    const settings = appSettings.get();
    const memoryMode = deriveMemoryStorageMode(settings);
    const memoryEnabled = memoryMode !== 'off';
    const showMemoryTable = memoryEnabled && memoryMode === 'table';
    const enabled = settings.memoryAutoExtract === true;
    const mode = String(settings.memoryAutoExtractMode || 'inline').toLowerCase();
    const showAuto = showMemoryTable && Boolean(enabled);
    if (this.memoryModeSummary) this.memoryModeSummary.disabled = !memoryEnabled;
    if (this.memoryModeTable) this.memoryModeTable.disabled = !memoryEnabled;
    if (this.memoryAutoToggle) this.memoryAutoToggle.disabled = !showMemoryTable;
    if (this.memoryPlacesButton) {
      this.memoryPlacesButton.disabled = !showMemoryTable;
      this.memoryPlacesButton.classList.toggle('is-disabled', this.memoryPlacesButton.disabled);
    }
    if (this.memoryAutoOptions) {
      this.memoryAutoOptions.style.display = showAuto ? 'block' : 'none';
    }
    const showApi = showAuto && mode === 'separate';
    if (this.memoryUpdateApiBlock) {
      this.memoryUpdateApiBlock.style.display = showApi ? 'block' : 'none';
    }
    if (this.memoryUpdateContextInput) {
      this.memoryUpdateContextInput.disabled = !showApi;
    }
    const apiMode = String(settings.memoryUpdateApiMode || 'chat').toLowerCase();
    if (this.memoryUpdateProfileSelect) {
      this.memoryUpdateProfileSelect.disabled = !showApi || apiMode !== 'profile';
    }
    if (this.memoryUpdateProfileButton) {
      this.memoryUpdateProfileButton.disabled = !showApi || apiMode !== 'profile';
      this.memoryUpdateProfileButton.classList.toggle('is-disabled', this.memoryUpdateProfileButton.disabled);
    }
    if (this.memoryUpdateProfileManageBtn) {
      this.memoryUpdateProfileManageBtn.disabled =
        !showApi || apiMode !== 'profile' || typeof this.externalActions.openConfig !== 'function';
    }
    if (this.memoryBudgetBlock) {
      this.memoryBudgetBlock.style.display = showMemoryTable ? 'block' : 'none';
    }
    const budgetMode = String(settings.memoryBudgetMode || '').trim().toLowerCase() === 'rows'
      ? 'rows'
      : 'token';
    if (this.memoryBudgetModeSelect) this.memoryBudgetModeSelect.disabled = !showMemoryTable;
    if (this.memoryTokenBudgetWrap) {
      this.memoryTokenBudgetWrap.style.display = showMemoryTable && budgetMode === 'token' ? 'block' : 'none';
    }
    if (this.memoryInputBudgetInput) {
      this.memoryInputBudgetInput.disabled = !showMemoryTable || budgetMode !== 'token';
    }
    if (this.memoryRowsBudgetWrap) {
      this.memoryRowsBudgetWrap.style.display = showMemoryTable && budgetMode === 'rows' ? 'block' : 'none';
    }
    if (this.memoryMaxRowsInput) {
      this.memoryMaxRowsInput.disabled = !showMemoryTable;
    }
    if (this.memoryMaxTokensInput) {
      this.memoryMaxTokensInput.disabled = !showMemoryTable;
    }
    if (this.memoryGroupMemberReferenceToggle) {
      this.memoryGroupMemberReferenceToggle.disabled = !showMemoryTable;
    }
    if (this.memoryGroupMemberReferenceLimitInput) {
      this.memoryGroupMemberReferenceLimitInput.disabled = !showMemoryTable
        || this.memoryGroupMemberReferenceToggle?.checked === false;
    }
    if (this.memoryInjectPositionSelect) {
      this.memoryInjectPositionSelect.disabled = !showMemoryTable;
    }
    if (this.memoryInjectPositionButton) {
      this.memoryInjectPositionButton.disabled = !showMemoryTable;
      this.memoryInjectPositionButton.classList.toggle('is-disabled', this.memoryInjectPositionButton.disabled);
    }
    const position = String(settings.memoryInjectPosition || 'before_latest_user').toLowerCase();
    const showDepth = showMemoryTable && position === 'history_depth';
    if (this.memoryInjectDepthWrap) {
      this.memoryInjectDepthWrap.style.display = showDepth ? 'block' : 'none';
    }
    if (this.memoryInjectDepthInput) {
      this.memoryInjectDepthInput.disabled = !showDepth;
    }
    if (this.memoryBridgeBlock) {
      this.memoryBridgeBlock.style.display = showMemoryTable ? 'block' : 'none';
    }
    const syncBridgePair = (toggle, input) => {
      if (toggle) toggle.disabled = !showMemoryTable;
      if (input) input.disabled = !showMemoryTable || toggle?.checked === false;
    };
    syncBridgePair(this.memoryBridgeMomentsToChatToggle, this.memoryBridgeMomentsToChatLimitInput);
    syncBridgePair(this.memoryBridgeChatToMomentsToggle, this.memoryBridgeChatToMomentsLimitInput);
    syncBridgePair(this.memoryBridgeRpToMomentsToggle, this.memoryBridgeRpToMomentsLimitInput);
    this.updateSelectableCards();
  }

  refreshMemoryPlacesDialog(settings = appSettings.get()) {
    const checks = this.memoryPlacesChecks || {};
    if (checks.chat) checks.chat.checked = settings.memoryTableEnabledChat !== false;
    if (checks.moments) checks.moments.checked = settings.memoryTableEnabledMoments !== false;
    if (checks.writing) checks.writing.checked = settings.memoryTableEnabledWriting !== false;
  }

  ensureMemoryPlacesDialog() {
    if (this.memoryPlacesDialog) return;
    const overlay = document.createElement('div');
    overlay.className = 'app-themed-overlay general-memory-places-overlay';
    overlay.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(15,23,42,0.45); z-index:24000; align-items:center; justify-content:center; padding:16px;';
    const dialog = document.createElement('div');
    dialog.className = 'app-themed-panel general-memory-places-dialog';
    dialog.style.cssText = 'width:min(92vw,420px); background:var(--app-surface-card); border:1px solid var(--app-border-default); border-radius:14px; box-shadow:0 18px 42px rgba(15,23,42,0.22); overflow:hidden;';
    dialog.addEventListener('click', (e) => e.stopPropagation());
    dialog.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; border-bottom:1px solid var(--app-border-default); background:var(--app-surface-subtle);">
        <div style="font-weight:900;">记忆表格生效位置</div>
        <button type="button" data-role="close" style="border:1px solid var(--app-border-default); background:var(--app-surface-card); border-radius:10px; padding:6px 10px; cursor:pointer;">关闭</button>
      </div>
      <div style="padding:14px; display:flex; flex-direction:column; gap:10px;">
        <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; padding:10px; border:1px solid var(--app-border-subtle); border-radius:10px;">
          <input type="checkbox" data-place="chat" style="width:18px; height:18px; margin-top:1px;">
          <span>
            <span class="has-help" data-help="私聊与群聊请求注入、自动写表。" data-help-mode="press" style="display:block; font-weight:800; color:var(--app-text-primary);">聊天</span>
          </span>
        </label>
        <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; padding:10px; border:1px solid var(--app-border-subtle); border-radius:10px;">
          <input type="checkbox" data-place="moments" style="width:18px; height:18px; margin-top:1px;">
          <span>
            <span class="has-help" data-help="动态评论时注入、自动写表。" data-help-mode="press" style="display:block; font-weight:800; color:var(--app-text-primary);">动态</span>
          </span>
        </label>
        <label style="display:flex; align-items:flex-start; gap:10px; cursor:pointer; padding:10px; border:1px solid var(--app-border-subtle); border-radius:10px;">
          <input type="checkbox" data-place="writing" style="width:18px; height:18px; margin-top:1px;">
          <span>
            <span class="has-help" data-help="创意写作请求注入、自动写表。" data-help-mode="press" style="display:block; font-weight:800; color:var(--app-text-primary);">创意写作</span>
          </span>
        </label>
      </div>
      <div style="display:flex; justify-content:flex-end; gap:10px; padding:12px 14px; border-top:1px solid var(--app-border-default);">
        <button type="button" data-role="cancel" style="padding:8px 12px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-subtle); cursor:pointer;">取消</button>
        <button type="button" data-role="save" style="padding:8px 14px; border:none; border-radius:10px; background:#019aff; color:var(--app-text-inverse); cursor:pointer; font-weight:800;">保存</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    this.memoryPlacesDialogOverlay = overlay;
    this.memoryPlacesDialog = dialog;
    this.memoryPlacesChecks = {
      chat: dialog.querySelector('[data-place="chat"]'),
      moments: dialog.querySelector('[data-place="moments"]'),
      writing: dialog.querySelector('[data-place="writing"]'),
    };
    const close = () => this.hideMemoryPlacesDialog();
    overlay.addEventListener('click', close);
    dialog.querySelector('[data-role="close"]')?.addEventListener('click', close);
    dialog.querySelector('[data-role="cancel"]')?.addEventListener('click', close);
    dialog.querySelector('[data-role="save"]')?.addEventListener('click', () => this.saveMemoryPlacesDialog());
  }

  showMemoryPlacesDialog() {
    this.ensureMemoryPlacesDialog();
    this.refreshMemoryPlacesDialog(appSettings.get());
    if (this.memoryPlacesDialogOverlay) this.memoryPlacesDialogOverlay.style.display = 'flex';
  }

  hideMemoryPlacesDialog() {
    if (this.memoryPlacesDialogOverlay) this.memoryPlacesDialogOverlay.style.display = 'none';
  }

  saveMemoryPlacesDialog() {
    const patch = {
      memoryTableEnabledChat: this.memoryPlacesChecks.chat?.checked !== false,
      memoryTableEnabledMoments: this.memoryPlacesChecks.moments?.checked !== false,
      memoryTableEnabledWriting: this.memoryPlacesChecks.writing?.checked !== false,
    };
    appSettings.update(patch);
    Object.entries(patch).forEach(([key, value]) => {
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key, value } }));
    });
    window.dispatchEvent(new CustomEvent('memory-table-places-changed', { detail: patch }));
    this.hideMemoryPlacesDialog();
    this.updateMemoryAutoVisibility();
    window.toastr?.success?.('已更新记忆表格生效位置');
  }

  updateTemplateScriptVisibility() {
    const templateAdvancedOpen = this.isFoldExpanded(this.templateAdvancedToggle);
    const templateEnabled = Boolean(this.templateEnabledToggle?.checked);
    if (this.templateOptionsWrap) {
      this.templateOptionsWrap.style.display = templateEnabled && templateAdvancedOpen ? 'flex' : 'none';
    }
    if (this.templateBeforeToggle) this.templateBeforeToggle.disabled = !templateEnabled || !templateAdvancedOpen;
    if (this.templateAfterToggle) this.templateAfterToggle.disabled = !templateEnabled || !templateAdvancedOpen;
    if (this.templateErrorToggle) this.templateErrorToggle.disabled = !templateEnabled || !templateAdvancedOpen;

    const scriptAdvancedOpen = this.isFoldExpanded(this.scriptAdvancedToggle);
    const scriptEnabled = Boolean(this.scriptEnabledToggle?.checked);
    if (this.scriptOptionsWrap) {
      this.scriptOptionsWrap.style.display = scriptEnabled && scriptAdvancedOpen ? 'flex' : 'none';
    }
    if (this.scriptAllowVarsToggle) this.scriptAllowVarsToggle.disabled = !scriptEnabled || !scriptAdvancedOpen;
    if (this.scriptAllowMessagesToggle) this.scriptAllowMessagesToggle.disabled = !scriptEnabled || !scriptAdvancedOpen;
    if (this.scriptAllowNetworkToggle) this.scriptAllowNetworkToggle.disabled = !scriptEnabled || !scriptAdvancedOpen;
    this.updateSelectableCards();
  }

  updateShortcutButtons() {
    if (this.openSessionBtn) {
      this.openSessionBtn.disabled = typeof this.externalActions.openSession !== 'function';
    }
    if (this.openMemoryTemplatesBtn) {
      this.openMemoryTemplatesBtn.disabled = typeof this.externalActions.openMemoryTemplates !== 'function';
    }
    if (this.customBundleExportBtn) {
      this.customBundleExportBtn.disabled = typeof this.externalActions.exportCustomBundle !== 'function';
    }
  }

  ensureCustomSelectMenu() {
    if (this.customSelectMenuEl) return this.customSelectMenuEl;
    const menu = document.createElement('div');
    menu.className = 'world-app-select-menu';
    menu.style.display = 'none';
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(menu);
    this.customSelectMenuEl = menu;
    return menu;
  }

  closeCustomSelectMenu() {
    if (typeof this.customSelectMenuCleanup === 'function') {
      try { this.customSelectMenuCleanup(); } catch {}
    }
    this.customSelectMenuCleanup = null;
    this.customSelectMenuAnchor = null;
    if (this.customSelectMenuEl) {
      this.customSelectMenuEl.style.display = 'none';
      this.customSelectMenuEl.innerHTML = '';
    }
  }

  openCustomSelectMenu({ anchorEl, options = [], currentValue = '', onSelect = null } = {}) {
    if (!anchorEl) return;
    const isSameAnchorOpen =
      this.customSelectMenuAnchor === anchorEl &&
      this.customSelectMenuEl &&
      this.customSelectMenuEl.style.display !== 'none';
    if (isSameAnchorOpen) {
      this.closeCustomSelectMenu();
      return;
    }

    const menu = this.ensureCustomSelectMenu();
    const current = String(currentValue ?? '').trim();
    const opts = Array.isArray(options) ? options : [];
    menu.innerHTML = opts.map((opt) => {
      const value = String(opt?.value ?? '');
      const label = String(opt?.label ?? value).replace(/[&<>"]/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
      }[ch]));
      const selected = value === current;
      return `
        <button type="button" class="world-app-select-item ${selected ? 'is-selected' : ''}" data-value="${value.replace(/"/g, '&quot;')}">
          <span class="world-app-select-item-label">${label}</span>
          <span class="world-app-select-item-check">${selected ? '✓' : ''}</span>
        </button>
      `;
    }).join('');

    menu.querySelectorAll('.world-app-select-item').forEach((item) => {
      item.addEventListener('click', () => {
        const value = String(item.dataset.value ?? '');
        if (typeof onSelect === 'function') onSelect(value);
        this.closeCustomSelectMenu();
      });
    });

    menu.style.display = 'block';
    menu.style.visibility = 'hidden';
    menu.style.minWidth = `${Math.max(170, Math.round(anchorEl.getBoundingClientRect().width))}px`;
    menu.style.left = '0px';
    menu.style.top = '0px';

    const anchorRect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 6;
    let left = anchorRect.left;
    let top = anchorRect.bottom + gap;
    if (left + menuRect.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - menuRect.width - 8);
    }
    if (top + menuRect.height > window.innerHeight - 8) {
      top = Math.max(8, anchorRect.top - menuRect.height - gap);
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.visibility = 'visible';

    const onDocClick = (ev) => {
      const target = ev?.target;
      if (!target) return;
      if (menu.contains(target) || anchorEl.contains(target)) return;
      this.closeCustomSelectMenu();
    };
    const onResize = () => this.closeCustomSelectMenu();
    const onScroll = (ev) => {
      const target = ev?.target;
      if (target && (menu.contains(target) || anchorEl.contains(target))) return;
      this.closeCustomSelectMenu();
    };
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('touchstart', onDocClick, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    this.customSelectMenuCleanup = () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('touchstart', onDocClick, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
    };
    this.customSelectMenuAnchor = anchorEl;
  }

  refreshMemoryUpdateProfileSelectButton() {
    if (!this.memoryUpdateProfileButton || !this.memoryUpdateProfileSelect) return;
    const labelEl = this.memoryUpdateProfileButton.querySelector('.general-settings-custom-select-label');
    const current = Array.from(this.memoryUpdateProfileSelect.options || []).find((opt) => opt.value === this.memoryUpdateProfileSelect.value)
      || this.memoryUpdateProfileSelect.options?.[this.memoryUpdateProfileSelect.selectedIndex]
      || null;
    if (labelEl) {
      labelEl.textContent = current?.textContent?.trim() || this.memoryUpdateProfileButton.dataset.placeholder || '请选择';
    }
  }

  isFoldExpanded(toggle) {
    return String(toggle?.dataset?.expanded || '0') === '1';
  }

  syncAdvancedFoldVisibility() {
    const applyFold = (toggle, wrap) => {
      const expanded = this.isFoldExpanded(toggle);
      if (toggle) {
        toggle.dataset.expanded = expanded ? '1' : '0';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.setAttribute('aria-label', expanded ? '收起子项' : '展开子项');
      }
      if (wrap) {
        wrap.style.display = expanded ? 'block' : 'none';
      }
    };
    applyFold(this.uiAdvancedToggle, this.uiAdvancedWrap);
    applyFold(this.themeAdvancedToggle, this.themeAdvancedWrap);
    applyFold(this.autoImagePromptAdvancedToggle, this.autoImagePromptAdvancedWrap);
    applyFold(this.memoryAdvancedToggle, this.memoryAdvancedWrap);
    applyFold(this.templateAdvancedToggle, this.templateAdvancedWrap);
    applyFold(this.scriptAdvancedToggle, this.scriptAdvancedWrap);
  }

  scrollFoldSectionIntoView(toggle, wrap) {
    const container = this.modalElement || this.element?.querySelector('.general-settings-modal');
    if (!(container instanceof HTMLElement)) return;
    const anchor = (wrap?.firstElementChild instanceof HTMLElement
      ? wrap.firstElementChild
      : (wrap instanceof HTMLElement ? wrap : toggle));
    if (!(anchor instanceof HTMLElement)) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const containerRect = container.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        const rawTop = container.scrollTop + (anchorRect.top - containerRect.top) - 12;
        const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
        const nextTop = Math.max(0, Math.min(maxTop, Math.round(rawTop)));
        container.scrollTo({ top: nextTop, behavior: 'smooth' });
      });
    });
  }

  toggleAdvancedSection(toggle, wrap, afterToggle = null) {
    if (!toggle) return;
    const nextExpanded = !this.isFoldExpanded(toggle);
    toggle.dataset.expanded = nextExpanded ? '1' : '0';
    this.syncAdvancedFoldVisibility();
    if (typeof afterToggle === 'function') afterToggle(nextExpanded);
    if (nextExpanded) this.scrollFoldSectionIntoView(toggle, wrap);
  }

  revealRichIframeScriptsSetting() {
    if (!this.uiAdvancedToggle || !this.uiAdvancedWrap || !this.richIframeScriptsToggle) return false;
    if (!this.isFoldExpanded(this.uiAdvancedToggle)) {
      this.uiAdvancedToggle.dataset.expanded = '1';
      this.syncAdvancedFoldVisibility();
    }
    this.scrollFoldSectionIntoView(this.uiAdvancedToggle, this.uiAdvancedWrap);
    return true;
  }

  initSelectableCards() {
    if (!this.element) return;
    const labels = this.element.querySelectorAll('.general-settings-toggle-row');
    labels.forEach((label) => {
      if (!label.querySelector('input[type="checkbox"], input[type="radio"]')) return;
      if (label.closest('.general-settings-fold-content') && !label.classList.contains('general-settings-toggle-subrow')) {
        label.classList.add('general-settings-toggle-subrow');
      }
    });
    this.updateSelectableCards();
  }

  updateSelectableCards() {
    if (!this.element) return;
    const inputs = this.element.querySelectorAll('input[type="checkbox"], input[type="radio"]');
    inputs.forEach((input) => {
      const label = input.closest('label');
      if (!label || !label.classList.contains('general-settings-toggle-row')) return;
      const checked = Boolean(input.checked);
      const disabled = Boolean(input.disabled);
      label.classList.toggle('is-on', checked);
      label.classList.toggle('is-off', !checked);
      label.classList.toggle('is-disabled', disabled);
      if (label.querySelector('.general-settings-risk')) {
        label.classList.toggle('has-risk', checked);
      }
    });
  }

  handleCardPointerDown(label, event) {
    if (!label || label.classList.contains('is-disabled') || label.classList.contains('general-settings-toggle-subrow')) return;
    label.classList.remove('is-bounce');
    label.classList.add('is-pressing');
    this.spawnCardRipple(label, event);
  }

  handleCardPointerUp(label) {
    if (!label || label.classList.contains('general-settings-toggle-subrow')) return;
    label.classList.remove('is-pressing');
    label.classList.remove('is-bounce');
    // Restart animation so rapid taps still produce a clear elastic response.
    void label.offsetWidth;
    label.classList.add('is-bounce');
    if (label.__cardBounceTimer) clearTimeout(label.__cardBounceTimer);
    label.__cardBounceTimer = setTimeout(() => {
      label.classList.remove('is-bounce');
      label.__cardBounceTimer = null;
    }, 240);
  }

  spawnCardRipple(label, event) {
    if (!label) return;
    const rect = label.getBoundingClientRect();
    const x = Number.isFinite(event?.clientX) ? (event.clientX - rect.left) : (rect.width / 2);
    const y = Number.isFinite(event?.clientY) ? (event.clientY - rect.top) : (rect.height / 2);
    const size = Math.max(rect.width, rect.height) * 2.1;
    const ripple = document.createElement('span');
    ripple.className = 'general-settings-ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
    label.appendChild(ripple);
  }

  async refreshMemoryUpdateProfiles() {
    if (!this.memoryUpdateProfileSelect) return;
    try {
      await this.configManager.load();
      const profiles = this.configManager.getProfiles();
      const activeId = this.configManager.getActiveProfileId();
      const current = appSettings.get().memoryUpdateProfileId || activeId || '';
      this.memoryUpdateProfileSelect.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = profiles.length ? '选择 API 配置…' : '暂无配置';
      this.memoryUpdateProfileSelect.appendChild(placeholder);
      profiles.forEach((profile) => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.id;
        if (profile.id === current) option.selected = true;
        this.memoryUpdateProfileSelect.appendChild(option);
      });
    } catch {}
    this.refreshMemoryUpdateProfileSelectButton();
  }

  ensureStyles() {
    if (document.getElementById('general-settings-style')) return;
    const style = document.createElement('style');
    style.id = 'general-settings-style';
    style.textContent = `
      #general-settings-overlay {
        background: rgba(15, 23, 42, 0.42) !important;
        backdrop-filter: blur(2px);
      }
      #general-settings-panel {
        width: min(94vw, 460px);
      }
      /* 电脑版适配：加宽面板，卡片流成两栏（不切分单卡），充分利用横向空间 */
      @media (min-width: 840px) and (pointer: fine) {
        #general-settings-panel {
          width: min(92vw, 920px);
        }
        #general-settings-panel .general-settings-cards {
          columns: 2;
          column-gap: 16px;
        }
        #general-settings-panel .general-settings-cards .general-settings-card {
          break-inside: avoid;
          margin-top: 0;
        }
      }
      #general-settings-panel .general-settings-modal {
        width: 100%;
        padding: 16px;
        background: linear-gradient(180deg, var(--app-surface-card) 0%, var(--app-surface-subtle) 100%);
        border: 1px solid var(--app-border-default);
        border-radius: 16px;
        box-shadow: 0 12px 34px rgba(15, 23, 42, 0.22);
        max-height: calc(100vh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 20px);
        overflow-y: auto;
      }
      #general-settings-panel .general-settings-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      #general-settings-panel .general-settings-title {
        margin: 0;
        color: var(--app-text-primary);
        font-size: 18px;
        font-weight: 800;
        letter-spacing: 0.2px;
      }
      #general-settings-panel .general-settings-close {
        width: 30px;
        height: 30px;
        border: 1px solid var(--app-border-default);
        border-radius: 10px;
        background: var(--app-surface-card);
        color: var(--app-text-primary);
        font-size: 18px;
        cursor: pointer;
      }
      #general-settings-panel .general-settings-subtitle {
        color: var(--app-text-muted);
        font-size: 12px;
        margin-bottom: 12px;
      }
      #general-settings-panel .general-settings-card {
        margin: 8px 0 12px;
        padding: 14px;
        border: 1px solid var(--app-border-default);
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.04);
      }
      #general-settings-panel .general-settings-card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 12px;
      }
      #general-settings-panel .general-settings-card-title {
        font-size: 13px;
        color: var(--app-text-secondary);
        font-weight: 700;
        margin-bottom: 0;
      }
      #general-settings-panel .general-settings-card-note {
        margin-top: 4px;
        color: var(--app-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      #general-settings-panel .general-settings-subcard {
        margin-top: 10px;
        padding: 12px;
        border: 1px solid var(--app-border-default);
        border-radius: 14px;
        background: var(--app-surface-subtle);
      }
      #general-settings-panel .general-settings-subcard + .general-settings-subcard {
        margin-top: 10px;
      }
      #general-settings-panel .general-settings-subcard-title {
        font-size: 12px;
        line-height: 1.4;
        color: var(--app-text-secondary);
        font-weight: 700;
      }
      #general-settings-panel .general-settings-subcard-note {
        margin-top: 4px;
        color: var(--app-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      #general-settings-panel .general-settings-setting-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      #general-settings-panel .general-settings-setting-list-sub {
        gap: 8px;
      }
      #general-settings-panel .general-settings-risk {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-left: 2px;
        min-height: 20px;
        padding: 0 8px;
        font-size: 10px;
        line-height: 20px;
        border-radius: 999px;
        border: none;
        color: var(--app-text-inverse);
        background: #ef4444;
        font-weight: 800;
        letter-spacing: 0.2px;
        vertical-align: middle;
      }
      #general-settings-panel #general-template-options,
      #general-settings-panel #general-script-options,
      #general-settings-panel #general-memory-auto-options,
      #general-settings-panel #general-memory-budget-block {
        margin-top: 10px !important;
        padding: 12px;
        border-radius: 14px;
        border: 1px solid var(--app-border-default);
        background: var(--app-surface-subtle);
      }
      #general-settings-panel .general-settings-inline-actions {
        display: flex;
        align-items: stretch;
        gap: 8px;
        margin-top: 4px;
      }
      #general-settings-panel .general-settings-inline-actions .world-app-select-btn {
        flex: 1 1 auto;
        min-width: 0;
      }
      #general-settings-panel .general-settings-inline-actions .world-app-select-btn.is-disabled {
        opacity: 0.6;
        cursor: default;
      }
      #general-settings-panel .general-settings-theme-actions .general-settings-manage-btn {
        min-width: 56px;
      }
      #general-settings-panel .general-settings-range-wrap {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #general-settings-panel .general-settings-range {
        flex: 1 1 auto;
        width: 100%;
        accent-color: #0ea5e9;
      }
      #general-settings-panel .general-settings-range-value {
        flex: 0 0 auto;
        min-width: 48px;
        text-align: right;
        color: var(--app-accent-strong, #2563eb);
        font-size: 12px;
        font-weight: 800;
      }
      #general-settings-panel .general-settings-manage-btn {
        flex: 0 0 auto;
        min-width: 62px;
        padding: 0 12px;
        border-radius: 12px;
        border: 1px solid var(--app-border-default);
        background: var(--app-surface-card);
        color: var(--app-text-secondary);
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      #general-settings-panel .general-settings-manage-btn:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      #general-settings-panel .general-settings-fold-btn {
        min-width: auto;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid var(--app-border-default);
        border-radius: 999px;
        background: var(--app-surface-subtle);
        color: var(--app-text-muted);
        padding: 0 10px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 700;
        transition:
          background 180ms ease,
          border-color 180ms ease,
          color 180ms ease,
          transform 160ms ease;
      }
      #general-settings-panel .general-settings-fold-btn:hover {
        background: var(--app-accent-soft, #eff6ff);
        border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.35);
        color: var(--app-accent-strong, #2563eb);
      }
      #general-settings-panel .general-settings-fold-btn:active {
        transform: scale(0.92);
      }
      #general-settings-panel .general-settings-fold-btn:focus-visible {
        outline: 2px solid rgba(14, 165, 233, 0.28);
        outline-offset: 1px;
      }
      #general-settings-panel .general-settings-fold-btn[data-expanded='1'] {
        color: var(--app-accent-strong, #2563eb);
        background: var(--app-accent-soft, #eff6ff);
        border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.35);
      }
      #general-settings-panel .general-settings-fold-btn-label {
        white-space: nowrap;
      }
      #general-settings-panel .general-settings-fold-btn svg {
        width: 16px;
        height: 16px;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
        transition: transform 250ms cubic-bezier(0.2, 0.9, 0.2, 1);
      }
      #general-settings-panel .general-settings-fold-btn[data-expanded='1'] svg {
        transform: rotate(180deg);
      }
      #general-settings-panel .general-settings-inline-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #general-settings-panel .general-settings-inline-row > label {
        flex: 1 1 auto;
      }
      #general-settings-panel .general-settings-inline-row .general-settings-fold-btn {
        flex: 0 0 auto;
      }
      #general-settings-panel .general-settings-fold-content {
        margin-top: 12px;
        padding-top: 12px;
        border-top: 1px dashed var(--app-border-default);
      }
      #general-settings-panel .general-settings-toggle-row {
        position: relative;
        user-select: none;
        border: 1px solid var(--app-border-default);
        border-radius: 14px;
        padding: 12px;
        background: var(--app-surface-card);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        transition:
          background 300ms ease-in-out,
          border-color 300ms ease-in-out,
          box-shadow 300ms ease-in-out;
      }
      #general-settings-panel .general-settings-toggle-row:hover {
        border-color: var(--app-border-strong);
      }
      #general-settings-panel .general-settings-toggle-row.is-on {
        background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.05);
        border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.3);
        box-shadow: 0 8px 18px rgba(var(--app-accent-rgb, 37, 99, 235), 0.06);
      }
      #general-settings-panel .general-settings-toggle-row.is-off {
        background: var(--app-surface-card);
        border-color: var(--app-border-default);
      }
      #general-settings-panel .general-settings-toggle-row.is-on.has-risk {
        background: #fff7f7;
        border-color: #fecaca;
        box-shadow: 0 8px 18px rgba(239, 68, 68, 0.08);
      }
      #general-settings-panel .general-settings-toggle-row.is-disabled {
        opacity: 0.56;
        cursor: not-allowed;
      }
      #general-settings-panel .general-settings-toggle-row.general-settings-toggle-subrow {
        border-radius: 12px;
        padding: 10px 12px;
      }
      #general-settings-panel .general-settings-row-main {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }
      #general-settings-panel .general-settings-row-icon {
        width: 36px;
        height: 36px;
        border-radius: 12px;
        background: var(--app-surface-hover);
        color: var(--app-text-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 36px;
        transition:
          background 220ms ease,
          color 220ms ease;
      }
      #general-settings-panel .general-settings-row-icon svg {
        width: 18px;
        height: 18px;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        fill: none;
      }
      #general-settings-panel .general-settings-toggle-row.is-on .general-settings-row-icon {
        background: rgba(var(--app-accent-rgb, 37, 99, 235), 0.12);
        color: var(--app-accent-strong, #2563eb);
      }
      #general-settings-panel .general-settings-toggle-row.has-risk.is-on .general-settings-row-icon {
        background: #fee2e2;
        color: #dc2626;
      }
      #general-settings-panel .general-settings-row-copy {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      #general-settings-panel .general-settings-row-title {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        color: var(--app-text-primary);
        font-size: 14px;
        font-weight: 700;
        line-height: 1.35;
      }
      #general-settings-panel .general-settings-row-desc {
        color: var(--app-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      #general-settings-panel .general-settings-control {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #general-settings-panel .general-settings-switch {
        position: relative;
        width: 44px;
        height: 26px;
        border-radius: 999px;
        background: var(--app-border-strong);
        transition: background 200ms ease;
      }
      #general-settings-panel .general-settings-switch::after {
        content: '';
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        background: var(--app-surface-card);
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.22);
        transition: transform 180ms ease;
      }
      #general-settings-panel .general-settings-toggle-row.is-on .general-settings-switch {
        background: var(--app-accent-strong, #2563eb);
      }
      #general-settings-panel .general-settings-toggle-row.is-on .general-settings-switch::after {
        transform: translateX(18px);
      }
      #general-settings-panel .general-settings-radio {
        position: relative;
        width: 22px;
        height: 22px;
        border-radius: 999px;
        border: 2px solid var(--app-border-strong);
        background: var(--app-surface-card);
        box-sizing: border-box;
      }
      #general-settings-panel .general-settings-radio::after {
        content: '';
        position: absolute;
        top: 50%;
        left: 50%;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--app-accent-strong, #2563eb);
        transform: translate(-50%, -50%) scale(0);
        transition: transform 160ms ease;
      }
      #general-settings-panel .general-settings-toggle-row.is-on .general-settings-radio {
        border-color: rgba(var(--app-accent-rgb, 37, 99, 235), 0.6);
        background: var(--app-accent-soft, #eff6ff);
      }
      #general-settings-panel .general-settings-toggle-row.is-on .general-settings-radio::after {
        transform: translate(-50%, -50%) scale(1);
      }
      #general-settings-panel .general-settings-input-row {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 12px;
        border: 1px solid var(--app-border-default);
        border-radius: 14px;
        padding: 12px;
        background: var(--app-surface-card);
      }
      #general-settings-panel .general-settings-input-control {
        flex: 0 0 auto;
        width: 100%;
        min-width: 0;
      }
      #general-settings-panel .general-settings-input-control-row {
        width: 100%;
      }
      #general-settings-panel .general-settings-number-input,
      #general-settings-panel .general-settings-select {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid var(--app-border-default);
        border-radius: 10px;
        font-size: 13px;
        background: var(--app-surface-card);
        color: var(--app-text-primary);
      }
      #general-settings-panel .general-settings-select option {
        background: var(--app-surface-card);
        color: var(--app-text-primary);
      }
      #general-settings-panel .general-settings-inline-hint {
        margin-top: 8px;
        color: var(--app-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      #general-settings-panel .general-settings-field-block {
        margin-top: 10px;
      }
      #general-settings-panel .general-settings-field-label {
        display: block;
        margin-bottom: 6px;
        color: var(--app-text-primary);
        font-size: 12px;
        font-weight: 700;
      }
      #general-settings-panel .general-settings-field-help {
        display: block;
        margin-top: 6px;
        color: var(--app-text-muted);
        font-size: 12px;
        line-height: 1.45;
      }
      #general-settings-panel .general-settings-toggle-row input[type='checkbox'],
      #general-settings-panel .general-settings-toggle-row input[type='radio'] {
        position: absolute;
        width: 0;
        height: 0;
        margin: 0;
        opacity: 0;
        pointer-events: none;
      }
      #general-settings-panel input[type='number'],
      #general-settings-panel select {
        border-color: var(--app-border-default) !important;
        background: var(--app-surface-card);
      }
      #general-settings-panel .general-settings-shortcut-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #general-settings-panel .general-settings-shortcut-btn {
        border: 1px solid var(--app-border-default) !important;
        border-radius: 10px !important;
        background: var(--app-surface-card) !important;
        color: var(--app-text-primary) !important;
        font-weight: 700;
        padding: 8px 10px !important;
        cursor: pointer;
        text-align: center;
      }
      #general-settings-panel .general-settings-shortcut-btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      #general-settings-panel button[id^='general-bundle-'],
      #general-settings-panel #general-clean-wallpapers {
        border: 1px solid var(--app-border-default) !important;
        border-radius: 10px !important;
        background: var(--app-surface-card) !important;
        color: var(--app-text-primary) !important;
        font-weight: 600;
        padding: 7px 12px !important;
      }
      #general-settings-panel #general-clean-wallpapers {
        border-color: #fecaca !important;
        background: #fff5f5 !important;
        color: #b91c1c !important;
      }
      #general-settings-panel #general-settings-done {
        border-color: #0ea5e9 !important;
        background: #0ea5e9 !important;
        color: var(--app-text-inverse) !important;
        font-weight: 700;
      }
    `;
    document.head.appendChild(style);
  }

  getSettingIcon(name = 'sliders') {
    return GENERAL_SETTINGS_ICONS[name] || GENERAL_SETTINGS_ICONS.sliders;
  }

  renderFoldButton(id, label = '高级选项', guideTarget = '') {
    const guideAttr = String(guideTarget || '').trim()
      ? ` data-maid-guide-target="${String(guideTarget).replace(/"/g, '&quot;')}"`
      : '';
    return `
      <button type="button" id="${id}" class="general-settings-fold-btn" data-expanded="0" aria-expanded="false"${guideAttr}>
        <span class="general-settings-fold-btn-label">${t(label)}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
    `.trim();
  }

  renderSettingRow({
    id,
    title,
    description = '',
    icon = 'sliders',
    type = 'checkbox',
    name = '',
    value = '',
    nested = false,
    risk = false,
    extraClass = '',
    guideTarget = '',
  } = {}) {
    const guideAttr = String(guideTarget || '').trim()
      ? ` data-maid-guide-target="${String(guideTarget).replace(/"/g, '&quot;')}"`
      : '';
    const inputAttrs = type === 'radio'
      ? `type="radio" id="${id}" name="${name}" value="${value}"`
      : `type="checkbox" id="${id}"`;
    const classes = [
      'general-settings-toggle-row',
      nested ? 'general-settings-toggle-subrow' : '',
      extraClass,
    ].filter(Boolean).join(' ');
    const control = type === 'radio'
      ? '<span class="general-settings-control general-settings-radio" aria-hidden="true"></span>'
      : '<span class="general-settings-control general-settings-switch" aria-hidden="true"></span>';
    return `
      <label class="${classes}"${guideAttr}>
        <input ${inputAttrs}>
        <span class="general-settings-row-main">
          <span class="general-settings-row-icon" aria-hidden="true">${this.getSettingIcon(icon)}</span>
          <span class="general-settings-row-copy">
            <span class="general-settings-row-title${description ? ' has-help' : ''}"${description ? ` data-help="${(description || '').replace(/"/g, '&quot;')}" data-help-mode="press"` : ''}>${title}${risk ? '<span class="general-settings-risk">高风险</span>' : ''}</span>
          </span>
        </span>
        ${control}
      </label>
    `.trim();
  }

  renderInputRow({ title, description = '', icon = 'sliders', control = '' } = {}) {
    return `
      <div class="general-settings-input-row">
        <div class="general-settings-row-main">
          <span class="general-settings-row-icon" aria-hidden="true">${this.getSettingIcon(icon)}</span>
          <span class="general-settings-row-copy">
            <span class="general-settings-row-title${description ? ' has-help' : ''}"${description ? ` data-help="${(description || '').replace(/"/g, '&quot;')}"` : ''}>${title}</span>
          </span>
        </div>
        <div class="general-settings-input-control-row">
          <div class="general-settings-input-control">${control}</div>
        </div>
      </div>
    `.trim();
  }

  createUI() {
    this.ensureStyles();
    this.overlayElement = document.createElement('div');
    this.overlayElement.id = 'general-settings-overlay';
    this.overlayElement.style.cssText = `
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      z-index: 20000;
    `;
    this.overlayElement.onclick = () => this.hide();

    this.element = document.createElement('div');
    this.element.id = 'general-settings-panel';
    this.element.innerHTML = `
      <div class="general-settings-modal">
        <div class="general-settings-header">
          <h2 class="general-settings-title">通用设定</h2>
          <button id="general-settings-close" class="general-settings-close">×</button>
        </div>
        <div class="general-settings-subtitle">外观、图片、记忆、脚本等设定。</div>

        <div class="general-settings-cards">
        <div class="general-settings-card" data-maid-action-key="general-settings.language">
          <div class="general-settings-card-head">
            <div>
              <div class="general-settings-card-title has-help" data-help="选择界面语言；更改后需要重启应用。">语言与地区</div>
            </div>
          </div>
          <div class="general-settings-setting-list">
            ${this.renderInputRow({
              title: '界面语言',
              description: '首次启动时选择的语言，也可以在这里更改。',
              icon: 'sliders',
              control: `
                <select id="general-language-select" class="general-settings-select" style="display:none;">
                  ${LANGUAGE_OPTIONS.map(option => `<option value="${option.value}">${option.label}</option>`).join('')}
                </select>
                <button type="button" id="general-language-btn" class="world-app-select-btn" style="margin-top:0;">
                  <span class="general-settings-custom-select-label">选择语言</span>
                  <span class="world-app-select-btn-chevron">▾</span>
                </button>
                <div id="general-language-status" class="general-settings-inline-hint">更改语言后需要重启应用。</div>
              `,
            })}
          </div>
        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-head">
            <div>
              <div class="general-settings-card-title has-help" data-help="内建明暗主题、主题导入导出，以及基础显示风格。">外观与主题</div>
            </div>
            ${this.renderFoldButton('general-theme-advanced-toggle', '更多外观')}
          </div>

          <div class="general-settings-setting-list">
            ${this.renderInputRow({
              title: '当前主题',
              description: '切换内建或已导入的主题；导入 ST 主题会自动适配。',
              icon: 'palette',
              control: `
                <select id="general-theme-preset-select" class="general-settings-select" style="display:none;"></select>
                <div class="general-settings-inline-actions general-settings-theme-actions">
                  <button type="button" id="general-theme-preset-btn" class="world-app-select-btn" style="margin-top:0;">
                    <span class="general-settings-custom-select-label">选择主题…</span>
                    <span class="world-app-select-btn-chevron">▾</span>
                  </button>
                  <button type="button" id="general-theme-import" class="general-settings-manage-btn">导入</button>
                  <button type="button" id="general-theme-export" class="general-settings-manage-btn">导出</button>
                </div>
                <div id="general-theme-status" class="general-settings-inline-hint">内建主题 · 浅色</div>
                <input type="file" id="general-theme-file" accept=".json,application/json" style="display:none;">
              `,
            })}
          </div>

          <div id="general-theme-advanced" class="general-settings-fold-content" style="display:none;">
            <div class="general-settings-setting-list">
            ${this.renderInputRow({
              title: '头像样式',
              description: '聊天、联系人等头像的圆角形态。',
              icon: 'sliders',
              control: `
                <select id="general-theme-avatar-style-select" class="general-settings-select" style="display:none;"></select>
                <div class="general-settings-inline-actions">
                  <button type="button" id="general-theme-avatar-style-btn" class="world-app-select-btn" style="margin-top:0;">
                    <span class="general-settings-custom-select-label">头像样式</span>
                    <span class="world-app-select-btn-chevron">▾</span>
                  </button>
                </div>
              `,
            })}
            ${this.renderInputRow({
              title: '聊天风格',
              description: '气泡式或更偏文档式的显示方式。',
              icon: 'expand',
              control: `
                <select id="general-theme-chat-display-select" class="general-settings-select" style="display:none;"></select>
                <div class="general-settings-inline-actions">
                  <button type="button" id="general-theme-chat-display-btn" class="world-app-select-btn" style="margin-top:0;">
                    <span class="general-settings-custom-select-label">聊天风格</span>
                    <span class="world-app-select-btn-chevron">▾</span>
                  </button>
                </div>
              `,
            })}
            ${this.renderInputRow({
              title: '通知位置',
              description: '通知提示出现的位置。',
              icon: 'reply',
              control: `
                <select id="general-theme-toast-position-select" class="general-settings-select" style="display:none;"></select>
                <div class="general-settings-inline-actions">
                  <button type="button" id="general-theme-toast-position-btn" class="world-app-select-btn" style="margin-top:0;">
                    <span class="general-settings-custom-select-label">通知位置</span>
                    <span class="world-app-select-btn-chevron">▾</span>
                  </button>
                </div>
              `,
            })}
            ${this.renderInputRow({
              title: '字体缩放',
              description: '整体界面的字号大小。',
              icon: 'history',
              control: `
                <div class="general-settings-range-wrap">
                  <input type="range" id="general-theme-font-scale" class="general-settings-range" min="85" max="135" step="1" value="100">
                  <span id="general-theme-font-scale-value" class="general-settings-range-value">100%</span>
                </div>
              `,
            })}
            ${this.renderSettingRow({
              id: 'general-theme-reduced-motion',
              title: '降低动画强度',
              description: '减少过渡与动画，视觉更稳。',
              icon: 'reply',
            })}
            ${this.renderSettingRow({
              id: 'general-theme-compact-input',
              title: '紧凑输入区',
              description: '压缩输入栏高度，更紧凑。',
              icon: 'expand',
            })}
            ${this.renderSettingRow({
              id: 'general-theme-hide-avatars',
              title: '隐藏聊天头像',
              description: '隐藏对话气泡里的头像，只留消息。',
              icon: 'palette',
            })}
            </div>
          </div>
        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-head">
            <div>
              <div class="general-settings-card-title has-help" data-help="控制 APP 自有结构化通道与旧版文本协议之间的选择。">模型输出</div>
            </div>
          </div>
          <div class="general-settings-setting-list">
            ${this.renderSettingRow({
              id: 'general-traditional-model-output-protocol',
              title: '使用传统模型输出协议（兼容模式）',
              description: '部分模型或中转不支持结构化调用时可开启；女仆会改用旧版文本规划，后续支持结构化的聊天也会同步切换。创意写作不受影响。',
              icon: 'code',
            })}
          </div>
        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-head">
            <div>
              <div class="general-settings-card-title has-help" data-help="AI 回复后自动提取标签、生成配图。">AI 图片生成</div>
            </div>
            ${this.renderFoldButton('general-auto-image-prompt-advanced-toggle', '自动生图策略')}
          </div>

          <div class="general-settings-setting-list">
            ${this.renderSettingRow({
              id: 'general-auto-image-prompt',
              title: 'AI 回复后自动生图',
              description: '开启后，AI 会在合适时机输出配图标签，本地据此自动生成图片。',
              icon: 'palette',
            })}
            ${this.renderSettingRow({
              id: 'general-auto-image-prompt-writing',
              title: '创意写作自动生图',
              description: '创意写作也按标签位置自动生成插图。',
              icon: 'book-open',
            })}
            ${this.renderInputRow({
              title: '生图提示词风格',
              description: '调整生图标签的提示词要求；实际生图仍用当前图片模型。',
              icon: 'sliders',
              control: `
                <select id="general-auto-image-prompt-style" class="general-settings-select">
                  <option value="auto">自动匹配当前图片模型</option>
                  <option value="natural">自然语言提示词</option>
                  <option value="nai_tags">NAI / 标签式提示词</option>
                </select>
              `,
            })}
          </div>
          <div id="general-auto-image-prompt-advanced" class="general-settings-fold-content" style="display:none;">
            <div class="general-settings-setting-list-sub">
              ${this.renderInputRow({
                title: '触发策略',
                description: '保守会减少误触发；积极更容易让角色在视觉场景中发图。',
                icon: 'sliders',
                control: `
                  <select id="general-auto-image-prompt-decision-mode" class="general-settings-select">
                    <option value="conservative">保守</option>
                    <option value="standard">标准</option>
                    <option value="aggressive">积极</option>
                  </select>
                `,
              })}
              ${this.renderInputRow({
                title: '动态配图模式',
                description: '动态内容的配图格式。',
                icon: 'palette',
                control: `
                  <select id="general-auto-image-prompt-moment-media-mode" class="general-settings-select">
                    <option value="placeholder">占位图片</option>
                    <option value="image_prompt">文生图</option>
                    <option value="ai">AI决策</option>
                  </select>
                `,
              })}
              ${this.renderInputRow({
                title: '冷却轮数',
                description: '两次自动生图之间至少间隔几条回复；0 不限制。',
                icon: 'history',
                control: '<input type="number" id="general-auto-image-prompt-cooldown" class="general-settings-number-input" min="0" step="1" value="0">',
              })}
              ${this.renderInputRow({
                title: '窗口轮数',
                description: '频率限制的统计窗口；0 不启用。',
                icon: 'history',
                control: '<input type="number" id="general-auto-image-prompt-window-rounds" class="general-settings-number-input" min="0" step="1" value="0">',
              })}
              ${this.renderInputRow({
                title: '窗口内最多张数',
                description: '窗口轮数内最多自动生成几张；0 不限制。',
                icon: 'palette',
                control: '<input type="number" id="general-auto-image-prompt-window-max" class="general-settings-number-input" min="0" step="1" value="0">',
              })}
              ${this.renderInputRow({
                title: '最大并发数',
                description: '同时进行的自动生图数，超出排队。',
                icon: 'sliders',
                control: '<input type="number" id="general-auto-image-prompt-max-concurrency" class="general-settings-number-input" min="1" step="1" value="1">',
              })}
              ${this.renderInputRow({
                title: '单次最多图片标签',
                description: '单条回复最多自动生成几张；0 不限制，超出的显示为可重试占位。',
                icon: 'image',
                control: '<input type="number" id="general-auto-image-prompt-max-per-response" class="general-settings-number-input" min="0" step="1" value="0">',
              })}
              ${this.renderSettingRow({
                id: 'general-auto-image-prompt-skip-repeated',
                title: '跳过重复提示词',
                description: '提示词与上次相同时不重复生成。',
                icon: 'reply',
                nested: true,
              })}
            </div>
          </div>
        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-head">
            <div>
              <div class="general-settings-card-title has-help" data-help="显示、动画与调试辅助选项。">界面与调试</div>
            </div>
            ${this.renderFoldButton('general-ui-advanced-toggle', '调试选项', 'general-ui-advanced')}
          </div>

          <div class="general-settings-setting-list">
            ${this.renderSettingRow({
              id: 'general-typing-dots',
              title: '回复动画',
              description: '回复时显示跳动的小点动画。',
              icon: 'reply',
            })}
            <div data-reply-notification-settings hidden>
              ${this.renderSettingRow({
                id: 'general-reply-notification-enabled',
                title: '回复完成通知',
                description: '切换到其他应用或最小化后，回复完成时发送 Windows 系统通知。点击返回对应会话，横幅与声音遵循系统设置。',
                icon: 'bell',
              })}
            </div>
            ${this.renderSettingRow({
              id: 'general-creative-wide',
              title: '创意写作气泡加宽',
              description: '创意写作用更舒展的宽气泡版式。',
              icon: 'expand',
            })}
            ${this.renderInputRow({
              title: '聊天前文注入条数',
              description: '每次请求注入的历史消息条数；0 全部注入（按预算自动裁剪）。',
              icon: 'history',
              control: '<input type="number" id="general-chat-history-max" min="0" step="1" class="general-settings-number-input">',
            })}
            ${this.renderInputRow({
              title: '创意写作注入条数',
              description: '创意写作注入的历史轮数；0 全部注入。',
              icon: 'history',
              control: '<input type="number" id="general-creative-history" min="0" step="1" class="general-settings-number-input">',
            })}
          </div>

          <div id="general-ui-advanced" class="general-settings-fold-content" style="display:none;">
            <div class="general-settings-subcard">
              <div class="general-settings-subcard-title has-help" data-help="仅在排查问题或验证渲染时开启。">调试与实验功能</div>
              <div class="general-settings-setting-list general-settings-setting-list-sub">
                ${this.renderSettingRow({
                  id: 'general-debug-toggle',
                  title: '显示诊断按钮',
                  description: '显示诊断入口，用于导出资料包和错误日志。',
                  icon: 'bug',
                  nested: true,
                })}
                ${this.renderSettingRow({
                  id: 'general-debug-logs',
                  title: '记录诊断日志',
                  description: '仅在需要排查问题时开启，保留更多运行日志。',
                  icon: 'log',
                  nested: true,
                })}
                ${this.renderSettingRow({
                  id: 'general-rich-iframe-scripts',
                  title: '富文本 iframe 执行脚本',
                  description: '允许 iframe 执行脚本、放宽安全限制；仅信任来源时开启。',
                  icon: 'code',
                  nested: true,
                  risk: true,
                  guideTarget: 'general-rich-iframe-scripts',
                })}
                ${this.renderSettingRow({
                  id: 'general-toast-enabled',
                  title: '应用内提示',
                  description: '在应用内显示操作结果与状态提示。',
                  icon: 'bell',
                  nested: true,
                })}
              </div>
            </div>
          </div>
        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-head">
            <div>
              <div class="general-settings-card-title has-help" data-help="角色绑定、时间上下文与记忆系统。">记忆与角色</div>
            </div>
            ${this.renderFoldButton('general-memory-advanced-toggle', '更多设置')}
          </div>

          <div class="general-settings-setting-list">
            ${this.renderSettingRow({
              id: 'general-persona-bind',
              title: '角色卡绑定联系人 / 聊天记录',
              description: '不同角色卡各自保留联系人与聊天上下文。',
              icon: 'link',
            })}
            ${this.renderSettingRow({
              id: 'general-prompt-time',
              title: '发送当前时间给 AI',
              description: '发送当前真实时间，并为聊天历史标注日期与时段。',
              icon: 'clock',
            })}
            ${this.renderSettingRow({
              id: 'general-chat-ai-time',
              title: '使用 AI 回复时间',
              description: '默认关闭，聊天和动态使用实际接收时间。开启后恢复带时间字段的旧格式，并显示 AI 提供的时间；仅影响之后收到的消息。',
              icon: 'clock',
            })}
            ${this.renderSettingRow({
              id: 'general-moment-comment-side-effects',
              title: '动态评论联动私聊 / 群聊',
              description: '允许动态评论任务在公开评论外，少量写入相关私聊或群聊。',
              icon: 'reply',
            })}
            ${this.renderSettingRow({
              id: 'general-memory-enabled',
              title: '启用记忆系统',
              description: '关闭后不会发送摘要提示词，也不会读写记忆表格。',
              icon: 'brain',
            })}
          </div>

          <div class="general-settings-subcard">
            <div class="general-settings-subcard-title has-help" data-help="当前角色/会话默认的记忆结构。">记忆存储方式</div>
            <div class="general-settings-setting-list general-settings-setting-list-sub">
              ${this.renderSettingRow({
                id: 'general-memory-mode-summary',
                type: 'radio',
                name: 'general-memory-mode',
                value: 'summary',
                title: '摘要模式',
                description: '使用摘要文本积累长期记忆。',
                icon: 'notes',
                nested: true,
              })}
              ${this.renderSettingRow({
                id: 'general-memory-mode-table',
                type: 'radio',
                name: 'general-memory-mode',
                value: 'table',
                title: '记忆表格模式',
                description: '使用结构化表格保存角色、事件与状态。',
                icon: 'table',
                nested: true,
              })}
            </div>
          </div>

          <div id="general-memory-advanced" class="general-settings-fold-content" style="display:none;">
            <div style="margin-bottom: 10px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-memory-auto" style="width: 18px; height: 18px;">
                <span style="font-weight: 700;">AI 自动写入记忆表格</span>
              </label>
            </div>

            <div style="margin-left: 26px; margin-top: 8px; margin-bottom: 10px;">
              <button type="button" id="general-memory-places-btn" class="general-settings-manage-btn has-help" data-help="记忆表格在聊天、动态、创意写作里是否启用。" data-help-mode="press">生效位置</button>
            </div>

            <div id="general-memory-auto-options" style="margin-left: 26px; margin-top: 6px; display: none;">
            <div style="font-size:12px; color:var(--app-text-muted); margin-bottom:8px;">写表方式</div>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:6px;">
              <input type="radio" name="general-memory-auto-mode" id="general-memory-auto-inline" value="inline">
              <span>随聊天回复一起（同一请求）</span>
            </label>
            <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
              <input type="radio" name="general-memory-auto-mode" id="general-memory-auto-separate" value="separate">
              <span>聊天后独立请求</span>
            </label>
            <div style="margin-top: 8px; display:flex; flex-direction: column; gap: 6px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-memory-auto-confirm" style="width: 16px; height: 16px;">
                <span>写表前确认</span>
              </label>
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-memory-auto-step" style="width: 16px; height: 16px;">
                <span class="has-help" data-help="逐条弹窗确认每条指令。" data-help-mode="press">逐条执行（每条指令确认）</span>
              </label>
            </div>
            <div style="margin-top: 10px;">
              <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; font-weight:700; color:var(--app-text-primary);">
                <span class="has-help" data-help="默认 1（每轮都填）；设 3 则每 3 轮填一次。" data-help-mode="press">每 N 轮填表一次</span>
                <input type="number" id="general-memory-fill-every-n" min="1" step="1"
                       style="width: 90px; padding: 4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
              </label>
            </div>

            <div id="general-memory-update-api" style="margin-top: 10px; padding: 8px; border: 1px dashed var(--app-border-default); border-radius: 10px; display: none;">
              <div style="font-size:12px; color:var(--app-text-muted); margin-bottom:8px;">记忆更新 API</div>
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:6px;">
                <input type="radio" name="general-memory-update-api" id="general-memory-update-chat" value="chat">
                <span>使用聊天配置</span>
              </label>
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:6px;">
                <input type="radio" name="general-memory-update-api" id="general-memory-update-profile" value="profile">
                <span class="has-help" data-help="可在 API 配置里新增多个配置。" data-help-mode="press">选择 API 配置</span>
              </label>
              <select id="general-memory-update-profile-select" style="display:none;"></select>
              <div class="general-settings-inline-actions">
                <button type="button" id="general-memory-update-profile-btn" class="world-app-select-btn" data-select-id="general-memory-update-profile-select" style="margin-top:0;">
                  <span class="general-settings-custom-select-label">选择 API 配置…</span>
                  <span class="world-app-select-btn-chevron">▾</span>
                </button>
                <button type="button" id="general-memory-update-profile-manage" class="general-settings-manage-btn">管理</button>
              </div>
              <div id="general-memory-update-context" style="margin-top: 10px;">
                <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; font-weight:700; color:var(--app-text-primary);">
                  <span class="has-help" data-help="默认 6 轮（用户+助手）；0 不发送历史。" data-help-mode="press">记忆更新上下文轮数</span>
                  <input type="number" id="general-memory-update-context-rounds" min="0" step="1"
                         style="width: 90px; padding: 4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
                </label>
              </div>
            </div>
            </div>

            <div id="general-memory-budget-block" style="margin-left: 26px; margin-top: 10px; padding: 8px; border: 1px dashed var(--app-border-default); border-radius: 10px; display: none;">
            <div style="font-size:12px; color:var(--app-text-muted); margin-bottom:8px;">记忆注入与统一预算</div>

            <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
              <label class="has-help" data-help="Token 模式按统一输入预算自动分配世界书、记忆、前文和召回配额；条数模式保留直观条数限制，并在模型上下文已知时使用 Token 安全硬顶。" data-help-mode="press"
                     for="general-memory-budget-mode" style="font-size:12px; font-weight:700; color:var(--app-text-primary);">预算模式</label>
              <select id="general-memory-budget-mode" class="general-settings-select" style="min-width:150px;">
                <option value="token">Token 模式（推荐）</option>
                <option value="rows">条数模式</option>
              </select>
            </div>

            <div id="general-memory-token-budget-wrap" style="margin-top:10px;">
              <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; font-weight:700; color:var(--app-text-primary);">
                <span class="has-help" data-help="整次请求的输入总预算 B，包含人设、世界书、记忆、前文与召回；最终仍受模型上下文上限约束。" data-help-mode="press">统一输入总预算</span>
                <input type="number" id="general-memory-input-budget-tokens" min="1" step="1000"
                       style="width:110px; padding:4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
              </label>
              <small style="display:block; margin-top:4px; color:var(--app-text-muted);">单位：Token；默认 100000</small>
            </div>

            <div id="general-memory-rows-budget-wrap" style="margin-top:10px; display:none;">
              <small style="display:block; color:var(--app-text-muted); line-height:1.5;">条数模式沿用聊天前文条数和各桥接条数；模型上下文未知时不会擅自套用小上下文硬顶。</small>
            </div>

            <div style="margin-top:10px; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px;">
              <span class="has-help" data-help="记忆表格的后备行数上限。Token 模式下通常只在异常规模时触发。" data-help-mode="press"
                    style="font-size:12px; color:var(--app-text-secondary);">表格后备行数上限</span>
              <input type="number" id="general-memory-max-rows" min="1" step="10"
                     style="width:110px; padding:4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
              <span class="has-help" data-help="记忆表格旧管线的安全 Token 上限；统一预算可用时以统一预算为准。" data-help-mode="press"
                    style="font-size:12px; color:var(--app-text-secondary);">表格安全 Token 上限</span>
              <input type="number" id="general-memory-max-tokens" min="1" step="1000"
                     style="width:110px; padding:4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
            </div>

            <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--app-border-default);">
              <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--app-text-primary); font-size:12px;">
                <span class="has-help" data-help="群聊中按需参考各成员私聊记忆；关闭后不会走这条隐式跨会话通道。" data-help-mode="press">群聊参考成员私聊记忆</span>
                <input type="checkbox" id="general-memory-group-member-reference" style="width:16px; height:16px;">
              </label>
              <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; color:var(--app-text-secondary); font-size:12px;">
                <span>每张表最多注入行数</span>
                <input type="number" id="general-memory-group-member-reference-limit" min="0" step="1"
                       style="width:90px; padding:4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
              </label>
            </div>

            <div style="margin-top: 10px;">
              <div class="has-help" data-help="作用于当前聊天、动态或创意写作中启用的记忆表格；默认排在最新输入前。" style="font-size:12px; color:var(--app-text-muted); margin-bottom:6px;">记忆表格内容注入位置</div>
              <select id="general-memory-inject-position" style="display:none;">
	                <option value="after_persona">角色设定后</option>
	                <option value="template">跟随记忆模板</option>
	                <option value="system_end">系统提示末尾</option>
                <option value="before_chat">对话前</option>
                <option value="history_before">History 前</option>
                <option value="history_after">History 后</option>
                <option value="history_depth">深度注入（插入到 History 内）</option>
                <option value="before_latest_user">最新输入前</option>
                <option value="after_latest_user">最新输入后</option>
                <option value="system_end+before_chat">双重注入（系统末尾 + 对话前）</option>
              </select>
              <div class="general-settings-inline-actions">
                <button type="button" id="general-memory-inject-position-btn" class="world-app-select-btn" style="margin-top:0;">
                  <span class="general-settings-custom-select-label">注入位置</span>
                  <span class="world-app-select-btn-chevron">▾</span>
                </button>
              </div>
            </div>

	            <div id="general-memory-inject-depth-wrap" style="margin-top: 10px; display:none;">
	              <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; font-weight:700; color:var(--app-text-primary);">
	                <span class="has-help" data-help="距聊天末尾第 N 条插入；仅「深度注入」模式时生效。" data-help-mode="press">深度注入位置</span>
	                <input type="number" id="general-memory-inject-depth" min="0" step="1"
	                       style="width: 90px; padding: 4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
	              </label>
	            </div>
	          </div>

              <div id="general-memory-bridge-block" style="margin-left: 26px; margin-top: 10px; padding: 8px; border: 1px dashed var(--app-border-default); border-radius: 10px; display: none;">
                <small style="color:var(--app-text-muted); line-height:1.6; display:block;">聊天 / 创意写作会话之间的桥接请在各会话的「好友设置 → 记忆共享」中配置；动态桥接为全局设置。</small>
                <div style="display:flex; flex-direction:column; gap:8px; margin-top:8px;">
                  <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--app-text-primary); font-size:12px;">
                    <span>动态记忆注入聊天 / 创意写作</span>
                    <input type="checkbox" id="general-memory-bridge-moments-to-chat" style="width:16px; height:16px;">
                  </label>
                  <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--app-text-secondary); font-size:12px;">
                    <span>注入条数（每表，0=全部）</span>
                    <input type="number" id="general-memory-bridge-moments-to-chat-limit" min="0" step="1"
                           style="width: 90px; padding: 4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
                  </label>
                  <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--app-text-primary); font-size:12px;">
                    <span>聊天 / 群聊记忆注入动态</span>
                    <input type="checkbox" id="general-memory-bridge-chat-to-moments" style="width:16px; height:16px;">
                  </label>
                  <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--app-text-secondary); font-size:12px;">
                    <span>注入条数（每表，0=全部）</span>
                    <input type="number" id="general-memory-bridge-chat-to-moments-limit" min="0" step="1"
                           style="width: 90px; padding: 4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
                  </label>
                  <label style="display:flex; align-items:center; justify-content:space-between; gap:10px; color:var(--app-text-primary); font-size:12px;">
                    <span>创意写作记忆注入动态</span>
                    <input type="checkbox" id="general-memory-bridge-rp-to-moments" style="width:16px; height:16px;">
                  </label>
                  <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--app-text-secondary); font-size:12px;">
                    <span>注入条数（每表，0=全部）</span>
                    <input type="number" id="general-memory-bridge-rp-to-moments-limit" min="0" step="1"
                           style="width: 90px; padding: 4px 6px; border:1px solid var(--app-border-default); border-radius:8px; font-size:12px; text-align:right;">
                  </label>
                </div>
              </div>
	          </div>
	        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-head">
            <div>
              <div class="general-settings-card-title has-help" data-help="角色卡模板、脚本与扩展行为。">模板与脚本</div>
            </div>
          </div>

          <div class="general-settings-subcard">
            <div class="general-settings-card-head" style="margin-bottom: 10px;">
              <div>
                <div class="general-settings-subcard-title has-help" data-help="模板在生成前、渲染后的执行开关。">模板处理</div>
              </div>
              ${this.renderFoldButton('general-template-advanced-toggle', '模板选项')}
            </div>
            <div class="general-settings-setting-list">
              ${this.renderSettingRow({
                id: 'general-template-enabled',
                title: '启用模板处理',
                description: '模板执行的总开关。',
                icon: 'template',
              })}
            </div>
          <div id="general-template-advanced" class="general-settings-fold-content" style="display:none; margin-bottom: 10px;">
            <div id="general-template-options" style="margin-left: 26px; display:none; flex-direction:column; gap:8px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-template-before" style="width: 16px; height: 16px;">
                <span>生成前执行（Prompt）</span>
              </label>
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-template-after" style="width: 16px; height: 16px;">
                <span>渲染后执行（显示）</span>
              </label>
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-template-error" style="width: 16px; height: 16px;">
                <span>显示模板错误提示</span>
              </label>
            </div>
          </div>
          </div>

          <div class="general-settings-subcard">
            <div class="general-settings-card-head" style="margin-bottom: 10px;">
              <div>
                <div class="general-settings-subcard-title has-help" data-help="角色卡脚本的可用范围与权限。">角色卡脚本</div>
              </div>
              ${this.renderFoldButton('general-script-advanced-toggle', '脚本选项')}
            </div>
            <div class="general-settings-setting-list">
              ${this.renderSettingRow({
                id: 'general-script-enabled',
                title: '启用角色卡脚本',
                description: '允许角色卡脚本参与运行时逻辑。',
                icon: 'script',
              })}
            </div>
          <div id="general-script-advanced" class="general-settings-fold-content" style="display:none;">
            <div id="general-script-options" style="margin-left: 26px; display:none; flex-direction:column; gap:8px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-script-allow-vars" style="width: 16px; height: 16px;">
                <span>允许脚本修改变量</span>
              </label>
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-script-allow-messages" style="width: 16px; height: 16px;">
                <span>允许脚本读取聊天记录</span>
              </label>
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                <input type="checkbox" id="general-script-allow-network" style="width: 16px; height: 16px;">
                <span>允许脚本访问网络<span class="general-settings-risk">高风险</span></span>
              </label>
            </div>
          </div>
          </div>
        </div>

        <div class="general-settings-card">
          <div class="general-settings-shortcut-grid">
            <button id="general-open-session" class="general-settings-shortcut-btn">💬 会话</button>
            <button id="general-open-memory-templates" data-maid-guide-target="general-memory-templates" class="general-settings-shortcut-btn">🧠 记忆表格</button>
          </div>
        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-title">资料迁移</div>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap: wrap;">
            <button id="general-bundle-export"
                    style="padding: 6px 10px; border-radius: 8px; border: 1px solid var(--app-border-default); background: var(--app-surface-card); cursor: pointer; font-size: 12px; color: var(--app-text-primary);">
              完整备份
            </button>
            <button id="general-bundle-import"
                    style="padding: 6px 10px; border-radius: 8px; border: 1px solid var(--app-border-default); background: var(--app-surface-card); cursor: pointer; font-size: 12px; color: var(--app-text-primary);">
              导入
            </button>
            <button id="general-custom-bundle-export"
                    style="padding: 6px 10px; border-radius: 8px; border: 1px solid var(--app-border-default); background: var(--app-surface-card); cursor: pointer; font-size: 12px; color: var(--app-text-primary);">
              自定义导出
            </button>
            <span id="general-bundle-status" style="font-size: 12px; color:var(--app-text-muted);">
              完整备份聊天与资源（含连线配置，不含 API Key）
            </span>
          </div>
          <small style="color:var(--app-text-muted); display:block; margin-top:6px;">导入会自动识别完整资料包、体验包与自定义资料包；完整资料包导入会覆盖当前资料。</small>
          <div id="general-bundle-progress-wrap" style="display:none; flex-direction:column; gap:6px; margin-top:8px;">
            <div style="height:8px; border-radius:999px; background:rgba(148,163,184,0.18); overflow:hidden; position:relative;">
              <div id="general-bundle-progress-bar" style="width:0%; height:100%; border-radius:999px; background:linear-gradient(90deg, rgba(59,130,246,0.92), rgba(96,165,250,0.92)); transition:width 180ms ease;"></div>
            </div>
            <div id="general-bundle-progress-text" style="font-size:12px; color:var(--app-text-muted);">正在处理...</div>
          </div>
          <input type="file" id="general-bundle-file" accept=".zip,.aicpack,application/zip" style="display:none;">
        </div>

        <div class="general-settings-card">
          <div class="general-settings-card-title">存储清理</div>
          <div style="display:flex; align-items:center; gap:8px; flex-wrap: wrap;">
            <button id="general-clean-wallpapers"
                    style="padding: 6px 10px; border-radius: 8px; border: 1px solid var(--app-border-default); background: var(--app-surface-card); cursor: pointer; font-size: 12px; color: var(--app-text-primary);">
              清理壁纸残留
            </button>
            <span id="general-clean-wallpapers-status" style="font-size: 12px; color:var(--app-text-muted);">
              清理未引用旧文件
            </span>
          </div>
        </div>

        </div>

        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button id="general-settings-done" style="padding: 8px 14px; border-radius: 8px; border: 1px solid var(--app-border-default);
                                                   background: var(--app-surface-subtle); cursor: pointer; font-size: 14px; color: var(--app-text-secondary);">
            完成
          </button>
        </div>
      </div>
    `;
    this.element.style.cssText = `
      display: none;
      position: fixed;
      top: calc(env(safe-area-inset-top, 0px) + 12px);
      left: 50%;
      transform: translateX(-50%);
      z-index: 21000;
    `;
    this.element.onclick = (e) => e.stopPropagation();
    this.modalElement = this.element.querySelector('.general-settings-modal');
    this.languageSelect = this.element.querySelector('#general-language-select');
    this.languageButton = this.element.querySelector('#general-language-btn');
    this.languageStatus = this.element.querySelector('#general-language-status');

    this.themePresetSelect = this.element.querySelector('#general-theme-preset-select');
    this.themePresetButton = this.element.querySelector('#general-theme-preset-btn');
    this.themeAdvancedToggle = this.element.querySelector('#general-theme-advanced-toggle');
    this.themeAdvancedWrap = this.element.querySelector('#general-theme-advanced');
    this.themeAvatarStyleSelect = this.element.querySelector('#general-theme-avatar-style-select');
    this.themeAvatarStyleButton = this.element.querySelector('#general-theme-avatar-style-btn');
    this.themeChatDisplaySelect = this.element.querySelector('#general-theme-chat-display-select');
    this.themeChatDisplayButton = this.element.querySelector('#general-theme-chat-display-btn');
    this.themeToastPositionSelect = this.element.querySelector('#general-theme-toast-position-select');
    this.themeToastPositionButton = this.element.querySelector('#general-theme-toast-position-btn');
    this.themeFontScaleInput = this.element.querySelector('#general-theme-font-scale');
    this.themeFontScaleValue = this.element.querySelector('#general-theme-font-scale-value');
    this.themeReducedMotionToggle = this.element.querySelector('#general-theme-reduced-motion');
    this.themeCompactInputToggle = this.element.querySelector('#general-theme-compact-input');
    this.themeHideAvatarsToggle = this.element.querySelector('#general-theme-hide-avatars');
    this.themeImportBtn = this.element.querySelector('#general-theme-import');
    this.themeExportBtn = this.element.querySelector('#general-theme-export');
    this.themeStatus = this.element.querySelector('#general-theme-status');
    this.themeImportInput = this.element.querySelector('#general-theme-file');
    this.debugToggle = this.element.querySelector('#general-debug-toggle');
    this.debugLogToggle = this.element.querySelector('#general-debug-logs');
    this.typingDotsToggle = this.element.querySelector('#general-typing-dots');
    this.richIframeScriptsToggle = this.element.querySelector('#general-rich-iframe-scripts');
    this.traditionalProtocolToggle = this.element.querySelector('#general-traditional-model-output-protocol');
    this.chatAiTimeToggle = this.element.querySelector('#general-chat-ai-time');
    this.toastEnabledToggle = this.element.querySelector('#general-toast-enabled');
    this.replyNotificationSettingsCleanup = bindReplyNotificationSettings({
      root: this.element,
      updateRows: () => this.updateSelectableCards(),
      onError: () => window.toastr?.error?.(t('通知设置保存失败，请重试')),
    });
    this.chatHistoryMaxInput = this.element.querySelector('#general-chat-history-max');
    this.creativeHistoryInput = this.element.querySelector('#general-creative-history');
    this.creativeWideToggle = this.element.querySelector('#general-creative-wide');
    this.uiAdvancedToggle = this.element.querySelector('#general-ui-advanced-toggle');
    this.uiAdvancedWrap = this.element.querySelector('#general-ui-advanced');
    this.personaBindToggle = this.element.querySelector('#general-persona-bind');
    this.promptTimeToggle = this.element.querySelector('#general-prompt-time');
    this.momentCommentSideEffectsToggle = this.element.querySelector('#general-moment-comment-side-effects');
    this.autoImagePromptToggle = this.element.querySelector('#general-auto-image-prompt');
    this.autoImagePromptWritingToggle = this.element.querySelector('#general-auto-image-prompt-writing');
    this.autoImagePromptStyleSelect = this.element.querySelector('#general-auto-image-prompt-style');
    this.autoImagePromptAdvancedToggle = this.element.querySelector('#general-auto-image-prompt-advanced-toggle');
    this.autoImagePromptAdvancedWrap = this.element.querySelector('#general-auto-image-prompt-advanced');
    this.autoImagePromptDecisionModeSelect = this.element.querySelector('#general-auto-image-prompt-decision-mode');
    this.autoImagePromptMomentMediaModeSelect = this.element.querySelector('#general-auto-image-prompt-moment-media-mode');
    this.autoImagePromptCooldownInput = this.element.querySelector('#general-auto-image-prompt-cooldown');
    this.autoImagePromptWindowRoundsInput = this.element.querySelector('#general-auto-image-prompt-window-rounds');
    this.autoImagePromptWindowMaxInput = this.element.querySelector('#general-auto-image-prompt-window-max');
    this.autoImagePromptMaxConcurrencyInput = this.element.querySelector('#general-auto-image-prompt-max-concurrency');
    this.autoImagePromptMaxPerResponseInput = this.element.querySelector('#general-auto-image-prompt-max-per-response');
    this.autoImagePromptSkipRepeatedToggle = this.element.querySelector('#general-auto-image-prompt-skip-repeated');
    this.memoryEnabledToggle = this.element.querySelector('#general-memory-enabled');
    this.memoryModeSummary = this.element.querySelector('#general-memory-mode-summary');
    this.memoryModeTable = this.element.querySelector('#general-memory-mode-table');
    this.memoryAdvancedToggle = this.element.querySelector('#general-memory-advanced-toggle');
    this.memoryAdvancedWrap = this.element.querySelector('#general-memory-advanced');
    this.memoryAutoToggle = this.element.querySelector('#general-memory-auto');
    this.memoryAutoModeInline = this.element.querySelector('#general-memory-auto-inline');
    this.memoryAutoModeSeparate = this.element.querySelector('#general-memory-auto-separate');
    this.memoryAutoOptions = this.element.querySelector('#general-memory-auto-options');
    this.memoryUpdateApiChat = this.element.querySelector('#general-memory-update-chat');
    this.memoryUpdateApiProfile = this.element.querySelector('#general-memory-update-profile');
    this.memoryUpdateProfileSelect = this.element.querySelector('#general-memory-update-profile-select');
    this.memoryUpdateProfileButton = this.element.querySelector('#general-memory-update-profile-btn');
    this.memoryUpdateProfileManageBtn = this.element.querySelector('#general-memory-update-profile-manage');
    this.memoryUpdateApiBlock = this.element.querySelector('#general-memory-update-api');
    this.memoryUpdateContextInput = this.element.querySelector('#general-memory-update-context-rounds');
    this.memoryBudgetBlock = this.element.querySelector('#general-memory-budget-block');
    this.memoryBudgetModeSelect = this.element.querySelector('#general-memory-budget-mode');
    this.memoryTokenBudgetWrap = this.element.querySelector('#general-memory-token-budget-wrap');
    this.memoryInputBudgetInput = this.element.querySelector('#general-memory-input-budget-tokens');
    this.memoryRowsBudgetWrap = this.element.querySelector('#general-memory-rows-budget-wrap');
    this.memoryMaxRowsInput = this.element.querySelector('#general-memory-max-rows');
    this.memoryMaxTokensInput = this.element.querySelector('#general-memory-max-tokens');
    this.memoryInjectPositionSelect = this.element.querySelector('#general-memory-inject-position');
    this.memoryInjectPositionButton = this.element.querySelector('#general-memory-inject-position-btn');
    this.memoryInjectDepthWrap = this.element.querySelector('#general-memory-inject-depth-wrap');
    this.memoryInjectDepthInput = this.element.querySelector('#general-memory-inject-depth');
    this.memoryBridgeBlock = this.element.querySelector('#general-memory-bridge-block');
    this.memoryBridgeMomentsToChatToggle = this.element.querySelector('#general-memory-bridge-moments-to-chat');
    this.memoryBridgeMomentsToChatLimitInput = this.element.querySelector('#general-memory-bridge-moments-to-chat-limit');
    this.memoryBridgeChatToMomentsToggle = this.element.querySelector('#general-memory-bridge-chat-to-moments');
    this.memoryBridgeChatToMomentsLimitInput = this.element.querySelector('#general-memory-bridge-chat-to-moments-limit');
    this.memoryBridgeRpToMomentsToggle = this.element.querySelector('#general-memory-bridge-rp-to-moments');
    this.memoryBridgeRpToMomentsLimitInput = this.element.querySelector('#general-memory-bridge-rp-to-moments-limit');
    this.memoryGroupMemberReferenceToggle = this.element.querySelector('#general-memory-group-member-reference');
    this.memoryGroupMemberReferenceLimitInput = this.element.querySelector('#general-memory-group-member-reference-limit');
    this.memoryAutoConfirmToggle = this.element.querySelector('#general-memory-auto-confirm');
    this.memoryAutoStepToggle = this.element.querySelector('#general-memory-auto-step');
    this.memoryFillEveryNInput = this.element.querySelector('#general-memory-fill-every-n');
    this.memoryPlacesButton = this.element.querySelector('#general-memory-places-btn');
    this.templateEnabledToggle = this.element.querySelector('#general-template-enabled');
    this.templateBeforeToggle = this.element.querySelector('#general-template-before');
    this.templateAfterToggle = this.element.querySelector('#general-template-after');
    this.templateErrorToggle = this.element.querySelector('#general-template-error');
    this.templateOptionsWrap = this.element.querySelector('#general-template-options');
    this.templateAdvancedToggle = this.element.querySelector('#general-template-advanced-toggle');
    this.templateAdvancedWrap = this.element.querySelector('#general-template-advanced');
    this.scriptAdvancedToggle = this.element.querySelector('#general-script-advanced-toggle');
    this.scriptAdvancedWrap = this.element.querySelector('#general-script-advanced');
    this.scriptEnabledToggle = this.element.querySelector('#general-script-enabled');
    this.scriptAllowVarsToggle = this.element.querySelector('#general-script-allow-vars');
    this.scriptAllowMessagesToggle = this.element.querySelector('#general-script-allow-messages');
    this.scriptAllowNetworkToggle = this.element.querySelector('#general-script-allow-network');
    this.scriptOptionsWrap = this.element.querySelector('#general-script-options');
    this.openSessionBtn = this.element.querySelector('#general-open-session');
    this.openMemoryTemplatesBtn = this.element.querySelector('#general-open-memory-templates');
    this.cleanWallpapersBtn = this.element.querySelector('#general-clean-wallpapers');
    this.cleanWallpapersStatus = this.element.querySelector('#general-clean-wallpapers-status');
    this.bundleExportBtn = this.element.querySelector('#general-bundle-export');
    this.bundleImportBtn = this.element.querySelector('#general-bundle-import');
    this.customBundleExportBtn = this.element.querySelector('#general-custom-bundle-export');
    this.bundleStatus = this.element.querySelector('#general-bundle-status');
    this.bundleProgressWrap = this.element.querySelector('#general-bundle-progress-wrap');
    this.bundleProgressBar = this.element.querySelector('#general-bundle-progress-bar');
    this.bundleProgressText = this.element.querySelector('#general-bundle-progress-text');
    this.bundleImportInput = this.element.querySelector('#general-bundle-file');
    this.resetBundleProgress();

    this.populateThemeSelect(this.themeAvatarStyleSelect, THEME_AVATAR_STYLE_OPTIONS, appSettings.get().uiThemeAvatarStyle);
    this.populateThemeSelect(this.themeChatDisplaySelect, THEME_CHAT_DISPLAY_OPTIONS, appSettings.get().uiThemeChatDisplay);
    this.populateThemeSelect(this.themeToastPositionSelect, THEME_TOAST_POSITION_OPTIONS, appSettings.get().uiThemeToastrPosition);

    this.initSelectableCards();
    this.updateShortcutButtons();
    this.openSessionBtn?.addEventListener('click', () => {
      const fn = this.externalActions.openSession;
      if (typeof fn !== 'function') return;
      this.hide();
      fn();
    });
    this.openMemoryTemplatesBtn?.addEventListener('click', () => {
      const fn = this.externalActions.openMemoryTemplates;
      if (typeof fn !== 'function') return;
      this.hide();
      fn();
    });
    this.memoryPlacesButton?.addEventListener('click', () => {
      if (this.memoryPlacesButton?.disabled) return;
      this.showMemoryPlacesDialog();
    });
    this.customBundleExportBtn?.addEventListener('click', async () => {
      const fn = this.externalActions.exportCustomBundle;
      if (typeof fn !== 'function') return;
      this.hide();
      try {
        await fn();
      } catch (err) {
        window.toastr?.error?.(err?.message || '自定义导出失败');
      }
    });
    this.element.addEventListener('change', (e) => {
      const target = e?.target;
      if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
        this.updateSelectableCards();
      }
    });
    window.addEventListener('custom-bundle-import-progress', (event) => {
      const detail = event?.detail || {};
      if (String(detail?.kind || '').trim() !== 'custom-bundle-import') return;
      const statusText = String(detail?.status || '').trim();
      const progress = Math.max(0, Math.min(100, Number(detail?.progress || 0) || 0));
      const done = detail?.done === true;
      const tone = detail?.error ? 'error' : (done ? 'success' : 'normal');
      this.setBundleProgress({
        visible: !done || Boolean(statusText),
        progress,
        text: statusText || (done ? '导入完成' : '正在处理...'),
        indeterminate: !done && progress <= 0,
        tone,
      });
      if (statusText) {
        if (this.bundleStatus) this.bundleStatus.textContent = statusText;
      }
      if (done && !detail?.error) {
        setTimeout(() => {
          this.resetBundleProgress();
        }, 2400);
      }
    });

    const applyThemeSetting = (key, value) => {
      appSettings.update({ [key]: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key, value } }));
    };
    const hasTauriRuntime = () => {
      const g = typeof globalThis !== 'undefined' ? globalThis : window;
      return Boolean(g?.__TAURI__ || g?.__TAURI_INTERNALS__ || g?.__TAURI_INVOKE__);
    };
    const encodeTextBase64 = (text) => {
      const bytes = new TextEncoder().encode(String(text || ''));
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode(...slice);
      }
      return btoa(binary);
    };
    const sanitizeThemeFileName = (value) => {
      const raw = String(value || '').trim();
      const cleaned = raw.replace(/[\\/:*?"<>|]+/g, '_');
      return `${cleaned || 'theme'}.json`;
    };
    const downloadThemeFallback = (text, fileName) => {
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    };

    this.themePresetSelect?.addEventListener('change', async (e) => {
      const value = String(e?.target?.value || 'classic-dark').trim() || 'classic-dark';
      await themeManager.activateThemeById(value, { syncAppearance: true });
      this.refreshThemePresetOptions();
      const settings = appSettings.get();
      if (this.themePresetSelect) this.themePresetSelect.value = settings.uiThemePresetId;
      if (this.themeAvatarStyleSelect) this.themeAvatarStyleSelect.value = settings.uiThemeAvatarStyle;
      if (this.themeChatDisplaySelect) this.themeChatDisplaySelect.value = settings.uiThemeChatDisplay;
      if (this.themeToastPositionSelect) this.themeToastPositionSelect.value = settings.uiThemeToastrPosition;
      if (this.themeFontScaleInput) this.themeFontScaleInput.value = String(Math.round(Number(settings.uiThemeFontScale || 1) * 100));
      if (this.themeReducedMotionToggle) this.themeReducedMotionToggle.checked = settings.uiThemeReducedMotion === true;
      if (this.themeCompactInputToggle) this.themeCompactInputToggle.checked = settings.uiThemeCompactInput === true;
      if (this.themeHideAvatarsToggle) this.themeHideAvatarsToggle.checked = settings.uiThemeHideChatAvatars === true;
      this.refreshThemeSelectButton(this.themePresetButton, this.themePresetSelect, '选择主题…');
      this.refreshThemeSelectButton(this.themeAvatarStyleButton, this.themeAvatarStyleSelect, '头像样式');
      this.refreshThemeSelectButton(this.themeChatDisplayButton, this.themeChatDisplaySelect, '聊天风格');
      this.refreshThemeSelectButton(this.themeToastPositionButton, this.themeToastPositionSelect, '通知位置');
      this.updateThemeFontScaleValue();
      this.updateThemeStatus();
    });
    this.themePresetButton?.addEventListener('click', () => {
      this.refreshThemePresetOptions();
      this.openThemeSelectMenu(this.themePresetButton, this.themePresetSelect, '选择主题…');
    });
    this.themeAdvancedToggle?.addEventListener('click', () => {
      this.toggleAdvancedSection(this.themeAdvancedToggle, this.themeAdvancedWrap);
    });
    this.autoImagePromptAdvancedToggle?.addEventListener('click', () => {
      this.toggleAdvancedSection(this.autoImagePromptAdvancedToggle, this.autoImagePromptAdvancedWrap);
    });
    this.themeAvatarStyleSelect?.addEventListener('change', (e) => {
      const value = String(e?.target?.value || 'system').trim() || 'system';
      applyThemeSetting('uiThemeAvatarStyle', value);
      this.refreshThemeSelectButton(this.themeAvatarStyleButton, this.themeAvatarStyleSelect, '头像样式');
    });
    this.themeAvatarStyleButton?.addEventListener('click', () => {
      this.openThemeSelectMenu(this.themeAvatarStyleButton, this.themeAvatarStyleSelect, '头像样式');
    });
    this.themeChatDisplaySelect?.addEventListener('change', (e) => {
      const value = String(e?.target?.value || 'default').trim() || 'default';
      applyThemeSetting('uiThemeChatDisplay', value);
      this.refreshThemeSelectButton(this.themeChatDisplayButton, this.themeChatDisplaySelect, '聊天风格');
    });
    this.themeChatDisplayButton?.addEventListener('click', () => {
      this.openThemeSelectMenu(this.themeChatDisplayButton, this.themeChatDisplaySelect, '聊天风格');
    });
    this.themeToastPositionSelect?.addEventListener('change', (e) => {
      const value = String(e?.target?.value || 'toast-top-right').trim() || 'toast-top-right';
      applyThemeSetting('uiThemeToastrPosition', value);
      this.refreshThemeSelectButton(this.themeToastPositionButton, this.themeToastPositionSelect, '通知位置');
    });
    this.themeToastPositionButton?.addEventListener('click', () => {
      this.openThemeSelectMenu(this.themeToastPositionButton, this.themeToastPositionSelect, '通知位置');
    });
    this.themeFontScaleInput?.addEventListener('input', (e) => {
      const raw = Math.trunc(Number(e?.target?.value));
      const safe = Number.isFinite(raw) ? Math.max(85, Math.min(135, raw)) : 100;
      if (e?.target) e.target.value = String(safe);
      applyThemeSetting('uiThemeFontScale', safe / 100);
      this.updateThemeFontScaleValue();
    });
    this.themeReducedMotionToggle?.addEventListener('change', (e) => {
      applyThemeSetting('uiThemeReducedMotion', Boolean(e?.target?.checked));
    });
    this.themeCompactInputToggle?.addEventListener('change', (e) => {
      applyThemeSetting('uiThemeCompactInput', Boolean(e?.target?.checked));
    });
    this.themeHideAvatarsToggle?.addEventListener('change', (e) => {
      applyThemeSetting('uiThemeHideChatAvatars', Boolean(e?.target?.checked));
    });
    this.themeImportBtn?.addEventListener('click', () => {
      if (this.themeImportInput) this.themeImportInput.value = '';
      this.themeImportInput?.click();
    });
    this.themeImportInput?.addEventListener('change', async () => {
      const file = this.themeImportInput?.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const preset = await themeManager.importThemeObject(parsed);
        this.refreshThemePresetOptions();
        const settings = appSettings.get();
        if (this.themePresetSelect) this.themePresetSelect.value = preset.id;
        if (this.themeAvatarStyleSelect) this.themeAvatarStyleSelect.value = settings.uiThemeAvatarStyle;
        if (this.themeChatDisplaySelect) this.themeChatDisplaySelect.value = settings.uiThemeChatDisplay;
        if (this.themeToastPositionSelect) this.themeToastPositionSelect.value = settings.uiThemeToastrPosition;
        if (this.themeFontScaleInput) this.themeFontScaleInput.value = String(Math.round(Number(settings.uiThemeFontScale || 1) * 100));
        if (this.themeReducedMotionToggle) this.themeReducedMotionToggle.checked = settings.uiThemeReducedMotion === true;
        if (this.themeCompactInputToggle) this.themeCompactInputToggle.checked = settings.uiThemeCompactInput === true;
        if (this.themeHideAvatarsToggle) this.themeHideAvatarsToggle.checked = settings.uiThemeHideChatAvatars === true;
        this.refreshThemeSelectButton(this.themePresetButton, this.themePresetSelect, '选择主题…');
        this.refreshThemeSelectButton(this.themeAvatarStyleButton, this.themeAvatarStyleSelect, '头像样式');
        this.refreshThemeSelectButton(this.themeChatDisplayButton, this.themeChatDisplaySelect, '聊天风格');
        this.refreshThemeSelectButton(this.themeToastPositionButton, this.themeToastPositionSelect, '通知位置');
        this.updateThemeFontScaleValue();
        this.updateThemeStatus(`已导入并启用：${preset.name}`);
        window.toastr?.success?.(`主题导入成功：${preset.name}`);
      } catch (err) {
        const message = String(err?.message || err || '导入失败').trim();
        this.updateThemeStatus(`导入失败：${message}`);
        window.toastr?.error?.(`主题导入失败：${message}`);
      }
    });
    this.themeExportBtn?.addEventListener('click', async () => {
      const preset = themeManager.buildCurrentExport();
      const text = JSON.stringify(preset, null, 2);
      const fileName = sanitizeThemeFileName(preset?.name || 'theme');
      try {
        let savedPath = '';
        const pick = await pickSavePath({
          defaultName: fileName,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (pick.cancelled) return;
        if (!pick.fallback && pick.path) {
          await safeInvoke('write_text_file', { path: pick.path, text });
          savedPath = String(pick.path);
        }
        if (!savedPath && hasTauriRuntime()) {
          const resp = await safeInvoke('export_attachment', {
            dataUrl: `data:application/json;base64,${encodeTextBase64(text)}`,
            fileName,
          });
          savedPath = String(resp?.path || '').trim();
        }
        if (!savedPath) {
          downloadThemeFallback(text, fileName);
          this.updateThemeStatus(`已导出：${fileName}`);
          window.toastr?.success?.(`主题已导出：${fileName}`);
          return;
        }
        this.updateThemeStatus(`已导出：${savedPath}`);
        window.toastr?.success?.(`主题已导出：${savedPath}`);
      } catch (err) {
        const message = String(err?.message || err || '导出失败').trim();
        this.updateThemeStatus(`导出失败：${message}`);
        window.toastr?.error?.(`主题导出失败：${message}`);
      }
    });

    this.debugToggle?.addEventListener('change', async (e) => {
      const enabled = Boolean(e?.target?.checked);
      const settings = appSettings.update({ showDebugToggle: enabled });
      try {
        const { getDebugPanel } = await import('./debug-panel.js');
        const panel = getDebugPanel();
        panel.setEnabled(Boolean(settings.showDebugToggle));
      } catch {}
    });
    this.debugLogToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ debugExecutionLogs: enabled });
    });
    this.languageButton?.addEventListener('click', () => {
      this.openThemeSelectMenu(this.languageButton, this.languageSelect, t('选择语言'));
    });
    this.languageSelect?.addEventListener('change', async (e) => {
      const value = String(e?.target?.value || 'system');
      const allowed = new Set(LANGUAGE_OPTIONS.map(option => option.value));
      const locale = allowed.has(value) ? value : 'system';
      const previous = String(appSettings.get().locale || 'system');
      if (e?.target) e.target.value = locale;
      this.refreshThemeSelectButton(this.languageButton, this.languageSelect, t('选择语言'));
      if (locale === previous) return;
      appSettings.update({ locale, languageSetupCompleted: true });
      if (this.languageStatus) this.languageStatus.textContent = t('语言设置已保存，等待重启。');
      window.dispatchEvent(new CustomEvent('app-settings-changed', {
        detail: { key: 'locale', value: locale },
      }));
      const restartNow = await appConfirm({
        title: t('重启应用以切换语言'),
        message: t('语言设置已保存。重启应用后，所有界面会使用新语言。'),
        confirmText: t('立即重启'),
        cancelText: t('稍后'),
      });
      if (!restartNow) return;
      if (this.languageStatus) this.languageStatus.textContent = t('正在重启应用…');
      const result = await this.externalActions.restartApp?.();
      if (result?.ok) return;
      const manual = result?.reason === 'manual_restart_required';
      const message = manual
        ? t('请关闭并重新打开应用以完成语言切换。')
        : t('无法自动重启，请手动关闭并重新打开应用。');
      if (this.languageStatus) this.languageStatus.textContent = message;
      window.toastr?.info?.(message);
    });
    this.typingDotsToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      const settings = appSettings.update({ typingDotsEnabled: enabled });
      this.applyTypingDotsSetting(settings.typingDotsEnabled !== false);
    });
    this.richIframeScriptsToggle?.addEventListener('change', async (e) => {
      const target = e?.target;
      const enabled = Boolean(target?.checked);
      if (enabled) {
        const ok = await appConfirm({
          title: '安全提示',
          message:
            '启用后，富文本 iframe 将执行其中的脚本并放宽安全限制，脚本可能访问同源数据、加载外部资源，导致敏感信息泄露或设置被篡改。仅在信任来源时启用。确定继续吗？',
        });
        if (!ok) {
          if (target) target.checked = false;
          return;
        }
      }
      const settings = appSettings.update({ allowRichIframeScripts: enabled });
      const value = settings?.allowRichIframeScripts === true;
      if (target) target.checked = value;
      window.dispatchEvent(new CustomEvent('app-settings-changed', {
        detail: { key: 'allowRichIframeScripts', value },
      }));
    });
    this.traditionalProtocolToggle?.addEventListener('change', (e) => {
      const value = Boolean(e?.target?.checked);
      const settings = appSettings.update({ traditionalModelOutputProtocolEnabled: value });
      const enabled = settings?.traditionalModelOutputProtocolEnabled === true;
      if (e?.target) e.target.checked = enabled;
      window.dispatchEvent(new CustomEvent('app-settings-changed', {
        detail: { key: 'traditionalModelOutputProtocolEnabled', value: enabled },
      }));
    });
    this.chatAiTimeToggle?.addEventListener('change', (e) => {
      const value = e.target.checked === true;
      appSettings.update({ chatAiTimeEnabled: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'chatAiTimeEnabled', value } }));
    });
    this.toastEnabledToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ toastEnabled: enabled });
    });
    this.creativeWideToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      const settings = appSettings.update({ creativeWideBubble: enabled });
      this.applyCreativeWideSetting(Boolean(settings.creativeWideBubble));
    });
    this.chatHistoryMaxInput?.addEventListener('input', (e) => {
      const raw = e?.target?.value;
      const n = Math.trunc(Number(raw));
      const safe = Number.isFinite(n) ? Math.max(0, n) : 0;
      if (e?.target) e.target.value = String(safe);
      appSettings.update({ chatHistoryMax: safe });
    });
    this.creativeHistoryInput?.addEventListener('input', (e) => {
      const raw = e?.target?.value;
      const n = Math.trunc(Number(raw));
      const safe = Number.isFinite(n) ? Math.max(0, n) : 5;
      if (e?.target) e.target.value = String(safe);
      appSettings.update({ creativeHistoryMax: safe });
    });
    this.uiAdvancedToggle?.addEventListener('click', () => {
      this.toggleAdvancedSection(this.uiAdvancedToggle, this.uiAdvancedWrap);
    });
    this.memoryAdvancedToggle?.addEventListener('click', () => {
      this.toggleAdvancedSection(this.memoryAdvancedToggle, this.memoryAdvancedWrap);
    });
    this.templateAdvancedToggle?.addEventListener('click', () => {
      this.toggleAdvancedSection(this.templateAdvancedToggle, this.templateAdvancedWrap, () => {
        this.updateTemplateScriptVisibility();
      });
    });
    this.scriptAdvancedToggle?.addEventListener('click', () => {
      this.toggleAdvancedSection(this.scriptAdvancedToggle, this.scriptAdvancedWrap, () => {
        this.updateTemplateScriptVisibility();
      });
    });

    this.templateEnabledToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ templateEnabled: enabled });
      this.updateTemplateScriptVisibility();
    });
    this.templateBeforeToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ templateExecuteBeforeGenerate: enabled });
    });
    this.templateAfterToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ templateExecuteAfterRender: enabled });
    });
    this.templateErrorToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ templateShowErrorToast: enabled });
    });
    this.scriptEnabledToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ scriptEnabled: enabled });
      this.updateTemplateScriptVisibility();
    });
    this.scriptAllowVarsToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ scriptAllowModifyVariables: enabled });
    });
    this.scriptAllowMessagesToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ scriptAllowReadMessages: enabled });
    });
    this.scriptAllowNetworkToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ scriptAllowNetwork: enabled });
    });

    this.personaBindToggle?.addEventListener('change', async (e) => {
      const target = e?.target;
      const enabled = Boolean(target?.checked);
      if (!enabled) {
        const ok = await appConfirm({
          title: '关闭绑定',
          message:
            '关闭后，所有角色卡将共享同一份联系人/聊天记录（共享区）。已绑定的数据不会丢失，但需切回绑定模式才能查看各自内容。确定继续吗？',
        });
        if (!ok) {
          if (target) target.checked = true;
          return;
        }
      }
      appSettings.update({ personaBindContacts: enabled });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'personaBindContacts', value: enabled } }));
    });

    this.promptTimeToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ promptCurrentTimeEnabled: enabled });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'promptCurrentTimeEnabled', value: enabled } }));
    });
    this.momentCommentSideEffectsToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ momentCommentSideEffectsEnabled: enabled });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'momentCommentSideEffectsEnabled', value: enabled } }));
    });
    this.autoImagePromptToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ autoImagePromptEnabled: enabled });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'autoImagePromptEnabled', value: enabled } }));
    });
    this.autoImagePromptWritingToggle?.addEventListener('change', (e) => {
      const value = Boolean(e?.target?.checked);
      appSettings.update({ autoImagePromptWritingEnabled: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'autoImagePromptWritingEnabled', value } }));
    });
    this.autoImagePromptStyleSelect?.addEventListener('change', (e) => {
      const raw = String(e?.target?.value || 'auto').trim();
      const allowed = new Set(['auto', 'natural', 'nai_tags']);
      const value = allowed.has(raw) ? raw : 'auto';
      if (e?.target) e.target.value = value;
      appSettings.update({ autoImagePromptStyle: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'autoImagePromptStyle', value } }));
    });
    this.autoImagePromptDecisionModeSelect?.addEventListener('change', (e) => {
      const raw = String(e?.target?.value || 'conservative').trim();
      const allowed = new Set(['conservative', 'standard', 'aggressive']);
      const value = allowed.has(raw) ? raw : 'conservative';
      if (e?.target) e.target.value = value;
      appSettings.update({ autoImagePromptDecisionMode: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'autoImagePromptDecisionMode', value } }));
    });
    this.autoImagePromptMomentMediaModeSelect?.addEventListener('change', (e) => {
      const raw = String(e?.target?.value || 'ai').trim();
      const allowed = new Set(['placeholder', 'image_prompt', 'ai']);
      const value = allowed.has(raw) ? raw : 'ai';
      if (e?.target) e.target.value = value;
      appSettings.update({ autoImagePromptMomentMediaMode: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'autoImagePromptMomentMediaMode', value } }));
    });
    const bindAutoImagePromptNumber = (input, key, fallback, min = 0) => {
      input?.addEventListener('input', (e) => {
        const raw = Math.trunc(Number(e?.target?.value));
        const value = Number.isFinite(raw) ? Math.max(min, raw) : fallback;
        if (e?.target) e.target.value = String(value);
        appSettings.update({ [key]: value });
        window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key, value } }));
      });
    };
    bindAutoImagePromptNumber(this.autoImagePromptCooldownInput, 'autoImagePromptCooldownRounds', 0);
    bindAutoImagePromptNumber(this.autoImagePromptWindowRoundsInput, 'autoImagePromptWindowRounds', 0);
    bindAutoImagePromptNumber(this.autoImagePromptWindowMaxInput, 'autoImagePromptWindowMax', 0);
    bindAutoImagePromptNumber(this.autoImagePromptMaxConcurrencyInput, 'autoImagePromptMaxConcurrency', 1, 1);
    bindAutoImagePromptNumber(this.autoImagePromptMaxPerResponseInput, 'autoImagePromptMaxPerResponse', 0, 0);
    this.autoImagePromptSkipRepeatedToggle?.addEventListener('change', (e) => {
      const value = Boolean(e?.target?.checked);
      appSettings.update({ autoImagePromptSkipRepeated: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'autoImagePromptSkipRepeated', value } }));
    });

    const applyMemoryMode = (mode) => {
      applyMemoryStorageMode({
        mode,
        appSettings,
        dispatchEvent: event => window.dispatchEvent(event),
      });
      this.updateMemoryAutoVisibility();
    };
    this.memoryEnabledToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      const nextMode = enabled ? (this.memoryModeTable?.checked ? 'table' : 'summary') : 'off';
      applyMemoryMode(nextMode);
    });
    this.memoryModeSummary?.addEventListener('change', (e) => {
      const checked = Boolean(e?.target?.checked);
      if (!checked) return;
      applyMemoryMode('summary');
    });
    this.memoryAutoToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ memoryAutoExtract: enabled });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryAutoExtract', value: enabled } }));
      this.updateMemoryAutoVisibility();
    });
    const applyAutoMode = (mode) => {
      const next = mode === 'separate' ? 'separate' : 'inline';
      appSettings.update({ memoryAutoExtractMode: next });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryAutoExtractMode', value: next } }));
      this.updateMemoryAutoVisibility();
    };
    this.memoryAutoModeInline?.addEventListener('change', (e) => {
      if (!e?.target?.checked) return;
      applyAutoMode('inline');
    });
    this.memoryAutoModeSeparate?.addEventListener('change', (e) => {
      if (!e?.target?.checked) return;
      applyAutoMode('separate');
    });
    const applyMemoryApiMode = (mode) => {
      const next = mode === 'profile' ? 'profile' : 'chat';
      appSettings.update({ memoryUpdateApiMode: next });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryUpdateApiMode', value: next } }));
      this.updateMemoryAutoVisibility();
    };
    this.memoryUpdateApiChat?.addEventListener('change', (e) => {
      if (!e?.target?.checked) return;
      applyMemoryApiMode('chat');
    });
    this.memoryUpdateApiProfile?.addEventListener('change', (e) => {
      if (!e?.target?.checked) return;
      applyMemoryApiMode('profile');
    });
    this.memoryUpdateProfileSelect?.addEventListener('change', (e) => {
      const value = String(e?.target?.value || '').trim();
      appSettings.update({ memoryUpdateProfileId: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryUpdateProfileId', value } }));
      this.refreshMemoryUpdateProfileSelectButton();
    });
    this.memoryUpdateProfileButton?.addEventListener('click', () => {
      if (!this.memoryUpdateProfileSelect || this.memoryUpdateProfileButton?.disabled) return;
      const options = Array.from(this.memoryUpdateProfileSelect.options || []).map((opt) => ({
        value: opt.value,
        label: opt.textContent || opt.value,
      }));
      this.openCustomSelectMenu({
        anchorEl: this.memoryUpdateProfileButton,
        options,
        currentValue: this.memoryUpdateProfileSelect.value,
        onSelect: (value) => {
          if (this.memoryUpdateProfileSelect.value !== value) {
            this.memoryUpdateProfileSelect.value = value;
            this.memoryUpdateProfileSelect.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            this.refreshMemoryUpdateProfileSelectButton();
          }
        },
      });
    });
    this.memoryUpdateProfileManageBtn?.addEventListener('click', () => {
      const fn = this.externalActions.openConfig;
      if (typeof fn !== 'function') return;
      this.closeCustomSelectMenu();
      this.hide();
      fn({
        tab: 'chat',
        onHide: async () => {
          await this.refreshMemoryUpdateProfiles().catch(() => {});
          this.show();
        },
      });
    });
    this.memoryUpdateContextInput?.addEventListener('input', (e) => {
      const raw = Math.trunc(Number(e?.target?.value));
      const safe = Number.isFinite(raw) ? Math.max(0, raw) : 6;
      if (e?.target) e.target.value = String(safe);
      appSettings.update({ memoryUpdateContextRounds: safe });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryUpdateContextRounds', value: safe } }));
    });
    this.memoryAutoConfirmToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ memoryAutoConfirm: enabled });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryAutoConfirm', value: enabled } }));
    });
    this.memoryAutoStepToggle?.addEventListener('change', (e) => {
      const enabled = Boolean(e?.target?.checked);
      appSettings.update({ memoryAutoStepByStep: enabled });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryAutoStepByStep', value: enabled } }));
    });
    this.memoryFillEveryNInput?.addEventListener('input', (e) => {
      const raw = Math.trunc(Number(e?.target?.value));
      const safe = Number.isFinite(raw) && raw >= 1 ? raw : 1;
      if (e?.target) e.target.value = String(safe);
      appSettings.update({ memoryFillEveryN: safe });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryFillEveryN', value: safe } }));
    });

    const setBundleStatus = (text) => {
      if (this.bundleStatus) this.bundleStatus.textContent = text;
    };

    const readFileAsDataUrl = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });

    const readFileAsArrayBuffer = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result || new ArrayBuffer(0));
      reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
      reader.readAsArrayBuffer(file);
    });

    const detectImportKind = async (file) => {
      const buffer = await readFileAsArrayBuffer(file);
      const bytes = Array.from(new Uint8Array(buffer));
      const entries = await safeInvoke('read_zip_entries', { bytes });
      return resolveImportKindFromZipEntries(entries);
    };

    const buildBundleFileName = () => {
      const now = new Date();
      const pad = (value) => String(value).padStart(2, '0');
      const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      return `omnitavern_backup_${ts}.zip`;
    };

    const pickBundleExportPath = async () =>
      pickSavePath({
        defaultName: buildBundleFileName(),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });

    this.bundleExportBtn?.addEventListener('click', async () => {
      if (this.bundleExportBtn) this.bundleExportBtn.disabled = true;
      setBundleStatus('正在打包...');
      try {
        await safeInvoke('save_kv', { name: 'app_settings_v1', data: appSettings.get() });
        const bridge = window?.appBridge;
        await bridge?.chatStore?.flush?.();
        await bridge?.momentsStore?.flush?.();
      } catch {}
      try {
        const pick = await pickBundleExportPath();
        if (pick.cancelled) {
          setBundleStatus('已取消导出');
          return;
        }
        const result = pick.fallback
          ? await safeInvoke('export_data_bundle', {})
          : await safeInvoke('export_data_bundle', { path: pick.path });
        const path = String(result?.path || '').trim();
        const bytes = Number(result?.bytes || 0);
        const size = bytes ? `${(bytes / (1024 * 1024)).toFixed(2)} MB` : '';
        setBundleStatus(path ? `已导出：${path}${size ? `（${size}）` : ''}` : '导出完成');
        window.toastr?.success?.('资料包导出完成');
      } catch (err) {
        const message = String(err?.message || err || '导出失败').trim();
        setBundleStatus(`导出失败: ${message}`);
        window.toastr?.error?.('资料包导出失败');
      } finally {
        if (this.bundleExportBtn) this.bundleExportBtn.disabled = false;
      }
    });

    this.bundleImportBtn?.addEventListener('click', async () => {
      if (this.bundleImportInput) this.bundleImportInput.value = '';
      this.bundleImportInput?.click();
    });

    this.bundleImportInput?.addEventListener('change', async () => {
      const file = this.bundleImportInput?.files?.[0];
      if (!file) return;
      if (this.bundleImportBtn) this.bundleImportBtn.disabled = true;
      try {
        setBundleStatus('正在识别导入包...');
        this.setBundleProgress({
          visible: true,
          progress: 6,
          text: '正在识别导入包...',
          indeterminate: true,
          tone: 'normal',
        });
        const detected = await detectImportKind(file);
        const kind = String(detected?.kind || 'bundle').trim() || 'bundle';
        if (kind === 'experience-pack') {
          setBundleStatus('识别为体验包，正在导入...');
          this.setBundleProgress({
            visible: true,
            progress: 14,
            text: '识别为体验包，正在导入...',
            indeterminate: true,
            tone: 'normal',
          });
          const fn = this.externalActions.importExperiencePackFile;
          if (typeof fn !== 'function') throw new Error('体验包导入器不可用');
          const ok = await fn(file);
          setBundleStatus(ok ? '体验包导入完成' : '已取消导入');
          this.setBundleProgress({
            visible: ok,
            progress: ok ? 100 : 0,
            text: ok ? '体验包导入完成' : '已取消导入',
            indeterminate: false,
            tone: ok ? 'success' : 'normal',
          });
          return;
        }
        if (kind === 'custom-bundle') {
          setBundleStatus('识别为自定义资料包，正在导入...');
          this.setBundleProgress({
            visible: true,
            progress: 12,
            text: '识别为自定义资料包，准备导入...',
            indeterminate: false,
            tone: 'normal',
          });
          const fn = this.externalActions.importCustomBundleFile;
          if (typeof fn !== 'function') throw new Error('自定义资料包导入器不可用');
          const ok = await fn(file, { prefetchedEntries: detected?.entries || null });
          setBundleStatus(ok ? '自定义资料包导入完成' : '已取消导入');
          if (!ok) this.resetBundleProgress();
          return;
        }
        const confirmed = await appConfirm({
          title: '导入完整资料包',
          message:
            '识别为完整资料包。导入会覆盖当前所有资料（不包含 API 配置），且无法撤销。\n请确认资料包来源可信，避免泄露隐私。\n确定继续吗？',
          danger: true,
        });
        if (!confirmed) {
          setBundleStatus('已取消导入');
          this.resetBundleProgress();
          return;
        }
        setBundleStatus('正在导入完整资料包...');
        this.setBundleProgress({
          visible: true,
          progress: 18,
          text: '正在导入完整资料包...',
          indeterminate: true,
          tone: 'normal',
        });
        const mode = 'replace';
        const filePath = typeof file.path === 'string' ? file.path : '';
        let result = null;
        if (filePath) {
          result = await safeInvoke('import_data_bundle', { path: filePath, mode });
        } else {
          const dataUrl = await readFileAsDataUrl(file);
          result = await safeInvoke('import_data_bundle_bytes', { data: dataUrl, mode });
        }
        try {
          const prefs = await safeInvoke('load_kv', { name: 'app_settings_v1' });
          if (prefs && typeof prefs === 'object' && !prefs._tooLarge) {
            appSettings.update(prefs);
          }
        } catch {}
        const skipped = Number(result?.skipped || 0);
        const suffix = skipped ? `（跳过 ${skipped} 项）` : '';
        setBundleStatus(`导入完成${suffix}，请重启应用以加载新资料`);
        this.setBundleProgress({
          visible: true,
          progress: 100,
          text: `完整资料包导入完成${suffix}`,
          indeterminate: false,
          tone: 'success',
        });
        window.toastr?.success?.(`完整资料包导入完成${suffix}`);
        const restart = await appConfirm({
          title: '重启应用',
          message: '资料导入完成，是否立即重启应用？',
          confirmText: '立即重启',
          cancelText: '稍后',
        });
        if (restart) window.location.reload();
      } catch (err) {
        const message = String(err?.message || err || '导入失败').trim();
        setBundleStatus(`导入失败: ${message}`);
        this.setBundleProgress({
          visible: true,
          progress: 100,
          text: `导入失败: ${message}`,
          indeterminate: false,
          tone: 'error',
        });
        window.toastr?.error?.('导入失败');
      } finally {
        if (this.bundleImportBtn) this.bundleImportBtn.disabled = false;
      }
    });

    this.cleanWallpapersBtn?.addEventListener('click', async () => {
      const confirmed = await appConfirm({
        title: '清理壁纸',
        message: '将清理未被会话引用的壁纸文件，是否继续？',
        danger: true,
      });
      if (!confirmed) return;
      const store = window?.appBridge?.chatStore || null;
      const sessionIds = store?.listSessions?.() || [];
      const referenced = sessionIds
        .map((sid) => store?.getSessionSettings?.(sid)?.wallpaper?.path || '')
        .map((val) => String(val || '').trim())
        .filter(Boolean);
      const unique = Array.from(new Set(referenced));
      if (this.cleanWallpapersBtn) {
        this.cleanWallpapersBtn.disabled = true;
        this.cleanWallpapersBtn.textContent = '清理中...';
      }
      if (this.cleanWallpapersStatus) {
        this.cleanWallpapersStatus.textContent = `已引用 ${unique.length} 个壁纸文件`;
      }
      try {
        const result = await safeInvoke('cleanup_wallpapers', { referencedPaths: unique });
        const removed = Number(result?.removed || 0);
        const kept = Number(result?.kept || 0);
        if (this.cleanWallpapersStatus) {
          this.cleanWallpapersStatus.textContent = `已清理 ${removed} 个残留文件，保留 ${kept} 个在用壁纸`;
        }
      } catch (err) {
        const message = String(err?.message || err || '清理失败').trim();
        if (this.cleanWallpapersStatus) {
          this.cleanWallpapersStatus.textContent = `清理失败: ${message}`;
        }
      } finally {
        if (this.cleanWallpapersBtn) {
          this.cleanWallpapersBtn.disabled = false;
          this.cleanWallpapersBtn.textContent = '清理壁纸残留';
        }
      }
    });
    this.memoryInjectPositionSelect?.addEventListener('change', (e) => {
      const raw = String(e?.target?.value || 'before_latest_user').toLowerCase();
      const allowed = new Set(['template', 'after_persona', 'system_end', 'before_chat', 'history_before', 'history_after', 'history_depth', 'before_latest_user', 'after_latest_user', 'system_end+before_chat']);
      const next = allowed.has(raw) ? raw : 'before_latest_user';
      appSettings.update({ memoryInjectPosition: next });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryInjectPosition', value: next } }));
      this.refreshThemeSelectButton(this.memoryInjectPositionButton, this.memoryInjectPositionSelect, '注入位置');
      this.updateMemoryAutoVisibility();
    });
    this.memoryInjectPositionButton?.addEventListener('click', () => {
      if (!this.memoryInjectPositionSelect || this.memoryInjectPositionButton?.disabled) return;
      const options = Array.from(this.memoryInjectPositionSelect.options || []).map((opt) => ({
        value: opt.value,
        label: opt.textContent || opt.value,
      }));
      this.openCustomSelectMenu({
        anchorEl: this.memoryInjectPositionButton,
        options,
        currentValue: this.memoryInjectPositionSelect.value,
        onSelect: (value) => {
          if (this.memoryInjectPositionSelect.value !== value) {
            this.memoryInjectPositionSelect.value = value;
            this.memoryInjectPositionSelect.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            this.refreshThemeSelectButton(this.memoryInjectPositionButton, this.memoryInjectPositionSelect, '注入位置');
          }
        },
      });
    });
    this.memoryInjectDepthInput?.addEventListener('input', (e) => {
      const raw = Math.trunc(Number(e?.target?.value));
      const safe = Number.isFinite(raw) ? Math.max(0, raw) : 4;
      if (e?.target) e.target.value = String(safe);
      appSettings.update({ memoryInjectDepth: safe });
      window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key: 'memoryInjectDepth', value: safe } }));
    });
    this.memoryBudgetModeSelect?.addEventListener('change', (e) => {
      const value = String(e?.target?.value || '').trim().toLowerCase() === 'rows'
        ? 'rows'
        : 'token';
      if (e?.target) e.target.value = value;
      appSettings.update({ memoryBudgetMode: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', {
        detail: { key: 'memoryBudgetMode', value },
      }));
      this.updateMemoryAutoVisibility();
    });
    const bindMemoryBudgetNumber = (input, key, fallback, min = 0) => {
      input?.addEventListener('input', (e) => {
        const raw = Math.trunc(Number(e?.target?.value));
        const value = Number.isFinite(raw) ? Math.max(min, raw) : fallback;
        if (e?.target) e.target.value = String(value);
        appSettings.update({ [key]: value });
        window.dispatchEvent(new CustomEvent('app-settings-changed', {
          detail: { key, value },
        }));
      });
    };
    bindMemoryBudgetNumber(this.memoryInputBudgetInput, 'memoryInputBudgetTokens', 100000, 1);
    bindMemoryBudgetNumber(this.memoryMaxRowsInput, 'memoryMaxRows', 1000, 1);
    bindMemoryBudgetNumber(this.memoryMaxTokensInput, 'memoryMaxTokens', 100000, 1);
    this.memoryGroupMemberReferenceToggle?.addEventListener('change', (e) => {
      const value = e?.target?.checked !== false;
      appSettings.update({ memoryGroupMemberReferenceEnabled: value });
      window.dispatchEvent(new CustomEvent('app-settings-changed', {
        detail: { key: 'memoryGroupMemberReferenceEnabled', value },
      }));
      this.updateMemoryAutoVisibility();
    });
    bindMemoryBudgetNumber(
      this.memoryGroupMemberReferenceLimitInput,
      'memoryGroupMemberReferenceLimit',
      5,
      0,
    );
    const bindMemoryBridgeToggle = (input, key) => {
      input?.addEventListener('change', (e) => {
        const enabled = e?.target?.checked !== false;
        appSettings.update({ [key]: enabled });
        window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key, value: enabled } }));
        this.updateMemoryAutoVisibility();
      });
    };
    const bindMemoryBridgeLimit = (input, key, fallback = 5) => {
      input?.addEventListener('input', (e) => {
        const raw = Math.trunc(Number(e?.target?.value));
        const safe = Number.isFinite(raw) ? Math.max(0, raw) : fallback;
        if (e?.target) e.target.value = String(safe);
        appSettings.update({ [key]: safe });
        window.dispatchEvent(new CustomEvent('app-settings-changed', { detail: { key, value: safe } }));
      });
    };
    bindMemoryBridgeToggle(this.memoryBridgeMomentsToChatToggle, 'memoryBridgeMomentsToChatEnabled');
    bindMemoryBridgeLimit(this.memoryBridgeMomentsToChatLimitInput, 'memoryBridgeMomentsToChatLimit', 5);
    bindMemoryBridgeToggle(this.memoryBridgeChatToMomentsToggle, 'memoryBridgeChatToMomentsEnabled');
    bindMemoryBridgeLimit(this.memoryBridgeChatToMomentsLimitInput, 'memoryBridgeChatToMomentsLimit', 5);
    bindMemoryBridgeToggle(this.memoryBridgeRpToMomentsToggle, 'memoryBridgeRpToMomentsEnabled');
    bindMemoryBridgeLimit(this.memoryBridgeRpToMomentsLimitInput, 'memoryBridgeRpToMomentsLimit', 5);
    this.memoryModeTable?.addEventListener('change', async (e) => {
      const target = e?.target;
      const checked = Boolean(target?.checked);
      if (!checked) return;
      const ok = await appConfirm({
        title: '切换记忆模式',
        message:
          '切换到记忆表格模式？\n\n• 新对话将使用记忆表格\n• 历史摘要数据保留，不会丢失\n• 你可以随时切换回摘要模式\n\n确定切换？',
      });
      if (!ok) {
        if (target) target.checked = false;
        if (this.memoryModeSummary) this.memoryModeSummary.checked = true;
        return;
      }
      applyMemoryMode('table');
    });

    this.element.querySelector('#general-settings-close')?.addEventListener('click', () => this.hide());
    this.element.querySelector('#general-settings-done')?.addEventListener('click', () => this.hide());

    document.body.appendChild(this.overlayElement);
    document.body.appendChild(this.element);
    localizeDomSubtree(this.element);
  }
}
