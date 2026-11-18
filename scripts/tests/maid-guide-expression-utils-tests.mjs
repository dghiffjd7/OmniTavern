import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  MAID_GUIDE_EXPRESSIONS,
  MAID_GUIDE_EXPRESSION_BACKGROUND,
  MAID_GUIDE_EXPRESSION_SHEET_SRC,
  MAID_GUIDE_EXPRESSION_TOP,
  MAID_GUIDE_EXPRESSION_ZOOM,
  applyMaidGuideExpression,
  getMaidGuideExpression,
  resolveMaidGuideExpressionState,
} from '../../src/scripts/ui/maid-guide-expression-utils.js';

assert.equal(Object.keys(MAID_GUIDE_EXPRESSIONS).length, 16);
assert.deepEqual(getMaidGuideExpression('welcome'), { state: 'welcome', row: 0, column: 0 });
assert.deepEqual(getMaidGuideExpression('complete'), { state: 'complete', row: 3, column: 3 });
assert.equal(getMaidGuideExpression('missing').state, 'welcome');

assert.equal(resolveMaidGuideExpressionState({ phase: 'done' }), 'complete');
assert.equal(resolveMaidGuideExpressionState({ step: { action: 'click' } }), 'point');
assert.equal(resolveMaidGuideExpressionState({ step: { action: 'type' } }), 'clipboard');
assert.equal(resolveMaidGuideExpressionState({ step: { action: 'wait-event', target: 'chat-body' } }), 'waiting');
assert.equal(resolveMaidGuideExpressionState({ step: { expression: 'apology' } }), 'apology');

// 表情用整张表的 <img> 画、头像框裁出一格（不用 CSS 背景图：只取表的一格时浏览器不用 mipmap，桌面缩小会出锯齿）；
// 半身构图：每格放大 1.45 倍、横向居中、顶部留 3%。
const makeElement = () => {
  const node = tag => {
    const classes = new Set();
    const item = { tagName: tag.toUpperCase(), children: [], dataset: {}, style: {}, ownerDocument: null,
      classList: { add: value => classes.add(value), contains: value => classes.has(value) },
      appendChild(child) { item.children.push(child); return child; } };
    Object.defineProperty(item, 'className', { get: () => [...classes].join(' '), set: (value) => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(name => classes.add(name)); } });
    return item;
  };
  const doc = { createElement: tag => { const child = node(tag); child.ownerDocument = doc; return child; } };
  return doc.createElement('span');
};
const element = makeElement();
const applied = applyMaidGuideExpression(element, 'encourage');
assert.equal(applied.state, 'encourage');
assert.equal(element.dataset.maidExpression, 'encourage');
assert.equal(MAID_GUIDE_EXPRESSION_ZOOM, 1.45);
assert.equal(MAID_GUIDE_EXPRESSION_TOP, 0.03);
assert.equal(MAID_GUIDE_EXPRESSION_BACKGROUND, '#efedf7');
assert.equal(element.style.backgroundColor, MAID_GUIDE_EXPRESSION_BACKGROUND);
assert.equal(element.style.backgroundImage, undefined, 'no CSS background sprite');
assert.equal(element.style.overflow, 'hidden');
assert.equal(element.classList.contains('maid-guide-expression'), true);
assert.equal(element.children.length, 1);
const sheet = element.children[0];
assert.equal(sheet.tagName, 'IMG');
assert.equal(sheet.src, MAID_GUIDE_EXPRESSION_SHEET_SRC);
// encourage = 第 4 行第 3 列：整张表 580%（4 格 × 1.45），左移 2×1.45+0.225 框、上移 (3+0.03)×1.45 框
assert.match(sheet.style.cssText, /left:-312.5%;top:-439.35%;width:580%;height:580%;max-width:none;/);
applyMaidGuideExpression(element, 'welcome');
assert.equal(element.children.length, 1, 'switching expression reuses the same image');
assert.match(element.children[0].style.cssText, /left:-22.5%;top:-4.35%;/);

assert.equal(MAID_GUIDE_EXPRESSION_SHEET_SRC, './assets/media/maid-guide-expression-sheet.webp');

const assertLosslessSheet = (basename, expectedEdge, expectedCell, minSize) => {
  let canonicalBytes = null;
  for (const path of [
    `../../src/assets/media/${basename}`,
    `../../src-tauri/resources/media/${basename}`,
    `../../src-tauri/gen/android/app/src/main/assets/resources/media/${basename}`,
  ]) {
    const url = new URL(path, import.meta.url);
    const stat = fs.statSync(url);
    assert.ok(stat.size > minSize && stat.size < 3_000_000, `${path} should retain lossless sprite detail`);
    const bytes = fs.readFileSync(url);
    const chunkOffset = bytes.indexOf(Buffer.from('VP8L'));
    assert.ok(chunkOffset > 0, `${path} should contain a lossless VP8L chunk`);
    const frameOffset = chunkOffset + 8;
    assert.equal(bytes[frameOffset], 0x2f, `${path} should contain a valid VP8L signature`);
    const dimensions = bytes.readUInt32LE(frameOffset + 1);
    assert.deepEqual(
      [(dimensions & 0x3fff) + 1, ((dimensions >>> 14) & 0x3fff) + 1],
      [expectedEdge, expectedEdge],
      `${path} should use four integer ${expectedCell}px cells`,
    );
    if (canonicalBytes) assert.equal(bytes.equals(canonicalBytes), true, `${path} should match the web asset byte-for-byte`);
    else canonicalBytes = bytes;
  }
};

// 320px/格：半身裁切后一格显示约 221 源像素，够手机 3 倍屏 72px 的完成卡 1:1。
assertLosslessSheet('maid-guide-expression-sheet.webp', 1280, 320, 1_000_000);
for (const basename of ['maid-guide-expression-sheet-compact.webp', 'maid-guide-expression-sheet-hdpi.webp']) {
  for (const dir of ['src/assets/media', 'src-tauri/resources/media', 'src-tauri/gen/android/app/src/main/assets/resources/media']) {
    assert.equal(fs.existsSync(new URL(`../../${dir}/${basename}`, import.meta.url)), false, `${dir}/${basename} is no longer used`);
  }
}

console.log('ok - maid guide crops 16 half-body expressions from one lossless 320px-cell sheet drawn as an <img>');
