// Windows WebView：隔离内存板验证新增选单过滤、修改 Agent 创建和异步上下文保护。
import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const result = await evaluateInApp(`(async () => {
  const { createHopscotchBoardPanel } = await import('/scripts/ui/chat/hopscotch-board-panel.js');
  const { createHopscotchBoardStore } = await import('/scripts/storage/hopscotch-board-store.js');
  const { createHopscotchTurnRuntime } = await import('/scripts/ui/chat/hopscotch-turn-runtime.js');
  const focus = document.activeElement;
  const panels = [];
  const make = async ({ fused = ['memory_table', 'image_prompt', 'variable'], extra = [], agents = [], create } = {}) => {
    const data = new Map(), storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
    const store = createHopscotchBoardStore({ storage });
    const saved = await store.setGlobalBoard({ version: 2, rows: [
      { id: 'body-row', houses: [{ id: 'body', kind: 'body', fused }] },
      { id: 'post-row', houses: [{ id: 'review', kind: 'format_review' }, ...extra] },
    ] });
    if (!saved.ok) throw new Error('Invalid test board ' + JSON.stringify(saved.errors));
    let sid = 'picker-session', pending, calls = 0, opened;
    const runtime = createHopscotchTurnRuntime({ boardStore: store, getSettings: () => ({ creativeHopscotchEnabled: true }) });
    const panel = createHopscotchBoardPanel({ boardStore: store, runtime, getSessionId: () => sid,
      listTextAgents: () => agents, createTextAgent: async options => {
        calls++;
        if (create === 'pending') return await new Promise(resolve => { pending = resolve; });
        return { ok: true, id: 'text-edit:created', config: { title: '正文优化' }, scope: options.scope };
      }, openTextAgent: (id, options) => { opened = { id, ...options }; },
    });
    panels.push(panel); panel.show();
    const root = [...document.querySelectorAll('dialog.hop-dialog[open]')].at(-1);
    const detail = () => document.querySelector('dialog.hop-detail[open]');
    const click = (selector, parent = root) => {
      const el = parent.querySelector(selector);
      if (!el || el.disabled) throw new Error('Missing or disabled ' + selector);
      el.click();
    };
    const choices = () => [...detail().querySelectorAll('.hop-picker button')].map(el => ({ name: el.textContent.trim(), disabled: el.disabled }));
    const add = name => {
      const el = [...detail().querySelectorAll('.hop-picker button')].find(el => el.textContent.trim() === name);
      if (!el || el.disabled) throw new Error('Missing choice ' + name); el.click(); return el;
    };
    return { panel, root, detail, click, choices, add, changeSession: () => { sid = 'other-session'; },
      resolve: () => pending?.({ ok: true, id: 'text-edit:late', config: { title: '延迟 Agent' } }),
      created: () => ({ calls, opened, dirty: !!root.querySelector('.hop-source.is-dirty'), houses: root.querySelectorAll('[data-hop-kind="text_edit"]').length }),
    };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  try {
    const fixture = await make({ agents: [{ id: 'text-edit:existing', title: '已有润色' }] });
    fixture.click('[data-hop-add="0"][data-hop-new="0"]');
    const alongsideBody = fixture.choices();
    fixture.click('[data-action="close-detail"]', fixture.detail());
    fixture.click('[data-hop-add="1"][data-hop-new="1"]');
    const afterBody = fixture.choices();
    const help = [...fixture.detail().querySelectorAll('[data-help]')].map(el => ({ title: el.textContent, mode: el.dataset.helpMode, help: el.dataset.help }));
    fixture.add('修改文本'); await settle();
    const created = fixture.created();
    fixture.panel.dispose();

    const detached = await make({ fused: ['image_prompt', 'variable'] });
    detached.click('[data-hop-add="1"][data-hop-new="1"]');
    const detachedChoices = detached.choices(); detached.panel.dispose();

    const duplicate = await make({ agents: [{ id: 'text-edit:placed', title: '已放入' }, { id: 'text-edit:free', title: '可添加' }],
      extra: [{ id: 'placed-edit', kind: 'text_edit', config: { agentId: 'text-edit:placed' } }] });
    duplicate.click('[data-hop-add="1"][data-hop-new="1"]');
    const duplicateChoices = duplicate.choices(); duplicate.panel.dispose();

    const capped = await make({ agents: Array.from({ length: 8 }, (_, i) => ({ id: 'text-edit:limit-' + i, title: '助手' + i })) });
    capped.click('[data-hop-add="1"][data-hop-new="1"]');
    const cappedChoices = capped.choices(); capped.panel.dispose();

    const staleSession = await make({ create: 'pending' });
    staleSession.click('[data-hop-add="1"][data-hop-new="1"]');
    const creationButton = staleSession.add('修改文本'); creationButton.click();
    const pendingDisabled = staleSession.choices().every(item => item.disabled);
    staleSession.changeSession(); staleSession.resolve(); await settle();
    const sessionChanged = staleSession.created(); staleSession.panel.dispose();

    const closed = await make({ create: 'pending' });
    closed.click('[data-hop-add="1"][data-hop-new="1"]'); closed.add('修改文本');
    closed.click('[data-action="close-detail"]', closed.detail());
    closed.click('[data-hop-add="0"][data-hop-new="0"]');
    closed.resolve(); await settle();
    const closedResult = { ...closed.created(), choices: closed.choices() }; closed.panel.dispose();
    return { alongsideBody, afterBody, help, created, detachedChoices, duplicateChoices, cappedChoices, pendingDisabled, sessionChanged, closedResult };
  } finally { panels.forEach(panel => panel.dispose()); if (focus?.isConnected) focus.focus({ preventScroll: true }); }
})()`);

assert.deepEqual(result.alongsideBody, [{ name: '自定义提示词', disabled: false }]);
assert.equal(result.afterBody.some(item => item.disabled), false);
assert.deepEqual(result.afterBody.slice(0, 3).map(item => item.name), ['修改文本', '自定义提示词', '已有润色']);
for (const label of ['记忆表格', '变量更新', '图片提示', '格式修复', '发送前变量规则']) assert.equal(result.afterBody.some(item => item.name === label), false, label);
assert.equal(result.help.find(item => item.title === '新建 Agent')?.mode, 'tap');
assert.equal(result.help.find(item => item.title === '新建 Agent')?.help.includes('确认后替换'), true);
assert.deepEqual(result.created, { calls: 1, opened: { id: 'text-edit:created', scope: 'global' }, dirty: true, houses: 1 });
assert.equal(result.detachedChoices.some(item => item.name === '记忆表格'), true);
assert.equal(result.duplicateChoices.some(item => item.name === '已放入'), false);
assert.equal(result.duplicateChoices.some(item => item.name === '可添加'), true);
assert.equal(result.cappedChoices.some(item => item.name === '修改文本'), false);
assert.equal(result.cappedChoices.filter(item => item.name.startsWith('助手')).length, 8);
assert.equal(result.pendingDisabled, true);
assert.deepEqual(result.sessionChanged, { calls: 1, dirty: false, houses: 0 });
assert.deepEqual(result.closedResult, { calls: 1, dirty: false, houses: 0, choices: [{ name: '自定义提示词', disabled: false }] });
console.log('ok - legal picker choices, existing and new edit agents, scope forwarding, capacity, duplicate click and stale creation guards in isolated Windows UI');
