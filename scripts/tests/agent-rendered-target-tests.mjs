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
console.log('agent rendered target tests passed');
