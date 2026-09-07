import assert from 'node:assert/strict';
import { RealtimeModelDiscovery, filterRealtimeModels, buildNovaModelsRequest } from '../../src/scripts/ui/realtime/realtime-model-discovery.js';
import { makeRealtimeProfile, validateRealtimeProfile } from '../../src/scripts/ui/realtime/realtime-provider-catalog.js';
import { buildDoubaoSession } from '../../src/scripts/ui/realtime/realtime-doubao-protocol.js';
const response = data => ({ status: 200, body: JSON.stringify(data) });
const vertex = { ...makeRealtimeProfile(), geminiBackend: 'vertex', vertexaiAuthMode: 'service_account', model: 'gemini-live-2.5-flash-native-audio', region: 'us-central1', vertexaiProjectId: 'test-project' };
const credentials = { apiKey: 'STUDIO_ONLY', vertexaiApiKey: 'EXPRESS_ONLY', vertexaiServiceAccount: JSON.stringify({ client_email: 'test@example.com', private_key: '-----BEGIN PRIVATE KEY-----\nTEST\n-----END PRIVATE KEY-----' }), accessKeyId: 'AWS_TEST_ACCESS', secretAccessKey: 'AWS_TEST_SECRET', sessionToken: 'AWS_TEST_SESSION' };
let count = 0;
const test = async (name, body) => { await body(); count++; console.log(`ok - ${name}`); };
await test('catalogs select conversation models and preserve future versions and aliases', () => {
  const fixtures = {
    openai: ['gpt-realtime-next', 'gpt-4o-mini-tts', 'whisper-1'],
    gemini_live: ['gemini-next-native-audio', 'gemini-2.5-flash-preview-tts', 'gemini-flash'],
    qwen_audio_realtime: ['qwen-audio-3.0-realtime-plus-2026-09', 'qwen-audio-3.0-tts-realtime', 'qwen-audio-3.0-asr-realtime', 'qwen3.5-omni-realtime'],
    step_realtime: ['stepaudio-2.5-realtime-next', 'stepaudio-2.5-tts', 'stepaudio-asr-realtime'],
    xai_voice: ['grok-voice-latest', 'grok-4.3', 'grok-transcribe'],
    nova_sonic: ['amazon.nova-2-sonic-v1:1', 'amazon.nova-pro-v1:0'],
  };
  for (const [provider, ids] of Object.entries(fixtures)) assert.deepEqual(filterRealtimeModels(makeRealtimeProfile(provider), ids.map(id => ({ id }))), ids.slice(0, 1));
  assert.deepEqual(filterRealtimeModels(makeRealtimeProfile(), [{ name: 'models/gemini-audio-future', supportedGenerationMethods: ['bidiGenerateContent'] }, null]), ['gemini-audio-future']);
});
await test('refresh uses official endpoints, active authentication and all pages', async () => {
  const calls = [];
  const discovery = new RealtimeModelDiscovery({ createVertexAuth: async () => ({ getAccessToken: async () => 'VERTEX_TEMP_TOKEN' }), invoke: async (name, args) => {
    assert.equal(name, 'http_request'); calls.push(args); const url = new URL(args.url);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      assert.deepEqual(args.headers, { 'x-goog-api-key': 'STUDIO_ONLY' });
      return response(url.searchParams.has('pageToken') ? { models: [{ name: 'models/gemini-live-test' }, { name: 'models/gemini-live-test' }] } : { models: [{ name: 'models/gemini-flash' }], nextPageToken: 'next' });
    }
    if (url.hostname === 'aiplatform.googleapis.com') { assert.deepEqual(args.headers, { Authorization: 'Bearer VERTEX_TEMP_TOKEN' }); return response({ publisherModels: [{ name: 'publishers/google/models/gemini-live-2.5-flash-native-audio' }] }); }
    if (url.hostname.endsWith('maas.aliyuncs.com')) return response({ output: { total: 2, models: [{ model: url.searchParams.get('page_no') === '1' ? 'qwen-audio-3.0-realtime-plus' : 'qwen-audio-3.0-realtime-flash' }] } });
    if (url.hostname === 'dashscope-intl.aliyuncs.com' || url.hostname === 'dashscope.aliyuncs.com') return response({ output: { total: 1, models: [{ model: 'qwen-audio-3.0-realtime-plus' }] } });
    const model = { 'api.openai.com': 'gpt-realtime-test', 'api.stepfun.com': 'stepaudio-2.5-realtime', 'api.x.ai': 'grok-voice-latest' }[url.hostname];
    assert(model); return response({ data: [{ id: model }] });
  } });
  for (const profile of [makeRealtimeProfile('openai'), makeRealtimeProfile(), vertex, { ...makeRealtimeProfile('qwen_audio_realtime'), workspaceId: 'workspace1' }, makeRealtimeProfile('qwen_audio_realtime'), { ...makeRealtimeProfile('qwen_audio_realtime'), region: 'ap-southeast-1' }, makeRealtimeProfile('step_realtime'), makeRealtimeProfile('xai_voice')]) {
    const original = structuredClone(profile), result = await discovery.list(profile, credentials); assert(result.remote && result.models.length); assert.deepEqual(profile, original);
  }
  assert.equal(calls.filter(c => c.url.includes('workspace1.')).length, 2);
  assert(calls.every(c => c.requestId && !c.url.includes('ONLY') && !c.url.includes('SECRET')));
});
await test('Nova uses SDK SigV4 for the chosen Bedrock region and temporary AWS credentials', async () => {
  const profile = makeRealtimeProfile('nova_sonic');
  const request = await buildNovaModelsRequest(profile, credentials, new Date('2026-09-06T00:00:00Z'));
  assert.equal(request.url, 'https://bedrock.us-east-1.amazonaws.com/foundation-models?byProvider=Amazon');
  assert.equal(request.headers['x-amz-security-token'], 'AWS_TEST_SESSION');
  assert.equal(request.headers['x-amz-date'], '20260906T000000Z');
  assert.match(request.headers.authorization, /Credential=AWS_TEST_ACCESS\/20260906\/us-east-1\/bedrock\/aws4_request/);
  assert.match(request.headers.authorization, /Signature=[a-f0-9]{64}$/); assert(!JSON.stringify(request).includes('AWS_TEST_SECRET'));
  const result = await new RealtimeModelDiscovery({ invoke: async (name, args) => { assert(args.headers.authorization); return response({ modelSummaries: [{ modelId: 'amazon.nova-2-sonic-v1:0' }, { modelId: 'amazon.nova-2-lite-v1:0' }] }); } }).list(profile, credentials);
  assert.deepEqual(result.models, ['amazon.nova-2-sonic-v1:0']);
});
await test('unsupported catalogs give explicit builtins; errors and empty lists do not become fake successes', async () => {
  const offline = new RealtimeModelDiscovery({ invoke: async () => { throw new Error('Should not request'); } });
  for (const profile of [makeRealtimeProfile('doubao_realtime'), { ...vertex, vertexaiAuthMode: 'express' }]) {
    const result = await offline.list(profile, {}); assert.equal(result.remote, false); assert(result.models.length && result.message);
  }
  for (const data of [null, { data: [] }, { data: [{ id: 'stepaudio-2.5-tts' }] }]) await assert.rejects(new RealtimeModelDiscovery({ invoke: async () => response(data) }).list(makeRealtimeProfile('step_realtime'), credentials), /模型/);
  await assert.rejects(new RealtimeModelDiscovery({ invoke: async () => ({ status: 401, body: 'PRIVATE_CREDENTIAL_DETAIL' }) }).list(makeRealtimeProfile('step_realtime'), credentials), error => error.message.includes('401') && !error.message.includes('PRIVATE'));
  await assert.rejects(new RealtimeModelDiscovery({ invoke: async () => response({ models: [], nextPageToken: 'repeated' }) }).list(makeRealtimeProfile(), credentials), /分页/);
  await assert.rejects(offline.list({ ...makeRealtimeProfile('qwen_audio_realtime'), workspaceId: 'bad.example/path' }, credentials), /区域/);
});
await test('cancel ends JS waiting and aborts the native catalog request', async () => {
  const controller = new AbortController(), calls = []; let started;
  const ready = new Promise(resolve => { started = resolve; });
  const discovery = new RealtimeModelDiscovery({ invoke: async (name, args) => { calls.push([name, args]); if (name === 'http_request') { started(); return new Promise(() => {}); } } });
  const rejected = assert.rejects(discovery.list(makeRealtimeProfile('xai_voice'), credentials, { signal: controller.signal }), error => error.name === 'AbortError');
  await ready; controller.abort(); await rejected;
  assert.equal(calls[1][0], 'http_abort_request'); assert.equal(calls[1][1].requestId, calls[0][1].requestId);
});
await test('manual model revisions pass through while voice and identifier validation remains', () => {
  const nova = { ...makeRealtimeProfile('nova_sonic'), model: 'amazon.nova-2-sonic-v1:1' }; validateRealtimeProfile(nova);
  const doubao = { ...makeRealtimeProfile('doubao_realtime'), model: '2.2.0.1', voice: 'saturn_zh_female_wenrouwenya_tob' }; validateRealtimeProfile(doubao);
  assert.equal(buildDoubaoSession(doubao, 'role').dialog.character_manifest, 'role');
  assert.throws(() => validateRealtimeProfile({ ...doubao, voice: 'zh_female_vv_jupiter_bigtts' }), /saturn_/);
  assert.throws(() => validateRealtimeProfile({ ...nova, model: 'amazon.nova-pro-v1:0' }), /Sonic/);
});
console.log(`realtime model discovery tests passed (${count})`);
