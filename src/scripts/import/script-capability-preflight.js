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
