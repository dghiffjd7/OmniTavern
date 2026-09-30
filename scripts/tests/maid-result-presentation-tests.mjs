import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { applyMaidResultPresentation } from '../../src/scripts/agent/maid-result-presentation.js';

const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/maid-worldbook-comparison-observations.json', import.meta.url)));
const restore = record => record.steps.map(({ outputRef, ...step }) => ({ ...step, output: structuredClone(captured.snapshots[outputRef]) }));
const context = { roleCardId: 'card', submissionId: 'submission-current' };
const reads = new Set(['worldbook.read', 'worldbook.list', 'session.list', 'app.read_resource', 'app.search_feature', 'app.read_feature_doc']);
const isWriteTool = name => reads.has(name) ? false : name === 'session.delete_many' ? true : undefined;
const resultOf = steps => ({ ok: true, status: 'succeeded', responseType: 'react', source: 'maid_provider_fc',
  message: 'Original model draft.', finalDecision: { ok: true, action: 'final', providerFcControl: 'final', message: 'Original model draft.' }, steps });
const entry = (id, content) => ({ id, title: id, content, contentLength: content.length, contentTruncated: false, contentSource: 'content' });
const read = (id, content = 'Observed body') => ({ index: 1, toolName: 'worldbook.read', status: 'succeeded', args: { worldbookId: id, includeContent: true },
  output: { ok: true, id, name: id, contentMode: 'content', entryCount: 1, returnedEntryCount: 1, truncated: false, entries: [entry('one', content)],
    ownershipKnown: true, targetSelectionEvidence: { currentCard: { personaId: 'card', bindingState: 'unbound' } } } });
const world = () => resultOf([read('left', 'First original body'), read('right', 'Second original body')]);
const worldOptions = { input: '合并两本世界书并提出方案', context, isWriteTool };
const sessions = () => resultOf([{ index: 1, toolName: 'app.read_resource', featureId: 'session.compare', status: 'succeeded', args: { resource: 'session', include: ['description', 'messageCount'] },
  output: { ok: true, resource: 'session', sessions: [{ id: 'original', name: '小雪', messageCount: 4 }, { id: 'copy', name: '小雪 (副本)', messageCount: 2 }] } }]);
const sessionOptions = { input: '帮我比较同名联系人，删除重复联系人', context: { ...context, operationIntentPolicy: { mode: 'write_allowed' } }, isWriteTool };

test('both captured comparison runs produce APP attributed text and retain the exact original decision', () => {
  for (const record of captured.cases) {
    const steps = restore(record);
    const observedCard = steps.map(step => step.output?.targetSelectionEvidence?.currentCard?.personaId).find(Boolean);
    const original = resultOf(steps), before = JSON.stringify(original);
    const actual = applyMaidResultPresentation(original, { ...worldOptions, context: { ...context, roleCardId: observedCard || context.roleCardId } });
    assert.notEqual(actual.message, original.message, record.model);
    assert.equal(actual.appPresentation?.source, 'app');
    assert.equal(actual.appPresentation?.kind, 'worldbook_entries');
    assert.equal(actual.appPresentation?.modelMessage, original.message);
    assert.strictEqual(actual.finalDecision, original.finalDecision);
    assert.equal(actual.source, original.source);
    assert.equal(actual.status, original.status);
    assert.match(actual.message, /APP/);
    assert.ok(actual.message.length <= 2200);
    assert.equal(JSON.stringify(original), before);
  }
});

test('session deletion risk is visibly APP attributed and precedes the unchanged model draft exactly once', () => {
  const original = sessions(), actual = applyMaidResultPresentation(original, sessionOptions);
  assert.notEqual(actual.message, original.message);
  assert.match(actual.message, /APP/);
  assert.ok(actual.message.endsWith(original.message));
  assert.equal(actual.appPresentation?.kind, 'session_deletion_risk');
  assert.equal(actual.appPresentation?.modelMessage, original.message);
  assert.strictEqual(actual.finalDecision, original.finalDecision);
  assert.strictEqual(applyMaidResultPresentation(actual, sessionOptions), actual);
});

test('ordinary explanations, unrelated tasks and missing request identity pass through unchanged', () => {
  for (const [result, options] of [
    [world(), { ...worldOptions, input: '今天怎么样' }],
    [resultOf([]), worldOptions],
    [world(), { ...worldOptions, context: {} }],
    [world(), { ...worldOptions, context: { roleCardId: 'card' } }],
    [world(), { ...worldOptions, isWriteTool: undefined }],
  ]) assert.strictEqual(applyMaidResultPresentation(result, options), result);
});

