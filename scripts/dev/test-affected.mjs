// 只跑受改动影响的测试（开发中用）；正式更版前仍跑全量 npm run test:all。
//   npm run test:affected                 跑「上次运行后改过的文件」相关的测试，加上上次没过的
//   npm run test:affected -- --all        逐条跑全部测试，失败也继续，最后列出全部失败
//   npm run test:affected -- --list       只列出会跑哪些，不执行
//   npm run test:affected -- <文件…>      只按指定文件选测（不更新记录）
// 记录在 node_modules/.cache/test-affected/state.json：每次运行开始时的文件快照，和这次没过的测试。
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODE_FILE_RE,
  buildDependencyIndex,
  diffSnapshots,
  expandTestCommands,
  mergeRunSnapshot,
  selectAffectedCommands,
} from './test-affected-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_FILE = path.join(ROOT, 'node_modules/.cache/test-affected/state.json');
const LOG_FILE = path.join(ROOT, 'scripts/dev/tmp/test-affected.log');
const SNAPSHOT_ROOTS = ['src', 'scripts', 'src-tauri/src', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'gen', 'dist', 'scripts/dev/tmp']);
// test:i18n 要先 generate 再检查，选中任一条就整组跑
const WHOLE_SUITES = ['test:i18n'];
const isGeneratedFile = file => /^(src\/scripts\/i18n|scripts\/i18n)\//.test(file);

const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const explicit = args.filter(arg => !arg.startsWith('--')).map(arg => path.relative(ROOT, path.resolve(arg)).split(path.sep).join('/'));

const readSnapshot = () => {
  const hashes = {};
  const sources = new Map();
  const dirs = new Set();
  const visit = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) return;
    let entries = null;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { entries = null; }
    if (!entries) {
      const buffer = readFileSync(abs);
      hashes[rel] = createHash('sha1').update(buffer).digest('hex');
      if (CODE_FILE_RE.test(rel)) sources.set(rel, buffer.toString('utf8'));
      return;
    }
    dirs.add(rel);
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(child)) continue;
      if (entry.isDirectory() || entry.isFile()) visit(child);
    }
  };
  SNAPSHOT_ROOTS.forEach(visit);
  return { hashes, sources, dirs };
};

const readState = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
};

const writeState = (state) => {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
};

const preview = (items, limit = 12) => items.slice(0, limit).map(item => `  ${item}`).join('\n')
  + (items.length > limit ? `\n  …另外 ${items.length - limit} 个` : '');

const scripts = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
const commands = expandTestCommands(scripts);
const start = readSnapshot();
const state = readState();
const runAll = flags.has('--all') || (!explicit.length && !state);
const record = !explicit.length && !flags.has('--list');

let selected = commands;
if (!state && !flags.has('--all') && !explicit.length) {
  console.log('还没有运行记录：这次跑全部测试，之后只跑改动相关的。');
}
if (!runAll) {
  const known = new Set(commands.map(item => item.command));
  const changed = explicit.length ? explicit : diffSnapshots(state.snapshot, start.hashes);
  const carry = explicit.length ? [] : (state.failed || []).filter(command => known.has(command));
  const files = new Set([...Object.keys(start.hashes), ...changed]);
  const index = buildDependencyIndex({ sources: start.sources, files, dirs: start.dirs });
  const result = selectAffectedCommands({ commands, changed, index, carry, wholeSuites: WHOLE_SUITES });
  selected = result.selected;
  console.log(`改动 ${changed.length} 个文件${changed.length ? `：\n${preview(changed)}` : ''}`);
  if (carry.length) console.log(`上次没过、这次重跑 ${carry.length} 条`);
  if (result.uncovered.length) console.log(`没有测试引用这些文件（需要另外验证）：\n${preview(result.uncovered)}`);
  if (result.rust.length) console.log(`Rust 有改动，请另跑 cargo test（在 src-tauri）：\n${preview(result.rust)}`);
}
console.log(`选中 ${selected.length} / ${commands.length} 条测试`);
if (flags.has('--list')) {
  console.log(preview(selected.map(item => item.command), 200));
  process.exit(0);
}

mkdirSync(path.dirname(LOG_FILE), { recursive: true });
writeFileSync(LOG_FILE, '');
const failed = [];
const startedAt = Date.now();
selected.forEach((item, index) => {
  const began = Date.now();
  const run = spawnSync(process.execPath, [item.file, ...item.args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  appendFileSync(LOG_FILE, `\n===== ${item.command}\n${output}`);
  const ok = run.status === 0;
  const seconds = ((Date.now() - began) / 1000).toFixed(1);
  console.log(`[${index + 1}/${selected.length}] ${ok ? 'ok  ' : 'FAIL'} ${item.command} (${seconds}s)`);
  if (!ok) {
    failed.push(item.command);
    console.log(output.trim().split('\n').slice(-25).map(line => `      ${line}`).join('\n'));
  }
});

if (record) {
  const end = readSnapshot();
  writeState({ snapshot: mergeRunSnapshot(start.hashes, end.hashes, isGeneratedFile), failed, at: new Date().toISOString() });
}
const total = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log(failed.length
  ? `\n${failed.length} 条没过（${total}s，完整输出见 scripts/dev/tmp/test-affected.log）：\n${preview(failed, 50)}`
  : `\n全部通过：${selected.length} 条（${total}s）`);
process.exit(failed.length ? 1 : 0);
