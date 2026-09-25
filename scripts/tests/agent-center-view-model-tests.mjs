import assert from 'node:assert/strict';

import {
  AGENT_CENTER_TABS,
  buildAgentCenterView,
} from '../../src/scripts/ui/agent-center-view-model.js';

{
  assert.deepEqual(AGENT_CENTER_TABS.map(tab => tab.id), ['pending', 'agents', 'prompts', 'global_prompts', 'diagnostics', 'resources', 'activity', 'safety']);
  console.log('ok - agent center exposes user-facing tabs');
}

{
  const view = buildAgentCenterView({
    pendingPermissions: [
      {
        id: 'permission-1',
        status: 'pending',
        toolName: 'contact_profile.list',
        sessionId: 'chat:alice',
        permissions: ['storage'],
        riskLevel: 'low',
        createdAt: 2,
      },
      {
        id: 'permission-2',
        status: 'denied',
        toolName: 'memory.update_after_chat',
        permissions: ['storage:write'],
        riskLevel: 'medium',
        createdAt: 1,
      },
    ],
    contactProfilePendingUpdates: [
      {
        id: 'profile-pending-1',
        status: 'pending',
        contactId: 'chat:bob',
        reason: 'background',
        createdAt: 3,
        profile: {
          contactId: 'chat:bob',
          displayName: 'Bob',
          stable_traits: [{ label: '喜欢咖啡' }],
          interaction_focus: [{ topic: 'daily' }],
        },
      },
    ],
    agentRuns: [
      {
        id: 'run-1',
        kind: 'memory_update',
        title: 'Memory update',
        status: 'running',
        createdAt: 10,
        updatedAt: 12,
      },
      {
        id: 'run-2',
        kind: 'lineage_layout',
        title: 'Lineage layout',
        status: 'failed',
        createdAt: 8,
        updatedAt: 9,
      },
    ],
    tools: [
      { name: 'memory.update_after_chat', title: 'Memory update', permissions: ['storage:write'], riskLevel: 'medium' },
      { name: 'contact_profile.list', title: 'Contact profile list', permissions: ['storage'], riskLevel: 'low' },
    ],
    agentFeatureSettings: {
      features: {
        reply_check: { enabled: true, modelMode: 'none', triggerMode: 'local_only', updatedAt: 100 },
        write_preview: { enabled: false, modelMode: 'none' },
      },
    },
    sessionGate: { enabled: false, allowedTools: ['contact_profile.list'] },
    experimentStatus: { enabled: false, allowedTools: ['contact_profile.list'] },
    continuationCommitPolicy: { defaultStrategy: 'append_to_previous_bubble', strategies: ['preview_only', 'append_to_previous_bubble'] },
  });
  assert.equal(view.meta.pending, 2);
  assert.equal(view.meta.activeRuns, 1);
  assert.equal(view.meta.failedRuns, 1);
  assert.equal(view.meta.unreadFailedRuns, 1);
  assert.equal(view.meta.newestFailureAt, 9);
  assert.equal(view.meta.tools, 2);
  assert.equal(view.meta.resources, 6);
  assert.equal(view.meta.resourceAlerts, 1);
  assert.equal(view.pending[0].id, 'profile-pending-1');
  assert.equal(view.pending[0].kind, 'contact_profile_update');
  assert.equal(view.pending[0].profileSummary, 'Bob · 特征 1 · 互动重点 1');
  assert.deepEqual(view.pending.map(item => item.id), ['profile-pending-1', 'permission-1']);
  assert.deepEqual(view.tools.map(tool => tool.name), ['contact_profile.list', 'memory.update_after_chat']);
  assert.equal(view.meta.agents, 8);
  assert.equal(view.meta.promptModules, 3);
  assert.equal(view.meta.diagnosticViews, 2);
  assert.equal(view.meta.featureAgents, 5);
  for (const id of ['archive_naming', 'reply_scoring']) assert.equal(view.agents.find(agent => agent.id === id).enabled, false);
  assert.equal(view.meta.enabledAgents, 4);
  assert.equal(view.meta.enabledPromptModules, 3);
  assert.equal(view.meta.enabledFeatureAgents, 1);
  assert.equal(view.agents.find(agent => agent.id === 'reply_check').title, '检查回复格式');
  assert.equal(view.agents.find(agent => agent.id === 'reply_check').enabled, true);
  assert.equal(view.agents.find(agent => agent.id === 'reply_check').modelLabel, '不调用模型');
  assert.equal(view.agents.find(agent => agent.id === 'reply_check').triggerLabel, '自动触发');
  assert.equal(view.agents.find(agent => agent.id === 'text_completion').enabled, false);
  assert.equal(view.agents.find(agent => agent.id === 'prompt_manager'), undefined);
  assert.equal(view.agents.find(agent => agent.id === 'memory_manager'), undefined);
  assert.equal(view.agents.find(agent => agent.id === 'image_director').title, '生图 Agent');
  assert.equal(view.agents.find(agent => agent.id === 'memory_table_agent').enabled, true);
  assert.equal(view.agents.find(agent => agent.id === 'summary_agent'), undefined);
  assert.equal(view.agents.find(agent => agent.id === 'execution_lane_agent'), undefined);
  assert.equal(view.promptModules.find(agent => agent.id === 'phone_format_agent').title, '手机格式');
  assert.equal(view.diagnosticViews.find(agent => agent.id === 'execution_lane_agent').summary, '把创作过程按输入、模型、记忆和生图等泳道展示。');
  assert.deepEqual(view.tools[0].capabilities, {
    read: false,
    write: false,
    network: false,
    cost: 'none',
    undo: 'none',
    modelContext: 'none',
    confirmation: 'allow_once',
  });
  assert.equal(view.tabs.find(tab => tab.id === 'pending').count, 2);
  assert.equal(view.tabs.find(tab => tab.id === 'activity').count, 1);
  assert.equal(view.tabs.find(tab => tab.id === 'agents').count, 8);
  assert.equal(view.tabs.find(tab => tab.id === 'prompts').count, 3);
  assert.equal(view.tabs.find(tab => tab.id === 'diagnostics').count, 2);
  assert.equal(view.tabs.find(tab => tab.id === 'resources').count, 1);
  assert.equal(view.resources.find(resource => resource.id === 'prompt_library'), undefined);
  assert.equal(view.resources.find(resource => resource.id === 'contact_profiles').count, 1);
  assert.equal(view.safety.continuationCommitPolicy.defaultStrategy, 'append_to_previous_bubble');
  assert.equal(view.safety.sessionGate.writePreviewTools.enabled, false);
  assert.deepEqual(view.safety.sessionGate.writePreviewTools.activeTools, []);
  console.log('ok - agent center view summarizes pending activity tools and safety state');
}

