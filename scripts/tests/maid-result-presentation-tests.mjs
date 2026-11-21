import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { applyMaidResultPresentation } from '../../src/scripts/agent/maid-result-presentation.js';

// 11/21 起结果呈现只剩删除提醒（只看结构）；世界书比较报告改成模型自己调用的只读工具 worldbook.compare_entries，
// 跨卡目标澄清交给模型自己问，APP 不再改写模型的最终回复。
const captured = JSON.parse(fs.readFileSync(new URL('./fixtures/maid-worldbook-comparison-observations.json', import.meta.url)));
const restore = record => record.steps.map(({ outputRef, ...step }) => ({ ...step, output: structuredClone(captured.snapshots[outputRef]) }));
const context = { roleCardId: 'card', submissionId: 'submission-current' };
const reads = new Set(['worldbook.read', 'worldbook.list', 'session.list', 'app.read_resource', 'app.search_feature', 'app.read_feature_doc']);
const isWriteTool = name => reads.has(name) ? false : name === 'session.delete_many' ? true : undefined;
const resultOf = steps => ({ ok: true, status: 'succeeded', responseType: 'react', source: 'maid_provider_fc',
  message: 'Original model draft.', finalDecision: { ok: true, action: 'final', providerFcControl: 'final', message: 'Original model draft.' }, steps });
const sessionRead = () => ({ index: 1, toolName: 'app.read_resource', featureId: 'session.compare', status: 'succeeded', args: { resource: 'session', include: ['description', 'messageCount'] },
  output: { ok: true, resource: 'session', sessions: [{ id: 'original', name: '小雪', messageCount: 4 }, { id: 'copy', name: '小雪 (副本)', messageCount: 2 }] } });
const sessions = () => resultOf([sessionRead()]);
const options = { context, isWriteTool };

test('worldbook comparison runs keep the model final message unchanged', () => {
  for (const record of captured.cases) {
    const steps = restore(record);
    const observedCard = steps.map(step => step.output?.targetSelectionEvidence?.currentCard?.personaId).find(Boolean);
    const original = resultOf(steps), before = JSON.stringify(original);
    assert.strictEqual(applyMaidResultPresentation(original, { ...options, context: { ...context, roleCardId: observedCard } }), original, record.model);
    assert.equal(JSON.stringify(original), before);
  }
});

test('session deletion risk is visibly APP attributed and precedes the unchanged model draft exactly once', () => {
  const original = sessions(), actual = applyMaidResultPresentation(original, options);
  assert.notEqual(actual.message, original.message);
  assert.match(actual.message, /APP/);
  assert.ok(actual.message.endsWith(original.message));
  assert.equal(actual.appPresentation?.kind, 'session_deletion_risk');
  assert.equal(actual.appPresentation?.modelMessage, original.message);
  assert.strictEqual(actual.finalDecision, original.finalDecision);
  assert.strictEqual(applyMaidResultPresentation(actual, options), actual);
});

test('runs without observations and missing request identity pass through unchanged', () => {
  for (const [result, patch] of [
    [resultOf([]), options],
    [sessions(), { ...options, context: {} }],
    [sessions(), { ...options, context: { roleCardId: 'card' } }],
    [sessions(), { ...options, isWriteTool: undefined }],
  ]) assert.strictEqual(applyMaidResultPresentation(result, patch), result);
});

test('only successful final or clarify outcomes qualify; cancellation, refusal and pending work remain intact', () => {
  for (const patch of [
    { ok: false }, { status: 'cancelled' }, { status: 'awaiting_confirmation' }, { status: 'interrupted' },
    { pendingWorkflow: { type: 'delete' } }, { aborted: true },
    { finalDecision: { action: 'tool' } }, { finalDecision: { action: 'final', providerFcControl: 'unsupported' } },
    { finalDecision: { action: 'final', ok: false } },
  ]) {
    const result = { ...sessions(), ...patch };
    assert.strictEqual(applyMaidResultPresentation(result, options), result);
  }
  const result = sessions(), signal = AbortSignal.abort();
  assert.strictEqual(applyMaidResultPresentation(result, { ...options, context: { ...context, signal } }), result);
  for (const finalDecision of [{ ok: true, action: 'clarify', message: 'Which one?' }, { ok: true, action: 'final', providerFcControl: 'clarify', message: 'Which one?' }]) {
    assert.equal(applyMaidResultPresentation({ ...sessions(), finalDecision }, options).appPresentation?.source, 'app');
  }
});

test('any actual write, unknown tool, failed or synthetic observation blocks the notice', () => {
  for (const step of [
    { toolName: 'session.delete_many', status: 'succeeded', output: { ok: true } },
    { toolName: 'unknown.tool', status: 'succeeded', output: { ok: true } },
    { toolName: 'session.list', status: 'failed', output: { ok: false, reason: 'permission_denied' } },
    { toolName: 'session.list', status: 'succeeded', output: { ok: true, partial: true } },
    { toolName: 'session.list', status: 'succeeded', output: { ok: true, localToolExecutionSkipped: true } },
    { toolName: 'session.list', status: 'skipped', output: { ok: true } },
    { toolName: 'session.list', status: 'succeeded', output: { toolName: 'session.list', result: { ok: false } } },
  ]) {
    const result = sessions(); result.steps.push(step);
    assert.strictEqual(applyMaidResultPresentation(result, options), result, step.toolName);
  }
  const result = sessions();
  assert.strictEqual(applyMaidResultPresentation(result, { ...options, isWriteTool: () => { throw Error('registry unavailable'); } }), result);
});

test('continuations and explicit role or run conflicts cannot reuse another task evidence', () => {
  for (const patch of [{ runContinuation: {} }, { pendingActionSubmissionId: 'old' }, { resumedFromRunId: 'old' }]) {
    const result = sessions();
    assert.strictEqual(applyMaidResultPresentation(result, { ...options, context: { ...context, ...patch } }), result);
  }
  const foreignCard = sessions(); foreignCard.steps[0].context = { roleCardId: 'other' };
  assert.strictEqual(applyMaidResultPresentation(foreignCard, options), foreignCard);
  const previous = sessions(); previous.steps[0].metadata = { crossRunSourceRunId: 'old' };
  assert.strictEqual(applyMaidResultPresentation(previous, options), previous);
  const wrongRequest = sessions(); wrongRequest.submissionId = 'other-submission';
  assert.strictEqual(applyMaidResultPresentation(wrongRequest, options), wrongRequest);
});
