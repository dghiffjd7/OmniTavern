// 女仆结果卡片（计划书 Unfinished_Plans/女仆内置能力开关与实时语音对话质量设计.md 第一部分 §4）。
// 卡片种类固定，数据只来自工具的真实返回（step.output.card），APP 按种类渲染；模型只用一句话概括，不提供卡片内容。
// 例外是选项提问卡（choice，ROADMAP 29-①）与计划卡（plan，29-⑨）：内容就是女仆自己的提问或计划，来自收尾时附的
// choices／plan，由 APP 校验后生成；用户的回答或「开始做」作为下一句话送回女仆。
// 校验后只留渲染要用的字段：文字回复、语音托盘与对话历史共用这一份数据。
import { MAID_MAP_TRAVEL_MODES, cleanMaidMapPlace } from './maid-map-links.js';
import { MAID_WEATHER_DAYS } from './maid-weather.js';

export const MAID_RESULT_CARD_TYPES = Object.freeze(['random', 'map', 'weather', 'choice', 'plan']);
export const MAID_RESULT_CARD_LIMIT = 4;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

const normalizeRandomData = (data) => {
  if (data.mode === 'dice') {
    const { sides, rolls } = data;
    if (!isInt(sides, 2, 100) || !Array.isArray(rolls) || !rolls.length || rolls.length > 10 || !rolls.every(value => isInt(value, 1, sides))) return null;
    // 总和按点数重算，不信任传入值
    return { mode: 'dice', sides, rolls: rolls.slice(), total: rolls.reduce((sum, value) => sum + value, 0) };
  }
  if (data.mode !== 'draw' && data.mode !== 'choose') return null;
  const options = (Array.isArray(data.options) ? data.options : []).map(item => clean(item, 40)).filter(Boolean).slice(0, 20);
  const picked = (Array.isArray(data.picked) ? data.picked : []).map(item => clean(item, 40));
  if (options.length < 2 || !picked.length || picked.length > options.length || !picked.every(item => options.includes(item))) return null;
  if (data.mode === 'choose' && picked.length !== 1) return null;
  return { mode: data.mode, options, picked };
};

// 地图卡只存地点名与方式；网址在打开时按这些字段重新生成，不存、不信任传入的网址
const normalizeMapData = (data) => {
  if (!['google', 'amap'].includes(data.provider) || !['search', 'route'].includes(data.mode)) return null;
  if (data.mode === 'search') {
    const query = cleanMaidMapPlace(data.query);
    return query ? { provider: data.provider, mode: 'search', query } : null;
  }
  const destination = cleanMaidMapPlace(data.destination);
  if (!destination) return null;
  return {
    provider: data.provider, mode: 'route', destination,
    origin: cleanMaidMapPlace(data.origin),
    travelMode: MAID_MAP_TRAVEL_MODES.includes(data.travelMode) ? data.travelMode : '',
  };
};

// 天气卡：数字只收合理范围（缺值为 null），地名与时间只留文字
const finiteIn = (value, min, max) => (value === null || value === undefined || value === '' ? null
  : (Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : undefined));
const normalizeWeatherData = (data) => {
  const place = isPlainObject(data.place) ? data.place : {};
  const current = isPlainObject(data.current) ? data.current : {};
  const name = clean(place.name, 60);
  const temperature = finiteIn(current.temperature, -90, 70);
  const code = Number(current.code);
  if (!name || temperature === null || temperature === undefined || !isInt(code, 0, 99)) return null;
  const daily = (Array.isArray(data.daily) ? data.daily : []).slice(0, MAID_WEATHER_DAYS).map((day) => {
    const values = { max: finiteIn(day?.max, -90, 70), min: finiteIn(day?.min, -90, 70), rain: finiteIn(day?.rain, 0, 100) };
    const dayCode = Number(day?.code);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day?.date || '')) || !isInt(dayCode, 0, 99) || Object.values(values).includes(undefined)) return null;
    return { date: day.date, code: dayCode, ...values };
  });
  if (!daily.length || daily.includes(null)) return null;
  const extras = { feelsLike: finiteIn(current.feelsLike, -90, 70), humidity: finiteIn(current.humidity, 0, 100), wind: finiteIn(current.wind, 0, 500) };
  if (Object.values(extras).includes(undefined)) return null;
  return {
    place: { name, region: clean(place.region, 60), country: clean(place.country, 60) },
    timezone: clean(data.timezone, 60),
    localTime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(data.localTime || '')) ? data.localTime : '',
    fetchedAt: Number(data.fetchedAt) > 0 ? Number(data.fetchedAt) : 0,
    current: { temperature, ...extras, code, isDay: current.isDay !== false },
    daily,
  };
};