{
  const view = buildAgentCenterView({
    memoryMode: 'summary',
  });
  assert.equal(view.agents.find(agent => agent.id === 'memory_table_agent').title, '记忆表格 Agent');
  assert.equal(view.agents.find(agent => agent.id === 'summary_agent').title, '摘要 Agent');
  assert.equal(view.tabs.find(tab => tab.id === 'agents').count, 9);
  assert.equal(view.meta.memoryMode, 'summary');
  console.log('ok - agent center keeps the memory mode hub reachable while showing summary agent in summary mode');
}

{
  const view = buildAgentCenterView({ memoryMode: 'off' });
  assert.equal(view.agents.find(agent => agent.id === 'memory_table_agent').title, '记忆表格 Agent');
  assert.equal(view.agents.find(agent => agent.id === 'summary_agent'), undefined);
  assert.equal(view.tabs.find(tab => tab.id === 'agents').count, 8);
  console.log('ok - agent center keeps the memory mode hub reachable while memory is off');
}

{
  const view = buildAgentCenterView({
    agentModelProfiles: [
      { id: 'profile-a', name: '轻量检查', provider: 'openrouter', model: 'model-a' },
    ],
    agentFeatureSettings: {
      features: {
        reply_check: { modelMode: 'profile', modelProfileId: 'profile-a' },
      },
    },
  });
  assert.equal(view.agentModelProfiles[0].label, '轻量检查 · openrouter / model-a');
  assert.equal(view.agents.find(agent => agent.id === 'reply_check').modelLabel, '轻量检查 · openrouter / model-a');
  console.log('ok - agent center view resolves selected agent model profile labels');
}

