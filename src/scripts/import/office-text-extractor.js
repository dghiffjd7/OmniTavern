// Office 文档（docx／pptx／xlsx，都是 XML 组成的 zip）的纯文本提取，供女仆读取附件。
// 思路参考 Noa 的 documents.js：Word 按段落、PowerPoint 按页（含备注）、Excel 按工作表（共享字符串与缓存值，
// 不计算公式）。工作表按 workbook 关系对应名称，单元格按列号放置。提取出的文字是资料，不是指令。
import { listZipEntries, readZipEntry } from '../utils/zip-archive.js';

export const OFFICE_DOCUMENT_TYPES = Object.freeze({ docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel' });
// 附件条上显示的类型名（经 UI 词表翻译）
export const OFFICE_DOCUMENT_LABELS = Object.freeze({ docx: 'Word 文档', pptx: 'PowerPoint 文档', xlsx: 'Excel 文档' });
const MAX_XML_BYTES = 16 * 1024 * 1024;
const MAX_SHEET_ROWS = 5000;
const MAX_TEXT_CHARS = 2_000_000;

const decodeXml = text => text
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
  .replace(/&amp;/g, '&');

// 段落文字：一段内的文字块拼起来，一段一行
const paragraphs = (xml, paragraph, run) => {
  const lines = [];
  for (const block of xml.match(new RegExp(`<${paragraph}[\\s>][\\s\\S]*?</${paragraph}>`, 'g')) || []) {
    const line = [...block.matchAll(new RegExp(`<${run}(?:\\s[^>]*)?>([\\s\\S]*?)</${run}>`, 'g'))]
      .map(match => decodeXml(match[1])).join('').trim();
    if (line) lines.push(line);
  }
  return lines;
};
const numbered = name => Number(name.match(/(\d+)\.xml$/)?.[1] || 0);

// 按 Office 包的内容识别类型（扩展名只作辅助）
export const detectOfficeType = (listing, name = '') => {
  const paths = new Set((listing?.entries || []).map(entry => entry.path));
  if (!paths.has('[Content_Types].xml')) return '';
  if (paths.has('word/document.xml')) return 'docx';
  if (paths.has('xl/workbook.xml')) return 'xlsx';
  if ([...paths].some(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))) return 'pptx';
  const ext = String(name).toLowerCase().match(/\.(docx|xlsx|pptx)$/)?.[1];
  return ext || '';
};

const readXml = async (bytes, listing, path) => {
  const entry = listing.entries.find(item => item.path === path && !item.duplicate);
  if (!entry) return null;
  return new TextDecoder('utf-8').decode(await readZipEntry(bytes, entry, { maxBytes: MAX_XML_BYTES }));
};

const extractWord = async (bytes, listing) => {
  const xml = await readXml(bytes, listing, 'word/document.xml');
  if (xml === null) throw new Error('Word 文档缺少正文');
  const lines = paragraphs(xml, 'w:p', 'w:t');
  return { text: lines.join('\n'), stats: { paragraphs: lines.length } };
};

const extractPowerPoint = async (bytes, listing) => {
  const slides = listing.entries.map(entry => entry.path)
    .filter(path => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => numbered(a) - numbered(b));
  if (!slides.length) throw new Error('演示文稿里没有幻灯片');
  const pages = [];
  for (const path of slides) {
    const page = numbered(path);
    const body = paragraphs(await readXml(bytes, listing, path) || '', 'a:p', 'a:t').join('\n');
    const notesXml = await readXml(bytes, listing, `ppt/notesSlides/notesSlide${page}.xml`);
    const remark = notesXml ? paragraphs(notesXml, 'a:p', 'a:t').filter(line => !/^\d+$/.test(line)).join('\n') : '';
    pages.push(`=== 第 ${page} 页 ===\n${body || '（这一页没有文字）'}${remark ? `\n[备注] ${remark}` : ''}`);
  }
  return { text: pages.join('\n\n'), stats: { slides: slides.length } };
};

const columnIndex = ref => {
  const letters = String(ref || '').match(/^[A-Z]+/)?.[0] || '';
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
};

const extractExcel = async (bytes, listing) => {
  const sharedXml = await readXml(bytes, listing, 'xl/sharedStrings.xml');
  const shared = (sharedXml?.match(/<si>[\s\S]*?<\/si>/g) || [])
    .map(item => [...item.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join(''));
  const workbook = await readXml(bytes, listing, 'xl/workbook.xml') || '';
  const rels = await readXml(bytes, listing, 'xl/_rels/workbook.xml.rels') || '';
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(([tag]) => [
    tag.match(/\bId="([^"]*)"/)?.[1] || '',
    (tag.match(/\bTarget="([^"]*)"/)?.[1] || '').replace(/^\/?(xl\/)?/, 'xl/'),
  ]));
  let sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(([tag]) => ({
    name: decodeXml(tag.match(/\bname="([^"]*)"/)?.[1] || ''),
    path: targets.get(tag.match(/\br:id="([^"]*)"/)?.[1] || '') || '',
  })).filter(sheet => sheet.path);
  // 没有关系表时按文件序号对应
  if (!sheets.length) {
    sheets = listing.entries.map(entry => entry.path)
      .filter(path => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
      .sort((a, b) => numbered(a) - numbered(b))
      .map((path, index) => ({ name: String(index + 1), path }));
  }
  const parts = [];
  let rowCount = 0;
  for (const sheet of sheets) {
    const xml = await readXml(bytes, listing, sheet.path);
    if (xml === null) continue;
    const rows = [];
    for (const row of xml.match(/<row\b[\s\S]*?<\/row>/g) || []) {
      const cells = [];
      for (const [, attributes, inner = ''] of row.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const value = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const inline = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/)?.[1];
        const text = /\bt="s"/.test(attributes) ? (shared[Number(value)] ?? '') : decodeXml(inline ?? value ?? '');
        const column = columnIndex(attributes.match(/\br="([A-Z]+)\d+"/)?.[1]);
        cells[column >= 0 ? column : cells.length] = text;
      }
      const line = Array.from(cells, cell => cell ?? '').join('\t').replace(/\t+$/, '');
      if (line.trim()) rows.push(line);
      if (rows.length >= MAX_SHEET_ROWS) {
        rows.push('…（后面的行省略）');
        break;
      }
    }
    rowCount += rows.length;
    parts.push(`=== 工作表 ${sheet.name || parts.length + 1} ===\n${rows.join('\n')}`);
  }
  if (!parts.length) throw new Error('表格里没有工作表');
  return { text: parts.join('\n\n'), stats: { sheets: parts.length, rows: rowCount } };
};

/** 提取 Office 文档文字：返回 { type, kind, text, truncated, stats }；不是 Office 文档时返回 null。 */
export const extractOfficeText = async (bytes, { name = '', listing = null } = {}) => {
  const zip = listing || listZipEntries(bytes);
  const type = detectOfficeType(zip, name);
  if (!type) return null;
  const result = type === 'docx' ? await extractWord(bytes, zip)
    : type === 'pptx' ? await extractPowerPoint(bytes, zip)
      : await extractExcel(bytes, zip);
  const truncated = result.text.length > MAX_TEXT_CHARS;
  return {
    type,
    kind: OFFICE_DOCUMENT_TYPES[type],
    label: OFFICE_DOCUMENT_LABELS[type],
    text: truncated ? `${result.text.slice(0, MAX_TEXT_CHARS)}\n…（内容过长，后面省略）` : result.text,
    truncated,
    stats: result.stats,
  };
};
