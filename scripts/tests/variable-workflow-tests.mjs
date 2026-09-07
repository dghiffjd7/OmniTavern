import assert from 'node:assert/strict';
import { resolveVariableWorkflowActivity as activity, createVariableWorkflowResolver, collectVariableWorkflowPromptSources, collectVariableWorkflowPresetSources } from '../../src/scripts/ui/chat/variable-workflow-utils.js';
globalThis.localStorage ||= { getItem: () => null };
const { VariableRuleEngine } = await import('../../src/scripts/variables/variable-rule-engine.js');

const card = { source: { type: 'character_card', mvuConverted: true, mvuSource: 'zod' } };
const displayRule = { markdownOnly: true, placement: [2], findRegex: '<StatusPlaceHolderImpl/>' };
const native = { variables: { 好感度: 0 }, schemas: { 好感度: { type: 'number', ui: { display: 'progress' } } }, rules: [{ enabled: true, trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: '好感度', prompt: 'Return affinity change' } }] };

assert.equal(activity({ runtimeEnabled: true }).reason, 'no_variables');
assert.equal(activity({ persona: card, regexRules: [displayRule], variables: { stat_data: {} }, schemas: { stat_data: { type: 'object', default: {} } } }).enabled, false, 'an empty MVU container/placeholder is not an active variable task');
assert.equal(activity({ variables: { score: 0 }, schemas: { score: { type: 'number' } } }).reason, 'no_variable_updates', 'data without an update request remains inactive');
const st = activity({ persona: card, variables: { score: 0, flag: false }, regexRules: [displayRule], promptSources: ['Output <UpdateVariable> changes'] });
assert(st.enabled && st.hasPlaceholder); assert.deepEqual(st.kinds, ['st']); assert.equal(st.variableCount, 2);
assert.deepEqual(st.updateModes, ['inline']); assert(st.effects.includes('display'));
assert.equal(activity({ persona: { source: { type: 'character_card' } }, variables: { score: 1 }, regexRules: [displayRule] }).enabled, false, 'display-only regex does not establish an update contract');
assert.equal(activity({ persona: card, variables: { score: 1 }, regexRules: [displayRule] }).enabled, false, 'MVU conversion only imports values/schema; it does not add update instructions');
assert.deepEqual(activity({ persona: card, variables: { score: 1 }, regexRules: [displayRule] }).kinds, ['st']);
assert.deepEqual(activity({ variables: { score: 1 } }).kinds, ['app'], 'source remains identifiable even without an active update route');
const legacy = activity({ persona: { source: { type: 'character_card' } }, variables: { score: 0 }, promptSources: ['Return <UpdateVariable>_.set("score", 2)</UpdateVariable>'] });
assert(legacy.enabled); assert.deepEqual(legacy.kinds, ['st']);
const app = activity(native); assert(app.enabled); assert.deepEqual(app.kinds, ['app']); assert.deepEqual(app.updateModes, ['model_rule']);
assert(app.effects.includes('display'));
assert.equal(activity({ ...native, rules: [{ ...native.rules[0], action: { ...native.rules[0].action, type: ' AI_EVALUATE ' } }] }).enabled, true, 'normalization matches the real rule engine');
for (const trigger of [{ type: 'condition', expr: 'Math.random() > 0' }, { type: 'keyword', keywords: ['', ' '] }, { type: 'every_n_turns' }]) {
  assert.equal(activity({ ...native, rules: [{ ...native.rules[0], trigger }] }).enabled, false, 'unexecutable triggers do not establish a model update route');
}
for (const rules of [[], [{ ...native.rules[0], enabled: false }], [{ ...native.rules[0], trigger: { type: 'manual' } }], [{ ...native.rules[0], action: { ...native.rules[0].action, target: 'missing' } }]]) {
  assert.equal(activity({ ...native, rules }).enabled, false, 'only automatic requests with a real variable target count');
}
assert.equal(activity({ ...native, rules: [{ ...native.rules[0], action: { type: 'increment', target: '好感度', value: 1 } }] }).enabled, false, 'local-only changes do not advertise a model variable task');
assert.equal(activity({ ...native, runtimeEnabled: false }).reason, 'variable_runtime_disabled');
assert.equal(activity({ ...native, stageSchema: { stages: [{ condition: '好感度 > 5', prompt: 'Close relationship' }] } }).effects.includes('stage'), true);
assert.deepEqual(collectVariableWorkflowPromptSources([{ entries: { one: { content: 'keep' }, two: { content: 'disabled', disable: true } } }]), ['keep']);
const presetSources = collectVariableWorkflowPresetSources({ sysprompt: { content: '<UpdateVariable>', dialogue_enabled: false, dialogue_rules: 'disabled dialogue' }, openai: {
  prompts: [{ identifier: 'main', content: '' }, { identifier: 'paused', content: 'disabled update' }, { identifier: 'unused', content: 'unselected update' }],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main' }, { identifier: 'paused', enabled: false }] }],
} });
assert.deepEqual(presetSources, ['<UpdateVariable>']);
assert(activity({ persona: card, variables: { score: 0 }, promptSources: presetSources }).enabled, 'imported system prompts can supply the real update contract');
const emptyCardResolver = createVariableWorkflowResolver({ chatStore: { listGlobalVariables: () => ({ score: 100 }), listVariables: () => ({}) }, getEffectivePersona: () => card, listActiveRegexRules: () => [displayRule] });
assert.equal(emptyCardResolver('empty').enabled, false, 'another character/global variable pool does not activate an empty character');

let calls = 0, value = 0;
const engine = new VariableRuleEngine({
  chatStore: { listVariableRules: () => native.rules, listVariables: () => ({ 好感度: value }), setVariable: (target, next, sid) => { assert.equal(target, '好感度'); assert.equal(sid, 'own'); value = next; } },
  appBridge: { buildMessages() {}, backgroundChat: async () => { calls++; return '3'; } },
});
await engine.handleAfterReceive({ sessionId: 'own', message: { role: 'assistant', content: 'hello' } });
assert.equal(calls, 1); assert.equal(value, 3, 'the advertised native update route actually requests a model and changes the variable');
console.log('ok - empty/ST/native variable capability, request/effect evidence, scope and native update execution');
