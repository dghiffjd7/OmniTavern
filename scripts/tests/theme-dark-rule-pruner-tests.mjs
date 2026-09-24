import assert from 'node:assert/strict';

const {
  countDarkOnlyRules,
  createThemeDarkRulePruner,
  isDarkOnlySelectorText,
  removeDarkOnlyRules,
  splitSelectorList,
} = await import('../../src/scripts/ui/theme-dark-rule-pruner.js');

// 暗色专属规则：只有每个选择器都要求 body 为暗色时才算，浅色下移除、暗色前按原位放回

assert.deepEqual(splitSelectorList('a, b:is(.x, .y), c[title="1,2"]'), ['a', 'b:is(.x, .y)', 'c[title="1,2"]']);
assert.equal(isDarkOnlySelectorText('body[data-theme-mode="dark"] .a'), true);
assert.equal(isDarkOnlySelectorText("body[data-theme-mode='dark'] :is(.a, .b) :is([style*=\"background:#fff\"])"), true);
assert.equal(isDarkOnlySelectorText('body[data-theme-mode="dark"]:not(.x) .a, body[data-theme-mode="dark"] > .b'), true);
assert.equal(isDarkOnlySelectorText('body[data-theme-mode="dark"]'), true);
assert.equal(isDarkOnlySelectorText('body[data-theme-mode="dark"] .a, .b'), false, '选择器列表里有通用部分时保留');
assert.equal(isDarkOnlySelectorText('body[data-theme-mode="darker"] .a'), false);
assert.equal(isDarkOnlySelectorText('body[data-theme-mode="light"] .a'), false);
assert.equal(isDarkOnlySelectorText('.a body[data-theme-mode="dark"] .b'), false, '不以 body 暗色开头的不算');
console.log('ok - dark-only selector detection requires every selector to start with the dark body');

const makeContainer = (rules) => ({
  cssRules: rules,
  disabled: false,
  deleteRule(index) { rules.splice(index, 1); },
});
const styleRule = (selectorText, body = 'color: red;') => ({ selectorText, cssText: `${selectorText} { ${body} }` });
const serialize = container => container.cssRules.map(rule => (rule.selectorText !== undefined ? rule.cssText : `@media{${serialize(rule)}}`)).join('|');
const makeSheet = () => makeContainer([
  styleRule(':root'),
  styleRule('body[data-theme-mode="dark"] .a'),
  styleRule('.b'),
  makeContainer([
    styleRule('.m1'),
    styleRule('body[data-theme-mode="dark"] .m2'),
    styleRule('body[data-theme-mode="dark"] .m3'),
  ]),
  styleRule('body[data-theme-mode="dark"] .c, .keep'),
  styleRule('body[data-theme-mode="dark"] :is(.d, .e)'),
]);

{
  const sheet = makeSheet();
  assert.equal(countDarkOnlyRules(sheet), 4);
  assert.equal(removeDarkOnlyRules(sheet), 4);
  assert.equal(serialize(sheet), [
    ':root { color: red; }', '.b { color: red; }', '@media{.m1 { color: red; }}', 'body[data-theme-mode="dark"] .c, .keep { color: red; }',
  ].join('|'), '只删暗色专属规则，其余规则与顺序不变（含 @media 内）');
  console.log('ok - dark-only rules are removed in place without rewriting other rules');
}

{
  // 模拟 DOM：副本插在原表之前，加载后裁剪；浅色启用副本、暗色启用原表
  const order = [];
  const makeLink = (sheet) => {
    const listeners = {};
    const link = {
      dataset: {},
      sheet,
      addEventListener: (type, fn) => { listeners[type] = fn; },
      fire: type => listeners[type]?.(),
      cloneNode: () => {
        const clone = makeLink(null);
        clone.pendingSheet = makeSheet();
        return clone;
      },
      before: (node) => { order.splice(order.indexOf(link), 0, node); },
      remove: () => { order.splice(order.indexOf(link), 1); },
    };
    return link;
  };
  const original = makeLink(makeSheet());
  const small = makeLink(makeContainer([styleRule('body[data-theme-mode="dark"] .x')]));
  order.push(small, original);
  const documentRef = { querySelectorAll: () => [...order] };
  const pruner = createThemeDarkRulePruner({ documentRef, minRules: 2 });

  const ready = pruner.sync('light');
  assert.equal(order.length, 3, '只为暗色规则达到阈值的样式表建副本');
  const lite = order[1];
  assert.equal(order[2], original, '副本紧贴在原表之前');
  assert.equal(original.sheet.disabled, false, '副本就绪前原表照常生效');
  lite.sheet = lite.pendingSheet;
  lite.fire('load');
  await ready;
  assert.equal(pruner.pairCount, 1);
  assert.equal(countDarkOnlyRules(lite.sheet), 0);
  assert.equal(lite.sheet.disabled, false);
  assert.equal(original.sheet.disabled, true, '浅色：启用裁剪副本，停用原表');
  const untouched = serialize(original.sheet);

  pruner.sync('dark');
  assert.equal(lite.sheet.disabled, true);
  assert.equal(original.sheet.disabled, false, '暗色：启用原表（从未改动）');
  assert.equal(serialize(original.sheet), untouched);
  assert.equal(countDarkOnlyRules(original.sheet), 4);

  pruner.sync('light');
  assert.equal(order.length, 3, '副本只建一次');
  assert.equal(original.sheet.disabled, true);
  console.log('ok - light mode swaps to a pruned copy placed right before the original; dark mode uses the untouched original');
}

{
  const unreadable = { get cssRules() { throw new Error('cross-origin'); } };
  assert.equal(countDarkOnlyRules(unreadable), 0);
  assert.equal(removeDarkOnlyRules(unreadable), 0);
  console.log('ok - unreadable stylesheets are skipped');
}
