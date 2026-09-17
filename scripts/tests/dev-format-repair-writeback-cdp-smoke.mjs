// Exercises the real app.js write boundary and persistent ChatStore on a
// disposable, inactive conversation. No model call or user-message mutation.
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(String.raw`(async () => {
  const { createFormatRepairSelection } = await import('/scripts/agent/format-repair-selection.js');
  const bridge = window.appBridge, store = bridge.getChatStore(), ui = bridge.getChatUI();
  const sid = 'rp:format-writeback-smoke-' + crypto.randomUUID(), mid = 'scoped-edit';
  const current = store.getCurrent(), beforeSessions = Object.keys(store.state.sessions).length;
  const source = '<thinking>保留的隐藏内容</thinking>\r\n<p>A &amp; B</p\r\n<footer>保留</footer>';
  const selected = '<p>A &amp; B</p', replacement = selected + '>', start = source.indexOf(selected);
  const plan = createFormatRepairSelection(source, { range: { start, end: start + selected.length } });
  const linePatches = [{ startLine: 1, endLine: 1, originalLines: [selected], replacementLines: [replacement] }];
  const otherBranch = { rawOriginal: '另一分支保持原样', rawSource: '另一分支保持原样', content: '另一分支保持原样' };
  const toasts = new Set(document.querySelectorAll('#toast-container>div'));
  try {
    const message = store.appendMessage({ id: mid, role: 'assistant', type: 'text', status: 'sent', content: source,
      rawOriginal: source, rawSource: source, raw: source, meta: { activeSwipe: 1,
        swipes: [otherBranch, { rawOriginal: source, rawSource: source, raw: source, content: source }] } }, sid);
    const payload = { sessionId: sid, source: 'chat_format_guardian', sourceKind: 'creative_raw_original', sourceSnapshot: source,
      formatSelection: { ...plan, linePatches }, canCommit: () => true, text: source.replace(selected, replacement) };
    const outside = await ui.actionHandler('edit-assistant-raw', message, { ...payload, text: payload.text.replace('保留的隐藏内容', '不允许修改') });
    const untouched = await store.loadRawOriginal(store.findMessage(mid, sid), sid);
    const applied = await ui.actionHandler('edit-assistant-raw', message, payload);
    await store.flush();
    const saved = store.findMessage(mid, sid), raw = await store.loadRawOriginal(saved, sid);
    const stale = await ui.actionHandler('edit-assistant-raw', saved, payload);
    return { outside, untouched: untouched === source, applied, raw: raw === payload.text,
      currentBranch: saved.meta.swipes[1].rawOriginal === payload.text,
      otherBranch: JSON.stringify(saved.meta.swipes[0]) === JSON.stringify(otherBranch),
      stale, currentUnchanged: store.getCurrent() === current, temporaryOnly: Object.keys(store.state.sessions).length === beforeSessions + 1 };
  } finally {
    store.delete(sid); await store.flush();
    document.querySelectorAll('#toast-container>div').forEach(node => { if (!toasts.has(node)) node.remove(); });
  }
})()`);
assert.deepEqual(result, { outside: false, untouched: true, applied: true, raw: true, currentBranch: true, otherBranch: true, stale: false, currentUnchanged: true, temporaryOnly: true });
console.log('real format writeback: outside-range rejection, CRLF source, active swipe persistence, stale result rejection and temporary-session cleanup passed');
