/* 女仆单次任务内的“目标账本”，只读本轮已执行的步骤，不改工具本身：
   1. 删除幂等：本轮已删除的目标再次被要求删除时，不再调用工具，直接说明“已在第 N 步删除，无需重复”；
   2. 重复检测看目标：参数里的名称与 ID 统一映射到同一目标后再比较，按名称删和按 ID 删视为同一件事；
   3. 成败看目标：最终回答时最后一步失败，但它只是对已完成目标的多余操作，或只是收尾读取失败而所有写入目标都已达成，
      整次任务仍算成功。 */

const DELETE_TOOL_TARGET_ARGS = Object.freeze({
  'regex.delete_many': 'targets',
  'script.delete_many': 'scripts',
  'preset.delete_many': 'presets',
  'persona.delete_many': 'personas',
  'worldbook.delete_many': 'worldbooks',
  'session.delete_many': 'sessions',
});
const RESULT_ID_FIELDS = ['id', 'presetId', 'personaId', 'worldbookId', 'sessionId', 'scriptId'];
const ALIAS_NAME_FIELDS = ['name', 'title', 'scriptName', 'target'];
// 参数里表示“操作哪个目标”的字段；其余字段（内容、开关值等）不参与目标身份
const IDENTITY_ARG_KEYS = new Set([
  'targets', 'scripts', 'presets', 'personas', 'worldbooks', 'sessions',
  'target', 'id', 'name', 'sessionId', 'worldbookId', 'personaId', 'presetId', 'scriptId', 'setId', 'newSetName',
  'type', 'kind', 'scope',
]);
export const ALREADY_DELETED_REASON = 'already_deleted_in_run';
const MAX_ALIAS_SCAN_NODES = 4000;
const MAX_ALIAS_SCAN_DEPTH = 6;

const trim = value => String(value ?? '').trim();
const normKey = value => trim(value).toLowerCase().replace(/\s+/g, '');
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stepList = steps => (Array.isArray(steps) ? steps : []);
const resultOf = output => (isPlainObject(output?.result) ? output.result : output);

const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
};

export const isMaidDeleteTool = toolName => Object.hasOwn(DELETE_TOOL_TARGET_ARGS, trim(toolName));

/* 步骤属于哪一类资源：工具名前缀（regex.list → regex）；通用读取 app.read_resource 按它读的资源归类
   （输出里的 resource 已规范化，如 regexes → regex）。名称与 ID 的对应只在同类资源的输出里取证，
   别的资源里的同名对象不影响，同类资源经由通用读取列出的对象也不会漏看。 */
export const maidStepResourceFamily = (step = {}) => {
  const toolName = trim(step?.toolName);
  if (toolName === 'app.read_resource') {
    return normKey(step?.output?.resource || step?.args?.resource) || 'app';
  }
  return toolName.split('.')[0];
};

const buildFamilyAliasReader = (steps = []) => {
  const list = stepList(steps);
  const cache = new Map();
  return (family) => {
    if (!cache.has(family)) {
      cache.set(family, buildMaidTargetAliases(list.filter(step => maidStepResourceFamily(step) === family)));
    }
    return cache.get(family);
  };
};

// 预设按类型区分（同名的对话预设与系统提示词不是同一个目标）
const deleteScopeOf = (toolName, args = {}) => (trim(toolName) === 'preset.delete_many' ? trim(args?.type) || 'openai' : '');
const deleteKey = (toolName, scope, value, byId = false) => JSON.stringify([
  trim(toolName), scope, byId ? 'id' : 'name', byId ? trim(value) : normKey(value),
]);

// 本轮已成功删除的目标：键为 工具|范围|名称或 ID，值为首次删除所在步骤
export const collectRunDeletedTargets = (steps = []) => {
  const deleted = new Map();
  const list = stepList(steps);
  const aliasesOf = buildFamilyAliasReader(list);
  list.forEach((step, position) => {
    const toolName = trim(step?.toolName);
    if (!isMaidDeleteTool(toolName) || step?.status !== 'succeeded') return;
    const aliases = aliasesOf(maidStepResourceFamily(step));
    const scope = deleteScopeOf(toolName, step.args);
    const stepIndex = Number(step.index) || position + 1;
    const output = resultOf(step.output);
    const items = Array.isArray(output?.results) ? output.results : [];
    items.forEach((item) => {
      if (item?.status !== 'succeeded') return;
      const id = RESULT_ID_FIELDS.map(field => trim(item[field])).find(Boolean);
      if (!id) return;
      const label = trim(item.name || item.target || id);
      const record = { stepIndex, label };
      const idKey = deleteKey(toolName, scope, id, true);
      if (!deleted.has(idKey)) deleted.set(idKey, record);
      // 名称必须在本轮同类资源的所有输出中唯一对应这个 ID；重名或重新创建后交回工具解析。
      [item.target, item.name].forEach((value) => {
        if (!trim(value) || aliases.get(normKey(value)) !== id) return;
        const key = deleteKey(toolName, scope, value);
        if (!deleted.has(key)) deleted.set(key, record);
      });
    });
  });
  return deleted;
};

