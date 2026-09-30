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

const controller = new AbortController(); controller.abort();
const aborted = createMaidModelBackedReActPlanner({
  resolveRuntimeConfig: async () => ({ client: { chat: async () => { throw new DOMException('Aborted', 'AbortError'); } } }), logger,
});
await assert.rejects(() => aborted('Continue', { signal: controller.signal }), /Aborted/);
console.log('ok - user cancellation remains cancellation instead of resumable network failure');
