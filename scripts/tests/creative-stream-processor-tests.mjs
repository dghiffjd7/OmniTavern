import assert from 'node:assert/strict';

import {
  CreativeStreamProcessor,
  balanceCreativeStreamPreview,
} from '../../src/scripts/ui/chat/creative-stream-processor.js';
import {
  protectUnclosedAutoImagePromptTags,
  restoreProtectedAutoImagePromptTags,
} from '../../src/scripts/ui/chat/auto-image-prompt-utils.js';

const splitThinking = (raw) => {
  const text = String(raw ?? '');
  const start = text.indexOf('<think>');
  if (start < 0) return { content: text, reasoning: '', reasoningDisplay: '' };
  const bodyStart = start + '<think>'.length;
  const end = text.indexOf('</think>', bodyStart);
  if (end < 0) {
    return {
      content: text.slice(0, start).trimEnd(),
      reasoning: text.slice(bodyStart).trim(),
      reasoningDisplay: text.slice(bodyStart).trim(),
    };
  }
  return {
    content: `${text.slice(0, start)}${text.slice(end + '</think>'.length)}`.trim(),
    reasoning: text.slice(bodyStart, end).trim(),
    reasoningDisplay: text.slice(bodyStart, end).trim(),
  };
};

const testPreviewBalance = () => {
  assert.equal(balanceCreativeStreamPreview('abc ```js\nconst x = 1;'), 'abc ```js\nconst x = 1;\n```');
  assert.equal(balanceCreativeStreamPreview('他说 "你好'), '他说 "你好"');
};

const testIncompleteReasoningSplit = () => {
  let now = 1000;
  const processor = new CreativeStreamProcessor({
    now: () => now,
    minChunkChars: 1,
    normalizeText: value => String(value ?? ''),
    extractReasoning: splitThinking,
    applyStored: value => value,
    applyDisplay: value => value,
  });
  const snapshot = processor.append('正文<think>先想一下');
  assert.ok(snapshot);
  assert.equal(snapshot.contentSource, '正文');
  assert.equal(snapshot.display, '正文');
  assert.equal(snapshot.reasoning, '先想一下');
  assert.equal(snapshot.reasoningDisplay, '先想一下');
};

const testPreviewFallbackWhenRegexEmpties = () => {
  let now = 2000;
  const processor = new CreativeStreamProcessor({
    now: () => now,
    minChunkChars: 1,
    normalizeText: value => String(value ?? ''),
    extractReasoning: value => ({ content: String(value ?? ''), reasoning: '', reasoningDisplay: '' }),
    applyStored: () => '',
    applyDisplay: () => '',
  });
  const snapshot = processor.append('可见正文');
  assert.ok(snapshot);
  assert.equal(snapshot.display, '可见正文');
  assert.equal(snapshot.stored, '可见正文');
};

const testThrottleAndFinalize = () => {
  let now = 3000;
  const processor = new CreativeStreamProcessor({
    now: () => now,
    fps: 20,
    minChunkChars: 10,
    maxWaitMs: 180,
    normalizeText: value => String(value ?? ''),
    extractReasoning: value => ({ content: String(value ?? ''), reasoning: '', reasoningDisplay: '' }),
    applyStored: value => value,
    applyDisplay: value => value,
  });
  const first = processor.append('abc');
  assert.ok(first);
  assert.equal(first.display, 'abc');
  now += 10;
  assert.equal(processor.append('def'), null);
  now += 60;
  assert.equal(processor.append('ghi'), null);
  now += 130;
  const emitted = processor.append('j');
  assert.ok(emitted);
  assert.equal(emitted.display, 'abcdefghij');
  now += 10;
  const preview = processor.append('```code');
  assert.equal(preview, null);
  const finalSnapshot = processor.finalize();
  assert.equal(finalSnapshot.display, 'abcdefghij```code');
};

const testIncompleteImagePromptSurvivesRegex = () => {
  let now = 4000;
  const dangerousStrip = value => String(value ?? '').replace(/<\s*image_prompt\b[\s\S]*/i, '');
  const processor = new CreativeStreamProcessor({
    now: () => now,
    minChunkChars: 1,
    normalizeText: value => String(value ?? ''),
    extractReasoning: value => ({ content: String(value ?? ''), reasoning: '', reasoningDisplay: '' }),
    applyStored: dangerousStrip,
    applyDisplay: dangerousStrip,
    protectRegexSource: protectUnclosedAutoImagePromptTags,
    restoreRegexOutput: restoreProtectedAutoImagePromptTags,
  });
  const snapshot = processor.append('正文\n<image_prompt>\n后续正文');
  assert.ok(snapshot);
  assert.equal(snapshot.stored, '正文\n<image_prompt>\n后续正文');
  assert.equal(snapshot.display, '正文\n<image_prompt>\n后续正文');
};

const testContentWrapperHiddenDuringStream = () => {
  let now = 5000;
  const processor = new CreativeStreamProcessor({
    now: () => now,
    minChunkChars: 1,
    normalizeText: value => String(value ?? ''),
    extractReasoning: value => ({ content: String(value ?? ''), reasoning: '', reasoningDisplay: '' }),
    applyStored: value => value,
    applyDisplay: value => value,
  });
  const opening = processor.append('<content');
  assert.ok(opening);
  assert.equal(opening.stored, '<content');
  assert.equal(opening.display, '');
  now += 60;
  const body = processor.append('>正文</content>');
  assert.ok(body);
  assert.equal(body.stored, '<content>正文</content>');
  assert.equal(body.display, '正文');
};

// 显示正则很贵时（长回复），下次预览至少隔上次耗时的 4 倍；最终结果不受影响
const testAdaptiveThrottleForExpensiveSnapshots = () => {
  let now = 10000;
  const processor = new CreativeStreamProcessor({
    now: () => now,
    clock: () => now,
    minChunkChars: 1,
    normalizeText: value => String(value ?? ''),
    extractReasoning: value => ({ content: String(value ?? ''), reasoning: '', reasoningDisplay: '' }),
    applyStored: value => value,
    applyDisplay: value => { now += 80; return value; },
  });
  // 间隔从上次快照开始时算起（快照自身的 80ms 也计入），即两次快照之间至少空出 3 倍耗时
  assert.ok(processor.append('第一段'));
  now += 100;
  assert.equal(processor.append('第二段'), null, '距上次开始 180ms，不到 80ms×4');
  now += 100;
  assert.equal(processor.append('第三段'), null, '280ms 仍不到');
  now += 100;
  const next = processor.append('第四段');
  assert.ok(next, '超过 320ms 后照常更新');
  assert.equal(next.display, '第一段第二段第三段第四段', '跳过的片段都在下一次快照里');
  assert.equal(processor.finalize().display, '第一段第二段第三段第四段', '最终结果照常生成');
  // 快照便宜时仍按原来的帧率
  let fast = 20000;
  const cheap = new CreativeStreamProcessor({ now: () => fast, clock: () => fast, minChunkChars: 1, applyDisplay: value => value });
  assert.ok(cheap.append('a'));
  fast += 60;
  assert.ok(cheap.append('b'));
};

testPreviewBalance();
testAdaptiveThrottleForExpensiveSnapshots();
testIncompleteReasoningSplit();
testPreviewFallbackWhenRegexEmpties();
testThrottleAndFinalize();
testIncompleteImagePromptSurvivesRegex();
testContentWrapperHiddenDuringStream();

console.log('creative-stream-processor tests passed');
