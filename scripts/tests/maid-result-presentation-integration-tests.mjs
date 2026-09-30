import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createAgentToolRegistry } from '../../src/scripts/agent/agent-tool-registry.js';
import { createAgentTaskRuntime } from '../../src/scripts/agent/agent-task-runtime.js';
import { AgentRunStore } from '../../src/scripts/storage/agent-run-store.js';
import { createMaidAssistantAgent } from '../../src/scripts/agent/maid-assistant-agent.js';
import { createMaidModelBackedPlanner, createMaidModelBackedReActPlanner } from '../../src/scripts/agent/maid-model-planner.js';
import { listAppFeatures } from '../../src/scripts/agent/app-feature-catalog.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/maid-worldbook-comparison-observations.json', import.meta.url)));
const worldReads = fixture.cases[0].steps.filter(step => step.toolName === 'worldbook.read')
  .map(({ outputRef, ...step }) => ({ ...step, output: fixture.snapshots[outputRef] }));
const worldDraft = '原版旅行者公会是木徽升铜徽再升银徽。';
const sessionDraft = '三个联系人的描述不同，建议保留原始小雪，请选择要保留的版本。';
const contacts = [{ id: 'snow-original', name: '小雪' }, { id: 'snow-copy', name: '小雪(1)' }];
const sessionReads = [
  { toolName: 'session.list', args: {}, output: { count: 2, contacts } },
  ...contacts.map((item, index) => ({ toolName: 'app.read_resource', args: { resource: 'session', sessionId: item.id, include: ['description'] },
    output: { ok: true, resource: 'session', sessions: [{ ...item, messageCount: 2 - index, description: `distinct description ${index}` }] } })),
];

// Exercise real normalization, registry execution and terminal persistence with
// fixed model responses. Network/model retries cannot hide the two regressions.
for (const transport of ['provider_fc', 'prompted_json']) for (const scenario of ['worldbook', 'session']) {
  test(`${transport}: ${scenario} APP presentation is published while the model draft stays unchanged`, async () => {
    const reads = scenario === 'worldbook' ? worldReads : sessionReads;
    const draft = scenario === 'worldbook' ? worldDraft : sessionDraft;
    const input = scenario === 'worldbook' ? '把奇幻大陆的副本合并回去' : '把重复的小雪删掉只留一个';
    const featureId = scenario === 'worldbook' ? 'worldbook.read' : 'session.compare';
    const toolNames = [...new Set(reads.map(step => step.toolName))];
    const schemas = Object.fromEntries(toolNames.map(name => [name, { type: 'object', properties: {}, additionalProperties: true }]));
    const feature = { ...listAppFeatures().find(item => item.id === featureId), tools: toolNames, toolSchemas: schemas };
    const logger = { debug() {}, warn() {} };
    const executed = [], requests = [];
    const registry = createAgentToolRegistry({ logger });
    for (const name of toolNames) registry.register({ name, schema: schemas[name], riskLevel: 'low', permissions: [],
      capabilities: { read: true, write: false, network: false }, execute: async args => {
        const observed = reads[executed.length];
        assert.equal(name, observed.toolName);
        assert.deepEqual(args, observed.args);
        executed.push({ name, args });
        return structuredClone(observed.output);
      } });
    const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
    const client = { async chat(messages, options) {
      requests.push(messages);
      const read = reads[executed.length];
      if (!options.tools?.length) return JSON.stringify(read
        ? { ok: true, action: 'tool', toolName: read.toolName, featureId, args: read.args }
        : { ok: true, action: 'final', message: draft });
      options.onProviderToolCallDelta({ output: [{ type: 'function_call', id: `call-${requests.length}`, call_id: `call-${requests.length}`,
        name: read ? read.toolName.replaceAll('.', '_') : 'maid_planner_control',
        arguments: JSON.stringify(read ? read.args : { action: 'final', message: draft }),
      }] }, { provider: config.provider, model: config.model });
      return '';
    } };
    const deps = { features: [feature], resolveRuntimeConfig: async () => ({ config, client }),
      getProviderFcExperimentStatus: () => ({ enabled: transport === 'provider_fc' }), logger };
    const store = new AgentRunStore();
    const runtime = createAgentTaskRuntime({ store, toolRegistry: registry, logger });
    const agent = createMaidAssistantAgent({ toolRegistry: registry, agentTaskRuntime: runtime,
      planner: createMaidModelBackedPlanner(deps), reactPlanner: createMaidModelBackedReActPlanner(deps), maxReactSteps: 8, logger });
    const roleCardId = scenario === 'worldbook' ? worldReads[0].output.targetSelectionEvidence.currentCard.personaId : 'card';
    const result = await agent.runPrompt(input, { roleCardId, submissionId: `${transport}-${scenario}`, uiMode: 'chat',
      capabilitySnapshot: { id: 'presentation-contract', useCandidates: true, candidateFeatures: [feature], promptFeatures: [feature] } });
    assert.equal(result.ok, true);
    assert.equal(executed.length, reads.length, 'presentation adds no tool call or write');
    assert.equal(requests.length, reads.length + 1, 'presentation adds no model call');
    assert.equal(result.finalDecision.message, draft, 'raw model output remains available for diagnosis/scoring');
    assert.equal(result.finalDecision.source, transport === 'provider_fc' ? 'maid_provider_fc' : 'model_react');
    assert.ok(result.appPresentation, 'terminal output must apply the APP presentation');
    assert.equal(result.appPresentation.modelMessage, draft);
    assert.match(result.message, /APP/);
    if (scenario === 'worldbook') {
      assert.ok(!result.message.includes(worldDraft), 'known cross-book paraphrase must not remain in the visible facts');
      const sourceBodies = [...new Map(worldReads.flatMap(step => step.output.entries
        .filter(entry => typeof entry.content === 'string' && /旅行者公会|北境霜城/u.test(entry.title))
        .map(entry => [`${step.output.id}:${entry.id}`, entry]))).values()];
      assert.equal(sourceBodies.length, 4);
      for (const entry of sourceBodies) assert.ok(result.message.includes(entry.content), `Missing original: ${entry.content}\nVisible result: ${result.message}`);
    } else {
      assert.ok(result.message.endsWith(sessionDraft));
      assert.match(result.message, /丢失其聊天记录/);
      assert.match(result.message, /真实确认/);
    }
    assert.equal(result.pendingWorkflow, undefined);
    assert.equal(result.pendingAction, undefined);
    const run = store.listRuns({ kind: 'maid_assistant' })[0];
    assert.ok(run.summary.startsWith('APP'), 'tracker must persist the APP presentation instead of the original draft');
  });
}
