import { t } from '../i18n/index.js';
import { isModuleLikeScript } from './script-capability-preflight.js';

// 导入兼容报告：从脚本代码认出它用到的酒馆功能，对照 APP 的实际支持情况。
// 只看代码（静态推测），不执行；认不准的写法宁可不报，也不误报。
// 支持表（TAVERN_FEATURE_SUPPORT）是唯一依据，APP 的支持范围改了只改这张表。

export const TAVERN_FEATURE_STATUS = Object.freeze({
  SUPPORTED: 'supported',
  PARTIAL: 'partial',
  UNSUPPORTED: 'unsupported',
});
const STATUS_RANK = Object.freeze({ supported: 0, partial: 1, unsupported: 2 });

// 脚本有两种运行环境（plugins/script-runtime.js）：一般脚本在 Worker，模块脚本（import／export／顶层 await）
// 在隔离 iframe。iframe 只提供变量、事件、宏与只读查询，没有 fetch 拦截、生成、世界书写入与虚拟页面；
// workerOnly 的项目在模块脚本里一律不支持。
export const TAVERN_FEATURE_SUPPORT = Object.freeze({
  // 酒馆后端接口：Worker 拦下 fetch 的相对路径交主程式路由（plugins/tavern-api-router.js）
  '/api/backends/chat-completions/status': {
    category: 'tavern_api', status: 'supported', workerOnly: true,
    impact: () => t('回传当前会话连线的模型清单（需要「访问网络」权限）；请求里指定的其他连线不生效。'),
  },
  '/api/backends/chat-completions/generate': {
    category: 'tavern_api', status: 'supported', workerOnly: true,
    impact: () => t('用当前会话的连线调用模型（需要「访问网络」权限），每个脚本第一次调用会先请你同意费用；请求里的 Key、反代与自订网址不生效。'),
  },
  '/api/tokenizers/openai/count': {
    category: 'tavern_api', status: 'supported', workerOnly: true,
    impact: () => t('token 数用 APP 本地估算，与酒馆算的可能略有出入。'),
  },
  '/api/worldinfo/list': {
    category: 'tavern_api', status: 'supported', workerOnly: true,
    impact: () => t('可列出 APP 里的世界书。'),
  },
  '/api/worldinfo/get': {
    category: 'tavern_api', status: 'supported', workerOnly: true,
    impact: () => t('可读取世界书内容（酒馆格式）。'),
  },
  '/api/worldinfo/edit': {
    category: 'tavern_api', status: 'supported', workerOnly: true,
    impact: () => t('整本写入世界书，每次写入都会先请你确认。'),
  },
  '/api/chats/get': {
    category: 'tavern_api', status: 'supported', workerOnly: true,
    impact: () => t('可读取当前会话的聊天记录（需要「读取聊天记录」权限）；读不到其他聊天文件。'),
  },
  '/api/settings/get': {
    category: 'tavern_api', status: 'partial', workerOnly: true,
    impact: () => t('只回当前对话预设的设定与脚本最近存过的预设，其他酒馆设定读不到；不含 Key 与连线地址。'),
  },
  '/api/presets/save': {
    category: 'tavern_api', status: 'partial', workerOnly: true,
    impact: () => t('只能修改 APP 里已有的对话预设（每次请你确认，需要「修改变量」权限）；不能新建预设，也不支持其他类型的预设。'),
  },
  'api:secrets': {
    category: 'tavern_api', status: 'unsupported',
    impact: () => t('APP 不把 API Key 交给脚本，依赖它的功能无法使用。'),
  },
  'api:other': {
    category: 'tavern_api', status: 'unsupported', workerOnly: true,
    impact: () => t('APP 没有这个酒馆接口，依赖它的脚本功能无法使用；实际调用时会记进兼容缺口。'),
  },
  generate: {
    category: 'generation', status: 'supported', workerOnly: true,
    impact: () => t('可以调用模型（需要「访问网络」权限）；不支持图片输入，流式输出不会逐字触发事件。'),
  },
  slash: {
    category: 'slash', status: 'unsupported',
    impact: () => t('APP 的脚本环境没有斜杠命令，脚本里用斜杠命令做的事不会执行。'),
  },
  database_plugin: {
    category: 'plugin', status: 'unsupported', label: () => t('数据库插件（AutoCardUpdaterAPI）'),
    impact: () => t('APP 不兼容数据库插件，依赖它的表格功能无法使用。'),
  },
  host_dom: {
    category: 'host_page', status: 'partial', workerOnly: true, label: () => t('酒馆页面元素'),
    impact: () => t('脚本自己加的界面会显示在 APP 上；酒馆页面原有的元素（聊天楼层、菜单、按钮等）在 APP 里没有，读写它们不会生效。'),
  },
  send_textarea: {
    category: 'host_page', status: 'supported', workerOnly: true, label: () => '#send_textarea',
    impact: () => t('读写酒馆输入框会同步到 APP 的输入框。'),
  },
  jquery_request: {
    category: 'host_page', status: 'unsupported',
    impact: () => t('APP 的脚本环境没有 jQuery 的请求函数，用它发的请求（包括打酒馆接口的）不会执行；改用 fetch 才能用。'),
  },
  worldbook_write: {
    category: 'worldbook', status: 'supported', workerOnly: true,
    impact: () => t('可以整本建立或覆盖世界书，每次写入都会先请你确认。'),
  },
  worldbook_unsupported: {
    category: 'worldbook', status: 'unsupported',
    impact: () => t('APP 只提供世界书读取与整本写入；条目级修改、删除、绑定与旧版 Lorebook 接口还没有，脚本里对应的功能会出错。'),
  },
});

