// 女仆「地图」能力的链接（免填 Key 计划 B）：按地点名生成 Google 地图或高德地图的网址，用户点了才打开。
// 只做跳转，不读地图数据（商家、评分、路线时间都没有）。网址只由这里按固定格式生成，模型只给地点名。
// 高德的路线网址必须填终点经纬度，我们只有地点名，所以高德的「路线」退回为搜索终点，结果卡上写明。

export const MAID_MAP_PROVIDER_SETTINGS = Object.freeze(['auto', 'google', 'amap']);
export const MAID_MAP_TRAVEL_MODES = Object.freeze(['driving', 'walking', 'bicycling', 'transit']);
export const MAID_MAP_PLACE_MAX_LENGTH = 120;

export const MAID_MAP_PROVIDER_LABELS = Object.freeze({ google: 'Google 地图', amap: '高德地图' });

/** 地点名：去掉控制字符、压成一行、限长。 */
export const cleanMaidMapPlace = value => [...String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()]
  .slice(0, MAID_MAP_PLACE_MAX_LENGTH).join('').trim();

/** 设置「跟随界面语言」时：简体中文用高德，其他语言用 Google。 */
export const resolveMaidMapProvider = (setting = 'auto', locale = '') => {
  if (setting === 'google' || setting === 'amap') return setting;
  return /^zh(?:-(?:cn|hans|sg)\b|$)/i.test(String(locale || '').trim()) ? 'amap' : 'google';
};

// 连 !'()* 也编码：网址经规范化后与原样一致，Rust 端白名单按原样核对
const enc = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * 生成网址。search 用 query；route 用 destination（origin 可空，空时 Google 用当前位置）。
 * 返回 { url, provider, routeFallback }；地点为空返回 null。
 */
export const buildMaidMapUrl = ({ provider = 'google', mode = 'search', query = '', origin = '', destination = '', travelMode = '' } = {}) => {
  const route = mode === 'route';
  const target = cleanMaidMapPlace(route ? destination : query);
  if (!target) return null;
  if (provider === 'amap') {
    return { url: `https://uri.amap.com/search?keyword=${enc(target)}&view=map&src=omnitavern&callnative=1`, provider: 'amap', routeFallback: route };
  }
  if (!route) return { url: `https://www.google.com/maps/search/?api=1&query=${enc(target)}`, provider: 'google', routeFallback: false };
  const from = cleanMaidMapPlace(origin);
  const params = [`destination=${enc(target)}`];
  if (from) params.push(`origin=${enc(from)}`);
  if (MAID_MAP_TRAVEL_MODES.includes(travelMode)) params.push(`travelmode=${travelMode}`);
  return { url: `https://www.google.com/maps/dir/?api=1&${params.join('&')}`, provider: 'google', routeFallback: false };
};
