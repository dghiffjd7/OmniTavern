import assert from 'node:assert/strict';

import {
  buildDependencyIndex,
  diffSnapshots,
  expandTestCommands,
  mergeRunSnapshot,
  selectAffectedCommands,
} from '../dev/test-affected-utils.mjs';

{
  const scripts = {
    'pretest:all': 'npm run test:prep',
    'test:all': 'npm run test:a && npm run test:i18n && npm run test:b',
    'test:prep': 'node scripts/tests/prep-tests.mjs',
    'test:a': 'node scripts/tests/a-tests.mjs && npm run test:shared',
    'pretest:b': 'npm run test:shared',
    'test:b': 'node scripts/tests/b-tests.mjs',
    'test:shared': 'node scripts/tests/shared-tests.mjs',
    'test:i18n': 'npm run i18n:generate && node scripts/tests/i18n-tests.mjs && npm run i18n:scan',
    'i18n:generate': 'node scripts/i18n/generate.mjs',
    'i18n:scan': 'node scripts/i18n/scan.mjs --scope=content',
  };
  const commands = expandTestCommands(scripts);
  assert.deepEqual(commands.map(item => item.command), [
    'node scripts/tests/prep-tests.mjs',
    'node scripts/tests/a-tests.mjs',
    'node scripts/tests/shared-tests.mjs',
    'node scripts/i18n/generate.mjs',
    'node scripts/tests/i18n-tests.mjs',
    'node scripts/i18n/scan.mjs --scope=content',
    'node scripts/tests/b-tests.mjs',
  ], 'npm order with pre hooks; a command shared by two suites runs once');
  assert.deepEqual(commands.find(item => item.file === 'scripts/i18n/scan.mjs').args, ['--scope=content']);
  assert.equal(commands.find(item => item.file === 'scripts/i18n/generate.mjs').suite, 'test:i18n');
  assert.throws(() => expandTestCommands({ 'test:all': 'cargo test' }), /unsupported test command/);
  console.log('ok - test commands expand like npm, with pre hooks, dedup and top-level suites');
}

const repo = (sources, extraFiles = []) => {
  const files = new Set([...sources.keys(), ...extraFiles]);
  const dirs = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'));
  }
  return { index: buildDependencyIndex({ sources, files, dirs }), files };
};

const testCommands = files => files.map(file => ({ command: `node ${file}`, file, args: [], suite: 'test:x' }));

{
  const sources = new Map([
    // 注释里的撇号（don't）不能吃掉后面的 import
    ['scripts/tests/import-tests.mjs', "// don't break\nimport { a } from '../../src/scripts/ui/a.js';"],
    ['src/scripts/ui/a.js', "import { b } from './b.js';\nexport const a = b;"],
    ['src/scripts/ui/b.js', 'export const b = 1;'],
    ['scripts/tests/url-tests.mjs', "const s = readFileSync(new URL('../../src/styles/app.css', import.meta.url), 'utf8');"],
    ['scripts/tests/cwd-tests.mjs', "fs.readFileSync(path.join(process.cwd(), 'src/scripts/ui/chat/render.js'), 'utf8');"],
    ['scripts/tests/fragment-tests.mjs', "const read = p => readFileSync(new URL(`../../src/scripts/${p}`, import.meta.url));\nread('ui/chat/render.js');"],
    ['scripts/tests/dev-path-tests.mjs', "await import('/scripts/ui/b.js');"],
    ['scripts/tests/scanner-tests.mjs', "const dir = path.join(root, 'src/scripts/agent');\nconst list = readdirSync(dir);"],
    ['scripts/tests/unrelated-tests.mjs', "import { x } from '../../src/scripts/other.js';"],
    ['src/scripts/ui/chat/render.js', 'export const render = 1;'],
    ['src/scripts/other.js', 'export const x = 1;'],
  ]);
  const { index } = repo(sources, ['src/styles/app.css', 'src/scripts/agent/tool.js']);
  const commands = testCommands([...sources.keys()].filter(file => file.startsWith('scripts/tests/')));
  const pick = changed => selectAffectedCommands({ commands, changed, index }).selected.map(item => item.file);

  assert.deepEqual(pick(['src/scripts/ui/b.js']), ['scripts/tests/import-tests.mjs', 'scripts/tests/dev-path-tests.mjs'], 'transitive import and dev absolute path');
  assert.deepEqual(pick(['src/styles/app.css']), ['scripts/tests/url-tests.mjs']);
  assert.deepEqual(pick(['src/scripts/ui/chat/render.js']), ['scripts/tests/cwd-tests.mjs', 'scripts/tests/fragment-tests.mjs']);
  assert.deepEqual(pick(['src/scripts/agent/tool.js']), ['scripts/tests/scanner-tests.mjs'], 'directory scanners cover files under their directory');
  assert.deepEqual(pick(['scripts/tests/unrelated-tests.mjs']), ['scripts/tests/unrelated-tests.mjs'], 'an edited test runs itself');
  console.log('ok - dependency index follows imports, source reads, path fragments and directory scans');
}

