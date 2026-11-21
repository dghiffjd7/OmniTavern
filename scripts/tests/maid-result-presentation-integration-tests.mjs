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
// 11/21 起世界书比较报告是模型自己调用的工具（worldbook.compare_entries），读完世界书后的最终回复照模型原文；
// 同名联系人比较后的删除提醒（只看结构）仍由 APP 加在模型原文前。
for (const transport of ['provider_fc', 'prompted_json']) for (const scenario of ['worldbook', 'session']) {
  test(`${transport}: ${scenario} final reply ${scenario === 'session' ? 'gets the APP deletion notice' : 'stays the model draft'} without extra calls`, async () => {
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
        // 按模型第几次决定对应录下来的读取：内容仍在已读记录里的重读不会走到工具
        const observed = reads[requests.length - 1];
        assert.equal(name, observed.toolName);
        assert.deepEqual(args, observed.args);
        executed.push({ name, args });
        return structuredClone(observed.output);
      } });
    const config = { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' };
    const client = { async chat(messages, options) {
      requests.push(messages);
      const read = reads[requests.length - 1];
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
    const answeredFromLedger = result.steps.filter(step => step.output?.alreadyRead).map(step => step.index);
    // 录下的 Gemini 那轮第 5、6 步只改 maxEntries 又读了一遍两本书，正文都还在已读记录里
    assert.deepEqual(answeredFromLedger, scenario === 'worldbook' ? [3, 4] : []);
    assert.equal(executed.length + answeredFromLedger.length, reads.length, 'presentation adds no tool call or write');
    assert.equal(requests.length, reads.length + 1, 'presentation adds no model call');
    assert.equal(result.finalDecision.message, draft, 'raw model output remains available for diagnosis/scoring');
    assert.equal(result.finalDecision.source, transport === 'provider_fc' ? 'maid_provider_fc' : 'model_react');
    const run = store.listRuns({ kind: 'maid_assistant' })[0];
    if (scenario === 'worldbook') {
      assert.equal(result.appPresentation, undefined);
      assert.equal(result.message, worldDraft);
    } else {
      assert.ok(result.appPresentation, 'terminal output must apply the APP deletion notice');
      assert.equal(result.appPresentation.modelMessage, draft);
      assert.match(result.message, /APP/);
      assert.ok(result.message.endsWith(sessionDraft));
      assert.match(result.message, /丢失其聊天记录/);
      assert.match(result.message, /真实确认/);
      assert.ok(run.summary.startsWith('APP'), 'tracker must persist the APP notice instead of the original draft');
    }
    assert.equal(result.pendingWorkflow, undefined);
    assert.equal(result.pendingAction, undefined);
  });
}
