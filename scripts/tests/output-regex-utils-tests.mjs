import assert from 'node:assert/strict';

import {
  applyOutputDisplayRegexSafe,
  applyOutputRegexPairSafe,
  applyOutputStoredRegexSafe,
  applyPromptHistoryRegex,
} from '../../src/scripts/ui/chat/output-regex-utils.js';

globalThis.localStorage ||= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { RegexStore, regex_placement } = await import('../../src/scripts/storage/regex-store.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('applyOutputStoredRegexSafe applies bridge function and normalization', () => {
  assert.equal(
    applyOutputStoredRegexSafe('hello', {
      appBridge: {
        applyOutputStoredRegex(value) {
          return `${value}!`;
        },
      },
      normalizeText: value => value.toUpperCase(),
    }),
    'HELLO!',
  );
});

test('applyOutputDisplayRegexSafe falls back on bridge errors and reports stage', () => {
  const stages = [];
  assert.equal(
    applyOutputDisplayRegexSafe('hello', {
      appBridge: {
        applyOutputDisplayRegex() {
          throw new Error('boom');
        },
      },
      onError(_err, stage) {
        stages.push(stage);
      },
    }),
    'hello',
  );
  assert.deepEqual(stages, ['display']);
});

test('applyOutputRegexPairSafe chains stored result into display stage', () => {
  const calls = [];
  assert.deepEqual(
    applyOutputRegexPairSafe('hello', {
      appBridge: {
        applyOutputStoredRegex(value, options) {
          calls.push(['stored', value, options]);
          return `stored:${value}`;
        },
        applyOutputDisplayRegex(value, options) {
          calls.push(['display', value, options]);
          return `display:${value}`;
        },
      },
      depth: 2,
      isEdit: true,
    }),
    {
      stored: 'stored:hello',
      display: 'display:stored:hello',
    },
  );
  assert.deepEqual(calls, [
    ['stored', 'hello', { isEdit: true, depth: 2 }],
    ['display', 'stored:hello', { isEdit: true, depth: 2 }],
  ]);
});

test('applyPromptHistoryRegex passes prompt flags, depth and role placement', () => {
  const calls = [];
  const regex = { apply: (text, context, placement, options) => { calls.push({ text, context, placement, options }); return `${text}*`; } };
  const placements = { USER_INPUT: 1, AI_OUTPUT: 2 };
  assert.equal(applyPromptHistoryRegex('hi', { role: 'user', depth: 3, regex, context: 'ctx', placements }), 'hi*');
  assert.equal(applyPromptHistoryRegex('yo', { role: 'assistant', depth: 0, regex, context: 'ctx', placements }), 'yo*');
  assert.deepEqual(calls.map(c => [c.placement, c.options.depth, c.options.isPrompt, c.options.isMarkdown, c.context]), [[1, 3, true, false, 'ctx'], [2, 0, true, false, 'ctx']]);
  assert.equal(applyPromptHistoryRegex('raw', { role: 'user', depth: 0 }), 'raw', '没有正则仓库时原样返回');
});

test('applyPromptHistoryRegex hides only messages at or beyond a promptOnly minDepth', () => {
  // 用户攻略「正则隐藏消息最小深度 10」：只清空深度 >= 10 的历史，近处的保留。
  const store = Object.create(RegexStore.prototype);
  store.computeActiveRules = () => [{
    id: 'hide-old', findRegex: '/[\\s\\S]+/', replaceString: '', promptOnly: true, markdownOnly: false,
    placement: [regex_placement.USER_INPUT, regex_placement.AI_OUTPUT], minDepth: 10, maxDepth: null, trimStrings: [],
  }];
  const run = depth => applyPromptHistoryRegex('old text', { role: 'assistant', depth, regex: store, context: {}, placements: regex_placement });
  assert.equal(run(9), 'old text');
  assert.equal(run(10), '');
  assert.equal(run(25), '');
});

test('both buildMessages history paths apply prompt history regex', async () => {
  const { readFile } = await import('node:fs/promises');
  const bridge = await readFile(new URL('../../src/scripts/ui/bridge.js', import.meta.url), 'utf8');
  // 关闭「自定义提示词区块」时走的组装路径也必须套用，深度隐藏才不会随开关失效
  assert.equal(bridge.match(/applyPromptHistoryRegex\(/g)?.length, 2);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${t.name}`);
    console.error(err);
  }
}

if (failed > 0) process.exit(1);
