// 变量注入总览与假设值模拟（逻辑层，计划书 Unfinished_Plans/创意向体验与世界书变量管理优化计划.md M4）：
// 列出世界书条件、条件触发的变量规则、阶段三种「变量 → 条件 → 注入」，分别用现在的变量和假设值求值。
// 只做判断，不拼完整提示词、不写任何变量；关键词触发的条目只标「需要关键词」。

import {
  explainConditionTree,
  isTrivialConditionTree,
  normalizeConditionTree,
  normalizeWorldPromptMode,
  shouldUseWorldPromptBlocks,
  visitConditionTree,
} from './world-condition-core.js';
import {
  buildVariableContext,
  setValueAtPath,
  stripKnownVariableRootPrefix,
  toVariablePath,
} from './variable-path-utils.js';
import { evaluateBooleanExpression } from './safe-expression-evaluator.js';

const text = value => String(value ?? '').trim();
const asArray = value => (Array.isArray(value) ? value : []);
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

const EXPRESSION_WORDS = new Set(['true', 'false', 'null', 'undefined', 'and', 'or', 'not', 'in', 'vars', 'typeof', 'NaN', 'Infinity']);
const IDENT = '[A-Za-z_$\\u4e00-\\u9fff][\\w$\\u4e00-\\u9fff]*';
const PATH_RE = new RegExp(`${IDENT}(?:\\.${IDENT}|\\[\\d+\\])*`, 'g');

const pushPath = (out, raw) => {
  const path = text(raw).replace(/^vars\./, '');
  if (path && !EXPRESSION_WORDS.has(path) && !out.includes(path)) out.push(path);
};