const CATEGORY_LABELS = Object.freeze({
  tavern_api: () => t('酒馆后端接口'),
  generation: () => t('生成'),
  slash: () => t('斜杠命令'),
  plugin: () => t('酒馆插件'),
  host_page: () => t('酒馆页面'),
  worldbook: () => t('世界书写入'),
});
export const getTavernFeatureCategoryLabel = category => CATEGORY_LABELS[category]?.() || String(category || '');

// 酒馆服务器 /api 下的路由分组（对照酒馆公开源码）。分组不在这里的 /api 路径多半是别的服务，不报
const TAVERN_API_GROUPS = new Set([
  'anthropic', 'assets', 'avatars', 'azure', 'backends', 'backgrounds', 'backups', 'caption', 'characters', 'chats',
  'classify', 'content', 'data-bank', 'extensions', 'extra', 'files', 'google', 'groups', 'horde', 'images', 'minimax',
  'moving-ui', 'novelai', 'openai', 'ping', 'plugins', 'presets', 'quick-replies', 'sd', 'search', 'secrets',
  'settings', 'speech', 'sprites', 'stats', 'themes', 'thumbnail', 'tokenizers', 'translate', 'users', 'vector',
  'worldinfo',
]);

// 酒馆助手的世界书接口里 APP 有的只有读取与整本写入；以下（含旧版 Lorebook 接口）在两种运行环境都没有
const WORLDBOOK_WRITE_NAMES = ['createWorldbook', 'createOrReplaceWorldbook', 'importRawWorldbook', 'rebindGlobalWorldbooks'];
const WORLDBOOK_UNSUPPORTED_NAMES = [
  'replaceWorldbook', 'updateWorldbookWith', 'createWorldbookEntries', 'deleteWorldbookEntries', 'deleteWorldbook',
  'rebindCharWorldbooks', 'rebindChatWorldbook', 'getOrCreateChatWorldbook',
  'getLorebooks', 'getCharLorebooks', 'getChatLorebook', 'getCurrentCharPrimaryLorebook', 'getLorebookSettings',
  'setLorebookSettings', 'getLorebookEntries', 'setLorebookEntries', 'createLorebookEntries', 'createLorebookEntry',
  'deleteLorebookEntries', 'deleteLorebookEntry', 'replaceLorebookEntries', 'updateLorebookEntriesWith',
  'createLorebook', 'deleteLorebook', 'setChatLorebook', 'setCurrentCharLorebooks', 'getOrCreateChatLorebook',
];
const SLASH_NAMES = [
  'triggerSlash', 'triggerSlashWithResult', 'executeSlashCommands', 'executeSlashCommandsWithOptions',
  'SlashCommandParser', 'registerSlashCommand',
];
// Worker 里 generate／generateRaw 挂在全局（window／self 等同全局）；generateRaw 另挂在 TavernHelper 与 SillyTavern 上
const GLOBAL_RECEIVERS = ['window', 'self', 'globalThis', 'parent', 'top'];

// ── 源码扫描：去掉注释，字串与模板字串换成占位符 __S<n>__，正则字面量换成 __R__ ──

const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%<>~^';
const isIdentChar = char => /[\w$]/.test(char || '');

