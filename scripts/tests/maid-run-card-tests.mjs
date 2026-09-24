import assert from 'node:assert/strict';

import {
  buildMaidRunCardModel,
  buildMaidVoiceTaskSummary,
  formatMaidRunElapsed,
  resolveMaidRunVisibleRows,
  resolveMaidToolTarget,
  summarizeMaidToolArgs,
} from '../../src/scripts/ui/maid-run-card-model.js';
import { createMaidRunCardView } from '../../src/scripts/ui/maid-run-card-dom.js';
import { createMaidToolConfirmationRuntime } from '../../src/scripts/ui/maid-tool-confirmation-runtime.js';
import { projectMaidRunToTraceView } from '../../src/scripts/ui/chat/execution-flow-runtime-utils.js';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    const set = new Set();
    this.classList = {
      add: (...tokens) => tokens.forEach(token => set.add(token)),
      remove: (...tokens) => tokens.forEach(token => set.delete(token)),
      contains: token => set.has(token),
      toggle: (token, force) => { if (force === undefined ? !set.has(token) : force) set.add(token); else set.delete(token); },
    };
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.hidden = false;
    this.textContent = '';
    this._innerHTML = '';
  }

  set innerHTML(value) { this._innerHTML = String(value || ''); this.children.forEach(child => { child.parentNode = null; }); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  appendChild(child) { child.parentNode?.children && (child.parentNode.children = child.parentNode.children.filter(item => item !== child)); child.parentNode = this; this.children.push(child); return child; }
  remove() { if (!this.parentNode) return; this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, handler) { this.listeners.set(type, [...(this.listeners.get(type) || []), handler]); }
  contains(target) { let node = target; while (node) { if (node === this) return true; node = node.parentNode; } return false; }
}

class FakeDocument {
  constructor() { this.head = new FakeElement('head'); this.body = new FakeElement('body'); }
  createElement(tag) { return new FakeElement(tag); }
  getElementById(id) { return this.head.children.find(child => child.id === id) || null; }
}

const run = (overrides = {}) => ({
  id: 'run_1',
  kind: 'maid_assistant',
  status: 'running',
  createdAt: 1000,
  updatedAt: 5000,
  metadata: { goal: '为三个角色建私聊并绑定世界书' },
  steps: [
    { id: 's1', status: 'succeeded', summary: '共 2 个聊天室', input: { toolName: 'session.list', args: {} }, output: { summary: '共 2 个聊天室' }, startedAt: 1000, finishedAt: 1400 },
    { id: 's2', status: 'succeeded', summary: '已创建 3 个聊天室', input: { toolName: 'session.create', args: { names: ['精灵女王', '露娜', '夜羽'], open: false } }, output: { summary: '已创建 3 个聊天室' }, startedAt: 1500, finishedAt: 3600 },
    { id: 's3', status: 'succeeded', summary: '已读回', input: { toolName: 'session.list', args: {} }, startedAt: 3700, finishedAt: 3900 },
    { id: 's4', status: 'running', summary: '绑定世界书', input: { toolName: 'worldbook.bind_sessions', args: { worldbookName: '魔法学院设定', apiKey: 'sk-secret' } }, startedAt: 4000 },
  ],
  ...overrides,
});

