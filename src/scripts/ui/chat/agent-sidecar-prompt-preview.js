import { buildMemoryUpdatePlanInput, buildMemoryUpdateRequest } from './memory-update-runtime-utils.js';
import { buildHopscotchImagePromptMessages } from './hopscotch-sidecar-executors.js';
import { LLMClient } from '../../api/client.js';

// Inputs are the same current-room context and prompt draft used by the main
// preview. Independent tasks reuse their production message builders.
export const buildAgentSidecarPromptPreview = async ({ input, context, bridge, getMemoryHistory, getMemoryConfig,
  getBody, getImageSettings, getSidecarConfig, renderMacros } = {}) => {
  const draft = context?.meta?.agentPromptDraft;
  const kind = draft?.requestKind;
  const sessionId = context.session.id;
  if (kind === 'memory_update') {
    const plan = await bridge.buildMemoryPromptPlan(buildMemoryUpdatePlanInput(context, { sessionId, isGroup:context.session.isGroup }));
    const historyText = getMemoryHistory(sessionId);
    const request = buildMemoryUpdateRequest({ promptText:plan?.promptText, historyText });
    const config = await getMemoryConfig();
    const prepared = config?.provider ? new LLMClient(config).prepareChatRequest?.(request.messages, { stream:false }) : null;
    return { ...request, model:config?.model || '', provider:config?.provider || '', previewLabel:'独立写表请求',
      ...(prepared?.body ? { wireRequest:{ body:prepared.body, parameterReport:prepared.parameterReport || [] } } : {}),
      previewNote:!historyText ? '当前没有可用于写表的聊天记录；正式任务会等待聊天内容。' : '根据当前已有的聊天记录预览；正式写表还会包含触发时的新回复。',
      sections:[{ source:'记忆表格与写表指导', editFields:Object.keys(draft.promptFields || {}).map(id => `memory:${id}`), origin:'表格值与定位编号只读' }, { source:'聊天记录', origin:'当前聊天室 · 只读' }],
      agentPromptContext:{ memory:plan },
    };
  }
  if (kind === 'image_prompt') {
    const body = getBody(sessionId);
    if (!body) return { messages:[], previewNote:'当前没有可供生成图片提示词的正文，请先生成一条回复。' };
    const messages = buildHopscotchImagePromptMessages({ imageSettings:getImageSettings(draft), userInput:input,
      body, renderMacros:value => renderMacros(value,context) });
    const request = await bridge.backgroundChat(messages, { previewOnly:true, maxTokens:4096, tools:[],
      presetContext:{sessionId,uiMode:'rp'}, runtimeConfigOverride:await getSidecarConfig(draft.house) });
    return { ...request, previewLabel:'独立图片提示词请求', previewNote:'以当前最新回复作为正文预览。',
      sections:[{source:'生图指导',editField:'agent:auto-image-prompt',origin:'任务模板可编辑，输出协议由程序组装'},{source:'用户输入与正文',origin:'当前聊天室 · 只读'}] };
  }
  return bridge.generate(input, context);
};
