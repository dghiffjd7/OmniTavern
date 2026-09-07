import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
};

const {
  createScenePresetAccess,
  createScenePromptPreviewRequestBuilder,
  evaluateScenePreviewMacro,
} = await import('../../src/scripts/ui/scene-prompt-preview-utils.js');

{
  const calls = [];
  const request = { messages: [{ role: 'user', content: 'draft' }] };
  const build = createScenePromptPreviewRequestBuilder({ handleSend: async (...args) => { calls.push(args); return request; } });
  assert.equal(await build(), request);
  assert.deepEqual(calls[0], [null, {
    previewOnly: true, ignorePending: true, previewUiMode: '', previewScenario: '',
    previewChatFormat: true, previewInjectMemory: true, previewInjectImage: true,
    previewInjectMomentCreate: true, previewSuppressHistory: true,
    previewRawBlocks: false, previewForceLegacyText: false, skipScripts: true,
  }], '抽出组装器后预设默认参数保持等价');
  await build({ includeHistory: true, previewUiMode: 'rp', rawBlocks: false });
  assert.equal(calls[1][1].previewSuppressHistory, false, '正文预览包含会话历史');
  assert.equal(calls[1][1].previewUiMode, 'rp');
  assert.equal(calls[1][1].previewOnly, true);
  assert.equal(calls[1][1].skipScripts, true);
  assert.equal(await createScenePromptPreviewRequestBuilder({ handleSend: async () => false })(), null);
  assert.equal(await createScenePromptPreviewRequestBuilder({ handleSend: async () => { throw new Error('unavailable'); } })(), null);
  console.log('ok - shared preview builder preserves preset defaults, includes body history and contains failures');
}

{
  const calls = [];
  const access = createScenePresetAccess({
    appBridge: { id: 'bridge' },
    sessionId: 'session-a',
    uiMode: 'rp',
    resolvePreset: (bridge, type, context) => {
      calls.push({ bridge, type, context });
      return { type, uiMode: context.uiMode };
    },
  });
  assert.deepEqual(access.context, { sessionId: 'session-a', uiMode: 'rp' });
  assert.deepEqual(access.getOpenAIPreset(), { type: 'openai', uiMode: 'rp' });
  assert.deepEqual(access.getReasoningPreset(), { type: 'reasoning', uiMode: 'rp' });
  assert.ok(calls.every(call => call.context === access.context), '同一请求的预设解析必须共享场景 context');
  console.log('ok - 场景预览以指定 uiMode 解析全部绑定预设');
}

{
  let called = false;
  const result = evaluateScenePreviewMacro('{{setvar：：hover_probe：：mutated}}', {
    processTextMacros: () => { called = true; return ''; },
  });
  assert.equal(result.kind, 'effect');
  assert.match(result.text, /hover_probe/);
  assert.equal(called, false, '全角分隔符的写宏必须在调用宏引擎前拦截');
  console.log('ok - 悬停写宏识别全角分隔符且不执行');
}

{
  let receivedContext = null;
  const result = evaluateScenePreviewMacro('{{getvar::safe}}', {
    context: { sessionId: 's1', uiMode: 'chat' },
    processTextMacros: (_token, context) => {
      receivedContext = context;
      return 'value';
    },
  });
  assert.equal(result.kind, 'value');
  assert.equal(result.text, 'value');
  assert.ok(receivedContext.macroVariableState instanceof Map, '悬停求值必须使用隔离变量状态');
  console.log('ok - 悬停只读宏在隔离状态中求值');
}

{
  let called = false;
  const result = evaluateScenePreviewMacro('<% setVariable("x", 1) %>', {
    processTextMacros: () => { called = true; return ''; },
  });
  assert.equal(result.kind, 'script');
  assert.equal(called, false);
  console.log('ok - EJS 悬停不执行');
}