// 这次删除里哪些目标本轮已经删过；没有命中时返回 null
export const findAlreadyDeletedTargets = (plan = {}, steps = []) => {
  const toolName = trim(plan?.toolName);
  const argKey = DELETE_TOOL_TARGET_ARGS[toolName];
  if (!argKey) return null;
  const requested = (Array.isArray(plan?.args?.[argKey]) ? plan.args[argKey] : [plan?.args?.[argKey]]).map(trim).filter(Boolean);
  if (!requested.length) return null;
  const ledger = collectRunDeletedTargets(steps);
  if (!ledger.size) return null;
  const scope = deleteScopeOf(toolName, plan.args);
  const deleted = [];
  const remaining = [];
  requested.forEach((target) => {
    const hit = ledger.get(deleteKey(toolName, scope, target, true)) || ledger.get(deleteKey(toolName, scope, target));
    if (hit) deleted.push({ target, stepIndex: hit.stepIndex, label: hit.label || target });
    else remaining.push(target);
  });
  if (!deleted.length) return null;
  return { toolName, argKey, deleted, remaining };
};

const describeAlreadyDeleted = deleted => deleted
  .map(item => `「${item.label}」已在第 ${item.stepIndex} 步删除`)
  .join('；');

const alreadyDeletedResults = deleted => deleted.map(item => ({
  target: item.target,
  name: item.label,
  status: 'skipped',
  reason: ALREADY_DELETED_REASON,
  deletedAtStep: item.stepIndex,
}));

// 全部目标都已删除：不调用工具，按成功返回并提示模型停止重复
export const buildAlreadyDeletedExecution = (match = {}) => {
  const deleted = Array.isArray(match.deleted) ? match.deleted : [];
  const message = `${describeAlreadyDeleted(deleted)}，无需重复；请继续下一个未完成的目标，或直接给出最终回答。`;
  return {
    output: {
      toolName: trim(match.toolName),
      status: 'succeeded',
      result: {
        ok: true,
        requestedCount: deleted.length,
        succeededCount: 0,
        skippedCount: deleted.length,
        failedCount: 0,
        results: alreadyDeletedResults(deleted),
        localToolExecutionSkipped: true,
        reusedVerifiedAction: true,
        reason: ALREADY_DELETED_REASON,
        message,
      },
      summary: `${describeAlreadyDeleted(deleted)}，无需重复`,
    },
    guided: false,
    guide: null,
    message: '',
  };
};

// 部分目标已删除：只把剩余目标交给工具（确认框也只列剩余目标）
export const stripAlreadyDeletedTargets = (plan = {}, match = {}) => ({
  ...plan,
  args: { ...(plan.args || {}), [match.argKey]: [...match.remaining] },
});

// 剩余目标执行完后，把本轮已删除的目标补回结果，模型能看到完整清单
export const appendAlreadyDeletedResults = (output = {}, match = {}) => {
  const deleted = Array.isArray(match.deleted) ? match.deleted : [];
  if (!deleted.length || !isPlainObject(output)) return output;
  const result = resultOf(output);
  if (!isPlainObject(result)) return output;
  const merged = {
    ...result,
    requestedCount: (Number(result.requestedCount) || 0) + deleted.length,
    skippedCount: (Number(result.skippedCount) || 0) + deleted.length,
    results: [...(Array.isArray(result.results) ? result.results : []), ...alreadyDeletedResults(deleted)],
  };
  const summary = [trim(output.summary), `${describeAlreadyDeleted(deleted)}，无需重复`].filter(Boolean).join('；');
  return result === output ? { ...merged, summary } : { ...output, result: merged, summary };
};

/* 名称 → ID 别名表：从给定步骤的输出里收集带 ID 与名称的对象（列表结果、批量操作结果）。
   同名对应多个 ID 时不做映射，避免把两个不同目标当成一个。
   过深的嵌套（如角色卡内嵌的世界书扩展字段）只跳过那一段，不影响其余证据；
   节点总数超限说明没扫完，此时无法证明名称唯一，整张表作废（ID 仍可直接使用）。 */
