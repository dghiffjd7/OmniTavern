import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMaidProviderFcToolPlan, normalizeMaidProviderFcCompletedCalls, runMaidProviderFcAttempt } from '../../src/scripts/agent/maid-provider-fc-planner.js';

// Captured failure shape: a write feature exposes its prerequisite list tool
// before the list capability. Keep the fixture independent of catalog cleanup.
const readSchema = { type: 'object', additionalProperties: false, properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } } };
const providers = {
  gemini: { provider: 'makersuite', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com' },
  deepseek: { provider: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' },
};
const featurePair = toolName => {
  const writeId = toolName === 'session.list' ? 'session.create' : 'worldbook.bind_persona';
  const read = { id: toolName, title: `Read ${toolName}`, summary: 'Read saved resource summaries.', argsHint: 'limit is optional.', writes: false, tools: [toolName], toolSchemas: { [toolName]: readSchema } };
  const write = { id: writeId, title: `Write ${writeId}`, summary: 'Create or bind a resource.', argsHint: 'Supply the write target.', writes: true, tools: [writeId, toolName], toolSchemas: { [toolName]: readSchema, [writeId]: { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false } } };
  return { write, read };
};
const declarations = options => {
  const result = [];
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.name === 'string' && typeof value.description === 'string') result.push(value);
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child);
  };
  walk(options.tools);
  return result;
};

