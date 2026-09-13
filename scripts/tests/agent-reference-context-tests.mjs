import assert from 'node:assert/strict';
import { normalizeAgentReferenceConfig, selectAgentReferenceMessages, sanitizeAgentReferenceText,
  buildAgentReferenceContext, createAgentReferenceContextBuilder } from '../../src/scripts/agent/agent-reference-context.js';
import { buildAgentReferenceContext as legacyReference } from '../../src/scripts/agent/agent-request-builder.js';

const history = Array.from({ length: 5 }, (_, i) => [
  { id: `u${i + 1}`, role: 'user', type: 'text', content: `Question ${i + 1}` },
  { id: `a${i + 1}`, role: 'assistant', type: 'text', content: `Reply ${i + 1}` },
]).flat();
const modern = { history: { enabled: true, unit: 'turns', count: 3, roles: ['user', 'assistant'], includeTarget: true } };
assert.equal(normalizeAgentReferenceConfig({ mode: 'recent', count: 8 }).history.unit, 'messages');
assert.equal(normalizeAgentReferenceConfig({ mode: 'recent', count: 8 }).history.includeTarget, false);
assert.equal(normalizeAgentReferenceConfig({}).maxChars, 10000);
assert.deepEqual(normalizeAgentReferenceConfig({ worldbook: { enabled: true, ids: ['a', 'a', ''] } }).worldbook.ids, ['a']);
assert.equal(legacyReference([{ role: 'user', content: 'Before' }, { role: 'assistant', content: 'After' }], { mode: 'recent', count: 1 }).text, 'assistant: After');
assert.equal(legacyReference(history, { mode: 'none' }).text, '');