{
  const model = buildMaidRunCardModel(projectMaidRunToTraceView(run()));
  assert.equal(model.state, 'running');
  assert.equal(model.stateLabel, '执行中');
  assert.equal(model.doneCount, 3);
  assert.equal(model.total, 4);
  assert.equal(model.currentSeq, 4, '环心是当前步序号');
  assert.equal(model.rows[1].target, '精灵女王、露娜、夜羽', '目标来自参数');
  assert.equal(model.rows[1].durationMs, 2100);
  assert.equal(model.rows[3].target, '魔法学院设定');
  assert.deepEqual(model.rows[3].args.find(([key]) => key === 'apiKey'), ['apiKey', '••••'], '密钥类参数脱敏');
  assert.equal(model.rows[0].result, '', '结果与标题相同时不重复');

  const waiting = buildMaidRunCardModel(projectMaidRunToTraceView(run({ status: 'waiting_permission' })));
  assert.equal(waiting.state, 'waiting');
  assert.equal(waiting.rows[3].status, 'waiting', '等待授权落在当前步');

  const aborted = buildMaidRunCardModel(projectMaidRunToTraceView(run({ status: 'cancelled', finishedAt: 4500 })));
  assert.equal(aborted.rows[3].status, 'cancelled', '终态后不再显示旋转');
  assert.equal(aborted.finishedAt, 4500);

  const folded = resolveMaidRunVisibleRows(model);
  assert.equal(folded.foldedCount, 3, '超过 2 步的已完成部分收成一行');
  assert.deepEqual(folded.rows.map(row => row.id), ['s4']);
  assert.equal(resolveMaidRunVisibleRows(model, { foldOpen: true }).foldedCount, 0);
  const failed = buildMaidRunCardModel(projectMaidRunToTraceView(run({
    status: 'failed',
    steps: [{ id: 'f1', status: 'failed', summary: '创建聊天室', errorMessage: '角色卡「夜羽」不存在', input: { toolName: 'session.create', args: { name: '夜羽' } } }],
  })));
  assert.equal(failed.rows[0].error, '角色卡「夜羽」不存在');

  assert.equal(formatMaidRunElapsed(12400), '12.4s');
  assert.equal(formatMaidRunElapsed(65_000), '1m 05s');
  assert.equal(resolveMaidToolTarget({ sessionId: 'abc' }), '', 'ID 类参数不当作目标');
  assert.equal(summarizeMaidToolArgs({ _internal: 1, open: true })[0][1], '是');
  console.log('ok - maid run card model maps states, targets, folding and redaction');
}

{
  assert.deepEqual(
    [
      buildMaidVoiceTaskSummary({ status: 'running', message: '正在处理', request: '建私聊' }).beat,
      buildMaidVoiceTaskSummary({ status: 'running', message: '正在绑定世界书', request: '建私聊' }).beat,
      buildMaidVoiceTaskSummary({ status: 'succeeded', message: '都建好了', request: '建私聊' }).beat,
    ],
    [0, 1, 2],
    '接收 → 执行 → 汇报',
  );
  const waiting = buildMaidVoiceTaskSummary({ status: 'running', message: '允许绑定世界书吗？' }, { approvalPending: true });
  assert.equal(waiting.tone, 'warning');
  assert.equal(buildMaidVoiceTaskSummary({ status: 'failed', message: '没找到' }).tone, 'danger');
  console.log('ok - maid voice task summary exposes three beats');
}

