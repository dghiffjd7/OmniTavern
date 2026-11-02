// 文件诊断（女仆通用文件处理第二期，承接导入计划第 5 步）：把问题指到具体位置。
// JSON 语法错误给出行列与前后几行；正则逐条试编译；脚本按兼容性预检标出 APP 不支持或受限的写法。
// 只诊断，不改文件；修复由女仆写一份改好的副本再导入。

import { analyzeScriptCompatibility } from './script-capability-preflight.js';

const text = value => String(value ?? '').trim();
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const MAX_LISTED = 5;
const EXCERPT_RADIUS = 2;

// V8 的 JSON 错误信息带 position，新版还带 line／column；都没有时只给原文
const readErrorPosition = (source, message) => {
  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const position = /position (\d+)/.exec(message);
  if (position) {
    const before = source.slice(0, Number(position[1]));
    const lines = before.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  if (/end of (?:JSON|data) input/i.test(message)) {
    const lines = source.split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
  }
  return null;
};

/** JSON 语法错误 → { line, column, message, excerpt }；excerpt 带行号，出错那行下面画 ^ 标出列。 */
export const describeJsonSyntaxError = (source = '', error = null) => {
  const message = text(error?.message || error).slice(0, 200);
  const at = readErrorPosition(String(source), message);
  if (!at) return { line: 0, column: 0, message, excerpt: '' };
  const lines = String(source).split('\n');
  const from = Math.max(1, at.line - EXCERPT_RADIUS);
  const to = Math.min(lines.length, at.line + EXCERPT_RADIUS);
  const width = String(to).length;
  const out = [];
  for (let line = from; line <= to; line += 1) {
    const content = lines[line - 1].length > 160 ? `${lines[line - 1].slice(0, 160)}…` : lines[line - 1];
    out.push(`${String(line).padStart(width)}| ${content}`);
    if (line === at.line) out.push(`${' '.repeat(width)}| ${' '.repeat(Math.max(0, Math.min(at.column - 1, 160)))}^`);
  }
  return { ...at, message, excerpt: out.join('\n') };
};

const compileRegex = (source) => {
  const raw = String(source ?? '');
  if (!raw.trim()) return '查找内容是空的';
  const literal = raw.match(/^\/([\s\S]*)\/([a-z]*)$/);
  try {
    // eslint-disable-next-line no-new
    new RegExp(literal ? literal[1] : raw, literal ? literal[2] : '');
    return '';
  } catch (error) {
    return text(error?.message).slice(0, 160);
  }
};

const summarize = (problems, describe, moreLabel) => [
  ...problems.slice(0, MAX_LISTED).map(describe),
  ...(problems.length > MAX_LISTED ? [moreLabel(problems.length - MAX_LISTED)] : []),
];

/** 正则逐条试编译，返回诊断文字（最多列 5 条）。rules：{ scriptName|name, findRegex|find_regex }。 */
export const diagnoseRegexRules = (rules = []) => {
  const problems = (Array.isArray(rules) ? rules : []).map((rule, index) => ({
    name: text(rule?.scriptName || rule?.script_name || rule?.name) || `#${index + 1}`,
    error: compileRegex(rule?.findRegex ?? rule?.find_regex ?? rule?.pattern),
    disabled: rule?.disabled === true || rule?.enabled === false,
  })).filter(item => item.error && !item.disabled);
  return summarize(problems, item => `正则「${item.name}」无法使用：${item.error}`, count => `另有 ${count} 条正则无法使用`);
};

const collectScripts = (nodes, out = [], depth = 0) => {
  (Array.isArray(nodes) ? nodes : []).forEach((node) => {
    if (!isPlainObject(node) || depth > 8) return;
    if (node.type === 'folder' || Array.isArray(node.scripts)) collectScripts(node.scripts, out, depth + 1);
    else out.push(node);
  });
  return out;
};

/** 脚本兼容性：只列 APP 不支持或受限的（最多 5 条）。nodes：脚本树；单个 .js 传 [{ name, content }]。 */
export const diagnoseScripts = (nodes = []) => {
  const problems = collectScripts(nodes)
    .map((node, index) => ({ name: text(node.name) || `#${index + 1}`, report: analyzeScriptCompatibility(String(node.content ?? '')) }))
    // 顶层 await 只是换到模块环境运行，不算问题
    .filter(item => ['external_extension', 'sandbox_limited'].includes(item.report.level));
  return summarize(problems, item => `脚本「${item.name}」：${item.report.message}`, count => `另有 ${count} 个脚本有兼容性问题`);
};
