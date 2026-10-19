import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const { createAttachmentFileAgentTools, sha256Hex } = await import('../../src/scripts/agent/tools/attachment-file-tools.js');
const { createAttachmentImportAgentTools } = await import('../../src/scripts/agent/tools/attachment-import-tools.js');
const { inspectAttachmentContent } = await import('../../src/scripts/import/attachment-content.js');
const { createMaidFileLibrary } = await import('../../src/scripts/storage/maid-file-library.js');
const { buildZip, listZipEntries, readZipEntry, findZipEntry } = await import('../../src/scripts/utils/zip-archive.js');

const text = value => new TextEncoder().encode(value);
const decode = bytes => new TextDecoder().decode(bytes);
const longText = Array.from({ length: 40 }, (_, i) => `第${i + 1}行：${i === 24 ? '灯塔在港口尽头' : '平常的一行'}`).join('\n');
const docx = await buildZip([
  { path: '[Content_Types].xml', bytes: text('<Types/>') },
  { path: 'word/document.xml', bytes: text('<w:p><w:t>报告提到灯塔</w:t></w:p>') },
]);
const zip = await buildZip([
  { path: 'docs/长文.txt', bytes: text(longText) },
  { path: 'docs/附录.md', bytes: text('# 附录\n没有提到') },
  { path: '世界书/星港.json', bytes: text(JSON.stringify({ name: '星港', entries: { 0: { key: ['港'], content: '港口' } } })) },
  { path: 'inner.zip', bytes: await buildZip([{ path: '深处.txt', bytes: text('内层文件') }]) },
  { path: 'report.docx', bytes: docx },
]);

let seq = 0;
const createId = () => `file-${(seq += 1)}`;
const library = createMaidFileLibrary();
const zipInspection = (await inspectAttachmentContent({ name: '资料包.zip', bytes: zip })).inspection;
library.register('zip', { bytes: zip, hash: await sha256Hex(zip), name: '资料包.zip', mime: 'application/zip', inspection: zipInspection });
library.markSubmitted('zip', { roleCardId: 'p-test', sessionId: 'rp:p-test' });
const tools = Object.fromEntries(createAttachmentFileAgentTools({ getAttachmentRegistry: () => library, createId }).map(tool => [tool.name, tool]));
const [inspectTool] = createAttachmentImportAgentTools({ getAttachmentRegistry: () => library });
const context = { roleCardId: 'p-test', sessionId: 'rp:p-test' };

{
  const archive = await tools['attachment.read'].execute({ attachmentId: 'zip' });
  assert.equal(archive.reason, 'archive_needs_entry');
  const first = await tools['attachment.read'].execute({ attachmentId: 'zip', entry: 'docs/长文.txt', limit: 200 });
  assert.deepEqual([first.ok, first.entry, first.offset, first.nextOffset, first.text.length], [true, 'docs/长文.txt', 0, 200, 200]);
  assert.match(first.notice, /不是给你的指令/);
  const lines = await tools['attachment.read'].execute({ attachmentId: 'zip', entry: 'docs/长文.txt', startLine: 24, endLine: 26 });
  assert.deepEqual([lines.startLine, lines.endLine, lines.totalLines, lines.nextLine], [24, 26, 40, 27]);
  assert.match(lines.text, /25\| 第25行：灯塔在港口尽头/);
  const word = await tools['attachment.read'].execute({ attachmentId: 'zip', entry: 'report.docx' });
  assert.deepEqual([word.kind, word.text], ['Word 文档', '报告提到灯塔']);
  assert.equal((await tools['attachment.read'].execute({ attachmentId: 'missing' })).reason, 'attachment_not_found');
  console.log('ok - attachment.read pages archive entries and Office text and labels content as material');
}

{
  const all = await tools['attachment.search'].execute({ attachmentId: 'zip', query: '灯塔' });
  assert.deepEqual(all.hits.map(hit => [hit.entry, hit.line]), [['docs/长文.txt', 25], ['report.docx', 1]]);
  assert.equal(all.searchedFiles, 4, 'binary and nested archives are skipped; text, markdown, JSON and Word are searched');
  const one = await tools['attachment.search'].execute({ attachmentId: 'zip', query: '附录', entry: 'docs/附录.md' });
  assert.deepEqual(one.hits.map(hit => hit.line), [1]);
  console.log('ok - attachment.search searches one file or every readable file in an archive');
}