{
  // 把 app.js 当文本读的测试，只在 app.js 本身改了才跑；app.js import 的模块改了不算
  const sources = new Map([
    ['scripts/tests/app-text-tests.mjs', "const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');"],
    ['scripts/tests/helper-user-tests.mjs', "import { css } from './helpers/read-css.mjs';"],
    ['scripts/tests/helpers/read-css.mjs', "export const css = readFileSync(new URL('../../../src/styles/app.css', import.meta.url), 'utf8');"],
    ['src/scripts/ui/app.js', "import { b } from './b.js';"],
    ['src/scripts/ui/b.js', 'export const b = 1;'],
  ]);
  const { index } = repo(sources, ['src/styles/app.css']);
  const commands = testCommands(['scripts/tests/app-text-tests.mjs', 'scripts/tests/helper-user-tests.mjs']);
  const pick = changed => selectAffectedCommands({ commands, changed, index }).selected.map(item => item.file);
  assert.deepEqual(pick(['src/scripts/ui/b.js']), [], 'a text reader of app.js does not follow app.js imports');
  assert.deepEqual(pick(['src/scripts/ui/app.js']), ['scripts/tests/app-text-tests.mjs']);
  assert.deepEqual(pick(['src/styles/app.css']), ['scripts/tests/helper-user-tests.mjs'], 'importers of a text reader are still affected');
  console.log('ok - text reads only count changes to the read file itself');
}

{
  // 删掉的文件：还引用它的测试要被选中（会在 import 时失败）
  const sources = new Map([['scripts/tests/gone-tests.mjs', "import '../../src/scripts/gone.js';"]]);
  const { index } = repo(sources, ['src/scripts/gone.js']);
  const result = selectAffectedCommands({ commands: testCommands(['scripts/tests/gone-tests.mjs']), changed: ['src/scripts/gone.js'], index });
  assert.deepEqual(result.selected.map(item => item.file), ['scripts/tests/gone-tests.mjs']);
  console.log('ok - tests that still reference a deleted file are selected');
}

{
  const sources = new Map([
    ['scripts/tests/i18n-tests.mjs', "import '../../src/scripts/i18n/index.js';"],
    ['src/scripts/i18n/index.js', 'export const t = s => s;'],
    ['scripts/tests/old-tests.mjs', "import '../../src/scripts/keep.js';"],
    ['src/scripts/keep.js', ''],
    ['src/scripts/lonely.js', ''],
  ]);
  const { index } = repo(sources);
  const commands = [
    { command: 'node scripts/i18n/generate.mjs', file: 'scripts/i18n/generate.mjs', args: [], suite: 'test:i18n' },
    { command: 'node scripts/tests/i18n-tests.mjs', file: 'scripts/tests/i18n-tests.mjs', args: [], suite: 'test:i18n' },
    { command: 'node scripts/tests/old-tests.mjs', file: 'scripts/tests/old-tests.mjs', args: [], suite: 'test:x' },
  ];
  const result = selectAffectedCommands({
    commands,
    changed: ['src/scripts/i18n/index.js', 'src/scripts/lonely.js', 'src-tauri/src/commands.rs'],
    index,
    carry: ['node scripts/tests/old-tests.mjs'],
    wholeSuites: ['test:i18n'],
  });
  assert.deepEqual(result.selected.map(item => item.file), ['scripts/i18n/generate.mjs', 'scripts/tests/i18n-tests.mjs', 'scripts/tests/old-tests.mjs'],
    'whole suites keep their setup step; last failures are carried; order follows the command list');
  assert.deepEqual(result.uncovered, ['src/scripts/lonely.js']);
  assert.deepEqual(result.rust, ['src-tauri/src/commands.rs']);
  console.log('ok - whole suites, carried failures, uncovered files and rust changes are reported');
}

{
  assert.deepEqual(diffSnapshots({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' }), ['b', 'c', 'd']);
  const merged = mergeRunSnapshot(
    { 'src/scripts/i18n/locales/en.json': 'old', 'src/x.js': 'start' },
    { 'src/scripts/i18n/locales/en.json': 'new', 'src/x.js': 'edited-during-run' },
    file => file.startsWith('src/scripts/i18n/'),
  );
  assert.deepEqual(merged, { 'src/scripts/i18n/locales/en.json': 'new', 'src/x.js': 'start' },
    'generated outputs take the end state; other edits during the run stay pending');
  console.log('ok - snapshots diff and merge generated outputs only');
}
