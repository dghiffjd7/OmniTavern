import assert from 'node:assert/strict';
import { captureAgentReferenceMessages, selectAgentReferenceMessages, buildAgentReferenceContext } from '../../src/scripts/agent/agent-reference-context.js';

// The renderer imports the app logger; the fixture has no browser storage or UI.
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { createAgentReferenceAppRuntime } = await import('../../src/scripts/ui/chat/agent-reference-app-runtime.js');

const context = { sessionId: 'rp:test', place: 'writing', scopeId: 'profile', archiveId: 'archive' };
let active = { ...context }, messageReads = 0, displayCalls = 0, boundaryReads = 0, frame;
const messages = [
  { id: 'u1', role: 'user', type: 'text', content: 'Earlier question' },
  { id: 'a1', role: 'assistant', type: 'text', content: 'Stored display', raw_source: 'DISPLAY SOURCE', meta: { renderRich: true } },
  { id: 'image', role: 'assistant', type: 'image', content: 'data:image/huge', meta: { localPath: 'an-attachment', expired: true } },
  { id: 'pending', role: 'assistant', type: 'text', content: 'PENDING BODY', pending: true },
  { id: 'failed', role: 'assistant', type: 'text', content: 'FAILED BODY', error: 'failed' },
  { id: 'hidden', role: 'assistant', type: 'text', content: 'HIDDEN BODY', meta: { hidden: true } },
  { id: 'deleted', role: 'assistant', type: 'text', content: 'DELETED BODY', deleted: true },
  { id: 'u2', role: 'user', type: 'text', content: 'Current question' },
  { id: 'a2', role: 'assistant', type: 'text', content: 'CURRENT TARGET' },
  { id: 'u3', role: 'user', type: 'text', content: 'FUTURE QUESTION' },
  { id: 'a3', role: 'assistant', type: 'text', content: 'FUTURE REPLY' },
];
const config = { history: { enabled: true, unit: 'turns', count: 2, includeTarget: true } };
const emptyWorld = { ready: Promise.resolve(), list: () => [] };
let world = emptyWorld;
const runtime = createAgentReferenceAppRuntime({ getContext: () => active,
  getMessages: sid => { messageReads++; assert.equal(sid, context.sessionId); return messages; },
  getDisplayMessages: all => {
    displayCalls++; frame = all;
    const conversation = all.filter(message => ['user', 'assistant'].includes(message?.role));
    return all.map(message => {
      if (message.type === 'image') assert.fail('reading reference data reached the image-expiry branch');
      const depth = conversation.length - 1 - conversation.indexOf(message);
      return { ...message, content: message.content ? `${message.raw_source || message.content} @depth:${depth}` : '' };
    });
  },
  getReasoningBoundaries: () => { boundaryReads++; return { prefix: 'BEGIN_PRIVATE', suffix: 'END_PRIVATE' }; },
  getWorldStore: () => world, getPresetStore: () => null, documentRef: {},
});
const reference = await runtime.resolveReference({ config, context, targetMessageId: 'a2' });
assert.equal(frame.length, messages.length);
assert.deepEqual(frame.map(message => message.role), messages.map(message => message.role));
assert.equal(frame.find(message => message.id === 'image').type, 'reference_placeholder');
assert.equal(frame.find(message => message.id === 'pending').content, '');
assert.equal(frame.find(message => message.id === 'hidden').content, '');
assert.equal(frame.find(message => message.id === 'deleted').content, '');
assert.equal(frame.find(message => message.id === 'a3').content, '');
assert.ok(reference.text.includes('DISPLAY SOURCE @depth:9'), 'depth remains exactly the visible full conversation depth');
assert.equal(reference.text.includes('FUTURE'), false);
assert.equal(reference.text.includes('CURRENT TARGET'), false);
assert.equal(displayCalls, 1, 'all selected messages share one display-regex pass');
assert.equal(boundaryReads, 1, 'reasoning preset snapshot is shared by the request');

const captured = captureAgentReferenceMessages(messages, config, { targetMessageId: 'a2' });
assert.deepEqual(selectAgentReferenceMessages(captured, config, { targetMessageId: 'a2' }).messages.map(message => message.id), ['u1','a1','u2']);
assert.equal(captured.find(message => message.id === 'image').content, '');
assert.equal(captured.find(message => message.id === 'a2').role, 'assistant');
assert.equal(captured.find(message => message.id === 'a3').content, '');
assert.equal(captured.find(message => message.id === 'a1').raw_source, 'DISPLAY SOURCE');
assert.equal(captured.find(message => message.id === 'hidden').meta.hidden, true);
messages[1].content = 'changed'; messages[1].raw_source = 'changed raw'; messages[1].meta.renderRich = false;
messages[5].meta.hidden = false;
assert.equal(captured[1].content, 'Stored display');
assert.equal(captured[1].raw_source, 'DISPLAY SOURCE');
assert.equal(captured[1].meta.renderRich, true);
assert.equal(captured[5].meta.hidden, true, 'nested flags are snapshots rather than original mutable metadata');
assert.ok(buildAgentReferenceContext(captured, config, { targetMessageId: 'a2' }).text.includes('Stored display'));

const noHistoryCalls = displayCalls;
await runtime.resolveReference({ config: {}, context });
assert.equal(displayCalls, noHistoryCalls, 'no-history requests do not decorate the conversation');
active = { ...context, archiveId: 'another' };
const beforeStaleReads = messageReads;
await assert.rejects(runtime.resolveReference({ config: {}, context }), error => error.name === 'AbortError');
assert.equal(messageReads, beforeStaleReads, 'a stale scope fails before reading any current-profile chat');
active = { ...context };

let releaseWorld;
world = { ready: new Promise(resolve => { releaseWorld = resolve; }), list: () => [], load: () => null };
const pending = runtime.resolveReference({ config: { ...config, worldbook: { enabled: true, ids: ['worldbook:missing'] } }, context, targetMessageId: 'a2' });
await new Promise(resolve => setTimeout(resolve, 0));
active = { ...context, scopeId: 'new-profile' }; releaseWorld();
await assert.rejects(pending, error => error.name === 'AbortError', 'scope changes during source IO invalidate already-projected history');
active = { ...context }; world = emptyWorld;
const controller = new AbortController(); controller.abort();
await assert.rejects(runtime.resolveReference({ config: {}, context, signal: controller.signal }), error => error.name === 'AbortError');

// Even when only fixed material is requested, a scope change during loading must
// abort instead of returning a misleading empty reference.
let releaseOnly;
world = { ready: new Promise(resolve => { releaseOnly = resolve; }), list: () => [] };
const fixedOnly = runtime.resolveReference({ config: { worldbook: { enabled: true, ids: ['worldbook:x'] } }, context });
await new Promise(resolve => setTimeout(resolve, 0));
active = { ...context, archiveId: 'different' }; releaseOnly();
await assert.rejects(fixedOnly, error => error.name === 'AbortError');
console.log('agent reference app runtime tests passed');
