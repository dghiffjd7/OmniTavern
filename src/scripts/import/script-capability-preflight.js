// 判定规则改了就加一，已存的判定结果会重新计算
export const SCRIPT_COMPATIBILITY_VERSION = 2;

const scanJavascriptSource = (value) => {
  const source = String(value || '');
  const code = source.split('');
  const strings = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      code[index] = ' ';
      code[index + 1] = ' ';
      index += 2;
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        code[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '/' && next === '*') {
      code[index] = ' ';
      code[index + 1] = ' ';
      index += 2;
      while (index < source.length) {
        if (source[index] === '*' && source[index + 1] === '/') {
          code[index] = ' ';
          code[index + 1] = ' ';
          index += 2;
          break;
        }
        if (source[index] !== '\n' && source[index] !== '\r') code[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      let content = '';
      code[index] = ' ';
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === '\\') {
          content += current;
          code[index] = ' ';
          index += 1;
          if (index < source.length) {
            content += source[index];
            if (source[index] !== '\n' && source[index] !== '\r') code[index] = ' ';
            index += 1;
          }
          continue;
        }
        if (current === quote) {
          code[index] = ' ';
          index += 1;
          break;
        }
        content += current;
        if (current !== '\n' && current !== '\r') code[index] = ' ';
        index += 1;
      }
      strings.push(content);
      continue;
    }
    index += 1;
  }
  return { code: code.join(''), strings };
};

export const hasTopLevelAwait = (value) => {
  const source = String(value || '');
  const { code } = scanJavascriptSource(source);
  if (!/\bawait\b/.test(code)) return false;
  try {
    // 仅编译、不执行。合法 async function 内的 await 可通过；顶层 await 会得到稳定的语法错误。
    Function(source);
    return false;
  } catch (error) {
    const message = String(error?.message || error || '');
    return /await is only valid|unexpected reserved word/i.test(message);
  }
};

// 脚本运行时据此把脚本交给隔离 iframe（模块环境）而不是 Worker；导入兼容报告也按它判断运行环境
// 只解析、不执行：让 JS 引擎判断能不能当一般脚本（函数主体）编译。SyntaxError 回 false，其他错误（例如环境不允许 eval）回 null。
const compilesAsClassicScript = (text) => {
  try {
    new Function(text);
    return true;
  } catch (error) {
    return error instanceof SyntaxError ? false : null;
  }
};
// 同一份代码只编译一次（运行时每次同步都会判断）
const classicCompileCache = new Map();
const classicCompileOf = (text) => {
  if (classicCompileCache.has(text)) return classicCompileCache.get(text);
  const result = compilesAsClassicScript(text);
  classicCompileCache.set(text, result);
  if (classicCompileCache.size > 32) classicCompileCache.delete(classicCompileCache.keys().next().value);
  return result;
};

