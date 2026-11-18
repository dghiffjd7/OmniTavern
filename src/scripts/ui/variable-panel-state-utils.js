export const VARIABLE_TREE_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 2000,
  maxArray: 120,
});

const createVariableTreeNode = (name, path, order = 0) => ({
  name,
  path,
  order,
  children: new Map(),
  hasValue: false,
  value: undefined,
});

export const formatVariableTreeValue = (value) => {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const trimmed = value.replace(/\s+/g, ' ').trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (typeof value === 'object') return `{${Object.keys(value).length}}`;
  return String(value);
};

export const buildVariableTree = (variables = {}, limits = VARIABLE_TREE_LIMITS) => {
  const root = createVariableTreeNode('', '');
  let nodeCount = 0;

  const ensureChild = (parent, name, path, order = 0) => {
    if (!parent) return null;
    let child = parent.children.get(name);
    if (!child) {
      if (nodeCount >= limits.maxNodes) return null;
      child = createVariableTreeNode(name, path, order);
      parent.children.set(name, child);
      nodeCount += 1;
    } else if (Number.isFinite(order)) {
      child.order = order;
    }
    return child;
  };

  const assignValue = (node, value, override = false) => {
    if (!node) return;
    if (override || !node.hasValue) {
      node.value = value;
      node.hasValue = true;
    }
  };

  const expandValue = (node, value, depth = 0) => {
    if (!node || value == null || depth >= limits.maxDepth) return;
    if (Array.isArray(value)) {
      const limit = Math.min(value.length, limits.maxArray);
      for (let index = 0; index < limit; index += 1) {
        const name = `[${index}]`;
        const path = node.path ? `${node.path}${name}` : name;
        const child = ensureChild(node, name, path, index);
        if (!child) break;
        assignValue(child, value[index], false);
        expandValue(child, value[index], depth + 1);
      }
      return;
    }
    if (typeof value !== 'object') return;
    const entries = Object.entries(value);
    for (let index = 0; index < entries.length; index += 1) {
      const [key, item] = entries[index];
      const name = String(key);
      const path = node.path ? `${node.path}.${name}` : name;
      const child = ensureChild(node, name, path, index);
      if (!child) break;
      assignValue(child, item, false);
      expandValue(child, item, depth + 1);
    }
  };

  Object.entries(variables || {}).forEach(([path, value]) => {
    const raw = String(path || '').trim();
    if (!raw) return;
    const parts = raw.split('.').filter(Boolean);
    let node = root;
    let currentPath = '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      currentPath = currentPath ? `${currentPath}.${part}` : part;
      node = ensureChild(node, part, currentPath, index);
      if (!node) return;
    }
    assignValue(node, value, true);
    expandValue(node, value, parts.length);
  });
  return root;
};

const cloneVariablePathValue = (value) => {
  try {
    return structuredClone(value);
  } catch {}
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {}
  return value;
};

const matchVariablePathKey = (keys, rest) => keys
  .filter(key => key && (rest === key || (rest.startsWith(key) && (rest[key.length] === '.' || rest[key.length] === '['))))
  .sort((a, b) => b.length - a.length)[0];

// 树视图把嵌套值显示成点路径（stat_data.角色.好感度、背包[0]），会话变量却只按顶层名存；
// 读写删前要把路径拆回「顶层变量名 + 嵌套段」，否则会写出扁平的 "a.b.c" 新变量、或删不到。
// 顶层名和嵌套键本身都可能带点，所以每层按已有的键做最长匹配，不按点硬拆。
export const resolveVariablePath = (vars = {}, rawPath = '') => {
  const path = String(rawPath ?? '').trim();
  const source = vars && typeof vars === 'object' ? vars : {};
  if (!path) return null;
  if (Object.prototype.hasOwnProperty.call(source, path)) return { rootKey: path, segments: [] };
  const rootKey = matchVariablePathKey(Object.keys(source), path);
  if (rootKey === undefined) return null;
  const segments = [];
  let node = source[rootKey];
  let rest = path.slice(rootKey.length);
  while (rest) {
    const index = /^\[(\d+)\]/.exec(rest);
    if (index) {
      const position = Number(index[1]);
      if (!Array.isArray(node) || position >= node.length) return null;
      segments.push(position);
      node = node[position];
      rest = rest.slice(index[0].length);
      continue;
    }
    if (rest[0] !== '.' || !node || typeof node !== 'object' || Array.isArray(node)) return null;
    rest = rest.slice(1);
    const key = matchVariablePathKey(Object.keys(node), rest);
    if (key === undefined) return null;
    segments.push(key);
    node = node[key];
    rest = rest.slice(key.length);
  }
  return { rootKey, segments };
};