// 选项提问：1–3 题，每题 2–4 个不重复的选项（可附一句说明），可标推荐、可多选
export const MAID_CHOICE_LIMITS = Object.freeze({ questions: 3, minOptions: 2, maxOptions: 4, question: 160, label: 40, description: 100 });
const normalizeChoiceQuestion = (item) => {
  if (!isPlainObject(item)) return null;
  const question = clean(item.question, MAID_CHOICE_LIMITS.question);
  const seen = new Set();
  const options = (Array.isArray(item.options) ? item.options : [])
    .map(option => (isPlainObject(option) ? option : { label: option }))
    .map(option => ({ label: clean(option.label, MAID_CHOICE_LIMITS.label), description: clean(option.description, MAID_CHOICE_LIMITS.description) }))
    .filter(option => option.label && !seen.has(option.label) && seen.add(option.label))
    .slice(0, MAID_CHOICE_LIMITS.maxOptions);
  if (!question || options.length < MAID_CHOICE_LIMITS.minOptions) return null;
  const recommended = Number.isInteger(item.recommended) && item.recommended >= 0 && item.recommended < options.length ? item.recommended : null;
  return { question, options, recommended, multiSelect: item.multiSelect === true };
};
const normalizeChoiceData = (data) => {
  const questions = (Array.isArray(data.questions) ? data.questions : []).map(normalizeChoiceQuestion).filter(Boolean).slice(0, MAID_CHOICE_LIMITS.questions);
  return questions.length ? { title: clean(data.title, 40), questions } : null;
};

// 计划：标题、目标、步骤（1–8）、会改动什么（≤5）、开始后要用的写入工具（≤8，开始做时这些工具在本次任务内不再逐个确认）
export const MAID_PLAN_LIMITS = Object.freeze({ title: 40, goal: 200, steps: 8, step: 160, changes: 5, change: 120, tools: 8, tool: 80 });
const cleanList = (value, count, max) => (Array.isArray(value) ? value : []).map(item => clean(item, max)).filter(Boolean).slice(0, count);
const normalizePlanData = (data) => {
  const title = clean(data.title, MAID_PLAN_LIMITS.title);
  const goal = clean(data.goal, MAID_PLAN_LIMITS.goal);
  const steps = cleanList(data.steps, MAID_PLAN_LIMITS.steps, MAID_PLAN_LIMITS.step);
  if (!title || !goal || !steps.length) return null;
  const tools = [...new Set(cleanList(data.tools, MAID_PLAN_LIMITS.tools, MAID_PLAN_LIMITS.tool).filter(name => /^[a-z][\w.]*$/i.test(name)))];
  return { title, goal, steps, changes: cleanList(data.changes, MAID_PLAN_LIMITS.changes, MAID_PLAN_LIMITS.change), tools };
};

const DATA_NORMALIZERS = { random: normalizeRandomData, map: normalizeMapData, weather: normalizeWeatherData, choice: normalizeChoiceData, plan: normalizePlanData };

/** 校验一张卡：种类与数据不合规时返回 null（不显示，也不保存）。 */
export const normalizeMaidResultCard = (raw) => {
  if (!isPlainObject(raw) || !MAID_RESULT_CARD_TYPES.includes(raw.type) || !isPlainObject(raw.data)) return null;
  const data = DATA_NORMALIZERS[raw.type](raw.data);
  const id = clean(raw.id, 80);
  if (!data || !id) return null;
  return { id, type: raw.type, createdAt: Number(raw.createdAt) || 0, data };
};

export const normalizeMaidResultCards = list => (Array.isArray(list) ? list : [])
  .map(normalizeMaidResultCard).filter(Boolean).slice(-MAID_RESULT_CARD_LIMIT);

/** 本次运行产出的卡片：只取成功步骤的工具返回。 */
export const collectMaidResultCards = steps => normalizeMaidResultCards((Array.isArray(steps) ? steps : [])
  .filter(step => String(step?.status || '') === 'succeeded')
  .map(step => step?.output?.card));