export const buildMaidTargetAliases = (steps = []) => {
  const candidates = new Map();
  let visited = 0;
  let truncated = false;
  const addAlias = (name, id) => {
    const key = normKey(name);
    const canonical = trim(id);
    if (!key || !canonical || key === normKey(canonical)) return;
    if (!candidates.has(key)) candidates.set(key, new Set());
    candidates.get(key).add(canonical);
  };
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > MAX_ALIAS_SCAN_DEPTH) return;
    if (visited >= MAX_ALIAS_SCAN_NODES) { truncated = true; return; }
    visited += 1;
    if (Array.isArray(node)) {
      node.forEach(child => walk(child, depth + 1));
      return;
    }
    const id = RESULT_ID_FIELDS.map(field => trim(node[field])).find(Boolean);
    if (id) ALIAS_NAME_FIELDS.forEach(field => { if (typeof node[field] === 'string') addAlias(node[field], id); });
    Object.values(node).forEach(child => { if (child && typeof child === 'object') walk(child, depth + 1); });
  };
  stepList(steps).forEach(step => walk(step?.output, 0));
  const aliases = new Map();
  // 未扫描完时不能证明名称唯一；ID 仍可直接使用。
  if (truncated) return aliases;
  candidates.forEach((ids, key) => { if (ids.size === 1) aliases.set(key, [...ids][0]); });
  return aliases;
};

const canonicalizeValue = (value, aliases) => {
  if (typeof value === 'string') return aliases.get(normKey(value)) || trim(value);
  if (Array.isArray(value)) {
    const mapped = value.map(item => canonicalizeValue(item, aliases));
    return mapped.every(item => typeof item === 'string') ? [...new Set(mapped)].sort() : mapped;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalizeValue(item, aliases)]));
  }
  return value;
};

// 同一操作的比较键：工具 + 目标统一成 ID 后的参数（内容与开关值仍参与比较）
export const buildMaidStepActionKey = (step = {}, aliases = new Map()) => (
  `${trim(step?.toolName)}:${stableStringify(canonicalizeValue(isPlainObject(step?.args) ? step.args : {}, aliases))}`
);

// 目标身份键：只看“操作哪个目标”，不看写入的内容；没有可识别的目标字段时退回整份参数
export const buildMaidStepTargetKey = (step = {}, aliases = new Map()) => {
  const args = isPlainObject(step?.args) ? step.args : {};
  const identity = Object.fromEntries(Object.entries(args).filter(([key]) => IDENTITY_ARG_KEYS.has(key)));
  return `${trim(step?.toolName)}#${stableStringify(canonicalizeValue(Object.keys(identity).length ? identity : args, aliases))}`;
};

/* 从末尾往前数，连续多少步是同一操作且状态相同（status: 'failed' | 'succeeded'） */
export const countConsecutiveSameAction = (steps = [], status = 'failed') => {
  const list = stepList(steps);
  const last = list.at(-1);
  if (!last || last.status !== status) return { count: 0, key: '' };
  // 比较键含工具名，只有同一工具的步骤可能相同，按末步所属资源取证即可
  const aliases = buildFamilyAliasReader(list)(maidStepResourceFamily(last));
  const key = buildMaidStepActionKey(last, aliases);
  let count = 0;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const step = list[index];
    if (step?.status !== status || buildMaidStepActionKey(step, aliases) !== key) break;
    count += 1;
  }
  return { count, key, toolName: trim(last.toolName), args: JSON.parse(JSON.stringify(last.args || {})) };
};

/* 模型给出最终回答时的整体成败。
   isWriteTool(toolName) 返回 true / false / undefined（未知工具）；未知工具按写入处理，只读判断必须明确。 */
export const resolveMaidRunOutcome = ({ lastOk = false, steps = [], isWriteTool = () => undefined } = {}) => {
  if (lastOk) return { ok: true, reason: '' };
  const list = stepList(steps);
  const last = list.at(-1);
  if (!last || last.status !== 'failed') return { ok: false, reason: '' };
  const aliasesOf = buildFamilyAliasReader(list);
  const actionKey = step => buildMaidStepActionKey(step, aliasesOf(maidStepResourceFamily(step)));
  const targetKey = step => buildMaidStepTargetKey(step, aliasesOf(maidStepResourceFamily(step)));
  const earlier = list.slice(0, -1);
  const lastAction = actionKey(last);
  const writes = list.filter(step => isWriteTool(step?.toolName) !== false && ['succeeded', 'failed'].includes(step?.status));
  const latestByTarget = new Map();
  writes.forEach((step) => {
    const target = targetKey(step);
    const action = actionKey(step);
    const previous = latestByTarget.get(target);
    // 只沿用该目标当前已证实的状态；中间改成别的状态后，旧成功不能证明这次也已完成。
    const achieved = step.status === 'succeeded' || (previous?.achieved === true && previous.action === action);
    latestByTarget.set(target, { action, achieved });
  });
  // 即便末步只是重复操作，也不能掩盖其他尚未完成的写入目标。
  if ([...latestByTarget.values()].some(state => !state.achieved)) return { ok: false, reason: '' };
  const repeated = isWriteTool(last.toolName) !== false
    ? latestByTarget.get(targetKey(last))?.achieved === true
    : earlier.some(step => step?.status === 'succeeded' && actionKey(step) === lastAction);
  if (repeated) return { ok: true, reason: 'redundant_repeat' };
  return writes.length ? { ok: true, reason: 'goal_reached' } : { ok: false, reason: '' };
};
