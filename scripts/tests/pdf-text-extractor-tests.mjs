import assert from 'node:assert/strict';
import { makeTestPdf } from './fixtures/make-test-pdf.mjs';

const { extractPdfText, pickPdfjsVersion } = await import('../../src/scripts/import/pdf-text-extractor.js');

{
  assert.equal(pickPdfjsVersion({ userAgent: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36 Edg/131', hasDocument: true }), 'v6');
  assert.equal(pickPdfjsVersion({ userAgent: 'Mozilla/5.0 (Linux; Android 10) Chrome/92.0.4515.159 Mobile Safari/537.36', hasDocument: true }), 'v3');
  assert.equal(pickPdfjsVersion({ userAgent: 'Mozilla/5.0 Chrome/124.0 Mobile', hasDocument: true }), 'v3');
  assert.equal(pickPdfjsVersion({ userAgent: 'Mozilla/5.0 Chrome/125.0 Mobile', hasDocument: true }), 'v6');
  assert.equal(pickPdfjsVersion({ userAgent: 'SomethingElse', hasDocument: true }), 'v3', 'unknown browsers take the older build');
  assert.equal(pickPdfjsVersion({ hasDocument: false, nodeVersion: '22.13.0' }), 'v6', 'Node 22.13+ loads the 6.x module build');
  assert.equal(pickPdfjsVersion({ hasDocument: false, nodeVersion: '20.19.4' }), 'v3', 'older Node falls back to the 3.11 CommonJS build');
  console.log('ok - pdf.js 6.x is used from Chrome 125, older WebViews fall back to 3.11');
}

{
  const pdf = makeTestPdf([['Hello PDF', 'Second line'], ['Page two text']]);
  const before = Array.from(pdf);
  const result = await extractPdfText(pdf);
  assert.deepEqual([result.ok, result.pages, result.readPages, result.truncated, result.noTextLayer, result.version], [true, 2, 2, false, false, pickPdfjsVersion()]);
  assert.equal(result.text, '[第 1 页]\nHello PDF\nSecond line\n\n[第 2 页]\nPage two text');
  assert.deepEqual(Array.from(pdf), before, 'the caller keeps its bytes (pdf.js gets a copy)');

  const firstPage = await extractPdfText(makeTestPdf([['A'], ['B'], ['C']]), { maxPages: 1 });
  assert.deepEqual([firstPage.pages, firstPage.readPages, firstPage.truncated, firstPage.text], [3, 1, true, '[第 1 页]\nA']);

  const blank = await extractPdfText(makeTestPdf([[]]));
  assert.equal(blank.noTextLayer, true, 'a page without text reports no text layer');

  // 两个版本在 Node 里都要能用（测试环境可能是 Node 20 或 22）
  const viaV3 = await extractPdfText(makeTestPdf([['Old build']]), { version: 'v3' });
  assert.deepEqual([viaV3.ok, viaV3.text, viaV3.version], [true, '[第 1 页]\nOld build', 'v3']);

  const broken = await extractPdfText(new TextEncoder().encode('%PDF-1.4 broken'));
  assert.deepEqual([broken.ok, broken.reason], [false, 'pdf_unreadable']);
  console.log('ok - PDF text is extracted page by page with markers, limits and failure reasons');
}

console.log('pdf-text-extractor-tests passed');
