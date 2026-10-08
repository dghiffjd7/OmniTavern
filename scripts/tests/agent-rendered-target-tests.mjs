import assert from 'node:assert/strict';
import { collectRenderedAgentExcludedRanges, resolveRenderedAgentTarget, spliceRenderedAgentTarget } from '../../src/scripts/agent/agent-rendered-target.js';

const resolve = (raw, display, options) => {
  const target = resolveRenderedAgentTarget(raw, display, options);
  assert.equal(target.ok, true, target.message);
  return target;
};

const plain = 'First line.\r\n\r\nSecond line.';
assert.equal(spliceRenderedAgentTarget(resolve(plain, 'First line.\n\nSecond line.'), 'Opening.\n\nMiddle.\n\nEnding.'), 'Opening.\r\n\r\nMiddle.\r\n\r\nEnding.');
assert.equal(spliceRenderedAgentTarget(resolve('  Body.  ', 'Body.'), 'Revised.'), '  Revised.  ');
const wrapped = '<content>**A paragraph.**</content>';
assert.equal(spliceRenderedAgentTarget(resolve(wrapped, 'A paragraph.'), 'A better paragraph.'), '<content>**A better paragraph.**</content>');

const html = '<div class="story"><p>Tom &amp; Sue &lt;3.</p><p>She smiled &#x1f642;.</p></div>';
const htmlTarget = resolve(html, 'Tom & Sue <3.\n\nShe smiled 🙂.');
assert.equal(spliceRenderedAgentTarget(htmlTarget, 'Tom & Sue laughed.\n\nShe said <hello>.'), '<div class="story"><p>Tom &amp; Sue laughed.</p><p>She said &lt;hello&gt;.</p></div>');
assert.equal(spliceRenderedAgentTarget(htmlTarget, htmlTarget.text), html, 'unchanged entities retain their original spelling');
assert.equal(spliceRenderedAgentTarget(resolve('<p>One.</p>', 'One.'), 'Two.\nThree.'), '<p>Two.<br>Three.</p>');
assert.throws(() => spliceRenderedAgentTarget(htmlTarget, 'One merged paragraph.'), /段落无法安全对应/);

const hidden = '<think>Repeated line.</think>\r\n<content>Repeated line.\r\n\r\nSecond line.</content>'
  + '<tableEdit>updateRow(0, 0, {"x":"Second line."})</tableEdit>'
  + '<details><summary>摘要</summary>Repeated line.</details><summary>Second line.</summary>'
  + '<table><tr><td>Second line.</td></tr></table><script>Second line.</script>';
const hiddenTarget = resolve(hidden, 'Repeated line.\n\nSecond line.');
assert.equal(spliceRenderedAgentTarget(hiddenTarget, 'Natural line.\n\nSecond line.'), hidden.replace('<content>Repeated line.', '<content>Natural line.'));
assert.ok(collectRenderedAgentExcludedRanges('<cot>secret</cot><abstract>secret</abstract><摘要>秘密</摘要>').length > 0);
assert.equal(resolveRenderedAgentTarget('<analysis>Only secret.</analysis>', 'Only secret.').ok, false);
assert.equal(resolveRenderedAgentTarget('<details>Only secret.</details>', 'Only secret.').ok, false);
assert.equal(resolveRenderedAgentTarget('<div hidden>Secret.</div>', 'Secret.').ok, false);
assert.equal(resolveRenderedAgentTarget('<div style="display: none">Secret.</div>', 'Secret.').ok, false);
assert.equal(resolveRenderedAgentTarget('<think>unfinished secret', 'unfinished secret').ok, false);
const customized = 'BEGIN_PRIVATE\nBody.\nEND_PRIVATE\nBody.';
const excludedRanges = [{ start: 0, end: customized.indexOf('END_PRIVATE') + 'END_PRIVATE'.length }];
assert.equal(spliceRenderedAgentTarget(resolve(customized, 'Body.', { excludedRanges }), 'Visible.'), customized.slice(0, customized.lastIndexOf('Body.')) + 'Visible.');