const decodeEscape = (source, index) => {
  const next = source[index + 1];
  if (next === undefined) return { text: '', length: 1 };
  if (next === 'n') return { text: '\n', length: 2 };
  if (next === 't') return { text: '\t', length: 2 };
  if (next === 'r') return { text: '\r', length: 2 };
  if (next === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(index + 2, index + 4))) {
    return { text: String.fromCharCode(parseInt(source.slice(index + 2, index + 4), 16)), length: 4 };
  }
  if (next === 'u' && /^[0-9a-f]{4}$/i.test(source.slice(index + 2, index + 6))) {
    return { text: String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16)), length: 6 };
  }
  if (next === '\r' || next === '\n') return { text: '', length: 2 };
  return { text: next, length: 2 };
};

export const scanJavascriptLiterals = (value = '') => {
  const source = String(value || '');
  const length = source.length;
  const literals = [];
  const extraCode = [];
  let frameSeq = 0;

  // 字串内容按段切片，只在跳脱字元处拼接
  const readQuoted = (start) => {
    const quote = source[start];
    let text = '';
    let index = start + 1;
    let runStart = index;
    while (index < length) {
      const char = source[index];
      if (char === '\\') {
        text += source.slice(runStart, index);
        const escape = decodeEscape(source, index);
        text += escape.text;
        index += escape.length;
        runStart = index;
        continue;
      }
      if (char === quote || char === '\n') break;
      index += 1;
    }
    text += source.slice(runStart, Math.min(index, length));
    if (source[index] === quote) index += 1;
    return { kind: 'quote', parts: [{ text }], end: index };
  };

  let scanCode = null;
  const readTemplate = (start) => {
    const parts = [];
    let text = '';
    let index = start + 1;
    let runStart = index;
    while (index < length) {
      const char = source[index];
      if (char === '\\') {
        text += source.slice(runStart, index);
        const escape = decodeEscape(source, index);
        text += escape.text;
        index += escape.length;
        runStart = index;
        continue;
      }
      if (char === '`') break;
      if (char === '$' && source[index + 1] === '{') {
        text += source.slice(runStart, index);
        if (text) parts.push({ text });
        text = '';
        const inner = scanCode(index + 2, true);
        extraCode.push(inner.masked);
        inner.frame.code = inner.masked;
        parts.push({ expr: source.slice(index + 2, inner.end).trim() });
        index = inner.end + 1;
        runStart = index;
        continue;
      }
      index += 1;
    }
    text += source.slice(runStart, Math.min(index, length));
    if (source[index] === '`') index += 1;
    if (text || !parts.length) parts.push({ text });
    return { kind: 'template', parts, end: index };
  };

  const readRegex = (start) => {
    let index = start + 1;
    let inClass = false;
    while (index < length) {
      const char = source[index];
      if (char === '\n' || char === '\r') return -1;
      if (char === '\\') { index += 2; continue; }
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      else if (char === '/' && !inClass) {
        index += 1;
        while (index < length && /[a-z]/i.test(source[index])) index += 1;
        return index;
      }
      index += 1;
    }
    return -1;
  };

  // 逐字扫描，但输出按段切片拼接（逐字串接在 MB 级脚本上会拖慢）
  scanCode = (start, untilBrace) => {
    const frame = { id: frameSeq++, code: '' };
    const chunks = [];
    let maskedLength = 0;
    let runStart = start;
    let index = start;
    let depth = 0;
    let lastSignificant = '';
    // 最近一个识别字的范围（判断 / 前是不是 return 一类关键字）；占位符不算关键字
    let wordStart = -1;
    let wordEnd = -1;
    let inWord = false;
    const flush = (to) => {
      if (to > runStart) {
        chunks.push(source.slice(runStart, to));
        maskedLength += to - runStart;
      }
    };
    const emit = (text, resumeAt) => {
      chunks.push(text);
      maskedLength += text.length;
      runStart = resumeAt;
    };
    const markToken = (token, resumeAt) => {
      emit(token, resumeAt);
      lastSignificant = '_';
      wordStart = -1;
      wordEnd = -1;
      inWord = false;
    };
    while (index < length) {
      const char = source[index];
      const next = source[index + 1];
      if (char === '/' && next === '/') {
        flush(index);
        while (index < length && source[index] !== '\n') index += 1;
        emit(' ', index);
        inWord = false;
        continue;
      }
      if (char === '/' && next === '*') {
        flush(index);
        const close = source.indexOf('*/', index + 2);
        index = close < 0 ? length : close + 2;
        emit(' ', index);
        inWord = false;
        continue;
      }
      if (char === '\'' || char === '"' || char === '`') {
        flush(index);
        const literal = char === '`' ? readTemplate(index) : readQuoted(index);
        const id = literals.length;
        literals.push({
          id,
          kind: literal.kind,
          parts: literal.parts,
          raw: source.slice(index, literal.end),
          frame,
          offset: maskedLength,
        });
        index = literal.end;
        markToken(`__S${id}__`, index);
        continue;
      }
      if (char === '/') {
        const regexAllowed = !lastSignificant
          || REGEX_PREFIX_CHARS.includes(lastSignificant)
          || (isIdentChar(lastSignificant) && wordStart >= 0 && REGEX_KEYWORDS.has(source.slice(wordStart, wordEnd)));
        if (regexAllowed) {
          const end = readRegex(index);
          if (end > 0) {
            flush(index);
            index = end;
            markToken(' __R__ ', index);
            continue;
          }
        }
      }
      if (untilBrace) {
        if (char === '{') depth += 1;
        else if (char === '}') {
          if (depth === 0) {
            flush(index);
            return { masked: chunks.join(''), end: index, frame };
          }
          depth -= 1;
        }
      }
      if (isIdentChar(char)) {
        if (!inWord) wordStart = index;
        wordEnd = index + 1;
        inWord = true;
      } else {
        inWord = false;
        if (char !== ' ' && char !== '\n' && char !== '\t' && char !== '\r') {
          wordStart = -1;
          lastSignificant = char;
        }
      }
      if (inWord) lastSignificant = char;
      index += 1;
    }
    flush(index);
    return { masked: chunks.join(''), end: index, frame };
  };

  const main = scanCode(0, false);
  main.frame.code = main.masked;
  literals.forEach((literal) => {
    literal.value = literal.parts.map(part => ('text' in part ? part.text : '')).join('');
    literal.dynamic = literal.parts.some(part => 'expr' in part);
    // 占位符所在的代码段（主代码或某段模板 ${} 里的代码）
    literal.code = literal.frame.code;
    literal.frameId = literal.frame.id;
    delete literal.frame;
  });
  return { code: main.masked, extraCode, literals };
};

