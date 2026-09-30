import assert from 'node:assert/strict';
import { buildMaidResultBasis, normalizeMaidResultBasis } from '../../src/scripts/agent/maid-result-basis.js';
import { MaidConversationStore } from '../../src/scripts/storage/maid-conversation-store.js';

// Reduced successful observations from the real F04 run: two versions remain
// in the attachment pool, while the old history projection lost both IDs.
const generated = (id, status = 'succeeded', ok = true) => ({
  toolName: 'media.generate_image', status,
  output: { toolName: 'media.generate_image', result: { ok, attachmentId: id,
    dataUrl: 'do-not-persist-image-bytes', generationContext: { apiKey: 'do-not-persist-key' },
    visualSpec: { subject: 'Lilith', subjectAliases: ['Lily'], target: 'Lilith', purpose: 'avatar',
      appearance: 'pink hair, small demon horns', outfit: 'black dress', style: 'anime',
      targetAspectRatio: '1:1', actualWidth: 2048, actualHeight: 2048 },
  } },
});
const applied = id => ({ toolName: 'contact.set_avatar', status: 'succeeded', output: {
  ok: true, kind: 'contact', target: { id: 'contact-lilith', name: 'Lilith' }, image: { attachmentId: id },
} });
const first = buildMaidResultBasis({ steps: [generated('generated-first'), applied('generated-first')] });
assert.equal(first.artifacts[0].attachmentId, 'generated-first');
assert.equal(first.artifacts[0].target, 'contact-lilith', 'successful write resolves the actual target ID');
assert.equal(first.artifacts[0].appearance, 'pink hair, small demon horns');
assert.equal(first.artifacts[0].actualWidth, 2048);
assert.equal(JSON.stringify(first).includes('do-not-persist'), false);
assert.equal(buildMaidResultBasis({ steps: [generated('failed', 'failed'), generated('rejected', 'succeeded', false)] }).artifacts, undefined);
assert.equal(buildMaidResultBasis({ message: 'generated-made-up', plan: generated('plan-only') }).artifacts, undefined);
assert.deepEqual(buildMaidResultBasis({ resultBasis: first }).artifacts, first.artifacts);
assert.deepEqual(buildMaidResultBasis({ resultBasis: first }, { traceView: { steps: [
  { toolName: 'media.generate_image', status: 'running' },
] } }).artifacts, first.artifacts, 'delayed traces retain completed evidence');
assert.equal(normalizeMaidResultBasis({ artifacts: Array.from({ length: 20 }, (_, i) => ({
  attachmentId: `image-${i}`, appearance: 'a'.repeat(2000), arbitrary: 'do-not-persist',
})) }).artifacts.length, 8);
assert.equal(normalizeMaidResultBasis({ artifacts: [{ attachmentId: 'data:image/png;base64,abc' }] }).artifacts, undefined);
console.log('ok - only observed successful image metadata survives, with bounded fields and actual write targets');

const data = new Map();
const options = { storage: null, loadKv: async key => data.get(key),
  saveKv: async (key, value) => data.set(key, structuredClone(value)),
  compactionTurnThreshold: 1000, compactionHistoryTokenThreshold: 100000 };
const store = new MaidConversationStore(options); await store.load();
await store.appendTurn({ input: 'Make her avatar', message: 'Applied', resultBasis: first });
await store.appendTurn({ input: 'Make it cuter', message: 'Applied second version',
  resultBasis: buildMaidResultBasis({ steps: [generated('generated-second'), applied('generated-second')] }) });
const reloaded = new MaidConversationStore(options); await reloaded.load();
const history = reloaded.getHistoryContextText();
assert(history.includes('generated-first') && history.includes('generated-second'));
assert(history.indexOf('generated-first') < history.indexOf('generated-second'));
assert(history.includes('contact-lilith') && history.includes('pink hair, small demon horns'));
assert(!history.includes('do-not-persist'));
assert.deepEqual(reloaded.exportState().turns[0].resultBasis.artifacts, first.artifacts);
console.log('ok - both image versions and identity metadata survive persistence and ordered planner history');