assert.equal(resolveRenderedAgentTarget('Repeated.\nRepeated.', 'Repeated.').reason, 'rendered_target_ambiguous');
assert.equal(resolveRenderedAgentTarget('<p>She <b>smiled</b>.</p>', 'She smiled.').reason, 'rendered_target_unmapped');
assert.equal(resolveRenderedAgentTarget('Original.', 'Transformed by a display regex.').reason, 'rendered_target_unmapped');
assert.equal(resolveRenderedAgentTarget('First.\nSecond.', 'Second.\nFirst.').reason, 'rendered_target_order');
assert.equal(resolveRenderedAgentTarget('Body.', '').reason, 'empty_target');
assert.equal(resolveRenderedAgentTarget('Body.', 'Body.', { maxChars: 3 }).reason, 'target_too_long');

const islands = 'Prefix.\nA paragraph.<details>Untouched summary.</details>B paragraph.\nSuffix.';
const islandsTarget = resolve(islands, 'A paragraph.\n\nB paragraph.');
assert.equal(spliceRenderedAgentTarget(islandsTarget, 'Revised A.\n\nRevised B.'), 'Prefix.\nRevised A.<details>Untouched summary.</details>Revised B.\nSuffix.');
assert.throws(() => spliceRenderedAgentTarget(islandsTarget, 'Combined.'), /段落无法安全对应/);
const partial = resolve('Prefix.\nVisible.\nHidden.\nVisible second.\nSuffix.', 'Visible.\nVisible second.');
assert.equal(spliceRenderedAgentTarget(partial, 'Changed.\nChanged second.'), 'Prefix.\nChanged.\nHidden.\nChanged second.\nSuffix.');
assert.throws(() => spliceRenderedAgentTarget(partial, 'Combined.'), /段落无法安全对应/);
// 跨记号逐字对应（仅快速编辑开启 allowProjected）：Agent 的默认行为不变
{
  const projected = (raw, display) => resolveRenderedAgentTarget(raw, display, { allowProjected: true });
  const write = (raw, display, next) => spliceRenderedAgentTarget(projected(raw, display), next);
  assert.equal(resolveRenderedAgentTarget('"走吧。"*她拉起他的手*', '"走吧。"她拉起他的手').reason, 'rendered_target_unmapped', '未开启时仍按单个文本节点严格对应');
  assert.equal(projected('"走吧。"*她拉起他的手*', '"走吧。"她拉起他的手').projected, true);
  assert.equal(write('"走吧。"*她拉起他的手*', '"走吧。"她拉起他的手', '"走吧。"她轻轻拉起他的手'), '"走吧。"*她轻轻拉起他的手*', '新字跟随前一个字，斜体保留');
  assert.equal(write('他**很**高兴。', '他很高兴', '他非常高兴'), '他**非常**高兴。');
  assert.equal(write('前情。<content>她推开门。</content>', '前情。她推开门。', '前情提要。她用力推开门。'), '前情提要。<content>她用力推开门。</content>', '跨过 XML 标签边界');
  assert.equal(write('<a>第一句。</a><b>第二句。</b>', '第一句。第二句。', '第一句！第二句！'), '<a>第一句！</a><b>第二句！</b>');
  assert.equal(write('去[这里](https://x.y)看', '去这里看', '去那里看'), '去[那里](https://x.y)看', '链接只改显示文字，网址保留');
  assert.equal(write('他点头。*微笑*，离开。', '他点头。微笑，离开。', '他点头。，离开。'), '他点头。，离开。', '记号内的字删光时连同空记号删除');
  assert.equal(write('<span>她说</span>：好', '她说：好', '她说<b>：好'), '<span>她说&lt;b&gt;</span>：好', 'HTML 内插入的字被转义');
  assert.equal(write('第一行。*动作*\n第二行。', '第一行。动作\n第二行。', '第一行。动作第二行。'), '第一行。*动作*第二行。', '合并两行时只删换行，记号保留');
  assert.equal(write('第一行。*动作*<think>想</think>\n第二行。', '第一行。动作\n第二行。', '第一行。动作第二行。'), '第一行。*动作*<think>想</think>第二行。', '隐藏块原样保留');
  assert.equal(write('a😀*b*c', 'a😀bc', 'a😀Xbc'), 'a😀X*b*c', '表情符号按 UTF-16 对位');
  assert.equal(projected('*好的*。\n他点头。\n**好的**。', '好的。').reason, 'rendered_target_ambiguous', '跨记号后出现多次仍拒绝');
  assert.equal(projected('*好的*。\n他点头。\n好的。', '好的。').reason, 'rendered_target_ambiguous', '严格匹配只见一处、显示却出现两次时也拒绝，避免改到另一处');
  assert.equal(projected('他沉默了...', '他沉默了……').reason, 'rendered_target_unmapped', '被正则改过的显示仍无法对应');
  assert.equal(projected('5*3=15，对吗', '5*3=15，对吗').ok, true, '单个 * 是字面字符，保持可见');
  // 编辑器给出逐字来源（ops）时按它写回：新增落在屏幕上显示的位置；ops 与原文、新文字对不上则退回逐字比对
  const wet = projected('衣服*湿了*。', '衣服湿了。');
  const before = [{ type: 'eq', text: '衣服' }, { type: 'ins', text: '湿了' }, { type: 'eq', text: '湿了。' }];
  assert.equal(spliceRenderedAgentTarget(wet, '衣服湿了湿了。'), '衣服*湿了湿了*。');
  assert.equal(spliceRenderedAgentTarget(wet, '衣服湿了湿了。', { ops: before }), '衣服湿了*湿了*。');
  assert.equal(spliceRenderedAgentTarget(wet, '衣服湿了湿了。', { ops: [{ type: 'eq', text: '衣服' }] }), '衣服*湿了湿了*。');
  assert.equal(spliceRenderedAgentTarget(wet, '衣服湿透。', { ops: [{ type: 'eq', text: '衣服湿' }, { type: 'del', text: '了' }, { type: 'ins', text: '透' }, { type: 'eq', text: '。' }] }), '衣服*湿透*。');
  // 选区首尾空白：原文里紧挨着、逐字相同的才纳入编辑；显示时才有的、隔着记号的不纳入；Agent 路径照旧去掉
  const spaced = projected('前文  拉拉  后文', '  拉拉  ');
  assert.equal(spaced.text, '  拉拉  ');
  assert.equal(spliceRenderedAgentTarget(spaced, ''), '前文后文', '整段删掉时两侧空格一起删');
  assert.equal(spliceRenderedAgentTarget(spaced, '  啦啦  '), '前文  啦啦  后文');
  assert.equal(write('第一段。\n　　她说话了。\n第三段。', '　　她说话了。', '她说话了。'), '第一段。\n她说话了。\n第三段。', '全角段首缩进可删');
  assert.equal(write('　　甲说。\n　　乙说。', '　　甲说。\n　　乙说。', '甲说。\n乙说。'), '甲说。\n乙说。', '多行逐行处理行首空白');
  assert.equal(projected('她说话了。', '　　她说话了。').text, '她说话了。', '显示时加上的缩进不纳入');
  assert.equal(projected('x 拉拉', '　 拉拉').text, ' 拉拉', '只纳入原文里逐字相同的那部分');
  assert.equal(write('  *拉拉*  ', '  拉拉  ', '啦'), '  *啦*  ', '不跨过记号对应空白');
  assert.equal(write('<think>x</think>  拉拉', '  拉拉', '啦'), '<think>x</think>啦');
  assert.equal(write('<p>  拉拉  </p>', '  拉拉  ', ''), '<p></p>');
  assert.equal(resolveRenderedAgentTarget('a  拉拉  b', '  拉拉  ').text, '拉拉', 'Agent 仍去掉首尾空白');
  // 气泡合并连续空白时，显示的一个空格对应原文一整串半角空格或 Tab；全角空格仍逐字对应
  const collapsed = resolveRenderedAgentTarget('前文  拉拉\t 后文', ' 拉拉 ', { allowProjected: true, collapseSpaces: true });
  assert.equal(collapsed.text, '  拉拉\t ');
  assert.equal(spliceRenderedAgentTarget(collapsed, ''), '前文后文');
  assert.equal(projected('前文  拉拉  后文', ' 拉拉 ').text, ' 拉拉 ', '按原样显示的气泡只纳入选中的空格');
  assert.equal(resolveRenderedAgentTarget('前文　 拉拉', '　 拉拉', { allowProjected: true, collapseSpaces: true }).text, '　 拉拉');
  assert.equal(resolveRenderedAgentTarget('前文　　拉拉', ' 拉拉', { allowProjected: true, collapseSpaces: true }).text, '拉拉', '半角空格不对应全角空格');
  assert.equal(projected('段一。\n\n  拉拉\n', '\n  拉拉\n\n').text, '  拉拉', '首尾空行不纳入');
  assert.equal(write('纯文字一行。', '纯文字一行', '改过的一行'), '改过的一行。', '严格对应的选区仍走原写回逻辑');
}
console.log('agent rendered target tests passed');
