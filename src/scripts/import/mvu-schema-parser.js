/**
 * MVU Zod Schema 解析器
 *
 * 解析酒馆 MVU 脚本中的 Zod Schema 定义，提取变量结构。
 * 不执行脚本，只静态分析 Schema 定义部分。
 */

/**
 * 创建一个"记录型" Zod 模拟对象
 * 不做实际验证，只记录 Schema 结构
 */
const createZodRecorder = () => {
  const createChain = (type, extra = {}) => {
    const info = { _type: type, ...extra };

    const chain = {
      // 获取记录的信息
      _getInfo: () => info,

      // 常用方法
      prefault: (val) => {
        info._default = val;
        return chain;
      },
      default: (val) => {
        info._default = val;
        return chain;
      },
      describe: (desc) => {
        info._description = desc;
        return chain;
      },
      transform: (fn) => {
        // 尝试从 transform 函数中提取范围信息
        try {
          const fnStr = fn.toString();
          // 匹配 _.clamp(v, min, max)
          const clampMatch = fnStr.match(/clamp\s*\([^,]+,\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
          if (clampMatch) {
            info._range = {
              min: parseFloat(clampMatch[1]),
              max: parseFloat(clampMatch[2]),
            };
          }
          // 匹配 _.max([min, v]) 形式 (下限)
          const maxMatch = fnStr.match(/max\s*\(\s*\[\s*(-?\d+(?:\.\d+)?)/);
          if (maxMatch && !info._range) {
            info._range = { min: parseFloat(maxMatch[1]), max: null };
          }
        } catch {}
        return chain;
      },
      optional: () => {
        info._optional = true;
        return chain;
      },
      nullable: () => {
        info._nullable = true;
        return chain;
      },
      // 其他常见方法（返回 chain 保持链式调用）
      min: (val) => { info._min = val; return chain; },
      max: (val) => { info._max = val; return chain; },
      length: (val) => { info._length = val; return chain; },
      email: () => chain,
      url: () => chain,
      uuid: () => chain,
      regex: () => chain,
      trim: () => chain,
      toLowerCase: () => chain,
      toUpperCase: () => chain,
      int: () => chain,
      positive: () => { info._range = { ...(info._range || {}), min: 0 }; return chain; },
      negative: () => { info._range = { ...(info._range || {}), max: 0 }; return chain; },
      nonnegative: () => { info._range = { ...(info._range || {}), min: 0 }; return chain; },
      nonpositive: () => { info._range = { ...(info._range || {}), max: 0 }; return chain; },
      finite: () => chain,
      safe: () => chain,
      // 校验类方法只影响运行期校验，记录结构时不调用回调
      refine: () => chain,
      superRefine: () => chain,
      catch: (val) => {
        if (!('_default' in info)) info._default = val;
        return chain;
      },
    };

    return chain;
  };

  const z = {
    // 基本类型
    string: () => createChain('string'),
    number: () => createChain('number'),
    boolean: () => createChain('boolean'),
    bigint: () => createChain('bigint'),
    date: () => createChain('date'),
    undefined: () => createChain('undefined'),
    null: () => createChain('null'),
    void: () => createChain('void'),
    any: () => createChain('any'),
    unknown: () => createChain('unknown'),
    never: () => createChain('never'),

    // 复合类型
    object: (shape) => createChain('object', { _shape: shape }),
    array: (itemType) => createChain('array', { _itemType: itemType }),
    tuple: (...items) => createChain('tuple', { _items: items }),
    record: (keyType, valueType) => createChain('record', { _keyType: keyType, _valueType: valueType }),
    map: (keyType, valueType) => createChain('map', { _keyType: keyType, _valueType: valueType }),
    set: (itemType) => createChain('set', { _itemType: itemType }),

    // 枚举和联合
    enum: (values) => createChain('enum', { _options: values }),
    nativeEnum: (enumObj) => createChain('nativeEnum', { _enumObj: enumObj }),
    union: (...types) => createChain('union', { _types: types }),
    discriminatedUnion: (key, types) => createChain('discriminatedUnion', { _key: key, _types: types }),
    intersection: (...types) => createChain('intersection', { _types: types }),

    // 特殊类型
    literal: (value) => createChain('literal', { _value: value }),
    promise: (inner) => createChain('promise', { _inner: inner }),
    function: () => createChain('function'),
    lazy: (getter) => createChain('lazy', { _getter: getter }),
    // 预处理只改运行期输入，结构取第二个参数
    preprocess: (_fn, schema) => schema || createChain('any'),

    // coerce 系列
    coerce: {
      string: () => createChain('string', { _coerce: true }),
      number: () => createChain('number', { _coerce: true }),
      boolean: () => createChain('boolean', { _coerce: true }),
      bigint: () => createChain('bigint', { _coerce: true }),
      date: () => createChain('date', { _coerce: true }),
    },

    // 辅助方法
    optional: (inner) => {
      const chain = inner || createChain('any');
      if (chain._getInfo) chain._getInfo()._optional = true;
      return chain;
    },
    nullable: (inner) => {
      const chain = inner || createChain('any');
      if (chain._getInfo) chain._getInfo()._nullable = true;
      return chain;
    },

    // 扩展方法（兼容 MVU 使用的自定义方法）
    looseObject: (shape) => createChain('object', { _shape: shape, _loose: true }),
  };

  return z;
};

/**
 * 创建模拟的 lodash 对象
 */
const createLodashMock = () => ({
  clamp: (val, min, max) => Math.min(Math.max(val, min), max),
  max: (arr) => Array.isArray(arr) ? Math.max(...arr) : arr,
  min: (arr) => Array.isArray(arr) ? Math.min(...arr) : arr,
  get: (obj, path, def) => {
    const keys = typeof path === 'string' ? path.split('.') : path;
    let result = obj;
    for (const key of keys) {
      if (result == null) return def;
      result = result[key];
    }
    return result === undefined ? def : result;
  },
  set: (obj, path, value) => {
    const keys = typeof path === 'string' ? path.split('.') : path;
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    return obj;
  },
  // 结构定义时常用的几个（MVU 脚本里 lodash 是全局的）
  mapValues: (obj, fn) => Object.fromEntries(Object.entries(obj || {})
    .map(([key, value]) => [key, typeof fn === 'function' ? fn(value, key, obj) : value?.[fn]])),
  uniq: (arr) => [...new Set(Array.isArray(arr) ? arr : [])],
  pick: (obj, ...keys) => Object.fromEntries(keys.flat()
    .filter(key => obj && Object.prototype.hasOwnProperty.call(obj, key))
    .map(key => [key, obj[key]])),
  pickBy: (obj, fn = Boolean) => Object.fromEntries(Object.entries(obj || {}).filter(([key, value]) => fn(value, key))),
  omit: (obj, ...keys) => {
    const drop = new Set(keys.flat());
    return Object.fromEntries(Object.entries(obj || {}).filter(([key]) => !drop.has(key)));
  },
});

// ---- 代码扫描：跳过字符串、模板字符串、注释与正则字面量，按括号配对 ----
const IDENT_CHAR_RE = /[\w$\u4e00-\u9fff]/;
const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_PREFIX_WORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|throw)$/;

// 返回非代码片段（字符串、注释、正则）的结束位置；i 处不是这类片段时返回 -1
const skipNonCode = (source, i, lastSignificant = '', before = '') => {
  const ch = source[i];
  const next = source[i + 1];
  if (ch === '/' && next === '/') {
    const end = source.indexOf('\n', i);
    return end < 0 ? source.length : end;
  }
  if (ch === '/' && next === '*') {
    const end = source.indexOf('*/', i + 2);
    return end < 0 ? source.length : end + 2;
  }
  if (ch === '"' || ch === "'") {
    for (let j = i + 1; j < source.length; j += 1) {
      if (source[j] === '\\') { j += 1; continue; }
      if (source[j] === ch || source[j] === '\n') return j + 1;
    }
    return source.length;
  }
  if (ch === '`') {
    for (let j = i + 1; j < source.length; j += 1) {
      if (source[j] === '\\') { j += 1; continue; }
      if (source[j] === '`') return j + 1;
      if (source[j] === '$' && source[j + 1] === '{') {
        const close = findMatchingBracket(source, j + 1);
        if (close < 0) return source.length;
        j = close;
      }
    }
    return source.length;
  }
  if (ch === '/' && (!lastSignificant || REGEX_PREFIX_CHARS.includes(lastSignificant) || REGEX_PREFIX_WORDS.test(before))) {
    let inClass = false;
    for (let j = i + 1; j < source.length; j += 1) {
      const c = source[j];
      if (c === '\\') { j += 1; continue; }
      if (c === '\n') return -1;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        let k = j + 1;
        while (k < source.length && /[a-z]/i.test(source[k])) k += 1;
        return k;
      }
    }
  }
  return -1;
};

// 逐字遍历代码，跳过非代码片段；visit 返回 false 时停止
const walkCode = (source, start, visit) => {
  let lastSignificant = '';
  for (let i = start; i < source.length; i += 1) {
    const skipped = skipNonCode(source, i, lastSignificant, source.slice(Math.max(0, i - 12), i).trimEnd());
    if (skipped > i) {
      if (source[i] !== '/' || source[i + 1] === '/' || source[i + 1] === '*') {
        if (source[i] === '"' || source[i] === "'" || source[i] === '`') lastSignificant = 'a';
      } else {
        lastSignificant = 'a';
      }
      if (visit(i, null, skipped) === false) return;
      i = skipped - 1;
      continue;
    }
    const ch = source[i];
    if (visit(i, ch) === false) return;
    if (!/\s/.test(ch)) lastSignificant = IDENT_CHAR_RE.test(ch) ? 'a' : ch;
  }
};

const OPEN_BRACKETS = { '(': ')', '[': ']', '{': '}' };

// openIndex 处是 ( [ {，返回配对的结束括号位置
function findMatchingBracket(source, openIndex) {
  let depth = 0;
  let result = -1;
  walkCode(source, openIndex, (i, ch) => {
    if (!ch) return true;
    if (OPEN_BRACKETS[ch]) depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) { result = i; return false; }
    }
    return true;
  });
  return result;
}