// ── 路径解析：常量与 + 串接、模板字串尽量还原；认不出的部分记成 UNKNOWN ──

const UNKNOWN = '\u0000';
const PIECE_SOURCE = String.raw`(?:__S\d+__|[A-Za-z_$][\w$]*(?:\s*\??\.\s*[A-Za-z_$][\w$]*)*(?:\s*\([^()]*\))?)`;
const PIECE_AT_END_RE = new RegExp(`${PIECE_SOURCE}$`);
const PIECE_AT_START_RE = new RegExp(`^${PIECE_SOURCE}`);
const LITERAL_TOKEN_RE = /^__S(\d+)__$/;
const PLAIN_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

const collectConstants = (code, literals) => {
  const found = new Map();
  const ambiguous = new Set();
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*__S(\d+)__(?=[ \t]*(?:[;,)\]}\r\n]|$))/g;
  let match;
  while ((match = re.exec(code))) {
    const literal = literals[Number(match[2])];
    if (!literal || literal.dynamic) continue;
    const name = match[1];
    if (found.has(name) && found.get(name) !== literal.value) ambiguous.add(name);
    found.set(name, literal.value);
  }
  ambiguous.forEach(name => found.delete(name));
  return found;
};

const resolveLiteral = (literal, constants) => literal.parts.map((part) => {
  if ('text' in part) return part.text;
  return PLAIN_IDENT_RE.test(part.expr) && constants.has(part.expr) ? constants.get(part.expr) : UNKNOWN;
}).join('');

const resolvePiece = (piece, literals, constants) => {
  const token = piece.trim();
  const literalMatch = token.match(LITERAL_TOKEN_RE);
  if (literalMatch) return resolveLiteral(literals[Number(literalMatch[1])], constants);
  return PLAIN_IDENT_RE.test(token) && constants.has(token) ? constants.get(token) : UNKNOWN;
};