/** 停下反问时附的 choices → 选项提问卡（不合规的题目丢掉，一题都不剩就不出卡，只留文字提问）。 */
export const buildMaidChoiceCard = (choices, { id = '', createdAt = Date.now() } = {}) => normalizeMaidResultCard({
  id: id || `choice_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
  type: 'choice',
  createdAt,
  data: { questions: Array.isArray(choices) ? choices : [] },
});

/**
 * 写入工具：只出现在会写入的功能里。会写入的功能也列着它要用的读取工具（如改世界书功能里的 worldbook.read），
 * 这些同时出现在只读功能里，不算写入工具。
 */
export const isCatalogWriteTool = (features = [], name = '') => {
  const list = Array.isArray(features) ? features : [];
  const has = feature => Array.isArray(feature?.tools) && feature.tools.includes(name);
  return Boolean(name) && list.some(feature => feature?.writes === true && has(feature)) && !list.some(feature => feature?.writes !== true && has(feature));
};

/**
 * 收尾交出的计划 → 计划卡。tools 只留 isWriteTool 认可的写入工具（APP 目录里的真实工具），
 * 不合规（缺标题、目标或步骤）时不出卡，只留文字。
 */
export const buildMaidPlanCard = (plan, { id = '', createdAt = Date.now(), isWriteTool = () => false } = {}) => {
  const src = isPlainObject(plan) ? plan : {};
  return normalizeMaidResultCard({
    id: id || `plan_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'plan',
    createdAt,
    data: { ...src, tools: (Array.isArray(src.tools) ? src.tools : []).filter(name => isWriteTool(String(name || '').trim())) },
  });
};

/** 一次结果的全部卡片：工具步骤的卡片，加上收尾附的选项卡或计划卡（排在最后）。文字回复区、语音托盘与对话历史都用这一份。 */
export const collectMaidResultCardsFromResult = result => normalizeMaidResultCards([
  ...collectMaidResultCards(result?.steps),
  result?.finalDecision?.choiceCard,
  result?.finalDecision?.planCard,
]);

/** 用户的回答：只有一题时就是选中的项（多选用「、」连接）；几题时每行「题目：回答」。 */
export const formatMaidChoiceAnswer = (card, picks = []) => {
  const data = normalizeMaidResultCard(card)?.data;
  if (card?.type !== 'choice' || !data) return '';
  const lines = data.questions.map((question, index) => {
    const picked = (Array.isArray(picks[index]) ? picks[index] : [picks[index]])
      .filter(at => Number.isInteger(at) && at >= 0 && at < question.options.length)
      .sort((a, b) => a - b)
      .map(at => question.options[at].label);
    return picked.length ? { question: question.question, answer: picked.join('、') } : null;
  });
  if (lines.some(line => !line)) return '';
  return lines.length === 1 ? lines[0].answer : lines.map(line => `${line.question}：${line.answer}`).join('\n');
};

/** 历史里记下交过的计划（用户下一句「开始做」时女仆据此执行）。 */
export const summarizeMaidPlanCard = (card) => {
  const data = normalizeMaidResultCard(card)?.data;
  if (card?.type !== 'plan' || !data) return '';
  return [
    `「${data.title}」${data.goal}`,
    `步骤：${data.steps.map((step, index) => `${index + 1}. ${step}`).join('；')}`,
    data.changes.length ? `会改动：${data.changes.join('；')}` : '',
    data.tools.length ? `开始后用到的写入工具：${data.tools.join('、')}` : '',
  ].filter(Boolean).join(' ｜ ');
};

/** 历史里记下给过的选项（女仆下一轮据此理解用户只回了一个选项的情况）。 */
export const summarizeMaidChoiceCard = (card) => {
  const data = normalizeMaidResultCard(card)?.data;
  if (card?.type !== 'choice' || !data) return '';
  return data.questions.map(question => `${question.question}（${question.options.map(option => option.label).join('／')}${question.multiSelect ? '，可多选' : ''}）`).join('；');
};

/** 「再来一次」按卡上的数据还原参数，产生新卡，不改旧卡。 */
export const maidRandomCardRerollArgs = (card) => {
  const data = normalizeMaidResultCard(card)?.data;
  if (!data) return null;
  if (data.mode === 'dice') return { mode: 'dice', count: data.rolls.length, sides: data.sides };
  return { mode: data.mode, options: data.options.slice(), pick: data.picked.length };
};
