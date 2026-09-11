/**
 * 配置面板 UI
 */

import { RealtimeSettingsPanel } from './realtime/realtime-settings-panel.js';
import { realtimeReplyLanguageField, bindRealtimeReplyLanguagePicker } from './realtime/realtime-reply-language-picker.js';
import { getRealtimeProfileStore } from '../storage/realtime-profile-store.js';
import { ConfigManager } from '../storage/config.js';
import { LLMClient } from '../api/client.js';
import { VoiceClient } from '../api/voice-client.js';
import { canInitClient } from '../api/client-config-utils.js';
import {
    VERTEX_AUTH_MODE_EXPRESS,
    normalizeVertexAuthMode,
} from '../api/vertexai-config-utils.js';
import { normalizeOpenRouterProviderSlugs } from '../api/openrouter-provider-routing.js';
import { openRequestParamsPanel } from './request-params-panel.js';
import { normalizeCustomRequestParams, getRequestParamProtection } from '../api/request-params.js';
import { partitionPresetRequestParam } from '../api/request-param-ownership.js';
import { normalizeOpenAIApiFormat, supportsOpenAIApiFormatSelection } from '../api/openai-api-format.js';
import { logger } from '../utils/logger.js';
import {
    normalizeGenerationParamFilterList,
} from '../utils/generation-param-filter-utils.js';
import { appConfirm } from './app-confirm.js';
import { appSettings } from '../storage/app-settings.js';
import { t, translateUiText } from '../i18n/index.js';
import { bindBackdropActivation } from './backdrop-activation-utils.js';
import { rankModelCandidates } from '../utils/model-candidates.js';
import {
    reloadBridgeConfig,
    syncChatRuntimeConfigToBridge,
} from './config-runtime-utils.js';
import { ImageGenerationParamsPanel } from './image-generation-params-panel.js';
import { ChatFcCompatibilityPanel } from './chat-fc-compatibility-panel.js';
import { buildReasoningRequestOptions } from '../api/model-capabilities.js';
import { chatStructuredRouteEvidenceStore } from '../storage/chat-structured-route-evidence-store.js';
import { getPresetStore } from './preset-store-runtime-utils.js';
import { resolveChatStructuredProfileStatus } from './chat/chat-structured-profile-status.js';
import {
    getVoiceProviderDefaults,
    getVoiceProviderOptions,
    normalizeVoiceCapability,
    normalizeVoiceConnectionMode,
} from './voice-config-utils.js';
import { VoiceRegistryPanel } from './voice-registry-panel.js';
import {
    OPENAI_REALTIME_VOICES,
    normalizeRealtimeVoiceSettings,
    resolveRealtimeConfigReference,
} from './realtime/realtime-voice-config-utils.js';

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"]/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
}[ch]));

const apiConfigIconSvg = (content, className = '') => `
    <svg class="api-config-svg ${className}" viewBox="0 0 24 24" aria-hidden="true">
        ${content}
    </svg>
`;

const API_CONFIG_ICONS = Object.freeze({
    chat: apiConfigIconSvg('<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>'),
    image: apiConfigIconSvg('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="8.5" cy="10.5" r="1.5"/><path d="m21 15-4.2-4.2a2 2 0 0 0-2.8 0L6 18"/>'),
    voice: apiConfigIconSvg('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8 21h8"/>'),
    images: apiConfigIconSvg('<rect x="4" y="4" width="16" height="14" rx="3"/><path d="M8 20h9a3 3 0 0 0 3-3V9"/><circle cx="9" cy="9" r="1.4"/><path d="m20 14-3.4-3.4a2 2 0 0 0-2.8 0L7 17"/>'),
    close: apiConfigIconSvg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    plus: apiConfigIconSvg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    pencil: apiConfigIconSvg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
    trash: apiConfigIconSvg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/>'),
    key: apiConfigIconSvg('<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9"/><path d="m15 8 3 3"/><path d="m17 6 3 3"/>'),
    eye: apiConfigIconSvg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>'),
    eyeOff: apiConfigIconSvg('<path d="m3 3 18 18"/><path d="M10.6 6.2A11 11 0 0 1 12 6c6.5 0 10 6 10 6a16 16 0 0 1-2.2 2.8"/><path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 6 10 6a10 10 0 0 0 4.4-1"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/>'),
    refresh: apiConfigIconSvg('<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 6.5L4 9"/><path d="M5.5 15A7 7 0 0 0 18 17.5l2-2.5"/>'),
    filter: apiConfigIconSvg('<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3Z"/>'),
    chevronRight: apiConfigIconSvg('<path d="m9 18 6-6-6-6"/>'),
    chevronDown: apiConfigIconSvg('<path d="m6 9 6 6 6-6"/>'),
    cable: apiConfigIconSvg('<path d="M17 19h1a4 4 0 0 0 4-4V5"/><path d="M2 10v5a4 4 0 0 0 4 4h1"/><path d="M7 9h10v10H7z"/><path d="M9 9V5"/><path d="M15 9V5"/>'),
    zap: apiConfigIconSvg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>'),
    save: apiConfigIconSvg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>'),
    check: apiConfigIconSvg('<path d="m20 6-11 11-5-5"/>'),
    loader: apiConfigIconSvg('<path d="M21 12a9 9 0 1 1-6.2-8.6"/>', 'is-spinning'),
    shield: apiConfigIconSvg('<path d="M12 3 4 6v5c0 5 3.4 8.3 8 10 4.6-1.7 8-5 8-10V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>'),
});

const setApiButtonContent = (button, icon, label) => {
    if (!button) return;
    button.innerHTML = `${icon || ''}<span>${escapeHtml(label)}</span>`;
};

const MODEL_FILTER_DEBOUNCE_MS = 80;
const VERTEX_SERVICE_ACCOUNT_MASK = '••••••••••••••••';

export const shouldResetDirectProviderModel = (provider = '', model = '') => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const normalizedModel = String(model || '').trim().toLowerCase();
    if (normalizedProvider === 'kimi') return !/^(?:kimi-|moonshot-v1)/u.test(normalizedModel);
    if (normalizedProvider === 'zhipu') return !/^glm-/u.test(normalizedModel);
    return false;
};

const CHAT_PROVIDER_OPTIONS = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'makersuite', label: 'Google AI Studio (Makersuite)' },
    { value: 'vertexai', label: 'Google Vertex AI' },
    { value: 'deepseek', label: 'Deepseek' },
    { value: 'openrouter', label: 'OpenRouter' },
    { value: 'opencode', label: 'OpenCode Go' },
    { value: 'kimi', label: 'Kimi (Moonshot AI)' },
    { value: 'zhipu', label: '智谱 GLM' },
    { value: 'anthropic', label: 'Anthropic (Claude)' },
    { value: 'ollama', label: 'Ollama' },
    { value: 'custom', label: '自定义 API' },
];

const IMAGE_PROVIDER_OPTIONS = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'makersuite', label: 'Google AI Studio (Gemini/Imagen)' },
    { value: 'vertexai', label: 'Google Vertex AI' },
    { value: 'novelai', label: 'NovelAI Diffusion' },
    { value: 'stability', label: 'Stability AI' },
    { value: 'togetherai', label: 'Together AI' },
    { value: 'pollinations', label: 'Pollinations' },
    { value: 'automatic1111', label: 'AUTOMATIC1111' },
    { value: 'comfyui', label: 'ComfyUI' },
    { value: 'custom', label: '自定义 OpenAI 兼容 API' },
];

const NO_API_KEY_PROVIDERS = new Set(['pollinations', 'automatic1111', 'a1111', 'comfyui', 'comfy', 'qwen_local']);
const PROMPT_POST_PROCESSING_VALUES = new Set(['none', 'merge', 'semi', 'strict', 'single']);
const normalizePromptPostProcessingForForm = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    return PROMPT_POST_PROCESSING_VALUES.has(raw) ? raw : 'none';
};

export class ConfigPanel {
    constructor({
        onSaved = null,
        chatConfigManager = null,
        imageConfigManager = null,
        voiceSharedConfigManager = null,
        voiceTtsConfigManager = null,
        voiceSttConfigManager = null,
        voiceRegistryStore = null,
        webSearchCredentialManager = null,
    } = {}) {
        this.chatConfigManager = chatConfigManager || new ConfigManager();
        this.imageConfigManager = imageConfigManager || new ConfigManager({ scope: 'image' });
        this.voiceSharedConfigManager = voiceSharedConfigManager || new ConfigManager({ scope: 'voice_shared' });
        this.voiceTtsConfigManager = voiceTtsConfigManager || new ConfigManager({ scope: 'voice_tts' });
        this.voiceSttConfigManager = voiceSttConfigManager || new ConfigManager({ scope: 'voice_stt' });
        this.voiceRegistryStore = voiceRegistryStore;
        this.webSearchCredentialManager = webSearchCredentialManager || new ConfigManager({
            scope: 'web_search_credentials',
            credentialsOnly: true,
        });
        this.activeTab = 'chat';
        this.voiceConnectionMode = normalizeVoiceConnectionMode(appSettings.get().voiceConnectionMode);
        this.voiceConfigView = this.voiceConnectionMode;
        this.voiceCapability = 'tts';
        this.configManager = this.chatConfigManager;
        this.element = null;
        this.overlayElement = null;
        this.saveButton = null;
        this.testButton = null;
        this.modelOptions = [];
        this.voiceModelOptions = { tts: [], stt: [] };
        this.realtimeVoiceModelOptions = { realtime: [], transcription: [] };
        this.openrouterProviderOptions = [];
        this.openrouterProviderOnly = [];
        this.openrouterProviderModel = '';
        this.openrouterProviderLoadRevision = 0;
        this.modelFilterDebounceTimer = null;
        this.keyOverlay = null;
        this.keyModal = null;
        this.isRefreshingProfile = false; // 防止刷新时触发 onchange
        this.customSelectMenuEl = null;
        this.customSelectMenuCleanup = null;
        this.customSelectMenuAnchor = null;
        this.transportExpanded = false;
        this.webSearchCredentialLoadSequence = 0;
        this.excludedGenerationParams = [];
        this.customRequestParams = [];
        this.requestParamsDialog = null;
        this.openOptions = {};
        this.onSaved = typeof onSaved === 'function' ? onSaved : null;
        this.currentPage = 'main';
        this.imageGenerationParamsPanel = new ImageGenerationParamsPanel({
            getImageConfig: async () => {
                const draft = this.getDraftConfig?.({ tab: 'image' });
                if (draft) return draft;
                return await this.imageConfigManager.load();
            },
        });
        this.chatFcCompatibilityPanel = new ChatFcCompatibilityPanel({
            configManager: this.chatConfigManager,
            onChanged: () => this.updateFcCompatibilitySummary(),
        });
        this.voiceRegistryPanel = this.voiceRegistryStore ? new VoiceRegistryPanel({
            store: this.voiceRegistryStore,
            sharedManager: this.voiceSharedConfigManager,
            ttsManager: this.voiceTtsConfigManager,
            getPreferredScope: () => this.voiceConnectionMode === 'shared' ? 'voice_shared' : 'voice_tts',
        }) : null;
        this.voiceRegistryStore?.subscribe?.(() => this.updateVoiceRegistrySummary());
    }

    /**
     * 初始化并显示配置面板
     */
    async show(options = {}) {
        this.openOptions = options && typeof options === 'object' ? { ...options } : {};
        if (!this.element) {
            this.createUI();
        }

        if (this.openOptions?.tab) {
            await this.setActiveTab(this.openOptions.tab, { skipLoad: true });
        }
        this.updateTabUI();

        // 加载当前配置到表单
        let config = await this.configManager.load();
        if (!config) {
            logger.warn('配置为空，使用默认配置');
            config = this.configManager.getDefault();
        }
        this.refreshProfileOptions();
        this.populateForm(config);
        if (this.activeTab === 'voice') await this.renderRealtimeVoiceSettings();
        this.updateVoiceRegistrySummary();
        await this.refreshMaidSearchInputs?.();
        this.updateFcCompatibilitySummary();
        this.hideImageParamsPage();

        this.element.classList.remove('is-open');
        this.overlayElement.classList.remove('is-open');
        this.element.style.display = 'flex';
        this.overlayElement.style.display = 'block';
        void this.element.offsetWidth;
        this.element.classList.add('is-open');
        this.overlayElement.classList.add('is-open');
    }

    /**
     * 隐藏配置面板
     */
    hide() {
        this.requestParamsDialog?.close();
        this.realtimeSettingsPanel?.hide();
        this.realtimeReplyLanguagePicker?.close();
        if (this.modelFilterDebounceTimer !== null) {
            clearTimeout(this.modelFilterDebounceTimer);
            this.modelFilterDebounceTimer = null;
        }
        this.hideImageParamsPage();
        this.imageGenerationParamsPanel.hide();
        this.chatFcCompatibilityPanel.hide();
        if (this.element) {
            this.element.classList.remove('is-open');
            this.overlayElement.classList.remove('is-open');
            this.element.style.display = 'none';
            this.overlayElement.style.display = 'none';
        }
        const options = this.openOptions || {};
        this.openOptions = {};
        if (typeof options.onHide === 'function') {
            try {
                options.onHide();
            } catch (err) {
                logger.warn('config panel onHide failed', err);
            }
        }
    }

    async setActiveTab(tab, { skipLoad = false } = {}) {
        const next = tab === 'image' ? 'image' : tab === 'voice' ? 'voice' : 'chat';
        this.hideImageParamsPage();
        this.activeTab = next;
        if (next === 'voice') {
            this.voiceConnectionMode = normalizeVoiceConnectionMode(appSettings.get().voiceConnectionMode);
            if (this.voiceConfigView !== 'realtime') {
                this.voiceConfigView = this.voiceConnectionMode;
            }
        }
        this.configManager = this.getConfigManagerForTab(next);
        this.updateTabUI();
        this.clearModelOptions();
        this.clearVoiceModelOptions();
        this.clearRealtimeVoiceModelOptions();
        if (skipLoad) return;
        let config = await this.configManager.load();
        if (!config) config = this.configManager.getDefault();
        this.refreshProfileOptions();
        this.populateForm(config);
        if (next === 'voice') await this.renderRealtimeVoiceSettings();
        this.emitDraftChange();
    }

    getVoiceConfigManager() {
        if (this.voiceConnectionMode === 'shared') return this.voiceSharedConfigManager;
        return this.voiceCapability === 'stt' ? this.voiceSttConfigManager : this.voiceTtsConfigManager;
    }

    getConfigManagerForTab(tab = this.activeTab) {
        if (tab === 'image') return this.imageConfigManager;
        if (tab === 'voice') return this.getVoiceConfigManager();
        return this.chatConfigManager;
    }

    async setVoiceConnectionMode(mode, { skipLoad = false, persist = true } = {}) {
        this.voiceConnectionMode = normalizeVoiceConnectionMode(mode);
        this.voiceConfigView = this.voiceConnectionMode;
        if (persist) appSettings.update({ voiceConnectionMode: this.voiceConnectionMode });
        if (this.activeTab !== 'voice') return;
        this.configManager = this.getVoiceConfigManager();
        this.updateTabUI();
        this.clearModelOptions();
        this.clearVoiceModelOptions();
        this.clearRealtimeVoiceModelOptions();
        if (skipLoad) return;
        let config = await this.configManager.load();
        if (!config) config = this.configManager.getDefault();
        this.refreshProfileOptions();
        this.populateForm(config);
        this.emitDraftChange();
    }

    async setVoiceConfigView(view) {
        const next = view === 'realtime' ? 'realtime' : normalizeVoiceConnectionMode(view);
        if (next !== 'realtime') {
            await this.setVoiceConnectionMode(next);
            return;
        }
        this.voiceConfigView = 'realtime';
        if (this.activeTab !== 'voice') return;
        this.updateTabUI();
        this.clearModelOptions();
        this.clearVoiceModelOptions();
        this.clearRealtimeVoiceModelOptions();
        await this.renderRealtimeVoiceSettings();
    }

    async setVoiceCapability(capability, { skipLoad = false } = {}) {
        this.voiceCapability = normalizeVoiceCapability(capability);
        if (this.activeTab !== 'voice' || this.voiceConnectionMode !== 'split') return;
        this.configManager = this.getVoiceConfigManager();
        this.updateTabUI();
        this.clearModelOptions();
        this.clearVoiceModelOptions();
        if (skipLoad) return;
        let config = await this.configManager.load();
        if (!config) config = this.configManager.getDefault();
        this.refreshProfileOptions();
        this.populateForm(config);
        this.emitDraftChange();
    }

    emitDraftChange() {
        if (this.activeTab === 'chat') {
            this.updateFcCompatibilitySummary();
            this.refreshGenerationParamFilterSummary();
        }
        try {
            window.dispatchEvent(new CustomEvent('config-draft-changed', {
                detail: { tab: this.activeTab },
            }));
        } catch {}
    }

    async syncActiveProfileRuntime(config = null) {
        if (!window.appBridge || this.activeTab !== 'chat') return config;
        let runtime = config;
        try {
            runtime = await reloadBridgeConfig(window.appBridge) || config;
        } catch (err) {
            logger.warn('同步聊天配置切换到运行时失败，回退表单配置', err);
        }
        syncChatRuntimeConfigToBridge({
            bridge: window.appBridge,
            runtime: runtime || config || {},
            canInitClient,
            createClient: nextRuntime => new LLMClient(nextRuntime),
        });
        return runtime || config;
    }

    emitProfileChanged(profileId = '') {
        this.emitDraftChange();
        try {
            window.dispatchEvent(new CustomEvent('config-profile-changed', {
                detail: {
                    tab: this.activeTab,
                    profileId: profileId || this.configManager.getActiveProfileId?.() || '',
                },
            }));
        } catch {}
    }

    getProviderOptions() {
        if (this.activeTab === 'voice') {
            return getVoiceProviderOptions({
                mode: this.voiceConnectionMode,
                capability: this.voiceCapability,
            });
        }
        return this.activeTab === 'image' ? IMAGE_PROVIDER_OPTIONS : CHAT_PROVIDER_OPTIONS;
    }

