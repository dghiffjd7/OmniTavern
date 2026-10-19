import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [css, indexHtml, panelSource, editorSource, appSource] = await Promise.all([
  readFile(new URL('../../src/assets/css/variable-manager.css', import.meta.url), 'utf8'),
  readFile(new URL('../../src/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../../src/scripts/ui/variable-panel.js', import.meta.url), 'utf8'),
  readFile(new URL('../../src/scripts/ui/variable-schema-editor.js', import.meta.url), 'utf8'),
  readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8'),
]);

assert.match(indexHtml, /assets\/css\/variable-manager\.css/);
assert.match(css, /\.variable-manager-rail/);
assert.match(css, /\.variable-manager-mobile-tabs/);
assert.match(css, /\.variable-inspector-panel/);
assert.match(css, /width:\s*372px/);
assert.match(css, /@media\s*\(max-width:\s*767px\)/);
assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
assert.match(css, /body\[data-reduced-motion='on'\]/);
assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
assert.match(css, /var\(--app-accent-primary/);
assert.match(css, /var\(--app-surface-card/);
assert.doesNotMatch(css, /var\(--app-surface-elevated(?:,|\))/);
assert.match(css, /\.variable-view-pill/);
assert.match(css, /260ms cubic-bezier\(\.22,\s*1,\s*\.36,\s*1\)/);
assert.match(css, /\.variable-inspector-panel[\s\S]*340ms cubic-bezier\(0\.32,\s*0\.72,\s*0,\s*1\)/);
assert.match(css, /--variable-enter-index/);
assert.match(
  css,
  /\.variable-manager-close\s*\{[\s\S]*?animation:\s*variable-manager-close-pulse/,
);
assert.match(
  css,
  /\.variable-manager-close:hover,\s*\.variable-manager-close:focus-visible/,
);
assert.match(css, /@keyframes\s+variable-manager-close-pulse/);
const darkCloseRule = css.match(
  /body\[data-theme-mode='dark'\]\s+\.variable-panel-shell\.variable-manager-shell\s+\.variable-manager-close\.variable-rail-button\s*\{([^}]+)\}/,
)?.[1] || '';
assert.match(darkCloseRule, /color:\s*var\(--vm-danger\)\s*!important/);
assert.match(darkCloseRule, /background:[^;]+!important/);
assert.match(darkCloseRule, /border-color:[^;]+!important/);
const reducedMotionCss = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
assert.match(reducedMotionCss, /\.variable-manager-close/);
assert.match(
  reducedMotionCss,
  /body\[data-reduced-motion='on'\]\s+\.variable-manager-close/,
);

assert.match(panelSource, /VARIABLE_LIST_BATCH_SIZE\s*=\s*80/);
assert.match(panelSource, /reconvertMvuVariables/);
assert.match(panelSource, /initializeMvuVariables/);
assert.match(panelSource, /启用当前会话变量运行/);
assert.match(panelSource, /role="switch"/);
assert.match(panelSource, /setVariableRuntimeEnabled/);
assert.match(panelSource, /result\?\.ok\s*===\s*true/);
assert.match(css, /\.variable-runtime-control/);
assert.match(panelSource, /graveyard/);
assert.match(panelSource, /event\.key === '\/'/);
assert.match(panelSource, /event\.key\.toLowerCase\(\) === 'n'/);
assert.match(editorSource, /variable-inspector-preview-ring/);
assert.match(editorSource, /getInitialValue/);
assert.match(editorSource, /restoreInitialValue/);
assert.match(appSource, /variablePanel\.closeTopLayer\(\)/);
assert.match(appSource, /variablePanel\.hasVisibleLayer\(\)/);

console.log('ok - variable manager keeps the three-page responsive tokenized motion contract');

// --app-accent-secondary 没有任何主题定义：不带备用色时整条渐变失效，浅色下主按钮成了白字白底（规则编辑「保存」看不见）
const runtimeSource = await readFile(new URL('../../src/scripts/ui/variable-panel-runtime.js', import.meta.url), 'utf8');
assert.doesNotMatch(runtimeSource, /var\(--app-accent-secondary\)/);
assert.match(runtimeSource, /id="rule-save" style="[^"]*var\(--app-accent-secondary, var\(--app-accent-primary\)\)/);
console.log('ok - variable panel primary buttons keep a background when the secondary accent token is undefined');
