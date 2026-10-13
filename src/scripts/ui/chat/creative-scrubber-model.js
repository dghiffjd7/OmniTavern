// 创意写作刻度导航的纯逻辑：刻度排列、按住展开的取样、预览文字裁剪。
// 条号从 1 开始，对应当前存档里的第几条消息。

export const SCRUBBER_SLOTS = 10;
export const SCRUBBER_WINDOW = 8;

const tick = (i, extra = {}) => ({ t: 'tick', i, ...extra });
const gap = (from, to, extra = {}) => ({ t: 'gap', from, to, ...extra });

// 平时 10 个位置：首尾固定，中间 8 个连续跟随阅读位置；窗口碰到首尾时与之合并。
export const buildFollowItems = (center, total) => {
  const N = Math.max(0, Math.floor(Number(total) || 0));
  if (N <= SCRUBBER_SLOTS) return Array.from({ length: N }, (_, k) => tick(k + 1));
  const c = Math.max(1, Math.min(N, Math.floor(Number(center) || N)));
  const start = Math.max(2, Math.min(c - 3, N - SCRUBBER_WINDOW));
  const items = [tick(1)];
  if (start === 2) {
    for (let i = 2; i <= 9; i += 1) items.push(tick(i));
    items.push(gap(10, N - 1), tick(N));
    return items;
  }
  if (start >= N - SCRUBBER_WINDOW) {
    items.push(gap(2, N - 9));
    for (let i = N - 8; i <= N; i += 1) items.push(tick(i));
    return items;
  }
  items.push(gap(2, start - 1));
  for (let i = start; i < start + SCRUBBER_WINDOW; i += 1) items.push(tick(i));
  items.push(gap(start + SCRUBBER_WINDOW, N - 1), tick(N));
  return items;
};

const isNearTop = ({ from, to }, current) => Math.abs(current - from) <= Math.abs(current - to);

// 按住展开：靠近阅读位置的一端连续 3 条，越远间隔越大；远端留 2 条连续接上边界。
export const buildExpansionSamples = (range, current) => {
  const from = Math.floor(Number(range?.from)), to = Math.floor(Number(range?.to));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  const size = to - from + 1;
  if (size <= SCRUBBER_SLOTS) return Array.from({ length: size }, (_, k) => from + k);
  const nearTop = isNearTop({ from, to }, Number(current) || 0);
  const span = size - 6;
  const dists = [0, 1, 2];
  for (let k = 1; k <= 6; k += 1) dists.push(3 + Math.round(span * Math.pow(k / 7, 2.4)));
  const out = new Set(dists.map(d => (nearTop ? from + d : to - d)));
  out.add(nearTop ? to - 1 : from + 1);
  out.add(nearTop ? to : from);
  return [...out].filter(i => i >= from && i <= to).sort((a, b) => a - b);
};

// 展开后的刻度：保留首尾和区间两侧的邻居，样本之间留省略号可继续展开。
// enter/order 供界面做「从小点处依次长出」的动画，顺序从靠近阅读位置的一侧往外。
export const buildZoomItems = (range, total, current) => {
  const N = Math.max(0, Math.floor(Number(total) || 0));
  const list = [];
  const left = range.from - 1, right = range.to + 1;
  if (left >= 1) list.push(left);
  list.push(...buildExpansionSamples(range, current));
  if (right <= N) list.push(right);
  if (!list.length) return [];
  const items = [];
  if (list[0] > 1) {
    items.push(tick(1));
    if (list[0] > 2) items.push(gap(2, list[0] - 1));
  }
  list.forEach((i, k) => {
    if (k > 0 && i - list[k - 1] > 1) items.push(gap(list[k - 1] + 1, i - 1, { enter: true }));
    items.push(tick(i, { enter: i >= range.from && i <= range.to }));
  });
  const last = list[list.length - 1];
  if (last < N) {
    if (last < N - 1) items.push(gap(last + 1, N - 1));
    items.push(tick(N));
  }
  const entering = items.filter(item => item.t === 'tick' && item.enter);
  (isNearTop(range, Number(current) || 0) ? entering : entering.slice().reverse())
    .forEach((item, order) => { item.order = order; });
  return items;
};

export const clipScrubberPreview = (value, maxLength = 46) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
};

