import assert from 'node:assert/strict';

import { createAppNavigationAgentTools } from '../../src/scripts/agent/tools/app-navigation-tools.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAgentPermissionEvaluator } from '../../src/scripts/agent/agent-permissions.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);

{
  const opened = [];
  const tools = createAppNavigationAgentTools({
    actions: {
      config: options => {
        opened.push(['config', options.tab]);
        return { opened: true };
      },
      'group-create': () => {
        opened.push(['group-create']);
        return { opened: true };
      },
    },
  });
  const result = await getTool(tools, 'app.open_panel').execute({ panel: 'api', tab: 'chat' });
  assert.equal(result.opened, true);
  assert.equal(result.panel, 'config');
  const groupCreate = await getTool(tools, 'app.open_panel').execute({ panel: 'create-group' });
  assert.equal(groupCreate.opened, true);
  assert.equal(groupCreate.panel, 'group-create');
  assert.deepEqual(opened, [['config', 'chat'], ['group-create']]);
  console.log('ok - app navigation tool normalizes panel aliases and opens whitelisted panels');
}

{
  const tools = createAppNavigationAgentTools({
    getCurrentState: () => ({ activePage: 'chat', sessionId: 'A' }),
    getVisiblePanelSummary: () => ({
      ok: true,
      activePage: 'chat',
      sessionId: 'A',
      panels: [{ id: 'chat', title: '聊天室', text: '当前聊天内容' }],
    }),
    readResource: args => ({
      ok: true,
      resource: args.resource,
      items: [{ id: 'm1', content: '完整回复' }],
    }),
  });
  const state = await getTool(tools, 'app.get_current_state').execute({});
  assert.deepEqual(state, { activePage: 'chat', sessionId: 'A' });

  const visible = await getTool(tools, 'app.ui.inspect').execute({});
  assert.equal(visible.ok, true);
  assert.equal(visible.panels[0].id, 'chat');
  const legacyVisible = await getTool(tools, 'app.read_visible_panel_summary').execute({});
  assert.equal(legacyVisible.ok, true);
  assert.equal(legacyVisible.panels[0].id, 'chat');

  const resourceTool = getTool(tools, 'app.read_resource');
  assert.match(resourceTool.schema.properties.include.description, /persona\/user/);
  assert.match(resourceTool.schema.properties.include.description, /details/);
  assert.match(resourceTool.schema.properties.include.description, /associations/);
  const resource = await resourceTool.execute({ resource: 'chat', sessionName: 'A' });
  assert.equal(resource.ok, true);
  assert.equal(resource.resource, 'chat');
  assert.equal(resource.items[0].content, '完整回复');

  const search = await getTool(tools, 'app.search_feature').execute({ query: '世界书' });
  assert.equal(search.features[0].id, 'worldbook.open');

  const doc = await getTool(tools, 'app.read_feature_doc').execute({ featureId: 'worldbook.open' });
  assert.equal(doc.ok, true);
  assert.equal(doc.feature.panel, 'worldbook');
  console.log('ok - app navigation tools read state and feature catalog');
}