// 以某个字串为中心，往左右沿着 + 收集整条串接
const expandChain = (code, start, end) => {
  let left = start;
  let right = end;
  for (;;) {
    let cursor = left;
    while (cursor > 0 && /\s/.test(code[cursor - 1])) cursor -= 1;
    if (code[cursor - 1] !== '+' || code[cursor - 2] === '+') break;
    cursor -= 1;
    while (cursor > 0 && /\s/.test(code[cursor - 1])) cursor -= 1;
    const match = code.slice(Math.max(0, cursor - 240), cursor).match(PIECE_AT_END_RE);
    if (!match) { left = -1; break; }
    left = cursor - match[0].length;
  }
  for (;;) {
    let cursor = right;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
    if (code[cursor] !== '+' || code[cursor + 1] === '+' || code[cursor + 1] === '=') break;
    cursor += 1;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
    const match = code.slice(cursor, cursor + 240).match(PIECE_AT_START_RE);
    if (!match) { right = -1; break; }
    right = cursor + match[0].length;
  }
  return { left, right };
};

const splitChainPieces = (text) => {
  const pieces = [];
  let rest = text.trim();
  while (rest) {
    const match = rest.match(PIECE_AT_START_RE);
    if (!match) return null;
    pieces.push(match[0]);
    rest = rest.slice(match[0].length).trim();
    if (!rest) break;
    if (rest[0] !== '+') return null;
    rest = rest.slice(1).trim();
  }
  return pieces;
};

const extractTavernPaths = (resolved) => {
  const paths = [];
  let from = 0;
  for (;;) {
    const index = resolved.indexOf('api/', from);
    if (index < 0) break;
    from = index + 4;
    let pathStart;
    if (index === 0) pathStart = 0;
    else if (resolved[index - 1] === '/') pathStart = index - 1;
    else continue;
    const before = resolved.slice(0, pathStart);
    // 前面只能是空的、./ 一类相对写法，或是认不出的部分（例如 location.origin）；写死网址的是别的服务
    if (before && !/^\.{1,2}$/.test(before) && !before.endsWith(UNKNOWN)) continue;
    let cursor = index + 4;
    while (cursor < resolved.length && /[A-Za-z0-9_\-./]/.test(resolved[cursor])) cursor += 1;
    const incomplete = resolved[cursor] === UNKNOWN;
    const rawPath = `/api/${resolved.slice(index + 4, cursor)}`;
    const path = rawPath.replace(/\/+$/, '');
    const group = path.split('/')[2] || '';
    if (!TAVERN_API_GROUPS.has(group)) continue;
    // 路径后面接着认不出的部分（例如 '/api/worldinfo/' + action），或以 / 结尾的前缀（多半拿来比对网址），
    // 只认支持表里完整的路径
    if ((incomplete || rawPath.endsWith('/')) && !Object.hasOwn(TAVERN_FEATURE_SUPPORT, path)) continue;
    paths.push(path);
  }
  return paths;
};

const compactSnippet = (text, limit = 80) => {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
};

// 被串接或放进模板字串的常量（例如 const BASE = '/api/worldinfo'）是网址的前半段，由使用处还原，本身不报
const collectJoinedConstantNames = (codes, literals, constants) => {
  const names = new Set();
  if (!constants.size) return names;
  const re = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\+(?![+=])|\+\s*([A-Za-z_$][\w$]*)(?![\w$])/g;
  codes.forEach((code) => {
    for (const match of code.matchAll(re)) {
      const name = match[1] || match[2];
      if (constants.has(name)) names.add(name);
    }
  });
  literals.forEach((literal) => {
    literal.parts.forEach((part) => { if ('expr' in part && constants.has(part.expr)) names.add(part.expr); });
  });
  return names;
};

const findTavernApiPaths = ({ code, extraCode, literals }) => {
  const constants = collectConstants(code, literals);
  // 只有值里带 api 的常量才可能拼出酒馆接口路径
  const apiConstants = new Map(Array.from(constants).filter(([, value]) => value.includes('api')));
  const joinedConstants = collectJoinedConstantNames([code, ...extraCode], literals, apiConstants);
  const results = [];
  const seenChains = new Set();
  literals.forEach((literal) => {
    const token = `__S${literal.id}__`;
    const code = literal.code;
    const start = literal.offset;
    const end = start + token.length;
    const declared = code.slice(Math.max(0, start - 120), start).match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/);
    if (declared && joinedConstants.has(declared[1]) && /^[ \t]*(?:[;,)\]}\r\n]|$)/.test(code.slice(end, end + 8))) return;
    const hasApi = literal.value.includes('api');
    if (!hasApi && !(apiConstants.size && (literal.dynamic || literal.value.startsWith('/')))) return;
    const nearPlus = /\+\s*$/.test(code.slice(Math.max(0, start - 4), start)) || /^\s*\+(?![+=])/.test(code.slice(end, end + 4));
    const { left, right } = nearPlus ? expandChain(code, start, end) : { left: start, right: end };
    const chainLeft = left < 0 ? start : left;
    const chainRight = right < 0 ? end : right;
    const chainKey = `${literal.frameId}:${chainLeft}:${chainRight}`;
    if (seenChains.has(chainKey)) return;
    seenChains.add(chainKey);
    const chainCode = code.slice(chainLeft, chainRight);
    const pieces = splitChainPieces(chainCode) || [token];
    const resolved = (left < 0 ? UNKNOWN : '')
      + pieces.map(piece => resolvePiece(piece, literals, constants)).join('')
      + (right < 0 ? UNKNOWN : '');
    const snippet = compactSnippet(chainCode.replace(/__S(\d+)__/g, (_, id) => literals[Number(id)]?.raw || ''));
    extractTavernPaths(resolved).forEach(path => results.push({ path, snippet }));
  });
  return results;
};

