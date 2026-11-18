import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  buildMaidProviderFcToolPlan,
  normalizeMaidProviderFcCompletedCalls,
  MAID_PROVIDER_FC_CONTROL_TOOL_NAME,
  MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH,
} from '../../src/scripts/agent/maid-provider-fc-planner.js';
import { createMaidModelBackedReActPlanner } from '../../src/scripts/agent/maid-model-planner.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/maid-provider-fc-control-reason.json', import.meta.url), 'utf8'));
const feature = {
  id: 'session.list', title: 'Read sessions', tools: ['session.list'], writes: false,
  toolSchemas: { 'session.list': {
    type: 'object', additionalProperties: false,
    properties: { reason: { type: 'string', maxLength: 120 } },
  } },
};
const snapshot = { id: 'control-reason-regression', useCandidates: true,
  candidateFeatures: [feature], promptFeatures: [feature] };
const plan = buildMaidProviderFcToolPlan({ config: fixture.config, features: [feature], phase: 'react' });
const normalize = (args, { name = MAID_PROVIDER_FC_CONTROL_TOOL_NAME, stream = false } = {}) => {
  const call = { toolName: name, arguments: structuredClone(args),
    ...(stream ? { metadata: { streamingArgumentsText: JSON.stringify(args) } } : {}) };
  const original = structuredClone(call);
  const result = normalizeMaidProviderFcCompletedCalls({ toolPlan: plan, completedToolCalls: [call], phase: 'react' });
  assert.deepEqual(call, original, 'raw completed call is preserved for audit');
  return result;
};

test('captured Gemini clarification crosses delta accumulator and real ReAct planner without JSON fallback', async () => {
  assert.equal(fixture.functionCall.args.reason.length, 127);
  let calls = 0;
  const usage = [];
  const original = structuredClone(fixture.functionCall);
  const client = { async chat(_messages, options) {
    calls++;
    assert.equal(calls, 1, 'valid control must not request a second JSON completion');
    const control = options.tools[0].functionDeclarations.find(tool => tool.name === MAID_PROVIDER_FC_CONTROL_TOOL_NAME);
    assert.equal(control.parameters.properties.reason.maxLength, undefined,
      'Gemini transport omits this local bound, matching the captured offered schema');
    options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: fixture.functionCall }] }, finishReason: 'STOP' }] }, fixture.config);
    return '';
  } };
  const react = createMaidModelBackedReActPlanner({ features: [feature],
    resolveRuntimeConfig: async () => ({ config: fixture.config, client }),
    getProviderFcExperimentStatus: () => ({ enabled: true }), logger: { warn() {}, debug() {} } });
  const decision = await react('Clarify the target before changing the setting.', {
    capabilitySnapshot: snapshot, sessionId: 'control-reason-test', uiMode: 'chat',
    onModelUsage: value => usage.push(value), maidReactSteps: [],
  });
  assert.equal(decision.ok, true, decision.reason);
  assert.equal(decision.providerFcControl, 'clarify');
  assert.equal(decision.message, fixture.functionCall.args.message, 'user-facing content is not shortened or rewritten');
  assert.equal(decision.reason, fixture.functionCall.args.reason.slice(0, 120).trim());
  assert.equal(decision.plannerTransport.effectiveMode, 'provider_fc');
  assert.equal(decision.plannerTransport.fallbackReason, '');
  assert.deepEqual(usage.filter(value => value.transport === 'provider_fc').map(value => value.outcome), ['ok']);
  assert.equal(calls, 1);
  assert.deepEqual(fixture.functionCall, original);
});

test('only control diagnostic strings are bounded at 120 and 121 chars without mutating completed calls', () => {
  for (const stream of [false, true]) for (const length of [120, 121]) {
    const args = { action: 'clarify', message: 'Choose the target.', reason: `  ${'r'.repeat(length)}  ` };
    const result = normalize(args, { stream });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.control.reason, 'r'.repeat(120));
    assert.equal(result.control.message, args.message);
  }
  assert.equal(normalize({ action: 'clarify', message: 'Choose the target.' }).ok, true);
});

test('non-string control reasons remain invalid rather than being coerced', () => {
  for (const reason of [null, false, 42, {}, []]) {
    const result = normalize({ action: 'clarify', message: 'Choose the target.', reason });
    assert.equal(result.ok, false, JSON.stringify(reason));
    assert.equal(result.reason, 'invalid_tool_arguments');
  }
});