{
  const documentRef = new FakeDocument();
  const stops = [];
  const decisions = [];
  const card = createMaidRunCardView({ documentRef, onStop: payload => stops.push(payload), onDecision: payload => decisions.push(payload), now: () => 13_000 });
  assert.ok(documentRef.getElementById('maid-run-card-style'), '样式只注入一次');
  card.update(projectMaidRunToTraceView(run()), { liveText: '正在绑定世界书', thoughts: ['先看看有哪些聊天室。'] });
  const [headEl, bodyEl] = card.el.children;
  assert.equal(card.el.dataset.state, 'running');
  assert.match(headEl.innerHTML, /mrc-ring/, '进行中头部是进度环');
  assert.match(headEl.innerHTML, /3\/4/);
  assert.match(headEl.innerHTML, /12\.0s/, '耗时由开始时间计算');
  assert.match(headEl.innerHTML, /data-mrc-action="stop"/, '停止按钮常驻');
  assert.doesNotMatch(headEl.innerHTML, /mrc-model/, '还不知道执行模型时不显示');
  card.update(projectMaidRunToTraceView(run({ metadata: { goal: '为三个角色建私聊并绑定世界书', executionModel: 'deepseek-flash' } })));
  assert.match(headEl.innerHTML, /<span class="mrc-model" title="执行模型">deepseek-flash<\/span>/, '头部写明实际执行的模型');
  assert.equal(projectMaidRunToTraceView(run({ usage: { model: 'gemini-3.8-flash' } })).executionModel, 'gemini-3.8-flash', '旧记录退回用量里的模型');
  const [rowsEl, approvalEl, liveEl, thoughtEl] = bodyEl.children;
  assert.equal(rowsEl.children.length, 2, '折叠行 + 当前步');
  assert.match(rowsEl.children[0].innerHTML, /已完成 3 步/);
  assert.equal(approvalEl.hidden, true);
  assert.equal(liveEl.hidden, false);
  assert.match(liveEl.innerHTML, /正在绑定世界书/);
  assert.equal(thoughtEl.hidden, false);
  assert.doesNotMatch(thoughtEl.innerHTML, /先看看有哪些聊天室/, '思路默认折叠');
  assert.doesNotMatch(card.el.children[0].innerHTML + rowsEl.children.map(child => child.innerHTML).join(''), /[计行成败]<\/span>/, '不再使用汉字铭牌');

  const currentRow = rowsEl.children[1];
  card.update(projectMaidRunToTraceView(run()), { liveText: '正在绑定世界书' });
  assert.equal(rowsEl.children[1], currentRow, '同 id 行原位保留，不重新进场');

  card.handleAction('thought');
  assert.match(thoughtEl.innerHTML, /先看看有哪些聊天室/);
  card.handleAction('fold');
  assert.equal(rowsEl.children.length, 4, '展开折叠后显示全部步骤');
  card.handleAction('row', 's2');
  assert.match(rowsEl.children[1].innerHTML, /session\.create/, '展开后显示工具与参数');
  assert.match(rowsEl.children[1].innerHTML, /2\.1s/);

  card.update(projectMaidRunToTraceView(run({ status: 'waiting_permission' })), {
    approval: { id: 'c1', title: '允许女仆绑定世界书吗？', message: '绑定到 3 个聊天室', items: [{ label: '精灵女王' }], allowAlways: true, confirmLabel: '允许一次', cancelLabel: '取消' },
  });
  assert.equal(card.el.dataset.state, 'waiting');
  assert.equal(approvalEl.hidden, false);
  assert.equal(liveEl.hidden, true, '等待确认时进行中行让位');
  assert.match(approvalEl.innerHTML, /始终允许/);
  card.handleAction('allow_once');
  assert.deepEqual(decisions[0], { id: 'c1', action: 'allow_once', runId: 'run_1' });
  card.setExtras({ voice: true });
  assert.doesNotMatch(approvalEl.innerHTML, /始终允许/, '语音确认不提供始终允许');
  assert.match(approvalEl.innerHTML, /也可以直接说“允许”/);
  assert.equal(card.handleAction('allow_always'), false);

  card.handleAction('stop');
  assert.deepEqual(stops, [{ runId: 'run_1' }]);

  card.update(projectMaidRunToTraceView(run({ status: 'succeeded', finishedAt: 18_200, steps: run().steps.map(step => ({ ...step, status: 'succeeded', finishedAt: step.finishedAt || 4200 })) })), { approval: null });
  assert.equal(card.el.dataset.state, 'done');
  assert.match(headEl.innerHTML, /mrc-badge is-ok/);
  assert.match(headEl.innerHTML, /17\.2s/, '终态耗时固定为结束时间');
  assert.equal(bodyEl.hidden, true, '完成后默认收起步骤');
  card.handleAction('toggle');
  assert.equal(bodyEl.hidden, false);
  console.log('ok - maid run card view renders states, folding, approval and actions');
}

