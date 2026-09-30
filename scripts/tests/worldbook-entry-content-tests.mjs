import assert from 'node:assert/strict';
import {
  describeWorldbookEntryContent,
  resolveWorldbookEntryContentPatch,
} from '../../src/scripts/agent/tools/worldbook-entry-content.js';

const test = (name, run) => {
  run();
  console.log(`ok - ${name}`);
};
const read = entry => describeWorldbookEntryContent(entry, { includeContent: true });
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('single block edits the injected body and flat display without changing block metadata', () => {
  const entry = freeze({
    content: 'stale flat body', promptMode: 'hybrid',
    promptBlocks: [{ id: 'main', content: 'actual body', title: '正文', enabled: true,
      role: 1, priority: 17, position: 4, when: { left: 'hp', op: '>', right: 0 },
      nodeGraph: { nodes: [{ id: 'condition' }] }, extension: { keep: true } }],
  });
  assert.equal(read(entry).content, 'actual body');
  const result = resolveWorldbookEntryContentPatch(entry, { content: 'new body' });
  assert.equal(result.ok, true);
  assert.equal(result.promptBlockId, 'main');
  assert.equal(result.patch.content, 'new body');
  assert.deepEqual(result.patch.promptBlocks, [{ ...entry.promptBlocks[0], content: 'new body' }]);
  assert.equal(read({ ...entry, ...result.patch }).content, 'new body');
  assert.equal(entry.promptBlocks[0].content, 'actual body');
  assert.equal(Object.hasOwn(result.patch, 'promptMode'), false);
});

