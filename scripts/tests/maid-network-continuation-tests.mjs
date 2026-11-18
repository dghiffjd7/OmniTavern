import assert from 'node:assert/strict';
import { createMaidModelBackedReActPlanner } from '../../src/scripts/agent/maid-model-planner.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';

const logger = { warn() {}, debug() {} };
const reactPlanner = createMaidModelBackedReActPlanner({
  resolveRuntimeConfig: async () => ({ client: { chat: async () => { throw new TypeError('Failed to fetch'); } } }),
  logger,
});
const decision = await reactPlanner('Continue the remaining work');
assert.equal(decision.reason, 'provider_request_failed');
assert.equal(decision.errorMessage, 'Failed to fetch');
const store = new AgentRunStore();
const registry = { executeTool: async toolName => ({ toolName, status: 'succeeded',
  result: { ok: true, panel: 'worldbook' }, summary: 'opened worldbook panel' }) };
const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger });
const agent = createMaidAssistantAgent({ agentTaskRuntime: runtime, toolRegistry: registry, logger,
  planner: async () => ({ ok: true, toolName: 'app.open_panel', featureId: 'worldbook.open', args: { panel: 'worldbook' } }),
  reactPlanner,
});
const result = await agent.runPrompt('先打开世界书面板，再继续完成配置');
assert.equal(result.ok, false);
assert.equal(result.continuable, true);
const run = store.listRuns().find(run => run.metadata?.continuable);
assert(run.metadata.continuationSnapshot.successfulSteps.some(step => step.toolName === 'app.open_panel'));
assert.equal(run.metadata.continuationSnapshot.sourceRunId, run.id);
console.log('ok - real planner request failure preserves completed steps in a resumable run');

// 报错原文原样交给界面并写进执行记录；续跑仍按 metadata.reason 判断中断原因
assert.equal(result.errorDetail, 'Failed to fetch');
assert.equal(run.errorMessage, 'Failed to fetch');
assert.equal(run.metadata.reason, 'provider_request_failed');
console.log('ok - the provider error text reaches the result and the run record verbatim');

{
  const longBody = `HTTP 400 ${JSON.stringify({ error: { message: 'x'.repeat(600) } })}`;
  const bothFail = createMaidModelBackedReActPlanner({
    resolveRuntimeConfig: async () => ({
      config: { provider: 'vertexai', model: 'gemini-a' },
      client: { chat: async () => { throw new Error('No candidates returned: PROHIBITED_CONTENT'); } },
      fallbackConfig: { provider: 'makersuite', model: 'gemini-b' },
      fallbackClient: { chat: async () => { throw new Error(longBody); } },
    }),
    logger,
  });
  const failed = await bothFail('Continue the remaining work');
  assert.equal(failed.reason, 'provider_request_failed');
  assert.equal(failed.errorMessage, [
    '主模型（vertexai / gemini-a）：No candidates returned: PROHIBITED_CONTENT',
    `备用配置（makersuite / gemini-b）：${longBody}`,
  ].join('\n'), 'both errors are kept untruncated, each labelled with the profile that raised it');
  console.log('ok - when the fallback also fails, the primary error is not hidden');
}

const controller = new AbortController(); controller.abort();
const aborted = createMaidModelBackedReActPlanner({
  resolveRuntimeConfig: async () => ({ client: { chat: async () => { throw new DOMException('Aborted', 'AbortError'); } } }), logger,
});
await assert.rejects(() => aborted('Continue', { signal: controller.signal }), /Aborted/);
console.log('ok - user cancellation remains cancellation instead of resumable network failure');