// 从 start 读一个完整表达式：到顶层分号、顶层换行后接新语句，或遇到外层的结束括号为止
const readExpression = (source, start) => {
  let depth = 0;
  let end = source.length;
  const CONTINUE_RE = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*([.?)\]},+\-*\/&|:=<>%^])/;
  walkCode(source, start, (i, ch) => {
    if (!ch) return true;
    if (OPEN_BRACKETS[ch]) depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) { end = i; return false; }
      depth -= 1;
    } else if (depth === 0 && ch === ';') {
      end = i;
      return false;
    } else if (depth === 0 && ch === '\n') {
      const before = source.slice(start, i).trimEnd();
      const lastChar = before[before.length - 1] || '';
      if (before && !'=([{,+-*/&|?:<>%^!'.includes(lastChar) && !CONTINUE_RE.test(source.slice(i))) {
        end = i;
        return false;
      }
    }
    return true;
  });
  return source.slice(start, end).trim();
};

// 展开 $(() => { ... }) / $(function () { ... }) 包装（按括号配对，避免被内部的 }) 截断）
const unwrapReadyCallbacks = (source) => {
  let out = source;
  const re = /\$\s*\(\s*(?:\(\s*\)\s*=>|function\s*\(\s*\))\s*\{/g;
  let m;
  while ((m = re.exec(out))) {
    const braceIndex = m.index + m[0].length - 1;
    const close = findMatchingBracket(out, braceIndex);
    const tail = close < 0 ? null : out.slice(close + 1).match(/^\s*\)\s*;?/);
    if (!tail) { re.lastIndex = braceIndex + 1; continue; }
    out = `${out.slice(0, m.index)}${out.slice(braceIndex + 1, close)}${out.slice(close + 1 + tail[0].length)}`;
    re.lastIndex = m.index;
  }
  return out;
};

// 只收集最外层的 const/let/var/function 声明
const collectTopLevelDeclarations = (source) => {
  const declarations = [];
  let depth = 0;
  const DECL_RE = /^(?:export\s+)?(?:(?:const|let|var)\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*=(?!=)|function\s+([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*\()/;
  walkCode(source, 0, (i, ch, skipEnd) => {
    if (!ch) return true;
    if (OPEN_BRACKETS[ch]) { depth += 1; return true; }
    if (ch === ')' || ch === ']' || ch === '}') { depth = Math.max(0, depth - 1); return true; }
    if (depth !== 0 || (i > 0 && IDENT_CHAR_RE.test(source[i - 1])) || !/[ecflv]/.test(ch)) return true;
    const m = source.slice(i, i + 200).match(DECL_RE);
    if (!m) return true;
    const name = m[1] || m[2];
    if (m[1]) {
      const exprStart = i + m[0].length;
      const expression = readExpression(source, exprStart);
      declarations.push({ name, start: i, text: `const ${name} = ${expression};`, expression });
    } else {
      const braceIndex = source.indexOf('{', source.indexOf(')', i + m[0].length - 1));
      const close = braceIndex < 0 ? -1 : findMatchingBracket(source, braceIndex);
      if (close > 0) declarations.push({ name, start: i, text: source.slice(i, close + 1).replace(/^export\s+/, ''), expression: source.slice(i, close + 1) });
    }
    return true;
  });
  return declarations;
};

// 结构引用到的顶层辅助声明（递归）；含网络、页面、事件等副作用的不带进来
const SCHEMA_HELPER_SIDE_EFFECT_RE = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|import|require|document|window|globalThis|self|parent|top|location|navigator|localStorage|sessionStorage|indexedDB|postMessage|setTimeout|setInterval|eventOn|eventEmit|triggerSlash|Function|eval)\b|\$\s*\(/;
const collectSchemaHelpers = (source, expression, excludeNames = []) => {
  const declarations = collectTopLevelDeclarations(source).filter(item => !excludeNames.includes(item.name));
  const picked = new Map();
  const queue = [expression];
  const referencedNames = (text) => declarations
    .filter(item => !picked.has(item.name))
    .filter(item => new RegExp(`(?<![.\\w$\\u4e00-\\u9fff])${item.name.replace(/\$/g, '\\$')}(?![\\w$\\u4e00-\\u9fff])(?!\\s*:(?!:))`).test(text));
  // 每个声明最多收一次，队列自然会结束
  while (queue.length && picked.size < declarations.length) {
    const text = queue.shift();
    referencedNames(text).forEach((item) => {
      if (SCHEMA_HELPER_SIDE_EFFECT_RE.test(item.expression)) return;
      picked.set(item.name, item);
      queue.push(item.expression);
    });
  }
  return [...picked.values()].sort((a, b) => a.start - b.start).map(item => item.text);
};

// 移除 import 语句，展开 $(() => { ... }) 包装
const cleanSchemaScript = (content) => {
  let cleaned = String(content || '').replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*/g, '');
  cleaned = cleaned.replace(/import\s+['"][^'"]+['"];?\s*/g, '');
  return unwrapReadyCallbacks(cleaned);
};

/**
 * 从脚本内容中提取 Schema 定义部分
 */
const extractSchemaCode = (content) => {
  const cleaned = cleanSchemaScript(content);

  const findCallArgs = (source, fnName) => {
    if (!source || !fnName) return null;
    const re = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(source))) {
      const start = m.index + m[0].length;
      let depth = 0;
      let inQuote = '';
      for (let i = start; i < source.length; i += 1) {
        const ch = source[i];
        const prev = i > 0 ? source[i - 1] : '';
        if (inQuote) {
          if (ch === inQuote && prev !== '\\') inQuote = '';
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          inQuote = ch;
          continue;
        }
        if (ch === '(') depth += 1;
        if (ch === ')') {
          if (depth === 0) {
            return source.slice(start, i);
          }
          depth -= 1;
        }
      }
    }
    return null;
  };

  const splitArgs = (text) => {
    const args = [];
    let buf = '';
    let inQuote = '';
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const prev = i > 0 ? text[i - 1] : '';
      if (inQuote) {
        buf += ch;
        if (ch === inQuote && prev !== '\\') inQuote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inQuote = ch;
        buf += ch;
        continue;
      }
      if (ch === '(') paren += 1;
      if (ch === ')') paren -= 1;
      if (ch === '[') bracket += 1;
      if (ch === ']') bracket -= 1;
      if (ch === '{') brace += 1;
      if (ch === '}') brace -= 1;
      if (ch === ',' && paren === 0 && bracket === 0 && brace === 0) {
        const trimmed = buf.trim();
        if (trimmed) args.push(trimmed);
        buf = '';
        continue;
      }
      buf += ch;
    }
    const trimmed = buf.trim();
    if (trimmed) args.push(trimmed);
    return args;
  };

  // 按括号配对读完整个赋值表达式（回调里的 const/let 不会把它截断）
  const findAssignedExpression = (name) => {
    const key = String(name || '').trim();
    if (!key) return null;
    const declaration = collectTopLevelDeclarations(cleaned).find(item => item.name === key && item.text.startsWith('const '));
    return declaration ? declaration.expression || null : null;
  };

  const resolveSchemaExpr = (expr) => {
    const rawExpr = String(expr || '').trim();
    if (!rawExpr) return null;
    if (/^z\./.test(rawExpr) || /^zod\./.test(rawExpr)) return rawExpr;
    if (/^[A-Za-z_$][\w$]*$/.test(rawExpr)) {
      const assigned = findAssignedExpression(rawExpr);
      if (assigned) return assigned;
    }
    return rawExpr;
  };

  const registerMvuArgs = findCallArgs(cleaned, 'registerMvuSchema');
  if (registerMvuArgs) {
    const args = splitArgs(registerMvuArgs);
    if (args.length) {
      const resolved = resolveSchemaExpr(args[0]);
      if (resolved) return resolved;
    }
  }

  const registerVarArgs = findCallArgs(cleaned, 'registerVariableSchema');
  if (registerVarArgs) {
    const args = splitArgs(registerVarArgs);
    if (args.length) {
      const expr = String(args[0] || '').trim();
      const statMatch = expr.match(/stat_data\s*:\s*([A-Za-z_$][\w$]*)\s*(?:[,}])/);
      if (statMatch) {
        const assigned = findAssignedExpression(statMatch[1]);
        if (assigned) return assigned;
      }
      const statDataMatch = expr.match(/statData\s*:\s*([A-Za-z_$][\w$]*)\s*(?:[,}])/);
      if (statDataMatch) {
        const assigned = findAssignedExpression(statDataMatch[1]);
        if (assigned) return assigned;
      }
      const resolved = resolveSchemaExpr(expr);
      if (resolved) return resolved;
    }
  }

  // 尝试提取 (export) const Schema = z.object({...})
  const schemaAssigned = findAssignedExpression('Schema');
  if (schemaAssigned) {
    const resolved = resolveSchemaExpr(schemaAssigned);
    if (resolved) return resolved;
  }

  // 尝试提取任何 z.object({...}) 形式
  const objectMatch = cleaned.match(/(z\.object\s*\(\s*\{[\s\S]*\}\s*\))/);
  if (objectMatch) {
    return objectMatch[1];
  }

  return null;
};

