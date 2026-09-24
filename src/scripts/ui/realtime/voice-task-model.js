import { OPENAI_LIVE_BACKEND_MODEL } from './openai-live-config.js';

/* “语音执行”模式下，实时语音里交办的应用任务由语音设置档所在账号的文本模型执行（仍走女仆的规划、确认与读回流程）。
   GPT-Live 用设置档里的推理模型；OpenAI Realtime 没有单独的文本模型设置，用同一账号的推理模型默认值；
   其他服务商没有可用的文本接口，返回 null，任务交给女仆设置里的模型。 */
export const resolveVoiceTaskModel = ({ config = null, settings = null } = {}) => {
  if (!config || typeof config !== 'object') return null;
  if (String(config.provider || 'openai').trim().toLowerCase() !== 'openai') return null;
  const apiKey = String(config.apiKey || config.credentials?.apiKey || '').trim();
  if (!apiKey) return null;
  const model = String(settings?.liveBackendModel || OPENAI_LIVE_BACKEND_MODEL).trim();
  if (!model) return null;
  return {
    model,
    config: {
      provider: 'openai',
      apiKey,
      baseUrl: String(config.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, ''),
      model,
    },
  };
};

// 按通话记住交办时的执行模型：任务可能在通话结束后才跑完，不能等执行时再去读已断开的连接
export const createVoiceTaskModelRegistry = ({ limit = 8 } = {}) => {
  const models = new Map();
  return {
    remember: (callId = '', model = null) => {
      const id = String(callId || '').trim();
      if (!id) return;
      models.delete(id);
      if (!model) return;
      models.set(id, model);
      while (models.size > limit) models.delete(models.keys().next().value);
    },
    get: (callId = '') => models.get(String(callId || '').trim()) || null,
  };
};

/* 女仆运行时解析器外包一层：来自“语音执行”通话的任务改用该通话记下的模型；
   女仆的人格提示与子代理等其余字段照旧，只替换执行模型，也不带女仆档的备用 client。 */
export const createVoiceAwareMaidRuntimeResolver = ({
  resolveMaidRuntime,
  registry,
  createClient,
  captureRequestContext = context => context,
  timeoutMs = 240000,
} = {}) => async (context = {}) => {
  const base = await resolveMaidRuntime(context);
  const voiceModel = registry?.get?.(context?.voiceCallId);
  if (!voiceModel || typeof createClient !== 'function') return base;
  const config = {
    ...voiceModel.config,
    requestContext: captureRequestContext(context?.requestContext || { sessionId: context?.sessionId || 'maid' }),
    timeout: timeoutMs,
  };
  return {
    ...(base && typeof base === 'object' ? base : {}),
    configured: true,
    bound: true,
    config,
    client: createClient(config),
    fallbackClient: null,
    fallbackConfig: null,
    fallbackProfileId: '',
    profileId: '',
    bindingSource: 'voice',
    reason: '',
  };
};
