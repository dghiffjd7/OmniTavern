import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };

const { createAgentToolRegistry } = await import('../../src/scripts/agent/agent-tool-registry.js');
const { MaidSettingsStore } = await import('../../src/scripts/storage/maid-settings-store.js');
const { createMaidCapabilityAgentTools, rollMaidRandom } = await import('../../src/scripts/agent/tools/maid-capability-tools.js');

// 可预测的随机源：依次返回给定的数
const sequence = (...values) => {
  let index = 0;
  return { getRandomValues: (buffer) => { buffer[0] = values[index++ % values.length]; return buffer; } };
};

// executeTool 返回包装：{ toolName, status, result }
const run = async (registry, name, args, context) => {
  const envelope = await registry.executeTool(name, args, context);
  return envelope?.result ? { ...envelope.result, status: envelope.status } : envelope;
};

const makeStore = async () => {
  const kv = new Map();
  const store = new MaidSettingsStore({ storage: null, loadKv: async key => kv.get(key) ?? null, saveKv: async (key, value) => { kv.set(key, value); }, now: () => 1000 });
  await store.load();
  return store;
};

{
  assert.deepEqual(rollMaidRandom({ mode: 'dice', count: 2, sides: 6 }, { random: sequence(0, 5) }).rolls, [1, 6]);
  assert.equal(rollMaidRandom({ mode: 'dice', count: 50, sides: 1 }, { random: sequence(1) }).count, 10, 'dice count and sides are clamped');
  const draw = rollMaidRandom({ mode: 'draw', options: ['甲', '乙', '丙', '乙'], pick: 2 }, { random: sequence(1, 0) });
  assert.deepEqual([draw.options, draw.picked], [['甲', '乙', '丙'], ['乙', '甲']], 'draws are without replacement over unique options');
  assert.equal(rollMaidRandom({ mode: 'choose', options: ['只有一个'] }).reason, 'too_few_options');
  let calls = 0;
  const biased = { getRandomValues: (buffer) => { buffer[0] = calls++ === 0 ? 0xffffffff : 2; return buffer; } };
  assert.deepEqual(rollMaidRandom({ mode: 'dice', sides: 6 }, { random: biased }).rolls, [3], 'values in the biased tail are rejected and redrawn');
  console.log('ok - random results are uniform, clamped and draw without replacement');
}

{
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store, random: sequence(3) }));
  const off = await run(registry, 'maid.random', { mode: 'dice' }, {});
  assert.deepEqual([off.ok, off.reason], [false, 'capability_disabled'], 'the tool rechecks the switch at execution time');

  const requests = [];
  const ask = decision => async (request) => { requests.push(request); return { decision }; };
  const declined = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random', reason: '用户想掷骰子' }, {
    operationIntentPolicy: { mode: 'read_only' }, requestToolConfirmation: ask('deny'),
  });
  assert.deepEqual([declined.ok, declined.reason, store.getBuiltinCapability('random').enabled], [false, 'capability_enable_declined', false]);
  assert.equal(requests.length, 1, 'a read-only request only asks once: the enable confirmation itself');
  assert.equal(requests[0].allowAlways, false, 'persistent enabling never offers always-allow');
  assert.equal(requests[0].details.purpose, 'persistent_enable');
  assert.match(requests[0].title, /开启「随机互动」/);

  const enabled = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    operationIntentPolicy: { mode: 'read_only' }, requestToolConfirmation: ask('allow'),
  });
  assert.deepEqual([enabled.ok, enabled.enabled, store.getBuiltinCapability('random').enabled], [true, true, true]);
  assert.deepEqual(store.getCapabilityLog().map(item => item.source), ['maid_request']);

  const rolled = await run(registry, 'maid.random', { mode: 'dice', count: 1, sides: 6 }, {});
  assert.deepEqual([rolled.ok, rolled.rolls, rolled.card.type, rolled.card.data.total], [true, [4], 'random', 4]);
  assert.ok(store.getBuiltinCapability('random').lastUsedAt > 0, 'using it records the time');

  const again = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, { requestToolConfirmation: ask('allow') });
  assert.deepEqual([again.ok, again.alreadyEnabled], [true, true]);
  assert.equal(requests.length, 2, 'an already enabled capability needs no confirmation');
  console.log('ok - enabling asks for a persistent confirmation, declines do not write, and the tool checks the live switch');
}