// ---- 刻度条几何：坐标以刻度条左上角为原点 ----

export const SCRUBBER_PITCH = 18;

// 紧凑排列：固定间距，整条以 height × centerRatio 处为中心（电脑居中、手机略低），放不下才压缩间距；
// 末项是回底箭头时与最后一道刻度多隔开 endGap。
export const layoutScrubberItems = (items, height, { pitch = SCRUBBER_PITCH, centerRatio = 0.5, endGap = 6 } = {}) => {
  const n = Array.isArray(items) ? items.length : 0;
  if (!n) return { pitch, ys: [] };
  const H = Math.max(0, Number(height) || 0);
  const extra = items[n - 1]?.t === 'end' ? endGap : 0;
  const P = n > 1 ? Math.max(0, Math.min(pitch, (H - extra) / (n - 1))) : pitch;
  const span = (n - 1) * P + extra;
  const top = Math.max(0, Math.min(H - span, H * centerRatio - span / 2));
  return { pitch: P, ys: items.map((item, k) => top + k * P + (item.t === 'end' ? extra : 0)) };
};

// 按住时的凸起：手指附近间距放大（spread、magnify），刻度沿高斯曲线向左鼓出 bulge px（宽度 width），
// 并按曲线法线方向倾斜，像钟面刻度。手指处不动、先后顺序不变。strength 0–1 用于渐入渐出。
export const SCRUBBER_ARC = Object.freeze({ spread: 32, magnify: 0.6, bulge: 20, width: 50 });

// 手指按住时的弧要拉出到手指外面，否则整段刻度都在手指底下：
// 按下处离刻度条右缘的距离 + 手指接触面长边（触控事件的 width/height，CSS px）+ 10，限制在 48–110。
// 读不到接触面时（≤2px：部分浏览器只给 0 或 1）用 64。实测 Pixel 10 平常按约 13 + 40 + 10 = 63。
export const SCRUBBER_TOUCH_BULGE_DEFAULT = 64;
export const touchArcForContact = ({ contact = 0, edge = 0 } = {}) => {
  const size = Number(contact) || 0;
  const bulge = size > 2
    ? Math.round(Math.min(110, Math.max(48, (Number(edge) || 0) + size + 10)))
    : SCRUBBER_TOUCH_BULGE_DEFAULT;
  return {
    magnify: 0.9,
    bulge,
    width: Math.round(bulge * 1.12),
    spread: Math.round(Math.min(52, Math.max(32, bulge * 0.62))),
  };
};
export const scrubberLens = (y, focus, strength = 1, arc = SCRUBBER_ARC) => {
  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  const u = y - focus;
  const yy = focus + u + arc.magnify * arc.spread * Math.tanh(u / arc.spread) * s;
  const v = yy - focus;
  const w = Math.exp(-((v / arc.width) ** 2));
  const dx = arc.bulge * s * w;
  const slope = v ? dx * (-2 * v / (arc.width * arc.width)) : 0;
  return { y: yy, dx, rot: Math.atan(slope), lenF: 1 + 0.55 * s * w };
};

// 指针对应的项目：凸起不改变先后顺序，取排列位置最近的一项。
// 鼠标严格在条内（extraLeft：凸起时往左鼓出的部分）；手指按住（lenient）在凸起之外再往左容忍 60px、往右 24px，上下拖过头停在首尾。
export const pickScrubberItem = (entries, { x, y, width = 0, pitch = SCRUBBER_PITCH, lenient = false, extraLeft = 0 } = {}) => {
  if (!Array.isArray(entries) || !entries.length) return null;
  const left = -Math.max(0, extraLeft) - (lenient ? 60 : 0);
  const right = width + (lenient ? 24 : 0);
  if (!(x >= left && x <= right)) return null;
  const first = entries[0].y, last = entries[entries.length - 1].y;
  let probe = y;
  if (lenient) probe = Math.max(first, Math.min(last, y));
  else {
    const slack = Math.max(pitch / 2 + 4, 10);
    if (!(y >= first - slack && y <= last + slack)) return null;
  }
  let best = null;
  for (const entry of entries) {
    if (!best || Math.abs(entry.y - probe) < Math.abs(best.y - probe)) best = entry;
  }
  return best;
};
