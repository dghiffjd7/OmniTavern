// 女仆结果卡片的渲染（数据与校验见 agent/maid-result-cards.js）：按种类画，卡片数据只经 textContent 写入。
// 文字回复区、语音托盘与对话历史共用；「再来一次」「打开」等动作交给调用方，由它在执行前复核能力开关。
import { t } from '../i18n/index.js';
import { normalizeMaidResultCard } from '../agent/maid-result-cards.js';
import { MAID_MAP_PROVIDER_LABELS } from '../agent/maid-map-links.js';
import { describeMaidWeatherCode } from '../agent/maid-weather.js';

const STYLE_ID = 'maid-result-card-style';

const svg = body => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const ICONS = Object.freeze({
  dice: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3.5"/></g><g fill="currentColor"><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="12" cy="12" r="1.2"/></g>'),
  draw: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10l-1 16H8z"/><path d="M10 4V2.5M14 4V2.5"/><path d="M10 9h4"/></g>'),
  choose: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></g>'),
  reroll: svg('<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/></g>'),
  pin: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></g>'),
  route: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="18.5" r="2"/><circle cx="18" cy="5.5" r="2"/><path d="M8 18.5h7.5a3.5 3.5 0 0 0 0-7h-7a3.5 3.5 0 0 1 0-7H16"/></g>'),
  open: svg('<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></g>'),
});

// 天气图标（按 WMO 代码分组；晴天夜里画月亮）
const CLOUD = '<path d="M7 18.5h10a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.6A3.3 3.3 0 0 0 7 18.5z"/>';
const WEATHER_ICONS = Object.freeze({
  clear: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></g>'),
  night: svg('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>'),
  partly: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3v1.5M3.5 8.5H5M5 5l1 1M13 5l-1 1"/><path d="M5.6 11.3a3.5 3.5 0 1 1 6.3-3"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .3-7 4.8 4.8 0 0 0-9.2 1.3A2.9 2.9 0 0 0 9 20z"/></g>'),
  cloudy: svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">${CLOUD}</g>`),
  fog: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M6 13h12M4 17h16"/></g>'),
  drizzle: svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(0 -3)">${CLOUD}</g><path d="M8.5 19.5v.5M12 20.5v.5M15.5 19.5v.5"/></g>`),
  rain: svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(0 -3)">${CLOUD}</g><path d="M8.5 18.5l-1 2.5M12.5 18.5l-1 2.5M16.5 18.5l-1 2.5"/></g>`),
  snow: svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(0 -3)">${CLOUD}</g><path d="M8.5 19.5h.01M12 21h.01M15.5 19.5h.01"/></g>`),
  thunder: svg(`<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(0 -3)">${CLOUD}</g><path d="M12.5 15.5l-2 3.5h3l-2 3.5"/></g>`),
  drop: svg('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M12 3.5s-5.5 6-5.5 10a5.5 5.5 0 0 0 11 0c0-4-5.5-10-5.5-10z"/>'),
});
const weatherIcon = (code, isDay = true) => {
  const icon = describeMaidWeatherCode(code).icon;
  return WEATHER_ICONS[icon === 'clear' && !isDay ? 'night' : icon] || WEATHER_ICONS.cloudy;
};

