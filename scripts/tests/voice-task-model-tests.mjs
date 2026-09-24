import assert from 'node:assert/strict';

import {
  createVoiceAwareMaidRuntimeResolver,
  createVoiceTaskModelRegistry,
  resolveVoiceTaskModel,
} from '../../src/scripts/ui/realtime/voice-task-model.js';
import { OPENAI_LIVE_BACKEND_MODEL } from '../../src/scripts/ui/realtime/openai-live-config.js';

// 语音设置档能提供的文本模型：GPT-Live 用推理模型，OpenAI Realtime 用默认推理模型，其他服务商没有
{
  const live = resolveVoiceTaskModel({
    config: { provider: 'openai', model: 'gpt-live-1', apiKey: 'sk-live', baseUrl: 'https://api.openai.com/v1/', voice: 'marin', credentials: { apiKey: 'sk-live' } },
    settings: { openaiBackend: 'live', liveBackendModel: 'gpt-5.6-terra' },
  });
  assert.deepEqual(live, { model: 'gpt-5.6-terra', config: { provider: 'openai', apiKey: 'sk-live', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-terra' } }, 'only the fields a text client needs');
  const realtime = resolveVoiceTaskModel({ config: { provider: 'openai', model: 'gpt-realtime', credentials: { apiKey: 'sk-rt' } }, settings: {} });
  assert.equal(realtime.model, OPENAI_LIVE_BACKEND_MODEL, 'the realtime audio model is never used as a text model');
  assert.equal(realtime.config.apiKey, 'sk-rt');
  assert.equal(resolveVoiceTaskModel({ config: { provider: 'xai_voice', apiKey: 'k' }, settings: {} }), null);
  assert.equal(resolveVoiceTaskModel({ config: { provider: 'openai' }, settings: {} }), null, 'no key, no voice execution');
  assert.equal(resolveVoiceTaskModel({}), null);
  console.log('ok - voice profiles expose a text model only when they can run one');
}

// 按通话记住执行模型：通话结束后任务仍可查到；未选语音执行时清掉
{
  const registry = createVoiceTaskModelRegistry({ limit: 2 });
  registry.remember('call-1', { model: 'a' });
  registry.remember('call-2', { model: 'b' });
  registry.remember('call-3', { model: 'c' });
  assert.equal(registry.get('call-1'), null, 'bounded');
  assert.equal(registry.get('call-3').model, 'c');
  registry.remember('call-3', null);
  assert.equal(registry.get('call-3'), null);
  assert.equal(registry.get(''), null);
  console.log('ok - the registry keeps the model per call and stays bounded');
}

// 解析器：语音执行的通话换用语音模型并保留女仆人格等字段；其他任务原样使用女仆模型
{
  const registry = createVoiceTaskModelRegistry();
  const maidRuntime = { configured: true, bound: true, config: { model: 'deepseek-flash' }, client: { id: 'maid' }, fallbackClient: { id: 'fallback' }, maidPrompt: '女仆人格', subAgents: [{ id: 's1' }], bindingSource: 'maid' };
  const created = [];
  const resolve = createVoiceAwareMaidRuntimeResolver({
    resolveMaidRuntime: async () => maidRuntime,
    registry,
    createClient: config => { created.push(config); return { id: 'voice', config }; },
    captureRequestContext: context => ({ captured: context }),
  });
  assert.equal(await resolve({ sessionId: 'maid' }), maidRuntime, 'typed tasks keep the maid model');
  assert.equal(await resolve({ voiceCallId: 'call-x' }), maidRuntime, 'calls without a remembered model keep the maid model');
  registry.remember('call-v', { model: 'gpt-5.6-luna', config: { provider: 'openai', apiKey: 'sk', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-luna' } });
  const voice = await resolve({ voiceCallId: 'call-v', sessionId: 'maid' });
  assert.equal(voice.client.id, 'voice');
  assert.equal(voice.config.model, 'gpt-5.6-luna');
  assert.equal(voice.config.timeout, 240000);
  assert.deepEqual(voice.config.requestContext, { captured: { sessionId: 'maid' } });
  assert.equal(voice.fallbackClient, null, "the maid profile's fallback is not mixed into voice execution");
  assert.equal(voice.maidPrompt, '女仆人格');
  assert.deepEqual(voice.subAgents, [{ id: 's1' }]);
  assert.equal(voice.bindingSource, 'voice');
  assert.equal(created.length, 1);
  console.log('ok - voice-executed tasks run the maid pipeline on the voice profile model');
}

console.log('voice task model tests passed');
