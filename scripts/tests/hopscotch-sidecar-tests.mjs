import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHopscotchSidecarExecutors } from '../../src/scripts/ui/chat/hopscotch-sidecar-executors.js';
import { createHopscotchImageExecutor } from '../../src/scripts/ui/chat/hopscotch-image-executor.js';
import { createHopscotchExecutors } from '../../src/scripts/ui/chat/hopscotch-turn-runtime.js';
import { createCreativeTurnOrchestrator } from '../../src/scripts/ui/chat/creative-turn-orchestrator.js';
import { normalizeHopscotchBoard } from '../../src/scripts/ui/chat/hopscotch-board-utils.js';
globalThis.localStorage ||= { getItem: () => null };
const { VariableRuleEngine } = await import('../../src/scripts/variables/variable-rule-engine.js');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const fixture = () => {
  const f = { scope: 'one', exists: true, values: { score: 1 }, writes: 0, checkpoints: [], calls: [], enabled: true,
    message: { id: 'new-reply', role: 'assistant', content: 'The new body', rawOriginal: 'The new body', meta: {} }, rules: [] };
  f.deps = {
    sessionId: 'rp:sidecar', userInput: 'Continue', board: normalizeHopscotchBoard({ rows: [{ houses: [{ id: 'body', kind: 'body' }] }] }),
    runtimeConfig: { model: 'body-model' }, getTurnContext: () => ({ body: { messageId: 'new-reply' } }),
    backgroundChat: async (messages, options) => { f.calls.push({ messages, options }); return '<UpdateVariable>[{"op":"replace","path":"/score","value":4}]</UpdateVariable>'; },
    getMessage: mid => mid === f.message?.id ? f.message : null, getScope: () => f.scope, hasSession: () => f.exists,
    getVariables: () => f.values, getSchemas: () => ({ score: { type: 'number' } }), isVariableEnabled: () => f.enabled,
    promptSources: ['Use <UpdateVariable> to update score according to the story.'],
    applyVariables: commands => { f.writes++; assert.equal(commands[0].type, 'set'); f.values.score = commands[0].value; return true; },
    checkpointVariables: async mid => { f.checkpoints.push(mid); },
  };
  f.engine = new VariableRuleEngine({ chatStore: { listVariableRules: () => f.rules, listVariables: () => f.values, getMessages: () => [f.message], setVariable: (name, value) => { f.values[name] = value; f.writes++; } },
    appBridge: { buildMessages() {}, backgroundChat: async (_, options) => { f.calls.push({ options }); return '2'; } },
  });
  f.deps.ruleEngine = f.engine;
  return f;
};
const variable = { id: 'v', kind: 'variable' }, imagePrompt = { id: 'p', kind: 'image_prompt' };
{
  const f = fixture(); f.deps.imageEligibility = () => ({ ok: false, reason: 'cooldown-3' });
  assert.equal((await createHopscotchSidecarExecutors(f.deps).image_prompt.run({ house: imagePrompt })).reason, 'cooldown-3');
  assert.equal(f.calls.length, 0, 'cooldown also skips the independent prompt request');
}
{
  const f = fixture(), sidecars = createHopscotchSidecarExecutors(f.deps);
  const result = await sidecars.variable.run({ house: variable });
  assert.equal(result.status, 'succeeded'); assert.equal(f.values.score, 4); assert.equal(f.writes, 1);
  assert.deepEqual(f.checkpoints, ['new-reply']); assert.equal(f.calls[0].options.runtimeConfigOverride.model, 'body-model');
  assert(f.calls[0].messages[1].content.includes('The new body'));
}
for (const change of [f => { f.scope = 'different'; }, f => { f.exists = false; }, f => { f.message = null; }, f => { f.message.rawOriginal = 'edited'; }, f => { f.message.meta.activeSwipe = 1; }, f => { f.enabled = false; }]) {
  const f = fixture(), pending = deferred();
  f.deps.backgroundChat = () => pending.promise;
  const job = createHopscotchSidecarExecutors(f.deps).variable.run({ house: variable });
  await pause(); change(f); pending.resolve('<UpdateVariable>[{"op":"replace","path":"/score","value":4}]</UpdateVariable>');
  await assert.rejects(job, { name: 'AbortError' }); assert.equal(f.writes, 0); assert.equal(f.checkpoints.length, 0);
}
{
  const f = fixture(), pending = deferred(), controller = new AbortController();
  f.deps.backgroundChat = async (_, options) => { assert.equal(options.signal, controller.signal); return pending.promise; };
  const job = createHopscotchSidecarExecutors(f.deps).variable.run({ house: variable, signal: controller.signal });
  await pause(); controller.abort(); pending.resolve('<UpdateVariable>[]</UpdateVariable>');
  await assert.rejects(job, { name: 'AbortError' }); assert.equal(f.writes, 0);
}
{
  const f = fixture(); f.deps.backgroundChat = async () => { f.values.score = 9; return '<UpdateVariable>[{"op":"replace","path":"/score","value":4}]</UpdateVariable>'; };
  await assert.rejects(createHopscotchSidecarExecutors(f.deps).variable.run({ house: variable }), /变量/); assert.equal(f.writes, 0);
}
for (const response of ['hello', '</UpdateVariable>', '<UpdateVariable>invalid</UpdateVariable>', '<UpdateVariable>[{"op":"replace","path":"/score","value":4}]', '<UpdateVariable>[]</UpdateVariable><UpdateVariable>_.set("score", 8)']) {
  const f = fixture(); f.deps.backgroundChat = async () => response;
  await assert.rejects(createHopscotchSidecarExecutors(f.deps).variable.run({ house: variable })); assert.equal(f.writes, 0);
}
{
  const f = fixture(); f.deps.backgroundChat = async () => '<UpdateVariable>[]</UpdateVariable>';
  assert.equal((await createHopscotchSidecarExecutors(f.deps).variable.run({ house: variable })).artifact.payload.changed, false);
  assert.equal(f.writes, 0);
}
{
  const f = fixture(), pending = deferred();
  f.rules = [{ id: 'before', trigger: { type: 'keyword', keywords: ['Continue'] }, action: { type: 'ai_evaluate', target: 'score', prompt: 'delta' } },
    { id: 'after', trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: 'score', prompt: 'delta' } }];
  f.engine.appBridge.backgroundChat = async (_, options) => { f.calls.push(options); return pending.promise; };
  const sidecars = createHopscotchSidecarExecutors(f.deps), controller = new AbortController();
  const before = sidecars.variable_rules.run({ house: { config: { phase: 'before' } }, signal: controller.signal });
  await pause(); assert.equal(f.writes, 0); assert.equal(f.calls.length, 1);
  pending.resolve('2'); await before; assert.equal(f.values.score, 3);
  await sidecars.variable_rules.run({ house: { config: { phase: 'after' } }, signal: controller.signal });
  assert.equal(f.calls.length, 2); assert.equal(f.values.score, 5); assert.deepEqual(f.checkpoints, ['new-reply']);
  assert.equal(f.calls[0].runtimeConfigOverride.model, 'body-model');
  assert.equal(f.calls[0].signal, controller.signal);
}
{
  const f = fixture();
  f.rules = ['one', 'two'].map(id => ({ id, trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: 'score', prompt: 'delta' } }));
  let count = 0; f.engine.appBridge.backgroundChat = async () => ++count === 1 ? '2' : 'error 401';
  await assert.rejects(createHopscotchSidecarExecutors(f.deps).variable_rules.run({ house: { config: { phase: 'after' } } }));
  assert.equal(f.writes, 1); assert.equal(f.values.score, 3); assert.deepEqual(f.checkpoints, ['new-reply'], 'earlier successful rule writes remain bound to this branch when a later rule fails');
}
{
  const f = fixture(); f.rules = [{ trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: 'score', prompt: 'delta' } }];
  const pending = deferred(), controller = new AbortController(); f.engine.appBridge.backgroundChat = () => pending.promise;
  const job = createHopscotchSidecarExecutors(f.deps).variable_rules.run({ house: { config: { phase: 'after' } }, signal: controller.signal });
  await pause(); controller.abort(); pending.resolve('2');
  await assert.rejects(job, { name: 'AbortError' }); assert.equal(f.writes, 0);
}
{
  const f = fixture(), pending = deferred(), images = [];
  f.deps.board = normalizeHopscotchBoard({ rows: [{ houses: [{ id: 'body', kind: 'body' }] }, { houses: [imagePrompt, variable] }, { houses: [{ id: 'image', kind: 'image_generation' }] }] });
  f.deps.backgroundChat = async (messages, options) => {
    f.calls.push(options);
    return messages[0].content.includes('<image_prompt>') ? pending.promise : '<UpdateVariable>[]</UpdateVariable>';
  };
  const sidecars = createHopscotchSidecarExecutors(f.deps);
  const executors = createHopscotchExecutors({ ...f.deps, sidecars, image: { run: async options => { images.push(options.promptArtifact); return { status: 'succeeded' }; } } });
  const turn = createCreativeTurnOrchestrator({ board: f.deps.board, executors });
  const completion = turn.runTurn(); await executors.__body.waitForStart(); executors.__body.resolve({ status: 'succeeded' });
  await pause(); assert.equal(images.length, 0, 'image waits for both tasks in the preceding row');
  pending.resolve('<image_prompt>A watercolor lighthouse</image_prompt>'); await completion;
  assert.equal(f.calls.length, 2); assert.equal(images.length, 1); assert.equal(images[0].sourceMessageId, 'new-reply');
  let scheduled;
  const image = createHopscotchImageExecutor({ findMessage: () => f.message, schedule: (message, sid, options) => { scheduled = { message, options }; options.onItemsScheduled({ count: 1 }); options.onItemDone({ item: { index: 0 }, asset: { id: 'asset' } }); return true; } });
  const result = await image({ sessionId: 'rp:sidecar', messageId: 'new-reply', promptArtifact: images[0] });
  assert.equal(result.status, 'succeeded'); assert(scheduled.options.rawText.startsWith('The new body'));
  assert(scheduled.options.rawText.includes('<image_prompt>A watercolor lighthouse</image_prompt>'));
  assert.equal(f.message.rawOriginal, 'The new body', 'handoff does not mutate stored body before the normal image writer');
  const noArtifact = await executors.image_generation.run({ rowInput: { artifacts: {} } }); assert.equal(noArtifact.status, 'skipped'); assert.equal(images.length, 1);
}
const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
assert.match(app, /!boardOwnsVariableRules && variableUpdatesEnabled\(\)/);
assert.match(app, /suppressVariableRules: boardOwnsVariableRules \|\| !variableUpdatesEnabled\(\)/);
assert.match(app, /const bodyMessageId = hopscotchBodyMessageId \|\| checkpointTargetMessageId/);
assert.match(app, /if \(swipeTarget && hopscotchTurn\) await hopscotchTurn\.turnPromise/);
assert.match(app, /swipeTarget\.onVariableUpdatePolicy\?\.\(false\)/, 'swipe fallback must not reapply an inline update already committed before post tasks');
console.log('ok - independent prompt/variable execution, phases, row barrier, image handoff, cancellation, stale-target guards and swipe ownership');
