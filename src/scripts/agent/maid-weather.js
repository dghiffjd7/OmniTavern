// 女仆「天气」能力（免填 Key 计划 C）：Open-Meteo 免费接口（非商业、免 key、CC BY 4.0，结果卡注明来源）。
// 城市名 → 地名接口取坐标（同名地点分不清时让女仆问用户）→ 预报接口取当前天气与未来 3 天。
// 网络请求由调用方注入（APP 里走 Rust public_http_request）；同一地点 10 分钟内重用结果。
// 地名接口的限制（11-02 实测）：只按 language 那种语言的地名匹配；两个字的查询只做精确匹配（「台北」对不上「台北市」），
// 中日韩原名还常配到同名小村（「高雄」→ 四川的村子）。英文名最可靠（Taipei 配 language=zh 回「台北市」），所以工具请模型传英文名。

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const MAID_WEATHER_CACHE_MS = 10 * 60 * 1000;
export const MAID_WEATHER_DAYS = 4; // 今天＋未来 3 天
export const MAID_WEATHER_CITY_MAX_LENGTH = 60;

const trim = value => String(value ?? '').trim();
export const cleanMaidWeatherText = (value, max = MAID_WEATHER_CITY_MAX_LENGTH) => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()]
  .slice(0, max).join('').trim();

// WMO 天气代码：卡片文字（中文原文，渲染时翻译）、给模型的英文描述、图标
const CODE_GROUPS = [
  [[0], '晴', 'clear', 'clear'],
  [[1], '大致晴朗', 'mainly clear', 'partly'],
  [[2], '多云', 'partly cloudy', 'partly'],
  [[3], '阴', 'overcast', 'cloudy'],
  [[45, 48], '雾', 'fog', 'fog'],
  [[51, 53, 55, 56, 57], '毛毛雨', 'drizzle', 'drizzle'],
  [[61], '小雨', 'light rain', 'rain'],
  [[63], '中雨', 'rain', 'rain'],
  [[65], '大雨', 'heavy rain', 'rain'],
  [[66, 67], '冻雨', 'freezing rain', 'rain'],
  [[71, 73, 75, 77], '雪', 'snow', 'snow'],
  [[80, 81, 82], '阵雨', 'rain showers', 'rain'],
  [[85, 86], '阵雪', 'snow showers', 'snow'],
  [[95], '雷雨', 'thunderstorm', 'thunder'],
  [[96, 99], '雷雨伴冰雹', 'thunderstorm with hail', 'thunder'],
];
const CODE_TABLE = new Map(CODE_GROUPS.flatMap(([codes, label, english, icon]) => codes.map(code => [code, { label, english, icon }])));
export const describeMaidWeatherCode = code => CODE_TABLE.get(Number(code)) || { label: '未知', english: 'unknown', icon: 'cloudy' };

/** 界面语言 → 地名接口的 language（只影响返回的地名写法）。 */
export const resolveMaidWeatherLanguage = (locale = '') => {
  const value = trim(locale).toLowerCase();
  if (value.startsWith('zh')) return 'zh';
  return ['en', 'ja', 'ko'].find(code => value.startsWith(code)) || 'en';
};

export const buildMaidGeocodingUrl = (name, language = 'en') => `${GEOCODING_URL}?name=${encodeURIComponent(name)}&count=10&language=${encodeURIComponent(language)}&format=json`;