    refreshProviderOptions() {
        if (!this.element) return;
        const select = this.element.querySelector('#config-provider');
        if (!select) return;
        const options = this.getProviderOptions();
        const current = select.value;
        const allowed = new Set(options.map(item => item.value));
        select.innerHTML = options
            .map(item => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
            .join('');
        select.value = allowed.has(current) ? current : (options[0]?.value || 'openai');
        this.refreshCustomSelect('config-provider');
    }

    providerRequiresApiKey(provider, baseUrl = '') {
        const raw = String(provider || '').trim().toLowerCase();
        if (raw === 'vertexai') return false;
        // ollama：云端（ollama.com）必须有 Key，本地可留空
        if (raw === 'ollama') return /(^|\/\/)(www\.)?ollama\.com(\/|$)/i.test(String(baseUrl || '').trim());
        return !NO_API_KEY_PROVIDERS.has(raw);
    }

    updateTabUI() {
        if (!this.element) return;
        const realtimeVoiceView = this.activeTab === 'voice' && this.voiceConfigView === 'realtime';
        this.element.classList.toggle('is-voice-realtime-view', realtimeVoiceView);
        this.refreshProviderOptions();
        const title = this.element.querySelector('#config-title');
        if (title) {
            title.textContent = this.activeTab === 'image'
                ? t('图片模型配置')
                : this.activeTab === 'voice'
                    ? t('语音模型配置')
                    : t('聊天模型配置');
        }
        const tabs = Array.from(this.element.querySelectorAll('.config-tab'));
        tabs.forEach(btn => {
            const tab = btn?.dataset?.tab || '';
            btn.classList.toggle('is-active', tab === this.activeTab);
            btn.setAttribute('aria-selected', String(tab === this.activeTab));
        });
        const imageParamsEntry = this.element.querySelector('#image-params-entry');
        if (imageParamsEntry) {
            imageParamsEntry.style.display = this.activeTab === 'image' ? 'block' : 'none';
        }
        const promptPostProcessingSection = this.element.querySelector('#config-prompt-post-processing-section');
        if (promptPostProcessingSection) {
            promptPostProcessingSection.style.display = this.activeTab === 'chat' ? 'block' : 'none';
        }
        const generationParamFilterSection = this.element.querySelector('#config-generation-param-filter-section');
        if (generationParamFilterSection) {
            generationParamFilterSection.style.display = this.activeTab === 'chat' ? 'block' : 'none';
        }
        const fcCompatibilitySection = this.element.querySelector('#config-fc-compatibility-section');
        if (fcCompatibilitySection) {
            fcCompatibilitySection.style.display = this.activeTab === 'chat' ? 'block' : 'none';
        }
        const webSearchCard = this.element.querySelector('#config-web-search-card');
        if (webSearchCard) {
            webSearchCard.style.display = this.activeTab === 'chat' ? 'block' : 'none';
        }
        const voiceRouting = this.element.querySelector('#config-voice-routing');
        if (voiceRouting) {
            voiceRouting.style.display = this.activeTab === 'voice' ? 'block' : 'none';
        }
        this.element.querySelectorAll('[data-voice-config-view]').forEach((button) => {
            const active = button.dataset.voiceConfigView === this.voiceConfigView;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const voiceCapabilityTabs = this.element.querySelector('#config-voice-capability-tabs');
        if (voiceCapabilityTabs) {
            voiceCapabilityTabs.style.display = this.activeTab === 'voice'
                && this.voiceConfigView === 'split'
                ? 'grid'
                : 'none';
        }
        this.element.querySelectorAll('[data-voice-capability]').forEach((button) => {
            const active = button.dataset.voiceCapability === this.voiceCapability;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const sharedModels = this.element.querySelector('#config-voice-shared-models');
        if (sharedModels) {
            sharedModels.style.display = this.activeTab === 'voice' && this.voiceConfigView === 'shared'
                ? 'grid'
                : 'none';
        }
        const voiceTtsSettings = this.element.querySelector('#config-voice-tts-settings');
        if (voiceTtsSettings) {
            voiceTtsSettings.style.display = this.activeTab === 'voice' && (
                this.voiceConfigView === 'shared'
                || (this.voiceConfigView === 'split' && this.voiceCapability === 'tts')
            ) ? 'block' : 'none';
        }
        const voiceSttLanguageSettings = this.element.querySelector('#config-voice-stt-language-settings');
        if (voiceSttLanguageSettings) {
            voiceSttLanguageSettings.style.display = this.activeTab === 'voice' && (
                this.voiceConfigView === 'shared'
                || (this.voiceConfigView === 'split' && this.voiceCapability === 'stt')
            ) ? 'block' : 'none';
        }
        const voiceLibraryEntry = this.element.querySelector('#config-voice-library-entry');
        if (voiceLibraryEntry) {
            voiceLibraryEntry.style.display = this.activeTab === 'voice'
                && !realtimeVoiceView
                && this.voiceRegistryPanel
                ? 'block'
                : 'none';
        }
        const realtimeVoiceCard = this.element.querySelector('#config-voice-realtime-card');
        if (realtimeVoiceCard) {
            realtimeVoiceCard.style.display = realtimeVoiceView ? 'block' : 'none';
        }
        const modelSection = this.element.querySelector('#config-model-section');
        if (modelSection) {
            modelSection.style.display = this.activeTab === 'voice'
                && (this.voiceConfigView === 'shared' || realtimeVoiceView)
                ? 'none'
                : 'block';
        }
        const openrouterRouting = this.element.querySelector('#openrouter-provider-routing');
        if (openrouterRouting) {
            const provider = this.element.querySelector('#config-provider')?.value || '';
            openrouterRouting.style.display = this.activeTab === 'chat' && provider === 'openrouter'
                ? 'block'
                : 'none';
        }
        const modelLabel = this.element.querySelector('#config-model-label');
        if (modelLabel) {
            modelLabel.textContent = this.activeTab === 'voice'
                ? this.voiceCapability === 'stt' ? 'STT 模型' : 'TTS 模型'
                : '模型';
        }
        const refreshModels = this.element.querySelector('#refresh-models');
        if (refreshModels) {
            refreshModels.style.display = this.activeTab === 'voice'
                && (this.voiceConfigView === 'shared' || realtimeVoiceView)
                ? 'none'
                : '';
        }
        const streamCard = this.element.querySelector('#config-stream-card');
        if (streamCard) streamCard.style.display = this.activeTab === 'voice' ? 'none' : 'block';
        const testButton = this.element.querySelector('#config-test');
        if (testButton) testButton.style.display = realtimeVoiceView ? 'none' : 'inline-flex';
        const saveButton = this.element.querySelector('#config-save');
        if (saveButton) saveButton.style.display = realtimeVoiceView ? 'none' : 'inline-flex';
        this.updateVoiceTtsSettings(this.element.querySelector('#config-provider')?.value || 'openai');
    }

    async showImageParamsPage() {
        if (!this.element) return;
        this.closeCustomSelectMenu();
        if (this.activeTab !== 'image') {
            await this.setActiveTab('image');
        }
        const mainPage = this.element.querySelector('#config-main-page');
        const paramsPage = this.element.querySelector('#config-image-params-page');
        if (!mainPage || !paramsPage) return;
        this.currentPage = 'imageParams';
        this.element.classList.add('is-image-params-page');
        mainPage.style.display = 'none';
        paramsPage.style.display = 'block';
        await this.imageGenerationParamsPanel.showEmbedded({
            container: paramsPage,
            onBack: () => this.hideImageParamsPage(),
        });
    }

    hideImageParamsPage() {
        if (!this.element) return;
        const mainPage = this.element.querySelector('#config-main-page');
        const paramsPage = this.element.querySelector('#config-image-params-page');
        this.currentPage = 'main';
        this.element.classList.remove('is-image-params-page');
        this.imageGenerationParamsPanel.hide();
        if (mainPage) mainPage.style.display = 'flex';
        if (paramsPage) paramsPage.style.display = 'none';
    }

    /**
     * 创建 UI 元素
     */
    createUI() {
        // 创建遮罩层
        this.overlayElement = document.createElement('div');
        this.overlayElement.id = 'config-overlay';
        this.overlayElement.className = 'api-config-overlay';
        this.overlayElement.dataset.maidGuideBack = 'api-config';
        this.overlayElement.style.cssText = `
            display: none;
            position: fixed;
            z-index: 23000;
        `;
        this.overlayElement.onclick = () => this.hide();

        // 创建配置面板
        this.element = document.createElement('div');
        this.element.id = 'config-panel';
        this.element.className = 'api-config-panel';
        this.element.innerHTML = `
            <div class="config-modal api-config-modal" role="dialog" aria-modal="true" aria-labelledby="config-title">
                <header class="api-config-header">
                    <div class="api-config-heading">
                        <div class="api-config-kicker">Aria / API Connection</div>
                        <h2 id="config-title">聊天模型配置</h2>
                    </div>
                    <div class="api-config-header-actions">
                        <span class="api-config-live-note">保存后立即生效</span>
                        <button type="button" id="config-close" class="api-config-close" data-maid-guide-back="api-config" aria-label="关闭 API 配置" title="关闭">
                            ${API_CONFIG_ICONS.close}
                        </button>
                    </div>
                </header>
                <div id="config-main-page" class="api-config-main-page" data-maid-guide-target="config-connection-fields">
                <div class="api-config-tabs-shell">
                    <div class="api-config-tabs" role="tablist" aria-label="API 配置类型">
                    <button type="button" class="config-tab api-config-tab is-active" data-tab="chat" role="tab" aria-selected="true">
                        ${API_CONFIG_ICONS.chat}
                        ${t('聊天模型')}
                    </button>
                    <button type="button" class="config-tab api-config-tab" data-tab="image" role="tab" aria-selected="false">
                        ${API_CONFIG_ICONS.image}
                        ${t('图片模型')}
                    </button>
                    <button type="button" class="config-tab api-config-tab" data-tab="voice" role="tab" aria-selected="false">
                        ${API_CONFIG_ICONS.voice}
                        ${t('语音模型')}
                    </button>
                    </div>
                </div>
                <div class="api-config-scroll">
                <section id="config-voice-routing" class="api-config-voice-routing" style="display:none;">
                    <div class="api-config-voice-routing-heading">
                        <div>
                            <strong class="has-help" data-help="共用连接为朗读和转写使用同一服务；分别配置可各选服务。实时通话单独配置。" data-help-mode="tap">语音配置</strong>
                        </div>
                    </div>
                    <div class="api-config-voice-mode-grid has-realtime" role="group" aria-label="语音配置类型">
                        <button type="button" class="api-config-voice-mode is-active" data-voice-config-view="shared" data-voice-connection-mode="shared" aria-pressed="true">
                            <strong>共用连接</strong>
                        </button>
                        <button type="button" class="api-config-voice-mode" data-voice-config-view="split" data-voice-connection-mode="split" aria-pressed="false">
                            <strong>分别配置</strong>
                        </button>
                        <button type="button" class="api-config-voice-mode" data-voice-config-view="realtime" aria-pressed="false">
                            <strong>实时通话</strong>
                        </button>
                    </div>
                    <div id="config-voice-capability-tabs" class="api-config-voice-capability-tabs" style="display:none;" role="group" aria-label="语音能力">
                        <button type="button" class="api-config-voice-capability is-active" data-voice-capability="tts" aria-pressed="true">TTS · 文字转语音</button>
                        <button type="button" class="api-config-voice-capability" data-voice-capability="stt" aria-pressed="false">STT · 语音转文字</button>
                    </div>
                </section>
                <div id="image-params-entry" class="api-config-field" style="display:none;">
                    <button type="button" id="open-image-generation-params" class="api-config-row-card">
                        <span class="api-config-row-main">
                            <span class="api-config-row-icon">${API_CONFIG_ICONS.images}</span>
                            <span class="api-config-row-copy">
                                <strong>图片生成参数</strong>
                                <small>质量、尺寸、输出格式等；所有生图入口共享</small>
                            </span>
                        </span>
                        ${API_CONFIG_ICONS.chevronRight}
                    </button>
                </div>

                <div class="api-config-field" data-maid-guide-target="config-profile-select">
                    <label class="api-config-field-label">
                        <span class="has-help" data-help="保存多份连线配置，随时切换">连线设置档</span>
                        <div class="api-config-field-tools">
                            <button id="profile-new" class="api-config-icon-action" title="新建设置档" aria-label="新建设置档">${API_CONFIG_ICONS.plus}</button>
                            <button id="profile-rename" class="api-config-icon-action" title="重命名" aria-label="重命名设置档">${API_CONFIG_ICONS.pencil}</button>
                            <button id="profile-delete" class="api-config-icon-action is-danger" title="删除" aria-label="删除设置档">${API_CONFIG_ICONS.trash}</button>
                        </div>
                    </label>
                    <select id="config-profile" data-maid-guide-target="config-profile-select" style="display:none;"></select>
                    <button type="button" id="config-profile-btn" class="world-app-select-btn" data-select-id="config-profile" data-maid-guide-target="config-profile-select">
                        <span class="config-custom-select-label">请选择设置档</span>
                        <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                    </button>
                </div>

                <div class="api-config-field">
                    <label class="api-config-field-label">服务商</label>
                    <select id="config-provider" data-maid-guide-target="config-provider-select" style="display:none;">
                        <option value="openai">OpenAI</option>
                        <option value="makersuite">Google AI Studio (Makersuite)</option>
                        <option value="vertexai">Google Vertex AI</option>
                        <option value="deepseek">Deepseek</option>
                        <option value="openrouter">OpenRouter</option>
                        <option value="opencode">OpenCode Go</option>
                        <option value="kimi">Kimi (Moonshot AI)</option>
                        <option value="zhipu">智谱 GLM</option>
                        <option value="anthropic">Anthropic (Claude)</option>
                        <option value="ollama">Ollama</option>
                        <option value="custom">自定义 API</option>
                    </select>
                    <button type="button" id="config-provider-btn" class="world-app-select-btn" data-select-id="config-provider" data-maid-guide-target="config-provider-select">
                        <span class="config-custom-select-label">请选择服务商</span>
                        <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                    </button>
                </div>

                <div id="ollama-fields" style="display: none;">
                    <div class="api-config-field">
                        <label class="api-config-field-label has-help" data-help="云端使用 ollama.com 托管模型（需 API Key）；本地连接本机 Ollama 服务（需先 ollama pull 模型）">连接模式</label>
                        <select id="config-ollama-mode" style="display:none;">
                            <option value="cloud">云端</option>
                            <option value="local">本地</option>
                        </select>
                        <button type="button" id="config-ollama-mode-btn" class="world-app-select-btn" data-select-id="config-ollama-mode">
                            <span class="config-custom-select-label">云端</span>
                            <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                        </button>
                    </div>
                </div>

                <div id="kimi-fields" style="display: none;">
                    <div class="api-config-field">
                        <label class="api-config-field-label has-help" data-help="全球站与中国大陆站使用不同的 API Key；请选择生成 Key 的对应站点">Kimi 连接站点</label>
                        <select id="config-kimi-region" style="display:none;">
                            <option value="global">全球站（api.moonshot.ai）</option>
                            <option value="china">中国大陆站（api.moonshot.cn）</option>
                        </select>
                        <button type="button" id="config-kimi-region-btn" class="world-app-select-btn" data-select-id="config-kimi-region">
                            <span class="config-custom-select-label">全球站（api.moonshot.ai）</span>
                            <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                        </button>
                    </div>
                </div>

                <div id="config-api-format-section" class="api-config-field" style="display:none;">
                    <span id="config-api-format-label" class="api-config-field-label has-help" data-help="按服务商文档选择接口格式：Chat Completions 使用 /chat/completions，Responses 使用 /responses。模型列表沿用刷新与手动填写，工具等能力以渠道支持为准。">接口格式</span>
                    <div class="api-config-format-picker" role="radiogroup" aria-labelledby="config-api-format-label">
                        <label class="api-config-format-option">
                            <input type="radio" name="config-api-format" value="chat_completions" checked>
                            <span translate="no">Chat Completions</span>
                        </label>
                        <label class="api-config-format-option">
                            <input type="radio" name="config-api-format" value="responses">
                            <span translate="no">Responses</span>
                        </label>
                    </div>
                </div>

                <div id="config-custom-fields" data-maid-guide-target="config-custom-fields">
                <div id="config-baseurl-section" class="api-config-field">
                    <label class="api-config-field-label has-help" data-help="内建服务商自动使用默认地址；仅自定义 API 需填写">API Base URL</label>
                    <input type="text" id="config-baseurl" data-maid-guide-target="config-base-url-input" placeholder="https://api.openai.com/v1"
                           style="width: 100%; padding: 10px; border-radius: 5px; border: 1px solid var(--app-border-default); font-size: 14px; box-sizing: border-box;">
                </div>

                <div class="api-config-field">
                    <label class="api-config-field-label">
                        <span id="apikey-help" class="has-help" data-help="可在 Key 管理中保存多个凭证" data-help-mode="tap">API Key</span>
                        <div class="api-config-field-tools">
                            <button id="toggle-apikey" class="api-config-text-action">${API_CONFIG_ICONS.eye}<span>显示</span></button>
                            <button id="manage-keys" class="api-config-icon-action" title="管理已保存的 Key" aria-label="管理已保存的 Key">${API_CONFIG_ICONS.key}</button>
                        </div>
                    </label>
                    <input type="password" id="config-apikey" data-maid-guide-target="config-api-key-input" placeholder="sk-..."
                           style="width: 100%; padding: 10px; border-radius: 5px; border: 1px solid var(--app-border-default); font-size: 14px; box-sizing: border-box;">
                </div>
                </div>

                <div id="vertexai-fields" style="display: none;">
                    <div class="api-config-field">
                        <label class="api-config-field-label has-help" data-help="完整模式使用 Google Cloud Service Account 与项目额度；Express 模式使用专用 API Key">连接模式</label>
                        <select id="config-vertex-auth-mode" style="display:none;">
                            <option value="service_account">完整模式（Service Account）</option>
                            <option value="express">Express 模式（API Key）</option>
                        </select>
                        <button type="button" id="config-vertex-auth-mode-btn" class="world-app-select-btn" data-select-id="config-vertex-auth-mode">
                            <span class="config-custom-select-label">请选择连接模式</span>
                            <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                        </button>
                    </div>

                    <div id="vertexai-region-field" class="api-config-field">
                        <label class="api-config-field-label has-help" data-help="Vertex AI 区域">Region</label>
                        <select id="config-region" style="display:none;">
                            <option value="global">global（推荐）</option>
                            <option value="us-central1">us-central1</option>
                            <option value="us-east1">us-east1</option>
                            <option value="us-west1">us-west1</option>
                            <option value="europe-west1">europe-west1</option>
                            <option value="asia-southeast1">asia-southeast1</option>
                        </select>
                        <button type="button" id="config-region-btn" class="world-app-select-btn" data-select-id="config-region">
                            <span class="config-custom-select-label">请选择 Region</span>
                            <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                        </button>
                    </div>

                    <div id="vertexai-service-account-field" class="api-config-field">
                        <label class="api-config-field-label">
                            <span class="has-help" data-help="粘贴从 Google Cloud 下载的 Service Account JSON；Project ID 会自动识别。凭证保存在本机加密 Keyring。" data-help-mode="tap">Service Account JSON</span>
                            <button id="toggle-sa" class="api-config-text-action">${API_CONFIG_ICONS.eye}<span>显示</span></button>
                        </label>
                        <textarea id="config-serviceaccount" data-maid-guide-target="config-service-account-input" placeholder='{"type": "service_account", "project_id": "your-project", ...}'
                                  style="width: 100%; padding: 10px; border-radius: 5px; border: 1px solid var(--app-border-default); font-size: 12px; box-sizing: border-box; font-family: monospace; min-height: 100px; resize: vertical;"></textarea>
                    </div>
                </div>

                <div id="config-voice-shared-models" class="api-config-voice-model-grid" style="display:none;">
                    <div class="api-config-field">
                        <label class="api-config-field-label">
                            <span class="has-help" data-help="负责把角色回复转换成语音" data-help-mode="tap">TTS 模型</span>
                            <button type="button" id="refresh-voice-tts-models" class="api-config-refresh-action">
                                ${API_CONFIG_ICONS.refresh}<span>刷新列表</span>
                            </button>
                        </label>
                        <div class="api-config-model-picker">
                            <input type="text" id="config-voice-tts-model" placeholder="gpt-4o-mini-tts">
                            <div id="voice-tts-model-options" class="api-config-model-options" aria-label="可用 TTS 模型列表" style="display:none;"></div>
                        </div>
                        <small id="config-voice-tts-model-help" class="api-config-field-status" role="status"></small>
                    </div>
                    <div class="api-config-field">
                        <label class="api-config-field-label">
                            <span class="has-help" data-help="负责把麦克风录音转换成文字" data-help-mode="tap">STT 模型</span>
                            <button type="button" id="refresh-voice-stt-models" class="api-config-refresh-action">
                                ${API_CONFIG_ICONS.refresh}<span>刷新列表</span>
                            </button>
                        </label>
                        <div class="api-config-model-picker">
                            <input type="text" id="config-voice-stt-model" placeholder="gpt-transcribe">
                            <div id="voice-stt-model-options" class="api-config-model-options" aria-label="可用 STT 模型列表" style="display:none;"></div>
                        </div>
                        <small id="config-voice-stt-model-help" class="api-config-field-status" role="status"></small>
                    </div>
                </div>

                <div id="config-voice-tts-settings" class="api-config-field" style="display:none;">
                    <label class="api-config-field-label"><span id="config-voice-tts-voice-help" class="has-help" data-help="OpenAI 声音名称；推荐 marin 或 cedar" data-help-mode="tap">默认声音</span></label>
                    <input type="text" id="config-voice-tts-voice" placeholder="marin" autocomplete="off">
                    <div id="config-voice-tts-voice-presets" class="api-config-voice-presets" role="group" aria-label="声音快捷选择"></div>
                </div>

                <div id="config-voice-stt-language-settings" class="api-config-field" style="display:none;">
                    <label class="api-config-field-label" for="config-voice-stt-language"><span class="has-help" data-help="用于普通录音转写的语言提示，保存在当前连线档。" data-help-mode="tap">输入识别语言</span></label>
                    <select id="config-voice-stt-language" style="display:none;">
                        <option value="">自动识别</option>
                        <option value="zh">普通话／中文</option>
                        <option value="zh,en">中文 + 英文</option>
                        <option value="en">英文</option>
                        <option value="ja">日文</option>
                        <option value="ko">韩文</option>
                    </select>
                    <button type="button" id="config-voice-stt-language-btn" class="world-app-select-btn" data-select-id="config-voice-stt-language">
                        <span class="config-custom-select-label">自动识别</span>
                        <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                    </button>
                </div>

                <div id="config-voice-library-entry" class="api-config-field" style="display:none;">
                    <button type="button" id="open-voice-library" class="api-config-row-card">
                        <span class="api-config-row-main">
                            <span class="api-config-row-icon">${API_CONFIG_ICONS.voice}</span>
                            <span class="api-config-row-copy">
                                <strong>人物声音库</strong>
                                <small id="config-voice-library-summary"></small>
                            </span>
                        </span>
                        ${API_CONFIG_ICONS.chevronRight}
                    </button>
                </div>

                <section id="config-voice-realtime-card" class="api-config-realtime-card" style="display:none;">
                    <div class="api-config-realtime-heading">
                        <span class="api-config-row-icon">${API_CONFIG_ICONS.cable}</span>
                        <div>
                            <strong class="has-help" data-help="为创意写作和私聊配置双向语音通话。" data-help-mode="tap">实时语音通话</strong>
                        </div>
                    </div>
                    <div class="api-config-realtime-grid">
                        <label class="api-config-realtime-field is-wide">
                            <span class="has-help" data-help="使用已保存的官方 OpenAI 设置档与凭证。" data-help-mode="tap">OpenAI 连线设置档</span>
                            <select id="config-realtime-profile"></select>
                        </label>
                        <div class="api-config-realtime-field">
                            <label class="api-config-field-label" for="config-realtime-model">
                                <span class="has-help" data-help="负责持续理解语音并生成角色回复。输入与输出音频发送给 OpenAI。" data-help-mode="tap">Realtime 模型</span>
                                <button type="button" id="refresh-realtime-models" class="api-config-refresh-action">
                                    ${API_CONFIG_ICONS.refresh}<span>刷新列表</span>
                                </button>
                            </label>
                            <div class="api-config-model-picker">
                                <input type="text" id="config-realtime-model" placeholder="gpt-realtime-2.1" autocomplete="off">
                                <div id="realtime-model-options" class="api-config-model-options" aria-label="可用 Realtime 模型列表" style="display:none;"></div>
                            </div>
                        </div>
                        <div class="api-config-realtime-field">
                            <label class="api-config-field-label" for="config-realtime-transcription-model">
                                <span class="has-help" data-help="把用户语音转成文字记录，按转写模型独立计费。" data-help-mode="tap">输入转写模型</span>
                                <button type="button" id="refresh-realtime-transcription-models" class="api-config-refresh-action">
                                    ${API_CONFIG_ICONS.refresh}<span>刷新列表</span>
                                </button>
                            </label>
                            <div class="api-config-model-picker">
                                <input type="text" id="config-realtime-transcription-model" placeholder="gpt-4o-mini-transcribe" autocomplete="off">
                                <div id="realtime-transcription-model-options" class="api-config-model-options" aria-label="可用输入转写模型列表" style="display:none;"></div>
                            </div>
                        </div>
                        <div class="api-config-realtime-field">
                            <span class="has-help" data-help="用于实时通话的输入转写。" data-help-mode="tap">输入识别语言</span>
                            <select id="config-realtime-transcription-language" style="display:none;">
                                <option value="">自动识别</option>
                                <option value="zh">普通话／中文</option>
                                <option value="zh,en">中文 + 英文</option>
                                <option value="en">英文</option>
                                <option value="ja">日文</option>
                                <option value="ko">韩文</option>
                            </select>
                            <button type="button" id="config-realtime-transcription-language-btn" class="world-app-select-btn" data-select-id="config-realtime-transcription-language">
                                <span class="config-custom-select-label">自动识别</span>
                                <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                            </button>
                        </div>
                        ${realtimeReplyLanguageField('config-realtime-reply-language')}
                        <label class="api-config-realtime-field">
                            <span>声音</span>
                            <select id="config-realtime-voice">
                                ${OPENAI_REALTIME_VOICES.map(voice => `<option value="${voice}">${voice}</option>`).join('')}
                            </select>
                        </label>
                        <label class="api-config-realtime-field">
                            <span>停顿判定</span>
                            <select id="config-realtime-vad-mode">
                                <option value="server_vad">Server VAD</option>
                                <option value="semantic_vad">Semantic VAD</option>
                            </select>
                        </label>
                        <label class="api-config-realtime-field">
                            <span>静音挂断（分钟）</span>
                            <input id="config-realtime-idle-timeout" type="number" min="1" max="30" step="1">
                        </label>
                    </div>
                    <div class="api-config-realtime-actions">
                        <button type="button" id="config-realtime-save" class="api-config-text-action is-primary">
                            ${API_CONFIG_ICONS.save}<span>保存实时通话</span>
                        </button>
                    </div>
                    <small id="config-realtime-status" class="api-config-realtime-status" role="status"></small>
                </section>

                <div id="config-model-section" class="api-config-field" data-maid-guide-target="config-model-section">
                    <label class="api-config-field-label">
                        <span id="config-model-label" class="has-help" data-help="要使用的模型 ID（可输入或从列表选择）" data-help-mode="tap">模型</span>
                        <button id="refresh-models" class="api-config-refresh-action" data-maid-guide-target="config-refresh-models">
                            ${API_CONFIG_ICONS.refresh}<span>刷新列表</span>
                        </button>
                    </label>
                    <div id="config-model-picker" data-maid-guide-target="config-model-picker">
                        <input type="text" id="config-model" data-maid-guide-target="config-model-select" placeholder="gpt-3.5-turbo"
                               style="width: 100%; padding: 10px 12px; border-radius: 5px; border: 1px solid var(--app-border-default); font-size: 14px; box-sizing: border-box;">
                        <div id="model-options" class="api-config-model-options" aria-label="可用模型列表" style="display:none;"></div>
                    </div>
                    <small id="model-help" class="api-config-field-status" role="status" style="color: var(--app-text-secondary);"></small>
                </div>

                <div id="openrouter-provider-routing" class="api-config-field" style="display:none;">
                    <label class="api-config-field-label">
                        <span>上游服务商</span>
                        <button id="refresh-openrouter-providers" class="api-config-refresh-action" type="button">
                            ${API_CONFIG_ICONS.refresh}<span>刷新上游</span>
                        </button>
                    </label>
                    <div id="openrouter-provider-options" class="api-config-provider-options" role="group" aria-label="OpenRouter 上游服务商"></div>
                    <small id="openrouter-provider-help">不指定表示允许全部可用上游；选择后只使用已选服务商。</small>
                </div>

                <div id="config-web-search-card" class="api-config-stream-card">
                    <label>
                        <input type="checkbox" id="config-web-search" style="width: 18px; height: 18px;">
                        <span>
                            <strong class="has-help" data-help="允许当前聊天模型按需检索公开网页；搜索服务可能另行计费" data-help-mode="press">联网</strong>
                            <small>默认关闭；开启后优先使用模型原生搜索，其余模型使用只读网页工具</small>
                        </span>
                    </label>
                    <div id="config-maid-search-row" style="display: grid; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--app-border-subtle);">
                        <label class="api-config-field-label has-help" data-help="女仆的 web.search 与聊天模型的兜底搜索共用此服务；全局设置，即时保存" data-help-mode="press">搜索服务</label>
                        <select id="config-maid-search-provider" style="width: 100%; padding: 8px 10px; border-radius: 5px; border: 1px solid var(--app-border-default); font-size: 13px; box-sizing: border-box;">
                            <option value="duckduckgo">DuckDuckGo（免 Key，默认）</option>
                            <option value="brave">Brave（每月 2000 次免费，需 Key）</option>
                            <option value="tavily">Tavily（每月 1000 credits 免费，需 Key）</option>
                            <option value="serpapi">SerpAPI（Google 结果，需 Key）</option>
                        </select>
                        <input type="password" id="config-maid-search-key" placeholder="搜索服务 API Key（DuckDuckGo 无需填写）" autocomplete="off"
                               style="width: 100%; padding: 8px 10px; border-radius: 5px; border: 1px solid var(--app-border-default); font-size: 13px; box-sizing: border-box;">
                    </div>
                </div>

                <div id="config-stream-card" class="api-config-stream-card">
                    <label>
                        <input type="checkbox" id="config-stream" style="width: 18px; height: 18px;">
                        <span>
                            <strong class="has-help" data-help="实时显示 AI 的回复过程" data-help-mode="press">启用流式响应</strong>
                            <small>逐字流式输出，角色回复更自然</small>
                        </span>
                    </label>
                </div>

                <div id="config-prompt-post-processing-section" class="api-config-field">
                    <label class="api-config-field-label has-help" data-help="仅聊天请求生效；越靠后兼容性越强，但对原始提示词改动越大。">提示词后处理</label>
                    <select id="config-prompt-post-processing" style="display:none;">
                        <option value="none">不处理（默认）</option>
                        <option value="merge">合并连续同角色</option>
                        <option value="semi">半严格（强制角色交替）</option>
                        <option value="strict">严格（强制 user 最先、角色交替）</option>
                        <option value="single">单一用户消息</option>
                    </select>
                    <button type="button" id="config-prompt-post-processing-btn" class="world-app-select-btn" data-select-id="config-prompt-post-processing">
                        <span class="config-custom-select-label">不处理（默认）</span>
                        <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                    </button>
                </div>

                <div id="config-generation-param-filter-section" class="api-config-field">
                    <button type="button" id="open-generation-param-filter" class="api-config-row-card">
                        <span class="api-config-row-main">
                            <span class="api-config-row-icon">${API_CONFIG_ICONS.filter}</span>
                            <span class="api-config-row-copy">
                                <strong>请求参数</strong>
                                <small id="generation-param-filter-summary">${t('附加 {custom} · 排除 {excluded}', { custom: 0, excluded: 0 })}</small>
                            </span>
                        </span>
                        ${API_CONFIG_ICONS.chevronRight}
                    </button>
                </div>

                <div id="config-fc-compatibility-section" class="api-config-field">
                    <button type="button" id="open-fc-compatibility" class="api-config-row-card">
                        <span class="api-config-row-main">
                            <span class="api-config-row-icon">${API_CONFIG_ICONS.shield}</span>
                            <span class="api-config-row-copy">
                                <strong>聊天格式兼容性（高级）</strong>
                                <small id="fc-compatibility-summary">内建兼容库 revision 1 · 0 条本地规则</small>
                            </span>
                        </span>
                        ${API_CONFIG_ICONS.chevronRight}
                    </button>
                </div>

                <div class="api-config-timeout-row">
                    <label>
                        <span>
                            <strong class="has-help" data-help="请求超过此时长将中止（10–9000 秒）">请求超时（秒）</strong>
                            <small>长上下文推理或生图任务建议适当放宽</small>
                        </span>
                        <input id="config-timeout" type="number" min="10" max="9000" step="5" value="60" inputmode="numeric"
                               style="width: 120px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--app-border-default); font-size: 14px; text-align:right;">
                    </label>
                </div>

                <div id="config-transport-section" class="api-config-accordion">
                    <button type="button" id="config-transport-toggle" aria-expanded="false">
                        <span class="api-config-row-icon">${API_CONFIG_ICONS.cable}</span>
                        <div style="display:flex; flex-direction:column; gap:2px;">
                            <span style="font-weight:800; color:var(--app-text-primary);">高级连线与反代</span>
                            <span id="config-transport-summary" style="font-size:12px; color:var(--app-text-muted);">默认直连，只有需要代理出口时再展开</span>
                        </div>
                        <span id="config-transport-chevron" aria-hidden="true">${API_CONFIG_ICONS.chevronDown}</span>
                    </button>
                    <div id="config-transport-content" class="api-config-accordion-content" aria-hidden="true">
                    <div class="api-config-accordion-inner">
                        <div style="margin-bottom: 14px;">
                            <label class="has-help" data-help="一般保持直连，需要走代理出口时再改。" style="display:block; margin-bottom:5px; font-weight:bold;">连线模式</label>
                            <select id="config-transport-mode" style="display:none;">
                                <option value="direct">直连</option>
                                <option value="reverse_proxy">反代出口</option>
                            </select>
                            <button type="button" id="config-transport-mode-btn" class="world-app-select-btn" data-select-id="config-transport-mode" style="margin-top:2px;">
                                <span class="config-custom-select-label">直连</span>
                                <span class="world-app-select-btn-chevron">${API_CONFIG_ICONS.chevronDown}</span>
                            </button>
                        </div>

                        <div id="config-proxy-fields" style="display:none;">
                            <div style="margin-bottom: 14px;">
                                <label class="has-help" data-help="填这里即可。API Key 照常填写，请求会保留原协议、改走此出口。" style="display:block; margin-bottom:5px; font-weight:bold;">反代 URL</label>
                                <input type="text" id="config-proxy-baseurl" placeholder="https://proxy.example.com/llm"
                                       style="width:100%; padding:10px; border-radius:5px; border:1px solid var(--app-border-default); font-size:14px; box-sizing:border-box;">
                            </div>

                            <div id="config-proxy-auth-header-row" style="margin-bottom: 14px; display:none;">
                                <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:5px; font-weight:bold;">
                                    <span class="has-help" data-help="如你的反代需要额外密钥，可填写自定义 Header 名。">代理鉴权 Header</span>
                                    <span style="font-size:12px; color:var(--app-text-muted); font-weight:600;">可选</span>
                                </label>
                                <input type="text" id="config-proxy-auth-header" placeholder="X-Proxy-Auth / Authorization"
                                       style="width:100%; padding:10px; border-radius:5px; border:1px solid var(--app-border-default); font-size:14px; box-sizing:border-box;">
                            </div>

                            <div id="config-proxy-auth-token-row" style="margin-bottom: 14px; display:none;">
                                <label style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:5px; font-weight:bold;">
                                    <span class="has-help" data-help="若反代不要求单独鉴权，这里留空即可。">代理鉴权 Token</span>
                                    <button id="toggle-proxy-token" type="button" class="api-config-text-action">${API_CONFIG_ICONS.eye}<span>显示</span></button>
                                </label>
                                <input type="password" id="config-proxy-auth-token" placeholder="可选"
                                       style="width:100%; padding:10px; border-radius:5px; border:1px solid var(--app-border-default); font-size:14px; box-sizing:border-box;">
                            </div>

                            <div id="config-forward-provider-auth-row" style="margin-bottom: 2px; display:none;">
                                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                                    <input type="checkbox" id="config-forward-provider-auth" checked style="width:18px; height:18px;">
                                    <span class="has-help" data-help="关闭后，会移除原本的 API Key / Authorization，仅保留反代鉴权。" data-help-mode="press" style="font-weight:700;">同时转发原服务商鉴权信息</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
                </div>
                </div>
                <footer class="api-config-footer">
                <div id="config-status" class="api-config-status" style="display:none;"></div>
                <div class="api-config-footer-actions">
                    <button id="config-test" class="api-config-button is-secondary">
                        ${API_CONFIG_ICONS.zap}<span>测试连接</span>
                    </button>
                    <button id="config-cancel" class="api-config-button is-secondary" data-maid-guide-back="api-config">
                        取消
                    </button>
                    <button id="config-save" class="api-config-button is-primary" data-maid-guide-target="config-save-btn">
                        ${API_CONFIG_ICONS.save}<span>保存</span>
                    </button>
                </div>
                </footer>
                </div>
                <div id="config-image-params-page" style="display:none;"></div>
            </div>
        `;
        this.element.style.cssText = `
            display: none;
            position: fixed;
            z-index: 23010;
        `;

        // 阻止点击面板时关闭
        this.element.onclick = (e) => e.stopPropagation();

        const tabButtons = Array.from(this.element.querySelectorAll('.config-tab'));
        tabButtons.forEach((btn) => {
            btn.addEventListener('click', async () => {
                const tab = btn?.dataset?.tab || 'chat';
                await this.setActiveTab(tab);
            });
        });
        this.element.querySelectorAll('[data-voice-config-view]').forEach((button) => {
            button.addEventListener('click', async () => {
                await this.setVoiceConfigView(button.dataset.voiceConfigView);
            });
        });
        this.element.querySelectorAll('[data-voice-capability]').forEach((button) => {
            button.addEventListener('click', async () => {
                await this.setVoiceCapability(button.dataset.voiceCapability);
            });
        });
        this.updateTabUI();

        // 绑定事件
        this.saveButton = this.element.querySelector('#config-save');
        this.testButton = this.element.querySelector('#config-test');

        this.saveButton.onclick = () => this.onSave();
        this.element.querySelector('#config-cancel').onclick = () => this.hide();
        this.element.querySelector('#config-close').onclick = () => this.hide();
        this.testButton.onclick = () => this.onTest();
        this.element.querySelector('#toggle-apikey').onclick = () => this.toggleApiKey();
        this.element.querySelector('#manage-keys').onclick = () => this.openKeyManager();
        this.element.querySelector('#profile-new').onclick = () => this.createProfile();
        this.element.querySelector('#profile-rename').onclick = () => this.renameProfile();
        this.element.querySelector('#profile-delete').onclick = () => this.deleteProfile();
        this.element.querySelector('#toggle-sa')?.addEventListener('click', () => this.toggleServiceAccount());
        this.element.querySelector('#refresh-models').onclick = () => this.refreshModels();
        this.element.querySelector('#refresh-openrouter-providers')?.addEventListener('click', () => {
            void this.refreshOpenRouterProviders();
        });
        this.element.querySelector('#config-transport-toggle').onclick = () => this.toggleTransportSection();
        this.element.querySelector('#toggle-proxy-token').onclick = () => this.toggleProxyToken();
        this.element.querySelector('#open-generation-param-filter')?.addEventListener('click', () => {
            this.openGenerationParamFilterDialog();
        });
        this.element.querySelector('#open-image-generation-params')?.addEventListener('click', () => {
            this.showImageParamsPage();
        });
        this.element.querySelector('#open-fc-compatibility')?.addEventListener('click', () => {
            this.chatFcCompatibilityPanel.show().catch((error) => {
                logger.error('打开 FC 兼容性面板失败', error);
                this.showStatus(`打开 FC 兼容性失败: ${error.message}`, 'error');
            });
        });

        // 连线设置档切换
        this.element.querySelector('#config-profile').onchange = async (e) => {
            // 防止刷新选项时触发 onchange
            if (this.isRefreshingProfile) {
                logger.debug('忽略配置选择器的 onchange（刷新中）');
                return;
            }

            const profileId = e.target.value;
            logger.info(`用户切换配置: ${profileId.slice(0, 20)}...`);
            await this.configManager.setActiveProfile(profileId);
            const config = await this.configManager.load();
            this.populateForm(config);
            await this.syncActiveProfileRuntime(config);
            this.emitProfileChanged(profileId);
        };

        // Provider 切换时更新默认值和字段可见性
        this.element.querySelector('#config-provider').onchange = async (e) => {
            const provider = e.target.value;
            this.setApiFormat('chat_completions');
            if (this.activeTab === 'voice') this.clearVoiceModelOptions();
            this.updateDefaultsForProvider(provider);
            this.setOpenRouterProviderState({
                model: this.element.querySelector('#config-model')?.value || '',
            });
            this.updateFieldVisibility(provider);
            this.emitDraftChange();
        };
        this.element.querySelectorAll('input[name="config-api-format"]').forEach(input => {
            input.addEventListener('change', () => {
                this.emitDraftChange();
            });
        });
        this.element.querySelector('#config-region').onchange = async () => {
            const provider = this.element.querySelector('#config-provider')?.value || 'openai';
            if (provider === 'vertexai') {
                this.updateDefaultsForProvider(provider);
            }
            this.emitDraftChange();
        };
        this.element.querySelector('#config-vertex-auth-mode').onchange = async () => {
            const provider = this.element.querySelector('#config-provider')?.value || 'openai';
            if (provider === 'vertexai') {
                const authMode = normalizeVertexAuthMode(
                    this.element.querySelector('#config-vertex-auth-mode')?.value,
                );
                if (authMode === VERTEX_AUTH_MODE_EXPRESS) {
                    const regionInput = this.element.querySelector('#config-region');
                    if (regionInput) regionInput.value = 'global';
                }
                this.updateDefaultsForProvider(provider);
                this.updateFieldVisibility(provider);
            }
            this.emitDraftChange();
        };
        this.element.querySelector('#config-ollama-mode').onchange = async () => {
            const provider = this.element.querySelector('#config-provider')?.value || 'openai';
            if (provider === 'ollama') {
                this.updateDefaultsForProvider(provider);
                this.updateFieldVisibility(provider);
            }
            this.emitDraftChange();
        };
        this.element.querySelector('#config-kimi-region').onchange = async () => {
            const provider = this.element.querySelector('#config-provider')?.value || 'openai';
            if (provider === 'kimi') {
                this.updateDefaultsForProvider(provider);
                this.updateFieldVisibility(provider);
            }
            this.emitDraftChange();
        };
        this.element.querySelector('#config-transport-mode').onchange = async () => {
            this.updateTransportVisibility({ autoExpand: true });
            this.emitDraftChange();
        };
        this.element.querySelector('#config-prompt-post-processing').onchange = async () => {
            this.emitDraftChange();
        };
        this.element.querySelector('#config-web-search')?.addEventListener('change', async (event) => {
            const input = event.currentTarget;
            if (input?.checked) {
                input.disabled = true;
                const confirmed = await appConfirm({
                    title: '开启联网',
                    message: '联网可能产生额外费用，并会把本次请求交给模型服务商或搜索服务处理。要为当前 API 设置档开启吗？',
                    confirmText: '开启联网',
                    cancelText: '保持关闭',
                });
                input.checked = confirmed === true;
                input.disabled = false;
            }
            this.emitDraftChange();
        });
        // 女仆/兜底搜索服务是全局 app 设置（非 API 设置档），改动即时保存
        const maidSearchProviderEl = this.element.querySelector('#config-maid-search-provider');
        const maidSearchKeyEl = this.element.querySelector('#config-maid-search-key');
        const refreshMaidSearchInputs = async () => {
            const settings = appSettings.get();
            const provider = settings.webSearchProvider || 'duckduckgo';
            if (maidSearchProviderEl) maidSearchProviderEl.value = provider;
            await this.loadWebSearchCredentialForProvider(provider, {
                providerElement: maidSearchProviderEl,
                keyElement: maidSearchKeyEl,
            });
        };
        void refreshMaidSearchInputs();
        this.refreshMaidSearchInputs = refreshMaidSearchInputs;
        maidSearchProviderEl?.addEventListener('change', async () => {
            const provider = maidSearchProviderEl.value;
            appSettings.update({ webSearchProvider: provider });
            await this.loadWebSearchCredentialForProvider(provider, {
                providerElement: maidSearchProviderEl,
                keyElement: maidSearchKeyEl,
            });
        });
        maidSearchKeyEl?.addEventListener('change', async () => {
            const provider = maidSearchProviderEl?.value || appSettings.get().webSearchProvider;
            if (
                maidSearchKeyEl.disabled
                || maidSearchKeyEl.dataset.webSearchProvider !== provider
            ) return;
            await this.webSearchCredentialManager.setWebSearchApiKey(provider, maidSearchKeyEl.value);
        });
        this.element.querySelector('#config-model')?.addEventListener('input', () => {
            this.handleOpenRouterModelInput();
            this.emitDraftChange();
            this.scheduleModelOptionsRender();
        });
        this.element.querySelector('#config-voice-tts-model')?.addEventListener('input', () => {
            this.emitDraftChange();
            this.renderVoiceModelOptions('tts', this.voiceModelOptions.tts);
        });
        this.element.querySelector('#config-voice-stt-model')?.addEventListener('input', () => {
            this.emitDraftChange();
            this.renderVoiceModelOptions('stt', this.voiceModelOptions.stt);
        });
        this.element.querySelector('#config-voice-stt-language')?.addEventListener('change', () => {
            this.emitDraftChange();
        });
        this.element.querySelector('#refresh-voice-tts-models')?.addEventListener('click', () => {
            void this.refreshVoiceModels('tts');
        });
        this.element.querySelector('#refresh-voice-stt-models')?.addEventListener('click', () => {
            void this.refreshVoiceModels('stt');
        });
        this.element.querySelector('#config-voice-tts-voice')?.addEventListener('input', () => {
            this.syncVoicePresetSelection();
            this.emitDraftChange();
        });
        this.element.querySelector('#config-voice-tts-voice-presets')?.addEventListener('click', (event) => {
            const button = event.target?.closest?.('[data-voice-preset]');
            if (!button) return;
            const input = this.element.querySelector('#config-voice-tts-voice');
            if (!input) return;
            input.value = String(button.dataset.voicePreset || '');
            this.syncVoicePresetSelection();
            this.emitDraftChange();
        });
        this.element.querySelector('#open-voice-library')?.addEventListener('click', () => {
            void this.voiceRegistryPanel?.show?.();
        });
        this.element.querySelector('#config-realtime-model')?.addEventListener('input', () => {
            this.renderRealtimeVoiceModelOptions('realtime', this.realtimeVoiceModelOptions.realtime);
        });
        this.element.querySelector('#config-realtime-transcription-model')?.addEventListener('input', () => {
            this.renderRealtimeVoiceModelOptions('transcription', this.realtimeVoiceModelOptions.transcription);
        });
        this.element.querySelector('#refresh-realtime-models')?.addEventListener('click', () => {
            void this.refreshRealtimeVoiceModels('realtime');
        });
        this.element.querySelector('#refresh-realtime-transcription-models')?.addEventListener('click', () => {
            void this.refreshRealtimeVoiceModels('transcription');
        });
        this.element.querySelector('#config-realtime-save')?.addEventListener('click', () => {
            void this.saveRealtimeVoiceSettings();
        });
        this.element.querySelector('#config-baseurl')?.addEventListener('input', () => this.emitDraftChange());

        this.initCustomSelects();
        this.realtimeReplyLanguagePicker?.destroy();
        this.realtimeReplyLanguagePicker = bindRealtimeReplyLanguagePicker(this.element.querySelector('#config-realtime-reply-language'));

        document.body.appendChild(this.overlayElement);
        document.body.appendChild(this.element);
    }

    async loadWebSearchCredentialForProvider(provider, {
        providerElement = null,
        keyElement = null,
    } = {}) {
        const normalizedProvider = String(provider || 'duckduckgo').trim().toLowerCase() || 'duckduckgo';
        const sequence = ++this.webSearchCredentialLoadSequence;
        if (keyElement) {
            keyElement.disabled = true;
            keyElement.value = '';
            keyElement.dataset.webSearchProvider = '';
        }

        let key = '';
        try {
            key = String(await this.webSearchCredentialManager.getWebSearchApiKey(normalizedProvider) || '');
        } catch (error) {
            if (sequence === this.webSearchCredentialLoadSequence) {
                logger.warn(`读取搜索凭证失败: ${normalizedProvider}`, error);
            }
        }

        const currentProvider = String(providerElement?.value || normalizedProvider).trim().toLowerCase();
        if (
            sequence !== this.webSearchCredentialLoadSequence
            || currentProvider !== normalizedProvider
        ) return false;

        if (keyElement) {
            keyElement.value = key;
            keyElement.disabled = false;
            keyElement.dataset.webSearchProvider = normalizedProvider;
        }
        return true;
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
            this.customSelectMenuEl.classList.remove('is-maid-guide-menu');
            delete this.customSelectMenuEl.dataset.selectId;
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
        menu.classList.toggle('is-maid-guide-menu', Boolean(anchorEl.dataset.maidGuideTarget));
        menu.dataset.selectId = String(anchorEl.dataset.selectId || '');
        const current = String(currentValue ?? '').trim();
        const opts = Array.isArray(options) ? options : [];
        menu.innerHTML = opts.map((opt) => {
            const value = String(opt?.value ?? '');
            const label = escapeHtml(String(opt?.label ?? value));
            const selected = value === current;
            return `
                <button type="button" class="world-app-select-item ${selected ? 'is-selected' : ''}" data-value="${value.replace(/"/g, '&quot;')}">
                    <span class="world-app-select-item-label">${label}</span>
                    <span class="world-app-select-item-check">${selected ? API_CONFIG_ICONS.check : ''}</span>
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

    refreshCustomSelect(selectOrId) {
        const panel = this.element || document;
        const select = typeof selectOrId === 'string'
            ? panel.querySelector(`#${selectOrId}`)
            : selectOrId;
        if (!select) return;
        const button = panel.querySelector(`[data-select-id="${select.id}"]`);
        if (!button) return;
        const labelEl = button.querySelector('.config-custom-select-label');
        const current = Array.from(select.options || []).find((opt) => opt.value === select.value) || select.options?.[select.selectedIndex] || null;
        if (labelEl) {
            labelEl.textContent = current?.textContent?.trim() || button.dataset.placeholder || '请选择';
        }
    }

    refreshAllCustomSelects() {
        ['config-profile', 'config-provider', 'config-vertex-auth-mode', 'config-region', 'config-ollama-mode', 'config-kimi-region', 'config-transport-mode', 'config-prompt-post-processing', 'config-voice-stt-language', 'config-realtime-transcription-language'].forEach((id) => this.refreshCustomSelect(id));
    }

    bindCustomSelect(selectId) {
        const panel = this.element || document;
        const select = panel.querySelector(`#${selectId}`);
        const button = panel.querySelector(`[data-select-id="${selectId}"]`);
        if (!select || !button || button.dataset.bound === 'true') return;

        button.dataset.bound = 'true';
        button.addEventListener('click', () => {
            const options = Array.from(select.options || []).map((opt) => ({
                value: opt.value,
                label: opt.textContent || opt.value,
            }));
            this.openCustomSelectMenu({
                anchorEl: button,
                options,
                currentValue: select.value,
                onSelect: (value) => {
                    const changed = select.value !== value;
                    select.value = value;
                    if (changed || selectId === 'config-provider') {
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    } else {
                        this.refreshCustomSelect(select);
                    }
                },
            });
        });

        select.addEventListener('change', () => this.refreshCustomSelect(select));
        this.refreshCustomSelect(select);
    }

    initCustomSelects() {
        ['config-profile', 'config-provider', 'config-vertex-auth-mode', 'config-region', 'config-ollama-mode', 'config-kimi-region', 'config-transport-mode', 'config-prompt-post-processing', 'config-voice-stt-language', 'config-realtime-transcription-language'].forEach((id) => this.bindCustomSelect(id));
        this.refreshAllCustomSelects();
    }

    setTransportSectionExpanded(expanded) {
        this.transportExpanded = Boolean(expanded);
        const panel = this.element || document;
        const section = panel.querySelector('#config-transport-section');
        const toggle = panel.querySelector('#config-transport-toggle');
        const content = panel.querySelector('#config-transport-content');
        section?.classList.toggle('is-expanded', this.transportExpanded);
        toggle?.setAttribute('aria-expanded', String(this.transportExpanded));
        content?.setAttribute('aria-hidden', String(!this.transportExpanded));
    }

    toggleTransportSection() {
        this.setTransportSectionExpanded(!this.transportExpanded);
    }

    updateTransportVisibility({ autoExpand = false } = {}) {
        const panel = this.element || document;
        const mode = panel.querySelector('#config-transport-mode')?.value || 'direct';
        const proxyFields = panel.querySelector('#config-proxy-fields');
        const summary = panel.querySelector('#config-transport-summary');
        if (proxyFields) {
            proxyFields.style.display = mode === 'reverse_proxy' ? 'block' : 'none';
        }
        if (summary) {
            summary.textContent = mode === 'reverse_proxy'
                ? t('当前：反代出口。保留服务商原协议，只改请求出口和附加鉴权。')
                : t('当前：直连。保持现在的请求方式，不经过反代。');
        }
        if (autoExpand && mode === 'reverse_proxy') {
            this.setTransportSectionExpanded(true);
        }
        if (!autoExpand && mode !== 'reverse_proxy' && !this.transportExpanded) {
            this.setTransportSectionExpanded(false);
        }
        this.refreshCustomSelect('config-transport-mode');
    }

    toggleProxyToken() {
        const panel = this.element || document;
        const input = panel.querySelector('#config-proxy-auth-token');
        const btn = panel.querySelector('#toggle-proxy-token');
        if (!input || !btn) return;
        if (input.type === 'password') {
            input.type = 'text';
            setApiButtonContent(btn, API_CONFIG_ICONS.eyeOff, '隐藏');
        } else {
            input.type = 'password';
            setApiButtonContent(btn, API_CONFIG_ICONS.eye, '显示');
        }
    }

    setExcludedGenerationParams(params = [], { emit = false } = {}) {
        this.excludedGenerationParams = normalizeGenerationParamFilterList(params);
        this.refreshGenerationParamFilterSummary();
        if (emit) this.emitDraftChange();
    }

    setCustomRequestParams(params = [], { emit = false } = {}) {
        this.customRequestParams = normalizeCustomRequestParams(params);
        this.refreshGenerationParamFilterSummary();
        if (emit) this.emitDraftChange();
    }

    refreshGenerationParamFilterSummary() {
        const summary = this.element?.querySelector?.('#generation-param-filter-summary');
        if (!summary) return;
        const excluded = normalizeGenerationParamFilterList(this.excludedGenerationParams);
        const custom = normalizeCustomRequestParams(this.customRequestParams);
        const config = { ...this.configManager.get(), provider: this.element?.querySelector('#config-provider')?.value, model: this.element?.querySelector('#config-model')?.value, baseUrl: this.element?.querySelector('#config-baseurl')?.value };
        summary.textContent = t('附加 {custom} · 排除 {excluded}', {
            custom: custom.filter(row => row.enabled && partitionPresetRequestParam(row, { config }).hasValue && !getRequestParamProtection(row.name, { config })).length, excluded: excluded.length,
        });
        summary.title = '';
    }

    openGenerationParamFilterDialog() {
        this.requestParamsDialog?.close();
        const config = { ...this.configManager.get(), ...this.getFormData() };
        this.requestParamsDialog = openRequestParamsPanel({
            config,
            icons: API_CONFIG_ICONS,
            onApply: ({ customRequestParams, excludedGenerationParams }) => {
                this.setCustomRequestParams(customRequestParams);
                this.setExcludedGenerationParams(excludedGenerationParams, { emit: true });
            },
            onClose: () => { this.requestParamsDialog = null; },
            onOpenPreset: typeof this.onOpenPresetParams === 'function' ? options => this.openPresetFromRequestParams(options) : undefined,
            buildPreview: rules => {
                const previewConfig = { ...config, ...rules };
                const options = window.appBridge?.getGenerationOptions?.(null, previewConfig) || {};
                return new LLMClient(previewConfig).prepareChatRequest(
                    [{ role: 'user', content: 'Hi' }], { ...options, stream: config.stream !== false },
                );
            },
        });
    }

    async openPresetFromRequestParams({ field, rules }) {
        const panelVisibility = this.element.style.visibility;
        const overlayVisibility = this.overlayElement.style.visibility;
        this.requestParamsPresetDraft = rules;
        this.closeCustomSelectMenu();
        this.element.style.visibility = 'hidden';
        this.overlayElement.style.visibility = 'hidden';
        try {
            await new Promise((resolve, reject) => {
                Promise.resolve(this.onOpenPresetParams({ section: 'openai', focusParam: field, onHide: resolve })).catch(reject);
            });
        } finally {
            this.requestParamsPresetDraft = null;
            this.element.style.visibility = panelVisibility;
            this.overlayElement.style.visibility = overlayVisibility;
        }
    }

    /**
     * 获取指定 provider 的默认配置
     */
    getProviderDefaults(provider, options = {}) {
        if (this.activeTab === 'voice') {
            const voiceDefaults = getVoiceProviderDefaults(provider);
            return {
                ...voiceDefaults,
                model: this.voiceCapability === 'stt'
                    ? voiceDefaults.sttModel
                    : voiceDefaults.ttsModel,
            };
        }
        const isImage = this.activeTab === 'image';
        const regionRaw = String(options?.region || 'global').trim();
        const region = regionRaw || 'global';
        const vertexBaseUrl = region === 'global'
            ? 'https://aiplatform.googleapis.com'
            : `https://${region}-aiplatform.googleapis.com`;
        const defaults = {
            openai: {
                baseUrl: 'https://api.openai.com/v1',
                model: isImage ? 'gpt-image-2' : 'gpt-3.5-turbo',
                urlHelp: 'OpenAI API 基础 URL'
            },
            makersuite: {
                baseUrl: 'https://generativelanguage.googleapis.com',
                model: 'gemini-2.0-flash-exp',
                urlHelp: 'Google AI Studio API URL'
            },
            vertexai: {
                baseUrl: vertexBaseUrl,
                model: isImage ? 'gemini-3.1-flash-image' : 'gemini-3.5-flash',
                urlHelp: 'Vertex AI API URL（根据 Region 自动调整）'
            },
            deepseek: {
                baseUrl: 'https://api.deepseek.com/v1',
                model: 'deepseek-chat',
                urlHelp: 'Deepseek API URL'
            },
            ollama: String(options?.ollamaMode || 'cloud') === 'local'
                ? {
                    baseUrl: 'http://127.0.0.1:11434/v1',
                    model: '',
                    urlHelp: '本地 Ollama 地址（默认 http://127.0.0.1:11434/v1）；模型需先 ollama pull，再填 ollama list 中的名称'
                }
                : {
                    baseUrl: 'https://ollama.com/v1',
                    model: '',
                    urlHelp: '云端 ollama.com 地址（必须 https）；需保存 ollama.com 账号的 API Key'
                },
            openrouter: {
                baseUrl: 'https://openrouter.ai/api/v1',
                model: 'openrouter/auto',
                urlHelp: 'OpenRouter API 基础 URL'
            },
            opencode: {
                baseUrl: 'https://opencode.ai/zen/go/v1',
                model: 'glm-5.3',
                urlHelp: 'OpenCode Go API（首版仅支持 Chat Completions 模型）'
            },
            kimi: String(options?.kimiRegion || 'global') === 'china'
                ? {
                    baseUrl: 'https://api.moonshot.cn/v1',
                    model: 'kimi-k2.6',
                    urlHelp: 'Kimi 中国大陆开放平台；全球站 Key 与大陆站 Key 不通用'
                }
                : {
                    baseUrl: 'https://api.moonshot.ai/v1',
                    model: 'kimi-k2.6',
                    urlHelp: 'Kimi 全球开放平台；中国大陆 Key 请切换连接站点'
                },
            zhipu: {
                baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
                model: 'glm-5.2',
                urlHelp: '智谱 BigModel API 官方地址'
            },
            anthropic: {
                baseUrl: 'https://api.anthropic.com/v1',
                model: 'claude-3-5-sonnet-20241022',
                urlHelp: 'Anthropic API 基础 URL'
            },
            novelai: {
                baseUrl: 'https://image.novelai.net',
                model: 'nai-diffusion-4-5-full',
                urlHelp: 'NovelAI Image API URL'
            },
            stability: {
                baseUrl: 'https://api.stability.ai',
                model: 'stable-image-core',
                urlHelp: 'Stability AI API URL'
            },
            togetherai: {
                baseUrl: 'https://api.together.xyz/v1',
                model: 'black-forest-labs/FLUX.1-schnell',
                urlHelp: 'Together AI API URL'
            },
            pollinations: {
                baseUrl: 'https://gen.pollinations.ai',
                model: 'flux',
                urlHelp: 'Pollinations 图片 API URL'
            },
            automatic1111: {
                baseUrl: 'http://127.0.0.1:7860',
                model: 'default',
                urlHelp: 'AUTOMATIC1111 WebUI URL（需要启动 --api）'
            },
            comfyui: {
                baseUrl: 'http://127.0.0.1:8188',
                model: 'workflow',
                urlHelp: 'ComfyUI URL（需要在图片参数中填写 API Format workflow JSON）'
            },
            custom: {
                baseUrl: 'http://localhost:8000/v1',
                model: isImage ? 'image-model' : 'default',
                urlHelp: '自定义 API 的基础 URL'
            }
        };

        return defaults[provider] || defaults.openai;
    }

    usesEditableBaseUrl(provider) {
        return ['custom', 'ollama', 'automatic1111', 'a1111', 'comfyui', 'comfy', 'qwen_local'].includes(String(provider || '').trim().toLowerCase());
    }

    resetFormForProvider(provider) {
        const panel = this.element || document;
        this.setApiFormat('chat_completions');
        const baseEl = panel.querySelector('#config-baseurl');
        const modelEl = panel.querySelector('#config-model');
        const ttsModelEl = panel.querySelector('#config-voice-tts-model');
        const sttModelEl = panel.querySelector('#config-voice-stt-model');
        const ttsVoiceEl = panel.querySelector('#config-voice-tts-voice');
        const apiKeyEl = panel.querySelector('#config-apikey');
        const streamEl = panel.querySelector('#config-stream');
        const webSearchEl = panel.querySelector('#config-web-search');
        const promptPostProcessingEl = panel.querySelector('#config-prompt-post-processing');
        const regionEl = panel.querySelector('#config-region');
        const vertexAuthModeEl = panel.querySelector('#config-vertex-auth-mode');
        const kimiRegionEl = panel.querySelector('#config-kimi-region');
        const saEl = panel.querySelector('#config-serviceaccount');

        if (provider === 'kimi' && kimiRegionEl) kimiRegionEl.value = 'global';
        const defaults = this.getProviderDefaults(provider, {
            region: regionEl?.value || 'global',
            kimiRegion: kimiRegionEl?.value || 'global',
        });

        if (baseEl) {
            baseEl.value = defaults.baseUrl;
            baseEl.placeholder = defaults.baseUrl;
        }
        if (modelEl) {
            modelEl.value = defaults.model;
            modelEl.placeholder = defaults.model;
        }
        if (ttsModelEl && defaults.ttsModel) {
            ttsModelEl.value = defaults.ttsModel;
            ttsModelEl.placeholder = defaults.ttsModel;
        }
        if (sttModelEl && defaults.sttModel) {
            sttModelEl.value = defaults.sttModel;
            sttModelEl.placeholder = defaults.sttModel;
        }
        if (ttsVoiceEl) {
            ttsVoiceEl.value = defaults.ttsVoice || '';
            ttsVoiceEl.placeholder = defaults.ttsVoice || 'Voice ID';
        }
        if (apiKeyEl) {
            apiKeyEl.value = '';
            apiKeyEl.dataset.hasKey = 'false';
            apiKeyEl.dataset.originalKey = '';
        }
        if (streamEl) {
            streamEl.checked = true;
        }
        if (webSearchEl) {
            webSearchEl.checked = false;
        }
        if (promptPostProcessingEl) {
            promptPostProcessingEl.value = 'none';
        }
        if (regionEl) {
            regionEl.value = 'global';
        }
        if (vertexAuthModeEl) {
            vertexAuthModeEl.value = 'service_account';
        }
        if (saEl) {
            saEl.value = '';
            saEl.dataset.hasKey = 'false';
            saEl.style.webkitTextSecurity = 'none';
        }
        this.clearModelOptions();
        this.clearVoiceModelOptions();
        this.setOpenRouterProviderState({ model: modelEl?.value || '' });
        this.refreshAllCustomSelects();
    }

    scheduleModelOptionsRender() {
        if (this.modelFilterDebounceTimer !== null) {
            clearTimeout(this.modelFilterDebounceTimer);
            this.modelFilterDebounceTimer = null;
        }
        if (!this.modelOptions.length) return;
        this.modelFilterDebounceTimer = setTimeout(() => {
            this.modelFilterDebounceTimer = null;
            if (this.modelOptions.length) {
                this.renderModelOptions(this.modelOptions);
            }
        }, MODEL_FILTER_DEBOUNCE_MS);
    }

    clearModelOptions() {
        if (this.modelFilterDebounceTimer !== null) {
            clearTimeout(this.modelFilterDebounceTimer);
            this.modelFilterDebounceTimer = null;
        }
        const container = (this.element || document).querySelector('#model-options');
        if (container) {
            container.innerHTML = '';
            container.style.display = 'none';
        }
        this.modelOptions = [];
    }

    setOpenRouterProviderState({ model = '', selected = [], options = [] } = {}) {
        this.openrouterProviderLoadRevision += 1;
        this.openrouterProviderModel = String(model || '').trim();
        this.openrouterProviderOnly = normalizeOpenRouterProviderSlugs(selected);
        const seen = new Set();
        this.openrouterProviderOptions = [];
        [...options, ...this.openrouterProviderOnly.map(slug => ({ slug, name: slug }))].forEach((item) => {
            const slug = normalizeOpenRouterProviderSlugs([item?.slug])[0] || '';
            if (!slug || seen.has(slug)) return;
            seen.add(slug);
            this.openrouterProviderOptions.push({
                slug,
                name: String(item?.name || slug).trim() || slug,
                unavailable: item?.unavailable === true,
            });
        });
        this.renderOpenRouterProviderOptions();
    }

    handleOpenRouterModelInput() {
        const panel = this.element || document;
        if (panel.querySelector('#config-provider')?.value !== 'openrouter') return;
        const model = String(panel.querySelector('#config-model')?.value || '').trim();
        if (model === this.openrouterProviderModel) return;
        this.setOpenRouterProviderState({ model });
    }

    renderOpenRouterProviderOptions() {
        const panel = this.element || document;
        const container = panel.querySelector('#openrouter-provider-options');
        const help = panel.querySelector('#openrouter-provider-help');
        if (!container) return;
        const selected = new Set(this.openrouterProviderOnly);
        container.innerHTML = '';

        const appendChip = ({ slug = '', name = '', all = false, unavailable = false }) => {
            const active = all ? selected.size === 0 : selected.has(slug);
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'api-config-provider-chip';
            chip.classList.toggle('is-selected', active);
            chip.classList.toggle('is-unavailable', unavailable);
            chip.setAttribute('aria-pressed', String(active));
            chip.textContent = all ? '全部（自动）' : name;
            chip.title = all
                ? '不限制上游，由 OpenRouter 自动路由'
                : `${name} · ${slug}${unavailable ? '（当前目录未列出）' : ''}`;
            chip.onclick = () => {
                this.openrouterProviderOnly = all
                    ? []
                    : normalizeOpenRouterProviderSlugs(active
                        ? this.openrouterProviderOnly.filter(item => item !== slug)
                        : [...this.openrouterProviderOnly, slug]);
                this.renderOpenRouterProviderOptions();
                this.emitDraftChange();
            };
            container.appendChild(chip);
        };

        appendChip({ all: true });
        this.openrouterProviderOptions.forEach(appendChip);
        if (help) {
            help.textContent = selected.size
                ? `已指定 ${selected.size} 个上游；请求只会使用已选服务商。`
                : this.openrouterProviderOptions.length
                    ? '不指定（当前为全部）：由 OpenRouter 在该模型的可用上游中自动路由。'
                    : '不指定表示全部；选择具体模型后点击“刷新上游”载入可选服务商。';
        }
    }

    async refreshOpenRouterProviders({ notify = true } = {}) {
        const panel = this.element || document;
        const provider = panel.querySelector('#config-provider')?.value || '';
        const model = String(panel.querySelector('#config-model')?.value || '').trim();
        if (this.activeTab !== 'chat' || provider !== 'openrouter') return false;
        if (!model || model === 'openrouter/auto' || !model.includes('/')) {
            if (notify) this.showStatus('请先选择一个具体的 OpenRouter 模型', 'error');
            return false;
        }

        const refreshBtn = panel.querySelector('#refresh-openrouter-providers');
        const help = panel.querySelector('#openrouter-provider-help');
        const revision = ++this.openrouterProviderLoadRevision;
        try {
            const formData = this.getFormData({ commitActiveInput: false });
            const runtime = await this.configManager.load();
            const existingKey = String(runtime?.apiKey || '').trim();
            const keyToUse = typeof formData.apiKey === 'string'
                ? formData.apiKey.trim()
                : existingKey;
            if (!keyToUse) {
                if (notify) this.showStatus('请先在 Key 管理中保存 API Key，或在此栏贴上 Key', 'error');
                return false;
            }
            setApiButtonContent(refreshBtn, API_CONFIG_ICONS.loader, '获取中...');
            if (refreshBtn) refreshBtn.disabled = true;
            if (help) help.textContent = '正在读取当前模型的可用上游...';

            const client = new LLMClient({ ...formData, apiKey: keyToUse });
            const providers = await client.listModelProviders(model);
            if (
                revision !== this.openrouterProviderLoadRevision
                || panel.querySelector('#config-provider')?.value !== 'openrouter'
                || String(panel.querySelector('#config-model')?.value || '').trim() !== model
            ) return false;
            if (!providers.length) throw new Error('当前模型没有返回可选上游');

            const available = new Set(providers.map(item => item.slug));
            const missingSelected = this.openrouterProviderOnly
                .filter(slug => !available.has(slug))
                .map(slug => ({ slug, name: slug, unavailable: true }));
            this.openrouterProviderModel = model;
            this.openrouterProviderOptions = [...providers, ...missingSelected];
            this.renderOpenRouterProviderOptions();
            if (notify) this.showStatus(`已加载 ${providers.length} 个可用上游`, 'success');
            return true;
        } catch (error) {
            if (revision === this.openrouterProviderLoadRevision) {
                if (help) help.textContent = `上游列表获取失败：${error.message}`;
                if (notify) this.showStatus(`获取上游列表失败: ${error.message}`, 'error');
            }
            logger.error('获取 OpenRouter 上游列表失败:', error);
            return false;
        } finally {
            if (revision === this.openrouterProviderLoadRevision) {
                setApiButtonContent(refreshBtn, API_CONFIG_ICONS.refresh, '刷新上游');
                if (refreshBtn) refreshBtn.disabled = false;
            }
        }
    }

    clearVoiceModelOptions(capability = null) {
        const panel = this.element || document;
        const capabilities = capability === 'tts' || capability === 'stt'
            ? [capability]
            : ['tts', 'stt'];
        capabilities.forEach((name) => {
            const container = panel.querySelector(`#voice-${name}-model-options`);
            if (container) {
                container.innerHTML = '';
                container.style.display = 'none';
            }
            this.voiceModelOptions[name] = [];
        });
    }

    clearRealtimeVoiceModelOptions(kind = null) {
        const panel = this.element || document;
        const kinds = kind === 'realtime' || kind === 'transcription'
            ? [kind]
            : ['realtime', 'transcription'];
        kinds.forEach((name) => {
            const container = panel.querySelector(`#realtime-${name === 'realtime' ? 'model' : 'transcription-model'}-options`);
            if (container) {
                container.innerHTML = '';
                container.style.display = 'none';
            }
            this.realtimeVoiceModelOptions[name] = [];
        });
    }

    renderRealtimeVoiceModelOptions(kind, models = []) {
        const normalized = kind === 'transcription' ? 'transcription' : 'realtime';
        const panel = this.element || document;
        const input = panel.querySelector(normalized === 'realtime'
            ? '#config-realtime-model'
            : '#config-realtime-transcription-model');
        const container = panel.querySelector(normalized === 'realtime'
            ? '#realtime-model-options'
            : '#realtime-transcription-model-options');
        if (!input || !container) return;
        if (!models.length) {
            this.clearRealtimeVoiceModelOptions(normalized);
            return;
        }

        this.realtimeVoiceModelOptions[normalized] = Array.from(models);
        const query = String(input.value || '').trim();
        const normalizedQuery = query.toLowerCase();
        const rankedModels = rankModelCandidates(this.realtimeVoiceModelOptions[normalized], query);
        container.innerHTML = '';
        container.style.display = 'flex';
        rankedModels.forEach((modelId) => {
            const normalizedModelId = String(modelId).toLowerCase();
            const isMatch = Boolean(normalizedQuery && normalizedModelId.includes(normalizedQuery));
            const isSelected = String(input.value || '').trim() === modelId;
            const chip = document.createElement('button');
            chip.textContent = modelId;
            chip.type = 'button';
            chip.className = 'api-config-model-chip';
            chip.classList.toggle('is-match', isMatch);
            chip.classList.toggle('is-selected', isSelected);
            chip.ariaPressed = String(isSelected);
            chip.title = isMatch ? `匹配“${query}”` : modelId;
            chip.onclick = () => {
                input.value = modelId;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            };
            container.appendChild(chip);
        });
    }

    renderModelOptions(models = []) {
        if (this.modelFilterDebounceTimer !== null) {
            clearTimeout(this.modelFilterDebounceTimer);
            this.modelFilterDebounceTimer = null;
        }
        const panel = this.element || document;
        const container = panel.querySelector('#model-options');
        if (!container) return;

        if (!models.length) {
            this.clearModelOptions();
            return;
        }

        this.modelOptions = Array.from(models);
        const modelInput = panel.querySelector('#config-model');
        const query = String(modelInput?.value || '').trim();
        const normalizedQuery = query.toLowerCase();
        const rankedModels = rankModelCandidates(this.modelOptions, query);
        container.innerHTML = '';
        container.style.display = 'flex';

        rankedModels.forEach(modelId => {
            const normalizedModelId = String(modelId).toLowerCase();
            const isMatch = Boolean(normalizedQuery && normalizedModelId.includes(normalizedQuery));
            const isSelected = String(modelInput?.value || '').trim() === modelId;
            const chip = document.createElement('button');
            chip.textContent = modelId;
            chip.type = 'button';
            chip.className = 'api-config-model-chip';
            chip.classList.toggle('is-match', isMatch);
            chip.classList.toggle('is-selected', isSelected);
            chip.ariaPressed = String(isSelected);
            chip.title = isMatch ? `匹配“${query}”` : modelId;
            chip.onclick = () => {
                if (modelInput) {
                    modelInput.value = modelId;
                    modelInput.dispatchEvent(new Event('input', { bubbles: true }));
                    if (panel.querySelector('#config-provider')?.value === 'openrouter') {
                        void this.refreshOpenRouterProviders();
                    }
                }
            };
            container.appendChild(chip);
        });
    }

    renderVoiceModelOptions(capability, models = []) {
        const normalized = normalizeVoiceCapability(capability);
        const panel = this.element || document;
        const container = panel.querySelector(`#voice-${normalized}-model-options`);
        const modelInput = panel.querySelector(`#config-voice-${normalized}-model`);
        if (!container || !modelInput) return;
        if (!models.length) {
            this.clearVoiceModelOptions(normalized);
            return;
        }

        this.voiceModelOptions[normalized] = Array.from(models);
        const query = String(modelInput.value || '').trim();
        const normalizedQuery = query.toLowerCase();
        const rankedModels = rankModelCandidates(this.voiceModelOptions[normalized], query);
        container.innerHTML = '';
        container.style.display = 'flex';
        rankedModels.forEach((modelId) => {
            const normalizedModelId = String(modelId).toLowerCase();
            const isMatch = Boolean(normalizedQuery && normalizedModelId.includes(normalizedQuery));
            const isSelected = String(modelInput.value || '').trim() === modelId;
            const chip = document.createElement('button');
            chip.textContent = modelId;
            chip.type = 'button';
            chip.className = 'api-config-model-chip';
            chip.classList.toggle('is-match', isMatch);
            chip.classList.toggle('is-selected', isSelected);
            chip.ariaPressed = String(isSelected);
            chip.title = isMatch ? `匹配“${query}”` : modelId;
            chip.onclick = () => {
                modelInput.value = modelId;
                modelInput.dispatchEvent(new Event('input', { bubbles: true }));
            };
            container.appendChild(chip);
        });
    }

    /**
     * 加载特定 provider 的配置
     */
    async loadProviderConfig(provider) {
        try {
            // 每次切换先回到该 provider 的默认值，避免泄漏其他 provider 的配置
            this.resetFormForProvider(provider);

            // 从 localStorage 加载所有配置
            const stored = localStorage.getItem('llm_configs');
            if (!stored) {
                this.updateDefaultsForProvider(provider);
                this.updateFieldVisibility(provider);
                return; // 没有存储的配置，使用默认值
            }

            const allConfigs = JSON.parse(stored);
            const providerConfig = allConfigs[provider];

            if (!providerConfig) {
                this.updateDefaultsForProvider(provider);
                this.updateFieldVisibility(provider);
                return; // 该 provider 没有配置，使用默认值
            }

            // 解密配置
            const config = { ...providerConfig, provider };

            // 解密 API Key
            if (config._encrypted && config.apiKey) {
                try {
                    config.apiKey = atob(config.apiKey);
                } catch (e) {
                    logger.error('解密 API Key 失败:', e);
                }
                delete config._encrypted;
            }

            // 解密 Service Account JSON
            if (config._saEncrypted && config.vertexaiServiceAccount) {
                try {
                    config.vertexaiServiceAccount = atob(config.vertexaiServiceAccount);
                } catch (e) {
                    logger.error('解密 Service Account 失败:', e);
                }
                delete config._saEncrypted;
            }

            // 填充表单
            const panel = this.element || document;
            const baseEl = panel.querySelector('#config-baseurl');
            const modelEl = panel.querySelector('#config-model');
            const streamEl = panel.querySelector('#config-stream');
            const webSearchEl = panel.querySelector('#config-web-search');
            const promptPostProcessingEl = panel.querySelector('#config-prompt-post-processing');
            const apiKeyInput = panel.querySelector('#config-apikey');

            if (baseEl) baseEl.value = config.baseUrl || '';
            this.setApiFormat(config.apiFormat);
            if (modelEl) modelEl.value = config.model || '';
            if (streamEl) streamEl.checked = config.stream !== false;
            if (webSearchEl) webSearchEl.checked = config.webSearchEnabled === true;
            if (promptPostProcessingEl) promptPostProcessingEl.value = normalizePromptPostProcessingForForm(config.promptPostProcessing);

            // API Key 显示为 masked
            if (apiKeyInput) {
                if (config.apiKey) {
                    apiKeyInput.value = '••••••••••••••••';
                    apiKeyInput.dataset.hasKey = 'true';
                    apiKeyInput.dataset.originalKey = config.apiKey;
                } else {
                    apiKeyInput.value = '';
                    apiKeyInput.dataset.hasKey = 'false';
                }
            }

            // ollama：连接模式不落盘，由 baseUrl 推导（含 ollama.com 即云端）
            if (provider === 'ollama') {
                const modeInput = panel.querySelector('#config-ollama-mode');
                if (modeInput) {
                    modeInput.value = /ollama\.com/i.test(String(config.baseUrl || '')) ? 'cloud' : 'local';
                }
            }

            // 填充 Vertex AI 特定字段
            if (provider === 'vertexai') {
                const authModeInput = panel.querySelector('#config-vertex-auth-mode');
                const regionInput = panel.querySelector('#config-region');
                const saInput = panel.querySelector('#config-serviceaccount');

                if (authModeInput) {
                    authModeInput.value = normalizeVertexAuthMode(config.vertexaiAuthMode, config);
                }
                if (regionInput) {
                    regionInput.value = config.vertexaiRegion || 'global';
                }

                if (saInput) {
                    if (config.vertexaiServiceAccount) {
                        saInput.value = VERTEX_SERVICE_ACCOUNT_MASK;
                        saInput.dataset.hasKey = 'true';
                        saInput.style.webkitTextSecurity = 'disc';
                    } else {
                        saInput.value = '';
                        saInput.dataset.hasKey = 'false';
                        saInput.style.webkitTextSecurity = 'none';
                    }
                }
            }

            logger.info(`已加载 ${provider} 的配置`);
            this.updateFieldVisibility(provider);
            this.refreshAllCustomSelects();

        } catch (e) {
            logger.error('加载 provider 配置失败:', e);
        }
    }

    /**
     * 填充表单
     */
    populateForm(config) {
        if (!this.element) {
            this.createUI();
        }
        const panel = this.element || document;
        const providerEl = panel.querySelector('#config-provider');
        const baseEl = panel.querySelector('#config-baseurl');
        const modelEl = panel.querySelector('#config-model');
        const ttsModelEl = panel.querySelector('#config-voice-tts-model');
        const sttModelEl = panel.querySelector('#config-voice-stt-model');
        const sttLanguageEl = panel.querySelector('#config-voice-stt-language');
        const ttsVoiceEl = panel.querySelector('#config-voice-tts-voice');
        const streamEl = panel.querySelector('#config-stream');
        const webSearchEl = panel.querySelector('#config-web-search');
        const promptPostProcessingEl = panel.querySelector('#config-prompt-post-processing');
        const transportModeEl = panel.querySelector('#config-transport-mode');
        const proxyBaseEl = panel.querySelector('#config-proxy-baseurl');
        const proxyHeaderEl = panel.querySelector('#config-proxy-auth-header');
        const proxyTokenEl = panel.querySelector('#config-proxy-auth-token');
        const forwardProviderAuthEl = panel.querySelector('#config-forward-provider-auth');
        const apiKeyInput = panel.querySelector('#config-apikey');
        if (!providerEl || !baseEl || !modelEl || !streamEl || !apiKeyInput) {
            logger.error('配置面板元素缺失，填充表单中止');
            return;
        }

        const allowedProviders = new Set(this.getProviderOptions().map(item => item.value));
        const selectedProvider = allowedProviders.has(config.provider) ? config.provider : 'openai';
        providerEl.value = selectedProvider;
        const currentProvider = providerEl.value || 'openai';
        const currentRegion = config.vertexaiRegion || 'global';
        const storedBaseUrl = String(config.baseUrl || '').trim();
        const kimiRegionEl = panel.querySelector('#config-kimi-region');
        if (kimiRegionEl && currentProvider === 'kimi') {
            kimiRegionEl.value = /api\.moonshot\.cn(?:\/|$)/iu.test(storedBaseUrl) ? 'china' : 'global';
        }
        const currentKimiRegion = kimiRegionEl?.value || 'global';
        const defaultBaseUrl = this.getProviderDefaults(currentProvider, {
            region: currentRegion,
            kimiRegion: currentKimiRegion,
        }).baseUrl;
        const legacyProxyBaseUrl =
            !this.usesEditableBaseUrl(currentProvider) &&
            storedBaseUrl &&
            storedBaseUrl !== defaultBaseUrl &&
            config.connectionMode !== 'reverse_proxy'
                ? storedBaseUrl
                : '';
        baseEl.value = this.usesEditableBaseUrl(currentProvider)
            ? (config.baseUrl || '')
            : defaultBaseUrl;
        modelEl.value = config.model || '';
        this.setOpenRouterProviderState({
            model: modelEl.value,
            selected: currentProvider === 'openrouter' ? config.openrouterProviderOnly : [],
        });
        const providerDefaults = this.getProviderDefaults(currentProvider, {
            region: currentRegion,
            kimiRegion: currentKimiRegion,
        });
        if (ttsModelEl) {
            ttsModelEl.value = config.ttsModel || providerDefaults.ttsModel || '';
            ttsModelEl.placeholder = providerDefaults.ttsModel || 'tts-model';
        }
        if (sttModelEl) {
            sttModelEl.value = config.sttModel || providerDefaults.sttModel || '';
            sttModelEl.placeholder = providerDefaults.sttModel || 'stt-model';
        }
        if (sttLanguageEl) sttLanguageEl.value = config.sttLanguage || '';
        if (ttsVoiceEl) {
            ttsVoiceEl.value = config.ttsVoice || providerDefaults.ttsVoice || '';
            ttsVoiceEl.placeholder = providerDefaults.ttsVoice || 'Voice ID';
        }
        streamEl.checked = config.stream !== false;
        this.setApiFormat(config.apiFormat);
        if (webSearchEl) webSearchEl.checked = config.webSearchEnabled === true;
        this.setExcludedGenerationParams(config.excludedGenerationParams || [], { emit: false });
        this.setCustomRequestParams(config.customRequestParams || [], { emit: false });
        if (promptPostProcessingEl) promptPostProcessingEl.value = normalizePromptPostProcessingForForm(config.promptPostProcessing);
        if (transportModeEl) {
            transportModeEl.value = (config.connectionMode === 'reverse_proxy' || legacyProxyBaseUrl)
                ? 'reverse_proxy'
                : 'direct';
        }
        if (proxyBaseEl) proxyBaseEl.value = config.proxyBaseUrl || legacyProxyBaseUrl || '';
        if (proxyHeaderEl) proxyHeaderEl.value = config.proxyAuthHeaderName || '';
        if (proxyTokenEl) {
            proxyTokenEl.type = 'password';
            proxyTokenEl.value = config.proxyAuthToken || '';
        }
        const proxyToggleBtn = panel.querySelector('#toggle-proxy-token');
        setApiButtonContent(proxyToggleBtn, API_CONFIG_ICONS.eye, '显示');
        if (forwardProviderAuthEl) forwardProviderAuthEl.checked = config.forwardProviderAuth !== false;
        const timeoutEl = panel.querySelector('#config-timeout');
        if (timeoutEl) {
            const ms = Number(config.timeout);
            const sec = Number.isFinite(ms) ? Math.round(ms / 1000) : 60;
            timeoutEl.value = String(Math.min(9000, Math.max(10, sec)));
        }

        // Profile selector
        this.refreshProfileOptions();

        // API Key：仅显示遮罩（不把明文塞进 DOM / dataset）
        const masked = this.getMaskedActiveKey();
        apiKeyInput.type = 'password';
        setApiButtonContent(panel.querySelector('#toggle-apikey'), API_CONFIG_ICONS.eye, '显示');
        if (masked) {
            apiKeyInput.value = masked;
            apiKeyInput.dataset.hasKey = 'true';
            apiKeyInput.dataset.masked = masked;
        } else {
            apiKeyInput.value = '';
            apiKeyInput.dataset.hasKey = 'false';
            apiKeyInput.dataset.masked = '';
        }

        apiKeyInput.onfocus = function() {
            if (this.dataset.hasKey === 'true' && this.dataset.masked && this.value === this.dataset.masked) {
                this.value = '';
            }
        };
        apiKeyInput.onblur = function() {
            if (!this.value && this.dataset.masked) {
                this.value = this.dataset.masked;
                this.dataset.hasKey = 'true';
            }
        };

        // ollama：连接模式由 baseUrl 推导（含 ollama.com 即云端）
        if (config.provider === 'ollama') {
            const modeInput = panel.querySelector('#config-ollama-mode');
            if (modeInput) {
                modeInput.value = /ollama\.com/i.test(String(config.baseUrl || '')) ? 'cloud' : 'local';
            }
        }

        // 填充 Vertex AI 特定字段
        if (config.provider === 'vertexai') {
            const authModeInput = panel.querySelector('#config-vertex-auth-mode');
            const regionInput = panel.querySelector('#config-region');
            const saInput = panel.querySelector('#config-serviceaccount');

            if (authModeInput) {
                authModeInput.value = normalizeVertexAuthMode(config.vertexaiAuthMode, config);
            }
            if (regionInput) {
                regionInput.value = config.vertexaiRegion || 'global';
            }

            // Mask Service Account JSON
            if (saInput) {
                setApiButtonContent(panel.querySelector('#toggle-sa'), API_CONFIG_ICONS.eye, '显示');
                if (config.vertexaiServiceAccount) {
                    saInput.value = VERTEX_SERVICE_ACCOUNT_MASK;
                    saInput.dataset.hasKey = 'true';
                    saInput.style.webkitTextSecurity = 'disc';
                } else {
                    saInput.value = '';
                    saInput.dataset.hasKey = 'false';
                    saInput.style.webkitTextSecurity = 'none';
                }

                // Clear on focus
                saInput.onfocus = function() {
                    if (this.dataset.hasKey === 'true' && this.value === VERTEX_SERVICE_ACCOUNT_MASK) {
                        this.value = '';
                        this.style.webkitTextSecurity = 'none';
                    }
                };
                saInput.onblur = function() {
                    if (!this.value && this.dataset.hasKey === 'true') {
                        this.value = VERTEX_SERVICE_ACCOUNT_MASK;
                        this.style.webkitTextSecurity = 'disc';
                    }
                };
            }
        }

        // 更新字段可见性
        this.updateFieldVisibility(currentProvider);
        this.updateTransportVisibility();
        this.setTransportSectionExpanded(config.connectionMode === 'reverse_proxy' || Boolean(legacyProxyBaseUrl));
        this.refreshAllCustomSelects();
    }

    refreshProfileOptions() {
        const panel = this.element || document;
        const select = panel.querySelector('#config-profile');
        if (!select) return;

        // 自定义菜单是打开瞬间的选项快照；设置档变化时先关闭，避免继续显示旧的空列表。
        const profileButton = panel.querySelector('#config-profile-btn');
        if (profileButton && this.customSelectMenuAnchor === profileButton) {
            this.closeCustomSelectMenu();
        }

        // 设置标志防止触发 onchange
        this.isRefreshingProfile = true;

        try {
            const profiles = this.configManager.getProfiles?.() || [];
            const activeId = this.configManager.getActiveProfileId?.();
            select.innerHTML = '';
            profiles.forEach((p) => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                select.appendChild(opt);
            });
            if (activeId) {
                select.value = activeId;
                logger.debug(`刷新配置选择器，当前: ${activeId.slice(0, 20)}...`);
            }
            this.refreshCustomSelect(select);
        } finally {
            // DOM 直接改 value/option 不会触发 change；同步解除，避免吞掉用户紧接着的选择。
            this.isRefreshingProfile = false;
        }
    }

    resolveCurrentChatReasoning(config = {}) {
        const store = getPresetStore(window.appBridge);
        const sessionId = String(window.appBridge?.lastRequest?.session?.id || '').trim();
        const resolved = store?.getResolvedActive?.('openai', { sessionId, uiMode: 'chat' }) || null;
        const preset = resolved?.preset || {};
        const override = store?.getSessionReasoning?.('openai', sessionId)
            || store?.getModeReasoning?.('openai', 'chat')
            || null;
        const requestReasoning = override
            ? override.request_reasoning === true
            : preset.request_reasoning === true;
        const reasoningEffort = override?.reasoning_effort || preset.reasoning_effort;
        return {
            thinkingEnabled: requestReasoning,
            reasoningOptions: buildReasoningRequestOptions({
                provider: config?.provider,
                model: config?.model,
                baseUrl: config?.baseUrl,
                requestReasoning,
                reasoningEffort,
                maxOutputTokens: Number(preset.openai_max_tokens) || undefined,
            }),
        };
    }

    updateFcCompatibilitySummary() {
        const summary = this.element?.querySelector('#fc-compatibility-summary');
        if (!summary) return;
        const count = this.chatFcCompatibilityPanel?.getRuleCount?.() || 0;
        const config = this.getDraftConfig?.({ tab: 'chat' })
            || window.appBridge?.getConfig?.()
            || this.configManager.getActiveProfile?.()
            || {};
        const reasoning = this.resolveCurrentChatReasoning(config);
        const status = resolveChatStructuredProfileStatus({
            config,
            ...reasoning,
            thinkingPreference: appSettings.get().chatStructuredThinkingPreference,
            compatibilityModeEnabled: appSettings.get().traditionalModelOutputProtocolEnabled === true,
            evidenceStore: chatStructuredRouteEvidenceStore,
        });
        summary.textContent = `${translateUiText(status.label)}${status.detail ? ` · ${translateUiText(status.detail)}` : ''}`;
        summary.title = `仅表示当前配置档、基础私聊与当前思考设置；内建兼容库及 ${count} 条本地规则的其他能力请点入查看。`;
    }

    getMaskedActiveKey() {
        const active = this.configManager.getActiveProfile?.();
        if (!active?.activeKeyId) return '';
        const keys = this.configManager.listKeys?.(active.id) || [];
        const key = keys.find(k => k.id === active.activeKeyId);
        return key?.preview || '';
    }

    /**
     * 更新不同 provider 的默认值
     */
    updateDefaultsForProvider(provider) {
        const panel = this.element || document;
        const defaults = this.getProviderDefaults(provider, {
            region: panel.querySelector('#config-region')?.value || 'global',
            ollamaMode: panel.querySelector('#config-ollama-mode')?.value || 'cloud',
            kimiRegion: panel.querySelector('#config-kimi-region')?.value || 'global',
        });
        const baseUrlInput = panel.querySelector('#config-baseurl');
        const baseUrlSection = panel.querySelector('#config-baseurl-section');
        const modelInput = panel.querySelector('#config-model');
        const ttsModelInput = panel.querySelector('#config-voice-tts-model');
        const sttModelInput = panel.querySelector('#config-voice-stt-model');
        const ttsVoiceInput = panel.querySelector('#config-voice-tts-voice');
        const editableBaseUrl = this.usesEditableBaseUrl(provider);
        const providerKeys = this.getProviderOptions().map(item => item.value);

        if (baseUrlInput) {
            // 内建服务商固定使用默认协议地址；custom 保持可编辑。
            const currentUrl = baseUrlInput.value.trim();
            const selectedRegion = panel.querySelector('#config-region')?.value || 'global';
            const allDefaults = providerKeys
                .map((name) => this.getProviderDefaults(name, { region: selectedRegion }).baseUrl)
                // ollama 云端/本地是同一 provider 的两个默认地址，切换时都视为“默认值”可替换
                .concat(this.activeTab === 'chat'
                    ? [this.getProviderDefaults('ollama', { ollamaMode: 'local' }).baseUrl]
                    : []);
            const isDefaultUrl = allDefaults.includes(currentUrl);
            if (!editableBaseUrl || !currentUrl || isDefaultUrl) {
                baseUrlInput.value = defaults.baseUrl;
            }
            baseUrlInput.placeholder = defaults.baseUrl;

            const helpText = baseUrlInput.nextElementSibling;
            if (helpText && helpText.tagName === 'SMALL') {
                helpText.textContent = defaults.urlHelp;
            }
        }
        if (baseUrlSection) {
            baseUrlSection.style.display = editableBaseUrl ? 'block' : 'none';
        }

        if (modelInput) {
            // 自动填写模型（如果当前为空或为其他服务商的默认值）
            const currentModel = modelInput.value.trim();
            const allDefaults = providerKeys.map(p => this.getProviderDefaults(p).model);
            const isDefaultModel = allDefaults.includes(currentModel);
            if (!currentModel || isDefaultModel || shouldResetDirectProviderModel(provider, currentModel)) {
                modelInput.value = defaults.model;
            }
            modelInput.placeholder = defaults.model;
        }
        if (this.activeTab === 'voice' && this.voiceConnectionMode === 'shared') {
            const allVoiceDefaults = providerKeys.map(name => this.getProviderDefaults(name));
            const updateVoiceModel = (input, key) => {
                if (!input) return;
                const current = input.value.trim();
                const isProviderDefault = allVoiceDefaults.some(item => item[key] === current);
                if (!current || isProviderDefault) input.value = defaults[key] || '';
                input.placeholder = defaults[key] || '';
            };
            updateVoiceModel(ttsModelInput, 'ttsModel');
            updateVoiceModel(sttModelInput, 'sttModel');
        }
        if (this.activeTab === 'voice' && (
            this.voiceConnectionMode === 'shared' || this.voiceCapability === 'tts'
        )) {
            const allVoiceDefaults = providerKeys.map(name => this.getProviderDefaults(name));
            const currentVoice = String(ttsVoiceInput?.value || '').trim();
            const isProviderDefault = allVoiceDefaults.some(item => item.ttsVoice === currentVoice);
            if (ttsVoiceInput && (!currentVoice || isProviderDefault)) {
                ttsVoiceInput.value = defaults.ttsVoice || '';
            }
            if (ttsVoiceInput) ttsVoiceInput.placeholder = defaults.ttsVoice || 'Voice ID';
        }
        this.updateVoiceTtsSettings(provider);
    }

    updateVoiceTtsSettings(provider) {
        const panel = this.element || document;
        const normalized = String(provider || '').trim().toLowerCase();
        const help = panel.querySelector('#config-voice-tts-voice-help');
        const presets = panel.querySelector('#config-voice-tts-voice-presets');
        const input = panel.querySelector('#config-voice-tts-voice');
        const options = normalized === 'openai'
            ? ['marin', 'cedar', 'coral', 'nova', 'alloy', 'shimmer']
            : normalized === 'qwen_local'
                ? ['Serena', 'Vivian', 'Uncle_Fu', 'Dylan', 'Eric']
            : normalized === 'custom'
                ? ['alloy', 'marin', 'cedar']
                : [];
        if (presets) {
            presets.innerHTML = options.map(value => `
                <button type="button" class="api-config-voice-preset" data-voice-preset="${escapeHtml(value)}" aria-pressed="false">${escapeHtml(value)}</button>
            `).join('');
        }
        if (help) {
            help.dataset.help = t('朗读使用 AI 合成语音。') + ' ' + (normalized === 'elevenlabs'
                ? t('填写 ElevenLabs「My Voices」中的 Voice ID；默认值可直接替换')
                : normalized === 'qwen_local'
                    ? t('Qwen CustomVoice 内建音色；Serena 为默认中文女声，也可选择 Vivian 或直接输入其他 speaker')
                : normalized === 'custom'
                    ? t('填写兼容服务支持的 voice 值')
                    : t('OpenAI 声音名称；推荐 marin 或 cedar，可直接输入其他支持值'));
        }
        if (input) input.placeholder = this.getProviderDefaults(normalized).ttsVoice || 'Voice ID';
        this.syncVoicePresetSelection();
    }

    updateVoiceRegistrySummary() {
        const summary = this.element?.querySelector?.('#config-voice-library-summary');
        if (!summary) return;
        const count = this.voiceRegistryStore?.list?.().length || 0;
        summary.textContent = t('{count} 个声音', { count });
    }

    syncVoicePresetSelection() {
        const panel = this.element || document;
        const current = String(panel.querySelector('#config-voice-tts-voice')?.value || '').trim();
        panel.querySelectorAll('[data-voice-preset]').forEach((button) => {
            const active = String(button.dataset.voicePreset || '') === current;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    /**
     * 更新字段可见性（根据服务商）
     */
    setApiFormat(value) {
        const panel = this.element || document;
        const format = normalizeOpenAIApiFormat(value);
        panel.querySelectorAll?.('input[name="config-api-format"]').forEach(input => {
            input.checked = input.value === format;
        });
    }

    updateFieldVisibility(provider) {
        const panel = this.element || document;
        const formatSection = panel.querySelector('#config-api-format-section');
        if (formatSection) {
            formatSection.style.display = this.activeTab === 'chat' && supportsOpenAIApiFormatSelection(provider)
                ? 'block' : 'none';
        }
        const baseUrlSection = panel.querySelector('#config-baseurl-section');
        const vertexaiFields = panel.querySelector('#vertexai-fields');
        const vertexRegionField = panel.querySelector('#vertexai-region-field');
        const vertexServiceAccountField = panel.querySelector('#vertexai-service-account-field');
        const ollamaFields = panel.querySelector('#ollama-fields');
        const kimiFields = panel.querySelector('#kimi-fields');
        const openrouterRouting = panel.querySelector('#openrouter-provider-routing');
        const apiKeyHelp = panel.querySelector('#apikey-help');
        if (baseUrlSection) {
            baseUrlSection.style.display = this.usesEditableBaseUrl(provider) ? 'block' : 'none';
        }
        if (ollamaFields) {
            ollamaFields.style.display = provider === 'ollama' ? 'block' : 'none';
        }
        if (kimiFields) {
            kimiFields.style.display = provider === 'kimi' ? 'block' : 'none';
        }
        if (openrouterRouting) {
            openrouterRouting.style.display = this.activeTab === 'chat' && provider === 'openrouter'
                ? 'block'
                : 'none';
        }
        if (provider === 'ollama') {
            if (vertexaiFields) vertexaiFields.style.display = 'none';
            if (apiKeyHelp) {
                const mode = panel.querySelector('#config-ollama-mode')?.value || 'cloud';
                apiKeyHelp.dataset.help = mode === 'local'
                    ? t('本地 Ollama 可不填写 API Key；若服务端启用鉴权再保存 Key。')
                    : t('云端 ollama.com 需保存账号 API Key。');
            }
            this.refreshAllCustomSelects();
            return;
        }

        if (provider === 'vertexai') {
            if (vertexaiFields) vertexaiFields.style.display = 'block';
            const authMode = normalizeVertexAuthMode(
                panel.querySelector('#config-vertex-auth-mode')?.value,
            );
            const usesExpress = authMode === VERTEX_AUTH_MODE_EXPRESS;
            if (vertexRegionField) vertexRegionField.style.display = usesExpress ? 'none' : 'block';
            if (vertexServiceAccountField) vertexServiceAccountField.style.display = usesExpress ? 'none' : 'block';
            if (apiKeyHelp) {
                apiKeyHelp.dataset.help = usesExpress
                    ? t('Express 模式使用 Vertex AI 专用 API Key，不需要 Project ID 或 Region。')
                    : t('完整模式使用 Service Account 与 Google Cloud 项目额度；此处 API Key 不参与鉴权。');
            }
        } else if (provider === 'kimi') {
            vertexaiFields.style.display = 'none';
            if (apiKeyHelp) {
                apiKeyHelp.dataset.help = t('请使用所选开放平台站点创建的 API Key；全球站、中国大陆站与 Kimi Code Key 不通用。');
            }
        } else if (!this.providerRequiresApiKey(provider)) {
            vertexaiFields.style.display = 'none';
            if (apiKeyHelp) {
                apiKeyHelp.dataset.help = t('此渠道可不填写 API Key；若服务端启用鉴权再保存 Key。');
            }
        } else {
            vertexaiFields.style.display = 'none';
            if (apiKeyHelp) {
                apiKeyHelp.dataset.help = t('可在 Key 管理中保存多个凭证');
            }
        }
        if (this.activeTab === 'voice') this.updateVoiceTtsSettings(provider);
        this.refreshAllCustomSelects();
    }

    /**
     * 获取表单数据
     */
    getFormData({ commitActiveInput = true } = {}) {
        const panel = this.element || document;

        // 在部分移动端输入法下，点击按钮时输入可能还在 composition 状态；先 blur 提交文本
        if (commitActiveInput) {
            try {
                const activeEl = panel?.ownerDocument?.activeElement || document.activeElement;
                if (activeEl && panel?.contains?.(activeEl) && typeof activeEl.blur === 'function') {
                    activeEl.blur();
                }
            } catch {}
        }

        const provider = panel.querySelector('#config-provider')?.value;
        const region = panel.querySelector('#config-region')?.value || 'global';
        const kimiRegion = panel.querySelector('#config-kimi-region')?.value || 'global';
        const apiKeyInput = panel.querySelector('#config-apikey');
        const rawKey = (apiKeyInput?.value || '').trim();
        const masked = apiKeyInput?.dataset?.masked || '';
        // apiKey 为 null => 不修改 key（继续使用已保存的 active key）
        const apiKey = (!rawKey || (masked && rawKey === masked)) ? null : rawKey;

        const formData = {
            provider: provider,
            apiFormat: this.activeTab === 'chat' && supportsOpenAIApiFormatSelection(provider)
                ? normalizeOpenAIApiFormat(panel.querySelector('input[name="config-api-format"]:checked')?.value)
                : 'chat_completions',
            baseUrl: this.usesEditableBaseUrl(provider)
                ? (panel.querySelector('#config-baseurl')?.value || '').trim()
                : this.getProviderDefaults(provider, { region, kimiRegion }).baseUrl,
            connectionMode: panel.querySelector('#config-transport-mode')?.value === 'reverse_proxy' ? 'reverse_proxy' : 'direct',
            proxyBaseUrl: (panel.querySelector('#config-proxy-baseurl')?.value || '').trim(),
            proxyAuthHeaderName: (panel.querySelector('#config-proxy-auth-header')?.value || '').trim(),
            proxyAuthToken: panel.querySelector('#config-proxy-auth-token')?.value || '',
            forwardProviderAuth: Boolean(panel.querySelector('#config-forward-provider-auth')?.checked),
            promptPostProcessing: normalizePromptPostProcessingForForm(panel.querySelector('#config-prompt-post-processing')?.value),
            apiKey: apiKey,
            model: (panel.querySelector('#config-model')?.value || '').trim(),
            webSearchEnabled: Boolean(panel.querySelector('#config-web-search')?.checked),
            stream: Boolean(panel.querySelector('#config-stream')?.checked),
            excludedGenerationParams: normalizeGenerationParamFilterList(this.excludedGenerationParams),
            customRequestParams: this.activeTab === 'chat' ? normalizeCustomRequestParams(this.customRequestParams) : [],
            timeout: (() => {
                const secRaw = (panel.querySelector('#config-timeout')?.value || '').trim();
                const sec = Number(secRaw);
                const clamped = Number.isFinite(sec) ? Math.min(9000, Math.max(10, Math.trunc(sec))) : 60;
                return clamped * 1000;
            })(),
            maxRetries: 3
        };

        if (this.activeTab === 'voice') {
            formData.webSearchEnabled = false;
            formData.promptPostProcessing = 'none';
            formData.excludedGenerationParams = [];
            formData.customRequestParams = [];
            if (this.voiceConnectionMode === 'shared') {
                formData.ttsModel = (panel.querySelector('#config-voice-tts-model')?.value || '').trim();
                formData.sttModel = (panel.querySelector('#config-voice-stt-model')?.value || '').trim();
                formData.sttLanguage = (panel.querySelector('#config-voice-stt-language')?.value || '').trim();
                formData.ttsVoice = (panel.querySelector('#config-voice-tts-voice')?.value || '').trim();
                // ConfigManager 的通用运行时仍保留 model；语音运行时会分别读取 ttsModel / sttModel。
                formData.model = formData.ttsModel;
            } else if (this.voiceCapability === 'tts') {
                formData.ttsVoice = (panel.querySelector('#config-voice-tts-voice')?.value || '').trim();
            } else {
                formData.sttLanguage = (panel.querySelector('#config-voice-stt-language')?.value || '').trim();
            }
        }

        // Add Vertex AI specific fields
        if (provider === 'vertexai') {
            const saInput = panel.querySelector('#config-serviceaccount');
            const serviceAccount = String(saInput?.value || '').trim();

            formData.vertexaiAuthMode = normalizeVertexAuthMode(
                panel.querySelector('#config-vertex-auth-mode')?.value,
            );
            if (region) formData.vertexaiRegion = region;
            if (serviceAccount && serviceAccount !== VERTEX_SERVICE_ACCOUNT_MASK) {
                formData.vertexaiServiceAccount = serviceAccount;
            }
        }

        if (provider === 'openrouter') {
            formData.openrouterProviderOnly = [...this.openrouterProviderOnly];
        }

        return formData;
    }

    async resolveVertexRequestConfig(formData) {
        const runtime = await this.configManager.load();
        const merged = {
            ...(runtime || {}),
            ...(formData || {}),
        };
        merged.vertexaiAuthMode = normalizeVertexAuthMode(
            formData?.vertexaiAuthMode || runtime?.vertexaiAuthMode,
            merged,
        );
        merged.apiKey = typeof formData?.apiKey === 'string' && formData.apiKey.trim()
            ? formData.apiKey.trim()
            : String(runtime?.apiKey || '').trim();
        merged.vertexaiServiceAccount = typeof formData?.vertexaiServiceAccount === 'string'
            && formData.vertexaiServiceAccount.trim()
            ? formData.vertexaiServiceAccount.trim()
            : String(runtime?.vertexaiServiceAccount || '').trim();
        return merged;
    }

    isOpen() {
        return Boolean(this.element && this.element.style.display !== 'none');
    }

    getActiveTab() {
        return this.activeTab;
    }

    getDraftConfig({ tab = '' } = {}) {
        const targetTab = ['chat', 'image', 'voice'].includes(tab) ? tab : this.activeTab;
        if (!this.isOpen() || targetTab !== this.activeTab) return null;
        return { ...this.getFormData({ commitActiveInput: false }), ...(this.requestParamsPresetDraft || {}) };
    }

    toggleApiKey() {
        const panel = this.element || document;
        const input = panel.querySelector('#config-apikey');
        const btn = panel.querySelector('#toggle-apikey');
        if (input.type === 'password') {
            input.type = 'text';
            setApiButtonContent(btn, API_CONFIG_ICONS.eyeOff, '隐藏');
        } else {
            input.type = 'password';
            setApiButtonContent(btn, API_CONFIG_ICONS.eye, '显示');
        }
    }

    toggleServiceAccount() {
        const panel = this.element || document;
        const input = panel.querySelector('#config-serviceaccount');
        const btn = panel.querySelector('#toggle-sa');
        if (!input || !btn) return;
        if (input.dataset.hasKey === 'true' && input.value === VERTEX_SERVICE_ACCOUNT_MASK) {
            this.showStatus(t('粘贴新的 Service Account JSON 即可替换已保存凭证'), 'info');
            return;
        }

        if (input.style.webkitTextSecurity === 'disc' || input.style.webkitTextSecurity === '') {
            input.style.webkitTextSecurity = 'none';
            setApiButtonContent(btn, API_CONFIG_ICONS.eyeOff, '隐藏');
        } else {
            input.style.webkitTextSecurity = 'disc';
            setApiButtonContent(btn, API_CONFIG_ICONS.eye, '显示');
        }
    }

    async createProfile() {
        const name = prompt('新设置档名称', '新配置');
        if (!name) return;
        await this.configManager.createProfile(name);
        const config = await this.configManager.load();
        this.refreshProfileOptions();
        this.populateForm(config);
        await this.syncActiveProfileRuntime(config);
        this.emitProfileChanged();
        window.toastr?.success(`已创建：${name}`);
    }

    async renameProfile() {
        const active = this.configManager.getActiveProfile?.();
        if (!active) return;
        const name = prompt('重命名设置档', active.name || '');
        if (!name) return;
        await this.configManager.renameProfile(active.id, name);
        this.refreshProfileOptions();
        this.emitProfileChanged(active.id);
        window.toastr?.success('已重命名');
    }

    async deleteProfile() {
        const profiles = this.configManager.getProfiles?.() || [];
        if (profiles.length <= 1) {
            window.toastr?.warning('至少保留一个设置档');
            return;
        }
        const active = this.configManager.getActiveProfile?.();
        if (!active) return;
        const ok = await appConfirm({
            title: '删除设置档',
            message: `删除设置档「${active.name}」？此操作不可恢复。`,
            danger: true,
        });
        if (!ok) return;
        await this.configManager.deleteProfile(active.id);
        const config = await this.configManager.load();
        this.refreshProfileOptions();
        this.populateForm(config);
        await this.syncActiveProfileRuntime(config);
        this.emitProfileChanged();
    }

    openKeyManager() {
        if (!this.keyOverlay) {
            this.createKeyManagerUI();
        }
        this.refreshKeyManagerList();
        this.keyOverlay.style.display = 'block';
        this.keyModal.style.display = 'block';
    }

    closeKeyManager() {
        if (this.keyOverlay) this.keyOverlay.style.display = 'none';
        if (this.keyModal) this.keyModal.style.display = 'none';
    }

    createKeyManagerUI() {
        this.keyOverlay = document.createElement('div');
        this.keyOverlay.id = 'config-key-overlay';
        this.keyOverlay.className = 'app-themed-overlay';
        this.keyOverlay.style.cssText = 'display:none; position:fixed; inset:0; background:rgba(0,0,0,0.5); z-index: 23100;';
        this.keyOverlay.onclick = () => this.closeKeyManager();

        this.keyModal = document.createElement('div');
        this.keyModal.id = 'config-key-modal';
        this.keyModal.className = 'app-themed-panel';
        this.keyModal.style.cssText = `
            display:none; position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
            width:min(560px,92vw); max-height:80vh; overflow:auto;
            background:var(--app-surface-card); border-radius:12px; box-shadow:0 10px 40px rgba(0,0,0,0.25);
            z-index: 23110; padding:16px;
        `;
        this.keyModal.onclick = (e) => e.stopPropagation();
        this.keyModal.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                <div>
                    <div style="display:flex; align-items:center; gap:7px; font-weight:800; color:var(--app-text-primary);">${API_CONFIG_ICONS.key}<span>Key 管理</span></div>
                    <div style="color:var(--app-text-muted); font-size:12px;">Key 以遮罩显示，不可复制；可保存多个并切换当前使用</div>
                </div>
                <button id="keymgr-close" aria-label="关闭 Key 管理" style="width:32px; height:32px; display:inline-flex; align-items:center; justify-content:center; border:none; border-radius:8px; background:var(--app-surface-subtle); color:var(--app-text-secondary); cursor:pointer;">${API_CONFIG_ICONS.close}</button>
            </div>
            <div style="margin-top:12px; border-top:1px solid var(--app-border-subtle); padding-top:12px;">
                <div style="font-weight:700; margin-bottom:6px;">已保存的 Keys</div>
                <ul id="keymgr-list" style="list-style:none; padding:0; margin:0; border:1px solid var(--app-border-subtle); border-radius:10px; overflow:hidden;"></ul>
            </div>
            <div style="margin-top:12px; border-top:1px solid var(--app-border-subtle); padding-top:12px;">
                <div style="font-weight:700; margin-bottom:6px;">新增 Key</div>
                <div style="display:flex; gap:8px; align-items:center;">
                    <input id="keymgr-input" type="password" placeholder="贴上 API Key" style="flex:1; padding:10px; border:1px solid var(--app-border-default); border-radius:10px;">
                    <button id="keymgr-add" style="padding:10px 12px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-subtle); cursor:pointer;">保存</button>
                </div>
                <small style="color:var(--app-text-muted);">保存后将自動设为当前 Key</small>
            </div>
        `;

        this.keyModal.querySelector('#keymgr-close').onclick = () => this.closeKeyManager();
        this.keyModal.querySelector('#keymgr-add').onclick = async () => {
            const input = this.keyModal.querySelector('#keymgr-input');
            const key = (input?.value || '').trim();
            if (!key) {
                window.toastr?.warning('请输入 Key');
                return;
            }
            const active = this.configManager.getActiveProfile?.();
            try {
                const keyId = await this.configManager.addKey(active?.id, key, 'API Key');
                await this.configManager.setActiveKey(active?.id, keyId);
                input.value = '';
                this.refreshKeyManagerList();
                this.syncMaskedKeyToForm();
                await this.syncRuntimeToAppBridge();
                window.toastr?.success('Key 已保存并设为当前');
            } catch (err) {
                window.toastr?.error(err.message || '保存 Key 失败');
            }
        };

        document.body.appendChild(this.keyOverlay);
        document.body.appendChild(this.keyModal);
    }

    syncMaskedKeyToForm() {
        const masked = this.getMaskedActiveKey();
        const apiKeyInput = (this.element || document).querySelector('#config-apikey');
        if (!apiKeyInput) return;
        apiKeyInput.value = masked || '';
        apiKeyInput.dataset.masked = masked || '';
        apiKeyInput.dataset.hasKey = masked ? 'true' : 'false';
    }

    async syncRuntimeToAppBridge() {
        if (this.activeTab !== 'chat') return;
        const runtime = await this.configManager.load();
        if (window.appBridge) {
            syncChatRuntimeConfigToBridge({
                bridge: window.appBridge,
                runtime,
                canInitClient,
                createClient: config => new LLMClient(config),
            });
        }
    }

    refreshKeyManagerList() {
        const list = this.keyModal?.querySelector('#keymgr-list');
        if (!list) return;
        const active = this.configManager.getActiveProfile?.();
        const keys = this.configManager.listKeys?.(active?.id) || [];
        list.innerHTML = '';
        if (!keys.length) {
            const li = document.createElement('li');
            li.style.cssText = 'padding:10px 12px; color:var(--app-text-muted);';
            li.textContent = '（尚无 Key）';
            list.appendChild(li);
            return;
        }
        keys.forEach((k) => {
            const li = document.createElement('li');
            li.style.cssText = 'padding:10px 12px; border-bottom:1px solid var(--app-surface-hover); display:flex; align-items:center; justify-content:space-between; gap:10px;';
            const left = document.createElement('div');
            const isActive = active?.activeKeyId === k.id;
            left.innerHTML = `<div style="font-weight:700; color:var(--app-text-primary);">${k.preview || '••••'}</div><div style="color:var(--app-text-muted); font-size:12px;">${k.label || 'API Key'}${isActive ? ' · 当前' : ''}</div>`;
            const right = document.createElement('div');
            right.style.display = 'flex';
            right.style.gap = '6px';

            const useBtn = document.createElement('button');
            useBtn.textContent = isActive ? '当前' : '使用';
            useBtn.disabled = isActive;
            useBtn.style.cssText = 'padding:6px 10px; border:1px solid var(--app-border-default); border-radius:10px; background:var(--app-surface-subtle); cursor:pointer;';
            useBtn.onclick = async () => {
                await this.configManager.setActiveKey(active?.id, k.id);
                this.refreshKeyManagerList();
                this.syncMaskedKeyToForm();
                await this.syncRuntimeToAppBridge();
            };

            const delBtn = document.createElement('button');
            delBtn.textContent = '删除';
            delBtn.style.cssText = 'padding:6px 10px; border:1px solid #fca5a5; border-radius:10px; background:#fee2e2; color:#b91c1c; cursor:pointer;';
            delBtn.onclick = async () => {
                const ok = await appConfirm({ title: '删除 Key', message: '删除该 Key？', danger: true });
                if (!ok) return;
                await this.configManager.removeKey(active?.id, k.id);
                this.refreshKeyManagerList();
                this.syncMaskedKeyToForm();
                await this.syncRuntimeToAppBridge();
            };

            right.appendChild(useBtn);
            right.appendChild(delBtn);
            li.appendChild(left);
            li.appendChild(right);
            list.appendChild(li);
        });
    }

    /**
     * 显示状态消息
     */
    showStatus(message, type = 'info') {
        const statusEl = (this.element || document).querySelector('#config-status');
        if (!statusEl) return;
        const state = ['success', 'error', 'info'].includes(type) ? type : 'info';
        statusEl.className = `api-config-status is-${state}`;
        statusEl.style.display = 'flex';
        statusEl.style.background = '';
        statusEl.style.color = '';
        statusEl.textContent = message;

        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 5000);
    }

    /**
     * 保存配置
     */
    async onSave() {
        const formData = this.getFormData();

        try {
            const missingVoiceModel = this.activeTab === 'voice'
                && this.voiceConnectionMode === 'shared'
                && (!formData.ttsModel || !formData.sttModel);
            if (missingVoiceModel || !formData.model || (this.usesEditableBaseUrl(formData.provider) && !formData.baseUrl)) {
                if (missingVoiceModel) {
                    this.showStatus('请填写 TTS / STT 模型', 'error');
                    return;
                }
                this.showStatus(this.usesEditableBaseUrl(formData.provider) ? '请填写 Base URL / 模型' : '请填写模型', 'error');
                return;
            }

            // 已保存 Key 存在时，输入框仍显示遮罩（formData.apiKey 会是 null）。
            const active = this.configManager.getActiveProfile?.();
            const keys = this.configManager.listKeys?.(active?.id) || [];
            const hasTypedKey = typeof formData.apiKey === 'string' && formData.apiKey.trim().length > 0;
            const hasSavedKey = keys.length > 0;
            if (formData.provider === 'vertexai') {
                const authMode = normalizeVertexAuthMode(formData.vertexaiAuthMode, formData);
                const hasServiceAccount = Boolean(
                    String(formData.vertexaiServiceAccount || this.configManager.get()?.vertexaiServiceAccount || '').trim(),
                );
                if (authMode === VERTEX_AUTH_MODE_EXPRESS && !hasTypedKey && !hasSavedKey) {
                    this.showStatus('Vertex AI Express 模式需要 API Key', 'error');
                    return;
                }
                if (authMode !== VERTEX_AUTH_MODE_EXPRESS && !hasServiceAccount) {
                    this.showStatus('Vertex AI 完整模式需要 Service Account JSON', 'error');
                    return;
                }
            }
            if (!hasTypedKey && !hasSavedKey && this.providerRequiresApiKey(formData.provider, formData.baseUrl)) {
                this.showStatus('请先在 Key 管理中保存至少一个 API Key，或在此栏贴上 Key 后保存', 'error');
                return;
            }
            this.setLoading(true);
            // 验证配置
            await this.configManager.validate({ ...formData, apiKey: hasTypedKey ? formData.apiKey.trim() : null });

            // 保存
            await this.configManager.save(formData);

            // 重新初始化客户端（仅聊天配置）
            if (window.appBridge && this.activeTab === 'chat') {
                const runtime = await this.configManager.load();
                const syncResult = syncChatRuntimeConfigToBridge({
                    bridge: window.appBridge,
                    runtime,
                    canInitClient,
                    createClient: config => new LLMClient(config),
                });
                await reloadBridgeConfig(window.appBridge);

                // 若保存后仍拿不到 key（解密/保存失败），給出明確提示并不自動关闭
                if (!syncResult.configured) {
                    this.showStatus('已保存，但当前 Key 不可用（请在 Key 管理中重新保存）', 'error');
                    return;
                }
            }

            this.showStatus('配置保存成功！', 'success');
            logger.info('配置保存成功');
            this.emitProfileChanged();
            const savedPayload = {
                tab: this.activeTab,
                profileId: this.configManager.getActiveProfileId?.() || '',
                profile: this.configManager.getActiveProfile?.() || null,
                config: this.configManager.get?.() || null,
                ...(this.activeTab === 'voice' ? {
                    voiceConnectionMode: this.voiceConnectionMode,
                    voiceCapability: this.voiceConnectionMode === 'split' ? this.voiceCapability : null,
                } : {}),
            };
            const callbacks = new Set([this.onSaved, this.openOptions?.onSaved].filter(callback => typeof callback === 'function'));
            for (const callback of callbacks) {
                try {
                    await callback(savedPayload);
                } catch (callbackError) {
                    logger.warn('config panel onSaved failed', callbackError);
                }
            }

            setTimeout(() => this.hide(), 1500);
        } catch (e) {
            this.showStatus(`保存失败: ${e.message}`, 'error');
            logger.error('保存配置失败:', e);
        } finally {
            this.setLoading(false);
        }
    }

    /**
     * 测试连接
     */
    async onTest() {
        const formData = this.getFormData();

        try {
            setApiButtonContent(this.testButton, API_CONFIG_ICONS.loader, '测试中...');
            this.testButton.disabled = true;

            if (this.activeTab === 'voice') {
                this.configManager.validate(formData);
                const runtime = await this.configManager.load();
                const existingKey = String(runtime?.apiKey || '').trim();
                const keyToUse = typeof formData.apiKey === 'string'
                    ? formData.apiKey.trim() || existingKey
                    : existingKey;
                if (!keyToUse && this.providerRequiresApiKey(formData.provider, formData.baseUrl)) {
                    this.showStatus('请先在 Key 管理中保存至少一个 API Key，或在此栏贴上 Key', 'error');
                    return;
                }
                const capabilities = this.voiceConnectionMode === 'shared'
                    ? ['tts', 'stt']
                    : [normalizeVoiceCapability(this.voiceCapability)];
                const client = new VoiceClient();
                const results = await Promise.all(capabilities.map(async (capability) => {
                    const model = this.voiceConnectionMode === 'shared'
                        ? capability === 'stt' ? formData.sttModel : formData.ttsModel
                        : formData.model;
                    const models = await client.listModels({
                        ...formData,
                        apiKey: keyToUse,
                        model,
                    }, { capability });
                    if (!models.length) throw new Error(`未获取到适用于 ${capability.toUpperCase()} 的模型`);
                    return `${capability.toUpperCase()} ${models.length} 个模型`;
                }));
                this.showStatus(`连接成功：${results.join('，')}`, 'success');
                logger.info(`语音 API 连接测试成功：${results.join('，')}`);
                return;
            }

            if (formData.provider === 'vertexai') {
                const requestConfig = await this.resolveVertexRequestConfig(formData);
                if (requestConfig.vertexaiAuthMode === VERTEX_AUTH_MODE_EXPRESS && !requestConfig.apiKey) {
                    this.showStatus('请先保存或填写 Vertex AI Express API Key', 'error');
                    return;
                }
                if (requestConfig.vertexaiAuthMode !== VERTEX_AUTH_MODE_EXPRESS && !requestConfig.vertexaiServiceAccount) {
                    this.showStatus('请填写 Vertex AI Service Account（JSON）后再测试连接', 'error');
                    return;
                }
                const tempClient = new LLMClient(requestConfig);
                const result = await tempClient.healthCheck();
                if (result.ok) {
                    this.showStatus('连接成功！', 'success');
                    logger.info('API 连接测试成功');
                } else {
                    this.showStatus(`连接失败: ${result.error}`, 'error');
                    logger.warn('API 连接测试失败:', result.error);
                }
                return;
            }

            const runtime = await this.configManager.load();
            const existingKey = (runtime?.apiKey || '').trim();
            const keyToUse = (typeof formData.apiKey === 'string') ? formData.apiKey.trim() : existingKey;
            if (!keyToUse && this.providerRequiresApiKey(formData.provider, formData.baseUrl)) {
                this.showStatus('请先在 Key 管理中保存至少一个 API Key，或在此栏贴上 Key', 'error');
                return;
            }
            const tempClient = new LLMClient({ ...formData, apiKey: keyToUse });
            const result = await tempClient.healthCheck();

            if (result.ok) {
                this.showStatus('连接成功！', 'success');
                logger.info('API 连接测试成功');
            } else {
                this.showStatus(`连接失败: ${result.error}`, 'error');
                logger.warn('API 连接测试失败:', result.error);
            }
        } catch (e) {
            this.showStatus(`测试失败: ${e.message}`, 'error');
            logger.error('API 连接测试异常:', e);
        } finally {
            setApiButtonContent(this.testButton, API_CONFIG_ICONS.zap, '测试连接');
            this.testButton.disabled = false;
        }
    }

    setLoading(isLoading) {
        if (!this.saveButton) return;
        this.saveButton.disabled = isLoading;
        this.testButton.disabled = isLoading;
        setApiButtonContent(
            this.saveButton,
            isLoading ? API_CONFIG_ICONS.loader : API_CONFIG_ICONS.save,
            isLoading ? '保存中...' : '保存',
        );
    }

    /**
     * 刷新模型列表
     */
    getRealtimeVoiceManagers() {
        return {
            chat: this.chatConfigManager,
            voice_shared: this.voiceSharedConfigManager,
            voice_tts: this.voiceTtsConfigManager,
            voice_stt: this.voiceSttConfigManager,
        };
    }

    setRealtimeVoiceStatus(message = '', type = '') {
        const element = this.element?.querySelector?.('#config-realtime-status');
        if (!element) return;
        element.textContent = String(message || '');
        element.dataset.type = String(type || '');
    }

    readRealtimeVoiceForm() {
        const panel = this.element;
        const profileValue = String(panel?.querySelector?.('#config-realtime-profile')?.value || '');
        const separator = profileValue.indexOf('::');
        const scope = separator >= 0 ? profileValue.slice(0, separator) : 'voice_shared';
        const profileId = separator >= 0 ? profileValue.slice(separator + 2) : '';
        return normalizeRealtimeVoiceSettings({
            ...appSettings.get().realtimeVoiceSettings,
            configRef: { scope, profileId },
            realtimeModel: panel?.querySelector?.('#config-realtime-model')?.value,
            transcriptionModel: panel?.querySelector?.('#config-realtime-transcription-model')?.value,
            transcriptionLanguage: panel?.querySelector?.('#config-realtime-transcription-language')?.value,
            replyLanguage: panel?.querySelector?.('#config-realtime-reply-language')?.value,
            voice: panel?.querySelector?.('#config-realtime-voice')?.value,
            vad: {
                ...(appSettings.get().realtimeVoiceSettings?.vad || {}),
                mode: panel?.querySelector?.('#config-realtime-vad-mode')?.value,
            },
            idleTimeoutMinutes: panel?.querySelector?.('#config-realtime-idle-timeout')?.value,
        });
    }

    async getRealtimeVoiceProfileOptions() {
        const labels = {
            chat: '聊天模型',
            voice_shared: '语音共用',
            voice_tts: 'TTS',
            voice_stt: 'STT',
        };
        const managers = this.getRealtimeVoiceManagers();
        await Promise.all(Object.values(managers).map(async manager => {
            try { await manager.load(); } catch {}
        }));
        const options = [];
        Object.entries(managers).forEach(([scope, manager]) => {
            const profiles = Array.isArray(manager.getProfiles?.()) ? manager.getProfiles() : [];
            profiles.forEach(profile => {
                if (String(profile?.provider || '').trim().toLowerCase() !== 'openai') return;
                options.push({
                    value: `${scope}::${profile.id}`,
                    label: `${labels[scope]} · ${profile.name || '未命名设置档'}`,
                });
            });
        });
        return options;
    }

    async renderRealtimeVoiceSettings() {
        if (!this.element) return;
        const card = this.element.querySelector('#config-voice-realtime-card');
        if (card && !this.realtimeSettingsPanel) this.realtimeSettingsPanel = new RealtimeSettingsPanel({ card });
        await this.realtimeSettingsPanel?.ready;
        this.realtimeSettingsPanel?.refresh();
        const settings = normalizeRealtimeVoiceSettings(appSettings.get().realtimeVoiceSettings);
        const profileSelect = this.element.querySelector('#config-realtime-profile');
        const options = await this.getRealtimeVoiceProfileOptions();
        if (profileSelect) {
            profileSelect.innerHTML = options.length
                ? options.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')
                : '<option value="">暂无可用的 OpenAI 设置档</option>';
            const selected = `${settings.configRef.scope}::${settings.configRef.profileId}`;
            profileSelect.value = options.some(option => option.value === selected)
                ? selected
                : (options[0]?.value || '');
        }
        const setValue = (selector, value) => {
            const input = this.element.querySelector(selector);
            if (input?.tagName === 'SELECT' && value && !Array.from(input.options || []).some(option => option.value === String(value))) {
                input.add(new Option(String(value), String(value)));
            }
            if (input) input.value = String(value ?? '');
        };
        setValue('#config-realtime-model', settings.realtimeModel);
        setValue('#config-realtime-transcription-model', settings.transcriptionModel);
        setValue('#config-realtime-transcription-language', settings.transcriptionLanguage);
        setValue('#config-realtime-reply-language', settings.replyLanguage);
        setValue('#config-realtime-voice', settings.voice);
        setValue('#config-realtime-vad-mode', settings.vad.mode);
        setValue('#config-realtime-idle-timeout', settings.idleTimeoutMinutes);
        this.refreshCustomSelect('config-realtime-transcription-language');
        this.setRealtimeVoiceStatus(options.length
            ? ''
            : '请先建立并保存一个官方 OpenAI 连线设置档。', options.length ? '' : 'warning');
    }

    async saveRealtimeVoiceSettings() {
        const settings = this.readRealtimeVoiceForm();
        const resolved = await resolveRealtimeConfigReference({
            settings,
            managers: this.getRealtimeVoiceManagers(),
            profileStore: { resolve: async () => null },
        });
        if (!resolved.ok) {
            const messages = {
                profile_missing: '请选择 OpenAI 连线设置档',
                profile_not_found: '所选设置档已不存在，请重新选择',
                provider_not_openai: '实时通话首版只支持官方 OpenAI 设置档',
                api_key_missing: '所选设置档没有可用 API Key',
                base_url_not_official: '实时通话首版只支持 OpenAI 官方 API 地址',
                scope_unavailable: '无法读取所选设置档',
                realtime_model_invalid: '请选择有效的 OpenAI Realtime 模型',
                transcription_model_invalid: '请选择有效的输入转写模型',
            };
            this.setRealtimeVoiceStatus(messages[resolved.reason] || '实时通话配置无效', 'error');
            return false;
        }
        await getRealtimeProfileStore().activate('');
        appSettings.update({ realtimeVoiceSettings: settings });
        this.setRealtimeVoiceStatus('实时通话设置已保存', 'success');
        try {
            window.dispatchEvent(new CustomEvent('realtime-voice-settings-changed', { detail: { settings } }));
        } catch {}
        return true;
    }

    async refreshRealtimeVoiceModels(kind = 'all') {
        const normalizedKind = kind === 'realtime' || kind === 'transcription' ? kind : 'all';
        const targets = normalizedKind === 'all'
            ? ['realtime', 'transcription']
            : [normalizedKind];
        const buttons = targets.map((target) => this.element?.querySelector?.(target === 'realtime'
            ? '#refresh-realtime-models'
            : '#refresh-realtime-transcription-models')).filter(Boolean);
        const settings = this.readRealtimeVoiceForm();
        buttons.forEach((button) => {
            button.disabled = true;
            setApiButtonContent(button, API_CONFIG_ICONS.loader, '刷新中...');
        });
        this.setRealtimeVoiceStatus(
            normalizedKind === 'realtime'
                ? '正在读取 OpenAI Realtime 模型...'
                : normalizedKind === 'transcription'
                    ? '正在读取 OpenAI 输入转写模型...'
                    : '正在读取 OpenAI 可用模型...',
            '',
        );
        try {
            const resolved = await resolveRealtimeConfigReference({
                settings,
                managers: this.getRealtimeVoiceManagers(),
                profileStore: { resolve: async () => null },
            });
            if (!resolved.ok) throw new Error('请先选择具备 API Key 的 OpenAI 官方设置档');
            const client = new VoiceClient();
            const results = await Promise.all(targets.map(async (target) => {
                const models = await client.listModels(resolved.config, {
                    capability: target === 'realtime' ? 'realtime' : 'realtime_transcription',
                });
                if (!models.length) {
                    throw new Error(target === 'realtime'
                        ? '目录中没有可用 Realtime 模型'
                        : '目录中没有可用输入转写模型');
                }
                return [target, models];
            }));
            if (this.activeTab !== 'voice' || this.voiceConfigView !== 'realtime') return;
            results.forEach(([target, models]) => this.renderRealtimeVoiceModelOptions(target, models));
            const counts = Object.fromEntries(results.map(([target, models]) => [target, models.length]));
            this.setRealtimeVoiceStatus(normalizedKind === 'all'
                ? `已加载 ${counts.realtime} 个 Realtime、${counts.transcription} 个转写模型`
                : `已加载 ${counts[normalizedKind]} 个${normalizedKind === 'realtime' ? ' Realtime' : '输入转写'}模型`, 'success');
        } catch (error) {
            this.setRealtimeVoiceStatus(`刷新失败：${error.message}`, 'error');
        } finally {
            buttons.forEach((button) => {
                setApiButtonContent(button, API_CONFIG_ICONS.refresh, '刷新列表');
                button.disabled = false;
            });
        }
    }

    async refreshVoiceModels(capability = this.voiceCapability) {
        const normalized = normalizeVoiceCapability(capability);
        const shared = this.voiceConnectionMode === 'shared';
        const panel = this.element || document;
        const refreshBtn = panel.querySelector(shared
            ? `#refresh-voice-${normalized}-models`
            : '#refresh-models');
        const modelHelp = panel.querySelector(shared
            ? `#config-voice-${normalized}-model-help`
            : '#model-help');
        const originalHelpText = modelHelp?.textContent || '';
        const capabilityLabel = normalized === 'stt' ? 'STT' : 'TTS';
        const formData = this.getFormData();

        try {
            if (!formData.baseUrl) {
                this.showStatus('请先填写 Base URL', 'error');
                return;
            }
            const runtime = await this.configManager.load();
            const existingKey = String(runtime?.apiKey || '').trim();
            const keyToUse = typeof formData.apiKey === 'string'
                ? formData.apiKey.trim()
                : existingKey;
            if (!keyToUse && this.providerRequiresApiKey(formData.provider, formData.baseUrl)) {
                this.showStatus('请先在 Key 管理中保存至少一个 API Key，或在此栏贴上 Key', 'error');
                return;
            }

            setApiButtonContent(refreshBtn, API_CONFIG_ICONS.loader, '获取中...');
            if (refreshBtn) refreshBtn.disabled = true;
            if (modelHelp) {
                modelHelp.textContent = `正在获取可用 ${capabilityLabel} 模型...`;
                modelHelp.style.color = 'var(--app-accent-strong)';
            }

            const requestConfig = {
                ...formData,
                apiKey: keyToUse,
                model: shared
                    ? (normalized === 'stt' ? formData.sttModel : formData.ttsModel)
                    : formData.model,
            };
            logger.info(`正在获取 ${formData.provider} 的 ${capabilityLabel} 模型列表...`);
            const models = await new VoiceClient().listModels(requestConfig, {
                capability: normalized,
            });
            if (!models.length) {
                throw new Error(`未获取到适用于 ${capabilityLabel} 的模型；仍可手动填写模型 ID`);
            }

            const providerStillCurrent = this.activeTab === 'voice'
                && panel.querySelector('#config-provider')?.value === formData.provider
                && this.voiceConnectionMode === (shared ? 'shared' : 'split')
                && (shared || this.voiceCapability === normalized);
            if (!providerStillCurrent) return;

            if (shared) this.renderVoiceModelOptions(normalized, models);
            else this.renderModelOptions(models);
            try {
                window.dispatchEvent(new CustomEvent('config-models-refreshed', {
                    detail: {
                        tab: 'voice',
                        provider: formData.provider,
                        capability: normalized,
                        count: models.length,
                    },
                }));
            } catch {}
            this.showStatus(`成功获取 ${models.length} 个可用 ${capabilityLabel} 模型`, 'success');
            if (modelHelp) {
                modelHelp.textContent = `已加载 ${models.length} 个 ${capabilityLabel} 模型（可输入或从列表选择）`;
                modelHelp.style.color = 'var(--app-accent-strong)';
            }
            logger.info(`成功获取 ${models.length} 个 ${capabilityLabel} 模型:`, models);
            setTimeout(() => {
                if (!modelHelp) return;
                modelHelp.textContent = originalHelpText;
                modelHelp.style.color = 'var(--app-text-secondary)';
            }, 3000);
        } catch (error) {
            this.showStatus(`获取${capabilityLabel}模型列表失败: ${error.message}`, 'error');
            logger.error(`获取 ${capabilityLabel} 模型列表失败:`, error);
            if (modelHelp) {
                modelHelp.textContent = '获取失败，请检查配置后重试';
                modelHelp.style.color = 'var(--app-danger-text)';
            }
            setTimeout(() => {
                if (!modelHelp) return;
                modelHelp.textContent = originalHelpText;
                modelHelp.style.color = 'var(--app-text-secondary)';
            }, 5000);
        } finally {
            setApiButtonContent(refreshBtn, API_CONFIG_ICONS.refresh, '刷新列表');
            if (refreshBtn) refreshBtn.disabled = false;
        }
    }

    async refreshModels() {
        if (this.activeTab === 'voice') {
            await this.refreshVoiceModels(this.voiceCapability);
            return;
        }
        const formData = this.getFormData();
        const refreshBtn = document.getElementById('refresh-models');
        const modelHelp = document.getElementById('model-help');
        const originalHelpText = modelHelp.textContent;

        try {
            // 验证必填字段
            if (this.usesEditableBaseUrl(formData.provider) && !formData.baseUrl) {
                this.showStatus('请先填写 Base URL', 'error');
                return;
            }
            const runtime = await this.configManager.load();
            const existingKey = (runtime?.apiKey || '').trim();
            const keyToUse = (typeof formData.apiKey === 'string') ? formData.apiKey.trim() : existingKey;
            if (!keyToUse && formData.provider !== 'vertexai') {
                this.showStatus('请先在 Key 管理中保存至少一个 API Key，或在此栏贴上 Key', 'error');
                return;
            }
            let requestConfig = { ...formData, apiKey: keyToUse };
            if (formData.provider === 'vertexai') {
                requestConfig = await this.resolveVertexRequestConfig(formData);
                if (requestConfig.vertexaiAuthMode === VERTEX_AUTH_MODE_EXPRESS && !requestConfig.apiKey) {
                    this.showStatus('请先保存或填写 Vertex AI Express API Key', 'error');
                    return;
                }
                if (requestConfig.vertexaiAuthMode !== VERTEX_AUTH_MODE_EXPRESS && !requestConfig.vertexaiServiceAccount) {
                    this.showStatus('请填写 Vertex AI Service Account（JSON）后再刷新列表', 'error');
                    return;
                }
            }

            // 设置加载状态
            setApiButtonContent(refreshBtn, API_CONFIG_ICONS.loader, '获取中...');
            refreshBtn.disabled = true;
            modelHelp.textContent = '正在从服务器获取可用模型列表...';
            modelHelp.style.color = 'var(--app-accent-strong)';

            // 创建临时客户端
            const tempClient = new LLMClient(requestConfig);

            // 获取模型列表
            logger.info(`正在获取 ${formData.provider} 的模型列表...`);
            const models = await tempClient.listModels();
            if (
                this.activeTab === 'chat'
                && typeof tempClient.prepareProviderFcCapabilities === 'function'
            ) {
                await tempClient.prepareProviderFcCapabilities();
            }
            const needsGoogleImageModels = this.activeTab === 'image'
                && (formData.provider === 'makersuite' || formData.provider === 'vertexai');
            if (needsGoogleImageModels) {
                const googleImageModels = [
                    'gemini-3.1-flash-lite-image',
                    'gemini-3.1-flash-image',
                    'gemini-3-pro-image',
                    'gemini-2.5-flash-image',
                ];
                const merged = Array.from(new Set([...(models || []), ...googleImageModels]));
                models.length = 0;
                merged.forEach(model => models.push(model));
            }

            if (!models || models.length === 0) {
                throw new Error('未获取到模型列表');
            }

            this.renderModelOptions(models);
            if (formData.provider === 'openrouter') {
                await this.refreshOpenRouterProviders({ notify: false });
            }
            try {
                window.dispatchEvent(new CustomEvent('config-models-refreshed', {
                    detail: {
                        tab: this.activeTab,
                        provider: formData.provider,
                        count: models.length,
                    },
                }));
            } catch {}

            // 成功提示
            this.showStatus(`成功获取 ${models.length} 个可用模型`, 'success');
            modelHelp.textContent = `已加载 ${models.length} 个模型（可输入或从列表选择）`;
            modelHelp.style.color = 'var(--app-accent-strong)';
            logger.info(`成功获取 ${models.length} 个模型:`, models);

            // 3秒后恢复原始提示
            setTimeout(() => {
                modelHelp.textContent = originalHelpText;
                modelHelp.style.color = 'var(--app-text-secondary)';
            }, 3000);

        } catch (e) {
            this.showStatus(`获取模型列表失败: ${e.message}`, 'error');
            logger.error('获取模型列表失败:', e);
            const fallbackModels = Array.isArray(e?.fallbackModels) ? e.fallbackModels : [];
            if (fallbackModels.length > 0) {
                const fallback = [...fallbackModels];
                if (this.activeTab === 'image') {
                    fallback.unshift(
                        'gemini-3.1-flash-lite-image',
                        'gemini-3.1-flash-image',
                        'gemini-3-pro-image',
                        'gemini-2.5-flash-image',
                    );
                }
                this.renderModelOptions(Array.from(new Set(fallback)));
            }
            modelHelp.textContent = fallbackModels.length > 0
                ? '目录获取失败，已显示内建候选；请检查权限，或直接填写模型 ID'
                : '获取失败，请检查配置后重试';
            modelHelp.style.color = 'var(--app-danger-text)';

            // 5秒后恢复原始提示
            setTimeout(() => {
                modelHelp.textContent = originalHelpText;
                modelHelp.style.color = 'var(--app-text-secondary)';
            }, 5000);
        } finally {
            setApiButtonContent(refreshBtn, API_CONFIG_ICONS.refresh, '刷新列表');
            refreshBtn.disabled = false;
        }
    }
}
