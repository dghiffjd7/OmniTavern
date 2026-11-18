// 女仆内置能力（计划书 Unfinished_Plans/女仆内置能力开关与实时语音对话质量设计.md 第一部分）。
// 开关在 女仆设置 → 技能 → 内置能力，默认关闭；女仆只能「请求」开启，必须经用户确认（持久开启，不给「始终允许」）。
// 能力工具在真正执行前再读一次最新开关：路由过滤只用来挑能力，不能代替执行期检查。

import { t } from '../../i18n/index.js';
import { maidRandomCardRerollArgs, normalizeMaidResultCard } from '../maid-result-cards.js';
import { MAID_MAP_PROVIDER_LABELS, MAID_MAP_TRAVEL_MODES, buildMaidMapUrl, resolveMaidMapProvider } from '../maid-map-links.js';
import { MAID_WEATHER_CITY_MAX_LENGTH, cleanMaidWeatherText, describeMaidWeatherCode, isLatinMaidWeatherQuery } from '../maid-weather.js';

const trim = value => String(value ?? '').trim();

export const MAID_BUILTIN_CAPABILITIES = Object.freeze({
  random: Object.freeze({
    id: 'random',
    title: '随机互动',
    // 技能页副标题：只写一个关键信息
    subtitle: '骰子 · 抽签 · 帮你选',
    purpose: '掷骰子、抽签、在几个选项里帮你选一个',
    network: '',
    tools: Object.freeze(['maid.random']),
  }),
  map: Object.freeze({
    id: 'map',
    title: '地图',
    subtitle: 'Google 地图 · 高德地图',
    purpose: '按地点名打开地图搜索或路线（只做跳转，不读取地图数据）',
    network: '',
    tools: Object.freeze(['maid.map']),
    // 技能页能力行下方的单项设置（值存在 maid-settings-store 的 options）
    options: Object.freeze([
      Object.freeze({ key: 'provider', label: '地图服务', choices: Object.freeze([['auto', '跟随界面语言'], ['google', 'Google 地图'], ['amap', '高德地图']]) }),
    ]),
  }),
  weather: Object.freeze({
    id: 'weather',
    title: '天气',
    subtitle: 'Open-Meteo · 联网',
    purpose: '查询城市现在的天气和未来 3 天的预报',
    network: 'Open-Meteo (open-meteo.com)',
    tools: Object.freeze(['maid.weather']),
    options: Object.freeze([
      Object.freeze({ key: 'defaultCity', label: '默认城市', type: 'text', placeholder: '没说城市时用这里，例如：台北', maxLength: MAID_WEATHER_CITY_MAX_LENGTH }),
    ]),
  }),
});

export const describeMaidBuiltinCapability = id => MAID_BUILTIN_CAPABILITIES[trim(id)] || null;

// 技能页「内置能力」分组：说明 + 设置里的开关状态
// values 是单项设置的当前值（键见 info.options）
export const listMaidBuiltinCapabilityStates = settingsStore => Object.values(MAID_BUILTIN_CAPABILITIES).map((info) => {
  const { options: values = {}, ...state } = settingsStore?.getBuiltinCapability?.(info.id) || {};
  return { ...info, enabled: false, lastUsedAt: 0, ...state, values };
});