{
  // 确认期间用户在设置里改过开关：迟到的「允许」不写
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store }));
  const result = await run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    requestToolConfirmation: async () => {
      await store.setBuiltinCapabilityEnabled('random', true);
      await store.setBuiltinCapabilityEnabled('random', false);
      return { decision: 'allow' };
    },
  });
  assert.deepEqual([result.ok, result.reason, store.getBuiltinCapability('random').enabled], [false, 'revision_changed', false]);
  console.log('ok - a confirmation answered after the switch changed does not overwrite the user choice');
}

{
  // 路由：没开启的内置能力不进候选与完整功能表，改列进「可开启能力」；规划器把它写进随本次变化的部分
  const { createMaidCapabilityRoutingRuntime } = await import('../../src/scripts/agent/maid-capability-routing.js');
  const { buildMaidFeatureCatalogPrompt } = await import('../../src/scripts/agent/maid-model-planner.js');
  const { listAppFeatures } = await import('../../src/scripts/agent/app-feature-catalog.js');
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store }));
  const runtime = createMaidCapabilityRoutingRuntime({
    toolRegistry: registry,
    storage: null,
    isBuiltinCapabilityEnabled: id => store.getBuiltinCapability(id)?.enabled === true,
  });
  const decide = () => {
    const request = runtime.beginRequest({ input: '帮我掷两个骰子' });
    return runtime.prepareDecision({ requestId: request.id, input: '帮我掷两个骰子', phase: 'planner' });
  };
  const off = decide();
  assert.deepEqual(off.enableableCapabilities.map(item => [item.capabilityId, item.featureId]), [['random', 'maid.random'], ['map', 'maid.map'], ['weather', 'maid.weather']]);
  assert.ok(off.excluded.some(item => item.id === 'maid.random' && item.reason === 'capability_disabled'));
  assert.ok(!off.candidateFeatures.some(feature => feature.id === 'maid.random'));
  assert.ok(!off.promptFeatures.some(feature => feature.id === 'maid.random'), 'disabled capabilities are not offered as executable features');
  const prompt = buildMaidFeatureCatalogPrompt({ features: off.promptFeatures, featureIndex: listAppFeatures(), enableableCapabilities: off.enableableCapabilities });
  assert.match(prompt.detailText, /<enableable_capabilities>[\s\S]*- random：随机互动[\s\S]*maid\.capability\.request_enable/);
  assert.doesNotMatch(prompt.staticText, /enableable_capabilities/, 'the cached static prefix does not change with the switch');

  await store.setBuiltinCapabilityEnabled('random', true);
  await store.setBuiltinCapabilityEnabled('map', true);
  await store.setBuiltinCapabilityEnabled('weather', true);
  const on = decide();
  assert.deepEqual(on.enableableCapabilities, []);
  assert.ok(on.promptFeatures.some(feature => feature.id === 'maid.random'), 'the live switch is read on every decision');
  assert.doesNotMatch(buildMaidFeatureCatalogPrompt({ features: on.promptFeatures, enableableCapabilities: on.enableableCapabilities }).detailText, /enableable_capabilities/);
  // 候选模式（手机上的设定）：口语说法要靠检索进候选，否则女仆看不到工具会自己编点数
  for (const input of ['帮我掷一个六面骰子', '帮我抽个签', '抛个硬币', '随便帮我在火锅和烧烤里选一个']) {
    const request = runtime.beginRequest({ input });
    const bounded = runtime.prepareDecision({ requestId: request.id, input, phase: 'planner', configOverride: { mode: 'bounded' } });
    assert.equal(bounded.effectiveMode, 'candidate', input);
    assert.ok(bounded.candidateFeatures.some(feature => feature.id === 'maid.random'), input);
  }
  console.log('ok - routing offers disabled built-in capabilities only as enable-able, and reads the live switch');
}

