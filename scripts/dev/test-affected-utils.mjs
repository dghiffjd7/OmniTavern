// 选测的纯逻辑：从 package.json 展开测试命令，按依赖找出受改动影响的测试。
// 依赖来源：源码里所有像路径的字符串（import、new URL('../../src/…')、path.join(cwd, 'src/…') 读源码），
// 以及按目录扫描的测试（readdir/glob）里指向目录的字符串。宁可多选，不可漏选。
// import 依赖会一层层往上传；把文件当文本读（含目录扫描）只看那个文件本身有没有改，不沿着它的 import 传。
import path from 'node:path';

const posix = path.posix;

export const CODE_FILE_RE = /\.(?:m?js|cjs)$/;
const PATH_LITERAL_RE = /(['"`])([\p{L}\p{N}_@.\-/]+)\1/gu;
const FILE_EXT_RE = /\.[\w]+$/;
const DIR_SCANNER_RE = /\breaddir(?:Sync)?\s*\(|\bglob(?:Sync)?\s*\(|\bopendir(?:Sync)?\s*\(/;
const IMPORT_PREFIX_RE = /(?:\bfrom|\bimport)\s*\(?\s*$/;
// 后缀匹配命中太多（如 index.js）就当作无法判断，不建依赖
const MAX_SUFFIX_MATCHES = 3;

// 展开顺序与 npm 一致：pre<name> → name → post<name>；同一条命令只保留第一次出现。
// suite 记的是 entry 下的第一层脚本（如 test:i18n），用于整组执行。
export const expandTestCommands = (scripts = {}, entry = 'test:all') => {
  const commands = [];
  const seen = new Set();
  const visit = (name, suite, stack) => {
    if (stack.includes(name)) return;
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      const body = scripts[hook];
      if (typeof body !== 'string') continue;
      for (const part of body.split(/\s*&&\s*/)) {
        const npm = part.match(/^npm run ([\w:.-]+)$/);
        if (npm) {
          visit(npm[1], suite || npm[1], [...stack, name]);
          continue;
        }
        const node = part.match(/^node (\S+)((?: \S+)*)$/);
        if (!node) throw new Error(`unsupported test command in ${hook}: ${part}`);
        if (seen.has(part)) continue;
        seen.add(part);
        commands.push({
          command: part,
          file: posix.normalize(node[1]),
          args: node[2].trim() ? node[2].trim().split(/\s+/) : [],
          suite: suite || name,
        });
      }
    }
  };
  visit(entry, '', []);
  return commands;
};

const isInsideRepo = rel => rel && rel !== '.' && !rel.startsWith('../') && rel !== '..';

const literalCandidates = (literal, fromFile) => {
  const clean = literal.replace(/[?#].*$/, '');
  if (!clean) return [];
  const list = clean.startsWith('/')
    ? [posix.join('src', clean), clean.slice(1)]
    : [posix.join(posix.dirname(fromFile), clean), posix.normalize(clean), posix.join('src', clean)];
  return list.map(item => posix.normalize(item)).filter(isInsideRepo);
};

const buildSuffixIndex = (files) => {
  const byBase = new Map();
  for (const file of files) {
    const base = posix.basename(file);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(file);
  }
  return byBase;
};

const resolveFileLiteral = (literal, fromFile, files, byBase) => {
  for (const candidate of literalCandidates(literal, fromFile)) {
    if (files.has(candidate)) return [candidate];
  }
  // 模板拼出来的路径（`../../src/scripts/${p}`）只剩 'ui/chat/x.js' 这类片段：按后缀找
  const tail = literal.replace(/[?#].*$/, '').replace(/^(?:\.{1,2}\/)+|^\//, '');
  const matches = (byBase.get(posix.basename(tail)) || []).filter(file => file === tail || file.endsWith(`/${tail}`));
  return matches.length && matches.length <= MAX_SUFFIX_MATCHES ? matches : [];
};

const resolveDirLiteral = (literal, fromFile, dirs) => literalCandidates(literal, fromFile)
  .find(candidate => dirs.has(candidate) && !candidate.split('/').includes('node_modules')) || '';

// sources: Map<repo 相对路径, 源码>，只需代码文件；files: 当前所有文件（含刚删除的，好让引用它的测试被选中）
export const buildDependencyIndex = ({ sources = new Map(), files = new Set(), dirs = new Set() } = {}) => {
  const importers = new Map();
  const readers = new Map();
  const dirDependents = [];
  const byBase = buildSuffixIndex(files);
  const addEdge = (edges, target, from) => {
    if (target === from) return;
    if (!edges.has(target)) edges.set(target, new Set());
    edges.get(target).add(from);
  };
  for (const [file, source] of sources) {
    const scansDirs = DIR_SCANNER_RE.test(source);
    for (const match of source.matchAll(PATH_LITERAL_RE)) {
      const literal = match[2];
      if (FILE_EXT_RE.test(literal)) {
        const edges = IMPORT_PREFIX_RE.test(source.slice(Math.max(0, match.index - 24), match.index)) ? importers : readers;
        resolveFileLiteral(literal, file, files, byBase).forEach(target => addEdge(edges, target, file));
      } else if (scansDirs) {
        const dir = resolveDirLiteral(literal, file, dirs);
        if (dir) dirDependents.push({ dir, file });
      }
    }
  }
  return { importers, readers, dirDependents };
};

// 改动文件 → 受影响的文件（含它自己）：读它文本的、扫描它所在目录的，以及这些文件一路往上的 import 方
export const collectAffectedFiles = (changed = [], index = {}) => {
  const affected = new Set();
  const queue = [...changed];
  const changedSet = new Set(changed);
  while (queue.length) {
    const file = queue.shift();
    if (affected.has(file)) continue;
    affected.add(file);
    for (const importer of index.importers?.get(file) || []) queue.push(importer);
    if (!changedSet.has(file)) continue;
    for (const reader of index.readers?.get(file) || []) queue.push(reader);
    for (const { dir, file: scanner } of index.dirDependents || []) {
      if (file.startsWith(`${dir}/`)) queue.push(scanner);
    }
  }
  return affected;
};

export const selectAffectedCommands = ({ commands = [], changed = [], index = {}, carry = [], wholeSuites = [] } = {}) => {
  const affected = collectAffectedFiles(changed, index);
  const carried = new Set(carry);
  const picked = new Set(commands
    .filter(item => affected.has(item.file) || carried.has(item.command))
    .map(item => item.command));
  // 有先后依赖的组（如 test:i18n 先 generate 再 check）选中任一条就整组跑
  const suites = new Set(commands.filter(item => picked.has(item.command) && wholeSuites.includes(item.suite)).map(item => item.suite));
  const selected = commands.filter(item => picked.has(item.command) || suites.has(item.suite));
  const commandFiles = new Set(commands.map(item => item.file));
  const uncovered = changed.filter(file => (
    /^src\//.test(file)
    && ![...collectAffectedFiles([file], index)].some(item => commandFiles.has(item))
  ));
  return { selected, uncovered, rust: changed.filter(file => file.startsWith('src-tauri/')) };
};

export const diffSnapshots = (before = {}, after = {}) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter(file => before[file] !== after[file])
  .sort();

// 测试过程中自己重新生成的文件（i18n:generate 的产物）以跑完后的内容为准，否则下次会被当成新改动
export const mergeRunSnapshot = (start = {}, end = {}, isGenerated = () => false) => {
  const merged = { ...start };
  for (const file of diffSnapshots(start, end)) {
    if (!isGenerated(file)) continue;
    if (file in end) merged[file] = end[file];
    else delete merged[file];
  }
  return merged;
};