// 均匀的随机整数 [0, max)：拒绝采样，避免取模偏差
const randomInt = (max, random = globalThis.crypto) => {
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do { random.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max;
};

const createCardId = () => globalThis.crypto?.randomUUID?.() || `card-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * 随机结果（工具与结果卡的「再来一次」共用）：
 * dice 掷 count 个 sides 面骰；draw 从 options 里不放回抽 pick 个；choose 从 options 里选 1 个。
 */
export const rollMaidRandom = ({ mode = 'dice', count = 1, sides = 6, options = [], pick = 1 } = {}, { random = globalThis.crypto } = {}) => {
  if (mode === 'dice') {
    const diceCount = Math.min(10, Math.max(1, Math.trunc(Number(count) || 1)));
    const diceSides = Math.min(100, Math.max(2, Math.trunc(Number(sides) || 6)));
    const rolls = Array.from({ length: diceCount }, () => randomInt(diceSides, random) + 1);
    return { ok: true, mode, count: diceCount, sides: diceSides, rolls, total: rolls.reduce((sum, value) => sum + value, 0) };
  }
  const choices = [...new Set((Array.isArray(options) ? options : []).map(item => trim(item).slice(0, 40)).filter(Boolean))].slice(0, 20);
  if (choices.length < 2) return { ok: false, reason: 'too_few_options', message: '至少要有两个不同的选项' };
  const wanted = mode === 'draw' ? Math.min(choices.length, Math.max(1, Math.trunc(Number(pick) || 1))) : 1;
  const pool = choices.slice();
  const picked = [];
  while (picked.length < wanted) picked.push(pool.splice(randomInt(pool.length, random), 1)[0]);
  return { ok: true, mode: mode === 'draw' ? 'draw' : 'choose', options: choices, picked };
};

// 结果卡数据只来自真实的随机结果；标题与「由 APP 随机生成」由渲染按种类给出（见 maid-result-cards.js）
export const buildMaidRandomCard = (result, { now = Date.now } = {}) => ({
  id: createCardId(),
  type: 'random',
  createdAt: now(),
  data: result.mode === 'dice'
    ? { mode: 'dice', sides: result.sides, rolls: result.rolls, total: result.total }
    : { mode: result.mode, options: result.options, picked: result.picked },
});

const capabilityOffResult = (id = 'random') => ({ ok: false, reason: 'capability_disabled', capabilityId: id, message: `「${MAID_BUILTIN_CAPABILITIES[id].title}」没有开启；需要时先用 maid.capability.request_enable 请用户开启` });
// 结果卡上的动作（再来一次、打开地图）在能力已关时给用户看的提示
const capabilityOffCardResult = id => ({ ...capabilityOffResult(id), message: t('「{name}」已关闭，可在女仆设置 → 技能重新开启', { name: t(MAID_BUILTIN_CAPABILITIES[id].title) }) });

/** 结果卡「再来一次」：和工具走同一个执行期检查（读最新开关），产生新卡，不改旧卡。 */
export const rerollMaidRandomCard = async (card, { settingsStore = null, random = globalThis.crypto, now = Date.now } = {}) => {
  if (!settingsStore?.getBuiltinCapability?.('random')?.enabled) return capabilityOffCardResult('random');
  const args = maidRandomCardRerollArgs(card);
  const result = args ? rollMaidRandom(args, { random }) : { ok: false, reason: 'invalid_card' };
  if (!result.ok) return result;
  await settingsStore.markBuiltinCapabilityUsed?.('random');
  return { ok: true, card: buildMaidRandomCard(result, { now }) };
};

// 地图卡：只存地点名与方式，网址打开时再按卡上的字段生成（见 maid-map-links.js）
export const buildMaidMapCard = ({ provider, mode, query = '', origin = '', destination = '', travelMode = '' }, { now = Date.now } = {}) => normalizeMaidResultCard({
  id: createCardId(),
  type: 'map',
  createdAt: now(),
  data: mode === 'route' ? { provider, mode, origin, destination, travelMode } : { provider, mode, query },
});

/** 结果卡「打开」：读最新开关，按卡上的字段重新生成网址，交给 openUrl（返回是否打开成功）。 */
export const openMaidMapCard = async (card, { settingsStore = null, openUrl = async () => false } = {}) => {
  if (!settingsStore?.getBuiltinCapability?.('map')?.enabled) return capabilityOffCardResult('map');
  const data = normalizeMaidResultCard(card)?.type === 'map' ? normalizeMaidResultCard(card).data : null;
  const link = data ? buildMaidMapUrl(data) : null;
  if (!link) return { ok: false, reason: 'invalid_card' };
  if (!await openUrl(link.url)) return { ok: false, reason: 'open_failed', message: t('打不开地图链接') };
  return { ok: true, url: link.url };
};

// 天气卡：地名、当地时间、当前天气与逐日预报，注明获取时间（来源 Open-Meteo 由渲染写上）
export const buildMaidWeatherCard = ({ place, forecast, fetchedAt }, { now = Date.now } = {}) => normalizeMaidResultCard({
  id: createCardId(),
  type: 'weather',
  createdAt: now(),
  data: {
    place: { name: place.name, region: place.region, country: place.country },
    timezone: forecast.timezone,
    localTime: forecast.localTime,
    fetchedAt,
    current: forecast.current,
    daily: forecast.daily,
  },
});

// 天气查询失败时给模型的说明（找不到且不是英文名：请模型改用英文名再查，见 maid-weather.js 的地名接口限制）
const WEATHER_FAILURES = Object.freeze({
  city_not_found: 'No place with that name was found; ask the user to check the city name.',
  city_not_found_local: 'No match for this name; call again with the city\'s English name (for example Taipei, Tokyo or Kaohsiung).',
  city_ambiguous: 'Several places match; ask the user which one they mean, then call again with region.',
  weather_unavailable: 'The weather service did not respond; tell the user and do not guess the weather. You may offer a web search instead.',
});

export const createMaidCapabilityAgentTools = ({
  getSettingsStore = () => null,
  getLocale = () => '',
  getWeatherService = () => null,
  random = globalThis.crypto,
  now = Date.now,
} = {}) => {
  const store = () => getSettingsStore();
  const pinnedRevisions = new WeakMap();

  const requestEnableTool = {
    name: 'maid.capability.request_enable',
    title: 'Ask the user to turn on a built-in capability',
    description: 'Ask the user to turn on a built-in Maid capability that is currently off (listed in <enableable_capabilities>). The user confirms in the APP; this persistently turns it on until they turn it off in Maid settings → Skills. Pass capabilityId and a short reason. If the user declines, do not ask again in this task.',
    source: 'maid-builtin-capability', permissions: [], riskLevel: 'medium',
    capabilities: { read: false, write: true, network: false, cost: 'none', undo: 'manual', modelContext: 'none', confirmation: 'required' },
    // 用户问「掷个骰子」属于只读请求：这里的确认就是开启确认本身，不再额外问「允许一次」
    metadata: { allowInReadOnlyIntent: true },
    schema: {
      type: 'object', additionalProperties: false, required: ['capabilityId'],
      properties: {
        capabilityId: { type: 'string', enum: Object.keys(MAID_BUILTIN_CAPABILITIES) },
        reason: { type: 'string', maxLength: 160 },
      },
    },
    safety: {
      operationType: 'enable_builtin_capability',
      destructive: 'conditional',
      description: 'Persistently turns on one built-in capability after the user confirms; writes only if the switch is unchanged since the confirmation was shown.',
      preflight: async (args = {}) => {
        const info = describeMaidBuiltinCapability(args.capabilityId);
        const current = info ? store()?.getBuiltinCapability?.(info.id) : null;
        if (!info || !current || current.enabled) return { destructive: false };
        pinnedRevisions.set(args, current.revision);
        // 确认卡上给用户看的文字按界面语言显示；拒绝后的结果是给模型看的
        const name = t(info.title);
        return {
          requiresConfirmation: true,
          kind: 'maid.capability.enable',
          operationType: 'enable_builtin_capability',
          title: t('开启「{name}」？', { name }),
          message: [
            t('开启后女仆可以直接{purpose}。', { purpose: t(info.purpose) }),
            info.network ? t('会联网到 {host}。', { host: info.network }) : '',
            t('会一直开着，可在女仆设置 → 技能随时关闭。'),
          ].filter(Boolean).join(''),
          confirmText: t('确认开启'),
          cancelText: t('不用了'),
          danger: false,
          allowAlways: false,
          argsPreview: { capabilityId: info.id, reason: trim(args.reason).slice(0, 160) },
          details: { purpose: 'persistent_enable', capabilityId: info.id, capabilityTitle: info.title, revision: current.revision },
          onDeny: {
            action: 'skip',
            reason: 'capability_enable_declined',
            result: { ok: false, enabled: false, reason: 'capability_enable_declined', capabilityId: info.id, message: `「${info.title}」这次没有开启（用户拒绝，或确认期间开关在设置里被改过）；本任务里不要再请求开启，若它已经开着可以直接用` },
          },
        };
      },
    },
    execute: async (args = {}) => {
      const info = describeMaidBuiltinCapability(args.capabilityId);
      const settings = store();
      if (!info || !settings?.setBuiltinCapabilityEnabled) return { ok: false, reason: 'unknown_capability' };
      const current = settings.getBuiltinCapability(info.id);
      if (current?.enabled) return { ok: true, enabled: true, alreadyEnabled: true, capabilityId: info.id };
      // 没经过确认（找不到确认时的版本）就不写
      if (!pinnedRevisions.has(args)) return { ok: false, reason: 'confirmation_missing', capabilityId: info.id };
      const result = await settings.setBuiltinCapabilityEnabled(info.id, true, { source: 'maid_request', expectedRevision: pinnedRevisions.get(args) });
      if (!result.ok) {
        return {
          ok: false, enabled: false, reason: result.reason, capabilityId: info.id,
          message: result.reason === 'revision_changed' ? '确认期间开关被改过，这次没有开启' : '保存失败，没有开启',
        };
      }
      return { ok: true, enabled: true, capabilityId: info.id, message: `已开启「${info.title}」` };
    },
    summarizeResult: result => (result?.ok ? `capability ${trim(result.capabilityId)} enabled` : `capability not enabled: ${trim(result?.reason)}`),
  };

  const randomTool = {
    name: 'maid.random',
    title: 'Random dice / draw / choose',
    description: 'Roll dice (mode dice: count 1-10, sides 2-100), draw lots without replacement (mode draw: options, pick), or pick one of several options (mode choose: options). The APP generates the result and shows it as a card; summarize it in one sentence without repeating every number.',
    source: 'maid-builtin-capability', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'none' },
    schema: {
      type: 'object', additionalProperties: false, required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['dice', 'draw', 'choose'] },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        sides: { type: 'integer', minimum: 2, maximum: 100 },
        options: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
        pick: { type: 'integer', minimum: 1, maximum: 5 },
      },
    },
    execute: async (args = {}) => {
      const settings = store();
      // 执行期检查：读最新开关，不信任路由时的快照
      if (!settings?.getBuiltinCapability?.('random')?.enabled) return capabilityOffResult('random');
      const result = rollMaidRandom(args, { random });
      if (!result.ok) return result;
      await settings.markBuiltinCapabilityUsed?.('random');
      return { ...result, card: buildMaidRandomCard(result, { now }) };
    },
    summarizeResult: result => (result?.ok ? `random ${trim(result.mode)}: ${result.mode === 'dice' ? result.rolls.join(',') : result.picked.join(',')}` : `random failed: ${trim(result?.reason)}`),
  };

  const mapTool = {
    name: 'maid.map',
    title: 'Open a place or directions in a map app',
    description: 'Make a card that opens a place search (mode search: query) or directions (mode route: destination, optional origin and travelMode) in the user\'s map app; the user taps Open on the card. '
      + 'Use place names, adding the city when known; leave origin empty for the user\'s current location. '
      + 'You get no map data: do not state distances, travel times, ratings or opening hours. Summarize in one sentence.',
    source: 'maid-builtin-capability', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: false, network: false, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'none' },
    schema: {
      type: 'object', additionalProperties: false, required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['search', 'route'] },
        query: { type: 'string', maxLength: 120 },
        destination: { type: 'string', maxLength: 120 },
        origin: { type: 'string', maxLength: 120 },
        travelMode: { type: 'string', enum: [...MAID_MAP_TRAVEL_MODES] },
      },
    },
    execute: async (args = {}) => {
      const settings = store();
      const capability = settings?.getBuiltinCapability?.('map');
      if (!capability?.enabled) return capabilityOffResult('map');
      const mode = args.mode === 'route' ? 'route' : 'search';
      const provider = resolveMaidMapProvider(capability.options?.provider, getLocale());
      const link = buildMaidMapUrl({ ...args, mode, provider });
      if (!link) return { ok: false, reason: 'missing_place', message: mode === 'route' ? 'destination is empty' : 'query is empty' };
      const card = buildMaidMapCard({ ...args, mode, provider }, { now });
      await settings.markBuiltinCapabilityUsed?.('map');
      return {
        ok: true, mode, provider: MAID_MAP_PROVIDER_LABELS[provider], card,
        ...(link.routeFallback ? { note: 'AMap links can only search a place, so the card opens a search for the destination; tell the user to tap Route in AMap.' } : {}),
      };
    },
    summarizeResult: result => (result?.ok ? `map ${trim(result.mode)} card (${trim(result.provider)})` : `map failed: ${trim(result?.reason)}`),
  };

  const weatherTool = {
    name: 'maid.weather',
    title: 'Current weather and 3-day forecast',
    description: 'Look up the current weather and the forecast for today and the next 3 days in a city (data from Open-Meteo). '
      + 'Pass city as the city\'s English name (for example Taipei, Tokyo, Kaohsiung): the place search matches English names reliably, and the card still shows names in the user\'s language. '
      + 'Add region (province, state, country or country code) when the user gave one or picked from options. Leave city empty to use the user\'s default city. '
      + 'The APP shows the details as a card; reply in one or two sentences with only the key numbers. If the lookup fails, say so and never guess the weather.',
    source: 'maid-builtin-capability', permissions: [], riskLevel: 'low',
    capabilities: { read: true, write: false, network: true, cost: 'none', undo: 'none', modelContext: 'none', confirmation: 'none' },
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        city: { type: 'string', maxLength: MAID_WEATHER_CITY_MAX_LENGTH, description: 'English city name, e.g. Taipei' },
        region: { type: 'string', maxLength: MAID_WEATHER_CITY_MAX_LENGTH },
      },
    },
    execute: async (args = {}) => {
      const settings = store();
      const capability = settings?.getBuiltinCapability?.('weather');
      if (!capability?.enabled) return capabilityOffResult('weather');
      const city = cleanMaidWeatherText(args.city) || cleanMaidWeatherText(capability.options?.defaultCity);
      if (!city) return { ok: false, reason: 'city_missing', message: 'No city was given and no default city is set; ask the user which city.' };
      const service = getWeatherService();
      const found = service ? await service.lookup({ city, region: cleanMaidWeatherText(args.region), locale: getLocale() }) : { ok: false, reason: 'weather_unavailable' };
      // 查询期间能力被关掉：不产出结果
      if (!settings.getBuiltinCapability?.('weather')?.enabled) return capabilityOffResult('weather');
      if (!found.ok) {
        const local = found.reason === 'city_not_found' && !isLatinMaidWeatherQuery(city);
        const usedDefault = !cleanMaidWeatherText(args.city);
        return {
          ok: false, reason: found.reason, city, ...(found.options ? { options: found.options } : {}),
          message: `${usedDefault ? `This was the user's default city "${city}". ` : ''}${WEATHER_FAILURES[local ? 'city_not_found_local' : found.reason] || WEATHER_FAILURES.weather_unavailable}`,
        };
      }
      const card = buildMaidWeatherCard(found, { now });
      if (!card) return { ok: false, reason: 'weather_unavailable', city, message: WEATHER_FAILURES.weather_unavailable };
      await settings.markBuiltinCapabilityUsed?.('weather');
      const { place, current, daily, localTime } = card.data;
      return {
        ok: true,
        place: [place.name, place.region, place.country].filter(Boolean).join(', '),
        localTime,
        current: { temperatureC: current.temperature, feelsLikeC: current.feelsLike, condition: describeMaidWeatherCode(current.code).english, humidityPercent: current.humidity, windKmh: current.wind },
        days: daily.map(day => ({ date: day.date, condition: describeMaidWeatherCode(day.code).english, minC: day.min, maxC: day.max, rainChancePercent: day.rain })),
        source: 'Open-Meteo',
        card,
      };
    },
    summarizeResult: result => (result?.ok ? `weather ${trim(result.place)}: ${result.current?.temperatureC}C ${trim(result.current?.condition)}` : `weather failed: ${trim(result?.reason)}`),
  };

  return [requestEnableTool, randomTool, mapTool, weatherTool];
};

export const registerMaidCapabilityAgentTools = (registry, deps = {}) => {
  if (!registry?.registerMany) return [];
  return registry.registerMany(createMaidCapabilityAgentTools(deps));
};