{
  const opened = [];
  const changes = [];
  let visible = true;
  const allowRules = [];
  const runtime = createMaidToolConfirmationRuntime({
    allowStore: { isAllowed: () => false, allowAlways: request => { allowRules.push(request.toolName); return { id: 'rule' }; } },
    choose: async (options) => { opened.push(options); return 'allow_once'; },
    canShowInline: () => visible,
    onChange: () => changes.push(runtime.getPendingCount()),
  });

  const modal = await runtime.request({ toolName: 'x', title: 'T' }, { runId: '' });
  assert.deepEqual(modal, { decision: 'allow' });
  assert.equal(opened.length, 1, '没有 runId 时沿用弹窗');
  // 权限确认弹窗横排：始终允许（文字按钮）在左，取消、允许一次在右；回车仍默认允许一次
  assert.deepEqual(opened[0].actions.map(action => action.id), ['allow_always', 'deny', 'allow_once']);
  assert.equal(opened[0].defaultActionId, 'allow_once');
  assert.equal(opened[0].tone, 'caution');
  assert.equal(opened[0].danger, false, '非删除类操作不再用红色主按钮');

  {
    const dangerOpened = [];
    const dangerRuntime = createMaidToolConfirmationRuntime({ choose: async (options) => { dangerOpened.push(options); return 'deny'; } });
    await dangerRuntime.request({ toolName: 'regex.delete_many', title: '删除正则', operationType: 'delete_regex', allowAlways: false, confirmText: '确认删除' }, { runId: '' });
    assert.equal(dangerOpened[0].tone, 'danger');
    assert.equal(dangerOpened[0].danger, true);
    assert.equal(dangerOpened[0].badge, '删除');
    assert.deepEqual(dangerOpened[0].actions.map(action => action.id), ['deny', 'allow_once'], '不允许“始终允许”时不显示');
  }

  const inline = runtime.request({ toolName: 'worldbook.bind', title: '绑定？', details: { items: [{ label: 'A' }] } }, { runId: 'run_1' });
  const pending = runtime.getInline('run_1');
  assert.equal(pending.title, '绑定？');
  assert.equal(pending.items[0].label, 'A');
  assert.equal(runtime.getInline('run_other'), null);
  runtime.resolve(pending.id, 'allow_always');
  assert.deepEqual(await inline, { decision: 'allow', remembered: true, rule: { id: 'rule' } });
  assert.deepEqual(allowRules, ['worldbook.bind']);

  const escalated = runtime.request({ toolName: 'w', escalation: 'read_only_write' }, { runId: 'run_1' });
  const escalatedEntry = runtime.getInline('run_1');
  assert.equal(escalatedEntry.allowAlways, false, '只读升级不提供始终允许');
  runtime.resolve(escalatedEntry.id, 'allow_always');
  assert.deepEqual(await escalated, { decision: 'allow' }, '不可记忆的请求按允许一次处理');

  const voice = runtime.request({ toolName: 'v' }, { runId: 'run_voice' });
  assert.equal(runtime.confirmByVoice(['run_other']), false, '语音只确认本通话的任务');
  assert.equal(runtime.confirmByVoice(['run_voice']), true);
  assert.deepEqual(await voice, { decision: 'allow' }, '语音确认只算允许一次');

  const controller = new AbortController();
  const aborted = runtime.request({ toolName: 'a' }, { runId: 'run_1', signal: controller.signal });
  controller.abort();
  assert.deepEqual(await aborted, { decision: 'deny' }, '任务中止时确认随之取消');
  assert.equal(runtime.getPendingCount(), 0);

  const hidden = runtime.request({ toolName: 'h' }, { runId: 'run_1' });
  visible = false;
  runtime.ensureVisible();
  assert.equal(runtime.getInline('run_1'), null, '承载面关闭后改用弹窗');
  assert.deepEqual(await hidden, { decision: 'allow' });
  assert.equal(opened.length, 2);
  assert.ok(changes.length > 0);
  console.log('ok - maid tool confirmation runs inline, falls back to the modal and accepts voice once');
}