export const readVariablePathValue = (vars = {}, target = null) => {
  if (!target) return undefined;
  let node = vars?.[target.rootKey];
  for (const segment of Array.isArray(target.segments) ? target.segments : []) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
};

// 返回写入后的新顶层值（不改动传入的值）；insert 用于撤销删除时把数组元素插回原位。
export const writeVariablePathValue = (rootValue, segments = [], value, { insert = false } = {}) => {
  const parts = Array.isArray(segments) ? segments : [];
  if (!parts.length) return cloneVariablePathValue(value);
  const out = rootValue && typeof rootValue === 'object' ? cloneVariablePathValue(rootValue) : {};
  let node = out;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!node[part] || typeof node[part] !== 'object') {
      node[part] = typeof parts[index + 1] === 'number' ? [] : {};
    }
    node = node[part];
  }
  const last = parts[parts.length - 1];
  if (insert && Array.isArray(node) && typeof last === 'number') {
    node.splice(last, 0, cloneVariablePathValue(value));
  } else {
    node[last] = cloneVariablePathValue(value);
  }
  return out;
};

export const removeVariablePathValue = (rootValue, segments = []) => {
  const parts = Array.isArray(segments) ? segments : [];
  if (!parts.length || !rootValue || typeof rootValue !== 'object') return rootValue;
  const out = cloneVariablePathValue(rootValue);
  let node = out;
  for (let index = 0; index < parts.length - 1; index += 1) {
    node = node?.[parts[index]];
    if (!node || typeof node !== 'object') return out;
  }
  const last = parts[parts.length - 1];
  if (Array.isArray(node) && typeof last === 'number') {
    node.splice(last, 1);
  } else {
    delete node[last];
  }
  return out;
};

export const getSortedVariableTreeChildren = (node) => {
  const list = Array.from(node?.children?.values?.() || []);
  return list.sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });
};

export const variableTreeNodeMatches = (node, rawTerm = '') => {
  const term = String(rawTerm || '').trim().toLowerCase();
  if (!term) return true;
  const text = `${node?.path || ''} ${node?.name || ''} ${formatVariableTreeValue(node?.value)}`.toLowerCase();
  if (text.includes(term)) return true;
  for (const child of node?.children?.values?.() || []) {
    if (variableTreeNodeMatches(child, term)) return true;
  }
  return false;
};

export const normalizeVariableScope = value => (
  String(value || '').trim() === 'global' ? 'global' : 'session'
);

export const resolveVariablePanelScope = ({
  sessionId = '',
  getVariableScope = null,
} = {}) => {
  const sid = String(sessionId || '').trim();
  let rawScope = 'session';
  try {
    rawScope = typeof getVariableScope === 'function' ? getVariableScope(sid) : 'session';
  } catch {}
  return { sid, scope: normalizeVariableScope(rawScope) };
};

export const formatVariableScopeLabel = ({ scope = 'session', sessionId = '' } = {}) => {
  const normalizedScope = normalizeVariableScope(scope);
  const sid = String(sessionId || '').trim();
  if (normalizedScope === 'global') return '全局变量（所有会话共享）';
  return sid ? `当前会话「${sid}」` : '当前会话';
};

