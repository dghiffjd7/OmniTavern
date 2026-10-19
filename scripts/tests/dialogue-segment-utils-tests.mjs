import assert from 'node:assert/strict';

import {
  buildDualVoiceSpeechChunks,
  segmentDialogueRuns,
  segmentDialogueText,
} from '../../src/scripts/ui/chat/dialogue-segment-utils.js';

{
  const segments = segmentDialogueText('她轻轻抬头。\n“早安，主人。”随后把茶放下。\n「今天也请多指教。」');
  assert.deepEqual(segments, [
    { kind: 'narration', text: '她轻轻抬头。\n' },
    { kind: 'dialogue', text: '“早安，主人。”' },
    { kind: 'narration', text: '随后把茶放下。\n' },
    { kind: 'dialogue', text: '「今天也请多指教。」' },
  ]);
  assert.deepEqual(segmentDialogueText('“跨行\n对白”不会命中'), [
    { kind: 'narration', text: '“跨行\n对白”不会命中' },
  ]);
  assert.deepEqual(segmentDialogueText('没有闭合的“对白'), [
    { kind: 'narration', text: '没有闭合的“对白' },
  ]);
  assert.deepEqual(segmentDialogueText('Narration "Hello." End.'), [
    { kind: 'narration', text: 'Narration ' },
    { kind: 'dialogue', text: '"Hello."' },
    { kind: 'narration', text: ' End.' },
  ]);
  assert.deepEqual(segmentDialogueText('旁白 \\"不是对白\\" “是对白”'), [
    { kind: 'narration', text: '旁白 \\"不是对白\\" ' },
    { kind: 'dialogue', text: '“是对白”' },
  ]);
  assert.deepEqual(segmentDialogueText('“她说「你好」后离开”'), [
    { kind: 'dialogue', text: '“她说「你好」后离开”' },
  ]);
  assert.deepEqual(segmentDialogueText('"She said \\"hello\\"."'), [
    { kind: 'dialogue', text: '"She said \\"hello\\"."' },
  ]);
  console.log('ok - dialogue segmentation is deterministic and rejects cross-paragraph or unclosed quotes');
}

{
  // 一段里被加粗等格式拆开的几段文字：引号跨格式也能配对，切回各段后拼起来与原文一致
  const runs = ['她说：“快', '走', '！”随后转身。'];
  const segments = segmentDialogueRuns(runs);
  assert.deepEqual(segments, [
    [{ kind: 'narration', text: '她说：' }, { kind: 'dialogue', text: '“快' }],
    [{ kind: 'dialogue', text: '走' }],
    [{ kind: 'dialogue', text: '！”' }, { kind: 'narration', text: '随后转身。' }],
  ]);
  assert.deepEqual(segments.map(items => items.map(item => item.text).join('')), runs);
  // 换行当作独立一段传入：跨行的引号仍不配对
  assert.deepEqual(segmentDialogueRuns(['“跨行', '\n', '对白”']), [
    [{ kind: 'narration', text: '“跨行' }],
    [{ kind: 'narration', text: '\n' }],
    [{ kind: 'narration', text: '对白”' }],
  ]);
  assert.deepEqual(segmentDialogueRuns(['', '“对白”']), [[], [{ kind: 'dialogue', text: '“对白”' }]]);
  console.log('ok - dialogue runs split by inline formatting still pair their quotes');
}

{
  const chunks = buildDualVoiceSpeechChunks('旁白。“对白很长。”结尾。', {
    narrationConfig: { provider: 'openai', ttsVoice: 'narrator' },
    dialogueConfig: { provider: 'qwen_local', ttsVoice: 'Serena' },
    resolveMaxChars: config => config.provider === 'qwen_local' ? 4 : 10,
  });
  assert.equal(chunks.map(item => item.text).join(''), '旁白。“对白很长。”结尾。');
  assert.equal(chunks.filter(item => item.kind === 'dialogue').length > 1, true);
  assert.equal(chunks.every(item => item.config.ttsVoice === (item.kind === 'dialogue' ? 'Serena' : 'narrator')), true);
  console.log('ok - dual-voice chunks preserve order while applying per-voice provider limits');
}

{
  const chunks = buildDualVoiceSpeechChunks('「你好」\n「再见」', {
    narrationConfig: { provider: 'openai', ttsVoice: 'narrator' },
    dialogueConfig: { provider: 'openai', ttsVoice: 'dialogue' },
  });
  assert.deepEqual(chunks.map(item => item.text), ['「你好」', '「再见」']);
  assert.equal(chunks.every(item => item.text.trim()), true);
  console.log('ok - adjacent dialogue lines never produce whitespace-only speech chunks');
}
