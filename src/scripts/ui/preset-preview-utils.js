import { buildLineDiff } from '../utils/line-diff-utils.js';

export const normalizePresetBlockText = value =>
  String(value ?? '').replace(/\r\n?/g, '\n');

export const presetBlockContentChanged = (baseText, draftText) =>
  normalizePresetBlockText(baseText) !== normalizePresetBlockText(draftText);

// 草稿与已保存预设按内容比对：对象键顺序不算差异（分片落盘后键按字母排序，
// 表单收集的键顺序不同），数组顺序仍算（区块顺序即注入顺序）。
const stablePresetJson = value => {
  if (Array.isArray(value)) return `[${value.map(item => stablePresetJson(item === undefined ? null : item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${stablePresetJson(value[key])}`).join(',')}}`;
};
export const isSamePresetData = (a, b) => stablePresetJson(a) === stablePresetJson(b);

export const buildPresetPreviewBlockMap = ({
  messageTexts = [],
  blocks = [],
} = {}) => {
  const texts = (Array.isArray(messageTexts) ? messageTexts : []).map(text => String(text ?? ''));
  const claimed = texts.map(() => []);
  const result = new Map();

  const tryClaim = (id, needle, exact) => {
    const value = String(needle ?? '');
    if (!value) return false;
    for (let messageIndex = 0; messageIndex < texts.length; messageIndex += 1) {
      let searchFrom = 0;
      while (searchFrom <= texts[messageIndex].length - value.length) {
        const start = texts[messageIndex].indexOf(value, searchFrom);
        if (start < 0) break;
        const end = start + value.length;
        searchFrom = start + 1;
        if (claimed[messageIndex].some(([claimedStart, claimedEnd]) => start < claimedEnd && end > claimedStart)) {
          continue;
        }
        claimed[messageIndex].push([start, end]);
        result.set(id, { msg: messageIndex, start, len: value.length, exact });
        return true;
      }
    }
    return false;
  };

  const fuzzyPass = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id || '').trim();
    if (!id || block?.marker === true || block?.enabled === false) continue;
    const content = String(block?.content ?? '');
    if (content.trim().length < 6) continue;
    if (!tryClaim(id, content, true)) fuzzyPass.push({ id, content });
  }

  for (const { id, content } of fuzzyPass) {
    const segments = content
      .split(/\{\{[^{}]*\}\}|<%[\s\S]*?%>/)
      .map(segment => segment.trim())
      .filter(segment => segment.length >= 24)
      .sort((left, right) => right.length - left.length)
      .slice(0, 3);
    for (const segment of segments) {
      if (tryClaim(id, segment, false)) break;
    }
  }

  return result;
};

export const applyPresetBlockHunk = (baseText, draftText, hunkIndex, mode) => {
  const { rows } = buildLineDiff(baseText, draftText, { collapseContext: false });
  const isChanged = row => row?.type === 'del' || row?.type === 'add';
  let currentHunk = -1;
  const lines = [];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (isChanged(row) && !isChanged(rows[index - 1])) currentHunk += 1;
    if (row.type === 'context') {
      lines.push(row.text);
      continue;
    }
    const inTargetHunk = currentHunk === hunkIndex;
    if (mode === 'accept') {
      if (row.type === 'del' ? !inTargetHunk : inTargetHunk) lines.push(row.text);
    } else if (row.type === 'del' ? inTargetHunk : !inTargetHunk) {
      lines.push(row.text);
    }
  }

  return lines.join('\n');
};

export const createLatestPreviewBuildQueue = ({
  build,
  onStart = null,
  onResult = null,
  onFailure = null,
} = {}) => {
  let revision = 0;
  let queuedJob = null;
  let running = null;

  const drain = async () => {
    while (true) {
      while (queuedJob) {
        const job = queuedJob;
        queuedJob = null;
        onStart?.(job);
        let result = null;
        let error = null;
        try {
          result = await build?.(job.options);
        } catch (err) {
          error = err;
        }
        if (job.revision !== revision) continue;
        if (result) onResult?.(result, job);
        else onFailure?.(error, job);
      }
      // onResult/onFailure 可能以 queueMicrotask 再排一次重建；留一轮微任务后
      // 再确认队列稳定，避免 job 卡在 drain 完成与 running 清空之间。
      await Promise.resolve();
      if (!queuedJob) break;
    }
  };

  const ensureDrain = () => {
    if (running) return running;
    let tracked = null;
    tracked = drain().finally(() => {
      if (running === tracked) running = null;
      // request 可能恰好落在 drain 结束与 finally 清锁之间；最终再检查一次，
      // 让这个窗口里的 job 自动开启下一轮，而不是永久滞留在 queuedJob。
      if (queuedJob) return ensureDrain();
      return undefined;
    });
    running = tracked;
    return tracked;
  };

  return {
    request(options = {}) {
      queuedJob = { revision: ++revision, options };
      return ensureDrain();
    },
    invalidate() {
      revision += 1;
      queuedJob = null;
    },
  };
};