// ── 函数与写法：在去掉字串的代码上找 ──

const escapeRe = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const findClosingParen = (code, openIndex) => {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === '(') depth += 1;
    else if (code[index] === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

// 定义（function x、方法简写 x() {、属性键 x:、赋值 obj.x =）不算使用
const isDefinitionAt = (code, nameStart, nameEnd) => {
  const before = code.slice(Math.max(0, nameStart - 40), nameStart);
  if (/\b(?:function\s*\*?|class|const|let|var)\s*$/.test(before)) return true;
  const after = code.slice(nameEnd);
  if (/^\s*:(?!:)/.test(after) && !/\?\s*$/.test(before)) return true;
  if (/^\s*=(?![=>])/.test(after)) return true;
  const paren = after.match(/^\s*\(/);
  if (paren) {
    const close = findClosingParen(code, nameEnd + paren[0].length - 1);
    if (close >= 0 && /^\s*\{/.test(code.slice(close + 1))) return true;
  }
  return false;
};

const declaresBinding = (code, name) => new RegExp(
  String.raw`\bfunction\s*\*?\s*${escapeRe(name)}\s*\(|\b(?:const|let|var|class)\s+${escapeRe(name)}\b`,
).test(code);

// names 中被使用到的函数名与写法；receivers 为 null 表示任何写法都算（例如 obj.x()），
// 否则只认直接呼叫或经过这些全局物件的呼叫
const findUsages = (codes, names, { receivers = null, call = false } = {}) => {
  const found = new Map();
  const namePattern = names.map(escapeRe).join('|');
  codes.forEach((code) => {
    const re = receivers && receivers.length
      ? new RegExp(String.raw`(?<![\w$.])(?:(${receivers.map(escapeRe).join('|')})\s*\??\.\s*)?(${namePattern})(?![\w$])`, 'g')
      : new RegExp(String.raw`(?<![\w$${receivers ? '.' : ''}])(${namePattern})(?![\w$])`, 'g');
    let match;
    while ((match = re.exec(code))) {
      const receiver = receivers && receivers.length ? match[1] || '' : '';
      const name = receivers && receivers.length ? match[2] : match[1];
      const nameStart = match.index + match[0].length - name.length;
      const nameEnd = match.index + match[0].length;
      if (isDefinitionAt(code, nameStart, nameEnd)) continue;
      if (!receiver && receivers && declaresBinding(code, name)) continue;
      if (call && !/^\s*\(/.test(code.slice(nameEnd))) continue;
      const form = `${receiver ? `${receiver}.` : ''}${name}${call ? '(' : ''}`;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name).add(form);
    }
  });
  return found;
};

const HOST_PAGE_RE = /(?:(?<![\w$.])|\b(?:window|globalThis|self)\s*\??\.\s*)(?:parent|top)\s*\??\.\s*(?:document|\$|jQuery)(?![\w$])/g;
// 酒馆页面上常见的元素（聊天区、楼层、输入列、菜单）
const TAVERN_PAGE_SELECTOR_RE = /(?:^|[\s,>+~(])(#(?:chat|send_but|send_form|form_sheld|sheld|extensionsMenu|extensions_settings2?|top-bar|top-settings-holder|leftSendForm|rightSendForm|qr--bar|movingDivs|bg1|character_popup|right-nav-panel|left-nav-panel|WorldInfo)|\.(?:mes|mes_text|mes_block|mes_buttons|last_mes|swipe_left|swipe_right))(?![\w-])/;
const SEND_TEXTAREA_RE = /(?:^|[\s,>+~(])#send_textarea(?![\w-])|^send_textarea$/;
const JQUERY_REQUEST_RE = /(?<![\w$.])(\$|jQuery)\s*\.\s*(ajax|get|post|getJSON)\s*\(/g;

// ── 分析 ──

const getScriptContent = scriptOrContent => (
  scriptOrContent && typeof scriptOrContent === 'object' ? String(scriptOrContent.content || '') : String(scriptOrContent || '')
);

const resolveSupport = (key, runtime) => {
  const entry = TAVERN_FEATURE_SUPPORT[key];
  if (runtime === 'module' && entry.workerOnly) {
    return {
      status: TAVERN_FEATURE_STATUS.UNSUPPORTED,
      impact: t('这个脚本以模块方式运行（用了 import／export 或顶层 await），模块环境没有这项功能。'),
    };
  }
  return { status: entry.status, impact: entry.impact() };
};

const makeItem = ({ id, key, label, matches, runtime }) => {
  const entry = TAVERN_FEATURE_SUPPORT[key];
  return {
    id,
    feature: key,
    category: entry.category,
    label: label || entry.label?.() || key,
    matches: Array.from(new Set(matches)).slice(0, 6),
    ...resolveSupport(key, runtime),
  };
};

const ANALYSIS_CACHE_LIMIT = 64;
const analysisCache = new Map();

const analyzeContent = (content, runtime) => {
  const scanned = scanJavascriptLiterals(content);
  const codes = [scanned.code, ...scanned.extraCode];
  const items = [];

  const apiMatches = new Map();
  findTavernApiPaths(scanned).forEach(({ path, snippet }) => {
    if (!apiMatches.has(path)) apiMatches.set(path, []);
    apiMatches.get(path).push(snippet);
  });
  Array.from(apiMatches.keys()).sort().forEach((path) => {
    const key = Object.hasOwn(TAVERN_FEATURE_SUPPORT, path)
      ? path
      : path === '/api/secrets' || path.startsWith('/api/secrets/') ? 'api:secrets' : 'api:other';
    items.push(makeItem({ id: `api:${path}`, key, label: path, matches: apiMatches.get(path), runtime }));
  });

  const addNamed = (key, found) => {
    if (!found.size) return;
    const names = Array.from(found.keys());
    items.push(makeItem({
      id: key,
      key,
      label: TAVERN_FEATURE_SUPPORT[key].label?.() || names.slice(0, 2).join('／') + (names.length > 2 ? '…' : ''),
      matches: names.flatMap(name => Array.from(found.get(name))),
      runtime,
    }));
  };

  const generate = findUsages(codes, ['generate'], { receivers: GLOBAL_RECEIVERS, call: true });
  findUsages(codes, ['generateRaw'], { receivers: [...GLOBAL_RECEIVERS, 'TavernHelper', 'SillyTavern'], call: true })
    .forEach((forms, name) => generate.set(name, forms));
  addNamed('generate', generate);
  addNamed('slash', findUsages(codes, SLASH_NAMES));

  const database = findUsages(codes, ['AutoCardUpdaterAPI']);
  if (scanned.literals.some(literal => literal.value === 'AutoCardUpdaterAPI')) {
    if (!database.has('AutoCardUpdaterAPI')) database.set('AutoCardUpdaterAPI', new Set());
    database.get('AutoCardUpdaterAPI').add('\'AutoCardUpdaterAPI\'');
  }
  addNamed('database_plugin', database);

  const hostForms = new Set();
  codes.forEach((code) => {
    for (const match of code.matchAll(HOST_PAGE_RE)) hostForms.add(compactSnippet(match[0], 40));
  });
  scanned.literals.forEach((literal) => {
    const match = literal.value.match(TAVERN_PAGE_SELECTOR_RE);
    if (match) hostForms.add(match[1]);
  });
  if (hostForms.size) items.push(makeItem({ id: 'host_dom', key: 'host_dom', matches: Array.from(hostForms), runtime }));
  if (scanned.literals.some(literal => SEND_TEXTAREA_RE.test(literal.value))) {
    items.push(makeItem({ id: 'send_textarea', key: 'send_textarea', matches: ['#send_textarea'], runtime }));
  }

  const requests = new Map();
  codes.forEach((code) => {
    for (const match of code.matchAll(JQUERY_REQUEST_RE)) {
      const name = `${match[1]}.${match[2]}`;
      if (!requests.has(name)) requests.set(name, new Set());
      requests.get(name).add(`${name}(`);
    }
  });
  addNamed('jquery_request', requests);

  // 世界书整本写入挂在每个脚本自己的作用域，只有直接呼叫才拿得到
  addNamed('worldbook_write', findUsages(codes, WORLDBOOK_WRITE_NAMES, { receivers: [], call: true }));
  addNamed('worldbook_unsupported', findUsages(codes, WORLDBOOK_UNSUPPORTED_NAMES));
  return items;
};

// 输出：{ runtime: 'worker'|'module', items: [{ id, feature, category, label, matches, status, impact }] }
export const analyzeTavernFeatures = (scriptOrContent = '') => {
  const content = getScriptContent(scriptOrContent);
  const compatibility = scriptOrContent && typeof scriptOrContent === 'object' ? scriptOrContent.compatibility : null;
  const runtime = isModuleLikeScript(content, compatibility) ? 'module' : 'worker';
  if (!content.trim()) return { runtime, items: [] };
  const cached = analysisCache.get(content);
  if (cached?.runtime === runtime) {
    analysisCache.delete(content);
    analysisCache.set(content, cached);
    return { runtime, items: cached.items.map(item => ({ ...item, matches: [...item.matches] })) };
  }
  const items = analyzeContent(content, runtime);
  analysisCache.delete(content);
  analysisCache.set(content, { runtime, items });
  if (analysisCache.size > ANALYSIS_CACHE_LIMIT) analysisCache.delete(analysisCache.keys().next().value);
  return { runtime, items: items.map(item => ({ ...item, matches: [...item.matches] })) };
};

// 多个脚本合并：同一项取最差的状态；counts 按项计
export const summarizeTavernFeatures = (reports = []) => {
  const merged = new Map();
  (Array.isArray(reports) ? reports : []).forEach((report) => {
    (Array.isArray(report?.items) ? report.items : []).forEach((item) => {
      const previous = merged.get(item.id);
      if (!previous) {
        merged.set(item.id, { ...item, matches: [...(item.matches || [])] });
        return;
      }
      if ((STATUS_RANK[item.status] ?? 0) > (STATUS_RANK[previous.status] ?? 0)) {
        merged.set(item.id, { ...item, matches: Array.from(new Set([...previous.matches, ...(item.matches || [])])).slice(0, 6) });
      } else {
        previous.matches = Array.from(new Set([...previous.matches, ...(item.matches || [])])).slice(0, 6);
      }
    });
  });
  const items = Array.from(merged.values());
  const counts = { supported: 0, partial: 0, unsupported: 0 };
  items.forEach((item) => { if (Object.hasOwn(counts, item.status)) counts[item.status] += 1; });
  return { items, counts };
};

const SUMMARY_LABEL_LIMIT = 3;
const listLabels = (items) => {
  const labels = items.slice(0, SUMMARY_LABEL_LIMIT).map(item => item.label);
  return items.length > SUMMARY_LABEL_LIMIT ? t('{items} 等', { items: labels.join('、') }) : labels.join('、');
};

// 「3 项支持、1 项部分支持（/api/settings/get）、1 项不支持（triggerSlash）」；没有用到酒馆功能时回空字串
export const buildTavernFeatureSummary = (summaryOrReport = null) => {
  const items = Array.isArray(summaryOrReport?.items) ? summaryOrReport.items : [];
  if (!items.length) return '';
  const byStatus = status => items.filter(item => item.status === status);
  const supported = byStatus('supported');
  const partial = byStatus('partial');
  const unsupported = byStatus('unsupported');
  const parts = [];
  if (supported.length) parts.push(t('{count} 项支持', { count: supported.length }));
  if (partial.length) parts.push(t('{count} 项部分支持（{items}）', { count: partial.length, items: listLabels(partial) }));
  if (unsupported.length) parts.push(t('{count} 项不支持（{items}）', { count: unsupported.length, items: listLabels(unsupported) }));
  return parts.join('、');
};

// 导入完成提示里的一行；没有用到酒馆功能时回空字串
export const buildTavernFeatureImportLine = (summaryOrReport = null) => {
  const summary = buildTavernFeatureSummary(summaryOrReport);
  return summary ? t('酒馆功能：{summary}。明细可在脚本管理里查看。', { summary }) : '';
};

// 导入时分析：被拦下的外部扩展与只取结构的 MVU 脚本不会执行，不列
export const analyzeImportedScripts = (scripts = []) => summarizeTavernFeatures(
  (Array.isArray(scripts) ? scripts : [])
    .filter(script => script && script.compatibility?.blocked !== true && script.schemaOnly !== true)
    .map(script => analyzeTavernFeatures(script)),
);