/**
 * 将记录的 Schema 信息转换为我们的原生格式
 */
const convertToNativeSchema = (info, path = []) => {
  if (!info || typeof info !== 'object') return null;

  // 获取 _getInfo() 的结果（如果是 chain 对象）
  const data = typeof info._getInfo === 'function' ? info._getInfo() : info;

  const type = data._type || 'string';
  const result = {
    type: mapType(type),
    default: data._default,
    description: data._description || null,
    range: data._range || null,
    options: data._options || null,
    optional: data._optional || false,
    nullable: data._nullable || false,
  };

  // 处理嵌套对象
  if (type === 'object' && data._shape) {
    result.properties = {};
    Object.entries(data._shape).forEach(([key, value]) => {
      const nested = convertToNativeSchema(value, [...path, key]);
      if (nested) {
        result.properties[key] = nested;
      }
    });
  }

  // 处理 record 类型
  if (type === 'record' && data._valueType) {
    result.valueSchema = convertToNativeSchema(data._valueType, [...path, '*']);
  }

  // 处理数组类型
  if (type === 'array' && data._itemType) {
    result.itemSchema = convertToNativeSchema(data._itemType, [...path, '[]']);
  }

  return result;
};

/**
 * 映射 Zod 类型到我们的类型系统
 */
const mapType = (zodType) => {
  const mapping = {
    'string': 'string',
    'number': 'number',
    'boolean': 'boolean',
    'enum': 'enum',
    'object': 'object',
    'array': 'array',
    'record': 'object',
    'map': 'object',
    'set': 'array',
    'tuple': 'array',
    'bigint': 'number',
    'date': 'string',
    'literal': 'string',
    'union': 'string',
    'any': 'string',
    'unknown': 'string',
  };
  return mapping[zodType] || 'string';
};