{
  const repoRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const appSource = await readFile(path.join(repoRoot, 'src/scripts/ui/app.js'), 'utf8');
  const bridgeSource = await readFile(path.join(repoRoot, 'src/scripts/ui/bridge.js'), 'utf8');
  const panelSource = await readFile(path.join(repoRoot, 'src/scripts/ui/preset-panel.js'), 'utf8');
  const handleSendStart = appSource.indexOf('const handleSend = async');
  const handleSendEnd = appSource.indexOf('const sendMessageFromPlugin', handleSendStart);
  assert.ok(handleSendStart >= 0 && handleSendEnd > handleSendStart, '应能定位 handleSend 实现');
  const handleSendSource = appSource.slice(handleSendStart, handleSendEnd);
  assert.doesNotMatch(
    handleSendSource,
    /\bpresetContext\b/,
    'handleSend 不得引用预设上下文重构前的旧变量 presetContext',
  );
  assert.match(
    handleSendSource,
    /getResolvedActiveId\?\.\('openai', requestPresetContext\)\?\.presetId/,
    '创意写作执行记录应使用本次场景实际解析的 OpenAI 预设 ID',
  );
  assert.match(
    await readFile(path.join(repoRoot, 'src/scripts/ui/scene-prompt-preview-utils.js'), 'utf8'),
    /createScenePromptPreviewRequestBuilder[\s\S]*?skipScripts:\s*true/,
    '场景预览必须显式跳过会产生真实副作用的脚本钩子',
  );
  assert.match(
    appSource,
    /if\s*\(!previewOnly\)\s*\{[\s\S]*?setContextBuilder\?\.\(llmContext\)/,
    'previewOnly 不得覆盖正式发送链保存的 contextBuilder',
  );
  assert.match(
    appSource,
    /evalScenePreviewMacro\s*=\s*\(token\s*=\s*'',\s*\{\s*previewUiMode\s*=\s*''\s*\}\s*=\s*\{\}\)[\s\S]*?uiMode:\s*previewUiMode\s*\|\|\s*uiMode/,
    '悬停宏必须优先使用预览场景 uiMode',
  );
  assert.match(
    panelSource,
    /evalFn\(target\.textContent\s*\|\|\s*'',\s*\{\s*previewUiMode:\s*this\.getPreviewUiMode\(\)\s*\}\)/,
    '预设面板必须把当前预览场景（注入选择条驱动）传给悬停宏求值器',
  );
  assert.match(
    bridgeSource,
    /if\s*\(!previewOnly\s*&&\s*pluginRuntime\)/,
    'previewOnly 不得执行插件 prompt hook',
  );
  assert.match(
    bridgeSource,
    /readOnly:\s*previewOnly/,
    'EJS 预览必须以只读模式执行',
  );
  assert.match(
    bridgeSource,
    /previewRawBlocks\s*!==\s*true/,
    '区块原样预览不得再被后置 EJS 渲染改写',
  );
  assert.match(
    bridgeSource,
    /previewBuildPromise/,
    '预览构建应使用独立于正式 isGenerating 的等待通道',
  );
  assert.match(
    bridgeSource,
    /previousLastPromptSegmentDebug[\s\S]*?this\.lastPromptSegmentDebug\s*=\s*previousLastPromptSegmentDebug/,
    'previewOnly 完成后必须恢复正式请求的 Prompt 分段诊断快照',
  );
  assert.match(
    bridgeSource,
    /previewOnly\s*\?\s*buildPromptCacheDebugSnapshot\([\s\S]*?:\s*this\.emitPromptCacheDebug\(/,
    'previewOnly 不得写入正式请求的 Prompt cache 调试基线',
  );
  assert.match(
    bridgeSource,
    /if\s*\(!previewOnly\s*&&\s*!this\.isConfigured\(\)\)/,
    '本地 Prompt 预览不得依赖 API 已配置状态',
  );
  console.log('ok - handleSend 使用场景预设上下文记录实际预设 ID');
}