{
  const view = buildAgentCenterView({
    sessionGate: {
      enabled: true,
      allowedTools: [
        'contact_profile.list',
        'memory.preview_actions',
        'variable.preview_commands',
        'worldbook.preview_actions',
      ],
    },
  });
  assert.equal(view.safety.sessionGate.writePreviewTools.enabled, true);
  assert.deepEqual(view.safety.sessionGate.writePreviewTools.activeTools, [
    'memory.preview_actions',
    'variable.preview_commands',
    'worldbook.preview_actions',
  ]);
  console.log('ok - agent center view summarizes write preview model-context state');
}

{
  const view = buildAgentCenterView({
    permissionRules: [
      {
        layer: 'session',
        decision: 'allow',
        toolName: 'contact_profile.list',
        permission: 'storage',
        sessionId: 'chat:a',
        priority: 0,
      },
      {
        layer: 'global',
        decision: 'deny',
        toolName: 'contact_profile.list',
        permission: 'storage',
        sessionId: 'chat:a',
        priority: 0,
      },
      {
        layer: 'session',
        decision: 'deny',
        toolName: 'contact_profile.list',
        permission: 'storage',
        sessionId: 'chat:a',
        priority: 1,
      },
    ],
  });
  const summary = view.safety.permissionRuleSummary;
  assert.equal(summary.total, 3);
  assert.equal(summary.orderText, '全局 > 角色卡 > 当前会话 > Agent > 插件 > 默认');
  assert.equal(summary.tieBreakText, '同层先看优先级，仍相同则以后添加的规则生效。');
  assert.equal(summary.decisionCounts.allow, 1);
  assert.equal(summary.decisionCounts.deny, 2);
  assert.equal(summary.conflictCount, 1);
  assert.equal(summary.visibleRules[0].layerLabel, '全局');
  assert.equal(summary.visibleRules[0].decisionLabel, '拒绝');
  assert.equal(summary.visibleRules[1].priority, 1);
  console.log('ok - agent center view summarizes permission precedence for safety UI');
}

{
  const view = buildAgentCenterView({
    agentRunView: {
      meta: { total: 3, active: 2, failures: 1 },
      filters: { limit: 3 },
      runs: [{ id: 'run-3', status: 'running', kind: 'image_generation' }],
    },
    tools: null,
    pendingPermissions: null,
  });
  assert.equal(view.activity.runs.length, 1);
  assert.equal(view.meta.activeRuns, 2);
  assert.equal(view.meta.unreadFailedRuns, 1);
  assert.equal(view.meta.tools, 0);
  // 只读用量画像随 activity 视图一并构建（此处 run 无 usage → unknown 计数）
  assert.ok(view.activity.usageProfile && view.activity.usageProfile.overall);
  assert.equal(view.activity.usageProfile.overall.runCount, 1);
  console.log('ok - agent center accepts prebuilt agent run views');
}

