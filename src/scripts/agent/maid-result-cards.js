// 女仆结果卡片（计划书 Unfinished_Plans/女仆内置能力开关与实时语音对话质量设计.md 第一部分 §4）。
// 卡片种类固定，数据只来自工具的真实返回（step.output.card），APP 按种类渲染；模型只用一句话概括，不提供卡片内容。
// 校验后只留渲染要用的字段：文字回复、语音托盘与对话历史共用这一份数据。

export const MAID_RESULT_CARD_TYPES = Object.freeze(['random']);
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

const DATA_NORMALIZERS = { random: normalizeRandomData };

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

/** 「再来一次」按卡上的数据还原参数，产生新卡，不改旧卡。 */
export const maidRandomCardRerollArgs = (card) => {
  const data = normalizeMaidResultCard(card)?.data;
  if (!data) return null;
  if (data.mode === 'dice') return { mode: 'dice', count: data.rolls.length, sides: data.sides };
  return { mode: data.mode, options: data.options.slice(), pick: data.picked.length };
};