export const buildMaidForecastUrl = ({ latitude, longitude }) => `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}`
  + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day'
  + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${MAID_WEATHER_DAYS}`;

export const isLatinMaidWeatherQuery = value => /^[\x20-\x7e]+$/.test(trim(value));

// 地名资料偶有「A or B」两种写法并列（如「臺灣省 or 台灣省」），只取第一种
const firstVariant = value => cleanMaidWeatherText(String(value ?? '').split(/\s+or\s+/)[0], 60);

const placeOf = item => ({
  id: Number(item?.id) || 0,
  name: firstVariant(item?.name),
  region: firstVariant(item?.admin1),
  country: cleanMaidWeatherText(item?.country, 60),
  countryCode: cleanMaidWeatherText(item?.country_code, 4),
  latitude: Number(item?.latitude),
  longitude: Number(item?.longitude),
  population: Number(item?.population) || 0,
});
const placeKey = place => `${place.region}|${place.country}`.toLowerCase();

/**
 * 从地名结果里挑一个：region（省／州／国家或国家代码）有给就先按它筛；同名的地点在不同地区、且人口差不多时算分不清，
 * 返回 { ambiguous: [...] } 让女仆问用户；没有结果返回 { notFound: true }。非拉丁字母的查询只认有人口数据的地点（免得配到同名小村）。
 */
export const pickMaidWeatherPlace = (results = [], { query = '', region = '' } = {}) => {
  let places = (Array.isArray(results) ? results : []).map(placeOf)
    .filter(place => place.name && Number.isFinite(place.latitude) && Number.isFinite(place.longitude));
  if (!isLatinMaidWeatherQuery(query)) places = places.filter(place => place.population > 0);
  const hint = trim(region).toLowerCase();
  if (hint) places = places.filter(place => `${place.region} ${place.country}`.toLowerCase().includes(hint) || place.countryCode.toLowerCase() === hint);
  if (!places.length) return { notFound: true };
  if (hint) return { place: places[0] };
  // 只看前两名的人口差距：界面语言的结果里大城市有译名、小镇保留原名，按名字是否完全相同来挑会挑错
  const [first, second] = places;
  const distinct = [...new Map(places.map(place => [placeKey(place), place])).values()];
  if (second && distinct.length > 1 && first.population < second.population * 5) {
    return { ambiguous: distinct.slice(0, 4).map(({ name: placeName, region: placeRegion, country }) => ({ name: placeName, region: placeRegion, country })) };
  }
  return { place: first };
};

// 缺值（null、空字串）保持 null，免得显示成 0
const num = (value, digits = 0) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(digits)) : null);

/** 预报回应 → 卡片要的精简数据（不合格返回 null）。 */
export const parseMaidForecast = (json = {}) => {
  const current = json?.current || {};
  const daily = json?.daily || {};
  const dates = Array.isArray(daily.time) ? daily.time : [];
  if (num(current.temperature_2m) === null || !dates.length) return null;
  return {
    timezone: cleanMaidWeatherText(json.timezone, 60),
    localTime: cleanMaidWeatherText(current.time, 20),
    current: {
      temperature: num(current.temperature_2m),
      feelsLike: num(current.apparent_temperature),
      humidity: num(current.relative_humidity_2m),
      wind: num(current.wind_speed_10m),
      code: Number(current.weather_code) || 0,
      isDay: Number(current.is_day) !== 0,
    },
    daily: dates.slice(0, MAID_WEATHER_DAYS).map((date, index) => ({
      date: cleanMaidWeatherText(date, 10),
      code: Number(daily.weather_code?.[index]) || 0,
      max: num(daily.temperature_2m_max?.[index]),
      min: num(daily.temperature_2m_min?.[index]),
      rain: num(daily.precipitation_probability_max?.[index]),
    })),
  };
};

const readJson = async (httpRequest, url) => {
  const response = await httpRequest({ url, method: 'GET', headers: { Accept: 'application/json' }, body: null, timeoutMs: 10000, maxResponseBytes: 200000 });
  if (!response?.ok) throw new Error(`http_${response?.status || 0}`);
  return JSON.parse(String(response.body || ''));
};

/**
 * 查询服务：lookup({ city, region, locale }) →
 * { ok: true, place, forecast, fetchedAt } | { ok: false, reason: 'city_not_found' | 'city_ambiguous' | 'weather_unavailable', options? }
 */
export const createMaidWeatherService = ({ httpRequest, now = Date.now, cacheMs = MAID_WEATHER_CACHE_MS } = {}) => {
  const forecasts = new Map();
  const places = new Map();
  const lookup = async ({ city = '', region = '', locale = '' } = {}) => {
    const query = cleanMaidWeatherText(city);
    const language = resolveMaidWeatherLanguage(locale);
    const placeCacheKey = `${language}|${query.toLowerCase()}|${trim(region).toLowerCase()}`;
    let picked = places.get(placeCacheKey);
    const geocode = async lang => (await readJson(httpRequest, buildMaidGeocodingUrl(query, lang)))?.results || [];
    try {
      if (!picked) {
        const results = await geocode(language);
        picked = pickMaidWeatherPlace(results, { query, region });
        // 地区可能写成英文，而结果的省份与国家名是界面语言：改用英文结果再筛一次，找到后按 id 换回界面语言的地名
        if (picked.notFound && trim(region) && results.length && language !== 'en') {
          picked = pickMaidWeatherPlace(await geocode('en'), { query, region });
          const localized = picked.place?.id ? results.find(item => Number(item?.id) === picked.place.id) : null;
          if (localized) picked = { place: { ...placeOf(localized), latitude: picked.place.latitude, longitude: picked.place.longitude } };
        }
        if (picked.place) places.set(placeCacheKey, picked);
      }
      if (picked.notFound) return { ok: false, reason: 'city_not_found' };
      if (picked.ambiguous) return { ok: false, reason: 'city_ambiguous', options: picked.ambiguous };
      const { place } = picked;
      const key = `${place.latitude.toFixed(2)},${place.longitude.toFixed(2)}`;
      const cached = forecasts.get(key);
      if (cached && now() - cached.fetchedAt < cacheMs) return { ok: true, place, ...cached };
      const forecast = parseMaidForecast(await readJson(httpRequest, buildMaidForecastUrl(place)));
      if (!forecast) return { ok: false, reason: 'weather_unavailable' };
      const entry = { forecast, fetchedAt: now() };
      forecasts.set(key, entry);
      return { ok: true, place, ...entry };
    } catch {
      return { ok: false, reason: 'weather_unavailable' };
    }
  };
  return { lookup };
};