{
  // 卡内确认带用途；确认等待期间开关在设置里被改过：旧确认自动取消，不写入
  const { createMaidToolConfirmationRuntime } = await import('../../src/scripts/ui/maid-tool-confirmation-runtime.js');
  const store = await makeStore();
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store }));
  const confirmations = createMaidToolConfirmationRuntime({ canShowInline: () => true });
  store.subscribeCapabilities(() => confirmations.cancelWhere(request => request?.details?.purpose === 'persistent_enable'
    && store.getBuiltinCapability(request.details.capabilityId)?.revision !== request.details.revision));
  const pending = run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    runId: 'run-1', requestToolConfirmation: (request, options) => confirmations.request(request, options),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  const inline = confirmations.getInline('run-1');
  assert.deepEqual([inline.purpose, inline.capabilityTitle, inline.confirmLabel, inline.cancelLabel, inline.allowAlways], ['persistent_enable', '随机互动', '确认开启', '不用了', false]);
  await store.setBuiltinCapabilityEnabled('random', true);
  assert.equal(confirmations.getInline('run-1'), null, 'the stale confirmation is withdrawn as soon as the switch changes');
  await store.setBuiltinCapabilityEnabled('random', false);
  const result = await pending;
  assert.deepEqual([result.ok, result.reason, store.getBuiltinCapability('random').enabled], [false, 'capability_enable_declined', false]);
  assert.deepEqual(store.getCapabilityLog().map(item => item.source), ['settings', 'settings'], 'only the user settings changes were written');

  // 无关变化（记录使用时间）不取消等待中的确认
  const next = run(registry, 'maid.capability.request_enable', { capabilityId: 'random' }, {
    runId: 'run-2', requestToolConfirmation: (request, options) => confirmations.request(request, options),
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  await store.markBuiltinCapabilityUsed('random');
  assert.ok(confirmations.getInline('run-2'), 'a change that keeps the revision does not cancel');
  confirmations.resolve(confirmations.getInline('run-2').id, 'allow_once');
  assert.deepEqual([(await next).ok, store.getBuiltinCapability('random').enabled], [true, true]);
  console.log('ok - persistent enable confirmations carry their purpose and are withdrawn when the switch changes');
}

{
  // 语音：持久开启的确认说明会一直开着，不说成“允许一次”
  const { maidTaskUpdateText, formatMaidConfirmationUpdate } = await import('../../src/scripts/ui/realtime/realtime-maid-tools.js');
  const update = { kind: 'confirmation', task_id: 't1', request: '掷骰子', message: '开启「随机互动」？', purpose: 'persistent_enable' };
  assert.match(formatMaidConfirmationUpdate(update), /"effect":"turns a built-in capability on until/);
  assert.match(maidTaskUpdateText(update), /stays on until they turn it off/);
  assert.doesNotMatch(maidTaskUpdateText(update), /allow once/);
  assert.match(maidTaskUpdateText({ kind: 'confirmation', task_id: 't1', message: '删除？' }), /to allow once/, 'ordinary confirmations keep their wording');
  assert.doesNotMatch(formatMaidConfirmationUpdate({ kind: 'confirmation', task_id: 't1' }), /effect/);
  // GPT-Live 同样要请用户说「允许」：只说「只认允许」时，模型问完会自己接「这就开始处理」
  const { createRealtimeMaidTaskSession } = await import('../../src/scripts/ui/realtime/realtime-maid-task-session.js');
  const target = { uiMode: 'maid', sessionId: 'maid', maidCallId: 'c1' };
  const sent = [];
  const live = createRealtimeMaidTaskSession({ target, live: true, getClient: () => ({ sendEvent: event => sent.push(event) }), handleTaskRequest: async () => ({ ok: true }) });
  live.notifyTaskUpdate({ ...update, target });
  live.notifyTaskUpdate({ kind: 'confirmation', task_id: 't2', message: '删除？', target });
  assert.match(sent[0].content, /stays on until they turn it off/);
  assert.match(sent[0].content, /Tell them to say "允许"/);
  assert.match(sent[1].content, /Tell them to say "允许".*to allow once/);
  live.dispose();
  console.log('ok - voice confirmation wording distinguishes persistent enabling');
}

{
  // 地图：网址只由固定格式生成；跟随界面语言时简体中文用高德；高德路线退回为搜索终点
  const { buildMaidMapUrl, resolveMaidMapProvider } = await import('../../src/scripts/agent/maid-map-links.js');
  assert.deepEqual(['zh-CN', 'zh', 'zh-Hans', 'zh-TW', 'en', 'ja', ''].map(locale => resolveMaidMapProvider('auto', locale)), ['amap', 'amap', 'amap', 'google', 'google', 'google', 'google']);
  assert.equal(resolveMaidMapProvider('google', 'zh-CN'), 'google', 'an explicit choice wins over the language');
  assert.equal(buildMaidMapUrl({ provider: 'google', mode: 'search', query: ' 台北 101\n' }).url, 'https://www.google.com/maps/search/?api=1&query=%E5%8F%B0%E5%8C%97%20101');
  assert.equal(buildMaidMapUrl({ provider: 'google', mode: 'route', destination: "Macy's (Herald Sq)", origin: '', travelMode: 'walking' }).url,
    'https://www.google.com/maps/dir/?api=1&destination=Macy%27s%20%28Herald%20Sq%29&travelmode=walking', 'quotes and brackets are encoded too');
  assert.equal(buildMaidMapUrl({ provider: 'google', mode: 'route', destination: 'B', origin: 'A', travelMode: 'teleport' }).url,
    'https://www.google.com/maps/dir/?api=1&destination=B&origin=A', 'unknown travel modes are dropped');
  const amap = buildMaidMapUrl({ provider: 'amap', mode: 'route', destination: '故宫&x=1', origin: '天安门' });
  assert.deepEqual([amap.url, amap.routeFallback], ['https://uri.amap.com/search?keyword=%E6%95%85%E5%AE%AB%26x%3D1&view=map&src=omnitavern&callnative=1', true]);
  assert.equal(buildMaidMapUrl({ provider: 'google', mode: 'search', query: '   ' }), null);

  const store = await makeStore();
  const registry = createAgentToolRegistry();
  let locale = 'zh-CN';
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store, getLocale: () => locale }));
  const off = await run(registry, 'maid.map', { mode: 'search', query: '故宫' }, {});
  assert.deepEqual([off.ok, off.reason, off.capabilityId], [false, 'capability_disabled', 'map']);
  await store.setBuiltinCapabilityEnabled('map', true);
  const found = await run(registry, 'maid.map', { mode: 'search', query: '故宫' }, {});
  assert.deepEqual([found.ok, found.provider, found.card.type, found.card.data], [true, '高德地图', 'map', { provider: 'amap', mode: 'search', query: '故宫' }]);
  assert.ok(store.getBuiltinCapability('map').lastUsedAt > 0);
  const route = await run(registry, 'maid.map', { mode: 'route', destination: '故宫', travelMode: 'transit' }, {});
  assert.match(route.note, /AMap links can only search/, 'the model is told the AMap card opens a search');
  locale = 'en';
  const google = await run(registry, 'maid.map', { mode: 'route', destination: 'Taipei 101', travelMode: 'transit' }, {});
  assert.deepEqual([google.provider, google.note, google.card.data], ['Google 地图', undefined, { provider: 'google', mode: 'route', destination: 'Taipei 101', origin: '', travelMode: 'transit' }]);
  await store.setBuiltinCapabilityOptions('map', { provider: 'amap' });
  assert.equal((await run(registry, 'maid.map', { mode: 'search', query: 'x' }, {})).card.data.provider, 'amap', 'the map service setting is read on every call');
  assert.equal((await run(registry, 'maid.map', { mode: 'route', destination: ' ' }, {})).reason, 'missing_place');

  // 结果卡「打开」：读最新开关；网址按卡上的字段重新生成
  const { openMaidMapCard } = await import('../../src/scripts/agent/tools/maid-capability-tools.js');
  const opened = [];
  const openUrl = async (url) => { opened.push(url); return true; };
  assert.deepEqual(await openMaidMapCard(google.card, { settingsStore: store, openUrl }), { ok: true, url: 'https://www.google.com/maps/dir/?api=1&destination=Taipei%20101&travelmode=transit' });
  assert.equal((await openMaidMapCard({ ...google.card, data: { ...google.card.data, url: 'https://evil.example' } }, { settingsStore: store, openUrl })).url, opened[0], 'a stored url is never used');
  assert.equal((await openMaidMapCard(google.card, { settingsStore: store, openUrl: async () => false })).reason, 'open_failed');
  await store.setBuiltinCapabilityEnabled('map', false);
  const closed = await openMaidMapCard(google.card, { settingsStore: store, openUrl });
  assert.deepEqual([closed.ok, closed.reason], [false, 'capability_disabled']);
  assert.match(closed.message, /「地图」已关闭/);
  assert.equal(opened.length, 2, 'nothing opens once the capability is off');
  console.log('ok - map links follow the language setting, encode place names and open only while the capability is on');
}