/**
 * 将嵌套的 Schema 展平为变量列表
 */
const flattenSchema = (schema, prefix = '', results = { variables: {}, schemas: {} }) => {
  if (!schema || typeof schema !== 'object') return results;

  const type = schema.type || 'string';

  if (type === 'object' && schema.properties) {
    // 递归处理嵌套属性
    Object.entries(schema.properties).forEach(([key, value]) => {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      flattenSchema(value, fullPath, results);
    });
  } else {
    // 叶子节点 - 创建变量
    const varName = prefix || 'value';

    // 变量初始值
    const hasExplicitDefault = schema.default !== undefined;
    const defaultValue = hasExplicitDefault ? schema.default : getDefaultValue(type, schema);
    results.variables[varName] = defaultValue;

    // 变量 Schema
    results.schemas[varName] = {
      id: varName,
      name: varName.split('.').pop() || varName,
      type: type,
      default: defaultValue,
      defaultSource: hasExplicitDefault ? 'schema' : 'fallback',
      range: schema.range,
      options: schema.options,
      ui: inferUI(varName, type, schema),
    };
  }

  return results;
};

/**
 * 获取类型的默认值
 */
const getDefaultValue = (type, schema) => {
  switch (type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    case 'enum': return schema.options?.[0] || '';
    default: return '';
  }
};