{
  const { resolveMaidLiveControl, createMaidRealtimeTools, maidTaskUpdateText } = await import('../../src/scripts/ui/realtime/realtime-maid-tools.js');
  const { createMaidVoiceTaskRuntime } = await import('../../src/scripts/ui/maid-voice-task-runtime.js');
  assert.equal(resolveMaidLiveControl('允许').action, 'confirm');
  assert.equal(resolveMaidLiveControl('允許。').action, 'confirm', '繁体同样可以确认');
  assert.equal(resolveMaidLiveControl('允许一次').action, 'confirm');
  assert.equal(resolveMaidLiveControl('Yes').action, 'confirm', '英文 yes 即可确认');
  assert.equal(resolveMaidLiveControl('allow').action, 'confirm');
  assert.equal(resolveMaidLiveControl('好').action, 'execute', '含糊回答不算确认');
  assert.equal(resolveMaidLiveControl('可以').action, 'execute');
  assert.equal(resolveMaidLiveControl('ok').action, 'execute');
  assert.equal(resolveMaidLiveControl('不允许').action, 'execute', '否定不是确认');
  const tool = createMaidRealtimeTools()[0];
  assert.ok(tool.parameters.properties.action.enum.includes('confirm'));
  assert.match(tool.description, /allows exactly once/);
  const prompt = maidTaskUpdateText({ kind: 'confirmation', task_id: 't1', request: '绑定世界书', message: '允许女仆绑定世界书吗？' });
  assert.match(prompt, /maid_permission_request/);
  assert.match(prompt, /允许/);
  assert.match(maidTaskUpdateText({ task_id: 't1', status: 'succeeded', message: 'ok' }), /maid_task_result/, '结果回传保持原格式');

  const confirmed = [];
  const submitted = [];
  let pending = true;
  const command = {
    isSubmitting: () => false,
    submitVoiceTask: (text, options) => { submitted.push({ text, id: options.id }); return new Promise(() => {}); },
  };
  const voiceTasks = createMaidVoiceTaskRuntime({
    getCommandRuntime: () => command,
    confirmApproval: (ids) => { confirmed.push(ids); return pending; },
  });
  const target = { maidCallId: 'call_a' };
  const accepted = await voiceTasks.request({ target, requestId: 'r1', args: { action: 'execute', request: '绑定世界书' } });
  await voiceTasks.request({ target: { maidCallId: 'call_b' }, requestId: 'r2', args: { action: 'execute', request: '别的通话' } });
  const result = await voiceTasks.request({ target, requestId: 'r3', args: { action: 'confirm' } });
  assert.equal(result.confirmed, true);
  assert.deepEqual(confirmed[0], [accepted.task_id], '只确认本通话的任务');
  pending = false;
  const noPending = await voiceTasks.request({ target, requestId: 'r4', args: { action: 'confirm' }, inputText: 'yes' });
  assert.equal(noPending.accepted, true, '没有待确认项时 yes 交给女仆按上下文处理');
  assert.equal(submitted.at(-1).text, 'yes');
  assert.equal(voiceTasks.getTaskMeta(accepted.task_id).requestId, 'r1');
  assert.equal(voiceTasks.getState().recent.length, 3, '托盘列出最近的语音任务');
  console.log('ok - voice confirmation accepts only 允许 / yes, stays scoped to the call and allows once');
}

{
  // 确认项带附注（改动前后、影响范围）或不会执行时逐行列出，便于看清要改什么
  const card = createMaidRunCardView({ documentRef: new FakeDocument() });
  card.update(projectMaidRunToTraceView(run({ status: 'waiting_permission' })), {
    approval: { id: 'c2', title: '写入正则规则', message: '', allowAlways: false, confirmLabel: '写入', cancelLabel: '取消', items: [
      { label: '去星号', meta: '修改：\\* → x ⇒ \\* → ', status: 'planned' },
      { label: '坏规则', meta: '', status: 'failed' },
    ] },
  });
  const approvalEl = card.el.children[1].children[1];
  assert.match(approvalEl.innerHTML, /is-detailed/);
  assert.match(approvalEl.innerHTML, /修改：/);
  assert.match(approvalEl.innerHTML, /is-skipped[\s\S]*不会执行/);
  assert.doesNotMatch(approvalEl.innerHTML, /始终允许/, '不可记忆的确认不提供始终允许');
  console.log('ok - inline approval lists item notes and skipped items');
}
