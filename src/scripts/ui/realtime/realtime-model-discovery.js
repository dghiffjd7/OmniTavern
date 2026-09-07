import { t } from '../../i18n/index.js';
import { safeInvoke } from '../../utils/tauri.js';
import { invokeNativeHttpRequest, createLinkedAbortController } from '../../api/abort.js';
import { buildVoiceModelsRequest, parseVoiceModelCatalog } from '../../api/voice-client.js';
import { REALTIME_PROVIDERS, GEMINI_VERTEX_MODELS, isGeminiVertex, validateRealtimeCredentials, getStepRealtimeApiBase } from './realtime-provider-catalog.js';

const aborted = () => new DOMException('Cancelled', 'AbortError');
const checkSignal = signal => { if (signal?.aborted) throw aborted(); };
export const realtimeModelDefaults = profile => [...(isGeminiVertex(profile) ? GEMINI_VERTEX_MODELS : REALTIME_PROVIDERS[profile.provider]?.models || [])];
export const realtimeModelSource = profile => JSON.stringify([profile.id || '', profile.provider, profile.geminiBackend || '', profile.vertexaiAuthMode || '', profile.region || '', profile.workspaceId || '', profile.vertexaiProjectId || '', profile.credentialId || '']);
export const filterRealtimeModels = (profile, items) => {
  if (profile.provider === 'openai') return parseVoiceModelCatalog({ data: items }, { provider: 'openai', capability: 'realtime' });
  const ids = items.filter(item => item && item.modelLifecycle?.status !== 'END_OF_LIFE').map(item => {
    const id = String(typeof item === 'string' ? item : item.id || item.modelId || item.model || item.name || '').split('/').pop();
    if (!id || id.length > 200 || /\s|[<>]/.test(id) || /(?:^|[-_])(tts|asr|transcribe|transcription|translate)(?:$|[-_])/i.test(id)) return '';
    if (profile.provider === 'gemini_live') return /^gemini/i.test(id) && (/(live|native-audio)/i.test(id) || item.supportedGenerationMethods?.some(method => /bidiGenerateContent/i.test(method))) ? id : '';
    const pattern = { qwen_audio_realtime: /^qwen-audio.*-realtime(?:-|$)/i, step_realtime: /^stepaudio.*-realtime(?:-|$)/i, xai_voice: /^grok-voice(?:-|$)/i, nova_sonic: /^amazon\.nova.*-sonic(?:-|:|$)/i }[profile.provider];
    return pattern?.test(id) ? id : '';
  });
  return [...new Set(ids.filter(Boolean))];
};

// A single fixed Bedrock GET, signed by the AWS SDK signer and sent by the existing
// cancellable native HTTP transport. No AWS key is placed in the URL or cache.
export const buildNovaModelsRequest = async (profile, credentials, now = new Date()) => {
  if (!REALTIME_PROVIDERS.nova_sonic.regions.includes(profile.region)) throw new Error(t('请选择受支持的区域'));
  validateRealtimeCredentials('nova_sonic', credentials);
  const { SignatureV4, Sha256 } = await import('../../../vendor/realtime/aws-signing.js');
  const host = `bedrock.${profile.region}.amazonaws.com`;
  const signer = new SignatureV4({ service: 'bedrock', region: profile.region, sha256: Sha256,
    credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey, ...(credentials.sessionToken ? { sessionToken: credentials.sessionToken } : {}) } });
  const { headers } = await signer.sign({ protocol: 'https:', hostname: host, path: '/foundation-models', query: { byProvider: 'Amazon' }, method: 'GET', headers: { host } }, { signingDate: now });
  return { url: `https://${host}/foundation-models?byProvider=Amazon`, headers };
};

