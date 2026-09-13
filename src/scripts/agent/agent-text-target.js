import { spliceRenderedAgentTarget } from './agent-rendered-target.js';
// All offsets refer to the immutable raw reply, never rendered HTML.
export const AGENT_TARGET_MAX_CHARS = 40000;
const failure = (reason, message) => ({ ok: false, reason, message });
// Textareas normalize CRLF/CR to LF. Map their selection back to raw offsets.
export const mapAgentRawSelection = (raw, start, end) => {
  const source = String(raw ?? '');
  let cursor = 0, normalized = 0, rawStart = -1, rawEnd = -1;
  while (cursor <= source.length) {
    if (normalized === start) rawStart = cursor;
    if (normalized === end) { rawEnd = cursor; break; }
    if (cursor === source.length) break;
    cursor += source[cursor] === '\r' && source[cursor + 1] === '\n' ? 2 : 1;
    normalized++;
  }
  return { start: rawStart, end: rawEnd, text: rawStart >= 0 && rawEnd > rawStart ? source.slice(rawStart, rawEnd) : '' };
};
export const resolveAgentTextTarget = (raw, rule = {}, { bodyRule, selection, maxChars = AGENT_TARGET_MAX_CHARS } = {}) => {
  const source = String(raw ?? '');
  let start = 0, end = source.length;
  if (!source.trim()) return failure('empty_source', '这条回复没有可处理的文本');
  if (selection) {
    start = selection.start; end = selection.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > source.length
      || source.slice(start, end) !== selection.text) return failure('selection_changed', '选中文字已变化，请重新选择');
  } else {
    if (rule.mode === 'body') {
      if (!bodyRule || bodyRule.mode === 'body') return failure('body_rule_missing', '请先设置正文识别规则');
      rule = bodyRule;
    }
    if (rule.mode === 'tags') {
      if (!rule.start || !rule.end) return failure('tags_missing', '请填写开始和结束标签');
      const first = source.indexOf(rule.start), close = first < 0 ? -1 : source.indexOf(rule.end, first + rule.start.length);
      if (first < 0 || close < 0) return failure('target_missing', '这条回复未匹配到完整的目标范围');
      if (source.indexOf(rule.start, first + rule.start.length) >= 0 || source.indexOf(rule.end, close + rule.end.length) >= 0)
        return failure('target_ambiguous', '匹配到多个范围，请用更精确的规则');
      start = first + rule.start.length; end = close;
    } else if (rule.mode === 'regex') {
      if (!rule.pattern || rule.pattern.length > 1000 || source.length > 120000) return failure('invalid_regex', '请缩短正则或待匹配文本');
      // Exclude catastrophic common forms before evaluating a user rule on the UI thread.
      if (/\([^)]*[+*][^)]*\)[+*{]|\\[1-9]|\(\?<([=!])/.test(rule.pattern)) return failure('unsafe_regex', '请简化正则，使用明确的起止边界和捕获组');
      let regex;
      try { regex = new RegExp(rule.pattern, [...new Set(`${String(rule.flags || '').replace(/[^imsu]/g, '')}gd`)].join('')); }
      catch { return failure('invalid_regex', '正则无效，或当前系统不支持捕获组位置；可使用起止标签'); }
      const match = regex.exec(source), group = Number(rule.group || 1);
      const span = match?.indices?.[group];
      if (!span) return failure('target_missing', '正则未匹配到指定捕获组');
      if (!match[0].length || regex.exec(source)) return failure('target_ambiguous', '匹配到多个范围，请用更精确的规则');
      [start, end] = span;
    } else if (rule.mode !== 'full') return failure('invalid_target', '请选择处理范围');
  }
  if (end <= start || !source.slice(start, end).trim()) return failure('empty_target', '匹配到的内容为空');
  if (end - start > maxChars) return failure('target_too_long', '处理文本超过 40000 字符，请缩小范围');
  return { ok: true, start, end, text: source.slice(start, end), source };
};

export const suggestAgentBodyRules = (source = '', evidence = []) => {
  const found = new Map();
  for (const [index, entry] of [source, ...evidence].entries()) {
    const text = typeof entry === 'string' ? entry : entry?.text || entry?.content || '';
    for (const match of String(text).matchAll(/<([a-zA-Z][\w-]*)\b[^>]*>/g)) {
      const tag = match[1];
      if (/^(think|thinking|analysis|tableEdit|UpdateVariable|image_prompt|script|style)$/i.test(tag)) continue;
      const rule = { mode: 'tags', start: match[0], end: `</${tag}>` };
      if (!found.has(tag) && String(text).includes(rule.end)) found.set(tag, { label: tag, source: index ? '提示词 / 正则' : '最近回复', rule });
    }
  }
  return [...found.values()].slice(0, 16);
};

export const spliceAgentTextTarget = (target, text) => target.mode === 'rendered' ? spliceRenderedAgentTarget(target, text) : target.source.slice(0, target.start) + text + target.source.slice(target.end);

// Advanced user regex runs off the UI thread and has a strict execution deadline.
export const resolveAgentTextTargetAsync = (source, rule, options = {}) => {
  const effective = rule?.mode === 'body' ? options.bodyRule : rule;
  if (options.selection || effective?.mode !== 'regex' || typeof Worker !== 'function') return Promise.resolve(resolveAgentTextTarget(source, rule, options));
  return new Promise(resolve => {
    let worker, timer;
    const done = result => { clearTimeout(timer); worker?.terminate(); resolve(result); };
    try {
      worker = new Worker(new URL('./agent-text-target-worker.js', import.meta.url), { type: 'module' });
      timer = setTimeout(() => done(failure('regex_timeout', '正则匹配超时，请简化表达式')), 1000);
      worker.onmessage = event => done(event.data);
      worker.onerror = () => done(failure('regex_unavailable', '当前环境无法执行正则匹配，请使用起止标签'));
      worker.postMessage({ source, rule, options });
    } catch { done(failure('regex_unavailable', '当前环境无法执行正则匹配，请使用起止标签')); }
  });
};