{
  // 地图服务设置：只收已知值、不动开关版本；没改过的默认值不算「有设置」
  const store = await makeStore();
  assert.deepEqual(store.getBuiltinCapability('map').options, { provider: 'auto' });
  assert.deepEqual(store.getBuiltinCapability('random').options, {});
  const saved = await store.setBuiltinCapabilityOptions('map', { provider: 'google', extra: 1 });
  assert.deepEqual([saved.ok, store.getBuiltinCapability('map').options, store.getBuiltinCapability('map').revision], [true, { provider: 'google' }, 0]);
  await store.setBuiltinCapabilityOptions('map', { provider: 'apple' });
  assert.equal(store.getBuiltinCapability('map').options.provider, 'auto', 'unknown values fall back to following the language');
  assert.equal((await store.setBuiltinCapabilityOptions('random', { x: 1 })).reason, 'unknown_capability');
  console.log('ok - capability options keep only known values and leave the switch revision alone');
}

// Open-Meteo 的假回应：地名与预报
const geocodingResults = {
  台北: [{ name: '台北', admin1: '台湾', country: '台湾', latitude: 25.05, longitude: 121.53, population: 2500000 }],
  // 中文原名常配到同名小村（人口 0）
  高雄: [{ name: '高雄', admin1: '四川', country: '中国', country_code: 'CN', latitude: 29.4, longitude: 104.9, population: 0 }],
  Springfield: [
    { id: 1, name: 'Springfield', admin1: 'Illinois', country: 'United States', latitude: 39.8, longitude: -89.64, population: 114000 },
    { id: 2, name: 'Springfield', admin1: 'Missouri', country: 'United States', latitude: 37.2, longitude: -93.29, population: 169000 },
    { id: 3, name: 'Springfield', admin1: 'Massachusetts', country: 'United States', latitude: 42.1, longitude: -72.59, population: 155000 },
  ],
};
const forecastJson = {
  timezone: 'Asia/Taipei',
  current: { time: '2026-11-02T20:00', temperature_2m: 23.4, apparent_temperature: 25.1, relative_humidity_2m: 81, weather_code: 2, wind_speed_10m: 11.6, is_day: 0 },
  daily: {
    time: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'],
    weather_code: [2, 61, 3, 0], temperature_2m_max: [26.2, 24, 23.5, 25], temperature_2m_min: [20.1, 19.6, 18.9, 19], precipitation_probability_max: [40, 85, null, 5],
  },
};
// language=zh 时省份与国家名是中文（Springfield 用来测英文地区名）
const localizedRegions = { Illinois: '伊利诺伊州', Missouri: '密苏里州', Massachusetts: '马萨诸塞州' };
const fakeWeatherHttp = (calls, { fail = false } = {}) => async ({ url }) => {
  calls.push(url);
  if (fail) throw new Error('timeout');
  if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
    const params = new URL(url).searchParams;
    const name = decodeURIComponent(params.get('name'));
    const results = (geocodingResults[name] || []).map(item => (params.get('language') === 'zh' && localizedRegions[item.admin1]
      ? { ...item, name: '斯普林菲尔德', admin1: localizedRegions[item.admin1], country: '美国', country_code: 'US' } : item));
    return { ok: true, status: 200, body: JSON.stringify(geocodingResults[name] ? { results } : {}) };
  }
  return { ok: true, status: 200, body: JSON.stringify(forecastJson) };
};

