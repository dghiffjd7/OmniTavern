import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { resolveStickerPanelLayout } = await import('../../src/scripts/ui/chat/sticker-panel-layout-utils.js');

// 每页排满两行：手机固定 4 列；宽屏按面板宽度算列数，不再出现「一行 7 张、第二行只剩 1 张」
assert.deepEqual(resolveStickerPanelLayout({ panelWidth: 412, wide: false }), { columns: 4, pageSize: 8 });
assert.deepEqual(resolveStickerPanelLayout({ panelWidth: 796, wide: true }), { columns: 7, pageSize: 14 });
assert.deepEqual(resolveStickerPanelLayout({ panelWidth: 480, wide: true }), { columns: 4, pageSize: 8 }, 'never fewer than four columns');
assert.deepEqual(resolveStickerPanelLayout({ panelWidth: 0, wide: true }), { columns: 4, pageSize: 8 }, 'an unmeasured panel falls back to four columns');

// 宽屏的格子列数跟着每页张数走
const css = await readFile(new URL('../../src/assets/css/qq-legacy.css', import.meta.url), 'utf8');
assert.match(css, /@media \(min-width: 600px\) \{\s*(?:\/\*[^*]*\*\/\s*)?\.sticker-page \{\s*grid-template-columns: repeat\(var\(--sticker-cols, 4\), minmax\(70px, 96px\)\);\s*grid-template-rows: repeat\(2, auto\);/);

console.log('ok - sticker pages fill two full rows on phones and wide screens');
