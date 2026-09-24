import assert from 'node:assert/strict';
import { pickAgentSuggestion, describeAgentSuggestion, createAgentSuggestionBanner } from '../../src/scripts/ui/chat/agent-suggestion-banner.js';

const job = (id, patch = {}) => ({ id, agentId: 'body-polish', title: '正文润色', sessionId: 's1', invocation: 'auto', outputMode: 'edit',
  status: 'ready', message: '', changeCount: 0, createdAt: Number(id.replace(/\D/g, '')) || 0, ...patch });

// 只选当前会话、自动触发、待查看的最新一条
{
  const jobs = [job('r1'), job('r2'), job('r3', { invocation: 'manual' }), job('r4', { sessionId: 's2' }), job('r5', { status: 'applied' })];
  const picked = pickAgentSuggestion(jobs, { sessionId: 's1' });
  assert.equal(picked.job.id, 'r2');
  assert.equal(picked.others, 1);
  assert.equal(pickAgentSuggestion(jobs, { sessionId: 's1', dismissed: new Set(['r2']) }).job.id, 'r1');
  assert.equal(pickAgentSuggestion(jobs, { sessionId: '' }), null, 'no banner outside a chat room');
  assert.equal(pickAgentSuggestion([job('r9', { status: 'running' })], { sessionId: 's1' }), null);
}

// 文案：模型摘要优先，没有摘要时按修改处数说明；笔记类结果换成查看结果
{
  const withSummary = describeAgentSuggestion({ job: job('r1', { message: '调整了两处重复用词', changeCount: 2 }), others: 0 });
  assert.equal(withSummary.title, '正文润色');
  assert.equal(withSummary.text, '调整了两处重复用词');
  assert.equal(withSummary.primary, '查看修改');
  assert.equal(withSummary.secondary, '忽略');
  const counted = describeAgentSuggestion({ job: job('r1', { changeCount: 3 }), others: 2 });
  assert.match(counted.text, /3 处修改建议/);
  assert.match(counted.text, /另有 2 条建议待查看/);
  const note = describeAgentSuggestion({ job: job('r1', { outputMode: 'note' }) });
  assert.equal(note.primary, '查看结果');
  assert.equal(note.chip, 'Agent 结果');
}

// 横幅：挂到输入区、随会话同步、查看/忽略/关闭各走各的路径
{
  const listeners = new Map();
  const win = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const makeEl = () => ({ textContent: '', title: '', dataset: {}, hidden: false });
  const parts = {
    '[data-agent-suggestion-title]': makeEl(),
    '[data-agent-suggestion-chip]': makeEl(),
    '[data-agent-suggestion-text]': makeEl(),
    '[data-agent-suggestion-action="open"]': makeEl(),
    '[data-agent-suggestion-action="dismiss-job"]': makeEl(),
  };
  let clickHandler = null;
  const root = { hidden: false, dataset: {}, className: '', setAttribute() {}, querySelector: selector => parts[selector],
    addEventListener: (type, fn) => { clickHandler = fn; }, removeEventListener() {}, remove() { root.removed = true; } };
  const inserted = [];
  const container = { insertBefore: (node, ref) => inserted.push([node, ref]) };
  const documentRef = { defaultView: win, createElement: () => root };
  let jobs = [job('r1', { message: '润色了开头' })];
  const opened = [], ignored = [], runs = [];
  const runtime = { list: () => jobs, open: async id => opened.push(id), ignore: id => { ignored.push(id); jobs = jobs.map(j => (j.id === id ? { ...j, status: 'ignored' } : j)); } };
  const banner = createAgentSuggestionBanner({ container, runtime, documentRef, openRun: (agentId, runId) => runs.push([agentId, runId]) });
  assert.equal(inserted.length, 1);
  assert.equal(root.hidden, true, 'hidden until a chat room is synced');
  assert.equal(banner.sync('s1'), true);
  assert.equal(root.hidden, false);
  assert.equal(parts['[data-agent-suggestion-text]'].textContent, '润色了开头');
  const click = action => clickHandler({ target: { closest: () => ({ dataset: { agentSuggestionAction: action } }) }, preventDefault() {} });
  click('open');
  assert.deepEqual(opened, ['r1'], 'edit suggestions open the patch review directly');
  click('dismiss-job');
  assert.deepEqual(ignored, ['r1']);
  assert.equal(root.hidden, true);

  jobs = [job('r2', { outputMode: 'note' })];
  listeners.get('agent-text-edit-changed')();
  assert.equal(root.hidden, false);
  click('open');
  assert.deepEqual(runs, [['body-polish', 'r2']], 'note results open in the toolbox');
  assert.equal(root.hidden, true);

  jobs = [job('r3')];
  banner.render();
  click('close');
  assert.deepEqual(ignored, ['r1'], 'closing only hides the banner, the suggestion stays in the toolbox');
  assert.equal(root.hidden, true);

  jobs = [job('r4')];
  banner.sync('');
  assert.equal(root.hidden, true, 'leaving the chat room hides the banner');
  banner.dispose();
  assert.equal(listeners.has('agent-text-edit-changed'), false);
  assert.equal(root.removed, true);
}

console.log('agent suggestion banner tests passed');
