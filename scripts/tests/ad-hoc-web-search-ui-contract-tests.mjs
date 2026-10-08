import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worldEditorSource = await readFile(new URL('../../src/scripts/ui/world-editor.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
const mainCss = await readFile(new URL('../../src/assets/css/main.css', import.meta.url), 'utf8');
const legacyCss = await readFile(new URL('../../src/assets/css/qq-legacy.css', import.meta.url), 'utf8');

assert.match(worldEditorSource, /id="world-ai-web-search"/);
assert.match(worldEditorSource, /createAdHocWebSearchToggleRuntime\(\{/);
assert.match(worldEditorSource, /this\.aiWebSearchToggleRuntime\?\.reset\(\)/);
const worldRun = worldEditorSource.slice(
  worldEditorSource.indexOf('async runWorldAi('),
  worldEditorSource.indexOf('async handleAiGenerate('),
);
assert.match(worldRun, /await this\.aiWebSearchToggleRuntime\?\.consume\(\)/);
// 世界书 AI 走带回退的生成：原生联网失败改用搜索服务，再失败则不联网生成；每次都重新读取当前模型档
assert.match(worldRun, /runAdHocWebSearchChat\(\{/);
assert.match(worldRun, /describeAdHocModel\(config\)/);
assert.match(worldEditorSource, /async ensureChatConfigReady\(\) \{[\s\S]{0,200}this\.chatConfigManager\.reload\(\)/);
assert.match(worldRun, /renderAdHocWebSources\(this\.aiWebSourcesEl, sources\)/);

assert.match(appSource, /id="sticker-ai-web-search"/);
assert.match(appSource, /const webSearchToggleRuntime = createAdHocWebSearchToggleRuntime\(\{/);
const promptHandlers = appSource.slice(
  appSource.indexOf('const runStickerPromptGeneration = async'),
  appSource.indexOf('const show = (options = {})'),
);
assert.equal((promptHandlers.match(/await webSearchToggleRuntime\.consume\(\)/g) || []).length, 1);
// 贴图提示词同样走带回退的生成：原生联网失败改用搜索服务，再失败则不联网生成
assert.equal((promptHandlers.match(/await runAdHocWebSearchChat\(\{/g) || []).length, 1);
assert.equal((promptHandlers.match(/runStickerPromptGeneration\(\{/g) || []).length, 2);
assert.match(promptHandlers, /if \(stickerAiTextPending\) return;/);
assert.match(promptHandlers, /signal: abortController\.signal/);
assert.match(promptHandlers, /err\?\.name === 'AbortError'/);
const imageHandler = appSource.slice(
  appSource.indexOf('const handleGenerateImage = async'),
  appSource.indexOf('const show = (options = {})'),
);
assert.doesNotMatch(imageHandler, /runAdHocWebSearchChat|webSearchToggleRuntime\.consume/);
assert.match(appSource, /webSearchToggleRuntime\.reset\(\);[\s\S]*?renderAdHocWebSources\(webSourcesEl, \[\]\);/);

assert.match(mainCss, /\.ad-hoc-web-sources\s*\{/);
assert.match(mainCss, /\.world-ai-web-toggle\s*\{/);
assert.match(legacyCss, /\.sticker-ai-web-toggle\s*\{/);

console.log('ok - one-shot web search is wired only to world/sticker text generation');