/**
 * 推断 UI 配置
 */
const inferUI = (name, type, schema) => {
  const ui = {
    display: 'card',
    label: name.split('.').pop() || name,
    color: '',
    icon: '',
    format: '',
  };

  // 根据名称和类型推断显示方式
  const nameLower = name.toLowerCase();

  if (type === 'number') {
    if (schema.range && schema.range.min !== null && schema.range.max !== null) {
      ui.display = 'progress';
      ui.format = `{value}/${schema.range.max}`;
    }
    // 常见的进度类变量
    if (/好感|生命|体力|血量|饥饿|口渴|精神|心情|体温|hp|health|stamina|hunger|thirst/.test(nameLower)) {
      ui.display = 'progress';
      if (!schema.range) {
        ui.format = '{value}/100';
      }
    }
  }

  if (type === 'boolean') {
    ui.display = 'badge';
  }

  if (type === 'enum') {
    ui.display = 'badge';
  }

  // 根据名称推断图标
  if (/好感|爱|love|affection/.test(nameLower)) ui.icon = '❤️';
  if (/生命|血量|hp|health/.test(nameLower)) ui.icon = '💗';
  if (/体力|stamina/.test(nameLower)) ui.icon = '⚡';
  if (/金币|money|gold|coin/.test(nameLower)) ui.icon = '💰';
  if (/天气|weather/.test(nameLower)) ui.icon = '🌤️';
  if (/时间|time/.test(nameLower)) ui.icon = '🕐';
  if (/位置|location/.test(nameLower)) ui.icon = '📍';

  return ui;
};