const vertexAuth = async (profile, credentials) => {
  const { VertexAIProvider } = await import('../../api/providers/vertexai.js');
  return new VertexAIProvider({ vertexaiAuthMode: 'service_account', vertexaiServiceAccount: credentials.vertexaiServiceAccount, timeout: 20000 });
};
export class RealtimeModelDiscovery {
  constructor({ invoke = safeInvoke, createVertexAuth = vertexAuth } = {}) { this.invoke = invoke; this.createVertexAuth = createVertexAuth; }
  async request(url, headers, signal) {
    checkSignal(signal);
    let response;
    try { response = await invokeNativeHttpRequest({ invoker: this.invoke, signal, args: { url, headers, method: 'GET', body: null, timeoutMs: 20000 } }); }
    catch (error) { if (error.name === 'AbortError') throw error; throw new Error(t('获取模型列表失败，请检查网络后重试；当前模型不会被覆盖')); }
    checkSignal(signal);
    if (!(response?.status >= 200 && response.status < 300)) throw new Error(t('获取模型列表失败（HTTP {status}），请检查凭证和模型目录权限', { status: response?.status || 0 }));
    let data;
    try { data = JSON.parse(response.body); } catch { throw new Error(t('模型列表返回了无效响应')); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('模型列表返回了无效响应'));
    if (data.success === false || data.error || data.code) throw new Error(t('模型列表查询失败，请检查凭证和区域配置'));
    return data;
  }
  async list(profile, credentials, { signal } = {}) {
    const linked = createLinkedAbortController({ signal, timeoutMs: 30000 });
    try { return await this.load(profile, credentials, linked.controller.signal); }
    finally { linked.cleanup(); }
  }
  async load(profile, credentials, signal) {
    checkSignal(signal);
    if (profile.provider === 'doubao_realtime' || (isGeminiVertex(profile) && profile.vertexaiAuthMode === 'express')) {
      return { models: realtimeModelDefaults(profile), remote: false, message: t('此接入方式暂不支持在线模型列表；已显示内建候选，也可手动填写') };
    }
    validateRealtimeCredentials(profile.provider, credentials, profile);
    let url, headers = { Authorization: `Bearer ${credentials.apiKey}` }, paging = '', rows = [], page = 1, token = '';
    if (profile.provider === 'openai') ({ url, headers } = buildVoiceModelsRequest({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: credentials.apiKey }));
    else if (profile.provider === 'gemini_live') {
      if (isGeminiVertex(profile)) {
        const auth = await this.createVertexAuth(profile, credentials); checkSignal(signal);
        let accessToken;
        try { accessToken = await auth.getAccessToken({ signal }); }
        catch (error) { if (error.name === 'AbortError') throw error; throw new Error(t('Vertex AI 鉴权失败，请检查 Service Account、项目权限与网络')); }
        headers = { Authorization: `Bearer ${accessToken}` }; url = 'https://aiplatform.googleapis.com/v1beta1/publishers/google/models';
      } else { url = 'https://generativelanguage.googleapis.com/v1beta/models'; headers = { 'x-goog-api-key': credentials.apiKey }; }
      paging = 'token';
    } else if (profile.provider === 'qwen_audio_realtime') {
      if (!REALTIME_PROVIDERS.qwen_audio_realtime.regions.includes(profile.region) || !/^[a-zA-Z0-9-]*$/.test(profile.workspaceId || '')) throw new Error(t('模型列表查询失败，请检查凭证和区域配置'));
      const host = profile.region === 'ap-southeast-1' ? 'dashscope-intl.aliyuncs.com' : profile.workspaceId ? `${profile.workspaceId}.cn-beijing.maas.aliyuncs.com` : 'dashscope.aliyuncs.com';
      url = `https://${host}/api/v1/models`; paging = 'page';
    } else if (profile.provider === 'step_realtime') url = `${getStepRealtimeApiBase(profile)}/models`;
    else if (profile.provider === 'xai_voice') url = 'https://api.x.ai/v1/models';
    else if (profile.provider === 'nova_sonic') ({ url, headers } = await buildNovaModelsRequest(profile, credentials));
    else throw new Error(t('未知实时语音服务商'));
    const seenTokens = new Set();
    while (true) {
      checkSignal(signal);
      const requestUrl = new URL(url);
      if (paging === 'token') { requestUrl.searchParams.set('pageSize', '100'); if (token) requestUrl.searchParams.set('pageToken', token); }
      if (paging === 'page') { requestUrl.searchParams.set('page_no', String(page)); requestUrl.searchParams.set('page_size', '100'); }
      const data = await this.request(requestUrl.href, headers, signal);
      const items = data.publisherModels || data.models || data.data || data.output?.models || data.modelSummaries;
      if (!Array.isArray(items)) throw new Error(t('模型列表返回了无效响应'));
      if (rows.length + items.length > 5000) throw new Error(t('模型列表过大，请稍后重试'));
      rows.push(...items);
      if (paging === 'token') {
        token = String(data.nextPageToken || ''); if (!token) break;
        if (seenTokens.has(token)) throw new Error(t('模型列表分页异常，请稍后重试')); seenTokens.add(token);
      } else if (paging === 'page') {
        const total = Number(data.output?.total);
        if (!items.length || (Number.isFinite(total) ? rows.length >= total : items.length < 100)) break;
      } else break;
      if (++page > 50 || rows.length > 5000) throw new Error(t('模型列表过大，请稍后重试'));
    }
    const models = filterRealtimeModels(profile, rows); checkSignal(signal);
    if (!models.length) throw new Error(t('目录中未找到此渠道的实时通话模型；可保留当前值或手动填写'));
    return { models, remote: true };
  }
}