{
  const tools = createAppNavigationAgentTools({
    listRecentErrors: ({ limit }) => [
      {
        kind: 'maid_run',
        goal: '整理世界书',
        reason: 'args.name is required',
        maidStatus: 'failed',
        continuable: false,
        at: 1700000000000,
        failedSteps: [{ toolName: 'worldbook.update_entries', errorMessage: 'args.name is required' }],
      },
    ].slice(0, limit),
  });
  const result = await getTool(tools, 'app.read_recent_errors').execute({ limit: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.errors[0].goal, '整理世界书');
  assert.equal(result.errors[0].failedSteps[0].toolName, 'worldbook.update_entries');
  console.log('ok - app.read_recent_errors returns recent maid run failures');
}

{
  const tools = createAppNavigationAgentTools({});
  const result = await getTool(tools, 'app.read_recent_errors').execute({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'recent_errors_unavailable');
  console.log('ok - app.read_recent_errors reports unavailable without provider');
}

{
  const clicks = [];
  const tools = createAppNavigationAgentTools({
    clickUiElement: async args => {
      clicks.push(args);
      return { ok: true, clicked: true };
    },
  });
  const clickTool = getTool(tools, 'ui.click_element');
  assert.equal(clickTool.metadata.allowInReadOnlyIntent, true);
  const safe = await clickTool.execute({ label: '活动' }, {
    operationIntentPolicy: { mode: 'read_only' },
  });
  assert.equal(safe.clicked, true);
  const dangerous = await clickTool.execute({ label: '删除记录' }, {
    operationIntentPolicy: { mode: 'read_only' },
    requestToolConfirmation: () => ({ decision: 'allow' }),
  });
  assert.equal(dangerous.ok, false);
  assert.equal(dangerous.reason, 'agent_tool_write_intent_required');
  assert.equal(clicks.length, 1);
  console.log('ok - read-only intent allows navigation clicks but blocks dangerous UI actions');
}

{
  const clicks = [];
  let confirmationScopesStarted = 0;
  let confirmationScopesEnded = 0;
  const tools = createAppNavigationAgentTools({
    describeUiElement: ({ ref }) => ({ ok: true, ref, label: '删除记录' }),
    beginUiElementConfirmation: () => {
      confirmationScopesStarted += 1;
      return () => { confirmationScopesEnded += 1; };
    },
    clickUiElement: async args => {
      clicks.push(args);
      return { ok: true, clicked: '删除记录' };
    },
  });
  const clickTool = getTool(tools, 'ui.click_element');
  const readOnly = await clickTool.execute({ ref: 'settings:r1:btn-2' }, {
    operationIntentPolicy: { mode: 'read_only' },
    requestToolConfirmation: () => ({ decision: 'allow' }),
  });
  assert.equal(readOnly.ok, false);
  assert.equal(readOnly.reason, 'agent_tool_write_intent_required');
  assert.equal(clicks.length, 0);
  assert.equal(confirmationScopesStarted, 0);

  let confirmation = null;
  const allowed = await clickTool.execute({ ref: 'settings:r1:btn-2' }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => {
      confirmation = request;
      return { decision: 'allow' };
    },
  });
  assert.equal(allowed.ok, true);
  assert.equal(clicks.length, 1);
  assert.equal(confirmationScopesStarted, 1);
  assert.equal(confirmationScopesEnded, 1);
  assert.match(confirmation.message, /删除记录/);
  console.log('ok - ref-only dangerous UI clicks resolve their label before intent and confirmation checks');
}

{
  const clicks = [];
  const tools = createAppNavigationAgentTools({
    describeUiElement: ({ ref }) => ({ ok: true, ref, label: '删除记录', panel: 'settings' }),
    clickUiElement: async args => {
      clicks.push(args);
      return { ok: true, clicked: '删除记录' };
    },
  });
  const clickTool = getTool(tools, 'ui.click_element');
  const disguised = await clickTool.execute({
    ref: 'settings:r1:btn-2',
    label: '活动',
  }, {
    operationIntentPolicy: { mode: 'read_only' },
    requestToolConfirmation: () => ({ decision: 'allow' }),
  });
  assert.equal(disguised.ok, false);
  assert.equal(disguised.reason, 'agent_tool_write_intent_required');
  assert.equal(clicks.length, 0);

  let confirmation = null;
  const allowed = await clickTool.execute({
    ref: 'settings:r1:btn-2',
    label: '活动',
  }, {
    operationIntentPolicy: { mode: 'write_allowed' },
    requestToolConfirmation: request => {
      confirmation = request;
      return { decision: 'allow' };
    },
  });
  assert.equal(allowed.ok, true);
  assert.match(confirmation.message, /删除记录/);
  assert.equal(clicks[0].label, '删除记录');
  console.log('ok - ref clicks use the inspected label instead of a caller supplied harmless label');
}

{
  // 用户决定（2026-11-20）：程序分不清哪个按钮会改内容，每次点击都先确认；危险按钮单独一类 kind，operationType 固定
  const clicks = [];
  let scopesStarted = 0;
  let scopesEnded = 0;
  const labels = { 'settings:r1:btn-1': '活动', 'settings:r1:btn-2': '删除记录' };
  const tools = createAppNavigationAgentTools({
    describeUiElement: ({ ref }) => (labels[ref] ? { ok: true, ref, label: labels[ref], panel: 'settings' } : { ok: false, reason: 'ref_not_found' }),
    beginUiElementConfirmation: () => {
      scopesStarted += 1;
      return () => { scopesEnded += 1; };
    },
    clickUiElement: async args => {
      clicks.push(args);
      return { ok: true, clicked: args.label };
    },
  });
  const clickTool = getTool(tools, 'ui.click_element');
  const pick = result => [result.destructive, result.kind, result.operationType, result.danger];
  assert.deepEqual(pick(await clickTool.safety.preflight({ ref: 'settings:r1:btn-1' }, {})), [true, 'ui.click_element', 'click_element', false]);
  assert.deepEqual(pick(await clickTool.safety.preflight({ label: '展开' }, { operationIntentPolicy: { mode: 'read_only' } })), [true, 'ui.click_element', 'click_element', false],
    'even navigation clicks are confirmed');
  const danger = await clickTool.safety.preflight({ ref: 'settings:r1:btn-2', label: '活动' }, {});
  assert.deepEqual(pick(danger), [true, 'ui.click_danger', 'click_element', true], 'the inspected label decides the danger class');
  assert.match(danger.message, /删除记录/);
  assert.equal((await clickTool.safety.preflight({ ref: 'settings:r1:btn-2' }, { operationIntentPolicy: { mode: 'read_only' } })).destructive, false,
    'read-only intent refuses dangerous clicks in execute without asking first');
  assert.equal((await clickTool.safety.preflight({ ref: 'settings:r9:gone' }, {})).destructive, false, 'a stale ref clicks nothing');
  assert.equal((await clickTool.safety.preflight({}, {})).destructive, false, 'no target clicks nothing');
  assert.equal((await getTool(createAppNavigationAgentTools(), 'ui.click_element').safety.preflight({ label: '活动' }, {})).destructive, false);
  assert.deepEqual([scopesStarted, scopesEnded], [3, 3], 'each confirming preflight opens one scope; the next click call closes a leftover one');

  const registry = createAgentToolRegistry({
    permissionEvaluator: createAgentPermissionEvaluator({ defaultDecision: 'allow' }),
    logger: { warn() {} },
  });
  registry.registerMany(tools);
  const requests = [];
  const allowed = await registry.executeTool('ui.click_element', { ref: 'settings:r1:btn-2' }, {
    requestToolConfirmation: (request) => { requests.push(request); return true; },
  });
  assert.equal(allowed.result.ok, true);
  assert.deepEqual(requests.map(request => request.kind), ['ui.click_danger'], 'a dangerous click asks once, not again inside execute');
  assert.equal(scopesEnded, scopesStarted, 'the confirmation scope closes before clicking');
  const denied = await registry.executeTool('ui.click_element', { ref: 'settings:r1:btn-1' }, {
    requestToolConfirmation: (request) => { requests.push(request); return false; },
  });
  assert.equal(denied.status, 'skipped');
  assert.deepEqual([denied.result.reason, denied.result.cancelled], ['user_declined', true]);
  assert.equal(clicks.length, 1, 'a declined click never clicks');
  await clickTool.safety.preflight({}, {});
  assert.equal(scopesEnded, scopesStarted, 'a declined confirmation scope is closed by the next click call');
  console.log('ok - every UI click is confirmed once by preflight, dangerous labels get their own kind');
}
