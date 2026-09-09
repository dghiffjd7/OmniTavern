/**
 * LLM API 客户端 - 统一的接口层
 */

import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { CustomProvider } from './providers/custom.js';
import { GeminiProvider } from './providers/gemini.js';
import { DeepseekProvider } from './providers/deepseek.js';
import { OllamaProvider } from './providers/ollama.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { OpenCodeProvider } from './providers/opencode.js';
import { bindOpenCodeRequestContext } from './opencode-request-headers.js';
import { KimiProvider } from './providers/kimi.js';
import { ZhipuProvider } from './providers/zhipu.js';
import { MakersuiteProvider } from './providers/makersuite.js';
import { VertexAIProvider } from './providers/vertexai.js';
import {
    Automatic1111ImageProvider,
    ComfyUIImageProvider,
    NovelAIImageProvider,
    PollinationsImageProvider,
    StabilityAIImageProvider,
    TogetherAIImageProvider,
} from './providers/image-generation-providers.js';

const PROVIDER_CLASSES = Object.freeze({
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
    gemini: GeminiProvider,
    makersuite: MakersuiteProvider,
    vertexai: VertexAIProvider,
    deepseek: DeepseekProvider,
    ollama: OllamaProvider,
    openrouter: OpenRouterProvider,
    opencode: OpenCodeProvider,
    kimi: KimiProvider,
    zhipu: ZhipuProvider,
    custom: CustomProvider,
    novelai: NovelAIImageProvider,
    stability: StabilityAIImageProvider,
    togetherai: TogetherAIImageProvider,
    pollinations: PollinationsImageProvider,
    automatic1111: Automatic1111ImageProvider,
    a1111: Automatic1111ImageProvider,
    comfyui: ComfyUIImageProvider,
    comfy: ComfyUIImageProvider,
});

export class LLMClient {
    constructor(config) {
        this.config = config;
        this.provider = this.createProvider(config.provider);
    }

    /**
     * 根据配置创建对应的提供商
     */
    createProvider(type) {
        const ProviderClass = PROVIDER_CLASSES[type];
        if (!ProviderClass) {
            throw new Error(`Unknown provider: ${type}. Available: ${Object.keys(PROVIDER_CLASSES).join(', ')}`);
        }

        return new ProviderClass(this.config);
    }

    /**
     * 发送聊天消息（非流式）
     * @param {Array} messages - 消息数组 [{role: 'user', content: '...'}]
     * @param {Object} options - 可选参数（temperature, maxTokens 等）
     * @returns {Promise<string>} AI 回复的文本
     */
    async chat(messages, options = {}) {
        return bindOpenCodeRequestContext(this.provider, options.requestContext).chat(messages, options);
    }

    /**
     * 流式聊天
     * @param {Array} messages - 消息数组
     * @param {Object} options - 可选参数
     * @returns {AsyncGenerator<string>} 逐字符/逐词的文本流
     */
    async *streamChat(messages, options = {}) {
        yield* bindOpenCodeRequestContext(this.provider, options.requestContext).streamChat(messages, options);
    }

    prepareChatRequest(messages, options = {}) {
        if (typeof this.provider?.prepareChatRequest === 'function') {
            return bindOpenCodeRequestContext(this.provider, options.requestContext).prepareChatRequest(messages, options);
        }
        return null;
    }

    /**
     * 获取可用模型列表
     * @returns {Promise<Array<string>>} 模型 ID 列表
     */
    async listModels() {
        return this.provider.listModels();
    }

    async listModelProviders(model = this.config?.model) {
        if (typeof this.provider?.listModelProviders !== 'function') {
            throw new Error(`当前 provider 不支持查询模型上游: ${this.config?.provider || ''}`);
        }
        return this.provider.listModelProviders(model);
    }

    async prepareProviderFcCapabilities() {
        if (typeof this.provider?.prepareProviderFcCapabilities !== 'function') return null;
        return this.provider.prepareProviderFcCapabilities();
    }

    /**
     * 健康检查
     * @returns {Promise<{ok: boolean, error?: string}>}
     */
    async healthCheck() {
        const hasRequestRules = this.config?.customRequestParams?.some(row => row.enabled !== false)
            || this.config?.excludedGenerationParams?.length;
        if (hasRequestRules && typeof this.provider.chat === 'function') {
            try {
                await this.chat([{ role: 'user', content: 'Hi' }], {
                    maxTokens: 128, requestParamConstraints: { maxOutputTokens: 128, tools: 'none' },
                });
                return { ok: true };
            } catch (error) { return { ok: false, error: error.message }; }
        }
        return this.provider.healthCheck();
    }

    /**
     * 生成图片（非流式）
     * @param {string} prompt
     * @param {Object} options
     * @returns {Promise<Array<{dataUrl?: string, url?: string, index: number}>>}
     */
    async generateImage(prompt, options = {}) {
        if (typeof this.provider.generateImage !== 'function') {
            throw new Error(`当前 provider 不支持图片生成: ${this.config.provider}`);
        }
        return this.provider.generateImage(prompt, options);
    }

    /**
     * 重新配置客户端
     * @param {Object} newConfig - 新的配置
     */
    reconfigure(newConfig) {
        this.config = newConfig;
        this.provider = this.createProvider(newConfig.provider);
    }
}