/**
 * 解析 MVU 脚本内容，提取变量 Schema
 *
 * @param {string} scriptContent - 脚本内容（JSON 的 content 字段）
 * @returns {{ variables: object, schemas: object, rawSchema: object|null, error: string|null }}
 */
export const parseMvuScript = (scriptContent) => {
  const result = {
    variables: {},
    schemas: {},
    rawSchema: null,
    error: null,
  };

  try {
    const schemaCode = extractSchemaCode(scriptContent);
    if (!schemaCode) {
      result.error = '未找到 Schema 定义';
      return result;
    }

    // 创建沙箱环境
    const z = createZodRecorder();
    const _ = createLodashMock();
    // 结构引用的顶层辅助函数（不含副作用的）一起带上
    const helpers = collectSchemaHelpers(cleanSchemaScript(scriptContent), schemaCode, ['Schema', 'z', '_']);

    // 在沙箱中执行 Schema 定义
    // 使用 Function 构造器创建隔离的执行环境
    const sandbox = new Function('z', '_', `
      "use strict";
      try {
        ${helpers.join('\n')}
        return (${schemaCode});
      } catch (e) {
        return { _error: e.message };
      }
    `);

    const schemaResult = sandbox(z, _);

    if (schemaResult?._error) {
      result.error = `Schema 解析错误: ${schemaResult._error}`;
      return result;
    }

    // 转换为原生格式
    let nativeSchema = convertToNativeSchema(schemaResult);
    if (nativeSchema && nativeSchema.type === 'object' && nativeSchema.properties) {
      const statData = nativeSchema.properties.stat_data || nativeSchema.properties.statData;
      if (statData && typeof statData === 'object') {
        nativeSchema = statData;
      }
    }
    result.rawSchema = nativeSchema;

    // 展平为变量列表
    const flattened = flattenSchema(nativeSchema);
    result.variables = flattened.variables;
    result.schemas = flattened.schemas;

  } catch (err) {
    result.error = `解析失败: ${err.message || err}`;
  }

  return result;
};