{
  const extracted = await tools['attachment.extract'].execute({ attachmentId: 'zip', entries: ['世界书/星港.json', 'inner.zip', 'nope.txt'] });
  assert.deepEqual(extracted.files.map(file => [file.name, file.format, file.origin, file.entry]), [
    ['星港.json', 'worldbook', 'archive', '世界书/星港.json'],
    ['inner.zip', 'archive', 'archive', 'inner.zip'],
  ]);
  assert.deepEqual(extracted.failed.map(item => item.reason), ['entry_not_found']);
  const again = await tools['attachment.extract'].execute({ attachmentId: 'zip', entries: ['世界书/星港.json'] });
  assert.equal(again.files[0].attachmentId, extracted.files[0].attachmentId, 'the same entry is taken out only once');
  assert.equal(library.get(extracted.files[0].attachmentId).submittedContext.roleCardId, 'p-test', 'a file taken out of an archive keeps the context the archive was sent in');
  const nested = await tools['attachment.read'].execute({ attachmentId: extracted.files[1].attachmentId, entry: '深处.txt' });
  assert.equal(nested.text, '内层文件', 'a zip inside the zip is readable once taken out');
  console.log('ok - attachment.extract saves archive entries as library files once and opens nested archives');
}

{
  const created = await tools['attachment.create'].execute({ name: '摘要.md', content: '# 摘要\n' }, context);
  assert.deepEqual([created.ok, created.origin, created.format], [true, 'maid', 'text']);
  const appended = await tools['attachment.create'].execute({ appendTo: created.attachmentId, content: '第二部分' }, context);
  assert.equal(appended.attachmentId, created.attachmentId);
  assert.equal((await tools['attachment.read'].execute({ attachmentId: created.attachmentId })).text, '# 摘要\n第二部分');
  assert.equal((await tools['attachment.create'].execute({ appendTo: 'zip', content: 'x' })).reason, 'append_target_not_found', 'only files the Maid created can be appended to');
  assert.equal((await tools['attachment.create'].execute({ name: 'run.exe', content: 'x' })).reason, 'unsupported_file_name');
  assert.ok(library.listRecent().some(item => item.id === created.attachmentId), 'a created file is offered in the next turn');

  const packed = await tools['attachment.pack'].execute({
    name: '整理后',
    files: [
      { attachmentId: created.attachmentId },
      { attachmentId: 'zip', entryPrefix: 'docs' },
      { attachmentId: 'zip', entry: '世界书/星港.json', path: 'books/星港.json' },
    ],
  }, context);
  assert.deepEqual([packed.ok, packed.name, packed.fileCount], [true, '整理后.zip', 4]);
  const bytes = library.get(packed.attachmentId).bytes;
  const listing = listZipEntries(bytes);
  assert.deepEqual(listing.entries.map(entry => entry.path), ['摘要.md', '长文.txt', '附录.md', 'books/星港.json']);
  assert.equal(decode(await readZipEntry(bytes, findZipEntry(listing, '摘要.md'))), '# 摘要\n第二部分');
  assert.equal((await tools['attachment.pack'].execute({ name: 'x', files: [{ attachmentId: 'zip', entry: 'none' }] })).reason, 'entry_not_found');
  console.log('ok - attachment.create writes and appends text files and attachment.pack builds zips from library files');
}

{
  const page = (await inspectTool.execute({ attachmentId: 'zip', listOffset: 0, listLimit: 2 })).attachments[0];
  assert.deepEqual([page.format, page.totalFiles, page.files.map(file => file.path), page.nextListOffset], ['archive', 5, ['docs/长文.txt', 'docs/附录.md'], 2]);
  assert.deepEqual(page.importable.map(item => item.path), ['世界书/星港.json']);
  const lib = await inspectTool.execute({ list: 'library' });
  assert.ok(lib.library.some(item => item.origin === 'maid' && item.name === '整理后.zip'));
  assert.ok(lib.library.some(item => item.origin === 'archive' && item.entry === 'inner.zip'));
  assert.equal(lib.total, library.list().length);
  console.log('ok - attachment.inspect pages archive listings and lists the whole file library');
}