const window3 = selectAgentReferenceMessages(history, modern, { targetMessageId: 'a4' });
assert.deepEqual(window3.messages.map(message => message.id), ['u2', 'a2', 'u3', 'a3', 'u4']);
assert.equal(window3.turnCount, 3, 'window includes the current turn while its target is separate');
const previous3 = selectAgentReferenceMessages(history, { history: { ...modern.history, includeTarget: false } }, { targetMessageId: 'a4' });
assert.deepEqual(previous3.messages.map(message => message.id), ['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
const replies = selectAgentReferenceMessages(history, { history: { ...modern.history, roles: ['assistant'] } }, { targetMessageId: 'a4' });
assert.deepEqual(replies.messages.map(message => message.id), ['a2', 'a3'], 'role filtering never changes which three rounds were selected');
const legacyWindow = selectAgentReferenceMessages(history, { mode: 'recent', count: 3 }, { targetMessageId: 'a4' });
assert.deepEqual(legacyWindow.messages.map(message => message.id), ['a2', 'u3', 'a3', 'u4'].slice(-3));
assert.equal(buildAgentReferenceContext(history, modern, { targetMessageId: 'deleted' }).text, '');
assert.equal(buildAgentReferenceContext(history, modern, { targetMessageId: 'deleted' }).targetMissing, true);
assert.equal(buildAgentReferenceContext(history, modern, { targetMessageId: 'a4' }).text.includes('Reply 4'), false);
assert.equal(buildAgentReferenceContext(history, modern, { targetMessageId: 'a4' }).text.includes('Reply 5'), false);

const bubbles = [{ id: 'u', role: 'user', content: 'First' }, { id: 'uu', role: 'user', content: 'Second' },
  { id: 'a', role: 'assistant', content: 'First bubble' }, { id: 'aa', role: 'assistant', content: 'Second bubble' }];
assert.equal(selectAgentReferenceMessages(bubbles, { history: { ...modern.history, count: 1 } }).messages.length, 4);
const badMessages = [
  { role: 'assistant', content: 'pending', pending: true }, { role: 'assistant', content: 'error', error: 'failed' },
  { role: 'assistant', content: 'media', meta: { generatedMedia: {} } }, { role: 'assistant', content: 'hidden', hidden: true },
  { role: 'assistant', content: 'streaming', status: 'streaming' }, { role: 'assistant', content: 'voice', type: 'voice' },
  { role: 'tool', content: 'tool result' }, { role: 'assistant', content: 'visible' },
];
assert.equal(buildAgentReferenceContext(badMessages, { mode: 'recent', count: 50 }).text, 'assistant: visible');

const raw = '<think>PRIVATE THOUGHT</think><content>Visible first.<br>Visible next.</content>'
  + '<tableEdit>SECRET TABLE</tableEdit><UpdateVariable>SECRET VARIABLE</UpdateVariable>'
  + '<details><summary>SUMMARY TITLE</summary>SECRET SUMMARY</details>'
  + '<span hidden>SECRET HIDDEN</span><script>SECRET SCRIPT</script>[[image:media]]';
assert.equal(sanitizeAgentReferenceText(raw).text, 'Visible first.\nVisible next.');
assert.equal(sanitizeAgentReferenceText('Reasoning start\nsecret\nReasoning end\nBody', {
  reasoningBoundaries: { prefix: 'Reasoning start', suffix: 'Reasoning end' },
}).text, 'Body');
assert.equal(sanitizeAgentReferenceText('<think>unclosed secret').text, '');
assert.equal(sanitizeAgentReferenceText('<iframe>private widget</iframe>').ok, false);
assert.equal(sanitizeAgentReferenceText('<style>.x{display:none}</style><div class="x">private</div>').ok, false);
assert.equal(buildAgentReferenceContext([{ id: 'raw', role: 'assistant', content: raw }], { mode: 'recent' }).text.includes('SECRET'), false);

const sources = [
  { id: 'book:1', kind: 'worldbook', title: 'City', group: 'World', text: 'A city by the sea.' },
  { id: 'prompt:1', kind: 'prompt', title: 'Voice', text: 'Use <tableEdit> only for examples.' },
  { id: 'book:2', kind: 'worldbook', title: 'Disabled', text: 'SHOULD NOT SEND', disabled: true },
  { id: 'prompt:2', kind: 'prompt', title: 'Loading', available: false, text: 'SHOULD NOT SEND' },
];
const selected = { worldbook: { enabled: true, ids: ['book:1', 'book:2', 'gone'] }, prompts: { enabled: true, ids: ['prompt:1', 'prompt:2'] } };
const sourceResult = buildAgentReferenceContext([], selected, { sources });
assert.ok(sourceResult.text.includes('A city by the sea.'));
assert.ok(sourceResult.text.includes('<tableEdit>'), 'selected fixed instructions are not cleaned as chat messages');
assert.equal(sourceResult.text.includes('SHOULD NOT SEND'), false);
assert.deepEqual(sourceResult.sources.map(source => source.status), ['included', 'disabled', 'missing', 'included', 'unavailable']);
assert.equal(sourceResult.chars, sourceResult.text.length);
const disabled = buildAgentReferenceContext([], { ...selected, worldbook: { ...selected.worldbook, enabled: false } }, { sources });
assert.equal(disabled.text.includes('A city'), false);

const clipped = buildAgentReferenceContext([{ id: 'long', role: 'assistant', content: `OLD${'x'.repeat(700)}LATEST` }], {
  mode: 'recent', maxChars: 500, ...selected,
}, { sources });
assert.ok(clipped.text.length <= 500);
assert.equal(clipped.truncated, true);
assert.ok(clipped.text.endsWith('LATEST'));
assert.ok(clipped.sources.some(source => source.status === 'truncated'));
assert.ok(clipped.warnings.length);

const readIds = [], catalogReads = [], contexts = [];
const build = createAgentReferenceContextBuilder({ getMessages: sid => { contexts.push(sid); return history; },
  listSources: (context, options) => { catalogReads.push([context.sessionId, options.config]); return sources; },
  getMessageText: async (message, context) => { readIds.push(message.id); assert.equal(context.sessionId, 's'); return { ok: true, text: `display ${message.content}` }; },
});
const asyncResult = await build({ config: { context: { ...modern, ...selected } }, context: { sessionId: 's' }, targetMessageId: 'a4' });
assert.deepEqual(readIds, ['u2', 'a2', 'u3', 'a3', 'u4'], 'renderer reads only the selected past window');
assert.ok(asyncResult.text.includes('display Reply 3'));
assert.equal(asyncResult.text.includes('display Reply 4'), false);
assert.equal(catalogReads.length, 1);
assert.deepEqual(contexts, ['s']);
const noRead = createAgentReferenceContextBuilder({ getMessages: () => [], listSources: () => { throw new Error('unneeded source read'); } });
assert.equal((await noRead({ config: {} })).text, '');
const unavailable = createAgentReferenceContextBuilder({ getMessages: () => [{ id: 'x', role: 'assistant', content: 'RAW SECRET' }], getMessageText: async () => undefined });
const unavailableResult = await unavailable({ config: { mode: 'recent' } });
assert.equal(unavailableResult.text, '', 'renderer failure must never fall back to raw chat content');
assert.equal(unavailableResult.sources[0].status, 'unavailable');

const controller = new AbortController();
let started = false;
const stalled = createAgentReferenceContextBuilder({ getMessages: () => [{ id: 'x', role: 'assistant', content: 'x' }],
  getMessageText: () => { started = true; return new Promise(() => {}); },
});
const pending = stalled({ config: { mode: 'recent' }, signal: controller.signal });
while (!started) await new Promise(resolve => setTimeout(resolve, 0));
controller.abort();
await assert.rejects(pending, error => error.name === 'AbortError');
const alreadyAborted = new AbortController(); alreadyAborted.abort();
await assert.rejects(build({ config: {}, signal: alreadyAborted.signal }), error => error.name === 'AbortError');
console.log('agent reference context tests passed');