/**
 * 检测脚本是否包含 Zod Schema 定义
 */
export const hasZodSchema = (scriptContent) => {
  const raw = String(scriptContent || '');
  return /z\.object\s*\(/.test(raw) ||
    /export\s+const\s+Schema\s*=/.test(raw) ||
    /\bregisterMvuSchema\s*\(/.test(raw) ||
    /\bregisterVariableSchema\s*\(/.test(raw);
};

/**
 * 从 JS-Slash-Runner 脚本 JSON 中提取并解析 Schema
 */
export const parseScriptJson = (scriptJson) => {
  const result = {
    name: '',
    variables: {},
    schemas: {},
    rawSchema: null,
    error: null,
  };

  try {
    const data = typeof scriptJson === 'string' ? JSON.parse(scriptJson) : scriptJson;

    if (!data || typeof data !== 'object') {
      result.error = '无效的脚本 JSON';
      return result;
    }

    result.name = data.name || '';

    const content = data.content || '';
    if (!content) {
      result.error = '脚本内容为空';
      return result;
    }

    if (!hasZodSchema(content)) {
      result.error = '脚本中未找到 Zod Schema 定义';
      return result;
    }

    const parsed = parseMvuScript(content);
    result.variables = parsed.variables;
    result.schemas = parsed.schemas;
    result.rawSchema = parsed.rawSchema;
    result.error = parsed.error;

  } catch (err) {
    result.error = `JSON 解析失败: ${err.message || err}`;
  }

  return result;
};

export default {
  parseMvuScript,
  parseScriptJson,
  hasZodSchema,
};
