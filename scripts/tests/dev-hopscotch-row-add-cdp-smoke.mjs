// Windows WebView：隔离内存板验证各行新增入口、格式修复锚点、取消/撤销/保存。
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const storage = new Map();
  const store = createHopscotchBoardStore({ storage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) } });
  const runtime = createHopscotchTurnRuntime({ boardStore: store, getSettings: () => ({ creativeHopscotchEnabled: true }),
    resolveWritingSettings: () => ({ place: 'writing', replyCheck: { enabled: false } }) });
  const focus = document.activeElement;
  const panel = createHopscotchBoardPanel({ boardStore: store, runtime, getSessionId: () => '', getFormatReview: () => ({ enabled: false, reason: 'disabled' }) });
  try {
    panel.show();
    const root = [...document.querySelectorAll('dialog.hop-dialog[open]')].at(-1);
    const detail = () => document.querySelector('dialog.hop-detail[open]');
    const click = (selector, parent = root) => { const el = parent.querySelector(selector); if (!el || el.disabled) throw new Error('Missing or disabled ' + selector); el.click(); };
    const layout = () => [...root.querySelectorAll('.hop-row')].map(row => [...row.querySelectorAll('[data-hop-kind]')].map(h => h.dataset.hopKind));
    const controls = () => ({ sides: root.querySelectorAll('.hop-side').length, gaps: root.querySelectorAll('.hop-gap').length });
    const addCustom = () => {
      const el = [...detail().querySelectorAll('.hop-picker button')].find(el => el.textContent === '自定义提示词');
      if (!el || el.disabled) throw new Error('Custom prompt choice unavailable'); el.click();
    };
    const initial = { layout: layout(), controls: controls() };
    click('[data-hop-anchor="format_review"][data-hop-new="0"]');
    const title = detail().querySelector('h2').textContent;
    click('[data-action="close-detail"]', detail());
    const cancelled = !root.querySelector('.hop-source.is-dirty') && !store.getGlobalBoard();
    click('[data-hop-anchor="format_review"][data-hop-new="0"]'); addCustom();
    const parallel = { layout: layout(), controls: controls(), disabled: root.querySelector('[data-hop-kind="format_review"]').dataset.hopEnabled === 'false' };
    click('[data-action="undo"]');
    const undone = { layout: layout(), clean: !root.querySelector('.hop-source.is-dirty') };
    click('[data-hop-anchor="format_review"][data-hop-new="1"]'); addCustom();
    const after = layout();
    click('[data-action="undo"]');
    click('[data-hop-add="1"][data-hop-new="1"]'); addCustom();
    const above = layout();
    click('[data-hop-add="1"][data-hop-new="0"]'); addCustom();
    const ordinaryParallel = layout();
    click('[data-action="undo"]'); click('[data-action="undo"]');
    click('[data-hop-add="0"][data-hop-new="1"]'); addCustom();
    const top = layout();
    click('[data-hop-anchor="format_review"][data-hop-new="0"]'); addCustom();
    click('[data-action="save"]');
    for (let i = 0; i < 30 && (!store.getGlobalBoard() || root.querySelector('.hop-source.is-dirty')); i++) await new Promise(r => setTimeout(r, 10));
    const saved = store.getGlobalBoard();
    if (!saved) throw new Error(root.querySelector('.hop-error').textContent || 'Save failed');
    return { initial, title, cancelled, parallel, undone, after, above, ordinaryParallel, top,
      saved: saved.rows.map(row => row.houses.map(h => h.kind)), finalControls: controls(),
      duplicates: root.querySelectorAll('[data-hop-kind="format_review"]').length };
  } finally { panel.dispose(); if (focus?.isConnected) focus.focus({ preventScroll: true }); }
})()`);
assert.deepEqual(result.initial, { layout: [['body'], ['format_review']], controls: { sides: 2, gaps: 3 } });
assert.equal(result.title, '新增并行房子');
assert.equal(result.cancelled, true);
assert.deepEqual(result.parallel, { layout: [['body'], ['format_review', 'custom_prompt']], controls: { sides: 2, gaps: 3 }, disabled: true });
assert.deepEqual(result.undone, { layout: result.initial.layout, clean: true });
assert.deepEqual(result.after, [['body'], ['format_review'], ['custom_prompt']]);
assert.deepEqual(result.above, [['body'], ['custom_prompt'], ['format_review']]);
assert.deepEqual(result.ordinaryParallel, [['body'], ['custom_prompt', 'custom_prompt'], ['format_review']]);
assert.deepEqual(result.top, [['custom_prompt'], ['body'], ['format_review']]);
assert.deepEqual(result.saved, [['custom_prompt'], ['body'], ['format_review', 'custom_prompt']]);
assert.deepEqual(result.finalControls, { sides: 3, gaps: 4 });
assert.equal(result.duplicates, 1);
console.log('ok - row/parallel add, review placeholder, cancel, atomic undo and saved order in isolated Windows editor');
