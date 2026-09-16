// Agent Center and the board use the same scene routing. A local card or a
// missing trigger must never silently fall back to the ordinary chat request.
export const createAgentCenterPromptPreview = ({ getContext, resolveRoute, buildScene, buildMoment } = {}) => async (options = {}) => {
  const context = getContext();
  const agentId = String(options.agentId || options.draft?.agentId || 'body');
  const draft = { ...(options.draft || {}), agentId };
  const empty = previewNote => ({ messages: [], previewOnly: true, previewNote, session: { id: context.sessionId } });
  if (['lineage_agent', 'execution_lane_agent', 'write_preview', 'variable_rules'].includes(agentId)) {
    return empty('此卡片在本地处理状态或执行权限，没有独立的模型提示词。');
  }
  if (!context.sessionId) return empty('请先进入聊天室，再预览该 Agent 的实际上下文。');
  const route = resolveRoute({ ...options, agentId, draft, context });
  let request;
  if (agentId === 'moment_agent' && draft.task && draft.task !== 'moment') request = await buildMoment(draft, context);
  else if (route.previewNote && !route.requestKind) return empty(route.previewNote);
  else request = await buildScene({ previewUiMode: context.uiMode, includeHistory: true,
    agentPromptDraft: { ...draft, requestKind: route.requestKind || 'body', ...(route.house ? { house: route.house } : {}) } });
  if (getContext().key !== context.key) throw new Error('会话已变化，请重新展开预览。');
  if (!request) return empty('暂时无法组装请求，请检查当前任务所需的上下文。');
  return { ...request, previewOnly: true, session: request.session || { id:context.sessionId },
    previewLabel:request.previewLabel || route.label, previewNote:request.previewNote || route.previewNote || (route.requestKind === 'body' ? '根据当前会话与此页草稿预览；发送脚本和前置 Agent 的新产物在执行时加入。' : '') };
};
