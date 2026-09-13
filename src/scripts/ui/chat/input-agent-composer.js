import { createInputAgentRuntime, buildInputAgentRequest } from '../../agent/input-agent-runtime.js';

// DOM／IME／草稿生命周期只在此处接线；运行时通过快照和一次原子写回访问输入框。
export const bindInputAgentComposer = ({ input, getContext, getMessages, getConfig, listConfigs,
  captureModel, request, review, onChange, budget, resolveReference } = {}) => {
  const doc = input.ownerDocument, win = doc.defaultView, bindings = [];
  let revision = 0, composing = false;
  const snapshot = () => {
    const context = getContext();
    return { context, contextKey: JSON.stringify(context), revision, text: input.value,
      start: input.selectionStart, end: input.selectionEnd, composing,
      available: Boolean(context.sessionId && input.getClientRects().length && !input.disabled && !input.readOnly),
      active: doc.activeElement === input && !doc.hidden && !composing,
      messages: (getMessages(context.sessionId) || []).slice(-200).map(m => {
        if (!m || typeof m !== 'object') return null;
        const text = (!m.type || m.type === 'text') && !m.meta?.generatedMedia;
        return { id: m.id, role: m.role, type: m.type, status: m.status, pending: Boolean(m.pending), error: Boolean(m.error),
          ...(text ? { raw: m.raw, rawSource: m.rawSource, raw_source: m.raw_source, content: m.content, name: m.name, time: m.time } : { content: '' }),
          hidden: Boolean(m.hidden), deleted: Boolean(m.deleted),
          meta: { renderRich: m.meta?.renderRich, hidden: Boolean(m.meta?.hidden), generatedMedia: Boolean(m.meta?.generatedMedia) } };
      }),
    };
  };
  const runtime = createInputAgentRuntime({ getSnapshot: snapshot, getConfig, listConfigs, captureModel, request, review, onChange, budget, resolveReference,
    commit: ({ snapshot: saved, target, text, canCommit }) => {
      if (!canCommit() || saved.text !== input.value || saved.revision !== revision) return false;
      input.focus({ preventScroll: true }); input.setSelectionRange(target.start, target.end);
      const original = input.value, next = original.slice(0, target.start) + text + original.slice(target.end);
      const ok = doc.execCommand?.('insertText', false, text);
      if (!ok || input.value !== next) { input.value = original; input.setRangeText(text, target.start, target.end, 'end'); input.dispatchEvent(new win.Event('input', { bubbles: true })); }
      return input.value === next;
    },
  });
  const listen = (el, event, fn) => { el.addEventListener(event, fn); bindings.push(() => el.removeEventListener(event, fn)); };
  listen(input, 'input', () => { revision++; if (!composing) runtime.schedule(); });
  listen(input, 'input-suggestion-reset', () => { revision++; runtime.invalidate(); });
  listen(input, 'compositionstart', () => { composing = true; runtime.invalidate(); });
  listen(input, 'compositionend', () => { composing = false; revision++; runtime.schedule(); });
  listen(input, 'blur', runtime.pauseAutomatic);
  listen(win, 'blur', runtime.pauseAutomatic);
  listen(doc, 'visibilitychange', () => { if (doc.hidden) runtime.pauseAutomatic(); });
  listen(win, 'session-changed', () => { revision++; runtime.invalidate('会话已变化，请重新运行'); });
  listen(win, 'agent-feature-settings-changed', runtime.reconcile);
  const observer = new win.MutationObserver(() => { revision++; runtime.invalidate('当前模式已变化，请重新运行'); });
  observer.observe(doc.body, { attributes: true, attributeFilter: ['data-ui-mode'] });
  return { ...runtime, snapshot, preview: async config => { const saved = snapshot(); const reference = resolveReference ? await resolveReference({config: config.context, context: saved.context, messages: saved.messages}) : null; return buildInputAgentRequest(config, saved, reference); },
    dispose: () => { bindings.forEach(fn => fn()); observer.disconnect(); runtime.dispose(); },
  };
};