{
  // 天气服务：地名分不清时给候选、region 可筛；预报整理成卡片数据；同地点 10 分钟内重用
  const { createMaidWeatherService, pickMaidWeatherPlace, parseMaidForecast, buildMaidGeocodingUrl, resolveMaidWeatherLanguage } = await import('../../src/scripts/agent/maid-weather.js');
  assert.deepEqual(['zh-CN', 'zh-TW', 'ja', 'fr', ''].map(resolveMaidWeatherLanguage), ['zh', 'zh', 'ja', 'en', 'en']);
  assert.equal(buildMaidGeocodingUrl('São Paulo', 'en'), 'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo&count=10&language=en&format=json');
  const ambiguous = pickMaidWeatherPlace(geocodingResults.Springfield, { query: 'Springfield' });
  assert.deepEqual(ambiguous.ambiguous.map(item => item.region), ['Illinois', 'Missouri', 'Massachusetts']);
  assert.equal(pickMaidWeatherPlace(geocodingResults.Springfield, { query: 'Springfield', region: 'missouri' }).place.region, 'Missouri');
  assert.equal(pickMaidWeatherPlace([{ ...geocodingResults.Springfield[0], population: 1000000 }, geocodingResults.Springfield[1]], { query: 'Springfield' }).place.region, 'Illinois', 'a much larger place wins');
  // 中文结果里大城市有译名、小镇保留原名：不按名字是否相同来挑
  const translated = [
    { ...geocodingResults.Springfield[1], name: '斯普林菲尔德' }, { ...geocodingResults.Springfield[0], name: '斯普林菲尔德' },
    geocodingResults.Springfield[2], { ...geocodingResults.Springfield[2], id: 4, admin1: 'Tennessee', population: 16000 },
  ];
  assert.deepEqual(pickMaidWeatherPlace(translated, { query: 'Springfield' }).ambiguous.map(item => item.region), ['Missouri', 'Illinois', 'Massachusetts', 'Tennessee']);
  assert.deepEqual(pickMaidWeatherPlace([{ name: '台北市', admin1: '臺灣省 or 台灣省', country: '台湾', latitude: 25, longitude: 121, population: 7871900 }], { query: 'Taipei' }).place.region, '臺灣省', 'only the first of "A or B" names is kept');
  assert.deepEqual(pickMaidWeatherPlace([], { query: 'x' }), { notFound: true });
  assert.deepEqual(pickMaidWeatherPlace(geocodingResults.高雄, { query: '高雄' }), { notFound: true }, 'a native-name match with no population is not trusted');
  assert.equal(pickMaidWeatherPlace(geocodingResults.Springfield.map(item => ({ ...item, country_code: 'US' })), { query: 'Springfield', region: 'us' }).ambiguous, undefined, 'a country code also works as region');
  const parsed = parseMaidForecast(forecastJson);
  assert.deepEqual(parsed.current, { temperature: 23, feelsLike: 25, humidity: 81, wind: 12, code: 2, isDay: false });
  assert.deepEqual(parsed.daily[2], { date: '2026-11-04', code: 3, max: 24, min: 19, rain: null }, 'a missing rain chance stays empty, not 0');
  assert.equal(parseMaidForecast({ current: { temperature_2m: null }, daily: { time: ['2026-11-02'] } }), null);

  const calls = [];
  let clock = 1000;
  const service = createMaidWeatherService({ httpRequest: fakeWeatherHttp(calls), now: () => clock });
  const first = await service.lookup({ city: '台北', locale: 'zh-CN' });
  assert.deepEqual([first.ok, first.place.name, first.fetchedAt, calls.length], [true, '台北', 1000, 2]);
  assert.match(calls[0], /language=zh/);
  assert.match(calls[1], /latitude=25.05&longitude=121.53&current=.*forecast_days=4/);
  clock += 5 * 60 * 1000;
  assert.equal((await service.lookup({ city: '台北', locale: 'zh-CN' })).fetchedAt, 1000, 'the same place is reused within 10 minutes');
  assert.equal(calls.length, 2);
  clock += 6 * 60 * 1000;
  assert.equal((await service.lookup({ city: '台北', locale: 'zh-CN' })).fetchedAt, clock, 'older results are fetched again');
  assert.deepEqual(await service.lookup({ city: 'Springfield' }), { ok: false, reason: 'city_ambiguous', options: ambiguous.ambiguous });
  const before = calls.length;
  const english = await service.lookup({ city: 'Springfield', region: 'Missouri', locale: 'zh-CN' });
  assert.deepEqual([english.ok, english.place.name, english.place.region], [true, '斯普林菲尔德', '密苏里州'], 'an English region is matched in English, then shown with the localized names');
  assert.deepEqual(calls.slice(before, before + 2).map(url => new URL(url).searchParams.get('language')), ['zh', 'en']);
  assert.deepEqual(await service.lookup({ city: 'Nowhere' }), { ok: false, reason: 'city_not_found' });
  const broken = createMaidWeatherService({ httpRequest: fakeWeatherHttp([], { fail: true }) });
  assert.deepEqual(await broken.lookup({ city: '台北' }), { ok: false, reason: 'weather_unavailable' });
  console.log('ok - the weather service resolves cities, asks about ambiguous ones, parses the forecast and caches it');
}

