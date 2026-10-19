import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const { buildMaidFileResultActions, buildMaidFilePreviewText, collectMaidOutputFiles, toMaidFileAttachment } = await import('../../src/scripts/ui/maid-file-result-actions.js');
const { createAttachmentTextReader } = await import('../../src/scripts/import/attachment-content.js');
const { buildZip } = await import('../../src/scripts/utils/zip-archive.js');

{
  const steps = [
    { toolName: 'attachment.create', status: 'succeeded', output: { ok: true, attachmentId: 'f1', name: '摘要.md' } },
    { toolName: 'attachment.create', status: 'succeeded', output: { ok: true, appended: true, attachmentId: 'f1', name: '摘要.md' } },
    { toolName: 'attachment.extract', status: 'succeeded', output: { ok: true, files: [{ attachmentId: 'f2', name: 'a.json' }, { attachmentId: 'f3', name: 'b.json' }] } },
    { toolName: 'attachment.pack', status: 'failed', output: { ok: false } },
    { toolName: 'attachment.read', status: 'succeeded', output: { ok: true, attachmentId: 'zip' } },
  ];
  assert.deepEqual(collectMaidOutputFiles(steps).map(file => file.attachmentId), ['f1', 'f2', 'f3'], 'appending to a file keeps one entry; reads and failures are ignored');
  const previewed = [];
  const attached = [];
  const actions = buildMaidFileResultActions(steps, { preview: id => previewed.push(id), attach: ids => attached.push(ids) });
  assert.equal(actions.length, 3, 'at most two previews plus one attach action');
  assert.match(actions[0].label, /摘要\.md/);
  assert.match(actions[2].label, /3/);
  actions[0].onClick();
  actions[2].onClick();
  assert.deepEqual([previewed, attached], [['f1'], [['f1', 'f2', 'f3']]]);
  assert.deepEqual(buildMaidFileResultActions([{ toolName: 'attachment.read', status: 'succeeded', output: { ok: true } }], { preview() {}, attach() {} }), []);
  console.log('ok - maid file result actions offer preview and re-attach for produced files');
}

{
  const reader = createAttachmentTextReader();
  const zip = await buildZip([{ path: 'docs/a.txt', bytes: new TextEncoder().encode('x'.repeat(2048)) }]);
  const listing = await buildMaidFilePreviewText({ id: 'z', hash: 'hz', name: 'a.zip', bytes: zip, inspection: { format: 'archive' } }, { reader });
  assert.match(listing, /1/);
  assert.match(listing, /docs\/a\.txt {2}\(2 KB\)/);
  const textPreview = await buildMaidFilePreviewText({ id: 't', hash: 'ht', name: 'n.md', bytes: new TextEncoder().encode('# 标题'), inspection: { format: 'text' } }, { reader });
  assert.equal(textPreview, '# 标题');
  assert.match(await buildMaidFilePreviewText(null, { reader }), /清理/);
  const chip = toMaidFileAttachment({ id: 'f1', name: '摘要.md', mime: 'text/markdown', size: 8, hash: 'h', inspection: { format: 'text', label: 'Markdown' } });
  assert.deepEqual([chip.kind, chip.file.label, chip.source], ['file', 'Markdown', 'library']);
  console.log('ok - maid file previews list archives and show text, and library files become input attachments');
}
