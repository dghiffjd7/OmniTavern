import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = file => readFile(path.join(root, file), 'utf8');

// 系统深色时安卓状态栏图标是白色：浅色界面铺到状态栏后面，要像聊天页一样垫一层遮罩。
// 遮罩颜色统一用 --app-statusbar-scrim，系统浅色（深色图标）时是透明
const theme = await read('src/assets/css/theme.css');
assert.match(theme, /:root \{[^}]*--app-statusbar-scrim: transparent;/, 'the scrim token defaults to transparent');
assert.match(
  theme,
  /@media \(prefers-color-scheme: dark\) \{\s*:root \{\s*--app-statusbar-scrim: var\(--app-surface-overlay\);\s*\}\s*\}/,
  'the scrim token uses the theme overlay color when the status bar icons are white',
);

// 手机上贴顶的全屏界面：标题栏放一层只有状态栏高的遮罩
const heads = [
  ['src/scripts/ui/tools/user-tool-settings-panel.js', '.uts-head'],
  ['src/scripts/ui/mcp-server-panel.js', '.mcp-head'],
  ['src/scripts/ui/memory-overview-panel.js', '.mo-head'],
  ['src/scripts/ui/agent-directory-panel.js', '.ad-head'],
  ['src/scripts/ui/maid-settings-panel.js', '.maid-settings-header'],
  ['src/assets/css/variable-manager.css', '.variable-manager-mobile-header'],
];
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [file, selector] of heads) {
  const source = await read(file);
  const sel = escape(selector);
  assert.match(source, new RegExp(`${sel} \\{[^}]*position: relative;`), `${file}: ${selector} hosts the scrim`);
  assert.match(
    source,
    new RegExp(`${sel}::before \\{[^}]*height: env\\(safe-area-inset-top, 0px\\);[^}]*var\\(--app-statusbar-scrim, transparent\\)`),
    `${file}: the scrim covers only the status bar`,
  );
}

// 代码查看最大化时背景是卡片色，状态栏那一截同样垫遮罩
const codeViewer = await read('src/scripts/ui/chat/code-viewer-ui-utils.js');
assert.match(
  codeViewer,
  /const CODE_VIEWER_MAXIMIZED_BACKGROUND = 'linear-gradient\(180deg, var\(--app-statusbar-scrim, transparent\) [^']*env\(safe-area-inset-top, 0px\)\), var\(--app-surface-card\)';/,
);
assert.match(codeViewer, /overlay\.style\.background = maximized \? CODE_VIEWER_MAXIMIZED_BACKGROUND : /);

// 女仆面板「半屏」按可见高度算：安卓弹出键盘时页面高度不变，52dvh 会把面板顶进状态栏
const maidInput = await read('src/scripts/ui/maid-command-input-runtime-utils.js');
assert.match(
  maidInput,
  /\[data-snap="half"\] \.maid-command-input-result \{ max-height: calc\(\(100dvh - var\(--mci-keyboard-offset, 0px\)\) \* 0\.52\); \}/,
);

console.log('ok - full-screen phone surfaces keep white status bar icons readable');