// 表达式里读到的变量路径：去掉字符串字面量，跳过函数调用与关键字
export const extractExpressionPaths = (expr = '') => {
  // vars["好感度"] 这类方括号写法先改成点号路径，再去掉其余字符串字面量
  const source = String(expr ?? '')
    .replace(/\[\s*(['"])([^'"\]]+)\1\s*\]/g, '.$2')
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ' ');
  const out = [];
  for (const match of source.matchAll(PATH_RE)) {
    const after = source.slice(match.index + match[0].length).trimStart();
    const before = source.slice(0, match.index).trimEnd();
    if (before.endsWith('.')) continue;
    let path = match[0];
    // x.includes(...) 读的是 x；单独的函数调用不算变量
    if (after.startsWith('(')) {
      const dot = path.lastIndexOf('.');
      if (dot <= 0) continue;
      path = path.slice(0, dot);
    }
    pushPath(out, path.replace(/\.length$/, ''));
  }
  return out;
};

const collectOperandPaths = (operand, out) => {
  if (operand && typeof operand === 'object') {
    if (typeof operand.var === 'string') pushPath(out, operand.var);
    asArray(operand.args).forEach(arg => collectOperandPaths(arg, out));
    return;
  }
  if (typeof operand === 'string' && operand.trim() && !/^-?\d+(?:\.\d+)?$/.test(operand.trim())) pushPath(out, operand);
};

export const collectConditionPaths = (tree) => {
  const out = [];
  visitConditionTree(tree, (node) => {
    if (Array.isArray(node.clauses) || node.logic === 'not') return;
    collectOperandPaths(node.left, out);
    if (node.rightType === 'variable') collectOperandPaths(node.right, out);
  });
  return out;
};

const entryTitle = (entry, index) => text(entry?.comment || entry?.title || entry?.name) || `#${index + 1}`;
const entryKeys = entry => asArray(entry?.key ?? entry?.keys).map(text).filter(Boolean);
const activationOf = entry => (entry?.constant === true ? 'constant' : entryKeys(entry).length ? 'keyword' : 'none');

const listEntries = world => (Array.isArray(world?.entries) ? world.entries : Object.values(world?.entries || {}));

const collectWorldItems = ({ id: worldId = '', name = '', world = null } = {}) => {
  const items = [];
  listEntries(world).forEach((entry, index) => {
    if (!entry || entry.disable === true || entry.enabled === false) return;
    const entryWhen = isTrivialConditionTree(entry.when) ? null : normalizeConditionTree(entry.when);
    const blocks = asArray(entry.promptBlocks);
    const entryId = text(entry.uid ?? entry.id) || String(index);
    const base = {
      kind: 'world',
      worldId: text(worldId) || text(name),
      entryId,
      activation: activationOf(entry),
    };
    const worldLabel = `${text(name) || text(worldId)} · ${entryTitle(entry, index)}`;
    if (shouldUseWorldPromptBlocks(normalizeWorldPromptMode(entry.promptMode), blocks)) {
      blocks.forEach((block, blockIndex) => {
        if (!block || block.enabled === false || !text(block.content)) return;
        const blockWhen = isTrivialConditionTree(block.when) ? null : normalizeConditionTree(block.when);
        if (!entryWhen && !blockWhen) return;
        const conditions = [entryWhen, blockWhen].filter(Boolean);
        items.push({
          ...base,
          id: `world:${base.worldId}:${entryId}:${text(block.id) || blockIndex}`,
          blockId: text(block.id),
          label: `${worldLabel} · ${text(block.title || block.name) || `#${blockIndex + 1}`}`,
          conditions,
          content: String(block.content),
          paths: [...new Set(conditions.flatMap(collectConditionPaths))],
        });
      });
      return;
    }
    if (!entryWhen || !text(entry.content)) return;
    items.push({
      ...base,
      id: `world:${base.worldId}:${entryId}`,
      blockId: '',
      label: worldLabel,
      conditions: [entryWhen],
      content: String(entry.content),
      paths: collectConditionPaths(entryWhen),
    });
  });
  return items;
};

const RULE_ACTION_LABELS = Object.freeze({
  set_value: '设置变量', increment: '增加变量', decrement: '减少变量', toggle: '切换变量', push: '加入列表',
  remove: '移出列表', notify: '通知', switch_persona: '切换人设', inject_prompt: '注入提示词', ai_evaluate: 'AI 评估',
});

const collectRuleItems = rules => asArray(rules)
  .filter(rule => rule && rule.enabled !== false && rule.trigger?.type === 'condition' && text(rule.trigger?.expr))
  .map(rule => ({
    kind: 'rule',
    id: `rule:${text(rule.id)}`,
    ruleId: text(rule.id),
    label: text(rule.name) || text(rule.id),
    expr: text(rule.trigger.expr),
    action: text(rule.action?.type),
    actionLabel: RULE_ACTION_LABELS[text(rule.action?.type)] || text(rule.action?.type),
    content: rule.action?.type === 'inject_prompt' ? String(rule.action?.prompt || '') : '',
    target: text(rule.action?.target),
    paths: extractExpressionPaths(rule.trigger.expr),
  }));

const normalizeStages = (schema) => {
  if (!schema || typeof schema !== 'object') return null;
  const stages = asArray(schema.stages).filter(stage => stage && typeof stage === 'object').map((stage, index) => ({
    id: text(stage.id) || `stage_${index + 1}`,
    name: text(stage.name) || text(stage.id) || `stage_${index + 1}`,
    condition: typeof stage.condition === 'string' ? stage.condition.trim() : '',
    prompt: typeof stage.prompt === 'string' ? stage.prompt.trim() : '',
  }));
  if (!stages.length) return null;
  return { currentStageVar: text(schema.currentStageVar) || 'stage', stages };
};

const collectStageItem = (schema) => {
  const normalized = normalizeStages(schema);
  if (!normalized) return [];
  return [{
    kind: 'stage',
    id: 'stage',
    label: normalized.currentStageVar,
    stageVar: normalized.currentStageVar,
    stages: normalized.stages,
    paths: [...new Set([normalized.currentStageVar, ...normalized.stages.flatMap(stage => extractExpressionPaths(stage.condition))])],
  }];
};

// 输入：当前会话用到的世界书（{ id, name, world }）、会话变量规则、阶段设置
export const collectInjectionItems = ({ worlds = [], rules = [], stageSchema = null } = {}) => [
  ...asArray(worlds).flatMap(collectWorldItems),
  ...collectRuleItems(rules),
  ...collectStageItem(stageSchema),
];

const isSharedKey = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

// overrides：{ 路径: 假设值 }。global_variables./global. 开头的写进全局，其余写进当前作用域（共享变量会话就是全局）。
export const buildSandboxVariables = ({ localVars = {}, globalVars = {}, shared = false, overrides = {} } = {}) => {
  const local = clone(localVars) || {};
  const global = clone(globalVars) || {};
  Object.entries(overrides || {}).forEach(([rawPath, value]) => {
    const path = text(rawPath);
    if (!path) return;
    const globalMatch = /^(?:global_variables|global)\.(.+)$/.exec(path);
    const target = globalMatch || shared ? global : local;
    const inner = globalMatch ? globalMatch[1] : path.replace(/^local_variables\./, '');
    if (isSharedKey(target, inner)) {
      target[inner] = value;
      return;
    }
    const parts = stripKnownVariableRootPrefix(toVariablePath(inner, { coerceNumeric: false }));
    if (parts.length === 1) target[parts[0]] = value;
    else if (parts.length) setValueAtPath(target, parts, value, { create: true });
  });
  return { localVars: local, globalVars: global };
};

// 与发送时一致：共享变量会话以全局变量为基础
export const buildInjectionContext = ({ localVars = {}, globalVars = {}, shared = false } = {}) => buildVariableContext({
  baseVars: shared ? globalVars : localVars,
  globalVars,
  localVars,
});

// 假设值输入：沿用现值的类型；对象／数组按 JSON 解析
export const parseHypotheticalValue = (raw, currentValue) => {
  const input = String(raw ?? '');
  if (typeof currentValue === 'number') {
    const n = Number(input.trim());
    return Number.isFinite(n) && input.trim() !== '' ? n : input;
  }
  if (typeof currentValue === 'boolean') {
    if (/^(true|是|1)$/i.test(input.trim())) return true;
    if (/^(false|否|0)$/i.test(input.trim())) return false;
    return input;
  }
  if (currentValue && typeof currentValue === 'object') {
    try { return JSON.parse(input); } catch { return input; }
  }
  if (currentValue === undefined && /^-?\d+(?:\.\d+)?$/.test(input.trim())) return Number(input.trim());
  return input;
};

const evalExpr = (expr, ctx, fallback) => {
  try {
    const vars = ctx.variableContext;
    return evaluateBooleanExpression(expr, { ...vars, vars }, { fallback }) ? 'hit' : 'miss';
  } catch {
    return 'error';
  }
};

const resolveStages = (item, ctx, localCtx) => {
  // 与 StageManager 一致：阶段变量和阶段条件都按本会话变量读
  const current = text(localCtx.resolvePathValue(item.stageVar));
  const injected = item.stages.find(stage => stage.id === current) || null;
  // 没有条件成立时回到第一个阶段
  let resolved = null;
  item.stages.forEach((stage) => {
    if (!stage.condition || evalExpr(stage.condition, localCtx, true) === 'hit') resolved = stage;
  });
  return { stageValue: current, injected, resolved: resolved || item.stages[0] };
};

// 求值一条注入：world/rule 返回 status（hit 命中／miss 未命中／keyword 条件满足但要关键词／pending 缺变量／error）；
// stage 另外返回当前注入的阶段与按条件应处于的阶段
export const evaluateInjectionItem = (item, { ctx, localCtx = ctx } = {}) => {
  if (item.kind === 'rule') return { status: evalExpr(item.expr, ctx, false) };
  if (item.kind === 'stage') {
    const stage = resolveStages(item, ctx, localCtx);
    return { status: stage.injected?.prompt ? 'hit' : 'miss', ...stage };
  }
  const results = item.conditions.map(tree => explainConditionTree(tree, ctx).result);
  if (results.some(result => result === false)) return { status: 'miss' };
  if (results.some(result => result !== true)) return { status: 'pending' };
  return { status: item.activation === 'keyword' ? 'keyword' : 'hit' };
};

// 总览：每个变量路径 → 读它的注入；读不到变量的（例如条件写的是常量）单独放「其他」
export const groupInjectionItemsByPath = (items = []) => {
  const groups = new Map();
  asArray(items).forEach((item) => {
    const paths = item.paths.length ? item.paths : [''];
    paths.forEach((path) => {
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path).push(item);
    });
  });
  return groups;
};
