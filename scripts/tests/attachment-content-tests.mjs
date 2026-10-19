import assert from 'node:assert/strict';

globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const {
  createAttachmentTextReader,
  inspectAttachmentContent,
  pageText,
  searchText,
  sniffAttachmentBytes,
} = await import('../../src/scripts/import/attachment-content.js');
const { extractOfficeText } = await import('../../src/scripts/import/office-text-extractor.js');
const { decodeTextBytes } = await import('../../src/scripts/utils/text-decode.js');
const { buildZip } = await import('../../src/scripts/utils/zip-archive.js');

const text = value => new TextEncoder().encode(value);
const GBK_NIHAO = Uint8Array.from([0xc4, 0xe3, 0xba, 0xc3]); // 「你好」
const CONTENT_TYPES = { path: '[Content_Types].xml', bytes: text('<Types/>') };

{
  assert.deepEqual(decodeTextBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...text('abc')])), { text: 'abc', encoding: 'utf-8' });
  assert.deepEqual(decodeTextBytes(Uint8Array.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59])), { text: '你好', encoding: 'utf-16le' });
  assert.deepEqual(decodeTextBytes(GBK_NIHAO), { text: '你好', encoding: 'gb18030' });
  assert.equal(decodeTextBytes(Uint8Array.from([1, 2, 0, 3])), null, 'NUL bytes mean binary');
  assert.equal(sniffAttachmentBytes(text('%PDF-1.7')).kind, 'pdf');
  console.log('ok - text decoding handles BOMs, UTF-16 and GBK, and rejects binary');
}

{
  const docx = await buildZip([
    CONTENT_TYPES,
    { path: 'word/document.xml', bytes: text('<w:document><w:body><w:p><w:r><w:t>第一段</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; 续</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>') },
  ]);
  const word = await extractOfficeText(docx, { name: 'a.docx' });
  assert.deepEqual([word.type, word.text, word.stats], ['docx', '第一段 & 续\n第二段', { paragraphs: 2 }]);

  const pptx = await buildZip([
    CONTENT_TYPES,
    { path: 'ppt/slides/slide2.xml', bytes: text('<p:sld><a:p><a:t>第二页</a:t></a:p></p:sld>') },
    { path: 'ppt/slides/slide1.xml', bytes: text('<p:sld><a:p><a:t>封面</a:t></a:p></p:sld>') },
    { path: 'ppt/notesSlides/notesSlide1.xml', bytes: text('<p:notes><a:p><a:t>讲稿</a:t></a:p><a:p><a:t>1</a:t></a:p></p:notes>') },
  ]);
  const deck = await extractOfficeText(pptx, { name: 'deck.pptx' });
  assert.equal(deck.text, '=== 第 1 页 ===\n封面\n[备注] 讲稿\n\n=== 第 2 页 ===\n第二页');

  // 工作表顺序按 workbook 关系，不按文件编号；单元格按列号放置
  const xlsx = await buildZip([
    CONTENT_TYPES,
    { path: 'xl/workbook.xml', bytes: text('<workbook><sheets><sheet name="汇总" sheetId="2" r:id="rId2"/><sheet name="明细" sheetId="1" r:id="rId1"/></sheets></workbook>') },
    { path: 'xl/_rels/workbook.xml.rels', bytes: text('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>') },
    { path: 'xl/sharedStrings.xml', bytes: text('<sst><si><t>名称</t></si><si><t>数量</t></si></sst>') },
    { path: 'xl/worksheets/sheet1.xml', bytes: text('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>苹果</t></is></c><c r="C2"><v>3</v></c></row></sheetData></worksheet>') },
    { path: 'xl/worksheets/sheet2.xml', bytes: text('<worksheet><sheetData><row r="1"><c r="B1"><v>42</v></c></row></sheetData></worksheet>') },
  ]);
  const sheet = await extractOfficeText(xlsx, { name: 'book.xlsx' });
  assert.equal(sheet.text, '=== 工作表 汇总 ===\n\t42\n\n=== 工作表 明细 ===\n名称\t\t数量\n苹果\t\t3');
  assert.deepEqual(sheet.stats, { sheets: 2, rows: 3 });
  console.log('ok - office extraction reads Word paragraphs, slides with notes, and sheets by workbook order');
}

