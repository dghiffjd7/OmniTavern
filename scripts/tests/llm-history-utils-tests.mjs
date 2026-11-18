import assert from 'node:assert/strict';

import {
  applyChatHistoryLimit,
  applyHistoryCharBudget,
  applyHistoryTokenBudget,
  dropTrailingPendingUserEcho,
  finalizeLlmHistory,
  injectReasoningIntoHistory,
  limitHistoryByTokenBudget,
  mapHistoryMessagesToTurns,
  resolveCoverageProtectedHistoryIndexes,
  restoreCoverageHoleHistory,
  limitCreativeAssistantHistory,
  stripTransientHistoryFields,
} from '../../src/scripts/ui/chat/llm-history-utils.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('dropTrailingPendingUserEcho removes only the duplicated trailing user message', () => {
  const history = [
    { role: 'assistant', content: 'a' },
    { role: 'user', content: ' hello ' },
  ];
  assert.deepEqual(dropTrailingPendingUserEcho(history, 'hello'), [
    { role: 'assistant', content: 'a' },
  ]);
  assert.equal(history.length, 2);
});

test('applyChatHistoryLimit trims oldest messages when over limit', () => {
  assert.deepEqual(
    applyChatHistoryLimit([
      { content: '1' },
      { content: '2' },
      { content: '3' },
    ], 2),
    [
      { content: '2' },
      { content: '3' },
    ],
  );
});

test('applyHistoryTokenBudget caps long messages and drops oldest entries when over budget', () => {
  const result = applyHistoryCharBudget([
    { role: 'assistant', content: 'a'.repeat(50000) },
    { role: 'assistant', content: 'b'.repeat(50000) },
    { role: 'assistant', content: 'c'.repeat(50000) },
  ], {
    maxContext: 2000,
    maxOut: 1000,
  });

  assert.equal(result.length, 1);
  assert.ok(result[0].content.length <= 1953);
  assert.ok(result[0].content.startsWith('c'));
});

test('history token budget is conservative for Chinese and English across small contexts', () => {
  const chinese = limitHistoryByTokenBudget([
    { role: 'assistant', content: '中'.repeat(2000) },
  ], {
    maxContext: 2000,
    maxOut: 1000,
  });
  assert.ok(chinese.stats.usedTokens <= 488);
  assert.ok(chinese.messages[0].content.length <= 488);

  const english = limitHistoryByTokenBudget([
    { role: 'assistant', content: 'a'.repeat(8000) },
  ], {
    maxContext: 2000,
    maxOut: 1000,
  });
  assert.ok(english.stats.usedTokens <= 488);
  assert.ok(english.messages[0].content.length > chinese.messages[0].content.length);
});

test('unknown context does not invent an 8000-token hard limit', () => {
  const content = '中'.repeat(20000);
  const result = applyHistoryTokenBudget([
    { role: 'assistant', content },
  ], {
    maxContext: 0,
    maxOut: 4096,
  });
  assert.equal(result[0].content, content);
});

test('large context no longer uses a 140k-character cap that underfills English', () => {
  const content = 'a'.repeat(200000);
  const result = limitHistoryByTokenBudget([
    { role: 'assistant', content },
  ], {
    maxContext: 131072,
    maxOut: 4096,
  });
  assert.equal(result.messages[0].content, content);
  assert.equal(result.stats.inputBudgetTokens, 126464);
  assert.ok(result.stats.usedTokens < result.stats.inputBudgetTokens);
});

test('coverage holes protect exact history turns even when they exceed the recent quota', () => {
  const history = [
    { role: 'user', content: '第8轮用户'.repeat(20) },
    { role: 'assistant', content: '第8轮助手'.repeat(20) },
    { role: 'user', content: '第9轮用户'.repeat(20) },
    { role: 'assistant', content: '第9轮助手'.repeat(20) },
    { role: 'user', content: '第10轮用户'.repeat(20) },
    { role: 'assistant', content: '第10轮助手'.repeat(20) },
  ];
  assert.deepEqual(mapHistoryMessagesToTurns(history, { lastTurn: 10 }).map(item => item.turn), [
    8, 8, 9, 9, 10, 10,
  ]);
  const protectedIndexes = resolveCoverageProtectedHistoryIndexes({
    history,
    holes: [{ from: 8, to: 8 }],
    lastTurn: 10,
  });
  assert.deepEqual(protectedIndexes, [0, 1]);
  const limited = limitHistoryByTokenBudget(history, {
    inputBudgetTokens: 10,
    protectedMessageIndexes: protectedIndexes,
  });
  assert.deepEqual(limited.stats.keptOriginalIndexes, [0, 1]);
  assert.equal(limited.stats.protectedMessageCount, 2);
  assert.equal(limited.stats.overflowed, true);
});