export const buildVariableScopeImpactText = ({
  scope = 'session',
  sessionId = '',
  action = 'manage',
} = {}) => {
  const normalizedScope = normalizeVariableScope(scope);
  const target = formatVariableScopeLabel({ scope: normalizedScope, sessionId });
  const storesRules = normalizedScope !== 'global';
  if (action === 'edit') {
    return `影响范围：${target}。已有变量的当前值会即时写入；新建变量${storesRules ? '、类型与展示配置' : ''}需点击保存。取消或关闭不会回滚已即时写入的值${storesRules ? '，也不会保存尚未提交的配置草稿' : ''}。`;
  }
  if (action === 'rules') {
    return `影响范围：${target}。启用的规则可能在后续消息中自动修改变量、切换角色或注入提示词；关闭窗口不会运行规则，停用或删除规则可停止后续影响。`;
  }
  if (action === 'templates') {
    return `影响范围：${target}。应用模板会一次写入多项会话变量；取消覆盖确认不会写入，应用前可先导出备份。`;
  }
  if (action === 'import') {
    const extra = storesRules ? '、Schema 与规则' : '';
    return `影响范围：${target}。合并导入会写入同名变量${extra}；覆盖导入会先清空当前范围再写入。建议先导出备份，关闭窗口或取消确认不会写入。`;
  }
  if (action === 'export') {
    return `影响范围：${target}。导出为只读复制，不会修改变量；可作为导入或覆盖前的回退备份。`;
  }
  if (action === 'delete') {
    return `影响范围：${target}。删除后相关提示词、世界书条件和脚本读取会失去该变量；取消确认不会删除，可通过导入备份恢复。`;
  }
  if (action === 'clear') {
    return `影响范围：${target}。清空会删除当前范围内的变量值；取消确认不会删除，建议先导出备份。`;
  }
  return `影响范围：${target}。变量会影响后续提示词、世界书条件和脚本读取；关闭面板不会撤销已保存内容，导出可作为回退备份。`;
};

export const inferVariableValueType = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'string';
};

export const isVariableValueFilled = value => (
  value !== undefined
  && value !== null
  && !(typeof value === 'string' && value.trim() === '')
);

const normalizeVariableFilter = value => (
  ['filled', 'empty'].includes(String(value || '').trim()) ? String(value).trim() : 'all'
);

const normalizeVariableSort = value => (
  String(value || '').trim() === 'updated' ? 'updated' : 'name'
);

export const buildVariableListRows = ({
  vars = {},
  schemas = {},
  term = '',
  filter = 'all',
  sort = 'name',
  updatedAtByKey = {},
} = {}) => {
  const query = String(term || '').trim().toLowerCase();
  const normalizedFilter = normalizeVariableFilter(filter);
  const normalizedSort = normalizeVariableSort(sort);
  const rows = Object.entries(vars || {}).map(([rawKey, value], index) => {
    const key = String(rawKey);
    const valueText = value === null || value === undefined ? '' : String(value);
    return {
      key,
      value,
      valueText,
      schema: schemas?.[key] || null,
      filled: isVariableValueFilled(value),
      updatedAt: Number(updatedAtByKey?.[key] || 0) || 0,
      index,
    };
  }).filter((row) => {
    if (normalizedFilter === 'filled' && !row.filled) return false;
    if (normalizedFilter === 'empty' && row.filled) return false;
    if (!query) return true;
    return row.key.toLowerCase().includes(query) || row.valueText.toLowerCase().includes(query);
  });

  rows.sort((left, right) => {
    if (normalizedSort === 'updated' && left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    const byName = left.key.localeCompare(right.key);
    return byName || left.index - right.index;
  });
  return rows;
};

export const getVariableRenderSlice = ({
  rows = [],
  limit = 80,
  batchSize = 80,
} = {}) => {
  const list = Array.isArray(rows) ? rows : [];
  const normalizedBatchSize = Math.max(1, Math.trunc(Number(batchSize) || 80));
  const normalizedLimit = Math.max(
    normalizedBatchSize,
    Math.trunc(Number(limit) || normalizedBatchSize),
  );
  const rendered = Math.min(list.length, normalizedLimit);
  return {
    rows: list.slice(0, rendered),
    rendered,
    total: list.length,
    hasMore: rendered < list.length,
    nextLimit: Math.min(list.length, normalizedLimit + normalizedBatchSize),
    // 加载过第一批之后可以收起回第一批
    canCollapse: rendered > normalizedBatchSize,
  };
};

export const resolveNextEnumValue = (currentValue, rawOptions = []) => {
  const options = Array.isArray(rawOptions)
    ? rawOptions.map(option => String(option)).filter(Boolean)
    : [];
  if (!options.length) return '';
  const current = String(currentValue ?? '');
  const index = options.indexOf(current);
  return options[(index + 1 + options.length) % options.length];
};