test('long diagnostic reason does not relax action, message or unknown field validation', () => {
  const valid = { action: 'clarify', message: 'Choose the target.', reason: 'r'.repeat(121) };
  for (const override of [
    { action: 'execute' }, { action: 1 }, { message: '' }, { message: null },
    { message: 'm'.repeat(MAID_PROVIDER_FC_MESSAGE_MAX_LENGTH + 1) }, { extra: 'not allowed' },
  ]) {
    const result = normalize({ ...valid, ...override });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_tool_arguments');
  }
  for (const field of ['action', 'message']) {
    const args = { ...valid }; delete args[field];
    assert.equal(normalize(args).reason, 'invalid_tool_arguments');
  }
});

test('business arguments and tools outside the offered plan retain strict validation', () => {
  const name = plan.toolMappings.find(tool => !tool.control).providerName;
  assert.equal(normalize({ reason: 'r'.repeat(120) }, { name }).ok, true);
  const tooLong = normalize({ reason: 'r'.repeat(121) }, { name });
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.reason, 'invalid_tool_arguments');
  assert.equal(normalize({ action: 'clarify', message: 'Choose.', reason: 'r'.repeat(121) }, { name: 'unoffered_control' }).reason, 'unknown_tool');
});

test('clarify may carry choices: offered without length bounds, passed through and turned into one card on the decision', async () => {
  const control = plan.toolMappings.find(tool => tool.control);
  assert.equal(control.schema.properties.choices.type, 'array');
  assert.equal(control.schema.properties.choices.items.properties.question.maxLength, undefined, 'no bounds that would void the whole clarify');
  const choices = [{ question: 'Which book?', options: [{ label: 'Harbor' }, { label: 'Global', description: 'shared' }], recommended: 0 }];
  const normalized = normalize({ action: 'clarify', message: 'Which one?', choices });
  assert.equal(normalized.ok, true, normalized.reason);
  assert.deepEqual(normalized.control.choices, choices);
  // 校验宽松：多出的选项、长文字留给 APP 生成卡片时裁剪，不让整个反问作废
  assert.equal(normalize({ action: 'clarify', message: 'Which one?', choices: [{ question: 'q'.repeat(400), options: ['a', 'b', 'c', 'd', 'e'].map(label => ({ label: label.repeat(80) })) }] }).ok, true);

  const callArgs = { action: 'clarify', message: 'Which book should I change?', choices };
  const client = { async chat(_messages, options) {
    options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: { name: MAID_PROVIDER_FC_CONTROL_TOOL_NAME, args: callArgs } }] }, finishReason: 'STOP' }] }, fixture.config);
    return '';
  } };
  const react = createMaidModelBackedReActPlanner({ features: [feature],
    resolveRuntimeConfig: async () => ({ config: fixture.config, client }),
    getProviderFcExperimentStatus: () => ({ enabled: true }), logger: { warn() {}, debug() {} } });
  const decision = await react('Change the setting.', { capabilitySnapshot: snapshot, sessionId: 'choice-test', uiMode: 'chat', maidReactSteps: [] });
  assert.equal(decision.providerFcControl, 'clarify');
  assert.equal(decision.message, callArgs.message, 'the text question stays as the message');
  assert.equal(decision.choiceCard.type, 'choice');
  assert.deepEqual(decision.choiceCard.data.questions[0].options.map(option => option.label), ['Harbor', 'Global']);

  // final 附 choices 不出卡（只在停下反问时显示选项）
  const finalClient = { async chat(_messages, options) {
    options.onProviderToolCallDelta({ candidates: [{ content: { parts: [{ functionCall: { name: MAID_PROVIDER_FC_CONTROL_TOOL_NAME, args: { ...callArgs, action: 'final' } } }] }, finishReason: 'STOP' }] }, fixture.config);
    return '';
  } };
  const finalReact = createMaidModelBackedReActPlanner({ features: [feature],
    resolveRuntimeConfig: async () => ({ config: fixture.config, client: finalClient }),
    getProviderFcExperimentStatus: () => ({ enabled: true }), logger: { warn() {}, debug() {} } });
  const finalDecision = await finalReact('Change the setting.', { capabilitySnapshot: snapshot, sessionId: 'choice-final', uiMode: 'chat', maidReactSteps: [] });
  assert.equal(finalDecision.choiceCard, undefined);
});