export const isModuleLikeScript = (content, compatibility = null) => {
  const text = String(content || '');
  if (!text) return false;
  // 只认语句起点的模块语法：脚本内嵌 HTML/字符串里的 `id="btn-import"`、`bam-btn-export`
  // 一类字面量不能把普通 worker 脚本改判进 iframe（iframe API 面更窄，误判会静默丢功能）。
  const moduleSyntax = /(^|[;{}()\n])\s*import\s*(?:['"]|\{|\*|[\w$]+\s+from\s)/.test(text)
    || /(^|[;{}()\n])\s*export\s*(?:default\s|const\s|let\s|var\s|function[\s(*]|class\s|async\s|\{|\*)/.test(text);
  // 文字规则命中时再请 JS 引擎确认：能当一般脚本编译，表示 import／export 只出现在字串、模板字串或正则里
  // （11/20：内嵌了 `import … from '/scripts/…'` 模板字串的脚本被误判成模块，进了 base 指向 CDN 的 iframe）。
  if (moduleSyntax) return classicCompileOf(text) !== true;
  if (typeof compatibility?.signals?.topLevelAwait === 'boolean') {
    return compatibility.signals.topLevelAwait;
  }
  return hasTopLevelAwait(text);
};

const getScriptContent = (scriptOrContent) => (
  scriptOrContent && typeof scriptOrContent === 'object'
    ? String(scriptOrContent.content || '')
    : String(scriptOrContent || '')
);

export const analyzeScriptCompatibility = (scriptOrContent = '') => {
  const content = getScriptContent(scriptOrContent);
  const { code, strings } = scanJavascriptSource(content);
  const referencesHostWindow = /\b(?:window|globalThis)\s*\.\s*(?:parent|top)\b|\b(?:parent|top)\s*(?:\?\.)?\s*\.\s*document\b/.test(code);
  const accessesDocument = /(?:\.|\?\.)\s*document\b|\bdocument\s*\./.test(code);
  const hostDomAccess = referencesHostWindow && accessesDocument;
  const hasRemoteUrl = strings.some(text => /https?:\/\/|\b(?:cdn|fastly|gcore)\.jsdelivr\.net\b|\bgithub(?:usercontent)?\.com\b/i.test(text));
  const createsDomAsset = /(?:\.|\?\.)\s*createElement\s*\(/.test(code);
  const assignsAssetUrl = /(?:\.|\?\.)\s*(?:src|href)\s*=/.test(code);
  const injectsDomAsset = /(?:\.|\?\.)\s*(?:appendChild|append|prepend|insertBefore)\s*\(/.test(code);
  const remoteAssetLoader = hasRemoteUrl && createsDomAsset && assignsAssetUrl && injectsDomAsset;
  // saveSettingsDebounced 由 SillyTavern.getContext() 提供（酒馆助手脚本常经 context 呼叫），不当作外部扩展的信号
  const nativeExtensionApi = /\b(?:AutoCardUpdaterAPI|extension_settings|registerExtension)\b/.test(code);
  const topLevelAwait = hasTopLevelAwait(content);
  const reasons = [];
  if (hostDomAccess) reasons.push('host_dom_access');
  if (remoteAssetLoader) reasons.push('remote_asset_loader');
  if (topLevelAwait) reasons.push('top_level_await');
  if (nativeExtensionApi) reasons.push('native_extension_api');
  const blocked = hostDomAccess && (remoteAssetLoader || nativeExtensionApi);
  const level = blocked
    ? 'external_extension'
    : hostDomAccess
      ? 'sandbox_limited'
      : topLevelAwait
        ? 'module'
        : 'standard';
  const fingerprint = `${level}:${reasons.join('+') || 'none'}`;
  let message = '';
  if (blocked) {
    message = '该脚本需要作为 SillyTavern 外部扩展安装；它请求宿主页面权限并加载扩展资源，OmniTavern 已保留记录但不会启用。';
  } else if (level === 'sandbox_limited') {
    message = '该脚本会访问宿主页面 DOM；OmniTavern 只会在隔离沙箱中运行，部分界面功能可能不可用。';
  } else if (level === 'module') {
    message = '该脚本使用顶层 await，将在隔离模块环境中运行。';
  }
  return {
    version: SCRIPT_COMPATIBILITY_VERSION,
    level,
    blocked,
    reasons,
    signals: {
      topLevelAwait,
      hostDomAccess,
      remoteAssetLoader,
      nativeExtensionApi,
    },
    fingerprint,
    message,
  };
};

const isCurrentScriptCompatibility = (value) => (
  value &&
  typeof value === 'object' &&
  Number(value.version) === SCRIPT_COMPATIBILITY_VERSION &&
  typeof value.level === 'string' &&
  typeof value.blocked === 'boolean' &&
  Array.isArray(value.reasons) &&
  value.signals &&
  typeof value.signals === 'object' &&
  typeof value.signals.topLevelAwait === 'boolean' &&
  typeof value.fingerprint === 'string'
);

export const resolveScriptCompatibility = (scriptOrContent = '') => {
  if (
    scriptOrContent &&
    typeof scriptOrContent === 'object' &&
    isCurrentScriptCompatibility(scriptOrContent.compatibility)
  ) {
    return scriptOrContent.compatibility;
  }
  return analyzeScriptCompatibility(scriptOrContent);
};

const MISSING_IDENTIFIER_PATTERNS = [
  /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+is not defined/,
  /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s+is not a function/,
  /Cannot read propert(?:y|ies) of (?:undefined|null) \(reading '([^']+)'\)/,
  /undefined is not an object \(evaluating '([^']+)'\)/,
];

export const extractMissingApiIdentifier = (value) => {
  const message = String(value || '');
  for (const pattern of MISSING_IDENTIFIER_PATTERNS) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].slice(0, 80);
  }
  return '';
};

// worker 诊断与 iframe compat-gap 共用的唯一错误分类器；API 形状类判定放在
// sandbox_boundary 之前——compat-gap 的 candidate→confirmed 关联依赖 api_shape 优先。
export const classifyScriptRuntimeErrorCategory = (value) => {
  const message = String(value || '');
  if (/await is only valid|unexpected reserved word/i.test(message)) return 'syntax_top_level_await';
  if (/is not a function/i.test(message)) return 'api_shape';
  if (/is not defined/i.test(message)) return 'missing_global';
  if (/cannot read propert(?:y|ies) of (?:undefined|null)/i.test(message)) return 'missing_value';
  if (/blocked a frame|cross-origin|permission denied|securityerror|sandbox/i.test(message)) return 'sandbox_boundary';
  if (/failed to fetch|networkerror|content security policy|\bcsp\b/i.test(message)) return 'network_policy';
  if (/syntaxerror|unexpected token|unexpected identifier/i.test(message)) return 'syntax';
  return 'runtime';
};

const classifyRuntimeError = classifyScriptRuntimeErrorCategory;

export const buildScriptRuntimeErrorDiagnostic = ({
  scriptId = '',
  phase = 'runtime',
  error = '',
  compatibility = null,
} = {}) => {
  const normalizedScriptId = String(scriptId || 'unknown-script').trim() || 'unknown-script';
  const normalizedPhase = String(phase || 'runtime').trim().toLowerCase() || 'runtime';
  const normalizedCompatibility = compatibility && typeof compatibility === 'object'
    ? compatibility
    : analyzeScriptCompatibility('');
  const compatibilityFingerprint = String(normalizedCompatibility.fingerprint || 'standard:none');
  const category = classifyRuntimeError(error);
  const identifier = extractMissingApiIdentifier(error);
  return {
    category,
    identifier,
    signature: `${normalizedScriptId}:${normalizedPhase}:${category}${identifier ? `:${identifier}` : ''}:${compatibilityFingerprint}`,
  };
};
