import assert from 'node:assert/strict';
import { createInputSuggestionRequest } from '../../src/scripts/ui/chat/input-suggestion-runtime.js';
import { runChatFormatGuardianPreview } from '../../src/scripts/ui/chat/after-receive-dispatch-utils.js';
import { createAgentReferenceContextBuilder } from '../../src/scripts/agent/agent-reference-context.js';

const context = { place: 'writing', sessionId: 'rp:test', scopeId: 'test', archiveId: 'a' };
const messages = [
  { id: 'u1', role: 'user', content: 'First question' },
  { id: 'a1', role: 'assistant', content: '<think>PRIVATE</think><content>Earlier reply</content><tableEdit>PRIVATE TABLE</tableEdit>' },
  { id: 'u2', role: 'user', content: 'Current question' },
  { id: 'a2', role: 'assistant', content: 'TARGET REPLY' },
  { id: 'u3', role: 'user', content: 'FUTURE QUESTION' },
  { id: 'a3', role: 'assistant', content: 'FUTURE REPLY' },
];
const referenceConfig = { history: { enabled: true, unit: 'turns', count: 2, includeTarget: true },
  prompts: { enabled: true, ids: ['prompt:voice'] } };
const referenceBuilder = createAgentReferenceContextBuilder({ getMessages: () => messages,
  listSources: () => [{ id: 'prompt:voice', kind: 'prompt', title: 'Voice', text: 'SELECTED VOICE' }],
});
const snapshot = { before: 'Draft before', after: '', agentContext: context, referenceContext: { text: 'STALE SNAPSHOT' },
  settings: { enabled: true, modelMode: 'profile', modelProfileId: 'tiny', context: referenceConfig } };
let sent = [], reads = 0;
const request = createInputSuggestionRequest({ getProfileConfig: async () => ({ model: 'mock' }),
  resolveReference: async (value, signal) => {
    reads++; assert.equal(value.agentContext.sessionId, context.sessionId);
    return referenceBuilder({ config: value.settings, context: value.agentContext, messages: messages.slice(0, 4), signal });
  },
  createClient: () => ({ chat: async (payload, options) => { sent.push({ payload, options }); return 'continuation'; } }),
});
const controller = new AbortController();
assert.equal(reads, 0, 'reference material is resolved only when the debounced request starts');
assert.equal(await request(snapshot, controller.signal), 'continuation');
assert.equal(reads, 1);
const requestText = sent[0].payload.map(message => message.content).join('\n');
assert.ok(requestText.includes('SELECTED VOICE') && requestText.includes('Earlier reply'));
assert.equal(requestText.includes('PRIVATE'), false);
assert.equal(requestText.includes('STALE SNAPSHOT'), false);
assert.equal(sent[0].options.signal, controller.signal);
assert.deepEqual(sent[0].options.requestParamConstraints, { maxOutputTokens: 96, tools: 'none' });

let resolveHeld;
const pendingRequest = createInputSuggestionRequest({ getProfileConfig: async () => ({ model: 'mock' }),
  resolveReference: () => new Promise(resolve => { resolveHeld = resolve; }),
  createClient: () => ({ chat: () => assert.fail('cancelled context load must not start a model request') }),
});
const cancel = new AbortController();
const pending = pendingRequest(snapshot, cancel.signal);
await new Promise(resolve => setTimeout(resolve, 0));
cancel.abort(); resolveHeld({ text: 'too late' });
assert.equal(await pending, '');
let legacySent;
const legacy = createInputSuggestionRequest({ getProfileConfig: async () => ({}), createClient: () => ({ chat: payload => { legacySent = payload; return ''; } }) });
await legacy(snapshot, new AbortController().signal);
assert.ok(legacySent.some(message => message.content.includes('STALE SNAPSHOT')), 'old callers retain their provided reference');
const failed = createInputSuggestionRequest({ getProfileConfig: async () => ({}), resolveReference: async () => { throw new Error('source failed'); },
  createClient: () => assert.fail('a resolver failure must not fall back to stale/raw reference') });
await assert.rejects(failed(snapshot, new AbortController().signal), /source failed/);

const runFormat = async ({ resolveReferenceContext, referenceContext = { text: 'LEGACY FORMAT REFERENCE' }, repairTarget, signal } = {}) => {
  const calls = [];
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  runChatFormatGuardianPreview({
    message: { id: 'display-bubble', role: 'assistant', content: '<我和菲伦的私聊>\n菲伦--今晚别一个人走。--22:12\n</我和菲伦的私聊>' },
    sessionId: context.sessionId,
    chatFormatGuardian: { enabled: true, baseRevision: 'reference-test', repairTarget,
      userName: '我', resolvePrivateTargetId: () => 'contact:firen', resolveSpeakerId: () => 'contact:firen',
      modelReview: { enabled: true, force: true, referenceContext, resolveReferenceContext, requestOptions: { signal },
        backgroundChat: async (payload, options) => {
          calls.push({ payload, options });
          return JSON.stringify({ protocolVersion: 'format_patch.v1', baseRevision: 'reference-test', status: 'no_change', issues: [], linePatches: [] });
        },
      },
    },
    onChatFormatGuardianModelReviewCompleted: result => complete(result), logger: { warn() {} },
  });
  const result = await completed;
  return { calls, result };
};
const formatController = new AbortController();
let resolvedTarget = '';
const repaired = await runFormat({ repairTarget: { sourceMessageId: 'a2' }, signal: formatController.signal,
  resolveReferenceContext: async options => {
    resolvedTarget = options.targetMessageId; assert.equal(options.signal, formatController.signal);
    return referenceBuilder({ config: referenceConfig, context, targetMessageId: options.targetMessageId, signal: options.signal });
  },
});
assert.equal(resolvedTarget, 'a2', 'the repair source wins over a display bubble id');
assert.equal(repaired.calls.length, 1);
const formatText = repaired.calls[0].payload.map(message => message.content).join('\n');
assert.ok(formatText.includes('Earlier reply') && formatText.includes('SELECTED VOICE'));
assert.equal(formatText.includes('FUTURE'), false, 'manual repair of an old reply cannot read its future');
assert.equal(formatText.includes('TARGET REPLY'), false, 'the writable target is not duplicated in reference context');
assert.equal(formatText.includes('LEGACY FORMAT REFERENCE'), false);
assert.equal(formatText.includes('PRIVATE'), false);
assert.equal(repaired.calls[0].options.signal, formatController.signal);
const fallback = await runFormat();
assert.ok(fallback.calls[0].payload.some(message => message.content.includes('LEGACY FORMAT REFERENCE')));
const cancelFormat = new AbortController();
const cancelled = await runFormat({ signal: cancelFormat.signal,
  resolveReferenceContext: async () => { cancelFormat.abort(); return { text: 'late material' }; },
});
assert.equal(cancelled.calls.length, 0);
assert.equal(cancelled.result.failed, true);
console.log('agent builtin reference tests passed');
