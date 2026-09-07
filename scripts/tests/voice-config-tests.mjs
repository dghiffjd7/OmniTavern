import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(String(key)) || null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: key => storage.delete(String(key)),
};
globalThis.__TAURI__ = {
  core: {
    invoke: async command => (command === 'save_kv' ? true : null),
  },
};

const {
  getVoiceConfigScope,
  getVoiceProviderDefaults,
  getVoiceProviderOptions,
  normalizeVoiceCapability,
  normalizeVoiceConnectionMode,
} = await import('../../src/scripts/ui/voice-config-utils.js');
const { ConfigManager } = await import('../../src/scripts/storage/config.js');
const { appSettings } = await import('../../src/scripts/storage/app-settings.js');

test('voice connection mode keeps shared credentials separate from TTS/STT models', () => {
  assert.equal(normalizeVoiceConnectionMode('shared'), 'shared');
  assert.equal(normalizeVoiceConnectionMode('split'), 'split');
  assert.equal(normalizeVoiceConnectionMode('unexpected'), 'shared');
  assert.equal(normalizeVoiceCapability('stt'), 'stt');
  assert.equal(normalizeVoiceCapability('unexpected'), 'tts');

  assert.equal(getVoiceConfigScope({ mode: 'shared', capability: 'stt' }), 'voice_shared');
  assert.equal(getVoiceConfigScope({ mode: 'split', capability: 'tts' }), 'voice_tts');
  assert.equal(getVoiceConfigScope({ mode: 'split', capability: 'stt' }), 'voice_stt');

  const defaults = getVoiceProviderDefaults('openai');
  assert.equal(defaults.baseUrl, 'https://api.openai.com/v1');
  assert.equal(defaults.ttsModel, 'gpt-4o-mini-tts');
  assert.equal(defaults.sttModel, 'gpt-transcribe');
  assert.equal(defaults.ttsVoice, 'marin');

  const qwenDefaults = getVoiceProviderDefaults('qwen_local');
  assert.equal(qwenDefaults.baseUrl, 'http://127.0.0.1:8765/v1');
  assert.equal(qwenDefaults.ttsModel, 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice');
  assert.equal(qwenDefaults.sttModel, 'Qwen/Qwen3-ASR-0.6B');
  assert.equal(qwenDefaults.ttsVoice, 'Serena');
});

test('shared mode only lists providers that can serve both voice capabilities', () => {
  const shared = getVoiceProviderOptions({ mode: 'shared' });
  assert.equal(shared.some(item => item.value === 'openai' && item.capabilities.includes('tts') && item.capabilities.includes('stt')), true);
  assert.equal(shared.some(item => item.value === 'elevenlabs' && item.capabilities.includes('tts') && item.capabilities.includes('stt')), true);
  assert.equal(shared.some(item => item.value === 'qwen_local' && item.capabilities.includes('tts') && item.capabilities.includes('stt')), true);
  assert.equal(shared.every(item => item.capabilities.includes('tts') && item.capabilities.includes('stt')), true);

  const splitTts = getVoiceProviderOptions({ mode: 'split', capability: 'tts' });
  const splitStt = getVoiceProviderOptions({ mode: 'split', capability: 'stt' });
  assert.equal(splitTts.every(item => item.capabilities.includes('tts')), true);
  assert.equal(splitStt.every(item => item.capabilities.includes('stt')), true);
  assert.equal(splitTts.some(item => item.value === 'groq'), false);
  assert.equal(splitStt.some(item => item.value === 'groq'), true);
  assert.equal(shared.some(item => item.value === 'groq'), false);
});

test('voice profile scopes persist shared and split configurations independently', async () => {
  const shared = new ConfigManager({ scope: 'voice_shared' });
  const tts = new ConfigManager({ scope: 'voice_tts' });
  const stt = new ConfigManager({ scope: 'voice_stt' });

  await shared.load();
  await tts.load();
  await stt.load();
  assert.equal(shared.get().ttsModel, 'gpt-4o-mini-tts');
  assert.equal(shared.get().sttModel, 'gpt-transcribe');
  assert.equal(shared.get().sttLanguage, '');
  assert.equal(shared.get().ttsVoice, 'marin');
  assert.equal(tts.get().model, 'gpt-4o-mini-tts');
  assert.equal(tts.get().ttsVoice, 'marin');
  assert.equal(stt.get().model, 'gpt-transcribe');
  assert.equal(stt.get().sttLanguage, '');

  await shared.save({
    ...shared.get(),
    provider: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'eleven_flash_v2_5',
    ttsModel: 'eleven_flash_v2_5',
    sttModel: 'scribe_v2',
    sttLanguage: 'zh,en',
    ttsVoice: 'JBFqnCBsd6RMkjVDRZzb',
  });
  await tts.save({
    ...tts.get(),
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'tts-1-hd',
    ttsVoice: 'cedar',
  });
  await stt.save({
    ...stt.get(),
    provider: 'custom',
    baseUrl: 'https://voice.example.test/v1',
    model: 'custom-transcriber',
    sttLanguage: 'ja',
  });

  const reloadedShared = await new ConfigManager({ scope: 'voice_shared' }).load();
  const reloadedTts = await new ConfigManager({ scope: 'voice_tts' }).load();
  const reloadedStt = await new ConfigManager({ scope: 'voice_stt' }).load();
  assert.equal(reloadedShared.provider, 'elevenlabs');
  assert.equal(reloadedShared.ttsModel, 'eleven_flash_v2_5');
  assert.equal(reloadedShared.sttModel, 'scribe_v2');
  assert.equal(reloadedShared.sttLanguage, 'zh,en');
  assert.equal(reloadedShared.ttsVoice, 'JBFqnCBsd6RMkjVDRZzb');
  assert.equal(reloadedTts.model, 'tts-1-hd');
  assert.equal(reloadedTts.ttsVoice, 'cedar');
  assert.equal(reloadedStt.model, 'custom-transcriber');
  assert.equal(reloadedStt.sttLanguage, 'ja');
});

test('voice profile validation rejects a half-configured shared provider', () => {
  const shared = new ConfigManager({ scope: 'voice_shared' });
  assert.throws(() => shared.validate({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    ttsModel: 'gpt-4o-mini-tts',
    sttModel: '',
    ttsVoice: 'marin',
  }), /sttModel/);

  assert.throws(() => shared.validate({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    ttsModel: 'gpt-4o-mini-tts',
    sttModel: 'gpt-4o-mini-transcribe',
    ttsVoice: '',
  }), /ttsVoice/);

  const chat = new ConfigManager();
  assert.throws(() => chat.validate({
    provider: 'elevenlabs',
    baseUrl: 'https://api.elevenlabs.io/v1',
    model: 'eleven_flash_v2_5',
  }), /无效的 provider/);
});

test('current OpenAI transcription model is preserved on profile load', async () => {
  const profileId = 'current-openai-stt';
  storage.set('llm_profiles_voice_stt_v1', JSON.stringify({
    activeProfileId: profileId,
    savedAt: Date.now(),
    profiles: {
      [profileId]: {
        id: profileId,
        name: '当前语音配置',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-transcribe',
      },
    },
  }));

  const config = await new ConfigManager({ scope: 'voice_stt' }).load();
  assert.equal(config.model, 'gpt-transcribe');
});

test('voice connection mode is a normalized app setting', () => {
  appSettings.update({ voiceConnectionMode: 'split' });
  assert.equal(appSettings.get().voiceConnectionMode, 'split');
  appSettings.update({ voiceConnectionMode: 'invalid' });
  assert.equal(appSettings.get().voiceConnectionMode, 'shared');
});

test('realtime is an independent config view and does not overwrite TTS/STT routing', async () => {
  appSettings.update({ voiceConnectionMode: 'shared' });
  const { ConfigPanel } = await import('../../src/scripts/ui/config-panel.js');
  const panel = new ConfigPanel();

  await panel.setVoiceConfigView('realtime');

  assert.equal(panel.voiceConfigView, 'realtime');
  assert.equal(panel.voiceConnectionMode, 'shared');
  assert.equal(appSettings.get().voiceConnectionMode, 'shared');
});

test('API settings expose independent shared, split, and realtime voice views', async () => {
  const source = await readFile('src/scripts/ui/config-panel.js', 'utf8');
  assert.match(source, /data-tab="voice"/);
  assert.match(source, /data-voice-connection-mode="shared"/);
  assert.match(source, /data-voice-connection-mode="split"/);
  assert.match(source, /data-voice-config-view="realtime"/);
  assert.match(source, /id="config-voice-tts-model"/);
  assert.match(source, /id="config-voice-stt-model"/);
  assert.match(source, /<select id="config-voice-stt-language" style="display:none;">/);
  assert.match(source, /id="config-voice-stt-language-btn"[^>]+data-select-id="config-voice-stt-language"/);
  assert.match(source, /中文 \+ 英文/);
  assert.match(source, /id="refresh-voice-tts-models"/);
  assert.match(source, /id="refresh-voice-stt-models"/);
  assert.match(source, /id="voice-tts-model-options"/);
  assert.match(source, /id="voice-stt-model-options"/);
  assert.match(source, /<input[^>]+id="config-realtime-model"/);
  assert.match(source, /<input[^>]+id="config-realtime-transcription-model"/);
  assert.match(source, /id="realtime-model-options"/);
  assert.match(source, /id="realtime-transcription-model-options"/);
  assert.match(source, /id="refresh-realtime-models"/);
  assert.match(source, /id="refresh-realtime-transcription-models"/);
  assert.match(source, /<select id="config-realtime-transcription-language" style="display:none;">/);
  assert.match(source, /id="config-realtime-transcription-language-btn"[^>]+data-select-id="config-realtime-transcription-language"/);
  assert.doesNotMatch(source, /<select[^>]+id="config-realtime-(?:transcription-)?model"/);
  assert.match(source, /new VoiceClient/);
  assert.match(source, /id="config-voice-tts-voice"/);
  assert.match(source, /data-voice-preset/);
  assert.doesNotMatch(source, /<datalist/i);
  assert.match(source, /AI 合成语音/);
  assert.match(source, /NO_API_KEY_PROVIDERS[^;]+qwen_local/s);
  assert.match(source, /usesEditableBaseUrl[\s\S]+qwen_local/);
});

test('voice connection test checks both shared capabilities without running inference', async () => {
  const { ConfigPanel } = await import('../../src/scripts/ui/config-panel.js');
  const originalInvoke = globalThis.__TAURI__.core.invoke;
  const requests = [];
  globalThis.__TAURI__.core.invoke = async (command, args) => {
    if (command !== 'http_request') return null;
    requests.push(args);
    return {
      status: 200,
      ok: true,
      body: JSON.stringify({
        data: [
          { id: 'gpt-4o-mini-tts' },
          { id: 'gpt-transcribe' },
        ],
      }),
    };
  };

  try {
    const statuses = [];
    const panel = new ConfigPanel();
    panel.activeTab = 'voice';
    panel.voiceConnectionMode = 'shared';
    panel.configManager = {
      validate() {},
      load: async () => ({ apiKey: 'stored-key' }),
    };
    panel.testButton = { disabled: false, innerHTML: '' };
    panel.getFormData = () => ({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini-tts',
      ttsModel: 'gpt-4o-mini-tts',
      sttModel: 'gpt-transcribe',
      ttsVoice: 'marin',
    });
    panel.showStatus = (message, level) => statuses.push({ message, level });

    await panel.onTest();

    assert.equal(requests.length, 2);
    assert.equal(requests.every(request => request.method === 'GET' && /\/models$/.test(request.url)), true);
    assert.deepEqual(statuses.at(-1), {
      message: '连接成功：TTS 1 个模型，STT 1 个模型',
      level: 'success',
    });
  } finally {
    globalThis.__TAURI__.core.invoke = originalInvoke;
  }
});

test('chat runtime wires microphone, assistant speech, and Android recording permission', async () => {
  const [appSource, html, manifest] = await Promise.all([
    readFile('src/scripts/ui/app.js', 'utf8'),
    readFile('src/index.html', 'utf8'),
    readFile('src-tauri/gen/android/app/src/main/AndroidManifest.xml', 'utf8'),
  ]);
  assert.match(appSource, /createChatVoiceRuntime\s*\(/);
  assert.match(appSource, /action === 'speak'/);
  assert.match(appSource, /await chatVoiceRuntime\.cancel\(\)/);
  assert.match(html, /id="voice-input-button"/);
  assert.match(manifest, /android\.permission\.RECORD_AUDIO/);
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
});

test('realtime commit helpers never return null after persisting a message', async () => {
  const appSource = await readFile('src/scripts/ui/app.js', 'utf8');
  for (const name of ['commitRealtimeUserMessage', 'commitRealtimeAssistantMessage']) {
    const start = appSource.indexOf(`const ${name} = async`);
    assert.ok(start >= 0, `${name} 必须存在`);
    const appendIndex = appSource.indexOf('chatStore.appendMessage', start);
    const returnIndex = appSource.indexOf('return { messageId', start);
    assert.ok(appendIndex > start && returnIndex > appendIndex, `${name} 必须持久化并返回 messageId`);
    const beforeAppend = appSource.slice(start, appendIndex);
    assert.match(beforeAppend, /isRealtimeCallTargetCurrent\(target\)/, `${name} 持久化前必须复核 target`);
    const afterAppend = appSource.slice(appendIndex, returnIndex);
    assert.ok(!afterAppend.includes('return null'), `${name} 持久化后不得返回 null（消息已落库必须回传 id 并完成 UI 同步）`);
  }
});

let failed = 0;
for (const current of tests) {
  try {
    await current.fn();
    console.log(`ok - ${current.name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${current.name}`);
    console.error(error);
  }
}

if (failed > 0) process.exit(1);
