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
  // 默认提示词写「-5~+5」：严格模式也要接受带正号的数字，与提示词写法一致；带说明文字仍算无效
  const f = fixture(); f.rules = [{ trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: 'score', prompt: 'delta' } }];
  f.engine.appBridge.backgroundChat = async () => '+3';
  await createHopscotchSidecarExecutors(f.deps).variable_rules.run({ house: { config: { phase: 'after' } } });
  assert.equal(f.values.score, 4);
  f.rules = [{ trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: 'score', prompt: 'set', mode: 'set' } }];
  await createHopscotchSidecarExecutors(f.deps).variable_rules.run({ house: { config: { phase: 'after' } } });
  assert.equal(f.values.score, 3);
  f.engine.appBridge.backgroundChat = async () => '+3（好感上升）';
  await assert.rejects(createHopscotchSidecarExecutors(f.deps).variable_rules.run({ house: { config: { phase: 'after' } } }));
  assert.equal(f.values.score, 3);
  console.log('ok - strict ai_evaluate accepts a leading plus sign like the default prompt range');
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
{
  // 生图房子跳过时报出调度器给的实际原因；调度器没给原因才算没有提示。
  const message = { id: 'm1', role: 'assistant', content: 'body' };
  const limited = createHopscotchImageExecutor({ findMessage: () => message, schedule: (msg, sid, options) => { options.onSkipped({ reason: 'repeated-prompt' }); return false; } });
  assert.deepEqual(await limited({ sessionId: 's', messageId: 'm1' }), { status: 'skipped', reason: 'repeated-prompt' });
  const silent = createHopscotchImageExecutor({ findMessage: () => message, schedule: () => false });
  assert.deepEqual(await silent({ sessionId: 's', messageId: 'm1' }), { status: 'skipped', reason: 'no_prompt' });
  const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
  assert.match(app, /return reportSkip\('already_processed'\)/);
  assert.match(app, /return reportSkip\(guard\.reason\)/);
  assert.match(app, /onSkipped,\n\s+\}\);/, 'writing branch passes skip reasons through');
  console.log('ok - image house reports the scheduler skip reason');
}
const app = readFileSync(new URL('../../src/scripts/ui/app.js', import.meta.url), 'utf8');
assert.match(app, /!boardOwnsVariableRules && variableUpdatesEnabled\(\)/);
assert.match(app, /suppressVariableRules: boardOwnsVariableRules \|\| !variableUpdatesEnabled\(\)/);
assert.match(app, /const bodyMessageId = hopscotchBodyMessageId \|\| checkpointTargetMessageId/);
assert.match(app, /if \(swipeTarget && hopscotchTurn\) await hopscotchTurn\.turnPromise/);
assert.match(app, /swipeTarget\.onVariableUpdatePolicy\?\.\(false\)/, 'swipe fallback must not reapply an inline update already committed before post tasks');
assert.match(app, /if \(hopscotchTurn\) \{\n\s+swipeTarget\?\.onImageOwnedByTurn\?\.\(\);/, 'hopscotch turn owns swipe images');
assert.match(app, /sourceAutoImagePlaceholders\.length && !swipeImageOwnedByTurn\)/, 'swipe commit must not generate images again after the image house');
console.log('ok - independent prompt/variable execution, phases, row barrier, image handoff, cancellation, stale-target guards and swipe ownership');
{
  // 图片提示房子「套用预设」：本轮输入与正文放在预设的聊天记录位置；上限仍 4096；预设删除后退回原规则。
  const f = fixture();
  f.deps.backgroundChat = async (messages, options) => { f.calls.push({ messages, options }); return '<image_prompt>a cat</image_prompt>'; };
  f.deps.resolveTaskPreset = id => (id === 'ip' ? { ok: true, id, name: '配图', render: data => ({ ok: true, messages: [{ role: 'system', content: '预设配图指令' }, ...data] }) } : { ok: false });
  const sidecars = createHopscotchSidecarExecutors(f.deps);
  const house = { id: 'p', kind: 'image_prompt', config: { promptSource: 'preset', presetId: 'ip' } };
  const result = await sidecars.image_prompt.run({ house });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.artifact.prompts, ['a cat']);
  assert.deepEqual(f.calls[0].messages, [{ role: 'system', content: '预设配图指令' }, { role: 'user', content: 'Continue\n\nThe new body' }]);
  assert.equal(f.calls[0].options.maxTokens, 4096);
  assert.equal(f.calls[0].options.presetContext.presetId, 'ip');
  const fallback = await sidecars.image_prompt.run({ house: { ...house, config: { promptSource: 'preset', presetId: 'gone' } } });
  assert.equal(fallback.status, 'succeeded');
  assert.match(f.calls[1].messages[0].content, /image_prompt/);
  assert.equal(f.calls[1].options.presetContext.presetId, undefined);
  const config = normalizeHopscotchBoard({ rows: [{ houses: [{ id: 'body', kind: 'body' }] }, { houses: [{ id: 'p', kind: 'image_prompt', config: { promptSource: 'preset', presetId: ' ip ' } }] }] }).rows[1].houses[0].config;
  assert.deepEqual([config.promptSource, config.presetId], ['preset', 'ip']);
  console.log('ok - image prompt house uses the selected preset and falls back to the built-in rules');
}
{
  const { createImagePromptHousePresetHandler } = await import('../../src/scripts/ui/chat/hopscotch-sidecar-executors.js');
  const sent = [];
  const handler = createImagePromptHousePresetHandler({
    getSessionId: () => 'rp:x',
    getMessages: () => [{ role: 'user', content: '去海边' }, { role: 'assistant', content: '浪花拍岸' }],
    resolvePreset: (id, sid) => (id === 'ip' ? { ok: true, id, sid, render: data => ({ ok: true, messages: [{ role: 'system', content: 'P' }, ...data] }) } : { ok: false }),
    backgroundChat: async (messages, options) => { sent.push({ messages, options }); return options.previewOnly ? { messages } : '<image_prompt>sea</image_prompt><image_prompt>wave</image_prompt>'; },
    getRuntimeConfigByProfileId: async () => null,
  });
  const preview = await handler.preview({ presetId: 'ip', context: { config: {} } });
  assert.equal(preview.ok, true);
  assert.equal(sent[0].messages[1].content, '去海边\n\n浪花拍岸');
  assert.deepEqual(sent[0].options.presetContext, { sessionId: 'rp:x', uiMode: 'rp', presetId: 'ip' });
  const trial = await handler.trial({ presetId: 'ip', context: { config: {} } });
  assert.equal(trial.ok, true);
  assert.equal(trial.message, '读到 2 条图片提示');
  assert.equal(sent[1].options.maxTokens, 4096);
  assert.deepEqual(await handler.trial({ presetId: 'gone', context: { config: {} } }), { ok: false, message: '所选预设已不存在' });
  console.log('ok - image prompt house preset handler previews and trials with the latest turn');
}
{
  // 变量规则 AI 评估「套用预设」：最近对话放在预设的聊天记录位置；温度跟预设；预设删除退回原提示词。
  // 只要一个数字：两条路径都不思考（DeepSeek 等思考会吃光小上限），上限放宽给关不掉思考的模型留余量。
  const { setAgentTaskPresetSource } = await import('../../src/scripts/ui/chat/agent-task-preset.js');
  setAgentTaskPresetSource({ resolve: id => (id === 'judge' ? { ok: true, id, name: '判断', render: data => ({ ok: true, messages: [{ role: 'system', content: '只输出整数' }, ...data] }) } : { ok: false }) });
  const f = fixture();
  const sent = [];
  f.engine.appBridge.backgroundChat = async (messages, options) => { sent.push({ messages, options }); return '3'; };
  f.rules = [{ id: 'r', trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: 'score', prompt: '', promptSource: 'preset', presetId: 'judge' } }];
  await createHopscotchSidecarExecutors(f.deps).variable_rules.run({ house: { config: { phase: 'after' } } });
  assert.equal(sent[0].messages[0].content, '只输出整数');
  assert.match(sent[0].messages[1].content, /^<chat_history>\n[\s\S]*The new body[\s\S]*<\/chat_history>$/);
  assert.equal(sent[0].options.temperature, undefined);
  assert.equal(sent[0].options.maxTokens, 1024);
  assert.equal(sent[0].options.reasoningMode, 'off');
  assert.equal(sent[0].options.presetContext.presetId, 'judge');
  assert.equal(sent[0].options.presetContext.sessionId, 'rp:sidecar');
  f.rules = [{ id: 'r', trigger: { type: 'every_turn' }, action: { type: 'ai_evaluate', target: 'score', prompt: 'delta', promptSource: 'preset', presetId: 'gone' } }];
  await createHopscotchSidecarExecutors(f.deps).variable_rules.run({ house: { config: { phase: 'after' } } });
  assert.match(sent[1].messages[1].content, /^delta/);
  assert.equal(sent[1].options.temperature, 0.2);
  assert.equal(sent[1].options.maxTokens, 1024);
  assert.equal(sent[1].options.reasoningMode, 'off');
  setAgentTaskPresetSource(null);
  // 规则编辑里显示的上限与实际请求一致（面板不引入引擎，避免拖进 logger 等启动依赖）
  const { VARIABLE_AI_EVALUATE_MAX_TOKENS } = await import('../../src/scripts/variables/variable-rule-engine.js');
  assert.equal(VARIABLE_AI_EVALUATE_MAX_TOKENS, 1024);
  assert.match(readFileSync(new URL('../../src/scripts/ui/variable-panel-runtime.js', import.meta.url), 'utf8'), new RegExp(`kind: 'variable_ai_evaluate'[\\s\\S]{0,200}limitValue: '${VARIABLE_AI_EVALUATE_MAX_TOKENS}'`));
  console.log('ok - variable ai_evaluate rules use the selected preset and fall back to their prompt');
}
