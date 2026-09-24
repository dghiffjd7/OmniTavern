import assert from 'node:assert/strict';

import { buildMaidModelReActMessages } from '../../src/scripts/agent/maid-model-planner.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAppUiCaptureTools } from '../../src/scripts/agent/tools/app-ui-capture-tools.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';

const getTool = (tools, name) => tools.find(tool => tool.name === name);

{
  const captured = [];
  const attachments = [];
  const tools = createAppUiCaptureTools({
    checkVisionSupport: async ({ context }) => {
      assert.equal(context.voiceCallId, 'voice-call');
      assert.equal(context.sessionId, 'captured-room');
      return { ok: true, capability: { status: 'supported' } };
    },
    captureRegion: async payload => {
      captured.push(payload);
      return {
        dataUrl: 'data:image/png;base64,QUJDRA==',
        mime: 'image/png',
        width: 240,
        height: 120,
        bytes: 4,
      };
    },
    now: () => 1000,
  });
  const tool = getTool(tools, 'ui.capture_region');
  assert.ok(tool);
  let resolveCalls = 0;
  const context = {
    voiceCallId: 'voice-call', sessionId: 'captured-room',
    userSelection: [{
      regionId: 'region-1',
      semanticSummary: '屏幕选区（160×80）',
      viewportRect: { left: 20, top: 30, width: 160, height: 80 },
    }],
    maidAttachments: attachments,
    resolveMaidSelectionRegion: async () => {
      resolveCalls += 1;
      return {
        ok: true,
        rect: { left: resolveCalls === 1 ? 20 : 24, top: 30, width: 160, height: 80 },
        semanticSummary: '屏幕选区（160×80）',
      };
    },
  };
  const result = await tool.execute({ regionId: 'region-1' }, context);
  assert.equal(result.ok, true);
  assert.equal(result.regionId, 'region-1');
  assert.equal(result.attachmentId, 'capture-region-1-1000');
  assert.equal(JSON.stringify(result).includes('base64'), false, 'tool output must not expose image bytes');
  assert.equal(resolveCalls, 2, 'vision gate 后应重新解析 live region');
  assert.deepEqual(captured[0].rect, { left: 24, top: 30, width: 160, height: 80 });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].llmUrl, 'data:image/png;base64,QUJDRA==');

  const messages = buildMaidModelReActMessages({
    input: '看看这里为什么错位',
    context,
    steps: [{ toolName: 'ui.capture_region', status: 'succeeded', summary: 'captured' }],
  });
  const imageParts = Array.isArray(messages[1].content)
    ? messages[1].content.filter(part => part?.type === 'image_url')
    : [];
  assert.equal(imageParts.length, 1, 'captured region should be visible to the next ReAct turn');
  console.log('ok - ui.capture_region injects a private screenshot attachment into the same maid run');
}