{
  // 天气工具：读最新开关；没说城市用默认城市，都没有就请模型问；失败如实回报；查询期间被关掉不产出结果
  const { createMaidWeatherService } = await import('../../src/scripts/agent/maid-weather.js');
  const store = await makeStore();
  const calls = [];
  let service = createMaidWeatherService({ httpRequest: fakeWeatherHttp(calls), now: () => 5000 });
  const registry = createAgentToolRegistry();
  registry.registerMany(createMaidCapabilityAgentTools({ getSettingsStore: () => store, getLocale: () => 'zh-CN', getWeatherService: () => service, now: () => 6000 }));
  assert.equal((await run(registry, 'maid.weather', { city: '台北' }, {})).reason, 'capability_disabled');
  assert.equal(calls.length, 0, 'nothing is fetched while the capability is off');
  await store.setBuiltinCapabilityEnabled('weather', true);
  assert.equal((await run(registry, 'maid.weather', {}, {})).reason, 'city_missing');
  await store.setBuiltinCapabilityOptions('weather', { defaultCity: '高雄' });
  assert.match((await run(registry, 'maid.weather', {}, {})).message, /^This was the user's default city "高雄"\. .*English name/, 'a default city that is not found is named so the model can retry in English');
  await store.setBuiltinCapabilityOptions('weather', { defaultCity: ' 台北 ' });
  const result = await run(registry, 'maid.weather', {}, {});
  assert.deepEqual([result.ok, result.place, result.localTime, result.source], [true, '台北, 台湾, 台湾', '2026-11-02T20:00', 'Open-Meteo']);
  assert.deepEqual(result.current, { temperatureC: 23, feelsLikeC: 25, condition: 'partly cloudy', humidityPercent: 81, windKmh: 12 });
  assert.deepEqual(result.days[1], { date: '2026-11-03', condition: 'light rain', minC: 20, maxC: 24, rainChancePercent: 85 });
  assert.deepEqual([result.card.type, result.card.data.fetchedAt, result.card.data.daily.length], ['weather', 5000, 4]);
  assert.ok(store.getBuiltinCapability('weather').lastUsedAt > 0);
  const local = await run(registry, 'maid.weather', { city: '高雄' }, {});
  assert.deepEqual([local.ok, local.reason], [false, 'city_not_found']);
  assert.match(local.message, /English name/, 'a native name that finds nothing is retried in English by the model');
  assert.match((await run(registry, 'maid.weather', { city: 'Atlantis' }, {})).message, /ask the user to check/);
  const choose = await run(registry, 'maid.weather', { city: 'Springfield' }, {});
  assert.deepEqual([choose.ok, choose.reason, choose.options.length], [false, 'city_ambiguous', 3]);
  assert.match(choose.message, /ask the user which one/);
  service = createMaidWeatherService({ httpRequest: fakeWeatherHttp([], { fail: true }) });
  const failed = await run(registry, 'maid.weather', { city: '台北' }, {});
  assert.deepEqual([failed.ok, failed.reason], [false, 'weather_unavailable']);
  assert.match(failed.message, /never|do not guess/);
  service = { lookup: async () => { await store.setBuiltinCapabilityEnabled('weather', false); return { ok: true }; } };
  assert.equal((await run(registry, 'maid.weather', { city: '台北' }, {})).reason, 'capability_disabled', 'turning it off during the lookup drops the result');
  console.log('ok - the weather tool checks the switch, uses the default city and reports failures honestly');
}

{
  // 默认城市设置：压成一行、限长
  const store = await makeStore();
  assert.deepEqual(store.getBuiltinCapability('weather').options, { defaultCity: '' });
  await store.setBuiltinCapabilityOptions('weather', { defaultCity: ` 台北\n${'市'.repeat(80)} ` });
  assert.equal(store.getBuiltinCapability('weather').options.defaultCity.length, 60);
  assert.ok(!store.getBuiltinCapability('weather').options.defaultCity.includes('\n'));
  console.log('ok - the default city is kept on one line and length-limited');
}

console.log('maid-capability-tools-tests passed');
