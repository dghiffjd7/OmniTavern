import assert from 'node:assert/strict';
import {
  applyInlineEditTextChange, cloneInlineEditProvenance, createInlineEditProvenance, inlineEditOps,
  inlineEditSegments, provenanceText, restoreInlineEditDeleted,
} from '../../src/scripts/ui/chat/inline-edit-provenance.js';

const view = state => inlineEditSegments(state).map(({ type, text }) => type === 'eq' ? text : `<${type}>${text}</${type}>`).join('');
const insertAt = (state, at, text) => {
  const current = provenanceText(state);
  return applyInlineEditTextChange(state, current.slice(0, at) + text + current.slice(at), at + text.length);
};
const backspaceAt = (state, at, count = 1) => {
  const current = provenanceText(state);
  return applyInlineEditTextChange(state, current.slice(0, at - count) + current.slice(at), at - count);
};

{
  const state = createInlineEditProvenance('雨落在肩头。');
  assert.equal(applyInlineEditTextChange(state, '雨落在肩头。', 6), false, '文字没变不记变动');
  assert.equal(view(state), '雨落在肩头。');
}

{
  // 先在「肩头」后加字，再在「肩头」前加字：肩头本身不应被当成删掉又加回
  const state = createInlineEditProvenance('雨落在肩头。');
  insertAt(state, 5, '啦啦啦');
  insertAt(state, 3, '哦');
  assert.equal(view(state), '雨落在<ins>哦</ins>肩头<ins>啦啦啦</ins>。');
}

{
  // 在重复文字前插入同样的文字：按光标位置判断新增在前
  const state = createInlineEditProvenance('衣服湿了。');
  insertAt(state, 2, '湿了');
  assert.equal(view(state), '衣服<ins>湿了</ins>湿了。');
  backspaceAt(state, 5, 1);
  assert.equal(view(state), '衣服<del>湿</del><ins>湿了</ins>了。', '退格删原文显示为红字，排在同一空隙的新增之前');
  assert.equal(restoreInlineEditDeleted(state, 2, 3), 3);
  assert.equal(view(state), '衣服湿<ins>湿了</ins>了。', '恢复的原文放回原位，同一空隙的新增排在它后面');
  backspaceAt(state, 5, 1);
  assert.equal(view(state), '衣服湿<ins>湿</ins>了。', '删掉自己新加的字直接消失');
}

{
  // 同一空隙里先显示删除、再显示新增；点红字恢复后新增排在恢复的原文之后
  const state = createInlineEditProvenance('他伸手拉起她的手。');
  backspaceAt(state, 8, 2);
  insertAt(state, 6, '那只手');
  assert.equal(view(state), '他伸手拉起她<del>的手</del><ins>那只手</ins>。');
  const segments = inlineEditSegments(state);
  const deleted = segments.find(segment => segment.type === 'del');
  assert.deepEqual([deleted.from, deleted.to], [6, 8]);
  const snapshot = cloneInlineEditProvenance(state);
  const caret = restoreInlineEditDeleted(state, deleted.from, deleted.to);
  assert.equal(caret, 8);
  assert.equal(view(state), '他伸手拉起她的手<ins>那只手</ins>。');
  assert.equal(view(snapshot), '他伸手拉起她<del>的手</del><ins>那只手</ins>。', '快照不受之后的修改影响');
  assert.deepEqual(inlineEditOps(snapshot), [
    { type: 'eq', text: '他伸手拉起她' }, { type: 'del', text: '的手' }, { type: 'ins', text: '那只手' }, { type: 'eq', text: '。' },
  ]);
}

{
  // 选中替换：删除与新增在同一处
  const state = createInlineEditProvenance('今天很冷。');
  applyInlineEditTextChange(state, '今天很热。', 4);
  assert.equal(view(state), '今天很<del>冷</del><ins>热</ins>。');
  // 不相邻的两段删除各自成块
  const two = createInlineEditProvenance('甲乙丙丁');
  backspaceAt(two, 2, 1); backspaceAt(two, 3, 1);
  assert.deepEqual(inlineEditSegments(two).filter(segment => segment.type === 'del').map(({ from, to }) => [from, to]), [[1, 2], [3, 4]]);
}

console.log('inline-edit-provenance tests passed');