test('only successful final or clarify outcomes qualify; cancellation, refusal and pending work remain intact', () => {
  for (const patch of [
    { ok: false }, { status: 'cancelled' }, { status: 'awaiting_confirmation' }, { status: 'interrupted' },
    { pendingWorkflow: { type: 'delete' } }, { aborted: true },
    { finalDecision: { action: 'tool' } }, { finalDecision: { action: 'final', providerFcControl: 'unsupported' } },
    { finalDecision: { action: 'final', ok: false } },
  ]) {
    const result = { ...world(), ...patch };
    assert.strictEqual(applyMaidResultPresentation(result, worldOptions), result);
  }
  const result = world(), signal = AbortSignal.abort();
  assert.strictEqual(applyMaidResultPresentation(result, { ...worldOptions, context: { ...context, signal } }), result);
  for (const finalDecision of [{ action: 'clarify', message: 'Which books?' }, { action: 'final', providerFcControl: 'clarify', message: 'Which books?' }]) {
    assert.equal(applyMaidResultPresentation({ ...world(), finalDecision }, worldOptions).appPresentation?.source, 'app');
  }
});

test('any actual write, unknown tool, failed or synthetic observation blocks presentation replacement', () => {
  for (const step of [
    { toolName: 'session.delete_many', status: 'succeeded', output: { ok: true } },
    { toolName: 'unknown.tool', status: 'succeeded', output: { ok: true } },
    { toolName: 'worldbook.read', status: 'failed', output: { ok: false, reason: 'permission_denied' } },
    { toolName: 'worldbook.read', status: 'succeeded', output: { ok: true, partial: true } },
    { toolName: 'worldbook.read', status: 'succeeded', output: { ok: true, localToolExecutionSkipped: true } },
    { toolName: 'worldbook.read', status: 'skipped', output: { ok: true } },
    { toolName: 'worldbook.read', status: 'succeeded', output: { toolName: 'worldbook.read', result: { ok: false } } },
  ]) {
    const result = world(); result.steps.push(step);
    assert.strictEqual(applyMaidResultPresentation(result, worldOptions), result, step.toolName);
  }
  const result = world();
  assert.strictEqual(applyMaidResultPresentation(result, { ...worldOptions, isWriteTool: () => { throw Error('registry unavailable'); } }), result);
});

test('continuations and explicit role or run conflicts cannot reuse another task evidence', () => {
  for (const patch of [{ runContinuation: {} }, { pendingActionSubmissionId: 'old' }, { resumedFromRunId: 'old' }, { roleCardId: 'other' }]) {
    const result = world();
    assert.strictEqual(applyMaidResultPresentation(result, { ...worldOptions, context: { ...context, ...patch } }), result);
  }
  const result = world(); result.steps[1].output.targetSelectionEvidence.currentCard.personaId = 'other';
  assert.strictEqual(applyMaidResultPresentation(result, worldOptions), result);
  const previous = world(); previous.steps[0].metadata = { crossRunSourceRunId: 'old' };
  assert.strictEqual(applyMaidResultPresentation(previous, worldOptions), previous);
  const wrongRequest = world(); wrongRequest.submissionId = 'other-submission';
  assert.strictEqual(applyMaidResultPresentation(wrongRequest, worldOptions), wrongRequest);
});

test('partial or ambiguous comparison yields only the pure module clarification, without guessing a pair', () => {
  const partial = world(); partial.steps[0].output.truncated = true;
  const limited = applyMaidResultPresentation(partial, worldOptions);
  assert.equal(limited.appPresentation?.source, 'app');
  assert.equal(limited.appPresentation?.status, 'incomplete');
  assert.match(limited.message, /APP/);
  const multiple = world(); multiple.steps.push(read('third'));
  assert.equal(applyMaidResultPresentation(multiple, worldOptions).appPresentation?.status, 'needs_selection');
});

test('two supporting lorebook reads cannot replace a different comparison goal or an ordinary comparison', () => {
  for (const input of ['比较小雪和 Luna 的人设', '比较两本世界书', 'Compare the personalities of Luna and Snow', 'Merge these contacts']) {
    const original = world();
    assert.strictEqual(applyMaidResultPresentation(original, { ...worldOptions, input }), original, input);
  }
});