{
  let captureIndex = 0;
  const attachments = [{
    id: 'user-image',
    kind: 'image',
    llmUrl: `data:image/png;base64,${'U'.repeat(60_000)}`,
  }];
  const tool = getTool(createAppUiCaptureTools({
    maxRunImageChars: 100_000,
    captureRegion: async () => ({
      dataUrl: `data:image/png;base64,${'S'.repeat(50_000)}`,
      mime: 'image/png',
      bytes: 10,
    }),
  }), 'ui.capture_region');
  const overBudget = await tool.execute({ regionId: 'r-budget' }, {
    userSelection: [{
      regionId: 'r-budget',
      viewportRect: { left: 0, top: 0, width: 20, height: 20 },
    }],
    maidAttachments: attachments,
  });
  assert.equal(overBudget.ok, false);
  assert.equal(overBudget.reason, 'capture_run_image_budget_exceeded');
  assert.equal(attachments.length, 1, '超预算失败不得部分写入截图附件');

  const rotatingAttachments = [];
  const rotatingTool = getTool(createAppUiCaptureTools({
    maxRunCaptures: 2,
    captureRegion: async () => {
      captureIndex += 1;
      return {
        dataUrl: `data:image/png;base64,${captureIndex}`,
        mime: 'image/png',
        bytes: 1,
      };
    },
  }), 'ui.capture_region');
  for (const regionId of ['r1', 'r2', 'r3']) {
    const result = await rotatingTool.execute({ regionId }, {
      userSelection: [{ regionId, viewportRect: { left: 0, top: 0, width: 20, height: 20 } }],
      maidAttachments: rotatingAttachments,
    });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(rotatingAttachments.map(item => item.regionId), ['r2', 'r3']);
  console.log('ok - ui.capture_region enforces the total image budget and screenshot rotation limit');
}

{
  let captures = 0;
  const tool = getTool(createAppUiCaptureTools({
    checkVisionSupport: async () => ({
      ok: false,
      capability: { status: 'unsupported' },
      message: '当前女仆模型不支持图片输入。',
    }),
    captureRegion: async () => {
      captures += 1;
      return {};
    },
  }), 'ui.capture_region');
  const result = await tool.execute({ regionId: 'r1' }, {
    userSelection: [{ regionId: 'r1', viewportRect: { left: 0, top: 0, width: 20, height: 20 } }],
    maidAttachments: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'maid_vision_not_supported');
  assert.equal(captures, 0);
  console.log('ok - ui.capture_region checks maid vision support before capturing pixels');
}

{
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  registry.registerMany(createAppUiCaptureTools({
    checkVisionSupport: async () => ({ ok: true }),
    captureRegion: async () => ({
      dataUrl: 'data:image/png;base64,VEVTVA==',
      mime: 'image/png',
      width: 80,
      height: 40,
      bytes: 4,
    }),
  }));
  const store = new AgentRunStore();
  const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger: { warn() {} } });
  const sourceAttachments = [];
  let reactCalls = 0;
  const agent = createMaidAssistantAgent({
    planner: async () => ({
      ok: true,
      action: 'tool',
      featureId: 'app.ui.capture_region',
      toolName: 'ui.capture_region',
      args: { regionId: 'r-e2e' },
      title: '查看选区截图',
      response: '我先查看选区截图。',
    }),
    reactPlanner: async (input, context) => {
      reactCalls += 1;
      assert.equal(context.maidAttachments.length, 1);
      const messages = buildMaidModelReActMessages({ input, context, steps: context.maidReactSteps });
      const imageParts = messages.flatMap(message => (
        Array.isArray(message?.content) ? message.content.filter(part => part?.type === 'image_url') : []
      ));
      assert.equal(imageParts.length, 1, '真实 Agent→Runtime→Registry 链应把截图送入下一轮 ReAct');
      return { ok: true, action: 'final', message: '已根据截图完成视觉检查。' };
    },
    agentTaskRuntime: runtime,
    logger: { warn() {} },
  });
  const result = await agent.runPrompt('看看这里的视觉效果', {
    sessionId: 's-e2e',
    userSelection: [{
      regionId: 'r-e2e',
      semanticSummary: '屏幕选区',
      viewportRect: { left: 10, top: 20, width: 80, height: 40 },
    }],
    maidAttachments: sourceAttachments,
    resolveMaidSelectionRegion: async () => ({
      ok: true,
      regionId: 'r-e2e',
      rect: { left: 10, top: 20, width: 80, height: 40 },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(reactCalls, 1);
  assert.equal(sourceAttachments.length, 0, '截图附件不得回写输入框附件数组');
  const run = store.listRuns({ kind: 'maid_assistant' })[0];
  assert.equal(run.steps.length, 1);
  assert.equal(JSON.stringify(run).includes('data:image'), false, '持久 run 不得保存截图 base64');
  console.log('ok - ui.capture_region survives the full Agent runtime chain without cross-run persistence');
}

{
  const registry = createAgentToolRegistry({
    permissionEvaluator: { evaluateTool: () => ({ decision: 'allow', checks: [] }) },
    logger: { warn() {} },
  });
  registry.registerMany(createAppUiCaptureTools({ captureRegion: async () => ({}) }));
  await assert.rejects(
    registry.executeTool('ui.capture_region', {}),
    error => error?.code === 'agent_tool_args_invalid' && /regionId is required/.test(error.message),
  );
  await assert.rejects(
    registry.executeTool('ui.capture_region', { regionId: 'r1', x: 10, y: 20 }),
    error => error?.code === 'agent_tool_args_invalid' && /args.x is not allowed/.test(error.message),
  );
  console.log('ok - ui.capture_region registry contract rejects missing IDs and model coordinates');
}

{
  const tool = getTool(createAppUiCaptureTools({ captureRegion: async () => ({}) }), 'ui.capture_region');
  const missing = await tool.execute({}, { userSelection: [], maidAttachments: [] });
  assert.equal(missing.reason, 'selection_region_missing');
  const ambiguous = await tool.execute({}, {
    userSelection: [
      { regionId: 'r1', viewportRect: { left: 0, top: 0, width: 20, height: 20 } },
      { regionId: 'r2', viewportRect: { left: 30, top: 0, width: 20, height: 20 } },
    ],
    maidAttachments: [],
  });
  assert.equal(ambiguous.reason, 'selection_region_ambiguous');
  assert.deepEqual(ambiguous.availableRegions.map(item => item.regionId), ['r1', 'r2']);
  console.log('ok - ui.capture_region requires an unambiguous selected region');
}

console.log('app-ui-capture-tools-tests passed');
