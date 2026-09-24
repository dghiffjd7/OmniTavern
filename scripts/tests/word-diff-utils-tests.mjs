import assert from 'node:assert/strict';

import {
  alignLinesWithWords,
  annotateLineDiffWords,
  countWordDiffChanges,
  diffWords,
  renderWordDiffHtml,
  tokenizeForWordDiff,
} from '../../src/scripts/utils/word-diff-utils.js';
import { buildLineDiff } from '../../src/scripts/utils/line-diff-utils.js';

// 字词级 diff：中文按字、英文按词；把整段划掉重写的改写还原成几处具体改动

const joinSide = (groups, side) => groups.map(g => (g.type === 'equal' ? g.text : (side === 'old' ? g.del : g.ins))).join('');

{
  assert.deepEqual(tokenizeForWordDiff('Hi 你好, world_1!'), ['Hi', ' ', '你', '好', ',', ' ', 'world_1', '!']);
  assert.deepEqual(diffWords('same', 'same'), [{ type: 'equal', text: 'same' }]);
  assert.deepEqual(diffWords('', ''), []);
  console.log('ok - tokenizer splits CJK by character and latin by word');
}

{
  for (const [oldChar, newChar] of [['😀', '😁'], ['𠮷', '𠮸'], ['🇨🇳', '🇨🇦'], ['❤️', '❤'], ['👨‍👩‍👧', '👨‍👩‍👦'], ['👍🏽', '👍🏿'], ['1️⃣', '2️⃣'], ['é', 'è']]) {
    const oldText = `字符${oldChar}保留`;
    const newText = `字符${newChar}保留`;
    const groups = diffWords(oldText, newText);
    assert.equal(joinSide(groups, 'old'), oldText);
    assert.equal(joinSide(groups, 'new'), newText);
    for (const side of ['merged', 'old', 'new']) {
      const html = renderWordDiffHtml(groups, { side });
      assert.doesNotMatch(html, /[\uD800-\uDFFF]/u, 'HTML nodes must not split Unicode surrogate pairs');
      if (side !== 'new') assert.ok(html.includes(`<del class="wd-del">${oldChar}</del>`));
      if (side !== 'old') assert.ok(html.includes(`<ins class="wd-ins">${newChar}</ins>`));
    }
  }
  console.log('ok - emoji sequences, flags, keycaps and supplementary CJK stay whole in every diff view');
}

{
  const cases = [
    ['e\u0301', 'e\u0300', 'e\u0301', 'e\u0300'],
    ['Cafe\u0301', 'Cafe\u0300', 'Cafe\u0301', 'Cafe\u0300'],
    ['\u2764\uFE0E', '\u2764', '\u2764\uFE0E', '\u2764'],
    ['\u2764\uFE0E', '\u2764\uFE0F', '\u2764\uFE0E', '\u2764\uFE0F'],
    ['step1️⃣', 'step2️⃣', '1️⃣', '2️⃣'],
    ['v11️⃣next', 'v12️⃣next', '1️⃣', '2️⃣'],
    ['word1\u20E3x', 'word2\u20E3x', '1\u20E3', '2\u20E3'],
  ];
  for (const [oldText, newText, removed, inserted] of cases) {
    const groups = diffWords(oldText, newText);
    assert.equal(joinSide(groups, 'old'), oldText, 'preserve the exact original Unicode sequence');
    assert.equal(joinSide(groups, 'new'), newText, 'preserve the exact replacement Unicode sequence');
    for (const side of ['merged', 'old', 'new']) {
      const html = renderWordDiffHtml(groups, { side });
      if (side !== 'new') assert.ok(html.includes(`<del class="wd-del">${removed}</del>`), `${oldText}: keep the removed glyph whole in ${side}`);
      if (side !== 'old') assert.ok(html.includes(`<ins class="wd-ins">${inserted}</ins>`), `${newText}: keep the inserted glyph whole in ${side}`);
    }
  }
  console.log('ok - combining accents, both variation selectors and adjacent keycaps stay inside their diff marks');
}

