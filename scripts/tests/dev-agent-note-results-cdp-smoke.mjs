import assert from 'node:assert/strict';
import { evaluateInApp } from '../dev/cdp-client.mjs';

const fixture = async () => {
  const { createAgentToolbox } = await import(`/scripts/ui/agent-toolbox.js?note-smoke=${Date.now()}`);
  const { AgentCenterPanel } = await import(`/scripts/ui/agent-center-panel.js?note-smoke=${Date.now()}`);
  const check = (condition, label) => { if (!condition) throw Error(label); };
  const pause = () => new Promise(resolve => setTimeout(resolve, 40));
  const frame = document.createElement('iframe'); frame.style.cssText = 'position:fixed;left:20px;top:20px;width:390px;height:720px;z-index:31000;background:white';
  document.body.append(frame);
  const doc = frame.contentDocument, win = frame.contentWindow;
  doc.body.innerHTML = '<div class="chat-input-row"><textarea aria-label="isolated draft">draft</textarea></div>';
  const input = doc.querySelector('textarea');
  const ctx = { place: 'writing', sessionId: 'rp:note-fixture', scopeId: 'fixture', archiveId: 'A' };
  const configs = [{ id: 'text-edit:manual', kind: 'text_edit', title: 'Manual note', enabled: true, invocationMode: 'manual', outputMode: 'note' },
    { id: 'text-edit:auto', kind: 'text_edit', title: 'Automatic note', enabled: true, invocationMode: 'auto', outputMode: 'note' }];
  const jobs = [
    { id: 'text-edit-run:manual', agentId: configs[0].id, title: configs[0].title, outputMode: 'note', text: 'Manual result <script>plain text</script>', context: ctx, sessionId: ctx.sessionId, messageId: 'reply', status: 'ready' },
    { id: 'text-edit-run:auto', agentId: configs[1].id, title: configs[1].title, outputMode: 'note', text: 'Automatic result', context: ctx, sessionId: ctx.sessionId, messageId: 'reply', status: 'ready', trace: { steps: [{ id: '1', kind: 'answer', label: '生成结果', status: 'succeeded' }] } },
    { id: 'text-edit-run:wrong', agentId: configs[1].id, title: 'PRIVATE OTHER ARCHIVE', outputMode: 'note', text: 'PRIVATE OTHER ARCHIVE', context: { ...ctx, archiveId: 'B' }, sessionId: ctx.sessionId, messageId: 'reply', status: 'ready' },
  ];
  let copied = '', reviews = 0, executions = 0, opened = null, flips = 0;
  Object.defineProperty(win.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { copied = value; } } });
  const actions = { listAgentConfigurations: () => configs.map(config => ({ config })), getAgentConfiguration: () => ({ context: ctx }),
    listInputAgentRuns: () => [], listTextEditRuns: () => jobs,
    runTextEditAgent: async () => { executions++; }, openTextEditRun: () => { reviews++; },
    ignoreTextEditRun: id => { jobs.find(job => job.id === id).status = 'ignored'; }, ignoreInputAgentRun: () => { throw Error('wrong dismiss runtime'); } };
  let toolbox;
  try {
    toolbox = createAgentToolbox({ input, actions, getContext: () => ctx, getMessages: () => [{ id: 'reply', role: 'assistant', content: 'Body' }],
      getInputSnapshot: () => ({ text: input.value, revision: 1, start: 0, end: 5 }), openAgent: (id, options) => { opened = { id, options }; }, openCenter() {}, documentRef: doc,
      storage: { getItem: () => null, setItem() {} } });
    toolbox.open();
    const panel = toolbox.panel;
    check(panel.querySelector('[data-key="result-run:text-edit-run:auto"]'), 'automatic reply note appears even when draft is selected');
    check(!panel.textContent.includes('PRIVATE OTHER ARCHIVE'), 'other archive does not appear');
    panel.querySelector('[data-key="result-run:text-edit-run:auto"]').click();
    check(panel.querySelector('pre').textContent === 'Automatic result', 'automatic result visible');
    check(!panel.querySelector('[data-key^="review:"],[data-key^="apply:"]'), 'note has no patch action');
    panel.querySelector('[data-key^="copy:"]').click(); await pause();
    check(copied === 'Automatic result' && panel.textContent.includes('已复制'), 'copy result and confirmation');
    panel.querySelector('[data-key^="process:"]').click();
    check(opened.id === configs[1].id && opened.options.messageId === 'reply', 'execution process opens matching Agent details');
    toolbox.open({ messageId: 'reply' });
    panel.querySelector('[data-key="run:text-edit:manual"]').click(); await pause();
    check(panel.querySelector('pre').textContent === jobs[0].text && !panel.querySelector('script'), 'manual note shows escaped output');
    check(executions === 0 && reviews === 0, 'ready note never regenerates or opens patch review');
    panel.querySelector('[data-key^="ignore:"]').click(); await pause();
    check(jobs[0].status === 'ignored', 'dismiss delegates to reply runtime');

    const fake = { getActions: () => actions, getHopscotchPanel: () => null, getAgentCards: () => [], renderCardList: () => '',
      mountCommonAgentEditors() {}, openFloatingAgentCard: (id, options) => { opened = { id, options }; }, toggleFloatingAgentCard: () => { flips++; } };
    const centerHost = doc.createElement('section'); centerHost.innerHTML = AgentCenterPanel.prototype.renderAgents.call(fake); doc.body.append(centerHost);
    check(centerHost.querySelector('[data-text-agent-result="text-edit-run:auto"]'), 'AC note uses view result entry');
    check(!centerHost.querySelector('[data-text-edit-run]') && !centerHost.textContent.includes('PRIVATE OTHER ARCHIVE'), 'AC notes do not use patch action or other archive');
    AgentCenterPanel.prototype.bindAgentCardEvents.call(fake, centerHost);
    centerHost.querySelector('[data-text-agent-result="text-edit-run:auto"]').click();
    check(opened.id === configs[1].id && flips === 1 && reviews === 0, 'AC opens note Agent configuration details');
    return { automatic: true, manual: true, copy: true, dismiss: true, context: true, noPatch: true, centerEntry: true };
  } finally { toolbox?.dispose(); frame.remove(); }
};
const result = await evaluateInApp(`(${fixture.toString()})()`);
assert.equal(result.centerEntry, true); console.log(result);