test('multi-block body requires a target even when other blocks are disabled or empty', () => {
  const entry = freeze({ content: 'flat', promptBlocks: [
    { id: 'first', content: 'visible' },
    { id: 'off', enabled: false, content: '' },
  ] });
  const result = resolveWorldbookEntryContentPatch(entry, { content: 'replacement', newTitle: 'renamed' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'prompt_block_required');
  assert.equal(Object.hasOwn(result, 'patch'), false);
  assert.equal(read(entry).requiresPromptBlockId, true);
  assert.deepEqual(resolveWorldbookEntryContentPatch(entry, { newTitle: 'renamed', keys: ['word'] }), { ok: true, patch: {} });
});

test('explicit multi-block edit preserves other blocks and mirrors only the first body', () => {
  const entry = freeze({ content: 'outdated mirror', promptMode: 'blocks', promptBlocks: [
    { id: 'a', content: 'first body', when: { left: 'mode', op: '==', right: 'a' } },
    { id: 'b', content: 'second body', role: 2, priority: 3, enabled: true, nodeGraph: { nodes: [] } },
  ] });
  const result = resolveWorldbookEntryContentPatch(entry, { promptBlockId: 'b', content: 'edited second body' });
  assert.equal(result.ok, true);
  assert.equal(result.patch.content, 'first body');
  assert.equal(result.patch.promptBlocks[0], entry.promptBlocks[0]);
  assert.deepEqual(result.patch.promptBlocks[1], { ...entry.promptBlocks[1], content: 'edited second body' });
  assert.equal(read({ ...entry, ...result.patch }).content, 'first body\n\nedited second body');
  assert.equal(entry.promptBlocks[1].content, 'second body');
});

test('legacy edits flat content and leaves inactive blocks unchanged', () => {
  const entry = freeze({ promptMode: 'LEGACY', content: 'legacy body', promptBlocks: [{ id: 'unused', content: 'inactive body' }] });
  assert.equal(read(entry).contentSource, 'content');
  assert.equal(read(entry).content, 'legacy body');
  const result = resolveWorldbookEntryContentPatch(entry, { content: 'new legacy body' });
  assert.deepEqual(result, { ok: true, patch: { content: 'new legacy body' } });
  assert.equal(read({ ...entry, ...result.patch }).content, 'new legacy body');
  assert.equal(resolveWorldbookEntryContentPatch(entry, { promptBlockId: 'unused', content: 'x' }).reason, 'prompt_blocks_inactive');
});

test('absent or empty block arrays use flat content without manufacturing blocks', () => {
  for (const entry of [{ content: 'flat' }, { content: 'flat', promptMode: 'blocks', promptBlocks: [] }]) {
    freeze(entry);
    assert.equal(read(entry).contentSource, 'content');
    assert.equal(read(entry).content, 'flat');
    assert.deepEqual(resolveWorldbookEntryContentPatch(entry, { content: 'new' }), { ok: true, patch: { content: 'new' } });
    assert.equal(resolveWorldbookEntryContentPatch(entry, { content: 'new', promptBlockId: 'blk_0' }).reason, 'prompt_block_not_found');
  }
});

test('one empty block suppresses stale flat fallback and can receive or clear its own body', () => {
  for (const block of [{ id: 'empty', content: '' }, { id: 'empty' }]) {
    const entry = freeze({ content: 'must not inject', promptBlocks: [block] });
    assert.equal(read(entry).contentSource, 'promptBlocks');
    assert.equal(read(entry).content, '');
    const result = resolveWorldbookEntryContentPatch(entry, { content: 'actual text' });
    assert.equal(result.ok, true);
    assert.equal(read({ ...entry, ...result.patch }).content, 'actual text');
    const cleared = resolveWorldbookEntryContentPatch({ ...entry, ...result.patch }, { content: '' });
    assert.equal(cleared.patch.content, '');
    assert.equal(read({ ...entry, ...cleared.patch }).content, '');
  }
});

test('block IDs follow bridge positional fallback and duplicate IDs refuse an edit', () => {
  const entry = freeze({ promptBlocks: [{ content: 'first' }, { content: 'second' }] });
  assert.deepEqual(read(entry).promptBlocks.map(block => block.id), ['blk_0', 'blk_1']);
  const result = resolveWorldbookEntryContentPatch(entry, { promptBlockId: 'blk_1', content: 'new second' });
  assert.equal(result.ok, true);
  assert.equal(result.patch.promptBlocks[1].content, 'new second');
  assert.equal(Object.hasOwn(result.patch.promptBlocks[1], 'id'), false);
  assert.equal(resolveWorldbookEntryContentPatch(entry, { promptBlockId: 'missing', content: 'x' }).reason, 'prompt_block_not_found');
  const collision = { promptBlocks: [{ content: 'first' }, { id: 'blk_0', content: 'second' }] };
  assert.equal(resolveWorldbookEntryContentPatch(collision, { promptBlockId: 'blk_0', content: 'x' }).reason, 'ambiguous_prompt_block');
});

test('read exposes disabled targets without treating them as injected or enabling them on edit', () => {
  const entry = freeze({ promptBlocks: [
    { id: 'on', content: 'shown', when: { left: 'flag', op: '==', right: true } },
    { id: 'off', enabled: false, content: 'hidden' },
  ] });
  const summary = read(entry);
  assert.equal(summary.content, 'shown');
  assert.equal(summary.conditionsEvaluated, false);
  assert.equal(summary.promptBlocks[1].content, 'hidden');
  const result = resolveWorldbookEntryContentPatch(entry, { promptBlockId: 'off', content: 'edited hidden' });
  assert.equal(result.patch.promptBlocks[1].enabled, false);
  assert.equal(read({ ...entry, ...result.patch }).content, 'shown');
});

test('description alias retains content precedence and metadata-only updates never need block resolution', () => {
  assert.deepEqual(resolveWorldbookEntryContentPatch({}, { description: ' body ' }), { ok: true, patch: { content: 'body' } });
  assert.deepEqual(resolveWorldbookEntryContentPatch({}, { content: '', description: 'ignored' }), { ok: true, patch: { content: '' } });
  assert.deepEqual(resolveWorldbookEntryContentPatch({ promptBlocks: [null, null] }, { title: 'name', promptBlockId: 'invalid' }), { ok: true, patch: {} });
  assert.equal(resolveWorldbookEntryContentPatch({ promptBlocks: [null] }, { content: 'x' }).reason, 'invalid_prompt_block');
});

test('content summaries honor content omission and truncation for flat and block bodies', () => {
  for (const entry of [{ content: 'abcdef' }, { content: 'stale', promptBlocks: [{ id: 'a', content: 'abcdef' }] }]) {
    const summary = describeWorldbookEntryContent(entry);
    assert.equal(summary.contentLength, 6);
    assert.equal(Object.hasOwn(summary, 'content'), false);
    assert.ok(summary.promptBlocks.every(block => !Object.hasOwn(block, 'content')));
    const shown = describeWorldbookEntryContent(entry, { includeContent: true, maxContentLength: 3 });
    assert.equal(shown.content, 'abc');
    assert.equal(shown.contentTruncated, true);
    assert.ok(shown.promptBlocks.every(block => block.content === 'abc' && block.contentTruncated));
  }
});

test('all block bodies share one preview budget while keeping actual lengths and truncation flags', () => {
  const entry = freeze({ promptBlocks: [
    { id: 'a', content: 'abcd' },
    { id: 'b', content: 'efgh', enabled: false },
    { id: 'c', content: 'ijkl' },
    { id: 'empty', content: '' },
  ] });
  const shown = describeWorldbookEntryContent(entry, { includeContent: true, maxContentLength: 6 });
  assert.equal(shown.content.length, 6);
  assert.equal(shown.contentTruncated, true);
  assert.equal(shown.promptBlocks.reduce((total, block) => total + block.content.length, 0), 6);
  assert.deepEqual(shown.promptBlocks.map(block => block.content), ['abcd', 'ef', '', '']);
  assert.deepEqual(shown.promptBlocks.map(block => block.contentLength), [4, 4, 4, 0]);
  assert.deepEqual(shown.promptBlocks.map(block => block.contentTruncated), [false, true, true, false]);
});
