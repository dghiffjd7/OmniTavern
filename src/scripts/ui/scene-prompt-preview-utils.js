import { buildPresetContext, resolveResolvedPreset } from './chat/prompt-context-utils.js';

// 预设与正文卡共用正式发送链的只读请求组装入口。
export const createScenePromptPreviewRequestBuilder = ({ handleSend, logger } = {}) => async ({
  previewUiMode = '', previewScenario = '', previewChatFormat = true,
  previewInjectMemory = true, previewInjectImage = true, previewInjectMomentCreate = true,
  includeHistory = false, rawBlocks = false, forceLegacyText = false,
  agentPromptDraft = null,
} = {}) => {
  try {
    const request = await handleSend(null, {
      previewOnly: true, ignorePending: true, previewUiMode, previewScenario,
      previewChatFormat, previewInjectMemory, previewInjectImage, previewInjectMomentCreate,
      previewSuppressHistory: !includeHistory, previewRawBlocks: Boolean(rawBlocks),
      previewForceLegacyText: Boolean(forceLegacyText), skipScripts: true,
      ...(agentPromptDraft ? { agentPromptDraft } : {}),
    });
    return request && Array.isArray(request.messages) ? request : null;
  } catch (err) {
    logger?.warn?.('build scene preview request failed', err);
    if (agentPromptDraft) throw err;
    return null;
  }
};

const normalizeScenePreviewMacroToken = token =>
  String(token ?? '').trim().replace(/：：/g, '::');

export const describeScenePreviewWriteMacro = (token = '') => {
  const normalized = normalizeScenePreviewMacroToken(token);
  const match = normalized.match(
    /^\{\{\s*(setvar|setglobalvar|addvar|addglobalvar|incvar|decvar|incglobalvar|decglobalvar)\s*::\s*([^:}]+?)(?:\s*::\s*([\s\S]*?))?\s*\}\}$/i,
  );
  if (!match) return null;
  const command = match[1].toLowerCase();
  const key = match[2].trim();
  const value = match[3] ?? '';
  const action = command.startsWith('set')
    ? `设为「${value}」`
    : command.startsWith('add')
      ? `增加「${value}」`
      : command.startsWith('inc')
        ? '自增 1'
        : '自减 1';
  return { kind: 'effect', text: `写变量：「${key}」${action}（输出为空；预览悬停不执行）` };
};

export const evaluateScenePreviewMacro = (token = '', {
  processTextMacros = null,
  context = {},
} = {}) => {
  const raw = String(token ?? '').trim();
  if (!raw) return { kind: 'empty', text: '' };

  const writeEffect = describeScenePreviewWriteMacro(raw);
  if (writeEffect) return writeEffect;
  if (/^<%/.test(raw)) {
    return {
      kind: 'script',
      text: 'EJS 模板脚本：可能有副作用，悬停不执行。关闭「区块原样」并 ↻ 重建可看整体求值效果。',
    };
  }
  if (typeof processTextMacros !== 'function') return { kind: 'raw', text: '（无法求值，保持原样）' };

  try {
    const output = processTextMacros(raw, {
      ...(context || {}),
      macroVariableState: new Map(),
    });
    const text = String(output ?? '');
    if (text === raw) return { kind: 'raw', text: '（无法求值，保持原样）' };
    return { kind: 'value', text: text === '' ? '（求值为空）' : text };
  } catch {
    return { kind: 'error', text: '（求值失败）' };
  }
};

export const createScenePresetAccess = ({
  appBridge = null,
  sessionId = '',
  uiMode = 'chat',
  resolvePreset = resolveResolvedPreset,
} = {}) => {
  const context = buildPresetContext({ sessionId, uiMode });
  const getPreset = type => resolvePreset(appBridge, type, context);
  return {
    context,
    getPreset,
    getOpenAIPreset: () => getPreset('openai'),
    getReasoningPreset: () => getPreset('reasoning'),
  };
};