for (const [provider, config] of Object.entries(providers)) test(`${provider}: actual FC declaration and delta choose the offered read owner in either order`, async () => {
  for (const toolName of ['session.list', 'worldbook.list']) {
    const { write, read } = featurePair(toolName);
    for (const features of [[write, read], [read, write]]) {
      let offered;
      const result = await runMaidProviderFcAttempt({
        config, capabilitySnapshot: { id: 'shared-list-owner', useCandidates: true, candidateFeatures: features },
        experimentStatus: { enabled: true }, messages: [{ role: 'user', content: 'Read the list.' }],
        client: { async chat(_messages, options) {
          offered = declarations(options).find(tool => tool.name === toolName.replaceAll('.', '_'));
          const name = toolName.replaceAll('.', '_'), args = { limit: 20 };
          const delta = provider === 'gemini'
            ? { candidates: [{ content: { parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP' }] }
            : { output: [{ type: 'function_call', id: 'read-owner-item', call_id: 'read-owner-call', name, arguments: JSON.stringify(args) }] };
          options.onProviderToolCallDelta(delta, { provider: config.provider, model: config.model });
          return '';
        } },
      });
      assert.equal(result.ok, true, result.reason);
      assert.equal(result.selection.featureId, read.id, 'candidate registration order must not turn a list into a write capability');
      assert.equal(result.selection.title, read.title);
      assert.ok(offered.description.includes(`APP capability: ${read.id};`));
      assert.ok(!offered.description.includes(write.summary));
      assert.deepEqual(result.selection.args, { limit: 20 });
    }
  }
});

test('offered read-only owner wins over a write feature even when its id differs from tool name', () => {
  const { write, read } = featurePair('session.list');
  const alias = { ...read, id: 'session.inventory' };
  const plan = buildMaidProviderFcToolPlan({ config: providers.deepseek, features: [write, alias] });
  assert.equal(plan.toolMappings.find(tool => tool.internalName === 'session.list').featureId, alias.id);
});

test('missing read owner keeps its offered authority but describes only the auxiliary read', () => {
  const { write, read } = featurePair('session.list');
  const plan = buildMaidProviderFcToolPlan({ config: providers.deepseek, features: [write] });
  const mapping = plan.toolMappings.find(tool => tool.internalName === 'session.list');
  assert.equal(mapping.featureId, write.id, 'do not authorize a catalog owner absent from this offered snapshot');
  assert.notEqual(mapping.title, write.title);
  assert.ok(!mapping.description.includes(write.summary));
  assert.match(mapping.description, /read-only/i);
  assert.ok(!plan.toolMappings.some(tool => tool.featureId === read.id));
  assert.deepEqual(plan.toolMappings.filter(tool => !tool.control).map(tool => tool.internalName).sort(), write.tools.slice().sort());
});

test('owner preference does not weaken schema checks or admit unoffered tools', () => {
  const { write, read } = featurePair('session.list');
  const plan = buildMaidProviderFcToolPlan({ config: providers.deepseek, features: [write, read] });
  const normalize = (toolName, args) => normalizeMaidProviderFcCompletedCalls({ toolPlan: plan, completedToolCalls: [{ toolName, arguments: args }] });
  assert.equal(normalize('session_list', { limit: 'all' }).reason, 'invalid_tool_arguments');
  assert.equal(normalize('worldbook_list', {}).reason, 'unknown_tool');
  assert.equal(normalize('session_create', {}).reason, 'invalid_tool_arguments');
  assert.equal(normalize('session_create', { name: 'Allowed explicit creation' }).selection.featureId, write.id);
});

test('a prerequisite read uses its own description even under a read-only workflow guide', () => {
  const feature={id:'session.compare',title:'Compare duplicate contacts',summary:'Propose deletions only after comparison.',
    writes:false,riskLevel:'low',tools:['session.list'],toolSchemas:{'session.list':readSchema},
    toolMetadata:{'session.list':{title:'List contacts',description:'List scoped contacts with pagination and avatar filtering.'}}};
  const mapping=buildMaidProviderFcToolPlan({config:providers.deepseek,features:[feature]}).toolMappings[0];
  assert.equal(mapping.featureId,'session.compare','keep the authority of the actually offered feature');
  assert.match(mapping.description,/pagination and avatar filtering/);
  assert.doesNotMatch(mapping.description,/Propose deletions|Compare duplicate/);
});

test('public feature help retains its generic owner instead of an unrelated manual guide', () => {
  const schema={type:'object',properties:{featureId:{type:'string'}},required:['featureId']};
  const generic={id:'app.capabilities.search',writes:false,riskLevel:'low',directAction:'app.search_feature',
    title:'Capability discovery',tools:['app.read_feature_doc'],toolSchemas:{'app.read_feature_doc':schema}};
  const guide={...generic,id:'chat.export.help',directAction:'app.read_feature_doc',title:'Manual chat export',summary:'Cannot directly export a chat.'};
  const mapping=buildMaidProviderFcToolPlan({config:providers.deepseek,features:[guide,generic]}).toolMappings[0];
  assert.equal(mapping.featureId,generic.id);
  assert.doesNotMatch(mapping.description,/Manual chat export|Cannot directly export/);
});

test('a shared panel tool is attributed to the offered owner whose panel the call opens', () => {
  // app.open_panel 只提供一次；归属决定首次引导与能力记录，必须跟着 args.panel 走，不能按 id 排序固定给第一个
  const panelSchema = { type: 'object', additionalProperties: false, properties: { panel: { type: 'string' }, focus: { type: 'string' } } };
  const owner = (id, title, panel, directAction = 'app.open_panel') => ({
    id, title, panel, directAction, summary: `Open ${panel}.`, writes: false, riskLevel: 'low',
    tools: ['app.open_panel'], toolSchemas: { 'app.open_panel': panelSchema },
  });
  const features = [
    owner('memory.open', '打开记忆表格', 'memory'),
    owner('agent.center.open', '打开 Agent Center', 'agent-center'),
    owner('config.api.open', '打开 API 配置', 'config'),
    owner('creative.body_tool_transport', '防截断传输', 'agent-center', ''),
  ];
  const plan = buildMaidProviderFcToolPlan({ config: providers.deepseek, features });
  assert.equal(plan.ok, true, plan.reason);
  const select = args => normalizeMaidProviderFcCompletedCalls({
    toolPlan: plan, completedToolCalls: [{ toolName: 'app_open_panel', arguments: args }],
  }).selection;
  assert.equal(select({ panel: 'config' }).featureId, 'config.api.open');
  assert.equal(select({ panel: 'config' }).title, '打开 API 配置');
  assert.equal(select({ panel: 'memory' }).featureId, 'memory.open');
  assert.equal(select({ panel: 'agent-center' }).featureId, 'agent.center.open', 'two owners of one panel keep the default owner');
  assert.equal(select({ panel: 'unknown' }).featureId, 'agent.center.open');
  assert.equal(select({}).featureId, 'agent.center.open');
});
