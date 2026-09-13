import { createAgentReferenceContextBuilder, selectAgentReferenceMessages } from '../../agent/agent-reference-context.js';
import { extractRenderedAgentBodyText } from './agent-rendered-body.js';
import { createAgentReferenceSourceCatalog } from './agent-reference-sources.js';

// Scope-bound read-only bridge. A request renders its conversation at most once,
// then projects only the selected history window; source catalogs load on demand.
export const createAgentReferenceAppRuntime = ({ getContext, getMessages, getDisplayMessages, getReasoningBoundaries,
  getWorldStore, getPresetStore, getResolvedWorldState, documentRef = document } = {}) => {
  const isCurrent = context => {
    const active = getContext();
    if (!active || !context) return false;
    return ['sessionId','place','scopeId'].every(key => active[key] === context[key])
      && (context.archiveId === undefined || active.archiveId === context.archiveId);
  };
  const catalog = createAgentReferenceSourceCatalog({ getWorldStore, getPresetStore, getResolvedWorldState, isCurrent });
  const listSources = (context, options = {}) => catalog(context, options);
  const resolveReference = async (options = {}) => {
    const { context, signal } = options;
    const checkCurrent = () => {
      if (signal?.aborted) throw Object.assign(new Error('任务已取消'), { name: 'AbortError' });
      if (!isCurrent(context)) throw Object.assign(new Error('当前角色或存档已变化，请重新打开'), { name: 'AbortError' });
    };
    checkCurrent();
    const messages = options.messages || getMessages(context.sessionId) || [];
    const selected = new Set(selectAgentReferenceMessages(messages, options.config?.context || options.config, options).messages);
    // Preserve every position counted by the UI's depth-sensitive regex, but never
    // ask its image branch to render/expire media while merely reading references.
    let displayed, boundaries;
    const resolveBoundaries = () => boundaries || (boundaries = getReasoningBoundaries?.(context) || {});
    const builder = createAgentReferenceContextBuilder({
      getMessages: () => messages,
      listSources,
      getReasoningBoundaries: resolveBoundaries,
      getMessageText: async message => {
        checkCurrent();
        const reasoningBoundaries = await resolveBoundaries();
        checkCurrent();
        if (!displayed) {
          const displayFrame = messages.map(item => selected.has(item) ? item
            : { id: item?.id, role: item?.role, type: 'reference_placeholder', content: '' });
          displayed = new Map((getDisplayMessages(displayFrame,context) || []).filter(Boolean).map(item => [item.id,item]));
        }
        const current = displayed.get(message.id);
        if (!current) return { ok: false, message: '这条消息暂无可用的显示内容' };
        return extractRenderedAgentBodyText(current.content, { documentRef, boundaries: reasoningBoundaries });
      },
    });
    const result = await builder({ ...options, messages, signal });
    checkCurrent();
    return result;
  };
  return { listSources, resolveReference };
};