{
  const OLD = '阳翔如果想听姐姐的完整计划，周六早上八点半姐姐会来，第四步用静电拖把把死角灰尘吸干净再整体拖一遍地，你看这样好不好呀？';
  const NEW = '阳翔，如果想听姐姐的完整计划，周六早上八点半，姐姐会来，第四步，用静电拖把吸干净死角灰尘，再整体拖一遍地。你看这样好不好呀？';
  const groups = diffWords(OLD, NEW);
  assert.equal(joinSide(groups, 'old'), OLD, '旧文可以从分组还原');
  assert.equal(joinSide(groups, 'new'), NEW, '新文可以从分组还原');
  const changes = groups.filter(g => g.type === 'change');
  assert.ok(changes.length >= 4 && changes.length <= 9, `改动被拆成少量具体位置，实际 ${changes.length}`);
  assert.ok(changes.some(g => g.ins === '，' && !g.del), '补逗号识别为单纯插入');
  assert.ok(groups.filter(g => g.type === 'equal').reduce((n, g) => n + g.text.length, 0) > OLD.length * 0.7, '大部分文字保持不变');
  console.log('ok - prose rewrite is reduced to a few precise word changes');
}

{
  const groups = diffWords('ab你cd', 'ab我cx');
  assert.equal(countWordDiffChanges(groups), 1, '夹在两处改动之间的单个字并入改动，不碎成两处');
  console.log('ok - single-char islands between changes are merged');
}

{
  const rows = annotateLineDiffWords(buildLineDiff('一\n今天天气很好\n三', '一\n今天天气真好\n三\n新增行', { collapseContext: false }).rows);
  const del = rows.find(r => r.type === 'del');
  const add = rows.find(r => r.type === 'add' && r.text === '今天天气真好');
  assert.ok(del.words && add.words, '一删一增的改写配对并附上字词分组');
  assert.equal(rows.find(r => r.text === '新增行').words, undefined, '纯新增行不配对');
  const unrelated = annotateLineDiffWords(buildLineDiff('完全不同的一句话', 'xyz 123', { collapseContext: false }).rows);
  assert.ok(unrelated.every(r => !r.words), '相似度过低视为整行重写，不做行内细分');
  console.log('ok - line diff rows get word groups only for similar paired rewrites');
}

{
  const rows = alignLinesWithWords(['保留', '润色正文。', '删掉这行'], ['保留', '润色正文，保留语气。', '新加一行', '新加两行']);
  assert.deepEqual(rows.map(r => r.type), ['equal', 'modified', 'modified', 'added']);
  assert.ok(rows[1].words, '相似改写带字词分组');
  assert.equal(rows[2].words, null, '不相似的配对不细分');
  assert.equal(rows[3].newText, '新加两行');
  assert.deepEqual(rows.map(r => r.oldIndex), [0, 1, 2, null]);
  assert.deepEqual(rows.map(r => r.newIndex), [0, 1, 2, 3]);
  console.log('ok - patch lines align with modified / removed / added rows');
}

{
  const big = 'a'.repeat(3000);
  const groups = diffWords(`${big}甲。${big}`, `${big}乙。${big}`);
  assert.equal(joinSide(groups, 'new'), `${big}乙。${big}`);
  const huge = diffWords(Array.from({ length: 2000 }, (_, i) => `词${i}`).join(' '), Array.from({ length: 2000 }, (_, i) => `字${i}`).join(' '));
  assert.ok(Array.isArray(huge), '超大改写降级处理，不会卡死');
  console.log('ok - large inputs trim common edges and degrade gracefully');
}

{
  const html = renderWordDiffHtml(diffWords('a<b', 'a<c'), { side: 'merged' });
  assert.match(html, /<del class="wd-del">b<\/del><ins class="wd-ins">c<\/ins>/);
  assert.match(html, /^a&lt;/, '转义原文');
  assert.match(renderWordDiffHtml(diffWords('ab', 'ac'), { side: 'old', changeOffset: 3 }), /data-wd-change="3"/);
  assert.doesNotMatch(renderWordDiffHtml(diffWords('ab', 'ac'), { side: 'old' }), /wd-ins/);
  console.log('ok - html rendering escapes text and marks changes per side');
}