{
  const inspect = async (name, bytes, mime = '') => inspectAttachmentContent({ name, mime, bytes });
  const csv = await inspect('数据.csv', GBK_NIHAO);
  assert.deepEqual([csv.inspection.format, csv.inspection.label, csv.inspection.details.encoding], ['text', 'CSV 表格', 'gb18030']);
  assert.equal((await inspect('main.py', text('print(1)\n'))).inspection.label, '代码');
  const world = await inspect('书.json', text(JSON.stringify({ entries: { 0: { key: ['a'], content: 'x' } } })));
  assert.equal(world.inspection.format, 'worldbook', 'importable JSON keeps its import format');
  assert.equal((await inspect('notes.txt', text('{ not json'))).inspection.format, 'text');
  assert.equal((await inspect('a.pdf', text('%PDF-1.4 ...'))).unsupported, 'pdf');
  assert.equal((await inspect('a.bin', Uint8Array.from([0, 1, 2]))).unsupported, 'binary');

  const zip = await buildZip([
    { path: '资料/说明.md', bytes: text('# 说明') },
    { path: '世界书/星港.json', bytes: text(JSON.stringify({ name: '星港', entries: { 0: { key: ['港'], content: '港口' } } })) },
    { path: 'img/a.bin', bytes: Uint8Array.from([0, 1]) },
  ]);
  const archive = (await inspect('包.zip', zip)).inspection;
  assert.deepEqual([archive.format, archive.counts.files], ['archive', 3]);
  assert.deepEqual(archive.details.importable.map(item => [item.path, item.format]), [['世界书/星港.json', 'worldbook']]);
  assert.equal(archive.details.sample.length, 3);
  const docx = await buildZip([CONTENT_TYPES, { path: 'word/document.xml', bytes: text('<w:p><w:t>正文</w:t></w:p>') }]);
  const document = (await inspect('报告.docx', docx)).inspection;
  assert.deepEqual([document.format, document.label, document.counts.paragraphs], ['document', 'Word 文档', 1]);
  console.log('ok - attachment content inspection recognizes text, code, archives, Office and unsupported files');
}

{
  const zip = await buildZip([
    { path: 'docs/长文.txt', bytes: text(Array.from({ length: 30 }, (_, i) => `第${i + 1}行：灯塔在港口尽头`).join('\n')) },
    { path: 'inner.zip', bytes: await buildZip([{ path: 'x.txt', bytes: text('x') }]) },
    { path: 'blob.bin', bytes: Uint8Array.from([0, 0, 1]) },
  ]);
  const reader = createAttachmentTextReader();
  const entry = { id: 'z', hash: 'h-zip', name: '包.zip', bytes: zip, inspection: { format: 'archive' } };
  assert.equal((await reader.read(entry)).reason, 'archive_needs_entry');
  const long = await reader.read(entry, { entryPath: 'DOCS/长文.txt' });
  assert.deepEqual([long.ok, long.path], [true, 'docs/长文.txt']);
  assert.equal((await reader.read(entry, { entryPath: 'inner.zip' })).reason, 'nested_archive');
  assert.equal((await reader.read(entry, { entryPath: 'blob.bin' })).reason, 'binary_file');
  const missing = await reader.read(entry, { entryPath: '长文.txt' });
  assert.deepEqual([missing.reason, missing.suggestions], ['entry_not_found', ['docs/长文.txt']]);

  const page = pageText(long.text, { offset: 0, limit: 200 });
  assert.equal(page.text.length, 200);
  assert.equal(page.nextOffset, 200);
  const lines = pageText(long.text, { startLine: 29 });
  assert.deepEqual([lines.startLine, lines.endLine, lines.totalLines, lines.nextLine], [29, 30, 30, null]);
  assert.match(lines.text, /^ {3}29\| 第29行/);

  const literal = searchText(long.text, '第7行 灯塔');
  assert.deepEqual([literal.mode, literal.hits.map(hit => hit.line)], ['literal', [7]]);
  const fuzzy = searchText(long.text, '港口尽头的灯塔');
  assert.equal(fuzzy.mode, 'bigram', 'a Chinese phrase that does not appear verbatim falls back to two-character matching');
  assert.equal(fuzzy.total, 30);
  assert.equal(fuzzy.hits.length, 10, 'hits are capped so one search fits the step budget');
  console.log('ok - attachment reader opens archive entries, pages text by chars or lines, and searches');
}