{
  // usage 画像从带 usage 的 run 汇总：recorded 求和，unknown 只计数
  const view = buildAgentCenterView({
    agentRuns: [
      { id: 'u1', kind: 'maid_assistant', usage: { status: 'recorded', promptTokens: 1000, completionTokens: 200, totalTokens: 1200, latencyMs: 3000, toolCallCount: 2 } },
      { id: 'u2', kind: 'maid_assistant', usage: { status: 'unknown', latencyMs: 500, toolCallCount: 1 } },
    ],
    tools: null,
    pendingPermissions: null,
  });
  const profile = view.activity.usageProfile;
  assert.equal(profile.overall.runCount, 2);
  assert.equal(profile.overall.recordedCount, 1);
  assert.equal(profile.overall.unknownCount, 1);
  assert.equal(profile.overall.totalTokens, 1200);
  console.log('ok - agent center activity view aggregates read-only usage profile');
}

{
  const view = buildAgentCenterView({
    pendingPermissions: [{
      id: 'chat-emit-pending-1',
      status: 'pending',
      toolName: 'chat.emit_private',
      sessionId: 'contact:firen',
      permissions: ['chat:emit_candidate'],
      argsPreview: {
        targetName: '菲伦',
        speakerName: '菲伦',
        content: '今晚别一个人走。',
        time: '22:12',
      },
    }],
  });
  assert.equal(view.pending[0].chatEmitPreview.kind, '私聊候选');
  assert.equal(view.pending[0].chatEmitPreview.target, '菲伦');
  assert.equal(view.pending[0].chatEmitPreview.speaker, '菲伦');
  assert.equal(view.pending[0].chatEmitPreview.contentPreview, '今晚别一个人走。');
  assert.equal(view.pending[0].chatEmitCommitPreview.effect, '新增 1 条私聊消息到「菲伦」');
  assert.equal(view.pending[0].chatEmitCommitPreview.currentExecutionWrites, false);
  assert.equal(view.pending[0].chatEmitCommitPreview.confirmationRequired, true);
  assert.equal(view.pending[0].chatEmitCommit.canCommit, false);
  assert.equal(view.pending[0].chatEmitCommit.canUndo, false);
  console.log('ok - agent center view summarizes chat emit pending previews');
}

{
  const ready = buildAgentCenterView({
    pendingPermissions: [{
      id: 'chat-emit-pending-2',
      status: 'allowed',
      toolName: 'chat.emit_private',
      sessionId: 'contact:firen',
      permissions: ['chat:emit_candidate'],
      resumeStatus: 'succeeded',
      commitStatus: 'idle',
      argsPreview: {
        targetName: '菲伦',
        speakerName: '菲伦',
        content: '今晚别一个人走。',
      },
    }],
  });
  assert.equal(ready.pending[0].chatEmitCommit.canCommit, true);
  assert.equal(ready.pending[0].chatEmitCommit.canUndo, false);

  const committed = buildAgentCenterView({
    pendingPermissions: [{
      id: 'chat-emit-pending-3',
      status: 'allowed',
      toolName: 'chat.emit_private',
      sessionId: 'contact:firen',
      permissions: ['chat:emit_candidate'],
      resumeStatus: 'succeeded',
      commitStatus: 'committed',
      commitResult: {
        status: 'committed',
        refs: { createdMessageIds: ['m1'] },
      },
      argsPreview: {
        targetName: '菲伦',
        speakerName: '菲伦',
        content: '今晚别一个人走。',
      },
    }],
  });
  assert.equal(committed.pending[0].chatEmitCommit.canCommit, false);
  assert.equal(committed.pending[0].chatEmitCommit.canUndo, true);
  assert.equal(committed.pending[0].chatEmitCommit.resultSummary, '消息 1');

  const skipped = buildAgentCenterView({
    pendingPermissions: [{
      id: 'chat-emit-pending-4',
      status: 'allowed',
      toolName: 'chat.emit_private',
      sessionId: 'contact:firen',
      permissions: ['chat:emit_candidate'],
      resumeStatus: 'succeeded',
      commitStatus: 'skipped',
      commitResult: {
        status: 'skipped',
        reason: 'target_session_not_found',
        displayMessage: '找不到候选目标会话，请检查目标名称或 ID 后重试。',
      },
      argsPreview: {
        targetName: '菲伦',
        speakerName: '菲伦',
        content: '今晚别一个人走。',
      },
    }],
  });
  assert.equal(skipped.pending[0].chatEmitCommit.canCommit, true);
  assert.equal(skipped.pending[0].chatEmitCommit.message, '找不到候选目标会话，请检查目标名称或 ID 后重试。');

  const rejected = buildAgentCenterView({
    pendingPermissions: [{
      id: 'chat-emit-pending-5',
      status: 'allowed',
      toolName: 'chat.emit_private',
      sessionId: 'contact:firen',
      permissions: ['chat:emit_candidate'],
      resumeStatus: 'succeeded',
      commitStatus: 'skipped',
      commitResult: {
        status: 'skipped',
        reason: 'user_rejected',
        reviewDecision: 'user_rejected',
        displayMessage: '已打回，未提交聊天候选。',
      },
      argsPreview: {
        targetName: '菲伦',
        speakerName: '菲伦',
        content: '今晚别一个人走。',
      },
    }],
  });
  assert.equal(rejected.pending.length, 0);
  console.log('ok - agent center view exposes chat emit commit and undo actions after resume');
}