// 出行方式：图标与名称（卡上只在指定了方式时显示）
const TRAVEL_MODES = Object.freeze({
  driving: { label: '开车', icon: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16v-4.5L7 6.5h10l2 5V16"/><path d="M3.5 16.5h17"/><circle cx="7.5" cy="17" r="1.6"/><circle cx="16.5" cy="17" r="1.6"/></g>') },
  walking: { label: '步行', icon: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4.5" r="1.6"/><path d="M9 21l2.5-6.5L14 17v4"/><path d="M8 11.5l3-3.5 3 2.5 3 1"/><path d="M11.5 14.5L11 8"/></g>') },
  bicycling: { label: '骑车', icon: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="16" r="3.5"/><circle cx="18" cy="16" r="3.5"/><path d="M6 16l3.5-7h5.5L18 16"/><path d="M9.5 9l2.5 7h3"/></g>') },
  transit: { label: '公共交通', icon: svg('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="3.5" width="14" height="13" rx="3"/><path d="M5 10h14"/><path d="M8.5 20.5l1.5-4M15.5 20.5l-1.5-4"/></g>') },
});

// 六面骰画点数，其他面数直接写数字
const PIPS = {
  1: [[12, 12]], 2: [[8, 8], [16, 16]], 3: [[8, 8], [12, 12], [16, 16]], 4: [[8, 8], [16, 8], [8, 16], [16, 16]],
  5: [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]], 6: [[8, 7.5], [16, 7.5], [8, 12], [16, 12], [8, 16.5], [16, 16.5]],
};

const MAID_RESULT_CARD_STYLE = `
.mrcard { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 14px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); }
.mrcard-head { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 700; }
.mrcard-icon { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: 8px; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-accent-primary, #2563eb); flex: 0 0 auto; }
.mrcard-icon svg { width: 16px; height: 16px; }
.mrcard-dice { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.mrcard-die { width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border: 2px solid var(--app-accent-primary, #2563eb); border-radius: 10px; color: var(--app-accent-primary, #2563eb); font-size: 17px; font-weight: 800; font-variant-numeric: tabular-nums; }
.mrcard-die svg { width: 30px; height: 30px; }
.mrcard-total { font-size: 13px; color: var(--app-text-secondary, #475569); }
.mrcard-total strong { color: var(--app-text-primary, #0f172a); font-size: 15px; }
.mrcard-options { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.mrcard-option { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 2px 10px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 999px; font-size: 13px; color: var(--app-text-secondary, #475569); overflow-wrap: anywhere; }
.mrcard-option.is-picked { border-color: var(--app-accent-primary, #2563eb); background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 12%, transparent); color: var(--app-text-primary, #0f172a); font-weight: 700; }
.mrcard-order { display: inline-flex; min-width: 18px; height: 18px; align-items: center; justify-content: center; border-radius: 999px; background: var(--app-accent-primary, #2563eb); color: var(--app-text-on-accent, #fff); font-size: 11px; font-weight: 800; }
.mrcard-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.mrcard-note { font-size: 11.5px; color: var(--app-text-muted, #94a3b8); }
.mrcard-action { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 10px; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 999px; background: transparent; color: var(--app-text-secondary, #475569); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; }
.mrcard-action:hover { background: var(--app-surface-hover, #f1f5f9); color: var(--app-text-primary, #0f172a); }
.mrcard-action:disabled { opacity: .5; cursor: default; }
.mrcard-action svg { width: 14px; height: 14px; }
.mrcard-questions { display: grid; gap: 12px; min-width: 0; }
.mrcard-question { display: grid; gap: 6px; min-width: 0; }
.mrcard-q { font-size: 13.5px; font-weight: 700; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.mrcard-choices { display: grid; gap: 6px; }
.mrcard-choice { display: grid; gap: 2px; min-height: 34px; padding: 7px 11px; box-sizing: border-box; border: 1px solid var(--app-border-default, #e2e8f0); border-radius: 10px; background: var(--app-surface-card, #fff); color: var(--app-text-primary, #0f172a); font: inherit; font-size: 13px; line-height: 1.45; text-align: left; overflow-wrap: anywhere; }
button.mrcard-choice { cursor: pointer; }
button.mrcard-choice:hover:not(:disabled) { border-color: var(--app-accent-primary, #2563eb); }
button.mrcard-choice:disabled { cursor: default; }
.mrcard-choice.is-selected { border-color: var(--app-accent-primary, #2563eb); background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, var(--app-surface-card, #fff)); font-weight: 700; }
.mrcard-choice small { font-size: 12px; font-weight: 400; color: var(--app-text-secondary, #475569); }
.mrcard-choice-tag { margin-left: 6px; font-size: 11px; font-weight: 700; color: var(--app-accent-primary, #2563eb); }
.mrcard.is-answered .mrcard-choice:not(.is-selected) { opacity: .55; }
.mrcard-plan { display: grid; gap: 8px; min-width: 0; }
.mrcard-plan-goal { font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; }
.mrcard-plan-steps, .mrcard-plan-changes { display: grid; gap: 4px; margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.mrcard-plan-label { font-size: 12px; font-weight: 700; color: var(--app-text-secondary, #475569); }
.mrcard-plan-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.mrcard-plan-actions .is-primary { border-color: var(--app-accent-primary, #2563eb); background: var(--app-accent-primary, #2563eb); color: var(--app-text-on-accent, #fff); }
.mrcard-plan-actions .is-primary:hover:not(:disabled) { background: var(--app-accent-primary, #2563eb); color: var(--app-text-on-accent, #fff); filter: brightness(1.05); }
.mrcard.is-answered .mrcard-plan-actions .mrcard-action:not(.is-chosen) { opacity: .45; }
.mrcard-place { margin: 0; font-size: 16px; font-weight: 800; line-height: 1.4; overflow-wrap: anywhere; }
.mrcard-route { position: relative; display: grid; gap: 8px; margin: 0; padding: 0 0 0 22px; list-style: none; }
.mrcard-route::before { content: ''; position: absolute; left: 6px; top: 10px; bottom: 10px; border-left: 2px dotted var(--app-border-strong, #cbd5e1); }
.mrcard-stop { position: relative; font-size: 14px; line-height: 1.4; overflow-wrap: anywhere; }
.mrcard-stop::before { content: ''; position: absolute; left: -22px; top: .7em; width: 14px; height: 14px; box-sizing: border-box; border: 2px solid var(--app-accent-primary, #2563eb); border-radius: 50%; background: var(--app-surface-card, #fff); transform: translateY(-50%); }
.mrcard-stop.is-end { font-size: 15px; font-weight: 800; }
.mrcard-stop.is-end::before { background: var(--app-accent-primary, #2563eb); }
.mrcard-stop.is-here { color: var(--app-text-secondary, #475569); }
.mrcard-mode { display: inline-flex; align-items: center; gap: 5px; justify-self: start; min-height: 24px; padding: 1px 10px; border-radius: 999px; background: color-mix(in srgb, var(--app-accent-primary, #2563eb) 10%, transparent); color: var(--app-accent-primary, #2563eb); font-size: 12px; font-weight: 700; }
.mrcard-mode svg { width: 14px; height: 14px; }
.mrcard-map { display: grid; gap: 8px; }
.mrcard-sub { margin-left: auto; font-size: 11.5px; font-weight: 600; color: var(--app-text-muted, #94a3b8); white-space: nowrap; }
.mrcard-weather { display: grid; gap: 10px; }
.mrcard-now { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.mrcard-now-icon { display: inline-flex; color: var(--app-accent-primary, #2563eb); }
.mrcard-now-icon svg { width: 40px; height: 40px; }
.mrcard-temp { font-size: 32px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
.mrcard-cond { display: grid; gap: 2px; min-width: 0; }
.mrcard-cond strong { font-size: 14px; }
.mrcard-meta { font-size: 12px; color: var(--app-text-secondary, #475569); }
.mrcard-days { display: grid; gap: 4px; margin: 0; padding: 8px 0 0; list-style: none; border-top: 1px solid var(--app-border-default, #e2e8f0); }
.mrcard-day { display: grid; grid-template-columns: minmax(3.4em, auto) 20px minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 26px; font-size: 13px; }
.mrcard-day-icon { display: inline-flex; color: var(--app-text-secondary, #475569); }
.mrcard-day-icon svg { width: 18px; height: 18px; }
.mrcard-day-label { font-weight: 700; }
.mrcard-day-temp { font-variant-numeric: tabular-nums; }
.mrcard-day-temp .is-min { color: var(--app-text-muted, #94a3b8); }
.mrcard-day-rain { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--app-text-secondary, #475569); font-variant-numeric: tabular-nums; }
.mrcard-day-rain svg { width: 12px; height: 12px; }
.mrcard.is-rolling .mrcard-die, .mrcard.is-rolling .mrcard-option.is-picked { animation: mrcard-roll 520ms cubic-bezier(.22, 1, .36, 1) both; }
@keyframes mrcard-roll { 0% { transform: rotate(-28deg) scale(.6); opacity: 0; } 60% { transform: rotate(8deg) scale(1.06); opacity: 1; } 100% { transform: none; } }
body[data-reduced-motion='on'] .mrcard * { animation: none !important; }
@media (prefers-reduced-motion: reduce) { .mrcard * { animation: none !important; } }
`;

export const injectMaidResultCardStyle = (documentRef) => {
  if (!documentRef?.head || documentRef.getElementById?.(STYLE_ID)) return;
  const style = documentRef.createElement?.('style');
  if (!style) return;
  style.id = STYLE_ID;
  style.textContent = MAID_RESULT_CARD_STYLE;
  documentRef.head.appendChild(style);
};

const node = (doc, tag, className = '', text = '') => {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};

const dieNode = (doc, value, sides) => {
  const die = node(doc, 'span', 'mrcard-die');
  die.setAttribute?.('aria-label', String(value));
  if (sides === 6) die.innerHTML = svg(PIPS[value].map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="1.9" fill="currentColor"/>`).join(''));
  else die.textContent = String(value);
  return die;
};

const randomTitle = data => (data.mode === 'dice'
  ? t('掷 {count} 个 {sides} 面骰', { count: data.rolls.length, sides: data.sides })
  : data.mode === 'draw' ? t('抽签') : t('帮你选'));

const renderRandomBody = (doc, data) => {
  if (data.mode === 'dice') {
    const body = node(doc, 'div', 'mrcard-body');
    const dice = node(doc, 'div', 'mrcard-dice');
    data.rolls.forEach(value => dice.appendChild(dieNode(doc, value, data.sides)));
    body.appendChild(dice);
    if (data.rolls.length > 1) {
      const total = node(doc, 'div', 'mrcard-total', `${t('合计')} `);
      total.appendChild(node(doc, 'strong', '', String(data.total)));
      body.appendChild(total);
    }
    return body;
  }
  // 候选项全部列出，抽中的高亮；抽多个时标出先后
  const list = node(doc, 'ul', 'mrcard-options');
  data.options.forEach((option) => {
    const order = data.picked.indexOf(option);
    const item = node(doc, 'li', `mrcard-option${order >= 0 ? ' is-picked' : ''}`);
    if (order >= 0 && data.picked.length > 1) item.appendChild(node(doc, 'span', 'mrcard-order', String(order + 1)));
    item.appendChild(node(doc, 'span', '', option));
    item.dataset.i18nSkip = '';
    list.appendChild(item);
  });
  return list;
};

// 地点卡写地点名；路线卡写「起点 → 终点」（没给起点就是「我的位置」）与出行方式
const renderMapBody = (doc, data) => {
  const body = node(doc, 'div', 'mrcard-map');
  if (data.mode === 'search') {
    const place = node(doc, 'p', 'mrcard-place', data.query);
    place.dataset.i18nSkip = '';
    body.appendChild(place);
    return body;
  }
  const route = node(doc, 'ol', 'mrcard-route');
  const start = node(doc, 'li', `mrcard-stop${data.origin ? '' : ' is-here'}`, data.origin || t('我的位置'));
  if (data.origin) start.dataset.i18nSkip = '';
  const end = node(doc, 'li', 'mrcard-stop is-end', data.destination);
  end.dataset.i18nSkip = '';
  route.appendChild(start);
  route.appendChild(end);
  body.appendChild(route);
  const mode = TRAVEL_MODES[data.travelMode];
  if (mode) {
    const chip = node(doc, 'span', 'mrcard-mode');
    chip.innerHTML = mode.icon;
    chip.appendChild(node(doc, 'span', '', t(mode.label)));
    body.appendChild(chip);
  }
  return body;
};

const mapProviderName = data => t(MAID_MAP_PROVIDER_LABELS[data.provider] || '');

const pad = value => String(value).padStart(2, '0');
const degrees = value => (value === null ? '–' : `${Math.round(value)}°`);
// 「YYYY-MM-DD」或「YYYY-MM-DDTHH:MM」→ 月/日
const monthDay = text => `${Number(text.slice(5, 7))}/${Number(text.slice(8, 10))}`;
const dayLabel = (date, index) => (index === 0 ? t('今天') : index === 1 ? t('明天') : monthDay(date));
// 获取时间按本机时间写；不是今天就带上日期
const formatFetchedAt = (at, now = Date.now()) => {
  const date = new Date(at);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
};
export const MAID_WEATHER_STALE_MS = 3 * 60 * 60 * 1000;

const renderWeatherBody = (doc, data) => {
  const body = node(doc, 'div', 'mrcard-weather');
  const now = node(doc, 'div', 'mrcard-now');
  const icon = node(doc, 'span', 'mrcard-now-icon');
  icon.innerHTML = weatherIcon(data.current.code, data.current.isDay);
  now.appendChild(icon);
  now.appendChild(node(doc, 'span', 'mrcard-temp', degrees(data.current.temperature)));
  const cond = node(doc, 'span', 'mrcard-cond');
  cond.appendChild(node(doc, 'strong', '', t(describeMaidWeatherCode(data.current.code).label)));
  const meta = [
    data.current.feelsLike !== null ? t('体感 {value}', { value: degrees(data.current.feelsLike) }) : '',
    data.current.humidity !== null ? t('湿度 {value}%', { value: Math.round(data.current.humidity) }) : '',
    data.current.wind !== null ? t('风 {value} km/h', { value: Math.round(data.current.wind) }) : '',
  ].filter(Boolean).join(' · ');
  if (meta) cond.appendChild(node(doc, 'span', 'mrcard-meta', meta));
  now.appendChild(cond);
  body.appendChild(now);
  const days = node(doc, 'ul', 'mrcard-days');
  data.daily.forEach((day, index) => {
    const row = node(doc, 'li', 'mrcard-day');
    row.appendChild(node(doc, 'span', 'mrcard-day-label', dayLabel(day.date, index)));
    const dayIcon = node(doc, 'span', 'mrcard-day-icon');
    dayIcon.innerHTML = weatherIcon(day.code);
    row.appendChild(dayIcon);
    const temp = node(doc, 'span', 'mrcard-day-temp');
    temp.appendChild(node(doc, 'span', 'is-min', degrees(day.min)));
    temp.appendChild(node(doc, 'span', '', ` / ${degrees(day.max)}`));
    temp.setAttribute?.('aria-label', `${t(describeMaidWeatherCode(day.code).label)} ${degrees(day.min)} / ${degrees(day.max)}`);
    row.appendChild(temp);
    const rain = node(doc, 'span', 'mrcard-day-rain');
    if (day.rain !== null) {
      rain.innerHTML = WEATHER_ICONS.drop;
      rain.appendChild(node(doc, 'span', '', `${Math.round(day.rain)}%`));
    }
    row.appendChild(rain);
    days.appendChild(row);
  });
  body.appendChild(days);
  return body;
};

const weatherNote = (data) => {
  const parts = [t('来源 Open-Meteo')];
  if (data.fetchedAt) parts.push(t('获取于 {time}', { time: formatFetchedAt(data.fetchedAt) }));
  if (data.fetchedAt && Date.now() - data.fetchedAt > MAID_WEATHER_STALE_MS) parts.push(t('可能已过时'));
  return parts.join(' · ');
};

// 选项提问：一题单选时点了就送出；几题或多选时都选好再点「发送」。回答交给调用方（onAction answer），
// 送出后整张卡锁住、留着选中的项。没有 onAction（历史里）时只显示题目与选项。
const renderChoiceBody = (doc, data, { card = null, onAction = null, root = null, foot = null } = {}) => {
  const body = node(doc, 'div', 'mrcard-questions');
  const interactive = typeof onAction === 'function';
  const picks = data.questions.map(() => new Set());
  const buttons = [];
  let sendBtn = null;
  const immediate = data.questions.length === 1 && !data.questions[0].multiSelect;
  const complete = () => picks.every(set => set.size > 0);
  const mark = () => {
    buttons.forEach(({ el, q, at }) => {
      el.classList?.toggle?.('is-selected', picks[q].has(at));
      el.setAttribute?.('aria-pressed', picks[q].has(at) ? 'true' : 'false');
    });
    if (sendBtn) sendBtn.disabled = !complete();
  };
  const send = async () => {
    if (!complete() || root?.classList?.contains?.('is-answered')) return;
    root?.classList?.add?.('is-answered');
    buttons.forEach(({ el }) => { el.disabled = true; });
    if (sendBtn) sendBtn.disabled = true;
    try {
      const outcome = await onAction({ action: 'answer', card, picks: picks.map(set => [...set]) });
      if (outcome?.answered) return;
    } catch {}
    // 没送出去：解锁，让用户再点一次
    root?.classList?.remove?.('is-answered');
    buttons.forEach(({ el }) => { el.disabled = false; });
    mark();
  };
  data.questions.forEach((question, q) => {
    const block = node(doc, 'div', 'mrcard-question');
    const asked = node(doc, 'div', 'mrcard-q', question.question);
    asked.dataset.i18nSkip = '';
    block.appendChild(asked);
    const list = node(doc, 'div', 'mrcard-choices');
    question.options.forEach((option, at) => {
      const el = node(doc, interactive ? 'button' : 'div', 'mrcard-choice');
      if (interactive) el.type = 'button';
      const label = node(doc, 'span', '', option.label);
      label.dataset.i18nSkip = '';
      if (at === question.recommended) label.appendChild(node(doc, 'span', 'mrcard-choice-tag', t('推荐')));
      el.appendChild(label);
      if (option.description) {
        const desc = node(doc, 'small', '', option.description);
        desc.dataset.i18nSkip = '';
        el.appendChild(desc);
      }
      if (interactive) {
        el.setAttribute?.('aria-pressed', 'false');
        el.addEventListener?.('click', (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          if (el.disabled) return;
          if (question.multiSelect) {
            if (picks[q].has(at)) picks[q].delete(at);
            else picks[q].add(at);
          } else {
            picks[q].clear();
            picks[q].add(at);
          }
          mark();
          if (immediate) void send();
        });
        buttons.push({ el, q, at });
      }
      list.appendChild(el);
    });
    block.appendChild(list);
    body.appendChild(block);
  });
  if (interactive && !immediate && foot) {
    sendBtn = node(doc, 'button', 'mrcard-action mrcard-send');
    sendBtn.type = 'button';
    sendBtn.dataset.action = 'answer';
    sendBtn.appendChild(node(doc, 'span', '', t('发送')));
    sendBtn.disabled = true;
    sendBtn.addEventListener?.('click', (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      void send();
    });
    foot.appendChild(sendBtn);
  }
  return body;
};

// 计划卡：目标、步骤、会改动什么；「开始做」「不做了」送出后整张卡锁住，「我想改一下」只把输入条交给用户，不锁。
// 没有 onAction（历史里）时只显示计划。
const renderPlanBody = (doc, data, { card = null, onAction = null, root = null, foot = null } = {}) => {
  const body = node(doc, 'div', 'mrcard-plan');
  const goal = node(doc, 'div', 'mrcard-plan-goal', data.goal);
  goal.dataset.i18nSkip = '';
  body.appendChild(goal);
  const steps = node(doc, 'ol', 'mrcard-plan-steps');
  data.steps.forEach((step) => {
    const item = node(doc, 'li', '', step);
    item.dataset.i18nSkip = '';
    steps.appendChild(item);
  });
  body.appendChild(steps);
  if (data.changes.length) {
    body.appendChild(node(doc, 'div', 'mrcard-plan-label', t('会改动')));
    const changes = node(doc, 'ul', 'mrcard-plan-changes');
    data.changes.forEach((change) => {
      const item = node(doc, 'li', '', change);
      item.dataset.i18nSkip = '';
      changes.appendChild(item);
    });
    body.appendChild(changes);
  }
  if (typeof onAction !== 'function' || !foot) return body;
  const actions = node(doc, 'div', 'mrcard-plan-actions');
  const buttons = [];
  const act = async (id, button) => {
    if (root?.classList?.contains?.('is-answered')) return;
    const locks = id !== 'revise';
    if (locks) {
      root?.classList?.add?.('is-answered');
      button.classList?.add?.('is-chosen');
    }
    buttons.forEach((item) => { item.disabled = true; });
    let outcome = null;
    try { outcome = await onAction({ action: id, card }); } catch {}
    if (locks && outcome?.answered) return;
    // 「我想改一下」或没送出去：解锁
    root?.classList?.remove?.('is-answered');
    button.classList?.remove?.('is-chosen');
    buttons.forEach((item) => { item.disabled = false; });
  };
  [['start', t('开始做'), 'is-primary'], ['revise', t('我想改一下'), ''], ['drop', t('不做了'), '']].forEach(([id, label, extra]) => {
    const button = node(doc, 'button', `mrcard-action${extra ? ` ${extra}` : ''}`);
    button.type = 'button';
    button.dataset.action = id;
    button.appendChild(node(doc, 'span', '', label));
    button.addEventListener?.('click', (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      void act(id, button);
    });
    buttons.push(button);
    actions.appendChild(button);
  });
  foot.appendChild(actions);
  return body;
};

// 每种卡：标题图标、标题、内容、底部说明与动作按钮
const CARD_KINDS = Object.freeze({
  random: {
    icon: data => ICONS[data.mode] || ICONS.dice,
    title: randomTitle,
    body: renderRandomBody,
    note: () => t('由 APP 随机生成'),
    action: { id: 'reroll', icon: ICONS.reroll, label: () => t('再来一次') },
  },
  map: {
    icon: data => (data.mode === 'route' ? ICONS.route : ICONS.pin),
    title: data => (data.mode === 'route' ? t('路线') : t('地点')),
    body: renderMapBody,
    // 高德网址只能搜索地点：路线卡打开的是终点搜索
    note: data => (data.provider === 'amap' && data.mode === 'route' ? t('高德只能搜索地点，到高德里再点「路线」') : t('点开后在{name}查看', { name: mapProviderName(data) })),
    action: { id: 'open', icon: ICONS.open, label: data => t('在{name}打开', { name: mapProviderName(data) }) },
  },
  weather: {
    icon: data => weatherIcon(data.current.code, data.current.isDay),
    // 省份与城市同名（直辖市等）时改写国家
    title: data => [data.place.name, data.place.region && data.place.region !== data.place.name ? data.place.region : data.place.country].filter(Boolean).join(' · '),
    // 标题右侧写当地时间（城市可能和本机不在同一时区）
    sub: data => (data.localTime ? t('当地 {time}', { time: data.localTime.slice(11, 16) }) : ''),
    body: renderWeatherBody,
    note: weatherNote,
    action: null,
  },
  plan: {
    icon: () => ICONS.route,
    title: data => data.title,
    body: renderPlanBody,
    note: data => (data.tools.length ? t('开始后，计划里写明的修改不再逐个确认') : t('看过后再开始')),
    action: null,
  },
  choice: {
    icon: () => ICONS.choose,
    title: data => data.title || (data.questions.length > 1 ? t('请帮我决定这几件事') : t('请选一个')),
    body: renderChoiceBody,
    note: () => t('也可以直接回答我'),
    action: null,
  },
});

/**
 * 画一张结果卡；数据不合规时返回 null。
 * onAction({ action: 'reroll' | 'open', card }) 返回 Promise 时，按钮在等待期间禁用。
 * 选项提问卡：onAction({ action: 'answer', card, picks })，回答送出后返回 { answered: true }；answerable: false（历史里）只显示不能点。
 * 计划卡：onAction({ action: 'start' | 'revise' | 'drop', card })，同样以 { answered: true } 表示已送出。
 */
export const renderMaidResultCard = (documentRef, rawCard, { animate = false, onAction = null, answerable = true } = {}) => {
  const card = normalizeMaidResultCard(rawCard);
  if (!card || !documentRef?.createElement) return null;
  injectMaidResultCardStyle(documentRef);
  const kind = CARD_KINDS[card.type];
  const rolling = animate && card.type === 'random';
  const root = node(documentRef, 'div', `mrcard is-${card.type}${rolling ? ' is-rolling' : ''}`);
  root.dataset.cardId = card.id;
  const head = node(documentRef, 'div', 'mrcard-head');
  const icon = node(documentRef, 'span', 'mrcard-icon');
  icon.innerHTML = kind.icon(card.data);
  head.appendChild(icon);
  const title = node(documentRef, 'span', 'mrcard-title', kind.title(card.data));
  if (card.type === 'weather' || card.type === 'plan') title.dataset.i18nSkip = ''; // 地名来自地名接口、计划标题是女仆写的，不再翻译
  head.appendChild(title);
  const sub = kind.sub?.(card.data);
  if (sub) head.appendChild(node(documentRef, 'span', 'mrcard-sub', sub));
  const foot = node(documentRef, 'div', 'mrcard-foot');
  foot.appendChild(node(documentRef, 'span', 'mrcard-note', kind.note(card.data)));
  if (typeof onAction === 'function' && kind.action) {
    const button = node(documentRef, 'button', 'mrcard-action');
    button.type = 'button';
    button.dataset.action = kind.action.id;
    button.innerHTML = kind.action.icon;
    button.appendChild(node(documentRef, 'span', '', kind.action.label(card.data)));
    button.addEventListener?.('click', async (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      if (button.disabled) return;
      button.disabled = true;
      try { await onAction({ action: kind.action.id, card }); } finally { button.disabled = false; }
    });
    foot.appendChild(button);
  }
  const bodyContext = { card, root, foot, onAction: ['choice', 'plan'].includes(card.type) && answerable !== false ? onAction : null };
  [head, kind.body(documentRef, card.data, bodyContext), foot].forEach(part => root.appendChild(part));
  if (rolling) root.addEventListener?.('animationend', () => root.classList?.remove?.('is-rolling'), { once: true });
  return root;
};
