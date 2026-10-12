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