{
  const pending = buildAgentCenterView({
    pendingPermissions: [{
      id: 'memory-preview-pending-1',
      status: 'pending',
      toolName: 'memory.preview_actions',
      sessionId: 'chat:firen',
      permissions: ['storage'],
      argsPreview: {
        sessionId: 'chat:firen',
        actions: [
          { action: 'insert', tableId: 'profile', data: { name: '菲伦' } },
          { action: 'update', tableId: 'profile', rowId: 'r1', data: { note: 'next' } },
        ],
      },
    }],
  });
  assert.equal(pending.pending[0].writePreview.kind, '记忆表写入预览');
  assert.equal(pending.pending[0].writePreview.target, 'chat:firen');
  assert.equal(pending.pending[0].writePreview.requestCount, 2);
  assert.equal(pending.pending[0].writePreview.previewReady, false);
  assert.equal(pending.pending[0].writePreview.currentExecutionWrites, false);

  const resumed = buildAgentCenterView({
    pendingPermissions: [{
      id: 'worldbook-preview-pending-1',
      status: 'allowed',
      toolName: 'worldbook.preview_actions',
      sessionId: 'chat:firen',
      permissions: ['worldbook.read'],
      argsPreview: {
        worldId: 'world:firen',
        actions: [{ action: 'update_entry', entryId: 'e1', patch: { content: 'next' } }],
      },
      resumeStatus: 'succeeded',
      resumeResult: {
        output: {
          status: 'succeeded',
          result: {
            changed: 1,
            skipped: 0,
            updated: 1,
            entryCountBefore: 3,
            entryCountAfter: 3,
            rollbackSnapshot: { worldId: 'world:firen', worldData: { entries: [] } },
            entries: [{
              kind: 'update',
              action: 'update_entry',
              entryId: 'e1',
              title: '菲伦',
              diff: { changedFields: ['content'] },
            }],
          },
        },
      },
    }],
  });
  assert.equal(resumed.pending[0].writePreview.kind, '世界书写入预览');
  assert.equal(resumed.pending[0].writePreview.target, 'world:firen');
  assert.equal(resumed.pending[0].writePreview.previewReady, true);
  assert.equal(resumed.pending[0].writePreview.resultSummary, '变更 1 · 跳过 0 · updated 1 · 条目 3 -> 3');
  assert.equal(resumed.pending[0].writePreview.rollbackReady, true);
  assert.equal(resumed.pending[0].writePreview.commit.canCommit, true);
  assert.equal(resumed.pending[0].writePreview.commit.canUndo, false);
  assert.match(resumed.pending[0].writePreview.entries[0], /字段：content/);
  console.log('ok - agent center view summarizes write preview tools and commit readiness');
}