const buildTurnHistory = (turns, chars = 1000) => {
  const history = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    history.push({ role: 'user', content: `[第${turn}轮用户]${'字'.repeat(chars)}` });
    history.push({ role: 'assistant', content: `[第${turn}轮AI]${'字'.repeat(chars)}` });
  }
  return history;
};

const holeIndexesBeforeRecentWindow = (history, recent) => {
  const oldestKept = Math.min(...recent.stats.keptOriginalIndexes);
  return history.map((_, index) => index).filter(index => index < oldestKept);
};

test('coverage hole restore keeps the recent window when uncovered history exceeds the budget', () => {
  const history = buildTurnHistory(50);
  const recent = limitHistoryByTokenBudget(history, { inputBudgetTokens: 35000 });
  const holes = holeIndexesBeforeRecentWindow(history, recent);
  assert.ok(holes.length > recent.stats.keptOriginalIndexes.length, 'holes alone exceed the budget');
  const restored = restoreCoverageHoleHistory(history, recent, {
    holeMessageIndexes: holes,
    inputBudgetTokens: 35000,
  });
  for (const index of recent.stats.keptOriginalIndexes) {
    assert.ok(restored.stats.keptOriginalIndexes.includes(index), `recent message ${index} must stay`);
  }
  assert.equal(restored.stats.keptOriginalIndexes.at(-1), history.length - 1);
  assert.ok(restored.stats.usedTokens <= 35000);
  assert.equal(restored.stats.overflowed, false);
  assert.equal(restored.stats.originalMessageCount, history.length);
  assert.equal(
    restored.stats.droppedMessageCount,
    history.length - restored.stats.keptOriginalIndexes.length,
  );
});

const buildUniformHistory = count => Array.from({ length: count }, (_, index) => ({
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: '字'.repeat(100),
}));

test('coverage hole restore fills only leftover budget, newest holes first and contiguous', () => {
  const history = buildUniformHistory(20);
  const perMessage = limitHistoryByTokenBudget([history[0]], {}).stats.usedTokens;
  const recent = limitHistoryByTokenBudget(history, { inputBudgetTokens: perMessage * 6 });
  assert.deepEqual(recent.stats.keptOriginalIndexes, [14, 15, 16, 17, 18, 19]);
  const budget = perMessage * 8 + Math.floor(perMessage / 2);
  const restored = restoreCoverageHoleHistory(history, recent, {
    holeMessageIndexes: [4, 5, 6, 7, 8, 9, 10, 11],
    inputBudgetTokens: budget,
  });
  assert.deepEqual(restored.stats.keptOriginalIndexes, [10, 11, 14, 15, 16, 17, 18, 19]);
  assert.equal(restored.stats.restoredHoleMessageCount, 2);
  assert.ok(restored.stats.usedTokens <= budget);
  assert.deepEqual(restored.messages[0], history[10]);
});

test('coverage hole restore returns the recent window untouched when there is no hole or no room', () => {
  const history = buildUniformHistory(20);
  const recent = limitHistoryByTokenBudget(history, { inputBudgetTokens: 2000 });
  const noHoles = restoreCoverageHoleHistory(history, recent, {
    holeMessageIndexes: [],
    inputBudgetTokens: 2000,
  });
  assert.deepEqual(noHoles.messages, recent.messages);
  assert.equal(noHoles.stats.restoredHoleMessageCount, 0);
  const noRoom = restoreCoverageHoleHistory(history, recent, {
    holeMessageIndexes: [0, 1],
    inputBudgetTokens: recent.stats.usedTokens,
  });
  assert.deepEqual(noRoom.stats.keptOriginalIndexes, recent.stats.keptOriginalIndexes);
  assert.equal(noRoom.stats.restoredHoleMessageCount, 0);
});

