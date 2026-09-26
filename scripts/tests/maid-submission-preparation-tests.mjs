import assert from 'node:assert/strict';
import test from 'node:test';
import { createSubmissionPreparationQueue } from '../../src/scripts/ui/maid-command-input-runtime-utils.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('programmatic submits wait for the running preparation and enqueue in submit order', async () => {
  const queue = createSubmissionPreparationQueue(), order = [], first = deferred();
  const a = queue(() => first.promise, ({ value }) => { order.push(value); return new Promise(() => {}); });
  const b = queue(async () => 'retry', ({ value }) => { order.push(value); return 'queued'; });
  assert.notEqual(b, null, 'a resume retry is not dropped while another task prepares');
  first.resolve('draft');
  assert.equal(await b, 'queued', 'a task completion promise does not block the next submit');
  assert.deepEqual(order, ['draft', 'retry']);
  void a;
});

test('a second Enter on the draft being prepared is ignored; failures release the queue', async () => {
  const queue = createSubmissionPreparationQueue(), first = deferred();
  const a = queue(() => first.promise, ({ ok, error }) => ok ? 'ok' : error.message, { fromDraft: true });
  assert.equal(queue(async () => 'dup', () => 'dup', { fromDraft: true }), null);
  first.reject(new Error('unconfigured'));
  assert.equal(await a, 'unconfigured');
  assert.equal(await queue(async () => 'next', ({ value }) => value, { fromDraft: true }), 'next');
});