test('token budget trimming stays fast on thousand-floor Chinese histories', () => {
  const history = Array.from({ length: 3000 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `第${index}楼：${'剧情正文'.repeat(125)}`,
  }));
  const startedAt = Date.now();
  const result = limitHistoryByTokenBudget(history, {
    inputBudgetTokens: 20000,
    protectedMessageIndexes: [0, 1],
  });
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 1500, `trimming took ${elapsedMs}ms`);
  assert.ok(result.stats.droppedMessageCount > 2900);
  assert.ok(result.stats.usedTokens <= 20000);
  assert.equal(result.stats.protectedMessageCount, 2);
  assert.deepEqual(result.stats.keptOriginalIndexes.slice(0, 2), [0, 1]);
  const tail = result.stats.keptOriginalIndexes.slice(2);
  assert.deepEqual(tail, tail.map((_, i) => 3000 - tail.length + i));
});

test('limitCreativeAssistantHistory keeps the user turn before the retained creative window', () => {
  const result = limitCreativeAssistantHistory([
    { role: 'user', content: 'u1' },
    { role: 'assistant', content: 'a1', __creative: true },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2', __creative: true },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3', __creative: true },
  ], 2);

  assert.deepEqual(result, [
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a2', __creative: true },
    { role: 'user', content: 'u3' },
    { role: 'assistant', content: 'a3', __creative: true },
  ]);
});

test('injectReasoningIntoHistory prepends latest assistant reasoning blocks up to max additions', () => {
  const result = injectReasoningIntoHistory([
    { role: 'assistant', content: 'a1', __reasoning: 'r1' },
    { role: 'assistant', content: 'a2', __reasoning: 'r2' },
    { role: 'user', content: 'u' },
  ], {
    enabled: true,
    prefix: '[',
    suffix: ']',
    separator: '\n',
    maxAdditions: 1,
    applyMacros: value => String(value ?? '').toUpperCase(),
  });

  assert.equal(result[0].content, 'a1');
  assert.equal(result[1].content, '[r2]\na2');
});

test('stripTransientHistoryFields removes helper-only fields', () => {
  assert.deepEqual(
    stripTransientHistoryFields([
      { role: 'assistant', content: 'a', __creative: true, __reasoning: 'r' },
      { role: 'user', content: 'u' },
    ]),
    [
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'u' },
    ],
  );
});

test('finalizeLlmHistory composes all post-processing steps', () => {
  const result = finalizeLlmHistory([
    { role: 'assistant', content: 'older', __creative: true, __reasoning: 'old-think' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'newer', __creative: true, __reasoning: 'new-think' },
    { role: 'user', content: 'pending' },
  ], {
    pendingUserText: 'pending',
    chatHistoryLimit: 3,
    openaiPreset: { openai_max_context: 50000, openai_max_tokens: 1000 },
    rpUiMode: true,
    creativeHistoryLimit: 1,
    reasoning: {
      enabled: true,
      prefix: '<',
      suffix: '>',
      separator: '\n',
      maxAdditions: 1,
      applyMacros: value => String(value ?? ''),
    },
  });

  assert.deepEqual(result, [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: '<new-think>\nnewer' },
  ]);
});

test('turn mapping skips assistant-generated user messages like the stamping side', () => {
  const history = [
    { role: 'user', content: '第1轮' },
    { role: 'assistant', content: '回1' },
    { role: 'user', content: 'AI 代发', meta: { generatedByAssistant: true } },
    { role: 'user', content: '第2轮' },
    { role: 'assistant', content: '回2' },
  ];
  // 代发消息不推进轮号：与 countUserTurnsForMemoryTimeline 同口径
  assert.deepEqual(
    mapHistoryMessagesToTurns(history, { lastTurn: 2 }).map(item => item.turn),
    [1, 1, 1, 2, 2],
  );
  // 空洞保护按同一轮号对齐：第 1 轮的三条（含代发）都被保护
  assert.deepEqual(
    resolveCoverageProtectedHistoryIndexes({ history, holes: [{ from: 1, to: 1 }], lastTurn: 2 }),
    [0, 1, 2],
  );
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

if (failed > 0) {
  process.exit(1);
}
